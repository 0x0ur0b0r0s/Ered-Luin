import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseD2cConfig } from './preflight.mjs';
import { runD2cCollection } from './collection-plan.mjs';
import { acquireCollectionLock } from './collector-lock.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SAFE_CLI_ERROR_CODES = new Set([
  'USAGE', 'COLLECTION_CONFIG_MUST_BE_EXTERNAL', 'COLLECTION_CONFIG_INVALID', 'COLLECTION_CONFIG_UNREADABLE',
  'COLLECTION_EXTERNAL_CONFIG_REQUIRED', 'COLLECTION_REQUIRES_SEPARATE_REVIEW_AND_EXPLICIT_ENABLEMENT',
  'COLLECTION_BUDGET_BELOW_PLAN_OR_LEDGER_MISMATCH', 'COLLECTION_CREDENTIAL_UNAVAILABLE',
  'COLLECTION_EXTERNAL_STATE_UNAVAILABLE', 'COLLECTION_ALREADY_RUNNING', 'COLLECTION_LOCK_STALE_REQUIRES_RECONCILIATION',
  'COLLECTION_LOCK_FAILED', 'COLLECTION_LOCK_INVALID', 'COLLECTION_LOCK_UNREADABLE', 'COLLECTION_LOCK_TRANSITION_BUSY', 'COLLECTION_LOCK_TRANSITION_REQUIRES_RECONCILIATION', 'COLLECTION_LOCK_TRANSITION_FAILED', 'LEDGER_RECONCILIATION_REQUIRED',
]);
export function safeCliFailureCode(error) {
  const candidate = error instanceof Error ? error.message : '';
  return SAFE_CLI_ERROR_CODES.has(candidate) ? candidate : 'COLLECTION_FAILED';
}
function insideRoot(path) {
  const rel = relative(ROOT, resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}
export function readD2cExternalConfig(path) {
  if (!path || !isAbsolute(path) || insideRoot(path)) throw new Error('COLLECTION_CONFIG_MUST_BE_EXTERNAL');
  let stat;
  try { stat = lstatSync(path); } catch { throw new Error('COLLECTION_CONFIG_UNREADABLE'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024) throw new Error('COLLECTION_CONFIG_INVALID');
  let config;
  try { config = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('COLLECTION_CONFIG_INVALID'); }
  const environment = parseD2cConfig(config);
  if (!environment) throw new Error('COLLECTION_CONFIG_INVALID');
  return environment;
}
function args(argv) {
  let collect = false;
  let config = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--collect') collect = true;
    else if (argv[i] === '--config' && argv[i + 1] && config === null) config = resolve(argv[++i]);
    else throw new Error('USAGE');
  }
  return { collect, config };
}

async function main() {
  const options = args(process.argv.slice(2));
  if (!options.collect) {
    const report = await runD2cCollection({ mode: 'dry-run' });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  if (!options.config) throw new Error('COLLECTION_EXTERNAL_CONFIG_REQUIRED');
  const environment = readD2cExternalConfig(options.config);
  const { createNansenClient, createNansenQueryManager, NANSEN_COST_PROFILE_VERSION, openCreditLedger, openNansenObservationStore } = await import('../../packages/nansen/dist/index.js');
  if (environment.NANSEN_COST_PROFILE_VERSION !== NANSEN_COST_PROFILE_VERSION) throw new Error('COLLECTION_CONFIG_INVALID');
  let collectionLock = null;
  const collectionGatesEnabled = environment.NANSEN_COLLECTION_REVIEWED === 'true' &&
    environment.NANSEN_COLLECTION_ENABLED === 'true' && environment.NANSEN_API_ENABLED === 'true';
  if (collectionGatesEnabled) collectionLock = acquireCollectionLock(environment.NANSEN_OBSERVATION_STORE_PATH);
  try {
    const report = await runD2cCollection({
      mode: 'collect',
      environment(key) {
        return key === 'NANSEN_API_KEY' ? process.env.NANSEN_API_KEY : environment[key];
      },
      dependencies: {
        openLedger: (settings) => openCreditLedger(settings),
        openStore: (settings) => openNansenObservationStore(settings),
        createClient: (settings) => createNansenClient({
          ...settings, timeoutMs: 8_000, maxResponseBytes: 1_048_576,
        }),
        createManager: (settings) => createNansenQueryManager(settings),
      },
    });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally { collectionLock?.release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = safeCliFailureCode(error);
    process.stderr.write('D2c collection stopped safely: ' + code + '. No secret values, config fragments, private paths, credential URLs, or response bodies are printed.\n');
    process.exitCode = 1;
  });
}
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquireCollectionLock } from '../d2c/collector-lock.mjs';
import { loadD2kConfiguration } from './config.mjs';
import {
  D2K_CREDIT_LIMIT,
  D2K_RUN_ID,
  buildD2kDryRunPlan,
  runD2kWithExternalState,
} from './diagnostic.mjs';
import {
  NANSEN_COST_PROFILE_VERSION,
  initializeCreditLedger,
  openCreditLedger,
} from '../../packages/nansen/dist/index.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SAFE_ERRORS = new Set([
  'USAGE',
  'D2K_LOCAL_APPDATA_UNAVAILABLE',
  'D2K_CONFIG_INVALID',
  'D2K_EXTERNAL_GATES_NOT_OFF',
  'D2K_MAIN_CONFIG_CHANGED',
  'D2K_PROCESS_GATE_OVERRIDE',
  'D2K_COST_PROFILE_MISMATCH',
  'D2K_PRIOR_LEDGER_NOT_EXHAUSTED',
  'D2K_EXTERNAL_STATE_UNAVAILABLE',
  'D2K_STATE_REQUIRES_RECONCILIATION',
  'D2K_CREDENTIAL_UNAVAILABLE',
  'D2K_LEDGER_INITIALIZATION_FAILED',
  'D2K_LEDGER_NOT_FRESH',
  'D2K_POSTFLIGHT_FAILED',
  'D2K_ATTEMPT_CAP_REACHED',
  'D2K_CONFIGURATION_INVALID',
]);

function args(argv) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--dry-run')) return 'dry-run';
  if (argv.length === 1 && argv[0] === '--dispatch') return 'dispatch';
  throw new Error('USAGE');
}

function safeFailureCode(error) {
  const code = error instanceof Error ? error.message : '';
  return SAFE_ERRORS.has(code) ? code : 'D2K_FAILED_SAFE';
}

function within(root, path) {
  const rel = relative(root, resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

function regularExternalFile(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || within(ROOT, path)) {
    throw new Error('D2K_EXTERNAL_STATE_UNAVAILABLE');
  }
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('D2K_EXTERNAL_STATE_UNAVAILABLE');
  } catch {
    throw new Error('D2K_EXTERNAL_STATE_UNAVAILABLE');
  }
  return resolve(path);
}

const PROCESS_GATES_OFF = [
  'NANSEN_API_ENABLED', 'NANSEN_COLLECTION_REVIEWED', 'NANSEN_COLLECTION_ENABLED',
  'LIVE_EXECUTION_ENABLED', 'D2_BASE_READS_ENABLED', 'D2_DEPLOYMENT_REVIEWED',
  'ALCHEMY_BUDGET_VERIFIED', 'G3C_REVIEWED_MODE', 'D2_EXECUTION_REVIEWED',
  'D2_SIGNING_ENABLED', 'D2_BROADCAST_ENABLED', 'G3C_SIGNER_DEPLOYED',
  'BASE_BROADCASTER_DEPLOYED', 'D2_G1D_ANALYSIS_HANDOFF_ENABLED', 'D2_G1D_ANALYSIS_ENABLED',
];

function assertProcessGatesOff() {
  if (PROCESS_GATES_OFF.some((key) => process.env[key] === 'true') ||
      (process.env.EXECUTION_MODE !== undefined && process.env.EXECUTION_MODE !== 'paper')) {
    throw new Error('D2K_PROCESS_GATE_OVERRIDE');
  }
}

function fileDigest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function collectorLockReleased(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) return false;
    const owner = JSON.parse(readFileSync(path, 'utf8'));
    if (!owner || Object.getPrototypeOf(owner) !== Object.prototype ||
        !Number.isSafeInteger(owner.pid) || typeof owner.runId !== 'string') return false;
    return !(owner.pid === process.pid && owner.runId === D2K_RUN_ID);
  } catch (error) {
    return error && typeof error === 'object' && error.code === 'ENOENT';
  }
}
function verifyPriorLedger(environment) {
  const ledger = openCreditLedger({
    databasePath: environment.NANSEN_LEDGER_PATH,
    budgetId: environment.NANSEN_LEDGER_BUDGET_ID,
    limitCredits: 7,
    costProfileVersion: environment.NANSEN_COST_PROFILE_VERSION,
  });
  try {
    const snapshot = ledger.getSnapshot();
    const unknown = ledger.listUnknownChargeAttempts().length;
    if (snapshot.limitCredits !== 7 || snapshot.allocatedCredits !== 7 ||
        snapshot.remainingCredits !== 0 || snapshot.reportedChargedCreditsTotal !== 7 ||
        snapshot.reportedChargeCount !== 3 || snapshot.pendingAttemptCount !== 0 ||
        snapshot.reconciliationRequired || snapshot.haltReason !== null || unknown !== 0) {
      throw new Error('D2K_PRIOR_LEDGER_NOT_EXHAUSTED');
    }
  } finally {
    ledger.close();
  }
  return true;
}

function writeAtomicReport(path, report) {
  const temporary = path + '.postflight.tmp';
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify(report, null, 2) + '\n', 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* keep the safe result path */ }
    }
    throw new Error('D2K_EXTERNAL_STATE_UNAVAILABLE');
  }
}

async function dispatch() {
  if (!process.env.LOCALAPPDATA) throw new Error('D2K_LOCAL_APPDATA_UNAVAILABLE');
  if (typeof process.env.NANSEN_API_KEY !== 'string' || process.env.NANSEN_API_KEY.length === 0) {
    throw new Error('D2K_CREDENTIAL_UNAVAILABLE');
  }
  assertProcessGatesOff();

  const privateRoot = resolve(process.env.LOCALAPPDATA, 'Ered-Luin');
  const { mainConfigPath, originalValidationConfigPath, validationEnvironment } =
    loadD2kConfiguration(privateRoot);
  regularExternalFile(mainConfigPath);
  regularExternalFile(originalValidationConfigPath);
  const environment = validationEnvironment;
  regularExternalFile(environment.NANSEN_LEDGER_PATH);
  regularExternalFile(environment.NANSEN_OBSERVATION_STORE_PATH);
  const mainConfigDigest = fileDigest(mainConfigPath);

  const stateDirectory = join(privateRoot, D2K_RUN_ID);
  const resultPath = join(stateDirectory, 'diagnostic-result.json');
  const completionReportPath = join(stateDirectory, 'result.json');
  const sharedLock = acquireCollectionLock(environment.NANSEN_OBSERVATION_STORE_PATH, { runId: D2K_RUN_ID });
  let report = null;
  let stateCreated = false;
  try {
    verifyPriorLedger(environment);
    if (existsSync(stateDirectory)) throw new Error('D2K_STATE_REQUIRES_RECONCILIATION');
    try { mkdirSync(stateDirectory); stateCreated = true; }
    catch { throw new Error('D2K_STATE_REQUIRES_RECONCILIATION'); }
    const stateStat = lstatSync(stateDirectory);
    if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) throw new Error('D2K_EXTERNAL_STATE_UNAVAILABLE');

    const ledgerOptions = {
      databasePath: join(stateDirectory, 'credits.sqlite'),
      budgetId: D2K_RUN_ID,
      limitCredits: D2K_CREDIT_LIMIT,
      costProfileVersion: NANSEN_COST_PROFILE_VERSION,
    };
    let initializedLedger;
    try {
      initializedLedger = initializeCreditLedger(ledgerOptions);
      initializedLedger.close();
      initializedLedger = null;
    } catch {
      try { initializedLedger?.close(); } catch { /* do not expose local database details */ }
      throw new Error('D2K_LEDGER_INITIALIZATION_FAILED');
    }

    report = await runD2kWithExternalState({
      ledgerOptions,
      storeOptions: {
        databasePath: environment.NANSEN_OBSERVATION_STORE_PATH,
        storeId: environment.NANSEN_OBSERVATION_STORE_ID,
      },
      apiKey: process.env.NANSEN_API_KEY,
      runMarkerPath: join(stateDirectory, 'run.marker.json'),
      dispatchMarkerPath: join(stateDirectory, 'dispatch.marker.json'),
      resultPath,
    });
  } finally {
    sharedLock.release();
  }

  if (report === null || !stateCreated) throw new Error('D2K_POSTFLIGHT_FAILED');
  const postflightConfig = loadD2kConfiguration(privateRoot);
  regularExternalFile(mainConfigPath);
  assertProcessGatesOff();
  const mainConfigUnchanged = fileDigest(mainConfigPath) === mainConfigDigest;
  const originalSevenCreditLedgerPreserved = verifyPriorLedger(postflightConfig.validationEnvironment);
  const sharedCollectorLockReleased = collectorLockReleased(environment.NANSEN_OBSERVATION_STORE_PATH + '.collector.lock');
  const postflight = Object.freeze({
    sharedCollectorLockReleased,
    mainConfigUnchanged,
    collectionSettingsOff: true,
    executionGatesOff: true,
    executionMode: postflightConfig.mainEnvironment.EXECUTION_MODE,
    originalSevenCreditLedgerPreserved,
  });
  if (!sharedCollectorLockReleased || !mainConfigUnchanged || !originalSevenCreditLedgerPreserved) {
    throw new Error('D2K_POSTFLIGHT_FAILED');
  }
  const finalReport = Object.freeze({
    ...report,
    boundaries: Object.freeze({
      originalSevenCreditLedgerPreserved,
      separateDiagnosticLedgerLimit: D2K_CREDIT_LIMIT,
      mainCollectionSettingsChanged: false,
      executionGatesOff: true,
      executionMode: postflightConfig.mainEnvironment.EXECUTION_MODE,
      furtherRequestsAuthorized: false,
    }),
    postflight,
  });
  writeAtomicReport(completionReportPath, finalReport);
  return finalReport;
}

async function main() {
  const mode = args(process.argv.slice(2));
  if (mode === 'dry-run') {
    process.stdout.write(JSON.stringify(buildD2kDryRunPlan(), null, 2) + '\n');
    return;
  }
  try {
    const result = await dispatch();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally {
    delete process.env.NANSEN_API_KEY;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write('D2k stopped safely: ' + safeFailureCode(error) + '. No secret values, config fragments, private paths, provider bodies, or arbitrary error text are printed.\n');
    process.exitCode = 1;
  });
}
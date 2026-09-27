import { existsSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquireCollectionLock } from '../d2c/collector-lock.mjs';
import { loadD2kConfiguration } from '../d2k/config.mjs';
import {
  D2U_CREDIT_LIMIT,
  D2U_RUN_ID,
  buildD2uDryRunPlan,
  runD2uManagedDiagnostic,
} from './diagnostic.mjs';
import {
  NANSEN_COST_PROFILE_VERSION,
  initializeCreditLedger,
  openCreditLedger,
  openNansenObservationStore,
} from '../../packages/nansen/dist/index.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SAFE_ERRORS = new Set([
  'USAGE',
  'D2U_LOCALAPPDATA_UNAVAILABLE',
  'D2U_CONFIG_INVALID',
  'D2U_EXTERNAL_GATES_NOT_OFF',
  'D2U_MAIN_CONFIG_CHANGED',
  'D2U_PROCESS_GATE_OVERRIDE',
  'D2U_COST_PROFILE_MISMATCH',
  'D2U_PRIOR_LEDGER_NOT_EXHAUSTED',
  'D2U_EXTERNAL_STATE_UNAVAILABLE',
  'D2U_STORE_LOCKED',
  'D2U_RUN_ALREADY_EXISTS',
  'D2U_STATE_REQUIRES_RECONCILIATION',
  'D2U_CREDENTIAL_UNAVAILABLE',
  'D2U_LEDGER_INITIALIZATION_FAILED',
  'D2U_LEDGER_NOT_FRESH',
  'D2U_POSTFLIGHT_FAILED',
]);

function mode(argv) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--dry-run')) return 'dry-run';
  if (argv.length === 1 && argv[0] === '--dispatch') return 'dispatch';
  throw new Error('USAGE');
}
function safeFailureCode(error) {
  const code = error instanceof Error ? error.message : '';
  return SAFE_ERRORS.has(code) ? code : 'D2U_FAILED_SAFE';
}
function within(root, path) {
  const rel = relative(root, resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}
function regularExternalFile(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || within(ROOT, path)) throw new Error('D2U_EXTERNAL_STATE_UNAVAILABLE');
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('D2U_EXTERNAL_STATE_UNAVAILABLE');
  } catch { throw new Error('D2U_EXTERNAL_STATE_UNAVAILABLE'); }
  return resolve(path);
}
function assertProcessGatesOff() {
  const keys = [
    'NANSEN_API_ENABLED', 'NANSEN_COLLECTION_REVIEWED', 'NANSEN_COLLECTION_ENABLED',
    'LIVE_EXECUTION_ENABLED', 'D2_BASE_READS_ENABLED', 'D2_DEPLOYMENT_REVIEWED',
    'ALCHEMY_BUDGET_VERIFIED', 'G3C_REVIEWED_MODE', 'D2_EXECUTION_REVIEWED',
    'D2_SIGNING_ENABLED', 'D2_BROADCAST_ENABLED', 'G3C_SIGNER_DEPLOYED',
    'BASE_BROADCASTER_DEPLOYED', 'D2_G1D_ANALYSIS_HANDOFF_ENABLED', 'D2_G1D_ANALYSIS_ENABLED',
  ];
  if (keys.some((key) => process.env[key] === 'true') ||
      (process.env.EXECUTION_MODE !== undefined && process.env.EXECUTION_MODE !== 'paper')) {
    throw new Error('D2U_PROCESS_GATE_OVERRIDE');
  }
}
function fileDigest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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
    if (snapshot.limitCredits !== 7 || snapshot.allocatedCredits !== 7 || snapshot.remainingCredits !== 0 ||
        snapshot.reportedChargedCreditsTotal !== 7 || snapshot.reportedChargeCount !== 3 ||
        snapshot.pendingAttemptCount !== 0 || snapshot.reconciliationRequired || snapshot.haltReason !== null || unknown !== 0) {
      throw new Error('D2U_PRIOR_LEDGER_NOT_EXHAUSTED');
    }
  } finally { ledger.close(); }
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
      try { closeSync(descriptor); } catch { /* Keep the safe postflight failure. */ }
    }
    throw new Error('D2U_EXTERNAL_STATE_UNAVAILABLE');
  }
}
function lockIsReleased(path) {
  try { lstatSync(path); return false; }
  catch (error) { return error && typeof error === 'object' && error.code === 'ENOENT'; }
}
function freshLedger(ledger) {
  const snapshot = ledger.getSnapshot();
  return snapshot.limitCredits === D2U_CREDIT_LIMIT && snapshot.allocatedCredits === 0 &&
    snapshot.remainingCredits === D2U_CREDIT_LIMIT && snapshot.reportedChargeCount === 0 &&
    snapshot.pendingAttemptCount === 0 && !snapshot.reconciliationRequired &&
    ledger.listUnknownChargeAttempts().length === 0;
}

export function buildD2uPreview() {
  return buildD2uDryRunPlan();
}
export function resolveD2uScopedConfiguration(privateRoot, loadConfiguration = loadD2kConfiguration) {
  const config = loadConfiguration(privateRoot);
  const environment = config.validationEnvironment;
  if (!environment || environment.NANSEN_COST_PROFILE_VERSION !== NANSEN_COST_PROFILE_VERSION ||
      environment.NANSEN_CREDIT_BUDGET !== '0' || environment.NANSEN_LEDGER_LIMIT_CREDITS !== '7' ||
      !environment.NANSEN_LEDGER_PATH || !environment.NANSEN_LEDGER_BUDGET_ID ||
      !environment.NANSEN_OBSERVATION_STORE_PATH || !environment.NANSEN_OBSERVATION_STORE_ID) {
    throw new Error('D2U_CONFIG_INVALID');
  }
  return Object.freeze({ ...config, environment });
}

export function acquireD2uSharedStoreLock(observationStorePath) {
  try { return acquireCollectionLock(observationStorePath, { runId: D2U_RUN_ID }); }
  catch { throw new Error('D2U_STORE_LOCKED'); }
}

export async function dispatchD2uDiagnostic({ privateRoot, apiKey, transport, loadConfiguration = loadD2kConfiguration } = {}) {
  if (typeof privateRoot !== 'string' || typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('D2U_CONFIGURATION_INVALID');
  assertProcessGatesOff();
  const config = resolveD2uScopedConfiguration(privateRoot, loadConfiguration);
  const mainConfigPath = regularExternalFile(config.mainConfigPath);
  regularExternalFile(config.originalValidationConfigPath);
  const environment = config.environment;
  regularExternalFile(environment.NANSEN_LEDGER_PATH);
  regularExternalFile(environment.NANSEN_OBSERVATION_STORE_PATH);
  const mainConfigDigest = fileDigest(mainConfigPath);
  verifyPriorLedger(environment);
  const stateDirectory = join(privateRoot, D2U_RUN_ID);
  const resultPath = join(stateDirectory, 'diagnostic-summary.json');
  const completionReportPath = join(stateDirectory, 'completion.json');
  const lock = acquireD2uSharedStoreLock(environment.NANSEN_OBSERVATION_STORE_PATH);
  let ledger = null;
  let store = null;
  let stateCreated = false;
  let result = null;
  try {
    if (existsSync(stateDirectory)) throw new Error('D2U_RUN_ALREADY_EXISTS');
    try { mkdirSync(stateDirectory); stateCreated = true; }
    catch { throw new Error('D2U_RUN_ALREADY_EXISTS'); }
    const stateStat = lstatSync(stateDirectory);
    if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) throw new Error('D2U_EXTERNAL_STATE_UNAVAILABLE');

    const ledgerOptions = {
      databasePath: join(stateDirectory, 'credits.sqlite'),
      budgetId: D2U_RUN_ID,
      limitCredits: D2U_CREDIT_LIMIT,
      costProfileVersion: NANSEN_COST_PROFILE_VERSION,
    };
    let initialized = null;
    try { initialized = initializeCreditLedger(ledgerOptions); initialized.close(); initialized = null; }
    catch {
      try { initialized?.close(); } catch { /* Do not expose private local state. */ }
      throw new Error('D2U_LEDGER_INITIALIZATION_FAILED');
    }
    ledger = openCreditLedger(ledgerOptions);
    if (!freshLedger(ledger)) throw new Error('D2U_LEDGER_NOT_FRESH');
    store = openNansenObservationStore({
      databasePath: environment.NANSEN_OBSERVATION_STORE_PATH,
      storeId: environment.NANSEN_OBSERVATION_STORE_ID,
    });
    result = await runD2uManagedDiagnostic({
      ledger,
      store,
      apiKey,
      runMarkerPath: join(stateDirectory, 'run.marker.json'),
      dispatchMarkerPath: join(stateDirectory, 'dispatch.marker.json'),
      resultPath,
      ...(transport === undefined ? {} : { transport }),
    });
  } finally {
    try { store?.close(); } finally {
      try { ledger?.close(); } finally { lock.release(); }
    }
  }

  const postflightConfig = loadConfiguration(privateRoot);
  regularExternalFile(postflightConfig.mainConfigPath);
  regularExternalFile(postflightConfig.originalValidationConfigPath);
  assertProcessGatesOff();
  const mainConfigUnchanged = fileDigest(mainConfigPath) === mainConfigDigest;
  const originalSevenCreditLedgerPreserved = verifyPriorLedger(postflightConfig.validationEnvironment);
  const sharedCollectorLockReleased = lockIsReleased(environment.NANSEN_OBSERVATION_STORE_PATH + '.collector.lock');
  if (!mainConfigUnchanged || !originalSevenCreditLedgerPreserved || !sharedCollectorLockReleased || !stateCreated || result === null) {
    throw new Error('D2U_POSTFLIGHT_FAILED');
  }
  const report = Object.freeze({
    ...result,
    boundaries: Object.freeze({
      originalSevenCreditLedgerPreserved,
      separateDiagnosticLedgerLimit: D2U_CREDIT_LIMIT,
      maximumTransportAttempts: 1,
      mainConfigChanged: false,
      collectionDefaultsChanged: false,
      liveExecutionEnabled: false,
      furtherCallsAuthorized: false,
      sharedCollectorLockReleased,
    }),
  });
  writeAtomicReport(completionReportPath, report);
  return report;
}

async function main() {
  const options = mode(process.argv.slice(2));
  if (options === 'dry-run') {
    process.stdout.write(JSON.stringify(buildD2uPreview(), null, 2) + '\n');
    return;
  }
  try {
    if (!process.env.LOCALAPPDATA) throw new Error('D2U_LOCALAPPDATA_UNAVAILABLE');
    const report = await dispatchD2uDiagnostic({
      privateRoot: resolve(process.env.LOCALAPPDATA, 'Ered-Luin'),
      apiKey: process.env.NANSEN_API_KEY,
    });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally { delete process.env.NANSEN_API_KEY; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write('D2u stopped safely: ' + safeFailureCode(error) +
      '. No secret values, configuration fragments, private paths, response bodies, or arbitrary error text are printed.\n');
    process.exitCode = 1;
  });
}

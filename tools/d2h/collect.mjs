import { closeSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NANSEN_COLLECTOR_PLAN, WETH_RESEARCH_PLAN, NANSEN_COST_PROFILE_VERSION, NANSEN_OPERATION_COSTS,
  createNansenClient, createNansenCollector, createNansenQueryManager,
  openCreditLedger, openNansenObservationStore,
} from '../../packages/nansen/dist/index.js';
import { readD2cExternalConfig } from '../d2c/manual-collect.mjs';
import { acquireCollectionLock, collectionProcessIsAlive } from '../d2c/collector-lock.mjs';
import {
  buildD2hPreview, createD2hRunHooks, makeNewRunManifest, createStateIdentity,
  makeSafeLedger, publicRunStatus, readRunManifest, resolveExternalManifestPath, writeRunManifest,
} from './bounded-session.mjs';
import { summarizeNansenHistory } from './history-summary.mjs';
import { createD2lResearchHooks } from '../d2l/research-session.mjs';
import { summarizeWethResearchHistory } from '../d2l/research-summary.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FAIL_REASONS = new Set([
  'QUERY_FAILED', 'CHECKPOINT_FAILED', 'UNKNOWN_CHARGE_REQUIRES_RECONCILIATION', 'LEDGER_ACCOUNTING_HALTED',
  'RATE_LIMITED', 'UNUSABLE_RESULT', 'NON_NANSEN_SOURCE', 'RECONCILIATION_REQUIRED', 'COST_ESTIMATE_UNAVAILABLE',
  'LEDGER_STATE_CHANGED', 'LEDGER_BUDGET_EXHAUSTED', 'STOP_REQUEST_INVALID',
]);
const SAFE_ERRORS = new Set([
  'USAGE', 'COLLECTION_CONFIG_MUST_BE_EXTERNAL', 'COLLECTION_CONFIG_INVALID', 'COLLECTION_CONFIG_UNREADABLE',
  'COLLECTION_EXTERNAL_CONFIG_REQUIRED', 'COLLECTION_REQUIRES_SEPARATE_REVIEW_AND_EXPLICIT_ENABLEMENT',
  'COLLECTION_BUDGET_BELOW_PLAN_OR_LEDGER_MISMATCH', 'COLLECTION_CREDENTIAL_UNAVAILABLE', 'COLLECTION_EXTERNAL_STATE_UNAVAILABLE',
  'COLLECTION_ALREADY_RUNNING', 'COLLECTION_LOCK_STALE_REQUIRES_RECONCILIATION', 'COLLECTION_LOCK_FAILED',
  'COLLECTION_LOCK_INVALID', 'COLLECTION_LOCK_UNREADABLE', 'COLLECTION_LOCK_TRANSITION_BUSY', 'COLLECTION_LOCK_TRANSITION_REQUIRES_RECONCILIATION', 'COLLECTION_LOCK_TRANSITION_FAILED', 'MANIFEST_PATH_INVALID', 'MANIFEST_INVALID',
  'MANIFEST_UNAVAILABLE', 'MANIFEST_WRITE_FAILED', 'MANIFEST_ALREADY_EXISTS', 'RUN_BOUNDS_REQUIRED',
  'RUN_BOUNDS_INVALID', 'RUN_CREDIT_CAP_EXCEEDS_ACTIVE_BUDGET', 'ACTIVE_BUDGET_INVALID',
  'COLLECTION_UNRELATED_GATE_ENABLED', 'COLLECTION_COST_PROFILE_MISMATCH', 'NANSEN_CREDENTIAL_UNAVAILABLE',
  'LEDGER_RECONCILIATION_REQUIRED', 'LEDGER_REMAINING_BELOW_CREDIT_CAP', 'RESUME_NOT_ALLOWED',
  'RESUME_REQUIRES_RECONCILIATION', 'RESUME_COUNTERS_REQUIRED', 'RESUME_COUNTERS_INVALID',
  'RUN_DEADLINE_EXPIRED', 'RUN_ALREADY_ACTIVE', 'STOP_REQUEST_INVALID', 'STOP_REQUEST_UNAVAILABLE',
  'STATUS_COMMAND_INVALID', 'SUMMARY_CONFIG_REQUIRED', 'D2H_FAILED_SAFE', 'SUMMARY_INPUT_INVALID', 'SUMMARY_CLOCK_INVALID',
]);
const OFF_GATES = [
  'LIVE_EXECUTION_ENABLED', 'D2_BASE_READS_ENABLED', 'D2_DEPLOYMENT_REVIEWED', 'ALCHEMY_BUDGET_VERIFIED',
  'G3C_REVIEWED_MODE', 'D2_EXECUTION_REVIEWED', 'D2_SIGNING_ENABLED', 'D2_BROADCAST_ENABLED',
  'G3C_SIGNER_DEPLOYED', 'BASE_BROADCASTER_DEPLOYED', 'D2_G1D_ANALYSIS_HANDOFF_ENABLED', 'D2_G1D_ANALYSIS_ENABLED',
];
function safeErrorCode(error) {
  const code = error instanceof Error ? error.message : '';
  return SAFE_ERRORS.has(code) ? code : 'D2H_FAILED_SAFE';
}
function parseArgs(argv) {
  const commands = new Set(['preview', 'start', 'status', 'stop', 'resume', 'summary']);
  let command = 'preview'; let commandSeen = false;
  const values = {}; const booleans = new Set(['--reconciled']);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (commands.has(key)) { if (commandSeen) throw new Error('USAGE'); command = key; commandSeen = true; continue; }
    if (booleans.has(key)) { if (values.reconciled) throw new Error('USAGE'); values.reconciled = true; continue; }
    if (!key.startsWith('--') || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('USAGE');
    const name = key.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    if (Object.hasOwn(values, name)) throw new Error('USAGE');
    values[name] = argv[++i];
  }
  if (values.profile !== undefined && !['default-v1', 'weth-research-v1'].includes(values.profile)) throw new Error('USAGE');
  const profile = values.profile ?? 'default-v1';
  const allowedByCommand = {
    preview: new Set(['profile', 'durationMinutes', 'deadline', 'maxAttempts', 'creditCap', 'successTarget', 'reconciledPriorSuccesses']),
    start: new Set(['profile', 'config', 'manifest', 'durationMinutes', 'deadline', 'maxAttempts', 'creditCap', 'successTarget', 'reconciledPriorSuccesses']),
    status: new Set(['profile', 'manifest']), stop: new Set(['profile', 'manifest']), summary: new Set(['profile', 'config']),
    resume: new Set(['profile', 'config', 'manifest', 'reconciled', 'reconciledAttempts', 'reconciledSuccesses', 'reconciledCredits', 'reconciledUnknownCharges']),
  };
  if (Object.keys(values).some((key) => !allowedByCommand[command].has(key))) throw new Error('USAGE');
  return { command, ...values, profile };
}
function positiveInt(value, code = 'RUN_BOUNDS_INVALID') {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(code);
  return Number(value);
}
function nonnegativeInt(value, code = 'RUN_BOUNDS_INVALID') {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(code);
  return Number(value);
}
function parseDeadline(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) throw new Error('RUN_BOUNDS_INVALID');
  const timestamp = Date.parse(value);
  if (!Number.isSafeInteger(timestamp)) throw new Error('RUN_BOUNDS_INVALID');
  return new Date(timestamp).toISOString();
}
function planFor(profile) { return profile === 'weth-research-v1' ? WETH_RESEARCH_PLAN : NANSEN_COLLECTOR_PLAN; }
function makeBounds(options) {
  const durationMinutes = options.durationMinutes === undefined ? null : positiveInt(options.durationMinutes);
  const deadlineAt = options.deadline === undefined ? null : parseDeadline(options.deadline);
  if ((durationMinutes === null) === (deadlineAt === null)) throw new Error('RUN_BOUNDS_REQUIRED');
  const maxAttempts = positiveInt(options.maxAttempts);
  const creditCap = positiveInt(options.creditCap);
  const successTarget = positiveInt(options.successTarget);
  const reconciledPriorSuccesses = nonnegativeInt(options.reconciledPriorSuccesses, 'RUN_BOUNDS_REQUIRED');
  const preview = buildD2hPreview({ plan: planFor(options.profile), costs: NANSEN_OPERATION_COSTS,
    durationMinutes, deadlineAt, maxAttempts, creditCap, successTarget, reconciledPriorSuccesses });
  if (preview.missingInputs.length) throw new Error('RUN_BOUNDS_REQUIRED');
  const deadline = preview.requested.deadlineAt;
  if (Date.parse(deadline) <= Date.now()) throw new Error('RUN_DEADLINE_EXPIRED');
  return { deadlineAt: deadline, maxAttempts, creditCap, successTarget, reconciledPriorSuccesses };
}
function requireConfigPath(path) {
  if (typeof path !== 'string') throw new Error('COLLECTION_EXTERNAL_CONFIG_REQUIRED');
  return path;
}
function assertExternalCollectionGates(environment, creditCap) {
  if (environment.NANSEN_COLLECTION_REVIEWED !== 'true' || environment.NANSEN_COLLECTION_ENABLED !== 'true' || environment.NANSEN_API_ENABLED !== 'true') {
    throw new Error('COLLECTION_REQUIRES_SEPARATE_REVIEW_AND_EXPLICIT_ENABLEMENT');
  }
  if (environment.EXECUTION_MODE !== 'paper' || OFF_GATES.some((key) => environment[key] !== 'false')) throw new Error('COLLECTION_UNRELATED_GATE_ENABLED');
  if (environment.NANSEN_COST_PROFILE_VERSION !== NANSEN_COST_PROFILE_VERSION) throw new Error('COLLECTION_COST_PROFILE_MISMATCH');
  const activeBudget = Number(environment.NANSEN_CREDIT_BUDGET);
  const ledgerLimit = Number(environment.NANSEN_LEDGER_LIMIT_CREDITS);
  if (!Number.isSafeInteger(activeBudget) || activeBudget < 1 || !Number.isSafeInteger(ledgerLimit) || ledgerLimit !== activeBudget) throw new Error('ACTIVE_BUDGET_INVALID');
  if (!Number.isSafeInteger(creditCap) || creditCap < 1 || creditCap > activeBudget) throw new Error('RUN_CREDIT_CAP_EXCEEDS_ACTIVE_BUDGET');
}
function printJson(value) { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }
function assertNewManifestLocation(path) {
  const target = resolveExternalManifestPath(path, ROOT);
  try { const stat = lstatSync(target); if (stat.isFile() || stat.isSymbolicLink()) throw new Error('MANIFEST_ALREADY_EXISTS'); }
  catch (error) { if (error && typeof error === 'object' && error.code === 'ENOENT') return target; throw error; }
  throw new Error('MANIFEST_ALREADY_EXISTS');
}
function markerPath(manifestPath) { return resolveExternalManifestPath(manifestPath + '.stop', ROOT); }
function readStopRequest(path, runId) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) return 'INVALID';
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(',') !== 'requestedAt,runId,schemaVersion' ||
        value.schemaVersion !== 1 || value.runId !== runId || typeof value.requestedAt !== 'string') return 'INVALID';
    return 'REQUESTED';
  } catch (error) { if (error && typeof error === 'object' && error.code === 'ENOENT') return 'NONE'; return 'INVALID'; }
}
function writeStopRequest(path, runId) {
  const marker = markerPath(path);
  const payload = JSON.stringify({ schemaVersion: 1, runId, requestedAt: new Date().toISOString() });
  try { const fd = openSync(marker, 'wx', 0o600); try { writeFileSync(fd, payload); } finally { closeSync(fd); } }
  catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'EEXIST')) throw new Error('STOP_REQUEST_UNAVAILABLE');
    if (readStopRequest(marker, runId) === 'REQUESTED') return;
    throw new Error('STOP_REQUEST_INVALID');
  }
}
function removeStopRequest(path, runId) {
  const marker = markerPath(path);
  if (readStopRequest(marker, runId) === 'REQUESTED') { try { unlinkSync(marker); } catch { /* A leftover marker is harmless and will fail closed on the next run. */ } }
}
function safeLedgerEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function updateFromReconciliation(manifest, options) {
  const ledgerChanged = !safeLedgerEqual(manifest.ledger, makeSafeLedger(manifest._currentLedger));
  const counterKeys = ['reconciledAttempts', 'reconciledSuccesses', 'reconciledCredits', 'reconciledUnknownCharges'];
  const supplied = counterKeys.filter((key) => options[key] !== undefined).length;
  const requiresCounters = ledgerChanged || manifest.stats.unknownChargeAttempts > 0;
  if (requiresCounters && supplied === 0) throw new Error('RESUME_COUNTERS_REQUIRED');
  if (!requiresCounters && supplied > 0) throw new Error('RESUME_COUNTERS_INVALID');
  if (supplied > 0 && supplied !== counterKeys.length) throw new Error('RESUME_COUNTERS_INVALID');
  if (supplied === counterKeys.length) {
    const values = {
      providerAttempts: positiveOrZero(options.reconciledAttempts), qualifyingSuccesses: positiveOrZero(options.reconciledSuccesses),
      actualChargedCredits: positiveOrZero(options.reconciledCredits), unknownChargeAttempts: positiveOrZero(options.reconciledUnknownCharges),
    };
    if (values.providerAttempts < manifest.stats.providerAttempts || values.qualifyingSuccesses < manifest.stats.qualifyingSuccesses ||
        values.actualChargedCredits < manifest.stats.actualChargedCredits || values.providerAttempts > manifest.maxAttempts ||
        values.qualifyingSuccesses > manifest.successTarget || values.actualChargedCredits > manifest.creditCap ||
        values.unknownChargeAttempts !== 0 || values.unknownChargeAttempts > values.providerAttempts) {
      throw new Error('RESUME_COUNTERS_INVALID');
    }
    Object.assign(manifest.stats, values);
  }
}
function positiveOrZero(value) { return value === undefined ? NaN : nonnegativeInt(value, 'RESUME_COUNTERS_INVALID'); }
function setManifestStatus(manifest, scheduler, ledger) {
  const state = scheduler.getState();
  const reason = state.stopReason ?? 'UNKNOWN_STOP';
  manifest.stopReason = reason;
  manifest.status = reason === 'SUCCESS_TARGET_REACHED' ? 'COMPLETED' : FAIL_REASONS.has(reason) ? 'FAILED' : 'STOPPED';
  manifest.pid = process.pid;
  manifest.updatedAt = new Date().toISOString();
  manifest.ledger = makeSafeLedger(ledger.getSnapshot());
}

async function summary(options) {
  const environment = readD2cExternalConfig(requireConfigPath(options.config));
  const store = openNansenObservationStore({ databasePath: environment.NANSEN_OBSERVATION_STORE_PATH, storeId: environment.NANSEN_OBSERVATION_STORE_ID });
  try { printJson(options.profile === 'weth-research-v1' ? summarizeWethResearchHistory(store) : summarizeNansenHistory(store)); }
  finally { store.close(); }
}
async function startOrResume(command, options) {
  const manifestPath = options.manifest;
  if (typeof manifestPath !== 'string') throw new Error('MANIFEST_PATH_INVALID');
  const configPath = requireConfigPath(options.config);
  const environment = readD2cExternalConfig(configPath);
  let existing = null;
  if (command === 'start') assertNewManifestLocation(manifestPath);
  else {
    if (options.reconciled !== true) throw new Error('RESUME_REQUIRES_RECONCILIATION');
    existing = readRunManifest(manifestPath, ROOT);
    if ((existing.profile ?? 'default-v1') !== options.profile) throw new Error('RESUME_NOT_ALLOWED');
    if (existing.status === 'COMPLETED') throw new Error('RESUME_NOT_ALLOWED');
    if (collectionProcessIsAlive(existing.pid)) throw new Error('RUN_ALREADY_ACTIVE');
    if (Date.parse(existing.deadlineAt) <= Date.now()) throw new Error('RUN_DEADLINE_EXPIRED');
  }
  const creditCap = command === 'start' ? positiveInt(options.creditCap) : existing.creditCap;
  assertExternalCollectionGates(environment, creditCap);
  const apiKey = process.env.NANSEN_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('NANSEN_CREDENTIAL_UNAVAILABLE');
  const runId = existing?.runId ?? undefined;
  const lock = acquireCollectionLock(environment.NANSEN_OBSERVATION_STORE_PATH, { ...(runId ? { runId } : {}), recoverStale: command === 'resume' });
  let ledger = null;
  let store = null;
  let manifest = existing;
  let manifestCheckpointed = false;
  let scheduler = null;
  let stopPoll = null;
  let deadlineTimer = null;
  const onSignal = () => scheduler?.stop('OPERATOR_SIGNAL');
  try {
    ledger = openCreditLedger({ databasePath: environment.NANSEN_LEDGER_PATH, budgetId: environment.NANSEN_LEDGER_BUDGET_ID,
      limitCredits: Number(environment.NANSEN_LEDGER_LIMIT_CREDITS), costProfileVersion: environment.NANSEN_COST_PROFILE_VERSION });
    let ledgerSnapshot = ledger.getSnapshot();
    if (ledgerSnapshot.pendingAttemptCount > 0 || ledgerSnapshot.reconciliationRequired || ledger.listUnknownChargeAttempts().length > 0) {
      throw new Error('LEDGER_RECONCILIATION_REQUIRED');
    }
    if (command === 'start') {
      const bounds = makeBounds(options);
      if (creditCap > ledgerSnapshot.remainingCredits) throw new Error('LEDGER_REMAINING_BELOW_CREDIT_CAP');
      store = openNansenObservationStore({ databasePath: environment.NANSEN_OBSERVATION_STORE_PATH, storeId: environment.NANSEN_OBSERVATION_STORE_ID });
      manifest = makeNewRunManifest({ bounds, profile: options.profile, stateIdentity: createStateIdentity({ ledgerPath: environment.NANSEN_LEDGER_PATH,
        budgetId: environment.NANSEN_LEDGER_BUDGET_ID, costProfileVersion: environment.NANSEN_COST_PROFILE_VERSION,
        observationStorePath: environment.NANSEN_OBSERVATION_STORE_PATH, observationStoreId: environment.NANSEN_OBSERVATION_STORE_ID }),
        baselineAllocatedCredits: ledgerSnapshot.allocatedCredits, ledger: ledgerSnapshot });
      writeRunManifest(manifestPath, ROOT, manifest, { createOnly: true }); manifestCheckpointed = true;
    } else {
      store = openNansenObservationStore({ databasePath: environment.NANSEN_OBSERVATION_STORE_PATH, storeId: environment.NANSEN_OBSERVATION_STORE_ID });
      const identity = createStateIdentity({ ledgerPath: environment.NANSEN_LEDGER_PATH, budgetId: environment.NANSEN_LEDGER_BUDGET_ID,
        costProfileVersion: environment.NANSEN_COST_PROFILE_VERSION, observationStorePath: environment.NANSEN_OBSERVATION_STORE_PATH,
        observationStoreId: environment.NANSEN_OBSERVATION_STORE_ID });
      if (identity !== manifest.stateIdentity) throw new Error('RESUME_NOT_ALLOWED');
      const mutable = { ...manifest, _currentLedger: ledgerSnapshot };
      updateFromReconciliation(mutable, options);
      delete mutable._currentLedger;
      manifest = mutable;
      manifest.status = 'RUNNING'; manifest.pid = process.pid; manifest.stopReason = null;
      manifest.reconciliationConfirmedAt = new Date().toISOString(); manifest.ledger = makeSafeLedger(ledgerSnapshot); manifest.updatedAt = new Date().toISOString();
      writeRunManifest(manifestPath, ROOT, manifest);
      manifestCheckpointed = true;
    }
    const resolvedBounds = command === 'start'
      ? { ...manifestBounds(manifest), reconciledPriorSuccesses: manifest.reconciledPriorSuccesses }
      : manifestBounds(manifest);
    const persist = () => writeRunManifest(manifestPath, ROOT, manifest);
    const hookOptions = { bounds: resolvedBounds, manifest, getLedgerSnapshot: () => ledger.getSnapshot(),
      costs: NANSEN_OPERATION_COSTS, persist, stopRequested: () => readStopRequest(markerPath(manifestPath), manifest.runId) !== 'NONE' };
    const hooks = options.profile === 'weth-research-v1' ? createD2lResearchHooks(hookOptions) : createD2hRunHooks(hookOptions);
    const client = createNansenClient({ ledger, enabled: true, apiKey, maxPages: 1, timeoutMs: 8_000, maxResponseBytes: 1_048_576 });
    const manager = createNansenQueryManager({ client, store, enabled: true, maxPageBound: 1, maxRetryBound: 0, beforeDispatch: hooks.beforeDispatch,
      ...(options.profile === 'weth-research-v1' ? { cachePolicy: 'weth-research-v1' } : {}) });
    scheduler = createNansenCollector({ manager, profile: options.profile, enabled: true, stopOnFailure: true, beforeQuery: hooks.beforeQuery, onQuery: hooks.onQuery, onQueryError: hooks.onQueryError,
      onCycle: () => { hooks.onCycle(); printJson({ event: 'cycle', ...publicRunStatus(manifest, true) }); } });
    process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
    const deadlineDelay = Math.max(1, Date.parse(manifest.deadlineAt) - Date.now());
    deadlineTimer = setTimeout(() => scheduler?.stop('DEADLINE_REACHED'), deadlineDelay);
    stopPoll = setInterval(() => {
      const marker = readStopRequest(markerPath(manifestPath), manifest.runId);
      if (marker === 'REQUESTED') scheduler?.stop('OPERATOR_STOP_REQUESTED');
      else if (marker === 'INVALID') scheduler?.stop('STOP_REQUEST_INVALID');
    }, 250);
    const didStart = await scheduler.start();
    if (!didStart) throw new Error('RUN_ALREADY_ACTIVE');
    if (scheduler.getState().running || scheduler.getState().cycleInProgress) await scheduler.waitForStop();
    setManifestStatus(manifest, scheduler, ledger);
    persist();
    removeStopRequest(manifestPath, manifest.runId);
    printJson({ event: 'stopped', ...publicRunStatus(manifest, false) });
  } catch (error) {
    if (manifest && manifestCheckpointed) {
      manifest.status = 'FAILED'; manifest.stopReason = safeErrorCode(error); manifest.updatedAt = new Date().toISOString();
      if (ledger) manifest.ledger = makeSafeLedger(ledger.getSnapshot());
      try { writeRunManifest(manifestPath, ROOT, manifest); } catch { /* Preserve the original fail-closed error. */ }
    }
    throw error;
  } finally {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    if (stopPoll !== null) clearInterval(stopPoll);
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    try { store?.close(); } finally { try { ledger?.close(); } finally { lock.release(); } }
  }
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'preview') {
    const durationMinutes = options.durationMinutes === undefined ? null : positiveInt(options.durationMinutes);
    const deadlineAt = options.deadline === undefined ? null : parseDeadline(options.deadline);
    const maxAttempts = options.maxAttempts === undefined ? null : positiveInt(options.maxAttempts);
    const creditCap = options.creditCap === undefined ? null : positiveInt(options.creditCap);
    const successTarget = options.successTarget === undefined ? null : positiveInt(options.successTarget);
    const reconciledPriorSuccesses = options.reconciledPriorSuccesses === undefined ? null : nonnegativeInt(options.reconciledPriorSuccesses);
    printJson(buildD2hPreview({ plan: planFor(options.profile), costs: NANSEN_OPERATION_COSTS, durationMinutes, deadlineAt,
      maxAttempts, creditCap, successTarget, reconciledPriorSuccesses }));
    return;
  }
  if (options.command === 'status') {
    const manifest = readRunManifest(options.manifest, ROOT);
    if ((manifest.profile ?? 'default-v1') !== options.profile) throw new Error('STATUS_COMMAND_INVALID');
    printJson(publicRunStatus(manifest, collectionProcessIsAlive(manifest.pid)));
    return;
  }
  if (options.command === 'stop') {
    const manifest = readRunManifest(options.manifest, ROOT);
    if ((manifest.profile ?? 'default-v1') !== options.profile) throw new Error('STATUS_COMMAND_INVALID');
    if (manifest.status !== 'RUNNING' || !collectionProcessIsAlive(manifest.pid)) throw new Error('STOP_REQUEST_UNAVAILABLE');
    writeStopRequest(options.manifest, manifest.runId);
    printJson({ event: 'stop-requested', runId: manifest.runId, requestedAt: new Date().toISOString() });
    return;
  }
  if (options.command === 'summary') { await summary(options); return; }
  await startOrResume(options.command, options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = safeErrorCode(error);
    process.stderr.write('D2h collection preparation stopped safely: ' + code + '. No secret values, file paths, request bodies, or raw observations are printed.\n');
    process.exitCode = 1;
  });
}

function manifestBounds(manifest) {
  return { deadlineAt: manifest.deadlineAt, maxAttempts: manifest.maxAttempts, creditCap: manifest.creditCap,
    successTarget: manifest.successTarget, reconciledPriorSuccesses: manifest.reconciledPriorSuccesses };
}
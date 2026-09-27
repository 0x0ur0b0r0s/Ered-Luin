import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASE_ASSET_ADDRESSES, BASE_USDC_OHLCV_PRICE_CACHE_KEY, NANSEN_COST_PROFILE_VERSION, NANSEN_OPERATION_COSTS,
  createBaseUsdcOhlcvPriceQuery, createNansenClient, createNansenQueryManager, openCreditLedger, openNansenObservationStore,
} from '../../packages/nansen/dist/index.js';
import { readD2cExternalConfig } from '../d2c/manual-collect.mjs';
import { collectionProcessIsAlive } from '../d2c/collector-lock.mjs';
import { createStateIdentity, readRunManifest } from '../d2h/bounded-session.mjs';
import { D2U_CREDIT_LIMIT, D2U_RUN_ID } from '../d2u/diagnostic.mjs';
import { acquireD2uSharedStoreLock, resolveD2uScopedConfiguration } from '../d2u/run-usdc-diagnostic.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const D2L_PREFIX = 'd2l-';
const MAX_RAW_BYTES = 1_048_576;
const OFF_GATES = [
  'NANSEN_API_ENABLED', 'NANSEN_COLLECTION_REVIEWED', 'NANSEN_COLLECTION_ENABLED',
  'LIVE_EXECUTION_ENABLED', 'D2_BASE_READS_ENABLED', 'D2_DEPLOYMENT_REVIEWED', 'ALCHEMY_BUDGET_VERIFIED',
  'G3C_REVIEWED_MODE', 'D2_EXECUTION_REVIEWED', 'D2_SIGNING_ENABLED', 'D2_BROADCAST_ENABLED',
  'G3C_SIGNER_DEPLOYED', 'BASE_BROADCASTER_DEPLOYED', 'D2_G1D_ANALYSIS_HANDOFF_ENABLED', 'D2_G1D_ANALYSIS_ENABLED',
];
const SAFE_FAILURES = new Set([
  'D2V_USAGE', 'D2V_CONFIGURATION_INVALID', 'D2V_EXTERNAL_STATE_UNAVAILABLE', 'D2V_GATES_NOT_OFF',
  'D2V_COST_PROFILE_MISMATCH', 'D2V_PRIOR_D2U_EVIDENCE_INVALID', 'D2V_ALREADY_ATTEMPTED',
  'D2V_LEDGER_STATE_INVALID', 'D2V_PRIOR_LEDGER_INVALID', 'D2V_COLLECTOR_STATE_AMBIGUOUS',
  'D2V_COLLECTOR_NOT_STOPPED', 'D2V_COLLECTOR_IDENTITY_MISMATCH', 'D2V_COLLECTOR_ACCOUNTING_MISMATCH',
  'D2V_STORE_LOCKED', 'D2V_POSTFLIGHT_FAILED', 'D2V_CAPTURE_FAILED', 'D2V_RUN_FAILED_SAFE',
]);
function fail(code) { throw new Error(code); }
function inside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}
function externalFile(path, maxBytes = 16_777_216) {
  if (typeof path !== 'string' || !isAbsolute(path) || inside(ROOT, path)) fail('D2V_EXTERNAL_STATE_UNAVAILABLE');
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) fail('D2V_EXTERNAL_STATE_UNAVAILABLE');
    return resolve(path);
  } catch { fail('D2V_EXTERNAL_STATE_UNAVAILABLE'); }
}
function externalDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || inside(ROOT, path)) fail('D2V_EXTERNAL_STATE_UNAVAILABLE');
  try { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('D2V_EXTERNAL_STATE_UNAVAILABLE'); }
  catch { fail('D2V_EXTERNAL_STATE_UNAVAILABLE'); }
  return resolve(path);
}
function readJson(path, maxBytes = 65_536) {
  try { return JSON.parse(readFileSync(externalFile(path, maxBytes), 'utf8')); }
  catch { fail('D2V_EXTERNAL_STATE_UNAVAILABLE'); }
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('D2V_CONFIGURATION_INVALID'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value !== 'object') fail('D2V_CONFIGURATION_INVALID');
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}
function writeCreateOnly(path, bytes) {
  let descriptor;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
  } catch {
    if (descriptor !== undefined) { try { closeSync(descriptor); } catch { /* Keep the bounded failure. */ } }
    fail('D2V_EXTERNAL_STATE_UNAVAILABLE');
  }
}
function writeJsonCreateOnly(path, value) {
  writeCreateOnly(path, Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8'));
}
function eastTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isSafeInteger(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const zoneParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', timeZoneName: 'short' }).formatToParts(date);
  const offsetParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', timeZoneName: 'shortOffset' }).formatToParts(date);
  const part = (name) => parts.find((item) => item.type === name)?.value ?? '';
  const zoneName = zoneParts.find((item) => item.type === 'timeZoneName')?.value ?? 'Eastern local';
  const offsetLabel = offsetParts.find((item) => item.type === 'timeZoneName')?.value ?? '';
  const offset = offsetLabel.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/u);
  const utcOffset = offset ? 'UTC' + (offset[1] === '+' ? '+' : '−') + offset[2].padStart(2, '0') + ':' + (offset[3] ?? '00') : 'UTC offset unavailable';
  return part('year') + '-' + part('month') + '-' + part('day') + ' ' + part('hour') + ':' + part('minute') + ':' + part('second') +
    ' ' + zoneName + ' (' + utcOffset + ')';
}
function safeLedger(snapshot) {
  return Object.freeze({ limitCredits: snapshot.limitCredits, reservedEstimateCredits: snapshot.reservedEstimateCredits,
    allocatedCredits: snapshot.allocatedCredits, remainingCredits: snapshot.remainingCredits, overrunCredits: snapshot.overrunCredits,
    overBudgetCredits: snapshot.overBudgetCredits, reportedChargedCreditsTotal: snapshot.reportedChargedCreditsTotal,
    reportedChargeCount: snapshot.reportedChargeCount, pendingAttemptCount: snapshot.pendingAttemptCount,
    reconciliationRequired: snapshot.reconciliationRequired, haltReason: snapshot.haltReason });
}
function safeLedgerEqual(a, b) { return JSON.stringify(safeLedger(a)) === JSON.stringify(safeLedger(b)); }
function assertGatesOff() {
  if (OFF_GATES.some((key) => process.env[key] === 'true') ||
      (process.env.EXECUTION_MODE !== undefined && process.env.EXECUTION_MODE !== 'paper')) fail('D2V_GATES_NOT_OFF');
}
function verifyOriginalSevenCreditLedgerReadOnly(environment) {
  const path = externalFile(environment.NANSEN_LEDGER_PATH);
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA query_only = ON');
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    const meta = db.prepare('SELECT schema_version, budget_id, limit_credits, profile_version, allocated_credits, halted, halt_reason FROM ledger_meta WHERE singleton = 1').get();
    const counts = db.prepare(`SELECT COUNT(*) AS attempts, SUM(COALESCE(charged_credits, 0)) AS charged,
      SUM(CASE WHEN outcome IS NULL THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN outcome IS NOT NULL AND charged_credits IS NULL THEN 1 ELSE 0 END) AS unknown FROM attempts`).get();
    const integrity = db.prepare('PRAGMA integrity_check').all();
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    if (![2, 3].includes(version) || Number(meta?.schema_version) !== version || meta?.budget_id !== environment.NANSEN_LEDGER_BUDGET_ID ||
        Number(meta?.limit_credits) !== 7 || meta?.profile_version !== environment.NANSEN_COST_PROFILE_VERSION ||
        meta?.allocated_credits !== '7' || Number(meta?.halted) !== 0 || meta?.halt_reason !== null ||
        Number(counts?.attempts) !== 3 || Number(counts?.charged) !== 7 || Number(counts?.pending) !== 0 || Number(counts?.unknown) !== 0 ||
        integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok' || foreignKeys.length !== 0) fail('D2V_PRIOR_LEDGER_INVALID');
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === 'D2V_PRIOR_LEDGER_INVALID') throw error;
    fail('D2V_PRIOR_LEDGER_INVALID');
  } finally { try { db?.close(); } catch { /* Read-only check cleanup. */ } }
}
function verifyPriorD2uArtifacts(directory) {
  const names = readdirSync(directory);
  const dispatchFiles = names.filter((name) => /^dispatch\.marker\.json\.\d+$/u.test(name)).sort();
  const first = readJson(join(directory, 'dispatch.marker.json.1'));
  const second = readJson(join(directory, 'dispatch.marker.json.2'));
  const continuation = readJson(join(directory, 'raw-attribution.marker.json.2'));
  const attribution = readJson(join(directory, 'raw-attribution-report.json'));
  const original = readJson(join(directory, 'run.marker.json'));
  if (dispatchFiles.join(',') !== 'dispatch.marker.json.1,dispatch.marker.json.2' ||
      first.runId !== D2U_RUN_ID || first.sequence !== 1 || first.operation !== 'TOKEN_SCREENER' ||
      second.runId !== D2U_RUN_ID || second.sequence !== 2 || second.operation !== 'TOKEN_SCREENER' ||
      continuation.runId !== D2U_RUN_ID || continuation.sequence !== 2 || continuation.operation !== 'TOKEN_SCREENER' ||
      attribution.runId !== D2U_RUN_ID || attribution.request?.endpoint !== '/api/v1/token-screener' ||
      original.runId !== D2U_RUN_ID || original.creditLimit !== D2U_CREDIT_LIMIT || original.transportAttemptLimit !== D2U_CREDIT_LIMIT ||
      !existsSync(join(directory, 'raw-attribution-query-result.json')) || names.some((name) => name.startsWith('ohlcv-'))) {
    fail('D2V_PRIOR_D2U_EVIDENCE_INVALID');
  }
  return Object.freeze({ priorProviderAttempts: 2, priorReportedCredits: 2, maximumAttempts: 3, maximumCredits: 3 });
}
function verifyD2uLedger(ledger, expectedAttempts) {
  const state = ledger.getSnapshot();
  if (state.limitCredits !== D2U_CREDIT_LIMIT || state.allocatedCredits !== expectedAttempts ||
      state.remainingCredits !== D2U_CREDIT_LIMIT - expectedAttempts || state.reportedChargeCount !== expectedAttempts ||
      state.reportedChargedCreditsTotal !== expectedAttempts || state.pendingAttemptCount !== 0 ||
      state.reconciliationRequired || state.haltReason !== null || ledger.listUnknownChargeAttempts().length !== 0) {
    fail('D2V_LEDGER_STATE_INVALID');
  }
  return state;
}
function stoppedCollector(privateRoot) {
  const candidates = [];
  for (const entry of readdirSync(privateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(D2L_PREFIX)) continue;
    const directory = join(privateRoot, entry.name);
    try {
      const manifest = readRunManifest(join(directory, 'd2l-run.json'), ROOT);
      if (manifest.profile === 'weth-research-v2' && Date.parse(manifest.deadlineAt) > Date.now()) candidates.push({ directory, manifest });
    } catch { /* Ignore invalid or unrelated historical sessions. */ }
  }
  if (candidates.length !== 1) fail('D2V_COLLECTOR_STATE_AMBIGUOUS');
  const { directory, manifest } = candidates[0];
  if (manifest.status !== 'STOPPED' || collectionProcessIsAlive(manifest.pid) || manifest.successTarget !== 850 ||
      manifest.maxAttempts !== 900 || manifest.creditCap !== 2700 || manifest.stats.unknownChargeAttempts !== 0 ||
      manifest.ledger.pendingAttemptCount !== 0 || manifest.ledger.reconciliationRequired) fail('D2V_COLLECTOR_NOT_STOPPED');
  const configPath = externalFile(join(directory, 'collection.json'));
  const config = readD2cExternalConfig(configPath);
  const identity = createStateIdentity({ ledgerPath: config.NANSEN_LEDGER_PATH, budgetId: config.NANSEN_LEDGER_BUDGET_ID,
    costProfileVersion: config.NANSEN_COST_PROFILE_VERSION, observationStorePath: config.NANSEN_OBSERVATION_STORE_PATH,
    observationStoreId: config.NANSEN_OBSERVATION_STORE_ID });
  if (identity !== manifest.stateIdentity) fail('D2V_COLLECTOR_IDENTITY_MISMATCH');
  const ledger = openCreditLedger({ databasePath: config.NANSEN_LEDGER_PATH, budgetId: config.NANSEN_LEDGER_BUDGET_ID,
    limitCredits: Number(config.NANSEN_LEDGER_LIMIT_CREDITS), costProfileVersion: config.NANSEN_COST_PROFILE_VERSION });
  try {
    const snapshot = ledger.getSnapshot();
    if (ledger.listUnknownChargeAttempts().length !== 0 || !safeLedgerEqual(snapshot, manifest.ledger)) fail('D2V_COLLECTOR_ACCOUNTING_MISMATCH');
  } finally { ledger.close(); }
  return Object.freeze({ profile: manifest.profile, state: manifest.status, processAlive: false, runId: manifest.runId,
    manifestPath: join(directory, 'd2l-run.json'), configPath, deadlineAt: manifest.deadlineAt,
    successTarget: manifest.successTarget, maxAttempts: manifest.maxAttempts, creditCap: manifest.creditCap,
    stats: manifest.stats, ledger: manifest.ledger });
}
function makeRawCaptureObserver({ directory, expectedBodyHash, captureState }) {
  return (observation) => {
    try {
      if (observation.operation !== 'TOKEN_OHLCV' || !Number.isSafeInteger(observation.status) || observation.status < 100 || observation.status > 599 ||
          !(observation.body instanceof Uint8Array) || observation.body.byteLength > MAX_RAW_BYTES ||
          typeof observation.attemptId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(observation.attemptId)) {
        captureState.status = 'CAPTURE_FAILED'; captureState.reasonCode = 'RAW_RESPONSE_OUT_OF_BOUNDS'; return;
      }
      const rawName = 'ohlcv-raw-response-' + observation.attemptId + '.bin';
      const metadataName = 'ohlcv-raw-response-' + observation.attemptId + '.capture.json';
      const bytes = new Uint8Array(observation.body);
      const metadata = Object.freeze({ schemaVersion: 1, runId: D2U_RUN_ID, operation: 'TOKEN_OHLCV',
        endpoint: '/api/v1/tgm/token-ohlcv', requestBodySha256: observation.requestBodySha256,
        matchesApprovedRequestBody: observation.requestBodySha256 === expectedBodyHash,
        attemptId: observation.attemptId, capturedAt: observation.capturedAt, capturedAtEastern: eastTime(observation.capturedAt),
        httpStatus: observation.status, providerRequestId: observation.providerRequestId, chargedCredits: observation.chargedCredits,
        contentType: observation.contentType, byteLength: bytes.byteLength, responseSha256: observation.sha256,
        complete: true, rawResponseFile: rawName });
      writeCreateOnly(join(directory, rawName), bytes);
      writeJsonCreateOnly(join(directory, metadataName), metadata);
      captureState.status = 'CAPTURED'; captureState.metadata = metadata; captureState.metadataFile = metadataName;
    } catch {
      captureState.status = 'CAPTURE_FAILED'; captureState.reasonCode = 'RAW_CAPTURE_WRITE_FAILED';
    }
  };
}
function safeSignal(signal) {
  return Object.freeze({ endpoint: signal.endpoint, provider: signal.provider, chainId: signal.chainId, asset: signal.asset,
    metric: signal.metric, timeframe: signal.timeframe ?? null, observedAt: signal.observedAt, fetchedAt: signal.fetchedAt,
    quality: signal.quality, value: signal.value, unit: signal.unit, provenanceId: signal.provenanceId });
}
function publicLedgerState(snapshot, unknownCharges) {
  return Object.freeze({ ...safeLedger(snapshot), unknownChargeAttempts: unknownCharges });
}
export function buildD2vDryRunPlan(now = new Date()) {
  const query = createBaseUsdcOhlcvPriceQuery(now);
  const requestBody = Object.freeze({ chain: 'base', token_address: BASE_ASSET_ADDRESSES.USDC, timeframe: '1m', date: query.date });
  return Object.freeze({ gate: 'D2v', mode: 'DRY_RUN', providerCalls: 0, transportAttempts: 0, credentialRead: false,
    budget: Object.freeze({ allocationId: D2U_RUN_ID, ceilingCredits: D2U_CREDIT_LIMIT, priorAttempts: 2,
      priorReportedCredits: 2, maximumAdditionalAttempts: 1, maximumAdditionalCredits: 1 }),
    request: Object.freeze({ method: 'POST', endpoint: '/api/v1/tgm/token-ohlcv', body: requestBody,
      operation: 'TOKEN_OHLCV', expectedCredits: NANSEN_OPERATION_COSTS.TOKEN_OHLCV, pageBound: 1, retryBound: 0,
      costProfileVersion: NANSEN_COST_PROFILE_VERSION, cacheKey: BASE_USDC_OHLCV_PRICE_CACHE_KEY }),
    rawCapture: 'create-only protected local bytes before parsing; maximum 1 MiB',
    policy: 'fresh completed OHLCV, then fresh standalone screener, then fresh paired screener; no execution quote',
  });
}
export function classifyD2vPrice({ result, now = new Date() }) {
  const signals = Array.isArray(result?.observations) ? result.observations.filter((signal) =>
    signal.endpoint === 'TOKEN_OHLCV' && signal.provider === 'nansen' && signal.chainId === 8453 &&
    signal.asset === 'USDC' && signal.metric === 'price_usd' && signal.timeframe === '1m') : [];
  if (signals.length > 1) return Object.freeze({ status: 'PRICE_AMBIGUOUS', usable: false, signal: null, ageMs: null, priceUsd: null });
  if (signals.length === 0) return Object.freeze({ status: 'PRICE_MISSING', usable: false, signal: null, ageMs: null, priceUsd: null });
  const signal = signals[0];
  const observedMs = Date.parse(signal.observedAt);
  const fetchedMs = Date.parse(signal.fetchedAt);
  const nowMs = now.getTime();
  const ageMs = nowMs - observedMs;
  let micros = null;
  if (typeof signal.value === 'string' && /^[1-9][0-9]*$/u.test(signal.value)) {
    try { micros = BigInt(signal.value); } catch { micros = null; }
  }
  const valid = signal.quality === 'COMPLETE' && micros !== null && micros > 0n && Number.isSafeInteger(observedMs) &&
    Number.isSafeInteger(fetchedMs) && Number.isSafeInteger(nowMs) && observedMs % 60_000 === 0 &&
    observedMs + 60_000 <= fetchedMs && fetchedMs <= nowMs && ageMs >= 0;
  if (!valid) return Object.freeze({ status: 'PRICE_MALFORMED', usable: false, signal: safeSignal(signal), ageMs: Number.isSafeInteger(ageMs) ? ageMs : null, priceUsd: null });
  if (ageMs > 10 * 60_000) return Object.freeze({ status: 'PRICE_STALE', usable: false, signal: safeSignal(signal), ageMs, priceUsd: null });
  const priceUsd = (micros / 1_000_000n).toString() + '.' + (micros % 1_000_000n).toString().padStart(6, '0');
  return Object.freeze({ status: 'PRICE_USABLE', usable: true, signal: safeSignal(signal), ageMs, priceUsd, priceUsdMicros: micros.toString() });
}
export async function runD2vManagedDiagnostic({ ledger, store, apiKey, stateDirectory, runMarkerPath, dispatchMarkerPath,
  resultPath, now = () => new Date(), createClient = createNansenClient, createManager = createNansenQueryManager } = {}) {
  if (!ledger || !store || typeof apiKey !== 'string' || apiKey.length === 0 || typeof stateDirectory !== 'string' ||
      typeof runMarkerPath !== 'string' || typeof dispatchMarkerPath !== 'string' || typeof resultPath !== 'string' || typeof now !== 'function') fail('D2V_CONFIGURATION_INVALID');
  const startedAt = now();
  if (!(startedAt instanceof Date) || !Number.isSafeInteger(startedAt.getTime())) fail('D2V_CONFIGURATION_INVALID');
  const before = verifyD2uLedger(ledger, 2);
  const query = createBaseUsdcOhlcvPriceQuery(startedAt);
  const requestBody = { chain: 'base', token_address: BASE_ASSET_ADDRESSES.USDC, timeframe: '1m', date: query.date };
  const expectedBodyHash = digest(Buffer.from(canonicalJson(requestBody), 'utf8'));
  const captureState = { status: 'NOT_CAPTURED', metadata: null, metadataFile: null, reasonCode: null };
  writeJsonCreateOnly(runMarkerPath, { schemaVersion: 1, gate: 'D2v', runId: D2U_RUN_ID, operation: 'TOKEN_OHLCV',
    endpoint: '/api/v1/tgm/token-ohlcv', requestBodySha256: expectedBodyHash, startedAt: startedAt.toISOString(),
    startedAtEastern: eastTime(startedAt), priorAttempts: 2, priorCredits: 2, maximumAdditionalAttempts: 1,
    maximumAdditionalCredits: 1, pageBound: 1, retryBound: 0, cacheKey: BASE_USDC_OHLCV_PRICE_CACHE_KEY });
  let dispatches = 0;
  const client = createClient({ ledger, enabled: true, apiKey, maxPages: 1, timeoutMs: 8_000, maxResponseBytes: MAX_RAW_BYTES,
    onRawResponse: makeRawCaptureObserver({ directory: stateDirectory, expectedBodyHash, captureState }) });
  const manager = createManager({ client, store, enabled: true, maxPageBound: 1, maxRetryBound: 0, clock: now,
    beforeDispatch() {
      if (dispatches >= 1) return 'D2V_ONE_ATTEMPT_LIMIT';
      const sequence = 3;
      writeJsonCreateOnly(dispatchMarkerPath + '.' + sequence, { schemaVersion: 1, gate: 'D2v', runId: D2U_RUN_ID,
        sequence, operation: 'TOKEN_OHLCV', endpoint: '/api/v1/tgm/token-ohlcv', requestBodySha256: expectedBodyHash,
        pageBound: 1, retryBound: 0, maximumAdditionalCredits: 1, createdAt: now().toISOString(), createdAtEastern: eastTime(now()) });
      dispatches += 1;
      return null;
    } });
  let result = null;
  let failureClass = null;
  try { result = await manager.query(query); }
  catch { failureClass = 'MANAGED_QUERY_FAILURE'; }
  const finishedAt = now();
  if (!(finishedAt instanceof Date) || !Number.isSafeInteger(finishedAt.getTime())) fail('D2V_CONFIGURATION_INVALID');
  const after = ledger.getSnapshot();
  const unknownCharges = ledger.listUnknownChargeAttempts().length;
  if (after.pendingAttemptCount > 0 || after.reconciliationRequired || unknownCharges > 0) failureClass = 'ACCOUNTING_RECONCILIATION_REQUIRED';
  const price = classifyD2vPrice({ result, now: finishedAt });
  const refs = Array.isArray(result?.attemptPageReferences) ? result.attemptPageReferences : [];
  const expectedAllocation = dispatches === 1 ? 3 : 2;
  if (after.limitCredits !== 3 || after.allocatedCredits !== expectedAllocation || after.remainingCredits !== 3 - expectedAllocation ||
      after.reportedChargedCreditsTotal !== expectedAllocation || after.reportedChargeCount !== expectedAllocation || after.pendingAttemptCount !== 0 || after.reconciliationRequired || unknownCharges !== 0) {
    failureClass = 'ACCOUNTING_POSTFLIGHT_MISMATCH';
  }
  if (dispatches > 1 || refs.length > 1 || (dispatches === 1 && refs.length !== 1)) failureClass = 'ATTEMPT_BOUND_MISMATCH';
  if (dispatches === 1 && captureState.status !== 'CAPTURED') failureClass = 'RAW_CAPTURE_FAILED';
  const report = Object.freeze({ schemaVersion: 1, gate: 'D2v', allocationId: D2U_RUN_ID,
    request: Object.freeze({ method: 'POST', endpoint: '/api/v1/tgm/token-ohlcv', chain: 'base',
      tokenAddress: BASE_ASSET_ADDRESSES.USDC, timeframe: '1m', date: query.date,
      requestBodySha256: expectedBodyHash, cacheKey: BASE_USDC_OHLCV_PRICE_CACHE_KEY,
      pageBound: 1, retryBound: 0, expectedCredits: 1 }),
    mode: result?.cacheHit ? 'CACHE_HIT_NO_DISPATCH' : dispatches === 1 ? 'BOUNDED_DISPATCH' : 'NO_DISPATCH',
    status: failureClass ?? (result?.failure ? 'REQUEST_FAILED' : price.status), failureClass,
    cacheHit: result?.cacheHit === true, dispatches, transportAttempts: refs.length,
    attempts: refs.map((ref) => ({ page: ref.page, retry: ref.retry, received: ref.received,
      httpStatus: ref.status, chargedCredits: ref.chargedCredits })),
    providerResult: Object.freeze({ status: result?.status ?? 'unavailable', completeness: result?.completeness ?? 'unknown',
      failureCode: result?.failure?.code ?? null, storeError: result?.storeError ?? null }),
    price, rawCapture: Object.freeze({ status: captureState.status, reasonCode: captureState.reasonCode,
      metadata: captureState.metadata ? { attemptId: captureState.metadata.attemptId, httpStatus: captureState.metadata.httpStatus,
        providerRequestId: captureState.metadata.providerRequestId, chargedCredits: captureState.metadata.chargedCredits,
        capturedAt: captureState.metadata.capturedAt, capturedAtEastern: captureState.metadata.capturedAtEastern,
        byteLength: captureState.metadata.byteLength, responseSha256: captureState.metadata.responseSha256,
        requestBodySha256: captureState.metadata.requestBodySha256, matchesApprovedRequestBody: captureState.metadata.matchesApprovedRequestBody } : null }),
    ledger: Object.freeze({ before: publicLedgerState(before, 0), after: publicLedgerState(after, unknownCharges) }),
    startedAt: startedAt.toISOString(), startedAtEastern: eastTime(startedAt), finishedAt: finishedAt.toISOString(), finishedAtEastern: eastTime(finishedAt),
    boundaries: Object.freeze({ maxAdditionalAttempts: 1, maxAdditionalCredits: 1, retryBound: 0, noCacheEviction: true,
      noAlternativeEndpoint: true, noWalletOrTrading: true, liveExecutionEnabled: false }),
  });
  writeJsonCreateOnly(resultPath, report);
  return report;
}
export function safeD2vFailure(error) {
  const code = error instanceof Error ? error.message : '';
  return SAFE_FAILURES.has(code) ? code : 'D2V_RUN_FAILED_SAFE';
}
function verifyOriginalSevenCreditLedger(environment) { return verifyOriginalSevenCreditLedgerReadOnly(environment); }
export async function dispatchD2vOhlcv({ privateRoot, apiKey, loadConfiguration } = {}) {
  if (typeof privateRoot !== 'string' || typeof apiKey !== 'string' || apiKey.length === 0) fail('D2V_CONFIGURATION_INVALID');
  assertGatesOff();
  const config = resolveD2uScopedConfiguration(privateRoot, loadConfiguration);
  const environment = config.environment;
  if (environment.NANSEN_COST_PROFILE_VERSION !== NANSEN_COST_PROFILE_VERSION) fail('D2V_COST_PROFILE_MISMATCH');
  const stateDirectory = externalDirectory(join(privateRoot, D2U_RUN_ID));
  const mainConfigPath = externalFile(config.mainConfigPath);
  const originalConfigPath = externalFile(config.originalValidationConfigPath);
  const mainHash = digest(readFileSync(mainConfigPath));
  const originalHash = digest(readFileSync(originalConfigPath));
  verifyOriginalSevenCreditLedger(environment);
  const prior = verifyPriorD2uArtifacts(stateDirectory);
  const initialCollector = stoppedCollector(privateRoot);
  const storePath = externalFile(environment.NANSEN_OBSERVATION_STORE_PATH);
  const ledgerPath = externalFile(join(stateDirectory, 'credits.sqlite'));
  const runMarkerPath = join(stateDirectory, 'ohlcv-run.marker.json');
  const dispatchMarkerPath = join(stateDirectory, 'ohlcv-attempt.marker.json');
  const resultPath = join(stateDirectory, 'ohlcv-diagnostic-summary.json');
  for (const path of [runMarkerPath, dispatchMarkerPath + '.3', resultPath, join(stateDirectory, 'ohlcv-completion.json')]) {
    if (existsSync(path)) fail('D2V_ALREADY_ATTEMPTED');
  }
  if (prior.priorProviderAttempts !== 2 || prior.priorReportedCredits !== 2) fail('D2V_PRIOR_D2U_EVIDENCE_INVALID');
  let lock;
  let ledger;
  let store;
  let result;
  try {
    lock = acquireD2uSharedStoreLock(storePath);
    const lockedCollector = stoppedCollector(privateRoot);
    if (lockedCollector.runId !== initialCollector.runId) fail('D2V_COLLECTOR_STATE_AMBIGUOUS');
    ledger = openCreditLedger({ databasePath: ledgerPath, budgetId: D2U_RUN_ID,
      limitCredits: D2U_CREDIT_LIMIT, costProfileVersion: NANSEN_COST_PROFILE_VERSION });
    verifyD2uLedger(ledger, 2);
    store = openNansenObservationStore({ databasePath: storePath, storeId: environment.NANSEN_OBSERVATION_STORE_ID });
    result = await runD2vManagedDiagnostic({ ledger, store, apiKey, stateDirectory,
      runMarkerPath, dispatchMarkerPath, resultPath });
  } finally {
    try { store?.close(); } finally { try { ledger?.close(); } finally { lock?.release(); } }
  }
  assertGatesOff();
  const postConfig = resolveD2uScopedConfiguration(privateRoot, loadConfiguration);
  const mainConfigUnchanged = digest(readFileSync(externalFile(postConfig.mainConfigPath))) === mainHash;
  const originalConfigUnchanged = digest(readFileSync(externalFile(postConfig.originalValidationConfigPath))) === originalHash;
  const previousSevenCreditLedgerPreserved = verifyOriginalSevenCreditLedger(postConfig.environment);
  const sharedStoreLockReleased = !existsSync(storePath + '.collector.lock');
  const collectorAfter = stoppedCollector(privateRoot);
  const finalLedger = openCreditLedger({ databasePath: ledgerPath, budgetId: D2U_RUN_ID,
    limitCredits: D2U_CREDIT_LIMIT, costProfileVersion: NANSEN_COST_PROFILE_VERSION });
  let finalAccounting;
  try { finalAccounting = publicLedgerState(finalLedger.getSnapshot(), finalLedger.listUnknownChargeAttempts().length); }
  finally { finalLedger.close(); }
  if (!mainConfigUnchanged || !originalConfigUnchanged || !previousSevenCreditLedgerPreserved || !sharedStoreLockReleased ||
      collectorAfter.runId !== initialCollector.runId || collectorAfter.state !== 'STOPPED') fail('D2V_POSTFLIGHT_FAILED');
  const completion = Object.freeze({ ...result, collectorAtDispatch: Object.freeze({ state: initialCollector.state,
    processAlive: initialCollector.processAlive, deadlineAt: initialCollector.deadlineAt,
    successTarget: initialCollector.successTarget, maxAttempts: initialCollector.maxAttempts, creditCap: initialCollector.creditCap }),
    collectorAfterDiagnostic: Object.freeze({ state: collectorAfter.state, processAlive: collectorAfter.processAlive }),
    postflight: Object.freeze({ mainConfigurationUnchanged: mainConfigUnchanged, originalValidationConfigurationUnchanged: originalConfigUnchanged,
      originalSevenCreditLedgerPreserved: previousSevenCreditLedgerPreserved, sharedStoreLockReleased, finalD2uLedger: finalAccounting }),
    resumeEligible: result.failureClass === null && sharedStoreLockReleased });
  writeJsonCreateOnly(join(stateDirectory, 'ohlcv-completion.json'), completion);
  return completion;
}
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizedSignalSchema } from '../../packages/contracts/dist/index.js';
import {
  BASE_ASSET_ADDRESSES, BASE_USDC_OHLCV_PRICE_CACHE_KEY, NANSEN_COST_PROFILE_VERSION,
  openCreditLedger, openNansenObservationStore, usdToMicros,
} from '../../packages/nansen/dist/index.js';
import { buildNansenAdapters } from '../../packages/nansen/dist/adapters.js';
import { D2U_CREDIT_LIMIT, D2U_RUN_ID } from '../d2u/diagnostic.mjs';
import { acquireD2uSharedStoreLock, resolveD2uScopedConfiguration } from '../d2u/run-usdc-diagnostic.mjs';
import { readPersistedUsdcReadiness } from '../d2u/readiness-check.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SAFE_ERRORS = new Set(['D2V_REPLAY_USAGE', 'D2V_REPLAY_STATE_INVALID', 'D2V_REPLAY_ALREADY_DONE',
  'D2V_REPLAY_STORE_LOCKED', 'D2V_REPLAY_NORMALIZATION_FAILED', 'D2V_REPLAY_PERSIST_FAILED', 'D2V_REPLAY_PRIOR_SNAPSHOT_MISMATCH', 'D2V_REPLAY_STORE_WRITE_FAILED', 'D2V_REPLAY_STORE_WRITE_INVALID_INPUT', 'D2V_REPLAY_STORE_WRITE_DATABASE_FAILURE', 'D2V_REPLAY_STORE_WRITE_CAPACITY_EXCEEDED', 'D2V_REPLAY_STORE_WRITE_DATABASE_CORRUPT', 'D2V_REPLAY_LATEST_MISMATCH']);
function fail(code) { throw new Error(code); }
function inside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}
function privateFile(path, maxBytes = 16_777_216) {
  if (typeof path !== 'string' || !isAbsolute(path) || inside(ROOT, path)) fail('D2V_REPLAY_STATE_INVALID');
  try { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) fail('D2V_REPLAY_STATE_INVALID'); }
  catch { fail('D2V_REPLAY_STATE_INVALID'); }
  return resolve(path);
}
function privateDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || inside(ROOT, path)) fail('D2V_REPLAY_STATE_INVALID');
  try { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('D2V_REPLAY_STATE_INVALID'); }
  catch { fail('D2V_REPLAY_STATE_INVALID'); }
  return resolve(path);
}
function readJson(path, maxBytes = 65_536) {
  try { return JSON.parse(readFileSync(privateFile(path, maxBytes), 'utf8')); }
  catch { fail('D2V_REPLAY_STATE_INVALID'); }
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('D2V_REPLAY_STATE_INVALID'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (!value || typeof value !== 'object') fail('D2V_REPLAY_STATE_INVALID');
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}
function writeCreateOnly(path, value) {
  let descriptor;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8'));
    fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
  } catch {
    if (descriptor !== undefined) { try { closeSync(descriptor); } catch { /* Preserve bounded failure. */ } }
    fail('D2V_REPLAY_STATE_INVALID');
  }
}
function eastern(value) {
  const date = new Date(value);
  if (!Number.isSafeInteger(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', timeZoneName: 'short' }).formatToParts(date).find((part) => part.type === 'timeZoneName')?.value ?? 'Eastern local';
  const offsetLabel = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', timeZoneName: 'shortOffset' }).formatToParts(date).find((part) => part.type === 'timeZoneName')?.value ?? '';
  const offset = offsetLabel.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/u);
  const utcOffset = offset ? 'UTC' + (offset[1] === '+' ? '+' : '−') + offset[2].padStart(2, '0') + ':' + (offset[3] ?? '00') : 'UTC offset unavailable';
  const part = (key) => parts.find((item) => item.type === key)?.value ?? '';
  return part('year') + '-' + part('month') + '-' + part('day') + ' ' + part('hour') + ':' + part('minute') + ':' + part('second') + ' ' + name + ' (' + utcOffset + ')';
}

export async function replayD2vCapturedResponse({ privateRoot } = {}) {
  if (typeof privateRoot !== 'string' || !isAbsolute(privateRoot) || inside(ROOT, privateRoot)) fail('D2V_REPLAY_STATE_INVALID');
  const root = privateDirectory(privateRoot);
  const stateDirectory = privateDirectory(join(root, D2U_RUN_ID));
  const completionPath = join(stateDirectory, 'ohlcv-completion.json');
  const summaryPath = join(stateDirectory, 'ohlcv-diagnostic-summary.json');
  const replayReportPath = join(stateDirectory, 'ohlcv-normalizer-replay.json');
  if (existsSync(replayReportPath)) fail('D2V_REPLAY_ALREADY_DONE');
  const completion = readJson(completionPath);
  const summary = readJson(summaryPath);
  const capture = completion.rawCapture?.metadata;
  const captureDetails = capture?.attemptId ? readJson(join(stateDirectory, 'ohlcv-raw-response-' + capture.attemptId + '.capture.json')) : null;
  if (completion.gate !== 'D2v' || completion.allocationId !== D2U_RUN_ID || completion.dispatches !== 1 ||
      completion.transportAttempts !== 1 || completion.failureClass !== null || completion.status !== 'REQUEST_FAILED' ||
      completion.postflight?.sharedStoreLockReleased !== true || completion.resumeEligible !== true ||
      completion.postflight?.finalD2uLedger?.allocatedCredits !== 3 || completion.postflight?.finalD2uLedger?.reportedChargeCount !== 3 ||
      completion.postflight?.finalD2uLedger?.reportedChargedCreditsTotal !== 3 || completion.postflight?.finalD2uLedger?.remainingCredits !== 0 ||
      completion.postflight?.finalD2uLedger?.pendingAttemptCount !== 0 || completion.postflight?.finalD2uLedger?.reconciliationRequired !== false ||
      completion.postflight?.finalD2uLedger?.unknownChargeAttempts !== 0 || completion.postflight?.originalSevenCreditLedgerPreserved !== true || !capture?.matchesApprovedRequestBody || capture.httpStatus !== 200 ||
      capture.chargedCredits !== 1 || !captureDetails || captureDetails.complete !== true || captureDetails.responseSha256 !== capture.responseSha256 || summary.providerResult?.failureCode !== 'INVALID_RESPONSE' ||
      summary.request?.endpoint !== '/api/v1/tgm/token-ohlcv' ||
      summary.request?.expectedCredits !== 1 || summary.request?.pageBound !== 1 || summary.request?.retryBound !== 0) fail('D2V_REPLAY_STATE_INVALID');
  const config = resolveD2uScopedConfiguration(root).environment;
  if (config.NANSEN_COST_PROFILE_VERSION !== NANSEN_COST_PROFILE_VERSION || !config.NANSEN_OBSERVATION_STORE_PATH || !config.NANSEN_OBSERVATION_STORE_ID) {
    fail('D2V_REPLAY_STATE_INVALID');
  }
  const ledger = openCreditLedger({ databasePath: privateFile(join(stateDirectory, 'credits.sqlite')), budgetId: D2U_RUN_ID,
    limitCredits: D2U_CREDIT_LIMIT, costProfileVersion: NANSEN_COST_PROFILE_VERSION });
  try {
    const state = ledger.getSnapshot();
    if (state.limitCredits !== 3 || state.allocatedCredits !== 3 || state.remainingCredits !== 0 || state.reportedChargeCount !== 3 ||
        state.reportedChargedCreditsTotal !== 3 || state.pendingAttemptCount !== 0 || state.reconciliationRequired || ledger.listUnknownChargeAttempts().length !== 0) fail('D2V_REPLAY_STATE_INVALID');
  } finally { ledger.close(); }
  const rawPath = privateFile(join(stateDirectory, 'ohlcv-raw-response-' + capture.attemptId + '.bin'), 1_048_576);
  const raw = readFileSync(rawPath);
  if (raw.length !== capture.byteLength || digest(raw) !== capture.responseSha256) fail('D2V_REPLAY_STATE_INVALID');
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { fail('D2V_REPLAY_STATE_INVALID'); }
  const requestBody = { chain: 'base', token_address: BASE_ASSET_ADDRESSES.USDC, timeframe: '1m', date: summary.request.date };
  const approvedBodyHash = digest(Buffer.from(canonicalJson(requestBody), 'utf8'));
  if (approvedBodyHash !== summary.request.requestBodySha256 || approvedBodyHash !== capture.requestBodySha256) fail('D2V_REPLAY_STATE_INVALID');
  const reference = completion.attempts?.[0];
  if (reference?.httpStatus !== 200 || reference.chargedCredits !== 1 || reference.retry !== 0 || reference.page !== 1) fail('D2V_REPLAY_STATE_INVALID');

  const adapters = buildNansenAdapters({ maxPages: 1, post: async (operation, bodyArg, parse) => {
    if (operation !== 'TOKEN_OHLCV' || digest(Buffer.from(canonicalJson(bodyArg), 'utf8')) !== approvedBodyHash) fail('D2V_REPLAY_STATE_INVALID');
    return { value: parse(body), attemptId: capture.attemptId, status: capture.httpStatus,
      providerRequestId: capture.providerRequestId, chargedCredits: capture.chargedCredits };
  } });
  const parsed = await adapters.tokenOhlcv({ date: summary.request.date }, { maxPages: 1 });
  if (parsed.failure !== null || parsed.completeness !== 'complete' || !parsed.candle || parsed.pageReferences.length !== 1) fail('D2V_REPLAY_NORMALIZATION_FAILED');
  const candle = parsed.candle;
  const value = usdToMicros(candle.close);
  if (value === null || BigInt(value) <= 0n) fail('D2V_REPLAY_NORMALIZATION_FAILED');
  const fetchedAt = capture.capturedAt;
  const acquiredAt = completion.finishedAt;
  if (!Number.isSafeInteger(Date.parse(fetchedAt)) || !Number.isSafeInteger(Date.parse(acquiredAt)) || Date.parse(acquiredAt) < Date.parse(fetchedAt)) fail('D2V_REPLAY_STATE_INVALID');
  const signal = normalizedSignalSchema.parse({ signalId: randomUUID(), provider: 'nansen', endpoint: 'TOKEN_OHLCV',
    chainId: 8453, asset: 'USDC', metric: 'price_usd', observedAt: candle.interval_start, fetchedAt, timeframe: '1m',
    quality: 'COMPLETE', value, unit: 'usd_micros', provenanceId: (BASE_USDC_OHLCV_PRICE_CACHE_KEY.slice(0, 18) + ':' + capture.attemptId).slice(0, 160) });
  const page = parsed.pageReferences[0];
  const pageReference = { ...page, retry: 0 };
  let lock;
  let store;
  let snapshot;
  try {
    lock = acquireD2uSharedStoreLock(config.NANSEN_OBSERVATION_STORE_PATH);
    store = openNansenObservationStore({ databasePath: config.NANSEN_OBSERVATION_STORE_PATH, storeId: config.NANSEN_OBSERVATION_STORE_ID });
    const prior = store.getLatestSnapshotByCacheKey(BASE_USDC_OHLCV_PRICE_CACHE_KEY);
    if (!prior || prior.failure?.code !== 'INVALID_RESPONSE' || prior.pageReferences[0]?.attemptId !== capture.attemptId) fail('D2V_REPLAY_PRIOR_SNAPSHOT_MISMATCH');
    const expiresAt = new Date(Date.parse(acquiredAt) + 60_000).toISOString();
    try { snapshot = store.writeSnapshot({ cacheKey: BASE_USDC_OHLCV_PRICE_CACHE_KEY, operation: 'TOKEN_OHLCV', asset: 'USDC',
      timeframe: '1m', pageBound: 1, retryBound: 0, source: 'nansen', fetchedAt, acquiredAt, expiresAt,
      completeness: 'complete', failure: null, pageReferences: [pageReference], unavailableFields: [], signals: [signal] }, { cache: false });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      const safe = new Set(['INVALID_INPUT', 'DATABASE_FAILURE', 'CAPACITY_EXCEEDED', 'DATABASE_CORRUPT']);
      fail(safe.has(code) ? 'D2V_REPLAY_STORE_WRITE_' + code : 'D2V_REPLAY_STORE_WRITE_FAILED');
    }
    const latest = store.getLatestSnapshotByCacheKey(BASE_USDC_OHLCV_PRICE_CACHE_KEY);
    if (!latest || latest.snapshotId !== snapshot.snapshotId || latest.failure !== null || latest.signals[0]?.provenanceId !== signal.provenanceId) fail('D2V_REPLAY_LATEST_MISMATCH');
  } catch (error) {
    if (error instanceof Error && SAFE_ERRORS.has(error.message)) throw error;
    if (!store) fail('D2V_REPLAY_STORE_LOCKED');
    fail('D2V_REPLAY_PERSIST_FAILED');
  } finally { try { store?.close(); } finally { lock?.release(); } }

  const readiness = readPersistedUsdcReadiness({ databasePath: config.NANSEN_OBSERVATION_STORE_PATH, storeId: config.NANSEN_OBSERVATION_STORE_ID });
  const candidate = readiness.candidates.find((item) => item.source === 'nansen-token-ohlcv');
  if (!candidate || candidate.snapshotId !== snapshot.snapshotId) fail('D2V_REPLAY_PERSIST_FAILED');
  const report = Object.freeze({ schemaVersion: 1, gate: 'D2v', mode: 'OFFLINE_CAPTURE_REPLAY', providerCalls: 0,
    credentialRead: false, additionalLedgerAttempts: 0, sourceRequest: Object.freeze({ attemptId: capture.attemptId,
      providerRequestId: capture.providerRequestId, httpStatus: capture.httpStatus, chargedCredits: capture.chargedCredits,
      requestBodySha256: approvedBodyHash, responseSha256: capture.responseSha256, rawByteLength: raw.length,
      exactRawHashVerified: true }),
    normalization: Object.freeze({ status: 'NORMALIZED', operation: 'TOKEN_OHLCV', chain: 'base', tokenAddress: BASE_ASSET_ADDRESSES.USDC,
      timeframe: '1m', newestCandleSelected: true, intervalStart: candle.interval_start, intervalStartEastern: eastern(candle.interval_start),
      fetchedAt, fetchedAtEastern: eastern(fetchedAt), closeIsPositiveFinite: true, explicitNullNoteAcceptedOnlyWithTruncatedFalse: true }),
    persistence: Object.freeze({ snapshotId: snapshot.snapshotId, cacheKey: BASE_USDC_OHLCV_PRICE_CACHE_KEY,
      operation: 'TOKEN_OHLCV', source: 'nansen', attemptId: capture.attemptId, page: 1, retry: 0, cacheEntryUpdated: false,
      sharedStoreLockReleased: true }),
    readiness: Object.freeze({ status: readiness.status, ready: readiness.ready, selectedSource: readiness.selectedSource,
      ageMs: candidate.ageMs, intervalStart: candidate.intervalStart, fetchedAt: candidate.fetchedAt,
      freshness: candidate.status === 'READY' ? 'fresh' : candidate.status === 'PRICE_STALE' ? 'stale' : 'not_ready' }) });
  writeCreateOnly(replayReportPath, report);
  return report;
}
export function safeD2vReplayFailure(error) {
  const code = error instanceof Error ? error.message : '';
  return SAFE_ERRORS.has(code) ? code : 'D2V_REPLAY_PERSIST_FAILED';
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 0 || !process.env.LOCALAPPDATA) {
    process.stderr.write('D2v offline response replay stopped safely: D2V_REPLAY_USAGE. No credentials, raw body, private paths, or provider calls are used.\n');
    process.exitCode = 1;
  } else {
    replayD2vCapturedResponse({ privateRoot: resolve(process.env.LOCALAPPDATA, 'Ered-Luin') }).then((report) => {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    }).catch((error) => {
      process.stderr.write('D2v offline response replay stopped safely: ' + safeD2vReplayFailure(error) + '. No credentials, raw body, private paths, or provider calls are used.\n');
      process.exitCode = 1;
    });
  }
}

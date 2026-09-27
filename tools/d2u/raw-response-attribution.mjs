import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  BASE_USDC_PRICE_CACHE_KEY, BASE_USDC_PRICE_QUERY, NANSEN_COST_PROFILE_VERSION,
  createNansenClient, createNansenQueryManager, initializeCreditLedger, initializeNansenObservationStore,
  openCreditLedger, openNansenObservationStore,
} from '../../packages/nansen/dist/index.js';
import { acquireD2uSharedStoreLock, resolveD2uScopedConfiguration } from './run-usdc-diagnostic.mjs';
import { D2U_ADAPTER_BODY, D2U_CREDIT_LIMIT, D2U_QUERY, D2U_RUN_ID, runD2uManagedDiagnostic } from './diagnostic.mjs';
import { readD2cExternalConfig } from '../d2c/manual-collect.mjs';
import { collectionProcessIsAlive } from '../d2c/collector-lock.mjs';
import { createStateIdentity, readRunManifest } from '../d2h/bounded-session.mjs';
import { analyzeRawD2uResponse } from './raw-response-analysis.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const MAX_CAPTURE_BYTES = 1_048_576;
const D2L_DIRECTORY_PREFIX = 'd2l-';
const OFF_GATES = [
  'NANSEN_API_ENABLED', 'NANSEN_COLLECTION_REVIEWED', 'NANSEN_COLLECTION_ENABLED',
  'LIVE_EXECUTION_ENABLED', 'D2_BASE_READS_ENABLED', 'D2_DEPLOYMENT_REVIEWED', 'ALCHEMY_BUDGET_VERIFIED',
  'G3C_REVIEWED_MODE', 'D2_EXECUTION_REVIEWED', 'D2_SIGNING_ENABLED', 'D2_BROADCAST_ENABLED',
  'G3C_SIGNER_DEPLOYED', 'BASE_BROADCASTER_DEPLOYED', 'D2_G1D_ANALYSIS_HANDOFF_ENABLED', 'D2_G1D_ANALYSIS_ENABLED',
];

function fail(code) { throw new Error(code); }
function inside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}
function regularExternalFile(path, maxBytes = 1_048_576) {
  if (typeof path !== 'string' || !isAbsolute(path) || inside(ROOT, path)) fail('D2U_EXTERNAL_STATE_UNAVAILABLE');
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) fail('D2U_EXTERNAL_STATE_UNAVAILABLE');
    return resolve(path);
  } catch { fail('D2U_EXTERNAL_STATE_UNAVAILABLE'); }
}
function externalDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || inside(ROOT, path)) fail('D2U_EXTERNAL_STATE_UNAVAILABLE');
  try { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('D2U_EXTERNAL_STATE_UNAVAILABLE'); }
  catch { fail('D2U_EXTERNAL_STATE_UNAVAILABLE'); }
  return resolve(path);
}
function readJson(path, maxBytes = 32_768) {
  try { return JSON.parse(readFileSync(regularExternalFile(path, maxBytes), 'utf8')); }
  catch { fail('D2U_EXTERNAL_STATE_UNAVAILABLE'); }
}
function digestBytes(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function fileDigest(path) { return digestBytes(readFileSync(regularExternalFile(path))); }
function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('D2U_REQUEST_BODY_INVALID'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value !== 'object') fail('D2U_REQUEST_BODY_INVALID');
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}
function requestBodyDigest() { return digestBytes(Buffer.from(canonicalJson(D2U_ADAPTER_BODY), 'utf8')); }
function writeCreateOnlyBytes(path, bytes) {
  let descriptor;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
  } catch {
    if (descriptor !== undefined) { try { closeSync(descriptor); } catch { /* Preserve safe failure. */ } }
    fail('D2U_CAPTURE_WRITE_FAILED');
  }
}
function writeCreateOnlyJson(path, value) {
  writeCreateOnlyBytes(path, Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8'));
}
function safeLedger(snapshot) {
  return Object.freeze({
    limitCredits: snapshot.limitCredits, reservedEstimateCredits: snapshot.reservedEstimateCredits,
    allocatedCredits: snapshot.allocatedCredits, remainingCredits: snapshot.remainingCredits,
    overrunCredits: snapshot.overrunCredits, overBudgetCredits: snapshot.overBudgetCredits,
    reportedChargedCreditsTotal: snapshot.reportedChargedCreditsTotal, reportedChargeCount: snapshot.reportedChargeCount,
    pendingAttemptCount: snapshot.pendingAttemptCount, reconciliationRequired: snapshot.reconciliationRequired,
    haltReason: snapshot.haltReason,
  });
}
function processGatesOff() {
  if (OFF_GATES.some((key) => process.env[key] === 'true') ||
      (process.env.EXECUTION_MODE !== undefined && process.env.EXECUTION_MODE !== 'paper')) fail('D2U_PROCESS_GATE_OVERRIDE');
}
function verifyPriorSevenCreditLedger(environment) {
  const ledger = openCreditLedger({ databasePath: environment.NANSEN_LEDGER_PATH,
    budgetId: environment.NANSEN_LEDGER_BUDGET_ID, limitCredits: 7,
    costProfileVersion: environment.NANSEN_COST_PROFILE_VERSION });
  try {
    const snapshot = ledger.getSnapshot();
    if (snapshot.limitCredits !== 7 || snapshot.allocatedCredits !== 7 || snapshot.remainingCredits !== 0 ||
        snapshot.reportedChargedCreditsTotal !== 7 || snapshot.reportedChargeCount !== 3 ||
        snapshot.pendingAttemptCount !== 0 || snapshot.reconciliationRequired || snapshot.haltReason !== null ||
        ledger.listUnknownChargeAttempts().length !== 0) fail('D2U_PRIOR_LEDGER_NOT_EXHAUSTED');
  } finally { ledger.close(); }
  return true;
}
function assertProcessGatesOff() { processGatesOff(); }
function assertExistingD2uArtifacts(stateDirectory) {
  const completion = readJson(join(stateDirectory, 'completion.json'));
  const previous = readJson(join(stateDirectory, 'diagnostic-summary.json'));
  const run = readJson(join(stateDirectory, 'run.marker.json'));
  const marker = readJson(join(stateDirectory, 'dispatch.marker.json.1'));
  const dispatchFiles = readdirSync(stateDirectory).filter((name) => name.startsWith('dispatch.marker.json.')).sort();
  if (completion.runId !== D2U_RUN_ID || previous.runId !== D2U_RUN_ID || run.runId !== D2U_RUN_ID ||
      completion.status !== 'fresh' || previous.status !== 'fresh' || completion.dispatches !== 1 || previous.dispatches !== 1 ||
      completion.transportAttempts !== 1 || previous.transportAttempts !== 1 || completion.unknownChargeAttempts !== 0 || previous.unknownChargeAttempts !== 0 ||
      completion.attempts?.length !== 1 || previous.attempts?.length !== 1 ||
      completion.attempts[0]?.page !== 1 || completion.attempts[0]?.retry !== 0 || completion.attempts[0]?.received !== true ||
      completion.attempts[0]?.status !== 200 || completion.attempts[0]?.chargedCredits !== 1 ||
      previous.attempts[0]?.status !== 200 || previous.attempts[0]?.chargedCredits !== 1 ||
      completion.ledger?.limitCredits !== 3 || completion.ledger?.allocatedCredits !== 1 || completion.ledger?.remainingCredits !== 2 ||
      completion.ledger?.reportedChargedCreditsTotal !== 1 || completion.ledger?.reportedChargeCount !== 1 ||
      completion.ledger?.pendingAttemptCount !== 0 || completion.ledger?.reconciliationRequired !== false ||
      run.creditLimit !== 3 || run.transportAttemptLimit !== 3 || run.pageBound !== 1 || run.retryBound !== 0 ||
      marker.runId !== D2U_RUN_ID || marker.sequence !== 1 || marker.operation !== 'TOKEN_SCREENER' ||
      marker.pageBound !== 1 || marker.retryBound !== 0 || dispatchFiles.length !== 1 || dispatchFiles[0] !== 'dispatch.marker.json.1') {
    fail('D2U_EXISTING_ARTIFACTS_INVALID');
  }
  for (const name of ['dispatch.marker.json.2', 'raw-attribution.marker.json.2', 'raw-attribution-query-result.json', 'raw-attribution-report.json']) {
    if (existsSync(join(stateDirectory, name))) fail('D2U_ATTRIBUTION_ALREADY_ATTEMPTED');
  }
  if (readdirSync(stateDirectory).some((name) => name.startsWith('raw-response-'))) fail('D2U_ATTRIBUTION_ALREADY_ATTEMPTED');
  return Object.freeze({ priorProviderAttempts: 1, priorReportedCredits: 1 });
}
function currentStoppedCollector(privateRoot) {
  const candidates = [];
  for (const entry of readdirSync(privateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(D2L_DIRECTORY_PREFIX)) continue;
    const directory = join(privateRoot, entry.name);
    try {
      const manifest = readRunManifest(join(directory, 'd2l-run.json'), ROOT);
      if (manifest.profile === 'weth-research-v2' && Date.parse(manifest.deadlineAt) > Date.now()) candidates.push({ directory, manifest });
    } catch { /* Ignore unrelated or invalid historical directories. */ }
  }
  if (candidates.length !== 1) fail('D2U_COLLECTOR_STATE_AMBIGUOUS');
  const { directory, manifest } = candidates[0];
  if (manifest.status !== 'STOPPED' || collectionProcessIsAlive(manifest.pid) ||
      manifest.successTarget !== 850 || manifest.maxAttempts !== 900 || manifest.creditCap !== 2700 ||
      manifest.stats.unknownChargeAttempts !== 0 || manifest.ledger.pendingAttemptCount !== 0 ||
      manifest.ledger.reconciliationRequired) fail('D2U_COLLECTOR_NOT_CLEANLY_STOPPED');
  const config = readD2cExternalConfig(join(directory, 'collection.json'));
  const identity = createStateIdentity({ ledgerPath: config.NANSEN_LEDGER_PATH, budgetId: config.NANSEN_LEDGER_BUDGET_ID,
    costProfileVersion: config.NANSEN_COST_PROFILE_VERSION, observationStorePath: config.NANSEN_OBSERVATION_STORE_PATH,
    observationStoreId: config.NANSEN_OBSERVATION_STORE_ID });
  if (identity !== manifest.stateIdentity) fail('D2U_COLLECTOR_IDENTITY_MISMATCH');
  const ledger = openCreditLedger({ databasePath: config.NANSEN_LEDGER_PATH, budgetId: config.NANSEN_LEDGER_BUDGET_ID,
    limitCredits: Number(config.NANSEN_LEDGER_LIMIT_CREDITS), costProfileVersion: config.NANSEN_COST_PROFILE_VERSION });
  try {
    const snapshot = ledger.getSnapshot();
    if (snapshot.pendingAttemptCount !== 0 || snapshot.reconciliationRequired || ledger.listUnknownChargeAttempts().length !== 0 ||
        JSON.stringify(safeLedger(snapshot)) !== JSON.stringify(manifest.ledger)) fail('D2U_COLLECTOR_ACCOUNTING_MISMATCH');
  } finally { ledger.close(); }
  return Object.freeze({ profile: manifest.profile, state: manifest.status, processAlive: false, deadlineAt: manifest.deadlineAt,
    bounds: Object.freeze({ successTarget: manifest.successTarget, maxAttempts: manifest.maxAttempts, creditCap: manifest.creditCap }),
    stats: manifest.stats, ledger: manifest.ledger });
}
function estFromUtc(value) {
  const timestamp = Date.parse(value);
  if (!Number.isSafeInteger(timestamp)) return null;
  const date = new Date(timestamp - 5 * 60 * 60_000);
  return date.toISOString().replace('T', ' ').replace('Z', ' EST');
}
function captureRawResponse(stateDirectory, expectedRequestDigest, captureState) {
  return (observation) => {
    try {
      if (observation.operation !== 'TOKEN_SCREENER' || observation.status < 200 || observation.status >= 300 ||
          !(observation.body instanceof Uint8Array) || observation.body.byteLength > MAX_CAPTURE_BYTES) {
        captureState.status = 'CAPTURE_FAILED'; captureState.reasonCode = 'CAPTURE_RESPONSE_OUT_OF_BOUNDS'; return;
      }
      const fileName = 'raw-response-' + observation.attemptId + '.bin';
      const metadataName = 'raw-response-' + observation.attemptId + '.capture.json';
      const bytes = new Uint8Array(observation.body);
      const metadata = Object.freeze({
        schemaVersion: 1, runId: D2U_RUN_ID, attemptId: observation.attemptId, operation: observation.operation,
        endpoint: '/api/v1/token-screener', requestBodySha256: observation.requestBodySha256,
        matchesApprovedRequestBody: observation.requestBodySha256 === expectedRequestDigest,
        capturedAt: observation.capturedAt, capturedAtEST: estFromUtc(observation.capturedAt),
        httpStatus: observation.status, providerRequestId: observation.providerRequestId,
        chargedCredits: observation.chargedCredits, contentType: observation.contentType,
        byteLength: bytes.byteLength, responseSha256: observation.sha256, complete: true,
        rawResponseFile: fileName,
      });
      writeCreateOnlyBytes(join(stateDirectory, fileName), bytes);
      writeCreateOnlyJson(join(stateDirectory, metadataName), metadata);
      captureState.status = 'CAPTURED'; captureState.metadata = metadata; captureState.metadataFile = metadataName;
    } catch {
      captureState.status = 'CAPTURE_FAILED'; captureState.reasonCode = 'CAPTURE_WRITE_FAILED';
    }
  };
}
function validateCapture(stateDirectory, metadataFile) {
  if (typeof metadataFile !== 'string' || !/^raw-response-[A-Za-z0-9._:-]+\.capture\.json$/u.test(metadataFile) || basename(metadataFile) !== metadataFile) fail('D2U_CAPTURE_UNAVAILABLE');
  const metadata = readJson(join(stateDirectory, metadataFile), 16_384);
  if (metadata.runId !== D2U_RUN_ID || metadata.operation !== 'TOKEN_SCREENER' || metadata.endpoint !== '/api/v1/token-screener' ||
      typeof metadata.attemptId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(metadata.attemptId) ||
      typeof metadata.rawResponseFile !== 'string' || basename(metadata.rawResponseFile) !== metadata.rawResponseFile ||
      !/^raw-response-[A-Za-z0-9._:-]+\.bin$/u.test(metadata.rawResponseFile) || metadata.rawResponseFile !== 'raw-response-' + metadata.attemptId + '.bin' ||
      metadata.complete !== true || !Number.isSafeInteger(metadata.httpStatus) || metadata.httpStatus < 200 || metadata.httpStatus >= 300 ||
      !(metadata.chargedCredits === null || (Number.isSafeInteger(metadata.chargedCredits) && metadata.chargedCredits >= 0)) ||
      !(metadata.providerRequestId === null || (typeof metadata.providerRequestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(metadata.providerRequestId))) ||
      !(metadata.contentType === null || (typeof metadata.contentType === 'string' && metadata.contentType.length <= 160)) ||
      typeof metadata.matchesApprovedRequestBody !== 'boolean' || !Number.isSafeInteger(Date.parse(metadata.capturedAt)) ||
      !Number.isSafeInteger(metadata.byteLength) || metadata.byteLength < 0 || metadata.byteLength > MAX_CAPTURE_BYTES ||
      !/^[0-9a-f]{64}$/u.test(metadata.responseSha256) || !/^[0-9a-f]{64}$/u.test(metadata.requestBodySha256)) fail('D2U_CAPTURE_INVALID');
  const path = regularExternalFile(join(stateDirectory, metadata.rawResponseFile), MAX_CAPTURE_BYTES);
  const bytes = new Uint8Array(readFileSync(path));
  if (bytes.byteLength !== metadata.byteLength || digestBytes(bytes) !== metadata.responseSha256) fail('D2U_CAPTURE_DIGEST_MISMATCH');
  return Object.freeze({ metadata, bytes });
}
async function replayWithProductionNormalizer(metadata, bytes) {
  let scratch;
  try { scratch = mkdtempSync(join(realpathSync(tmpdir()), 'ered-luin-d2u-raw-replay-')); }
  catch { fail('D2U_REPLAY_STATE_UNAVAILABLE'); }
  let ledger = null; let store = null;
  let transportCalls = 0; let diagnostic = null;
  try {
    const replayId = 'raw-replay-' + randomUUID();
    ledger = initializeCreditLedger({ databasePath: join(scratch, 'ledger.sqlite'), budgetId: replayId, limitCredits: 1, costProfileVersion: NANSEN_COST_PROFILE_VERSION });
    store = initializeNansenObservationStore({ databasePath: join(scratch, 'observations.sqlite'), storeId: replayId });
    const client = createNansenClient({ ledger, enabled: true, apiKey: 'offline-replay-only', maxPages: 1,
      transport: async () => {
        transportCalls += 1;
        return { status: metadata.httpStatus, headers: { ...(metadata.providerRequestId ? { 'x-request-id': metadata.providerRequestId } : {}), 'x-nansen-credits-used': '1', ...(metadata.contentType ? { 'content-type': metadata.contentType } : {}) }, body: new Uint8Array(bytes) };
      } });
    const manager = createNansenQueryManager({ client, store, enabled: true, maxPageBound: 1, maxRetryBound: 0,
      onDiagnostic: (value) => { diagnostic = value; } });
    const result = await manager.query(BASE_USDC_PRICE_QUERY);
    const replayAccounting = ledger.getSnapshot();
    if (transportCalls !== 1 || replayAccounting.allocatedCredits !== 1 || replayAccounting.reportedChargedCreditsTotal !== 1 ||
        replayAccounting.reportedChargeCount !== 1 || replayAccounting.pendingAttemptCount !== 0 || ledger.listUnknownChargeAttempts().length !== 0) {
      fail('D2U_REPLAY_ACCOUNTING_FAILED');
    }
    const parserFailureCode = result.failure?.code ?? null;
    const analysis = analyzeRawD2uResponse({ bytes, complete: metadata.complete, normalizer: {
      parserFailureCode,
      diagnosticRows: diagnostic?.rows ?? [],
      usdcSignals: result.observations,
    } });
    return Object.freeze({ replayProviderCalls: 0, replayTransportInvocations: transportCalls, replaySource: result.source,
      resultStatus: result.status, resultCompleteness: result.completeness, resultFailureCode: parserFailureCode,
      diagnostics: diagnostic ? { rows: diagnostic.rows, pagesRead: diagnostic.pagesRead, finalPage: diagnostic.finalPage,
        warningsFieldPresent: diagnostic.warningsFieldPresent, warningsPresent: diagnostic.warningsPresent } : null,
      accounting: { syntheticAttempts: replayAccounting.reportedChargeCount, syntheticCredits: replayAccounting.reportedChargedCreditsTotal },
      analysis });
  } finally {
    try { store?.close(); } finally { ledger?.close(); }
    const tempRoot = realpathSync(tmpdir());
    const realScratch = realpathSync(scratch);
    if (!inside(tempRoot, realScratch) || realScratch === tempRoot) fail('D2U_REPLAY_CLEANUP_BLOCKED');
    for (const entry of readdirSync(realScratch)) {
      const file = join(realScratch, entry);
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) fail('D2U_REPLAY_CLEANUP_BLOCKED');
      unlinkSync(file);
    }
    rmdirSync(realScratch);
  }
}
function validateCollectorState(privateRoot) {
  return currentStoppedCollector(privateRoot);
}

export function buildD2uRawAttributionPreview() {
  const bodyHash = requestBodyDigest();
  return Object.freeze({ gate: 'D2u', mode: 'DRY_RUN', providerCalls: 0, credentialsRead: false,
    request: { method: 'POST', endpoint: '/api/v1/token-screener', managedQuery: D2U_QUERY, page: 1, perPage: 100,
      retryBound: 0, requestBodySha256: bodyHash },
    existingAllocation: { totalCreditLimit: D2U_CREDIT_LIMIT, priorReportedCredits: 1, maximumAdditionalProviderCalls: 1,
      maximumAdditionalCredits: 1, totalAttemptCeiling: 3, totalCreditCeiling: 3 },
    policy: 'same D2u ledger and canonical cache identity; no cache eviction; no retries; no trading' });
}

export async function continueD2uRawAttribution({ privateRoot, apiKey } = {}) {
  if (typeof privateRoot !== 'string' || typeof apiKey !== 'string' || apiKey.length === 0) fail('D2U_CONFIGURATION_INVALID');
  assertProcessGatesOff();
  const config = resolveD2uScopedConfiguration(privateRoot);
  const environment = config.environment;
  const stateDirectory = externalDirectory(join(privateRoot, D2U_RUN_ID));
  const mainConfigPath = regularExternalFile(config.mainConfigPath);
  regularExternalFile(config.originalValidationConfigPath);
  regularExternalFile(environment.NANSEN_LEDGER_PATH);
  regularExternalFile(environment.NANSEN_OBSERVATION_STORE_PATH);
  const mainConfigSha256 = fileDigest(mainConfigPath);
  verifyPriorSevenCreditLedger(environment);
  const prior = assertExistingD2uArtifacts(stateDirectory);
  const collector = validateCollectorState(privateRoot);
  const expectedBodySha256 = requestBodyDigest();
  const continuationPath = join(stateDirectory, 'raw-attribution.marker.json.2');
  const lock = acquireD2uSharedStoreLock(environment.NANSEN_OBSERVATION_STORE_PATH);
  let ledger = null; let store = null; let result = null;
  const captureState = { status: 'NOT_CAPTURED', metadata: null, metadataFile: null, reasonCode: null };
  try {
    const ledgerOptions = { databasePath: join(stateDirectory, 'credits.sqlite'), budgetId: D2U_RUN_ID,
      limitCredits: D2U_CREDIT_LIMIT, costProfileVersion: NANSEN_COST_PROFILE_VERSION };
    regularExternalFile(ledgerOptions.databasePath);
    ledger = openCreditLedger(ledgerOptions);
    const before = ledger.getSnapshot();
    if (before.limitCredits !== 3 || before.allocatedCredits !== 1 || before.remainingCredits !== 2 ||
        before.reportedChargedCreditsTotal !== 1 || before.reportedChargeCount !== 1 || before.pendingAttemptCount !== 0 ||
        before.reconciliationRequired || ledger.listUnknownChargeAttempts().length !== 0) fail('D2U_CONTINUATION_ACCOUNTING_INVALID');
    store = openNansenObservationStore({ databasePath: environment.NANSEN_OBSERVATION_STORE_PATH,
      storeId: environment.NANSEN_OBSERVATION_STORE_ID });
    const fresh = store.getFreshCache(BASE_USDC_PRICE_CACHE_KEY, new Date());
    if (fresh) fail('D2U_CANONICAL_CACHE_FRESH');
    writeCreateOnlyJson(continuationPath, { schemaVersion: 1, runId: D2U_RUN_ID, sequence: 2, operation: 'TOKEN_SCREENER',
      endpoint: '/api/v1/token-screener', requestBodySha256: expectedBodySha256, priorProviderAttempts: prior.priorProviderAttempts,
      maxAdditionalAttempts: 1, maxAdditionalCredits: 1, createdAt: new Date().toISOString() });
    result = await runD2uManagedDiagnostic({ ledger, store, apiKey,
      runMarkerPath: join(stateDirectory, 'run.marker.json'),
      dispatchMarkerPath: join(stateDirectory, 'dispatch.marker.json'),
      resultPath: join(stateDirectory, 'raw-attribution-query-result.json'),
      continuation: { priorDispatches: 1, maxAdditionalAttempts: 1 },
      onRawResponse: captureRawResponse(stateDirectory, expectedBodySha256, captureState),
    });
  } finally {
    try { store?.close(); } finally { try { ledger?.close(); } finally { lock.release(); } }
  }

  const mainConfigUnchanged = fileDigest(mainConfigPath) === mainConfigSha256;
  const priorLedgerStillPreserved = verifyPriorSevenCreditLedger(config.environment);
  const sharedStoreLockReleased = !existsSync(environment.NANSEN_OBSERVATION_STORE_PATH + '.collector.lock');
  const finalLedger = openCreditLedger({ databasePath: join(stateDirectory, 'credits.sqlite'), budgetId: D2U_RUN_ID,
    limitCredits: 3, costProfileVersion: NANSEN_COST_PROFILE_VERSION });
  let after; let unknownChargeAttempts;
  try { after = finalLedger.getSnapshot(); unknownChargeAttempts = finalLedger.listUnknownChargeAttempts().length; }
  finally { finalLedger.close(); }
  if (!mainConfigUnchanged || !priorLedgerStillPreserved || !sharedStoreLockReleased) fail('D2U_ATTRIBUTION_POSTFLIGHT_FAILED');

  let replay = null;
  if (captureState.status === 'CAPTURED' && captureState.metadataFile !== null) {
    const captured = validateCapture(stateDirectory, captureState.metadataFile);
    replay = await replayWithProductionNormalizer(captured.metadata, captured.bytes);
  }
  if (captureState.metadata && captureState.metadata.matchesApprovedRequestBody !== true && replay?.analysis) {
    replay = Object.freeze({ ...replay, analysis: Object.freeze({ ...replay.analysis, classification: 'indeterminate', reasonCode: 'REQUEST_BODY_DOES_NOT_MATCH_APPROVED_SEMANTICS' }) });
  }
  const report = Object.freeze({
    schemaVersion: 1, gate: 'D2u', runId: D2U_RUN_ID, completedAt: new Date().toISOString(),
    completedAtEST: estFromUtc(new Date().toISOString()),
    request: { method: 'POST', endpoint: '/api/v1/token-screener', requestBodySha256: expectedBodySha256,
      matchesPriorSuccessfulRequestSemantics: captureState.metadata?.matchesApprovedRequestBody === true, chain: 'base', timeframe: '1h', page: 1, perPage: 100,
      tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', includeStablecoins: true, traderType: 'all', retryBound: 0 },
    providerAttempt: { dispatches: result?.dispatches ?? 0, attempts: result?.attempts ?? [], captureStatus: captureState.status,
      captureFailureCode: captureState.reasonCode, captureMetadataFile: captureState.metadataFile,
      capture: captureState.metadata ? { attemptId: captureState.metadata.attemptId, capturedAt: captureState.metadata.capturedAt,
        capturedAtEST: captureState.metadata.capturedAtEST, httpStatus: captureState.metadata.httpStatus,
        providerRequestId: captureState.metadata.providerRequestId, chargedCredits: captureState.metadata.chargedCredits,
        contentType: captureState.metadata.contentType, byteLength: captureState.metadata.byteLength,
        responseSha256: captureState.metadata.responseSha256, requestBodySha256: captureState.metadata.requestBodySha256,
        matchesApprovedRequestBody: captureState.metadata.matchesApprovedRequestBody, rawResponseFile: captureState.metadata.rawResponseFile } : null },
    replay: replay ? { replayProviderCalls: replay.replayProviderCalls, replayTransportInvocations: replay.replayTransportInvocations,
      replaySource: replay.replaySource, resultStatus: replay.resultStatus, resultCompleteness: replay.resultCompleteness,
      resultFailureCode: replay.resultFailureCode, diagnostics: replay.diagnostics, syntheticAccounting: replay.accounting,
      evidence: replay.analysis } : null,
    accounting: { priorProviderAttempts: 1, priorReportedCredits: 1,
      totalProviderAttempts: prior.priorProviderAttempts + (result?.transportAttempts ?? result?.dispatches ?? 0),
      addedProviderAttempts: result?.transportAttempts ?? result?.dispatches ?? 0,
      ledger: safeLedger(after), unknownChargeAttempts },
    boundaries: { totalCreditCeiling: 3, totalAttemptCeiling: 3, maximumAdditionalProviderCalls: 1,
      maximumAdditionalCredits: 1, mainConfigChanged: !mainConfigUnchanged, originalSevenCreditLedgerPreserved: priorLedgerStillPreserved,
      collectorAtDispatch: collector, sharedStoreLockReleased, noCacheEviction: true, retries: 0,
      liveExecutionEnabled: false, walletOrTradingAccess: false },
  });
  writeCreateOnlyJson(join(stateDirectory, 'raw-attribution-report.json'), report);
  return report;
}

export async function replayExistingD2uCapture({ privateRoot } = {}) {
  if (typeof privateRoot !== 'string') fail('D2U_CONFIGURATION_INVALID');
  const stateDirectory = externalDirectory(join(privateRoot, D2U_RUN_ID));
  const candidates = readdirSync(stateDirectory).filter((name) => /^raw-response-[A-Za-z0-9._:-]+\.capture\.json$/u.test(name));
  if (candidates.length !== 1) fail('D2U_CAPTURE_UNAVAILABLE');
  const captured = validateCapture(stateDirectory, candidates[0]);
  const replay = await replayWithProductionNormalizer(captured.metadata, captured.bytes);
  return Object.freeze({ mode: 'OFFLINE_REPLAY', providerCalls: 0, credentialsRead: false,
    capture: { attemptId: captured.metadata.attemptId, httpStatus: captured.metadata.httpStatus,
      providerRequestId: captured.metadata.providerRequestId, chargedCredits: captured.metadata.chargedCredits,
      byteLength: captured.metadata.byteLength, responseSha256: captured.metadata.responseSha256,
      requestBodySha256: captured.metadata.requestBodySha256 },
    evidence: replay.analysis, normalizer: { resultStatus: replay.resultStatus, resultCompleteness: replay.resultCompleteness,
      resultFailureCode: replay.resultFailureCode, diagnostics: replay.diagnostics },
    syntheticAccounting: replay.accounting });
}

export function publicD2uRawAttributionFailure(error) {
  const code = error instanceof Error ? error.message : '';
  const allowed = new Set(['USAGE', 'D2U_CONFIGURATION_INVALID', 'D2U_EXTERNAL_STATE_UNAVAILABLE', 'D2U_PROCESS_GATE_OVERRIDE',
    'D2U_CONFIG_INVALID', 'D2U_PRIOR_LEDGER_NOT_EXHAUSTED', 'D2U_EXISTING_ARTIFACTS_INVALID', 'D2U_ATTRIBUTION_ALREADY_ATTEMPTED',
    'D2U_COLLECTOR_STATE_AMBIGUOUS', 'D2U_COLLECTOR_NOT_CLEANLY_STOPPED', 'D2U_COLLECTOR_IDENTITY_MISMATCH',
    'D2U_COLLECTOR_ACCOUNTING_MISMATCH', 'D2U_STORE_LOCKED', 'D2U_CONTINUATION_ACCOUNTING_INVALID', 'D2U_CANONICAL_CACHE_FRESH',
    'D2U_CAPTURE_WRITE_FAILED', 'D2U_CAPTURE_UNAVAILABLE', 'D2U_CAPTURE_INVALID', 'D2U_CAPTURE_DIGEST_MISMATCH',
    'D2U_REPLAY_STATE_UNAVAILABLE', 'D2U_REPLAY_ACCOUNTING_FAILED', 'D2U_REPLAY_CLEANUP_BLOCKED', 'D2U_ATTRIBUTION_POSTFLIGHT_FAILED', 'D2U_CONTINUATION_ACCOUNTING_INVALID',
    'D2U_REQUEST_BODY_INVALID', 'D2U_COLLECTOR_STATE_AMBIGUOUS', 'D2U_CONTINUATION_INVALID']);
  return allowed.has(code) ? code : 'D2U_ATTRIBUTION_FAILED_SAFE';
}

async function main() {
  const mode = process.argv[2] ?? '--dry-run';
  if (mode === '--dry-run') {
    process.stdout.write(JSON.stringify(buildD2uRawAttributionPreview(), null, 2) + '\n');
    return;
  }
  if (!process.env.LOCALAPPDATA) fail('D2U_CONFIGURATION_INVALID');
  const privateRoot = resolve(process.env.LOCALAPPDATA, 'Ered-Luin');
  if (mode === '--replay') {
    process.stdout.write(JSON.stringify(await replayExistingD2uCapture({ privateRoot }), null, 2) + '\n');
    return;
  }
  if (mode === '--dispatch') {
    const report = await continueD2uRawAttribution({ privateRoot, apiKey: process.env.NANSEN_API_KEY });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    delete process.env.NANSEN_API_KEY;
    return;
  }
  fail('USAGE');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write('D2u raw attribution stopped safely: ' + publicD2uRawAttributionFailure(error) +
      '. No secrets, private paths, raw response bytes, or arbitrary error text are printed.\n');
    process.exitCode = 1;
  });
}
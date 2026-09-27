import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import {
  BASE_USDC_PRICE_QUERY,
  NANSEN_COST_PROFILE_VERSION,
  NANSEN_OPERATION_COSTS,
  createNansenClient,
  createNansenQueryManager,
} from '../../packages/nansen/dist/index.js';

export const D2U_RUN_ID = 'nansen-usdc-price-diagnostic-20260927-01';
export const D2U_CREDIT_LIMIT = 3;
export const D2U_ATTEMPT_CAP = 3;
export const D2U_QUERY = BASE_USDC_PRICE_QUERY;
export const D2U_ADAPTER_BODY = Object.freeze({
  chains: Object.freeze(['base']),
  timeframe: '1h',
  pagination: Object.freeze({ page: 1, per_page: 100 }),
  filters: Object.freeze({
    token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    include_stablecoins: true,
    trader_type: 'all',
  }),
});

export function buildD2uDryRunPlan() {
  return Object.freeze({
    gate: 'D2u',
    mode: 'DRY_RUN',
    providerCalls: 0,
    transportAttempts: 0,
    credentialRead: false,
    activeBudgetCredits: 0,
    authorizedTotalCeilingCredits: D2U_CREDIT_LIMIT,
    maximumTransportAttempts: D2U_ATTEMPT_CAP,
    request: Object.freeze({
      method: 'POST',
      endpoint: '/api/v1/token-screener',
      managedQuery: D2U_QUERY,
      body: D2U_ADAPTER_BODY,
      maxPages: 1,
      maxRetries: 0,
      expectedCredits: NANSEN_OPERATION_COSTS.TOKEN_SCREENER,
      costProfileVersion: NANSEN_COST_PROFILE_VERSION,
    }),
    cachePolicy: 'canonical manager identity; matching fresh evidence reused',
    stopAfter: 'one request result or cache hit; no alternative query is dispatched',
  });
}

function writeCreateOnly(path, value) {
  let descriptor;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
  } catch {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Preserve the safe failure. */ }
    }
    throw new Error('D2U_EXTERNAL_STATE_UNAVAILABLE');
  }
}

function safeLedger(snapshot) {
  return Object.freeze({
    limitCredits: snapshot.limitCredits,
    reservedEstimateCredits: snapshot.reservedEstimateCredits,
    allocatedCredits: snapshot.allocatedCredits,
    remainingCredits: snapshot.remainingCredits,
    overrunCredits: snapshot.overrunCredits,
    overBudgetCredits: snapshot.overBudgetCredits,
    reportedChargedCreditsTotal: snapshot.reportedChargedCreditsTotal,
    reportedChargeCount: snapshot.reportedChargeCount,
    pendingAttemptCount: snapshot.pendingAttemptCount,
    reconciliationRequired: snapshot.reconciliationRequired,
    haltReason: snapshot.haltReason,
  });
}

function priceEvidence(snapshot, expectedCacheKey, now) {
  if (!snapshot || !expectedCacheKey || snapshot.cacheKey !== expectedCacheKey || (snapshot.source !== 'nansen' && snapshot.source !== 'synthetic') ||
      snapshot.operation !== 'TOKEN_SCREENER' || snapshot.asset !== 'USDC') {
    return Object.freeze({ rowPresence: 'absent', priceState: 'missing', usable: false });
  }
  const liveSource = snapshot.source === 'nansen';
  const matches = snapshot.signals.filter((signal) =>
    signal.endpoint === 'TOKEN_SCREENER' && signal.asset === 'USDC' && signal.metric === 'price_usd' &&
    signal.unit === 'usd_micros');
  if (matches.length > 1) return Object.freeze({ rowPresence: 'ambiguous', priceState: 'ambiguous', usable: false });
  if (matches.length === 0) return Object.freeze({ rowPresence: 'absent', priceState: 'missing', usable: false });
  const signal = matches[0];
  const fetchedMs = Date.parse(snapshot.fetchedAt);
  const acquiredMs = Date.parse(snapshot.acquiredAt);
  const expiresMs = Date.parse(snapshot.expiresAt);
  const fresh = Number.isSafeInteger(fetchedMs) && Number.isSafeInteger(acquiredMs) &&
    fetchedMs <= now.getTime() && acquiredMs <= now.getTime() && expiresMs > now.getTime() &&
    now.getTime() - fetchedMs <= 10 * 60_000 && snapshot.completeness === 'complete' && snapshot.failure === null;
  let micros = null;
  try {
    if (typeof signal.value === 'string' && /^[0-9]+$/u.test(signal.value)) micros = BigInt(signal.value);
  } catch { micros = null; }
  const rowPresent = signal.quality !== 'MISSING';
  const positive = rowPresent && micros !== null && micros > 0n && signal.quality === 'COMPLETE';
  const priceUsd = positive
    ? (micros / 1_000_000n).toString() + '.' + (micros % 1_000_000n).toString().padStart(6, '0')
    : null;
  return Object.freeze({
    rowPresence: rowPresent ? 'present' : 'absent',
    priceState: !rowPresent ? 'missing' : !positive ? 'nonpositive_or_invalid' : !fresh ? 'stale_or_incomplete' : liveSource ? 'usable' : 'synthetic_only',
    usable: positive && fresh && liveSource,
    priceUsd,
    priceUsdMicros: positive ? micros.toString() : null,
    observedAt: signal.observedAt,
    fetchedAt: snapshot.fetchedAt,
    acquiredAt: snapshot.acquiredAt,
    expiresAt: snapshot.expiresAt,
    freshness: fresh ? 'fresh' : 'stale_or_incomplete',
  });
}

export function summarizeD2uResult({ result, snapshot, ledgerSnapshot, unknownChargeAttempts, dispatches, cacheHit, failureClass, now }) {
  const refs = Array.isArray(result?.attemptPageReferences) ? result.attemptPageReferences : [];
  const evidence = priceEvidence(snapshot, result?.cacheKey, now);
  return Object.freeze({
    gate: 'D2u',
    runId: D2U_RUN_ID,
    operation: 'TOKEN_SCREENER',
    asset: 'USDC',
    chain: 'base',
    tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    status: result?.status ?? 'failed',
    completeness: result?.completeness ?? 'unknown',
    source: snapshot?.source === 'nansen' || snapshot?.source === 'synthetic' ? snapshot.source : 'none',
    cacheOutcome: cacheHit ? 'HIT' : dispatches > 0 ? 'MISS_DISPATCHED' : 'MISS_NO_DISPATCH',
    cacheHit,
    dispatches,
    transportAttempts: refs.length,
    attemptAccountingSource: 'MANAGED_CLIENT_PAGE_REFERENCES',
    attempts: refs.map((ref) => ({
      page: Number.isSafeInteger(ref.page) ? ref.page : null,
      retry: Number.isSafeInteger(ref.retry) ? ref.retry : null,
      received: ref.received === true,
      status: Number.isSafeInteger(ref.status) ? ref.status : null,
      chargedCredits: Number.isSafeInteger(ref.chargedCredits) ? ref.chargedCredits : null,
    })),
    failureClass,
    usdc: evidence,
    ledger: safeLedger(ledgerSnapshot),
    unknownChargeAttempts,
    stopAfterThisResult: true,
  });
}

export async function runD2uManagedDiagnostic({
  ledger,
  store,
  apiKey,
  runMarkerPath,
  dispatchMarkerPath,
  resultPath,
  transport,
  onRawResponse,
  continuation = null,
  createClient = createNansenClient,
  createManager = createNansenQueryManager,
  now = () => new Date(),
}) {
  if (!ledger || !store || typeof apiKey !== 'string' || apiKey.length === 0 ||
      typeof runMarkerPath !== 'string' || typeof dispatchMarkerPath !== 'string' || typeof resultPath !== 'string' ||
      typeof now !== 'function') throw new Error('D2U_CONFIGURATION_INVALID');
  const startedAt = now();
  if (!(startedAt instanceof Date) || !Number.isSafeInteger(startedAt.getTime())) throw new Error('D2U_CLOCK_UNAVAILABLE');
  if (continuation === null) {
    writeCreateOnly(runMarkerPath, {
      schemaVersion: 1,
      runId: D2U_RUN_ID,
      startedAt: startedAt.toISOString(),
      operation: D2U_QUERY.operation,
      asset: D2U_QUERY.asset,
      pageBound: 1,
      retryBound: 0,
      creditLimit: D2U_CREDIT_LIMIT,
      transportAttemptLimit: D2U_ATTEMPT_CAP,
    });
  } else if (typeof continuation !== 'object' || !Number.isSafeInteger(continuation.priorDispatches) ||
      continuation.priorDispatches < 1 || !Number.isSafeInteger(continuation.maxAdditionalAttempts) ||
      continuation.maxAdditionalAttempts !== 1 || continuation.priorDispatches + continuation.maxAdditionalAttempts > D2U_ATTEMPT_CAP) {
    throw new Error('D2U_CONTINUATION_INVALID');
  }

  const before = ledger.getSnapshot();
  const unknownBefore = ledger.listUnknownChargeAttempts().length;
  if (continuation === null) {
    if (before.limitCredits !== D2U_CREDIT_LIMIT || before.allocatedCredits !== 0 ||
        before.remainingCredits !== D2U_CREDIT_LIMIT || before.reservedEstimateCredits !== 0 ||
        before.overrunCredits !== 0 || before.overBudgetCredits !== 0 ||
        (before.reportedChargedCreditsTotal !== null && before.reportedChargedCreditsTotal !== 0) ||
        before.reportedChargeCount !== 0 || before.pendingAttemptCount !== 0 ||
        before.reconciliationRequired || before.haltReason !== null || unknownBefore !== 0) throw new Error('D2U_LEDGER_NOT_FRESH');
  } else if (before.limitCredits !== D2U_CREDIT_LIMIT || before.allocatedCredits !== continuation.priorDispatches ||
      before.remainingCredits !== D2U_CREDIT_LIMIT - continuation.priorDispatches ||
      before.reportedChargedCreditsTotal !== continuation.priorDispatches || before.reportedChargeCount !== continuation.priorDispatches ||
      before.pendingAttemptCount !== 0 || before.reconciliationRequired || before.haltReason !== null || unknownBefore !== 0) {
    throw new Error('D2U_CONTINUATION_ACCOUNTING_INVALID');
  }

  let dispatches = 0;
  const clientOptions = {
    ledger,
    enabled: true,
    apiKey,
    maxPages: 1,
    timeoutMs: 8_000,
    maxResponseBytes: 1_048_576,
    ...(transport === undefined ? {} : { transport }),
    ...(onRawResponse === undefined ? {} : { onRawResponse }),
  };
  const client = createClient(clientOptions);
  const manager = createManager({
    client,
    store,
    enabled: true,
    maxPageBound: 1,
    maxRetryBound: 0,
    beforeDispatch() {
      const maximumNewAttempts = continuation?.maxAdditionalAttempts ?? D2U_ATTEMPT_CAP;
      if (dispatches >= maximumNewAttempts) return 'D2U_ATTEMPT_CAP_REACHED';
      const nextDispatch = dispatches + 1;
      const sequence = (continuation?.priorDispatches ?? 0) + nextDispatch;
      writeCreateOnly(dispatchMarkerPath + '.' + String(sequence), {
        schemaVersion: 1,
        runId: D2U_RUN_ID,
        startedAt: now().toISOString(),
        operation: D2U_QUERY.operation,
        pageBound: 1,
        retryBound: 0,
        sequence,
        ...(continuation === null ? {} : { continuation: true }),
      });
      dispatches = nextDispatch;
      return null;
    },
  });

  let result = null;
  let failureClass = null;
  try { result = await manager.query(D2U_QUERY); }
  catch { failureClass = 'MANAGED_QUERY_FAILURE'; }

  const finishedAt = now();
  const snapshot = result?.cacheKey ? store.getLatestSnapshotByCacheKey(result.cacheKey) : null;
  const ledgerSnapshot = ledger.getSnapshot();
  const unknownChargeAttempts = ledger.listUnknownChargeAttempts().length;
  if (ledgerSnapshot.pendingAttemptCount > 0 || ledgerSnapshot.reconciliationRequired ||
      unknownChargeAttempts > 0) failureClass = 'ACCOUNTING_RECONCILIATION_REQUIRED';
  else if (result?.failure || result?.storeError || result?.managerError) failureClass ??= 'QUERY_OR_PERSISTENCE_FAILURE';

  const summary = summarizeD2uResult({
    result,
    snapshot,
    ledgerSnapshot,
    unknownChargeAttempts,
    dispatches,
    cacheHit: result?.cacheHit === true,
    failureClass,
    now: finishedAt,
  });
  writeCreateOnly(resultPath, summary);
  return summary;
}

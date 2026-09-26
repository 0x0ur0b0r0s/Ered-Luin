import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import {
  createNansenClient,
  createNansenQueryManager,
  NANSEN_COST_PROFILE_VERSION,
  NANSEN_OPERATION_COSTS,
  openCreditLedger,
  openNansenObservationStore,
} from '../../packages/nansen/dist/index.js';

export const D2K_RUN_ID = 'nansen-token-screener-d2k-20260925-01';
export const D2K_CREDIT_LIMIT = 3;
export const D2K_TOKEN_QUERY = Object.freeze({
  operation: 'TOKEN_SCREENER',
  asset: 'BASE_PAIR',
  timeframe: '1h',
  pageBound: 1,
  retryBound: 0,
  perPage: 100,
});
export const D2K_ADAPTER_BODY = Object.freeze({
  chains: Object.freeze(['base']),
  timeframe: '1h',
  pagination: Object.freeze({ page: 1, per_page: 100 }),
  filters: Object.freeze({
    token_address: Object.freeze([
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      '0x4200000000000000000000000000000000000006',
    ]),
    include_stablecoins: true,
    include_native_tokens: true,
  }),
});

const FIELD_NAMES = new Set(['market_cap_usd', 'price_usd']);
const FIELD_STATES = new Set(['absent', 'null', 'numeric', 'invalid', 'ambiguous']);
const ROW_PRESENCE = new Set(['present', 'absent', 'duplicate']);
const QUALITY = new Set(['COMPLETE', 'PARTIAL', 'MISSING']);

export function buildD2kDryRunPlan() {
  return Object.freeze({
    mode: 'DRY_RUN',
    providerCalls: 0,
    credentialRead: false,
    activeBudgetCredits: 0,
    authorizedTotalCeilingCredits: D2K_CREDIT_LIMIT,
    request: Object.freeze({
      method: 'POST',
      endpoint: '/api/v1/token-screener',
      managedQuery: D2K_TOKEN_QUERY,
      body: D2K_ADAPTER_BODY,
      maxPages: 1,
      maxRetries: 0,
      expectedCredits: NANSEN_OPERATION_COSTS.TOKEN_SCREENER,
      costProfileVersion: NANSEN_COST_PROFILE_VERSION,
    }),
    stopAfter: 'one result, cache hit, incomplete evidence, failure, unknown charge, or accounting halt',
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
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Preserve the original failure. */ }
    }
    throw error;
  }
}

function safeDiagnostic(diagnostic) {
  if (!diagnostic || diagnostic.operation !== 'TOKEN_SCREENER') return null;
  const rows = Array.isArray(diagnostic.rows) ? diagnostic.rows.flatMap((row) => {
    if (!row || (row.asset !== 'USDC' && row.asset !== 'WETH') || !ROW_PRESENCE.has(row.presence)) return [];
    const fields = Array.isArray(row.fields) ? row.fields.flatMap((field) => {
      if (!field || !FIELD_NAMES.has(field.name) || !FIELD_STATES.has(field.state)) return [];
      return [{ name: field.name, state: field.state }];
    }) : [];
    return [{ asset: row.asset, presence: row.presence, fields }];
  }) : [];
  const attempts = Array.isArray(diagnostic.attemptReferences) ? diagnostic.attemptReferences.map((attempt) => ({
    page: Number.isSafeInteger(attempt.page) ? attempt.page : null,
    retry: Number.isSafeInteger(attempt.retry) ? attempt.retry : null,
    received: attempt.received === true,
    status: Number.isSafeInteger(attempt.status) ? attempt.status : null,
    chargedCredits: Number.isSafeInteger(attempt.chargedCredits) ? attempt.chargedCredits : null,
  })) : [];
  return Object.freeze({
    operation: 'TOKEN_SCREENER',
    rows,
    pagesRead: Number.isSafeInteger(diagnostic.pagesRead) ? diagnostic.pagesRead : 0,
    finalPage: typeof diagnostic.finalPage === 'boolean' ? diagnostic.finalPage : null,
    warningsFieldPresent: diagnostic.warningsFieldPresent === true,
    warningsPresent: diagnostic.warningsPresent === true,
    attempts,
  });
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

function signalStatus(result, asset) {
  const signal = result.observations.find((item) => item.asset === asset && item.metric === 'price_usd');
  const quality = signal && QUALITY.has(signal.quality) ? signal.quality : 'MISSING';
  let positive = false;
  if (signal && typeof signal.value === 'string' && /^-?[0-9]+$/u.test(signal.value)) {
    try { positive = BigInt(signal.value) > 0n; } catch { positive = false; }
  }
  return Object.freeze({
    quality,
    complete: quality === 'COMPLETE' && typeof signal?.value === 'string' && signal.value.length > 0,
    positive: positive,
    usableAsPositivePrice: quality === 'COMPLETE' && positive,
  });
}

export function summarizeD2kResult(result, diagnostics, transportAttempts, ledgerSnapshot, dispatchMarkerCreated, transportMeasurement) {
  const safeSignal = result.observations && Array.isArray(result.observations)
    ? Object.freeze({
        usdcPrice: signalStatus(result, 'USDC'),
        wethPrice: signalStatus(result, 'WETH'),
      })
    : Object.freeze({ usdcPrice: signalStatus({ observations: [] }, 'USDC'), wethPrice: signalStatus({ observations: [] }, 'WETH') });
  const refs = Array.isArray(result.attemptPageReferences) ? result.attemptPageReferences : [];
  const receivedPages = refs.filter((ref) => ref.received === true).length;
  const safeFailure = result.failure ? 'PROVIDER_FAILURE'
    : result.storeError || result.managerError ? 'LOCAL_PERSISTENCE_OR_MANAGER_FAILURE' : null;
  const diag = diagnostics.length === 0 ? null : diagnostics[0];
  return Object.freeze({
    gate: 'D2k',
    runId: D2K_RUN_ID,
    operation: D2K_TOKEN_QUERY.operation,
    status: result.status,
    source: result.source,
    completeness: result.completeness,
    cacheOutcome: result.cacheHit ? 'HIT' : dispatchMarkerCreated ? 'MISS_DISPATCH_MARKED' : 'MISS_NO_DISPATCH',
    cacheHit: result.cacheHit === true,
    managedAttempts: refs.length,
    attemptAccountingSource: 'MANAGED_CLIENT_PAGE_REFERENCES',
    dispatchMarkerCreated,
    transportAttempts,
    transportMeasurement,
    receivedPages,
    qualifyingSuccessfulRequests: Number.isSafeInteger(result.qualifyingSuccessfulRequests) ? result.qualifyingSuccessfulRequests : 0,
    failureClass: safeFailure,
    httpStatuses: refs.map((ref) => Number.isSafeInteger(ref.status) ? ref.status : null),
    diagnosticsProduced: diag !== null,
    diagnostics: diag,
    normalizedSignals: safeSignal,
    usdcPriceFieldState: diag?.rows.find((row) => row.asset === 'USDC')?.fields.find((field) => field.name === 'price_usd')?.state
      ?? (result.cacheHit ? 'NOT_CAPTURED_CACHE_HIT' : 'NOT_AVAILABLE'),
    usdcRowPresence: diag?.rows.find((row) => row.asset === 'USDC')?.presence
      ?? (result.cacheHit ? 'NOT_CAPTURED_CACHE_HIT' : 'NOT_AVAILABLE'),
    ledger: safeLedger(ledgerSnapshot),
    stopAfterThisResult: true,
  });
}

export async function runD2kManagedDiagnostic({
  ledger,
  store,
  apiKey,
  runMarkerPath,
  dispatchMarkerPath,
  resultPath,
  transport,
  createClient = createNansenClient,
  createManager = createNansenQueryManager,
  now = () => new Date(),
}) {
  if (!ledger || !store || typeof apiKey !== 'string' || apiKey.length === 0 ||
      typeof runMarkerPath !== 'string' || typeof dispatchMarkerPath !== 'string' || typeof resultPath !== 'string') {
    throw new Error('D2K_CONFIGURATION_INVALID');
  }
  const startedAt = now().toISOString();
  writeCreateOnly(runMarkerPath, {
    schemaVersion: 1,
    runId: D2K_RUN_ID,
    startedAt,
    operation: D2K_TOKEN_QUERY.operation,
    pageBound: 1,
    retryBound: 0,
  });

  const diagnostics = [];
  let dispatches = 0;
  let dispatchMarkerCreated = false;
  let transportAttempts = 0;
  const wrappedTransport = transport === undefined ? undefined : async (request) => {
    transportAttempts += 1;
    if (transportAttempts > 1) throw new Error('D2K_ATTEMPT_CAP_REACHED');
    return transport(request);
  };
  const clientOptions = {
    ledger,
    enabled: true,
    apiKey,
    maxPages: 1,
    timeoutMs: 8_000,
    maxResponseBytes: 1_048_576,
    ...(wrappedTransport ? { transport: wrappedTransport } : {}),
  };
  const client = createClient(clientOptions);
  const manager = createManager({
    client,
    store,
    enabled: true,
    maxPageBound: 1,
    maxRetryBound: 0,
    beforeDispatch() {
      if (dispatches !== 0) return 'D2K_ATTEMPT_CAP_REACHED';
      writeCreateOnly(dispatchMarkerPath, {
        schemaVersion: 1,
        runId: D2K_RUN_ID,
        startedAt: now().toISOString(),
        operation: D2K_TOKEN_QUERY.operation,
        pageBound: 1,
        retryBound: 0,
      });
      dispatches += 1;
      dispatchMarkerCreated = true;
      return null;
    },
    onDiagnostic(diagnostic) {
      const safe = safeDiagnostic(diagnostic);
      if (safe) diagnostics.push(safe);
    },
  });
  const result = await manager.query(D2K_TOKEN_QUERY);
  const snapshot = ledger.getSnapshot();
  const measuredTransportAttempts = transport === undefined ? (dispatchMarkerCreated ? null : 0) : transportAttempts;
  const transportMeasurement = transport === undefined
    ? (dispatchMarkerCreated ? 'DEFAULT_TRANSPORT_COUNT_UNMEASURED' : 'NO_DISPATCH_TO_DEFAULT_TRANSPORT')
    : 'INJECTED_TRANSPORT_BOUNDARY_COUNTED';
  const summary = summarizeD2kResult(result, diagnostics, measuredTransportAttempts, snapshot, dispatchMarkerCreated, transportMeasurement);
  writeCreateOnly(resultPath, summary);
  return summary;
}

export async function runD2kWithExternalState({
  ledgerOptions,
  storeOptions,
  apiKey,
  runMarkerPath,
  dispatchMarkerPath,
  resultPath,
  transport,
  openLedger = openCreditLedger,
  openStore = openNansenObservationStore,
  createClient = createNansenClient,
  createManager = createNansenQueryManager,
}) {
  let ledger = null;
  let store = null;
  try {
    ledger = openLedger(ledgerOptions);
    const starting = ledger.getSnapshot();
    if (starting.limitCredits !== D2K_CREDIT_LIMIT || starting.allocatedCredits !== 0 ||
        starting.remainingCredits !== D2K_CREDIT_LIMIT || starting.reservedEstimateCredits !== 0 ||
        starting.overrunCredits !== 0 || starting.overBudgetCredits !== 0 ||
        (starting.reportedChargedCreditsTotal !== null && starting.reportedChargedCreditsTotal !== 0) || starting.reportedChargeCount !== 0 ||
        starting.pendingAttemptCount !== 0 || starting.reconciliationRequired ||
        starting.haltReason !== null || ledger.listUnknownChargeAttempts().length !== 0) {
      throw new Error('D2K_LEDGER_NOT_FRESH');
    }
    store = openStore(storeOptions);
    return await runD2kManagedDiagnostic({
      ledger, store, apiKey, runMarkerPath, dispatchMarkerPath, resultPath, transport,
      createClient, createManager,
    });
  } finally {
    try { store?.close(); } finally { ledger?.close(); }
  }
}
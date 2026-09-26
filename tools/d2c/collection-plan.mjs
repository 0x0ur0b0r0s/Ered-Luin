export const D2C_COLLECTION_QUERIES = Object.freeze([
  Object.freeze({ operation: 'TOKEN_SCREENER', asset: 'BASE_PAIR', timeframe: '1h', pageBound: 1, retryBound: 0, perPage: 100, estimatedCredits: 1 }),
  Object.freeze({ operation: 'FLOW_INTELLIGENCE', asset: 'WETH', timeframe: '1h', pageBound: 1, retryBound: 0, perPage: 1, estimatedCredits: 1 }),
  Object.freeze({ operation: 'SMART_MONEY_NETFLOW', asset: 'BASE_PAIR', timeframe: '1h', pageBound: 1, retryBound: 0, perPage: 100, estimatedCredits: 5 }),
]);

export function canonicalManagedQuery(query) {
  const { operation, asset, timeframe, pageBound, retryBound, perPage } = query;
  return Object.freeze({ operation, asset, timeframe, pageBound, retryBound, perPage });
}

export function createD2cCollectionPlan(outputStoreId = null) {
  if (outputStoreId !== null && (typeof outputStoreId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(outputStoreId))) {
    throw new TypeError('Collection output store identity is invalid.');
  }
  return Object.freeze({
    planId: 'd2c-base-evidence-refresh-v1',
    usefulPurpose: 'Refresh Base USDC/WETH evidence needed for a reviewed D2 proposal and G2 evaluation.',
    consumer: 'Ered Luin persisted observation store; later D2 proposal/G2 policy evaluation.',
    queries: D2C_COLLECTION_QUERIES,
    pagination: 'At most one page per endpoint; incomplete provider pagination stays incomplete.',
    retries: 'Zero automatic or manual retries in this plan; failed attempts remain in the ledger.',
    maximumAttempts: 3,
    maximumEstimatedCredits: 7,
    cache: 'Use the canonical G1c query manager cache; no cache bypass. Cache hits make no provider call and reserve no credits.',
    outputStore: outputStoreId === null ? 'NANSEN_OBSERVATION_STORE_ID (external value intentionally not read during dry-run)' : 'CONFIGURED_EXTERNAL_STORE_ID_REDACTED',
    stopConditions: Object.freeze([
      'Stop before dispatch unless an external approved positive budget, existing matching ledger, credential, and post-Astra collection gate are configured.',
      'Stop on the first failed, incomplete, uncertain, over-budget, or accounting-halted result; never retry automatically.',
      'Stop after at most three query attempts or seven estimated credits for this plan.',
      'Do not run to satisfy a qualification count; reconcile useful verified successes and provider billing separately.',
    ]),
  });
}

export async function runD2cCollection({ mode = 'dry-run', environment = () => undefined, dependencies = null } = {}) {
  if (mode === 'dry-run') {
    const outputStoreId = null;
    return Object.freeze({ mode: 'DRY_RUN', providerCalls: 0, providerAttempts: 0, qualifyingSuccessfulRequests: 0, credentialRead: false, plan: createD2cCollectionPlan(outputStoreId) });
  }
  if (mode !== 'collect') throw new TypeError('Collection mode is invalid.');
  if (!dependencies || typeof dependencies.openLedger !== 'function' || typeof dependencies.openStore !== 'function' ||
      typeof dependencies.createClient !== 'function' || typeof dependencies.createManager !== 'function') {
    throw new TypeError('Collection dependencies are invalid.');
  }
  const gates = {
    collectionReviewed: environment('NANSEN_COLLECTION_REVIEWED') === 'true',
    collectionEnabled: environment('NANSEN_COLLECTION_ENABLED') === 'true',
    apiEnabled: environment('NANSEN_API_ENABLED') === 'true',
  };
  if (!gates.collectionReviewed || !gates.collectionEnabled || !gates.apiEnabled) {
    throw new Error('COLLECTION_REQUIRES_SEPARATE_REVIEW_AND_EXPLICIT_ENABLEMENT');
  }
  const limit = Number(environment('NANSEN_CREDIT_BUDGET'));
  const ledgerLimit = Number(environment('NANSEN_LEDGER_LIMIT_CREDITS'));
  if (!Number.isSafeInteger(limit) || limit < 7 || limit !== ledgerLimit) throw new Error('COLLECTION_BUDGET_BELOW_PLAN_OR_LEDGER_MISMATCH');
  const apiKey = environment('NANSEN_API_KEY');
  if (typeof apiKey !== 'string' || apiKey.length < 1) throw new Error('COLLECTION_CREDENTIAL_UNAVAILABLE');
  const required = [
    'NANSEN_LEDGER_PATH', 'NANSEN_LEDGER_BUDGET_ID', 'NANSEN_OBSERVATION_STORE_PATH', 'NANSEN_OBSERVATION_STORE_ID',
  ];
  if (required.some((key) => typeof environment(key) !== 'string' || environment(key).length === 0)) {
    throw new Error('COLLECTION_EXTERNAL_STATE_UNAVAILABLE');
  }
  const ledger = dependencies.openLedger({
    databasePath: environment('NANSEN_LEDGER_PATH'), budgetId: environment('NANSEN_LEDGER_BUDGET_ID'),
    limitCredits: ledgerLimit, costProfileVersion: environment('NANSEN_COST_PROFILE_VERSION'),
  });
  let store;
  try {
    const ledgerSnapshot = ledger.getSnapshot();
    if (ledgerSnapshot.pendingAttemptCount > 0 || ledgerSnapshot.reconciliationRequired ||
        (typeof ledger.listUnknownChargeAttempts === 'function' && ledger.listUnknownChargeAttempts().length > 0)) {
      throw new Error('LEDGER_RECONCILIATION_REQUIRED');
    }
    store = dependencies.openStore({ databasePath: environment('NANSEN_OBSERVATION_STORE_PATH'), storeId: environment('NANSEN_OBSERVATION_STORE_ID') });
    const client = dependencies.createClient({ ledger, enabled: true, apiKey, maxPages: 1 });
    const manager = dependencies.createManager({ client, store, enabled: true, maxPageBound: 1, maxRetryBound: 0 });
    const results = [];
    let failed = false;
    for (const query of D2C_COLLECTION_QUERIES) {
      const result = await manager.query(canonicalManagedQuery(query));
      results.push(Object.freeze({
        operation: query.operation,
        status: result.status,
        source: result.source,
        completeness: result.completeness,
        observationCount: result.observations.length,
        providerAttempts: result.attemptPageReferences.length,
        qualifyingSuccessfulRequests: result.qualifyingSuccessfulRequests,
        failureCode: result.failure?.code ?? result.storeError ?? result.managerError ?? null,
      }));
      const cleanCompleteNansenResult = result.source === 'nansen' && result.completeness === 'complete' &&
        !result.failure && !result.storeError && !result.managerError;
      const successfulFresh = result.status === 'fresh' && cleanCompleteNansenResult &&
        (result.qualifyingSuccessfulRequests > 0 || result.coalesced);
      const freshCacheHit = result.status === 'cached' && result.cacheHit && cleanCompleteNansenResult &&
        result.qualifyingSuccessfulRequests === 0 && result.attemptPageReferences.length === 0;
      if (!successfulFresh && !freshCacheHit) {
        failed = true;
        break;
      }
    }
    const providerAttempts = results.reduce((total, result) => total + result.providerAttempts, 0);
    const qualifyingSuccessfulRequests = results.reduce((total, result) => total + result.qualifyingSuccessfulRequests, 0);
    return Object.freeze({ mode: 'COLLECTED', providerCalls: providerAttempts, providerAttempts, qualifyingSuccessfulRequests, credentialRead: true,
      stoppedOnFailure: failed, results: Object.freeze(results), ledger: ledger.getSnapshot() });
  } finally {
    try { store?.close(); } finally { ledger.close(); }
  }
}
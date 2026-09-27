import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BASE_USDC_PRICE_CACHE_KEY,
  WETH_RESEARCH_CACHE_KEYS,
  NANSEN_COST_PROFILE_VERSION,
  createNansenClient,
  createNansenQueryManager,
  initializeCreditLedger,
  initializeNansenObservationStore,
  openCreditLedger,
  openNansenObservationStore,
} from '../../packages/nansen/dist/index.js';
import { acquireCollectionLock } from '../d2c/collector-lock.mjs';
import {
  D2U_ADAPTER_BODY,
  D2U_ATTEMPT_CAP,
  D2U_CREDIT_LIMIT,
  D2U_QUERY,
  buildD2uDryRunPlan,
  runD2uManagedDiagnostic,
} from './diagnostic.mjs';
import { acquireD2uSharedStoreLock, resolveD2uScopedConfiguration } from './run-usdc-diagnostic.mjs';
import { assessPersistedUsdcCandidates, readPersistedUsdcReadiness } from './readiness-check.mjs';
import { buildD2uRawAttributionPreview } from './raw-response-attribution.mjs';

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const FIXTURE = JSON.parse(readFileSync(new URL('../../packages/nansen/fixtures/token-screener.synthetic.json', import.meta.url), 'utf8'));
const USDC_FIXTURE = { ...FIXTURE, data: FIXTURE.data.filter((row) => row.token_address.toLowerCase() === USDC_ADDRESS.toLowerCase()) };
const ROOTS = new Set();
function root() {
  const path = mkdtempSync(join(tmpdir(), 'ered-luin-d2u-'));
  ROOTS.add(path);
  return path;
}
function state(path, id = 'main') {
  const ledgerOptions = { databasePath: join(path, id + '-credits.sqlite'), budgetId: 'd2u-test-' + id,
    limitCredits: D2U_CREDIT_LIMIT, costProfileVersion: NANSEN_COST_PROFILE_VERSION };
  initializeCreditLedger(ledgerOptions).close();
  const storeOptions = { databasePath: join(path, id + '-observations.sqlite'), storeId: 'd2u-test-' + id };
  initializeNansenObservationStore(storeOptions).close();
  return { ledgerOptions, storeOptions };
}
function paths(path) {
  return { runMarkerPath: join(path, 'run.marker.json'), dispatchMarkerPath: join(path, 'dispatch.marker.json'),
    resultPath: join(path, 'result.json') };
}
function response(body = USDC_FIXTURE, status = 200, charged = 1) {
  return { status, headers: charged === null ? {} : { 'X-Nansen-Credits-Used': String(charged) },
    body: new TextEncoder().encode(JSON.stringify(body)) };
}
function fakeTransport(body = USDC_FIXTURE, status = 200, charged = 1) {
  const calls = [];
  return { calls, transport: async (request) => {
    calls.push({ url: new URL(request.url), method: request.method, headers: request.headers, body: JSON.parse(request.body) });
    return response(body, status, charged);
  } };
}
async function run(storeOptions, ledgerOptions, files, transport) {
  const ledger = openCreditLedger(ledgerOptions);
  const store = openNansenObservationStore(storeOptions);
  try {
    return await runD2uManagedDiagnostic({ ledger, store, apiKey: 'D2U_SYNTHETIC_TEST_KEY', ...files,
      ...(transport ? { transport } : {}) });
  } finally { store.close(); ledger.close(); }
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const path of ROOTS) rmSync(path, { recursive: true, force: true });
  ROOTS.clear();
});

describe('D2u bounded native Base USDC diagnostic', () => {
  it('previews exact semantics with zero calls and three-credit/attempt ceilings', () => {
    expect(buildD2uDryRunPlan()).toMatchObject({
      mode: 'DRY_RUN', providerCalls: 0, transportAttempts: 0, credentialRead: false,
      authorizedTotalCeilingCredits: 3, maximumTransportAttempts: D2U_ATTEMPT_CAP,
      request: { managedQuery: D2U_QUERY, body: D2U_ADAPTER_BODY, maxPages: 1, maxRetries: 0, expectedCredits: 1 },
    });
    expect(D2U_ADAPTER_BODY.filters.token_address).toBe(USDC_ADDRESS);
    expect(D2U_ADAPTER_BODY.filters).not.toHaveProperty('include_native_tokens');
  });

  it('sends one exact managed request through injected transport and marks its evidence synthetic', async () => {
    const dir = root(); const db = state(dir); const fake = fakeTransport();
    const report = await run(db.storeOptions, db.ledgerOptions, paths(dir), fake.transport);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      url: { pathname: '/api/v1/token-screener' }, method: 'POST',
      headers: { apikey: 'D2U_SYNTHETIC_TEST_KEY' }, body: D2U_ADAPTER_BODY,
    });
    const expectedWireBody = '{"chains":["base"],"filters":{"include_stablecoins":true,"token_address":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","trader_type":"all"},"pagination":{"page":1,"per_page":100},"timeframe":"1h"}';
    expect(JSON.stringify(fake.calls[0].body)).toBe(expectedWireBody);
    expect(buildD2uRawAttributionPreview().request.requestBodySha256).toBe(createHash('sha256').update(expectedWireBody).digest('hex'));
    expect(report).toMatchObject({
      status: 'fresh', source: 'synthetic', cacheOutcome: 'MISS_DISPATCHED',
      dispatches: 1, transportAttempts: 1,
      usdc: { rowPresence: 'present', priceState: 'synthetic_only', usable: false, priceUsd: '1.000000' },
      ledger: { limitCredits: 3, allocatedCredits: 1, remainingCredits: 2, reportedChargedCreditsTotal: 1 },
    });
  });

  it('uses the production default transport and reports one actual fetch plus a usable live-source shape', async () => {
    const dir = root(); const db = state(dir); const calls = [];
    vi.stubGlobal('fetch', async (url, init) => {
      calls.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(USDC_FIXTURE), { status: 200, headers: { 'X-Nansen-Credits-Used': '1' } });
    });
    const ledger = openCreditLedger(db.ledgerOptions); const store = openNansenObservationStore(db.storeOptions);
    try {
      const report = await runD2uManagedDiagnostic({ ledger, store, apiKey: 'D2U_SYNTHETIC_TEST_KEY', ...paths(dir) });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ url: 'https://api.nansen.ai/api/v1/token-screener', method: 'POST', body: D2U_ADAPTER_BODY });
      expect(report).toMatchObject({ source: 'nansen', dispatches: 1, transportAttempts: 1, usdc: { usable: true, priceUsd: '1.000000' } });
    } finally { store.close(); ledger.close(); }
  });

  it('continues the original ledger and append-only dispatch sequence for one additional attempt', async () => {
    const dir = root(); const db = state(dir); const first = fakeTransport();
    const originalFiles = paths(dir);
    await run(db.storeOptions, db.ledgerOptions, originalFiles, first.transport);
    const continuedStoreOptions = { databasePath: join(dir, 'continued-observations.sqlite'), storeId: 'd2u-test-continued' };
    initializeNansenObservationStore(continuedStoreOptions).close();
    const ledger = openCreditLedger(db.ledgerOptions); const store = openNansenObservationStore(continuedStoreOptions);
    const second = fakeTransport();
    try {
      const continued = await runD2uManagedDiagnostic({ ledger, store, apiKey: 'synthetic-test-key',
        ...originalFiles, resultPath: join(dir, 'continued-result.json'), transport: second.transport,
        continuation: { priorDispatches: 1, maxAdditionalAttempts: 1 } });
      expect(second.calls).toHaveLength(1);
      expect(continued).toMatchObject({ dispatches: 1, transportAttempts: 1, ledger: { allocatedCredits: 2, remainingCredits: 1, reportedChargeCount: 2 } });
      expect(JSON.parse(readFileSync(originalFiles.dispatchMarkerPath + '.1', 'utf8'))).toMatchObject({ sequence: 1 });
      expect(JSON.parse(readFileSync(originalFiles.dispatchMarkerPath + '.2', 'utf8'))).toMatchObject({ sequence: 2, continuation: true });
      expect(JSON.parse(readFileSync(originalFiles.runMarkerPath, 'utf8'))).toMatchObject({ transportAttemptLimit: 3 });
    } finally { store.close(); ledger.close(); }
  });

  it('reuses the manager cache without consuming a credit or calling fetch', async () => {
    const dir = root(); const db = state(dir); let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return new Response(JSON.stringify(USDC_FIXTURE), { status: 200, headers: { 'X-Nansen-Credits-Used': '1' } });
    });
    const seedLedgerOptions = { ...db.ledgerOptions, databasePath: join(dir, 'seed-credits.sqlite'), budgetId: 'd2u-test-seed' };
    initializeCreditLedger(seedLedgerOptions).close();
    const seedLedger = openCreditLedger(seedLedgerOptions); const seedStore = openNansenObservationStore(db.storeOptions);
    try {
      const client = createNansenClient({ ledger: seedLedger, enabled: true, apiKey: 'seed-key', maxPages: 1 });
      const manager = createNansenQueryManager({ client, store: seedStore, enabled: true, maxPageBound: 1, maxRetryBound: 0 });
      await manager.query(D2U_QUERY);
    } finally { seedStore.close(); seedLedger.close(); }
    const before = calls;
    const report = await run(db.storeOptions, db.ledgerOptions, paths(dir));
    expect(calls).toBe(before);
    expect(report).toMatchObject({ cacheOutcome: 'HIT', cacheHit: true, dispatches: 0,
      ledger: { allocatedCredits: 0, remainingCredits: 3, reportedChargeCount: 0 }, usdc: { usable: true } });
  });

  it('reports missing native USDC without inventing a price', async () => {
    const dir = root(); const db = state(dir);
    const missing = { ...USDC_FIXTURE, data: [] };
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(missing), { status: 200,
      headers: { 'X-Nansen-Credits-Used': '1' } }));
    const ledger = openCreditLedger(db.ledgerOptions); const store = openNansenObservationStore(db.storeOptions);
    try {
      const report = await runD2uManagedDiagnostic({ ledger, store, apiKey: 'synthetic-test-key', ...paths(dir) });
      expect(report).toMatchObject({ source: 'nansen', usdc: { rowPresence: 'absent', priceState: 'missing', usable: false } });
      expect(report.usdc.priceUsd).toBeNull();
      expect(report.ledger.allocatedCredits).toBe(1);
      const readiness = readPersistedUsdcReadiness({ databasePath: db.storeOptions.databasePath, storeId: db.storeOptions.storeId });
      expect(readiness).toMatchObject({ status: 'PRICE_MISSING', ready: false, snapshotPresent: true, source: 'nansen' });
    } finally { store.close(); ledger.close(); }
  });

  it('stops on failed or unknown charge, does not retry, and sanitizes transport errors', async () => {
    const failedDir = root(); const failedDb = state(failedDir); const failed = fakeTransport({ error: 'private-body' }, 503, 1);
    const failedReport = await run(failedDb.storeOptions, failedDb.ledgerOptions, paths(failedDir), failed.transport);
    expect(failed.calls).toHaveLength(1);
    expect(failedReport).toMatchObject({ status: 'failed', dispatches: 1, ledger: { allocatedCredits: 1, reportedChargedCreditsTotal: 1 } });
    expect(JSON.stringify(failedReport)).not.toContain('private-body');

    const unknownDir = root(); const unknownDb = state(unknownDir); let calls = 0;
    const privateError = 'D2U_SECRET_TRANSPORT_DETAIL';
    const unknown = async () => { calls += 1; throw new Error(privateError); };
    const unknownReport = await run(unknownDb.storeOptions, unknownDb.ledgerOptions, paths(unknownDir), unknown);
    expect(calls).toBe(1);
    expect(unknownReport).toMatchObject({ dispatches: 1, failureClass: 'ACCOUNTING_RECONCILIATION_REQUIRED',
      unknownChargeAttempts: 1, ledger: { pendingAttemptCount: 0 } });
    expect(JSON.stringify(unknownReport)).not.toContain(privateError);
    expect(JSON.stringify(unknownReport)).not.toContain('D2U_SYNTHETIC_TEST_KEY');
  });

  it('rejects duplicate create-only run state before a second transport attempt', async () => {
    const dir = root(); const db = state(dir); const files = paths(dir); const fake = fakeTransport();
    await run(db.storeOptions, db.ledgerOptions, files, fake.transport);
    const ledger = openCreditLedger(db.ledgerOptions); const store = openNansenObservationStore(db.storeOptions);
    try {
      await expect(runD2uManagedDiagnostic({ ledger, store, apiKey: 'test-key', ...files, transport: fake.transport }))
        .rejects.toThrow('D2U_EXTERNAL_STATE_UNAVAILABLE');
    } finally { store.close(); ledger.close(); }
    expect(fake.calls).toHaveLength(1);
  });

  it('selects the existing validation configuration and never the main zero-budget ledger', () => {
    const validationEnvironment = {
      BASE_USDC_PRICE_CACHE_KEY,
  WETH_RESEARCH_CACHE_KEYS,
  NANSEN_COST_PROFILE_VERSION, NANSEN_CREDIT_BUDGET: '0', NANSEN_LEDGER_LIMIT_CREDITS: '7',
      NANSEN_LEDGER_PATH: 'scoped-ledger', NANSEN_LEDGER_BUDGET_ID: 'scoped-budget',
      NANSEN_OBSERVATION_STORE_PATH: 'canonical-store', NANSEN_OBSERVATION_STORE_ID: 'canonical-id',
    };
    const config = resolveD2uScopedConfiguration('private-root', () => ({
      mainConfigPath: 'main-config', originalValidationConfigPath: 'scoped-config',
      mainEnvironment: { NANSEN_LEDGER_LIMIT_CREDITS: '0', NANSEN_LEDGER_PATH: '' }, validationEnvironment,
    }));
    expect(config.environment).toBe(validationEnvironment);
    expect(config.environment.NANSEN_LEDGER_PATH).toBe('scoped-ledger');
  });

  it('fails closed on shared observation-store lock contention', () => {
    const dir = root(); const db = state(dir, 'locked');
    const owner = acquireCollectionLock(db.storeOptions.databasePath, { runId: 'test-owner' });
    try { expect(() => acquireD2uSharedStoreLock(db.storeOptions.databasePath)).toThrow('D2U_STORE_LOCKED'); }
    finally { owner.release(); }
  });

  it('does not dispatch against a non-fresh diagnostic ledger', async () => {
    const dir = root(); const db = state(dir); const ledger = openCreditLedger(db.ledgerOptions);
    const store = openNansenObservationStore(db.storeOptions); const fake = fakeTransport();
    try {
      ledger.reserveAttempt({ attemptId: 'spent-once', operation: 'TOKEN_SCREENER', requestFingerprint: 'a'.repeat(64) });
      ledger.recordTerminalResult({ attemptId: 'spent-once', outcome: 'SUCCESS', chargedCredits: 1 });
      await expect(runD2uManagedDiagnostic({ ledger, store, apiKey: 'test-key', ...paths(dir), transport: fake.transport }))
        .rejects.toThrow('D2U_LEDGER_NOT_FRESH');
      expect(fake.calls).toHaveLength(0);
    } finally { store.close(); ledger.close(); }
  });
  it('reads a persisted native USDC price with a read-only connection and no provider calls', async () => {
    const dir = root(); const db = state(dir); const instant = new Date(Date.now() - 60_000); let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return new Response(JSON.stringify(USDC_FIXTURE), { status: 200, headers: { 'X-Nansen-Credits-Used': '1' } });
    });
    const ledger = openCreditLedger(db.ledgerOptions); const store = openNansenObservationStore(db.storeOptions);
    try {
      const client = createNansenClient({ ledger, enabled: true, apiKey: 'test-key', maxPages: 1 });
      const manager = createNansenQueryManager({ client, store, enabled: true, maxPageBound: 1, maxRetryBound: 0, clock: () => instant });
      await manager.query(D2U_QUERY);
    } finally { store.close(); ledger.close(); }
    const callsBeforeReadiness = calls;
    const dbPath = db.storeOptions.databasePath;
    const hashBefore = createHash('sha256').update(readFileSync(dbPath)).digest('hex');
    const report = readPersistedUsdcReadiness({ databasePath: dbPath, storeId: db.storeOptions.storeId, now: new Date(instant.getTime() + 60_000) });
    const hashAfter = createHash('sha256').update(readFileSync(dbPath)).digest('hex');
    expect(report).toMatchObject({ mode: 'PERSISTED_READINESS', providerCalls: 0, credentialRead: false,
      status: 'READY', ready: true, source: 'nansen', operation: 'TOKEN_SCREENER', asset: 'USDC' });
    expect(report.priceUsdMicros).toMatch(/^[1-9][0-9]*$/u);
    expect(calls).toBe(callsBeforeReadiness);
    expect(hashAfter).toBe(hashBefore);
  });
  it('selects fresh paired USDC fallback and reports its source and market age', () => {
    const fetchedAt = '2026-09-27T11:59:00.000Z';
    const acquiredAt = '2026-09-27T11:59:01.000Z';
    const snapshot = { snapshot_id: '00000000-0000-4000-8000-000000000501',
      cache_key: WETH_RESEARCH_CACHE_KEYS.TOKEN_SCREENER, operation: 'TOKEN_SCREENER', asset: 'BASE_PAIR',
      timeframe: '1h', page_bound: 1, retry_bound: 0, source: 'nansen', fetched_at: fetchedAt, acquired_at: acquiredAt,
      expires_at: '2026-09-27T12:09:01.000Z', completeness: 'complete', failure_code: null };
    const signal = { provider: 'nansen', endpoint: 'TOKEN_SCREENER', chain_id: 8453, asset: 'USDC',
      metric: 'price_usd', quality: 'COMPLETE', value: '1000000', unit: 'usd_micros', observed_at: acquiredAt,
      fetched_at: fetchedAt, timeframe: '1h' };
    const report = assessPersistedUsdcCandidates([snapshot], new Map([[snapshot.snapshot_id, [signal]]]), new Date('2026-09-27T12:00:00.000Z'));
    expect(report).toMatchObject({ status: 'READY', ready: true, source: 'nansen',
      selectedSource: 'nansen-paired-screener', operation: 'TOKEN_SCREENER', asset: 'BASE_PAIR',
      ageMs: 60_000, priceUsdMicros: '1000000' });
  });

  it('reports the actual persisted diagnostic snapshot as missing when no USDC price row exists', () => {
    const dir = root(); const db = state(dir);
    const report = readPersistedUsdcReadiness({ databasePath: db.storeOptions.databasePath, storeId: db.storeOptions.storeId });
    expect(report).toMatchObject({ providerCalls: 0, credentialRead: false, status: 'NO_SNAPSHOT', ready: false, snapshotPresent: false });
  });
});

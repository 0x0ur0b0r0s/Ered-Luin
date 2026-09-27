import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BASE_ASSET_ADDRESSES, BASE_USDC_OHLCV_PRICE_CACHE_KEY, NANSEN_COST_PROFILE_VERSION,
  createBaseUsdcOhlcvPriceQuery, initializeCreditLedger, initializeNansenObservationStore,
} from '../../packages/nansen/dist/index.js';
import { buildD2vDryRunPlan, classifyD2vPrice, runD2vManagedDiagnostic } from './diagnostic.mjs';

const roots = new Set();
function root() { const value = mkdtempSync(join(tmpdir(), 'ered-luin-d2v-test-')); roots.add(value); return value; }
afterEach(() => { vi.unstubAllGlobals(); for (const value of roots) rmSync(value, { recursive: true, force: true }); roots.clear(); });
function completedSignal(overrides = {}, now = new Date()) {
  const observedAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000 - 2 * 60_000).toISOString();
  return { endpoint: 'TOKEN_OHLCV', provider: 'nansen', chainId: 8453, asset: 'USDC', metric: 'price_usd',
    timeframe: '1m', observedAt, fetchedAt: now.toISOString(), quality: 'COMPLETE', value: '1000100', unit: 'usd_micros',
    provenanceId: 'synthetic-d2v-test', ...overrides };
}

describe('D2v bounded OHLCV diagnostic', () => {
  it('shows exact one-request scope with no credential read in dry-run', () => {
    const plan = buildD2vDryRunPlan(new Date('2026-09-27T12:30:45.000Z'));
    expect(plan).toMatchObject({ gate: 'D2v', mode: 'DRY_RUN', providerCalls: 0, transportAttempts: 0, credentialRead: false,
      budget: { ceilingCredits: 3, priorAttempts: 2, priorReportedCredits: 2, maximumAdditionalAttempts: 1, maximumAdditionalCredits: 1 },
      request: { endpoint: '/api/v1/tgm/token-ohlcv', operation: 'TOKEN_OHLCV', expectedCredits: 1, pageBound: 1, retryBound: 0,
        cacheKey: BASE_USDC_OHLCV_PRICE_CACHE_KEY, body: { chain: 'base', token_address: BASE_ASSET_ADDRESSES.USDC, timeframe: '1m',
          date: { from: '2026-09-27T12:20:00.000Z', to: '2026-09-27T12:30:00.000Z' } } } });
  });

  it('classifies missing, malformed, stale, and usable candles by interval time', () => {
    const now = new Date();
    expect(classifyD2vPrice({ result: { observations: [] }, now }).status).toBe('PRICE_MISSING');
    expect(classifyD2vPrice({ result: { observations: [completedSignal({ value: '0' }, now)] }, now }).status).toBe('PRICE_MALFORMED');
    const staleAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000 - 12 * 60_000).toISOString();
    expect(classifyD2vPrice({ result: { observations: [completedSignal({ observedAt: staleAt }, now)] }, now }).status).toBe('PRICE_STALE');
    expect(classifyD2vPrice({ result: { observations: [completedSignal({}, now)] }, now }).status).toBe('PRICE_USABLE');
    expect(classifyD2vPrice({ result: { observations: [completedSignal({}, now), completedSignal({ signalId: 'duplicate' }, now)] }, now }).status).toBe('PRICE_AMBIGUOUS');
  });

  it('uses default transport once, captures raw bytes before parsing, and settles exactly the remaining credit', async () => {
    const state = root();
    const started = new Date();
    const query = createBaseUsdcOhlcvPriceQuery(started);
    const toMs = Date.parse(query.date.to);
    const rawText = JSON.stringify({ chain: 'base', token_address: BASE_ASSET_ADDRESSES.USDC, timeframe: '1m',
      data: [{ interval_start: new Date(toMs - 2 * 60_000).toISOString(), close: 1.0001, market_cap: { close: 99_000 } }] });
    const fetchSpy = vi.fn(async (input, init) => {
      expect(String(input)).toBe('https://api.nansen.ai/api/v1/tgm/token-ohlcv');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({ chain: 'base', token_address: BASE_ASSET_ADDRESSES.USDC,
        timeframe: '1m', date: query.date });
      return new Response(rawText, { status: 200, headers: { 'content-type': 'application/json',
        'x-request-id': 'd2v-default-transport-test', 'x-nansen-credits-used': '1' } });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const ledgerOptions = { databasePath: join(state, 'credits.sqlite'), budgetId: 'nansen-usdc-price-diagnostic-20260927-01',
      limitCredits: 3, costProfileVersion: NANSEN_COST_PROFILE_VERSION };
    const ledger = initializeCreditLedger(ledgerOptions);
    const storeId = 'd2v-offline-store';
    const store = initializeNansenObservationStore({ databasePath: join(state, 'observations.sqlite'), storeId });
    for (const [index, attemptId] of ['prior-screen-one', 'prior-screen-two'].entries()) {
      ledger.reserveAttempt({ attemptId, operation: 'TOKEN_SCREENER', requestFingerprint: String(index + 1).repeat(64) });
      ledger.recordTerminalResult({ attemptId, outcome: 'SUCCESS', httpStatus: 200, providerRequestId: 'prior-' + index, chargedCredits: 1 });
    }
    const reportPath = join(state, 'ohlcv-diagnostic-summary.json');
    const report = await runD2vManagedDiagnostic({ ledger, store, apiKey: 'synthetic-test-key', stateDirectory: state,
      runMarkerPath: join(state, 'ohlcv-run.marker.json'), dispatchMarkerPath: join(state, 'ohlcv-attempt.marker.json'),
      resultPath: reportPath, now: () => new Date() });
    try {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(report).toMatchObject({ status: 'PRICE_USABLE', dispatches: 1, transportAttempts: 1,
        rawCapture: { status: 'CAPTURED', metadata: { httpStatus: 200, chargedCredits: 1, matchesApprovedRequestBody: true } },
        ledger: { before: { allocatedCredits: 2, remainingCredits: 1 }, after: { allocatedCredits: 3, remainingCredits: 0,
          reportedChargeCount: 3, pendingAttemptCount: 0, reconciliationRequired: false, unknownChargeAttempts: 0 } } });
      expect(report.price).toMatchObject({ status: 'PRICE_USABLE', priceUsd: '1.000100', priceUsdMicros: '1000100' });
      expect(report.request.cacheKey).toBe(BASE_USDC_OHLCV_PRICE_CACHE_KEY);
      expect(JSON.stringify(report)).not.toContain(rawText);
      expect(readdirSync(state)).toContain('ohlcv-attempt.marker.json.3');
      const rawFile = readdirSync(state).find((name) => name.startsWith('ohlcv-raw-response-') && name.endsWith('.bin'));
      expect(rawFile).toBeDefined();
      expect(readFileSync(join(state, rawFile), 'utf8')).toBe(rawText);
      expect(store.getLatestSnapshotByCacheKey(BASE_USDC_OHLCV_PRICE_CACHE_KEY)?.signals[0]?.timeframe).toBe('1m');
    } finally { store.close(); ledger.close(); }
  });
});
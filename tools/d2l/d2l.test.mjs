import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NANSEN_COLLECTOR_PLAN, WETH_RESEARCH_PLAN, WETH_RESEARCH_CACHE_KEYS, QUERY_CACHE_TTL_MS,
  NANSEN_COST_PROFILE_VERSION, NANSEN_OPERATION_COSTS, createNansenClient, createNansenCollector,
  createNansenQueryManager, initializeCreditLedger, initializeNansenObservationStore, openNansenObservationStore,
} from '../../packages/nansen/dist/index.js';
import { evaluateG2Intent } from '../../apps/api/dist/policy.js';
import { makeNewRunManifest, readRunManifest, writeRunManifest } from '../d2h/bounded-session.mjs';
import { createD2lResearchHooks, hasUsableWethResearchSignal } from './research-session.mjs';
import { summarizeWethResearchHistory } from './research-summary.mjs';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SCREEN = JSON.parse(readFileSync(new URL('../../packages/nansen/fixtures/token-screener.synthetic.json', import.meta.url), 'utf8'));
const NETFLOW = JSON.parse(readFileSync(new URL('../../packages/nansen/fixtures/smart-money-netflow.synthetic.json', import.meta.url), 'utf8'));
const dirs = []; const stores = []; const ledgers = [];
let time; let requests;
function makeRuntime({ budget = 3_000, response = null, latencyMs = 0 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ered-luin-d2l-test-')); dirs.push(directory);
  const clock = () => new Date(time.value);
  const ledgerPath = join(directory, 'ledger.sqlite'); const storePath = join(directory, 'observations.sqlite');
  const ledger = initializeCreditLedger({ databasePath: ledgerPath, budgetId: 'synthetic-d2l-budget', limitCredits: budget, costProfileVersion: NANSEN_COST_PROFILE_VERSION, clock }); ledgers.push(ledger);
  let store = initializeNansenObservationStore({ databasePath: storePath, storeId: 'synthetic-d2l-store', clock }); stores.push(store);
  requests = [];
  const fetchImpl = vi.fn(async (url) => {
    const address = String(url); const operation = address.endsWith('/token-screener') ? 'TOKEN_SCREENER' : 'SMART_MONEY_NETFLOW';
    requests.push(operation); time.value += latencyMs;
    const chosen = response ? response(operation) : operation === 'TOKEN_SCREENER' ? SCREEN : NETFLOW;
    if (chosen instanceof Response) return chosen;
    return new Response(JSON.stringify(chosen), { status: 200, headers: { 'x-nansen-credits-used': String(NANSEN_OPERATION_COSTS[operation]) } });
  });
  vi.stubGlobal('fetch', fetchImpl);
  const manager = (extra = {}) => createNansenQueryManager({ client: createNansenClient({ ledger, enabled: true, apiKey: 'synthetic-only-d2l-key', maxPages: 1 }),
    store, enabled: true, maxPageBound: 1, maxRetryBound: 0, clock, ...extra });
  return { directory, ledgerPath, storePath, ledger, get store() { return store; }, reopenStore() { store.close(); store = openNansenObservationStore({ databasePath: storePath, storeId: 'synthetic-d2l-store', clock }); stores.push(store); return store; }, clock, fetchImpl, manager };
}
function summaryStoreForFlows(samples) {
  const snapshots = samples.map(({ at, value }) => ({
    source: 'nansen', acquiredAt: at, completeness: 'complete', failure: null,
    signals: [{ provider: 'nansen', endpoint: 'SMART_MONEY_NETFLOW', asset: 'WETH', metric: 'net_flow_1h_usd',
      quality: 'COMPLETE', unit: 'usd_micros', value, observedAt: at, fetchedAt: at }],
  }));
  return {
    getHistoryCount: (cacheKey) => cacheKey === WETH_RESEARCH_CACHE_KEYS.SMART_MONEY_NETFLOW ? snapshots.length : 0,
    listHistory: ({ cacheKey, limit }) => cacheKey === WETH_RESEARCH_CACHE_KEYS.SMART_MONEY_NETFLOW ? snapshots.slice(0, limit) : [],
  };
}
function manifestFor(runtime, overrides = {}) {
  const bounds = { deadlineAt: new Date(time.value + 48 * 60 * 60_000).toISOString(), maxAttempts: 900, creditCap: 2_700, successTarget: 850, reconciledPriorSuccesses: 0, ...overrides };
  return makeNewRunManifest({ bounds, profile: 'weth-research-v1', stateIdentity: 'b'.repeat(64), baselineAllocatedCredits: runtime.ledger.getSnapshot().allocatedCredits, ledger: runtime.ledger.getSnapshot() });
}
function policyContext(signals, now) {
  const issuedAt = new Date(now.getTime() - 1_000).toISOString();
  return {
    intent: { intentId: '11111111-1111-4111-8111-111111111111', chainId: 8453, walletAddress: '0x0000000000000000000000000000000000000011', sellAsset: 'USDC', buyAsset: 'WETH', amountIn: '1000000', issuedAt, expiresAt: new Date(now.getTime() + 59_000).toISOString() },
    signals, account: { walletAddress: '0x0000000000000000000000000000000000000011', version: 0, usdcBalanceAtomic: '20000000', wethBalanceAtomic: '0', gasBalanceNativeWei: '0', utcDay: now.toISOString().slice(0, 10), dailyStartEquityUsdcMicros: '20000000', dailyFundingUsdcMicros: '0' },
    quotes: { accountVersion: 0, positionQuote: null, tradeQuote: null, projectedPositionQuote: null, gasQuote: null, projectedGasQuote: null, gasFeeQuote: null }, now,
  };
}
function fakeTimerRuntime(runtime, bounds, onStarted = () => {}) {
  const manifest = manifestFor(runtime, bounds); let checkpointCount = 0; const timers = []; let cycleDone = null;
  const hooks = createD2lResearchHooks({ bounds: { ...manifest }, manifest, getLedgerSnapshot: () => runtime.ledger.getSnapshot(), costs: NANSEN_OPERATION_COSTS, now: runtime.clock, persist: () => { checkpointCount += 1; } });
  const manager = runtime.manager({ cachePolicy: 'weth-research-v1', beforeDispatch: hooks.beforeDispatch });
  const scheduler = createNansenCollector({ manager, profile: 'weth-research-v1', enabled: true, clock: runtime.clock, stopOnFailure: true,
    beforeQuery: hooks.beforeQuery, onQuery: hooks.onQuery,
    setTimer(callback, delayMs) { const timer = { callback, delayMs, cancelled: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cancelled = true; },
    onCycle() { hooks.onCycle(); onStarted(); cycleDone?.(); cycleDone = null; },
  });
  return { manifest, hooks, scheduler, timers, get checkpointCount() { return checkpointCount; }, async tick() {
    const timer = timers.findLast((candidate) => !candidate.cancelled); if (!timer) throw new Error('expected a scheduled research tick');
    timer.cancelled = true; let done; const complete = new Promise((resolve) => { done = resolve; }); cycleDone = done;
    time.value += timer.delayMs; timer.callback(); await complete;
  } };
}
beforeEach(() => { time = { value: Date.now() }; requests = []; });
afterEach(() => { for (const store of stores.splice(0)) { try { store.close(); } catch { /* Store may already have been closed to simulate process restart. */ } } for (const ledger of ledgers.splice(0)) { try { ledger.close(); } catch { /* Ledger may already have been closed. */ } } for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); });

describe('D2l bounded WETH research profile', () => {
  it('uses an actual five-minute cache age across manager restarts while preserving the default 30-minute Netflow TTL', async () => {
    const runtime = makeRuntime();
    expect(QUERY_CACHE_TTL_MS.SMART_MONEY_NETFLOW).toBe(30 * 60_000);
    const query = WETH_RESEARCH_PLAN[1].query;
    const first = await runtime.manager({ cachePolicy: 'weth-research-v1' }).query(query);
    expect(first.status).toBe('fresh'); expect(requests).toHaveLength(1);
    runtime.reopenStore();
    time.value += 4 * 60_000 + 59_000;
    const recent = await runtime.manager({ cachePolicy: 'weth-research-v1' }).query(query);
    expect(recent).toMatchObject({ status: 'cached', cacheHit: true, qualifyingSuccessfulRequests: 0 }); expect(requests).toHaveLength(1);
    time.value += 2_000;
    const defaultCache = await runtime.manager().query(query);
    expect(defaultCache).toMatchObject({ status: 'cached', cacheHit: true }); expect(requests).toHaveLength(1);
    const aged = await runtime.manager({ cachePolicy: 'weth-research-v1' }).query(query);
    expect(aged.status).toBe('fresh'); expect(requests).toHaveLength(2);
    expect(runtime.ledger.getSnapshot().allocatedCredits).toBe(10);
    await expect(runtime.manager({ cachePolicy: 'weth-research-v1' }).query({ ...query, perPage: 99 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('persists versioned research counters outside the repository and reads them after restart', () => {
    const runtime = makeRuntime(); const manifest = manifestFor(runtime);
    manifest.research.usableResearchSnapshots = 7; manifest.research.successfulHttpRequests.TOKEN_SCREENER = 5;
    const path = join(runtime.directory, 'd2l-run.json');
    writeRunManifest(path, PROJECT_ROOT, manifest, { createOnly: true });
    const restored = readRunManifest(path, PROJECT_ROOT);
    expect(restored).toMatchObject({ schemaVersion: 2, profile: 'weth-research-v1', research: { usableResearchSnapshots: 7, successfulHttpRequests: { TOKEN_SCREENER: 5, SMART_MONEY_NETFLOW: 0 }, organizerConfirmedSuccesses: null } });
  });

  it('keeps the default three-task plan and selects only the immutable two-task research plan', async () => {
    expect(NANSEN_COLLECTOR_PLAN.map(({ query }) => query.operation)).toEqual(['TOKEN_SCREENER', 'FLOW_INTELLIGENCE', 'SMART_MONEY_NETFLOW']);
    expect(WETH_RESEARCH_PLAN.map(({ query, intervalMs }) => [query.operation, intervalMs, query.pageBound, query.retryBound, query.perPage])).toEqual([
      ['TOKEN_SCREENER', 300_000, 1, 0, 100], ['SMART_MONEY_NETFLOW', 300_000, 1, 0, 100],
    ]);
    expect(Object.isFrozen(WETH_RESEARCH_PLAN)).toBe(true); expect(WETH_RESEARCH_PLAN.every((item) => Object.isFrozen(item) && Object.isFrozen(item.query))).toBe(true);
    const seen = []; const timers = [];
    const scheduler = createNansenCollector({ manager: { async query(query) { seen.push(query); return {}; } }, profile: 'weth-research-v1', enabled: true,
      setTimer(callback, delayMs) { const timer = { callback, delayMs }; timers.push(timer); return timer; }, clearTimer() {} });
    await scheduler.start(); scheduler.stop();
    expect(seen.map((query) => query.operation)).toEqual(['TOKEN_SCREENER', 'SMART_MONEY_NETFLOW']);
    expect(timers[0].delayMs).toBe(300_000);
  });

  it('continues for complete WETH when USDC is absent, counts the usable snapshot, and leaves G2 blocked on USDC', async () => {
    const wethOnly = { ...SCREEN, data: SCREEN.data.filter((row) => row.token_symbol !== 'USDC') };
    const runtime = makeRuntime({ response: (operation) => operation === 'TOKEN_SCREENER' ? wethOnly : NETFLOW });
    const config = manifestFor(runtime, { successTarget: 1, maxAttempts: 2 });
    const hooks = createD2lResearchHooks({ bounds: { ...config }, manifest: config, getLedgerSnapshot: () => runtime.ledger.getSnapshot(), costs: NANSEN_OPERATION_COSTS, now: runtime.clock, persist() {} });
    const manager = runtime.manager({ cachePolicy: 'weth-research-v1', beforeDispatch: hooks.beforeDispatch });
    const screenResult = await manager.query(WETH_RESEARCH_PLAN[0].query);
    expect(screenResult).toMatchObject({ status: 'fresh', completeness: 'complete', quality: 'PARTIAL' });
    expect(hasUsableWethResearchSignal(WETH_RESEARCH_PLAN[0].query, screenResult)).toBe(true);
    expect(hooks.onQuery(WETH_RESEARCH_PLAN[0].query, screenResult)).toBe('SUCCESS_TARGET_REACHED');
    expect(config.research).toMatchObject({ successfulHttpRequests: { TOKEN_SCREENER: 1, SMART_MONEY_NETFLOW: 0 }, usableResearchSnapshots: 1, failedResults: 0, cacheHits: 0, organizerConfirmedSuccesses: null });
    expect(requests).toEqual(['TOKEN_SCREENER']);
    const decision = evaluateG2Intent(policyContext(screenResult.observations, runtime.clock()));
    expect(screenResult.observations.find((signal) => signal.asset === 'USDC' && signal.metric === 'price_usd')).toMatchObject({ quality: 'MISSING', value: null });
    expect(decision.decision.status).toBe('REQUIRE_REVIEW'); expect(decision.decision.reasons).toContain('SCREENER_INCOMPLETE');
  });

  it('accepts signed zero Netflow as usable research but never retries or calls on a fresh cache hit', async () => {
    const zero = { ...NETFLOW, data: NETFLOW.data.map((row) => row.token_symbol === 'WETH' ? { ...row, net_flow_1h_usd: 0 } : row) };
    const runtime = makeRuntime({ response: (operation) => operation === 'SMART_MONEY_NETFLOW' ? zero : SCREEN });
    const result = await runtime.manager({ cachePolicy: 'weth-research-v1' }).query(WETH_RESEARCH_PLAN[1].query);
    expect(hasUsableWethResearchSignal(WETH_RESEARCH_PLAN[1].query, result)).toBe(true);
    expect(result.observations.find((signal) => signal.asset === 'WETH' && signal.metric === 'net_flow_1h_usd')).toMatchObject({ quality: 'COMPLETE', value: '0' });
    time.value += 60_000;
    const cached = await runtime.manager({ cachePolicy: 'weth-research-v1' }).query(WETH_RESEARCH_PLAN[1].query);
    expect(cached).toMatchObject({ status: 'cached', qualifyingSuccessfulRequests: 0 }); expect(requests).toHaveLength(1);
  });

  it('stops on 429, unknown charge, and unusable WETH without masking the accounting reason', async () => {
    const runtime = makeRuntime(); const manifest = manifestFor(runtime);
    const hooks = createD2lResearchHooks({ bounds: { ...manifest }, manifest, getLedgerSnapshot: () => runtime.ledger.getSnapshot(), costs: NANSEN_OPERATION_COSTS, now: runtime.clock, persist() {} });
    const valid = { cacheKey: 'a'.repeat(64), operation: 'TOKEN_SCREENER', asset: 'BASE_PAIR', timeframe: '1h', pageBound: 1, retryBound: 0, status: 'fresh', source: 'nansen', fetchedAt: runtime.clock().toISOString(), acquiredAt: runtime.clock().toISOString(), ageMs: 0, completeness: 'complete', quality: 'PARTIAL', observations: [{ provider: 'nansen', endpoint: 'TOKEN_SCREENER', chainId: 8453, asset: 'WETH', metric: 'price_usd', quality: 'COMPLETE', value: '1000000', unit: 'usd_micros', observedAt: runtime.clock().toISOString() }], failure: null, storeError: null, managerError: null, cacheHit: false, attemptPageReferences: [{ received: true, status: 200, chargedCredits: 1 }] };
    expect(hooks.onQuery(WETH_RESEARCH_PLAN[0].query, { ...valid, attemptPageReferences: [{ received: true, status: 429, chargedCredits: 0 }] })).toBe('RATE_LIMITED');
    const unknownManifest = manifestFor(runtime); const unknownHooks = createD2lResearchHooks({ bounds: { ...unknownManifest }, manifest: unknownManifest, getLedgerSnapshot: () => runtime.ledger.getSnapshot(), costs: NANSEN_OPERATION_COSTS, now: runtime.clock, persist() {} });
    expect(unknownHooks.onQuery(WETH_RESEARCH_PLAN[0].query, { ...valid, attemptPageReferences: [{ received: false, status: 200, chargedCredits: null }] })).toBe('UNKNOWN_CHARGE_REQUIRES_RECONCILIATION');
    expect(unknownManifest.research.successfulHttpRequests.TOKEN_SCREENER).toBe(1);
    const invalid = { ...valid, observations: valid.observations.map((signal) => ({ ...signal, quality: 'PARTIAL', value: null })) };
    const invalidManifest = manifestFor(runtime); const invalidHooks = createD2lResearchHooks({ bounds: { ...invalidManifest }, manifest: invalidManifest, getLedgerSnapshot: () => runtime.ledger.getSnapshot(), costs: NANSEN_OPERATION_COSTS, now: runtime.clock, persist() {} });
    expect(invalidHooks.onQuery(WETH_RESEARCH_PLAN[0].query, invalid)).toBe('UNUSABLE_RESULT');
    expect(invalidManifest.research.failedResults).toBe(1);
  });

  it('runs a synthetic 36-hour bounded session with real manager, ledger and store, then summarizes without lookahead or raw values', async () => {
    time.value = Date.parse('2026-09-26T00:00:00.000Z');
    let netflowCalls = 0;
    const runtime = makeRuntime({ budget: 2_700, latencyMs: 100, response: (operation) => {
      if (operation === 'TOKEN_SCREENER') return SCREEN;
      netflowCalls += 1;
      const rows = NETFLOW.data.map((row) => row.token_symbol === 'WETH' && netflowCalls >= 7 ? { ...row, net_flow_1h_usd: -23_000 } : row);
      return { ...NETFLOW, data: rows };
    } });
    const session = fakeTimerRuntime(runtime, { maxAttempts: 900, creditCap: 2_700, successTarget: 900 });
    await session.scheduler.start();
    for (let i = 0; i < 432; i += 1) await session.tick();
    session.scheduler.stop('SYNTHETIC_COMPLETE');
    expect(session.scheduler.getState().cycleCount).toBe(433);
    expect(session.manifest.research.successfulHttpRequests).toEqual({ TOKEN_SCREENER: 433, SMART_MONEY_NETFLOW: 433 });
    expect(session.manifest.research.usableResearchSnapshots).toBe(866);
    expect(runtime.ledger.getSnapshot().allocatedCredits).toBe(2_598);
    expect(requests).toHaveLength(866);
    const report = summarizeWethResearchHistory(runtime.store, { now: runtime.clock });
    expect(report).toMatchObject({ mode: 'OFFLINE_WETH_RESEARCH_HISTORY', providerCalls: 0, credentialRead: false, storeMutation: false, outputTruncated: false });
    expect(report.series.tokenScreener.usableWethPriceSamples).toBe(433);
    expect(report.series.smartMoneyNetflow.usableWethNetflowSamples).toBe(433);
    expect(report.comparison.fineReversals).toBe(1); expect(report.comparison.coarseReversals).toBe(1);
    expect(report.comparison.matchedReversals).toBe(1); expect(report.comparison.medianDetectionDelaySeconds).toBeGreaterThan(1_700);
    expect(report.comparison.medianDetectionDelaySeconds).toBeLessThan(1_800);
    expect(report.comparison.uncomparablePeriodsTotal).toBe(0); expect(report.comparison.dataGapsTotal).toBe(0);
    expect(report.comparison.coarseSeries.every((sample) => sample.selectedAt === null || Date.parse(sample.selectedAt) <= Date.parse(sample.bucketAt))).toBe(true);
    expect(JSON.stringify(report)).not.toContain('privateValue'); expect(JSON.stringify(report)).not.toContain('"value":');
    expect(report.series.missingUsdcSpot).toMatchObject({ latestStatus: 'COMPLETE', blocksG2: false });
    const sparse = { getHistoryCount: (key) => key === WETH_RESEARCH_CACHE_KEYS.SMART_MONEY_NETFLOW ? Math.ceil(runtime.store.getHistoryCount(key) / 3) : runtime.store.getHistoryCount(key),
      listHistory: ({ cacheKey, limit }) => { const rows = runtime.store.listHistory({ cacheKey, limit }); return cacheKey === WETH_RESEARCH_CACHE_KEYS.SMART_MONEY_NETFLOW ? rows.filter((_, index) => index % 3 === 0) : rows; } };
    const sparseReport = summarizeWethResearchHistory(sparse, { now: runtime.clock });
    expect(sparseReport.comparison.uncomparablePeriodsTotal).toBeGreaterThan(0); expect(sparseReport.comparison.dataGapsTotal).toBeGreaterThan(0);
  }, 60_000);
  it('matches only the coarse reversal in the same fine episode and records missed oscillation episodes', () => {
    const start = Date.parse('2026-09-26T00:00:00.000Z');
    const samples = [];
    for (let minute = 0; minute <= 60; minute += 5) {
      const sign = minute === 0 ? 'POSITIVE' : minute === 5 ? 'NEGATIVE' : minute <= 30 ? 'POSITIVE' : 'NEGATIVE';
      samples.push({ at: new Date(start + minute * 60_000).toISOString(), value: sign === 'POSITIVE' ? '1' : '-1' });
    }
    const report = summarizeWethResearchHistory(summaryStoreForFlows(samples), { now: () => new Date(start + 60 * 60_000) });
    expect(report.comparison).toMatchObject({
      fineReversals: 3, coarseReversals: 1, matchedReversals: 1, unmatchedFineReversals: 2,
      observedDetectionDelaySeconds: [1_500], medianDetectionDelaySeconds: 1_500,
    });
    expect(report.comparison.coarseSeries.find((sample) => sample.bucketAt === '2026-09-26T00:30:00.000Z'))
      .toMatchObject({ selectedAt: '2026-09-26T00:30:00.000Z', sign: 'POSITIVE' });
    expect(JSON.stringify(report)).not.toContain('"value":');
    expect(JSON.stringify(report)).not.toContain('privateValue');
  });

  it('treats zero netflow as neutral and does not invent zero-crossing reversals', () => {
    const start = Date.parse('2026-09-26T00:00:00.000Z');
    const values = ['1', '0', '-1', '0', '-1', '1'];
    const samples = values.map((value, index) => ({ at: new Date(start + index * 5 * 60_000).toISOString(), value }));
    const report = summarizeWethResearchHistory(summaryStoreForFlows(samples), { now: () => new Date(start + 25 * 60_000) });
    expect(report.comparison).toMatchObject({
      fineReversals: 2, coarseReversals: 0, matchedReversals: 0, unmatchedFineReversals: 2,
      observedDetectionDelaySeconds: [], medianDetectionDelaySeconds: null,
    });
    expect(report.series.smartMoneyNetflow.usableWethNetflowSamples).toBe(6);
    expect(JSON.stringify(report)).not.toContain('"value":');
  });

  it('keeps reversal windows separate across data gaps and unavailable coarse buckets without look-ahead', () => {
    const start = Date.parse('2026-09-26T00:00:00.000Z');
    const gapSamples = [
      { at: new Date(start).toISOString(), value: '1' },
      { at: new Date(start + 5 * 60_000).toISOString(), value: '-1' },
      { at: new Date(start + 30 * 60_000).toISOString(), value: '-1' },
    ];
    const gapReport = summarizeWethResearchHistory(summaryStoreForFlows(gapSamples), { now: () => new Date(start + 30 * 60_000) });
    expect(gapReport.comparison).toMatchObject({ fineReversals: 1, coarseReversals: 1, matchedReversals: 0, unmatchedFineReversals: 1, dataGapsTotal: 1 });

    const unavailableSamples = [
      { at: new Date(start).toISOString(), value: '1' },
      { at: new Date(start + 5 * 60_000).toISOString(), value: '-1' },
      { at: new Date(start + 40 * 60_000).toISOString(), value: '1' },
      { at: new Date(start + 45 * 60_000).toISOString(), value: '-1' },
    ];
    const unavailableReport = summarizeWethResearchHistory(summaryStoreForFlows(unavailableSamples), { now: () => new Date(start + 45 * 60_000) });
    expect(unavailableReport.comparison).toMatchObject({ fineReversals: 2, matchedReversals: 0, unmatchedFineReversals: 2, uncomparablePeriodsTotal: 1, dataGapsTotal: 1 });
    expect(unavailableReport.comparison.coarseSeries.find((sample) => sample.bucketAt === '2026-09-26T00:30:00.000Z'))
      .toMatchObject({ selectedAt: null, sign: 'UNAVAILABLE' });
    expect(unavailableReport.comparison.coarseSeries.every((sample) => sample.selectedAt === null || Date.parse(sample.selectedAt) <= Date.parse(sample.bucketAt))).toBe(true);
  });
});

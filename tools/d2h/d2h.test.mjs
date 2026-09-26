import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NANSEN_COLLECTOR_PLAN, NANSEN_COST_PROFILE_VERSION, NANSEN_OPERATION_COSTS,
  createNansenClient, createNansenCollector, createNansenQueryManager,
  initializeCreditLedger, initializeNansenObservationStore, openCreditLedger,
} from '../../packages/nansen/dist/index.js';
import {
  buildD2hPreview, createD2hRunHooks, createStateIdentity, makeNewRunManifest, publicRunStatus,
  readRunManifest, writeRunManifest,
} from './bounded-session.mjs';
import { prepareResumeProfile } from './collect.mjs';
import { summarizeNansenHistory } from './history-summary.mjs';
import { acquireCollectionLock } from '../d2c/collector-lock.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SCREEN = JSON.parse(readFileSync(new URL('../../packages/nansen/fixtures/token-screener.synthetic.json', import.meta.url), 'utf8'));
const FLOW = JSON.parse(readFileSync(new URL('../../packages/nansen/fixtures/flow-intelligence.synthetic.json', import.meta.url), 'utf8'));
const NETFLOW = JSON.parse(readFileSync(new URL('../../packages/nansen/fixtures/smart-money-netflow.synthetic.json', import.meta.url), 'utf8'));
const directories = [];
const ledgers = [];
const stores = [];
let time;
function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), 'ered-luin-d2h-test-'));
  directories.push(path);
  return path;
}
function responseFor(url) {
  const operation = String(url).endsWith('/token-screener') ? 'TOKEN_SCREENER'
    : String(url).endsWith('/flow-intelligence') ? 'FLOW_INTELLIGENCE' : 'SMART_MONEY_NETFLOW';
  const data = operation === 'TOKEN_SCREENER' ? SCREEN : operation === 'FLOW_INTELLIGENCE' ? FLOW : NETFLOW;
  const credits = NANSEN_OPERATION_COSTS[operation];
  return new Response(JSON.stringify(data), { status: 200, headers: { 'x-nansen-credits-used': String(credits) } });
}
function makeRuntime({ budget = 3_000, fetchResponse = responseFor } = {}) {
  const directory = temporaryDirectory();
  const clock = () => new Date(time.value);
  const ledgerPath = join(directory, 'ledger.sqlite');
  const observationStorePath = join(directory, 'observations.sqlite');
  const ledgerOptions = { databasePath: ledgerPath, budgetId: 'synthetic-d2h-budget', limitCredits: budget, costProfileVersion: NANSEN_COST_PROFILE_VERSION, clock };
  let ledger = initializeCreditLedger(ledgerOptions);
  ledgers.push(ledger);
  const store = initializeNansenObservationStore({ databasePath: observationStorePath, storeId: 'synthetic-d2h-observations', clock });
  stores.push(store);
  const requestUrls = [];
  const fakeFetch = vi.fn(async (url) => {
    requestUrls.push(String(url));
    return fetchResponse(url);
  });
  vi.stubGlobal('fetch', fakeFetch);
  const makeManager = () => {
    const client = createNansenClient({ ledger, enabled: true, apiKey: 'synthetic-only-d2h-test-key', maxPages: 1 });
    return createNansenQueryManager({ client, store, enabled: true, maxPageBound: 1, maxRetryBound: 0, clock });
  };
  let manager = makeManager();
  return {
    directory, ledgerPath, observationStorePath, ledgerOptions, clock, requestUrls, fakeFetch, store,
    get ledger() { return ledger; }, set ledger(value) { ledger = value; ledgers.push(value); },
    get manager() { return manager; }, renewManager() { manager = makeManager(); },
    guardWith(beforeDispatch) { manager = createNansenQueryManager({ client: createNansenClient({ ledger, enabled: true,
      apiKey: 'synthetic-only-d2h-test-key', maxPages: 1 }), store, enabled: true, maxPageBound: 1, maxRetryBound: 0, clock, beforeDispatch }); },
  };
}
function bounds(overrides = {}) {
  return {
    deadlineAt: new Date(time.value + 48 * 60 * 60_000).toISOString(),
    maxAttempts: 2_000, creditCap: 2_000, successTarget: 1_500, reconciledPriorSuccesses: 0,
    ...overrides,
  };
}
function manifestFor(runtime, runBounds = bounds()) {
  return makeNewRunManifest({ bounds: runBounds, stateIdentity: 'a'.repeat(64),
    baselineAllocatedCredits: runtime.ledger.getSnapshot().allocatedCredits, ledger: runtime.ledger.getSnapshot() });
}
function makeHooks(runtime, runBounds = bounds(), manifest = manifestFor(runtime, runBounds), options = {}) {
  let checkpoints = 0;
  const hooks = createD2hRunHooks({ bounds: runBounds, manifest, getLedgerSnapshot: () => runtime.ledger.getSnapshot(),
    costs: NANSEN_OPERATION_COSTS, now: runtime.clock, stopRequested: options.stopRequested ?? (() => false), persist: () => { checkpoints += 1; } });
  return { hooks, manifest, get checkpoints() { return checkpoints; } };
}
function makeFakeScheduler(runtime, runBounds = bounds()) {
  const timers = [];
  const testHooks = makeHooks(runtime, runBounds);
  runtime.guardWith(testHooks.hooks.beforeDispatch);
  let cycleDone = null;
  const scheduler = createNansenCollector({
    manager: runtime.manager, enabled: true, clock: runtime.clock, stopOnFailure: true,
    setTimer(callback, delayMs) { const timer = { callback, delayMs, cancelled: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cancelled = true; },
    beforeQuery: testHooks.hooks.beforeQuery, onQuery: testHooks.hooks.onQuery,
    onCycle() { testHooks.hooks.onCycle(); cycleDone?.(); cycleDone = null; },
  });
  async function tick() {
    const timer = timers.findLast((candidate) => !candidate.cancelled);
    if (!timer) throw new Error('expected next fake scheduler timer');
    let resolve;
    const completed = new Promise((done) => { resolve = done; });
    cycleDone = resolve;
    time.value += timer.delayMs;
    timer.callback();
    await completed;
  }
  return { scheduler, hooks: testHooks.hooks, manifest: testHooks.manifest, timers, tick };
}
beforeEach(() => { time = { value: Date.now() - 60_000 }; });
afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed by restart fixture */ } }
  for (const ledger of ledgers.splice(0)) { try { ledger.close(); } catch { /* already closed by restart fixture */ } }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('D2h bounded collection preparation', () => {
  it('upgrades an interrupted D2l run only through the explicit v2 profile transition', () => {
    const existing = { profile: 'weth-research-v1', successTarget: 700, maxAttempts: 900,
      stats: { providerAttempts: 91, qualifyingSuccesses: 90, actualChargedCredits: 270 } };
    const upgraded = prepareResumeProfile(existing, { profile: 'weth-research-v2', upgradeResearchProfile: true, successTarget: '850' });
    expect(upgraded).toMatchObject({ profile: 'weth-research-v2', successTarget: 850, maxAttempts: 900,
      stats: { providerAttempts: 91, qualifyingSuccesses: 90, actualChargedCredits: 270 } });
    expect(existing).toMatchObject({ profile: 'weth-research-v1', successTarget: 700 });
    expect(() => prepareResumeProfile(existing, { profile: 'weth-research-v2', successTarget: '850' })).toThrow('RESUME_PROFILE_UPGRADE_REQUIRED');
    expect(() => prepareResumeProfile(existing, { profile: 'weth-research-v2', upgradeResearchProfile: true, successTarget: '699' })).toThrow('RESUME_SUCCESS_TARGET_INVALID');
    expect(() => prepareResumeProfile(existing, { profile: 'weth-research-v2', upgradeResearchProfile: true, successTarget: '901' })).toThrow('RESUME_SUCCESS_TARGET_INVALID');
    expect(() => prepareResumeProfile(existing, { profile: 'default-v1', upgradeResearchProfile: true, successTarget: '850' })).toThrow('RESUME_NOT_ALLOWED');
  });

  it('previews the natural cadence with no side effects and no implicit spend caps', () => {
    const preview = buildD2hPreview({ plan: NANSEN_COLLECTOR_PLAN, costs: NANSEN_OPERATION_COSTS, now: new Date(time.value) });
    expect(preview).toMatchObject({ mode: 'DRY_RUN', providerCalls: 0, credentialRead: false, persistentWrite: false, timerScheduled: false,
      cadence: { callsPerHour: 26, creditsPerHour: 34 },
      requested: { deadlineAt: null, maxAttempts: null, creditCap: null, successTarget: null, reconciledPriorSuccesses: null, totalSuccessTarget: null } });
    expect(preview.plan.map((entry) => entry.refreshMinutes)).toEqual([5, 5, 30]);
    expect(preview.missingInputs).toHaveLength(5);
    expect(JSON.stringify(preview)).not.toMatch(/20,?000|40,?100/u);

    const cli = spawnSync(process.execPath, [join(ROOT, 'tools/d2h/collect.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 15_000 });
    expect(cli.status).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({ mode: 'DRY_RUN', providerCalls: 0, credentialRead: false, persistentWrite: false, timerScheduled: false });
  });

  it('serves canonical cache hits without increasing provider attempts or useful successes', async () => {
    const runtime = makeRuntime();
    const collection = makeFakeScheduler(runtime, bounds());
    expect(await collection.scheduler.start()).toBe(true);
    expect(collection.manifest.stats).toMatchObject({ providerAttempts: 3, qualifyingSuccesses: 3, cacheHits: 0, actualChargedCredits: 7 });
    collection.scheduler.stop();
    expect(await collection.scheduler.start()).toBe(true);
    expect(runtime.requestUrls).toHaveLength(3);
    expect(collection.manifest.stats).toMatchObject({ providerAttempts: 3, qualifyingSuccesses: 3, cacheHits: 3, actualChargedCredits: 7 });
    collection.scheduler.stop();
  });

  it('simulates a 42-hour natural-cadence rehearsal in fake time and stops at 1,100 fresh successes', async () => {
    const start = time.value;
    const runtime = makeRuntime({ budget: 2_500 });
    const runBounds = bounds({ deadlineAt: new Date(start + 43 * 60 * 60_000).toISOString(), maxAttempts: 1_100,
      creditCap: 1_500, successTarget: 1_100 });
    const collection = makeFakeScheduler(runtime, runBounds);
    expect(await collection.scheduler.start()).toBe(true);
    let cycles = 0;
    while (collection.scheduler.getState().running) {
      await collection.tick();
      cycles += 1;
      if (cycles > 600) throw new Error('synthetic cadence rehearsal did not reach its bounded target');
    }
    const elapsedMs = time.value - start;
    expect(elapsedMs).toBe(42 * 60 * 60_000 + 15 * 60_000);
    expect(collection.scheduler.getState().stopReason).toBe('SUCCESS_TARGET_REACHED');
    expect(collection.manifest.stats).toMatchObject({ providerAttempts: 1_100, qualifyingSuccesses: 1_100, cacheHits: 0,
      actualChargedCredits: 1_440, unknownChargeAttempts: 0, failedQueries: 0 });
    expect(runtime.ledger.getSnapshot()).toMatchObject({ allocatedCredits: 1_440, pendingAttemptCount: 0, reconciliationRequired: false });
    expect(runtime.fakeFetch).toHaveBeenCalledTimes(1_100);

    const summary = summarizeNansenHistory(runtime.store, { now: runtime.clock });
    expect(summary).toMatchObject({ mode: 'OFFLINE_HISTORY_SUMMARY', providerCalls: 0, credentialRead: false, storeMutation: false });
    expect(summary.snapshotsByOperation.TOKEN_SCREENER).toBeGreaterThan(500);
    expect(summary.snapshotsByOperation.FLOW_INTELLIGENCE).toBeGreaterThan(500);
    expect(summary.snapshotsByOperation.SMART_MONEY_NETFLOW).toBeGreaterThan(80);
    expect(JSON.stringify(summary)).not.toContain('synthetic-only-d2h-test-key');
    expect(JSON.stringify(summary)).not.toContain('23000000000');
  }, 60_000);

  it('enforces attempt and credit caps again inside the query manager before provider dispatch', async () => {
    const attemptRuntime = makeRuntime();
    const attemptBounds = bounds({ maxAttempts: 1 });
    const attemptRun = makeHooks(attemptRuntime, attemptBounds);
    attemptRuntime.guardWith(attemptRun.hooks.beforeDispatch);
    const first = await attemptRuntime.manager.query(NANSEN_COLLECTOR_PLAN[0].query);
    expect(attemptRun.hooks.onQuery(NANSEN_COLLECTOR_PLAN[0].query, first)).toBe('ATTEMPT_CAP_REACHED');
    const deniedAttempt = await attemptRuntime.manager.query(NANSEN_COLLECTOR_PLAN[1].query);
    expect(deniedAttempt.failure?.code).toBe('DISABLED');
    expect(attemptRun.hooks.onQuery(NANSEN_COLLECTOR_PLAN[1].query, deniedAttempt)).toBe('ATTEMPT_CAP_REACHED');
    expect(attemptRuntime.fakeFetch).toHaveBeenCalledTimes(1);

    const creditRuntime = makeRuntime();
    const creditBounds = bounds({ creditCap: 1 });
    const creditRun = makeHooks(creditRuntime, creditBounds);
    creditRuntime.guardWith(creditRun.hooks.beforeDispatch);
    const credited = await creditRuntime.manager.query(NANSEN_COLLECTOR_PLAN[0].query);
    expect(creditRun.hooks.onQuery(NANSEN_COLLECTOR_PLAN[0].query, credited)).toBe('CREDIT_CAP_REACHED');
    const deniedCredit = await creditRuntime.manager.query(NANSEN_COLLECTOR_PLAN[1].query);
    expect(deniedCredit.failure?.code).toBe('DISABLED');
    expect(creditRun.hooks.onQuery(NANSEN_COLLECTOR_PLAN[1].query, deniedCredit)).toBe('CREDIT_CAP_REACHED');
    expect(creditRuntime.fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('stops after one rate-limited or uncertain attempt and never retries', async () => {
    const rateLimitedRuntime = makeRuntime({ fetchResponse: async (url) => {
      const response = responseFor(url);
      return new Response(await response.text(), { status: 429, headers: { 'x-nansen-credits-used': '1' } });
    } });
    const rateCollection = makeFakeScheduler(rateLimitedRuntime, bounds());
    expect(await rateCollection.scheduler.start()).toBe(true);
    expect(rateLimitedRuntime.fakeFetch).toHaveBeenCalledTimes(1);
    expect(rateCollection.scheduler.getState().stopReason).toBe('RATE_LIMITED');

    const uncertainRuntime = makeRuntime({ fetchResponse: async () => { throw new Error('synthetic transport interruption'); } });
    const uncertainCollection = makeFakeScheduler(uncertainRuntime, bounds());
    expect(await uncertainCollection.scheduler.start()).toBe(true);
    expect(uncertainRuntime.fakeFetch).toHaveBeenCalledTimes(1);
    expect(uncertainCollection.scheduler.getState().stopReason).toBe('UNKNOWN_CHARGE_REQUIRES_RECONCILIATION');
    expect(uncertainCollection.manifest.stats.unknownChargeAttempts).toBe(1);
  });

  it('keeps interrupted ledger reservations across reopen and refuses an unreconciled dispatch', async () => {
    const runtime = makeRuntime();
    const priorManifest = manifestFor(runtime, bounds());
    runtime.ledger.reserveAttempt({ attemptId: randomUUID(), operation: 'TOKEN_SCREENER', requestFingerprint: createHash('sha256').update('synthetic interrupted request').digest('hex') });
    runtime.ledger.close();
    runtime.ledger = openCreditLedger(runtime.ledgerOptions);
    runtime.renewManager();
    const hooks = makeHooks(runtime, bounds(), priorManifest);
    runtime.guardWith(hooks.hooks.beforeDispatch);
    expect(runtime.ledger.getSnapshot()).toMatchObject({ allocatedCredits: 1, pendingAttemptCount: 1 });
    const result = await runtime.manager.query(NANSEN_COLLECTOR_PLAN[0].query);
    expect(result.failure?.code).toBe('DISABLED');
    expect(hooks.hooks.onQuery(NANSEN_COLLECTOR_PLAN[0].query, result)).toBe('RECONCILIATION_REQUIRED');
    expect(runtime.fakeFetch).not.toHaveBeenCalled();
  });

  it('resumes only after explicit reconciliation clears an unknown charge, without dispatching past the cap', () => {
    const directory = temporaryDirectory();
    const ledgerPath = join(directory, 'ledger.sqlite');
    const observationStorePath = join(directory, 'observations.sqlite');
    const budgetId = 'synthetic-d2h-resume-budget';
    const observationStoreId = 'synthetic-d2h-resume-observations';
    const ledgerOptions = { databasePath: ledgerPath, budgetId, limitCredits: 7, costProfileVersion: NANSEN_COST_PROFILE_VERSION };
    const ledger = initializeCreditLedger(ledgerOptions);
    ledgers.push(ledger);
    const store = initializeNansenObservationStore({ databasePath: observationStorePath, storeId: observationStoreId });
    stores.push(store);
    const runBounds = bounds({ maxAttempts: 1, creditCap: 7, successTarget: 1 });
    const stateIdentity = createStateIdentity({ ledgerPath, budgetId, costProfileVersion: NANSEN_COST_PROFILE_VERSION,
      observationStorePath, observationStoreId });
    const manifest = makeNewRunManifest({ bounds: runBounds, stateIdentity, baselineAllocatedCredits: 0, ledger: ledger.getSnapshot() });
    manifest.status = 'FAILED';
    // A failed manifest may retain a PID that has since been reused by an unrelated live process.
    // The shared observation-store lock, not that stale PID, governs whether a resume can proceed.
    manifest.pid = process.pid;
    manifest.stopReason = 'UNKNOWN_CHARGE_REQUIRES_RECONCILIATION';
    manifest.stats.providerAttempts = 1;
    manifest.stats.unknownChargeAttempts = 1;
    manifest.stats.lastEndpoint = 'TOKEN_SCREENER';
    const manifestPath = join(directory, 'run-manifest.json');
    writeRunManifest(manifestPath, ROOT, manifest, { createOnly: true });

    const attemptId = randomUUID();
    ledger.reserveAttempt({ attemptId, operation: 'TOKEN_SCREENER', requestFingerprint: createHash('sha256').update('synthetic uncertain charge').digest('hex') });
    ledger.recordTerminalResult({ attemptId, outcome: 'TRANSPORT_ERROR', chargedCredits: null });

    const example = JSON.parse(readFileSync(new URL('../d2c/local-config.example.json', import.meta.url), 'utf8'));
    Object.assign(example.environment, {
      NANSEN_API_ENABLED: 'true', NANSEN_CREDIT_BUDGET: '7', NANSEN_COLLECTION_REVIEWED: 'true', NANSEN_COLLECTION_ENABLED: 'true',
      NANSEN_LEDGER_PATH: ledgerPath, NANSEN_LEDGER_BUDGET_ID: budgetId, NANSEN_LEDGER_LIMIT_CREDITS: '7',
      NANSEN_OBSERVATION_STORE_PATH: observationStorePath, NANSEN_OBSERVATION_STORE_ID: observationStoreId,
    });
    const configPath = join(directory, 'd2c-local.json');
    writeFileSync(configPath, JSON.stringify(example));
    expect(ledger.listUnknownChargeAttempts()).toHaveLength(1);
    ledger.close();
    store.close();

    const newManifestPath = join(directory, 'new-run-manifest.json');
    const bypass = spawnSync(process.execPath, [join(ROOT, 'tools/d2h/collect.mjs'), 'start', '--config', configPath, '--manifest', newManifestPath,
      '--duration-minutes', '60', '--max-attempts', '1', '--credit-cap', '7', '--success-target', '1', '--reconciled-prior-successes', '0'],
    { cwd: ROOT, encoding: 'utf8', timeout: 15_000, env: { ...process.env, NANSEN_API_KEY: 'synthetic-only-d2h-test-key' } });
    expect(bypass.status).toBe(1);
    expect(bypass.stderr).toContain('LEDGER_RECONCILIATION_REQUIRED');
    expect(existsSync(newManifestPath)).toBe(false);

    const reconciler = openCreditLedger(ledgerOptions);
    ledgers.push(reconciler);
    expect(reconciler.listUnknownChargeAttempts()).toHaveLength(1);
    reconciler.reconcileUnknownCharge({ attemptId, chargedCredits: 1 });
    expect(reconciler.listUnknownChargeAttempts()).toEqual([]);
    reconciler.close();

    const result = spawnSync(process.execPath, [join(ROOT, 'tools/d2h/collect.mjs'), 'resume', '--config', configPath, '--manifest', manifestPath,
      '--reconciled', '--reconciled-attempts', '1', '--reconciled-successes', '0', '--reconciled-credits', '1', '--reconciled-unknown-charges', '0'],
    { cwd: ROOT, encoding: 'utf8', timeout: 15_000, env: { ...process.env, NANSEN_API_KEY: 'synthetic-only-d2h-test-key' } });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ATTEMPT_CAP_REACHED');
    expect(result.stdout).not.toContain('synthetic-only-d2h-test-key');
    expect(readRunManifest(manifestPath, ROOT)).toMatchObject({ status: 'STOPPED', stopReason: 'ATTEMPT_CAP_REACHED',
      stats: { providerAttempts: 1, qualifyingSuccesses: 0, actualChargedCredits: 1, unknownChargeAttempts: 0 } });
  });

  it('uses one shared process lock, requires stale-lock recovery to be explicit, and persists redacted checkpoints', () => {
    const directory = temporaryDirectory();
    const observationStorePath = join(directory, 'observations.sqlite');
    writeFileSync(observationStorePath, 'synthetic observation store');
    const lock = acquireCollectionLock(observationStorePath, { runId: 'synthetic-d2h-run' });
    expect(() => acquireCollectionLock(observationStorePath, { runId: 'synthetic-d2c-run' })).toThrow('COLLECTION_ALREADY_RUNNING');
    lock.release();
    const next = acquireCollectionLock(observationStorePath, { runId: 'synthetic-d2c-run' });
    next.release();

    const stalePath = observationStorePath + '.collector.lock';
    writeFileSync(stalePath, JSON.stringify({ schemaVersion: 1, runId: 'old-run', pid: 2_147_483_647, startedAt: new Date().toISOString(), nonce: 'old-nonce' }));
    expect(() => acquireCollectionLock(observationStorePath, { runId: 'resumed-run' })).toThrow('COLLECTION_LOCK_STALE_REQUIRES_RECONCILIATION');
    const recovered = acquireCollectionLock(observationStorePath, { runId: 'resumed-run', recoverStale: true });
    recovered.release();

    const runtime = makeRuntime();
    const stateIdentity = createStateIdentity({ ledgerPath: runtime.ledgerPath, budgetId: 'synthetic-d2h-budget', costProfileVersion: NANSEN_COST_PROFILE_VERSION,
      observationStorePath: runtime.observationStorePath, observationStoreId: 'synthetic-d2h-observations' });
    const checkpoint = makeNewRunManifest({ bounds: bounds(), stateIdentity, baselineAllocatedCredits: 0, ledger: runtime.ledger.getSnapshot() });
    const checkpointPath = join(directory, 'run-manifest.json');
    writeRunManifest(checkpointPath, ROOT, checkpoint, { createOnly: true });
    const readBack = readRunManifest(checkpointPath, ROOT);
    expect(publicRunStatus(readBack, false)).toMatchObject({ state: 'RUNNING', reconciliationRequired: false });
    const persisted = readFileSync(checkpointPath, 'utf8');
    expect(persisted).not.toContain(directory);
    expect(persisted).not.toContain('synthetic-only-d2h-test-key');
    expect(persisted).not.toContain('NANSEN_API_KEY');
  });

  it('replays WETH signal direction, freshness and current G2 paper policy from offline history', () => {
    const firstAt = new Date(time.value - 10 * 60_000).toISOString();
    const secondAt = new Date(time.value - 5 * 60_000).toISOString();
    const values = [
      { at: firstAt, flow: '500000', price: '2000000' },
      { at: secondAt, flow: '-1', price: '2100000' },
    ];
    const operations = ['TOKEN_SCREENER', 'FLOW_INTELLIGENCE', 'SMART_MONEY_NETFLOW'];
    const histories = new Map(operations.map((operation) => [operation, values.map((entry) => ({
      snapshotId: randomUUID(), cacheKey: createHash('sha256').update(operation).digest('hex'), operation,
      asset: operation === 'FLOW_INTELLIGENCE' ? 'WETH' : 'BASE_PAIR', timeframe: '1h', pageBound: 1, retryBound: 0,
      source: 'nansen', fetchedAt: entry.at, acquiredAt: entry.at, expiresAt: new Date(Date.parse(entry.at) + 60_000).toISOString(),
      completeness: 'complete', failure: null, pageReferences: [], unavailableFields: [],
      signals: operation === 'TOKEN_SCREENER' ? [
        { signalId: randomUUID(), provider: 'nansen', endpoint: operation, chainId: 8453, asset: 'USDC', metric: 'price_usd', observedAt: entry.at, fetchedAt: entry.at, quality: 'COMPLETE', value: '1000000', unit: 'usd_micros', provenanceId: 'synthetic-d2h-summary-test' },
        { signalId: randomUUID(), provider: 'nansen', endpoint: operation, chainId: 8453, asset: 'WETH', metric: 'price_usd', observedAt: entry.at, fetchedAt: entry.at, quality: 'COMPLETE', value: entry.price, unit: 'usd_micros', provenanceId: 'synthetic-d2h-summary-test' },
      ] : operation === 'FLOW_INTELLIGENCE' ? [
        { signalId: randomUUID(), provider: 'nansen', endpoint: operation, chainId: 8453, asset: 'WETH', metric: 'smart_trader_net_flow_usd', observedAt: entry.at, fetchedAt: entry.at, quality: 'COMPLETE', value: '1000000', unit: 'usd_micros', provenanceId: 'synthetic-d2h-summary-test' },
      ] : [
        { signalId: randomUUID(), provider: 'nansen', endpoint: operation, chainId: 8453, asset: 'WETH', metric: 'net_flow_1h_usd', observedAt: entry.at, fetchedAt: entry.at, quality: 'COMPLETE', value: entry.flow, unit: 'usd_micros', provenanceId: 'synthetic-d2h-summary-test' },
      ],
    }))]));
    const fakeStore = {
      getLatestSnapshots: () => [...histories.values()].map((history) => history.at(-1)),
      listHistory: ({ cacheKey, limit }) => {
        expect(limit).toBe(1_024);
        return [...histories.values()].flat().filter((snapshot) => snapshot.cacheKey === cacheKey).reverse();
      },
    };
    const summary = summarizeNansenHistory(fakeStore, { now: () => new Date(time.value) });
    expect(summary.timeline).toHaveLength(2);
    expect(summary.timeline[0].freshness.TOKEN_SCREENER.fresh).toBe(true);
    expect(summary.timeline[0].wethSignals.find((item) => item.metric === 'net_flow_1h_usd')).toMatchObject({ sign: 'POSITIVE', change: 'UNAVAILABLE' });
    expect(summary.timeline[0].policy.status).toBe('ALLOW');
    expect(summary.timeline[1].wethSignals.find((item) => item.metric === 'net_flow_1h_usd')).toMatchObject({ sign: 'NEGATIVE', change: 'DECREASED' });
    expect(summary.timeline[1].policy.status).toBe('BLOCK');
    expect(summary.timeline[1].policy.reasons).toContain('NONPOSITIVE_WETH_NETFLOW');
    expect(JSON.stringify(summary)).not.toContain('500000');
  });

  it('does not read credentials or create a manifest when external collection review gates are off', () => {
    const directory = temporaryDirectory();
    const example = JSON.parse(readFileSync(new URL('../d2c/local-config.example.json', import.meta.url), 'utf8'));
    const configPath = join(directory, 'd2c-local.json');
    const manifestPath = join(directory, 'run-manifest.json');
    writeFileSync(configPath, JSON.stringify(example));
    const result = spawnSync(process.execPath, [join(ROOT, 'tools/d2h/collect.mjs'), 'start', '--config', configPath, '--manifest', manifestPath,
      '--duration-minutes', '60', '--max-attempts', '3', '--credit-cap', '7', '--success-target', '3', '--reconciled-prior-successes', '0'],
    { cwd: ROOT, encoding: 'utf8', timeout: 15_000, env: { ...process.env, NANSEN_API_KEY: undefined } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('COLLECTION_REQUIRES_SEPARATE_REVIEW_AND_EXPLICIT_ENABLEMENT');
    expect(existsSync(manifestPath)).toBe(false);
    expect(result.stderr).not.toContain(configPath);
  });
});
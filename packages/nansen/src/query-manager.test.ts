import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizedSignalSchema } from '@ered-luin/contracts';
import {
  BASE_ASSET_ADDRESSES, NANSEN_COST_PROFILE_VERSION, buildG1DEvidencePacket, createNansenClient, createNansenQueryManager,
  estimateWorstCaseCredits, initializeCreditLedger, initializeNansenObservationStore,
  isWithinSignalFreshness, openCreditLedger, openNansenObservationStore,
  projectScheduledCollection, usdToMicros, type LedgerOptions, type ManagedQueryDiagnostic, type NansenCreditLedger,
  type NansenHttpRequest, type NansenHttpResponse, type NansenHttpTransport,
  type NansenManagedQuery, type NansenObservationStore,
} from './index.js';

const screener = JSON.parse(readFileSync(new URL('../fixtures/token-screener.synthetic.json', import.meta.url), 'utf8')) as unknown;
const flow = JSON.parse(readFileSync(new URL('../fixtures/flow-intelligence.synthetic.json', import.meta.url), 'utf8')) as unknown;
const netflow = JSON.parse(readFileSync(new URL('../fixtures/smart-money-netflow.synthetic.json', import.meta.url), 'utf8')) as unknown;
const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'observation-store-worker.mjs');
const SCREEN_QUERY = Object.freeze({ operation: 'TOKEN_SCREENER', asset: 'BASE_PAIR', timeframe: '1h', pageBound: 1, retryBound: 0, perPage: 100 } as const satisfies NansenManagedQuery);
const FLOW_QUERY = Object.freeze({ operation: 'FLOW_INTELLIGENCE', asset: 'WETH', timeframe: '1h', pageBound: 1, retryBound: 0, perPage: 1 } as const satisfies NansenManagedQuery);
const NETFLOW_QUERY = Object.freeze({ operation: 'SMART_MONEY_NETFLOW', asset: 'BASE_PAIR', timeframe: '1h', pageBound: 1, retryBound: 0, perPage: 100 } as const satisfies NansenManagedQuery);
type Reply = NansenHttpResponse | Error | ((request: NansenHttpRequest) => Promise<NansenHttpResponse>);
let root: string;
let timeMs: number;
let ledgers: NansenCreditLedger[];
let stores: NansenObservationStore[];

function response(body: unknown, status = 200, credits = 1): NansenHttpResponse {
  return { status, headers: { 'X-Nansen-Credits-Used': String(credits) }, body: new TextEncoder().encode(JSON.stringify(body)) };
}
function transportQueue(replies: Reply[] = []) {
  const requests: NansenHttpRequest[] = [];
  const transport: NansenHttpTransport = async (request) => {
    requests.push(request);
    const reply = replies.shift();
    if (reply === undefined) throw new Error('synthetic reply queue exhausted');
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'function') return reply(request);
    return reply;
  };
  return { transport, requests };
}
function env(transport: NansenHttpTransport, options: { budget?: number; maxPages?: number; maxRetries?: number; enabled?: boolean; onDiagnostic?: (diagnostic: ManagedQueryDiagnostic) => void } = {}) {
  const clock = () => new Date(timeMs);
  const ledgerOptions: LedgerOptions = {
    databasePath: join(root, `ledger-${ledgers.length}.sqlite`), budgetId: `synthetic-${ledgers.length}`,
    limitCredits: options.budget ?? 100, costProfileVersion: NANSEN_COST_PROFILE_VERSION, clock,
  };
  const ledger = initializeCreditLedger(ledgerOptions); ledgers.push(ledger);
  const storePath = join(root, `observations-${stores.length}.sqlite`);
  const storeId = `synthetic-store-${stores.length}`;
  const store = initializeNansenObservationStore({ databasePath: storePath, storeId, clock }); stores.push(store);
  const client = createNansenClient({ ledger, enabled: true, apiKey: 'synthetic-only-test-key', transport, maxPages: options.maxPages ?? 2 });
  const manager = createNansenQueryManager({
    client, store, enabled: options.enabled ?? true,
    maxPageBound: options.maxPages ?? 2, maxRetryBound: options.maxRetries ?? 1, clock,
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
  });
  return { ledger, ledgerOptions, store, storePath, storeId, client, manager, clock };
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ered-luin-g1c-')); timeMs = Date.parse('2026-09-23T12:00:00.000Z'); ledgers = []; stores = []; });
afterEach(() => {
  for (const store of stores) { try { store.close(); } catch { /* test may close it before reopen */ } }
  for (const ledger of ledgers) { try { ledger.close(); } catch { /* test may close it before reopen */ } }
  rmSync(root, { recursive: true, force: true });
});

describe('G1c query management and observation persistence', () => {
  it('maps the normal G1c result triplet into G1d evidence with WETH flow', async () => {
    const fake = transportQueue([response(screener), response(flow), response(netflow, 200, 5)]);
    const test = env(fake.transport);
    const results = [
      await test.manager.query(SCREEN_QUERY),
      await test.manager.query(FLOW_QUERY),
      await test.manager.query(NETFLOW_QUERY),
    ];
    const storedSignals = test.store.getLatestSignals();
    expect(storedSignals).toHaveLength(7);
    expect(storedSignals.every((signal) => signal.provider === 'synthetic')).toBe(true);
    expect(test.store.getLatestSnapshots('nansen')).toHaveLength(0);
    expect(test.store.getLatestSnapshots('synthetic')).toHaveLength(3);
    const packet = buildG1DEvidencePacket(results, { now: new Date(timeMs) });
    const flowFeature = packet.features.find((feature) =>
      feature.endpoint === 'FLOW_INTELLIGENCE' && feature.asset === 'WETH');

    expect(fake.requests).toHaveLength(3);
    expect(results.map((result) => result.asset)).toEqual(['BASE_PAIR', 'WETH', 'BASE_PAIR']);
    expect(packet.inputs).toHaveLength(3);
    expect(packet.issues).not.toContain('INVALID_RESULT');
    expect(packet.eligibility).toBe('INELIGIBLE');
    expect(flowFeature).toMatchObject({ source: 'synthetic', completeness: 'complete' });
    expect(flowFeature?.valueMicros).toBe('12000000000');
  });
  it('rejects an observation database path inside the repository', () => {
    expect(() => initializeNansenObservationStore({ databasePath: join(process.cwd(), 'g1c-forbidden.sqlite'), storeId: 'forbidden-store' }))
      .toThrowError(expect.objectContaining({ code: 'DATABASE_PATH_INVALID' }));
  });
  it('keeps manager requests disabled by default and ledger denial before transport', async () => {
    const fake = transportQueue([response(screener)]);
    const test = env(fake.transport, { budget: 0, enabled: false });
    const disabled = await createNansenQueryManager({ client: test.client, store: test.store, clock: test.clock }).query(SCREEN_QUERY);
    expect(disabled.status).toBe('disabled');
    expect(disabled.failure?.code).toBe('DISABLED');
    expect(fake.requests).toHaveLength(0);
    const noCredits = await createNansenQueryManager({ client: test.client, store: test.store, enabled: true, clock: test.clock }).query(SCREEN_QUERY);
    expect(noCredits.failure).toMatchObject({ code: 'RESERVATION_DENIED', ledgerCode: 'BUDGET_EXHAUSTED' });
    expect(fake.requests).toHaveLength(0);
    expect(test.ledger.getSnapshot()).toMatchObject({ allocatedCredits: 0, pendingAttemptCount: 0 });
  });

  it('derives synthetic provenance from an injected fake transport when manager source is omitted', async () => {
    const fake = transportQueue([response(screener)]);
    const test = env(fake.transport);
    const defaultManager = createNansenQueryManager({ client: test.client, store: test.store, enabled: true, clock: test.clock });
    const result = await defaultManager.query(SCREEN_QUERY);
    const snapshot = test.store.listHistory({ cacheKey: result.cacheKey })[0];
    expect(fake.requests).toHaveLength(1);
    expect(result.source).toBe('synthetic');
    expect(result.qualifyingSuccessfulRequests).toBe(0);
    expect(result.observations.every((signal) => signal.provider === 'synthetic')).toBe(true);
    expect(snapshot?.source).toBe('synthetic');
    expect(snapshot?.signals.every((signal) => signal.provider === 'synthetic')).toBe(true);
  });

  it('retains dispatched attempt references when observation persistence fails', async () => {
    let closeStore: () => void = () => {};
    const fake = transportQueue([async () => { closeStore(); return response(screener, 200, 1); }]);
    const test = env(fake.transport);
    closeStore = () => test.store.close();
    const result = await test.manager.query(SCREEN_QUERY);
    const reference = result.pageReferences[0];
    const attempt = reference ? test.ledger.getAttempt(reference.attemptId) : null;
    expect(fake.requests).toHaveLength(1);
    expect(result).toMatchObject({
      status: 'failed', source: 'synthetic', operation: 'TOKEN_SCREENER', storeError: 'STORE_FAILURE',
      completeness: 'incomplete', quality: 'MISSING', cacheHit: false, qualifyingSuccessfulRequests: 0,
      observations: [],
    });
    expect(result.fetchedAt).not.toBeNull();
    expect(result.acquiredAt).not.toBeNull();
    expect(result.pageReferences).toHaveLength(1);
    expect(reference).toMatchObject({ page: 1, retry: 0, received: true, status: 200, chargedCredits: 1 });
    expect(attempt).toMatchObject({
      attemptId: reference?.attemptId, operation: 'TOKEN_SCREENER', reservedCredits: 1,
      outcome: 'SUCCESS', httpStatus: 200, reportedChargedCredits: 1,
    });
    expect(attempt?.completedAt).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain('synthetic-only-test-key');
  });

  it('coalesces concurrent identical misses, then serves a cache hit without new allocation', async () => {
    let finish!: (value: NansenHttpResponse) => void;
    let entered!: () => void;
    const hasEntered = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<NansenHttpResponse>((resolve) => { finish = resolve; });
    const fake = transportQueue([() => { entered(); return gate; }]);
    const test = env(fake.transport);
    const first = test.manager.query(SCREEN_QUERY);
    await hasEntered;
    const second = test.manager.query(SCREEN_QUERY);
    finish(response(screener));
    const [one, two] = await Promise.all([first, second]);
    expect(fake.requests).toHaveLength(1);
    expect(one.quality).toBe('COMPLETE');
    expect(two.coalesced).toBe(true);
    expect(one.attemptPageReferences).toEqual(one.pageReferences);
    expect(two.attemptPageReferences).toEqual([]);
    expect(test.ledger.getSnapshot()).toMatchObject({ allocatedCredits: 1, reportedChargeCount: 1 });
    const cached = await test.manager.query(SCREEN_QUERY);
    expect(cached.cacheHit).toBe(true);
    expect(cached.status).toBe('cached');
    expect(cached.attemptPageReferences).toEqual([]);
    expect(cached.observations.find((signal) => signal.metric === 'price_usd' && signal.asset === 'WETH')?.value).toBe('3200000000');
    expect(fake.requests).toHaveLength(1);
    expect(test.ledger.getSnapshot().allocatedCredits).toBe(1);
    expect(cached.observations.every((signal) => normalizedSignalSchema.safeParse(signal).success)).toBe(true);
  });

  it('honors page bounds and reserves each page through G1a', async () => {
    const first = structuredClone(screener) as { pagination: { page: number; is_last_page: boolean } };
    first.pagination.page = 1; first.pagination.is_last_page = false;
    const second = structuredClone(screener) as { data: unknown[]; pagination: { page: number; is_last_page: boolean } };
    second.data = [];
    second.pagination.page = 2; second.pagination.is_last_page = true;
    const fake = transportQueue([response(first), response(second)]);
    const test = env(fake.transport, { maxPages: 2 });
    const q = { ...SCREEN_QUERY, pageBound: 2 } as const;
    const result = await test.manager.query(q);
    expect(fake.requests).toHaveLength(2);
    expect(JSON.parse(fake.requests[0]!.body).pagination.page).toBe(1);
    expect(JSON.parse(fake.requests[1]!.body).pagination.page).toBe(2);
    expect(result.pageReferences).toHaveLength(2);
    expect(result.attemptPageReferences).toEqual(result.pageReferences);
    expect(result.quality).toBe('COMPLETE');
    expect(test.ledger.getSnapshot()).toMatchObject({ allocatedCredits: 2, reportedChargeCount: 2 });
    expect(estimateWorstCaseCredits({ ...q, retryBound: 1 })).toBe(4);
  });

  it('retries only a dispatched transport failure and reserves a fresh attempt', async () => {
    const fake = transportQueue([new Error('private raw provider text'), response(screener)]);
    const test = env(fake.transport, { maxRetries: 1 });
    const q = { ...SCREEN_QUERY, retryBound: 1 } as const;
    const result = await test.manager.query(q);
    expect(fake.requests).toHaveLength(2);
    expect(result.quality).toBe('COMPLETE');
    expect(result.pageReferences.map((ref) => ref.attemptId)).toHaveLength(2);
    expect(new Set(result.pageReferences.map((ref) => ref.attemptId)).size).toBe(2);
    expect(test.ledger.getSnapshot()).toMatchObject({ allocatedCredits: 2, reportedChargeCount: 1, pendingAttemptCount: 0 });
  });
  it('keeps zero distinct from missing and partial metrics', async () => {
    const zeroData = structuredClone(netflow) as { data: Array<Record<string, unknown>> };
    zeroData.data[1]!.net_flow_1h_usd = 0;
    const zeroFake = transportQueue([response(zeroData, 200, 5)]);
    const zeroEnv = env(zeroFake.transport);
    const zero = await zeroEnv.manager.query(NETFLOW_QUERY);
    const wethZero = zero.observations.find((signal) => signal.asset === 'WETH');
    expect(wethZero).toMatchObject({ quality: 'COMPLETE', value: '0', unit: 'usd_micros' });

    const partialData = structuredClone(netflow) as { data: Array<Record<string, unknown>> };
    delete partialData.data[1]!.net_flow_1h_usd;
    const partialEnv = env(transportQueue([response(partialData, 200, 5)]).transport);
    const partial = await partialEnv.manager.query({ ...NETFLOW_QUERY, perPage: 99 });
    expect(partial.observations.find((signal) => signal.asset === 'WETH')).toMatchObject({ quality: 'PARTIAL', value: null });

    const missingData = structuredClone(netflow) as { data: Array<Record<string, unknown>> };
    missingData.data = [missingData.data[0]!];
    const missingEnv = env(transportQueue([response(missingData, 200, 5)]).transport);
    const missing = await missingEnv.manager.query({ ...NETFLOW_QUERY, perPage: 98 });
    expect(missing.observations.find((signal) => signal.asset === 'WETH')).toMatchObject({ quality: 'MISSING', value: null });
    const duplicateData = structuredClone(netflow) as { data: Array<Record<string, unknown>> };
    duplicateData.data.push({ ...duplicateData.data[1]! });
    const duplicateEnv = env(transportQueue([response(duplicateData, 200, 5)]).transport);
    const duplicate = await duplicateEnv.manager.query({ ...NETFLOW_QUERY, perPage: 97 });
    expect(duplicate.observations.find((signal) => signal.asset === 'WETH')).toMatchObject({ quality: 'PARTIAL', value: null });
    const flowResult = await env(transportQueue([response(flow)]).transport).manager.query(FLOW_QUERY);
    expect(flowResult.completeness).toBe('complete');
    expect(flowResult.quality).toBe('COMPLETE');
    expect(flowResult.observations[0]).toMatchObject({ quality: 'COMPLETE', value: '12000000000' });
    expect(zeroEnv.ledger.getSnapshot().allocatedCredits).toBe(5);
  });

  it.each([
    ['absent', 'absent'],
    ['null', 'null'],
    ['malformed', 'invalid'],
  ] as const)('keeps a warning-free flow response page-complete when WETH smart-trader flow is %s', async (shape, expectedState) => {
    const payload = structuredClone(flow) as { data: Array<Record<string, unknown>> };
    if (shape === 'absent') delete payload.data[0]!.smart_trader_net_flow_usd;
    else if (shape === 'null') payload.data[0]!.smart_trader_net_flow_usd = null;
    else payload.data[0]!.smart_trader_net_flow_usd = 'private-malformed-value';
    const diagnostics: ManagedQueryDiagnostic[] = [];
    const test = env(transportQueue([response(payload)]).transport, { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });
    const result = await test.manager.query(FLOW_QUERY);
    expect(result).toMatchObject({ status: 'fresh', completeness: 'complete', quality: 'PARTIAL' });
    expect(result.observations[0]).toMatchObject({ quality: 'PARTIAL', value: null });
    expect(diagnostics[0]).toMatchObject({
      operation: 'FLOW_INTELLIGENCE', pagesRead: 1, finalPage: null, warningsFieldPresent: true, warningsPresent: false,
      rows: [{ asset: 'WETH', presence: 'present', fields: [{ name: 'smart_trader_net_flow_usd', state: expectedState }] }],
      attemptReferences: [{ page: 1, retry: 0, received: true, status: 200, chargedCredits: 1 }],
    });
    expect(JSON.stringify(diagnostics[0])).not.toContain('private-malformed-value');
    expect(JSON.stringify(result)).not.toContain('private-malformed-value');
  });

  it('reports only warning presence and structural state for documented warning-bearing flow responses', async () => {
    const warningText = 'private-warning-canary';
    const payload = { ...structuredClone(flow), warnings: [warningText] };
    const diagnostics: ManagedQueryDiagnostic[] = [];
    const test = env(transportQueue([response(payload)]).transport, { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });
    const result = await test.manager.query(FLOW_QUERY);
    expect(result).toMatchObject({ status: 'incomplete', completeness: 'incomplete', quality: 'PARTIAL' });
    expect(diagnostics[0]).toMatchObject({ warningsFieldPresent: true, warningsPresent: true });
    expect(JSON.stringify(diagnostics[0])).not.toContain(warningText);
    expect(JSON.stringify(result)).not.toContain(warningText);
  });

  it('does not let an opt-in diagnostic sink failure change the manager result or persistence', async () => {
    const test = env(transportQueue([response(flow)]).transport, {
      onDiagnostic: () => { throw new Error('private-diagnostic-sink-error'); },
    });
    const result = await test.manager.query(FLOW_QUERY);
    expect(result).toMatchObject({ status: 'fresh', completeness: 'complete', quality: 'COMPLETE' });
    expect(test.store.listHistory({ cacheKey: result.cacheKey })).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('private-diagnostic-sink-error');
  });

  it('classifies an absent requested USDC netflow row without changing the WETH observation', async () => {
    const payload = structuredClone(netflow) as { data: Array<Record<string, unknown>> };
    payload.data = payload.data.filter((row) => row.token_address !== BASE_ASSET_ADDRESSES.USDC);
    const diagnostics: ManagedQueryDiagnostic[] = [];
    const test = env(transportQueue([response(payload, 200, 5)]).transport, { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });
    const result = await test.manager.query(NETFLOW_QUERY);
    expect(result.completeness).toBe('complete');
    expect(result.quality).toBe('PARTIAL');
    expect(result.observations.find((signal) => signal.asset === 'USDC')).toMatchObject({ quality: 'MISSING', value: null });
    expect(result.observations.find((signal) => signal.asset === 'WETH')).toMatchObject({ quality: 'COMPLETE', value: '23000000000' });
    expect(diagnostics[0]).toMatchObject({
      rows: [
        { asset: 'USDC', presence: 'absent', fields: [{ name: 'net_flow_1h_usd', state: 'absent' }] },
        { asset: 'WETH', presence: 'present', fields: [{ name: 'net_flow_1h_usd', state: 'numeric' }] },
      ],
      warningsPresent: false,
    });
  });

  it('uses safe signed micros rounding and exact freshness boundaries', () => {
    expect(usdToMicros(0)).toBe('0');
    expect(usdToMicros(1.0000005)).toBe('1000001');
    expect(usdToMicros(-1.0000005)).toBe('-1000001');
    expect(usdToMicros(0.00000049)).toBe('0');
    expect(usdToMicros(Number.POSITIVE_INFINITY)).toBeNull();
    const fetched = timeMs;
    expect(isWithinSignalFreshness('TOKEN_SCREENER', fetched, fetched + 10 * 60_000)).toBe(true);
    expect(isWithinSignalFreshness('TOKEN_SCREENER', fetched, fetched + 10 * 60_000 + 1)).toBe(false);
    expect(isWithinSignalFreshness('SMART_MONEY_NETFLOW', fetched, fetched - 1)).toBe(false);
    expect(projectScheduledCollection(24)).toMatchObject({ calls: 624, credits: 816 });
    expect(projectScheduledCollection(48)).toMatchObject({ calls: 1_248, credits: 1_632 });
    expect(projectScheduledCollection(24, 3, 1)).toMatchObject({ calls: 2_592, credits: 3_744 });
  });

  it('returns stale fallback with masked values after a refresh failure', async () => {
    const fake = transportQueue([response(screener), new Error('private provider error text'), new Error('private provider error text')]);
    const test = env(fake.transport);
    const first = await test.manager.query(SCREEN_QUERY);
    timeMs += 10 * 60_000;
    const stale = await test.manager.query(SCREEN_QUERY);
    expect(first.quality).toBe('COMPLETE');
    expect(stale.status).toBe('stale');
    expect(stale.completeness).toBe('incomplete');
    expect(stale.failure?.code).toBe('TRANSPORT_ERROR');
    expect(stale.observations.every((signal) => signal.value === null && signal.quality === 'PARTIAL')).toBe(true);
    expect(JSON.stringify(stale)).not.toContain('private provider error text');
    expect(stale.qualifyingSuccessfulRequests).toBe(0);
    expect(stale.pageReferences[0]?.attemptId).toBe(first.pageReferences[0]?.attemptId);
    expect(stale.attemptPageReferences).toHaveLength(1);
    expect(stale.attemptPageReferences[0]?.attemptId).not.toBe(first.pageReferences[0]?.attemptId);
    expect(test.store.listHistory({ cacheKey: first.cacheKey })).toHaveLength(2);
    timeMs += 16_000;
    const staleAgain = await test.manager.query(SCREEN_QUERY);
    expect(staleAgain.status).toBe('stale');
    expect(staleAgain.observations.some((signal) => signal.quality === 'COMPLETE')).toBe(false);
    expect(test.store.listHistory({ cacheKey: first.cacheKey })).toHaveLength(3);
  });

  it('retains history and serves cache after a child process reopens the database', async () => {
    const fake = transportQueue([response(screener)]);
    const test = env(fake.transport);
    const result = await test.manager.query(SCREEN_QUERY);
    test.store.close(); test.ledger.close();
    const child = spawnSync(process.execPath, [workerPath, test.storePath, test.storeId, result.cacheKey, String(timeMs)], { encoding: 'utf8' });
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ found: true, observationCount: 4, completeness: 'complete' });

    const reopenedStore = openNansenObservationStore({ databasePath: test.storePath, storeId: test.storeId, clock: test.clock });
    stores.push(reopenedStore);
    const reopenedLedger = openCreditLedger(test.ledgerOptions); ledgers.push(reopenedLedger);
    let requests = 0;
    const noCall: NansenHttpTransport = async () => { requests += 1; return response(screener); };
    const client = createNansenClient({ ledger: reopenedLedger, enabled: true, apiKey: 'synthetic-only-test-key', transport: noCall });
    const manager = createNansenQueryManager({ client, store: reopenedStore, enabled: true, clock: test.clock });
    const cached = await manager.query(SCREEN_QUERY);
    expect(cached.cacheHit).toBe(true);
    expect(requests).toBe(0);
    expect(reopenedLedger.getSnapshot().allocatedCredits).toBe(1);
    timeMs += 5 * 60_000;
    const refreshed = await manager.query(SCREEN_QUERY);
    expect(refreshed.cacheHit).toBe(false);
    expect(reopenedStore.listHistory({ cacheKey: result.cacheKey })).toHaveLength(2);
    expect(reopenedLedger.getSnapshot().allocatedCredits).toBe(2);
  });

  it('fails closed on identity/schema mismatch and rolls back an interrupted snapshot write', async () => {
    const test = env(transportQueue([response(screener)]).transport);
    const result = await test.manager.query(SCREEN_QUERY);
    const original = test.store.listHistory({ cacheKey: result.cacheKey })[0]!;
    const nextIso = new Date(timeMs + 1).toISOString();
    const duplicate = { ...original.signals[0]!, fetchedAt: nextIso, observedAt: nextIso };
    expect(() => test.store.writeSnapshot({
      ...original, snapshotId: cryptoRandomId(), fetchedAt: nextIso, acquiredAt: nextIso,
      expiresAt: new Date(timeMs + 5 * 60_000 + 1).toISOString(), signals: [duplicate],
    })).toThrowError(expect.objectContaining({ code: 'DATABASE_FAILURE' }));
    expect(test.store.listHistory({ cacheKey: result.cacheKey })).toHaveLength(1);

    test.store.close();
    expect(() => openNansenObservationStore({ databasePath: test.storePath, storeId: 'wrong-store' })).toThrowError(expect.objectContaining({ code: 'CONFIGURATION_MISMATCH' }));
    const db = new DatabaseSync(test.storePath); db.exec('PRAGMA user_version = 99'); db.close();
    expect(() => openNansenObservationStore({ databasePath: test.storePath, storeId: test.storeId })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_SCHEMA_VERSION' }));
  });

  it('bounds distinct concurrent work without granting the excess query', async () => {
    const held: Array<() => void> = [];
    let ready!: () => void;
    const eighthDispatched = new Promise<void>((resolve) => { ready = resolve; });
    const fake = transportQueue([]);
    const boundedTransport: NansenHttpTransport = async (request) => {
      fake.requests.push(request);
      return new Promise<NansenHttpResponse>((resolve) => {
        held.push(() => resolve(response(screener)));
        if (held.length === 8) ready();
      });
    };
    const test = env(boundedTransport);
    const firstEight = Array.from({ length: 8 }, (_unused, index) => test.manager.query({ ...SCREEN_QUERY, perPage: index + 1 }));
    await eighthDispatched;
    const excess = await test.manager.query({ ...SCREEN_QUERY, perPage: 9 });
    expect(excess.managerError).toBe('IN_FLIGHT_CAPACITY');
    expect(excess.failure?.code).toBe('QUERY_CAPACITY');
    expect(fake.requests).toHaveLength(8);
    for (const finish of held) finish();
    await Promise.all(firstEight);
    expect(test.ledger.getSnapshot().allocatedCredits).toBe(8);
  });});

function cryptoRandomId(): string { return globalThis.crypto.randomUUID(); }

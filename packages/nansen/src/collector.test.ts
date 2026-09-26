import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NANSEN_COST_PROFILE_VERSION, createNansenClient, createNansenCollector, createNansenQueryManager,
  initializeCreditLedger, initializeNansenObservationStore, type NansenCreditLedger,
  type NansenHttpRequest, type NansenHttpResponse, type NansenHttpTransport, type NansenObservationStore,
} from './index.js';

const screener = JSON.parse(readFileSync(new URL('../fixtures/token-screener.synthetic.json', import.meta.url), 'utf8')) as unknown;
const flow = JSON.parse(readFileSync(new URL('../fixtures/flow-intelligence.synthetic.json', import.meta.url), 'utf8')) as unknown;
const netflow = JSON.parse(readFileSync(new URL('../fixtures/smart-money-netflow.synthetic.json', import.meta.url), 'utf8')) as unknown;
interface FakeTimer { readonly callback: () => void; readonly delayMs: number; cancelled: boolean; }
let root: string;
let timeMs: number;
let ledger: NansenCreditLedger;
let store: NansenObservationStore;
let timers: FakeTimer[];
let requests: NansenHttpRequest[];
function response(body: unknown, credits: number): NansenHttpResponse {
  return { status: 200, headers: { 'X-Nansen-Credits-Used': String(credits) }, body: new TextEncoder().encode(JSON.stringify(body)) };
}
function setup() {
  const clock = () => new Date(timeMs);
  ledger = initializeCreditLedger({ databasePath: join(root, 'ledger.sqlite'), budgetId: 'collector-test', limitCredits: 100, costProfileVersion: NANSEN_COST_PROFILE_VERSION, clock });
  store = initializeNansenObservationStore({ databasePath: join(root, 'observations.sqlite'), storeId: 'collector-store', clock });
  requests = [];
  const transport: NansenHttpTransport = async (request) => {
    requests.push(request);
    if (request.url.endsWith('/token-screener')) return response(screener, 1);
    if (request.url.endsWith('/flow-intelligence')) return response(flow, 1);
    return response(netflow, 5);
  };
  const client = createNansenClient({ ledger, enabled: true, apiKey: 'synthetic-only-test-key', transport, maxPages: 1 });
  const manager = createNansenQueryManager({ client, store, enabled: true, clock });
  timers = [];
  const setTimer = (callback: () => void, delayMs: number) => {
    const timer: FakeTimer = { callback, delayMs, cancelled: false }; timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  };
  const clearTimer = (handle: ReturnType<typeof setTimeout>) => { (handle as unknown as FakeTimer).cancelled = true; };
  return { clock, manager, setTimer, clearTimer };
}
function nextTimer(): FakeTimer {
  const timer = timers.findLast((candidate) => !candidate.cancelled);
  if (!timer) throw new Error('expected a scheduled callback');
  return timer;
}
function cycleSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ered-luin-collector-')); timeMs = Date.parse('2026-09-23T12:00:00.000Z'); timers = []; requests = []; });
afterEach(() => {
  try { store.close(); } catch { /* optional before setup */ }
  try { ledger.close(); } catch { /* optional before setup */ }
  rmSync(root, { recursive: true, force: true });
});

describe('G1c offline collector scheduler', () => {
  it('stays off by default, observes cadence, skips downtime catch-up, and resumes with one cycle', async () => {
    const test = setup();
    const disabled = createNansenCollector({ manager: test.manager, clock: test.clock, setTimer: test.setTimer, clearTimer: test.clearTimer });
    expect(await disabled.start()).toBe(false);
    expect(timers).toHaveLength(0);
    expect(requests).toHaveLength(0);

    const completed: (() => void)[] = [];
    const scheduler = createNansenCollector({
      manager: test.manager, enabled: true, clock: test.clock, setTimer: test.setTimer, clearTimer: test.clearTimer,
      onCycle: () => completed.shift()?.(),
    });
    const firstCycle = cycleSignal(); completed.push(firstCycle.resolve);
    expect(await scheduler.start()).toBe(true);
    expect(requests).toHaveLength(3);
    expect(ledger.getSnapshot().allocatedCredits).toBe(7);
    expect(nextTimer().delayMs).toBe(5 * 60_000);
    expect(JSON.parse(requests[0]!.body).pagination.page).toBe(1);

    const secondCycle = cycleSignal(); completed.push(secondCycle.resolve);
    timeMs += 5 * 60_000;
    nextTimer().callback();
    await secondCycle.promise;
    expect(requests).toHaveLength(5);
    expect(scheduler.getState().cycleCount).toBe(2);

    const afterDowntime = cycleSignal(); completed.push(afterDowntime.resolve);
    timeMs += 5 * 60 * 60_000;
    nextTimer().callback();
    await afterDowntime.promise;
    expect(requests).toHaveLength(8);
    expect(scheduler.getState().cycleCount).toBe(3);
    expect(ledger.getSnapshot().allocatedCredits).toBe(16);

    scheduler.stop();
    timeMs += 10 * 60 * 60_000;
    const resumed = cycleSignal(); completed.push(resumed.resolve);
    expect(await scheduler.start()).toBe(true);
    await resumed.promise;
    expect(requests).toHaveLength(11);
    expect(scheduler.getState().cycleCount).toBe(4);
    scheduler.stop();
  });

  it('does not overlap a running cycle when start is requested again', async () => {
    const test = setup();
    let release!: (value: NansenHttpResponse) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<NansenHttpResponse>((resolve) => { release = resolve; });
    let first = true;
    const transport: NansenHttpTransport = async (request) => {
      requests.push(request);
      if (first) { first = false; entered(); return blocked; }
      if (request.url.endsWith('/token-screener')) return response(screener, 1);
      if (request.url.endsWith('/flow-intelligence')) return response(flow, 1);
      return response(netflow, 5);
    };
    const client = createNansenClient({ ledger, enabled: true, apiKey: 'synthetic-only-test-key', transport, maxPages: 1 });
    const manager = createNansenQueryManager({ client, store, enabled: true, clock: test.clock });
    const scheduler = createNansenCollector({ manager, enabled: true, clock: test.clock, setTimer: test.setTimer, clearTimer: test.clearTimer });
    const starting = scheduler.start();
    await started;
    expect(await scheduler.start()).toBe(false);
    expect(requests).toHaveLength(1);
    release(response(screener, 1));
    await starting;
    expect(requests).toHaveLength(3);
    expect(scheduler.getState().cycleCount).toBe(1);
    scheduler.stop();
  });
});
import type { ManagedQueryResult, NansenManagedQuery } from './query-manager.js';
import { NansenQueryManager, WETH_RESEARCH_QUERIES } from './query-manager.js';

export const COLLECTION_INTERVAL_MS = Object.freeze({
  TOKEN_SCREENER: 5 * 60 * 1_000,
  FLOW_INTELLIGENCE: 5 * 60 * 1_000,
  SMART_MONEY_NETFLOW: 30 * 60 * 1_000,
});
const TASKS: readonly { readonly intervalMs: number; readonly query: NansenManagedQuery }[] = Object.freeze([
  { intervalMs: COLLECTION_INTERVAL_MS.TOKEN_SCREENER, query: Object.freeze({ operation: 'TOKEN_SCREENER', asset: 'BASE_PAIR', timeframe: '1h', pageBound: 1, retryBound: 0, perPage: 100 }) },
  { intervalMs: COLLECTION_INTERVAL_MS.FLOW_INTELLIGENCE, query: Object.freeze({ operation: 'FLOW_INTELLIGENCE', asset: 'WETH', timeframe: '1h', pageBound: 1, retryBound: 0, perPage: 1 }) },
  { intervalMs: COLLECTION_INTERVAL_MS.SMART_MONEY_NETFLOW, query: Object.freeze({ operation: 'SMART_MONEY_NETFLOW', asset: 'BASE_PAIR', timeframe: '1h', pageBound: 1, retryBound: 0, perPage: 100 }) },
]);
export const NANSEN_COLLECTOR_PLAN = Object.freeze(TASKS.map((task) => Object.freeze({ intervalMs: task.intervalMs, query: task.query })));
export const WETH_RESEARCH_PLAN = Object.freeze([
  Object.freeze({ intervalMs: 5 * 60 * 1_000, query: WETH_RESEARCH_QUERIES.TOKEN_SCREENER }),
  Object.freeze({ intervalMs: 5 * 60 * 1_000, query: WETH_RESEARCH_QUERIES.SMART_MONEY_NETFLOW }),
]);
export type NansenCollectorProfile = 'default-v1' | 'weth-research-v1';
type TimerHandle = ReturnType<typeof setTimeout>;
type TimerFunction = (callback: () => void, delayMs: number) => TimerHandle;

export interface NansenCollectorOptions {
  readonly manager: Pick<NansenQueryManager, 'query'>;
  /** Selects one of the built-in immutable plans; arbitrary task plans are not accepted. */
  readonly profile?: NansenCollectorProfile;
  readonly enabled?: boolean;
  readonly clock?: () => Date;
  readonly setTimer?: TimerFunction;
  readonly clearTimer?: (handle: TimerHandle) => void;
  readonly beforeQuery?: (query: NansenManagedQuery) => string | null;
  readonly onQuery?: (query: NansenManagedQuery, result: ManagedQueryResult) => string | null;
  readonly onQueryError?: (query: NansenManagedQuery, error: unknown) => void;
  readonly stopOnFailure?: boolean;
  readonly onCycle?: (results: readonly ManagedQueryResult[]) => void;
}
export interface CollectorState {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly cycleCount: number;
  readonly skippedOverlaps: number;
  readonly failedTasks: number;
  readonly lastCycleAt: string | null;
  readonly nextRunAt: string | null;
  readonly cycleInProgress: boolean;
  readonly stopReason: string | null;
}

function readNow(clock: () => Date): number {
  const value = clock();
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime()) || value.getTime() < 0) throw new Error('Collector clock is invalid.');
  return value.getTime();
}
function validStopReason(value: string): string {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(value)) throw new TypeError('Collector stop reason is invalid.');
  return value;
}

/** Offline scheduler. Constructing it never schedules work; start() is explicitly opt-in. */
export class NansenCollectorScheduler {
  private readonly enabled: boolean;
  private readonly clock: () => Date;
  private readonly setTimer: TimerFunction;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly plan: typeof NANSEN_COLLECTOR_PLAN | typeof WETH_RESEARCH_PLAN;
  private readonly nextDue = new Map<NansenManagedQuery['operation'], number>();
  private active = false;
  private running = false;
  private timer: TimerHandle | null = null;
  private cycles = 0;
  private skipped = 0;
  private failures = 0;
  private lastCycleAt: string | null = null;
  private nextRunAt: string | null = null;
  private lastStopReason: string | null = null;
  private readonly idleWaiters = new Set<() => void>();

  constructor(private readonly options: NansenCollectorOptions) {
    if (!options || typeof options !== 'object' || typeof options.manager?.query !== 'function' ||
        (options.enabled !== undefined && typeof options.enabled !== 'boolean') ||
        (options.beforeQuery !== undefined && typeof options.beforeQuery !== 'function') ||
        (options.onQuery !== undefined && typeof options.onQuery !== 'function') ||
        (options.onQueryError !== undefined && typeof options.onQueryError !== 'function') ||
        (options.stopOnFailure !== undefined && typeof options.stopOnFailure !== 'boolean') ||
        (options.profile !== undefined && options.profile !== 'default-v1' && options.profile !== 'weth-research-v1') ||
        (options.onCycle !== undefined && typeof options.onCycle !== 'function')) throw new TypeError('Invalid collector options.');
    this.plan = options.profile === 'weth-research-v1' ? WETH_RESEARCH_PLAN : NANSEN_COLLECTOR_PLAN;
    this.enabled = options.enabled ?? false;
    this.clock = options.clock ?? (() => new Date());
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  getState(): CollectorState {
    return Object.freeze({
      enabled: this.enabled, running: this.active, cycleCount: this.cycles, skippedOverlaps: this.skipped, failedTasks: this.failures,
      lastCycleAt: this.lastCycleAt, nextRunAt: this.nextRunAt, cycleInProgress: this.running, stopReason: this.lastStopReason,
    });
  }

  async start(): Promise<boolean> {
    if (!this.enabled || this.active) return false;
    this.active = true;
    this.lastStopReason = null;
    this.nextDue.clear();
    const start = readNow(this.clock);
    for (const task of this.plan) this.nextDue.set(task.query.operation, start);
    await this.runCycle();
    return true;
  }

  stop(reason = 'OPERATOR_STOP'): void {
    this.active = false;
    this.lastStopReason = validStopReason(reason);
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.nextRunAt = null;
    if (!this.running) this.resolveIdleWaiters();
  }

  waitForStop(): Promise<void> {
    if (!this.active && !this.running) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private resolveIdleWaiters(): void {
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private async runCycle(): Promise<void> {
    if (!this.active) return;
    if (this.running) { this.skipped += 1; return; }
    this.running = true;
    const start = readNow(this.clock);
    const due = this.plan.filter((task) => start >= (this.nextDue.get(task.query.operation) ?? start));
    const results: ManagedQueryResult[] = [];
    try {
      for (const task of due) {
        if (!this.active) break;
        let preflightStop: string | null;
        try {
          preflightStop = this.options.beforeQuery?.(task.query) ?? null;
        } catch {
          this.failures += 1;
          this.stop('CHECKPOINT_FAILED');
          break;
        }
        if (preflightStop !== null) { this.stop(preflightStop); break; }
        let result: ManagedQueryResult;
        try { result = await this.options.manager.query(task.query); }
        catch (error) {
          this.failures += 1;
          try { this.options.onQueryError?.(task.query, error); }
          catch { this.stop('CHECKPOINT_FAILED'); break; }
          if (this.options.stopOnFailure === true) { this.stop('QUERY_FAILED'); break; }
          /* Legacy callers retry only at the next scheduled due time. */
          continue;
        }
        results.push(result);
        let resultStop: string | null;
        try { resultStop = this.options.onQuery?.(task.query, result) ?? null; }
        catch {
          this.failures += 1;
          this.stop('CHECKPOINT_FAILED');
          break;
        }
        if (resultStop !== null) { this.stop(resultStop); break; }
      }
      const finished = readNow(this.clock);
      for (const task of due) this.nextDue.set(task.query.operation, finished + task.intervalMs);
      this.cycles += 1;
      this.lastCycleAt = new Date(finished).toISOString();
      try { this.options.onCycle?.(Object.freeze(results)); }
      catch { this.failures += 1; this.stop('CHECKPOINT_FAILED'); }
    } finally {
      this.running = false;
      if (this.active) this.scheduleNext();
      else this.resolveIdleWaiters();
    }
  }

  private scheduleNext(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    const next = Math.min(...this.nextDue.values());
    const current = readNow(this.clock);
    const delay = Math.max(0, next - current);
    this.nextRunAt = new Date(next).toISOString();
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.runCycle();
    }, delay);
  }
}

export function createNansenCollector(options: NansenCollectorOptions): NansenCollectorScheduler {
  return new NansenCollectorScheduler(options);
}
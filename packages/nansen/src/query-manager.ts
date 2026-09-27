import { createHash, randomUUID } from 'node:crypto';
import { normalizedSignalSchema, type NormalizedSignal } from '@ered-luin/contracts';
import {
  BASE_ASSET_ADDRESSES,
  getNansenClientProvenance,
  type AdapterCompleteness,
  type AdapterEvidenceDiagnostics,
  type AdapterFailure,
  type AdapterResult,
  type FlowIntelligenceRow,
  type NansenClient,
  type PageReference,
  type SmartMoneyNetflowToken,
  type TokenScreenerToken,
  type TokenOhlcvCandle,
} from './client.js';
import { NansenClientError } from './client.js';
import { NANSEN_OPERATION_COSTS, type NansenOperation } from './index.js';
import { NansenObservationStore, type ObservationSnapshot, type StoredPageReference } from './observation-store.js';

export const QUERY_CACHE_TTL_MS = Object.freeze({
  TOKEN_SCREENER: 5 * 60 * 1_000,
  FLOW_INTELLIGENCE: 5 * 60 * 1_000,
  SMART_MONEY_NETFLOW: 30 * 60 * 1_000,
  TOKEN_OHLCV: 60 * 1_000,
});
export const SIGNAL_FRESHNESS_MS = Object.freeze({
  TOKEN_SCREENER: 10 * 60 * 1_000,
  FLOW_INTELLIGENCE: 10 * 60 * 1_000,
  SMART_MONEY_NETFLOW: 35 * 60 * 1_000,
  TOKEN_OHLCV: 10 * 60 * 1_000,
});
export const MAX_QUERY_PAGE_BOUND = 20;
export const MAX_QUERY_RETRY_BOUND = 2;
const MAX_PER_PAGE = 100;
const MAX_IN_FLIGHT_QUERIES = 8;
const NEGATIVE_CACHE_TTL_MS = 15_000;
export const WETH_RESEARCH_MAX_CACHE_AGE_MS = 5 * 60 * 1_000;
export const WETH_RESEARCH_V2_MAX_CACHE_AGE_MS = 3 * 60 * 1_000;

export type NansenManagedQuery =
  | { readonly operation: 'TOKEN_SCREENER'; readonly asset: 'BASE_PAIR' | 'USDC'; readonly timeframe: '1h'; readonly pageBound: number; readonly retryBound: number; readonly perPage: number }
  | { readonly operation: 'FLOW_INTELLIGENCE'; readonly asset: 'WETH'; readonly timeframe: '1h'; readonly pageBound: 1; readonly retryBound: number; readonly perPage: 1 }
  | { readonly operation: 'SMART_MONEY_NETFLOW'; readonly asset: 'BASE_PAIR'; readonly timeframe: '1h'; readonly pageBound: number; readonly retryBound: number; readonly perPage: number }
  | { readonly operation: 'TOKEN_OHLCV'; readonly asset: 'USDC'; readonly timeframe: '1m'; readonly date: { readonly from: string; readonly to: string }; readonly historical?: true; readonly pageBound: 1; readonly retryBound: 0; readonly perPage: 1 };
export const WETH_RESEARCH_QUERIES = Object.freeze({
  TOKEN_SCREENER: Object.freeze({ operation: 'TOKEN_SCREENER', asset: 'BASE_PAIR', timeframe: '1h', pageBound: 1, retryBound: 0, perPage: 100 }) as NansenManagedQuery,
  SMART_MONEY_NETFLOW: Object.freeze({ operation: 'SMART_MONEY_NETFLOW', asset: 'BASE_PAIR', timeframe: '1h', pageBound: 1, retryBound: 0, perPage: 100 }) as NansenManagedQuery,
});

export type ManagedQuality = 'COMPLETE' | 'PARTIAL' | 'MISSING';
export type ManagedQueryStatus = 'fresh' | 'cached' | 'stale' | 'incomplete' | 'failed' | 'disabled';
export type ManagedQueryFailure = Omit<AdapterFailure, 'code'> & { readonly code: AdapterFailure['code'] | 'QUERY_CAPACITY' };
export interface ManagedQueryResult {
  readonly cacheKey: string;
  readonly operation: NansenOperation;
  readonly asset: 'BASE_PAIR' | 'USDC' | 'WETH';
  readonly timeframe: '1h' | '1m';
  readonly pageBound: number;
  readonly retryBound: number;
  readonly status: ManagedQueryStatus;
  readonly source: 'nansen' | 'synthetic';
  readonly fetchedAt: string | null;
  readonly acquiredAt: string | null;
  readonly ageMs: number | null;
  readonly completeness: AdapterCompleteness;
  readonly quality: ManagedQuality;
  readonly observations: readonly NormalizedSignal[];
  readonly failure: ManagedQueryFailure | null;
  readonly storeError: string | null;
  readonly managerError: string | null;
  readonly pageReferences: readonly StoredPageReference[];
  readonly attemptPageReferences: readonly StoredPageReference[];
  readonly cacheHit: boolean;
  readonly coalesced: boolean;
  readonly qualifyingSuccessfulRequests: number;
}

export interface ManagedQueryDiagnostic extends AdapterEvidenceDiagnostics {
  readonly operation: NansenOperation;
  readonly attemptReferences: readonly {
    readonly attemptId: string;
    readonly page: number;
    readonly retry: number;
    readonly received: boolean;
    readonly status: number | null;
    readonly chargedCredits: number | null;
  }[];
}

export interface NansenQueryManagerOptions {
  readonly client: NansenClient;
  readonly store: NansenObservationStore;
  readonly enabled?: boolean;
  readonly maxPageBound?: number;
  readonly maxRetryBound?: number;
  readonly clock?: () => Date;
  readonly beforeDispatch?: (query: NansenManagedQuery) => string | null;
  /** Opt-in transient diagnostics; sink failures never affect policy results or stored observations. */
  readonly onDiagnostic?: (diagnostic: ManagedQueryDiagnostic) => void;
  /** Fixed, opt-in cache-age policy matched to an immutable WETH research profile. */
  readonly cachePolicy?: 'weth-research-v1' | 'weth-research-v2';
}
interface ManagerConfig {
  readonly client: NansenClient; readonly store: NansenObservationStore; readonly enabled: boolean;
  readonly source: 'nansen' | 'synthetic'; readonly maxPageBound: number; readonly maxRetryBound: number;
  readonly clock: () => Date;
  readonly beforeDispatch?: ((query: NansenManagedQuery) => string | null) | undefined;
  readonly onDiagnostic?: ((diagnostic: ManagedQueryDiagnostic) => void) | undefined;
  readonly cachePolicy?: 'weth-research-v1' | 'weth-research-v2' | undefined;
}
type QueryData = readonly (TokenScreenerToken | FlowIntelligenceRow | SmartMoneyNetflowToken | TokenOhlcvCandle)[];
interface AttemptResult { readonly data: QueryData; readonly completeness: AdapterCompleteness; readonly failure: AdapterFailure | null; readonly refs: readonly PageReference[]; readonly unavailable: readonly string[]; readonly diagnostics: AdapterEvidenceDiagnostics | null; }

function now(clock: () => Date): number {
  let value: Date;
  try { value = clock(); } catch { throw new Error('Query clock unavailable.'); }
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime()) || value.getTime() < 0) throw new Error('Query clock invalid.');
  return value.getTime();
}
function validateConfig(value: unknown): ManagerConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new NansenClientError('INVALID_CONFIGURATION');
  const options = value as Record<string, unknown>;
  const allowed = ['client', 'store', 'enabled', 'maxPageBound', 'maxRetryBound', 'clock', 'beforeDispatch', 'onDiagnostic', 'cachePolicy'];
  if (Object.keys(options).some((key) => !allowed.includes(key))) throw new NansenClientError('INVALID_CONFIGURATION');
  const client = options.client as NansenClient | undefined;
  const store = options.store as NansenObservationStore | undefined;
  if (!client || typeof client.tokenScreener !== 'function' || typeof client.flowIntelligence !== 'function' || typeof client.smartMoneyNetflow !== 'function' || typeof client.tokenOhlcv !== 'function' ||
      !store || typeof store.getFreshCache !== 'function' || typeof store.writeSnapshot !== 'function') throw new NansenClientError('INVALID_CONFIGURATION');
  const enabled = options.enabled ?? false;
  const source = getNansenClientProvenance(client);
  const maxPageBound = options.maxPageBound ?? 1;
  const maxRetryBound = options.maxRetryBound ?? 0;
  const clock = options.clock ?? (() => new Date());
  const beforeDispatch = options.beforeDispatch;
  const onDiagnostic = options.onDiagnostic;
  const cachePolicy = options.cachePolicy;
  if (typeof enabled !== 'boolean' ||
      typeof maxPageBound !== 'number' || !Number.isSafeInteger(maxPageBound) || maxPageBound < 1 || maxPageBound > MAX_QUERY_PAGE_BOUND ||
      typeof maxRetryBound !== 'number' || !Number.isSafeInteger(maxRetryBound) || maxRetryBound < 0 || maxRetryBound > MAX_QUERY_RETRY_BOUND || typeof clock !== 'function' ||
      (beforeDispatch !== undefined && typeof beforeDispatch !== 'function') ||
      (onDiagnostic !== undefined && typeof onDiagnostic !== 'function') ||
      (cachePolicy !== undefined && cachePolicy !== 'weth-research-v1' && cachePolicy !== 'weth-research-v2') ||
      (cachePolicy !== undefined && source !== 'nansen') ||
      (cachePolicy !== undefined && typeof store?.getMostRecentWithObservations !== 'function')) {
    throw new NansenClientError('INVALID_CONFIGURATION');
  }
  return { client, store, enabled, source, maxPageBound, maxRetryBound, clock: clock as () => Date, beforeDispatch: beforeDispatch as ((query: NansenManagedQuery) => string | null) | undefined, onDiagnostic: onDiagnostic as ((diagnostic: ManagedQueryDiagnostic) => void) | undefined, cachePolicy: cachePolicy as 'weth-research-v1' | 'weth-research-v2' | undefined };
}
function validateQuery(value: unknown, config: ManagerConfig): NansenManagedQuery {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new NansenClientError('INVALID_REQUEST');
  const q = value as Record<string, unknown>;
  const expected = q.operation === 'TOKEN_OHLCV'
    ? (q.historical === true
      ? ['operation', 'asset', 'timeframe', 'date', 'historical', 'pageBound', 'retryBound', 'perPage']
      : ['operation', 'asset', 'timeframe', 'date', 'pageBound', 'retryBound', 'perPage'])
    : ['operation', 'asset', 'timeframe', 'pageBound', 'retryBound', 'perPage'];
  if (Object.keys(q).length !== expected.length || Object.keys(q).some((key) => !expected.includes(key)) ||
      !Number.isSafeInteger(q.pageBound) || Number(q.pageBound) < 1 || Number(q.pageBound) > config.maxPageBound ||
      !Number.isSafeInteger(q.retryBound) || Number(q.retryBound) < 0 || Number(q.retryBound) > config.maxRetryBound ||
      !Number.isSafeInteger(q.perPage) || Number(q.perPage) < 1 || Number(q.perPage) > MAX_PER_PAGE) throw new NansenClientError('INVALID_REQUEST');
  if (q.operation === 'TOKEN_OHLCV') {
    if (q.asset !== 'USDC' || q.timeframe !== '1m' || q.pageBound !== 1 || q.retryBound !== 0 || q.perPage !== 1 ||
        typeof q.date !== 'object' || q.date === null || Array.isArray(q.date)) throw new NansenClientError('INVALID_REQUEST');
    const date = q.date as Record<string, unknown>;
    if (Object.keys(date).length !== 2 || typeof date.from !== 'string' || typeof date.to !== 'string') throw new NansenClientError('INVALID_REQUEST');
    const fromMs = Date.parse(date.from), toMs = Date.parse(date.to), nowMs = now(config.clock);
    const endMs = Math.floor(nowMs / 60_000) * 60_000;
    const historical = q.historical === true;
    if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || fromMs % 60_000 !== 0 || toMs % 60_000 !== 0 ||
        toMs - fromMs !== 10 * 60_000 || (historical ? toMs > endMs : toMs !== endMs || fromMs !== endMs - 10 * 60_000) ||
        new Date(fromMs).toISOString() !== date.from || new Date(toMs).toISOString() !== date.to) {
      throw new NansenClientError('INVALID_REQUEST');
    }
    return Object.freeze(q as unknown as NansenManagedQuery);
  }
  if (q.timeframe !== '1h') throw new NansenClientError('INVALID_REQUEST');
  if (q.operation === 'TOKEN_SCREENER' && q.asset === 'BASE_PAIR') return Object.freeze(q as unknown as NansenManagedQuery);
  if (q.operation === 'TOKEN_SCREENER' && q.asset === 'USDC' && q.pageBound === 1 && q.retryBound === 0 && q.perPage === 100) return Object.freeze(q as unknown as NansenManagedQuery);
  if (q.operation === 'SMART_MONEY_NETFLOW' && q.asset === 'BASE_PAIR') return Object.freeze(q as unknown as NansenManagedQuery);
  if (q.operation === 'FLOW_INTELLIGENCE' && q.asset === 'WETH' && q.pageBound === 1 && q.perPage === 1) return Object.freeze(q as unknown as NansenManagedQuery);
  throw new NansenClientError('INVALID_REQUEST');
}
function canonicalQuery(q: NansenManagedQuery, source: 'nansen' | 'synthetic'): string {
  if (q.operation === 'TOKEN_OHLCV') {
    if (q.historical === true) return JSON.stringify({ operation: q.operation, asset: q.asset, timeframe: q.timeframe,
      date: q.date, historical: true, pageBound: q.pageBound, retryBound: q.retryBound, perPage: q.perPage, source, schema: 1 });
    return JSON.stringify({ operation: q.operation, asset: q.asset, timeframe: q.timeframe, window: 'last-10-completed-minutes',
      pageBound: q.pageBound, retryBound: q.retryBound, perPage: q.perPage, source, schema: 3 });
  }
  return JSON.stringify({ operation: q.operation, asset: q.asset, timeframe: q.timeframe, pageBound: q.pageBound, retryBound: q.retryBound, perPage: q.perPage, source, schema: 2 });
}
function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
export function historicalBaseUsdcOhlcvCacheKey(query: NansenManagedQuery): string {
  if (query.operation !== 'TOKEN_OHLCV' || query.historical !== true) throw new NansenClientError('INVALID_REQUEST');
  return digest(canonicalQuery(query, 'nansen'));
}
export const WETH_RESEARCH_CACHE_KEYS = Object.freeze({
  TOKEN_SCREENER: digest(canonicalQuery(WETH_RESEARCH_QUERIES.TOKEN_SCREENER, 'nansen')),
  SMART_MONEY_NETFLOW: digest(canonicalQuery(WETH_RESEARCH_QUERIES.SMART_MONEY_NETFLOW, 'nansen')),
});
export const BASE_USDC_PRICE_QUERY = Object.freeze({
  operation: 'TOKEN_SCREENER', asset: 'USDC', timeframe: '1h', pageBound: 1, retryBound: 0, perPage: 100,
}) as NansenManagedQuery;
export const BASE_USDC_PRICE_CACHE_KEY = digest(canonicalQuery(BASE_USDC_PRICE_QUERY, 'nansen'));
const BASE_USDC_OHLCV_QUERY_IDENTITY = Object.freeze({ operation: 'TOKEN_OHLCV', asset: 'USDC', timeframe: '1m', date: { from: '2000-01-01T00:00:00.000Z', to: '2000-01-01T00:10:00.000Z' }, pageBound: 1, retryBound: 0, perPage: 1 }) as NansenManagedQuery;
export const BASE_USDC_OHLCV_PRICE_CACHE_KEY = digest(canonicalQuery(BASE_USDC_OHLCV_QUERY_IDENTITY, 'nansen'));
export function createBaseUsdcOhlcvPriceQuery(at: Date = new Date()): NansenManagedQuery {
  if (!(at instanceof Date) || !Number.isSafeInteger(at.getTime()) || at.getTime() < 0) throw new NansenClientError('INVALID_REQUEST');
  const toMs = Math.floor(at.getTime() / 60_000) * 60_000;
  return Object.freeze({ ...BASE_USDC_OHLCV_QUERY_IDENTITY, date: Object.freeze({ from: new Date(toMs - 10 * 60_000).toISOString(), to: new Date(toMs).toISOString() }) });
}
export function createHistoricalBaseUsdcOhlcvQuery(from: Date, to: Date): NansenManagedQuery {
  if (!(from instanceof Date) || !(to instanceof Date) || !Number.isSafeInteger(from.getTime()) || !Number.isSafeInteger(to.getTime()) ||
      from.getTime() % 60_000 !== 0 || to.getTime() - from.getTime() !== 10 * 60_000 ||
      to.getTime() > Math.floor(Date.now() / 60_000) * 60_000) throw new NansenClientError('INVALID_REQUEST');
  return Object.freeze({ ...BASE_USDC_OHLCV_QUERY_IDENTITY, date: Object.freeze({ from: from.toISOString(), to: to.toISOString() }), historical: true });
}
function isWethResearchQuery(query: NansenManagedQuery): boolean {
  return Object.entries(WETH_RESEARCH_QUERIES).some(([operation, expected]) => operation === query.operation &&
    expected.operation === query.operation && expected.asset === query.asset && expected.timeframe === query.timeframe &&
    expected.pageBound === query.pageBound && expected.retryBound === query.retryBound && expected.perPage === query.perPage);
}
export function estimateWorstCaseCredits(query: NansenManagedQuery): number {
  const pages = query.operation === 'FLOW_INTELLIGENCE' ? 1 : query.pageBound;
  return NANSEN_OPERATION_COSTS[query.operation] * pages * (query.retryBound + 1);
}
export function isWithinSignalFreshness(operation: NansenOperation, fetchedAtMs: number, nowMs: number): boolean {
  const age = nowMs - fetchedAtMs;
  return Number.isSafeInteger(age) && age >= 0 && age <= SIGNAL_FRESHNESS_MS[operation];
}
export function usdToMicros(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/iu.exec(String(value));
  if (!match) return null;
  const exponent = Number(match[4] ?? '0');
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 400) return null;
  const fraction = match[3] ?? '';
  let magnitude = BigInt((match[2] + fraction).replace(/^0+(?=\d)/u, ''));
  const scale = 6 - fraction.length + exponent;
  if (scale >= 0) magnitude *= 10n ** BigInt(scale);
  else {
    const divisor = 10n ** BigInt(-scale);
    const quotient = magnitude / divisor;
    const remainder = magnitude % divisor;
    magnitude = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  }
  const signed = match[1] === '-' && magnitude !== 0n ? -magnitude : magnitude;
  const output = signed.toString();
  return output.length <= 256 ? output : null;
}function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function rowAsset(row: QueryData[number]): 'USDC' | 'WETH' | null {
  if (!isRecord(row) || typeof row.token_address !== 'string') return null;
  const address = row.token_address.toLowerCase();
  if (address === BASE_ASSET_ADDRESSES.USDC.toLowerCase()) return 'USDC';
  if (address === BASE_ASSET_ADDRESSES.WETH.toLowerCase()) return 'WETH';
  return null;
}
function metricsFor(query: NansenManagedQuery, data: QueryData): readonly { asset: 'USDC' | 'WETH'; metric: string; value: number | null; rowPresent: boolean }[] {
  if (query.operation === 'TOKEN_OHLCV') {
    const candle = data[0] as TokenOhlcvCandle | undefined;
    return candle ? [{ asset: 'USDC', metric: 'price_usd', value: candle.close, rowPresent: true }] : [];
  }
  if (query.operation === 'TOKEN_SCREENER') {
    const assets: readonly ('USDC' | 'WETH')[] = query.asset === 'USDC' ? ['USDC'] : ['USDC', 'WETH'];
    return assets.flatMap((asset) => {
      const matches = data.filter((item) => rowAsset(item) === asset);
      const row = matches.length === 1 ? matches[0] as TokenScreenerToken : undefined;
      const rawPrice = row?.price_usd;
      const positivePrice = typeof rawPrice === 'number' && Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : null;
      return [
        { asset, metric: 'market_cap_usd', value: row?.market_cap_usd ?? null, rowPresent: matches.length > 0 },
        { asset, metric: 'price_usd', value: positivePrice, rowPresent: matches.length > 0 },
      ];
    });
  }
  if (query.operation === 'FLOW_INTELLIGENCE') {
    const matches = data.filter((item) => rowAsset(item) === 'WETH');
    const row = matches.length === 1 ? matches[0] as FlowIntelligenceRow : undefined;
    return [{ asset: 'WETH', metric: 'smart_trader_net_flow_usd', value: row?.smart_trader_net_flow_usd ?? null, rowPresent: matches.length > 0 }];
  }
  return (['USDC', 'WETH'] as const).map((asset) => {
    const matches = data.filter((item) => rowAsset(item) === asset);
    const row = matches.length === 1 ? matches[0] as SmartMoneyNetflowToken : undefined;
    return { asset, metric: 'net_flow_1h_usd', value: row?.net_flow_1h_usd ?? null, rowPresent: matches.length > 0 };
  });
}
function makeSignals(
  query: NansenManagedQuery,
  source: 'nansen' | 'synthetic',
  fetchedAt: string,
  acquiredAt: string,
  cacheKey: string,
  refs: readonly StoredPageReference[],
  completeness: AdapterCompleteness,
  data: QueryData,
): readonly NormalizedSignal[] {
  const provenanceId = (cacheKey.slice(0, 18) + ':' + refs.slice(0, 6).map((ref) => ref.attemptId).join(',')).slice(0, 160);
  return Object.freeze(metricsFor(query, data).map((metric) => {
    let quality: NormalizedSignal['quality'];
    let value: string | null = null;
    if (!metric.rowPresent) quality = 'MISSING';
    else if (completeness !== 'complete' || metric.value === null) quality = 'PARTIAL';
    else {
      const micros = usdToMicros(metric.value);
      if (micros === null) quality = 'PARTIAL';
      else { quality = 'COMPLETE'; value = micros; }
    }
    const signal = normalizedSignalSchema.parse({
      signalId: randomUUID(), provider: source, endpoint: query.operation, chainId: 8453,
      asset: metric.asset, metric: metric.metric, observedAt: query.operation === 'TOKEN_OHLCV' ? (data[0] as TokenOhlcvCandle).interval_start : acquiredAt, fetchedAt, timeframe: query.timeframe, quality, value,
      unit: 'usd_micros', provenanceId: provenanceId || cacheKey.slice(0, 64),
    });
    return Object.freeze(signal);
  }));
}
function flatten(result: AdapterResult<TokenScreenerToken | FlowIntelligenceRow | SmartMoneyNetflowToken>): AttemptResult {
  return {
    data: result.data,
    completeness: result.completeness,
    failure: result.failure,
    refs: result.pageReferences,
    unavailable: result.unavailableFields,
    diagnostics: result.diagnostics,
  };
}
function retryable(result: AttemptResult): boolean {
  if (!result.failure || result.refs.length === 0) return false;
  if (result.failure.code === 'TIMEOUT' || result.failure.code === 'TRANSPORT_ERROR' || result.failure.code === 'INVALID_RESPONSE' || result.failure.code === 'RESPONSE_TOO_LARGE') return true;
  return result.failure.code === 'HTTP_ERROR' && (result.failure.status === 429 || (result.failure.status ?? 0) >= 500);
}
function maskStale(snapshot: ObservationSnapshot): readonly NormalizedSignal[] {
  return Object.freeze(snapshot.signals.map((signal) => Object.freeze({ ...signal, quality: 'PARTIAL' as const, value: null })));
}
function qualityOf(signals: readonly NormalizedSignal[], completeness: AdapterCompleteness, stale = false): ManagedQuality {
  if (stale || completeness !== 'complete') return signals.some((signal) => signal.quality !== 'MISSING') ? 'PARTIAL' : 'MISSING';
  if (signals.length === 0 || signals.every((signal) => signal.quality === 'MISSING')) return 'MISSING';
  if (signals.some((signal) => signal.quality !== 'COMPLETE')) return 'PARTIAL';
  return 'COMPLETE';
}
function validateRefs(refs: readonly PageReference[], retry: number): readonly StoredPageReference[] {
  return Object.freeze(refs.map((ref) => Object.freeze({ ...ref, retry })));
}
function qualifyingRequestCount(source: 'nansen' | 'synthetic', refs: readonly PageReference[]): number {
  return source === 'nansen'
    ? refs.filter((ref) => ref.received && ref.status !== null && ref.status >= 200 && ref.status < 300).length
    : 0;
}

class QueryDispatchDenied extends Error {}

export class NansenQueryManager {
  private readonly inFlight = new Map<string, Promise<ManagedQueryResult>>();
  constructor(private readonly config: ManagerConfig) {}

  async query(input: NansenManagedQuery): Promise<ManagedQueryResult> {
    const query = validateQuery(input, this.config);
    if (this.config.cachePolicy !== undefined && !isWethResearchQuery(query)) throw new NansenClientError('INVALID_REQUEST');
    const cacheKey = digest(canonicalQuery(query, this.config.source));
    const nowMs = now(this.config.clock);
    if (!this.config.enabled) return this.noCallResult(query, cacheKey, { code: 'DISABLED', status: null, ledgerCode: null }, 'disabled');
    let cached: ObservationSnapshot | null;
    if (this.config.cachePolicy !== undefined) {
      const recent = this.config.store.getMostRecentWithObservations(cacheKey);
      const acquiredAtMs = recent ? Date.parse(recent.acquiredAt) : Number.NaN;
      const ageMs = nowMs - acquiredAtMs;
      const maxCacheAgeMs = this.config.cachePolicy === 'weth-research-v2' ? WETH_RESEARCH_V2_MAX_CACHE_AGE_MS : WETH_RESEARCH_MAX_CACHE_AGE_MS;
      cached = recent && recent.source === this.config.source && recent.completeness === 'complete' && recent.failure === null &&
        Number.isSafeInteger(acquiredAtMs) && ageMs >= 0 && ageMs <= maxCacheAgeMs ? recent : null;
    } else cached = this.config.store.getFreshCache(cacheKey, new Date(nowMs));
    if (cached) return this.fromSnapshot(cached, 'cached', true, false);
    const pending = this.inFlight.get(cacheKey);
    if (pending) {
      const result = await pending;
      return Object.freeze({ ...result, coalesced: true, attemptPageReferences: Object.freeze([]), qualifyingSuccessfulRequests: 0 });
    }
    if (this.inFlight.size >= MAX_IN_FLIGHT_QUERIES) {
      return this.noCallResult(query, cacheKey, { code: 'QUERY_CAPACITY', status: null, ledgerCode: null }, 'failed', null, 'IN_FLIGHT_CAPACITY');
    }
    const work = this.execute(query, cacheKey);
    this.inFlight.set(cacheKey, work);
    try { return await work; }
    finally { if (this.inFlight.get(cacheKey) === work) this.inFlight.delete(cacheKey); }
  }

  private async invoke(query: NansenManagedQuery): Promise<AttemptResult> {
    const denied = this.config.beforeDispatch?.(query) ?? null;
    if (denied !== null) throw new QueryDispatchDenied();
    const options = { maxPages: query.pageBound };
    if (query.operation === 'TOKEN_SCREENER') {
      return flatten(await this.config.client.tokenScreener({ asset: query.asset, timeframe: query.timeframe, per_page: query.perPage }, options));
    }
    if (query.operation === 'TOKEN_OHLCV') {
      const result = await this.config.client.tokenOhlcv({ date: query.date }, { maxPages: 1 });
      return { data: result.candle ? [result.candle] : [], completeness: result.completeness, failure: result.failure, refs: result.pageReferences, unavailable: [], diagnostics: null };
    }
    if (query.operation === 'FLOW_INTELLIGENCE') {
      return flatten(await this.config.client.flowIntelligence({ asset: 'WETH', timeframe: query.timeframe }, options));
    }
    return flatten(await this.config.client.smartMoneyNetflow({ per_page: query.perPage }, options));
  }

  private emitDiagnostic(operation: NansenOperation, diagnostics: AdapterEvidenceDiagnostics, refs: readonly StoredPageReference[]): void {
    const sink = this.config.onDiagnostic;
    if (!sink) return;
    const attemptReferences = Object.freeze(refs.map((ref) => Object.freeze({
      attemptId: ref.attemptId, page: ref.page, retry: ref.retry, received: ref.received,
      status: ref.status, chargedCredits: ref.chargedCredits,
    })));
    try { sink(Object.freeze({ ...diagnostics, operation, attemptReferences })); }
    catch { /* Optional diagnostics cannot invalidate a charged query or alter policy evidence. */ }
  }

  private async execute(query: NansenManagedQuery, cacheKey: string): Promise<ManagedQueryResult> {
    const old = this.config.store.getMostRecentWithObservations(cacheKey);
    let final: AttemptResult = { data: [], completeness: 'unknown', failure: null, refs: [], unavailable: [], diagnostics: null };
    let fetchedAt = now(this.config.clock);
    const allRefs: StoredPageReference[] = [];
    const unavailable = new Set<string>();
    for (let retry = 0; retry <= query.retryBound; retry += 1) {
      fetchedAt = now(this.config.clock);
      try { final = await this.invoke(query); }
      catch (error) {
        final = { data: [], completeness: 'incomplete', failure: error instanceof NansenClientError
          ? { code: error.code, status: error.status, ledgerCode: error.ledgerCode }
          : error instanceof QueryDispatchDenied
            ? { code: 'DISABLED', status: null, ledgerCode: null }
            : { code: 'INVALID_RESPONSE', status: null, ledgerCode: null }, refs: [], unavailable: [], diagnostics: null };
      }
      allRefs.push(...validateRefs(final.refs, retry));
      for (const field of final.unavailable) if (/^[A-Za-z0-9_.-]{1,96}$/u.test(field)) unavailable.add(field);
      if (!retryable(final) || retry === query.retryBound) break;
    }
    const acquiredAtMs = now(this.config.clock);
    const fetchedAtIso = new Date(fetchedAt).toISOString();
    const acquiredAtIso = new Date(acquiredAtMs).toISOString();
    const completeness: AdapterCompleteness = final.failure === null ? final.completeness : 'incomplete';
    const signals = makeSignals(query, this.config.source, fetchedAtIso, acquiredAtIso, cacheKey, allRefs, completeness, final.data);
    if (allRefs.length === 0) {
      if (old) return this.fromSnapshot(old, 'stale', false, false, final.failure);
      return this.noCallResult(query, cacheKey, final.failure, final.failure ? 'failed' : 'incomplete');
    }
    const ttl = final.failure === null ? QUERY_CACHE_TTL_MS[query.operation] : NEGATIVE_CACHE_TTL_MS;
    try {
      const snapshot = this.config.store.writeSnapshot({
        cacheKey, operation: query.operation, asset: query.asset, timeframe: query.timeframe,
        pageBound: query.pageBound, retryBound: query.retryBound, source: this.config.source,
        fetchedAt: fetchedAtIso, acquiredAt: acquiredAtIso, expiresAt: new Date(acquiredAtMs + ttl).toISOString(),
        completeness, failure: final.failure, pageReferences: allRefs, unavailableFields: [...unavailable].slice(0, 64), signals,
      });
      if (final.failure && old) {
        return this.fromSnapshot(
          old, 'stale', false, false, final.failure, null,
          qualifyingRequestCount(this.config.source, allRefs), allRefs,
        );
      }
      const status: ManagedQueryStatus = final.failure ? 'failed' : completeness === 'complete' ? 'fresh' : 'incomplete';
      if (final.failure === null && final.diagnostics !== null) this.emitDiagnostic(query.operation, final.diagnostics, allRefs);
      return this.fromSnapshot(
        snapshot, status, false, false, undefined, null,
        qualifyingRequestCount(this.config.source, allRefs), allRefs,
      );
    } catch {
      return this.storeFailureResult(query, cacheKey, fetchedAtIso, acquiredAtIso, allRefs, final.failure);
    }
  }

  private storeFailureResult(
    query: NansenManagedQuery,
    cacheKey: string,
    fetchedAt: string,
    acquiredAt: string,
    pageReferences: readonly StoredPageReference[],
    failure: AdapterFailure | null,
  ): ManagedQueryResult {
    const age = now(this.config.clock) - Date.parse(acquiredAt);
    const qualifyingSuccessfulRequests = qualifyingRequestCount(this.config.source, pageReferences);
    return Object.freeze({
      cacheKey, operation: query.operation, asset: query.asset, timeframe: query.timeframe,
      pageBound: query.pageBound, retryBound: query.retryBound, status: 'failed', source: this.config.source,
      fetchedAt, acquiredAt, ageMs: age < 0 ? null : age, completeness: 'incomplete', quality: 'MISSING',
      observations: Object.freeze([]), failure, storeError: 'STORE_FAILURE', managerError: null,
      pageReferences: Object.freeze([...pageReferences]), attemptPageReferences: Object.freeze([...pageReferences]),
      cacheHit: false, coalesced: false, qualifyingSuccessfulRequests,
    });
  }

  private fromSnapshot(
    snapshot: ObservationSnapshot,
    requestedStatus: ManagedQueryStatus,
    cacheHit: boolean,
    coalesced: boolean,
    overrideFailure?: AdapterFailure | null,
    storeError: string | null = null,
    qualifyingSuccessfulRequests = 0,
    attemptPageReferences: readonly StoredPageReference[] = [],
  ): ManagedQueryResult {
    const currentMs = now(this.config.clock);
    const acquiredMs = Date.parse(snapshot.acquiredAt);
    const freshnessMs = snapshot.operation === 'TOKEN_OHLCV' && snapshot.signals.length === 1 ? Date.parse(snapshot.signals[0]!.observedAt) : acquiredMs;
    const age = currentMs - freshnessMs;
    const stale = requestedStatus === 'stale' || !isWithinSignalFreshness(snapshot.operation, freshnessMs, currentMs);
    const observations = stale ? maskStale(snapshot) : snapshot.signals;
    const completeness: AdapterCompleteness = stale ? 'incomplete' : snapshot.completeness;
    let status: ManagedQueryStatus = stale ? 'stale' : requestedStatus;
    if (!stale && snapshot.failure) status = 'failed';
    else if (!stale && snapshot.completeness !== 'complete') status = 'incomplete';
    const failure = overrideFailure === undefined ? snapshot.failure : overrideFailure;

    return Object.freeze({
      cacheKey: snapshot.cacheKey, operation: snapshot.operation, asset: snapshot.asset, timeframe: snapshot.timeframe,
      pageBound: snapshot.pageBound, retryBound: snapshot.retryBound, status, source: snapshot.source,
      fetchedAt: snapshot.fetchedAt, acquiredAt: snapshot.acquiredAt, ageMs: age < 0 ? null : age, completeness,
      quality: qualityOf(observations, completeness, stale), observations, failure, storeError, managerError: null,
      pageReferences: snapshot.pageReferences, attemptPageReferences: Object.freeze([...attemptPageReferences]),
      cacheHit, coalesced, qualifyingSuccessfulRequests,
    });
  }

  private noCallResult(
    query: NansenManagedQuery,
    cacheKey: string,
    failure: ManagedQueryFailure | null,
    status: ManagedQueryStatus,
    storeError: string | null = null,
    managerError: string | null = null,
  ): ManagedQueryResult {
    return Object.freeze({
      cacheKey, operation: query.operation, asset: query.asset, timeframe: query.timeframe,
      pageBound: query.pageBound, retryBound: query.retryBound, status, source: this.config.source,
      fetchedAt: null, acquiredAt: null, ageMs: null, completeness: 'unknown', quality: 'MISSING',
      observations: Object.freeze([]), failure, storeError, managerError, pageReferences: Object.freeze([]),
      attemptPageReferences: Object.freeze([]), cacheHit: false, coalesced: false, qualifyingSuccessfulRequests: 0,
    });
  }
}

export function createNansenQueryManager(options: NansenQueryManagerOptions): NansenQueryManager {
  return new NansenQueryManager(validateConfig(options));
}
export interface CollectionProjection {
  readonly hours: number;
  readonly pageBound: number;
  readonly retryBound: number;
  readonly calls: number;
  readonly credits: number;
}
export function projectScheduledCollection(hours: number, pageBound = 1, retryBound = 0): CollectionProjection {
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 168 ||
      !Number.isSafeInteger(pageBound) || pageBound < 1 || pageBound > MAX_QUERY_PAGE_BOUND ||
      !Number.isSafeInteger(retryBound) || retryBound < 0 || retryBound > MAX_QUERY_RETRY_BOUND) {
    throw new NansenClientError('INVALID_REQUEST');
  }
  const multiplier = hours * (retryBound + 1);
  return Object.freeze({
    hours, pageBound, retryBound,
    calls: multiplier * (12 * pageBound + 12 + 2 * pageBound),
    credits: multiplier * (12 * pageBound + 12 + 10 * pageBound),
  });
}
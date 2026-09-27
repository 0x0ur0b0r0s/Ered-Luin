import {
  NansenClientError,
  type GuardedPost,
  type NansenCallOptions,
  type NansenClientErrorCode,
  type NansenAttemptMetadata,
} from './client-core.js';

export const BASE_ASSET_ADDRESSES = Object.freeze({
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  WETH: '0x4200000000000000000000000000000000000006',
} as const);

export type BaseEvidenceAsset = keyof typeof BASE_ASSET_ADDRESSES;
export type TokenScreenerTimeframe = '5m' | '10m' | '1h' | '6h' | '24h' | '7d' | '30d';
export type FlowIntelligenceTimeframe = '5m' | '1h' | '6h' | '12h' | '1d' | '7d';
export type TokenOhlcvTimeframe = '1m';
export type AdapterCompleteness = 'complete' | 'incomplete' | 'unknown';
export type EvidenceFieldState = 'absent' | 'null' | 'numeric' | 'invalid' | 'ambiguous';
export type EvidenceFieldName = 'market_cap_usd' | 'price_usd' | 'smart_trader_net_flow_usd' | 'net_flow_1h_usd';

/** Shape-only metadata for requested Base rows. It contains no provider values or warning text. */
export interface AdapterEvidenceDiagnostics {
  readonly rows: readonly {
    readonly asset: BaseEvidenceAsset;
    readonly presence: 'present' | 'absent' | 'duplicate';
    readonly fields: readonly { readonly name: EvidenceFieldName; readonly state: EvidenceFieldState }[];
  }[];
  readonly pagesRead: number;
  readonly finalPage: boolean | null;
  readonly warningsFieldPresent: boolean;
  readonly warningsPresent: boolean;
}

export interface TokenOhlcvDateRange { readonly from: string; readonly to: string; }
export interface TokenOhlcvQuery { readonly date: TokenOhlcvDateRange; }
export interface TokenOhlcvCandle { readonly interval_start: string; readonly close: number; readonly market_cap: Readonly<Record<string, unknown>>; }
export interface TokenOhlcvAdapterResult { readonly operation: 'TOKEN_OHLCV'; readonly candle: TokenOhlcvCandle | null; readonly completeness: AdapterCompleteness; readonly pageReferences: readonly PageReference[]; readonly failure: AdapterFailure | null; }

export interface TokenScreenerQuery {
  /** BASE_PAIR preserves the established pair request; USDC selects exact Base USDC only. */
  readonly asset?: 'BASE_PAIR' | 'USDC';
  readonly timeframe?: TokenScreenerTimeframe;
  readonly per_page?: number;
}

export interface FlowIntelligenceQuery {
  readonly asset: BaseEvidenceAsset;
  readonly timeframe?: FlowIntelligenceTimeframe;
}

export interface SmartMoneyNetflowQuery {
  readonly per_page?: number;
}

export interface TokenScreenerToken {
  readonly chain: string;
  readonly token_address: string;
  readonly token_symbol: string;
  readonly token_age_days: number | null;
  readonly token_deployment_date: string | null;
  readonly market_cap_usd: number | null;
  readonly liquidity: number | null;
  readonly price_usd: number | null;
  readonly price_change: number | null;
  readonly fdv: number | null;
  readonly buy_volume: number | null;
  readonly sell_volume: number | null;
  readonly volume: number | null;
  readonly netflow: number | null;
}

export interface FlowIntelligenceRow {
  readonly asset: BaseEvidenceAsset;
  readonly chain: 'base';
  readonly token_address: string;
  readonly public_figure_net_flow_usd: number | null;
  readonly public_figure_avg_flow_usd: number | null;
  readonly public_figure_wallet_count: number | null;
  readonly top_pnl_net_flow_usd: number | null;
  readonly top_pnl_avg_flow_usd: number | null;
  readonly top_pnl_wallet_count: number | null;
  readonly whale_net_flow_usd: number | null;
  readonly whale_avg_flow_usd: number | null;
  readonly whale_wallet_count: number | null;
  readonly smart_trader_net_flow_usd: number | null;
  readonly smart_trader_avg_flow_usd: number | null;
  readonly smart_trader_wallet_count: number | null;
  readonly exchange_net_flow_usd: number | null;
  readonly exchange_avg_flow_usd: number | null;
  readonly exchange_wallet_count: number | null;
  readonly fresh_wallets_net_flow_usd: number | null;
  readonly fresh_wallets_avg_flow_usd: number | null;
  readonly fresh_wallets_wallet_count: number | null;
}

export interface SmartMoneyNetflowToken {
  readonly chain: string;
  readonly token_address: string;
  readonly token_symbol: string;
  readonly net_flow_1h_usd: number | null;
  readonly net_flow_24h_usd: number | null;
  readonly net_flow_7d_usd: number | null;
  readonly net_flow_30d_usd: number | null;
  readonly token_sectors: readonly string[] | null;
  readonly trader_count: number | null;
  readonly token_age_days: number | null;
  readonly market_cap_usd: number | null;
}

export interface PageReference extends Omit<NansenAttemptMetadata, 'status'> {
  readonly status: number | null;
  readonly page: number;
  readonly received: boolean;
}

export interface AdapterFailure {
  readonly code: NansenClientErrorCode;
  readonly status: number | null;
  readonly ledgerCode: string | null;
}

export interface AdapterResult<T> {
  readonly operation: 'TOKEN_SCREENER' | 'FLOW_INTELLIGENCE' | 'SMART_MONEY_NETFLOW' | 'TOKEN_OHLCV';
  readonly data: readonly T[];
  readonly warnings: readonly string[];
  readonly warningsAvailable: boolean;
  readonly completeness: AdapterCompleteness;
  readonly pagesRead: number;
  readonly pageReferences: readonly PageReference[];
  readonly unavailableFields: readonly string[];
  /** Transient shape metadata; not persisted with policy observations. */
  readonly diagnostics: AdapterEvidenceDiagnostics | null;
  readonly failure: AdapterFailure | null;
}

export interface NansenClient {
  readonly tokenScreener: (
    query?: TokenScreenerQuery,
    options?: NansenCallOptions,
  ) => Promise<AdapterResult<TokenScreenerToken>>;
  readonly flowIntelligence: (
    query: FlowIntelligenceQuery,
    options?: NansenCallOptions,
  ) => Promise<AdapterResult<FlowIntelligenceRow>>;
  readonly tokenOhlcv: (query: TokenOhlcvQuery, options?: NansenCallOptions) => Promise<TokenOhlcvAdapterResult>;
  readonly smartMoneyNetflow: (
    query?: SmartMoneyNetflowQuery,
    options?: NansenCallOptions,
  ) => Promise<AdapterResult<SmartMoneyNetflowToken>>;
}

type PaginationSignal = {
  readonly page: number | null;
  readonly per_page: number | null;
  readonly is_last_page: boolean | null;
};
type ParsedPage<T> = {
  readonly data: readonly T[];
  readonly pagination: PaginationSignal;
  readonly warnings: readonly string[];
  readonly warningsAvailable: boolean;
  readonly unavailableFields: readonly string[];
  readonly structuralRows: readonly StructuralRow[];
};
type StructuralRow = { readonly asset: BaseEvidenceAsset; readonly fields: readonly { readonly name: EvidenceFieldName; readonly state: Exclude<EvidenceFieldState, 'ambiguous'> }[] };
type PageFetcher<T> = (page: number) => Promise<{
  readonly page: ParsedPage<T>;
  readonly attempt: NansenAttemptMetadata;
}>;

const SCREENER_TIMEFRAMES = new Set<TokenScreenerTimeframe>(['5m', '10m', '1h', '6h', '24h', '7d', '30d']);
const FLOW_TIMEFRAMES = new Set<FlowIntelligenceTimeframe>(['5m', '1h', '6h', '12h', '1d', '7d']);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const SCREENER_FIELDS = [
  'token_age_days', 'token_deployment_date', 'market_cap_usd', 'liquidity',
  'price_usd', 'price_change', 'fdv', 'buy_volume', 'sell_volume', 'volume', 'netflow',
] as const;
// Documented optional ratios are accepted but stay outside the normalized signal contract.
const DOCUMENTED_UNNORMALIZED_SCREENER_FIELDS = [
  'fdv_mc_ratio', 'inflow_fdv_ratio', 'outflow_fdv_ratio',
] as const;

const FLOW_FIELDS = [
  'public_figure_net_flow_usd', 'public_figure_avg_flow_usd', 'public_figure_wallet_count',
  'top_pnl_net_flow_usd', 'top_pnl_avg_flow_usd', 'top_pnl_wallet_count',
  'whale_net_flow_usd', 'whale_avg_flow_usd', 'whale_wallet_count',
  'smart_trader_net_flow_usd', 'smart_trader_avg_flow_usd', 'smart_trader_wallet_count',
  'exchange_net_flow_usd', 'exchange_avg_flow_usd', 'exchange_wallet_count',
  'fresh_wallets_net_flow_usd', 'fresh_wallets_avg_flow_usd', 'fresh_wallets_wallet_count',
] as const;
const NETFLOW_FIELDS = [
  'net_flow_1h_usd', 'net_flow_24h_usd', 'net_flow_7d_usd', 'net_flow_30d_usd',
  'trader_count', 'token_age_days', 'market_cap_usd',
] as const;

function isBaseEvidenceAddress(value: unknown): value is string {
  return typeof value === 'string' &&
    ADDRESS.test(value) &&
    Object.values(BASE_ASSET_ADDRESSES).some((address) => address.toLowerCase() === value.toLowerCase());
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new NansenClientError('INVALID_REQUEST');
  }
}

function normalizePageSize(input: unknown, allowedKeys: readonly string[]): number {
  if (input === undefined) return 100;
  if (!isRecord(input)) throw new NansenClientError('INVALID_REQUEST');
  rejectUnknownKeys(input, allowedKeys);
  const size = input.per_page ?? 100;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > 1_000) {
    throw new NansenClientError('INVALID_REQUEST');
  }
  return size;
}

function sanitizeWarning(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    result += code <= 31 || code === 127 ? ' ' : character;
  }
  return result.slice(0, 512);
}

function boundedWarningList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((part) => typeof part !== 'string')) {
    throw new TypeError('Invalid warnings');
  }
  return Object.freeze(value.slice(0, 20).map(sanitizeWarning));
}

function optionalNumber(
  row: Record<string, unknown>,
  key: string,
  unavailable: string[],
  integer = false,
): number | null {
  const value = row[key];
  if (value === undefined || value === null) {
    unavailable.push(key);
    return null;
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (integer && !Number.isSafeInteger(value))
  ) {
    unavailable.push(key);
    return null;
  }
  return value;
}

function numberShape(row: Record<string, unknown>, key: EvidenceFieldName): Exclude<EvidenceFieldState, 'ambiguous'> {
  if (!Object.hasOwn(row, key)) return 'absent';
  const value = row[key];
  if (value === null) return 'null';
  return typeof value === 'number' && Number.isFinite(value) ? 'numeric' : 'invalid';
}

function evidenceAsset(address: unknown): BaseEvidenceAsset | null {
  if (typeof address !== 'string') return null;
  const normalized = address.toLowerCase();
  if (normalized === BASE_ASSET_ADDRESSES.USDC.toLowerCase()) return 'USDC';
  if (normalized === BASE_ASSET_ADDRESSES.WETH.toLowerCase()) return 'WETH';
  return null;
}

function evidenceDiagnostics(
  operation: AdapterResult<unknown>['operation'],
  structuralRows: readonly StructuralRow[],
  pagesRead: number,
  finalPage: boolean | null,
  warningsFieldPresent: boolean,
  warningsPresent: boolean,
  requestedAssetsOverride?: readonly BaseEvidenceAsset[],
): AdapterEvidenceDiagnostics {
  const requestedAssets: readonly BaseEvidenceAsset[] = requestedAssetsOverride ?? (operation === 'FLOW_INTELLIGENCE' ? ['WETH'] : ['USDC', 'WETH']);
  const fields: readonly EvidenceFieldName[] = operation === 'TOKEN_SCREENER'
    ? ['market_cap_usd', 'price_usd']
    : operation === 'FLOW_INTELLIGENCE' ? ['smart_trader_net_flow_usd'] : ['net_flow_1h_usd'];
  const rows = requestedAssets.map((asset) => {
    const matches = structuralRows.filter((row) => row.asset === asset);
    const presence = matches.length === 0 ? 'absent' : matches.length === 1 ? 'present' : 'duplicate';
    const fieldDiagnostics = fields.map((name) => ({
      name,
      state: matches.length > 1 ? 'ambiguous' as const : matches[0]?.fields.find((field) => field.name === name)?.state ?? 'absent' as const,
    }));
    return Object.freeze({ asset, presence, fields: Object.freeze(fieldDiagnostics) });
  });
  return Object.freeze({ rows: Object.freeze(rows), pagesRead, finalPage, warningsFieldPresent, warningsPresent });
}

function optionalString(row: Record<string, unknown>, key: string, unavailable: string[]): string | null {
  const value = row[key];
  if (value === undefined || value === null) {
    unavailable.push(key);
    return null;
  }
  if (typeof value !== 'string' || value.length > 128) {
    unavailable.push(key);
    return null;
  }
  return value;
}

function isUnknownSet(row: Record<string, unknown>, known: readonly string[]): boolean {
  return Object.keys(row).some((key) => !known.includes(key));
}

function parsePagination(value: unknown, expectedPage: number): PaginationSignal {
  if (!isRecord(value)) throw new TypeError('Invalid pagination');
  const page = value.page;
  const perPage = value.per_page;
  const last = value.is_last_page;
  if (page !== undefined && (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1)) {
    throw new TypeError('Invalid pagination page');
  }
  if (page !== undefined && page !== expectedPage) throw new TypeError('Unexpected pagination page');
  if (
    perPage !== undefined &&
    (typeof perPage !== 'number' || !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 1_000)
  ) throw new TypeError('Invalid pagination page size');
  if (last !== undefined && typeof last !== 'boolean') throw new TypeError('Invalid last page signal');
  return {
    page: typeof page === 'number' ? page : null,
    per_page: typeof perPage === 'number' ? perPage : null,
    is_last_page: typeof last === 'boolean' ? last : null,
  };
}

function parseWarnings(row: Record<string, unknown>): {
  readonly warnings: readonly string[];
  readonly available: boolean;
} {
  if (!Object.hasOwn(row, 'warnings')) return { warnings: Object.freeze([]), available: false };
  return { warnings: boundedWarningList(row.warnings), available: true };
}

function parsePagedRoot(
  value: unknown,
  expectedPage: number,
  allowedRootFields: readonly string[],
): { readonly root: Record<string, unknown>; readonly pagination: PaginationSignal; readonly unknown: boolean } {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new TypeError('Invalid response data');
  if (!isRecord(value.pagination)) throw new TypeError('Invalid pagination');
  return {
    root: value,
    pagination: parsePagination(value.pagination, expectedPage),
    unknown: isUnknownSet(value, allowedRootFields),
  };
}

function parseTokenScreener(value: unknown, pageNumber: number, perPage: number, requestedAsset: 'BASE_PAIR' | 'USDC'): ParsedPage<TokenScreenerToken> {
  const parsed = parsePagedRoot(value, pageNumber, ['data', 'pagination']);
  if ((parsed.root.data as unknown[]).length > perPage) throw new TypeError('Too many response rows');
  const unavailable: string[] = parsed.unknown ? ['unrecognized_provider_fields'] : [];
  const structuralRows: StructuralRow[] = [];
  const data = (parsed.root.data as unknown[]).map((item) => {
    if (!isRecord(item)) throw new TypeError('Invalid token row');
    const known = ['chain', 'token_address', 'token_symbol', ...SCREENER_FIELDS, ...DOCUMENTED_UNNORMALIZED_SCREENER_FIELDS, 'token_age_hours'];
    if (
      typeof item.chain !== 'string' ||
      item.chain.toLowerCase() !== 'base' ||
      !isBaseEvidenceAddress(item.token_address) ||
      typeof item.token_symbol !== 'string' ||
      item.token_symbol.length > 64
    ) throw new TypeError('Invalid token identity');
    const returnedAsset = evidenceAsset(item.token_address);
    if (requestedAsset === 'USDC' && returnedAsset !== 'USDC') throw new TypeError('Unexpected token identity');
    if (isUnknownSet(item, known)) unavailable.push('unrecognized_token_fields');
    const rowUnavailable: string[] = [];
    const output: TokenScreenerToken = {
      chain: 'base',
      token_address: item.token_address,
      token_symbol: item.token_symbol,
      token_age_days: optionalNumber(item, 'token_age_days', rowUnavailable),
      token_deployment_date: optionalString(item, 'token_deployment_date', rowUnavailable),
      market_cap_usd: optionalNumber(item, 'market_cap_usd', rowUnavailable),
      liquidity: optionalNumber(item, 'liquidity', rowUnavailable),
      price_usd: optionalNumber(item, 'price_usd', rowUnavailable),
      price_change: optionalNumber(item, 'price_change', rowUnavailable),
      fdv: optionalNumber(item, 'fdv', rowUnavailable),
      buy_volume: optionalNumber(item, 'buy_volume', rowUnavailable),
      sell_volume: optionalNumber(item, 'sell_volume', rowUnavailable),
      volume: optionalNumber(item, 'volume', rowUnavailable),
      netflow: optionalNumber(item, 'netflow', rowUnavailable),
    };
    for (const field of rowUnavailable) unavailable.push('data.' + field);
    const asset = evidenceAsset(item.token_address);
    if (asset) structuralRows.push({ asset, fields: [
      { name: 'market_cap_usd', state: numberShape(item, 'market_cap_usd') },
      { name: 'price_usd', state: numberShape(item, 'price_usd') },
    ] });
    return output;
  });
  return {
    data: Object.freeze(data),
    pagination: parsed.pagination,
    warnings: Object.freeze([]),
    warningsAvailable: false,
    unavailableFields: Object.freeze(unavailable.slice(0, 64)),
    structuralRows: Object.freeze(structuralRows),
  };
}

function parseFlowIntelligence(
  value: unknown,
  asset: BaseEvidenceAsset,
): ParsedPage<FlowIntelligenceRow> {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new TypeError('Invalid response data');
  const knownRoot = ['data', 'warnings'];
  const warnings = parseWarnings(value);
  const unavailable: string[] = isUnknownSet(value, knownRoot) ? ['unrecognized_provider_fields'] : [];
  const structuralRows: StructuralRow[] = [];
  const data = value.data.map((item) => {
    if (!isRecord(item)) throw new TypeError('Invalid flow row');
    if (isUnknownSet(item, FLOW_FIELDS)) unavailable.push('unrecognized_flow_fields');
    const rowUnavailable: string[] = [];
    const output = {
      asset,
      chain: 'base' as const,
      token_address: BASE_ASSET_ADDRESSES[asset],
      public_figure_net_flow_usd: optionalNumber(item, 'public_figure_net_flow_usd', rowUnavailable),
      public_figure_avg_flow_usd: optionalNumber(item, 'public_figure_avg_flow_usd', rowUnavailable),
      public_figure_wallet_count: optionalNumber(item, 'public_figure_wallet_count', rowUnavailable, true),
      top_pnl_net_flow_usd: optionalNumber(item, 'top_pnl_net_flow_usd', rowUnavailable),
      top_pnl_avg_flow_usd: optionalNumber(item, 'top_pnl_avg_flow_usd', rowUnavailable),
      top_pnl_wallet_count: optionalNumber(item, 'top_pnl_wallet_count', rowUnavailable, true),
      whale_net_flow_usd: optionalNumber(item, 'whale_net_flow_usd', rowUnavailable),
      whale_avg_flow_usd: optionalNumber(item, 'whale_avg_flow_usd', rowUnavailable),
      whale_wallet_count: optionalNumber(item, 'whale_wallet_count', rowUnavailable, true),
      smart_trader_net_flow_usd: optionalNumber(item, 'smart_trader_net_flow_usd', rowUnavailable),
      smart_trader_avg_flow_usd: optionalNumber(item, 'smart_trader_avg_flow_usd', rowUnavailable),
      smart_trader_wallet_count: optionalNumber(item, 'smart_trader_wallet_count', rowUnavailable, true),
      exchange_net_flow_usd: optionalNumber(item, 'exchange_net_flow_usd', rowUnavailable),
      exchange_avg_flow_usd: optionalNumber(item, 'exchange_avg_flow_usd', rowUnavailable),
      exchange_wallet_count: optionalNumber(item, 'exchange_wallet_count', rowUnavailable, true),
      fresh_wallets_net_flow_usd: optionalNumber(item, 'fresh_wallets_net_flow_usd', rowUnavailable),
      fresh_wallets_avg_flow_usd: optionalNumber(item, 'fresh_wallets_avg_flow_usd', rowUnavailable),
      fresh_wallets_wallet_count: optionalNumber(item, 'fresh_wallets_wallet_count', rowUnavailable, true),
    };
    for (const field of rowUnavailable) unavailable.push('data.' + field);
    structuralRows.push({ asset, fields: [{ name: 'smart_trader_net_flow_usd', state: numberShape(item, 'smart_trader_net_flow_usd') }] });
    return output;
  });
  return {
    data: Object.freeze(data),
    pagination: { page: null, per_page: null, is_last_page: null },
    warnings: warnings.warnings,
    warningsAvailable: warnings.available,
    unavailableFields: Object.freeze(unavailable.slice(0, 64)),
    structuralRows: Object.freeze(structuralRows),
  };
}

function parseSmartMoneyNetflow(
  value: unknown,
  pageNumber: number,
  perPage: number,
): ParsedPage<SmartMoneyNetflowToken> {
  const parsed = parsePagedRoot(value, pageNumber, ['data', 'pagination']);
  if ((parsed.root.data as unknown[]).length > perPage) throw new TypeError('Too many response rows');
  const unavailable: string[] = parsed.unknown ? ['unrecognized_provider_fields'] : [];
  const structuralRows: StructuralRow[] = [];
  const data = (parsed.root.data as unknown[]).map((item) => {
    if (!isRecord(item)) throw new TypeError('Invalid netflow row');
    const known = ['chain', 'token_address', 'token_symbol', 'token_sectors', ...NETFLOW_FIELDS];
    if (
      typeof item.chain !== 'string' ||
      item.chain.toLowerCase() !== 'base' ||
      !isBaseEvidenceAddress(item.token_address) ||
      typeof item.token_symbol !== 'string' ||
      item.token_symbol.length > 64
    ) throw new TypeError('Invalid netflow identity');
    if (isUnknownSet(item, known)) unavailable.push('unrecognized_netflow_fields');
    const rowUnavailable: string[] = [];
    let tokenSectors: readonly string[] | null = null;
    if (item.token_sectors === undefined || item.token_sectors === null) {
      rowUnavailable.push('token_sectors');
    } else if (
      Array.isArray(item.token_sectors) &&
      item.token_sectors.length <= 64 &&
      item.token_sectors.every((sector) => typeof sector === 'string' && sector.length <= 128)
    ) {
      tokenSectors = Object.freeze([...item.token_sectors] as string[]);
    } else {
      rowUnavailable.push('token_sectors');
    }
    const output: SmartMoneyNetflowToken = {
      chain: 'base',
      token_address: item.token_address,
      token_symbol: item.token_symbol,
      net_flow_1h_usd: optionalNumber(item, 'net_flow_1h_usd', rowUnavailable),
      net_flow_24h_usd: optionalNumber(item, 'net_flow_24h_usd', rowUnavailable),
      net_flow_7d_usd: optionalNumber(item, 'net_flow_7d_usd', rowUnavailable),
      net_flow_30d_usd: optionalNumber(item, 'net_flow_30d_usd', rowUnavailable),
      token_sectors: tokenSectors,
      trader_count: optionalNumber(item, 'trader_count', rowUnavailable, true),
      token_age_days: optionalNumber(item, 'token_age_days', rowUnavailable, true),
      market_cap_usd: optionalNumber(item, 'market_cap_usd', rowUnavailable),
    };
    for (const field of rowUnavailable) unavailable.push('data.' + field);
    const asset = evidenceAsset(item.token_address);
    if (asset) structuralRows.push({ asset, fields: [{ name: 'net_flow_1h_usd', state: numberShape(item, 'net_flow_1h_usd') }] });
    return output;
  });
  return {
    data: Object.freeze(data),
    pagination: parsed.pagination,
    warnings: Object.freeze([]),
    warningsAvailable: false,
    unavailableFields: Object.freeze(unavailable.slice(0, 64)),
    structuralRows: Object.freeze(structuralRows),
  };
}

function clientError(error: unknown): NansenClientError {
  if (error instanceof NansenClientError) return error;
  return new NansenClientError('INVALID_RESPONSE');
}

function failureFor(error: NansenClientError): AdapterFailure {
  return Object.freeze({
    code: error.code,
    status: error.status,
    ledgerCode: error.ledgerCode,
  });
}

async function pageResults<T>(
  operation: AdapterResult<T>['operation'],
  maxPages: number,
  fetchPage: PageFetcher<T>,
  requestedAssets?: readonly BaseEvidenceAsset[],
): Promise<AdapterResult<T>> {
  const data: T[] = [];
  const warnings: string[] = [];
  const unavailable: string[] = [];
  const references: PageReference[] = [];
  let pagesRead = 0;
  let warningsAvailable = false;
  const structuralRows: StructuralRow[] = [];
  let finalPage: boolean | null = null;
  let completeness: AdapterCompleteness = 'unknown';
  let failure: AdapterFailure | null = null;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    let received: Awaited<ReturnType<PageFetcher<T>>>;
    try {
      received = await fetchPage(pageNumber);
    } catch (error) {
      const safe = clientError(error);
      failure = failureFor(safe);
      if (safe.attemptId !== null) {
        references.push(Object.freeze({
          attemptId: safe.attemptId,
          page: pageNumber,
          received: false,
          status: safe.status,
          providerRequestId: safe.providerRequestId,
          chargedCredits: safe.chargedCredits,
        }));
      }
      completeness = 'incomplete';
      break;
    }
    pagesRead += 1;
    data.push(...received.page.data);
    warnings.push(...received.page.warnings);
    warningsAvailable = warningsAvailable || received.page.warningsAvailable;
    unavailable.push(...received.page.unavailableFields);
    structuralRows.push(...received.page.structuralRows);
    references.push(Object.freeze({
      ...received.attempt,
      page: pageNumber,
      received: true,
    }));

    const lastPage = received.page.pagination.is_last_page;
    finalPage = lastPage;
    if (warnings.length > 0) {
      completeness = 'incomplete';
      if (lastPage === false && pageNumber < maxPages) continue;
      break;
    }
    if (lastPage === true) {
      completeness = 'complete';
      break;
    }
    if (lastPage === false) {
      if (pageNumber === maxPages) completeness = 'incomplete';
      continue;
    }
    completeness = 'unknown';
    break;
  }

  return Object.freeze({
    operation,
    data: Object.freeze(data),
    warnings: Object.freeze(warnings.slice(0, 40)),
    warningsAvailable,
    completeness,
    pagesRead,
    pageReferences: Object.freeze(references),
    unavailableFields: Object.freeze([...new Set(unavailable)].slice(0, 64)),
    diagnostics: failure === null && pagesRead > 0
      ? evidenceDiagnostics(operation, structuralRows, pagesRead, finalPage, warningsAvailable, warnings.length > 0, requestedAssets)
      : null,
    failure,
  });
}

function validateAsset(value: unknown): BaseEvidenceAsset {
  if (value !== 'USDC' && value !== 'WETH') throw new NansenClientError('INVALID_REQUEST');
  return value;
}

function validateOhlcvWindow(date: TokenOhlcvDateRange): { readonly fromMs: number; readonly toMs: number } {
  const fromMs = Date.parse(date.from);
  const toMs = Date.parse(date.to);
  const isoZoned = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.0+)?(?:Z|[+-]\d{2}:\d{2})$/u;
  if (!isoZoned.test(date.from) || !isoZoned.test(date.to) || !Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) ||
      fromMs % 60_000 !== 0 || toMs % 60_000 !== 0 || toMs - fromMs !== 10 * 60_000 ||
      toMs > Math.floor(Date.now() / 60_000) * 60_000) throw new NansenClientError('INVALID_REQUEST');
  return Object.freeze({ fromMs, toMs });
}
function parseTokenOhlcv(value: unknown, query: TokenOhlcvQuery): TokenOhlcvCandle | null {
  const { fromMs, toMs } = validateOhlcvWindow(query.date);
  if (!isRecord(value) || Object.keys(value).some((key) => !['chain', 'token_address', 'timeframe', 'data', 'truncated', 'truncation_note'].includes(key)) ||
      value.chain !== 'base' || typeof value.token_address !== 'string' ||
      value.token_address.toLowerCase() !== BASE_ASSET_ADDRESSES.USDC.toLowerCase() || value.timeframe !== '1m' ||
      !Array.isArray(value.data) || value.data.length > 50_000) throw new NansenClientError('INVALID_RESPONSE');
  const truncated = value.truncated === undefined ? false : value.truncated;
  if (typeof truncated !== 'boolean' || truncated) throw new NansenClientError('INVALID_RESPONSE');
  if (value.truncation_note !== undefined && value.truncation_note !== null &&
      (typeof value.truncation_note !== 'string' || value.truncation_note.length > 512 || value.truncation_note.length > 0)) {
    throw new NansenClientError('INVALID_RESPONSE');
  }

  const intervals = new Set<number>();
  let newest: TokenOhlcvCandle | null = null;
  let newestMs = -1;
  for (const item of value.data) {
    if (!isRecord(item) || typeof item.interval_start !== 'string' || typeof item.close !== 'number' ||
        !Number.isFinite(item.close) || item.close <= 0 || !isRecord(item.market_cap)) {
      throw new NansenClientError('INVALID_RESPONSE');
    }
    const intervalMs = Date.parse(item.interval_start);
    if (!Number.isSafeInteger(intervalMs) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.0+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(item.interval_start) || intervalMs % 60_000 !== 0 ||
        intervalMs < fromMs || intervalMs >= toMs || intervalMs + 60_000 > toMs || intervals.has(intervalMs)) {
      throw new NansenClientError('INVALID_RESPONSE');
    }
    intervals.add(intervalMs);
    if (intervalMs > newestMs) {
      newestMs = intervalMs;
      newest = Object.freeze({ interval_start: new Date(intervalMs).toISOString(), close: item.close, market_cap: Object.freeze({ ...item.market_cap }) });
    }
  }
  return newest;
}
export function buildNansenAdapters(
  guarded: { readonly post: GuardedPost; readonly maxPages: number },
): NansenClient {
  const pageBound = (options: NansenCallOptions | undefined, maximum: number): number => {
    if (options === undefined) return maximum;
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      throw new NansenClientError('INVALID_REQUEST');
    }
    rejectUnknownKeys(options as Record<string, unknown>, ['signal', 'maxPages']);
    const requested = options.maxPages ?? maximum;
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > maximum) {
      throw new NansenClientError('INVALID_REQUEST');
    }
    return requested;
  };
  const tokenScreener = async (
    query?: TokenScreenerQuery,
    options?: NansenCallOptions,
  ): Promise<AdapterResult<TokenScreenerToken>> => {
    if (query !== undefined && !isRecord(query)) throw new NansenClientError('INVALID_REQUEST');
    const record = (query ?? {}) as Record<string, unknown>;
    rejectUnknownKeys(record, ['asset', 'timeframe', 'per_page']);
    const asset = record.asset ?? 'BASE_PAIR';
    if (asset !== 'BASE_PAIR' && asset !== 'USDC') throw new NansenClientError('INVALID_REQUEST');
    const timeframe = record.timeframe ?? '1h';
    if (typeof timeframe !== 'string' || !SCREENER_TIMEFRAMES.has(timeframe as TokenScreenerTimeframe)) {
      throw new NansenClientError('INVALID_REQUEST');
    }
    const perPage = normalizePageSize(query, ['asset', 'timeframe', 'per_page']);
    const maxPages = pageBound(options, guarded.maxPages);
    const requestedAssets: readonly BaseEvidenceAsset[] = asset === 'USDC' ? ['USDC'] : ['USDC', 'WETH'];
    return pageResults('TOKEN_SCREENER', maxPages, async (page) => {
      const parsed = await guarded.post(
        'TOKEN_SCREENER',
        {
          chains: ['base'],
          timeframe,
          pagination: { page, per_page: perPage },
          filters: asset === 'USDC' ? {
            token_address: BASE_ASSET_ADDRESSES.USDC,
            include_stablecoins: true,
            trader_type: 'all',
          } : {
            token_address: [BASE_ASSET_ADDRESSES.USDC, BASE_ASSET_ADDRESSES.WETH],
            include_stablecoins: true,
            include_native_tokens: true,
          },
        },
        (value) => parseTokenScreener(value, page, perPage, asset),
        options,
      );
      return {
        page: parsed.value,
        attempt: {
          attemptId: parsed.attemptId,
          status: parsed.status,
          providerRequestId: parsed.providerRequestId,
          chargedCredits: parsed.chargedCredits,
        },
      };
    }, requestedAssets);
  };

  const flowIntelligence = async (
    query: FlowIntelligenceQuery,
    options?: NansenCallOptions,
  ): Promise<AdapterResult<FlowIntelligenceRow>> => {
    if (!isRecord(query)) throw new NansenClientError('INVALID_REQUEST');
    rejectUnknownKeys(query, ['asset', 'timeframe']);
    const asset = validateAsset(query.asset);
    const timeframe = query.timeframe ?? '1d';
    if (typeof timeframe !== 'string' || !FLOW_TIMEFRAMES.has(timeframe as FlowIntelligenceTimeframe)) {
      throw new NansenClientError('INVALID_REQUEST');
    }
    pageBound(options, 1);
    return pageResults('FLOW_INTELLIGENCE', 1, async () => {
      const parsed = await guarded.post(
        'FLOW_INTELLIGENCE',
        {
          chain: 'base',
          token_address: BASE_ASSET_ADDRESSES[asset],
          timeframe,
        },
        (value) => parseFlowIntelligence(value, asset),
        options,
      );
      return {
        page: parsed.value,
        attempt: {
          attemptId: parsed.attemptId,
          status: parsed.status,
          providerRequestId: parsed.providerRequestId,
          chargedCredits: parsed.chargedCredits,
        },
      };
    }).then((result) => Object.freeze({
      ...result,
      // Flow Intelligence returns one aggregate response without pagination metadata; warnings are the endpoint's partial-result signal.
      completeness: result.failure !== null || result.warnings.length > 0 ? 'incomplete' : 'complete',
    }));
  };

  const tokenOhlcv = async (
    query: TokenOhlcvQuery,
    options?: NansenCallOptions,
  ): Promise<TokenOhlcvAdapterResult> => {
    if (!isRecord(query) || Object.keys(query).length !== 1 || !isRecord(query.date) ||
        Object.keys(query.date).length !== 2 || typeof query.date.from !== 'string' || typeof query.date.to !== 'string') {
      throw new NansenClientError('INVALID_REQUEST');
    }
    pageBound(options, 1);
    validateOhlcvWindow(query.date);
    try {
      const parsed = await guarded.post(
        'TOKEN_OHLCV',
        { chain: 'base', token_address: BASE_ASSET_ADDRESSES.USDC, timeframe: '1m', date: { from: query.date.from, to: query.date.to } },
        (value) => parseTokenOhlcv(value, query),
        options,
      );
      return Object.freeze({
        operation: 'TOKEN_OHLCV', candle: parsed.value, completeness: 'complete', failure: null,
        pageReferences: Object.freeze([{ attemptId: parsed.attemptId, status: parsed.status, providerRequestId: parsed.providerRequestId,
          chargedCredits: parsed.chargedCredits, page: 1, received: true }]),
      });
    } catch (error) {
      const safe = clientError(error);
      const refs: PageReference[] = safe.attemptId === null ? [] : [Object.freeze({
        attemptId: safe.attemptId, status: safe.status, providerRequestId: safe.providerRequestId,
        chargedCredits: safe.chargedCredits, page: 1, received: false,
      })];
      return Object.freeze({
        operation: 'TOKEN_OHLCV', candle: null, completeness: 'incomplete', failure: failureFor(safe),
        pageReferences: Object.freeze(refs),
      });
    }
  };
  const smartMoneyNetflow = async (
    query?: SmartMoneyNetflowQuery,
    options?: NansenCallOptions,
  ): Promise<AdapterResult<SmartMoneyNetflowToken>> => {
    const perPage = normalizePageSize(query, ['per_page']);
    const maxPages = pageBound(options, guarded.maxPages);
    return pageResults('SMART_MONEY_NETFLOW', maxPages, async (page) => {
      const parsed = await guarded.post(
        'SMART_MONEY_NETFLOW',
        {
          chains: ['base'],
          pagination: { page, per_page: perPage },
          filters: {
            token_address: [BASE_ASSET_ADDRESSES.USDC, BASE_ASSET_ADDRESSES.WETH],
            include_stablecoins: true,
            include_native_tokens: true,
          },
        },
        (value) => parseSmartMoneyNetflow(value, page, perPage),
        options,
      );
      return {
        page: parsed.value,
        attempt: {
          attemptId: parsed.attemptId,
          status: parsed.status,
          providerRequestId: parsed.providerRequestId,
          chargedCredits: parsed.chargedCredits,
        },
      };
    });
  };

  return Object.freeze({ tokenScreener, flowIntelligence, tokenOhlcv, smartMoneyNetflow });
}

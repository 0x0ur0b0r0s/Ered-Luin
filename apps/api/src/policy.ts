import { randomUUID } from 'node:crypto';
import {
  normalizedSignalSchema,
  type Decision,
  type NormalizedSignal,
  type TradeIntent,
  tradeIntentSchema,
} from '@ered-luin/contracts';
import { z } from 'zod';

export const G2_POLICY_VERSION = 'g2-paper-v1' as const;
export const G2_LIMITS = Object.freeze({
  walletValueUsdcMicros: 25_000_000n,
  tradeValueUsdcMicros: 5_000_000n,
  wethPositionUsdcMicros: 10_000_000n,
  dailyLossAbsoluteUsdcMicros: 10_000_000n,
  dailyLossPercentBps: 2_000n,
  maxSlippageBps: 50,
  maxPriceImpactBps: 50,
  maxFeeUsdcMicros: 250_000n,
  intentLifetimeMs: 60_000,
  quoteFreshnessMs: 10_000,
  screenerFreshnessMs: 10 * 60_000,
  smartMoneyFreshnessMs: 35 * 60_000,
  futureClockSkewMs: 2_000,
});

const unsigned = z.string().regex(/^(0|[1-9][0-9]*)$/);
const positive = z.string().regex(/^[1-9][0-9]*$/);
const quoteSchema = z.object({
  source: z.enum(['pool', 'synthetic']),
  chainId: z.literal(8453),
  sellAsset: z.enum(['USDC', 'WETH']),
  buyAsset: z.enum(['USDC', 'WETH']),
  amountIn: positive,
  amountOut: positive,
  quotedAt: z.iso.datetime({ offset: true }),
  slippageBps: z.number().int().min(0).max(100_000),
  priceImpactBps: z.number().int().min(0).max(100_000),
  feeUsdcMicros: unsigned,
  gasFeeNativeWei: unsigned,
}).strict().refine((q) => q.sellAsset !== q.buyAsset, { path: ['buyAsset'], message: 'Quote assets must differ' });
export type PaperQuote = z.infer<typeof quoteSchema>;
const gasValuationQuoteSchema = z.object({
  source: z.enum(['pool', 'synthetic']), chainId: z.literal(8453),
  amountInNativeWei: positive, valueUsdcMicros: positive, quotedAt: z.iso.datetime({ offset: true }),
}).strict();
export type GasValuationQuote = z.infer<typeof gasValuationQuoteSchema>;

export interface PaperAccountSnapshot {
  readonly walletAddress: string;
  readonly version: number;
  readonly usdcBalanceAtomic: string;
  readonly wethBalanceAtomic: string;
  readonly gasBalanceNativeWei: string;
  readonly utcDay: string;
  readonly dailyStartEquityUsdcMicros: string;
  readonly dailyFundingUsdcMicros: string;
}

export interface G2QuoteBundle {
  readonly accountVersion: number;
  /** Fresh WETH→USDC executable quote for the complete current WETH balance. */
  readonly positionQuote: PaperQuote | null;
  /** Fresh executable quote for exactly the submitted input amount. */
  readonly tradeQuote: PaperQuote | null;
  /** Fresh WETH→USDC quote for the complete projected WETH balance after the paper fill. */
  readonly projectedPositionQuote: PaperQuote | null;
  /** Fresh executable native-gas→USDC value for the current and projected fee balance. */
  readonly gasQuote: GasValuationQuote | null;
  readonly projectedGasQuote: GasValuationQuote | null;
  /** Fresh executable USDC valuation for exactly the native gas fee. */
  readonly gasFeeQuote: GasValuationQuote | null;
}

export interface G2EvaluationInput {
  readonly intent: TradeIntent;
  readonly signals: readonly unknown[];
  readonly account: PaperAccountSnapshot | null;
  readonly quotes: G2QuoteBundle | null;
  readonly now: Date;
}

export interface PaperProjection {
  readonly usdcBalanceAtomic: string;
  readonly wethBalanceAtomic: string;
  readonly gasBalanceNativeWei: string;
  readonly dailyStartEquityUsdcMicros: string;
  readonly dailyFundingUsdcMicros: string;
  readonly utcDay: string;
  readonly reservedExposureUsdcMicros: string;
}

export interface G2Evaluation {
  readonly decision: Decision;
  readonly signalIds: readonly string[];
  readonly signalSource: 'nansen' | 'synthetic' | 'none' | 'mixed';
  readonly quoteSource: 'pool' | 'synthetic' | 'none' | 'mixed';
  readonly projection: PaperProjection | null;
}

const USDC_ASSET = 'USDC' as const;
const WETH_ASSET = 'WETH' as const;
const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/u;

type SignalRequirement = {
  readonly endpoint: 'TOKEN_SCREENER' | 'SMART_MONEY_NETFLOW';
  readonly asset: 'USDC' | 'WETH';
  readonly metric: string;
  readonly freshnessMs: number;
};

function timestampMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
}
function micros(value: string): bigint | null {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}
function signedMicros(value: string): bigint | null {
  if (!/^-?(0|[1-9][0-9]*)$/u.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}
function validUtcDay(value: string): boolean {
  if (!UTC_DAY.test(value)) return false;
  const ms = Date.parse(value + 'T00:00:00.000Z');
  return Number.isSafeInteger(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}
function ageOk(value: string, nowMs: number, maxAgeMs: number): boolean {
  const ms = timestampMs(value);
  return ms !== null && ms <= nowMs && nowMs - ms <= maxAgeMs;
}
function normalizeAddress(value: string): string { return value.toLowerCase(); }
function sourceOf(values: readonly ('nansen' | 'synthetic')[]): 'nansen' | 'synthetic' | 'none' | 'mixed' {
  if (values.length === 0) return 'none';
  const first = values[0];
  return values.every((value) => value === first) ? first! : 'mixed';
}
function quoteSourceOf(quotes: readonly ({ readonly source: 'pool' | 'synthetic' } | null)[]): 'pool' | 'synthetic' | 'none' | 'mixed' {
  const sources = quotes.flatMap((quote) => quote ? [quote.source] : []);
  if (sources.length === 0) return 'none';
  return sources.every((value) => value === sources[0]) ? sources[0]! : 'mixed';
}
function makeDecision(
  intent: TradeIntent,
  now: Date,
  status: Decision['status'],
  approvedAmountIn: string | null,
  reasons: readonly string[],
): Decision {
  return {
    decisionId: randomUUID(), intentId: intent.intentId, status,
    evaluatedAt: now.toISOString(), policyVersion: G2_POLICY_VERSION,
    requestedAmountIn: intent.amountIn, approvedAmountIn, reasons: [...reasons],
  };
}
function result(
  intent: TradeIntent,
  now: Date,
  status: Decision['status'],
  reasons: readonly string[],
  options: { approvedAmountIn?: string | null; signalIds?: readonly string[]; signalSource?: G2Evaluation['signalSource']; quoteSource?: G2Evaluation['quoteSource']; projection?: PaperProjection | null } = {},
): G2Evaluation {
  return {
    decision: makeDecision(intent, now, status, options.approvedAmountIn ?? null, reasons),
    signalIds: options.signalIds ?? [],
    signalSource: options.signalSource ?? 'none',
    quoteSource: options.quoteSource ?? 'none',
    projection: options.projection ?? null,
  };
}

function findSignal(
  signals: readonly unknown[],
  requirement: SignalRequirement,
  nowMs: number,
): { signal: NormalizedSignal | null; failure: 'MISSING' | 'AMBIGUOUS' | 'STALE' | 'INCOMPLETE' | 'INVALID' | null } {
  const parsed: NormalizedSignal[] = [];
  let rawMatchCount = 0;
  let hasMalformedMatch = false;
  for (const value of signals) {
    const raw = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
    if (!raw || raw.endpoint !== requirement.endpoint || raw.asset !== requirement.asset || raw.metric !== requirement.metric) continue;
    // Malformed unrelated observations do not affect this key, but every matching raw record must validate.
    rawMatchCount += 1;
    const candidate = normalizedSignalSchema.safeParse(value);
    if (!candidate.success || candidate.data.chainId !== 8453) {
      hasMalformedMatch = true;
      continue;
    }
    parsed.push(candidate.data);
  }
  if (rawMatchCount === 0) return { signal: null, failure: 'MISSING' };
  if (hasMalformedMatch) return { signal: null, failure: 'INVALID' };
  if (parsed.length !== 1) return { signal: null, failure: 'AMBIGUOUS' };
  const signal = parsed[0]!;
  if (signal.quality !== 'COMPLETE' || signal.value === null) return { signal, failure: 'INCOMPLETE' };
  if (signal.unit !== 'usd_micros' || signedMicros(signal.value) === null) return { signal, failure: 'INVALID' };
  if (!ageOk(signal.fetchedAt, nowMs, requirement.freshnessMs) || !ageOk(signal.observedAt, nowMs, requirement.freshnessMs)) return { signal, failure: 'STALE' };
  return { signal, failure: null };
}
function validQuote(
  raw: PaperQuote | null,
  expected: { sellAsset: 'USDC' | 'WETH'; buyAsset: 'USDC' | 'WETH'; amountIn: string },
  nowMs: number,
): PaperQuote | null {
  if (raw === null) return null;
  const parsed = quoteSchema.safeParse(raw);
  if (!parsed.success) return null;
  const quote = parsed.data;
  if (quote.sellAsset !== expected.sellAsset || quote.buyAsset !== expected.buyAsset || quote.amountIn !== expected.amountIn ||
      !ageOk(quote.quotedAt, nowMs, G2_LIMITS.quoteFreshnessMs)) return null;
  return quote;
}
function validGasQuote(raw: GasValuationQuote | null, amountInNativeWei: string, nowMs: number): GasValuationQuote | null {
  if (raw === null) return null;
  const parsed = gasValuationQuoteSchema.safeParse(raw);
  if (!parsed.success || parsed.data.amountInNativeWei !== amountInNativeWei || !ageOk(parsed.data.quotedAt, nowMs, G2_LIMITS.quoteFreshnessMs)) return null;
  return parsed.data;
}function safeUtcDay(now: Date): string | null {
  if (!(now instanceof Date) || !Number.isSafeInteger(now.getTime()) || now.getTime() < 0) return null;
  return now.toISOString().slice(0, 10);
}
function requiredInput(value: unknown): TradeIntent | null {
  const parsed = tradeIntentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Pure G2 policy and paper-fill projection. No network, Nansen client, signer, or chain client is accepted here. */
export function evaluateG2Intent(input: G2EvaluationInput): G2Evaluation {
  const nowMs = input.now instanceof Date ? input.now.getTime() : Number.NaN;
  const nowDay = safeUtcDay(input.now);
  const intent = requiredInput(input.intent);
  if (!intent || !Number.isSafeInteger(nowMs) || nowMs < 0 || nowDay === null) {
    const fallbackIntent = input.intent as TradeIntent;
    return result(fallbackIntent, Number.isFinite(nowMs) ? input.now : new Date(0), 'BLOCK', ['INVALID_POLICY_INPUT']);
  }
  const issuedMs = timestampMs(intent.issuedAt);
  const expiresMs = timestampMs(intent.expiresAt);
  if (issuedMs === null || expiresMs === null || issuedMs > nowMs + G2_LIMITS.futureClockSkewMs || expiresMs <= issuedMs || expiresMs - issuedMs > G2_LIMITS.intentLifetimeMs) {
    return result(intent, input.now, 'BLOCK', ['INVALID_OR_EXPIRED_INTENT_WINDOW']);
  }
  if (nowMs >= expiresMs) return result(intent, input.now, 'BLOCK', ['INTENT_EXPIRED']);
  if (!input.account) return result(intent, input.now, 'REQUIRE_REVIEW', ['PAPER_ACCOUNT_UNAVAILABLE']);
  const account = input.account;
  if (normalizeAddress(account.walletAddress) !== normalizeAddress(intent.walletAddress) || !Number.isSafeInteger(account.version) || account.version < 0 ||
      !validUtcDay(account.utcDay) || micros(account.usdcBalanceAtomic) === null || micros(account.wethBalanceAtomic) === null ||
      micros(account.gasBalanceNativeWei) === null || micros(account.dailyStartEquityUsdcMicros) === null || signedMicros(account.dailyFundingUsdcMicros) === null) {
    return result(intent, input.now, 'REQUIRE_REVIEW', ['PAPER_ACCOUNT_INVALID']);
  }
  const bundle = input.quotes;
  if (!bundle || bundle.accountVersion !== account.version) return result(intent, input.now, 'REQUIRE_REVIEW', ['QUOTE_CONTEXT_UNAVAILABLE_OR_STALE']);
  const accountWeth = BigInt(account.wethBalanceAtomic);
  const accountUsdc = BigInt(account.usdcBalanceAtomic);
  const gasBalance = BigInt(account.gasBalanceNativeWei);
  const currentGasQuote = gasBalance === 0n ? null : validGasQuote(bundle.gasQuote, account.gasBalanceNativeWei, nowMs);
  if (gasBalance > 0n && !currentGasQuote) return result(intent, input.now, 'REQUIRE_REVIEW', ['GAS_VALUATION_QUOTE_UNAVAILABLE_OR_STALE']);
  if (gasBalance === 0n && bundle.gasQuote !== null) return result(intent, input.now, 'REQUIRE_REVIEW', ['GAS_VALUATION_QUOTE_MISMATCH']);
  const gasValue = currentGasQuote ? BigInt(currentGasQuote.valueUsdcMicros) : 0n;
  const currentPositionQuote = accountWeth === 0n ? null : validQuote(bundle.positionQuote, { sellAsset: WETH_ASSET, buyAsset: USDC_ASSET, amountIn: account.wethBalanceAtomic }, nowMs);
  if (accountWeth > 0n && !currentPositionQuote) return result(intent, input.now, 'REQUIRE_REVIEW', ['WETH_VALUATION_QUOTE_UNAVAILABLE_OR_STALE']);
  if (accountWeth === 0n && bundle.positionQuote !== null) return result(intent, input.now, 'REQUIRE_REVIEW', ['WETH_VALUATION_QUOTE_MISMATCH']);
  const positionValue = currentPositionQuote ? BigInt(currentPositionQuote.amountOut) : 0n;
  const currentEquity = accountUsdc + positionValue + gasValue;
  const rolledOver = account.utcDay !== nowDay;
  const dayStart = rolledOver ? currentEquity : BigInt(account.dailyStartEquityUsdcMicros);
  const funding = rolledOver ? 0n : BigInt(account.dailyFundingUsdcMicros);
  if (dayStart <= 0n) return result(intent, input.now, 'BLOCK', ['NONPOSITIVE_DAILY_START_EQUITY']);
  const currentPnl = currentEquity - dayStart - funding;
  const dailyLossLimit = dayStart * G2_LIMITS.dailyLossPercentBps / 10_000n < G2_LIMITS.dailyLossAbsoluteUsdcMicros
    ? dayStart * G2_LIMITS.dailyLossPercentBps / 10_000n : G2_LIMITS.dailyLossAbsoluteUsdcMicros;
  if (currentEquity > G2_LIMITS.walletValueUsdcMicros) return result(intent, input.now, 'BLOCK', ['WALLET_VALUE_LIMIT_EXCEEDED']);
  if (currentPnl < -dailyLossLimit) return result(intent, input.now, 'BLOCK', ['DAILY_LOSS_LIMIT_EXCEEDED']);
  const walletSources: Array<'nansen' | 'synthetic'> = [];
  const screenerReqs: readonly SignalRequirement[] = [
    { endpoint: 'TOKEN_SCREENER', asset: 'USDC', metric: 'price_usd', freshnessMs: G2_LIMITS.screenerFreshnessMs },
    { endpoint: 'TOKEN_SCREENER', asset: 'WETH', metric: 'price_usd', freshnessMs: G2_LIMITS.screenerFreshnessMs },
  ];
  const requiredSignals = screenerReqs.map((requirement) => findSignal(input.signals, requirement, nowMs));
  const signalIds = requiredSignals.flatMap((candidate) => candidate.signal ? [candidate.signal.signalId] : []);
  for (const candidate of requiredSignals) if (candidate.signal) walletSources.push(candidate.signal.provider);
  const badSignal = requiredSignals.find((candidate) => candidate.failure !== null);
  if (badSignal) return result(intent, input.now, 'REQUIRE_REVIEW', [`SCREENER_${badSignal.failure}`], { signalIds, signalSource: sourceOf(walletSources) });
  for (const candidate of requiredSignals) {
    const value = BigInt(candidate.signal!.value!);
    if (value <= 0n) return result(intent, input.now, 'REQUIRE_REVIEW', ['NONPOSITIVE_SPOT_PRICE'], { signalIds, signalSource: sourceOf(walletSources) });
  }
  const increasesWeth = intent.buyAsset === WETH_ASSET;
  if (increasesWeth) {
    const flow = findSignal(input.signals, {
      endpoint: 'SMART_MONEY_NETFLOW', asset: WETH_ASSET, metric: 'net_flow_1h_usd', freshnessMs: G2_LIMITS.smartMoneyFreshnessMs,
    }, nowMs);
    if (flow.signal) { signalIds.push(flow.signal.signalId); walletSources.push(flow.signal.provider); }
    if (flow.failure) return result(intent, input.now, 'REQUIRE_REVIEW', [`SMART_MONEY_NETFLOW_${flow.failure}`], { signalIds, signalSource: sourceOf(walletSources) });
    if (BigInt(flow.signal!.value!) <= 0n) return result(intent, input.now, 'BLOCK', ['NONPOSITIVE_WETH_NETFLOW'], { signalIds, signalSource: sourceOf(walletSources) });
  }
  const tradeQuote = validQuote(bundle.tradeQuote, { sellAsset: intent.sellAsset, buyAsset: intent.buyAsset, amountIn: intent.amountIn }, nowMs);
  if (!tradeQuote) return result(intent, input.now, 'REQUIRE_REVIEW', ['TRADE_QUOTE_UNAVAILABLE_OR_STALE'], { signalIds, signalSource: sourceOf(walletSources) });
  const reportedFeeUsdcMicros = BigInt(tradeQuote.feeUsdcMicros);
  const gasFeeNative = BigInt(tradeQuote.gasFeeNativeWei);
  const gasFeeQuote = gasFeeNative === 0n ? null : validGasQuote(bundle.gasFeeQuote, tradeQuote.gasFeeNativeWei, nowMs);
  const quoteSources: ({ readonly source: 'pool' | 'synthetic' })[] = [currentPositionQuote, currentGasQuote, tradeQuote, gasFeeQuote].filter((quote): quote is PaperQuote | GasValuationQuote => quote !== null);
  if (tradeQuote.slippageBps > G2_LIMITS.maxSlippageBps) return result(intent, input.now, 'BLOCK', ['SLIPPAGE_LIMIT_EXCEEDED'], { signalIds, signalSource: sourceOf(walletSources), quoteSource: quoteSourceOf(quoteSources) });
  if (tradeQuote.priceImpactBps > G2_LIMITS.maxPriceImpactBps) return result(intent, input.now, 'BLOCK', ['PRICE_IMPACT_LIMIT_EXCEEDED'], { signalIds, signalSource: sourceOf(walletSources), quoteSource: quoteSourceOf(quoteSources) });
  if (reportedFeeUsdcMicros > G2_LIMITS.maxFeeUsdcMicros) return result(intent, input.now, 'BLOCK', ['NETWORK_FEE_LIMIT_EXCEEDED'], { signalIds, signalSource: sourceOf(walletSources), quoteSource: quoteSourceOf(quoteSources) });
  if (gasFeeNative > gasBalance) return result(intent, input.now, 'BLOCK', ['INSUFFICIENT_GAS_BALANCE'], { signalIds, signalSource: sourceOf(walletSources), quoteSource: quoteSourceOf(quoteSources) });
  if (gasFeeNative === 0n) {
    if (reportedFeeUsdcMicros !== 0n || bundle.gasFeeQuote !== null) return result(intent, input.now, 'REQUIRE_REVIEW', ['GAS_FEE_VALUATION_MISMATCH'], { signalIds, signalSource: sourceOf(walletSources), quoteSource: quoteSourceOf(quoteSources) });
  } else {
    if (!gasFeeQuote) return result(intent, input.now, 'REQUIRE_REVIEW', ['GAS_FEE_VALUATION_QUOTE_UNAVAILABLE_OR_STALE'], { signalIds, signalSource: sourceOf(walletSources), quoteSource: quoteSourceOf(quoteSources) });
    const verifiedFeeUsdcMicros = BigInt(gasFeeQuote.valueUsdcMicros);
    if (verifiedFeeUsdcMicros > G2_LIMITS.maxFeeUsdcMicros) return result(intent, input.now, 'BLOCK', ['NETWORK_FEE_LIMIT_EXCEEDED'], { signalIds, signalSource: sourceOf(walletSources), quoteSource: quoteSourceOf(quoteSources) });
    if (verifiedFeeUsdcMicros !== reportedFeeUsdcMicros) return result(intent, input.now, 'REQUIRE_REVIEW', ['GAS_FEE_VALUATION_MISMATCH'], { signalIds, signalSource: sourceOf(walletSources), quoteSource: quoteSourceOf(quoteSources) });
  }
  const intentAmount = BigInt(intent.amountIn);
  const tradeValue = intent.sellAsset === USDC_ASSET ? intentAmount : BigInt(tradeQuote.amountOut);
  if (tradeValue <= 0n) return result(intent, input.now, 'BLOCK', ['ZERO_EXECUTABLE_TRADE_VALUE'], { signalIds, signalSource: sourceOf(walletSources), quoteSource: quoteSourceOf(quoteSources) });
  let maxInput = intentAmount;
  const inputBalance = intent.sellAsset === USDC_ASSET ? accountUsdc : accountWeth;
  if (inputBalance < maxInput) maxInput = inputBalance;
  const maxTradeInput = intent.sellAsset === USDC_ASSET ? G2_LIMITS.tradeValueUsdcMicros : intentAmount * G2_LIMITS.tradeValueUsdcMicros / tradeValue;
  if (maxTradeInput < maxInput) maxInput = maxTradeInput;
  if (increasesWeth) {
    const remainingPositionLimit = G2_LIMITS.wethPositionUsdcMicros > positionValue ? G2_LIMITS.wethPositionUsdcMicros - positionValue : 0n;
    if (remainingPositionLimit < maxInput) maxInput = remainingPositionLimit;
  }
  if (maxInput <= 0n) return result(intent, input.now, 'BLOCK', ['NO_REMAINING_RISK_CAPACITY'], { signalIds, signalSource: sourceOf(walletSources), quoteSource: quoteSourceOf(quoteSources) });
  if (maxInput < intentAmount) {
    return result(intent, input.now, 'RESIZE', ['TRADE_BALANCE_OR_POSITION_LIMIT'], {
      approvedAmountIn: maxInput.toString(), signalIds, signalSource: sourceOf(walletSources), quoteSource: quoteSourceOf(quoteSources),
    });
  }
  if (tradeValue > G2_LIMITS.tradeValueUsdcMicros) return result(intent, input.now, 'RESIZE', ['TRADE_SIZE_LIMIT'], {
    approvedAmountIn: maxTradeInput.toString(), signalIds, signalSource: sourceOf(walletSources), quoteSource: quoteSourceOf(quoteSources),
  });
  const requestedProjectedWeth = intent.buyAsset === WETH_ASSET
    ? accountWeth + BigInt(tradeQuote.amountOut)
    : accountWeth - intentAmount;
  if (requestedProjectedWeth < 0n) return result(intent, input.now, 'REQUIRE_REVIEW', ['INSUFFICIENT_WETH_BALANCE']);
  const projectedPositionQuote = requestedProjectedWeth === 0n ? null : validQuote(bundle.projectedPositionQuote, {
    sellAsset: WETH_ASSET, buyAsset: USDC_ASSET, amountIn: requestedProjectedWeth.toString(),
  }, nowMs);
  if (requestedProjectedWeth > 0n && !projectedPositionQuote) return result(intent, input.now, 'REQUIRE_REVIEW', ['PROJECTED_WETH_VALUATION_UNAVAILABLE_OR_STALE'], {
    signalIds, signalSource: sourceOf(walletSources), quoteSource: quoteSourceOf([...quoteSources, currentPositionQuote, bundle.projectedPositionQuote]),
  });
  if (requestedProjectedWeth === 0n && bundle.projectedPositionQuote !== null) return result(intent, input.now, 'REQUIRE_REVIEW', ['PROJECTED_WETH_VALUATION_MISMATCH']);
  if (projectedPositionQuote) quoteSources.push(projectedPositionQuote);
  const projectedPositionValue = projectedPositionQuote ? BigInt(projectedPositionQuote.amountOut) : 0n;
  const projectedUsdc = intent.sellAsset === USDC_ASSET
    ? accountUsdc - intentAmount
    : accountUsdc + BigInt(tradeQuote.amountOut);
  const projectedGasBalance = gasBalance - gasFeeNative;
  const projectedGasQuote = projectedGasBalance === 0n ? null : validGasQuote(bundle.projectedGasQuote, projectedGasBalance.toString(), nowMs);
  if (projectedGasBalance > 0n && !projectedGasQuote) return result(intent, input.now, 'REQUIRE_REVIEW', ['PROJECTED_GAS_VALUATION_UNAVAILABLE_OR_STALE'], { signalIds, signalSource: sourceOf(walletSources), quoteSource: quoteSourceOf([...quoteSources, projectedPositionQuote]) });
  if (projectedGasBalance === 0n && bundle.projectedGasQuote !== null) return result(intent, input.now, 'REQUIRE_REVIEW', ['PROJECTED_GAS_VALUATION_MISMATCH']);
  if (projectedGasQuote) quoteSources.push(projectedGasQuote);
  const projectedGasValue = projectedGasQuote ? BigInt(projectedGasQuote.valueUsdcMicros) : 0n;
  const projectedEquity = projectedUsdc + projectedPositionValue + projectedGasValue;
  const projectedPnl = projectedEquity - dayStart - funding;
  if (projectedEquity > G2_LIMITS.walletValueUsdcMicros) return result(intent, input.now, 'BLOCK', ['WALLET_VALUE_LIMIT_EXCEEDED'], {
    signalIds, signalSource: sourceOf(walletSources), quoteSource: quoteSourceOf(quoteSources),
  });
  if (projectedPositionValue > G2_LIMITS.wethPositionUsdcMicros) {
    const addedPositionValue = projectedPositionValue - positionValue;
    const remainingPosition = G2_LIMITS.wethPositionUsdcMicros > positionValue ? G2_LIMITS.wethPositionUsdcMicros - positionValue : 0n;
    if (addedPositionValue <= 0n || remainingPosition <= 0n || intent.sellAsset !== USDC_ASSET) return result(intent, input.now, 'REQUIRE_REVIEW', ['WETH_POSITION_QUOTE_INCONSISTENT']);
    const positionInput = intentAmount * remainingPosition / addedPositionValue;
    const approved = positionInput < maxInput ? positionInput : maxInput;
    if (approved <= 0n) return result(intent, input.now, 'BLOCK', ['NO_REMAINING_WETH_POSITION_CAPACITY']);
    return result(intent, input.now, 'RESIZE', ['WETH_POSITION_LIMIT'], {
      approvedAmountIn: approved.toString(), signalIds, signalSource: sourceOf(walletSources), quoteSource: quoteSourceOf(quoteSources),
    });
  }
  if (currentPnl < -dailyLossLimit || projectedPnl < -dailyLossLimit) return result(intent, input.now, 'BLOCK', ['DAILY_LOSS_LIMIT_EXCEEDED'], {
    signalIds, signalSource: sourceOf(walletSources), quoteSource: quoteSourceOf(quoteSources),
  });
  const projection: PaperProjection = {
    usdcBalanceAtomic: projectedUsdc.toString(), wethBalanceAtomic: requestedProjectedWeth.toString(),
    gasBalanceNativeWei: projectedGasBalance.toString(), dailyStartEquityUsdcMicros: dayStart.toString(),
    dailyFundingUsdcMicros: funding.toString(), utcDay: nowDay,
    reservedExposureUsdcMicros: tradeValue.toString(),
  };
  return result(intent, input.now, 'ALLOW', ['ALL_G2_CONTROLS_PASSED'], {
    approvedAmountIn: intent.amountIn, signalIds, signalSource: sourceOf(walletSources),
    quoteSource: quoteSourceOf(quoteSources), projection,
  });
}

export function validateGasValuationQuote(value: unknown): GasValuationQuote | null {
  const parsed = gasValuationQuoteSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}export function validatePaperQuote(value: unknown): PaperQuote | null {
  const parsed = quoteSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

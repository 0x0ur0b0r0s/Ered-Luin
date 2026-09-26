import { randomUUID } from 'node:crypto';
import { evaluateG2Intent } from '../../apps/api/dist/policy.js';
import { isWithinSignalFreshness, MAX_OBSERVATION_HISTORY_QUERY_LIMIT } from '../../packages/nansen/dist/index.js';

const WALLET = '0x0000000000000000000000000000000000000011';
const E18 = 10n ** 18n;
const WETH_USD_MICROS = 2_000_000n;
const SIGNALS = [
  ['TOKEN_SCREENER', 'price_usd'],
  ['FLOW_INTELLIGENCE', 'smart_trader_net_flow_usd'],
  ['SMART_MONEY_NETFLOW', 'net_flow_1h_usd'],
];
function signalFor(signals, endpoint, asset, metric) {
  return signals.find((signal) => signal.endpoint === endpoint && signal.asset === asset && signal.metric === metric) ?? null;
}
function classify(value) {
  if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]*)$/u.test(value)) return 'UNAVAILABLE';
  const numeric = BigInt(value);
  return numeric > 0n ? 'POSITIVE' : numeric < 0n ? 'NEGATIVE' : 'ZERO';
}
function changeFrom(previous, current) {
  if (previous === null || current === null || !/^-?(0|[1-9][0-9]*)$/u.test(previous) || !/^-?(0|[1-9][0-9]*)$/u.test(current)) return 'UNAVAILABLE';
  const a = BigInt(previous); const b = BigInt(current);
  return b > a ? 'INCREASED' : b < a ? 'DECREASED' : 'UNCHANGED';
}
function syntheticPolicyContext(atMs) {
  const now = new Date(atMs);
  const issuedAt = new Date(atMs - 1_000).toISOString();
  const expiresAt = new Date(atMs + 59_000).toISOString();
  const amountIn = '1000000';
  const amountOut = '500000000000000000';
  const quote = (sellAsset, buyAsset, amount, output) => ({
    source: 'synthetic', chainId: 8453, sellAsset, buyAsset, amountIn: amount, amountOut: output,
    quotedAt: now.toISOString(), slippageBps: 10, priceImpactBps: 10, feeUsdcMicros: '0', gasFeeNativeWei: '0',
  });
  const trade = {
    intentId: randomUUID(), chainId: 8453, walletAddress: WALLET, sellAsset: 'USDC', buyAsset: 'WETH', amountIn,
    issuedAt, expiresAt,
  };
  const account = {
    walletAddress: WALLET, version: 0, usdcBalanceAtomic: '20000000', wethBalanceAtomic: '0', gasBalanceNativeWei: '0',
    utcDay: now.toISOString().slice(0, 10), dailyStartEquityUsdcMicros: '20000000', dailyFundingUsdcMicros: '0',
  };
  const projectedWeth = BigInt(amountOut);
  const projectedValue = (projectedWeth * WETH_USD_MICROS / E18).toString();
  const quotes = {
    accountVersion: 0, positionQuote: null,
    tradeQuote: quote('USDC', 'WETH', amountIn, amountOut),
    projectedPositionQuote: quote('WETH', 'USDC', amountOut, projectedValue),
    gasQuote: null, projectedGasQuote: null, gasFeeQuote: null,
  };
  return { intent: trade, account, quotes, now };
}
function direction(signals, endpoint, metric, previous) {
  const signal = signalFor(signals, endpoint, 'WETH', metric);
  const key = endpoint + ':' + metric;
  const value = signal?.quality === 'COMPLETE' ? signal.value : null;
  return { key, sign: classify(value), change: changeFrom(previous.get(key) ?? null, value), valueForNext: value };
}

/** Reads only persisted Nansen history and exercises the existing deterministic G2 paper policy with synthetic quotes/account context. */
export function summarizeNansenHistory(store, { now = () => new Date() } = {}) {
  if (!store || typeof store.getLatestSnapshots !== 'function' || typeof store.listHistory !== 'function' || typeof now !== 'function') throw new Error('SUMMARY_INPUT_INVALID');
  const latest = store.getLatestSnapshots('nansen');
  const histories = new Map(latest.map((snapshot) => [snapshot.operation, store.listHistory({ cacheKey: snapshot.cacheKey, limit: MAX_OBSERVATION_HISTORY_QUERY_LIMIT })
    .filter((item) => item.source === 'nansen')
    .sort((a, b) => Date.parse(a.acquiredAt) - Date.parse(b.acquiredAt))]));
  const points = [...new Set([...histories.values()].flatMap((history) => history.map((snapshot) => snapshot.acquiredAt)))].sort((a, b) => Date.parse(a) - Date.parse(b));
  const previous = new Map();
  const timeline = [];
  for (const at of points) {
    const atMs = Date.parse(at);
    const selected = [];
    const freshness = {};
    for (const [operation, history] of histories) {
      const snapshot = history.filter((entry) => Date.parse(entry.acquiredAt) <= atMs).at(-1) ?? null;
      if (!snapshot) { freshness[operation] = { ageMs: null, fresh: false, completeness: 'missing' }; continue; }
      selected.push(snapshot);
      const acquiredMs = Date.parse(snapshot.acquiredAt);
      const signalFetchedAt = snapshot.signals[0]?.fetchedAt ?? snapshot.acquiredAt;
      const fetchedMs = Date.parse(signalFetchedAt);
      const ageMs = atMs - acquiredMs;
      freshness[operation] = {
        ageMs, fresh: isWithinSignalFreshness(operation, fetchedMs, atMs), completeness: snapshot.completeness,
      };
    }
    const signals = selected.flatMap((snapshot) => snapshot.signals);
    const wethSignals = SIGNALS.map(([endpoint, metric]) => {
      const item = direction(signals, endpoint, metric, previous);
      previous.set(item.key, item.valueForNext);
      return Object.freeze({ endpoint, metric, sign: item.sign, change: item.change });
    });
    const context = syntheticPolicyContext(atMs);
    const evaluation = evaluateG2Intent({ ...context, signals });
    timeline.push(Object.freeze({
      at, freshness: Object.freeze(freshness), wethSignals: Object.freeze(wethSignals),
      policy: Object.freeze({ status: evaluation.decision.status, reasons: evaluation.decision.reasons, signalSource: evaluation.signalSource, quoteSource: evaluation.quoteSource }),
    }));
  }
  const current = now();
  const currentMs = current instanceof Date ? current.getTime() : NaN;
  if (!Number.isSafeInteger(currentMs) || currentMs < 0) throw new Error('SUMMARY_CLOCK_INVALID');
  const counts = {};
  for (const [operation, history] of histories) counts[operation] = history.length;
  return Object.freeze({
    mode: 'OFFLINE_HISTORY_SUMMARY', providerCalls: 0, credentialRead: false, storeMutation: false,
    summaryAt: current.toISOString(), source: 'persisted Nansen snapshots only; no live evidence was fetched',
    policyContext: 'Existing G2 deterministic paper policy; synthetic account, intent and quotes; no execution is proposed.',
    snapshotsByOperation: Object.freeze(counts), timeline: Object.freeze(timeline),
  });
}
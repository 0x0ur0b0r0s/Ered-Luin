import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Decision, ExecutionTransactionEnvelope, NormalizedSignal, TradeIntent } from '@ered-luin/contracts';
import {
  BASE_ASSET_ADDRESSES, NANSEN_COST_PROFILE_VERSION, createNansenClient, createNansenQueryManager,
  initializeCreditLedger, initializeNansenObservationStore,
  type NansenHttpRequest, type NansenHttpResponse, type NansenHttpTransport, type NansenManagedQuery,
} from '@ered-luin/nansen';
import { createApiApp, type G2DataProvider } from './api.js';
import { initializePaperStore, openPaperStore, PaperStore } from './paper-store.js';
import { openExecutionStore } from './execution-store.js';
import { evaluateG2Intent, G2_POLICY_VERSION, type G2QuoteBundle, type PaperAccountSnapshot, type PaperQuote } from './policy.js';

const now = new Date('2026-09-23T18:30:00.000Z');
const wallet = '0x0000000000000000000000000000000000000011';
const directories: string[] = [];
const stores: PaperStore[] = [];
const E18 = 10n ** 18n;
const WETH_USD_MICROS = 2_000_000_000n;
function syntheticSignals(flow = '1250000'): NormalizedSignal[] {
  const base = {
    provider: 'synthetic' as const, chainId: 8453 as const, observedAt: new Date(now.getTime() - 1000).toISOString(),
    fetchedAt: new Date(now.getTime() - 1500).toISOString(), quality: 'COMPLETE' as const,
    unit: 'usd_micros' as const, provenanceId: 'fixture:g2-synthetic-only-v1',
  };
  return [
    { ...base, signalId: randomUUID(), endpoint: 'TOKEN_SCREENER', asset: 'USDC', metric: 'price_usd', value: '1000000' },
    { ...base, signalId: randomUUID(), endpoint: 'TOKEN_SCREENER', asset: 'WETH', metric: 'price_usd', value: WETH_USD_MICROS.toString() },
    { ...base, signalId: randomUUID(), endpoint: 'SMART_MONEY_NETFLOW', asset: 'WETH', metric: 'net_flow_1h_usd', value: flow },
  ];
}
function intent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return {
    intentId: randomUUID(), chainId: 8453, walletAddress: wallet, sellAsset: 'USDC', buyAsset: 'WETH', amountIn: '4000000',
    issuedAt: new Date(now.getTime() - 1000).toISOString(), expiresAt: new Date(now.getTime() + 59_000).toISOString(), ...overrides,
  };
}
function wethValue(amount: string): string {
  const value = BigInt(amount) * WETH_USD_MICROS / E18;
  return value === 0n && BigInt(amount) > 0n ? '1' : value.toString();
}
function quote(sellAsset: 'USDC' | 'WETH', buyAsset: 'USDC' | 'WETH', amountIn: string, amountOut: string, overrides: Partial<PaperQuote> = {}): PaperQuote {
  return {
    source: 'synthetic', chainId: 8453, sellAsset, buyAsset, amountIn, amountOut,
    quotedAt: now.toISOString(), slippageBps: 10, priceImpactBps: 10, feeUsdcMicros: '10000', gasFeeNativeWei: '5000000000000', ...overrides,
  };
}
function quotesFor(trade: TradeIntent, account: PaperAccountSnapshot, overrides: Partial<G2QuoteBundle> = {}): G2QuoteBundle {
  const amountIn = BigInt(trade.amountIn);
  const amountOut = trade.sellAsset === 'USDC'
    ? (amountIn * E18 / WETH_USD_MICROS).toString()
    : (amountIn * WETH_USD_MICROS / E18).toString();
  const tradeQuote = overrides.tradeQuote ?? quote(trade.sellAsset, trade.buyAsset, trade.amountIn, amountOut);
  const wethBefore = BigInt(account.wethBalanceAtomic);
  const wethAfter = trade.buyAsset === 'WETH' ? wethBefore + BigInt(amountOut) : wethBefore - amountIn;
  const positionQuote = wethBefore === 0n ? null : quote('WETH', 'USDC', wethBefore.toString(), wethValue(wethBefore.toString()));
  const projectedPositionQuote = wethAfter === 0n ? null : quote('WETH', 'USDC', wethAfter.toString(), wethValue(wethAfter.toString()));
  const gasBefore = BigInt(account.gasBalanceNativeWei);
  const gasFee = BigInt(tradeQuote.gasFeeNativeWei);
  const gasAfter = gasBefore >= gasFee ? gasBefore - gasFee : 0n;
  const gasQuote = gasBefore === 0n ? null : {
    source: 'synthetic' as const, chainId: 8453 as const, amountInNativeWei: gasBefore.toString(),
    valueUsdcMicros: wethValue(gasBefore.toString()), quotedAt: now.toISOString(),
  };
  const projectedGasQuote = gasAfter === 0n ? null : {
    source: 'synthetic' as const, chainId: 8453 as const, amountInNativeWei: gasAfter.toString(),
    valueUsdcMicros: wethValue(gasAfter.toString()), quotedAt: now.toISOString(),
  };
  const gasFeeQuote = gasFee === 0n ? null : {
    source: 'synthetic' as const, chainId: 8453 as const, amountInNativeWei: gasFee.toString(),
    valueUsdcMicros: wethValue(gasFee.toString()), quotedAt: now.toISOString(),
  };
  return { accountVersion: account.version, positionQuote, tradeQuote, projectedPositionQuote, gasQuote, projectedGasQuote, gasFeeQuote, ...overrides };
}
function setup(options: { usdc?: string; weth?: string; gas?: string; start?: string; funding?: string; flow?: string; provider?: G2DataProvider } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ered-luin-g2-'));
  directories.push(directory);
  const store = initializePaperStore({ databasePath: join(directory, 'paper.sqlite'), clock: () => now });
  stores.push(store);
  const weth = options.weth ?? '0';
  const gas = options.gas ?? '500000000000000';
  const usdc = options.usdc ?? '20000000';
  const equity = options.start ?? (BigInt(usdc) + BigInt(wethValue(gas)) + BigInt(wethValue(weth))).toString();
  store.createAccount({ walletAddress: wallet, usdcBalanceAtomic: usdc, wethBalanceAtomic: weth,
    gasBalanceNativeWei: gas, dailyStartEquityUsdcMicros: equity,
    dailyFundingUsdcMicros: options.funding ?? '0', utcDay: '2026-09-23' });
  const provider = options.provider ?? {
    getSignals: () => syntheticSignals(options.flow),
    getQuoteBundle: (trade: TradeIntent, account: PaperAccountSnapshot) => quotesFor(trade, account),
  } satisfies G2DataProvider;
  const app = createApiApp({ store, dataProvider: provider, clock: () => now });
  return { app, store, provider, directory };
}
async function postIntent(app: ReturnType<typeof createApiApp>, value: object) {
  return await app.inject({ method: 'POST', url: '/v1/intents/evaluate', payload: value });
}
afterEach(async () => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* App hooks may already close it. */ } }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('G2 deterministic policy and paper workflow', () => {
  it('requires USDC spot but does not require a USDC netflow row for a positive WETH buy', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ered-luin-d2j-evidence-'));
    directories.push(directory);
    const ledgerOptions = {
      databasePath: join(directory, 'ledger.sqlite'), budgetId: 'd2j-synthetic-only', limitCredits: 7,
      costProfileVersion: NANSEN_COST_PROFILE_VERSION, clock: () => now,
    };
    const storeOptions = { databasePath: join(directory, 'observations.sqlite'), storeId: 'd2j-synthetic-only', clock: () => now };
    const ledger = initializeCreditLedger(ledgerOptions);
    const observationStore = initializeNansenObservationStore(storeOptions);
    const screener = JSON.parse(readFileSync(new URL('../../../packages/nansen/fixtures/token-screener.synthetic.json', import.meta.url), 'utf8')) as { data: Array<Record<string, unknown>>; pagination: unknown };
    const netflow = JSON.parse(readFileSync(new URL('../../../packages/nansen/fixtures/smart-money-netflow.synthetic.json', import.meta.url), 'utf8')) as { data: Array<Record<string, unknown>>; pagination: unknown };
    const noUsdcNetflow = { ...netflow, data: netflow.data.filter((row) => row.token_address !== BASE_ASSET_ADDRESSES.USDC) };
    const noUsdcScreener = { ...screener, data: screener.data.filter((row) => row.token_address !== BASE_ASSET_ADDRESSES.USDC) };
    const replies = [
      { body: screener, charge: 1 },
      { body: noUsdcNetflow, charge: 5 },
      { body: noUsdcScreener, charge: 1 },
    ];
    const requests: NansenHttpRequest[] = [];
    const transport: NansenHttpTransport = async (request) => {
      requests.push(request);
      const next = replies.shift();
      if (!next) throw new Error('synthetic-only reply queue exhausted');
      const body: NansenHttpResponse = {
        status: 200, headers: { 'X-Nansen-Credits-Used': String(next.charge) },
        body: new TextEncoder().encode(JSON.stringify(next.body)),
      };
      return body;
    };
    const client = createNansenClient({ ledger, enabled: true, apiKey: 'synthetic-only-g2-key', transport, maxPages: 1 });
    const manager = createNansenQueryManager({ client, store: observationStore, enabled: true, maxPageBound: 1, maxRetryBound: 0, clock: () => now });
    const screenerQuery = (perPage: number) => ({ operation: 'TOKEN_SCREENER', asset: 'BASE_PAIR', timeframe: '1h', pageBound: 1, retryBound: 0, perPage }) as const satisfies NansenManagedQuery;
    const netflowQuery = { operation: 'SMART_MONEY_NETFLOW', asset: 'BASE_PAIR', timeframe: '1h', pageBound: 1, retryBound: 0, perPage: 100 } as const satisfies NansenManagedQuery;
    const account = {
      walletAddress: wallet, version: 0, usdcBalanceAtomic: '20000000', wethBalanceAtomic: '0', gasBalanceNativeWei: '500000000000000',
      utcDay: '2026-09-23', dailyStartEquityUsdcMicros: '21000000', dailyFundingUsdcMicros: '0',
    } satisfies PaperAccountSnapshot;
    const trade = intent();
    try {
      const completeSpot = await manager.query(screenerQuery(100));
      const missingUsdcFlow = await manager.query(netflowQuery);
      expect(missingUsdcFlow.completeness).toBe('complete');
      expect(missingUsdcFlow.quality).toBe('PARTIAL');
      expect(missingUsdcFlow.observations.find((signal) => signal.asset === 'USDC')).toMatchObject({ quality: 'MISSING', value: null });
      expect(missingUsdcFlow.observations.find((signal) => signal.asset === 'WETH')).toMatchObject({ quality: 'COMPLETE', value: '23000000000' });
      const withUsdcPrice = evaluateG2Intent({ intent: trade, signals: [...completeSpot.observations, ...missingUsdcFlow.observations],
        account, quotes: quotesFor(trade, account), now });
      expect(withUsdcPrice.decision.status).toBe('ALLOW');

      const missingUsdcPrice = await manager.query(screenerQuery(99));
      const withoutUsdcPrice = evaluateG2Intent({ intent: trade, signals: [...missingUsdcPrice.observations, ...missingUsdcFlow.observations],
        account, quotes: quotesFor(trade, account), now });
      expect(withoutUsdcPrice.decision.status).toBe('REQUIRE_REVIEW');
      expect(withoutUsdcPrice.decision.reasons).toContain('SCREENER_INCOMPLETE');
      expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
        '/api/v1/token-screener', '/api/v1/smart-money/netflow', '/api/v1/token-screener',
      ]);
      expect(JSON.parse(requests[0]!.body)).toMatchObject({
        chains: ['base'], timeframe: '1h', pagination: { page: 1, per_page: 100 },
        filters: { token_address: [BASE_ASSET_ADDRESSES.USDC, BASE_ASSET_ADDRESSES.WETH], include_stablecoins: true, include_native_tokens: true },
      });
      expect(ledger.getSnapshot()).toMatchObject({ allocatedCredits: 7, reportedChargeCount: 3, pendingAttemptCount: 0 });
    } finally {
      observationStore.close();
      ledger.close();
    }
  });

  it('persists an ALLOW decision, transient exposure reservation, simulated paper fill, and account update', async () => {
    const { app, store } = setup();
    const trade = intent();
    const response = await postIntent(app, trade);
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.record.decision.status).toBe('ALLOW');
    expect(body.record.decision.policyVersion).toBe(G2_POLICY_VERSION);
    expect(body.record.execution).toMatchObject({ mode: 'PAPER', status: 'SIMULATED', transactionHash: null });
    expect(body.record.signalSource).toBe('synthetic');
    expect(body.record.quoteSource).toBe('synthetic');
    expect(body.record.reservationId).toMatch(/^[0-9a-f-]{36}$/iu);
    const account = store.getAccount(wallet)!;
    expect(account.version).toBe(1);
    expect(account.usdcBalanceAtomic).toBe('16000000');
    expect(BigInt(account.wethBalanceAtomic)).toBeGreaterThan(0n);
    const fetched = await app.inject({ method: 'GET', url: `/v1/intents/${trade.intentId}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().execution.status).toBe('SIMULATED');
    await app.close();
  });

  it('changes the buy decision when the fresh Nansen observation changes, while zero and missing remain distinct', () => {
    const trade = intent();
    const account = {
      walletAddress: wallet, version: 0, usdcBalanceAtomic: '20000000', wethBalanceAtomic: '0', gasBalanceNativeWei: '500000000000000',
      utcDay: '2026-09-23', dailyStartEquityUsdcMicros: '21000000', dailyFundingUsdcMicros: '0',
    } satisfies PaperAccountSnapshot;
    const quotes = quotesFor(trade, account);
    const positive = evaluateG2Intent({ intent: trade, signals: syntheticSignals('1250000'), account, quotes, now });
    const zero = evaluateG2Intent({ intent: trade, signals: syntheticSignals('0'), account, quotes, now });
    const negative = evaluateG2Intent({ intent: trade, signals: syntheticSignals('-1'), account, quotes, now });
    const missing = evaluateG2Intent({ intent: trade, signals: syntheticSignals().filter((signal) => signal.endpoint !== 'SMART_MONEY_NETFLOW'), account, quotes, now });
    expect(positive.decision.status).toBe('ALLOW');
    expect(zero.decision.status).toBe('BLOCK');
    expect(zero.decision.reasons).toContain('NONPOSITIVE_WETH_NETFLOW');
    expect(negative.decision.status).toBe('BLOCK');
    expect(negative.decision.reasons).toContain('NONPOSITIVE_WETH_NETFLOW');
    expect(missing.decision.status).toBe('REQUIRE_REVIEW');
    expect(missing.decision.reasons).toContain('SMART_MONEY_NETFLOW_MISSING');
  });

  it('reviews malformed raw duplicates of each required signal key before allowing a trade', async () => {
    const signals = syntheticSignals();
    const account = {
      walletAddress: wallet, version: 0, usdcBalanceAtomic: '20000000', wethBalanceAtomic: '0', gasBalanceNativeWei: '500000000000000',
      utcDay: '2026-09-23', dailyStartEquityUsdcMicros: '21000000', dailyFundingUsdcMicros: '0',
    } satisfies PaperAccountSnapshot;
    const trade = intent();
    const validFlow = signals.find((signal) => signal.endpoint === 'SMART_MONEY_NETFLOW')!;
    const malformedFlow = { ...validFlow, provider: 'invalid-provider' };
    const withMalformedFlow = [...signals, malformedFlow];
    const directFlow = evaluateG2Intent({ intent: trade, signals: withMalformedFlow, account, quotes: quotesFor(trade, account), now });
    expect(directFlow.decision.status).toBe('REQUIRE_REVIEW');
    expect(directFlow.decision.reasons).toContain('SMART_MONEY_NETFLOW_INVALID');

    const validWethSpot = signals.find((signal) => signal.endpoint === 'TOKEN_SCREENER' && signal.asset === 'WETH')!;
    const malformedWethSpot = { ...validWethSpot, chainId: '8453' };
    const directSpot = evaluateG2Intent({ intent: trade, signals: [...signals, malformedWethSpot], account, quotes: quotesFor(trade, account), now });
    expect(directSpot.decision.status).toBe('REQUIRE_REVIEW');
    expect(directSpot.decision.reasons).toContain('SCREENER_INVALID');

    const provider: G2DataProvider = {
      getSignals: () => withMalformedFlow,
      getQuoteBundle: (request, snapshot) => quotesFor(request, snapshot),
    };
    const { app, store } = setup({ provider });
    const response = await postIntent(app, trade);
    expect(response.statusCode).toBe(201);
    expect(response.json().record.decision.status).toBe('REQUIRE_REVIEW');
    expect(response.json().record.decision.reasons).toContain('SMART_MONEY_NETFLOW_INVALID');
    expect(response.json().record.execution.status).toBe('NOT_STARTED');
    expect(store.getAccount(wallet)!.version).toBe(0);
    await app.close();
  });

  it('does not require positive netflow when reducing WETH exposure', () => {
    const account = {
      walletAddress: wallet, version: 0, usdcBalanceAtomic: '10000000', wethBalanceAtomic: '2500000000000000', gasBalanceNativeWei: '500000000000000',
      utcDay: '2026-09-23', dailyStartEquityUsdcMicros: '16000000', dailyFundingUsdcMicros: '0',
    } satisfies PaperAccountSnapshot;
    const trade = intent({ sellAsset: 'WETH', buyAsset: 'USDC', amountIn: '1000000000000000' });
    const evaluation = evaluateG2Intent({ intent: trade, signals: syntheticSignals('0').filter((signal) => signal.endpoint !== 'SMART_MONEY_NETFLOW'),
      account, quotes: quotesFor(trade, account), now });
    expect(evaluation.decision.status).toBe('ALLOW');
  });

  it('requotes the exact remaining 5 USDC trade cap before paper execution', async () => {
    const { app, store, provider } = setup();
    const quoteSpy = vi.spyOn(provider, 'getQuoteBundle');
    const trade = intent({ amountIn: '7000000' });
    const response = await postIntent(app, trade);
    expect(response.statusCode).toBe(201);
    expect(response.json().record.decision).toMatchObject({ status: 'RESIZE', approvedAmountIn: '5000000' });
    expect(response.json().record.execution.status).toBe('SIMULATED');
    expect(store.getAccount(wallet)!.version).toBe(1);
    expect(store.getAccount(wallet)!.usdcBalanceAtomic).toBe('15000000');
    expect(quoteSpy.mock.calls.map(([request]) => request.amountIn)).toEqual(['7000000', '5000000']);
    await app.close();
  });

  it('resizes new WETH exposure to the exact remaining position cap', () => {
    const account = {
      walletAddress: wallet, version: 0, usdcBalanceAtomic: '15000000', wethBalanceAtomic: '4500000000000000', gasBalanceNativeWei: '500000000000000',
      utcDay: '2026-09-23', dailyStartEquityUsdcMicros: '25000000', dailyFundingUsdcMicros: '0',
    } satisfies PaperAccountSnapshot;
    const trade = intent({ amountIn: '2000000' });
    const evaluation = evaluateG2Intent({ intent: trade, signals: syntheticSignals(), account, quotes: quotesFor(trade, account), now });
    expect(evaluation.decision.status).toBe('RESIZE');
    expect(evaluation.decision.approvedAmountIn).toBe('1000000');
    expect(evaluation.decision.reasons).toContain('TRADE_BALANCE_OR_POSITION_LIMIT');
  });

  it('blocks wallet value, 20% daily loss, and absolute daily-loss ceiling breaches', () => {
    const walletOver = {
      walletAddress: wallet, version: 0, usdcBalanceAtomic: '26000000', wethBalanceAtomic: '0', gasBalanceNativeWei: '500000000000000',
      utcDay: '2026-09-23', dailyStartEquityUsdcMicros: '30000000', dailyFundingUsdcMicros: '0',
    } satisfies PaperAccountSnapshot;
    const tradeA = intent({ amountIn: '1000000' });
    const walletDecision = evaluateG2Intent({ intent: tradeA, signals: syntheticSignals(), account: walletOver, quotes: quotesFor(tradeA, walletOver), now });
    expect(walletDecision.decision.status).toBe('BLOCK');
    expect(walletDecision.decision.reasons).toContain('WALLET_VALUE_LIMIT_EXCEEDED');

    const lossAccount = {
      walletAddress: wallet, version: 0, usdcBalanceAtomic: '15000000', wethBalanceAtomic: '0', gasBalanceNativeWei: '5000000000000',
      utcDay: '2026-09-23', dailyStartEquityUsdcMicros: '20000000', dailyFundingUsdcMicros: '0',
    } satisfies PaperAccountSnapshot;
    const tradeB = intent({ amountIn: '1000000' });
    const lossDecision = evaluateG2Intent({ intent: tradeB, signals: syntheticSignals(), account: lossAccount, quotes: quotesFor(tradeB, lossAccount), now });
    expect(lossDecision.decision.status).toBe('BLOCK');
    expect(lossDecision.decision.reasons).toContain('DAILY_LOSS_LIMIT_EXCEEDED');

    const absoluteLoss = { ...lossAccount, usdcBalanceAtomic: '20000000', gasBalanceNativeWei: '0', dailyStartEquityUsdcMicros: '50000000' };
    const tradeC = intent({ amountIn: '1000000' });
    const noFeeQuotes = quotesFor(tradeC, absoluteLoss, { tradeQuote: quote('USDC', 'WETH', tradeC.amountIn, '500000000000000', { feeUsdcMicros: '0', gasFeeNativeWei: '0' }) });
    const absoluteDecision = evaluateG2Intent({ intent: tradeC, signals: syntheticSignals(), account: absoluteLoss, quotes: noFeeQuotes, now });
    expect(absoluteDecision.decision.status).toBe('BLOCK');
    expect(absoluteDecision.decision.reasons).toContain('DAILY_LOSS_LIMIT_EXCEEDED');
  });

  it('enforces the network fee ceiling using an exact native-gas valuation', () => {
    const buyAccount = {
      walletAddress: wallet, version: 0, usdcBalanceAtomic: '20000000', wethBalanceAtomic: '0', gasBalanceNativeWei: '500000000000000',
      utcDay: '2026-09-23', dailyStartEquityUsdcMicros: '21000000', dailyFundingUsdcMicros: '0',
    } satisfies PaperAccountSnapshot;
    const buyTrade = intent();
    const underreportedBuyQuotes = quotesFor(buyTrade, buyAccount, {
      tradeQuote: quote('USDC', 'WETH', buyTrade.amountIn, '2000000000000000', {
        feeUsdcMicros: '10000', gasFeeNativeWei: '400000000000000',
      }),
    });
    const underreportedBuy = evaluateG2Intent({ intent: buyTrade, signals: syntheticSignals(), account: buyAccount, quotes: underreportedBuyQuotes, now });
    expect(underreportedBuy.decision.status).not.toBe('ALLOW');
    expect(underreportedBuy.decision.reasons).toContain('NETWORK_FEE_LIMIT_EXCEEDED');
    expect(underreportedBuy.projection).toBeNull();

    const offsettingRepriceBase = quotesFor(buyTrade, buyAccount, {
      tradeQuote: quote('USDC', 'WETH', buyTrade.amountIn, '2000000000000000', {
        feeUsdcMicros: '10000', gasFeeNativeWei: '400000000000000',
      }),
    });
    const offsettingReprice = evaluateG2Intent({
      intent: buyTrade, signals: syntheticSignals(), account: buyAccount,
      quotes: { ...offsettingRepriceBase, projectedGasQuote: { ...offsettingRepriceBase.projectedGasQuote!, valueUsdcMicros: '990000' } }, now,
    });
    expect(offsettingReprice.decision.status).toBe('BLOCK');
    expect(offsettingReprice.decision.reasons).toContain('NETWORK_FEE_LIMIT_EXCEEDED');
    expect(offsettingReprice.projection).toBeNull();
    const sellAccount = {
      walletAddress: wallet, version: 0, usdcBalanceAtomic: '16000000', wethBalanceAtomic: '2000000000000000', gasBalanceNativeWei: '500000000000000',
      utcDay: '2026-09-23', dailyStartEquityUsdcMicros: '21000000', dailyFundingUsdcMicros: '0',
    } satisfies PaperAccountSnapshot;
    const sellTrade = intent({ sellAsset: 'WETH', buyAsset: 'USDC', amountIn: '500000000000000' });
    const underreportedSellQuotes = quotesFor(sellTrade, sellAccount, {
      tradeQuote: quote('WETH', 'USDC', sellTrade.amountIn, '1000000', {
        feeUsdcMicros: '10000', gasFeeNativeWei: '400000000000000',
      }),
    });
    const underreportedSell = evaluateG2Intent({ intent: sellTrade, signals: syntheticSignals(), account: sellAccount, quotes: underreportedSellQuotes, now });
    expect(underreportedSell.decision.status).not.toBe('ALLOW');
    expect(underreportedSell.decision.reasons).toContain('NETWORK_FEE_LIMIT_EXCEEDED');
    expect(underreportedSell.projection).toBeNull();

    const completeFeeQuotes = quotesFor(buyTrade, buyAccount);
    const missingFeeQuote = evaluateG2Intent({ intent: buyTrade, signals: syntheticSignals(), account: buyAccount,
      quotes: { ...completeFeeQuotes, gasFeeQuote: null }, now });
    expect(missingFeeQuote.decision.status).toBe('REQUIRE_REVIEW');
    expect(missingFeeQuote.decision.reasons).toContain('GAS_FEE_VALUATION_QUOTE_UNAVAILABLE_OR_STALE');
    const staleFeeQuote = evaluateG2Intent({ intent: buyTrade, signals: syntheticSignals(), account: buyAccount,
      quotes: { ...completeFeeQuotes, gasFeeQuote: { ...completeFeeQuotes.gasFeeQuote!, quotedAt: new Date(now.getTime() - 11_000).toISOString() } }, now });
    expect(staleFeeQuote.decision.status).toBe('REQUIRE_REVIEW');
    expect(staleFeeQuote.decision.reasons).toContain('GAS_FEE_VALUATION_QUOTE_UNAVAILABLE_OR_STALE');
    const smallMismatchQuotes = quotesFor(buyTrade, buyAccount, {
      tradeQuote: quote('USDC', 'WETH', buyTrade.amountIn, '2000000000000000', {
        feeUsdcMicros: '10000', gasFeeNativeWei: '10000000000000',
      }),
    });
    const smallMismatch = evaluateG2Intent({ intent: buyTrade, signals: syntheticSignals(), account: buyAccount, quotes: smallMismatchQuotes, now });
    expect(smallMismatch.decision.status).toBe('REQUIRE_REVIEW');
    expect(smallMismatch.decision.reasons).toContain('GAS_FEE_VALUATION_MISMATCH');

    const lossAccount = { ...buyAccount, usdcBalanceAtomic: '15900000' };
    const lossTrade = intent({ amountIn: '1000000' });
    const feePushesLossOverLimit = evaluateG2Intent({
      intent: lossTrade, signals: syntheticSignals(), account: lossAccount,
      quotes: quotesFor(lossTrade, lossAccount, {
        tradeQuote: quote('USDC', 'WETH', lossTrade.amountIn, '500000000000000', {
          feeUsdcMicros: '200000', gasFeeNativeWei: '100000000000000',
        }),
      }), now,
    });
    expect(feePushesLossOverLimit.decision.status).toBe('BLOCK');
    expect(feePushesLossOverLimit.decision.reasons).toContain('DAILY_LOSS_LIMIT_EXCEEDED');

    const normalFee = evaluateG2Intent({ intent: buyTrade, signals: syntheticSignals(), account: buyAccount, quotes: quotesFor(buyTrade, buyAccount), now });
    expect(normalFee.decision.status).toBe('ALLOW');
    const zeroFeeQuotes = quotesFor(buyTrade, buyAccount, {
      tradeQuote: quote('USDC', 'WETH', buyTrade.amountIn, '2000000000000000', { feeUsdcMicros: '0', gasFeeNativeWei: '0' }),
    });
    const zeroFee = evaluateG2Intent({ intent: buyTrade, signals: syntheticSignals(), account: buyAccount, quotes: zeroFeeQuotes, now });
    expect(zeroFee.decision.status).toBe('ALLOW');
    const inconsistentZeroFee = evaluateG2Intent({ intent: buyTrade, signals: syntheticSignals(), account: buyAccount, quotes: quotesFor(buyTrade, buyAccount, {
      tradeQuote: quote('USDC', 'WETH', buyTrade.amountIn, '2000000000000000', { feeUsdcMicros: '0' }),
    }), now });
    expect(inconsistentZeroFee.decision.status).toBe('REQUIRE_REVIEW');
    expect(inconsistentZeroFee.decision.reasons).toContain('GAS_FEE_VALUATION_MISMATCH');
  });

  it('does not simulate an intent when the reported fee understates its gas valuation', async () => {
    const trade = intent();
    const provider: G2DataProvider = {
      getSignals: () => syntheticSignals(),
      getQuoteBundle: (request, account) => quotesFor(request, account, {
        tradeQuote: quote(request.sellAsset, request.buyAsset, request.amountIn, '2000000000000000', {
          feeUsdcMicros: '10000', gasFeeNativeWei: '400000000000000',
        }),
      }),
    };
    const { app, store } = setup({ provider });
    const response = await postIntent(app, trade);
    expect(response.statusCode).toBe(201);
    expect(response.json().record.decision.status).not.toBe('ALLOW');
    expect(response.json().record.execution.status).not.toBe('SIMULATED');
    expect(store.getAccount(wallet)!.version).toBe(0);
    await app.close();
  });

  it('resets daily loss baseline at the UTC day boundary using current marked equity', () => {
    const account = {
      walletAddress: wallet, version: 0, usdcBalanceAtomic: '20000000', wethBalanceAtomic: '0', gasBalanceNativeWei: '500000000000000',
      utcDay: '2026-09-22', dailyStartEquityUsdcMicros: '3000000', dailyFundingUsdcMicros: '-1000000',
    } satisfies PaperAccountSnapshot;
    const trade = intent({ amountIn: '1000000' });
    const evaluation = evaluateG2Intent({ intent: trade, signals: syntheticSignals(), account, quotes: quotesFor(trade, account), now });
    expect(evaluation.decision.status).toBe('ALLOW');
    expect(evaluation.projection).toMatchObject({ utcDay: '2026-09-23', dailyStartEquityUsdcMicros: '21000000', dailyFundingUsdcMicros: '0' });
  });

  it('adjusts daily loss for external USDC funding movements', async () => {
    const { app, store } = setup({ usdc: '20000000', start: '20000000' });
    const account = store.recordExternalUsdcFunding(wallet, '-5000000', '2026-09-23');
    expect(account.usdcBalanceAtomic).toBe('15000000');
    expect(account.dailyFundingUsdcMicros).toBe('-5000000');
    const response = await postIntent(app, intent({ amountIn: '1000000' }));
    expect(response.json().record.decision.status, JSON.stringify(response.json().record.decision)).toBe('ALLOW');
    await app.close();
  });

  it('adjusts daily equity for externally funded WETH using a fresh executable quote', async () => {
    const { app, store } = setup({ usdc: '20000000', start: '21000000' });
    const account = store.recordExternalFunding({ walletAddress: wallet, asset: 'WETH', amountAtomic: '1000000000000000',
      valueUsdcMicros: '2000000', quotedAt: now.toISOString(), utcDay: '2026-09-23' });
    expect(account.wethBalanceAtomic).toBe('1000000000000000');
    expect(account.dailyFundingUsdcMicros).toBe('2000000');
    expect(() => store.recordExternalFunding({ walletAddress: wallet, asset: 'WETH', amountAtomic: '1000000000000000',
      valueUsdcMicros: '2000000', quotedAt: new Date(now.getTime() - 11_000).toISOString(), utcDay: '2026-09-23' }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    const response = await postIntent(app, intent({ amountIn: '1000000' }));
    expect(response.json().record.decision.status).toBe('ALLOW');
    await app.close();
  });
  it('reviews stale, incomplete, ambiguous signals and quotes, and blocks oversized slippage, impact, and fee', () => {
    const trade = intent();
    const account = {
      walletAddress: wallet, version: 0, usdcBalanceAtomic: '20000000', wethBalanceAtomic: '0', gasBalanceNativeWei: '500000000000000',
      utcDay: '2026-09-23', dailyStartEquityUsdcMicros: '21000000', dailyFundingUsdcMicros: '0',
    } satisfies PaperAccountSnapshot;
    const base = { intent: trade, account, quotes: quotesFor(trade, account), now };
    const stale = syntheticSignals().map((signal) => signal.asset === 'WETH' && signal.endpoint === 'TOKEN_SCREENER'
      ? { ...signal, fetchedAt: new Date(now.getTime() - 11 * 60_000).toISOString(), observedAt: new Date(now.getTime() - 11 * 60_000).toISOString() } : signal);
    expect(evaluateG2Intent({ ...base, signals: stale }).decision.status).toBe('REQUIRE_REVIEW');
    const partial = syntheticSignals().map((signal) => signal.endpoint === 'TOKEN_SCREENER' && signal.asset === 'USDC'
      ? { ...signal, quality: 'PARTIAL' as const, value: null } : signal);
    expect(evaluateG2Intent({ ...base, signals: partial }).decision.reasons).toContain('SCREENER_INCOMPLETE');
    const duplicate = syntheticSignals().concat(syntheticSignals().filter((signal) => signal.asset === 'USDC' && signal.endpoint === 'TOKEN_SCREENER'));
    expect(evaluateG2Intent({ ...base, signals: duplicate }).decision.reasons).toContain('SCREENER_AMBIGUOUS');
    expect(evaluateG2Intent({ ...base, signals: syntheticSignals(), quotes: null }).decision.status).toBe('REQUIRE_REVIEW');
    const validQuotes = quotesFor(trade, account);
    const staleTradeQuote = { ...validQuotes, tradeQuote: { ...validQuotes.tradeQuote!, quotedAt: new Date(now.getTime() - 11_000).toISOString() } };
    expect(evaluateG2Intent({ ...base, signals: syntheticSignals(), quotes: staleTradeQuote }).decision.reasons).toContain('TRADE_QUOTE_UNAVAILABLE_OR_STALE');
    const staleGasQuote = { ...validQuotes, gasQuote: { ...validQuotes.gasQuote!, quotedAt: new Date(now.getTime() - 11_000).toISOString() } };
    expect(evaluateG2Intent({ ...base, signals: syntheticSignals(), quotes: staleGasQuote }).decision.reasons).toContain('GAS_VALUATION_QUOTE_UNAVAILABLE_OR_STALE');
    expect(evaluateG2Intent({ ...base, signals: syntheticSignals(), quotes: quotesFor(trade, account, { tradeQuote: quote('USDC','WETH',trade.amountIn,'2000000000000000',{ slippageBps: 51 }) }) }).decision.reasons).toContain('SLIPPAGE_LIMIT_EXCEEDED');
    expect(evaluateG2Intent({ ...base, signals: syntheticSignals(), quotes: quotesFor(trade, account, { tradeQuote: quote('USDC','WETH',trade.amountIn,'2000000000000000',{ priceImpactBps: 51 }) }) }).decision.reasons).toContain('PRICE_IMPACT_LIMIT_EXCEEDED');
    expect(evaluateG2Intent({ ...base, signals: syntheticSignals(), quotes: quotesFor(trade, account, { tradeQuote: quote('USDC','WETH',trade.amountIn,'2000000000000000',{ feeUsdcMicros: '250001' }) }) }).decision.reasons).toContain('NETWORK_FEE_LIMIT_EXCEEDED');
  });

  it('requires review on invalid lifetime and intent expiry', () => {
    const account = {
      walletAddress: wallet, version: 0, usdcBalanceAtomic: '20000000', wethBalanceAtomic: '0', gasBalanceNativeWei: '500000000000000',
      utcDay: '2026-09-23', dailyStartEquityUsdcMicros: '21000000', dailyFundingUsdcMicros: '0',
    } satisfies PaperAccountSnapshot;
    const long = intent({ expiresAt: new Date(now.getTime() + 120_000).toISOString() });
    expect(evaluateG2Intent({ intent: long, signals: syntheticSignals(), account, quotes: quotesFor(long, account), now }).decision.status).toBe('BLOCK');
    const expired = intent({ issuedAt: new Date(now.getTime() - 61_000).toISOString(), expiresAt: new Date(now.getTime() - 1000).toISOString() });
    expect(evaluateG2Intent({ intent: expired, signals: syntheticSignals(), account, quotes: quotesFor(expired, account), now }).decision.reasons).toContain('INTENT_EXPIRED');
  });

  it('rejects unknown policy/mode fields, exposes only paper health, and returns synthetic signals explicitly', async () => {
    const signals = syntheticSignals();
    const provider: G2DataProvider = { getSignals: () => signals, getQuoteBundle: () => null };
    const { app } = setup({ provider });
    const rejected = await postIntent(app, { ...intent(), executionMode: 'LIVE', policyVersion: 'changed' });
    expect(rejected.statusCode).toBe(400);
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.json()).toMatchObject({ executionMode: 'PAPER', paidNansenCallsEnabled: false, activeNansenCreditBudget: 0, liveExecutionEnabled: false });
    const signalsResponse = await app.inject({ method: 'GET', url: '/v1/signals' });
    expect(signalsResponse.json().signals).toHaveLength(3);
    expect(signalsResponse.json().signals.every((signal: NormalizedSignal) => signal.provider === 'synthetic')).toBe(true);
    await app.close();
  });

  it('is idempotent, rejects intent-id conflicts, and serializes concurrent requests against account version', async () => {
    const { app, store, provider, directory } = setup();
    const getSignals = vi.spyOn(provider, 'getSignals');
    const trade = intent({ amountIn: '2000000' });
    const first = await postIntent(app, trade);
    const replay = await postIntent(app, trade);
    expect(first.json().record.execution.status).toBe('SIMULATED');
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect(getSignals).toHaveBeenCalledTimes(1);
    const conflict = await postIntent(app, { ...trade, amountIn: '1000000' });
    expect(conflict.statusCode).toBe(409);
    expect(store.getAccount(wallet)!.version).toBe(1);

    const snapshot = store.getAccount(wallet)!;
    const secondConnection = openPaperStore({ databasePath: join(directory, 'paper.sqlite') });
    stores.push(secondConnection);
    const a = intent({ amountIn: '2000000' });
    const b = intent({ amountIn: '2000000' });
    const aDecision = evaluateG2Intent({ intent: a, signals: syntheticSignals(), account: snapshot, quotes: quotesFor(a, snapshot), now });
    const bDecision = evaluateG2Intent({ intent: b, signals: syntheticSignals(), account: snapshot, quotes: quotesFor(b, snapshot), now });
    const firstCommit = store.commitEvaluation(a, aDecision, snapshot.version);
    const concurrentCommit = secondConnection.commitEvaluation(b, bDecision, snapshot.version);
    expect([firstCommit.record.decision.status, concurrentCommit.record.decision.status].sort()).toEqual(['ALLOW','REQUIRE_REVIEW']);
    expect([firstCommit.record.execution.status, concurrentCommit.record.execution.status].filter((status) => status === 'SIMULATED')).toHaveLength(1);
    expect(store.getAccount(wallet)!.version).toBe(2);
    await app.close();
  });

  it('keeps an unknown reservation consuming the wallet slot', async () => {
    const { app, store } = setup();
    store.reservePending(wallet, randomUUID(), randomUUID(), '1000000', '1000000', now.toISOString());
    const response = await postIntent(app, intent({ amountIn: '1000000' }));
    expect(response.json().record.decision.status).toBe('REQUIRE_REVIEW');
    expect(response.json().record.decision.reasons).toContain('WALLET_EXECUTION_PENDING');
    expect(response.json().record.execution.status).toBe('NOT_STARTED');
    expect(store.getAccount(wallet)!.version).toBe(0);
    await app.close();
  });

  it('fails closed on a mismatched external paper-store identity', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ered-luin-g2-corrupt-'));
    directories.push(directory);
    const databasePath = join(directory, 'paper.sqlite');
    const store = initializePaperStore({ databasePath });
    stores.push(store);
    expect(() => openPaperStore({ databasePath, storeId: 'wrong-store' }))
      .toThrowError(expect.objectContaining({ code: 'CONFIGURATION_MISMATCH' }));
    expect(() => initializePaperStore({ databasePath })).toThrowError(expect.objectContaining({ code: 'DATABASE_ALREADY_EXISTS' }));
  });

  it('shares the wallet reservation authority with execution lifecycle records', async () => {
    const { app, store, directory } = setup();
    const executionStore = openExecutionStore({ databasePath: join(directory, 'paper.sqlite'), clock: () => now });
    try {
      const trade = intent();
      const accountVersion = store.getAccount(wallet)!.version;
      const decision: Decision = {
        decisionId: randomUUID(), intentId: trade.intentId, status: 'ALLOW', evaluatedAt: now.toISOString(),
        policyVersion: G2_POLICY_VERSION, requestedAmountIn: trade.amountIn, approvedAmountIn: trade.amountIn,
        reasons: ['SYNTHETIC_G3A_SHARED_RESERVATION_REGRESSION'],
      };
      const transaction: ExecutionTransactionEnvelope = {
        version: 1, chainId: 8453, walletAddress: trade.walletAddress,
        router: '0x0000000000000000000000000000000000000022',
        recipient: trade.walletAddress, sellAsset: trade.sellAsset, buyAsset: trade.buyAsset,
        amountIn: trade.amountIn, minimumAmountOut: '1', valueNativeWei: '0',
        maxFeePerGasWei: '3', maxPriorityFeePerGasWei: '1', maxTotalFeeWei: '100',
        chainNonce: '41', expiresAt: new Date(now.getTime() + 50_000).toISOString(),
      };
      executionStore.reserve({
        executionId: randomUUID(), intent: trade, decision, accountVersion,
        reservationExposureUsdcMicros: '4000000', transaction, reason: 'synthetic shared-slot regression',
      });
      const response = await postIntent(app, trade);
      expect(response.statusCode).toBe(201);
      expect(response.json().record.decision.status).toBe('REQUIRE_REVIEW');
      expect(response.json().record.decision.reasons).toContain('WALLET_EXECUTION_PENDING');
      expect(store.getAccount(wallet)!.version).toBe(accountVersion);
    } finally {
      executionStore.close();
      await app.close();
    }
  });
});

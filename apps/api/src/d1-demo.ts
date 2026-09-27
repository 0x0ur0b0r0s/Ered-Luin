import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  d1G3cFixtureSchema,
  d1G3cStatusNameSchema,
  d1ProposalSchema,
  d1ScenarioIdSchema,
  d1ScenarioSchema,
  g3cEvidenceAttestationSchema,
  g3cStatusResponseSchema,
  type D1G3cFixture,
  type D1Proposal,
  type D1Scenario,
  type D1ScenarioId,
  type D1G3cStatusName,
  type G3cStatusResponse,
  type NormalizedSignal,
  type TradeIntent,
} from '@ered-luin/contracts';
import {
  buildG1DEvidencePacket,
  createNansenQueryManager,
  initializeNansenObservationStore,
  type AdapterResult,
  type FlowIntelligenceRow,
  type G1DShadowEvaluator,
  type ManagedQueryResult,
  type NansenClient,
  type NansenManagedQuery,
  type SmartMoneyNetflowToken,
  type TokenOhlcvAdapterResult,
  type TokenScreenerToken,
} from '@ered-luin/nansen';
import type { CreatePaperAccountInput } from './paper-store.js';
import type { G2DataProvider } from './api.js';
import type { PaperAccountSnapshot, PaperQuote, G2QuoteBundle } from './policy.js';

const E18 = 10n ** 18n;
const WETH_PRICE_USD_MICROS = 2_000_000_000n;
const GAS_FEE_NATIVE_WEI = 5_000_000_000_000n;
const SCREENER_QUERY = Object.freeze({
  operation: 'TOKEN_SCREENER', asset: 'BASE_PAIR', timeframe: '1h', pageBound: 1, retryBound: 0, perPage: 100,
} as const satisfies NansenManagedQuery);
const FLOW_QUERY = Object.freeze({
  operation: 'FLOW_INTELLIGENCE', asset: 'WETH', timeframe: '1h', pageBound: 1, retryBound: 0, perPage: 1,
} as const satisfies NansenManagedQuery);
const NETFLOW_QUERY = Object.freeze({
  operation: 'SMART_MONEY_NETFLOW', asset: 'BASE_PAIR', timeframe: '1h', pageBound: 1, retryBound: 0, perPage: 100,
} as const satisfies NansenManagedQuery);

const SCENARIOS: readonly D1Scenario[] = Object.freeze([
  d1ScenarioSchema.parse({ id: 'ALLOW', title: 'Positive flow', description: 'Fresh positive synthetic WETH flow and a $4 USDC proposal.' }),
  d1ScenarioSchema.parse({ id: 'RESIZE', title: 'Resize to cap', description: 'Positive synthetic WETH flow and a $7 USDC proposal.' }),
  d1ScenarioSchema.parse({ id: 'BLOCK', title: 'Negative flow', description: 'Negative synthetic WETH flow on a $4 USDC proposal.' }),
  d1ScenarioSchema.parse({ id: 'REVIEW', title: 'Evidence missing', description: 'Incomplete screener data and missing WETH flow on a $4 USDC proposal.' }),
]);

interface ScenarioConfig {
  readonly amountIn: string;
  readonly wethNetflowUsd: number | null;
  readonly screenerCompleteness: 'complete' | 'incomplete';
}
const SCENARIO_CONFIG: Readonly<Record<D1ScenarioId, ScenarioConfig>> = Object.freeze({
  ALLOW: { amountIn: '4000000', wethNetflowUsd: 23_000, screenerCompleteness: 'complete' },
  RESIZE: { amountIn: '7000000', wethNetflowUsd: 23_000, screenerCompleteness: 'complete' },
  BLOCK: { amountIn: '4000000', wethNetflowUsd: -1, screenerCompleteness: 'complete' },
  REVIEW: { amountIn: '4000000', wethNetflowUsd: null, screenerCompleteness: 'incomplete' },
});

export interface D1EvaluationContext {
  readonly proposal: D1Proposal;
  readonly account: CreatePaperAccountInput;
  readonly provider: G2DataProvider;
}
export interface D1DemoService {
  scenarios(): readonly D1Scenario[];
  createProposal(scenarioId: D1ScenarioId): Promise<D1Proposal>;
  evaluationContext(proposalId: string): D1EvaluationContext | null;
  g3cStatus(status: D1G3cStatusName): D1G3cFixture;
  close(): void;
}

function pageReference(operation: string) {
  return Object.freeze({
    attemptId: 'd1-synthetic:' + operation.toLowerCase(),
    status: 200,
    providerRequestId: 'fixture-' + operation.toLowerCase(),
    chargedCredits: null,
    page: 1,
    received: true,
  });
}
function adapterResult<T>(
  operation: AdapterResult<T>['operation'],
  data: readonly T[],
  completeness: AdapterResult<T>['completeness'] = 'complete',
): AdapterResult<T> {
  return Object.freeze({
    operation, data: Object.freeze([...data]), warnings: Object.freeze([]), warningsAvailable: true,
    completeness, pagesRead: 1, pageReferences: Object.freeze([pageReference(operation)]),
    unavailableFields: Object.freeze([]), diagnostics: null, failure: null,
  });
}
function token(asset: 'USDC' | 'WETH'): TokenScreenerToken {
  const isUsdc = asset === 'USDC';
  return {
    chain: 'base',
    token_address: isUsdc ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' : '0x4200000000000000000000000000000000000006',
    token_symbol: asset, token_age_days: isUsdc ? 450 : 700,
    token_deployment_date: isUsdc ? '2023-09-01T00:00:00Z' : '2021-08-01T00:00:00Z',
    market_cap_usd: isUsdc ? 25_000_000_000 : 420_000_000, liquidity: 22_000_000,
    price_usd: isUsdc ? 1 : 2_000, price_change: 0, fdv: isUsdc ? 25_000_000_000 : 420_000_000,
    buy_volume: 100_000, sell_volume: 90_000, volume: 190_000, netflow: 10_000,
  };
}
function flowRow(): FlowIntelligenceRow {
  return {
    asset: 'WETH', chain: 'base', token_address: '0x4200000000000000000000000000000000000006',
    public_figure_net_flow_usd: 0, public_figure_avg_flow_usd: null, public_figure_wallet_count: 0,
    top_pnl_net_flow_usd: 2_100, top_pnl_avg_flow_usd: 700, top_pnl_wallet_count: 3,
    whale_net_flow_usd: -450, whale_avg_flow_usd: 225, whale_wallet_count: 2,
    smart_trader_net_flow_usd: 12_000, smart_trader_avg_flow_usd: 3_000, smart_trader_wallet_count: 4,
    exchange_net_flow_usd: -1_000, exchange_avg_flow_usd: 500, exchange_wallet_count: 0,
    fresh_wallets_net_flow_usd: null, fresh_wallets_avg_flow_usd: null, fresh_wallets_wallet_count: null,
  };
}
function netflowRow(asset: 'USDC' | 'WETH', flowUsd: number): SmartMoneyNetflowToken {
  return {
    chain: 'base',
    token_address: asset === 'USDC' ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' : '0x4200000000000000000000000000000000000006',
    token_symbol: asset, net_flow_1h_usd: flowUsd, net_flow_24h_usd: 9_000,
    net_flow_7d_usd: -12_000, net_flow_30d_usd: 34_000,
    token_sectors: asset === 'USDC' ? ['Stablecoin'] : ['DeFi'], trader_count: 12,
    token_age_days: asset === 'USDC' ? 450 : 700, market_cap_usd: asset === 'USDC' ? 25_000_000_000 : 420_000_000,
  };
}
function replayClient(config: ScenarioConfig): NansenClient {
  return {
    tokenScreener: async () => adapterResult('TOKEN_SCREENER', [token('USDC'), token('WETH')], config.screenerCompleteness),
    flowIntelligence: async () => adapterResult('FLOW_INTELLIGENCE', [flowRow()]),
    tokenOhlcv: async (): Promise<TokenOhlcvAdapterResult> => Object.freeze({ operation: 'TOKEN_OHLCV', candle: null,
      completeness: 'complete', pageReferences: Object.freeze([]), failure: null }),
    smartMoneyNetflow: async () => adapterResult('SMART_MONEY_NETFLOW', [
      netflowRow('USDC', 500),
      ...(config.wethNetflowUsd === null ? [] : [netflowRow('WETH', config.wethNetflowUsd)]),
    ]),
  };
}
function randomWallet(): string {
  return '0x' + randomBytes(20).toString('hex');
}
function syntheticAccount(walletAddress: string, now: Date): CreatePaperAccountInput {
  return Object.freeze({
    walletAddress, usdcBalanceAtomic: '20000000', wethBalanceAtomic: '0',
    gasBalanceNativeWei: '500000000000000', dailyStartEquityUsdcMicros: '21000000',
    dailyFundingUsdcMicros: '0', utcDay: now.toISOString().slice(0, 10),
  });
}
function wethValue(amountAtomic: string): string {
  return (BigInt(amountAtomic) * WETH_PRICE_USD_MICROS / E18).toString();
}
function makeQuote(
  sellAsset: 'USDC' | 'WETH',
  buyAsset: 'USDC' | 'WETH',
  amountIn: string,
  amountOut: string,
  quotedAt: string,
): PaperQuote {
  return Object.freeze({
    source: 'synthetic', chainId: 8453, sellAsset, buyAsset, amountIn, amountOut,
    quotedAt, slippageBps: 10, priceImpactBps: 10, feeUsdcMicros: '10000',
    gasFeeNativeWei: GAS_FEE_NATIVE_WEI.toString(),
  });
}
function quoteBundleFor(clock: () => Date, intent: TradeIntent, account: PaperAccountSnapshot): G2QuoteBundle {
  const at = clock().toISOString();
  const amountIn = BigInt(intent.amountIn);
  const amountOut = intent.sellAsset === 'USDC'
    ? (amountIn * E18 / WETH_PRICE_USD_MICROS).toString()
    : (amountIn * WETH_PRICE_USD_MICROS / E18).toString();
  const tradeQuote = makeQuote(intent.sellAsset, intent.buyAsset, intent.amountIn, amountOut, at);
  const wethBefore = BigInt(account.wethBalanceAtomic);
  const wethAfter = intent.buyAsset === 'WETH' ? wethBefore + BigInt(amountOut) : wethBefore - amountIn;
  const gasBefore = BigInt(account.gasBalanceNativeWei);
  const gasAfter = gasBefore >= GAS_FEE_NATIVE_WEI ? gasBefore - GAS_FEE_NATIVE_WEI : 0n;
  const gasQuote = gasBefore === 0n ? null : Object.freeze({
    source: 'synthetic' as const, chainId: 8453 as const, amountInNativeWei: gasBefore.toString(),
    valueUsdcMicros: wethValue(gasBefore.toString()), quotedAt: at,
  });
  const projectedGasQuote = gasAfter === 0n ? null : Object.freeze({
    source: 'synthetic' as const, chainId: 8453 as const, amountInNativeWei: gasAfter.toString(),
    valueUsdcMicros: wethValue(gasAfter.toString()), quotedAt: at,
  });
  const gasFeeQuote = Object.freeze({
    source: 'synthetic' as const, chainId: 8453 as const,
    amountInNativeWei: GAS_FEE_NATIVE_WEI.toString(), valueUsdcMicros: '10000', quotedAt: at,
  });
  return Object.freeze({
    accountVersion: account.version,
    positionQuote: wethBefore === 0n ? null : makeQuote('WETH', 'USDC', wethBefore.toString(), wethValue(wethBefore.toString()), at),
    tradeQuote,
    projectedPositionQuote: wethAfter === 0n ? null : makeQuote('WETH', 'USDC', wethAfter.toString(), wethValue(wethAfter.toString()), at),
    gasQuote, projectedGasQuote, gasFeeQuote,
  });
}
function rationaleFor(signals: readonly NormalizedSignal[]): string {
  const flow = signals.find((signal) =>
    signal.endpoint === 'SMART_MONEY_NETFLOW' && signal.asset === 'WETH' && signal.metric === 'net_flow_1h_usd');
  if (!flow || flow.quality !== 'COMPLETE' || flow.value === null) {
    return 'The synthetic one-hour WETH Smart Money observation is missing or incomplete. This deterministic replay leaves the policy outcome to the firewall.';
  }
  if (BigInt(flow.value) <= 0n) {
    return 'The synthetic one-hour WETH Smart Money netflow is zero or negative. This deterministic replay leaves the policy outcome to the firewall.';
  }
  return 'The synthetic one-hour WETH Smart Money netflow is positive. This deterministic replay proposes a small USDC-to-WETH example; the firewall independently decides whether it is allowed.';
}
function semanticSummary(result: Awaited<ReturnType<G1DShadowEvaluator['evaluate']>> | null) {
  if (!result) return {
    provider: 'none' as const, status: 'NOT_CONFIGURED' as const, authority: 'NONE' as const,
    advisoryRoute: 'ASTRA_REVIEW' as const, answer: null, questionVersion: null, requestsMade: 0 as const,
  };
  if (result.authority !== 'NONE') throw new Error('D1_SEMANTIC_AUTHORITY_INVALID');
  return {
    provider: 'typesafe-shadow' as const, status: result.status, authority: 'NONE' as const,
    advisoryRoute: result.advisoryRoute, answer: result.answer,
    questionVersion: result.evidence.questionVersion, requestsMade: result.requestsMade,
  };
}

function receiptFixture(status: 'PENDING' | 'CONFIRMED' | 'REVERTED', now: Date, executionId: string, operationId: string) {
  const seconds = Math.floor(now.getTime() / 1000);
  const finalizedBlock = status === 'PENDING' ? null : '99';
  const blockHash = '0x' + 'ab'.repeat(32);
  const terminal = status === 'CONFIRMED' || status === 'REVERTED';
  const payload = {
    version: 3 as const, serviceId: 'ered-luin-g3c-evidence' as const, environment: 'synthetic-test' as const,
    keyId: 'd1-synthetic-fixture', sourceFinality: terminal ? 'historical-finalized' as const : null,
    sourceBlockNumber: finalizedBlock, sourceBlockHash: terminal ? blockHash : null,
    sourceBlockTimestamp: terminal ? seconds - 2 : null,
    latestHeadNumber: '101', latestHeadHash: '0x' + 'cd'.repeat(32), latestHeadTimestamp: seconds,
    safeHeadNumber: '100', safeHeadHash: '0x' + 'cd'.repeat(32), safeHeadTimestamp: seconds - 1,
    finalizedHeadNumber: '99', finalizedHeadHash: blockHash, finalizedHeadTimestamp: seconds - 2,
    feeValuationBlockNumber: terminal ? '99' : null,
    feeValuationBlockHash: terminal ? blockHash : null,
    feeValuationBlockTimestamp: terminal ? seconds - 2 : null,
    kind: 'RECEIPT' as const, executionId, operationId, chainId: 8453 as const,
    transactionHash: '0x' + 'ef'.repeat(32), sender: '0x00000000000000000000000000000000000000d1',
    nonce: '1', outcome: status, blockNumber: terminal ? '99' : null,
    blockHash: terminal ? blockHash : null, finality: terminal ? 'finalized' as const : null,
    gasUsed: terminal ? '100000' : null, effectiveGasPriceWei: terminal ? '1000000000' : null,
    l1FeeWei: terminal ? '1000' : null, operatorFeeWei: terminal ? '0' : null,
    actualFeeUsdcMicros: terminal ? '12000' : null, canonical: terminal ? true : null,
    observedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 10_000).toISOString(),
  };
  return g3cEvidenceAttestationSchema.parse({ payload, signature: '0x' + '00'.repeat(64) });
}
function makeG3cFixture(status: D1G3cStatusName, clock: () => Date): D1G3cFixture {
  const now = clock();
  const executionId = randomUUID();
  const operationId = randomUUID();
  const terminal = status === 'CONFIRMED' || status === 'REVERTED';
  const receipt = status === 'PENDING' || terminal ? receiptFixture(status, now, executionId, operationId) : null;
  const response = g3cStatusResponseSchema.parse({
    executionId, inputAsset: 'USDC', requestedAmount: '4000000', permittedAmount: terminal || status === 'PENDING' ? '4000000' : null,
    policyReason: 'SYNTHETIC_STATUS_EXAMPLE_ONLY', mode: 'LIVE_DISABLED', status,
    transactionHash: status === 'UNKNOWN' ? null : '0x' + 'ef'.repeat(32),
    receipt, actualFeesUsdcMicros: terminal ? '12000' : null,
    evidenceProvenance: ['synthetic-fixture:d1'],
  } satisfies G3cStatusResponse);
  return d1G3cFixtureSchema.parse({
    label: 'SYNTHETIC G3C STATUS FIXTURE — NOT A CHAIN RECEIPT', status: response,
  });
}

export function createD1DemoService(options: {
  readonly clock?: () => Date;
  readonly semanticAnalyzer?: Pick<G1DShadowEvaluator, 'evaluate'>;
} = {}): D1DemoService {
  const clock = options.clock ?? (() => new Date());
  const tempRoot = mkdtempSync(join(tmpdir(), 'ered-luin-d1-'));
  const proposals = new Map<string, D1EvaluationContext>();
  let closed = false;

  return {
    scenarios: () => SCENARIOS,
    async createProposal(scenarioValue) {
      if (closed) throw new Error('D1_DEMO_CLOSED');
      const scenarioParsed = d1ScenarioIdSchema.safeParse(scenarioValue);
      if (!scenarioParsed.success) throw new Error('D1_SCENARIO_INVALID');
      const scenarioId = scenarioParsed.data;
      const config = SCENARIO_CONFIG[scenarioId];
      const now = clock();
      if (!(now instanceof Date) || !Number.isSafeInteger(now.getTime()) || now.getTime() < 0) throw new Error('D1_CLOCK_INVALID');

      const replayDir = mkdtempSync(join(tempRoot, 'replay-'));
      const observationStore = initializeNansenObservationStore({
        databasePath: join(replayDir, 'observations.sqlite'),
        storeId: 'd1-replay-' + randomUUID(), clock,
      });
      try {
        const manager = createNansenQueryManager({
          client: replayClient(config), store: observationStore, enabled: true,
          maxPageBound: 1, maxRetryBound: 0, clock,
        });
        const results: ManagedQueryResult[] = await Promise.all([
          manager.query(SCREENER_QUERY), manager.query(FLOW_QUERY), manager.query(NETFLOW_QUERY),
        ]);
        if (results.some((result) => result.source !== 'synthetic' || result.qualifyingSuccessfulRequests !== 0)) {
          throw new Error('D1_REPLAY_PROVENANCE_INVALID');
        }
        const shadowPacket = buildG1DEvidencePacket(results, { now });
        const observations = results.flatMap((result) => result.observations);
        const semantic = options.semanticAnalyzer ? await options.semanticAnalyzer.evaluate(results) : null;
        const semanticSignalIds = semantic?.evidence.features
          .flatMap((feature) => feature.signalReferences.map((reference) => reference.signalId)).sort();
        const expectedSignalIds = observations.map((signal) => signal.signalId).sort();
        if (semantic && (semantic.authority !== 'NONE' || semantic.evidence.source !== shadowPacket.source ||
            semantic.request.state.source !== shadowPacket.source ||
            semanticSignalIds?.join(',') !== expectedSignalIds.join(','))) {
          throw new Error('D1_SEMANTIC_EVIDENCE_MISMATCH');
        }
        const proposalId = randomUUID();
        const walletAddress = randomWallet();
        const intent = {
          intentId: proposalId, chainId: 8453 as const, walletAddress,
          sellAsset: 'USDC' as const, buyAsset: 'WETH' as const, amountIn: config.amountIn,
          issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        } satisfies TradeIntent;
        const proposal = d1ProposalSchema.parse({
          proposalId, scenarioId, createdAt: now.toISOString(), intent,
          analysis: {
            source: 'DETERMINISTIC_REPLAY', version: 'd1-rule-v1',
            rationale: rationaleFor(observations), semantic: semanticSummary(semantic),
          },
          evidence: {
            label: 'SYNTHETIC FIXTURE — NOT MARKET EVIDENCE', source: 'synthetic',
            observationIds: observations.map((signal) => signal.signalId), observations,
            batches: results.map((result) => ({
              operation: result.operation, status: result.status, source: 'synthetic',
              completeness: result.completeness, fetchedAt: result.fetchedAt, acquiredAt: result.acquiredAt,
              ageMs: result.ageMs, observationIds: result.observations.map((signal) => signal.signalId),
            })),
          },
        });
        const account = syntheticAccount(walletAddress, now);
        const provider: G2DataProvider = Object.freeze({
          getSignals: () => proposal.evidence.observations,
          getQuoteBundle: (trade: TradeIntent, snapshot: PaperAccountSnapshot) => quoteBundleFor(clock, trade, snapshot),
        });
        proposals.set(proposalId, Object.freeze({ proposal, account, provider }));
        return proposal;
      } finally {
        observationStore.close();
        rmSync(replayDir, { recursive: true, force: true });
      }
    },
    evaluationContext(proposalId) {
      return closed ? null : proposals.get(proposalId) ?? null;
    },
    g3cStatus(statusValue) {
      if (closed) throw new Error('D1_DEMO_CLOSED');
      const status = d1G3cStatusNameSchema.parse(statusValue);
      return makeG3cFixture(status, clock);
    },
    close() {
      if (closed) return;
      closed = true;
      proposals.clear();
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

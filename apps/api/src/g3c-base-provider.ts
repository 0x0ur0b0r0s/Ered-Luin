import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DEFAULT_D2_RPC_MAX_REQUESTS, DEFAULT_D2_RPC_RECOVERY_RESERVE, RpcRunBudget, type RpcRunBudgetSnapshot } from './rpc-budget.js';
import {
  createPublicClient, encodeFunctionData, getAddress, http, parseAbi,
  type Address, type Hex,
} from 'viem';
import { base } from 'viem/chains';
import { assertG3cHeadFreshness, canonicalJson, g3bUnsignedTransactionSchema, type ExecutionTransactionEnvelope, type G3bUnsignedTransaction, type G3cEvidenceAttestation, type G3cEvidenceHeadAnchor, type G3cSourceFinality, type TradeIntent } from '@ered-luin/contracts';
import { BASE_TOKENS, BASE_UNISWAP_V3, verifyBaseAllowlist, type BaseDeploymentEvidence } from './base-allowlist.js';
import type { G3cEvidenceAuthority } from './g3c-evidence.js';
import type { G3cBroadcaster } from './g3c-execution-store.js';
import { serializeG3bUnsignedTransaction, g3bUnsignedTransactionHash, UNISWAP_V3_ROUTER_ABI } from './g3b-transaction.js';
import type { G2QuoteBundle, PaperQuote } from './policy.js';

const QUOTER = getAddress('0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a');
const GAS_PRICE_ORACLE = getAddress('0x420000000000000000000000000000000000000F');
const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
]);
const POOL_ABI = parseAbi([
  'function token0() view returns (address)', 'function token1() view returns (address)',
  'function fee() view returns (uint24)', 'function tickSpacing() view returns (int24)',
  'function factory() view returns (address)',
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
]);
const FACTORY_ABI = parseAbi(['function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)']);
const ERC20_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
]);
const ORACLE_ABI = parseAbi([
  'function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)',
  'function getL1Fee(bytes data) view returns (uint256)',
  'function getOperatorFee(uint256 gasUsed) view returns (uint256)',
]);
export interface G3cAccountObservation {
  readonly walletAddress: Address; readonly accountVersion: number; readonly blockNumber: bigint; readonly blockHash: Hex;
  readonly blockFinality: 'unsafe' | 'safe' | 'finalized'; readonly pendingNonce: bigint;
  readonly usdcBalanceAtomic: bigint; readonly wethBalanceAtomic: bigint; readonly gasBalanceNativeWei: bigint;
  readonly allowanceToken: Address; readonly allowanceSpender: Address; readonly allowanceAtomic: bigint;
  readonly usdcValueUsdcMicros: bigint; readonly wethValueUsdcMicros: bigint; readonly gasValueUsdcMicros: bigint;
  readonly walletValueUsdcMicros: bigint; readonly valuationPool: Address; readonly valuationBlockNumber: bigint;
  readonly valuationBlockHash: Hex;
}
export interface BasePolicyQuoteResult {
  readonly quotes: G2QuoteBundle;
  readonly executionTransaction: ExecutionTransactionEnvelope;
  readonly evidence: readonly string[];
}
export interface G3cReadOnlyBaseProvider {
  rpcBudgetSnapshot(): RpcRunBudgetSnapshot;
  withRecoveryBudget?<T>(operation: () => Promise<T>): Promise<T>;
  verifyDeployment(): Promise<BaseDeploymentEvidence>;
  account(walletAddress: string, allowanceToken: string, accountVersion: number, finality?: 'unsafe' | 'safe' | 'finalized'): Promise<G3cEvidenceAttestation>;
  quote(input: { executionId: string; operationId: string; tokenIn: string; tokenOut: string; amountIn: string; slippageBps?: number; blockNumber?: string; blockHash?: Hex; sourceFinality?: 'unsafe' | 'safe' }): Promise<G3cEvidenceAttestation>;
  policyQuoteBundle(input: { readonly intent: TradeIntent; readonly accountSnapshot: G3cEvidenceAttestation }): Promise<BasePolicyQuoteResult>;
  simulate(input: { executionId: string; operationId: string; transaction: G3bUnsignedTransaction; blockNumber?: string; blockHash?: Hex; sourceFinality?: 'unsafe' | 'safe' }): Promise<G3cEvidenceAttestation>;
  estimateFee(input: { executionId: string; operationId: string; transaction: G3bUnsignedTransaction; blockNumber?: string; blockHash?: Hex; sourceFinality?: 'unsafe' | 'safe' }): Promise<G3cEvidenceAttestation>;
  receipt(input: { executionId: string; operationId: string; transactionHash: Hex; sender: string; nonce: string }): Promise<G3cEvidenceAttestation>;
  close(): void;
}
function safeNonceNumber(value: string): number {
  const nonce = BigInt(value);
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('G3C_NONCE_OUT_OF_RANGE');
  return Number(nonce);
}
function safeUnsigned(value: bigint): string {
  if (value < 0n || value.toString().length > 128) throw new Error('G3C_PROVIDER_VALUE_INVALID');
  return value.toString();
}
function usdcMicros(atomic: bigint): bigint { return atomic; }
function ceilDiv(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error('G3C_DIVISOR_INVALID');
  return (n + d - 1n) / d;
}
function feeMarginWei(total: bigint): bigint { return ceilDiv(total * 2n, 10n); }
function feeValueWithMargin(valueUsdcMicros: bigint): bigint { return ceilDiv(valueUsdcMicros * 120n, 100n); }
function txHashBytesLength(tx: G3bUnsignedTransaction): bigint {
  const serialized = serializeG3bUnsignedTransaction(tx);
  return BigInt((serialized.length - 2) / 2 + 100);
}
function transactionDigest(tx: G3bUnsignedTransaction): string {
  return createHash('sha256').update(canonicalJson(tx)).digest('hex');
}
function impactFromSqrtPrice(input: { tokenIn: Address; amountIn: bigint; amountOut: bigint; sqrtPriceX96: bigint }): number {
  const q192 = 1n << 192n;
  const square = input.sqrtPriceX96 * input.sqrtPriceX96;
  const mid = input.tokenIn.toLowerCase() === BASE_TOKENS.WETH.toLowerCase()
    ? input.amountIn * square / q192
    : input.amountIn * q192 / square;
  if (mid <= 0n) throw new Error('G3C_MID_PRICE_INVALID');
  if (input.amountOut >= mid) return 0;
  const bps = (mid - input.amountOut) * 10_000n / mid;
  if (bps > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('G3C_IMPACT_OUT_OF_RANGE');
  return Number(bps);
}
function validateRpcUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('BASE_RPC_URL_INVALID'); }
  if (url.protocol !== 'https:' || !url.hostname) throw new Error('BASE_RPC_URL_MUST_USE_HTTPS');
  return url;
}
function receiptPayload(input: {
  executionId: string; operationId: string; transactionHash: Hex; sender: string; nonce: string;
  outcome: 'PENDING' | 'REPLACED' | 'CONFLICT';
}): Parameters<G3cEvidenceAuthority['attest']>[0] {
  return {
    kind: 'RECEIPT', executionId: input.executionId, operationId: input.operationId, chainId: 8453,
    transactionHash: input.transactionHash, sender: getAddress(input.sender), nonce: input.nonce,
    outcome: input.outcome, blockNumber: null, blockHash: null, finality: null, gasUsed: null,
    effectiveGasPriceWei: null, l1FeeWei: null, operatorFeeWei: null, actualFeeUsdcMicros: null, canonical: null,
  };
}
export function createBaseReadOnlyProvider(input: { readonly rpcUrl: string; readonly authority: G3cEvidenceAuthority; readonly clock?: () => Date; readonly client?: ReturnType<typeof createPublicClient>; readonly rpcBudget?: RpcRunBudget }): G3cReadOnlyBaseProvider {
  const url = validateRpcUrl(input.rpcUrl);
  const budget = input.rpcBudget ?? new RpcRunBudget(randomUUID(), DEFAULT_D2_RPC_MAX_REQUESTS, DEFAULT_D2_RPC_RECOVERY_RESERVE);
  const recoveryContext = new AsyncLocalStorage<boolean>();
  const countedFetch = async (request: string | URL | Request, init?: RequestInit) => {
    budget.consume(recoveryContext.getStore() === true ? 'recovery' : 'regular');
    return fetch(request, init);
  };
  const client = input.client ?? createPublicClient({ chain: base, transport: http(url.toString(), { retryCount: 0, timeout: 8000, batch: false, fetchFn: countedFetch }) });
  let deployment: BaseDeploymentEvidence | null = null;
  let deploymentCheckedAt = 0;
  const clock = input.clock ?? (() => new Date());
  async function taggedBlock(finality: 'latest' | 'safe' | 'finalized') {
    const value = await client.getBlock({ blockTag: finality });
    if (value.number === null || !value.hash || value.timestamp === null) throw new Error('G3C_CANONICAL_BLOCK_UNAVAILABLE');
    return { number: value.number, hash: value.hash, timestamp: value.timestamp, value };
  }
  async function finalityBlock(finality: 'unsafe' | 'safe' | 'finalized' = 'unsafe') { return taggedBlock(finality === 'unsafe' ? 'latest' : finality); }
  async function captureAnchor(source?: { number: bigint; hash: Hex; timestamp: bigint }, finality: G3cSourceFinality = 'unsafe') {
    const [latest, safe, finalized] = await Promise.all([
      taggedBlock('latest'), taggedBlock('safe'), taggedBlock('finalized'),
    ]);
    const fields: G3cEvidenceHeadAnchor = {
      latestHeadNumber: safeUnsigned(latest.number), latestHeadHash: latest.hash,
      latestHeadTimestamp: Number(latest.timestamp), safeHeadNumber: safeUnsigned(safe.number), safeHeadHash: safe.hash,
      safeHeadTimestamp: Number(safe.timestamp), finalizedHeadNumber: safeUnsigned(finalized.number), finalizedHeadHash: finalized.hash,
      finalizedHeadTimestamp: Number(finalized.timestamp),
    };
    const exactHeads = await Promise.all([
      client.getBlock({ blockNumber: latest.number }), client.getBlock({ blockNumber: safe.number }),
      client.getBlock({ blockNumber: finalized.number }),
    ]);
    const [latestExact, safeExact, finalizedExact] = exactHeads;
    if (latestExact.number !== latest.number || latestExact.hash?.toLowerCase() !== latest.hash.toLowerCase() || latestExact.timestamp !== latest.timestamp ||
        safeExact.number !== safe.number || safeExact.hash?.toLowerCase() !== safe.hash.toLowerCase() || safeExact.timestamp !== safe.timestamp ||
        finalizedExact.number !== finalized.number || finalizedExact.hash?.toLowerCase() !== finalized.hash.toLowerCase() || finalizedExact.timestamp !== finalized.timestamp) {
      throw new Error('G3C_BASE_HEAD_CHANGED_DURING_READ');
    }
    const now = clock();
    if (!(now instanceof Date) || !Number.isSafeInteger(now.getTime())) throw new Error('G3C_CLOCK_INVALID');
    if (source) {
      const canonical = await client.getBlock({ blockNumber: source.number });
      if (canonical.number !== source.number || canonical.hash?.toLowerCase() !== source.hash.toLowerCase() ||
          canonical.timestamp !== source.timestamp) throw new Error('G3C_SOURCE_BLOCK_CHANGED');
      const checkedAt = clock();
      if (!(checkedAt instanceof Date) || !Number.isSafeInteger(checkedAt.getTime())) throw new Error('G3C_CLOCK_INVALID');
      assertG3cHeadFreshness(fields, checkedAt.getTime(), {
        number: safeUnsigned(source.number), hash: source.hash, timestamp: Number(source.timestamp), finality,
      });
      return { ...fields, sourceFinality: finality, sourceBlockNumber: safeUnsigned(source.number), sourceBlockHash: source.hash,
        sourceBlockTimestamp: Number(source.timestamp) };
    }
    assertG3cHeadFreshness(fields, now.getTime());
    return { ...fields, sourceFinality: null, sourceBlockNumber: null, sourceBlockHash: null, sourceBlockTimestamp: null };
  }
  async function evidenceBlock(blockNumber?: string, blockHash?: Hex, finality: 'unsafe' | 'safe' = 'unsafe') {
    if (blockNumber === undefined && blockHash === undefined) {
      const block = await finalityBlock(finality);
      const anchor = await captureAnchor(block, finality);
      return { ...block, anchor };
    }
    if (blockNumber === undefined || blockHash === undefined || !/^(0|[1-9][0-9]*)$/u.test(blockNumber)) throw new Error('G3C_BLOCK_ANCHOR_INVALID');
    const number = BigInt(blockNumber);
    const block = await client.getBlock({ blockNumber: number });
    if (!block.hash || block.number !== number || block.hash.toLowerCase() !== blockHash.toLowerCase() || block.timestamp === null) {
      throw new Error('G3C_BLOCK_ANCHOR_NOT_CANONICAL_SAFE');
    }
    const source = { number, hash: block.hash, timestamp: block.timestamp };
    const anchor = await captureAnchor(source, finality);
    return { number, hash: block.hash, timestamp: block.timestamp, value: block, anchor };
  }
  async function ensureDeployment(): Promise<BaseDeploymentEvidence> {
    if (deployment && clock().getTime() - deploymentCheckedAt < 60_000) return deployment;
    const block = await finalityBlock('unsafe');
    deployment = await verifyBaseAllowlist({
      async readDeployment() {
        const [chainId, pool, token0, token1, fee, tickSpacing, factory, factoryCode, routerCode, poolCode, usdcCode, wethCode, quoterCode, oracleCode] = await Promise.all([
          client.getChainId(),
          client.readContract({ address: BASE_UNISWAP_V3.factory, abi: FACTORY_ABI, functionName: 'getPool', args: [BASE_TOKENS.USDC, BASE_TOKENS.WETH, 500], blockNumber: block.number }),
          client.readContract({ address: BASE_UNISWAP_V3.pool, abi: POOL_ABI, functionName: 'token0', blockNumber: block.number }),
          client.readContract({ address: BASE_UNISWAP_V3.pool, abi: POOL_ABI, functionName: 'token1', blockNumber: block.number }),
          client.readContract({ address: BASE_UNISWAP_V3.pool, abi: POOL_ABI, functionName: 'fee', blockNumber: block.number }),
          client.readContract({ address: BASE_UNISWAP_V3.pool, abi: POOL_ABI, functionName: 'tickSpacing', blockNumber: block.number }),
          client.readContract({ address: BASE_UNISWAP_V3.pool, abi: POOL_ABI, functionName: 'factory', blockNumber: block.number }),
          client.getBytecode({ address: BASE_UNISWAP_V3.factory, blockNumber: block.number }),
          client.getBytecode({ address: BASE_UNISWAP_V3.router, blockNumber: block.number }),
          client.getBytecode({ address: BASE_UNISWAP_V3.pool, blockNumber: block.number }),
          client.getBytecode({ address: BASE_TOKENS.USDC, blockNumber: block.number }),
          client.getBytecode({ address: BASE_TOKENS.WETH, blockNumber: block.number }),
          client.getBytecode({ address: QUOTER, blockNumber: block.number }),
          client.getBytecode({ address: GAS_PRICE_ORACLE, blockNumber: block.number }),
        ]);
        if (pool.toLowerCase() !== BASE_UNISWAP_V3.pool.toLowerCase() ||
            factory.toLowerCase() !== BASE_UNISWAP_V3.factory.toLowerCase() ||
            !quoterCode || quoterCode === '0x' || !oracleCode || oracleCode === '0x') throw new Error('BASE_DEPLOYMENT_IDENTITY_MISMATCH');
        return { chainId, factory, router: BASE_UNISWAP_V3.router, pool, token0, token1, fee, tickSpacing,
          factoryHasCode: Boolean(factoryCode && factoryCode !== '0x'), routerHasCode: Boolean(routerCode && routerCode !== '0x'),
          poolHasCode: Boolean(poolCode && poolCode !== '0x'), usdcHasCode: Boolean(usdcCode && usdcCode !== '0x'),
          wethHasCode: Boolean(wethCode && wethCode !== '0x') };
      },
    });
    deploymentCheckedAt = clock().getTime();
    return deployment;
  }
  async function quoteRaw(tokenIn: Address, tokenOut: Address, amountIn: bigint, blockNumber: bigint) {
    if (amountIn <= 0n) return { amountOut: 0n, priceImpactBps: 0 };
    const result = await client.readContract({ address: QUOTER, abi: QUOTER_ABI, functionName: 'quoteExactInputSingle',
      args: [{ tokenIn, tokenOut, amountIn, fee: BASE_UNISWAP_V3.fee, sqrtPriceLimitX96: 0n }], blockNumber }) as
      readonly [bigint, bigint, number, bigint];
    const state = await client.readContract({ address: BASE_UNISWAP_V3.pool, abi: POOL_ABI, functionName: 'slot0', blockNumber }) as
      readonly [bigint, number, number, number, number, number, boolean];
    const [amountOut] = result;
    const [sqrtPriceX96] = state;
    return { amountOut, priceImpactBps: impactFromSqrtPrice({ tokenIn, amountIn, amountOut, sqrtPriceX96 }) };
  }
  function signPayload<T extends Parameters<G3cEvidenceAuthority['attest']>[0]>(payload: T): G3cEvidenceAttestation {
    const withFeeAnchor = payload.kind === 'RECEIPT' && (payload.outcome === 'CONFIRMED' || payload.outcome === 'REVERTED')
      ? payload
      : { ...payload, feeValuationBlockNumber: null, feeValuationBlockHash: null, feeValuationBlockTimestamp: null };
    return input.authority.attest(withFeeAnchor);
  }

  async function policyQuoteBundle(input: { readonly intent: TradeIntent; readonly accountSnapshot: G3cEvidenceAttestation }): Promise<BasePolicyQuoteResult> {
    await ensureDeployment();
    const account = input.accountSnapshot.payload;
    const intent = input.intent;
    if (account.kind !== 'ACCOUNT_SNAPSHOT' || account.blockFinality !== 'unsafe' ||
        account.walletAddress.toLowerCase() !== intent.walletAddress.toLowerCase() || intent.chainId !== 8453 ||
        intent.sellAsset === intent.buyAsset || account.pendingNonce.length > 15) throw new Error('G2_BASE_ACCOUNT_CONTEXT_INVALID');
    const sourceBlock = await evidenceBlock(account.blockNumber, account.blockHash as Hex, 'unsafe');
    const tokenIn = BASE_TOKENS[intent.sellAsset];
    const tokenOut = BASE_TOKENS[intent.buyAsset];
    const amountIn = BigInt(intent.amountIn);
    if (amountIn <= 0n) throw new Error('G2_BASE_QUOTE_AMOUNT_INVALID');
    const trade = await quoteRaw(tokenIn, tokenOut, amountIn, sourceBlock.number);
    if (trade.amountOut <= 0n) throw new Error('G2_BASE_QUOTE_EMPTY');
    const minOut = trade.amountOut * 9_950n / 10_000n;
    if (minOut <= 0n) throw new Error('G2_BASE_MINIMUM_OUTPUT_INVALID');
    const fees = await client.estimateFeesPerGas({ type: 'eip1559', chain: base });
    if (!fees.maxFeePerGas || fees.maxPriorityFeePerGas === undefined || fees.maxPriorityFeePerGas > fees.maxFeePerGas) {
      throw new Error('G2_BASE_FEE_DATA_UNAVAILABLE');
    }
    const inner = encodeFunctionData({
      abi: UNISWAP_V3_ROUTER_ABI, functionName: 'exactInputSingle',
      args: [{ tokenIn, tokenOut, fee: BASE_UNISWAP_V3.fee, recipient: getAddress(intent.walletAddress),
        amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
    });
    const deadline = BigInt(Math.floor(Date.parse(intent.expiresAt) / 1000));
    const data = encodeFunctionData({ abi: UNISWAP_V3_ROUTER_ABI, functionName: 'multicall', args: [deadline, [inner]] });
    const gasEstimate = await client.estimateGas({
      account: getAddress(intent.walletAddress), to: BASE_UNISWAP_V3.router, data, value: 0n,
      nonce: safeNonceNumber(account.pendingNonce), maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas, blockNumber: sourceBlock.number,
    });
    const gasLimit = ceilDiv(gasEstimate * 120n, 100n);
    if (gasLimit < gasEstimate || gasLimit <= 0n || gasLimit > 450_000n) throw new Error('G2_BASE_GAS_LIMIT_EXCEEDED');
    const unsigned = g3bUnsignedTransactionSchema.parse({
      version: 1, type: 'EIP1559', chainId: 8453, from: getAddress(intent.walletAddress), to: BASE_UNISWAP_V3.router,
      data, valueWei: '0', nonce: account.pendingNonce, gasLimit: safeUnsigned(gasLimit),
      maxFeePerGasWei: safeUnsigned(fees.maxFeePerGas), maxPriorityFeePerGasWei: safeUnsigned(fees.maxPriorityFeePerGas), accessList: [],
    });
    const [l1DataFeeWei, operatorFeeWei] = await Promise.all([
      client.readContract({ address: GAS_PRICE_ORACLE, abi: ORACLE_ABI, functionName: 'getL1FeeUpperBound',
        args: [txHashBytesLength(unsigned)], blockNumber: sourceBlock.number }),
      client.readContract({ address: GAS_PRICE_ORACLE, abi: ORACLE_ABI, functionName: 'getOperatorFee',
        args: [gasLimit], blockNumber: sourceBlock.number }),
    ]);
    const subtotal = gasLimit * fees.maxFeePerGas + l1DataFeeWei + operatorFeeWei;
    const totalFeeWei = subtotal + feeMarginWei(subtotal);
    const feeValue = await quoteRaw(BASE_TOKENS.WETH, BASE_TOKENS.USDC, totalFeeWei, sourceBlock.number);
    if (feeValue.amountOut <= 0n) throw new Error('G2_BASE_FEE_VALUATION_UNAVAILABLE');
    const feeUsdcMicros = feeValueWithMargin(feeValue.amountOut);
    const wethBalance = BigInt(account.wethBalanceAtomic);

    const gasBalance = BigInt(account.gasBalanceNativeWei);
    const projectedWeth = intent.buyAsset === 'WETH' ? wethBalance + trade.amountOut : wethBalance - amountIn;
    const projectedGas = gasBalance > totalFeeWei ? gasBalance - totalFeeWei : 0n;
    const [position, projectedPosition, gas, projectedGasValue] = await Promise.all([
      wethBalance > 0n ? quoteRaw(BASE_TOKENS.WETH, BASE_TOKENS.USDC, wethBalance, sourceBlock.number) : null,
      projectedWeth > 0n ? quoteRaw(BASE_TOKENS.WETH, BASE_TOKENS.USDC, projectedWeth, sourceBlock.number) : null,
      gasBalance > 0n ? quoteRaw(BASE_TOKENS.WETH, BASE_TOKENS.USDC, gasBalance, sourceBlock.number) : null,
      projectedGas > 0n ? quoteRaw(BASE_TOKENS.WETH, BASE_TOKENS.USDC, projectedGas, sourceBlock.number) : null,
    ]);
    const checkedAt = clock();
    if (!(checkedAt instanceof Date) || !Number.isSafeInteger(checkedAt.getTime()) || checkedAt.getTime() < 0) throw new Error('G3C_CLOCK_INVALID');
    await captureAnchor(sourceBlock, 'unsafe');
    const quotedAt = checkedAt.toISOString();
    const makeQuote = (sellAsset: 'USDC' | 'WETH', buyAsset: 'USDC' | 'WETH', inputAmount: bigint, outputAmount: bigint,
      slippageBps: number, priceImpactBps: number, fee: bigint, feeNative: bigint): PaperQuote => ({
        source: 'pool', chainId: 8453, sellAsset, buyAsset, amountIn: safeUnsigned(inputAmount),
        amountOut: safeUnsigned(outputAmount), quotedAt, slippageBps, priceImpactBps,
        feeUsdcMicros: safeUnsigned(fee), gasFeeNativeWei: safeUnsigned(feeNative),
      });
    const tradeQuote = makeQuote(intent.sellAsset, intent.buyAsset, amountIn, trade.amountOut, 50, trade.priceImpactBps, feeUsdcMicros, totalFeeWei);
    const gasQuote = gas ? {
      source: 'pool' as const, chainId: 8453 as const, amountInNativeWei: safeUnsigned(gasBalance),
      valueUsdcMicros: safeUnsigned(gas.amountOut), quotedAt,
    } : null;
    const gasFeeQuote = {
      source: 'pool' as const, chainId: 8453 as const, amountInNativeWei: safeUnsigned(totalFeeWei),
      valueUsdcMicros: safeUnsigned(feeUsdcMicros), quotedAt,
    };
    const projectedGasQuote = projectedGasValue ? {
      source: 'pool' as const, chainId: 8453 as const, amountInNativeWei: safeUnsigned(projectedGas),
      valueUsdcMicros: safeUnsigned(projectedGasValue.amountOut), quotedAt,
    } : null;
    const currentPositionQuote = position
      ? makeQuote('WETH', 'USDC', wethBalance, position.amountOut, 0, position.priceImpactBps, 0n, 0n) : null;
    const projectedPositionQuote = projectedPosition
      ? makeQuote('WETH', 'USDC', projectedWeth, projectedPosition.amountOut, 0, projectedPosition.priceImpactBps, 0n, 0n) : null;
    const quotes: G2QuoteBundle = {
      accountVersion: account.accountVersion, positionQuote: currentPositionQuote, tradeQuote,
      projectedPositionQuote, gasQuote, projectedGasQuote, gasFeeQuote,
    };
    const executionTransaction: ExecutionTransactionEnvelope = {
      version: 1, chainId: 8453, walletAddress: getAddress(intent.walletAddress), router: BASE_UNISWAP_V3.router,
      recipient: getAddress(intent.walletAddress), sellAsset: intent.sellAsset, buyAsset: intent.buyAsset,
      amountIn: safeUnsigned(amountIn), minimumAmountOut: safeUnsigned(minOut), valueNativeWei: '0',
      maxFeePerGasWei: safeUnsigned(fees.maxFeePerGas), maxPriorityFeePerGasWei: safeUnsigned(fees.maxPriorityFeePerGas),
      maxTotalFeeWei: safeUnsigned(totalFeeWei), chainNonce: account.pendingNonce, expiresAt: intent.expiresAt,
    };
    return { quotes, executionTransaction, evidence: Object.freeze([
      'base:' + sourceBlock.number.toString() + ':' + sourceBlock.hash.toLowerCase(),
      'base-fee-cap:' + safeUnsigned(totalFeeWei),
      'base-pool:' + BASE_UNISWAP_V3.pool.toLowerCase(),
    ]) };
  }
  return {
    rpcBudgetSnapshot: () => budget.snapshot(),
    withRecoveryBudget: <T>(operation: () => Promise<T>) => recoveryContext.run(true, operation),
    verifyDeployment: ensureDeployment,
    async account(walletAddress, allowanceToken, accountVersion, finality = 'unsafe') {
      const wallet = getAddress(walletAddress);
      const token = getAddress(allowanceToken);
      if (![BASE_TOKENS.USDC, BASE_TOKENS.WETH].some((candidate) => candidate.toLowerCase() === token.toLowerCase()) ||
          !Number.isSafeInteger(accountVersion) || accountVersion < 1) throw new Error('G3C_ACCOUNT_INPUT_INVALID');
      await ensureDeployment();
      const block = await finalityBlock(finality);
      const initialAnchor = await captureAnchor(block, finality);
      const [chainId, usdcBalance, wethBalance, gasBalance, allowance, nonce] = await Promise.all([
        client.getChainId(),
        client.readContract({ address: BASE_TOKENS.USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet], blockNumber: block.number }),
        client.readContract({ address: BASE_TOKENS.WETH, abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet], blockNumber: block.number }),
        client.getBalance({ address: wallet, blockNumber: block.number }),
        client.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [wallet, BASE_UNISWAP_V3.router], blockNumber: block.number }),
        client.getTransactionCount({ address: wallet, blockTag: 'pending' }),
      ]);
      if (chainId !== 8453) throw new Error('BASE_CHAIN_ID_MISMATCH');
      const [wethValue, gasValue] = await Promise.all([
        quoteRaw(BASE_TOKENS.WETH, BASE_TOKENS.USDC, wethBalance, block.number),
        quoteRaw(BASE_TOKENS.WETH, BASE_TOKENS.USDC, gasBalance, block.number),
      ]);
      const [usdcAgain, wethAgain, gasAgain, allowanceAgain, nonceAgain] = await Promise.all([
        client.readContract({ address: BASE_TOKENS.USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet], blockNumber: block.number }),
        client.readContract({ address: BASE_TOKENS.WETH, abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet], blockNumber: block.number }),
        client.getBalance({ address: wallet, blockNumber: block.number }),
        client.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [wallet, BASE_UNISWAP_V3.router], blockNumber: block.number }),
        client.getTransactionCount({ address: wallet, blockTag: 'pending' }),
      ]);
      if (usdcAgain !== usdcBalance || wethAgain !== wethBalance || gasAgain !== gasBalance ||
          allowanceAgain !== allowance || nonceAgain !== nonce) throw new Error('G3C_ACCOUNT_CHANGED_DURING_READ');
      const anchor = await captureAnchor(block, finality);
      if (initialAnchor.sourceBlockHash?.toLowerCase() !== anchor.sourceBlockHash?.toLowerCase()) throw new Error('G3C_SOURCE_BLOCK_CHANGED');
      const usdcValue = usdcMicros(usdcBalance);
      const wethValueMicros = wethValue.amountOut;
      const gasValueMicros = gasValue.amountOut;
      return signPayload({
        kind: 'ACCOUNT_SNAPSHOT', ...anchor, walletAddress: wallet, chainId: 8453, accountVersion,
        blockNumber: safeUnsigned(block.number), blockHash: block.hash, blockFinality: finality,
        pendingNonce: safeUnsigned(BigInt(nonce)), usdcBalanceAtomic: safeUnsigned(usdcBalance), wethBalanceAtomic: safeUnsigned(wethBalance),
        gasBalanceNativeWei: safeUnsigned(gasBalance), allowanceToken: token, allowanceSpender: BASE_UNISWAP_V3.router,
        allowanceAtomic: safeUnsigned(allowance), usdcValueUsdcMicros: safeUnsigned(usdcValue), wethValueUsdcMicros: safeUnsigned(wethValueMicros),
        gasValueUsdcMicros: safeUnsigned(gasValueMicros), walletValueUsdcMicros: safeUnsigned(usdcValue + wethValueMicros + gasValueMicros),
        valuationPool: BASE_UNISWAP_V3.pool, valuationBlockNumber: safeUnsigned(block.number), valuationBlockHash: block.hash,
      });
    },
    async quote(query) {
      await ensureDeployment();
      const tokenIn = getAddress(query.tokenIn); const tokenOut = getAddress(query.tokenOut);
      const validPair = (tokenIn.toLowerCase() === BASE_TOKENS.USDC.toLowerCase() && tokenOut.toLowerCase() === BASE_TOKENS.WETH.toLowerCase()) ||
        (tokenIn.toLowerCase() === BASE_TOKENS.WETH.toLowerCase() && tokenOut.toLowerCase() === BASE_TOKENS.USDC.toLowerCase());
      const amountIn = BigInt(query.amountIn); const slippageBps = query.slippageBps ?? 50;
      if (!validPair || amountIn <= 0n || !Number.isSafeInteger(slippageBps) || slippageBps < 0 || slippageBps > 50) throw new Error('G3C_QUOTE_INPUT_INVALID');
      const block = await evidenceBlock(query.blockNumber, query.blockHash, query.sourceFinality ?? 'unsafe');
      const result = await quoteRaw(tokenIn, tokenOut, amountIn, block.number);
      const anchor = await captureAnchor(block, query.sourceFinality ?? 'unsafe');
      if (result.amountOut <= 0n) throw new Error('G3C_QUOTE_EMPTY');
      const minOut = result.amountOut * BigInt(10_000 - slippageBps) / 10_000n;
      return signPayload({
        kind: 'QUOTE', ...anchor, executionId: query.executionId, operationId: query.operationId, chainId: 8453,
        poolAddress: BASE_UNISWAP_V3.pool, tokenIn, tokenOut, fee: 500, amountIn: safeUnsigned(amountIn),
        amountOut: safeUnsigned(result.amountOut), minimumAmountOut: safeUnsigned(minOut), slippageBps,
        priceImpactBps: result.priceImpactBps, blockNumber: safeUnsigned(block.number), blockHash: block.hash,
      });
    },
    policyQuoteBundle,
    async simulate(query) {
      await ensureDeployment();
      const tx = query.transaction; const block = await evidenceBlock(query.blockNumber, query.blockHash, query.sourceFinality ?? 'unsafe');
      let outcome: 'PASSED' | 'FAILED' = 'PASSED';
      let gasEstimate = BigInt(tx.gasLimit);
      try {
        await client.call({ account: getAddress(tx.from), to: getAddress(tx.to), data: tx.data as Hex,
          value: BigInt(tx.valueWei), nonce: safeNonceNumber(tx.nonce), gas: BigInt(tx.gasLimit),
          maxFeePerGas: BigInt(tx.maxFeePerGasWei), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGasWei), blockNumber: block.number });
        gasEstimate = await client.estimateGas({ account: getAddress(tx.from), to: getAddress(tx.to), data: tx.data as Hex,
          value: BigInt(tx.valueWei), nonce: safeNonceNumber(tx.nonce), gas: BigInt(tx.gasLimit),
          maxFeePerGas: BigInt(tx.maxFeePerGasWei), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGasWei), blockNumber: block.number });
      } catch { outcome = 'FAILED'; }
      const anchor = await captureAnchor(block, query.sourceFinality ?? 'unsafe');
      return signPayload({
        kind: 'SIMULATION', ...anchor, executionId: query.executionId, operationId: query.operationId, chainId: 8453,
        transactionDigest: transactionDigest(tx), unsignedTransactionHash: g3bUnsignedTransactionHash(tx),
        outcome, blockNumber: safeUnsigned(block.number), blockHash: block.hash,
        gasEstimate: safeUnsigned(gasEstimate), revertGasEstimate: tx.gasLimit,
      });
    },
    async estimateFee(query) {
      await ensureDeployment();
      const tx = query.transaction; const block = await evidenceBlock(query.blockNumber, query.blockHash, query.sourceFinality ?? 'unsafe');
      const [gasEstimate, fees] = await Promise.all([
        client.estimateGas({ account: getAddress(tx.from), to: getAddress(tx.to), data: tx.data as Hex,
          value: BigInt(tx.valueWei), blockNumber: block.number }),
        client.estimateFeesPerGas({ type: 'eip1559', chain: base }),
      ]);
      if (!fees.maxFeePerGas || fees.maxPriorityFeePerGas === undefined ||
          BigInt(tx.maxFeePerGasWei) < fees.maxFeePerGas || BigInt(tx.maxPriorityFeePerGasWei) < fees.maxPriorityFeePerGas ||
          BigInt(tx.gasLimit) < ceilDiv(gasEstimate * 120n, 100n)) throw new Error('G3C_FEE_OR_GAS_CEILING_INSUFFICIENT');
      const gasLimit = BigInt(tx.gasLimit);
      const executionGasFeeCapWei = gasLimit * BigInt(tx.maxFeePerGasWei);
      const [l1DataFeeWei, operatorFeeWei] = await Promise.all([
        client.readContract({ address: GAS_PRICE_ORACLE, abi: ORACLE_ABI, functionName: 'getL1FeeUpperBound',
          args: [txHashBytesLength(tx)], blockNumber: block.number }),
        client.readContract({ address: GAS_PRICE_ORACLE, abi: ORACLE_ABI, functionName: 'getOperatorFee',
          args: [gasLimit], blockNumber: block.number }),
      ]);
      const subtotal = executionGasFeeCapWei + l1DataFeeWei + operatorFeeWei;
      const safetyMarginWei = feeMarginWei(subtotal);
      const totalFeeWei = subtotal + safetyMarginWei;
      const quote = await quoteRaw(BASE_TOKENS.WETH, BASE_TOKENS.USDC, totalFeeWei, block.number);
      const anchor = await captureAnchor(block, query.sourceFinality ?? 'unsafe');
      if (quote.amountOut <= 0n) throw new Error('G3C_FEE_VALUATION_UNAVAILABLE');
      return signPayload({
        kind: 'BASE_FEE', ...anchor, executionId: query.executionId, operationId: query.operationId, chainId: 8453,
        unsignedTransactionHash: g3bUnsignedTransactionHash(tx), blockNumber: safeUnsigned(block.number), blockHash: block.hash,
        gasLimit: safeUnsigned(gasLimit),
        maxFeePerGasWei: tx.maxFeePerGasWei, executionGasFeeCapWei: safeUnsigned(executionGasFeeCapWei),
        l1DataFeeWei: safeUnsigned(l1DataFeeWei), operatorFeeWei: safeUnsigned(operatorFeeWei),
        safetyMarginWei: safeUnsigned(safetyMarginWei), totalFeeWei: safeUnsigned(totalFeeWei),
        valueUsdcMicros: safeUnsigned(feeValueWithMargin(quote.amountOut)), includesRevertPath: true,
      });
    },
    async receipt(query) {
      return recoveryContext.run(true, async () => {
      await ensureDeployment();
      const sender = getAddress(query.sender);
      let tx;
      try { tx = await client.getTransaction({ hash: query.transactionHash }); }
      catch {
        let pendingNonce: bigint;
        try { pendingNonce = BigInt(await client.getTransactionCount({ address: sender, blockTag: 'pending' })); }
        catch { throw new Error('G3C_RECEIPT_PROVIDER_UNAVAILABLE'); }
        const outcome = pendingNonce > BigInt(query.nonce) ? 'CONFLICT' : 'PENDING';
        return signPayload({ ...receiptPayload({ ...query, sender, outcome }), ...await captureAnchor() });
      }
      if (tx.hash.toLowerCase() !== query.transactionHash.toLowerCase() || tx.from.toLowerCase() !== sender.toLowerCase() || tx.nonce.toString() !== query.nonce) {
        return signPayload({ ...receiptPayload({ ...query, sender, outcome: 'CONFLICT' }), ...await captureAnchor() });
      }
      let receipt;
      try { receipt = await client.getTransactionReceipt({ hash: query.transactionHash }); }
      catch { return signPayload({ ...receiptPayload({ ...query, sender, outcome: 'PENDING' }), ...await captureAnchor() }); }
      if (receipt.transactionHash.toLowerCase() !== query.transactionHash.toLowerCase()) {
        return signPayload({ ...receiptPayload({ ...query, sender, outcome: 'CONFLICT' }), ...await captureAnchor() });
      }
      const [receiptBlock, safe, finalized, raw] = await Promise.all([
        client.getBlock({ blockNumber: receipt.blockNumber }), finalityBlock('safe'), finalityBlock('finalized'),
        client.getRawTransaction({ hash: query.transactionHash }),
      ]);
      const canonical = receiptBlock.hash?.toLowerCase() === receipt.blockHash.toLowerCase() && receiptBlock.timestamp !== null;
      if (!canonical || !raw) return signPayload({ ...receiptPayload({ ...query, sender, outcome: 'CONFLICT' }), ...await captureAnchor() });
      const rawBytes = raw as Hex;
      const [l1Fee, operatorFee] = await Promise.all([
        client.readContract({ address: GAS_PRICE_ORACLE, abi: ORACLE_ABI, functionName: 'getL1Fee',
          args: [rawBytes], blockNumber: receipt.blockNumber }),
        client.readContract({ address: GAS_PRICE_ORACLE, abi: ORACLE_ABI, functionName: 'getOperatorFee',
          args: [receipt.gasUsed], blockNumber: receipt.blockNumber }),
      ]);
      const actualFeeWei = receipt.gasUsed * receipt.effectiveGasPrice + l1Fee + operatorFee;
      const finality = BigInt(receipt.blockNumber) <= finalized.number ? 'finalized' :
        BigInt(receipt.blockNumber) <= safe.number ? 'safe' : 'unsafe';
      const source = { number: BigInt(receipt.blockNumber), hash: receipt.blockHash, timestamp: receiptBlock.timestamp! };
      const value = await quoteRaw(BASE_TOKENS.WETH, BASE_TOKENS.USDC, actualFeeWei, source.number);
      if (value.amountOut <= 0n) throw new Error('G3C_RECEIPT_FEE_VALUATION_UNAVAILABLE');
      const actualFeeUsdcMicros = usdcMicros(value.amountOut);
      const headAnchor = await captureAnchor(source, finality === 'finalized' ? 'historical-finalized' : finality);
      return signPayload({
        kind: 'RECEIPT', ...headAnchor,
        feeValuationBlockNumber: safeUnsigned(source.number), feeValuationBlockHash: source.hash,
        feeValuationBlockTimestamp: Number(source.timestamp),
        executionId: query.executionId, operationId: query.operationId, chainId: 8453,
        transactionHash: query.transactionHash, sender, nonce: safeUnsigned(BigInt(tx.nonce)),
        outcome: receipt.status === 'success' ? 'CONFIRMED' : 'REVERTED',
        blockNumber: safeUnsigned(BigInt(receipt.blockNumber)), blockHash: receipt.blockHash, finality,
        gasUsed: safeUnsigned(receipt.gasUsed), effectiveGasPriceWei: safeUnsigned(receipt.effectiveGasPrice),
        l1FeeWei: safeUnsigned(l1Fee), operatorFeeWei: safeUnsigned(operatorFee),
        actualFeeUsdcMicros: safeUnsigned(actualFeeUsdcMicros), canonical: true,
      });
      });
    },
    close() { /* HTTP JSON-RPC transport keeps no persistent client resource. */ },
  };
}

/** Optional Base broadcaster; construction is inert and every send requires reviewed live mode. */
export function createBaseG3cBroadcaster(input: { readonly rpcUrl: string; readonly enabled: boolean }): G3cBroadcaster & { close(): void } {
  const url = validateRpcUrl(input.rpcUrl);
  const client = createPublicClient({ chain: base, transport: http(url.toString(), { retryCount: 0, timeout: 8000 }) });
  return {
    async sendRawTransaction(signedBytesHex) {
      if (input.enabled !== true || process.env.LIVE_EXECUTION_ENABLED !== 'true' ||
          process.env.EXECUTION_MODE !== 'live-reviewed' || process.env.G3C_REVIEWED_MODE !== 'true') throw new Error('G3C_BROADCAST_DISABLED');
      if (!/^0x02[0-9a-fA-F]+$/u.test(signedBytesHex)) throw new Error('G3C_SIGNED_TRANSACTION_INVALID');
      if (await client.getChainId() !== 8453) throw new Error('BASE_CHAIN_ID_MISMATCH');
      return client.sendRawTransaction({ serializedTransaction: signedBytesHex as Hex });
    },
    close() { /* HTTP JSON-RPC transport keeps no persistent client resource. */ },
  };
}

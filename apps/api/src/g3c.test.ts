import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { fork, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { G3bUnsignedTransaction, G3cEvidenceAttestation, TradeIntent } from '@ered-luin/contracts';
import { canonicalJson, d2ProposalSchema } from '@ered-luin/contracts';
import { initializeExecutionStore, openExecutionStore, type ExecutionStore } from './execution-store.js';
import { openPaperStore } from './paper-store.js';
import { createApiApp } from './api.js';
import { initializeD2AuditStore, openD2AuditStore } from './d2-audit-store.js';
import { G3cExecutionStore, type G3cBroadcaster, type G3cWorkflowInput } from './g3c-execution-store.js';
import { createSyntheticG3cEvidenceAuthority, loadProductionG3cEvidenceAuthority, loadProductionG3cEvidenceTrust } from './g3c-evidence.js';
import { buildG3cUnsignedTransaction } from './g3c-transaction.js';
import { decodeExactSwap, g3bUnsignedTransactionHash } from './g3b-transaction.js';
import { createSyntheticIsolatedG3cSigner, type G3cIsolatedSigner } from './g3c-signer-client.js';
import { createG3cSignerMessage } from './g3c-signer-protocol.js';
import { startBaseG3cSession, prepareBaseG3cOperation, simulateBaseG3cOperation, signBaseG3cOperation,
  broadcastBaseG3cOperation, reconcileBaseG3cOperation } from './g3c-orchestrator.js';
import { BASE_TOKENS, BASE_UNISWAP_V3, type BaseDeploymentEvidence } from './base-allowlist.js';
import { createBaseReadOnlyProvider, type G3cReadOnlyBaseProvider } from './g3c-base-provider.js';

let nowMs = Date.now();
const dirs: string[] = [];
const stores: ExecutionStore[] = [];
const signers: G3cIsolatedSigner[] = [];
const g3cWorkerPath = fileURLToPath(new URL('./g3c-store-worker.mjs', import.meta.url));
const g3cSignerWorkerPath = fileURLToPath(new URL('../../signer/dist/g3c-worker.js', import.meta.url));
const HASHES = Array.from({ length: 8 }, (_, index) => `0x${String(index + 1).repeat(64)}` as Hex);
function syntheticBaseHeadHash(number: bigint): Hex {
  return ('0x' + createHash('sha256').update('synthetic-base-head:' + number.toString()).digest('hex')) as Hex;
}

function setup(options: { readonly amountIn?: string; readonly exposure?: string; readonly g3cOptions?: { allowTestSigning?: boolean; allowTestBroadcast?: boolean } } = {}) {
  nowMs = Date.now();
  const dir = mkdtempSync(join(tmpdir(), 'ered-luin-g3c-')); dirs.push(dir);
  const databasePath = join(dir, 'state.sqlite');
  const walletPrivateKey = generatePrivateKey();
  const wallet = privateKeyToAccount(walletPrivateKey).address;
  const clock = () => new Date(nowMs);
  const execution = initializeExecutionStore({ databasePath, clock }); stores.push(execution);
  execution.setKillSwitch(false, 'synthetic G3c test fixture');
  const amountIn = options.amountIn ?? '5000000';
  const exposure = options.exposure ?? amountIn;
  const intent: TradeIntent = {
    intentId: randomUUID(), chainId: 8453, walletAddress: wallet, sellAsset: 'USDC', buyAsset: 'WETH', amountIn,
    issuedAt: new Date(nowMs - 10_000).toISOString(), expiresAt: new Date(nowMs + 60_000).toISOString(),
  };
  const decision = {
    decisionId: randomUUID(), intentId: intent.intentId, status: 'ALLOW' as const,
    evaluatedAt: new Date(nowMs - 5_000).toISOString(), policyVersion: 'g3c-synthetic-test',
    requestedAmountIn: amountIn, approvedAmountIn: amountIn, reasons: ['SYNTHETIC_TEST_ONLY'],
  };
  const transaction = {
    version: 1 as const, chainId: 8453 as const, walletAddress: wallet, router: BASE_UNISWAP_V3.router,
    recipient: wallet, sellAsset: 'USDC' as const, buyAsset: 'WETH' as const, amountIn,
    minimumAmountOut: '1', valueNativeWei: '0', maxFeePerGasWei: '3', maxPriorityFeePerGasWei: '1',
    maxTotalFeeWei: '1000000000', chainNonce: '0', expiresAt: intent.expiresAt,
  };
  const parent = execution.reserve({ executionId: randomUUID(), intent, decision, accountVersion: 1,
    reservationExposureUsdcMicros: exposure, transaction, reason: 'synthetic G2-approved parent' }).record;
  const authority = createSyntheticG3cEvidenceAuthority(clock);
  const g3c = new G3cExecutionStore(execution, authority.trust, options.g3cOptions ?? { allowTestSigning: true, allowTestBroadcast: true }, clock);
  return { dir, databasePath, execution, parent, wallet, walletPrivateKey, authority, g3c, clock };
}

function accountEvidence(ctx: ReturnType<typeof setup>, input: {
  readonly version: number; readonly blockNumber: string; readonly blockHash?: Hex; readonly finality?: 'unsafe' | 'safe' | 'finalized';
  readonly nonce: string; readonly allowance?: string; readonly usdc?: string; readonly weth?: string;
  readonly wethValue?: string; readonly gasValue?: string;
}): G3cEvidenceAttestation {
  const usdc = BigInt(input.usdc ?? '10000000');
  const wethValue = BigInt(input.wethValue ?? '0');
  const gasValue = BigInt(input.gasValue ?? '1000000');
  return ctx.authority.attest({
    kind: 'ACCOUNT_SNAPSHOT', walletAddress: ctx.wallet, chainId: 8453, accountVersion: input.version,
    blockNumber: input.blockNumber, blockHash: input.blockHash ?? HASHES[input.version % HASHES.length]!,
    blockFinality: input.finality ?? 'unsafe', pendingNonce: input.nonce,
    usdcBalanceAtomic: usdc.toString(), wethBalanceAtomic: input.weth ?? '0', gasBalanceNativeWei: '10000000000000000',
    allowanceToken: BASE_TOKENS.USDC, allowanceSpender: BASE_UNISWAP_V3.router, allowanceAtomic: input.allowance ?? '0',
    usdcValueUsdcMicros: usdc.toString(), wethValueUsdcMicros: wethValue.toString(), gasValueUsdcMicros: gasValue.toString(),
    walletValueUsdcMicros: (usdc + wethValue + gasValue).toString(), valuationPool: BASE_UNISWAP_V3.pool,
    valuationBlockNumber: input.blockNumber, valuationBlockHash: input.blockHash ?? HASHES[input.version % HASHES.length]!,
  });
}

function reserveAdditionalParent(ctx: ReturnType<typeof setup>, nonce: string) {
  const intent: TradeIntent = { intentId: randomUUID(), chainId: 8453, walletAddress: ctx.wallet,
    sellAsset: 'USDC', buyAsset: 'WETH', amountIn: '5000000',
    issuedAt: new Date(nowMs - 10_000).toISOString(), expiresAt: new Date(nowMs + 60_000).toISOString() };
  const decision = { decisionId: randomUUID(), intentId: intent.intentId, status: 'ALLOW' as const,
    evaluatedAt: new Date(nowMs - 5_000).toISOString(), policyVersion: 'g3c-synthetic-test',
    requestedAmountIn: intent.amountIn, approvedAmountIn: intent.amountIn, reasons: ['SYNTHETIC_TEST_ONLY'] };
  const transaction = { version: 1 as const, chainId: 8453 as const, walletAddress: ctx.wallet,
    router: BASE_UNISWAP_V3.router, recipient: ctx.wallet, sellAsset: 'USDC' as const, buyAsset: 'WETH' as const,
    amountIn: intent.amountIn, minimumAmountOut: '1', valueNativeWei: '0', maxFeePerGasWei: '3',
    maxPriorityFeePerGasWei: '1', maxTotalFeeWei: '1000000000', chainNonce: nonce, expiresAt: intent.expiresAt };
  return ctx.execution.reserve({ executionId: randomUUID(), intent, decision, accountVersion: 1,
    reservationExposureUsdcMicros: '5000000', transaction, reason: 'synthetic sequential G2-approved parent' }).record;
}

function accountPayload(version: number) {
  if (version === 1) return { blockNumber: '100', nonce: '0', allowance: '0', usdc: '10000000', gasValue: '1000000' } as const;
  if (version === 2) return { blockNumber: '101', nonce: '0', allowance: '0', usdc: '10000000', gasValue: '1000000' } as const;
  if (version === 3) return { blockNumber: '102', nonce: '1', allowance: '5000000', usdc: '10000000', gasValue: '997000', finality: 'finalized' as const } as const;
  if (version === 4) return { blockNumber: '103', nonce: '1', allowance: '5000000', usdc: '10000000', gasValue: '997000' } as const;
  if (version === 5) return { blockNumber: '104', nonce: '2', allowance: '5000000', usdc: '5000000', weth: '2500000000000000',
    wethValue: '5000000', gasValue: '994000', finality: 'finalized' as const } as const;
  throw new Error('Unexpected synthetic account version');
}

function testProvider(ctx: ReturnType<typeof setup>): G3cReadOnlyBaseProvider {
  let receiptCount = 0;
  const deployment: BaseDeploymentEvidence = {
    chainId: 8453, factory: BASE_UNISWAP_V3.factory, router: BASE_UNISWAP_V3.router, pool: BASE_UNISWAP_V3.pool,
    token0: BASE_TOKENS.WETH, token1: BASE_TOKENS.USDC, fee: 500, tickSpacing: 10,
    factoryHasCode: true, routerHasCode: true, poolHasCode: true, usdcHasCode: true, wethHasCode: true,
  };
  return {
    rpcBudgetSnapshot: () => ({ runId: 'g3c-test', maxRequests: 100, recoveryReserve: 10, usedRequests: 0, regularRequests: 0, recoveryRequests: 0, remainingRequests: 100, regularRemainingRequests: 90 }),
    policyQuoteBundle: async () => { throw new Error('G3c fixture does not exercise policy quotes.'); },
    verifyDeployment: async () => deployment,
    async account(_wallet, _token, version, finality = 'unsafe') {
      const data = accountPayload(version);
      return accountEvidence(ctx, { ...data, version, finality });
    },
    async quote(input) {
      const amountOut = '2500000000000000';
      const minimumAmountOut = (BigInt(amountOut) * 9950n / 10000n).toString();
      return ctx.authority.attest({
        kind: 'QUOTE', executionId: input.executionId, operationId: input.operationId, chainId: 8453,
        poolAddress: BASE_UNISWAP_V3.pool, tokenIn: input.tokenIn, tokenOut: input.tokenOut, fee: 500,
        amountIn: input.amountIn, amountOut, minimumAmountOut, slippageBps: 50, priceImpactBps: 20,
        blockNumber: input.blockNumber ?? '103', blockHash: input.blockHash ?? HASHES[103 % HASHES.length]!,
      });
    },
    async simulate(input) {
      const gasEstimate = input.transaction.to.toLowerCase() === BASE_TOKENS.USDC.toLowerCase() ? '65000' : '100000';
      return ctx.authority.attest({
        kind: 'SIMULATION', executionId: input.executionId, operationId: input.operationId, chainId: 8453,
        transactionDigest: createHash('sha256').update(canonicalJson(input.transaction)).digest('hex'),
        unsignedTransactionHash: g3bUnsignedTransactionHash(input.transaction), outcome: 'PASSED',
        blockNumber: input.blockNumber ?? '101', blockHash: input.blockHash ?? HASHES[101 % HASHES.length]!,
        gasEstimate, revertGasEstimate: input.transaction.gasLimit,
      });
    },
    async estimateFee(input) {
      const executionGasFeeCapWei = BigInt(input.transaction.gasLimit) * BigInt(input.transaction.maxFeePerGasWei);
      const l1DataFeeWei = 1000n; const operatorFeeWei = 500n;
      const subtotal = executionGasFeeCapWei + l1DataFeeWei + operatorFeeWei;
      const safetyMarginWei = (subtotal + 9n) / 10n;
      return ctx.authority.attest({
        kind: 'BASE_FEE', executionId: input.executionId, operationId: input.operationId, chainId: 8453,
        unsignedTransactionHash: g3bUnsignedTransactionHash(input.transaction), blockNumber: input.blockNumber ?? '101',
        blockHash: input.blockHash ?? HASHES[101 % HASHES.length]!, gasLimit: input.transaction.gasLimit,
        maxFeePerGasWei: input.transaction.maxFeePerGasWei, executionGasFeeCapWei: executionGasFeeCapWei.toString(),
        l1DataFeeWei: l1DataFeeWei.toString(), operatorFeeWei: operatorFeeWei.toString(), safetyMarginWei: safetyMarginWei.toString(),
        totalFeeWei: (subtotal + safetyMarginWei).toString(), valueUsdcMicros: '10000', includesRevertPath: true,
      });
    },
    async receipt(input) {
      receiptCount += 1;
      const blockNumber = receiptCount === 1 ? '102' : '104';
      return ctx.authority.attest({
        kind: 'RECEIPT', executionId: input.executionId, operationId: input.operationId, chainId: 8453,
        transactionHash: input.transactionHash, sender: input.sender, nonce: input.nonce, outcome: 'CONFIRMED',
        blockNumber, blockHash: blockNumber === '102' ? HASHES[2]! : HASHES[4]!, finality: 'finalized',
        gasUsed: receiptCount === 1 ? '65000' : '100000', effectiveGasPriceWei: '2',
        l1FeeWei: '1000', operatorFeeWei: '500', actualFeeUsdcMicros: '3000', canonical: true,
      });
    },
    close() {},
  };
}

function makeSeparatedProductionProvider(ctx: ReturnType<typeof setup>, options: { readonly receiptStatus?: 'success' | 'reverted'; readonly receiptBlockHashMismatch?: boolean } = {}) {
  const startedAtMs = nowMs;
  let approved = false;
  let broadcastHash: Hex | null = null;
  let broadcastTransaction: G3bUnsignedTransaction | null = null;
  const hashFor = (number: bigint): Hex => ('0x' + number.toString(16).padStart(64, '0')) as Hex;
  const heads = () => {
    const elapsedBlocks = BigInt(Math.max(0, Math.floor((nowMs - startedAtMs) / 2_000)));
    const latest = 1000n + elapsedBlocks;
    return { latest, safe: latest - 60n, finalized: latest - 450n };
  };
  const blockTimestamp = (number: bigint) => BigInt(Math.floor(startedAtMs / 1000) + Number(number - 1000n) * 2);
  const rpc = {
    async getBlock(input: { blockTag?: string; blockNumber?: bigint }) {
      const current = heads();
      const number = input.blockTag === 'latest' ? current.latest :
        input.blockTag === 'safe' ? current.safe :
          input.blockTag === 'finalized' ? current.finalized : input.blockNumber!;
      return { number, hash: hashFor(number), timestamp: blockTimestamp(number) };
    },
    async getChainId() { return 8453; },
    async getBytecode() { return '0x6000'; },
    async getBalance() { return 10_000_000_000_000n; },
    async getTransactionCount() { return approved ? 1n : 0n; },
    async call() { return '0x'; },
    async estimateGas() { return 65_000n; },
    async estimateFeesPerGas() { return { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }; },
    async getTransaction(input: { hash: Hex }) {
      if (!approved || input.hash.toLowerCase() !== broadcastHash?.toLowerCase()) throw new Error('Synthetic transaction is not known');
      const tx = broadcastTransaction;
      return tx ? { hash: input.hash, type: 'eip1559', chainId: 8453, from: tx.from, to: tx.to, input: tx.data,
        value: BigInt(tx.valueWei), nonce: Number(tx.nonce), gas: BigInt(tx.gasLimit),
        maxFeePerGas: BigInt(tx.maxFeePerGasWei), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGasWei), accessList: [] }
        : { hash: input.hash, from: ctx.wallet, nonce: 0n };
    },
    async getTransactionReceipt(input: { hash: Hex }) {
      if (!approved || input.hash.toLowerCase() !== broadcastHash?.toLowerCase()) throw new Error('Synthetic receipt is not ready');
      return { transactionHash: input.hash, blockNumber: 1000n,
        blockHash: options.receiptBlockHashMismatch ? hashFor(999n) : hashFor(1000n),
        status: options.receiptStatus ?? 'success', gasUsed: 65_000n, effectiveGasPrice: 2n };
    },
    async getRawTransaction() { return '0x02c0'; },
    async readContract(input: { address?: string; functionName: string; args?: readonly unknown[] }) {
      if (input.functionName === 'getPool') return BASE_UNISWAP_V3.pool;
      if (input.functionName === 'token0') return BASE_TOKENS.WETH;
      if (input.functionName === 'token1') return BASE_TOKENS.USDC;
      if (input.functionName === 'fee') return 500;
      if (input.functionName === 'tickSpacing') return 10;
      if (input.functionName === 'factory') return BASE_UNISWAP_V3.factory;
      if (input.functionName === 'balanceOf') {
        return input.address?.toLowerCase() === BASE_TOKENS.USDC.toLowerCase() ? 10_000_000n : 0n;
      }
      if (input.functionName === 'allowance') return approved && options.receiptStatus !== 'reverted' ? 5_000_000n : 0n;
      if (input.functionName === 'quoteExactInputSingle') {
        const params = input.args?.[0] as { readonly tokenIn: string; readonly amountIn: bigint };
        const amountOut = params.tokenIn.toLowerCase() === BASE_TOKENS.WETH.toLowerCase()
          ? params.amountIn < 1_000_000_000_000n ? 1n : params.amountIn / 1_000_000_000_000n * 3_000n
          : params.amountIn * 1_000_000_000_000n;
        return [amountOut, 1n << 96n, 0, 65_000n];
      }
      if (input.functionName === 'slot0') return [1n << 96n, 0, 0, 0, 0, 0, true];
      if (input.functionName === 'getL1FeeUpperBound' || input.functionName === 'getL1Fee' ||
          input.functionName === 'getOperatorFee') return 1_000n;
      throw new Error('Unexpected synthetic Base read: ' + input.functionName);
    },
  };
  const provider = createBaseReadOnlyProvider({ rpcUrl: 'https://unused.invalid', authority: ctx.authority,
    clock: ctx.clock, client: rpc as never });
  return {
    provider,
    markBroadcast(hash: Hex, transaction?: G3bUnsignedTransaction) { broadcastHash = hash; broadcastTransaction = transaction ?? null; approved = true; },
  };
}

function workflowInput(ctx: ReturnType<typeof setup>, snapshot: G3cEvidenceAttestation, kind: 'APPROVAL' | 'SWAP' = 'SWAP',
  options: { readonly feeMicros?: string; readonly slippageBps?: number; readonly priceImpactBps?: number;
    readonly feeBlockNumber?: string; readonly feeBlockHash?: Hex; readonly executionId?: string } = {}): G3cWorkflowInput {
  const parent = ctx.execution.get(options.executionId ?? ctx.parent.executionId);
  const operationId = randomUUID();
  const account = snapshot.payload;
  if (account.kind !== 'ACCOUNT_SNAPSHOT') throw new Error('account needed');
  const quote = kind === 'SWAP' ? ctx.authority.attest({
    kind: 'QUOTE', executionId: parent.executionId, operationId, chainId: 8453,
    poolAddress: BASE_UNISWAP_V3.pool, tokenIn: BASE_TOKENS.USDC, tokenOut: BASE_TOKENS.WETH, fee: 500,
    amountIn: parent.transaction.amountIn, amountOut: '2500000000000000',
    minimumAmountOut: (2500000000000000n * BigInt(10000 - (options.slippageBps ?? 50)) / 10000n).toString(),
    slippageBps: options.slippageBps ?? 50, priceImpactBps: options.priceImpactBps ?? 20,
    blockNumber: account.blockNumber, blockHash: account.blockHash,
  }) : null;
  const unsignedTransaction = buildG3cUnsignedTransaction({ parent, kind, accountSnapshot: snapshot, quote, gasLimit: 120000n });
  const txHash = g3bUnsignedTransactionHash(unsignedTransaction);
  const feeBase = BigInt(unsignedTransaction.gasLimit) * BigInt(unsignedTransaction.maxFeePerGasWei);
  const l1 = 1000n; const operator = 500n; const subtotal = feeBase + l1 + operator; const margin = (subtotal + 9n) / 10n;
  const feeMicros = options.feeMicros ?? '10000';
  const simulation = ctx.authority.attest({
    kind: 'SIMULATION', executionId: parent.executionId, operationId, chainId: 8453,
    transactionDigest: createHash('sha256').update(canonicalJson(unsignedTransaction)).digest('hex'),
    unsignedTransactionHash: txHash, outcome: 'PASSED', blockNumber: account.blockNumber,
    blockHash: account.blockHash, gasEstimate: '100000', revertGasEstimate: unsignedTransaction.gasLimit,
  });
  const fee = ctx.authority.attest({
    kind: 'BASE_FEE', executionId: parent.executionId, operationId, chainId: 8453,
    unsignedTransactionHash: txHash, blockNumber: options.feeBlockNumber ?? account.blockNumber, blockHash: options.feeBlockHash ?? account.blockHash,
    gasLimit: unsignedTransaction.gasLimit, maxFeePerGasWei: unsignedTransaction.maxFeePerGasWei,
    executionGasFeeCapWei: feeBase.toString(), l1DataFeeWei: l1.toString(), operatorFeeWei: operator.toString(),
    safetyMarginWei: margin.toString(), totalFeeWei: (subtotal + margin).toString(), valueUsdcMicros: feeMicros, includesRevertPath: true,
  });
  return { executionId: parent.executionId, operationId, sessionId: randomUUID(), kind, unsignedTransaction, accountSnapshot: snapshot,
    quote, simulation, fee, reason: 'synthetic G3c workflow fixture' };
}

function startFixtureSession(ctx: ReturnType<typeof setup>, snapshot = accountEvidence(ctx, {
  version: 1, blockNumber: '100', nonce: '0', allowance: ctx.parent.transaction.amountIn,
})) {
  const sessionId = randomUUID();
  const session = ctx.g3c.startSession({ sessionId, accountSnapshot: snapshot, reason: 'synthetic G3c session start' });
  return { sessionId, session, snapshot };
}

async function prepareAndSubmitApproval(ctx: ReturnType<typeof setup>) {
  const provider = testProvider(ctx);
  const session = await startBaseG3cSession({ store: ctx.g3c, provider, sessionId: randomUUID(),
    walletAddress: ctx.wallet, allowanceToken: BASE_TOKENS.USDC, reason: 'synthetic approval-only session' });
  const operationId = randomUUID();
  await prepareBaseG3cOperation({ store: ctx.g3c, provider, executionId: ctx.parent.executionId,
    operationId, sessionId: session.sessionId, kind: 'APPROVAL', reason: 'synthetic approval-only operation' });
  const signed = await signBaseG3cOperation({ store: ctx.g3c, provider, operationId, signer: makeSigner(ctx),
    reason: 'synthetic approval signing' });
  await broadcastBaseG3cOperation({ store: ctx.g3c, operationId,
    broadcaster: { async sendRawTransaction() { return signed.workflow.transactionHash as Hex; } },
    reason: 'synthetic approval broadcast', clock: ctx.clock });
  return { provider, session, operationId, signed };
}

type RaceResult = { readonly type: string; readonly ok?: boolean; readonly operationId?: string; readonly status?: string; readonly claimId?: string };
type RaceTask = { readonly action: 'prepare'; readonly input: G3cWorkflowInput } |
  { readonly action: 'claim'; readonly operationId: string; readonly snapshot: G3cEvidenceAttestation } |
  { readonly action: 'legacy-release'; readonly executionId: string; readonly accountVersion: number };
function startRaceWorker(ctx: ReturnType<typeof setup>, task: RaceTask) {
  const child = fork(g3cWorkerPath, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  let readyResolve!: () => void;
  let resultResolve!: (result: RaceResult) => void;
  let rejectAll!: (error: Error) => void;
  const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
  const result = new Promise<RaceResult>((resolve, reject) => { resultResolve = resolve; rejectAll = reject; });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || !('type' in message)) return;
    const value = message as RaceResult & { failed?: boolean };
    if (value.type === 'READY') {
      if (value.failed) rejectAll(new Error('G3c race worker failed to initialize.'));
      else readyResolve();
    } else if (value.type === 'RESULT') resultResolve(value);
  });
  child.once('error', rejectAll);
  child.send({ databasePath: ctx.databasePath, trust: ctx.authority.trust, ...task });
  return { child, ready, result, exited };
}
async function runRace(ctx: ReturnType<typeof setup>, tasks: readonly RaceTask[]): Promise<readonly RaceResult[]> {
  const workers = tasks.map((task) => startRaceWorker(ctx, task));
  await Promise.all(workers.map((worker) => worker.ready));
  for (const worker of workers) worker.child.send({ type: 'GO' });
  const results = await Promise.all(workers.map((worker) => worker.result));
  await Promise.all(workers.map((worker) => worker.exited));
  return results;
}

function makeSigner(ctx: ReturnType<typeof setup>) {
  const signer = createSyntheticIsolatedG3cSigner({
    privateKey: ctx.walletPrivateKey, hmacSecret: Buffer.alloc(32, 7), trust: ctx.authority.trust,
    statePath: join(ctx.dir, 'signer-replay.sqlite'), repositoryRoot: process.cwd(),
  });
  signers.push(signer);
  return signer;
}

function invokeRawSignerWorker(message: string, ctx: ReturnType<typeof setup>, statePath: string): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const worker = spawn(process.execPath, [g3cSignerWorkerPath], {
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
        NODE_ENV: 'test', ERED_LUIN_G3C_MODE: 'test', ERED_LUIN_G3C_HMAC_KEY: Buffer.alloc(32, 7).toString('hex'),
        ERED_LUIN_G3C_STATE_PATH: statePath, ERED_LUIN_G3C_REPOSITORY_ROOT: process.cwd(),
        ERED_LUIN_G3C_TEST_PRIVATE_KEY: ctx.walletPrivateKey,
        ERED_LUIN_G3C_TEST_TRUST_KEYS: JSON.stringify(ctx.authority.trust.publicKeys),
      },
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    if (!worker.stdin || !worker.stdout) { worker.kill(); rejectPromise(new Error('G3C_SIGNER_PROCESS_FAILED')); return; }
    worker.stdout.setEncoding('utf8');
    let output = '';
    let response: Record<string, unknown> | undefined;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.kill();
      rejectPromise(new Error('G3C_SIGNER_PROCESS_TIMEOUT'));
    }, 10_000);
    worker.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 8192) { worker.kill(); return; }
      const newline = output.indexOf('\n');
      if (newline < 0 || response) return;
      try { response = JSON.parse(output.slice(0, newline)) as Record<string, unknown>; }
      catch { worker.kill(); }
    });
    worker.once('error', (error) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); rejectPromise(error);
    });
    worker.once('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      if (response) resolvePromise(response);
      else rejectPromise(new Error(`G3C_SIGNER_PROCESS_FAILED:${code ?? 'unknown'}`));
    });
    worker.stdin.end(`${message}\n`);
  });
}

afterEach(async () => {
  for (const signer of signers.splice(0)) { try { await signer.close(); } catch { /* already closed */ } }
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('G3c durable Base execution path', () => {
  it.each(['success', 'reverted'] as const)(
    'recovers a one-hour-old finalized %s approval after restart without double settlement', async (receiptStatus) => {
      const ctx = setup({ g3cOptions: { allowTestSigning: true, allowTestBroadcast: true } });
      const { provider, markBroadcast } = makeSeparatedProductionProvider(ctx, { receiptStatus });
      const session = await startBaseG3cSession({ store: ctx.g3c, provider, sessionId: randomUUID(),
        walletAddress: ctx.wallet, allowanceToken: BASE_TOKENS.USDC, reason: 'synthetic separated-head session' });
      expect(session.latestSnapshot?.payload).toMatchObject({ kind: 'ACCOUNT_SNAPSHOT', blockNumber: '1000', blockFinality: 'unsafe',
        latestHeadNumber: '1000', safeHeadNumber: '940', finalizedHeadNumber: '550' });

      const operationId = randomUUID();
      const prepared = await prepareBaseG3cOperation({ store: ctx.g3c, provider, executionId: ctx.parent.executionId,
        operationId, sessionId: session.sessionId, kind: 'APPROVAL', reason: 'synthetic delayed-finality approval' });
      expect(prepared.workflow.accountSnapshot.payload).toMatchObject({ kind: 'ACCOUNT_SNAPSHOT', blockNumber: '1000',
        blockFinality: 'unsafe', sourceFinality: 'unsafe', latestHeadNumber: '1000', safeHeadNumber: '940', finalizedHeadNumber: '550' });
      expect(prepared.workflow.simulation?.payload).toMatchObject({ kind: 'SIMULATION', blockNumber: '1000', sourceFinality: 'unsafe' });
      expect(prepared.workflow.fee?.payload).toMatchObject({ kind: 'BASE_FEE', blockNumber: '1000', sourceFinality: 'unsafe' });

      const signed = await signBaseG3cOperation({ store: ctx.g3c, provider, operationId, signer: makeSigner(ctx),
        reason: 'synthetic approval signing under unsafe source policy' });
      await broadcastBaseG3cOperation({ store: ctx.g3c, operationId, broadcaster: {
        async sendRawTransaction() {
          const hash = signed.workflow.transactionHash as Hex;
          markBroadcast(hash, signed.workflow.unsignedTransaction);
          return hash;
        },
      }, reason: 'synthetic approval broadcast', clock: ctx.clock });

      nowMs = Math.max(Date.parse(ctx.parent.intent.expiresAt) + 1, nowMs + 3_600_001);
      ctx.execution.close();
      const unresolvedStore = openExecutionStore({ databasePath: ctx.databasePath, clock: ctx.clock });
      stores.push(unresolvedStore);
      ctx.execution = unresolvedStore;
      ctx.g3c = new G3cExecutionStore(unresolvedStore, ctx.authority.trust, {}, ctx.clock);
      expect(ctx.g3c.getWorkflow(operationId)).toMatchObject({
        status: 'SUBMITTED', signedBytesHex: signed.workflow.signedBytesHex, transactionHash: signed.workflow.transactionHash,
      });

      const settled = await reconcileBaseG3cOperation({ store: ctx.g3c, provider, operationId,
        reason: 'synthetic one-hour finalized approval recovery after restart' });
      const expectedStatus = receiptStatus === 'success' ? 'CONFIRMED' : 'REVERTED';
      expect(settled.workflow.status).toBe(expectedStatus);
      if (!settled.workflow.receipt || !settled.workflow.settlementSnapshot) throw new Error('settled receipt evidence missing');
      const receiptPayload = settled.workflow.receipt.payload;
      const receiptBlockHash = ('0x' + (1000n).toString(16).padStart(64, '0')) as Hex;
      expect(receiptPayload).toMatchObject({ kind: 'RECEIPT', outcome: expectedStatus,
        finality: 'finalized', sourceFinality: 'historical-finalized', blockNumber: '1000', blockHash: receiptBlockHash,
        feeValuationBlockNumber: '1000', feeValuationBlockHash: receiptBlockHash,
        latestHeadNumber: '2800', safeHeadNumber: '2740', finalizedHeadNumber: '2350', actualFeeUsdcMicros: '1' });
      if (receiptPayload.kind !== 'RECEIPT') throw new Error('receipt payload missing');
      expect(receiptPayload.feeValuationBlockTimestamp).toBe(receiptPayload.sourceBlockTimestamp);
      const replay = ctx.g3c.recordReceipt(operationId, settled.workflow.receipt, settled.workflow.settlementSnapshot,
        'synthetic duplicate finalized settlement delivery');
      expect(replay.replayed).toBe(true);
      expect(ctx.g3c.getSession(session.sessionId)).toMatchObject({
        status: 'ACTIVE', realizedFeesUsdcMicros: '1', outstandingWorstCaseReservationsUsdcMicros: '0',
      });

      if (receiptStatus === 'success') {
        const current = ctx.g3c.getSession(session.sessionId);
        const releaseSnapshot = await provider.account(ctx.wallet, BASE_TOKENS.USDC, current.latestAccountVersion + 1, 'finalized');
        ctx.g3c.releaseAfterApprovalOnly(ctx.parent.executionId, releaseSnapshot, 'expired synthetic approval-only release');
      }
      expect(ctx.execution.get(ctx.parent.executionId).status).toBe('RELEASED');
      const releasedSession = ctx.g3c.getSession(session.sessionId);
      expect(releasedSession.latestSnapshot?.payload).toMatchObject({ kind: 'ACCOUNT_SNAPSHOT',
        allowanceAtomic: receiptStatus === 'success' ? '5000000' : '0' });

      ctx.execution.close();
      const settledStore = openExecutionStore({ databasePath: ctx.databasePath, clock: ctx.clock });
      stores.push(settledStore);
      const recovered = new G3cExecutionStore(settledStore, ctx.authority.trust, {}, ctx.clock);
      expect(recovered.getWorkflow(operationId).status).toBe(expectedStatus);
      expect(recovered.getSession(session.sessionId)).toMatchObject({
        status: 'ACTIVE', realizedFeesUsdcMicros: '1', outstandingWorstCaseReservationsUsdcMicros: '0',
      });
    },
  );

  it('rejects a historical receipt whose inclusion block hash is not canonical', async () => {
    const ctx = setup({ g3cOptions: { allowTestSigning: true, allowTestBroadcast: true } });
    const { provider, markBroadcast } = makeSeparatedProductionProvider(ctx, { receiptBlockHashMismatch: true });
    const transactionHash = ('0x' + 'a'.repeat(64)) as Hex;
    markBroadcast(transactionHash);
    nowMs += 3_600_001;
    const evidence = await provider.receipt({ executionId: ctx.parent.executionId, operationId: randomUUID(),
      transactionHash, sender: ctx.wallet, nonce: '0' });
    expect(evidence.payload).toMatchObject({ kind: 'RECEIPT', outcome: 'CONFLICT', canonical: null,
      blockNumber: null, sourceBlockNumber: null, sourceFinality: null });
  });

  it('runs nonce-zero approval through an isolated signer and fake broadcaster, then swaps and settles exact fees', async () => {
    const ctx = setup({ g3cOptions: { allowTestSigning: true, allowTestBroadcast: true } });
    const provider = testProvider(ctx);
    const session = await startBaseG3cSession({ store: ctx.g3c, provider, sessionId: randomUUID(), walletAddress: ctx.wallet,
      allowanceToken: BASE_TOKENS.USDC, reason: 'synthetic session' });
    const signer = makeSigner(ctx);
    let broadcastCount = 0;
    let latestOperationId = '';

    for (const [kind, nonce] of [['APPROVAL', '0'], ['SWAP', '1']] as const) {
      const operationId = randomUUID();
      latestOperationId = operationId;
      const prepared = await prepareBaseG3cOperation({ store: ctx.g3c, provider, executionId: ctx.parent.executionId,
        operationId, sessionId: session.sessionId, kind, reason: 'synthetic operation prepared' });
      expect(prepared.workflow.status).toBe('AUTHORIZED');
      expect(prepared.workflow.unsignedTransaction.nonce).toBe(nonce);
      let savedRequest: Parameters<typeof signer.sign>[0] | null = null;
      const interceptingSigner = { sign: async (request: Parameters<typeof signer.sign>[0]) => {
        savedRequest = request;
        return signer.sign(request);
      } };
      const signed = await signBaseG3cOperation({ store: ctx.g3c, provider, operationId, signer: interceptingSigner,
        reason: 'synthetic isolated sign' });
      expect(signed.workflow.status).toBe('SIGNED_OUTBOX');
      if (kind === 'APPROVAL') {
        expect(savedRequest).not.toBeNull();
        const unauthorizedMessage = JSON.parse(createG3cSignerMessage(savedRequest!, Buffer.alloc(32, 7))) as { mac: string };
        unauthorizedMessage.mac = '00'.repeat(32);
        const unauthorizedStatePath = join(ctx.dir, 'unauthorized-signer.sqlite');
        await expect(invokeRawSignerWorker(JSON.stringify(unauthorizedMessage), ctx, unauthorizedStatePath)).resolves.toMatchObject({ ok: false });
        const unauthorizedDb = new DatabaseSync(unauthorizedStatePath);
        try {
          const ledgerRow = unauthorizedDb.prepare('SELECT COUNT(*) AS count FROM g3c_signer_consumed_claims').get() as { count: number };
          expect(Number(ledgerRow.count)).toBe(0);
        } finally { unauthorizedDb.close(); }
        await expect(signer.sign(savedRequest!)).rejects.toThrow();
        await signer.close();
        const restarted = makeSigner(ctx);
        await expect(restarted.sign(savedRequest!)).rejects.toThrow();
      }
      const broadcaster: G3cBroadcaster = { async sendRawTransaction(raw) {
        broadcastCount += 1;
        expect(raw).toBe(signed.workflow.signedBytesHex);
        return signed.workflow.transactionHash as Hex;
      } };
      const submitted = await broadcastBaseG3cOperation({ store: ctx.g3c, operationId, broadcaster, reason: 'synthetic fake broadcast', clock: ctx.clock });
      expect(submitted.workflow.status).toBe('SUBMITTED');
      const settled = await reconcileBaseG3cOperation({ store: ctx.g3c, provider, operationId, reason: 'synthetic finalized receipt' });
      expect(settled.workflow.status).toBe('CONFIRMED');
    }

    expect(broadcastCount).toBe(2);
    expect(ctx.g3c.listReconciliationQueue()).toHaveLength(0);
    const finalWorkflow = ctx.g3c.getWorkflow(latestOperationId);
    expect(finalWorkflow.unsignedTransaction.nonce).toBe('1');
    const finalSession = ctx.g3c.getSession(session.sessionId);
    expect(finalSession.status).toBe('ACTIVE');
    expect(finalSession.realizedFeesUsdcMicros).toBe('6000');
    expect(finalSession.realizedLossUsdcMicros).toBe('0');
    expect(finalSession.outstandingWorstCaseReservationsUsdcMicros).toBe('0');
    const d1Status = ctx.g3c.status(ctx.parent.executionId);
    expect(d1Status.status).toBe('CONFIRMED');
    expect(d1Status.requestedAmount).toBe('5000000');
    expect(d1Status.permittedAmount).toBe('5000000');
    expect(d1Status.actualFeesUsdcMicros).toBe('3000');
    expect(d1Status.evidenceProvenance.length).toBeGreaterThan(0);

  });

  it('fails closed on mismatched fee block, oversized exposure, stale account and policy rejection before signing', () => {
    const ctx = setup({ g3cOptions: { allowTestSigning: true, allowTestBroadcast: true } });
    const session = startFixtureSession(ctx);
    const input = workflowInput(ctx, session.snapshot, 'SWAP', { feeBlockNumber: '99', feeBlockHash: HASHES[7]! });
    const corrected = { ...input, sessionId: session.sessionId };
    expect(() => ctx.g3c.prepareOperation(corrected)).toThrow();
    expect(ctx.g3c.getSession(session.sessionId).outstandingWorstCaseReservationsUsdcMicros).toBe('0');

    const overLimit = setup({ amountIn: '6000000', exposure: '6000000' });
    const overSession = startFixtureSession(overLimit);
    const overInput = workflowInput(overLimit, overSession.snapshot, 'SWAP');
    const overBound = { ...overInput, sessionId: overSession.sessionId };
    expect(() => overLimit.g3c.prepareOperation(overBound)).toThrow();

    const staleCtx = setup();
    const staleSession = startFixtureSession(staleCtx);
    const newer = accountEvidence(staleCtx, { version: 2, blockNumber: '101', nonce: '0', allowance: '5000000' });
    staleCtx.g3c.refreshSessionSnapshot(staleSession.sessionId, newer, 'synthetic account refresh');
    const staleInput = { ...workflowInput(staleCtx, staleSession.snapshot), sessionId: staleSession.sessionId };
    expect(() => staleCtx.g3c.prepareOperation(staleInput)).toThrow();
    expect(staleCtx.g3c.getSession(staleSession.sessionId).outstandingWorstCaseReservationsUsdcMicros).toBe('0');
  });

  it('marks account drawdown against session equity and stops at the $2 loss boundary', () => {
    const ctx = setup({ g3cOptions: { allowTestSigning: true, allowTestBroadcast: true } });
    const session = startFixtureSession(ctx);
    const adverse = accountEvidence(ctx, { version: 2, blockNumber: '101', nonce: '0', allowance: '5000000',
      usdc: '8000000', gasValue: '1000000' });
    const updated = ctx.g3c.refreshSessionSnapshot(session.sessionId, adverse, 'synthetic adverse mark');
    expect(updated.unrealizedLossUsdcMicros).toBe('2000000');
    expect(updated.status).toBe('STOPPED');
    const input = { ...workflowInput(ctx, adverse), sessionId: session.sessionId };
    expect(() => ctx.g3c.prepareOperation(input)).toThrow();
    expect(() => ctx.g3c.getWorkflow(input.operationId)).toThrow();
  });

  it('keeps reservations through pending, conflicting, and safe-but-not-final receipts, then stops on actual fee breach', async () => {
    const ctx = setup({ g3cOptions: { allowTestSigning: true, allowTestBroadcast: true } });
    const session = startFixtureSession(ctx);
    const input = { ...workflowInput(ctx, session.snapshot), sessionId: session.sessionId };
    const authorized = ctx.g3c.prepareOperation(input).workflow;
    const signer = makeSigner(ctx);
    const request = ctx.g3c.claimForSigning(authorized.operationId, session.snapshot, 'synthetic claim');
    const signed = await signer.sign(request);
    await ctx.g3c.persistSigned(authorized.operationId, signed.signedBytesHex, signed.transactionHash, 'persist before fake network');
    const release = ctx.g3c.prepareBroadcast(authorized.operationId, 'fake submission');
    expect(release.attempt).toBe(1);
    ctx.g3c.recordSubmissionAccepted(authorized.operationId, release.transactionHash, new Date(nowMs).toISOString(), 'fake RPC accepted');

    const receiptBase = {
      kind: 'RECEIPT' as const, executionId: ctx.parent.executionId, operationId: authorized.operationId, chainId: 8453 as const,
      transactionHash: signed.transactionHash, sender: ctx.wallet, nonce: '0',
    };
    const nullReceiptFields = { blockNumber: null, blockHash: null, finality: null, gasUsed: null,
      effectiveGasPriceWei: null, l1FeeWei: null, operatorFeeWei: null, actualFeeUsdcMicros: null, canonical: null };
    const pending = ctx.authority.attest({ ...receiptBase, ...nullReceiptFields, outcome: 'PENDING' });
    expect(ctx.g3c.recordReceipt(authorized.operationId, pending, null, 'pending receipt').workflow.status).toBe('SUBMISSION_UNCERTAIN');
    const conflict = ctx.authority.attest({ ...receiptBase, ...nullReceiptFields, outcome: 'CONFLICT' });
    expect(ctx.g3c.recordReceipt(authorized.operationId, conflict, null, 'nonce conflict').workflow.status).toBe('RECONCILIATION_REQUIRED');
    expect(ctx.g3c.getSession(session.sessionId).outstandingWorstCaseReservationsUsdcMicros).toBe(authorized.reservedWorstCaseLossUsdcMicros);

    const safeReceipt = ctx.authority.attest({ ...receiptBase, outcome: 'CONFIRMED',
      blockNumber: '101', blockHash: HASHES[1]!, finality: 'safe', gasUsed: '100000', effectiveGasPriceWei: '2',
      l1FeeWei: '1000', operatorFeeWei: '500', actualFeeUsdcMicros: '251000', canonical: true });
    expect(ctx.g3c.recordReceipt(authorized.operationId, safeReceipt, null, 'await Base finality').workflow.status)
      .toBe('RECONCILIATION_REQUIRED');
    expect(ctx.g3c.getSession(session.sessionId).outstandingWorstCaseReservationsUsdcMicros).toBe(authorized.reservedWorstCaseLossUsdcMicros);

    const finalizedReceipt = ctx.authority.attest({ ...receiptBase, outcome: 'CONFIRMED',
      blockNumber: '101', blockHash: HASHES[1]!, finality: 'finalized', gasUsed: '100000', effectiveGasPriceWei: '2',
      l1FeeWei: '1000', operatorFeeWei: '500', actualFeeUsdcMicros: '251000', canonical: true });
    const settlement = accountEvidence(ctx, { version: 2, blockNumber: '102', nonce: '1', allowance: '5000000', finality: 'finalized',
      usdc: '10000000', gasValue: '749000' });
    const settled = ctx.g3c.recordReceipt(authorized.operationId, finalizedReceipt, settlement, 'finalized exact transaction');
    expect(settled.workflow.status).toBe('CONFIRMED');
    const finalSession = ctx.g3c.getSession(session.sessionId);
    expect(finalSession.status).toBe('STOPPED');
    expect(finalSession.realizedFeesUsdcMicros).toBe('251000');
    expect(finalSession.outstandingWorstCaseReservationsUsdcMicros).toBe('0');
    expect(finalSession.realizedLossUsdcMicros).toBe('0');
  });

  it('blocks the next authorization when cumulative realized fees plus worst-case reserve would exceed $2', async () => {
    const ctx = setup({ g3cOptions: { allowTestSigning: true, allowTestBroadcast: true } });
    const initial = accountEvidence(ctx, { version: 1, blockNumber: '100', nonce: '0', allowance: '5000000', gasValue: '2500000' });
    const session = ctx.g3c.startSession({ sessionId: randomUUID(), accountSnapshot: initial, reason: 'synthetic cumulative-fee session' });
    const signer = makeSigner(ctx);
    let snapshot = initial;

    for (let index = 0; index < 7; index += 1) {
      const parent = index === 0 ? ctx.parent : reserveAdditionalParent(ctx, String(index));
      const input = { ...workflowInput(ctx, snapshot, 'SWAP', { feeMicros: '250000', executionId: parent.executionId }),
        executionId: parent.executionId, sessionId: session.sessionId };
      const authorized = ctx.g3c.prepareOperation(input).workflow;
      const request = ctx.g3c.claimForSigning(authorized.operationId, snapshot, 'synthetic fee-boundary claim');
      const signed = await signer.sign(request);
      await ctx.g3c.persistSigned(authorized.operationId, signed.signedBytesHex, signed.transactionHash, 'persist cumulative-fee fixture');
      const released = ctx.g3c.prepareBroadcast(authorized.operationId, 'synthetic fee-boundary broadcast');
      ctx.g3c.recordSubmissionAccepted(authorized.operationId, released.transactionHash, new Date(nowMs).toISOString(), 'fake accepted');
      const receipt = ctx.authority.attest({
        kind: 'RECEIPT', executionId: parent.executionId, operationId: authorized.operationId, chainId: 8453,
        transactionHash: signed.transactionHash, sender: ctx.wallet, nonce: String(index), outcome: 'CONFIRMED',
        blockNumber: String(101 + index), blockHash: HASHES[(1 + index) % HASHES.length]!, finality: 'finalized',
        gasUsed: '100000', effectiveGasPriceWei: '2', l1FeeWei: '1000', operatorFeeWei: '500',
        actualFeeUsdcMicros: '250000', canonical: true,
      });
      snapshot = accountEvidence(ctx, { version: index + 2, blockNumber: String(102 + index), nonce: String(index + 1),
        allowance: '5000000', finality: 'finalized', usdc: '10000000',
        gasValue: String(2500000 - ((index + 1) * 250000)) });
      const settled = ctx.g3c.recordReceipt(authorized.operationId, receipt, snapshot, 'finalized cumulative fee');
      expect(settled.workflow.status).toBe('CONFIRMED');
    }

    expect(ctx.g3c.getSession(session.sessionId).realizedFeesUsdcMicros).toBe('1750000');
    const eighth = reserveAdditionalParent(ctx, '7');
    const rejectedInput = { ...workflowInput(ctx, snapshot, 'SWAP', { feeMicros: '250000', executionId: eighth.executionId }),
      executionId: eighth.executionId, sessionId: session.sessionId };
    expect(() => ctx.g3c.prepareOperation(rejectedInput)).toThrow();
    expect(ctx.g3c.getSession(session.sessionId).realizedFeesUsdcMicros).toBe('1750000');
    expect(ctx.g3c.getSession(session.sessionId).outstandingWorstCaseReservationsUsdcMicros).toBe('0');
    expect(() => ctx.g3c.getWorkflow(rejectedInput.operationId)).toThrow();
  });

  it('serializes competing reservations and one-time signing claims across two processes', async () => {
    const ctx = setup({ g3cOptions: { allowTestSigning: true, allowTestBroadcast: true } });
    const session = startFixtureSession(ctx);
    const first = { ...workflowInput(ctx, session.snapshot), sessionId: session.sessionId };
    const second = { ...workflowInput(ctx, session.snapshot), sessionId: session.sessionId };
    const prepareResults = await runRace(ctx, [{ action: 'prepare', input: first }, { action: 'prepare', input: second }]);
    expect(prepareResults.filter((result) => result.ok)).toHaveLength(1);
    const winner = prepareResults.find((result) => result.ok);
    expect(winner?.status).toBe('AUTHORIZED');
    expect(ctx.g3c.getSession(session.sessionId).outstandingWorstCaseReservationsUsdcMicros).toBe(
      ctx.g3c.getWorkflow(winner!.operationId!).reservedWorstCaseLossUsdcMicros);

    const claims = await runRace(ctx, [
      { action: 'claim', operationId: winner!.operationId!, snapshot: session.snapshot },
      { action: 'claim', operationId: winner!.operationId!, snapshot: session.snapshot },
    ]);
    expect(claims.filter((result) => result.ok)).toHaveLength(1);
    expect(ctx.g3c.getWorkflow(winner!.operationId!).status).toBe('SIGNING_CLAIMED');
  });

  it('review reproduction: G3c ownership survives claimed, signed, uncertain, connection, process and restart attempts', async () => {
    const ctx = setup({ g3cOptions: { allowTestSigning: true, allowTestBroadcast: true } });
    const session = startFixtureSession(ctx, accountEvidence(ctx, { version: 1, blockNumber: '100', nonce: '0', allowance: '0' }));
    const input = { ...workflowInput(ctx, session.snapshot, 'APPROVAL'), sessionId: session.sessionId };
    const authorized = ctx.g3c.prepareOperation(input).workflow;

    const claim = ctx.g3c.claimForSigning(authorized.operationId, session.snapshot, 'review claim');
    expect(claim.workflow.status).toBe('SIGNING_CLAIMED');
    expect(() => ctx.execution.releaseBeforeSigning(ctx.parent.executionId, ctx.parent.accountVersion, 'review legacy release')).toThrow();
    expect(ctx.execution.get(ctx.parent.executionId).status).toBe('RESERVED');

    const signer = makeSigner(ctx);
    const signed = await signer.sign(claim);
    await ctx.g3c.persistSigned(authorized.operationId, signed.signedBytesHex, signed.transactionHash, 'review signed outbox');
    const secondConnection = openExecutionStore({ databasePath: ctx.databasePath, clock: ctx.clock });
    stores.push(secondConnection);
    expect(() => secondConnection.releaseBeforeSigning(ctx.parent.executionId, ctx.parent.accountVersion, 'second connection legacy release')).toThrow();
    secondConnection.close();

    ctx.execution.close();
    const reopened = openExecutionStore({ databasePath: ctx.databasePath, clock: ctx.clock });
    stores.push(reopened);
    ctx.execution = reopened;
    ctx.g3c = new G3cExecutionStore(reopened, ctx.authority.trust, { allowTestSigning: true, allowTestBroadcast: true }, ctx.clock);
    const broadcast = ctx.g3c.prepareBroadcast(authorized.operationId, 'review uncertain outbox');
    expect(ctx.g3c.getWorkflow(authorized.operationId).status).toBe('SUBMISSION_UNCERTAIN');
    const childRelease = await runRace(ctx, [{ action: 'legacy-release', executionId: ctx.parent.executionId,
      accountVersion: ctx.parent.accountVersion }]);
    expect(childRelease[0]?.ok).toBe(false);
    expect(ctx.execution.get(ctx.parent.executionId).status).toBe('RESERVED');
    expect(() => reserveAdditionalParent(ctx, '8')).toThrow();

    const reconciliationProvider = testProvider(ctx);
    reconciliationProvider.account = async (_wallet, _token, version, finality = 'unsafe') => accountEvidence(ctx, {
      version, blockNumber: '103', finality, nonce: '1', allowance: '0',
    });
    const reconciled = await reconcileBaseG3cOperation({ store: ctx.g3c, provider: reconciliationProvider,
      operationId: authorized.operationId, reason: 'review exact receipt reconciliation after rejected legacy release' });
    expect(reconciled.workflow.status).toBe('CONFIRMED');
    expect(ctx.execution.get(ctx.parent.executionId).status).toBe('RESERVED');
    expect(broadcast.transactionHash).toBe(signed.transactionHash);
  });

  it('settles an approval after intent expiry, releases only after a finalized snapshot, and rejects the old swap', async () => {
    const ctx = setup({ g3cOptions: { allowTestSigning: true, allowTestBroadcast: true } });
    const flow = await prepareAndSubmitApproval(ctx);
    nowMs = Date.parse(ctx.parent.intent.expiresAt) + 1;
    const settled = await reconcileBaseG3cOperation({ store: ctx.g3c, provider: flow.provider,
      operationId: flow.operationId, reason: 'approval finalized after original intent expiry' });
    expect(settled.workflow.status).toBe('CONFIRMED');
    expect(ctx.g3c.getSession(flow.session.sessionId).realizedFeesUsdcMicros).toBe('3000');

    const rejectedOperationId = randomUUID();
    let providerReads = 0;
    const noReadProvider = { ...flow.provider, async verifyDeployment() { providerReads += 1; return flow.provider.verifyDeployment(); } };
    await expect(prepareBaseG3cOperation({ store: ctx.g3c, provider: noReadProvider, executionId: ctx.parent.executionId,
      operationId: rejectedOperationId, sessionId: flow.session.sessionId, kind: 'SWAP', reason: 'must require a newly evaluated intent' }))
      .rejects.toThrow();
    expect(providerReads).toBe(0);
    expect(() => ctx.g3c.getWorkflow(rejectedOperationId)).toThrow();

    const current = ctx.g3c.getSession(flow.session.sessionId);
    const staleFinalized = accountEvidence(ctx, { version: current.latestAccountVersion + 1, blockNumber: '101',
      finality: 'finalized', nonce: '1', allowance: '5000000', usdc: '10000000', gasValue: '997000' });
    expect(() => ctx.g3c.releaseAfterApprovalOnly(ctx.parent.executionId, staleFinalized, 'reject pre-approval finalized snapshot')).toThrow();
    expect(ctx.execution.get(ctx.parent.executionId).status).toBe('RESERVED');
    const freshFinalized = accountEvidence(ctx, { version: current.latestAccountVersion + 1, blockNumber: '105',
      finality: 'finalized', nonce: '1', allowance: '5000000', usdc: '10000000', gasValue: '997000' });
    ctx.g3c.releaseAfterApprovalOnly(ctx.parent.executionId, freshFinalized, 'expired approval-only authorization release');

    const releasedSession = ctx.g3c.getSession(flow.session.sessionId);
    expect(releasedSession.latestSnapshot?.payload.kind).toBe('ACCOUNT_SNAPSHOT');
    if (releasedSession.latestSnapshot?.payload.kind !== 'ACCOUNT_SNAPSHOT') throw new Error('account snapshot missing after approval release');
    expect(releasedSession.latestSnapshot.payload.allowanceAtomic).toBe('5000000');
    expect(ctx.g3c.getSession(flow.session.sessionId).realizedFeesUsdcMicros).toBe('3000');
  });

  it('recomputes approval-only loss and WETH exposure before release and remains readable after restart', async () => {
    const runCase = async (input: { usdc: string; wethValue: string; weth: string; gasValue: string }) => {
      const ctx = setup({ g3cOptions: { allowTestSigning: true, allowTestBroadcast: true } });
      const flow = await prepareAndSubmitApproval(ctx);
      nowMs = Date.parse(ctx.parent.intent.expiresAt) + 1;
      await reconcileBaseG3cOperation({ store: ctx.g3c, provider: flow.provider, operationId: flow.operationId,
        reason: 'settle approval fees before snapshot accounting' });
      const current = ctx.g3c.getSession(flow.session.sessionId);
      const snapshot = accountEvidence(ctx, { version: current.latestAccountVersion + 1, blockNumber: '105',
        finality: 'finalized', nonce: '1', allowance: '5000000', usdc: input.usdc, wethValue: input.wethValue,
        weth: input.weth, gasValue: input.gasValue });
      ctx.g3c.releaseAfterApprovalOnly(ctx.parent.executionId, snapshot, 'approval-only release with changed valuation');
      return { ctx, flow, session: ctx.g3c.getSession(flow.session.sessionId) };
    };

    const gain = await runCase({ usdc: '10000000', weth: '500000000000000', wethValue: '1000000', gasValue: '500000' });
    expect(gain.session.unrealizedLossUsdcMicros).toBe('0');
    expect(gain.session.markedExposureUsdcMicros).toBe('1000000');
    expect(gain.session.status).toBe('ACTIVE');
    expect(gain.ctx.execution.get(gain.ctx.parent.executionId).status).toBe('RELEASED');

    const loss = await runCase({ usdc: '7000000', weth: '500000000000000', wethValue: '1000000', gasValue: '0' });
    expect(loss.session.unrealizedLossUsdcMicros).toBe('2997000');
    expect(loss.session.markedExposureUsdcMicros).toBe('1000000');
    expect(loss.session.status).toBe('STOPPED');
    expect(loss.ctx.execution.get(loss.ctx.parent.executionId).status).toBe('RELEASED');
    expect(() => loss.ctx.g3c.prepareOperation({ ...workflowInput(loss.ctx, loss.session.latestSnapshot!, 'SWAP'),
      sessionId: loss.flow.session.sessionId })).toThrow();

    loss.ctx.execution.close();
    const reopened = openExecutionStore({ databasePath: loss.ctx.databasePath, clock: loss.ctx.clock });
    stores.push(reopened);
    const recovered = new G3cExecutionStore(reopened, loss.ctx.authority.trust, {}, loss.ctx.clock);
    expect(recovered.getSession(loss.flow.session.sessionId)).toMatchObject({
      status: 'STOPPED', unrealizedLossUsdcMicros: '2997000', markedExposureUsdcMicros: '1000000',
    });
  });

  it('stores historical funding evidence across separated heads and verifies it after restart', () => {
    const ctx = setup();
    const { sessionId } = startFixtureSession(ctx);
    const nowSeconds = Math.floor(nowMs / 1000);
    const adjustment = ctx.authority.attest({
      kind: 'FUNDING_ADJUSTMENT', walletAddress: ctx.wallet, chainId: 8453, token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      direction: 'DEPOSIT', amountAtomic: '1000000', transactionHash: `0x${'c'.repeat(64)}`, logIndex: 0,
      blockNumber: '550', blockHash: syntheticBaseHeadHash(550n), finality: 'finalized',
      sourceFinality: 'historical-finalized', sourceBlockNumber: '550', sourceBlockHash: syntheticBaseHeadHash(550n),
      sourceBlockTimestamp: nowSeconds - 900, latestHeadNumber: '1000', latestHeadHash: syntheticBaseHeadHash(1000n),
      latestHeadTimestamp: nowSeconds, safeHeadNumber: '940', safeHeadHash: syntheticBaseHeadHash(940n),
      safeHeadTimestamp: nowSeconds - 120, finalizedHeadNumber: '550', finalizedHeadHash: syntheticBaseHeadHash(550n),
      finalizedHeadTimestamp: nowSeconds - 900,
    });
    const after = accountEvidence(ctx, { version: 2, blockNumber: '551', nonce: '0', allowance: '0', finality: 'finalized',
      usdc: '11000000', gasValue: '1000000' });
    const recorded = ctx.g3c.recordFundingAdjustment(sessionId, adjustment, after, 'synthetic finalized funding');
    expect(recorded.externalFundingAdjustments).toHaveLength(1);
    expect(recorded.externalFundingAdjustments[0]?.deltaUsdcMicros).toBe('1000000');
    expect(recorded.externalFundingAdjustments[0]?.sourceEvidence).toEqual(adjustment);
    expect(() => ctx.g3c.recordFundingAdjustment(sessionId, adjustment, after, 'duplicate funding')).toThrow();

    nowMs += 1_000_000;
    ctx.execution.close();
    const reopened = openExecutionStore({ databasePath: ctx.databasePath, clock: ctx.clock }); stores.push(reopened);
    const recovered = new G3cExecutionStore(reopened, ctx.authority.trust);
    expect(recovered.getSession(sessionId).externalFundingAdjustments[0]?.sourceEvidence).toEqual(adjustment);
  });

  it('serves the narrow D1 status response from the API', async () => {
    const ctx = setup();
    const paper = openPaperStore({ databasePath: ctx.databasePath, clock: ctx.clock });
    const app = createApiApp({ store: paper, g3cStatusReader: ctx.g3c });
    const response = await app.inject({ method: 'GET', url: `/v1/executions/${ctx.parent.executionId}/g3c-status` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ executionId: ctx.parent.executionId, status: 'NOT_STARTED', mode: 'LIVE_DISABLED' });
    await app.close();
  });

  it('loads production evidence keys only from external files', () => {
    const ctx = setup();
    const keyPair = generateKeyPairSync('ed25519');
    const privatePath = join(ctx.dir, 'evidence-private.pem');
    const trustPath = join(ctx.dir, 'evidence-trust.json');
    const keyId = 'g3c-test-evidence';
    const privatePem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    writeFileSync(privatePath, privatePem, { mode: 0o600 });
    writeFileSync(trustPath, JSON.stringify({ [keyId]: publicPem }), { mode: 0o600 });

    const authority = loadProductionG3cEvidenceAuthority({ privateKeyPath: privatePath, keyId, repositoryRoot: process.cwd(),
      clock: () => new Date(nowMs) });
    const trust = loadProductionG3cEvidenceTrust({ publicKeysPath: trustPath, repositoryRoot: process.cwd() });
    expect(authority.trust.publicKeys[keyId]).toBe(publicPem);
    expect(trust.publicKeys[keyId]).toBe(publicPem);
    expect(() => loadProductionG3cEvidenceAuthority({ privateKeyPath: join(process.cwd(), 'apps', 'api', 'src', 'missing-key.pem'),
      keyId, repositoryRoot: process.cwd() })).toThrow('G3C_PRIVATE_KEY_MUST_BE_OUTSIDE_REPOSITORY');
  });

  it('does not expose live signing or broadcast with production defaults', () => {
    const ctx = setup();
    const session = startFixtureSession(ctx);
    const input = { ...workflowInput(ctx, session.snapshot), sessionId: session.sessionId };
    const workflow = ctx.g3c.prepareOperation(input).workflow;
    const defaults = new G3cExecutionStore(ctx.execution, ctx.authority.trust);
    expect(() => defaults.claimForSigning(workflow.operationId, session.snapshot, 'production default must stay off')).toThrow();
    expect(() => defaults.prepareBroadcast(workflow.operationId, 'production default must stay off')).toThrow();
  });
});






describe('G3c browser-wallet durable state', () => {
  it('persists browser submission before wallet access, excludes the app signer, and releases only on explicit rejection', () => {
    const ctx = setup({ g3cOptions: { allowTestSigning: true, allowTestBroadcast: true } });
    const session = startFixtureSession(ctx);
    const workflow = ctx.g3c.prepareOperation({ ...workflowInput(ctx, session.snapshot), sessionId: session.sessionId }).workflow;
    const ready = ctx.g3c.prepareBrowserWallet(workflow.operationId, 'synthetic browser wallet pending record');
    expect(ready.workflow).toMatchObject({ submissionMode: 'BROWSER_WALLET', browserStage: 'READY', status: 'AUTHORIZED',
      signedBytesHex: null, signedBytesDigest: null, transactionHash: null });
    expect(ready.replayed).toBe(false);
    expect(ctx.g3c.prepareBrowserWallet(workflow.operationId, 'synthetic duplicate pending record').replayed).toBe(true);
    expect(ctx.g3c.getSession(session.sessionId).outstandingWorstCaseReservationsUsdcMicros).not.toBe('0');
    let signerError: unknown;
    try { ctx.g3c.claimForSigning(workflow.operationId, session.snapshot, 'must not enter local signer'); } catch (error) { signerError = error; }
    expect(signerError).toMatchObject({ reason: 'G3C_SIGNING_CLAIM_INVALID' });

    const armed = ctx.g3c.armBrowserWalletSubmission(workflow.operationId, session.snapshot, 'synthetic before Rabby request');
    expect(armed.workflow).toMatchObject({ status: 'SUBMISSION_UNCERTAIN', browserStage: 'SUBMISSION_UNCERTAIN', submissionAttempts: 1 });
    const rejected = ctx.g3c.rejectBrowserWalletSubmission(workflow.operationId, 'Rabby returned EIP-1193 user rejection code 4001');
    expect(rejected.workflow).toMatchObject({ status: 'CANCELLED', browserStage: 'REJECTED', failureReason: 'WALLET_USER_REJECTED' });
    expect(ctx.g3c.getSession(session.sessionId).outstandingWorstCaseReservationsUsdcMicros).toBe('0');
    expect(ctx.execution.get(ctx.parent.executionId).status).toBe('RELEASED');
  });

  it('retains unknown transaction hashes and reservations without permitting a second hash', () => {
    const ctx = setup({ g3cOptions: { allowTestSigning: true, allowTestBroadcast: true } });
    const session = startFixtureSession(ctx);
    const workflow = ctx.g3c.prepareOperation({ ...workflowInput(ctx, session.snapshot), sessionId: session.sessionId }).workflow;
    ctx.g3c.prepareBrowserWallet(workflow.operationId, 'synthetic browser wallet pending record');
    ctx.g3c.armBrowserWalletSubmission(workflow.operationId, session.snapshot, 'synthetic before Rabby request');
    const unknownHash = HASHES[0]!;
    const uncertain = ctx.g3c.recordBrowserTransaction(workflow.operationId, unknownHash, 'NOT_FOUND', 'synthetic RPC not found yet');
    expect(uncertain.workflow).toMatchObject({ status: 'SUBMISSION_UNCERTAIN', browserStage: 'SUBMISSION_UNCERTAIN', transactionHash: unknownHash });
    expect(ctx.g3c.getSession(session.sessionId).outstandingWorstCaseReservationsUsdcMicros).not.toBe('0');
    let hashError: unknown;
    try { ctx.g3c.recordBrowserTransaction(workflow.operationId, HASHES[1]!, 'MATCH', 'must preserve first hash'); } catch (error) { hashError = error; }
    expect(hashError).toMatchObject({ reason: 'G3C_BROWSER_HASH_CONFLICT' });
    expect(ctx.g3c.getWorkflow(workflow.operationId).transactionHash).toBe(unknownHash);
  });
});
describe('G3c read-only simulation boundary', () => {
  it('validates exact G2 amount and Base evidence without persisting G3c authorization', async () => {
    const ctx = setup();
    const { sessionId } = startFixtureSession(ctx);
    const operationId = randomUUID();
    const baseProvider = testProvider(ctx);
    const provider: G3cReadOnlyBaseProvider = {
      ...baseProvider,
      async account(walletAddress, allowanceToken, accountVersion, finality) {
        if (accountVersion === 2) return accountEvidence(ctx, {
          version: 2, blockNumber: '101', nonce: '0', allowance: ctx.parent.transaction.amountIn,
          ...(finality ? { finality } : {}),
        });
        return baseProvider.account(walletAddress, allowanceToken, accountVersion, finality);
      },
    };
    const result = await simulateBaseG3cOperation({
      store: ctx.g3c, provider, executionId: ctx.parent.executionId, operationId, sessionId,
    });

    const decoded = decodeExactSwap(result.transaction.data as Hex);
    expect(decoded.amountIn.toString()).toBe(ctx.parent.transaction.amountIn);
    expect(result.accountVersion).toBe(2);
    expect(result.quote?.payload.kind).toBe('QUOTE');
    expect(result.simulation.payload.kind === 'SIMULATION' && result.simulation.payload.outcome).toBe('PASSED');
    expect(result.fee.payload.kind).toBe('BASE_FEE');
    expect(ctx.g3c.status(ctx.parent.executionId).status).toBe('NOT_STARTED');
    expect(ctx.execution.get(ctx.parent.executionId).authorization).toBeNull();
    expect(ctx.execution.get(ctx.parent.executionId).simulation).toBeNull();
    expect(() => ctx.g3c.getWorkflow(operationId)).toThrow();

    const proposalId = ctx.parent.intent.intentId;
    const proposal = d2ProposalSchema.parse({
      proposalId, createdAt: ctx.clock().toISOString(), intent: ctx.parent.intent,
      analysis: { source: 'DETERMINISTIC_EVIDENCE_RULES', version: 'd2-rule-v1',
        rationale: 'Synthetic G3c simulation audit fixture only.', semanticStatus: 'NOT_CONFIGURED', semanticAuthority: 'NONE' },
      evidence: { source: 'nansen', label: 'PERSISTED NANSEN OBSERVATIONS', observations: [], observationIds: [], batches: [] },
    });
    const auditPath = join(ctx.dir, 'd2-audit.sqlite');
    const audit = initializeD2AuditStore({ databasePath: auditPath });
    let saved;
    try {
      audit.saveProposal(proposal);
      saved = audit.recordSimulation({
        proposalId, executionId: ctx.parent.executionId, operationId, sessionId, walletAddress: ctx.wallet,
        accountVersion: result.accountVersion, requestedAmount: ctx.parent.intent.amountIn,
        permittedAmount: ctx.parent.decision.approvedAmountIn!, policyTransaction: ctx.parent.transaction,
        transaction: result.transaction, quote: result.quote, simulation: result.simulation, fee: result.fee,
        status: 'SIMULATED', executionMode: 'READ_ONLY', authorizationCreated: false,
        signerInvocations: 0, broadcasterInvocations: 0, createdAt: ctx.clock().toISOString(),
      });
    } finally { audit.close(); }
    const reopenedAudit = openD2AuditStore({ databasePath: auditPath });
    try {
      expect(reopenedAudit.getSimulation(proposalId, operationId)).toEqual(saved);
    } finally { reopenedAudit.close(); }
  });
});
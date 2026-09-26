import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeFunctionData, keccak256, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { ExecutionLifecycleRecord, G3bEvidenceAttestation, G3bOperation, G3bSignerPayload, TradeIntent } from '@ered-luin/contracts';
import { initializeExecutionStore, openExecutionStore, type ExecutionStore } from './execution-store.js';
import { createSyntheticG3bEvidenceProvider } from './g3b-providers.js';
import { signG3bEvidence } from './g3b-evidence.js';
import { G3bExecutionStore } from './g3b-execution-store.js';
import { buildG3bApprovalTransaction, buildG3bSwapTransactionForQuote, assertG3bOperationTransaction,
  g3bSemanticDigest, g3bUnsignedTransactionHash, UNISWAP_V3_ROUTER_ABI, ERC20_APPROVAL_ABI } from './g3b-transaction.js';
import { createSyntheticIsolatedSigner } from './g3b-signer-client.js';
import { createG3bSignerMessage, makeG3bSignerPayload, verifyG3bSignerMessage } from './g3b-signer-protocol.js';
import { BASE_TOKENS, BASE_UNISWAP_V3 } from './base-allowlist.js';

let wallet: Address = '0x1111111111111111111111111111111111111111';
const dirs: string[] = []; const stores: ExecutionStore[] = [];
let nowMs = Date.now(); let databasePath = '';
const routerAbi = UNISWAP_V3_ROUTER_ABI;
const approvAbi = ERC20_APPROVAL_ABI;
const HASH_A = `0x${'a'.repeat(64)}` as const;
const HASH_B = `0x${'b'.repeat(64)}` as const;
const executionWorkerPath = fileURLToPath(new URL('./execution-store-worker.mjs', import.meta.url));
function setup() {
  nowMs = Date.now();
  const walletPrivateKey = generatePrivateKey();
  wallet = privateKeyToAccount(walletPrivateKey).address;
  const dir = mkdtempSync(join(tmpdir(), 'ered-luin-g3b-')); dirs.push(dir); databasePath = join(dir, 'state.sqlite');
  const clock = () => new Date(nowMs);
  const execution = initializeExecutionStore({ databasePath, clock }); stores.push(execution);
  execution.setKillSwitch(false, 'synthetic G3b acceptance fixture');
  const intent: TradeIntent = { intentId: randomUUID(), chainId: 8453, walletAddress: wallet, sellAsset: 'USDC', buyAsset: 'WETH',
    amountIn: '5000000', issuedAt: new Date(nowMs - 10_000).toISOString(), expiresAt: new Date(nowMs + 60_000).toISOString() };
  const decision = { decisionId: randomUUID(), intentId: intent.intentId, status: 'ALLOW' as const, evaluatedAt: new Date(nowMs - 5_000).toISOString(),
    policyVersion: 'g3b-synthetic-test', requestedAmountIn: intent.amountIn, approvedAmountIn: intent.amountIn, reasons: ['SYNTHETIC_TEST_ONLY'] };
  const transaction = { version: 1 as const, chainId: 8453 as const, walletAddress: wallet, router: BASE_UNISWAP_V3.router,
    recipient: wallet, sellAsset: 'USDC' as const, buyAsset: 'WETH' as const, amountIn: '5000000', minimumAmountOut: '1000000000000000',
    valueNativeWei: '0', maxFeePerGasWei: '3', maxPriorityFeePerGasWei: '1', maxTotalFeeWei: '1000000000', chainNonce: '41',
    expiresAt: new Date(nowMs + 50_000).toISOString() };
  const reserved = execution.reserve({ executionId: randomUUID(), intent, decision, accountVersion: 4, reservationExposureUsdcMicros: '5000000', transaction,
    reason: 'synthetic G3b parent' }).record;
  const simulation = { version: 1 as const, simulationId: randomUUID(), executionId: reserved.executionId, transactionDigest: reserved.transactionDigest,
    producerId: 'synthetic-test-adapter' as const, outcome: 'PASSED' as const, simulatedAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + 10_000).toISOString() };
  const simulated = execution.recordSimulation(reserved.executionId, reserved.accountVersion, simulation, 'synthetic G3a adapter passed').record;
  const parent = execution.issueAuthorization(simulated.executionId, simulated.accountVersion, 'synthetic G3a parent authorization').record;
  const providers = createSyntheticG3bEvidenceProvider(() => new Date(nowMs));
  const g3b = new G3bExecutionStore(execution, providers.trust);
  return { execution, parent, providers, g3b, clock, dir, walletPrivateKey };
}
function feeFields(nonce: string) { return { nonce, gasLimit: '45000', maxFeePerGasWei: '3', maxPriorityFeePerGasWei: '1' }; }
function feeQuery(parent: ExecutionLifecycleRecord, operation: G3bOperation) {
  return { executionId: parent.executionId, operationId: operation.operationId, unsignedTransactionHash: operation.unsignedTransactionHash as `0x${string}`,
    gasLimit: operation.unsignedTransaction.gasLimit, maxFeePerGasWei: operation.unsignedTransaction.maxFeePerGasWei,
    l1DataFeeWei: '10000', operatorFeeWei: '5000', valueUsdcMicros: '50000' } as const;
}
function riskQuery(parent: ExecutionLifecycleRecord, operation: G3bOperation, blockNumber: string, blockHash: `0x${string}`, quote?: G3bEvidenceAttestation) {
  const quotePayload = quote?.payload.kind === 'QUOTE' ? quote.payload : null;
  return { executionId: parent.executionId, operationId: operation.operationId, accountVersion: parent.accountVersion, sessionId: randomUUID(), snapshotVersion: 1,
    blockNumber, blockHash, walletValueUsdcMicros: '20000000', tradeValueUsdcMicros: parent.reservationExposureUsdcMicros,
    wethPositionAfterUsdcMicros: '2000000', slippageBps: quotePayload?.slippageBps ?? 0, priceImpactBps: quotePayload?.priceImpactBps ?? 0,
    currentSessionLossUsdcMicros: '1000', reservedSessionLossUsdcMicros: '2000', worstCaseTradeLossUsdcMicros: '10000', workflowFeeReserveUsdcMicros: '50000' } as const;
}
async function prepareOperation(ctx: ReturnType<typeof setup>, kind: 'APPROVAL' | 'SWAP' = 'SWAP', options: {
  readonly nonce?: string; readonly blockNumber?: string; readonly blockHash?: `0x${string}`;
  readonly allowance?: string; readonly approvalReceipt?: G3bEvidenceAttestation | null;
} = {}) {
  const parent = ctx.execution.get(ctx.parent.executionId); const operationId = randomUUID(); const nonce = options.nonce ?? parent.transaction.chainNonce;
  const blockNumber = options.blockNumber ?? '100'; const blockHash = options.blockHash ?? HASH_A;
  const quote = kind === 'SWAP' ? await ctx.providers.provider.quote({ executionId: parent.executionId, operationId, chainId: 8453,
    poolAddress: BASE_UNISWAP_V3.pool, tokenIn: BASE_TOKENS.USDC, tokenOut: BASE_TOKENS.WETH, fee: 500, amountIn: parent.transaction.amountIn,
    minimumAmountOut: '1000000000000000', slippageBps: 10, priceImpactBps: 12, blockNumber, blockHash }) : null;
  const unsignedTransaction = kind === 'SWAP'
    ? buildG3bSwapTransactionForQuote(parent, feeFields(nonce), quote!, ctx.providers.trust, operationId, nowMs)
    : buildG3bApprovalTransaction(parent, feeFields(nonce));
  const allowanceEvidence = await ctx.providers.provider.allowance({ executionId: parent.executionId, operationId, chainId: 8453,
    walletAddress: parent.walletAddress, token: BASE_TOKENS.USDC, spender: BASE_UNISWAP_V3.router,
    allowanceAtomic: options.allowance ?? (kind === 'APPROVAL' ? '0' : parent.transaction.amountIn), nextNonce: nonce, blockNumber, blockHash });
  const prepared = ctx.g3b.prepareOperation({ executionId: parent.executionId, operationId, kind, unsignedTransaction, allowanceEvidence,
    quoteEvidence: quote, approvalReceipt: options.approvalReceipt ?? null, reason: 'synthetic G3b operation prepared' }).operation;
  const simulation = await ctx.providers.provider.simulate({ executionId: parent.executionId, operationId, semanticDigest: prepared.semanticDigest,
    unsignedTransactionHash: prepared.unsignedTransactionHash as `0x${string}`, poolAddress: kind === 'SWAP' ? BASE_UNISWAP_V3.pool : null, blockNumber, blockHash });
  ctx.g3b.recordSimulation(operationId, simulation, 'synthetic simulation');
  const fee = await ctx.providers.provider.baseFee(feeQuery(parent, prepared));
  ctx.g3b.recordFee(operationId, fee, 'synthetic Base fee calculation');
  const risk = await ctx.providers.provider.sessionRisk(riskQuery(parent, prepared, blockNumber, blockHash, quote ?? undefined));
  ctx.g3b.recordRisk(operationId, risk, 'synthetic session cap snapshot');
  return { operationId, operation: ctx.g3b.authorize(operationId, 'synthetic G3b child authorization').operation,
    quoteEvidence: quote, allowanceEvidence };
}
function signingPayload(ctx: ReturnType<typeof setup>, operationId: string): G3bSignerPayload {
  const claim = ctx.g3b.claimForSigning(operationId, ctx.parent.accountVersion, 'atomic synthetic signing claim');
  return makeG3bSignerPayload({ parent: claim.parent, operation: claim.operation, intent: claim.parent.intent, decision: claim.parent.decision,
    g3aAuthorization: claim.parent.authorization!, signingClaim: claim.parent.signingClaim! });
}
function signerFor(ctx: ReturnType<typeof setup>, privateKey = ctx.walletPrivateKey) {
  const signer = createSyntheticIsolatedSigner({ privateKey, hmacSecret: Buffer.alloc(32, 7),
    trustedEvidenceKeys: { [ctx.providers.trust.environment === 'synthetic-test' ? 'synthetic-g3b-runtime' : 'missing']: ctx.providers.publicKeyPem },
    evidenceEnvironment: 'synthetic-test', allowSyntheticTestEvidence: true });
  return { signer, privateKey, address: privateKeyToAccount(privateKey).address };
}
function mutateStoredG3bOperation(operationId: string, mutate: (operation: G3bOperation) => void): void {
  const db = new DatabaseSync(databasePath);
  try {
    const row = db.prepare('SELECT record_json FROM execution_g3b_operations WHERE operation_id = ?').get(operationId) as { record_json: string } | undefined;
    if (!row) throw new Error('G3b operation was not found for corruption fixture.');
    const operation = JSON.parse(row.record_json) as G3bOperation;
    mutate(operation);
    db.prepare('UPDATE execution_g3b_operations SET record_json = ? WHERE operation_id = ?').run(JSON.stringify(operation), operationId);
  } finally { db.close(); }
}
async function freshProcessOpen(): Promise<{ readonly response: { readonly type: string; readonly value?: unknown }; readonly exitCode: number | null }> {
  const child = fork(executionWorkerPath, ['status', databasePath, JSON.stringify({ clockAt: new Date(nowMs).toISOString() }), ''], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const response = new Promise<{ readonly type: string; readonly value?: unknown }>((resolve, reject) => {
    child.once('message', (value: unknown) => {
      if (typeof value !== 'object' || value === null || !('type' in value) || typeof value.type !== 'string') {
        reject(new Error('G3a worker returned a malformed response.')); return;
      }
      resolve(value as { readonly type: string; readonly value?: unknown });
    });
    child.once('error', reject);
  });
  const exit = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  const [received, exitCode] = await Promise.all([response, exit]);
  return { response: received, exitCode };
}
afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('G3b transaction authorization', () => {
  it('constructs a deadline-bearing one-call exact-input USDC/WETH swap', async () => {
    const ctx = setup(); const { operation, quoteEvidence } = await prepareOperation(ctx, 'SWAP');
    expect(operation.unsignedTransaction.to.toLowerCase()).toBe(BASE_UNISWAP_V3.router.toLowerCase());
    expect(operation.unsignedTransaction.chainId).toBe(8453);
    expect(operation.unsignedTransaction.valueWei).toBe('0');
    expect(operation.unsignedTransaction.accessList).toEqual([]);
    expect(operation.quoteEvidence).toEqual(quoteEvidence);
    expect(operation.unsignedTransactionHash).toBe(g3bUnsignedTransactionHash(operation.unsignedTransaction));
    expect(operation.semanticDigest).toBe(g3bSemanticDigest({ executionId: operation.executionId, operationId: operation.operationId,
      kind: 'SWAP', transaction: operation.unsignedTransaction }));
    const decoded = assertG3bOperationTransaction(ctx.execution.get(ctx.parent.executionId), 'SWAP', operation.unsignedTransaction,
      nowMs, quoteEvidence!, ctx.providers.trust, operation.allowanceEvidence!);
    expect(decoded).toBeUndefined();
  });

  it.each([
    ['wrong chain', (tx: G3bOperation['unsignedTransaction']) => ({ ...tx, chainId: 1 }), 'invalid'],
    ['wrong sender', (tx: G3bOperation['unsignedTransaction']) => ({ ...tx, from: '0x2222222222222222222222222222222222222222' }), 'semantic-only'],
    ['wrong target', (tx: G3bOperation['unsignedTransaction']) => ({ ...tx, to: '0x2222222222222222222222222222222222222222' })],
    ['native value', (tx: G3bOperation['unsignedTransaction']) => ({ ...tx, valueWei: '1' })],
    ['altered nonce', (tx: G3bOperation['unsignedTransaction']) => ({ ...tx, nonce: '42' })],
    ['gas ceiling', (tx: G3bOperation['unsignedTransaction']) => ({ ...tx, gasLimit: '400000000' })],
    ['max fee', (tx: G3bOperation['unsignedTransaction']) => ({ ...tx, maxFeePerGasWei: '4' })],
    ['priority fee', (tx: G3bOperation['unsignedTransaction']) => ({ ...tx, maxPriorityFeePerGasWei: '2' })],
    ['access list', (tx: G3bOperation['unsignedTransaction']) => ({ ...tx, accessList: [{}] }), 'invalid'],
  ])('rejects independently mutated transaction field: %s', async (_name, mutate, hashChange = 'changed') => {
    const ctx = setup(); const { operation, quoteEvidence } = await prepareOperation(ctx, 'SWAP');
    const changed = mutate(operation.unsignedTransaction) as G3bOperation['unsignedTransaction'];
    expect(() => assertG3bOperationTransaction(ctx.execution.get(ctx.parent.executionId), 'SWAP', changed, nowMs,
      quoteEvidence!, ctx.providers.trust, operation.allowanceEvidence!)).toThrow();
    if (hashChange === 'invalid') expect(() => g3bUnsignedTransactionHash(changed)).toThrow();
    else if (hashChange === 'semantic-only') expect(g3bUnsignedTransactionHash(changed)).toBe(operation.unsignedTransactionHash);
    else expect(g3bUnsignedTransactionHash(changed)).not.toBe(operation.unsignedTransactionHash);
    expect(g3bSemanticDigest({ executionId: operation.executionId, operationId: operation.operationId, kind: operation.kind, transaction: changed }))
      .not.toBe(operation.semanticDigest);
  });

  it('rejects changed minOut, extra router calls, unsupported selectors, and expired deadlines', async () => {
    const ctx = setup(); const { operation, quoteEvidence } = await prepareOperation(ctx, 'SWAP');
    const parent = ctx.execution.get(ctx.parent.executionId); const tx = operation.unsignedTransaction;
    const params = { tokenIn: BASE_TOKENS.USDC, tokenOut: BASE_TOKENS.WETH, fee: 500, recipient: wallet,
      amountIn: BigInt(parent.transaction.amountIn), amountOutMinimum: 1000000000000001n, sqrtPriceLimitX96: 0n };
    const inner = encodeFunctionData({ abi: routerAbi, functionName: 'exactInputSingle', args: [params] });
    const deadline = BigInt(Math.floor(Date.parse(parent.intent.expiresAt) / 1000));
    const mutations = [
      { ...tx, data: encodeFunctionData({ abi: routerAbi, functionName: 'multicall', args: [deadline, [inner]] }) },
      { ...tx, data: encodeFunctionData({ abi: routerAbi, functionName: 'multicall', args: [deadline, [tx.data as Hex, tx.data as Hex]] }) },
      { ...tx, data: '0xdeadbeef' },
      { ...tx, data: encodeFunctionData({ abi: routerAbi, functionName: 'multicall', args: [1n, [tx.data as Hex]] }) },
    ];
    for (const changed of mutations) expect(() => assertG3bOperationTransaction(parent, 'SWAP', changed, nowMs, quoteEvidence!, ctx.providers.trust, operation.allowanceEvidence!)).toThrow();
  });

  it('rejects unlimited approvals and nonzero unexpected allowances', async () => {
    const ctx = setup(); const parent = ctx.execution.get(ctx.parent.executionId);
    const approval = buildG3bApprovalTransaction(parent, feeFields('40'));
    expect(() => assertG3bOperationTransaction(parent, 'APPROVAL', approval, nowMs)).not.toThrow();
    const unlimited = { ...approval, data: encodeFunctionData({ abi: approvAbi, functionName: 'approve',
      args: [BASE_UNISWAP_V3.router, (1n << 256n) - 1n] }) };
    expect(() => assertG3bOperationTransaction(parent, 'APPROVAL', unlimited, nowMs)).toThrow();
    const operationId = randomUUID();
    const allowance = await ctx.providers.provider.allowance({ executionId: parent.executionId, operationId, chainId: 8453,
      walletAddress: parent.walletAddress, token: BASE_TOKENS.USDC, spender: BASE_UNISWAP_V3.router, allowanceAtomic: '5000001',
      nextNonce: '41', blockNumber: '100', blockHash: HASH_A });
    expect(() => ctx.g3b.prepareOperation({ executionId: parent.executionId, operationId, kind: 'SWAP', unsignedTransaction: approval,
      allowanceEvidence: allowance, reason: 'unexpected allowance must fail' })).toThrow();
  });
});

describe('G3b signer and outbox', () => {
  it('signs a genuine EIP-1559 transaction in a separate process, verifies it, and persists before fake broadcast', async () => {
    const ctx = setup(); const { operationId } = await prepareOperation(ctx, 'SWAP'); const payload = signingPayload(ctx, operationId);
    expect(() => ctx.g3b.claimForSigning(operationId, ctx.parent.accountVersion, 'replay')).toThrow();
    expect(() => ctx.g3b.claimForSigning(operationId, ctx.parent.accountVersion + 1, 'stale account version')).toThrow();
    const wrong = signerFor(ctx, generatePrivateKey());
    await expect(wrong.signer.sign(payload)).rejects.toThrow('SIGNER_REJECTED'); await wrong.signer.close();
    const { signer } = signerFor(ctx);
    const signed = await signer.sign(payload);
    await expect(signer.sign(payload)).rejects.toThrow('SIGNER_REJECTED');
    await expect(ctx.g3b.persistSigned(operationId, signed.signedBytesHex, `0x${'f'.repeat(64)}`, 'mutated hash')).rejects.toThrow();
    await expect(ctx.g3b.persistSigned(operationId, '0xdeadbeef', signed.transactionHash, 'malformed signed bytes')).rejects.toThrow();
    const stored = (await ctx.g3b.persistSigned(operationId, signed.signedBytesHex, signed.transactionHash, 'persist verified signer output')).operation;
    expect(stored.status).toBe('SIGNED_OUTBOX');
    expect(stored.transactionHash).toBe(signed.transactionHash);
    expect(stored.signedBytesHex).toBe(signed.signedBytesHex);
    expect(ctx.execution.get(ctx.parent.executionId).status).toBe('SIGNING_CLAIMED');
    expect(ctx.execution.get(ctx.parent.executionId).signedOutbox).toBeNull();
    const release = ctx.g3b.prepareBroadcast(operationId, 'fake broadcaster asks for persisted bytes');
    expect(ctx.g3b.get(operationId).status).toBe('SUBMISSION_UNCERTAIN');
    const fakeBroadcastCalls: string[] = [];
    fakeBroadcastCalls.push(release.signedBytesHex);
    expect(fakeBroadcastCalls).toEqual([stored.signedBytesHex]);
    ctx.g3b.recordSubmissionAccepted(operationId, release.transactionHash, new Date(nowMs).toISOString(), 'synthetic acknowledgement');
    expect(ctx.g3b.get(operationId).status).toBe('SUBMITTED');
    await signer.close();
  });

  it('holds a claimed reservation for reconciliation after a signing-to-persistence crash', async () => {
    const ctx = setup(); const { operationId } = await prepareOperation(ctx, 'SWAP');
    signingPayload(ctx, operationId);
    expect(ctx.g3b.get(operationId).status).toBe('SIGNING_CLAIMED');
    ctx.execution.close();
    const reopened = openExecutionStore({ databasePath, clock: () => new Date(nowMs) }); stores.push(reopened);
    const afterRestart = new G3bExecutionStore(reopened, ctx.providers.trust);
    expect(afterRestart.listReconciliationQueue().map((operation) => operation.operationId)).toContain(operationId);
    expect(afterRestart.get(operationId).signedBytesHex).toBeNull();
    expect(() => afterRestart.claimForSigning(operationId, ctx.parent.accountVersion, 'do not reissue after crash')).toThrow();
    const db = new DatabaseSync(databasePath);
    try {
      const row = db.prepare('SELECT status FROM wallet_reservations WHERE reservation_id = ?').get(ctx.parent.reservationId) as { status: string };
      expect(row.status).toBe('ACTIVE');
    } finally { db.close(); }
  });

  it('orders signing against the persisted stop and rejects stale evidence', async () => {
    const ctx = setup(); const prepared = await prepareOperation(ctx, 'SWAP');
    const claim = ctx.g3b.claimForSigning(prepared.operationId, ctx.parent.accountVersion, 'first claim');
    expect(() => ctx.g3b.claimForSigning(prepared.operationId, ctx.parent.accountVersion, 'replay')).toThrow();
    expect(claim.parent.status).toBe('SIGNING_CLAIMED');

    const another = setup(); const parent = another.execution.get(another.parent.executionId); const operationId = randomUUID();
    const quote = await another.providers.provider.quote({ executionId: parent.executionId, operationId, chainId: 8453,
      poolAddress: BASE_UNISWAP_V3.pool, tokenIn: BASE_TOKENS.USDC, tokenOut: BASE_TOKENS.WETH, fee: 500,
      amountIn: parent.transaction.amountIn, minimumAmountOut: '1000000000000000', slippageBps: 10, priceImpactBps: 10, blockNumber: '100', blockHash: HASH_A });
    const transaction = buildG3bSwapTransactionForQuote(parent, feeFields('41'), quote, another.providers.trust, operationId, nowMs);
    const allowance = await another.providers.provider.allowance({ executionId: parent.executionId, operationId, chainId: 8453,
      walletAddress: parent.walletAddress, token: BASE_TOKENS.USDC, spender: BASE_UNISWAP_V3.router, allowanceAtomic: '5000000',
      nextNonce: '41', blockNumber: '100', blockHash: HASH_A });
    another.g3b.prepareOperation({ executionId: parent.executionId, operationId, kind: 'SWAP', unsignedTransaction: transaction,
      quoteEvidence: quote, allowanceEvidence: allowance, reason: 'staleness fixture' });
    const simulation = await another.providers.provider.simulate({ executionId: parent.executionId, operationId,
      semanticDigest: g3bSemanticDigest({ executionId: parent.executionId, operationId, kind: 'SWAP', transaction }),
      unsignedTransactionHash: g3bUnsignedTransactionHash(transaction), poolAddress: BASE_UNISWAP_V3.pool,
      blockNumber: '100', blockHash: HASH_A });
    nowMs += 16_000;
    expect(() => another.g3b.recordSimulation(operationId, simulation, 'stale simulation')).toThrow();
  });
});



describe('G3b approval handoff', () => {
  it('requires exact approval confirmation before a refreshed quote, allowance, simulation, and swap', async () => {
    const ctx = setup(); const parent = ctx.execution.get(ctx.parent.executionId);
    const approval = await prepareOperation(ctx, 'APPROVAL', { nonce: '0', blockNumber: '100', blockHash: HASH_A });
    const earlySwapId = randomUUID();
    const earlyQuote = await ctx.providers.provider.quote({ executionId: parent.executionId, operationId: earlySwapId, chainId: 8453,
      poolAddress: BASE_UNISWAP_V3.pool, tokenIn: BASE_TOKENS.USDC, tokenOut: BASE_TOKENS.WETH, fee: 500,
      amountIn: parent.transaction.amountIn, minimumAmountOut: '1000000000000000', slippageBps: 10, priceImpactBps: 10, blockNumber: '100', blockHash: HASH_A });
    const earlyTx = buildG3bSwapTransactionForQuote(parent, feeFields('1'), earlyQuote, ctx.providers.trust, earlySwapId, nowMs);
    const earlyAllowance = await ctx.providers.provider.allowance({ executionId: parent.executionId, operationId: earlySwapId, chainId: 8453,
      walletAddress: parent.walletAddress, token: BASE_TOKENS.USDC, spender: BASE_UNISWAP_V3.router, allowanceAtomic: parent.transaction.amountIn,
      nextNonce: '1', blockNumber: '100', blockHash: HASH_A });
    expect(() => ctx.g3b.prepareOperation({ executionId: parent.executionId, operationId: earlySwapId, kind: 'SWAP', unsignedTransaction: earlyTx,
      quoteEvidence: earlyQuote, allowanceEvidence: earlyAllowance, reason: 'swap before approval receipt' })).toThrow();

    const payload = signingPayload(ctx, approval.operationId); const { signer } = signerFor(ctx);
    const signed = await signer.sign(payload);
    const outbox = (await ctx.g3b.persistSigned(approval.operationId, signed.signedBytesHex, signed.transactionHash, 'persist exact approval')).operation;
    expect(outbox.status).toBe('SIGNED_OUTBOX');
    const released = ctx.g3b.prepareBroadcast(approval.operationId, 'synthetic approval broadcaster');
    ctx.g3b.recordSubmissionAccepted(approval.operationId, released.transactionHash, new Date(nowMs).toISOString(), 'synthetic approval acknowledgement');
    const receipt = await ctx.providers.provider.receipt({ executionId: parent.executionId, operationId: approval.operationId, chainId: 8453,
      transactionHash: released.transactionHash as `0x${string}`, outcome: 'CONFIRMED', blockNumber: '100', blockHash: HASH_A });
    expect(ctx.g3b.recordReceipt(approval.operationId, receipt, 'synthetic confirmed approval').operation.status).toBe('CONFIRMED');
    await signer.close();

    nowMs = Date.now();
    const swap = await prepareOperation(ctx, 'SWAP', { nonce: '1', blockNumber: '101', blockHash: HASH_B, allowance: parent.transaction.amountIn, approvalReceipt: receipt });
    expect(swap.operation.status).toBe('AUTHORIZED');
    expect(swap.operation.approvalReceipt).toEqual(receipt);
    expect(swap.operation.quoteEvidence?.payload.kind === 'QUOTE' && BigInt(swap.operation.quoteEvidence.payload.blockNumber)).toBe(101n);
    expect(swap.operation.allowanceEvidence?.payload.kind === 'ALLOWANCE' && swap.operation.allowanceEvidence.payload.nextNonce).toBe('1');
    expect(ctx.execution.get(parent.executionId).status).toBe('SIGNING_CLAIMED');
    const db = new DatabaseSync(databasePath);
    try {
      const row = db.prepare('SELECT status FROM wallet_reservations WHERE reservation_id = ?').get(parent.reservationId) as { status: string };
      expect(row.status).toBe('ACTIVE');
    } finally { db.close(); }
  });
});
async function prepareSimulationStage(ctx: ReturnType<typeof setup>) {
  const parent = ctx.execution.get(ctx.parent.executionId); const operationId = randomUUID();
  const quote = await ctx.providers.provider.quote({ executionId: parent.executionId, operationId, chainId: 8453,
    poolAddress: BASE_UNISWAP_V3.pool, tokenIn: BASE_TOKENS.USDC, tokenOut: BASE_TOKENS.WETH, fee: 500,
    amountIn: parent.transaction.amountIn, minimumAmountOut: '1000000000000000', slippageBps: 10, priceImpactBps: 10, blockNumber: '100', blockHash: HASH_A });
  const unsignedTransaction = buildG3bSwapTransactionForQuote(parent, feeFields('41'), quote, ctx.providers.trust, operationId, nowMs);
  const allowanceEvidence = await ctx.providers.provider.allowance({ executionId: parent.executionId, operationId, chainId: 8453,
    walletAddress: parent.walletAddress, token: BASE_TOKENS.USDC, spender: BASE_UNISWAP_V3.router,
    allowanceAtomic: parent.transaction.amountIn, nextNonce: '41', blockNumber: '100', blockHash: HASH_A });
  const operation = ctx.g3b.prepareOperation({ executionId: parent.executionId, operationId, kind: 'SWAP', unsignedTransaction,
    quoteEvidence: quote, allowanceEvidence, reason: 'synthetic risk-bound fixture' }).operation;
  const simulation = await ctx.providers.provider.simulate({ executionId: parent.executionId, operationId, semanticDigest: operation.semanticDigest,
    unsignedTransactionHash: operation.unsignedTransactionHash as `0x${string}`, poolAddress: BASE_UNISWAP_V3.pool, blockNumber: '100', blockHash: HASH_A });
  ctx.g3b.recordSimulation(operationId, simulation, 'risk-bound synthetic simulation');
  return { parent, operationId, operation, quote, risk: riskQuery(parent, operation, '100', HASH_A, quote) };
}
async function prepareRiskStage(ctx: ReturnType<typeof setup>) {
  const stage = await prepareSimulationStage(ctx);
  const fee = await ctx.providers.provider.baseFee(feeQuery(stage.parent, stage.operation));
  ctx.g3b.recordFee(stage.operationId, fee, 'risk fixture Base fee');
  return stage;
}

describe('G3b adversarial policy evidence', () => {
  const calldataMutations: Array<readonly [string, Partial<{ tokenIn: Address; tokenOut: Address; fee: number; recipient: Address; amountIn: bigint }>]> = [
    ['recipient', { recipient: '0x2222222222222222222222222222222222222222' as Address }],
    ['tokenIn', { tokenIn: BASE_TOKENS.WETH }],
    ['tokenOut', { tokenOut: BASE_TOKENS.USDC }],
    ['fee tier', { fee: 3000 }],
    ['exact input', { amountIn: 5000001n }],
  ];
  it.each(calldataMutations)('rejects calldata with altered %s', async (_name, change) => {
    const ctx = setup(); const { operation, quoteEvidence } = await prepareOperation(ctx, 'SWAP');
    const parent = ctx.execution.get(ctx.parent.executionId); const tx = operation.unsignedTransaction;
    const decodedParams = { tokenIn: BASE_TOKENS.USDC, tokenOut: BASE_TOKENS.WETH, fee: 500, recipient: wallet,
      amountIn: BigInt(parent.transaction.amountIn), amountOutMinimum: BigInt(quoteEvidence!.payload.kind === 'QUOTE' ? quoteEvidence!.payload.minimumAmountOut : '0'),
      sqrtPriceLimitX96: 0n, ...change };
    const inner = encodeFunctionData({ abi: routerAbi, functionName: 'exactInputSingle', args: [decodedParams] });
    const deadline = BigInt(Math.floor(Date.parse(parent.intent.expiresAt) / 1000));
    const mutated = { ...tx, data: encodeFunctionData({ abi: routerAbi, functionName: 'multicall', args: [deadline, [inner]] }) };
    expect(() => assertG3bOperationTransaction(parent, 'SWAP', mutated, nowMs, quoteEvidence!, ctx.providers.trust, operation.allowanceEvidence!)).toThrow();
  });

  it('rejects an otherwise valid quote signed by an untrusted evidence key', async () => {
    const ctx = setup(); const parent = ctx.execution.get(ctx.parent.executionId); const operationId = randomUUID();
    const quote = await ctx.providers.provider.quote({ executionId: parent.executionId, operationId, chainId: 8453,
      poolAddress: BASE_UNISWAP_V3.pool, tokenIn: BASE_TOKENS.USDC, tokenOut: BASE_TOKENS.WETH, fee: 500,
      amountIn: parent.transaction.amountIn, minimumAmountOut: '1000000000000000', slippageBps: 10, priceImpactBps: 10,
      blockNumber: '100', blockHash: HASH_A });
    const outsider = generateKeyPairSync('ed25519');
    const unauthorizedQuote = signG3bEvidence(quote.payload, outsider.privateKey);
    expect(() => buildG3bSwapTransactionForQuote(parent, feeFields('41'), unauthorizedQuote, ctx.providers.trust, operationId, nowMs)).toThrow();
  });

  it('rejects evidence above the fixed wallet, fee, WETH, slip, impact, and session loss caps', async () => {
    const rejectedRisk: Array<readonly [string, Record<string, string | number>]> = [
      ['wallet', { walletValueUsdcMicros: '25000001' }],
      ['WETH position', { wethPositionAfterUsdcMicros: '10000001' }],
      ['slippage', { slippageBps: 51 }],
      ['price impact', { priceImpactBps: 51 }],
      ['session loss', { currentSessionLossUsdcMicros: '2000001', projectedSessionLossUsdcMicros: '2063001' }],
    ];
    for (const [label, change] of rejectedRisk) {
      const ctx = setup(); const stage = await prepareRiskStage(ctx);
      const base = await ctx.providers.provider.sessionRisk(stage.risk);
      const attestation = ctx.providers.attest({ ...base.payload, ...change } as typeof base.payload);
      expect(() => ctx.g3b.recordRisk(stage.operationId, attestation, `reject over cap ${label}`), label).toThrow();
    }

    const ctx = setup(); const stage = await prepareSimulationStage(ctx);
    const tooExpensive = await ctx.providers.provider.baseFee({ ...feeQuery(stage.parent, stage.operation), valueUsdcMicros: '250001' });
    expect(() => ctx.g3b.recordFee(stage.operationId, tooExpensive, 'reject fee above 25 cents')).toThrow();
  });

  it('blocks child authorization after stop and reevaluates an expired parent intent', async () => {
    const stopped = setup(); const stage = await prepareRiskStage(stopped);
    const validRisk = await stopped.providers.provider.sessionRisk(stage.risk);
    stopped.g3b.recordRisk(stage.operationId, validRisk, 'valid risk before stop');
    stopped.execution.setKillSwitch(true, 'synthetic stop barrier');
    expect(() => stopped.g3b.authorize(stage.operationId, 'authorization after stop')).toThrow();

    const expired = setup();
    nowMs = Date.parse(expired.parent.intent.expiresAt) + 1;
    await expect(prepareOperation(expired, 'SWAP')).rejects.toThrow();
  });
});

it('authenticates the isolated signer request with an HMAC', async () => {
  const ctx = setup(); const { operationId } = await prepareOperation(ctx, 'SWAP');
  const payload = signingPayload(ctx, operationId); const secret = Buffer.alloc(32, 7);
  const encoded = createG3bSignerMessage(payload, secret);
  const message = JSON.parse(encoded) as unknown;
  expect(verifyG3bSignerMessage(message, secret)).toEqual(payload);
  expect(() => verifyG3bSignerMessage({ ...(message as object), mac: '0'.repeat(64) }, secret)).toThrow('G3B_SIGNER_MESSAGE_AUTH_FAILED');
});

describe('G3b repair regressions', () => {
  it('accepts canonical nonce zero and the safe integer boundary, and rejects invalid or oversized values', () => {
    const ctx = setup(); const parent = ctx.execution.get(ctx.parent.executionId);
    const zero = buildG3bApprovalTransaction(parent, feeFields('0'));
    expect(zero.nonce).toBe('0');
    expect(g3bUnsignedTransactionHash(zero)).toMatch(/^0x[0-9a-f]{64}$/u);
    const maximum = buildG3bApprovalTransaction(parent, feeFields(String(Number.MAX_SAFE_INTEGER)));
    expect(g3bUnsignedTransactionHash(maximum)).toMatch(/^0x[0-9a-f]{64}$/u);
    for (const nonce of ['-1', '01', '9007199254740992', '9007199254740993']) {
      expect(() => buildG3bApprovalTransaction(parent, feeFields(nonce)), nonce).toThrow();
    }
  });

  it('rejects a transaction hash changed independently on the open store, on reopen, and in a fresh process', async () => {
    const ctx = setup(); const { operationId } = await prepareOperation(ctx, 'SWAP');
    const payload = signingPayload(ctx, operationId); const { signer } = signerFor(ctx);
    const signed = await signer.sign(payload); await signer.close();
    await ctx.g3b.persistSigned(operationId, signed.signedBytesHex, signed.transactionHash, 'persist for hash-integrity regression');
    mutateStoredG3bOperation(operationId, (operation) => { operation.transactionHash = '0x' + 'f'.repeat(64); });

    expect(() => ctx.g3b.get(operationId)).toThrow();
    expect(() => ctx.g3b.prepareBroadcast(operationId, 'must reject mutated outbox identity')).toThrow();
    const reservationDb = new DatabaseSync(databasePath);
    try {
      const row = reservationDb.prepare('SELECT status FROM wallet_reservations WHERE reservation_id = ?').get(ctx.parent.reservationId) as { status: string };
      expect(row.status).toBe('ACTIVE');
    } finally { reservationDb.close(); }

    ctx.execution.close();
    expect(() => openExecutionStore({ databasePath, clock: ctx.clock })).toThrow();
    const child = await freshProcessOpen();
    expect(child.response.type).toBe('error');
    expect(child.exitCode).toBe(0);
  });

  it('rejects signed bytes for altered authorized fields even when their hash and digest agree', async () => {
    const ctx = setup(); const { operationId } = await prepareOperation(ctx, 'SWAP');
    const payload = signingPayload(ctx, operationId); const { signer } = signerFor(ctx);
    const signed = await signer.sign(payload); await signer.close();
    await ctx.g3b.persistSigned(operationId, signed.signedBytesHex, signed.transactionHash, 'persist for signed-field regression');
    const transaction = ctx.g3b.get(operationId).unsignedTransaction;
    const mismatchedBytes = await privateKeyToAccount(ctx.walletPrivateKey).signTransaction({
      type: 'eip1559', chainId: transaction.chainId, nonce: Number(BigInt(transaction.nonce)), gas: BigInt(transaction.gasLimit),
      maxFeePerGas: BigInt(transaction.maxFeePerGasWei), maxPriorityFeePerGas: BigInt(transaction.maxPriorityFeePerGasWei),
      to: transaction.to as Address, value: BigInt(transaction.valueWei) + 1n, data: transaction.data as Hex, accessList: [],
    });
    const mismatchedDigest = createHash('sha256').update(Buffer.from(mismatchedBytes.slice(2), 'hex')).digest('hex');
    const mismatchedHash = keccak256(mismatchedBytes);
    mutateStoredG3bOperation(operationId, (operation) => {
      operation.signedBytesHex = mismatchedBytes as Hex;
      operation.signedBytesDigest = mismatchedDigest;
      operation.transactionHash = mismatchedHash;
    });

    expect(() => ctx.g3b.get(operationId)).toThrow();
    ctx.execution.close();
    expect(() => openExecutionStore({ databasePath, clock: ctx.clock })).toThrow();
    const reservationDb = new DatabaseSync(databasePath);
    try {
      const row = reservationDb.prepare('SELECT status FROM wallet_reservations WHERE reservation_id = ?').get(ctx.parent.reservationId) as { status: string };
      expect(row.status).toBe('ACTIVE');
    } finally { reservationDb.close(); }
  });

  it('keeps expired signed history inspectable and recovers identical bytes on every retry', async () => {
    const ctx = setup(); const { operationId } = await prepareOperation(ctx, 'SWAP');
    const payload = signingPayload(ctx, operationId); const { signer } = signerFor(ctx);
    const signed = await signer.sign(payload); await signer.close();
    await ctx.g3b.persistSigned(operationId, signed.signedBytesHex, signed.transactionHash, 'persist for expired-history regression');

    nowMs = Date.parse(ctx.parent.intent.expiresAt) + 1;
    ctx.execution.close();
    const reopened = openExecutionStore({ databasePath, clock: ctx.clock }); stores.push(reopened);
    const recovered = new G3bExecutionStore(reopened, ctx.providers.trust);
    expect(recovered.get(operationId).status).toBe('SIGNED_OUTBOX');
    const first = recovered.prepareBroadcast(operationId, 'recover exact signed bytes after expiry');
    const second = recovered.prepareBroadcast(operationId, 'retry exact signed bytes after expiry');
    expect(first.signedBytesHex).toBe(signed.signedBytesHex);
    expect(second.signedBytesHex).toBe(signed.signedBytesHex);
    expect(first.transactionHash).toBe(signed.transactionHash);
    expect(second.transactionHash).toBe(signed.transactionHash);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.attempt).toBe(first.attempt + 1);
  });
});
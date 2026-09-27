import type { G3cEvidenceAttestation } from '@ered-luin/contracts';
import type { Hex } from 'viem';
import { G3cExecutionStore, broadcastG3cOperation, signG3cOperation, type G3cBroadcaster, type G3cSigner, type G3cWorkflowWriteResult } from './g3c-execution-store.js';
import type { G3cReadOnlyBaseProvider } from './g3c-base-provider.js';
import { buildG3cUnsignedTransaction } from './g3c-transaction.js';
import { BASE_TOKENS } from './base-allowlist.js';

const MAX_GAS_LIMIT = Object.freeze({ APPROVAL: 150_000n, SWAP: 450_000n });
function ceilDiv(n: bigint, d: bigint): bigint { if (d <= 0n) throw new Error('G3C_DIVISOR_INVALID'); return (n + d - 1n) / d; }
function accountFields(value: G3cEvidenceAttestation) {
  if (value.payload.kind !== 'ACCOUNT_SNAPSHOT') throw new Error('G3C_ACCOUNT_SNAPSHOT_REQUIRED');
  return value.payload;
}
function simulationFields(value: G3cEvidenceAttestation) {
  if (value.payload.kind !== 'SIMULATION' || value.payload.outcome !== 'PASSED') throw new Error('G3C_REAL_SIMULATION_FAILED');
  return value.payload;
}
export async function startBaseG3cSession(input: {
  readonly store: G3cExecutionStore; readonly provider: G3cReadOnlyBaseProvider; readonly sessionId: string;
  readonly walletAddress: string; readonly allowanceToken: string; readonly reason: string;
}) {
  await input.provider.verifyDeployment();
  const snapshot = await input.provider.account(input.walletAddress, input.allowanceToken, 1, 'unsafe');
  return input.store.startSession({ sessionId: input.sessionId, accountSnapshot: snapshot, reason: input.reason });
}
export interface G3cSimulationResult {
  readonly accountVersion: number;
  readonly transaction: import('@ered-luin/contracts').G3bUnsignedTransaction;
  readonly quote: G3cEvidenceAttestation | null;
  readonly simulation: G3cEvidenceAttestation;
  readonly fee: G3cEvidenceAttestation;
}

/** Provider-backed D2 simulation. It refreshes read-only evidence but does not persist a G3c authorization workflow. */
export async function simulateBaseG3cOperation(input: {
  readonly store: G3cExecutionStore; readonly provider: G3cReadOnlyBaseProvider; readonly executionId: string;
  readonly operationId: string; readonly sessionId: string;
}): Promise<G3cSimulationResult> {
  input.store.assertIntentFresh(input.executionId);
  await input.provider.verifyDeployment();
  const parent = input.store.getParent(input.executionId);
  const session = input.store.getSession(input.sessionId);
  if (session.status !== 'ACTIVE') throw new Error('G3C_SESSION_NOT_ACTIVE');
  if (session.walletAddress.toLowerCase() !== parent.walletAddress.toLowerCase()) throw new Error('G3C_SESSION_WALLET_MISMATCH');
  const tokenIn = parent.intent.sellAsset === 'USDC' ? BASE_TOKENS.USDC : BASE_TOKENS.WETH;
  const refreshed = await input.provider.account(parent.walletAddress, tokenIn, session.latestAccountVersion + 1, 'unsafe');
  const snapshot = accountFields(refreshed);
  input.store.refreshSessionSnapshot(input.sessionId, refreshed, 'D2 read-only G3c simulation account refresh');
  const quote = await input.provider.quote({
    executionId: input.executionId, operationId: input.operationId, tokenIn,
    tokenOut: parent.intent.buyAsset === 'USDC' ? BASE_TOKENS.USDC : BASE_TOKENS.WETH,
    amountIn: parent.transaction.amountIn, slippageBps: 50,
    blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash as `0x${string}`, sourceFinality: 'unsafe',
  });
  const feeGasCeiling = BigInt(parent.transaction.maxTotalFeeWei) / BigInt(parent.transaction.maxFeePerGasWei);
  const initialGasLimit = feeGasCeiling < MAX_GAS_LIMIT.SWAP ? feeGasCeiling : MAX_GAS_LIMIT.SWAP;
  if (initialGasLimit <= 0n) throw new Error('G3C_FEE_OR_GAS_CEILING_INSUFFICIENT');
  const initialTransaction = buildG3cUnsignedTransaction({ parent, kind: 'SWAP', accountSnapshot: refreshed, quote, gasLimit: initialGasLimit });
  const firstSimulation = await input.provider.simulate({
    executionId: input.executionId, operationId: input.operationId, transaction: initialTransaction,
    blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash as `0x${string}`, sourceFinality: 'unsafe',
  });
  const estimatedGas = BigInt(simulationFields(firstSimulation).gasEstimate);
  const gasLimit = ceilDiv(estimatedGas * 120n, 100n);
  if (gasLimit > MAX_GAS_LIMIT.SWAP || gasLimit > feeGasCeiling || gasLimit < estimatedGas) throw new Error('G3C_FEE_OR_GAS_CEILING_INSUFFICIENT');
  const transaction = buildG3cUnsignedTransaction({ parent, kind: 'SWAP', accountSnapshot: refreshed, quote, gasLimit });
  const simulation = gasLimit === initialGasLimit ? firstSimulation : await input.provider.simulate({
    executionId: input.executionId, operationId: input.operationId, transaction,
    blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash as `0x${string}`, sourceFinality: 'unsafe',
  });
  simulationFields(simulation);
  const fee = await input.provider.estimateFee({
    executionId: input.executionId, operationId: input.operationId, transaction,
    blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash as `0x${string}`, sourceFinality: 'unsafe',
  });
  input.store.validateSimulation({ executionId: input.executionId, operationId: input.operationId, sessionId: input.sessionId,
    kind: 'SWAP', unsignedTransaction: transaction, accountSnapshot: refreshed, quote, simulation, fee,
    reason: 'D2 simulation validates G3c evidence without creating authorization state' });
  return Object.freeze({ accountVersion: snapshot.accountVersion, transaction, quote, simulation, fee });
}

export async function prepareBaseG3cOperation(input: {
  readonly store: G3cExecutionStore; readonly provider: G3cReadOnlyBaseProvider; readonly executionId: string;
  readonly operationId: string; readonly sessionId: string; readonly kind: 'APPROVAL' | 'SWAP'; readonly reason: string;
  readonly submissionMode?: 'APPLICATION_SIGNER' | 'BROWSER_WALLET';
}): Promise<G3cWorkflowWriteResult> {
  input.store.assertIntentFresh(input.executionId);
  await input.provider.verifyDeployment();
  const parent = input.store.getParent(input.executionId);
  const session = input.store.getSession(input.sessionId);
  if (session.walletAddress.toLowerCase() !== parent.walletAddress.toLowerCase()) throw new Error('G3C_SESSION_WALLET_MISMATCH');
  const tokenIn = parent.intent.sellAsset === 'USDC' ? BASE_TOKENS.USDC : BASE_TOKENS.WETH;
  const refreshed = await input.provider.account(parent.walletAddress, tokenIn, session.latestAccountVersion + 1, 'unsafe');
  const snapshot = accountFields(refreshed);
  input.store.refreshSessionSnapshot(input.sessionId, refreshed, 'Fresh Base account and allowance snapshot');
  let quote: G3cEvidenceAttestation | null = null;
  if (input.kind === 'SWAP') {
    quote = await input.provider.quote({ executionId: input.executionId, operationId: input.operationId, tokenIn,
      tokenOut: parent.intent.buyAsset === 'USDC' ? BASE_TOKENS.USDC : BASE_TOKENS.WETH,
      amountIn: parent.transaction.amountIn, slippageBps: 50, blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash as `0x${string}`, sourceFinality: 'unsafe'});
  }
  const gasLimitCeiling = MAX_GAS_LIMIT[input.kind];
  const feeGasCeiling = BigInt(parent.transaction.maxTotalFeeWei) / BigInt(parent.transaction.maxFeePerGasWei);
  const initialGasLimit = feeGasCeiling < gasLimitCeiling ? feeGasCeiling : gasLimitCeiling;
  if (initialGasLimit <= 0n) throw new Error('G3C_FEE_OR_GAS_CEILING_INSUFFICIENT');
  const initialTransaction = buildG3cUnsignedTransaction({ parent, kind: input.kind, accountSnapshot: refreshed, quote, gasLimit: initialGasLimit });
  const firstSimulation = await input.provider.simulate({ executionId: input.executionId, operationId: input.operationId,
    transaction: initialTransaction, blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash as `0x${string}`, sourceFinality: 'unsafe'});
  const estimatedGas = BigInt(simulationFields(firstSimulation).gasEstimate);
  const gasLimit = ceilDiv(estimatedGas * 120n, 100n);
  if (gasLimit > gasLimitCeiling || gasLimit > feeGasCeiling || gasLimit < estimatedGas) throw new Error('G3C_FEE_OR_GAS_CEILING_INSUFFICIENT');
  const transaction = buildG3cUnsignedTransaction({ parent, kind: input.kind, accountSnapshot: refreshed, quote, gasLimit });
  const simulation = gasLimit === initialGasLimit ? firstSimulation : await input.provider.simulate({ executionId: input.executionId,
    operationId: input.operationId, transaction, blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash as `0x${string}`, sourceFinality: 'unsafe'});
  simulationFields(simulation);
  const fee = await input.provider.estimateFee({ executionId: input.executionId, operationId: input.operationId,
    transaction, blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash as `0x${string}`, sourceFinality: 'unsafe'});
  const workflowInput = { executionId: input.executionId, operationId: input.operationId, sessionId: input.sessionId,
    kind: input.kind, unsignedTransaction: transaction, accountSnapshot: refreshed, quote, simulation, fee, reason: input.reason } as const;
  return input.submissionMode === 'BROWSER_WALLET'
    ? input.store.prepareBrowserOperation(workflowInput)
    : input.store.prepareOperation(workflowInput);
}
export async function signBaseG3cOperation(input: {
  readonly store: G3cExecutionStore; readonly provider: G3cReadOnlyBaseProvider; readonly operationId: string;
  readonly signer: G3cSigner; readonly reason: string;
}): Promise<G3cWorkflowWriteResult> {
  const workflow = input.store.getWorkflow(input.operationId);
  input.store.assertIntentFresh(workflow.executionId);
  const session = input.store.getSession(workflow.sessionId);
  const token = workflow.accountSnapshot.payload.kind === 'ACCOUNT_SNAPSHOT' ? workflow.accountSnapshot.payload.allowanceToken : '';
  const fresh = await input.provider.account(session.walletAddress, token, workflow.accountVersion, 'unsafe');
  return signG3cOperation(input.store, input.operationId, fresh, input.signer, input.reason);
}
export async function broadcastBaseG3cOperation(input: {
  readonly store: G3cExecutionStore; readonly operationId: string; readonly broadcaster: G3cBroadcaster; readonly reason: string;
  readonly clock?: () => Date;
}): Promise<G3cWorkflowWriteResult> {
  return broadcastG3cOperation(input.store, input.operationId, input.broadcaster, input.reason, input.clock);
}
export async function reconcileBaseG3cOperation(input: {
  readonly store: G3cExecutionStore; readonly provider: G3cReadOnlyBaseProvider; readonly operationId: string; readonly reason: string;
}): Promise<G3cWorkflowWriteResult> {
  const reconcile = async () => {
    const workflow = input.store.getWorkflow(input.operationId);
    if (!workflow.transactionHash) throw new Error('G3C_TRANSACTION_HASH_MISSING');
    const receipt = await input.provider.receipt({ executionId: workflow.executionId, operationId: workflow.operationId,
      transactionHash: workflow.transactionHash as Hex, sender: workflow.unsignedTransaction.from, nonce: workflow.unsignedTransaction.nonce,
      expectedTransaction: workflow.unsignedTransaction });
    const payload = receipt.payload;
    if (payload.kind !== 'RECEIPT' || !['CONFIRMED','REVERTED'].includes(payload.outcome) || payload.finality !== 'finalized' || payload.canonical !== true) {
      return input.store.recordReceipt(workflow.operationId, receipt, null, input.reason);
    }
    const session = input.store.getSession(workflow.sessionId);
    const token = workflow.accountSnapshot.payload.kind === 'ACCOUNT_SNAPSHOT' ? workflow.accountSnapshot.payload.allowanceToken : '';
    const settlement = await input.provider.account(session.walletAddress, token, session.latestAccountVersion + 1, 'finalized');
    return input.store.recordReceipt(workflow.operationId, receipt, settlement, input.reason);
  };
  return input.provider.withRecoveryBudget
    ? input.provider.withRecoveryBudget(reconcile)
    : reconcile();
}

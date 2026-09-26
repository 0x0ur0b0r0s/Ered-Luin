import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  decodeFunctionData, encodeFunctionData, getAddress, keccak256, parseAbi, parseTransaction, serializeTransaction,
  type Address, type Hex, type TransactionSerialized,
} from 'viem';
import { canonicalJson, g3bUnsignedTransactionSchema, type G3bOperation, type G3bOperationKind, type G3bUnsignedTransaction } from '@ered-luin/contracts';
import type { ExecutionLifecycleRecord, G3bEvidenceAttestation } from '@ered-luin/contracts';
import { assertFreshG3bEvidence, verifyG3bEvidenceAttestation, type G3bEvidenceTrust } from './g3b-evidence.js';
import { BASE_ALLOWLIST_VERSION, BASE_TOKENS, BASE_UNISWAP_V3 } from './base-allowlist.js';

export const UNISWAP_V3_ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)',
]);
export const ERC20_APPROVAL_ABI = parseAbi(['function approve(address spender,uint256 value) returns (bool)']);
const SWAP_ABI = UNISWAP_V3_ROUTER_ABI;

export interface G3bFeeFields {
  readonly nonce: string;
  readonly gasLimit: string;
  readonly maxFeePerGasWei: string;
  readonly maxPriorityFeePerGasWei: string;
}

function assetAddress(asset: 'USDC' | 'WETH'): Address { return BASE_TOKENS[asset]; }
function positive(value: string): bigint { const n = BigInt(value); if (n <= 0n) throw new Error('G3B_INVALID_POSITIVE_INTEGER'); return n; }
function safeNonceNumber(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error('G3B_INVALID_NONCE');
  const nonce = BigInt(value);
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('G3B_NONCE_OUT_OF_RANGE');
  return Number(nonce);
}
function safeEpochSeconds(value: string): bigint {
  const millis = Date.parse(value);
  if (!Number.isSafeInteger(millis) || new Date(millis).toISOString() !== value) throw new Error('G3B_INVALID_TIMESTAMP');
  return BigInt(Math.floor(millis / 1000));
}
function validateFeeFields(fields: G3bFeeFields): void {
  positive(fields.gasLimit); positive(fields.maxFeePerGasWei); safeNonceNumber(fields.nonce);
  if (!/^(0|[1-9][0-9]*)$/u.test(fields.maxPriorityFeePerGasWei) ||
      BigInt(fields.maxPriorityFeePerGasWei) > BigInt(fields.maxFeePerGasWei)) throw new Error('G3B_INVALID_FEE_FIELDS');
}

function buildSwapTransaction(parent: ExecutionLifecycleRecord, fees: G3bFeeFields, exactMinimumAmountOut: string): G3bUnsignedTransaction {
  validateFeeFields(fees);
  const intent = parent.intent;
  const deadline = safeEpochSeconds(intent.expiresAt);
  const inner = encodeFunctionData({
    abi: UNISWAP_V3_ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [{ tokenIn: assetAddress(intent.sellAsset), tokenOut: assetAddress(intent.buyAsset), fee: BASE_UNISWAP_V3.fee,
      recipient: getAddress(parent.walletAddress), amountIn: positive(parent.transaction.amountIn),
      amountOutMinimum: positive(exactMinimumAmountOut), sqrtPriceLimitX96: 0n }],
  });
  const data = encodeFunctionData({ abi: UNISWAP_V3_ROUTER_ABI, functionName: 'multicall', args: [deadline, [inner]] });
  return g3bUnsignedTransactionSchema.parse({
    version: 1, type: 'EIP1559', chainId: BASE_UNISWAP_V3.chainId,
    from: getAddress(parent.walletAddress), to: BASE_UNISWAP_V3.router, data,
    valueWei: parent.transaction.valueNativeWei, nonce: fees.nonce, gasLimit: fees.gasLimit,
    maxFeePerGasWei: fees.maxFeePerGasWei, maxPriorityFeePerGasWei: fees.maxPriorityFeePerGasWei, accessList: [],
  });
}

export function buildG3bSwapTransaction(parent: ExecutionLifecycleRecord, fees: G3bFeeFields): G3bUnsignedTransaction {
  return buildSwapTransaction(parent, fees, parent.transaction.minimumAmountOut);
}

export function buildG3bSwapTransactionForQuote(
  parent: ExecutionLifecycleRecord,
  fees: G3bFeeFields,
  quoteEvidence: G3bEvidenceAttestation,
  trust: G3bEvidenceTrust,
  expectedOperationId: string,
  nowMs: number,
): G3bUnsignedTransaction {
  const quote = verifyG3bEvidenceAttestation(quoteEvidence, trust).payload;
  assertFreshG3bEvidence(quoteEvidence, nowMs);
  if (quote.kind !== 'QUOTE' || quote.executionId !== parent.executionId || quote.operationId !== expectedOperationId ||
      quote.chainId !== BASE_UNISWAP_V3.chainId || quote.poolAddress.toLowerCase() !== BASE_UNISWAP_V3.pool.toLowerCase() ||
      quote.tokenIn.toLowerCase() !== assetAddress(parent.intent.sellAsset).toLowerCase() ||
      quote.tokenOut.toLowerCase() !== assetAddress(parent.intent.buyAsset).toLowerCase() || quote.fee !== BASE_UNISWAP_V3.fee ||
      quote.amountIn !== parent.transaction.amountIn || quote.slippageBps > 50 || quote.priceImpactBps > 50) throw new Error('G3B_QUOTE_BINDING_INVALID');
  return buildSwapTransaction(parent, fees, quote.minimumAmountOut);
}

export function buildG3bApprovalTransaction(parent: ExecutionLifecycleRecord, fees: G3bFeeFields): G3bUnsignedTransaction {
  validateFeeFields(fees);
  const data = encodeFunctionData({ abi: ERC20_APPROVAL_ABI, functionName: 'approve',
    args: [BASE_UNISWAP_V3.router, positive(parent.transaction.amountIn)] });
  return g3bUnsignedTransactionSchema.parse({
    version: 1, type: 'EIP1559', chainId: BASE_UNISWAP_V3.chainId,
    from: getAddress(parent.walletAddress), to: assetAddress(parent.intent.sellAsset), data,
    valueWei: '0', nonce: fees.nonce, gasLimit: fees.gasLimit,
    maxFeePerGasWei: fees.maxFeePerGasWei, maxPriorityFeePerGasWei: fees.maxPriorityFeePerGasWei, accessList: [],
  });
}

export function serializeG3bUnsignedTransaction(transaction: G3bUnsignedTransaction): Hex {
  const tx = g3bUnsignedTransactionSchema.parse(transaction);
  return serializeTransaction({
    type: 'eip1559', chainId: tx.chainId, nonce: safeNonceNumber(tx.nonce), gas: BigInt(tx.gasLimit),
    maxFeePerGas: BigInt(tx.maxFeePerGasWei), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGasWei),
    to: getAddress(tx.to), value: BigInt(tx.valueWei), data: tx.data as Hex, accessList: [],
  });
}

export function g3bUnsignedTransactionHash(transaction: G3bUnsignedTransaction): `0x${string}` {
  return keccak256(serializeG3bUnsignedTransaction(transaction));
}

export function g3bSemanticDigest(input: {
  readonly executionId: string;
  readonly operationId: string;
  readonly kind: G3bOperationKind;
  readonly transaction: G3bUnsignedTransaction;
}): string {
  return createHash('sha256').update(canonicalJson({ version: 1, allowlistVersion: BASE_ALLOWLIST_VERSION, ...input })).digest('hex');
}

export interface DecodedSwap {
  readonly deadline: bigint;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly fee: number;
  readonly recipient: Address;
  readonly amountIn: bigint;
  readonly amountOutMinimum: bigint;
  readonly sqrtPriceLimitX96: bigint;
}

export function decodeExactSwap(data: Hex): DecodedSwap {
  const outer = decodeFunctionData({ abi: SWAP_ABI, data });
  if (outer.functionName !== 'multicall' || !outer.args || outer.args[1].length !== 1) throw new Error('G3B_UNSUPPORTED_ROUTER_CALL');
  const [deadline, calls] = outer.args;
  const inner = decodeFunctionData({ abi: SWAP_ABI, data: calls[0]! });
  if (inner.functionName !== 'exactInputSingle') throw new Error('G3B_UNSUPPORTED_ROUTER_CALL');
  const args = inner.args[0];
  const normalized = encodeFunctionData({ abi: SWAP_ABI, functionName: 'multicall', args: [deadline, [calls[0]!]] });
  if (normalized.toLowerCase() !== data.toLowerCase()) throw new Error('G3B_NON_CANONICAL_CALLDATA');
  return { deadline, tokenIn: getAddress(args.tokenIn), tokenOut: getAddress(args.tokenOut), fee: args.fee,
    recipient: getAddress(args.recipient), amountIn: args.amountIn, amountOutMinimum: args.amountOutMinimum,
    sqrtPriceLimitX96: args.sqrtPriceLimitX96 };
}

export function assertG3bOperationTransaction(
  parent: ExecutionLifecycleRecord,
  kind: G3bOperationKind,
  transaction: G3bUnsignedTransaction,
  nowMs: number,
  quoteEvidence?: G3bEvidenceAttestation,
  trust?: G3bEvidenceTrust,
  allowanceEvidence?: G3bEvidenceAttestation,
): void {
  const tx = g3bUnsignedTransactionSchema.parse(transaction);
  const intent = parent.intent;
  if (!Number.isSafeInteger(nowMs) || tx.chainId !== BASE_UNISWAP_V3.chainId || tx.from.toLowerCase() !== parent.walletAddress.toLowerCase() ||
      tx.accessList.length !== 0 || BigInt(tx.gasLimit) * BigInt(tx.maxFeePerGasWei) > BigInt(parent.transaction.maxTotalFeeWei) ||
      BigInt(tx.maxPriorityFeePerGasWei) > BigInt(parent.transaction.maxPriorityFeePerGasWei) ||
      BigInt(tx.maxFeePerGasWei) > BigInt(parent.transaction.maxFeePerGasWei)) throw new Error('G3B_TRANSACTION_ENVELOPE_MISMATCH');
  if (kind === 'SWAP') {
    let expectedNonce = parent.transaction.chainNonce;
    if (allowanceEvidence) {
      if (!trust) throw new Error('G3B_ALLOWANCE_TRUST_REQUIRED');
      const allowance = verifyG3bEvidenceAttestation(allowanceEvidence, trust).payload;
      assertFreshG3bEvidence(allowanceEvidence, nowMs);
      if (allowance.kind !== 'ALLOWANCE' || allowance.executionId !== parent.executionId || allowance.walletAddress.toLowerCase() !== parent.walletAddress.toLowerCase()) throw new Error('G3B_ALLOWANCE_INVALID');
      expectedNonce = allowance.nextNonce;
    }
    if (tx.to.toLowerCase() !== BASE_UNISWAP_V3.router.toLowerCase() || tx.valueWei !== parent.transaction.valueNativeWei ||
        tx.nonce !== expectedNonce || tx.maxFeePerGasWei !== parent.transaction.maxFeePerGasWei ||
        tx.maxPriorityFeePerGasWei !== parent.transaction.maxPriorityFeePerGasWei) throw new Error('G3B_SWAP_ENVELOPE_MISMATCH');
    const decoded = decodeExactSwap(tx.data as Hex);
    let expectedMinimumAmountOut = parent.transaction.minimumAmountOut;
    if (quoteEvidence) {
      if (!trust) throw new Error('G3B_QUOTE_TRUST_REQUIRED');
      const quote = verifyG3bEvidenceAttestation(quoteEvidence, trust).payload;
      assertFreshG3bEvidence(quoteEvidence, nowMs);
      if (quote.kind !== 'QUOTE' || quote.executionId !== parent.executionId ||
          quote.tokenIn.toLowerCase() !== assetAddress(intent.sellAsset).toLowerCase() || quote.tokenOut.toLowerCase() !== assetAddress(intent.buyAsset).toLowerCase() ||
          quote.poolAddress.toLowerCase() !== BASE_UNISWAP_V3.pool.toLowerCase() || quote.fee !== BASE_UNISWAP_V3.fee ||
          quote.amountIn !== parent.transaction.amountIn || quote.slippageBps > 50 || quote.priceImpactBps > 50) throw new Error('G3B_QUOTE_BINDING_INVALID');
      expectedMinimumAmountOut = quote.minimumAmountOut;
    }
    const expectedDeadline = safeEpochSeconds(intent.expiresAt);
    if (decoded.deadline !== expectedDeadline || decoded.deadline * 1000n <= BigInt(nowMs) ||
        decoded.tokenIn.toLowerCase() !== assetAddress(intent.sellAsset).toLowerCase() ||
        decoded.tokenOut.toLowerCase() !== assetAddress(intent.buyAsset).toLowerCase() || decoded.fee !== BASE_UNISWAP_V3.fee ||
        decoded.recipient.toLowerCase() !== parent.walletAddress.toLowerCase() || decoded.amountIn !== BigInt(parent.transaction.amountIn) ||
        decoded.amountOutMinimum !== BigInt(expectedMinimumAmountOut) || decoded.sqrtPriceLimitX96 !== 0n) {
      throw new Error('G3B_SWAP_CALL_MISMATCH');
    }
    return;
  }
  if (tx.to.toLowerCase() !== assetAddress(intent.sellAsset).toLowerCase() || tx.valueWei !== '0' || tx.maxFeePerGasWei === '0') {
    throw new Error('G3B_APPROVAL_ENVELOPE_MISMATCH');
  }
  const approval = decodeFunctionData({ abi: ERC20_APPROVAL_ABI, data: tx.data as Hex });
  if (approval.functionName !== 'approve' || !approval.args || getAddress(approval.args[0]).toLowerCase() !== BASE_UNISWAP_V3.router.toLowerCase() ||
      approval.args[1] !== BigInt(parent.transaction.amountIn)) throw new Error('G3B_APPROVAL_CALL_MISMATCH');
  const canonical = encodeFunctionData({ abi: ERC20_APPROVAL_ABI, functionName: 'approve', args: [BASE_UNISWAP_V3.router, approval.args[1]] });
  if (canonical.toLowerCase() !== tx.data.toLowerCase()) throw new Error('G3B_NON_CANONICAL_CALLDATA');
}

export function validateSignedG3bTransactionSync(
  serialized: Hex,
  expected: G3bUnsignedTransaction,
): { readonly sender: Address; readonly transactionHash: Hex } {
  const tx = g3bUnsignedTransactionSchema.parse(expected);
  if (!/^0x02[0-9a-fA-F]+$/u.test(serialized)) throw new Error('G3B_SIGNED_TRANSACTION_TYPE_INVALID');
  const bytes = serialized as TransactionSerialized;
  const parsed = parseTransaction(bytes);
  const r = parsed.r; const s = parsed.s;
  if (parsed.type !== 'eip1559' || parsed.chainId !== tx.chainId || !Number.isSafeInteger(parsed.nonce) ||
      parsed.nonce !== safeNonceNumber(tx.nonce) || parsed.gas !== BigInt(tx.gasLimit) ||
      parsed.maxFeePerGas !== BigInt(tx.maxFeePerGasWei) || parsed.maxPriorityFeePerGas !== BigInt(tx.maxPriorityFeePerGasWei) ||
      parsed.to?.toLowerCase() !== tx.to.toLowerCase() || (parsed.value ?? 0n) !== BigInt(tx.valueWei) ||
      parsed.data?.toLowerCase() !== tx.data.toLowerCase() || (parsed.accessList?.length ?? 0) !== tx.accessList.length ||
      (parsed.yParity !== 0 && parsed.yParity !== 1) || typeof r !== 'string' || typeof s !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/u.test(r) || !/^0x[0-9a-fA-F]{64}$/u.test(s)) {    throw new Error('G3B_SIGNED_TRANSACTION_MISMATCH');
  }
  const signature = new secp256k1.Signature(BigInt(r), BigInt(s));
  if (signature.hasHighS()) throw new Error('G3B_SIGNED_SIGNATURE_INVALID');
  const signingHash = g3bUnsignedTransactionHash(tx);
  const publicKeyBytes = signature.addRecoveryBit(parsed.yParity).recoverPublicKey(signingHash.slice(2)).toRawBytes(false);
  const publicKey = Buffer.from(publicKeyBytes).subarray(1).toString('hex');
  const sender = getAddress(('0x' + keccak256(('0x' + publicKey) as Hex).slice(-40)) as Address);
  if (sender.toLowerCase() !== tx.from.toLowerCase()) throw new Error('G3B_SIGNED_SENDER_MISMATCH');
  return { sender, transactionHash: keccak256(bytes) };
}

export async function validateSignedG3bTransaction(
  serialized: Hex,
  expected: G3bUnsignedTransaction,
): Promise<{ readonly sender: Address; readonly transactionHash: Hex }> {
  return validateSignedG3bTransactionSync(serialized, expected);
}


function attestationDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function assertStoredG3bOperation(operation: G3bOperation): void {
  if (g3bUnsignedTransactionHash(operation.unsignedTransaction).toLowerCase() !== operation.unsignedTransactionHash.toLowerCase() ||
      g3bSemanticDigest({ executionId: operation.executionId, operationId: operation.operationId, kind: operation.kind,
        transaction: operation.unsignedTransaction }) !== operation.semanticDigest) throw new Error('G3B_STORED_TRANSACTION_BINDING_INVALID');
  const sim = operation.simulation?.payload; const fee = operation.fee?.payload; const risk = operation.risk?.payload;
  const quote = operation.quoteEvidence?.payload; const allowance = operation.allowanceEvidence?.payload;
  const priorApproval = operation.approvalReceipt?.payload; const receipt = operation.receipt?.payload;
  if (sim && (sim.kind !== 'SIMULATION' || sim.executionId !== operation.executionId || sim.operationId !== operation.operationId ||
      sim.semanticDigest !== operation.semanticDigest || sim.unsignedTransactionHash.toLowerCase() !== operation.unsignedTransactionHash.toLowerCase())) throw new Error('G3B_STORED_SIMULATION_INVALID');
  if (fee && (fee.kind !== 'BASE_FEE' || fee.executionId !== operation.executionId || fee.operationId !== operation.operationId ||
      fee.unsignedTransactionHash.toLowerCase() !== operation.unsignedTransactionHash.toLowerCase() || fee.gasLimit !== operation.unsignedTransaction.gasLimit ||
      fee.maxFeePerGasWei !== operation.unsignedTransaction.maxFeePerGasWei || BigInt(fee.totalFeeWei) !== BigInt(fee.executionGasFeeCapWei) + BigInt(fee.l1DataFeeWei) + BigInt(fee.operatorFeeWei))) throw new Error('G3B_STORED_FEE_INVALID');
  if (risk && (risk.kind !== 'SESSION_RISK' || risk.executionId !== operation.executionId || risk.operationId !== operation.operationId ||
      (operation.authorization !== null && risk.accountVersion !== operation.authorization.accountVersion))) throw new Error('G3B_STORED_RISK_INVALID');
  if (operation.kind === 'SWAP') {
    if (!quote || quote.kind !== 'QUOTE' || quote.executionId !== operation.executionId || quote.operationId !== operation.operationId ||
        quote.amountIn === '0' || quote.minimumAmountOut === '0') throw new Error('G3B_STORED_QUOTE_INVALID');
    const decoded = decodeExactSwap(operation.unsignedTransaction.data as Hex);
    if (decoded.amountIn !== BigInt(quote.amountIn) || decoded.amountOutMinimum !== BigInt(quote.minimumAmountOut) || decoded.fee !== quote.fee ||
        decoded.tokenIn.toLowerCase() !== quote.tokenIn.toLowerCase() || decoded.tokenOut.toLowerCase() !== quote.tokenOut.toLowerCase()) throw new Error('G3B_STORED_QUOTE_CALL_MISMATCH');
  } else if (quote || priorApproval) throw new Error('G3B_STORED_APPROVAL_EVIDENCE_INVALID');
  if (allowance) {
    if (allowance.kind !== 'ALLOWANCE' || allowance.executionId !== operation.executionId || allowance.operationId !== operation.operationId ||
        allowance.allowanceAtomic === '0' && operation.kind === 'SWAP') throw new Error('G3B_STORED_ALLOWANCE_INVALID');
  } else if (['AUTHORIZED','SIGNING_CLAIMED','SIGNED_OUTBOX','SUBMISSION_UNCERTAIN','SUBMITTED','CONFIRMED','FAILED'].includes(operation.status)) {
    throw new Error('G3B_STORED_ALLOWANCE_MISSING');
  }
  if (priorApproval && (priorApproval.kind !== 'APPROVAL_RECEIPT' || priorApproval.outcome !== 'CONFIRMED' || priorApproval.executionId !== operation.executionId)) throw new Error('G3B_STORED_APPROVAL_RECEIPT_INVALID');
  if (receipt && (receipt.kind !== 'APPROVAL_RECEIPT' || receipt.executionId !== operation.executionId || receipt.operationId !== operation.operationId ||
      receipt.transactionHash.toLowerCase() !== operation.transactionHash?.toLowerCase())) throw new Error('G3B_STORED_RECEIPT_INVALID');
  const auth = operation.authorization;
  if (auth && (!sim || !fee || !risk || !allowance || (operation.kind === 'SWAP' && !quote) || auth.executionId !== operation.executionId ||
      auth.operationId !== operation.operationId || auth.semanticDigest !== operation.semanticDigest ||
      auth.unsignedTransactionHash.toLowerCase() !== operation.unsignedTransactionHash.toLowerCase() ||
      auth.simulationAttestationDigest !== attestationDigest(operation.simulation) || auth.feeAttestationDigest !== attestationDigest(operation.fee) ||
      auth.riskAttestationDigest !== attestationDigest(operation.risk) || auth.allowanceAttestationDigest !== attestationDigest(operation.allowanceEvidence) ||
      auth.quoteAttestationDigest !== (operation.quoteEvidence ? attestationDigest(operation.quoteEvidence) : null))) throw new Error('G3B_STORED_AUTHORIZATION_INVALID');
  const hasSigned = operation.signedBytesHex !== null || operation.signedBytesDigest !== null || operation.transactionHash !== null;
  if (hasSigned !== (operation.signedBytesHex !== null && operation.signedBytesDigest !== null && operation.transactionHash !== null) ||
      (operation.signedBytesHex !== null && createHash('sha256').update(Buffer.from(operation.signedBytesHex.slice(2), 'hex')).digest('hex') !== operation.signedBytesDigest)) throw new Error('G3B_STORED_SIGNED_BYTES_INVALID');
  if (operation.signedBytesHex !== null) {
    const signed = validateSignedG3bTransactionSync(operation.signedBytesHex as Hex, operation.unsignedTransaction);
    if (signed.transactionHash.toLowerCase() !== operation.transactionHash!.toLowerCase()) throw new Error('G3B_STORED_SIGNED_HASH_INVALID');
  }
  if (['PREPARED'].includes(operation.status) && (sim || fee || risk || auth || operation.signingClaimId || hasSigned || receipt)) throw new Error('G3B_STORED_STATE_INVALID');
  if (['SIMULATED'].includes(operation.status) && (!sim || auth || operation.signingClaimId || hasSigned || receipt)) throw new Error('G3B_STORED_STATE_INVALID');
  if (['AUTHORIZED'].includes(operation.status) && (!auth || operation.signingClaimId || hasSigned || receipt)) throw new Error('G3B_STORED_STATE_INVALID');
  if (['SIGNING_CLAIMED'].includes(operation.status) && (!auth || !operation.signingClaimId || hasSigned || receipt)) throw new Error('G3B_STORED_STATE_INVALID');
  if (['SIGNED_OUTBOX','SUBMISSION_UNCERTAIN','SUBMITTED'].includes(operation.status) && (!auth || !operation.signingClaimId || !hasSigned || receipt)) throw new Error('G3B_STORED_STATE_INVALID');
  if (['CONFIRMED','FAILED'].includes(operation.status) && (!auth || !operation.signingClaimId || !hasSigned || !receipt ||
      (operation.status === 'CONFIRMED' ? receipt.outcome !== 'CONFIRMED' : receipt.outcome !== 'REVERTED'))) throw new Error('G3B_STORED_STATE_INVALID');
  if ((operation.status === 'SIGNED_OUTBOX' && operation.broadcastAttempts !== 0) ||
      (['SUBMISSION_UNCERTAIN','SUBMITTED','CONFIRMED','FAILED'].includes(operation.status) && operation.broadcastAttempts < 1)) throw new Error('G3B_STORED_RETRY_INVALID');
}

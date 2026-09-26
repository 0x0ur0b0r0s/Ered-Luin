import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  canonicalJson, G3B_CAPS, g3bEvidenceAttestationSchema, g3bSignerMessageSchema,
  g3bSignerPayloadSchema, g3bUnsignedTransactionSchema,
  type G3bEvidencePayload, type G3bSignerPayload,
} from '@ered-luin/contracts';
import {
  decodeFunctionData, encodeFunctionData, getAddress, keccak256, parseAbi, parseTransaction,
  recoverTransactionAddress, serializeTransaction, type Hex, type TransactionSerialized,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const CHAIN_ID = 8453;
const ROUTER = '0x2626664c2603336e57b271c5c0b26f421741e481';
const POOL = '0xd0b53d9277642d899df5c87a3966a349a798f224';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const ALLOWLIST_VERSION = 1;
const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)',
]);
const approveAbi = parseAbi(['function approve(address spender,uint256 value) returns (bool)']);
const secretHex = process.env.ERED_LUIN_SIGNER_HMAC_KEY ?? '';
const privateKey = process.env.ERED_LUIN_SIGNER_PRIVATE_KEY ?? '';
const evidenceEnvironment = process.env.ERED_LUIN_SIGNER_EVIDENCE_ENV ?? '';
const allowSynthetic = process.env.ERED_LUIN_ALLOW_SYNTHETIC_TEST_EVIDENCE === '1';
const evidenceKeyJson = process.env.ERED_LUIN_SIGNER_EVIDENCE_KEYS ?? '{}';
delete process.env.ERED_LUIN_SIGNER_PRIVATE_KEY;
delete process.env.ERED_LUIN_SIGNER_HMAC_KEY;
delete process.env.ERED_LUIN_SIGNER_EVIDENCE_KEYS;
let trustedKeys: Record<string, string> = {};
try { trustedKeys = JSON.parse(evidenceKeyJson) as Record<string, string>; } catch { /* Requests fail closed without a usable key map. */ }
const messageSecret = Buffer.from(secretHex, 'hex');
const consumedNonces = new Set<string>();
let diagnosticStage = 'MESSAGE';

function reject(): never { throw new Error('SIGNER_REJECTED'); }
function canonicalDate(value: string): boolean { const ms = Date.parse(value); return Number.isSafeInteger(ms) && new Date(ms).toISOString() === value; }
function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function attestationDigest(value: unknown): string { return sha256(canonicalJson(value)); }
function verifyMessage(value: unknown): G3bSignerPayload {
  const checked = g3bSignerMessageSchema.safeParse(value);
  if (!checked.success || messageSecret.length < 32) return reject();
  const expected = createHmac('sha256', messageSecret).update(canonicalJson(checked.data.payload)).digest();
  const supplied = Buffer.from(checked.data.mac, 'hex');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return reject();
  return g3bSignerPayloadSchema.parse(checked.data.payload);
}
function verifyAttestation(value: unknown, nowMs: number): G3bEvidencePayload {
  const checked = g3bEvidenceAttestationSchema.safeParse(value);
  if (!checked.success) return reject();
  const { payload, signature } = checked.data;
  if (payload.environment !== evidenceEnvironment || (payload.environment === 'synthetic-test' && !allowSynthetic)) return reject();
  const keyPem = trustedKeys[payload.keyId];
  if (!keyPem || !verify(null, Buffer.from(canonicalJson(payload)), createPublicKey(keyPem), Buffer.from(signature.slice(2), 'hex'))) return reject();
  if (payload.kind !== 'APPROVAL_RECEIPT') {
    const observed = Date.parse(payload.observedAt); const expires = Date.parse(payload.expiresAt);
    if (!canonicalDate(payload.observedAt) || !canonicalDate(payload.expiresAt) || observed > nowMs || expires <= nowMs ||
        expires <= observed || expires - observed > G3B_CAPS.evidenceTtlMs) return reject();
  }
  return payload;
}
function safeNonceNumber(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) return reject();
  const nonce = BigInt(value);
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) return reject();
  return Number(nonce);
}
function unsignedTransactionHash(tx: ReturnType<typeof g3bUnsignedTransactionSchema.parse>): string {
  return keccak256(serializeTransaction({ type: 'eip1559', chainId: tx.chainId, nonce: safeNonceNumber(tx.nonce), gas: BigInt(tx.gasLimit),
    maxFeePerGas: BigInt(tx.maxFeePerGasWei), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGasWei), to: getAddress(tx.to),
    value: BigInt(tx.valueWei), data: tx.data as Hex, accessList: [] }));
}
function semanticDigest(payload: G3bSignerPayload): string {
  return sha256(canonicalJson({ version: 1, allowlistVersion: ALLOWLIST_VERSION, executionId: payload.operation.executionId,
    operationId: payload.operation.operationId, kind: payload.operation.kind, transaction: payload.operation.unsignedTransaction }));
}
function validateParentAndAuth(payload: G3bSignerPayload, nowMs: number): void {
  const parent = payload.parent; const operation = payload.operation; const authorization = operation.authorization;
  const g3a = parent.authorization; const claim = parent.signingClaim;
  if (!authorization || !g3a || !claim || parent.status !== 'SIGNING_CLAIMED' || operation.status !== 'SIGNING_CLAIMED' ||
      !operation.signingClaimId || operation.signingClaimId !== claim.claimId || parent.accountVersion !== authorization.accountVersion ||
      parent.accountVersion !== authorization.accountVersion || g3a.authorizationId !== authorization.g3aAuthorizationId ||
      g3a.authorizationNonce !== authorization.g3aAuthorizationNonce || claim.authorizationNonce !== g3a.authorizationNonce ||
      claim.accountVersion !== parent.accountVersion || payload.intent.intentId !== parent.intentId || payload.decision.decisionId !== parent.decisionId ||
      (payload.decision.status !== 'ALLOW' && payload.decision.status !== 'RESIZE')) { diagnosticStage = 'PARENT_LINK'; return reject(); }
  if (parent.intent.walletAddress.toLowerCase() !== parent.walletAddress.toLowerCase() ||
      parent.transaction.walletAddress.toLowerCase() !== parent.walletAddress.toLowerCase() || parent.transaction.chainId !== CHAIN_ID ||
      sha256(JSON.stringify(parent.transaction)) !== parent.transactionDigest) { diagnosticStage = 'PARENT_SEMANTIC'; return reject(); }
  const requestAt = Date.parse(payload.requestAt); const issued = Date.parse(authorization.issuedAt); const expires = Date.parse(authorization.expiresAt);
  if (!canonicalDate(payload.requestAt) || Math.abs(nowMs - requestAt) > 5_000 || !canonicalDate(authorization.issuedAt) ||
      !canonicalDate(authorization.expiresAt) || issued > nowMs || expires <= nowMs || expires - issued > G3B_CAPS.authorizationTtlMs ||
      Date.parse(parent.intent.expiresAt) <= nowMs) { diagnosticStage = 'PARENT_FRESHNESS'; return reject(); }
  if (authorization.accountVersion !== parent.accountVersion || authorization.g3aAuthorizationId !== g3a.authorizationId ||
      authorization.g3aAuthorizationNonce !== g3a.authorizationNonce ||
      authorization.unsignedTransactionHash.toLowerCase() !== operation.unsignedTransactionHash.toLowerCase() ||
      authorization.semanticDigest !== operation.semanticDigest ||
      authorization.simulationAttestationDigest !== attestationDigest(operation.simulation) ||
      authorization.feeAttestationDigest !== attestationDigest(operation.fee) ||
      authorization.riskAttestationDigest !== attestationDigest(operation.risk) ||
      authorization.allowanceAttestationDigest !== attestationDigest(operation.allowanceEvidence) ||
      authorization.quoteAttestationDigest !== (operation.quoteEvidence ? attestationDigest(operation.quoteEvidence) : null)) { diagnosticStage = 'CHILD_AUTH_BINDING'; return reject(); }
  if (operation.unsignedTransactionHash.toLowerCase() !== unsignedTransactionHash(operation.unsignedTransaction).toLowerCase() ||
      operation.semanticDigest !== semanticDigest(payload)) { diagnosticStage = 'CHILD_TRANSACTION_DIGEST'; return reject(); }
}
function validateEvidence(payload: G3bSignerPayload, nowMs: number): void {
  const operation = payload.operation;
  if (!operation.simulation || !operation.fee || !operation.risk || !operation.allowanceEvidence || !operation.authorization) return reject();
  const simulation = verifyAttestation(operation.simulation, nowMs);
  const fee = verifyAttestation(operation.fee, nowMs);
  const risk = verifyAttestation(operation.risk, nowMs);
  const allowance = verifyAttestation(operation.allowanceEvidence, nowMs);
  const quote = operation.quoteEvidence ? verifyAttestation(operation.quoteEvidence, nowMs) : null;
  const approvalReceipt = operation.approvalReceipt ? verifyAttestation(operation.approvalReceipt, nowMs) : null;
  const tx = operation.unsignedTransaction; const parent = payload.parent;
  if (simulation.kind !== 'SIMULATION' || simulation.outcome !== 'PASSED' || simulation.executionId !== operation.executionId ||
      simulation.operationId !== operation.operationId || simulation.semanticDigest !== operation.semanticDigest ||
      simulation.unsignedTransactionHash.toLowerCase() !== operation.unsignedTransactionHash.toLowerCase() ||
      simulation.chainId !== CHAIN_ID || simulation.poolAddress?.toLowerCase() !== (operation.kind === 'SWAP' ? POOL : undefined)) return reject();
  if (fee.kind !== 'BASE_FEE' || fee.executionId !== operation.executionId || fee.operationId !== operation.operationId ||
      fee.unsignedTransactionHash.toLowerCase() !== operation.unsignedTransactionHash.toLowerCase() ||
      fee.gasLimit !== tx.gasLimit || fee.maxFeePerGasWei !== tx.maxFeePerGasWei ||
      BigInt(fee.executionGasFeeCapWei) !== BigInt(fee.gasLimit) * BigInt(fee.maxFeePerGasWei) ||
      BigInt(fee.totalFeeWei) !== BigInt(fee.executionGasFeeCapWei) + BigInt(fee.l1DataFeeWei) + BigInt(fee.operatorFeeWei) ||
      fee.includesRevertPath !== true || BigInt(fee.totalFeeWei) > BigInt(parent.transaction.maxTotalFeeWei) ||
      BigInt(fee.valueUsdcMicros) > G3B_CAPS.networkFeeUsdcMicros) return reject();
  if (risk.kind !== 'SESSION_RISK') return reject();
  const projected = BigInt(risk.currentSessionLossUsdcMicros) + BigInt(risk.reservedSessionLossUsdcMicros) +
    BigInt(risk.worstCaseTradeLossUsdcMicros) + BigInt(risk.workflowFeeReserveUsdcMicros);
  if (risk.executionId !== operation.executionId || risk.operationId !== operation.operationId || risk.accountVersion !== parent.accountVersion ||
      risk.chainId !== CHAIN_ID || risk.blockNumber !== simulation.blockNumber || risk.blockHash !== simulation.blockHash ||
      BigInt(risk.walletValueUsdcMicros) > G3B_CAPS.walletValueUsdcMicros ||
      BigInt(risk.tradeValueUsdcMicros) !== BigInt(parent.reservationExposureUsdcMicros) || BigInt(risk.tradeValueUsdcMicros) > G3B_CAPS.tradeValueUsdcMicros ||
      BigInt(risk.wethPositionAfterUsdcMicros) > G3B_CAPS.wethPositionUsdcMicros ||
      risk.slippageBps > G3B_CAPS.slippageBps || risk.priceImpactBps > G3B_CAPS.priceImpactBps ||
      (quote && quote.kind === 'QUOTE' && (risk.slippageBps !== quote.slippageBps || risk.priceImpactBps !== quote.priceImpactBps)) ||
      BigInt(risk.workflowFeeReserveUsdcMicros) < BigInt(fee.valueUsdcMicros) ||
      projected !== BigInt(risk.projectedSessionLossUsdcMicros) || projected > G3B_CAPS.sessionLossUsdcMicros) return reject();
  if (allowance.kind !== 'ALLOWANCE' || allowance.executionId !== operation.executionId || allowance.operationId !== operation.operationId ||
      allowance.chainId !== CHAIN_ID || allowance.walletAddress.toLowerCase() !== parent.walletAddress.toLowerCase() ||
      allowance.token.toLowerCase() !== txTokenIn(payload).toLowerCase() || allowance.spender.toLowerCase() !== ROUTER || allowance.nextNonce !== tx.nonce ||
      (operation.kind === 'APPROVAL' ? allowance.allowanceAtomic !== '0' : allowance.allowanceAtomic !== parent.transaction.amountIn)) return reject();
  if (operation.kind === 'SWAP') {
    if (!quote || quote.kind !== 'QUOTE' || quote.executionId !== operation.executionId || quote.operationId !== operation.operationId ||
        quote.chainId !== CHAIN_ID || quote.poolAddress.toLowerCase() !== POOL || quote.tokenIn.toLowerCase() !== txTokenIn(payload).toLowerCase() ||
        quote.tokenOut.toLowerCase() !== txTokenOut(payload).toLowerCase() || quote.fee !== 500 || quote.amountIn !== parent.transaction.amountIn ||
        quote.slippageBps > G3B_CAPS.slippageBps || quote.priceImpactBps > G3B_CAPS.priceImpactBps ||
        quote.blockNumber !== simulation.blockNumber || quote.blockHash !== simulation.blockHash) return reject();
    if (approvalReceipt && (approvalReceipt.kind !== 'APPROVAL_RECEIPT' || approvalReceipt.outcome !== 'CONFIRMED' ||
        approvalReceipt.executionId !== operation.executionId || approvalReceipt.operationId === operation.operationId || approvalReceipt.chainId !== CHAIN_ID ||
        BigInt(allowance.blockNumber) <= BigInt(approvalReceipt.blockNumber) || Date.parse(quote.observedAt) < Date.parse(approvalReceipt.confirmedAt))) return reject();
  } else if (quote || approvalReceipt) return reject();
}
function txTokenIn(payload: G3bSignerPayload): string { return payload.parent.intent.sellAsset === 'USDC' ? USDC : WETH; }
function txTokenOut(payload: G3bSignerPayload): string { return payload.parent.intent.buyAsset === 'USDC' ? USDC : WETH; }
function validateCalldata(payload: G3bSignerPayload, nowMs: number): void {
  const parent = payload.parent; const op = payload.operation; const tx = g3bUnsignedTransactionSchema.parse(op.unsignedTransaction);
  if (tx.chainId !== CHAIN_ID || tx.from.toLowerCase() !== parent.walletAddress.toLowerCase() || tx.accessList.length !== 0 ||
      BigInt(tx.gasLimit) * BigInt(tx.maxFeePerGasWei) > BigInt(parent.transaction.maxTotalFeeWei) ||
      BigInt(tx.maxFeePerGasWei) > BigInt(parent.transaction.maxFeePerGasWei) ||
      BigInt(tx.maxPriorityFeePerGasWei) > BigInt(parent.transaction.maxPriorityFeePerGasWei)) return reject();
  if (op.kind === 'SWAP') {
    if (tx.to.toLowerCase() !== ROUTER || tx.valueWei !== parent.transaction.valueNativeWei ||
        tx.maxFeePerGasWei !== parent.transaction.maxFeePerGasWei || tx.maxPriorityFeePerGasWei !== parent.transaction.maxPriorityFeePerGasWei) return reject();
    const outer = decodeFunctionData({ abi: routerAbi, data: tx.data as Hex });
    if (outer.functionName !== 'multicall' || !outer.args || outer.args[1].length !== 1) return reject();
    const [deadline, calls] = outer.args;
    const inner = decodeFunctionData({ abi: routerAbi, data: calls[0]! });
    if (inner.functionName !== 'exactInputSingle') return reject();
    const args = inner.args[0];
    const canonicalInner = encodeFunctionData({ abi: routerAbi, functionName: 'exactInputSingle', args: [args] });
    const canonicalOuter = encodeFunctionData({ abi: routerAbi, functionName: 'multicall', args: [deadline, [canonicalInner]] });
    const quote = op.quoteEvidence?.payload;
    const expectedMinimum = quote?.kind === 'QUOTE' ? quote.minimumAmountOut : parent.transaction.minimumAmountOut;
    if (canonicalOuter.toLowerCase() !== tx.data.toLowerCase() || deadline !== BigInt(Math.floor(Date.parse(parent.intent.expiresAt) / 1000)) ||
        deadline * 1000n <= BigInt(nowMs) || getAddress(args.tokenIn).toLowerCase() !== txTokenIn(payload).toLowerCase() ||
        getAddress(args.tokenOut).toLowerCase() !== txTokenOut(payload).toLowerCase() || args.fee !== 500 ||
        getAddress(args.recipient).toLowerCase() !== parent.walletAddress.toLowerCase() || args.amountIn !== BigInt(parent.transaction.amountIn) ||
        args.amountOutMinimum !== BigInt(expectedMinimum) || args.sqrtPriceLimitX96 !== 0n) return reject();
    return;
  }
  if (tx.to.toLowerCase() !== txTokenIn(payload).toLowerCase() || tx.valueWei !== '0') return reject();
  const approval = decodeFunctionData({ abi: approveAbi, data: tx.data as Hex });
  if (approval.functionName !== 'approve' || !approval.args || getAddress(approval.args[0]).toLowerCase() !== ROUTER ||
      approval.args[1] !== BigInt(parent.transaction.amountIn) ||
      encodeFunctionData({ abi: approveAbi, functionName: 'approve', args: [ROUTER, approval.args[1]] }).toLowerCase() !== tx.data.toLowerCase()) return reject();
}
async function signRequest(value: unknown) {
  const payload = verifyMessage(value); const nowMs = Date.now();
  diagnosticStage = 'PARENT'; validateParentAndAuth(payload, nowMs);
  diagnosticStage = 'EVIDENCE'; validateEvidence(payload, nowMs);
  diagnosticStage = 'CALLDATA'; validateCalldata(payload, nowMs);
  diagnosticStage = 'SIGNER_KEY';
  const auth = payload.operation.authorization;
  if (!auth || consumedNonces.has(auth.operationNonce)) return reject();
  if (evidenceEnvironment !== 'synthetic-test' && evidenceEnvironment !== 'production') return reject();
  if (evidenceEnvironment === 'production' && process.env.LIVE_EXECUTION_ENABLED !== 'true') return reject();
  if (privateKey.length !== 66 || !/^0x[0-9a-f]{64}$/u.test(privateKey)) return reject();
  const account = privateKeyToAccount(privateKey as Hex);
  const tx = payload.operation.unsignedTransaction;
  if (account.address.toLowerCase() !== tx.from.toLowerCase()) return reject();
  const nonce = safeNonceNumber(tx.nonce);
  consumedNonces.add(auth.operationNonce);
  diagnosticStage = 'SIGNATURE';
  const signedBytes = await account.signTransaction({ type: 'eip1559', chainId: tx.chainId, nonce,
    gas: BigInt(tx.gasLimit), maxFeePerGas: BigInt(tx.maxFeePerGasWei), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGasWei),
    to: getAddress(tx.to), value: BigInt(tx.valueWei), data: tx.data as Hex, accessList: [] });
  diagnosticStage = 'VERIFY_SIGNED_TRANSACTION';
  if (!/^0x02[0-9a-fA-F]+$/u.test(signedBytes)) return reject();
  const serialized = signedBytes as TransactionSerialized;
  const decoded = parseTransaction(serialized);
  if (decoded.type !== 'eip1559') { diagnosticStage = 'SIGNED_TYPE'; return reject(); }
  if (decoded.chainId !== tx.chainId) { diagnosticStage = 'SIGNED_CHAIN'; return reject(); }
  if (decoded.nonce === undefined || !Number.isSafeInteger(decoded.nonce) || BigInt(decoded.nonce) !== BigInt(tx.nonce)) { diagnosticStage = 'SIGNED_NONCE'; return reject(); }
  if (decoded.gas !== BigInt(tx.gasLimit)) { diagnosticStage = 'SIGNED_GAS'; return reject(); }
  if (decoded.maxFeePerGas !== BigInt(tx.maxFeePerGasWei)) { diagnosticStage = 'SIGNED_MAX_FEE'; return reject(); }
  if (decoded.maxPriorityFeePerGas !== BigInt(tx.maxPriorityFeePerGasWei)) { diagnosticStage = 'SIGNED_PRIORITY_FEE'; return reject(); }
  if (decoded.to?.toLowerCase() !== tx.to.toLowerCase()) { diagnosticStage = 'SIGNED_TARGET'; return reject(); }
  if ((decoded.value ?? 0n) !== BigInt(tx.valueWei)) { diagnosticStage = 'SIGNED_VALUE'; return reject(); }
  if (decoded.data?.toLowerCase() !== tx.data.toLowerCase()) { diagnosticStage = 'SIGNED_CALLDATA'; return reject(); }
  if ((decoded.accessList?.length ?? 0) !== 0) { diagnosticStage = 'SIGNED_ACCESS_LIST'; return reject(); }
  diagnosticStage = 'RECOVER_SENDER';
  if ((await recoverTransactionAddress({ serializedTransaction: serialized })).toLowerCase() !== tx.from.toLowerCase()) return reject();
  return { ok: true, signedBytesHex: signedBytes.toLowerCase(), transactionHash: keccak256(serialized) };
}

if (messageSecret.length < 32 || !privateKey || !trustedKeys || typeof trustedKeys !== 'object') {
  process.exitCode = 1;
} else {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    if (line.length > 300_000) { process.stdout.write(JSON.stringify({ ok: false, code: 'SIGNER_REJECTED' }) + '\n'); return; }
    try {
      void signRequest(JSON.parse(line) as unknown).then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
        .catch(() => process.stdout.write(JSON.stringify({ ok: false, code: diagnosticStage }) + '\n'));
    } catch { process.stdout.write(JSON.stringify({ ok: false, code: 'SIGNER_REJECTED' }) + '\n'); }
  });
}

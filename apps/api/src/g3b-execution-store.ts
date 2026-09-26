import { createHash, randomUUID } from 'node:crypto';
import {
  executionLifecycleRecordSchema, executionSigningClaimSchema, g3bOperationAuthorizationSchema, g3bOperationSchema,
  type ExecutionLifecycleRecord, type G3bEvidenceAttestation, type G3bEvidencePayload, type G3bOperation,
  type G3bOperationKind, type G3bUnsignedTransaction,
} from '@ered-luin/contracts';
import { assertExecutionLifecycleRecord } from './execution-lifecycle-validation.js';
import { assertNoG3cLifecycleOwner, ExecutionStore } from './execution-store.js';
import { PaperStoreError } from './paper-store.js';
import { assertFreshG3bEvidence, canonicalEvidenceDigest, verifyG3bEvidenceAttestation, type G3bEvidenceTrust } from './g3b-evidence.js';
import { assertG3bOperationTransaction, assertStoredG3bOperation, decodeExactSwap, g3bSemanticDigest, g3bUnsignedTransactionHash, validateSignedG3bTransaction } from './g3b-transaction.js';

type SqlRow = Record<string, unknown>;
type Db = import('node:sqlite').DatabaseSync;
export interface PrepareG3bOperationInput {
  readonly executionId: string; readonly operationId: string; readonly kind: G3bOperationKind;
  readonly unsignedTransaction: G3bUnsignedTransaction; readonly allowanceEvidence: G3bEvidenceAttestation;
  readonly quoteEvidence?: G3bEvidenceAttestation | null; readonly approvalReceipt?: G3bEvidenceAttestation | null;
  readonly reason: string;
}
export interface G3bOperationWriteResult { readonly operation: G3bOperation; readonly replayed: boolean; }
export interface G3bSigningClaim { readonly parent: ExecutionLifecycleRecord; readonly operation: G3bOperation; }
export interface G3bOutboxRelease { readonly operation: G3bOperation; readonly transactionHash: string; readonly signedBytesHex: string; readonly attempt: number; readonly replayed: boolean; }
class G3bExecutionError extends PaperStoreError {
  readonly reason: string;
  constructor(reason: string) { super('EXECUTION_STATE_INVALID'); this.name = 'G3bExecutionError'; this.reason = reason; }
}
function fail(code: string): never { throw new G3bExecutionError(code); }
function canonicalDate(value: unknown): value is string {
  if (typeof value !== 'string') return false; const ms = Date.parse(value);
  return Number.isSafeInteger(ms) && new Date(ms).toISOString() === value;
}
function nowFrom(clock: () => Date): Date {
  try { const now = clock(); if (now instanceof Date && Number.isSafeInteger(now.getTime())) return now; } catch { /* fail closed */ }
  return fail('DATABASE_FAILURE');
}
function recordEvent(db: Db, executionId: string, eventType: string, reason: string, evidence: unknown, at: string): void {
  const encoded = JSON.stringify(evidence);
  if (reason.trim().length === 0 || reason.length > 240 || encoded.length > 131_072) fail('G3B_INVALID_EVENT');
  db.prepare('INSERT INTO execution_events (event_id,execution_id,event_type,reason,evidence_json,created_at) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), executionId, eventType, reason, encoded, at);
}
function readParent(db: Db, executionId: string): ExecutionLifecycleRecord {
  const row = db.prepare('SELECT * FROM execution_lifecycle WHERE execution_id = ?').get(executionId) as SqlRow | undefined;
  if (!row) return fail('EXECUTION_NOT_FOUND');
  let parsed: unknown; try { parsed = JSON.parse(String(row.record_json)); } catch { return fail('DATABASE_CORRUPT'); }
  const checked = executionLifecycleRecordSchema.safeParse(parsed);
  if (!checked.success || checked.data.executionId !== row.execution_id || checked.data.intentId !== row.intent_id ||
      checked.data.walletAddress.toLowerCase() !== String(row.wallet_address).toLowerCase() || checked.data.reservationId !== row.reservation_id ||
      checked.data.status !== row.status || checked.data.revision !== row.revision || checked.data.createdAt !== row.created_at || checked.data.updatedAt !== row.updated_at) return fail('DATABASE_CORRUPT');
  try { assertExecutionLifecycleRecord(checked.data); } catch { return fail('DATABASE_CORRUPT'); }
  return checked.data;
}
function readOperation(db: Db, operationId: string): G3bOperation {
  const row = db.prepare('SELECT * FROM execution_g3b_operations WHERE operation_id = ?').get(operationId) as SqlRow | undefined;
  if (!row) return fail('G3B_OPERATION_NOT_FOUND');
  assertNoG3cLifecycleOwner(db, String(row.execution_id));
  let parsed: unknown; try { parsed = JSON.parse(String(row.record_json)); } catch { return fail('DATABASE_CORRUPT'); }
  const checked = g3bOperationSchema.safeParse(parsed);
  if (!checked.success || checked.data.operationId !== row.operation_id || checked.data.executionId !== row.execution_id || checked.data.status !== row.status ||
      checked.data.createdAt !== row.created_at || checked.data.updatedAt !== row.updated_at || checked.data.revision !== row.revision) return fail('DATABASE_CORRUPT');
  try { assertStoredG3bOperation(checked.data); } catch { return fail('DATABASE_CORRUPT'); }
  return checked.data;
}
function writeOperation(db: Db, operation: G3bOperation): void {
  try { assertStoredG3bOperation(operation); } catch { return fail('G3B_OPERATION_INVALID'); }
  const result = db.prepare('UPDATE execution_g3b_operations SET status = ?, record_json = ?, updated_at = ?, revision = ? WHERE operation_id = ?')
    .run(operation.status, JSON.stringify(operation), operation.updatedAt, operation.revision, operation.operationId);
  if (result.changes !== 1) fail('DATABASE_CORRUPT');
}
function nextOperation(operation: G3bOperation, patch: Partial<G3bOperation>, at: string): G3bOperation {
  return g3bOperationSchema.parse({ ...operation, ...patch, updatedAt: at, revision: operation.revision + 1 });
}
function evidencePayload(value: unknown, trust: G3bEvidenceTrust, nowMs: number): G3bEvidencePayload {
  const attestation = verifyG3bEvidenceAttestation(value, trust); assertFreshG3bEvidence(attestation, nowMs); return attestation.payload;
}
function assertReason(reason: string): void { if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 240) fail('G3B_INVALID_REASON'); }
function assertParentRunnable(parent: ExecutionLifecycleRecord, nowMs: number): void {
  if (!['AUTHORIZED', 'SIGNING_CLAIMED'].includes(parent.status) || !parent.authorization || Date.parse(parent.intent.expiresAt) <= nowMs) fail('G3B_PARENT_NOT_RUNNABLE');
}
function assertQuote(payload: G3bEvidencePayload, input: PrepareG3bOperationInput, parent: ExecutionLifecycleRecord): void {
  if (input.kind !== 'SWAP' || payload.kind !== 'QUOTE' || payload.executionId !== input.executionId || payload.operationId !== input.operationId ||
      payload.chainId !== 8453 || payload.poolAddress.toLowerCase() !== '0xd0b53d9277642d899df5c87a3966a349a798f224' ||
      payload.tokenIn.toLowerCase() !== (parent.intent.sellAsset === 'USDC' ? '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' : '0x4200000000000000000000000000000000000006') ||
      payload.tokenOut.toLowerCase() !== (parent.intent.buyAsset === 'USDC' ? '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' : '0x4200000000000000000000000000000000000006') ||
      payload.fee !== 500 || payload.amountIn !== parent.transaction.amountIn || payload.slippageBps > 50 || payload.priceImpactBps > 50) fail('G3B_QUOTE_INVALID');
  const call = decodeExactSwap(input.unsignedTransaction.data as `0x${string}`);
  if (call.amountOutMinimum !== BigInt(payload.minimumAmountOut) || call.amountIn !== BigInt(payload.amountIn)) fail('G3B_QUOTE_CALL_MISMATCH');
}
function assertAllowance(payload: G3bEvidencePayload, input: PrepareG3bOperationInput, parent: ExecutionLifecycleRecord): void {
  const token = parent.intent.sellAsset === 'USDC' ? '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' : '0x4200000000000000000000000000000000000006';
  const expected = input.kind === 'APPROVAL' ? '0' : parent.transaction.amountIn;
  if (payload.kind !== 'ALLOWANCE' || payload.executionId !== input.executionId || payload.operationId !== input.operationId || payload.chainId !== 8453 ||
      payload.walletAddress.toLowerCase() !== parent.walletAddress.toLowerCase() || payload.token.toLowerCase() !== token ||
      payload.spender.toLowerCase() !== '0x2626664c2603336e57b271c5c0b26f421741e481' || payload.allowanceAtomic !== expected ||
      payload.nextNonce !== input.unsignedTransaction.nonce) fail('G3B_ALLOWANCE_UNEXPECTED');
}
function assertApprovalReceipt(db: Db, payload: G3bEvidencePayload | null, current: PrepareG3bOperationInput, nowMs: number): void {
  if (current.kind !== 'SWAP') { if (payload) fail('G3B_APPROVAL_RECEIPT_UNEXPECTED'); return; }
  if (!payload) {
    const prior = db.prepare("SELECT COUNT(*) AS count FROM execution_g3b_operations WHERE execution_id = ? AND json_extract(record_json, '$.kind') = 'APPROVAL'").get(current.executionId) as SqlRow;
    if (Number(prior.count) > 0) fail('G3B_APPROVAL_NOT_CONFIRMED');
    return;
  }
  if (payload.kind !== 'APPROVAL_RECEIPT' || payload.executionId !== current.executionId || payload.chainId !== 8453 ||
      payload.outcome !== 'CONFIRMED' || !canonicalDate(payload.confirmedAt) || Date.parse(payload.confirmedAt) > nowMs) fail('G3B_APPROVAL_RECEIPT_INVALID');
  const approval = readOperation(db, payload.operationId);
  if (approval.kind !== 'APPROVAL' || approval.status !== 'CONFIRMED' || approval.transactionHash?.toLowerCase() !== payload.transactionHash.toLowerCase() ||
      approval.executionId !== current.executionId) fail('G3B_APPROVAL_RECEIPT_MISMATCH');
}
function assertFreshOperation(operation: G3bOperation, parent: ExecutionLifecycleRecord, nowMs: number): void {
  const auth = operation.authorization;
  if (!auth) fail('G3B_AUTHORIZATION_MISSING');
  const issued = Date.parse(auth.issuedAt); const expires = Date.parse(auth.expiresAt);
  if (!canonicalDate(auth.issuedAt) || !canonicalDate(auth.expiresAt) || issued > nowMs || expires <= nowMs || expires - issued > 15_000 ||
      Date.parse(parent.intent.expiresAt) <= nowMs || auth.accountVersion !== parent.accountVersion || auth.executionId !== parent.executionId ||
      auth.operationId !== operation.operationId || auth.g3aAuthorizationId !== parent.authorization?.authorizationId ||
      auth.g3aAuthorizationNonce !== parent.authorization?.authorizationNonce || auth.unsignedTransactionHash.toLowerCase() !== operation.unsignedTransactionHash.toLowerCase() ||
      auth.semanticDigest !== operation.semanticDigest) fail('G3B_AUTHORIZATION_EXPIRED');
}
function assertG3aClaimFresh(parent: ExecutionLifecycleRecord, nowMs: number): void {
  const auth = parent.authorization; const simulation = parent.simulation;
  if (!auth || !simulation || simulation.producerId !== 'synthetic-test-adapter' || simulation.outcome !== 'PASSED' ||
      simulation.executionId !== parent.executionId || simulation.transactionDigest !== parent.transactionDigest ||
      !canonicalDate(simulation.simulatedAt) || !canonicalDate(simulation.expiresAt) || Date.parse(simulation.simulatedAt) > nowMs ||
      Date.parse(simulation.expiresAt) <= nowMs || nowMs - Date.parse(simulation.simulatedAt) > 15_000 ||
      !canonicalDate(auth.issuedAt) || !canonicalDate(auth.expiresAt) || Date.parse(auth.issuedAt) > nowMs || Date.parse(auth.expiresAt) <= nowMs ||
      Date.parse(auth.expiresAt) > Date.parse(parent.transaction.expiresAt) || auth.transactionDigest !== parent.transactionDigest ||
      auth.accountVersion !== parent.accountVersion || auth.simulationId !== simulation.simulationId) fail('G3A_AUTHORIZATION_EXPIRED');
}
type G3bRiskPayload = Extract<G3bEvidencePayload, { readonly kind: 'SESSION_RISK' }>;
function assertRisk(payload: G3bRiskPayload, parent: ExecutionLifecycleRecord, operation: G3bOperation, fee: G3bEvidencePayload | null): void {
  if (payload.kind !== 'SESSION_RISK' || payload.executionId !== parent.executionId || payload.operationId !== operation.operationId ||
      payload.accountVersion !== parent.accountVersion || payload.chainId !== 8453 || BigInt(payload.walletValueUsdcMicros) > 25_000_000n ||
      BigInt(payload.tradeValueUsdcMicros) !== BigInt(parent.reservationExposureUsdcMicros) || BigInt(payload.tradeValueUsdcMicros) > 5_000_000n ||
      BigInt(payload.wethPositionAfterUsdcMicros) > 10_000_000n || payload.slippageBps > 50 || payload.priceImpactBps > 50) fail('G3B_RISK_CAP_EXCEEDED');
  const projected = BigInt(payload.currentSessionLossUsdcMicros) + BigInt(payload.reservedSessionLossUsdcMicros) +
    BigInt(payload.worstCaseTradeLossUsdcMicros) + BigInt(payload.workflowFeeReserveUsdcMicros);
  if (projected !== BigInt(payload.projectedSessionLossUsdcMicros) || projected > 2_000_000n) fail('G3B_SESSION_LOSS_CAP_EXCEEDED');
  if (fee?.kind !== 'BASE_FEE' || BigInt(fee.valueUsdcMicros) > 250_000n || BigInt(payload.workflowFeeReserveUsdcMicros) < BigInt(fee.valueUsdcMicros)) fail('G3B_FEE_RESERVE_MISSING');
  if (operation.quoteEvidence?.payload.kind === 'QUOTE' &&
      (payload.slippageBps !== operation.quoteEvidence.payload.slippageBps || payload.priceImpactBps !== operation.quoteEvidence.payload.priceImpactBps ||
       payload.blockNumber !== operation.quoteEvidence.payload.blockNumber || payload.blockHash !== operation.quoteEvidence.payload.blockHash)) fail('G3B_RISK_QUOTE_MISMATCH');
}

export class G3bExecutionStore {
  constructor(private readonly execution: ExecutionStore, private readonly trust: G3bEvidenceTrust) {}
  get(operationId: string): G3bOperation { return this.execution.g3bRead((db) => readOperation(db, operationId)); }
  listReconciliationQueue(): readonly G3bOperation[] {
    return this.execution.g3bRead((db) => {
      const rows = db.prepare("SELECT operation_id FROM execution_g3b_operations WHERE status IN ('SIGNING_CLAIMED','SIGNED_OUTBOX','SUBMISSION_UNCERTAIN','SUBMITTED') ORDER BY created_at,operation_id").all() as SqlRow[];
      return Object.freeze(rows.map((row) => readOperation(db, String(row.operation_id))));
    });
  }

  prepareOperation(input: PrepareG3bOperationInput): G3bOperationWriteResult {
    assertReason(input.reason);
    return this.execution.g3bTransaction((db, clock) => {
      assertNoG3cLifecycleOwner(db, input.executionId);
      const nowDate = nowFrom(clock); const nowMs = nowDate.getTime(); const now = nowDate.toISOString();
      if (!/^[0-9a-f-]{36}$/iu.test(input.operationId)) fail('G3B_INVALID_OPERATION_ID');
      const parent = readParent(db, input.executionId);
      assertParentRunnable(parent, nowMs);
      if (!['AUTHORIZED','SIGNING_CLAIMED'].includes(parent.status) || !parent.authorization || Date.parse(parent.intent.expiresAt) <= nowMs) fail('G3B_PARENT_NOT_RUNNABLE');
      const prior = db.prepare('SELECT operation_id FROM execution_g3b_operations WHERE operation_id = ?').get(input.operationId) as SqlRow | undefined;
      const digest = g3bSemanticDigest({ executionId: input.executionId, operationId: input.operationId, kind: input.kind, transaction: input.unsignedTransaction });
      const txHash = g3bUnsignedTransactionHash(input.unsignedTransaction);
      if (prior) {
        const existing = readOperation(db, input.operationId);
        if (existing.executionId !== input.executionId || existing.kind !== input.kind || existing.semanticDigest !== digest || existing.unsignedTransactionHash.toLowerCase() !== txHash.toLowerCase()) fail('G3B_OPERATION_ID_CONFLICT');
        return { operation: existing, replayed: true };
      }
      const unresolved = db.prepare("SELECT COUNT(*) AS count FROM execution_g3b_operations WHERE execution_id = ? AND status NOT IN ('CONFIRMED','FAILED')").get(input.executionId) as SqlRow;
      const hasSwap = db.prepare("SELECT COUNT(*) AS count FROM execution_g3b_operations WHERE execution_id = ? AND json_extract(record_json, '$.kind') = 'SWAP'").get(input.executionId) as SqlRow;
      if (Number(unresolved.count) !== 0 || Number(hasSwap.count) !== 0) fail('G3B_OPERATION_ALREADY_PENDING');
      const allowance = evidencePayload(input.allowanceEvidence, this.trust, nowMs); assertAllowance(allowance, input, parent);
      const quote = input.quoteEvidence ? evidencePayload(input.quoteEvidence, this.trust, nowMs) : null;
      if (input.kind === 'SWAP') { if (!quote) fail('G3B_QUOTE_REQUIRED'); assertQuote(quote, input, parent); }
      else if (quote) fail('G3B_QUOTE_UNEXPECTED');
      const receipt = input.approvalReceipt ? verifyG3bEvidenceAttestation(input.approvalReceipt, this.trust).payload : null;
      assertApprovalReceipt(db, receipt, input, nowMs);
      if (receipt?.kind === 'APPROVAL_RECEIPT' && quote?.kind === 'QUOTE' &&
          (Date.parse(quote.observedAt) < Date.parse(receipt.confirmedAt) || BigInt(quote.blockNumber) <= BigInt(receipt.blockNumber) ||
           BigInt(allowance.kind === 'ALLOWANCE' ? allowance.blockNumber : '0') <= BigInt(receipt.blockNumber))) fail('G3B_REFRESH_MUST_FOLLOW_APPROVAL');
      assertG3bOperationTransaction(parent, input.kind, input.unsignedTransaction, nowMs, input.quoteEvidence ?? undefined, this.trust, input.allowanceEvidence);
      const operation = g3bOperationSchema.parse({ version: 1, executionId: input.executionId, operationId: input.operationId, kind: input.kind,
        status: 'PREPARED', semanticDigest: digest, unsignedTransactionHash: txHash, unsignedTransaction: input.unsignedTransaction,
        simulation: null, fee: null, risk: null, quoteEvidence: input.quoteEvidence ?? null, allowanceEvidence: input.allowanceEvidence,
        approvalReceipt: input.approvalReceipt ?? null, receipt: null, authorization: null, signingClaimId: null, signedBytesHex: null,
        signedBytesDigest: null, transactionHash: null, broadcastAttempts: 0, failureReason: null, createdAt: now, updatedAt: now, revision: 1 });
      assertStoredG3bOperation(operation);
      db.prepare('INSERT INTO execution_g3b_operations (operation_id,execution_id,status,record_json,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?)')
        .run(operation.operationId, operation.executionId, operation.status, JSON.stringify(operation), now, now, operation.revision);
      recordEvent(db, input.executionId, 'G3B_OPERATION_PREPARED', input.reason, { operationId: input.operationId, kind: input.kind, semanticDigest: digest, unsignedTransactionHash: txHash }, now);
      return { operation, replayed: false };
    });
  }

  recordSimulation(operationId: string, attestation: G3bEvidenceAttestation, reason: string): G3bOperationWriteResult {
    assertReason(reason);
    return this.execution.g3bTransaction((db, clock) => {
      const nowDate = nowFrom(clock); const nowMs = nowDate.getTime(); const now = nowDate.toISOString();
      const current = readOperation(db, operationId); const payload = evidencePayload(attestation, this.trust, nowMs);
      if (current.simulation) return { operation: current.simulation.signature === attestation.signature ? current : fail('G3B_SIMULATION_CONFLICT'), replayed: true };
      if (current.status !== 'PREPARED' || payload.kind !== 'SIMULATION' || payload.outcome !== 'PASSED' || payload.executionId !== current.executionId ||
          payload.operationId !== operationId || payload.semanticDigest !== current.semanticDigest || payload.unsignedTransactionHash.toLowerCase() !== current.unsignedTransactionHash.toLowerCase() ||
          payload.chainId !== 8453 || (current.kind === 'SWAP' ? payload.poolAddress?.toLowerCase() !== '0xd0b53d9277642d899df5c87a3966a349a798f224' : payload.poolAddress !== null)) fail('G3B_SIMULATION_INVALID');
      const quoteState = current.quoteEvidence?.payload;
      const allowanceState = current.allowanceEvidence?.payload;
      if (quoteState?.kind === 'QUOTE' && (payload.blockNumber !== quoteState.blockNumber || payload.blockHash !== quoteState.blockHash)) fail('G3B_SIMULATION_STATE_MISMATCH');
      if (allowanceState?.kind === 'ALLOWANCE' && (payload.blockNumber !== allowanceState.blockNumber || payload.blockHash !== allowanceState.blockHash)) fail('G3B_SIMULATION_STATE_MISMATCH');
      if (current.approvalReceipt?.payload.kind === 'APPROVAL_RECEIPT' && BigInt(payload.blockNumber) <= BigInt(current.approvalReceipt.payload.blockNumber)) fail('G3B_SIMULATION_BEFORE_APPROVAL');
      const next = nextOperation(current, { status: 'SIMULATED', simulation: attestation }, now); writeOperation(db, next);
      recordEvent(db, current.executionId, 'G3B_SIMULATION_ACCEPTED', reason, { operationId, unsignedTransactionHash: current.unsignedTransactionHash }, now);
      return { operation: next, replayed: false };
    });
  }

  recordFee(operationId: string, attestation: G3bEvidenceAttestation, reason: string): G3bOperationWriteResult {
    assertReason(reason);
    return this.execution.g3bTransaction((db, clock) => {
      const nowDate = nowFrom(clock); const nowMs = nowDate.getTime(); const now = nowDate.toISOString();
      const current = readOperation(db, operationId); const parent = readParent(db, current.executionId); const payload = evidencePayload(attestation, this.trust, nowMs);
      if (current.fee) return { operation: current.fee.signature === attestation.signature ? current : fail('G3B_FEE_CONFLICT'), replayed: true };
      if (current.status !== 'SIMULATED' || payload.kind !== 'BASE_FEE' || payload.executionId !== current.executionId || payload.operationId !== operationId ||
          payload.unsignedTransactionHash.toLowerCase() !== current.unsignedTransactionHash.toLowerCase() || payload.gasLimit !== current.unsignedTransaction.gasLimit ||
          payload.maxFeePerGasWei !== current.unsignedTransaction.maxFeePerGasWei || BigInt(payload.executionGasFeeCapWei) !== BigInt(payload.gasLimit) * BigInt(payload.maxFeePerGasWei) ||
          BigInt(payload.totalFeeWei) !== BigInt(payload.executionGasFeeCapWei) + BigInt(payload.l1DataFeeWei) + BigInt(payload.operatorFeeWei) ||
          payload.includesRevertPath !== true || BigInt(payload.totalFeeWei) > BigInt(parent.transaction.maxTotalFeeWei) || BigInt(payload.valueUsdcMicros) > 250_000n) fail('G3B_FEE_INVALID');
      const next = nextOperation(current, { fee: attestation }, now); writeOperation(db, next);
      recordEvent(db, current.executionId, 'G3B_FEE_ACCEPTED', reason, { operationId, totalFeeWei: payload.totalFeeWei, valueUsdcMicros: payload.valueUsdcMicros }, now);
      return { operation: next, replayed: false };
    });
  }

  recordRisk(operationId: string, attestation: G3bEvidenceAttestation, reason: string): G3bOperationWriteResult {
    assertReason(reason);
    return this.execution.g3bTransaction((db, clock) => {
      const nowDate = nowFrom(clock); const nowMs = nowDate.getTime(); const now = nowDate.toISOString();
      const current = readOperation(db, operationId); const parent = readParent(db, current.executionId); const payload = evidencePayload(attestation, this.trust, nowMs);
      if (current.risk) return { operation: current.risk.signature === attestation.signature ? current : fail('G3B_RISK_CONFLICT'), replayed: true };
      if (current.status !== 'SIMULATED' || !current.fee) fail('G3B_RISK_PREREQUISITE_MISSING');
      if (payload.kind !== 'SESSION_RISK') fail('G3B_RISK_INVALID');
      assertRisk(payload, parent, current, current.fee.payload);
      if (current.simulation?.payload.kind !== 'SIMULATION' || payload.blockNumber !== current.simulation.payload.blockNumber || payload.blockHash !== current.simulation.payload.blockHash) fail('G3B_RISK_STATE_MISMATCH');
      const next = nextOperation(current, { risk: attestation }, now); writeOperation(db, next);
      recordEvent(db, current.executionId, 'G3B_RISK_ACCEPTED', reason, { operationId, projectedSessionLossUsdcMicros: payload.projectedSessionLossUsdcMicros }, now);
      return { operation: next, replayed: false };
    });
  }

  authorize(operationId: string, reason: string): G3bOperationWriteResult {
    assertReason(reason);
    return this.execution.g3bTransaction((db, clock) => {
      const nowDate = nowFrom(clock); const nowMs = nowDate.getTime(); const now = nowDate.toISOString();
      const current = readOperation(db, operationId); const parent = readParent(db, current.executionId);
      if (current.status === 'AUTHORIZED' && current.authorization) { assertFreshOperation(current, parent, nowMs); return { operation: current, replayed: true }; }
      const control = db.prepare('SELECT stopped FROM execution_control WHERE singleton = 1').get() as SqlRow | undefined;
      if (control?.stopped !== 0) fail('KILL_SWITCH_STOPPED');
      if (current.status !== 'SIMULATED' || !current.simulation || !current.fee || !current.risk || !current.allowanceEvidence ||
          (current.kind === 'SWAP' && !current.quoteEvidence) || !parent.authorization || !['AUTHORIZED','SIGNING_CLAIMED'].includes(parent.status)) fail('G3B_AUTHORIZATION_PREREQUISITE_MISSING');
      for (const evidence of [current.simulation, current.fee, current.risk, current.allowanceEvidence, current.quoteEvidence].filter(Boolean)) {
        const checked = verifyG3bEvidenceAttestation(evidence, this.trust); assertFreshG3bEvidence(checked, nowMs);
      }
      if (current.approvalReceipt) verifyG3bEvidenceAttestation(current.approvalReceipt, this.trust);
      if (parent.status === 'AUTHORIZED') assertG3aClaimFresh(parent, nowMs);
      const expiries = [current.simulation, current.fee, current.risk, current.allowanceEvidence, current.quoteEvidence]
        .filter((value): value is G3bEvidenceAttestation => value !== null).map((value) => Date.parse(value.payload.kind === 'APPROVAL_RECEIPT' ? value.payload.confirmedAt : value.payload.expiresAt));
      const expiry = Math.min(nowMs + 15_000, Date.parse(parent.intent.expiresAt), ...expiries,
        parent.status === 'AUTHORIZED' ? Date.parse(parent.authorization.expiresAt) : Number.POSITIVE_INFINITY);
      if (expiry <= nowMs) fail('G3B_AUTHORIZATION_EXPIRED');
      const authorization = g3bOperationAuthorizationSchema.parse({
        version: 1, authorizationId: randomUUID(), executionId: current.executionId, operationId: current.operationId,
        g3aAuthorizationId: parent.authorization.authorizationId, g3aAuthorizationNonce: parent.authorization.authorizationNonce,
        accountVersion: parent.accountVersion, semanticDigest: current.semanticDigest, unsignedTransactionHash: current.unsignedTransactionHash,
        operationNonce: randomUUID(), simulationAttestationDigest: canonicalEvidenceDigest(current.simulation),
        feeAttestationDigest: canonicalEvidenceDigest(current.fee), riskAttestationDigest: canonicalEvidenceDigest(current.risk),
        allowanceAttestationDigest: canonicalEvidenceDigest(current.allowanceEvidence),
        quoteAttestationDigest: current.quoteEvidence ? canonicalEvidenceDigest(current.quoteEvidence) : null,
        issuedAt: now, expiresAt: new Date(expiry).toISOString(),
      });
      const next = nextOperation(current, { status: 'AUTHORIZED', authorization }, now); writeOperation(db, next);
      recordEvent(db, current.executionId, 'G3B_AUTHORIZATION_ISSUED', reason, { operationId, authorizationId: authorization.authorizationId,
        unsignedTransactionHash: current.unsignedTransactionHash, expiresAt: authorization.expiresAt }, now);
      return { operation: next, replayed: false };
    });
  }

  claimForSigning(operationId: string, accountVersion: number, reason: string): G3bSigningClaim {
    assertReason(reason);
    return this.execution.g3bTransaction((db, clock) => {
      const nowDate = nowFrom(clock); const nowMs = nowDate.getTime(); const now = nowDate.toISOString();
      const current = readOperation(db, operationId); const parent = readParent(db, current.executionId);
      const control = db.prepare('SELECT stopped FROM execution_control WHERE singleton = 1').get() as SqlRow | undefined;
      if (control?.stopped !== 0) fail('KILL_SWITCH_STOPPED');
      if (!Number.isSafeInteger(accountVersion) || accountVersion !== parent.accountVersion || current.authorization?.accountVersion !== accountVersion) fail('ACCOUNT_VERSION_STALE');
      if (current.status !== 'AUTHORIZED' || !current.authorization || !['AUTHORIZED','SIGNING_CLAIMED'].includes(parent.status)) fail('G3B_OPERATION_STATE_INVALID');
      assertFreshOperation(current, parent, nowMs);
      for (const evidence of [current.simulation, current.fee, current.risk, current.allowanceEvidence, current.quoteEvidence].filter(Boolean)) {
        const checked = verifyG3bEvidenceAttestation(evidence, this.trust); assertFreshG3bEvidence(checked, nowMs);
      }
      if (current.approvalReceipt) verifyG3bEvidenceAttestation(current.approvalReceipt, this.trust);
      let nextParent = parent;
      if (parent.status === 'AUTHORIZED') {
        if (parent.signingClaim) fail('AUTHORIZATION_NONCE_REPLAYED');
        assertG3aClaimFresh(parent, nowMs);
        const claim = executionSigningClaimSchema.parse({ version: 1, claimId: randomUUID(),
          authorizationNonce: parent.authorization!.authorizationNonce, accountVersion: parent.accountVersion, claimedAt: now });
        nextParent = executionLifecycleRecordSchema.parse({ ...parent, status: 'SIGNING_CLAIMED', signingClaim: claim, updatedAt: now, revision: parent.revision + 1 });
        assertExecutionLifecycleRecord(nextParent);
        const updated = db.prepare('UPDATE execution_lifecycle SET status = ?, record_json = ?, updated_at = ?, revision = ? WHERE execution_id = ? AND status = ?')
          .run(nextParent.status, JSON.stringify(nextParent), nextParent.updatedAt, nextParent.revision, nextParent.executionId, parent.status);
        if (updated.changes !== 1) fail('DATABASE_FAILURE');
        recordEvent(db, parent.executionId, 'SIGNING_CLAIMED', reason, { claimId: claim.claimId, authorizationNonce: claim.authorizationNonce,
          transactionDigest: parent.transactionDigest }, now);
      } else if (!parent.signingClaim || parent.signingClaim.accountVersion !== parent.accountVersion ||
          parent.signingClaim.authorizationNonce !== parent.authorization?.authorizationNonce) fail('G3B_PARENT_CLAIM_INVALID');
      const claimed = nextOperation(current, { status: 'SIGNING_CLAIMED', signingClaimId: nextParent.signingClaim!.claimId }, now);
      writeOperation(db, claimed);
      recordEvent(db, current.executionId, 'G3B_SIGNING_CLAIMED', reason, { operationId, claimId: claimed.signingClaimId,
        operationNonce: current.authorization.operationNonce }, now);
      return { parent: nextParent, operation: claimed };
    });
  }

  async persistSigned(operationId: string, signedBytesHex: string, transactionHash: string, reason: string): Promise<G3bOperationWriteResult> {
    assertReason(reason);
    const prepared = this.get(operationId);
    if (prepared.status !== 'SIGNING_CLAIMED' || typeof signedBytesHex !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/u.test(signedBytesHex) ||
        typeof transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/u.test(transactionHash)) fail('G3B_SIGNING_CLAIM_MISSING');
    const normalizedBytes = signedBytesHex.toLowerCase();
    const decoded = await validateSignedG3bTransaction(normalizedBytes as `0x${string}`, prepared.unsignedTransaction);
    if (decoded.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) fail('G3B_SIGNED_HASH_MISMATCH');
    return this.execution.g3bTransaction((db, clock) => {
      const nowDate = nowFrom(clock); const nowMs = nowDate.getTime(); const now = nowDate.toISOString();
      const operation = readOperation(db, operationId); const parent = readParent(db, operation.executionId);
      if (operation.status !== 'SIGNING_CLAIMED' || !operation.authorization || !parent.signingClaim || operation.signingClaimId !== parent.signingClaim.claimId) fail('G3B_SIGNING_CLAIM_MISSING');
      assertFreshOperation(operation, parent, nowMs);
      const digest = createHash('sha256').update(Buffer.from(normalizedBytes.slice(2), 'hex')).digest('hex');
      const next = nextOperation(operation, { status: 'SIGNED_OUTBOX', signedBytesHex: normalizedBytes, signedBytesDigest: digest,
        transactionHash: decoded.transactionHash.toLowerCase(), broadcastAttempts: 0 }, now);
      writeOperation(db, next);
      recordEvent(db, operation.executionId, 'G3B_SIGNED_BYTES_PERSISTED', reason, { operationId, transactionHash: next.transactionHash,
        signedBytesDigest: digest, semanticDigest: operation.semanticDigest }, now);
      return { operation: next, replayed: false };
    });
  }

  prepareBroadcast(operationId: string, reason: string): G3bOutboxRelease {
    assertReason(reason);
    return this.execution.g3bTransaction((db, clock) => {
      const nowDate = nowFrom(clock); const now = nowDate.toISOString(); const operation = readOperation(db, operationId);
      if (!operation.signedBytesHex || !operation.transactionHash || !['SIGNED_OUTBOX','SUBMISSION_UNCERTAIN'].includes(operation.status)) fail('G3B_OUTBOX_NOT_READY');
      const control = db.prepare('SELECT stopped FROM execution_control WHERE singleton = 1').get() as SqlRow | undefined;
      if (operation.status === 'SIGNED_OUTBOX' && control?.stopped !== 0) fail('KILL_SWITCH_STOPPED');
      const attempt = operation.broadcastAttempts + 1;
      const next = nextOperation(operation, { status: 'SUBMISSION_UNCERTAIN', broadcastAttempts: attempt }, now); writeOperation(db, next);
      recordEvent(db, operation.executionId, 'G3B_BROADCAST_BYTES_RELEASED', reason, { operationId, attempt, transactionHash: operation.transactionHash,
        signedBytesDigest: operation.signedBytesDigest }, now);
      return { operation: next, transactionHash: operation.transactionHash, signedBytesHex: operation.signedBytesHex, attempt, replayed: attempt > 1 };
    });
  }

  recordSubmissionAccepted(operationId: string, transactionHash: string, acceptedAt: string, reason: string): G3bOperationWriteResult {
    assertReason(reason);
    return this.execution.g3bTransaction((db, clock) => {
      const nowDate = nowFrom(clock); const now = nowDate.toISOString(); const operation = readOperation(db, operationId);
      if (operation.transactionHash?.toLowerCase() !== transactionHash.toLowerCase() || !canonicalDate(acceptedAt) || Date.parse(acceptedAt) > nowDate.getTime() ||
          !['SUBMISSION_UNCERTAIN','SUBMITTED'].includes(operation.status)) fail('G3B_SUBMISSION_MISMATCH');
      if (operation.status === 'SUBMITTED') return { operation, replayed: true };
      const next = nextOperation(operation, { status: 'SUBMITTED' }, now); writeOperation(db, next);
      recordEvent(db, operation.executionId, 'G3B_SUBMISSION_ACCEPTED', reason, { operationId, transactionHash, acceptedAt }, now);
      return { operation: next, replayed: false };
    });
  }

  recordReceipt(operationId: string, attestation: G3bEvidenceAttestation, reason: string): G3bOperationWriteResult {
    assertReason(reason);
    return this.execution.g3bTransaction((db, clock) => {
      const nowDate = nowFrom(clock); const now = nowDate.toISOString(); const operation = readOperation(db, operationId);
      const payload = verifyG3bEvidenceAttestation(attestation, this.trust).payload;
      if (payload.kind !== 'APPROVAL_RECEIPT' || payload.executionId !== operation.executionId || payload.operationId !== operationId ||
          payload.chainId !== 8453 || payload.transactionHash.toLowerCase() !== operation.transactionHash?.toLowerCase() ||
          !canonicalDate(payload.confirmedAt) || Date.parse(payload.confirmedAt) > nowDate.getTime() ||
          !['SIGNED_OUTBOX','SUBMISSION_UNCERTAIN','SUBMITTED','CONFIRMED','FAILED'].includes(operation.status)) fail('G3B_RECEIPT_MISMATCH');
      if (operation.status === 'CONFIRMED' || operation.status === 'FAILED') {
        if (operation.receipt && canonicalEvidenceDigest(operation.receipt) === canonicalEvidenceDigest(attestation)) return { operation, replayed: true };
        fail('G3B_RECEIPT_CONFLICT');
      }
      const status = payload.outcome === 'CONFIRMED' ? 'CONFIRMED' : 'FAILED';
      const next = nextOperation(operation, { status, receipt: attestation,
        failureReason: status === 'FAILED' ? 'EXACT_TRANSACTION_REVERTED' : null }, now); writeOperation(db, next);
      recordEvent(db, operation.executionId, status === 'CONFIRMED' ? 'G3B_TRANSACTION_CONFIRMED' : 'G3B_TRANSACTION_REVERTED', reason,
        { operationId, transactionHash: operation.transactionHash, blockNumber: payload.blockNumber, blockHash: payload.blockHash }, now);
      return { operation: next, replayed: false };
    });
  }
}

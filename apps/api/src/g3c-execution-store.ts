import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalJson, executionLifecycleRecordSchema, executionKillSwitchSchema,
  g3bUnsignedTransactionSchema, g3cSessionSchema, g3cWorkflowSchema,
  g3cStatusResponseSchema, type ExecutionLifecycleRecord, type G3bUnsignedTransaction,
  type G3cEvidenceAttestation, type G3cSession, type G3cStatusResponse, type G3cWorkflow, type G3cSigningRequest,
} from '@ered-luin/contracts';
import { decodeFunctionData, getAddress, parseAbi, type Hex } from 'viem';
import { ExecutionStore } from './execution-store.js';
import { PaperStoreError } from './paper-store.js';
import { assertExecutionLifecycleRecord } from './execution-lifecycle-validation.js';
import { assertFreshG3cEvidence, canonicalG3cEvidenceDigest, verifyG3cEvidenceAttestation, type G3cEvidenceTrust } from './g3c-evidence.js';
import { decodeExactSwap, g3bUnsignedTransactionHash, validateSignedG3bTransaction, validateSignedG3bTransactionSync } from './g3b-transaction.js';
import { BASE_TOKENS, BASE_UNISWAP_V3 } from './base-allowlist.js';

type SqlRow = Record<string, unknown>;
type Db = import('node:sqlite').DatabaseSync;
const APPROVE_ABI = parseAbi(['function approve(address spender,uint256 value) returns (bool)']);
export const G3C_CAPS = Object.freeze({
  walletValueUsdcMicros: 25_000_000n, tradeValueUsdcMicros: 5_000_000n,
  wethPositionUsdcMicros: 10_000_000n, feeUsdcMicros: 250_000n,
  slippageBps: 50, impactBps: 50, sessionLossUsdcMicros: 2_000_000n,
});
export interface G3cStoreOptions { readonly allowTestSigning?: boolean; readonly allowTestBroadcast?: boolean; readonly enableProductionSigning?: boolean; readonly enableProductionBroadcast?: boolean; }
export interface G3cWorkflowInput {
  readonly executionId: string; readonly operationId: string; readonly sessionId: string;
  readonly kind: 'APPROVAL' | 'SWAP'; readonly unsignedTransaction: G3bUnsignedTransaction;
  readonly accountSnapshot: G3cEvidenceAttestation; readonly quote?: G3cEvidenceAttestation | null;
  readonly simulation: G3cEvidenceAttestation; readonly fee: G3cEvidenceAttestation; readonly reason: string;
}
export interface G3cWorkflowWriteResult { readonly workflow: G3cWorkflow; readonly replayed: boolean; }
export interface G3cBroadcastRelease {
  readonly operationId: string; readonly transactionHash: string; readonly signedBytesHex: string;
  readonly attempt: number; readonly replayed: boolean;
}
export interface G3cSignedResult { readonly signedBytesHex: string; readonly transactionHash: Hex; }
export interface G3cSigner { sign(request: G3cSigningRequest): Promise<G3cSignedResult>; }
export interface G3cBroadcaster { sendRawTransaction(signedBytesHex: string): Promise<Hex>; }
export type D2bOperatorAction = 'PREPARE_SIGN' | 'SUBMIT' | 'RECONCILE';
export interface D2bOperatorActionInput {
  readonly executionId: string;
  readonly proposalId: string;
  readonly operationId: string;
  readonly sessionId: string;
  readonly operatorId: string;
  readonly action: D2bOperatorAction;
  readonly idempotencyKey: string;
  readonly payloadDigest: string;
}
export type D2bOperatorActionClaim =
  | { readonly status: 'CLAIMED'; readonly claimToken: string }
  | { readonly status: 'COMPLETED' | 'UNCERTAIN' | 'IN_PROGRESS'; readonly claimToken: null };
type D2bOperatorActionProgressState = 'IN_PROGRESS' | 'RETRYABLE' | 'COMPLETED' | 'UNCERTAIN';
interface D2bOperatorActionProgress extends D2bOperatorActionInput {
  readonly state: D2bOperatorActionProgressState;
  readonly claimToken: string | null;
  readonly claimExpiresAt: string | null;
  readonly startingSubmissionAttempts: number | null;
  readonly outcomeStatus: string | null;
}
const D2B_ACTION_CLAIM_LEASE_MS = 2 * 60_000;
class G3cExecutionError extends PaperStoreError {
  readonly reason: string;
  constructor(reason: string) { super('EXECUTION_STATE_INVALID'); this.name = 'G3cExecutionError'; this.reason = reason; }
}
function fail(reason: string): never { throw new G3cExecutionError(reason); }
function canonicalDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && new Date(parsed).toISOString() === value;
}
function nowFrom(clock: () => Date): Date {
  try { const now = clock(); if (now instanceof Date && Number.isSafeInteger(now.getTime()) && now.getTime() >= 0) return now; } catch { /* fail closed */ }
  return fail('G3C_CLOCK_INVALID');
}
function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function writeEvent(db: Db, executionId: string, type: string, reason: string, evidence: unknown, at: string): void {
  const encoded = JSON.stringify(evidence);
  if (!reason.trim() || reason.length > 240 || encoded.length > 131_072) fail('G3C_EVENT_INVALID');
  db.prepare('INSERT INTO execution_events (event_id,execution_id,event_type,reason,evidence_json,created_at) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), executionId, type, reason, encoded, at);
}
function validateD2bOperatorActionInput(input: D2bOperatorActionInput): void {
  if (!/^[0-9a-f-]{36}$/iu.test(input.executionId) || input.proposalId !== input.executionId ||
      !/^[0-9a-f-]{36}$/iu.test(input.operationId) || !/^[0-9a-f-]{36}$/iu.test(input.sessionId) ||
      !/^local-[0-9a-f]{16}$/u.test(input.operatorId) || !/^[0-9a-f-]{36}$/iu.test(input.idempotencyKey) ||
      !/^[0-9a-f]{64}$/u.test(input.payloadDigest) ||
      !['PREPARE_SIGN', 'SUBMIT', 'RECONCILE'].includes(input.action)) fail('D2B_OPERATOR_ACTION_INVALID');
}
function sameD2bOperatorAction(a: D2bOperatorActionInput, b: D2bOperatorActionInput): boolean {
  return a.executionId === b.executionId && a.proposalId === b.proposalId && a.operationId === b.operationId &&
    a.sessionId === b.sessionId && a.operatorId === b.operatorId && a.action === b.action &&
    a.idempotencyKey === b.idempotencyKey && a.payloadDigest === b.payloadDigest;
}
function bindD2bOperatorAction(db: Db, input: D2bOperatorActionInput, trust: G3cEvidenceTrust, at: string): boolean {
  const parent = readParent(db, input.executionId);
  if (parent.executionId !== input.executionId) fail('D2B_EXECUTION_IDENTITY_MISMATCH');
  const rows = db.prepare("SELECT evidence_json FROM execution_events WHERE event_type = 'D2B_OPERATOR_ACTION_BOUND' ORDER BY rowid").all() as SqlRow[];
  for (const row of rows) {
    let prior: Record<string, unknown>;
    try { prior = JSON.parse(String(row.evidence_json)) as Record<string, unknown>; } catch { return fail('DATABASE_CORRUPT'); }
    const sameIdempotencyKey = prior.idempotencyKey === input.idempotencyKey;
    const sameActionIdentity = prior.operationId === input.operationId && prior.action === input.action;
    const sameProposalPreparation = input.action === 'PREPARE_SIGN' && prior.proposalId === input.proposalId && prior.action === input.action;
    if (sameIdempotencyKey) {
      const same = prior.executionId === input.executionId && prior.proposalId === input.proposalId && prior.operationId === input.operationId &&
        prior.sessionId === input.sessionId && prior.operatorId === input.operatorId && prior.action === input.action && prior.payloadDigest === input.payloadDigest;
      if (!same) fail('D2B_IDEMPOTENCY_CONFLICT');
      return false;
    }
    if (sameActionIdentity && input.action === 'PREPARE_SIGN') fail('D2B_IDEMPOTENCY_CONFLICT');
    if (sameProposalPreparation) {
      if (typeof prior.operationId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(prior.operationId)) fail('DATABASE_CORRUPT');
      const previousRow = db.prepare('SELECT operation_id FROM execution_g3c_workflows WHERE operation_id = ?').get(prior.operationId) as SqlRow | undefined;
      if (!previousRow || prior.operatorId !== input.operatorId) fail('D2B_OPERATION_IDENTITY_CONFLICT');
      const previousWorkflow = readWorkflow(db, String(previousRow.operation_id), trust);
      if (previousWorkflow.kind !== 'APPROVAL' || previousWorkflow.status !== 'CONFIRMED' || previousWorkflow.sessionId !== input.sessionId) {
        fail('D2B_OPERATION_IDENTITY_CONFLICT');
      }
    }
  }
  writeEvent(db, input.executionId, 'D2B_OPERATOR_ACTION_BOUND', 'Authenticated D2b ' + input.action + ' action bound to durable operation identity', {
    executionId: input.executionId, proposalId: input.proposalId, operationId: input.operationId, sessionId: input.sessionId,
    operatorId: input.operatorId, action: input.action, idempotencyKey: input.idempotencyKey, payloadDigest: input.payloadDigest,
  }, at);
  return true;
}
function d2bProgressFromEvidence(value: unknown): D2bOperatorActionProgress {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('DATABASE_CORRUPT');
  const record = value as Record<string, unknown>;
  const input = {
    executionId: record.executionId, proposalId: record.proposalId, operationId: record.operationId,
    sessionId: record.sessionId, operatorId: record.operatorId, action: record.action,
    idempotencyKey: record.idempotencyKey, payloadDigest: record.payloadDigest,
  };
  if (typeof input.executionId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(input.executionId) ||
      input.proposalId !== input.executionId || typeof input.operationId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(input.operationId) ||
      typeof input.sessionId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(input.sessionId) ||
      typeof input.operatorId !== 'string' || !/^local-[0-9a-f]{16}$/u.test(input.operatorId) ||
      !['SUBMIT', 'RECONCILE'].includes(String(input.action)) ||
      typeof input.idempotencyKey !== 'string' || !/^[0-9a-f-]{36}$/iu.test(input.idempotencyKey) ||
      typeof input.payloadDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(input.payloadDigest) ||
      !['IN_PROGRESS', 'RETRYABLE', 'COMPLETED', 'UNCERTAIN'].includes(String(record.state))) return fail('DATABASE_CORRUPT');
  const inProgress = record.state === 'IN_PROGRESS';
  if (inProgress) {
    if (typeof record.claimToken !== 'string' || !/^[0-9a-f-]{36}$/iu.test(record.claimToken) ||
        !canonicalDate(record.claimExpiresAt) ||
        (record.action === 'SUBMIT' && (!Number.isSafeInteger(record.startingSubmissionAttempts) || Number(record.startingSubmissionAttempts) < 0)) ||
        (record.action === 'RECONCILE' && record.startingSubmissionAttempts !== null) ||
        record.outcomeStatus !== null) return fail('DATABASE_CORRUPT');
  } else if (record.claimToken !== null || record.claimExpiresAt !== null || record.startingSubmissionAttempts !== null ||
      !(record.outcomeStatus === null || (typeof record.outcomeStatus === 'string' && record.outcomeStatus.length <= 128))) {
    return fail('DATABASE_CORRUPT');
  }
  return {
    executionId: input.executionId as string, proposalId: input.proposalId as string, operationId: input.operationId as string,
    sessionId: input.sessionId as string, operatorId: input.operatorId as string, action: input.action as 'SUBMIT' | 'RECONCILE',
    idempotencyKey: input.idempotencyKey as string, payloadDigest: input.payloadDigest as string,
    state: record.state as D2bOperatorActionProgressState, claimToken: record.claimToken as string | null,
    claimExpiresAt: record.claimExpiresAt as string | null, startingSubmissionAttempts: record.startingSubmissionAttempts as number | null,
    outcomeStatus: record.outcomeStatus as string | null,
  };
}
function listD2bOperatorActionProgress(db: Db): D2bOperatorActionProgress[] {
  const rows = db.prepare("SELECT evidence_json FROM execution_events WHERE event_type = 'D2B_OPERATOR_ACTION_PROGRESS' ORDER BY rowid").all() as SqlRow[];
  return rows.map((row) => {
    try { return d2bProgressFromEvidence(JSON.parse(String(row.evidence_json)) as unknown); }
    catch (error) { if (error instanceof G3cExecutionError) throw error; return fail('DATABASE_CORRUPT'); }
  });
}
function latestD2bOperatorActionProgress(db: Db, idempotencyKey: string): D2bOperatorActionProgress | null {
  const matching = listD2bOperatorActionProgress(db).filter((item) => item.idempotencyKey === idempotencyKey);
  return matching.length ? matching[matching.length - 1]! : null;
}
function currentD2bOperatorActionProgress(db: Db): D2bOperatorActionProgress[] {
  const latestByKey = new Map<string, D2bOperatorActionProgress>();
  for (const item of listD2bOperatorActionProgress(db)) latestByKey.set(item.idempotencyKey, item);
  return [...latestByKey.values()];
}
function writeD2bOperatorActionProgress(
  db: Db, input: D2bOperatorActionInput, state: D2bOperatorActionProgressState, at: string,
  detail: { readonly claimToken?: string; readonly claimExpiresAt?: string; readonly startingSubmissionAttempts?: number; readonly outcomeStatus?: string },
): void {
  const inProgress = state === 'IN_PROGRESS';
  writeEvent(db, input.executionId, 'D2B_OPERATOR_ACTION_PROGRESS', 'Authenticated D2b ' + input.action + ' progress ' + state, {
    ...input, state,
    claimToken: inProgress ? detail.claimToken ?? null : null,
    claimExpiresAt: inProgress ? detail.claimExpiresAt ?? null : null,
    startingSubmissionAttempts: inProgress && input.action === 'SUBMIT' ? detail.startingSubmissionAttempts ?? null : null,
    outcomeStatus: inProgress ? null : detail.outcomeStatus ?? null,
  }, at);
}
function actionWorkflowInTransaction(db: Db, operationId: string, trust: G3cEvidenceTrust): G3cWorkflow {
  const row = db.prepare('SELECT operation_id FROM execution_g3c_workflows WHERE operation_id = ?').get(operationId) as SqlRow | undefined;
  if (!row) return fail('D2B_WORKFLOW_NOT_FOUND');
  return readWorkflow(db, String(row.operation_id), trust);
}
function readParent(db: Db, executionId: string): ExecutionLifecycleRecord {
  const row = db.prepare('SELECT * FROM execution_lifecycle WHERE execution_id = ?').get(executionId) as SqlRow | undefined;
  if (!row) return fail('EXECUTION_NOT_FOUND');
  let data: unknown;
  try { data = JSON.parse(String(row.record_json)); } catch { return fail('DATABASE_CORRUPT'); }
  const checked = executionLifecycleRecordSchema.safeParse(data);
  if (!checked.success || checked.data.executionId !== row.execution_id || checked.data.status !== row.status ||
      checked.data.revision !== row.revision || checked.data.intentId !== row.intent_id ||
      checked.data.reservationId !== row.reservation_id || checked.data.walletAddress.toLowerCase() !== String(row.wallet_address).toLowerCase()) return fail('DATABASE_CORRUPT');
  try { assertExecutionLifecycleRecord(checked.data); } catch { return fail('DATABASE_CORRUPT'); }
  return checked.data;
}
function fundingAdjustmentTotal(adjustments: G3cSession['externalFundingAdjustments']): bigint {
  return adjustments.reduce((total, adjustment) => total + BigInt(adjustment.deltaUsdcMicros), 0n);
}
function calculateUnrealizedLoss(input: {
  readonly initialEquityUsdcMicros: string; readonly externalFundingAdjustments: G3cSession['externalFundingAdjustments'];
  readonly realizedLossUsdcMicros: string; readonly realizedFeesUsdcMicros: string; readonly walletValueUsdcMicros: string;
}): bigint {
  const expectedEquity = BigInt(input.initialEquityUsdcMicros) + fundingAdjustmentTotal(input.externalFundingAdjustments) -
    BigInt(input.realizedLossUsdcMicros) - BigInt(input.realizedFeesUsdcMicros);
  const actualEquity = BigInt(input.walletValueUsdcMicros);
  return expectedEquity > actualEquity ? expectedEquity - actualEquity : 0n;
}

function accountSessionSnapshot(session: G3cSession, snapshot: ReturnType<typeof accountPayload>, forceStop = false) {
  const unrealizedLossUsdcMicros = calculateUnrealizedLoss({ ...session, walletValueUsdcMicros: snapshot.walletValueUsdcMicros });
  const projectedLoss = BigInt(session.realizedLossUsdcMicros) + BigInt(session.realizedFeesUsdcMicros) +
    unrealizedLossUsdcMicros + BigInt(session.outstandingWorstCaseReservationsUsdcMicros);
  const reasons = [
    BigInt(snapshot.walletValueUsdcMicros) > G3C_CAPS.walletValueUsdcMicros ? 'WALLET_CAP_EXCEEDED' : null,
    BigInt(snapshot.wethValueUsdcMicros) > G3C_CAPS.wethPositionUsdcMicros ? 'WETH_POSITION_CAP_EXCEEDED' : null,
    projectedLoss >= G3C_CAPS.sessionLossUsdcMicros ? 'SESSION_LOSS_CAP_EXCEEDED' : null,
    forceStop ? 'FEE_CAP_EXCEEDED' : null,
  ].filter((reason): reason is string => reason !== null);
  return {
    unrealizedLossUsdcMicros: unrealizedLossUsdcMicros.toString(),
    markedExposureUsdcMicros: snapshot.wethValueUsdcMicros,
    projectedLossUsdcMicros: projectedLoss.toString(),
    stopReasons: reasons,
    status: session.status === 'ACTIVE' && reasons.length > 0 ? 'STOPPED' as const : session.status,
  };
}

function readSession(db: Db, sessionId: string, trust: G3cEvidenceTrust): G3cSession {
  const row = db.prepare('SELECT * FROM execution_g3c_sessions WHERE session_id = ?').get(sessionId) as SqlRow | undefined;
  if (!row) return fail('G3C_SESSION_NOT_FOUND');
  let data: unknown;
  try { data = JSON.parse(String(row.record_json)); } catch { return fail('DATABASE_CORRUPT'); }
  const checked = g3cSessionSchema.safeParse(data);
  if (!checked.success || checked.data.sessionId !== row.session_id || checked.data.status !== row.status ||
      checked.data.revision !== row.revision || checked.data.walletAddress.toLowerCase() !== String(row.wallet_address).toLowerCase() ||
      checked.data.createdAt !== row.created_at || checked.data.updatedAt !== row.updated_at) return fail('DATABASE_CORRUPT');
  const session = checked.data;
  if (!session.latestSnapshot) return fail('DATABASE_CORRUPT');
  try {
    const latest = verifyG3cEvidenceAttestation(session.latestSnapshot, trust);
    const account = accountPayload(latest);
    const accounting = accountSessionSnapshot(session, account);
    if (canonicalG3cEvidenceDigest(latest) !== session.latestSnapshotDigest ||
        account.walletAddress.toLowerCase() !== session.walletAddress.toLowerCase() ||
        account.accountVersion !== session.latestAccountVersion ||
        accounting.unrealizedLossUsdcMicros !== session.unrealizedLossUsdcMicros ||
        accounting.markedExposureUsdcMicros !== session.markedExposureUsdcMicros ||
        session.status === 'ACTIVE' && accounting.status !== 'ACTIVE') {
      return fail('DATABASE_CORRUPT');
    }
    const seen = new Set<string>();
    for (const adjustment of session.externalFundingAdjustments) {
      const source = verifyG3cEvidenceAttestation(adjustment.sourceEvidence, trust);
      if (canonicalG3cEvidenceDigest(source) !== adjustment.sourceDigest || seen.has(adjustment.sourceDigest) ||
          source.payload.kind !== 'FUNDING_ADJUSTMENT' ||
          BigInt(source.payload.amountAtomic) * (source.payload.direction === 'DEPOSIT' ? 1n : -1n) !== BigInt(adjustment.deltaUsdcMicros)) {
        return fail('DATABASE_CORRUPT');
      }
      seen.add(adjustment.sourceDigest);
    }
  } catch { return fail('DATABASE_CORRUPT'); }
  return session;
}
function readWorkflow(db: Db, operationId: string, trust: G3cEvidenceTrust): G3cWorkflow {
  const row = db.prepare('SELECT * FROM execution_g3c_workflows WHERE operation_id = ?').get(operationId) as SqlRow | undefined;
  if (!row) return fail('G3C_WORKFLOW_NOT_FOUND');
  let data: unknown;
  try { data = JSON.parse(String(row.record_json)); } catch { return fail('DATABASE_CORRUPT'); }
  const checked = g3cWorkflowSchema.safeParse(data);
  if (!checked.success || checked.data.operationId !== row.operation_id || checked.data.executionId !== row.execution_id ||
      checked.data.sessionId !== row.session_id || checked.data.status !== row.status || checked.data.revision !== row.revision ||
      checked.data.createdAt !== row.created_at || checked.data.updatedAt !== row.updated_at) return fail('DATABASE_CORRUPT');
  try { assertStoredWorkflow(checked.data, trust); } catch { return fail('DATABASE_CORRUPT'); }
  return checked.data;
}
function writeSession(db: Db, session: G3cSession): void {
  const checked = g3cSessionSchema.safeParse(session);
  if (!checked.success) return fail('G3C_SESSION_INVALID');
  const result = db.prepare('UPDATE execution_g3c_sessions SET status = ?,record_json = ?,updated_at = ?,revision = ? WHERE session_id = ?')
    .run(session.status, JSON.stringify(session), session.updatedAt, session.revision, session.sessionId);
  if (result.changes !== 1) fail('DATABASE_CORRUPT');
}
function writeWorkflow(db: Db, workflow: G3cWorkflow): void {
  const checked = g3cWorkflowSchema.safeParse(workflow);
  if (!checked.success) return fail('G3C_WORKFLOW_INVALID');
  const result = db.prepare('UPDATE execution_g3c_workflows SET status = ?,record_json = ?,updated_at = ?,revision = ? WHERE operation_id = ?')
    .run(workflow.status, JSON.stringify(workflow), workflow.updatedAt, workflow.revision, workflow.operationId);
  if (result.changes !== 1) fail('DATABASE_CORRUPT');
}
function nextSession(session: G3cSession, patch: Partial<G3cSession>, at: string): G3cSession {
  return g3cSessionSchema.parse({ ...session, ...patch, updatedAt: at, revision: session.revision + 1 });
}
function nextWorkflow(workflow: G3cWorkflow, patch: Partial<G3cWorkflow>, at: string): G3cWorkflow {
  return g3cWorkflowSchema.parse({ ...workflow, ...patch, updatedAt: at, revision: workflow.revision + 1 });
}
function evidence(value: unknown, trust: G3cEvidenceTrust, nowMs: number): G3cEvidenceAttestation {
  const checked = verifyG3cEvidenceAttestation(value, trust);
  assertFreshG3cEvidence(checked, nowMs);
  return checked;
}
function accountPayload(attestation: G3cEvidenceAttestation) {
  const payload = attestation.payload;
  if (payload.kind !== 'ACCOUNT_SNAPSHOT') return fail('G3C_ACCOUNT_SNAPSHOT_REQUIRED');
  const usdcMicros = BigInt(payload.usdcBalanceAtomic);
  if (BigInt(payload.usdcValueUsdcMicros) !== usdcMicros ||
      BigInt(payload.walletValueUsdcMicros) !== BigInt(payload.usdcValueUsdcMicros) + BigInt(payload.wethValueUsdcMicros) + BigInt(payload.gasValueUsdcMicros) ||
      payload.blockNumber !== payload.valuationBlockNumber || payload.blockHash.toLowerCase() !== payload.valuationBlockHash.toLowerCase()) fail('G3C_ACCOUNT_SNAPSHOT_MATH_INVALID');
  return payload;
}
function killSwitchState(db: Db) {
  const row = db.prepare('SELECT singleton,stopped,reason,changed_at FROM execution_control WHERE singleton = 1').get() as SqlRow | undefined;
  const checked = executionKillSwitchSchema.safeParse({ version: 1, stopped: row?.stopped === 1, reason: row?.reason, changedAt: row?.changed_at });
  if (!checked.success || (row?.stopped !== 0 && row?.stopped !== 1)) return fail('DATABASE_CORRUPT');
  return checked.data;
}
function killSwitchStopped(db: Db): boolean { return killSwitchState(db).stopped; }
function reserveRow(db: Db, parent: ExecutionLifecycleRecord): void {
  const row = db.prepare("SELECT status,owner_kind,intent_id,wallet_address,amount_in,exposure_usdc_micros FROM wallet_reservations WHERE reservation_id = ?")
    .get(parent.reservationId) as SqlRow | undefined;
  if (!row || row.status !== 'ACTIVE' || row.owner_kind !== 'EXECUTION' || row.intent_id !== parent.intentId ||
      String(row.wallet_address).toLowerCase() !== parent.walletAddress.toLowerCase() ||
      row.amount_in !== parent.transaction.amountIn || row.exposure_usdc_micros !== parent.reservationExposureUsdcMicros) fail('G3C_RESERVATION_NOT_ACTIVE');
}
function releaseParent(db: Db, parent: ExecutionLifecycleRecord, reason: string, at: string): void {
  if (parent.status === 'RELEASED') return;
  if (parent.status !== 'RESERVED' || parent.simulation || parent.authorization || parent.signingClaim || parent.signedOutbox || parent.receipt) fail('G3C_PARENT_NOT_RELEASEABLE');
  const released = executionLifecycleRecordSchema.parse({ ...parent, status: 'RELEASED', failureReason: reason, updatedAt: at, revision: parent.revision + 1 });
  assertExecutionLifecycleRecord(released);
  const changed = db.prepare("UPDATE execution_lifecycle SET status = 'RELEASED',record_json = ?,updated_at = ?,revision = ? WHERE execution_id = ? AND status = 'RESERVED'")
    .run(JSON.stringify(released), at, released.revision, parent.executionId);
  const reservation = db.prepare("UPDATE wallet_reservations SET status = 'RELEASED',updated_at = ? WHERE reservation_id = ? AND status = 'ACTIVE'")
    .run(at, parent.reservationId);
  if (changed.changes !== 1 || reservation.changes !== 1) fail('G3C_RESERVATION_RACE');
  writeEvent(db, parent.executionId, 'RESERVATION_RELEASED', reason, { reservationId: parent.reservationId, g3c: true }, at);
}
function assertAccountMatchesParent(snapshot: ReturnType<typeof accountPayload>, parent: ExecutionLifecycleRecord): void {
  const expectedToken = parent.intent.sellAsset === 'USDC' ? BASE_TOKENS.USDC : BASE_TOKENS.WETH;
  const available = parent.intent.sellAsset === 'USDC' ? snapshot.usdcBalanceAtomic : snapshot.wethBalanceAtomic;
  if (snapshot.walletAddress.toLowerCase() !== parent.walletAddress.toLowerCase() || snapshot.chainId !== 8453 ||
      snapshot.allowanceToken.toLowerCase() !== expectedToken.toLowerCase() ||
      snapshot.allowanceSpender.toLowerCase() !== BASE_UNISWAP_V3.router.toLowerCase() ||
      BigInt(available) < BigInt(parent.transaction.amountIn)) fail('G3C_ACCOUNT_DOES_NOT_SUPPORT_PROPOSAL');
}
function sameAccountState(a: ReturnType<typeof accountPayload>, b: ReturnType<typeof accountPayload>): boolean {
  const comparable = (value: ReturnType<typeof accountPayload>) => ({
    walletAddress: value.walletAddress.toLowerCase(), chainId: value.chainId, accountVersion: value.accountVersion,
    pendingNonce: value.pendingNonce, usdcBalanceAtomic: value.usdcBalanceAtomic, wethBalanceAtomic: value.wethBalanceAtomic,
    gasBalanceNativeWei: value.gasBalanceNativeWei, allowanceToken: value.allowanceToken.toLowerCase(),
    allowanceSpender: value.allowanceSpender.toLowerCase(), allowanceAtomic: value.allowanceAtomic,
    usdcValueUsdcMicros: value.usdcValueUsdcMicros, wethValueUsdcMicros: value.wethValueUsdcMicros,
    gasValueUsdcMicros: value.gasValueUsdcMicros, walletValueUsdcMicros: value.walletValueUsdcMicros,
    valuationPool: value.valuationPool.toLowerCase(),
  });
  return canonicalJson(comparable(a)) === canonicalJson(comparable(b));
}
function workflowInputDigest(input: G3cWorkflowInput): string {
  return sha256(canonicalJson({ version: 1, executionId: input.executionId, operationId: input.operationId,
    kind: input.kind, transaction: g3bUnsignedTransactionSchema.parse(input.unsignedTransaction),
    accountSnapshot: canonicalG3cEvidenceDigest(input.accountSnapshot),
    quote: input.quote ? canonicalG3cEvidenceDigest(input.quote) : null,
    simulation: canonicalG3cEvidenceDigest(input.simulation), fee: canonicalG3cEvidenceDigest(input.fee) }));
}
function assertStoredWorkflow(workflow: G3cWorkflow, trust: G3cEvidenceTrust): void {
  try {
    const attestations = [workflow.accountSnapshot, workflow.signingAccountSnapshot, workflow.quote,
      workflow.simulation, workflow.fee, workflow.receipt, workflow.settlementSnapshot].filter(Boolean);
    for (const item of attestations) verifyG3cEvidenceAttestation(item, trust);
    const expectedDigest = sha256(canonicalJson({ version: 1, executionId: workflow.executionId,
      operationId: workflow.operationId, kind: workflow.kind, transaction: workflow.unsignedTransaction,
      accountSnapshot: canonicalG3cEvidenceDigest(workflow.accountSnapshot),
      quote: workflow.quote ? canonicalG3cEvidenceDigest(workflow.quote) : null,
      simulation: canonicalG3cEvidenceDigest(workflow.simulation), fee: canonicalG3cEvidenceDigest(workflow.fee) }));
    if (expectedDigest !== workflow.transactionDigest) fail('DATABASE_CORRUPT');
    if (workflow.signedBytesHex === null) return;
    const digest = sha256(Buffer.from(workflow.signedBytesHex.slice(2), 'hex'));
    const signed = validateSignedG3bTransactionSync(workflow.signedBytesHex as Hex, workflow.unsignedTransaction);
    if (digest !== workflow.signedBytesDigest || signed.transactionHash.toLowerCase() !== workflow.transactionHash?.toLowerCase()) fail('DATABASE_CORRUPT');
  } catch { fail('DATABASE_CORRUPT'); }
}
function productionModeAllowed(flag: boolean): boolean {
  return flag && process.env.LIVE_EXECUTION_ENABLED === 'true' && process.env.EXECUTION_MODE === 'live-reviewed' &&
    process.env.G3C_REVIEWED_MODE === 'true';
}
function validateOperation(input: G3cWorkflowInput, parent: ExecutionLifecycleRecord,
  snapshot: ReturnType<typeof accountPayload>, quote: G3cEvidenceAttestation | null,
  simulation: G3cEvidenceAttestation, fee: G3cEvidenceAttestation, nowMs: number): bigint {
  const tx = g3bUnsignedTransactionSchema.parse(input.unsignedTransaction);
  if (tx.chainId !== 8453 || tx.from.toLowerCase() !== parent.walletAddress.toLowerCase() || tx.accessList.length !== 0 ||
      tx.nonce !== snapshot.pendingNonce || BigInt(tx.maxFeePerGasWei) > BigInt(parent.transaction.maxFeePerGasWei) ||
      BigInt(tx.maxPriorityFeePerGasWei) > BigInt(parent.transaction.maxPriorityFeePerGasWei) ||
      BigInt(tx.gasLimit) * BigInt(tx.maxFeePerGasWei) > BigInt(parent.transaction.maxTotalFeeWei) ||
      BigInt(parent.reservationExposureUsdcMicros) > G3C_CAPS.tradeValueUsdcMicros ||
      parent.transaction.amountIn !== parent.decision.approvedAmountIn) fail('G3C_TRANSACTION_ENVELOPE_INVALID');
  if ((snapshot.blockFinality !== 'unsafe' && snapshot.blockFinality !== 'safe' && snapshot.blockFinality !== 'finalized') || BigInt(snapshot.walletValueUsdcMicros) === 0n || BigInt(snapshot.walletValueUsdcMicros) > G3C_CAPS.walletValueUsdcMicros) fail('G3C_WALLET_CAP_EXCEEDED');
  const spendable = parent.intent.sellAsset === 'USDC' ? snapshot.usdcBalanceAtomic : snapshot.wethBalanceAtomic;
  if (BigInt(spendable) < BigInt(parent.transaction.amountIn)) fail('G3C_ACCOUNT_DOES_NOT_SUPPORT_PROPOSAL');
  const expectedDeadline = BigInt(Math.floor(Date.parse(parent.intent.expiresAt) / 1000));
  if (BigInt(parent.transaction.maxTotalFeeWei) <= 0n || Date.parse(parent.intent.expiresAt) <= nowMs) fail('G3C_INTENT_EXPIRED');
  if (input.kind === 'APPROVAL') {
    if (quote || BigInt(snapshot.allowanceAtomic) >= BigInt(parent.transaction.amountIn) ||
        tx.to.toLowerCase() !== snapshot.allowanceToken.toLowerCase() || tx.valueWei !== '0') fail('G3C_APPROVAL_NOT_REQUIRED');
    const call = decodeFunctionData({ abi: APPROVE_ABI, data: tx.data as Hex });
    if (call.functionName !== 'approve' || !call.args ||
        getAddress(call.args[0]).toLowerCase() !== BASE_UNISWAP_V3.router.toLowerCase() ||
        call.args[1] !== BigInt(parent.transaction.amountIn)) fail('G3C_APPROVAL_CALL_INVALID');
  } else {
    if (BigInt(snapshot.allowanceAtomic) < BigInt(parent.transaction.amountIn) || tx.to.toLowerCase() !== BASE_UNISWAP_V3.router.toLowerCase()) fail('G3C_ALLOWANCE_INSUFFICIENT');
    if (!quote || quote.payload.kind !== 'QUOTE') fail('G3C_QUOTE_REQUIRED');
    const q = quote.payload;
    const swap = decodeExactSwap(tx.data as Hex);
    if (swap.deadline !== expectedDeadline || swap.deadline * 1000n <= BigInt(nowMs) || tx.valueWei !== parent.transaction.valueNativeWei ||
        q.executionId !== input.executionId || q.operationId !== input.operationId || q.chainId !== 8453 ||
        q.poolAddress.toLowerCase() !== BASE_UNISWAP_V3.pool.toLowerCase() || q.fee !== 500 ||
        q.tokenIn.toLowerCase() !== snapshot.allowanceToken.toLowerCase() ||
        q.tokenOut.toLowerCase() !== (parent.intent.buyAsset === 'USDC' ? BASE_TOKENS.USDC : BASE_TOKENS.WETH).toLowerCase() ||
        q.amountIn !== parent.transaction.amountIn || q.minimumAmountOut !== swap.amountOutMinimum.toString() ||
        BigInt(q.minimumAmountOut) !== BigInt(q.amountOut) * BigInt(10_000 - q.slippageBps) / 10_000n ||
        q.slippageBps > G3C_CAPS.slippageBps || q.priceImpactBps > G3C_CAPS.impactBps ||
        q.blockNumber !== snapshot.blockNumber || q.blockHash.toLowerCase() !== snapshot.blockHash.toLowerCase() ||
        swap.tokenIn.toLowerCase() !== q.tokenIn.toLowerCase() || swap.tokenOut.toLowerCase() !== q.tokenOut.toLowerCase() ||
        swap.fee !== q.fee || swap.recipient.toLowerCase() !== parent.walletAddress.toLowerCase() ||
        swap.amountIn !== BigInt(q.amountIn) || swap.sqrtPriceLimitX96 !== 0n) fail('G3C_QUOTE_OR_SWAP_MISMATCH');
  }
  const txHash = g3bUnsignedTransactionHash(tx);
  const txDigest = sha256(canonicalJson(tx));
  const sim = simulation.payload;
  if (sim.kind !== 'SIMULATION' || sim.executionId !== input.executionId || sim.operationId !== input.operationId ||
      sim.chainId !== 8453 || sim.transactionDigest !== txDigest || sim.unsignedTransactionHash.toLowerCase() !== txHash.toLowerCase() ||
      sim.outcome !== 'PASSED' || sim.blockNumber !== snapshot.blockNumber || sim.blockHash.toLowerCase() !== snapshot.blockHash.toLowerCase() ||
      BigInt(sim.gasEstimate) > BigInt(tx.gasLimit) || BigInt(sim.revertGasEstimate) > BigInt(tx.gasLimit)) fail('G3C_SIMULATION_INVALID');
  const f = fee.payload;
  if (f.kind !== 'BASE_FEE' || f.includesRevertPath !== true || f.executionId !== input.executionId || f.operationId !== input.operationId ||
      f.chainId !== 8453 || f.unsignedTransactionHash.toLowerCase() !== txHash.toLowerCase() ||
      f.blockNumber !== snapshot.blockNumber || f.blockHash.toLowerCase() !== snapshot.blockHash.toLowerCase() ||
      f.gasLimit !== tx.gasLimit || f.maxFeePerGasWei !== tx.maxFeePerGasWei ||
      BigInt(f.executionGasFeeCapWei) !== BigInt(f.gasLimit) * BigInt(f.maxFeePerGasWei) ||
      BigInt(f.totalFeeWei) !== BigInt(f.executionGasFeeCapWei) + BigInt(f.l1DataFeeWei) + BigInt(f.operatorFeeWei) + BigInt(f.safetyMarginWei) ||
      BigInt(f.valueUsdcMicros) > G3C_CAPS.feeUsdcMicros ||
      BigInt(f.totalFeeWei) > BigInt(parent.transaction.maxTotalFeeWei)) fail('G3C_FEE_LIMIT_EXCEEDED');
  if (BigInt(snapshot.gasBalanceNativeWei) < BigInt(f.totalFeeWei) + BigInt(tx.valueWei)) fail('G3C_NATIVE_GAS_BALANCE_INSUFFICIENT');
  let tradeLoss = 0n;
  if (input.kind === 'SWAP') {
    const q = quote!.payload;
    if (q.kind !== 'QUOTE') return fail('G3C_QUOTE_REQUIRED');
    tradeLoss = ceilDiv(BigInt(parent.reservationExposureUsdcMicros) * BigInt(q.slippageBps + q.priceImpactBps), 10_000n);
    const currentWeth = BigInt(snapshot.wethValueUsdcMicros);
    const projectedWeth = parent.intent.buyAsset === 'WETH'
      ? currentWeth + BigInt(parent.reservationExposureUsdcMicros)
      : currentWeth > BigInt(parent.reservationExposureUsdcMicros) ? currentWeth - BigInt(parent.reservationExposureUsdcMicros) : 0n;
    if (projectedWeth > G3C_CAPS.wethPositionUsdcMicros) fail('G3C_WETH_POSITION_CAP_EXCEEDED');
  }
  return tradeLoss + BigInt(f.valueUsdcMicros);
}
function ceilDiv(n: bigint, d: bigint): bigint { if (d <= 0n) fail('G3C_DIVISOR_INVALID'); return (n + d - 1n) / d; }
function snapshotForSettlement(value: unknown, trust: G3cEvidenceTrust, nowMs: number, wallet: string): G3cEvidenceAttestation {
  const checked = evidence(value, trust, nowMs);
  const snapshot = accountPayload(checked);
  if (snapshot.walletAddress.toLowerCase() !== wallet.toLowerCase()) fail('G3C_SETTLEMENT_WALLET_MISMATCH');
  return checked;
}
export class G3cExecutionStore {
  constructor(
    private readonly execution: ExecutionStore,
    private readonly trust: G3cEvidenceTrust,
    private readonly options: G3cStoreOptions = {},
    private readonly clock: () => Date = () => new Date(),
  ) {
    if ((options.allowTestSigning || options.allowTestBroadcast) &&
        (process.env.NODE_ENV !== 'test' || trust.environment !== 'synthetic-test' || trust.allowSyntheticTestEvidence !== true)) {
      throw new Error('G3C_TEST_MONEY_MOVEMENT_IS_TEST_ONLY');
    }
  }

  getSession(sessionId: string): G3cSession {
    return this.execution.g3bRead((db) => readSession(db, sessionId, this.trust));
  }

  getParent(executionId: string): ExecutionLifecycleRecord { return this.execution.get(executionId); }

  get reviewedMode(): boolean {
    return this.trust.environment === 'production' &&
      (productionModeAllowed(this.options.enableProductionSigning === true) || productionModeAllowed(this.options.enableProductionBroadcast === true));
  }

  assertIntentFresh(executionId: string): void {
    const parent = this.getParent(executionId);
    const now = nowFrom(this.clock).getTime();
    if (parent.status !== 'RESERVED' || Date.parse(parent.intent.expiresAt) <= now) fail('G3C_INTENT_EXPIRED');
  }


  getWorkflow(operationId: string): G3cWorkflow {
    return this.execution.g3bRead((db) => readWorkflow(db, operationId, this.trust));
  }
  findWorkflow(operationId: string): G3cWorkflow | null {
    return this.execution.g3bRead((db) => {
      const row = db.prepare('SELECT operation_id FROM execution_g3c_workflows WHERE operation_id = ?').get(operationId) as SqlRow | undefined;
      return row ? readWorkflow(db, operationId, this.trust) : null;
    });
  }

  listWorkflowsForExecution(executionId: string): readonly G3cWorkflow[] {
    return this.execution.g3bRead((db) => Object.freeze((db.prepare('SELECT operation_id FROM execution_g3c_workflows WHERE execution_id = ? ORDER BY created_at,operation_id').all(executionId) as SqlRow[])
      .map((row) => readWorkflow(db, String(row.operation_id), this.trust))));
  }

  recordD2bOperatorAction(input: D2bOperatorActionInput): { readonly replayed: boolean } {
    validateD2bOperatorActionInput(input);
    return this.execution.g3bTransaction((db, clock) => ({
      replayed: !bindD2bOperatorAction(db, input, this.trust, nowFrom(clock).toISOString()),
    }));
  }

  claimD2bOperatorAction(input: D2bOperatorActionInput): D2bOperatorActionClaim {
    validateD2bOperatorActionInput(input);
    if (input.action !== 'SUBMIT' && input.action !== 'RECONCILE') fail('D2B_OPERATOR_ACTION_INVALID');
    return this.execution.g3bTransaction((db, clock) => {
      const now = nowFrom(clock);
      const newlyBound = bindD2bOperatorAction(db, input, this.trust, now.toISOString());
      const current = latestD2bOperatorActionProgress(db, input.idempotencyKey);
      if (current && !sameD2bOperatorAction(current, input)) fail('DATABASE_CORRUPT');
      const workflow = actionWorkflowInTransaction(db, input.operationId, this.trust);
      const actionProgress = currentD2bOperatorActionProgress(db);
      const terminalForAction = input.action === 'SUBMIT'
        ? ['SUBMITTED', 'CONFIRMED', 'REVERTED'].includes(workflow.status)
        : ['CONFIRMED', 'REVERTED'].includes(workflow.status);

      if (current?.state === 'COMPLETED') return { status: 'COMPLETED', claimToken: null };
      if (terminalForAction) {
        writeD2bOperatorActionProgress(db, input, 'COMPLETED', now.toISOString(), { outcomeStatus: workflow.status });
        return { status: 'COMPLETED', claimToken: null };
      }
      if (current?.state === 'UNCERTAIN') return { status: 'UNCERTAIN', claimToken: null };
      if (current?.state === 'IN_PROGRESS' && current.claimExpiresAt && Date.parse(current.claimExpiresAt) > now.getTime()) {
        return { status: 'IN_PROGRESS', claimToken: null };
      }

      const anotherActive = actionProgress.some((item) => item.operationId === input.operationId &&
        item.idempotencyKey !== input.idempotencyKey && item.state === 'IN_PROGRESS' &&
        item.claimExpiresAt !== null && Date.parse(item.claimExpiresAt) > now.getTime());
      if (anotherActive) {
        if (!current) writeD2bOperatorActionProgress(db, input, 'RETRYABLE', now.toISOString(), { outcomeStatus: 'D2B_ACTION_IN_PROGRESS' });
        return { status: 'IN_PROGRESS', claimToken: null };
      }

      if (current?.state === 'IN_PROGRESS') {
        if (input.action === 'SUBMIT' &&
            (!['SIGNED_OUTBOX', 'SUBMISSION_UNCERTAIN'].includes(workflow.status) ||
             workflow.submissionAttempts !== current.startingSubmissionAttempts)) {
          writeD2bOperatorActionProgress(db, input, 'UNCERTAIN', now.toISOString(), { outcomeStatus: workflow.status });
          return { status: 'UNCERTAIN', claimToken: null };
        }
      }

      if (input.action === 'SUBMIT') {
        if (!['SIGNED_OUTBOX', 'SUBMISSION_UNCERTAIN'].includes(workflow.status)) fail('D2B_SIGNED_OUTBOX_REQUIRED');
        if (!current && !newlyBound && workflow.status !== 'SIGNED_OUTBOX') {
          writeD2bOperatorActionProgress(db, input, 'UNCERTAIN', now.toISOString(), { outcomeStatus: workflow.status });
          return { status: 'UNCERTAIN', claimToken: null };
        }
      } else if (!['SUBMISSION_UNCERTAIN', 'SUBMITTED', 'RECONCILIATION_REQUIRED', 'CONFIRMED', 'REVERTED'].includes(workflow.status)) {
        fail('D2B_RECOVERY_NOT_PENDING');
      }

      const claimToken = randomUUID();
      writeD2bOperatorActionProgress(db, input, 'IN_PROGRESS', now.toISOString(), {
        claimToken, claimExpiresAt: new Date(now.getTime() + D2B_ACTION_CLAIM_LEASE_MS).toISOString(),
        ...(input.action === 'SUBMIT' ? { startingSubmissionAttempts: workflow.submissionAttempts } : {}),
      });
      return { status: 'CLAIMED', claimToken };
    });
  }

  completeD2bOperatorAction(input: D2bOperatorActionInput, claimToken: string, outcomeStatus: string): boolean {
    return this.finishD2bOperatorAction(input, claimToken, 'COMPLETED', outcomeStatus);
  }

  releaseD2bOperatorAction(
    input: D2bOperatorActionInput, claimToken: string, state: 'RETRYABLE' | 'UNCERTAIN', outcomeStatus: string,
  ): boolean {
    return this.finishD2bOperatorAction(input, claimToken, state, outcomeStatus);
  }

  private finishD2bOperatorAction(
    input: D2bOperatorActionInput, claimToken: string, state: 'RETRYABLE' | 'COMPLETED' | 'UNCERTAIN', outcomeStatus: string,
  ): boolean {
    if (!/^[0-9a-f-]{36}$/iu.test(claimToken) || typeof outcomeStatus !== 'string' || outcomeStatus.length > 128) fail('D2B_OPERATOR_ACTION_INVALID');
    return this.execution.g3bTransaction((db, clock) => {
      const latest = latestD2bOperatorActionProgress(db, input.idempotencyKey);
      if (!latest || !sameD2bOperatorAction(latest, input) || latest.state !== 'IN_PROGRESS' || latest.claimToken !== claimToken) return false;
      writeD2bOperatorActionProgress(db, input, state, nowFrom(clock).toISOString(), { outcomeStatus });
      return true;
    });
  }
  startSession(input: { readonly sessionId: string; readonly accountSnapshot: G3cEvidenceAttestation; readonly reason: string }): G3cSession {
    if (!input || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 240) fail('G3C_INVALID_REASON');
    return this.execution.g3bTransaction((db, clock) => {
      const atDate = nowFrom(clock); const at = atDate.toISOString();
      const snapshotEvidence = evidence(input.accountSnapshot, this.trust, atDate.getTime());
      const snapshot = accountPayload(snapshotEvidence);
      if (snapshot.chainId !== 8453 || snapshot.blockFinality !== 'unsafe' && snapshot.blockFinality !== 'safe' && snapshot.blockFinality !== 'finalized' ||
          snapshot.allowanceSpender.toLowerCase() !== BASE_UNISWAP_V3.router.toLowerCase() ||
          snapshot.valuationPool.toLowerCase() !== BASE_UNISWAP_V3.pool.toLowerCase() ||
          BigInt(snapshot.walletValueUsdcMicros) <= 0n || BigInt(snapshot.walletValueUsdcMicros) > G3C_CAPS.walletValueUsdcMicros ||
          BigInt(snapshot.wethValueUsdcMicros) > G3C_CAPS.wethPositionUsdcMicros) fail('G3C_SESSION_START_CAP');
      const existing = db.prepare('SELECT session_id,record_json FROM execution_g3c_sessions WHERE session_id = ?').get(input.sessionId) as SqlRow | undefined;
      const digest = canonicalG3cEvidenceDigest(snapshotEvidence);
      if (existing) {
        const prior = readSession(db, input.sessionId, this.trust);
        if (prior.latestSnapshotDigest === digest) return prior;
        fail('G3C_SESSION_ID_CONFLICT');
      }
      const active = db.prepare("SELECT COUNT(*) AS count FROM execution_g3c_sessions WHERE lower(wallet_address) = lower(?) AND status = 'ACTIVE'")
        .get(snapshot.walletAddress) as SqlRow;
      if (Number(active.count) > 0) fail('G3C_SESSION_ALREADY_ACTIVE');
      const session = g3cSessionSchema.parse({
        version: 1, sessionId: input.sessionId, walletAddress: getAddress(snapshot.walletAddress), status: 'ACTIVE',
        initialEquityUsdcMicros: snapshot.walletValueUsdcMicros, externalFundingAdjustments: [],
        realizedLossUsdcMicros: '0', realizedFeesUsdcMicros: '0', unrealizedLossUsdcMicros: '0',
        markedExposureUsdcMicros: snapshot.wethValueUsdcMicros,
        outstandingWorstCaseReservationsUsdcMicros: '0', latestAccountVersion: snapshot.accountVersion,
        latestSnapshotDigest: digest, latestSnapshot: snapshotEvidence, createdAt: at, updatedAt: at, revision: 1,
      });
      db.prepare('INSERT INTO execution_g3c_sessions (session_id,wallet_address,status,record_json,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?)')
        .run(session.sessionId, session.walletAddress, session.status, JSON.stringify(session), at, at, session.revision);
      writeEvent(db, session.sessionId, 'G3C_SESSION_STARTED', input.reason, {
        sessionId: session.sessionId, accountVersion: session.latestAccountVersion, snapshotDigest: digest,
        walletValueUsdcMicros: snapshot.walletValueUsdcMicros,
      }, at);
      return session;
    });
  }

  refreshSessionSnapshot(sessionId: string, accountSnapshot: G3cEvidenceAttestation, reason: string): G3cSession {
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 240) fail('G3C_INVALID_REASON');
    return this.execution.g3bTransaction((db, clock) => {
      const atDate = nowFrom(clock); const at = atDate.toISOString();
      const current = readSession(db, sessionId, this.trust);
      if (current.status !== 'ACTIVE') fail('G3C_SESSION_NOT_ACTIVE');
      const active = db.prepare("SELECT COUNT(*) AS count FROM execution_g3c_workflows WHERE session_id = ? AND status NOT IN ('CONFIRMED','REVERTED','CANCELLED')")
        .get(sessionId) as SqlRow;
      if (Number(active.count) !== 0) fail('G3C_UNRESOLVED_WORKFLOW');
      const checked = evidence(accountSnapshot, this.trust, atDate.getTime());
      const snapshot = accountPayload(checked);
      if (snapshot.walletAddress.toLowerCase() !== current.walletAddress.toLowerCase() ||
          snapshot.accountVersion !== current.latestAccountVersion + 1 ||
          snapshot.allowanceSpender.toLowerCase() !== BASE_UNISWAP_V3.router.toLowerCase() ||
          snapshot.valuationPool.toLowerCase() !== BASE_UNISWAP_V3.pool.toLowerCase()) fail('G3C_ACCOUNT_VERSION_INVALID');
      const digest = canonicalG3cEvidenceDigest(checked);
      const accounting = accountSessionSnapshot(current, snapshot);
      const next = nextSession(current, { status: accounting.status, unrealizedLossUsdcMicros: accounting.unrealizedLossUsdcMicros,
        latestAccountVersion: snapshot.accountVersion, latestSnapshotDigest: digest, latestSnapshot: checked,
        markedExposureUsdcMicros: accounting.markedExposureUsdcMicros }, at);
      writeSession(db, next);
      writeEvent(db, sessionId, 'G3C_ACCOUNT_REFRESHED', reason, {
        sessionId, accountVersion: snapshot.accountVersion, snapshotDigest: digest, walletValueUsdcMicros: snapshot.walletValueUsdcMicros,
      }, at);
      if (accounting.status === 'STOPPED') writeEvent(db, sessionId, 'G3C_SESSION_STOPPED', accounting.stopReasons.join('|'), { sessionId, projectedLossUsdcMicros: accounting.projectedLossUsdcMicros }, at);
      return next;
    });
  }

  /** Validate a completed simulation against G3c's exact transaction, evidence, reservation and loss controls without creating authorization state. */
  validateSimulation(input: G3cWorkflowInput): void {
    if (!input || !/^[0-9a-f-]{36}$/iu.test(input.executionId) || !/^[0-9a-f-]{36}$/iu.test(input.operationId) ||
        !/^[0-9a-f-]{36}$/iu.test(input.sessionId) || input.kind !== 'SWAP' ||
        typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 240) fail('G3C_INVALID_INPUT');
    this.execution.g3bRead((db) => {
      const nowMs = nowFrom(this.clock).getTime();
      const parent = readParent(db, input.executionId);
      const session = readSession(db, input.sessionId, this.trust);
      if (killSwitchStopped(db) || session.status !== 'ACTIVE') fail('KILL_SWITCH_STOPPED');
      if (parent.status !== 'RESERVED' || parent.simulation || parent.authorization || parent.signingClaim ||
          parent.intent.expiresAt <= new Date(nowMs).toISOString() || !['ALLOW', 'RESIZE'].includes(parent.decision.status) ||
          parent.decision.approvedAmountIn !== parent.transaction.amountIn ||
          Date.parse(parent.decision.evaluatedAt) > nowMs || nowMs - Date.parse(parent.decision.evaluatedAt) > 60_000) fail('G3C_PARENT_POLICY_INVALID');
      if (session.walletAddress.toLowerCase() !== parent.walletAddress.toLowerCase()) fail('G3C_SESSION_WALLET_MISMATCH');
      const active = db.prepare("SELECT COUNT(*) AS count FROM execution_g3c_workflows WHERE execution_id = ? AND status NOT IN ('CONFIRMED','REVERTED','CANCELLED')")
        .get(input.executionId) as SqlRow;
      if (Number(active.count) !== 0) fail('G3C_OPERATION_ALREADY_PENDING');
      reserveRow(db, parent);
      const snapshotEvidence = evidence(input.accountSnapshot, this.trust, nowMs);
      const snapshot = accountPayload(snapshotEvidence);
      if (snapshot.accountVersion !== session.latestAccountVersion ||
          canonicalG3cEvidenceDigest(snapshotEvidence) !== session.latestSnapshotDigest) fail('G3C_ACCOUNT_SNAPSHOT_STALE');
      assertAccountMatchesParent(snapshot, parent);
      const quoteEvidence = input.quote ? evidence(input.quote, this.trust, nowMs) : null;
      const simulationEvidence = evidence(input.simulation, this.trust, nowMs);
      const feeEvidence = evidence(input.fee, this.trust, nowMs);
      const reserveAmount = validateOperation(input, parent, snapshot, quoteEvidence, simulationEvidence, feeEvidence, nowMs);
      const projectedLoss = BigInt(session.realizedLossUsdcMicros) + BigInt(session.realizedFeesUsdcMicros) +
        BigInt(session.unrealizedLossUsdcMicros) + BigInt(session.outstandingWorstCaseReservationsUsdcMicros) + reserveAmount;
      if (projectedLoss > G3C_CAPS.sessionLossUsdcMicros) fail('G3C_SESSION_LOSS_CAP_EXCEEDED');
    });
  }

  prepareOperation(input: G3cWorkflowInput): G3cWorkflowWriteResult {
    return this.prepareValidatedOperation(input, 'APPLICATION_SIGNER');
  }

  /** Create browser-wallet authority only after a complete transaction/evidence packet is validated. */
  prepareBrowserOperation(input: G3cWorkflowInput): G3cWorkflowWriteResult {
    return this.prepareValidatedOperation(input, 'BROWSER_WALLET');
  }

  private prepareValidatedOperation(input: G3cWorkflowInput, submissionMode: 'APPLICATION_SIGNER' | 'BROWSER_WALLET'): G3cWorkflowWriteResult {
    if (!input || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 240 ||
        !/^[0-9a-f-]{36}$/iu.test(input.executionId) || !/^[0-9a-f-]{36}$/iu.test(input.operationId)) fail('G3C_INVALID_INPUT');
    return this.execution.g3bTransaction((db, clock) => {
      const atDate = nowFrom(clock); const nowMs = atDate.getTime(); const at = atDate.toISOString();
      const existingRow = db.prepare('SELECT operation_id FROM execution_g3c_workflows WHERE operation_id = ?').get(input.operationId) as SqlRow | undefined;
      if (existingRow) {
        const existing = readWorkflow(db, input.operationId, this.trust);
        const same = existing.executionId === input.executionId && existing.sessionId === input.sessionId &&
          existing.submissionMode === submissionMode && existing.transactionDigest === workflowInputDigest(input);
        if (!same) fail('G3C_OPERATION_ID_CONFLICT');
        return { workflow: existing, replayed: true };
      }
      const g3bOwner = db.prepare('SELECT 1 AS owned FROM execution_g3b_operations WHERE execution_id = ? LIMIT 1').get(input.executionId) as SqlRow | undefined;
      if (g3bOwner) fail('G3C_EXECUTION_ALREADY_G3B_OWNED');
      const session = readSession(db, input.sessionId, this.trust);
      if (session.status !== 'ACTIVE' || killSwitchStopped(db)) fail('KILL_SWITCH_STOPPED');
      const parent = readParent(db, input.executionId);
      if (parent.status !== 'RESERVED' || parent.simulation || parent.authorization || parent.signingClaim ||
          parent.intent.expiresAt <= at || !['ALLOW','RESIZE'].includes(parent.decision.status) ||
          parent.decision.approvedAmountIn !== parent.transaction.amountIn ||
          Date.parse(parent.decision.evaluatedAt) > nowMs || nowMs - Date.parse(parent.decision.evaluatedAt) > 60_000) fail('G3C_PARENT_POLICY_INVALID');
      reserveRow(db, parent);
      if (parent.walletAddress.toLowerCase() !== session.walletAddress.toLowerCase()) fail('G3C_SESSION_WALLET_MISMATCH');
      const active = db.prepare("SELECT COUNT(*) AS count FROM execution_g3c_workflows WHERE execution_id = ? AND status NOT IN ('CONFIRMED','REVERTED','CANCELLED')")
        .get(input.executionId) as SqlRow;
      if (Number(active.count) !== 0) fail('G3C_OPERATION_ALREADY_PENDING');
      const snapshotEvidence = evidence(input.accountSnapshot, this.trust, nowMs);
      const snapshot = accountPayload(snapshotEvidence);
      if (snapshot.accountVersion !== session.latestAccountVersion ||
          canonicalG3cEvidenceDigest(snapshotEvidence) !== session.latestSnapshotDigest) fail('G3C_ACCOUNT_SNAPSHOT_STALE');
      assertAccountMatchesParent(snapshot, parent);
      const quoteEvidence = input.quote ? evidence(input.quote, this.trust, nowMs) : null;
      const simulationEvidence = evidence(input.simulation, this.trust, nowMs);
      const feeEvidence = evidence(input.fee, this.trust, nowMs);
      const reserveAmount = validateOperation(input, parent, snapshot, quoteEvidence, simulationEvidence, feeEvidence, nowMs);
      const projectedLoss = BigInt(session.realizedLossUsdcMicros) + BigInt(session.realizedFeesUsdcMicros) +
        BigInt(session.unrealizedLossUsdcMicros) + BigInt(session.outstandingWorstCaseReservationsUsdcMicros) + reserveAmount;
      if (projectedLoss > G3C_CAPS.sessionLossUsdcMicros) fail('G3C_SESSION_LOSS_CAP_EXCEEDED');
      const transactionDigest = workflowInputDigest(input);
      const workflow = g3cWorkflowSchema.parse({
        version: 1, executionId: input.executionId, intentId: parent.intentId, decisionId: parent.decisionId,
        reservationId: parent.reservationId, operationId: input.operationId, sessionId: session.sessionId,
        kind: input.kind, status: 'AUTHORIZED', submissionMode, browserStage: submissionMode === 'BROWSER_WALLET' ? 'READY' : null,
        accountVersion: snapshot.accountVersion, accountSnapshot: snapshotEvidence, signingAccountSnapshot: null,
        quote: quoteEvidence, simulation: simulationEvidence, fee: feeEvidence,
        unsignedTransaction: g3bUnsignedTransactionSchema.parse(input.unsignedTransaction), transactionDigest,
        authorizationId: randomUUID(), signingClaimId: null, claimedAt: null,
        signedBytesHex: null, signedBytesDigest: null, transactionHash: null, submissionAttempts: 0,
        receipt: null, settlementSnapshot: null, reservedWorstCaseLossUsdcMicros: reserveAmount.toString(),
        actualFeesUsdcMicros: '0', actualLossUsdcMicros: '0', intentExpiresAt: parent.intent.expiresAt,
        failureReason: null, createdAt: at, updatedAt: at, revision: 1,
      });
      const updatedSession = nextSession(session, {
        outstandingWorstCaseReservationsUsdcMicros: (BigInt(session.outstandingWorstCaseReservationsUsdcMicros) + reserveAmount).toString(),
      }, at);
      writeSession(db, updatedSession);
      db.prepare('INSERT INTO execution_g3c_workflows (operation_id,execution_id,session_id,status,record_json,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?)')
        .run(workflow.operationId, workflow.executionId, workflow.sessionId, workflow.status, JSON.stringify(workflow), at, at, workflow.revision);
      writeEvent(db, workflow.executionId, submissionMode === 'BROWSER_WALLET' ? 'D2_BROWSER_PENDING_CREATED' : 'G3C_WORKFLOW_AUTHORIZED', input.reason, {
        operationId: workflow.operationId, sessionId: workflow.sessionId, transactionDigest,
        accountVersion: workflow.accountVersion, reservedWorstCaseLossUsdcMicros: workflow.reservedWorstCaseLossUsdcMicros,
      }, at);
      return { workflow, replayed: false };
    });
  }

  prepareBrowserWallet(operationId: string, reason: string): G3cWorkflowWriteResult {
    if (!reason.trim() || reason.length > 240) fail('G3C_INVALID_REASON');
    return this.execution.g3bTransaction((db, clock) => {
      const atDate = nowFrom(clock); const at = atDate.toISOString(); const nowMs = atDate.getTime();
      const workflow = readWorkflow(db, operationId, this.trust);
      if (workflow.submissionMode === 'BROWSER_WALLET' && workflow.browserStage === 'READY') return { workflow, replayed: true };
      const parent = readParent(db, workflow.executionId); const session = readSession(db, workflow.sessionId, this.trust);
      if (workflow.status !== 'AUTHORIZED' || workflow.submissionMode !== 'APPLICATION_SIGNER' || workflow.signingClaimId || workflow.signedBytesHex ||
          parent.status !== 'RESERVED' || session.status !== 'ACTIVE' || killSwitchStopped(db) || Date.parse(workflow.intentExpiresAt) <= nowMs ||
          !['ALLOW','RESIZE'].includes(parent.decision.status) || workflow.kind !== 'SWAP') fail('G3C_BROWSER_PREPARATION_INVALID');
      reserveRow(db, parent);
      for (const item of [workflow.accountSnapshot, workflow.quote, workflow.simulation, workflow.fee].filter(Boolean)) assertFreshG3cEvidence(item!, nowMs);
      const next = nextWorkflow(workflow, { submissionMode: 'BROWSER_WALLET', browserStage: 'READY' }, at);
      writeWorkflow(db, next);
      writeEvent(db, workflow.executionId, 'D2_BROWSER_PENDING_CREATED', reason, {
        operationId, sessionId: workflow.sessionId, transactionDigest: workflow.transactionDigest,
        unsignedTransactionHash: g3bUnsignedTransactionHash(workflow.unsignedTransaction),
      }, at);
      return { workflow: next, replayed: false };
    });
  }

  armBrowserWalletSubmission(operationId: string, currentAccountSnapshot: G3cEvidenceAttestation, reason: string): G3cWorkflowWriteResult {
    if (!reason.trim() || reason.length > 240) fail('G3C_INVALID_REASON');
    return this.execution.g3bTransaction((db, clock) => {
      const atDate = nowFrom(clock); const at = atDate.toISOString(); const nowMs = atDate.getTime();
      const workflow = readWorkflow(db, operationId, this.trust);
      if (workflow.submissionMode !== 'BROWSER_WALLET' || workflow.browserStage !== 'READY' || workflow.status !== 'AUTHORIZED') fail('G3C_BROWSER_SEND_NOT_READY');
      const parent = readParent(db, workflow.executionId); const session = readSession(db, workflow.sessionId, this.trust);
      if (parent.status !== 'RESERVED' || session.status !== 'ACTIVE' || killSwitchStopped(db) ||
          Date.parse(workflow.intentExpiresAt) <= nowMs || !['ALLOW','RESIZE'].includes(parent.decision.status)) fail('G3C_BROWSER_PREPARATION_INVALID');
      reserveRow(db, parent);
      const current = evidence(currentAccountSnapshot, this.trust, nowMs);
      if (current.payload.kind !== 'ACCOUNT_SNAPSHOT' || current.payload.accountVersion !== workflow.accountVersion ||
          !sameAccountState(accountPayload(current), accountPayload(workflow.accountSnapshot))) fail('G3C_ACCOUNT_VERSION_STALE');
      for (const item of [workflow.accountSnapshot, workflow.quote, workflow.simulation, workflow.fee].filter(Boolean)) assertFreshG3cEvidence(item!, nowMs);
      const next = nextWorkflow(workflow, { status: 'SUBMISSION_UNCERTAIN', browserStage: 'SUBMISSION_UNCERTAIN', submissionAttempts: 1 }, at);
      writeWorkflow(db, next);
      writeEvent(db, workflow.executionId, 'D2_BROWSER_SEND_ARMED', reason, {
        operationId, sessionId: workflow.sessionId, walletAddress: workflow.unsignedTransaction.from,
        chainId: workflow.unsignedTransaction.chainId, transactionDigest: workflow.transactionDigest,
      }, at);
      return { workflow: next, replayed: false };
    });
  }

  recordBrowserTransaction(operationId: string, transactionHash: string, verification: 'MATCH' | 'NOT_FOUND' | 'CONFLICT', reason: string): G3cWorkflowWriteResult {
    if (!reason.trim() || reason.length > 240 || !/^0x[0-9a-fA-F]{64}$/u.test(transactionHash)) fail('G3C_BROWSER_HASH_INVALID');
    return this.execution.g3bTransaction((db, clock) => {
      const at = nowFrom(clock).toISOString(); const workflow = readWorkflow(db, operationId, this.trust);
      if (workflow.submissionMode !== 'BROWSER_WALLET' || !['SUBMISSION_UNCERTAIN','SUBMITTED','RECONCILIATION_REQUIRED'].includes(workflow.status)) fail('G3C_BROWSER_SUBMISSION_STATE_INVALID');
      if (workflow.transactionHash && workflow.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) fail('G3C_BROWSER_HASH_CONFLICT');
      if (workflow.status === 'SUBMITTED' && workflow.transactionHash?.toLowerCase() === transactionHash.toLowerCase() && verification === 'MATCH') return { workflow, replayed: true };
      const status = verification === 'MATCH' ? 'SUBMITTED' : verification === 'CONFLICT' ? 'RECONCILIATION_REQUIRED' : 'SUBMISSION_UNCERTAIN';
      const browserStage = verification === 'MATCH' ? 'SUBMITTED' : verification === 'CONFLICT' ? 'RECONCILIATION_REQUIRED' : 'SUBMISSION_UNCERTAIN';
      const next = nextWorkflow(workflow, { status, browserStage, transactionHash: transactionHash.toLowerCase() as Hex,
        failureReason: verification === 'CONFLICT' ? 'BROWSER_TRANSACTION_MISMATCH' : null }, at);
      writeWorkflow(db, next);
      writeEvent(db, workflow.executionId, verification === 'CONFLICT' ? 'D2_BROWSER_RECONCILIATION_REQUIRED' : 'D2_BROWSER_SUBMISSION_OBSERVED', reason, {
        operationId, transactionHash: transactionHash.toLowerCase(), verification,
        expectedTransactionDigest: workflow.transactionDigest,
      }, at);
      return { workflow: next, replayed: false };
    });
  }

  rejectBrowserWalletSubmission(operationId: string, reason: string): G3cWorkflowWriteResult {
    if (!reason.trim() || reason.length > 240) fail('G3C_INVALID_REASON');
    return this.execution.g3bTransaction((db, clock) => {
      const at = nowFrom(clock).toISOString(); const workflow = readWorkflow(db, operationId, this.trust);
      if (workflow.submissionMode !== 'BROWSER_WALLET' || !['SUBMISSION_UNCERTAIN','AUTHORIZED'].includes(workflow.status) ||
          workflow.transactionHash !== null || !['SUBMISSION_UNCERTAIN','READY'].includes(workflow.browserStage ?? '')) fail('G3C_BROWSER_REJECTION_STATE_INVALID');
      const session = readSession(db, workflow.sessionId, this.trust);
      const remaining = BigInt(session.outstandingWorstCaseReservationsUsdcMicros) - BigInt(workflow.reservedWorstCaseLossUsdcMicros);
      if (remaining < 0n) fail('G3C_SESSION_ACCOUNTING_CORRUPT');
      const parent = readParent(db, workflow.executionId); reserveRow(db, parent);
      const nextSessionRecord = nextSession(session, { outstandingWorstCaseReservationsUsdcMicros: remaining.toString() }, at);
      const next = nextWorkflow(workflow, { status: 'CANCELLED', browserStage: 'REJECTED', failureReason: reason.includes('user rejection') ? 'WALLET_USER_REJECTED' : 'BROWSER_WALLET_CONTEXT_CHANGED' }, at);
      writeSession(db, nextSessionRecord); writeWorkflow(db, next);
      releaseParent(db, parent, 'D2_BROWSER_WALLET_USER_REJECTED', at);
      writeEvent(db, workflow.executionId, 'D2_BROWSER_WALLET_REJECTED', reason, { operationId, sessionId: workflow.sessionId }, at);
      return { workflow: next, replayed: false };
    });
  }

  recordBrowserReceipt(operationId: string, receiptEvidence: G3cEvidenceAttestation,
    settlementSnapshot?: G3cEvidenceAttestation | null, reason = 'Browser wallet receipt reconciliation'): G3cWorkflowWriteResult {
    if (!reason.trim() || reason.length > 240) fail('G3C_INVALID_REASON');
    return this.execution.g3bTransaction((db, clock) => {
      const atDate = nowFrom(clock); const nowMs = atDate.getTime(); const at = atDate.toISOString();
      const workflow = readWorkflow(db, operationId, this.trust);
      if (workflow.submissionMode !== 'BROWSER_WALLET' || !workflow.transactionHash ||
          !['SUBMISSION_UNCERTAIN','SUBMITTED','RECONCILIATION_REQUIRED','CONFIRMED','REVERTED'].includes(workflow.status)) fail('G3C_BROWSER_RECEIPT_STATE_INVALID');
      const authenticReceipt = verifyG3cEvidenceAttestation(receiptEvidence, this.trust); const receipt = authenticReceipt.payload;
      const parent = readParent(db, workflow.executionId);
      if (receipt.kind !== 'RECEIPT' || receipt.executionId !== workflow.executionId || receipt.operationId !== operationId || receipt.chainId !== 8453 ||
          receipt.transactionHash.toLowerCase() !== workflow.transactionHash.toLowerCase() ||
          receipt.sender.toLowerCase() !== workflow.unsignedTransaction.from.toLowerCase() || receipt.nonce !== workflow.unsignedTransaction.nonce) fail('G3C_RECEIPT_MISMATCH');
      if (workflow.status === 'CONFIRMED' || workflow.status === 'REVERTED') {
        if (workflow.receipt && canonicalG3cEvidenceDigest(workflow.receipt) === canonicalG3cEvidenceDigest(authenticReceipt) &&
            settlementSnapshot && workflow.settlementSnapshot && canonicalG3cEvidenceDigest(workflow.settlementSnapshot) === canonicalG3cEvidenceDigest(verifyG3cEvidenceAttestation(settlementSnapshot, this.trust))) return { workflow, replayed: true };
        fail('G3C_RECEIPT_CONFLICT');
      }
      const receiptAttestation = evidence(authenticReceipt, this.trust, nowMs);
      if (receipt.outcome === 'PENDING') {
        const next = nextWorkflow(workflow, { status: 'SUBMITTED', browserStage: 'SUBMITTED', receipt: receiptAttestation }, at);
        writeWorkflow(db, next); writeEvent(db, workflow.executionId, 'D2_BROWSER_RECEIPT_OBSERVED', reason, { operationId, outcome: receipt.outcome }, at);
        return { workflow: next, replayed: false };
      }
      if (receipt.outcome === 'REPLACED' || receipt.outcome === 'CONFLICT') {
        const next = nextWorkflow(workflow, { status: 'RECONCILIATION_REQUIRED', browserStage: 'RECONCILIATION_REQUIRED', receipt: receiptAttestation,
          failureReason: receipt.outcome === 'REPLACED' ? 'TRANSACTION_REPLACED' : 'BROWSER_RECEIPT_CONFLICT' }, at);
        writeWorkflow(db, next); writeEvent(db, workflow.executionId, 'D2_BROWSER_RECONCILIATION_REQUIRED', reason, { operationId, outcome: receipt.outcome }, at);
        return { workflow: next, replayed: false };
      }
      if (receipt.finality !== 'finalized' || receipt.canonical !== true) {
        const next = nextWorkflow(workflow, { status: 'RECONCILIATION_REQUIRED', browserStage: 'RECONCILIATION_REQUIRED', receipt: receiptAttestation,
          failureReason: receipt.canonical === false ? 'RECEIPT_BLOCK_NOT_CANONICAL' : 'WAITING_FOR_FINALITY' }, at);
        writeWorkflow(db, next); writeEvent(db, workflow.executionId, 'D2_BROWSER_RECONCILIATION_REQUIRED', reason, { operationId, finality: receipt.finality, canonical: receipt.canonical }, at);
        return { workflow: next, replayed: false };
      }
      if (!settlementSnapshot) fail('G3C_SETTLEMENT_SNAPSHOT_REQUIRED');
      const settledEvidence = snapshotForSettlement(settlementSnapshot, this.trust, nowMs, parent.walletAddress);
      const settledSnapshot = accountPayload(settledEvidence); const session = readSession(db, workflow.sessionId, this.trust);
      if (settledSnapshot.accountVersion !== session.latestAccountVersion + 1 || settledSnapshot.blockFinality !== 'finalized' ||
          BigInt(settledSnapshot.blockNumber) < BigInt(receipt.blockNumber!)) fail('G3C_SETTLEMENT_SNAPSHOT_STALE');
      const actualFees = BigInt(receipt.actualFeeUsdcMicros!); const actualGasUsed = BigInt(receipt.gasUsed!);
      const actualEffectiveGasPrice = BigInt(receipt.effectiveGasPriceWei!); const actualL1Fee = BigInt(receipt.l1FeeWei!); const actualOperatorFee = BigInt(receipt.operatorFeeWei!);
      if (actualGasUsed <= 0n || actualGasUsed > BigInt(workflow.unsignedTransaction.gasLimit) || actualEffectiveGasPrice <= 0n ||
          actualEffectiveGasPrice > BigInt(workflow.unsignedTransaction.maxFeePerGasWei) || actualGasUsed * actualEffectiveGasPrice + actualL1Fee + actualOperatorFee <= 0n) fail('G3C_RECEIPT_FEE_COMPONENTS_INVALID');
      const startValue = BigInt(accountPayload(workflow.accountSnapshot).walletValueUsdcMicros); const endValue = BigInt(settledSnapshot.walletValueUsdcMicros);
      const lossBeforeFees = startValue > endValue ? startValue - endValue : 0n; const actualLoss = lossBeforeFees > actualFees ? lossBeforeFees - actualFees : 0n;
      const remainingReserve = BigInt(session.outstandingWorstCaseReservationsUsdcMicros) - BigInt(workflow.reservedWorstCaseLossUsdcMicros);
      if (remainingReserve < 0n) fail('G3C_SESSION_ACCOUNTING_CORRUPT');
      const accountingBase = { ...session, realizedLossUsdcMicros: (BigInt(session.realizedLossUsdcMicros) + actualLoss).toString(),
        realizedFeesUsdcMicros: (BigInt(session.realizedFeesUsdcMicros) + actualFees).toString(),
        outstandingWorstCaseReservationsUsdcMicros: remainingReserve.toString() };
      const accounting = accountSessionSnapshot(accountingBase, settledSnapshot, actualFees > G3C_CAPS.feeUsdcMicros);
      const nextSessionRecord = nextSession(session, { status: accounting.status,
        realizedLossUsdcMicros: accountingBase.realizedLossUsdcMicros, realizedFeesUsdcMicros: accountingBase.realizedFeesUsdcMicros,
        unrealizedLossUsdcMicros: accounting.unrealizedLossUsdcMicros,
        outstandingWorstCaseReservationsUsdcMicros: remainingReserve.toString(), markedExposureUsdcMicros: accounting.markedExposureUsdcMicros,
        latestAccountVersion: settledSnapshot.accountVersion, latestSnapshotDigest: canonicalG3cEvidenceDigest(settledEvidence), latestSnapshot: settledEvidence }, at);
      writeSession(db, nextSessionRecord);
      const status = receipt.outcome === 'CONFIRMED' ? 'CONFIRMED' : 'REVERTED';
      const next = nextWorkflow(workflow, { status, browserStage: status, receipt: receiptAttestation, settlementSnapshot: settledEvidence,
        actualFeesUsdcMicros: actualFees.toString(), actualLossUsdcMicros: actualLoss.toString(),
        failureReason: status === 'REVERTED' ? 'EXACT_TRANSACTION_REVERTED' : null }, at);
      writeWorkflow(db, next);
      if (workflow.kind === 'SWAP' || status === 'REVERTED') releaseParent(db, parent,
        status === 'CONFIRMED' ? 'D2_BROWSER_FINALIZED_AND_RECONCILED' : 'D2_BROWSER_FINALIZED_REVERT_RECONCILED', at);
      writeEvent(db, workflow.executionId, status === 'CONFIRMED' ? 'D2_BROWSER_SETTLEMENT_CONFIRMED' : 'D2_BROWSER_SETTLEMENT_REVERTED', reason,
        { operationId, transactionHash: workflow.transactionHash, actualFeesUsdcMicros: actualFees.toString(), actualLossUsdcMicros: actualLoss.toString(),
          blockNumber: receipt.blockNumber, blockHash: receipt.blockHash }, at);
      if (accounting.status === 'STOPPED' && session.status !== 'STOPPED') writeEvent(db, workflow.executionId, 'G3C_SESSION_STOPPED',
        accounting.stopReasons.join('|'), { sessionId: session.sessionId, projectedLossUsdcMicros: accounting.projectedLossUsdcMicros }, at);
      return { workflow: next, replayed: false };
    });
  }
  claimForSigning(operationId: string, currentAccountSnapshot: G3cEvidenceAttestation, reason: string): G3cSigningRequest {
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 240) fail('G3C_INVALID_REASON');
    const testAllowed = this.options.allowTestSigning === true && process.env.NODE_ENV === 'test' &&
      this.trust.environment === 'synthetic-test' && this.trust.allowSyntheticTestEvidence === true;
    const productionAllowed = productionModeAllowed(this.options.enableProductionSigning === true) && this.trust.environment === 'production';
    if (!testAllowed && !productionAllowed) fail('G3C_SIGNING_DISABLED');
    return this.execution.g3bTransaction((db, clock) => {
      const atDate = nowFrom(clock); const nowMs = atDate.getTime(); const at = atDate.toISOString();
      const workflow = readWorkflow(db, operationId, this.trust);
      const parent = readParent(db, workflow.executionId);
      const session = readSession(db, workflow.sessionId, this.trust);
      if (killSwitchStopped(db) || session.status !== 'ACTIVE') fail('KILL_SWITCH_STOPPED');
      if (workflow.submissionMode !== 'APPLICATION_SIGNER' || workflow.status !== 'AUTHORIZED' || parent.status !== 'RESERVED' ||
          Date.parse(parent.intent.expiresAt) <= nowMs || workflow.intentExpiresAt !== parent.intent.expiresAt) fail('G3C_SIGNING_CLAIM_INVALID');
      const current = evidence(currentAccountSnapshot, this.trust, nowMs);
      if (current.payload.kind !== 'ACCOUNT_SNAPSHOT' || current.payload.accountVersion !== workflow.accountVersion ||
          (current.payload.blockFinality !== 'unsafe' && current.payload.blockFinality !== 'safe' && current.payload.blockFinality !== 'finalized') ||
          !sameAccountState(accountPayload(current), accountPayload(workflow.accountSnapshot))) fail('G3C_ACCOUNT_VERSION_STALE');
      for (const item of [workflow.accountSnapshot, workflow.quote, workflow.simulation, workflow.fee].filter(Boolean)) {
        assertFreshG3cEvidence(item!, nowMs);
      }
      reserveRow(db, parent);
      const claimId = randomUUID();
      const next = nextWorkflow(workflow, { status: 'SIGNING_CLAIMED', signingClaimId: claimId, claimedAt: at, signingAccountSnapshot: current }, at);
      writeWorkflow(db, next);
      writeEvent(db, workflow.executionId, 'G3C_SIGNING_CLAIMED', reason, {
        operationId, claimId, accountVersion: workflow.accountVersion, authorizationId: workflow.authorizationId,
      }, at);
      return { version: 1, requestId: randomUUID(), requestAt: at, parent, workflow: next, session, killSwitch: killSwitchState(db), signingClaimId: claimId, accountVersion: workflow.accountVersion };
    });
  }

  async persistSigned(operationId: string, signedBytesHex: string, transactionHash: string, reason: string): Promise<G3cWorkflowWriteResult> {
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 240 ||
        typeof signedBytesHex !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/u.test(signedBytesHex) ||
        typeof transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/u.test(transactionHash)) fail('G3C_SIGNED_RESULT_INVALID');
    const initial = this.getWorkflow(operationId);
    if (initial.status !== 'SIGNING_CLAIMED') fail('G3C_SIGNING_CLAIM_MISSING');
    const normalized = signedBytesHex.toLowerCase();
    const decoded = await validateSignedG3bTransaction(normalized as Hex, initial.unsignedTransaction);
    if (decoded.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) fail('G3C_SIGNED_HASH_MISMATCH');
    return this.execution.g3bTransaction((db, clock) => {
      const atDate = nowFrom(clock); const at = atDate.toISOString(); const nowMs = atDate.getTime();
      const workflow = readWorkflow(db, operationId, this.trust);
      if (workflow.status !== 'SIGNING_CLAIMED' || !workflow.signingClaimId || !workflow.claimedAt ||
          Date.parse(workflow.claimedAt) > nowMs || Date.parse(workflow.intentExpiresAt) <= nowMs) fail('G3C_SIGNING_CLAIM_MISSING');
      const parent = readParent(db, workflow.executionId); reserveRow(db, parent);
      for (const item of [workflow.accountSnapshot, workflow.signingAccountSnapshot, workflow.quote, workflow.simulation, workflow.fee].filter(Boolean)) assertFreshG3cEvidence(item!, nowMs);
      const digest = createHash('sha256').update(Buffer.from(normalized.slice(2), 'hex')).digest('hex');
      const next = nextWorkflow(workflow, { status: 'SIGNED_OUTBOX', signedBytesHex: normalized, signedBytesDigest: digest,
        transactionHash: decoded.transactionHash.toLowerCase() as Hex }, at);
      writeWorkflow(db, next);
      writeEvent(db, workflow.executionId, 'G3C_SIGNED_BYTES_PERSISTED', reason, {
        operationId, transactionHash: next.transactionHash, signedBytesDigest: digest, transactionDigest: workflow.transactionDigest,
      }, at);
      return { workflow: next, replayed: false };
    });
  }

  prepareBroadcast(operationId: string, reason: string): G3cBroadcastRelease {
    const testAllowed = this.options.allowTestBroadcast === true && process.env.NODE_ENV === 'test' &&
      this.trust.environment === 'synthetic-test' && this.trust.allowSyntheticTestEvidence === true;
    const productionAllowed = productionModeAllowed(this.options.enableProductionBroadcast === true) && this.trust.environment === 'production';
    if (!testAllowed && !productionAllowed) fail('G3C_BROADCAST_DISABLED');
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 240) fail('G3C_INVALID_REASON');
    return this.execution.g3bTransaction((db, clock) => {
      const atDate = nowFrom(clock); const nowMs = atDate.getTime(); const at = atDate.toISOString();
      const workflow = readWorkflow(db, operationId, this.trust);
      if (!workflow.signedBytesHex || !workflow.transactionHash ||
          !['SIGNED_OUTBOX','SUBMISSION_UNCERTAIN'].includes(workflow.status)) fail('G3C_OUTBOX_NOT_READY');
      if (killSwitchStopped(db)) fail('KILL_SWITCH_STOPPED');
      if (Date.parse(workflow.intentExpiresAt) <= nowMs) fail('G3C_INTENT_EXPIRED');
      const parent = readParent(db, workflow.executionId); reserveRow(db, parent);
      const replayed = workflow.status === 'SUBMISSION_UNCERTAIN' && workflow.submissionAttempts > 0;
      for (const item of [workflow.accountSnapshot, workflow.signingAccountSnapshot, workflow.quote, workflow.simulation, workflow.fee].filter(Boolean)) assertFreshG3cEvidence(item!, nowMs);
      const attempt = workflow.submissionAttempts + 1;
      const next = nextWorkflow(workflow, { status: 'SUBMISSION_UNCERTAIN', submissionAttempts: attempt }, at);
      writeWorkflow(db, next);
      writeEvent(db, workflow.executionId, 'G3C_BROADCAST_BYTES_RELEASED', reason, {
        operationId, attempt, transactionHash: workflow.transactionHash, signedBytesDigest: workflow.signedBytesDigest,
      }, at);
      return { operationId, transactionHash: workflow.transactionHash, signedBytesHex: workflow.signedBytesHex, attempt, replayed };
    });
  }

  recordSubmissionAccepted(operationId: string, transactionHash: string, acceptedAt: string, reason: string): G3cWorkflowWriteResult {
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 240) fail('G3C_INVALID_REASON');
    return this.execution.g3bTransaction((db, clock) => {
      const now = nowFrom(clock); const at = now.toISOString(); const workflow = readWorkflow(db, operationId, this.trust);
      if (!canonicalDate(acceptedAt) || Date.parse(acceptedAt) > now.getTime() ||
          workflow.transactionHash?.toLowerCase() !== transactionHash.toLowerCase() ||
          !['SUBMISSION_UNCERTAIN','SUBMITTED'].includes(workflow.status)) fail('G3C_SUBMISSION_MISMATCH');
      if (workflow.status === 'SUBMITTED') return { workflow, replayed: true };
      const next = nextWorkflow(workflow, { status: 'SUBMITTED' }, at);
      writeWorkflow(db, next);
      writeEvent(db, workflow.executionId, 'G3C_SUBMISSION_ACCEPTED', reason, {
        operationId, transactionHash, acceptedAt, attempt: workflow.submissionAttempts,
      }, at);
      return { workflow: next, replayed: false };
    });
  }

  recordReceipt(operationId: string, receiptEvidence: G3cEvidenceAttestation,
    settlementSnapshot?: G3cEvidenceAttestation | null, reason = 'G3c receipt reconciliation'): G3cWorkflowWriteResult {
    if (!reason.trim() || reason.length > 240) fail('G3C_INVALID_REASON');
    return this.execution.g3bTransaction((db, clock) => {
      const atDate = nowFrom(clock); const nowMs = atDate.getTime(); const at = atDate.toISOString();
      const workflow = readWorkflow(db, operationId, this.trust);
      if (workflow.submissionMode !== 'APPLICATION_SIGNER' || !workflow.transactionHash || !workflow.signedBytesHex ||
          !['SUBMISSION_UNCERTAIN','SUBMITTED','RECONCILIATION_REQUIRED','CONFIRMED','REVERTED'].includes(workflow.status)) fail('G3C_RECEIPT_STATE_INVALID');
      const authenticReceipt = verifyG3cEvidenceAttestation(receiptEvidence, this.trust);
      const receipt = authenticReceipt.payload;
      const parent = readParent(db, workflow.executionId);
      if (receipt.kind !== 'RECEIPT' || receipt.executionId !== workflow.executionId || receipt.operationId !== operationId ||
          receipt.chainId !== 8453 || receipt.transactionHash.toLowerCase() !== workflow.transactionHash.toLowerCase() ||
          receipt.sender.toLowerCase() !== workflow.unsignedTransaction.from.toLowerCase() ||
          receipt.nonce !== workflow.unsignedTransaction.nonce) fail('G3C_RECEIPT_MISMATCH');
      if (workflow.status === 'CONFIRMED' || workflow.status === 'REVERTED') {
        if (canonicalG3cEvidenceDigest(workflow.receipt!) === canonicalG3cEvidenceDigest(authenticReceipt) &&
            settlementSnapshot && workflow.settlementSnapshot &&
            canonicalG3cEvidenceDigest(workflow.settlementSnapshot) === canonicalG3cEvidenceDigest(verifyG3cEvidenceAttestation(settlementSnapshot, this.trust))) return { workflow, replayed: true };
        fail('G3C_RECEIPT_CONFLICT');
      }
      const receiptAttestation = evidence(authenticReceipt, this.trust, nowMs);
      if (receipt.outcome === 'PENDING') {
        const pending = nextWorkflow(workflow, { status: 'SUBMISSION_UNCERTAIN', receipt: receiptAttestation }, at);
        writeWorkflow(db, pending);
        writeEvent(db, workflow.executionId, 'G3C_RECEIPT_OBSERVED', reason, { operationId, outcome: receipt.outcome }, at);
        return { workflow: pending, replayed: false };
      }
      if (receipt.outcome === 'REPLACED' || receipt.outcome === 'CONFLICT') {
        const mismatch = nextWorkflow(workflow, { status: 'RECONCILIATION_REQUIRED', receipt: receiptAttestation,
          failureReason: receipt.outcome === 'REPLACED' ? 'TRANSACTION_REPLACED' : 'RECEIPT_CONFLICT' }, at);
        writeWorkflow(db, mismatch);
        writeEvent(db, workflow.executionId, 'G3C_RECONCILIATION_REQUIRED', reason, { operationId, outcome: receipt.outcome }, at);
        return { workflow: mismatch, replayed: false };
      }
      if (receipt.finality !== 'finalized' || receipt.canonical !== true) {
        const awaiting = nextWorkflow(workflow, { status: 'RECONCILIATION_REQUIRED', receipt: receiptAttestation,
          failureReason: receipt.canonical === false ? 'RECEIPT_BLOCK_NOT_CANONICAL' : 'WAITING_FOR_FINALITY' }, at);
        writeWorkflow(db, awaiting);
        writeEvent(db, workflow.executionId, 'G3C_RECONCILIATION_REQUIRED', reason, {
          operationId, finality: receipt.finality, canonical: receipt.canonical,
        }, at);
        return { workflow: awaiting, replayed: false };
      }
      if (!settlementSnapshot) fail('G3C_SETTLEMENT_SNAPSHOT_REQUIRED');
      const settledSnapshotEvidence = snapshotForSettlement(settlementSnapshot, this.trust, nowMs, parent.walletAddress);
      const settledSnapshot = accountPayload(settledSnapshotEvidence);
      const session = readSession(db, workflow.sessionId, this.trust);
      if (settledSnapshot.accountVersion !== session.latestAccountVersion + 1 ||
          settledSnapshot.blockFinality !== 'finalized' ||
          BigInt(settledSnapshot.blockNumber) < BigInt(receipt.blockNumber!)) fail('G3C_SETTLEMENT_SNAPSHOT_STALE');
      const actualFees = BigInt(receipt.actualFeeUsdcMicros!);
      const actualGasUsed = BigInt(receipt.gasUsed!);
      const actualEffectiveGasPrice = BigInt(receipt.effectiveGasPriceWei!);
      const actualL1Fee = BigInt(receipt.l1FeeWei!);
      const actualOperatorFee = BigInt(receipt.operatorFeeWei!);
      if (actualGasUsed <= 0n || actualGasUsed > BigInt(workflow.unsignedTransaction.gasLimit) || actualEffectiveGasPrice <= 0n ||
          actualEffectiveGasPrice > BigInt(workflow.unsignedTransaction.maxFeePerGasWei) ||
          actualGasUsed * actualEffectiveGasPrice + actualL1Fee + actualOperatorFee <= 0n) fail('G3C_RECEIPT_FEE_COMPONENTS_INVALID');
      const startValue = BigInt(accountPayload(workflow.accountSnapshot).walletValueUsdcMicros);
      const endValue = BigInt(settledSnapshot.walletValueUsdcMicros);
      const lossBeforeFees = startValue > endValue ? startValue - endValue : 0n;
      const actualLoss = lossBeforeFees > actualFees ? lossBeforeFees - actualFees : 0n;
      const remainingReserve = BigInt(session.outstandingWorstCaseReservationsUsdcMicros) - BigInt(workflow.reservedWorstCaseLossUsdcMicros);
      if (remainingReserve < 0n) fail('G3C_SESSION_ACCOUNTING_CORRUPT');
      const realizedLossUsdcMicros = (BigInt(session.realizedLossUsdcMicros) + actualLoss).toString();
      const realizedFeesUsdcMicros = (BigInt(session.realizedFeesUsdcMicros) + actualFees).toString();
      const accountingBase = { ...session, realizedLossUsdcMicros, realizedFeesUsdcMicros,
        outstandingWorstCaseReservationsUsdcMicros: remainingReserve.toString() };
      const accounting = accountSessionSnapshot(accountingBase, settledSnapshot, actualFees > G3C_CAPS.feeUsdcMicros);
      const sessionStatus = accounting.status;
      const nextSessionRecord = nextSession(session, {
        status: sessionStatus, realizedLossUsdcMicros, realizedFeesUsdcMicros,
        unrealizedLossUsdcMicros: accounting.unrealizedLossUsdcMicros,
        outstandingWorstCaseReservationsUsdcMicros: remainingReserve.toString(),
        markedExposureUsdcMicros: accounting.markedExposureUsdcMicros,
        latestAccountVersion: settledSnapshot.accountVersion,
        latestSnapshotDigest: canonicalG3cEvidenceDigest(settledSnapshotEvidence), latestSnapshot: settledSnapshotEvidence,
      }, at);
      writeSession(db, nextSessionRecord);
      const status = receipt.outcome === 'CONFIRMED' ? 'CONFIRMED' : 'REVERTED';
      const next = nextWorkflow(workflow, { status, receipt: receiptAttestation, settlementSnapshot: settledSnapshotEvidence,
        actualFeesUsdcMicros: actualFees.toString(), actualLossUsdcMicros: actualLoss.toString(),
        failureReason: status === 'REVERTED' ? 'EXACT_TRANSACTION_REVERTED' : null }, at);
      writeWorkflow(db, next);
      if (workflow.kind === 'SWAP' || status === 'REVERTED') releaseParent(db, parent,
        status === 'CONFIRMED' ? 'G3C_FINALIZED_AND_RECONCILED' : 'G3C_FINALIZED_REVERT_RECONCILED', at);
      writeEvent(db, workflow.executionId, status === 'CONFIRMED' ? 'G3C_SETTLEMENT_CONFIRMED' : 'G3C_SETTLEMENT_REVERTED', reason, {
        operationId, transactionHash: workflow.transactionHash, actualFeesUsdcMicros: actualFees.toString(),
        actualLossUsdcMicros: actualLoss.toString(), blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
      }, at);
      if (sessionStatus === 'STOPPED' && session.status !== 'STOPPED') writeEvent(db, workflow.executionId, 'G3C_SESSION_STOPPED', accounting.stopReasons.join('|'), { sessionId: session.sessionId, projectedLossUsdcMicros: accounting.projectedLossUsdcMicros }, at);
      return { workflow: next, replayed: false };
    });
  }

  recordFundingAdjustment(sessionId: string, adjustmentEvidence: G3cEvidenceAttestation,
    accountSnapshot: G3cEvidenceAttestation, reason: string): G3cSession {
    if (!reason.trim() || reason.length > 240) fail('G3C_INVALID_REASON');
    return this.execution.g3bTransaction((db, clock) => {
      const atDate = nowFrom(clock); const nowMs = atDate.getTime(); const at = atDate.toISOString();
      const session = readSession(db, sessionId, this.trust);
      if (session.status !== 'ACTIVE' || !session.latestSnapshot || BigInt(session.outstandingWorstCaseReservationsUsdcMicros) !== 0n) fail('G3C_FUNDING_ADJUSTMENT_NOT_ALLOWED');
      const checkedAdjustment = evidence(adjustmentEvidence, this.trust, nowMs);
      const source = checkedAdjustment.payload;
      const sourceDigest = canonicalG3cEvidenceDigest(checkedAdjustment);
      if (session.externalFundingAdjustments.some((item) => item.sourceDigest === sourceDigest)) fail('G3C_FUNDING_ADJUSTMENT_DUPLICATE');
      const afterEvidence = evidence(accountSnapshot, this.trust, nowMs);
      const before = accountPayload(session.latestSnapshot);
      const after = accountPayload(afterEvidence);
      if (source.kind !== 'FUNDING_ADJUSTMENT' || source.chainId !== 8453 ||
          source.walletAddress.toLowerCase() !== session.walletAddress.toLowerCase() ||
          after.walletAddress.toLowerCase() !== session.walletAddress.toLowerCase() ||
          after.accountVersion !== session.latestAccountVersion + 1 ||
          BigInt(after.blockNumber) < BigInt(source.blockNumber) ||
          after.blockFinality !== 'finalized' ||
          BigInt(after.wethBalanceAtomic) !== BigInt(before.wethBalanceAtomic) ||
          BigInt(after.usdcBalanceAtomic) !== (source.direction === 'DEPOSIT'
            ? BigInt(before.usdcBalanceAtomic) + BigInt(source.amountAtomic)
            : BigInt(before.usdcBalanceAtomic) - BigInt(source.amountAtomic))) fail('G3C_FUNDING_EVIDENCE_MISMATCH');
      const delta = BigInt(source.amountAtomic) * (source.direction === 'DEPOSIT' ? 1n : -1n);
      if (session.externalFundingAdjustments.length >= 1000) fail('G3C_FUNDING_ADJUSTMENT_LIMIT');
      const entry = { adjustmentId: randomUUID(), deltaUsdcMicros: delta.toString(),
        sourceDigest, sourceEvidence: checkedAdjustment, recordedAt: at };
      const externalFundingAdjustments = [...session.externalFundingAdjustments, entry];
      const accountingBase = { ...session, externalFundingAdjustments };
      const accounting = accountSessionSnapshot(accountingBase, after);
      const digest = canonicalG3cEvidenceDigest(afterEvidence);
      const next = nextSession(session, {
        externalFundingAdjustments, unrealizedLossUsdcMicros: accounting.unrealizedLossUsdcMicros,
        latestAccountVersion: after.accountVersion, latestSnapshotDigest: digest, latestSnapshot: afterEvidence,
        markedExposureUsdcMicros: accounting.markedExposureUsdcMicros, status: accounting.status,
      }, at);
      writeSession(db, next);
      writeEvent(db, session.sessionId, 'G3C_ACCOUNT_REFRESHED', reason, {
        sessionId, adjustmentId: entry.adjustmentId, deltaUsdcMicros: entry.deltaUsdcMicros,
        sourceDigest: entry.sourceDigest, sourceEvidence: checkedAdjustment, accountVersion: after.accountVersion,
      }, at);
      if (accounting.status === 'STOPPED') writeEvent(db, sessionId, 'G3C_SESSION_STOPPED', accounting.stopReasons.join('|'), { sessionId, projectedLossUsdcMicros: accounting.projectedLossUsdcMicros }, at);
      return next;
    });
  }

  cancelOperation(operationId: string, reason: string): G3cWorkflowWriteResult {
    if (!reason.trim() || reason.length > 240) fail('G3C_INVALID_REASON');
    return this.execution.g3bTransaction((db, clock) => {
      const at = nowFrom(clock).toISOString(); const workflow = readWorkflow(db, operationId, this.trust);
      if (workflow.status === 'CANCELLED') return { workflow, replayed: true };
      if (workflow.status !== 'AUTHORIZED' || workflow.signingClaimId || workflow.signedBytesHex) fail('G3C_CANCEL_AFTER_SIGNING');
      const session = readSession(db, workflow.sessionId, this.trust);
      const remaining = BigInt(session.outstandingWorstCaseReservationsUsdcMicros) - BigInt(workflow.reservedWorstCaseLossUsdcMicros);
      if (remaining < 0n) fail('G3C_SESSION_ACCOUNTING_CORRUPT');
      const parent = readParent(db, workflow.executionId); reserveRow(db, parent);
      const next = nextWorkflow(workflow, { status: 'CANCELLED', failureReason: reason }, at);
      const nextSessionRecord = nextSession(session, { outstandingWorstCaseReservationsUsdcMicros: remaining.toString() }, at);
      writeSession(db, nextSessionRecord); writeWorkflow(db, next);
      releaseParent(db, parent, 'G3C_CANCELLED_BEFORE_SIGNING', at);
      writeEvent(db, workflow.executionId, 'G3C_RECONCILIATION_REQUIRED', reason, { operationId, cancelledBeforeSigning: true }, at);
      return { workflow: next, replayed: false };
    });
  }

  releaseAfterBrowserApproval(executionId: string, currentAccountSnapshot: G3cEvidenceAttestation, reason: string): void {
    this.releaseAfterApprovalOnly(executionId, currentAccountSnapshot, reason, true);
  }

  releaseAfterApprovalOnly(executionId: string, currentAccountSnapshot: G3cEvidenceAttestation, reason: string, browserEarly = false): void {
    if (!reason.trim() || reason.length > 240) fail('G3C_INVALID_REASON');
    this.execution.g3bTransaction((db, clock) => {
      const atDate = nowFrom(clock); const at = atDate.toISOString(); const nowMs = atDate.getTime();
      const parent = readParent(db, executionId);
      if (parent.status === 'RELEASED') return;
      const rows = db.prepare('SELECT operation_id FROM execution_g3c_workflows WHERE execution_id = ? ORDER BY created_at,operation_id')
        .all(executionId) as SqlRow[];
      const workflows = rows.map((row) => readWorkflow(db, String(row.operation_id), this.trust));
      const unresolved = workflows.filter((workflow) => !['CONFIRMED','REVERTED','CANCELLED'].includes(workflow.status));
      const browserOnly = workflows.length > 0 && workflows.every((workflow) => workflow.submissionMode === 'BROWSER_WALLET');
      if (unresolved.length !== 0 || workflows.length === 0 || workflows.some((workflow) => workflow.kind !== 'APPROVAL' || workflow.status !== 'CONFIRMED') ||
          (Date.parse(parent.intent.expiresAt) > nowMs && !(browserEarly && browserOnly))) fail('G3C_EXECUTION_NOT_RELEASABLE');
      const session = readSession(db, workflows[workflows.length - 1]!.sessionId, this.trust);
      if (!session.latestSnapshot || BigInt(session.outstandingWorstCaseReservationsUsdcMicros) !== 0n) fail('G3C_SESSION_RECONCILIATION_REQUIRED');
      const checked = evidence(currentAccountSnapshot, this.trust, nowMs); const snapshot = accountPayload(checked);
      const lastApprovalBlock = workflows.reduce((latestBlock, workflow) => {
        const receipt = workflow.receipt?.payload;
        if (!receipt || receipt.kind !== 'RECEIPT' || receipt.outcome !== 'CONFIRMED' ||
            receipt.finality !== 'finalized' || receipt.canonical !== true || receipt.blockNumber === null ||
            receipt.nonce !== workflow.unsignedTransaction.nonce) fail('G3C_APPROVAL_RECEIPT_REQUIRED');
        const blockNumber = BigInt(receipt.blockNumber);
        return blockNumber > latestBlock ? blockNumber : latestBlock;
      }, 0n);
      const lastApprovalNonce = workflows.reduce((latestNonce, workflow) => {
        const nonce = BigInt(workflow.unsignedTransaction.nonce);
        return nonce > latestNonce ? nonce : latestNonce;
      }, 0n);
      const expectedToken = parent.intent.sellAsset === 'USDC' ? BASE_TOKENS.USDC : BASE_TOKENS.WETH;
      if (snapshot.walletAddress.toLowerCase() !== parent.walletAddress.toLowerCase() || snapshot.accountVersion !== session.latestAccountVersion + 1 ||
          snapshot.blockFinality !== 'finalized' || BigInt(snapshot.blockNumber) < lastApprovalBlock ||
          BigInt(snapshot.pendingNonce) <= lastApprovalNonce || snapshot.allowanceToken.toLowerCase() !== expectedToken.toLowerCase() ||
          snapshot.allowanceSpender.toLowerCase() !== BASE_UNISWAP_V3.router.toLowerCase() ||
          BigInt(snapshot.allowanceAtomic) > BigInt(parent.transaction.amountIn) ||
          (browserEarly && BigInt(snapshot.allowanceAtomic) !== BigInt(parent.transaction.amountIn))) fail('G3C_APPROVAL_ONLY_ACCOUNT_INVALID');
      const accounting = accountSessionSnapshot(session, snapshot);
      const next = nextSession(session, { status: accounting.status,
        unrealizedLossUsdcMicros: accounting.unrealizedLossUsdcMicros,
        latestAccountVersion: snapshot.accountVersion, latestSnapshotDigest: canonicalG3cEvidenceDigest(checked),
        latestSnapshot: checked, markedExposureUsdcMicros: accounting.markedExposureUsdcMicros }, at);
      writeSession(db, next);
      writeEvent(db, executionId, 'G3C_APPROVAL_ONLY_RELEASED', reason, {
        sessionId: session.sessionId, accountVersion: snapshot.accountVersion,
        walletValueUsdcMicros: snapshot.walletValueUsdcMicros, wethExposureUsdcMicros: accounting.markedExposureUsdcMicros,
        unrealizedLossUsdcMicros: accounting.unrealizedLossUsdcMicros, projectedLossUsdcMicros: accounting.projectedLossUsdcMicros,
        sessionStatus: accounting.status, stopReasons: accounting.stopReasons,
        remainingAllowanceAtomic: snapshot.allowanceAtomic, allowanceToken: snapshot.allowanceToken,
        freshPolicyEvaluationRequired: true,
      }, at);
      releaseParent(db, parent, browserEarly ? 'G3C_BROWSER_APPROVAL_FINALIZED' : 'G3C_APPROVAL_ONLY_EXPIRED_OR_STOPPED', at);
      if (accounting.status === 'STOPPED' && session.status !== 'STOPPED') writeEvent(db, session.sessionId, 'G3C_SESSION_STOPPED',
        accounting.stopReasons.join('|'), { executionId, sessionId: session.sessionId, projectedLossUsdcMicros: accounting.projectedLossUsdcMicros }, at);
    });
  }

  stopSession(sessionId: string, reason: string): G3cSession {
    if (!reason.trim() || reason.length > 240) fail('G3C_INVALID_REASON');
    return this.execution.g3bTransaction((db, clock) => {
      const at = nowFrom(clock).toISOString(); const session = readSession(db, sessionId, this.trust);
      if (session.status === 'CLOSED') fail('G3C_SESSION_CLOSED');
      if (session.status === 'STOPPED') return session;
      const stopped = nextSession(session, { status: 'STOPPED' }, at);
      writeSession(db, stopped);
      writeEvent(db, sessionId, 'G3C_SESSION_STOPPED', reason, { sessionId }, at);
      return stopped;
    });
  }

  closeSession(sessionId: string, reason: string): G3cSession {
    if (!reason.trim() || reason.length > 240) fail('G3C_INVALID_REASON');
    return this.execution.g3bTransaction((db, clock) => {
      const at = nowFrom(clock).toISOString(); const session = readSession(db, sessionId, this.trust);
      if (session.status === 'CLOSED') return session;
      if (BigInt(session.outstandingWorstCaseReservationsUsdcMicros) !== 0n) fail('G3C_SESSION_HAS_RESERVED_LOSS');
      const workflows = db.prepare('SELECT operation_id FROM execution_g3c_workflows WHERE session_id = ?').all(sessionId) as SqlRow[];
      for (const row of workflows) {
        const data = readWorkflow(db, String(row.operation_id), this.trust);
        const reservation = db.prepare('SELECT status FROM wallet_reservations WHERE reservation_id = ?').get(data.reservationId) as SqlRow | undefined;
        if (reservation?.status === 'ACTIVE') fail('G3C_SESSION_HAS_ACTIVE_WALLET_RESERVATION');
      }
      const closed = nextSession(session, { status: 'CLOSED' }, at);
      writeSession(db, closed);
      writeEvent(db, sessionId, 'G3C_SESSION_STOPPED', reason, { sessionId, closed: true }, at);
      return closed;
    });
  }

  status(executionId: string): G3cStatusResponse {
    return this.execution.g3bRead((db) => {
      const parent = readParent(db, executionId);
      const row = db.prepare('SELECT operation_id FROM execution_g3c_workflows WHERE execution_id = ? ORDER BY rowid DESC LIMIT 1')
        .get(executionId) as SqlRow | undefined;
      const decisionReasons = parent.decision.reasons.join('; ').slice(0, 240) || 'POLICY_DECISION_RECORDED';
      if (!row) return g3cStatusResponseSchema.parse({
        executionId, inputAsset: parent.intent.sellAsset, requestedAmount: parent.intent.amountIn,
        permittedAmount: parent.decision.approvedAmountIn, policyReason: decisionReasons,
        mode: this.reviewedMode ? 'LIVE_REVIEWED' : 'LIVE_DISABLED', status: 'NOT_STARTED', transactionHash: null, receipt: null,
        actualFeesUsdcMicros: null, evidenceProvenance: [],
      });
      if (Object.keys(this.trust.publicKeys).length === 0) fail('G3C_EVIDENCE_TRUST_UNAVAILABLE');
      const workflow = readWorkflow(db, String(row.operation_id), this.trust);
      const status = workflow.status === 'SUBMITTED' ? 'PENDING' : workflow.status === 'SUBMISSION_UNCERTAIN' ? (workflow.receipt?.payload.kind === 'RECEIPT' && workflow.receipt.payload.outcome === 'PENDING' ? 'PENDING' : 'UNKNOWN') : workflow.status;
      const evidenceItems = [workflow.accountSnapshot, workflow.quote, workflow.simulation, workflow.fee, workflow.receipt].filter(Boolean);
      const provenance = evidenceItems.map((item) => {
        const payload = item!.payload;
        return payload.serviceId + ':' + payload.keyId + ':' + payload.environment;
      });
      return g3cStatusResponseSchema.parse({
        executionId, inputAsset: parent.intent.sellAsset, requestedAmount: parent.intent.amountIn, permittedAmount: parent.decision.approvedAmountIn,
        policyReason: decisionReasons, mode: this.reviewedMode ? 'LIVE_REVIEWED' : 'LIVE_DISABLED', status,
        transactionHash: workflow.transactionHash, receipt: workflow.receipt,
        actualFeesUsdcMicros: ['CONFIRMED','REVERTED'].includes(workflow.status) ? workflow.actualFeesUsdcMicros : null,
        evidenceProvenance: provenance,
      });
    });
  }

  listReconciliationQueue(): readonly G3cWorkflow[] {
    return this.execution.g3bRead((db) => Object.freeze(
      (db.prepare("SELECT operation_id FROM execution_g3c_workflows WHERE status IN ('SIGNING_CLAIMED','SIGNED_OUTBOX','SUBMISSION_UNCERTAIN','SUBMITTED','RECONCILIATION_REQUIRED') ORDER BY created_at,operation_id").all() as SqlRow[])
        .map((row) => readWorkflow(db, String(row.operation_id), this.trust)),
    ));
  }
}

export async function signG3cOperation(
  store: G3cExecutionStore, operationId: string, currentAccountSnapshot: G3cEvidenceAttestation,
  signer: G3cSigner, reason: string,
): Promise<G3cWorkflowWriteResult> {
  const request = store.claimForSigning(operationId, currentAccountSnapshot, reason);
  const result = await signer.sign(request);
  return store.persistSigned(operationId, result.signedBytesHex, result.transactionHash, 'G3c signer returned validated transaction bytes');
}
export async function broadcastG3cOperation(
  store: G3cExecutionStore, operationId: string, broadcaster: G3cBroadcaster, reason: string,
  clock: () => Date = () => new Date(),
): Promise<G3cWorkflowWriteResult> {
  const released = store.prepareBroadcast(operationId, reason);
  let transactionHash: Hex;
  try { transactionHash = await broadcaster.sendRawTransaction(released.signedBytesHex); }
  catch { return { workflow: store.getWorkflow(operationId), replayed: released.replayed }; }
  if (transactionHash.toLowerCase() !== released.transactionHash.toLowerCase()) fail('G3C_BROADCAST_HASH_MISMATCH');
  return store.recordSubmissionAccepted(operationId, transactionHash, clock().toISOString(), 'Broadcaster returned the persisted transaction hash');
}

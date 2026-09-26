import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  decisionSchema, executionAuthorizationEnvelopeSchema, executionKillSwitchSchema,
  executionLifecycleRecordSchema, executionReceiptEvidenceSchema, executionSimulationEvidenceSchema,
  executionSignedOutboxSchema, executionSigningClaimSchema, executionTransactionEnvelopeSchema,
  tradeIntentSchema, type Decision, type ExecutionAuthorizationEnvelope, type ExecutionKillSwitch,
  type ExecutionLifecycleRecord, type ExecutionReceiptEvidence, type ExecutionSimulationEvidence,
  type ExecutionSignedOutbox, type ExecutionTransactionEnvelope, type TradeIntent,
} from '@ered-luin/contracts';
import { assertExecutionLifecycleRecord } from './execution-lifecycle-validation.js';
import {
  initializePaperStore, openPaperStore, PaperStore, PaperStoreError,
  type PaperStoreErrorCode, type PaperStoreOptions,
} from './paper-store.js';

const SIMULATION_FRESHNESS_MS = 15_000;
const AUTHORIZATION_TTL_MS = 15_000;
type SqlRow = Record<string, unknown>;
type Db = import('node:sqlite').DatabaseSync;

export interface CreateExecutionReservationInput {
  readonly executionId: string;
  readonly intent: TradeIntent;
  readonly decision: Decision;
  readonly accountVersion: number;
  readonly reservationExposureUsdcMicros: string;
  readonly transaction: ExecutionTransactionEnvelope;
  readonly reason: string;
}
export interface ExecutionWriteResult { readonly record: ExecutionLifecycleRecord; readonly replayed: boolean; }
export interface PrepareBroadcastResult {
  readonly record: ExecutionLifecycleRecord;
  readonly transactionHash: string;
  readonly signedBytesHex: string;
  readonly attempt: number;
  readonly replayed: boolean;
}
export interface SubmissionAcknowledgement {
  readonly version: 1; readonly chainId: 8453; readonly transactionHash: string;
  readonly transactionDigest: string; readonly chainNonce: string; readonly acceptedAt: string;
}
const submissionAcknowledgementSchema = z.object({
  version: z.literal(1), chainId: z.literal(8453), transactionHash: z.string().regex(/^0x[a-f0-9]{64}$/u),
  transactionDigest: z.string().regex(/^[a-f0-9]{64}$/u), chainNonce: z.string().max(128).regex(/^(0|[1-9][0-9]*)$/u),
  acceptedAt: z.iso.datetime({ offset: true }),
}).strict();

function fail(code: PaperStoreErrorCode): never { throw new PaperStoreError(code); }
function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function nowFrom(clock: () => Date): Date {
  let value: Date;
  try { value = clock(); } catch { return fail('DATABASE_FAILURE'); }
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime())) return fail('DATABASE_FAILURE');
  return value;
}
function canonicalDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const millis = Date.parse(value);
  return Number.isSafeInteger(millis) && new Date(millis).toISOString() === value;
}
function parseRecord(row: SqlRow | undefined): ExecutionLifecycleRecord | null {
  if (!row) return null;
  try {
    const record = executionLifecycleRecordSchema.parse(JSON.parse(String(row.record_json)));
    if (record.executionId !== row.execution_id || record.intentId !== row.intent_id ||
        record.walletAddress.toLowerCase() !== String(row.wallet_address).toLowerCase() ||
        record.reservationId !== row.reservation_id || record.status !== row.status ||
        record.revision !== row.revision || record.createdAt !== row.created_at || record.updatedAt !== row.updated_at) throw new Error();
    assertRecord(record);
    return record;
  } catch { return fail('DATABASE_CORRUPT'); }
}
function assertRecord(record: ExecutionLifecycleRecord): void {
  try {
    assertExecutionLifecycleRecord(record);
  } catch {
    fail('DATABASE_CORRUPT');
  }
}
function readRecord(db: Db, id: string): ExecutionLifecycleRecord {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/iu.test(id)) return fail('EXECUTION_INVALID_INPUT');
  const record = parseRecord(db.prepare('SELECT * FROM execution_lifecycle WHERE execution_id = ?').get(id) as SqlRow | undefined);
  if (!record) return fail('EXECUTION_NOT_FOUND');
  assertRecord(record);
  return record;
}
/** The G3c child workflow owns the parent reservation once any workflow row exists. */
export function assertNoG3cLifecycleOwner(db: Db, executionId: string): void {
  const owner = db.prepare('SELECT 1 AS owned FROM execution_g3c_workflows WHERE execution_id = ? LIMIT 1').get(executionId) as SqlRow | undefined;
  if (owner) fail('EXECUTION_STATE_INVALID');
}
function assertAccountVersion(record: ExecutionLifecycleRecord, version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) return fail('EXECUTION_INVALID_INPUT');
  if (version !== record.accountVersion) return fail('ACCOUNT_VERSION_STALE');
}
function controlFromRow(row: SqlRow | undefined): ExecutionKillSwitch {
  if (!row || (row.stopped !== 0 && row.stopped !== 1)) return fail('DATABASE_CORRUPT');
  const result = executionKillSwitchSchema.safeParse({ version: 1, stopped: row.stopped === 1, reason: row.reason, changedAt: row.changed_at });
  if (!result.success) return fail('DATABASE_CORRUPT');
  return result.data;
}
function appendEvent(db: Db, id: string | null, type: string, reason: string, evidence: unknown, at: string): void {
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 240) return fail('EXECUTION_INVALID_INPUT');
  let payload: string;
  try { payload = JSON.stringify(evidence); } catch { return fail('EXECUTION_INVALID_INPUT'); }
  if (payload.length > 131_072) return fail('EXECUTION_INVALID_INPUT');
  db.prepare('INSERT INTO execution_events (event_id,execution_id,event_type,reason,evidence_json,created_at) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), id, type, reason, payload, at);
}
function persistRecord(db: Db, record: ExecutionLifecycleRecord): void {
  assertRecord(record);
  const result = db.prepare('UPDATE execution_lifecycle SET status = ?, record_json = ?, updated_at = ?, revision = ? WHERE execution_id = ?')
    .run(record.status, JSON.stringify(record), record.updatedAt, record.revision, record.executionId);
  if (result.changes !== 1) return fail('DATABASE_CORRUPT');
}
function nextRecord(record: ExecutionLifecycleRecord, patch: Partial<ExecutionLifecycleRecord>, at: string): ExecutionLifecycleRecord {
  return executionLifecycleRecordSchema.parse({ ...record, ...patch, updatedAt: at, revision: record.revision + 1 });
}
function setReservationStatus(db: Db, id: string, status: 'SETTLED' | 'RELEASED', at: string): void {
  const result = db.prepare("UPDATE wallet_reservations SET status = ?, updated_at = ? WHERE reservation_id = ? AND owner_kind = 'EXECUTION' AND status = 'ACTIVE'")
    .run(status, at, id);
  if (result.changes !== 1) return fail('DATABASE_CORRUPT');
}
function ensureSimulationFresh(evidence: ExecutionSimulationEvidence, record: ExecutionLifecycleRecord, at: Date): void {
  const now = at.getTime(); const simulated = Date.parse(evidence.simulatedAt); const expiry = Date.parse(evidence.expiresAt);
  if (evidence.outcome !== 'PASSED' || evidence.producerId !== 'synthetic-test-adapter' ||
      evidence.executionId !== record.executionId || evidence.transactionDigest !== record.transactionDigest ||
      !canonicalDate(evidence.simulatedAt) || !canonicalDate(evidence.expiresAt) ||
      simulated > now || expiry <= now || now - simulated > SIMULATION_FRESHNESS_MS ||
      expiry <= simulated || expiry - simulated > SIMULATION_FRESHNESS_MS) fail('SIMULATION_INVALID');
}
function ensureAuthorizationFresh(auth: ExecutionAuthorizationEnvelope, record: ExecutionLifecycleRecord, at: Date): void {
  const now = at.getTime();
  const issuedAt = Date.parse(auth.issuedAt);
  const expiresAt = Date.parse(auth.expiresAt);
  if (!canonicalDate(auth.issuedAt) || !canonicalDate(auth.expiresAt) || issuedAt > now || expiresAt <= now ||
      expiresAt > Date.parse(record.transaction.expiresAt) || !record.simulation ||
      auth.transactionDigest !== record.transactionDigest || auth.executionId !== record.executionId ||
      auth.intentId !== record.intentId || auth.decisionId !== record.decisionId ||
      auth.accountVersion !== record.accountVersion || auth.simulationId !== record.simulation.simulationId) fail('AUTHORIZATION_EXPIRED');
  ensureSimulationFresh(record.simulation, record, at);
}

export class ExecutionStore {
  constructor(private readonly state: PaperStore) {}

  get(executionId: string): ExecutionLifecycleRecord {
    return this.state.executionRead((db) => readRecord(db, executionId));
  }

  /** @internal Shared transaction seam for versioned G3b child operations. */
  g3bRead<T>(read: (db: Db) => T): T { return this.state.executionRead(read); }
  /** @internal Orders child-operation claims against the persisted stop control. */
  g3bTransaction<T>(work: (db: Db, clock: () => Date) => T): T { return this.state.executionTransaction(work); }
  getKillSwitch(): ExecutionKillSwitch {
    return this.state.executionRead((db) => controlFromRow(
      db.prepare('SELECT singleton,stopped,reason,changed_at FROM execution_control WHERE singleton = 1').get() as SqlRow | undefined,
    ));
  }
  listReconciliationQueue(): readonly ExecutionLifecycleRecord[] {
    return this.state.executionRead((db) => Object.freeze(
      (db.prepare("SELECT * FROM execution_lifecycle WHERE status IN ('SIGNING_CLAIMED','SIGNED_OUTBOX','SUBMISSION_UNCERTAIN','SUBMITTED') ORDER BY created_at,execution_id").all() as SqlRow[])
        .map((row) => { const record = parseRecord(row); if (!record) return fail('DATABASE_CORRUPT'); assertRecord(record); return record; }),
    ));
  }
  setKillSwitch(stopped: boolean, reason: string): ExecutionKillSwitch {
    if (typeof stopped !== 'boolean' || typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 240) fail('EXECUTION_INVALID_INPUT');
    return this.state.executionTransaction((db, clock) => {
      const at = nowFrom(clock).toISOString();
      const current = controlFromRow(db.prepare('SELECT singleton,stopped,reason,changed_at FROM execution_control WHERE singleton = 1').get() as SqlRow | undefined);
      if (current.stopped === stopped && current.reason === reason) return current;
      db.prepare('UPDATE execution_control SET stopped = ?,reason = ?,changed_at = ? WHERE singleton = 1').run(stopped ? 1 : 0, reason, at);
      appendEvent(db, null, stopped ? 'KILL_SWITCH_STOPPED' : 'KILL_SWITCH_ARMED', reason, { stopped }, at);
      return executionKillSwitchSchema.parse({ version: 1, stopped, reason, changedAt: at });
    });
  }

  reserve(input: CreateExecutionReservationInput): ExecutionWriteResult {
    if (!input || typeof input !== 'object' || Object.keys(input).some((key) =>
      !['executionId','intent','decision','accountVersion','reservationExposureUsdcMicros','transaction','reason'].includes(key))) fail('EXECUTION_INVALID_INPUT');
    const ir = tradeIntentSchema.safeParse(input.intent); const dr = decisionSchema.safeParse(input.decision);
    const tr = executionTransactionEnvelopeSchema.safeParse(input.transaction);
    if (!/^[0-9a-f-]{36}$/iu.test(input.executionId) || !ir.success || !dr.success || !tr.success ||
        !Number.isSafeInteger(input.accountVersion) || input.accountVersion < 0 ||
        typeof input.reservationExposureUsdcMicros !== 'string' || !/^[1-9][0-9]*$/u.test(input.reservationExposureUsdcMicros) ||
        input.reservationExposureUsdcMicros.length > 128 || typeof input.reason !== 'string' || input.reason.trim().length === 0 || input.reason.length > 240) fail('EXECUTION_INVALID_INPUT');
    const intent = ir.data; const decision = dr.data; const tx = tr.data;
    if (decision.intentId !== intent.intentId || decision.requestedAmountIn !== intent.amountIn ||
        !['ALLOW','RESIZE'].includes(decision.status) || !decision.approvedAmountIn ||
        (decision.status === 'ALLOW' && decision.approvedAmountIn !== intent.amountIn) ||
        (decision.status === 'RESIZE' && BigInt(decision.approvedAmountIn) >= BigInt(intent.amountIn)) ||
        tx.walletAddress.toLowerCase() !== intent.walletAddress.toLowerCase() || tx.chainId !== intent.chainId ||
        tx.sellAsset !== intent.sellAsset || tx.buyAsset !== intent.buyAsset || tx.amountIn !== decision.approvedAmountIn ||
        Date.parse(tx.expiresAt) > Date.parse(intent.expiresAt)) fail('EXECUTION_INVALID_INPUT');
    const transactionDigest = sha256(JSON.stringify(tx));
    const payload = {
      version: 1, executionId: input.executionId, intent, decision, accountVersion: input.accountVersion,
      reservationExposureUsdcMicros: input.reservationExposureUsdcMicros, transaction: tx, reason: input.reason,
    };
    const requestDigest = sha256(JSON.stringify(payload));
    return this.state.executionTransaction((db, clock) => {
      const nowDate = nowFrom(clock); const now = nowDate.toISOString();
      const prior = db.prepare('SELECT * FROM execution_lifecycle WHERE execution_id = ? OR intent_id = ?').get(input.executionId, intent.intentId) as SqlRow | undefined;
      if (prior) {
        const existing = parseRecord(prior);
        if (!existing) return fail('DATABASE_CORRUPT');
        if (existing.executionId !== input.executionId || existing.requestDigest !== requestDigest) fail('EXECUTION_ID_CONFLICT');
        return { record: existing, replayed: true };
      }
      if (!canonicalDate(intent.issuedAt) || !canonicalDate(intent.expiresAt) ||
          Date.parse(intent.issuedAt) > nowDate.getTime() || Date.parse(intent.expiresAt) <= nowDate.getTime() ||
          Date.parse(tx.expiresAt) <= nowDate.getTime()) fail('EXECUTION_INVALID_INPUT');
      const reservationId = randomUUID();
      const record = executionLifecycleRecordSchema.parse({
        version: 1, executionId: input.executionId, intentId: intent.intentId, decisionId: decision.decisionId,
        walletAddress: intent.walletAddress.toLowerCase(), intent, decision,
        reservationExposureUsdcMicros: input.reservationExposureUsdcMicros, reservationReason: input.reason,
        accountVersion: input.accountVersion, reservationId, requestDigest, transaction: tx, transactionDigest,
        status: 'RESERVED', simulation: null, authorization: null, signingClaim: null, signedOutbox: null, receipt: null,
        failureReason: null, createdAt: now, updatedAt: now, revision: 1,
      });
      try {
        assertExecutionLifecycleRecord(record);
      } catch {
        fail('EXECUTION_INVALID_INPUT');
      }
      try {
        db.prepare("INSERT INTO wallet_reservations (reservation_id,owner_kind,intent_id,wallet_address,amount_in,exposure_usdc_micros,status,created_at,updated_at) VALUES (?,'EXECUTION',?,?,?,?,'ACTIVE',?,?)")
          .run(reservationId, intent.intentId, record.walletAddress, tx.amountIn, input.reservationExposureUsdcMicros, now, now);
      } catch (error) {
        if (String(error).includes('UNIQUE') || String(error).includes('wallet_reservations_one_active_per_wallet')) fail('EXECUTION_WALLET_BUSY');
        throw error;
      }
      db.prepare('INSERT INTO execution_lifecycle (execution_id,intent_id,wallet_address,reservation_id,status,record_json,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(record.executionId, record.intentId, record.walletAddress, record.reservationId, record.status, JSON.stringify(record), now, now, record.revision);
      appendEvent(db, record.executionId, 'RESERVATION_CREATED', input.reason, {
        reservationId, intentId: record.intentId, decisionId: record.decisionId, accountVersion: record.accountVersion,
        transactionDigest, requestDigest,
      }, now);
      return { record, replayed: false };
    });
  }

  recordSimulation(executionId: string, accountVersion: number, evidence: ExecutionSimulationEvidence, reason: string): ExecutionWriteResult {
    if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 240) fail('EXECUTION_INVALID_INPUT');
    const checked = executionSimulationEvidenceSchema.safeParse(evidence);
    if (!checked.success) fail('SIMULATION_INVALID');
    return this.state.executionTransaction((db, clock) => {
      assertNoG3cLifecycleOwner(db, executionId);
      const current = readRecord(db, executionId); assertAccountVersion(current, accountVersion);
      const nowDate = nowFrom(clock); const now = nowDate.toISOString();
      if (current.status === 'SIMULATED' && current.simulation) {
        if (JSON.stringify(current.simulation) !== JSON.stringify(checked.data)) fail('SIMULATION_INVALID');
        return { record: current, replayed: true };
      }
      if (current.status !== 'RESERVED') fail('EXECUTION_STATE_INVALID');
      ensureSimulationFresh(checked.data, current, nowDate);
      const next = nextRecord(current, { status: 'SIMULATED', simulation: checked.data }, now); persistRecord(db, next);
      appendEvent(db, executionId, 'SIMULATION_ACCEPTED', reason, {
        simulationId: checked.data.simulationId, transactionDigest: current.transactionDigest,
      }, now);
      return { record: next, replayed: false };
    });
  }

  issueAuthorization(executionId: string, accountVersion: number, reason: string): ExecutionWriteResult {
    if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 240) fail('EXECUTION_INVALID_INPUT');
    return this.state.executionTransaction((db, clock) => {
      assertNoG3cLifecycleOwner(db, executionId);
      const current = readRecord(db, executionId); assertAccountVersion(current, accountVersion);
      const nowDate = nowFrom(clock); const now = nowDate.toISOString();
      const control = controlFromRow(db.prepare('SELECT singleton,stopped,reason,changed_at FROM execution_control WHERE singleton = 1').get() as SqlRow | undefined);
      if (control.stopped) fail('KILL_SWITCH_STOPPED');
      if (current.status === 'AUTHORIZED' && current.authorization) {
        ensureAuthorizationFresh(current.authorization, current, nowDate);
        return { record: current, replayed: true };
      }
      if (current.status !== 'SIMULATED' || !current.simulation) fail('EXECUTION_STATE_INVALID');
      ensureSimulationFresh(current.simulation, current, nowDate);
      if (Date.parse(current.transaction.expiresAt) <= nowDate.getTime()) fail('SIMULATION_INVALID');
      const expiresAt = new Date(Math.min(Date.parse(current.transaction.expiresAt), Date.parse(current.simulation.expiresAt), nowDate.getTime() + AUTHORIZATION_TTL_MS)).toISOString();
      const tx = current.transaction;
      const auth: ExecutionAuthorizationEnvelope = executionAuthorizationEnvelopeSchema.parse({
        version: 1, authorizationId: randomUUID(), executionId: current.executionId, intentId: current.intentId,
        decisionId: current.decisionId, accountVersion: current.accountVersion, walletAddress: tx.walletAddress,
        chainId: tx.chainId, router: tx.router, recipient: tx.recipient, sellAsset: tx.sellAsset, buyAsset: tx.buyAsset,
        amountIn: tx.amountIn, minimumAmountOut: tx.minimumAmountOut, valueNativeWei: tx.valueNativeWei,
        maxFeePerGasWei: tx.maxFeePerGasWei, maxPriorityFeePerGasWei: tx.maxPriorityFeePerGasWei,
        maxTotalFeeWei: tx.maxTotalFeeWei, chainNonce: tx.chainNonce, transactionDigest: current.transactionDigest,
        simulationId: current.simulation.simulationId, authorizationNonce: randomUUID(), issuedAt: now, expiresAt,
      });
      const next = nextRecord(current, { status: 'AUTHORIZED', authorization: auth }, now); persistRecord(db, next);
      appendEvent(db, executionId, 'AUTHORIZATION_ISSUED', reason, {
        authorizationId: auth.authorizationId, authorizationNonce: auth.authorizationNonce,
        simulationId: auth.simulationId, transactionDigest: auth.transactionDigest,
      }, now);
      return { record: next, replayed: false };
    });
  }

  claimSigning(executionId: string, authorizationNonce: string, accountVersion: number, reason: string): ExecutionWriteResult {
    if (!/^[0-9a-f-]{36}$/iu.test(authorizationNonce) || typeof reason !== 'string' ||
        reason.trim().length === 0 || reason.length > 240) fail('EXECUTION_INVALID_INPUT');
    return this.state.executionTransaction((db, clock) => {
      assertNoG3cLifecycleOwner(db, executionId);
      const current = readRecord(db, executionId); assertAccountVersion(current, accountVersion);
      const control = controlFromRow(db.prepare('SELECT singleton,stopped,reason,changed_at FROM execution_control WHERE singleton = 1').get() as SqlRow | undefined);
      if (control.stopped) fail('KILL_SWITCH_STOPPED');
      if (current.signingClaim || ['SIGNED_OUTBOX','SUBMISSION_UNCERTAIN','SUBMITTED','CONFIRMED','FAILED'].includes(current.status)) fail('AUTHORIZATION_NONCE_REPLAYED');
      if (current.status !== 'AUTHORIZED' || !current.authorization) fail('EXECUTION_STATE_INVALID');
      const nowDate = nowFrom(clock); const now = nowDate.toISOString();
      ensureAuthorizationFresh(current.authorization, current, nowDate);
      if (current.authorization.authorizationNonce !== authorizationNonce) fail('AUTHORIZATION_NONCE_REPLAYED');
      const claim = executionSigningClaimSchema.parse({
        version: 1, claimId: randomUUID(), authorizationNonce, accountVersion: current.accountVersion, claimedAt: now,
      });
      const next = nextRecord(current, { status: 'SIGNING_CLAIMED', signingClaim: claim }, now); persistRecord(db, next);
      appendEvent(db, executionId, 'SIGNING_CLAIMED', reason, {
        claimId: claim.claimId, authorizationNonce, transactionDigest: current.transactionDigest,
      }, now);
      return { record: next, replayed: false };
    });
  }

  persistSignedOutbox(executionId: string, accountVersion: number, signedBytesHex: string, transactionHash: string, reason: string): ExecutionWriteResult {
    if (typeof signedBytesHex !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/u.test(signedBytesHex) ||
        signedBytesHex.length > 65_538 || typeof transactionHash !== 'string' || !/^0x[a-f0-9]{64}$/u.test(transactionHash) || typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 240) fail('EXECUTION_INVALID_INPUT');
    return this.state.executionTransaction((db, clock) => {
      assertNoG3cLifecycleOwner(db, executionId);
      const current = readRecord(db, executionId); assertAccountVersion(current, accountVersion);
      const now = nowFrom(clock).toISOString(); const bytesHex = signedBytesHex.toLowerCase();
      const bytes = Buffer.from(bytesHex.slice(2), 'hex'); const digest = sha256(bytes); const hash = transactionHash;
      if (current.signedOutbox) {
        if (current.signedOutbox.signedBytesHex !== bytesHex || current.signedOutbox.transactionHash !== hash) fail('EXECUTION_ID_CONFLICT');
        return { record: current, replayed: true };
      }
      if (current.status !== 'SIGNING_CLAIMED' || !current.signingClaim) fail('EXECUTION_STATE_INVALID');
      const outbox: ExecutionSignedOutbox = executionSignedOutboxSchema.parse({
        version: 1, transactionDigest: current.transactionDigest, chainId: current.transaction.chainId,
        chainNonce: current.transaction.chainNonce, transactionHash: hash, signedBytesDigest: digest,
        signedBytesHex: bytesHex, persistedAt: now, broadcastAttempts: 0,
      });
      const next = nextRecord(current, { status: 'SIGNED_OUTBOX', signedOutbox: outbox }, now); persistRecord(db, next);
      appendEvent(db, executionId, 'SIGNED_BYTES_PERSISTED', reason, {
        claimId: current.signingClaim.claimId, transactionHash: hash, signedBytesDigest: digest,
        transactionDigest: current.transactionDigest,
      }, now);
      return { record: next, replayed: false };
    });
  }

  prepareBroadcast(executionId: string, reason: string): PrepareBroadcastResult {
    if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 240) fail('EXECUTION_INVALID_INPUT');
    return this.state.executionTransaction((db, clock) => {
      assertNoG3cLifecycleOwner(db, executionId);
      const current = readRecord(db, executionId);
      if (!current.signedOutbox || !['SIGNED_OUTBOX','SUBMISSION_UNCERTAIN'].includes(current.status)) fail('EXECUTION_STATE_INVALID');
      const now = nowFrom(clock).toISOString(); const attempt = current.signedOutbox.broadcastAttempts + 1;
      const outbox = executionSignedOutboxSchema.parse({ ...current.signedOutbox, broadcastAttempts: attempt });
      const next = nextRecord(current, { status: 'SUBMISSION_UNCERTAIN', signedOutbox: outbox }, now); persistRecord(db, next);
      appendEvent(db, executionId, 'BROADCAST_BYTES_RELEASED', reason, {
        attempt, transactionHash: outbox.transactionHash, signedBytesDigest: outbox.signedBytesDigest,
        transactionDigest: outbox.transactionDigest,
      }, now);
      return { record: next, transactionHash: outbox.transactionHash, signedBytesHex: outbox.signedBytesHex, attempt, replayed: attempt > 1 };
    });
  }

  recordSubmissionTimeout(executionId: string, reason: string): ExecutionLifecycleRecord {
    if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 240) fail('EXECUTION_INVALID_INPUT');
    return this.state.executionTransaction((db, clock) => {
      assertNoG3cLifecycleOwner(db, executionId);
      const current = readRecord(db, executionId);
      if (current.status !== 'SUBMISSION_UNCERTAIN' || !current.signedOutbox) fail('EXECUTION_STATE_INVALID');
      const now = nowFrom(clock).toISOString();
      appendEvent(db, executionId, 'SUBMISSION_TIMEOUT', reason, {
        attempt: current.signedOutbox.broadcastAttempts, transactionHash: current.signedOutbox.transactionHash,
        signedBytesDigest: current.signedOutbox.signedBytesDigest,
      }, now);
      return current;
    });
  }

  recordSubmissionAccepted(executionId: string, evidence: SubmissionAcknowledgement, reason: string): ExecutionWriteResult {
    const checked = submissionAcknowledgementSchema.safeParse(evidence);
    if (!checked.success || typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 240) fail('EXECUTION_INVALID_INPUT');
    return this.state.executionTransaction((db, clock) => {
      assertNoG3cLifecycleOwner(db, executionId);
      const current = readRecord(db, executionId); const ack = checked.data; const outbox = current.signedOutbox;
      const nowDate = nowFrom(clock);
      if (!outbox || ack.chainId !== outbox.chainId || ack.chainNonce !== outbox.chainNonce ||
          ack.transactionHash !== outbox.transactionHash || ack.transactionDigest !== outbox.transactionDigest ||
          !canonicalDate(ack.acceptedAt) || Date.parse(ack.acceptedAt) > nowDate.getTime()) fail('RECEIPT_MISMATCH');
      if (current.status === 'SUBMITTED') return { record: current, replayed: true };
      if (current.status !== 'SUBMISSION_UNCERTAIN') fail('EXECUTION_STATE_INVALID');
      const now = nowDate.toISOString(); const next = nextRecord(current, { status: 'SUBMITTED' }, now); persistRecord(db, next);
      appendEvent(db, executionId, 'SUBMISSION_ACCEPTED', reason, {
        transactionHash: ack.transactionHash, transactionDigest: ack.transactionDigest,
        chainNonce: ack.chainNonce, acceptedAt: ack.acceptedAt,
      }, now);
      return { record: next, replayed: false };
    });
  }

  reconcileReceipt(executionId: string, evidence: ExecutionReceiptEvidence, reason: string): ExecutionWriteResult {
    const checked = executionReceiptEvidenceSchema.safeParse(evidence);
    if (!checked.success || typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 240) fail('RECEIPT_MISMATCH');
    return this.state.executionTransaction((db, clock) => {
      assertNoG3cLifecycleOwner(db, executionId);
      const current = readRecord(db, executionId); const receipt = checked.data; const outbox = current.signedOutbox;
      const nowDate = nowFrom(clock);
      if (!outbox || receipt.chainId !== outbox.chainId || receipt.transactionHash !== outbox.transactionHash ||
          receipt.transactionDigest !== outbox.transactionDigest || receipt.chainNonce !== outbox.chainNonce ||
          !canonicalDate(receipt.observedAt) || Date.parse(receipt.observedAt) > nowDate.getTime()) fail('RECEIPT_MISMATCH');
      if (current.status === 'CONFIRMED' || current.status === 'FAILED') {
        if (JSON.stringify(current.receipt) !== JSON.stringify(receipt)) fail('RECEIPT_CONFLICT');
        return { record: current, replayed: true };
      }
      if (!['SUBMISSION_UNCERTAIN','SUBMITTED'].includes(current.status)) fail('EXECUTION_STATE_INVALID');
      const now = nowDate.toISOString(); const status = receipt.outcome === 'CONFIRMED' ? 'CONFIRMED' : 'FAILED';
      const next = nextRecord(current, { status, receipt, failureReason: status === 'FAILED' ? 'EXACT_TRANSACTION_REVERTED' : null }, now);
      setReservationStatus(db, current.reservationId, status === 'CONFIRMED' ? 'SETTLED' : 'RELEASED', now);
      persistRecord(db, next);
      appendEvent(db, executionId, status === 'CONFIRMED' ? 'TRANSACTION_CONFIRMED' : 'TRANSACTION_REVERTED', reason, {
        receiptId: receipt.receiptId, transactionHash: receipt.transactionHash, transactionDigest: receipt.transactionDigest,
        chainNonce: receipt.chainNonce, outcome: receipt.outcome, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
        gasUsedNativeWei: receipt.gasUsedNativeWei, effectiveGasPriceWei: receipt.effectiveGasPriceWei,
      }, now);
      return { record: next, replayed: false };
    });
  }

  releaseBeforeSigning(executionId: string, accountVersion: number, reason: string, failed = false): ExecutionWriteResult {
    if (typeof failed !== 'boolean' || typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 240) fail('EXECUTION_INVALID_INPUT');
    return this.state.executionTransaction((db, clock) => {
      assertNoG3cLifecycleOwner(db, executionId);
      const current = readRecord(db, executionId); assertAccountVersion(current, accountVersion);
      if (current.status === 'RELEASED' && !failed) {
        if (current.failureReason !== reason) fail('EXECUTION_ID_CONFLICT');
        return { record: current, replayed: true };
      }
      if (current.status === 'FAILED' && failed && !current.signingClaim) {
        if (current.failureReason !== reason) fail('EXECUTION_ID_CONFLICT');
        return { record: current, replayed: true };
      }
      if (!['RESERVED','SIMULATED','AUTHORIZED'].includes(current.status)) fail('EXECUTION_STATE_INVALID');
      const now = nowFrom(clock).toISOString(); const status = failed ? 'FAILED' : 'RELEASED';
      const next = nextRecord(current, { status, failureReason: reason }, now);
      setReservationStatus(db, current.reservationId, 'RELEASED', now); persistRecord(db, next);
      appendEvent(db, executionId, failed ? 'EXECUTION_FAILED_BEFORE_SIGNING' : 'RESERVATION_RELEASED', reason, {
        reservationId: current.reservationId, priorStatus: current.status, accountVersion,
      }, now);
      return { record: next, replayed: false };
    });
  }

  close(): void { this.state.close(); }
}

export function initializeExecutionStore(options: PaperStoreOptions): ExecutionStore {
  return new ExecutionStore(initializePaperStore(options));
}
export function openExecutionStore(options: PaperStoreOptions): ExecutionStore {
  return new ExecutionStore(openPaperStore(options));
}

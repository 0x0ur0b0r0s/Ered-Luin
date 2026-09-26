import { closeSync, lstatSync, openSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { decisionSchema, executionKillSwitchSchema, executionLifecycleRecordSchema, executionStateSchema, tradeIntentSchema, type Decision, type ExecutionLifecycleRecord, type ExecutionState, type TradeIntent } from '@ered-luin/contracts';
import { assertExecutionLifecycleRecord } from './execution-lifecycle-validation.js';
import { g3bOperationSchema, g3cSessionSchema, g3cWorkflowSchema } from '@ered-luin/contracts';
import { assertStoredG3bOperation, validateSignedG3bTransactionSync } from './g3b-transaction.js';
import { G2_LIMITS, type G2Evaluation, type PaperAccountSnapshot } from './policy.js';

export const PAPER_STORE_SCHEMA_VERSION = 4 as const;
export const PAPER_STORE_ID = 'ered-luin-state-v4' as const;
const LEGACY_PAPER_STORE_ID = 'ered-luin-paper-g2-v1' as const;
const LEGACY_V2_PAPER_STORE_ID = 'ered-luin-state-v2' as const;
const LEGACY_V3_PAPER_STORE_ID = 'ered-luin-state-v3' as const;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
type SqlRow = Record<string, unknown>;

export type PaperStoreErrorCode = 'INVALID_INPUT' | 'DATABASE_PATH_INVALID' | 'DATABASE_ALREADY_EXISTS' | 'DATABASE_NOT_FOUND' | 'DATABASE_CORRUPT' | 'UNSUPPORTED_SCHEMA_VERSION' | 'CONFIGURATION_MISMATCH' | 'DATABASE_FAILURE' | 'STORE_CLOSED' | 'ACCOUNT_EXISTS' | 'ACCOUNT_NOT_FOUND' | 'INTENT_ID_CONFLICT' | 'INTENT_NOT_FOUND' | 'WALLET_RESERVATION_PENDING' | 'EXECUTION_INVALID_INPUT' | 'EXECUTION_ID_CONFLICT' | 'EXECUTION_NOT_FOUND' | 'EXECUTION_WALLET_BUSY' | 'KILL_SWITCH_STOPPED' | 'EXECUTION_STATE_INVALID' | 'ACCOUNT_VERSION_STALE' | 'SIMULATION_INVALID' | 'AUTHORIZATION_EXPIRED' | 'AUTHORIZATION_NONCE_REPLAYED' | 'RECEIPT_MISMATCH' | 'RECEIPT_CONFLICT';
const STORE_MESSAGES: Record<PaperStoreErrorCode, string> = {
  INVALID_INPUT: 'Paper store input is invalid.', DATABASE_PATH_INVALID: 'Paper state must use an absolute regular file outside the repository.',
  DATABASE_ALREADY_EXISTS: 'Paper state already exists; initialization never overwrites it.', DATABASE_NOT_FOUND: 'Existing paper state was not found.',
  DATABASE_CORRUPT: 'Paper state is corrupt or inconsistent; execution is halted.', UNSUPPORTED_SCHEMA_VERSION: 'Paper state schema version is unsupported.',
  CONFIGURATION_MISMATCH: 'Paper state identity does not match.', DATABASE_FAILURE: 'Paper state operation failed; state is preserved.',
  STORE_CLOSED: 'Paper store connection is closed.', ACCOUNT_EXISTS: 'Paper account already exists.', ACCOUNT_NOT_FOUND: 'Paper account was not found.',
  INTENT_ID_CONFLICT: 'Intent ID was already used for a different input.', INTENT_NOT_FOUND: 'Intent record was not found.',
  WALLET_RESERVATION_PENDING: 'A pending or uncertain paper reservation already exists for this wallet.', EXECUTION_INVALID_INPUT: 'Execution lifecycle input is invalid.', EXECUTION_ID_CONFLICT: 'Execution identity was already used for different input.', EXECUTION_NOT_FOUND: 'Execution lifecycle record was not found.', EXECUTION_WALLET_BUSY: 'A paper or execution reservation already holds this wallet.', KILL_SWITCH_STOPPED: 'The persisted execution kill switch is stopped.', EXECUTION_STATE_INVALID: 'The execution lifecycle transition is not legal from the current state.', ACCOUNT_VERSION_STALE: 'The account version does not match the bound execution snapshot.', SIMULATION_INVALID: 'Simulation evidence is missing, stale, failed, or bound to a different transaction.', AUTHORIZATION_EXPIRED: 'The authorization is expired or does not match the execution.', AUTHORIZATION_NONCE_REPLAYED: 'The single-use authorization nonce has already been consumed.', RECEIPT_MISMATCH: 'Receipt evidence does not match the exact persisted transaction.', RECEIPT_CONFLICT: 'Contradictory terminal receipt evidence was rejected.',
};
export class PaperStoreError extends Error {
  readonly code: PaperStoreErrorCode;
  constructor(code: PaperStoreErrorCode) { super(STORE_MESSAGES[code]); this.name = 'PaperStoreError'; this.code = code; }
}

export interface PaperStoreOptions { readonly databasePath: string; readonly storeId?: string; readonly clock?: () => Date; }
interface NormalizedPaperStoreOptions { readonly databasePath: string; readonly storeId: string; readonly clock: () => Date; }
export interface ExternalFundingInput { readonly walletAddress: string; readonly asset: 'USDC' | 'WETH' | 'NATIVE_GAS'; readonly amountAtomic: string; readonly valueUsdcMicros: string; readonly quotedAt?: string; readonly utcDay: string; }
export interface CreatePaperAccountInput {
  readonly walletAddress: string;
  readonly usdcBalanceAtomic: string;
  readonly wethBalanceAtomic: string;
  readonly gasBalanceNativeWei: string;
  readonly dailyStartEquityUsdcMicros: string;
  readonly dailyFundingUsdcMicros?: string;
  readonly utcDay: string;
}
export interface PaperIntentRecord {
  readonly intent: TradeIntent;
  readonly decision: Decision;
  readonly execution: ExecutionState;
  readonly signalIds: readonly string[];
  readonly signalSource: G2Evaluation['signalSource'];
  readonly quoteSource: G2Evaluation['quoteSource'];
  readonly reservationId: string | null;
}
export interface CommitEvaluationResult { readonly record: PaperIntentRecord; readonly replayed: boolean; }

const META_SQL = `CREATE TABLE paper_meta (
 singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
 schema_version INTEGER NOT NULL CHECK (typeof(schema_version) = 'integer' AND schema_version > 0),
 store_id TEXT NOT NULL UNIQUE CHECK (length(store_id) BETWEEN 1 AND 128)
) STRICT`;
const ACCOUNTS_SQL = `CREATE TABLE paper_accounts (
 wallet_address TEXT PRIMARY KEY CHECK (length(wallet_address) = 42),
 version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 0),
 usdc_balance_atomic TEXT NOT NULL CHECK (length(usdc_balance_atomic) <= 128 AND usdc_balance_atomic NOT GLOB '*[^0-9]*' AND (usdc_balance_atomic = '0' OR substr(usdc_balance_atomic, 1, 1) BETWEEN '1' AND '9')),
 weth_balance_atomic TEXT NOT NULL CHECK (length(weth_balance_atomic) <= 128 AND weth_balance_atomic NOT GLOB '*[^0-9]*' AND (weth_balance_atomic = '0' OR substr(weth_balance_atomic, 1, 1) BETWEEN '1' AND '9')),
 gas_balance_native_wei TEXT NOT NULL CHECK (length(gas_balance_native_wei) <= 128 AND gas_balance_native_wei NOT GLOB '*[^0-9]*' AND (gas_balance_native_wei = '0' OR substr(gas_balance_native_wei, 1, 1) BETWEEN '1' AND '9')),
 utc_day TEXT NOT NULL CHECK (length(utc_day) = 10),
 daily_start_equity_usdc_micros TEXT NOT NULL CHECK (length(daily_start_equity_usdc_micros) <= 128 AND daily_start_equity_usdc_micros NOT GLOB '*[^0-9]*' AND (daily_start_equity_usdc_micros = '0' OR substr(daily_start_equity_usdc_micros, 1, 1) BETWEEN '1' AND '9')),
 daily_funding_usdc_micros TEXT NOT NULL CHECK (length(daily_funding_usdc_micros) <= 128),
 created_at TEXT NOT NULL
) STRICT`;
const INTENTS_SQL = `CREATE TABLE paper_intents (
 intent_id TEXT PRIMARY KEY CHECK (length(intent_id) = 36),
 intent_json TEXT NOT NULL CHECK (length(intent_json) <= 4096),
 decision_json TEXT NOT NULL CHECK (length(decision_json) <= 16384),
 execution_json TEXT NOT NULL CHECK (length(execution_json) <= 4096),
 signal_ids_json TEXT NOT NULL CHECK (length(signal_ids_json) <= 16384),
 signal_source TEXT NOT NULL CHECK (signal_source IN ('nansen','synthetic','none','mixed')),
 quote_source TEXT NOT NULL CHECK (quote_source IN ('pool','synthetic','none','mixed')),
 reservation_id TEXT,
 created_at TEXT NOT NULL
) STRICT`;
const RESERVATIONS_SQL = `CREATE TABLE paper_reservations (
 reservation_id TEXT PRIMARY KEY CHECK (length(reservation_id) = 36),
 intent_id TEXT NOT NULL UNIQUE REFERENCES paper_intents(intent_id),
 wallet_address TEXT NOT NULL REFERENCES paper_accounts(wallet_address),
 approved_amount_in TEXT NOT NULL CHECK (length(approved_amount_in) <= 128 AND approved_amount_in NOT GLOB '*[^0-9]*' AND approved_amount_in <> '0'),
 exposure_usdc_micros TEXT NOT NULL CHECK (length(exposure_usdc_micros) <= 128 AND exposure_usdc_micros NOT GLOB '*[^0-9]*' AND exposure_usdc_micros <> '0'),
 status TEXT NOT NULL CHECK (status IN ('PENDING','UNKNOWN','SETTLED','RELEASED')),
 created_at TEXT NOT NULL,
 settled_at TEXT
) STRICT`;
const TABLES_V1: Record<string, { readonly sql: string; readonly columns: readonly string[] }> = {
  paper_accounts: { sql: ACCOUNTS_SQL, columns: ['wallet_address','version','usdc_balance_atomic','weth_balance_atomic','gas_balance_native_wei','utc_day','daily_start_equity_usdc_micros','daily_funding_usdc_micros','created_at'] },
  paper_intents: { sql: INTENTS_SQL, columns: ['intent_id','intent_json','decision_json','execution_json','signal_ids_json','signal_source','quote_source','reservation_id','created_at'] },
  paper_meta: { sql: META_SQL, columns: ['singleton','schema_version','store_id'] },
  paper_reservations: { sql: RESERVATIONS_SQL, columns: ['reservation_id','intent_id','wallet_address','approved_amount_in','exposure_usdc_micros','status','created_at','settled_at'] },
};
const WALLET_RESERVATIONS_SQL = `CREATE TABLE wallet_reservations (
 reservation_id TEXT PRIMARY KEY CHECK (length(reservation_id) = 36),
 owner_kind TEXT NOT NULL CHECK (owner_kind IN ('PAPER','EXECUTION')),
 intent_id TEXT NOT NULL CHECK (length(intent_id) = 36),
 wallet_address TEXT NOT NULL CHECK (length(wallet_address) = 42),
 amount_in TEXT NOT NULL CHECK (length(amount_in) <= 128 AND amount_in NOT GLOB '*[^0-9]*' AND amount_in <> '0'),
 exposure_usdc_micros TEXT NOT NULL CHECK (length(exposure_usdc_micros) <= 128 AND exposure_usdc_micros NOT GLOB '*[^0-9]*' AND exposure_usdc_micros <> '0'),
 status TEXT NOT NULL CHECK (status IN ('ACTIVE','SETTLED','RELEASED')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
) STRICT`;
const WALLET_RESERVATIONS_INDEX_SQL = `CREATE UNIQUE INDEX wallet_reservations_one_active_per_wallet
 ON wallet_reservations(wallet_address) WHERE status = 'ACTIVE'`;
const EXECUTION_CONTROL_SQL = `CREATE TABLE execution_control (
 singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
 stopped INTEGER NOT NULL CHECK (stopped IN (0,1)),
 reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 240),
 changed_at TEXT NOT NULL
) STRICT`;
const EXECUTION_LIFECYCLE_SQL = `CREATE TABLE execution_lifecycle (
 execution_id TEXT PRIMARY KEY CHECK (length(execution_id) = 36),
 intent_id TEXT NOT NULL UNIQUE CHECK (length(intent_id) = 36),
 wallet_address TEXT NOT NULL CHECK (length(wallet_address) = 42),
 reservation_id TEXT NOT NULL UNIQUE REFERENCES wallet_reservations(reservation_id),
 status TEXT NOT NULL CHECK (status IN ('RESERVED','SIMULATED','AUTHORIZED','SIGNING_CLAIMED','SIGNED_OUTBOX','SUBMISSION_UNCERTAIN','SUBMITTED','CONFIRMED','FAILED','RELEASED')),
 record_json TEXT NOT NULL CHECK (length(record_json) <= 131072),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision > 0)
) STRICT`;
const EXECUTION_G3B_OPERATIONS_SQL = `CREATE TABLE execution_g3b_operations (
 operation_id TEXT PRIMARY KEY CHECK (length(operation_id) = 36),
 execution_id TEXT NOT NULL REFERENCES execution_lifecycle(execution_id),
 status TEXT NOT NULL CHECK (status IN ('PREPARED','SIMULATED','AUTHORIZED','SIGNING_CLAIMED','SIGNED_OUTBOX','SUBMISSION_UNCERTAIN','SUBMITTED','CONFIRMED','FAILED')),
 record_json TEXT NOT NULL CHECK (length(record_json) <= 262144),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision > 0)
) STRICT`;
const EXECUTION_EVENTS_SQL = `CREATE TABLE execution_events (
 event_id TEXT PRIMARY KEY CHECK (length(event_id) = 36),
 execution_id TEXT,
 event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 64),
 reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 240),
 evidence_json TEXT NOT NULL CHECK (length(evidence_json) <= 131072),
 created_at TEXT NOT NULL
) STRICT`;
const EXECUTION_G3C_SESSIONS_SQL = "CREATE TABLE execution_g3c_sessions (\n session_id TEXT PRIMARY KEY CHECK (length(session_id) = 36),\n wallet_address TEXT NOT NULL CHECK (length(wallet_address) = 42),\n status TEXT NOT NULL CHECK (status IN ('ACTIVE','STOPPED','CLOSED')),\n record_json TEXT NOT NULL CHECK (length(record_json) <= 131072),\n created_at TEXT NOT NULL,\n updated_at TEXT NOT NULL,\n revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision > 0)\n) STRICT";
const EXECUTION_G3C_WORKFLOWS_SQL = "CREATE TABLE execution_g3c_workflows (\n operation_id TEXT PRIMARY KEY CHECK (length(operation_id) = 36),\n execution_id TEXT NOT NULL REFERENCES execution_lifecycle(execution_id),\n session_id TEXT NOT NULL REFERENCES execution_g3c_sessions(session_id),\n status TEXT NOT NULL CHECK (status IN ('AUTHORIZED','SIGNING_CLAIMED','SIGNED_OUTBOX','SUBMISSION_UNCERTAIN','SUBMITTED','CONFIRMED','REVERTED','RECONCILIATION_REQUIRED','CANCELLED')),\n record_json TEXT NOT NULL CHECK (length(record_json) <= 524288),\n created_at TEXT NOT NULL,\n updated_at TEXT NOT NULL,\n revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision > 0)\n) STRICT";
const TABLES_V3: Record<string, { readonly sql: string; readonly columns: readonly string[] }> = {
  ...TABLES_V1,
  wallet_reservations: { sql: WALLET_RESERVATIONS_SQL, columns: ['reservation_id','owner_kind','intent_id','wallet_address','amount_in','exposure_usdc_micros','status','created_at','updated_at'] },
  execution_control: { sql: EXECUTION_CONTROL_SQL, columns: ['singleton','stopped','reason','changed_at'] },
  execution_lifecycle: { sql: EXECUTION_LIFECYCLE_SQL, columns: ['execution_id','intent_id','wallet_address','reservation_id','status','record_json','created_at','updated_at','revision'] },
  execution_events: { sql: EXECUTION_EVENTS_SQL, columns: ['event_id','execution_id','event_type','reason','evidence_json','created_at'] },
  execution_g3b_operations: { sql: EXECUTION_G3B_OPERATIONS_SQL, columns: ['operation_id','execution_id','status','record_json','created_at','updated_at','revision'] },
};
const TABLES: Record<string, { readonly sql: string; readonly columns: readonly string[] }> = {
  ...TABLES_V3,
  execution_g3c_sessions: { sql: EXECUTION_G3C_SESSIONS_SQL, columns: ['session_id','wallet_address','status','record_json','created_at','updated_at','revision'] },
  execution_g3c_workflows: { sql: EXECUTION_G3C_WORKFLOWS_SQL, columns: ['operation_id','execution_id','session_id','status','record_json','created_at','updated_at','revision'] },
};
const TABLES_V2 = Object.fromEntries(Object.entries(TABLES_V3).filter(([name]) => name !== 'execution_g3b_operations')) as typeof TABLES_V3;
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isInsideRepository(path: string): boolean {
  const relativePath = relative(REPOSITORY_ROOT, resolve(path));
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith('..' + sep) && !isAbsolute(relativePath));
}
function normalizedOptions(value: unknown): NormalizedPaperStoreOptions {
  if (!isRecord(value) || Object.keys(value).some((key) => !['databasePath','storeId','clock'].includes(key)) ||
      typeof value.databasePath !== 'string' || !isAbsolute(value.databasePath) || value.databasePath.includes(String.fromCharCode(0)) || isInsideRepository(value.databasePath)) {
    throw new PaperStoreError('DATABASE_PATH_INVALID');
  }
  const storeId = value.storeId ?? PAPER_STORE_ID;
  const clock = value.clock ?? (() => new Date());
  if (typeof storeId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(storeId) || typeof clock !== 'function') throw new PaperStoreError('INVALID_INPUT');
  return { databasePath: value.databasePath, storeId, clock: clock as () => Date };
}
function configure(db: DatabaseSync): void { db.exec('PRAGMA foreign_keys = ON'); db.exec('PRAGMA busy_timeout = 5000'); db.exec('PRAGMA synchronous = FULL'); }
function normalizeSql(value: string): string { return value.replace(/\s+/gu, '').toLowerCase(); }
function assertIntegrity(db: DatabaseSync): void {
  const integrity = db.prepare('PRAGMA integrity_check').all() as SqlRow[];
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all() as SqlRow[];
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok' || foreignKeys.length !== 0) throw new PaperStoreError('DATABASE_CORRUPT');
}
function assertTableSet(db: DatabaseSync, tables: Record<string, { readonly sql: string; readonly columns: readonly string[] }>): void {
  const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as SqlRow[];
  const names = Object.keys(tables).sort();
  if (rows.length !== names.length) throw new PaperStoreError('DATABASE_CORRUPT');
  for (const [i, name] of names.entries()) {
    const row = rows[i]; const table = tables[name];
    if (row?.type !== 'table' || row.name !== name || typeof row.sql !== 'string' || normalizeSql(row.sql) !== normalizeSql(table?.sql ?? '')) throw new PaperStoreError('DATABASE_CORRUPT');
    const columns = (db.prepare(`PRAGMA table_info(${name})`).all() as SqlRow[]).map((column) => column.name);
    if (columns.length !== table?.columns.length || columns.some((column, index) => column !== table?.columns[index])) throw new PaperStoreError('DATABASE_CORRUPT');
  }
}
function assertIdentity(db: DatabaseSync, expectedVersion: number, storeId: string): void {
  const meta = db.prepare('SELECT schema_version, store_id FROM paper_meta WHERE singleton = 1').get() as SqlRow | undefined;
  const count = db.prepare('SELECT COUNT(*) AS count FROM paper_meta').get() as SqlRow;
  if (!meta || meta.schema_version !== expectedVersion || meta.store_id !== storeId || count.count !== 1) throw new PaperStoreError('CONFIGURATION_MISMATCH');
}
function assertLegacySchema(db: DatabaseSync, storeId: string): void {
  const version = db.prepare('PRAGMA user_version').get() as SqlRow | undefined;
  if (version?.user_version !== 1) throw new PaperStoreError('UNSUPPORTED_SCHEMA_VERSION');
  assertTableSet(db, TABLES_V1);
  assertIdentity(db, 1, storeId);
}
function assertStoredLifecycleRecord(record: ExecutionLifecycleRecord): void {
  try {
    assertExecutionLifecycleRecord(record);
  } catch {
    throw new PaperStoreError('DATABASE_CORRUPT');
  }
}
function assertSchema(db: DatabaseSync, storeId: string): void {
  const version = db.prepare('PRAGMA user_version').get() as SqlRow | undefined;
  if (version?.user_version !== PAPER_STORE_SCHEMA_VERSION) throw new PaperStoreError('UNSUPPORTED_SCHEMA_VERSION');
  assertTableSet(db, TABLES);
  assertIdentity(db, PAPER_STORE_SCHEMA_VERSION, storeId);
  const indexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all() as SqlRow[];
  if (indexes.length !== 1 || indexes[0]?.name !== 'wallet_reservations_one_active_per_wallet' ||
      typeof indexes[0]?.sql !== 'string' || normalizeSql(indexes[0].sql) !== normalizeSql(WALLET_RESERVATIONS_INDEX_SQL)) throw new PaperStoreError('DATABASE_CORRUPT');
  const controls = db.prepare('SELECT singleton, stopped, reason, changed_at FROM execution_control').all() as SqlRow[];
  if (controls.length !== 1 || controls[0]?.singleton !== 1 ||
      !executionKillSwitchSchema.safeParse({ version: 1, stopped: controls[0]?.stopped === 1, reason: controls[0]?.reason, changedAt: controls[0]?.changed_at }).success ||
      (controls[0]?.stopped !== 0 && controls[0]?.stopped !== 1)) throw new PaperStoreError('DATABASE_CORRUPT');
  const records = db.prepare('SELECT * FROM execution_lifecycle').all() as SqlRow[];
  for (const row of records) {
    let parsed: unknown;
    try { parsed = JSON.parse(String(row.record_json)); } catch { throw new PaperStoreError('DATABASE_CORRUPT'); }
    const checked = executionLifecycleRecordSchema.safeParse(parsed);
    if (checked.success) assertStoredLifecycleRecord(checked.data);
    if (!checked.success || checked.data.executionId !== row.execution_id || checked.data.intentId !== row.intent_id ||
        checked.data.walletAddress.toLowerCase() !== String(row.wallet_address).toLowerCase() ||
        checked.data.reservationId !== row.reservation_id || checked.data.status !== row.status ||
        checked.data.revision !== row.revision || checked.data.createdAt !== row.created_at || checked.data.updatedAt !== row.updated_at) throw new PaperStoreError('DATABASE_CORRUPT');
    const reservation = db.prepare('SELECT owner_kind, status, intent_id, wallet_address, amount_in, exposure_usdc_micros FROM wallet_reservations WHERE reservation_id = ?').get(row.reservation_id) as SqlRow | undefined;
    const expectedReservationStatus = checked.data.status === 'CONFIRMED' ? 'SETTLED' :
      (checked.data.status === 'FAILED' || checked.data.status === 'RELEASED') ? 'RELEASED' : 'ACTIVE';
    if (!reservation || reservation.owner_kind !== 'EXECUTION' || reservation.status !== expectedReservationStatus ||
        reservation.intent_id !== checked.data.intentId || String(reservation.wallet_address).toLowerCase() !== checked.data.walletAddress.toLowerCase() ||
        reservation.amount_in !== checked.data.transaction.amountIn || reservation.exposure_usdc_micros !== checked.data.reservationExposureUsdcMicros) throw new PaperStoreError('DATABASE_CORRUPT');
  }
  const paperReservations = db.prepare(`SELECT p.reservation_id AS paper_id, p.intent_id AS paper_intent_id, p.wallet_address AS paper_wallet,
      p.approved_amount_in AS paper_amount, p.exposure_usdc_micros AS paper_exposure, p.status AS paper_status,
      w.reservation_id AS shared_id, w.owner_kind, w.status AS shared_status, w.intent_id AS shared_intent_id,
      w.wallet_address AS shared_wallet, w.amount_in AS shared_amount, w.exposure_usdc_micros AS shared_exposure
    FROM paper_reservations p LEFT JOIN wallet_reservations w ON w.reservation_id = p.reservation_id`).all() as SqlRow[];
  for (const row of paperReservations) {
    const expected = ['PENDING','UNKNOWN'].includes(String(row.paper_status)) ? 'ACTIVE' :
      row.paper_status === 'SETTLED' ? 'SETTLED' : 'RELEASED';
    if (!row.shared_id || row.owner_kind !== 'PAPER' || row.shared_status !== expected ||
        row.paper_intent_id !== row.shared_intent_id || String(row.paper_wallet).toLowerCase() !== String(row.shared_wallet).toLowerCase() ||
        row.paper_amount !== row.shared_amount || row.paper_exposure !== row.shared_exposure) throw new PaperStoreError('DATABASE_CORRUPT');
  }
  const orphanCount = db.prepare(`SELECT COUNT(*) AS count FROM wallet_reservations w WHERE
    (w.owner_kind = 'PAPER' AND NOT EXISTS (SELECT 1 FROM paper_reservations p WHERE p.reservation_id = w.reservation_id)) OR
    (w.owner_kind = 'EXECUTION' AND NOT EXISTS (SELECT 1 FROM execution_lifecycle e WHERE e.reservation_id = w.reservation_id))`).get() as SqlRow;
  if (orphanCount.count !== 0) throw new PaperStoreError('DATABASE_CORRUPT');
  const operations = db.prepare('SELECT operation_id, execution_id, status, record_json, created_at, updated_at, revision FROM execution_g3b_operations').all() as SqlRow[];
  for (const row of operations) {
    let parsed: unknown;
    try { parsed = JSON.parse(String(row.record_json)); } catch { throw new PaperStoreError('DATABASE_CORRUPT'); }
    const checked = g3bOperationSchema.safeParse(parsed);
    if (!checked.success || checked.data.operationId !== row.operation_id || checked.data.executionId !== row.execution_id ||
        checked.data.status !== row.status || checked.data.createdAt !== row.created_at || checked.data.updatedAt !== row.updated_at ||
        checked.data.revision !== row.revision) throw new PaperStoreError('DATABASE_CORRUPT');
    try { assertStoredG3bOperation(checked.data); } catch { throw new PaperStoreError('DATABASE_CORRUPT'); }
  }
  const sessions = db.prepare('SELECT * FROM execution_g3c_sessions').all() as SqlRow[];
  const g3cSessions = new Map<string, import('@ered-luin/contracts').G3cSession>();
  for (const row of sessions) {
    let parsed: unknown;
    try { parsed = JSON.parse(String(row.record_json)); } catch { throw new PaperStoreError('DATABASE_CORRUPT'); }
    const checked = g3cSessionSchema.safeParse(parsed);
    if (!checked.success || checked.data.sessionId !== row.session_id || checked.data.walletAddress.toLowerCase() !== String(row.wallet_address).toLowerCase() ||
        checked.data.status !== row.status || checked.data.createdAt !== row.created_at || checked.data.updatedAt !== row.updated_at ||
        checked.data.revision !== row.revision) throw new PaperStoreError('DATABASE_CORRUPT');
    g3cSessions.set(checked.data.sessionId, checked.data);
  }
  const workflows = db.prepare('SELECT * FROM execution_g3c_workflows').all() as SqlRow[];
  const activeWorstCaseBySession = new Map<string, bigint>();
  const feesBySession = new Map<string, bigint>();
  const lossesBySession = new Map<string, bigint>();
  for (const row of workflows) {
    let parsed: unknown;
    try { parsed = JSON.parse(String(row.record_json)); } catch { throw new PaperStoreError('DATABASE_CORRUPT'); }
    const checked = g3cWorkflowSchema.safeParse(parsed);
    if (!checked.success || checked.data.operationId !== row.operation_id || checked.data.executionId !== row.execution_id ||
        checked.data.sessionId !== row.session_id || checked.data.status !== row.status || checked.data.createdAt !== row.created_at ||
        checked.data.updatedAt !== row.updated_at || checked.data.revision !== row.revision) throw new PaperStoreError('DATABASE_CORRUPT');
    if (checked.data.signedBytesHex !== null) {
      try {
        const digest = createHash('sha256').update(Buffer.from(checked.data.signedBytesHex.slice(2), 'hex')).digest('hex');
        const signed = validateSignedG3bTransactionSync(checked.data.signedBytesHex as `0x${string}`, checked.data.unsignedTransaction);
        if (digest !== checked.data.signedBytesDigest || signed.transactionHash.toLowerCase() !== checked.data.transactionHash?.toLowerCase()) throw new Error();
      } catch { throw new PaperStoreError('DATABASE_CORRUPT'); }
    }
    const session = g3cSessions.get(checked.data.sessionId);
    const parentRow = db.prepare('SELECT record_json FROM execution_lifecycle WHERE execution_id = ?').get(checked.data.executionId) as SqlRow | undefined;
    if (!session || !parentRow) throw new PaperStoreError('DATABASE_CORRUPT');
    let parent: unknown;
    try { parent = JSON.parse(String(parentRow.record_json)); } catch { throw new PaperStoreError('DATABASE_CORRUPT'); }
    const execution = executionLifecycleRecordSchema.safeParse(parent);
    if (!execution.success || execution.data.intentId !== checked.data.intentId || execution.data.decisionId !== checked.data.decisionId ||
        execution.data.reservationId !== checked.data.reservationId || execution.data.walletAddress.toLowerCase() !== session.walletAddress.toLowerCase() ||
        checked.data.accountSnapshot.payload.kind !== 'ACCOUNT_SNAPSHOT' ||
        checked.data.accountSnapshot.payload.walletAddress.toLowerCase() !== session.walletAddress.toLowerCase()) throw new PaperStoreError('DATABASE_CORRUPT');
    const isFinanciallySettled = checked.data.status === 'CONFIRMED' || checked.data.status === 'REVERTED' || checked.data.status === 'CANCELLED';
    const releasesParent = checked.data.status === 'CANCELLED' || checked.data.status === 'REVERTED' ||
      (checked.data.status === 'CONFIRMED' && checked.data.kind === 'SWAP') ||
      (checked.data.status === 'CONFIRMED' && checked.data.kind === 'APPROVAL' && execution.data.status === 'RELEASED');
    const expectedParentStatus = releasesParent ? 'RELEASED' : 'RESERVED';
    const reservation = db.prepare('SELECT status FROM wallet_reservations WHERE reservation_id = ?').get(checked.data.reservationId) as SqlRow | undefined;
    if (execution.data.status !== expectedParentStatus || !reservation ||
        reservation.status !== (releasesParent ? 'RELEASED' : 'ACTIVE')) throw new PaperStoreError('DATABASE_CORRUPT');
    const active = !isFinanciallySettled;
    if (active) activeWorstCaseBySession.set(session.sessionId, (activeWorstCaseBySession.get(session.sessionId) ?? 0n) + BigInt(checked.data.reservedWorstCaseLossUsdcMicros));
    else {
      feesBySession.set(session.sessionId, (feesBySession.get(session.sessionId) ?? 0n) + BigInt(checked.data.actualFeesUsdcMicros));
      lossesBySession.set(session.sessionId, (lossesBySession.get(session.sessionId) ?? 0n) + BigInt(checked.data.actualLossUsdcMicros));
    }
  }
  for (const session of g3cSessions.values()) {
    if (BigInt(session.outstandingWorstCaseReservationsUsdcMicros) !== (activeWorstCaseBySession.get(session.sessionId) ?? 0n) ||
        BigInt(session.realizedFeesUsdcMicros) !== (feesBySession.get(session.sessionId) ?? 0n) ||
        BigInt(session.realizedLossUsdcMicros) !== (lossesBySession.get(session.sessionId) ?? 0n)) throw new PaperStoreError('DATABASE_CORRUPT');
  }  const events = db.prepare('SELECT event_id, event_type, reason, evidence_json, created_at FROM execution_events').all() as SqlRow[];
  const eventTypes = ['KILL_SWITCH_STOPPED','KILL_SWITCH_ARMED','RESERVATION_CREATED','SIMULATION_ACCEPTED','AUTHORIZATION_ISSUED',
    'SIGNING_CLAIMED','SIGNED_BYTES_PERSISTED','BROADCAST_BYTES_RELEASED','SUBMISSION_TIMEOUT','SUBMISSION_ACCEPTED',
    'TRANSACTION_CONFIRMED','TRANSACTION_REVERTED','EXECUTION_FAILED_BEFORE_SIGNING','RESERVATION_RELEASED',
    'G3B_OPERATION_PREPARED','G3B_SIMULATION_ACCEPTED','G3B_FEE_ACCEPTED','G3B_RISK_ACCEPTED','G3B_AUTHORIZATION_ISSUED',
    'G3B_SIGNING_CLAIMED','G3B_SIGNED_BYTES_PERSISTED','G3B_BROADCAST_BYTES_RELEASED','G3B_SUBMISSION_ACCEPTED',
    'G3B_TRANSACTION_CONFIRMED','G3B_TRANSACTION_REVERTED','G3C_SESSION_STARTED','G3C_ACCOUNT_REFRESHED','G3C_WORKFLOW_AUTHORIZED',
    'G3C_SIGNING_CLAIMED','G3C_SIGNED_BYTES_PERSISTED','G3C_BROADCAST_BYTES_RELEASED','G3C_SUBMISSION_ACCEPTED',
    'G3C_RECEIPT_OBSERVED','G3C_APPROVAL_ONLY_RELEASED','G3C_SETTLEMENT_CONFIRMED','G3C_SETTLEMENT_REVERTED','G3C_RECONCILIATION_REQUIRED','G3C_SESSION_STOPPED','D2B_OPERATOR_ACTION_BOUND','D2B_OPERATOR_ACTION_PROGRESS'];
  for (const event of events) {
    let evidence: unknown;
    try { evidence = JSON.parse(String(event.evidence_json)); } catch { throw new PaperStoreError('DATABASE_CORRUPT'); }
    if (typeof event.event_id !== 'string' || !/^[0-9a-f-]{36}$/iu.test(event.event_id) ||
        !eventTypes.includes(String(event.event_type)) || typeof event.reason !== 'string' || event.reason.length === 0 ||
        !isRecord(evidence) || typeof event.created_at !== 'string' || !Number.isFinite(Date.parse(event.created_at)) ||
        new Date(Date.parse(event.created_at)).toISOString() !== event.created_at) throw new PaperStoreError('DATABASE_CORRUPT');
  }
}
function assertVersionTwoSchema(db: DatabaseSync, storeId: string): void {
  const version = db.prepare('PRAGMA user_version').get() as SqlRow | undefined;
  if (version?.user_version !== 2) throw new PaperStoreError('UNSUPPORTED_SCHEMA_VERSION');
  assertTableSet(db, TABLES_V2);
  assertIdentity(db, 2, storeId);
}
function assertVersionThreeSchema(db: DatabaseSync, storeId: string): void {
  const version = db.prepare('PRAGMA user_version').get() as SqlRow | undefined;
  if (version?.user_version !== 3) throw new PaperStoreError('UNSUPPORTED_SCHEMA_VERSION');
  assertTableSet(db, TABLES_V3);
  assertIdentity(db, 3, storeId);
}
function migrateLegacyPaperStore(db: DatabaseSync, storeId: string, clock: () => Date): void {
  const version = db.prepare('PRAGMA user_version').get() as SqlRow | undefined;
  if (version?.user_version === PAPER_STORE_SCHEMA_VERSION) return;
  const previousStoreId = version?.user_version === 1
    ? (storeId === PAPER_STORE_ID ? LEGACY_PAPER_STORE_ID : storeId)
    : version?.user_version === 2
      ? (storeId === PAPER_STORE_ID ? LEGACY_V2_PAPER_STORE_ID : storeId)
      : (storeId === PAPER_STORE_ID ? LEGACY_V3_PAPER_STORE_ID : storeId);
  if (version?.user_version === 1) assertLegacySchema(db, previousStoreId);
  else if (version?.user_version === 2) assertVersionTwoSchema(db, previousStoreId);
  else if (version?.user_version === 3) assertVersionThreeSchema(db, previousStoreId);
  else throw new PaperStoreError('UNSUPPORTED_SCHEMA_VERSION');
  let migratedAt: string;
  try { const now = clock(); if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error(); migratedAt = now.toISOString(); }
  catch { throw new PaperStoreError('DATABASE_FAILURE'); }
  try {
    transaction(db, () => {
      if (version?.user_version === 1) {
        db.exec(WALLET_RESERVATIONS_SQL);
        db.exec(EXECUTION_CONTROL_SQL);
        db.exec(EXECUTION_LIFECYCLE_SQL);
        db.exec(EXECUTION_EVENTS_SQL);
        db.prepare(`INSERT INTO wallet_reservations
          (reservation_id,owner_kind,intent_id,wallet_address,amount_in,exposure_usdc_micros,status,created_at,updated_at)
          SELECT reservation_id,'PAPER',intent_id,wallet_address,approved_amount_in,exposure_usdc_micros,
            CASE WHEN status IN ('PENDING','UNKNOWN') THEN 'ACTIVE' WHEN status = 'RELEASED' THEN 'RELEASED' ELSE 'SETTLED' END,
            created_at,COALESCE(settled_at,created_at) FROM paper_reservations`).run();
        db.exec(WALLET_RESERVATIONS_INDEX_SQL);
        db.prepare('INSERT INTO execution_control (singleton,stopped,reason,changed_at) VALUES (1,1,?,?)').run('SCHEMA_UPGRADED_STOPPED', migratedAt);
      }
      if (version?.user_version !== 3) db.exec(EXECUTION_G3B_OPERATIONS_SQL);
      db.exec(EXECUTION_G3C_SESSIONS_SQL);
      db.exec(EXECUTION_G3C_WORKFLOWS_SQL);
      db.prepare("UPDATE execution_control SET stopped = 1, reason = 'SCHEMA_UPGRADED_STOPPED', changed_at = ? WHERE singleton = 1").run(migratedAt);
      db.prepare('UPDATE paper_meta SET schema_version = ?, store_id = ? WHERE singleton = 1').run(PAPER_STORE_SCHEMA_VERSION, storeId);
      db.exec(`PRAGMA user_version = ${PAPER_STORE_SCHEMA_VERSION}`);
    });
  } catch (error) {
    if (error instanceof PaperStoreError) throw error;
    throw new PaperStoreError('DATABASE_CORRUPT');
  }
  assertIntegrity(db);
  assertSchema(db, storeId);
}
function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { try { db.exec('ROLLBACK'); } catch { /* Preserve the triggering failure. */ } if (error instanceof PaperStoreError) throw error; throw new PaperStoreError('DATABASE_FAILURE'); }
}
function openExisting(databasePath: string): DatabaseSync {
  try { const stat = lstatSync(databasePath); if (!stat.isFile() || stat.isSymbolicLink()) throw new PaperStoreError('DATABASE_PATH_INVALID'); }
  catch (error) { if (error instanceof PaperStoreError) throw error; throw new PaperStoreError('DATABASE_NOT_FOUND'); }
  try {
    const db = new DatabaseSync(databasePath); configure(db);
    if ((db.prepare('PRAGMA journal_mode').get() as SqlRow | undefined)?.journal_mode !== 'wal') { db.close(); throw new PaperStoreError('DATABASE_CORRUPT'); }
    return db;
  } catch (error) { if (error instanceof PaperStoreError) throw error; throw new PaperStoreError('DATABASE_CORRUPT'); }
}
function unsigned(value: unknown): value is string { return typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value) && value.length <= 128; }
function validUtcDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isSafeInteger(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}
function signed(value: unknown): value is string { return typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/u.test(value) && value.length <= 128; }
function readAccount(row: SqlRow | undefined): PaperAccountSnapshot | null {
  if (!row) return null;
  if (typeof row.wallet_address !== 'string' || typeof row.version !== 'number' || !Number.isSafeInteger(row.version) ||
      !unsigned(row.usdc_balance_atomic) || !unsigned(row.weth_balance_atomic) || !unsigned(row.gas_balance_native_wei) ||
      !validUtcDay(row.utc_day) || !unsigned(row.daily_start_equity_usdc_micros) || !signed(row.daily_funding_usdc_micros)) throw new PaperStoreError('DATABASE_CORRUPT');
  return Object.freeze({ walletAddress: row.wallet_address, version: row.version, usdcBalanceAtomic: row.usdc_balance_atomic,
    wethBalanceAtomic: row.weth_balance_atomic, gasBalanceNativeWei: row.gas_balance_native_wei, utcDay: row.utc_day,
    dailyStartEquityUsdcMicros: row.daily_start_equity_usdc_micros, dailyFundingUsdcMicros: row.daily_funding_usdc_micros });
}
function parseStoredRecord(row: SqlRow | undefined): PaperIntentRecord | null {
  if (!row) return null;
  try {
    const intent = tradeIntentSchema.parse(JSON.parse(String(row.intent_json)));
    const decision = decisionSchema.parse(JSON.parse(String(row.decision_json)));
    const execution = executionStateSchema.parse(JSON.parse(String(row.execution_json)));
    const signalIds = JSON.parse(String(row.signal_ids_json)) as unknown;
    if (!Array.isArray(signalIds) || signalIds.some((id) => typeof id !== 'string') ||
        !['nansen','synthetic','none','mixed'].includes(String(row.signal_source)) || !['pool','synthetic','none','mixed'].includes(String(row.quote_source)) ||
        (row.reservation_id !== null && typeof row.reservation_id !== 'string')) throw new Error('invalid stored record');
    return Object.freeze({ intent, decision, execution, signalIds: Object.freeze(signalIds as string[]),
      signalSource: row.signal_source as PaperIntentRecord['signalSource'], quoteSource: row.quote_source as PaperIntentRecord['quoteSource'],
      reservationId: row.reservation_id as string | null });
  } catch { throw new PaperStoreError('DATABASE_CORRUPT'); }
}
function makeReview(decision: Decision, reason: string): Decision {
  return { ...decision, status: 'REQUIRE_REVIEW', approvedAmountIn: null, reasons: [...decision.reasons, reason] };
}

export class PaperStore {
  private closed = false;
  constructor(private readonly db: DatabaseSync, private readonly clock: () => Date) {}

  createAccount(input: CreatePaperAccountInput): PaperAccountSnapshot {
    this.ensureOpen();
    if (Object.keys(input).some((key) => !['walletAddress','usdcBalanceAtomic','wethBalanceAtomic','gasBalanceNativeWei','dailyStartEquityUsdcMicros','dailyFundingUsdcMicros','utcDay'].includes(key))) throw new PaperStoreError('INVALID_INPUT');
    const walletAddress = typeof input.walletAddress === 'string' && /^0x[0-9a-fA-F]{40}$/u.test(input.walletAddress) ? input.walletAddress.toLowerCase() : null;
    if (!walletAddress || !unsigned(input.usdcBalanceAtomic) || !unsigned(input.wethBalanceAtomic) || !unsigned(input.gasBalanceNativeWei) ||
        !unsigned(input.dailyStartEquityUsdcMicros) || !signed(input.dailyFundingUsdcMicros ?? '0') || !validUtcDay(input.utcDay)) throw new PaperStoreError('INVALID_INPUT');
    const start = input.dailyStartEquityUsdcMicros;
    if (start === '0') throw new PaperStoreError('INVALID_INPUT');
    try {
      transaction(this.db, () => this.db.prepare(`INSERT INTO paper_accounts
        (wallet_address,version,usdc_balance_atomic,weth_balance_atomic,gas_balance_native_wei,utc_day,daily_start_equity_usdc_micros,daily_funding_usdc_micros,created_at)
        VALUES (?,0,?,?,?,?,?,?,?)`).run(walletAddress, input.usdcBalanceAtomic, input.wethBalanceAtomic, input.gasBalanceNativeWei,
          input.utcDay, start, input.dailyFundingUsdcMicros ?? '0', new Date().toISOString()));
    } catch (error) {
      if (error instanceof PaperStoreError) throw error;
      if (String(error).includes('UNIQUE') || String(error).includes('PRIMARY KEY')) throw new PaperStoreError('ACCOUNT_EXISTS');
      throw error;
    }
    return this.getAccount(walletAddress)!;
  }

  getAccount(walletAddress: string): PaperAccountSnapshot | null {
    this.ensureOpen();
    if (typeof walletAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/u.test(walletAddress)) throw new PaperStoreError('INVALID_INPUT');
    return readAccount(this.db.prepare('SELECT * FROM paper_accounts WHERE wallet_address = ?').get(walletAddress.toLowerCase()) as SqlRow | undefined);
  }

  recordExternalUsdcFunding(walletAddress: string, deltaUsdcMicros: string, utcDay: string): PaperAccountSnapshot {
    if (!signed(deltaUsdcMicros) || deltaUsdcMicros === '-0') throw new PaperStoreError('INVALID_INPUT');
    const value = BigInt(deltaUsdcMicros) < 0n ? (-BigInt(deltaUsdcMicros)).toString() : deltaUsdcMicros;
    return this.recordExternalFunding({ walletAddress, asset: 'USDC', amountAtomic: deltaUsdcMicros, valueUsdcMicros: value, utcDay });
  }

  /** Apply a reconciled external movement. Non-USDC movements require a fresh executable USDC valuation quote. */
  recordExternalFunding(input: ExternalFundingInput): PaperAccountSnapshot {
    this.ensureOpen();
    if (Object.keys(input).some((key) => !['walletAddress','asset','amountAtomic','valueUsdcMicros','quotedAt','utcDay'].includes(key)) ||
        !/^0x[0-9a-fA-F]{40}$/u.test(input.walletAddress) || !['USDC','WETH','NATIVE_GAS'].includes(input.asset) ||
        !signed(input.amountAtomic) || input.amountAtomic === '0' || input.amountAtomic === '-0' || !unsigned(input.valueUsdcMicros) || input.valueUsdcMicros === '0' ||
        !validUtcDay(input.utcDay)) throw new PaperStoreError('INVALID_INPUT');
    const signedAmount = BigInt(input.amountAtomic);
    const absoluteAmount = (signedAmount < 0n ? -signedAmount : signedAmount).toString();
    if (input.asset === 'USDC') {
      if (input.valueUsdcMicros !== absoluteAmount || input.quotedAt !== undefined) throw new PaperStoreError('INVALID_INPUT');
    } else {
      const quoteMs = typeof input.quotedAt === 'string' ? Date.parse(input.quotedAt) : Number.NaN;
      let now: Date;
      try { now = this.clock(); } catch { throw new PaperStoreError('INVALID_INPUT'); }
      const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
      if (typeof input.quotedAt !== 'string' || !Number.isSafeInteger(quoteMs) || !Number.isSafeInteger(nowMs) || new Date(quoteMs).toISOString() !== input.quotedAt || quoteMs < 0 || quoteMs > nowMs || nowMs - quoteMs > G2_LIMITS.quoteFreshnessMs) throw new PaperStoreError('INVALID_INPUT');
    }
    const fundingDelta = signedAmount < 0n ? -BigInt(input.valueUsdcMicros) : BigInt(input.valueUsdcMicros);
    return transaction(this.db, () => {
      const account = readAccount(this.db.prepare('SELECT * FROM paper_accounts WHERE wallet_address = ?').get(input.walletAddress.toLowerCase()) as SqlRow | undefined);
      if (!account) throw new PaperStoreError('ACCOUNT_NOT_FOUND');
      if (account.utcDay !== input.utcDay) throw new PaperStoreError('INVALID_INPUT');
      const nextUsdc = BigInt(account.usdcBalanceAtomic) + (input.asset === 'USDC' ? signedAmount : 0n);
      const nextWeth = BigInt(account.wethBalanceAtomic) + (input.asset === 'WETH' ? signedAmount : 0n);
      const nextGas = BigInt(account.gasBalanceNativeWei) + (input.asset === 'NATIVE_GAS' ? signedAmount : 0n);
      if (nextUsdc < 0n || nextWeth < 0n || nextGas < 0n) throw new PaperStoreError('INVALID_INPUT');
      const nextFunding = BigInt(account.dailyFundingUsdcMicros) + fundingDelta;
      const update = this.db.prepare(`UPDATE paper_accounts SET version = version + 1, usdc_balance_atomic = ?, weth_balance_atomic = ?,
        gas_balance_native_wei = ?, daily_funding_usdc_micros = ? WHERE wallet_address = ? AND version = ?`)
        .run(nextUsdc.toString(), nextWeth.toString(), nextGas.toString(), nextFunding.toString(), account.walletAddress, account.version);
      if (update.changes !== 1) throw new PaperStoreError('DATABASE_FAILURE');
      return this.getAccount(account.walletAddress)!;
    });
  }
  getIntent(intentId: string): PaperIntentRecord | null {
    this.ensureOpen();
    if (typeof intentId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(intentId)) throw new PaperStoreError('INVALID_INPUT');
    return parseStoredRecord(this.db.prepare('SELECT * FROM paper_intents WHERE intent_id = ?').get(intentId) as SqlRow | undefined);
  }

  commitEvaluation(intent: TradeIntent, evaluation: G2Evaluation, expectedAccountVersion: number | null): CommitEvaluationResult {
    this.ensureOpen();
    const parsedIntent = tradeIntentSchema.safeParse(intent);
    const parsedDecision = decisionSchema.safeParse(evaluation.decision);
    if (!parsedIntent.success || !parsedDecision.success || parsedIntent.data.intentId !== parsedDecision.data.intentId ||
        evaluation.signalIds.length > 64 || evaluation.signalIds.some((id) => !/^[0-9a-f-]{36}$/iu.test(id)) ||
        (expectedAccountVersion !== null && (!Number.isSafeInteger(expectedAccountVersion) || expectedAccountVersion < 0))) throw new PaperStoreError('INVALID_INPUT');
    return transaction(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM paper_intents WHERE intent_id = ?').get(intent.intentId) as SqlRow | undefined;
      if (existing) {
        const record = parseStoredRecord(existing)!;
        if (JSON.stringify(record.intent) !== JSON.stringify(parsedIntent.data)) throw new PaperStoreError('INTENT_ID_CONFLICT');
        return { record, replayed: true };
      }
      const account = readAccount(this.db.prepare('SELECT * FROM paper_accounts WHERE wallet_address = ?').get(intent.walletAddress.toLowerCase()) as SqlRow | undefined);
      let decision = parsedDecision.data;
      let projection = evaluation.projection;
      let shouldSimulate = decision.status === 'ALLOW' || (decision.status === 'RESIZE' && projection !== null);
      if (account && expectedAccountVersion !== null && expectedAccountVersion !== account.version) {
        decision = makeReview(decision, 'ACCOUNT_STATE_CHANGED_REEVALUATE'); projection = null; shouldSimulate = false;
      }
      if (!account && shouldSimulate) { decision = makeReview(decision, 'PAPER_ACCOUNT_UNAVAILABLE'); projection = null; shouldSimulate = false; }
      if (shouldSimulate && !projection) { decision = makeReview(decision, 'PAPER_PROJECTION_UNAVAILABLE'); shouldSimulate = false; }
      if (account && shouldSimulate) {
        const pending = this.db.prepare("SELECT COUNT(*) AS count FROM wallet_reservations WHERE wallet_address = ? AND status = 'ACTIVE'").get(account.walletAddress) as SqlRow;
        if (pending.count !== 0) { decision = makeReview(decision, 'WALLET_EXECUTION_PENDING'); projection = null; shouldSimulate = false; }
      }
      const execution = executionStateSchema.parse({ intentId: intent.intentId, mode: 'PAPER', status: shouldSimulate ? 'SIMULATED' : 'NOT_STARTED',
        updatedAt: decision.evaluatedAt, transactionHash: null, failureCode: null });
      const record: PaperIntentRecord = Object.freeze({ intent: parsedIntent.data, decision, execution,
        signalIds: Object.freeze([...evaluation.signalIds]), signalSource: evaluation.signalSource, quoteSource: evaluation.quoteSource,
        reservationId: shouldSimulate ? randomUUID() : null });
      this.db.prepare(`INSERT INTO paper_intents (intent_id,intent_json,decision_json,execution_json,signal_ids_json,signal_source,quote_source,reservation_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(intent.intentId, JSON.stringify(record.intent), JSON.stringify(record.decision), JSON.stringify(record.execution),
          JSON.stringify(record.signalIds), record.signalSource, record.quoteSource, record.reservationId, decision.evaluatedAt);
      if (shouldSimulate && account && projection) {
        const approved = decision.approvedAmountIn;
        const exposure = projection.reservedExposureUsdcMicros;
        if (!approved || !unsigned(approved) || approved === '0' || BigInt(approved) > BigInt(intent.amountIn) ||
            (decision.status === 'ALLOW' && approved !== intent.amountIn) || (decision.status === 'RESIZE' && approved === intent.amountIn) ||
            !unsigned(exposure) || exposure === '0' ||
            !unsigned(projection.usdcBalanceAtomic) || !unsigned(projection.wethBalanceAtomic) || !unsigned(projection.gasBalanceNativeWei) ||
            !unsigned(projection.dailyStartEquityUsdcMicros) || !signed(projection.dailyFundingUsdcMicros) || !validUtcDay(projection.utcDay)) throw new PaperStoreError('INVALID_INPUT');
        this.db.prepare(`INSERT INTO wallet_reservations (reservation_id,owner_kind,intent_id,wallet_address,amount_in,exposure_usdc_micros,status,created_at,updated_at)
          VALUES (?,'PAPER',?,?,?,?, 'ACTIVE',?,?)`).run(record.reservationId, intent.intentId, account.walletAddress, approved, exposure, decision.evaluatedAt, decision.evaluatedAt);
        this.db.prepare(`INSERT INTO paper_reservations (reservation_id,intent_id,wallet_address,approved_amount_in,exposure_usdc_micros,status,created_at,settled_at)
          VALUES (?,?,?,?,?,'PENDING',?,NULL)`).run(record.reservationId, intent.intentId, account.walletAddress, approved, exposure, decision.evaluatedAt);
        const updated = this.db.prepare(`UPDATE paper_accounts SET version = version + 1, usdc_balance_atomic = ?, weth_balance_atomic = ?, gas_balance_native_wei = ?,
          utc_day = ?, daily_start_equity_usdc_micros = ?, daily_funding_usdc_micros = ? WHERE wallet_address = ? AND version = ?`)
          .run(projection.usdcBalanceAtomic, projection.wethBalanceAtomic, projection.gasBalanceNativeWei, projection.utcDay,
            projection.dailyStartEquityUsdcMicros, projection.dailyFundingUsdcMicros, account.walletAddress, account.version);
        if (updated.changes !== 1) throw new PaperStoreError('DATABASE_FAILURE');
        this.db.prepare("UPDATE paper_reservations SET status = 'SETTLED', settled_at = ? WHERE reservation_id = ? AND status = 'PENDING'")
          .run(decision.evaluatedAt, record.reservationId);
        this.db.prepare("UPDATE wallet_reservations SET status = 'SETTLED', updated_at = ? WHERE reservation_id = ? AND status = 'ACTIVE'")
          .run(decision.evaluatedAt, record.reservationId);
      }
      return { record, replayed: false };
    });
  }

  /** Reserve an unresolved wallet slot for recovery/import. It is not exposed by the G2 HTTP API. */
  reservePending(walletAddress: string, reservationId: string, intentId: string, amountIn: string, exposureUsdcMicros: string, createdAt: string): void {
    this.ensureOpen();
    if (!/^0x[0-9a-fA-F]{40}$/u.test(walletAddress) || !/^[0-9a-f-]{36}$/iu.test(reservationId) ||
        !/^[0-9a-f-]{36}$/iu.test(intentId) || !unsigned(amountIn) || amountIn === '0' || !unsigned(exposureUsdcMicros) || exposureUsdcMicros === '0' ||
        typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt)) || new Date(Date.parse(createdAt)).toISOString() !== createdAt) throw new PaperStoreError('INVALID_INPUT');
    transaction(this.db, () => {
      const account = this.getAccount(walletAddress);
      if (!account) throw new PaperStoreError('ACCOUNT_NOT_FOUND');
      const pending = this.db.prepare("SELECT COUNT(*) AS count FROM wallet_reservations WHERE wallet_address = ? AND status = 'ACTIVE'").get(account.walletAddress) as SqlRow;
      if (pending.count !== 0) throw new PaperStoreError('WALLET_RESERVATION_PENDING');
      this.db.prepare(`INSERT INTO wallet_reservations (reservation_id,owner_kind,intent_id,wallet_address,amount_in,exposure_usdc_micros,status,created_at,updated_at)
        VALUES (?,'PAPER',?,?,?,?, 'ACTIVE',?,?)`).run(reservationId, intentId, account.walletAddress, amountIn, exposureUsdcMicros, createdAt, createdAt);
      const intent = { intentId, chainId: 8453, walletAddress: account.walletAddress, sellAsset: 'USDC', buyAsset: 'WETH', amountIn,
        issuedAt: createdAt, expiresAt: new Date(Date.parse(createdAt) + 60_000).toISOString() };
      const decision = { decisionId: randomUUID(), intentId, status: 'REQUIRE_REVIEW', evaluatedAt: createdAt, policyVersion: 'recovery',
        requestedAmountIn: amountIn, approvedAmountIn: null, reasons: ['IMPORTED_PENDING_RESERVATION'] };
      const execution = { intentId, mode: 'PAPER', status: 'UNKNOWN', updatedAt: createdAt, transactionHash: null, failureCode: 'UNCERTAIN' };
      this.db.prepare(`INSERT INTO paper_intents (intent_id,intent_json,decision_json,execution_json,signal_ids_json,signal_source,quote_source,reservation_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(intentId, JSON.stringify(intent), JSON.stringify(decision), JSON.stringify(execution), '[]', 'none', 'none', reservationId, createdAt);
      this.db.prepare(`INSERT INTO paper_reservations (reservation_id,intent_id,wallet_address,approved_amount_in,exposure_usdc_micros,status,created_at,settled_at) VALUES (?,?,?,?,?,'UNKNOWN',?,NULL)`)
        .run(reservationId, intentId, account.walletAddress, amountIn, exposureUsdcMicros, createdAt);
    });
  }

  /** @internal Execution lifecycle operations share this connection and reservation authority. */
  executionRead<T>(read: (db: DatabaseSync) => T): T { this.ensureOpen(); return read(this.db); }
  /** @internal The immediate transaction orders execution claims against stop changes and paper commits. */
  executionTransaction<T>(work: (db: DatabaseSync, clock: () => Date) => T): T {
    this.ensureOpen();
    return transaction(this.db, () => work(this.db, this.clock));
  }

  close(): void { if (this.closed) return; try { this.db.close(); this.closed = true; } catch { throw new PaperStoreError('DATABASE_FAILURE'); } }
  private ensureOpen(): void { if (this.closed) throw new PaperStoreError('STORE_CLOSED'); }
}

export function initializePaperStore(options: PaperStoreOptions): PaperStore {
  const config = normalizedOptions(options);
  let descriptor: number;
  try { descriptor = openSync(config.databasePath, 'wx', 0o600); }
  catch (error) { if (isRecord(error) && error.code === 'EEXIST') throw new PaperStoreError('DATABASE_ALREADY_EXISTS'); throw new PaperStoreError('DATABASE_PATH_INVALID'); }
  try { closeSync(descriptor); } catch { throw new PaperStoreError('DATABASE_FAILURE'); }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(config.databasePath); configure(db);
    if ((db.prepare('PRAGMA journal_mode = WAL').get() as SqlRow | undefined)?.journal_mode !== 'wal') throw new PaperStoreError('DATABASE_FAILURE');
    transaction(db, () => {
      db?.exec(META_SQL); db?.exec(ACCOUNTS_SQL); db?.exec(INTENTS_SQL); db?.exec(RESERVATIONS_SQL);
      db?.exec(WALLET_RESERVATIONS_SQL); db?.exec(WALLET_RESERVATIONS_INDEX_SQL);
      db?.exec(EXECUTION_CONTROL_SQL); db?.exec(EXECUTION_LIFECYCLE_SQL); db?.exec(EXECUTION_EVENTS_SQL); db?.exec(EXECUTION_G3B_OPERATIONS_SQL); db?.exec(EXECUTION_G3C_SESSIONS_SQL); db?.exec(EXECUTION_G3C_WORKFLOWS_SQL);
      db?.exec(`PRAGMA user_version = ${PAPER_STORE_SCHEMA_VERSION}`);
      db?.prepare('INSERT INTO paper_meta (singleton,schema_version,store_id) VALUES (1,?,?)').run(PAPER_STORE_SCHEMA_VERSION, config.storeId);
      const now = config.clock();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new PaperStoreError('DATABASE_FAILURE');
      db?.prepare('INSERT INTO execution_control (singleton,stopped,reason,changed_at) VALUES (1,1,?,?)').run('INITIALIZED_STOPPED', now.toISOString());
    });
    assertIntegrity(db); assertSchema(db, config.storeId); return new PaperStore(db, config.clock);
  } catch (error) { try { db?.close(); } catch { /* Preserve failed initialized state. */ } if (error instanceof PaperStoreError) throw error; throw new PaperStoreError('DATABASE_FAILURE'); }
}
export function openPaperStore(options: PaperStoreOptions): PaperStore {
  const config = normalizedOptions(options); const db = openExisting(config.databasePath);
  try { assertIntegrity(db); migrateLegacyPaperStore(db, config.storeId, config.clock); assertIntegrity(db); assertSchema(db, config.storeId); return new PaperStore(db, config.clock); }
  catch (error) { try { db.close(); } catch { /* Preserve state on fail-closed open. */ } if (error instanceof PaperStoreError) throw error; throw new PaperStoreError('DATABASE_CORRUPT'); }
}

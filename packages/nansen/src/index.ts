import { closeSync, lstatSync, openSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const LEDGER_SCHEMA_VERSION = 3 as const;
export const NANSEN_COST_PROFILE_VERSION = 'nansen-2026-09-22-v1' as const;
export const NANSEN_OPERATION_COSTS = Object.freeze({
  TOKEN_SCREENER: 1,
  FLOW_INTELLIGENCE: 1,
  SMART_MONEY_NETFLOW: 5,
  TOKEN_OHLCV: 1,
} as const);
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

const OUTCOMES = ['SUCCESS', 'HTTP_ERROR', 'TRANSPORT_ERROR', 'CANCELLED', 'RESPONSE_ERROR'] as const;
const OUTCOME_SET = new Set<string>(OUTCOMES);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

export type NansenOperation = keyof typeof NANSEN_OPERATION_COSTS;
export type NansenOutcome = (typeof OUTCOMES)[number];
export type AttemptOutcome = NansenOutcome | 'PENDING';
export type LedgerErrorCode =
  | 'INVALID_INPUT' | 'DATABASE_PATH_INVALID' | 'DATABASE_ALREADY_EXISTS' | 'DATABASE_NOT_FOUND'
  | 'DATABASE_CORRUPT' | 'UNSUPPORTED_SCHEMA_VERSION' | 'UNKNOWN_COST_PROFILE' | 'UNKNOWN_OPERATION'
  | 'CONFIGURATION_MISMATCH' | 'BUDGET_EXHAUSTED' | 'DUPLICATE_ATTEMPT_CONFLICT'
  | 'ATTEMPT_NOT_FOUND' | 'COMPLETION_CONFLICT' | 'RECONCILIATION_CONFLICT' | 'ACCOUNTING_HALTED' | 'INTEGER_OVERFLOW'
  | 'DATABASE_FAILURE' | 'LEDGER_CLOSED';

const ERROR_MESSAGES: Record<LedgerErrorCode, string> = {
  INVALID_INPUT: 'Ledger input is invalid.',
  DATABASE_PATH_INVALID: 'Database path must identify an absolute regular-file location.',
  DATABASE_ALREADY_EXISTS: 'Database path already exists; initialization never overwrites it.',
  DATABASE_NOT_FOUND: 'Existing ledger database was not found.',
  DATABASE_CORRUPT: 'Ledger database is corrupt or inconsistent; accounting is halted.',
  UNSUPPORTED_SCHEMA_VERSION: 'Ledger schema version is unsupported.',
  UNKNOWN_COST_PROFILE: 'Cost profile version is not recognized.',
  UNKNOWN_OPERATION: 'Nansen operation is not in the closed cost profile.',
  CONFIGURATION_MISMATCH: 'Ledger identity or immutable configuration does not match.',
  BUDGET_EXHAUSTED: 'The configured request budget is exhausted.',
  DUPLICATE_ATTEMPT_CONFLICT: 'Attempt ID was reused with different reservation inputs.',
  ATTEMPT_NOT_FOUND: 'Reservation attempt was not found.',
  COMPLETION_CONFLICT: 'Attempt already has a different terminal result.',
  RECONCILIATION_CONFLICT: 'Attempt charge cannot be reconciled with the supplied result.',
  ACCOUNTING_HALTED: 'New reservations are halted pending operator reconciliation.',
  INTEGER_OVERFLOW: 'Credit total exceeds JavaScript safe integer range.',
  DATABASE_FAILURE: 'Ledger database operation failed; no dispatch grant was issued.',
  LEDGER_CLOSED: 'Ledger connection is closed.',
};

export interface LedgerErrorDetails {
  allocatedCreditsExact?: string;
  reconciliationRequired?: boolean;
  haltReason?: 'CHARGE_OVERRUN' | null;
}
export class CreditLedgerError extends Error {
  readonly code: LedgerErrorCode;
  readonly details: Readonly<LedgerErrorDetails> | null;
  constructor(code: LedgerErrorCode, details?: LedgerErrorDetails) {
    super(ERROR_MESSAGES[code]);
    this.name = 'CreditLedgerError';
    this.code = code;
    this.details = details === undefined ? null : Object.freeze({ ...details });
  }
}

export interface LedgerOptions {
  databasePath: string;
  budgetId: string;
  limitCredits: number;
  costProfileVersion: string;
  clock?: () => Date;
}
export interface ReserveAttemptInput {
  attemptId: string;
  operation: string;
  requestFingerprint: string;
}
export interface RecordTerminalResultInput {
  attemptId: string;
  outcome: NansenOutcome;
  httpStatus?: number | null;
  providerRequestId?: string | null;
  chargedCredits?: number | null;
}
export interface ReconcileUnknownChargeInput {
  attemptId: string;
  chargedCredits: number;
}
export interface AttemptRecord {
  attemptId: string;
  budgetId: string;
  operation: NansenOperation;
  costProfileVersion: string;
  requestFingerprint: string;
  reservedCredits: number;
  reportedChargedCredits: number | null;
  outcome: AttemptOutcome;
  createdAt: string;
  completedAt: string | null;
  httpStatus: number | null;
  providerRequestId: string | null;
}
export interface ReservationResult {
  attempt: AttemptRecord;
  dispatchGranted: boolean;
}
export interface LedgerSnapshot {
  budgetId: string;
  costProfileVersion: string;
  limitCredits: number;
  reservedEstimateCredits: number;
  allocatedCredits: number;
  remainingCredits: number;
  overrunCredits: number;
  overBudgetCredits: number;
  reportedChargedCreditsTotal: number | null;
  reportedChargeCount: number;
  pendingAttemptCount: number;
  reconciliationRequired: boolean;
  haltReason: 'CHARGE_OVERRUN' | null;
}
export interface NormalizedLedgerOptions {
  databasePath: string;
  budgetId: string;
  limitCredits: number;
  costProfileVersion: string;
  clock: () => Date;
}
interface LedgerMeta {
  schemaVersion: number;
  budgetId: string;
  limitCredits: number;
  costProfileVersion: string;
  allocatedCredits: bigint;
  halted: boolean;
  haltReason: 'CHARGE_OVERRUN' | null;
  createdAtMs: number;
}
interface AccountingState {
  meta: LedgerMeta;
  attempts: AttemptRecord[];
  reservedEstimateCredits: bigint;
  allocatedCredits: bigint;
  remainingCredits: bigint;
  overrunCredits: bigint;
  reportedChargedCreditsTotal: bigint | null;
  reportedChargeCount: number;
  pendingAttemptCount: number;
}
type SqlRow = Record<string, unknown>;
type Statement = ReturnType<DatabaseSync['prepare']>;

const COST_PROFILES: Readonly<Record<string, Readonly<Record<string, number>>>> = Object.freeze({
  [NANSEN_COST_PROFILE_VERSION]: NANSEN_OPERATION_COSTS,
});
const COLUMNS = {
  ledger_meta: [
    'singleton', 'schema_version', 'budget_id', 'limit_credits', 'profile_version',
    'allocated_credits', 'halted', 'halt_reason', 'created_at_ms',
  ],
  attempts: [
    'attempt_id', 'budget_id', 'profile_version', 'operation', 'request_fingerprint',
    'reserved_credits', 'charged_credits', 'outcome', 'http_status', 'provider_request_id',
    'created_at_ms', 'completed_at_ms',
  ],
} as const;

const META_SQL = [
  'CREATE TABLE ledger_meta (',
  'singleton INTEGER PRIMARY KEY CHECK (singleton = 1),',
  "schema_version INTEGER NOT NULL CHECK (typeof(schema_version) = 'integer' AND schema_version > 0),",
  'budget_id TEXT NOT NULL UNIQUE CHECK (length(budget_id) BETWEEN 1 AND 128),',
  "limit_credits INTEGER NOT NULL CHECK (typeof(limit_credits) = 'integer' AND limit_credits >= 0),",
  'profile_version TEXT NOT NULL CHECK (length(profile_version) BETWEEN 1 AND 64),',
  "allocated_credits TEXT NOT NULL CHECK (length(allocated_credits) BETWEEN 1 AND 128 AND allocated_credits NOT GLOB '*[^0-9]*' AND (allocated_credits = '0' OR substr(allocated_credits, 1, 1) BETWEEN '1' AND '9')),",
  'halted INTEGER NOT NULL CHECK (halted IN (0, 1)),',
  "halt_reason TEXT CHECK (halt_reason IS NULL OR halt_reason = 'CHARGE_OVERRUN'),",
  "created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms >= 0)",
  ') STRICT',
].join('\n');
const ATTEMPTS_SQL = [
  'CREATE TABLE attempts (',
  'attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id) BETWEEN 1 AND 128),',
  'budget_id TEXT NOT NULL REFERENCES ledger_meta(budget_id),',
  'profile_version TEXT NOT NULL CHECK (length(profile_version) BETWEEN 1 AND 64),',
  "operation TEXT NOT NULL CHECK (operation IN ('TOKEN_SCREENER', 'FLOW_INTELLIGENCE', 'SMART_MONEY_NETFLOW', 'TOKEN_OHLCV')),",
  "request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),",
  "reserved_credits INTEGER NOT NULL CHECK (typeof(reserved_credits) = 'integer' AND reserved_credits > 0),",
  "charged_credits INTEGER CHECK (charged_credits IS NULL OR (typeof(charged_credits) = 'integer' AND charged_credits >= 0)),",
  "outcome TEXT CHECK (outcome IS NULL OR outcome IN ('SUCCESS', 'HTTP_ERROR', 'TRANSPORT_ERROR', 'CANCELLED', 'RESPONSE_ERROR')),",
  "http_status INTEGER CHECK (http_status IS NULL OR (typeof(http_status) = 'integer' AND http_status BETWEEN 100 AND 599)),",
  'provider_request_id TEXT CHECK (provider_request_id IS NULL OR length(provider_request_id) BETWEEN 1 AND 128),',
  "created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms >= 0),",
  'completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR (typeof(completed_at_ms) = \'integer\' AND completed_at_ms >= created_at_ms)),',
  'CHECK ((outcome IS NULL AND completed_at_ms IS NULL AND http_status IS NULL AND provider_request_id IS NULL AND charged_credits IS NULL) OR (outcome IS NOT NULL AND completed_at_ms IS NOT NULL))',
  ') STRICT',
].join('\n');

const ATTEMPTS_V2_SQL = ATTEMPTS_SQL.replace(`, 'TOKEN_OHLCV'`, '');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function assertExactKeys(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new CreditLedgerError('INVALID_INPUT');
  }
}
function assertIdentifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || !IDENTIFIER.test(value)) {
    throw new CreditLedgerError('INVALID_INPUT');
  }
}
function assertNonNegativeSafeInteger(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new CreditLedgerError('INVALID_INPUT');
  }
}
function assertProfileVersion(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !Object.hasOwn(COST_PROFILES, value)) {
    throw new CreditLedgerError('UNKNOWN_COST_PROFILE');
  }
}
function readClock(clock: () => Date): number {
  let value: Date;
  try { value = clock(); } catch { throw new CreditLedgerError('INVALID_INPUT'); }
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime()) || value.getTime() < 0) {
    throw new CreditLedgerError('INVALID_INPUT');
  }
  return value.getTime();
}
function normalizeOptions(value: unknown): NormalizedLedgerOptions {
  assertExactKeys(value, ['databasePath', 'budgetId', 'limitCredits', 'costProfileVersion', 'clock']);
  if (
    typeof value.databasePath !== 'string' ||
    !isAbsolute(value.databasePath) ||
    value.databasePath.includes(String.fromCharCode(0))
  ) throw new CreditLedgerError('DATABASE_PATH_INVALID');
  assertIdentifier(value.budgetId);
  assertNonNegativeSafeInteger(value.limitCredits);
  assertProfileVersion(value.costProfileVersion);
  const clock = value.clock === undefined ? () => new Date() : value.clock;
  if (typeof clock !== 'function') throw new CreditLedgerError('INVALID_INPUT');
  return {
    databasePath: value.databasePath,
    budgetId: value.budgetId,
    limitCredits: value.limitCredits,
    costProfileVersion: value.costProfileVersion,
    clock: clock as () => Date,
  };
}
export function getReservedCredits(
  operation: unknown,
  profileVersion: unknown = NANSEN_COST_PROFILE_VERSION,
): number {
  assertProfileVersion(profileVersion);
  const profile = COST_PROFILES[profileVersion];
  if (!profile) throw new CreditLedgerError('UNKNOWN_COST_PROFILE');
  if (typeof operation !== 'string' || !Object.hasOwn(profile, operation)) {
    throw new CreditLedgerError('UNKNOWN_OPERATION');
  }
  const cost = profile[operation];
  if (typeof cost !== 'number' || !Number.isSafeInteger(cost) || cost <= 0) {
    throw new CreditLedgerError('UNKNOWN_OPERATION');
  }
  return cost;
}
function normalizeReserve(value: unknown, profileVersion: string) {
  assertExactKeys(value, ['attemptId', 'operation', 'requestFingerprint']);
  assertIdentifier(value.attemptId);
  if (typeof value.requestFingerprint !== 'string' || !FINGERPRINT.test(value.requestFingerprint)) {
    throw new CreditLedgerError('INVALID_INPUT');
  }
  const reservedCredits = getReservedCredits(value.operation, profileVersion);
  return {
    attemptId: value.attemptId,
    operation: value.operation as NansenOperation,
    requestFingerprint: value.requestFingerprint,
    reservedCredits,
  };
}
function normalizeTerminal(value: unknown) {
  assertExactKeys(value, ['attemptId', 'outcome', 'httpStatus', 'providerRequestId', 'chargedCredits']);
  assertIdentifier(value.attemptId);
  if (typeof value.outcome !== 'string' || !OUTCOME_SET.has(value.outcome)) {
    throw new CreditLedgerError('INVALID_INPUT');
  }
  const httpStatus = value.httpStatus == null ? null : value.httpStatus;
  if (
    httpStatus !== null &&
    (typeof httpStatus !== 'number' || !Number.isSafeInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)
  ) throw new CreditLedgerError('INVALID_INPUT');
  const providerRequestId = value.providerRequestId == null ? null : value.providerRequestId;
  if (providerRequestId !== null) assertIdentifier(providerRequestId);
  const chargedCredits = value.chargedCredits == null ? null : value.chargedCredits;
  if (chargedCredits !== null) assertNonNegativeSafeInteger(chargedCredits);
  return {
    attemptId: value.attemptId,
    outcome: value.outcome as NansenOutcome,
    httpStatus,
    providerRequestId,
    chargedCredits,
  };
}
function normalizeUnknownChargeReconciliation(value: unknown): ReconcileUnknownChargeInput {
  assertExactKeys(value, ['attemptId', 'chargedCredits']);
  assertIdentifier(value.attemptId);
  assertNonNegativeSafeInteger(value.chargedCredits);
  return { attemptId: value.attemptId, chargedCredits: value.chargedCredits };
}
function safeSqlInteger(value: unknown): number {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_SAFE_BIGINT) {
    throw new CreditLedgerError('DATABASE_CORRUPT');
  }
  return Number(value);
}
function readCreditTotal(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 128) {
    throw new CreditLedgerError('DATABASE_CORRUPT');
  }
  return BigInt(value);
}
function haltDetails(state: AccountingState): LedgerErrorDetails {
  return {
    allocatedCreditsExact: state.allocatedCredits.toString(),
    reconciliationRequired: true,
    haltReason: state.meta.haltReason,
  };
}
function getSqlRow(statement: Statement, ...params: (string | number | null)[]): SqlRow | undefined {
  statement.setReadBigInts(true);
  return statement.get(...params) as SqlRow | undefined;
}
function getSqlRows(statement: Statement, ...params: (string | number | null)[]): SqlRow[] {
  statement.setReadBigInts(true);
  return statement.all(...params) as SqlRow[];
}
function configureConnection(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = ' + SQLITE_BUSY_TIMEOUT_MS);
  db.exec('PRAGMA synchronous = FULL');
  const journal = db.prepare('PRAGMA journal_mode').get() as SqlRow | undefined;
  const foreign = db.prepare('PRAGMA foreign_keys').get() as SqlRow | undefined;
  const timeout = db.prepare('PRAGMA busy_timeout').get() as SqlRow | undefined;
  if (journal?.journal_mode !== 'wal' || foreign?.foreign_keys !== 1 || timeout?.timeout !== SQLITE_BUSY_TIMEOUT_MS) {
    throw new CreditLedgerError('DATABASE_CORRUPT');
  }
}
function enableWal(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA journal_mode = WAL').get() as SqlRow | undefined;
  if (row?.journal_mode !== 'wal') throw new CreditLedgerError('DATABASE_FAILURE');
}
function assertIntegrity(db: DatabaseSync): void {
  let result: SqlRow[];
  try { result = db.prepare('PRAGMA integrity_check').all() as SqlRow[]; }
  catch { throw new CreditLedgerError('DATABASE_CORRUPT'); }
  if (result.length !== 1 || result[0]?.integrity_check !== 'ok') throw new CreditLedgerError('DATABASE_CORRUPT');
  if (db.prepare('PRAGMA foreign_key_check').all().length !== 0) throw new CreditLedgerError('DATABASE_CORRUPT');
}
function normalizeSchemaSql(sql: string): string {
  return sql.replaceAll(String.fromCharCode(32), '').replaceAll(String.fromCharCode(10), '').replaceAll(String.fromCharCode(13), '').replaceAll(String.fromCharCode(34), '').toLowerCase();
}
function assertSchema(db: DatabaseSync): void {
  const rows = db.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as SqlRow[];
  if (
    rows.length !== 2 ||
    rows[0]?.type !== 'table' || rows[0]?.name !== 'attempts' ||
    rows[1]?.type !== 'table' || rows[1]?.name !== 'ledger_meta'
  ) throw new CreditLedgerError('DATABASE_CORRUPT');

  for (const table of ['ledger_meta', 'attempts'] as const) {
    const schema = rows.find((row) => row.name === table)?.sql;
    const expected = table === 'ledger_meta' ? META_SQL : ATTEMPTS_SQL;
    if (typeof schema !== 'string' || normalizeSchemaSql(schema) !== normalizeSchemaSql(expected)) {
      throw new CreditLedgerError('DATABASE_CORRUPT');
    }
    const info = db.prepare('PRAGMA table_info(' + table + ')').all() as SqlRow[];
    const names = info.map((row) => row.name);
    if (names.length !== COLUMNS[table].length || names.some((name, i) => name !== COLUMNS[table][i])) {
      throw new CreditLedgerError('DATABASE_CORRUPT');
    }
  }
}
function readAttemptRow(db: DatabaseSync, id: string): SqlRow | undefined {
  return getSqlRow(db.prepare(
    'SELECT attempt_id, budget_id, profile_version, operation, request_fingerprint, reserved_credits, charged_credits, outcome, http_status, provider_request_id, created_at_ms, completed_at_ms FROM attempts WHERE attempt_id = ?',
  ), id);
}
function toAttempt(row: SqlRow): AttemptRecord {
  const { attempt_id, budget_id, profile_version, operation, request_fingerprint } = row;
  if (
    typeof attempt_id !== 'string' || typeof budget_id !== 'string' ||
    typeof profile_version !== 'string' || typeof operation !== 'string' ||
    typeof request_fingerprint !== 'string' || !FINGERPRINT.test(request_fingerprint)
  ) throw new CreditLedgerError('DATABASE_CORRUPT');
  if (!Object.hasOwn(COST_PROFILES, profile_version)) throw new CreditLedgerError('UNKNOWN_COST_PROFILE');
  if (!Object.hasOwn(NANSEN_OPERATION_COSTS, operation)) throw new CreditLedgerError('DATABASE_CORRUPT');

  const reservedCredits = safeSqlInteger(row.reserved_credits);
  const reportedChargedCredits = row.charged_credits === null ? null : safeSqlInteger(row.charged_credits);
  const createdAtMs = safeSqlInteger(row.created_at_ms);
  const completedAtMs = row.completed_at_ms === null ? null : safeSqlInteger(row.completed_at_ms);
  const httpStatus = row.http_status === null ? null : safeSqlInteger(row.http_status);
  const providerRequestId = row.provider_request_id;
  const outcome = row.outcome;

  try { assertIdentifier(attempt_id); assertIdentifier(budget_id); }
  catch { throw new CreditLedgerError('DATABASE_CORRUPT'); }
  if (providerRequestId !== null) {
    if (typeof providerRequestId !== 'string') throw new CreditLedgerError('DATABASE_CORRUPT');
    try { assertIdentifier(providerRequestId); } catch { throw new CreditLedgerError('DATABASE_CORRUPT'); }
  }
  if (httpStatus !== null && (httpStatus < 100 || httpStatus > 599)) throw new CreditLedgerError('DATABASE_CORRUPT');
  if (outcome !== null && (typeof outcome !== 'string' || !OUTCOME_SET.has(outcome))) {
    throw new CreditLedgerError('DATABASE_CORRUPT');
  }
  if ((outcome === null) !== (completedAtMs === null)) throw new CreditLedgerError('DATABASE_CORRUPT');
  if (completedAtMs !== null && completedAtMs < createdAtMs) throw new CreditLedgerError('DATABASE_CORRUPT');
  if (outcome === null && (reportedChargedCredits !== null || httpStatus !== null || providerRequestId !== null)) {
    throw new CreditLedgerError('DATABASE_CORRUPT');
  }
  if (getReservedCredits(operation, profile_version) !== reservedCredits) {
    throw new CreditLedgerError('DATABASE_CORRUPT');
  }
  return {
    attemptId: attempt_id,
    budgetId: budget_id,
    operation: operation as NansenOperation,
    costProfileVersion: profile_version,
    requestFingerprint: request_fingerprint,
    reservedCredits,
    reportedChargedCredits,
    outcome: outcome === null ? 'PENDING' : outcome as NansenOutcome,
    createdAt: new Date(createdAtMs).toISOString(),
    completedAt: completedAtMs === null ? null : new Date(completedAtMs).toISOString(),
    httpStatus,
    providerRequestId: providerRequestId as string | null,
  };
}
function readState(db: DatabaseSync, config: NormalizedLedgerOptions): AccountingState {
  try {
    assertIntegrity(db);
    const pragma = getSqlRow(db.prepare('PRAGMA user_version'));
    if (!pragma || typeof pragma.user_version !== 'bigint') throw new CreditLedgerError('DATABASE_CORRUPT');
    const pragmaVersion = safeSqlInteger(pragma.user_version);
    if (pragmaVersion === 0) throw new CreditLedgerError('DATABASE_CORRUPT');
    if (pragmaVersion !== LEDGER_SCHEMA_VERSION) throw new CreditLedgerError('UNSUPPORTED_SCHEMA_VERSION');
    assertSchema(db);

    const meta = getSqlRow(db.prepare(
      'SELECT schema_version, budget_id, limit_credits, profile_version, allocated_credits, halted, halt_reason, created_at_ms FROM ledger_meta WHERE singleton = 1',
    ));
    if (!meta) throw new CreditLedgerError('DATABASE_CORRUPT');
    const schemaVersion = safeSqlInteger(meta.schema_version);
    if (schemaVersion !== LEDGER_SCHEMA_VERSION) throw new CreditLedgerError('UNSUPPORTED_SCHEMA_VERSION');
    if (typeof meta.budget_id !== 'string' || typeof meta.profile_version !== 'string') {
      throw new CreditLedgerError('DATABASE_CORRUPT');
    }
    if (!Object.hasOwn(COST_PROFILES, meta.profile_version)) throw new CreditLedgerError('UNKNOWN_COST_PROFILE');
    try { assertIdentifier(meta.budget_id); } catch { throw new CreditLedgerError('DATABASE_CORRUPT'); }
    const limitCredits = safeSqlInteger(meta.limit_credits);
    const allocatedInMeta = readCreditTotal(meta.allocated_credits);
    const createdAtMs = safeSqlInteger(meta.created_at_ms);
    const haltedInt = safeSqlInteger(meta.halted);
    if (haltedInt !== 0 && haltedInt !== 1) throw new CreditLedgerError('DATABASE_CORRUPT');
    if (meta.halt_reason !== null && meta.halt_reason !== 'CHARGE_OVERRUN') {
      throw new CreditLedgerError('DATABASE_CORRUPT');
    }
    if (
      meta.budget_id !== config.budgetId ||
      limitCredits !== config.limitCredits ||
      meta.profile_version !== config.costProfileVersion
    ) throw new CreditLedgerError('CONFIGURATION_MISMATCH');

    const rows = getSqlRows(db.prepare(
      'SELECT attempt_id, budget_id, profile_version, operation, request_fingerprint, reserved_credits, charged_credits, outcome, http_status, provider_request_id, created_at_ms, completed_at_ms FROM attempts ORDER BY attempt_id',
    ));
    const attempts = rows.map(toAttempt);
    let reserved = 0n, allocated = 0n, providerCharged = 0n, overrun = 0n;
    let reportedCount = 0, pendingCount = 0, hasOverrun = false;
    for (const attempt of attempts) {
      if (attempt.budgetId !== meta.budget_id || attempt.costProfileVersion !== meta.profile_version) {
        throw new CreditLedgerError('DATABASE_CORRUPT');
      }
      const amount = BigInt(attempt.reservedCredits);
      const charged = attempt.reportedChargedCredits === null ? 0n : BigInt(attempt.reportedChargedCredits);
      reserved += amount;
      allocated += amount > charged ? amount : charged;
      if (attempt.reportedChargedCredits !== null) {
        providerCharged += charged;
        reportedCount += 1;
      }
      if (attempt.outcome === 'PENDING') pendingCount += 1;
      if (charged > amount) {
        overrun += charged - amount;
        hasOverrun = true;
      }
    }
    if (allocated !== allocatedInMeta) throw new CreditLedgerError('DATABASE_CORRUPT');
    if (Boolean(haltedInt) !== hasOverrun || (meta.halt_reason === 'CHARGE_OVERRUN') !== hasOverrun) {
      throw new CreditLedgerError('DATABASE_CORRUPT');
    }

    const limit = BigInt(limitCredits);
    const metaValue: LedgerMeta = {
      schemaVersion,
      budgetId: meta.budget_id,
      limitCredits,
      costProfileVersion: meta.profile_version,
      allocatedCredits: allocated,
      halted: Boolean(haltedInt),
      haltReason: meta.halt_reason as 'CHARGE_OVERRUN' | null,
      createdAtMs,
    };
    return {
      meta: metaValue,
      attempts,
      reservedEstimateCredits: reserved,
      allocatedCredits: allocated,
      remainingCredits: allocated >= limit ? 0n : limit - allocated,
      overrunCredits: overrun,
      reportedChargedCreditsTotal: reportedCount === 0 ? null : providerCharged,
      reportedChargeCount: reportedCount,
      pendingAttemptCount: pendingCount,
    };
  } catch (error) {
    if (error instanceof CreditLedgerError) throw error;
    throw new CreditLedgerError('DATABASE_CORRUPT');
  }
}
function transaction<T>(db: DatabaseSync, mode: 'IMMEDIATE' | 'DEFERRED', action: () => T): T {
  let started = false;
  try {
    db.exec('BEGIN ' + mode);
    started = true;
    const value = action();
    db.exec('COMMIT');
    started = false;
    return value;
  } catch (error) {
    if (started) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the original fail-closed state. */ }
    }
    if (error instanceof CreditLedgerError) throw error;
    throw new CreditLedgerError('DATABASE_FAILURE');
  }
}
function findAttempt(attempts: readonly AttemptRecord[], id: string): AttemptRecord | undefined {
  return attempts.find((attempt) => attempt.attemptId === id);
}
function makePending(input: ReturnType<typeof normalizeReserve>, config: NormalizedLedgerOptions, time: number): AttemptRecord {
  return {
    attemptId: input.attemptId,
    budgetId: config.budgetId,
    operation: input.operation,
    costProfileVersion: config.costProfileVersion,
    requestFingerprint: input.requestFingerprint,
    reservedCredits: input.reservedCredits,
    reportedChargedCredits: null,
    outcome: 'PENDING',
    createdAt: new Date(time).toISOString(),
    completedAt: null,
    httpStatus: null,
    providerRequestId: null,
  };
}
function openExistingFile(databasePath: string): DatabaseSync {
  let stat;
  try { stat = lstatSync(databasePath); }
  catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') throw new CreditLedgerError('DATABASE_NOT_FOUND');
    throw new CreditLedgerError('DATABASE_PATH_INVALID');
  }
  if (!stat.isFile()) throw new CreditLedgerError('DATABASE_PATH_INVALID');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(databasePath);
    configureConnection(db);
    return db;
  } catch {
    try { db?.close(); } catch { /* The existing file remains untouched. */ }
    throw new CreditLedgerError('DATABASE_CORRUPT');
  }
}
function assertLedgerV2Schema(db: DatabaseSync): void {
  const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as SqlRow[];
  if (rows.length !== 2 || rows[0]?.type !== 'table' || rows[0]?.name !== 'attempts' ||
      rows[1]?.type !== 'table' || rows[1]?.name !== 'ledger_meta') throw new CreditLedgerError('DATABASE_CORRUPT');
  for (const table of ['ledger_meta', 'attempts'] as const) {
    const sql = rows.find((row) => row.name === table)?.sql;
    const expected = table === 'ledger_meta' ? META_SQL : ATTEMPTS_V2_SQL;
    if (typeof sql !== 'string' || normalizeSchemaSql(sql) !== normalizeSchemaSql(expected)) throw new CreditLedgerError('DATABASE_CORRUPT');
    const columns = (db.prepare('PRAGMA table_info(' + table + ')').all() as SqlRow[]).map((row) => row.name);
    if (columns.length !== COLUMNS[table].length || columns.some((name, i) => name !== COLUMNS[table][i])) {
      throw new CreditLedgerError('DATABASE_CORRUPT');
    }
  }
}

function migrateLedgerV2(db: DatabaseSync, config: NormalizedLedgerOptions): void {
  const version = getSqlRow(db.prepare('PRAGMA user_version'));
  if (version?.user_version !== 2n) {
    if (version?.user_version === BigInt(LEDGER_SCHEMA_VERSION)) return;
    if (version?.user_version === 0n) throw new CreditLedgerError('DATABASE_CORRUPT');
    throw new CreditLedgerError('UNSUPPORTED_SCHEMA_VERSION');
  }
  assertIntegrity(db);
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(db, 'IMMEDIATE', () => {
      const currentVersion = getSqlRow(db.prepare('PRAGMA user_version'));
      if (currentVersion?.user_version !== 2n) throw new CreditLedgerError('UNSUPPORTED_SCHEMA_VERSION');
      assertLedgerV2Schema(db);
      const meta = getSqlRow(db.prepare('SELECT schema_version, budget_id, limit_credits, profile_version FROM ledger_meta WHERE singleton = 1'));
      if (!meta || safeSqlInteger(meta.schema_version) !== 2 || meta.budget_id !== config.budgetId ||
          safeSqlInteger(meta.limit_credits) !== config.limitCredits || meta.profile_version !== config.costProfileVersion) {
        throw new CreditLedgerError('CONFIGURATION_MISMATCH');
      }
      const before = safeSqlInteger(getSqlRow(db.prepare('SELECT COUNT(*) AS count FROM attempts'))?.count);
      const replacement = ATTEMPTS_SQL.replace('CREATE TABLE attempts (', 'CREATE TABLE attempts_v3 (');
      if (replacement === ATTEMPTS_SQL) throw new CreditLedgerError('DATABASE_FAILURE');
      db.exec(replacement);
      db.exec('INSERT INTO attempts_v3 SELECT * FROM attempts');
      db.exec('DROP TABLE attempts');
      db.exec('ALTER TABLE attempts_v3 RENAME TO attempts');
      db.prepare('UPDATE ledger_meta SET schema_version = ? WHERE singleton = 1').run(LEDGER_SCHEMA_VERSION);
      db.exec('PRAGMA user_version = ' + LEDGER_SCHEMA_VERSION);
      const after = safeSqlInteger(getSqlRow(db.prepare('SELECT COUNT(*) AS count FROM attempts'))?.count);
      if (before !== after) throw new CreditLedgerError('DATABASE_CORRUPT');
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  assertIntegrity(db);
  assertSchema(db);
}
function verifyConfig(db: DatabaseSync, config: NormalizedLedgerOptions): void {
  transaction(db, 'DEFERRED', () => { readState(db, config); });
}

export class NansenCreditLedger {
  private closed = false;
  constructor(private readonly db: DatabaseSync, private readonly config: NormalizedLedgerOptions) {}

  reserveAttempt(input: ReserveAttemptInput): ReservationResult {
    this.ensureOpen();
    const normalized = normalizeReserve(input, this.config.costProfileVersion);
    return transaction(this.db, 'IMMEDIATE', () => {
      const state = readState(this.db, this.config);
      const previous = findAttempt(state.attempts, normalized.attemptId);
      if (previous) {
        const identical = previous.budgetId === state.meta.budgetId &&
          previous.costProfileVersion === state.meta.costProfileVersion &&
          previous.operation === normalized.operation &&
          previous.requestFingerprint === normalized.requestFingerprint &&
          previous.reservedCredits === normalized.reservedCredits;
        if (!identical) throw new CreditLedgerError('DUPLICATE_ATTEMPT_CONFLICT');
        return { attempt: previous, dispatchGranted: false };
      }
      if (state.meta.halted) throw new CreditLedgerError('ACCOUNTING_HALTED', haltDetails(state));

      const total = state.allocatedCredits + BigInt(normalized.reservedCredits);
      if (total > BigInt(state.meta.limitCredits)) throw new CreditLedgerError('BUDGET_EXHAUSTED');
      const createdAtMs = readClock(this.config.clock);
      const attempt = makePending(normalized, this.config, createdAtMs);
      this.db.prepare(
        'INSERT INTO attempts (attempt_id, budget_id, profile_version, operation, request_fingerprint, reserved_credits, charged_credits, outcome, http_status, provider_request_id, created_at_ms, completed_at_ms) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL)',
      ).run(
        attempt.attemptId, attempt.budgetId, attempt.costProfileVersion, attempt.operation,
        attempt.requestFingerprint, attempt.reservedCredits, createdAtMs,
      );
      const update = this.db.prepare(
        'UPDATE ledger_meta SET allocated_credits = ? WHERE singleton = 1 AND allocated_credits = ?',
      ).run(total.toString(), state.meta.allocatedCredits.toString());
      if (update.changes !== 1) throw new CreditLedgerError('DATABASE_CORRUPT');
      return { attempt, dispatchGranted: true };
    });
  }

  recordTerminalResult(input: RecordTerminalResultInput): AttemptRecord {
    this.ensureOpen();
    const normalized = normalizeTerminal(input);
    return transaction(this.db, 'IMMEDIATE', () => {
      const state = readState(this.db, this.config);
      const previous = findAttempt(state.attempts, normalized.attemptId);
      if (!previous) throw new CreditLedgerError('ATTEMPT_NOT_FOUND');
      if (previous.outcome !== 'PENDING') {
        const identical = previous.outcome === normalized.outcome &&
          previous.httpStatus === normalized.httpStatus &&
          previous.providerRequestId === normalized.providerRequestId &&
          previous.reportedChargedCredits === normalized.chargedCredits;
        if (!identical) throw new CreditLedgerError('COMPLETION_CONFLICT');
        return previous;
      }

      const completedAtMs = readClock(this.config.clock);
      if (completedAtMs < Date.parse(previous.createdAt)) throw new CreditLedgerError('INVALID_INPUT');
      const reserved = BigInt(previous.reservedCredits);
      const charged = normalized.chargedCredits === null ? 0n : BigInt(normalized.chargedCredits);
      const debit = reserved > charged ? reserved : charged;
      const nextAllocated = state.allocatedCredits + debit - reserved;

      this.db.prepare(
        'UPDATE attempts SET outcome = ?, http_status = ?, provider_request_id = ?, charged_credits = ?, completed_at_ms = ? WHERE attempt_id = ? AND outcome IS NULL',
      ).run(
        normalized.outcome, normalized.httpStatus, normalized.providerRequestId,
        normalized.chargedCredits, completedAtMs, normalized.attemptId,
      );
      const overrun = normalized.chargedCredits !== null &&
        normalized.chargedCredits > previous.reservedCredits;
      const halted = state.meta.halted || overrun;
      const reason = halted ? 'CHARGE_OVERRUN' : null;
      const update = this.db.prepare(
        'UPDATE ledger_meta SET allocated_credits = ?, halted = ?, halt_reason = ? WHERE singleton = 1 AND allocated_credits = ?',
      ).run(nextAllocated.toString(), halted ? 1 : 0, reason, state.meta.allocatedCredits.toString());
      if (update.changes !== 1) throw new CreditLedgerError('DATABASE_CORRUPT');
      const row = readAttemptRow(this.db, normalized.attemptId);
      if (!row) throw new CreditLedgerError('DATABASE_CORRUPT');
      return toAttempt(row);
    });
  }

  listUnknownChargeAttempts(): AttemptRecord[] {
    this.ensureOpen();
    return transaction(this.db, 'DEFERRED', () => {
      const state = readState(this.db, this.config);
      return state.attempts.filter((attempt) => attempt.outcome !== 'PENDING' && attempt.reportedChargedCredits === null);
    });
  }

  reconcileUnknownCharge(input: ReconcileUnknownChargeInput): AttemptRecord {
    this.ensureOpen();
    const normalized = normalizeUnknownChargeReconciliation(input);
    return transaction(this.db, 'IMMEDIATE', () => {
      const state = readState(this.db, this.config);
      const previous = findAttempt(state.attempts, normalized.attemptId);
      if (!previous) throw new CreditLedgerError('ATTEMPT_NOT_FOUND');
      if (previous.outcome === 'PENDING') throw new CreditLedgerError('RECONCILIATION_CONFLICT');
      if (previous.reportedChargedCredits !== null) {
        if (previous.reportedChargedCredits === normalized.chargedCredits) return previous;
        throw new CreditLedgerError('RECONCILIATION_CONFLICT');
      }
      const reserved = BigInt(previous.reservedCredits);
      const charged = BigInt(normalized.chargedCredits);
      const debit = reserved > charged ? reserved : charged;
      const nextAllocated = state.allocatedCredits + debit - reserved;
      const overrun = charged > reserved;
      const halted = state.meta.halted || overrun;
      const reason = halted ? 'CHARGE_OVERRUN' : null;
      const attemptUpdate = this.db.prepare(
        'UPDATE attempts SET charged_credits = ? WHERE attempt_id = ? AND charged_credits IS NULL AND outcome IS NOT NULL',
      ).run(normalized.chargedCredits, normalized.attemptId);
      if (attemptUpdate.changes !== 1) throw new CreditLedgerError('DATABASE_CORRUPT');
      const ledgerUpdate = this.db.prepare(
        'UPDATE ledger_meta SET allocated_credits = ?, halted = ?, halt_reason = ? WHERE singleton = 1 AND allocated_credits = ?',
      ).run(nextAllocated.toString(), halted ? 1 : 0, reason, state.meta.allocatedCredits.toString());
      if (ledgerUpdate.changes !== 1) throw new CreditLedgerError('DATABASE_CORRUPT');
      const row = readAttemptRow(this.db, normalized.attemptId);
      if (!row) throw new CreditLedgerError('DATABASE_CORRUPT');
      return toAttempt(row);
    });
  }

  getAttempt(attemptId: string): AttemptRecord | null {
    this.ensureOpen();
    assertIdentifier(attemptId);
    return transaction(this.db, 'DEFERRED', () => {
      const state = readState(this.db, this.config);
      return findAttempt(state.attempts, attemptId) ?? null;
    });
  }

  getSnapshot(): LedgerSnapshot {
    this.ensureOpen();
    const state = transaction(this.db, 'DEFERRED', () => readState(this.db, this.config));
    const overBudget = state.allocatedCredits > BigInt(state.meta.limitCredits)
      ? state.allocatedCredits - BigInt(state.meta.limitCredits)
      : 0n;
    const aggregateValues = [
      state.reservedEstimateCredits,
      state.allocatedCredits,
      state.remainingCredits,
      state.overrunCredits,
      overBudget,
      ...(state.reportedChargedCreditsTotal === null ? [] : [state.reportedChargedCreditsTotal]),
    ];
    if (aggregateValues.some((value) => value > MAX_SAFE_BIGINT)) {
      throw new CreditLedgerError('INTEGER_OVERFLOW', haltDetails(state));
    }
    return {
      budgetId: state.meta.budgetId,
      costProfileVersion: state.meta.costProfileVersion,
      limitCredits: state.meta.limitCredits,
      reservedEstimateCredits: Number(state.reservedEstimateCredits),
      allocatedCredits: Number(state.allocatedCredits),
      remainingCredits: Number(state.remainingCredits),
      overrunCredits: Number(state.overrunCredits),
      overBudgetCredits: Number(overBudget),
      reportedChargedCreditsTotal: state.reportedChargedCreditsTotal === null
        ? null
        : Number(state.reportedChargedCreditsTotal),
      reportedChargeCount: state.reportedChargeCount,
      pendingAttemptCount: state.pendingAttemptCount,
      reconciliationRequired: state.meta.halted || state.allocatedCredits > BigInt(state.meta.limitCredits),
      haltReason: state.meta.haltReason,
    };
  }

  close(): void {
    if (this.closed) return;
    try { this.db.close(); this.closed = true; }
    catch { throw new CreditLedgerError('DATABASE_FAILURE'); }
  }
  private ensureOpen(): void {
    if (this.closed) throw new CreditLedgerError('LEDGER_CLOSED');
  }
}

export function initializeCreditLedger(options: LedgerOptions): NansenCreditLedger {
  const config = normalizeOptions(options);
  let descriptor: number;
  try { descriptor = openSync(config.databasePath, 'wx', 0o600); }
  catch (error) {
    if (isRecord(error) && error.code === 'EEXIST') throw new CreditLedgerError('DATABASE_ALREADY_EXISTS');
    throw new CreditLedgerError('DATABASE_PATH_INVALID');
  }
  try { closeSync(descriptor); }
  catch { throw new CreditLedgerError('DATABASE_FAILURE'); }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(config.databasePath);
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = ' + SQLITE_BUSY_TIMEOUT_MS);
    db.exec('PRAGMA synchronous = FULL');
    enableWal(db);
    const createdAtMs = readClock(config.clock);
    transaction(db, 'IMMEDIATE', () => {
      db?.exec(META_SQL);
      db?.exec(ATTEMPTS_SQL);
      db?.exec('PRAGMA user_version = ' + LEDGER_SCHEMA_VERSION);
      db?.prepare(
        'INSERT INTO ledger_meta (singleton, schema_version, budget_id, limit_credits, profile_version, allocated_credits, halted, halt_reason, created_at_ms) VALUES (1, ?, ?, ?, ?, ?, 0, NULL, ?)',
      ).run(
        LEDGER_SCHEMA_VERSION, config.budgetId, config.limitCredits,
        config.costProfileVersion, '0', createdAtMs,
      );
    });
    configureConnection(db);
    verifyConfig(db, config);
    return new NansenCreditLedger(db, config);
  } catch (error) {
    try { db?.close(); } catch { /* Keep the explicit path so failed state cannot be reset. */ }
    if (error instanceof CreditLedgerError) throw error;
    throw new CreditLedgerError('DATABASE_FAILURE');
  }
}

export function openCreditLedger(options: LedgerOptions): NansenCreditLedger {
  const config = normalizeOptions(options);
  const db = openExistingFile(config.databasePath);
  try {
    migrateLedgerV2(db, config);
    verifyConfig(db, config);
    return new NansenCreditLedger(db, config);
  } catch (error) {
    try { db.close(); } catch { /* Fail closed and preserve the existing file. */ }
    if (error instanceof CreditLedgerError) throw error;
    throw new CreditLedgerError('DATABASE_CORRUPT');
  }
}

export { createNansenClient, NansenClientError, BASE_ASSET_ADDRESSES } from './client.js';
export type {
  NansenCallOptions, NansenClientErrorCode, NansenClientOptions, NansenHttpRequest,
  NansenHttpResponse, NansenHttpTransport, NansenRawResponseObservation, AdapterCompleteness, AdapterEvidenceDiagnostics, EvidenceFieldName, EvidenceFieldState, AdapterFailure, AdapterResult,
  BaseEvidenceAsset, FlowIntelligenceQuery, FlowIntelligenceRow, FlowIntelligenceTimeframe,
  NansenClient, PageReference, SmartMoneyNetflowQuery, SmartMoneyNetflowToken,
  TokenScreenerQuery, TokenScreenerTimeframe, TokenScreenerToken, TokenOhlcvAdapterResult, TokenOhlcvCandle, TokenOhlcvDateRange, TokenOhlcvQuery, TokenOhlcvTimeframe,
} from './client.js';
export * from './observation-store.js';
export * from './query-manager.js';
export * from './collector.js';

export * from './typesafe-shadow-contracts.js';
export * from './typesafe-shadow-store.js';
export * from './typesafe-shadow.js';

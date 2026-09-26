import { closeSync, lstatSync, openSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  G1D_MODEL_ALIAS,
  type G1DAuditStatus,
  type G1DShadowAuditRecord,
  type G1DShadowErrorCode,
  type G1DTypeSafeRequest,
  type G1DUsage,
} from './typesafe-shadow-contracts.js';

export const G1D_SHADOW_STORE_SCHEMA_VERSION = 1 as const;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ROUTES = ['STORE', 'WATCH', 'ASTRA_REVIEW'] as const;
const STATUSES = ['PENDING', 'OBSERVED', 'UNAVAILABLE', 'INVALID_RESPONSE'] as const;
const ERRORS: readonly G1DShadowErrorCode[] = [
  'INVALID_INPUT', 'INVALID_CONFIGURATION', 'MISSING_CREDENTIAL', 'LOCAL_AUDIT_FAILURE',
  'HTTP_ERROR', 'TIMEOUT', 'TRANSPORT_ERROR', 'RESPONSE_TOO_LARGE', 'INVALID_RESPONSE', 'AUDIT_COMPLETION_FAILED', 'AMBIGUOUS_ATTEMPT', 'PRIOR_ATTEMPT_EXISTS',
];
const MAX_REQUEST_BYTES = 24 * 1024;
const MAX_MODEL_LENGTH = 80;

const META_SQL = [
  'CREATE TABLE shadow_meta (',
  'singleton INTEGER PRIMARY KEY CHECK (singleton = 1),',
  "schema_version INTEGER NOT NULL CHECK (typeof(schema_version) = 'integer' AND schema_version > 0),",
  'store_id TEXT NOT NULL UNIQUE CHECK (length(store_id) BETWEEN 1 AND 128),',
  'created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40)',
  ') STRICT',
].join('\n');
const ATTEMPTS_SQL = [
  'CREATE TABLE shadow_attempts (',
  'attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id) = 36),',
  "request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),",
  "question_set_hash TEXT NOT NULL CHECK (length(question_set_hash) = 64 AND question_set_hash NOT GLOB '*[^0-9a-f]*'),",
  'created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),',
  'completed_at TEXT CHECK (completed_at IS NULL OR length(completed_at) BETWEEN 20 AND 40),',
  "status TEXT NOT NULL CHECK (status IN ('PENDING', 'OBSERVED', 'UNAVAILABLE', 'INVALID_RESPONSE')),",
  "requested_model TEXT NOT NULL CHECK (requested_model = 'jev-latest'),",
  'request_json TEXT NOT NULL CHECK (length(request_json) BETWEEN 1 AND 24576),',
  'resolved_model TEXT CHECK (resolved_model IS NULL OR length(resolved_model) BETWEEN 1 AND 80),',
  'answer_value REAL CHECK (answer_value IS NULL OR (answer_value >= 0 AND answer_value <= 1)),',
  "usage_input_tokens INTEGER CHECK (usage_input_tokens IS NULL OR (typeof(usage_input_tokens) = 'integer' AND usage_input_tokens >= 0)),",
  "usage_output_tokens INTEGER CHECK (usage_output_tokens IS NULL OR (typeof(usage_output_tokens) = 'integer' AND usage_output_tokens >= 0)),",
  "latency_ms INTEGER CHECK (latency_ms IS NULL OR (typeof(latency_ms) = 'integer' AND latency_ms >= 0)),",
  "http_status INTEGER CHECK (http_status IS NULL OR (typeof(http_status) = 'integer' AND http_status BETWEEN 100 AND 599)),",
  'error_code TEXT CHECK (error_code IS NULL OR error_code IN (' + ERRORS.map((code) => "'" + code + "'").join(', ') + ')),',
  "advisory_route TEXT NOT NULL CHECK (advisory_route IN ('STORE', 'WATCH', 'ASTRA_REVIEW')),",
  'requests_made INTEGER CHECK (requests_made IS NULL OR requests_made IN (0, 1)),',
  "CHECK ((status = 'PENDING' AND completed_at IS NULL AND requests_made IS NULL) OR (status != 'PENDING' AND completed_at IS NOT NULL AND requests_made = 1))",
  ') STRICT',
].join('\n');

export type G1DPendingAuditInput = Pick<
  G1DShadowAuditRecord,
  'attemptId' | 'requestHash' | 'questionSetHash' | 'createdAt' | 'requestedModel' | 'request'
>;
export type G1DCompletionAuditInput = Pick<
  G1DShadowAuditRecord,
  'status' | 'resolvedModel' | 'answer' | 'usage' | 'latencyMs' | 'httpStatus' | 'errorCode' | 'advisoryRoute'
> & { readonly status: Exclude<G1DAuditStatus, 'PENDING'> };

export class G1DShadowStoreError extends Error {
  readonly code: 'INVALID_INPUT' | 'DATABASE_PATH_INVALID' | 'DATABASE_ALREADY_EXISTS' | 'DATABASE_NOT_FOUND' |
    'DATABASE_CORRUPT' | 'UNSUPPORTED_SCHEMA_VERSION' | 'CONFIGURATION_MISMATCH' | 'DATABASE_FAILURE' | 'STORE_CLOSED' | 'DUPLICATE_REQUEST';
  constructor(code: G1DShadowStoreError['code']) {
    super('TypeSafe shadow audit store operation failed: ' + code + '.');
    this.name = 'G1DShadowStoreError';
    this.code = code;
  }
}
export interface G1DShadowStoreOptions {
  readonly databasePath: string;
  readonly storeId: string;
  readonly clock?: () => Date;
}
export interface G1DShadowAuditStore {
  recordPending(input: G1DPendingAuditInput): G1DShadowAuditRecord;
  recordCompletion(attemptId: string, input: G1DCompletionAuditInput): G1DShadowAuditRecord;
  getAttempt(attemptId: string): G1DShadowAuditRecord | null;
  getByRequestHash(requestHash: string): G1DShadowAuditRecord | null;
  listPending(): readonly G1DShadowAuditRecord[];
  listRecent(limit?: number): readonly G1DShadowAuditRecord[];
  close(): void;
}
interface StoreConfig { databasePath: string; storeId: string; clock: () => Date; }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}
function insideRepository(path: string): boolean {
  const relativePath = relative(REPOSITORY_ROOT, resolve(path));
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith('..' + sep) && !isAbsolute(relativePath));
}
function parseTime(value: unknown): string {
  if (typeof value !== 'string') throw new G1DShadowStoreError('INVALID_INPUT');
  const ms = Date.parse(value);
  if (!Number.isSafeInteger(ms) || ms < 0) throw new G1DShadowStoreError('INVALID_INPUT');
  return new Date(ms).toISOString();
}
function normalizeOptions(value: unknown): StoreConfig {
  if (!isRecord(value) || !exactKeys(value, ['databasePath', 'storeId', 'clock'])) throw new G1DShadowStoreError('INVALID_INPUT');
  if (typeof value.databasePath !== 'string' || !isAbsolute(value.databasePath) ||
      value.databasePath.includes(String.fromCharCode(0)) || insideRepository(value.databasePath)) {
    throw new G1DShadowStoreError('DATABASE_PATH_INVALID');
  }
  if (typeof value.storeId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.storeId)) throw new G1DShadowStoreError('INVALID_INPUT');
  const clock = value.clock ?? (() => new Date());
  if (typeof clock !== 'function') throw new G1DShadowStoreError('INVALID_INPUT');
  return { databasePath: value.databasePath, storeId: value.storeId, clock: clock as () => Date };
}
function assertPathFile(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new G1DShadowStoreError('DATABASE_PATH_INVALID');
  } catch (error) {
    if (error instanceof G1DShadowStoreError) throw error;
    if (isRecord(error) && error.code === 'ENOENT') throw new G1DShadowStoreError('DATABASE_NOT_FOUND');
    throw new G1DShadowStoreError('DATABASE_PATH_INVALID');
  }
}
function enableWal(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA journal_mode = WAL').get() as Record<string, unknown> | undefined;
  if (row?.journal_mode !== 'wal') throw new G1DShadowStoreError('DATABASE_FAILURE');
}
function transaction<T>(db: DatabaseSync, callback: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const value = callback(); db.exec('COMMIT'); return value; }
  catch (error) { try { db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ } throw error; }
}
function validateRequest(value: unknown): { request: G1DTypeSafeRequest; json: string } {
  if (!isRecord(value) || !exactKeys(value, ['state', 'model', 'questions']) ||
      value.model !== G1D_MODEL_ALIAS || !isRecord(value.state) || !isRecord(value.questions)) {
    throw new G1DShadowStoreError('INVALID_INPUT');
  }
  const json = JSON.stringify(value);
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_REQUEST_BYTES) throw new G1DShadowStoreError('INVALID_INPUT');
  return { request: value as unknown as G1DTypeSafeRequest, json };
}
function validatePending(value: unknown): G1DPendingAuditInput & { requestJson: string; createdAt: string } {
  if (!isRecord(value) || !exactKeys(value, ['attemptId', 'requestHash', 'questionSetHash', 'createdAt', 'requestedModel', 'request']) ||
      typeof value.attemptId !== 'string' || !UUID.test(value.attemptId) ||
      typeof value.requestHash !== 'string' || !HASH.test(value.requestHash) ||
      typeof value.questionSetHash !== 'string' || !HASH.test(value.questionSetHash) ||
      value.requestedModel !== G1D_MODEL_ALIAS) throw new G1DShadowStoreError('INVALID_INPUT');
  const request = validateRequest(value.request);
  return {
    attemptId: value.attemptId,
    requestHash: value.requestHash,
    questionSetHash: value.questionSetHash,
    createdAt: parseTime(value.createdAt),
    requestedModel: G1D_MODEL_ALIAS,
    request: request.request,
    requestJson: request.json,
  };
}
function validateCompletion(value: unknown): G1DCompletionAuditInput {
  if (!isRecord(value) || !exactKeys(value, ['status', 'resolvedModel', 'answer', 'usage', 'latencyMs', 'httpStatus', 'errorCode', 'advisoryRoute']) ||
      !(STATUSES as readonly string[]).includes(String(value.status)) || value.status === 'PENDING' ||
      !(ROUTES as readonly string[]).includes(String(value.advisoryRoute))) throw new G1DShadowStoreError('INVALID_INPUT');
  if (value.answer !== null && (!isRecord(value.answer) || !exactKeys(value.answer, ['type', 'noul']) ||
      value.answer.type !== 'noul' || typeof value.answer.noul !== 'number' ||
      !Number.isFinite(value.answer.noul) || value.answer.noul < 0 || value.answer.noul > 1)) {
    throw new G1DShadowStoreError('INVALID_INPUT');
  }
  if (value.usage !== null && (!isRecord(value.usage) || !exactKeys(value.usage, ['input_tokens', 'output_tokens']) ||
      !Number.isSafeInteger(value.usage.input_tokens) || Number(value.usage.input_tokens) < 0 ||
      !Number.isSafeInteger(value.usage.output_tokens) || Number(value.usage.output_tokens) < 0)) {
    throw new G1DShadowStoreError('INVALID_INPUT');
  }
  if (value.resolvedModel !== null && (typeof value.resolvedModel !== 'string' || value.resolvedModel.length < 1 ||
      value.resolvedModel.length > MAX_MODEL_LENGTH || !/^jev-(?:latest|[0-9]+\.[0-9]+\.[0-9]+)$/u.test(value.resolvedModel))) {
    throw new G1DShadowStoreError('INVALID_INPUT');
  }
  if (value.latencyMs !== null && (!Number.isSafeInteger(value.latencyMs) || Number(value.latencyMs) < 0)) throw new G1DShadowStoreError('INVALID_INPUT');
  if (value.httpStatus !== null && (!Number.isSafeInteger(value.httpStatus) || Number(value.httpStatus) < 100 || Number(value.httpStatus) > 599)) throw new G1DShadowStoreError('INVALID_INPUT');
  if (value.errorCode !== null && !(ERRORS as readonly string[]).includes(String(value.errorCode))) throw new G1DShadowStoreError('INVALID_INPUT');
  return value as unknown as G1DCompletionAuditInput;
}
function decodeRow(row: Record<string, unknown>): G1DShadowAuditRecord {
  let request: unknown;
  try { request = JSON.parse(String(row.request_json)) as unknown; }
  catch { throw new G1DShadowStoreError('DATABASE_CORRUPT'); }
  const usage = row.usage_input_tokens === null || row.usage_output_tokens === null
    ? null
    : { input_tokens: Number(row.usage_input_tokens), output_tokens: Number(row.usage_output_tokens) } satisfies G1DUsage;
  const answer = row.answer_value === null ? null : { type: 'noul' as const, noul: Number(row.answer_value) };
  return {
    attemptId: String(row.attempt_id),
    requestHash: String(row.request_hash),
    questionSetHash: String(row.question_set_hash),
    createdAt: String(row.created_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    status: String(row.status) as G1DAuditStatus,
    requestedModel: G1D_MODEL_ALIAS,
    request: request as G1DTypeSafeRequest,
    resolvedModel: row.resolved_model === null ? null : String(row.resolved_model),
    answer,
    usage,
    latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
    httpStatus: row.http_status === null ? null : Number(row.http_status),
    errorCode: row.error_code === null ? null : String(row.error_code) as G1DShadowErrorCode,
    advisoryRoute: String(row.advisory_route) as G1DShadowAuditRecord['advisoryRoute'],
    requestsMade: row.requests_made === null ? null : Number(row.requests_made) as 0 | 1,
  };
}
function verifyDatabase(db: DatabaseSync, config: StoreConfig): void {
  const version = db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined;
  if (Number(version?.user_version) !== G1D_SHADOW_STORE_SCHEMA_VERSION) throw new G1DShadowStoreError('UNSUPPORTED_SCHEMA_VERSION');
  const row = db.prepare('SELECT schema_version, store_id FROM shadow_meta WHERE singleton = 1').get() as Record<string, unknown> | undefined;
  if (row === undefined || Number(row.schema_version) !== G1D_SHADOW_STORE_SCHEMA_VERSION) throw new G1DShadowStoreError('DATABASE_CORRUPT');
  if (row.store_id !== config.storeId) throw new G1DShadowStoreError('CONFIGURATION_MISMATCH');
  const check = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
  if (check?.quick_check !== 'ok') throw new G1DShadowStoreError('DATABASE_CORRUPT');
}
function openExisting(path: string): DatabaseSync {
  assertPathFile(path);
  try { return new DatabaseSync(path); }
  catch { throw new G1DShadowStoreError('DATABASE_CORRUPT'); }
}

class SqliteG1DShadowAuditStore implements G1DShadowAuditStore {
  private closed = false;
  constructor(private readonly db: DatabaseSync, private readonly config: StoreConfig) {}

  recordPending(input: G1DPendingAuditInput): G1DShadowAuditRecord {
    this.ensureOpen();
    try {
      const pending = validatePending(input);
      transaction(this.db, () => {
        const prior = this.db.prepare('SELECT attempt_id FROM shadow_attempts WHERE request_hash = ? LIMIT 1').get(pending.requestHash);
        if (prior !== undefined) throw new G1DShadowStoreError('DUPLICATE_REQUEST');
        this.db.prepare(
          'INSERT INTO shadow_attempts (attempt_id, request_hash, question_set_hash, created_at, completed_at, status, requested_model, request_json, resolved_model, answer_value, usage_input_tokens, usage_output_tokens, latency_ms, http_status, error_code, advisory_route, requests_made) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL)',
        ).run(pending.attemptId, pending.requestHash, pending.questionSetHash, pending.createdAt, 'PENDING', pending.requestedModel, pending.requestJson, 'STORE');
      });
      const record = this.getAttempt(pending.attemptId);
      if (record === null) throw new G1DShadowStoreError('DATABASE_FAILURE');
      return record;
    } catch (error) { if (error instanceof G1DShadowStoreError) throw error; throw new G1DShadowStoreError('DATABASE_FAILURE'); }
  }

  recordCompletion(attemptId: string, input: G1DCompletionAuditInput): G1DShadowAuditRecord {
    this.ensureOpen();
    if (typeof attemptId !== 'string' || !UUID.test(attemptId)) throw new G1DShadowStoreError('INVALID_INPUT');
    try {
      const completion = validateCompletion(input);
      const completedAt = parseTime(this.config.clock().toISOString());
      const result = this.db.prepare(
        "UPDATE shadow_attempts SET completed_at = ?, status = ?, resolved_model = ?, answer_value = ?, usage_input_tokens = ?, usage_output_tokens = ?, latency_ms = ?, http_status = ?, error_code = ?, advisory_route = ?, requests_made = 1 WHERE attempt_id = ? AND status = 'PENDING'",
      ).run(
        completedAt, completion.status, completion.resolvedModel, completion.answer?.noul ?? null,
        completion.usage?.input_tokens ?? null, completion.usage?.output_tokens ?? null,
        completion.latencyMs, completion.httpStatus, completion.errorCode, completion.advisoryRoute, attemptId,
      );
      if (Number(result.changes) !== 1) throw new G1DShadowStoreError('DATABASE_FAILURE');
      const record = this.getAttempt(attemptId);
      if (record === null) throw new G1DShadowStoreError('DATABASE_FAILURE');
      return record;
    } catch (error) { if (error instanceof G1DShadowStoreError) throw error; throw new G1DShadowStoreError('DATABASE_FAILURE'); }
  }

  getAttempt(attemptId: string): G1DShadowAuditRecord | null {
    this.ensureOpen();
    if (typeof attemptId !== 'string' || !UUID.test(attemptId)) throw new G1DShadowStoreError('INVALID_INPUT');
    try {
      const row = this.db.prepare('SELECT * FROM shadow_attempts WHERE attempt_id = ?').get(attemptId) as Record<string, unknown> | undefined;
      return row === undefined ? null : decodeRow(row);
    } catch (error) { if (error instanceof G1DShadowStoreError) throw error; throw new G1DShadowStoreError('DATABASE_FAILURE'); }
  }

  getByRequestHash(requestHash: string): G1DShadowAuditRecord | null {
    this.ensureOpen();
    if (typeof requestHash !== 'string' || !HASH.test(requestHash)) throw new G1DShadowStoreError('INVALID_INPUT');
    try {
      const row = this.db.prepare('SELECT * FROM shadow_attempts WHERE request_hash = ? ORDER BY created_at DESC, attempt_id DESC LIMIT 1').get(requestHash) as Record<string, unknown> | undefined;
      return row === undefined ? null : decodeRow(row);
    } catch (error) { if (error instanceof G1DShadowStoreError) throw error; throw new G1DShadowStoreError('DATABASE_FAILURE'); }
  }

  listPending(): readonly G1DShadowAuditRecord[] {
    this.ensureOpen();
    try {
      const rows = this.db.prepare("SELECT * FROM shadow_attempts WHERE status = 'PENDING' ORDER BY created_at, attempt_id").all() as Record<string, unknown>[];
      return Object.freeze(rows.map(decodeRow));
    } catch (error) { if (error instanceof G1DShadowStoreError) throw error; throw new G1DShadowStoreError('DATABASE_FAILURE'); }
  }

  listRecent(limit = 50): readonly G1DShadowAuditRecord[] {
    this.ensureOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new G1DShadowStoreError('INVALID_INPUT');
    try {
      const rows = this.db.prepare('SELECT * FROM shadow_attempts ORDER BY created_at DESC, attempt_id DESC LIMIT ?').all(limit) as Record<string, unknown>[];
      return Object.freeze(rows.map(decodeRow));
    } catch (error) { if (error instanceof G1DShadowStoreError) throw error; throw new G1DShadowStoreError('DATABASE_FAILURE'); }
  }
  close(): void {
    if (this.closed) return;
    try { this.db.close(); this.closed = true; }
    catch { throw new G1DShadowStoreError('DATABASE_FAILURE'); }
  }
  private ensureOpen(): void { if (this.closed) throw new G1DShadowStoreError('STORE_CLOSED'); }
}

export function initializeG1DShadowAuditStore(options: G1DShadowStoreOptions): G1DShadowAuditStore {
  const config = normalizeOptions(options);
  let descriptor: number;
  try { descriptor = openSync(config.databasePath, 'wx', 0o600); }
  catch (error) {
    if (isRecord(error) && error.code === 'EEXIST') throw new G1DShadowStoreError('DATABASE_ALREADY_EXISTS');
    throw new G1DShadowStoreError('DATABASE_PATH_INVALID');
  }
  closeSync(descriptor);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(config.databasePath);
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = FULL');
    enableWal(db);
    const createdAt = parseTime(config.clock().toISOString());
    db.exec('BEGIN IMMEDIATE');
    db.exec(META_SQL);
    db.exec(ATTEMPTS_SQL);
    db.prepare('INSERT INTO shadow_meta (singleton, schema_version, store_id, created_at) VALUES (1, ?, ?, ?)')
      .run(G1D_SHADOW_STORE_SCHEMA_VERSION, config.storeId, createdAt);
    db.exec('PRAGMA user_version = ' + G1D_SHADOW_STORE_SCHEMA_VERSION);
    db.exec('COMMIT');
    verifyDatabase(db, config);
    return new SqliteG1DShadowAuditStore(db, config);
  } catch (error) {
    try { db?.exec('ROLLBACK'); } catch { /* Preserve the initialized file for operator inspection. */ }
    try { db?.close(); } catch { /* Preserve the initialized file for operator inspection. */ }
    if (error instanceof G1DShadowStoreError) throw error;
    throw new G1DShadowStoreError('DATABASE_FAILURE');
  }
}

export function openG1DShadowAuditStore(options: G1DShadowStoreOptions): G1DShadowAuditStore {
  const config = normalizeOptions(options);
  const db = openExisting(config.databasePath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = FULL');
    verifyDatabase(db, config);
    return new SqliteG1DShadowAuditStore(db, config);
  } catch (error) {
    try { db.close(); } catch { /* Fail closed and preserve the database. */ }
    if (error instanceof G1DShadowStoreError) throw error;
    throw new G1DShadowStoreError('DATABASE_CORRUPT');
  }
}

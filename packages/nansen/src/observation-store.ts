import { closeSync, lstatSync, openSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { normalizedSignalSchema, type NormalizedSignal } from '@ered-luin/contracts';
import type { AdapterCompleteness, AdapterFailure, PageReference } from './client.js';
import type { NansenOperation } from './index.js';

export const OBSERVATION_STORE_SCHEMA_VERSION = 2 as const;
export const DEFAULT_OBSERVATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEFAULT_MAX_OBSERVATION_ROWS = 100_000;
export const DEFAULT_MAX_CACHE_ENTRIES = 512;
export const MAX_OBSERVATION_HISTORY_QUERY_LIMIT = 1_024;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MAX_SIGNALS_PER_SNAPSHOT = 5_000;
const MAX_SNAPSHOT_ROWS = 10_000;
const MAX_PAGE_REFERENCES = 60;
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const ENDPOINTS = ['TOKEN_SCREENER', 'FLOW_INTELLIGENCE', 'SMART_MONEY_NETFLOW', 'TOKEN_OHLCV'] as const;
const COMPLETENESS = ['complete', 'incomplete', 'unknown'] as const;
const FAILURE_CODES = [
  'DISABLED', 'CREDENTIAL_MISSING', 'INVALID_CONFIGURATION', 'INVALID_REQUEST', 'RESERVATION_DENIED',
  'DUPLICATE_ATTEMPT', 'TRANSPORT_ERROR', 'TIMEOUT', 'CANCELLED', 'RESPONSE_TOO_LARGE',
  'INVALID_RESPONSE', 'HTTP_ERROR', 'LEDGER_RECORD_FAILED',
] as const;
const LEDGER_CODES = [
  'INVALID_INPUT', 'DATABASE_PATH_INVALID', 'DATABASE_ALREADY_EXISTS', 'DATABASE_NOT_FOUND',
  'DATABASE_CORRUPT', 'UNSUPPORTED_SCHEMA_VERSION', 'UNKNOWN_COST_PROFILE', 'UNKNOWN_OPERATION',
  'CONFIGURATION_MISMATCH', 'BUDGET_EXHAUSTED', 'DUPLICATE_ATTEMPT_CONFLICT', 'ATTEMPT_NOT_FOUND',
  'COMPLETION_CONFLICT', 'ACCOUNTING_HALTED', 'INTEGER_OVERFLOW', 'DATABASE_FAILURE', 'LEDGER_CLOSED',
] as const;

export type ObservationStoreErrorCode =
  | 'INVALID_INPUT' | 'DATABASE_PATH_INVALID' | 'DATABASE_ALREADY_EXISTS' | 'DATABASE_NOT_FOUND'
  | 'DATABASE_CORRUPT' | 'UNSUPPORTED_SCHEMA_VERSION' | 'CONFIGURATION_MISMATCH'
  | 'DATABASE_FAILURE' | 'STORE_CLOSED' | 'CAPACITY_EXCEEDED';
const STORE_MESSAGES: Record<ObservationStoreErrorCode, string> = {
  INVALID_INPUT: 'Observation store input is invalid.',
  DATABASE_PATH_INVALID: 'Observation store path must be absolute and identify a regular file.',
  DATABASE_ALREADY_EXISTS: 'Observation store path already exists; initialization never overwrites it.',
  DATABASE_NOT_FOUND: 'Existing observation store was not found.',
  DATABASE_CORRUPT: 'Observation store is corrupt or inconsistent; state is preserved.',
  UNSUPPORTED_SCHEMA_VERSION: 'Observation store schema version is unsupported.',
  CONFIGURATION_MISMATCH: 'Observation store identity or immutable limits do not match.',
  DATABASE_FAILURE: 'Observation store operation failed; state is preserved.',
  STORE_CLOSED: 'Observation store connection is closed.',
  CAPACITY_EXCEEDED: 'Observation store capacity cannot retain the new snapshot.',
};
export class ObservationStoreError extends Error {
  readonly code: ObservationStoreErrorCode;
  constructor(code: ObservationStoreErrorCode) { super(STORE_MESSAGES[code]); this.name = 'ObservationStoreError'; this.code = code; }
}

export interface ObservationStoreOptions {
  readonly databasePath: string;
  readonly storeId: string;
  readonly maxObservationRows?: number;
  readonly maxCacheEntries?: number;
  readonly retentionMs?: number;
  readonly clock?: () => Date;
}
interface StoreConfig {
  readonly databasePath: string; readonly storeId: string; readonly maxObservationRows: number;
  readonly maxCacheEntries: number; readonly retentionMs: number; readonly clock: () => Date;
}
export interface StoredPageReference extends PageReference { readonly retry: number; }
export interface ObservationSnapshotInput {
  readonly snapshotId?: string; readonly cacheKey: string; readonly operation: NansenOperation;
  readonly asset: 'BASE_PAIR' | 'USDC' | 'WETH'; readonly timeframe: '1h' | '1m'; readonly pageBound: number;
  readonly retryBound: number; readonly source: 'nansen' | 'synthetic'; readonly fetchedAt: string;
  readonly acquiredAt: string; readonly expiresAt: string; readonly completeness: AdapterCompleteness;
  readonly failure: AdapterFailure | null; readonly pageReferences: readonly StoredPageReference[];
  readonly unavailableFields: readonly string[]; readonly signals: readonly NormalizedSignal[];
}
export interface ObservationStoreWriteOptions { readonly cache?: boolean; }
export interface ObservationSnapshot extends ObservationSnapshotInput { readonly snapshotId: string; }
export interface ObservationHistoryQuery { readonly cacheKey: string; readonly limit?: number; }
type SqlRow = Record<string, unknown>;

const META_SQL = `CREATE TABLE store_meta (
 singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
 schema_version INTEGER NOT NULL CHECK (typeof(schema_version) = 'integer' AND schema_version > 0),
 store_id TEXT NOT NULL UNIQUE CHECK (length(store_id) BETWEEN 1 AND 128),
 max_observation_rows INTEGER NOT NULL CHECK (typeof(max_observation_rows) = 'integer' AND max_observation_rows > 0),
 max_cache_entries INTEGER NOT NULL CHECK (typeof(max_cache_entries) = 'integer' AND max_cache_entries > 0),
 retention_ms INTEGER NOT NULL CHECK (typeof(retention_ms) = 'integer' AND retention_ms > 0)
) STRICT`;
const SNAPSHOTS_SQL = `CREATE TABLE snapshots (
 snapshot_id TEXT PRIMARY KEY CHECK (length(snapshot_id) = 36),
 cache_key TEXT NOT NULL CHECK (length(cache_key) = 64 AND cache_key NOT GLOB '*[^0-9a-f]*'),
 operation TEXT NOT NULL CHECK (operation IN ('TOKEN_SCREENER', 'FLOW_INTELLIGENCE', 'SMART_MONEY_NETFLOW', 'TOKEN_OHLCV')),
 asset TEXT NOT NULL CHECK (asset IN ('BASE_PAIR', 'USDC', 'WETH')),
 timeframe TEXT NOT NULL CHECK (((operation = 'TOKEN_OHLCV' AND asset = 'USDC' AND timeframe = '1m') OR (operation <> 'TOKEN_OHLCV' AND timeframe = '1h'))),
 page_bound INTEGER NOT NULL CHECK (typeof(page_bound) = 'integer' AND page_bound BETWEEN 1 AND 20),
 retry_bound INTEGER NOT NULL CHECK (typeof(retry_bound) = 'integer' AND retry_bound BETWEEN 0 AND 2),
 source TEXT NOT NULL CHECK (source IN ('nansen', 'synthetic')),
 fetched_at TEXT NOT NULL CHECK (length(fetched_at) BETWEEN 20 AND 40),
 acquired_at TEXT NOT NULL CHECK (length(acquired_at) BETWEEN 20 AND 40),
 fetched_at_ms INTEGER NOT NULL CHECK (typeof(fetched_at_ms) = 'integer' AND fetched_at_ms >= 0),
 acquired_at_ms INTEGER NOT NULL CHECK (typeof(acquired_at_ms) = 'integer' AND acquired_at_ms >= fetched_at_ms),
 expires_at TEXT NOT NULL CHECK (length(expires_at) BETWEEN 20 AND 40),
 expires_at_ms INTEGER NOT NULL CHECK (typeof(expires_at_ms) = 'integer' AND expires_at_ms >= acquired_at_ms),
 completeness TEXT NOT NULL CHECK (completeness IN ('complete', 'incomplete', 'unknown')),
 failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 40),
 failure_status INTEGER CHECK (failure_status IS NULL OR (typeof(failure_status) = 'integer' AND failure_status BETWEEN 100 AND 599)),
 failure_ledger_code TEXT CHECK (failure_ledger_code IS NULL OR length(failure_ledger_code) BETWEEN 1 AND 40),
 page_references_json TEXT NOT NULL CHECK (length(page_references_json) <= 32768),
 unavailable_fields_json TEXT NOT NULL CHECK (length(unavailable_fields_json) <= 8192),
 observation_count INTEGER NOT NULL CHECK (typeof(observation_count) = 'integer' AND observation_count BETWEEN 0 AND 5000)
) STRICT`;const OBSERVATIONS_SQL = `CREATE TABLE observations (
 signal_id TEXT PRIMARY KEY CHECK (length(signal_id) = 36),
 snapshot_id TEXT NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
 provider TEXT NOT NULL CHECK (provider IN ('nansen', 'synthetic')),
 endpoint TEXT NOT NULL CHECK (endpoint IN ('TOKEN_SCREENER', 'FLOW_INTELLIGENCE', 'SMART_MONEY_NETFLOW', 'TOKEN_OHLCV')),
 chain_id INTEGER NOT NULL CHECK (chain_id = 8453),
 asset TEXT NOT NULL CHECK (asset IN ('USDC', 'WETH')),
 metric TEXT NOT NULL CHECK (length(metric) BETWEEN 1 AND 80),
 observed_at TEXT NOT NULL CHECK (length(observed_at) BETWEEN 20 AND 40),
 fetched_at TEXT NOT NULL CHECK (length(fetched_at) BETWEEN 20 AND 40),
 quality TEXT NOT NULL CHECK (quality IN ('COMPLETE', 'PARTIAL', 'MISSING')),
 value TEXT CHECK (value IS NULL OR length(value) <= 256),
 unit TEXT NOT NULL CHECK (unit IN ('usd_micros', 'count')),
 provenance_id TEXT NOT NULL CHECK (length(provenance_id) BETWEEN 1 AND 160)
) STRICT`;
const CACHE_SQL = `CREATE TABLE cache_entries (
 cache_key TEXT PRIMARY KEY CHECK (length(cache_key) = 64 AND cache_key NOT GLOB '*[^0-9a-f]*'),
 snapshot_id TEXT NOT NULL UNIQUE REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
 cached_at_ms INTEGER NOT NULL CHECK (typeof(cached_at_ms) = 'integer' AND cached_at_ms >= 0),
 expires_at_ms INTEGER NOT NULL CHECK (typeof(expires_at_ms) = 'integer' AND expires_at_ms >= cached_at_ms)
) STRICT`;
const TABLES: Record<string, { sql: string; columns: readonly string[] }> = {
  cache_entries: { sql: CACHE_SQL, columns: ['cache_key', 'snapshot_id', 'cached_at_ms', 'expires_at_ms'] },
  observations: { sql: OBSERVATIONS_SQL, columns: [
    'signal_id', 'snapshot_id', 'provider', 'endpoint', 'chain_id', 'asset', 'metric', 'observed_at', 'fetched_at',
    'quality', 'value', 'unit', 'provenance_id',
  ] },
  snapshots: { sql: SNAPSHOTS_SQL, columns: [
    'snapshot_id', 'cache_key', 'operation', 'asset', 'timeframe', 'page_bound', 'retry_bound', 'source',
    'fetched_at', 'acquired_at', 'fetched_at_ms', 'acquired_at_ms', 'expires_at', 'expires_at_ms', 'completeness',
    'failure_code', 'failure_status', 'failure_ledger_code', 'page_references_json', 'unavailable_fields_json', 'observation_count',
  ] },
  store_meta: { sql: META_SQL, columns: ['singleton', 'schema_version', 'store_id', 'max_observation_rows', 'max_cache_entries', 'retention_ms'] },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function safeDate(value: unknown): { iso: string; ms: number } {
  if (typeof value !== 'string') throw new ObservationStoreError('INVALID_INPUT');
  const ms = Date.parse(value);
  if (!Number.isSafeInteger(ms) || ms < 0) throw new ObservationStoreError('INVALID_INPUT');
  return { iso: new Date(ms).toISOString(), ms };
}
function isInsideRepository(path: string): boolean {
  const relativePath = relative(REPOSITORY_ROOT, resolve(path));
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith('..' + sep) && !isAbsolute(relativePath));
}
function validateConfig(value: unknown): StoreConfig {
  if (!isRecord(value) || !exactKeys(value, ['databasePath', 'storeId', 'maxObservationRows', 'maxCacheEntries', 'retentionMs', 'clock'])) {
    throw new ObservationStoreError('INVALID_INPUT');
  }
  if (typeof value.databasePath !== 'string' || !isAbsolute(value.databasePath) || value.databasePath.includes(String.fromCharCode(0)) || isInsideRepository(value.databasePath)) {
    throw new ObservationStoreError('DATABASE_PATH_INVALID');
  }
  if (typeof value.storeId !== 'string' || !IDENTIFIER.test(value.storeId)) throw new ObservationStoreError('INVALID_INPUT');
  const maxObservationRows = value.maxObservationRows ?? 100_000;
  const maxCacheEntries = value.maxCacheEntries ?? 512;
  const retentionMs = value.retentionMs ?? 7 * 24 * 60 * 60 * 1_000;
  if (typeof maxObservationRows !== 'number' || !Number.isSafeInteger(maxObservationRows) || maxObservationRows <= 0 ||
      typeof maxCacheEntries !== 'number' || !Number.isSafeInteger(maxCacheEntries) || maxCacheEntries <= 0 ||
      typeof retentionMs !== 'number' || !Number.isSafeInteger(retentionMs) || retentionMs <= 0) throw new ObservationStoreError('INVALID_INPUT');
  if (maxObservationRows > 1_000_000 || maxCacheEntries > 10_000 || maxCacheEntries > maxObservationRows || retentionMs > 365 * 24 * 60 * 60 * 1_000) {
    throw new ObservationStoreError('INVALID_INPUT');
  }
  const clock = value.clock ?? (() => new Date());
  if (typeof clock !== 'function') throw new ObservationStoreError('INVALID_INPUT');
  return { databasePath: value.databasePath, storeId: value.storeId, maxObservationRows, maxCacheEntries, retentionMs, clock: clock as () => Date };
}
function clockMs(clock: () => Date): number {
  let date: Date;
  try { date = clock(); } catch { throw new ObservationStoreError('INVALID_INPUT'); }
  if (!(date instanceof Date) || !Number.isSafeInteger(date.getTime()) || date.getTime() < 0) throw new ObservationStoreError('INVALID_INPUT');
  return date.getTime();
}
function normalizeSql(sql: string): string { return sql.replaceAll(String.fromCharCode(32), '').replaceAll(String.fromCharCode(10), '').replaceAll(String.fromCharCode(13), '').replaceAll(String.fromCharCode(34), '').toLowerCase(); }
function configure(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = FULL');
}
function assertIntegrity(db: DatabaseSync): void {
  const integrity = db.prepare('PRAGMA integrity_check').all() as SqlRow[];
  const fks = db.prepare('PRAGMA foreign_key_check').all() as SqlRow[];
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok' || fks.length !== 0) throw new ObservationStoreError('DATABASE_CORRUPT');
}
function assertSchema(db: DatabaseSync, config: StoreConfig): void {
  const version = db.prepare('PRAGMA user_version').get() as SqlRow | undefined;
  if (version?.user_version !== OBSERVATION_STORE_SCHEMA_VERSION) throw new ObservationStoreError('UNSUPPORTED_SCHEMA_VERSION');
  const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as SqlRow[];
  const names = Object.keys(TABLES).sort();
  if (rows.length !== names.length) throw new ObservationStoreError('DATABASE_CORRUPT');
  for (const [i, name] of names.entries()) {
    const row = rows[i];
    const schema = TABLES[name];
    if (row?.type !== 'table' || row.name !== name || typeof row.sql !== 'string' || normalizeSql(row.sql) !== normalizeSql(schema?.sql ?? '')) {
      throw new ObservationStoreError('DATABASE_CORRUPT');
    }
    const columns = (db.prepare(`PRAGMA table_info(${name})`).all() as SqlRow[]).map((column) => column.name);
    if (columns.length !== schema?.columns.length || columns.some((column, j) => column !== schema?.columns[j])) throw new ObservationStoreError('DATABASE_CORRUPT');
  }
  const meta = db.prepare('SELECT schema_version, store_id, max_observation_rows, max_cache_entries, retention_ms FROM store_meta WHERE singleton = 1').get() as SqlRow | undefined;
  if (!meta || meta.schema_version !== OBSERVATION_STORE_SCHEMA_VERSION || meta.store_id !== config.storeId || meta.max_observation_rows !== config.maxObservationRows || meta.max_cache_entries !== config.maxCacheEntries || meta.retention_ms !== config.retentionMs) {
    throw new ObservationStoreError('CONFIGURATION_MISMATCH');
  }
  const count = db.prepare('SELECT COUNT(*) AS count FROM store_meta').get() as SqlRow;
  if (count.count !== 1) throw new ObservationStoreError('DATABASE_CORRUPT');
}
function openExisting(path: string): DatabaseSync {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ObservationStoreError('DATABASE_PATH_INVALID');
  } catch (error) {
    if (error instanceof ObservationStoreError) throw error;
    throw new ObservationStoreError('DATABASE_NOT_FOUND');
  }
  try {
    const db = new DatabaseSync(path);
    configure(db);
    if ((db.prepare('PRAGMA journal_mode').get() as SqlRow | undefined)?.journal_mode !== 'wal') {
      db.close(); throw new ObservationStoreError('DATABASE_CORRUPT');
    }
    return db;
  } catch (error) {
    if (error instanceof ObservationStoreError) throw error;
    throw new ObservationStoreError('DATABASE_CORRUPT');
  }
}
function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve safe failure */ }
    if (error instanceof ObservationStoreError) throw error;
    throw new ObservationStoreError('DATABASE_FAILURE');
  }
}
const SNAPSHOTS_V1_SQL = SNAPSHOTS_SQL
  .replace(", 'TOKEN_OHLCV'", '')
  .replace("CHECK (((operation = 'TOKEN_OHLCV' AND asset = 'USDC' AND timeframe = '1m') OR (operation <> 'TOKEN_OHLCV' AND timeframe = '1h')))", "CHECK (timeframe = '1h')");
const OBSERVATIONS_V1_SQL = OBSERVATIONS_SQL.replace(", 'TOKEN_OHLCV'", '');

function assertObservationStoreV1Schema(db: DatabaseSync, config: StoreConfig): void {
  const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as SqlRow[];
  const expected: Record<string, string> = {
    cache_entries: CACHE_SQL, observations: OBSERVATIONS_V1_SQL, snapshots: SNAPSHOTS_V1_SQL, store_meta: META_SQL,
  };
  const names = Object.keys(expected).sort();
  if (rows.length !== names.length) throw new ObservationStoreError('DATABASE_CORRUPT');
  for (const [i, name] of names.entries()) {
    const row = rows[i];
    if (row?.type !== 'table' || row.name !== name || typeof row.sql !== 'string' ||
        normalizeSql(row.sql) !== normalizeSql(expected[name] ?? '')) throw new ObservationStoreError('DATABASE_CORRUPT');
    const columns = (db.prepare('PRAGMA table_info(' + name + ')').all() as SqlRow[]).map((column) => column.name);
    const expectedColumns = TABLES[name]?.columns;
    if (!expectedColumns || columns.length !== expectedColumns.length || columns.some((column, j) => column !== expectedColumns[j])) {
      throw new ObservationStoreError('DATABASE_CORRUPT');
    }
  }
  const meta = db.prepare('SELECT schema_version, store_id, max_observation_rows, max_cache_entries, retention_ms FROM store_meta WHERE singleton = 1').get() as SqlRow | undefined;
  if (!meta || meta.schema_version !== 1 || meta.store_id !== config.storeId ||
      meta.max_observation_rows !== config.maxObservationRows || meta.max_cache_entries !== config.maxCacheEntries ||
      meta.retention_ms !== config.retentionMs) throw new ObservationStoreError('CONFIGURATION_MISMATCH');
}

function migrateObservationStoreV1(db: DatabaseSync, config: StoreConfig): void {
  const version = db.prepare('PRAGMA user_version').get() as SqlRow | undefined;
  if (version?.user_version !== 1) {
    if (version?.user_version === OBSERVATION_STORE_SCHEMA_VERSION) return;
    throw new ObservationStoreError('UNSUPPORTED_SCHEMA_VERSION');
  }
  assertIntegrity(db);
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(db, () => {
      const current = db.prepare('PRAGMA user_version').get() as SqlRow | undefined;
      if (current?.user_version !== 1) throw new ObservationStoreError('UNSUPPORTED_SCHEMA_VERSION');
      assertObservationStoreV1Schema(db, config);
      const snapshotsBefore = Number((db.prepare('SELECT COUNT(*) AS count FROM snapshots').get() as SqlRow).count);
      const observationsBefore = Number((db.prepare('SELECT COUNT(*) AS count FROM observations').get() as SqlRow).count);
      const snapshotsV2 = SNAPSHOTS_SQL.replace('CREATE TABLE snapshots (', 'CREATE TABLE snapshots_v2 (');
      const observationsV2 = OBSERVATIONS_SQL.replace('CREATE TABLE observations (', 'CREATE TABLE observations_v2 (');
      if (snapshotsV2 === SNAPSHOTS_SQL || observationsV2 === OBSERVATIONS_SQL) throw new ObservationStoreError('DATABASE_FAILURE');
      db.exec(snapshotsV2);
      db.exec('INSERT INTO snapshots_v2 SELECT * FROM snapshots');
      db.exec(observationsV2);
      db.exec('INSERT INTO observations_v2 SELECT * FROM observations');
      db.exec('DROP TABLE observations');
      db.exec('DROP TABLE snapshots');
      db.exec('ALTER TABLE snapshots_v2 RENAME TO snapshots');
      db.exec('ALTER TABLE observations_v2 RENAME TO observations');
      db.prepare('UPDATE store_meta SET schema_version = ? WHERE singleton = 1').run(OBSERVATION_STORE_SCHEMA_VERSION);
      db.exec('PRAGMA user_version = ' + OBSERVATION_STORE_SCHEMA_VERSION);
      const snapshotsAfter = Number((db.prepare('SELECT COUNT(*) AS count FROM snapshots').get() as SqlRow).count);
      const observationsAfter = Number((db.prepare('SELECT COUNT(*) AS count FROM observations').get() as SqlRow).count);
      if (snapshotsBefore !== snapshotsAfter || observationsBefore !== observationsAfter) throw new ObservationStoreError('DATABASE_CORRUPT');
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  assertIntegrity(db);
  assertSchema(db, config);
}
function validatePageReferences(value: unknown): readonly StoredPageReference[] {
  if (!Array.isArray(value) || value.length > MAX_PAGE_REFERENCES) throw new ObservationStoreError('INVALID_INPUT');
  const result: StoredPageReference[] = [];
  for (const item of value) {
    if (!isRecord(item) || !exactKeys(item, ['attemptId', 'status', 'providerRequestId', 'chargedCredits', 'page', 'received', 'retry'])) throw new ObservationStoreError('INVALID_INPUT');
    if (
      typeof item.attemptId !== 'string' || !IDENTIFIER.test(item.attemptId) ||
      (item.status !== null && (!Number.isSafeInteger(item.status) || Number(item.status) < 100 || Number(item.status) > 599)) ||
      (item.providerRequestId !== null && (typeof item.providerRequestId !== 'string' || !IDENTIFIER.test(item.providerRequestId))) ||
      (item.chargedCredits !== null && (!Number.isSafeInteger(item.chargedCredits) || Number(item.chargedCredits) < 0)) ||
      !Number.isSafeInteger(item.page) || Number(item.page) < 1 || Number(item.page) > 20 ||
      typeof item.received !== 'boolean' || !Number.isSafeInteger(item.retry) || Number(item.retry) < 0 || Number(item.retry) > 2
    ) throw new ObservationStoreError('INVALID_INPUT');
    result.push(Object.freeze({
      attemptId: item.attemptId, status: item.status as number | null,
      providerRequestId: item.providerRequestId as string | null, chargedCredits: item.chargedCredits as number | null,
      page: item.page as number, received: item.received, retry: item.retry as number,
    }));
  }
  return Object.freeze(result);
}
function validateFailure(value: unknown): AdapterFailure | null {
  if (value === null) return null;
  if (!isRecord(value) || !exactKeys(value, ['code', 'status', 'ledgerCode'])) throw new ObservationStoreError('INVALID_INPUT');
  if (
    typeof value.code !== 'string' || !(FAILURE_CODES as readonly string[]).includes(value.code) ||
    (value.status !== null && (!Number.isSafeInteger(value.status) || Number(value.status) < 100 || Number(value.status) > 599)) ||
    (value.ledgerCode !== null && (typeof value.ledgerCode !== 'string' || !(LEDGER_CODES as readonly string[]).includes(value.ledgerCode)))
  ) throw new ObservationStoreError('INVALID_INPUT');
  return Object.freeze({ code: value.code as AdapterFailure['code'], status: value.status as number | null, ledgerCode: value.ledgerCode as string | null });
}
function validateUnavailable(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 64 || value.some((field) => typeof field !== 'string' || !/^[A-Za-z0-9_.-]{1,96}$/u.test(field))) {
    throw new ObservationStoreError('INVALID_INPUT');
  }
  return Object.freeze([...new Set(value as string[])]);
}
function validateSnapshot(input: ObservationSnapshotInput): ObservationSnapshot {
  const allowed = ['snapshotId', 'cacheKey', 'operation', 'asset', 'timeframe', 'pageBound', 'retryBound', 'source', 'fetchedAt', 'acquiredAt', 'expiresAt', 'completeness', 'failure', 'pageReferences', 'unavailableFields', 'signals'];
  if (!isRecord(input) || !exactKeys(input, allowed)) throw new ObservationStoreError('INVALID_INPUT');
  const snapshotId = input.snapshotId ?? randomUUID();
  const fetched = safeDate(input.fetchedAt);
  const acquired = safeDate(input.acquiredAt);
  const expires = safeDate(input.expiresAt);
  if (
    typeof snapshotId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(snapshotId) ||
    typeof input.cacheKey !== 'string' || !HASH.test(input.cacheKey) ||
    typeof input.operation !== 'string' || !(ENDPOINTS as readonly string[]).includes(input.operation) ||
    !['BASE_PAIR', 'USDC', 'WETH'].includes(String(input.asset)) || (input.operation === 'TOKEN_OHLCV' ? input.asset !== 'USDC' || input.timeframe !== '1m' || input.pageBound !== 1 || input.retryBound !== 0 : input.timeframe !== '1h') ||
    !Number.isSafeInteger(input.pageBound) || Number(input.pageBound) < 1 || Number(input.pageBound) > 20 ||
    !Number.isSafeInteger(input.retryBound) || Number(input.retryBound) < 0 || Number(input.retryBound) > 2 ||
    (input.source !== 'nansen' && input.source !== 'synthetic') ||
    typeof input.completeness !== 'string' || !(COMPLETENESS as readonly string[]).includes(input.completeness) ||
    fetched.ms > acquired.ms || expires.ms < acquired.ms || !Array.isArray(input.signals) || input.signals.length > MAX_SIGNALS_PER_SNAPSHOT
  ) throw new ObservationStoreError('INVALID_INPUT');
  const failure = validateFailure(input.failure);
  const pageReferences = validatePageReferences(input.pageReferences);
  const unavailableFields = validateUnavailable(input.unavailableFields);
  if (failure !== null && input.completeness === 'complete') throw new ObservationStoreError('INVALID_INPUT');
  const endpoint = input.operation as NormalizedSignal['endpoint'];
  const signals = input.signals.map((candidate) => {
    const parsed = normalizedSignalSchema.safeParse(candidate);
    if (!parsed.success) throw new ObservationStoreError('INVALID_INPUT');
    const signal = parsed.data;
    if (input.completeness !== 'complete' && signal.quality === 'COMPLETE') throw new ObservationStoreError('INVALID_INPUT');
    const signalTimeValid = input.operation === 'TOKEN_OHLCV'
      ? signal.asset === 'USDC' && signal.metric === 'price_usd' && signal.timeframe === '1m' && Date.parse(signal.observedAt) + 60_000 <= fetched.ms
      : signal.observedAt === acquired.iso && (signal.timeframe === undefined || signal.timeframe === '1h');
    if (signal.endpoint !== endpoint || signal.provider !== input.source || !signalTimeValid || signal.fetchedAt !== fetched.iso) {
      throw new ObservationStoreError('INVALID_INPUT');
    }
    return Object.freeze({ ...signal, timeframe: input.timeframe as ObservationSnapshot['timeframe'] });
  });
  if (new Set(signals.map((signal) => signal.signalId)).size !== signals.length) throw new ObservationStoreError('INVALID_INPUT');
  return Object.freeze({
    snapshotId, cacheKey: input.cacheKey, operation: input.operation as NansenOperation,
    asset: input.asset as ObservationSnapshot['asset'], timeframe: input.timeframe as ObservationSnapshot['timeframe'], pageBound: Number(input.pageBound),
    retryBound: Number(input.retryBound), source: input.source, fetchedAt: fetched.iso, acquiredAt: acquired.iso,
    expiresAt: expires.iso, completeness: input.completeness as AdapterCompleteness, failure,
    pageReferences, unavailableFields, signals: Object.freeze(signals),
  });
}
function parseJson<T>(value: unknown, validate: (input: unknown) => T): T {
  if (typeof value !== 'string') throw new ObservationStoreError('DATABASE_CORRUPT');
  try { return validate(JSON.parse(value) as unknown); }
  catch (error) { if (error instanceof ObservationStoreError) throw error; throw new ObservationStoreError('DATABASE_CORRUPT'); }
}
function snapshotFromRow(db: DatabaseSync, row: SqlRow): ObservationSnapshot {
  if (
    typeof row.snapshot_id !== 'string' || typeof row.cache_key !== 'string' || !HASH.test(row.cache_key) ||
    typeof row.operation !== 'string' || !(ENDPOINTS as readonly string[]).includes(row.operation) ||
    typeof row.asset !== 'string' || !['BASE_PAIR', 'USDC', 'WETH'].includes(row.asset) ||
    typeof row.source !== 'string' || !['nansen', 'synthetic'].includes(row.source) ||
    typeof row.completeness !== 'string' || !(COMPLETENESS as readonly string[]).includes(row.completeness) ||
    typeof row.fetched_at !== 'string' || typeof row.acquired_at !== 'string' || typeof row.expires_at !== 'string'
  ) throw new ObservationStoreError('DATABASE_CORRUPT');
  if (row.failure_code === null && (row.failure_status !== null || row.failure_ledger_code !== null)) throw new ObservationStoreError('DATABASE_CORRUPT');
  const failure = row.failure_code === null ? null : validateFailure({
    code: row.failure_code, status: row.failure_status === null ? null : Number(row.failure_status), ledgerCode: row.failure_ledger_code,
  });
  const rows = db.prepare(
    'SELECT signal_id, provider, endpoint, chain_id, asset, metric, observed_at, fetched_at, quality, value, unit, provenance_id FROM observations WHERE snapshot_id = ? ORDER BY rowid',
  ).all(row.snapshot_id) as SqlRow[];
  if (rows.length !== Number(row.observation_count) || rows.length > MAX_SIGNALS_PER_SNAPSHOT) throw new ObservationStoreError('DATABASE_CORRUPT');
  const signals = rows.map((r) => {
    const parsed = normalizedSignalSchema.safeParse({
      signalId: r.signal_id, provider: r.provider, endpoint: r.endpoint, chainId: r.chain_id,
      asset: r.asset, metric: r.metric, observedAt: r.observed_at, fetchedAt: r.fetched_at, timeframe: row.timeframe,
      quality: r.quality, value: r.value, unit: r.unit, provenanceId: r.provenance_id,
    });
    if (!parsed.success) throw new ObservationStoreError('DATABASE_CORRUPT');
    return parsed.data;
  });
  const refs = parseJson(row.page_references_json, validatePageReferences);
  const unavailable = parseJson(row.unavailable_fields_json, validateUnavailable);
  return validateSnapshot({
    snapshotId: row.snapshot_id, cacheKey: row.cache_key, operation: row.operation as NansenOperation,
    asset: row.asset as ObservationSnapshot['asset'], timeframe: row.timeframe as ObservationSnapshot['timeframe'],
    pageBound: Number(row.page_bound), retryBound: Number(row.retry_bound), source: row.source as 'nansen' | 'synthetic',
    fetchedAt: row.fetched_at, acquiredAt: row.acquired_at, expiresAt: row.expires_at,
    completeness: row.completeness as AdapterCompleteness, failure, pageReferences: refs,
    unavailableFields: unavailable, signals,
  });
}

export class NansenObservationStore {
  private closed = false;
  constructor(private readonly db: DatabaseSync, private readonly config: StoreConfig) {}

  /** Set `cache: false` to append historical evidence without changing cache rows. */
  writeSnapshot(input: ObservationSnapshotInput, options?: ObservationStoreWriteOptions): ObservationSnapshot {
    this.ensureOpen();
    if (options !== undefined && (!isRecord(options) || !exactKeys(options, ['cache']) ||
        (options.cache !== undefined && typeof options.cache !== 'boolean'))) throw new ObservationStoreError('INVALID_INPUT');
    const updateCache = options?.cache ?? true;
    const snapshot = validateSnapshot(input);
    if (snapshot.signals.length > this.config.maxObservationRows) throw new ObservationStoreError('CAPACITY_EXCEEDED');
    const cachedAt = clockMs(this.config.clock);
    const retentionCutoff = cachedAt - this.config.retentionMs;
    return transaction(this.db, () => {
      if (updateCache) {
        this.db.prepare('DELETE FROM cache_entries WHERE expires_at_ms <= ?').run(cachedAt);
        this.db.prepare('DELETE FROM snapshots WHERE acquired_at_ms < ?').run(retentionCutoff);
      }
      this.db.prepare(
        'INSERT INTO snapshots (snapshot_id, cache_key, operation, asset, timeframe, page_bound, retry_bound, source, fetched_at, acquired_at, fetched_at_ms, acquired_at_ms, expires_at, expires_at_ms, completeness, failure_code, failure_status, failure_ledger_code, page_references_json, unavailable_fields_json, observation_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        snapshot.snapshotId, snapshot.cacheKey, snapshot.operation, snapshot.asset, snapshot.timeframe,
        snapshot.pageBound, snapshot.retryBound, snapshot.source, snapshot.fetchedAt, snapshot.acquiredAt,
        Date.parse(snapshot.fetchedAt), Date.parse(snapshot.acquiredAt), snapshot.expiresAt, Date.parse(snapshot.expiresAt),
        snapshot.completeness, snapshot.failure?.code ?? null, snapshot.failure?.status ?? null,
        snapshot.failure?.ledgerCode ?? null, JSON.stringify(snapshot.pageReferences), JSON.stringify(snapshot.unavailableFields),
        snapshot.signals.length,
      );
      const insert = this.db.prepare(
        'INSERT INTO observations (signal_id, snapshot_id, provider, endpoint, chain_id, asset, metric, observed_at, fetched_at, quality, value, unit, provenance_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const signal of snapshot.signals) {
        insert.run(signal.signalId, snapshot.snapshotId, signal.provider, signal.endpoint, signal.chainId, signal.asset,
          signal.metric, signal.observedAt, signal.fetchedAt, signal.quality, signal.value, signal.unit, signal.provenanceId);
      }
      if (updateCache) {
        this.db.prepare(
          'INSERT INTO cache_entries (cache_key, snapshot_id, cached_at_ms, expires_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET snapshot_id = excluded.snapshot_id, cached_at_ms = excluded.cached_at_ms, expires_at_ms = excluded.expires_at_ms',
        ).run(snapshot.cacheKey, snapshot.snapshotId, cachedAt, Date.parse(snapshot.expiresAt));
        const count = (sql: string) => Number((this.db.prepare(sql).get() as SqlRow).count);
        const extraCache = count('SELECT COUNT(*) AS count FROM cache_entries') - this.config.maxCacheEntries;
        if (extraCache > 0) this.db.prepare(
          'DELETE FROM cache_entries WHERE cache_key IN (SELECT cache_key FROM cache_entries ORDER BY cached_at_ms, cache_key LIMIT ?)',
        ).run(extraCache);
      }
      const count = (sql: string) => Number((this.db.prepare(sql).get() as SqlRow).count);
      let rows = count('SELECT COUNT(*) AS count FROM observations');
      while (rows > this.config.maxObservationRows) {
        const oldest = this.db.prepare(updateCache
          ? 'SELECT snapshot_id, observation_count FROM snapshots WHERE snapshot_id <> ? ORDER BY acquired_at_ms, snapshot_id LIMIT 1'
          : 'SELECT s.snapshot_id, s.observation_count FROM snapshots s LEFT JOIN cache_entries c ON c.snapshot_id = s.snapshot_id WHERE s.snapshot_id <> ? AND c.snapshot_id IS NULL ORDER BY s.acquired_at_ms, s.snapshot_id LIMIT 1',
        ).get(snapshot.snapshotId) as SqlRow | undefined;
        if (!oldest || typeof oldest.snapshot_id !== 'string') throw new ObservationStoreError('CAPACITY_EXCEEDED');
        rows -= Number(oldest.observation_count);
        this.db.prepare('DELETE FROM snapshots WHERE snapshot_id = ?').run(oldest.snapshot_id);
      }
      let snapshots = count('SELECT COUNT(*) AS count FROM snapshots');
      while (snapshots > MAX_SNAPSHOT_ROWS) {
        const oldestSnapshot = this.db.prepare(updateCache
          ? 'SELECT snapshot_id FROM snapshots WHERE snapshot_id <> ? ORDER BY acquired_at_ms, snapshot_id LIMIT 1'
          : 'SELECT s.snapshot_id FROM snapshots s LEFT JOIN cache_entries c ON c.snapshot_id = s.snapshot_id WHERE s.snapshot_id <> ? AND c.snapshot_id IS NULL ORDER BY s.acquired_at_ms, s.snapshot_id LIMIT 1',
        ).get(snapshot.snapshotId) as SqlRow | undefined;
        if (!oldestSnapshot || typeof oldestSnapshot.snapshot_id !== 'string') throw new ObservationStoreError('CAPACITY_EXCEEDED');
        this.db.prepare('DELETE FROM snapshots WHERE snapshot_id = ?').run(oldestSnapshot.snapshot_id);
        snapshots -= 1;
      }
      return snapshot;
    });
  }

  getFreshCache(cacheKey: string, at: Date = this.config.clock()): ObservationSnapshot | null {
    this.ensureOpen();
    if (!HASH.test(cacheKey)) throw new ObservationStoreError('INVALID_INPUT');
    const now = clockMs(() => at);
    return transaction(this.db, () => {
      const row = this.db.prepare(
        'SELECT s.* FROM cache_entries c JOIN snapshots s ON s.snapshot_id = c.snapshot_id WHERE c.cache_key = ? AND c.expires_at_ms > ?',
      ).get(cacheKey, now) as SqlRow | undefined;
      return row ? snapshotFromRow(this.db, row) : null;
    });
  }

  getMostRecentWithObservations(cacheKey: string): ObservationSnapshot | null {
    this.ensureOpen();
    if (!HASH.test(cacheKey)) throw new ObservationStoreError('INVALID_INPUT');
    return transaction(this.db, () => {
      const row = this.db.prepare(
        "SELECT * FROM snapshots WHERE cache_key = ? AND observation_count > 0 AND failure_code IS NULL AND completeness = 'complete' ORDER BY acquired_at_ms DESC, snapshot_id DESC LIMIT 1",
      ).get(cacheKey) as SqlRow | undefined;
      return row ? snapshotFromRow(this.db, row) : null;
    });
  }

  /** Read the newest stored attempt for one exact managed query identity, including incomplete results. */
  getLatestSnapshotByCacheKey(cacheKey: string): ObservationSnapshot | null {
    this.ensureOpen();
    if (!HASH.test(cacheKey)) throw new ObservationStoreError('INVALID_INPUT');
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM snapshots WHERE cache_key = ? ORDER BY acquired_at_ms DESC, snapshot_id DESC LIMIT 1').get(cacheKey) as SqlRow | undefined;
      return row ? snapshotFromRow(this.db, row) : null;
    });
  }

  /** Read the newest persisted snapshot for each operation from exactly one provenance source. */
  getLatestSnapshots(source: 'nansen' | 'synthetic'): readonly ObservationSnapshot[] {
    this.ensureOpen();
    if (source !== 'nansen' && source !== 'synthetic') throw new ObservationStoreError('INVALID_INPUT');
    return transaction(this.db, () => Object.freeze((this.db.prepare(`
      SELECT s.* FROM snapshots s
      JOIN (
        SELECT operation, MAX(acquired_at_ms) AS acquired_at_ms FROM snapshots WHERE source = ? GROUP BY operation
      ) latest ON latest.operation = s.operation AND latest.acquired_at_ms = s.acquired_at_ms
      WHERE s.source = ? ORDER BY s.operation, s.snapshot_id DESC LIMIT 3
    `).all(source, source) as SqlRow[]).map((row) => snapshotFromRow(this.db, row))));
  }
  /** Read the newest persisted observation snapshot per operation and provenance without dispatching a request. */
  getLatestSignals(): readonly NormalizedSignal[] {
    this.ensureOpen();
    return transaction(this.db, () => {
      const rows = this.db.prepare(`WITH latest AS (
        SELECT source, operation, MAX(acquired_at_ms) AS acquired_at_ms FROM snapshots GROUP BY source, operation
      )
      SELECT o.* FROM observations o
      JOIN snapshots s ON s.snapshot_id = o.snapshot_id
      JOIN latest l ON l.source = s.source AND l.operation = s.operation AND l.acquired_at_ms = s.acquired_at_ms
      ORDER BY s.acquired_at_ms DESC, o.signal_id ASC LIMIT 5000`).all() as SqlRow[];
      return Object.freeze(rows.map((row) => normalizedSignalSchema.parse({
        signalId: row.signal_id, provider: row.provider, endpoint: row.endpoint, chainId: row.chain_id,
        asset: row.asset, metric: row.metric, observedAt: row.observed_at, fetchedAt: row.fetched_at,
        quality: row.quality, value: row.value, unit: row.unit, provenanceId: row.provenance_id,
      })));
    });
  }
  listHistory(query: ObservationHistoryQuery): readonly ObservationSnapshot[] {
    this.ensureOpen();
    if (!isRecord(query) || !exactKeys(query, ['cacheKey', 'limit']) || typeof query.cacheKey !== 'string' || !HASH.test(query.cacheKey)) {
      throw new ObservationStoreError('INVALID_INPUT');
    }
    const limit = query.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_OBSERVATION_HISTORY_QUERY_LIMIT) throw new ObservationStoreError('INVALID_INPUT');
    return transaction(this.db, () => Object.freeze((this.db.prepare(
      'SELECT * FROM snapshots WHERE cache_key = ? ORDER BY acquired_at_ms DESC, snapshot_id DESC LIMIT ?',
    ).all(query.cacheKey, limit) as SqlRow[]).map((row) => snapshotFromRow(this.db, row))));
  }

  /** Total retained snapshots for a canonical query, used to report bounded-history truncation. */
  getHistoryCount(cacheKey: string): number {
    this.ensureOpen();
    if (!HASH.test(cacheKey)) throw new ObservationStoreError('INVALID_INPUT');
    return transaction(this.db, () => Number((this.db.prepare(
      'SELECT COUNT(*) AS count FROM snapshots WHERE cache_key = ?',
    ).get(cacheKey) as SqlRow).count));
  }

  getStats(): { readonly observationRows: number; readonly cacheEntries: number; readonly retainedSnapshots: number } {
    this.ensureOpen();
    return transaction(this.db, () => {
      const count = (table: string) => Number((this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as SqlRow).count);
      return Object.freeze({ observationRows: count('observations'), cacheEntries: count('cache_entries'), retainedSnapshots: count('snapshots') });
    });
  }

  close(): void {
    if (this.closed) return;
    try { this.db.close(); this.closed = true; }
    catch { throw new ObservationStoreError('DATABASE_FAILURE'); }
  }
  private ensureOpen(): void { if (this.closed) throw new ObservationStoreError('STORE_CLOSED'); }
}

export function initializeNansenObservationStore(options: ObservationStoreOptions): NansenObservationStore {
  const config = validateConfig(options);
  let descriptor: number;
  try { descriptor = openSync(config.databasePath, 'wx', 0o600); }
  catch (error) {
    if (isRecord(error) && error.code === 'EEXIST') throw new ObservationStoreError('DATABASE_ALREADY_EXISTS');
    throw new ObservationStoreError('DATABASE_PATH_INVALID');
  }
  try { closeSync(descriptor); } catch { throw new ObservationStoreError('DATABASE_FAILURE'); }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(config.databasePath);
    configure(db);
    if ((db.prepare('PRAGMA journal_mode = WAL').get() as SqlRow | undefined)?.journal_mode !== 'wal') throw new ObservationStoreError('DATABASE_FAILURE');
    transaction(db, () => {
      db?.exec(META_SQL); db?.exec(SNAPSHOTS_SQL); db?.exec(OBSERVATIONS_SQL); db?.exec(CACHE_SQL);
      db?.exec('PRAGMA user_version = ' + OBSERVATION_STORE_SCHEMA_VERSION);
      db?.prepare('INSERT INTO store_meta (singleton, schema_version, store_id, max_observation_rows, max_cache_entries, retention_ms) VALUES (1, ?, ?, ?, ?, ?)')
        .run(OBSERVATION_STORE_SCHEMA_VERSION, config.storeId, config.maxObservationRows, config.maxCacheEntries, config.retentionMs);
    });
    assertIntegrity(db); assertSchema(db, config);
    return new NansenObservationStore(db, config);
  } catch (error) {
    try { db?.close(); } catch { /* Preserve failed initialized state. */ }
    if (error instanceof ObservationStoreError) throw error;
    throw new ObservationStoreError('DATABASE_FAILURE');
  }
}

export function openNansenObservationStore(options: ObservationStoreOptions): NansenObservationStore {
  const config = validateConfig(options);
  const db = openExisting(config.databasePath);
  try { migrateObservationStoreV1(db, config); assertIntegrity(db); assertSchema(db, config); return new NansenObservationStore(db, config); }
  catch (error) {
    try { db.close(); } catch { /* Preserve state on fail-closed open. */ }
    if (error instanceof ObservationStoreError) throw error;
    throw new ObservationStoreError('DATABASE_CORRUPT');
  }
}

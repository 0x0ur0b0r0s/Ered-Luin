import { closeSync, existsSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, d2EvaluationSchema, d2ProposalSchema, d2SimulationSchema, type D2Evaluation, type D2Proposal, type D2Simulation, type G3cStatusResponse } from '@ered-luin/contracts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TABLE_SQL = `CREATE TABLE d2_proposals (
  proposal_id TEXT PRIMARY KEY CHECK (length(proposal_id) = 36),
  proposal_json TEXT NOT NULL CHECK (length(proposal_json) <= 524288),
  evaluation_json TEXT CHECK (evaluation_json IS NULL OR length(evaluation_json) <= 524288),
  created_at TEXT NOT NULL
) STRICT`;
const SIMULATION_SQL = `CREATE TABLE d2_simulations (
  operation_id TEXT PRIMARY KEY CHECK (length(operation_id) = 36),
  proposal_id TEXT NOT NULL REFERENCES d2_proposals(proposal_id),
  simulation_json TEXT NOT NULL CHECK (length(simulation_json) <= 524288),
  created_at TEXT NOT NULL
) STRICT`;
const SEMANTIC_ASSOCIATIONS_V2_SQL = `CREATE TABLE d2_semantic_associations (
  proposal_id TEXT PRIMARY KEY REFERENCES d2_proposals(proposal_id),
  attempt_id TEXT NOT NULL UNIQUE CHECK (length(attempt_id) = 36),
  request_hash TEXT NOT NULL UNIQUE CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  evidence_hash TEXT NOT NULL CHECK (length(evidence_hash) = 64 AND evidence_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL
) STRICT`;
const SEMANTIC_ASSOCIATIONS_SQL = `CREATE TABLE d2_semantic_associations (
  proposal_id TEXT PRIMARY KEY REFERENCES d2_proposals(proposal_id),
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) = 36),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  evidence_hash TEXT NOT NULL CHECK (length(evidence_hash) = 64 AND evidence_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL
) STRICT`;
const SEMANTIC_ASSOCIATION_TRIGGERS = [
  "CREATE TRIGGER d2_semantic_associations_no_update BEFORE UPDATE ON d2_semantic_associations BEGIN SELECT RAISE(ABORT, 'append only'); END",
  "CREATE TRIGGER d2_semantic_associations_no_delete BEFORE DELETE ON d2_semantic_associations BEGIN SELECT RAISE(ABORT, 'append only'); END",
];
const SEMANTIC_ASSOCIATION_INDEXES = [
  'CREATE INDEX d2_semantic_associations_attempt_id ON d2_semantic_associations (attempt_id)',
  'CREATE INDEX d2_semantic_associations_request_hash ON d2_semantic_associations (request_hash)',
];
const D2_SCHEMA_VERSION = 3;
type Row = Record<string, unknown>;

export interface D2SemanticAssociation {
  readonly proposalId: string;
  readonly attemptId: string;
  readonly requestHash: string;
  readonly evidenceHash: string;
  readonly createdAt: string;
}

function parseSemanticAssociation(row: Row | undefined): D2SemanticAssociation | null {
  if (!row) return null;
  const value = {
    proposalId: String(row.proposal_id), attemptId: String(row.attempt_id), requestHash: String(row.request_hash),
    evidenceHash: String(row.evidence_hash), createdAt: String(row.created_at),
  };
  if (!/^[0-9a-f-]{36}$/iu.test(value.proposalId) || !/^[0-9a-f-]{36}$/iu.test(value.attemptId) ||
      !/^[0-9a-f]{64}$/u.test(value.requestHash) || !/^[0-9a-f]{64}$/u.test(value.evidenceHash) ||
      !Number.isSafeInteger(Date.parse(value.createdAt))) throw new D2AuditStoreError('CORRUPT');
  return Object.freeze(value);
}

function evidenceHash(proposal: D2Proposal): string {
  return createHash('sha256').update(canonicalJson(proposal.evidence), 'utf8').digest('hex');
}

function installSemanticAssociations(db: DatabaseSync): void {
  db.exec(SEMANTIC_ASSOCIATIONS_SQL);
  for (const trigger of SEMANTIC_ASSOCIATION_TRIGGERS) db.exec(trigger);
  for (const index of SEMANTIC_ASSOCIATION_INDEXES) db.exec(index);
}

function validateSemanticAssociationTriggers(db: DatabaseSync): void {
  for (let index = 0; index < SEMANTIC_ASSOCIATION_TRIGGERS.length; index += 1) {
    const name = index === 0 ? 'd2_semantic_associations_no_update' : 'd2_semantic_associations_no_delete';
    const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?").get(name) as Row | undefined;
    if (trigger?.sql !== SEMANTIC_ASSOCIATION_TRIGGERS[index]) throw new D2AuditStoreError('CORRUPT');
  }
}

function migrateSemanticAssociationsV2(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DROP TRIGGER d2_semantic_associations_no_update; DROP TRIGGER d2_semantic_associations_no_delete');
    db.exec('ALTER TABLE d2_semantic_associations RENAME TO d2_semantic_associations_v2');
    db.exec(SEMANTIC_ASSOCIATIONS_SQL);
    db.exec(`INSERT INTO d2_semantic_associations (proposal_id,attempt_id,request_hash,evidence_hash,created_at)
      SELECT proposal_id,attempt_id,request_hash,evidence_hash,created_at FROM d2_semantic_associations_v2`);
    db.exec('DROP TABLE d2_semantic_associations_v2');
    for (const trigger of SEMANTIC_ASSOCIATION_TRIGGERS) db.exec(trigger);
    for (const index of SEMANTIC_ASSOCIATION_INDEXES) db.exec(index);
    db.exec('PRAGMA user_version = ' + D2_SCHEMA_VERSION);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Preserve primary failure. */ }
    throw error;
  }
}

function parseSimulation(row: Row | undefined): D2Simulation | null {
  if (!row) return null;
  try {
    const simulation = d2SimulationSchema.parse(JSON.parse(String(row.simulation_json)));
    if (simulation.operationId !== row.operation_id || simulation.proposalId !== row.proposal_id) throw new Error();
    return simulation;
  } catch { throw new D2AuditStoreError('CORRUPT'); }
}

export class D2AuditStoreError extends Error {
  constructor(readonly code: 'PATH_INVALID' | 'ALREADY_EXISTS' | 'NOT_FOUND' | 'CORRUPT' | 'CONFLICT' | 'CLOSED' | 'DATABASE_FAILURE') {
    super(`D2 audit store ${code.toLowerCase().replaceAll('_', ' ')}.`);
    this.name = 'D2AuditStoreError';
  }
}

function validatePath(path: string): string {
  if (!isAbsolute(path) || path.includes(String.fromCharCode(0))) throw new D2AuditStoreError('PATH_INVALID');
  const absolute = resolve(path);
  const rel = relative(ROOT, absolute);
  if (rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))) throw new D2AuditStoreError('PATH_INVALID');
  if (existsSync(absolute)) {
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || resolve(realpathSync(absolute)) !== absolute) throw new D2AuditStoreError('PATH_INVALID');
  }
  return absolute;
}
function parseProposal(row: Row | undefined): D2Proposal | null {
  if (!row) return null;
  try {
    const proposal = d2ProposalSchema.parse(JSON.parse(String(row.proposal_json)));
    if (proposal.proposalId !== row.proposal_id) throw new Error();
    return proposal;
  } catch { throw new D2AuditStoreError('CORRUPT'); }
}
function parseEvaluation(row: Row | undefined): D2Evaluation | null {
  if (!row || row.evaluation_json === null || row.evaluation_json === undefined) return null;
  try {
    const evaluation = d2EvaluationSchema.parse(JSON.parse(String(row.evaluation_json)));
    if (evaluation.proposalId !== row.proposal_id) throw new Error();
    return evaluation;
  } catch { throw new D2AuditStoreError('CORRUPT'); }
}

export class D2AuditStore {
  private closed = false;
  constructor(private readonly db: DatabaseSync) {}

  saveProposal(value: D2Proposal): D2Proposal {
    this.ensureOpen();
    const proposal = d2ProposalSchema.parse(value);
    try {
      const existing = this.db.prepare('SELECT * FROM d2_proposals WHERE proposal_id = ?').get(proposal.proposalId) as Row | undefined;
      if (existing) {
        const prior = parseProposal(existing);
        if (JSON.stringify(prior) !== JSON.stringify(proposal)) throw new D2AuditStoreError('CONFLICT');
        return prior!;
      }
      this.db.prepare('INSERT INTO d2_proposals (proposal_id,proposal_json,evaluation_json,created_at) VALUES (?,?,NULL,?)')
        .run(proposal.proposalId, JSON.stringify(proposal), proposal.createdAt);
      return proposal;
    } catch (error) {
      if (error instanceof D2AuditStoreError) throw error;
      throw new D2AuditStoreError('DATABASE_FAILURE');
    }
  }

  getProposal(proposalId: string): D2Proposal | null {
    this.ensureOpen();
    if (!/^[0-9a-f-]{36}$/iu.test(proposalId)) return null;
    try { return parseProposal(this.db.prepare('SELECT * FROM d2_proposals WHERE proposal_id = ?').get(proposalId) as Row | undefined); }
    catch (error) { if (error instanceof D2AuditStoreError) throw error; throw new D2AuditStoreError('DATABASE_FAILURE'); }
  }

  associateSemanticAttempt(input: { readonly proposalId: string; readonly attemptId: string; readonly requestHash: string; readonly createdAt: string }): D2SemanticAssociation {
    this.ensureOpen();
    if (!/^[0-9a-f-]{36}$/iu.test(input.proposalId) || !/^[0-9a-f-]{36}$/iu.test(input.attemptId) ||
        !/^[0-9a-f]{64}$/u.test(input.requestHash) || !Number.isSafeInteger(Date.parse(input.createdAt))) {
      throw new D2AuditStoreError('CONFLICT');
    }
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const proposal = parseProposal(this.db.prepare('SELECT * FROM d2_proposals WHERE proposal_id = ?').get(input.proposalId) as Row | undefined);
      if (!proposal) throw new D2AuditStoreError('NOT_FOUND');
      const hash = evidenceHash(proposal);
      const prior = parseSemanticAssociation(this.db.prepare('SELECT * FROM d2_semantic_associations WHERE proposal_id = ?').get(input.proposalId) as Row | undefined);
      if (prior) {
        if (prior.attemptId !== input.attemptId || prior.requestHash !== input.requestHash || prior.evidenceHash !== hash) throw new D2AuditStoreError('CONFLICT');
        this.db.exec('COMMIT');
        return prior;
      }
      const attemptBinding = this.db.prepare('SELECT attempt_id,request_hash FROM d2_semantic_associations WHERE attempt_id = ? LIMIT 1')
        .get(input.attemptId) as Row | undefined;
      const requestBinding = this.db.prepare('SELECT attempt_id,request_hash FROM d2_semantic_associations WHERE request_hash = ? LIMIT 1')
        .get(input.requestHash) as Row | undefined;
      for (const binding of [attemptBinding, requestBinding]) {
        if (binding && (binding.attempt_id !== input.attemptId || binding.request_hash !== input.requestHash)) {
          throw new D2AuditStoreError('CONFLICT');
        }
      }
      const createdAt = new Date(Date.parse(input.createdAt)).toISOString();
      this.db.prepare('INSERT INTO d2_semantic_associations (proposal_id,attempt_id,request_hash,evidence_hash,created_at) VALUES (?,?,?,?,?)')
        .run(input.proposalId, input.attemptId, input.requestHash, hash, createdAt);
      this.db.exec('COMMIT');
      return { proposalId: input.proposalId, attemptId: input.attemptId, requestHash: input.requestHash, evidenceHash: hash, createdAt };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve primary failure. */ }
      if (error instanceof D2AuditStoreError) throw error;
      throw new D2AuditStoreError('CONFLICT');
    }
  }

  getSemanticAssociation(proposalId: string): D2SemanticAssociation | null {
    this.ensureOpen();
    if (!/^[0-9a-f-]{36}$/iu.test(proposalId)) return null;
    try { return parseSemanticAssociation(this.db.prepare('SELECT * FROM d2_semantic_associations WHERE proposal_id = ?').get(proposalId) as Row | undefined); }
    catch (error) { if (error instanceof D2AuditStoreError) throw error; throw new D2AuditStoreError('DATABASE_FAILURE'); }
  }

  getEvaluation(proposalId: string): D2Evaluation | null {
    this.ensureOpen();
    if (!/^[0-9a-f-]{36}$/iu.test(proposalId)) return null;
    try { return parseEvaluation(this.db.prepare('SELECT * FROM d2_proposals WHERE proposal_id = ?').get(proposalId) as Row | undefined); }
    catch (error) { if (error instanceof D2AuditStoreError) throw error; throw new D2AuditStoreError('DATABASE_FAILURE'); }
  }

  recordEvaluation(value: D2Evaluation): D2Evaluation {
    this.ensureOpen();
    const evaluation = d2EvaluationSchema.parse({ ...value, replayed: false });
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const row = this.db.prepare('SELECT * FROM d2_proposals WHERE proposal_id = ?').get(evaluation.proposalId) as Row | undefined;
      if (!row) throw new D2AuditStoreError('NOT_FOUND');
      const prior = parseEvaluation(row);
      if (prior) {
        this.db.exec('COMMIT');
        return d2EvaluationSchema.parse({ ...prior, replayed: true });
      }
      this.db.prepare('UPDATE d2_proposals SET evaluation_json = ? WHERE proposal_id = ? AND evaluation_json IS NULL')
        .run(JSON.stringify(evaluation), evaluation.proposalId);
      this.db.exec('COMMIT');
      return evaluation;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve primary failure. */ }
      if (error instanceof D2AuditStoreError) throw error;
      throw new D2AuditStoreError('DATABASE_FAILURE');
    }
  }

  attachG3cStatus(proposalId: string, status: G3cStatusResponse): D2Evaluation {
    this.ensureOpen();
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const row = this.db.prepare('SELECT * FROM d2_proposals WHERE proposal_id = ?').get(proposalId) as Row | undefined;
      const proposal = parseProposal(row);
      const evaluation = parseEvaluation(row);
      if (!proposal || !evaluation) throw new D2AuditStoreError('NOT_FOUND');
      if ((evaluation.g3cExecutionId !== null && status.executionId !== evaluation.g3cExecutionId) || status.requestedAmount !== proposal.intent.amountIn ||
          status.permittedAmount !== evaluation.decision.approvedAmountIn || !['LIVE_DISABLED', 'LIVE_REVIEWED'].includes(status.mode)) throw new D2AuditStoreError('CONFLICT');
      const updated = d2EvaluationSchema.parse({ ...evaluation, g3cExecutionId: status.executionId, g3cStatus: status });
      this.db.prepare('UPDATE d2_proposals SET evaluation_json = ? WHERE proposal_id = ?').run(JSON.stringify(updated), proposalId);
      this.db.exec('COMMIT');
      return updated;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve primary failure. */ }
      if (error instanceof D2AuditStoreError) throw error;
      throw new D2AuditStoreError('DATABASE_FAILURE');
    }
  }
  recordSimulation(value: D2Simulation): D2Simulation {
    this.ensureOpen();
    const simulation = d2SimulationSchema.parse(value);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const proposal = this.db.prepare('SELECT proposal_id FROM d2_proposals WHERE proposal_id = ?').get(simulation.proposalId) as Row | undefined;
      if (!proposal) throw new D2AuditStoreError('NOT_FOUND');
      const existing = this.db.prepare('SELECT * FROM d2_simulations WHERE operation_id = ?').get(simulation.operationId) as Row | undefined;
      if (existing) {
        const prior = parseSimulation(existing);
        if (JSON.stringify(prior) !== JSON.stringify(simulation)) throw new D2AuditStoreError('CONFLICT');
        this.db.exec('COMMIT');
        return prior!;
      }
      this.db.prepare('INSERT INTO d2_simulations (operation_id,proposal_id,simulation_json,created_at) VALUES (?,?,?,?)')
        .run(simulation.operationId, simulation.proposalId, JSON.stringify(simulation), simulation.createdAt);
      this.db.exec('COMMIT');
      return simulation;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve primary failure. */ }
      if (error instanceof D2AuditStoreError) throw error;
      throw new D2AuditStoreError('DATABASE_FAILURE');
    }
  }

  getSimulation(proposalId: string, operationId?: string): D2Simulation | null {
    this.ensureOpen();
    if (!/^[0-9a-f-]{36}$/iu.test(proposalId) || (operationId !== undefined && !/^[0-9a-f-]{36}$/iu.test(operationId))) return null;
    try {
      const row = operationId
        ? this.db.prepare('SELECT * FROM d2_simulations WHERE proposal_id = ? AND operation_id = ?').get(proposalId, operationId) as Row | undefined
        : this.db.prepare('SELECT * FROM d2_simulations WHERE proposal_id = ? ORDER BY created_at DESC, operation_id DESC LIMIT 1').get(proposalId) as Row | undefined;
      return parseSimulation(row);
    } catch (error) { if (error instanceof D2AuditStoreError) throw error; throw new D2AuditStoreError('DATABASE_FAILURE'); }
  }

  close(): void {
    if (this.closed) return;
    try { this.db.close(); this.closed = true; }
    catch { throw new D2AuditStoreError('DATABASE_FAILURE'); }
  }

  private ensureOpen(): void { if (this.closed) throw new D2AuditStoreError('CLOSED'); }
}

export function initializeD2AuditStore(input: { readonly databasePath: string }): D2AuditStore {
  const path = validatePath(input.databasePath);
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new D2AuditStoreError('ALREADY_EXISTS');
    throw new D2AuditStoreError('PATH_INVALID');
  }
  closeSync(fd);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(TABLE_SQL);
    db.exec(SIMULATION_SQL);
    installSemanticAssociations(db);
    db.exec('PRAGMA user_version = ' + D2_SCHEMA_VERSION);
    return new D2AuditStore(db);
  } catch {
    try { db?.close(); } catch { /* Preserve failed initialization. */ }
    throw new D2AuditStoreError('DATABASE_FAILURE');
  }
}

export function openD2AuditStore(input: { readonly databasePath: string }): D2AuditStore {
  const path = validatePath(input.databasePath);
  if (!existsSync(path)) throw new D2AuditStoreError('NOT_FOUND');
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys = ON');
    const version = db.prepare('PRAGMA user_version').get() as Row | undefined;
    if (version?.user_version !== 1 && version?.user_version !== 2 && version?.user_version !== D2_SCHEMA_VERSION) throw new D2AuditStoreError('CORRUPT');
    const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'd2_proposals'").get() as Row | undefined;
    if (sql?.sql !== TABLE_SQL) throw new D2AuditStoreError('CORRUPT');
    const simulationSql = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'd2_simulations'").get() as Row | undefined;
    if (simulationSql?.sql !== SIMULATION_SQL) throw new D2AuditStoreError('CORRUPT');
    if (version?.user_version === 1) {
      db.exec('BEGIN IMMEDIATE');
      try {
        installSemanticAssociations(db);
        db.exec('PRAGMA user_version = ' + D2_SCHEMA_VERSION);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* Preserve primary failure. */ }
        throw error;
      }
    } else if (version?.user_version === 2) {
      const associationSql = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'd2_semantic_associations'").get() as Row | undefined;
      if (associationSql?.sql !== SEMANTIC_ASSOCIATIONS_V2_SQL) throw new D2AuditStoreError('CORRUPT');
      validateSemanticAssociationTriggers(db);
      migrateSemanticAssociationsV2(db);
    } else {
      const associationSql = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'd2_semantic_associations'").get() as Row | undefined;
      if (associationSql?.sql !== SEMANTIC_ASSOCIATIONS_SQL) throw new D2AuditStoreError('CORRUPT');
      validateSemanticAssociationTriggers(db);
      for (const sql of SEMANTIC_ASSOCIATION_INDEXES) {
        const name = sql.split(' ')[2]!;
        const index = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?").get(name) as Row | undefined;
        if (index?.sql !== sql) throw new D2AuditStoreError('CORRUPT');
      }
    }
    return new D2AuditStore(db);
  } catch (error) {
    if (error instanceof D2AuditStoreError) throw error;
    throw new D2AuditStoreError('DATABASE_FAILURE');
  }
}

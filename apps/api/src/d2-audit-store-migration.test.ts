import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openD2AuditStore } from './d2-audit-store.js';

const PROPOSALS_SQL = `CREATE TABLE d2_proposals (
  proposal_id TEXT PRIMARY KEY CHECK (length(proposal_id) = 36),
  proposal_json TEXT NOT NULL CHECK (length(proposal_json) <= 524288),
  evaluation_json TEXT CHECK (evaluation_json IS NULL OR length(evaluation_json) <= 524288),
  created_at TEXT NOT NULL
) STRICT`;
const SIMULATIONS_SQL = `CREATE TABLE d2_simulations (
  operation_id TEXT PRIMARY KEY CHECK (length(operation_id) = 36),
  proposal_id TEXT NOT NULL REFERENCES d2_proposals(proposal_id),
  simulation_json TEXT NOT NULL CHECK (length(simulation_json) <= 524288),
  created_at TEXT NOT NULL
) STRICT`;
const V2_ASSOCIATIONS_SQL = `CREATE TABLE d2_semantic_associations (
  proposal_id TEXT PRIMARY KEY REFERENCES d2_proposals(proposal_id),
  attempt_id TEXT NOT NULL UNIQUE CHECK (length(attempt_id) = 36),
  request_hash TEXT NOT NULL UNIQUE CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  evidence_hash TEXT NOT NULL CHECK (length(evidence_hash) = 64 AND evidence_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL
) STRICT`;
const TRIGGERS = [
  "CREATE TRIGGER d2_semantic_associations_no_update BEFORE UPDATE ON d2_semantic_associations BEGIN SELECT RAISE(ABORT, 'append only'); END",
  "CREATE TRIGGER d2_semantic_associations_no_delete BEFORE DELETE ON d2_semantic_associations BEGIN SELECT RAISE(ABORT, 'append only'); END",
];
const proposalId = '00000000-0000-4000-8000-000000000001';
const attemptId = '00000000-0000-4000-8000-000000000002';
const operationId = '00000000-0000-4000-8000-000000000003';
const createdAt = '2026-09-25T12:00:00.000Z';
const proposalJson = JSON.stringify({ fixture: 'synthetic-proposal' });
const evaluationJson = JSON.stringify({ fixture: 'synthetic-evaluation' });
const simulationJson = JSON.stringify({ fixture: 'synthetic-simulation' });
let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });

function createLegacyDatabase(version: 1 | 2): string {
  root = mkdtempSync(join(tmpdir(), 'ered-luin-d2-migration-'));
  const path = join(root, 'legacy.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(PROPOSALS_SQL);
    db.exec(SIMULATIONS_SQL);
    db.prepare('INSERT INTO d2_proposals (proposal_id,proposal_json,evaluation_json,created_at) VALUES (?,?,?,?)')
      .run(proposalId, proposalJson, evaluationJson, createdAt);
    db.prepare('INSERT INTO d2_simulations (operation_id,proposal_id,simulation_json,created_at) VALUES (?,?,?,?)')
      .run(operationId, proposalId, simulationJson, createdAt);
    if (version === 2) {
      db.exec(V2_ASSOCIATIONS_SQL);
      for (const trigger of TRIGGERS) db.exec(trigger);
      db.prepare('INSERT INTO d2_semantic_associations (proposal_id,attempt_id,request_hash,evidence_hash,created_at) VALUES (?,?,?,?,?)')
        .run(proposalId, attemptId, 'a'.repeat(64), 'b'.repeat(64), createdAt);
    }
    db.exec('PRAGMA user_version = ' + version);
    return path;
  } finally { db.close(); }
}

describe('D2 audit schema upgrades', () => {
  it('transactionally migrates a populated v2 store and reopens the upgraded schema', () => {
    const path = createLegacyDatabase(2);
    const migrated = openD2AuditStore({ databasePath: path });
    migrated.close();
    const reopened = openD2AuditStore({ databasePath: path });
    reopened.close();

    const db = new DatabaseSync(path);
    try {
      expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 3 });
      expect(db.prepare('SELECT proposal_id,proposal_json,evaluation_json,created_at FROM d2_proposals').get())
        .toEqual({ proposal_id: proposalId, proposal_json: proposalJson, evaluation_json: evaluationJson, created_at: createdAt });
      expect(db.prepare('SELECT operation_id,proposal_id,simulation_json,created_at FROM d2_simulations').get())
        .toEqual({ operation_id: operationId, proposal_id: proposalId, simulation_json: simulationJson, created_at: createdAt });
      expect(db.prepare('SELECT proposal_id,attempt_id,request_hash,evidence_hash,created_at FROM d2_semantic_associations').get())
        .toEqual({ proposal_id: proposalId, attempt_id: attemptId, request_hash: 'a'.repeat(64), evidence_hash: 'b'.repeat(64), created_at: createdAt });
      expect(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='trigger' AND name LIKE 'd2_semantic_associations_no_%'").get())
        .toMatchObject({ count: 2 });
      expect(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='index' AND name LIKE 'd2_semantic_associations_%'").get())
        .toMatchObject({ count: 2 });
      expect(() => db.prepare('UPDATE d2_semantic_associations SET request_hash = ? WHERE proposal_id = ?').run('c'.repeat(64), proposalId))
        .toThrow();
      expect(() => db.prepare('DELETE FROM d2_semantic_associations WHERE proposal_id = ?').run(proposalId)).toThrow();
    } finally { db.close(); }
  });

  it('upgrades the supported v1 store without changing its proposal, evaluation, or simulation', () => {
    const path = createLegacyDatabase(1);
    const migrated = openD2AuditStore({ databasePath: path });
    migrated.close();
    const reopened = openD2AuditStore({ databasePath: path });
    reopened.close();

    const db = new DatabaseSync(path);
    try {
      expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 3 });
      expect(db.prepare('SELECT proposal_json,evaluation_json FROM d2_proposals WHERE proposal_id = ?').get(proposalId))
        .toEqual({ proposal_json: proposalJson, evaluation_json: evaluationJson });
      expect(db.prepare('SELECT simulation_json FROM d2_simulations WHERE operation_id = ?').get(operationId))
        .toEqual({ simulation_json: simulationJson });
      expect(db.prepare('SELECT count(*) AS count FROM d2_semantic_associations').get()).toMatchObject({ count: 0 });
    } finally { db.close(); }
  });
});

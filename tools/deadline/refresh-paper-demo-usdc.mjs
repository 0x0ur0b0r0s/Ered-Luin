import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireCollectionLock } from '../d2c/collector-lock.mjs';
import { BASE_USDC_PRICE_QUERY, BASE_USDC_PRICE_CACHE_KEY, createNansenClient, createNansenQueryManager, initializeCreditLedger, openNansenObservationStore, NANSEN_COST_PROFILE_VERSION } from '../../packages/nansen/dist/index.js';

const parentId = process.argv[2];
if (!parentId || !/^paper-demo-\d{14}-[a-f0-9]{8}$/u.test(parentId)) throw new Error('PARENT_ALLOCATION_INVALID');
if (!process.env.NANSEN_API_KEY) throw new Error('CREDENTIAL_UNAVAILABLE');
const root = resolve(process.env.LOCALAPPDATA ?? '', 'Ered-Luin', 'paper-demo-allocations');
const parent = resolve(root, parentId);
const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
if (!isAbsolute(parent) || parent.toLowerCase().startsWith(repo.toLowerCase())) throw new Error('EXTERNAL_PATH_INVALID');
const storeId = parentId + '-observations';
const storePath = join(parent, 'observations.sqlite');
const suffix = new Date().toISOString().replaceAll(/[^0-9]/gu, '').slice(0, 14) + '-' + randomUUID().slice(0, 8);
const runId = 'paper-demo-refresh-' + suffix;
const dir = join(root, runId);
mkdirSync(dir, { recursive: false });
const ledger = initializeCreditLedger({ databasePath: join(dir, 'credits.sqlite'), budgetId: runId, limitCredits: 1, costProfileVersion: NANSEN_COST_PROFILE_VERSION });
const attemptsPath = join(dir, 'attempts.jsonl');
const manifestPath = join(dir, 'run-manifest.json');
const lock = acquireCollectionLock(storePath, { runId });
let store;
let dispatches = 0;
const startedAt = new Date().toISOString();
try {
  store = openNansenObservationStore({ databasePath: storePath, storeId });
  const client = createNansenClient({ ledger, enabled: true, apiKey: process.env.NANSEN_API_KEY, maxPages: 1, timeoutMs: 10_000, maxResponseBytes: 1_048_576 });
  const manager = createNansenQueryManager({ client, store, enabled: true, maxPageBound: 1, maxRetryBound: 0,
    beforeDispatch() { if (dispatches >= 1) return 'ATTEMPT_CAP'; dispatches += 1; return null; } });
  const result = await manager.query(BASE_USDC_PRICE_QUERY);
  const refs = result.attemptPageReferences;
  const successes = refs.filter((ref) => ref.received && ref.status !== null && ref.status >= 200 && ref.status < 300).length;
  const persisted = store.getLatestSnapshotByCacheKey(BASE_USDC_PRICE_CACHE_KEY);
  const row = { runId, operation: result.operation, status: result.status, fetchedAt: result.fetchedAt, acquiredAt: result.acquiredAt,
    completeness: result.completeness, httpStatuses: refs.map((ref) => ref.status), providerHttpSuccesses: successes,
    chargedCredits: refs.reduce((sum, ref) => sum + (ref.chargedCredits ?? 0), 0), signalCount: persisted?.signals.length ?? 0,
    failure: result.failure?.code ?? result.storeError ?? result.managerError ?? null };
  appendFileSync(attemptsPath, JSON.stringify(row) + '\n');
  const snap = ledger.getSnapshot();
  const status = successes === 1 && refs.length === 1 && !result.failure && !result.storeError && !result.managerError && persisted ? 'COMPLETE' : 'STOPPED';
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, status, runId, parentRunId: parentId, budgetId: runId, storeId,
    allocation: { maxAttempts: 1, maxCredits: 1, costProfileVersion: NANSEN_COST_PROFILE_VERSION }, startedAt, updatedAt: new Date().toISOString(),
    attempts: dispatches, providerHttpSuccesses: successes, allocatedCredits: snap.allocatedCredits, remainingCredits: snap.remainingCredits,
    pendingAttemptCount: snap.pendingAttemptCount, reconciliationRequired: snap.reconciliationRequired, query: 'BASE_USDC_PRICE_QUERY',
    pageBound: 1, retryBound: 0, attemptsFile: 'attempts.jsonl' }, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ mode: status, runId, attempts: dispatches, providerHttpSuccesses: successes, httpStatuses: row.httpStatuses,
    chargedCredits: row.chargedCredits, storeId, snapshot: persisted ? { snapshotId: persisted.snapshotId, fetchedAt: persisted.fetchedAt,
      acquiredAt: persisted.acquiredAt, expiresAt: persisted.expiresAt, signals: persisted.signals.map((s) => ({ endpoint: s.endpoint,
        asset: s.asset, metric: s.metric, value: s.value, quality: s.quality, observedAt: s.observedAt, fetchedAt: s.fetchedAt,
        provider: s.provider, provenanceId: s.provenanceId })) } : null }) + '\n');
  if (status !== 'COMPLETE') process.exitCode = 1;
} catch (error) {
  const snap = ledger.getSnapshot();
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, status: 'STOPPED', runId, parentRunId: parentId, budgetId: runId, storeId,
    allocation: { maxAttempts: 1, maxCredits: 1, costProfileVersion: NANSEN_COST_PROFILE_VERSION }, startedAt, updatedAt: new Date().toISOString(),
    attempts: dispatches, providerHttpSuccesses: 0, allocatedCredits: snap.allocatedCredits, remainingCredits: snap.remainingCredits,
    pendingAttemptCount: snap.pendingAttemptCount, reconciliationRequired: snap.reconciliationRequired, error: error instanceof Error ? error.message : 'UNKNOWN' }, null, 2) + '\n');
  process.stderr.write(JSON.stringify({ mode: 'STOPPED', runId, attempts: dispatches, error: error instanceof Error ? error.message : 'UNKNOWN' }) + '\n');
  process.exitCode = 1;
} finally {
  try { store?.close(); } catch { /* Preserve durable state. */ }
  try { ledger.close(); } catch { /* Preserve durable accounting. */ }
  lock.release();
}

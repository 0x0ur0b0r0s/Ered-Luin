import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireCollectionLock } from '../d2c/collector-lock.mjs';
import {
  createHistoricalBaseUsdcOhlcvQuery, createNansenClient, createNansenQueryManager,
  initializeCreditLedger, openNansenObservationStore, NANSEN_COST_PROFILE_VERSION,
  NANSEN_OPERATION_COSTS, WETH_RESEARCH_QUERIES,
} from '../../packages/nansen/dist/index.js';

const parentId = process.argv[2];
if (!parentId || !/^paper-demo-\d{14}-[a-f0-9]{8}$/u.test(parentId)) throw new Error('PARENT_ALLOCATION_INVALID');
const PARENT = resolve(process.env.LOCALAPPDATA ?? '', 'Ered-Luin', 'paper-demo-allocations', parentId);
const ROOT = resolve(process.env.LOCALAPPDATA ?? '', 'Ered-Luin', 'paper-demo-allocations');
const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
if (!isAbsolute(PARENT) || PARENT.toLowerCase().startsWith(REPO.toLowerCase())) throw new Error('EXTERNAL_PATH_INVALID');
const storePath = join(PARENT, 'observations.sqlite'), storeId = parentId + '-observations';
const startMs = Date.parse('2026-09-24T10:10:00.000Z');
const windows = Array.from({ length: 197 }, (_, i) => {
  const from = new Date(startMs + i * 600_000);
  return createHistoricalBaseUsdcOhlcvQuery(from, new Date(from.getTime() + 600_000));
});
const remainingWindows = windows.slice(105);
const maxAttempts = remainingWindows.length + 2;
const maxCredits = remainingWindows.length * NANSEN_OPERATION_COSTS.TOKEN_OHLCV +
  NANSEN_OPERATION_COSTS.TOKEN_SCREENER + NANSEN_OPERATION_COSTS.SMART_MONEY_NETFLOW;
if (remainingWindows.length !== 92 || maxAttempts !== 94 || maxCredits !== 98) throw new Error('CONTINUATION_PLAN_INVALID');
if (!process.env.NANSEN_API_KEY) throw new Error('CREDENTIAL_UNAVAILABLE');
if (!existsSync(storePath)) throw new Error('DEMO_STORE_NOT_FOUND');
const suffix = new Date().toISOString().replaceAll(/[^0-9]/gu, '').slice(0, 14) + '-' + randomUUID().slice(0, 8);
const runId = 'paper-demo-segment-' + suffix, dir = join(ROOT, runId);
mkdirSync(dir, { recursive: false });
const budgetId = runId, ledgerPath = join(dir, 'credits.sqlite');
const manifestPath = join(dir, 'run-manifest.json'), attemptsPath = join(dir, 'attempts.jsonl');
const lock = acquireCollectionLock(storePath, { runId });
const ledger = initializeCreditLedger({ databasePath: ledgerPath, budgetId, limitCredits: maxCredits, costProfileVersion: NANSEN_COST_PROFILE_VERSION });
let store, done = 0, successes = 0, responses = 0, lastDispatch = 0;
const startedAt = new Date().toISOString();
const rows = [];
const save = (status) => {
  const s = ledger.getSnapshot();
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, status, runId, parentRunId: parentId, budgetId, storeId,
    allocation: { maxAttempts, maxCredits, costProfileVersion: NANSEN_COST_PROFILE_VERSION },
    startedAt, updatedAt: new Date().toISOString(), attempts: done, providerHttpSuccesses: successes,
    providerResponses: responses, allocatedCredits: s.allocatedCredits, remainingCredits: s.remainingCredits,
    pendingAttemptCount: s.pendingAttemptCount, reconciliationRequired: s.reconciliationRequired,
    previousSegment: { confirmedHttpSuccesses: 105, nonResponseAttemptPreserved: true },
    appPaidNansenEnabled: false, appPaidNansenBudget: 0, liveExecution: false, signing: false,
    browserSubmission: false, rabby: false, attemptsFile: 'attempts.jsonl' }, null, 2) + '\n');
};
try {
  store = openNansenObservationStore({ databasePath: storePath, storeId });
  if (store.getStats().retainedSnapshots < 105) throw new Error('PRIOR_SUCCESS_SNAPSHOTS_MISSING');
  const client = createNansenClient({ ledger, enabled: true, apiKey: process.env.NANSEN_API_KEY, maxPages: 1,
    timeoutMs: 10_000, maxResponseBytes: 1_048_576 });
  const manager = createNansenQueryManager({ client, store, enabled: true, maxPageBound: 1, maxRetryBound: 0,
    beforeDispatch() { if (done >= maxAttempts) return 'ATTEMPT_CAP'; done += 1; return null; } });
  const collect = async (query, label, historical = false) => {
    if (lastDispatch) { const remaining = 2_000 - (Date.now() - lastDispatch); if (remaining > 0) await new Promise((r) => setTimeout(r, remaining)); }
    lastDispatch = Date.now();
    const result = await manager.query(query), refs = result.attemptPageReferences;
    const n = refs.filter((r) => r.received && r.status !== null && r.status >= 200 && r.status < 300).length;
    successes += n; responses += refs.length;
    const persisted = historical ? store.getMostRecentWithObservations(result.cacheKey) : null;
    const row = { index: done, label, operation: result.operation, status: result.status, fetchedAt: result.fetchedAt,
      acquiredAt: result.acquiredAt, completeness: result.completeness, signalCount: result.observations.length,
      httpStatuses: refs.map((r) => r.status), providerHttpSuccesses: n,
      chargedCredits: refs.reduce((sum, r) => sum + (r.chargedCredits ?? 0), 0),
      persistedCompleteness: persisted?.completeness ?? null,
      failure: result.failure?.code ?? result.storeError ?? result.managerError ?? null };
    rows.push(row); appendFileSync(attemptsPath, JSON.stringify(row) + '\n'); save('RUNNING');
    process.stdout.write(JSON.stringify({ progress: done, segmentTarget: maxAttempts, segmentSuccesses: successes,
      combinedSuccesses: 105 + successes, operation: row.operation, status: row.status, httpStatus: refs[0]?.status ?? null }) + '\n');
    const historicalOk = historical && persisted?.source === 'nansen' && persisted.completeness === 'complete' && persisted.failure === null;
    const freshOk = !historical && ['fresh', 'incomplete'].includes(result.status) && result.failure === null &&
      result.storeError === null && result.managerError === null;
    if (refs.length !== 1 || n !== 1 || result.failure || result.storeError || result.managerError ||
        (historical ? !historicalOk : !freshOk)) throw new Error('PROVIDER_RESPONSE_OR_PERSISTENCE_NOT_ACCEPTED');
  };
  for (const q of remainingWindows) await collect(q, 'base-usdc-ohlcv-' + q.date.from, true);
  await collect(WETH_RESEARCH_QUERIES.TOKEN_SCREENER, 'fresh-base-pair-token-screener');
  await collect(WETH_RESEARCH_QUERIES.SMART_MONEY_NETFLOW, 'fresh-base-pair-smart-money-netflow');
  if (done !== maxAttempts || successes !== maxAttempts || responses !== maxAttempts) throw new Error('FINAL_COUNT_MISMATCH');
  save('COMPLETE');
  process.stdout.write(JSON.stringify({ mode: 'COMPLETE', runId, parentRunId: parentId, attempts: done,
    providerHttpSuccesses: successes, combinedProviderHttpSuccesses: 105 + successes, providerResponses: responses,
    allocatedCredits: ledger.getSnapshot().allocatedCredits, remainingCredits: ledger.getSnapshot().remainingCredits, storeId }) + '\n');
} catch (error) {
  try { save('STOPPED'); } catch { /* Preserve ledger and store. */ }
  process.stderr.write(JSON.stringify({ mode: 'STOPPED', runId, attempts: done, providerHttpSuccesses: successes,
    providerResponses: responses, code: error instanceof Error ? error.message : 'UNKNOWN' }) + '\n');
  process.exitCode = 1;
} finally {
  try { store?.close(); } catch { /* Durable records remain. */ }
  try { ledger.close(); } catch { /* Durable ledger remains. */ }
  lock.release();
}

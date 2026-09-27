import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createHistoricalBaseUsdcOhlcvQuery, createNansenClient, createNansenQueryManager,
  initializeCreditLedger, initializeNansenObservationStore, openCreditLedger, openNansenObservationStore,
  NANSEN_COST_PROFILE_VERSION, NANSEN_OPERATION_COSTS, WETH_RESEARCH_QUERIES,
} from '../../packages/nansen/dist/index.js';

const MAX_ATTEMPTS = 199, MAX_CREDITS = 203, GAP_MS = 2_000;
const ROOT = resolve(process.env.LOCALAPPDATA ?? '', 'Ered-Luin', 'paper-demo-allocations');
const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const dryRun = process.argv.includes('--dry-run');
const resumeAt = process.argv.indexOf('--resume');
const resumeId = resumeAt >= 0 ? process.argv[resumeAt + 1] : null;
if (resumeAt >= 0 && (!resumeId || !/^paper-demo-\d{14}-[a-f0-9]{8}$/u.test(resumeId))) throw new Error('RESUME_ID_INVALID');
const startMs = Date.parse('2026-09-24T10:10:00.000Z');
const windows = Array.from({ length: 197 }, (_, i) => {
  const from = new Date(startMs + i * 600_000);
  return createHistoricalBaseUsdcOhlcvQuery(from, new Date(from.getTime() + 600_000));
});
if (windows.length !== 197 || windows.at(-1).date.to !== '2026-09-25T19:00:00.000Z') throw new Error('WINDOW_PLAN_INVALID');
const expectedCalls = windows.length + 2;
const expectedCredits = windows.length * NANSEN_OPERATION_COSTS.TOKEN_OHLCV +
  NANSEN_OPERATION_COSTS.TOKEN_SCREENER + NANSEN_OPERATION_COSTS.SMART_MONEY_NETFLOW;
if (expectedCalls !== MAX_ATTEMPTS || expectedCredits !== MAX_CREDITS) throw new Error('ALLOCATION_PLAN_INVALID');
if (dryRun) {
  process.stdout.write(JSON.stringify({ mode: 'DRY_RUN', calls: expectedCalls, credits: expectedCredits,
    resuming: resumeId !== null, windows: { count: windows.length, first: windows[0].date, last: windows.at(-1).date },
    liveExecution: false, signing: false, browserSubmission: false, rabby: false }) + '\n');
  process.exit(0);
}
if (!process.env.NANSEN_API_KEY || !process.env.NANSEN_API_KEY.length) throw new Error('CREDENTIAL_UNAVAILABLE');
if (!isAbsolute(ROOT) || ROOT.toLowerCase().startsWith(repo.toLowerCase())) throw new Error('EXTERNAL_ROOT_INVALID');
mkdirSync(ROOT, { recursive: true });
const runId = resumeId ?? ('paper-demo-' + new Date().toISOString().replaceAll(/[^0-9]/gu, '').slice(0, 14) + '-' + randomUUID().slice(0, 8));
const runDir = join(ROOT, runId);
if (resumeId === null) {
  if (existsSync(runDir)) throw new Error('ALLOCATION_ALREADY_EXISTS');
  mkdirSync(runDir, { recursive: false });
} else if (!existsSync(runDir)) throw new Error('RESUME_ALLOCATION_NOT_FOUND');
const budgetId = runId, storeId = runId + '-observations';
const ledgerPath = join(runDir, 'credits.sqlite'), storePath = join(runDir, 'observations.sqlite');
const manifestPath = join(runDir, 'run-manifest.json'), attemptsPath = join(runDir, 'attempts.jsonl');
const ledgerOptions = { databasePath: ledgerPath, budgetId, limitCredits: MAX_CREDITS, costProfileVersion: NANSEN_COST_PROFILE_VERSION };
let previous = [];
if (resumeId) {
  if (!existsSync(manifestPath) || !existsSync(attemptsPath)) throw new Error('RESUME_STATE_MISSING');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.runId !== runId || manifest.budgetId !== budgetId || manifest.storeId !== storeId ||
      manifest.allocation?.maxAttempts !== MAX_ATTEMPTS || manifest.allocation?.maxCredits !== MAX_CREDITS ||
      manifest.status !== 'STOPPED') throw new Error('RESUME_IDENTITY_MISMATCH');
  previous = readFileSync(attemptsPath, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}
const ledger = resumeId ? openCreditLedger(ledgerOptions) : initializeCreditLedger(ledgerOptions);
let store, done = previous.length, qualified = previous.reduce((n, item) => n + item.providerHttpSuccesses, 0), captured = previous.length;
let lastRequestAt = 0, startedAt = resumeId ? JSON.parse(readFileSync(manifestPath, 'utf8')).startedAt : new Date().toISOString();
const attempts = [...previous];
const priorByLabel = new Map(previous.map((item) => [item.label, item]));
const save = (status) => {
  const snap = ledger.getSnapshot();
  const data = { schemaVersion: 1, status, runId, budgetId, storeId,
    allocation: { maxAttempts: MAX_ATTEMPTS, maxCredits: MAX_CREDITS, costProfileVersion: NANSEN_COST_PROFILE_VERSION },
    startedAt, updatedAt: new Date().toISOString(), attempts: done, providerHttpSuccesses: qualified,
    providerResponses: captured, allocatedCredits: snap.allocatedCredits, remainingCredits: snap.remainingCredits,
    pendingAttemptCount: snap.pendingAttemptCount, reconciliationRequired: snap.reconciliationRequired,
    attemptsFile: 'attempts.jsonl', config: { collectorNansenEnabled: true, appApiPaidNansenEnabled: false,
      appApiPaidNansenBudget: 0, executionMode: 'paper', liveExecution: false, signing: false, browserSubmission: false, rabby: false } };
  writeFileSync(manifestPath, JSON.stringify(data, null, 2) + '\n');
};
try {
  store = resumeId ? openNansenObservationStore({ databasePath: storePath, storeId }) :
    initializeNansenObservationStore({ databasePath: storePath, storeId });
  const snap = ledger.getSnapshot();
  if (snap.pendingAttemptCount || snap.reconciliationRequired || snap.remainingCredits > MAX_CREDITS ||
      snap.allocatedCredits !== previous.reduce((n, item) => n + item.chargedCredits, 0)) throw new Error('LEDGER_RESUME_RECONCILIATION_REQUIRED');
  if (previous.some((item) => item.providerHttpSuccesses !== 1 || !item.httpStatuses.some((s) => s >= 200 && s < 300))) {
    throw new Error('PRIOR_ATTEMPT_NOT_SUCCESSFUL; NO_REDISPATCH');
  }
  const client = createNansenClient({ ledger, enabled: true, apiKey: process.env.NANSEN_API_KEY,
    timeoutMs: 10_000, maxResponseBytes: 1_048_576, maxPages: 1 });
  const manager = createNansenQueryManager({ client, store, enabled: true, maxPageBound: 1, maxRetryBound: 0,
    beforeDispatch() { if (done >= MAX_ATTEMPTS) return 'PAPER_DEMO_ATTEMPT_CAP'; done += 1; return null; } });
  const runQuery = async (query, label, historical = false) => {
    const completed = priorByLabel.get(label);
    if (completed) return;
    const elapsed = Date.now() - lastRequestAt;
    if (lastRequestAt && elapsed < GAP_MS) await new Promise((r) => setTimeout(r, GAP_MS - elapsed));
    lastRequestAt = Date.now();
    const result = await manager.query(query), refs = result.attemptPageReferences;
    const httpSuccess = refs.filter((r) => r.received && r.status !== null && r.status >= 200 && r.status < 300).length;
    qualified += httpSuccess; captured += refs.length;
    const persisted = historical ? store.getMostRecentWithObservations(result.cacheKey) : null;
    const attempt = { index: done, label, operation: result.operation, status: result.status,
      fetchedAt: result.fetchedAt, acquiredAt: result.acquiredAt, completeness: result.completeness,
      signalCount: result.observations.length, httpStatuses: refs.map((r) => r.status),
      providerHttpSuccesses: httpSuccess, chargedCredits: refs.reduce((n, r) => n + (r.chargedCredits ?? 0), 0),
      persistedCompleteness: persisted?.completeness ?? null, failure: result.failure?.code ?? result.storeError ?? result.managerError ?? null };
    attempts.push(attempt);
    appendFileSync(attemptsPath, JSON.stringify(attempt) + '\n');
    save('RUNNING');
    process.stdout.write(JSON.stringify({ progress: done, successes: qualified, target: MAX_ATTEMPTS,
      operation: result.operation, status: result.status, httpStatus: refs[0]?.status ?? null }) + '\n');
    const historicalOk = historical && persisted?.source === 'nansen' && persisted.completeness === 'complete' && persisted.failure === null;
    const currentOk = !historical && result.status === 'fresh' && result.completeness === 'complete' &&
      result.observations.some((s) => s.quality === 'COMPLETE' && s.value !== null);
    if (refs.length !== 1 || httpSuccess !== 1 || result.failure || result.storeError || result.managerError ||
        (historical ? !historicalOk : !currentOk)) throw new Error('PROVIDER_RESPONSE_OR_PERSISTENCE_NOT_ACCEPTED');
  };
  for (const q of windows) await runQuery(q, 'base-usdc-ohlcv-' + q.date.from, true);
  await runQuery(WETH_RESEARCH_QUERIES.TOKEN_SCREENER, 'fresh-base-pair-token-screener');
  await runQuery(WETH_RESEARCH_QUERIES.SMART_MONEY_NETFLOW, 'fresh-base-pair-smart-money-netflow');
  if (done !== MAX_ATTEMPTS || qualified !== MAX_ATTEMPTS || captured !== MAX_ATTEMPTS) throw new Error('FINAL_COUNT_MISMATCH');
  save('COMPLETE');
  process.stdout.write(JSON.stringify({ mode: 'COMPLETE', runId, providerHttpSuccesses: qualified,
    attempts: done, providerResponses: captured, allocatedCredits: ledger.getSnapshot().allocatedCredits,
    remainingCredits: ledger.getSnapshot().remainingCredits, storeId }) + '\n');
} catch (error) {
  try { save('STOPPED'); } catch { /* Preserve the ledger if manifest update fails. */ }
  process.stderr.write(JSON.stringify({ mode: 'STOPPED', attempts: done, providerHttpSuccesses: qualified,
    providerResponses: captured, code: error instanceof Error ? error.message : 'UNKNOWN' }) + '\n');
  process.exitCode = 1;
} finally {
  try { store?.close(); } catch { /* Best-effort close; durable state remains on disk. */ }
  try { ledger.close(); } catch { /* Best-effort close; durable state remains on disk. */ }
}

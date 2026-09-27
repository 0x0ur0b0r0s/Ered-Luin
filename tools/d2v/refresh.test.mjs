import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NANSEN_COST_PROFILE_VERSION, initializeCreditLedger, initializeNansenObservationStore, openCreditLedger,
} from '../../packages/nansen/dist/index.js';
import { D2C_CONFIG_KEYS } from '../d2c/preflight.mjs';
import { D2U_RUN_ID } from '../d2u/diagnostic.mjs';
import { acquireCollectionLock } from '../d2c/collector-lock.mjs';

const roots = new Set();
const root = () => { const path = mkdtempSync(join(tmpdir(), 'ered-d2v-refresh-')); roots.add(path); return path; };
afterEach(() => { for (const path of roots) rmSync(path, { recursive: true, force: true }); roots.clear(); });

function fixture(base, budgetId = 'synthetic-budget', maxCredits = 3, maxAttempts = 3) {
  const local = join(base, 'local'), privateRoot = join(local, 'Ered-Luin');
  const allocationDir = join(privateRoot, 'd2v-usdc-refresh', budgetId), originalDir = join(privateRoot, D2U_RUN_ID);
  const storePath = join(base, 'observations.sqlite'), storeId = 'synthetic-shared-store';
  mkdirSync(allocationDir, { recursive: true }); mkdirSync(originalDir, { recursive: true });
  const template = JSON.parse(readFileSync(new URL('../d2c/local-config.example.json', import.meta.url), 'utf8')).environment;
  writeFileSync(join(privateRoot, 'd2c-local.json'), JSON.stringify({ schemaVersion: 1, environment: { ...template } }));
  const validationDir = join(privateRoot, 'nansen-validation-20260925-01'); mkdirSync(validationDir);
  const validationLedger = join(validationDir, 'credits.sqlite');
  initializeCreditLedger({ databasePath: validationLedger, budgetId: 'nansen-validation-20260925-01', limitCredits: 7,
    costProfileVersion: NANSEN_COST_PROFILE_VERSION }).close();
  const validation = { ...template, NANSEN_LEDGER_PATH: validationLedger, NANSEN_LEDGER_BUDGET_ID: 'nansen-validation-20260925-01',
    NANSEN_LEDGER_LIMIT_CREDITS: '7', NANSEN_OBSERVATION_STORE_PATH: storePath, NANSEN_OBSERVATION_STORE_ID: storeId };
  writeFileSync(join(validationDir, 'collection.json'), JSON.stringify({ schemaVersion: 1, environment: validation }));
  initializeNansenObservationStore({ databasePath: storePath, storeId }).close();

  const originalLedger = join(originalDir, 'credits.sqlite');
  const old = initializeCreditLedger({ databasePath: originalLedger, budgetId: D2U_RUN_ID, limitCredits: 3, costProfileVersion: NANSEN_COST_PROFILE_VERSION });
  for (const [i, operation] of ['TOKEN_SCREENER', 'TOKEN_SCREENER', 'TOKEN_OHLCV'].entries()) {
    const attemptId = 'completed-old-' + i;
    old.reserveAttempt({ attemptId, operation, requestFingerprint: String(i + 1).repeat(64) });
    old.recordTerminalResult({ attemptId, outcome: 'SUCCESS', httpStatus: 200, providerRequestId: 'synthetic-old-' + i, chargedCredits: 1 });
  }
  old.close();
  const originalMarker = join(originalDir, 'ohlcv-run.marker.json');
  writeFileSync(originalMarker, '{"schemaVersion":1,"preserve":"completed-original-diagnostic"}\n');
  writeFileSync(join(originalDir, 'ohlcv-attempt.marker.json.3'), '{"sequence":3}\n');

  const refreshLedger = join(allocationDir, 'credits.sqlite');
  initializeCreditLedger({ databasePath: refreshLedger, budgetId, limitCredits: maxCredits, costProfileVersion: NANSEN_COST_PROFILE_VERSION }).close();
  const environment = { ...template, NANSEN_API_ENABLED: 'true', NANSEN_COLLECTION_REVIEWED: 'true', NANSEN_COLLECTION_ENABLED: 'true',
    NANSEN_CREDIT_BUDGET: String(maxCredits), NANSEN_LEDGER_PATH: refreshLedger, NANSEN_LEDGER_BUDGET_ID: budgetId,
    NANSEN_LEDGER_LIMIT_CREDITS: String(maxCredits), NANSEN_OBSERVATION_STORE_PATH: storePath, NANSEN_OBSERVATION_STORE_ID: storeId };
  expect(Object.keys(environment).sort()).toEqual([...D2C_CONFIG_KEYS].sort());
  const configPath = join(allocationDir, 'refresh.json');
  writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, allocation: { budgetId, maxAttempts, maxCredits }, environment }, null, 2));
  return { local, privateRoot, allocationDir, configPath, storePath, originalMarker, originalLedger, refreshLedger, budgetId, maxCredits };
}
const runner = fileURLToPath(new URL('./run-refresh.mjs', import.meta.url));
function invoke(f, args, extra = {}) {
  return spawnSync(process.execPath, [runner, '--config', f.configPath, '--invocation-id', ...args], {
    encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: f.local, NANSEN_API_KEY: '', ...extra },
  });
}
function fakeProvider(f, mode = 'valid') {
  const bootstrap = join(f.allocationDir, 'fake-provider-' + mode + '.mjs');
  const counter = join(f.allocationDir, 'provider-calls.txt');
  const json = mode === 'malformed'
    ? "{ chain:'base', token_address:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', timeframe:'1m', data:[] }"
    : "{ chain:'base', token_address:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', timeframe:'1m', data:[{ interval_start:new Date(to-120000).toISOString(), close:1.0001, market_cap:{ close:99000 } }] }";
  const body = mode === 'throw' ? "throw new Error(process.env.NANSEN_API_KEY)" :
    "return new Response(JSON.stringify(" + json + "),{status:200,headers:{'content-type':'application/json','x-request-id':'refresh-offline','x-nansen-credits-used':'1'}})";
  const nl = String.fromCharCode(10);
  writeFileSync(bootstrap, "import { appendFileSync } from 'node:fs';" + nl +
    "const to=Math.floor(Date.now()/60000)*60000;" + nl +
    "globalThis.fetch=async()=>{appendFileSync(process.env.FAKE_COUNTER,'x');" + body + '};' + nl);
  return { bootstrap, counter };
}function dispatchOffline(f, invocationId, provider, key = 'synthetic-secret-never-print') {
  return spawnSync(process.execPath, ['--import', pathToFileURL(provider.bootstrap).href, runner, '--config', f.configPath,
    '--invocation-id', invocationId, '--dispatch'], { encoding: 'utf8',
    env: { ...process.env, LOCALAPPDATA: f.local, FAKE_COUNTER: provider.counter, NANSEN_API_KEY: key } });
}
function seedAttempts(f, { count = 1, outcome = 'SUCCESS', charge = 1 } = {}) {
  const ledger = openCreditLedger({ databasePath: f.refreshLedger, budgetId: f.budgetId, limitCredits: f.maxCredits,
    costProfileVersion: NANSEN_COST_PROFILE_VERSION });
  for (let i = 0; i < count; i += 1) {
    const attemptId = 'seed-attempt-' + i;
    ledger.reserveAttempt({ attemptId, operation: 'TOKEN_OHLCV', requestFingerprint: String(i + 1).repeat(64) });
    if (outcome !== 'PENDING') ledger.recordTerminalResult({ attemptId, outcome, httpStatus: outcome === 'SUCCESS' ? 200 : null,
      providerRequestId: outcome === 'SUCCESS' ? 'synthetic-settled' : null, chargedCredits: charge });
    writeFileSync(join(f.allocationDir, 'refresh-seed-' + i + '.dispatch.json'),
      JSON.stringify({ schemaVersion: 1, operation: 'TOKEN_OHLCV', attemptId }));
    writeFileSync(join(f.allocationDir, 'refresh-seed-' + i + '.invocation.json'), '{}');
  }
  ledger.close();
}

describe('D2v operational refresh CLI', () => {
  it('uses a distinct allocation, preserves the completed diagnostic, and dispatches at most once before cache reuse', () => {
    const f = fixture(root()), markerBefore = readFileSync(f.originalMarker), oldLedgerBefore = readFileSync(f.originalLedger);
    const newLedgerBefore = readFileSync(f.refreshLedger);
    const dry = invoke(f, ['dry-one', '--dry-run']);
    expect(dry.status).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({ mode: 'DRY_RUN', providerCalls: 0, credentialRead: false, persistentWrite: false,
      allocation: { budgetId: 'synthetic-budget', remainingCredits: 3 } });
    expect(readFileSync(f.originalMarker)).toEqual(markerBefore);
    expect(readFileSync(f.originalLedger)).toEqual(oldLedgerBefore);
    expect(readFileSync(f.refreshLedger)).toEqual(newLedgerBefore);

    const provider = fakeProvider(f);
    const sent = dispatchOffline(f, 'offline-live-one', provider);
    expect(sent.status).toBe(0);
    expect(sent.stdout + sent.stderr).not.toContain('synthetic-secret-never-print');
    const sentReport = JSON.parse(sent.stdout);
    expect(sentReport).toMatchObject({ status: 'PRICE_USABLE', dispatches: 1, transportAttempts: 1,
      accounting: { allocatedCredits: 1, remainingCredits: 2, unknownChargeAttempts: 0 }, rawCapture: { status: 'CAPTURED' } });
    expect(readFileSync(provider.counter, 'utf8')).toBe('x');
    expect(readFileSync(f.originalMarker)).toEqual(markerBefore);
    expect(readFileSync(f.originalLedger)).toEqual(oldLedgerBefore);

    const cache = invoke(f, ['offline-cache-two', '--dispatch']);
    expect(cache.status).toBe(0);
    expect(JSON.parse(cache.stdout)).toMatchObject({ status: 'CACHE_HIT_USABLE', dispatches: 0, transportAttempts: 0, cacheHit: true });
    const ledger = openCreditLedger({ databasePath: f.refreshLedger, budgetId: f.budgetId, limitCredits: 3, costProfileVersion: NANSEN_COST_PROFILE_VERSION });
    expect(ledger.getSnapshot().reportedChargeCount).toBe(1); ledger.close();
    const reused = invoke(f, ['offline-live-one', '--dispatch']);
    expect(reused.status).toBe(1);
    expect(reused.stderr).toContain('D2V_REFRESH_INVOCATION_REUSED');
    expect(readFileSync(provider.counter, 'utf8')).toBe('x');
  });

  it('rejects occupied shared-store locks before dispatch, even when ledgers differ', () => {
    const f = fixture(root()), lock = acquireCollectionLock(f.storePath, { runId: 'synthetic-existing-collector' });
    const provider = fakeProvider(f);
    try {
      const result = dispatchOffline(f, 'busy-attempt', provider, 'synthetic-key');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('D2V_REFRESH_STORE_LOCKED');
      expect(existsSync(provider.counter)).toBe(false);
    } finally { lock.release(); }
  });

  it('rejects the exhausted original allocation and conflicting observation-store identity', () => {
    const original = fixture(root(), D2U_RUN_ID);
    const old = invoke(original, ['wrong-budget', '--dry-run']);
    expect(old.status).toBe(1);
    expect(old.stderr).toContain('D2V_REFRESH_ORIGINAL_ALLOCATION_REJECTED');

    const changed = fixture(root());
    const config = JSON.parse(readFileSync(changed.configPath, 'utf8'));
    config.environment.NANSEN_OBSERVATION_STORE_ID = 'different-store';
    writeFileSync(changed.configPath, JSON.stringify(config));
    const conflict = invoke(changed, ['wrong-store', '--dry-run']);
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toContain('D2V_REFRESH_ORIGINAL_ALLOCATION_REJECTED');
  });

  it('rejects insufficient budget, pending or unknown charges, and halted accounting before dispatch', () => {
    const insufficient = fixture(root(), 'budget-two', 2, 3);
    seedAttempts(insufficient, { count: 2 });
    const noBudget = invoke(insufficient, ['no-budget', '--dry-run']);
    expect(noBudget.status).toBe(1);
    expect(noBudget.stderr).toContain('D2V_REFRESH_BUDGET_INSUFFICIENT');

    for (const outcome of ['PENDING', 'TRANSPORT_ERROR', 'OVERRUN']) {
      const f = fixture(root(), 'state-' + outcome.toLowerCase());
      const seed = outcome === 'OVERRUN' ? { count: 1, outcome: 'SUCCESS', charge: 2 } :
        outcome === 'PENDING' ? { count: 1, outcome: 'PENDING' } :
          { count: 1, outcome: 'TRANSPORT_ERROR', charge: null };
      seedAttempts(f, seed);
      const result = invoke(f, ['blocked-' + outcome.toLowerCase(), '--dry-run']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(outcome === 'OVERRUN' ? 'D2V_REFRESH_LEDGER_INVALID' : 'D2V_REFRESH_ACCOUNTING_RECONCILIATION_REQUIRED');
    }
  });

  it('keeps an uncertain charge reserved, hides synthetic secret text, and blocks a second dispatch', () => {
    const f = fixture(root()), provider = fakeProvider(f, 'throw');
    const first = dispatchOffline(f, 'uncertain-one', provider, 'synthetic-secret-in-error');
    expect(first.status).toBe(0);
    expect(first.stdout + first.stderr).not.toContain('synthetic-secret-in-error');
    expect(readFileSync(provider.counter, 'utf8')).toBe('x');
    const next = dispatchOffline(f, 'uncertain-two', provider, 'synthetic-secret-in-error');
    expect(next.status).toBe(1);
    expect(next.stderr).toContain('D2V_REFRESH_ACCOUNTING_RECONCILIATION_REQUIRED');
    expect(next.stdout + next.stderr).not.toContain('synthetic-secret-in-error');
    expect(readFileSync(provider.counter, 'utf8')).toBe('x');
  });
});

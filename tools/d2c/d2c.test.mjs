import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createD2cPreflightReport, D2C_CONFIG_KEYS, parseD2cConfig } from './preflight.mjs';
import { D2C_COLLECTION_QUERIES, runD2cCollection } from './collection-plan.mjs';
import { safeCliFailureCode } from './manual-collect.mjs';
import { acquireCollectionLock } from './collector-lock.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const LOCK_WORKER = join(ROOT, 'tools/d2c/collector-lock-worker.synthetic.mjs');
let directories = [];
async function waitForFile(path, timeoutMs = 8_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('barrier timed out: ' + path);
}
async function waitForWorkerResult(worker) {
  const until = Date.now() + 8_000;
  while (Date.now() < until) {
    for (const name of ['acquired', 'failed']) {
      const path = join(worker.eventDirectory, worker.role + '-' + name + '.json');
      if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('worker result timed out: ' + worker.role);
}
function startLockWorker(directory, ledgerPath, role, { observationStorePath = ledgerPath, pauseRename = false } = {}) {
  const eventDirectory = join(directory, 'events');
  const controlDirectory = join(directory, 'controls');
  const child = spawn(process.execPath, [LOCK_WORKER, ledgerPath, observationStorePath, role, role, eventDirectory, controlDirectory, String(pauseRename)], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return {
    child, role, eventDirectory, controlDirectory, get stderr() { return stderr; },
    signal(name) {
      const path = join(controlDirectory, role + '-' + name);
      if (!existsSync(path)) writeFileSync(path, 'released by test barrier', { flag: 'wx' });
    },
  };
}
async function cleanupLockWorkers(workers) {
  for (const worker of workers) for (const signal of ['acquire', 'continue-rename', 'release']) worker.signal(signal);
  await Promise.all(workers.map(async (worker) => {
    if (worker.child.exitCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 500);
      worker.child.once('close', () => { clearTimeout(timer); resolve(); });
    });
    if (worker.child.exitCode === null) worker.child.kill();
  }));
}
function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'ered-luin-d2c-test-'));
  directories.push(directory);
  return directory;
}
function exampleEnvironment() {
  return JSON.parse(readFileSync(new URL('./local-config.example.json', import.meta.url), 'utf8')).environment;
}
function completeConfig(directory) {
  const environment = { ...exampleEnvironment(), D2_OPERATOR_SECRET: 'D'.repeat(43) };
  expect(Object.keys(environment).sort()).toEqual([...D2C_CONFIG_KEYS].sort());
  for (const name of ['PAPER_STATE_PATH', 'NANSEN_OBSERVATION_STORE_PATH', 'D2_AUDIT_STORE_PATH']) {
    const path = join(directory, name + '.sqlite');
    writeFileSync(path, 'synthetic temporary path fixture');
    environment[name] = path;
  }
  environment.NANSEN_OBSERVATION_STORE_ID = 'synthetic-observation-store';
  const config = { schemaVersion: 1, environment };
  const configPath = join(directory, 'd2c-local.json');
  writeFileSync(configPath, JSON.stringify(config));
  return { config, configPath, environment };
}
function providerReference(attemptId, status = 200, received = true) {
  return { attemptId, page: 1, retry: 0, received, status, chargedCredits: status === 200 ? 1 : null };
}
function managedResult(status, overrides = {}) {
  const cached = status === 'cached';
  const successful = status === 'fresh';
  return {
    cacheKey: 'a'.repeat(64), operation: 'TOKEN_SCREENER', asset: 'BASE_PAIR', timeframe: '1h',
    pageBound: 1, retryBound: 0, status, source: 'nansen', fetchedAt: '2026-09-24T20:00:00.000Z',
    acquiredAt: '2026-09-24T20:00:00.000Z', ageMs: 0,
    completeness: status === 'incomplete' || status === 'failed' ? 'incomplete' : 'complete',
    quality: status === 'incomplete' || status === 'failed' ? 'PARTIAL' : 'COMPLETE',
    observations: [], failure: status === 'failed' ? { code: 'TIMEOUT', status: null, ledgerCode: null } : null,
    storeError: null, managerError: null,
    pageReferences: cached ? [providerReference('historical-attempt')] : successful || status === 'failed' || status === 'incomplete'
      ? [providerReference('current-attempt', status === 'fresh' ? 200 : null, status === 'fresh')] : [],
    attemptPageReferences: cached ? [] : successful || status === 'failed' || status === 'incomplete'
      ? [providerReference('current-attempt', status === 'fresh' ? 200 : null, status === 'fresh')] : [],
    cacheHit: cached, coalesced: false, qualifyingSuccessfulRequests: successful ? 1 : 0,
    ...overrides,
  };
}
function collectionEnvironment(directory) {
  return {
    NANSEN_COLLECTION_REVIEWED: 'true', NANSEN_COLLECTION_ENABLED: 'true', NANSEN_API_ENABLED: 'true',
    NANSEN_CREDIT_BUDGET: '7', NANSEN_LEDGER_LIMIT_CREDITS: '7', NANSEN_API_KEY: 'SYNTHETIC_API_KEY',
    NANSEN_LEDGER_PATH: join(directory, 'synthetic-ledger.sqlite'),
    NANSEN_LEDGER_BUDGET_ID: 'synthetic-budget', NANSEN_COST_PROFILE_VERSION: 'nansen-2026-09-22-v1',
    NANSEN_OBSERVATION_STORE_PATH: join(directory, 'synthetic-observations.sqlite'),
    NANSEN_OBSERVATION_STORE_ID: 'synthetic-store',
  };
}
function collectionDependencies(results) {
  const queries = [];
  let index = 0;
  const ledger = { getSnapshot: () => ({ allocatedCredits: 0, pendingAttemptCount: 0, reconciliationRequired: false }),
    listUnknownChargeAttempts: () => [], close: vi.fn() };
  const store = { close: vi.fn() };
  const manager = { query: vi.fn(async (query) => { queries.push(query); return results[index++]; }) };
  return {
    queries, manager, ledger, store,
    dependencies: {
      openLedger: vi.fn(() => ledger), openStore: vi.fn(() => store),
      createClient: vi.fn(() => ({})), createManager: vi.fn(() => manager),
    },
  };
}
function runManualCollectionCli(args, extraEnvironment = {}) {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'USERPROFILE', 'APPDATA']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, extraEnvironment);
  return spawnSync(process.execPath, [join(ROOT, 'tools', 'd2c', 'manual-collect.mjs'), ...args], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 15_000,
  });
}
afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories = [];
});

describe('D2c deterministic preflight and bounded collection plan', () => {
  it('passes the external config directly to the preflight CLI from the PowerShell launcher', () => {
    const launcher = readFileSync(new URL('./start-local.ps1', import.meta.url), 'utf8');
    expect(launcher).toContain("$preflightArgs = @('exec', 'node', 'tools/d2c/preflight.mjs', '--config', $ConfigPath)");
    expect(launcher).toContain('$preflightOutput = & $launcherPath @preflightArgs');
    expect(launcher).toContain("$preflightArgs += '--allow-typesafe-analysis'");
    expect(launcher).not.toContain("'d2c:preflight', '--',");
  });

  it('reports missing and invalid configuration without enabling provider or execution activity', () => {
    const missing = createD2cPreflightReport({ runtime: 'v24.20.0', pnpmUserAgent: 'pnpm/11.25.0 node/v24.20.0' });
    expect(missing).toMatchObject({ mode: 'ZERO_CALL_PREFLIGHT', providerCalls: 0, secretDecryption: 0,
      signerInvocations: 0, broadcastInvocations: 0, stateMutation: false, safeToStartLocal: false, liveRehearsalReady: false });
    expect(missing.checks.every((check) => ['PASS', 'FAIL', 'NOT_VERIFIED'].includes(check.status))).toBe(true);
    const invalid = parseD2cConfig({ schemaVersion: 1, environment: { NODE_ENV: 'development', UNKNOWN: 'value' } });
    expect(invalid).toBeNull();
    const legacyEnvironment = { ...exampleEnvironment() };
    delete legacyEnvironment.D2_G1D_ANALYSIS_ENABLED;
    expect(parseD2cConfig({ schemaVersion: 1, environment: legacyEnvironment }).D2_G1D_ANALYSIS_ENABLED).toBe('false');
    const internalPath = createD2cPreflightReport({ configValue: { schemaVersion: 1, environment: { ...exampleEnvironment() } },
      configPath: join(ROOT, 'tools', 'd2c', 'local-config.example.json'), runtime: 'v24.20.0', pnpmUserAgent: 'pnpm/11.25.0 node/v24.20.0' });
    expect(internalPath.checks.find((check) => check.name === 'local configuration')?.status).toBe('FAIL');
  });

  it('accepts safe temporary external config, redacts secrets and paths, and leaves unverified readiness explicit', () => {
    const directory = temporaryDirectory();
    const { config, configPath, environment } = completeConfig(directory);
    const secret = environment.D2_OPERATOR_SECRET;
    const report = createD2cPreflightReport({ configValue: config, configPath, runtime: 'v24.20.2',
      pnpmUserAgent: 'pnpm/11.25.0 npm/? node/v24.20.2 win32 x64' });
    expect(report.safeToStartLocal).toBe(true);
    expect(report.liveRehearsalReady).toBe(false);
    expect(report.checks.find((check) => check.name === 'local configuration')?.status).toBe('PASS');
    expect(report.checks.find((check) => check.name === 'external durable paths')?.status).toBe('PASS');
    expect(report.checks.find((check) => check.name === 'independent execution gates')?.status).toBe('PASS');
    expect(report.checks.find((check) => check.name === 'signer and custody')?.status).toBe('NOT_VERIFIED');
    expect(report.checks.find((check) => check.name === 'wallet inputs')?.status).toBe('NOT_VERIFIED');
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain(directory);
    expect(JSON.stringify(report)).not.toContain('NANSEN_API_KEY');

    const analysisEnabled = { ...config, environment: { ...environment, D2_G1D_ANALYSIS_ENABLED: 'true' } };
    const analysisReport = createD2cPreflightReport({ configValue: analysisEnabled, configPath, runtime: 'v24.20.2',
      pnpmUserAgent: 'pnpm/11.25.0 node/v24.20.2' });
    expect(analysisReport.safeToStartLocal).toBe(false);
    expect(analysisReport.checks.find((check) => check.name === 'independent execution gates')?.status).toBe('FAIL');

    const shadowPath = join(directory, 'g1d-shadow.sqlite');
    writeFileSync(shadowPath, 'synthetic temporary path fixture');
    const analysisReady = { ...analysisEnabled, environment: { ...analysisEnabled.environment,
      G1D_SHADOW_AUDIT_STORE_PATH: shadowPath, G1D_SHADOW_AUDIT_STORE_ID: 'synthetic-g1d-shadow' } };
    const analysisOptIn = createD2cPreflightReport({ configValue: analysisReady, configPath, allowTypeSafeAnalysis: true,
      runtime: 'v24.20.2', pnpmUserAgent: 'pnpm/11.25.0 node/v24.20.2' });
    expect(analysisOptIn).toMatchObject({ safeToStartLocal: true, providerCalls: 0, secretDecryption: 0,
      signerInvocations: 0, broadcastInvocations: 0, freshTypeSafeAnalysisInvocationEnabled: true });
    expect(analysisOptIn.checks.find((check) => check.name === 'independent execution gates')?.status).toBe('PASS');

    const unsafe = { ...config, environment: { ...environment, D2_SIGNING_ENABLED: 'true' } };
    const unsafeReport = createD2cPreflightReport({ configValue: unsafe, configPath, runtime: 'v24.20.2',
      pnpmUserAgent: 'pnpm/11.25.0 node/v24.20.2' });
    expect(unsafeReport.safeToStartLocal).toBe(false);
    expect(unsafeReport.checks.find((check) => check.name === 'independent execution gates')?.status).toBe('FAIL');
  });

  it('keeps the manual collection dry-run exact and reads no environment or credentials', async () => {
    const environment = vi.fn(() => { throw new Error('DRY_RUN_READ_ENVIRONMENT'); });
    const report = await runD2cCollection({ mode: 'dry-run', environment });
    expect(environment).not.toHaveBeenCalled();
    expect(report).toMatchObject({ mode: 'DRY_RUN', providerCalls: 0, credentialRead: false,
      plan: { maximumAttempts: 3, maximumEstimatedCredits: 7 } });
    expect(D2C_COLLECTION_QUERIES).toEqual([
      { operation: 'TOKEN_SCREENER', asset: 'BASE_PAIR', timeframe: '1h', pageBound: 1, retryBound: 0, perPage: 100, estimatedCredits: 1 },
      { operation: 'FLOW_INTELLIGENCE', asset: 'WETH', timeframe: '1h', pageBound: 1, retryBound: 0, perPage: 1, estimatedCredits: 1 },
      { operation: 'SMART_MONEY_NETFLOW', asset: 'BASE_PAIR', timeframe: '1h', pageBound: 1, retryBound: 0, perPage: 100, estimatedCredits: 5 },
    ]);
  });

  it('refuses collection before reading credentials or opening stores while default gates are off', async () => {
    const reads = [];
    const openLedger = vi.fn();
    const openStore = vi.fn();
    const report = { openLedger, openStore, createClient: vi.fn(), createManager: vi.fn() };
    await expect(runD2cCollection({ mode: 'collect', environment(key) {
      reads.push(key);
      return key === 'NANSEN_API_ENABLED' ? 'false' : 'false';
    }, dependencies: report })).rejects.toThrow('COLLECTION_REQUIRES_SEPARATE_REVIEW_AND_EXPLICIT_ENABLEMENT');
    expect(reads).toEqual(['NANSEN_COLLECTION_REVIEWED', 'NANSEN_COLLECTION_ENABLED', 'NANSEN_API_ENABLED']);
    expect(reads).not.toContain('NANSEN_API_KEY');
    expect(openLedger).not.toHaveBeenCalled();
    expect(openStore).not.toHaveBeenCalled();
  });

  it('does not accept an enabled G1d handoff without a paired external audit store', () => {
    const directory = temporaryDirectory();
    const { config, configPath, environment } = completeConfig(directory);
    const enabled = { ...config, environment: { ...environment, D2_G1D_ANALYSIS_HANDOFF_ENABLED: 'true' } };
    const report = createD2cPreflightReport({ configValue: enabled, configPath, runtime: 'v24.20.2',
      pnpmUserAgent: 'pnpm/11.25.0 node/v24.20.2' });
    expect(report.checks.find((check) => check.name === 'external durable paths')?.status).toBe('FAIL');
    expect(report.safeToStartLocal).toBe(false);
  });
  it('serializes two-process stale recovery so a stale observation cannot move the new live owner', async () => {
    const directory = temporaryDirectory();
    const eventDirectory = join(directory, 'events');
    const controlDirectory = join(directory, 'controls');
    mkdirSync(eventDirectory); mkdirSync(controlDirectory);
    const ledgerPath = join(directory, 'ledger.sqlite');
    writeFileSync(ledgerPath, 'synthetic external ledger path');
    const lockPath = ledgerPath + '.collector.lock';
    writeFileSync(lockPath, JSON.stringify({ schemaVersion: 1, runId: 'stale-owner', pid: 2_147_483_647,
      startedAt: new Date().toISOString(), nonce: 'stale-nonce' }));
    const observer = startLockWorker(directory, ledgerPath, 'observer', { pauseRename: true });
    const contender = startLockWorker(directory, ledgerPath, 'contender');
    const workers = [observer, contender];
    try {
      await Promise.all(workers.map((worker) => waitForFile(join(eventDirectory, worker.role + '-ready.json'))));
      observer.signal('acquire');
      await waitForFile(join(eventDirectory, 'observer-rename-paused.json'));
      contender.signal('acquire');
      const contenderResult = await waitForWorkerResult(contender);
      observer.signal('continue-rename');
      const observerResult = await waitForWorkerResult(observer);

      expect(contenderResult).toMatchObject({ name: 'failed', code: 'COLLECTION_LOCK_TRANSITION_BUSY' });
      expect(observerResult.name).toBe('acquired');
      expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ runId: 'observer' });
      observer.signal('release');
      expect(await waitForFile(join(eventDirectory, 'observer-released.json'))).toMatchObject({ runId: 'observer' });
      expect(existsSync(lockPath)).toBe(false);
      const later = acquireCollectionLock(ledgerPath, { runId: 'later-fresh-owner' });
      later.release();
    } finally {
      await cleanupLockWorkers(workers);
    }
  }, 20_000);

  it('allows exactly one owner during simultaneous child-process acquisition', async () => {
    const directory = temporaryDirectory();
    mkdirSync(join(directory, 'events')); mkdirSync(join(directory, 'controls'));
    const ledgerPath = join(directory, 'ledger.sqlite');
    writeFileSync(ledgerPath, 'synthetic external ledger path');
    const left = startLockWorker(directory, ledgerPath, 'simultaneous-left');
    const right = startLockWorker(directory, ledgerPath, 'simultaneous-right');
    const workers = [left, right];
    try {
      await Promise.all(workers.map((worker) => waitForFile(join(worker.eventDirectory, worker.role + '-ready.json'))));
      left.signal('acquire'); right.signal('acquire');
      const results = await Promise.all(workers.map(waitForWorkerResult));
      expect(results.filter((result) => result.name === 'acquired')).toHaveLength(1);
      expect(results.filter((result) => result.name === 'failed')).toHaveLength(1);
      const owner = results.find((result) => result.name === 'acquired');
      expect(JSON.parse(readFileSync(ledgerPath + '.collector.lock', 'utf8')).runId).toBe(owner.runId);
      const winner = owner.runId === left.role ? left : right;
      winner.signal('release');
      expect(await waitForFile(join(winner.eventDirectory, winner.role + '-released.json'))).toMatchObject({ runId: winner.role });
    } finally {
      await cleanupLockWorkers(workers);
    }
  }, 20_000);

  it('shares exclusion between D2c and D2h child processes using the same observation-store path', async () => {
    const directory = temporaryDirectory();
    mkdirSync(join(directory, 'events')); mkdirSync(join(directory, 'controls'));
    const ledgerPath = join(directory, 'ledger.sqlite');
    writeFileSync(ledgerPath, 'synthetic external ledger path');
    const d2c = startLockWorker(directory, ledgerPath, 'd2c');
    const d2h = startLockWorker(directory, ledgerPath, 'd2h');
    const workers = [d2c, d2h];
    try {
      await Promise.all(workers.map((worker) => waitForFile(join(worker.eventDirectory, worker.role + '-ready.json'))));
      d2c.signal('acquire');
      expect(await waitForFile(join(directory, 'events', 'd2c-acquired.json'))).toMatchObject({ runId: 'd2c' });
      d2h.signal('acquire');
      expect(await waitForWorkerResult(d2h)).toMatchObject({ name: 'failed', code: 'COLLECTION_ALREADY_RUNNING' });
      expect(JSON.parse(readFileSync(ledgerPath + '.collector.lock', 'utf8'))).toMatchObject({ runId: 'd2c' });
      d2c.signal('release');
      await waitForFile(join(directory, 'events', 'd2c-released.json'));
      expect(existsSync(ledgerPath + '.collector.lock')).toBe(false);
    } finally {
      await cleanupLockWorkers(workers);
    }
  }, 20_000);

  it('serializes different budget ledgers for one observation store, then safely releases and recovers stale ownership', async () => {
    const directory = temporaryDirectory();
    mkdirSync(join(directory, 'events')); mkdirSync(join(directory, 'controls'));
    const observationStorePath = join(directory, 'observations.sqlite');
    const leftLedgerPath = join(directory, 'd2c-budget.sqlite');
    const rightLedgerPath = join(directory, 'd2l-budget.sqlite');
    writeFileSync(observationStorePath, 'synthetic shared observation store');
    writeFileSync(leftLedgerPath, 'synthetic first budget ledger');
    writeFileSync(rightLedgerPath, 'synthetic second budget ledger');
    const left = startLockWorker(directory, leftLedgerPath, 'd2c-config-a', { observationStorePath });
    const right = startLockWorker(directory, rightLedgerPath, 'd2l-config-b', { observationStorePath });
    const workers = [left, right];
    try {
      const configurations = await Promise.all(workers.map((worker) => waitForFile(join(worker.eventDirectory, worker.role + '-ready.json'))));
      expect(configurations.map((configuration) => configuration.sameLedgerAndStore)).toEqual([false, false]);
      left.signal('acquire'); right.signal('acquire');
      const results = await Promise.all(workers.map(waitForWorkerResult));
      expect(results.filter((result) => result.name === 'acquired')).toHaveLength(1);
      expect(results.filter((result) => result.name === 'failed')).toHaveLength(1);
      expect(['d2c-config-a', 'd2l-config-b'].filter((role) => existsSync(join(directory, 'events', role + '-dispatch-ready.json')))).toHaveLength(1);

      const winner = results.find((result) => result.name === 'acquired').runId === left.role ? left : right;
      winner.signal('release');
      expect(await waitForFile(join(directory, 'events', winner.role + '-released.json'))).toMatchObject({ runId: winner.role });
      expect(existsSync(observationStorePath + '.collector.lock')).toBe(false);
      writeFileSync(observationStorePath + '.collector.lock', JSON.stringify({ schemaVersion: 1, runId: 'stale-budget-owner', pid: 2_147_483_647,
        startedAt: new Date().toISOString(), nonce: 'stale-budget-nonce' }));
      const resumed = acquireCollectionLock(observationStorePath, { runId: 'd2l-config-b-resumed', recoverStale: true });
      resumed.release();
      expect(existsSync(observationStorePath + '.collector.lock')).toBe(false);
    } finally {
      await cleanupLockWorkers(workers);
    }
  }, 20_000);
  it('fails closed on a process abandoned inside lock recovery until the transition is explicitly cleared', () => {
    const directory = temporaryDirectory();
    const ledgerPath = join(directory, 'ledger.sqlite');
    writeFileSync(ledgerPath, 'synthetic external ledger path');
    const lockPath = ledgerPath + '.collector.lock';
    const transitionPath = lockPath + '.transition';
    const archivedStalePath = lockPath + '.stale.interrupted';
    mkdirSync(transitionPath);
    writeFileSync(join(transitionPath, 'owner.json'), JSON.stringify({ schemaVersion: 1, runId: 'interrupted-run',
      pid: 2_147_483_647, startedAt: new Date().toISOString(), nonce: 'interrupted-nonce' }));
    writeFileSync(archivedStalePath, JSON.stringify({ schemaVersion: 1, runId: 'stale-owner', pid: 2_147_483_647,
      startedAt: new Date().toISOString(), nonce: 'stale-nonce' }));

    expect(() => acquireCollectionLock(ledgerPath, { runId: 'after-crash', recoverStale: true }))
      .toThrow('COLLECTION_LOCK_TRANSITION_REQUIRES_RECONCILIATION');
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(transitionPath)).toBe(true);
    expect(existsSync(archivedStalePath)).toBe(true);

    rmSync(transitionPath, { recursive: true });
    const afterOperatorCheck = acquireCollectionLock(ledgerPath, { runId: 'after-operator-check' });
    afterOperatorCheck.release();
    expect(existsSync(archivedStalePath)).toBe(true);
  });

  it('blocks D2c collection while a shared-ledger unknown charge remains unresolved', async () => {
    const directory = temporaryDirectory();
    const environment = collectionEnvironment(directory);
    const harness = collectionDependencies([managedResult('fresh')]);
    harness.ledger.listUnknownChargeAttempts = () => [{ attemptId: 'synthetic-unknown', reportedChargedCredits: null }];
    await expect(runD2cCollection({ mode: 'collect', environment: (key) => environment[key], dependencies: harness.dependencies }))
      .rejects.toThrow('LEDGER_RECONCILIATION_REQUIRED');
    expect(harness.queries).toHaveLength(0);
    expect(harness.dependencies.openStore).not.toHaveBeenCalled();
    expect(harness.dependencies.createManager).not.toHaveBeenCalled();
    expect(harness.ledger.close).toHaveBeenCalledOnce();
  });

  it('continues after a complete Nansen cache hit and refreshes the later stale endpoints', async () => {
    const directory = temporaryDirectory();
    const environment = collectionEnvironment(directory);
    const harness = collectionDependencies([
      managedResult('cached'),
      managedResult('fresh', { operation: 'FLOW_INTELLIGENCE', asset: 'WETH' }),
      managedResult('fresh', { operation: 'SMART_MONEY_NETFLOW' }),
    ]);
    const report = await runD2cCollection({ mode: 'collect', environment: (key) => environment[key], dependencies: harness.dependencies });
    expect(harness.queries).toHaveLength(3);
    expect(report.results.map((result) => result.status)).toEqual(['cached', 'fresh', 'fresh']);
    expect(report.results[0].providerAttempts).toBe(0);
    expect(report.providerCalls).toBe(2);
    expect(report.qualifyingSuccessfulRequests).toBe(2);
    expect(report.stoppedOnFailure).toBe(false);
  });

  it('completes an all-cached plan with zero new provider calls or qualifying successes', async () => {
    const directory = temporaryDirectory();
    const environment = collectionEnvironment(directory);
    const harness = collectionDependencies([managedResult('cached'), managedResult('cached'), managedResult('cached')]);
    const report = await runD2cCollection({ mode: 'collect', environment: (key) => environment[key], dependencies: harness.dependencies });
    expect(harness.queries).toHaveLength(3);
    expect(report.results.map((result) => result.providerAttempts)).toEqual([0, 0, 0]);
    expect(report.providerCalls).toBe(0);
    expect(report.qualifyingSuccessfulRequests).toBe(0);
    expect(report.stoppedOnFailure).toBe(false);
  });

  it('reports successful fresh query attempts separately from qualifying successes', async () => {
    const directory = temporaryDirectory();
    const environment = collectionEnvironment(directory);
    const harness = collectionDependencies([managedResult('fresh'), managedResult('fresh'), managedResult('fresh')]);
    const report = await runD2cCollection({ mode: 'collect', environment: (key) => environment[key], dependencies: harness.dependencies });
    expect(report.providerCalls).toBe(3);
    expect(report.qualifyingSuccessfulRequests).toBe(3);
    expect(report.results.map((result) => result.providerAttempts)).toEqual([1, 1, 1]);
    expect(report.stoppedOnFailure).toBe(false);
  });

  it('counts a failed dispatched provider request and stops before later endpoints', async () => {
    const directory = temporaryDirectory();
    const environment = collectionEnvironment(directory);
    const harness = collectionDependencies([
      managedResult('failed'),
      managedResult('fresh'),
      managedResult('fresh'),
    ]);
    const report = await runD2cCollection({ mode: 'collect', environment: (key) => environment[key], dependencies: harness.dependencies });
    expect(harness.queries).toHaveLength(1);
    expect(report.providerCalls).toBe(1);
    expect(report.qualifyingSuccessfulRequests).toBe(0);
    expect(report.results[0].providerAttempts).toBe(1);
    expect(report.stoppedOnFailure).toBe(true);
  });

  it('stops at incomplete observations while retaining the attempted-call count', async () => {
    const directory = temporaryDirectory();
    const environment = collectionEnvironment(directory);
    const harness = collectionDependencies([
      managedResult('incomplete'),
      managedResult('fresh'),
      managedResult('fresh'),
    ]);
    const report = await runD2cCollection({ mode: 'collect', environment: (key) => environment[key], dependencies: harness.dependencies });
    expect(harness.queries).toHaveLength(1);
    expect(report.providerCalls).toBe(1);
    expect(report.qualifyingSuccessfulRequests).toBe(0);
    expect(report.stoppedOnFailure).toBe(true);
  });

  it('does not leak a malformed external config secret or source excerpt to CLI stderr', () => {
    const directory = temporaryDirectory('ered-luin-d2c-CLI_PATH_SENTINEL-');
    const configPath = join(directory, 'malformed.json');
    const secret = 'SYNTHETIC_D2C_SECRET_SENTINEL';
    writeFileSync(configPath, '{"schemaVersion":1,"environment":{"D2_OPERATOR_SECRET":' + secret + '}}');
    const result = runManualCollectionCli(['--collect', '--config', configPath]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain('"D2_OPERATOR_SECRET":' + secret);
    expect(result.stderr).not.toContain('SYNTHETIC_');
    expect(result.stderr).toContain('COLLECTION_CONFIG_INVALID');

    expect(result.stderr).not.toContain(configPath);
  });

  it('does not leak a private config path when the external config file cannot be read', () => {
    const directory = temporaryDirectory('ered-luin-d2c-CLI_PATH_SENTINEL-');
    const configPath = join(directory, 'missing-SYNTHETIC_PATH_SENTINEL.json');
    const result = runManualCollectionCli(['--collect', '--config', configPath]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('SYNTHETIC_PATH_SENTINEL');
    expect(result.stderr).not.toContain(configPath);
    expect(result.stderr).toContain('COLLECTION_CONFIG_UNREADABLE');
  });
  it('allowlists safe CLI codes and replaces arbitrary errors with a generic code', () => {
    expect(safeCliFailureCode(new Error('COLLECTION_CONFIG_INVALID'))).toBe('COLLECTION_CONFIG_INVALID');
    expect(safeCliFailureCode(new Error('private storage failure at SYNTHETIC_PATH_SENTINEL'))).toBe('COLLECTION_FAILED');
    expect(safeCliFailureCode('SYNTHETIC_SECRET_SENTINEL')).toBe('COLLECTION_FAILED');
  });
});

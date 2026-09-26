import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { D2C_CONFIG_KEYS } from '../d2c/preflight.mjs';
import { loadD2kConfiguration } from './config.mjs';

import {
  D2K_ADAPTER_BODY,
  D2K_TOKEN_QUERY,
  buildD2kDryRunPlan,
  runD2kManagedDiagnostic,
  runD2kWithExternalState,
} from './diagnostic.mjs';
import {
  NANSEN_COST_PROFILE_VERSION,
  initializeCreditLedger,
  initializeNansenObservationStore,
  openCreditLedger,
  openNansenObservationStore,
} from '../../packages/nansen/dist/index.js';

const fixture = JSON.parse(readFileSync(new URL('../../packages/nansen/fixtures/token-screener.synthetic.json', import.meta.url), 'utf8'));
const roots = new Set();

function configEnvironment(overrides = {}) {
  return {
    ...Object.fromEntries(D2C_CONFIG_KEYS.map((key) => [key, 'false'])),
    NODE_ENV: 'development',
    NANSEN_API_ENABLED: 'false',
    NANSEN_CREDIT_BUDGET: '0',
    NANSEN_COLLECTION_REVIEWED: 'false',
    NANSEN_COLLECTION_ENABLED: 'false',
    EXECUTION_MODE: 'paper',
    NANSEN_LEDGER_LIMIT_CREDITS: '0',
    NANSEN_LEDGER_PATH: '',
    NANSEN_LEDGER_BUDGET_ID: '',
    NANSEN_COST_PROFILE_VERSION: NANSEN_COST_PROFILE_VERSION,
    NANSEN_OBSERVATION_STORE_PATH: '',
    NANSEN_OBSERVATION_STORE_ID: '',
    ...overrides,
  };
}
function writeConfig(path, environment) {
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, environment }), 'utf8');
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ered-luin-d2k-'));
  roots.add(root);
  return root;
}
function makeLedger(root, suffix = 'ledger') {
  const options = {
    databasePath: join(root, suffix + '.sqlite'),
    budgetId: 'd2k-test-' + suffix,
    limitCredits: 3,
    costProfileVersion: NANSEN_COST_PROFILE_VERSION,
  };
  initializeCreditLedger(options).close();
  return options;
}
function makeStore(root, suffix = 'observations') {
  const options = { databasePath: join(root, suffix + '.sqlite'), storeId: 'd2k-test-' + suffix };
  initializeNansenObservationStore(options).close();
  return options;
}
function makePaths(root, prefix = '') {
  return {
    runMarkerPath: join(root, prefix + 'run.marker.json'),
    dispatchMarkerPath: join(root, prefix + 'dispatch.marker.json'),
    resultPath: join(root, prefix + 'result.json'),
  };
}
function response(payload = fixture, status = 200, charged = 1) {
  return {
    status,
    headers: { 'X-Nansen-Credits-Used': String(charged) },
    body: new TextEncoder().encode(JSON.stringify(payload)),
  };
}
function managerTransport(payload = fixture, status = 200, charged = 1) {
  const calls = [];
  return {
    calls,
    transport: async (request) => {
      calls.push({
        url: new URL(request.url),
        method: request.method,
        headers: request.headers,
        body: JSON.parse(request.body),
      });
      return response(payload, status, charged);
    },
  };
}
function run(ledgerOptions, storeOptions, paths, transport) {
  return runD2kWithExternalState({
    ledgerOptions,
    storeOptions,
    apiKey: 'D2K_SYNTHETIC_TEST_KEY',
    ...paths,
    transport,
  });
}
function instrumentedOpen(open, closed, key) {
  return (options) => {
    const value = open(options);
    return new Proxy(value, {
      get(target, property) {
        const member = Reflect.get(target, property, target);
        if (property === 'close') return () => { closed[key] += 1; return member.call(target); };
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
  };
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe('D2k bounded Token Screener diagnostic', () => {
  it('defaults to a zero-call plan with the canonical one-page query and three-credit ceiling', () => {
    expect(buildD2kDryRunPlan()).toMatchObject({
      mode: 'DRY_RUN', providerCalls: 0, credentialRead: false, activeBudgetCredits: 0,
      authorizedTotalCeilingCredits: 3,
      request: {
        managedQuery: D2K_TOKEN_QUERY,
        body: D2K_ADAPTER_BODY,
        maxPages: 1,
        maxRetries: 0,
        expectedCredits: 1,
      },
    });
  });

  it('loads the original private validation config while leaving the main config unchanged', () => {
    const root = makeRoot();
    const privateRoot = join(root, 'Ered-Luin');
    const validationDirectory = join(privateRoot, 'nansen-validation-20260925-01');
    mkdirSync(validationDirectory, { recursive: true });
    const mainConfigPath = join(privateRoot, 'd2c-local.json');
    const validationConfigPath = join(validationDirectory, 'collection.json');
    const originalLedgerPath = join(validationDirectory, 'credits.sqlite');
    const mainEnvironment = configEnvironment({
      NANSEN_OBSERVATION_STORE_PATH: join(root, 'main-observations.sqlite'),
      NANSEN_OBSERVATION_STORE_ID: 'main-observations',
    });
    const validationEnvironment = configEnvironment({
      NANSEN_LEDGER_LIMIT_CREDITS: '7',
      NANSEN_LEDGER_PATH: originalLedgerPath,
      NANSEN_LEDGER_BUDGET_ID: 'nansen-validation-20260925-01',
      NANSEN_OBSERVATION_STORE_PATH: join(root, 'canonical-observations.sqlite'),
      NANSEN_OBSERVATION_STORE_ID: 'canonical-observations',
    });
    writeConfig(mainConfigPath, mainEnvironment);
    writeConfig(validationConfigPath, validationEnvironment);
    const mainBefore = readFileSync(mainConfigPath);

    const loaded = loadD2kConfiguration(privateRoot);

    expect(loaded.mainEnvironment.NANSEN_LEDGER_LIMIT_CREDITS).toBe('0');
    expect(loaded.validationEnvironment.NANSEN_LEDGER_LIMIT_CREDITS).toBe('7');
    expect(loaded.validationEnvironment.NANSEN_LEDGER_PATH).toBe(originalLedgerPath);
    expect(loaded.validationEnvironment.NANSEN_OBSERVATION_STORE_ID).toBe('canonical-observations');
    expect(readFileSync(mainConfigPath).equals(mainBefore)).toBe(true);
  });

  it('sends the exact canonical query through the real manager once and emits shape-only results', async () => {
    const root = makeRoot();
    const ledgerOptions = makeLedger(root);
    const storeOptions = makeStore(root);
    const paths = makePaths(root);
    const payload = structuredClone(fixture);
    for (const row of payload.data) {
      row.price_usd = 987654321.123;
      row.market_cap_usd = 9876543210;
    }
    const fake = managerTransport(payload);
    const report = await run(ledgerOptions, storeOptions, paths, fake.transport);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      url: { pathname: '/api/v1/token-screener' },
      method: 'POST',
      headers: { apikey: 'D2K_SYNTHETIC_TEST_KEY' },
      body: D2K_ADAPTER_BODY,
    });
    expect(report).toMatchObject({
      status: 'fresh',
      cacheOutcome: 'MISS_DISPATCH_MARKED',
      managedAttempts: 1,
      transportAttempts: 1,
      receivedPages: 1,
      completeness: 'complete',
      diagnosticsProduced: true,
      usdcPriceFieldState: 'numeric',
      usdcRowPresence: 'present',
      normalizedSignals: {
        usdcPrice: { quality: 'COMPLETE', complete: true, usableAsPositivePrice: true },
        wethPrice: { quality: 'COMPLETE', complete: true, usableAsPositivePrice: true },
      },
      ledger: { limitCredits: 3, allocatedCredits: 1, remainingCredits: 2, reportedChargedCreditsTotal: 1 },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('987654321');
    expect(serialized).not.toContain('D2K_SYNTHETIC_TEST_KEY');
    expect(serialized).not.toContain('0x833589');
    expect(serialized).not.toContain('0x420000');
  });

  it('rejects duplicate execution through the create-only run marker before any second request', async () => {
    const root = makeRoot();
    const ledgerOptions = makeLedger(root);
    const storeOptions = makeStore(root);
    const paths = makePaths(root);
    const fake = managerTransport();
    await run(ledgerOptions, storeOptions, paths, fake.transport);
    const ledger = openCreditLedger(ledgerOptions);
    const store = openNansenObservationStore(storeOptions);
    try {
      await expect(runD2kManagedDiagnostic({
        ledger,
        store,
        apiKey: 'D2K_SYNTHETIC_TEST_KEY',
        ...paths,
        transport: fake.transport,
      })).rejects.toThrow();
    } finally {
      store.close();
      ledger.close();
    }
    expect(fake.calls).toHaveLength(1);
  });

  it('does not retry a failed provider response and preserves its single charged attempt', async () => {
    const root = makeRoot();
    const ledgerOptions = makeLedger(root);
    const storeOptions = makeStore(root);
    const fake = managerTransport({ error: 'synthetic-failure' }, 503, 1);
    const report = await run(ledgerOptions, storeOptions, makePaths(root), fake.transport);

    expect(fake.calls).toHaveLength(1);
    expect(report).toMatchObject({
      status: 'failed',
      managedAttempts: 1,
      transportAttempts: 1,
      receivedPages: 0,
      httpStatuses: [503],
      diagnosticsProduced: false,
      failureClass: 'PROVIDER_FAILURE',
      ledger: { allocatedCredits: 1, reportedChargedCreditsTotal: 1, reportedChargeCount: 1 },
      stopAfterThisResult: true,
    });
  });

  it('reports the default transport count as unmeasured while a test boundary denies network access', async () => {
    const root = makeRoot();
    const ledgerOptions = makeLedger(root);
    const storeOptions = makeStore(root);
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url: new URL(url), method: init.method, body: JSON.parse(init.body) });
      throw new Error('synthetic network denial');
    };
    let report;
    try {
      report = await runD2kWithExternalState({
        ledgerOptions,
        storeOptions,
        apiKey: 'D2K_SYNTHETIC_TEST_KEY',
        ...makePaths(root),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: { pathname: '/api/v1/token-screener' },
      method: 'POST',
      body: D2K_ADAPTER_BODY,
    });
    expect(report).toMatchObject({
      cacheOutcome: 'MISS_DISPATCH_MARKED',
      dispatchMarkerCreated: true,
      managedAttempts: 1,
      attemptAccountingSource: 'MANAGED_CLIENT_PAGE_REFERENCES',
      transportAttempts: null,
      transportMeasurement: 'DEFAULT_TRANSPORT_COUNT_UNMEASURED',
      receivedPages: 0,
      failureClass: 'PROVIDER_FAILURE',
    });
  });
  it('uses the manager cache at zero cost and produces no new structural diagnostics on a hit', async () => {
    const root = makeRoot();
    const storeOptions = makeStore(root);
    const firstLedger = makeLedger(root, 'first-ledger');
    const firstTransport = managerTransport();
    const first = await run(firstLedger, storeOptions, makePaths(root, 'first-'), firstTransport.transport);
    expect(first.status).toBe('fresh');

    const secondLedger = makeLedger(root, 'second-ledger');
    const secondTransport = managerTransport();
    const second = await run(secondLedger, storeOptions, makePaths(root, 'second-'), secondTransport.transport);
    expect(secondTransport.calls).toHaveLength(0);
    expect(second).toMatchObject({
      status: 'cached',
      cacheOutcome: 'HIT',
      cacheHit: true,
      managedAttempts: 0,
      transportAttempts: 0,
      diagnosticsProduced: false,
      diagnostics: null,
      usdcPriceFieldState: 'NOT_CAPTURED_CACHE_HIT',
      normalizedSignals: { usdcPrice: { quality: 'COMPLETE', usableAsPositivePrice: true } },
      ledger: { allocatedCredits: 0, remainingCredits: 3, reportedChargeCount: 0 },
    });
  });

  it('closes the ledger and observation store after the bounded invocation', async () => {
    const root = makeRoot();
    const ledgerOptions = makeLedger(root);
    const storeOptions = makeStore(root);
    const closed = { ledger: 0, store: 0 };
    const fake = managerTransport();
    await runD2kWithExternalState({
      ledgerOptions,
      storeOptions,
      apiKey: 'D2K_SYNTHETIC_TEST_KEY',
      ...makePaths(root),
      transport: fake.transport,
      openLedger: instrumentedOpen(openCreditLedger, closed, 'ledger'),
      openStore: instrumentedOpen(openNansenObservationStore, closed, 'store'),
    });
    expect(closed).toEqual({ ledger: 1, store: 1 });
  });
});
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { canonicalManagedQuery, D2C_COLLECTION_QUERIES, runD2cCollection } from '../../../tools/d2c/collection-plan.mjs';
import {
  NANSEN_COST_PROFILE_VERSION,
  createNansenClient,
  createNansenQueryManager,
  initializeCreditLedger,
  initializeNansenObservationStore,
  openCreditLedger,
  openNansenObservationStore,
} from './index.ts';

const responseFixtures = new Map([
  ['/api/v1/token-screener', ['../fixtures/token-screener.synthetic.json', 1]],
  ['/api/v1/tgm/flow-intelligence', ['../fixtures/flow-intelligence.synthetic.json', 1]],
  ['/api/v1/smart-money/netflow', ['../fixtures/smart-money-netflow.synthetic.json', 5]],
]);
const paths = new Set();

function setupSyntheticState() {
  const root = mkdtempSync(join(tmpdir(), 'ered-luin-d2i-collection-'));
  paths.add(root);
  const ledgerOptions = {
    databasePath: join(root, 'synthetic-ledger.sqlite'),
    budgetId: 'd2i-synthetic-budget',
    limitCredits: 7,
    costProfileVersion: NANSEN_COST_PROFILE_VERSION,
  };
  const storeOptions = {
    databasePath: join(root, 'synthetic-observations.sqlite'),
    storeId: 'd2i-synthetic-store',
  };
  initializeCreditLedger(ledgerOptions).close();
  initializeNansenObservationStore(storeOptions).close();
  const requests = [];
  const transport = async (request) => {
    const url = new URL(request.url);
    const fixture = responseFixtures.get(url.pathname);
    if (!fixture) throw new Error('unexpected synthetic endpoint');
    requests.push({ pathname: url.pathname, body: JSON.parse(request.body) });
    const [fixturePath, chargedCredits] = fixture;
    const body = JSON.parse(readFileSync(new URL(fixturePath, import.meta.url), 'utf8'));
    if (url.pathname === '/api/v1/token-screener') {
      for (const row of body.data) Object.assign(row, { fdv_mc_ratio: 1.25, inflow_fdv_ratio: 0.05, outflow_fdv_ratio: 0.04 });
    }
    return {
      status: 200,
      headers: { 'X-Nansen-Credits-Used': String(chargedCredits) },
      body: new TextEncoder().encode(JSON.stringify(body)),
    };
  };
  const environment = {
    NANSEN_COLLECTION_REVIEWED: 'true',
    NANSEN_COLLECTION_ENABLED: 'true',
    NANSEN_API_ENABLED: 'true',
    NANSEN_CREDIT_BUDGET: '7',
    NANSEN_LEDGER_LIMIT_CREDITS: '7',
    NANSEN_API_KEY: 'SYNTHETIC_TEST_KEY',
    NANSEN_LEDGER_PATH: ledgerOptions.databasePath,
    NANSEN_LEDGER_BUDGET_ID: ledgerOptions.budgetId,
    NANSEN_COST_PROFILE_VERSION: NANSEN_COST_PROFILE_VERSION,
    NANSEN_OBSERVATION_STORE_PATH: storeOptions.databasePath,
    NANSEN_OBSERVATION_STORE_ID: storeOptions.storeId,
  };
  const dependencies = {
    openLedger: (settings) => openCreditLedger(settings),
    openStore: (settings) => openNansenObservationStore(settings),
    createClient: (settings) => createNansenClient({ ...settings, transport }),
    createManager: (settings) => createNansenQueryManager(settings),
  };
  return { root, ledgerOptions, storeOptions, requests, transport, environment, dependencies };
}

afterEach(() => {
  for (const path of paths) rmSync(path, { recursive: true, force: true });
  paths.clear();
});

describe('D2i D2c collection query compatibility', () => {
  it('dispatches every canonical planned query through the real manager with exact ledger charges', async () => {
    const test = setupSyntheticState();
    const ledger = openCreditLedger(test.ledgerOptions);
    const store = openNansenObservationStore(test.storeOptions);
    const client = createNansenClient({
      ledger,
      enabled: true,
      apiKey: 'SYNTHETIC_TEST_KEY',
      transport: test.transport,
      maxPages: 1,
    });
    const manager = createNansenQueryManager({ client, store, enabled: true, maxPageBound: 1, maxRetryBound: 0 });
    try {
      const results = [];
      for (const query of D2C_COLLECTION_QUERIES) {
        results.push(await manager.query(canonicalManagedQuery(query)));
      }

      expect(test.requests.map((request) => request.pathname)).toEqual([
        '/api/v1/token-screener',
        '/api/v1/tgm/flow-intelligence',
        '/api/v1/smart-money/netflow',
      ]);
      expect(results.map((result) => result.status)).toEqual(['fresh', 'fresh', 'fresh']);
      expect(results.every((result) => result.source === 'synthetic' && result.qualifyingSuccessfulRequests === 0)).toBe(true);
      expect(ledger.getSnapshot()).toMatchObject({
        limitCredits: 7,
        allocatedCredits: 7,
        remainingCredits: 0,
        reportedChargeCount: 3,
        reportedChargedCreditsTotal: 7,
        pendingAttemptCount: 0,
      });
      expect(store.getLatestSignals().every((signal) => signal.provider === 'synthetic')).toBe(true);
      const screenerSnapshot = store.listHistory({ cacheKey: results[0].cacheKey })[0];
      expect(screenerSnapshot?.unavailableFields).not.toContain('unrecognized_token_fields');
    } finally {
      store.close();
      ledger.close();
    }
  });
  it('strips plan metadata before the real manager and preserves dispatch accounting', async () => {
    const test = setupSyntheticState();
    let report;
    let failure = null;
    try {
      report = await runD2cCollection({
        mode: 'collect',
        environment: (key) => test.environment[key],
        dependencies: test.dependencies,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeNull();
    expect(test.requests).toHaveLength(1);
    expect(test.requests[0]).toMatchObject({
      pathname: '/api/v1/token-screener',
      body: { chains: ['base'], timeframe: '1h', pagination: { page: 1, per_page: 100 } },
    });
    expect(report).toMatchObject({
      providerAttempts: 1,
      qualifyingSuccessfulRequests: 0,
      stoppedOnFailure: true,
      results: [{ operation: 'TOKEN_SCREENER', status: 'fresh', source: 'synthetic', providerAttempts: 1 }],
      ledger: { allocatedCredits: 1, reportedChargeCount: 1, reportedChargedCreditsTotal: 1, pendingAttemptCount: 0 },
    });
    const ledger = openCreditLedger(test.ledgerOptions);
    try {
      expect(ledger.getSnapshot()).toMatchObject({
        allocatedCredits: 1,
        reportedChargeCount: 1,
        reportedChargedCreditsTotal: 1,
        pendingAttemptCount: 0,
      });
    } finally {
      ledger.close();
    }
  });
});

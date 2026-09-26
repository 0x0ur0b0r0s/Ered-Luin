import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizedSignalSchema, type D2Runtime, type ExecutionTransactionEnvelope } from '@ered-luin/contracts';
import type { ObservationSnapshot } from '@ered-luin/nansen';
import { initializeD2AuditStore, openD2AuditStore } from './d2-audit-store.js';
import { createD2ProductionService } from './d2-production.js';
import { createApiApp } from './api.js';
import { LocalOperatorAuthenticator } from './operator-auth.js';
import { BASE_UNISWAP_V3 } from './base-allowlist.js';
import { ExecutionStore } from './execution-store.js';
import { G3cExecutionStore } from './g3c-execution-store.js';
import { createSyntheticG3cEvidenceAuthority } from './g3c-evidence.js';
import { initializePaperStore } from './paper-store.js';
import type { D2G3cGateway } from './d2-g3c-gateway.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const NOW = new Date('2026-09-24T12:00:00.000Z');
const SESSION_ID = '00000000-0000-4000-8000-000000000321';
const RUNTIME: D2Runtime = {
  service: 'ered-luin-api', status: 'ok', appMode: 'PRODUCTION_READ_ONLY',
  paidNansenCallsEnabled: false, activeNansenCreditBudget: 0, liveExecutionEnabled: false,
  executionControls: { operatorAuthConfigured: true, signingEnabled: false, submissionEnabled: false, reviewedMode: false },
  nansenObservationStore: 'configured', productionEvaluation: 'configured',
  baseRpc: 'disabled', g3cStatusReader: 'configured', rpcRunBudget: null,
};

function snapshots(flowValue: string, staleFlow = false): readonly ObservationSnapshot[] {
  const fetchedAt = new Date(NOW.getTime() - (staleFlow ? 60 * 60_000 : 1_000)).toISOString();
  const acquiredAt = new Date(Date.parse(fetchedAt) + 1_000).toISOString();
  const expiresAt = new Date(Date.parse(fetchedAt) + (staleFlow ? 20 * 60_000 : 10 * 60_000)).toISOString();
  const mkSignal = (endpoint: 'TOKEN_SCREENER' | 'SMART_MONEY_NETFLOW', asset: 'USDC' | 'WETH',
    metric: string, value: string, signalNo: number) => normalizedSignalSchema.parse({
      signalId: '00000000-0000-4000-8000-0000000001' + String(signalNo).padStart(2, '0'),
      provider: 'nansen', endpoint, chainId: 8453, asset, metric,
      observedAt: acquiredAt, fetchedAt, quality: 'COMPLETE', value, unit: 'usd_micros',
      provenanceId: 'offline-test-only:synthetic-value',
    });
  const signals = [
    mkSignal('TOKEN_SCREENER', 'USDC', 'price_usd', '1000000', 1),
    mkSignal('TOKEN_SCREENER', 'WETH', 'price_usd', '2500000000', 2),
    mkSignal('SMART_MONEY_NETFLOW', 'WETH', 'net_flow_1h_usd', flowValue, 3),
  ];
  const makeSnapshot = (operation: ObservationSnapshot['operation'], asset: ObservationSnapshot['asset'],
    groupSignals: readonly ObservationSnapshot['signals'][number][], index: number): ObservationSnapshot => ({
      snapshotId: '00000000-0000-4000-8000-0000000002' + String(index).padStart(2, '0'),
      cacheKey: String(index).padStart(64, '0'), operation, asset, timeframe: '1h', pageBound: 1, retryBound: 0,
      source: 'nansen', fetchedAt, acquiredAt, expiresAt, completeness: 'complete', failure: null,
      pageReferences: [{ attemptId: 'offline-d2-' + index, status: 200, providerRequestId: 'synthetic-test-' + index,
        chargedCredits: 0, page: 1, received: true, retry: 0 }],
      unavailableFields: [], signals: groupSignals,
    });
  return [
    makeSnapshot('TOKEN_SCREENER', 'BASE_PAIR', signals.slice(0, 2), 1),
    makeSnapshot('SMART_MONEY_NETFLOW', 'WETH', [signals[2]!], 2),
  ];
}

function transaction(amountIn: string, expiresAt: string): ExecutionTransactionEnvelope {
  return {
    version: 1, chainId: 8453, walletAddress: WALLET, router: BASE_UNISWAP_V3.router,
    recipient: WALLET, sellAsset: 'USDC', buyAsset: 'WETH', amountIn,
    minimumAmountOut: (BigInt(amountIn) * 1_000_000_000n).toString(), valueNativeWei: '0',
    maxFeePerGasWei: '3', maxPriorityFeePerGasWei: '1', maxTotalFeeWei: '1000000000',
    chainNonce: '0', expiresAt,
  };
}

function createHarness(initialFlow = '1000000', staleFlow = false, now: () => Date = () => new Date(NOW),
  beforeQuote: (amountIn: string) => Promise<void> = async () => { await Promise.resolve(); }) {
  const dir = mkdtempSync(join(tmpdir(), 'ered-luin-d2-'));
  const store = initializePaperStore({ databasePath: join(dir, 'paper.sqlite'), clock: now });
  const execution = new ExecutionStore(store);
  execution.setKillSwitch(false, 'D2 offline integration fixture');
  const authority = createSyntheticG3cEvidenceAuthority(now);
  const g3c = new G3cExecutionStore(execution, authority.trust, {}, now);
  const auditPath = join(dir, 'd2-audit.sqlite');
  const audit = initializeD2AuditStore({ databasePath: auditPath });
  let flow = initialFlow;
  let stale = staleFlow;
  const calls = { sources: [] as string[], quoteAmounts: [] as string[], quoteTimes: [] as string[], simulation: 0, recovery: 0 };
  const observations = {
    getLatestSnapshots(source: 'nansen' | 'synthetic') {
      calls.sources.push(source);
      return source === 'nansen' ? snapshots(flow, stale) : [];
    },
  };
  const policyProvider = {
    getSignals: () => [],
    getAccountSnapshot: () => ({
      walletAddress: WALLET, version: 1, usdcBalanceAtomic: '10000000', wethBalanceAtomic: '0',
      gasBalanceNativeWei: '0', utcDay: '2026-09-24', dailyStartEquityUsdcMicros: '10000000', dailyFundingUsdcMicros: '0',
    }),
    async getQuoteBundle(intent: { readonly amountIn: string }) {
      calls.quoteAmounts.push(intent.amountIn);
      await beforeQuote(intent.amountIn);
      const amountOut = (BigInt(intent.amountIn) * 1_000_000_000n).toString();
      const tradeQuotedAt = now().toISOString();
      const projectedQuotedAt = now().toISOString();
      calls.quoteTimes.push(tradeQuotedAt, projectedQuotedAt);
      return {
        accountVersion: 1, positionQuote: null,
        tradeQuote: { source: 'synthetic', chainId: 8453, sellAsset: 'USDC', buyAsset: 'WETH',
          amountIn: intent.amountIn, amountOut, quotedAt: tradeQuotedAt, slippageBps: 0, priceImpactBps: 20,
          feeUsdcMicros: '0', gasFeeNativeWei: '0' },
        projectedPositionQuote: { source: 'synthetic', chainId: 8453, sellAsset: 'WETH', buyAsset: 'USDC',
          amountIn: amountOut, amountOut: intent.amountIn, quotedAt: projectedQuotedAt, slippageBps: 0, priceImpactBps: 20,
          feeUsdcMicros: '0', gasFeeNativeWei: '0' },
        gasQuote: null, projectedGasQuote: null, gasFeeQuote: null,
      };
    },
    getExecutionTransaction(intent: { readonly amountIn: string }, version: number) {
      if (version !== 1) throw new Error('Unexpected synthetic account version.');
      return transaction(intent.amountIn, new Date(NOW.getTime() + 60_000).toISOString());
    },
  };
  const gateway: D2G3cGateway = {
    async startSession() { throw new Error('Session creation is not exercised by this offline route test.'); },
    assertActiveSession(sessionId, walletAddress) {
      if (sessionId !== SESSION_ID || walletAddress.toLowerCase() !== WALLET.toLowerCase()) throw new Error('D2_SESSION_IDENTITY_MISMATCH');
    },
    async simulate() { calls.simulation += 1; throw new Error('Simulation provider is not exercised by this route test.'); },
    async reconcile() { calls.recovery += 1; throw new Error('Recovery provider is not exercised by this route test.'); },
    getWorkflow() { throw new Error('Workflow lookup is not exercised by this route test.'); },
    status(executionId: string) { return g3c.status(executionId); },
  };
  const production = createD2ProductionService({
    observations, audit, policyProvider, executionStore: execution, g3cStatusReader: g3c, g3cGateway: gateway, clock: now,
  });
  const operatorAuth = new LocalOperatorAuthenticator({ secret: 'A'.repeat(43), allowedOrigin: 'http://127.0.0.1:5173', clock: now });
  const login = operatorAuth.login({ password: 'A'.repeat(43), origin: 'http://127.0.0.1:5173', hostname: '127.0.0.1', remoteAddress: '127.0.0.1' });
  if (!login.ok) throw new Error('Offline operator fixture failed to authenticate.');
  const operatorHeaders = { origin: 'http://127.0.0.1:5173', cookie: login.cookie.split(';')[0]! };
  const app = createApiApp({ store, d2Production: production, g3cStatusReader: g3c, d2Runtime: () => RUNTIME, operatorAuth, clock: now });
  return {
    app, store, execution, g3c, auditPath, dir, calls, operatorHeaders,
    setEvidence(nextFlow: string, isStale = false) { flow = nextFlow; stale = isStale; },
    async close(retainFiles = false) {
      await app.close();
      if (!retainFiles) rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function createProposal(harness: ReturnType<typeof createHarness>, requestedUsdcMicros: string) {
  const response = await harness.app.inject({ headers: harness.operatorHeaders,
    method: 'POST', url: '/v1/production/proposals', payload: { walletAddress: WALLET, requestedUsdcMicros },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { proposalId: string; intent: { intentId: string; amountIn: string }; evidence: { source: string; observationIds: string[]; batches: unknown[] } };
}
async function evaluate(harness: ReturnType<typeof createHarness>, proposalId: string) {
  const response = await harness.app.inject({ headers: harness.operatorHeaders,
    method: 'POST', url: '/v1/production/evaluations', payload: { proposalId, sessionId: SESSION_ID },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { decision: { status: string; approvedAmountIn: string | null; requestedAmountIn: string; evaluatedAt: string; reasons: string[] };
    evidenceIds: string[]; evidenceBatches: unknown[]; paperFillCreated: false; executionMode: string };
}

describe('D2 production-read-only API integration', () => {
  it('keeps Nansen provenance and changes G2 decision when stored flow evidence changes', async () => {
    const h = createHarness();
    try {
      const positiveProposal = await createProposal(h, '4000000');
      expect(positiveProposal.evidence.source).toBe('nansen');
      expect(positiveProposal.evidence.observationIds).toHaveLength(3);
      expect(positiveProposal.evidence.batches).toHaveLength(2);
      const positive = await evaluate(h, positiveProposal.proposalId);
      expect(positive.decision.status).toBe('ALLOW');
      expect(positive.evidenceIds).toEqual(positiveProposal.evidence.observationIds);
      expect(positive.paperFillCreated).toBe(false);
      expect(positive.executionMode).toBe('READ_ONLY');

      h.setEvidence('-1000000');
      const negativeProposal = await createProposal(h, '4000000');
      const negative = await evaluate(h, negativeProposal.proposalId);
      expect(negative.decision.status).toBe('BLOCK');
      expect(negative.decision.approvedAmountIn).toBeNull();
      expect(negative.evidenceIds).toEqual(negativeProposal.evidence.observationIds);
      expect(h.calls.sources.every((source) => source === 'nansen')).toBe(true);
      expect(h.store.getIntent(positiveProposal.intent.intentId)).toBeNull();
      expect(h.store.getIntent(negativeProposal.intent.intentId)).toBeNull();
    } finally { await h.close(); }
  });

  it('refreshes the production evaluation clock after an asynchronous resize quote', async () => {
    let tick = 0;
    const h = createHarness('1000000', false, () => new Date(NOW.getTime() + tick++));
    try {
      const proposal = await createProposal(h, '6000000');
      const result = await evaluate(h, proposal.proposalId);

      expect(result.decision).toMatchObject({ status: 'RESIZE', requestedAmountIn: '6000000', approvedAmountIn: '5000000' });
      expect(h.calls.quoteAmounts).toEqual(['6000000', '5000000']);
      expect(Date.parse(result.decision.evaluatedAt)).toBeGreaterThan(Date.parse(h.calls.quoteTimes.at(-1)!));
    } finally { await h.close(); }
  });

  it('fails closed when a delayed resize quote arrives after intent expiry', async () => {
    let timeMs = NOW.getTime();
    const h = createHarness('1000000', false, () => new Date(timeMs), async (amountIn) => {
      await Promise.resolve();
      if (amountIn === '5000000') timeMs = NOW.getTime() + 60_001;
    });
    try {
      const proposal = await createProposal(h, '6000000');
      const result = await evaluate(h, proposal.proposalId);

      expect(result.decision).toMatchObject({ status: 'BLOCK', approvedAmountIn: null });
      expect(result.decision.reasons).toContain('INTENT_EXPIRED');
      expect(h.calls.quoteAmounts).toEqual(['6000000', '5000000']);
    } finally { await h.close(); }
  });

  it('reserves exactly the resized G2 amount without creating a G3c authorization or paper fill, and reopens the audit', async () => {
    const h = createHarness();
    let proposalId = '';
    let intentId = '';
    try {
      const proposal = await createProposal(h, '6000000');
      proposalId = proposal.proposalId;
      intentId = proposal.intent.intentId;
      const result = await evaluate(h, proposalId);
      expect(result.decision.status).toBe('RESIZE');
      expect(result.decision.requestedAmountIn).toBe('6000000');
      expect(result.decision.approvedAmountIn).toBe('5000000');
      expect(h.calls.quoteAmounts).toEqual(['6000000', '5000000']);

      const response = await h.app.inject({ headers: h.operatorHeaders,
        method: 'POST', url: '/v1/production/reservations', payload: { proposalId, sessionId: SESSION_ID },
      });
      expect(response.statusCode).toBe(201);
      const reserved = h.execution.get(proposalId);
      expect(reserved.transaction.amountIn).toBe('5000000');
      expect(reserved.decision.approvedAmountIn).toBe('5000000');
      expect(reserved.authorization).toBeNull();
      expect(reserved.simulation).toBeNull();
      expect(h.g3c.status(proposalId).status).toBe('NOT_STARTED');
      expect(h.store.getIntent(intentId)).toBeNull();

      for (const path of ['/v1/production/executions/sign', '/v1/production/executions/broadcast']) {
        const unavailable = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: path, payload: { proposalId } });
        expect(unavailable.statusCode).toBe(404);
      }
      expect(h.calls.simulation).toBe(0);
      expect(h.calls.recovery).toBe(0);
    } finally { await h.close(true); }

    const reopened = openD2AuditStore({ databasePath: h.auditPath });
    try {
      expect(reopened.getProposal(proposalId)?.proposalId).toBe(proposalId);
      expect(reopened.getEvaluation(proposalId)?.decision.approvedAmountIn).toBe('5000000');
    } finally {
      reopened.close();
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('fails stale evidence into review and blocks reservation and simulation', async () => {
    const h = createHarness('1000000', true);
    try {
      const proposal = await createProposal(h, '4000000');
      const result = await evaluate(h, proposal.proposalId);
      expect(result.decision.status).toBe('REQUIRE_REVIEW');
      expect(result.decision.approvedAmountIn).toBeNull();
      const reserve = await h.app.inject({ headers: h.operatorHeaders,
        method: 'POST', url: '/v1/production/reservations', payload: { proposalId: proposal.proposalId, sessionId: SESSION_ID },
      });
      expect(reserve.statusCode).toBe(409);
      const simulate = await h.app.inject({ headers: h.operatorHeaders,
        method: 'POST', url: '/v1/production/executions/simulate',
        payload: { proposalId: proposal.proposalId, sessionId: SESSION_ID, operationId: randomUUID() },
      });
      expect(simulate.statusCode).toBe(409);
      expect(h.calls.simulation).toBe(0);
      expect(h.calls.recovery).toBe(0);
      expect(h.store.getIntent(proposal.intent.intentId)).toBeNull();
    } finally { await h.close(); }
  });
});

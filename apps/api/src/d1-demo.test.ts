import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  d1EvaluateIntentResponseSchema,
  d1G3cFixtureSchema,
  d1ProposalSchema,
} from '@ered-luin/contracts';
import { createApiApp } from './api.js';
import { createD1DemoService } from './d1-demo.js';
import { initializePaperStore, type PaperStore } from './paper-store.js';

const now = new Date('2026-09-24T16:00:00.000Z');
let directory: string;
let store: PaperStore;
let app: ReturnType<typeof createApiApp>;
let activeClock: () => Date;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'ered-luin-d1-api-'));
  activeClock = () => now;
  const clock = () => activeClock();
  store = initializePaperStore({ databasePath: join(directory, 'paper.sqlite'), clock });
  app = createApiApp({ store, d1Demo: createD1DemoService({ clock }), clock });
});
afterEach(async () => {
  try { await app.close(); } catch { /* The API onClose hook may already have closed the store. */ }
  rmSync(directory, { recursive: true, force: true });
});

async function buildAndEvaluate(scenarioId: 'ALLOW' | 'RESIZE' | 'BLOCK' | 'REVIEW') {
  const created = await app.inject({
    method: 'POST', url: '/v1/demo/proposals', payload: { scenarioId },
  });
  expect(created.statusCode).toBe(201);
  const proposal = d1ProposalSchema.parse(created.json());
  const evaluated = await app.inject({
    method: 'POST', url: '/v1/intents/evaluate', payload: { proposalId: proposal.proposalId },
  });
  expect(evaluated.statusCode).toBe(201);
  const response = d1EvaluateIntentResponseSchema.parse(evaluated.json());
  const retrieved = await app.inject({
    method: 'GET', url: '/v1/intents/' + proposal.intent.intentId,
  });
  expect(retrieved.statusCode).toBe(200);
  return { proposal, response, record: retrieved.json() };
}

describe('D1 synthetic proposal to G2 paper audit', () => {
  it('routes allow, exact resize, block, and evidence-review cases through the API and persisted store', async () => {
    const allow = await buildAndEvaluate('ALLOW');
    expect(allow.response.record.decision.status).toBe('ALLOW');
    expect(allow.response.record.execution).toMatchObject({ mode: 'PAPER', status: 'SIMULATED', transactionHash: null });
    expect(allow.record.decision.decisionId).toBe(allow.response.record.decision.decisionId);
    expect(allow.record.signalIds).toEqual(allow.response.record.signalIds);
    expect(allow.proposal.evidence.source).toBe('synthetic');
    expect(allow.proposal.evidence.label).toBe('SYNTHETIC FIXTURE — NOT MARKET EVIDENCE');

    const resized = await buildAndEvaluate('RESIZE');
    expect(resized.response.record.decision).toMatchObject({
      status: 'RESIZE', requestedAmountIn: '7000000', approvedAmountIn: '5000000',
    });
    expect(resized.response.record.execution.status).toBe('SIMULATED');

    const blocked = await buildAndEvaluate('BLOCK');
    expect(blocked.response.record.decision.status).toBe('BLOCK');
    expect(blocked.response.record.execution.status).toBe('NOT_STARTED');
    expect(blocked.response.record.reservationId).toBeNull();
    expect(store.getAccount(blocked.proposal.intent.walletAddress)).toMatchObject({
      version: 0, usdcBalanceAtomic: '20000000', wethBalanceAtomic: '0',
    });

    const review = await buildAndEvaluate('REVIEW');
    expect(review.response.record.decision.status).toBe('REQUIRE_REVIEW');
    expect(review.response.record.execution.status).toBe('NOT_STARTED');
    expect(review.response.record.reservationId).toBeNull();
    expect(review.proposal.evidence.observations.some((signal) => signal.quality === 'PARTIAL')).toBe(true);
    expect(review.proposal.evidence.observations.some((signal) => signal.quality === 'MISSING')).toBe(true);
    expect(store.getAccount(review.proposal.intent.walletAddress)).toMatchObject({
      version: 0, usdcBalanceAtomic: '20000000', wethBalanceAtomic: '0',
    });
  });

  it('re-quotes a resized D1 proposal against the refreshed injected clock', async () => {
    let tick = 0;
    activeClock = () => new Date(now.getTime() + tick++);

    const resized = await buildAndEvaluate('RESIZE');

    expect(resized.response.record.decision).toMatchObject({
      status: 'RESIZE', requestedAmountIn: '7000000', approvedAmountIn: '5000000', reasons: expect.arrayContaining(['RESIZED_QUOTE_VALIDATED']),
    });
    expect(Date.parse(resized.response.record.decision.evaluatedAt)).toBeGreaterThan(Date.parse(resized.proposal.createdAt));
  });

  it('changes the policy outcome when only the synthetic WETH netflow value changes', async () => {
    const positive = await buildAndEvaluate('ALLOW');
    const negative = await buildAndEvaluate('BLOCK');
    const positiveFlow = positive.proposal.evidence.observations.find((signal) =>
      signal.endpoint === 'SMART_MONEY_NETFLOW' && signal.asset === 'WETH');
    const negativeFlow = negative.proposal.evidence.observations.find((signal) =>
      signal.endpoint === 'SMART_MONEY_NETFLOW' && signal.asset === 'WETH');

    expect(positiveFlow?.value).toBe('23000000000');
    expect(negativeFlow?.value).toBe('-1000000');
    expect(positive.response.record.decision.status).toBe('ALLOW');
    expect(negative.response.record.decision.status).toBe('BLOCK');
  });

  it('exercises typed pending, confirmed, reverted, and unknown G3c status fixtures', async () => {
    for (const status of ['pending', 'confirmed', 'reverted', 'unknown'] as const) {
      const result = await app.inject({ method: 'GET', url: '/v1/demo/g3c-status/' + status });
      expect(result.statusCode).toBe(200);
      const fixture = d1G3cFixtureSchema.parse(result.json());
      expect(fixture.label).toBe('SYNTHETIC G3C STATUS FIXTURE — NOT A CHAIN RECEIPT');
      expect(fixture.status.status).toBe(status.toUpperCase());
      expect(fixture.status.mode).toBe('LIVE_DISABLED');
      if (status === 'confirmed' || status === 'reverted') {
        expect(fixture.status.receipt?.payload.environment).toBe('synthetic-test');
        expect(fixture.status.actualFeesUsdcMicros).toBe('12000');
      }
    }
  });

  it('keeps paid Nansen and live execution disabled and rejects malformed demo input', async () => {
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.json()).toMatchObject({
      executionMode: 'PAPER', paidNansenCallsEnabled: false, activeNansenCreditBudget: 0, liveExecutionEnabled: false,
    });
    const malformed = await app.inject({
      method: 'POST', url: '/v1/demo/proposals', payload: { scenarioId: 'ALLOW', amountIn: '1' },
    });
    expect(malformed.statusCode).toBe(400);
  });
});
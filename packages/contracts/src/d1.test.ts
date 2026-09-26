import { describe, expect, it } from 'vitest';
import {
  d1EvaluateIntentResponseSchema,
  d1ProposalSchema,
  type D1Proposal,
} from './index.js';

const id = '00000000-0000-4000-8000-000000000001';
const signalId = '00000000-0000-4000-8000-000000000002';
const at = '2026-09-24T16:00:00.000Z';

function proposal(): D1Proposal {
  return d1ProposalSchema.parse({
    proposalId: id, scenarioId: 'ALLOW', createdAt: at,
    intent: {
      intentId: id, chainId: 8453, walletAddress: '0x0000000000000000000000000000000000000011',
      sellAsset: 'USDC', buyAsset: 'WETH', amountIn: '4000000', issuedAt: at, expiresAt: '2026-09-24T16:01:00.000Z',
    },
    analysis: {
      source: 'DETERMINISTIC_REPLAY', version: 'd1-rule-v1', rationale: 'Synthetic evidence and policy remain separate.',
      semantic: { provider: 'none', status: 'NOT_CONFIGURED', authority: 'NONE', advisoryRoute: 'ASTRA_REVIEW',
        answer: null, questionVersion: null, requestsMade: 0 },
    },
    evidence: {
      label: 'SYNTHETIC FIXTURE — NOT MARKET EVIDENCE', source: 'synthetic',
      observationIds: [signalId],
      observations: [{
        signalId, provider: 'synthetic', endpoint: 'SMART_MONEY_NETFLOW', chainId: 8453,
        asset: 'WETH', metric: 'net_flow_1h_usd', observedAt: at, fetchedAt: at,
        quality: 'COMPLETE', value: '23000000000', unit: 'usd_micros', provenanceId: 'fixture:d1',
      }],
      batches: [{
        operation: 'SMART_MONEY_NETFLOW', status: 'fresh', source: 'synthetic', completeness: 'complete',
        fetchedAt: at, acquiredAt: at, ageMs: 0, observationIds: [signalId],
      }],
    },
  });
}

describe('D1 shared contracts', () => {
  it('requires exact observation IDs and forbids proposal authority fields', () => {
    const valid = proposal();
    expect(d1ProposalSchema.safeParse(valid).success).toBe(true);
    expect(d1ProposalSchema.safeParse({
      ...valid, evidence: { ...valid.evidence, observationIds: [id] },
    }).success).toBe(false);
    expect(d1ProposalSchema.safeParse({ ...valid, executionMode: 'LIVE' }).success).toBe(false);
    const falseProvenance = { ...valid, evidence: { ...valid.evidence, observations: valid.evidence.observations.map((signal) => ({ ...signal, provider: 'nansen' as const })) } };
    expect(d1ProposalSchema.safeParse(falseProvenance).success).toBe(false);
  });

  it('requires the proposal identity to be the linked G2 intent identity', () => {
    const valid = proposal();
    expect(d1ProposalSchema.safeParse({
      ...valid, intent: { ...valid.intent, intentId: signalId },
    }).success).toBe(false);
  });

  it('rejects mismatched paper-result identities', () => {
    expect(d1EvaluateIntentResponseSchema.safeParse({
      record: {
        intent: proposal().intent,
        decision: {
          decisionId: id, intentId: signalId, status: 'ALLOW', evaluatedAt: at, policyVersion: 'g2-paper-v1',
          requestedAmountIn: '4000000', approvedAmountIn: '4000000', reasons: [],
        },
        execution: {
          intentId: id, mode: 'PAPER', status: 'SIMULATED', updatedAt: at, transactionHash: null, failureCode: null,
        },
        signalIds: [signalId], signalSource: 'synthetic', quoteSource: 'synthetic',
        reservationId: id,
      },
      replayed: false,
    }).success).toBe(false);
  });
});
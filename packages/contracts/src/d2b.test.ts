import { describe, expect, it } from 'vitest';
import {
  d2ExecutionActionResponseSchema, d2ExecutionReconcileRequestSchema,
  d2PrepareSignRequestSchema, d2RuntimeSchema, d2SubmitRequestSchema,
} from './d2.js';
import { runtimeConfigSchema } from './schemas.js';

const proposalId = '00000000-0000-4000-8000-000000000101';
const operationId = '00000000-0000-4000-8000-000000000102';
const sessionId = '00000000-0000-4000-8000-000000000103';
const idempotencyKey = '00000000-0000-4000-8000-000000000104';

describe('D2b shared execution contracts', () => {
  it('requires strict identities and separates prepare/sign, submit and reconcile requests', () => {
    const prepare = { proposalId, operationId, sessionId, idempotencyKey };
    expect(d2PrepareSignRequestSchema.safeParse(prepare).success).toBe(true);
    expect(d2PrepareSignRequestSchema.safeParse({ ...prepare, signedBytesHex: '0x02c0' }).success).toBe(false);
    expect(d2PrepareSignRequestSchema.safeParse({ ...prepare, sessionId: proposalId }).success).toBe(true);
    expect(d2SubmitRequestSchema.safeParse({ proposalId, operationId, idempotencyKey }).success).toBe(true);
    expect(d2SubmitRequestSchema.safeParse({ proposalId, operationId, idempotencyKey, rpcUrl: 'https://attacker.invalid' }).success).toBe(false);
    expect(d2ExecutionReconcileRequestSchema.safeParse({ proposalId, operationId, idempotencyKey }).success).toBe(true);
  });

  it('keeps runtime and response contracts free of caller-supplied execution bytes', () => {
    expect(d2RuntimeSchema.parse({
      service: 'ered-luin-api', status: 'degraded', appMode: 'PRODUCTION_READ_ONLY',
      paidNansenCallsEnabled: false, activeNansenCreditBudget: 0, liveExecutionEnabled: false,
      executionControls: { operatorAuthConfigured: false, signingEnabled: false, submissionEnabled: false, reviewedMode: false, browserWalletEnabled: false },
      nansenObservationStore: 'unconfigured', productionEvaluation: 'unconfigured', baseRpc: 'disabled',
      g3cStatusReader: 'configured', rpcRunBudget: null,
    }).executionControls).toMatchObject({ signingEnabled: false, submissionEnabled: false });
    expect(runtimeConfigSchema.parse({})).toMatchObject({
      NANSEN_API_ENABLED: 'false', NANSEN_CREDIT_BUDGET: '0', LIVE_EXECUTION_ENABLED: 'false', EXECUTION_MODE: 'paper',
    });
    const response = {
      proposalId, executionId: proposalId, operationId, sessionId, kind: 'SWAP', status: 'SIGNED_OUTBOX',
      permittedAmount: '4000000', transactionHash: '0x' + 'ab'.repeat(32), submissionAttempts: 0,
      receiptOutcome: null, receiptBlockNumber: null, actualFeesUsdcMicros: null, replayed: false,
    };
    expect(d2ExecutionActionResponseSchema.safeParse(response).success).toBe(true);
    expect(d2ExecutionActionResponseSchema.safeParse({ ...response, signedBytesHex: '0x02c0' }).success).toBe(false);
  });
});
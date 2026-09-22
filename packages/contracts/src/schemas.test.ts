import { describe, expect, it } from 'vitest';
import {
  auditEventSchema, decisionSchema, executionStateSchema, normalizedSignalSchema,
  runtimeConfigSchema, tradeIntentSchema,
} from './schemas.js';
import {
  syntheticMissingNetflow, syntheticPositiveNetflow, syntheticUsdcToWethIntent, syntheticZeroNetflow,
} from './fixtures.js';
import { validateTradeIntent } from './validation.js';
const now = new Date('2026-01-01T12:00:30.000Z');

describe('trade intent', () => {
  it('accepts exact-input integer-string quantities', () => {
    expect(tradeIntentSchema.safeParse(syntheticUsdcToWethIntent).success).toBe(true);
    expect(validateTradeIntent(syntheticUsdcToWethIntent, now).success).toBe(true);
  });
  it.each(['1.2', '1e6', '-1', '+1', '01', '0', ''])('rejects malformed amountIn %j', (amountIn) => {
    expect(tradeIntentSchema.safeParse({ ...syntheticUsdcToWethIntent, amountIn }).success).toBe(false);
  });
  it('rejects unsupported assets, chains, and arbitrary fields', () => {
    expect(tradeIntentSchema.safeParse({ ...syntheticUsdcToWethIntent, buyAsset: 'WBTC' }).success).toBe(false);
    expect(tradeIntentSchema.safeParse({ ...syntheticUsdcToWethIntent, chainId: 1 }).success).toBe(false);
    expect(tradeIntentSchema.safeParse({ ...syntheticUsdcToWethIntent, calldata: '0xdeadbeef' }).success).toBe(false);
  });
  it('rejects expired, future-issued, and inverted validity windows', () => {
    expect(validateTradeIntent({ ...syntheticUsdcToWethIntent, expiresAt: '2026-01-01T12:00:29.000Z' }, now))
      .toMatchObject({ success: false, issues: [{ code: 'INTENT_EXPIRED' }] });
    expect(validateTradeIntent({ ...syntheticUsdcToWethIntent, issuedAt: '2026-01-01T12:00:31.000Z' }, now))
      .toMatchObject({ success: false, issues: [{ code: 'INTENT_NOT_YET_VALID' }] });
    expect(validateTradeIntent({ ...syntheticUsdcToWethIntent, expiresAt: '2026-01-01T11:59:00.000Z' }, now).success).toBe(false);
  });
});

describe('shared contracts and safe defaults', () => {
  it('distinguishes complete, zero-valued, and missing signals', () => {
    expect(normalizedSignalSchema.safeParse(syntheticPositiveNetflow).success).toBe(true);
    expect(normalizedSignalSchema.safeParse(syntheticZeroNetflow).success).toBe(true);
    expect(normalizedSignalSchema.safeParse(syntheticMissingNetflow).success).toBe(true);
    expect(normalizedSignalSchema.safeParse({ ...syntheticMissingNetflow, value: '0' }).success).toBe(false);
  });
  it('accepts decisions, execution states, and audit events', () => {
    expect(decisionSchema.safeParse({
      decisionId: '00000000-0000-4000-8000-000000000010',
      intentId: syntheticUsdcToWethIntent.intentId, status: 'REQUIRE_REVIEW',
      evaluatedAt: '2026-01-01T12:00:30.000Z', policyVersion: 'g0-demo-v1',
      requestedAmountIn: '5000000', approvedAmountIn: null, reasons: ['Policy is a later gate'],
    }).success).toBe(true);
    expect(executionStateSchema.safeParse({
      intentId: syntheticUsdcToWethIntent.intentId, mode: 'PAPER', status: 'NOT_STARTED',
      updatedAt: '2026-01-01T12:00:30.000Z', transactionHash: null, failureCode: null,
    }).success).toBe(true);
    expect(auditEventSchema.safeParse({
      eventId: '00000000-0000-4000-8000-000000000011',
      occurredAt: '2026-01-01T12:00:30.000Z', actor: 'policy',
      entityId: syntheticUsdcToWethIntent.intentId, previousHash: null,
      eventHash: 'a'.repeat(64), kind: 'DECISION_RECORDED',
      decisionStatus: 'REQUIRE_REVIEW', policyVersion: 'g0-demo-v1',
    }).success).toBe(true);
  });
  it('defaults paid API requests and live execution off', () => {
    expect(runtimeConfigSchema.parse({})).toMatchObject({
      NANSEN_API_ENABLED: 'false', NANSEN_CREDIT_BUDGET: '0',
      LIVE_EXECUTION_ENABLED: 'false', EXECUTION_MODE: 'paper',
    });
    expect(runtimeConfigSchema.safeParse({ NANSEN_API_ENABLED: 'true' }).success).toBe(false);
  });
});

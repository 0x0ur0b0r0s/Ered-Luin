import { z } from 'zod';
export const SUPPORTED_CHAIN_ID = 8453 as const;
export const SUPPORTED_ASSETS = ['USDC', 'WETH'] as const;
export const ISO_TIMESTAMP = z.iso.datetime({ offset: true });
export const UNSIGNED_INTEGER_STRING = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const POSITIVE_INTEGER_STRING = z.string().regex(/^[1-9][0-9]*$/);
export const EVM_ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const tradeIntentSchema = z.object({
  intentId: z.uuid(), chainId: z.literal(SUPPORTED_CHAIN_ID), walletAddress: EVM_ADDRESS,
  sellAsset: z.enum(SUPPORTED_ASSETS), buyAsset: z.enum(SUPPORTED_ASSETS),
  amountIn: POSITIVE_INTEGER_STRING, issuedAt: ISO_TIMESTAMP, expiresAt: ISO_TIMESTAMP,
}).strict().refine((intent) => intent.sellAsset !== intent.buyAsset, {
  message: 'Sell and buy assets must differ', path: ['buyAsset'],
});
export type TradeIntent = z.infer<typeof tradeIntentSchema>;

export const decisionStatusSchema = z.enum(['ALLOW', 'RESIZE', 'BLOCK', 'REQUIRE_REVIEW']);
export const decisionSchema = z.object({
  decisionId: z.uuid(), intentId: z.uuid(), status: decisionStatusSchema,
  evaluatedAt: ISO_TIMESTAMP, policyVersion: z.string().min(1).max(64),
  requestedAmountIn: POSITIVE_INTEGER_STRING, approvedAmountIn: UNSIGNED_INTEGER_STRING.nullable(),
  reasons: z.array(z.string().min(1).max(240)).max(32),
}).strict();
export type Decision = z.infer<typeof decisionSchema>;

export const signalKindSchema = z.enum(['TOKEN_SCREENER', 'FLOW_INTELLIGENCE', 'SMART_MONEY_NETFLOW']);
export const normalizedSignalSchema = z.object({
  signalId: z.uuid(), provider: z.enum(['nansen', 'synthetic']), endpoint: signalKindSchema,
  chainId: z.literal(SUPPORTED_CHAIN_ID), asset: z.enum(SUPPORTED_ASSETS),
  metric: z.string().min(1).max(80), observedAt: ISO_TIMESTAMP, fetchedAt: ISO_TIMESTAMP,
  quality: z.enum(['COMPLETE', 'PARTIAL', 'MISSING']),
  value: z.string().regex(/^-?(0|[1-9][0-9]*)$/).nullable(),
  unit: z.enum(['atomic', 'usd_micros', 'count']), provenanceId: z.string().min(1).max(160),
}).strict().refine(
  (s) => (s.quality === 'COMPLETE' && s.value !== null) || (s.quality !== 'COMPLETE' && s.value === null),
  { message: 'Complete signals need a value; partial and missing signals use null', path: ['value'] },
);
export type NormalizedSignal = z.infer<typeof normalizedSignalSchema>;

export const executionModeSchema = z.enum(['PAPER', 'LIVE']);
export const executionStatusSchema = z.enum([
  'NOT_STARTED', 'SIMULATED', 'AUTHORIZED', 'SIGNED', 'BROADCAST',
  'PENDING', 'CONFIRMED', 'FAILED', 'UNKNOWN',
]);
export const executionStateSchema = z.object({
  intentId: z.uuid(), mode: executionModeSchema, status: executionStatusSchema,
  updatedAt: ISO_TIMESTAMP, transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).nullable(),
  failureCode: z.string().min(1).max(80).nullable(),
}).strict();
export type ExecutionState = z.infer<typeof executionStateSchema>;

const auditEventBase = {
  eventId: z.uuid(), occurredAt: ISO_TIMESTAMP,
  actor: z.enum(['system', 'policy', 'worker', 'signer', 'external_agent']),
  entityId: z.uuid(), previousHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  eventHash: z.string().regex(/^[0-9a-f]{64}$/),
};
export const auditEventSchema = z.discriminatedUnion('kind', [
  z.object({ ...auditEventBase, kind: z.literal('DECISION_RECORDED'), decisionStatus: decisionStatusSchema, policyVersion: z.string().min(1).max(64) }).strict(),
  z.object({ ...auditEventBase, kind: z.literal('SIMULATION_COMPLETED'), result: z.enum(['PASSED', 'FAILED']), simulationId: z.uuid() }).strict(),
  z.object({ ...auditEventBase, kind: z.literal('AUTHORIZATION_ISSUED'), authorizationId: z.uuid(), expiresAt: ISO_TIMESTAMP }).strict(),
  z.object({ ...auditEventBase, kind: z.literal('EXECUTION_STATE_CHANGED'), state: executionStatusSchema }).strict(),
  z.object({ ...auditEventBase, kind: z.literal('KILL_SWITCH_CHANGED'), enabled: z.boolean() }).strict(),
]);
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const runtimeConfigSchema = z.object({
  NANSEN_API_ENABLED: z.enum(['true', 'false']).default('false'),
  NANSEN_CREDIT_BUDGET: UNSIGNED_INTEGER_STRING.default('0'),
  LIVE_EXECUTION_ENABLED: z.enum(['true', 'false']).default('false'),
  EXECUTION_MODE: z.enum(['paper', 'live']).default('paper'),
}).strict().superRefine((c, ctx) => {
  if (c.NANSEN_API_ENABLED === 'true' && c.NANSEN_CREDIT_BUDGET === '0') {
    ctx.addIssue({ code: 'custom', path: ['NANSEN_CREDIT_BUDGET'], message: 'Nansen requests require a positive credit budget' });
  }
  if (c.LIVE_EXECUTION_ENABLED === 'true' && c.EXECUTION_MODE !== 'live') {
    ctx.addIssue({ code: 'custom', path: ['EXECUTION_MODE'], message: 'Live execution must be selected explicitly' });
  }
});
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

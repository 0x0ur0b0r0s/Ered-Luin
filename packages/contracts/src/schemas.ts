import { z } from 'zod';
export const SUPPORTED_CHAIN_ID = 8453 as const;
export const SUPPORTED_ASSETS = ['USDC', 'WETH'] as const;
export const ISO_TIMESTAMP = z.iso.datetime({ offset: true });
export const UNSIGNED_INTEGER_STRING = z.string().max(128).regex(/^(0|[1-9][0-9]*)$/);
export const POSITIVE_INTEGER_STRING = z.string().max(128).regex(/^[1-9][0-9]*$/);
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

export const signalKindSchema = z.enum(['TOKEN_SCREENER', 'FLOW_INTELLIGENCE', 'SMART_MONEY_NETFLOW', 'TOKEN_OHLCV']);
export const normalizedSignalSchema = z.object({
  signalId: z.uuid(), provider: z.enum(['nansen', 'synthetic']), endpoint: signalKindSchema,
  chainId: z.literal(SUPPORTED_CHAIN_ID), asset: z.enum(SUPPORTED_ASSETS),
  metric: z.string().min(1).max(80), observedAt: ISO_TIMESTAMP, fetchedAt: ISO_TIMESTAMP,
  timeframe: z.enum(['1h', '1m']).optional(),
  quality: z.enum(['COMPLETE', 'PARTIAL', 'MISSING']),
  value: z.string().regex(/^-?(0|[1-9][0-9]*)$/).nullable(),
  unit: z.enum(['atomic', 'usd_micros', 'count']), provenanceId: z.string().min(1).max(160),
}).strict().refine(
  (s) => (s.quality === 'COMPLETE' && s.value !== null) || (s.quality !== 'COMPLETE' && s.value === null),
  { message: 'Complete signals need a value; partial and missing signals use null', path: ['value'] },
).superRefine((signal, ctx) => {
  if ((signal.endpoint === 'TOKEN_OHLCV' && (signal.timeframe !== '1m' || signal.asset !== 'USDC' || signal.metric !== 'price_usd' ||
      Date.parse(signal.observedAt) % 60_000 !== 0 || Date.parse(signal.observedAt) + 60_000 > Date.parse(signal.fetchedAt))) ||
      (signal.endpoint !== 'TOKEN_OHLCV' && signal.timeframe === '1m')) {
    ctx.addIssue({ code: 'custom', path: ['timeframe'], message: 'Signal resolution must match its endpoint and asset' });
  }
});export type NormalizedSignal = z.infer<typeof normalizedSignalSchema>;

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


// G3a internal execution lifecycle contracts. These describe synthetic envelopes
// and durable state; they do not establish production simulation or signer trust.
export const executionLifecycleStatusSchema = z.enum([
  'RESERVED', 'SIMULATED', 'AUTHORIZED', 'SIGNING_CLAIMED', 'SIGNED_OUTBOX',
  'SUBMISSION_UNCERTAIN', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'RELEASED',
]);
export const transactionDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const executionTransactionEnvelopeSchema = z.object({
  version: z.literal(1), chainId: z.literal(SUPPORTED_CHAIN_ID),
  walletAddress: EVM_ADDRESS, router: EVM_ADDRESS, recipient: EVM_ADDRESS,
  sellAsset: z.enum(SUPPORTED_ASSETS), buyAsset: z.enum(SUPPORTED_ASSETS),
  amountIn: POSITIVE_INTEGER_STRING, minimumAmountOut: POSITIVE_INTEGER_STRING,
  valueNativeWei: UNSIGNED_INTEGER_STRING, maxFeePerGasWei: POSITIVE_INTEGER_STRING,
  maxPriorityFeePerGasWei: UNSIGNED_INTEGER_STRING, maxTotalFeeWei: POSITIVE_INTEGER_STRING,
  chainNonce: UNSIGNED_INTEGER_STRING, expiresAt: ISO_TIMESTAMP,
}).strict().superRefine((value, ctx) => {
  if (value.sellAsset === value.buyAsset) ctx.addIssue({ code: 'custom', path: ['buyAsset'], message: 'Transaction assets must differ' });
  if (BigInt(value.maxPriorityFeePerGasWei) > BigInt(value.maxFeePerGasWei)) {
    ctx.addIssue({ code: 'custom', path: ['maxPriorityFeePerGasWei'], message: 'Priority fee cannot exceed the maximum fee' });
  }
});
export type ExecutionTransactionEnvelope = z.infer<typeof executionTransactionEnvelopeSchema>;

export const executionSimulationEvidenceSchema = z.object({
  version: z.literal(1), simulationId: z.uuid(), executionId: z.uuid(),
  transactionDigest: transactionDigestSchema, producerId: z.literal('synthetic-test-adapter'),
  outcome: z.enum(['PASSED', 'FAILED']), simulatedAt: ISO_TIMESTAMP, expiresAt: ISO_TIMESTAMP,
}).strict();
export type ExecutionSimulationEvidence = z.infer<typeof executionSimulationEvidenceSchema>;

export const executionAuthorizationEnvelopeSchema = z.object({
  version: z.literal(1), authorizationId: z.uuid(), executionId: z.uuid(), intentId: z.uuid(), decisionId: z.uuid(),
  accountVersion: z.number().int().nonnegative().safe(), walletAddress: EVM_ADDRESS, chainId: z.literal(SUPPORTED_CHAIN_ID),
  router: EVM_ADDRESS, recipient: EVM_ADDRESS, sellAsset: z.enum(SUPPORTED_ASSETS), buyAsset: z.enum(SUPPORTED_ASSETS),
  amountIn: POSITIVE_INTEGER_STRING, minimumAmountOut: POSITIVE_INTEGER_STRING, valueNativeWei: UNSIGNED_INTEGER_STRING,
  maxFeePerGasWei: POSITIVE_INTEGER_STRING, maxPriorityFeePerGasWei: UNSIGNED_INTEGER_STRING,
  maxTotalFeeWei: POSITIVE_INTEGER_STRING, chainNonce: UNSIGNED_INTEGER_STRING,
  transactionDigest: transactionDigestSchema, simulationId: z.uuid(), authorizationNonce: z.uuid(),
  issuedAt: ISO_TIMESTAMP, expiresAt: ISO_TIMESTAMP,
}).strict();
export type ExecutionAuthorizationEnvelope = z.infer<typeof executionAuthorizationEnvelopeSchema>;

export const executionSigningClaimSchema = z.object({
  version: z.literal(1), claimId: z.uuid(), authorizationNonce: z.uuid(), accountVersion: z.number().int().nonnegative().safe(),
  claimedAt: ISO_TIMESTAMP,
}).strict();
export type ExecutionSigningClaim = z.infer<typeof executionSigningClaimSchema>;

export const executionSignedOutboxSchema = z.object({
  version: z.literal(1), transactionDigest: transactionDigestSchema, chainId: z.literal(SUPPORTED_CHAIN_ID),
  chainNonce: UNSIGNED_INTEGER_STRING, transactionHash: z.string().regex(/^0x[a-f0-9]{64}$/u),
  signedBytesDigest: transactionDigestSchema, signedBytesHex: z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/u).max(65_538),
  persistedAt: ISO_TIMESTAMP, broadcastAttempts: z.number().int().nonnegative().safe(),
}).strict();
export type ExecutionSignedOutbox = z.infer<typeof executionSignedOutboxSchema>;

export const executionReceiptEvidenceSchema = z.object({
  version: z.literal(1), receiptId: z.uuid(), chainId: z.literal(SUPPORTED_CHAIN_ID),
  transactionHash: z.string().regex(/^0x[a-f0-9]{64}$/u), transactionDigest: transactionDigestSchema,
  chainNonce: UNSIGNED_INTEGER_STRING, outcome: z.enum(['CONFIRMED', 'REVERTED']),
  blockNumber: UNSIGNED_INTEGER_STRING, blockHash: z.string().regex(/^0x[a-f0-9]{64}$/u),
  gasUsedNativeWei: POSITIVE_INTEGER_STRING, effectiveGasPriceWei: UNSIGNED_INTEGER_STRING, observedAt: ISO_TIMESTAMP,
}).strict();
export type ExecutionReceiptEvidence = z.infer<typeof executionReceiptEvidenceSchema>;

export const executionLifecycleRecordSchema = z.object({
  version: z.literal(1), executionId: z.uuid(), intentId: z.uuid(), decisionId: z.uuid(), walletAddress: EVM_ADDRESS,
  intent: tradeIntentSchema, decision: decisionSchema, reservationExposureUsdcMicros: POSITIVE_INTEGER_STRING, reservationReason: z.string().min(1).max(240),
  accountVersion: z.number().int().nonnegative().safe(), reservationId: z.uuid(), requestDigest: transactionDigestSchema,
  transaction: executionTransactionEnvelopeSchema, transactionDigest: transactionDigestSchema,
  status: executionLifecycleStatusSchema, simulation: executionSimulationEvidenceSchema.nullable(),
  authorization: executionAuthorizationEnvelopeSchema.nullable(), signingClaim: executionSigningClaimSchema.nullable(),
  signedOutbox: executionSignedOutboxSchema.nullable(), receipt: executionReceiptEvidenceSchema.nullable(),
  failureReason: z.string().min(1).max(240).nullable(), createdAt: ISO_TIMESTAMP, updatedAt: ISO_TIMESTAMP,
  revision: z.number().int().positive().safe(),
}).strict();
export type ExecutionLifecycleRecord = z.infer<typeof executionLifecycleRecordSchema>;

export const executionKillSwitchSchema = z.object({
  version: z.literal(1), stopped: z.boolean(), reason: z.string().min(1).max(240), changedAt: ISO_TIMESTAMP,
}).strict();
export type ExecutionKillSwitch = z.infer<typeof executionKillSwitchSchema>;


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
  EXECUTION_MODE: z.enum(['paper', 'live-reviewed', 'browser-wallet-reviewed']).default('paper'),
}).strict().superRefine((c, ctx) => {
  if (c.NANSEN_API_ENABLED === 'true' && c.NANSEN_CREDIT_BUDGET === '0') {
    ctx.addIssue({ code: 'custom', path: ['NANSEN_CREDIT_BUDGET'], message: 'Nansen requests require a positive credit budget' });
  }
  if (c.LIVE_EXECUTION_ENABLED === 'true' && !['live-reviewed', 'browser-wallet-reviewed'].includes(c.EXECUTION_MODE)) {
    ctx.addIssue({ code: 'custom', path: ['EXECUTION_MODE'], message: 'Live execution requires the explicit live-reviewed mode' });
  }
});
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

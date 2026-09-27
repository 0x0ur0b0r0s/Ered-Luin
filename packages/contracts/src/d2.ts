import { z } from 'zod';
import { decisionSchema, executionTransactionEnvelopeSchema, ISO_TIMESTAMP, normalizedSignalSchema, tradeIntentSchema } from './schemas.js';
import { g3cEvidenceAttestationSchema, g3cStatusResponseSchema, g3cWorkflowStatusSchema } from './g3c.js';
import { g3bUnsignedTransactionSchema } from './g3b.js';

const observationId = z.uuid();
const pageReferenceSchema = z.object({
  attemptId: z.string().min(1).max(128), status: z.number().int().min(100).max(599).nullable(),
  providerRequestId: z.string().min(1).max(128).nullable(), chargedCredits: z.number().int().nonnegative().safe().nullable(),
  page: z.number().int().min(1).max(20), received: z.boolean(), retry: z.number().int().min(0).max(2),
}).strict();

export const d2ObservationBatchSchema = z.object({
  snapshotId: observationId, operation: z.enum(['TOKEN_SCREENER', 'FLOW_INTELLIGENCE', 'SMART_MONEY_NETFLOW', 'TOKEN_OHLCV']),
  timeframe: z.enum(['1h', '1m']),
  source: z.literal('nansen'), status: z.enum(['fresh', 'stale', 'incomplete', 'failed']),
  completeness: z.enum(['complete', 'incomplete', 'unknown']), fetchedAt: ISO_TIMESTAMP, acquiredAt: ISO_TIMESTAMP,
  expiresAt: ISO_TIMESTAMP, ageMs: z.number().int().nonnegative().safe(), pageBound: z.number().int().min(1).max(20),
  retryBound: z.number().int().min(0).max(2), pageReferences: z.array(pageReferenceSchema).max(60),
  observationIds: z.array(observationId).max(64), unavailableFields: z.array(z.string().min(1).max(128)).max(128),
}).strict().superRefine((batch, ctx) => {
  if ((batch.operation === 'TOKEN_OHLCV' && (batch.timeframe !== '1m' || batch.pageBound !== 1 || batch.retryBound !== 0)) ||
      (batch.operation !== 'TOKEN_OHLCV' && batch.timeframe !== '1h')) {
    ctx.addIssue({ code: 'custom', path: ['timeframe'], message: 'Snapshot resolution and bounds must match its operation' });
  }
});
export type D2ObservationBatch = z.infer<typeof d2ObservationBatchSchema>;

export const d2EvidenceSchema = z.object({
  source: z.literal('nansen'), label: z.literal('PERSISTED NANSEN OBSERVATIONS'),
  observations: z.array(normalizedSignalSchema).max(64), observationIds: z.array(observationId).max(64),
  batches: z.array(d2ObservationBatchSchema).max(3),
}).strict().superRefine((evidence, ctx) => {
  const ids = evidence.observations.map((item) => item.signalId);
  if (evidence.observations.some((item) => item.provider !== 'nansen') || new Set(ids).size !== ids.length ||
      JSON.stringify([...ids].sort()) !== JSON.stringify([...evidence.observationIds].sort())) {
    ctx.addIssue({ code: 'custom', path: ['observationIds'], message: 'Production evidence must preserve unique Nansen observation identities' });
  }
  const batchIds = evidence.batches.flatMap((batch) => batch.observationIds);
  if (new Set(batchIds).size !== batchIds.length || JSON.stringify([...batchIds].sort()) !== JSON.stringify([...ids].sort())) {
    ctx.addIssue({ code: 'custom', path: ['batches'], message: 'Every production observation must link to exactly one stored snapshot' });
  }
  const signals = new Map(evidence.observations.map((signal) => [signal.signalId, signal]));
  for (const batch of evidence.batches) {
    for (const id of batch.observationIds) {
      const signal = signals.get(id);
      const lineageValid = signal?.endpoint === 'TOKEN_OHLCV'
        ? batch.timeframe === '1m' && signal.timeframe === '1m' &&
          Date.parse(signal.observedAt) + 60_000 <= Date.parse(signal.fetchedAt)
        : batch.timeframe === '1h' && signal?.observedAt === batch.acquiredAt;
      if (!signal || signal.endpoint !== batch.operation || signal.provider !== batch.source ||
          signal.fetchedAt !== batch.fetchedAt || !lineageValid) {
        ctx.addIssue({ code: 'custom', path: ['batches'], message: 'Snapshot timestamps, resolution and operation must match linked observations' });
        break;
      }
    }
  }
});
export type D2Evidence = z.infer<typeof d2EvidenceSchema>;

export const d2ProposalRequestSchema = z.object({
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/u), requestedUsdcMicros: z.string().max(78).regex(/^[1-9][0-9]*$/u),
}).strict();

const d2SemanticUnavailable = Object.freeze({
  status: 'UNAVAILABLE' as const, provider: 'none' as const, authority: 'NONE' as const,
  source: 'none' as const, reason: 'HANDOFF_DISABLED' as const,
});
const d2SemanticObservedBase = {
  provider: z.literal('typesafe-shadow'), authority: z.literal('NONE'), requestedModel: z.literal('jev-latest'),
  resolvedModel: z.string().regex(/^jev-(?:latest|[0-9]+\.[0-9]+\.[0-9]+)$/u),
  questionVersion: z.literal('g1d-analyst-review-v1'), attemptId: z.uuid(), requestHash: z.string().regex(/^[0-9a-f]{64}$/u),
  answer: z.number().min(0).max(1), advisoryRoute: z.enum(['STORE', 'WATCH', 'ASTRA_REVIEW']),
  evidenceSignalIds: z.array(z.uuid()).min(1).max(128),
};
export const d2SemanticHandoffSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('UNAVAILABLE'), provider: z.literal('none'), authority: z.literal('NONE'), source: z.literal('none'),
    reason: z.enum(['HANDOFF_DISABLED', 'NO_MATCHING_JUDGMENT', 'NO_OBSERVED_JUDGMENT', 'EVIDENCE_STALE', 'AUDIT_UNAVAILABLE']) }).strict(),
  z.object({ status: z.literal('FIXTURE'), ...d2SemanticObservedBase, source: z.literal('synthetic'),
    label: z.literal('SYNTHETIC FIXTURE — NOT MARKET ANALYSIS') }).strict(),
  z.object({ status: z.literal('OBSERVED'), ...d2SemanticObservedBase, source: z.literal('nansen') }).strict(),
]);
export type D2SemanticHandoff = z.infer<typeof d2SemanticHandoffSchema>;

const d2AnalysisBlockReason = z.enum([
  'NO_OBSERVATIONS', 'MISSING_REQUIRED_OPERATION', 'SYNTHETIC_EVIDENCE', 'STALE_EVIDENCE',
  'INCOMPLETE_EVIDENCE', 'PROPOSAL_NOT_FOUND', 'PROPOSAL_EVIDENCE_MISMATCH', 'AUDIT_UNAVAILABLE',
  'ANALYSIS_DISABLED', 'MISSING_CREDENTIAL', 'REVIEW_EXPIRED', 'REQUEST_HASH_MISMATCH',
  'AMBIGUOUS_ATTEMPT', 'PRIOR_ATTEMPT_EXISTS', 'INVALID_INPUT', 'INTERNAL_ERROR',
]);
export const d2AnalysisPreviewRequestSchema = z.object({ proposalId: z.uuid() }).strict();
export const d2AnalysisPreviewSchema = z.object({
  proposalId: z.uuid(), status: z.enum(['READY', 'UNAVAILABLE']), source: z.enum(['nansen', 'synthetic', 'mixed', 'none']),
  eligibility: z.enum(['ELIGIBLE', 'INELIGIBLE', 'CONTRADICTORY', 'INVALID']),
  authority: z.literal('NONE'), requestedModel: z.literal('jev-latest'), questionVersion: z.literal('g1d-analyst-review-v1'),
  generatedAt: ISO_TIMESTAMP, requestHash: z.string().regex(/^[0-9a-f]{64}$/u),
  proposalMatch: z.enum(['MATCHED', 'MISMATCHED', 'MISSING']), invocationEnabled: z.boolean(), credentialProviderConfigured: z.boolean(),
  canInvoke: z.boolean(), requestsMade: z.literal(0), missingPrerequisites: z.array(d2AnalysisBlockReason).max(16),
  inputs: z.array(z.object({ snapshotId: observationId, operation: z.enum(['TOKEN_SCREENER', 'FLOW_INTELLIGENCE', 'SMART_MONEY_NETFLOW', 'TOKEN_OHLCV']),
    source: z.enum(['nansen', 'synthetic']), status: z.enum(['fresh', 'cached', 'stale', 'incomplete', 'failed', 'disabled']),
    completeness: z.enum(['complete', 'incomplete', 'unknown']), fetchedAt: ISO_TIMESTAMP, ageMs: z.number().int().nonnegative().safe().nullable(),
    signalIds: z.array(observationId).max(64),
  }).strict()).max(3),
  features: z.array(z.object({ endpoint: z.enum(['TOKEN_SCREENER', 'FLOW_INTELLIGENCE', 'SMART_MONEY_NETFLOW', 'TOKEN_OHLCV']),
    asset: z.enum(['USDC', 'WETH']), metric: z.string().min(1).max(64), state: z.enum(['COMPLETE', 'ZERO', 'MISSING', 'PARTIAL', 'STALE', 'SYNTHETIC', 'CONTRADICTORY', 'INVALID']),
    quality: z.enum(['COMPLETE', 'PARTIAL', 'MISSING']), flags: z.array(z.enum(['MISSING', 'PARTIAL', 'STALE', 'SYNTHETIC', 'CONTRADICTORY', 'INVALID', 'DUPLICATE'])).max(7),
    signalIds: z.array(observationId).max(64),
  }).strict()).max(7),
}).strict();
export type D2AnalysisPreview = z.infer<typeof d2AnalysisPreviewSchema>;
export const d2AnalysisInvokeRequestSchema = z.object({ proposalId: z.uuid(), requestHash: z.string().regex(/^[0-9a-f]{64}$/u) }).strict();
export const d2AnalysisInvokeSchema = z.object({
  proposalId: z.uuid(), status: z.enum(['DISABLED', 'BLOCKED', 'CACHED', 'OBSERVED', 'UNAVAILABLE', 'INVALID_RESPONSE']),
  authority: z.literal('NONE'), requestsMade: z.union([z.literal(0), z.literal(1)]), approvedRequestHash: z.string().regex(/^[0-9a-f]{64}$/u),
  recordRequestHash: z.string().regex(/^[0-9a-f]{64}$/u).nullable(), attemptId: z.uuid().nullable(),
  requestedModel: z.literal('jev-latest'), resolvedModel: z.string().regex(/^jev-(?:latest|[0-9]+\.[0-9]+\.[0-9]+)$/u).nullable(),
  answer: z.number().min(0).max(1).nullable(), advisoryRoute: z.enum(['STORE', 'WATCH', 'ASTRA_REVIEW']).nullable(),
  reason: d2AnalysisBlockReason.nullable(),
}).strict();
export type D2AnalysisInvoke = z.infer<typeof d2AnalysisInvokeSchema>;
export const d2ProposalSchema = z.object({
  proposalId: z.uuid(), createdAt: ISO_TIMESTAMP, intent: tradeIntentSchema,
  analysis: z.object({
    source: z.literal('DETERMINISTIC_EVIDENCE_RULES'), version: z.literal('d2-rule-v1'),
    rationale: z.string().min(1).max(500), semanticStatus: z.enum(['NOT_CONFIGURED', 'UNAVAILABLE', 'FIXTURE', 'OBSERVED']).default('NOT_CONFIGURED'),
    semanticAuthority: z.literal('NONE'), semanticHandoff: d2SemanticHandoffSchema.default(d2SemanticUnavailable),
  }).strict(),
  evidence: d2EvidenceSchema,
}).strict().superRefine((proposal, ctx) => {
  if (proposal.proposalId !== proposal.intent.intentId) ctx.addIssue({ code: 'custom', path: ['intent', 'intentId'], message: 'Proposal identity must equal intent identity' });
});
export type D2Proposal = z.infer<typeof d2ProposalSchema>;

const d2QuoteSchema = z.object({
  source: z.enum(['pool', 'synthetic']), chainId: z.literal(8453), sellAsset: z.enum(['USDC', 'WETH']), buyAsset: z.enum(['USDC', 'WETH']),
  amountIn: z.string().max(78).regex(/^[1-9][0-9]*$/u), amountOut: z.string().max(78).regex(/^[1-9][0-9]*$/u),
  quotedAt: ISO_TIMESTAMP, slippageBps: z.number().int().min(0).max(100_000), priceImpactBps: z.number().int().min(0).max(100_000),
  feeUsdcMicros: z.string().max(78).regex(/^(0|[1-9][0-9]*)$/u), gasFeeNativeWei: z.string().max(78).regex(/^(0|[1-9][0-9]*)$/u),
}).strict();
const d2GasValuationSchema = z.object({ source: z.enum(['pool', 'synthetic']), chainId: z.literal(8453),
  amountInNativeWei: z.string().max(78).regex(/^[1-9][0-9]*$/u), valueUsdcMicros: z.string().max(78).regex(/^[1-9][0-9]*$/u), quotedAt: ISO_TIMESTAMP,
}).strict();
export const d2QuoteBundleSchema = z.object({
  accountVersion: z.number().int().nonnegative().safe(),
  positionQuote: d2QuoteSchema.nullable(), tradeQuote: d2QuoteSchema.nullable(), projectedPositionQuote: d2QuoteSchema.nullable(),
  gasQuote: d2GasValuationSchema.nullable(), projectedGasQuote: d2GasValuationSchema.nullable(), gasFeeQuote: d2GasValuationSchema.nullable(),
}).strict();
export type D2QuoteBundle = z.infer<typeof d2QuoteBundleSchema>;
export const d2EvaluationRequestSchema = z.object({ proposalId: z.uuid(), sessionId: z.uuid().optional() }).strict();
export const d2ReservationRequestSchema = z.object({ proposalId: z.uuid(), sessionId: z.uuid() }).strict();
export const d2PrepareRequestSchema = z.object({ proposalId: z.uuid(), operationId: z.uuid(), sessionId: z.uuid() }).strict();
export const d2OperationRequestSchema = z.object({ proposalId: z.uuid(), operationId: z.uuid() }).strict();
export const d2SessionResponseSchema = z.object({ sessionId: z.uuid(), walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/u), status: z.literal('ACTIVE'), initialEquityUsdcMicros: z.string().max(78).regex(/^[1-9][0-9]*$/u), latestAccountVersion: z.number().int().positive().safe(), createdAt: ISO_TIMESTAMP }).strict();
export const d2SessionRequestSchema = z.object({ sessionId: z.uuid(), walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/u), reason: z.string().trim().min(1).max(240) }).strict();
export const d2EvaluationSchema = z.object({
  proposalId: z.uuid(), intent: tradeIntentSchema, decision: decisionSchema,
  evidenceIds: z.array(observationId).max(64), evidenceBatches: z.array(d2ObservationBatchSchema).max(3),
  signalSource: z.enum(['nansen', 'none']), quoteSource: z.enum(['pool', 'synthetic', 'none']),
  sessionId: z.uuid().nullable(), accountVersion: z.number().int().nonnegative().safe().nullable(), quoteBundle: d2QuoteBundleSchema.nullable(),
  executionTransaction: executionTransactionEnvelopeSchema.nullable(),
  g3cExecutionId: z.uuid().nullable(), g3cStatus: g3cStatusResponseSchema.nullable(),
  executionMode: z.literal('READ_ONLY'), paperFillCreated: z.literal(false),
  createdAt: ISO_TIMESTAMP, replayed: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.intent.intentId !== value.decision.intentId || value.proposalId !== value.intent.intentId ||
      (value.g3cStatus !== null && value.g3cStatus.executionId !== value.g3cExecutionId)) {
    ctx.addIssue({ code: 'custom', path: ['intent'], message: 'D2 proposal, policy and execution identities must agree' });
  }
});
export type D2Evaluation = z.infer<typeof d2EvaluationSchema>;

export const d2SimulationRequestSchema = z.object({ proposalId: z.uuid(), operationId: z.uuid(), sessionId: z.uuid() }).strict();
export const d2SimulationSchema = z.object({
  proposalId: z.uuid(), executionId: z.uuid(), operationId: z.uuid(), sessionId: z.uuid(), walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/u),
  accountVersion: z.number().int().positive().safe(), requestedAmount: z.string().max(78).regex(/^[1-9][0-9]*$/u),
  permittedAmount: z.string().max(78).regex(/^[1-9][0-9]*$/u), policyTransaction: executionTransactionEnvelopeSchema, transaction: g3bUnsignedTransactionSchema,
  quote: g3cEvidenceAttestationSchema.nullable(), simulation: g3cEvidenceAttestationSchema, fee: g3cEvidenceAttestationSchema,
  status: z.literal('SIMULATED'), executionMode: z.literal('READ_ONLY'), authorizationCreated: z.literal(false),
  signerInvocations: z.literal(0), broadcasterInvocations: z.literal(0), createdAt: ISO_TIMESTAMP,
}).strict().superRefine((value, ctx) => {
  if (value.policyTransaction.amountIn !== value.permittedAmount ||
      value.policyTransaction.walletAddress.toLowerCase() !== value.walletAddress.toLowerCase() ||
      value.transaction.from.toLowerCase() !== value.walletAddress.toLowerCase() || value.transaction.chainId !== 8453 ||
      value.simulation.payload.kind !== 'SIMULATION' || value.fee.payload.kind !== 'BASE_FEE' ||
      (value.quote !== null && value.quote.payload.kind !== 'QUOTE')) {
    ctx.addIssue({ code: 'custom', path: ['transaction'], message: 'D2 simulation must match the exact reserved amount, wallet, and provider evidence kinds' });
  }
  const identities = [
    value.quote?.payload.kind === 'QUOTE' ? value.quote.payload : null,
    value.simulation.payload.kind === 'SIMULATION' ? value.simulation.payload : null,
    value.fee.payload.kind === 'BASE_FEE' ? value.fee.payload : null,
  ];
  if (identities.some((payload) => payload !== null &&
      (payload.executionId !== value.executionId || payload.operationId !== value.operationId))) {
    ctx.addIssue({ code: 'custom', path: ['simulation'], message: 'D2 simulation evidence must bind to its exact execution and operation' });
  }
});
export type D2Simulation = z.infer<typeof d2SimulationSchema>;
export const d2OperatorLoginRequestSchema = z.object({ password: z.string().min(43).max(128).regex(/^[A-Za-z0-9_-]+$/u) }).strict();
export const d2OperatorSessionSchema = z.object({ configured: z.boolean(), authenticated: z.boolean(), expiresAt: ISO_TIMESTAMP.nullable() }).strict();
export const d2PrepareSignRequestSchema = z.object({ proposalId: z.uuid(), operationId: z.uuid(), sessionId: z.uuid(), idempotencyKey: z.uuid() }).strict();
export const d2SubmitRequestSchema = z.object({ proposalId: z.uuid(), operationId: z.uuid(), idempotencyKey: z.uuid() }).strict();
export const d2ExecutionReconcileRequestSchema = z.object({ proposalId: z.uuid(), operationId: z.uuid(), idempotencyKey: z.uuid() }).strict();
export type D2OperatorLoginRequest = z.infer<typeof d2OperatorLoginRequestSchema>;
export type D2OperatorSession = z.infer<typeof d2OperatorSessionSchema>;
export type D2PrepareSignRequest = z.infer<typeof d2PrepareSignRequestSchema>;
export type D2SubmitRequest = z.infer<typeof d2SubmitRequestSchema>;
export type D2ExecutionReconcileRequest = z.infer<typeof d2ExecutionReconcileRequestSchema>;
export const d2ExecutionActionResponseSchema = z.object({
  proposalId: z.uuid(), executionId: z.uuid(), operationId: z.uuid(), sessionId: z.uuid(), kind: z.enum(['APPROVAL', 'SWAP']),
  status: g3cWorkflowStatusSchema, permittedAmount: z.string().max(78).regex(/^[1-9][0-9]*$/u),
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/u).nullable(), submissionAttempts: z.number().int().nonnegative().safe(),
  receiptOutcome: z.enum(['PENDING', 'CONFIRMED', 'REVERTED']).nullable(), receiptBlockNumber: z.string().max(78).regex(/^(0|[1-9][0-9]*)$/u).nullable(),
  actualFeesUsdcMicros: z.string().max(78).regex(/^(0|[1-9][0-9]*)$/u).nullable(), replayed: z.boolean(),
}).strict();
export type D2ExecutionActionResponse = z.infer<typeof d2ExecutionActionResponseSchema>;

export const d2BrowserAllowancePreflightResponseSchema = z.object({
  proposalId: z.uuid(), executionId: z.uuid(), sessionId: z.uuid(), walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/u),
  chainId: z.literal(8453), tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/u), spenderAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/u),
  currentAllowanceAtomic: z.string().max(78).regex(/^(0|[1-9][0-9]*)$/u), requiredAmountAtomic: z.string().max(78).regex(/^[1-9][0-9]*$/u),
  status: z.enum(['APPROVAL_REQUIRED', 'ALLOWANCE_SUFFICIENT']),
}).strict();
export type D2BrowserAllowancePreflightResponse = z.infer<typeof d2BrowserAllowancePreflightResponseSchema>;
export const d2BrowserExecutionPrepareRequestSchema = z.object({ proposalId: z.uuid(), operationId: z.uuid(), sessionId: z.uuid() }).strict();
export const d2BrowserExecutionIdentityRequestSchema = z.object({ proposalId: z.uuid(), operationId: z.uuid() }).strict();
export const d2BrowserExecutionHashRequestSchema = z.object({ proposalId: z.uuid(), operationId: z.uuid(), transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/u) }).strict();
export const d2BrowserExecutionRejectRequestSchema = z.object({ proposalId: z.uuid(), operationId: z.uuid(), reason: z.enum(['USER_REJECTED', 'PRE_SEND_CONTEXT_CHANGED']) }).strict();
export const d2BrowserExecutionActionResponseSchema = z.object({
  proposalId: z.uuid(), executionId: z.uuid(), operationId: z.uuid(), sessionId: z.uuid(), kind: z.enum(['APPROVAL', 'SWAP']),
  status: g3cWorkflowStatusSchema,
  browserStage: z.enum(['READY', 'SUBMISSION_UNCERTAIN', 'SUBMITTED', 'RECONCILIATION_REQUIRED', 'CONFIRMED', 'REVERTED', 'REJECTED']),
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/u), transaction: g3bUnsignedTransactionSchema,
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/u).nullable(), submissionAttempts: z.number().int().nonnegative().safe(),
  receiptOutcome: z.enum(['PENDING', 'CONFIRMED', 'REVERTED', 'REPLACED', 'CONFLICT']).nullable(),
  receiptBlockNumber: z.string().max(78).regex(/^(0|[1-9][0-9]*)$/u).nullable(),
  actualFeesUsdcMicros: z.string().max(78).regex(/^(0|[1-9][0-9]*)$/u).nullable(), replayed: z.boolean(),
}).strict();
export type D2BrowserExecutionActionResponse = z.infer<typeof d2BrowserExecutionActionResponseSchema>;


export const d2RuntimeSchema = z.object({
  service: z.literal('ered-luin-api'), status: z.enum(['ok', 'degraded']), appMode: z.enum(['PRODUCTION_READ_ONLY', 'SYNTHETIC_REPLAY', 'LIVE_REVIEWED']),
  paidNansenCallsEnabled: z.literal(false), activeNansenCreditBudget: z.literal(0), liveExecutionEnabled: z.boolean(),
  executionControls: z.object({ operatorAuthConfigured: z.boolean(), signingEnabled: z.boolean(), submissionEnabled: z.boolean(), reviewedMode: z.boolean(), browserWalletEnabled: z.boolean() }).strict(),
  nansenObservationStore: z.enum(['configured', 'unconfigured']), productionEvaluation: z.enum(['configured', 'unconfigured']),
  baseRpc: z.enum(['disabled', 'configured_but_gated', 'read_only_enabled']), g3cStatusReader: z.enum(['configured', 'unconfigured']),
  rpcRunBudget: z.object({ maxRequests: z.number().int().nonnegative().safe(), usedRequests: z.number().int().nonnegative().safe(), recoveryReserve: z.number().int().nonnegative().safe() }).strict().nullable(),
}).strict();
export type D2Runtime = z.infer<typeof d2RuntimeSchema>;

export const d2EvidenceResponseSchema = z.object({
  source: z.literal('nansen'), label: z.literal('PERSISTED NANSEN OBSERVATIONS'),
  observations: z.array(normalizedSignalSchema).max(64), batches: z.array(d2ObservationBatchSchema).max(3),
  freshness: z.enum(['fresh', 'stale', 'incomplete', 'missing']),
}).strict();
export type D2EvidenceResponse = z.infer<typeof d2EvidenceResponseSchema>;

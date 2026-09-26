import { z } from 'zod';
import { g3cStatusResponseSchema } from './g3c.js';
import {
  decisionSchema,
  executionStateSchema,
  ISO_TIMESTAMP,
  normalizedSignalSchema,
  tradeIntentSchema,
} from './schemas.js';

export const d1HealthResponseSchema = z.object({
  service: z.literal('ered-luin-api'),
  status: z.literal('ok'),
  executionMode: z.literal('PAPER'),
  paidNansenCallsEnabled: z.literal(false),
  activeNansenCreditBudget: z.literal(0),
  liveExecutionEnabled: z.literal(false),
}).strict();
export const d1ScenarioIdSchema = z.enum(['ALLOW', 'RESIZE', 'BLOCK', 'REVIEW']);
export type D1ScenarioId = z.infer<typeof d1ScenarioIdSchema>;

export const d1ScenarioSchema = z.object({
  id: d1ScenarioIdSchema,
  title: z.string().min(1).max(80),
  description: z.string().min(1).max(240),
}).strict();
export type D1Scenario = z.infer<typeof d1ScenarioSchema>;
export const d1ScenarioListResponseSchema = z.object({ scenarios: z.array(d1ScenarioSchema) }).strict();

export const d1ProposalRequestSchema = z.object({ scenarioId: d1ScenarioIdSchema }).strict();

export const d1ObservationBatchSchema = z.object({
  operation: z.enum(['TOKEN_SCREENER', 'FLOW_INTELLIGENCE', 'SMART_MONEY_NETFLOW']),
  status: z.enum(['fresh', 'cached', 'stale', 'incomplete', 'failed', 'disabled']),
  source: z.literal('synthetic'),
  completeness: z.enum(['complete', 'incomplete', 'unknown']),
  fetchedAt: ISO_TIMESTAMP.nullable(),
  acquiredAt: ISO_TIMESTAMP.nullable(),
  ageMs: z.number().int().nonnegative().safe().nullable(),
  observationIds: z.array(z.uuid()).max(32),
}).strict();

export const d1SemanticAnalysisSchema = z.object({
  provider: z.enum(['none', 'typesafe-shadow']),
  status: z.enum(['NOT_CONFIGURED', 'DISABLED', 'INVALID_INPUT', 'OBSERVED', 'UNAVAILABLE', 'INVALID_RESPONSE']),
  authority: z.literal('NONE'),
  advisoryRoute: z.enum(['STORE', 'WATCH', 'ASTRA_REVIEW']),
  answer: z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) }).strict().nullable(),
  questionVersion: z.string().min(1).max(80).nullable(),
  requestsMade: z.union([z.literal(0), z.literal(1)]),
}).strict();

export const d1ProposalSchema = z.object({
  proposalId: z.uuid(),
  scenarioId: d1ScenarioIdSchema,
  createdAt: ISO_TIMESTAMP,
  intent: tradeIntentSchema,
  analysis: z.object({
    source: z.literal('DETERMINISTIC_REPLAY'),
    version: z.literal('d1-rule-v1'),
    rationale: z.string().min(1).max(500),
    semantic: d1SemanticAnalysisSchema,
  }).strict(),
  evidence: z.object({
    label: z.literal('SYNTHETIC FIXTURE — NOT MARKET EVIDENCE'),
    source: z.literal('synthetic'),
    observationIds: z.array(z.uuid()).max(64),
    observations: z.array(normalizedSignalSchema).max(64),
    batches: z.array(d1ObservationBatchSchema).max(3),
  }).strict(),
}).strict().superRefine((proposal, ctx) => {
  if (proposal.proposalId !== proposal.intent.intentId) {
    ctx.addIssue({ code: 'custom', path: ['intent', 'intentId'], message: 'Proposal and intent identity must match' });
  }
  const signals = proposal.evidence.observations;
  const signalById = new Map(signals.map((signal) => [signal.signalId, signal]));
  const observationIds = signals.map((signal) => signal.signalId);
  if (new Set(observationIds).size !== observationIds.length ||
      JSON.stringify([...observationIds].sort()) !== JSON.stringify([...proposal.evidence.observationIds].sort())) {
    ctx.addIssue({ code: 'custom', path: ['evidence', 'observationIds'], message: 'Evidence IDs must exactly match normalized observations' });
  }
  if (signals.some((signal) => signal.provider !== 'synthetic')) {
    ctx.addIssue({ code: 'custom', path: ['evidence', 'observations'], message: 'Synthetic replay cannot claim live provider provenance' });
  }
  const batchIds = proposal.evidence.batches.flatMap((batch) => batch.observationIds);
  if (batchIds.length !== observationIds.length || new Set(batchIds).size !== batchIds.length ||
      JSON.stringify([...batchIds].sort()) !== JSON.stringify([...observationIds].sort())) {
    ctx.addIssue({ code: 'custom', path: ['evidence', 'batches'], message: 'Query batches must account for every observation exactly once' });
  }
  for (const batch of proposal.evidence.batches) {
    for (const signalId of batch.observationIds) {
      const signal = signalById.get(signalId);
      if (!signal || signal.endpoint !== batch.operation || signal.provider !== batch.source ||
          signal.fetchedAt !== batch.fetchedAt || signal.observedAt !== batch.acquiredAt ||
          (batch.completeness !== 'complete' && signal.quality === 'COMPLETE')) {
        ctx.addIssue({ code: 'custom', path: ['evidence', 'batches'], message: 'Query metadata must match every normalized signal' });
        break;
      }
    }
  }
});export type D1Proposal = z.infer<typeof d1ProposalSchema>;

export const d1EvaluateIntentRequestSchema = z.object({ proposalId: z.uuid() }).strict();

export const d1PaperIntentRecordSchema = z.object({
  intent: tradeIntentSchema,
  decision: decisionSchema,
  execution: executionStateSchema,
  signalIds: z.array(z.uuid()).max(64),
  signalSource: z.enum(['nansen', 'synthetic', 'none', 'mixed']),
  quoteSource: z.enum(['pool', 'synthetic', 'none', 'mixed']),
  reservationId: z.uuid().nullable(),
}).strict();

export const d1EvaluateIntentResponseSchema = z.object({
  record: d1PaperIntentRecordSchema,
  replayed: z.boolean(),
}).strict().superRefine((response, ctx) => {
  if (response.record.intent.intentId !== response.record.decision.intentId ||
      response.record.intent.intentId !== response.record.execution.intentId) {
    ctx.addIssue({ code: 'custom', path: ['record'], message: 'Paper result identities do not match' });
  }
  if (new Set(response.record.signalIds).size !== response.record.signalIds.length) {
    ctx.addIssue({ code: 'custom', path: ['record', 'signalIds'], message: 'Paper result signal IDs must be unique' });
  }
});

export const d1G3cFixtureSchema = z.object({
  label: z.literal('SYNTHETIC G3C STATUS FIXTURE — NOT A CHAIN RECEIPT'),
  status: g3cStatusResponseSchema,
}).strict();
export type D1G3cFixture = z.infer<typeof d1G3cFixtureSchema>;

export const d1G3cStatusNameSchema = z.enum(['PENDING', 'CONFIRMED', 'REVERTED', 'UNKNOWN']);
export type D1G3cStatusName = z.infer<typeof d1G3cStatusNameSchema>;
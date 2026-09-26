import Fastify, { type FastifyInstance } from 'fastify';
import { d1EvaluateIntentRequestSchema, d1G3cFixtureSchema, d1G3cStatusNameSchema, d1ProposalRequestSchema, d1ProposalSchema, d1ScenarioSchema, g3cStatusResponseSchema, normalizedSignalSchema, tradeIntentSchema, type G3cStatusResponse } from '@ered-luin/contracts';
import type { NormalizedSignal, TradeIntent } from '@ered-luin/contracts';
import { evaluateG2Intent, validateGasValuationQuote, validatePaperQuote, type G2Evaluation, type G2QuoteBundle, type PaperAccountSnapshot } from './policy.js';
import { PaperStore, PaperStoreError, type PaperIntentRecord } from './paper-store.js';
import type { D1DemoService } from './d1-demo.js';
import { d2EvaluationRequestSchema, d2EvaluationSchema, d2OperationRequestSchema, d2SimulationRequestSchema, d2SimulationSchema, d2ProposalRequestSchema, d2ProposalSchema, d2ReservationRequestSchema, d2RuntimeSchema, d2SessionRequestSchema, d2SessionResponseSchema, type D2Runtime } from '@ered-luin/contracts';
import type { D2ProductionService } from './d2-production.js';
import {
  d2ExecutionReconcileRequestSchema, d2ExecutionActionResponseSchema, d2OperatorLoginRequestSchema,
  d2OperatorSessionSchema, d2PrepareSignRequestSchema, d2SubmitRequestSchema,
} from '@ered-luin/contracts';
import type { D2ExecutionService } from './d2-execution.js';
import type { LocalOperatorAuthenticator, OperatorRequestContext, OperatorPrincipal } from './operator-auth.js';
import { d2AnalysisInvokeRequestSchema, d2AnalysisInvokeSchema, d2AnalysisPreviewRequestSchema, d2AnalysisPreviewSchema } from '@ered-luin/contracts';
import type { D2FreshAnalysisService } from './d2-fresh-analysis.js';

export interface G2DataProvider {
  getSignals(): Promise<readonly unknown[]> | readonly unknown[];
  getQuoteBundle(intent: TradeIntent, account: PaperAccountSnapshot): Promise<unknown> | unknown;
  close?(): void;
}
export interface CreateApiOptions {
  readonly store: PaperStore;
  readonly dataProvider?: G2DataProvider;
  readonly g3cStatusReader?: { status(executionId: string): G3cStatusResponse };
  readonly d1Demo?: D1DemoService;
  readonly d2Production?: D2ProductionService;
  readonly d2FreshAnalysis?: D2FreshAnalysisService;
  readonly d2Execution?: D2ExecutionService;
  readonly operatorAuth?: LocalOperatorAuthenticator;
  readonly d2Runtime?: () => D2Runtime;
  readonly clock?: () => Date;
}
export interface EvaluateIntentResponse { readonly record: PaperIntentRecord; readonly replayed: boolean; }

export const EMPTY_G2_DATA_PROVIDER: G2DataProvider = Object.freeze({
  getSignals: () => Object.freeze([]),
  getQuoteBundle: () => null,
});

function parseSignals(value: readonly unknown[]): readonly NormalizedSignal[] | null {
  if (!Array.isArray(value) || value.length > 5000) return null;
  const signals: NormalizedSignal[] = [];
  for (const candidate of value) {
    const parsed = normalizedSignalSchema.safeParse(candidate);
    if (!parsed.success) return null;
    signals.push(parsed.data);
  }
  return Object.freeze(signals);
}
export function parseQuoteBundle(value: unknown, account: PaperAccountSnapshot): G2QuoteBundle | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 7 || !['accountVersion','positionQuote','tradeQuote','projectedPositionQuote','gasQuote','projectedGasQuote','gasFeeQuote'].every((key) => Object.hasOwn(input, key)) ||
      !Number.isSafeInteger(input.accountVersion) || input.accountVersion !== account.version) return null;
  const positionQuote = input.positionQuote === null ? null : validatePaperQuote(input.positionQuote);
  const tradeQuote = input.tradeQuote === null ? null : validatePaperQuote(input.tradeQuote);
  const projectedPositionQuote = input.projectedPositionQuote === null ? null : validatePaperQuote(input.projectedPositionQuote);
  const gasQuote = input.gasQuote === null ? null : validateGasValuationQuote(input.gasQuote);
  const projectedGasQuote = input.projectedGasQuote === null ? null : validateGasValuationQuote(input.projectedGasQuote);
  const gasFeeQuote = input.gasFeeQuote === null ? null : validateGasValuationQuote(input.gasFeeQuote);
  if ((input.positionQuote !== null && !positionQuote) || (input.tradeQuote !== null && !tradeQuote) ||
      (input.projectedPositionQuote !== null && !projectedPositionQuote) || (input.gasQuote !== null && !gasQuote) ||
      (input.projectedGasQuote !== null && !projectedGasQuote) || (input.gasFeeQuote !== null && !gasFeeQuote)) return null;
  return Object.freeze({ accountVersion: account.version, positionQuote, tradeQuote, projectedPositionQuote, gasQuote, projectedGasQuote, gasFeeQuote });
}
function currentTime(clock: () => Date): Date {
  let date: Date;
  try { date = clock(); } catch { throw new Error('Clock unavailable.'); }
  if (!(date instanceof Date) || !Number.isSafeInteger(date.getTime()) || date.getTime() < 0) throw new Error('Clock unavailable.');
  return date;
}
function mergeQuoteSource(a: G2Evaluation['quoteSource'], b: G2Evaluation['quoteSource']): G2Evaluation['quoteSource'] {
  if (a === 'none') return b;
  if (b === 'none' || a === b) return a;
  return 'mixed';
}
export interface G2WithQuotesResult { readonly evaluation: G2Evaluation; readonly quotes: G2QuoteBundle | null; }
export async function evaluateWithResizeQuotes(
  intent: TradeIntent,
  signals: readonly unknown[],
  account: PaperAccountSnapshot,
  initialQuotes: G2QuoteBundle | null,
  now: Date,
  provider: G2DataProvider,
  clock: () => Date,
): Promise<G2WithQuotesResult> {
  let workingIntent = intent;
  let quotes = initialQuotes;
  let evaluation = evaluateG2Intent({ intent: workingIntent, signals, account, quotes, now });
  const decisionId = evaluation.decision.decisionId;
  const accumulatedReasons = [...evaluation.decision.reasons];
  let quoteSource = evaluation.quoteSource;
  for (let pass = 0; pass < 3 && evaluation.decision.status === 'RESIZE'; pass += 1) {
    const approved = evaluation.decision.approvedAmountIn;
    if (!approved || BigInt(approved) <= 0n || BigInt(approved) >= BigInt(workingIntent.amountIn)) {
      return { evaluation: { ...evaluation, decision: { ...evaluation.decision, status: 'REQUIRE_REVIEW', approvedAmountIn: null,
        reasons: [...accumulatedReasons, 'RESIZE_AMOUNT_INVALID'] }, projection: null }, quotes };
    }
    workingIntent = { ...workingIntent, amountIn: approved };
    try { quotes = parseQuoteBundle(await provider.getQuoteBundle(workingIntent, account), account); }
    catch { quotes = null; }
    const reevaluatedAt = currentTime(clock);
    if (!quotes) {
      const checked = evaluateG2Intent({ intent: workingIntent, signals, account, quotes: null, now: reevaluatedAt });
      const expired = checked.decision.status === 'BLOCK';
      return { evaluation: { ...checked, decision: { ...checked.decision, decisionId, intentId: intent.intentId,
        status: expired ? 'BLOCK' : 'REQUIRE_REVIEW', requestedAmountIn: intent.amountIn, approvedAmountIn: null,
        reasons: [...accumulatedReasons, ...(expired ? checked.decision.reasons : ['RESIZED_QUOTE_UNAVAILABLE_OR_STALE'])] }, projection: null }, quotes: null };
    }
    const checked = evaluateG2Intent({ intent: workingIntent, signals, account, quotes, now: reevaluatedAt });
    quoteSource = mergeQuoteSource(quoteSource, checked.quoteSource);
    if (checked.decision.status === 'ALLOW') {
      return {
        evaluation: { ...checked, quoteSource,
          decision: { ...checked.decision, decisionId, intentId: intent.intentId, status: 'RESIZE',
            requestedAmountIn: intent.amountIn, approvedAmountIn: workingIntent.amountIn,
            reasons: [...accumulatedReasons, 'RESIZED_QUOTE_VALIDATED', ...checked.decision.reasons] },
        }, quotes,
      };
    }
    accumulatedReasons.push(...checked.decision.reasons);
    if (checked.decision.status === 'RESIZE') { evaluation = checked; continue; }
    return { evaluation: { ...checked, quoteSource, decision: { ...checked.decision, decisionId, intentId: intent.intentId,
      requestedAmountIn: intent.amountIn, approvedAmountIn: null, reasons: accumulatedReasons }, projection: null }, quotes };
  }
  if (evaluation.decision.status === 'RESIZE') return { evaluation: { ...evaluation, quoteSource,
    decision: { ...evaluation.decision, decisionId, intentId: intent.intentId, status: 'REQUIRE_REVIEW',
      requestedAmountIn: intent.amountIn, approvedAmountIn: null, reasons: [...accumulatedReasons, 'RESIZE_REEVALUATION_LIMIT'] }, projection: null }, quotes };
  return { evaluation, quotes };
}function response(record: PaperIntentRecord, replayed: boolean): EvaluateIntentResponse {
  return Object.freeze({ record, replayed });
}
function errorCode(error: unknown): string {
  if (error instanceof PaperStoreError) return error.code;
  return 'INTERNAL_ERROR';
}

function operatorContext(request: import('fastify').FastifyRequest): OperatorRequestContext {
  return {
    cookieHeader: typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined,
    origin: typeof request.headers.origin === 'string' ? request.headers.origin : undefined,
    hostname: request.hostname,
    remoteAddress: request.ip,
  };
}

function authorizeOperator(
  options: CreateApiOptions,
  request: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
  mode: 'read' | 'mutation',
): OperatorPrincipal | null {
  if (!options.operatorAuth) {
    void reply.code(503).send({ error: 'OPERATOR_AUTH_UNAVAILABLE' });
    return null;
  }
  const context = operatorContext(request);
  const result = mode === 'mutation'
    ? options.operatorAuth.authorizeMutation(context)
    : options.operatorAuth.authorizeRead(context);
  if (!result.ok) {
    void reply.code(result.statusCode).send({ error: result.error });
    return null;
  }
  return result.principal;
}

function d2bErrorCode(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'reason' in error && typeof error.reason === 'string') return error.reason;
  return error instanceof Error ? error.message : fallback;
}
function d2bErrorStatus(code: string): number {
  if (['D2B_SIGNING_DISABLED', 'D2B_SUBMISSION_DISABLED', 'D2B_EXECUTION_UNAVAILABLE'].includes(code)) return 503;
  if (code === 'D2B_PROPOSAL_OR_EVALUATION_NOT_FOUND' || code === 'D2B_WORKFLOW_NOT_FOUND' || code === 'D2_EXECUTION_NOT_RESERVED') return 404;
  if (code.startsWith('D2B_') || code.startsWith('G3C_') || code.startsWith('D2_')) return 409;
  return 503;
}

export function createApiApp(options: CreateApiOptions): FastifyInstance {
  const clock = options.clock ?? (() => new Date());
  const provider = options.dataProvider ?? EMPTY_G2_DATA_PROVIDER;
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });

  app.get('/v1/operator/session', async (request, reply) => {
    if (!options.operatorAuth) return reply.code(503).send({ error: 'OPERATOR_AUTH_UNAVAILABLE' });
    const context = operatorContext(request);
    if (!['127.0.0.1', 'localhost', '::1'].includes(context.hostname.replace(/^\[|\]$/gu, '').toLowerCase())) {
      return reply.code(403).send({ error: 'OPERATOR_ORIGIN_REJECTED' });
    }
    return d2OperatorSessionSchema.parse(options.operatorAuth.inspect(context.cookieHeader));
  });
  app.post('/v1/operator/login', async (request, reply) => {
    const body = d2OperatorLoginRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'INVALID_OPERATOR_LOGIN' });
    if (!options.operatorAuth) return reply.code(503).send({ error: 'OPERATOR_AUTH_UNAVAILABLE' });
    const context = operatorContext(request);
    const result = options.operatorAuth.login({ password: body.data.password, origin: context.origin,
      hostname: context.hostname, remoteAddress: context.remoteAddress });
    if (!result.ok) return reply.code(result.statusCode).send({ error: result.error });
    reply.header('set-cookie', result.cookie);
    return reply.code(200).send(d2OperatorSessionSchema.parse({ configured: true, authenticated: true, expiresAt: result.principal.expiresAt }));
  });
  app.post('/v1/operator/logout', async (request, reply) => {
    const principal = authorizeOperator(options, request, reply, 'mutation');
    if (!principal || !options.operatorAuth) return;
    options.operatorAuth.logout(operatorContext(request));
    reply.header('set-cookie', options.operatorAuth.clearCookieHeader);
    return reply.code(200).send({ configured: true, authenticated: false, expiresAt: null });
  });

  app.get('/v2/runtime', async (_request, reply) => {
    const runtime = options.d2Runtime?.() ?? {
      service: 'ered-luin-api', status: options.d2Production ? 'ok' : 'degraded',
      appMode: 'PRODUCTION_READ_ONLY', paidNansenCallsEnabled: false, activeNansenCreditBudget: 0, liveExecutionEnabled: false,
      executionControls: { operatorAuthConfigured: options.operatorAuth?.configured ?? false,
        signingEnabled: options.d2Execution?.signingEnabled ?? false, submissionEnabled: options.d2Execution?.submissionEnabled ?? false, reviewedMode: false },
      nansenObservationStore: options.d2Production ? 'configured' : 'unconfigured',
      productionEvaluation: options.d2Production ? 'configured' : 'unconfigured', baseRpc: 'disabled',
      g3cStatusReader: options.g3cStatusReader ? 'configured' : 'unconfigured', rpcRunBudget: null,
    } as const;
    const parsed = d2RuntimeSchema.safeParse(runtime);
    if (!parsed.success) return reply.code(503).send({ error: 'D2_RUNTIME_INVALID' });
    return parsed.data;
  });

  app.get('/healthz', async () => ({
    service: 'ered-luin-api', status: 'ok', executionMode: 'PAPER',
    paidNansenCallsEnabled: false, activeNansenCreditBudget: 0, liveExecutionEnabled: false,
  }));

  app.get('/v1/signals', async (_request, reply) => {
    try {
      const raw = await provider.getSignals();
      const signals = parseSignals(raw);
      if (!signals) return reply.code(503).send({ error: 'SIGNAL_SOURCE_UNAVAILABLE' });
      return { signals };
    } catch {
      return reply.code(503).send({ error: 'SIGNAL_SOURCE_UNAVAILABLE' });
    }
  });

  app.get('/v1/demo/scenarios', async (_request, reply) => {
    if (!options.d1Demo) return reply.code(404).send({ error: 'D1_DEMO_UNAVAILABLE' });
    const parsed = d1ScenarioSchema.array().safeParse(options.d1Demo.scenarios());
    if (!parsed.success) return reply.code(503).send({ error: 'D1_SCENARIOS_INVALID' });
    return { scenarios: parsed.data };
  });

  app.post('/v1/demo/proposals', async (request, reply) => {
    if (!options.d1Demo) return reply.code(404).send({ error: 'D1_DEMO_UNAVAILABLE' });
    const input = d1ProposalRequestSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'INVALID_D1_PROPOSAL_REQUEST' });
    try {
      const proposal = d1ProposalSchema.safeParse(await options.d1Demo.createProposal(input.data.scenarioId));
      if (!proposal.success) return reply.code(503).send({ error: 'D1_PROPOSAL_INVALID' });
      return reply.code(201).send(proposal.data);
    } catch {
      return reply.code(503).send({ error: 'D1_PROPOSAL_UNAVAILABLE' });
    }
  });

  app.get<{ Params: { status: string } }>('/v1/demo/g3c-status/:status', async (request, reply) => {
    if (!options.d1Demo) return reply.code(404).send({ error: 'D1_DEMO_UNAVAILABLE' });
    const status = d1G3cStatusNameSchema.safeParse(request.params.status.toUpperCase());
    if (!status.success) return reply.code(400).send({ error: 'INVALID_D1_G3C_STATUS' });
    try {
      const fixture = d1G3cFixtureSchema.safeParse(options.d1Demo.g3cStatus(status.data));
      if (!fixture.success) return reply.code(503).send({ error: 'D1_G3C_FIXTURE_INVALID' });
      return fixture.data;
    } catch {
      return reply.code(503).send({ error: 'D1_G3C_FIXTURE_UNAVAILABLE' });
    }
  });
  app.get('/v1/production/evidence', async (_request, reply) => {
    if (!options.d2Production) return reply.code(503).send({ error: 'PRODUCTION_EVIDENCE_UNAVAILABLE' });
    try { return options.d2Production.evidence(); }
    catch { return reply.code(503).send({ error: 'PRODUCTION_EVIDENCE_INVALID' }); }
  });
  app.post('/v1/production/analysis/preview', async (request, reply) => {
    if (!authorizeOperator(options, request, reply, 'read')) return;
    const input = d2AnalysisPreviewRequestSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'INVALID_ANALYSIS_PREVIEW_REQUEST' });
    if (!options.d2FreshAnalysis) return reply.code(503).send({ error: 'FRESH_ANALYSIS_UNAVAILABLE' });
    try {
      const preview = d2AnalysisPreviewSchema.safeParse(options.d2FreshAnalysis.preview(input.data.proposalId));
      if (!preview.success) return reply.code(503).send({ error: 'FRESH_ANALYSIS_PREVIEW_INVALID' });
      return preview.data;
    } catch { return reply.code(503).send({ error: 'FRESH_ANALYSIS_PREVIEW_UNAVAILABLE' }); }
  });
  app.post('/v1/production/analysis/invoke', async (request, reply) => {
    if (!authorizeOperator(options, request, reply, 'mutation')) return;
    const input = d2AnalysisInvokeRequestSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'INVALID_ANALYSIS_INVOKE_REQUEST' });
    if (!options.d2FreshAnalysis) return reply.code(503).send({ error: 'FRESH_ANALYSIS_UNAVAILABLE' });
    try {
      const result = d2AnalysisInvokeSchema.safeParse(await options.d2FreshAnalysis.invoke(input.data));
      if (!result.success) return reply.code(503).send({ error: 'FRESH_ANALYSIS_RESPONSE_INVALID' });
      return result.data;
    } catch { return reply.code(503).send({ error: 'FRESH_ANALYSIS_INVOKE_UNAVAILABLE' }); }
  });
    app.post('/v1/production/proposals', async (request, reply) => {
    if (!authorizeOperator(options, request, reply, 'mutation')) return;
    if (!options.d2Production) return reply.code(503).send({ error: 'PRODUCTION_PROPOSAL_UNAVAILABLE' });
    if (!d2ProposalRequestSchema.safeParse(request.body).success) return reply.code(400).send({ error: 'INVALID_PRODUCTION_PROPOSAL_REQUEST' });
    try {
      const proposal = d2ProposalSchema.safeParse(options.d2Production.createProposal(request.body));
      if (!proposal.success) return reply.code(503).send({ error: 'PRODUCTION_PROPOSAL_INVALID' });
      return reply.code(201).send(proposal.data);
    } catch { return reply.code(503).send({ error: 'PRODUCTION_PROPOSAL_UNAVAILABLE' }); }
  });
  app.get<{ Params: { id: string } }>('/v1/production/proposals/:id', async (request, reply) => {
    if (!authorizeOperator(options, request, reply, 'read')) return;
    if (!/^[0-9a-f-]{36}$/iu.test(request.params.id)) return reply.code(400).send({ error: 'INVALID_PROPOSAL_ID' });
    if (!options.d2Production) return reply.code(503).send({ error: 'PRODUCTION_PROPOSAL_UNAVAILABLE' });
    try {
      const proposal = options.d2Production.proposal(request.params.id);
      return proposal ? proposal : reply.code(404).send({ error: 'PROPOSAL_NOT_FOUND' });
    } catch { return reply.code(503).send({ error: 'PRODUCTION_PROPOSAL_UNAVAILABLE' }); }
  });
    app.post('/v1/production/evaluations', async (request, reply) => {
    if (!authorizeOperator(options, request, reply, 'mutation')) return;
    const input = d2EvaluationRequestSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'INVALID_PRODUCTION_EVALUATION_REQUEST' });
    if (!options.d2Production) return reply.code(503).send({ error: 'PRODUCTION_EVALUATION_UNAVAILABLE' });
    try {
      const evaluation = d2EvaluationSchema.safeParse(await options.d2Production.evaluate(input.data.proposalId, input.data.sessionId));
      if (!evaluation.success) return reply.code(503).send({ error: 'PRODUCTION_EVALUATION_INVALID' });
      return reply.code(200).send(evaluation.data);
    } catch (error) {
      if (error instanceof Error && error.message === 'D2_PROPOSAL_NOT_FOUND') return reply.code(404).send({ error: 'PROPOSAL_NOT_FOUND' });
      return reply.code(503).send({ error: 'PRODUCTION_EVALUATION_UNAVAILABLE' });
    }
  });
  app.get<{ Params: { id: string } }>('/v1/production/evaluations/:id', async (request, reply) => {
    if (!/^[0-9a-f-]{36}$/iu.test(request.params.id)) return reply.code(400).send({ error: 'INVALID_PROPOSAL_ID' });
    if (!options.d2Production) return reply.code(503).send({ error: 'PRODUCTION_EVALUATION_UNAVAILABLE' });
    try {
      const evaluation = options.d2Production.evaluation(request.params.id);
      return evaluation ? evaluation : reply.code(404).send({ error: 'EVALUATION_NOT_FOUND' });
    } catch { return reply.code(503).send({ error: 'PRODUCTION_EVALUATION_UNAVAILABLE' }); }
  });
    app.post('/v1/production/sessions/start', async (request, reply) => {
    if (!authorizeOperator(options, request, reply, 'mutation')) return;
    const input = d2SessionRequestSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'INVALID_G3C_SESSION_REQUEST' });
    if (!options.d2Production) return reply.code(503).send({ error: 'G3C_SESSION_START_UNAVAILABLE' });
    try {
      const result = d2SessionResponseSchema.safeParse(await options.d2Production.startSession(input.data));
      if (!result.success) return reply.code(503).send({ error: 'G3C_SESSION_START_INVALID' });
      return reply.code(201).send(result.data);
    } catch { return reply.code(503).send({ error: 'G3C_SESSION_START_UNAVAILABLE' }); }
  });
    app.post('/v1/production/reservations', async (request, reply) => {
    if (!authorizeOperator(options, request, reply, 'mutation')) return;
    const input = d2ReservationRequestSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'INVALID_D2_RESERVATION_REQUEST' });
    if (!options.d2Production) return reply.code(503).send({ error: 'D2_RESERVATION_UNAVAILABLE' });
    try {
      const result = d2EvaluationSchema.safeParse(options.d2Production.reserve(input.data.proposalId, input.data.sessionId));
      if (!result.success) return reply.code(503).send({ error: 'D2_RESERVATION_INVALID' });
      return reply.code(result.data.replayed ? 200 : 201).send(result.data);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'D2_POLICY_NOT_EXECUTABLE' || code === 'D2_INTENT_EXPIRED_REQUIRES_NEW_PROPOSAL') return reply.code(409).send({ error: code });
      if (code === 'D2_EVALUATION_NOT_FOUND') return reply.code(404).send({ error: code });
      return reply.code(503).send({ error: 'D2_RESERVATION_UNAVAILABLE' });
    }
  });
  app.get<{ Params: { id: string } }>('/v1/production/proposals/:id/simulation', async (request, reply) => {
    if (!/^[0-9a-f-]{36}$/iu.test(request.params.id)) return reply.code(400).send({ error: 'INVALID_PROPOSAL_ID' });
    if (!options.d2Production) return reply.code(503).send({ error: 'D2_SIMULATION_UNAVAILABLE' });
    try {
      const result = d2SimulationSchema.safeParse(options.d2Production.simulation(request.params.id));
      if (!result.success) return reply.code(404).send({ error: 'SIMULATION_NOT_FOUND' });
      return result.data;
    } catch { return reply.code(503).send({ error: 'D2_SIMULATION_UNAVAILABLE' }); }
  });
    app.post('/v1/production/executions/simulate', async (request, reply) => {
    if (!authorizeOperator(options, request, reply, 'mutation')) return;
    const input = d2SimulationRequestSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'INVALID_D2_SIMULATION_REQUEST' });
    if (!options.d2Production) return reply.code(503).send({ error: 'D2_SIMULATION_UNAVAILABLE' });
    try {
      const result = d2SimulationSchema.safeParse(await options.d2Production.simulate(input.data.proposalId, input.data.sessionId, input.data.operationId));
      if (!result.success) return reply.code(503).send({ error: 'D2_SIMULATION_INVALID' });
      return reply.code(201).send(result.data);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (['D2_POLICY_NOT_EXECUTABLE', 'D2_EXECUTION_NOT_RESERVED', 'D2_SESSION_IDENTITY_MISMATCH', 'D2_EXECUTION_NOT_SIMULATABLE'].includes(code)) return reply.code(409).send({ error: code });
      return reply.code(503).send({ error: 'D2_SIMULATION_UNAVAILABLE' });
    }
  });
  app.post('/v1/production/executions/prepare-sign', async (request, reply) => {
    const operator = authorizeOperator(options, request, reply, 'mutation');
    if (!operator) return;
    const parsed = d2PrepareSignRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_D2_PREPARE_SIGN_REQUEST' });
    if (!options.d2Execution) return reply.code(503).send({ error: 'D2B_EXECUTION_UNAVAILABLE' });
    try {
      const result = d2ExecutionActionResponseSchema.safeParse(await options.d2Execution.prepareSign(parsed.data, operator.operatorId));
      if (!result.success) return reply.code(503).send({ error: 'D2B_EXECUTION_RESPONSE_INVALID' });
      return reply.code(200).send(result.data);
    } catch (error) {
      const code = d2bErrorCode(error, 'D2B_EXECUTION_UNAVAILABLE');
      const known = code.startsWith('D2B_') || code.startsWith('G3C_') || code.startsWith('D2_');
      return reply.code(d2bErrorStatus(code)).send({ error: known ? code : 'D2B_EXECUTION_UNAVAILABLE' });
    }
  });
  app.post('/v1/production/executions/submit', async (request, reply) => {
    const operator = authorizeOperator(options, request, reply, 'mutation');
    if (!operator) return;
    const parsed = d2SubmitRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_D2_SUBMIT_REQUEST' });
    if (!options.d2Execution) return reply.code(503).send({ error: 'D2B_EXECUTION_UNAVAILABLE' });
    try {
      const result = d2ExecutionActionResponseSchema.safeParse(await options.d2Execution.submit(parsed.data, operator.operatorId));
      if (!result.success) return reply.code(503).send({ error: 'D2B_EXECUTION_RESPONSE_INVALID' });
      return reply.code(200).send(result.data);
    } catch (error) {
      const code = d2bErrorCode(error, 'D2B_EXECUTION_UNAVAILABLE');
      const known = code.startsWith('D2B_') || code.startsWith('G3C_') || code.startsWith('D2_');
      return reply.code(d2bErrorStatus(code)).send({ error: known ? code : 'D2B_EXECUTION_UNAVAILABLE' });
    }
  });
  app.get<{ Params: { proposalId: string; operationId: string } }>('/v1/production/executions/:proposalId/:operationId', async (request, reply) => {
    if (!authorizeOperator(options, request, reply, 'read')) return;
    const parsed = d2OperationRequestSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_D2_EXECUTION_IDENTITY' });
    if (!options.d2Execution) return reply.code(503).send({ error: 'D2B_EXECUTION_UNAVAILABLE' });
    try {
      const result = d2ExecutionActionResponseSchema.safeParse(options.d2Execution.status(parsed.data.proposalId, parsed.data.operationId));
      if (!result.success) return reply.code(503).send({ error: 'D2B_EXECUTION_RESPONSE_INVALID' });
      return reply.code(200).send(result.data);
    } catch (error) {
      const code = d2bErrorCode(error, 'D2B_EXECUTION_UNAVAILABLE');
      const known = code.startsWith('D2B_') || code.startsWith('G3C_') || code.startsWith('D2_');
      return reply.code(d2bErrorStatus(code)).send({ error: known ? code : 'D2B_EXECUTION_UNAVAILABLE' });
    }
  });
  app.post('/v1/production/executions/reconcile', async (request, reply) => {
    const operator = authorizeOperator(options, request, reply, 'mutation');
    if (!operator) return;
    if (options.d2Execution) {
      const parsed = d2ExecutionReconcileRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'INVALID_D2_RECOVERY_REQUEST' });
      try {
        const result = d2ExecutionActionResponseSchema.safeParse(await options.d2Execution.reconcile(parsed.data, operator.operatorId));
        if (!result.success) return reply.code(503).send({ error: 'D2B_RECOVERY_RESPONSE_INVALID' });
        return reply.code(200).send(result.data);
      } catch (error) {
        const code = d2bErrorCode(error, 'D2B_RECOVERY_UNAVAILABLE');
        const known = code.startsWith('D2B_') || code.startsWith('G3C_') || code.startsWith('D2_');
        return reply.code(d2bErrorStatus(code)).send({ error: known ? code : 'D2B_RECOVERY_UNAVAILABLE' });
      }
    }
    const input = d2OperationRequestSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'INVALID_D2_RECOVERY_REQUEST' });
    if (!options.d2Production) return reply.code(503).send({ error: 'G3C_RECOVERY_UNAVAILABLE' });
    try {
      const result = d2EvaluationSchema.safeParse(await options.d2Production.reconcile(input.data.proposalId, input.data.operationId));
      if (!result.success) return reply.code(503).send({ error: 'G3C_RECOVERY_STATUS_INVALID' });
      return result.data;
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'D2_EXECUTION_NOT_RESERVED' || code === 'G3C_WORKFLOW_NOT_FOUND') return reply.code(404).send({ error: code });
      if (code === 'D2_RECOVERY_NOT_PENDING' || code === 'D2_RECOVERY_EXECUTION_MISMATCH' ||
          code === 'G3C_RECOVERY_EXECUTION_MISMATCH' || code === 'G3C_TRANSACTION_HASH_MISSING') return reply.code(409).send({ error: code });
      return reply.code(503).send({ error: 'G3C_RECOVERY_UNAVAILABLE' });
    }
  });
  app.post('/v1/intents/evaluate', async (request, reply) => {
    const demoRequest = d1EvaluateIntentRequestSchema.safeParse(request.body);
    const directIntent = tradeIntentSchema.safeParse(request.body);
    if (!demoRequest.success && !directIntent.success) return reply.code(400).send({ error: 'INVALID_INTENT' });
    const proposalId = demoRequest.success ? demoRequest.data.proposalId : null;
    const demoContext = proposalId === null ? null : options.d1Demo?.evaluationContext(proposalId) ?? null;
    if (proposalId !== null && !demoContext) return reply.code(404).send({ error: 'D1_PROPOSAL_NOT_FOUND' });
    const intent = demoContext?.proposal.intent ?? (directIntent.success ? directIntent.data : null);
    if (!intent) return reply.code(400).send({ error: 'INVALID_INTENT' });
    try {
      const existing = options.store.getIntent(intent.intentId);
      if (existing) {
        if (JSON.stringify(existing.intent) !== JSON.stringify(intent)) return reply.code(409).send({ error: 'INTENT_ID_CONFLICT' });
        return reply.code(200).send(response(existing, true));
      }
      let account = options.store.getAccount(intent.walletAddress);
      if (!account && demoContext) {
        try { account = options.store.createAccount(demoContext.account); }
        catch (error) {
          if (!(error instanceof PaperStoreError) || error.code !== 'ACCOUNT_EXISTS') throw error;
          account = options.store.getAccount(intent.walletAddress);
        }
      }
      const evaluationProvider = demoContext?.provider ?? provider;
      let signals: readonly unknown[] = [];
      try {
        const fetchedSignals = await evaluationProvider.getSignals();
        if (Array.isArray(fetchedSignals) && fetchedSignals.length <= 5000) signals = fetchedSignals;
      } catch { /* Missing signal data deterministically becomes REQUIRE_REVIEW. */ }
      let quotes: G2QuoteBundle | null = null;
      if (account) {
        try { quotes = parseQuoteBundle(await evaluationProvider.getQuoteBundle(intent, account), account); }
        catch { quotes = null; }
      }
      const now = currentTime(clock);
      const evaluation = account
        ? (await evaluateWithResizeQuotes(intent, signals, account, quotes, now, evaluationProvider, () => currentTime(clock))).evaluation
        : evaluateG2Intent({ intent, signals, account, quotes, now });
      const committed = options.store.commitEvaluation(intent, evaluation, quotes?.accountVersion ?? null);
      return reply.code(committed.replayed ? 200 : 201).send(response(committed.record, committed.replayed));
    } catch (error) {
      const code = errorCode(error);
      if (code === 'INTENT_ID_CONFLICT') return reply.code(409).send({ error: code });
      if (code === 'ACCOUNT_NOT_FOUND' || code === 'ACCOUNT_EXISTS') return reply.code(409).send({ error: code });
      request.log.error({ code }, 'intent evaluation failed');
      return reply.code(code === 'INVALID_INPUT' ? 400 : 503).send({ error: code });
    }
  });
  app.get<{ Params: { id: string } }>('/v1/intents/:id', async (request, reply) => {
    if (!/^[0-9a-f-]{36}$/iu.test(request.params.id)) return reply.code(400).send({ error: 'INVALID_INTENT_ID' });
    try {
      const record = options.store.getIntent(request.params.id);
      if (!record) return reply.code(404).send({ error: 'INTENT_NOT_FOUND' });
      return record;
    } catch (error) {
      const code = errorCode(error);
      request.log.error({ code }, 'intent lookup failed');
      return reply.code(503).send({ error: code });
    }
  });

  app.get<{ Params: { id: string } }>('/v1/executions/:id/g3c-status', async (request, reply) => {
    if (!/^[0-9a-f-]{36}$/iu.test(request.params.id)) return reply.code(400).send({ error: 'INVALID_EXECUTION_ID' });
    if (!options.g3cStatusReader) return reply.code(503).send({ error: 'G3C_STATUS_UNAVAILABLE' });
    try {
      const parsed = g3cStatusResponseSchema.safeParse(options.g3cStatusReader.status(request.params.id));
      if (!parsed.success) return reply.code(503).send({ error: 'G3C_STATUS_INVALID' });
      return reply.code(200).send(parsed.data);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'EXECUTION_NOT_FOUND') return reply.code(404).send({ error: 'EXECUTION_NOT_FOUND' });
      request.log.error({ code }, 'G3c status lookup failed');
      return reply.code(503).send({ error: code });
    }
  });

  app.addHook('onClose', async () => { options.store.close(); provider.close?.(); options.d1Demo?.close(); options.d2Production?.close(); });
  return app;
}

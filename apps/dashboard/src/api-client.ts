import {
  d1EvaluateIntentResponseSchema,
  d1G3cFixtureSchema,
  d1G3cStatusNameSchema,
  d1HealthResponseSchema,
  d1PaperIntentRecordSchema,
  d1ProposalSchema,
  d1ScenarioListResponseSchema,
  d2EvidenceResponseSchema,
  d2EvaluationSchema,
  d2ProposalSchema,
  d2RuntimeSchema,
  d2SessionResponseSchema,
  d2SimulationSchema,
  d2OperatorSessionSchema,
  d2ExecutionActionResponseSchema,
  d2AnalysisPreviewSchema,
  d2AnalysisInvokeSchema,
  d2BrowserExecutionActionResponseSchema, d2BrowserAllowancePreflightResponseSchema,
  type D2AnalysisPreview,
  type D2AnalysisInvoke, type D2BrowserAllowancePreflightResponse,
  type D1G3cFixture,
  type D1G3cStatusName,
  type D1Proposal,
  type D1Scenario,
} from '@ered-luin/contracts';

export type D1Health = ReturnType<typeof d1HealthResponseSchema.parse>;
export type D1PaperIntentRecord = ReturnType<typeof d1PaperIntentRecordSchema.parse>;
export type D2Runtime = ReturnType<typeof d2RuntimeSchema.parse>;
export type D2Evidence = ReturnType<typeof d2EvidenceResponseSchema.parse>;
export type D2Proposal = ReturnType<typeof d2ProposalSchema.parse>;
export type D2Evaluation = ReturnType<typeof d2EvaluationSchema.parse>;
export type D2Session = ReturnType<typeof d2SessionResponseSchema.parse>;
export type D2Simulation = ReturnType<typeof d2SimulationSchema.parse>;
export type D2OperatorSession = ReturnType<typeof d2OperatorSessionSchema.parse>;
export type D2ExecutionAction = ReturnType<typeof d2ExecutionActionResponseSchema.parse>;
export type D2BrowserExecutionAction = ReturnType<typeof d2BrowserExecutionActionResponseSchema.parse>;
export type D2BrowserAllowancePreflight = D2BrowserAllowancePreflightResponse;
export type D2FreshAnalysisPreview = D2AnalysisPreview;
export type D2FreshAnalysisResult = D2AnalysisInvoke;

interface ContractSchema<T> {
  safeParse(value: unknown): { readonly success: true; readonly data: T } | { readonly success: false };
}

async function responseBody<T>(
  fetcher: typeof fetch,
  path: string,
  schema: ContractSchema<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetcher(path, init);
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new Error('The API returned invalid JSON.'); }
  if (!response.ok) {
    const detail = typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
      ? value.error : 'API_REQUEST_FAILED';
    throw new Error(detail);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('The API response failed contract validation.');
  return parsed.data;
}

function post(fetcher: typeof fetch, path: string, body: unknown): RequestInit {
  return { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export function createD1ApiClient(fetcher: typeof fetch = fetch) {
  return Object.freeze({
    health: () => responseBody(fetcher, '/healthz', d1HealthResponseSchema),
    scenarios: async (): Promise<readonly D1Scenario[]> =>
      (await responseBody(fetcher, '/v1/demo/scenarios', d1ScenarioListResponseSchema)).scenarios,
    proposal: (scenarioId: D1Scenario['id']): Promise<D1Proposal> => responseBody(
      fetcher, '/v1/demo/proposals', d1ProposalSchema,
      post(fetcher, '/v1/demo/proposals', { scenarioId }),
    ),
    evaluate: (proposalId: string) => responseBody(
      fetcher, '/v1/intents/evaluate', d1EvaluateIntentResponseSchema,
      post(fetcher, '/v1/intents/evaluate', { proposalId }),
    ),
    intent: (intentId: string): Promise<D1PaperIntentRecord> =>
      responseBody(fetcher, '/v1/intents/' + encodeURIComponent(intentId), d1PaperIntentRecordSchema),
    g3cStatus: (status: D1G3cStatusName): Promise<D1G3cFixture> => {
      const parsedStatus = d1G3cStatusNameSchema.safeParse(status);
      if (!parsedStatus.success) throw new Error('INVALID_D1_G3C_STATUS');
      return responseBody(fetcher, '/v1/demo/g3c-status/' + parsedStatus.data.toLowerCase(), d1G3cFixtureSchema);
    },
  });
}

export async function d2bIdempotencyKey(action: 'PREPARE_SIGN' | 'SUBMIT' | 'RECONCILE', operationId: string, attempt = 0): Promise<string> {
  if (!/^[0-9a-f-]{36}$/iu.test(operationId) || !Number.isSafeInteger(attempt) || attempt < 0 || !globalThis.crypto?.subtle) throw new Error('D2_IDEMPOTENCY_CRYPTO_UNAVAILABLE');
  const bytes = new TextEncoder().encode('ered-luin:d2b:v1:' + action + ':' + operationId.toLowerCase() + ':' + attempt);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const value = Array.from(new Uint8Array(digest).slice(0, 16));
  value[6] = (value[6]! & 0x0f) | 0x50;
  value[8] = (value[8]! & 0x3f) | 0x80;
  const hex = value.map((part) => part.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}

export function createD2ApiClient(fetcher: typeof fetch = fetch) {
  return Object.freeze({
    runtime: () => responseBody(fetcher, '/v2/runtime', d2RuntimeSchema),
    operatorSession: () => responseBody(fetcher, '/v1/operator/session', d2OperatorSessionSchema, { credentials: 'same-origin' }),
    login: (password: string): Promise<D2OperatorSession> => responseBody(
      fetcher, '/v1/operator/login', d2OperatorSessionSchema, post(fetcher, '/v1/operator/login', { password }),
    ),
    logout: (): Promise<D2OperatorSession> => responseBody(
      fetcher, '/v1/operator/logout', d2OperatorSessionSchema, post(fetcher, '/v1/operator/logout', {}),
    ),
    evidence: () => responseBody(fetcher, '/v1/production/evidence', d2EvidenceResponseSchema),
    getEvaluation: (proposalId: string): Promise<D2Evaluation> => responseBody(fetcher, '/v1/production/evaluations/' + encodeURIComponent(proposalId), d2EvaluationSchema),
    analysisPreview: (proposalId: string): Promise<D2FreshAnalysisPreview> => responseBody(
      fetcher, '/v1/production/analysis/preview', d2AnalysisPreviewSchema, post(fetcher, '/v1/production/analysis/preview', { proposalId }),
    ),
    invokeAnalysis: (proposalId: string, requestHash: string): Promise<D2FreshAnalysisResult> => responseBody(
      fetcher, '/v1/production/analysis/invoke', d2AnalysisInvokeSchema,
      post(fetcher, '/v1/production/analysis/invoke', { proposalId, requestHash }),
    ),
    proposal: (walletAddress: string, requestedUsdcMicros: string): Promise<D2Proposal> => responseBody(
      fetcher, '/v1/production/proposals', d2ProposalSchema, post(fetcher, '/v1/production/proposals', { walletAddress, requestedUsdcMicros }),
    ),
    getProposal: (proposalId: string): Promise<D2Proposal> => responseBody(
      fetcher, '/v1/production/proposals/' + encodeURIComponent(proposalId), d2ProposalSchema, { credentials: 'same-origin' },
    ),
    startSession: (sessionId: string, walletAddress: string, reason: string): Promise<D2Session> => responseBody(
      fetcher, '/v1/production/sessions/start', d2SessionResponseSchema, post(fetcher, '/v1/production/sessions/start', { sessionId, walletAddress, reason }),
    ),
    evaluate: (proposalId: string, sessionId?: string) => responseBody(
      fetcher, '/v1/production/evaluations', d2EvaluationSchema, post(fetcher, '/v1/production/evaluations', { proposalId, ...(sessionId ? { sessionId } : {}) }),
    ),
    reserve: (proposalId: string, sessionId: string): Promise<D2Evaluation> => responseBody(
      fetcher, '/v1/production/reservations', d2EvaluationSchema, post(fetcher, '/v1/production/reservations', { proposalId, sessionId }),
    ),
    simulate: (proposalId: string, sessionId: string, operationId: string): Promise<D2Simulation> => responseBody(
      fetcher, '/v1/production/executions/simulate', d2SimulationSchema, post(fetcher, '/v1/production/executions/simulate', { proposalId, sessionId, operationId }),
    ),
    simulation: (proposalId: string): Promise<D2Simulation> =>
      responseBody(fetcher, '/v1/production/proposals/' + encodeURIComponent(proposalId) + '/simulation', d2SimulationSchema),
    browserCheckAllowance: (proposalId: string, operationId: string, sessionId: string): Promise<D2BrowserAllowancePreflightResponse> => responseBody(
      fetcher, '/v1/production/browser-executions/allowance', d2BrowserAllowancePreflightResponseSchema,
      post(fetcher, '/v1/production/browser-executions/allowance', { proposalId, operationId, sessionId }),
    ),    browserPrepare: (proposalId: string, operationId: string, sessionId: string): Promise<D2BrowserExecutionAction> => responseBody(
      fetcher, '/v1/production/browser-executions/prepare', d2BrowserExecutionActionResponseSchema,
      post(fetcher, '/v1/production/browser-executions/prepare', { proposalId, operationId, sessionId }),
    ),
    browserPrepareApproval: (proposalId: string, operationId: string, sessionId: string): Promise<D2BrowserExecutionAction> => responseBody(
      fetcher, '/v1/production/browser-executions/approval/prepare', d2BrowserExecutionActionResponseSchema,
      post(fetcher, '/v1/production/browser-executions/approval/prepare', { proposalId, operationId, sessionId }),
    ),
    browserCompleteApproval: (proposalId: string, operationId: string, sessionId: string): Promise<D2BrowserExecutionAction> => responseBody(
      fetcher, '/v1/production/browser-executions/approval/complete', d2BrowserExecutionActionResponseSchema,
      post(fetcher, '/v1/production/browser-executions/approval/complete', { proposalId, operationId, sessionId }),
    ),    browserBegin: (proposalId: string, operationId: string, sessionId: string): Promise<D2BrowserExecutionAction> => responseBody(
      fetcher, '/v1/production/browser-executions/begin', d2BrowserExecutionActionResponseSchema,
      post(fetcher, '/v1/production/browser-executions/begin', { proposalId, operationId, sessionId }),
    ),
    browserAttachHash: (proposalId: string, operationId: string, transactionHash: string): Promise<D2BrowserExecutionAction> => responseBody(
      fetcher, '/v1/production/browser-executions/hash', d2BrowserExecutionActionResponseSchema,
      post(fetcher, '/v1/production/browser-executions/hash', { proposalId, operationId, transactionHash }),
    ),
    browserReconcile: (proposalId: string, operationId: string): Promise<D2BrowserExecutionAction> => responseBody(
      fetcher, '/v1/production/browser-executions/reconcile', d2BrowserExecutionActionResponseSchema,
      post(fetcher, '/v1/production/browser-executions/reconcile', { proposalId, operationId }),
    ),
    browserReject: (proposalId: string, operationId: string, reason: 'USER_REJECTED' | 'PRE_SEND_CONTEXT_CHANGED'): Promise<D2BrowserExecutionAction> => responseBody(
      fetcher, '/v1/production/browser-executions/reject', d2BrowserExecutionActionResponseSchema,
      post(fetcher, '/v1/production/browser-executions/reject', { proposalId, operationId, reason }),
    ),
    browserStatus: (proposalId: string, operationId: string): Promise<D2BrowserExecutionAction> => responseBody(
      fetcher, '/v1/production/browser-executions/' + encodeURIComponent(proposalId) + '/' + encodeURIComponent(operationId),
      d2BrowserExecutionActionResponseSchema, { credentials: 'same-origin' },
    ),    prepareSign: (proposalId: string, operationId: string, sessionId: string, idempotencyKey: string): Promise<D2ExecutionAction> => responseBody(
      fetcher, '/v1/production/executions/prepare-sign', d2ExecutionActionResponseSchema,
      post(fetcher, '/v1/production/executions/prepare-sign', { proposalId, operationId, sessionId, idempotencyKey }),
    ),
    submit: (proposalId: string, operationId: string, idempotencyKey: string): Promise<D2ExecutionAction> => responseBody(
      fetcher, '/v1/production/executions/submit', d2ExecutionActionResponseSchema,
      post(fetcher, '/v1/production/executions/submit', { proposalId, operationId, idempotencyKey }),
    ),
    executionStatus: (proposalId: string, operationId: string): Promise<D2ExecutionAction> =>
      responseBody(fetcher, '/v1/production/executions/' + encodeURIComponent(proposalId) + '/' + encodeURIComponent(operationId), d2ExecutionActionResponseSchema, { credentials: 'same-origin' }),
    reconcile: (proposalId: string, operationId: string, idempotencyKey: string): Promise<D2ExecutionAction> => responseBody(
      fetcher, '/v1/production/executions/reconcile', d2ExecutionActionResponseSchema,
      post(fetcher, '/v1/production/executions/reconcile', { proposalId, operationId, idempotencyKey }),
    ),
  });
}
export const d1Api = createD1ApiClient();
export const d2Api = createD2ApiClient();

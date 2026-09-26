import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { runtimeConfigSchema, type D2Runtime } from '@ered-luin/contracts';
import { openG1DShadowAuditStore, openNansenObservationStore } from '@ered-luin/nansen';
import { createApiApp, EMPTY_G2_DATA_PROVIDER, type G2DataProvider } from './api.js';
import { openPaperStore } from './paper-store.js';
import { ExecutionStore } from './execution-store.js';
import { G3cExecutionStore } from './g3c-execution-store.js';
import { loadProductionG3cEvidenceAuthority, loadProductionG3cEvidenceTrust } from './g3c-evidence.js';
import { createBaseReadOnlyProvider, createBaseG3cBroadcaster } from './g3c-base-provider.js';
import { createD2G3cGateway } from './d2-g3c-gateway.js';
import { BaseD2PolicyProvider } from './d2-base-provider.js';
import { createD2ProductionService } from './d2-production.js';
import { createD2FreshAnalysisService } from './d2-fresh-analysis.js';
import { createD2ExecutionService } from './d2-execution.js';
import { createProductionG3cSigner } from './g3c-signer-client.js';
import { openD2AuditStore } from './d2-audit-store.js';
import { DEFAULT_D2_RPC_MAX_REQUESTS, DEFAULT_D2_RPC_RECOVERY_RESERVE, MIN_D2_RPC_RECOVERY_RESERVE, RpcRunBudget } from './rpc-budget.js';
import { loadAlchemyBaseRpcUrl } from './alchemy-config.js';
import { createD1DemoService } from './d1-demo.js';
import { LocalOperatorAuthenticator } from './operator-auth.js';

function envBoolean(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(name + ' must be true or false.');
}
function envInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000) throw new Error(name + ' is invalid.');
  return parsed;
}
function absoluteExternalPath(name: string): string {
  const value = process.env[name];
  if (!value || !isAbsolute(value)) throw new Error(name + ' must be an absolute path outside the repository.');
  return value;
}

const config = runtimeConfigSchema.parse({
  NANSEN_API_ENABLED: process.env.NANSEN_API_ENABLED,
  NANSEN_CREDIT_BUDGET: process.env.NANSEN_CREDIT_BUDGET,
  LIVE_EXECUTION_ENABLED: process.env.LIVE_EXECUTION_ENABLED,
  EXECUTION_MODE: process.env.EXECUTION_MODE,
});
if (config.NANSEN_API_ENABLED !== 'false' || config.NANSEN_CREDIT_BUDGET !== '0') {
  throw new Error('D2 runtime requires paid Nansen calls disabled and a zero credit budget.');
}
const operatorAuth = new LocalOperatorAuthenticator({
  ...(process.env.D2_OPERATOR_SECRET ? { secret: process.env.D2_OPERATOR_SECRET } : {}),
  allowedOrigin: process.env.D2_OPERATOR_ALLOWED_ORIGIN || 'http://127.0.0.1:5173',
});
const baseReadsEnabled = envBoolean('D2_BASE_READS_ENABLED');
const deploymentReviewed = envBoolean('D2_DEPLOYMENT_REVIEWED');
const alchemyBudgetVerified = envBoolean('ALCHEMY_BUDGET_VERIFIED');
const signingRequested = envBoolean('D2_SIGNING_ENABLED');
const submissionRequested = envBoolean('D2_BROADCAST_ENABLED');
const executionReviewed = envBoolean('D2_EXECUTION_REVIEWED');
const g3cReviewed = envBoolean('G3C_REVIEWED_MODE');
const signerDeployed = envBoolean('G3C_SIGNER_DEPLOYED');
const broadcasterDeployed = envBoolean('BASE_BROADCASTER_DEPLOYED');
if (baseReadsEnabled && (!deploymentReviewed || !alchemyBudgetVerified)) {
  throw new Error('Base reads require reviewed deployment and verified shared Alchemy budget inputs.');
}
const reviewedExecutionGate = config.LIVE_EXECUTION_ENABLED === 'true' && config.EXECUTION_MODE === 'live-reviewed' &&
  executionReviewed && g3cReviewed && deploymentReviewed && alchemyBudgetVerified && baseReadsEnabled && operatorAuth.configured;
if ((signingRequested || submissionRequested) && !reviewedExecutionGate) {
  throw new Error('D2 signing/submission require live-reviewed mode, reviewed deployment, verified RPC budget, Base reads, and configured operator authentication.');
}
if (signingRequested && !signerDeployed) throw new Error('D2 signing requires G3C_SIGNER_DEPLOYED=true.');
if (submissionRequested && !broadcasterDeployed) throw new Error('D2 submission requires BASE_BROADCASTER_DEPLOYED=true.');
const rpcUrl = baseReadsEnabled ? await loadAlchemyBaseRpcUrl() : null;
const statePath = process.env.PAPER_STATE_PATH;
if (typeof statePath !== 'string' || !isAbsolute(statePath)) throw new Error('Set PAPER_STATE_PATH to an initialized absolute path outside the repository.');
const store = openPaperStore({ databasePath: statePath });
const observationPath = process.env.NANSEN_OBSERVATION_STORE_PATH;
const observationStoreId = process.env.NANSEN_OBSERVATION_STORE_ID;
if ((observationPath && !observationStoreId) || (!observationPath && observationStoreId)) throw new Error('Set both NANSEN_OBSERVATION_STORE_PATH and NANSEN_OBSERVATION_STORE_ID, or leave both unset.');
if (observationPath && !isAbsolute(observationPath)) throw new Error('NANSEN_OBSERVATION_STORE_PATH must be absolute.');
const observations = observationPath && observationStoreId
  ? openNansenObservationStore({ databasePath: observationPath, storeId: observationStoreId })
  : null;
const provider: G2DataProvider = observations ? {
  getSignals: () => observations.getLatestSignals(),
  getQuoteBundle: () => null,
  close: () => observations.close(),
} : EMPTY_G2_DATA_PROVIDER;
const g3cTrustPath = process.env.G3C_EVIDENCE_TRUST_PATH;
const g3cTrust = g3cTrustPath
  ? loadProductionG3cEvidenceTrust({ publicKeysPath: g3cTrustPath, repositoryRoot: process.cwd() })
  : { environment: 'production' as const, publicKeys: {} };
const executionStore = new ExecutionStore(store);
const g3cStatusStore = new G3cExecutionStore(executionStore, g3cTrust, {
  enableProductionSigning: signingRequested && reviewedExecutionGate && signerDeployed,
  enableProductionBroadcast: submissionRequested && reviewedExecutionGate && broadcasterDeployed,
});
const d2AuditPath = process.env.D2_AUDIT_STORE_PATH;
if (d2AuditPath && !observations) throw new Error('D2_AUDIT_STORE_PATH requires the configured Nansen observation store.');
if (baseReadsEnabled && (!d2AuditPath || !observations)) throw new Error('D2 Base reads require both durable production observations and D2 audit storage.');
if ((signingRequested || submissionRequested) && (!d2AuditPath || !observations || !g3cTrustPath)) {
  throw new Error('D2 signing/submission require durable observation/audit stores and external G3c evidence trust.');
}
const d2Audit = d2AuditPath ? openD2AuditStore({ databasePath: d2AuditPath }) : null;
const g1dAnalysisHandoffEnabled = envBoolean('D2_G1D_ANALYSIS_HANDOFF_ENABLED');
const g1dAnalysisEnabled = envBoolean('D2_G1D_ANALYSIS_ENABLED');
const g1dAuditPath = process.env.G1D_SHADOW_AUDIT_STORE_PATH;
const g1dAuditStoreId = process.env.G1D_SHADOW_AUDIT_STORE_ID;
if ((g1dAuditPath && !g1dAuditStoreId) || (!g1dAuditPath && g1dAuditStoreId)) {
  throw new Error('Set both G1D_SHADOW_AUDIT_STORE_PATH and G1D_SHADOW_AUDIT_STORE_ID, or leave both unset.');
}
if (g1dAuditPath && !isAbsolute(g1dAuditPath)) throw new Error('G1D_SHADOW_AUDIT_STORE_PATH must be absolute.');
if (g1dAnalysisHandoffEnabled && (!observations || !d2Audit || !g1dAuditPath || !g1dAuditStoreId)) {
  throw new Error('D2 G1d analysis handoff requires configured production observations, D2 audit storage and an external G1d shadow audit store.');
}
if (g1dAnalysisEnabled && (!observations || !d2Audit || !g1dAuditPath || !g1dAuditStoreId)) {
  throw new Error('D2 fresh TypeSafe analysis requires configured observations and durable D2 and G1d audit stores.');
}
const g1dAuditStore = (g1dAnalysisHandoffEnabled || g1dAnalysisEnabled) && g1dAuditPath && g1dAuditStoreId
  ? openG1DShadowAuditStore({ databasePath: g1dAuditPath, storeId: g1dAuditStoreId })
  : null;

let rpcBudget: RpcRunBudget | null = null;
let baseProvider: ReturnType<typeof createBaseReadOnlyProvider> | null = null;
let d2PolicyProvider: BaseD2PolicyProvider | undefined;
let d2Gateway: ReturnType<typeof createD2G3cGateway> | undefined;
if (baseReadsEnabled) {
  const signingKeyPath = process.env.G3C_EVIDENCE_SIGNING_KEY_PATH;
  const keyId = process.env.G3C_EVIDENCE_KEY_ID;
  if (!rpcUrl || !signingKeyPath || !keyId || !g3cTrustPath) throw new Error('Base read configuration is incomplete.');
  const maxRequests = envInteger('D2_RPC_MAX_REQUESTS', DEFAULT_D2_RPC_MAX_REQUESTS);
  const recoveryReserve = envInteger('D2_RPC_RECOVERY_RESERVE', DEFAULT_D2_RPC_RECOVERY_RESERVE);
  if (recoveryReserve < MIN_D2_RPC_RECOVERY_RESERVE || recoveryReserve >= maxRequests) throw new Error('D2_RPC_RECOVERY_RESERVE must be at least 192 and less than D2_RPC_MAX_REQUESTS.');
  rpcBudget = new RpcRunBudget(randomUUID(), maxRequests, recoveryReserve);
  const authority = loadProductionG3cEvidenceAuthority({
    privateKeyPath: signingKeyPath, keyId, repositoryRoot: process.cwd(),
  });
  const evidenceTrust = authority.trust;
  const trustedKey = g3cTrust.publicKeys[keyId];
  if (!trustedKey || trustedKey !== evidenceTrust.publicKeys[keyId]) throw new Error('G3C_EVIDENCE_SIGNING_KEY_NOT_IN_TRUST_MAP.');
  baseProvider = createBaseReadOnlyProvider({ rpcUrl, authority, rpcBudget });
  d2PolicyProvider = new BaseD2PolicyProvider({ provider: baseProvider, store: g3cStatusStore, trust: evidenceTrust });
  d2Gateway = createD2G3cGateway({ store: g3cStatusStore, provider: baseProvider });
}
const d2Production = observations && d2Audit
  ? createD2ProductionService({
    observations, audit: d2Audit, executionStore, g3cStatusReader: g3cStatusStore,
    ...(d2PolicyProvider ? { policyProvider: d2PolicyProvider } : {}),
    ...(d2Gateway ? { g3cGateway: d2Gateway } : {}),
    ...(g1dAuditStore ? { g1dAuditStore } : {}),
    g1dAnalysisHandoffEnabled,
  })
  : undefined;
if ((signingRequested || submissionRequested) && (!d2Production || !baseProvider || !d2Gateway || !rpcUrl)) {
  throw new Error('D2 execution services require production D2, Base provider and RPC configuration.');
}
let signer: ReturnType<typeof createProductionG3cSigner> | undefined;
let broadcaster: ReturnType<typeof createBaseG3cBroadcaster> | undefined;
if (signingRequested) {
  signer = createProductionG3cSigner({
    privateKeyPath: absoluteExternalPath('G3C_SIGNER_PRIVATE_KEY_PATH'),
    hmacSecretPath: absoluteExternalPath('G3C_SIGNER_HMAC_SECRET_PATH'),
    trustPath: absoluteExternalPath('G3C_EVIDENCE_TRUST_PATH'),
    statePath: absoluteExternalPath('G3C_SIGNER_STATE_PATH'), repositoryRoot: process.cwd(),
  });
}
if (submissionRequested) broadcaster = createBaseG3cBroadcaster({ rpcUrl: rpcUrl!, enabled: true });
const d2Execution = d2Production
  ? createD2ExecutionService({
    production: d2Production, store: g3cStatusStore,
    ...(baseProvider ? { provider: baseProvider } : {}),
    ...(signer ? { signer } : {}), ...(broadcaster ? { broadcaster } : {}),
    signingEnabled: signingRequested && reviewedExecutionGate && signerDeployed,
    submissionEnabled: submissionRequested && reviewedExecutionGate && broadcasterDeployed,
  })
  : undefined;
const d2FreshAnalysis = observations && d2Production ? createD2FreshAnalysisService({
  observations, proposal: (proposalId) => d2Production.proposal(proposalId),
  ...(g1dAuditStore ? { auditStore: g1dAuditStore } : {}),
  ...(d2Audit ? { proposalAssociationStore: d2Audit } : {}),
  analysisEnabled: g1dAnalysisEnabled,
  ...(g1dAnalysisEnabled ? { apiKeyProvider: () => process.env.TYPESAFE_API_KEY } : {}),
}) : undefined;
const d1Demo = process.env.NODE_ENV === 'production' ? undefined : createD1DemoService();
function runtimeStatus(): D2Runtime {
  const budget = rpcBudget?.snapshot();
  const reviewedMode = reviewedExecutionGate;
  const signingEnabled = d2Execution?.signingEnabled ?? false;
  const submissionEnabled = d2Execution?.submissionEnabled ?? false;
  return {
    service: 'ered-luin-api', status: observations && d2Audit ? 'ok' : 'degraded',
    appMode: signingEnabled || submissionEnabled ? 'LIVE_REVIEWED' : 'PRODUCTION_READ_ONLY',
    paidNansenCallsEnabled: false, activeNansenCreditBudget: 0,
    liveExecutionEnabled: signingEnabled || submissionEnabled,
    executionControls: { operatorAuthConfigured: operatorAuth.configured, signingEnabled, submissionEnabled, reviewedMode },
    nansenObservationStore: observations ? 'configured' : 'unconfigured',
    productionEvaluation: d2Production ? 'configured' : 'unconfigured',
    baseRpc: baseReadsEnabled ? 'read_only_enabled' : 'disabled',
    g3cStatusReader: 'configured',
    rpcRunBudget: budget ? { maxRequests: budget.maxRequests, usedRequests: budget.usedRequests, recoveryReserve: budget.recoveryReserve } : null,
  };
}
export const app = createApiApp({
  store, dataProvider: provider, g3cStatusReader: g3cStatusStore, d2Runtime: runtimeStatus, operatorAuth,
  ...(d1Demo ? { d1Demo } : {}), ...(d2Production ? { d2Production } : {}),
  ...(d2FreshAnalysis ? { d2FreshAnalysis } : {}), ...(d2Execution ? { d2Execution } : {}),
});
if (signer) app.addHook('onClose', async () => { await signer?.close(); });
if (broadcaster) app.addHook('onClose', async () => { broadcaster?.close(); });

if (process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PORT is invalid.');
  await app.listen({ host: '127.0.0.1', port });
}

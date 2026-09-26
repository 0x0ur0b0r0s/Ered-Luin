import { randomBytes } from 'node:crypto';
import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { initializeD2AuditStore } from '../../apps/api/dist/d2-audit-store.js';
import { initializePaperStore } from '../../apps/api/dist/paper-store.js';
import { initializeNansenObservationStore } from '../../packages/nansen/dist/index.js';

function assert(condition, message) { if (!condition) throw new Error('SMOKE_ASSERTION_FAILED:' + message); }
function restoreEnvironment(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

let temporaryRoot = null;
let app = null;
let listening = false;
const saved = {};
const environment = {
  NODE_ENV: 'test', NANSEN_API_ENABLED: 'false', NANSEN_CREDIT_BUDGET: '0',
  LIVE_EXECUTION_ENABLED: 'false', EXECUTION_MODE: 'paper',
  D2_BASE_READS_ENABLED: 'false', D2_DEPLOYMENT_REVIEWED: 'false', ALCHEMY_BUDGET_VERIFIED: 'false',
  D2_SIGNING_ENABLED: 'false', D2_BROADCAST_ENABLED: 'false', D2_EXECUTION_REVIEWED: 'false',
  G3C_REVIEWED_MODE: 'false', G3C_SIGNER_DEPLOYED: 'false', BASE_BROADCASTER_DEPLOYED: 'false',
  D2_G1D_ANALYSIS_HANDOFF_ENABLED: 'false', D2_G1D_ANALYSIS_ENABLED: 'false', G1D_SHADOW_AUDIT_STORE_PATH: '', G1D_SHADOW_AUDIT_STORE_ID: '',
  D2_RPC_MAX_REQUESTS: '896', D2_RPC_RECOVERY_RESERVE: '192',
  D2_OPERATOR_SECRET: randomBytes(32).toString('base64url'),
  D2_OPERATOR_ALLOWED_ORIGIN: 'http://127.0.0.1:5173', PORT: '3000',
};

try {
  temporaryRoot = mkdtempSync(join(tmpdir(), 'ered-luin-d2c-smoke-'));
  const tempRelative = relative(resolve(tmpdir()), resolve(temporaryRoot));
  assert(tempRelative !== '..' && !tempRelative.startsWith('..' + sep) && !isAbsolute(tempRelative) &&
    lstatSync(temporaryRoot).isDirectory() && temporaryRoot.includes('ered-luin-d2c-smoke-'), 'temporary workspace is owned and external');
  const paperPath = join(temporaryRoot, 'paper.sqlite');
  const observationPath = join(temporaryRoot, 'observations.sqlite');
  const auditPath = join(temporaryRoot, 'd2-audit.sqlite');
  const paper = initializePaperStore({ databasePath: paperPath });
  paper.close();
  const observations = initializeNansenObservationStore({ databasePath: observationPath, storeId: 'd2c-offline-smoke' });
  observations.close();
  const audit = initializeD2AuditStore({ databasePath: auditPath });
  audit.close();
  Object.assign(environment, {
    PAPER_STATE_PATH: paperPath,
    NANSEN_OBSERVATION_STORE_PATH: observationPath,
    NANSEN_OBSERVATION_STORE_ID: 'd2c-offline-smoke',
    D2_AUDIT_STORE_PATH: auditPath,
  });
  for (const [key, value] of Object.entries(environment)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  const api = await import('../../apps/api/dist/server.js');
  app = api.app;
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  listening = true;
  const base = address;
  async function request(path, init = {}) {
    const response = await fetch(new URL(path, base), init);
    const body = await response.json();
    return { status: response.status, body, headers: response.headers };
  }

  const health = await request('/healthz');
  assert(health.status === 200 && health.body.status === 'ok' && health.body.activeNansenCreditBudget === 0 &&
    health.body.paidNansenCallsEnabled === false && health.body.liveExecutionEnabled === false, 'health reports offline defaults');
  const runtime = await request('/v2/runtime');
  assert(runtime.status === 200 && runtime.body.nansenObservationStore === 'configured' &&
    runtime.body.productionEvaluation === 'configured' && runtime.body.baseRpc === 'disabled' &&
    runtime.body.executionControls.signingEnabled === false && runtime.body.executionControls.submissionEnabled === false,
  'runtime reflects external temp stores and disabled provider/execution gates');

  const demo = await request('/v1/demo/proposals', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenarioId: 'ALLOW' }),
  });
  assert(demo.status === 201 && demo.body.evidence?.source === 'synthetic' &&
    demo.body.evidence?.label === 'SYNTHETIC FIXTURE — NOT MARKET EVIDENCE', 'synthetic demo proposal is clearly labeled');

  const login = await request('/v1/operator/login', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: environment.D2_OPERATOR_ALLOWED_ORIGIN },
    body: JSON.stringify({ password: environment.D2_OPERATOR_SECRET }),
  });
  assert(login.status === 200 && login.body.authenticated === true, 'ephemeral local operator login succeeds');
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  assert(cookie.length > 0, 'local operator session cookie returned');
  const proposal = await request('/v1/production/proposals', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: environment.D2_OPERATOR_ALLOWED_ORIGIN, cookie },
    body: JSON.stringify({ walletAddress: '0x1111111111111111111111111111111111111111', requestedUsdcMicros: '4000000' }),
  });
  assert(proposal.status === 201 && proposal.body.analysis.semanticStatus === 'NOT_CONFIGURED' &&
    proposal.body.analysis.semanticHandoff.status === 'UNAVAILABLE' && proposal.body.analysis.semanticHandoff.reason === 'HANDOFF_DISABLED' &&
    proposal.body.analysis.semanticAuthority === 'NONE' && proposal.body.evidence.observations.length === 0,
  'D2 proposal is deterministic and reports the optional stored judgment as unavailable');
  const preview = await request('/v1/production/analysis/preview', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: environment.D2_OPERATOR_ALLOWED_ORIGIN, cookie },
    body: JSON.stringify({ proposalId: proposal.body.proposalId }),
  });
  assert(preview.status === 200 && preview.body.requestsMade === 0 && preview.body.authority === 'NONE' &&
    preview.body.canInvoke === false && preview.body.missingPrerequisites.includes('ANALYSIS_DISABLED') &&
    preview.body.missingPrerequisites.includes('NO_OBSERVATIONS'), 'fresh-analysis preview is authenticated, dry-run only, and fails closed');
  const disabledAnalysis = await request('/v1/production/analysis/invoke', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: environment.D2_OPERATOR_ALLOWED_ORIGIN, cookie },
    body: JSON.stringify({ proposalId: proposal.body.proposalId, requestHash: preview.body.requestHash }),
  });
  assert(disabledAnalysis.status === 200 && disabledAnalysis.body.status === 'DISABLED' &&
    disabledAnalysis.body.requestsMade === 0 && disabledAnalysis.body.authority === 'NONE', 'disabled analysis gate issues no model request');
  const evaluation = await request('/v1/production/evaluations', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: environment.D2_OPERATOR_ALLOWED_ORIGIN, cookie },
    body: JSON.stringify({ proposalId: proposal.body.proposalId }),
  });
  assert(evaluation.status === 200 && evaluation.body.executionMode === 'READ_ONLY' &&
    evaluation.body.paperFillCreated === false && evaluation.body.decision.status === 'REQUIRE_REVIEW', 'independent policy evaluation fails closed on missing evidence');

  await app.close();
  listening = false;
  app = null;
  process.stdout.write(JSON.stringify({ status: 'PASS', api: 'started/status checked/shut down on loopback',
    syntheticDemo: 'clearly labeled', productionProposal: 'deterministic; handoff off',
    evaluation: 'REQUIRE_REVIEW on missing account/evidence', freshAnalysis: 'authenticated zero-call preview; independent gate disabled',
    providerCalls: 0, typesafeRequests: 0, paidNansenCredits: 0,
    baseReads: 0, signerInvocations: 0, broadcasterInvocations: 0 }) + '\n');
} catch (error) {
  process.stderr.write('D2c offline API smoke failed: ' + (error instanceof Error ? error.message : 'UNKNOWN') + '\n');
  process.exitCode = 1;
} finally {
  if (app && listening) { try { await app.close(); } catch { /* Preserve the original smoke result. */ } }
  restoreEnvironment(saved);
  if (temporaryRoot) {
    const resolvedTempRoot = resolve(temporaryRoot);
    const tempRelative = relative(resolve(tmpdir()), resolvedTempRoot);
    if (tempRelative !== '..' && !tempRelative.startsWith('..' + sep) && !isAbsolute(tempRelative) &&
        lstatSync(resolvedTempRoot).isDirectory() && resolvedTempRoot.includes('ered-luin-d2c-smoke-')) {
      rmSync(resolvedTempRoot, { recursive: true, force: true });
    }
  }
}

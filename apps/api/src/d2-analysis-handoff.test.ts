import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  G1D_FEATURE_DEFINITIONS, G1D_MODEL_ALIAS, G1D_QUESTION_ID, G1D_QUESTION_VERSION,
  buildG1DEvidencePacket, createG1DShadowEvaluator, createG1DTypeSafeRequest, g1dQuestionSetHash, g1dRequestHash,
  initializeG1DShadowAuditStore, type G1DShadowAuditStore,
  type ManagedQueryResult, type NansenOperation, type ObservationSnapshot,
} from '@ered-luin/nansen';
import { readD2SemanticHandoff, resolveD2SemanticHandoff } from './d2-analysis-handoff.js';
import { D2AuditStoreError, initializeD2AuditStore } from './d2-audit-store.js';
import { createD2ProductionService } from './d2-production.js';
import { createD2FreshAnalysisService } from './d2-fresh-analysis.js';
import { createApiApp } from './api.js';
import { LocalOperatorAuthenticator } from './operator-auth.js';
import { initializePaperStore } from './paper-store.js';

const NOW = new Date('2026-09-24T18:00:00.000Z');
const FETCHED = new Date(NOW.getTime() - 60_000).toISOString();
let root = '';
let stores: G1DShadowAuditStore[] = [];

function snapshots(source: 'nansen' | 'synthetic' = 'synthetic'): ObservationSnapshot[] {
  const operations: readonly NansenOperation[] = ['TOKEN_SCREENER', 'FLOW_INTELLIGENCE', 'SMART_MONEY_NETFLOW'];
  return operations.map((operation) => {
    const signals = G1D_FEATURE_DEFINITIONS.filter((feature) => feature.endpoint === operation).map((feature) => ({
      signalId: randomUUID(), provider: source, endpoint: feature.endpoint, chainId: 8453 as const,
      asset: feature.asset, metric: feature.metric, observedAt: FETCHED, fetchedAt: FETCHED,
      quality: 'COMPLETE' as const, value: '1000000', unit: 'usd_micros' as const,
      provenanceId: 'synthetic-or-nansen-provenance-' + randomUUID(),
    }));
    return {
      snapshotId: randomUUID(), cacheKey: createHash('sha256').update(operation).digest('hex'), operation,
      asset: operation === 'FLOW_INTELLIGENCE' ? 'WETH' as const : 'BASE_PAIR' as const,
      timeframe: '1h' as const, pageBound: 1, retryBound: 0, source, fetchedAt: FETCHED,
      acquiredAt: FETCHED, expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
      completeness: 'complete' as const, failure: null, pageReferences: [], unavailableFields: [], signals,
    };
  });
}
function managed(sources: readonly ObservationSnapshot[]): ManagedQueryResult[] {
  return sources.map((snapshot) => ({
    cacheKey: snapshot.cacheKey, operation: snapshot.operation, asset: snapshot.asset,
    timeframe: snapshot.timeframe, pageBound: snapshot.pageBound, retryBound: snapshot.retryBound,
    status: 'fresh' as const, source: snapshot.source, fetchedAt: snapshot.fetchedAt, acquiredAt: snapshot.acquiredAt,
    ageMs: 60_000, completeness: 'complete' as const, quality: 'COMPLETE' as const, observations: snapshot.signals,
    failure: null, storeError: null, managerError: null, pageReferences: [], attemptPageReferences: [], cacheHit: false,
    coalesced: false, qualifyingSuccessfulRequests: 1,
  }));
}
function observedRecord(current: readonly ObservationSnapshot[]) {
  const packet = buildG1DEvidencePacket(managed(current), { now: NOW });
  const request = createG1DTypeSafeRequest(packet);
  const store = initializeG1DShadowAuditStore({ databasePath: join(root, 'g1d.sqlite'), storeId: 'd2c-test-store', clock: () => NOW });
  stores.push(store);
  const attemptId = randomUUID();
  store.recordPending({ attemptId, requestHash: g1dRequestHash(request), questionSetHash: g1dQuestionSetHash(),
    createdAt: new Date(NOW.getTime() - 30_000).toISOString(), requestedModel: G1D_MODEL_ALIAS, request });
  return store.recordCompletion(attemptId, { status: 'OBSERVED', resolvedModel: 'jev-1.13.0', answer: { type: 'noul', noul: 0.63 },
    usage: { input_tokens: 40, output_tokens: 7 }, latencyMs: 15, httpStatus: 200, errorCode: null, advisoryRoute: 'WATCH' });
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ered-luin-d2c-handoff-')); stores = []; });
afterEach(() => { for (const store of stores) { try { store.close(); } catch { /* Closed by service cleanup. */ } } rmSync(root, { recursive: true, force: true }); });

describe('D2 optional stored G1d analysis handoff', () => {
  it('returns only the exact fresh synthetic judgment and labels it as a fixture', () => {
    const current = snapshots('synthetic');
    const record = observedRecord(current);
    const handoff = resolveD2SemanticHandoff({ records: [record], snapshots: current, evidenceFreshness: 'fresh', now: NOW });
    expect(handoff).toMatchObject({ status: 'FIXTURE', source: 'synthetic', authority: 'NONE', answer: 0.63,
      label: 'SYNTHETIC FIXTURE — NOT MARKET ANALYSIS' });
  });

  it('composes the actual evaluator, durable fake-response audit, and synthetic D2 handoff', async () => {
    const current = snapshots('synthetic');
    const shadowStore = initializeG1DShadowAuditStore({ databasePath: join(root, 'g1d-evaluator.sqlite'),
      storeId: 'd2e-evaluator-test', clock: () => NOW });
    stores.push(shadowStore);
    let requests = 0;
    const evaluator = createG1DShadowEvaluator({
      enabled: true, apiKey: 'synthetic-only-test-key', auditStore: shadowStore, clock: () => NOW,
      transport: async () => {
        requests += 1;
        return { status: 200, body: new TextEncoder().encode(JSON.stringify({ model: 'jev-1.13.0',
          answers: { [G1D_QUESTION_ID]: { type: 'noul', noul: 0.63 } }, usage: { input_tokens: 44, output_tokens: 8 } })) };
      },
    });
    const result = await evaluator.evaluate(managed(current));
    expect(result).toMatchObject({ status: 'OBSERVED', requestsMade: 1, authority: 'NONE', answer: { noul: 0.63 } });
    expect(requests).toBe(1);
    const record = shadowStore.getAttempt(result.attemptId!);
    expect(record).toMatchObject({ status: 'OBSERVED', requestsMade: 1, resolvedModel: 'jev-1.13.0' });
    expect(JSON.stringify(record)).not.toContain('synthetic-only-test-key');
    const handoff = resolveD2SemanticHandoff({ records: [record!], snapshots: current, evidenceFreshness: 'fresh', now: NOW });
    expect(handoff).toMatchObject({ status: 'FIXTURE', source: 'synthetic', authority: 'NONE', answer: 0.63,
      label: 'SYNTHETIC FIXTURE — NOT MARKET ANALYSIS' });
  });

  it('binds the enabled invocation, reload projection, cache reuse, and immutable evidence to its original proposal', async () => {
    const originalSnapshots = snapshots('nansen'); // Nansen-shaped synthetic fixtures only; these are not market evidence.
    let current = originalSnapshots;
    const shadowStore = initializeG1DShadowAuditStore({ databasePath: join(root, 'g1d-fresh-service.sqlite'),
      storeId: 'd2e-fresh-service-test', clock: () => NOW });
    stores.push(shadowStore);
    const audit = initializeD2AuditStore({ databasePath: join(root, 'd2-fresh-service.sqlite') });
    const production = createD2ProductionService({ observations: { getLatestSnapshots: () => current }, audit,
      g1dAuditStore: shadowStore, g1dAnalysisHandoffEnabled: true, clock: () => NOW });
    let app: ReturnType<typeof createApiApp> | undefined;
    let paper: ReturnType<typeof initializePaperStore> | undefined;
    try {
      const intent = { walletAddress: '0x1111111111111111111111111111111111111111', requestedUsdcMicros: '4000000' };
      const originalProposal = production.createProposal(intent);
      const persistedEvidence = audit.getProposal(originalProposal.proposalId)!.evidence;
      let credentialReads = 0;
      let transportCalls = 0;
      const evaluator = createG1DShadowEvaluator({ enabled: true, apiKey: 'synthetic-test-only', auditStore: shadowStore,
        clock: () => NOW, transport: async () => {
          transportCalls += 1;
          return { status: 200, body: new TextEncoder().encode(JSON.stringify({ model: 'jev-1.13.0',
            answers: { [G1D_QUESTION_ID]: { type: 'noul', noul: 0.63 } }, usage: { input_tokens: 44, output_tokens: 8 } })) };
        } });
      const service = createD2FreshAnalysisService({ observations: { getLatestSnapshots: () => current },
        proposal: (proposalId) => production.proposal(proposalId), auditStore: shadowStore,
        proposalAssociationStore: audit, analysisEnabled: true,
        apiKeyProvider: () => { credentialReads += 1; return 'synthetic-test-only'; }, evaluator, clock: () => NOW });
      paper = initializePaperStore({ databasePath: join(root, 'paper-fresh-service.sqlite'), clock: () => NOW });
      const operatorAuth = new LocalOperatorAuthenticator({ secret: 'A'.repeat(43),
        allowedOrigin: 'http://127.0.0.1:5173', clock: () => NOW });
      const login = operatorAuth.login({ password: 'A'.repeat(43), origin: 'http://127.0.0.1:5173',
        hostname: '127.0.0.1', remoteAddress: '127.0.0.1' });
      if (!login.ok) throw new Error('Synthetic operator login failed.');
      const operatorHeaders = { origin: 'http://127.0.0.1:5173', cookie: login.cookie.split(';')[0]! };
      app = createApiApp({ store: paper, d2Production: production, d2FreshAnalysis: service,
        operatorAuth, clock: () => NOW });

      const originalPreview = service.preview(originalProposal.proposalId);
      expect(originalPreview).toMatchObject({ status: 'READY', canInvoke: true, requestsMade: 0, authority: 'NONE' });
      expect(credentialReads).toBe(0);
      current = originalSnapshots.map((snapshot) => ({ ...snapshot, snapshotId: randomUUID() }));
      const changedEvidence = await service.invoke({ proposalId: originalProposal.proposalId, requestHash: originalPreview.requestHash });
      expect(changedEvidence).toMatchObject({ status: 'BLOCKED', requestsMade: 0, authority: 'NONE', reason: 'PROPOSAL_EVIDENCE_MISMATCH' });
      expect(credentialReads).toBe(0);
      expect(transportCalls).toBe(0);

      current = originalSnapshots;
      const previewResponse = await app.inject({ method: 'POST', url: '/v1/production/analysis/preview',
        headers: operatorHeaders, payload: { proposalId: originalProposal.proposalId } });
      expect(previewResponse.statusCode).toBe(200);
      const preview = previewResponse.json() as ReturnType<typeof service.preview>;
      expect(preview.requestHash).toBe(originalPreview.requestHash);
      const invokeResponse = await app.inject({ method: 'POST', url: '/v1/production/analysis/invoke',
        headers: operatorHeaders, payload: { proposalId: originalProposal.proposalId, requestHash: preview.requestHash } });
      expect(invokeResponse.statusCode).toBe(200);
      const result = invokeResponse.json() as Awaited<ReturnType<typeof service.invoke>>;
      expect(result).toMatchObject({ status: 'OBSERVED', requestsMade: 1, authority: 'NONE', answer: 0.63,
        approvedRequestHash: preview.requestHash, recordRequestHash: preview.requestHash, reason: null });
      expect(credentialReads).toBe(1);
      expect(transportCalls).toBe(1);
      const record = shadowStore.getAttempt(result.attemptId!);
      expect(record).toMatchObject({ status: 'OBSERVED', requestsMade: 1, requestHash: preview.requestHash });
      expect(JSON.stringify(record)).not.toContain('synthetic-test-only');
      expect(audit.getSemanticAssociation(originalProposal.proposalId)).toMatchObject({
        proposalId: originalProposal.proposalId, attemptId: result.attemptId, requestHash: preview.requestHash,
      });

      const reloadResponse = await app.inject({ method: 'GET', url: '/v1/production/proposals/' + originalProposal.proposalId,
        headers: operatorHeaders });
      expect(reloadResponse.statusCode).toBe(200);
      const linked = reloadResponse.json() as NonNullable<ReturnType<typeof production.proposal>>;
      expect(linked.analysis).toMatchObject({ semanticStatus: 'OBSERVED', semanticAuthority: 'NONE',
        semanticHandoff: { status: 'OBSERVED', source: 'nansen', authority: 'NONE', answer: 0.63,
          attemptId: result.attemptId, requestHash: preview.requestHash } });
      expect(linked.evidence).toEqual(persistedEvidence);
      expect(audit.getProposal(originalProposal.proposalId)!.evidence).toEqual(persistedEvidence);
      expect(audit.getProposal(originalProposal.proposalId)!.analysis.semanticHandoff.status).toBe('UNAVAILABLE');

      const cachedPreview = service.preview(originalProposal.proposalId);
      const cached = await service.invoke({ proposalId: originalProposal.proposalId, requestHash: cachedPreview.requestHash });
      expect(cached).toMatchObject({ status: 'CACHED', requestsMade: 0, authority: 'NONE', attemptId: result.attemptId });
      expect(credentialReads).toBe(1);
      expect(transportCalls).toBe(1);
      expect(production.proposal(originalProposal.proposalId)?.analysis.semanticHandoff).toMatchObject({
        status: 'OBSERVED', attemptId: result.attemptId, requestHash: preview.requestHash,
      });

      const reusedProposal = production.createProposal(intent);
      expect(reusedProposal.analysis.semanticHandoff).toMatchObject({ status: 'UNAVAILABLE', reason: 'NO_MATCHING_JUDGMENT' });
      const reusedPreviewResponse = await app.inject({ method: 'POST', url: '/v1/production/analysis/preview',
        headers: operatorHeaders, payload: { proposalId: reusedProposal.proposalId } });
      expect(reusedPreviewResponse.statusCode).toBe(200);
      const reusedPreview = reusedPreviewResponse.json() as ReturnType<typeof service.preview>;
      expect(reusedPreview).toMatchObject({ status: 'READY', canInvoke: true, requestsMade: 0, authority: 'NONE' });
      expect(reusedPreview.requestHash).toBe(preview.requestHash);
      const reusedInvokeResponse = await app.inject({ method: 'POST', url: '/v1/production/analysis/invoke',
        headers: operatorHeaders, payload: { proposalId: reusedProposal.proposalId, requestHash: reusedPreview.requestHash } });
      expect(reusedInvokeResponse.statusCode).toBe(200);
      const reusedResult = reusedInvokeResponse.json() as Awaited<ReturnType<typeof service.invoke>>;
      expect(reusedResult).toMatchObject({ status: 'CACHED', requestsMade: 0, authority: 'NONE',
        attemptId: result.attemptId, approvedRequestHash: preview.requestHash, recordRequestHash: preview.requestHash });
      expect(credentialReads).toBe(1);
      expect(transportCalls).toBe(1);
      const reusedAssociation = audit.getSemanticAssociation(reusedProposal.proposalId);
      expect(reusedAssociation).toMatchObject({ proposalId: reusedProposal.proposalId,
        attemptId: result.attemptId, requestHash: preview.requestHash });
      expect(reusedAssociation?.evidenceHash).toBe(audit.getSemanticAssociation(originalProposal.proposalId)?.evidenceHash);
      expect(audit.getProposal(reusedProposal.proposalId)?.evidence).toEqual(persistedEvidence);
      expect(production.proposal(reusedProposal.proposalId)?.analysis.semanticHandoff)
        .toMatchObject({ status: 'OBSERVED', attemptId: result.attemptId, requestHash: preview.requestHash });

      const conflictingProposal = production.createProposal(intent);
      expect(() => audit.associateSemanticAttempt({ proposalId: conflictingProposal.proposalId, attemptId: result.attemptId!,
        requestHash: 'ef'.repeat(32), createdAt: NOW.toISOString() })).toThrowError(D2AuditStoreError);
      expect(() => audit.associateSemanticAttempt({ proposalId: conflictingProposal.proposalId, attemptId: randomUUID(),
        requestHash: preview.requestHash, createdAt: NOW.toISOString() })).toThrowError(D2AuditStoreError);
      expect(() => audit.associateSemanticAttempt({ proposalId: originalProposal.proposalId, attemptId: randomUUID(),
        requestHash: preview.requestHash, createdAt: NOW.toISOString() })).toThrowError(D2AuditStoreError);

      current = originalSnapshots.map((snapshot) => ({ ...snapshot,
        fetchedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
        acquiredAt: new Date(NOW.getTime() - 60 * 60_000).toISOString() }));
      expect(production.proposal(originalProposal.proposalId)?.analysis.semanticHandoff)
        .toMatchObject({ status: 'UNAVAILABLE', reason: 'EVIDENCE_STALE' });
      current = originalSnapshots;
      expect(production.proposal(originalProposal.proposalId)?.analysis.semanticHandoff)
        .toMatchObject({ status: 'OBSERVED', attemptId: result.attemptId });
    } finally {
      if (app) await app.close();
      production.close();
      paper?.close();
    }
  });



  it('retrieves completed judgments after a process restart and preserves interrupted PENDING ambiguity', async () => {
    const fixtureSnapshots = snapshots('nansen'); // Nansen-shaped values generated in this test only; never market evidence.
    const observations = { getLatestSnapshots: () => fixtureSnapshots };
    const encodedSnapshots = Buffer.from(JSON.stringify(fixtureSnapshots)).toString('base64');
    const childPrelude = [
      "import { resolve } from 'node:path';",
      "import { pathToFileURL } from 'node:url';",
      "const projectRoot = resolve('../..');",
      "const api = (name) => pathToFileURL(resolve(projectRoot, 'apps/api/dist/' + name + '.js')).href;",
      "const nansen = await import('@ered-luin/nansen');",
      "const { createD2ProductionService } = await import(api('d2-production'));",
      "const { createD2FreshAnalysisService } = await import(api('d2-fresh-analysis'));",
      "const { createG1DShadowEvaluator } = nansen;",
      "const NOW = new Date(process.argv[6]);",
      "const snapshots = JSON.parse(Buffer.from(process.argv[5], 'base64').toString('utf8'));",
      "const observations = { getLatestSnapshots: () => snapshots };",
    ];
    const completeShadow = initializeG1DShadowAuditStore({ databasePath: join(root, 'g1d-complete-restart.sqlite'),
      storeId: 'd2e-complete-restart', clock: () => NOW });
    stores.push(completeShadow);
    const completeAudit = initializeD2AuditStore({ databasePath: join(root, 'd2-complete-restart.sqlite') });
    const completeProduction = createD2ProductionService({ observations, audit: completeAudit, g1dAuditStore: completeShadow,
      g1dAnalysisHandoffEnabled: true, clock: () => NOW });
    let completedProposalIds: string[] = [];
    let completedHash = '';
    let completedAttemptId = '';
    try {
      const proposal = completeProduction.createProposal({
        walletAddress: '0x1111111111111111111111111111111111111111', requestedUsdcMicros: '4000000',
      });
      let credentials = 0;
      let requests = 0;
      const evaluator = createG1DShadowEvaluator({ enabled: true, apiKey: 'synthetic-restart-only', auditStore: completeShadow,
        clock: () => NOW, transport: async () => {
          requests += 1;
          return { status: 200, body: new TextEncoder().encode(JSON.stringify({ model: 'jev-1.13.0',
            answers: { [G1D_QUESTION_ID]: { type: 'noul', noul: 0.63 } }, usage: { input_tokens: 44, output_tokens: 8 } })) };
        } });
      const service = createD2FreshAnalysisService({ observations, proposal: (id) => completeProduction.proposal(id),
        auditStore: completeShadow, proposalAssociationStore: completeAudit, analysisEnabled: true,
        apiKeyProvider: () => { credentials += 1; return 'synthetic-restart-only'; }, evaluator, clock: () => NOW });
      const preview = service.preview(proposal.proposalId);
      completedHash = preview.requestHash;
      const invoked = await service.invoke({ proposalId: proposal.proposalId, requestHash: preview.requestHash });
      expect(invoked.status).toBe('OBSERVED');
      completedAttemptId = invoked.attemptId!;

      const reused = completeProduction.createProposal({
        walletAddress: '0x1111111111111111111111111111111111111111', requestedUsdcMicros: '4000000',
      });
      expect(reused.analysis.semanticHandoff).toMatchObject({ status: 'UNAVAILABLE', reason: 'NO_MATCHING_JUDGMENT' });
      const reusedPreview = service.preview(reused.proposalId);
      expect(reusedPreview.requestHash).toBe(completedHash);
      const reusedInvoke = await service.invoke({ proposalId: reused.proposalId, requestHash: reusedPreview.requestHash });
      expect(reusedInvoke).toMatchObject({ status: 'CACHED', requestsMade: 0, authority: 'NONE', attemptId: completedAttemptId });
      expect(credentials).toBe(1);
      expect(requests).toBe(1);
      expect(completeAudit.getSemanticAssociation(reused.proposalId)).toMatchObject({
        proposalId: reused.proposalId, attemptId: completedAttemptId, requestHash: completedHash,
      });
      completedProposalIds = [proposal.proposalId, reused.proposalId];
    } finally {
      completeProduction.close();
    }
    const completedReadScript = [
      ...childPrelude,
      "const [d2Path, shadowPath, proposalIdsJson, storeId] = process.argv.slice(1, 5);",
      "const proposalIds = JSON.parse(proposalIdsJson);",
      "const { openD2AuditStore } = await import(api('d2-audit-store'));",
      "const audit = openD2AuditStore({ databasePath: d2Path });",
      "const shadow = nansen.openG1DShadowAuditStore({ databasePath: shadowPath, storeId, clock: () => NOW });",
      "const production = createD2ProductionService({ observations, audit, g1dAuditStore: shadow, g1dAnalysisHandoffEnabled: true, clock: () => NOW });",
      "try {",
      " const evaluator = createG1DShadowEvaluator({ enabled: true, apiKey: 'synthetic-restart-only', auditStore: shadow, clock: () => NOW, transport: async () => { throw new Error('preview must not invoke transport'); } });",
      " const fresh = createD2FreshAnalysisService({ observations, proposal: (id) => production.proposal(id), auditStore: shadow, proposalAssociationStore: audit, analysisEnabled: true, apiKeyProvider: () => 'synthetic-restart-only', evaluator, clock: () => NOW });",
      " const proposals = proposalIds.map((proposalId) => ({ proposalId, semanticHandoff: production.proposal(proposalId).analysis.semanticHandoff, association: audit.getSemanticAssociation(proposalId), evidence: audit.getProposal(proposalId).evidence, previewHash: fresh.preview(proposalId).requestHash }));",
      " console.log(JSON.stringify({ proposals }));",
      "} finally { production.close(); }",
    ].join('\n');
    const completedRestart = spawnSync(process.execPath, ['--input-type=module', '-e', completedReadScript,
      completeAuditPath(), completeShadowPath(), JSON.stringify(completedProposalIds), 'd2e-complete-restart', encodedSnapshots, NOW.toISOString()],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 30000 });
    expect(completedRestart.status, completedRestart.stderr || completedRestart.stdout).toBe(0);
    const completedProjection = JSON.parse(completedRestart.stdout.trim().split(/\r?\n/u).at(-1)!) as {
      proposals: { proposalId: string; semanticHandoff: { status: string; attemptId: string; requestHash: string; authority: string };
        association: { proposalId: string; attemptId: string; requestHash: string; evidenceHash: string };
        evidence: unknown; previewHash: string }[];
    };
    expect(completedProjection.proposals).toHaveLength(2);
    for (const proposal of completedProjection.proposals) {
      expect(proposal).toMatchObject({ semanticHandoff: { status: 'OBSERVED', attemptId: completedAttemptId,
        requestHash: completedHash, authority: 'NONE' },
        association: { proposalId: proposal.proposalId, attemptId: completedAttemptId, requestHash: completedHash },
        previewHash: completedHash });
    }
    expect(completedProjection.proposals[0]?.evidence).toEqual(completedProjection.proposals[1]?.evidence);
    expect(completedProjection.proposals[0]?.association.evidenceHash).toBe(completedProjection.proposals[1]?.association.evidenceHash);

    const pendingShadow = initializeG1DShadowAuditStore({ databasePath: join(root, 'g1d-pending-restart.sqlite'),
      storeId: 'd2e-pending-restart', clock: () => NOW });
    stores.push(pendingShadow);
    const pendingAudit = initializeD2AuditStore({ databasePath: join(root, 'd2-pending-restart.sqlite') });
    const pendingProduction = createD2ProductionService({ observations, audit: pendingAudit, g1dAuditStore: pendingShadow,
      g1dAnalysisHandoffEnabled: true, clock: () => NOW });
    let pendingProposalId = '';
    try {
      pendingProposalId = pendingProduction.createProposal({
        walletAddress: '0x2222222222222222222222222222222222222222', requestedUsdcMicros: '4000000',
      }).proposalId;
    } finally {
      pendingProduction.close();
    }
    const hangingInvokeScript = [
      ...childPrelude,
      "const [d2Path, shadowPath, proposalId, storeId] = process.argv.slice(1, 5);",
      "const { openD2AuditStore } = await import(api('d2-audit-store'));",
      "const audit = openD2AuditStore({ databasePath: d2Path });",
      "const shadow = nansen.openG1DShadowAuditStore({ databasePath: shadowPath, storeId, clock: () => NOW });",
      "const production = createD2ProductionService({ observations, audit, g1dAuditStore: shadow, g1dAnalysisHandoffEnabled: true, clock: () => NOW });",
      "const evaluator = createG1DShadowEvaluator({ enabled: true, apiKey: 'synthetic-interrupted-only', auditStore: shadow, clock: () => NOW, transport: async () => { process.stdout.write('PENDING_READY ' + preview.requestHash + '\\n'); return new Promise(() => {}); } });",
      "const fresh = createD2FreshAnalysisService({ observations, proposal: (id) => production.proposal(id), auditStore: shadow, proposalAssociationStore: audit, analysisEnabled: true, apiKeyProvider: () => 'synthetic-interrupted-only', evaluator, clock: () => NOW });",
      "const preview = fresh.preview(proposalId);",
      "await fresh.invoke({ proposalId, requestHash: preview.requestHash });",
    ].join('\n');
    const pendingChild = spawn(process.execPath, ['--input-type=module', '-e', hangingInvokeScript,
      pendingAuditPath(), pendingShadowPath(), pendingProposalId, 'd2e-pending-restart', encodedSnapshots, NOW.toISOString()],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let readyText = '';
    pendingChild.stdout.setEncoding('utf8');
    const becamePending = new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error('Interrupted test invocation did not reach its injected transport.')), 30000);
      pendingChild.stdout.on('data', (chunk: string) => {
        readyText += chunk;
        if (readyText.includes('PENDING_READY ')) { clearTimeout(timer); resolveReady(); }
      });
      pendingChild.once('error', (error) => { clearTimeout(timer); rejectReady(error); });
      pendingChild.once('close', (code) => {
        if (!readyText.includes('PENDING_READY ')) { clearTimeout(timer); rejectReady(new Error('Interrupted test child exited before its pending marker: ' + code)); }
      });
    });
    const childClosed = new Promise<void>((resolveClose) => pendingChild.once('close', () => resolveClose()));
    try {
      await becamePending;
    } finally {
      if (pendingChild.exitCode === null && pendingChild.signalCode === null) pendingChild.kill();
      await childClosed;
    }
    const pendingMatch = readyText.match(/PENDING_READY ([0-9a-f]{64})/u);
    expect(pendingMatch?.[1]).toBeTruthy();
    const recoveryScript = [
      ...childPrelude,
      "const [d2Path, shadowPath, proposalId, storeId] = process.argv.slice(1, 5);",
      "const { openD2AuditStore } = await import(api('d2-audit-store'));",
      "const audit = openD2AuditStore({ databasePath: d2Path });",
      "const shadow = nansen.openG1DShadowAuditStore({ databasePath: shadowPath, storeId, clock: () => NOW });",
      "const production = createD2ProductionService({ observations, audit, g1dAuditStore: shadow, g1dAnalysisHandoffEnabled: true, clock: () => NOW });",
      "let credentials = 0; let requests = 0;",
      "const evaluator = createG1DShadowEvaluator({ enabled: true, apiKey: 'synthetic-recovery-only', auditStore: shadow, clock: () => NOW, transport: async () => { requests += 1; return { status: 200, body: new TextEncoder().encode(JSON.stringify({ model: 'jev-1.13.0', answers: { [nansen.G1D_QUESTION_ID]: { type: 'noul', noul: 0.7 } }, usage: { input_tokens: 4, output_tokens: 2 } })) }; } });",
      "const fresh = createD2FreshAnalysisService({ observations, proposal: (id) => production.proposal(id), auditStore: shadow, proposalAssociationStore: audit, analysisEnabled: true, apiKeyProvider: () => { credentials += 1; return 'synthetic-recovery-only'; }, evaluator, clock: () => NOW });",
      "try { const preview = fresh.preview(proposalId); const result = await fresh.invoke({ proposalId, requestHash: preview.requestHash }); console.log(JSON.stringify({ previewHash: preview.requestHash, result, credentials, requests })); } finally { production.close(); }",
    ].join('\n');
    const pendingRestart = spawnSync(process.execPath, ['--input-type=module', '-e', recoveryScript,
      pendingAuditPath(), pendingShadowPath(), pendingProposalId, 'd2e-pending-restart', encodedSnapshots, NOW.toISOString()],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 30000 });
    expect(pendingRestart.status, pendingRestart.stderr || pendingRestart.stdout).toBe(0);
    const pendingProjection = JSON.parse(pendingRestart.stdout.trim().split(/\r?\n/u).at(-1)!) as {
      previewHash: string; result: { status: string; requestsMade: number; reason: string }; credentials: number; requests: number;
    };
    expect(pendingProjection.previewHash).toBe(pendingMatch![1]);
    expect(pendingProjection).toMatchObject({ result: { status: 'UNAVAILABLE', requestsMade: 0, reason: 'AMBIGUOUS_ATTEMPT' },
      credentials: 0, requests: 0 });

    function completeAuditPath() { return join(root, 'd2-complete-restart.sqlite'); }
    function completeShadowPath() { return join(root, 'g1d-complete-restart.sqlite'); }
    function pendingAuditPath() { return join(root, 'd2-pending-restart.sqlite'); }
    function pendingShadowPath() { return join(root, 'g1d-pending-restart.sqlite'); }
  });

  it('keeps preview, invoke, and proposal reload behind the original local operator boundary while gates are off', async () => {
    const current = snapshots('nansen');
    const shadowStore = initializeG1DShadowAuditStore({ databasePath: join(root, 'g1d-auth.sqlite'),
      storeId: 'd2e-auth-test', clock: () => NOW });
    stores.push(shadowStore);
    const audit = initializeD2AuditStore({ databasePath: join(root, 'd2-auth.sqlite') });
    const paper = initializePaperStore({ databasePath: join(root, 'paper-auth.sqlite'), clock: () => NOW });
    const production = createD2ProductionService({ observations: { getLatestSnapshots: () => current }, audit,
      g1dAuditStore: shadowStore, g1dAnalysisHandoffEnabled: true, clock: () => NOW });
    const auth = new LocalOperatorAuthenticator({ secret: 'A'.repeat(43), allowedOrigin: 'http://127.0.0.1:5173', clock: () => NOW });
    let credentialReads = 0;
    let transportCalls = 0;
    const proposal = production.createProposal({ walletAddress: '0x1111111111111111111111111111111111111111', requestedUsdcMicros: '4000000' });
    const freshAnalysis = createD2FreshAnalysisService({ observations: { getLatestSnapshots: () => current },
      proposal: (proposalId) => production.proposal(proposalId), auditStore: shadowStore, proposalAssociationStore: audit,
      analysisEnabled: false, apiKeyProvider: () => { credentialReads += 1; return 'must-not-be-read'; },
      evaluator: createG1DShadowEvaluator({ enabled: true, apiKey: 'synthetic-only', auditStore: shadowStore,
        clock: () => NOW, transport: async () => { transportCalls += 1; return { status: 200, body: new Uint8Array() }; } }),
      clock: () => NOW });
    const app = createApiApp({ store: paper, d2Production: production, d2FreshAnalysis: freshAnalysis, operatorAuth: auth, clock: () => NOW });
    try {
      const anonymousHeaders = { origin: 'http://127.0.0.1:5173' };
      const anonymousPreview = await app.inject({ method: 'POST', url: '/v1/production/analysis/preview', headers: anonymousHeaders,
        payload: { proposalId: proposal.proposalId } });
      const anonymousInvoke = await app.inject({ method: 'POST', url: '/v1/production/analysis/invoke', headers: anonymousHeaders,
        payload: { proposalId: proposal.proposalId, requestHash: 'ab'.repeat(32) } });
      const anonymousReload = await app.inject({ method: 'GET', url: '/v1/production/proposals/' + proposal.proposalId, headers: anonymousHeaders });
      expect(anonymousPreview.statusCode).toBe(401);
      expect(anonymousInvoke.statusCode).toBe(401);
      expect(anonymousReload.statusCode).toBe(401);
      const login = auth.login({ password: 'A'.repeat(43), origin: 'http://127.0.0.1:5173',
        hostname: '127.0.0.1', remoteAddress: '127.0.0.1' });
      if (!login.ok) throw new Error('Synthetic operator login failed.');
      const headers = { origin: 'http://127.0.0.1:5173', cookie: login.cookie.split(';')[0]! };
      const preview = await app.inject({ method: 'POST', url: '/v1/production/analysis/preview', headers,
        payload: { proposalId: proposal.proposalId } });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({ invocationEnabled: false, canInvoke: false, requestsMade: 0 });
      const invoke = await app.inject({ method: 'POST', url: '/v1/production/analysis/invoke', headers,
        payload: { proposalId: proposal.proposalId, requestHash: preview.json().requestHash } });
      expect(invoke.statusCode).toBe(200);
      expect(invoke.json()).toMatchObject({ status: 'DISABLED', requestsMade: 0, authority: 'NONE' });
      const reload = await app.inject({ method: 'GET', url: '/v1/production/proposals/' + proposal.proposalId, headers });
      expect(reload.statusCode).toBe(200);
      expect(reload.json()).toMatchObject({ proposalId: proposal.proposalId,
        analysis: { semanticHandoff: { status: 'UNAVAILABLE', authority: 'NONE' } } });
      expect(credentialReads).toBe(0);
      expect(transportCalls).toBe(0);
    } finally {
      await app.close();
      production.close();
      paper.close();
    }
  });

  it('serves an exact eligible Nansen judgment only as advisory evidence with authority NONE', () => {
    const current = snapshots('nansen');
    const record = observedRecord(current);
    const handoff = resolveD2SemanticHandoff({ records: [record], snapshots: current, evidenceFreshness: 'fresh', now: NOW });
    expect(handoff).toMatchObject({ status: 'OBSERVED', source: 'nansen', authority: 'NONE', requestedModel: 'jev-latest',
      resolvedModel: 'jev-1.13.0', questionVersion: G1D_QUESTION_VERSION, advisoryRoute: 'WATCH', answer: 0.63 });
  });

  it('stores the linked observed handoff on the actual deterministic D2 proposal', () => {
    const current = snapshots('nansen');
    observedRecord(current);
    const shadowStore = stores[0]!;
    const audit = initializeD2AuditStore({ databasePath: join(root, 'd2.sqlite') });
    const production = createD2ProductionService({
      observations: { getLatestSnapshots: () => current }, audit, g1dAuditStore: shadowStore,
      g1dAnalysisHandoffEnabled: true, clock: () => NOW,
    });
    const proposal = production.createProposal({
      walletAddress: '0x1111111111111111111111111111111111111111', requestedUsdcMicros: '4000000',
    });
    expect(proposal.analysis).toMatchObject({ semanticStatus: 'UNAVAILABLE', semanticAuthority: 'NONE',
      semanticHandoff: { status: 'UNAVAILABLE', reason: 'NO_MATCHING_JUDGMENT' } });
    expect(proposal.evidence.observationIds).toHaveLength(3);
    production.close();
  });
  it('fails closed when the handoff is disabled or evidence is stale, missing, or mismatched', () => {
    const current = snapshots('nansen');
    const record = observedRecord(current);
    expect(readD2SemanticHandoff({ enabled: false, snapshots: current, evidenceFreshness: 'fresh', now: NOW }))
      .toMatchObject({ status: 'UNAVAILABLE', reason: 'HANDOFF_DISABLED' });
    expect(resolveD2SemanticHandoff({ records: [record], snapshots: current, evidenceFreshness: 'stale', now: NOW }))
      .toMatchObject({ status: 'UNAVAILABLE', reason: 'EVIDENCE_STALE' });
    const changed = current.map((snapshot, index) => index === 0
      ? { ...snapshot, signals: snapshot.signals.map((signal, signalIndex) => signalIndex === 0
        ? { ...signal, provenanceId: signal.provenanceId + '-changed' } : signal) }
      : snapshot);
    expect(resolveD2SemanticHandoff({ records: [record], snapshots: changed, evidenceFreshness: 'fresh', now: NOW }))
      .toMatchObject({ status: 'UNAVAILABLE', reason: 'NO_MATCHING_JUDGMENT' });
    expect(resolveD2SemanticHandoff({ records: [], snapshots: current, evidenceFreshness: 'fresh', now: NOW }))
      .toMatchObject({ status: 'UNAVAILABLE', reason: 'NO_MATCHING_JUDGMENT' });
    const store = stores[0]!;
    expect(readD2SemanticHandoff({ enabled: true, auditStore: store, snapshots: current, evidenceFreshness: 'fresh', now: NOW }))
      .toMatchObject({ status: 'OBSERVED', authority: 'NONE' });
  });
});

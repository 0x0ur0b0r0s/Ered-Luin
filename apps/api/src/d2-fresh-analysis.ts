import {
  d2AnalysisInvokeSchema,
  d2AnalysisPreviewSchema,
  type D2AnalysisInvoke,
  type D2AnalysisPreview,
  type D2Proposal,
} from '@ered-luin/contracts';
import {
  buildG1DEvidencePacket,
  createG1DShadowEvaluator,
  createG1DTypeSafeRequest,
  g1dRequestHash,
  G1D_FEATURE_DEFINITIONS,
  G1D_MODEL_ALIAS,
  G1D_QUESTION_VERSION,
  SIGNAL_FRESHNESS_MS,
  type G1DShadowAuditStore,
  type G1DShadowEvaluator,
  type ManagedQueryResult,
  type ObservationSnapshot,
} from '@ered-luin/nansen';
import { findD2SemanticAttempt, resolveD2SemanticHandoff } from './d2-analysis-handoff.js';

const PREVIEW_TTL_MS = 5 * 60_000;
const MAX_PREVIEWS = 8;
type ProposalReader = (proposalId: string) => D2Proposal | null;
type AuditStore = G1DShadowAuditStore;
interface StoredPreview {
  readonly proposalId: string;
  readonly requestHash: string;
  readonly generatedAt: Date;
  readonly snapshots: readonly ObservationSnapshot[];
  readonly results: readonly ManagedQueryResult[];
}
export interface D2FreshAnalysisService {
  preview(proposalId: string): D2AnalysisPreview;
  invoke(input: { readonly proposalId: string; readonly requestHash: string }): Promise<D2AnalysisInvoke>;
}
export interface D2FreshAnalysisServiceOptions {
  readonly observations: { getLatestSnapshots(source: 'nansen' | 'synthetic'): readonly ObservationSnapshot[] };
  readonly proposal: ProposalReader;
  readonly auditStore?: AuditStore;
  readonly proposalAssociationStore?: { associateSemanticAttempt(input: { readonly proposalId: string; readonly attemptId: string; readonly requestHash: string; readonly createdAt: string }): unknown };
  readonly analysisEnabled?: boolean;
  readonly apiKeyProvider?: () => string | undefined;
  readonly evaluator?: G1DShadowEvaluator;
  readonly clock?: () => Date;
}
function checkedNow(clock: () => Date): Date {
  const now = clock();
  if (!(now instanceof Date) || !Number.isSafeInteger(now.getTime()) || now.getTime() < 0) throw new Error('ANALYSIS_CLOCK_UNAVAILABLE');
  return now;
}
function relevantSignal(signal: ObservationSnapshot['signals'][number]): boolean {
  return G1D_FEATURE_DEFINITIONS.some((definition) => definition.endpoint === signal.endpoint && definition.asset === signal.asset && definition.metric === signal.metric);
}
function signalAge(snapshot: ObservationSnapshot, nowMs: number): number | null {
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  if (!Number.isSafeInteger(fetchedAt) || fetchedAt < 0 || fetchedAt > nowMs) return null;
  return nowMs - fetchedAt;
}
function snapshotStatus(snapshot: ObservationSnapshot, nowMs: number): ManagedQueryResult['status'] {
  if (snapshot.failure !== null) return 'failed';
  if (snapshot.completeness !== 'complete') return 'incomplete';
  const age = signalAge(snapshot, nowMs);
  const expires = Date.parse(snapshot.expiresAt);
  if (age === null || !Number.isSafeInteger(expires) || expires <= nowMs || age > SIGNAL_FRESHNESS_MS[snapshot.operation]) return 'stale';
  return 'cached';
}
function qualityOf(snapshot: ObservationSnapshot, status: ManagedQueryResult['status']): ManagedQueryResult['quality'] {
  if (status === 'stale' || status === 'incomplete' || status === 'failed' || status === 'disabled') {
    return snapshot.signals.some((signal) => signal.quality !== 'MISSING') ? 'PARTIAL' : 'MISSING';
  }
  if (snapshot.signals.length === 0 || snapshot.signals.every((signal) => signal.quality === 'MISSING')) return 'MISSING';
  return snapshot.signals.some((signal) => signal.quality !== 'COMPLETE') ? 'PARTIAL' : 'COMPLETE';
}
function toManagedResults(snapshots: readonly ObservationSnapshot[], now: Date): readonly ManagedQueryResult[] {
  return Object.freeze(snapshots.map((snapshot) => {
    const status = snapshotStatus(snapshot, now.getTime());
    return Object.freeze({
      cacheKey: snapshot.cacheKey, operation: snapshot.operation, asset: snapshot.asset, timeframe: snapshot.timeframe,
      pageBound: snapshot.pageBound, retryBound: snapshot.retryBound, status, source: snapshot.source,
      fetchedAt: snapshot.fetchedAt, acquiredAt: snapshot.acquiredAt, ageMs: signalAge(snapshot, now.getTime()),
      completeness: status === 'stale' ? 'incomplete' as const : snapshot.completeness, quality: qualityOf(snapshot, status),
      observations: snapshot.signals, failure: snapshot.failure, storeError: null, managerError: null,
      pageReferences: snapshot.pageReferences, attemptPageReferences: Object.freeze([]), cacheHit: true, coalesced: false,
      qualifyingSuccessfulRequests: snapshot.pageReferences.filter((page) => page.received).length,
    });
  }));
}
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}
function proposalMatches(proposal: D2Proposal | null, snapshots: readonly ObservationSnapshot[]): 'MATCHED' | 'MISMATCHED' | 'MISSING' {
  if (proposal === null) return 'MISSING';
  if (proposal.evidence.source !== 'nansen' || proposal.evidence.batches.some((batch) => batch.source !== 'nansen') ||
      !sameIds(proposal.evidence.batches.map((batch) => batch.snapshotId), snapshots.map((snapshot) => snapshot.snapshotId))) return 'MISMATCHED';
  const required = [
    proposal.evidence.observations.find((signal) => (signal.endpoint === 'TOKEN_OHLCV' || signal.endpoint === 'TOKEN_SCREENER') && signal.asset === 'USDC' && signal.metric === 'price_usd'),
    proposal.evidence.observations.find((signal) => signal.endpoint === 'TOKEN_SCREENER' && signal.asset === 'WETH' && signal.metric === 'price_usd'),
    proposal.evidence.observations.find((signal) => signal.endpoint === 'SMART_MONEY_NETFLOW' && signal.asset === 'WETH' && signal.metric === 'net_flow_1h_usd'),
  ];
  if (required.some((signal) => !signal || signal.quality !== 'COMPLETE' || signal.value === null)) return 'MISMATCHED';
  if (proposal.evidence.batches.some((batch) => batch.status !== 'fresh' || batch.completeness !== 'complete')) return 'MISMATCHED';
  return 'MATCHED';
}
function uniqueReasons(values: readonly D2AnalysisPreview['missingPrerequisites'][number][]): D2AnalysisPreview['missingPrerequisites'] {
  return [...new Set(values)];
}
function snapshotIds(snapshots: readonly ObservationSnapshot[]): readonly string[] {
  return snapshots.map((snapshot) => snapshot.snapshotId).sort();
}
function response(input: D2AnalysisInvoke): D2AnalysisInvoke { return d2AnalysisInvokeSchema.parse(input); }

export function createD2FreshAnalysisService(options: D2FreshAnalysisServiceOptions): D2FreshAnalysisService {
  const clock = options.clock ?? (() => new Date());
  const analysisEnabled = options.analysisEnabled ?? false;
  const previews = new Map<string, StoredPreview>();

  function currentSnapshots(): readonly ObservationSnapshot[] {
    return options.observations.getLatestSnapshots('nansen');
  }
  function inspect(proposalId: string, now: Date, snapshots: readonly ObservationSnapshot[], retain: boolean): D2AnalysisPreview {
    const results = toManagedResults(snapshots, now);
    const evidence = buildG1DEvidencePacket(results, { now });
    const request = createG1DTypeSafeRequest(evidence);
    const requestHash = g1dRequestHash(request);
    const proposal = options.proposal(proposalId);
    const match = proposalMatches(proposal, snapshots);
    const missing: D2AnalysisPreview['missingPrerequisites'][number][] = [];
    if (snapshots.length === 0) missing.push('NO_OBSERVATIONS');
    if (evidence.source === 'synthetic' || evidence.source === 'mixed' || snapshots.some((snapshot) => snapshot.source !== 'nansen')) missing.push('SYNTHETIC_EVIDENCE');
    if (snapshots.some((snapshot) => snapshot.completeness !== 'complete' || snapshot.failure !== null)) missing.push('INCOMPLETE_EVIDENCE');
    if (snapshots.some((snapshot) => snapshotStatus(snapshot, now.getTime()) === 'stale')) missing.push('STALE_EVIDENCE');
    if (evidence.eligibility !== 'ELIGIBLE') missing.push('MISSING_REQUIRED_OPERATION');
    if (match === 'MISSING') missing.push('PROPOSAL_NOT_FOUND');
    if (match === 'MISMATCHED') missing.push('PROPOSAL_EVIDENCE_MISMATCH');
    if (!analysisEnabled) missing.push('ANALYSIS_DISABLED');
    if (analysisEnabled && (options.auditStore === undefined || options.proposalAssociationStore === undefined)) missing.push('AUDIT_UNAVAILABLE');
    const credentialProviderConfigured = analysisEnabled && options.apiKeyProvider !== undefined;
    if (analysisEnabled && !credentialProviderConfigured) missing.push('MISSING_CREDENTIAL');
    const dataReady = !missing.some((reason) => !['ANALYSIS_DISABLED', 'AUDIT_UNAVAILABLE', 'MISSING_CREDENTIAL'].includes(reason));
    const canInvoke = dataReady && analysisEnabled && credentialProviderConfigured && options.auditStore !== undefined && options.proposalAssociationStore !== undefined;
    const preview = d2AnalysisPreviewSchema.parse({
      proposalId, status: dataReady ? 'READY' : 'UNAVAILABLE', source: evidence.source, eligibility: evidence.eligibility,
      authority: 'NONE', requestedModel: G1D_MODEL_ALIAS, questionVersion: G1D_QUESTION_VERSION,
      generatedAt: evidence.generatedAt, requestHash, proposalMatch: match, invocationEnabled: analysisEnabled,
      credentialProviderConfigured, canInvoke, requestsMade: 0, missingPrerequisites: uniqueReasons(missing),
      inputs: snapshots.map((snapshot) => ({
        snapshotId: snapshot.snapshotId, operation: snapshot.operation, source: snapshot.source,
        status: snapshotStatus(snapshot, now.getTime()), completeness: snapshot.completeness, fetchedAt: snapshot.fetchedAt,
        ageMs: signalAge(snapshot, now.getTime()), signalIds: snapshot.signals.filter(relevantSignal).map((signal) => signal.signalId),
      })),
      features: evidence.features.map((feature) => ({
        endpoint: feature.endpoint, asset: feature.asset, metric: feature.metric, state: feature.state,
        quality: feature.quality, flags: [...feature.flags], signalIds: feature.signalReferences.map((ref) => ref.signalId),
      })),
    });
    if (retain && dataReady) {
      for (const [key, stored] of previews) if (stored.proposalId === proposalId) previews.delete(key);
      previews.set(requestHash, { proposalId, requestHash, generatedAt: now, snapshots: [...snapshots], results });
      while (previews.size > MAX_PREVIEWS) previews.delete(previews.keys().next().value as string);
    }
    return preview;
  }

  return Object.freeze({
    preview(proposalId: string) {
      const now = checkedNow(clock);
      return inspect(proposalId, now, currentSnapshots(), true);
    },
    async invoke(input: { readonly proposalId: string; readonly requestHash: string }) {
      const now = checkedNow(clock);
      if (!analysisEnabled) return response({
        proposalId: input.proposalId, status: 'DISABLED', authority: 'NONE', requestsMade: 0,
        approvedRequestHash: input.requestHash, recordRequestHash: null, attemptId: null, requestedModel: G1D_MODEL_ALIAS,
        resolvedModel: null, answer: null, advisoryRoute: null, reason: 'ANALYSIS_DISABLED',
      });
      if (!options.auditStore) return response({
        proposalId: input.proposalId, status: 'BLOCKED', authority: 'NONE', requestsMade: 0,
        approvedRequestHash: input.requestHash, recordRequestHash: null, attemptId: null, requestedModel: G1D_MODEL_ALIAS,
        resolvedModel: null, answer: null, advisoryRoute: null, reason: 'AUDIT_UNAVAILABLE',
      });
      const approved = previews.get(input.requestHash);
      if (!approved || approved.proposalId !== input.proposalId) return response({
        proposalId: input.proposalId, status: 'BLOCKED', authority: 'NONE', requestsMade: 0,
        approvedRequestHash: input.requestHash, recordRequestHash: null, attemptId: null, requestedModel: G1D_MODEL_ALIAS,
        resolvedModel: null, answer: null, advisoryRoute: null, reason: 'REVIEW_EXPIRED',
      });
      previews.delete(input.requestHash);
      if (now.getTime() < approved.generatedAt.getTime() || now.getTime() - approved.generatedAt.getTime() > PREVIEW_TTL_MS) return response({
        proposalId: input.proposalId, status: 'BLOCKED', authority: 'NONE', requestsMade: 0,
        approvedRequestHash: input.requestHash, recordRequestHash: null, attemptId: null, requestedModel: G1D_MODEL_ALIAS,
        resolvedModel: null, answer: null, advisoryRoute: null, reason: 'REVIEW_EXPIRED',
      });
      let snapshots: readonly ObservationSnapshot[];
      try { snapshots = currentSnapshots(); }
      catch {
        return response({ proposalId: input.proposalId, status: 'BLOCKED', authority: 'NONE', requestsMade: 0,
          approvedRequestHash: input.requestHash, recordRequestHash: null, attemptId: null, requestedModel: G1D_MODEL_ALIAS,
          resolvedModel: null, answer: null, advisoryRoute: null, reason: 'INTERNAL_ERROR' });
      }
      const proposal = options.proposal(input.proposalId);
      const currentPreview = inspect(input.proposalId, now, snapshots, false);
      const reviewedPacket = inspect(input.proposalId, approved.generatedAt, snapshots, false);
      if (!currentPreview.canInvoke || !reviewedPacket.canInvoke || reviewedPacket.requestHash !== approved.requestHash ||
          !sameIds(snapshotIds(approved.snapshots), snapshotIds(snapshots)) || proposalMatches(proposal, snapshots) !== 'MATCHED') {
        const currentDataBlock = currentPreview.missingPrerequisites.find((reason) =>
          !['ANALYSIS_DISABLED', 'AUDIT_UNAVAILABLE', 'MISSING_CREDENTIAL'].includes(reason));
        return response({ proposalId: input.proposalId, status: 'BLOCKED', authority: 'NONE', requestsMade: 0,
          approvedRequestHash: input.requestHash, recordRequestHash: null, attemptId: null, requestedModel: G1D_MODEL_ALIAS,
          resolvedModel: null, answer: null, advisoryRoute: null,
          reason: currentDataBlock ?? (reviewedPacket.proposalMatch === 'MATCHED' ? 'REQUEST_HASH_MISMATCH' : 'PROPOSAL_EVIDENCE_MISMATCH') });
      }
      const recent = options.auditStore.listRecent(100);
      const prior = findD2SemanticAttempt({ records: recent, snapshots, evidenceFreshness: 'fresh', now });
      if (prior?.status === 'PENDING') return response({
        proposalId: input.proposalId, status: 'UNAVAILABLE', authority: 'NONE', requestsMade: 0,
        approvedRequestHash: input.requestHash, recordRequestHash: prior.requestHash, attemptId: prior.attemptId,
        requestedModel: prior.requestedModel, resolvedModel: null, answer: null, advisoryRoute: null, reason: 'AMBIGUOUS_ATTEMPT',
      });
      if (prior?.status === 'OBSERVED') {
        const cached = resolveD2SemanticHandoff({ records: [prior], snapshots, evidenceFreshness: 'fresh', now });
        if (cached.status === 'OBSERVED') {
          options.proposalAssociationStore?.associateSemanticAttempt({ proposalId: input.proposalId, attemptId: prior.attemptId,
            requestHash: prior.requestHash, createdAt: now.toISOString() });
          return response({
          proposalId: input.proposalId, status: 'CACHED', authority: 'NONE', requestsMade: 0,
          approvedRequestHash: input.requestHash, recordRequestHash: cached.requestHash, attemptId: cached.attemptId,
          requestedModel: cached.requestedModel, resolvedModel: cached.resolvedModel, answer: cached.answer,
          advisoryRoute: cached.advisoryRoute, reason: null,
          });
        }
      }
      if (prior !== null) return response({
        proposalId: input.proposalId, status: 'UNAVAILABLE', authority: 'NONE', requestsMade: 0,
        approvedRequestHash: input.requestHash, recordRequestHash: prior.requestHash, attemptId: prior.attemptId,
        requestedModel: prior.requestedModel, resolvedModel: prior.resolvedModel, answer: null, advisoryRoute: null, reason: 'PRIOR_ATTEMPT_EXISTS',
      });
      let apiKey: string | undefined;
      try { apiKey = options.apiKeyProvider?.(); }
      catch { apiKey = undefined; }
      if (!apiKey) return response({
        proposalId: input.proposalId, status: 'BLOCKED', authority: 'NONE', requestsMade: 0,
        approvedRequestHash: input.requestHash, recordRequestHash: null, attemptId: null, requestedModel: G1D_MODEL_ALIAS,
        resolvedModel: null, answer: null, advisoryRoute: null, reason: 'MISSING_CREDENTIAL',
      });
      const evaluator = options.evaluator ?? createG1DShadowEvaluator({
        enabled: analysisEnabled, apiKey, ...(options.auditStore ? { auditStore: options.auditStore } : {}), clock,
      });
      const result = await evaluator.evaluate(approved.results, { now: approved.generatedAt });
      if (result.status === 'OBSERVED' && result.attemptId && result.requestHash) {
        const durable = options.auditStore.getAttempt(result.attemptId);
        const linked = resolveD2SemanticHandoff({ records: durable ? [durable] : [], snapshots,
          evidenceFreshness: 'fresh', now });
        if (!durable || durable.status !== 'OBSERVED' || durable.requestsMade !== 1 ||
            durable.requestHash !== approved.requestHash || linked.status !== 'OBSERVED' ||
            linked.requestHash !== approved.requestHash || options.proposalAssociationStore === undefined) {
          throw new Error('D2_ANALYSIS_ASSOCIATION_UNAVAILABLE');
        }
        options.proposalAssociationStore.associateSemanticAttempt({ proposalId: input.proposalId,
          attemptId: durable.attemptId, requestHash: durable.requestHash, createdAt: now.toISOString() });
      }
      const status = result.status === 'OBSERVED' && result.requestsMade === 0 ? 'CACHED'
        : result.status === 'OBSERVED' ? 'OBSERVED'
          : result.status === 'INVALID_RESPONSE' ? 'INVALID_RESPONSE'
            : result.status === 'DISABLED' ? 'DISABLED' : 'UNAVAILABLE';
      const reason = result.errorCode === 'AMBIGUOUS_ATTEMPT' ? 'AMBIGUOUS_ATTEMPT'
        : result.errorCode === 'PRIOR_ATTEMPT_EXISTS' ? 'PRIOR_ATTEMPT_EXISTS'
          : result.errorCode === 'MISSING_CREDENTIAL' ? 'MISSING_CREDENTIAL'
            : result.errorCode === null ? null : 'INTERNAL_ERROR';
      return response({
        proposalId: input.proposalId, status, authority: 'NONE', requestsMade: result.requestsMade,
        approvedRequestHash: input.requestHash, recordRequestHash: result.requestHash, attemptId: result.attemptId,
        requestedModel: result.requestedModel, resolvedModel: result.resolvedModel,
        answer: result.answer?.noul ?? null, advisoryRoute: result.answer ? result.advisoryRoute : null, reason,
      });
    },
  });
}

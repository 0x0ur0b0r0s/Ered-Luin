import { createHash } from 'node:crypto';
import {
  G1D_FEATURE_DEFINITIONS, G1D_QUESTION_VERSION, G1D_MODEL_ALIAS, g1dQuestionSetHash, g1dRequestHash,
  type G1DShadowAuditRecord, type ObservationSnapshot,
} from '@ered-luin/nansen';
import type { D2SemanticHandoff } from '@ered-luin/contracts';

const UNAVAILABLE = (reason: Extract<D2SemanticHandoff, { status: 'UNAVAILABLE' }>['reason']): D2SemanticHandoff => ({
  status: 'UNAVAILABLE', provider: 'none', authority: 'NONE', source: 'none', reason,
});
const allowedFeatures = new Set(G1D_FEATURE_DEFINITIONS.map((definition) =>
  definition.endpoint + '|' + definition.asset + '|' + definition.metric));
const MAX_G1D_FRESHNESS_MS = 35 * 60_000;

function provenanceHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function reference(signal: ObservationSnapshot['signals'][number]) {
  return {
    signalId: signal.signalId, source: signal.provider, endpoint: signal.endpoint,
    observedAt: signal.observedAt, fetchedAt: signal.fetchedAt, provenanceHash: provenanceHash(signal.provenanceId),
  };
}
function sortReferences<T extends { readonly signalId: string }>(items: readonly T[]): readonly T[] {
  return [...items].sort((a, b) => a.signalId.localeCompare(b.signalId));
}
function currentSnapshotsAreFresh(snapshots: readonly ObservationSnapshot[], nowMs: number): boolean {
  return snapshots.every((snapshot) => {
    if (snapshot.source !== 'nansen' && snapshot.source !== 'synthetic') return false;
    const freshnessBound = snapshot.operation === 'SMART_MONEY_NETFLOW' ? MAX_G1D_FRESHNESS_MS : 10 * 60_000;
    const fetched = Date.parse(snapshot.fetchedAt);
    const acquired = Date.parse(snapshot.acquiredAt);
    const expires = Date.parse(snapshot.expiresAt);
    if (snapshot.failure !== null || snapshot.completeness !== 'complete' || !Number.isSafeInteger(fetched) ||
        !Number.isSafeInteger(acquired) || !Number.isSafeInteger(expires) || fetched > nowMs || acquired > nowMs ||
        expires <= nowMs || nowMs - fetched > freshnessBound) return false;
    return snapshot.signals.filter((signal) => allowedFeatures.has(signal.endpoint + '|' + signal.asset + '|' + signal.metric))
      .every((signal) => {
        const signalFetched = Date.parse(signal.fetchedAt);
        const observed = Date.parse(signal.observedAt);
        return signal.provider === snapshot.source && signal.quality === 'COMPLETE' && signal.value !== null &&
          Number.isSafeInteger(signalFetched) && Number.isSafeInteger(observed) && signalFetched <= nowMs && observed <= nowMs &&
          nowMs - signalFetched <= freshnessBound;
      });
  });
}
function currentReferences(snapshots: readonly ObservationSnapshot[]): readonly ReturnType<typeof reference>[] {
  const refs = [] as ReturnType<typeof reference>[];
  for (const snapshot of snapshots) {
    if (snapshot.source !== 'nansen' && snapshot.source !== 'synthetic') return [];
    for (const signal of snapshot.signals) {
      if (signal.provider !== snapshot.source) return [];
      if (allowedFeatures.has(signal.endpoint + '|' + signal.asset + '|' + signal.metric)) refs.push(reference(signal));
    }
  }
  return sortReferences(refs);
}
function auditReferences(record: G1DShadowAuditRecord): readonly ReturnType<typeof reference>[] | null {
  try {
    if (!Array.isArray(record.request.state.features)) return null;
    return sortReferences(record.request.state.features.flatMap((feature) => feature.signalReferences));
  } catch { return null; }
}
function requestIsBound(record: G1DShadowAuditRecord): boolean {
  try {
    return record.request.model === G1D_MODEL_ALIAS && record.requestHash === g1dRequestHash(record.request) &&
      record.questionSetHash === g1dQuestionSetHash() && record.request.state.questionVersion === G1D_QUESTION_VERSION &&
      record.request.state.featureVersion === 'g1d-features-v1' && record.request.state.schemaVersion === 'g1d-evidence-packet-v1' &&
      record.request.state.routePolicyVersion === 'g1d-advisory-route-v1';
  } catch { return false; }
}
function toObserved(record: G1DShadowAuditRecord, source: 'nansen' | 'synthetic'): D2SemanticHandoff | null {
  if (record.status !== 'OBSERVED' || record.requestsMade !== 1 || record.answer === null || record.resolvedModel === null ||
      record.completedAt === null) return null;
  const base = {
    provider: 'typesafe-shadow' as const, authority: 'NONE' as const, requestedModel: G1D_MODEL_ALIAS,
    resolvedModel: record.resolvedModel, questionVersion: G1D_QUESTION_VERSION, attemptId: record.attemptId,
    requestHash: record.requestHash, answer: record.answer.noul, advisoryRoute: record.advisoryRoute,
    evidenceSignalIds: [...new Set(auditReferences(record)?.map((item) => item.signalId) ?? [])].sort(),
  };
  if (base.evidenceSignalIds.length === 0) return null;
  if (source === 'synthetic') return { status: 'FIXTURE', ...base, source, label: 'SYNTHETIC FIXTURE — NOT MARKET ANALYSIS' };
  if (record.request.state.source !== 'nansen' || record.request.state.eligibility !== 'ELIGIBLE' || record.request.state.issues.length > 0) return null;
  return { status: 'OBSERVED', ...base, source };
}

/** Finds any recent durable attempt for the exact current signal lineage and question contract. */
export function findD2SemanticAttempt(input: {
  readonly records: readonly G1DShadowAuditRecord[];
  readonly snapshots: readonly ObservationSnapshot[];
  readonly evidenceFreshness: 'fresh' | 'stale' | 'incomplete' | 'missing';
  readonly now: Date;
}): G1DShadowAuditRecord | null {
  if (!input || !Array.isArray(input.records) || !Array.isArray(input.snapshots) ||
      !(input.now instanceof Date) || !Number.isSafeInteger(input.now.getTime()) || input.now.getTime() < 0 ||
      input.evidenceFreshness !== 'fresh') return null;
  const nowMs = input.now.getTime();
  if (!currentSnapshotsAreFresh(input.snapshots, nowMs)) return null;
  const expected = currentReferences(input.snapshots);
  if (expected.length === 0) return null;
  return input.records.find((record) => {
    if (!requestIsBound(record)) return false;
    const created = Date.parse(record.createdAt);
    const generated = Date.parse(record.request.state.generatedAt);
    if (!Number.isSafeInteger(created) || !Number.isSafeInteger(generated) || created > nowMs || generated > nowMs ||
        nowMs - created > MAX_G1D_FRESHNESS_MS || nowMs - generated > MAX_G1D_FRESHNESS_MS) return false;
    const actual = auditReferences(record);
    return actual !== null && JSON.stringify(actual) === JSON.stringify(expected);
  }) ?? null;
}

/** Link only an already stored G1d result whose versioned request and signal provenance match the proposal's current snapshots. */
export function resolveD2SemanticHandoff(input: {
  readonly records: readonly G1DShadowAuditRecord[];
  readonly snapshots: readonly ObservationSnapshot[];
  readonly evidenceFreshness: 'fresh' | 'stale' | 'incomplete' | 'missing';
  readonly now: Date;
}): D2SemanticHandoff {
  if (!input || !Array.isArray(input.records) || !Array.isArray(input.snapshots) ||
      !(input.now instanceof Date) || !Number.isSafeInteger(input.now.getTime()) || input.now.getTime() < 0) {
    return UNAVAILABLE('AUDIT_UNAVAILABLE');
  }
  if (input.evidenceFreshness !== 'fresh') return UNAVAILABLE('EVIDENCE_STALE');
  const nowMs = input.now.getTime();
  if (!currentSnapshotsAreFresh(input.snapshots, nowMs)) return UNAVAILABLE('EVIDENCE_STALE');
  const matching = findD2SemanticAttempt(input);
  if (!matching) return UNAVAILABLE('NO_MATCHING_JUDGMENT');
  if (matching.request.state.source === 'synthetic') {
    return toObserved(matching, 'synthetic') ?? UNAVAILABLE('NO_OBSERVED_JUDGMENT');
  }
  if (matching.request.state.source !== 'nansen') return UNAVAILABLE('NO_OBSERVED_JUDGMENT');
  return toObserved(matching, 'nansen') ?? UNAVAILABLE('NO_OBSERVED_JUDGMENT');
}

export function readD2SemanticHandoff(input: {
  readonly enabled: boolean;
  readonly auditStore?: { listRecent(limit?: number): readonly G1DShadowAuditRecord[] };
  readonly snapshots: readonly ObservationSnapshot[];
  readonly evidenceFreshness: 'fresh' | 'stale' | 'incomplete' | 'missing';
  readonly now: Date;
}): D2SemanticHandoff {
  if (!input.enabled || !input.auditStore) return UNAVAILABLE('HANDOFF_DISABLED');
  try {
    return resolveD2SemanticHandoff({ records: input.auditStore.listRecent(50), snapshots: input.snapshots,
      evidenceFreshness: input.evidenceFreshness, now: input.now });
  } catch { return UNAVAILABLE('AUDIT_UNAVAILABLE'); }
}
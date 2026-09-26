import { createHash, randomUUID } from 'node:crypto';
import { normalizedSignalSchema } from '@ered-luin/contracts';
import {
  G1D_FEATURE_DEFINITIONS,
  G1D_MODEL_ALIAS,
  G1D_QUESTIONS,
  G1D_QUESTION_ID,
  G1D_QUESTION_VERSION,
  G1D_ROUTE_POLICY,
  type G1DAdvisoryRoute,

  type G1DEvidencePacket,
  type G1DFeatureFlag,
  type G1DFeatureState,
  type G1DInputIssue,
  type G1DMetricDefinition,
  type G1DMetricFeature,
  type G1DQuestionAnswer,
  type G1DShadowErrorCode,
  type G1DShadowAuditRecord,
  type G1DShadowResult,
  type G1DSource,
  type G1DTypeSafeRequest,
  type G1DUsage,
} from './typesafe-shadow-contracts.js';
import { SIGNAL_FRESHNESS_MS, type ManagedQueryResult } from './query-manager.js';
import type { G1DShadowAuditStore } from './typesafe-shadow-store.js';

const TYPE_SAFE_URL = 'https://api.typesafe.ai/v1/systemone';
const MAX_REQUEST_BYTES = 24 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 15_000;
const MAX_TOKEN_COUNT = 1_000_000;
const MAX_AUDIT_REUSE_AGE_MS = 35 * 60_000;
const OPERATIONS = ['TOKEN_SCREENER', 'FLOW_INTELLIGENCE', 'SMART_MONEY_NETFLOW'] as const;
const STATUSES = ['fresh', 'cached', 'stale', 'incomplete', 'failed', 'disabled'] as const;
const SOURCES = ['nansen', 'synthetic'] as const;
const COMPLETENESS = ['complete', 'incomplete', 'unknown'] as const;
const QUALITY = ['COMPLETE', 'PARTIAL', 'MISSING'] as const;
const HASH = /^[0-9a-f]{64}$/u;
const MODEL = /^jev-(?:latest|[0-9]+\.[0-9]+\.[0-9]+)$/u;

type Operation = (typeof OPERATIONS)[number];
type Definition = G1DMetricDefinition;
type ResultRecord = ManagedQueryResult & { readonly operation: Operation };
type FeatureEntry = {
  signal: ReturnType<typeof normalizedSignalSchema.parse>;
  result: ResultRecord;
  ageMs: number | null;
  stale: boolean;
};
export interface G1DMapOptions { readonly now?: Date; }

export interface G1DTypeSafeHttpRequest {
  readonly url: typeof TYPE_SAFE_URL;
  readonly method: 'POST';
  readonly headers: Readonly<{ Authorization: string; 'Content-Type': 'application/json' }>;
  readonly body: string;
  readonly signal: AbortSignal;
}
export interface G1DTypeSafeHttpResponse {
  readonly status: number;
  readonly body: Uint8Array;
}
export type G1DTypeSafeTransport = (request: G1DTypeSafeHttpRequest) => Promise<G1DTypeSafeHttpResponse>;
export interface G1DShadowEvaluatorOptions {
  readonly enabled?: boolean;
  readonly apiKey?: string;
  readonly auditStore?: G1DShadowAuditStore;
  readonly transport?: G1DTypeSafeTransport;
  readonly clock?: () => Date;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}
export interface G1DShadowEvaluator {
  evaluate(results: readonly ManagedQueryResult[], mapOptions?: G1DMapOptions): Promise<G1DShadowResult>;
}
export class G1DTypeSafeResponseTooLargeError extends Error {}
class G1DTypeSafeTimeoutError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}
function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite JSON number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  throw new TypeError('Unsupported JSON value');
}
function safeIso(value: unknown): { iso: string; ms: number } | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  if (!Number.isSafeInteger(ms) || ms < 0) return null;
  return { iso: new Date(ms).toISOString(), ms };
}
function definitionFor(endpoint: unknown, asset: unknown, metric: unknown): Definition | undefined {
  return G1D_FEATURE_DEFINITIONS.find((definition) =>
    definition.endpoint === endpoint && definition.asset === asset && definition.metric === metric);
}
function definitionForAssetMetric(asset: unknown, metric: unknown): Definition | undefined {
  return G1D_FEATURE_DEFINITIONS.find((definition) => definition.asset === asset && definition.metric === metric);
}
function addIssue(issues: Set<G1DInputIssue>, issue: G1DInputIssue): void { issues.add(issue); }
function summarizeResult(result: ResultRecord): G1DEvidencePacket['inputs'][number] {
  const fetchedAt = safeIso(result.fetchedAt)?.iso ?? null;
  const acquiredAt = safeIso(result.acquiredAt)?.iso ?? null;
  const cacheKey = HASH.test(result.cacheKey) ? result.cacheKey : null;
  return {
    operation: result.operation,
    status: result.status,
    source: result.source,
    completeness: result.completeness,
    cacheKey,
    fetchedAt,
    acquiredAt,
    ageMs: Number.isSafeInteger(result.ageMs) && result.ageMs !== null && result.ageMs >= 0 ? result.ageMs : null,
  };
}
function validResult(value: unknown): value is ResultRecord {
  if (!isRecord(value) || !OPERATIONS.includes(value.operation as Operation) ||
      !STATUSES.includes(value.status as ResultRecord['status']) ||
      !SOURCES.includes(value.source as ResultRecord['source']) ||
      !COMPLETENESS.includes(value.completeness as ResultRecord['completeness']) ||
      !QUALITY.includes(value.quality as ResultRecord['quality']) ||
      (value.operation === 'FLOW_INTELLIGENCE' ? value.asset !== 'WETH' : value.asset !== 'BASE_PAIR') ||
      value.timeframe !== '1h' ||
      !Number.isSafeInteger(value.pageBound) || Number(value.pageBound) < 1 || Number(value.pageBound) > 20 ||
      !Number.isSafeInteger(value.retryBound) || Number(value.retryBound) < 0 || Number(value.retryBound) > 2 ||
      typeof value.cacheKey !== 'string' || !Array.isArray(value.observations) || value.observations.length > G1D_FEATURE_DEFINITIONS.length ||
      !Array.isArray(value.pageReferences) || value.pageReferences.length > 60 || typeof value.cacheHit !== 'boolean' ||
      typeof value.coalesced !== 'boolean' || !Number.isSafeInteger(value.qualifyingSuccessfulRequests) ||
      Number(value.qualifyingSuccessfulRequests) < 0) return false;
  if (value.ageMs !== null && (!Number.isSafeInteger(value.ageMs) || Number(value.ageMs) < 0)) return false;
  if (value.fetchedAt !== null && safeIso(value.fetchedAt) === null) return false;
  if (value.acquiredAt !== null && safeIso(value.acquiredAt) === null) return false;
  return true;
}
function emptyFeature(
  definition: Definition,
  associated: readonly ResultRecord[],
  invalid: boolean,
  duplicateOperation: boolean,
): G1DMetricFeature {
  const flags = new Set<G1DFeatureFlag>();
  const sources = new Set(associated.map((result) => result.source));
  if (invalid) flags.add('INVALID');
  if (duplicateOperation) flags.add('DUPLICATE');
  if (associated.some((result) => result.status === 'stale')) flags.add('STALE');
  if (sources.has('synthetic')) flags.add('SYNTHETIC');
  if (associated.some((result) => result.completeness !== 'complete' || result.status === 'incomplete' || result.status === 'failed' || result.status === 'disabled')) flags.add('PARTIAL');
  flags.add('MISSING');
  let state: G1DFeatureState = 'MISSING';
  if (flags.has('INVALID')) state = 'INVALID';
  else if (flags.has('STALE')) state = 'STALE';
  else if (flags.has('MISSING')) state = 'MISSING';
  else if (flags.has('SYNTHETIC')) state = 'SYNTHETIC';
  const completeness = associated.length === 0 ? 'none'
    : associated.every((result) => result.completeness === 'complete') ? 'complete'
      : associated.every((result) => result.completeness === 'unknown') ? 'unknown' : 'incomplete';
  const source = sources.size > 1 ? 'mixed' : sources.values().next().value ?? 'none';
  return {
    endpoint: definition.endpoint, asset: definition.asset, metric: definition.metric, unit: 'usd_micros',
    state, flags: Object.freeze([...flags]), quality: 'MISSING', source, completeness, valueMicros: null,
    candidateValuesMicros: Object.freeze([]), fetchedAt: null,
    acquiredAt: associated.length === 1 ? safeIso(associated[0]?.acquiredAt)?.iso ?? null : null,
    observedAt: null,
    ageMs: associated.length === 1 ? associated[0]?.ageMs ?? null : null,
    signalReferences: Object.freeze([]),
  };
}
function canonicalMicros(value: string): string {
  try { return BigInt(value).toString(); }
  catch { return value; }
}
function featureFor(
  definition: Definition,
  entries: readonly FeatureEntry[],
  associated: readonly ResultRecord[],
  invalid: boolean,
  duplicateOperation: boolean,
): G1DMetricFeature {
  if (entries.length === 0) return emptyFeature(definition, associated, invalid, duplicateOperation);
  const flags = new Set<G1DFeatureFlag>();
  if (invalid) flags.add('INVALID');
  if (duplicateOperation || entries.length > 1) flags.add('DUPLICATE');
  if (entries.some((entry) => entry.stale) || associated.some((result) => result.status === 'stale')) flags.add('STALE');
  if (entries.some((entry) => entry.signal.provider === 'synthetic') || associated.some((result) => result.source === 'synthetic')) flags.add('SYNTHETIC');
  if (entries.some((entry) => entry.signal.quality === 'PARTIAL') ||
      associated.some((result) => result.completeness !== 'complete' || result.status === 'incomplete' || result.status === 'failed' || result.status === 'disabled')) flags.add('PARTIAL');
  if (entries.some((entry) => entry.signal.quality === 'MISSING')) flags.add('MISSING');

  const values = [...new Set(entries.filter((entry) => entry.signal.quality === 'COMPLETE' && entry.signal.value !== null)
    .map((entry) => canonicalMicros(entry.signal.value!)))].sort();
  if (values.length > 1) flags.add('CONTRADICTORY');
  const complete = entries.some((entry) => entry.signal.quality === 'COMPLETE' && entry.signal.value !== null);
  const missingOnly = !complete && entries.every((entry) => entry.signal.quality === 'MISSING');
  const partial = !missingOnly && (!complete || entries.some((entry) => entry.signal.quality !== 'COMPLETE') ||
    associated.some((result) => result.completeness !== 'complete' || (result.status !== 'fresh' && result.status !== 'cached')));
  let state: G1DFeatureState;
  if (flags.has('CONTRADICTORY')) state = 'CONTRADICTORY';
  else if (flags.has('INVALID')) state = 'INVALID';
  else if (flags.has('STALE')) state = 'STALE';
  else if (missingOnly) state = 'MISSING';
  else if (flags.has('SYNTHETIC')) state = 'SYNTHETIC';
  else if (partial || flags.has('PARTIAL') || flags.has('MISSING') || flags.has('DUPLICATE')) state = 'PARTIAL';
  else state = values[0] === '0' ? 'ZERO' : 'COMPLETE';

  const sources = new Set(entries.map((entry) => entry.signal.provider));
  const source = sources.size > 1 ? 'mixed' : sources.values().next().value ?? 'none';
  const completeness = associated.length === 0 ? 'none'
    : associated.every((result) => result.completeness === 'complete') ? 'complete'
      : associated.every((result) => result.completeness === 'unknown') ? 'unknown' : 'incomplete';
  const byTime = (a: string, b: string): number => (Date.parse(a) - Date.parse(b));
  const refs = entries.map((entry) => ({
    signalId: entry.signal.signalId, source: entry.signal.provider, endpoint: entry.signal.endpoint,
    observedAt: entry.signal.observedAt, fetchedAt: entry.signal.fetchedAt,
    provenanceHash: hash(entry.signal.provenanceId),
  })).sort((a, b) => a.signalId.localeCompare(b.signalId));
  const fetchedAtValues = entries.map((entry) => entry.signal.fetchedAt).sort(byTime);
  const observedAtValues = entries.map((entry) => entry.signal.observedAt).sort(byTime);
  const acquiredAtValues = associated.map((result) => result.acquiredAt).filter((v): v is string => v !== null).sort((a, b) => Date.parse(a) - Date.parse(b));
  const ages = entries.map((entry) => entry.ageMs).filter((age): age is number => age !== null);
  if (associated.some((result) => result.status === 'stale')) flags.add('STALE');
  return {
    endpoint: definition.endpoint, asset: definition.asset, metric: definition.metric, unit: 'usd_micros',
    state, flags: Object.freeze([...flags]), quality: missingOnly ? 'MISSING' : complete && !partial && !flags.has('STALE') ? 'COMPLETE' : 'PARTIAL',
    source, completeness, valueMicros: values.length === 1 && !flags.has('STALE') ? values[0]! : null,
    candidateValuesMicros: Object.freeze(flags.has('STALE') ? [] : values), fetchedAt: fetchedAtValues[fetchedAtValues.length - 1] ?? null,
    acquiredAt: acquiredAtValues[acquiredAtValues.length - 1] ?? null,
    observedAt: observedAtValues[observedAtValues.length - 1] ?? null,
    ageMs: ages.length === 0 ? null : Math.max(...ages), signalReferences: Object.freeze(refs),
  };
}

export function buildG1DEvidencePacket(
  results: readonly ManagedQueryResult[],
  options: G1DMapOptions = {},
): G1DEvidencePacket {
  const rawNowMs = options.now?.getTime() ?? Date.now();
  const validNow = Number.isSafeInteger(rawNowMs) && rawNowMs >= 0;
  const nowMs = validNow ? rawNowMs : 0;
  const issues = new Set<G1DInputIssue>();
  const validResults: ResultRecord[] = [];
  const invalidOperations = new Set<Operation>();
  const sources = new Set<'nansen' | 'synthetic'>();
  if (!validNow || !Array.isArray(results) || results.length > 12) {
    addIssue(issues, 'INVALID_RESULT');
  } else {
    for (const raw of results as readonly unknown[]) {
      const possibleOperation = isRecord(raw) && OPERATIONS.includes(raw.operation as Operation) ? raw.operation as Operation : null;
      if (!validResult(raw)) {
        addIssue(issues, 'INVALID_RESULT');
        if (possibleOperation !== null) invalidOperations.add(possibleOperation);
        continue;
      }
      if (!HASH.test(raw.cacheKey) || !Array.isArray(raw.observations)) {
        addIssue(issues, 'INVALID_RESULT');
        invalidOperations.add(raw.operation);
        continue;
      }
      const fetchedAt = safeIso(raw.fetchedAt);
      const acquiredAt = safeIso(raw.acquiredAt);
      if ((raw.fetchedAt !== null && fetchedAt === null) || (raw.acquiredAt !== null && acquiredAt === null) ||
          (raw.status === 'fresh' && (!fetchedAt || !acquiredAt))) {
        addIssue(issues, 'INVALID_RESULT');
        invalidOperations.add(raw.operation);
        continue;
      }
      validResults.push(raw);
      sources.add(raw.source);

    }
  }

  const resultCounts = new Map<Operation, number>();
  for (const result of validResults) resultCounts.set(result.operation, (resultCounts.get(result.operation) ?? 0) + 1);
  for (const count of resultCounts.values()) {
    if (count > 1) {
      addIssue(issues, 'DUPLICATE_OPERATION');
    }
  }

  const entries = new Map<string, FeatureEntry[]>();
  const invalidKeys = new Set<string>();
  for (const result of validResults) {
    for (const rawSignal of result.observations as readonly unknown[]) {
      const rawDefinition = isRecord(rawSignal) ? definitionForAssetMetric(rawSignal.asset, rawSignal.metric) : undefined;
      const rawKey = rawDefinition ? rawDefinition.endpoint + '|' + rawDefinition.asset + '|' + rawDefinition.metric : null;
      const parsed = normalizedSignalSchema.safeParse(rawSignal);
      if (!parsed.success) {
        addIssue(issues, 'INVALID_SIGNAL');
        if (rawKey !== null) invalidKeys.add(rawKey);
        continue;
      }
      const signal = parsed.data;
      const definition = definitionFor(signal.endpoint, signal.asset, signal.metric);
      if (definition === undefined) {
        const assetMetricDefinition = definitionForAssetMetric(signal.asset, signal.metric);
        if (assetMetricDefinition !== undefined) {
          addIssue(issues, 'ENDPOINT_MISMATCH');
          invalidKeys.add(assetMetricDefinition.endpoint + '|' + assetMetricDefinition.asset + '|' + assetMetricDefinition.metric);
        } else addIssue(issues, 'UNSUPPORTED_SIGNAL');
        continue;
      }
      const key = definition.endpoint + '|' + definition.asset + '|' + definition.metric;
      if (signal.unit !== definition.unit) {
        addIssue(issues, 'INVALID_SIGNAL');
        invalidKeys.add(key);
        continue;
      }
      if (signal.endpoint !== result.operation) {
        addIssue(issues, 'ENDPOINT_MISMATCH');
        invalidKeys.add(key);
        continue;
      }
      if (signal.provider !== result.source) {
        addIssue(issues, 'SOURCE_MISMATCH');
        invalidKeys.add(key);
        continue;
      }
      const resultFetched = safeIso(result.fetchedAt);
      const resultAcquired = safeIso(result.acquiredAt);
      const signalFetched = safeIso(signal.fetchedAt);
      const signalObserved = safeIso(signal.observedAt);
      if (resultFetched === null || resultAcquired === null || signalFetched === null || signalObserved === null ||
          resultFetched.ms !== signalFetched.ms || resultAcquired.ms !== signalObserved.ms) {
        addIssue(issues, 'TIMESTAMP_MISMATCH');
        invalidKeys.add(key);
        continue;
      }
      const timestampAgeMs = nowMs - signalObserved.ms;
      const ageMs = timestampAgeMs < 0 ? null : Math.max(timestampAgeMs, result.ageMs ?? 0);
      const stale = timestampAgeMs < 0 || (ageMs ?? 0) > SIGNAL_FRESHNESS_MS[result.operation] || result.status === 'stale';
      const list = entries.get(key) ?? [];
      list.push({ signal, result, ageMs, stale });
      entries.set(key, list);
    }
  }
  const inputSummaries = validResults.map(summarizeResult).sort((a, b) => a.operation.localeCompare(b.operation) || String(a.cacheKey).localeCompare(String(b.cacheKey)));
  const features = G1D_FEATURE_DEFINITIONS.map((definition) => {
    const key = definition.endpoint + '|' + definition.asset + '|' + definition.metric;
    const associated = validResults.filter((result) => result.operation === definition.endpoint);
    const invalid = invalidOperations.has(definition.endpoint) || invalidKeys.has(key) ||
      [...issues].some((issue) => issue === 'INVALID_RESULT' && invalidOperations.size === 0);
    const duplicate = (resultCounts.get(definition.endpoint) ?? 0) > 1;
    return featureFor(definition, entries.get(key) ?? [], associated, invalid, duplicate);
  });

  if (features.some((feature) => feature.state === 'CONTRADICTORY')) addIssue(issues, 'CONTRADICTORY_SIGNAL');
  const featuresById = new Map(features.map((feature) => [feature.endpoint + '|' + feature.asset + '|' + feature.metric, feature]));
  const spot = featuresById.get('TOKEN_SCREENER|WETH|price_usd');
  const flow = featuresById.get('SMART_MONEY_NETFLOW|WETH|net_flow_1h_usd');
  let eligibility: G1DEvidencePacket['eligibility'] = 'INELIGIBLE';
  if ([...issues].includes('CONTRADICTORY_SIGNAL') || features.some((feature) => feature.state === 'CONTRADICTORY')) eligibility = 'CONTRADICTORY';
  else if ([...issues].some((issue) => ['INVALID_RESULT', 'INVALID_SIGNAL', 'ENDPOINT_MISMATCH', 'SOURCE_MISMATCH', 'TIMESTAMP_MISMATCH'].includes(issue))) eligibility = 'INVALID';
  else if (spot && flow && ['COMPLETE', 'ZERO'].includes(spot.state) && ['COMPLETE', 'ZERO'].includes(flow.state) &&
      spot.source === 'nansen' && flow.source === 'nansen' && spot.valueMicros !== null && flow.valueMicros !== null &&
      spot.flags.length === 0 && flow.flags.length === 0) eligibility = 'ELIGIBLE';

  const source: G1DSource = sources.size > 1 ? 'mixed' : sources.values().next().value ?? 'none';
  return Object.freeze({
    schemaVersion: 'g1d-evidence-packet-v1',
    featureVersion: 'g1d-features-v1',
    questionVersion: G1D_QUESTION_VERSION,
    routePolicyVersion: G1D_ROUTE_POLICY.version,
    generatedAt: new Date(nowMs).toISOString(),
    source,
    eligibility,
    issues: Object.freeze([...issues].sort()),
    inputs: Object.freeze(inputSummaries),
    features: Object.freeze(features),
  });
}

export function createG1DTypeSafeRequest(evidence: G1DEvidencePacket): G1DTypeSafeRequest {
  return Object.freeze({ state: evidence, model: G1D_MODEL_ALIAS, questions: G1D_QUESTIONS });
}
export function g1dRequestHash(request: G1DTypeSafeRequest): string {
  return hash(canonicalJson(request));
}
export function g1dQuestionSetHash(): string {
  return hash(canonicalJson({ version: G1D_QUESTION_VERSION, model: G1D_MODEL_ALIAS, questions: G1D_QUESTIONS }));
}
function routeFor(evidence: G1DEvidencePacket, answer: G1DQuestionAnswer | null): G1DAdvisoryRoute {
  if (evidence.eligibility === 'INVALID' || evidence.eligibility === 'CONTRADICTORY') return 'ASTRA_REVIEW';
  if (evidence.eligibility !== 'ELIGIBLE' || evidence.source !== 'nansen') return 'STORE';
  if (answer === null) return 'ASTRA_REVIEW';
  if (answer.noul <= G1D_ROUTE_POLICY.watchAtOrBelow) return 'WATCH';
  if (answer.noul >= G1D_ROUTE_POLICY.reviewAtOrAbove) return 'ASTRA_REVIEW';
  return 'STORE';
}
function baseResult(
  evidence: G1DEvidencePacket,
  request: G1DTypeSafeRequest,
  status: G1DShadowResult['status'],
  errorCode: G1DShadowErrorCode | null,
  requestsMade: 0 | 1 = 0,
  attemptId: string | null = null,
  answer: G1DQuestionAnswer | null = null,
  usage: G1DUsage | null = null,
  resolvedModel: string | null = null,
  latencyMs: number | null = null,
  httpStatus: number | null = null,
): G1DShadowResult {
  return Object.freeze({
    status, requestsMade, authority: 'NONE', attemptId, requestHash: g1dRequestHash(request),
    questionSetHash: g1dQuestionSetHash(), requestedModel: G1D_MODEL_ALIAS, resolvedModel,
    evidence, request, answer, usage, latencyMs, httpStatus, errorCode, advisoryRoute: routeFor(evidence, answer),
  });
}
function validateOptions(value: G1DShadowEvaluatorOptions): Required<Pick<G1DShadowEvaluatorOptions, 'enabled' | 'clock' | 'timeoutMs' | 'maxResponseBytes'>> & G1DShadowEvaluatorOptions {
  const enabled = value.enabled ?? false;
  const clock = value.clock ?? (() => new Date());
  const timeoutMs = value.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = value.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (typeof enabled !== 'boolean' || typeof clock !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 256 || maxResponseBytes > MAX_RESPONSE_BYTES ||
      (value.apiKey !== undefined && (typeof value.apiKey !== 'string' || value.apiKey.length < 1 || value.apiKey.length > 2_000))) {
    throw new TypeError('Invalid G1d TypeSafe evaluator configuration.');
  }
  return { ...value, enabled, clock, timeoutMs, maxResponseBytes };
}
async function defaultTransport(request: G1DTypeSafeHttpRequest): Promise<G1DTypeSafeHttpResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
    redirect: 'error',
  });
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body !== null) {
    const reader = response.body.getReader();
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new G1DTypeSafeResponseTooLargeError();
      }
      chunks.push(item.value);
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return { status: response.status, body };
}
function parseResponse(value: unknown): { model: string; answer: G1DQuestionAnswer; usage: G1DUsage } | null {
  if (!isRecord(value) || !hasExactKeys(value, ['model', 'answers', 'usage']) ||
      typeof value.model !== 'string' || value.model.length > 80 || !MODEL.test(value.model) ||
      !isRecord(value.answers) || !hasExactKeys(value.answers, [G1D_QUESTION_ID]) || !isRecord(value.usage) ||
      !hasExactKeys(value.usage, ['input_tokens', 'output_tokens'])) return null;
  const answer = value.answers[G1D_QUESTION_ID];
  if (!isRecord(answer) || !hasExactKeys(answer, ['type', 'noul']) || answer.type !== 'noul' ||
      typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) return null;
  const inputTokens = value.usage.input_tokens;
  const outputTokens = value.usage.output_tokens;
  if (!Number.isSafeInteger(inputTokens) || Number(inputTokens) < 0 || Number(inputTokens) > MAX_TOKEN_COUNT ||
      !Number.isSafeInteger(outputTokens) || Number(outputTokens) < 0 || Number(outputTokens) > MAX_TOKEN_COUNT) return null;
  return {
    model: value.model,
    answer: { type: 'noul', noul: answer.noul },
    usage: { input_tokens: Number(inputTokens), output_tokens: Number(outputTokens) },
  };
}
function decodeBody(body: Uint8Array, limit: number): unknown | null {
  if (!(body instanceof Uint8Array) || body.byteLength > limit) throw new G1DTypeSafeResponseTooLargeError();
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown; }
  catch { return null; }
}
function cleanError(error: unknown): G1DShadowErrorCode {
  if (error instanceof G1DTypeSafeResponseTooLargeError) return 'RESPONSE_TOO_LARGE';
  if (error instanceof G1DTypeSafeTimeoutError) return 'TIMEOUT';
  return 'TRANSPORT_ERROR';
}
function errorResult(
  evidence: G1DEvidencePacket,
  request: G1DTypeSafeRequest,
  status: G1DShadowResult['status'],
  errorCode: G1DShadowErrorCode,
  requestsMade: 0 | 1,
  attemptId: string | null = null,
  latencyMs: number | null = null,
  httpStatus: number | null = null,
): G1DShadowResult {
  return baseResult(evidence, request, status, errorCode, requestsMade, attemptId, null, null, null, latencyMs, httpStatus);
}

function priorAttemptResult(
  evidence: G1DEvidencePacket,
  request: G1DTypeSafeRequest,
  record: G1DShadowAuditRecord,
  now: Date,
): G1DShadowResult {
  if (record.status === 'OBSERVED' && record.answer !== null && record.completedAt !== null &&
      record.resolvedModel !== null && record.usage !== null && record.requestHash === g1dRequestHash(request) &&
      record.questionSetHash === g1dQuestionSetHash()) {
    const completedAt = Date.parse(record.completedAt);
    const ageMs = now.getTime() - completedAt;
    if (Number.isSafeInteger(completedAt) && ageMs >= 0 && ageMs <= MAX_AUDIT_REUSE_AGE_MS) {
      return baseResult(evidence, request, 'OBSERVED', null, 0, record.attemptId, record.answer,
        record.usage, record.resolvedModel, record.latencyMs, record.httpStatus);
    }
  }
  const errorCode = record.status === 'PENDING' ? 'AMBIGUOUS_ATTEMPT' : 'PRIOR_ATTEMPT_EXISTS';
  return errorResult(evidence, request, 'UNAVAILABLE', errorCode, 0, record.attemptId);
}

export function createG1DShadowEvaluator(options: G1DShadowEvaluatorOptions = {}): G1DShadowEvaluator {
  const config = validateOptions(options);
  return {
    async evaluate(results, mapOptions = {}): Promise<G1DShadowResult> {
      const evaluationTime = mapOptions.now ?? config.clock();
      const evidence = buildG1DEvidencePacket(results, { now: evaluationTime });
      const request = createG1DTypeSafeRequest(evidence);
      if (!config.enabled) return baseResult(evidence, request, 'DISABLED', null);
      if (typeof config.apiKey !== 'string' || config.apiKey.length === 0) {
        return errorResult(evidence, request, 'UNAVAILABLE', 'MISSING_CREDENTIAL', 0);
      }
      if (config.auditStore === undefined) {
        return errorResult(evidence, request, 'UNAVAILABLE', 'INVALID_CONFIGURATION', 0);
      }
      if (config.transport === undefined && (evidence.source !== 'nansen' || evidence.eligibility !== 'ELIGIBLE')) {
        return errorResult(evidence, request, 'INVALID_INPUT', 'INVALID_INPUT', 0);
      }
      const requestBody = JSON.stringify(request);
      if (Buffer.byteLength(requestBody, 'utf8') > MAX_REQUEST_BYTES) {
        return errorResult(evidence, request, 'INVALID_INPUT', 'INVALID_INPUT', 0);
      }
      const attemptId = randomUUID();
      const requestHash = g1dRequestHash(request);
      const questionSetHash = g1dQuestionSetHash();
      try {
        const prior = config.auditStore.getByRequestHash(requestHash);
        if (prior !== null) return priorAttemptResult(evidence, request, prior, evaluationTime);
      } catch {
        return errorResult(evidence, request, 'UNAVAILABLE', 'LOCAL_AUDIT_FAILURE', 0);
      }
      try {
        config.auditStore.recordPending({
          attemptId,
          requestHash,
          questionSetHash,
          createdAt: evaluationTime.toISOString(),
          requestedModel: G1D_MODEL_ALIAS,
          request,
        });
      } catch {
        try {
          const prior = config.auditStore.getByRequestHash(requestHash);
          if (prior !== null) return priorAttemptResult(evidence, request, prior, evaluationTime);
        } catch { /* A failed lookup remains a local audit failure. */ }
        return errorResult(evidence, request, 'UNAVAILABLE', 'LOCAL_AUDIT_FAILURE', 0);
      }

      const controller = new AbortController();
      const started = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let response: G1DTypeSafeHttpResponse;
      try {
        const transport = config.transport ?? defaultTransport;
        const transportPromise = transport({
          url: TYPE_SAFE_URL,
          method: 'POST',
          headers: { Authorization: 'Bearer ' + config.apiKey, 'Content-Type': 'application/json' },
          body: requestBody,
          signal: controller.signal,
        });
        response = await Promise.race([
          transportPromise,
          new Promise<G1DTypeSafeHttpResponse>((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new G1DTypeSafeTimeoutError());
            }, config.timeoutMs);
          }),
        ]);
      } catch (error) {
        if (timer !== undefined) clearTimeout(timer);
        const latencyMs = Math.max(0, Date.now() - started);
        const errorCode = cleanError(error);
        const route = routeFor(evidence, null);
        try {
          config.auditStore.recordCompletion(attemptId, {
            status: 'UNAVAILABLE', resolvedModel: null, answer: null, usage: null, latencyMs,
            httpStatus: null, errorCode, advisoryRoute: route,
          });
        } catch {
          return errorResult(evidence, request, 'UNAVAILABLE', 'AUDIT_COMPLETION_FAILED', 1, attemptId, latencyMs);
        }
        return errorResult(evidence, request, 'UNAVAILABLE', errorCode, 1, attemptId, latencyMs);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      const latencyMs = Math.max(0, Date.now() - started);
      if (!isRecord(response) || !Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599 ||
          !(response.body instanceof Uint8Array)) {
        try {
          config.auditStore.recordCompletion(attemptId, {
            status: 'INVALID_RESPONSE', resolvedModel: null, answer: null, usage: null, latencyMs,
            httpStatus: null, errorCode: 'INVALID_RESPONSE', advisoryRoute: routeFor(evidence, null),
          });
        } catch {
          return errorResult(evidence, request, 'UNAVAILABLE', 'AUDIT_COMPLETION_FAILED', 1, attemptId, latencyMs);
        }
        return errorResult(evidence, request, 'INVALID_RESPONSE', 'INVALID_RESPONSE', 1, attemptId, latencyMs);
      }
      if (response.status < 200 || response.status >= 300) {
        try {
          config.auditStore.recordCompletion(attemptId, {
            status: 'UNAVAILABLE', resolvedModel: null, answer: null, usage: null, latencyMs,
            httpStatus: response.status, errorCode: 'HTTP_ERROR', advisoryRoute: routeFor(evidence, null),
          });
        } catch {
          return errorResult(evidence, request, 'UNAVAILABLE', 'AUDIT_COMPLETION_FAILED', 1, attemptId, latencyMs, response.status);
        }
        return errorResult(evidence, request, 'UNAVAILABLE', 'HTTP_ERROR', 1, attemptId, latencyMs, response.status);
      }
      let decoded: unknown | null;
      try { decoded = decodeBody(response.body, config.maxResponseBytes); }
      catch {
        try {
          config.auditStore.recordCompletion(attemptId, {
            status: 'INVALID_RESPONSE', resolvedModel: null, answer: null, usage: null, latencyMs,
            httpStatus: response.status, errorCode: 'RESPONSE_TOO_LARGE', advisoryRoute: routeFor(evidence, null),
          });
        } catch {
          return errorResult(evidence, request, 'UNAVAILABLE', 'AUDIT_COMPLETION_FAILED', 1, attemptId, latencyMs, response.status);
        }
        return errorResult(evidence, request, 'INVALID_RESPONSE', 'RESPONSE_TOO_LARGE', 1, attemptId, latencyMs, response.status);
      }
      const parsed = parseResponse(decoded);
      if (parsed === null) {
        try {
          config.auditStore.recordCompletion(attemptId, {
            status: 'INVALID_RESPONSE', resolvedModel: null, answer: null, usage: null, latencyMs,
            httpStatus: response.status, errorCode: 'INVALID_RESPONSE', advisoryRoute: routeFor(evidence, null),
          });
        } catch {
          return errorResult(evidence, request, 'UNAVAILABLE', 'AUDIT_COMPLETION_FAILED', 1, attemptId, latencyMs, response.status);
        }
        return errorResult(evidence, request, 'INVALID_RESPONSE', 'INVALID_RESPONSE', 1, attemptId, latencyMs, response.status);
      }

      const advisoryRoute = routeFor(evidence, parsed.answer);
      try {
        config.auditStore.recordCompletion(attemptId, {
          status: 'OBSERVED', resolvedModel: parsed.model, answer: parsed.answer, usage: parsed.usage,
          latencyMs, httpStatus: response.status, errorCode: null, advisoryRoute,
        });
      } catch {
        return errorResult(evidence, request, 'UNAVAILABLE', 'AUDIT_COMPLETION_FAILED', 1, attemptId, latencyMs, response.status);
      }
      return baseResult(evidence, request, 'OBSERVED', null, 1, attemptId, parsed.answer, parsed.usage, parsed.model, latencyMs, response.status);
    },
  };
}

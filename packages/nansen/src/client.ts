import { createGuardedPost, type NansenClientOptions } from './client-core.js';
import { buildNansenAdapters, type NansenClient } from './adapters.js';

export { NansenClientError } from './client-core.js';
export type {
  NansenCallOptions,
  NansenClientErrorCode,
  NansenClientOptions,
  NansenHttpRequest,
  NansenHttpResponse,
  NansenHttpTransport,
} from './client-core.js';
export { BASE_ASSET_ADDRESSES } from './adapters.js';
export type {
  AdapterCompleteness, AdapterEvidenceDiagnostics, EvidenceFieldName, EvidenceFieldState,
  AdapterFailure,
  AdapterResult,
  BaseEvidenceAsset,
  FlowIntelligenceQuery,
  FlowIntelligenceRow,
  FlowIntelligenceTimeframe,
  NansenClient,
  PageReference,
  SmartMoneyNetflowQuery,
  SmartMoneyNetflowToken,
  TokenScreenerQuery,
  TokenScreenerTimeframe,
  TokenScreenerToken,
} from './adapters.js';

const clientProvenance = new WeakMap<NansenClient, 'nansen' | 'synthetic'>();

export function createNansenClient(options: NansenClientOptions): NansenClient {
  const guarded = createGuardedPost(options);
  const client = buildNansenAdapters(guarded);
  clientProvenance.set(client, guarded.provenance);
  return client;
}

/** Unregistered structural clients fail closed to synthetic provenance. */
export function getNansenClientProvenance(client: NansenClient): 'nansen' | 'synthetic' {
  return clientProvenance.get(client) ?? 'synthetic';
}
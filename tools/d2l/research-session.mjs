import { createD2hRunHooks } from '../d2h/bounded-session.mjs';

const OPERATIONS = new Set(['TOKEN_SCREENER', 'SMART_MONEY_NETFLOW']);
const DECIMAL = /^-?(0|[1-9][0-9]*)$/u;
function record(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export function hasUsableWethResearchSignal(query, result) {
  if (!OPERATIONS.has(query?.operation) || !result || result.source !== 'nansen' ||
      !['fresh', 'cached'].includes(result.status) || result.completeness !== 'complete' || result.failure ||
      result.storeError || result.managerError || result.pageBound !== 1 || result.retryBound !== 0 ||
      !Number.isSafeInteger(Date.parse(result.acquiredAt ?? '')) || result.observations === undefined) return false;
  if (result.cacheHit !== (result.status === 'cached')) return false;
  const refs = Array.isArray(result.attemptPageReferences) ? result.attemptPageReferences : [];
  if (result.status === 'cached' ? refs.length !== 0 : refs.filter((ref) => ref.received === true && Number.isSafeInteger(ref.status) && ref.status >= 200 && ref.status < 300).length !== 1) return false;
  if (refs.some((ref) => ref.chargedCredits === null || ref.chargedCredits === undefined)) return false;
  const metric = query.operation === 'TOKEN_SCREENER' ? 'price_usd' : 'net_flow_1h_usd';
  const matches = result.observations.filter((signal) => signal?.provider === 'nansen' && signal.endpoint === query.operation &&
    signal.chainId === 8453 && signal.asset === 'WETH' && signal.metric === metric);
  if (matches.length !== 1) return false;
  const signal = matches[0];
  if (signal.quality !== 'COMPLETE' || signal.unit !== 'usd_micros' || !DECIMAL.test(signal.value ?? '') || signal.observedAt !== result.acquiredAt) return false;
  return query.operation !== 'TOKEN_SCREENER' || BigInt(signal.value) > 0n;
}

/** D2l accounting extends the accepted D2h guards without changing its attempt, credit, deadline, or reconciliation controls. */
export function createD2lResearchHooks(options) {
  if (!record(options?.manifest?.research) || options.manifest.profile !== 'weth-research-v1' || typeof options.persist !== 'function') throw new Error('SESSION_INVALID');
  let deferBasePersist = false;
  const base = createD2hRunHooks({ ...options, persist: (manifest) => { if (!deferBasePersist) options.persist(manifest); } });
  return Object.freeze({
    beforeQuery: base.beforeQuery,
    beforeDispatch: base.beforeDispatch,
    onQuery(query, result) {
      const refs = Array.isArray(result?.attemptPageReferences) ? result.attemptPageReferences : [];
      const research = options.manifest.research;
      if (result?.source === 'nansen' && OPERATIONS.has(query.operation)) research.successfulHttpRequests[query.operation] += refs.filter((ref) => Number.isSafeInteger(ref.status) && ref.status >= 200 && ref.status < 300).length;
      if (result?.cacheHit === true) research.cacheHits += 1;
      const usable = hasUsableWethResearchSignal(query, result);
      if (usable) research.usableResearchSnapshots += 1;
      else research.failedResults += 1;
      let baseStop;
      deferBasePersist = true;
      try { baseStop = base.onQuery(query, result); }
      finally { deferBasePersist = false; }
      options.persist(options.manifest);
      return baseStop ?? (usable ? null : 'UNUSABLE_RESULT');
    },
    onQueryError() {
      options.manifest.stats.failedQueries += 1;
      options.manifest.research.failedResults += 1;
      options.persist(options.manifest);
    },
    onCycle: base.onCycle,
    snapshot: base.snapshot,
  });
}

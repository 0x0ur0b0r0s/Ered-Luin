import { MAX_OBSERVATION_HISTORY_QUERY_LIMIT, WETH_RESEARCH_CACHE_KEYS } from '../../packages/nansen/dist/index.js';

const SAMPLE_MS = 5 * 60_000;
const COARSE_MS = 30 * 60_000;
const GAP_MS = 10 * 60_000;
const MAX_EVENTS = 128;
const INTEGER = /^-?(0|[1-9][0-9]*)$/u;
function validInteger(value) { return typeof value === 'string' && INTEGER.test(value); }
function signOf(value) { if (!validInteger(value)) return 'UNAVAILABLE'; const n = BigInt(value); return n > 0n ? 'POSITIVE' : n < 0n ? 'NEGATIVE' : 'ZERO'; }
function metric(snapshot, endpoint, asset, name) {
  const matches = snapshot.signals.filter((signal) => signal.provider === 'nansen' && signal.endpoint === endpoint && signal.asset === asset && signal.metric === name);
  return matches.length === 1 ? matches[0] : null;
}
function usable(snapshot, endpoint, asset, name, positive = false) {
  const acquiredAtMs = Date.parse(snapshot.acquiredAt);
  if (snapshot.source !== 'nansen' || snapshot.completeness !== 'complete' || snapshot.failure !== null || !Number.isSafeInteger(acquiredAtMs)) return null;
  const signal = metric(snapshot, endpoint, asset, name);
  if (!signal || signal.quality !== 'COMPLETE' || signal.unit !== 'usd_micros' || !validInteger(signal.value) || signal.observedAt !== snapshot.acquiredAt || !Number.isSafeInteger(Date.parse(signal.fetchedAt)) || Date.parse(signal.fetchedAt) > acquiredAtMs) return null;
  if (positive && BigInt(signal.value) <= 0n) return null;
  return signal;
}
function history(store, cacheKey) {
  const total = store.getHistoryCount(cacheKey);
  const snapshots = [...store.listHistory({ cacheKey, limit: MAX_OBSERVATION_HISTORY_QUERY_LIMIT })]
    .filter((item) => item.source === 'nansen').sort((a, b) => Date.parse(a.acquiredAt) - Date.parse(b.acquiredAt));
  return { total, snapshots, truncated: total > snapshots.length };
}
function bpsChange(previous, current) {
  const before = BigInt(previous); const after = BigInt(current);
  if (before <= 0n) return null;
  const value = ((after - before) * 10_000n / before).toString();
  return value.length <= 16 ? value : null;
}
function collectPrices(snapshots, nowMs) {
  const result = []; let previous = null; let validCount = 0;
  for (const snapshot of snapshots) {
    if (Date.parse(snapshot.acquiredAt) > nowMs) continue;
    const signal = usable(snapshot, 'TOKEN_SCREENER', 'WETH', 'price_usd', true);
    if (!signal) continue;
    validCount += 1;
    const current = signal.value;
    let direction = 'FIRST'; let changeBps = null;
    if (previous !== null) {
      const before = BigInt(previous); const after = BigInt(current);
      direction = after > before ? 'UP' : after < before ? 'DOWN' : 'UNCHANGED';
      changeBps = bpsChange(previous, current);
    }
    previous = current;
    result.push({ at: snapshot.acquiredAt, ageMs: Math.max(0, nowMs - Date.parse(snapshot.acquiredAt)), direction, changeBps });
  }
  return { points: result, validCount };
}
function collectFlows(snapshots, nowMs) {
  const result = []; let previous = null; let validCount = 0;
  for (const snapshot of snapshots) {
    if (Date.parse(snapshot.acquiredAt) > nowMs) continue;
    const signal = usable(snapshot, 'SMART_MONEY_NETFLOW', 'WETH', 'net_flow_1h_usd');
    if (!signal) continue;
    validCount += 1;
    const current = signal.value; const sign = signOf(current);
    let change = 'FIRST';
    if (previous !== null) { const before = BigInt(previous); const after = BigInt(current); change = after > before ? 'INCREASED' : after < before ? 'DECREASED' : 'UNCHANGED'; }
    previous = current;
    result.push({ at: snapshot.acquiredAt, ageMs: Math.max(0, nowMs - Date.parse(snapshot.acquiredAt)), sign, change, privateValue: current });
  }
  return { points: result, validCount };
}
function reversals(points, timeKey, { maxGapMs = null } = {}) {
  const events = []; let prior = null; let previousAtMs = null; let activeEvent = null;
  function closeActive(endAtMs, inclusive) {
    if (activeEvent && activeEvent.endAtMs === null) {
      activeEvent.endAtMs = endAtMs;
      activeEvent.endInclusive = inclusive;
    }
    activeEvent = null;
  }
  for (const point of points) {
    const at = point[timeKey]; const atMs = Date.parse(at);
    if (!Number.isSafeInteger(atMs)) {
      if (previousAtMs !== null) closeActive(previousAtMs, true);
      prior = null; previousAtMs = null; continue;
    }
    if (maxGapMs !== null && previousAtMs !== null && atMs - previousAtMs > maxGapMs) {
      closeActive(previousAtMs, true);
      prior = null;
    }
    if (point.sign === 'UNAVAILABLE') {
      closeActive(previousAtMs ?? atMs, true);
      prior = null; previousAtMs = atMs; continue;
    }
    if (point.sign === 'ZERO') { previousAtMs = atMs; continue; }
    if (prior && prior.sign !== point.sign) {
      closeActive(atMs, false);
      activeEvent = { from: prior.sign, to: point.sign, at, selectedAt: point.selectedAt ?? point.at, endAtMs: null, endInclusive: false };
      events.push(activeEvent);
    }
    prior = { sign: point.sign };
    previousAtMs = atMs;
  }
  return events;
}
function coarseSamples(points) {
  if (points.length === 0) return { samples: [], uncomparable: [] };
  const start = Date.parse(points[0].at); const end = Date.parse(points.at(-1).at);
  let bucket = Math.ceil(start / COARSE_MS) * COARSE_MS;
  const samples = []; const uncomparable = [];
  for (; bucket <= end; bucket += COARSE_MS) {
    let selected = null;
    for (const point of points) { if (Date.parse(point.at) <= bucket) selected = point; else break; }
    const ageMs = selected ? bucket - Date.parse(selected.at) : null;
    if (!selected || ageMs < 0 || ageMs > SAMPLE_MS) {
      uncomparable.push({ bucketAt: new Date(bucket).toISOString(), reason: selected ? 'NO_SAMPLE_WITHIN_FIVE_MINUTES' : 'NO_PRIOR_SAMPLE' });
      samples.push({ bucketAt: new Date(bucket).toISOString(), selectedAt: null, ageMs, sign: 'UNAVAILABLE' });
      continue;
    }
    if (Date.parse(selected.at) > bucket) throw new Error('LOOKAHEAD_DETECTED');
    samples.push({ bucketAt: new Date(bucket).toISOString(), selectedAt: selected.at, ageMs, sign: selected.sign, privateValue: selected.privateValue });
  }
  return { samples, uncomparable };
}
function summarizeReversals(finePoints, coarse) {
  const fine = reversals(finePoints, 'at', { maxGapMs: GAP_MS });
  const coarseEvents = reversals(coarse.samples.map((point) => ({ ...point, at: point.bucketAt })), 'at');
  const used = new Set(); const delaysSeconds = [];
  const remainsInEpisode = (atMs, event) => event.endAtMs === null || (event.endInclusive ? atMs <= event.endAtMs : atMs < event.endAtMs);
  for (const event of fine) {
    const eventAtMs = Date.parse(event.at);
    const index = coarseEvents.findIndex((candidate, i) => {
      const candidateAtMs = Date.parse(candidate.at); const selectedAtMs = Date.parse(candidate.selectedAt);
      return !used.has(i) && candidate.from === event.from && candidate.to === event.to &&
        candidateAtMs >= eventAtMs && selectedAtMs >= eventAtMs &&
        remainsInEpisode(candidateAtMs, event) && remainsInEpisode(selectedAtMs, event);
    });
    if (index < 0) continue;
    used.add(index); delaysSeconds.push(Math.floor((Date.parse(coarseEvents[index].at) - eventAtMs) / 1_000));
  }
  const gaps = [];
  for (let i = 1; i < finePoints.length; i += 1) {
    const gapMs = Date.parse(finePoints[i].at) - Date.parse(finePoints[i - 1].at);
    if (gapMs > GAP_MS) gaps.push({ from: finePoints[i - 1].at, to: finePoints[i].at, gapMs });
  }
  const shownDelays = delaysSeconds.slice(0, MAX_EVENTS);
  const shownGaps = gaps.slice(0, MAX_EVENTS);
  const shownUncomparable = coarse.uncomparable.slice(0, MAX_EVENTS);
  return {
    fineReversals: fine.length, coarseReversals: coarseEvents.length, matchedReversals: delaysSeconds.length,
    unmatchedFineReversals: fine.length - delaysSeconds.length, observedDetectionDelaySeconds: shownDelays,
    medianDetectionDelaySeconds: delaysSeconds.length ? [...delaysSeconds].sort((a, b) => a - b)[Math.floor((delaysSeconds.length - 1) / 2)] : null,
    uncomparablePeriods: shownUncomparable, uncomparablePeriodsTotal: coarse.uncomparable.length,
    dataGaps: shownGaps, dataGapsTotal: gaps.length,
    eventsTruncated: delaysSeconds.length > MAX_EVENTS || gaps.length > MAX_EVENTS || coarse.uncomparable.length > MAX_EVENTS,
  };
}

/** Compact, read-only D2l history report. Numeric spot/netflow values and raw provider payloads never leave this function. */
export function summarizeWethResearchHistory(store, { now = () => new Date() } = {}) {
  if (!store || typeof store.listHistory !== 'function' || typeof store.getHistoryCount !== 'function' || typeof now !== 'function') throw new Error('SUMMARY_INPUT_INVALID');
  const current = now(); const nowMs = current instanceof Date ? current.getTime() : NaN;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('SUMMARY_CLOCK_INVALID');
  const screener = history(store, WETH_RESEARCH_CACHE_KEYS.TOKEN_SCREENER);
  const netflow = history(store, WETH_RESEARCH_CACHE_KEYS.SMART_MONEY_NETFLOW);
  const prices = collectPrices(screener.snapshots, nowMs); const flows = collectFlows(netflow.snapshots, nowMs);
  const usdcStates = screener.snapshots.map((snapshot) => metric(snapshot, 'TOKEN_SCREENER', 'USDC', 'price_usd')?.quality ?? 'MISSING');
  const latestUsdc = usdcStates.at(-1) ?? 'UNKNOWN';
  const coarse = coarseSamples(flows.points);
  const comparison = summarizeReversals(flows.points, coarse);
  const compactPrices = prices.points.slice(-MAX_OBSERVATION_HISTORY_QUERY_LIMIT).map(({ at, ageMs, direction, changeBps }) => ({ at, ageMs, direction, changeBps }));
  const compactFlows = flows.points.slice(-MAX_OBSERVATION_HISTORY_QUERY_LIMIT).map(({ at, ageMs, sign, change }) => ({ at, ageMs, sign, change }));
  const coarseSeries = coarse.samples.slice(-MAX_OBSERVATION_HISTORY_QUERY_LIMIT).map(({ bucketAt, selectedAt, ageMs, sign }) => ({ bucketAt, selectedAt, ageMs, sign }));
  return Object.freeze({
    mode: 'OFFLINE_WETH_RESEARCH_HISTORY', providerCalls: 0, credentialRead: false, storeMutation: false,
    summaryAt: current.toISOString(), source: 'persisted canonical Nansen snapshots only; this is not market or trading evidence',
    series: Object.freeze({
      tokenScreener: Object.freeze({ retainedSnapshots: screener.total, returnedSnapshots: screener.snapshots.length, usableWethPriceSamples: prices.validCount, missingOrUnusableSamples: Math.max(0, screener.snapshots.length - prices.validCount), truncated: screener.truncated, price: Object.freeze(compactPrices) }),
      smartMoneyNetflow: Object.freeze({ retainedSnapshots: netflow.total, returnedSnapshots: netflow.snapshots.length, usableWethNetflowSamples: flows.validCount, missingOrUnusableSamples: Math.max(0, netflow.snapshots.length - flows.validCount), truncated: netflow.truncated, flow: Object.freeze(compactFlows) }),
      missingUsdcSpot: Object.freeze({ latestStatus: latestUsdc, missingOrPartialSnapshots: usdcStates.filter((state) => state !== 'COMPLETE').length, observedSnapshots: usdcStates.length, blocksG2: latestUsdc !== 'COMPLETE' }),
    }),
    comparison: Object.freeze({ method: 'UTC-aligned 30-minute buckets select only the newest complete sample acquired at or before each bucket; samples older than five minutes are uncomparable.', coarseSeries: Object.freeze(coarseSeries), ...comparison }),
    outputTruncated: screener.truncated || netflow.truncated || prices.points.length > MAX_OBSERVATION_HISTORY_QUERY_LIMIT || flows.points.length > MAX_OBSERVATION_HISTORY_QUERY_LIMIT || coarse.samples.length > MAX_OBSERVATION_HISTORY_QUERY_LIMIT || comparison.eventsTruncated,
  });
}

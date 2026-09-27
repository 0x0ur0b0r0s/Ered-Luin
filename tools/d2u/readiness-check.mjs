import { lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASE_USDC_OHLCV_PRICE_CACHE_KEY, BASE_USDC_PRICE_CACHE_KEY, NANSEN_COST_PROFILE_VERSION, WETH_RESEARCH_CACHE_KEYS,
} from '../../packages/nansen/dist/index.js';
import { resolveD2uScopedConfiguration } from './run-usdc-diagnostic.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const MAX_PRICE_AGE_MS = 10 * 60_000;
const CANDIDATES = Object.freeze([
  Object.freeze({ source: 'nansen-token-ohlcv', cacheKey: BASE_USDC_OHLCV_PRICE_CACHE_KEY, operation: 'TOKEN_OHLCV', timeframe: '1m', snapshotAsset: 'USDC' }),
  Object.freeze({ source: 'nansen-usdc-screener', cacheKey: BASE_USDC_PRICE_CACHE_KEY, operation: 'TOKEN_SCREENER', timeframe: '1h', snapshotAsset: 'USDC' }),
  Object.freeze({ source: 'nansen-paired-screener', cacheKey: WETH_RESEARCH_CACHE_KEYS.TOKEN_SCREENER, operation: 'TOKEN_SCREENER', timeframe: '1h', snapshotAsset: 'BASE_PAIR' }),
]);
function insideRoot(path) {
  const rel = relative(ROOT, resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}
function assertExternalDatabase(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || insideRoot(path)) throw new Error('READINESS_STORE_UNAVAILABLE');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('READINESS_STORE_UNAVAILABLE');
}
function safeMicros(value) {
  if (typeof value !== 'string' || !/^[0-9]+$/u.test(value)) return null;
  try { const parsed = BigInt(value); return parsed > 0n ? parsed : null; } catch { return null; }
}
function assessCandidate(candidate, snapshot, signals, nowMs) {
  if (!snapshot) return Object.freeze({ source: candidate.source, cacheKey: candidate.cacheKey,
    operation: candidate.operation, status: 'NO_SNAPSHOT', usable: false, ageMs: null, intervalStart: null,
    fetchedAt: null, priceUsdMicros: null });
  const base = { source: candidate.source, cacheKey: candidate.cacheKey, operation: candidate.operation,
    snapshotId: snapshot.snapshot_id, snapshotSource: snapshot.source, asset: snapshot.asset,
    timeframe: snapshot.timeframe, fetchedAt: snapshot.fetched_at, acquiredAt: snapshot.acquired_at };
  if (snapshot.source !== 'nansen' || snapshot.cache_key !== candidate.cacheKey || snapshot.operation !== candidate.operation ||
      snapshot.asset !== candidate.snapshotAsset || snapshot.timeframe !== candidate.timeframe || Number(snapshot.page_bound) !== 1 ||
      Number(snapshot.retry_bound) !== 0) return Object.freeze({ ...base, status: 'IDENTITY_MISMATCH', usable: false,
        ageMs: null, intervalStart: null, priceUsdMicros: null });
  const matching = signals.filter((signal) => signal.endpoint === candidate.operation && signal.asset === 'USDC' && signal.metric === 'price_usd');
  if (matching.length > 1) return Object.freeze({ ...base, status: 'PRICE_AMBIGUOUS', usable: false,
    ageMs: null, intervalStart: null, priceUsdMicros: null });
  if (matching.length === 0) return Object.freeze({ ...base, status: 'PRICE_MISSING', usable: false,
    ageMs: null, intervalStart: null, priceUsdMicros: null });
  const signal = matching[0];
  const signalLineageMatches = signal.fetched_at === snapshot.fetched_at && (candidate.operation === 'TOKEN_OHLCV'
    ? signal.timeframe === '1m' : signal.observed_at === snapshot.acquired_at);
  if (signal.provider !== 'nansen' || Number(signal.chain_id) !== 8453 || signal.unit !== 'usd_micros' || !signalLineageMatches) {
    return Object.freeze({ ...base, status: 'PRICE_IDENTITY_MISMATCH', usable: false, ageMs: null,
      intervalStart: candidate.operation === 'TOKEN_OHLCV' ? signal.observed_at : null, priceUsdMicros: null });
  }
  const fetchedMs = Date.parse(snapshot.fetched_at);
  const acquiredMs = Date.parse(snapshot.acquired_at);
  const expiresMs = Date.parse(snapshot.expires_at);
  const observedMs = Date.parse(candidate.operation === 'TOKEN_OHLCV' ? signal.observed_at : snapshot.fetched_at);
  const ageMs = nowMs - observedMs;
  const micros = safeMicros(signal.value);
  if (signal.quality === 'MISSING' && signal.value === null) return Object.freeze({ ...base, status: 'PRICE_MISSING', usable: false,
    ageMs: Number.isSafeInteger(ageMs) ? ageMs : null, intervalStart: candidate.operation === 'TOKEN_OHLCV' ? signal.observed_at : null, priceUsdMicros: null });
  if (signal.quality !== 'COMPLETE' || micros === null) return Object.freeze({ ...base, status: 'PRICE_INVALID', usable: false,
    ageMs: Number.isSafeInteger(ageMs) ? ageMs : null,
    intervalStart: candidate.operation === 'TOKEN_OHLCV' ? signal.observed_at : null, priceUsdMicros: null });
  const completed = candidate.operation !== 'TOKEN_OHLCV' ||
    (signal.timeframe === '1m' && Number.isSafeInteger(observedMs) && observedMs % 60_000 === 0 &&
      observedMs + 60_000 <= fetchedMs && signal.fetched_at === snapshot.fetched_at);
  const fresh = Number.isSafeInteger(fetchedMs) && Number.isSafeInteger(acquiredMs) && Number.isSafeInteger(expiresMs) &&
    Number.isSafeInteger(observedMs) && fetchedMs <= nowMs && acquiredMs <= nowMs && observedMs <= nowMs &&
    expiresMs > nowMs && ageMs >= 0 && ageMs <= MAX_PRICE_AGE_MS && snapshot.completeness === 'complete' &&
    snapshot.failure_code === null && completed;
  if (!fresh) return Object.freeze({ ...base, status: 'PRICE_STALE', usable: false,
    ageMs: Number.isSafeInteger(ageMs) ? ageMs : null,
    intervalStart: candidate.operation === 'TOKEN_OHLCV' ? signal.observed_at : null, priceUsdMicros: micros.toString() });
  return Object.freeze({ ...base, status: 'READY', usable: true, ageMs,
    intervalStart: candidate.operation === 'TOKEN_OHLCV' ? signal.observed_at : null,
    fetchedAt: snapshot.fetched_at, priceUsdMicros: micros.toString() });
}
function publicResult(status, candidates, selected = null) {
  return Object.freeze({ gate: 'D2v', mode: 'PERSISTED_READINESS', providerCalls: 0, credentialRead: false,
    cacheKey: selected?.cacheKey ?? candidates[0]?.cacheKey ?? BASE_USDC_OHLCV_PRICE_CACHE_KEY,
    status, ready: selected !== null, snapshotPresent: candidates.some((candidate) => candidate.snapshotId !== undefined),
    source: selected?.snapshotSource ?? candidates.find((candidate) => candidate.snapshotId !== undefined)?.snapshotSource ?? 'none',
    selectedSource: selected?.source ?? null, operation: selected?.operation ?? null, asset: selected?.asset ?? null,
    timeframe: selected?.timeframe ?? null, fetchedAt: selected?.fetchedAt ?? null, acquiredAt: selected?.acquiredAt ?? null,
    intervalStart: selected?.intervalStart ?? null, ageMs: selected?.ageMs ?? null,
    priceUsdMicros: selected?.priceUsdMicros ?? null, freshness: selected ? 'fresh' : 'not_ready',
    candidates: Object.freeze(candidates), reason: selected ? null : status });
}
export function assessPersistedUsdcCandidates(rows, signalsBySnapshot, now = new Date()) {
  if (!(now instanceof Date) || !Number.isSafeInteger(now.getTime())) throw new Error('READINESS_CLOCK_UNAVAILABLE');
  const assessed = CANDIDATES.map((candidate) => {
    const snapshot = rows.find((row) => row.cache_key === candidate.cacheKey) ?? null;
    const signals = snapshot ? signalsBySnapshot.get(snapshot.snapshot_id) ?? [] : [];
    return assessCandidate(candidate, snapshot, signals, now.getTime());
  });
  const selected = assessed.find((candidate) => candidate.usable) ?? null;
  if (selected) return publicResult('READY', assessed, selected);
  if (!assessed.some((candidate) => candidate.snapshotId)) return publicResult('NO_SNAPSHOT', assessed);
  const relevant = assessed.find((candidate) => candidate.status !== 'NO_SNAPSHOT' && candidate.status !== 'PRICE_MISSING') ??
    assessed.find((candidate) => candidate.status === 'PRICE_MISSING') ?? assessed[0];
  return publicResult(relevant?.status ?? 'NO_SNAPSHOT', assessed);
}
export function assessPersistedUsdcSnapshot(snapshot, signals, now = new Date()) {
  return assessPersistedUsdcCandidates(snapshot ? [snapshot] : [], new Map(snapshot ? [[snapshot.snapshot_id, signals]] : []), now);
}
export function readPersistedUsdcReadiness({ databasePath, storeId, now = new Date() }) {
  if (typeof storeId !== 'string' || storeId.length < 1 || storeId.length > 128) throw new Error('READINESS_STORE_UNAVAILABLE');
  assertExternalDatabase(databasePath);
  let db;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    db.exec('PRAGMA query_only = ON');
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    const meta = db.prepare('SELECT schema_version, store_id FROM store_meta WHERE singleton = 1').get();
    if (![1, 2].includes(version) || Number(meta?.schema_version) !== version || meta?.store_id !== storeId) throw new Error('READINESS_STORE_UNAVAILABLE');
    const keys = CANDIDATES.map((candidate) => candidate.cacheKey);
    const allSnapshots = keys.flatMap((key) => db.prepare(`SELECT snapshot_id, cache_key, operation, asset, timeframe, page_bound, retry_bound,
      source, fetched_at, acquired_at, expires_at, completeness, failure_code
      FROM snapshots WHERE cache_key = ? ORDER BY acquired_at_ms DESC, snapshot_id DESC LIMIT 1`).all(key));
    const signalsBySnapshot = new Map();
    for (const snapshot of allSnapshots) {
      const signals = db.prepare(`SELECT provider, endpoint, chain_id, asset, metric, quality, value, unit,
        observed_at, fetched_at FROM observations WHERE snapshot_id = ? AND asset = 'USDC' AND metric = 'price_usd'
        ORDER BY rowid`).all(snapshot.snapshot_id).map((signal) => ({ ...signal, timeframe: snapshot.timeframe }));
      signalsBySnapshot.set(snapshot.snapshot_id, signals);
    }
    return assessPersistedUsdcCandidates(allSnapshots, signalsBySnapshot, now);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('READINESS_')) throw error;
    throw new Error('READINESS_STORE_UNAVAILABLE');
  } finally { try { db?.close(); } catch { /* Read-only connection cleanup. */ } }
}
async function main() {
  if (process.argv.length !== 2) throw new Error('READINESS_USAGE');
  if (!process.env.LOCALAPPDATA) throw new Error('READINESS_CONFIGURATION_UNAVAILABLE');
  const privateRoot = resolve(process.env.LOCALAPPDATA, 'Ered-Luin');
  const config = resolveD2uScopedConfiguration(privateRoot);
  const environment = config.environment;
  if (environment.NANSEN_COST_PROFILE_VERSION !== NANSEN_COST_PROFILE_VERSION ||
      !environment.NANSEN_OBSERVATION_STORE_PATH || !environment.NANSEN_OBSERVATION_STORE_ID) throw new Error('READINESS_CONFIGURATION_UNAVAILABLE');
  const report = readPersistedUsdcReadiness({ databasePath: environment.NANSEN_OBSERVATION_STORE_PATH,
    storeId: environment.NANSEN_OBSERVATION_STORE_ID });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.ready) process.exitCode = 2;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const allowed = new Set(['READINESS_USAGE', 'READINESS_CONFIGURATION_UNAVAILABLE', 'READINESS_STORE_UNAVAILABLE', 'READINESS_CLOCK_UNAVAILABLE']);
    const code = error instanceof Error && allowed.has(error.message) ? error.message : 'READINESS_FAILED_SAFE';
    process.stderr.write('D2v readiness check stopped safely: ' + code + '. No credentials, private paths, provider calls, or arbitrary errors are reported.\n');
    process.exitCode = 1;
  });
}
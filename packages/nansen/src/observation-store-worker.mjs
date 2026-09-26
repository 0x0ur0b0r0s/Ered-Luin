import { openNansenObservationStore } from '../dist/index.js';

const [databasePath, storeId, cacheKey] = process.argv.slice(2);
if (!databasePath || !storeId || !cacheKey) process.exit(2);
let store;
try {
  store = openNansenObservationStore({ databasePath, storeId });
  const nowMs = Number(process.argv[5]);
  const snapshot = store.getFreshCache(cacheKey, new Date(nowMs));
  process.stdout.write(JSON.stringify({
    found: snapshot !== null,
    observationCount: snapshot?.signals.length ?? 0,
    completeness: snapshot?.completeness ?? null,
  }));
} catch {
  process.exitCode = 1;
} finally {
  try { store?.close(); } catch { process.exitCode = 1; }
}
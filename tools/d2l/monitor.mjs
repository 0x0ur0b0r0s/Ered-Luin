import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { collectionProcessIsAlive } from '../d2c/collector-lock.mjs';
import { publicRunStatus, readRunManifest } from '../d2h/bounded-session.mjs';

export const D2L_MONITOR_DEFAULTS = Object.freeze({ pollIntervalMs: 30_000, staleAfterMs: 7 * 60_000 });
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ALERT_TEXT = Object.freeze({
  COLLECTOR_STOPPED: 'The research collector is stopped or its process is no longer alive.',
  STALE_PROGRESS: 'The collector has not written a checkpoint within the configured research interval.',
  ACCOUNTING_RECONCILIATION: 'Collector accounting requires reconciliation.',
  STATUS_UNAVAILABLE: 'The local collector status could not be read.',
});

function validTopic(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(value)) throw new Error('MONITOR_TOPIC_INVALID');
  return value;
}
function validDuration(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
  return value;
}
export function assessD2lMonitorStatus(status, { nowMs = Date.now(), staleAfterMs = D2L_MONITOR_DEFAULTS.staleAfterMs } = {}) {
  validDuration(nowMs, 'MONITOR_CLOCK_INVALID');
  validDuration(staleAfterMs, 'MONITOR_STALE_WINDOW_INVALID');
  if (!status || typeof status !== 'object' || Array.isArray(status)) return Object.freeze(['STATUS_UNAVAILABLE']);
  const alerts = [];
  if (status.state !== 'RUNNING' || status.processAlive !== true) alerts.push('COLLECTOR_STOPPED');
  if (status.reconciliationRequired === true || status.ledger?.reconciliationRequired === true ||
      (Number.isSafeInteger(status.ledger?.pendingAttemptCount) && status.ledger.pendingAttemptCount > 0) ||
      (Number.isSafeInteger(status.stats?.unknownChargeAttempts) && status.stats.unknownChargeAttempts > 0)) {
    alerts.push('ACCOUNTING_RECONCILIATION');
  }
  const updatedAt = Date.parse(status.updatedAt);
  if (!Number.isSafeInteger(updatedAt) || updatedAt > nowMs || nowMs - updatedAt > staleAfterMs) alerts.push('STALE_PROGRESS');
  return Object.freeze(alerts);
}
export function d2lMonitorMessage(alerts) {
  const known = [...new Set(alerts)].filter((code) => Object.hasOwn(ALERT_TEXT, code)).sort();
  if (known.length === 0) throw new Error('MONITOR_ALERTS_EMPTY');
  return known.map((code) => ALERT_TEXT[code]).join(' ');
}
export async function pollD2lMonitorOnce({ readStatus, publish, topic,
  previousSignature = '', nowMs = Date.now(), staleAfterMs = D2L_MONITOR_DEFAULTS.staleAfterMs } = {}) {
  if (typeof readStatus !== 'function' || typeof publish !== 'function') throw new Error('MONITOR_INPUT_INVALID');
  const safeTopic = validTopic(topic);
  let status;
  try { status = await readStatus(); } catch { status = null; }
  const alerts = assessD2lMonitorStatus(status, { nowMs, staleAfterMs });
  const signature = alerts.join(',');
  if (signature && signature !== previousSignature) {
    await publish({ topic: safeTopic, title: 'Ered Luin D2l monitor', message: d2lMonitorMessage(alerts), priority: 4 });
    return Object.freeze({ signature, published: true, alerts });
  }
  return Object.freeze({ signature, published: false, alerts });
}

async function publishNtfy({ topic, title, message, priority }) {
  const response = await fetch(`https://ntfy.sh/${validTopic(topic)}`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Title': title, 'X-Priority': String(priority) },
    body: message, signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error('MONITOR_NOTIFY_FAILED');
}
function readStatus(manifestPath) {
  const manifest = readRunManifest(manifestPath, ROOT);
  return publicRunStatus(manifest, collectionProcessIsAlive(manifest.pid));
}
function parseOptions(argv) {
  const options = { manifest: null, topic: process.env.ERED_LUIN_D2L_MONITOR_TOPIC || null,
    pollIntervalMs: D2L_MONITOR_DEFAULTS.pollIntervalMs, staleAfterMs: D2L_MONITOR_DEFAULTS.staleAfterMs };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help') { options.help = true; continue; }
    const names = new Map([['--manifest', 'manifest'], ['--topic', 'topic'], ['--poll-seconds', 'pollSeconds'], ['--stale-minutes', 'staleMinutes']]);
    const name = names.get(key);
    if (!name || seen.has(name) || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('MONITOR_USAGE');
    seen.add(name);
    const value = argv[++index];
    if (name === 'manifest' || name === 'topic') options[name] = value;
    else {
      const numeric = Number(value);
      if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(numeric)) throw new Error('MONITOR_USAGE');
      const duration = numeric * (name === 'pollSeconds' ? 1_000 : 60_000);
      if (!Number.isSafeInteger(duration)) throw new Error('MONITOR_USAGE');
      options[name === 'pollSeconds' ? 'pollIntervalMs' : 'staleAfterMs'] = duration;
    }
  }
  if (options.help) return options;
  if (!options.manifest || !options.topic || options.pollIntervalMs < 5_000 || options.staleAfterMs <= options.pollIntervalMs) throw new Error('MONITOR_USAGE');
  validTopic(options.topic);
  return options;
}
async function main() {
  let options;
  try { options = parseOptions(process.argv.slice(2)); }
  catch { process.stderr.write('Usage: node tools/d2l/monitor.mjs --manifest <external-manifest> [--topic <private-topic>] [--poll-seconds 30] [--stale-minutes 7]\n'); process.exitCode = 2; return; }
  if (options.help) {
    process.stdout.write('Read-only D2l monitor. It checks the local manifest/process and publishes generic alerts; it never starts or restarts collection.\n');
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let signature = '';
  let retryDelayMs = 0;
  while (!controller.signal.aborted) {
    try {
      const result = await pollD2lMonitorOnce({ readStatus: () => readStatus(options.manifest), publish: publishNtfy,
        topic: options.topic, previousSignature: signature, staleAfterMs: options.staleAfterMs });
      signature = result.signature;
      retryDelayMs = 0;
    } catch {
      process.stderr.write('D2l monitor could not publish an alert; retrying after a short backoff.\n');
      retryDelayMs = retryDelayMs === 0 ? options.pollIntervalMs : Math.min(5 * 60_000, retryDelayMs * 2);
    }
    await new Promise((done) => setTimeout(done, retryDelayMs || options.pollIntervalMs));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('D2l monitor stopped safely.\n'); process.exitCode = 1; });
}

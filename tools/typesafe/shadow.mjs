import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const registry = JSON.parse(readFileSync(new URL('./questions.json', import.meta.url), 'utf8'));
const endpoint = 'https://api.typesafe.ai/v1/systemone';
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const packetKeys = ['version', 'role', 'phase', 'task', 'scope', 'requirements', 'evidence', 'claim', 'sourceRevision', 'hardReviewRequired', 'publicSafeReviewed'];
const secretPattern = /nsn_[A-Za-z0-9]{16,}|apikey_[A-Za-z0-9_]{16,}|-----BEGIN .*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{16,}/i;
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validatePacket(packet) {
  if (!record(packet) || Object.keys(packet).length !== packetKeys.length ||
      Object.keys(packet).some((key) => !packetKeys.includes(key)) ||
      packet.version !== 1 || !['Astra', 'Luna'].includes(packet.role) ||
      !['preflight', 'postflight'].includes(packet.phase) ||
      packet.publicSafeReviewed !== true || typeof packet.hardReviewRequired !== 'boolean') {
    throw new Error('INVALID_PACKET');
  }
  for (const key of ['task', 'scope', 'claim', 'sourceRevision']) {
    if (typeof packet[key] !== 'string' || !packet[key].trim() || packet[key].length > 4000) throw new Error('INVALID_PACKET');
  }
  for (const key of ['requirements', 'evidence']) {
    if (!Array.isArray(packet[key]) || packet[key].length > 30 ||
        packet[key].some((item) => typeof item !== 'string' || !item.trim() || item.length > 4000)) throw new Error('INVALID_PACKET');
  }
  const serialized = JSON.stringify(packet);
  if (Buffer.byteLength(serialized) > 24000) throw new Error('PACKET_TOO_LARGE');
  if (secretPattern.test(serialized)) throw new Error('SUSPECTED_SECRET');
  return packet;
}

function validateResponse(body) {
  if (!record(body) || typeof body.model !== 'string' || !/^[a-zA-Z0-9._:-]{1,100}$/.test(body.model) ||
      !record(body.answers) || !record(body.usage)) throw new Error('INVALID_RESPONSE');
  const names = Object.keys(registry.questions);
  if (Object.keys(body.answers).length !== names.length) throw new Error('INVALID_RESPONSE');
  const answers = {};
  for (const name of names) {
    const value = body.answers[name];
    if (!record(value) || value.type !== 'noul' || typeof value.noul !== 'number' ||
        !Number.isFinite(value.noul) || value.noul < 0 || value.noul > 1) throw new Error('INVALID_RESPONSE');
    answers[name] = { type: 'noul', noul: value.noul };
  }
  const usage = {};
  for (const name of ['input_tokens', 'output_tokens']) {
    if (!Number.isSafeInteger(body.usage[name]) || body.usage[name] < 0) throw new Error('INVALID_RESPONSE');
    usage[name] = body.usage[name];
  }
  return { model: body.model, answers, usage };
}

async function readBoundedJson(response) {
  if (!response.body) throw new Error('INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) throw new Error('RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

// Development-only advisory tool: callers must curate the packet before invocation.
export async function evaluateShadow(packet, { live = false, apiKey, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  validatePacket(packet);
  const request = { model: 'jev-latest', state: packet, questions: registry.questions };
  const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const base = {
    mode: 'shadow', registryVersion: registry.version,
    registryHash: createHash('sha256').update(JSON.stringify(registry)).digest('hex'),
    requestHash, requestedModel: request.model, task: packet.task,
    role: packet.role, phase: packet.phase, sourceRevision: packet.sourceRevision,
    authority: 'NONE', reviewRequired: true, hardReviewRequired: packet.hardReviewRequired,
  };
  if (!live) return { ...base, status: 'DRY_RUN', requestsMade: 0 };
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('MISSING_API_KEY');
  const started = performance.now();
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!response.ok) return { ...base, status: 'UNAVAILABLE', requestsMade: 1, httpStatus: response.status, fallback: 'ASTRA_REVIEW', latencyMs: Math.round(performance.now() - started) };
    const result = validateResponse(await readBoundedJson(response));
    return { ...base, status: 'OBSERVED', requestsMade: 1, ...result, latencyMs: Math.round(performance.now() - started) };
  } catch {
    return { ...base, status: 'UNAVAILABLE', requestsMade: 1, fallback: 'ASTRA_REVIEW', latencyMs: Math.round(performance.now() - started) };
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2 || (args[1] && args[1] !== '--live')) throw new Error('USAGE: node tools/typesafe/shadow.mjs <reviewed-packet.json> [--live]');
  const packet = validatePacket(JSON.parse(readFileSync(args[0], 'utf8')));
  const live = args[1] === '--live';
  if (!live) { process.stdout.write(JSON.stringify(await evaluateShadow(packet), null, 2) + '\n'); return; }
  const directory = process.env.TYPESAFE_AUDIT_DIR;
  if (!directory || !isAbsolute(directory)) throw new Error('PRIVATE_AUDIT_DIRECTORY_REQUIRED');
  const rel = relative(projectRoot, resolve(directory));
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('AUDIT_DIRECTORY_MUST_BE_OUTSIDE_REPOSITORY');
  if (!process.env.TYPESAFE_API_KEY) throw new Error('MISSING_API_KEY');
  mkdirSync(directory, { recursive: true });
  const receiptPath = resolve(directory, randomUUID() + '.json');
  // Persist an attempt before network dispatch, including failures or uncertain termination.
  const dryRun = await evaluateShadow(packet);
  writeFileSync(receiptPath, JSON.stringify({ ...dryRun, status: 'PENDING', requestsMade: 1, startedAt: new Date().toISOString() }, null, 2), { flag: 'wx', mode: 0o600 });
  const result = await evaluateShadow(packet, { live, apiKey: process.env.TYPESAFE_API_KEY });
  writeFileSync(receiptPath, JSON.stringify({ ...result, completedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ ...result, receiptPath }, null, 2) + '\n');
  if (result.status !== 'OBSERVED') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('TypeSafe check failed; inspect the packet/configuration locally. No raw provider error is logged.\n'); process.exitCode = 1; });
}

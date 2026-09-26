import { describe, it, expect } from 'vitest';
import { evaluateShadow, registry, validatePacket } from './shadow.mjs';
import { readFileSync } from 'node:fs';

const packet = () => JSON.parse(readFileSync(new URL('./packet.example.json', import.meta.url), 'utf8'));
const result = () => ({ model: 'jev-test', answers: Object.fromEntries(Object.keys(registry.questions).map((id) => [id, { type: 'noul', noul: 0.1 }])), usage: { input_tokens: 100, output_tokens: 20 } });
const key = 'synthetic-test-value';
describe('TypeSafe advisory boundary', () => {
  it('defaults to zero requests without a credential', async () => {
    const value = await evaluateShadow(packet(), { fetchImpl: () => { throw new Error('must not run'); } });
    expect(value).toMatchObject({ status: 'DRY_RUN', requestsMade: 0, authority: 'NONE', reviewRequired: true });
  });
  it('requires an explicitly curated packet and rejects unknown fields', () => {
    expect(() => validatePacket({ ...packet(), publicSafeReviewed: false })).toThrow('INVALID_PACKET');
    expect(() => validatePacket({ ...packet(), rawHeaders: {} })).toThrow('INVALID_PACKET');
    expect(() => validatePacket({ ...packet(), evidence: ['nsn_' + 'x'.repeat(32)] })).toThrow('SUSPECTED_SECRET');
  });
  it('rejects oversized packets before any network request', async () => {
    await expect(evaluateShadow({ ...packet(), evidence: Array(30).fill('x'.repeat(4000)) }, { live: true, apiKey: key })).rejects.toThrow('PACKET_TOO_LARGE');
  });
  it('requires a key only for an explicit live invocation', async () => {
    await expect(evaluateShadow(packet(), { live: true })).rejects.toThrow('MISSING_API_KEY');
  });
  it('batches the registry at the fixed endpoint and strips untrusted response fields', async () => {
    let calls = 0;
    const value = await evaluateShadow({ ...packet(), hardReviewRequired: true }, { live: true, apiKey: key, fetchImpl: async (url, options) => {
      calls++;
      expect(url).toBe('https://api.typesafe.ai/v1/systemone');
      expect(options.redirect).toBe('error');
      expect(options.headers.Authorization).toBe('Bearer ' + key);
      expect(JSON.parse(options.body).questions).toEqual(registry.questions);
      return Response.json({ ...result(), secretEcho: key });
    } });
    expect(calls).toBe(1);
    expect(value).toMatchObject({ status: 'OBSERVED', authority: 'NONE', reviewRequired: true, hardReviewRequired: true, usage: { input_tokens: 100, output_tokens: 20 } });
    expect(JSON.stringify(value)).not.toContain(key);
    expect(value).not.toHaveProperty('confidence');
  });
  it('never retries HTTP failures or exposes provider response bodies', async () => {
    let calls = 0;
    const value = await evaluateShadow(packet(), { live: true, apiKey: key, fetchImpl: async () => {
      calls++;
      return new Response(key, { status: 429 });
    } });
    expect(calls).toBe(1);
    expect(value).toMatchObject({ status: 'UNAVAILABLE', httpStatus: 429, fallback: 'ASTRA_REVIEW', reviewRequired: true });
    expect(JSON.stringify(value)).not.toContain(key);
  });
  it('falls back on transport failures without exposing error objects', async () => {
    const value = await evaluateShadow(packet(), { live: true, apiKey: key, fetchImpl: async () => { throw new Error(key); } });
    expect(value.status).toBe('UNAVAILABLE');
    expect(JSON.stringify(value)).not.toContain(key);
  });
  it('rejects missing, mismatched, out-of-range answers and malformed usage', async () => {
    const variants = [result(), result(), result(), result()];
    delete variants[0].answers.evidence_gap;
    variants[1].answers.evidence_gap.noul = 2;
    variants[2].answers.evidence_gap.type = 'score';
    variants[3].usage.input_tokens = '100';
    for (const body of variants) {
      const value = await evaluateShadow(packet(), { live: true, apiKey: key, fetchImpl: async () => Response.json(body) });
      expect(value).toMatchObject({ status: 'UNAVAILABLE', reviewRequired: true });
    }
  });
  it('bounds response size and timeout without approving a gate', async () => {
    const oversized = await evaluateShadow(packet(), { live: true, apiKey: key, fetchImpl: async () => new Response('x'.repeat(65537)) });
    expect(oversized.status).toBe('UNAVAILABLE');
    const timeout = await evaluateShadow(packet(), { live: true, apiKey: key, timeoutMs: 5, fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('timeout')));
    }) });
    expect(timeout).toMatchObject({ status: 'UNAVAILABLE', authority: 'NONE', reviewRequired: true });
  });
});

import { describe, expect, it } from 'vitest';
import { D2E_BASE_CAPABILITY_METHOD_PLAN, D2E_BASE_PROBE_REQUEST_CEILING, runD2eBaseCapabilityProbe } from './d2-base-capability-probe.js';

describe('D2e offline Base capability probe', () => {
  it('runs the reviewed bounded method plan through an injected mock and redacts RPC values', async () => {
    const secret = '0xprivate-response-and-endpoint-secret';
    const calls: string[] = [];
    const result = await runD2eBaseCapabilityProbe({
      runId: 'd2e-probe-success',
      transport: async (method) => { calls.push(method); return { result: secret, providerUrl: secret, apiKey: secret }; },
    });
    expect(result).toMatchObject({ mode: 'DRY_RUN_MOCKED_TRANSPORT', requestCount: D2E_BASE_CAPABILITY_METHOD_PLAN.length,
      requestCeiling: D2E_BASE_PROBE_REQUEST_CEILING, supported: D2E_BASE_CAPABILITY_METHOD_PLAN.length, failed: 0, unsupported: 0 });
    expect(calls).toEqual(D2E_BASE_CAPABILITY_METHOD_PLAN.map((item) => item.method));
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('apiKey');
  });

  it('reports unsupported capabilities without exposing provider error details', async () => {
    const secret = 'account=private endpoint=https://secret.invalid';
    const result = await runD2eBaseCapabilityProbe({
      runId: 'd2e-probe-unsupported',
      transport: async () => ({ error: { code: -32601, message: secret } }),
    });
    expect(result.unsupported).toBe(D2E_BASE_CAPABILITY_METHOD_PLAN.length);
    expect(result.results.every((item) => item.status === 'UNSUPPORTED')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('stops sending requests at an exhausted finite budget', async () => {
    let calls = 0;
    const result = await runD2eBaseCapabilityProbe({
      runId: 'd2e-probe-budget',
      maxRequests: 2,
      transport: async () => { calls += 1; return { result: '0x1' }; },
    });
    expect(calls).toBe(2);
    expect(result).toMatchObject({ requestCount: 2, requestCeiling: 2, remainingRequests: 0, supported: 2 });
    expect(result.results.filter((item) => item.status === 'NOT_RUN')).toHaveLength(D2E_BASE_CAPABILITY_METHOD_PLAN.length - 2);
  });

  it('rejects any configured request ceiling above the fixed probe maximum', async () => {
    await expect(runD2eBaseCapabilityProbe({ maxRequests: D2E_BASE_PROBE_REQUEST_CEILING + 1, transport: async () => ({}) }))
      .rejects.toThrow('D2_BASE_PROBE_CONFIGURATION_INVALID');
  });
});

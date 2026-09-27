import { describe, expect, it, vi } from 'vitest';
import { createD1ApiClient, createD2ApiClient, d2bIdempotencyKey } from './api-client.js';

const unknownFixture = {
  label: 'SYNTHETIC G3C STATUS FIXTURE — NOT A CHAIN RECEIPT',
  status: {
    executionId: '00000000-0000-4000-8000-000000000001',
    inputAsset: 'USDC', requestedAmount: '4000000', permittedAmount: null,
    policyReason: 'SYNTHETIC_STATUS_EXAMPLE_ONLY', mode: 'LIVE_DISABLED',
    status: 'UNKNOWN', transactionHash: null, receipt: null, actualFeesUsdcMicros: null,
    evidenceProvenance: ['synthetic-fixture:d1'],
  },
};

describe('D1 dashboard API adapter', () => {
  it('consumes G3c status through the shared typed contract and keeps the fixture label', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(unknownFixture), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const result = await createD1ApiClient(fetcher as typeof fetch).g3cStatus('UNKNOWN');
    expect(result.label).toBe('SYNTHETIC G3C STATUS FIXTURE — NOT A CHAIN RECEIPT');
    expect(result.status.status).toBe('UNKNOWN');
    expect(result.status.mode).toBe('LIVE_DISABLED');
    expect(fetcher).toHaveBeenCalledWith('/v1/demo/g3c-status/unknown', undefined);
  });

  it('rejects untyped status data instead of displaying it as a G3c state', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ...unknownFixture, status: { ...unknownFixture.status, signed: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(createD1ApiClient(fetcher as typeof fetch).g3cStatus('UNKNOWN'))
      .rejects.toThrow('The API response failed contract validation.');
  });
});
describe('D2 production dashboard API adapter', () => {
  it('reads the production runtime and persisted Nansen evidence through distinct routes', async () => {
    const runtime = {
      service: 'ered-luin-api', status: 'degraded', appMode: 'PRODUCTION_READ_ONLY',
      paidNansenCallsEnabled: false, activeNansenCreditBudget: 0, liveExecutionEnabled: false,
      executionControls: { operatorAuthConfigured: false, signingEnabled: false, submissionEnabled: false, reviewedMode: false, browserWalletEnabled: false },
      nansenObservationStore: 'unconfigured', productionEvaluation: 'unconfigured',
      baseRpc: 'disabled', g3cStatusReader: 'configured', rpcRunBudget: null,
    };
    const evidence = { source: 'nansen', label: 'PERSISTED NANSEN OBSERVATIONS', observations: [], batches: [], freshness: 'missing' };
    const fetcher = vi.fn(async (path: RequestInfo | URL) => new Response(JSON.stringify(
      String(path) === '/v2/runtime' ? runtime : evidence,
    ), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = createD2ApiClient(fetcher as typeof fetch);

    expect((await client.runtime()).appMode).toBe('PRODUCTION_READ_ONLY');
    expect((await client.evidence()).source).toBe('nansen');
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/v2/runtime', '/v1/production/evidence']);
  });

  it('submits only the public wallet and requested amount to the D2 proposal route', async () => {
    const proposal = {
      proposalId: '00000000-0000-4000-8000-000000000101', createdAt: '2026-09-24T12:00:00.000Z',
      intent: {
        intentId: '00000000-0000-4000-8000-000000000101', walletAddress: '0x1111111111111111111111111111111111111111',
        chainId: 8453, sellAsset: 'USDC', buyAsset: 'WETH', amountIn: '4000000',
        issuedAt: '2026-09-24T12:00:00.000Z', expiresAt: '2026-09-24T12:01:00.000Z',
      },
      analysis: {
        source: 'DETERMINISTIC_EVIDENCE_RULES', version: 'd2-rule-v1', rationale: 'Offline client fixture only.',
        semanticStatus: 'NOT_CONFIGURED', semanticAuthority: 'NONE',
      },
      evidence: { source: 'nansen', label: 'PERSISTED NANSEN OBSERVATIONS', observations: [], observationIds: [], batches: [] },
    };
    const fetcher = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      expect(path).toBe('/v1/production/proposals');
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify(proposal), {
        status: 201, headers: { 'content-type': 'application/json' },
      });
    });
    await createD2ApiClient(fetcher as typeof fetch).proposal('0x1111111111111111111111111111111111111111', '4000000');

    expect(fetcher).toHaveBeenCalledWith('/v1/production/proposals', expect.objectContaining({ method: 'POST' }));
    const init = fetcher.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      walletAddress: '0x1111111111111111111111111111111111111111', requestedUsdcMicros: '4000000',
    });
  });
  it('uses restart-stable idempotency keys and distinct authenticated execution routes', async () => {
    const proposalId = '00000000-0000-4000-8000-000000000201';
    const operationId = '00000000-0000-4000-8000-000000000202';
    const sessionId = '00000000-0000-4000-8000-000000000203';
    const response = {
      proposalId, executionId: proposalId, operationId, sessionId, kind: 'SWAP', status: 'SIGNED_OUTBOX',
      permittedAmount: '4000000', transactionHash: '0x' + 'ab'.repeat(32), submissionAttempts: 0,
      receiptOutcome: null, receiptBlockNumber: null, actualFeesUsdcMicros: null, replayed: false,
    };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(response), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const client = createD2ApiClient(fetcher as typeof fetch);
    const prepareKey = await d2bIdempotencyKey('PREPARE_SIGN', operationId);
    expect(await d2bIdempotencyKey('PREPARE_SIGN', operationId)).toBe(prepareKey);
    expect(await d2bIdempotencyKey('SUBMIT', operationId, 1)).not.toBe(prepareKey);
    await client.prepareSign(proposalId, operationId, sessionId, prepareKey);
    await client.submit(proposalId, operationId, await d2bIdempotencyKey('SUBMIT', operationId));
    await client.executionStatus(proposalId, operationId);
    await client.reconcile(proposalId, operationId, await d2bIdempotencyKey('RECONCILE', operationId));

    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      '/v1/production/executions/prepare-sign', '/v1/production/executions/submit',
      '/v1/production/executions/' + proposalId + '/' + operationId,
      '/v1/production/executions/reconcile',
    ]);
    for (const [, init] of fetcher.mock.calls) {
      if (!init) continue;
      expect(init.credentials).toBe('same-origin');
      expect(JSON.stringify(init.body ?? {})).not.toContain('signedBytesHex');
    }
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      proposalId, operationId, sessionId, idempotencyKey: prepareKey,
    });
  });
});

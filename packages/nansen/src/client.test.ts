import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CreditLedgerError,
  NANSEN_COST_PROFILE_VERSION,
  type LedgerOptions,
  type NansenCreditLedger,
  type NansenHttpRequest,
  type NansenHttpResponse,
  type NansenHttpTransport,
  createNansenClient,
  initializeCreditLedger,
  openCreditLedger,
} from './index.js';
import { createGuardedPost } from './client-core.js';

const API_KEY = 'synthetic-test-api-key-not-a-credential';
const screenerFixture: unknown = JSON.parse(readFileSync(
  new URL('../fixtures/token-screener.synthetic.json', import.meta.url),
  'utf8',
));
const flowFixture: unknown = JSON.parse(readFileSync(
  new URL('../fixtures/flow-intelligence.synthetic.json', import.meta.url),
  'utf8',
));
const netflowFixture: unknown = JSON.parse(readFileSync(
  new URL('../fixtures/smart-money-netflow.synthetic.json', import.meta.url),
  'utf8',
));

type FakeReply = NansenHttpResponse | Error | ((request: NansenHttpRequest) => Promise<NansenHttpResponse>);

let root: string;
let ledgers: NansenCreditLedger[];

function ledgerOptions(databasePath: string, limitCredits = 20, overrides: Partial<LedgerOptions> = {}): LedgerOptions {
  return {
    databasePath,
    budgetId: 'g1b-synthetic-budget',
    limitCredits,
    costProfileVersion: NANSEN_COST_PROFILE_VERSION,
    clock: () => new Date('2026-09-23T12:00:00.000Z'),
    ...overrides,
  };
}

function createLedger(limitCredits = 20, name = 'ledger.sqlite'): NansenCreditLedger {
  const ledger = initializeCreditLedger(ledgerOptions(join(root, name), limitCredits));
  ledgers.push(ledger);
  return ledger;
}

function response(body: unknown, status = 200, headers: Record<string, string> = {}): NansenHttpResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  if (text === undefined) throw new Error('Test response did not serialize.');
  return {
    status,
    headers: Object.freeze(headers),
    body: new TextEncoder().encode(text),
  };
}

function fakeTransport(replies: FakeReply[] = [], beforeDispatch?: () => void): {
  readonly transport: NansenHttpTransport;
  readonly requests: NansenHttpRequest[];
} {
  const requests: NansenHttpRequest[] = [];
  const transport: NansenHttpTransport = async (request) => {
    requests.push(request);
    beforeDispatch?.();
    const reply = replies.shift();
    if (reply === undefined) throw new Error('No synthetic reply was queued.');
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'function') return reply(request);
    return reply;
  };
  return { transport, requests };
}

function client(
  ledger: NansenCreditLedger,
  transport: NansenHttpTransport,
  overrides: Partial<Parameters<typeof createNansenClient>[0]> = {},
) {
  return createNansenClient({
    ledger,
    enabled: true,
    apiKey: API_KEY,
    transport,
    ...overrides,
  });
}

function fixtureResponse(fixture: unknown, cost: number, id: string): NansenHttpResponse {
  return response(fixture, 200, {
    'X-Request-Id': id,
    'X-Nansen-Credits-Used': String(cost),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ered-luin-g1b-'));
  ledgers = [];
});

afterEach(() => {
  for (const ledger of ledgers) {
    try { ledger.close(); } catch { /* A test may have already closed this connection. */ }
  }
  rmSync(root, { recursive: true, force: true });
});

describe('G1b guarded Nansen client and adapters', () => {
  it('fails closed when disabled, missing a key, at zero budget, or given an unsupported operation', async () => {
    const ledger = createLedger(0);
    let calls = 0;
    const transport: NansenHttpTransport = async () => {
      calls += 1;
      return response(screenerFixture);
    };

    const disabled = createNansenClient({ ledger, apiKey: API_KEY, transport });
    expect((await disabled.tokenScreener()).failure?.code).toBe('DISABLED');

    const noKey = client(ledger, transport, { apiKey: undefined });
    expect((await noKey.tokenScreener()).failure?.code).toBe('CREDENTIAL_MISSING');

    const noBudget = client(ledger, transport);
    expect((await noBudget.tokenScreener()).failure).toMatchObject({
      code: 'RESERVATION_DENIED',
      ledgerCode: 'BUDGET_EXHAUSTED',
    });

    const guarded = createGuardedPost({ ledger, enabled: true, apiKey: API_KEY, transport });
    const unsupported = guarded.post as unknown as (
      operation: string,
      body: Readonly<Record<string, unknown>>,
      parse: (value: unknown) => unknown,
    ) => Promise<unknown>;
    await expect(unsupported('NOT_A_NANSEN_OPERATION', {}, (value) => value)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(calls).toBe(0);
    expect(ledger.getSnapshot()).toMatchObject({ allocatedCredits: 0, pendingAttemptCount: 0 });
  });

  it('opens no client request when the ledger is missing, corrupt, or mismatched', async () => {
    let calls = 0;
    const transport: NansenHttpTransport = async () => {
      calls += 1;
      return response(screenerFixture);
    };
    const zeroLedger = createLedger(0, 'zero-before-invalid-ledgers.sqlite');
    expect((await client(zeroLedger, transport).tokenScreener()).failure?.ledgerCode).toBe('BUDGET_EXHAUSTED');
    const missing = ledgerOptions(join(root, 'missing.sqlite'));
    expect(() => openCreditLedger(missing)).toThrow(CreditLedgerError);

    const corruptPath = join(root, 'corrupt.sqlite');

    writeFileSync(corruptPath, 'not a sqlite database');
    expect(() => openCreditLedger(ledgerOptions(corruptPath))).toThrow(CreditLedgerError);

    const original = initializeCreditLedger(ledgerOptions(join(root, 'mismatch.sqlite')));
    original.close();
    expect(() => openCreditLedger(ledgerOptions(join(root, 'mismatch.sqlite'), 20, {
      budgetId: 'different-synthetic-budget',
    }))).toThrow(CreditLedgerError);
    expect(calls).toBe(0);
  });

  it('maps the three fixed endpoints and costs, records charges, and grants before transport', async () => {
    const ledger = createLedger(7);
    const replies = [
      fixtureResponse(screenerFixture, 1, 'synthetic-screen-1'),
      fixtureResponse(flowFixture, 1, 'synthetic-flow-1'),
      fixtureResponse(netflowFixture, 5, 'synthetic-netflow-1'),
    ];
    const fake = fakeTransport(replies, () => {
      expect(ledger.getSnapshot().pendingAttemptCount).toBeGreaterThanOrEqual(1);
    });
    const api = client(ledger, fake.transport);

    const screener = await api.tokenScreener({ timeframe: '24h', per_page: 100 });
    const flow = await api.flowIntelligence({ asset: 'WETH', timeframe: '1d' });
    const netflow = await api.smartMoneyNetflow({ per_page: 100 });

    expect(screener.completeness).toBe('complete');
    expect(screener.failure).toBeNull();
    expect(screener.data[0]?.token_symbol).toBe('USDC');
    expect(screener.data[1]?.token_symbol).toBe('WETH');
    expect(flow).toMatchObject({ completeness: 'complete', warningsAvailable: true, failure: null });
    expect(flow.data[0]).toMatchObject({ asset: 'WETH', chain: 'base', smart_trader_net_flow_usd: 12_000 });
    expect(netflow).toMatchObject({ completeness: 'complete', failure: null });
    expect(netflow.data).toHaveLength(2);

    expect(fake.requests.map((request) => request.url)).toEqual([
      'https://api.nansen.ai/api/v1/token-screener',
      'https://api.nansen.ai/api/v1/tgm/flow-intelligence',
      'https://api.nansen.ai/api/v1/smart-money/netflow',
    ]);
    for (const request of fake.requests) {
      expect(request.method).toBe('POST');
      expect(request.redirect).toBe('error');
      expect(request.headers.apikey).toBe(API_KEY);
      expect(request.headers['content-type']).toBe('application/json');
      expect(Object.keys(request.headers).sort()).toEqual(['accept', 'apikey', 'content-type']);
      expect(request.url.startsWith('https://api.nansen.ai/')).toBe(true);
    }

    const screenerBody = JSON.parse(fake.requests[0]!.body) as Record<string, unknown>;
    expect(screenerBody).toMatchObject({
      chains: ['base'],
      timeframe: '24h',
      pagination: { page: 1, per_page: 100 },
      filters: {
        token_address: [
          '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          '0x4200000000000000000000000000000000000006',
        ],
        include_stablecoins: true,
        include_native_tokens: true,
      },
    });
    expect(screenerBody).not.toHaveProperty('date');

    const flowBody = JSON.parse(fake.requests[1]!.body) as Record<string, unknown>;
    expect(flowBody).toEqual({
      chain: 'base',
      token_address: '0x4200000000000000000000000000000000000006',
      timeframe: '1d',
    });
    const netflowBody = JSON.parse(fake.requests[2]!.body) as Record<string, unknown>;
    expect(netflowBody).toMatchObject({
      chains: ['base'],
      filters: { include_stablecoins: true, include_native_tokens: true },
      pagination: { page: 1, per_page: 100 },
    });
    expect(JSON.stringify(fake.requests)).toContain(API_KEY);

    expect(ledger.getSnapshot()).toMatchObject({ limitCredits: 7, allocatedCredits: 7, remainingCredits: 0 });
    expect(ledger.getAttempt(screener.pageReferences[0]!.attemptId)).toMatchObject({
      operation: 'TOKEN_SCREENER',
      reservedCredits: 1,
      reportedChargedCredits: 1,
      outcome: 'SUCCESS',
    });
    expect(ledger.getAttempt(flow.pageReferences[0]!.attemptId)).toMatchObject({
      operation: 'FLOW_INTELLIGENCE',
      reservedCredits: 1,
      reportedChargedCredits: 1,
      outcome: 'SUCCESS',
    });
    expect(ledger.getAttempt(netflow.pageReferences[0]!.attemptId)).toMatchObject({
      operation: 'SMART_MONEY_NETFLOW',
      reservedCredits: 5,
      reportedChargedCredits: 5,
      outcome: 'SUCCESS',
    });
  });

  it('treats warning-free non-paginated flow aggregates as complete and warnings as partial', async () => {
    const ledger = createLedger(2);
    const warningFixture = { ...structuredClone(flowFixture), warnings: ['synthetic partial-result warning'] };
    const fake = fakeTransport([fixtureResponse(warningFixture, 1, 'synthetic-flow-warning')]);
    const result = await client(ledger, fake.transport).flowIntelligence({ asset: 'WETH', timeframe: '1h' });
    expect(result.completeness).toBe('incomplete');
    expect(result.warnings).toEqual(['synthetic partial-result warning']);
    expect(fake.requests).toHaveLength(1);
  });

  it('rejects deprecated or unsupported query fields before reserving', async () => {
    const ledger = createLedger();
    const fake = fakeTransport([fixtureResponse(screenerFixture, 1, 'synthetic-no-call')]);
    const api = client(ledger, fake.transport);
    const deprecated = { timeframe: '1h' as const, date: { from: '2020-01-01' } };
    await expect(api.tokenScreener(deprecated)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(api.smartMoneyNetflow({ per_page: 1_001 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const unsupportedAsset = { asset: 'OTHER' as const };
    await expect(api.flowIntelligence(unsupportedAsset)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(fake.requests).toHaveLength(0);
    expect(ledger.getSnapshot()).toMatchObject({ allocatedCredits: 0, pendingAttemptCount: 0 });
  });

  it('uses a separate durable attempt for each page and stops on the explicit last-page signal', async () => {
    const ledger = createLedger(2);
    const first = structuredClone(screenerFixture) as {
      data: unknown[];
      pagination: { page: number; per_page: number; is_last_page: boolean };
    };
    first.pagination.is_last_page = false;
    const second = structuredClone(screenerFixture) as {
      data: unknown[];
      pagination: { page: number; per_page: number; is_last_page: boolean };
    };
    second.pagination = { page: 2, per_page: 100, is_last_page: true };
    const fake = fakeTransport([
      fixtureResponse(first, 1, 'synthetic-page-1'),
      fixtureResponse(second, 1, 'synthetic-page-2'),
    ]);
    const api = client(ledger, fake.transport, { maxPages: 2 });
    const result = await api.tokenScreener({ per_page: 100 });

    expect(result.completeness).toBe('complete');
    expect(result.pagesRead).toBe(2);
    expect(result.pageReferences.map(({ page }) => page)).toEqual([1, 2]);
    expect(result.pageReferences[0]?.attemptId).not.toBe(result.pageReferences[1]?.attemptId);
    expect(JSON.parse(fake.requests[1]!.body)).toMatchObject({ pagination: { page: 2 } });
    expect(ledger.getSnapshot()).toMatchObject({ allocatedCredits: 2, pendingAttemptCount: 0 });
    for (const reference of result.pageReferences) {
      expect(ledger.getAttempt(reference.attemptId)?.outcome).toBe('SUCCESS');
    }
  });

  it('surfaces a failed later page as incomplete with both page references and retained allocations', async () => {
    const ledger = createLedger(10);
    const first = structuredClone(netflowFixture) as {
      data: unknown[];
      pagination: { page: number; per_page: number; is_last_page: boolean };
    };
    first.pagination.is_last_page = false;
    const fake = fakeTransport([
      fixtureResponse(first, 5, 'synthetic-netflow-page-1'),
      response('synthetic provider error body', 429, {
        'X-Request-Id': 'synthetic-netflow-page-2',
        'X-Nansen-Credits-Used': '0',
      }),
    ]);
    const api = client(ledger, fake.transport, { maxPages: 2 });
    const result = await api.smartMoneyNetflow();

    expect(result.completeness).toBe('incomplete');
    expect(result.failure).toMatchObject({ code: 'HTTP_ERROR', status: 429 });
    expect(result.pagesRead).toBe(1);
    expect(result.data).toHaveLength(2);
    expect(result.pageReferences).toHaveLength(2);
    expect(result.pageReferences[0]).toMatchObject({ page: 1, received: true, status: 200 });
    expect(result.pageReferences[1]).toMatchObject({
      page: 2,
      received: false,
      status: 429,
      providerRequestId: 'synthetic-netflow-page-2',
      chargedCredits: 0,
    });
    expect(ledger.getSnapshot()).toMatchObject({ allocatedCredits: 10, pendingAttemptCount: 0 });
    expect(ledger.getAttempt(result.pageReferences[1]!.attemptId)).toMatchObject({
      outcome: 'HTTP_ERROR',
      httpStatus: 429,
      reportedChargedCredits: 0,
      reservedCredits: 5,
    });
  });

  it('does not dispatch again when a duplicate attempt ID receives no dispatch grant', async () => {
    const ledger = createLedger();
    const fake = fakeTransport([response({ ok: true }, 200)]);
    const guarded = createGuardedPost(
      { ledger, enabled: true, apiKey: API_KEY, transport: fake.transport },
      () => 'same-synthetic-attempt',
    );
    await guarded.post('TOKEN_SCREENER', { chains: ['base'] }, (value) => value);
    await expect(
      guarded.post('TOKEN_SCREENER', { chains: ['base'] }, (value) => value),
    ).rejects.toMatchObject({ code: 'DUPLICATE_ATTEMPT' });
    expect(fake.requests).toHaveLength(1);
    expect(ledger.getSnapshot()).toMatchObject({ allocatedCredits: 1, pendingAttemptCount: 0 });
  });

  it('makes concurrent adapters share the same durable budget', async () => {
    const ledger = createLedger(1);
    const fake = fakeTransport([fixtureResponse(screenerFixture, 1, 'synthetic-concurrent')]);
    const api = client(ledger, fake.transport);
    const [screener, flow] = await Promise.all([
      api.tokenScreener(),
      api.flowIntelligence({ asset: 'USDC' }),
    ]);

    expect(fake.requests).toHaveLength(1);
    expect([screener.failure?.ledgerCode, flow.failure?.ledgerCode]).toContain('BUDGET_EXHAUSTED');
    expect([screener.failure, flow.failure].filter((failure) => failure === null)).toHaveLength(1);
    expect(ledger.getSnapshot()).toMatchObject({ allocatedCredits: 1, remainingCredits: 0 });
  });

  it('retains HTTP, transport, timeout, cancellation, size, and parse failures without leaking secrets', async () => {
    const cases: Array<{
      name: string;
      replies: FakeReply[];
      expectedCode: string;
      expectedOutcome: string;
      options?: Partial<Parameters<typeof createNansenClient>[0]>;
      signal?: AbortSignal;
    }> = [
      {
        name: '429',
        replies: [response('private body ' + API_KEY, 429, { 'X-Nansen-Credits-Used': '0' })],
        expectedCode: 'HTTP_ERROR',
        expectedOutcome: 'HTTP_ERROR',
      },
      {
        name: '5xx',
        replies: [response('provider body', 503, { 'X-Nansen-Credits-Used': '1' })],
        expectedCode: 'HTTP_ERROR',
        expectedOutcome: 'HTTP_ERROR',
      },
      {
        name: 'transport error',
        replies: [new Error('transport internals contain ' + API_KEY)],
        expectedCode: 'TRANSPORT_ERROR',
        expectedOutcome: 'TRANSPORT_ERROR',
      },
      {
        name: 'timeout',
        replies: [async () => new Promise<NansenHttpResponse>(() => {})],
        expectedCode: 'TIMEOUT',
        expectedOutcome: 'TRANSPORT_ERROR',
        options: { timeoutMs: 5 },
      },
      {
        name: 'malformed JSON',
        replies: [response('not-json ' + API_KEY, 200, { 'X-Nansen-Credits-Used': '1' })],
        expectedCode: 'INVALID_RESPONSE',
        expectedOutcome: 'RESPONSE_ERROR',
      },
      {
        name: 'malformed schema',
        replies: [response({
          data: [{ token_symbol: 'NO_IDENTITY' }],
          pagination: { page: 1, is_last_page: true },
        }, 200, { 'X-Nansen-Credits-Used': '1' })],
        expectedCode: 'INVALID_RESPONSE',
        expectedOutcome: 'RESPONSE_ERROR',
      },
      {
        name: 'oversized response',
        replies: [response(screenerFixture, 200, { 'X-Nansen-Credits-Used': '1' })],
        expectedCode: 'RESPONSE_TOO_LARGE',
        expectedOutcome: 'RESPONSE_ERROR',
        options: { maxResponseBytes: 32 },
      },
    ];

    for (const testCase of cases) {
      const ledger = createLedger(10, testCase.name.replaceAll(' ', '-') + '.sqlite');
      const fake = fakeTransport([...testCase.replies]);
      const api = client(ledger, fake.transport, testCase.options);
      const result = await api.tokenScreener(undefined, testCase.signal ? { signal: testCase.signal } : undefined);
      expect(result.failure?.code, testCase.name).toBe(testCase.expectedCode);
      const reference = result.pageReferences[0];
      expect(reference, testCase.name).toBeDefined();
      const attempt = ledger.getAttempt(reference!.attemptId);
      expect(attempt?.outcome, testCase.name).toBe(testCase.expectedOutcome);
      expect(attempt?.reservedCredits, testCase.name).toBe(1);
      expect(JSON.stringify(result)).not.toContain(API_KEY);
      expect(JSON.stringify(attempt)).not.toContain(API_KEY);
      expect(attempt?.requestFingerprint).toMatch(/^[0-9a-f]{64}$/u);
      if (testCase.name === '429') expect(attempt?.reportedChargedCredits).toBe(0);
      if (testCase.name === 'oversized response') expect(attempt?.reportedChargedCredits).toBe(1);
    }

    const cancelledLedger = createLedger(10, 'cancelled.sqlite');
    const controller = new AbortController();
    const cancelledFake = fakeTransport([
      async () => {
        controller.abort();
        return new Promise<NansenHttpResponse>(() => {});
      },
    ]);
    const cancelledApi = client(cancelledLedger, cancelledFake.transport);
    const cancelled = await cancelledApi.tokenScreener(undefined, { signal: controller.signal });
    expect(cancelled.failure?.code).toBe('CANCELLED');
    expect(cancelledLedger.getAttempt(cancelled.pageReferences[0]!.attemptId)?.outcome).toBe('CANCELLED');
  });

  it('marks missing pagination and missing provider metrics as unknown instead of inventing values', async () => {
    const ledger = createLedger();
    const partial = {
      data: [{
        chain: 'base',
        token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        token_symbol: 'USDC',
        market_cap_usd: null,
      }],
      pagination: { page: 1, per_page: 100 },
    };
    const fake = fakeTransport([fixtureResponse(partial, 1, 'synthetic-no-last-page')]);
    const result = await client(ledger, fake.transport).tokenScreener();
    expect(result.completeness).toBe('unknown');
    expect(result.data[0]).toMatchObject({
      price_usd: null,
      market_cap_usd: null,
      liquidity: null,
      netflow: null,
    });
    expect(result.unavailableFields).toContain('data.price_usd');
    expect(result.pageReferences[0]?.received).toBe(true);
  });

  it('halts new dispatch after a documented actual charge exceeds the reservation estimate', async () => {
    const ledger = createLedger(20);
    const fake = fakeTransport([
      fixtureResponse(netflowFixture, 6, 'synthetic-overrun'),
      fixtureResponse(screenerFixture, 1, 'must-not-dispatch'),
    ]);
    const api = client(ledger, fake.transport);
    const first = await api.smartMoneyNetflow();
    const blocked = await api.tokenScreener();
    expect(first.failure).toBeNull();
    expect(blocked.failure).toMatchObject({
      code: 'RESERVATION_DENIED',
      ledgerCode: 'ACCOUNTING_HALTED',
    });
    expect(fake.requests).toHaveLength(1);
    expect(ledger.getSnapshot()).toMatchObject({
      allocatedCredits: 6,
      reconciliationRequired: true,
      haltReason: 'CHARGE_OVERRUN',
    });
  });
});

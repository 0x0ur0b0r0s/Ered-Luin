import { describe, expect, it } from 'vitest';
import { buildD2jDiagnosticPlan } from './diagnostic-plan.mjs';

describe('D2j next diagnostic proposal', () => {
  it('is a one-page, zero-retry, zero-dispatch dry run for the smallest useful missing policy evidence', () => {
    const plan = buildD2jDiagnosticPlan();
    expect(plan).toMatchObject({ mode: 'DRY_RUN_ONLY', providerCalls: 0, activeBudgetCredits: 0,
      dispatchAuthorized: false, requiresSeparateAuthorization: true });
    expect(plan.request).toMatchObject({ method: 'POST', endpoint: '/api/v1/token-screener', maxPages: 1, maxRetries: 0,
      worstCaseCredits: { pro: 1, free: 1 }, totalWorstCaseCredits: { pro: 1, free: 1 },
      body: { chains: ['base'], timeframe: '1h', pagination: { page: 1, per_page: 100 },
        filters: { token_address: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', '0x4200000000000000000000000000000000000006'],
          include_stablecoins: true, include_native_tokens: true } } });
  });
});

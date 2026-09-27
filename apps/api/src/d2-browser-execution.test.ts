import { describe, expect, it, vi } from 'vitest';
import type { D2ProductionService } from './d2-production.js';
import type { G3cExecutionStore } from './g3c-execution-store.js';
import type { G3cReadOnlyBaseProvider } from './g3c-base-provider.js';
import { createD2BrowserExecutionService } from './d2-browser-execution.js';

const request = { proposalId: '00000000-0000-4000-8000-000000000001',
  operationId: '00000000-0000-4000-8000-000000000002', sessionId: '00000000-0000-4000-8000-000000000003' };

describe('D2 browser-wallet activation boundary', () => {
  it('keeps browser submission disabled without consulting evidence, execution state, or Base RPC', async () => {
    const production = {
      proposal: vi.fn(), evaluation: vi.fn(), evidence: vi.fn(), simulation: vi.fn(),
    } as unknown as D2ProductionService;
    const store = {
      getWorkflow: vi.fn(), prepareBrowserWallet: vi.fn(), armBrowserWalletSubmission: vi.fn(),
    } as unknown as G3cExecutionStore;
    const provider = { account: vi.fn(), verifyTransaction: vi.fn(), receipt: vi.fn() } as unknown as G3cReadOnlyBaseProvider;
    const service = createD2BrowserExecutionService({ production, store, provider, enabled: false,
      clock: () => new Date('2026-09-27T16:00:00.000Z') });

    expect(() => service.prepare(request)).toThrow('D2_BROWSER_WALLET_DISABLED');
    await expect(service.begin(request)).rejects.toThrow('D2_BROWSER_WALLET_DISABLED');
    expect(production.proposal).not.toHaveBeenCalled();
    expect(production.evaluation).not.toHaveBeenCalled();
    expect(production.evidence).not.toHaveBeenCalled();
    expect(production.simulation).not.toHaveBeenCalled();
    expect(store.prepareBrowserWallet).not.toHaveBeenCalled();
    expect(store.armBrowserWalletSubmission).not.toHaveBeenCalled();
    expect(provider.account).not.toHaveBeenCalled();
  });
});

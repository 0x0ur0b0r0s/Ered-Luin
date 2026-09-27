import { describe, expect, it, vi } from 'vitest';
import {
  WalletProviderDiscovery, connectBrowserWallet, isBaseWalletChain, parseWalletAccounts,
  parseWalletChainId, safeWalletError, sendBrowserWalletTransaction, subscribeWalletEvents, switchBrowserWalletToBase,
  walletAccountMatchesSession, type Eip1193Provider, type WalletDiscoveryTarget,
} from './browser-wallet.js';
import type { G3bUnsignedTransaction } from '@ered-luin/contracts';

const ACCOUNT_A = '0x1111111111111111111111111111111111111111';
const ACCOUNT_B = '0x2222222222222222222222222222222222222222';

function makeProvider(chainId = '0x2105') {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const request = vi.fn(async ({ method }: { readonly method: string; readonly params?: readonly unknown[] }): Promise<unknown> => {
    if (method === 'eth_requestAccounts') return [ACCOUNT_A, ACCOUNT_B];
    if (method === 'eth_chainId') return chainId;
    if (method === 'wallet_switchEthereumChain') return null;
    throw Object.assign(new Error('unsupported'), { code: 4200 });
  });
  const provider: Eip1193Provider = {
    request,
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
  };
  return {
    provider,
    request,
    emit(event: string, value: unknown) { for (const listener of listeners.get(event) ?? []) listener(value); },
    listenerCount(event: string) { return listeners.get(event)?.size ?? 0; },
  };
}

function announce(target: EventTarget, info: { uuid: string; name: string; rdns: string }, provider: Eip1193Provider) {
  const event = new Event('eip6963:announceProvider');
  Object.defineProperty(event, 'detail', { value: { info, provider } });
  target.dispatchEvent(event);
}

class DiscoveryTarget extends EventTarget implements WalletDiscoveryTarget {
  ethereum?: Eip1193Provider;
}

describe('read-only EIP-1193 browser wallet connection', () => {
  it('discovers multiple EIP-6963 providers without selecting or requesting accounts', () => {
    const target = new DiscoveryTarget();
    const rabby = makeProvider();
    const brave = makeProvider();
    target.addEventListener('eip6963:requestProvider', () => {
      announce(target, { uuid: '11111111-1111-4111-8111-111111111111', name: 'Rabby Wallet', rdns: 'io.rabby' }, rabby.provider);
      announce(target, { uuid: '22222222-2222-4222-8222-222222222222', name: 'Brave Wallet', rdns: 'com.brave.wallet' }, brave.provider);
    });
    const seen: readonly string[][] = [];
    const discovery = new WalletProviderDiscovery(target);
    let names: readonly string[] = [];
    discovery.subscribe((choices) => { names = choices.map((choice) => choice.name); });
    discovery.requestProviders();
    expect(names).toEqual(['Brave Wallet', 'Rabby Wallet']);
    expect(rabby.request).not.toHaveBeenCalled();
    expect(brave.request).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('uses legacy injected providers only as explicit fallback choices', () => {
    const target = new DiscoveryTarget();
    const first = makeProvider();
    const second = makeProvider();
    target.ethereum = Object.assign(first.provider, { providers: [first.provider, second.provider] });
    const discovery = new WalletProviderDiscovery(target);
    let choices: readonly { name: string; source: string }[] = [];
    discovery.subscribe((value) => { choices = value; });
    discovery.requestProviders();
    expect(choices.map((choice) => choice.source)).toEqual(['legacy', 'legacy']);
    expect(choices.map((choice) => choice.name)).toEqual(['Injected EVM wallet 1', 'Injected EVM wallet 2']);
    expect(first.request).not.toHaveBeenCalled();
    expect(second.request).not.toHaveBeenCalled();
  });

  it('requests account visibility only when connect is explicitly invoked and validates Base chain', async () => {
    const wallet = makeProvider();
    const result = await connectBrowserWallet(wallet.provider);
    expect(result).toEqual({ accounts: [ACCOUNT_A, ACCOUNT_B], chainId: 8453 });
    expect(wallet.request.mock.calls.map(([request]) => request.method)).toEqual(['eth_requestAccounts', 'eth_chainId']);
    expect(wallet.request.mock.calls.some(([request]) => request.method === 'eth_sendTransaction')).toBe(false);
    expect(isBaseWalletChain(result.chainId)).toBe(true);
  });

  it('rejects malformed account lists and never treats the wrong chain as an approved session', async () => {
    expect(parseWalletAccounts([ACCOUNT_A, '0xbroken'])).toBeNull();
    expect(parseWalletChainId('8453')).toBeNull();
    expect(parseWalletChainId('0x2105')).toBe(8453);
    expect(isBaseWalletChain(1)).toBe(false);
    expect(walletAccountMatchesSession(ACCOUNT_A, ACCOUNT_A, 1)).toBe(false);
    expect(walletAccountMatchesSession(ACCOUNT_B, ACCOUNT_A, 8453)).toBe(false);
    expect(walletAccountMatchesSession(ACCOUNT_A, ACCOUNT_A.toUpperCase().replace('0X', '0x'), 8453)).toBe(true);
  });

  it('switches to Base only when its explicit helper is called and verifies the resulting chain', async () => {
    const wallet = makeProvider();
    await expect(switchBrowserWalletToBase(wallet.provider)).resolves.toBe(8453);
    expect(wallet.request.mock.calls.map(([request]) => request.method)).toEqual(['wallet_switchEthereumChain', 'eth_chainId']);
  });

  it('forwards account, chain, and disconnect changes and releases listeners', () => {
    const wallet = makeProvider();
    const handlers = { accountsChanged: vi.fn(), chainChanged: vi.fn(), disconnect: vi.fn() };
    const unsubscribe = subscribeWalletEvents(wallet.provider, handlers);
    expect(unsubscribe).not.toBeNull();
    wallet.emit('accountsChanged', [ACCOUNT_B]);
    wallet.emit('chainChanged', '0x1');
    wallet.emit('disconnect', { code: 4900 });
    expect(handlers.accountsChanged).toHaveBeenCalledWith([ACCOUNT_B]);
    expect(handlers.chainChanged).toHaveBeenCalledWith('0x1');
    expect(handlers.disconnect).toHaveBeenCalledWith({ code: 4900 });
    unsubscribe?.();
    expect(wallet.listenerCount('accountsChanged')).toBe(0);
    expect(wallet.listenerCount('chainChanged')).toBe(0);
    expect(wallet.listenerCount('disconnect')).toBe(0);
  });

  it('sends only the exact EIP-1559 transaction after rechecking Base account and chain', async () => {
    const wallet = makeProvider();
    const hash = '0x' + 'a'.repeat(64);
    wallet.request.mockImplementation(async ({ method }) => {
      if (method === 'eth_accounts') return [ACCOUNT_A];
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_sendTransaction') return hash;
      throw new Error('unexpected wallet method');
    });
    const transaction: G3bUnsignedTransaction = {
      version: 1, type: 'EIP1559', chainId: 8453, from: ACCOUNT_A,
      to: '0x3333333333333333333333333333333333333333', data: '0x1234', valueWei: '0',
      nonce: '2', gasLimit: '21000', maxFeePerGasWei: '100', maxPriorityFeePerGasWei: '3', accessList: [],
    };
    await expect(sendBrowserWalletTransaction(wallet.provider, transaction)).resolves.toBe(hash);
    expect(wallet.request.mock.calls.map(([request]) => request.method)).toEqual(['eth_accounts', 'eth_chainId', 'eth_sendTransaction']);
    expect(wallet.request.mock.calls[2]?.[0].params).toEqual([{
      type: '0x2', from: ACCOUNT_A, to: transaction.to, data: transaction.data,
      value: '0x0', nonce: '0x2', gas: '0x5208', maxFeePerGas: '0x64', maxPriorityFeePerGas: '0x3',
    }]);
  });

  it.each([
    { accounts: [ACCOUNT_B], chainId: '0x2105' },
    { accounts: [ACCOUNT_A], chainId: '0x1' },
  ])('never calls eth_sendTransaction after an account or chain mismatch', async ({ accounts, chainId }) => {
    const wallet = makeProvider();
    wallet.request.mockImplementation(async ({ method }) => method === 'eth_accounts' ? accounts
      : method === 'eth_chainId' ? chainId : '0x' + 'b'.repeat(64));
    const transaction: G3bUnsignedTransaction = {
      version: 1, type: 'EIP1559', chainId: 8453, from: ACCOUNT_A,
      to: '0x3333333333333333333333333333333333333333', data: '0x1234', valueWei: '0',
      nonce: '0', gasLimit: '21000', maxFeePerGasWei: '100', maxPriorityFeePerGasWei: '3', accessList: [],
    };
    await expect(sendBrowserWalletTransaction(wallet.provider, transaction)).rejects.toThrow('BROWSER_WALLET_CONTEXT_CHANGED');
    expect(wallet.request.mock.calls.map(([request]) => request.method)).toEqual(['eth_accounts', 'eth_chainId']);
  });

  it('does not transform wallet rejection into a retry or a success hash', async () => {
    const wallet = makeProvider();
    wallet.request.mockImplementation(async ({ method }) => {
      if (method === 'eth_accounts') return [ACCOUNT_A];
      if (method === 'eth_chainId') return '0x2105';
      throw Object.assign(new Error('rejected'), { code: 4001 });
    });
    const transaction: G3bUnsignedTransaction = {
      version: 1, type: 'EIP1559', chainId: 8453, from: ACCOUNT_A,
      to: '0x3333333333333333333333333333333333333333', data: '0x1234', valueWei: '0',
      nonce: '0', gasLimit: '21000', maxFeePerGasWei: '100', maxPriorityFeePerGasWei: '3', accessList: [],
    };
    await expect(sendBrowserWalletTransaction(wallet.provider, transaction)).rejects.toMatchObject({ code: 4001 });
    expect(wallet.request.mock.calls.filter(([request]) => request.method === 'eth_sendTransaction')).toHaveLength(1);
  });
  it('maps rejection and unsupported-method errors to safe user-facing text', () => {
    expect(safeWalletError({ code: 4001, message: 'private wallet detail' })).toBe('The wallet request was rejected.');
    expect(safeWalletError({ code: 4200, message: 'private wallet detail' })).toContain('does not support');
    expect(safeWalletError(new Error('WALLET_EVENTS_UNSUPPORTED'))).toContain('cannot report account and network changes');
    expect(safeWalletError(new Error('private wallet detail'))).not.toContain('private wallet detail');
  });
});

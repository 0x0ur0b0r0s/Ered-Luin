import { describe, expect, it, vi } from 'vitest';
import { BrowserWalletController } from './browser-wallet-controller.js';
import type { Eip1193Provider, WalletProviderChoice } from './browser-wallet.js';

const ACCOUNT_A = '0x1111111111111111111111111111111111111111';
const ACCOUNT_B = '0x2222222222222222222222222222222222222222';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function wallet(request: (method: string) => Promise<unknown>) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  let requestCount = 0;
  const provider: Eip1193Provider = {
    request: ({ method }) => { requestCount += 1; return request(method); },
    on(event, listener) {
      const group = listeners.get(event) ?? new Set();
      group.add(listener);
      listeners.set(event, group);
    },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
  };
  return {
    provider,
    emit(event: string, value?: unknown) { for (const listener of [...(listeners.get(event) ?? [])]) listener(value); },
    listenerCount() { return [...listeners.values()].reduce((total, group) => total + group.size, 0); },
    requestCount() { return requestCount; },
  };
}
function choice(provider: Eip1193Provider, id: string): WalletProviderChoice {
  return { id, name: id, rdns: null, source: 'legacy', provider };
}
async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }

function makeController() {
  const onState = vi.fn();
  const onAccountSelection = vi.fn();
  const onContextInvalidated = vi.fn();
  const controller = new BrowserWalletController({ onState, onAccountSelection, onContextInvalidated });
  return { controller, onState, onAccountSelection, onContextInvalidated };
}

describe('BrowserWalletController asynchronous lifecycle', () => {
  it('does not restore an old Base connection after disconnect during the chain read', async () => {
    const chain = deferred<unknown>();
    const active = wallet(async (method) => {
      if (method === 'eth_requestAccounts') return [ACCOUNT_A];
      if (method === 'eth_chainId') return chain.promise;
      throw new Error('unexpected method');
    });
    const state = makeController();
    const pending = state.controller.connect(choice(active.provider, 'wallet-a'));

    await flush();
    expect(active.listenerCount()).toBe(3);
    active.emit('disconnect', { code: 4900 });
    chain.resolve('0x2105');
    await pending;

    expect(state.controller.snapshot()).toMatchObject({ connection: null, busy: false, problem: 'Wallet disconnected.' });
    expect(active.listenerCount()).toBe(0);
    expect(state.onAccountSelection).toHaveBeenCalledWith('');
    expect(state.onContextInvalidated).toHaveBeenCalledTimes(2);
  });

  it.each(['accountsChanged', 'chainChanged'] as const)('invalidates a pending connect on %s', async (event) => {
    const chain = deferred<unknown>();
    const active = wallet(async (method) => method === 'eth_requestAccounts' ? [ACCOUNT_A]
      : method === 'eth_chainId' ? chain.promise : Promise.reject(new Error('unexpected method')));
    const state = makeController();
    const pending = state.controller.connect(choice(active.provider, 'wallet-a'));
    await flush();

    active.emit(event, event === 'accountsChanged' ? [ACCOUNT_B] : '0x1');
    chain.resolve('0x2105');
    await pending;

    expect(state.controller.snapshot().connection).toBeNull();
    expect(state.controller.snapshot().busy).toBe(false);
    expect(active.listenerCount()).toBe(0);
  });

  it('keeps a newer provider connect busy when the superseded connect rejects', async () => {
    const firstChain = deferred<unknown>();
    const secondChain = deferred<unknown>();
    const first = wallet(async (method) => method === 'eth_requestAccounts' ? [ACCOUNT_A] : firstChain.promise);
    const second = wallet(async (method) => method === 'eth_requestAccounts' ? [ACCOUNT_B] : secondChain.promise);
    const state = makeController();
    const firstPending = state.controller.connect(choice(first.provider, 'wallet-a'));
    await flush();
    const secondPending = state.controller.connect(choice(second.provider, 'wallet-b'));
    await flush();

    firstChain.reject(new Error('stale failure detail'));
    await firstPending;
    expect(state.controller.snapshot()).toMatchObject({ connection: null, busy: true, problem: null });
    expect(first.listenerCount()).toBe(0);

    secondChain.resolve('0x2105');
    await secondPending;
    expect(state.controller.snapshot().connection?.choice.id).toBe('wallet-b');
    expect(state.controller.snapshot()).toMatchObject({ busy: false, problem: null });
  });

  it('does not let a stale chain read overwrite a chainChanged event during an explicit switch', async () => {
    const switchChain = deferred<unknown>();
    let chainReads = 0;
    const active = wallet(async (method) => {
      if (method === 'eth_requestAccounts') return [ACCOUNT_A];
      if (method === 'wallet_switchEthereumChain') return null;
      if (method === 'eth_chainId') return ++chainReads === 1 ? '0x1' : switchChain.promise;
      throw new Error('unexpected method');
    });
    const state = makeController();
    await state.controller.connect(choice(active.provider, 'wallet-a'));
    const pending = state.controller.switchToBase(active.provider);
    await flush();

    active.emit('chainChanged', '0x1');
    switchChain.resolve('0x2105');
    await pending;

    expect(state.controller.snapshot().connection?.chainId).toBe(1);
    expect(state.controller.snapshot()).toMatchObject({ busy: false, problem: null });
    expect(state.onContextInvalidated).toHaveBeenCalled();
  });

  it('releases pending listeners on local disconnect and unmount, ignoring late responses', async () => {
    const chain = deferred<unknown>();
    const active = wallet(async (method) => method === 'eth_requestAccounts' ? [ACCOUNT_A] : chain.promise);
    const state = makeController();
    const pending = state.controller.connect(choice(active.provider, 'wallet-a'));
    await flush();
    state.controller.disconnectLocally();
    expect(active.listenerCount()).toBe(0);
    const callsAtDispose = state.onState.mock.calls.length;
    state.controller.dispose();

    chain.resolve('0x2105');
    await pending;
    expect(state.onState).toHaveBeenCalledTimes(callsAtDispose);
    expect(state.controller.snapshot().connection).toBeNull();
  });

  it('requires an explicit provider that still owns the current connection before switching', async () => {
    const active = wallet(async (method) => method === 'eth_requestAccounts' ? [ACCOUNT_A] : '0x2105');
    const unrelated = wallet(async () => '0x2105');
    const state = makeController();
    await state.controller.connect(choice(active.provider, 'wallet-a'));
    await state.controller.switchToBase(unrelated.provider);

    expect(unrelated.requestCount()).toBe(0);
    expect(state.controller.snapshot().connection?.choice.provider).toBe(active.provider);
  });
});

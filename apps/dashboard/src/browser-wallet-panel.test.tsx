import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Eip1193Provider, WalletProviderChoice } from './browser-wallet.js';

const harness = vi.hoisted(() => {
  let slots: unknown[] = [];
  let cursor = 0;
  let scheduled: Array<{ index: number; callback: () => unknown }> = [];
  const dependencies = new Map<number, readonly unknown[] | undefined>();
  const callbacks = new Map<number, () => unknown>();
  const cleanups = new Map<number, () => void>();
  return {
    beginRender() { cursor = 0; scheduled = []; },
    reset() {
      this.unmount(); slots = []; cursor = 0; scheduled = [];
      dependencies.clear(); callbacks.clear(); cleanups.clear();
    },
    useState(initial: unknown) {
      const index = cursor++;
      if (index >= slots.length) slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [slots[index], (next: unknown) => {
        slots[index] = typeof next === 'function' ? (next as (previous: unknown) => unknown)(slots[index]) : next;
      }] as const;
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (index >= slots.length) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(callback: () => unknown, deps?: readonly unknown[]) {
      const index = cursor++;
      const previous = dependencies.get(index);
      const changed = !dependencies.has(index) || deps === undefined || previous === undefined ||
        deps.length !== previous.length || deps.some((value, at) => !Object.is(value, previous[at]));
      if (changed) {
        dependencies.set(index, deps);
        callbacks.set(index, callback);
        scheduled.push({ index, callback });
      }
    },
    commitStrictEffects() {
      const mountEffects = [...scheduled];
      const setup = (entry: { index: number; callback: () => unknown }) => {
        const cleanup = entry.callback();
        if (typeof cleanup === 'function') cleanups.set(entry.index, cleanup as () => void);
      };
      mountEffects.forEach(setup);
      [...mountEffects].reverse().forEach(({ index }) => { cleanups.get(index)?.(); cleanups.delete(index); });
      mountEffects.forEach(setup);
      scheduled = [];
    },
    commitEffects() {
      const mountEffects = [...scheduled];
      for (const entry of mountEffects) {
        const cleanup = entry.callback();
        if (typeof cleanup === 'function') cleanups.set(entry.index, cleanup as () => void);
      }
      scheduled = [];
    },
    unmount() {
      [...callbacks.keys()].sort((left, right) => right - left).forEach((index) => {
        cleanups.get(index)?.(); cleanups.delete(index);
      });
    },
  };
});

const discovery = vi.hoisted(() => ({
  choices: [] as unknown[],
  requestProviders: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useEffect: harness.useEffect as typeof actual.useEffect,
    useRef: harness.useRef as typeof actual.useRef,
    useState: harness.useState as typeof actual.useState,
  };
});

vi.mock('./browser-wallet.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-wallet.js')>();
  return {
    ...actual,
    walletProviderDiscovery: () => ({
      subscribe(listener: (choices: readonly WalletProviderChoice[]) => void) {
        discovery.subscribe(listener);
        listener(discovery.choices as WalletProviderChoice[]);
        return () => undefined;
      },
      requestProviders: discovery.requestProviders,
    }),
  };
});

import { BrowserWalletPanel } from './browser-wallet-panel.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
type ElementNode = { readonly type?: unknown; readonly props?: Record<string, unknown> };
function nodes(value: unknown, found: ElementNode[] = []): ElementNode[] {
  if (Array.isArray(value)) value.forEach((item) => nodes(item, found));
  else if (typeof value === 'object' && value !== null && 'type' in value && 'props' in value) {
    const element = value as ElementNode; found.push(element); nodes(element.props?.children, found);
  }
  return found;
}
function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(text).join(' ');
  if (typeof value === 'object' && value !== null && 'props' in value) return text((value as ElementNode).props?.children);
  return '';
}
function renderPanel(props: { onAccountSelection: (account: string) => void; onContextInvalidated: () => void }) {
  harness.beginRender();
  return BrowserWalletPanel({ currentWallet: '', sessionWallet: null, ...props });
}
function connectButton(tree: unknown): ElementNode {
  const button = nodes(tree).find((node) => node.type === 'button' && text(node.props?.children).includes('Connect Rabby'));
  if (!button) throw new Error('Connect Rabby button was not rendered.');
  return button;
}
function walletHarness(chainReply: Promise<unknown> | null = null) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const request = vi.fn(async ({ method }: { method: string }): Promise<unknown> => {
    if (method === 'eth_requestAccounts') return [ACCOUNT];
    if (method === 'eth_chainId') return chainReply ?? '0x2105';
    throw new Error('Unexpected wallet method.');
  });
  const provider: Eip1193Provider = {
    request,
    on(event, listener) { const group = listeners.get(event) ?? new Set(); group.add(listener); listeners.set(event, group); },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
  };
  const choice: WalletProviderChoice = { id: 'eip6963:00000000-0000-4000-8000-000000000321', name: 'Rabby', rdns: 'io.rabby', source: 'eip6963', provider };
  discovery.choices = [choice];
  return { request, listenerCount: () => [...listeners.values()].reduce((sum, group) => sum + group.size, 0) };
}

beforeEach(() => { harness.reset(); discovery.choices = []; vi.clearAllMocks(); vi.stubGlobal('window', {}); });
afterEach(() => { harness.reset(); vi.unstubAllGlobals(); });

describe('BrowserWalletPanel controller lifecycle', () => {
  it('does not show a transaction action while browser-wallet activation is gated', () => {
    const props = { onAccountSelection: vi.fn(), onContextInvalidated: vi.fn() };
    renderPanel(props); harness.commitEffects();
    const tree = renderPanel(props);
    expect(text(tree)).toContain('SUBMISSION GATED');
    expect(nodes(tree).some((node) => node.type === 'button' && text(node.props?.children).includes('Prepare and send to Rabby'))).toBe(false);
  });
  it('connects after StrictMode effect setup-cleanup-setup replay', async () => {
    const wallet = walletHarness();
    const props = { onAccountSelection: vi.fn(), onContextInvalidated: vi.fn() };
    renderPanel(props);
    harness.commitStrictEffects();
    const tree = renderPanel(props);
    const onClick = connectButton(tree).props?.onClick;
    if (typeof onClick !== 'function') throw new Error('Connect callback is missing.');
    (onClick as () => void)();
    await Promise.resolve(); await Promise.resolve();
    expect(wallet.request.mock.calls.map(([args]) => args.method)).toEqual(['eth_requestAccounts', 'eth_chainId']);
    expect(wallet.listenerCount()).toBe(3);
    harness.unmount();
    expect(wallet.listenerCount()).toBe(0);
  });

  it('cleans up the mounted controller and ignores a deferred chain response on unmount', async () => {
    let resolveChain!: (value: unknown) => void;
    const chainReply = new Promise<unknown>((resolve) => { resolveChain = resolve; });
    const wallet = walletHarness(chainReply);
    const props = { onAccountSelection: vi.fn(), onContextInvalidated: vi.fn() };
    renderPanel(props); harness.commitEffects();
    const tree = renderPanel(props);
    const onClick = connectButton(tree).props?.onClick;
    if (typeof onClick !== 'function') throw new Error('Connect callback is missing.');
    (onClick as () => void)();
    await Promise.resolve(); await Promise.resolve();
    expect(wallet.listenerCount()).toBe(3);
    harness.unmount();
    resolveChain('0x2105');
    await Promise.resolve(); await Promise.resolve();
    expect(wallet.listenerCount()).toBe(0);
    expect(props.onAccountSelection.mock.calls).toEqual([['']]);
  });
});
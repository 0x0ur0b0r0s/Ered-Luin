import type { G3bUnsignedTransaction } from '@ered-luin/contracts';

export interface Eip1193Provider {
  request(args: { readonly method: string; readonly params?: readonly unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
  readonly providers?: readonly Eip1193Provider[];
  readonly isRabby?: boolean;
  readonly isBraveWallet?: boolean;
}

export interface WalletProviderChoice {
  readonly id: string;
  readonly name: string;
  readonly rdns: string | null;
  readonly source: 'eip6963' | 'legacy';
  readonly provider: Eip1193Provider;
}

export interface WalletDiscoveryTarget extends EventTarget {
  readonly ethereum?: Eip1193Provider;
}

interface ProviderAnnouncement {
  readonly info?: { readonly uuid?: unknown; readonly name?: unknown; readonly rdns?: unknown };
  readonly provider?: unknown;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/iu;
const BASE_CHAIN_ID = 8453;
const BASE_CHAIN_HEX = '0x2105';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isEip1193Provider(value: unknown): value is Eip1193Provider {
  return isRecord(value) && typeof value.request === 'function';
}

export function supportsWalletEvents(provider: Eip1193Provider): boolean {
  return typeof provider.on === 'function' && typeof provider.removeListener === 'function';
}

function legacyName(provider: Eip1193Provider, index: number): string {
  if (provider.isRabby === true) return 'Rabby Wallet (legacy injection)';
  if (provider.isBraveWallet === true) return 'Brave Wallet (legacy injection)';
  return `Injected EVM wallet ${index + 1}`;
}

/** EIP-6963 announce listeners stay attached for the target window's lifetime. */
export class WalletProviderDiscovery {
  private readonly providers = new Map<Eip1193Provider, WalletProviderChoice>();
  private readonly subscribers = new Set<(choices: readonly WalletProviderChoice[]) => void>();

  constructor(private readonly target: WalletDiscoveryTarget) {
    target.addEventListener('eip6963:announceProvider', (event) => this.announce(event));
  }

  subscribe(listener: (choices: readonly WalletProviderChoice[]) => void): () => void {
    this.subscribers.add(listener);
    listener(this.snapshot());
    return () => { this.subscribers.delete(listener); };
  }

  requestProviders(): void {
    this.target.dispatchEvent(new Event('eip6963:requestProvider'));
    if (![...this.providers.values()].some((choice) => choice.source === 'eip6963')) this.collectLegacyProviders();
    this.emit();
  }

  private announce(event: Event): void {
    const detail = (event as CustomEvent<ProviderAnnouncement>).detail;
    const info = detail?.info;
    const provider = detail?.provider;
    if (!info || !UUID_V4.test(String(info.uuid ?? '')) || typeof info.name !== 'string' || !info.name.trim() ||
        typeof info.rdns !== 'string' || !info.rdns.trim() || !isEip1193Provider(provider)) return;
    const baseId = `eip6963:${String(info.uuid).toLowerCase()}`;
    let id = baseId;
    let duplicate = 1;
    while ([...this.providers.values()].some((choice) => choice.id === id && choice.provider !== provider)) id = `${baseId}:${duplicate++}`;
    this.providers.set(provider, Object.freeze({ id, name: info.name.trim(), rdns: info.rdns.trim(), source: 'eip6963', provider }));
    this.emit();
  }

  private collectLegacyProviders(): void {
    const injected = this.target.ethereum;
    const candidates = injected?.providers?.length ? injected.providers : injected ? [injected] : [];
    candidates.forEach((provider, index) => {
      if (!isEip1193Provider(provider) || this.providers.has(provider)) return;
      this.providers.set(provider, Object.freeze({
        id: `legacy:${index}:${this.providers.size}`,
        name: legacyName(provider, index),
        rdns: null,
        source: 'legacy',
        provider,
      }));
    });
  }

  private snapshot(): readonly WalletProviderChoice[] {
    return Object.freeze([...this.providers.values()].sort((left, right) => left.name.localeCompare(right.name)));
  }

  private emit(): void {
    const choices = this.snapshot();
    for (const subscriber of this.subscribers) subscriber(choices);
  }
}

const discoveries = new WeakMap<object, WalletProviderDiscovery>();

export function walletProviderDiscovery(target: WalletDiscoveryTarget = window): WalletProviderDiscovery {
  let discovery = discoveries.get(target);
  if (!discovery) {
    discovery = new WalletProviderDiscovery(target);
    discoveries.set(target, discovery);
  }
  return discovery;
}

export function parseWalletAccounts(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.some((account) => typeof account !== 'string' || !EVM_ADDRESS.test(account))) return null;
  return Object.freeze([...new Set(value as string[])]);
}

export function parseWalletChainId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/iu.test(value)) return null;
  try {
    const chainId = BigInt(value);
    return chainId <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(chainId) : null;
  } catch {
    return null;
  }
}

export function isBaseWalletChain(chainId: number | null): boolean {
  return chainId === BASE_CHAIN_ID;
}

export function walletAccountMatchesSession(account: string | null, sessionAccount: string | null, chainId: number | null): boolean {
  return account !== null && sessionAccount !== null && EVM_ADDRESS.test(account) && EVM_ADDRESS.test(sessionAccount) &&
    account.toLowerCase() === sessionAccount.toLowerCase() && isBaseWalletChain(chainId);
}

function walletQuantity(value: string): string {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error('BROWSER_TRANSACTION_QUANTITY_INVALID');
  return '0x' + BigInt(value).toString(16);
}

/** Rechecks the active account and Base chain immediately before opening the user wallet prompt. */
export async function sendBrowserWalletTransaction(provider: Eip1193Provider, transaction: G3bUnsignedTransaction): Promise<string> {
  const accounts = parseWalletAccounts(await provider.request({ method: 'eth_accounts' }));
  const chainId = parseWalletChainId(await provider.request({ method: 'eth_chainId' }));
  if (!accounts || !accounts.some((account) => account.toLowerCase() === transaction.from.toLowerCase()) || chainId !== BASE_CHAIN_ID) {
    throw new Error('BROWSER_WALLET_CONTEXT_CHANGED');
  }
  const result = await provider.request({ method: 'eth_sendTransaction', params: [{
    type: '0x2', from: transaction.from, to: transaction.to, data: transaction.data,
    value: walletQuantity(transaction.valueWei), nonce: walletQuantity(transaction.nonce), gas: walletQuantity(transaction.gasLimit),
    maxFeePerGas: walletQuantity(transaction.maxFeePerGasWei), maxPriorityFeePerGas: walletQuantity(transaction.maxPriorityFeePerGasWei),
  }] });
  if (typeof result !== 'string' || !/^0x[0-9a-f]{64}$/iu.test(result)) throw new Error('BROWSER_WALLET_HASH_INVALID');
  return result.toLowerCase();
}
export async function connectBrowserWallet(provider: Eip1193Provider): Promise<{
  readonly accounts: readonly string[];
  readonly chainId: number | null;
}> {
  if (!supportsWalletEvents(provider)) throw new Error('WALLET_EVENTS_UNSUPPORTED');
  const accounts = parseWalletAccounts(await provider.request({ method: 'eth_requestAccounts' }));
  if (!accounts || accounts.length === 0) throw new Error('WALLET_ACCOUNTS_INVALID');
  const chainId = parseWalletChainId(await provider.request({ method: 'eth_chainId' }));
  return Object.freeze({ accounts, chainId });
}

export async function switchBrowserWalletToBase(provider: Eip1193Provider): Promise<number> {
  if (!supportsWalletEvents(provider)) throw new Error('WALLET_EVENTS_UNSUPPORTED');
  await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_CHAIN_HEX }] });
  const chainId = parseWalletChainId(await provider.request({ method: 'eth_chainId' }));
  if (chainId !== BASE_CHAIN_ID) throw new Error('BASE_CHAIN_SWITCH_NOT_CONFIRMED');
  return BASE_CHAIN_ID;
}

export interface WalletEventHandlers {
  readonly accountsChanged: (accounts: unknown) => void;
  readonly chainChanged: (chainId: unknown) => void;
  readonly disconnect: (error: unknown) => void;
}

export function subscribeWalletEvents(provider: Eip1193Provider, handlers: WalletEventHandlers): (() => void) | null {
  if (!supportsWalletEvents(provider)) return null;
  const accountsChanged = (...args: unknown[]) => handlers.accountsChanged(args[0]);
  const chainChanged = (...args: unknown[]) => handlers.chainChanged(args[0]);
  const disconnect = (...args: unknown[]) => handlers.disconnect(args[0]);
  provider.on!('accountsChanged', accountsChanged);
  provider.on!('chainChanged', chainChanged);
  provider.on!('disconnect', disconnect);
  return () => {
    provider.removeListener!('accountsChanged', accountsChanged);
    provider.removeListener!('chainChanged', chainChanged);
    provider.removeListener!('disconnect', disconnect);
  };
}

export function safeWalletError(error: unknown): string {
  const code = isRecord(error) && typeof error.code === 'number' ? error.code : null;
  if (code === 4001) return 'The wallet request was rejected.';
  if (code === 4902) return 'Base is not configured in this wallet. Add Base in the wallet, then refresh.';
  if (code === 4200 || code === -32601) return 'This wallet does not support the requested connection or network method.';
  if (error instanceof Error && error.message === 'WALLET_EVENTS_UNSUPPORTED') return 'This wallet cannot report account and network changes safely.';
  if (error instanceof Error && error.message === 'WALLET_ACCOUNTS_INVALID') return 'The wallet returned no valid account.';
  if (error instanceof Error && error.message === 'BASE_CHAIN_SWITCH_NOT_CONFIRMED') return 'The wallet did not confirm Base chain 8453.';
  return 'Wallet request failed. No signing or transaction request was made.';
}

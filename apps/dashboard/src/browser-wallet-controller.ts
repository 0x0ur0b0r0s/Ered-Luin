import {
  connectBrowserWallet, isBaseWalletChain, parseWalletAccounts, parseWalletChainId,
  safeWalletError, subscribeWalletEvents, switchBrowserWalletToBase,
  type Eip1193Provider, type WalletProviderChoice,
} from './browser-wallet.js';

export interface ConnectedBrowserWallet {
  readonly choice: WalletProviderChoice;
  readonly accounts: readonly string[];
  readonly selectedAccount: string | null;
  readonly chainId: number | null;
  readonly unsubscribe: () => void;
}

export interface BrowserWalletControllerState {
  readonly connection: ConnectedBrowserWallet | null;
  readonly busy: boolean;
  readonly problem: string | null;
}

export interface BrowserWalletControllerCallbacks {
  readonly onState: (state: BrowserWalletControllerState) => void;
  readonly onAccountSelection: (account: string) => void;
  readonly onContextInvalidated: () => void;
}

const EMPTY_STATE: BrowserWalletControllerState = Object.freeze({ connection: null, busy: false, problem: null });

/** Owns pending EIP-1193 work and event listeners for one mounted panel instance. */
export class BrowserWalletController {
  private state: BrowserWalletControllerState = EMPTY_STATE;
  private operationGeneration = 0;
  private connectionGeneration = 0;
  private pendingUnsubscribe: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly callbacks: BrowserWalletControllerCallbacks) {}

  snapshot(): BrowserWalletControllerState { return this.state; }

  async connect(choice: WalletProviderChoice): Promise<void> {
    if (this.disposed) return;
    const operation = ++this.operationGeneration;
    const connectionGeneration = ++this.connectionGeneration;
    this.releaseListeners();
    this.emit({ connection: null, busy: true, problem: null });
    this.callbacks.onAccountSelection('');
    this.callbacks.onContextInvalidated();

    let committed = false;
    const unsubscribe = subscribeWalletEvents(choice.provider, {
      accountsChanged: (value) => {
        if (!this.isConnectionCurrent(connectionGeneration)) return;
        this.invalidateOperation();
        const accounts = parseWalletAccounts(value);
        if (!committed) {
          this.connectionGeneration += 1;
          this.releaseListeners();
          this.emit({ connection: null, busy: false, problem: accounts
            ? 'Wallet accounts changed while connecting. Reconnect to continue.'
            : 'Wallet returned an invalid account list. Reconnect to continue.' });
        } else {
          const current = this.state.connection;
          if (current?.choice.provider === choice.provider) this.emit({
            ...this.state, connection: { ...current, accounts: accounts ?? [], selectedAccount: null }, busy: false,
            problem: accounts ? 'Wallet accounts changed. Select an account again.' : 'Wallet returned an invalid account list. Reconnect to continue.',
          });
        }
        this.callbacks.onAccountSelection('');
        this.callbacks.onContextInvalidated();
      },
      chainChanged: (value) => {
        if (!this.isConnectionCurrent(connectionGeneration)) return;
        this.invalidateOperation();
        const chainId = parseWalletChainId(value);
        if (!committed) {
          this.connectionGeneration += 1;
          this.releaseListeners();
          this.emit({ connection: null, busy: false, problem: chainId === null
            ? 'Wallet returned an invalid chain ID while connecting.'
            : 'Wallet network changed while connecting. Reconnect to continue.' });
        } else {
          const current = this.state.connection;
          if (current?.choice.provider === choice.provider) this.emit({
            ...this.state, connection: { ...current, chainId }, busy: false,
            problem: chainId === null ? 'Wallet returned an invalid chain ID.' : null,
          });
        }
        this.callbacks.onContextInvalidated();
      },
      disconnect: () => {
        if (!this.isConnectionCurrent(connectionGeneration)) return;
        this.connectionGeneration += 1;
        this.invalidateOperation();
        this.releaseListeners();
        this.emit({ connection: null, busy: false, problem: 'Wallet disconnected.' });
        this.callbacks.onAccountSelection('');
        this.callbacks.onContextInvalidated();
      },
    });

    if (!unsubscribe) {
      if (this.isOperationCurrent(operation)) this.emit({
        connection: null, busy: false, problem: safeWalletError(new Error('WALLET_EVENTS_UNSUPPORTED')),
      });
      return;
    }
    this.pendingUnsubscribe = unsubscribe;
    try {
      const result = await connectBrowserWallet(choice.provider);
      if (!this.isOperationCurrent(operation) || !this.isConnectionCurrent(connectionGeneration)) return;
      committed = true;
      this.pendingUnsubscribe = null;
      this.emit({ connection: { choice, accounts: result.accounts, selectedAccount: null, chainId: result.chainId, unsubscribe }, busy: false, problem: null });
    } catch (error) {
      if (!this.isOperationCurrent(operation) || !this.isConnectionCurrent(connectionGeneration)) return;
      this.releaseListeners();
      this.emit({ connection: null, busy: false, problem: safeWalletError(error) });
    }
  }

  selectAccount(account: string): void {
    const connection = this.state.connection;
    if (this.disposed || !connection || !isBaseWalletChain(connection.chainId) || !connection.accounts.includes(account)) return;
    this.invalidateOperation();
    this.emit({ ...this.state, connection: { ...connection, selectedAccount: account }, busy: false, problem: null });
    this.callbacks.onAccountSelection(account);
  }

  async switchToBase(provider: Eip1193Provider): Promise<void> {
    const connection = this.state.connection;
    if (this.disposed || !connection || connection.choice.provider !== provider) return;
    const operation = ++this.operationGeneration;
    const generation = this.connectionGeneration;
    this.emit({ ...this.state, busy: true, problem: null });
    this.callbacks.onContextInvalidated();
    try {
      const chainId = await switchBrowserWalletToBase(provider);
      if (!this.isOperationCurrent(operation) || !this.isConnectionCurrent(generation)) return;
      const current = this.state.connection;
      if (!current || current.choice.provider !== provider) return;
      this.emit({ ...this.state, connection: { ...current, chainId }, busy: false, problem: null });
    } catch (error) {
      if (!this.isOperationCurrent(operation) || !this.isConnectionCurrent(generation)) return;
      this.emit({ ...this.state, busy: false, problem: safeWalletError(error) });
    }
  }

  disconnectLocally(): void {
    if (this.disposed) return;
    this.connectionGeneration += 1;
    this.invalidateOperation();
    this.releaseListeners();
    this.emit({ connection: null, busy: false, problem: null });
    this.callbacks.onAccountSelection('');
    this.callbacks.onContextInvalidated();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.connectionGeneration += 1;
    this.invalidateOperation();
    this.releaseListeners();
  }

  private isOperationCurrent(generation: number): boolean { return !this.disposed && this.operationGeneration === generation; }
  private isConnectionCurrent(generation: number): boolean { return !this.disposed && this.connectionGeneration === generation; }
  private invalidateOperation(): void { this.operationGeneration += 1; }

  private releaseListeners(): void {
    this.pendingUnsubscribe?.();
    this.pendingUnsubscribe = null;
    this.state.connection?.unsubscribe();
  }

  private emit(state: BrowserWalletControllerState): void {
    if (this.disposed) return;
    this.state = Object.freeze(state);
    this.callbacks.onState(this.state);
  }
}

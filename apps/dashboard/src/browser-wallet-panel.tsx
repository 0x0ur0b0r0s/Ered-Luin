import { useEffect, useRef, useState } from 'react';
import { d2Api, type D2BrowserAllowancePreflight, type D2BrowserExecutionAction, type D2Evaluation, type D2Simulation } from './api-client.js';
import {
  isBaseWalletChain, walletAccountMatchesSession, walletProviderDiscovery,
  sendBrowserWalletTransaction, type Eip1193Provider, type WalletProviderChoice,
} from './browser-wallet.js';
import { BrowserWalletController, type BrowserWalletControllerState } from './browser-wallet-controller.js';

interface BrowserWalletPanelProps {
  readonly currentWallet: string;
  readonly sessionWallet: string | null;
  readonly onAccountSelection: (account: string) => void;
  readonly onContextInvalidated: () => void;
  readonly api?: typeof d2Api;
  readonly proposalId?: string | null;
  readonly sessionId?: string | null;
  readonly operationId?: string | null;
  readonly evaluation?: D2Evaluation | null;
  readonly simulation?: D2Simulation | null;
  readonly authenticated?: boolean;
  readonly browserWalletEnabled?: boolean;
  readonly onApprovalComplete?: () => void;
}

function statusClass(value: string): string { return value.toLowerCase().replaceAll('_', '-'); }

function abbreviatedAddress(address: string): string {
  return address.slice(0, 8) + '…' + address.slice(-6);
}

const INITIAL_CONTROLLER_STATE: BrowserWalletControllerState = Object.freeze({ connection: null, busy: false, problem: null });

export function BrowserWalletPanel({ currentWallet, sessionWallet, onAccountSelection, onContextInvalidated, api = d2Api, proposalId = null, sessionId = null, operationId = null, evaluation = null, simulation = null, authenticated = false, browserWalletEnabled = false, onApprovalComplete = () => undefined }: BrowserWalletPanelProps) {
  const [choices, setChoices] = useState<readonly WalletProviderChoice[]>([]);
  const [controllerState, setControllerState] = useState(INITIAL_CONTROLLER_STATE);
  const [browserExecution, setBrowserExecution] = useState<D2BrowserExecutionAction | null>(null);
  const [allowance, setAllowance] = useState<D2BrowserAllowancePreflight | null>(null);
  const [transactionHashInput, setTransactionHashInput] = useState('');
  const [browserBusy, setBrowserBusy] = useState(false);
  const [browserProblem, setBrowserProblem] = useState<string | null>(null);
  const callbacks = useRef({ onAccountSelection, onContextInvalidated, onApprovalComplete });
  callbacks.current = { onAccountSelection, onContextInvalidated, onApprovalComplete };
  const [controller, setController] = useState<BrowserWalletController | null>(null);
  const { connection, busy, problem } = controllerState;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const discovery = walletProviderDiscovery(window);
    const unsubscribe = discovery.subscribe(setChoices);
    discovery.requestProviders();
    return unsubscribe;
  }, []);

  useEffect(() => {
    const ownedController = new BrowserWalletController({
      onState: setControllerState,
      onAccountSelection: (account) => callbacks.current.onAccountSelection(account),
      onContextInvalidated: () => callbacks.current.onContextInvalidated(),
    });
    setController(ownedController);
    return () => ownedController.dispose();
  }, []);

  function selectAccount(account: string) { controller?.selectAccount(account); }
  function switchToBase(provider: Eip1193Provider) { if (controller) void controller.switchToBase(provider); }
  function disconnectLocally() { controller?.disconnectLocally(); }

  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    let identity: { proposalId: string; operationId: string } | null = null;
    try { identity = JSON.parse(window.localStorage.getItem('ered-luin-browser-workflow') ?? 'null') as { proposalId: string; operationId: string } | null; } catch { identity = null; }
    const target = identity ?? (proposalId && operationId ? { proposalId, operationId } : null);
    if (target) void api.browserStatus(target.proposalId, target.operationId).then((status) => {
      if (active) { setBrowserExecution(status); window.localStorage.setItem('ered-luin-browser-workflow', JSON.stringify({ proposalId: status.proposalId, operationId: status.operationId })); }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [api, authenticated, operationId, proposalId]);

  useEffect(() => { setAllowance(null); }, [proposalId, sessionId]);

  useEffect(() => {
    if (browserExecution && proposalId && browserExecution.proposalId !== proposalId &&
        (browserExecution.browserStage === 'REVERTED' || browserExecution.browserStage === 'REJECTED' ||
         browserExecution.kind === 'SWAP' && browserExecution.browserStage === 'CONFIRMED')) {
      setBrowserExecution(null); setTransactionHashInput(''); setBrowserProblem(null);
    }
  }, [browserExecution, proposalId]);

  async function checkAllowance() {
    if (!proposalId || !sessionId || !authenticated || !browserWalletEnabled || !evaluation || !connection?.selectedAccount || !accountMatchesSession || !accountMatchesInput) return;
    setBrowserBusy(true); setBrowserProblem(null);
    try {
      const result = await api.browserCheckAllowance(proposalId, operationId ?? crypto.randomUUID(), sessionId);
      setAllowance(result);
    } catch (cause) { setBrowserProblem(cause instanceof Error ? cause.message : 'Fresh Base allowance check failed.'); }
    finally { setBrowserBusy(false); }
  }

  function persistIdentity(targetProposalId: string, targetOperationId: string) {
    window.localStorage.setItem('ered-luin-browser-workflow', JSON.stringify({ proposalId: targetProposalId, operationId: targetOperationId }));
  }

  async function openPrepared(prepared: D2BrowserExecutionAction) {
    setBrowserExecution(prepared);
    persistIdentity(prepared.proposalId, prepared.operationId);
    if (prepared.browserStage !== 'READY') return;
    if (!connection?.selectedAccount || !walletAccountMatchesSession(connection.selectedAccount, prepared.walletAddress, connection.chainId) ||
        connection.selectedAccount.toLowerCase() !== prepared.walletAddress.toLowerCase()) {
      setBrowserProblem('Select the exact session account on Base before opening Rabby.');
      return;
    }
    const armed = await api.browserBegin(prepared.proposalId, prepared.operationId, prepared.sessionId);
    setBrowserExecution(armed);
    try {
      const hash = await sendBrowserWalletTransaction(connection.choice.provider, armed.transaction);
      setTransactionHashInput(hash);
      try { setBrowserExecution(await api.browserAttachHash(prepared.proposalId, prepared.operationId, hash)); }
      catch { setBrowserProblem('Rabby returned a hash, but the server did not verify it. The operation remains reserved. Attach this hash manually; do not send again.'); }
    } catch (cause) {
      const code = typeof cause === 'object' && cause !== null && 'code' in cause ? (cause as { code?: unknown }).code : null;
      const message = cause instanceof Error ? cause.message : '';
      if (code === 4001) {
        setBrowserExecution(await api.browserReject(prepared.proposalId, prepared.operationId, 'USER_REJECTED'));
        window.localStorage.removeItem('ered-luin-browser-workflow');
        setBrowserProblem('Rabby rejected this operation. Its reservation was closed; create a fresh policy cycle before trying again.');
      } else if (message === 'BROWSER_WALLET_CONTEXT_CHANGED') {
        setBrowserExecution(await api.browserReject(prepared.proposalId, prepared.operationId, 'PRE_SEND_CONTEXT_CHANGED'));
        window.localStorage.removeItem('ered-luin-browser-workflow');
        setBrowserProblem('The selected account or network changed before Rabby opened. No transaction request was sent.');
      } else setBrowserProblem('The wallet response is uncertain. The reservation stays active. Attach a transaction hash or reconcile this operation; the app will not retry it.');
    }
  }

  async function prepareAndSend() {
    if (!proposalId || !sessionId || !operationId || !simulation || !evaluation || !connection?.selectedAccount || !authenticated || !browserWalletEnabled) return;
    setBrowserBusy(true); setBrowserProblem(null);
    try {
      const prepared = browserExecution?.kind === 'SWAP' && browserExecution.browserStage === 'READY'
        ? browserExecution : await api.browserPrepare(proposalId, operationId, sessionId);
      await openPrepared(prepared);
    } catch (cause) { setBrowserProblem(cause instanceof Error ? cause.message : 'Browser wallet preparation failed. No transaction was sent.'); }
    finally { setBrowserBusy(false); }
  }

  async function prepareApprovalAndSend() {
    if (!proposalId || !sessionId || !authenticated || !browserWalletEnabled || allowance?.status !== 'APPROVAL_REQUIRED' ||
        !connection?.selectedAccount || !accountMatchesSession || !accountMatchesInput) return;
    setBrowserBusy(true); setBrowserProblem(null);
    try {
      const approvalOperationId = crypto.randomUUID();
      const prepared = await api.browserPrepareApproval(proposalId, approvalOperationId, sessionId);
      await openPrepared(prepared);
    } catch (cause) { setBrowserProblem(cause instanceof Error ? cause.message : 'Exact approval preparation failed. No transaction was sent.'); }
    finally { setBrowserBusy(false); }
  }

  async function completeApproval() {
    if (!browserExecution || browserExecution.kind !== 'APPROVAL' || browserExecution.browserStage !== 'CONFIRMED' || !authenticated ||
        !connection?.selectedAccount || !walletAccountMatchesSession(connection.selectedAccount, browserExecution.walletAddress, connection.chainId)) return;
    setBrowserBusy(true); setBrowserProblem(null);
    try {
      await api.browserCompleteApproval(browserExecution.proposalId, browserExecution.operationId, browserExecution.sessionId);
      window.localStorage.removeItem('ered-luin-browser-workflow');
      setBrowserExecution(null); setAllowance(null);
      callbacks.current.onApprovalComplete();
      setBrowserProblem('Approval is finalized and the old proposal is released. Start a new read-only session, create a fresh proposal, evaluate, reserve, and simulate before preparing the swap.');
    } catch (cause) { setBrowserProblem(cause instanceof Error ? cause.message : 'Approval refresh could not be finalized.'); }
    finally { setBrowserBusy(false); }
  }
  async function attachHash() {
    const targetProposalId = browserExecution?.proposalId ?? proposalId;
    const targetOperationId = browserExecution?.operationId ?? operationId;
    if (!targetProposalId || !targetOperationId || !transactionHashInput || !authenticated) return;
    setBrowserBusy(true); setBrowserProblem(null);
    try { setBrowserExecution(await api.browserAttachHash(targetProposalId, targetOperationId, transactionHashInput.trim())); }
    catch (cause) { setBrowserProblem(cause instanceof Error ? cause.message : 'Transaction hash verification failed.'); }
    finally { setBrowserBusy(false); }
  }

  async function reconcileBrowserExecution() {
    if (!browserExecution || !authenticated) return;
    setBrowserBusy(true); setBrowserProblem(null);
    try { setBrowserExecution(await api.browserReconcile(browserExecution.proposalId, browserExecution.operationId)); }
    catch (cause) { setBrowserProblem(cause instanceof Error ? cause.message : 'Browser operation reconciliation failed.'); }
    finally { setBrowserBusy(false); }
  }

  const accountMatchesInput = !!connection?.selectedAccount && !!currentWallet &&
    connection.selectedAccount.toLowerCase() === currentWallet.toLowerCase();
  const accountMatchesSession = walletAccountMatchesSession(connection?.selectedAccount ?? null, sessionWallet, connection?.chainId ?? null);
  const browserProposalId = browserExecution?.proposalId ?? proposalId;
  const browserOperationId = browserExecution?.operationId ?? simulation?.operationId ?? operationId;
  const policyAllowsSwap = evaluation !== null && ['ALLOW', 'RESIZE'].includes(evaluation.decision.status) && evaluation.decision.approvedAmountIn !== null;
  const canCheckAllowance = browserWalletEnabled && authenticated && !!proposalId && !!sessionId && !!evaluation && policyAllowsSwap && accountMatchesSession && accountMatchesInput;
  const canPrepareApproval = canCheckAllowance && allowance?.status === 'APPROVAL_REQUIRED' && browserExecution === null;
  const canPrepareBrowserSwap = browserWalletEnabled && authenticated && !!browserProposalId && !!sessionId && !!browserOperationId && !!simulation && policyAllowsSwap && accountMatchesSession && accountMatchesInput && browserExecution?.browserStage !== 'REJECTED';
  const canSendBrowserSwap = canPrepareBrowserSwap && (!browserExecution || browserExecution.kind === 'SWAP' && browserExecution.browserStage === 'READY');
  const canCompleteApproval = authenticated && browserExecution?.kind === 'APPROVAL' && browserExecution.browserStage === 'CONFIRMED' &&
    !!connection?.selectedAccount && walletAccountMatchesSession(connection.selectedAccount, browserExecution.walletAddress, connection.chainId);

  return <section className="browser-wallet-card" aria-labelledby="browser-wallet-heading">
    <div className="browser-wallet-heading"><div><p className="eyebrow">User-controlled wallet</p><h4 id="browser-wallet-heading">Rabby / Brave connection</h4></div>
      <span className="browser-wallet-mode">{browserWalletEnabled ? 'USER-SIGNED MODE' : 'SUBMISSION GATED'}</span></div>
    <p>Choose an announced wallet, then connect explicitly. Connection reads the selected account and network. Swap and approval actions open Rabby only after the exact transaction and reservation are persisted.</p>
    <p>Wallet names are supplied by extensions and are not proof of identity; choose the wallet you recognize.</p>
    <div className="d2-button-row">
      <button className="secondary-button" type="button" onClick={() => typeof window !== 'undefined' && walletProviderDiscovery(window).requestProviders()} disabled={busy}>
        Refresh detected wallets
      </button>
    </div>
    {choices.length === 0 && <p className="d2-gate-note">No injected wallet has announced itself. Check wallet access for this browser tab, then refresh.</p>}
    <div className="browser-wallet-choices">
      {choices.map((choice) => <article className="browser-wallet-choice" key={choice.id}>
        <div><strong>{choice.name}</strong><small>{choice.source === 'eip6963' ? 'EIP-6963 provider announcement' : 'Legacy injection; provider identity is not verified'}</small></div>
        <button className="secondary-button" type="button" onClick={() => { if (controller) void controller.connect(choice); }} disabled={!controller || busy}>
          {busy ? 'Waiting for wallet…' : 'Connect ' + choice.name}
        </button>
      </article>)}
    </div>
    {connection && <div className="browser-wallet-connected">
      <p><strong>{connection.choice.name}</strong> · chain {connection.chainId ?? 'unavailable'} {isBaseWalletChain(connection.chainId) ? '(Base)' : '(Base 8453 required)'}</p>
      {!isBaseWalletChain(connection.chainId) && <button className="secondary-button" type="button" onClick={() => switchToBase(connection.choice.provider)} disabled={!controller || busy}>
        {busy ? 'Waiting for wallet…' : 'Switch wallet to Base'}
      </button>}
      {connection.accounts.length > 0 && <div className="browser-wallet-accounts">
        <strong>Choose the account for this app session</strong>
        {connection.accounts.map((account) => <button className="browser-wallet-account" type="button" key={account}
          aria-pressed={connection.selectedAccount === account} disabled={!isBaseWalletChain(connection.chainId)}
          onClick={() => selectAccount(account)}>
          {abbreviatedAddress(account)}{connection.selectedAccount === account ? ' · selected' : ' · use account'}
        </button>)}
      </div>}
      {connection.selectedAccount && <p className="browser-wallet-binding">
        App address {accountMatchesInput ? 'matches' : 'does not match'} selected account. Policy session {sessionWallet
          ? accountMatchesSession ? 'matches selected Base account.' : 'does not match selected account and Base chain.'
          : 'not started for this account yet.'}
      </p>}
      <button className="secondary-button" type="button" onClick={disconnectLocally} disabled={!controller || busy}>Disconnect in this app</button>
    </div>}
    {problem && <p className="d2-error" role="alert">{problem}</p>}
    {browserWalletEnabled && <div className="browser-wallet-flow">
      <div className="d2-subheading"><div><p className="eyebrow">G2 decision · G3c read-only simulation</p><h4>Rabby approval and Base swap</h4></div>
        <span className={'decision-chip ' + statusClass(evaluation?.decision.status ?? 'waiting')}>{evaluation?.decision.status ?? 'WAITING'}</span></div>
      <p>A bounded USDC/WETH operation. Check the fresh router allowance first. If needed, Rabby receives a separate exact-amount approval; after its finalized receipt, this proposal is released and a new policy cycle is required before the swap. Current caps remain $5 per trade, $25 wallet value and $10 WETH exposure.</p>
      {!canPrepareBrowserSwap && <p className="d2-gate-note">Connect the session account, sign in, and produce fresh Nansen evidence and an ALLOW/RESIZE decision. Check allowance before the read-only swap simulation.</p>}
      <button className="secondary-button" type="button" onClick={() => void checkAllowance()} disabled={!canCheckAllowance || browserBusy}>
        {browserBusy ? 'Checking Base…' : 'Check Base router allowance'}
      </button>
      {allowance && <div className="browser-wallet-operation" aria-live="polite">
        <strong>{allowance.status.replaceAll('_', ' ')}</strong>
        <span>USDC allowance {allowance.currentAllowanceAtomic} · required {allowance.requiredAmountAtomic}</span>
        <span>Spender {allowance.spenderAddress} · Base 8453</span>
        {allowance.status === 'ALLOWANCE_SUFFICIENT' && <p>Allowance is sufficient. Run the G3c read-only simulation, then use the swap action below.</p>}
        {allowance.status === 'APPROVAL_REQUIRED' && <p>The app will request approval for exactly {allowance.requiredAmountAtomic} USDC to the configured router. Rabby will show this as a separate approval transaction.</p>}
      </div>}
      {canPrepareApproval && <button className="primary-button" type="button" onClick={() => void prepareApprovalAndSend()} disabled={browserBusy}>
        {browserBusy ? 'Preparing exact approval…' : 'Prepare exact approval and open Rabby'}
      </button>}
      {!browserExecution && <button className="primary-button" type="button" onClick={() => void prepareAndSend()} disabled={!canSendBrowserSwap || browserBusy}>
        {browserBusy ? 'Preparing exact transaction…' : 'Prepare and send to Rabby'}
      </button>}
      {browserExecution && <div className="browser-wallet-operation" aria-live="polite">
        <strong>{browserExecution.browserStage.replaceAll('_', ' ')}</strong><span>Operation {browserExecution.operationId}</span>
        <span>{browserExecution.kind} · {browserExecution.transactionHash ?? 'no transaction hash recorded'}</span>
        {browserExecution.kind === 'SWAP' && browserExecution.browserStage === 'READY' && <button className="primary-button" type="button" onClick={() => void prepareAndSend()} disabled={!canSendBrowserSwap || browserBusy}>Review swap and open Rabby</button>}
        {browserExecution.kind === 'APPROVAL' && browserExecution.browserStage === 'READY' && <button className="primary-button" type="button" onClick={() => { setBrowserBusy(true); void openPrepared(browserExecution).finally(() => setBrowserBusy(false)); }} disabled={browserBusy || !connection?.selectedAccount}>Review exact approval and open Rabby</button>}
        {['SUBMISSION_UNCERTAIN', 'RECONCILIATION_REQUIRED'].includes(browserExecution.browserStage) && <label>Rabby transaction hash<input value={transactionHashInput} onChange={(event) => setTransactionHashInput(event.target.value)} placeholder="0x…" autoComplete="off" /></label>}
        {['SUBMISSION_UNCERTAIN', 'RECONCILIATION_REQUIRED'].includes(browserExecution.browserStage) && <button className="secondary-button" type="button" onClick={() => void attachHash()} disabled={browserBusy || !transactionHashInput}>Attach and verify hash</button>}
        {browserExecution.transactionHash && !['CONFIRMED', 'REVERTED', 'REJECTED'].includes(browserExecution.browserStage) && <button className="secondary-button" type="button" onClick={() => void reconcileBrowserExecution()} disabled={browserBusy}>Reconcile Base receipt</button>}
        {browserExecution.browserStage === 'CONFIRMED' && browserExecution.kind === 'SWAP' && <p>Swap finalized on Base · block {browserExecution.receiptBlockNumber} · fees {browserExecution.actualFeesUsdcMicros ?? '—'} USDC micros.</p>}
        {browserExecution.browserStage === 'CONFIRMED' && browserExecution.kind === 'APPROVAL' && <><p>Approval finalized on Base · block {browserExecution.receiptBlockNumber}. No swap has been submitted.</p><button className="primary-button" type="button" onClick={() => void completeApproval()} disabled={!canCompleteApproval || browserBusy}>Complete approval and refresh policy</button></>}
        {browserExecution.browserStage === 'REVERTED' && <p>The exact transaction reverted. Finalized account evidence and fee accounting were recorded.</p>}
      </div>}
      {browserProblem && <p className="d2-error" role="alert">{browserProblem}</p>}
    </div>}
    {!browserWalletEnabled && <p className="d2-gate-note">Rabby connection is read-only. Browser transaction submission is disabled until Astra reviews the implementation and a separate browser gate is configured.</p>}
    <p className="browser-wallet-boundary">A BLOCK decision cannot reach eth_sendTransaction. The exact pending transaction is persisted first, uncertain wallet responses are never retried automatically, and the user controls custody and confirmation. Independent Rabby transactions remain outside this app's firewall.</p>
  </section>;
}

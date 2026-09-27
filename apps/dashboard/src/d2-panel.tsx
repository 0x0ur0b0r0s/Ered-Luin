import { useEffect, useRef, useState } from 'react';
import { d2Api, d2bIdempotencyKey, type D2Evaluation, type D2Evidence, type D2ExecutionAction, type D2OperatorSession, type D2Proposal, type D2Runtime, type D2Session, type D2Simulation, type D2FreshAnalysisPreview, type D2FreshAnalysisResult } from './api-client.js';
import { BrowserWalletPanel } from './browser-wallet-panel.js';

function parseUsdcMicros(value: string): string | null {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/u.test(value)) return null;
  const [whole = '0', fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  return amount > 0n && amount <= 25_000_000n ? amount.toString() : null;
}
function usd(value: string | null | undefined): string {
  if (!value || !/^(0|[1-9][0-9]*)$/u.test(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 })
    .format(Number(BigInt(value)) / 1_000_000);
}
function nansenUsd(value: string | null): string {
  if (value === null || !/^-?(0|[1-9][0-9]*)$/u.test(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 })
    .format(Number(BigInt(value)) / 1_000_000);
}
function shortId(value: string): string { return value.slice(0, 8) + '…' + value.slice(-4); }
function statusClass(value: string): string { return value.toLowerCase().replaceAll('_', '-'); }
function StoredSemanticHandoff({ handoff }: { readonly handoff: D2Proposal['analysis']['semanticHandoff'] }) {
  return <aside className="d2-semantic-card" aria-label="Optional stored TypeSafe analysis">
    <div className="d2-subheading"><div><p className="eyebrow">Stored TypeSafe shadow · advisory only · authority NONE</p><h4>Linked analysis</h4></div>
      <span className={'d2-freshness freshness-' + statusClass(handoff.status)}>{handoff.status}</span></div>
    {handoff.status === 'UNAVAILABLE' ? <p>No exact fresh stored G1d judgment is available ({handoff.reason.replaceAll('_', ' ').toLowerCase()}). The deterministic proposal remains the analysis shown above.</p>
      : handoff.status === 'FIXTURE' ? <>
        <p>{handoff.label}. This synthetic score is not market analysis.</p>
        <div className="d2-audit-ids"><small>SYNTHETIC ATTEMPT</small><code>{handoff.attemptId}</code><small>LINKED SIGNALS</small><span>{handoff.evidenceSignalIds.length} fixture ids</span></div>
      </> : <>
        <p>Existing stored advisory output is linked to this exact observation set. It does not authorize or change G2/G3c decisions.</p>
        <div className="d2-decision-grid"><div><small>MODEL</small><strong>{handoff.resolvedModel}</strong></div>
          <div><small>NOUL</small><strong>{handoff.answer.toFixed(3)}</strong></div>
          <div><small>ROUTE</small><strong>{handoff.advisoryRoute}</strong></div>
          <div><small>QUESTION VERSION</small><strong>{handoff.questionVersion}</strong></div></div>
        <div className="d2-audit-ids"><small>ATTEMPT</small><code>{handoff.attemptId}</code><small>REQUEST HASH</small><code>{handoff.requestHash}</code>
          <small>LINKED SIGNALS</small><span>{handoff.evidenceSignalIds.map(shortId).join(', ')}</span></div>
      </>}
  </aside>;
}

export function D2ProductionPanel({ api = d2Api }: { readonly api?: typeof d2Api }) {
  const [runtime, setRuntime] = useState<D2Runtime | null>(null);
  const [operatorSession, setOperatorSession] = useState<D2OperatorSession | null>(null);
  const [operatorPassword, setOperatorPassword] = useState('');
  const [evidence, setEvidence] = useState<D2Evidence | null>(null);
  const [wallet, setWallet] = useState('');
  const [amount, setAmount] = useState('4.00');
  const [session, setSession] = useState<D2Session | null>(null);
  const [proposal, setProposal] = useState<D2Proposal | null>(null);
  const [analysisPreview, setAnalysisPreview] = useState<D2FreshAnalysisPreview | null>(null);
  const [analysisResult, setAnalysisResult] = useState<D2FreshAnalysisResult | null>(null);
  const [evaluation, setEvaluation] = useState<D2Evaluation | null>(null);
  const [persistedAudit, setPersistedAudit] = useState<D2Evaluation | null>(null);
  const [simulation, setSimulation] = useState<D2Simulation | null>(null);
  const [operationId, setOperationId] = useState('');
  const [execution, setExecution] = useState<D2ExecutionAction | null>(null);
  const [recoveryProposalId, setRecoveryProposalId] = useState('');
  const [recoveryOperationId, setRecoveryOperationId] = useState('');
  const [submitConfirmed, setSubmitConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRevision = useRef(0);
  const amountMicros = parseUsdcMicros(amount);
  const walletValid = /^0x[0-9a-fA-F]{40}$/u.test(wallet);
  const rpcReady = runtime?.baseRpc === 'read_only_enabled';
  const productionReady = runtime?.productionEvaluation === 'configured';
  const authenticated = operatorSession?.authenticated === true;

  useEffect(() => {
    const proposalId = new URLSearchParams(window.location.search).get('paperEvaluation');
    if (!proposalId || !/^[0-9a-f-]{36}$/iu.test(proposalId)) return;
    let active = true;
    void api.getEvaluation(proposalId).then((record) => {
      if (active) setPersistedAudit(record);
    }).catch(() => {
      if (active) setPersistedAudit(null);
    });
    return () => { active = false; };
  }, [api]);
  useEffect(() => {
    let active = true;
    void Promise.allSettled([api.runtime(), api.evidence(), api.operatorSession()]).then(([runtimeResult, evidenceResult, operatorResult]) => {
      if (!active) return;
      if (runtimeResult.status === 'fulfilled') setRuntime(runtimeResult.value);
      else setError(runtimeResult.reason instanceof Error ? runtimeResult.reason.message : 'Production runtime unavailable.');
      if (evidenceResult.status === 'fulfilled') setEvidence(evidenceResult.value);
      else if (runtimeResult.status === 'fulfilled' && runtimeResult.value.nansenObservationStore === 'configured') {
        setError(evidenceResult.reason instanceof Error ? evidenceResult.reason.message : 'Persisted evidence unavailable.');
      }
      if (operatorResult.status === 'fulfilled') setOperatorSession(operatorResult.value);
      else setOperatorSession({ configured: false, authenticated: false, expiresAt: null });
    });
    return () => { active = false; };
  }, [api]);

  function invalidateSelection() {
    requestRevision.current += 1;
    setBusy(null);
    setError(null);
  }
  async function run(action: string, operation: (revision: number) => Promise<void>) {
    const revision = requestRevision.current;
    setBusy(action);
    setError(null);
    try { await operation(revision); }
    catch (cause) {
      if (requestRevision.current !== revision) return;
      const message = cause instanceof Error ? cause.message : 'D2 request failed.';
      setError(message);
      if (message === 'OPERATOR_AUTH_REQUIRED' || message === 'OPERATOR_AUTH_UNAVAILABLE') {
        setOperatorSession((previous) => previous ? { ...previous, authenticated: false, expiresAt: null } : previous);
      }
    } finally {
      if (requestRevision.current === revision) setBusy(null);
    }
  }
  function isCurrent(revision: number): boolean { return requestRevision.current === revision; }
  function clearDownstream() {
    setProposal(null);
    setAnalysisPreview(null);
    setAnalysisResult(null);
    setEvaluation(null);
    setSimulation(null);
    setOperationId('');
    setExecution(null);
    setSubmitConfirmed(false);
  }
  function changeWallet(value: string) {
    invalidateSelection();
    setWallet(value.trim());
    setSession(null);
    clearDownstream();
  }
  function changeAmount(value: string) {
    invalidateSelection();
    setAmount(value);
    clearDownstream();
  }
  function login() {
    const secret = operatorPassword;
    setOperatorPassword('');
    if (!secret || !operatorSession?.configured) return;
    void run('operator-login', async (revision) => {
      const result = await api.login(secret);
      if (isCurrent(revision)) setOperatorSession(result);
    });
  }
  function logout() {
    void run('operator-logout', async (revision) => {
      const result = await api.logout();
      if (isCurrent(revision)) {
        setOperatorSession(result);
        clearDownstream();
        setSession(null);
      }
    });
  }
  function createProposal() {
    if (!walletValid || !amountMicros || !authenticated) return;
    void run('proposal', async (revision) => {
      clearDownstream();
      const result = await api.proposal(wallet, amountMicros);
      if (isCurrent(revision)) setProposal(result);
    });
  }
  function previewAnalysis() {
    if (!proposal || !authenticated) return;
    const selectedProposalId = proposal.proposalId;
    void run('analysis-preview', async (revision) => {
      const result = await api.analysisPreview(selectedProposalId);
      if (isCurrent(revision)) { setAnalysisPreview(result); setAnalysisResult(null); }
    });
  }
  function invokeAnalysis() {
    if (!proposal || !authenticated || !analysisPreview?.canInvoke) return;
    const selectedProposalId = proposal.proposalId;
    const selectedRequestHash = analysisPreview.requestHash;
    void run('analysis-invoke', async (revision) => {
      const result = await api.invokeAnalysis(selectedProposalId, selectedRequestHash);
      const refreshedProposal = await api.getProposal(selectedProposalId);
      if (isCurrent(revision)) { setAnalysisResult(result); setProposal(refreshedProposal); }
    });
  }
  function startSession() {
    if (!walletValid || !authenticated) return;
    void run('session', async (revision) => {
      const result = await api.startSession(crypto.randomUUID(), wallet, 'D2 public-wallet read-only policy session');
      if (isCurrent(revision)) setSession(result);
    });
  }
  function evaluate() {
    if (!proposal || !authenticated) return;
    const selectedProposalId = proposal.proposalId;
    void run('evaluation', async (revision) => {
      const result = await api.evaluate(selectedProposalId, session?.sessionId);
      if (isCurrent(revision)) {
        setEvaluation(result);
        setSimulation(null);
        setExecution(null);
      }
    });
  }
  function reserve() {
    if (!proposal || !session || !authenticated) return;
    const selectedProposalId = proposal.proposalId;
    void run('reservation', async (revision) => {
      const result = await api.reserve(selectedProposalId, session.sessionId);
      if (isCurrent(revision)) setEvaluation(result);
    });
  }
  function simulate() {
    if (!proposal || !session || !authenticated) return;
    const selectedProposalId = proposal.proposalId;
    const selectedOperationId = operationId || crypto.randomUUID();
    if (!operationId) {
      invalidateSelection();
      setOperationId(selectedOperationId);
    }
    void run('simulation', async (revision) => {
      const result = await api.simulate(selectedProposalId, session.sessionId, selectedOperationId);
      if (isCurrent(revision)) {
        setSimulation(result);
        setOperationId(selectedOperationId);
      }
    });
  }
  function prepareSign(operationOverride?: string) {
    if (!proposal || !evaluation?.sessionId || !authenticated) return;
    const selectedProposalId = proposal.proposalId;
    const selectedOperationId = operationOverride || (operationId && operationId !== simulation?.operationId ? operationId : crypto.randomUUID());
    if (selectedOperationId !== operationId) {
      invalidateSelection();
      setOperationId(selectedOperationId);
    }
    setSubmitConfirmed(false);
    void run('prepare-sign', async (revision) => {
      const idempotencyKey = await d2bIdempotencyKey('PREPARE_SIGN', selectedOperationId);
      if (!isCurrent(revision)) return;
      const result = await api.prepareSign(selectedProposalId, selectedOperationId, evaluation.sessionId!, idempotencyKey);
      if (isCurrent(revision)) {
        setExecution(result);
        setRecoveryProposalId(result.proposalId);
        setRecoveryOperationId(result.operationId);
      }
    });
  }
  function recoverStatus() {
    const selectedProposalId = recoveryProposalId.trim();
    const selectedOperationId = recoveryOperationId.trim();
    if (!selectedProposalId || !selectedOperationId || !authenticated) return;
    void run('execution-status', async (revision) => {
      const result = await api.executionStatus(selectedProposalId, selectedOperationId);
      if (isCurrent(revision)) setExecution(result);
    });
  }
  function submit() {
    if (!execution || !authenticated || !submitConfirmed) return;
    const current = execution;
    void run('submit', async (revision) => {
      const idempotencyKey = await d2bIdempotencyKey('SUBMIT', current.operationId, current.submissionAttempts);
      if (!isCurrent(revision)) return;
      const result = await api.submit(current.proposalId, current.operationId, idempotencyKey);
      if (isCurrent(revision)) {
        setExecution(result);
        setSubmitConfirmed(false);
      }
    });
  }
  function reconcile() {
    const selectedProposalId = execution?.proposalId ?? recoveryProposalId.trim();
    const selectedOperationId = execution?.operationId ?? recoveryOperationId.trim();
    if (!selectedProposalId || !selectedOperationId || !authenticated) return;
    void run('recovery', async (revision) => {
      const idempotencyKey = crypto.randomUUID();
      const result = await api.reconcile(selectedProposalId, selectedOperationId, idempotencyKey);
      if (isCurrent(revision)) {
        setExecution(result);
        setRecoveryProposalId(result.proposalId);
        setRecoveryOperationId(result.operationId);
      }
    });
  }

  const decision = evaluation?.decision;
  const canReserve = !!session && authenticated && !!evaluation?.decision.approvedAmountIn &&
    (evaluation.decision.status === 'ALLOW' || evaluation.decision.status === 'RESIZE') && !evaluation.g3cExecutionId;
  const canSimulate = !!session && authenticated && !!evaluation?.g3cExecutionId &&
    evaluation.g3cStatus?.status === 'NOT_STARTED' && evaluation.decision.approvedAmountIn !== null;
  const canPrepareSign = !!proposal && !!evaluation?.sessionId && !!evaluation.g3cExecutionId && authenticated &&
    !!runtime?.executionControls.signingEnabled && !!evaluation.decision.approvedAmountIn &&
    ['ALLOW', 'RESIZE'].includes(evaluation.decision.status);
  const canSubmit = !!execution && authenticated && !!runtime?.executionControls.submissionEnabled && submitConfirmed &&
    ['SIGNED_OUTBOX', 'SUBMISSION_UNCERTAIN'].includes(execution.status);
  const canReconcile = !!execution && authenticated && !!execution.transactionHash &&
    ['SUBMISSION_UNCERTAIN', 'SUBMITTED', 'RECONCILIATION_REQUIRED', 'CONFIRMED', 'REVERTED'].includes(execution.status);

  return <section className="d2-panel" aria-labelledby="d2-heading">
    <div className="d2-heading">
      <div><p className="eyebrow">D2 / Production evidence and execution controls</p><h2 id="d2-heading">Persisted evidence → policy → G3c</h2></div>
      <span className="d2-mode-chip">{runtime?.appMode ?? 'RUNTIME CHECKING'}</span>
    </div>
    <p className="d2-intro">Displays persisted Nansen market observations with provider timestamps. This app does not dispatch Nansen calls. Policy output is paper-only; signing, transaction submission, browser wallet and Rabby remain disabled.</p>

    <div className="d2-runtime-grid">
      <div><small>Observation store</small><strong>{runtime?.nansenObservationStore ?? 'checking'}</strong></div>
      <div><small>G2 evaluation</small><strong>{runtime?.productionEvaluation ?? 'checking'}</strong></div>
      <div><small>Base RPC</small><strong>{runtime?.baseRpc ?? 'checking'}</strong></div>
      <div><small>Paid Nansen</small><strong>off · {runtime?.activeNansenCreditBudget ?? '—'} allocated credits</strong></div>
      <div><small>Live execution</small><strong>{runtime?.liveExecutionEnabled === false ? 'disabled' : 'checking'}</strong></div>
      <div><small>Signing / submission</small><strong>{runtime?.executionControls.signingEnabled ? 'signing enabled' : 'signing off'} / {runtime?.executionControls.submissionEnabled ? 'submission enabled' : 'submission off'}</strong></div>
      <div><small>Operator</small><strong>{operatorSession?.authenticated ? 'authenticated' : operatorSession?.configured ? 'login required' : 'not configured'}</strong></div>
      <div><small>RPC requests this process</small><strong>{runtime?.rpcRunBudget ? runtime.rpcRunBudget.usedRequests + ' / ' + runtime.rpcRunBudget.maxRequests + ' · ' + runtime.rpcRunBudget.recoveryReserve + ' reserved' : 'not enabled'}</strong></div>
    </div>

    <div className="d2-operator-bar">
      {authenticated ? <>
        <span>Local operator session active{operatorSession?.expiresAt ? ' until ' + new Date(operatorSession.expiresAt).toLocaleTimeString() : ''}</span>
        <button className="secondary-button" onClick={logout} disabled={busy !== null}>Log out</button>
      </> : operatorSession?.configured ? <>
        <label>Local operator credential<input type="password" value={operatorPassword} onChange={(event) => setOperatorPassword(event.target.value)} autoComplete="off" /></label>
        <button className="secondary-button" onClick={login} disabled={!operatorPassword || busy !== null}>{busy === 'operator-login' ? 'Signing in…' : 'Sign in'}</button>
      </> : <span>State-changing actions are unavailable until D2_OPERATOR_SECRET is configured outside the repository.</span>}
    </div>

    {error && <div className="d2-error" role="alert">{error}<button onClick={() => setError(null)} aria-label="Dismiss D2 error">×</button></div>}
    <div className="d2-content-grid">
      <div className="d2-evidence">
        <div className="d2-subheading"><div><p className="eyebrow">Stored source evidence</p><h3>Nansen observation batches</h3></div>
          <span className={'d2-freshness freshness-' + (evidence?.freshness ?? 'missing')}>{evidence?.freshness ?? 'unavailable'}</span></div>
        {evidence?.batches.length ? evidence.batches.map((batch) => <article className="d2-batch" key={batch.snapshotId}>
          <div className="d2-batch-title"><strong>{batch.operation.replaceAll('_', ' ')}</strong><span className={'d2-freshness freshness-' + batch.status}>{batch.status}</span></div>
          <div className="d2-batch-meta"><span>Fetched {new Date(batch.fetchedAt).toLocaleString()}</span><span>Acquired {new Date(batch.acquiredAt).toLocaleString()}</span><span>{batch.completeness} · age {Math.ceil(batch.ageMs / 1000)}s</span></div>
          <div className="d2-market-values" aria-label="Actual persisted Nansen values">
            {evidence.observations.filter((signal) => batch.observationIds.includes(signal.signalId) && signal.value !== null && signal.quality === 'COMPLETE')
              .map((signal) => <p className="d2-market-value" key={signal.signalId}>
                <strong>{signal.asset} {signal.metric.replaceAll('_', ' ')}</strong>
                <span>{nansenUsd(signal.value)} USD</span>
                <small>Observed {new Date(signal.observedAt).toLocaleString()} · Nansen {signal.endpoint.replaceAll('_', ' ')}</small>
              </p>)}
          </div>
          {batch.operation === 'TOKEN_OHLCV' && evidence.observations.filter((signal) => batch.observationIds.includes(signal.signalId) && signal.endpoint === 'TOKEN_OHLCV')
            .map((signal) => <p className="d2-candle-note" key={signal.signalId}>Recent Nansen {batch.timeframe} candle price · interval {new Date(signal.observedAt).toLocaleString()} · not an executable swap quote.</p>)}
          <div className="d2-id-list"><small>OBSERVATION IDS</small>{batch.observationIds.map((id) => <code key={id}>{id}</code>)}</div>
          <div className="d2-page-list"><small>REQUEST ATTEMPT / PAGE REFERENCES</small>{batch.pageReferences.length ? batch.pageReferences.map((page) =>
            <code key={page.attemptId + ':' + page.page}>attempt {page.attemptId} · page {page.page} · HTTP {page.status ?? '—'} · retry {page.retry} · credits {page.chargedCredits ?? 'unknown'}</code>)
            : <span>Stored without page references</span>}</div>
        </article>) : <p className="d2-empty">No qualifying persisted Nansen snapshots. G2 will require review.</p>}
      </div>

      <div className="d2-controls">
        <div className="d2-subheading"><div><p className="eyebrow">Public inputs</p><h3>Evaluation setup</h3></div></div>
        <label>Wallet public address<input value={wallet} onChange={(event) => changeWallet(event.target.value)} placeholder="0x…" autoComplete="off" /></label>
        <BrowserWalletPanel currentWallet={wallet} sessionWallet={session?.walletAddress ?? null}
          onAccountSelection={changeWallet}
          onContextInvalidated={() => { invalidateSelection(); setSession(null); clearDownstream(); }}
          api={api} proposalId={proposal?.proposalId ?? (recoveryProposalId || null)} sessionId={session?.sessionId ?? evaluation?.sessionId ?? null}
          operationId={simulation?.operationId ?? (recoveryOperationId || null)} evaluation={evaluation} simulation={simulation}
          authenticated={authenticated} browserWalletEnabled={runtime?.executionControls.browserWalletEnabled === true}
          onApprovalComplete={() => { invalidateSelection(); setSession(null); clearDownstream(); }} />
        <label>Requested amount · USDC<input value={amount} onChange={(event) => changeAmount(event.target.value)} inputMode="decimal" /></label>
        <div className="d2-button-row">
          <button className="secondary-button" onClick={startSession} disabled={!authenticated || !walletValid || !rpcReady || busy !== null}
            title={rpcReady ? 'Start a bounded read-only Base session' : 'Base read-only mode is not enabled'}>
            {busy === 'session' ? 'Reading account…' : 'Start read-only session'}
          </button>
          <button className="primary-button" onClick={createProposal} disabled={!authenticated || !walletValid || !amountMicros || !productionReady || busy !== null}>
            {busy === 'proposal' ? 'Saving…' : 'Create proposal'} <span>→</span>
          </button>
        </div>
        {session && <p className="d2-session-line">Session {shortId(session.sessionId)} · account version {session.latestAccountVersion} · {session.status}</p>}
        {!authenticated && <p className="d2-gate-note">Sign in before creating proposals, sessions or reservations.</p>}
        {!rpcReady && <p className="d2-gate-note">Base reads are gated off. No RPC request will be made from this screen.</p>}
        {!productionReady && <p className="d2-gate-note">Production observation and audit stores are not configured.</p>}
      </div>
    </div>

    {persistedAudit && <div className="d2-result-card d2-persisted-audit" aria-label="Saved paper policy audit">
      <div className="d2-subheading"><div><p className="eyebrow">Durable paper policy audit</p><h3>Recorded G2 decision</h3></div>
        <span className={'decision-chip ' + statusClass(persistedAudit.decision.status)}>{persistedAudit.decision.status}</span></div>
      <div className="d2-decision-grid"><div><small>REQUESTED</small><strong>{usd(persistedAudit.decision.requestedAmountIn)}</strong></div>
        <div><small>PERMITTED</small><strong>{usd(persistedAudit.decision.approvedAmountIn)}</strong></div>
        <div><small>MARKET EVIDENCE</small><strong>{persistedAudit.evidenceIds.length} ids · {persistedAudit.signalSource}</strong></div>
        <div><small>EXECUTION</small><strong>paper only · no transaction</strong></div></div>
      <div className="d2-reasons"><small>POLICY REASONS</small>{persistedAudit.decision.reasons.map((reason) =>
        <span className="reason-chip" key={reason}>{reason.replaceAll('_', ' ')}</span>)}</div>
      <div className="d2-audit-ids"><small>PROPOSAL / EVALUATION ID</small><code>{persistedAudit.proposalId}</code>
        <small>DECISION ID</small><code>{persistedAudit.decision.decisionId}</code>
        <small>OBSERVATION IDS</small><span>{persistedAudit.evidenceIds.length} persisted Nansen records</span></div>
    </div>}
    {proposal && <div className="d2-result-card">
      <div className="d2-subheading"><div><p className="eyebrow">Deterministic proposal · optional stored advisory reference</p><h3>Candidate and linked evidence</h3></div><span className="proposal-only">PROPOSAL ONLY</span></div>
      <p>{proposal.analysis.rationale}</p>
      <div className="d2-audit-ids"><small>PROPOSAL ID</small><code>{proposal.proposalId}</code><small>LINKED OBSERVATIONS</small>
        <span>{proposal.evidence.observationIds.length} ids · source {proposal.evidence.source} · evidence {proposal.evidence.label}</span></div>
      <StoredSemanticHandoff handoff={proposal.analysis.semanticHandoff} />
      <aside className="d2-semantic-card" aria-label="Fresh TypeSafe advisory analysis">
        <div className="d2-subheading"><div><p className="eyebrow">Optional fresh analysis · zero-call preview</p><h4>TypeSafe advisory step</h4></div>
          <span className="d2-freshness freshness-muted">authority NONE</span></div>
        <p>Preview binds persisted observations to this proposal. The preview makes zero model requests; a separate request is available only when the independent analysis gate is enabled.</p>
        {analysisPreview && <>
          <div className="d2-decision-grid"><div><small>PACKET</small><strong>{analysisPreview.status} · {analysisPreview.eligibility}</strong></div>
            <div><small>PROVENANCE</small><strong>{analysisPreview.source} · proposal {analysisPreview.proposalMatch.toLowerCase()}</strong></div>
            <div><small>MODEL</small><strong>{analysisPreview.requestedModel}</strong></div>
            <div><small>PREVIEW REQUESTS</small><strong>0</strong></div></div>
          <div className="d2-audit-ids"><small>EXACT PACKET HASH</small><code>{analysisPreview.requestHash}</code>
            <small>SNAPSHOT LINEAGE</small>{analysisPreview.inputs.length ? analysisPreview.inputs.map((input) => <code key={input.snapshotId}>{input.operation} · {input.status} · {shortId(input.snapshotId)} · {input.signalIds.length} signal ids</code>) : <span>No persisted snapshots</span>}
            <small>PREREQUISITES</small><span>{analysisPreview.missingPrerequisites.length ? analysisPreview.missingPrerequisites.map((reason) => reason.replaceAll('_', ' ').toLowerCase()).join(' · ') : 'Fresh complete evidence is linked to this proposal.'}</span>
          </div>
        </>}
        {analysisResult && <div className="d2-audit-ids"><small>ADVISORY RESULT</small><strong>{analysisResult.status} · {analysisResult.answer === null ? 'no answer' : analysisResult.answer.toFixed(3)} · {analysisResult.advisoryRoute ?? 'no route'}</strong>
          <small>REQUESTS / AUTHORITY</small><span>{analysisResult.requestsMade} · NONE</span>
          {analysisResult.attemptId && <><small>AUDIT ATTEMPT</small><code>{analysisResult.attemptId}</code></>}
          {analysisResult.recordRequestHash && <><small>RECORDED PACKET HASH</small><code>{analysisResult.recordRequestHash}</code></>}
          {analysisResult.reason && <><small>STATUS DETAIL</small><span>{analysisResult.reason.replaceAll('_', ' ').toLowerCase()}</span></>}
        </div>}
        <div className="d2-button-row">
          <button className="secondary-button" onClick={previewAnalysis} disabled={!authenticated || busy !== null}>
            {busy === 'analysis-preview' ? 'Previewing…' : 'Preview exact evidence'}
          </button>
          <button className="primary-button" onClick={invokeAnalysis} disabled={!authenticated || !analysisPreview?.canInvoke || busy !== null}
            title={analysisPreview?.canInvoke ? 'One advisory request bound to this exact packet hash' : 'Analysis gate, exact evidence, proposal match, and credential prerequisites must all be ready'}>
            {busy === 'analysis-invoke' ? 'Requesting…' : 'Request one advisory judgment'}
          </button>
        </div>
      </aside>
      <div className="d2-button-row"><button className="primary-button" onClick={evaluate} disabled={!authenticated || busy !== null}>
        {busy === 'evaluation' ? 'Evaluating…' : 'Run independent G2 policy'} <span>→</span></button></div>
    </div>}

    {evaluation && <div className="d2-result-card">
      <div className="d2-subheading"><div><p className="eyebrow">Independent deterministic control</p><h3>G2 decision</h3></div>
        <span className={'decision-chip ' + statusClass(decision?.status ?? 'waiting')}>{decision?.status ?? 'WAITING'}</span></div>
      <div className="d2-decision-grid"><div><small>REQUESTED</small><strong>{usd(decision?.requestedAmountIn)}</strong></div>
        <div><small>PERMITTED</small><strong>{usd(decision?.approvedAmountIn)}</strong></div><div><small>EVIDENCE</small><strong>{evaluation.evidenceIds.length} ids · {evaluation.signalSource}</strong></div>
        <div><small>QUOTE SOURCE</small><strong>{evaluation.quoteSource}</strong></div></div>
      <div className="d2-reasons"><small>POLICY REASONS</small>{decision?.reasons.map((reason) => <span className="reason-chip" key={reason}>{reason.replaceAll('_', ' ')}</span>)}</div>
      {evaluation.quoteBundle?.tradeQuote && <div className="d2-quote-row"><span>Trade output {evaluation.quoteBundle.tradeQuote.amountOut} atomic</span><span>Fee {usd(evaluation.quoteBundle.tradeQuote.feeUsdcMicros)}</span><span>Slippage {evaluation.quoteBundle.tradeQuote.slippageBps} bps</span></div>}
      {evaluation.g3cStatus && <div className="d2-g3c-status"><strong>G3c {evaluation.g3cStatus.status}</strong><span>execution {shortId(evaluation.g3cStatus.executionId)}</span>
        <span>{evaluation.g3cStatus.mode} · permitted {usd(evaluation.g3cStatus.permittedAmount)}</span></div>}
      <div className="d2-button-row">
        {evaluation.sessionId && <button className="secondary-button" onClick={reserve} disabled={!canReserve || busy !== null}>{busy === 'reservation' ? 'Reserving…' : 'Reserve exact amount'}</button>}
        {evaluation.sessionId && <button className="secondary-button" onClick={simulate} disabled={!canSimulate || busy !== null}>{busy === 'simulation' ? 'Simulating…' : 'Run G3c read-only simulation'}</button>}
        <button className="primary-button" onClick={() => prepareSign(execution?.kind === 'APPROVAL' && execution.status === 'CONFIRMED' ? crypto.randomUUID() : undefined)} disabled={!canPrepareSign || busy !== null}
          title={runtime?.executionControls.signingEnabled ? 'Prepare fresh G3c evidence and sign to the durable outbox' : 'D2 signing is disabled by runtime controls'}>
          {busy === 'prepare-sign' ? 'Preparing and signing…' : execution?.kind === 'APPROVAL' && execution.status === 'CONFIRMED' ? 'Prepare next swap operation' : 'Prepare & sign'}
        </button>

      </div>
      {!runtime?.executionControls.signingEnabled && <p className="d2-gate-note">Signing remains disabled until every reviewed runtime gate is explicitly enabled. A G2 decision or read-only simulation is not signing authority.</p>}
      {simulation && <div className="d2-simulation-inline">
        <strong>Read-only simulation passed</strong><span>operation {shortId(simulation.operationId)}</span>
        <span>G2 amount {usd(simulation.permittedAmount)} · simulation creates no authorization or paper fill</span>
      </div>}
    </div>}

    {(execution || proposal) && <div className="d2-result-card d2-execution-card">
      <div className="d2-subheading"><div><p className="eyebrow">Persisted G3c execution</p><h3>Outbox, separate submission and recovery</h3></div>
        {execution && <span className={'decision-chip ' + statusClass(execution.status)}>{execution.status.replaceAll('_', ' ')}</span>}</div>
      {execution ? <>
        <div className="d2-audit-ids"><small>PROPOSAL ID</small><code>{execution.proposalId}</code><small>OPERATION ID</small><code>{execution.operationId}</code>
          <small>SESSION ID</small><code>{execution.sessionId}</code><small>G3C KIND</small><strong>{execution.kind}</strong>
          <small>PERMITTED AMOUNT</small><strong>{usd(execution.permittedAmount)}</strong></div>
        <div className="d2-execution-status">
          <span>Transaction hash {execution.transactionHash ?? 'not signed'}</span>
          <span>Submission attempts {execution.submissionAttempts}</span>
          {execution.receiptOutcome && <span>Receipt outcome {execution.receiptOutcome}</span>}
          {execution.receiptBlockNumber && <span>Finalized receipt block {execution.receiptBlockNumber}</span>}
          {execution.actualFeesUsdcMicros !== null && <span>Actual fees {usd(execution.actualFeesUsdcMicros)}</span>}
        </div>
        {['SIGNED_OUTBOX', 'SUBMISSION_UNCERTAIN'].includes(execution.status) && runtime?.executionControls.submissionEnabled && <>
          <label className="d2-confirm-submit"><input type="checkbox" checked={submitConfirmed} onChange={(event) => setSubmitConfirmed(event.target.checked)} />
            {execution.status === 'SUBMISSION_UNCERTAIN' ? 'I confirm a manual retry of the exact persisted transaction' : 'I confirm submitting the exact persisted signed transaction'}
          </label>
          <button className="primary-button" onClick={submit} disabled={!canSubmit || busy !== null}>
            {busy === 'submit' ? 'Submitting exact outbox…' : execution.status === 'SUBMISSION_UNCERTAIN' ? 'Retry submission' : 'Submit signed outbox'}
          </button>
        </>}
{['SIGNED_OUTBOX', 'SUBMISSION_UNCERTAIN'].includes(execution.status) && !runtime?.executionControls.submissionEnabled && <p className="d2-gate-note">Submission is disabled by runtime controls. The exact operation can still be checked and reconciled.</p>}
        {canReconcile && <button className="secondary-button" onClick={reconcile} disabled={busy !== null}>
          {busy === 'recovery' ? 'Reconciling exact hash…' : 'Reconcile exact operation'}</button>}
      </> : <p className="d2-gate-note">No signed bytes are returned to the browser. Prepare & sign creates a validated outbox; submission is a separate confirmed action.</p>}
    </div>}

    <div className="d2-result-card d2-recovery-card">
      <div className="d2-subheading"><div><p className="eyebrow">After reload or timeout</p><h3>Recover an exact persisted operation</h3></div></div>
      <label>Proposal ID<input value={recoveryProposalId} onChange={(event) => { invalidateSelection(); setExecution(null); setSubmitConfirmed(false); setRecoveryProposalId(event.target.value.trim()); }} autoComplete="off" /></label>
      <label>Operation ID<input value={recoveryOperationId} onChange={(event) => { invalidateSelection(); setExecution(null); setSubmitConfirmed(false); setRecoveryOperationId(event.target.value.trim()); }} autoComplete="off" /></label>
      <div className="d2-button-row">
        <button className="secondary-button" onClick={recoverStatus} disabled={!authenticated || !recoveryProposalId || !recoveryOperationId || busy !== null}>Check exact operation status</button>
        {canReconcile && <button className="secondary-button" onClick={reconcile} disabled={busy !== null}>Reconcile exact receipt</button>}
      </div>
    </div>
  </section>;
}

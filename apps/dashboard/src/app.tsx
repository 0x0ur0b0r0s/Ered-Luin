import { useEffect, useMemo, useState } from 'react';
import type { D1G3cFixture, D1G3cStatusName, D1Proposal, D1Scenario } from '@ered-luin/contracts';
import { d1Api, type D1Health, type D1PaperIntentRecord } from './api-client.js';
import { D2ProductionPanel } from './d2-panel.js';

const STATUS_EXAMPLES: readonly { id: D1G3cStatusName; label: string }[] = [
  { id: 'PENDING', label: 'Pending' },
  { id: 'CONFIRMED', label: 'Confirmed' },
  { id: 'REVERTED', label: 'Reverted' },
  { id: 'UNKNOWN', label: 'Unknown' },
];
const USD_MICROS = 1_000_000;

function formatUsdMicros(value: string | null | undefined): string {
  if (!value || !/^-?(0|[1-9][0-9]*)$/u.test(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
    .format(Number(BigInt(value)) / USD_MICROS);
}
function formatAtomic(value: string | null | undefined, decimals: number): string {
  if (!value || !/^(0|[1-9][0-9]*)$/u.test(value)) return '—';
  return (Number(BigInt(value)) / 10 ** decimals).toFixed(decimals === 6 ? 2 : 6);
}
function titleForDecision(status: D1PaperIntentRecord['decision']['status'] | undefined): string {
  if (status === 'ALLOW') return 'Allowed';
  if (status === 'RESIZE') return 'Modified';
  if (status === 'BLOCK') return 'Blocked';
  if (status === 'REQUIRE_REVIEW') return 'Review required';
  return 'Awaiting policy';
}
function qualityName(quality: string): string {
  return quality === 'COMPLETE' ? 'Fresh · complete' : quality === 'MISSING' ? 'Missing' : 'Incomplete';
}
function flowValueKind(value: string | null | undefined, quality?: string): string {
  if (value === undefined) return 'MISSING';
  if (value === null) return quality === 'MISSING' ? 'MISSING' : 'INCOMPLETE';
  const amount = BigInt(value);
  return amount > 0n ? 'POSITIVE' : amount < 0n ? 'NEGATIVE' : 'ZERO';
}
export function App({ api = d1Api }: { api?: typeof d1Api } = {}) {
  const [health, setHealth] = useState<D1Health | null>(null);
  const [scenarios, setScenarios] = useState<readonly D1Scenario[]>([]);
  const [scenarioId, setScenarioId] = useState<D1Scenario['id']>('ALLOW');
  const [proposal, setProposal] = useState<D1Proposal | null>(null);
  const [paperResult, setPaperResult] = useState<D1PaperIntentRecord | null>(null);
  const [statusFixtures, setStatusFixtures] = useState<Partial<Record<D1G3cStatusName, D1G3cFixture>>>({});
  const [busy, setBusy] = useState<'proposal' | 'policy' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proposalNowMs, setProposalNowMs] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [runtime, choices] = await Promise.all([api.health(), api.scenarios()]);
        if (!active) return;
        setHealth(runtime);
        setScenarios(choices);
        const statusResults = await Promise.allSettled(STATUS_EXAMPLES.map(({ id }) => api.g3cStatus(id)));
        if (!active) return;
        const fixtures: Partial<Record<D1G3cStatusName, D1G3cFixture>> = {};
        statusResults.forEach((result, index) => {
          const name = STATUS_EXAMPLES[index]?.id;
          if (result.status === 'fulfilled' && name) fixtures[name] = result.value;
        });
        setStatusFixtures(fixtures);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Dashboard API unavailable.');
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const timer = globalThis.setInterval(() => setProposalNowMs(Date.now()), 1_000);
    return () => globalThis.clearInterval(timer);
  }, []);

  const selectedScenario = useMemo(() => scenarios.find((item) => item.id === scenarioId) ?? null, [scenarioId, scenarios]);
  const flowSignal = proposal?.evidence.observations.find((signal) =>
    signal.endpoint === 'SMART_MONEY_NETFLOW' && signal.asset === 'WETH' && signal.metric === 'net_flow_1h_usd');
  const decision = paperResult?.decision;
  const permittedAmount = decision?.approvedAmountIn;
  const didSimulate = paperResult?.execution.status === 'SIMULATED';
  const proposalExpiresAtMs = proposal ? Date.parse(proposal.intent.expiresAt) : Number.NaN;
  const proposalExpired = Boolean(proposal) && (!Number.isSafeInteger(proposalExpiresAtMs) || proposalExpiresAtMs <= proposalNowMs);
  const proposalSecondsRemaining = proposal
    ? Math.max(0, Math.ceil((proposalExpiresAtMs - proposalNowMs) / 1_000))
    : null;

  async function prepareProposal() {
    setBusy('proposal');
    setError(null);
    setProposal(null);
    setPaperResult(null);
    try { setProposal(await api.proposal(scenarioId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create a proposal.'); }
    finally { setBusy(null); }
  }

  async function evaluateProposal() {
    if (!proposal) return;
    setBusy('policy');
    setError(null);
    try {
      const submitted = await api.evaluate(proposal.proposalId);
      const persisted = await api.intent(proposal.intent.intentId);
      if (persisted.intent.intentId !== submitted.record.intent.intentId ||
          persisted.decision.decisionId !== submitted.record.decision.decisionId ||
          persisted.execution.status !== submitted.record.execution.status) {
        throw new Error('Persisted audit record does not match the evaluated result.');
      }
      setPaperResult(persisted);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Policy evaluation failed.');
    } finally { setBusy(null); }
  }

  return <main className="app-shell">
    <header className="topbar">
      <a className="brand" href="#" aria-label="Ered Luin dashboard home"><span className="brand-mark">EL</span><span>Ered Luin</span></a>
      <div className="topbar-right">
        <span className="gate-tag">D2 · Read-only + D1 replay</span>
        <span className="runtime-pill"><i />{health?.executionMode === 'PAPER' ? 'Paper mode' : 'Checking runtime'}</span>
      </div>
    </header>

    <section className="hero">
      <div>
        <p className="eyebrow">Evidence in. Independent control out.</p>
        <h1>Let the agent propose.<br /><span>Let the firewall decide.</span></h1>
        <p className="hero-copy">A production read-only evidence path with a separate synthetic replay for offline review.</p>
      </div>
      <div className="hero-stamp"><span className="stamp-orbit">↗</span><span>Offline<br />acceptance slice</span></div>
    </section>

    <section className="safety-strip" aria-label="Execution boundaries">
      <div className="safety-label"><span className="shield">✓</span><span>Runtime boundaries</span></div>
      <div className="safety-item"><small>Execution mode</small><strong>{health?.executionMode ?? '—'}</strong></div>
      <div className="safety-item"><small>Paid Nansen calls</small><strong>{health ? (health.paidNansenCallsEnabled ? 'Enabled' : 'Off · 0 credits') : 'Checking…'}</strong></div>
      <div className="safety-item"><small>Live signing</small><strong>{health ? (health.liveExecutionEnabled ? 'Enabled' : 'Disabled') : 'Checking…'}</strong></div>
      <p className="synthetic-warning">The D1 replay below is synthetic. D2 observations are separately labeled and sourced from its persisted production store.</p>
    </section>

    <D2ProductionPanel />

    {error && <div className="error-banner" role="alert"><span>!</span>{error}<button onClick={() => setError(null)} aria-label="Dismiss error">×</button></div>}

    <section className="scenario-panel" aria-labelledby="scenario-heading">
      <div className="section-heading">
        <div><p className="eyebrow">01 / Replay a scenario</p><h2 id="scenario-heading">Choose the evidence path</h2></div>
        <span className="fixture-badge"><span className="fixture-dot" />DETERMINISTIC FIXTURES</span>
      </div>
      <div className="scenario-grid">
        {scenarios.map((item, index) => <button
          className={'scenario-card ' + (scenarioId === item.id ? 'selected' : '')}
          key={item.id} disabled={busy !== null} onClick={() => { if (busy !== null) return; setScenarioId(item.id); setProposal(null); setPaperResult(null); setError(null); }}
          aria-pressed={scenarioId === item.id}
        >
          <span className="scenario-index">{String(index + 1).padStart(2, '0')}</span>
          <strong>{item.title}</strong>
          <span>{item.description}</span>
          <span className="scenario-arrow">↗</span>
        </button>)}
      </div>
      <div className="scenario-action">
        <p>{selectedScenario?.description ?? 'Load the local replay scenarios to begin.'}</p>
        <button className="primary-button" onClick={prepareProposal} disabled={!health || !selectedScenario || busy !== null}>
          {busy === 'proposal' ? 'Building replay…' : proposal ? 'Rebuild proposal' : 'Build proposal'} <span>→</span>
        </button>
      </div>
      {proposal && <div className={'proposal-expiry ' + (proposalExpired ? 'proposal-expiry-ended' : '')} role={proposalExpired ? 'alert' : 'status'}>
        {proposalExpired
          ? <>This proposal expired at <time dateTime={proposal.intent.expiresAt}>{proposal.intent.expiresAt}</time>. Rebuild proposal before running the firewall.</>
          : <>Proposal expires in {proposalSecondsRemaining} {proposalSecondsRemaining === 1 ? 'second' : 'seconds'} · <time dateTime={proposal.intent.expiresAt}>{proposal.intent.expiresAt}</time></>}
      </div>}
    </section>

    <div className="flow-grid">
      <div className="flow-main">
        <section className="flow-card evidence-card" aria-labelledby="evidence-heading">
          <div className="card-heading">
            <div className="step-heading"><span className="step-number">02</span><div><p className="eyebrow">Source → analysis</p><h2 id="evidence-heading">Observation &amp; rationale</h2></div></div>
            <span className="source-chip">{proposal?.evidence.label ?? 'SYNTHETIC FIXTURE'}</span>
          </div>
          {!proposal ? <div className="empty-state"><span className="empty-icon">⌁</span><p>Select a scenario to load its normalized observations.</p></div> : <>
            <div className="flow-spotlight">
              <div className="spotlight-icon">↗</div>
              <div className="spotlight-data">
                <div className="spotlight-title"><strong>WETH · Smart Money netflow</strong><span className={'quality-chip ' + (flowSignal?.quality === 'COMPLETE' ? 'quality-good' : 'quality-muted')}>{flowSignal ? qualityName(flowSignal.quality) : 'Missing'}</span></div>
                <b>{flowSignal?.value === null || !flowSignal ? '—' : formatUsdMicros(flowSignal.value)}</b>
                <small>1 hour · {flowSignal?.observedAt ? new Date(flowSignal.observedAt).toLocaleString() : 'No observation time'}</small>
              </div>
              <span className="signal-change">{flowValueKind(flowSignal?.value, flowSignal?.quality)}</span>
            </div>
            <div className="analysis-box">
              <span className="analysis-mark">✳</span>
              <div><div className="analysis-meta"><strong>Agent analysis</strong><span>DETERMINISTIC REPLAY · {proposal.analysis.version}</span></div>
                <p>{proposal.analysis.rationale}</p>
                <small>TypeSafe: {proposal.analysis.semantic.status.toLowerCase().replaceAll('_', ' ')} · advisory authority only</small>
              </div>
            </div>
            <details className="observation-details">
              <summary>View all {proposal.evidence.observations.length} normalized observations</summary>
              <div className="observation-list">{proposal.evidence.observations.map((signal) => <div className="observation-row" key={signal.signalId}>
                <div><strong>{signal.asset} · {signal.metric.replaceAll('_', ' ')}</strong><small>{signal.endpoint} · observed {new Date(signal.observedAt).toLocaleTimeString()}</small></div>
                <span className={signal.quality === 'COMPLETE' ? 'value-good' : 'value-muted'}>{signal.value === null ? '—' : signal.unit === 'usd_micros' ? formatUsdMicros(signal.value) : signal.value}</span>
                <code>{signal.signalId.slice(0, 8)}…</code>
              </div>)}</div>
            </details>
          </>}
        </section>

        <section className="flow-card proposal-card" aria-labelledby="proposal-heading">
          <div className="card-heading">
            <div className="step-heading"><span className="step-number">03</span><div><p className="eyebrow">Agent proposal</p><h2 id="proposal-heading">Proposed trade</h2></div></div>
            {proposal && <span className="proposal-only">PROPOSAL ONLY</span>}
          </div>
          {!proposal ? <div className="empty-state compact"><p>The proposal will appear here with its evidence links.</p></div> : <div className="trade-row">
            <div className="trade-pair"><span className="asset-icon usdc">＄</span><span className="trade-arrow">→</span><span className="asset-icon weth">◇</span><div><strong>USDC <span>→</span> WETH</strong><small>Base · synthetic paper wallet</small></div></div>
            <div className="trade-amount"><small>REQUESTED</small><strong>{formatAtomic(proposal.intent.amountIn, 6)} <span>USDC</span></strong></div>
            <div className="trade-link"><small>LINKED OBSERVATIONS</small><strong>{proposal.evidence.observationIds.length} signals</strong></div>
          </div>}
        </section>

        <section className={'flow-card firewall-card ' + (decision ? 'decision-' + decision.status.toLowerCase() : '')} aria-labelledby="firewall-heading">
          <div className="card-heading">
            <div className="step-heading"><span className="step-number">04</span><div><p className="eyebrow">Independent control</p><h2 id="firewall-heading">Ered Luin firewall</h2></div></div>
            <span className={'decision-chip ' + (decision ? decision.status.toLowerCase() : 'waiting')}>{decision ? titleForDecision(decision.status) : 'Not evaluated'}</span>
          </div>
          {!proposal ? <div className="empty-state compact"><p>Build a proposal before policy evaluation.</p></div> : !paperResult ? <div className="firewall-ready">
            <div><strong>G2 policy is ready</strong><small>The proposal cannot set policy, execution mode, or signing authority.</small></div>
            <button className="primary-button" onClick={evaluateProposal} disabled={busy !== null || proposalExpired}>
              {busy === 'policy' ? 'Evaluating…' : 'Run firewall'} <span>→</span>
            </button>
          </div> : <>
            <div className="amount-comparison">
              <div><small>REQUESTED AMOUNT</small><strong>{formatAtomic(decision?.requestedAmountIn, 6)} <span>USDC</span></strong></div>
              <span className="comparison-arrow">→</span>
              <div><small>PERMITTED AMOUNT</small><strong>{permittedAmount ? formatAtomic(permittedAmount, 6) + ' USDC' : 'None'}</strong></div>
              {decision?.status === 'RESIZE' && <span className="modify-pill">MODIFY</span>}
            </div>
            <div className="decision-reasons"><small>POLICY REASONS</small><div>{decision?.reasons.length ? decision.reasons.map((reason) => <span className="reason-chip" key={reason}>{reason.replaceAll('_', ' ')}</span>) : <span className="reason-chip reason-ok">All required checks passed</span>}</div></div>
            <div className="paper-outcome">
              <span className={'outcome-icon ' + (didSimulate ? 'outcome-yes' : 'outcome-no')}>{didSimulate ? '✓' : '—'}</span>
              <div><strong>{didSimulate ? 'Paper simulation recorded' : 'No simulated fill'}</strong><small>{didSimulate ? 'Synthetic quote · account projection updated in the paper store.' : 'Block and review decisions create no fill and no account movement.'}</small></div>
              <span className="paper-tag">PAPER ONLY</span>
            </div>
          </>}
        </section>

        {paperResult && <section className="flow-card audit-card" aria-labelledby="audit-heading">
          <div className="card-heading">
            <div className="step-heading"><span className="step-number">05</span><div><p className="eyebrow">Persisted result</p><h2 id="audit-heading">Audit record</h2></div></div>
            <span className="saved-chip"><i />Retrieved from paper store</span>
          </div>
          <div className="audit-grid">
            <div><small>INTENT ID</small><code>{paperResult.intent.intentId}</code></div>
            <div><small>DECISION ID</small><code>{paperResult.decision.decisionId}</code></div>
            <div><small>RECORDED AT</small><strong>{new Date(paperResult.decision.evaluatedAt).toLocaleString()}</strong></div>
            <div><small>SOURCE / QUOTE</small><strong>{paperResult.signalSource} / {paperResult.quoteSource}</strong></div>
          </div>
          <div className="audit-signals"><small>POLICY EVIDENCE IDS</small><div>{paperResult.signalIds.length ? paperResult.signalIds.map((id) => <code key={id}>{id}</code>) : <span>No usable observations linked</span>}</div></div>
        </section>}
      </div>

      <aside className="flow-aside">
        <section className="aside-card" aria-labelledby="timeline-heading">
          <p className="eyebrow">D1 demo path</p><h2 id="timeline-heading">One visible handoff</h2>
          <ol className="timeline">
            <li className={proposal ? 'complete' : 'current'}><span>1</span><div><strong>Nansen observations</strong><small>Source, time, completeness</small></div></li>
            <li className={proposal ? 'current' : ''}><span>2</span><div><strong>Proposal &amp; rationale</strong><small>Evidence-linked, deterministic</small></div></li>
            <li className={paperResult ? 'complete' : proposal ? 'current' : ''}><span>3</span><div><strong>G2 firewall</strong><small>Allow, modify, block, review</small></div></li>
            <li className={paperResult ? 'complete' : ''}><span>4</span><div><strong>Paper audit</strong><small>Persisted result retrieval</small></div></li>
          </ol>
          <div className="aside-note"><span>i</span><p>Friday’s real-capital acceptance still needs the reviewed live path, real Nansen evidence, provider quotes and deployment checks.</p></div>
        </section>

        <section className="aside-card g3c-card" aria-labelledby="g3c-heading">
          <div className="aside-card-heading"><div><p className="eyebrow">Execution status contract</p><h2 id="g3c-heading">G3c examples</h2></div><span className="fixture-mini">FIXTURES</span></div>
          <p className="aside-copy">Typed examples only. They are not receipts, fills, or live execution.</p>
          <div className="status-list">{STATUS_EXAMPLES.map(({ id, label }) => {
            const fixture = statusFixtures[id];
            return <div className="status-example" key={id}>
              <span className={'status-dot status-' + id.toLowerCase()} />
              <strong>{label}</strong>
              <span>{fixture?.status.mode === 'LIVE_DISABLED' ? 'synthetic' : 'loading'}</span>
              <small>{fixture?.status.transactionHash ? fixture.status.transactionHash.slice(0, 10) + '…' : 'No transaction hash'}</small>
            </div>;
          })}</div>
          <div className="receipt-distinction"><span>≠</span><p><strong>Paper fills ≠ chain receipts</strong><br />A simulated fill is local arithmetic. A receipt is chain evidence.</p></div>
        </section>

        <section className="aside-card controls-card">
          <p className="eyebrow">Runtime safety</p>
          <div className="control-line"><span className="control-check">✓</span><span>Paid API budget</span><strong>0</strong></div>
          <div className="control-line"><span className="control-check">✓</span><span>Base RPC state</span><strong>See D2 runtime</strong></div>
          <div className="control-line"><span className="control-check">✓</span><span>Live transaction signing</span><strong>{health?.liveExecutionEnabled === false ? 'Disabled' : 'Checking'}</strong></div>
        </section>
      </aside>
    </div>
    <footer><span>ERED LUIN · D2 READ-ONLY + D1 REPLAY</span><span>D2 pending review · synthetic replay clearly labeled</span></footer>
  </main>;
}

import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalJson, d2EvidenceResponseSchema, d2ProposalRequestSchema, d2ProposalSchema, d2EvaluationSchema, d2SessionResponseSchema, d2SimulationSchema,
  type D2EvidenceResponse, type D2ObservationBatch, type D2Proposal, type D2Evaluation, type D2Simulation, type D2SemanticHandoff,
} from '@ered-luin/contracts';
import { G2_LIMITS, evaluateG2Intent, type G2Evaluation, type PaperAccountSnapshot } from './policy.js';
import { evaluateWithResizeQuotes, parseQuoteBundle, type G2DataProvider } from './api.js';
import { D2AuditStore } from './d2-audit-store.js';
import type { ObservationSnapshot } from '@ered-luin/nansen';
import type { ExecutionTransactionEnvelope } from '@ered-luin/contracts';
import type { G2QuoteBundle } from './policy.js';
import type { ExecutionStore } from './execution-store.js';
import type { D2G3cGateway } from './d2-g3c-gateway.js';
import type { G3cStatusResponse, NormalizedSignal } from '@ered-luin/contracts';
import { g3bUnsignedTransactionHash } from './g3b-transaction.js';
import { resolveD2SemanticHandoff } from './d2-analysis-handoff.js';
import type { G1DShadowAuditStore } from '@ered-luin/nansen';

export interface D2ObservationReader {
  getLatestSnapshots(source: 'nansen' | 'synthetic'): readonly ObservationSnapshot[];
}
export interface D2PolicyProvider extends G2DataProvider {
  getAccountSnapshot(intent: D2Proposal['intent'], sessionId?: string): Promise<PaperAccountSnapshot | null> | PaperAccountSnapshot | null;
  getExecutionTransaction?(intent: D2Proposal['intent'], accountVersion: number): ExecutionTransactionEnvelope | null;
}
export interface D2ProductionService {
  evidence(): D2EvidenceResponse;
  createProposal(input: unknown): D2Proposal;
  proposal(proposalId: string): D2Proposal | null;
  evaluation(proposalId: string): D2Evaluation | null;
  evaluate(proposalId: string, sessionId?: string): Promise<D2Evaluation>;
  startSession(input: { readonly sessionId: string; readonly walletAddress: string; readonly reason: string }): Promise<ReturnType<typeof d2SessionResponseSchema.parse>>;
  reserve(proposalId: string, sessionId: string): D2Evaluation;
  simulation(proposalId: string, operationId?: string): D2Simulation | null;
  simulate(proposalId: string, sessionId: string, operationId: string): Promise<D2Simulation>;
  reconcile(proposalId: string, operationId: string): Promise<D2Evaluation>;
  close(): void;
}
const EMPTY_PROVIDER: G2DataProvider = Object.freeze({ getSignals: () => [], getQuoteBundle: () => null });

function checkedNow(clock: () => Date): Date {
  let now: Date;
  try { now = clock(); } catch { throw new Error('D2_CLOCK_UNAVAILABLE'); }
  if (!(now instanceof Date) || !Number.isSafeInteger(now.getTime()) || now.getTime() < 0) throw new Error('D2_CLOCK_UNAVAILABLE');
  return now;
}
function isG2Evidence(signal: NormalizedSignal): boolean {
  return (signal.endpoint === 'TOKEN_SCREENER' &&
      ((signal.asset === 'USDC' || signal.asset === 'WETH') && signal.metric === 'price_usd')) ||
    (signal.endpoint === 'SMART_MONEY_NETFLOW' && signal.asset === 'WETH' && signal.metric === 'net_flow_1h_usd');
}
function batchFromSnapshot(snapshot: ObservationSnapshot, now: Date): D2ObservationBatch {
  const fetchedMs = Date.parse(snapshot.fetchedAt);
  const acquiredMs = Date.parse(snapshot.acquiredAt);
  const expiresMs = Date.parse(snapshot.expiresAt);
  const ageMs = Math.max(0, now.getTime() - fetchedMs);
  const freshnessBound = snapshot.operation === 'SMART_MONEY_NETFLOW' ? 35 * 60_000 : 10 * 60_000;
  const timeValid = Number.isSafeInteger(fetchedMs) && Number.isSafeInteger(acquiredMs) && fetchedMs <= now.getTime() &&
    acquiredMs <= now.getTime() && expiresMs > now.getTime() && now.getTime() - fetchedMs <= freshnessBound;
  const status = snapshot.failure ? 'failed' : snapshot.completeness !== 'complete' ? 'incomplete' : timeValid ? 'fresh' : 'stale';
  return {
    snapshotId: snapshot.snapshotId, operation: snapshot.operation, source: 'nansen', status,
    completeness: snapshot.completeness, fetchedAt: snapshot.fetchedAt, acquiredAt: snapshot.acquiredAt, expiresAt: snapshot.expiresAt,
    ageMs, pageBound: snapshot.pageBound, retryBound: snapshot.retryBound, pageReferences: [...snapshot.pageReferences],
    observationIds: snapshot.signals.filter(isG2Evidence).map((signal) => signal.signalId), unavailableFields: [...snapshot.unavailableFields],
  };
}
function evidenceFrom(snapshots: readonly ObservationSnapshot[], now: Date): D2EvidenceResponse {
  const nansenSnapshots = snapshots.filter((snapshot) => snapshot.source === 'nansen').slice(0, 3);
  const batches = nansenSnapshots.map((snapshot) => batchFromSnapshot(snapshot, now));
  const observations = nansenSnapshots.flatMap((snapshot) => snapshot.signals.filter(isG2Evidence));
  const required = [
    observations.find((signal) => signal.endpoint === 'TOKEN_SCREENER' && signal.asset === 'USDC' && signal.metric === 'price_usd'),
    observations.find((signal) => signal.endpoint === 'TOKEN_SCREENER' && signal.asset === 'WETH' && signal.metric === 'price_usd'),
    observations.find((signal) => signal.endpoint === 'SMART_MONEY_NETFLOW' && signal.asset === 'WETH' && signal.metric === 'net_flow_1h_usd'),
  ];
  const statusBySnapshot = new Map(batches.map((batch) => [batch.snapshotId, batch.status]));
  const batchBySignalId = new Map(batches.flatMap((batch) => batch.observationIds.map((id) => [id, batch] as const)));
  const freshness = required.some((signal) => !signal) ? 'missing'
    : required.some((signal) => statusBySnapshot.get(batchBySignalId.get(signal!.signalId)?.snapshotId ?? '') === 'stale') ? 'stale'
      : required.some((signal) => statusBySnapshot.get(batchBySignalId.get(signal!.signalId)?.snapshotId ?? '') !== 'fresh' ||
          signal!.quality !== 'COMPLETE' || signal!.value === null) ? 'incomplete' : 'fresh';
  return d2EvidenceResponseSchema.parse({
    source: 'nansen', label: 'PERSISTED NANSEN OBSERVATIONS', observations, batches, freshness,
  });
}
function rationale(evidence: D2EvidenceResponse): string {
  if (evidence.freshness !== 'fresh') {
    return 'Persisted Nansen evidence is ' + evidence.freshness + '. This deterministic candidate is shown for independent G2 review; missing or stale observations cannot authorize execution.';
  }
  const flow = evidence.observations.find((signal) =>
    signal.endpoint === 'SMART_MONEY_NETFLOW' && signal.asset === 'WETH' && signal.metric === 'net_flow_1h_usd');
  if (!flow || flow.value === null) return 'Nansen flow evidence is unavailable. This deterministic candidate carries the stored observation links; G2 remains authoritative and fails closed.';
  const value = BigInt(flow.value);
  return value > 0n
    ? 'The stored one-hour WETH netflow is positive. This deterministic rule presents a small USDC-to-WETH candidate; independent G2 policy decides whether it may proceed.'
    : 'The stored one-hour WETH netflow is nonpositive. This deterministic rule presents the evidence for independent G2 blocking or review; it does not assert a trade direction.';
}
function semanticUnavailable(reason: Extract<D2SemanticHandoff, { status: 'UNAVAILABLE' }>['reason']): D2SemanticHandoff {
  return { status: 'UNAVAILABLE', provider: 'none', authority: 'NONE', source: 'none', reason };
}
function proposalEvidenceHash(proposal: D2Proposal): string {
  return createHash('sha256').update(canonicalJson(proposal.evidence), 'utf8').digest('hex');
}
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function policyResultToD2(proposal: D2Proposal, result: G2Evaluation, createdAt: string, sessionId: string | undefined, account: PaperAccountSnapshot | null,
  quoteBundle: G2QuoteBundle | null, executionTransaction: ExecutionTransactionEnvelope | null): D2Evaluation {
  return d2EvaluationSchema.parse({
    proposalId: proposal.proposalId, intent: proposal.intent, decision: result.decision,
    evidenceIds: proposal.evidence.observationIds, evidenceBatches: proposal.evidence.batches,
    signalSource: result.signalSource === 'nansen' ? 'nansen' : 'none',
    quoteSource: result.quoteSource === 'pool' || result.quoteSource === 'synthetic' ? result.quoteSource : 'none',
    sessionId: sessionId ?? null, accountVersion: account?.version ?? null, quoteBundle, executionTransaction,
    g3cExecutionId: null, g3cStatus: null, executionMode: 'READ_ONLY', paperFillCreated: false, createdAt, replayed: false,
  });
}

export function createD2ProductionService(input: {
  readonly observations: D2ObservationReader;
  readonly audit: D2AuditStore;
  readonly policyProvider?: D2PolicyProvider;
  readonly executionStore?: ExecutionStore;
  readonly g3cStatusReader?: { status(executionId: string): G3cStatusResponse };
  readonly g3cGateway?: D2G3cGateway;
  readonly g1dAuditStore?: Pick<G1DShadowAuditStore, 'listRecent' | 'getAttempt' | 'close'>;
  readonly g1dAnalysisHandoffEnabled?: boolean;
  readonly clock?: () => Date;
}): D2ProductionService {
  const clock = input.clock ?? (() => new Date());
  const getEvidence = () => evidenceFrom(input.observations.getLatestSnapshots('nansen'), checkedNow(clock));
  return Object.freeze({
    evidence: getEvidence,
    createProposal(raw: unknown) {
      const parsed = d2ProposalRequestSchema.safeParse(raw);
      if (!parsed.success || BigInt(parsed.success ? parsed.data.requestedUsdcMicros : '0') > G2_LIMITS.walletValueUsdcMicros) {
        throw new Error('D2_PROPOSAL_REQUEST_INVALID');
      }
      const now = checkedNow(clock);
      const proposalId = randomUUID();
      const snapshots = input.observations.getLatestSnapshots('nansen');
      const evidence = evidenceFrom(snapshots, now);
      const semanticHandoff = input.g1dAnalysisHandoffEnabled === true
        ? semanticUnavailable('NO_MATCHING_JUDGMENT')
        : semanticUnavailable('HANDOFF_DISABLED');
      const proposal = d2ProposalSchema.parse({
        proposalId, createdAt: now.toISOString(),
        intent: {
          intentId: proposalId, walletAddress: parsed.data.walletAddress.toLowerCase(), chainId: 8453,
          sellAsset: 'USDC', buyAsset: 'WETH', amountIn: parsed.data.requestedUsdcMicros,
          issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        },
        analysis: {
          source: 'DETERMINISTIC_EVIDENCE_RULES', version: 'd2-rule-v1', rationale: rationale(evidence),
          semanticStatus: input.g1dAnalysisHandoffEnabled === true ? semanticHandoff.status : 'NOT_CONFIGURED',
          semanticAuthority: 'NONE', semanticHandoff,
        },
        evidence: {
          source: evidence.source, label: evidence.label, observations: evidence.observations,
          observationIds: evidence.observations.map((signal) => signal.signalId), batches: evidence.batches,
        },
      });
      return input.audit.saveProposal(proposal);
    },
    proposal(proposalId: string) {
      const persisted = input.audit.getProposal(proposalId);
      if (!persisted || input.g1dAnalysisHandoffEnabled !== true || !input.g1dAuditStore) return persisted;
      try {
        const association = input.audit.getSemanticAssociation(proposalId);
        if (!association) return persisted;
        const unavailable = (reason: Extract<D2SemanticHandoff, { status: 'UNAVAILABLE' }>['reason']) =>
          d2ProposalSchema.parse({ ...persisted, analysis: { ...persisted.analysis, semanticStatus: 'UNAVAILABLE',
            semanticHandoff: semanticUnavailable(reason) } });
        if (association.evidenceHash !== proposalEvidenceHash(persisted)) return unavailable('NO_MATCHING_JUDGMENT');
        const now = checkedNow(clock);
        const snapshots = input.observations.getLatestSnapshots('nansen');
        const currentEvidence = evidenceFrom(snapshots, now);
        const sameProposalEvidence = sameIds(persisted.evidence.batches.map((batch) => batch.snapshotId),
          snapshots.filter((snapshot) => snapshot.source === 'nansen').map((snapshot) => snapshot.snapshotId)) &&
          sameIds(persisted.evidence.observationIds, currentEvidence.observations.map((signal) => signal.signalId));
        if (!sameProposalEvidence) return unavailable(currentEvidence.freshness === 'fresh' ? 'NO_MATCHING_JUDGMENT' : 'EVIDENCE_STALE');
        const record = input.g1dAuditStore.getAttempt(association.attemptId);
        if (!record || record.attemptId !== association.attemptId || record.requestHash !== association.requestHash ||
            record.status !== 'OBSERVED' || record.requestsMade !== 1) return unavailable('NO_MATCHING_JUDGMENT');
        const handoff = resolveD2SemanticHandoff({ records: [record], snapshots, evidenceFreshness: currentEvidence.freshness, now });
        if (handoff.status !== 'OBSERVED' || handoff.requestHash !== association.requestHash) {
          return d2ProposalSchema.parse({ ...persisted, analysis: { ...persisted.analysis, semanticStatus: handoff.status,
            semanticHandoff: handoff } });
        }
        return d2ProposalSchema.parse({ ...persisted, analysis: { ...persisted.analysis,
          semanticStatus: handoff.status, semanticHandoff: handoff } });
      } catch {
        return d2ProposalSchema.parse({ ...persisted, analysis: { ...persisted.analysis,
          semanticStatus: 'UNAVAILABLE', semanticHandoff: semanticUnavailable('AUDIT_UNAVAILABLE') } });
      }
    },
    evaluation(proposalId: string) { return input.audit.getEvaluation(proposalId); },
    simulation(proposalId: string, operationId?: string) { return input.audit.getSimulation(proposalId, operationId); },
    async evaluate(proposalId: string, sessionId?: string) {
      const prior = input.audit.getEvaluation(proposalId);
      if (prior) return d2EvaluationSchema.parse({ ...prior, replayed: true });
      const proposal = input.audit.getProposal(proposalId);
      if (!proposal) throw new Error('D2_PROPOSAL_NOT_FOUND');
      const policyProvider = input.policyProvider ?? EMPTY_PROVIDER;
      let account: PaperAccountSnapshot | null = null;
      let initialQuotes: G2QuoteBundle | null = null;
      if (input.policyProvider) {
        try { account = await input.policyProvider.getAccountSnapshot(proposal.intent, sessionId); }
        catch { account = null; }
      }
      if (account) {
        try { initialQuotes = parseQuoteBundle(await policyProvider.getQuoteBundle(proposal.intent, account), account); }
        catch { initialQuotes = null; }
      }
      const now = checkedNow(clock);
      const signals = proposal.evidence.observations;
      let evaluation: G2Evaluation;
      let finalQuotes = initialQuotes;
      if (account) {
        const checked = await evaluateWithResizeQuotes(proposal.intent, signals, account, initialQuotes, now, policyProvider, () => checkedNow(clock));
        evaluation = checked.evaluation;
        finalQuotes = checked.quotes;
      } else evaluation = evaluateG2Intent({ intent: proposal.intent, signals, account: null, quotes: null, now });
      let executionTransaction: ExecutionTransactionEnvelope | null = null;
      const approved = evaluation.decision.approvedAmountIn;
      if (account && approved && ['ALLOW', 'RESIZE'].includes(evaluation.decision.status) && input.policyProvider?.getExecutionTransaction) {
        try { executionTransaction = input.policyProvider.getExecutionTransaction({ ...proposal.intent, amountIn: approved }, account.version); }
        catch { executionTransaction = null; }
        if (executionTransaction && (executionTransaction.amountIn !== approved ||
            executionTransaction.walletAddress.toLowerCase() !== proposal.intent.walletAddress.toLowerCase())) executionTransaction = null;
      }
      return input.audit.recordEvaluation(policyResultToD2(proposal, evaluation, now.toISOString(), sessionId, account,
        finalQuotes, executionTransaction));
    },
    async startSession(session: { readonly sessionId: string; readonly walletAddress: string; readonly reason: string }) {
      if (!input.g3cGateway) throw new Error('D2_G3C_SESSION_START_UNAVAILABLE');
      const started = await input.g3cGateway.startSession(session);
      return d2SessionResponseSchema.parse({ sessionId: started.sessionId, walletAddress: started.walletAddress, status: started.status,
        initialEquityUsdcMicros: started.initialEquityUsdcMicros, latestAccountVersion: started.latestAccountVersion, createdAt: started.createdAt });
    },
    reserve(proposalId: string, sessionId: string) {
      if (!input.executionStore || !input.g3cStatusReader || !input.g3cGateway) throw new Error('D2_EXECUTION_RESERVATION_UNAVAILABLE');
      const proposal = input.audit.getProposal(proposalId);
      const evaluation = input.audit.getEvaluation(proposalId);
      if (!proposal || !evaluation) throw new Error('D2_EVALUATION_NOT_FOUND');
      if (evaluation.g3cExecutionId) return d2EvaluationSchema.parse({ ...evaluation, replayed: true });
      if (!evaluation.sessionId || evaluation.sessionId !== sessionId) throw new Error('D2_SESSION_IDENTITY_MISMATCH');
      input.g3cGateway.assertActiveSession(sessionId, proposal.intent.walletAddress);
      if (!['ALLOW', 'RESIZE'].includes(evaluation.decision.status) || !evaluation.decision.approvedAmountIn) throw new Error('D2_POLICY_NOT_EXECUTABLE');
      if (Date.parse(proposal.intent.expiresAt) <= checkedNow(clock).getTime()) throw new Error('D2_INTENT_EXPIRED_REQUIRES_NEW_PROPOSAL');
      const tx = evaluation.executionTransaction;
      if (!tx || evaluation.accountVersion === null || tx.amountIn !== evaluation.decision.approvedAmountIn ||
          tx.walletAddress.toLowerCase() !== proposal.intent.walletAddress.toLowerCase()) throw new Error('D2_EXECUTION_PLAN_UNAVAILABLE');
      const executionId = proposal.proposalId;
      input.executionStore.reserve({
        executionId, intent: proposal.intent, decision: evaluation.decision, accountVersion: evaluation.accountVersion,
        reservationExposureUsdcMicros: evaluation.decision.approvedAmountIn, transaction: tx,
        reason: 'D2 exact G2-approved amount reserved for G3c preparation',
      });
      const status = input.g3cStatusReader.status(executionId);
      return input.audit.attachG3cStatus(proposalId, status);
    },
    async simulate(proposalId: string, sessionId: string, operationId: string) {
      if (!input.g3cGateway || !input.executionStore || !input.g3cStatusReader) throw new Error('D2_G3C_SIMULATION_UNAVAILABLE');
      const prior = input.audit.getSimulation(proposalId, operationId);
      if (prior) return prior;
      const proposal = input.audit.getProposal(proposalId);
      const evaluation = input.audit.getEvaluation(proposalId);
      if (!proposal || !evaluation || !evaluation.g3cExecutionId) throw new Error('D2_EXECUTION_NOT_RESERVED');
      if (evaluation.sessionId !== sessionId) throw new Error('D2_SESSION_IDENTITY_MISMATCH');
      input.g3cGateway.assertActiveSession(sessionId, proposal.intent.walletAddress);
      const policyTransaction = evaluation.executionTransaction;
      if (!['ALLOW', 'RESIZE'].includes(evaluation.decision.status) || !evaluation.decision.approvedAmountIn || !policyTransaction ||
          policyTransaction.amountIn !== evaluation.decision.approvedAmountIn) throw new Error('D2_POLICY_NOT_EXECUTABLE');
      const currentStatus = input.g3cStatusReader.status(evaluation.g3cExecutionId);
      if (currentStatus.executionId !== evaluation.g3cExecutionId || currentStatus.status !== 'NOT_STARTED') {
        throw new Error('D2_EXECUTION_NOT_SIMULATABLE');
      }
      const result = await input.g3cGateway.simulate({ executionId: evaluation.g3cExecutionId, operationId, sessionId });
      const transactionHash = g3bUnsignedTransactionHash(result.transaction);
      const transactionDigest = createHash('sha256').update(canonicalJson(result.transaction)).digest('hex');
      const simulationEvidence = result.simulation.payload;
      const feeEvidence = result.fee.payload;
      const quoteEvidence = result.quote?.payload;
      if (simulationEvidence.kind !== 'SIMULATION' || simulationEvidence.transactionDigest !== transactionDigest ||
          simulationEvidence.unsignedTransactionHash.toLowerCase() !== transactionHash.toLowerCase() || feeEvidence.kind !== 'BASE_FEE' ||
          feeEvidence.unsignedTransactionHash.toLowerCase() !== transactionHash.toLowerCase() || quoteEvidence?.kind !== 'QUOTE' ||
          quoteEvidence.amountIn !== policyTransaction.amountIn) throw new Error('D2_SIMULATION_TRANSACTION_EVIDENCE_MISMATCH');
      const simulation = d2SimulationSchema.parse({
        proposalId, executionId: evaluation.g3cExecutionId, operationId, sessionId, walletAddress: proposal.intent.walletAddress,
        accountVersion: result.accountVersion, requestedAmount: evaluation.decision.requestedAmountIn,
        permittedAmount: evaluation.decision.approvedAmountIn, policyTransaction, transaction: result.transaction,
        quote: result.quote, simulation: result.simulation, fee: result.fee,
        status: 'SIMULATED', executionMode: 'READ_ONLY', authorizationCreated: false,
        signerInvocations: 0, broadcasterInvocations: 0, createdAt: checkedNow(clock).toISOString(),
      });
      return input.audit.recordSimulation(simulation);
    },
    async reconcile(proposalId: string, operationId: string) {
      if (!input.g3cGateway || !input.g3cStatusReader) throw new Error('D2_G3C_RECOVERY_UNAVAILABLE');
      const evaluation = input.audit.getEvaluation(proposalId);
      if (!evaluation?.g3cExecutionId) throw new Error('D2_EXECUTION_NOT_RESERVED');
      const current = input.g3cStatusReader.status(evaluation.g3cExecutionId);
      if (current.executionId !== evaluation.g3cExecutionId || !['LIVE_DISABLED', 'LIVE_REVIEWED'].includes(current.mode)) throw new Error('D2_RECOVERY_EXECUTION_MISMATCH');
      const exactWorkflow = input.g3cGateway.getWorkflow?.(operationId);
      if (exactWorkflow && exactWorkflow.executionId !== evaluation.g3cExecutionId) throw new Error('D2_RECOVERY_EXECUTION_MISMATCH');
      if (exactWorkflow && ['CONFIRMED', 'REVERTED', 'CANCELLED'].includes(exactWorkflow.status)) {
        return current.transactionHash?.toLowerCase() === exactWorkflow.transactionHash?.toLowerCase()
          ? input.audit.attachG3cStatus(proposalId, current)
          : evaluation;
      }
      if (exactWorkflow && !['SUBMISSION_UNCERTAIN', 'SUBMITTED', 'RECONCILIATION_REQUIRED'].includes(exactWorkflow.status)) {
        throw new Error('D2_RECOVERY_NOT_PENDING');
      }
      if (!exactWorkflow) {
        if (current.status === 'CONFIRMED' || current.status === 'REVERTED') return input.audit.attachG3cStatus(proposalId, current);
        if (!['PENDING', 'UNKNOWN', 'RECONCILIATION_REQUIRED'].includes(current.status)) throw new Error('D2_RECOVERY_NOT_PENDING');
      }
      await input.g3cGateway.reconcile({ executionId: evaluation.g3cExecutionId, operationId,
        reason: 'D2 recovery of an already-submitted uncertain operation; no new authorization is created' });
      return input.audit.attachG3cStatus(proposalId, input.g3cGateway.status(evaluation.g3cExecutionId));
    },
    close() { input.policyProvider?.close?.(); input.g1dAuditStore?.close(); input.audit.close(); },
  });
}

import {
  canonicalJson, d2BrowserExecutionActionResponseSchema, d2BrowserAllowancePreflightResponseSchema,
  type D2BrowserExecutionActionResponse, type D2BrowserAllowancePreflightResponse,
} from '@ered-luin/contracts';
import type { D2ProductionService } from './d2-production.js';
import type { G3cExecutionStore } from './g3c-execution-store.js';
import type { G3cReadOnlyBaseProvider } from './g3c-base-provider.js';
import type { G3bUnsignedTransaction } from '@ered-luin/contracts';
import { decodeFunctionData, parseAbi } from 'viem';
import { BASE_TOKENS, BASE_UNISWAP_V3 } from './base-allowlist.js';
import { prepareBaseG3cOperation } from './g3c-orchestrator.js';

export type D2BrowserExecutionRequest = {
  readonly proposalId: string; readonly operationId: string; readonly sessionId: string;
};
const FRESH_PRICE_METRIC = 'price_usd';
const APPROVE_ABI = parseAbi(['function approve(address spender,uint256 value) returns (bool)']);

function failure(code: string): never { throw new Error(code); }
function stage(workflow: ReturnType<G3cExecutionStore['getWorkflow']>) {
  if (workflow.submissionMode !== 'BROWSER_WALLET' || !workflow.browserStage) return failure('D2_BROWSER_WORKFLOW_NOT_FOUND');
  return workflow.browserStage;
}
function response(proposalId: string, workflow: ReturnType<G3cExecutionStore['getWorkflow']>, replayed: boolean): D2BrowserExecutionActionResponse {
  const browserStage = stage(workflow);
  const receipt = workflow.receipt?.payload;
  return d2BrowserExecutionActionResponseSchema.parse({
    proposalId, executionId: workflow.executionId, operationId: workflow.operationId, sessionId: workflow.sessionId,
    kind: workflow.kind, status: workflow.status, browserStage, walletAddress: workflow.unsignedTransaction.from,
    transaction: workflow.unsignedTransaction, transactionHash: workflow.transactionHash,
    submissionAttempts: workflow.submissionAttempts,
    receiptOutcome: receipt?.kind === 'RECEIPT' ? receipt.outcome : null,
    receiptBlockNumber: receipt?.kind === 'RECEIPT' ? receipt.blockNumber : null,
    actualFeesUsdcMicros: workflow.actualFeesUsdcMicros === '0' ? null : workflow.actualFeesUsdcMicros,
    replayed,
  });
}
function assertFreshNansenEvidence(production: D2ProductionService, proposalId: string, nowMs: number): void {
  const proposal = production.proposal(proposalId);
  const evaluation = production.evaluation(proposalId);
  if (!proposal || !evaluation) failure('D2_EVALUATION_NOT_FOUND');
  const evidence = production.evidence();
  if (evidence.freshness !== 'fresh') failure('D2_BROWSER_CURRENT_NANSEN_EVIDENCE_REQUIRED');
  if (evaluation.signalSource !== 'nansen' || !['ALLOW', 'RESIZE'].includes(evaluation.decision.status) ||
      !evaluation.decision.approvedAmountIn || evaluation.decision.approvedAmountIn !== evaluation.executionTransaction?.amountIn ||
      Date.parse(proposal.intent.expiresAt) <= nowMs) failure('D2_POLICY_NOT_EXECUTABLE');
  const linked = evidence.observations.filter((signal) => evaluation.evidenceIds.includes(signal.signalId));
  const freshBatches = new Set(evidence.batches.filter((batch) => batch.status === 'fresh' && batch.completeness === 'complete')
    .flatMap((batch) => batch.observationIds));
  const has = (endpoint: string, asset: string, metric: string) => linked.some((signal) =>
    signal.endpoint === endpoint && signal.asset === asset && signal.metric === metric && freshBatches.has(signal.signalId));
  const hasUsdcPrice = has('TOKEN_SCREENER', 'USDC', FRESH_PRICE_METRIC) || has('TOKEN_OHLCV', 'USDC', FRESH_PRICE_METRIC);
  if (!hasUsdcPrice || !has('TOKEN_SCREENER', 'WETH', FRESH_PRICE_METRIC) ||
      !has('SMART_MONEY_NETFLOW', 'WETH', 'net_flow_1h_usd')) failure('D2_BROWSER_CURRENT_NANSEN_EVIDENCE_REQUIRED');
}
function assertSimulation(production: D2ProductionService, request: D2BrowserExecutionRequest, tx: G3bUnsignedTransaction, nowMs: number): void {
  const evaluation = production.evaluation(request.proposalId);
  const simulation = production.simulation(request.proposalId, request.operationId);
  if (!evaluation || !simulation || evaluation.sessionId !== request.sessionId ||
      evaluation.g3cExecutionId !== simulation.executionId || simulation.proposalId !== request.proposalId ||
      !['ALLOW', 'RESIZE'].includes(evaluation.decision.status) || evaluation.decision.approvedAmountIn !== simulation.permittedAmount ||
      simulation.policyTransaction.amountIn !== evaluation.decision.approvedAmountIn ||
      canonicalJson(simulation.policyTransaction) !== canonicalJson(evaluation.executionTransaction) ||
      simulation.operationId !== request.operationId || simulation.sessionId !== request.sessionId ||
      simulation.walletAddress.toLowerCase() !== tx.from.toLowerCase() || simulation.transaction.chainId !== 8453 ||
      canonicalJson(simulation.transaction) !== canonicalJson(tx) || simulation.simulation.payload.kind !== 'SIMULATION' ||
      simulation.simulation.payload.outcome !== 'PASSED' || simulation.fee.payload.kind !== 'BASE_FEE' ||
      Date.parse(simulation.createdAt) > nowMs || nowMs - Date.parse(simulation.createdAt) > 15_000 ||
      Date.parse(simulation.simulation.payload.expiresAt) <= nowMs || Date.parse(simulation.fee.payload.expiresAt) <= nowMs) {
    failure('D2_BROWSER_SIMULATION_STALE_OR_MISMATCHED');
  }
}

export function createD2BrowserExecutionService(input: {
  readonly production: D2ProductionService;
  readonly store: G3cExecutionStore;
  readonly provider: G3cReadOnlyBaseProvider;
  readonly enabled: boolean;
  readonly clock?: () => Date;
}) {
  const clock = input.clock ?? (() => new Date());
  function requireEnabled(): void { if (!input.enabled) failure('D2_BROWSER_WALLET_DISABLED'); }
  function currentTime(): Date {
    const value = clock();
    if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime())) failure('D2_CLOCK_UNAVAILABLE');
    return value;
  }
  function workflowFor(proposalId: string, operationId: string) {
    const workflow = input.store.findWorkflow(operationId);
    if (!workflow || workflow.executionId !== proposalId || workflow.operationId !== operationId) failure('D2_BROWSER_WORKFLOW_NOT_FOUND');
    if (workflow.submissionMode !== 'BROWSER_WALLET') failure('D2_BROWSER_WORKFLOW_NOT_FOUND');
    return workflow;
  }
  function expectedTx(workflow: ReturnType<G3cExecutionStore['getWorkflow']>): G3bUnsignedTransaction {
    if (!['SWAP', 'APPROVAL'].includes(workflow.kind) || workflow.unsignedTransaction.chainId !== 8453) failure('D2_BROWSER_OPERATION_INVALID');
    if (workflow.kind === 'APPROVAL') {
      const account = workflow.accountSnapshot.payload;
      const parent = input.store.getParent(workflow.executionId);
      const token = parent.intent.sellAsset === 'USDC' ? BASE_TOKENS.USDC : BASE_TOKENS.WETH;
      if (account.kind !== 'ACCOUNT_SNAPSHOT' || account.allowanceToken.toLowerCase() !== token.toLowerCase() ||
          account.allowanceSpender.toLowerCase() !== BASE_UNISWAP_V3.router.toLowerCase() ||
          BigInt(account.allowanceAtomic) >= BigInt(parent.transaction.amountIn) ||
          workflow.unsignedTransaction.from.toLowerCase() !== parent.walletAddress.toLowerCase() ||
          workflow.unsignedTransaction.to.toLowerCase() !== account.allowanceToken.toLowerCase() || workflow.unsignedTransaction.valueWei !== '0') {
        failure('D2_BROWSER_APPROVAL_INVALID');
      }
      let approval: ReturnType<typeof decodeFunctionData>;
      try { approval = decodeFunctionData({ abi: APPROVE_ABI, data: workflow.unsignedTransaction.data as `0x${string}` }); }
      catch { return failure('D2_BROWSER_APPROVAL_INVALID'); }
      if (approval.functionName !== 'approve' || !approval.args ||
          String(approval.args[0]).toLowerCase() !== BASE_UNISWAP_V3.router.toLowerCase() ||
          approval.args[1] !== BigInt(parent.transaction.amountIn)) failure('D2_BROWSER_APPROVAL_INVALID');
    }
    return workflow.unsignedTransaction;
  }
  return Object.freeze({
    enabled: input.enabled,
    async checkAllowance(request: D2BrowserExecutionRequest): Promise<D2BrowserAllowancePreflightResponse> {
      requireEnabled();
      const nowMs = currentTime().getTime();
      assertFreshNansenEvidence(input.production, request.proposalId, nowMs);
      const evaluation = input.production.evaluation(request.proposalId);
      if (!evaluation || evaluation.sessionId !== request.sessionId || !evaluation.g3cExecutionId ||
          !evaluation.decision.approvedAmountIn || !['ALLOW', 'RESIZE'].includes(evaluation.decision.status)) failure('D2_EXECUTION_NOT_RESERVED');
      const parent = input.store.getParent(evaluation.g3cExecutionId);
      if (parent.status !== 'RESERVED' || parent.walletAddress.toLowerCase() !== evaluation.executionTransaction?.walletAddress.toLowerCase()) failure('D2_EXECUTION_NOT_RESERVED');
      const session = input.store.getSession(request.sessionId);
      if (session.status !== 'ACTIVE' || session.walletAddress.toLowerCase() !== parent.walletAddress.toLowerCase()) failure('D2_BROWSER_OPERATION_MISMATCH');
      const tokenAddress = parent.intent.sellAsset === 'USDC' ? BASE_TOKENS.USDC : BASE_TOKENS.WETH;
      const fresh = await input.provider.account(session.walletAddress, tokenAddress, session.latestAccountVersion + 1, 'unsafe');
      if (fresh.payload.kind !== 'ACCOUNT_SNAPSHOT') failure('D2_BROWSER_ALLOWANCE_UNAVAILABLE');
      input.store.refreshSessionSnapshot(request.sessionId, fresh, 'Refresh account and exact router allowance before Rabby decision');
      return d2BrowserAllowancePreflightResponseSchema.parse({ proposalId: request.proposalId, executionId: parent.executionId,
        sessionId: request.sessionId, walletAddress: session.walletAddress, chainId: 8453, tokenAddress,
        spenderAddress: BASE_UNISWAP_V3.router, currentAllowanceAtomic: fresh.payload.allowanceAtomic,
        requiredAmountAtomic: parent.transaction.amountIn,
        status: BigInt(fresh.payload.allowanceAtomic) >= BigInt(parent.transaction.amountIn) ? 'ALLOWANCE_SUFFICIENT' : 'APPROVAL_REQUIRED' });
    },    prepare(request: D2BrowserExecutionRequest): D2BrowserExecutionActionResponse {
      requireEnabled();
      const nowMs = currentTime().getTime();
      assertFreshNansenEvidence(input.production, request.proposalId, nowMs);
      const evaluation = input.production.evaluation(request.proposalId);
      if (!evaluation || evaluation.sessionId !== request.sessionId || !evaluation.g3cExecutionId) failure('D2_EXECUTION_NOT_RESERVED');
      const simulation = input.production.simulation(request.proposalId, request.operationId);
      if (!simulation || simulation.executionId !== evaluation.g3cExecutionId || simulation.sessionId !== request.sessionId) failure('D2_BROWSER_SIMULATION_STALE_OR_MISMATCHED');
      assertSimulation(input.production, request, simulation.transaction, nowMs);
      const session = input.store.getSession(request.sessionId);
      if (session.walletAddress.toLowerCase() !== simulation.walletAddress.toLowerCase() ||
          session.latestAccountVersion !== simulation.accountVersion || !session.latestSnapshot) failure('D2_BROWSER_OPERATION_MISMATCH');
      const result = input.store.prepareBrowserOperation({ executionId: evaluation.g3cExecutionId, operationId: request.operationId,
        sessionId: request.sessionId, kind: 'SWAP', unsignedTransaction: simulation.transaction,
        accountSnapshot: session.latestSnapshot, quote: simulation.quote, simulation: simulation.simulation, fee: simulation.fee,
        reason: 'Persist exact reserved D2 simulation as a Rabby browser workflow' });
      return response(request.proposalId, result.workflow, result.replayed);
    },
    async prepareApproval(request: D2BrowserExecutionRequest): Promise<D2BrowserExecutionActionResponse> {
      requireEnabled();
      const nowMs = currentTime().getTime();
      assertFreshNansenEvidence(input.production, request.proposalId, nowMs);
      const evaluation = input.production.evaluation(request.proposalId);
      if (!evaluation || evaluation.sessionId !== request.sessionId || !evaluation.g3cExecutionId ||
          !['ALLOW', 'RESIZE'].includes(evaluation.decision.status) || !evaluation.decision.approvedAmountIn) failure('D2_EXECUTION_NOT_RESERVED');
      const existing = input.store.findWorkflow(request.operationId);
      if (existing) {
        if (existing.executionId !== evaluation.g3cExecutionId || existing.sessionId !== request.sessionId || existing.kind !== 'APPROVAL' ||
            existing.submissionMode !== 'BROWSER_WALLET') failure('D2_BROWSER_OPERATION_MISMATCH');
        expectedTx(existing);
        return response(request.proposalId, existing, true);
      }
      const result = await prepareBaseG3cOperation({ store: input.store, provider: input.provider,
        executionId: evaluation.g3cExecutionId, operationId: request.operationId, sessionId: request.sessionId,
        kind: 'APPROVAL', submissionMode: 'BROWSER_WALLET', reason: 'Persist exact-amount approval for explicit Rabby confirmation' });
      expectedTx(result.workflow);
      return response(request.proposalId, result.workflow, result.replayed);
    },
    async begin(request: D2BrowserExecutionRequest): Promise<D2BrowserExecutionActionResponse> {
      requireEnabled();
      const nowMs = currentTime().getTime();
      assertFreshNansenEvidence(input.production, request.proposalId, nowMs);
      const workflow = workflowFor(request.proposalId, request.operationId); const tx = expectedTx(workflow);
      if (workflow.kind === 'SWAP') assertSimulation(input.production, request, tx, nowMs);
      else if (workflow.kind !== 'APPROVAL') failure('D2_BROWSER_OPERATION_INVALID');
      const session = input.store.getSession(workflow.sessionId);
      if (session.sessionId !== request.sessionId || session.walletAddress.toLowerCase() !== tx.from.toLowerCase()) failure('D2_BROWSER_OPERATION_MISMATCH');
      const allowanceToken = workflow.accountSnapshot.payload.kind === 'ACCOUNT_SNAPSHOT' ? workflow.accountSnapshot.payload.allowanceToken : '';
      const freshAccount = await input.provider.account(tx.from, allowanceToken, workflow.accountVersion, 'unsafe');
      const result = input.store.armBrowserWalletSubmission(request.operationId, freshAccount, 'Persist uncertain browser submission before requesting Rabby');
      return response(request.proposalId, result.workflow, result.replayed);
    },
    async attachHash(proposalId: string, operationId: string, transactionHash: string): Promise<D2BrowserExecutionActionResponse> {
      requireEnabled();
      const workflow = workflowFor(proposalId, operationId); const tx = expectedTx(workflow);
      if (!input.provider.verifyTransaction) failure('D2_BROWSER_TRANSACTION_VERIFIER_UNAVAILABLE');
      const verification = await input.provider.verifyTransaction({ transactionHash: transactionHash as `0x${string}`, expectedTransaction: tx });
      const result = input.store.recordBrowserTransaction(operationId, transactionHash, verification,
        verification === 'MATCH' ? `Exact Rabby ${workflow.kind.toLowerCase()} transaction fields matched the persisted transaction` :
          verification === 'NOT_FOUND' ? 'Transaction hash retained as uncertain until the exact transaction is visible' :
            'Transaction hash does not match the persisted exact transaction');
      return response(proposalId, result.workflow, result.replayed);
    },
    async reconcile(proposalId: string, operationId: string): Promise<D2BrowserExecutionActionResponse> {
      requireEnabled();
      const workflow = workflowFor(proposalId, operationId); const tx = expectedTx(workflow);
      if (!workflow.transactionHash) return response(proposalId, workflow, false);
      const receipt = await input.provider.receipt({ executionId: workflow.executionId, operationId, transactionHash: workflow.transactionHash as `0x${string}`,
        sender: tx.from, nonce: tx.nonce, expectedTransaction: tx });
      const payload = receipt.payload;
      if (payload.kind !== 'RECEIPT') failure('D2_BROWSER_RECEIPT_INVALID');
      let settlementSnapshot = null;
      if (['CONFIRMED', 'REVERTED'].includes(payload.outcome) && payload.finality === 'finalized' && payload.canonical === true) {
        const session = input.store.getSession(workflow.sessionId);
        const allowanceToken = workflow.accountSnapshot.payload.kind === 'ACCOUNT_SNAPSHOT' ? workflow.accountSnapshot.payload.allowanceToken : '';
        settlementSnapshot = await input.provider.account(session.walletAddress, allowanceToken, session.latestAccountVersion + 1, 'finalized');
      }
      const result = input.store.recordBrowserReceipt(operationId, receipt, settlementSnapshot, 'Reconcile exact browser wallet hash and finalized Base account');
      return response(proposalId, result.workflow, result.replayed);
    },
    async completeApproval(proposalId: string, operationId: string, sessionId: string): Promise<D2BrowserExecutionActionResponse> {
      requireEnabled();
      const workflow = workflowFor(proposalId, operationId);
      if (workflow.sessionId !== sessionId) failure('D2_BROWSER_OPERATION_MISMATCH');
      const receipt = workflow.receipt?.payload;
      if (workflow.kind !== 'APPROVAL' || workflow.status !== 'CONFIRMED' || receipt?.kind !== 'RECEIPT' ||
          receipt.outcome !== 'CONFIRMED' || receipt.finality !== 'finalized' || receipt.canonical !== true) failure('D2_BROWSER_APPROVAL_NOT_FINALIZED');
      const session = input.store.getSession(workflow.sessionId);
      const allowanceToken = workflow.accountSnapshot.payload.kind === 'ACCOUNT_SNAPSHOT' ? workflow.accountSnapshot.payload.allowanceToken : '';
      const freshAccount = await input.provider.account(session.walletAddress, allowanceToken, session.latestAccountVersion + 1, 'finalized');
      input.store.releaseAfterBrowserApproval(workflow.executionId, freshAccount, 'Finalize bounded Rabby approval; require a new fresh D2 proposal and evaluation');
      return response(proposalId, workflow, false);
    },
    reject(proposalId: string, operationId: string, reason: 'USER_REJECTED' | 'PRE_SEND_CONTEXT_CHANGED'): D2BrowserExecutionActionResponse {
      requireEnabled();
      workflowFor(proposalId, operationId);
      const result = input.store.rejectBrowserWalletSubmission(operationId, reason === 'USER_REJECTED'
        ? 'Rabby returned EIP-1193 user rejection code 4001' : 'Local account or chain changed before opening Rabby');
      return response(proposalId, result.workflow, result.replayed);
    },
    status(proposalId: string, operationId: string): D2BrowserExecutionActionResponse {
      const workflow = workflowFor(proposalId, operationId);
      return response(proposalId, workflow, false);
    },
    now: currentTime,
  });
}
export type D2BrowserExecutionService = ReturnType<typeof createD2BrowserExecutionService>;
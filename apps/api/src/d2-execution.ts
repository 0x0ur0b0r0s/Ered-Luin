import { createHash } from 'node:crypto';
import { decodeFunctionData, type Hex } from 'viem';
import {
  canonicalJson, d2ExecutionActionResponseSchema,
  type D2Evaluation, type D2ExecutionActionResponse, type D2ExecutionReconcileRequest,
  type D2PrepareSignRequest, type D2SubmitRequest, type G3cWorkflow,
} from '@ered-luin/contracts';
import { BASE_TOKENS, BASE_UNISWAP_V3 } from './base-allowlist.js';
import { decodeExactSwap, ERC20_APPROVAL_ABI } from './g3b-transaction.js';
import type { D2ProductionService } from './d2-production.js';
import { broadcastBaseG3cOperation, prepareBaseG3cOperation, signBaseG3cOperation } from './g3c-orchestrator.js';
import type { G3cBroadcaster, G3cExecutionStore, G3cSigner } from './g3c-execution-store.js';
import type { G3cReadOnlyBaseProvider } from './g3c-base-provider.js';
import {
  D2B_APPROVAL_SWAP_REQUIRED_RECOVERY_REQUESTS, D2B_APPROVAL_SWAP_REQUIRED_REGULAR_REQUESTS,
  D2B_DIRECT_SWAP_REQUIRED_RECOVERY_REQUESTS, D2B_DIRECT_SWAP_REQUIRED_REGULAR_REQUESTS,
} from './rpc-budget.js';

export interface D2ExecutionService {
  readonly signingEnabled: boolean;
  readonly submissionEnabled: boolean;
  status(proposalId: string, operationId: string): D2ExecutionActionResponse;
  prepareSign(request: D2PrepareSignRequest, operatorId: string): Promise<D2ExecutionActionResponse>;
  submit(request: D2SubmitRequest, operatorId: string): Promise<D2ExecutionActionResponse>;
  reconcile(request: D2ExecutionReconcileRequest, operatorId: string): Promise<D2ExecutionActionResponse>;
}

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function failure(error: string): never { throw new Error(error); }
function actionReason(action: string, operatorId: string, idempotencyKey: string): string {
  return 'D2b ' + action + ' operator=' + operatorId + ' idempotency=' + idempotencyKey;
}
function checkedPair(input: {
  readonly production: D2ProductionService; readonly store: G3cExecutionStore; readonly proposalId: string;
}): { readonly proposal: NonNullable<ReturnType<D2ProductionService['proposal']>>; readonly evaluation: D2Evaluation; readonly parent: ReturnType<G3cExecutionStore['getParent']> } {
  const proposal = input.production.proposal(input.proposalId);
  const evaluation = input.production.evaluation(input.proposalId);
  if (!proposal || !evaluation) return failure('D2B_PROPOSAL_OR_EVALUATION_NOT_FOUND');
  if (evaluation.proposalId !== proposal.proposalId || proposal.proposalId !== proposal.intent.intentId ||
      evaluation.intent.intentId !== proposal.intent.intentId || canonicalJson(evaluation.intent) !== canonicalJson(proposal.intent) ||
      canonicalJson(evaluation.evidenceIds) !== canonicalJson(proposal.evidence.observationIds) ||
      evaluation.decision.intentId !== proposal.intent.intentId || evaluation.decision.requestedAmountIn !== proposal.intent.amountIn ||
      (evaluation.g3cStatus !== null && evaluation.g3cStatus.executionId !== evaluation.g3cExecutionId)) {
    return failure('D2B_PERSISTED_PROPOSAL_IDENTITY_MISMATCH');
  }
  if (!['ALLOW', 'RESIZE'].includes(evaluation.decision.status) || !evaluation.decision.approvedAmountIn ||
      !evaluation.executionTransaction || evaluation.executionTransaction.amountIn !== evaluation.decision.approvedAmountIn ||
      evaluation.executionTransaction.walletAddress.toLowerCase() !== proposal.intent.walletAddress.toLowerCase()) {
    return failure('D2B_POLICY_NOT_EXECUTABLE');
  }
  if (evaluation.g3cExecutionId !== proposal.proposalId || evaluation.sessionId === null) return failure('D2B_EXECUTION_NOT_RESERVED');
  const parent = input.store.getParent(evaluation.g3cExecutionId);
  if (parent.executionId !== proposal.proposalId || parent.intent.intentId !== proposal.intent.intentId ||
      canonicalJson(parent.intent) !== canonicalJson(proposal.intent) || canonicalJson(parent.decision) !== canonicalJson(evaluation.decision) ||
      !['RESERVED', 'RELEASED'].includes(parent.status) || parent.transaction.amountIn !== evaluation.decision.approvedAmountIn ||
      parent.transaction.walletAddress.toLowerCase() !== proposal.intent.walletAddress.toLowerCase() ||
      parent.reservationExposureUsdcMicros !== evaluation.decision.approvedAmountIn) {
    return failure('D2B_RESERVED_AUTHORITY_MISMATCH');
  }
  return { proposal, evaluation, parent };
}
function assertSession(input: {
  readonly store: G3cExecutionStore; readonly sessionId: string; readonly walletAddress: string; readonly allowanceToken: string;
}) {
  const session = input.store.getSession(input.sessionId);
  if (session.status !== 'ACTIVE' || session.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase() || !session.latestSnapshot ||
      session.latestSnapshot.payload.kind !== 'ACCOUNT_SNAPSHOT' ||
      session.latestSnapshot.payload.allowanceToken.toLowerCase() !== input.allowanceToken.toLowerCase() ||
      session.latestSnapshot.payload.allowanceSpender.toLowerCase() !== BASE_UNISWAP_V3.router.toLowerCase()) {
    return failure('D2B_SESSION_IDENTITY_MISMATCH');
  }
  return session;
}
function workflowAmount(workflow: G3cWorkflow): string {
  const data = workflow.unsignedTransaction.data as Hex;
  if (workflow.kind === 'APPROVAL') {
    const approval = decodeFunctionData({ abi: ERC20_APPROVAL_ABI, data });
    if (approval.functionName !== 'approve' || !approval.args) return failure('D2B_OPERATION_IDENTITY_MISMATCH');
    return approval.args[1].toString();
  }
  return decodeExactSwap(data).amountIn.toString();
}function assertWorkflowIdentity(input: {
  readonly workflow: G3cWorkflow; readonly executionId: string; readonly proposalId: string; readonly intentId: string;
  readonly decisionId: string; readonly sessionId: string; readonly amount: string; readonly walletAddress: string;
}): void {
  if (input.workflow.executionId !== input.executionId || input.executionId !== input.proposalId ||
      input.workflow.sessionId !== input.sessionId || input.workflow.intentId !== input.intentId ||
      input.workflow.decisionId !== input.decisionId || workflowAmount(input.workflow) !== input.amount ||
      input.workflow.unsignedTransaction.from.toLowerCase() !== input.walletAddress.toLowerCase()) {
    return failure('D2B_OPERATION_IDENTITY_MISMATCH');
  }
}
function response(input: {
  readonly proposalId: string; readonly evaluation: D2Evaluation; readonly workflow: G3cWorkflow;
  readonly replayed: boolean;
}): D2ExecutionActionResponse {
  const receipt = input.workflow.receipt?.payload;
  return d2ExecutionActionResponseSchema.parse({
    proposalId: input.proposalId, executionId: input.workflow.executionId, operationId: input.workflow.operationId,
    sessionId: input.workflow.sessionId, kind: input.workflow.kind, status: input.workflow.status,
    permittedAmount: input.evaluation.decision.approvedAmountIn!,
    transactionHash: input.workflow.transactionHash, submissionAttempts: input.workflow.submissionAttempts,
    receiptOutcome: receipt?.kind === 'RECEIPT' ? receipt.outcome : null,
    receiptBlockNumber: receipt?.kind === 'RECEIPT' ? receipt.blockNumber : null,
    actualFeesUsdcMicros: ['CONFIRMED', 'REVERTED'].includes(input.workflow.status) ? input.workflow.actualFeesUsdcMicros : null,
    replayed: input.replayed,
  });
}
function payloadDigest(value: unknown): string { return sha256(canonicalJson(value)); }
function actionLock<T>(locks: Map<string, Promise<void>>, key: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => hold);
  locks.set(key, queued);
  return previous.catch(() => undefined).then(action).finally(() => {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  });
}

export function createD2ExecutionService(input: {
  readonly production: D2ProductionService;
  readonly store: G3cExecutionStore;
  readonly provider?: G3cReadOnlyBaseProvider;
  readonly signer?: G3cSigner;
  readonly broadcaster?: G3cBroadcaster;
  readonly signingEnabled?: boolean;
  readonly submissionEnabled?: boolean;
  readonly clock?: () => Date;
}): D2ExecutionService {
  const signingEnabled = input.signingEnabled === true && input.signer !== undefined && input.provider !== undefined;
  const submissionEnabled = input.submissionEnabled === true && input.broadcaster !== undefined;
  const clock = input.clock ?? (() => new Date());
  const locks = new Map<string, Promise<void>>();

  function operation(proposalId: string, operationId: string) {
    const pair = checkedPair({ production: input.production, store: input.store, proposalId });
    if (!pair.evaluation.sessionId) return failure('D2B_SESSION_IDENTITY_MISMATCH');
    const workflow = input.store.findWorkflow(operationId);
    if (workflow) assertWorkflowIdentity({
      workflow, executionId: pair.parent.executionId, proposalId, intentId: pair.proposal.intent.intentId,
      decisionId: pair.evaluation.decision.decisionId, sessionId: pair.evaluation.sessionId, amount: pair.evaluation.decision.approvedAmountIn!, walletAddress: pair.proposal.intent.walletAddress,
    });
    return { ...pair, sessionId: pair.evaluation.sessionId, workflow };
  }
  function requireFreshSigningAuthority(value: ReturnType<typeof operation>) {
    if (value.parent.status !== 'RESERVED') return failure('D2B_RESERVED_AUTHORITY_MISMATCH');
    const token = value.proposal.intent.sellAsset === 'USDC' ? BASE_TOKENS.USDC : BASE_TOKENS.WETH;
    const session = assertSession({ store: input.store, sessionId: value.sessionId,
      walletAddress: value.proposal.intent.walletAddress, allowanceToken: token });
    input.store.assertIntentFresh(value.parent.executionId);
    return session;
  }
  function bind(value: {
    readonly proposalId: string; readonly operationId: string; readonly sessionId: string; readonly operatorId: string;
    readonly action: 'PREPARE_SIGN' | 'SUBMIT' | 'RECONCILE'; readonly idempotencyKey: string; readonly payload: unknown;
  }): { readonly replayed: boolean } {
    return input.store.recordD2bOperatorAction({
      executionId: value.proposalId, proposalId: value.proposalId, operationId: value.operationId,
      sessionId: value.sessionId, operatorId: value.operatorId, action: value.action,
      idempotencyKey: value.idempotencyKey, payloadDigest: payloadDigest(value.payload),
    });
  }
  function actionResponse(proposalId: string, evaluation: D2Evaluation, operationId: string, replayed: boolean) {
    const workflow = input.store.findWorkflow(operationId);
    if (!workflow) return failure('D2B_WORKFLOW_NOT_FOUND');
    return response({ proposalId, evaluation, workflow, replayed });
  }

  return Object.freeze({
    signingEnabled,
    submissionEnabled,
    status(proposalId: string, operationId: string) {
      const value = operation(proposalId, operationId);
      if (!value.workflow) return failure('D2B_WORKFLOW_NOT_FOUND');
      return response({ proposalId, evaluation: value.evaluation, workflow: value.workflow, replayed: false });
    },
    async prepareSign(request: D2PrepareSignRequest, operatorId: string) {
      if (!signingEnabled || !input.signer || !input.provider) return failure('D2B_SIGNING_DISABLED');
      return actionLock(locks, request.proposalId, async () => {
        const value = operation(request.proposalId, request.operationId);
        if (request.sessionId !== value.sessionId) return failure('D2B_SESSION_IDENTITY_MISMATCH');
        if (!value.workflow || value.workflow.status === 'AUTHORIZED') requireFreshSigningAuthority(value);
        const binding = bind({ proposalId: request.proposalId, operationId: request.operationId, sessionId: value.sessionId,
          operatorId, action: 'PREPARE_SIGN', idempotencyKey: request.idempotencyKey,
          payload: { action: 'PREPARE_SIGN', proposal: value.proposal, decision: value.evaluation.decision,
            transaction: value.evaluation.executionTransaction, sessionId: value.sessionId } });
        let workflow = value.workflow;
        let replayed = binding.replayed;
        if (workflow && workflow.status !== 'AUTHORIZED') return response({ proposalId: request.proposalId, evaluation: value.evaluation, workflow, replayed: true });
        if (!workflow) {
          const session = requireFreshSigningAuthority(value);
          const allowanceToken = value.proposal.intent.sellAsset === 'USDC' ? BASE_TOKENS.USDC : BASE_TOKENS.WETH;
          const refreshedAccount = await input.provider!.account(value.proposal.intent.walletAddress, allowanceToken,
            session.latestAccountVersion + 1, 'unsafe');
          input.store.refreshSessionSnapshot(value.sessionId, refreshedAccount, 'D2 fresh allowance check before selecting G3c operation');
          const refreshedSession = assertSession({ store: input.store, sessionId: value.sessionId,
            walletAddress: value.proposal.intent.walletAddress, allowanceToken });
          const latestAccount = refreshedSession.latestSnapshot!.payload;
          if (latestAccount.kind !== 'ACCOUNT_SNAPSHOT' || latestAccount.chainId !== 8453 ||
              latestAccount.allowanceSpender.toLowerCase() !== BASE_UNISWAP_V3.router.toLowerCase()) {
            return failure('D2B_SESSION_IDENTITY_MISMATCH');
          }
          const allowance = BigInt(latestAccount.allowanceAtomic);
          const kind = allowance < BigInt(value.evaluation.decision.approvedAmountIn!) ? 'APPROVAL' : 'SWAP';
          const requiredRegularCapacity = kind === 'APPROVAL'
            ? D2B_APPROVAL_SWAP_REQUIRED_REGULAR_REQUESTS : D2B_DIRECT_SWAP_REQUIRED_REGULAR_REQUESTS;
          const requiredRecoveryCapacity = kind === 'APPROVAL'
            ? D2B_APPROVAL_SWAP_REQUIRED_RECOVERY_REQUESTS : D2B_DIRECT_SWAP_REQUIRED_RECOVERY_REQUESTS;
          const rpcCapacity = input.provider!.rpcBudgetSnapshot();
          const remainingRecoveryCapacity = Math.max(0, rpcCapacity.recoveryReserve - rpcCapacity.recoveryRequests);
          if (rpcCapacity.regularRemainingRequests < requiredRegularCapacity ||
              remainingRecoveryCapacity < requiredRecoveryCapacity) {
            return failure('D2B_RPC_CAPACITY_INSUFFICIENT');
          }
          const previous = input.store.listWorkflowsForExecution(value.parent.executionId);
          if (previous.some((item) => !['CONFIRMED', 'REVERTED', 'CANCELLED'].includes(item.status))) return failure('D2B_PRIOR_OPERATION_PENDING');
          if (kind === 'SWAP' && previous.some((item) => item.kind === 'APPROVAL' && item.status !== 'CONFIRMED')) return failure('D2B_APPROVAL_RECEIPT_REQUIRED');
          if (kind === 'APPROVAL' && previous.some((item) => item.kind === 'APPROVAL' && item.status === 'CONFIRMED')) {
            return failure('D2B_APPROVAL_REFRESH_REQUIRED');
          }
          const prepared = await prepareBaseG3cOperation({ store: input.store, provider: input.provider!,
            executionId: value.parent.executionId, operationId: request.operationId, sessionId: value.sessionId, kind,
            reason: actionReason('PREPARE', operatorId, request.idempotencyKey) });
          workflow = prepared.workflow;
          replayed ||= prepared.replayed;
        }
        if (workflow.status === 'AUTHORIZED') {
          const signed = await signBaseG3cOperation({ store: input.store, provider: input.provider!,
            operationId: request.operationId, signer: input.signer!, reason: actionReason('SIGN', operatorId, request.idempotencyKey) });
          workflow = signed.workflow;
          replayed ||= signed.replayed;
        }
        assertWorkflowIdentity({ workflow, executionId: value.parent.executionId, proposalId: request.proposalId,
          intentId: value.proposal.intent.intentId, decisionId: value.evaluation.decision.decisionId,
          sessionId: value.sessionId, amount: value.evaluation.decision.approvedAmountIn!, walletAddress: value.proposal.intent.walletAddress });
        return response({ proposalId: request.proposalId, evaluation: value.evaluation, workflow, replayed });
      });
    },
    async submit(request: D2SubmitRequest, operatorId: string) {
      if (!submissionEnabled || !input.broadcaster) return failure('D2B_SUBMISSION_DISABLED');
      return actionLock(locks, request.proposalId, async () => {
        const value = operation(request.proposalId, request.operationId);
        const workflow = value.workflow;
        if (!workflow || !workflow.signedBytesHex || !workflow.transactionHash) return failure('D2B_SIGNED_OUTBOX_REQUIRED');
        const action = {
          executionId: request.proposalId, proposalId: request.proposalId, operationId: request.operationId,
          sessionId: value.sessionId, operatorId, action: 'SUBMIT' as const, idempotencyKey: request.idempotencyKey,
          payloadDigest: payloadDigest({ action: 'SUBMIT', proposalId: request.proposalId, operationId: request.operationId,
            sessionId: value.sessionId, transactionDigest: workflow.transactionDigest,
            signedBytesDigest: workflow.signedBytesDigest, transactionHash: workflow.transactionHash }),
        };
        const claim = input.store.claimD2bOperatorAction(action);
        if (claim.status !== 'CLAIMED') {
          if (claim.status === 'IN_PROGRESS') return failure('D2B_ACTION_IN_PROGRESS');
          return actionResponse(request.proposalId, value.evaluation, request.operationId, true);
        }
        const startingSubmissionAttempts = workflow.submissionAttempts;
        try {
          const submitted = await broadcastBaseG3cOperation({ store: input.store, operationId: request.operationId,
            broadcaster: input.broadcaster!, reason: actionReason('SUBMIT', operatorId, request.idempotencyKey), clock });
          const completed = input.store.completeD2bOperatorAction(action, claim.claimToken, submitted.workflow.status);
          const currentWorkflow = input.store.findWorkflow(request.operationId) ?? submitted.workflow;
          return response({ proposalId: request.proposalId, evaluation: value.evaluation, workflow: currentWorkflow,
            replayed: submitted.replayed || !completed });
        } catch (error) {
          const currentWorkflow = input.store.findWorkflow(request.operationId);
          const safeToRetry = currentWorkflow !== null &&
            ['SIGNED_OUTBOX', 'SUBMISSION_UNCERTAIN'].includes(currentWorkflow.status) &&
            currentWorkflow.submissionAttempts === startingSubmissionAttempts;
          input.store.releaseD2bOperatorAction(action, claim.claimToken,
            safeToRetry ? 'RETRYABLE' : 'UNCERTAIN',
            safeToRetry ? 'PRE_SEND_REJECTION' : currentWorkflow?.status ?? 'SUBMIT_OUTCOME_UNKNOWN');
          throw error;
        }
      });
    },
    async reconcile(request: D2ExecutionReconcileRequest, operatorId: string) {
      return actionLock(locks, request.proposalId, async () => {
        const value = operation(request.proposalId, request.operationId);
        const workflow = value.workflow;
        if (!workflow || !workflow.transactionHash || !['SUBMISSION_UNCERTAIN', 'SUBMITTED', 'RECONCILIATION_REQUIRED', 'CONFIRMED', 'REVERTED'].includes(workflow.status)) {
          return failure('D2B_RECOVERY_NOT_PENDING');
        }
        const action = {
          executionId: request.proposalId, proposalId: request.proposalId, operationId: request.operationId,
          sessionId: value.sessionId, operatorId, action: 'RECONCILE' as const, idempotencyKey: request.idempotencyKey,
          payloadDigest: payloadDigest({ action: 'RECONCILE', proposalId: request.proposalId, operationId: request.operationId,
            sessionId: value.sessionId, transactionDigest: workflow.transactionDigest, transactionHash: workflow.transactionHash }),
        };
        const claim = input.store.claimD2bOperatorAction(action);
        if (claim.status !== 'CLAIMED') {
          if (claim.status === 'IN_PROGRESS') return failure('D2B_ACTION_IN_PROGRESS');
          return actionResponse(request.proposalId, value.evaluation, request.operationId, true);
        }
        try {
          await input.production.reconcile(request.proposalId, request.operationId);
          const currentWorkflow = input.store.findWorkflow(request.operationId);
          const completed = input.store.completeD2bOperatorAction(action, claim.claimToken, currentWorkflow?.status ?? 'RECONCILED');
          return actionResponse(request.proposalId, value.evaluation, request.operationId, !completed);
        } catch (error) {
          const currentWorkflow = input.store.findWorkflow(request.operationId);
          if (currentWorkflow && ['CONFIRMED', 'REVERTED'].includes(currentWorkflow.status)) {
            input.store.completeD2bOperatorAction(action, claim.claimToken, currentWorkflow.status);
            return actionResponse(request.proposalId, value.evaluation, request.operationId, true);
          }
          input.store.releaseD2bOperatorAction(action, claim.claimToken, 'RETRYABLE',
            error instanceof Error ? error.message.slice(0, 128) : 'RECONCILE_READ_FAILED');
          throw error;
        }
      });
    },
  });
}

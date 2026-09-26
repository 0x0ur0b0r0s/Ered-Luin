import { createHash } from 'node:crypto';
import type { ExecutionLifecycleRecord } from '@ered-luin/contracts';

const SIMULATION_MAX_AGE_MS = 15_000;
const AUTHORIZATION_MAX_TTL_MS = 15_000;

function invalid(): never {
  throw new Error('Execution lifecycle record is semantically inconsistent.');
}

function requireInvariant(condition: unknown): asserts condition {
  if (!condition) invalid();
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  requireInvariant(Number.isSafeInteger(parsed));
  const date = new Date(parsed);
  requireInvariant(date.getTime() === parsed && date.toISOString() === value);
  return parsed;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Validate historical meaning only. Time-bounded operations separately check
 * whether simulation and authorization evidence are still fresh at use time.
 */
export function assertExecutionLifecycleRecord(record: ExecutionLifecycleRecord): void {
  const tx = record.transaction;
  const decision = record.decision;
  const createdAt = timestamp(record.createdAt);
  const updatedAt = timestamp(record.updatedAt);
  const intentIssuedAt = timestamp(record.intent.issuedAt);
  const intentExpiresAt = timestamp(record.intent.expiresAt);
  const decisionAt = timestamp(decision.evaluatedAt);
  const transactionExpiresAt = timestamp(tx.expiresAt);

  requireInvariant(updatedAt >= createdAt);
  requireInvariant(intentIssuedAt <= decisionAt && decisionAt <= createdAt);
  requireInvariant(transactionExpiresAt > createdAt && transactionExpiresAt <= intentExpiresAt);
  requireInvariant(record.intent.intentId === record.intentId);
  requireInvariant(decision.intentId === record.intentId && decision.decisionId === record.decisionId);
  requireInvariant(decision.requestedAmountIn === record.intent.amountIn && decision.approvedAmountIn === tx.amountIn);
  requireInvariant(decision.status === 'ALLOW' || decision.status === 'RESIZE');
  if (decision.status === 'ALLOW') requireInvariant(tx.amountIn === record.intent.amountIn);
  else requireInvariant(BigInt(tx.amountIn) < BigInt(record.intent.amountIn));
  requireInvariant(tx.walletAddress.toLowerCase() === record.walletAddress.toLowerCase());
  requireInvariant(record.intent.walletAddress.toLowerCase() === record.walletAddress.toLowerCase());
  requireInvariant(tx.chainId === record.intent.chainId && tx.sellAsset === record.intent.sellAsset && tx.buyAsset === record.intent.buyAsset);
  requireInvariant(sha256(JSON.stringify(tx)) === record.transactionDigest);
  requireInvariant(sha256(JSON.stringify({
    version: 1,
    executionId: record.executionId,
    intent: record.intent,
    decision,
    accountVersion: record.accountVersion,
    reservationExposureUsdcMicros: record.reservationExposureUsdcMicros,
    transaction: tx,
    reason: record.reservationReason,
  })) === record.requestDigest);

  const simulation = record.simulation;
  if (simulation) {
    const simulatedAt = timestamp(simulation.simulatedAt);
    const simulationExpiresAt = timestamp(simulation.expiresAt);
    requireInvariant(simulation.executionId === record.executionId && simulation.transactionDigest === record.transactionDigest);
    requireInvariant(simulation.producerId === 'synthetic-test-adapter' && simulation.outcome === 'PASSED');
    requireInvariant(simulatedAt >= decisionAt && simulatedAt >= createdAt && simulatedAt <= updatedAt);
    requireInvariant(simulationExpiresAt > simulatedAt && simulationExpiresAt - simulatedAt <= SIMULATION_MAX_AGE_MS);
  }

  const authorization = record.authorization;
  if (authorization) {
    requireInvariant(simulation !== null);
    const simulationAt = timestamp(simulation.simulatedAt);
    const simulationExpiresAt = timestamp(simulation.expiresAt);
    const issuedAt = timestamp(authorization.issuedAt);
    const expiresAt = timestamp(authorization.expiresAt);
    requireInvariant(authorization.executionId === record.executionId && authorization.intentId === record.intentId);
    requireInvariant(authorization.decisionId === record.decisionId && authorization.accountVersion === record.accountVersion);
    requireInvariant(authorization.walletAddress.toLowerCase() === tx.walletAddress.toLowerCase());
    requireInvariant(authorization.chainId === tx.chainId && authorization.router.toLowerCase() === tx.router.toLowerCase());
    requireInvariant(authorization.recipient.toLowerCase() === tx.recipient.toLowerCase());
    requireInvariant(authorization.sellAsset === tx.sellAsset && authorization.buyAsset === tx.buyAsset);
    requireInvariant(authorization.amountIn === tx.amountIn && authorization.minimumAmountOut === tx.minimumAmountOut);
    requireInvariant(authorization.valueNativeWei === tx.valueNativeWei);
    requireInvariant(authorization.maxFeePerGasWei === tx.maxFeePerGasWei);
    requireInvariant(authorization.maxPriorityFeePerGasWei === tx.maxPriorityFeePerGasWei);
    requireInvariant(authorization.maxTotalFeeWei === tx.maxTotalFeeWei && authorization.chainNonce === tx.chainNonce);
    requireInvariant(authorization.transactionDigest === record.transactionDigest && authorization.simulationId === simulation.simulationId);
    requireInvariant(issuedAt >= simulationAt && issuedAt < simulationExpiresAt && issuedAt <= updatedAt);
    requireInvariant(expiresAt > issuedAt && expiresAt <= transactionExpiresAt && expiresAt <= simulationExpiresAt);
    requireInvariant(expiresAt - issuedAt <= AUTHORIZATION_MAX_TTL_MS);
  }

  const signingClaim = record.signingClaim;
  if (signingClaim) {
    requireInvariant(authorization !== null);
    const claimedAt = timestamp(signingClaim.claimedAt);
    const authorizationIssuedAt = timestamp(authorization.issuedAt);
    const authorizationExpiresAt = timestamp(authorization.expiresAt);
    requireInvariant(signingClaim.authorizationNonce === authorization.authorizationNonce);
    requireInvariant(signingClaim.accountVersion === record.accountVersion);
    requireInvariant(claimedAt >= authorizationIssuedAt && claimedAt < authorizationExpiresAt && claimedAt <= updatedAt);
  }

  const outbox = record.signedOutbox;
  if (outbox) {
    requireInvariant(signingClaim !== null && simulation !== null && authorization !== null);
    const persistedAt = timestamp(outbox.persistedAt);
    const claimedAt = timestamp(signingClaim.claimedAt);
    const bytesHex = outbox.signedBytesHex.slice(2);
    requireInvariant(outbox.transactionDigest === record.transactionDigest && outbox.chainId === tx.chainId);
    requireInvariant(outbox.chainNonce === tx.chainNonce && outbox.signedBytesDigest === sha256(Buffer.from(bytesHex, 'hex')));
    requireInvariant(/^0x(?:[0-9a-fA-F]{2})+$/u.test(outbox.signedBytesHex));
    requireInvariant(persistedAt >= claimedAt && persistedAt <= updatedAt);
  }

  const receipt = record.receipt;
  if (receipt) {
    requireInvariant(outbox !== null && signingClaim !== null && authorization !== null && simulation !== null);
    const observedAt = timestamp(receipt.observedAt);
    const persistedAt = timestamp(outbox.persistedAt);
    requireInvariant(receipt.chainId === outbox.chainId && receipt.transactionHash === outbox.transactionHash);
    requireInvariant(receipt.transactionDigest === outbox.transactionDigest && receipt.chainNonce === outbox.chainNonce);
    requireInvariant(observedAt >= persistedAt && observedAt <= updatedAt);
  }

  const failureReason = record.failureReason;
  switch (record.status) {
    case 'RESERVED':
      requireInvariant(simulation === null && authorization === null && signingClaim === null && outbox === null && receipt === null && failureReason === null);
      break;
    case 'SIMULATED':
      requireInvariant(simulation !== null && authorization === null && signingClaim === null && outbox === null && receipt === null && failureReason === null);
      break;
    case 'AUTHORIZED':
      requireInvariant(simulation !== null && authorization !== null && signingClaim === null && outbox === null && receipt === null && failureReason === null);
      break;
    case 'SIGNING_CLAIMED':
      requireInvariant(simulation !== null && authorization !== null && signingClaim !== null && outbox === null && receipt === null && failureReason === null);
      break;
    case 'SIGNED_OUTBOX':
      requireInvariant(simulation !== null && authorization !== null && signingClaim !== null && outbox !== null && receipt === null && failureReason === null);
      requireInvariant(outbox.broadcastAttempts === 0);
      break;
    case 'SUBMISSION_UNCERTAIN':
    case 'SUBMITTED':
      requireInvariant(simulation !== null && authorization !== null && signingClaim !== null && outbox !== null && receipt === null && failureReason === null);
      requireInvariant(outbox.broadcastAttempts > 0);
      break;
    case 'CONFIRMED':
      requireInvariant(simulation !== null && authorization !== null && signingClaim !== null && outbox !== null);
      requireInvariant(receipt?.outcome === 'CONFIRMED' && failureReason === null && outbox.broadcastAttempts > 0);
      break;
    case 'FAILED':
      requireInvariant(failureReason !== null);
      if (receipt === null) {
        requireInvariant(signingClaim === null && outbox === null);
      } else {
        requireInvariant(simulation !== null && authorization !== null && signingClaim !== null && outbox !== null);
        requireInvariant(receipt.outcome === 'REVERTED' && failureReason === 'EXACT_TRANSACTION_REVERTED');
        requireInvariant(outbox.broadcastAttempts > 0);
      }
      break;
    case 'RELEASED':
      requireInvariant(signingClaim === null && outbox === null && receipt === null && failureReason !== null);
      break;
    default:
      invalid();
  }
}
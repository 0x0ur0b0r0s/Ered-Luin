import { z } from 'zod';
import { EVM_ADDRESS, ISO_TIMESTAMP, SUPPORTED_CHAIN_ID, UNSIGNED_INTEGER_STRING, transactionDigestSchema, executionLifecycleRecordSchema, executionKillSwitchSchema } from './schemas.js';
import { g3bUnsignedTransactionSchema } from './g3b.js';

const UUID = z.uuid();
const HASH32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/u);
const SIGNATURE = z.string().regex(/^0x[0-9a-f]{128}$/u);
const POSITIVE = z.string().max(78).regex(/^[1-9][0-9]*$/u);
const SIGNED = z.string().max(78).regex(/^-?(0|[1-9][0-9]*)$/u);
const g3cEvidenceBase = {
  version: z.union([z.literal(2), z.literal(3)]), serviceId: z.literal('ered-luin-g3c-evidence'),
  environment: z.enum(['production', 'synthetic-test']), keyId: z.string().min(1).max(80),
  sourceFinality: z.enum(['unsafe', 'safe', 'finalized', 'historical-finalized']).nullable().optional(),
  sourceBlockNumber: UNSIGNED_INTEGER_STRING.nullable(), sourceBlockHash: HASH32.nullable(),
  sourceBlockTimestamp: z.number().int().nonnegative().safe().nullable(),
  latestHeadNumber: UNSIGNED_INTEGER_STRING, latestHeadHash: HASH32, latestHeadTimestamp: z.number().int().nonnegative().safe(),
  safeHeadNumber: UNSIGNED_INTEGER_STRING, safeHeadHash: HASH32, safeHeadTimestamp: z.number().int().nonnegative().safe(),
  finalizedHeadNumber: UNSIGNED_INTEGER_STRING, finalizedHeadHash: HASH32, finalizedHeadTimestamp: z.number().int().nonnegative().safe(),
  feeValuationBlockNumber: UNSIGNED_INTEGER_STRING.nullable(), feeValuationBlockHash: HASH32.nullable(),
  feeValuationBlockTimestamp: z.number().int().nonnegative().safe().nullable(),
};
const accountSnapshotEvidenceSchema = z.object({
  ...g3cEvidenceBase, kind: z.literal('ACCOUNT_SNAPSHOT'), walletAddress: EVM_ADDRESS, chainId: z.literal(SUPPORTED_CHAIN_ID),
  accountVersion: z.number().int().positive().safe(), blockNumber: UNSIGNED_INTEGER_STRING, blockHash: HASH32,
  blockFinality: z.enum(['safe', 'finalized', 'unsafe']), pendingNonce: UNSIGNED_INTEGER_STRING,
  usdcBalanceAtomic: UNSIGNED_INTEGER_STRING, wethBalanceAtomic: UNSIGNED_INTEGER_STRING, gasBalanceNativeWei: UNSIGNED_INTEGER_STRING,
  allowanceToken: EVM_ADDRESS, allowanceSpender: EVM_ADDRESS, allowanceAtomic: UNSIGNED_INTEGER_STRING,
  usdcValueUsdcMicros: UNSIGNED_INTEGER_STRING, wethValueUsdcMicros: UNSIGNED_INTEGER_STRING,
  gasValueUsdcMicros: UNSIGNED_INTEGER_STRING, walletValueUsdcMicros: UNSIGNED_INTEGER_STRING,
  valuationPool: EVM_ADDRESS, valuationBlockNumber: UNSIGNED_INTEGER_STRING, valuationBlockHash: HASH32,
  observedAt: ISO_TIMESTAMP, expiresAt: ISO_TIMESTAMP,
}).strict();
const quoteEvidenceSchema = z.object({
  ...g3cEvidenceBase, kind: z.literal('QUOTE'), executionId: UUID, operationId: UUID, chainId: z.literal(SUPPORTED_CHAIN_ID),
  poolAddress: EVM_ADDRESS, tokenIn: EVM_ADDRESS, tokenOut: EVM_ADDRESS, fee: z.literal(500),
  amountIn: POSITIVE, amountOut: POSITIVE, minimumAmountOut: POSITIVE,
  slippageBps: z.number().int().nonnegative().safe(), priceImpactBps: z.number().int().nonnegative().safe(),
  blockNumber: UNSIGNED_INTEGER_STRING, blockHash: HASH32, observedAt: ISO_TIMESTAMP, expiresAt: ISO_TIMESTAMP,
}).strict();
const simulationEvidenceSchema = z.object({
  ...g3cEvidenceBase, kind: z.literal('SIMULATION'), executionId: UUID, operationId: UUID, chainId: z.literal(SUPPORTED_CHAIN_ID),
  transactionDigest: transactionDigestSchema, unsignedTransactionHash: HASH32, outcome: z.enum(['PASSED', 'FAILED']),
  blockNumber: UNSIGNED_INTEGER_STRING, blockHash: HASH32, gasEstimate: POSITIVE, revertGasEstimate: POSITIVE,
  observedAt: ISO_TIMESTAMP, expiresAt: ISO_TIMESTAMP,
}).strict();
const feeEvidenceSchema = z.object({
  ...g3cEvidenceBase, kind: z.literal('BASE_FEE'), executionId: UUID, operationId: UUID, chainId: z.literal(SUPPORTED_CHAIN_ID),
  unsignedTransactionHash: HASH32, blockNumber: UNSIGNED_INTEGER_STRING, blockHash: HASH32,
  gasLimit: POSITIVE, maxFeePerGasWei: POSITIVE,
  executionGasFeeCapWei: POSITIVE, l1DataFeeWei: UNSIGNED_INTEGER_STRING, operatorFeeWei: UNSIGNED_INTEGER_STRING,
  safetyMarginWei: UNSIGNED_INTEGER_STRING, totalFeeWei: POSITIVE, valueUsdcMicros: POSITIVE,
  includesRevertPath: z.literal(true), observedAt: ISO_TIMESTAMP, expiresAt: ISO_TIMESTAMP,
}).strict();
const fundingAdjustmentEvidenceSchema = z.object({
  ...g3cEvidenceBase, kind: z.literal('FUNDING_ADJUSTMENT'), walletAddress: EVM_ADDRESS, chainId: z.literal(SUPPORTED_CHAIN_ID),
  token: z.literal('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), direction: z.enum(['DEPOSIT', 'WITHDRAWAL']),
  amountAtomic: POSITIVE, transactionHash: HASH32, logIndex: z.number().int().nonnegative().safe(),
  blockNumber: UNSIGNED_INTEGER_STRING, blockHash: HASH32, finality: z.literal('finalized'),
  observedAt: ISO_TIMESTAMP, expiresAt: ISO_TIMESTAMP,
}).strict();
const receiptEvidenceSchema = z.object({
  ...g3cEvidenceBase, kind: z.literal('RECEIPT'), executionId: UUID, operationId: UUID, chainId: z.literal(SUPPORTED_CHAIN_ID),
  transactionHash: HASH32, sender: EVM_ADDRESS, nonce: UNSIGNED_INTEGER_STRING, outcome: z.enum(['PENDING', 'CONFIRMED', 'REVERTED', 'REPLACED', 'CONFLICT']),
  blockNumber: UNSIGNED_INTEGER_STRING.nullable(), blockHash: HASH32.nullable(), finality: z.enum(['unsafe', 'safe', 'finalized']).nullable(),
  gasUsed: UNSIGNED_INTEGER_STRING.nullable(), effectiveGasPriceWei: UNSIGNED_INTEGER_STRING.nullable(),
  l1FeeWei: UNSIGNED_INTEGER_STRING.nullable(), operatorFeeWei: UNSIGNED_INTEGER_STRING.nullable(),
  actualFeeUsdcMicros: UNSIGNED_INTEGER_STRING.nullable(), canonical: z.boolean().nullable(),
  observedAt: ISO_TIMESTAMP, expiresAt: ISO_TIMESTAMP,
}).strict().superRefine((value, ctx) => {
  const terminal = value.outcome === 'CONFIRMED' || value.outcome === 'REVERTED';
  const actuals = [value.blockNumber, value.blockHash, value.finality, value.gasUsed, value.effectiveGasPriceWei,
    value.l1FeeWei, value.operatorFeeWei, value.actualFeeUsdcMicros, value.canonical];
  if (terminal && actuals.some((item) => item === null)) ctx.addIssue({ code: 'custom', message: 'Terminal receipts require exact block, finality, fee, and canonicality data' });
  if (!terminal && actuals.some((item) => item !== null)) ctx.addIssue({ code: 'custom', message: 'Non-terminal receipts cannot claim settlement data' });
});
export const g3cEvidencePayloadSchema = z.discriminatedUnion('kind', [
  accountSnapshotEvidenceSchema, fundingAdjustmentEvidenceSchema, quoteEvidenceSchema, simulationEvidenceSchema, feeEvidenceSchema, receiptEvidenceSchema,
]).superRefine((value, ctx) => {
  const hasSourceFinality = value.sourceFinality !== undefined;
  if (value.version === 2 && hasSourceFinality) {
    ctx.addIssue({ code: 'custom', path: ['sourceFinality'], message: 'Version 2 evidence cannot carry source finality' });
  }
  if (value.version === 3 && !hasSourceFinality) {
    ctx.addIssue({ code: 'custom', path: ['sourceFinality'], message: 'Version 3 evidence requires explicit source finality' });
  }
  if (value.kind === 'ACCOUNT_SNAPSHOT') {
    if (value.version === 2 && value.blockFinality === 'unsafe') {
      ctx.addIssue({ code: 'custom', path: ['blockFinality'], message: 'Unsafe snapshots require evidence version 3' });
    }
    if (value.version === 3 && value.sourceFinality !== value.blockFinality) {
      ctx.addIssue({ code: 'custom', path: ['sourceFinality'], message: 'Snapshot source finality must match block finality' });
    }
  } else if (value.kind === 'FUNDING_ADJUSTMENT' && value.version === 3 && value.sourceFinality !== 'historical-finalized') {
    ctx.addIssue({ code: 'custom', path: ['sourceFinality'], message: 'Funding evidence must be historical-finalized' });
  } else if (value.kind === 'RECEIPT' && value.version === 3) {
    const terminal = value.outcome === 'CONFIRMED' || value.outcome === 'REVERTED';
    const expectedSourceFinality = value.finality === 'finalized' ? 'historical-finalized' : value.finality;
    if ((terminal && value.sourceFinality !== expectedSourceFinality) || (!terminal && value.sourceFinality !== null)) {
      ctx.addIssue({ code: 'custom', path: ['sourceFinality'], message: 'Receipt source purpose must match the receipt state' });
    }
    if (terminal && (value.feeValuationBlockNumber !== value.blockNumber ||
        value.feeValuationBlockHash?.toLowerCase() !== value.blockHash?.toLowerCase() ||
        value.feeValuationBlockTimestamp !== value.sourceBlockTimestamp)) {
      ctx.addIssue({ code: 'custom', path: ['feeValuationBlockNumber'], message: 'Version 3 receipt fees must use the receipt block valuation' });
    }
  } else if ((value.kind === 'QUOTE' || value.kind === 'SIMULATION' || value.kind === 'BASE_FEE') &&
      value.version === 3 && value.sourceFinality !== 'unsafe' && value.sourceFinality !== 'safe') {
    ctx.addIssue({ code: 'custom', path: ['sourceFinality'], message: 'Execution evidence requires an execution-state source' });
  }
});
export type G3cEvidencePayload = z.infer<typeof g3cEvidencePayloadSchema>;
export const g3cEvidenceAttestationSchema = z.object({ payload: g3cEvidencePayloadSchema, signature: SIGNATURE }).strict();
export type G3cEvidenceAttestation = z.infer<typeof g3cEvidenceAttestationSchema>;

export const g3cSessionStatusSchema = z.enum(['ACTIVE', 'STOPPED', 'CLOSED']);
const fundingAdjustmentSchema = z.object({
  adjustmentId: UUID, deltaUsdcMicros: SIGNED, sourceDigest: transactionDigestSchema,
  sourceEvidence: g3cEvidenceAttestationSchema, recordedAt: ISO_TIMESTAMP,
}).strict();
export const g3cSessionSchema = z.object({
  version: z.literal(1), sessionId: UUID, walletAddress: EVM_ADDRESS, status: g3cSessionStatusSchema,
  initialEquityUsdcMicros: POSITIVE, externalFundingAdjustments: z.array(fundingAdjustmentSchema).max(1000),
  realizedLossUsdcMicros: UNSIGNED_INTEGER_STRING, realizedFeesUsdcMicros: UNSIGNED_INTEGER_STRING,
  unrealizedLossUsdcMicros: UNSIGNED_INTEGER_STRING, markedExposureUsdcMicros: UNSIGNED_INTEGER_STRING,
  outstandingWorstCaseReservationsUsdcMicros: UNSIGNED_INTEGER_STRING,
  latestAccountVersion: z.number().int().nonnegative().safe(), latestSnapshotDigest: transactionDigestSchema.nullable(), latestSnapshot: g3cEvidenceAttestationSchema.nullable(),
  createdAt: ISO_TIMESTAMP, updatedAt: ISO_TIMESTAMP, revision: z.number().int().positive().safe(),
}).strict();
export type G3cSession = z.infer<typeof g3cSessionSchema>;

export const g3cWorkflowStatusSchema = z.enum([
  'AUTHORIZED', 'SIGNING_CLAIMED', 'SIGNED_OUTBOX', 'SUBMISSION_UNCERTAIN', 'SUBMITTED',
  'CONFIRMED', 'REVERTED', 'RECONCILIATION_REQUIRED', 'CANCELLED',
]);
export const g3cWorkflowSchema = z.object({
  version: z.literal(1), executionId: UUID, intentId: UUID, decisionId: UUID, reservationId: UUID, operationId: UUID, sessionId: UUID,
  kind: z.enum(['APPROVAL', 'SWAP']), status: g3cWorkflowStatusSchema,
  accountVersion: z.number().int().positive().safe(), accountSnapshot: g3cEvidenceAttestationSchema, signingAccountSnapshot: g3cEvidenceAttestationSchema.nullable(),
  quote: g3cEvidenceAttestationSchema.nullable(), simulation: g3cEvidenceAttestationSchema,
  fee: g3cEvidenceAttestationSchema, unsignedTransaction: g3bUnsignedTransactionSchema,
  transactionDigest: transactionDigestSchema, authorizationId: UUID,
  signingClaimId: UUID.nullable(), claimedAt: ISO_TIMESTAMP.nullable(),
  signedBytesHex: z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/u).max(65_538).nullable(),
  signedBytesDigest: transactionDigestSchema.nullable(), transactionHash: HASH32.nullable(),
  submissionAttempts: z.number().int().nonnegative().safe(), receipt: g3cEvidenceAttestationSchema.nullable(),
  settlementSnapshot: g3cEvidenceAttestationSchema.nullable(), reservedWorstCaseLossUsdcMicros: UNSIGNED_INTEGER_STRING, actualFeesUsdcMicros: UNSIGNED_INTEGER_STRING,
  actualLossUsdcMicros: UNSIGNED_INTEGER_STRING, intentExpiresAt: ISO_TIMESTAMP,
  failureReason: z.string().min(1).max(240).nullable(), createdAt: ISO_TIMESTAMP, updatedAt: ISO_TIMESTAMP,
  revision: z.number().int().positive().safe(),
}).strict().superRefine((value, ctx) => {
  const claimed = ['SIGNING_CLAIMED', 'SIGNED_OUTBOX', 'SUBMISSION_UNCERTAIN', 'SUBMITTED', 'CONFIRMED', 'REVERTED', 'RECONCILIATION_REQUIRED'].includes(value.status);
  const outbox = ['SIGNED_OUTBOX', 'SUBMISSION_UNCERTAIN', 'SUBMITTED', 'CONFIRMED', 'REVERTED', 'RECONCILIATION_REQUIRED'].includes(value.status);
  const settled = value.status === 'CONFIRMED' || value.status === 'REVERTED';
  if (claimed !== Boolean(value.signingClaimId && value.claimedAt && value.signingAccountSnapshot)) ctx.addIssue({ code: 'custom', path: ['signingClaimId'], message: 'Signing claim does not match workflow state' });
  if (outbox !== Boolean(value.signedBytesHex && value.signedBytesDigest && value.transactionHash)) ctx.addIssue({ code: 'custom', path: ['signedBytesHex'], message: 'Signed outbox does not match workflow state' });
  if (settled && (!value.receipt || !value.settlementSnapshot)) ctx.addIssue({ code: 'custom', path: ['receipt'], message: 'Final settlement requires receipt and reconciled account snapshot' });
  if (!settled && value.settlementSnapshot) ctx.addIssue({ code: 'custom', path: ['settlementSnapshot'], message: 'Only terminal workflows retain a settlement snapshot' });
  if (settled && value.status === 'CONFIRMED' && value.receipt?.payload.kind === 'RECEIPT' && value.receipt.payload.outcome !== 'CONFIRMED') ctx.addIssue({ code: 'custom', path: ['receipt'], message: 'Confirmed status requires a successful receipt' });
  if (settled && value.status === 'REVERTED' && value.receipt?.payload.kind === 'RECEIPT' && value.receipt.payload.outcome !== 'REVERTED') ctx.addIssue({ code: 'custom', path: ['receipt'], message: 'Reverted status requires a reverted receipt' });
  if (value.status === 'CANCELLED' && (claimed || outbox || value.receipt)) ctx.addIssue({ code: 'custom', path: ['status'], message: 'A workflow cannot be cancelled after signing begins' });
});
export type G3cWorkflow = z.infer<typeof g3cWorkflowSchema>;

export const g3cSigningRequestSchema = z.object({
  version: z.literal(1), requestId: UUID, requestAt: ISO_TIMESTAMP,
  parent: executionLifecycleRecordSchema, workflow: g3cWorkflowSchema, session: g3cSessionSchema, killSwitch: executionKillSwitchSchema,
  signingClaimId: UUID, accountVersion: z.number().int().positive().safe(),
}).strict().superRefine((value, ctx) => {
  if (value.workflow.status !== 'SIGNING_CLAIMED' || value.workflow.signingClaimId !== value.signingClaimId ||
      value.workflow.accountVersion !== value.accountVersion || value.parent.status !== 'RESERVED' ||
      value.parent.executionId !== value.workflow.executionId || value.parent.intentId !== value.workflow.intentId ||
      value.parent.decisionId !== value.workflow.decisionId || value.parent.reservationId !== value.workflow.reservationId ||
      value.parent.walletAddress.toLowerCase() !== value.workflow.unsignedTransaction.from.toLowerCase() ||
      value.session.sessionId !== value.workflow.sessionId || value.session.walletAddress.toLowerCase() !== value.parent.walletAddress.toLowerCase() ||
      value.killSwitch.stopped !== false) {
    ctx.addIssue({ code: 'custom', path: ['workflow'], message: 'Signing request does not match durable execution authority' });
  }
});
export type G3cSigningRequest = z.infer<typeof g3cSigningRequestSchema>;
export const g3cSignerMessageSchema = z.object({ payload: g3cSigningRequestSchema, mac: z.string().regex(/^[0-9a-f]{64}$/u) }).strict();

export const g3cStatusResponseSchema = z.object({
  executionId: UUID, inputAsset: z.enum(['USDC','WETH']), requestedAmount: UNSIGNED_INTEGER_STRING, permittedAmount: UNSIGNED_INTEGER_STRING.nullable(),
  policyReason: z.string().min(1).max(240), mode: z.enum(['PAPER', 'LIVE_DISABLED', 'LIVE_REVIEWED']),
  status: z.enum(['NOT_STARTED', 'AUTHORIZED', 'SIGNING_CLAIMED', 'SIGNED_OUTBOX', 'PENDING', 'UNKNOWN', 'CONFIRMED', 'REVERTED', 'CANCELLED', 'RECONCILIATION_REQUIRED']),
  transactionHash: HASH32.nullable(), receipt: g3cEvidenceAttestationSchema.nullable(), actualFeesUsdcMicros: UNSIGNED_INTEGER_STRING.nullable(),
  evidenceProvenance: z.array(z.string().min(1).max(160)).max(32),
}).strict();
export type G3cStatusResponse = z.infer<typeof g3cStatusResponseSchema>;

export type G3cEvidenceHeadAnchor = Pick<G3cEvidencePayload,
  'latestHeadNumber' | 'latestHeadHash' | 'latestHeadTimestamp' |
  'safeHeadNumber' | 'safeHeadHash' | 'safeHeadTimestamp' |
  'finalizedHeadNumber' | 'finalizedHeadHash' | 'finalizedHeadTimestamp'>;
export type G3cSourceFinality = 'safe' | 'finalized' | 'historical-finalized' | 'unsafe';

/** Bounded application freshness rules for evidence anchored to Base L2 heads. */
export function assertG3cHeadFreshness(
  anchor: G3cEvidenceHeadAnchor, nowMs: number,
  source?: { readonly number: string; readonly hash: string; readonly timestamp: number; readonly finality: G3cSourceFinality },
): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('G3C_CLOCK_INVALID');
  const latest = BigInt(anchor.latestHeadNumber);
  const safe = BigInt(anchor.safeHeadNumber);
  const finalized = BigInt(anchor.finalizedHeadNumber);
  const latestMs = anchor.latestHeadTimestamp * 1000;
  if (latest < safe || safe < finalized ||
      anchor.safeHeadTimestamp > anchor.latestHeadTimestamp + 2 ||
      anchor.finalizedHeadTimestamp > anchor.safeHeadTimestamp + 2 ||
      latestMs > nowMs + 2_000) throw new Error('G3C_BASE_HEAD_STALE_OR_INCONSISTENT');

  const executionEvidence = !source || source.finality === 'unsafe' || source.finality === 'safe';
  if (executionEvidence && nowMs - latestMs > 6_000) {
    throw new Error('G3C_BASE_HEAD_STALE_OR_INCONSISTENT');
  }
  if (!source) return;
  const number = BigInt(source.number);
  const sourceMs = source.timestamp * 1000;
  if (!source.hash || number > latest || source.timestamp > anchor.latestHeadTimestamp + 2 || sourceMs > nowMs + 2_000) {
    throw new Error('G3C_SOURCE_ANCHOR_INVALID');
  }
  if (source.finality === 'finalized') {
    if (number > finalized || finalized - number > 600n || source.timestamp > anchor.finalizedHeadTimestamp + 2 ||
        nowMs - sourceMs > 1_200_000) throw new Error('G3C_SETTLEMENT_HEAD_STALE_OR_INCONSISTENT');
  } else if (source.finality === 'historical-finalized') {
    if (number > finalized || source.timestamp > anchor.finalizedHeadTimestamp + 2) {
      throw new Error('G3C_HISTORICAL_FINALIZED_SOURCE_INCONSISTENT');
    }
  } else if (source.finality === 'safe') {
    const safeMs = anchor.safeHeadTimestamp * 1000;
    if (number > safe || safe - number > 6n || source.timestamp > anchor.safeHeadTimestamp + 2 ||
        safeMs > nowMs + 2_000 || nowMs - safeMs > 12_000 || nowMs - sourceMs > 12_000) {
      throw new Error('G3C_EXECUTION_SOURCE_STALE_OR_INCONSISTENT');
    }
  } else if (number > latest || latest - number > 6n || nowMs - sourceMs > 6_000) {
    throw new Error('G3C_UNSAFE_EXECUTION_SOURCE_STALE_OR_INCONSISTENT');
  }
}
export function assertG3cEvidenceSourceFreshness(payload: G3cEvidencePayload, nowMs: number): void {
  const sourceNumber = payload.sourceBlockNumber;
  const sourceHash = payload.sourceBlockHash;
  const sourceTimestamp = payload.sourceBlockTimestamp;
  const evidenceBlock = payload.kind === 'RECEIPT' ? payload.blockNumber :
    payload.kind === 'ACCOUNT_SNAPSHOT' || payload.kind === 'QUOTE' || payload.kind === 'SIMULATION' ||
    payload.kind === 'BASE_FEE' || payload.kind === 'FUNDING_ADJUSTMENT' ? payload.blockNumber : null;
  const evidenceHash = payload.kind === 'RECEIPT' ? payload.blockHash :
    payload.kind === 'ACCOUNT_SNAPSHOT' || payload.kind === 'QUOTE' || payload.kind === 'SIMULATION' ||
    payload.kind === 'BASE_FEE' || payload.kind === 'FUNDING_ADJUSTMENT' ? payload.blockHash : null;
  if (evidenceBlock !== sourceNumber || evidenceHash?.toLowerCase() !== sourceHash?.toLowerCase()) {
    throw new Error('G3C_SOURCE_DOES_NOT_MATCH_EVIDENCE_BLOCK');
  }
  const legacyFinality: G3cSourceFinality = payload.kind === 'ACCOUNT_SNAPSHOT' ? payload.blockFinality :
    payload.kind === 'FUNDING_ADJUSTMENT' ? 'historical-finalized' :
      payload.kind === 'RECEIPT'
        ? payload.finality === 'finalized' ? 'historical-finalized' : payload.finality ?? 'unsafe'
        : 'safe';
  const sourceFinality = payload.version === 3 ? payload.sourceFinality! : legacyFinality;
  if (payload.kind === 'RECEIPT') {
    const terminal = payload.outcome === 'CONFIRMED' || payload.outcome === 'REVERTED';
    const feeAnchorPresent = payload.feeValuationBlockNumber !== null && payload.feeValuationBlockHash !== null &&
      payload.feeValuationBlockTimestamp !== null;
    const anyFeeAnchor = payload.feeValuationBlockNumber !== null || payload.feeValuationBlockHash !== null ||
      payload.feeValuationBlockTimestamp !== null;
    if (terminal !== feeAnchorPresent || !terminal && anyFeeAnchor) throw new Error('G3C_RECEIPT_FEE_VALUATION_ANCHOR_INVALID');
    if (terminal) {
      if (payload.version === 3 && (payload.feeValuationBlockNumber !== payload.blockNumber ||
          payload.feeValuationBlockHash?.toLowerCase() !== payload.blockHash?.toLowerCase() ||
          payload.feeValuationBlockTimestamp !== payload.sourceBlockTimestamp)) {
        throw new Error('G3C_RECEIPT_FEE_VALUATION_ANCHOR_INVALID');
      }
      assertG3cHeadFreshness(payload, nowMs, {
        number: payload.feeValuationBlockNumber!, hash: payload.feeValuationBlockHash!,
        timestamp: payload.feeValuationBlockTimestamp!,
        finality: payload.version === 3 && payload.finality === 'finalized' ? 'historical-finalized' :
          payload.version === 3 ? payload.finality! : 'safe',
      });
    }
  } else if (payload.feeValuationBlockNumber !== null || payload.feeValuationBlockHash !== null ||
      payload.feeValuationBlockTimestamp !== null) throw new Error('G3C_UNEXPECTED_FEE_VALUATION_ANCHOR');

  if (sourceNumber === null || sourceHash === null || sourceTimestamp === null) {
    if (payload.kind !== 'RECEIPT' || payload.outcome === 'CONFIRMED' || payload.outcome === 'REVERTED' ||
        sourceNumber !== null || sourceHash !== null || sourceTimestamp !== null) throw new Error('G3C_SOURCE_ANCHOR_MISSING');
    assertG3cHeadFreshness(payload, nowMs);
    return;
  }
  assertG3cHeadFreshness(payload, nowMs, { number: sourceNumber, hash: sourceHash, timestamp: sourceTimestamp,
    finality: sourceFinality });
}

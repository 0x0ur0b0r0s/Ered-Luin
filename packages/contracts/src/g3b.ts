import { z } from 'zod';
import {
  decisionSchema, EVM_ADDRESS, executionAuthorizationEnvelopeSchema, executionLifecycleRecordSchema,
  executionSigningClaimSchema, ISO_TIMESTAMP, SUPPORTED_CHAIN_ID, tradeIntentSchema,
  UNSIGNED_INTEGER_STRING, transactionDigestSchema,
} from './schemas.js';

const UUID = z.uuid();
const HASH32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/u);
const HEX_SIGNATURE = z.string().regex(/^0x[0-9a-f]{128}$/u);
const HEX_CALLDATA = z.string().max(131_074).regex(/^0x(?:[0-9a-fA-F]{2})+$/u);
const POSITIVE = z.string().max(78).regex(/^[1-9][0-9]*$/u);
const SIGNED_HEX = z.string().max(131_074).regex(/^0x(?:[0-9a-fA-F]{2})+$/u);

export const G3B_CAPS = Object.freeze({
  walletValueUsdcMicros: 25_000_000n,
  tradeValueUsdcMicros: 5_000_000n,
  wethPositionUsdcMicros: 10_000_000n,
  networkFeeUsdcMicros: 250_000n,
  slippageBps: 50,
  priceImpactBps: 50,
  sessionLossUsdcMicros: 2_000_000n,
  authorizationTtlMs: 15_000,
  evidenceTtlMs: 15_000,
});

export const g3bOperationKindSchema = z.enum(['APPROVAL', 'SWAP']);
export type G3bOperationKind = z.infer<typeof g3bOperationKindSchema>;
export const g3bOperationStatusSchema = z.enum(['PREPARED', 'SIMULATED', 'AUTHORIZED', 'SIGNING_CLAIMED', 'SIGNED_OUTBOX', 'SUBMISSION_UNCERTAIN', 'SUBMITTED', 'CONFIRMED', 'FAILED']);

export const g3bUnsignedTransactionSchema = z.object({
  version: z.literal(1), type: z.literal('EIP1559'), chainId: z.literal(SUPPORTED_CHAIN_ID),
  from: EVM_ADDRESS, to: EVM_ADDRESS, data: HEX_CALLDATA, valueWei: UNSIGNED_INTEGER_STRING,
  nonce: UNSIGNED_INTEGER_STRING, gasLimit: POSITIVE, maxFeePerGasWei: POSITIVE, maxPriorityFeePerGasWei: UNSIGNED_INTEGER_STRING,
  accessList: z.array(z.unknown()).max(0),
}).strict().superRefine((tx, ctx) => {
  if (BigInt(tx.maxPriorityFeePerGasWei) > BigInt(tx.maxFeePerGasWei)) ctx.addIssue({ code: 'custom', path: ['maxPriorityFeePerGasWei'], message: 'Priority fee cannot exceed maximum fee' });
});
export type G3bUnsignedTransaction = z.infer<typeof g3bUnsignedTransactionSchema>;

const evidenceBase = {
  version: z.literal(1), serviceId: z.literal('ered-luin-execution-evidence'),
  environment: z.enum(['synthetic-test', 'production']), keyId: z.string().min(1).max(80),
};
const simulationEvidenceSchema = z.object({
  ...evidenceBase, kind: z.literal('SIMULATION'), executionId: UUID, operationId: UUID,
  semanticDigest: transactionDigestSchema, unsignedTransactionHash: HASH32, outcome: z.enum(['PASSED','FAILED']),
  chainId: z.literal(SUPPORTED_CHAIN_ID), blockNumber: UNSIGNED_INTEGER_STRING, blockHash: HASH32,
  poolAddress: EVM_ADDRESS.nullable(), observedAt: ISO_TIMESTAMP, expiresAt: ISO_TIMESTAMP,
}).strict();
const feeEvidenceSchema = z.object({
  ...evidenceBase, kind: z.literal('BASE_FEE'), executionId: UUID, operationId: UUID,
  unsignedTransactionHash: HASH32, gasLimit: POSITIVE, maxFeePerGasWei: POSITIVE,
  executionGasFeeCapWei: POSITIVE, l1DataFeeWei: UNSIGNED_INTEGER_STRING, operatorFeeWei: UNSIGNED_INTEGER_STRING,
  totalFeeWei: POSITIVE, valueUsdcMicros: POSITIVE, includesRevertPath: z.literal(true),
  observedAt: ISO_TIMESTAMP, expiresAt: ISO_TIMESTAMP,
}).strict();
const riskEvidenceSchema = z.object({
  ...evidenceBase, kind: z.literal('SESSION_RISK'), executionId: UUID, operationId: UUID,
  accountVersion: z.number().int().nonnegative().safe(), sessionId: UUID, snapshotVersion: z.number().int().positive().safe(),
  chainId: z.literal(SUPPORTED_CHAIN_ID), blockNumber: UNSIGNED_INTEGER_STRING, blockHash: HASH32,
  walletValueUsdcMicros: POSITIVE, tradeValueUsdcMicros: POSITIVE, wethPositionAfterUsdcMicros: UNSIGNED_INTEGER_STRING,
  slippageBps: z.number().int().nonnegative().safe(), priceImpactBps: z.number().int().nonnegative().safe(),
  currentSessionLossUsdcMicros: UNSIGNED_INTEGER_STRING, reservedSessionLossUsdcMicros: UNSIGNED_INTEGER_STRING,
  worstCaseTradeLossUsdcMicros: UNSIGNED_INTEGER_STRING, workflowFeeReserveUsdcMicros: UNSIGNED_INTEGER_STRING,
  projectedSessionLossUsdcMicros: UNSIGNED_INTEGER_STRING, observedAt: ISO_TIMESTAMP, expiresAt: ISO_TIMESTAMP,
}).strict();
const quoteEvidenceSchema = z.object({
  ...evidenceBase, kind: z.literal('QUOTE'), executionId: UUID, operationId: UUID,
  chainId: z.literal(SUPPORTED_CHAIN_ID), poolAddress: EVM_ADDRESS, tokenIn: EVM_ADDRESS, tokenOut: EVM_ADDRESS,
  fee: z.literal(500), amountIn: POSITIVE, minimumAmountOut: POSITIVE,
  slippageBps: z.number().int().nonnegative().safe(), priceImpactBps: z.number().int().nonnegative().safe(),
  blockNumber: UNSIGNED_INTEGER_STRING, blockHash: HASH32, observedAt: ISO_TIMESTAMP, expiresAt: ISO_TIMESTAMP,
}).strict();
const allowanceEvidenceSchema = z.object({
  ...evidenceBase, kind: z.literal('ALLOWANCE'), executionId: UUID, operationId: UUID,
  chainId: z.literal(SUPPORTED_CHAIN_ID), walletAddress: EVM_ADDRESS, token: EVM_ADDRESS, spender: EVM_ADDRESS,
  allowanceAtomic: UNSIGNED_INTEGER_STRING, nextNonce: UNSIGNED_INTEGER_STRING, blockNumber: UNSIGNED_INTEGER_STRING, blockHash: HASH32,
  observedAt: ISO_TIMESTAMP, expiresAt: ISO_TIMESTAMP,
}).strict();
const approvalReceiptEvidenceSchema = z.object({
  ...evidenceBase, kind: z.literal('APPROVAL_RECEIPT'), executionId: UUID, operationId: UUID,
  chainId: z.literal(SUPPORTED_CHAIN_ID), transactionHash: HASH32, outcome: z.enum(['CONFIRMED','REVERTED']),
  blockNumber: UNSIGNED_INTEGER_STRING, blockHash: HASH32, confirmedAt: ISO_TIMESTAMP,
}).strict();
export const g3bEvidencePayloadSchema = z.discriminatedUnion('kind', [simulationEvidenceSchema, feeEvidenceSchema, riskEvidenceSchema, approvalReceiptEvidenceSchema, allowanceEvidenceSchema, quoteEvidenceSchema]);
export type G3bEvidencePayload = z.infer<typeof g3bEvidencePayloadSchema>;
export const g3bEvidenceAttestationSchema = z.object({ payload: g3bEvidencePayloadSchema, signature: HEX_SIGNATURE }).strict();
export type G3bEvidenceAttestation = z.infer<typeof g3bEvidenceAttestationSchema>;

export const g3bOperationAuthorizationSchema = z.object({
  version: z.literal(1), authorizationId: UUID, executionId: UUID, operationId: UUID,
  g3aAuthorizationId: UUID, g3aAuthorizationNonce: UUID, accountVersion: z.number().int().nonnegative().safe(),
  semanticDigest: transactionDigestSchema, unsignedTransactionHash: HASH32, operationNonce: UUID,
  simulationAttestationDigest: transactionDigestSchema, feeAttestationDigest: transactionDigestSchema,
  riskAttestationDigest: transactionDigestSchema, allowanceAttestationDigest: transactionDigestSchema.nullable(),
  quoteAttestationDigest: transactionDigestSchema.nullable(), issuedAt: ISO_TIMESTAMP, expiresAt: ISO_TIMESTAMP,
}).strict();
export type G3bOperationAuthorization = z.infer<typeof g3bOperationAuthorizationSchema>;

export const g3bApprovalReceiptSchema = z.object({
  version: z.literal(1), transactionHash: HASH32, blockNumber: UNSIGNED_INTEGER_STRING,
  blockHash: HASH32, outcome: z.enum(['CONFIRMED','REVERTED']), confirmedAt: ISO_TIMESTAMP,
}).strict();
export type G3bApprovalReceipt = z.infer<typeof g3bApprovalReceiptSchema>;

export const g3bOperationSchema = z.object({
  version: z.literal(1), executionId: UUID, operationId: UUID, kind: g3bOperationKindSchema,
  status: g3bOperationStatusSchema, semanticDigest: transactionDigestSchema,
  unsignedTransactionHash: HASH32, unsignedTransaction: g3bUnsignedTransactionSchema,
  simulation: g3bEvidenceAttestationSchema.nullable(), fee: g3bEvidenceAttestationSchema.nullable(),
  risk: g3bEvidenceAttestationSchema.nullable(), quoteEvidence: g3bEvidenceAttestationSchema.nullable(),
  allowanceEvidence: g3bEvidenceAttestationSchema.nullable(),
  approvalReceipt: g3bEvidenceAttestationSchema.nullable(), receipt: g3bEvidenceAttestationSchema.nullable(),
  authorization: g3bOperationAuthorizationSchema.nullable(),
  signingClaimId: UUID.nullable(), signedBytesHex: SIGNED_HEX.nullable(),
  signedBytesDigest: transactionDigestSchema.nullable(), transactionHash: HASH32.nullable(),
  broadcastAttempts: z.number().int().nonnegative().safe(), failureReason: z.string().min(1).max(240).nullable(),
  createdAt: ISO_TIMESTAMP, updatedAt: ISO_TIMESTAMP, revision: z.number().int().positive().safe(),
}).strict();
export type G3bOperation = z.infer<typeof g3bOperationSchema>;

export const g3bSignerPayloadSchema = z.object({
  version: z.literal(1), requestId: UUID, requestAt: ISO_TIMESTAMP, stopped: z.literal(false),
  parent: executionLifecycleRecordSchema, operation: g3bOperationSchema,
  intent: tradeIntentSchema, decision: decisionSchema,
  g3aAuthorization: executionAuthorizationEnvelopeSchema, signingClaim: executionSigningClaimSchema,
}).strict();
export type G3bSignerPayload = z.infer<typeof g3bSignerPayloadSchema>;
export const g3bSignerMessageSchema = z.object({ payload: g3bSignerPayloadSchema, mac: z.string().regex(/^[0-9a-f]{64}$/u) }).strict();
export type G3bSignerMessage = z.infer<typeof g3bSignerMessageSchema>;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new TypeError('Non-finite numbers cannot be canonicalized'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  throw new TypeError('Value is not JSON-canonicalizable');
}
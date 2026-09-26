import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { G3bEvidenceAttestation, G3bEvidencePayload } from '@ered-luin/contracts';
import { signG3bEvidence, type G3bEvidenceTrust } from './g3b-evidence.js';

export interface AllowanceQuery { readonly executionId: string; readonly operationId: string; readonly chainId: 8453; readonly walletAddress: string; readonly token: string; readonly spender: string; readonly allowanceAtomic: string; readonly nextNonce: string; readonly blockNumber: string; readonly blockHash: `0x${string}`; }
export interface QuoteQuery { readonly executionId: string; readonly operationId: string; readonly chainId: 8453; readonly poolAddress: string; readonly tokenIn: string; readonly tokenOut: string; readonly fee: 500; readonly amountIn: string; readonly minimumAmountOut: string; readonly slippageBps: number; readonly priceImpactBps: number; readonly blockNumber: string; readonly blockHash: `0x${string}`; }
export interface SimulationQuery { readonly executionId: string; readonly operationId: string; readonly semanticDigest: string; readonly unsignedTransactionHash: `0x${string}`; readonly poolAddress: string | null; readonly blockNumber: string; readonly blockHash: `0x${string}`; }
export interface BaseFeeQuery { readonly executionId: string; readonly operationId: string; readonly unsignedTransactionHash: `0x${string}`; readonly gasLimit: string; readonly maxFeePerGasWei: string; readonly l1DataFeeWei: string; readonly operatorFeeWei: string; readonly valueUsdcMicros: string; }
export interface SessionRiskQuery { readonly executionId: string; readonly operationId: string; readonly accountVersion: number; readonly sessionId: string; readonly snapshotVersion: number; readonly blockNumber: string; readonly blockHash: `0x${string}`; readonly walletValueUsdcMicros: string; readonly tradeValueUsdcMicros: string; readonly wethPositionAfterUsdcMicros: string; readonly slippageBps: number; readonly priceImpactBps: number; readonly currentSessionLossUsdcMicros: string; readonly reservedSessionLossUsdcMicros: string; readonly worstCaseTradeLossUsdcMicros: string; readonly workflowFeeReserveUsdcMicros: string; }
export interface ReceiptQuery { readonly executionId: string; readonly operationId: string; readonly chainId: 8453; readonly transactionHash: `0x${string}`; readonly outcome: 'CONFIRMED' | 'REVERTED'; readonly blockNumber: string; readonly blockHash: `0x${string}`; }
export interface G3bEvidenceProvider {
  allowance(query: AllowanceQuery): Promise<G3bEvidenceAttestation>;
  quote(query: QuoteQuery): Promise<G3bEvidenceAttestation>;
  simulate(query: SimulationQuery): Promise<G3bEvidenceAttestation>;
  baseFee(query: BaseFeeQuery): Promise<G3bEvidenceAttestation>;
  sessionRisk(query: SessionRiskQuery): Promise<G3bEvidenceAttestation>;
  receipt(query: ReceiptQuery): Promise<G3bEvidenceAttestation>;
}
type G3bEvidenceDraft<T = G3bEvidencePayload> = T extends object ? Omit<T, 'version' | 'serviceId' | 'environment' | 'keyId'> : never;
export interface SyntheticProviderBundle { readonly provider: G3bEvidenceProvider; readonly trust: G3bEvidenceTrust; readonly publicKeyPem: string; readonly attest: (payload: G3bEvidencePayload) => G3bEvidenceAttestation; }

/** Runtime-generated synthetic evidence only; never accepted by the production signer configuration. */
export function createSyntheticG3bEvidenceProvider(clock: () => Date = () => new Date()): SyntheticProviderBundle {
  const pair = generateKeyPairSync('ed25519');
  const keyId = 'synthetic-g3b-runtime';
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKey: KeyObject = pair.privateKey;
  const trust: G3bEvidenceTrust = { environment: 'synthetic-test', publicKeys: { [keyId]: publicKeyPem }, allowSyntheticTestEvidence: true };
  function attest(payload: G3bEvidenceDraft): G3bEvidenceAttestation {
    const at = clock();
    if (!(at instanceof Date) || !Number.isSafeInteger(at.getTime())) throw new Error('SYNTHETIC_CLOCK_INVALID');
    return signG3bEvidence({ ...payload, version: 1, serviceId: 'ered-luin-execution-evidence', environment: 'synthetic-test', keyId } as G3bEvidencePayload, privateKey);
  }
  const provider: G3bEvidenceProvider = {
    async allowance(q) { return attest({ kind: 'ALLOWANCE', ...q, observedAt: clock().toISOString(), expiresAt: new Date(clock().getTime() + 10_000).toISOString() }); },
    async quote(q) { return attest({ kind: 'QUOTE', ...q, observedAt: clock().toISOString(), expiresAt: new Date(clock().getTime() + 10_000).toISOString() }); },
    async simulate(q) { return attest({ kind: 'SIMULATION', ...q, outcome: 'PASSED', chainId: 8453, observedAt: clock().toISOString(), expiresAt: new Date(clock().getTime() + 10_000).toISOString() }); },
    async baseFee(q) {
      const executionGasFeeCapWei = (BigInt(q.gasLimit) * BigInt(q.maxFeePerGasWei)).toString();
      const totalFeeWei = (BigInt(executionGasFeeCapWei) + BigInt(q.l1DataFeeWei) + BigInt(q.operatorFeeWei)).toString();
      return attest({ kind: 'BASE_FEE', ...q, executionGasFeeCapWei, totalFeeWei, includesRevertPath: true,
        observedAt: clock().toISOString(), expiresAt: new Date(clock().getTime() + 10_000).toISOString() });
    },
    async sessionRisk(q) {
      const projectedSessionLossUsdcMicros = (BigInt(q.currentSessionLossUsdcMicros) + BigInt(q.reservedSessionLossUsdcMicros) +
        BigInt(q.worstCaseTradeLossUsdcMicros) + BigInt(q.workflowFeeReserveUsdcMicros)).toString();
      return attest({ kind: 'SESSION_RISK', ...q, chainId: 8453, projectedSessionLossUsdcMicros,
        observedAt: clock().toISOString(), expiresAt: new Date(clock().getTime() + 10_000).toISOString() });
    },
    async receipt(q) { return attest({ kind: 'APPROVAL_RECEIPT', ...q, confirmedAt: clock().toISOString() }); },
  };
  return { provider, trust, publicKeyPem, attest: (payload) => signG3bEvidence(payload, privateKey) };
}

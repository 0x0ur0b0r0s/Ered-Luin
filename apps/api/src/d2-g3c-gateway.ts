import type { G3cExecutionStore } from './g3c-execution-store.js';
import type { G3cReadOnlyBaseProvider } from './g3c-base-provider.js';
import type { G3bUnsignedTransaction, G3cEvidenceAttestation, G3cSession, G3cStatusResponse, G3cWorkflow } from '@ered-luin/contracts';
import {
  simulateBaseG3cOperation, reconcileBaseG3cOperation, startBaseG3cSession,
} from './g3c-orchestrator.js';

export interface D2G3cGateway {
  startSession(input: { readonly sessionId: string; readonly walletAddress: string; readonly reason: string }): Promise<G3cSession>;
  assertActiveSession(sessionId: string, walletAddress: string): void;
  simulate(input: { readonly executionId: string; readonly operationId: string; readonly sessionId: string }): Promise<{
    readonly accountVersion: number; readonly transaction: G3bUnsignedTransaction; readonly quote: G3cEvidenceAttestation | null;
    readonly simulation: G3cEvidenceAttestation; readonly fee: G3cEvidenceAttestation;
  }>;
  reconcile(input: { readonly executionId: string; readonly operationId: string; readonly reason: string }): Promise<unknown>;
  getWorkflow?(operationId: string): G3cWorkflow;
  status(executionId: string): G3cStatusResponse;
}

export function createD2G3cGateway(input: {
  readonly store: G3cExecutionStore;
  readonly provider: G3cReadOnlyBaseProvider;
}): D2G3cGateway {
  return Object.freeze({
    startSession: (session: { readonly sessionId: string; readonly walletAddress: string; readonly reason: string }) => startBaseG3cSession({
      store: input.store, provider: input.provider, sessionId: session.sessionId,
      walletAddress: session.walletAddress, allowanceToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', reason: session.reason,
    }),
    assertActiveSession: (sessionId: string, walletAddress: string) => {
      const session = input.store.getSession(sessionId);
      if (session.status !== 'ACTIVE' || session.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) throw new Error('D2_SESSION_IDENTITY_MISMATCH');
    },
    simulate: (operation: { readonly executionId: string; readonly operationId: string; readonly sessionId: string }) =>
      simulateBaseG3cOperation({ store: input.store, provider: input.provider, executionId: operation.executionId,
        operationId: operation.operationId, sessionId: operation.sessionId }),
    reconcile: (operation: { readonly executionId: string; readonly operationId: string; readonly reason: string }) => {
      const workflow = input.store.getWorkflow(operation.operationId);
      if (workflow.executionId !== operation.executionId) throw new Error('D2_RECOVERY_EXECUTION_MISMATCH');
      return reconcileBaseG3cOperation({ store: input.store, provider: input.provider,
        operationId: operation.operationId, reason: operation.reason });
    },
    getWorkflow: (operationId: string): G3cWorkflow => input.store.getWorkflow(operationId),
    status: (executionId: string): G3cStatusResponse => input.store.status(executionId),
  });
}

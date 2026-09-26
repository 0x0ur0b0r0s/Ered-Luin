export const DEFAULT_D2_RPC_MAX_REQUESTS = 896;
export const DEFAULT_D2_RPC_RECOVERY_RESERVE = 192;
export const MIN_D2_RPC_RECOVERY_RESERVE = 192;
export const D2B_DIRECT_SWAP_REQUIRED_REGULAR_REQUESTS = 128;
export const D2B_DIRECT_SWAP_REQUIRED_RECOVERY_REQUESTS = 96;
export const D2B_APPROVAL_SWAP_REQUIRED_REGULAR_REQUESTS = 320;
export const D2B_APPROVAL_SWAP_REQUIRED_RECOVERY_REQUESTS = 160;

export interface RpcRunBudgetSnapshot {
  readonly runId: string;
  readonly maxRequests: number;
  readonly recoveryReserve: number;
  readonly usedRequests: number;
  readonly regularRequests: number;
  readonly recoveryRequests: number;
  readonly remainingRequests: number;
  readonly regularRemainingRequests: number;
}
export class RpcRunBudgetError extends Error {
  constructor() { super('RPC_RUN_BUDGET_EXHAUSTED'); this.name = 'RpcRunBudgetError'; }
}
export class RpcRunBudget {
  private used = 0;
  private regularUsed = 0;
  private recoveryUsed = 0;
  constructor(readonly runId: string, readonly maxRequests: number, readonly recoveryReserve: number) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(runId) ||
        !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 10_000 ||
        !Number.isSafeInteger(recoveryReserve) || recoveryReserve < 0 || recoveryReserve >= maxRequests) {
      throw new Error('RPC_RUN_BUDGET_INVALID');
    }
  }
  consume(purpose: 'regular' | 'recovery' = 'regular'): RpcRunBudgetSnapshot {
    const regularLimit = this.maxRequests - this.recoveryReserve;
    if (this.used >= this.maxRequests || (purpose === 'regular' && this.regularUsed >= regularLimit)) throw new RpcRunBudgetError();
    this.used += 1;
    if (purpose === 'recovery') this.recoveryUsed += 1;
    else this.regularUsed += 1;
    return this.snapshot();
  }
  snapshot(): RpcRunBudgetSnapshot {
    return Object.freeze({
      runId: this.runId, maxRequests: this.maxRequests, recoveryReserve: this.recoveryReserve,
      usedRequests: this.used, regularRequests: this.regularUsed, recoveryRequests: this.recoveryUsed,
      remainingRequests: this.maxRequests - this.used,
      regularRemainingRequests: Math.max(0, this.maxRequests - this.recoveryReserve - this.regularUsed),
    });
  }
}

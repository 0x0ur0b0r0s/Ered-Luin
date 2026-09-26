import { describe, expect, it } from 'vitest';
import { RpcRunBudget, RpcRunBudgetError } from './rpc-budget.js';

describe('bounded RPC run accounting', () => {
  it('stops regular requests before consuming capacity reserved for receipt recovery', () => {
    const budget = new RpcRunBudget('run-a', 5, 2);
    budget.consume(); budget.consume(); budget.consume();
    expect(() => budget.consume()).toThrow(RpcRunBudgetError);
    expect(budget.snapshot()).toMatchObject({ usedRequests: 3, regularRemainingRequests: 0, recoveryRequests: 0 });
    budget.consume('recovery'); budget.consume('recovery');
    expect(() => budget.consume('recovery')).toThrow(RpcRunBudgetError);
    expect(budget.snapshot()).toMatchObject({ usedRequests: 5, recoveryRequests: 2, remainingRequests: 0 });
  });
  it('rejects invalid limits and never resets within a run', () => {
    expect(() => new RpcRunBudget('run-a', 5, 5)).toThrow('RPC_RUN_BUDGET_INVALID');
    const budget = new RpcRunBudget('run-b', 2, 0);
    budget.consume(); budget.consume();
    expect(() => budget.consume()).toThrow(RpcRunBudgetError);
    expect(budget.snapshot().usedRequests).toBe(2);
  });
});

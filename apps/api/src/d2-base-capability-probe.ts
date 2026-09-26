import { randomUUID } from 'node:crypto';
import { BASE_TOKENS, BASE_UNISWAP_V3 } from './base-allowlist.js';
import { RpcRunBudget } from './rpc-budget.js';

export const D2E_BASE_PROBE_REQUEST_CEILING = 20;

export interface D2BaseCapabilityPlanItem {
  readonly method: string;
  readonly capability: 'chain_identity' | 'head_finality' | 'contract_identity' | 'account_reads' | 'quote_and_fees' | 'transaction_lookup';
  readonly params: readonly unknown[];
}

export const D2E_BASE_CAPABILITY_METHOD_PLAN: readonly D2BaseCapabilityPlanItem[] = Object.freeze([
  { method: 'eth_chainId', capability: 'chain_identity', params: [] },
  { method: 'eth_blockNumber', capability: 'head_finality', params: [] },
  { method: 'eth_getBlockByNumber', capability: 'head_finality', params: ['safe', false] },
  { method: 'eth_getBlockByNumber', capability: 'head_finality', params: ['finalized', false] },
  { method: 'eth_getCode', capability: 'contract_identity', params: [BASE_UNISWAP_V3.factory, 'latest'] },
  { method: 'eth_getCode', capability: 'contract_identity', params: [BASE_UNISWAP_V3.router, 'latest'] },
  { method: 'eth_getCode', capability: 'contract_identity', params: [BASE_UNISWAP_V3.pool, 'latest'] },
  { method: 'eth_call', capability: 'contract_identity', params: [{ to: BASE_UNISWAP_V3.factory, data: '0x1698ee82' }, 'latest'] },
  { method: 'eth_getBalance', capability: 'account_reads', params: ['0x1111111111111111111111111111111111111111', 'latest'] },
  { method: 'eth_getTransactionCount', capability: 'account_reads', params: ['0x1111111111111111111111111111111111111111', 'pending'] },
  { method: 'eth_call', capability: 'account_reads', params: [{ to: BASE_TOKENS.USDC, data: '0x70a082310000000000000000000000001111111111111111111111111111111111111111' }, 'latest'] },
  { method: 'eth_call', capability: 'account_reads', params: [{ to: BASE_TOKENS.WETH, data: '0x70a082310000000000000000000000001111111111111111111111111111111111111111' }, 'latest'] },
  { method: 'eth_call', capability: 'account_reads', params: [{ to: BASE_TOKENS.USDC, data: '0xdd62ed3e0000000000000000000000001111111111111111111111111111111111111111000000000000000000000000' + BASE_UNISWAP_V3.router.slice(2) }, 'latest'] },
  { method: 'eth_feeHistory', capability: 'quote_and_fees', params: ['0x1', 'latest', [50]] },
  { method: 'eth_maxPriorityFeePerGas', capability: 'quote_and_fees', params: [] },
  { method: 'eth_gasPrice', capability: 'quote_and_fees', params: [] },
  { method: 'eth_estimateGas', capability: 'quote_and_fees', params: [{ from: '0x1111111111111111111111111111111111111111', to: BASE_UNISWAP_V3.router, value: '0x0', data: '0x' }] },
  { method: 'eth_getTransactionByHash', capability: 'transaction_lookup', params: ['0x' + '11'.repeat(32)] },
  { method: 'eth_getRawTransactionByHash', capability: 'transaction_lookup', params: ['0x' + '11'.repeat(32)] },
  { method: 'eth_getTransactionReceipt', capability: 'transaction_lookup', params: ['0x' + '11'.repeat(32)] },
]);

export interface D2BaseCapabilityProbeResult {
  readonly mode: 'DRY_RUN_MOCKED_TRANSPORT';
  readonly requestCount: number;
  readonly requestCeiling: number;
  readonly remainingRequests: number;
  readonly supported: number;
  readonly unsupported: number;
  readonly failed: number;
  readonly results: readonly { readonly method: string; readonly capability: D2BaseCapabilityPlanItem['capability']; readonly status: 'SUPPORTED' | 'UNSUPPORTED' | 'FAILED' | 'NOT_RUN' }[];
}
export interface D2BaseCapabilityProbeOptions {
  readonly transport: (method: string, params: readonly unknown[]) => Promise<unknown>;
  readonly maxRequests?: number;
  readonly runId?: string;
}

function rpcResponseStatus(value: unknown): 'SUPPORTED' | 'UNSUPPORTED' | 'FAILED' {
  if (typeof value !== 'object' || value === null) return 'FAILED';
  if ('error' in value) {
    const error = value.error;
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number' ? error.code : null;
    return code === -32601 ? 'UNSUPPORTED' : 'FAILED';
  }
  return 'result' in value ? 'SUPPORTED' : 'FAILED';
}

export async function runD2eBaseCapabilityProbe(input: D2BaseCapabilityProbeOptions): Promise<D2BaseCapabilityProbeResult> {
  const ceiling = input.maxRequests ?? D2E_BASE_PROBE_REQUEST_CEILING;
  if (typeof input.transport !== 'function' || !Number.isSafeInteger(ceiling) || ceiling < 1 ||
      ceiling > D2E_BASE_PROBE_REQUEST_CEILING) throw new Error('D2_BASE_PROBE_CONFIGURATION_INVALID');
  const budget = new RpcRunBudget(input.runId ?? randomUUID(), ceiling, 0);
  const results: D2BaseCapabilityProbeResult['results'][number][] = [];
  for (const item of D2E_BASE_CAPABILITY_METHOD_PLAN) {
    try { budget.consume('regular'); }
    catch { results.push({ method: item.method, capability: item.capability, status: 'NOT_RUN' }); continue; }
    try {
      const response = await input.transport(item.method, item.params);
      results.push({ method: item.method, capability: item.capability, status: rpcResponseStatus(response) });
    } catch (error) {
      const status = rpcResponseStatus(error);
      results.push({ method: item.method, capability: item.capability, status });
    }
  }
  const snapshot = budget.snapshot();
  return Object.freeze({
    mode: 'DRY_RUN_MOCKED_TRANSPORT', requestCount: snapshot.usedRequests, requestCeiling: ceiling,
    remainingRequests: snapshot.remainingRequests,
    supported: results.filter((item) => item.status === 'SUPPORTED').length,
    unsupported: results.filter((item) => item.status === 'UNSUPPORTED').length,
    failed: results.filter((item) => item.status === 'FAILED').length,
    results: Object.freeze(results),
  });
}

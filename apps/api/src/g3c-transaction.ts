import { encodeFunctionData, getAddress, type Hex } from 'viem';
import type { ExecutionLifecycleRecord, G3bUnsignedTransaction, G3cEvidenceAttestation } from '@ered-luin/contracts';
import { g3bUnsignedTransactionSchema } from '@ered-luin/contracts';
import { BASE_TOKENS, BASE_UNISWAP_V3 } from './base-allowlist.js';
import { ERC20_APPROVAL_ABI, UNISWAP_V3_ROUTER_ABI } from './g3b-transaction.js';

export function buildG3cUnsignedTransaction(input: {
  readonly parent: ExecutionLifecycleRecord; readonly kind: 'APPROVAL' | 'SWAP'; readonly accountSnapshot: G3cEvidenceAttestation;
  readonly quote?: G3cEvidenceAttestation | null; readonly gasLimit: bigint;
}): G3bUnsignedTransaction {
  const account = input.accountSnapshot.payload;
  if (account.kind !== 'ACCOUNT_SNAPSHOT' || account.walletAddress.toLowerCase() !== input.parent.walletAddress.toLowerCase() ||
      account.chainId !== 8453 || input.gasLimit <= 0n) throw new Error('G3C_TRANSACTION_INPUT_INVALID');
  const tokenIn = input.parent.intent.sellAsset === 'USDC' ? BASE_TOKENS.USDC : BASE_TOKENS.WETH;
  let to: string; let data: Hex;
  if (input.kind === 'APPROVAL') {
    if (input.quote || account.allowanceToken.toLowerCase() !== tokenIn.toLowerCase() ||
        BigInt(account.allowanceAtomic) >= BigInt(input.parent.transaction.amountIn)) throw new Error('G3C_APPROVAL_NOT_REQUIRED');
    to = tokenIn;
    data = encodeFunctionData({ abi: ERC20_APPROVAL_ABI, functionName: 'approve', args: [BASE_UNISWAP_V3.router, BigInt(input.parent.transaction.amountIn)] });
  } else {
    const quote = input.quote?.payload;
    if (!quote || quote.kind !== 'QUOTE' || quote.executionId !== input.parent.executionId || account.allowanceToken.toLowerCase() !== tokenIn.toLowerCase() ||
        BigInt(account.allowanceAtomic) < BigInt(input.parent.transaction.amountIn)) throw new Error('G3C_SWAP_QUOTE_OR_ALLOWANCE_INVALID');
    const tokenOut = input.parent.intent.buyAsset === 'USDC' ? BASE_TOKENS.USDC : BASE_TOKENS.WETH;
    if (quote.tokenIn.toLowerCase() !== tokenIn.toLowerCase() || quote.tokenOut.toLowerCase() !== tokenOut.toLowerCase() ||
        quote.amountIn !== input.parent.transaction.amountIn || quote.blockNumber !== account.blockNumber || quote.blockHash.toLowerCase() !== account.blockHash.toLowerCase()) {
      throw new Error('G3C_SWAP_QUOTE_MISMATCH');
    }
    const inner = encodeFunctionData({ abi: UNISWAP_V3_ROUTER_ABI, functionName: 'exactInputSingle', args: [{
      tokenIn, tokenOut, fee: 500, recipient: getAddress(input.parent.walletAddress), amountIn: BigInt(input.parent.transaction.amountIn),
      amountOutMinimum: BigInt(quote.minimumAmountOut), sqrtPriceLimitX96: 0n,
    }] });
    const deadline = BigInt(Math.floor(Date.parse(input.parent.intent.expiresAt) / 1000));
    data = encodeFunctionData({ abi: UNISWAP_V3_ROUTER_ABI, functionName: 'multicall', args: [deadline, [inner]] });
    to = BASE_UNISWAP_V3.router;
  }
  return g3bUnsignedTransactionSchema.parse({ version: 1, type: 'EIP1559', chainId: 8453, from: input.parent.walletAddress, to,
    nonce: account.pendingNonce, gasLimit: input.gasLimit.toString(), maxFeePerGasWei: input.parent.transaction.maxFeePerGasWei,
    maxPriorityFeePerGasWei: input.parent.transaction.maxPriorityFeePerGasWei, valueWei: input.parent.transaction.valueNativeWei,
    data, accessList: [] });
}

import { describe, expect, it } from 'vitest';
import type { createPublicClient, Hex } from 'viem';
import { createSyntheticG3cEvidenceAuthority } from './g3c-evidence.js';
import { createBaseReadOnlyProvider } from './g3c-base-provider.js';
import { BASE_TOKENS, BASE_UNISWAP_V3 } from './base-allowlist.js';

const FIXED_NOW = Date.parse('2026-09-23T12:00:00.000Z');
const wallet = '0x1111111111111111111111111111111111111111';

type MockOptions = {
  readonly latestAgeSeconds?: number;
  readonly safeAgeSeconds?: number;
  readonly finalizedAgeSeconds?: number;
  readonly safeLagBlocks?: bigint;
  readonly finalizedLagBlocks?: bigint;
  readonly reorgSafeHead?: boolean;
  readonly reorgLatestHead?: boolean;
  readonly delayOnBalanceMs?: number;
  readonly changingRead?: 'balance' | 'allowance' | 'nonce';
};
function hashFor(number: bigint): Hex {
  return ('0x' + number.toString(16).padStart(64, '0')) as Hex;
}
function makeProvider(options: MockOptions = {}) {
  let nowMs = FIXED_NOW;
  const latestNumber = 1000n;
  const safeNumber = latestNumber - (options.safeLagBlocks ?? 3n);
  const finalizedNumber = latestNumber - (options.finalizedLagBlocks ?? 20n);
  const balance = 10_000_000n;
  let delayed = false;
  let safeExactReads = 0;
  let latestExactReads = 0;
  let balances = 0;
  let allowances = 0;
  let nonces = 0;
  const blockTimestamp = (number: bigint): bigint => {
    const baseline = BigInt(Math.floor(FIXED_NOW / 1000));
    if (number === latestNumber && options.latestAgeSeconds !== undefined) return baseline - BigInt(options.latestAgeSeconds);
    if (number === safeNumber && options.safeAgeSeconds !== undefined) return baseline - BigInt(options.safeAgeSeconds);
    if (number === finalizedNumber && options.finalizedAgeSeconds !== undefined) return baseline - BigInt(options.finalizedAgeSeconds);
    return baseline - (latestNumber - number) * 2n;
  };
  const rpc = {
    async getBlock(input: { blockTag?: string; blockNumber?: bigint }) {
      const tagNumber = input.blockTag === 'latest' ? latestNumber :
        input.blockTag === 'safe' ? safeNumber : input.blockTag === 'finalized' ? finalizedNumber : input.blockNumber!;
      const isExactSafe = input.blockTag === undefined && tagNumber === safeNumber;
      const isExactLatest = input.blockTag === undefined && tagNumber === latestNumber;
      if (isExactSafe) safeExactReads += 1;
      if (isExactLatest) latestExactReads += 1;
      const changed = options.reorgSafeHead && isExactSafe && safeExactReads === 1 ||
        options.reorgLatestHead && isExactLatest && latestExactReads === 1;
      return { number: tagNumber, hash: changed ? hashFor(tagNumber + 100_000n) : hashFor(tagNumber),
        timestamp: blockTimestamp(tagNumber) };
    },
    async getChainId() { return 8453; },
    async getBytecode() { return '0x6000'; },
    async getBalance() { return 0n; },
    async getTransactionCount() {
      nonces += 1;
      return options.changingRead === 'nonce' && nonces > 1 ? 1n : 0n;
    },
    async readContract(input: { functionName: string; address?: string }) {
      if (input.functionName === 'getPool') return BASE_UNISWAP_V3.pool;
      if (input.functionName === 'token0') return BASE_TOKENS.WETH;
      if (input.functionName === 'token1') return BASE_TOKENS.USDC;
      if (input.functionName === 'fee') return 500;
      if (input.functionName === 'tickSpacing') return 10;
      if (input.functionName === 'factory') return BASE_UNISWAP_V3.factory;
      if (input.functionName === 'balanceOf') {
        balances += 1;
        if (!delayed && options.delayOnBalanceMs) { delayed = true; nowMs += options.delayOnBalanceMs; }
        if (input.address?.toLowerCase() === BASE_TOKENS.USDC.toLowerCase()) {
          return options.changingRead === 'balance' && balances > 1 ? balance + 1n : balance;
        }
        return 0n;
      }
      if (input.functionName === 'allowance') {
        allowances += 1;
        return options.changingRead === 'allowance' && allowances > 1 ? 1n : 0n;
      }
      throw new Error('Unexpected mocked Base read: ' + input.functionName);
    },
  };
  const clock = () => new Date(nowMs);
  const authority = createSyntheticG3cEvidenceAuthority(clock);
  const provider = createBaseReadOnlyProvider({ rpcUrl: 'https://unused.invalid', authority, clock,
    client: rpc as never as ReturnType<typeof createPublicClient> });
  return { provider, rpc, clock };
}

describe('G3c production Base adapter source freshness', () => {
  it('review reproduction: rejects a canonical safe block that is one hour old', async () => {
    const { provider } = makeProvider({ safeAgeSeconds: 3600 });
    await expect(provider.account(wallet, BASE_TOKENS.USDC, 1, 'safe')).rejects.toThrow();
  });

  it('binds account state to a fresh canonical safe source block and current heads', async () => {
    const { provider } = makeProvider();
    const attestation = await provider.account(wallet, BASE_TOKENS.USDC, 1, 'safe');
    expect(attestation.payload).toMatchObject({
      kind: 'ACCOUNT_SNAPSHOT', sourceBlockNumber: '997', sourceBlockHash: hashFor(997n),
      safeHeadNumber: '997', latestHeadNumber: '1000', finalizedHeadNumber: '980',
    });
  });

  it('prepares fresh unsafe execution state while safe and finalized heads lag', async () => {
    const { provider } = makeProvider({ safeLagBlocks: 60n, finalizedLagBlocks: 450n,
      safeAgeSeconds: 120, finalizedAgeSeconds: 900 });
    const evidence = await provider.account(wallet, BASE_TOKENS.USDC, 1);
    expect(evidence.payload).toMatchObject({ kind: 'ACCOUNT_SNAPSHOT', blockNumber: '1000', blockFinality: 'unsafe',
      sourceFinality: 'unsafe', latestHeadNumber: '1000', safeHeadNumber: '940', finalizedHeadNumber: '550' });
  });

  it('rejects latest execution state older than the six-second policy', async () => {
    const { provider } = makeProvider({ latestAgeSeconds: 8 });
    await expect(provider.account(wallet, BASE_TOKENS.USDC, 1)).rejects.toThrow();
  });

  it('accepts finalized account state when the safe head is minutes behind', async () => {
    const { provider } = makeProvider({ safeLagBlocks: 60n, finalizedLagBlocks: 450n,
      safeAgeSeconds: 120, finalizedAgeSeconds: 900 });
    const evidence = await provider.account(wallet, BASE_TOKENS.USDC, 2, 'finalized');
    expect(evidence.payload).toMatchObject({ kind: 'ACCOUNT_SNAPSHOT', blockNumber: '550', blockFinality: 'finalized',
      sourceFinality: 'finalized', latestHeadNumber: '1000', safeHeadNumber: '940', finalizedHeadNumber: '550' });
  });

  it('rejects a finalized account snapshot beyond its settlement freshness bound', async () => {
    const { provider } = makeProvider({ safeLagBlocks: 60n, finalizedLagBlocks: 450n, finalizedAgeSeconds: 1800 });
    await expect(provider.account(wallet, BASE_TOKENS.USDC, 3, 'finalized'))
      .rejects.toThrow('G3C_SETTLEMENT_HEAD_STALE_OR_INCONSISTENT');
  });
  it('rejects a safe head that lags latest by more than the six-block policy', async () => {
    const { provider } = makeProvider({ safeLagBlocks: 7n });
    await expect(provider.account(wallet, BASE_TOKENS.USDC, 1, 'safe')).rejects.toThrow();
  });

  it('rejects a latest head hash that changes during the read', async () => {
    const { provider } = makeProvider({ reorgLatestHead: true });
    await expect(provider.account(wallet, BASE_TOKENS.USDC, 1)).rejects.toThrow('G3C_BASE_HEAD_CHANGED_DURING_READ');
  });

  it('rejects a safe head hash that changes during the read', async () => {
    const { provider } = makeProvider({ reorgSafeHead: true });
    await expect(provider.account(wallet, BASE_TOKENS.USDC, 1, 'safe')).rejects.toThrow('G3C_BASE_HEAD_CHANGED_DURING_READ');
  });

  it('rejects delayed reads after the source head ages out', async () => {
    const { provider } = makeProvider({ delayOnBalanceMs: 8_000 });
    await expect(provider.account(wallet, BASE_TOKENS.USDC, 1, 'safe')).rejects.toThrow();
  });

  it.each(['balance', 'allowance', 'nonce'] as const)('rejects a changed %s observed during an account read', async (changingRead) => {
    const { provider } = makeProvider({ changingRead });
    await expect(provider.account(wallet, BASE_TOKENS.USDC, 1, 'safe')).rejects.toThrow('G3C_ACCOUNT_CHANGED_DURING_READ');
  });
});

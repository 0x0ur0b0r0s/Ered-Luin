import type { NormalizedSignal, TradeIntent } from './schemas.js';
/** Synthetic only; these are not market observations or trading recommendations. */
export const syntheticUsdcToWethIntent: TradeIntent = {
  intentId: '00000000-0000-4000-8000-000000000001', chainId: 8453,
  walletAddress: '0x0000000000000000000000000000000000000001',
  sellAsset: 'USDC', buyAsset: 'WETH', amountIn: '5000000',
  issuedAt: '2026-01-01T12:00:00.000Z', expiresAt: '2026-01-01T12:01:00.000Z',
};
export const syntheticPositiveNetflow: NormalizedSignal = {
  signalId: '00000000-0000-4000-8000-000000000002', provider: 'synthetic',
  endpoint: 'SMART_MONEY_NETFLOW', chainId: 8453, asset: 'WETH',
  metric: 'netflow_1h_usd_micros', observedAt: '2026-01-01T12:00:00.000Z',
  fetchedAt: '2026-01-01T12:00:01.000Z', quality: 'COMPLETE',
  value: '1250000', unit: 'usd_micros', provenanceId: 'fixture:synthetic-positive-netflow-v1',
};
export const syntheticZeroNetflow: NormalizedSignal = {
  ...syntheticPositiveNetflow, signalId: '00000000-0000-4000-8000-000000000003',
  value: '0', provenanceId: 'fixture:synthetic-zero-netflow-v1',
};
export const syntheticMissingNetflow: NormalizedSignal = {
  ...syntheticPositiveNetflow, signalId: '00000000-0000-4000-8000-000000000004',
  quality: 'MISSING', value: null, provenanceId: 'fixture:synthetic-missing-netflow-v1',
};

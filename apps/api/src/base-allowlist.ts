import { getAddress, type Address } from 'viem';
import { SUPPORTED_CHAIN_ID } from '@ered-luin/contracts';

export const BASE_ALLOWLIST_VERSION = 1 as const;
export const BASE_V3_FEE = 500 as const;
export const BASE_TOKENS = Object.freeze({
  USDC: getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
  WETH: getAddress('0x4200000000000000000000000000000000000006'),
});
export const BASE_UNISWAP_V3 = Object.freeze({
  chainId: SUPPORTED_CHAIN_ID,
  factory: getAddress('0x33128a8fC17869897dcE68Ed026d694621f6FDfD'),
  router: getAddress('0x2626664c2603336E57B271c5C0b26F421741e481'),
  pool: getAddress('0xd0b53d9277642d899df5c87a3966a349a798f224'),
  fee: BASE_V3_FEE,
  tickSpacing: 10,
});
export type BaseDeploymentEvidence = Readonly<{
  chainId: number;
  factory: Address;
  router: Address;
  pool: Address;
  token0: Address;
  token1: Address;
  fee: number;
  tickSpacing: number;
  factoryHasCode: boolean;
  routerHasCode: boolean;
  poolHasCode: boolean;
  usdcHasCode: boolean;
  wethHasCode: boolean;
}>;
export interface BaseDeploymentReader { readDeployment(): Promise<BaseDeploymentEvidence>; }

export async function verifyBaseAllowlist(reader: BaseDeploymentReader): Promise<BaseDeploymentEvidence> {
  const evidence = await reader.readDeployment();
  const expected0 = BASE_TOKENS.WETH.toLowerCase();
  const expected1 = BASE_TOKENS.USDC.toLowerCase();
  if (evidence.chainId !== BASE_UNISWAP_V3.chainId ||
      evidence.factory.toLowerCase() !== BASE_UNISWAP_V3.factory.toLowerCase() ||
      evidence.router.toLowerCase() !== BASE_UNISWAP_V3.router.toLowerCase() ||
      evidence.pool.toLowerCase() !== BASE_UNISWAP_V3.pool.toLowerCase() ||
      evidence.token0.toLowerCase() !== expected0 || evidence.token1.toLowerCase() !== expected1 ||
      evidence.fee !== BASE_UNISWAP_V3.fee || evidence.tickSpacing !== BASE_UNISWAP_V3.tickSpacing ||
      !evidence.factoryHasCode || !evidence.routerHasCode || !evidence.poolHasCode || !evidence.usdcHasCode || !evidence.wethHasCode) {
    throw new Error('BASE_DEPLOYMENT_IDENTITY_MISMATCH');
  }
  return evidence;
}
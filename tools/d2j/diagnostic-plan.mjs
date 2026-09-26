import { pathToFileURL } from 'node:url';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH = '0x4200000000000000000000000000000000000006';

export function buildD2jDiagnosticPlan() {
  return Object.freeze({
    mode: 'DRY_RUN_ONLY',
    providerCalls: 0,
    activeBudgetCredits: 0,
    dispatchAuthorized: false,
    requiresSeparateAuthorization: true,
    question: 'Does a fresh Base Token Screener response now contain the explicitly requested USDC row and a numeric USDC price_usd, alongside the paired WETH row?',
    purpose: 'Refresh the smallest supported Token Screener request for the paired Base USDC/WETH rows, then check whether USDC price_usd is numeric. Market-cap fields remain contextual and are not a G2 trade prerequisite. This cannot establish why the earlier retained response lacked USDC because its raw row keys were not saved.',
    request: Object.freeze({
      method: 'POST',
      endpoint: '/api/v1/token-screener',
      body: Object.freeze({
        chains: Object.freeze(['base']),
        timeframe: '1h',
        pagination: Object.freeze({ page: 1, per_page: 100 }),
        filters: Object.freeze({
          token_address: Object.freeze([USDC, WETH]),
          include_stablecoins: true,
          include_native_tokens: true,
        }),
      }),
      maxPages: 1,
      maxRetries: 0,
      worstCaseCredits: Object.freeze({ pro: 1, free: 1 }),
      totalWorstCaseCredits: Object.freeze({ pro: 1, free: 1 }),
    }),
    executionPathAfterSeparateApproval: 'Run one TOKEN_SCREENER query through the existing Nansen client, managed-query manager, ledger, observation store and shared D2c/D2h collector lock. Emit only the manager opt-in shape diagnostics plus standard attempt/charge metadata; do not write diagnostic fields into policy observations.',
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error('USAGE');
  process.stdout.write(JSON.stringify(buildD2jDiagnosticPlan(), null, 2) + '\n');
}

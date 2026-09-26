import { initializePaperStore, openPaperStore } from './paper-store.js';

function usage(): never {
  throw new Error('Usage: paper-store-cli.js init <absolute-path> | seed-account <absolute-path> <wallet> <usdc-atomic> <weth-atomic> <gas-native-wei> <daily-start-usdc-micros> [utc-day]');
}
const [command, databasePath, ...values] = process.argv.slice(2);
if (!command || !databasePath) usage();
if (command === 'init') {
  if (values.length !== 0) usage();
  const store = initializePaperStore({ databasePath });
  store.close();
} else if (command === 'seed-account') {
  if (values.length < 5 || values.length > 6) usage();
  const [walletAddress, usdcBalanceAtomic, wethBalanceAtomic, gasBalanceNativeWei, dailyStartEquityUsdcMicros, providedDay] = values;
  const store = openPaperStore({ databasePath });
  try {
    store.createAccount({ walletAddress: walletAddress!, usdcBalanceAtomic: usdcBalanceAtomic!, wethBalanceAtomic: wethBalanceAtomic!,
      gasBalanceNativeWei: gasBalanceNativeWei!, dailyStartEquityUsdcMicros: dailyStartEquityUsdcMicros!,
      utcDay: providedDay ?? new Date().toISOString().slice(0, 10) });
  } finally { store.close(); }
} else usage();

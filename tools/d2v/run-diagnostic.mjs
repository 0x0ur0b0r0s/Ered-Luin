import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildD2vDryRunPlan, dispatchD2vOhlcv, safeD2vFailure } from './diagnostic.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === '--dry-run')) {
    process.stdout.write(JSON.stringify(buildD2vDryRunPlan(), null, 2) + '\n');
    return;
  }
  if (args.length !== 1 || args[0] !== '--dispatch') throw new Error('D2V_USAGE');
  if (!process.env.LOCALAPPDATA) throw new Error('D2V_CONFIGURATION_INVALID');
  try {
    const report = await dispatchD2vOhlcv({ privateRoot: resolve(process.env.LOCALAPPDATA, 'Ered-Luin'), apiKey: process.env.NANSEN_API_KEY });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally { delete process.env.NANSEN_API_KEY; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write('D2v stopped safely: ' + safeD2vFailure(error) + '. No credentials, raw body, private path, or arbitrary error text is printed.\n');
    process.exitCode = 1;
  });
}
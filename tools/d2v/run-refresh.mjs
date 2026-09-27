import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildD2vRefreshDryRun, runD2vRefresh, safeD2vRefreshFailure } from './refresh.mjs';

function parse(argv) {
  let configPath = null, invocationId = null, dispatch = false, hash = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config' && argv[i + 1] && configPath === null) configPath = resolve(argv[++i]);
    else if (argv[i] === '--invocation-id' && argv[i + 1] && invocationId === null) invocationId = argv[++i];
    else if (argv[i] === '--dispatch' && !dispatch) dispatch = true;
    else if (argv[i] === '--preflight-sha256' && argv[i + 1] && hash === null) hash = argv[++i];
    else if (argv[i] === '--dry-run') { if (dispatch) throw new Error('D2V_REFRESH_USAGE'); }
    else throw new Error('D2V_REFRESH_USAGE');
  }
  if (!configPath || !invocationId || (hash !== null && !/^[0-9a-f]{64}$/u.test(hash))) throw new Error('D2V_REFRESH_USAGE');
  return { configPath, invocationId, dispatch, expectedConfigSha256: hash };
}
async function main() {
  const args = parse(process.argv.slice(2));
  const report = args.dispatch ? await runD2vRefresh(args) : buildD2vRefreshDryRun(args);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write('D2v refresh stopped safely: ' + safeD2vRefreshFailure(error) + '. No credentials, private paths, raw response or arbitrary error text are printed.\n');
    delete process.env.NANSEN_API_KEY;
    process.exitCode = 1;
  }).finally(() => { delete process.env.NANSEN_API_KEY; });
}

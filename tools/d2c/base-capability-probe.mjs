import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const moduleUrl = pathToFileURL(resolve('apps/api/dist/d2-base-capability-probe.js'));
const { runD2eBaseCapabilityProbe } = await import(moduleUrl.href);
const probe = await runD2eBaseCapabilityProbe({
  transport: async () => ({ result: '0x1' }),
});
process.stdout.write(JSON.stringify(probe, null, 2) + '\n');

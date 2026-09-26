import { existsSync, writeFileSync } from 'node:fs';
import { openCreditLedger } from '../dist/index.js';

const [databasePath, readyPath, gatePath, serializedOptions, serializedInput] = process.argv.slice(2);
const options = JSON.parse(serializedOptions);
const input = JSON.parse(serializedInput);
const ledger = openCreditLedger({ ...options, databasePath });
writeFileSync(readyPath, String(process.pid));
process.stdout.write(JSON.stringify({ kind: 'ready', pid: process.pid }) + '\n');
const waitCell = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 12_000;
while (!existsSync(gatePath) && Date.now() < deadline) Atomics.wait(waitCell, 0, 0, 10);
if (!existsSync(gatePath)) {
  ledger.close();
  process.stderr.write('Gate timed out');
  process.exit(2);
}
try {
  const result = ledger.reserveAttempt(input);
  process.stdout.write(JSON.stringify({ kind: 'result', ok: true, dispatchGranted: result.dispatchGranted }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ kind: 'result', ok: false, code: error.code ?? 'UNKNOWN' }) + '\n');
} finally {
  ledger.close();
}

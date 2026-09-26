import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const [ledgerPath, observationStorePath, runId, role, eventDirectory, controlDirectory, pauseRename] = process.argv.slice(2);
function event(name, extra = {}) {
  fs.writeFileSync(join(eventDirectory, role + '-' + name + '.json'), JSON.stringify({ name, runId, ...extra }), { flag: 'wx' });
}
function waitForControl(name) {
  const target = join(controlDirectory, role + '-' + name);
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(target)) Atomics.wait(signal, 0, 0, 10);
}

if (pauseRename === 'true') {
  const rename = fs.renameSync.bind(fs);
  fs.renameSync = (...args) => {
    event('rename-paused');
    waitForControl('continue-rename');
    return rename(...args);
  };
  syncBuiltinESMExports();
}

const { acquireCollectionLock } = await import('./collector-lock.mjs');
event('ready', { sameLedgerAndStore: ledgerPath === observationStorePath });
waitForControl('acquire');
try {
  const lock = acquireCollectionLock(observationStorePath, { runId, recoverStale: true });
  event('acquired');
  event('dispatch-ready');
  waitForControl('release');
  lock.release();
  event('released');
} catch (error) {
  event('failed', { code: error instanceof Error ? error.message : 'UNKNOWN' });
}

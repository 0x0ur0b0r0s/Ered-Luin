import { isAbsolute } from 'node:path';
import { initializeExecutionStore, openExecutionStore } from './execution-store.js';

function usage(): never {
  throw new Error('Usage: execution-store.js init <absolute-state-path> | status <absolute-state-path> | kill-switch <absolute-state-path> stop|arm <reason>');
}
const [command, databasePath, action, ...reasonParts] = process.argv.slice(2);
if (!command || !databasePath || !isAbsolute(databasePath)) usage();
if (command === 'init') {
  if (action !== undefined || reasonParts.length !== 0) usage();
  const store = initializeExecutionStore({ databasePath });
  try { process.stdout.write(JSON.stringify({ initialized: true, killSwitch: store.getKillSwitch() }) + '\n'); }
  finally { store.close(); }
} else if (command === 'status') {
  if (action !== undefined || reasonParts.length !== 0) usage();
  const store = openExecutionStore({ databasePath });
  try {
    process.stdout.write(JSON.stringify({
      killSwitch: store.getKillSwitch(),
      reconciliationQueue: store.listReconciliationQueue().map((record) => ({
        executionId: record.executionId, status: record.status, transactionHash: record.signedOutbox?.transactionHash ?? null,
        reservationId: record.reservationId,
      })),
      liveExecutionEnabled: false,
    }) + '\n');
  } finally { store.close(); }
} else if (command === 'kill-switch') {
  if ((action !== 'stop' && action !== 'arm') || reasonParts.length === 0) usage();
  const store = openExecutionStore({ databasePath });
  try {
    const state = store.setKillSwitch(action === 'stop', reasonParts.join(' '));
    process.stdout.write(JSON.stringify({ killSwitch: state, liveExecutionEnabled: false }) + '\n');
  } finally { store.close(); }
} else usage();

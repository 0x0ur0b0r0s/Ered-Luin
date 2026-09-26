import { openExecutionStore } from '../dist/execution-store.js';

const [mode, databasePath, payloadText, barrierId] = process.argv.slice(2);
const payload = payloadText ? JSON.parse(payloadText) : {};
const clockAt = payload.clockAt;
const actionPayload = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'clockAt' && key !== 'action'));
let store;

function invoke(action, value) {
  if (action === 'reserve') return store.reserve(value);
  if (action === 'simulation') return store.recordSimulation(value.executionId, value.accountVersion, value.evidence, value.reason);
  if (action === 'authorization') return store.issueAuthorization(value.executionId, value.accountVersion, value.reason);
  if (action === 'claim') return store.claimSigning(value.executionId, value.authorizationNonce, value.accountVersion, value.reason);
  if (action === 'outbox') return store.persistSignedOutbox(value.executionId, value.accountVersion, value.signedBytesHex, value.transactionHash, value.reason);
  if (action === 'broadcast') return store.prepareBroadcast(value.executionId, value.reason);
  throw new Error('Unknown worker action.');
}
function send(message, exitAfterSend = false) {
  if (typeof process.send !== 'function') process.exit(2);
  process.send(message, () => { if (exitAfterSend) process.exit(0); });
}
function errorValue(error) { return { code: error && typeof error.code === 'string' ? error.code : 'UNEXPECTED_ERROR' }; }

try {
  store = openExecutionStore({ databasePath, ...(typeof clockAt === 'string' ? { clock: () => new Date(clockAt) } : {}) });
  if (mode === 'status') {
    send({ type: 'result', value: store.getKillSwitch() });
    store.close();
  } else if (mode === 'exit-after-action') {
    try {
      const result = invoke(payload.action, actionPayload);
      send({ type: 'result', value: result.record ?? result }, true);
    } catch (error) { send({ type: 'error', value: errorValue(error) }, true); }
  } else if (mode === 'race-reserve' || mode === 'race-claim') {
    send({ type: 'ready', barrierId, pid: process.pid });
    process.on('message', (message) => {
      if (!message || message.type !== 'release' || message.barrierId !== barrierId) return;
      try {
        const action = mode === 'race-reserve' ? 'reserve' : 'claim';
        const result = invoke(action, actionPayload);
        store.close();
        send({ type: 'result', value: { success: true, record: result.record } }, true);
      } catch (error) {
        try { store.close(); } catch { /* Preserve race result. */ }
        send({ type: 'result', value: { success: false, error: errorValue(error) } }, true);
      }
    });
  } else process.exit(3);
} catch (error) {
  send({ type: 'error', value: errorValue(error) }, true);
  try { store?.close(); } catch { /* Preserve worker failure. */ }
}

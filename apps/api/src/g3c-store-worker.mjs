import { openExecutionStore } from '../dist/execution-store.js';
import { G3cExecutionStore } from '../dist/g3c-execution-store.js';

process.once('message', (task) => {
  try {
    if (!task || typeof task !== 'object') throw new Error('invalid task');
    const execution = openExecutionStore({ databasePath: task.databasePath });
    const g3c = new G3cExecutionStore(execution, task.trust, { allowTestSigning: true });
    process.send?.({ type: 'READY' });
    process.once('message', (command) => {
      try {
        if (!command || command.type !== 'GO') throw new Error('invalid command');
        if (task.action === 'prepare') {
          const result = g3c.prepareOperation(task.input);
          process.send?.({ type: 'RESULT', ok: true, status: result.workflow.status, operationId: result.workflow.operationId });
        } else if (task.action === 'claim') {
          const request = g3c.claimForSigning(task.operationId, task.snapshot, 'two-process signer-claim race');
          process.send?.({ type: 'RESULT', ok: true, claimId: request.signingClaimId });
        } else if (task.action === 'legacy-release') {
          execution.releaseBeforeSigning(task.executionId, task.accountVersion, 'child-process legacy release');
          process.send?.({ type: 'RESULT', ok: true });
        } else {
          throw new Error('unknown action');
        }
      } catch {
        process.send?.({ type: 'RESULT', ok: false });
      } finally {
        execution.close();
        process.disconnect?.();
      }
    });
  } catch {
    process.send?.({ type: 'READY', failed: true });
    process.disconnect?.();
  }
});

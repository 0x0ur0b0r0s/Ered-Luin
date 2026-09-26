import { describe, expect, it } from 'vitest';
import { assessD2lMonitorStatus, d2lMonitorMessage, pollD2lMonitorOnce } from './monitor.mjs';

const nowMs = Date.parse('2026-09-26T20:00:00.000Z');
function status(overrides = {}) {
  return {
    state: 'RUNNING', processAlive: true, updatedAt: new Date(nowMs - 3 * 60_000).toISOString(), reconciliationRequired: false,
    stats: { unknownChargeAttempts: 0 }, ledger: { reconciliationRequired: false, pendingAttemptCount: 0 },
    runId: 'private-run-id', statsPrivate: { actualChargedCredits: 271 }, ...overrides,
  };
}

describe('D2l local monitor', () => {
  it('does not alert for a live run with a fresh checkpoint and reconciled accounting', () => {
    expect(assessD2lMonitorStatus(status(), { nowMs })).toEqual([]);
  });

  it('alerts after the seven-minute checkpoint age bound', () => {
    const stale = status({ updatedAt: new Date(nowMs - 7 * 60_000 - 1).toISOString() });
    expect(assessD2lMonitorStatus(stale, { nowMs })).toEqual(['STALE_PROGRESS']);
  });

  it('reports stopped, stale, and accounting failures together without including counters or run identity', () => {
    const failed = status({ state: 'FAILED', processAlive: false, updatedAt: 'invalid', reconciliationRequired: true,
      stats: { unknownChargeAttempts: 1 }, ledger: { reconciliationRequired: true, pendingAttemptCount: 1 } });
    const alerts = assessD2lMonitorStatus(failed, { nowMs });
    expect(alerts).toEqual(['COLLECTOR_STOPPED', 'ACCOUNTING_RECONCILIATION', 'STALE_PROGRESS']);
    const message = d2lMonitorMessage(alerts);
    expect(message).toContain('stopped'); expect(message).toContain('reconciliation');
    expect(message).not.toContain('private-run-id'); expect(message).not.toContain('271');
  });

  it('publishes only on a new alert episode and permits a later recurrence', async () => {
    const published = [];
    const publish = async (message) => { published.push(message); };
    const failed = status({ state: 'FAILED', processAlive: false });
    const readFailed = async () => failed;
    const first = await pollD2lMonitorOnce({ readStatus: readFailed, publish, topic: 'synthetic-d2l-topic', nowMs });
    const repeated = await pollD2lMonitorOnce({ readStatus: readFailed, publish, topic: 'synthetic-d2l-topic', nowMs, previousSignature: first.signature });
    expect(first.published).toBe(true); expect(repeated.published).toBe(false); expect(published).toHaveLength(1);
    const recovered = await pollD2lMonitorOnce({ readStatus: async () => status(), publish, topic: 'synthetic-d2l-topic', nowMs, previousSignature: repeated.signature });
    expect(recovered.signature).toBe('');
    const recurrence = await pollD2lMonitorOnce({ readStatus: readFailed, publish, topic: 'synthetic-d2l-topic', nowMs, previousSignature: recovered.signature });
    expect(recurrence.published).toBe(true); expect(published).toHaveLength(2);
    expect(published[0]).toMatchObject({ topic: 'synthetic-d2l-topic', title: 'Ered Luin D2l monitor', priority: 4 });
  });

  it('turns local status read errors into a bounded generic alert', async () => {
    const published = [];
    const result = await pollD2lMonitorOnce({ readStatus: async () => { throw new Error('private local path'); },
      publish: async (value) => { published.push(value); }, topic: 'synthetic-d2l-topic', nowMs });
    expect(result.alerts).toEqual(['STATUS_UNAVAILABLE']);
    expect(published[0].message).toContain('could not be read');
    expect(published[0].message).not.toContain('private local path');
  });
});

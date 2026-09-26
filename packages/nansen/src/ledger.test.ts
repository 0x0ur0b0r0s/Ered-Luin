import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runtimeConfigSchema } from '@ered-luin/contracts';
import {
  CreditLedgerError,
  NANSEN_COST_PROFILE_VERSION,
  NansenCreditLedger,
  type LedgerOptions,
  type NansenOperation,
  type RecordTerminalResultInput,
  type ReserveAttemptInput,
  getReservedCredits,
  initializeCreditLedger,
  openCreditLedger,
} from './index.js';

const sourceDir = dirname(fileURLToPath(import.meta.url));
const reservationWorker = join(sourceDir, 'reservation-worker.mjs');
const crashWorker = join(sourceDir, 'crash-reservation-worker.mjs');
const fingerprint = 'a'.repeat(64);
let root: string;
let ledgers: NansenCreditLedger[];

function options(databasePath: string, overrides: Partial<LedgerOptions> = {}) {
  return {
    databasePath,
    budgetId: 'test-budget',
    limitCredits: 10,
    costProfileVersion: NANSEN_COST_PROFILE_VERSION,
    clock: () => new Date('2026-09-22T12:00:00.000Z'),
    ...overrides,
  };
}
function path(name = 'ledger.sqlite') {
  return join(root, name);
}
function createLedger(limitCredits = 10, name = 'ledger.sqlite') {
  const ledger = initializeCreditLedger(options(path(name), { limitCredits }));
  ledgers.push(ledger);
  return ledger;
}
function expectCode(action: () => unknown, code: string): CreditLedgerError {
  try {
    action();
    throw new Error('Expected CreditLedgerError ' + code);
  } catch (error) {
    expect(error).toBeInstanceOf(CreditLedgerError);
    expect((error as CreditLedgerError).code).toBe(code);
    return error as CreditLedgerError;
  }
}
const reserveInput = (attemptId: string, operation: NansenOperation = 'TOKEN_SCREENER', requestFingerprint = fingerprint): ReserveAttemptInput => ({
  attemptId, operation, requestFingerprint,
});
const terminalInput = (attemptId: string, changes: Partial<Omit<RecordTerminalResultInput, 'attemptId'>> = {}): RecordTerminalResultInput => ({
  attemptId, outcome: 'SUCCESS', ...changes,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ered-luin-g1a-'));
  ledgers = [];
});
afterEach(() => {
  for (const ledger of ledgers) {
    try { ledger.close(); } catch { /* A test may already have closed this handle. */ }
  }
  rmSync(root, { recursive: true, force: true });
});

describe('G1a persistent credit ledger', () => {
  it('uses only the closed, versioned operation cost profile and rejects unsafe inputs', () => {
    expect(NANSEN_COST_PROFILE_VERSION).toBe('nansen-2026-09-22-v1');
    expect(getReservedCredits('TOKEN_SCREENER')).toBe(1);
    expect(getReservedCredits('FLOW_INTELLIGENCE')).toBe(1);
    expect(getReservedCredits('SMART_MONEY_NETFLOW')).toBe(5);
    expectCode(() => getReservedCredits('UNKNOWN'), 'UNKNOWN_OPERATION');
    expectCode(() => getReservedCredits('TOKEN_SCREENER', 'unrecognized-profile'), 'UNKNOWN_COST_PROFILE');
    for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expectCode(() => initializeCreditLedger(options(path('invalid-' + String(invalid) + '.sqlite'), { limitCredits: invalid })), 'INVALID_INPUT');
    }
    expectCode(() => initializeCreditLedger({
      ...options(path('unknown-profile.sqlite')),
      costProfileVersion: 'made-up',
    }), 'UNKNOWN_COST_PROFILE');
  });

  it('denies a zero-credit budget and enforces exact allocation and exhaustion', () => {
    const ledger = createLedger(0);
    expectCode(() => ledger.reserveAttempt(reserveInput('zero')), 'BUDGET_EXHAUSTED');
    expect(ledger.getSnapshot()).toMatchObject({
      limitCredits: 0, allocatedCredits: 0, remainingCredits: 0, pendingAttemptCount: 0,
    });

    const other = initializeCreditLedger(options(path('budget-two.sqlite'), { limitCredits: 2 }));
    ledgers.push(other);
    expect(other.reserveAttempt(reserveInput('first')).dispatchGranted).toBe(true);
    expect(other.reserveAttempt(reserveInput('second', 'FLOW_INTELLIGENCE')).dispatchGranted).toBe(true);
    expect(other.reserveAttempt(reserveInput('first')).dispatchGranted).toBe(false);
    expectCode(() => other.reserveAttempt(reserveInput('third')), 'BUDGET_EXHAUSTED');
    expect(other.getSnapshot()).toMatchObject({
      allocatedCredits: 2, reservedEstimateCredits: 2, remainingCredits: 0, pendingAttemptCount: 2,
    });
  });

  it('does not refund lower or missing charges, and retains failed and cancelled reservations', () => {
    const ledger = createLedger(5);
    ledger.reserveAttempt(reserveInput('five', 'SMART_MONEY_NETFLOW'));
    ledger.recordTerminalResult(terminalInput('five', { chargedCredits: 2 }));
    expect(ledger.getSnapshot()).toMatchObject({
      reservedEstimateCredits: 5, allocatedCredits: 5, remainingCredits: 0,
      reportedChargedCreditsTotal: 2, reportedChargeCount: 1,
    });
    expectCode(() => ledger.reserveAttempt(reserveInput('blocked')), 'BUDGET_EXHAUSTED');

    const another = initializeCreditLedger(options(path('failures.sqlite'), { limitCredits: 2 }));
    ledgers.push(another);
    another.reserveAttempt(reserveInput('http-failure'));
    another.recordTerminalResult(terminalInput('http-failure', { outcome: 'HTTP_ERROR', httpStatus: 429 }));
    another.reserveAttempt(reserveInput('cancelled', 'FLOW_INTELLIGENCE'));
    another.recordTerminalResult(terminalInput('cancelled', { outcome: 'CANCELLED' }));
    expect(another.getSnapshot()).toMatchObject({ allocatedCredits: 2, pendingAttemptCount: 0 });
  });

  it('durably lists and reconciles terminal attempts with an unknown provider charge', () => {
    const ledger = createLedger(10);
    ledger.reserveAttempt(reserveInput('unknown-charge'));
    ledger.recordTerminalResult(terminalInput('unknown-charge', { outcome: 'TRANSPORT_ERROR', chargedCredits: null }));
    expect(ledger.listUnknownChargeAttempts()).toMatchObject([
      { attemptId: 'unknown-charge', outcome: 'TRANSPORT_ERROR', reportedChargedCredits: null },
    ]);

    const reconciled = ledger.reconcileUnknownCharge({ attemptId: 'unknown-charge', chargedCredits: 1 });
    expect(reconciled).toMatchObject({ attemptId: 'unknown-charge', reportedChargedCredits: 1 });
    expect(ledger.listUnknownChargeAttempts()).toEqual([]);
    expect(ledger.getSnapshot()).toMatchObject({
      allocatedCredits: 1, reportedChargedCreditsTotal: 1, reportedChargeCount: 1, reconciliationRequired: false,
    });
    expect(ledger.reconcileUnknownCharge({ attemptId: 'unknown-charge', chargedCredits: 1 })).toEqual(reconciled);
    expectCode(() => ledger.reconcileUnknownCharge({ attemptId: 'unknown-charge', chargedCredits: 2 }), 'RECONCILIATION_CONFLICT');

    ledger.reserveAttempt(reserveInput('still-pending'));
    expectCode(() => ledger.reconcileUnknownCharge({ attemptId: 'still-pending', chargedCredits: 1 }), 'RECONCILIATION_CONFLICT');
  });

  it('halts accounting when explicit reconciliation confirms a charge above its reservation', () => {
    const ledger = createLedger(10);
    ledger.reserveAttempt(reserveInput('charge-overrun'));
    ledger.recordTerminalResult(terminalInput('charge-overrun', { outcome: 'TRANSPORT_ERROR', chargedCredits: null }));
    ledger.reconcileUnknownCharge({ attemptId: 'charge-overrun', chargedCredits: 3 });
    expect(ledger.getSnapshot()).toMatchObject({
      allocatedCredits: 3, overrunCredits: 2, reconciliationRequired: true, haltReason: 'CHARGE_OVERRUN',
    });
    expectCode(() => ledger.reserveAttempt(reserveInput('blocked-after-reconciliation')), 'ACCOUNTING_HALTED');
  });

  it('returns an existing reservation without redispatch, rejects ID conflicts, and makes terminal writes idempotent', () => {
    const ledger = createLedger();
    const first = ledger.reserveAttempt(reserveInput('same'));
    expect(first.dispatchGranted).toBe(true);
    expect(ledger.reserveAttempt(reserveInput('same')).dispatchGranted).toBe(false);
    expectCode(() => ledger.reserveAttempt(reserveInput('same', 'FLOW_INTELLIGENCE')), 'DUPLICATE_ATTEMPT_CONFLICT');
    expectCode(() => ledger.reserveAttempt(reserveInput('same', 'TOKEN_SCREENER', 'b'.repeat(64))), 'DUPLICATE_ATTEMPT_CONFLICT');
    const costOverride = { ...reserveInput('extra'), reservedCredits: 0 };
    expectCode(() => ledger.reserveAttempt(costOverride), 'INVALID_INPUT');

    const terminal = terminalInput('same', { httpStatus: 200, providerRequestId: 'req-1', chargedCredits: 1 });
    const saved = ledger.recordTerminalResult(terminal);
    expect(ledger.recordTerminalResult(terminal)).toEqual(saved);
    expectCode(() => ledger.recordTerminalResult(terminalInput('same', { outcome: 'HTTP_ERROR' })), 'COMPLETION_CONFLICT');
    expectCode(() => ledger.recordTerminalResult(terminalInput('missing')), 'ATTEMPT_NOT_FOUND');

    for (const invalid of [-1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expectCode(() => ledger.recordTerminalResult(terminalInput('same', { chargedCredits: invalid })), 'INVALID_INPUT');
    }
    expect(ledger.getSnapshot().allocatedCredits).toBe(1);
  });

  it('races independent processes for the last credit and for one identical attempt ID', async () => {
    const opts = options(path(), { limitCredits: 1 });
    const ledger = initializeCreditLedger(opts);
    ledgers.push(ledger);

    const different = await runReservationRace(opts, [
      reserveInput('race-a'),
      reserveInput('race-b'),
    ]);
    expect(different.filter((result) => result.ok && result.dispatchGranted)).toHaveLength(1);
    expect(different.filter((result) => result.code === 'BUDGET_EXHAUSTED')).toHaveLength(1);
    expect(ledger.getSnapshot().allocatedCredits).toBe(1);

    const sameOpts = options(path('same-race.sqlite'), { limitCredits: 1 });
    const sameLedger = initializeCreditLedger(sameOpts);
    ledgers.push(sameLedger);
    const same = await runReservationRace(sameOpts, [reserveInput('same-race'), reserveInput('same-race')]);
    expect(same.filter((result) => result.ok && result.dispatchGranted)).toHaveLength(1);
    expect(same.filter((result) => result.ok && !result.dispatchGranted)).toHaveLength(1);
    expect(sameLedger.getSnapshot().allocatedCredits).toBe(1);
  });

  it('survives reopen and a process exiting immediately after committed reservation', async () => {
    const opts = options(path(), { limitCredits: 3 });
    const ledger = initializeCreditLedger(opts);
    ledgers.push(ledger);
    ledger.reserveAttempt(reserveInput('survives-close'));
    ledger.close();

    const reopened = openCreditLedger(opts);
    ledgers.push(reopened);
    expect(reopened.getAttempt('survives-close')?.outcome).toBe('PENDING');
    expect(reopened.reserveAttempt(reserveInput('survives-close')).dispatchGranted).toBe(false);
    reopened.close();

    const child = await runChild(crashWorker, [
      opts.databasePath, JSON.stringify({ ...opts, clock: undefined }), JSON.stringify(reserveInput('crash-pending')),
    ]);
    expect(child.exitCode).toBe(0);
    const afterCrash = openCreditLedger(opts);
    ledgers.push(afterCrash);
    expect(afterCrash.getSnapshot()).toMatchObject({ allocatedCredits: 2, pendingAttemptCount: 2 });
    expect(afterCrash.reserveAttempt(reserveInput('crash-pending')).dispatchGranted).toBe(false);
  });

  it('rolls a failed reservation transaction back without granting or consuming credits', () => {
    const initial = createLedger(3);
    initial.close();
    const failingClock = openCreditLedger(options(path(), {
      limitCredits: 3,
      clock: () => { throw new Error('synthetic clock failure'); },
    }));
    ledgers.push(failingClock);

    expectCode(() => failingClock.reserveAttempt(reserveInput('rolled-back')), 'INVALID_INPUT');
    expect(failingClock.getSnapshot()).toMatchObject({ allocatedCredits: 0, pendingAttemptCount: 0 });
    failingClock.close();

    const ledger = openCreditLedger(options(path(), { limitCredits: 3 }));
    ledgers.push(ledger);
    expect(ledger.reserveAttempt(reserveInput('after-rollback')).dispatchGranted).toBe(true);
    expect(ledger.getSnapshot().allocatedCredits).toBe(1);
  });

  it('refuses missing, existing-empty, corrupt, unsupported, and mismatched ledgers without resetting them', () => {
    const missing = path('missing.sqlite');
    expectCode(() => openCreditLedger(options(missing)), 'DATABASE_NOT_FOUND');

    const empty = path('empty.sqlite');
    writeFileSync(empty, '');
    const emptyBefore = createHash('sha256').update(readFileSync(empty)).digest('hex');
    expectCode(() => openCreditLedger(options(empty)), 'DATABASE_CORRUPT');
    expect(createHash('sha256').update(readFileSync(empty)).digest('hex')).toBe(emptyBefore);
    expectCode(() => initializeCreditLedger(options(empty)), 'DATABASE_ALREADY_EXISTS');

    const noSchema = path('no-schema.sqlite');
    const bare = new DatabaseSync(noSchema);
    bare.exec('PRAGMA journal_mode = WAL');
    bare.close();
    expectCode(() => openCreditLedger(options(noSchema)), 'DATABASE_CORRUPT');
    expectCode(() => initializeCreditLedger(options(noSchema)), 'DATABASE_ALREADY_EXISTS');

    const corrupt = path('corrupt.sqlite');
    writeFileSync(corrupt, 'not sqlite data');
    const corruptBefore = createHash('sha256').update(readFileSync(corrupt)).digest('hex');
    expectCode(() => openCreditLedger(options(corrupt)), 'DATABASE_CORRUPT');
    expect(createHash('sha256').update(readFileSync(corrupt)).digest('hex')).toBe(corruptBefore);

    const ledger = createLedger(4, 'unsupported.sqlite');
    ledger.close();
    const unsupported = new DatabaseSync(path('unsupported.sqlite'));
    unsupported.exec('PRAGMA user_version = 1');
    unsupported.close();
    expectCode(() => openCreditLedger(options(path('unsupported.sqlite'), { limitCredits: 4 })), 'UNSUPPORTED_SCHEMA_VERSION');
    const futureVersion = createLedger(4, 'future-version.sqlite');
    futureVersion.close();
    const future = new DatabaseSync(path('future-version.sqlite'));
    future.exec('PRAGMA user_version = 999');
    future.close();
    expectCode(() => openCreditLedger(options(path('future-version.sqlite'), { limitCredits: 4 })), 'UNSUPPORTED_SCHEMA_VERSION');
    const mismatch = createLedger(4, 'mismatch.sqlite');
    mismatch.close();
    expectCode(() => openCreditLedger(options(path('mismatch.sqlite'), { limitCredits: 5 })), 'CONFIGURATION_MISMATCH');
    const correct = openCreditLedger(options(path('mismatch.sqlite'), { limitCredits: 4 }));
    ledgers.push(correct);
  });

  it('detects inconsistent accounting and does not repair it', () => {
    const ledger = createLedger(4);
    ledger.reserveAttempt(reserveInput('tamper'));
    ledger.close();
    const raw = new DatabaseSync(path());
    raw.exec('UPDATE ledger_meta SET allocated_credits = 0 WHERE singleton = 1');
    raw.close();
    expectCode(() => openCreditLedger(options(path(), { limitCredits: 4 })), 'DATABASE_CORRUPT');
    const verify = new DatabaseSync(path());
    const value = verify.prepare('SELECT allocated_credits FROM ledger_meta WHERE singleton = 1').get();
    verify.close();
    expect(value?.allocated_credits).toBe('0');

    const invalid = createLedger(4, 'invalid-row.sqlite');
    invalid.reserveAttempt(reserveInput('invalid-row'));
    invalid.close();
    const rawInvalid = new DatabaseSync(path('invalid-row.sqlite'));
    rawInvalid.exec('PRAGMA ignore_check_constraints = ON');
    rawInvalid.exec("UPDATE attempts SET operation = 'UNKNOWN' WHERE attempt_id = 'invalid-row'");
    rawInvalid.close();
    expectCode(() => openCreditLedger(options(path('invalid-row.sqlite'), { limitCredits: 4 })), 'DATABASE_CORRUPT');
    const verifyInvalid = new DatabaseSync(path('invalid-row.sqlite'));
    const invalidOperation = verifyInvalid.prepare("SELECT operation FROM attempts WHERE attempt_id = 'invalid-row'").get();
    verifyInvalid.close();
    expect(invalidOperation?.operation).toBe('UNKNOWN');

    const unexpected = createLedger(4, 'unexpected-trigger.sqlite');
    unexpected.close();
    const withTrigger = new DatabaseSync(path('unexpected-trigger.sqlite'));
    withTrigger.exec("CREATE TRIGGER unexpected_noop BEFORE INSERT ON attempts BEGIN SELECT 1; END");
    withTrigger.close();
    expectCode(() => openCreditLedger(options(path('unexpected-trigger.sqlite'), { limitCredits: 4 })), 'DATABASE_CORRUPT');
  });

  it('persists overflow evidence and blocks every connection and process', async () => {
    const normalOptions = options(path('normal-overrun.sqlite'), { limitCredits: 4 });
    const normal = initializeCreditLedger(normalOptions);
    ledgers.push(normal);
    normal.reserveAttempt(reserveInput('normal-overrun'));
    normal.recordTerminalResult(terminalInput('normal-overrun', { chargedCredits: 3 }));
    expect(normal.getSnapshot()).toMatchObject({
      allocatedCredits: 3, overrunCredits: 2, reconciliationRequired: true,
      haltReason: 'CHARGE_OVERRUN',
    });
    normal.close();
    const normalReopened = openCreditLedger(normalOptions);
    ledgers.push(normalReopened);
    expectCode(() => normalReopened.reserveAttempt(reserveInput('normal-overrun-blocked')), 'ACCOUNTING_HALTED');

    const opts = options(path('overflow.sqlite'), { limitCredits: 10 });
    const ledger = initializeCreditLedger(opts);
    ledgers.push(ledger);
    const secondConnection = openCreditLedger(opts);
    ledgers.push(secondConnection);

    ledger.reserveAttempt(reserveInput('overflow-one'));
    ledger.reserveAttempt(reserveInput('overflow-two'));
    const completed = ledger.recordTerminalResult(terminalInput('overflow-one', {
      chargedCredits: Number.MAX_SAFE_INTEGER,
    }));
    expect(completed).toMatchObject({
      attemptId: 'overflow-one',
      reportedChargedCredits: Number.MAX_SAFE_INTEGER,
      outcome: 'SUCCESS',
    });
    expect(ledger.recordTerminalResult(terminalInput('overflow-one', {
      chargedCredits: Number.MAX_SAFE_INTEGER,
    }))).toEqual(completed);

    const diagnostic = expectCode(() => ledger.getSnapshot(), 'INTEGER_OVERFLOW');
    expect(diagnostic.details).toEqual({
      allocatedCreditsExact: '9007199254740992',
      reconciliationRequired: true,
      haltReason: 'CHARGE_OVERRUN',
    });
    const raw = new DatabaseSync(path('overflow.sqlite'));
    const exactTotal = raw.prepare('SELECT allocated_credits FROM ledger_meta WHERE singleton = 1').get();
    const chargeEvidence = raw.prepare("SELECT charged_credits FROM attempts WHERE attempt_id = 'overflow-one'").get();
    raw.close();
    expect(exactTotal?.allocated_credits).toBe('9007199254740992');
    expect(chargeEvidence?.charged_credits).toBe(Number.MAX_SAFE_INTEGER);

    const sameConnectionBlock = expectCode(
      () => ledger.reserveAttempt(reserveInput('overflow-local-new')),
      'ACCOUNTING_HALTED',
    );
    expect(sameConnectionBlock.details?.allocatedCreditsExact).toBe('9007199254740992');
    const otherConnectionBlock = expectCode(
      () => secondConnection.reserveAttempt(reserveInput('overflow-second-connection')),
      'ACCOUNTING_HALTED',
    );
    expect(otherConnectionBlock.details?.allocatedCreditsExact).toBe('9007199254740992');

    ledger.close();
    secondConnection.close();
    const reopened = openCreditLedger(opts);
    ledgers.push(reopened);
    expect(reopened.getAttempt('overflow-one')?.reportedChargedCredits).toBe(Number.MAX_SAFE_INTEGER);
    expectCode(() => reopened.getSnapshot(), 'INTEGER_OVERFLOW');
    expectCode(() => reopened.reserveAttempt(reserveInput('overflow-after-reopen')), 'ACCOUNTING_HALTED');

    const processResult = await runReservationRace(opts, [reserveInput('overflow-new-process')]);
    expect(processResult).toEqual([{ ok: false, code: 'ACCOUNTING_HALTED' }]);
  });

  it('uses safe G0 configuration defaults and exposes only allowlisted metadata', () => {
    expect(runtimeConfigSchema.parse({})).toEqual({
      NANSEN_API_ENABLED: 'false', NANSEN_CREDIT_BUDGET: '0',
      LIVE_EXECUTION_ENABLED: 'false', EXECUTION_MODE: 'paper',
    });
    const ledger = createLedger();
    ledger.reserveAttempt(reserveInput('sanitized'));
    const attempt = ledger.recordTerminalResult(terminalInput('sanitized', {
      httpStatus: 200, providerRequestId: 'safe-request-id', chargedCredits: 1,
    }));
    const snapshotJson = JSON.stringify(ledger.getSnapshot());
    const attemptJson = JSON.stringify(attempt);
    for (const serialized of [snapshotJson, attemptJson]) {
      expect(serialized).not.toMatch(/authorization|secret|api.?key|body|headers|error.message/i);
    }
    expect(attempt).toHaveProperty('providerRequestId', 'safe-request-id');
    expect(existsSync(join(root, '.env'))).toBe(false);
  });
});

interface WorkerResult {
  ok: boolean;
  dispatchGranted?: boolean;
  code?: string;
}
async function runReservationRace(
  opts: ReturnType<typeof options>,
  inputs: ReturnType<typeof reserveInput>[],
): Promise<WorkerResult[]> {
  const barrierDirectory = mkdtempSync(join(root, 'race-barrier-'));
  const gate = join(barrierDirectory, 'release');
  const workers: BarrierWorker[] = [];

  try {
    inputs.forEach((input, index) => {
      const readyPath = join(barrierDirectory, 'ready-' + index);
      workers.push(startBarrierWorker(reservationWorker, [
        opts.databasePath,
        readyPath,
        gate,
        JSON.stringify({ ...opts, clock: undefined }),
        JSON.stringify(input),
      ], readyPath));
    });

    await waitUntil(() => workers.every((worker) => {
      if (worker.child.exitCode !== null) {
        throw new Error('Reservation process exited before the release handshake.');
      }
      try {
        return readFileSync(worker.readyPath, 'utf8') === String(worker.pid) &&
          worker.output.includes(JSON.stringify({ kind: 'ready', pid: worker.pid }) + '\n');
      } catch {
        return false;
      }
    }));

    expect(existsSync(gate)).toBe(false);
    expect(workers.every((worker) => {
      const messages = parseWorkerMessages(worker.output);
      return messages.length === 1 && messages[0]?.kind === 'ready';
    })).toBe(true);

    writeFileSync(gate, 'release');
    const results = await Promise.all(workers.map(async (worker) => {
      const child = await worker.promise;
      if (child.exitCode !== 0) throw new Error('Worker failed: ' + child.stderr);
      const result = parseWorkerMessages(child.stdout).find((message) => message.kind === 'result');
      if (!result) throw new Error('Worker exited without a reservation result.');
      return {
        ok: result.ok === true,
        dispatchGranted: result.dispatchGranted as boolean | undefined,
        code: result.code as string | undefined,
      };
    }));
    return results;
  } finally {
    if (!existsSync(gate)) writeFileSync(gate, 'release');
    await Promise.allSettled(workers.map((worker) => worker.promise));
    for (const worker of workers) {
      if (worker.child.exitCode === null && !worker.child.killed) worker.child.kill();
    }
  }
}
interface WorkerMessage {
  kind: 'ready' | 'result';
  pid?: number;
  ok?: boolean;
  dispatchGranted?: boolean;
  code?: string;
}
function parseWorkerMessages(output: string): WorkerMessage[] {
  return output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as WorkerMessage);
}
interface BarrierWorker {
  child: ReturnType<typeof spawn>;
  pid: number;
  readyPath: string;
  output: string;
  promise: Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
}
function startBarrierWorker(script: string, args: string[], readyPath: string): BarrierWorker {
  const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (child.pid === undefined || child.stdout === null || child.stderr === null) {
    child.kill();
    throw new Error('Could not start reservation worker with captured process streams.');
  }
  const worker: BarrierWorker = {
    child,
    pid: child.pid,
    readyPath,
    output: '',
    promise: Promise.resolve({ exitCode: null, stdout: '', stderr: '' }),
  };
  let stderr = '';
  let resolveWorker!: (value: { exitCode: number | null; stdout: string; stderr: string }) => void;
  let rejectWorker!: (error: Error) => void;
  worker.promise = new Promise((resolve, reject) => {
    resolveWorker = resolve;
    rejectWorker = reject;
  });
  void worker.promise.catch(() => {});
  const timeout = setTimeout(() => child.kill(), 20_000);
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { worker.output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  child.once('error', (error) => { clearTimeout(timeout); rejectWorker(error); });
  child.once('close', (code) => {
    clearTimeout(timeout);
    resolveWorker({ exitCode: code, stdout: worker.output, stderr });
  });
  return worker;
}
function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        if (predicate()) return resolve();
        if (Date.now() > deadline) return reject(new Error('Timed out waiting for reservation process handshakes.'));
        setTimeout(poll, 20);
      } catch (error) {
        reject(error);
      }
    };
    poll();
  });
}
function runChild(script: string, args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill(), 20_000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === null) return reject(new Error('Child process was terminated. ' + stderr));
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Decision, ExecutionLifecycleRecord, ExecutionReceiptEvidence, ExecutionSimulationEvidence, TradeIntent } from '@ered-luin/contracts';
import { initializeExecutionStore, openExecutionStore, type CreateExecutionReservationInput, type ExecutionStore } from './execution-store.js';

const workerPath = fileURLToPath(new URL('./execution-store-worker.mjs', import.meta.url));
const wallet = '0x' + '1'.repeat(40);
const router = '0x' + '2'.repeat(40);
const recipient = '0x' + '3'.repeat(40);
const openStores: ExecutionStore[] = [];
const tempDirs: string[] = [];
let currentMs = Date.parse('2026-09-23T16:00:00.000Z');
let databasePath = '';

function setup() {
  currentMs = Date.parse('2026-09-23T16:00:00.000Z');
  const directory = mkdtempSync(join(tmpdir(), 'ered-luin-g3a-'));
  tempDirs.push(directory);
  databasePath = join(directory, 'paper.sqlite');
  const clock = () => new Date(currentMs);
  const store = initializeExecutionStore({ databasePath, clock });
  openStores.push(store);
  return { store, clock };
}
function reopen() {
  const store = openExecutionStore({ databasePath, clock: () => new Date(currentMs) });
  openStores.push(store);
  return store;
}
function mutateStoredRecord(executionId: string, mutate: (record: ExecutionLifecycleRecord) => void): void {
  const database = new DatabaseSync(databasePath);
  try {
    const row = database.prepare('SELECT record_json FROM execution_lifecycle WHERE execution_id = ?').get(executionId) as { record_json: string } | undefined;
    if (!row) throw new Error('Execution record not found for corruption fixture.');
    const record = JSON.parse(row.record_json) as ExecutionLifecycleRecord;
    mutate(record);
    database.prepare('UPDATE execution_lifecycle SET status = ?, record_json = ? WHERE execution_id = ?')
      .run(record.status, JSON.stringify(record), executionId);
  } finally {
    database.close();
  }
}
function intent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return {
    intentId: randomUUID(), chainId: 8453, walletAddress: wallet, sellAsset: 'USDC', buyAsset: 'WETH',
    amountIn: '5000000', issuedAt: new Date(currentMs - 10_000).toISOString(),
    expiresAt: new Date(currentMs + 60_000).toISOString(), ...overrides,
  };
}
function decision(trade: TradeIntent, overrides: Partial<Decision> = {}): Decision {
  return {
    decisionId: randomUUID(), intentId: trade.intentId, status: 'ALLOW',
    evaluatedAt: new Date(currentMs - 5_000).toISOString(), policyVersion: 'g3a-synthetic-test-v1',
    requestedAmountIn: trade.amountIn, approvedAmountIn: trade.amountIn, reasons: ['SYNTHETIC_TEST_ONLY'], ...overrides,
  };
}
function transaction(trade: TradeIntent, overrides: Partial<CreateExecutionReservationInput['transaction']> = {}): CreateExecutionReservationInput['transaction'] {
  return {
    version: 1, chainId: 8453, walletAddress: trade.walletAddress, router, recipient,
    sellAsset: trade.sellAsset, buyAsset: trade.buyAsset, amountIn: trade.amountIn,
    minimumAmountOut: '4900000', valueNativeWei: '0', maxFeePerGasWei: '3',
    maxPriorityFeePerGasWei: '1', maxTotalFeeWei: '100', chainNonce: '41',
    expiresAt: new Date(currentMs + 50_000).toISOString(), ...overrides,
  };
}
function reservation(overrides: Partial<CreateExecutionReservationInput> = {}): CreateExecutionReservationInput {
  const trade = overrides.intent ?? intent();
  return {
    executionId: randomUUID(), intent: trade, decision: overrides.decision ?? decision(trade),
    accountVersion: 7, reservationExposureUsdcMicros: '5000000',
    transaction: overrides.transaction ?? transaction(trade), reason: 'synthetic reservation test', ...overrides,
  };
}
function evidence(record: ReturnType<ExecutionStore['get']>, overrides: Partial<ExecutionSimulationEvidence> = {}): ExecutionSimulationEvidence {
  return {
    version: 1, simulationId: randomUUID(), executionId: record.executionId,
    transactionDigest: record.transactionDigest, producerId: 'synthetic-test-adapter', outcome: 'PASSED',
    simulatedAt: new Date(currentMs).toISOString(), expiresAt: new Date(currentMs + 10_000).toISOString(), ...overrides,
  };
}
function authorize(store: ExecutionStore, input: CreateExecutionReservationInput) {
  const reserved = store.reserve(input).record;
  const simulated = store.recordSimulation(reserved.executionId, reserved.accountVersion, evidence(reserved), 'fake simulator passed').record;
  return store.issueAuthorization(simulated.executionId, simulated.accountVersion, 'unit test authorization').record;
}
function signAndPersist(store: ExecutionStore, record: ReturnType<ExecutionStore['get']>) {
  const auth = record.authorization!;
  const claim = store.claimSigning(record.executionId, auth.authorizationNonce, record.accountVersion, 'synthetic signer claim').record;
  const signedBytesHex = '0x' + Buffer.from('synthetic-signed-bytes:' + record.transactionDigest).toString('hex');
  const outbox = store.persistSignedOutbox(claim.executionId, claim.accountVersion, signedBytesHex, fakeTransactionHash(signedBytesHex), 'fake signer output').record;
  return { outbox, signedBytesHex };
}
function fakeTransactionHash(bytesHex: string): string { return '0x' + createHash('sha256').update(Buffer.from(bytesHex.slice(2), 'hex')).digest('hex'); }
function receipt(record: ReturnType<ExecutionStore['get']>, overrides: Partial<ExecutionReceiptEvidence> = {}): ExecutionReceiptEvidence {
  const outbox = record.signedOutbox!;
  return {
    version: 1, receiptId: randomUUID(), chainId: 8453, transactionHash: outbox.transactionHash,
    transactionDigest: record.transactionDigest, chainNonce: record.transaction.chainNonce, outcome: 'CONFIRMED',
    blockNumber: '100', blockHash: '0x' + 'b'.repeat(64), gasUsedNativeWei: '21000',
    effectiveGasPriceWei: '1', observedAt: new Date(currentMs).toISOString(), ...overrides,
  };
}
function codeOf(action: () => unknown, code: string): void {
  try { action(); } catch (error) { expect(error).toMatchObject({ code }); return; }
  throw new Error('Expected error code ' + code);
}
interface WorkerMessage { readonly type: string; readonly value?: unknown; readonly barrierId?: string }
function isWorkerMessage(value: unknown): value is WorkerMessage {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';
}
function message(child: ChildProcess, type: string): Promise<WorkerMessage> {
  return new Promise<WorkerMessage>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for child message ' + type)), 15_000);
    const handler = (value: unknown) => {
      if (!isWorkerMessage(value)) return;
      if (value.type === 'error' && type !== 'error') {
        clearTimeout(timeout); child.off('message', handler); reject(new Error(JSON.stringify(value.value))); return;
      }
      if (value.type !== type) return;
      clearTimeout(timeout); child.off('message', handler); resolve(value);
    };
    child.on('message', handler);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });
}
function exited(child: ChildProcess): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
}
function spawnWorker(mode: string, payload: unknown, barrier = ''): ChildProcess {
  return fork(workerPath, [mode, databasePath, JSON.stringify({ ...payload as object, clockAt: new Date(currentMs).toISOString() }), barrier], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
}
async function exitAfterAction(action: string, payload: object): Promise<unknown> {
  const child = spawnWorker('exit-after-action', { ...payload, action });
  const resultPromise = message(child, 'result');
  const exitPromise = exited(child);
  const result = await resultPromise;
  expect(await exitPromise).toBe(0);
  return result.value;
}
type RaceResult = { readonly success: true; readonly record: Pick<ExecutionLifecycleRecord, 'executionId'> } |
  { readonly success: false; readonly error: { readonly code: string } };
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isRaceResult(value: unknown): value is RaceResult {
  if (!isObject(value)) return false;
  if (value.success === true) return isObject(value.record) && typeof value.record.executionId === 'string';
  return value.success === false && isObject(value.error) && typeof value.error.code === 'string';
}
async function runRace(mode: 'race-reserve' | 'race-claim', payloads: unknown[]): Promise<RaceResult[]> {
  const barrierId = randomUUID();
  const children = payloads.map((payload) => spawnWorker(mode, payload, barrierId));
  const readyPromises = children.map((child) => message(child, 'ready'));
  const resultPromises = children.map((child) => message(child, 'result'));
  const exitPromises = children.map((child) => exited(child));
  const ready = await Promise.all(readyPromises);
  expect(ready.every((item) => item.barrierId === barrierId)).toBe(true);
  for (const child of children) child.send({ type: 'release', barrierId });
  const results = await Promise.all(resultPromises);
  expect(await Promise.all(exitPromises)).toEqual([0, 0]);
  return results.map((item) => {
    if (!isRaceResult(item.value)) throw new Error('Malformed race-worker result.');
    return item.value;
  });
}
afterEach(() => {
  for (const store of openStores.splice(0)) { try { store.close(); } catch { /* Already closed. */ } }
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('G3a durable execution lifecycle', () => {
  it('initializes stopped, persists stop across reopen and a fresh process, and keeps reconciliation available', async () => {
    const { store } = setup();
    expect(store.getKillSwitch()).toMatchObject({ stopped: true, reason: 'INITIALIZED_STOPPED' });
    store.setKillSwitch(false, 'synthetic test setup');
    const input = reservation();
    const authorized = authorize(store, input);
    const signed = signAndPersist(store, authorized);
    const uncertain = store.prepareBroadcast(signed.outbox.executionId, 'fake transport dispatch').record;
    const blockedIntent = intent({ walletAddress: '0x' + '4'.repeat(40) });
    const blocked = reservation({ intent: blockedIntent, transaction: transaction(blockedIntent) });
    const blockedAuthorized = authorizeIgnoringStopSetup(store, blocked);
    store.setKillSwitch(true, 'operator stop for test');
    codeOf(() => store.issueAuthorization(blockedAuthorized.executionId, blocked.accountVersion, 'must remain stopped'), 'KILL_SWITCH_STOPPED');
    codeOf(() => store.claimSigning(blockedAuthorized.executionId, blockedAuthorized.authorization!.authorizationNonce, blocked.accountVersion, 'must remain stopped'), 'KILL_SWITCH_STOPPED');
    store.close();
    const reopened = reopen();
    expect(reopened.getKillSwitch()).toMatchObject({ stopped: true, reason: 'operator stop for test' });
    const fresh = await runStatusProcess();
    expect(fresh).toMatchObject({ stopped: true, reason: 'operator stop for test' });
    expect(reopened.listReconciliationQueue().map((item) => item.executionId)).toContain(uncertain.executionId);
    const retry = reopened.prepareBroadcast(uncertain.executionId, 'reconcile while stopped');
    expect(retry.signedBytesHex).toBe(signed.signedBytesHex);
    const settled = reopened.reconcileReceipt(retry.record.executionId, receipt(retry.record), 'exact receipt while stopped');
    expect(settled.record.status).toBe('CONFIRMED');
  });

  it('uses strict idempotent reservations and one shared wallet slot', () => {
    const { store } = setup();
    const input = reservation();
    const first = store.reserve(input);
    expect(store.reserve(input)).toMatchObject({ replayed: true, record: { executionId: input.executionId } });
    codeOf(() => store.reserve({ ...input, reservationExposureUsdcMicros: '6000000' }), 'EXECUTION_ID_CONFLICT');
    const second = reservation({ intent: intent() });
    codeOf(() => store.reserve(second), 'EXECUTION_WALLET_BUSY');
    expect(first.record).toMatchObject({
      status: 'RESERVED', intent: input.intent, decision: input.decision, transaction: input.transaction,
      accountVersion: 7, reservationExposureUsdcMicros: '5000000',
    });
  });

  it('rejects invalid transitions, stale versions, changed transactions and mismatched or stale simulation evidence', () => {
    const { store } = setup();
    store.setKillSwitch(false, 'test arm');
    const input = reservation();
    const reserved = store.reserve(input).record;
    codeOf(() => store.issueAuthorization(reserved.executionId, 7, 'too early'), 'EXECUTION_STATE_INVALID');
    codeOf(() => store.recordSimulation(reserved.executionId, 6, evidence(reserved), 'stale account'), 'ACCOUNT_VERSION_STALE');
    codeOf(() => store.recordSimulation(reserved.executionId, 7, evidence(reserved, { transactionDigest: 'a'.repeat(64) }), 'mutated simulation'), 'SIMULATION_INVALID');
    codeOf(() => store.recordSimulation(reserved.executionId, 7, evidence(reserved, { outcome: 'FAILED' }), 'failed simulation'), 'SIMULATION_INVALID');
    codeOf(() => store.reserve({ ...input, transaction: { ...input.transaction, minimumAmountOut: '4800000' } }), 'EXECUTION_ID_CONFLICT');
    const stale = evidence(reserved, { simulatedAt: new Date(currentMs - 16_000).toISOString() });
    codeOf(() => store.recordSimulation(reserved.executionId, 7, stale, 'stale evidence'), 'SIMULATION_INVALID');
    const simulated = store.recordSimulation(reserved.executionId, 7, evidence(reserved), 'fresh synthetic evidence').record;
    codeOf(() => store.issueAuthorization(simulated.executionId, 8, 'stale account'), 'ACCOUNT_VERSION_STALE');
  });

  it('rejects a failed simulation mutation on the open connection, after reopen, and in a fresh process', async () => {
    const { store } = setup();
    store.setKillSwitch(false, 'simulation corruption test');
    const authorized = authorize(store, reservation());
    mutateStoredRecord(authorized.executionId, (record) => {
      if (!record.simulation) throw new Error('Authorized fixture must contain simulation evidence.');
      record.simulation.outcome = 'FAILED';
    });

    codeOf(() => store.get(authorized.executionId), 'DATABASE_CORRUPT');
    codeOf(() => store.claimSigning(authorized.executionId, authorized.authorization!.authorizationNonce, 7, 'claim corrupted authorization'), 'DATABASE_CORRUPT');
    codeOf(() => store.reserve(reservation()), 'EXECUTION_WALLET_BUSY');
    expect(await runOpenFailureProcess()).toMatchObject({ code: 'DATABASE_CORRUPT' });
    store.close();
    codeOf(() => openExecutionStore({ databasePath, clock: () => new Date(currentMs) }), 'DATABASE_CORRUPT');

    const check = new DatabaseSync(databasePath);
    const row = check.prepare('SELECT status, record_json FROM execution_lifecycle WHERE execution_id = ?').get(authorized.executionId) as { status: string; record_json: string };
    const persisted = JSON.parse(row.record_json) as ExecutionLifecycleRecord;
    const reservationRow = check.prepare('SELECT status FROM wallet_reservations WHERE reservation_id = ?').get(authorized.reservationId) as { status: string };
    expect(row.status).toBe('AUTHORIZED');
    expect(persisted.signingClaim).toBeNull();
    expect(reservationRow.status).toBe('ACTIVE');
    check.close();
  });

  it('rejects a pre-sign FAILED status that conceals an existing signing claim or outbox', () => {
    const { store } = setup();
    store.setKillSwitch(false, 'failure corruption test');
    const authorized = authorize(store, reservation());
    const { outbox } = signAndPersist(store, authorized);
    mutateStoredRecord(outbox.executionId, (record) => {
      record.status = 'FAILED';
      record.failureReason = 'synthetic failure without receipt';
    });

    codeOf(() => store.get(outbox.executionId), 'DATABASE_CORRUPT');
    codeOf(() => openExecutionStore({ databasePath, clock: () => new Date(currentMs) }), 'DATABASE_CORRUPT');
    const check = new DatabaseSync(databasePath);
    const reservationRow = check.prepare('SELECT status FROM wallet_reservations WHERE reservation_id = ?').get(outbox.reservationId) as { status: string };
    expect(reservationRow.status).toBe('ACTIVE');
    check.close();
  });
  it('binds authorization to every transaction field and consumes one nonce exactly once', () => {
    const { store } = setup();
    store.setKillSwitch(false, 'test arm');
    const input = reservation();
    const authorized = authorize(store, input);
    expect(authorized.authorization).toMatchObject({
      walletAddress: input.transaction.walletAddress, chainId: input.transaction.chainId,
      router: input.transaction.router, recipient: input.transaction.recipient,
      sellAsset: input.transaction.sellAsset, buyAsset: input.transaction.buyAsset,
      amountIn: input.transaction.amountIn, minimumAmountOut: input.transaction.minimumAmountOut,
      valueNativeWei: input.transaction.valueNativeWei, maxFeePerGasWei: input.transaction.maxFeePerGasWei,
      maxPriorityFeePerGasWei: input.transaction.maxPriorityFeePerGasWei, maxTotalFeeWei: input.transaction.maxTotalFeeWei,
      chainNonce: input.transaction.chainNonce, transactionDigest: authorized.transactionDigest,
      simulationId: authorized.simulation!.simulationId,
    });
    expect(authorized.authorization!.authorizationNonce).not.toBe(authorized.transaction.chainNonce);
    const claimed = store.claimSigning(authorized.executionId, authorized.authorization!.authorizationNonce, 7, 'claim once');
    expect(claimed.record.status).toBe('SIGNING_CLAIMED');
    codeOf(() => store.claimSigning(authorized.executionId, authorized.authorization!.authorizationNonce, 7, 'replay'), 'AUTHORIZATION_NONCE_REPLAYED');
  });

  it('reopens historically valid expired authorization but will not claim it or release its reservation', () => {
    const { store } = setup();
    store.setKillSwitch(false, 'test arm');
    const authorized = authorize(store, reservation());
    currentMs += 16_000;
    store.close();
    const reopened = reopen();
    expect(reopened.get(authorized.executionId).status).toBe('AUTHORIZED');
    codeOf(() => reopened.claimSigning(authorized.executionId, authorized.authorization!.authorizationNonce, 7, 'expired claim'), 'AUTHORIZATION_EXPIRED');
    codeOf(() => reopened.reserve(reservation()), 'EXECUTION_WALLET_BUSY');
  });
  it('persists signed bytes before fake broadcast and retries only the identical outbox', () => {
    const { store } = setup();
    store.setKillSwitch(false, 'test arm');
    const authorized = authorize(store, reservation());
    const { outbox, signedBytesHex } = signAndPersist(store, authorized);
    expect(outbox.status).toBe('SIGNED_OUTBOX');
    const fakeBroadcast = (bytes: string) => {
      const stored = store.get(outbox.executionId);
      expect(stored.status).toBe('SUBMISSION_UNCERTAIN');
      expect(stored.signedOutbox!.signedBytesHex).toBe(bytes);
      return { outcome: 'timeout' as const };
    };
    const first = store.prepareBroadcast(outbox.executionId, 'fake broadcast attempt 1');
    expect(fakeBroadcast(first.signedBytesHex)).toEqual({ outcome: 'timeout' });
    store.recordSubmissionTimeout(outbox.executionId, 'fake transport timed out');
    const retry = store.prepareBroadcast(outbox.executionId, 'same-byte retry');
    expect(retry.replayed).toBe(true);
    expect(retry.signedBytesHex).toBe(signedBytesHex);
    expect(retry.transactionHash).toBe(first.transactionHash);
  });

  it('rejects unknown and contradictory receipts, settles exact duplicates once, and releases only exact reverts', () => {
    const { store } = setup();
    store.setKillSwitch(false, 'test arm');
    const authorized = authorize(store, reservation());
    const { outbox } = signAndPersist(store, authorized);
    const uncertain = store.prepareBroadcast(outbox.executionId, 'fake send');
    const unknown = receipt(uncertain.record, { transactionHash: '0x' + 'c'.repeat(64) });
    codeOf(() => store.reconcileReceipt(outbox.executionId, unknown, 'wrong tx hash'), 'RECEIPT_MISMATCH');
    expect(store.get(outbox.executionId).status).toBe('SUBMISSION_UNCERTAIN');
    const confirmed = receipt(uncertain.record);
    expect(store.reconcileReceipt(outbox.executionId, confirmed, 'exact receipt').record.status).toBe('CONFIRMED');
    expect(store.reconcileReceipt(outbox.executionId, confirmed, 'duplicate exact receipt').replayed).toBe(true);
    codeOf(() => store.reconcileReceipt(outbox.executionId, receipt(uncertain.record, { outcome: 'REVERTED' }), 'contradiction'), 'RECEIPT_CONFLICT');
    const next = reservation();
    const nextRecord = store.reserve(next).record;
    expect(nextRecord.status).toBe('RESERVED');
    store.releaseBeforeSigning(nextRecord.executionId, 7, 'free separate test reservation');

    const revertedTrade = intent({ walletAddress: '0x' + '4'.repeat(40) });
    const revertedInput = reservation({ intent: revertedTrade, transaction: transaction(revertedTrade) });
    const revertedAuth = authorize(store, revertedInput);
    const revertedOutbox = signAndPersist(store, revertedAuth).outbox;
    const submitted = store.prepareBroadcast(revertedOutbox.executionId, 'fake revert send');
    expect(store.reconcileReceipt(revertedOutbox.executionId, receipt(submitted.record, { outcome: 'REVERTED' }), 'exact revert').record.status).toBe('FAILED');
    store.close();
    const reopened = reopen();
    expect(reopened.get(revertedOutbox.executionId).status).toBe('FAILED');
    const nextWalletIntent = intent({ walletAddress: revertedTrade.walletAddress });
    expect(reopened.reserve(reservation({ intent: nextWalletIntent, transaction: transaction(nextWalletIntent) })).record.status).toBe('RESERVED');
  });

  it('releases only before a signing claim and keeps a claimed crash held for reconciliation', () => {
    const { store } = setup();
    store.setKillSwitch(false, 'test arm');
    const before = store.reserve(reservation()).record;
    expect(store.releaseBeforeSigning(before.executionId, 7, 'operator cancelled').record.status).toBe('RELEASED');
    const auth = authorize(store, reservation({ intent: intent() }));
    const claim = store.claimSigning(auth.executionId, auth.authorization!.authorizationNonce, 7, 'claim before simulated crash').record;
    store.close();
    const reopened = reopen();
    expect(reopened.get(claim.executionId).status).toBe('SIGNING_CLAIMED');
    codeOf(() => reopened.releaseBeforeSigning(claim.executionId, 7, 'unsafe release'), 'EXECUTION_STATE_INVALID');
    expect(reopened.listReconciliationQueue().map((item) => item.executionId)).toContain(claim.executionId);
  });

  it('uses an independent ready/release barrier for wallet reservation and signing claim races', async () => {
    const { store } = setup();
    store.setKillSwitch(false, 'test arm');
    const inputA = reservation();
    const inputB = reservation({ intent: intent() });
    const reserveResults = await runRace('race-reserve', [inputA, inputB]);
    const successfulReservations = reserveResults.filter((result): result is Extract<RaceResult, { success: true }> => result.success);
    const failedReservations = reserveResults.filter((result): result is Extract<RaceResult, { success: false }> => !result.success);
    expect(successfulReservations).toHaveLength(1);
    expect(failedReservations).toHaveLength(1);
    expect(failedReservations[0]?.error.code).toBe('EXECUTION_WALLET_BUSY');

    const active = successfulReservations[0]?.record;
    if (!active) throw new Error('Expected one successful wallet reservation.');
    // Use a second wallet so the earlier active reservation remains held.
    const otherWalletIntent = intent({ walletAddress: '0x' + '4'.repeat(40) });
    const other = reservation({ intent: otherWalletIntent, transaction: transaction(otherWalletIntent) });
    const auth = authorize(store, other);
    const claimBase = {
      executionId: auth.executionId, authorizationNonce: auth.authorization!.authorizationNonce,
      accountVersion: auth.accountVersion, reason: 'same authorization raced',
    };
    const claimResults = await runRace('race-claim', [claimBase, claimBase]);
    const successfulClaims = claimResults.filter((result): result is Extract<RaceResult, { success: true }> => result.success);
    const failedClaims = claimResults.filter((result): result is Extract<RaceResult, { success: false }> => !result.success);
    expect(successfulClaims).toHaveLength(1);
    expect(failedClaims).toHaveLength(1);
    expect(failedClaims[0]?.error.code).toBe('AUTHORIZATION_NONCE_REPLAYED');
    expect(store.get(active.executionId).status).toBe('RESERVED');
  }, 30_000);

  it('reopens after child-process termination at reservation, claim, outbox and uncertainty', async () => {
    const { store } = setup();
    store.setKillSwitch(false, 'crash recovery test');
    const input = reservation();
    store.close();
    await exitAfterAction('reserve', input);
    let reopened = reopen();
    let record = reopened.get(input.executionId);
    expect(record.status).toBe('RESERVED');
    reopened.close();

    const simEvidence = evidence(record);
    await exitAfterAction('simulation', { executionId: input.executionId, accountVersion: 7, evidence: simEvidence, reason: 'worker simulation' });
    reopened = reopen();
    record = reopened.get(input.executionId);
    expect(record.status).toBe('SIMULATED');
    reopened.close();

    await exitAfterAction('authorization', { executionId: input.executionId, accountVersion: 7, reason: 'worker auth' });
    reopened = reopen();
    record = reopened.get(input.executionId);
    expect(record.status).toBe('AUTHORIZED');
    reopened.close();

    await exitAfterAction('claim', { executionId: input.executionId, authorizationNonce: record.authorization!.authorizationNonce, accountVersion: 7, reason: 'worker claim' });
    reopened = reopen();
    record = reopened.get(input.executionId);
    expect(record.status).toBe('SIGNING_CLAIMED');
    reopened.close();

    const signedBytesHex = '0x' + Buffer.from('crash-safe-synthetic:' + record.transactionDigest).toString('hex');
    await exitAfterAction('outbox', { executionId: input.executionId, accountVersion: 7, signedBytesHex, transactionHash: fakeTransactionHash(signedBytesHex), reason: 'worker signed bytes' });
    reopened = reopen();
    record = reopened.get(input.executionId);
    expect(record.status).toBe('SIGNED_OUTBOX');
    expect(record.signedOutbox!.signedBytesHex).toBe(signedBytesHex);
    reopened.close();

    await exitAfterAction('broadcast', { executionId: input.executionId, reason: 'worker persisted uncertain attempt' });
    reopened = reopen();
    record = reopened.get(input.executionId);
    currentMs += 20_000;
    reopened = reopen();
    record = reopened.get(input.executionId);
    expect(record.status).toBe('SUBMISSION_UNCERTAIN');
    expect(reopened.prepareBroadcast(input.executionId, 'identical recovery retry').signedBytesHex).toBe(signedBytesHex);
  });


  it('migrates the recognized G2 schema without resetting balances or unresolved reservations', () => {
    currentMs = Date.parse('2026-09-23T16:00:00.000Z');
    const directory = mkdtempSync(join(tmpdir(), 'ered-luin-g3a-migrate-'));
    tempDirs.push(directory);
    databasePath = join(directory, 'paper.sqlite');
    const legacy = new DatabaseSync(databasePath);
    legacy.exec('PRAGMA foreign_keys = ON'); legacy.exec('PRAGMA journal_mode = WAL');
    legacy.exec("CREATE TABLE paper_meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version INTEGER NOT NULL CHECK (typeof(schema_version) = 'integer' AND schema_version > 0), store_id TEXT NOT NULL UNIQUE CHECK (length(store_id) BETWEEN 1 AND 128)) STRICT");
    legacy.exec("CREATE TABLE paper_accounts (wallet_address TEXT PRIMARY KEY CHECK (length(wallet_address) = 42), version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 0), usdc_balance_atomic TEXT NOT NULL CHECK (length(usdc_balance_atomic) <= 128 AND usdc_balance_atomic NOT GLOB '*[^0-9]*' AND (usdc_balance_atomic = '0' OR substr(usdc_balance_atomic, 1, 1) BETWEEN '1' AND '9')), weth_balance_atomic TEXT NOT NULL CHECK (length(weth_balance_atomic) <= 128 AND weth_balance_atomic NOT GLOB '*[^0-9]*' AND (weth_balance_atomic = '0' OR substr(weth_balance_atomic, 1, 1) BETWEEN '1' AND '9')), gas_balance_native_wei TEXT NOT NULL CHECK (length(gas_balance_native_wei) <= 128 AND gas_balance_native_wei NOT GLOB '*[^0-9]*' AND (gas_balance_native_wei = '0' OR substr(gas_balance_native_wei, 1, 1) BETWEEN '1' AND '9')), utc_day TEXT NOT NULL CHECK (length(utc_day) = 10), daily_start_equity_usdc_micros TEXT NOT NULL CHECK (length(daily_start_equity_usdc_micros) <= 128 AND daily_start_equity_usdc_micros NOT GLOB '*[^0-9]*' AND (daily_start_equity_usdc_micros = '0' OR substr(daily_start_equity_usdc_micros, 1, 1) BETWEEN '1' AND '9')), daily_funding_usdc_micros TEXT NOT NULL CHECK (length(daily_funding_usdc_micros) <= 128), created_at TEXT NOT NULL) STRICT");
    legacy.exec("CREATE TABLE paper_intents (intent_id TEXT PRIMARY KEY CHECK (length(intent_id) = 36), intent_json TEXT NOT NULL CHECK (length(intent_json) <= 4096), decision_json TEXT NOT NULL CHECK (length(decision_json) <= 16384), execution_json TEXT NOT NULL CHECK (length(execution_json) <= 4096), signal_ids_json TEXT NOT NULL CHECK (length(signal_ids_json) <= 16384), signal_source TEXT NOT NULL CHECK (signal_source IN ('nansen','synthetic','none','mixed')), quote_source TEXT NOT NULL CHECK (quote_source IN ('pool','synthetic','none','mixed')), reservation_id TEXT, created_at TEXT NOT NULL) STRICT");
    legacy.exec("CREATE TABLE paper_reservations (reservation_id TEXT PRIMARY KEY CHECK (length(reservation_id) = 36), intent_id TEXT NOT NULL UNIQUE REFERENCES paper_intents(intent_id), wallet_address TEXT NOT NULL REFERENCES paper_accounts(wallet_address), approved_amount_in TEXT NOT NULL CHECK (length(approved_amount_in) <= 128 AND approved_amount_in NOT GLOB '*[^0-9]*' AND approved_amount_in <> '0'), exposure_usdc_micros TEXT NOT NULL CHECK (length(exposure_usdc_micros) <= 128 AND exposure_usdc_micros NOT GLOB '*[^0-9]*' AND exposure_usdc_micros <> '0'), status TEXT NOT NULL CHECK (status IN ('PENDING','UNKNOWN','SETTLED','RELEASED')), created_at TEXT NOT NULL, settled_at TEXT) STRICT");
    legacy.exec('PRAGMA user_version = 1');
    legacy.prepare('INSERT INTO paper_meta (singleton,schema_version,store_id) VALUES (1,1,?)').run('ered-luin-paper-g2-v1');
    legacy.prepare('INSERT INTO paper_accounts (wallet_address,version,usdc_balance_atomic,weth_balance_atomic,gas_balance_native_wei,utc_day,daily_start_equity_usdc_micros,daily_funding_usdc_micros,created_at) VALUES (?,5,?,?,?,?,?,?,?)')
      .run(wallet, '10000000', '0', '1000000000', '2026-09-23', '10000000', '0', new Date(currentMs).toISOString());
    const legacyIntent = intent({ intentId: '00000000-0000-4000-8000-000000000051' });
    const legacyDecision: Decision = {
      decisionId: '00000000-0000-4000-8000-000000000052', intentId: legacyIntent.intentId,
      status: 'REQUIRE_REVIEW', evaluatedAt: new Date(currentMs).toISOString(), policyVersion: 'g2-legacy',
      requestedAmountIn: legacyIntent.amountIn, approvedAmountIn: null, reasons: ['SYNTHETIC_MIGRATION_FIXTURE'],
    };
    const legacyExecution = {
      intentId: legacyIntent.intentId, mode: 'PAPER' as const, status: 'UNKNOWN' as const,
      updatedAt: new Date(currentMs).toISOString(), transactionHash: null, failureCode: 'MIGRATION_UNCERTAIN',
    };
    const reservationId = '00000000-0000-4000-8000-000000000053';
    legacy.prepare('INSERT INTO paper_intents (intent_id,intent_json,decision_json,execution_json,signal_ids_json,signal_source,quote_source,reservation_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(legacyIntent.intentId, JSON.stringify(legacyIntent), JSON.stringify(legacyDecision), JSON.stringify(legacyExecution),
        '[]', 'none', 'none', reservationId, new Date(currentMs).toISOString());
    legacy.prepare('INSERT INTO paper_reservations (reservation_id,intent_id,wallet_address,approved_amount_in,exposure_usdc_micros,status,created_at,settled_at) VALUES (?,?,?,?,?,?,?,NULL)')
      .run(reservationId, legacyIntent.intentId, wallet, '100000', '100000', 'UNKNOWN', new Date(currentMs).toISOString());
    legacy.close();

    const migrated = openExecutionStore({ databasePath, clock: () => new Date(currentMs) });
    openStores.push(migrated);
    expect(migrated.getKillSwitch()).toMatchObject({ stopped: true, reason: 'SCHEMA_UPGRADED_STOPPED' });
    codeOf(() => migrated.reserve(reservation()), 'EXECUTION_WALLET_BUSY');
    migrated.close();
    const check = new DatabaseSync(databasePath);
    expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(4);
    expect((check.prepare('SELECT usdc_balance_atomic FROM paper_accounts WHERE wallet_address = ?').get(wallet) as { usdc_balance_atomic: string }).usdc_balance_atomic).toBe('10000000');
    expect((check.prepare('SELECT status FROM wallet_reservations WHERE reservation_id = ?').get(reservationId) as { status: string }).status).toBe('ACTIVE');
    check.close();
  });

});

function authorizeIgnoringStopSetup(store: ExecutionStore, input: CreateExecutionReservationInput) {
  const reserved = store.reserve(input).record;
  const simulated = store.recordSimulation(reserved.executionId, reserved.accountVersion, evidence(reserved), 'simulate before stop').record;
  return store.issueAuthorization(simulated.executionId, simulated.accountVersion, 'issue before stop').record;
}
async function runOpenFailureProcess(): Promise<unknown> {
  const child = spawnWorker('status', {});
  const errorPromise = message(child, 'error');
  const exitPromise = exited(child);
  const result = await errorPromise;
  expect(await exitPromise).toBe(0);
  return result.value;
}

async function runStatusProcess(): Promise<unknown> {
  const child = spawnWorker('status', {});
  const resultPromise = message(child, 'result');
  const exitPromise = exited(child);
  const result = await resultPromise;
  expect(await exitPromise).toBe(0);
  return result.value;
}

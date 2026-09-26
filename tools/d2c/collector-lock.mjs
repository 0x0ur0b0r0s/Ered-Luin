import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const LOCK_MAX_BYTES = 2_048;
function isInsideRoot(path) {
  const rel = relative(ROOT, resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}
function checkedObservationStorePath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes(String.fromCharCode(0)) || isInsideRoot(value)) {
    throw new Error('COLLECTION_EXTERNAL_STATE_UNAVAILABLE');
  }
  let stat; let canonical;
  try { stat = lstatSync(value); canonical = realpathSync(value); } catch { throw new Error('COLLECTION_EXTERNAL_STATE_UNAVAILABLE'); }
  if (!stat.isFile() || stat.isSymbolicLink() || isInsideRoot(canonical)) throw new Error('COLLECTION_EXTERNAL_STATE_UNAVAILABLE');
  return canonical;
}
function readLock(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LOCK_MAX_BYTES) return null;
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(',') !== 'nonce,pid,runId,schemaVersion,startedAt' ||
        value.schemaVersion !== 1 || typeof value.runId !== 'string' || typeof value.nonce !== 'string' ||
        !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.startedAt !== 'string') return null;
    return value;
  } catch { return null; }
}
function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') return false;
    return true;
  }
}
function sameOwner(actual, expected) {
  return actual !== null && actual.pid === expected.pid && actual.runId === expected.runId && actual.nonce === expected.nonce;
}
function createOwnerFile(path, value, failureCode) {
  let descriptor;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify(value));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
  } catch {
    if (descriptor !== undefined) { try { closeSync(descriptor); } catch { /* Preserve fail-closed state. */ } }
    throw new Error(failureCode);
  }
}
function createLock(path, runId, nonce) {
  const value = { schemaVersion: 1, runId, pid: process.pid, startedAt: new Date().toISOString(), nonce };
  const descriptor = openSync(path, 'wx', 0o600);
  try { writeFileSync(descriptor, JSON.stringify(value)); fsyncSync(descriptor); }
  catch (error) { try { unlinkSync(path); } catch { /* Preserve the original failure. */ } throw error; }
  finally { closeSync(descriptor); }
  return value;
}
function transitionPathFor(path) { return path + '.transition'; }
function transitionOwnerPath(path) { return transitionPathFor(path) + '/owner.json'; }
function acquireTransition(path, runId) {
  const directory = transitionPathFor(path);
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'EEXIST')) throw new Error('COLLECTION_LOCK_TRANSITION_FAILED');
    const prior = readLock(transitionOwnerPath(path));
    if (prior && isProcessAlive(prior.pid)) throw new Error('COLLECTION_LOCK_TRANSITION_BUSY');
    throw new Error('COLLECTION_LOCK_TRANSITION_REQUIRES_RECONCILIATION');
  }

  const owner = { schemaVersion: 1, runId, pid: process.pid, startedAt: new Date().toISOString(), nonce: randomUUID() };
  try { createOwnerFile(transitionOwnerPath(path), owner, 'COLLECTION_LOCK_TRANSITION_FAILED'); }
  catch (error) {
    if (error instanceof Error && error.message === 'COLLECTION_LOCK_TRANSITION_FAILED') {
      const current = readLock(transitionOwnerPath(path));
      if (sameOwner(current, owner)) {
        try { unlinkSync(transitionOwnerPath(path)); rmdirSync(directory); } catch { /* Leave incomplete state fail-closed. */ }
      }
    }
    throw error;
  }

  let released = false;
  return Object.freeze({
    release() {
      if (released) return;
      released = true;
      if (!sameOwner(readLock(transitionOwnerPath(path)), owner)) return;
      try {
        unlinkSync(transitionOwnerPath(path));
        rmdirSync(directory);
      } catch { /* An interrupted transition is left fail-closed for operator reconciliation. */ }
    },
  });
}
function ownerHandle(path, owner) {
  let released = false;
  return Object.freeze({
    path,
    release() {
      if (released) return;
      released = true;
      const current = readLock(path);
      if (!sameOwner(current, owner) || current.pid !== process.pid) return;
      try { unlinkSync(path); } catch { /* Stale lock remains fail-closed for operator recovery. */ }
    },
  });
}

export function acquireCollectionLock(observationStorePath, { runId = randomUUID(), recoverStale = false } = {}) {
  const checked = checkedObservationStorePath(observationStorePath);
  if (typeof runId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(runId)) throw new Error('COLLECTION_LOCK_INVALID');
  const path = checked + '.collector.lock';
  const nonce = randomUUID();
  const transition = acquireTransition(path, runId);
  try {
    try { return ownerHandle(path, createLock(path, runId, nonce)); }
    catch (error) {
      if (!(error && typeof error === 'object' && error.code === 'EEXIST')) throw new Error('COLLECTION_LOCK_FAILED');
    }

    const prior = readLock(path);
    if (!prior) throw new Error('COLLECTION_LOCK_UNREADABLE');
    if (isProcessAlive(prior.pid)) throw new Error('COLLECTION_ALREADY_RUNNING');
    if (!recoverStale) throw new Error('COLLECTION_LOCK_STALE_REQUIRES_RECONCILIATION');

    const stalePath = path + '.stale.' + randomUUID();
    try { renameSync(path, stalePath); }
    catch { throw new Error('COLLECTION_ALREADY_RUNNING'); }
    let owner;
    try { owner = createLock(path, runId, nonce); }
    catch (createError) {
      if (createError && typeof createError === 'object' && createError.code === 'EEXIST') {
        throw new Error('COLLECTION_ALREADY_RUNNING');
      }
      throw new Error('COLLECTION_LOCK_FAILED');
    }
    try { unlinkSync(stalePath); } catch { /* Archived stale metadata contains no credential or source data. */ }
    return ownerHandle(path, owner);
  } finally {
    transition.release();
  }
}

export function collectionProcessIsAlive(pid) {
  return Number.isSafeInteger(pid) && pid > 0 && isProcessAlive(pid);
}

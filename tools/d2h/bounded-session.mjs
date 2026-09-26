import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const STATUSES = new Set(['RUNNING', 'STOPPED', 'FAILED', 'COMPLETED']);
const ENDPOINTS = new Set(['TOKEN_SCREENER', 'FLOW_INTELLIGENCE', 'SMART_MONEY_NETFLOW']);
const MAX_MANIFEST_BYTES = 64 * 1024;
function record(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function safeInt(value, min = 0) { return Number.isSafeInteger(value) && value >= min; }
function within(root, path) {
  const rel = relative(root, resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}
function exactKeys(value, keys) {
  return record(value) && Object.keys(value).sort().join('\n') === [...keys].sort().join('\n');
}
function validIso(value) { return typeof value === 'string' && Number.isSafeInteger(Date.parse(value)) && new Date(value).toISOString() === value; }

export function resolveExternalManifestPath(path, root) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes(String.fromCharCode(0))) throw new Error('MANIFEST_PATH_INVALID');
  const target = resolve(path);
  let realRoot;
  let realParent;
  try { realRoot = realpathSync(root); realParent = realpathSync(dirname(target)); } catch { throw new Error('MANIFEST_PATH_INVALID'); }
  const realTarget = resolve(realParent, target.slice(dirname(target).length + 1));
  if (within(realRoot, realTarget) || within(realRoot, realParent)) throw new Error('MANIFEST_PATH_INVALID');
  let parentStat;
  try { parentStat = lstatSync(dirname(target)); } catch { throw new Error('MANIFEST_PATH_INVALID'); }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('MANIFEST_PATH_INVALID');
  return target;
}

function validateStats(value) {
  const keys = ['cycles', 'providerAttempts', 'qualifyingSuccesses', 'cacheHits', 'actualChargedCredits', 'unknownChargeAttempts', 'failedQueries', 'lastEndpoint', 'lastObservedAt'];
  return exactKeys(value, keys) && ['cycles', 'providerAttempts', 'qualifyingSuccesses', 'cacheHits', 'actualChargedCredits', 'unknownChargeAttempts', 'failedQueries'].every((key) => safeInt(value[key])) &&
    (value.lastEndpoint === null || ENDPOINTS.has(value.lastEndpoint)) && (value.lastObservedAt === null || validIso(value.lastObservedAt));
}
function validateResearch(value) {
  return exactKeys(value, ['successfulHttpRequests', 'usableResearchSnapshots', 'cacheHits', 'failedResults', 'organizerConfirmedSuccesses']) &&
    exactKeys(value.successfulHttpRequests, ['TOKEN_SCREENER', 'SMART_MONEY_NETFLOW']) &&
    ['TOKEN_SCREENER', 'SMART_MONEY_NETFLOW'].every((key) => safeInt(value.successfulHttpRequests[key])) &&
    ['usableResearchSnapshots', 'cacheHits', 'failedResults'].every((key) => safeInt(value[key])) &&
    value.organizerConfirmedSuccesses === null;
}
function validateLedger(value) {
  const keys = ['limitCredits', 'reservedEstimateCredits', 'allocatedCredits', 'remainingCredits', 'overrunCredits', 'overBudgetCredits', 'reportedChargedCreditsTotal', 'reportedChargeCount', 'pendingAttemptCount', 'reconciliationRequired', 'haltReason'];
  return exactKeys(value, keys) && ['limitCredits', 'reservedEstimateCredits', 'allocatedCredits', 'remainingCredits', 'overrunCredits', 'overBudgetCredits', 'reportedChargeCount', 'pendingAttemptCount'].every((key) => safeInt(value[key])) &&
    (value.reportedChargedCreditsTotal === null || safeInt(value.reportedChargedCreditsTotal)) && typeof value.reconciliationRequired === 'boolean' &&
    (value.haltReason === null || value.haltReason === 'CHARGE_OVERRUN');
}
export function validateRunManifest(value) {
  const baseKeys = ['schemaVersion', 'runId', 'stateIdentity', 'createdAt', 'updatedAt', 'deadlineAt', 'maxAttempts', 'creditCap', 'successTarget', 'reconciledPriorSuccesses', 'baselineAllocatedCredits', 'status', 'pid', 'stopReason', 'reconciliationConfirmedAt', 'stats', 'ledger'];
  const v2 = record(value) && value.schemaVersion === 2;
  const keys = v2 ? [...baseKeys, 'profile', 'research'] : baseKeys;
  if (!exactKeys(value, keys) || (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
      (v2 && (!['weth-research-v1', 'weth-research-v2'].includes(value.profile) || !validateResearch(value.research))) || (!v2 && value.schemaVersion !== 1) || typeof value.runId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(value.runId) ||
      typeof value.stateIdentity !== 'string' || !/^[0-9a-f]{64}$/u.test(value.stateIdentity) || !validIso(value.createdAt) || !validIso(value.updatedAt) ||
      !validIso(value.deadlineAt) || !safeInt(value.maxAttempts, 1) || !safeInt(value.creditCap, 1) || !safeInt(value.successTarget, 1) || !safeInt(value.reconciledPriorSuccesses) ||
      !safeInt(value.baselineAllocatedCredits) || !STATUSES.has(value.status) || !safeInt(value.pid, 1) ||
      (value.stopReason !== null && (typeof value.stopReason !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.stopReason))) ||
      (value.reconciliationConfirmedAt !== null && !validIso(value.reconciliationConfirmedAt)) || !validateStats(value.stats) || !validateLedger(value.ledger)) {
    throw new Error('MANIFEST_INVALID');
  }
  return value;
}
export function readRunManifest(path, root) {
  const target = resolveExternalManifestPath(path, root);
  try {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) throw new Error('MANIFEST_INVALID');
    return validateRunManifest(JSON.parse(readFileSync(target, 'utf8')));
  } catch (error) {
    if (error instanceof Error && error.message === 'MANIFEST_INVALID') throw error;
    throw new Error('MANIFEST_UNAVAILABLE');
  }
}
export function writeRunManifest(path, root, value, { createOnly = false } = {}) {
  const target = resolveExternalManifestPath(path, root);
  const manifest = validateRunManifest(value);
  const payload = JSON.stringify(manifest, null, 2) + '\n';
  if (Buffer.byteLength(payload, 'utf8') > MAX_MANIFEST_BYTES) throw new Error('MANIFEST_INVALID');
  if (createOnly) {
    let descriptor;
    try { descriptor = openSync(target, 'wx', 0o600); }
    catch (error) { if (error && typeof error === 'object' && error.code === 'EEXIST') throw new Error('MANIFEST_ALREADY_EXISTS'); throw new Error('MANIFEST_WRITE_FAILED'); }
    try { writeFileSync(descriptor, payload); fsyncSync(descriptor); }
    catch { try { unlinkSync(target); } catch { /* Preserve the fail-closed result. */ } throw new Error('MANIFEST_WRITE_FAILED'); }
    finally { closeSync(descriptor); }
    return target;
  }
  let existing;
  try { existing = lstatSync(target); } catch { throw new Error('MANIFEST_UNAVAILABLE'); }
  if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('MANIFEST_INVALID');
  const temp = target + '.tmp.' + randomUUID();
  let descriptor;
  try {
    descriptor = openSync(temp, 'wx', 0o600);
    writeFileSync(descriptor, payload);
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    renameSync(temp, target);
  } catch { if (descriptor !== undefined) { try { closeSync(descriptor); } catch { /* noop */ } } try { unlinkSync(temp); } catch { /* noop */ } throw new Error('MANIFEST_WRITE_FAILED'); }
  return target;
}

export function createStateIdentity({ ledgerPath, budgetId, costProfileVersion, observationStorePath, observationStoreId }) {
  const value = { ledgerPath: resolve(ledgerPath), budgetId, costProfileVersion, observationStorePath: resolve(observationStorePath), observationStoreId };
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}
export function makeSafeLedger(snapshot) {
  return Object.freeze({
    limitCredits: snapshot.limitCredits, reservedEstimateCredits: snapshot.reservedEstimateCredits,
    allocatedCredits: snapshot.allocatedCredits, remainingCredits: snapshot.remainingCredits,
    overrunCredits: snapshot.overrunCredits, overBudgetCredits: snapshot.overBudgetCredits,
    reportedChargedCreditsTotal: snapshot.reportedChargedCreditsTotal, reportedChargeCount: snapshot.reportedChargeCount,
    pendingAttemptCount: snapshot.pendingAttemptCount, reconciliationRequired: snapshot.reconciliationRequired,
    haltReason: snapshot.haltReason,
  });
}
export function makeNewRunManifest({ bounds, stateIdentity, runId = randomUUID(), baselineAllocatedCredits, ledger, profile = 'default-v1' }) {
  const researchProfile = profile === 'weth-research-v1' || profile === 'weth-research-v2';
  if (profile !== 'default-v1' && !researchProfile) throw new Error('MANIFEST_INVALID');
  const now = new Date().toISOString();
  const research = researchProfile ? {
    successfulHttpRequests: { TOKEN_SCREENER: 0, SMART_MONEY_NETFLOW: 0 }, usableResearchSnapshots: 0, cacheHits: 0, failedResults: 0, organizerConfirmedSuccesses: null,
  } : null;
  return validateRunManifest({
    schemaVersion: research ? 2 : 1, ...(research ? { profile, research } : {}), runId, stateIdentity, createdAt: now, updatedAt: now, deadlineAt: bounds.deadlineAt,
    maxAttempts: bounds.maxAttempts, creditCap: bounds.creditCap, successTarget: bounds.successTarget, reconciledPriorSuccesses: bounds.reconciledPriorSuccesses,
    baselineAllocatedCredits, status: 'RUNNING', pid: process.pid, stopReason: null, reconciliationConfirmedAt: null,
    stats: { cycles: 0, providerAttempts: 0, qualifyingSuccesses: 0, cacheHits: 0, actualChargedCredits: 0, unknownChargeAttempts: 0, failedQueries: 0, lastEndpoint: null, lastObservedAt: null },
    ledger: makeSafeLedger(ledger),
  });
}
export function publicRunStatus(manifest, processAlive = null) {
  const checked = validateRunManifest(manifest);
  return Object.freeze({
    runId: checked.runId, state: checked.status, processAlive, updatedAt: checked.updatedAt, deadlineAt: checked.deadlineAt,
    bounds: Object.freeze({ maxAttempts: checked.maxAttempts, creditCap: checked.creditCap, successTarget: checked.successTarget, reconciledPriorSuccesses: checked.reconciledPriorSuccesses, totalSuccessTarget: checked.reconciledPriorSuccesses + checked.successTarget }),
    stats: checked.stats, ...(checked.schemaVersion === 2 ? { profile: checked.profile, research: checked.research } : {}), ledger: checked.ledger, stopReason: checked.stopReason,
    reconciliationRequired: checked.ledger.reconciliationRequired || checked.ledger.pendingAttemptCount > 0 || checked.stats.unknownChargeAttempts > 0,
  });
}

export function buildD2hPreview({ plan, costs, now = new Date(), durationMinutes = null, deadlineAt = null, maxAttempts = null, creditCap = null, successTarget = null, reconciledPriorSuccesses = null } = {}) {
  if (!Array.isArray(plan) || !plan.length || !record(costs) || !(now instanceof Date) || !Number.isSafeInteger(now.getTime())) throw new Error('PREVIEW_INVALID');
  const intervalMs = plan.map((item) => item.intervalMs);
  if (intervalMs.some((value) => !safeInt(value, 1))) throw new Error('PREVIEW_INVALID');
  const callsPerHour = plan.reduce((sum, item) => sum + 3_600_000 / item.intervalMs, 0);
  const creditsPerHour = plan.reduce((sum, item) => sum + (3_600_000 / item.intervalMs) * costs[item.query.operation] * item.query.pageBound * (item.query.retryBound + 1), 0);
  const validCaps = (maxAttempts === null || safeInt(maxAttempts, 1)) && (creditCap === null || safeInt(creditCap, 1)) && (successTarget === null || safeInt(successTarget, 1)) && (reconciledPriorSuccesses === null || safeInt(reconciledPriorSuccesses));
  if (!validCaps || (durationMinutes !== null && (!safeInt(durationMinutes, 1) || durationMinutes > 10_080)) || (durationMinutes !== null && deadlineAt !== null)) throw new Error('PREVIEW_BOUNDS_INVALID');
  const derivedDeadline = durationMinutes !== null ? new Date(now.getTime() + durationMinutes * 60_000).toISOString() : deadlineAt;
  if (derivedDeadline !== null && (!validIso(derivedDeadline) || Date.parse(derivedDeadline) <= now.getTime() || Date.parse(derivedDeadline) - now.getTime() > 7 * 24 * 60 * 60_000)) throw new Error('PREVIEW_BOUNDS_INVALID');
  const missingInputs = [];
  if (derivedDeadline === null) missingInputs.push('finite UTC deadline or duration');
  if (maxAttempts === null) missingInputs.push('maximum provider-attempt count');
  if (creditCap === null) missingInputs.push('positive credit cap matching approved external configuration');
  if (successTarget === null) missingInputs.push('target useful-success count after reconciliation');
  if (reconciledPriorSuccesses === null) missingInputs.push('reconciled prior qualifying-success count');
  return Object.freeze({
    mode: 'DRY_RUN', providerCalls: 0, credentialRead: false, persistentWrite: false, timerScheduled: false,
    requested: Object.freeze({ deadlineAt: derivedDeadline, maxAttempts, creditCap, successTarget, reconciledPriorSuccesses, totalSuccessTarget: reconciledPriorSuccesses === null || successTarget === null ? null : reconciledPriorSuccesses + successTarget }),
    cadence: Object.freeze({ callsPerHour: Number(callsPerHour.toFixed(2)), creditsPerHour: Number(creditsPerHour.toFixed(2)) }),
    plan: Object.freeze(plan.map((item) => Object.freeze({
      operation: item.query.operation, asset: item.query.asset, timeframe: item.query.timeframe,
      pageBound: item.query.pageBound, retryBound: item.query.retryBound, refreshMinutes: item.intervalMs / 60_000,
      estimatedCredits: costs[item.query.operation] * item.query.pageBound * (item.query.retryBound + 1),
    }))),
    cache: 'Canonical manager cache is used; cache hits do not create provider attempts or qualifying successes.',
    restart: 'No automatic restart or catch-up; an interrupted run requires ledger/provider reconciliation before explicit resume.',
    missingInputs: Object.freeze(missingInputs),
  });
}

function stopBeforeDispatch({ query, bounds, stats, ledgerSnapshot, baselineAllocatedCredits, nowMs, stopRequested }) {
  if (stopRequested) return 'OPERATOR_STOP_REQUESTED';
  if (nowMs >= Date.parse(bounds.deadlineAt)) return 'DEADLINE_REACHED';
  if (stats.qualifyingSuccesses >= bounds.successTarget) return 'SUCCESS_TARGET_REACHED';
  if (ledgerSnapshot.pendingAttemptCount > 0 || ledgerSnapshot.reconciliationRequired) return 'RECONCILIATION_REQUIRED';
  if (stats.unknownChargeAttempts > 0) return 'UNKNOWN_CHARGE_REQUIRES_RECONCILIATION';
  const attempts = query.pageBound * (query.retryBound + 1);
  if (stats.providerAttempts + attempts > bounds.maxAttempts) return 'ATTEMPT_CAP_REACHED';
  const reserve = query.estimatedCredits ?? null;
  const cost = reserve === null ? null : reserve;
  if (!safeInt(cost, 1)) return 'COST_ESTIMATE_UNAVAILABLE';
  const allocatedDuringRun = ledgerSnapshot.allocatedCredits - baselineAllocatedCredits;
  if (allocatedDuringRun < 0) return 'LEDGER_STATE_CHANGED';
  const runAllocated = Math.max(allocatedDuringRun, stats.actualChargedCredits);
  if (runAllocated + cost > bounds.creditCap) return 'CREDIT_CAP_REACHED';
  if (baselineAllocatedCredits + runAllocated + cost > ledgerSnapshot.limitCredits) return 'LEDGER_BUDGET_EXHAUSTED';
  if (ledgerSnapshot.remainingCredits < cost) return 'LEDGER_BUDGET_EXHAUSTED';
  return null;
}
export function createD2hRunHooks({ bounds, manifest, getLedgerSnapshot, costs, now = () => new Date(), stopRequested = () => false, persist = () => {} }) {
  if (!bounds || !manifest || typeof getLedgerSnapshot !== 'function' || !record(costs) || typeof now !== 'function' || typeof stopRequested !== 'function' || typeof persist !== 'function') throw new Error('SESSION_INVALID');
  let dispatchDenial = null;
  const snapshot = () => makeSafeLedger(getLedgerSnapshot());
  const syncManifest = (ledger = snapshot()) => {
    manifest.updatedAt = now().toISOString();
    manifest.ledger = ledger;
    persist(manifest);
  };
  function preDispatch(query) {
    const ledger = snapshot();
    const shapedQuery = { ...query, estimatedCredits: costs[query.operation] * query.pageBound * (query.retryBound + 1) };
    dispatchDenial = stopBeforeDispatch({ query: shapedQuery, bounds, stats: manifest.stats, ledgerSnapshot: ledger,
      baselineAllocatedCredits: manifest.baselineAllocatedCredits, nowMs: now().getTime(), stopRequested: stopRequested() });
    return dispatchDenial;
  }
  function onQuery(query, result) {
    if (dispatchDenial !== null) {
      const reason = dispatchDenial; dispatchDenial = null; syncManifest(); return reason;
    }
    const refs = Array.isArray(result.attemptPageReferences) ? result.attemptPageReferences : [];
    manifest.stats.lastEndpoint = query.operation;
    manifest.stats.lastObservedAt = result.acquiredAt ?? now().toISOString();
    manifest.stats.providerAttempts += refs.length;
    if (result.status === 'cached' && result.cacheHit === true) manifest.stats.cacheHits += 1;
    if (result.source === 'nansen' && result.status === 'fresh' && result.completeness === 'complete' && !result.failure && !result.storeError && !result.managerError) {
      manifest.stats.qualifyingSuccesses += result.qualifyingSuccessfulRequests;
    }
    for (const ref of refs) {
      if (safeInt(ref.chargedCredits)) manifest.stats.actualChargedCredits += ref.chargedCredits;
      else manifest.stats.unknownChargeAttempts += 1;
    }
    if (result.status === 'failed' || result.status === 'incomplete' || result.status === 'stale' || result.status === 'disabled' || result.storeError || result.managerError) {
      manifest.stats.failedQueries += 1;
    }
    const ledger = snapshot();
    syncManifest(ledger);
    if (refs.some((ref) => ref.chargedCredits === null || ref.chargedCredits === undefined) || ledger.pendingAttemptCount > 0) return 'UNKNOWN_CHARGE_REQUIRES_RECONCILIATION';
    if (ledger.reconciliationRequired) return 'LEDGER_ACCOUNTING_HALTED';
    if ((result.failure?.status ?? null) === 429 || refs.some((ref) => ref.status === 429)) return 'RATE_LIMITED';
    if (result.source !== 'nansen') return 'NON_NANSEN_SOURCE';
    if (!['fresh', 'cached'].includes(result.status) || result.completeness !== 'complete' || result.failure || result.storeError || result.managerError) return 'UNUSABLE_RESULT';
    if (stopRequested()) return 'OPERATOR_STOP_REQUESTED';
    if (now().getTime() >= Date.parse(bounds.deadlineAt)) return 'DEADLINE_REACHED';
    if (manifest.stats.qualifyingSuccesses >= bounds.successTarget) return 'SUCCESS_TARGET_REACHED';
    if (manifest.stats.providerAttempts >= bounds.maxAttempts) return 'ATTEMPT_CAP_REACHED';
    if (ledger.allocatedCredits - manifest.baselineAllocatedCredits >= bounds.creditCap) return 'CREDIT_CAP_REACHED';
    return null;
  }
  function beforeQuery() {
    if (stopRequested()) return 'OPERATOR_STOP_REQUESTED';
    if (now().getTime() >= Date.parse(bounds.deadlineAt)) return 'DEADLINE_REACHED';
    if (manifest.stats.qualifyingSuccesses >= bounds.successTarget) return 'SUCCESS_TARGET_REACHED';
    return null;
  }
  return Object.freeze({ beforeQuery, beforeDispatch: preDispatch, onQuery, onCycle() {
    manifest.stats.cycles += 1; syncManifest();
  }, snapshot });
}
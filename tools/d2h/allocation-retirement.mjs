import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const BUDGET = /^[A-Za-z0-9._-]{1,64}$/u;
const SHA = /^[0-9a-f]{64}$/u;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
export function ledgerPathDigest(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes(String.fromCharCode(0))) throw new Error('ALLOCATION_RETIREMENT_INVALID');
  return createHash('sha256').update(resolve(path).toLowerCase(), 'utf8').digest('hex');
}
export function allocationRetirementPath(privateRoot, budgetId) {
  if (typeof privateRoot !== 'string' || !isAbsolute(privateRoot) || !BUDGET.test(budgetId)) throw new Error('ALLOCATION_RETIREMENT_INVALID');
  return join(resolve(privateRoot), 'credit-allocation-retirements', budgetId + '.json');
}
export function validateAllocationRetirement(value) {
  const keys=['schemaVersion','budgetId','ledgerPathSha256','originalLimitCredits','allocatedCredits','retiredCredits','actualHttpSuccesses','unknownChargeAttempts','pendingAttempts','createdAt','reason'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.sort().join(',') ||
      value.schemaVersion !== 1 || typeof value.budgetId !== 'string' || !BUDGET.test(value.budgetId) ||
      typeof value.ledgerPathSha256 !== 'string' || !SHA.test(value.ledgerPathSha256) ||
      !integer(value.originalLimitCredits) || value.originalLimitCredits < 1 || !integer(value.allocatedCredits) ||
      !integer(value.retiredCredits) || value.retiredCredits !== value.originalLimitCredits - value.allocatedCredits ||
      !integer(value.actualHttpSuccesses) || !integer(value.unknownChargeAttempts) || !integer(value.pendingAttempts) || value.pendingAttempts !== 0 ||
      typeof value.createdAt !== 'string' || !Number.isSafeInteger(Date.parse(value.createdAt)) ||
      value.reason !== 'SUPERSEDED_BOUNDED_ALLOCATION') throw new Error('ALLOCATION_RETIREMENT_INVALID');
  return Object.freeze({ ...value });
}
export function readAllocationRetirement(privateRoot, budgetId, ledgerPath) {
  const path=allocationRetirementPath(privateRoot,budgetId);
  let value;
  try { const stat=lstatSync(path); if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096) throw new Error(); value=JSON.parse(readFileSync(path,'utf8')); }
  catch(error) { if(error&&typeof error==='object'&&error.code==='ENOENT') return null; throw new Error('ALLOCATION_RETIREMENT_INVALID'); }
  const checked=validateAllocationRetirement(value);
  if(checked.budgetId!==budgetId||checked.ledgerPathSha256!==ledgerPathDigest(ledgerPath)) throw new Error('ALLOCATION_RETIREMENT_IDENTITY_MISMATCH');
  return checked;
}
export function writeAllocationRetirement(privateRoot, value) {
  const checked=validateAllocationRetirement(value), path=allocationRetirementPath(privateRoot,checked.budgetId), directory=resolve(privateRoot,'credit-allocation-retirements');
  try { const stat=lstatSync(privateRoot); if(!stat.isDirectory()||stat.isSymbolicLink()) throw new Error(); }
  catch { throw new Error('ALLOCATION_RETIREMENT_INVALID'); }
  try { mkdirSync(directory,{mode:0o700}); } catch(error) { if(!(error&&typeof error==='object'&&error.code==='EEXIST')) throw new Error('ALLOCATION_RETIREMENT_WRITE_FAILED'); }
  try { const stat=lstatSync(directory); if(!stat.isDirectory()||stat.isSymbolicLink()) throw new Error(); } catch { throw new Error('ALLOCATION_RETIREMENT_INVALID'); }
  let fd;
  try { fd=openSync(path,'wx',0o600); writeFileSync(fd,JSON.stringify(checked,null,2)+'\n'); fsyncSync(fd); }
  catch(error) { if(error&&typeof error==='object'&&error.code==='EEXIST') throw new Error('ALLOCATION_RETIREMENT_ALREADY_EXISTS'); throw new Error('ALLOCATION_RETIREMENT_WRITE_FAILED'); }
  finally { if(fd!==undefined) closeSync(fd); }
  return path;
}

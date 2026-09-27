import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ledgerPathDigest, readAllocationRetirement, writeAllocationRetirement } from './allocation-retirement.mjs';

let root;
afterEach(() => { if (root) rmSync(root,{recursive:true,force:true}); root=undefined; });

describe('external allocation retirement', () => {
  it('writes once and blocks the retired budget without rewriting its source ledger', () => {
    root=mkdtempSync(join(tmpdir(),'ered-retirement-'));
    const ledgerPath=join(root,'old-ledger.sqlite');
    const record={ schemaVersion:1,budgetId:'old-weth-v2',ledgerPathSha256:ledgerPathDigest(ledgerPath),
      originalLimitCredits:2700,allocatedCredits:1636,retiredCredits:1064,actualHttpSuccesses:544,unknownChargeAttempts:1,pendingAttempts:0,
      createdAt:'2026-09-27T15:00:00.000Z',reason:'SUPERSEDED_BOUNDED_ALLOCATION' };
    const file=writeAllocationRetirement(root,record);
    const before=readFileSync(file,'utf8');
    expect(readAllocationRetirement(root,'old-weth-v2',ledgerPath)).toEqual(record);
    expect(() => readAllocationRetirement(root,'old-weth-v2',join(root,'different.sqlite'))).toThrow('ALLOCATION_RETIREMENT_IDENTITY_MISMATCH');
    expect(() => writeAllocationRetirement(root,record)).toThrow('ALLOCATION_RETIREMENT_ALREADY_EXISTS');
    expect(readFileSync(file,'utf8')).toBe(before);
  });

  it('rejects malformed, contradictory and pending retirement records', () => {
    root=mkdtempSync(join(tmpdir(),'ered-retirement-'));
    const ledgerPath=join(root,'old-ledger.sqlite');
    const record={ schemaVersion:1,budgetId:'old-weth-v2',ledgerPathSha256:ledgerPathDigest(ledgerPath),
      originalLimitCredits:2700,allocatedCredits:1636,retiredCredits:1064,unknownChargeAttempts:1,pendingAttempts:0,
      createdAt:'2026-09-27T15:00:00.000Z',reason:'SUPERSEDED_BOUNDED_ALLOCATION' };
    expect(() => writeAllocationRetirement(root,{...record,retiredCredits:1063})).toThrow('ALLOCATION_RETIREMENT_INVALID');
    expect(() => writeAllocationRetirement(root,{...record,pendingAttempts:1,retiredCredits:1064})).toThrow('ALLOCATION_RETIREMENT_INVALID');
  });
});

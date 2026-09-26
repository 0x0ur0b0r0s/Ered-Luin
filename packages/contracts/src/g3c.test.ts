import { describe, expect, it } from 'vitest';
import { assertG3cHeadFreshness } from './g3c.js';

const nowMs = Date.parse('2026-09-24T12:00:00.000Z');
const separatedHeads = {
  latestHeadNumber: '1000', latestHeadHash: `0x${'1'.repeat(64)}`,
  latestHeadTimestamp: nowMs / 1000,
  safeHeadNumber: '940', safeHeadHash: `0x${'2'.repeat(64)}`,
  safeHeadTimestamp: nowMs / 1000 - 120,
  finalizedHeadNumber: '550', finalizedHeadHash: `0x${'3'.repeat(64)}`,
  finalizedHeadTimestamp: nowMs / 1000 - 900,
} as const;
const finalizedSource = {
  number: '550', hash: `0x${'3'.repeat(64)}`,
  timestamp: nowMs / 1000 - 900, finality: 'finalized' as const,
};

describe('G3c purpose-specific head freshness', () => {
  it.each(['finalized', 'historical-finalized'] as const)(
    'accepts %s evidence when canonical latest, safe, and finalized heads are separated', (finality) => {
      expect(() => assertG3cHeadFreshness(separatedHeads, nowMs, {
        ...finalizedSource, finality,
      })).not.toThrow();
    },
  );
});

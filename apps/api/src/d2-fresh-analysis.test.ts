import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  G1D_FEATURE_DEFINITIONS,
  createG1DShadowEvaluator,
  initializeG1DShadowAuditStore,
  type G1DShadowAuditStore,
  type ObservationSnapshot,
} from '@ered-luin/nansen';
import { createD2FreshAnalysisService } from './d2-fresh-analysis.js';

const NOW = new Date('2026-09-25T12:00:00.000Z');
const FETCHED = new Date(NOW.getTime() - 60_000).toISOString();
let stores: G1DShadowAuditStore[] = [];
let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ered-luin-d2e-analysis-')); stores = []; });
function syntheticSnapshots(): ObservationSnapshot[] {
  return (['TOKEN_SCREENER', 'SMART_MONEY_NETFLOW'] as const).map((operation) => ({
    snapshotId: randomUUID(), cacheKey: 'ab'.repeat(32), operation,
    asset: 'BASE_PAIR', timeframe: '1h', pageBound: 1, retryBound: 0, source: 'synthetic',
    fetchedAt: FETCHED, acquiredAt: FETCHED, expiresAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    completeness: 'complete', failure: null, pageReferences: [], unavailableFields: [],
    signals: G1D_FEATURE_DEFINITIONS.filter((feature) => feature.endpoint === operation).map((feature) => ({
      signalId: randomUUID(), provider: 'synthetic', endpoint: feature.endpoint, chainId: 8453 as const,
      asset: feature.asset, metric: feature.metric, observedAt: FETCHED, fetchedAt: FETCHED,
      quality: 'COMPLETE' as const, value: '3200000000', unit: 'usd_micros' as const, provenanceId: 'synthetic-fixture-' + randomUUID(),
    })),
  }));
}
afterEach(() => { for (const store of stores) { try { store.close(); } catch { /* already closed */ } } stores = []; rmSync(root, { recursive: true, force: true }); });

describe('D2 fresh TypeSafe analysis preview', () => {
  it('previews sanitized synthetic lineage with zero credential reads and zero transport calls', () => {
    const audit = initializeG1DShadowAuditStore({ databasePath: join(root, 'g1d.sqlite'), storeId: 'd2e-preview-test', clock: () => NOW });
    stores.push(audit);
    let credentialReads = 0;
    let transportCalls = 0;
    const evaluator = createG1DShadowEvaluator({ enabled: true, apiKey: 'synthetic-test-key', auditStore: audit,
      clock: () => NOW, transport: async () => { transportCalls += 1; return { status: 200, body: new Uint8Array() }; } });
    const source = syntheticSnapshots();
    const service = createD2FreshAnalysisService({
      observations: { getLatestSnapshots: () => source }, proposal: () => null, auditStore: audit,
      analysisEnabled: false, apiKeyProvider: () => { credentialReads += 1; return 'must-not-be-read'; },
      evaluator, clock: () => NOW,
    });
    const preview = service.preview(randomUUID());
    expect(preview).toMatchObject({ status: 'UNAVAILABLE', source: 'synthetic', authority: 'NONE',
      requestsMade: 0, invocationEnabled: false, canInvoke: false, proposalMatch: 'MISSING' });
    expect(preview.missingPrerequisites).toContain('SYNTHETIC_EVIDENCE');
    expect(preview.missingPrerequisites).toContain('ANALYSIS_DISABLED');
    expect(preview.inputs).toHaveLength(2);
    expect(JSON.stringify(preview)).not.toContain('3200000000');
    expect(credentialReads).toBe(0);
    expect(transportCalls).toBe(0);
  });

  it('does not read the credential provider during a preview when the analysis gate is configured', () => {
    const audit = initializeG1DShadowAuditStore({ databasePath: join(root, 'g1d-preview-enabled.sqlite'), storeId: 'd2e-preview-enabled-test', clock: () => NOW });
    stores.push(audit);
    let credentialReads = 0;
    let transportCalls = 0;
    const service = createD2FreshAnalysisService({
      observations: { getLatestSnapshots: () => syntheticSnapshots() }, proposal: () => null, auditStore: audit,
      analysisEnabled: true, apiKeyProvider: () => { credentialReads += 1; return 'synthetic-test-key'; },
      evaluator: createG1DShadowEvaluator({ enabled: true, apiKey: 'synthetic-test-key', auditStore: audit, clock: () => NOW,
        transport: async () => { transportCalls += 1; return { status: 200, body: new Uint8Array() }; } }), clock: () => NOW,
    });
    const preview = service.preview(randomUUID());
    expect(preview).toMatchObject({ status: 'UNAVAILABLE', credentialProviderConfigured: true, canInvoke: false, requestsMade: 0 });
    expect(preview.missingPrerequisites).toContain('SYNTHETIC_EVIDENCE');
    expect(credentialReads).toBe(0);
    expect(transportCalls).toBe(0);
  });

  it('does not spend a transport call when the independent analysis gate is off', async () => {
    const audit = initializeG1DShadowAuditStore({ databasePath: join(root, 'g1d-disabled.sqlite'), storeId: 'd2e-disabled-test', clock: () => NOW });
    stores.push(audit);
    let calls = 0;
    const evaluator = createG1DShadowEvaluator({ enabled: true, apiKey: 'synthetic-test-key', auditStore: audit,
      transport: async () => { calls += 1; return { status: 200, body: new Uint8Array() }; }, clock: () => NOW });
    const service = createD2FreshAnalysisService({ observations: { getLatestSnapshots: () => syntheticSnapshots() },
      proposal: () => null, auditStore: audit, analysisEnabled: false, evaluator, clock: () => NOW });
    const result = await service.invoke({ proposalId: randomUUID(), requestHash: 'cd'.repeat(32) });
    expect(result).toMatchObject({ status: 'DISABLED', requestsMade: 0, authority: 'NONE', reason: 'ANALYSIS_DISABLED' });
    expect(calls).toBe(0);
    expect(audit.listRecent()).toHaveLength(0);
  });
});

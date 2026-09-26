import { afterEach, describe, expect, it, vi } from 'vitest';
import { d2Api, type D2ExecutionAction, type D2Runtime } from './api-client.js';

const hookHarness = vi.hoisted(() => {
  let values: unknown[] = [];
  let cursor = 0;
  let effect: (() => unknown) | undefined;
  let reference: { current: unknown } | undefined;
  return {
    reset() { values = []; cursor = 0; effect = undefined; reference = undefined; },
    beginRender() { cursor = 0; },
    useState(initial: unknown) {
      const index = cursor++;
      if (index >= values.length) values[index] = initial;
      return [values[index], (next: unknown) => {
        values[index] = typeof next === 'function' ? (next as (prior: unknown) => unknown)(values[index]) : next;
      }];
    },
    useRef(initial: unknown) {
      cursor += 1;
      reference ??= { current: initial };
      return reference;
    },
    useEffect(callback: () => unknown) { effect ??= callback; },
    runEffect() { return effect?.(); },
  };
});

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: hookHarness.useState as typeof actual.useState,
    useRef: hookHarness.useRef as typeof actual.useRef,
    useEffect: hookHarness.useEffect as typeof actual.useEffect,
  };
});

import { D2ProductionPanel } from './d2-panel.js';

const PROPOSAL_ID = '00000000-0000-4000-8000-000000000301';
const OPERATION_ID = '00000000-0000-4000-8000-000000000302';
const SESSION_ID = '00000000-0000-4000-8000-000000000303';
const STALE_HASH = '0x' + 'cd'.repeat(32);

type Node = { readonly type?: unknown; readonly props?: { readonly children?: unknown; readonly value?: unknown;
  readonly onChange?: (event: { readonly target: { readonly value: string } }) => void; readonly onClick?: () => void } };
function flatten(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (typeof value !== 'object' || value === null) return [];
  const node = value as Node;
  const rendered = typeof node.type === 'function' ? (node.type as (props: unknown) => unknown)(node.props) : node.props?.children;
  return [node, ...flatten(rendered)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (typeof value !== 'object' || value === null) return typeof value === 'string' ? value : '';
  const node = value as Node;
  if (typeof node.type === 'function') return text((node.type as (props: unknown) => unknown)(node.props));
  return text(node.props?.children);
}
function settle() { return new Promise<void>((resolve) => setTimeout(resolve, 0)); }

describe('D2 execution dashboard selection safety', () => {
  afterEach(() => hookHarness.reset());

  it('drops an exact-operation status response after the operator changes the selected proposal', async () => {
    let finishStatus!: (value: D2ExecutionAction) => void;
    const runtime: D2Runtime = {
      service: 'ered-luin-api', status: 'ok', appMode: 'PRODUCTION_READ_ONLY',
      paidNansenCallsEnabled: false, activeNansenCreditBudget: 0, liveExecutionEnabled: false,
      executionControls: { operatorAuthConfigured: true, signingEnabled: true, submissionEnabled: false, reviewedMode: false },
      nansenObservationStore: 'configured', productionEvaluation: 'configured', baseRpc: 'read_only_enabled',
      g3cStatusReader: 'configured', rpcRunBudget: null,
    };
    const api = {
      runtime: async () => runtime,
      evidence: async () => ({ source: 'nansen', label: 'PERSISTED NANSEN OBSERVATIONS', observations: [], batches: [], freshness: 'missing' }),
      operatorSession: async () => ({ configured: true, authenticated: true, expiresAt: '2026-09-24T20:00:00.000Z' }),
      executionStatus: vi.fn(() => new Promise<D2ExecutionAction>((resolve) => { finishStatus = resolve; })),
    } as unknown as typeof d2Api;
    function render() {
      hookHarness.beginRender();
      return D2ProductionPanel({ api });
    }

    let tree = render();
    hookHarness.runEffect();
    await settle();
    tree = render();

    let elements = flatten(tree);
    const labels = elements.filter((element) => element.type === 'label');
    const proposalLabel = labels.find((label) => text(label).includes('Proposal ID'));
    const operationLabel = labels.find((label) => text(label).includes('Operation ID'));
    const proposalInput = proposalLabel && flatten(proposalLabel).find((element) => element.type === 'input');
    const operationInput = operationLabel && flatten(operationLabel).find((element) => element.type === 'input');
    expect(proposalInput?.props?.onChange).toBeTypeOf('function');
    expect(operationInput?.props?.onChange).toBeTypeOf('function');
    proposalInput!.props!.onChange!({ target: { value: PROPOSAL_ID } });
    operationInput!.props!.onChange!({ target: { value: OPERATION_ID } });
    tree = render();

    elements = flatten(tree);
    const statusButton = elements.find((element) => element.type === 'button' && text(element).includes('Check exact operation status'));
    expect(statusButton?.props?.onClick).toBeTypeOf('function');
    statusButton!.props!.onClick!();
    expect(api.executionStatus).toHaveBeenCalledWith(PROPOSAL_ID, OPERATION_ID);

    tree = render();
    const updatedProposalLabel = flatten(tree).filter((element) => element.type === 'label')
      .find((label) => text(label).includes('Proposal ID'));
    const updatedProposalInput = updatedProposalLabel && flatten(updatedProposalLabel).find((element) => element.type === 'input');
    updatedProposalInput!.props!.onChange!({ target: { value: '00000000-0000-4000-8000-000000000399' } });

    finishStatus({
      proposalId: PROPOSAL_ID, executionId: PROPOSAL_ID, operationId: OPERATION_ID, sessionId: SESSION_ID,
      kind: 'SWAP', status: 'SUBMITTED', permittedAmount: '4000000', transactionHash: STALE_HASH,
      submissionAttempts: 1, receiptOutcome: null, receiptBlockNumber: null, actualFeesUsdcMicros: null, replayed: false,
    });
    await settle();
    tree = render();
    expect(text(tree)).not.toContain(STALE_HASH);
    expect(text(tree)).not.toContain('SUBMITTED');
  });
  it('renders stored G1d provenance as advisory metadata rather than approval', async () => {
    const runtime: D2Runtime = {
      service: 'ered-luin-api', status: 'ok', appMode: 'PRODUCTION_READ_ONLY',
      paidNansenCallsEnabled: false, activeNansenCreditBudget: 0, liveExecutionEnabled: false,
      executionControls: { operatorAuthConfigured: true, signingEnabled: false, submissionEnabled: false, reviewedMode: false },
      nansenObservationStore: 'configured', productionEvaluation: 'configured', baseRpc: 'disabled',
      g3cStatusReader: 'configured', rpcRunBudget: null,
    };
    const proposalResponse = {
        proposalId: PROPOSAL_ID, createdAt: '2026-09-24T18:00:00.000Z',
        intent: { intentId: PROPOSAL_ID, walletAddress: '0x1111111111111111111111111111111111111111', chainId: 8453,
          sellAsset: 'USDC', buyAsset: 'WETH', amountIn: '4000000', issuedAt: '2026-09-24T18:00:00.000Z', expiresAt: '2026-09-24T18:01:00.000Z' },
        analysis: { source: 'DETERMINISTIC_EVIDENCE_RULES', version: 'd2-rule-v1', rationale: 'Deterministic proposal rationale.',
          semanticStatus: 'OBSERVED', semanticAuthority: 'NONE', semanticHandoff: {
            status: 'OBSERVED', source: 'nansen', provider: 'typesafe-shadow', authority: 'NONE', requestedModel: 'jev-latest',
            resolvedModel: 'jev-1.13.0', questionVersion: 'g1d-analyst-review-v1', attemptId: '00000000-0000-4000-8000-000000000321',
            requestHash: 'ab'.repeat(32), answer: 0.63, advisoryRoute: 'WATCH', evidenceSignalIds: [SESSION_ID],
          } },
        evidence: { source: 'nansen', label: 'PERSISTED NANSEN OBSERVATIONS', observations: [], observationIds: [], batches: [] },
      };
    const api = {
      runtime: async () => runtime,
      evidence: async () => ({ source: 'nansen', label: 'PERSISTED NANSEN OBSERVATIONS', observations: [], batches: [], freshness: 'missing' }),
      operatorSession: async () => ({ configured: true, authenticated: true, expiresAt: null }),
      proposal: vi.fn(async () => proposalResponse),
      getProposal: vi.fn(async () => proposalResponse),
      analysisPreview: vi.fn(async (proposalId: string) => ({
        proposalId, status: 'READY', source: 'nansen', eligibility: 'ELIGIBLE', authority: 'NONE',
        requestedModel: 'jev-latest', questionVersion: 'g1d-analyst-review-v1', generatedAt: '2026-09-24T18:00:00.000Z',
        requestHash: 'de'.repeat(32), proposalMatch: 'MATCHED', invocationEnabled: true,
        credentialProviderConfigured: true, canInvoke: true, requestsMade: 0, missingPrerequisites: [],
        inputs: [{ snapshotId: SESSION_ID, operation: 'TOKEN_SCREENER', source: 'nansen', status: 'fresh',
          completeness: 'complete', fetchedAt: '2026-09-24T17:59:00.000Z', ageMs: 60_000, signalIds: [OPERATION_ID] }], features: [],
      })),
      invokeAnalysis: vi.fn(async (proposalId: string, requestHash: string) => ({
        proposalId, status: 'OBSERVED', authority: 'NONE', requestsMade: 1, approvedRequestHash: requestHash,
        recordRequestHash: requestHash, attemptId: '00000000-0000-4000-8000-000000000333', requestedModel: 'jev-latest',
        resolvedModel: 'jev-1.13.0', answer: 0.63, advisoryRoute: 'WATCH', reason: null,
      })),
    } as unknown as typeof d2Api;
    function render() { hookHarness.beginRender(); return D2ProductionPanel({ api }); }

    let tree = render();
    hookHarness.runEffect();
    await settle();
    tree = render();
    let elements = flatten(tree);
    const walletLabel = elements.filter((element) => element.type === 'label')
      .find((label) => text(label).includes('Wallet public address'));
    const walletInput = walletLabel && flatten(walletLabel).find((element) => element.type === 'input');
    walletInput!.props!.onChange!({ target: { value: '0x1111111111111111111111111111111111111111' } });
    tree = render();
    elements = flatten(tree);
    const createButton = elements.find((element) => element.type === 'button' && text(element).includes('Create proposal'));
    createButton!.props!.onClick!();
    await settle();
    tree = render();
    expect(api.proposal).toHaveBeenCalledOnce();
    expect(text(tree)).toContain('Stored TypeSafe shadow · advisory only · authority NONE');
    expect(text(tree)).toContain('jev-1.13.0');
    expect(text(tree)).toContain('WATCH');
    expect(text(tree)).toContain('Linked analysis');
    expect(text(tree)).toContain('Deterministic proposal rationale.');
    expect(text(tree)).not.toContain('approval authorized');

    elements = flatten(tree);
    const previewButton = elements.find((element) => element.type === 'button' && text(element).includes('Preview exact evidence'));
    previewButton!.props!.onClick!();
    await settle();
    tree = render();
    expect(api.analysisPreview).toHaveBeenCalledOnce();
    expect(api.analysisPreview).toHaveBeenCalledWith(PROPOSAL_ID);
    expect(text(tree)).toContain('EXACT PACKET HASH');
    expect(text(tree)).toContain('de'.repeat(32));
    const invokeButton = flatten(tree).find((element) => element.type === 'button' && text(element).includes('Request one advisory judgment'));
    invokeButton!.props!.onClick!();
    await settle();
    tree = render();
    expect(api.invokeAnalysis).toHaveBeenCalledOnce();
    expect(api.invokeAnalysis).toHaveBeenCalledWith(PROPOSAL_ID, 'de'.repeat(32));
    expect(api.getProposal).toHaveBeenCalledWith(PROPOSAL_ID);
    expect(text(tree)).toContain('OBSERVED · 0.630 · WATCH');
    expect(text(tree)).toContain('REQUESTS / AUTHORITY');
  });
});
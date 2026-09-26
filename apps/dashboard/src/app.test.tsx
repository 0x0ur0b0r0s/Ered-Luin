import { d1PaperIntentRecordSchema, d1ProposalSchema } from '@ered-luin/contracts';
import type { D1G3cFixture, D1Proposal, D1Scenario } from '@ered-luin/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { d1Api, type D1Health } from './api-client.js';

const hookHarness = vi.hoisted(() => {
  let states: unknown[] = [];
  let stateIndex = 0;
  let effects: (() => unknown)[] = [];
  let cleanups: (() => void)[] = [];

  return {
    reset() {
      states = [];
      stateIndex = 0;
      cleanups.forEach((cleanup) => cleanup());
      cleanups = [];
      effects = [];
    },
    beginRender() {
      stateIndex = 0;
    },
    useState(initial: unknown) {
      const index = stateIndex;
      stateIndex += 1;
      if (index >= states.length) states[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [states[index], (next: unknown) => {
        states[index] = typeof next === 'function'
          ? (next as (previous: unknown) => unknown)(states[index])
          : next;
      }];
    },
    useEffect(callback: () => unknown) {
      effects.push(callback);
    },
    useMemo<T>(factory: () => T): T {
      return factory();
    },
    runEffect() {
      effects.forEach((callback) => {
        const cleanup = callback();
        if (typeof cleanup === 'function') cleanups.push(cleanup as () => void);
      });
    },
  };
});

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: hookHarness.useState as typeof actual.useState,
    useEffect: hookHarness.useEffect as typeof actual.useEffect,
    useMemo: hookHarness.useMemo as typeof actual.useMemo,
  };
});

import { App } from './app.js';

const HEALTH = {
  service: 'ered-luin-api', status: 'ok', executionMode: 'PAPER',
  paidNansenCallsEnabled: false, activeNansenCreditBudget: 0, liveExecutionEnabled: false,
} satisfies D1Health;
const SCENARIOS = ['ALLOW', 'RESIZE', 'BLOCK', 'REVIEW'].map((id) => ({
  id, title: `${id} path`, description: `Synthetic ${id.toLowerCase()} evidence scenario.`,
})) as D1Scenario[];
const NOW = '2026-09-24T12:00:00.000Z';
const INTENT_IDS: Record<D1Scenario['id'], string> = {
  ALLOW: '00000000-0000-4000-8000-000000000001',
  RESIZE: '00000000-0000-4000-8000-000000000002',
  BLOCK: '00000000-0000-4000-8000-000000000003',
  REVIEW: '00000000-0000-4000-8000-000000000004',
};

function proposalFixture(scenarioId: D1Scenario['id'], expiresAt = new Date(Date.now() + 60_000).toISOString()): D1Proposal {
  const intentId = INTENT_IDS[scenarioId];
  const signalId = `00000000-0000-4000-8000-00000000010${Object.keys(INTENT_IDS).indexOf(scenarioId) + 1}`;
  return d1ProposalSchema.parse({
    proposalId: intentId,
    scenarioId,
    createdAt: NOW,
    intent: {
      intentId, chainId: 8453, walletAddress: '0x1111111111111111111111111111111111111111',
      sellAsset: 'USDC', buyAsset: 'WETH', amountIn: '4000000',
      issuedAt: NOW, expiresAt,
    },
    analysis: {
      source: 'DETERMINISTIC_REPLAY', version: 'd1-rule-v1',
      rationale: `${scenarioId} proposal rationale from synthetic evidence.`,
      semantic: {
        provider: 'none', status: 'NOT_CONFIGURED', authority: 'NONE', advisoryRoute: 'STORE',
        answer: null, questionVersion: null, requestsMade: 0,
      },
    },
    evidence: {
      label: 'SYNTHETIC FIXTURE — NOT MARKET EVIDENCE', source: 'synthetic', observationIds: [signalId],
      observations: [{
        signalId, provider: 'synthetic', endpoint: 'SMART_MONEY_NETFLOW', chainId: 8453,
        asset: 'WETH', metric: 'net_flow_1h_usd', observedAt: NOW, fetchedAt: NOW,
        quality: 'COMPLETE', value: scenarioId === 'BLOCK' ? '-2500000' : '2500000',
        unit: 'usd_micros', provenanceId: `synthetic:dashboard-test:${scenarioId}`,
      }],
      batches: [{
        operation: 'SMART_MONEY_NETFLOW', status: 'fresh', source: 'synthetic', completeness: 'complete',
        fetchedAt: NOW, acquiredAt: NOW, ageMs: 0, observationIds: [signalId],
      }],
    },
  });
}

function paperRecord(scenarioId: D1Scenario['id'] = 'ALLOW') {
  const intentId = INTENT_IDS[scenarioId];
  const signalId = `00000000-0000-4000-8000-00000000010${Object.keys(INTENT_IDS).indexOf(scenarioId) + 1}`;
  return d1PaperIntentRecordSchema.parse({
    intent: {
      intentId, chainId: 8453, walletAddress: '0x1111111111111111111111111111111111111111',
      sellAsset: 'USDC', buyAsset: 'WETH', amountIn: '4000000',
      issuedAt: NOW, expiresAt: '2026-09-25T12:00:00.000Z',
    },
    decision: {
      decisionId: `00000000-0000-4000-8000-00000000020${Object.keys(INTENT_IDS).indexOf(scenarioId) + 1}`,
      intentId, status: 'ALLOW', evaluatedAt: NOW, policyVersion: 'g2-test-v1',
      requestedAmountIn: '4000000', approvedAmountIn: '4000000', reasons: [],
    },
    execution: {
      intentId, mode: 'PAPER', status: 'SIMULATED', updatedAt: NOW,
      transactionHash: null, failureCode: null,
    },
    signalIds: [signalId], signalSource: 'synthetic', quoteSource: 'synthetic', reservationId: null,
  });
}

function createApi(overrides: Partial<typeof d1Api> = {}) {
  const defaults = {
    health: vi.fn(async () => HEALTH),
    scenarios: vi.fn(async () => SCENARIOS),
    proposal: vi.fn(async (scenarioId: D1Scenario['id']) => proposalFixture(scenarioId)),
    evaluate: vi.fn(async (proposalId: string) => {
      const scenarioId = (Object.entries(INTENT_IDS).find(([, intentId]) => intentId === proposalId)?.[0]
        ?? 'ALLOW') as D1Scenario['id'];
      return { record: paperRecord(scenarioId), replayed: false };
    }),
    intent: vi.fn(async (intentId: string) => {
      const scenarioId = (Object.entries(INTENT_IDS).find(([, id]) => id === intentId)?.[0]
        ?? 'ALLOW') as D1Scenario['id'];
      return paperRecord(scenarioId);
    }),
    g3cStatus: vi.fn(async (): Promise<D1G3cFixture> => {
      throw new Error('G3c fixture is not needed in this component test.');
    }),
  };
  return { ...defaults, ...overrides } as typeof defaults;
}

type RenderNode = { readonly type?: unknown; readonly props?: Record<string, unknown> };
function nodes(tree: unknown, found: RenderNode[] = []): RenderNode[] {
  if (Array.isArray(tree)) {
    tree.forEach((child) => nodes(child, found));
  } else if (typeof tree === 'object' && tree !== null && 'type' in tree && 'props' in tree) {
    const element = tree as RenderNode;
    found.push(element);
    nodes(element.props?.children, found);
  }
  return found;
}
function textOf(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(' ');
  if (typeof value === 'object' && value !== null && 'props' in value) {
    return textOf((value as RenderNode).props?.children);
  }
  return '';
}
function buttons(tree: unknown): RenderNode[] {
  return nodes(tree).filter((node) => node.type === 'button');
}
function scenarioButton(tree: unknown, scenarioId: D1Scenario['id']): RenderNode {
  const button = buttons(tree).find((node) =>
    String(node.props?.className ?? '').includes('scenario-card') && textOf(node.props?.children).includes(`${scenarioId} path`));
  if (!button) throw new Error(`No rendered scenario button for ${scenarioId}.`);
  return button;
}
function actionButton(tree: unknown, label: string): RenderNode {
  const button = buttons(tree).find((node) => textOf(node.props?.children).includes(label));
  if (!button) throw new Error(`No rendered action button containing ${label}.`);
  return button;
}
function click(node: RenderNode): unknown {
  if (node.props?.disabled === true) return false;
  const handler = node.props?.onClick;
  if (typeof handler !== 'function') throw new Error('Rendered button has no click handler.');
  return handler();
}
function render(api: ReturnType<typeof createApi>) {
  hookHarness.beginRender();
  return App({ api: api as unknown as typeof d1Api });
}
async function mount(api: ReturnType<typeof createApi>) {
  hookHarness.reset();
  let tree = render(api);
  hookHarness.runEffect();
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  tree = render(api);
  return {
    get tree() { return tree; },
    refresh() { tree = render(api); return tree; },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => { hookHarness.reset(); vi.useRealTimers(); });

describe('D1 dashboard scenario-bound async flow', () => {
  it('shows the proposal countdown and requires an explicit rebuild after expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const expiresAt = new Date(Date.parse(NOW) + 1_500).toISOString();
    const api = createApi({ proposal: vi.fn(async () => proposalFixture('ALLOW', expiresAt)) });
    const screen = await mount(api);

    await click(actionButton(screen.tree, 'Build proposal'));
    screen.refresh();
    expect(textOf(screen.tree)).toMatch(/Proposal expires in\s+2\s+seconds/u);
    expect(actionButton(screen.tree, 'Run firewall').props?.disabled).toBe(false);

    vi.advanceTimersByTime(1_000);
    screen.refresh();
    expect(textOf(screen.tree)).toMatch(/Proposal expires in\s+1\s+second/u);
    vi.advanceTimersByTime(1_000);
    screen.refresh();
    expect(textOf(screen.tree)).toContain('This proposal expired');
    expect(textOf(screen.tree)).toContain('Rebuild proposal before running the firewall');
    expect(actionButton(screen.tree, 'Run firewall').props?.disabled).toBe(true);
    expect(actionButton(screen.tree, 'Rebuild proposal').props?.disabled).toBe(false);
  });

  it('locks scenario selection until proposal creation completes', async () => {
    const proposalRequest = deferred<D1Proposal>();
    const api = createApi({ proposal: vi.fn(() => proposalRequest.promise) });
    const screen = await mount(api);

    const pending = click(actionButton(screen.tree, 'Build proposal')) as Promise<void>;
    screen.refresh();
    expect(buttons(screen.tree).filter((button) =>
      String(button.props?.className ?? '').includes('scenario-card')).every((button) => button.props?.disabled === true)).toBe(true);
    expect(click(scenarioButton(screen.tree, 'BLOCK'))).toBe(false);
    screen.refresh();
    expect(scenarioButton(screen.tree, 'ALLOW').props?.['aria-pressed']).toBe(true);
    expect(scenarioButton(screen.tree, 'BLOCK').props?.['aria-pressed']).toBe(false);

    proposalRequest.resolve(proposalFixture('ALLOW'));
    await pending;
    screen.refresh();
    expect(api.proposal).toHaveBeenCalledWith('ALLOW');
    expect(textOf(screen.tree)).toContain('ALLOW proposal rationale from synthetic evidence.');
    expect(scenarioButton(screen.tree, 'ALLOW').props?.['aria-pressed']).toBe(true);
  });

  it('keeps selection locked through evaluation and persisted audit retrieval', async () => {
    const evaluation = deferred<Awaited<ReturnType<typeof d1Api.evaluate>>>();
    const retrieval = deferred<Awaited<ReturnType<typeof d1Api.intent>>>();
    const api = createApi({
      evaluate: vi.fn(() => evaluation.promise),
      intent: vi.fn(() => retrieval.promise),
    });
    const screen = await mount(api);
    await click(actionButton(screen.tree, 'Build proposal'));
    screen.refresh();

    const pending = click(actionButton(screen.tree, 'Run firewall')) as Promise<void>;
    screen.refresh();
    expect(scenarioButton(screen.tree, 'BLOCK').props?.disabled).toBe(true);
    expect(click(scenarioButton(screen.tree, 'BLOCK'))).toBe(false);
    screen.refresh();
    expect(scenarioButton(screen.tree, 'ALLOW').props?.['aria-pressed']).toBe(true);

    evaluation.resolve({ record: paperRecord('ALLOW'), replayed: false });
    await Promise.resolve();
    expect(api.intent).toHaveBeenCalledWith(INTENT_IDS.ALLOW);
    screen.refresh();
    expect(scenarioButton(screen.tree, 'BLOCK').props?.disabled).toBe(true);
    expect(click(scenarioButton(screen.tree, 'BLOCK'))).toBe(false);

    retrieval.resolve(paperRecord('ALLOW'));
    await pending;
    screen.refresh();
    expect(api.evaluate).toHaveBeenCalledWith(INTENT_IDS.ALLOW);
    expect(textOf(screen.tree)).toContain('ALLOW proposal rationale from synthetic evidence.');
    expect(textOf(screen.tree)).toContain(INTENT_IDS.ALLOW);
    expect(textOf(screen.tree)).toContain('Retrieved from paper store');
    expect(scenarioButton(screen.tree, 'ALLOW').props?.['aria-pressed']).toBe(true);
  });

  it('clears the completed proposal and audit when switching scenarios', async () => {
    const api = createApi();
    const screen = await mount(api);
    await click(actionButton(screen.tree, 'Build proposal'));
    screen.refresh();
    await click(actionButton(screen.tree, 'Run firewall'));
    screen.refresh();
    expect(textOf(screen.tree)).toContain(INTENT_IDS.ALLOW);
    expect(textOf(screen.tree)).toContain('ALLOW proposal rationale from synthetic evidence.');

    expect(click(scenarioButton(screen.tree, 'BLOCK'))).not.toBe(false);
    screen.refresh();
    expect(scenarioButton(screen.tree, 'BLOCK').props?.['aria-pressed']).toBe(true);
    expect(textOf(screen.tree)).not.toContain('ALLOW proposal rationale from synthetic evidence.');
    expect(textOf(screen.tree)).not.toContain('Retrieved from paper store');
    expect(nodes(screen.tree).some((node) => textOf(node.props?.children).includes('Audit record'))).toBe(false);

    await click(actionButton(screen.tree, 'Build proposal'));
    screen.refresh();
    expect(api.proposal).toHaveBeenLastCalledWith('BLOCK');
    expect(textOf(screen.tree)).toContain('BLOCK proposal rationale from synthetic evidence.');
  });

  it('cleans up failed requests and permits a valid retry', async () => {
    const proposal = vi.fn(async (scenarioId: D1Scenario['id']) => proposalFixture(scenarioId));
    proposal.mockRejectedValueOnce(new Error('temporary proposal failure'));
    const intent = vi.fn(async () => paperRecord('ALLOW'));
    intent.mockRejectedValueOnce(new Error('temporary audit retrieval failure'));
    const api = createApi({ proposal, intent });
    const screen = await mount(api);

    await click(actionButton(screen.tree, 'Build proposal'));
    screen.refresh();
    expect(textOf(screen.tree)).toContain('temporary proposal failure');
    expect(scenarioButton(screen.tree, 'BLOCK').props?.disabled).toBe(false);
    expect(actionButton(screen.tree, 'Build proposal').props?.disabled).toBe(false);

    await click(actionButton(screen.tree, 'Build proposal'));
    screen.refresh();
    expect(textOf(screen.tree)).not.toContain('temporary proposal failure');
    expect(textOf(screen.tree)).toContain('ALLOW proposal rationale from synthetic evidence.');

    await click(actionButton(screen.tree, 'Run firewall'));
    screen.refresh();
    expect(textOf(screen.tree)).toContain('temporary audit retrieval failure');
    expect(scenarioButton(screen.tree, 'BLOCK').props?.disabled).toBe(false);
    expect(actionButton(screen.tree, 'Run firewall').props?.disabled).toBe(false);

    await click(actionButton(screen.tree, 'Run firewall'));
    screen.refresh();
    expect(textOf(screen.tree)).not.toContain('temporary audit retrieval failure');
    expect(textOf(screen.tree)).toContain('Retrieved from paper store');
    expect(api.proposal).toHaveBeenCalledTimes(2);
    expect(api.evaluate).toHaveBeenCalledTimes(2);
    expect(api.intent).toHaveBeenCalledTimes(2);
  });
});
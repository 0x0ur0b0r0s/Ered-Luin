import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keccak256, parseTransaction, stringToHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  canonicalJson, g3cStatusResponseSchema, normalizedSignalSchema, type D2Runtime, type ExecutionTransactionEnvelope, type G3bUnsignedTransaction,
} from '@ered-luin/contracts';
import type { ObservationSnapshot } from '@ered-luin/nansen';
import { initializeD2AuditStore, openD2AuditStore } from './d2-audit-store.js';
import { createD2ProductionService } from './d2-production.js';
import { createD2ExecutionService } from './d2-execution.js';
import { createSyntheticIsolatedG3cSigner } from './g3c-signer-client.js';
import { createApiApp } from './api.js';
import { createD2BrowserExecutionService } from './d2-browser-execution.js';
import { LocalOperatorAuthenticator } from './operator-auth.js';
import { BASE_TOKENS, BASE_UNISWAP_V3 } from './base-allowlist.js';
import { BaseD2PolicyProvider } from './d2-base-provider.js';
import { createD2G3cGateway } from './d2-g3c-gateway.js';
import { ExecutionStore } from './execution-store.js';
import { G3cExecutionStore } from './g3c-execution-store.js';
import { createSyntheticG3cEvidenceAuthority } from './g3c-evidence.js';
import { createBaseReadOnlyProvider } from './g3c-base-provider.js';
import { initializePaperStore, openPaperStore } from './paper-store.js';
import { DEFAULT_D2_RPC_MAX_REQUESTS, DEFAULT_D2_RPC_RECOVERY_RESERVE, D2B_APPROVAL_SWAP_REQUIRED_RECOVERY_REQUESTS, D2B_APPROVAL_SWAP_REQUIRED_REGULAR_REQUESTS, D2B_DIRECT_SWAP_REQUIRED_RECOVERY_REQUESTS, D2B_DIRECT_SWAP_REQUIRED_REGULAR_REQUESTS, RpcRunBudget } from './rpc-budget.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const NOW = new Date('2026-09-24T12:00:00.000Z');
const SESSION_ID = '00000000-0000-4000-8000-000000000321';
const SUBMITTED_HASH = ('0x' + 'ab'.repeat(32)) as Hex;
const LATEST_BLOCK = 1000n;
const SAFE_BLOCK = 997n;
const FINALIZED_BLOCK = 980n;
const RECEIPT_BLOCK = 970n;
const QUOTE_PRICE = (1n << 96n) / 20_000n;
const RUNTIME: D2Runtime = {
  service: 'ered-luin-api', status: 'ok', appMode: 'PRODUCTION_READ_ONLY',
  paidNansenCallsEnabled: false, activeNansenCreditBudget: 0, liveExecutionEnabled: false,
  executionControls: { operatorAuthConfigured: true, signingEnabled: false, submissionEnabled: false, reviewedMode: false, browserWalletEnabled: false },
  nansenObservationStore: 'configured', productionEvaluation: 'configured',
  baseRpc: 'read_only_enabled', g3cStatusReader: 'configured', rpcRunBudget: null,
};

function hashFor(number: bigint): Hex { return ('0x' + number.toString(16).padStart(64, '0')) as Hex; }
function word(value: bigint): string { return value.toString(16).padStart(64, '0'); }
function addressWord(value: string): string { return value.toLowerCase().replace(/^0x/u, '').padStart(64, '0'); }
function selector(signature: string): string { return keccak256(stringToHex(signature)).slice(0, 10).toLowerCase(); }
function snapshots(netflowValue = '1000000'): readonly ObservationSnapshot[] {
  const fetchedAt = new Date(NOW.getTime() - 1_000).toISOString();
  const acquiredAt = new Date(Date.parse(fetchedAt) + 1_000).toISOString();
  const expiresAt = new Date(Date.parse(fetchedAt) + 10 * 60_000).toISOString();
  const signal = (endpoint: 'TOKEN_SCREENER' | 'SMART_MONEY_NETFLOW', asset: 'USDC' | 'WETH',
    metric: string, value: string, index: number) => normalizedSignalSchema.parse({
    signalId: '00000000-0000-4000-8000-0000000003' + String(index).padStart(2, '0'),
    provider: 'nansen', endpoint, chainId: 8453, asset, metric,
    observedAt: acquiredAt, fetchedAt, quality: 'COMPLETE', value, unit: 'usd_micros',
    provenanceId: 'offline-test-only:synthetic-value',
  });
  const signals = [
    signal('TOKEN_SCREENER', 'USDC', 'price_usd', '1000000', 1),
    signal('TOKEN_SCREENER', 'WETH', 'price_usd', '2500000000', 2),
    signal('SMART_MONEY_NETFLOW', 'WETH', 'net_flow_1h_usd', netflowValue, 3),
  ];
  const group = (operation: ObservationSnapshot['operation'], asset: ObservationSnapshot['asset'],
    members: readonly ObservationSnapshot['signals'][number][], index: number): ObservationSnapshot => ({
    snapshotId: '00000000-0000-4000-8000-0000000004' + String(index).padStart(2, '0'),
    cacheKey: String(index).padStart(64, '0'), operation, asset, timeframe: '1h', pageBound: 1, retryBound: 0,
    source: 'nansen', fetchedAt, acquiredAt, expiresAt, completeness: 'complete', failure: null,
    pageReferences: [{ attemptId: 'offline-d2-integration-' + index, status: 200,
      providerRequestId: 'synthetic-test-' + index, chargedCredits: 0, page: 1, received: true, retry: 0 }],
    unavailableFields: [], signals: members,
  });
  return [group('TOKEN_SCREENER', 'BASE_PAIR', signals.slice(0, 2), 1),
    group('SMART_MONEY_NETFLOW', 'WETH', [signals[2]!], 2)];
}

function mockProductionTransport(walletAddress: string = WALLET, initialAllowance = 10_000_000n) {
  const calls: string[] = [];
  let failFinalizedAccount = false;
  let allowanceAtomic = initialAllowance;
  let receiptStatus = '0x1';
  let pendingNonce = 0n;
  const submissions = new Map<string, { readonly raw: Hex; readonly nonce: bigint; readonly transaction?: G3bUnsignedTransaction }>();
  const signatures = {
    getPool: selector('getPool(address,address,uint24)'),
    token0: selector('token0()'),
    token1: selector('token1()'),
    fee: selector('fee()'),
    tickSpacing: selector('tickSpacing()'),
    factory: selector('factory()'),
    balanceOf: selector('balanceOf(address)'),
    allowance: selector('allowance(address,address)'),
    quote: selector('quoteExactInputSingle((address,address,uint256,uint24,uint160))'),
    slot0: selector('slot0()'),
    getL1FeeUpperBound: selector('getL1FeeUpperBound(uint256)'),
    getL1Fee: selector('getL1Fee(bytes)'),
    getOperatorFee: selector('getOperatorFee(uint256)'),
  };
  const baseFee = 100_000_000n;
  const respond = (request: { readonly id: unknown; readonly method: string; readonly params?: readonly unknown[] }) => {
    calls.push(request.method);
    const params = request.params ?? [];
    if (request.method === 'eth_chainId') return { jsonrpc: '2.0', id: request.id, result: '0x2105' };
    if (request.method === 'eth_getCode') return { jsonrpc: '2.0', id: request.id, result: '0x6000' };
    if (request.method === 'eth_getBalance') return { jsonrpc: '2.0', id: request.id, result: '0x11c37937e08000' };
    if (request.method === 'eth_getTransactionCount') return { jsonrpc: '2.0', id: request.id, result: '0x' + pendingNonce.toString(16) };
    if (request.method === 'eth_getBlockByNumber') {
      const tag = String(params[0]);
      const number = tag === 'latest' ? LATEST_BLOCK : tag === 'safe' ? SAFE_BLOCK :
        tag === 'finalized' ? FINALIZED_BLOCK : BigInt(tag);
      const timestamp = BigInt(Math.floor(NOW.getTime() / 1000)) - (LATEST_BLOCK - number) * 2n;
      return { jsonrpc: '2.0', id: request.id, result: {
        number: '0x' + number.toString(16), hash: hashFor(number), parentHash: hashFor(number - 1n),
        nonce: '0x0000000000000000', sha3Uncles: hashFor(0n), logsBloom: '0x' + '00'.repeat(256),
        transactionsRoot: hashFor(1n), stateRoot: hashFor(2n), receiptsRoot: hashFor(3n),
        miner: '0x0000000000000000000000000000000000000000', difficulty: '0x0', totalDifficulty: '0x0',
        extraData: '0x', size: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0',
        timestamp: '0x' + timestamp.toString(16), transactions: [], uncles: [],
        baseFeePerGas: '0x' + baseFee.toString(16),
      } };
    }
    if (request.method === 'eth_feeHistory') return { jsonrpc: '2.0', id: request.id, result: {
      oldestBlock: '0x3e8', baseFeePerGas: ['0x' + baseFee.toString(16), '0x' + baseFee.toString(16)],
      gasUsedRatio: [0.5], reward: [['0x05f5e100']],
    } };
    if (request.method === 'eth_maxPriorityFeePerGas') return { jsonrpc: '2.0', id: request.id, result: '0x05f5e100' };
    if (request.method === 'eth_gasPrice') return { jsonrpc: '2.0', id: request.id, result: '0x05f5e100' };
    if (request.method === 'eth_estimateGas') return { jsonrpc: '2.0', id: request.id, result: '0x186a0' };
    if (request.method === 'eth_call') {
      const call = params[0] as { readonly to?: string; readonly data?: string; readonly input?: string };
      const blockTag = String(params[1]);
      const data = (call.data ?? call.input ?? '0x').toLowerCase();
      const sig = data.slice(0, 10);
      if (failFinalizedAccount && blockTag === '0x3d4' &&
          (sig === signatures.balanceOf || sig === signatures.allowance)) {
        return { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'synthetic finalized account read failure' } };
      }
      let result = '0x';
      if (sig === signatures.getPool) result = '0x' + addressWord(BASE_UNISWAP_V3.pool);
      else if (sig === signatures.token0) result = '0x' + addressWord(BASE_TOKENS.WETH);
      else if (sig === signatures.token1) result = '0x' + addressWord(BASE_TOKENS.USDC);
      else if (sig === signatures.fee) result = '0x' + word(500n);
      else if (sig === signatures.tickSpacing) result = '0x' + word(10n);
      else if (sig === signatures.factory) result = '0x' + addressWord(BASE_UNISWAP_V3.factory);
      else if (sig === signatures.balanceOf) {
        result = '0x' + word(call.to?.toLowerCase() === BASE_TOKENS.USDC.toLowerCase() ? 10_000_000n : 0n);
      } else if (sig === signatures.allowance) result = '0x' + word(allowanceAtomic);
      else if (sig === signatures.quote) {
        const tokenIn = '0x' + data.slice(10 + 24, 10 + 64);
        const amountIn = BigInt('0x' + data.slice(10 + 64 * 2, 10 + 64 * 3));
        const amountOut = tokenIn.toLowerCase() === BASE_TOKENS.WETH.toLowerCase()
          ? amountIn / 400_000_000n : amountIn * 400_000_000n;
        result = '0x' + word(amountOut) + word(QUOTE_PRICE) + word(0n) + word(100_000n);
      } else if (sig === signatures.slot0) {
        result = '0x' + word(QUOTE_PRICE) + word(0n) + word(0n) + word(0n) + word(0n) + word(0n) + word(1n);
      } else if (sig === signatures.getL1FeeUpperBound || sig === signatures.getL1Fee ||
          sig === signatures.getOperatorFee) result = '0x' + word(1_000n);
      return { jsonrpc: '2.0', id: request.id, result };
    }
    if (request.method === 'eth_getTransactionByHash') {
      const txHash = String(params[0]).toLowerCase();
      const submitted = submissions.get(txHash);
      if (!submitted) return { jsonrpc: '2.0', id: request.id, result: null };
      const parsed: Record<string, unknown> = submitted.transaction ? {
        chainId: submitted.transaction.chainId, from: submitted.transaction.from, to: submitted.transaction.to,
        input: submitted.transaction.data, nonce: Number(submitted.transaction.nonce), gas: BigInt(submitted.transaction.gasLimit),
        value: BigInt(submitted.transaction.valueWei), maxFeePerGas: BigInt(submitted.transaction.maxFeePerGasWei),
        maxPriorityFeePerGas: BigInt(submitted.transaction.maxPriorityFeePerGasWei), accessList: [],
        r: '0x' + '01'.padStart(64, '0'), s: '0x' + '01'.padStart(64, '0'), v: 0n, yParity: 0,
      } : parseTransaction(submitted.raw) as unknown as Record<string, unknown>;
      const quantity = (value: unknown) => typeof value === 'bigint' || typeof value === 'number'
        ? '0x' + BigInt(value).toString(16) : value;
      return { jsonrpc: '2.0', id: request.id, result: {
        blockHash: null, blockNumber: null, from: parsed.from ?? walletAddress, gas: quantity(parsed.gas), hash: String(params[0]),
        input: parsed.input ?? parsed.data ?? '0x', nonce: quantity(parsed.nonce), to: parsed.to, transactionIndex: null,
        value: quantity(parsed.value ?? 0n), type: '0x2', chainId: quantity(parsed.chainId),
        maxFeePerGas: quantity(parsed.maxFeePerGas), maxPriorityFeePerGas: quantity(parsed.maxPriorityFeePerGas),
        accessList: parsed.accessList ?? [], r: parsed.r, s: parsed.s, v: quantity(parsed.v), yParity: quantity(parsed.yParity),
      } };
    }
    if (request.method === 'eth_getTransactionReceipt') {
      const txHash = String(params[0]).toLowerCase();
      const submitted = submissions.get(txHash);
      return { jsonrpc: '2.0', id: request.id, result: submitted ? {
        transactionHash: String(params[0]), transactionIndex: '0x0', blockHash: hashFor(RECEIPT_BLOCK),
        blockNumber: '0x' + RECEIPT_BLOCK.toString(16), from: submitted.transaction?.from ?? walletAddress, to: submitted.transaction?.to ?? BASE_UNISWAP_V3.router,
        cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x0bebc200',
        status: receiptStatus, logs: [], logsBloom: '0x' + '00'.repeat(256), type: '0x2',
      } : null };
    }
    if (request.method === 'eth_getRawTransactionByHash') {
      const submitted = submissions.get(String(params[0]).toLowerCase());
      return { jsonrpc: '2.0', id: request.id, result: submitted?.raw ?? null };
    }
    return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unsupported synthetic RPC method' } };
  };
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    const parsed = JSON.parse(body) as { readonly id: unknown; readonly method: string; readonly params?: readonly unknown[] } |
      readonly { readonly id: unknown; readonly method: string; readonly params?: readonly unknown[] }[];
    const result = Array.isArray(parsed)
      ? (parsed as readonly { readonly id: unknown; readonly method: string; readonly params?: readonly unknown[] }[]).map(respond)
      : respond(parsed as { readonly id: unknown; readonly method: string; readonly params?: readonly unknown[] });
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return {
    calls, fetcher,
    setFailFinalizedAccount(value: boolean) { failFinalizedAccount = value; },
    setAllowance(value: bigint) { allowanceAtomic = value; },
    setReceiptStatus(value: '0x0' | '0x1') { receiptStatus = value; },
    allowance() { return allowanceAtomic; },
    setKnownSubmission(hash: Hex, raw: Hex, nonce: bigint, transaction?: G3bUnsignedTransaction) {
      submissions.set(hash.toLowerCase(), { raw, nonce, ...(transaction ? { transaction } : {}) });
      if (pendingNonce <= nonce) pendingNonce = nonce + 1n;
    },
    setSubmission(raw: Hex) {
      const hash = keccak256(raw);
      submissions.set(hash.toLowerCase(), { raw, nonce: pendingNonce });
      pendingNonce += 1n;
      return hash;
    },
  };
}

function setup(options: { readonly d2b?: boolean; readonly initialAllowance?: bigint;
  readonly signingEnabled?: boolean; readonly submissionEnabled?: boolean; readonly rpcMaxRequests?: number; readonly rpcRecoveryReserve?: number; readonly browserWallet?: boolean; readonly netflowValue?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ered-luin-d2-provider-integration-'));
  let currentTimeMs = NOW.getTime();
  const clock = () => new Date(currentTimeMs);
  const walletPrivateKey = options.d2b ? generatePrivateKey() : null;
  const walletAddress = walletPrivateKey ? privateKeyToAccount(walletPrivateKey).address : WALLET;
  const paperPath = join(directory, 'paper.sqlite');
  const paper = initializePaperStore({ databasePath: paperPath, clock });
  const execution = new ExecutionStore(paper);
  execution.setKillSwitch(false, 'offline D2 provider integration');
  const authority = createSyntheticG3cEvidenceAuthority(clock);
  const realG3c = new G3cExecutionStore(execution, authority.trust, options.d2b ? { allowTestSigning: true, allowTestBroadcast: true } : {}, clock);
  const budget = new RpcRunBudget(randomUUID(), options.rpcMaxRequests ?? DEFAULT_D2_RPC_MAX_REQUESTS, options.rpcRecoveryReserve ?? DEFAULT_D2_RPC_RECOVERY_RESERVE);
  const transport = mockProductionTransport(walletAddress, options.initialAllowance ?? 10_000_000n);
  vi.stubGlobal('fetch', transport.fetcher);
  const provider = createBaseReadOnlyProvider({
    rpcUrl: 'https://unused.invalid', authority, clock, rpcBudget: budget,
  });

  let recovery: {
    readonly workflow: Record<string, unknown>;
    readonly executionId: string;
    readonly operationId: string;
    readonly status: 'PENDING' | 'CONFIRMED';
    readonly reserved: boolean;
    readonly receipt: unknown;
    readonly fees: string | null;
    readonly receiptWrites: number;
  } | null = null;
  const g3cFacade = {
    startSession(input: Parameters<G3cExecutionStore['startSession']>[0]) { return realG3c.startSession(input); },
    getSession(sessionId: string) { return realG3c.getSession(sessionId); },
    getParent(executionId: string) { return realG3c.getParent(executionId); },
    assertIntentFresh(executionId: string) { return realG3c.assertIntentFresh(executionId); },
    refreshSessionSnapshot(sessionId: string, snapshot: Parameters<G3cExecutionStore['refreshSessionSnapshot']>[1], reason: string) {
      return realG3c.refreshSessionSnapshot(sessionId, snapshot, reason);
    },
    validateSimulation(input: Parameters<G3cExecutionStore['validateSimulation']>[0]) {
      return realG3c.validateSimulation(input);
    },
    getWorkflow(operationId: string) {
      if (recovery?.operationId === operationId) return recovery.workflow;
      return realG3c.getWorkflow(operationId);
    },
    recordReceipt(operationId: string, receipt: Parameters<G3cExecutionStore['recordReceipt']>[1],
      settlement: Parameters<G3cExecutionStore['recordReceipt']>[2]) {
      if (!recovery || recovery.operationId !== operationId || !settlement) throw new Error('SYNTHETIC_SUBMISSION_FIXTURE_MISMATCH');
      if (recovery.status === 'CONFIRMED') {
        if (JSON.stringify(recovery.receipt) === JSON.stringify(receipt)) return { workflow: recovery.workflow, replayed: true };
        throw new Error('SYNTHETIC_SUBMISSION_FIXTURE_CONFLICT');
      }
      if (receipt.payload.kind !== 'RECEIPT' || receipt.payload.finality !== 'finalized' || receipt.payload.canonical !== true ||
          settlement.payload.kind !== 'ACCOUNT_SNAPSHOT' || settlement.payload.blockFinality !== 'finalized') {
        throw new Error('SYNTHETIC_SUBMISSION_FIXTURE_NOT_FINAL');
      }
      recovery = { ...recovery, status: 'CONFIRMED', receipt, fees: receipt.payload.actualFeeUsdcMicros,
        reserved: false, receiptWrites: recovery.receiptWrites + 1,
        workflow: { ...recovery.workflow, receipt, settlementSnapshot: settlement, status: 'CONFIRMED' } };
      return { workflow: recovery.workflow, replayed: false };
    },
    status(executionId: string) {
      if (recovery?.executionId === executionId) {
        const parent = execution.get(executionId);
        return g3cStatusResponseSchema.parse({
          executionId, inputAsset: parent.intent.sellAsset, requestedAmount: parent.intent.amountIn,
          permittedAmount: parent.decision.approvedAmountIn, policyReason: 'PREEXISTING_SYNTHETIC_SUBMISSION_FIXTURE',
          mode: 'LIVE_DISABLED', status: recovery.status, transactionHash: SUBMITTED_HASH,
          receipt: recovery.receipt, actualFeesUsdcMicros: recovery.fees, evidenceProvenance: [],
        });
      }
      return realG3c.status(executionId);
    },

  };

  const auditPath = join(directory, 'd2-audit.sqlite');
  const audit = initializeD2AuditStore({ databasePath: auditPath });
  const observations = { getLatestSnapshots: () => snapshots(options.netflowValue) };
  const activeG3c = options.d2b || options.browserWallet ? realG3c : g3cFacade;
  const policyProvider = new BaseD2PolicyProvider({
    provider, store: activeG3c as never, trust: authority.trust, clock,
  });
  const gateway = createD2G3cGateway({ store: activeG3c as never, provider });
  const production = createD2ProductionService({
    observations, audit, policyProvider, executionStore: execution,
    g3cStatusReader: activeG3c, g3cGateway: gateway, clock,
  });
  const operatorAuth = new LocalOperatorAuthenticator({ secret: 'A'.repeat(43), allowedOrigin: 'http://127.0.0.1:5173', clock });
  const login = operatorAuth.login({ password: 'A'.repeat(43), origin: 'http://127.0.0.1:5173', hostname: '127.0.0.1', remoteAddress: '127.0.0.1' });
  if (!login.ok) throw new Error('Offline operator fixture failed to authenticate.');
  const operatorHeaders = { origin: 'http://127.0.0.1:5173', cookie: login.cookie.split(';')[0]! };
  let signerCalls = 0;
  let broadcasterCalls = 0;
  let failNextBroadcastResponse = false;
  let nextBroadcastGate: (() => Promise<void>) | null = null;
  const broadcastBytes: string[] = [];
  const isolatedSigner = walletPrivateKey ? createSyntheticIsolatedG3cSigner({
    privateKey: walletPrivateKey, hmacSecret: Buffer.alloc(32, 23), trust: authority.trust,
    statePath: join(directory, 'signer-replay.sqlite'), repositoryRoot: process.cwd(),
  }) : null;
  const signer = isolatedSigner ? {
    async sign(request: Parameters<typeof isolatedSigner.sign>[0]) {
      signerCalls += 1;
      return isolatedSigner.sign(request);
    },
  } : undefined;
  const broadcaster = options.d2b ? {
    async sendRawTransaction(raw: string) {
      broadcasterCalls += 1;
      broadcastBytes.push(raw);
      const gate = nextBroadcastGate;
      nextBroadcastGate = null;
      if (gate) await gate();
      const hash = transport.setSubmission(raw as Hex);
      if (failNextBroadcastResponse) {
        failNextBroadcastResponse = false;
        throw new Error('SYNTHETIC_BROADCAST_RESPONSE_LOST');
      }
      return hash;
    },
  } : undefined;
  const d2Execution = options.d2b ? createD2ExecutionService({
    production, store: realG3c, provider, ...(signer ? { signer } : {}), ...(broadcaster ? { broadcaster } : {}),
    signingEnabled: options.signingEnabled ?? true, submissionEnabled: options.submissionEnabled ?? true, clock,
  }) : undefined;
  const browserExecution = options.browserWallet ? createD2BrowserExecutionService({ production, store: realG3c, provider, enabled: true, clock }) : undefined;
  const app = createApiApp({
    store: paper, d2Production: production, g3cStatusReader: activeG3c, ...(d2Execution ? { d2Execution } : {}),
    ...(browserExecution ? { d2BrowserExecution: browserExecution } : {}),
    d2Runtime: () => d2Execution ? {
      ...RUNTIME, executionControls: { operatorAuthConfigured: true, signingEnabled: d2Execution.signingEnabled,
        submissionEnabled: d2Execution.submissionEnabled, reviewedMode: false, browserWalletEnabled: options.browserWallet === true },
    } : options.browserWallet ? { ...RUNTIME, liveExecutionEnabled: true, appMode: 'LIVE_REVIEWED', executionControls: { ...RUNTIME.executionControls, browserWalletEnabled: true } } : RUNTIME, operatorAuth, clock,
  });
  return {
    directory, paperPath, auditPath, paper, execution, realG3c, authority, budget, transport, operatorHeaders, walletAddress,
    setClock: (date: Date) => { currentTimeMs = date.getTime(); },
    provider, policyProvider, production, g3cFacade, d2Execution, app, broadcaster, getSignerCalls: () => signerCalls, getBroadcasterCalls: () => broadcasterCalls,
    getBroadcastBytes: () => [...broadcastBytes], setNextBroadcastGate: (gate: () => Promise<void>) => { nextBroadcastGate = gate; },
    loseNextBroadcastResponse: () => { failNextBroadcastResponse = true; },
    seedSubmission(executionId: string, operationId: string) {
      const unsignedTransaction: G3bUnsignedTransaction = {
        version: 1, type: 'EIP1559', chainId: 8453, from: WALLET, to: BASE_UNISWAP_V3.router,
        data: '0x1234', valueWei: '0', nonce: '0', gasLimit: '120000', maxFeePerGasWei: '300000000',
        maxPriorityFeePerGasWei: '100000000', accessList: [],
      };
      transport.setKnownSubmission(SUBMITTED_HASH, '0x02c0' as Hex, 0n, unsignedTransaction);
      recovery = {
        executionId, operationId, status: 'PENDING', reserved: true, receipt: null,
        fees: null, receiptWrites: 0,
        workflow: {
          executionId, operationId, sessionId: SESSION_ID, kind: 'SWAP', status: 'SUBMITTED', transactionHash: SUBMITTED_HASH,
          unsignedTransaction, accountSnapshot: { payload: { kind: 'ACCOUNT_SNAPSHOT', allowanceToken: BASE_TOKENS.USDC } },
        },
      };
    },
    async close(keepFiles = false) {
      await app.close();
      await isolatedSigner?.close();
      provider.close();
      production.close();
      execution.close();
      if (!keepFiles) rmSync(directory, { recursive: true, force: true });
    },
    getRecovery: () => recovery,
  };
}

async function createProposal(h: ReturnType<typeof setup>, amount = '4000000') {
  const response = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/proposals',
    payload: { walletAddress: h.walletAddress, requestedUsdcMicros: amount } });
  expect(response.statusCode).toBe(201);
  return response.json() as { proposalId: string; intent: { intentId: string; amountIn: string } };
}
async function evaluate(h: ReturnType<typeof setup>, proposalId: string) {
  const response = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/evaluations',
    payload: { proposalId, sessionId: SESSION_ID } });
  expect(response.statusCode).toBe(200);
  return response.json() as { decision: { status: string; approvedAmountIn: string | null; requestedAmountIn: string };
    executionMode: string; paperFillCreated: false; executionTransaction: ExecutionTransactionEnvelope | null };
}
async function startSession(h: ReturnType<typeof setup>) {
  const response = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/sessions/start',
    payload: { sessionId: SESSION_ID, walletAddress: h.walletAddress, reason: 'synthetic D2 provider integration session' } });
  expect(response.statusCode, JSON.stringify(response.json())).toBe(201);
}
async function reserve(h: ReturnType<typeof setup>, proposalId: string) {
  const response = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/reservations',
    payload: { proposalId, sessionId: SESSION_ID } });
  expect(response.statusCode).toBe(201);
  return response.json();
}

describe('D2 provider-backed application integration', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('keeps D2b switches off by default and rejects missing operator authentication before execution', async () => {
    const h = setup();
    try {
      const runtime = await h.app.inject({ method: 'GET', url: '/v2/runtime' });
      expect(runtime.statusCode).toBe(200);
      expect(runtime.json().executionControls).toMatchObject({
        signingEnabled: false, submissionEnabled: false, reviewedMode: false, browserWalletEnabled: false,
      });
      expect(runtime.json()).toMatchObject({ paidNansenCallsEnabled: false, activeNansenCreditBudget: 0, liveExecutionEnabled: false });

      const request = { proposalId: randomUUID(), operationId: randomUUID(), sessionId: SESSION_ID, idempotencyKey: randomUUID() };
      const unauthorized = await h.app.inject({ method: 'POST', url: '/v1/production/executions/prepare-sign',
        headers: { origin: 'http://127.0.0.1:5173' }, payload: request });
      expect(unauthorized.statusCode).toBe(401);
      const unavailable = await h.app.inject({ method: 'POST', url: '/v1/production/executions/prepare-sign',
        headers: h.operatorHeaders, payload: request });
      expect(unavailable.statusCode).toBe(503);
      expect(h.getSignerCalls()).toBe(0);
      expect(h.getBroadcasterCalls()).toBe(0);
    } finally { await h.close(); }
  });

  it('rejects cross-origin, unauthenticated and client-supplied signed transaction data before signer use', async () => {
    const h = setup({ d2b: true });
    try {
      const request = { proposalId: randomUUID(), operationId: randomUUID(), sessionId: SESSION_ID, idempotencyKey: randomUUID() };
      const unauthenticated = await h.app.inject({ method: 'POST', url: '/v1/production/executions/prepare-sign',
        headers: { origin: 'http://127.0.0.1:5173' }, payload: request });
      expect(unauthenticated.statusCode).toBe(401);
      const wrongOrigin = await h.app.inject({ method: 'POST', url: '/v1/production/executions/submit',
        headers: { ...h.operatorHeaders, origin: 'http://attacker.invalid' },
        payload: { proposalId: request.proposalId, operationId: request.operationId, idempotencyKey: randomUUID() } });
      expect(wrongOrigin.statusCode).toBe(403);
      const tampered = await h.app.inject({ method: 'POST', url: '/v1/production/executions/prepare-sign',
        headers: h.operatorHeaders, payload: { ...request, signedBytesHex: '0x02c0' } });
      expect(tampered.statusCode).toBe(400);
      expect(h.getSignerCalls()).toBe(0);
      expect(h.getBroadcasterCalls()).toBe(0);
    } finally { await h.close(); }
  });

  it('prepares an ALLOW decision using only its exact permitted amount', async () => {
    const h = setup({ d2b: true });
    try {
      await startSession(h);
      const proposal = await createProposal(h, '4000000');
      const evaluation = await evaluate(h, proposal.proposalId);
      expect(evaluation.decision).toMatchObject({ status: 'ALLOW', requestedAmountIn: '4000000', approvedAmountIn: '4000000' });
      await reserve(h, proposal.proposalId);
      const operationId = randomUUID();
      const prepared = await h.app.inject({ headers: h.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/prepare-sign',
        payload: { proposalId: proposal.proposalId, operationId, sessionId: SESSION_ID, idempotencyKey: randomUUID() } });
      expect(prepared.statusCode, JSON.stringify(prepared.json())).toBe(200);
      expect(prepared.json()).toMatchObject({
        proposalId: proposal.proposalId, operationId, kind: 'SWAP', status: 'SIGNED_OUTBOX', permittedAmount: '4000000',
      });
      const workflow = h.realG3c.getWorkflow(operationId);
      expect(workflow.quote?.payload).toMatchObject({ kind: 'QUOTE', amountIn: '4000000' });
      expect(h.getSignerCalls()).toBe(1);
      expect(h.getBroadcasterCalls()).toBe(0);
    } finally { await h.close(); }
  });
  it('keeps signing and submission as independent gates', async () => {
    const signingOff = setup({ d2b: true, signingEnabled: false, submissionEnabled: true });
    try {
      await startSession(signingOff);
      const proposal = await createProposal(signingOff);
      await evaluate(signingOff, proposal.proposalId);
      await reserve(signingOff, proposal.proposalId);
      const denied = await signingOff.app.inject({ headers: signingOff.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/prepare-sign',
        payload: { proposalId: proposal.proposalId, operationId: randomUUID(), sessionId: SESSION_ID, idempotencyKey: randomUUID() } });
      expect(denied.statusCode).toBe(503);
      expect(denied.json()).toMatchObject({ error: 'D2B_SIGNING_DISABLED' });
      expect(signingOff.getSignerCalls()).toBe(0);
      expect(signingOff.getBroadcasterCalls()).toBe(0);
    } finally { await signingOff.close(); }

    const submissionOff = setup({ d2b: true, signingEnabled: true, submissionEnabled: false });
    try {
      await startSession(submissionOff);
      const proposal = await createProposal(submissionOff);
      await evaluate(submissionOff, proposal.proposalId);
      await reserve(submissionOff, proposal.proposalId);
      const operationId = randomUUID();
      const prepared = await submissionOff.app.inject({ headers: submissionOff.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/prepare-sign',
        payload: { proposalId: proposal.proposalId, operationId, sessionId: SESSION_ID, idempotencyKey: randomUUID() } });
      expect(prepared.statusCode, JSON.stringify(prepared.json())).toBe(200);
      expect(prepared.json()).toMatchObject({ status: 'SIGNED_OUTBOX' });
      const denied = await submissionOff.app.inject({ headers: submissionOff.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/submit',
        payload: { proposalId: proposal.proposalId, operationId, idempotencyKey: randomUUID() } });
      expect(denied.statusCode).toBe(503);
      expect(denied.json()).toMatchObject({ error: 'D2B_SUBMISSION_DISABLED' });
      expect(submissionOff.getSignerCalls()).toBe(1);
      expect(submissionOff.getBroadcasterCalls()).toBe(0);
    } finally { await submissionOff.close(); }
  });

  it('replays durable operator action identity after the G3c store is reopened', async () => {
    const h = setup();
    let originalClosed = false;
    try {
      await startSession(h);
      const proposal = await createProposal(h);
      await evaluate(h, proposal.proposalId);
      await reserve(h, proposal.proposalId);
      const action = {
        executionId: proposal.proposalId, proposalId: proposal.proposalId, operationId: randomUUID(),
        sessionId: SESSION_ID, operatorId: 'local-0123456789abcdef', action: 'PREPARE_SIGN' as const,
        idempotencyKey: randomUUID(), payloadDigest: 'a'.repeat(64),
      };
      expect(h.realG3c.recordD2bOperatorAction(action)).toEqual({ replayed: false });
      await h.close(true);
      originalClosed = true;
      const reopenedPaper = openPaperStore({ databasePath: h.paperPath, clock: () => new Date(NOW) });
      const reopenedExecution = new ExecutionStore(reopenedPaper);
      const reopenedG3c = new G3cExecutionStore(reopenedExecution, h.authority.trust, {}, () => new Date(NOW));
      try {
        expect(reopenedG3c.recordD2bOperatorAction(action)).toEqual({ replayed: true });
        expect(() => reopenedG3c.recordD2bOperatorAction({ ...action, payloadDigest: 'b'.repeat(64) })).toThrow();
      } finally {
        reopenedExecution.close();
        rmSync(h.directory, { recursive: true, force: true });
      }
    } finally {
      if (!originalClosed) await h.close();
    }
  });
  it('uses the real D2 coordinator and G3c lifecycle for resize, approval, submit, receipt and swap sequencing', async () => {
    const h = setup({ d2b: true });
    try {
      await startSession(h);
      const proposal = await createProposal(h, '6000000');
      const evaluation = await evaluate(h, proposal.proposalId);
      expect(evaluation.decision).toMatchObject({ status: 'RESIZE', requestedAmountIn: '6000000', approvedAmountIn: '5000000' });
      await reserve(h, proposal.proposalId);

      const simulationOperationId = randomUUID();
      const simulated = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/executions/simulate',
        payload: { proposalId: proposal.proposalId, sessionId: SESSION_ID, operationId: simulationOperationId } });
      expect(simulated.statusCode, JSON.stringify(simulated.json())).toBe(201);
      expect(simulated.json()).toMatchObject({ requestedAmount: '6000000', permittedAmount: '5000000',
        executionMode: 'READ_ONLY', authorizationCreated: false, signerInvocations: 0, broadcasterInvocations: 0 });
      expect(h.getSignerCalls()).toBe(0);
      expect(h.getBroadcasterCalls()).toBe(0);

      // Model an allowance changing after simulation; prepare/sign must choose from its fresh read.
      expect(h.budget.snapshot().recoveryReserve - h.budget.snapshot().recoveryRequests).toBeGreaterThanOrEqual(D2B_APPROVAL_SWAP_REQUIRED_RECOVERY_REQUESTS);
      h.transport.setAllowance(0n);      h.transport.setAllowance(0n);
      const mismatchedSession = await h.app.inject({ headers: h.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/prepare-sign',
        payload: { proposalId: proposal.proposalId, operationId: randomUUID(), sessionId: randomUUID(), idempotencyKey: randomUUID() } });
      expect(mismatchedSession.statusCode).toBe(409);
      expect(h.getSignerCalls()).toBe(0);

      const approvalOperationId = randomUUID();
      const approvalRequest = { proposalId: proposal.proposalId, operationId: approvalOperationId,
        sessionId: SESSION_ID, idempotencyKey: randomUUID() };
      const [approvalPrepared, concurrentPrepare] = await Promise.all([
        h.app.inject({ headers: h.operatorHeaders, method: 'POST',
          url: '/v1/production/executions/prepare-sign', payload: approvalRequest }),
        h.app.inject({ headers: h.operatorHeaders, method: 'POST',
          url: '/v1/production/executions/prepare-sign', payload: approvalRequest }),
      ]);
      expect(approvalPrepared.statusCode, JSON.stringify(approvalPrepared.json())).toBe(200);
      expect(concurrentPrepare.statusCode, JSON.stringify(concurrentPrepare.json())).toBe(200);
      expect(approvalPrepared.json()).toMatchObject({
        kind: 'APPROVAL', status: 'SIGNED_OUTBOX', permittedAmount: '5000000',
      });
      expect(JSON.stringify(approvalPrepared.json())).not.toContain('signedBytesHex');
      const approvalWorkflow = h.realG3c.getWorkflow(approvalOperationId);
      expect(approvalWorkflow).toMatchObject({ kind: 'APPROVAL', status: 'SIGNED_OUTBOX', signedBytesHex: expect.stringMatching(/^0x02/u) });
      expect(approvalWorkflow.unsignedTransaction.data.slice(-64)).toBe((5_000_000n).toString(16).padStart(64, '0'));
      expect(approvalWorkflow.unsignedTransaction.chainId).toBe(8453);
      expect(approvalWorkflow.unsignedTransaction.from.toLowerCase()).toBe(h.walletAddress.toLowerCase());
      expect(h.getSignerCalls()).toBe(1);

      const replayedPrepare = await h.app.inject({ headers: h.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/prepare-sign', payload: approvalRequest });
      expect(replayedPrepare.statusCode).toBe(200);
      expect(replayedPrepare.json()).toMatchObject({ status: 'SIGNED_OUTBOX', replayed: true });
      expect(h.getSignerCalls()).toBe(1);

      const alteredBinding = await h.app.inject({ headers: h.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/prepare-sign',
        payload: { ...approvalRequest, operationId: randomUUID() } });
      expect(alteredBinding.statusCode, JSON.stringify(alteredBinding.json())).toBe(409);
      expect(h.getSignerCalls()).toBe(1);

      const approvalSubmitRequest = { proposalId: proposal.proposalId, operationId: approvalOperationId, idempotencyKey: randomUUID() };
      const submittedApproval = await h.app.inject({ headers: h.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/submit', payload: approvalSubmitRequest });
      expect(submittedApproval.statusCode).toBe(200);
      expect(submittedApproval.json()).toMatchObject({ kind: 'APPROVAL', status: 'SUBMITTED',
        transactionHash: approvalWorkflow.transactionHash });
      expect(h.getBroadcasterCalls()).toBe(1);
      const submitReplay = await h.app.inject({ headers: h.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/submit', payload: approvalSubmitRequest });
      expect(submitReplay.statusCode).toBe(200);
      expect(submitReplay.json()).toMatchObject({ status: 'SUBMITTED', replayed: true });
      expect(h.getBroadcasterCalls()).toBe(1);

      h.transport.setAllowance(5_000_000n);
      const recoveredApproval = await h.app.inject({ headers: h.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/reconcile',
        payload: { proposalId: proposal.proposalId, operationId: approvalOperationId, idempotencyKey: randomUUID() } });
      expect(recoveredApproval.statusCode, JSON.stringify(recoveredApproval.json())).toBe(200);
      expect(recoveredApproval.json()).toMatchObject({ kind: 'APPROVAL', status: 'CONFIRMED',
        receiptOutcome: 'CONFIRMED', permittedAmount: '5000000' });
      expect(BigInt(recoveredApproval.json().actualFeesUsdcMicros)).toBeGreaterThan(0n);
      const approvalStatus = await h.app.inject({ headers: h.operatorHeaders, method: 'GET',
        url: '/v1/production/executions/' + proposal.proposalId + '/' + approvalOperationId });
      expect(approvalStatus.statusCode).toBe(200);
      expect(approvalStatus.json()).toMatchObject({ status: 'CONFIRMED', kind: 'APPROVAL' });
      expect(h.realG3c.getSession(SESSION_ID).latestSnapshot?.payload).toMatchObject({ kind: 'ACCOUNT_SNAPSHOT', allowanceAtomic: '5000000' });

      expect(h.budget.snapshot().recoveryReserve - h.budget.snapshot().recoveryRequests).toBeGreaterThanOrEqual(D2B_DIRECT_SWAP_REQUIRED_RECOVERY_REQUESTS);
      const swapOperationId = randomUUID();
      const preparedSwap = await h.app.inject({ headers: h.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/prepare-sign',
        payload: { proposalId: proposal.proposalId, operationId: swapOperationId, sessionId: SESSION_ID, idempotencyKey: randomUUID() } });
      expect(preparedSwap.statusCode, JSON.stringify(preparedSwap.json())).toBe(200);
      expect(preparedSwap.json()).toMatchObject({ kind: 'SWAP', status: 'SIGNED_OUTBOX', permittedAmount: '5000000' });
      const swapWorkflow = h.realG3c.getWorkflow(swapOperationId);
      expect(swapWorkflow.unsignedTransaction).toMatchObject({
        chainId: 8453, from: h.walletAddress.toLowerCase(), to: BASE_UNISWAP_V3.router, nonce: '1',
      });
      expect(h.getSignerCalls()).toBe(2);

      const submittedSwap = await h.app.inject({ headers: h.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/submit',
        payload: { proposalId: proposal.proposalId, operationId: swapOperationId, idempotencyKey: randomUUID() } });
      expect(submittedSwap.statusCode).toBe(200);
      expect(submittedSwap.json()).toMatchObject({ kind: 'SWAP', status: 'SUBMITTED' });
      expect(h.getBroadcasterCalls()).toBe(2);
      const swapReconcileRequest = { proposalId: proposal.proposalId, operationId: swapOperationId, idempotencyKey: randomUUID() };
      const beforeSwapRecovery = h.budget.snapshot().recoveryRequests;
      h.transport.setFailFinalizedAccount(true);
      const failedSwapRecovery = await h.app.inject({ headers: h.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/reconcile', payload: swapReconcileRequest });
      expect([409, 503]).toContain(failedSwapRecovery.statusCode);
      h.transport.setFailFinalizedAccount(false);
      const recoveredSwap = await h.app.inject({ headers: h.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/reconcile', payload: swapReconcileRequest });
      expect(recoveredSwap.statusCode, JSON.stringify(recoveredSwap.json())).toBe(200);
      expect(recoveredSwap.json()).toMatchObject({ kind: 'SWAP', status: 'CONFIRMED', receiptOutcome: 'CONFIRMED' });
      const flowBudget = h.budget.snapshot();
      expect(flowBudget.maxRequests).toBe(DEFAULT_D2_RPC_MAX_REQUESTS);
      expect(flowBudget.recoveryReserve).toBe(DEFAULT_D2_RPC_RECOVERY_RESERVE);
      expect(flowBudget.regularRequests).toBe(529);
      expect(flowBudget.recoveryRequests).toBe(121);
      expect(flowBudget.regularRequests).toBeLessThanOrEqual(DEFAULT_D2_RPC_MAX_REQUESTS - DEFAULT_D2_RPC_RECOVERY_RESERVE);
      expect(flowBudget.recoveryRequests - beforeSwapRecovery).toBeLessThanOrEqual(DEFAULT_D2_RPC_RECOVERY_RESERVE);
      expect(flowBudget.recoveryRequests).toBeLessThanOrEqual(DEFAULT_D2_RPC_RECOVERY_RESERVE);
      expect(flowBudget.regularRemainingRequests).toBe(175);
      expect(flowBudget.recoveryReserve - flowBudget.recoveryRequests).toBe(71);
      const settledFees = h.realG3c.getSession(SESSION_ID).realizedFeesUsdcMicros;
      const settledRpcCalls = h.transport.calls.length;
      const repeatedSwapRecovery = await h.app.inject({ headers: h.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/reconcile', payload: swapReconcileRequest });
      expect(repeatedSwapRecovery.statusCode).toBe(200);
      expect(h.transport.calls).toHaveLength(settledRpcCalls);
      expect(h.realG3c.getSession(SESSION_ID).realizedFeesUsdcMicros).toBe(settledFees);
      expect(h.execution.get(proposal.proposalId).status).toBe('RELEASED');
      expect(h.getSignerCalls()).toBe(2);
      expect(h.getBroadcasterCalls()).toBe(2);
    } finally { await h.close(); }
  });
  it('resumes a pre-send SUBMIT rejection with the same key after fresh controls', async () => {
    const h = setup({ d2b: true });
    try {
      await startSession(h);
      const proposal = await createProposal(h);
      await evaluate(h, proposal.proposalId);
      await reserve(h, proposal.proposalId);
      const operationId = randomUUID();
      const prepared = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/executions/prepare-sign',
        payload: { proposalId: proposal.proposalId, operationId, sessionId: SESSION_ID, idempotencyKey: randomUUID() } });
      expect(prepared.statusCode, JSON.stringify(prepared.json())).toBe(200);
      const request = { proposalId: proposal.proposalId, operationId, idempotencyKey: randomUUID() };
      h.execution.setKillSwitch(true, 'synthetic stop before byte release');
      const rejected = await h.app.inject({ headers: h.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/submit', payload: request });
      expect(rejected.statusCode).toBe(503);
      expect(h.realG3c.getWorkflow(operationId)).toMatchObject({ status: 'SIGNED_OUTBOX', submissionAttempts: 0 });
      expect(h.getBroadcasterCalls()).toBe(0);

      h.execution.setKillSwitch(false, 'synthetic operator resumed');
      const retry = await h.app.inject({ headers: h.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/submit', payload: request });
      expect(retry.statusCode, JSON.stringify(retry.json())).toBe(200);
      expect(retry.json()).toMatchObject({ status: 'SUBMITTED', replayed: false });
      expect(h.realG3c.getWorkflow(operationId).submissionAttempts).toBe(1);
      expect(h.getBroadcasterCalls()).toBe(1);
    } finally { await h.close(); }
  });

  it('resumes a bound SUBMIT after coordinator/store reopen before any external byte release', async () => {
    const h = setup({ d2b: true });
    let reopenedExecution: ExecutionStore | null = null;
    try {
      await startSession(h);
      const proposal = await createProposal(h);
      await evaluate(h, proposal.proposalId);
      await reserve(h, proposal.proposalId);
      const operationId = randomUUID();
      const prepared = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/executions/prepare-sign',
        payload: { proposalId: proposal.proposalId, operationId, sessionId: SESSION_ID, idempotencyKey: randomUUID() } });
      expect(prepared.statusCode).toBe(200);
      const request = { proposalId: proposal.proposalId, operationId, idempotencyKey: randomUUID() };
      const workflow = h.realG3c.getWorkflow(operationId);
      const actionPayload = { action: 'SUBMIT', proposalId: proposal.proposalId, operationId, sessionId: SESSION_ID,
        transactionDigest: workflow.transactionDigest, signedBytesDigest: workflow.signedBytesDigest,
        transactionHash: workflow.transactionHash };
      const action = { executionId: proposal.proposalId, proposalId: proposal.proposalId, operationId, sessionId: SESSION_ID,
        operatorId: 'local-0123456789abcdef', action: 'SUBMIT' as const, idempotencyKey: request.idempotencyKey,
        payloadDigest: createHash('sha256').update(canonicalJson(actionPayload)).digest('hex') };
      expect(h.realG3c.recordD2bOperatorAction(action)).toEqual({ replayed: false });

      const reopenedPaper = openPaperStore({ databasePath: h.paperPath, clock: () => new Date(NOW) });
      reopenedExecution = new ExecutionStore(reopenedPaper);
      const reopenedStore = new G3cExecutionStore(reopenedExecution, h.authority.trust,
        { allowTestSigning: true, allowTestBroadcast: true }, () => new Date(NOW));
      const reopenedCoordinator = createD2ExecutionService({ production: h.production, store: reopenedStore,
        provider: h.provider, broadcaster: h.broadcaster!, submissionEnabled: true, clock: () => new Date(NOW) });
      const submitted = await reopenedCoordinator.submit(request, action.operatorId);
      expect(submitted.status).toBe('SUBMITTED');
      expect(submitted.replayed).toBe(false);
      expect(h.getBroadcasterCalls()).toBe(1);
      expect(reopenedStore.getWorkflow(operationId).status).toBe('SUBMITTED');
    } finally {
      reopenedExecution?.close();
      await h.close();
    }
  });

  it('claims a same-key submit across independent store/coordinator instances', async () => {
    const h = setup({ d2b: true });
    let reopenedExecution: ExecutionStore | null = null;
    let unblock: (() => void) | undefined;
    let entered!: () => void;
    try {
      await startSession(h);
      const proposal = await createProposal(h);
      await evaluate(h, proposal.proposalId);
      await reserve(h, proposal.proposalId);
      const operationId = randomUUID();
      const prepared = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/executions/prepare-sign',
        payload: { proposalId: proposal.proposalId, operationId, sessionId: SESSION_ID, idempotencyKey: randomUUID() } });
      expect(prepared.statusCode).toBe(200);
      const request = { proposalId: proposal.proposalId, operationId, idempotencyKey: randomUUID() };
      const operatorId = 'local-0123456789abcdef';
      const waitForRelease = new Promise<void>((resolve) => { unblock = resolve; });
      const broadcasterEntered = new Promise<void>((resolve) => { entered = resolve; });
      h.setNextBroadcastGate(async () => { entered(); await waitForRelease; });

      const reopenedPaper = openPaperStore({ databasePath: h.paperPath, clock: () => new Date(NOW) });
      reopenedExecution = new ExecutionStore(reopenedPaper);
      const reopenedStore = new G3cExecutionStore(reopenedExecution, h.authority.trust,
        { allowTestSigning: true, allowTestBroadcast: true }, () => new Date(NOW));
      const otherCoordinator = createD2ExecutionService({ production: h.production, store: reopenedStore,
        provider: h.provider, broadcaster: h.broadcaster!, submissionEnabled: true, clock: () => new Date(NOW) });
      const first = h.d2Execution!.submit(request, operatorId);
      await broadcasterEntered;
      await expect(otherCoordinator.submit(request, operatorId)).rejects.toThrow('D2B_ACTION_IN_PROGRESS');
      expect(h.getBroadcasterCalls()).toBe(1);
      unblock!();
      const submitted = await first;
      expect(submitted.status).toBe('SUBMITTED');
      expect(h.getBroadcasterCalls()).toBe(1);
      expect(reopenedStore.getWorkflow(operationId).status).toBe('SUBMITTED');
    } finally {
      unblock?.();
      reopenedExecution?.close();
      await h.close();
    }
  });

  it('preserves uncertain submission bytes and only retries them after a new explicit action key', async () => {
    const h = setup({ d2b: true });
    try {
      await startSession(h);
      const proposal = await createProposal(h);
      await evaluate(h, proposal.proposalId);
      await reserve(h, proposal.proposalId);
      const operationId = randomUUID();
      const prepared = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/executions/prepare-sign',
        payload: { proposalId: proposal.proposalId, operationId, sessionId: SESSION_ID, idempotencyKey: randomUUID() } });
      expect(prepared.statusCode).toBe(200);
      const signed = h.realG3c.getWorkflow(operationId);
      const uncertainRequest = { proposalId: proposal.proposalId, operationId, idempotencyKey: randomUUID() };
      h.loseNextBroadcastResponse();
      const uncertain = await h.app.inject({ headers: h.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/submit', payload: uncertainRequest });
      expect(uncertain.statusCode).toBe(200);
      expect(uncertain.json()).toMatchObject({ status: 'SUBMISSION_UNCERTAIN', submissionAttempts: 1 });
      const sameKeyReplay = await h.app.inject({ headers: h.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/submit', payload: uncertainRequest });
      expect(sameKeyReplay.statusCode).toBe(200);
      expect(sameKeyReplay.json()).toMatchObject({ status: 'SUBMISSION_UNCERTAIN', replayed: true });
      expect(h.getBroadcasterCalls()).toBe(1);
      const manualRetry = await h.app.inject({ headers: h.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/submit', payload: { ...uncertainRequest, idempotencyKey: randomUUID() } });
      expect(manualRetry.statusCode, JSON.stringify(manualRetry.json())).toBe(200);
      expect(manualRetry.json()).toMatchObject({ status: 'SUBMITTED', submissionAttempts: 2 });
      expect(h.getBroadcasterCalls()).toBe(2);
      expect(h.getBroadcastBytes()).toEqual([signed.signedBytesHex, signed.signedBytesHex]);
      expect(h.realG3c.getWorkflow(operationId)).toMatchObject({ transactionHash: signed.transactionHash, signedBytesHex: signed.signedBytesHex });
    } finally { await h.close(); }
  });

  it('preflights the remaining ordinary allowance before signing an approval flow', async () => {
    const h = setup({ d2b: true });
    try {
      await startSession(h);
      const proposal = await createProposal(h, '6000000');
      await evaluate(h, proposal.proposalId);
      await reserve(h, proposal.proposalId);
      const simulationOperationId = randomUUID();
      const simulated = await h.app.inject({ headers: h.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/simulate',
        payload: { proposalId: proposal.proposalId, sessionId: SESSION_ID, operationId: simulationOperationId } });
      expect(simulated.statusCode).toBe(201);
      h.transport.setAllowance(0n);
      while (h.budget.snapshot().regularRemainingRequests >= D2B_APPROVAL_SWAP_REQUIRED_REGULAR_REQUESTS) {
        h.budget.consume('regular');
      }
      expect(h.budget.snapshot().regularRemainingRequests).toBe(D2B_APPROVAL_SWAP_REQUIRED_REGULAR_REQUESTS - 1);
      const operationId = randomUUID();
      const rejected = await h.app.inject({ headers: h.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/prepare-sign',
        payload: { proposalId: proposal.proposalId, operationId, sessionId: SESSION_ID, idempotencyKey: randomUUID() } });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toMatchObject({ error: 'D2B_RPC_CAPACITY_INSUFFICIENT' });
      expect(h.realG3c.findWorkflow(operationId)).toBeNull();
      expect(h.getSignerCalls()).toBe(0);
      expect(h.getBroadcasterCalls()).toBe(0);
      while (h.budget.snapshot().regularRemainingRequests > 0) h.budget.consume('regular');
      expect(() => h.budget.consume('regular')).toThrow('RPC_RUN_BUDGET_EXHAUSTED');
      expect(h.budget.snapshot().recoveryRequests).toBe(0);
    } finally { await h.close(); }
  });

  it('completes a direct-swap flow within the shipped allowance and retries one failed reconciliation read', async () => {
    const h = setup({ d2b: true });
    try {
      await startSession(h);
      const proposal = await createProposal(h, '4000000');
      await evaluate(h, proposal.proposalId);
      await reserve(h, proposal.proposalId);
      expect(h.budget.snapshot().regularRemainingRequests).toBeGreaterThan(D2B_DIRECT_SWAP_REQUIRED_REGULAR_REQUESTS);
      const operationId = randomUUID();
      const prepared = await h.app.inject({ headers: h.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/prepare-sign',
        payload: { proposalId: proposal.proposalId, operationId, sessionId: SESSION_ID, idempotencyKey: randomUUID() } });
      expect(prepared.statusCode, JSON.stringify(prepared.json())).toBe(200);
      expect(prepared.json()).toMatchObject({ kind: 'SWAP', status: 'SIGNED_OUTBOX' });
      const submitted = await h.app.inject({ headers: h.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/submit', payload: { proposalId: proposal.proposalId, operationId, idempotencyKey: randomUUID() } });
      expect(submitted.statusCode).toBe(200);
      const reconcile = { proposalId: proposal.proposalId, operationId, idempotencyKey: randomUUID() };
      h.transport.setFailFinalizedAccount(true);
      const failed = await h.app.inject({ headers: h.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/reconcile', payload: reconcile });
      expect([409, 503]).toContain(failed.statusCode);
      h.transport.setFailFinalizedAccount(false);
      const reconciled = await h.app.inject({ headers: h.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/reconcile', payload: reconcile });
      expect(reconciled.statusCode, JSON.stringify(reconciled.json())).toBe(200);
      expect(reconciled.json()).toMatchObject({ status: 'CONFIRMED', kind: 'SWAP' });
      const beforeReplayCalls = h.transport.calls.length;
      const repeated = await h.app.inject({ headers: h.operatorHeaders, method: 'POST',
        url: '/v1/production/executions/reconcile', payload: reconcile });
      expect(repeated.statusCode).toBe(200);
      expect(h.transport.calls).toHaveLength(beforeReplayCalls);
      expect(h.budget.snapshot().maxRequests).toBe(DEFAULT_D2_RPC_MAX_REQUESTS);
      expect(h.budget.snapshot().recoveryReserve).toBe(DEFAULT_D2_RPC_RECOVERY_RESERVE);
      expect(h.budget.snapshot().regularRequests).toBe(258);
      expect(h.budget.snapshot().recoveryRequests).toBe(76);
      expect(h.budget.snapshot().recoveryRequests).toBeLessThanOrEqual(DEFAULT_D2_RPC_RECOVERY_RESERVE);
      expect(h.budget.snapshot().regularRequests).toBeLessThanOrEqual(DEFAULT_D2_RPC_MAX_REQUESTS - DEFAULT_D2_RPC_RECOVERY_RESERVE);
      expect(h.budget.snapshot().recoveryReserve - h.budget.snapshot().recoveryRequests).toBeGreaterThanOrEqual(D2B_DIRECT_SWAP_REQUIRED_RECOVERY_REQUESTS);
    } finally { await h.close(); }
  });
  it('drives a successful API simulation through the real policy provider and G3c gateway to durable audit', async () => {
    const h = setup();
    let proposalId = '';
    let operationId = '';
    try {
      await startSession(h);
      const proposal = await createProposal(h);
      proposalId = proposal.proposalId;
      const result = await evaluate(h, proposalId);
      expect(['ALLOW', 'RESIZE']).toContain(result.decision.status);
      expect(result.executionTransaction?.amountIn).toBe(result.decision.approvedAmountIn);
      await reserve(h, proposalId);
      operationId = randomUUID();
      const simulated = await h.app.inject({ headers: h.operatorHeaders,
        method: 'POST', url: '/v1/production/executions/simulate',
        payload: { proposalId, sessionId: SESSION_ID, operationId },
      });
      expect(simulated.statusCode, JSON.stringify(simulated.json())).toBe(201);
      expect(simulated.json()).toMatchObject({
        proposalId, operationId, requestedAmount: result.decision.requestedAmountIn,
        permittedAmount: result.decision.approvedAmountIn, status: 'SIMULATED',
        executionMode: 'READ_ONLY', authorizationCreated: false,
        signerInvocations: 0, broadcasterInvocations: 0,
      });
      expect(simulated.json().policyTransaction.amountIn).toBe(result.decision.approvedAmountIn);

      expect(h.execution.get(proposalId).simulation).toBeNull();
      const noSign = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/executions/sign', payload: { proposalId } });
      const noBroadcast = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/executions/broadcast', payload: { proposalId } });
      expect(noSign.statusCode).toBe(404);
      expect(noBroadcast.statusCode).toBe(404);
    } finally { await h.close(true); }

    const audit = openD2AuditStore({ databasePath: h.auditPath });
    try {
      const saved = audit.getSimulation(proposalId, operationId);
      expect(saved).toMatchObject({
        proposalId, operationId, status: 'SIMULATED', executionMode: 'READ_ONLY',
        authorizationCreated: false, signerInvocations: 0, broadcasterInvocations: 0,
      });
      expect(saved?.policyTransaction.amountIn).toBe(saved?.permittedAmount);
    } finally {
      audit.close();
      rmSync(h.directory, { recursive: true, force: true });
    }
  });

  it('recovers the exact preexisting submission using only recovery reserve through the API and real provider', async () => {
    const h = setup();
    try {
      await startSession(h);
      const proposal = await createProposal(h);
      const result = await evaluate(h, proposal.proposalId);
      expect(['ALLOW', 'RESIZE']).toContain(result.decision.status);
      await reserve(h, proposal.proposalId);
      const operationId = randomUUID();
      h.seedSubmission(proposal.proposalId, operationId);

      const maxRegular = h.budget.maxRequests - h.budget.recoveryReserve;
      while (h.budget.snapshot().regularRequests < maxRegular) h.budget.consume('regular');
      expect(h.budget.snapshot().regularRemainingRequests).toBe(0);
      expect(h.getRecovery()?.reserved).toBe(true);

      const beforeNormalCall = h.budget.snapshot();
      await expect(h.provider.account(WALLET, BASE_TOKENS.USDC, 99, 'unsafe'))
        .rejects.toThrow('RPC_RUN_BUDGET_EXHAUSTED');
      await expect(h.provider.account(WALLET, BASE_TOKENS.USDC, 100, 'finalized'))
        .rejects.toThrow('RPC_RUN_BUDGET_EXHAUSTED');
      expect(h.budget.snapshot().recoveryRequests).toBe(beforeNormalCall.recoveryRequests);
      expect(h.getRecovery()?.reserved).toBe(true);

      let releaseRecoveryContext!: () => void;
      const heldContext = h.provider.withRecoveryBudget!(() => new Promise<void>((resolve) => {
        releaseRecoveryContext = resolve;
      }));
      await Promise.resolve();
      const whileHeld = h.budget.snapshot();
      await expect(h.provider.account(WALLET, BASE_TOKENS.USDC, 101, 'unsafe'))
        .rejects.toThrow('RPC_RUN_BUDGET_EXHAUSTED');
      await expect(h.provider.account(WALLET, BASE_TOKENS.USDC, 102, 'finalized'))
        .rejects.toThrow('RPC_RUN_BUDGET_EXHAUSTED');
      expect(h.budget.snapshot().recoveryRequests).toBe(whileHeld.recoveryRequests);
      releaseRecoveryContext();
      await heldContext;

      const beforeRecovery = h.budget.snapshot().recoveryRequests;
      h.transport.setFailFinalizedAccount(true);
      const failed = await h.app.inject({ headers: h.operatorHeaders,
        method: 'POST', url: '/v1/production/executions/reconcile',
        payload: { proposalId: proposal.proposalId, operationId },
      });
      expect(failed.statusCode).toBe(503);
      expect(h.getRecovery()).toMatchObject({ reserved: true, receiptWrites: 0, status: 'PENDING' });
      const afterFailure = h.budget.snapshot();
      expect(afterFailure.recoveryRequests).toBeGreaterThan(0);
      expect(afterFailure.regularRequests).toBe(maxRegular);

      h.transport.setFailFinalizedAccount(false);
      const beforeRetry = h.budget.snapshot().recoveryRequests;
      const recovered = await h.app.inject({ headers: h.operatorHeaders,
        method: 'POST', url: '/v1/production/executions/reconcile',
        payload: { proposalId: proposal.proposalId, operationId },
      });
      expect(recovered.statusCode).toBe(200);
      const afterSuccess = h.budget.snapshot();
      const successfulRecoveryRequests = afterSuccess.recoveryRequests - beforeRetry;
      const totalRecoveryRequests = afterSuccess.recoveryRequests - beforeRecovery;
      expect(totalRecoveryRequests).toBeLessThanOrEqual(DEFAULT_D2_RPC_RECOVERY_RESERVE);
      expect(successfulRecoveryRequests).toBeGreaterThan(0);
      expect(successfulRecoveryRequests).toBeLessThanOrEqual(DEFAULT_D2_RPC_RECOVERY_RESERVE);
      expect(afterSuccess.recoveryRequests).toBeLessThanOrEqual(h.budget.recoveryReserve);
      expect(h.getRecovery()).toMatchObject({ reserved: false, receiptWrites: 1, status: 'CONFIRMED' });
      expect(BigInt(h.getRecovery()!.fees!)).toBeGreaterThan(0n);

      const rpcCallsAtSettlement = h.transport.calls.length;
      const repeated = await h.app.inject({ headers: h.operatorHeaders,
        method: 'POST', url: '/v1/production/executions/reconcile',
        payload: { proposalId: proposal.proposalId, operationId },
      });
      expect(repeated.statusCode).toBe(200);
      expect(h.getRecovery()?.receiptWrites).toBe(1);
      expect(h.transport.calls).toHaveLength(rpcCallsAtSettlement);
      expect(h.budget.snapshot().regularRequests).toBe(maxRegular);
    } finally { await h.close(); }
  });
});

describe('enabled D2 Rabby workflow integration', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('creates the browser workflow from the real reservation and read-only simulation; BLOCK, stale and mismatched inputs stay before Rabby', async () => {
    const h = setup({ browserWallet: true });
    const walletSubmissions = 0;
    try {
      await startSession(h);
      const proposal = await createProposal(h);
      const decision = await evaluate(h, proposal.proposalId);
      expect(['ALLOW', 'RESIZE']).toContain(decision.decision.status);
      await reserve(h, proposal.proposalId);
      const operationId = randomUUID();
      const allowance = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/allowance',
        payload: { proposalId: proposal.proposalId, operationId, sessionId: SESSION_ID } });
      expect(allowance.statusCode, JSON.stringify(allowance.json())).toBe(200);
      expect(allowance.json()).toMatchObject({ status: 'ALLOWANCE_SUFFICIENT', chainId: 8453, requiredAmountAtomic: '4000000' });
      const simulated = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/executions/simulate',
        payload: { proposalId: proposal.proposalId, sessionId: SESSION_ID, operationId } });
      expect(simulated.statusCode, JSON.stringify(simulated.json())).toBe(201);
      expect(simulated.json()).toMatchObject({ executionMode: 'READ_ONLY', authorizationCreated: false, signerInvocations: 0, broadcasterInvocations: 0 });
      expect(() => h.realG3c.getWorkflow(operationId)).toThrow();
      const prepared = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/prepare',
        payload: { proposalId: proposal.proposalId, operationId, sessionId: SESSION_ID } });
      expect(prepared.statusCode, JSON.stringify(prepared.json())).toBe(201);
      expect(prepared.json()).toMatchObject({ kind: 'SWAP', browserStage: 'READY', status: 'AUTHORIZED' });
      expect(h.realG3c.getWorkflow(operationId)).toMatchObject({ submissionMode: 'BROWSER_WALLET', browserStage: 'READY' });

      const mismatchedOperation = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/prepare',
        payload: { proposalId: proposal.proposalId, operationId: randomUUID(), sessionId: SESSION_ID } });
      expect(mismatchedOperation.statusCode).toBe(409);
      const wrongSession = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/begin',
        payload: { proposalId: proposal.proposalId, operationId, sessionId: randomUUID() } });
      expect(wrongSession.statusCode).toBe(409);
      h.setClock(new Date(NOW.getTime() + 16_000));
      const stale = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/begin',
        payload: { proposalId: proposal.proposalId, operationId, sessionId: SESSION_ID } });
      expect(stale.statusCode).toBe(409);
      expect(h.realG3c.getWorkflow(operationId)).toMatchObject({ status: 'AUTHORIZED', submissionAttempts: 0 });
      expect(walletSubmissions).toBe(0);
      h.setClock(new Date(NOW.getTime() + 11 * 60_000));
      const staleEvidence = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/begin',
        payload: { proposalId: proposal.proposalId, operationId, sessionId: SESSION_ID } });
      expect(staleEvidence.statusCode).toBe(409);
      expect(staleEvidence.json()).toMatchObject({ error: 'D2_BROWSER_CURRENT_NANSEN_EVIDENCE_REQUIRED' });
      expect(walletSubmissions).toBe(0);
      expect(h.getSignerCalls()).toBe(0);
      expect(h.getBroadcasterCalls()).toBe(0);
    } finally { await h.close(); }

    const blocked = setup({ browserWallet: true, netflowValue: '0' });
    try {
      await startSession(blocked);
      const proposal = await createProposal(blocked);
      const decision = await evaluate(blocked, proposal.proposalId);
      expect(decision.decision.status).toBe('BLOCK');
      const reservation = await blocked.app.inject({ headers: blocked.operatorHeaders, method: 'POST', url: '/v1/production/reservations',
        payload: { proposalId: proposal.proposalId, sessionId: SESSION_ID } });
      expect(reservation.statusCode).toBe(409);
      const begin = await blocked.app.inject({ headers: blocked.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/begin',
        payload: { proposalId: proposal.proposalId, operationId: randomUUID(), sessionId: SESSION_ID } });
      expect(begin.statusCode).toBe(409);
      expect(blocked.getSignerCalls()).toBe(0);
      expect(blocked.getBroadcasterCalls()).toBe(0);
      expect(walletSubmissions).toBe(0);
    } finally { await blocked.close(); }
  });

  it('performs exact Rabby approval, refreshes policy, then prepares and settles a distinct swap', async () => {
    const h = setup({ browserWallet: true, initialAllowance: 0n });
    const walletSend = vi.fn(async (transaction: G3bUnsignedTransaction, hash: Hex) => {
      h.transport.setKnownSubmission(hash, '0x02c0' as Hex, BigInt(transaction.nonce), transaction);
      return hash;
    });
    try {
      await startSession(h);
      const proposal = await createProposal(h, '4000000');
      const decision = await evaluate(h, proposal.proposalId);
      expect(['ALLOW', 'RESIZE']).toContain(decision.decision.status);
      await reserve(h, proposal.proposalId);
      const approvalOperationId = randomUUID();
      const allowance = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/allowance',
        payload: { proposalId: proposal.proposalId, operationId: approvalOperationId, sessionId: SESSION_ID } });
      expect(allowance.statusCode).toBe(200);
      expect(allowance.json()).toMatchObject({ status: 'APPROVAL_REQUIRED', currentAllowanceAtomic: '0', requiredAmountAtomic: '4000000' });
      const approval = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/approval/prepare',
        payload: { proposalId: proposal.proposalId, operationId: approvalOperationId, sessionId: SESSION_ID } });
      expect(approval.statusCode, JSON.stringify(approval.json())).toBe(201);
      expect(approval.json()).toMatchObject({ kind: 'APPROVAL', browserStage: 'READY', status: 'AUTHORIZED' });
      const approvalTx = approval.json().transaction as G3bUnsignedTransaction;
      expect(approvalTx.chainId).toBe(8453);
      expect(approvalTx.to.toLowerCase()).toBe(BASE_TOKENS.USDC.toLowerCase());
      expect(approvalTx.valueWei).toBe('0');
      expect(approvalTx.data.toLowerCase()).toContain(BASE_UNISWAP_V3.router.slice(2).toLowerCase());
      const armedApproval = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/begin',
        payload: { proposalId: proposal.proposalId, operationId: approvalOperationId, sessionId: SESSION_ID } });
      expect(armedApproval.statusCode).toBe(200);
      expect(armedApproval.json()).toMatchObject({ kind: 'APPROVAL', browserStage: 'SUBMISSION_UNCERTAIN', submissionAttempts: 1 });
      const approvalHash = ('0x' + 'cd'.repeat(32)) as Hex;
      expect(await walletSend(armedApproval.json().transaction as G3bUnsignedTransaction, approvalHash)).toBe(approvalHash);
      h.transport.setAllowance(4_000_000n);
      const approvalAttached = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/hash',
        payload: { proposalId: proposal.proposalId, operationId: approvalOperationId, transactionHash: approvalHash } });
      expect(approvalAttached.statusCode).toBe(200);
      const approvalReceipt = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/reconcile',
        payload: { proposalId: proposal.proposalId, operationId: approvalOperationId } });
      expect(approvalReceipt.statusCode, JSON.stringify(approvalReceipt.json())).toBe(200);
      expect(approvalReceipt.json()).toMatchObject({ kind: 'APPROVAL', status: 'CONFIRMED', browserStage: 'CONFIRMED', receiptOutcome: 'CONFIRMED' });
      expect(approvalReceipt.json().kind).not.toBe('SWAP');
      expect(h.realG3c.getWorkflow(approvalOperationId).kind).toBe('APPROVAL');
      expect(h.realG3c.getParent(proposal.proposalId).status).toBe('RESERVED');

      const completed = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/approval/complete',
        payload: { proposalId: proposal.proposalId, operationId: approvalOperationId, sessionId: SESSION_ID } });
      expect(completed.statusCode, JSON.stringify(completed.json())).toBe(200);
      expect(h.realG3c.getParent(proposal.proposalId).status).toBe('RELEASED');
      expect(h.transport.allowance()).toBe(4_000_000n);

      const nextProposal = await createProposal(h, '4000000');
      const nextDecision = await evaluate(h, nextProposal.proposalId);
      expect(['ALLOW', 'RESIZE']).toContain(nextDecision.decision.status);
      await reserve(h, nextProposal.proposalId);
      const swapOperationId = randomUUID();
      const simulation = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/executions/simulate',
        payload: { proposalId: nextProposal.proposalId, operationId: swapOperationId, sessionId: SESSION_ID } });
      expect(simulation.statusCode, JSON.stringify(simulation.json())).toBe(201);
      const swapPrepared = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/prepare',
        payload: { proposalId: nextProposal.proposalId, operationId: swapOperationId, sessionId: SESSION_ID } });
      expect(swapPrepared.statusCode, JSON.stringify(swapPrepared.json())).toBe(201);
      expect(swapPrepared.json()).toMatchObject({ kind: 'SWAP', browserStage: 'READY' });
      const swapArmed = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/begin',
        payload: { proposalId: nextProposal.proposalId, operationId: swapOperationId, sessionId: SESSION_ID } });
      expect(swapArmed.statusCode).toBe(200);
      const swapHash = ('0x' + 'ef'.repeat(32)) as Hex;
      await walletSend(swapArmed.json().transaction as G3bUnsignedTransaction, swapHash);
      const swapAttached = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/hash',
        payload: { proposalId: nextProposal.proposalId, operationId: swapOperationId, transactionHash: swapHash } });
      expect(swapAttached.statusCode).toBe(200);
      const settled = await h.app.inject({ headers: h.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/reconcile',
        payload: { proposalId: nextProposal.proposalId, operationId: swapOperationId } });
      expect(settled.statusCode, JSON.stringify(settled.json())).toBe(200);
      expect(settled.json()).toMatchObject({ kind: 'SWAP', status: 'CONFIRMED', browserStage: 'CONFIRMED', receiptOutcome: 'CONFIRMED' });
      expect(walletSend).toHaveBeenCalledTimes(2);
      expect(h.getSignerCalls()).toBe(0);
      expect(h.getBroadcasterCalls()).toBe(0);
    } finally { await h.close(); }
  });

  it('keeps uncertain approval reserved across reload, prevents a second begin, and rejects missing, expired, rejected, and reverted paths safely', async () => {
    const uncertain = setup({ browserWallet: true, initialAllowance: 0n });
    let uncertainClosed = false;
    try {
      await startSession(uncertain);
      const proposal = await createProposal(uncertain);
      await evaluate(uncertain, proposal.proposalId);
      await reserve(uncertain, proposal.proposalId);
      const operationId = randomUUID();
      const prepared = await uncertain.app.inject({ headers: uncertain.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/approval/prepare',
        payload: { proposalId: proposal.proposalId, operationId, sessionId: SESSION_ID } });
      expect(prepared.statusCode).toBe(201);
      const armed = await uncertain.app.inject({ headers: uncertain.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/begin',
        payload: { proposalId: proposal.proposalId, operationId, sessionId: SESSION_ID } });
      expect(armed.statusCode).toBe(200);
      const missingHash = await uncertain.app.inject({ headers: uncertain.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/hash',
        payload: { proposalId: proposal.proposalId, operationId } });
      expect(missingHash.statusCode).toBe(400);
      const duplicateBegin = await uncertain.app.inject({ headers: uncertain.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/begin',
        payload: { proposalId: proposal.proposalId, operationId, sessionId: SESSION_ID } });
      expect(duplicateBegin.statusCode).toBe(409);
      expect(uncertain.realG3c.getParent(proposal.proposalId).status).toBe('RESERVED');
      expect(uncertain.realG3c.getWorkflow(operationId)).toMatchObject({ status: 'SUBMISSION_UNCERTAIN', submissionAttempts: 1, transactionHash: null });

      await uncertain.close(true);
      uncertainClosed = true;
      const reopenedPaper = openPaperStore({ databasePath: uncertain.paperPath, clock: () => new Date(NOW) });
      const reopenedExecution = new ExecutionStore(reopenedPaper);
      const reopenedG3c = new G3cExecutionStore(reopenedExecution, uncertain.authority.trust, {}, () => new Date(NOW));
      try {
        expect(reopenedG3c.getWorkflow(operationId)).toMatchObject({ status: 'SUBMISSION_UNCERTAIN', submissionAttempts: 1, kind: 'APPROVAL' });
        expect(reopenedG3c.getParent(proposal.proposalId).status).toBe('RESERVED');
      } finally { reopenedExecution.close(); rmSync(uncertain.directory, { recursive: true, force: true }); }
    } finally { if (!uncertainClosed) await uncertain.close(); }

    const expired = setup({ browserWallet: true, initialAllowance: 0n });
    try {
      await startSession(expired);
      const proposal = await createProposal(expired);
      await evaluate(expired, proposal.proposalId);
      await reserve(expired, proposal.proposalId);
      const operationId = randomUUID();
      const prepared = await expired.app.inject({ headers: expired.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/approval/prepare',
        payload: { proposalId: proposal.proposalId, operationId, sessionId: SESSION_ID } });
      expect(prepared.statusCode).toBe(201);
      expired.setClock(new Date(NOW.getTime() + 60 * 60_000));
      const begin = await expired.app.inject({ headers: expired.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/begin',
        payload: { proposalId: proposal.proposalId, operationId, sessionId: SESSION_ID } });
      expect(begin.statusCode).toBe(409);
      expect(expired.realG3c.getWorkflow(operationId)).toMatchObject({ status: 'AUTHORIZED', submissionAttempts: 0 });
      expect(expired.realG3c.getParent(proposal.proposalId).status).toBe('RESERVED');
    } finally { await expired.close(); }

    const rejected = setup({ browserWallet: true, initialAllowance: 0n });
    try {
      await startSession(rejected);
      const proposal = await createProposal(rejected);
      await evaluate(rejected, proposal.proposalId);
      await reserve(rejected, proposal.proposalId);
      const operationId = randomUUID();
      await rejected.app.inject({ headers: rejected.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/approval/prepare',
        payload: { proposalId: proposal.proposalId, operationId, sessionId: SESSION_ID } });
      const response = await rejected.app.inject({ headers: rejected.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/reject',
        payload: { proposalId: proposal.proposalId, operationId, reason: 'USER_REJECTED' } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ kind: 'APPROVAL', browserStage: 'REJECTED', status: 'CANCELLED' });
      expect(rejected.realG3c.getParent(proposal.proposalId).status).toBe('RELEASED');
      expect(rejected.getSignerCalls()).toBe(0);
      expect(rejected.getBroadcasterCalls()).toBe(0);
    } finally { await rejected.close(); }

    const reverted = setup({ browserWallet: true, initialAllowance: 0n });
    try {
      await startSession(reverted);
      const proposal = await createProposal(reverted);
      await evaluate(reverted, proposal.proposalId);
      await reserve(reverted, proposal.proposalId);
      const operationId = randomUUID();
      const prepared = await reverted.app.inject({ headers: reverted.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/approval/prepare',
        payload: { proposalId: proposal.proposalId, operationId, sessionId: SESSION_ID } });
      const tx = prepared.json().transaction as G3bUnsignedTransaction;
      await reverted.app.inject({ headers: reverted.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/begin',
        payload: { proposalId: proposal.proposalId, operationId, sessionId: SESSION_ID } });
      const hash = ('0x' + '12'.repeat(32)) as Hex;
      reverted.transport.setKnownSubmission(hash, '0x02c0' as Hex, BigInt(tx.nonce), tx);
      reverted.transport.setReceiptStatus('0x0');
      const attached = await reverted.app.inject({ headers: reverted.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/hash',
        payload: { proposalId: proposal.proposalId, operationId, transactionHash: hash } });
      expect(attached.statusCode).toBe(200);
      const receipt = await reverted.app.inject({ headers: reverted.operatorHeaders, method: 'POST', url: '/v1/production/browser-executions/reconcile',
        payload: { proposalId: proposal.proposalId, operationId } });
      expect(receipt.statusCode).toBe(200);
      expect(receipt.json()).toMatchObject({ kind: 'APPROVAL', browserStage: 'REVERTED', status: 'REVERTED', receiptOutcome: 'REVERTED' });
      expect(receipt.json().kind).not.toBe('SWAP');
      expect(reverted.realG3c.getParent(proposal.proposalId).status).toBe('RELEASED');
      expect(reverted.getSignerCalls()).toBe(0);
      expect(reverted.getBroadcasterCalls()).toBe(0);
    } finally { await reverted.close(); }
  });
});
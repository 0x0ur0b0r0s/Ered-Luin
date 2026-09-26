import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { assertG3cEvidenceSourceFreshness, canonicalJson, g3cEvidenceAttestationSchema, g3cSignerMessageSchema, g3cSigningRequestSchema, type G3cEvidenceAttestation, type G3cSigningRequest } from '@ered-luin/contracts';
import { decodeFunctionData, getAddress, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, serializeTransaction, type Hex, type TransactionSerialized } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const WETH = getAddress('0x4200000000000000000000000000000000000006');
const ROUTER = getAddress('0x2626664c2603336E57B271c5C0b26F421741e481');
const POOL = getAddress('0xd0b53d9277642d899df5c87a3966a349a798f224');
const APPROVE_ABI = parseAbi(['function approve(address spender,uint256 value) returns (bool)']);
const ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)',
]);
type Trust = Readonly<{ environment: 'production' | 'synthetic-test'; publicKeys: Readonly<Record<string, string>> }>;
type Ledger = { readonly db: DatabaseSync; consume(claimId: string, requestId: string, operationId: string, at: string): void };
function reject(): never { throw new Error('G3C_SIGNER_REJECTED'); }
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function canonicalDate(value: string): boolean { const ms = Date.parse(value); return Number.isSafeInteger(ms) && new Date(ms).toISOString() === value; }
function unsignedNonce(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) return reject();
  const nonce = BigInt(value); if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) return reject(); return Number(nonce);
}
function assertExternal(value: string, repoRoot: string): string {
  if (!isAbsolute(value)) return reject();
  const path = resolve(value);
  const realRoot = resolve(realpathSync(repoRoot));
  const exists = existsSync(path);
  if (exists && lstatSync(path).isSymbolicLink()) return reject();
  const target = exists ? realpathSync(path) : resolve(realpathSync(dirname(path)), basename(path));
  const rel = relative(realRoot, target);
  if (rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))) return reject();
  return path;
}
function readTrust(mode: string, repoRoot: string): Trust {
  let keys: unknown;
  if (mode === 'test') keys = JSON.parse(process.env.ERED_LUIN_G3C_TEST_TRUST_KEYS ?? '{}');
  else {
    const trustPath = assertExternal(process.env.ERED_LUIN_G3C_TRUST_PATH ?? '', repoRoot);
    const stat = lstatSync(trustPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return reject();
    keys = JSON.parse(readFileSync(trustPath, 'utf8'));
  }
  if (!keys || typeof keys !== 'object' || Array.isArray(keys) || Object.values(keys).some((value) => typeof value !== 'string' || value.length > 8192)) return reject();
  return { environment: mode === 'test' ? 'synthetic-test' : 'production', publicKeys: keys as Record<string, string> };
}
function readPrivateKey(mode: string, repoRoot: string): Hex {
  let raw: string;
  if (mode === 'test') raw = process.env.ERED_LUIN_G3C_TEST_PRIVATE_KEY ?? '';
  else {
    const privatePath = assertExternal(process.env.ERED_LUIN_G3C_PRIVATE_KEY_PATH ?? '', repoRoot);
    const stat = lstatSync(privatePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return reject();
    raw = readFileSync(privatePath, 'utf8').trim();
  }
  if (!/^0x[0-9a-fA-F]{64}$/u.test(raw)) return reject();
  return raw as Hex;
}
function openLedger(path: string, repoRoot: string): Ledger {
  const statePath = assertExternal(path, repoRoot);
  if (existsSync(statePath)) { const stat = lstatSync(statePath); if (!stat.isFile() || stat.isSymbolicLink()) return reject(); }
  else { const fd = openSync(statePath, 'wx', 0o600); closeSync(fd); }
  const db = new DatabaseSync(statePath);
  db.exec('PRAGMA journal_mode = WAL'); db.exec('PRAGMA synchronous = FULL'); db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS g3c_signer_consumed_claims (
    claim_id TEXT PRIMARY KEY CHECK(length(claim_id)=36), request_id TEXT NOT NULL UNIQUE CHECK(length(request_id)=36),
    operation_id TEXT NOT NULL CHECK(length(operation_id)=36), consumed_at TEXT NOT NULL
  ) STRICT`);
  const integrity = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined;
  const columns = (db.prepare('PRAGMA table_info(g3c_signer_consumed_claims)').all() as Record<string, unknown>[]).map((row) => row.name);
  const objects = db.prepare("SELECT type,name FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%'")
    .all() as Record<string, unknown>[];
  const indexes = db.prepare('PRAGMA index_list(g3c_signer_consumed_claims)').all() as Record<string, unknown>[];
  if (integrity?.integrity_check !== 'ok' || columns.join(',') !== 'claim_id,request_id,operation_id,consumed_at' ||
      objects.length !== 1 || objects[0]?.type !== 'table' || objects[0]?.name !== 'g3c_signer_consumed_claims' ||
      indexes.length !== 2 || indexes.some((index) => index.unique !== 1)) return reject();
  return { db, consume(claimId, requestId, operationId, at) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const prior = db.prepare('SELECT claim_id FROM g3c_signer_consumed_claims WHERE claim_id = ? OR request_id = ?').get(claimId, requestId);
      if (prior) return reject();
      db.prepare('INSERT INTO g3c_signer_consumed_claims (claim_id,request_id,operation_id,consumed_at) VALUES (?,?,?,?)').run(claimId, requestId, operationId, at);
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* preserve trigger */ } throw error; }
  } };
}
function verifyAttestation(value: unknown, trust: Trust, nowMs: number, requireFresh = true): G3cEvidenceAttestation {
  const checked = g3cEvidenceAttestationSchema.safeParse(value); if (!checked.success) return reject();
  const payload = checked.data.payload;
  if (payload.environment !== trust.environment || payload.serviceId !== 'ered-luin-g3c-evidence') return reject();
  const pem = trust.publicKeys[payload.keyId]; if (!pem) return reject();
  try { if (!verify(null, Buffer.from(canonicalJson(payload)), createPublicKey(pem), Buffer.from(checked.data.signature.slice(2), 'hex'))) return reject(); }
  catch { return reject(); }
  const observed = Date.parse(payload.observedAt); const expiry = Date.parse(payload.expiresAt);
  if (!canonicalDate(payload.observedAt) || !canonicalDate(payload.expiresAt) || observed > nowMs ||
      expiry <= observed || expiry - observed > 15_000 || (requireFresh && expiry <= nowMs)) return reject();
  try { assertG3cEvidenceSourceFreshness(payload, nowMs); } catch { return reject(); }
  return checked.data;
}
function accountPayload(evidence: G3cEvidenceAttestation) {
  const p = evidence.payload; if (p.kind !== 'ACCOUNT_SNAPSHOT') return reject();
  if (BigInt(p.usdcValueUsdcMicros) !== BigInt(p.usdcBalanceAtomic) ||
      BigInt(p.walletValueUsdcMicros) !== BigInt(p.usdcValueUsdcMicros) + BigInt(p.wethValueUsdcMicros) + BigInt(p.gasValueUsdcMicros) ||
      p.blockNumber !== p.valuationBlockNumber || p.blockHash.toLowerCase() !== p.valuationBlockHash.toLowerCase()) return reject();
  return p;
}
function sameAccount(a: ReturnType<typeof accountPayload>, b: ReturnType<typeof accountPayload>): boolean {
  const fields = (v: ReturnType<typeof accountPayload>) => [v.walletAddress.toLowerCase(), v.chainId, v.accountVersion, v.pendingNonce,
    v.usdcBalanceAtomic, v.wethBalanceAtomic, v.gasBalanceNativeWei, v.allowanceToken.toLowerCase(),
    v.allowanceSpender.toLowerCase(), v.allowanceAtomic, v.usdcValueUsdcMicros, v.wethValueUsdcMicros,
    v.gasValueUsdcMicros, v.walletValueUsdcMicros, v.valuationPool.toLowerCase()];
  return canonicalJson(fields(a)) === canonicalJson(fields(b));
}
function unsignedTxHash(tx: G3cSigningRequest['workflow']['unsignedTransaction']): Hex {
  return keccak256(serializeTransaction({ type: 'eip1559', chainId: tx.chainId, nonce: unsignedNonce(tx.nonce), gas: BigInt(tx.gasLimit),
    maxFeePerGas: BigInt(tx.maxFeePerGasWei), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGasWei), to: getAddress(tx.to),
    value: BigInt(tx.valueWei), data: tx.data as Hex, accessList: [] }));
}
function evidenceDigest(value: G3cEvidenceAttestation): string { return hash(canonicalJson(g3cEvidenceAttestationSchema.parse(value))); }
function validateRequest(request: G3cSigningRequest, trust: Trust, nowMs: number): void {
  const { parent, workflow, session } = request; const tx = workflow.unsignedTransaction;
  if (request.killSwitch.stopped || !canonicalDate(request.requestAt) || Math.abs(nowMs - Date.parse(request.requestAt)) > 5_000 ||
      !workflow.claimedAt || !canonicalDate(workflow.claimedAt) || Date.parse(workflow.claimedAt) > nowMs ||
      Date.parse(parent.intent.expiresAt) <= nowMs || Date.parse(workflow.intentExpiresAt) <= nowMs || session.status !== 'ACTIVE' ||
      session.walletAddress.toLowerCase() !== parent.walletAddress.toLowerCase() || workflow.status !== 'SIGNING_CLAIMED' ||
      workflow.signingClaimId !== request.signingClaimId || workflow.accountVersion !== request.accountVersion ||
      parent.status !== 'RESERVED' || parent.simulation || parent.authorization || parent.signingClaim || parent.signedOutbox || parent.receipt ||
      parent.executionId !== workflow.executionId || parent.intentId !== workflow.intentId || parent.decisionId !== workflow.decisionId ||
      parent.reservationId !== workflow.reservationId || parent.decision.approvedAmountIn !== parent.transaction.amountIn ||
      !['ALLOW','RESIZE'].includes(parent.decision.status) || Date.parse(parent.decision.evaluatedAt) > nowMs || nowMs - Date.parse(parent.decision.evaluatedAt) > 60_000 ||
      parent.walletAddress.toLowerCase() !== tx.from.toLowerCase() || tx.chainId !== 8453 || tx.accessList.length !== 0) return reject();
  const accountEvidence = verifyAttestation(workflow.accountSnapshot, trust, nowMs);
  const signSnapshotEvidence = verifyAttestation(workflow.signingAccountSnapshot, trust, nowMs);
  const sessionSnapshotEvidence = session.latestSnapshot ? verifyAttestation(session.latestSnapshot, trust, nowMs) : reject();
  const quoteEvidence = workflow.quote ? verifyAttestation(workflow.quote, trust, nowMs) : null;
  const simulationEvidence = verifyAttestation(workflow.simulation, trust, nowMs);
  const feeEvidence = verifyAttestation(workflow.fee, trust, nowMs);
  const account = accountPayload(accountEvidence); const current = accountPayload(signSnapshotEvidence);
  const sessionAccount = accountPayload(sessionSnapshotEvidence);
  let fundingAdjustments = 0n;
  const fundingDigests = new Set<string>();
  for (const adjustment of session.externalFundingAdjustments) {
    const sourceEvidence = verifyAttestation(adjustment.sourceEvidence, trust, nowMs, false);
    const source = sourceEvidence.payload;
    if (source.kind !== 'FUNDING_ADJUSTMENT' || source.walletAddress.toLowerCase() !== session.walletAddress.toLowerCase() ||
        evidenceDigest(sourceEvidence) !== adjustment.sourceDigest || fundingDigests.has(adjustment.sourceDigest)) return reject();
    const delta = BigInt(source.amountAtomic) * (source.direction === 'DEPOSIT' ? 1n : -1n);
    if (delta !== BigInt(adjustment.deltaUsdcMicros)) return reject();
    fundingDigests.add(adjustment.sourceDigest); fundingAdjustments += delta;
  }
  const expectedEquity = BigInt(session.initialEquityUsdcMicros) + fundingAdjustments -
    BigInt(session.realizedLossUsdcMicros) - BigInt(session.realizedFeesUsdcMicros);
  const expectedUnrealizedLoss = expectedEquity > BigInt(sessionAccount.walletValueUsdcMicros)
    ? expectedEquity - BigInt(sessionAccount.walletValueUsdcMicros) : 0n;
  if (!sameAccount(account, current) || !sameAccount(account, sessionAccount) ||
      evidenceDigest(sessionSnapshotEvidence) !== session.latestSnapshotDigest ||
      session.latestAccountVersion !== workflow.accountVersion || expectedUnrealizedLoss !== BigInt(session.unrealizedLossUsdcMicros) ||
      current.accountVersion !== workflow.accountVersion || current.walletAddress.toLowerCase() !== parent.walletAddress.toLowerCase() ||
      current.blockFinality !== 'unsafe' && current.blockFinality !== 'safe' && current.blockFinality !== 'finalized' || current.pendingNonce !== tx.nonce ||
      BigInt(current.walletValueUsdcMicros) <= 0n || BigInt(current.walletValueUsdcMicros) > 25_000_000n ||
      account.allowanceSpender.toLowerCase() !== ROUTER.toLowerCase() || account.valuationPool.toLowerCase() !== POOL.toLowerCase() ||
      BigInt(session.outstandingWorstCaseReservationsUsdcMicros) < BigInt(workflow.reservedWorstCaseLossUsdcMicros) ||
      BigInt(session.realizedLossUsdcMicros) + BigInt(session.realizedFeesUsdcMicros) + BigInt(session.unrealizedLossUsdcMicros) +
        BigInt(session.outstandingWorstCaseReservationsUsdcMicros) > 2_000_000n ||
      BigInt(parent.reservationExposureUsdcMicros) > 5_000_000n || BigInt(tx.maxFeePerGasWei) > BigInt(parent.transaction.maxFeePerGasWei) ||
      BigInt(tx.maxPriorityFeePerGasWei) > BigInt(parent.transaction.maxPriorityFeePerGasWei) ||
      BigInt(tx.gasLimit) * BigInt(tx.maxFeePerGasWei) > BigInt(parent.transaction.maxTotalFeeWei)) return reject();
  if (workflow.transactionDigest !== hash(canonicalJson({ version: 1, executionId: workflow.executionId, operationId: workflow.operationId,
      kind: workflow.kind, transaction: tx, accountSnapshot: evidenceDigest(workflow.accountSnapshot),
      quote: workflow.quote ? evidenceDigest(workflow.quote) : null, simulation: evidenceDigest(workflow.simulation), fee: evidenceDigest(workflow.fee) }))) return reject();
  const sim = simulationEvidence.payload; const fee = feeEvidence.payload; const txHash = unsignedTxHash(tx);
  if (sim.kind !== 'SIMULATION' || sim.executionId !== workflow.executionId || sim.operationId !== workflow.operationId || sim.chainId !== 8453 ||
      sim.transactionDigest !== hash(canonicalJson(tx)) || sim.unsignedTransactionHash.toLowerCase() !== txHash.toLowerCase() || sim.outcome !== 'PASSED' ||
      sim.blockNumber !== account.blockNumber || sim.blockHash.toLowerCase() !== account.blockHash.toLowerCase() ||
      BigInt(sim.gasEstimate) > BigInt(tx.gasLimit) || BigInt(sim.revertGasEstimate) > BigInt(tx.gasLimit) ||
      fee.kind !== 'BASE_FEE' || fee.executionId !== workflow.executionId || fee.operationId !== workflow.operationId || fee.chainId !== 8453 ||
      fee.unsignedTransactionHash.toLowerCase() !== txHash.toLowerCase() || fee.blockNumber !== account.blockNumber ||
      fee.blockHash.toLowerCase() !== account.blockHash.toLowerCase() || fee.gasLimit !== tx.gasLimit || fee.maxFeePerGasWei !== tx.maxFeePerGasWei ||
      BigInt(fee.executionGasFeeCapWei) !== BigInt(fee.gasLimit) * BigInt(fee.maxFeePerGasWei) ||
      BigInt(fee.totalFeeWei) !== BigInt(fee.executionGasFeeCapWei) + BigInt(fee.l1DataFeeWei) + BigInt(fee.operatorFeeWei) + BigInt(fee.safetyMarginWei) ||
      fee.includesRevertPath !== true || BigInt(fee.valueUsdcMicros) > 250_000n ||
      BigInt(fee.totalFeeWei) > BigInt(parent.transaction.maxTotalFeeWei) ||
      BigInt(current.gasBalanceNativeWei) < BigInt(fee.totalFeeWei) + BigInt(tx.valueWei)) return reject();
  const tokenIn = parent.intent.sellAsset === 'USDC' ? USDC : WETH;
  const tokenOut = parent.intent.buyAsset === 'USDC' ? USDC : WETH;
  const available = parent.intent.sellAsset === 'USDC' ? account.usdcBalanceAtomic : account.wethBalanceAtomic;
  if (BigInt(available) < BigInt(parent.transaction.amountIn) || account.allowanceToken.toLowerCase() !== tokenIn.toLowerCase() ||
      parent.transaction.amountIn !== parent.decision.approvedAmountIn) return reject();
  let tradeLoss = 0n; let slippage = 0; let impact = 0;
  if (workflow.kind === 'APPROVAL') {
    if (workflow.quote || BigInt(account.allowanceAtomic) >= BigInt(parent.transaction.amountIn) || tx.to.toLowerCase() !== tokenIn.toLowerCase() || tx.valueWei !== '0') return reject();
    const approval = decodeFunctionData({ abi: APPROVE_ABI, data: tx.data as Hex });
    if (approval.functionName !== 'approve' || !approval.args || getAddress(approval.args[0]).toLowerCase() !== ROUTER.toLowerCase() ||
        approval.args[1] !== BigInt(parent.transaction.amountIn)) return reject();
  } else {
    if (!quoteEvidence || quoteEvidence.payload.kind !== 'QUOTE' || BigInt(account.allowanceAtomic) < BigInt(parent.transaction.amountIn) || tx.to.toLowerCase() !== ROUTER.toLowerCase()) return reject();
    const quote = quoteEvidence.payload;
    if (quote.executionId !== workflow.executionId || quote.operationId !== workflow.operationId || quote.chainId !== 8453 ||
        quote.poolAddress.toLowerCase() !== POOL.toLowerCase() || quote.fee !== 500 || quote.tokenIn.toLowerCase() !== tokenIn.toLowerCase() ||
        quote.tokenOut.toLowerCase() !== tokenOut.toLowerCase() || quote.amountIn !== parent.transaction.amountIn || quote.slippageBps > 50 || quote.priceImpactBps > 50 ||
        BigInt(quote.minimumAmountOut) !== BigInt(quote.amountOut) * BigInt(10_000 - quote.slippageBps) / 10_000n ||
        tx.valueWei !== parent.transaction.valueNativeWei || quote.blockNumber !== account.blockNumber || quote.blockHash.toLowerCase() !== account.blockHash.toLowerCase()) return reject();
    const outer = decodeFunctionData({ abi: ROUTER_ABI, data: tx.data as Hex });
    if (outer.functionName !== 'multicall' || !outer.args || outer.args[1].length !== 1) return reject();
    const [deadline, calls] = outer.args;
    const inner = decodeFunctionData({ abi: ROUTER_ABI, data: calls[0]! });
    if (inner.functionName !== 'exactInputSingle') return reject();
    const args = inner.args[0];
    if (deadline !== BigInt(Math.floor(Date.parse(parent.intent.expiresAt) / 1000)) || deadline * 1000n <= BigInt(nowMs) ||
        getAddress(args.tokenIn).toLowerCase() !== tokenIn.toLowerCase() || getAddress(args.tokenOut).toLowerCase() !== tokenOut.toLowerCase() ||
        args.fee !== 500 || getAddress(args.recipient).toLowerCase() !== parent.walletAddress.toLowerCase() ||
        args.amountIn !== BigInt(parent.transaction.amountIn) || args.amountOutMinimum !== BigInt(quote.minimumAmountOut) || args.sqrtPriceLimitX96 !== 0n) return reject();
    slippage = quote.slippageBps; impact = quote.priceImpactBps;
    tradeLoss = (BigInt(parent.reservationExposureUsdcMicros) * BigInt(slippage + impact) + 9_999n) / 10_000n;
  }
  const projectedWeth = parent.intent.buyAsset === 'WETH' ? BigInt(account.wethValueUsdcMicros) + BigInt(parent.reservationExposureUsdcMicros) :
    BigInt(account.wethValueUsdcMicros) > BigInt(parent.reservationExposureUsdcMicros) ? BigInt(account.wethValueUsdcMicros) - BigInt(parent.reservationExposureUsdcMicros) : 0n;
  const worstCase = tradeLoss + BigInt(fee.valueUsdcMicros);
  if (projectedWeth > 10_000_000n || worstCase > BigInt(workflow.reservedWorstCaseLossUsdcMicros) ||
      (workflow.kind === 'SWAP' && (slippage > 50 || impact > 50))) return reject();
}
function signSerialized(value: unknown, trust: Trust, privateKey: Hex, hmacKey: Buffer, ledger: Ledger) {
  const checked = g3cSignerMessageSchema.safeParse(value); if (!checked.success) return reject();
  const expected = createHmac('sha256', hmacKey).update(canonicalJson(checked.data.payload)).digest();
  const supplied = Buffer.from(checked.data.mac, 'hex');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return reject();
  const request = g3cSigningRequestSchema.parse(checked.data.payload);
  // Synthetic tests use an injected store clock; the authenticated request timestamp is authoritative only in test mode.
  const now = process.env.ERED_LUIN_G3C_MODE === 'test' ? Date.parse(request.requestAt) : Date.now();
  if (!Number.isSafeInteger(now)) return reject();
  validateRequest(request, trust, now);
  const tx = request.workflow.unsignedTransaction; const account = privateKeyToAccount(privateKey);
  if (account.address.toLowerCase() !== tx.from.toLowerCase()) return reject();
  ledger.consume(request.signingClaimId, request.requestId, request.workflow.operationId, new Date(now).toISOString());
  return account.signTransaction({ type: 'eip1559', chainId: tx.chainId, nonce: unsignedNonce(tx.nonce), gas: BigInt(tx.gasLimit),
    maxFeePerGas: BigInt(tx.maxFeePerGasWei), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGasWei), to: getAddress(tx.to),
    value: BigInt(tx.valueWei), data: tx.data as Hex, accessList: [] }).then(async (signedBytesHex) => {
      const serialized = signedBytesHex as TransactionSerialized; const decoded = parseTransaction(serialized);
      if (decoded.type !== 'eip1559' || decoded.chainId !== tx.chainId || decoded.nonce !== unsignedNonce(tx.nonce) ||
          decoded.gas !== BigInt(tx.gasLimit) || decoded.maxFeePerGas !== BigInt(tx.maxFeePerGasWei) ||
          decoded.maxPriorityFeePerGas !== BigInt(tx.maxPriorityFeePerGasWei) || decoded.to?.toLowerCase() !== tx.to.toLowerCase() ||
          (decoded.value ?? 0n) !== BigInt(tx.valueWei) || decoded.data?.toLowerCase() !== tx.data.toLowerCase() ||
          (decoded.accessList?.length ?? 0) !== 0 || (await recoverTransactionAddress({ serializedTransaction: serialized })).toLowerCase() !== tx.from.toLowerCase()) return reject();
      return { signedBytesHex: signedBytesHex.toLowerCase(), transactionHash: keccak256(serialized) };
    });
}

let state: { readonly trust: Trust; readonly privateKey: Hex; readonly hmacKey: Buffer; readonly ledger: Ledger } | null = null;
try {
  const mode = process.env.ERED_LUIN_G3C_MODE; const repoRoot = process.env.ERED_LUIN_G3C_REPOSITORY_ROOT ?? '';
  if (mode !== 'test' && mode !== 'production') reject();
  if (mode === 'test' && process.env.NODE_ENV !== 'test') reject();
  if (mode === 'production' && (process.env.LIVE_EXECUTION_ENABLED !== 'true' || process.env.EXECUTION_MODE !== 'live-reviewed' || process.env.G3C_REVIEWED_MODE !== 'true')) reject();
  const rawHmac = process.env.ERED_LUIN_G3C_HMAC_KEY ?? '';
  if (!/^(?:[0-9a-fA-F]{2})+$/u.test(rawHmac)) reject();
  const hmacKey = Buffer.from(rawHmac, 'hex'); if (hmacKey.length < 32) reject();
  const trust = readTrust(mode, repoRoot); const privateKey = readPrivateKey(mode, repoRoot);
  state = { trust, privateKey, hmacKey, ledger: openLedger(process.env.ERED_LUIN_G3C_STATE_PATH ?? '', repoRoot) };
} catch { process.exitCode = 1; }
if (state) {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    if (line.length > 300_000) { process.stdout.write(JSON.stringify({ ok: false }) + '\n'); return; }
    try {
      void Promise.resolve(signSerialized(JSON.parse(line) as unknown, state!.trust, state!.privateKey, state!.hmacKey, state!.ledger))
        .then((result) => process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n'))
        .catch(() => process.stdout.write(JSON.stringify({ ok: false }) + '\n'));
    } catch { process.stdout.write(JSON.stringify({ ok: false }) + '\n'); }
  });
}

import { BASE_TOKENS } from './base-allowlist.js';
import type { G3cExecutionStore } from './g3c-execution-store.js';
import type { D2PolicyProvider } from './d2-production.js';
import type { PaperAccountSnapshot } from './policy.js';
import type { ExecutionTransactionEnvelope, G3cEvidenceAttestation, TradeIntent } from '@ered-luin/contracts';
import { assertFreshG3cEvidence, verifyG3cEvidenceAttestation, type G3cEvidenceTrust } from './g3c-evidence.js';
import type { G3cReadOnlyBaseProvider } from './g3c-base-provider.js';

interface CachedAccount { readonly evidence: G3cEvidenceAttestation; readonly sessionId: string; }
interface CachedPlan { readonly transaction: ExecutionTransactionEnvelope; readonly createdAt: number; }
function key(wallet: string, version: number, amount: string): string { return wallet.toLowerCase() + ':' + version + ':' + amount; }
function signedTotal(session: ReturnType<G3cExecutionStore['getSession']>): string {
  return session.externalFundingAdjustments.reduce((total, item) => total + BigInt(item.deltaUsdcMicros), 0n).toString();
}

export class BaseD2PolicyProvider implements D2PolicyProvider {
  private readonly accounts = new Map<string, CachedAccount>();
  private readonly plans = new Map<string, CachedPlan>();
  constructor(private readonly input: {
    readonly provider: G3cReadOnlyBaseProvider;
    readonly store: G3cExecutionStore;
    readonly trust: G3cEvidenceTrust;
    readonly clock?: () => Date;
  }) {}

  getSignals(): readonly unknown[] { return Object.freeze([]); }

  async getAccountSnapshot(intent: TradeIntent, sessionId?: string): Promise<PaperAccountSnapshot | null> {
    if (!sessionId) return null;
    const session = this.input.store.getSession(sessionId);
    if (session.status !== 'ACTIVE' || session.walletAddress.toLowerCase() !== intent.walletAddress.toLowerCase()) return null;
    const accountVersion = session.latestAccountVersion + 1;
    if (!Number.isSafeInteger(accountVersion) || accountVersion < 1) return null;
    const evidence = await this.input.provider.account(intent.walletAddress, BASE_TOKENS.USDC, accountVersion, 'unsafe');
    const checked = verifyG3cEvidenceAttestation(evidence, this.input.trust);
    const now = (this.input.clock ?? (() => new Date()))();
    if (!(now instanceof Date) || !Number.isSafeInteger(now.getTime())) throw new Error('D2_CLOCK_INVALID');
    assertFreshG3cEvidence(checked, now.getTime());
    if (checked.payload.kind !== 'ACCOUNT_SNAPSHOT' || checked.payload.walletAddress.toLowerCase() !== intent.walletAddress.toLowerCase()) {
      throw new Error('D2_BASE_ACCOUNT_INVALID');
    }
    this.accounts.set(intent.walletAddress.toLowerCase() + ':' + checked.payload.accountVersion, { evidence: checked, sessionId });
    return Object.freeze({
      walletAddress: checked.payload.walletAddress, version: checked.payload.accountVersion,
      usdcBalanceAtomic: checked.payload.usdcBalanceAtomic, wethBalanceAtomic: checked.payload.wethBalanceAtomic,
      gasBalanceNativeWei: checked.payload.gasBalanceNativeWei,
      utcDay: now.toISOString().slice(0, 10), dailyStartEquityUsdcMicros: session.initialEquityUsdcMicros,
      dailyFundingUsdcMicros: signedTotal(session),
    });
  }

  async getQuoteBundle(intent: TradeIntent, account: PaperAccountSnapshot): Promise<unknown> {
    const context = this.accounts.get(intent.walletAddress.toLowerCase() + ':' + account.version);
    if (!context) return null;
    const now = (this.input.clock ?? (() => new Date()))();
    if (!(now instanceof Date) || !Number.isSafeInteger(now.getTime())) return null;
    const checked = verifyG3cEvidenceAttestation(context.evidence, this.input.trust);
    assertFreshG3cEvidence(checked, now.getTime());
    const plan = await this.input.provider.policyQuoteBundle({ intent, accountSnapshot: checked });
    this.plans.set(key(intent.walletAddress, account.version, intent.amountIn), { transaction: plan.executionTransaction, createdAt: now.getTime() });
    return plan.quotes;
  }

  getExecutionTransaction(intent: TradeIntent, accountVersion: number): ExecutionTransactionEnvelope | null {
    const plan = this.plans.get(key(intent.walletAddress, accountVersion, intent.amountIn));
    const now = (this.input.clock ?? (() => new Date()))();
    if (!plan || !(now instanceof Date) || !Number.isSafeInteger(now.getTime()) || now.getTime() < plan.createdAt ||
        now.getTime() - plan.createdAt > 10_000) return null;
    return plan.transaction;
  }

  close(): void {
    this.accounts.clear();
    this.plans.clear();
    this.input.provider.close();
  }
}

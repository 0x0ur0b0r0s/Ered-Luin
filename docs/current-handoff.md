# Current handoff

## Deadline live-demo task — latest status, 2026-09-27 13:25 EDT (UTC−04:00)

The separate bounded historical runner finished its 251-job manifest with 251 successful HTTP requests, 251 reported credits, and no failed or unknown attempts. Its useful windows are exhausted. The conservative verified total is 801 unique HTTP successes (baseline 550 plus 251), 249 short of the internal 1,050 target and 199 short of the stricter 1,000-call campaign-page requirement. Organizer qualification remains unconfirmed. The previous D2l process remains failed with one unknown charge reserved; its accounting is unchanged.

The deadline implementation is ready for Astra review: browser-mediated Rabby flow, distinct durable browser-wallet state, exact transaction and receipt checks, and offline regressions. Runtime activation remains false. Loopback API/dashboard checks confirmed paper/read-only mode, Nansen disabled and zero-budget, live execution disabled, browser wallet disabled, signing disabled, and submission disabled. The application serves locally at http://127.0.0.1:5173/; it is not externally deployed.

Historical OHLCV is stale, so there is no current evidence to approve or record a live trade. No wallet was asked to sign, no transaction or receipt exists, and no recording, post, or entry submission was made. The available local walkthrough is synthetic and explicitly labeled. See docs/deadline-demo-package.md for the rehearsal steps, recording timeline, X draft, and external checklist. The unresolved previous-run charge remains untouched.

Updated: 2026-09-27 13:25 EDT (UTC−04:00).

## D2l research collector

The single read-only status check on 2026-09-27 at 10:28 EDT reported the existing weth-research-v2 process as FAILED and not alive. The manifest's last update was 08:54:52 EDT. It records 544 successful HTTP requests (272 per endpoint), 545 aggregate qualifying successes including one operator attestation, 548 attempts, 1,635 reported credits, 1,636 allocated credits, and one unknown charge; pending attempts are zero. The unknown remains reserved and is not counted as a success or charge reconciliation. No collector control, restart, ledger mutation, or additional status polling occurred in this task. Its original 850 target, 900-attempt/2,700-credit limits, and 17:00 EDT stop remain historical bounds; this task did not resume it.

The deadline delivery prompt's conservative provider-success baseline is 544, deduplicated by actual successful attempt IDs. Organizer-confirmed qualification remains unknown. The old run's unknown charge remains excluded from successes and blocks refresh against the shared store.
## D2u USDC raw-response attribution

At 2026-09-26 23:57:28 EST, the authorized continuation sent one additional Base USDC Token Screener request with the existing D2u allocation, exact prior request semantics, one page, and zero retries. It returned HTTP 200 and one reported credit. Those original and continuation requests used two credits. The same 3-credit/3-attempt D2u allocation later funded the single D2v OHLCV request; the combined allocation now records three attempts and three credits, zero remaining, and zero unknown or pending charges. See the D2v section below. The main app configuration was unchanged, the original exhausted seven-credit D2k ledger was preserved, the canonical cache was not evicted, and the shared observation-store lock was released.

The bounded raw response is 70 bytes and remains in create-only protected local state. Its safe structure is top-level `data` and `pagination`; `data` is an empty array, pagination reports page 1 of 100 items and a final page, and the alternate `results`, `tokens`, and `prices` containers are absent. There are no raw USDC address occurrences, candidate data rows, warnings, or errors. Exact replay of those bytes through the production normalizer completed successfully with no parser failure; it selected `/data`, found no USDC row, and emitted two `MISSING` placeholder signals. Evidence-specific attribution is **raw-provider-omission** for this response: `providerReturnedAddress=false`, `providerReturnedUsdcDataRow=false`, and `normalizerProducedUsdcDataRow=false`. This does not establish permanent provider coverage behavior. No schema alias or normalizer change is supported by this response.

The no-call readiness command still reports `PRICE_MISSING` (exit code 2 is its designed not-ready result). The raw request ID and capture details remain in the protected completion report. Astra can reproduce the parser replay without credentials or provider calls with `pnpm run d2u:raw-attribution:replay`.

## D2v Base USDC OHLCV price

At 2026-09-27 07:50:43 EDT (UTC−04:00), one authorized `POST /api/v1/tgm/token-ohlcv` request queried Base USDC over the ten-minute bounded `1m` window. It returned HTTP 200 and charged one credit; dispatch count was one, page bound one, retries zero. The response bytes were captured before parsing in protected external storage and replayed byte-for-byte through the production adapter. The exact request/response hashes and request ID remain in that protected report; no raw payload or price value is in this handoff.

The adapter normalized six sparse candles after the truncation metadata fix. The newest completed interval starts at 07:49 EDT; fetch time is 07:50:43 EDT. It was persisted with original attempt attribution through a no-cache store write, so the expired diagnostic response did not update or evict cache rows. Readiness returned `PRICE_STALE` (36m45s interval age at the 08:25:45 EDT check); it is not usable as fresh policy evidence. The standalone USDC Screener record and latest paired Screener record also had no usable USDC price. D2v did not alter WETH history.

The D2v store lock was released before the same D2l run resumed. The original exhausted seven-credit D2k ledger remains unchanged. No other D2v API calls, Alchemy/RPC requests, wallet actions, signing, broadcasts, or trades occurred.

## Wallet and policy

The read-only browser wallet panel now owns controller creation and disposal within the same effect, so StrictMode setup-cleanup-setup creates a live controller after replay. Offline component regressions cover replay and deferred chain-response cleanup on unmount. Signing and transaction submission remain unimplemented.

D2 production evidence uses a fresh, valid standalone USDC snapshot when available. If it is absent, stale, wrongly identified, or ambiguous, the reader may use exactly one complete fresh USDC price from the exact BASE_PAIR cache entry. Stale, incomplete, identity-mismatched, and duplicate signals do not become fresh evidence; policy remains fail-closed. No live USDC price was inferred from the earlier empty raw response.

## Validation and next action

- & .\tools\pnpm-node24.ps1 exec vitest run tools/d2u/raw-response-analysis.test.mjs apps/api/src/d2.test.ts apps/dashboard/src/browser-wallet-panel.test.tsx apps/dashboard/src/browser-wallet-controller.test.ts apps/dashboard/src/browser-wallet.test.ts apps/dashboard/src/d2-panel.test.tsx --reporter=dot — 6 files, 63/63 passed.
- & .\tools\pnpm-node24.ps1 --filter @ered-luin/api typecheck — passed.
- & .\tools\pnpm-node24.ps1 --filter @ered-luin/dashboard typecheck — passed.
- Focused ESLint for the six changed D2u source/test files — passed with zero warnings.

No workspace build ran, and no provider call, credential read, wallet action, accounting mutation, collector restart, signing, or broadcast occurred. TypeSafe was not used: the repaired decisions are deterministic, covered directly by offline regressions, and do not need semantic judgment.

D2u repairs were pending Astra review when this note was written; the scoped gate was later accepted in the section below. The D2l figures in that historical note were later refreshed in the collector section at the top. D1 review, provider/deployment readiness, and organizer qualification remain separate open work.

## Astra D2u review

The three requested repairs are implemented: StrictMode controller lifecycle replay and deferred cleanup; pagination completeness attribution across explicit cursor aliases with unknown/contradictory states indeterminate; and deterministic paired-source USDC fallback when the separate exact-cache entry is unusable. Focused validation passed 68/68 tests, both API and dashboard typechecks, and ESLint. The original raw-response attribution remains specific to the captured final empty response. That pending status was superseded by the accepted D2u record below. See docs/reviews/D2u-astra-review.md for the findings and docs/build-state.md for the validation record.

## Astra D2u repair acceptance — September 27, Eastern Time

The three D2u repair findings are accepted after independent source review and 68/68 affected offline tests. See docs/reviews/D2u-repair-acceptance.md. Earlier pending-acceptance text is superseded for this scoped gate. USDC pricing remains unresolved; Rabby submission and full live readiness remain unaccepted. No collector or accounting state changed. The raw response contained zero data items; per_page=100 is page capacity, not a returned count.

## D2v validation addendum — 2026-09-27 08:28 EDT (UTC−04:00)

- `& .\tools\pnpm-node24.ps1 run test:d2v` — build passed; 7 files, 109/109 tests passed.
- Nansen, API, and dashboard typechecks passed; focused ESLint passed with zero warnings.
- `& .\tools\pnpm-node24.ps1 run d2v:raw-replay` — normalized and persisted the protected response, with zero provider calls and no credential read.
- `& .\tools\pnpm-node24.ps1 run d2v:readiness` — returned `PRICE_STALE`, ready=false; its not-ready exit is expected.
- `git diff --check` reported no whitespace errors; only Windows line-ending normalization notices were emitted.

The workspace build produced a dashboard bundle, but no API/dashboard instance was verified serving it. `http://127.0.0.1:5173/` was unavailable and no API listener was found on the checked local ports. No app service was restarted. D2v is ready for Astra review; the older D2u pending-status paragraph above is historical and is superseded by the accepted D2u record below. The D2l collector remains RUNNING under its existing bounds; current counters are in the first section.

## Astra D2v repair review

The truncation-metadata and historical no-cache persistence repairs pass review; 109/109 affected tests passed independently without rebuilding. D2v operational acceptance remains pending a P2: the advertised refresh command is still tied to the consumed D2u ledger and existing one-shot markers, so a new allocation alone cannot run it. See docs/reviews/D2v-repair-review.md. Preserve the completed diagnostic and add a separately configured bounded refresh path. No additional provider calls or collector changes were made by Astra.

## D2v operational refresh repair — 2026-09-27 10:39 EDT

A separate external-allocation refresh CLI and PowerShell wrapper now exist; the original one-shot D2v diagnostic source, completed markers, and exhausted D2u/D2v ledger were not changed. The default CLI is a read-only, credential-free dry-run. Offline CLI regressions use temporary stores/ledgers and a fake provider boundary to verify one guarded request, raw capture, normalized/persisted price, zero-call cache reuse, invocation reuse rejection, shared-lock exclusion, original-allocation rejection, insufficient budget, unknown/pending/halted accounting, and secret sanitization. Five new offline tests passed. No provider call, external allocation, credential read, collector action, wallet action, or app restart occurred.

The operational instructions and clearly synthetic example are in docs/d2v-refresh-operations.md and docs/examples/d2v-refresh-config.synthetic.example.json. The real collector's unknown charge means its shared-store state is currently not eligible for refresh. The D2v operational repair is submitted as a review milestone; it has not received Astra acceptance. The stale captured OHLCV value remains non-current. This source change does not update the running app.

## Deadline demonstration work — in progress

The execution prompt prioritizes a bounded Nansen request runner and a user-custodied Rabby Base swap. Implementation, offline checks, live evidence, deployment, user signing, verified receipt, recording, and submission are tracked as separate states. No paid request or wallet transaction has been initiated by this task. The user's Nansen signature remains in Rabby; no agent-initiated transaction is allowed. The old unknown attempt remains unresolved and uncounted.
## Immediate paper-demo handoff — 2026-09-27 15:17 EDT

The dashboard and local API are available at `http://127.0.0.1:5173/?paperEvaluation=682d0a8f-16c4-45f9-9d08-8c35c0cdb6e7`. The durable evaluation is `REQUIRE_REVIEW`, paperFillCreated=false, because the demo has no current paper-account snapshot. Runtime flags: `NANSEN_API_ENABLED=false`, `NANSEN_CREDIT_BUDGET=0`, `EXECUTION_MODE=paper`, `LIVE_EXECUTION_ENABLED=false`; Base RPC, signing, broadcaster, browser wallet, and Rabby are disabled. API PID 37384 uses only the isolated demo stores and has no Nansen credential.

Counts: 201 total attempts, 200 confirmed HTTP 2xx successes, one no-status attempt preserved without retry, 205 allocated credits across three isolated demo ledgers. Latest actual WETH price is $2,696.29 observed 14:57:10 EDT and WETH one-hour netflow is $0 observed 14:57:12 EDT. The 15:14:41 EDT USDC price request returned MISSING; the older OHLCV candle is stale. Evidence freshness is stale. Do not describe the screen as a fresh ALLOW/RESIZE/BLOCK decision or trade-ready. The prior D2l ledger remains untouched. A one-credit USDC refresh wrapper lives at `tools/deadline/refresh-paper-demo-usdc.ps1`.

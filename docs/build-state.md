# Build state

Last updated: 2026-09-27 13:25 EDT (UTC−04:00)

This is the public, repository-safe status summary. Detailed operator prompts, provider ledgers, credentials, run manifests, and private run reports are kept outside the public release.

## Deadline live-demo and API-completion status — 2026-09-27 13:25 EDT (UTC−04:00)

This entry supersedes older "in progress" statements later in this file for the deadline task. The 251-job bounded historical manifest is exhausted: 251 actual HTTP successes, 251 credits, zero failed/unknown attempts. The conservative total is 801 unique actual HTTP successes (baseline 550 + 251); this is 249 below the internal 1,050 target and 199 below the campaign page's 1,000-call figure. The earlier D2l run remains failed with one reserved unknown charge; its ledger and markers were not edited or reconciled. No current price evidence is available because the historical OHLCV is stale.

The browser-mediated Rabby/Base implementation and offline regressions are complete and ready for Astra review. Signing, submission, browser-wallet, paid Nansen, and live-execution gates remain off. The local API/dashboard are running on loopback; read-only runtime verification reported PAPER / PRODUCTION_READ_ONLY, paid calls false with budget 0, live execution false, and browser wallet/signing/submission false. The exact safe synthetic click path and recording script are in docs/deadline-demo-package.md. No live trade, receipt, recording, external deployment, X post, or entry form submission occurred.

Validation evidence for the deadline implementation: `pnpm --filter @ered-luin/api exec vitest run src --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --reporter=dot` passed 16 files / 167 tests; `pnpm run test:dashboard` passed 6 files / 36 tests; focused browser wallet tests passed 11/11 and focused G3c tests passed 19/19; `pnpm run test:deadline` passed 64/64; `pnpm run test:d2v` passed 109/109; `pnpm run build` and `pnpm run lint` passed; `git diff --check` passed with Windows line-ending normalization notices. Build output included the existing nonfatal Rollup/Zod annotation notices and the environment's Node 24.19.0 versus the declared >=24.20.0 engine warning. The campaign page says 1,000 calls while its official help article says 100+; use the stricter count pending organizer clarification. Local counts do not establish qualification.



## Accepted implementation

- G0 foundation and shared synthetic contracts.
- G1 credit accounting, provider normalization, and offline analysis gates.
- G2 deterministic policy and paper workflow.
- G3 bounded lifecycle, transaction, signer-boundary, and recovery work for offline scope.
- D1 local paper dashboard work.
- D2 offline/local implementation through the accepted D2l collector repairs.
- D2v Base USDC OHLCV integration and one approved bounded diagnostic; awaiting Astra review.

Acceptance of offline code does not accept production deployment, live provider readiness, signer custody, or live trading.

## Latest recorded validation

For the accepted D2l integration in the launch checkout:

- Workspace build passed; only the existing nonfatal Vite/Zod annotation notices were reported.
- The affected D2l/D2c/D2h/D2k suite passed, 48/48 tests.

The commands recorded for that integration were:

    & .\tools\pnpm-node24.ps1 run build
    & .\tools\pnpm-node24.ps1 exec vitest run tools/d2l tools/d2c tools/d2h tools/d2k --reporter=dot

Typecheck and lint were not rerun for that integration because the integrated source matched the accepted repair source. The preceding workspace checks had passed.

The D1 resize-clock repair had focused API regressions pass 10/10 and dashboard tests pass 12/12. Its latest full API suite result was 149/150: one synthetic Alchemy configuration test hit the default five-second timeout and passed when rerun alone with a longer timeout. Treat that timeout as an unresolved CI reliability issue, not as a full-suite pass.

These are recorded results from the prior gate work. They were not rerun as part of this documentation and GitHub preparation.

## Current bounded D2l research status

One read-only check at 2026-09-27 10:28 EDT found the existing weth-research-v2 process FAILED and not alive; manifest last update 08:54:52 EDT. Recorded: 544 successful HTTP requests, 545 aggregate qualifying successes including one operator attestation, 548 attempts, 1,635 reported credits, 1,636 allocated credits, one unknown charge, and zero pending attempts. The unknown stays reserved and uncounted. No restart, collector control, or accounting mutation occurred. Its prior 850 target, 900-attempt/2,700-credit limit, and 17:00 EDT hard stop remain the historical run bounds. The deadline prompt uses 544 unique actual HTTP successes as the conservative baseline; organizer-confirmed qualification remains unknown.
## D2u repair follow-up — 2026-09-27 06:08 EST

All three Astra findings have implementation and offline regressions: the wallet panel recreates its owned controller through StrictMode effect replay and cleans up deferred work on unmount; raw-response omission now requires complete, noncontradictory pagination evidence and covers cursor aliases; D2 production evidence prefers a valid fresh USDC-only cache entry and otherwise falls back to a fresh, complete, identity-matched, unambiguous USDC signal from the exact BASE_PAIR cache entry. Invalid, stale, incomplete, and ambiguous inputs remain fail-closed.

Validation passed: the focused D2u/browser/API Vitest command reported 6 files and 68/68 tests; API typecheck passed; dashboard typecheck passed; focused ESLint passed with zero warnings. No workspace build was run, preserving the review's instruction to avoid builds while the separate D2l collector is active. No paid provider request, wallet operation, trading action, or collector/accounting change was made. TypeSafe was not used because these are deterministic lifecycle, pagination, identity, and freshness rules.

At the time of this note, D2u was pending Astra acceptance; the scoped repair gate was subsequently accepted in the section below. At that time the D2l run's recorded status was 2026-09-27 04:30 EST (441 aggregate qualifying successes / 443 attempts; 1,323 charged and 1,377 remaining; zero unknown/pending). This repair work did not refresh the protected run manifest or ledger, so those figures are a last-verified snapshot rather than a current count.

## Pending work

- Obtain independent review of the D1 resize-clock repair and complete the manual visual dashboard pass.
- Complete the remaining D2 production-readiness review, including provider behavior, deployment configuration, signer custody, and operational recovery.
- Keep the active D2l run within its existing limits and hard stop; reconcile any new unknown charge before another resume. Its protected manifest and ledger are not part of this repository.
- Do not claim organizer-confirmed qualification from local HTTP success or synthetic test evidence.

## Limitations

- The checked-in templates keep paid provider calls off, but a separately provisioned operator configuration can enable a bounded research run.
- No claim of live trading readiness, profitability, market validity, or organizer qualification is made.
- Synthetic fixtures and mocks are for software validation only.
- Node's built-in SQLite API is currently marked as a release candidate by Node.js.

## D2u accepted — scoped repair review

Astra accepted the StrictMode lifecycle, pagination attribution and paired-source USDC fallback repairs; six affected suites passed 68/68. See docs/reviews/D2u-repair-acceptance.md. Acceptance does not supply the missing live USDC price or enable Rabby submission/live trading.

## D2v Base USDC OHLCV and operational refresh — pending Astra review

The previously approved one-call diagnostic at 07:50:43 EDT returned HTTP 200 and charged one credit. Its newest candle became stale and is not current price evidence. The original diagnostic remains preserved.

A separate external-allocation refresh CLI and DPAPI-backed PowerShell wrapper are implemented. Dry-run is the default and performs read-only configuration, ledger, store, allocation, and collector validation without credentials, lock acquisition, writes, or provider calls. Explicit dispatch uses one request maximum per unique invocation, one page, zero retries, a one-credit reservation, create-only markers, protected pre-parse raw capture, the production normalizer, and the canonical live-price cache. It rejects original/exhausted allocation reuse, identity conflicts, exhausted budgets, accounting uncertainty/halt, and occupied shared-store locks. The example config is synthetic; the external funded ledger is not created by this repair.

Offline CLI validation passed five tests, including one synthetic guarded dispatch, raw capture, usable-price persistence, fresh-cache no-call behavior, original marker/ledger byte preservation, reuse rejection, shared-lock exclusion, insufficient budget, pending/unknown/halted accounting, and secret sanitization. Nansen source was rebuilt once for the stable attempt-ID option. The operational guide is docs/d2v-refresh-operations.md. No paid API call, real credential read, allocation creation, collector control, or app restart occurred. The actual collector is FAILED with one reserved unknown charge, so a refresh sharing its observation store is blocked until evidence-backed resolution and a clean pause. The D2v repair is ready for Astra review, not accepted or deployed.
## Deadline demonstration task — in progress

The authorized deadline prompt's planned budget is a maximum 600 new credits/attempts across historical validation and live-evidence refreshes, with at least 30 credits held for demo evidence and combined allocated exposure no higher than the existing 2,700-credit envelope. These bounds are not a claim that any new calls have started. Current state remains 544 unique actual HTTP successes, 1,635 reported old-run credits, 1,636 allocated including the unknown, and one unknown attempt. Do not count the operator attestation or cache hits.

The bounded request runner, wallet-signed live flow, deployed app, user trade, receipt verification, recording, and submission package remain separate pending milestones. No transaction may be submitted by the agent; only the user confirms it in Rabby. No organizer qualification is claimed.
## Paper-demo live-data status — 2026-09-27 15:17 EDT

The isolated paper-demo collection completed 201 attempts: 200 confirmed HTTP 2xx responses and one attempt with no HTTP status (preserved, not retried). The original two segments account for 199 successes; one separately allocated, one-credit USDC Token Screener refresh added one confirmed success. Total allocated credits across these three isolated demo ledgers: 205. The pre-existing D2l ledger was not opened or changed. No live trading, wallet, signing, browser submission, or Rabby action occurred.

The local API is running in `PRODUCTION_READ_ONLY` against the external `paper-v2.sqlite`, `observations.sqlite`, and `d2-audit.sqlite` stores. Runtime confirms paid Nansen disabled, budget 0, live execution/signing/submission/browser wallet disabled, and Base RPC disabled. The Nansen key was used only by the bounded collector process and was not passed to the API process.

The latest available actual WETH price is 2,696.29 USD (Nansen, observed 14:57:10 EDT); the WETH one-hour netflow is 0 USD (Nansen, observed 14:57:12 EDT). The 15:14 EDT USDC Token Screener request returned `price_usd: MISSING`; the older OHLCV price is from Sep 25 and is stale. Evidence freshness is `stale`. The durable paper evaluation is `REQUIRE_REVIEW` (`PAPER_ACCOUNT_UNAVAILABLE`), with no paper fill. It is not an ALLOW/RESIZE/BLOCK result and must not be presented as one.

The external recording is `%LOCALAPPDATA%\Ered-Luin\paper-demo-allocations\paper-demo-20260927184415-64ec1549\paper-demo-recording.json`. Local review URL: `http://127.0.0.1:5173/?paperEvaluation=682d0a8f-16c4-45f9-9d08-8c35c0cdb6e7`. The extra one-credit bounded refresh wrapper is `tools/deadline/refresh-paper-demo-usdc.ps1`; the dashboard's live-data display changes remain unreviewed. This supports a truthful paper-data recording, not a fresh complete trade decision.

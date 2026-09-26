# Build state

Last updated: 2026-09-26

This is the public, repository-safe status summary. Detailed operator prompts, provider ledgers, credentials, run manifests, and private run reports are kept outside the public release.

## Accepted implementation

- G0 foundation and shared synthetic contracts.
- G1 credit accounting, provider normalization, and offline analysis gates.
- G2 deterministic policy and paper workflow.
- G3 bounded lifecycle, transaction, signer-boundary, and recovery work for offline scope.
- D1 local paper dashboard work.
- D2 offline/local implementation through the accepted D2l collector repairs.

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

The user-authorized external research run is active under an opt-in three-minute `weth-research-v2` profile with a matching 180-second cache-age limit. It uses the existing canonical WETH Token Screener and Smart Money Netflow queries, one page, zero retries, an 850-success run target, 900-attempt ceiling, 2,700-credit ceiling, and fixed `2026-09-27T21:00:00Z` stop. Its protected ledger and manifest remain outside the repository. This does not change checked-in zero-paid-call defaults or paper-only execution controls.

Offline validation for the v2 profile/monitor passed: D2l 16/16, D2h 11/11, typecheck, lint, and workspace build. A resume regression also covers recycled PIDs on failed manifests. The operational run status is held in protected local state; this summary is not a live feed. Three-minute cadence is research sampling only and does not establish trading readiness or organizer qualification.
## Pending work

- Obtain independent review of the D1 resize-clock repair and complete the manual visual dashboard pass.
- Complete the remaining D2 production-readiness review, including provider behavior, deployment configuration, signer custody, and operational recovery.
- Reconcile the external operator run state before resuming any interrupted bounded research collection. Its protected manifest and ledger are not part of this repository.
- Do not claim organizer-confirmed qualification from local HTTP success or synthetic test evidence.

## Limitations

- The checked-in templates keep paid provider calls off, but a separately provisioned operator configuration can enable a bounded research run.
- No claim of live trading readiness, profitability, market validity, or organizer qualification is made.
- Synthetic fixtures and mocks are for software validation only.
- Node's built-in SQLite API is currently marked as a release candidate by Node.js.

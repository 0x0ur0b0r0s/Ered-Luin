# Build state

## Gate status

- **G0 — Foundation:** implementation and acceptance checks are complete; awaiting user review.

## Current workspace

- Root: D:/Nansen COMP Project
- Repository: https://github.com/0x0ur0b0r0s/Ered-Luin; new, independent Git history on main.
- Existing Nansen source or historical data: none was present in the destination.
- Paid Nansen requests: disabled; default credit budget is 0.
- Execution: paper mode; live execution and signing are disabled.
- Validation runtime: Node.js v24.20.0 and pnpm v11.25.0.

## G0 validation evidence

- `pnpm install --offline --frozen-lockfile` — passed.
- `pnpm run build` — passed for the API, signal worker, dashboard, signer shell, and contracts package.
- `pnpm run typecheck` — passed for all five workspace packages.
- `pnpm run lint` — passed.
- `pnpm run test:contracts` — passed; 13 tests.

The contract tests cover strict unknown-field rejection, exact-input amount strings, unsupported assets and chains, intent expiry, complete/zero/missing signals, shared decision/execution/audit shapes, and disabled spending/live defaults.

## Rename validation — 2026-09-22

- Ered Luin name, @ered-luin package scope, workspace imports, lockfile, dashboard, and API service label updated.
- Frozen-lockfile install, build, type checks, lint, and all 13 contract tests passed after the rename.
- pnpm fetched missing registry metadata for its supply-chain check; locked dependency versions were preserved.

## Project identity

- Product: Ered Luin; workspace package scope: @ered-luin.
- This repository starts from the local G0 foundation and contains no Cirdan scanner history.
- Nansen available balance: 40,000 credits, user-reported; initial 2,000-credit collection ceiling remains proposed and paid calls remain disabled.

## Next task

Prepare the G1 prompt after user review of G0. G1 adds provider adapters and persistent per-attempt budget accounting. Keep collection disabled until a key and explicit spending ceiling are supplied.

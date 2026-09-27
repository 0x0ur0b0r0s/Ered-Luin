# Ered Luin

Ered Luin is a research and policy firewall for autonomous trading agents. It separates external market observations from agent proposals, deterministic policy evaluation, paper execution, and audit records.

## Architecture

- **Evidence adapters** normalize Nansen Token OHLCV, Token Screener, and Smart Money Netflow responses into typed observations with provider attribution, quality, completeness, and observation timestamps.
- **Query and accounting layer** applies explicit page and retry bounds, cache reuse, credit ledgers, allocation caps, and safe error codes before a provider request is dispatched.
- **Observation stores** persist source batches and normalized signals independently from policy and execution state. Store identity and writer exclusion prevent cross-allocation contamination.
- **Policy engine** evaluates trade intents against freshness, completeness, price, flow, gas, exposure, and notional constraints. It produces deterministic `ALLOW`, `RESIZE`, or `BLOCK` decisions with reasons and evidence identifiers.
- **Paper execution and audit** record proposals, evaluations, reservations, simulations, and outcomes without creating a transaction or requiring a private key.
- **Wallet boundary** is isolated behind explicit account, chain, allowance, transaction, and receipt checks. Browser submission is a separately gated capability.

## Runtime modes

The checked-in defaults are deliberately conservative:

- `PRODUCTION_READ_ONLY` reads persisted observations and exposes policy output without dispatching paid Nansen calls.
- `PAPER` initializes a simulated account and records policy/audit state without signing or broadcasting.
- Reviewed browser execution is separately configured and remains disabled by default. Private keys stay in the user wallet.

Credentials, private keys, production databases, and operator state are supplied through local configuration and are excluded from the repository.

## Local paper demo

The local dashboard presents the evidence-to-policy flow:

1. persisted Nansen observations with source endpoint, value, quality, and observation time;
2. a paper proposal and deterministic policy result;
3. runtime controls showing whether signing, submission, browser wallet, and Base RPC are enabled;
4. an auditable paper record with no transaction hash or fund movement.

Run the dashboard with the [D1 local paper demo](docs/d1-local-demo.md). The [paper-demo recording](docs/demo-live-paper.mp4) is a screen capture of the same read-only flow. The [demo guide](docs/friday-demo.md) describes the presentation sequence.

## Setup

Use Windows PowerShell 7, Node.js 24.20.0, and pnpm 11.25.0. Install dependencies from the lockfile:

    .\tools\pnpm-node24.ps1 install --frozen-lockfile

Build and validate the workspace:

    .\tools\pnpm-node24.ps1 run build
    .\tools\pnpm-node24.ps1 run typecheck
    .\tools\pnpm-node24.ps1 run lint
    .\tools\pnpm-node24.ps1 run test

Focused suites are available for the bounded collection and ledger paths:

    .\tools\pnpm-node24.ps1 run test:deadline
    .\tools\pnpm-node24.ps1 run test:d2l
    .\tools\pnpm-node24.ps1 run test:d2u
    .\tools\pnpm-node24.ps1 run test:d2v

## Repository layout

- `apps/api` — Fastify API, policy evaluation, paper store, execution boundaries, and operator controls.
- `apps/dashboard` — local evidence, policy, audit, and runtime-control UI.
- `packages/contracts` — shared schemas and validation contracts.
- `packages/nansen` — client core, adapters, query manager, credit ledger, cache, and observation store.
- `tools/deadline` — bounded refresh and paper-demo utilities.
- `tools/d2*` — gate-specific diagnostics, collection, and regression checks.
- `docs` — implementation plan, build evidence, handoff, runbooks, and demo material.

## Safety and operational boundary

The repository demonstrates sourced evidence handling, deterministic controls, and paper execution. Paid provider dispatch, wallet signing, transaction submission, and live trading require an explicitly reviewed runtime configuration and are not enabled by the checked-in defaults.

Synthetic fixtures are labeled as fixtures and are not market evidence. A successful mock or paper run does not constitute live-trading acceptance.

## Project documents

- [Implementation plan](docs/implementation-plan.md)
- [Build state and validation evidence](docs/build-state.md)
- [Current handoff](docs/current-handoff.md)
- [D1 local demo setup](docs/d1-local-demo.md)
- [Demo guide](docs/friday-demo.md)
- [Paper-demo recording](docs/demo-live-paper.mp4)
- [Desktop Rabby runbook](docs/desktop-rabby-runbook.md)
- [Deadline demo package](docs/deadline-demo-package.md)
- [D2l research monitoring](docs/d2l-research-monitoring.md)
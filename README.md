# Ered Luin

Ered Luin is a research and policy firewall for autonomous trading agents. It separates sourced observations and agent proposals from deterministic policy decisions, paper execution, and an auditable record.

## Current status

As of September 27, 2026, the bounded historical Nansen runner completed 251 new unique successful requests. The conservative verified local total is 801 unique HTTP successes; this does not establish organizer qualification. The internal target is 1,050, and the public campaign page lists 1,000 calls. See the [deadline demo package](docs/deadline-demo-package.md) for the accounting basis and submission status.

The earlier D2l collector is failed and has one unresolved reserved attempt. No collector is currently running. Historical evidence is stale and cannot authorize a current proposal or trade.

The local dashboard and API can be run in paper/read-only mode. The browser-wallet implementation is pending Astra review; browser submission, signing, live execution, and paid Nansen calls remain disabled. No live transaction, recording, public post, external deployment, or campaign entry is claimed.

## Safety defaults

- Checked-in configuration keeps paid Nansen calls disabled with a zero default budget.
- Execution defaults to paper mode; live execution, signing, and broadcast remain disabled.
- The local demo uses synthetic observations and quotes. Synthetic fixtures are not market evidence.
- Credentials, private keys, production databases, and operator run state do not belong in this repository.

These defaults do not replace review of a separately provisioned local configuration.

## Setup

Use Windows PowerShell 7, Node.js 24.20.0, and pnpm 11.25.0. Install Node.js and pnpm so both commands are available on PATH, then install from the lockfile:

    .\tools\pnpm-node24.ps1 install --frozen-lockfile

Build and check the workspace:

    .\tools\pnpm-node24.ps1 run build
    .\tools\pnpm-node24.ps1 run typecheck
    .\tools\pnpm-node24.ps1 run lint
    .\tools\pnpm-node24.ps1 run test

The focused collector suites are also available:

    .\tools\pnpm-node24.ps1 run test:d2k
    .\tools\pnpm-node24.ps1 run test:d2l

## Local demo

Follow the [D1 local paper demo](docs/d1-local-demo.md). It runs the API and dashboard locally against synthetic observations and a paper store. The [demo guide](docs/friday-demo.md) describes what the demo shows and its limits. The [deadline demo package](docs/deadline-demo-package.md) includes a 45–60 second synthetic rehearsal plan and a separate, gated live sequence.

## Project documents

- [Implementation plan](docs/implementation-plan.md)
- [Build state and validation evidence](docs/build-state.md)
- [Current handoff](docs/current-handoff.md)
- [D1 local demo setup](docs/d1-local-demo.md)
- [Demo guide](docs/friday-demo.md)
- [Deadline demonstration and submission package](docs/deadline-demo-package.md)

## Current limitations

- The D1 resize-clock repair still needs independent review and the local UI still needs its manual visual pass.
- D2 production readiness is incomplete. Production provider behavior, deployment configuration, signer custody, and live operational controls have not been accepted as a whole.
- The browser-wallet implementation has not been accepted for live use; its runtime flag is off.
- The verified local request count is below the campaign page's 1,000-call figure, and organizer qualification is unconfirmed.
- The full API suite previously had an intermittent timeout in a synthetic Alchemy configuration test; see the build-state for the exact recorded result.
- The ledger uses Node's built-in SQLite API, which Node currently labels a release candidate.
- This repository does not establish that synthetic results reflect market behavior or qualify for any external program.

D2l research sampling and the local monitor are documented in [docs/d2l-research-monitoring.md](docs/d2l-research-monitoring.md).

# Ered Luin

Ered Luin is a research and policy firewall for autonomous trading agents. It separates sourced observations and agent proposals from deterministic policy decisions, paper execution, and an auditable record.

## Current status

As of September 26, 2026, the offline implementation through the D2l collector repairs has been integrated. The accepted D2l repair set was verified in the launch checkout with a workspace build and 48 affected tests. The D1 resize-clock repair is implemented and awaits independent review. D2 live deployment and trading readiness are not accepted.

A bounded research collection may be running in an operator-managed local environment. Its credentials, configuration, ledger, and live status are kept outside this repository. Check the protected run manifest before assuming progress or resuming after an interruption. No organizer-confirmed qualification is claimed here.

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

Follow the [D1 local paper demo](docs/d1-local-demo.md). It runs the API and dashboard locally against synthetic observations and a paper store. The [demo guide](docs/friday-demo.md) describes what the demo shows and its limits.

## Project documents

- [Implementation plan](docs/implementation-plan.md)
- [Build state and validation evidence](docs/build-state.md)
- [Current handoff](docs/current-handoff.md)
- [D1 local demo setup](docs/d1-local-demo.md)
- [Demo guide](docs/friday-demo.md)

## Current limitations

- The D1 resize-clock repair still needs independent review and the local UI still needs its manual visual pass.
- D2 production readiness is incomplete. Production provider behavior, deployment configuration, signer custody, and live operational controls have not been accepted as a whole.
- The complete API suite has had one intermittent timeout in a synthetic Alchemy configuration test; that test passed when rerun alone with a longer timeout. See the build-state for the exact recorded result.
- The ledger uses Node's built-in SQLite API, which Node currently labels a release candidate.
- This repository does not establish that synthetic results reflect market behavior or qualify for any external program.

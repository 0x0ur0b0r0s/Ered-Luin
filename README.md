# Ered Luin

A Nansen-powered execution firewall for autonomous trading agents. The intended workflow connects sourced intelligence and typed trade intents to deterministic policy decisions, transaction simulation, restricted signing, and an audit trail.

Repository: https://github.com/0x0ur0b0r0s/Ered-Luin

## Current status

G0 foundation is implemented: a TypeScript/pnpm workspace, strict shared contracts, synthetic fixtures, an API health endpoint, a dashboard shell, signal-worker and signer shells, and CI checks. Runtime trading controls and provider integrations are planned work, not completed features.

Paid Nansen requests default to disabled with a zero-credit budget. Execution is paper-only and live signing is disabled. Contract fixtures are synthetic and are not market or trading evidence.

## Local validation

Use Node.js 22 or later and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test:contracts
```

`.env.example` documents configuration names and safe defaults. Keep credentials and raw/private datasets outside the repository.

## Build guidance

- [Implementation plan](docs/implementation-plan.md): architecture, boundaries, acceptance gates, and prompt workflow.
- [Build state](docs/build-state.md): completed checks and the next gate.
- [Agent instructions](AGENTS.md): working rules for implementation tasks.

The next gate is G1: provider adapters and persistent API-budget accounting, after review of G0.
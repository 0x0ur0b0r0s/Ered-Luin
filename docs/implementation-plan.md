# Ered Luin implementation plan

## Product scope

Build a research and policy firewall that accepts normalized market observations and agent proposals, applies deterministic controls, supports a paper-mode workflow, and records auditable decisions. Keep the intelligence layer separate from authorization and execution controls.

The repository is a prototype. A working local demo does not establish that a production deployment or live trading flow is ready.

## Architecture

- Shared contracts validate observations, proposals, decisions, execution state, and audit records.
- Provider adapters normalize external data and label freshness, completeness, and provenance.
- The analysis layer may summarize evidence but cannot approve transactions or bypass deterministic policy.
- The policy layer checks supported assets, exposure, freshness, sizing, expiry, and other configured constraints.
- Paper execution and durable audit storage support local review and replay.
- Signer and broadcast boundaries remain isolated and disabled unless separately implemented, reviewed, and explicitly configured.

## Gate map and acceptance boundaries

- G0: create the workspace, strict shared contracts, clearly synthetic fixtures, baseline agent instructions, and repeatable validation.
- G1a-G1d: account for provider attempts and credits durably; validate and normalize provider responses; coalesce/cache canonical requests; retain provenance and completeness; keep derived analysis advisory and separate from deterministic policy.
- G2: make deterministic ALLOW, RESIZE, BLOCK, and review decisions from validated evidence and policy inputs. Missing, stale, malformed, partial, or contradictory required evidence fails closed.
- G3a-G3c: enforce lifecycle, transaction, signer, and recovery boundaries. Bind authorization to exact validated inputs; preserve idempotency and reservations for uncertain outcomes; never bypass simulation or policy.
- D1: demonstrate the local paper workflow and audit retrieval. Resizing and expiry must be visible and deterministic; manual visual checks are recorded separately from automated tests.
- D2: compose production-facing services and bounded research collection. Validate provider, deployment, custody, budget, and recovery controls independently. Offline acceptance does not activate paid collection or live execution.

Current gate acceptance status and validation evidence are maintained in docs/build-state.md. Internal prompts and operator reviews are local workflow records, not product authorization. Work only on the requested gate and stop at its review boundary.

## Safety invariants

1. Paid provider use is opt-in. Checked-in defaults allocate zero paid credits.
2. Execution stays paper-only by default. Trading, signing, and broadcast controls fail closed.
3. Credentials, private keys, production configuration, local databases, and raw/private source data stay outside version control.
4. Fixtures are synthetic and must never be described as market evidence.
5. Missing, stale, partial, malformed, or contradictory evidence must remain visible and fail closed where required.
6. Agent analysis can inform a proposal but cannot grant authority or change a deterministic decision.
7. Unknown execution outcomes retain reservations and require reconciliation; never replace an uncertain transaction automatically.
8. A test or local rehearsal using mocks does not establish provider, chain, custody, or deployment readiness.

## Validation approach

Each gate has a bounded scope, explicit regression cases, and recorded validation commands. Run the package checks for the requested gate. Report failed or timed-out checks rather than describing a partial run as fully passing. Review source, tests, and the stated gate criteria together before accepting a change.

## Out of scope

Strategy profitability, automated capital deployment, additional chains, custom custody infrastructure, and production readiness beyond the accepted gates remain out of scope until separately planned and reviewed.
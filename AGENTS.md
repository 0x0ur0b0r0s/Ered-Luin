# Ered Luin agent instructions

- Read docs/implementation-plan.md for product scope, gate acceptance, and safety invariants. It is authoritative; work only on the requested gate.
- Read docs/build-state.md for accepted gates, validation evidence, and the next task.
- Keep paid Nansen credits at zero and execution paper-only by default. Change those boundaries only in a requested gate with its acceptance checks.
- Keep credentials and raw/private source data outside the repository. Label fixtures synthetic; never present them as market evidence.
- Run the package scripts for the requested gate and report exact commands and outcomes.

- For Astra planning/review and Luna tasks involving semantic judgment, read docs/typesafe-development.md and .agents/skills/typesafe-ai/SKILL.md. Use TypeSafe only when a narrow question could change triage or reveal an evidence gap; record why it helps. Follow the packet-sharing boundary. TypeSafe cannot approve gates or override deterministic controls.

## Usage efficiency — user preference, 2026-09-23

- Automatic reviewer subagents are disabled. Review Standards and Spec in one focused pass. This user preference overrides generic skill advice to launch parallel reviewers; use extra agents only on explicit user request.
- Read the current gate/handoff and changed code first. Reuse prior context; do not repeatedly print full plans, skills, logs or source files. Prefer bounded searches and short excerpts.
- Run the gate's required checks once after changes. Repeat only failing or affected checks, or tests needed for a concrete unresolved review risk.
- Keep implementation on Luna at the requested gate effort. Reserve Astra for architecture, consequential uncertainty and gate decisions. Do not expand a small status/review request into new implementation or research.
- TypeSafe must replace useful semantic analysis, not add a routine approval layer. Use one small batched check when needed, reuse unchanged evidence/results, and preserve the approved data-sharing boundary. No polling or automatic retries.

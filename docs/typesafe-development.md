# TypeSafe development boundary

TypeSafe may help with a narrow semantic question, such as identifying a missing evidence category or clarifying triage. Use it only when the answer could change the next step. It is optional and does not replace deterministic tests, security review, or gate acceptance.

## Data boundary

- Send only a small, reviewed, public-safe packet containing the minimum evidence needed for the question.
- Never send credentials, private keys, wallet balances, raw provider responses, production logs, private datasets, or unreviewed repository dumps.
- Keep API keys in protected environment or credential storage. Never put them in source, command arguments, frontend configuration, committed files, or request packets.
- Keep detailed request receipts and any sensitive audit data outside the repository.
- A failed or interrupted request is not automatically retried.

## Decision boundary

TypeSafe output is advisory. It cannot approve a gate, authorize spending or trading, change a budget, override deterministic controls, or establish provider or market truth. Missing deterministic checks still block acceptance.

Use synthetic packets for offline workflow verification. If a real project packet is not clearly safe for the intended recipient, do not send it. Continue with ordinary deterministic review and record why TypeSafe was not used.

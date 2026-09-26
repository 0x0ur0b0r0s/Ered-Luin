# Local demo guide

## What the demo shows

The D1 demo runs a local dashboard and API over deterministic synthetic observations and paper quotes. It shows how a proposal is evaluated, how the firewall allows, resizes, or blocks it, and how the resulting paper decision can be retrieved from the audit store.

Use the [D1 local demo setup](d1-local-demo.md) to start the services. Keep the demo on loopback and use a fresh synthetic paper database outside the repository.

## What the demo does not show

- Synthetic fixtures are not live market data and do not support trading decisions.
- A paper result is not a signed transaction, broadcast, on-chain receipt, or proof of profit.
- The local demo does not use a paid Nansen or TypeSafe API request.
- The demo does not establish production provider compatibility, signer custody, deployment readiness, or live trading readiness.

## Suggested walkthrough

1. Start the API and dashboard using the documented local setup.
2. Open the dashboard and inspect the synthetic evidence and its freshness/completeness labels.
3. Submit an allowed proposal, then a resized proposal, and then a blocked proposal.
4. Compare proposed and permitted amounts and read the policy reasons.
5. Retrieve the recorded decision from the audit view and repeat a scenario to show deterministic replay.
6. Close the demo by stating that all displayed market inputs and paper outcomes are synthetic.

Keep live calls, credentials, wallet actions, signing, and broadcast outside this demo. Any future live rehearsal needs its own bounded configuration, review, and explicit authorization.

# Ered Luin live Nansen paper demo

The accompanying [`demo-live-paper.webm`](demo-live-paper.webm) is a short recording of the read-only paper path using real Nansen provider responses. It contains no wallet connection, signature request, RPC call, broadcast, or live execution.

## Capture evidence

- Captured: 2026-09-27 19:34:33 EDT (2026-09-27T23:34:33.851Z)
- USDC/Base: `$1.000010`, Nansen Token OHLCV, observed 19:33:00 EDT, quality `COMPLETE`
- WETH/Base: `$2,686.38`, Nansen Token Screener, observed 19:34:32 EDT, quality `COMPLETE`
- WETH smart-money netflow: `$0.00`, Nansen Smart Money, observed 19:34:33 EDT, quality `COMPLETE`
- Refresh accounting: 3 provider HTTP successes, 7 credits, 0 retries; all three bounded requests returned complete usable observations.

The video shows the deterministic paper gate as `BLOCK` because `liveExecutionEnabled`, signing, submission, browser wallet, and Base RPC are disabled. The zero netflow is retained as market information; it is not converted into an `ALLOW`.

## Runtime

`PRODUCTION_READ_ONLY`, `paidNansenCallsEnabled=false`, `activeNansenCreditBudget=0`, `liveExecutionEnabled=false`, `signingEnabled=false`, `submissionEnabled=false`, `browserWalletEnabled=false`, and `baseRpc=disabled`.

The recording was made from the isolated paper-demo observation store. The original collector ledger and production shared store were not modified.

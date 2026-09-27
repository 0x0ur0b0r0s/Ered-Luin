# Ered Luin live Nansen paper demo

The accompanying [`demo-live-paper.webm`](demo-live-paper.webm) is a short recording of the read-only paper path. It contains no wallet connection, signature request, RPC call, broadcast, or live execution.

## Capture evidence

- Captured: 2026-09-27 19:01:28 EDT (2026-09-27T23:01:28.868Z)
- USDC/Base: `$0.998480`, Nansen Token OHLCV, observed 19:00:00 EDT, quality `COMPLETE`
- WETH/Base: `$2,674.49`, Nansen Token Screener, observed 19:01:16 EDT, quality `COMPLETE`
- WETH smart-money netflow: `$0.00`, Nansen Smart Money, observed 18:45:18 EDT, quality `COMPLETE`
- Refresh accounting: 2 provider HTTP successes, 2 credits, 0 retries; the netflow result was a complete cache hit from the same isolated store.

The video shows the deterministic paper gate as `BLOCK` because `liveExecutionEnabled`, signing, submission, browser wallet, and Base RPC are disabled. The zero netflow is retained as market information; it is not converted into an `ALLOW`.

## Runtime

`PRODUCTION_READ_ONLY`, `paidNansenCallsEnabled=false`, `activeNansenCreditBudget=0`, `liveExecutionEnabled=false`, `signingEnabled=false`, `submissionEnabled=false`, `browserWalletEnabled=false`, and `baseRpc=disabled`.

The recording was made from the isolated paper-demo observation store. The original collector ledger and production shared store were not modified.

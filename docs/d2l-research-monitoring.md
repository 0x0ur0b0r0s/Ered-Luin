# D2l research sampling and local monitor

The D2l collector has two named, immutable research profiles. `weth-research-v1` retains its five-minute schedule and five-minute research cache-age limit. `weth-research-v2` is a separately versioned three-minute sampling schedule. The ordinary application cache TTLs and D2h production defaults are unchanged.

## Profile v2

- The same two canonical Base queries run serially: Token Screener and Smart Money Netflow.
- Each query is due again three minutes after its prior cycle completes. Each call remains one page with zero retries; the query filters and response validation are unchanged.
- The research cache serves only a complete, error-free snapshot whose age is at most 180,000 ms. At 180,001 ms, the next query refreshes. This applies to both research queries and is matched to the three-minute sampling interval.
- Repeated values remain observations, not evidence of a new market event. This cadence is for research sampling and does not establish market evidence, trading readiness, or organizer qualification.
- A v1 run can migrate only through the explicit `--upgrade-research-profile` resume path. Its manifest, successful counts, attempts, credit ceiling, and deadline remain in place. Raising the target does not reset prior counts.

## Local monitor

The monitor reads only the external run manifest and collector process state. It checks every 30 seconds by default and alerts when the process stops, accounting needs reconciliation, status is unavailable, or the manifest has not checkpointed for seven minutes. It sends one generic notification per alert episode and permits a new notification after recovery. It never calls Nansen, starts or restarts collection, or reads credentials.

Pass the private ntfy topic via the local environment variable `ERED_LUIN_D2L_MONITOR_TOPIC`, or the `--topic` option. Do not store the topic in the repository. Notification bodies omit run IDs, endpoint counts, credit amounts, credentials, and observation data. The configured ntfy topic itself is the access token for publishing, so keep it private; the monitor uses only the operator-supplied topic.

Run the monitor in a separate PowerShell session on the same awake computer:

```powershell
$env:ERED_LUIN_D2L_MONITOR_TOPIC = '<private-topic>'
& .\tools\pnpm-node24.ps1 run d2l:monitor -- --manifest "<external-run-manifest>"
```

To inspect or stop a v2 collection, use its selected profile explicitly through the package script:

```powershell
& .\tools\pnpm-node24.ps1 run d2l:collect:v2 -- status --manifest "<external-run-manifest>"
& .\tools\pnpm-node24.ps1 run d2l:collect:v2 -- stop --manifest "<external-run-manifest>"
```

Manual resume requires provider-and-ledger reconciliation first. Do not infer a charge from a timeout, reservation, or configured endpoint price. Keep the collector in the foreground, the computer awake, and the original stop deadline unchanged.

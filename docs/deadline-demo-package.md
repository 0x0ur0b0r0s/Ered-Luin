# Deadline demonstration and submission package

Status as of 2026-09-27 13:25 EDT (UTC−04:00). This is a preparation package; nothing has been recorded or submitted.

## Current evidence and readiness

- The bounded historical runner completed 251 of 251 unique manifest jobs: 251 successful HTTP requests, 251 credits, no failed or unknown attempts. Its useful non-overlapping windows are exhausted.
- The conservative local total is 801 verified unique HTTP successes: the deduplicated baseline of 550 plus those 251. This is 249 below the internal 1,050 target and 199 below the stricter 1,000-call figure on the campaign page. Local success counts do not prove organizer qualification.
- The previous D2l run remains failed with one unresolved, reserved attempt. Its accounting was not edited or silently reconciled. The historical runner used a separate research store and bounded allocation.
- The historical OHLCV observations are stale and cannot authorize a current proposal or trade. No fresh live USDC/WETH evidence is available for a live recording.
- The local API and dashboard are running at `http://127.0.0.1:5173/` in paper/read-only mode. The served runtime reports paid Nansen calls disabled with a zero-credit budget, live execution disabled, browser wallet disabled, signing disabled, and submission disabled.
- The browser wallet implementation is available for Astra review. No wallet was connected for signing, no transaction was submitted, and no on-chain receipt exists.
- No recording, X post, external deployment, or entry form submission has been made.

## Safe local rehearsal

Use the existing local services. The dashboard is a synthetic, paper-only rehearsal; do not describe its fixtures as current market data.

1. Open `http://127.0.0.1:5173/` and show the `Paper mode` status.
2. In the D2 runtime panel, show `Paid Nansen` as off with `0` allocated credits, `Live execution` disabled, and signing/submission off.
3. Scroll to `01 / Replay a scenario`; select `Positive flow`, then click `Build proposal`.
4. Expand the `View all … normalized observations` disclosure and point out the synthetic evidence labels.
5. Click `Run firewall` and show the paper decision and audit result.
6. Select `Negative flow`, build the proposal, and run the firewall again to show a blocked example. `Resize to cap` is available for a resize example.
7. End by stating that all scenario inputs and outcomes in this rehearsal are synthetic and no trade was made.

### 45–60 second recording sequence available now

This records only the safe local rehearsal above, not a live-data competition submission.

- **0–8 sec:** Dashboard title and `Paper mode` indicator.
- **8–16 sec:** D2 runtime controls: paid Nansen `off · 0`, live execution disabled, signing/submission off.
- **16–27 sec:** Select `Positive flow`, build proposal, expand the normalized observations; say the fixture is synthetic.
- **27–39 sec:** Run the firewall and show its paper decision.
- **39–49 sec:** Select `Negative flow`, build and run it to show the blocked case.
- **49–55 sec:** State that this is a local synthetic rehearsal; there is no live transaction or receipt.

### Full live sequence remains gated

The intended live sequence is: current Nansen evidence with capture time → proposal → firewall decision and limits → simulation → user opens Rabby and confirms the exact transaction → Ered Luin verifies the matching Base transaction and receipt → audit record. Do not record or present this as completed until fresh evidence exists, Astra accepts the browser-wallet implementation, the user reviews the exact trade, and the user signs it in Rabby. The local runtime gates must be enabled only through the reviewed deployment procedure.

## Public post draft — do not publish without the user's final action

> Ered Luin is a research and policy firewall for agent-proposed Base swaps. This local walkthrough uses clearly labeled synthetic scenarios and paper execution; it is not a live-trading demonstration. Project: https://github.com/0xOur0b0r0s/Ered-Luin @nansen_ai

No post has been published.

## Submission checklist

The [Nansen Meridian Buildathon campaign](https://nansen.ai/campaigns/meridian-buildathon) lists a 1,000 API-call requirement. The [official help article](https://release.nansen.ai/help/articles/3540155-nansen-meridian-buildathon-sep-14-27) gives a different `100+` threshold and specifies a 30–60 second recording showing live Nansen data. Until the organizer resolves that discrepancy, use the stricter campaign requirement and do not claim eligibility. The campaign deadline is September 27, 2026 at 23:59 UTC (7:59 p.m. EDT).

- [ ] Confirm public repository contents and limitations: https://github.com/0xOur0b0r0s/Ered-Luin
- [ ] Obtain enough qualifying API activity under the campaign rules. Current local count is 801, with organizer qualification unconfirmed.
- [ ] Capture the required 30–60 second demonstration with live Nansen evidence. The available recording sequence above is synthetic and does not satisfy this requirement.
- [ ] Publish the final X post tagging `@nansen_ai` and linking the repository. The draft above is not published.
- [ ] Submit the entry through the campaign page. No form has been submitted.

Private credentials, raw provider payloads, transaction artifacts, and local databases remain outside the repository. This package contains no claim of a completed live trade, verified receipt, public post, submission, or organizer qualification.

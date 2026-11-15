# Cloud 2 build spec (owner-agreed, 2026-11-08/09)

Everything here was agreed with the owner in the Cloud 2 lane. Do not re-open a decision. If reality contradicts one, stop that piece and say so in your report.

## Ground rules for every agent
- Do not start subagents or parallel reviewers; do all the work yourself.
- Never print, log or commit a key. Run commands with the secrets in their environment: `"$ADE_CLI_PATH" secrets exec -- <command>` (values are masked in its output; agents cannot read them directly). Names: `AGENT37_API_KEY`, `ADE_STRIPE_SANDBOX_SECRET_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- Never deploy, never run a remote migration, never change anything on Cloudflare, never use the live Stripe key (`ADE_SECRET_FOR_AGENTS`). Validate against a local `wrangler dev` with a local D1.
- Agent 37: only delete computers you made; tag yours with metadata `created_by: c2-test`. Other computers in the workspace are not yours; never touch them. Put a `finally` on every test script so yours get deleted.
- Do not commit; the lead commits between stages. Do not rebase or switch branches. Other agents may be editing other files in this same worktree; re-read before you edit.
- Follow `CLAUDE.md`: no new test files during the build unless the behavior can only be validated by a test (say why). Validate by running the real thing. Run typecheck for the packages you touched once at the end of your piece, plus the existing tests that cover the files you changed. Do not run the full suite.
- Match the code around you: comment density, naming, idiom. User-facing text is short and plain. Users never see "Agent 37" (only the one "Powered by Agent 37" line), "template" or storage talk. Say "computer".
- Remote machines: a new IPC or preload call that acts on a chat, session, lane or terminal takes `pin` and routes through `callPinnedRuntimeAction`, and its runtime action is reachable remotely. Account-level calls take no pin.
- Performance: no new polls on hot paths; anything that polls runs only when ADE Cloud is visible for this account. See `docs/perf/macos-baseline.md`.
- Your final report: what you built, what you actually ran and saw (with numbers), what you could not validate, and every failure mode you noted. Plain sentences.

## The access flag (owner-only until launch)
- Server var `CLOUD_ACCESS_ACCOUNTS`: comma list of Clerk user ids, or `*`. Unset means nobody.
- `GET /cloud/access` answers `{ enabled }` for the bearer. Every `/cloud/*` route refuses a caller not on the list with 404 `not_found`.
- The app asks once at sign-in and again on focus at most every 10 minutes. Off, or unreachable with no cached yes: ADE Cloud does not exist in that app.
- Hidden when off: Settings cards and their search entries (including "Powered by Agent 37"), Add a computer's ADE Cloud option and cloud machine list, chat picker cloud and ready machines, `ade cloud` (acts as an unknown command), the `cloud` action domain, the `ade-cloud` skill and agent guidance, phone cloud page and settings entries, plans, hour banners, warning emails.

## Server owns the provider (apps/account-directory)
New folder `src/cloud/`. Migration `0018_cloud_account.sql` holds all tables below. Secrets: `AGENT37_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY` (optional), `CLOUD_CHAT_MASTER_KEY`. Vars: `CLOUD_ACCESS_ACCOUNTS`, `STRIPE_PLAN_PRICE_ID`, `STRIPE_EXTRA_PRICE_ID`, `STRIPE_METER_EVENT`, `CLOUD_ALERT_EMAIL`. R2 binding `CLOUD_CHATS`.

- The desktop and brains no longer hold any provider key. Delete the vault read, `ADE_CLOUD_DEV_KEY`, and `services/adeCloud/provider/agent37/` from the desktop. `getCloudProvider` returns a provider that calls these routes with the signed-in account token. A dev brain needs a way to reach a local server: use the existing account-directory base-URL mechanism.
- Routes mirror `CloudProvider` one to one, plus `stop` and `update`. Bearer is the Clerk account token (`callerToken.ts`).
- `cloud_computers` records owner, type, shape, disk, status, machine key and timestamps. Every call by instance id checks the owner; not yours or unknown is 404.
- `cloud_delete_log`: instance, owner, who (device or chat, as given), reason, time. Every delete, including automatic ones.
- `cloud_power_log`: instance, action (`wake|sleep|stop|start`), reason, time.
- `create` ignores any template from the client and uses the exact pinned version in `cloud_settings` (`template_version`, like `ade@8`). Unset means creates are refused with a clear log line. Size must be one of the eight below. Publicports limited to ADE's wake port.
- Limits on create, fork and copy: free 3 computers, paid 10. No create or wake at 0 hours.
- Disk: 4 GB on create. Free computers stay at 4 GB per computer. Paid accounts share 40 GB total: the server refuses any create or grow past that. Grow only in steps, only while the computer is idle (a disk resize restarts it). Android needs 12 GB, so a free account gets a clear "needs a paid plan" answer.
- Provider error codes map to plain sentences. `instance_limit_reached` gets its own: "ADE Cloud is at capacity right now. Try again in a few minutes." It no longer shares the empty-wallet line.

### Sizes (type, cpu, memory GB, hours multiplier)
Small default 2/4 1x; Medium default 4/8 2x; Large default 4/16 3.3x; X-Large default 4/32 5.8x; VM Small vm 2/4 2.5x; VM Medium vm 4/8 5x; VM Large vm 4/16 8.2x; VM X-Large vm 4/32 14.5x.
The UI shows a size and a "Full computer (Android, Docker)" switch, defaulting to Small, and how fast each uses hours. Android needs Medium or bigger.

## Hours
- Free 50 Small-hours a month, paid 500 (not 550). Paid resets on the billing date; free on the 1st UTC. Free to paid starts a fresh 500. Paid to free at period end starts a fresh 50.
- Store hours as integers (thousandths of a Small-hour), never floats.
- Minute cron: read the provider's instance list once, update status only on change, settle awake time into hours on change. Live hours = settled + running stretches, so most ticks write nothing. No computers, no work.
- Daily: compare each computer-day against `GET /v1/usage` `awake_minutes` (per machine per day, keeps deleted ones). Correct the account to the provider's number. Alert the owner to minutes the power log cannot explain.
- Before a delete, read the events history (`GET /v1/instances/{id}/events`): it disappears on delete.
- `GET /cloud/account`: plan, hours used, left, percent, 80/95/zero state, extra-hours state, disk used, computer counts, computers due for deletion, billing dates.
- Banners at 80% and 95%. Email at each too.

## 0 hours with extra off
Stop everywhere, never sleep: any request to a sleeping computer's address wakes it. In order: ask the computer to interrupt running turns and write the saved chat copy, wait for that (45 s at most), then stop it. A computer in cold storage (stop answers 400) is left alone; if something wakes it, the next tick stops it. Stop answers `409 try_again` during a sleep save: retry. Tools show "out of hours". No wakes. One exception: "Push all work to GitHub" gets a free short wake. Scheduled jobs and automations are refused by the server at 0 hours. A stopped computer comes back only with an explicit start, so the click-to-wake path must use start.

## Sleep and busy rules (on the computer)
- Sleep 3 minutes after last activity, matching the chat process timer `SESSION_INACTIVITY_TIMEOUT_MS`. The provider's own timer floors at 5 minutes, so the brain asks the server to sleep it (`POST /cloud/instances/:id/idle`), and the provider's 5-minute timer stays on as the backstop.
- One busy list, in `cloudKeepAwake`. Unknown is busy.
  - Busy: a running chat turn, a real running command, an agent CLI actually working, setup, first clone, move, copy, resize, someone watching a preview or Linux Desktop.
  - Idle: a shell at its prompt, an agent CLI at its prompt, a chat waiting on approval (answering wakes it).
  - A command or turn with no output and no touch for 60 minutes counts as idle.
- A person's click wakes, background refresh never does. Tools that need the computer (Terminal, Linux Desktop, Android, App Control, Files, Git, side chat, Browser on the lane's dev server) wake on open if hours remain. Reopening tabs at launch is not a click.
- While such a tool is open and the window is in front, the app sends "still watching" once a minute, only if the person moved or typed in the last few minutes.
- Server backstop: awake with no check-in for 10 minutes (use `machines.last_seen_at`, no new requests) is slept. Same for a computer that never started properly.
- A send racing a sleep: retry so the message is never lost.
- 30-day rule, every plan: a computer not awake for 30 days is deleted after 7-day and 1-day warnings (app and email) with "Push all work to GitHub". The lane stays. The clock waits for the next hours reset, so nobody loses a computer just because they ran out.

## Saved chats
After each turn the computer saves the new part of the chat to the server (R2, one write per turn). The chat list and transcripts read that copy, so nothing wakes. Only sending wakes. Security: one key per user kept apart from the chats (sealed with `CLOUD_CHAT_MASTER_KEY`), `redactSecrets` before upload, owner-only reads checked every time, no chat text in logs, deleting a chat, lane or account deletes the copy.

## PR and Jira on a sleeping computer
PR tab asks GitHub through the window's own machine using the lane's branch (`getGitHubSnapshot`, as the lane PR badges do). Jira uses the window machine's sign-in. Only actions touching the lane's files wake. On web or phone with no other computer on, show the saved PR link and Wake.

## Payments (Stripe Managed Payments; sandbox only)
- $5 a month, 500 Small-hours. Extra hours off by default, paid users only. 1 cent per Small-hour, 0.85 cents after 1,000 in a month, charged after use each time the tab reaches $5.
- Checkout: `mode=subscription`, `managed_payments[enabled]=true`, plan price plus graduated metered price, tax code `txcd_10103001`.
- Stripe accepts `billing_thresholds[amount_gte]=500` only by updating the subscription after Checkout, not in Checkout. Report whole Small-hours to the meter, carrying the remainder, with a stable identifier for each report.
- Change card and cancel go through Stripe's billing portal. The API cannot change a Managed Payments subscription's card.
- Webhook signature checked with WebCrypto, events stored for idempotency.
- Cancel: keep the plan to the end of the billing period, then free rules.
- `past_due` (a failed renewal or a failed extra-hours charge) moves the account to free-plan rules with a banner and email, and turns extra hours off. A later paid invoice restores the plan and its remaining hours.
- Email through Resend; with no key, log and carry on. Stripe sends receipts itself.

## Owner warnings
Every 10 minutes: alert under $15 wallet or when auto top-up is off (`GET /v1/billing`). No automatic stopping. Alert as awake computers approach the limit (`instance_limit` from the same call), at 80%.

## Template
- Server holds one exact version (`ade@N`); bare `ade` means newest and is never sent.
- Every release builds the template after its files are up, from that release's tag, gets the next build number, and changes nothing else.
- Tested on a real computer, then the version moves. Add a script for this: create from `ade@N`, ADE starts, terminal works, files survive sleep and wake, stop and start, deletes cleanly; time first start. Moving the version is one command, and moving back is the same command.
- An "Update this computer" action (provider `update`) replaces the "older template" message. Update resets the free system layer; only caches may live there.
- "Template is missing" becomes "ADE Cloud can't make a computer right now. Try again soon." The "ADE updates its template on its own" message goes.
- Waiting computers are dropped from the product. Their code stays hidden behind the flag for Cloud 3 to remove. Update the roadmap.

## Cloudflare cuts (rule: if it measures worse, it does not ship)
- "I'm online" heartbeat 30 s to 60 s, and the server's online window from 90 s to 150 s.
- Far fewer settings and vault checks, only if a change still reaches another computer within the same time, including first sync on a new device and a computer returning from off.
- Relay: measure which messages keep it active before changing it. Goal under 400K GB-s a month. Change only what does not affect delivery.
- Cost table with before and after numbers goes in the PR.

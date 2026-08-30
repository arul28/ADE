# Logging and product analytics

This is ADE's ground truth for operational logging and privacy-bounded product analytics. Read it before adding telemetry, changing an analytics event, or reviewing a feature with `/test`.

ADE is local-first. Operational logs stay local and help diagnose software behavior. Product analytics is a separate, deliberately narrow PostHog data path that answers how installations use ADE. PostHog is not a remote log sink, crash dump service, session recorder, or copy of ADE's local state.

## Non-negotiable boundaries

Never send any of the following to PostHog:

- prompts, responses, transcripts, code, diffs, file contents, terminal output, clipboard contents, screenshots, recordings, or proof artifacts;
- project, repository, lane, branch, file, or directory names and paths;
- command text or arguments, URLs, referrers, issue titles, PR titles, user-entered labels, raw errors, stack traces, or local log messages;
- credentials, tokens, email addresses, raw account identifiers, device names, or other user-provided strings;
- raw project IDs, session IDs, or other stable local database identifiers.

No PostHog SDK is linked. ADE calls the Capture API directly so autocapture, automatic pageviews, session replay, surveys, feature flags, remote config, automatic crash capture, and SDK-managed offline queues remain absent. Ordinary events disable person profiles and GeoIP with `$process_person_profile: false` and `$geoip_disable: true`. The sole exception is a quota-counted `$identify` call after ADE knows a signed-in account; it links the current anonymous history to a one-way hash of the account ID and sets only plan, platform, and app version. ADE does not send the account ID, email, name, provider, or token.

Only closed event names, closed property keys, and coarse allowlisted values may cross the analytics boundary. Desktop/runtime raw project and session IDs are installation-salted and hashed before capture. Local deduplication keys are also hashed and are never transmitted.

## Operational logs versus analytics

Operational logs use ADE's local logging services and may include bounded diagnostic context appropriate for the local machine. They are for debugging a specific installation and must not be forwarded to PostHog.

The machine brain writes the same `{ts, level, event, meta}` JSONL format as the desktop logger to `~/.ade/runtime/brain.jsonl`, honoring `ADE_LOG_LEVEL` (default `info`). The file rotates at 10 MiB to `brain.1.jsonl`; warnings and errors are also mirrored to stderr with an ISO-8601 timestamp and uppercase level for launchd diagnostics.

The desktop main process has a structured logger **from process start**: `apps/desktop/src/main/services/logging/machineLogger.ts` writes `~/.ade/runtime/desktop-main.jsonl` (same format, same `createFileLogger`, same 10 MiB rotation to `desktop-main.1.jsonl`), and `main.ts` opens it in its first executable statement, before the `ade://` claim and the single-instance lock. Its location is chosen for who can *read* it: `resolveMachineAdeLayout` is the resolver `ade report-issue` uses, so a headless report on a machine where the desktop will not start finds the file by construction, and each channel's `ADE_HOME` keeps its own. Electron's `userData` — where `local-runtime.jsonl` and `ade-update.jsonl` still live — is a per-platform, per-productName directory the CLI would have to guess, which is why those two remain desktop-only sources in a report.

Not everything reaches a structured logger. Lines the runtime prints on its way up go to the background service's **stdout**, which on macOS is `~/.ade/runtime/launchd.out.log` and not the `launchd.err.log` that carries stderr. Both streams are bounded by `runtimeLogMaintenance.ts` and **both** are collected into a diagnostic report; see [Diagnostic reports](features/storage-and-recovery/README.md#diagnostic-reports-report-issue). Early main-process events additionally mirror to `console` through `logMachineEvent`, so a terminal-launched app still shows them and the pathological case — an old plist that boots the whole desktop app as the background service — still leaves them in `launchd.out.log`. That mirror is a second copy, not the record: a bare `console.log` for something the machine log could carry is no longer acceptable, because it is invisible to a Finder-launched app.

Writes are batched onto an async stream, so a caller that is about to end the process (`app.exit`, a force quit, an install handoff escalation) must call `logger.flushSync()` immediately after the line that matters — while it is still queued — or the records explaining the exit die with the process. `flushSync` drains only what is still queued (a batch already handed to an in-flight async flush is not duplicated), skips rotation deliberately, and, like every other log write, never throws.

Not every operational log belongs to the active project. The rule is the **subject** of the event: if it is the computer, it goes to `desktop-main.jsonl`; if it is a repository, it goes to that project's `main.jsonl`. Machine-subject events include the launch marker `desktop.main_started`, the deeplink scheme claim and single-instance outcome (`deeplink.*`, including `deeplink.single_instance.lock_lost`), `app_navigation.queued_before_dispatcher_ready`, `app.hardware_acceleration`, `machine_trust_reset.failed`, and the `ade` CLI auto-install outcome (`ade_cli.auto_install`, `ade_cli.auto_install_failed`, `ade_cli.auto_install_skipped`) — whether this computer ever got the `ade` command is a fact about the computer, and filed per project it landed wherever the startup latch happened to win. Project-subject events (`project.init`, `ipc.*`, per-service telemetry) stay in the project log, unchanged. Auto-update events were already machine-scoped in `<Electron userData>/ade-update.jsonl` and stay there.

`createFileLogger` backs other machine-scoped sinks for the same reason: `accountBridge` writes `account.local_machines_removed` to `<machine ade dir>/runtime/account-trust.jsonl`, because dropping a paired machine credential is a machine-level mutation and the project logger follows the active project — on a remote-bound project it would ship the record to the other machine and leave nothing on the machine that actually lost its trust. Account-directory publish outcomes record only bounded per-leg durations, the failing leg, and coarse failure codes such as `token_timeout` or `http_timeout`; they never include bearer tokens or response bodies. These high-frequency health events remain local operational logs and are not product analytics.

The brain's sync host and memory watchdog write their own local structured
lines. `sync.host_start_failed` (signature, attempt, classified code, errno,
the human-readable failure message — the redacted sentence for a classified
storage fault, the raw error text otherwise —
provider — at the failure deduper's one-per-minute cadence) and
`sync.host_start_recovered` replace the free-text stderr lines that once made
the most frequent brain failure invisible to structured logs.
`brain.suspend_gap` records a sleep the watchdogs would previously have
mis-reported as an event-loop stall. `brain.memory_sample` (rss, heap,
external, uptime; every five minutes) and `brain.memory_restart` /
`brain.memory_restart_deferred` record the RSS slope and the planned
idle restart that mitigates a known native leak. All of these are local
operational logs and none is a PostHog event; the only analytics adjacent to
them is the existing `ade_feature_used` `auto_sent` outcome when a sustained
storage fault triggers an automatic diagnostic send through the unchanged
consent, deduplication, and budget path.

The desktop's runtime connection pool writes its own local lines around the
update window and repair throttle: `local_runtime.update_window_started` /
`_ended` / `_expired`, `local_runtime.connect_deferred_for_update`,
`local_runtime.service_repair_suppressed`, and
`local_runtime.service_repair_throttled`. They record why a repair or connect
was held back during an update transaction and carry no paths or versions
beyond the bounded fields already in `local-runtime.jsonl`; none is a PostHog
event.

Claude compaction observations use the local structured line
`agent_chat.claude_context_compaction_observed` with `sessionId`, `trigger`
(`natural`, `ade_fallback`, or `recovery`), and `occupancyPctAtTrigger`. Record
every natural and ADE-issued compaction so production logs can verify that the
SDK still compacts naturally above its high-water mark. The fallback gate's
debug line is `agent_chat.claude_context_compaction_fallback_gate`; neither line
is a PostHog event.

Spawned-child turn completions record the local structured line
`agent_chat.spawn_completion_routed` with `childSessionId`, `parentSessionId`,
`childTurnId`, `spawnKind`, `status`, and `routedTo` (`wake` or
`quiet_notice`). It is written after the delivery succeeds, so it records the
outcome rather than the intent and a retried attempt never reads as a second
wake. Write it for every completion, including the quiet ones: a
parent that was never woken is otherwise indistinguishable in the logs from a
child that never finished, which is how the original mis-attribution went
unnoticed. A final delivery failure keeps its own
`agent_chat.spawn_completion_delivery_failed` line. Explicit take over / promote
writes `agent_chat.spawn_kind_changed` with `sessionId`, `parentSessionId`,
`previousSpawnKind`, `spawnKind`, and `source` (`takeover`, `promote`, or
`parent_dispatch`). None of these spawn-coordination lines is a PostHog event.

When the idle sweep or budget eviction reclaims a chat runtime that still
*claims* live background work — the exemption expired after
`RUNTIME_WORKLOAD_EXEMPTION_MAX_SILENCE_MS` (= `SESSION_STALE_AFTER_MS`, three
hours) of total silence — it writes the local structured line `agent_chat.runtime_workload_exemption_expired` with
`sessionId`, `provider`, `silentForMs`, `liveBackgroundTaskCount`, and
`activeSubagentCount`. This is the one teardown path that overrides a workload
the runtime is still reporting, so it must be attributable after the fact:
without it, a user asking "why did my background job stop" has nothing to read.
It is a local operational log, not a PostHog event, and it carries no task ids,
commands, or titles.

**No product-analytics event accompanies it, deliberately.** The closed event
taxonomy records what an installation *does* — a surface opened, a chat started,
a settle the user asked for. This teardown is a background timer firing with no
user action behind it, so an `ade_feature_used` here would report engagement
nobody generated and would fire on a schedule rather than on use. The nearest
precedent cuts the same way: the settle-with-residue event exists because a
human pressed Settle and the stop could not be confirmed. If a future change
ever makes this reclaim user-initiated, revisit the decision then.

The Claude subprocess reaper writes its own local lines around process
teardown: `agent_chat.claude_subprocess_terminate` (with `pid`, `sessionId`,
`reason`, and on POSIX a `groupLeader` flag recording whether the whole process
group was signalled), `agent_chat.claude_subprocess_kill` for the SIGKILL
escalation, `agent_chat.claude_subprocess_pid_reused` when an identity probe
refuses a recycled pid, and `agent_chat.claude_subprocess_taskkill_failed` on
Windows. They carry pids and session ids and no command lines, and none is a
PostHog event.

Product analytics records a small number of meaningful product facts such as "an anonymous installation opened the Work screen" or "a chat session started." It must never inherit arbitrary fields from a log record, exception, IPC payload, database row, or UI component props. Log calls and product-analytics calls should remain separate at the call site.

## Source file map

Shared desktop/runtime boundary:

- `apps/desktop/src/shared/types/productAnalytics.ts` defines the closed event, surface, status, and capture contracts.
- `apps/desktop/src/main/services/analytics/productAnalyticsPolicy.ts` owns property allowlists, coarse value normalization, internal-only events, and the global/per-event/per-minute budgets.
- `apps/desktop/src/main/services/analytics/productAnalyticsService.ts` owns machine consent, installation identity, salted identifier hashing, persisted deduplication/quota state, and the bounded direct Capture API transport.
- `apps/desktop/src/main/services/analytics/usageProductAnalyticsExporter.ts`, `dailyUsageAnalytics.ts`, and `agentTurnProductAnalytics.ts` are the durable-ledger, daily-aggregate, and work-session producers. Their focused coverage is consolidated in `productAnalyticsService.test.ts`.
- `apps/desktop/src/main/services/ipc/registerIpc.ts`, `apps/desktop/src/preload/preload.ts`, and `apps/desktop/src/renderer/components/analytics/ProductAnalyticsLifecycle.tsx` expose the safe renderer boundary and lifecycle producers. `ProductAnalyticsSection.tsx` is the desktop opt-out UI.

Attached clients and native surfaces:

- `apps/ade-cli/src/services/sync/productAnalyticsRemoteCommand.ts` binds paired-client consent, surface, and project identity at the host boundary. `syncHostService.ts` keeps consent peer-scoped, and `syncRemoteCommandService.ts` exposes only the runtime-scoped analytics commands.
- `apps/ade-cli/src/tuiClient/productAnalytics.ts` and `app.tsx` emit normalized `ade code` lifecycle and screen events through the runtime; the TUI has no independent PostHog transport.
- `apps/desktop/src/renderer/webclient/adapter/analytics.ts` keeps the hosted client's browser-local opt-out. Hosted web is default-on; an explicit "false" preference in browser storage disables capture and is reasserted on every connection. It retries transient consent-sync failures, then disconnects fail-closed only when an opt-out acknowledgement still cannot be confirmed.
- `apps/ios/ADE/Services/ProductAnalytics.swift` owns the native iOS policy, identity, budget, default-on behavior, and direct transport. There is no native analytics preference or consent prompt. `PrivacyInfo.xcprivacy` files for ADE, the App Clip, and widgets declare the shipped privacy surface.
- `apps/web/src/lib/marketingAnalytics.ts`, `marketingAnalyticsBrowser.ts`, and `components/MarketingAnalyticsBridge.tsx` own the public site's separate consent, taxonomy, budget, and direct browser transport.

Build and operations:

- `apps/desktop/tsup.config.ts` and `apps/ade-cli/tsup.config.ts` validate and compile only the public capture configuration into release artifacts.
- `apps/ios/Scripts/validate-posthog-project-token.sh`, `.github/workflows/release-core.yml`, and `.github/scripts/ios-testflight-internal-build-bump-asc.sh` validate iOS configuration and pass it through a temporary mode-0600 xcconfig that is deleted after the archive command.
- `apps/web/vite.config.ts` rejects non-`phc_` tokens before a public-site build. Vercel Production supplies the two `VITE_` variables; Preview and Development intentionally do not.
- `scripts/posthog/dashboard-spec.mjs` and `provision.mjs` are the declarative dashboard/insight control plane. They accept the personal management key only in the provisioner process.

## Architecture by surface

### Desktop, runtime, TUI, and hosted web client

The canonical service is `apps/desktop/src/main/services/analytics/productAnalyticsService.ts`. The desktop main process and the ADE runtime use the same machine-scoped service and durable state file. `ade code` and the hosted web client send allowlisted capture requests through the runtime action registry; they do not own independent PostHog clients.

Machine analytics state lives under the active channel home at `secrets/product-analytics.json`, with a sibling `.disabled` marker for fail-closed opt-out during lock contention. It is not project state and never enters cr-sqlite replication. The project-local `usage_events` mutation ledger is also excluded from CRR sync; its analytics export marker prevents pre-analytics, opted-out, expired, or already-handled rows from being uploaded later.

The public contract is `apps/desktop/src/shared/types/productAnalytics.ts`. The allowed events are:

- `ade_app_installed`
- `ade_app_opened`
- `ade_activated`
- `ade_screen_viewed`
- `ade_project_opened`
- `ade_feature_used`
- `ade_work_session_started`
- `ade_work_session_completed`
- `ade_error`
- `ade_daily_usage_summary`
- `ade_analytics_budget`
- `ade_update_install_aborted`
- `ade_update_quit_escalated`
- `ade_update_install_did_not_land`
- `ade_update_auto_applied`
- `ade_update_auto_apply_cancelled`
- `ade_update_prompted`
- `ade_tool_fetched`
- `ade_brain_recovered`
- `ade_renderer_recovered`
- `ade_publish_failing`
- `ade_relay_suppressed`
- `ade_account_session_unreadable`
- `ade_brain_action_failed`

The update and reliability events are low-frequency by construction: the five `ade_update_*` events fire at most once per install attempt or idle-apply cycle (daily caps 10–20, minute caps 3–6). `ade_update_install_did_not_land` is emitted once at startup when a requested install relaunched on the old version, so it is bounded by app launches that follow a failed handoff, and carries only a bounded `attempt` counter; `ade_brain_recovered` fires once per wedge recovery at brain startup; `ade_renderer_recovered` fires once per lost renderer and is bounded by the recovery budget itself (three reload attempts per rolling 60 seconds, after which the window stays down rather than looping), carrying only `crash_reason` — Electron's closed enum, normalized to `unknown` for any future value — and whether the reload was still allowed, never the window URL or title; `ade_publish_failing` is edge-triggered once per sustained failure episode (first crossing of two minutes), never per attempt.

Changing automatic-install preferences records the existing `ade_feature_used`
event at the update-service owner boundary with `feature: "updates"`,
`action: "preferences_changed"`, a coarse `mode` (`automatic` or `manual`), and
a coarse `outcome` (`idle_only` or `immediate`). It carries no paths, versions,
session details, or runtime activity counts. A persisted 24-hour deduplication
key per preference combination bounds this to at most four accepted events per
installation per UTC day, within the existing `ade_feature_used` and shared
daily ceilings.

Choosing a keep-awake level records the same `ade_feature_used` event at the
keep-awake service's persist boundary — after the choice is written, so a
refused level (the lid-closed one whose password prompt was cancelled) is never
counted as adopted. It carries `feature: "connections"`,
`action: "preferences_changed"`, and one closed `outcome`:
`keep_awake_never`, `keep_awake_while_away`, or `keep_awake_lid_closed`. The
product question is only whether installations opt into ADE holding a machine
awake, and how many go as far as the level that needs a password. It carries no
machine name or identifier, no battery level, no power source, and nothing about
what was running. A 24-hour deduplication key per level bounds this to at most
three accepted events per installation per UTC day, inside the existing
`ade_feature_used` ceiling.

Host sleep and wake themselves are deliberately **not** analytics. They are
OS-driven mechanics that can fire dozens of times a day on a laptop, which is
exactly the high-frequency shape this document says to aggregate or leave
untracked. They stay local operational logs.

Settle teardown records two things at the session-service owner boundary, both
on the existing `ade_feature_used` event with `feature: "work"`.

`action: "settle_teardown_residue"` fires when a settle landed but a stop could
not be confirmed (the design's 3d option 3). It carries `provider`, a coarse
`outcome` reason (`no_stop_control`, `timeout`, or `rejected`) and a bucketed
`count_bucket` (`1`, `2_5`, `6_plus`). **One event per settle, never one per
failed job** — a fleet that fails to stop must not become a burst — and the
bucket exists so a large fleet cannot widen the dimension either. No session id,
task id, command, or error text is recorded; the human-readable residue detail
stays on the local diagnostics row and never enters the payload.

`action: "settle_remote_write_reconciled"` fires when an inbound changeset
carried settle-tuple columns and the session layer re-asserted them through the
chokepoint. It carries the coarse `outcome` and a bucketed `count_bucket` of how
many sessions one changeset covered.

It is a **rate** signal, not an anomaly signal. A paired second desktop
replicating its own settles reaches this path by design, so a non-zero rate is
expected wherever two desktops are paired; what it measures is how much settle
traffic arrives already-decided, which is the evidence needed before anyone
designs a protocol-level concurrency token. **One event per changeset, never one
per session** — a bulk settle on the peer arrives as a single apply covering N
sessions, and reporting each would turn one remote action into an N-event
burst.

Chat auto-resume after a provider usage limit records one coarse workflow
outcome per transition, on the same `ade_feature_used` event with
`feature: "work"` and `action: "auto_resume"`, at the coordinator that owns the
loop (`chatAutoResumeCoordinator`, through an injected emitter — it never
reaches the analytics service or a session id itself). `outcome` is a closed set
of exactly three values: `armed` (a resume was scheduled), `resumed` (an
auto-resume-originated turn started), and `paused` (the consecutive-arm cap
stopped re-arming). `provider` rides along, the same coarse slug through the
same sanitizer as the settle-teardown event, because a limit whose published
reset instant is the wrong one is a provider-specific failure and is the whole
reason the cap exists. The product question is only whether auto-resume rescues
a chat a limit stopped, so nothing finer crosses the boundary: no session id, no
reset timestamp, no provider error text, no prompt or notice copy, and no
schedule id.

A cancelled resume is deliberately **not** recorded. Cancellation fires on
ordinary user activity — any message or retry in the chat clears the pending
row — so counting it would report typing rather than the workflow, and the
number that matters is already derivable as `armed` minus `resumed`. No new
deduplication key was added because the volume is bounded by construction
instead: arms are capped at two per streak (and collapse to one event per
distinct reset instant, so the duplicate error events a single failure commits
do not double-count), `paused` is emitted once per capped streak rather than
once per failure, and `resumed` is emitted once per fired resume on the
not-pending-to-pending edge. Worst case is therefore five events per chat per
streak — two `armed`, two `resumed`, one `paused` — and a streak requires a
usage limit plus a reset window to elapse, so realistic volume is single digits
per installation per day, far inside the existing `ade_feature_used`
140-per-day / 30-per-minute limits and the shared 200-event ceiling. No ceiling
was raised. The dashboard spec is deliberately untouched: there is no product
question attached to these events yet, so they stay out of
`scripts/posthog/dashboard-spec.mjs` until there is one. The loop's local
operational lines (`agent_chat.auto_resume_scheduled`,
`agent_chat.auto_resume_cancelled`, `agent_chat.auto_resume_schedule_failed`),
which do carry session ids, schedule ids, and fire times, are not PostHog
events.

Applying an update is one transaction — app swap, background service reinstalled,
service restarted, service answering — and the brain half failing (the app
updated but the background service never came back) is its own product-level
failure category. The update service records it at the owner boundary where the
transaction result is published (`autoUpdateService.setUpdateTransaction`) using
the existing `ade_feature_used` event with `feature: "updates"`,
`action: "transaction_failed"`, and a coarse `outcome` naming the failed step —
`service`, `restart`, or `health`. A failed `swap` step is deliberately not
reported here because the app half already has `ade_update_install_did_not_land`.
Nothing else crosses the boundary: no versions, paths, step details, failure
copy, or error text — those stay in the local `autoUpdate.transaction_failed`
line. A persisted `update_transaction_failed:<step>` deduplication key with a
one-hour minimum interval means a relaunch loop costs one accepted event per
step per hour. Because a transaction runs at most once per post-update launch
and stops at the first failed step, realistic worst case is a single-digit
number of accepted events per installation per day (hard ceiling 72 across all
three steps), inside the existing `ade_feature_used` 140-per-day / 30-per-minute
limits and the shared 200-event ceiling — no ceiling was raised. The dashboard
spec is deliberately untouched: there is no product question attached to this
event yet, so it stays out of `scripts/posthog/dashboard-spec.mjs` until there
is one.

Which usage scope an installation actually looks at records the existing
`ade_feature_used` event at the durable owner boundary
(`usageTrackingService.getAdeUsageStats`, where the scope is normalized) with
`feature: "usage"`, `action: "scope_selected"`, and the coarse scope on
`outcome` — `machine`, `project`, or `account`. Reusing `outcome` rather than
adding a parallel `scope` key follows the update transaction's use of the same
key for its failed step. The product question is only whether cross-machine
("account") usage is used at all, so nothing finer crosses the boundary: no
machine count, machine key, project path, range preset, token count, or cost.
The Usage page re-reads on every `usage.onUpdate`, so the renderer's segmented
control is deliberately not the emitter; a persisted `usage_scope:<scope>`
deduplication key with a 24-hour minimum interval collapses that read stream to
at most three accepted events per installation per UTC day (one per scope),
inside the existing `ade_feature_used` 140-per-day / 30-per-minute limits and
the shared 200-event ceiling — no ceiling was raised. A scope value outside the
closed set is dropped rather than widening the allowlist. The dashboard spec is
deliberately untouched: adoption of the scope control has no dashboard card yet,
so it stays out of `scripts/posthog/dashboard-spec.mjs` until it does.

`ade_relay_suppressed` is the same shape for the relay leg. The relay keeps one host control socket per machine and evicts the previous holder, so two ADE brains on one machine can evict each other in a loop until relay is unusable for both. When the tunnel client exhausts its eviction budget and stops dialing, it emits one event carrying only `attempt` (the bounded eviction count) and a coarse `code` (`control_replaced`). It is keyed to the suppression *episode*, not the eviction, so a whole war collapses into one accepted event, and a 24-hour deduplication window bounds it further; a recovered control socket ends the episode so a genuinely new one still reports. The relay URL, machineKey, and raw WebSocket close reason stay in local logs and never reach the payload. Properties are closed enums and bounded numbers — `reason` is allowlisted to the abort-reason constant, `escalation_reason` to `hard_deadline` / `post_staging`, `last_command` is a closed sync-action slug, and `leg`/`code` are the coarse publish classifications. Worst-case combined volume is a handful of events on a very bad day, inside the shared ceiling.

`ade_account_session_unreadable` covers the credential-store half of the same
failure: the desktop app is signed in, but the ADE brain cannot decrypt the
shared `credentials.json.enc` and therefore never publishes the machine to the
account directory. The account-directory publisher emits it once per unreadable
*episode* (a readable status ends the episode) carrying only a coarse `code` for
the read path — `decrypt_failure`, `no_os_key_material`, `store_format`,
`session_parse`, `read_error`, or `unknown`. No paths, key material, ciphertext,
or account identifiers reach the payload, and a 24-hour deduplication window per
code bounds it further.

`ade_tool_fetched` records the outcome of fetching a pinned agent CLI (Codex,
Claude, or OpenCode) into the shared tools cache — a first-run or pin-bump
fact, not a progress stream. It fires once per completed per-tool attempt at
the service boundary (desktop `agentToolsCacheService`, brain
`backgroundFetch`) with only the closed properties `provider`, `outcome`
(`success`/`failed`), a coarse `duration_bucket`, and on failure a
`tool_error_kind` from the closed `ToolErrorKind` union. No URLs, paths,
versions, byte counts, or error text reach the payload. Caps: 12 per UTC day
and 3 per minute; download progress, retries, and integrity-verify mechanics
stay in local logs.

Clicking "Repair" on the Connections pane's unreadable-session banner records
the existing `ade_feature_used` event at the IPC owner boundary (where the
outcome is known) with `feature: "connections"`, `action: "brain_repair"`, and a
coarse `outcome`. The control now repairs the shared credential store — converge
its key binding, restore anything a peer process set aside — before restarting
the background service, so the outcome has three values rather than two:
`completed` (the store is readable, whether or not anything had to be restored),
`sign_in_required` (the repair ran, but nothing on this computer can open what
was set aside), and `failed` (the repair itself threw). The distinction is the
point — collapsing "recovered your session" and "your session is gone" into one
value answers neither question. Both the credential-repair handler and the older
restart-only handler emit the same action and dedupe key, because they are the
same product fact reached through a new and an old preload. It carries no error
text, paths, key material, or machine identifiers — the thrown error stays in the
renderer. A per-outcome one-hour deduplication key bounds a click-loop to at most
24 accepted events per outcome — 72 across all three — per installation per UTC
day, inside the existing `ade_feature_used` 140-per-day / 30-per-minute limits
and the shared 200-event ceiling; no ceiling was raised. The dashboard spec is
deliberately untouched: no card asks this question yet.

Pressing "Report issue" on any of ADE's error surfaces — the project recovery
screen, the renderer error boundary, the project transition alert, the update
banner — records the existing `ade_feature_used` event at the IPC owner boundary
(the `diagnostics.openIssue` handler, where the outcome is known) with
`feature: "connections"`, `action: "issue_report"`, and a coarse `outcome`:
`opened` when the prefilled GitHub issue page was launched, `failed` when it
could not be. That is the whole product question — whether the one control on a
broken screen reaches GitHub — so nothing else crosses the boundary: not the
surface it was pressed on, not the failure code or headline that put the screen
there, not the report, the clipboard result, the report file path, or the
install id the report carries. Those live in the local report file under
`<userData>/diagnostic-reports/` and on the clipboard, which the person reads
and pastes deliberately. A per-outcome one-hour deduplication key bounds a
click-loop to at most 24 accepted events per outcome — 48 across both — per
installation per UTC day, inside the existing `ade_feature_used` 140-per-day /
30-per-minute limits and the shared 200-event ceiling; no ceiling was raised.
The dashboard spec is deliberately untouched: no card asks this question yet.

When ADE hits a failure it already classified, it sends that same redacted
report by itself, and that decision records the same `ade_feature_used` event at
the owner boundary — the auto-diagnostics service, where the outcome is known —
with `feature: "connections"`, `action: "auto_sent"`, and one of three coarse
outcomes: `completed` when the upload succeeded, `skipped_budget` when the
client's own daily ceiling refused it, `failed` when it was attempted and did
not land (including a `429` from either the per-user or the fleet budget). The
product question is only whether the thing that fires without anyone asking
works and whether its guardrail holds, so nothing else crosses: not the failure
code that triggered it, not the surface, not the upload reference, not the saved
report path, and not whether the user then turned the feature off — that is a
setting, not an event. Two of the five outcomes `runAutoDiagnosticsSend` can
return deliberately emit nothing. `skipped_disabled`: an installation that has
withdrawn consent emits nothing at all, so counting its non-sends would be the
one measurement it declined. `skipped_ineligible` — an unusable failure code, or
a send already in flight — because nothing was built, spent or refused, so there
is no outcome to report; it is a caller bug or a race, and it belongs in the
local log, which is where it goes. A per-outcome one-hour
deduplication key bounds the worst case to 24 accepted events per outcome — 72
across all three — per installation per UTC day, and the client budget of three
sends a day makes the real number far smaller; this sits inside the existing
`ade_feature_used` 140-per-day / 30-per-minute limits and the shared 200-event
ceiling, and no ceiling was raised. The brain emits the same event for its own
automatic sends through the same shared service — under `surface: "api"`, since
nobody was at the keyboard — and shares the persisted deduplication state, so an
installation's counts are one number rather than two. The dashboard spec is
deliberately untouched: no card asks this question yet.

The diagnostic report itself is a **local** artifact and is not analytics. It
deliberately includes the PostHog `distinct_id` for this installation
(`productAnalyticsService.getDistinctId()` — the identified account hash when
signed in, otherwise the random anonymous install token) so a report someone
files by hand can be matched to the events the installation already sent.
Nothing flows the other way: no part of a report reaches PostHog, on either
path. A report the user files is written to disk and copied to the clipboard and
only they decide where it goes; a report ADE sends by itself goes to the
diagnostics upload route and nowhere else, and the analytics boundary learns
only that a send happened and how it ended. Its body is redacted before it is
written (home directory, project paths, usernames, hostnames and tailnet names,
emails, credentials and routable IP addresses) — the same bytes on both paths,
because redaction happens once in the builder — and the GitHub issue title and
stub body are redacted with the same context. Automatic sending is a separate
consent from analytics: it has its own Settings toggle (default on) and its own
persisted flag, so turning one off does not silently turn off the other.

Clicking "Reconnect this computer" on the Account pane's removed-machine banner
records the existing `ade_feature_used` event at the IPC owner boundary (the
`accountRepairMachinePairing` handler, where the repair outcome is known) with
`feature: "connections"`, `action: "machine_reconnect"`, and a coarse `outcome` —
`completed` when the brain re-paired the machine or nothing was gated, `failed`
otherwise, including a thrown repair. It carries no machine key or name, account
identifier, refusal reason code, or error text; those stay in the renderer's
banner copy and in local logs. A per-outcome one-hour deduplication key bounds a
click-loop to at most 24 accepted events per outcome — 48 across both — per
installation per UTC day, inside the existing `ade_feature_used` and shared
ceilings. The Activity feed's polling, rendering, section collapse, filters, and
acknowledgements, notch and iOS widget updates, pairing-grant mint and redeem,
and relay control sweeps remain untracked: they are high-frequency reads and UI
mechanics, or they run on the relay and account-directory surfaces that have no
analytics path.

Machine membership is two more coarse facts on the same `ade_feature_used`
event, added because a production incident — a machine revoked, then a brain
that would not boot — produced no analytics at all.

Removing a computer from the account records `feature: "connections"`,
`action: "machine_removed"`, and a coarse `outcome`. It is captured in
`accountBridge.removeMachine`, not in the IPC handler, because only that
function knows which half failed: the directory delete is the authoritative
membership change, and the Activity purge that follows it rethrows so the user
can retry clearing it. `completed` therefore means the directory accepted the
removal, and `failed` means it did not. No machine key, display name, or account
identifier travels.

The account directory refusing to register **this** computer records
`action: "machine_register_refused"`, `outcome: "failed"`, and `refusal_code` —
one of `machine_revoked`, `pairing_authentication_required`, or `other`. The
desktop can see this because the brain's publisher puts the machine-readable
code in `routeHealth.accountDirectory.lastHttpReason` alongside `http_error` and
a 401/403 (`accountMachinePublisherService`); the desktop never talks to the
directory itself. Any other 401/403 is reported as `other` rather than passing
the server's prose through, and non-refusals (timeouts, 5xx, transport failures)
are left to `ade_publish_failing`, which the brain already emits. The refusal is
a **state**, and the Connections pane and app shell both poll it on a timer, so
only the edge into a refusal is captured; a per-code one-hour key bounds the
case the in-process latch cannot see, an app or brain restarting inside the
refusal. Both events reuse the existing `ade_feature_used` 140-per-day /
30-per-minute limits and the shared 200-event ceiling; no ceiling was raised.

`ade_brain_action_failed` is the one new event. Every brain action the desktop
performs goes through the single `ade.localRuntime.callAction` IPC channel, and
that channel is not a meaningful usage action, so the existing `ade_error`
capture in `registerIpc` has never fired for it — an installation whose brain
rejected every action was silent. The channel is deliberately **not** added to
`MEANINGFUL_ACTIONS`: that set defines the durable `usage_events` mutation
ledger, and joining it would write a mutation row per brain call. Instead the
`callAction` error path emits exactly two properties: `action_domain`, the ADE
action domain, allowlisted against the closed `ADE_ACTION_DOMAIN_NAMES` list in
`services/adeActions/domains.ts` — its own zero-import module, because
`registry.ts` pulls in the whole runtime service graph and the analytics policy
needs only the names, which is why it used to keep a hand-written copy of all
of them; and `error_code`, the structured code from
`codedError`/`Error.code`/the RPC `code:` prefix — the code only, never the
message, never a path, and `ipc_timeout` or `unknown` when there is no code.
Because codes are an open code-authored vocabulary (seeing an unpredicted one is
the point), `error_code` is bounded by shape rather than a literal allowlist: a
lower-case identifier of at most 48 characters, which no path, URL, email,
hostname, or sentence fragment can satisfy. A per-domain-per-code one-hour
deduplication key turns an error loop into one accepted event an hour, and the
event's own 20-per-day / 3-per-minute caps bound the rest without touching
`ade_error`'s budget.

The default machine-wide ceiling is 200 accepted events per UTC day, shared across desktop, runtime, TUI, hosted web, and API-originated aggregates. Each event also has a tighter per-day and per-minute ceiling. Capture ingress is capped, noisy events use persisted deduplication windows, the in-memory transport queue is bounded, and the previous day's accepted/drop totals are summarized in at most two budget events per day.

Persisted `usage_events` are the preferred source for meaningful user mutations. The exporter is locally at-most-once and uses a random v4 client UUID as the PostHog insert ID; non-random or malformed client IDs are regenerated at the transport boundary. Screen events are limited to project, Hub, lanes, work, PRs, settings, and onboarding arrivals; utility/detail/loading transitions are skipped. The hosted Hub uses the existing `ade_screen_viewed` event with only `screen: "hub"`, `route_kind: "web"`, and `source: "renderer_route"`. Its two-second per-screen deduplication and the existing 12-per-minute, 80-per-day screen limits bound rapid tab switching without raising the shared 200-event ceiling. Reads, renderer commits, polling, heartbeats, stream chunks, terminal bytes, progress updates, retries, and other high-frequency mechanics must not emit product events.

The fresh-install milestone is stored in machine analytics state before enqueue. Activation is stored the same way and derives `time_since_install_seconds` locally. Legacy analytics state is marked as already installed and activated during migration so upgrades never create false funnel entrants. Account identification is pseudonymous and limited to three accepted identity changes per UTC day and two per minute. It still consumes PostHog ingestion quota. Explicit sign-out rotates the anonymous ID so later anonymous activity is not attached to the signed-out account.

Daily usage summaries report coarse totals and only the top coarse provider and model family. They never report provider account IDs, exact model strings, prompt content, or per-session content.

The storage doctor emits one `ade_feature_used` per completed maintenance run at the daemon boundary (`storageInsightsService`), with `feature: "storage_doctor"`, `action: "maintenance_run"`, a coarse `outcome` (`completed`, `partial`, or `failed`), and the numeric aggregates `bytes_freed` and `files_compressed`. It carries no paths, table names, or per-item detail. A per-project local dedupe key (`storage_doctor_run:<project>`) with a 20 h minimum interval collapses the daily run and any manual "Clean up now" into a single accepted event, so worst-case volume is well under 2 accepted events per project per day — inside the shared 200-event ceiling and the `ade_feature_used` per-day cap. The run also writes the local `storage.maintenance_completed` jsonl line (with `storage.maintenance_step_failed` per failed step); those operational lines are never forwarded to PostHog.

Desktop prompt-stash creation records the existing coarse
`ade_feature_used` mutation fact with `feature: "chat"` and
`action: "chat.createPromptStash"` through the durable `usage_events` ledger.
The event contains no prompt text, model/provider value, project path, or stash
identifier. Reads, menu opens, restores, and deletes are not product events.
The existing `ade_feature_used` limits cap this at 30 accepted events per minute
and 140 per UTC day without raising the shared 200-event ceiling.

Composer @-mention expansion records the existing coarse `ade_feature_used`
event at the expansion owner boundary (`chatMentionService` via the
`onChatMentionsExpanded` hook, produced by
`captureChatMentionsExpandedAnalytics`) with `feature: "chat"`,
`action: "mention_expanded"`, `outcome: "completed"`, and `source: "runtime"`.
It fires only when a send's text actually gained `<ade-mention>` pointer
blocks — never per keystroke, per suggestion query, or on the idempotent
second expansion pass — and carries no mention targets, titles, previews, or
counts. An installation-wide `chat_mention_expanded` deduplication key with a
one-hour minimum interval bounds it to at most 24 accepted events per UTC day,
inside the existing `ade_feature_used` and shared ceilings. The keystroke-rate
`chat.listMentionSuggestions` read stays untracked by design.

Explicitly regenerating a chat's visible metadata records the existing coarse
`ade_feature_used` event at the chat service boundary via
`captureSessionMetadataRegeneratedAnalytics`, with `feature: "chat"`,
`action: "metadata_regenerated"`, `outcome` (`completed`, `partial`, or
`failed`), and `source: "runtime"`. This measures the user's explicit choice,
not menu opens or model attempts. It carries no generated title, lane name,
status line, prompt, response, model identifier, or raw session/project
identifier; the normal analytics sanitizer and existing `ade_feature_used`
limits apply.

Lane “Archive & Reclaim” records the existing coarse `ade_feature_used`
mutation fact with `feature: "lanes"` and
`action: "lanes.archiveAndReclaim"` through the same durable `usage_events`
ledger.
It records only the successful user action—not lane names, paths, sizes,
blocked reasons, retries, or scheduled review scans. The existing
`ade_feature_used` limits cap it at 30 accepted events per minute and 140 per
UTC day without raising the shared 200-event ceiling.

Opening the account-wide Activity control (renamed from "Attention" in the UI;
the analytics taxonomy deliberately keeps the frozen `attention` keys) records
the existing `ade_feature_used` event with `feature: "attention"`,
`action: "header_opened"`, `outcome: "opened"`, and
`source: "renderer_route"`. The renderer emits no item, machine, project,
session, notification, or error data. A persisted one-hour deduplication key
limits this to at most 24 accepted events per installation per UTC day, inside
the existing `ade_feature_used` and shared daily ceilings. Hover, right-click,
snapshot refresh, acknowledgements, delivery retries, APNs/ActivityKit frames,
and native presentation changes remain untracked because they are either
high-frequency mechanics or can expose work-specific interaction patterns.

### Native iOS

Native UI analytics lives in `apps/ios/ADE/Services/ProductAnalytics.swift`. It uses a separate installation identity and `ade_mobile_*` event namespace so phone engagement cannot inflate desktop activation or retention. After sign-in, it sends the same one-way account hash used by desktop in a quota-counted `$identify` event; the raw account ID is never sent, and sign-out rotates the anonymous installation identity.

iOS analytics is default-on when the public capture configuration is present; the former affirmative opt-in and Settings opt-out have been removed. Its restart-safe ceiling remains 20 events per UTC day, with the existing event-specific limits of 3 app opens, 10 screen views, 7 feature events, 2 coarse errors, and 1 budget summary. Sign-in, machine-adoption, pairing, and quick-connect events use separate `ade_mobile_*` names with closed coarse enum properties and a limit of 2 events each. Foreground duplicate screens and outcomes are suppressed. The transport has no retry loop, redirects, cookies, cache, credential storage, background session, or persistent event queue.

Host-recorded mobile mutations may still appear in the canonical `ade_*` namespace with `surface: mobile`; those events use the machine installation identity and the same shared 200-event budget. Native `ade_mobile_*` events describe only interaction with the phone app itself.

### Public marketing site

The public-site implementation is `apps/web/src/lib/marketingAnalytics.ts` and `marketingAnalyticsBrowser.ts`, mounted by `MarketingAnalyticsBridge.tsx`. It is default-on with a browser-local opt-out (an explicit "false" preference, settable on /privacy) and uses a separate `ade_marketing_*` namespace.

Its durable browser-local ceiling is 40 events per UTC day: 1 app open, 12 screen views, 12 conversion CTA clicks, 16 other feature clicks, 3 coarse browser error categories, and 1 budget summary. A CTA click emits only `ade_marketing_cta_clicked`, never a duplicate feature event. Per-screen/per-key caps and deduplication windows are tighter still. If durable storage is unavailable, analytics fails closed so reloads cannot bypass the budget.

The install dialog (the modal behind every Mac/Windows download button and the
Linux brain link) uses the existing taxonomy: opening it records one feature
event per platform (`install_dialog_mac` / `install_dialog_windows` /
`install_dialog_linux`, emitted once from the dialog provider so every trigger
reports identically), copying a command records
`copy_install_command_<platform>` or `copy_brew_command`, and the direct
download buttons record the CTA event with closed labels
(`download_mac_arm64`, `download_mac_x64`, `download_windows_x64`) at position
`install_dialog`. Events carry no installer URL, release tag, platform
fingerprint, or referrer, and fit inside the unchanged 12-CTA / 16-feature /
40-event public-site ceilings. The `/install.sh`, `/install.ps1`, and
`/download/*` Vercel redirect endpoints are deliberately analytics-free — the
dialog's client-side click is the funnel signal, and a test pins that the
handlers make no analytics call for any method.

The browser sends events directly to `https://us.i.posthog.com/i/v0/e/`. It does not call a Vercel Function or Edge Function, enable Vercel Web Analytics, create a Vercel log drain, or proxy events through ADE infrastructure. PostHog therefore adds no Vercel compute, function-invocation, log-ingestion, or server-side analytics usage. The site retains only its normal static asset delivery; preview and development deployments intentionally have no PostHog environment variables so internal traffic does not spend quota or skew production data.

## Consent and kill switches

- Desktop/runtime builds are default-on when correctly configured and expose a durable opt-out in Settings. The machine-wide disable marker immediately stops all local clients and cancels queued delivery.
- Native iOS is default-on and has no in-app opt-out. Hosted web and the public marketing site are default-on with a durable browser-local opt-out (explicit "false" preference); there is no first-run consent prompt.
- `ADE_DISABLE_PRODUCT_ANALYTICS=1` disables the desktop/runtime service.
- Development builds are analytics-inert unless a developer explicitly sets `ADE_ENABLE_PRODUCT_ANALYTICS_IN_DEVELOPMENT=1`.
- Tests disable analytics automatically.
- Missing or invalid configuration disables capture without affecting ADE startup.

Opting out must stop future capture immediately. Where a surface owns an anonymous installation ID, opting out rotates or removes it so later opt-in does not link activity across the boundary. Repeated opt-out/opt-in cycles must not reset the daily quota.

## Configuration and secrets

Only the public `phc_` PostHog project token may be bundled into client applications. Build validation rejects a personal `phx_` key.

- Desktop and runtime builds: `ADE_POSTHOG_PROJECT_TOKEN`, `ADE_POSTHOG_HOST`
- iOS build settings: `ADE_POSTHOG_PROJECT_TOKEN`, `ADE_POSTHOG_HOST`, injected through the release workflow into `ADEPostHogProjectToken` and `ADEPostHogHost`
- Vercel Production: `VITE_POSTHOG_PROJECT_TOKEN`, `VITE_POSTHOG_HOST`
- Capture origin for the US project: `https://us.i.posthog.com`
- Management API origin: `https://us.posthog.com`

The desktop and runtime bundlers accept empty values so ordinary local builds remain analytics-inert. Release jobs inject the public values only for packaged desktop/runtime artifacts. The iOS archive path validates both values over stdin, references protected environment variables from a temporary mode-0600 xcconfig, and deletes that file immediately after the archive command. The public site receives its `VITE_` values only in the Vercel Production environment.

The full-access personal key belongs only in encrypted ADE secrets. When running the dashboard provisioner, map it to `POSTHOG_PERSONAL_API_KEY` for that process together with `POSTHOG_PROJECT_ID` and `POSTHOG_HOST`. Never put the personal key in GitHub Actions release secrets, Vercel, an app bundle, an `.env` file, source control, logs, screenshots, test fixtures, or a command argument that may be recorded.

## PostHog dashboards

`scripts/posthog/dashboard-spec.mjs` is the declarative source of truth. `scripts/posthog/provision.mjs` validates and idempotently upserts the managed objects. The project currently has five managed dashboards and thirty-four managed insights:

- ADE · Growth and retention
- ADE · Surface and feature adoption
- ADE · Native mobile engagement
- ADE · Marketing acquisition
- ADE · Reliability and analytics budget

The 30-day volume cards split the closed ingested catalog into groups of at most 26 series because PostHog formulas address series by letters `A`…`Z`. Their sum is the total tracked volume; the overflow card includes `$identify` so identity enrichment is not treated as free. When an event or property contract changes, update the dashboard spec and its tests in the same change. Run the provisioner in `--validate` mode locally. A live provisioning run requires the personal management key and should be idempotent: an immediate second run must report no changes.

## How to instrument new code

Instrument a new feature when it adds a meaningful user decision, successful mutation, coarse workflow outcome, screen, or product-level failure category that would change a product decision. Prefer one event at the durable owner boundary over events at every UI entry point.

Use this order:

1. Reuse an existing event. Most product work belongs in `ade_feature_used` with an allowlisted `feature`, `action`, and coarse `outcome`.
2. Emit from the durable mutation ledger or owning service after the action is known to have occurred. UI events are appropriate only for screen adoption or interactions that have no durable backend mutation.
3. Add a stable deduplication key and a minimum interval that matches the product fact being measured.
4. Estimate the worst-case accepted events per installation per day. Fit inside the existing surface ceiling and add a tighter per-event/per-key limit. Do not raise a global ceiling merely to fit a new event.
5. Use coarse enums. If a proposed property needs arbitrary user or runtime text, do not send it.
6. Add privacy, consent, rate-limit, deduplication, and configuration tests at the public analytics boundary.
7. Update the dashboard spec only when the event answers a concrete product question.
8. Update this document when architecture, limits, consent, configuration, or event taxonomy changes.

Do not capture keystrokes, mouse movement, hover, focus, scrolling, render counts, polling cycles, network attempts, sync frames, terminal chunks, token streaming, progress ticks, or every error occurrence. Aggregate locally or record one coarse outcome instead.

## Review and test gate

Every `/test` run must read this file and review the branch for analytics applicability. The change passes the logging/analytics gate only when all applicable items below are true:

- meaningful new behavior uses the existing taxonomy or includes an explicit reason analytics is not applicable;
- no arbitrary values or forbidden content can cross the sanitizer;
- each surface's configured default and disable behavior remain intact;
- worst-case event volume is bounded by durable daily, per-event, and deduplication controls;
- high-frequency mechanics are measured through local aggregation, not raw events;
- public project tokens are the only credentials shipped to clients;
- dashboard definitions and documentation match the event contract;
- focused tests prove sanitization, quota behavior, and fail-closed configuration;
- `node scripts/posthog/provision.mjs --validate` and `node --test scripts/posthog/provision.test.mjs` pass when PostHog definitions change.

The goal is broad product visibility with a small, predictable event budget. More call sites are not automatically better telemetry.

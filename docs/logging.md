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

Writes are batched onto an async stream, so a caller that is about to end the process (`app.exit`, a force quit, an install handoff escalation) must call `logger.flushSync()` immediately after the line that matters — while it is still queued — or the records explaining the exit die with the process. `flushSync` drains only what is still queued (a batch already handed to an in-flight async flush is not duplicated), skips rotation deliberately, and, like every other log write, never throws.

Not every operational log belongs to the active project. `createFileLogger` also backs machine-scoped sinks for facts that outlive or fall outside a project: `accountBridge` writes `account.local_machines_removed` to `<machine ade dir>/runtime/account-trust.jsonl`, because dropping a paired machine credential is a machine-level mutation and the project logger follows the active project — on a remote-bound project it would ship the record to the other machine and leave nothing on the machine that actually lost its trust. Account-directory publish outcomes record only bounded per-leg durations, the failing leg, and coarse failure codes such as `token_timeout` or `http_timeout`; they never include bearer tokens or response bodies. These high-frequency health events remain local operational logs and are not product analytics.

Claude compaction observations use the local structured line
`agent_chat.claude_context_compaction_observed` with `sessionId`, `trigger`
(`natural`, `ade_fallback`, or `recovery`), and `occupancyPctAtTrigger`. Record
every natural and ADE-issued compaction so production logs can verify that the
SDK still compacts naturally above its high-water mark. The fallback gate's
debug line is `agent_chat.claude_context_compaction_fallback_gate`; neither line
is a PostHog event.

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
- `ade_brain_recovered`
- `ade_publish_failing`
- `ade_relay_suppressed`
- `ade_account_session_unreadable`

The update and reliability events are low-frequency by construction: the five `ade_update_*` events fire at most once per install attempt or idle-apply cycle (daily caps 10–20, minute caps 3–6). `ade_update_install_did_not_land` is emitted once at startup when a requested install relaunched on the old version, so it is bounded by app launches that follow a failed handoff, and carries only a bounded `attempt` counter; `ade_brain_recovered` fires once per wedge recovery at brain startup; `ade_publish_failing` is edge-triggered once per sustained failure episode (first crossing of two minutes), never per attempt.

Changing automatic-install preferences records the existing `ade_feature_used`
event at the update-service owner boundary with `feature: "updates"`,
`action: "preferences_changed"`, a coarse `mode` (`automatic` or `manual`), and
a coarse `outcome` (`idle_only` or `immediate`). It carries no paths, versions,
session details, or runtime activity counts. A persisted 24-hour deduplication
key per preference combination bounds this to at most four accepted events per
installation per UTC day, within the existing `ade_feature_used` and shared
daily ceilings.

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

Clicking "Repair" on the Connections pane's unreadable-session banner records
the existing `ade_feature_used` event at the IPC owner boundary (where the
restart outcome is known) with `feature: "connections"`,
`action: "brain_repair"`, and a coarse `outcome` (`completed` or `failed`). It
carries no error text, paths, or machine identifiers — the thrown error stays in
the renderer. A per-outcome one-hour deduplication key bounds a click-loop to at
most 24 accepted events per installation per UTC day, inside the existing
`ade_feature_used` and shared ceilings.

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

The gated Windows download uses the existing CTA event with the closed
`cta_label: "download_for_windows"`, `screen: "download"`, and
`position: "download_page"` values. It carries no installer URL, release tag,
platform fingerprint, or referrer. The same CTA key is limited to three
accepted events per UTC day with a 1.5-second deduplication window, inside the
unchanged 12-CTA and 40-event public-site ceilings. Because annotated CTA
clicks suppress the companion feature event, one click still consumes one
event.

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

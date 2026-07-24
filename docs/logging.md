# Logging and product analytics

This is ADE's ground truth for operational logging and anonymous product analytics. Read it before adding telemetry, changing an analytics event, or reviewing a feature with `/test`.

ADE is local-first. Operational logs stay local and help diagnose software behavior. Product analytics is a separate, deliberately narrow PostHog data path that answers how anonymous installations use ADE. PostHog is not a remote log sink, crash dump service, session recorder, or copy of ADE's local state.

## Non-negotiable boundaries

Never send any of the following to PostHog:

- prompts, responses, transcripts, code, diffs, file contents, terminal output, clipboard contents, screenshots, recordings, or proof artifacts;
- project, repository, lane, branch, file, or directory names and paths;
- command text or arguments, URLs, referrers, issue titles, PR titles, user-entered labels, raw errors, stack traces, or local log messages;
- credentials, tokens, email addresses, account identifiers, device names, or other user-provided strings;
- raw project IDs, session IDs, or other stable local database identifiers.

No PostHog SDK is linked. ADE calls the Capture API directly so autocapture, automatic pageviews, session replay, surveys, feature flags, remote config, automatic crash capture, and SDK-managed offline queues remain absent. Every event disables person profiles and GeoIP with `$process_person_profile: false` and `$geoip_disable: true`.

Only closed event names, closed property keys, and coarse allowlisted values may cross the analytics boundary. Desktop/runtime raw project and session IDs are installation-salted and hashed before capture. Local deduplication keys are also hashed and are never transmitted.

## Operational logs versus analytics

Operational logs use ADE's local logging services and may include bounded diagnostic context appropriate for the local machine. They are for debugging a specific installation and must not be forwarded to PostHog.

The machine brain writes the same `{ts, level, event, meta}` JSONL format as the desktop logger to `~/.ade/runtime/brain.jsonl`, honoring `ADE_LOG_LEVEL` (default `info`). The file rotates at 10 MiB to `brain.1.jsonl`; warnings and errors are also mirrored to stderr with an ISO-8601 timestamp and uppercase level for launchd diagnostics. Account-directory publish outcomes record only bounded per-leg durations, the failing leg, and coarse failure codes such as `token_timeout` or `http_timeout`; they never include bearer tokens or response bodies. These high-frequency health events remain local operational logs and are not product analytics.

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
- `apps/desktop/src/renderer/webclient/adapter/analytics.ts` keeps the hosted client's affirmative choice in browser storage and reasserts it on every connection. It retries transient consent-sync failures, then disconnects fail-closed only when an opt-out acknowledgement still cannot be confirmed.
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

- `ade_app_opened`
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
- `ade_update_auto_applied`
- `ade_update_auto_apply_cancelled`
- `ade_brain_recovered`
- `ade_publish_failing`

The update and reliability events are low-frequency by construction: the four `ade_update_*` events fire at most once per install attempt or idle-apply cycle (daily caps 10–20, minute caps 3–6); `ade_brain_recovered` fires once per wedge recovery at brain startup; `ade_publish_failing` is edge-triggered once per sustained failure episode (first crossing of two minutes), never per attempt. Properties are closed enums and bounded numbers — `reason` is allowlisted to the abort-reason constant, `last_command` is a closed sync-action slug, and `leg`/`code` are the coarse publish classifications. Worst-case combined volume is a handful of events on a very bad day, inside the shared ceiling.

The default machine-wide ceiling is 200 accepted events per UTC day, shared across desktop, runtime, TUI, hosted web, and API-originated aggregates. Each event also has a tighter per-day and per-minute ceiling. Capture ingress is capped, noisy events use persisted deduplication windows, the in-memory transport queue is bounded, and the previous day's accepted/drop totals are summarized in at most two budget events per day.

Persisted `usage_events` are the preferred source for meaningful user mutations. The exporter is locally at-most-once and uses a random v4 client UUID as the PostHog insert ID; non-random or malformed client IDs are regenerated at the transport boundary. Reads, renderer commits, polling, heartbeats, stream chunks, terminal bytes, progress updates, retries, and other high-frequency mechanics must not emit product events.

Daily usage summaries report coarse totals and only the top coarse provider and model family. They never report provider account IDs, exact model strings, prompt content, or per-session content.

The storage doctor emits one `ade_feature_used` per completed maintenance run at the daemon boundary (`storageInsightsService`), with `feature: "storage_doctor"`, `action: "maintenance_run"`, a coarse `outcome` (`completed`, `partial`, or `failed`), and the numeric aggregates `bytes_freed` and `files_compressed`. It carries no paths, table names, or per-item detail. A per-project local dedupe key (`storage_doctor_run:<project>`) with a 20 h minimum interval collapses the daily run and any manual "Clean up now" into a single accepted event, so worst-case volume is well under 2 accepted events per project per day — inside the shared 200-event ceiling and the `ade_feature_used` per-day cap. The run also writes the local `storage.maintenance_completed` jsonl line (with `storage.maintenance_step_failed` per failed step); those operational lines are never forwarded to PostHog.

### Native iOS

Native UI analytics lives in `apps/ios/ADE/Services/ProductAnalytics.swift`. It uses a separate anonymous installation identity and separate `ade_mobile_*` event namespace so phone engagement cannot inflate desktop activation or retention.

iOS analytics is default-on when the public capture configuration is present; the former affirmative opt-in and Settings opt-out have been removed. Its restart-safe ceiling remains 20 events per UTC day, with the existing event-specific limits of 3 app opens, 10 screen views, 7 feature events, 2 coarse errors, and 1 budget summary. Sign-in, machine-adoption, pairing, and quick-connect events use separate `ade_mobile_*` names with closed coarse enum properties and a limit of 2 events each. Foreground duplicate screens and outcomes are suppressed. The transport has no retry loop, redirects, cookies, cache, credential storage, background session, or persistent event queue.

Host-recorded mobile mutations may still appear in the canonical `ade_*` namespace with `surface: mobile`; those events use the machine installation identity and the same shared 200-event budget. Native `ade_mobile_*` events describe only interaction with the phone app itself.

### Public marketing site

The public-site implementation is `apps/web/src/lib/marketingAnalytics.ts` and `marketingAnalyticsBrowser.ts`, mounted by `MarketingAnalyticsBridge.tsx`. It requires an affirmative browser-local choice and uses a separate `ade_marketing_*` namespace.

Its durable browser-local ceiling is 40 events per UTC day: 1 app open, 12 screen views, 20 feature clicks, 3 coarse browser error categories, and 1 budget summary. Per-screen/per-feature caps and deduplication windows are tighter still. If durable storage is unavailable, analytics fails closed so reloads cannot bypass the budget.

The browser sends events directly to `https://us.i.posthog.com/i/v0/e/`. It does not call a Vercel Function or Edge Function, enable Vercel Web Analytics, create a Vercel log drain, or proxy events through ADE infrastructure. PostHog therefore adds no Vercel compute, function-invocation, log-ingestion, or server-side analytics usage. The site retains only its normal static asset delivery; preview and development deployments intentionally have no PostHog environment variables so internal traffic does not spend quota or skew production data.

## Consent and kill switches

- Desktop/runtime builds are default-on when correctly configured and expose a durable opt-out in Settings. The machine-wide disable marker immediately stops all local clients and cancels queued delivery.
- Native iOS is default-on and has no in-app opt-out. Hosted web and the public marketing site still require an affirmative first-run choice before capture.
- `ADE_DISABLE_PRODUCT_ANALYTICS=1` disables the desktop/runtime service.
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

`scripts/posthog/dashboard-spec.mjs` is the declarative source of truth. `scripts/posthog/provision.mjs` validates and idempotently upserts the managed objects. The project currently has five managed dashboards and thirty-one managed insights:

- ADE · Growth and retention
- ADE · Surface and feature adoption
- ADE · Native mobile engagement
- ADE · Marketing acquisition
- ADE · Reliability and analytics budget

When an event or property contract changes, update the dashboard spec and its tests in the same change. Run the provisioner in `--validate` mode locally. A live provisioning run requires the personal management key and should be idempotent: an immediate second run must report no changes.

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

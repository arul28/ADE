# Logging, error tracking and product analytics

This is DAEX's ground truth for operational logs, error tracking (Sentry) and
privacy-bounded product analytics (PostHog). Read it before adding telemetry,
changing an analytics event, adding a failure path, or reviewing a feature with
`/test`.

Three paths, kept apart:

- **Operational logs** stay on the machine and diagnose one installation.
- **Error tracking** sends crashes, errors and warnings to Sentry so failures
  are seen without anyone pressing a button.
- **Product analytics** is a narrow PostHog path that answers how installations
  use DAEX. PostHog is not a remote log sink or crash dump.

Telemetry identifiers keep the old name on purpose: PostHog event names
(`ade_*`, `ade_mobile_*`, `ade_marketing_*`), Sentry projects (`ade-desktop`,
`ade-brain`, …) and releases (`ade@<version>`), `ADE_*` env vars, log file
names, and the managed dashboard names (`ADE · …`). Renaming them would split
every chart and issue history in two. See [brand/README.md](./brand/README.md).

The per-feature event catalog is
[analytics/tracking-plan.json](./analytics/tracking-plan.json); the PostHog
setup guide is [analytics/README.md](./analytics/README.md).

## Non-negotiable boundaries

Never send any of the following to PostHog:

- prompts, responses, transcripts, code, diffs, file contents, terminal output,
  clipboard contents, screenshots or proof artifacts, and no recording in which
  any of them can be read (session replay shows only DAEX's own interface text,
  see [Session replay](#session-replay));
- project, repository, lane, branch, file or directory names and paths;
- command text or arguments, URLs, referrers, issue or PR titles, user-entered
  labels, raw errors, stack traces or local log messages (exceptions: the public
  site's own page address, referrer and campaign tags, and `$exception`, which
  carries an error after Sentry's scrub);
- credentials, tokens, email addresses, device names or other user-provided
  strings;
- raw account identifiers anywhere but the person profile (`$identify` and the
  server-side `ade_signed_up` set the Clerk user id only as the person property
  `clerk_user_id`);
- raw project ids, session ids or other stable local database ids.

Events go through the Capture API directly. The desktop window and the
marketing site load posthog-js for session replay only
(`renderer/lib/sessionReplay.ts`, `apps/web/src/lib/marketingReplay.ts`), with a
`before_send` filter that drops everything but `$snapshot` (and, on the site,
`$$heatmap`).

Only closed event names, closed property keys and coarse allowlisted values
cross the boundary. Raw project and session ids are installation-salted and
hashed before capture; local deduplication keys are hashed and never sent.

## Operational logs

All desktop and brain loggers use `createFileLogger`
(`apps/desktop/src/main/services/logging/logger.ts`): JSONL lines
`{ts, level, event, meta}`, `ADE_LOG_LEVEL` (default `info`), 10 MiB rotation
to `<name>.1.jsonl`, every write through `redactSecrets()` /
`sanitizeStructuredData()`.

| File | Writer | Subject |
|---|---|---|
| `~/.ade/runtime/desktop-main.jsonl` | `machineLogger.ts`, from process start | the desktop app on this computer |
| `~/.ade/runtime/brain.jsonl` | `apps/ade-cli/src/services/runtime/brainLogger.ts` | the brain process |
| `~/.ade/runtime/account-trust.jsonl` | `accountBridge` | paired-credential changes |
| `<project>/.ade/transcripts/logs/main.jsonl` | the desktop's project logger | one repository, from the desktop |
| `<project>/.ade/transcripts/logs/ade-cli.jsonl` | the logger `createAdeRuntime` builds | one repository, from a project runtime in the brain |
| `~/.ade/runtime/launchd.out.log` / `launchd.err.log` (Windows: supervisor log; Linux: `systemd.*.log`) | the service manager | the brain's stdout and stderr on its way up |

Rules:

- **Log by subject.** An event about the computer goes to a machine log; an
  event about a repository goes to that project's log.
- **Flush before exit.** Writes are batched. A caller about to end the process
  (`app.exit`, a force quit, an install handoff) calls `logger.flushSync()`
  right after the line that matters.
- **Dropped work leaves a line.** Work DAEX owes (a continue message after a
  restart, a queued send) is never dropped silently: log the session id and a
  closed reason code, never chat text.
- **Logs never feed analytics.** Product analytics must not inherit fields from
  a log record, exception, IPC payload, database row or component props. Keep
  log calls and analytics calls separate.
- Warn and error lines are mirrored to Sentry where a Sentry client runs
  (`shared/sentry/logBridge.ts`); info and debug lines never leave the machine
  except in a diagnostic report's log tail.

`<home>/projects.json` writes are journaled (`projectRegistryJournal.ts`,
`projects.journal.jsonl`): each write holds `projects.json.lock` and records
who wrote what, so a vanished project can be traced.

## Error tracking (Sentry)

Sentry runs on every surface, with no setting and no notice. Organization
`ade-app` (US region), one project per surface:

| Project | Surface | Started in |
|---|---|---|
| `ade-desktop` | Electron main, renderer (over IPC to main), preload, native crashes | `apps/desktop/src/main/sentry/initMain.ts`; renderer `src/renderer/sentry/initRenderer.ts` |
| `ade-brain` | the brain (`daex serve`: desktop-started, background service, remote machine) | `apps/ade-cli/src/sentry/initBrain.ts` |
| `ade-web` | hosted web client | `apps/desktop/src/renderer/webclient/sentry.ts`, after first paint |
| `ade-workers` | push-relay, tunnel-relay, webhook-relay, account-directory (tag `worker`) | each Worker |
| `ade-ios` | the iOS app (not widgets or the App Clip) | `apps/ios/ADE/Services/CrashReporting.swift` |

**When it runs.** Packaged builds only. Workers report only where their deployed
config sets `SENTRY_ENVIRONMENT` to `production` and the deploy passes
`SENTRY_RELEASE`. `ADE_SENTRY_DISABLED` turns it off.

**What is sent.** Error messages, stack traces, file paths, ids (lane, chat
session, project, account hash), counts, durations, OS and hardware facts, the
package channel, and breadcrumbs (slow or failed IPC, brain connects and
disconnects, project-list removals, memory steps). A report from main or the
brain also carries (`shared/sentry/diagnostics.ts`) process and connection
contexts and gzipped log tails: the last 1,000 lines this process logged, the
newest part of `brain.jsonl` (desktop), and the service's own logs. Log tails go
as written, secrets removed (`scrubDiagnosticText`), because a report must show
what the process did.

**What is never sent** in the event itself: prompt and transcript text, model
output, file contents and diffs, terminal output, clipboard, secrets.

**What becomes an issue.**

- Uncaught exceptions and unhandled rejections, error-boundary crashes, native
  crashes.
- Every failed `ipcMain.handle` call, once per channel and error code
  (`main/sentry/ipcCapture.ts`); runtime-action channels rebuild the brain's
  error from its reply.
- Every failed brain action that is a defect (`reportFailedAction` in
  `adeRpcServer.ts`, tagged `runtime.action`).
- Every `logger.error` line (`shared/sentry/logBridge.ts`).
- Named warnings for conditions that need a person: a brain that keeps
  restarting (`brainRestartLoop.ts`), a brain freeze with a named cause
  (`brainStallProfiler.ts`), the first `runtime-failed` health transition per
  provider and kind (`providerRuntimeHealth.ts`), DAEX Cloud server failures
  (`reportCloudFailure`, `apps/account-directory/src/cloud/store.ts`), and
  feature-specific warnings with a stable `fingerprint`.

**What is a Sentry Log, not an issue.** Things the user is shown or can fix:

- An error its throw site marked as an answer:
  `new AdeExpectedError(message, kind)` or `markExpected(error, kind)` from
  `shared/expectedError.ts` (`kind` such as `user`). Text patterns in
  `shared/sentry/expectedFailure.ts` cover the same failures from older brains.
- Every error toast (`toast.<start of title>`) and every failure notice shown
  (`notice.shown`, `ui/notice/NoticeReport.tsx`).
- Connection failures to another machine (`remote.connect_failed`,
  `remoteRuntime/remoteDialTelemetry.ts`), a provider going `auth-failed`, a
  resource-pressure episode (`machine.resource_pressure`,
  `resourcePressureMonitor.ts`), a slow project open (`project.open_slow`).
- Expected outcomes of an IPC call or brain action (`EXPECTED_OUTCOME_PATTERNS`,
  `EXPECTED_OUTCOME_CODES`), a failed agent `daex` call that is not a defect
  (`runtime_action.agent.<action>`), an IPC timeout that spanned a sleep, and
  repeated timeouts of one stall after the first.

**Release-health lines.** A few info lines (for example `app.started`) go to
Sentry Logs so a release shows that it ran and updated cleanly.

**Tags on every event.** `sentryCommonTags` in `shared/sentry/config.ts` (Swift:
`CrashReporting.start`): `surface`, `client`, `release_channel`, `machine_id`
and more. Releases are named `ade@<version>` from the `v*` tag.

**Readable stack traces.** Release builds set `ADE_BUILD_SOURCEMAPS=1`, inject
debug ids, upload the maps (Sentry, then PostHog) and delete them before
packaging, so no map reaches a user.

**User Feedback and the report dialog.** Every error surface's "Report this
error to DAEX…" control opens one dialog
(`renderer/components/app/ReportIssueDialog.tsx`) that sends nothing until the
person confirms. A sent report makes one Sentry User Feedback entry
(`main/sentry/userFeedback.ts`; the hosted web client sends to `ade-web` from
the browser, `renderer/webclient/adapter/diagnostics.ts`).

**Instrumenting new code.** Use `captureError(error, context)` and
`captureProblem(message, context)` from
`apps/desktop/src/shared/sentry/capture.ts` (Swift: `CrashReporting.capture`).
They are no-ops where Sentry does not run, so never guard them. Give a
condition that should group together a stable `fingerprint`. Mark an expected
failure at its throw site instead of filtering its text later.

**Triage.** `sentry issue list ade-app/<project> --query "is:unresolved" --period 24h`,
`sentry issue view <ID>`, `sentry issue events <ID>`,
`sentry log list ade-app/<project> -q "severity:error"`. An event's log tails
are under its Attachments tab. `daex triage` follows
[triage/PLAYBOOK.md](./triage/PLAYBOOK.md).

**Account-side settings** (Sentry and PostHog, not code): PostHog project
510983 has `anonymize_ips: true`. Sentry's inbound release filters on
`ade-desktop` and `ade-brain` drop events from stable bands that aged out of
support; add the next band when it ages out.

## Product analytics (PostHog)

### Desktop, brain and hosted web

The service is
`apps/desktop/src/main/services/analytics/productAnalyticsService.ts`, shared
by desktop main and the brain with one machine-scoped state file
(`<home>/secrets/product-analytics.json`, plus a `.disabled` marker for a
fail-closed opt-out). It is not project state and never replicates. The hosted
web client sends allowlisted events through the brain's action registry; it has
no PostHog transport of its own.

The contract is `apps/desktop/src/shared/types/productAnalytics.ts`. Every
event carries one `surface`: `desktop`, `mobile`, `cli`, `web` or `api` (older
builds said `tui` for the CLI; `normalizeAdeUsageClientSurface` reads it as
`cli`). The closed event set:

`ade_app_installed`, `ade_app_opened`, `ade_activated`, `ade_screen_viewed`,
`ade_project_opened`, `ade_feature_used`, `ade_work_session_started`,
`ade_work_session_completed`, `ade_error`, `ade_daily_usage_summary`,
`ade_analytics_budget`, `ade_update_install_aborted`,
`ade_update_quit_escalated`, `ade_update_install_did_not_land`,
`ade_update_auto_applied`, `ade_update_auto_apply_cancelled`,
`ade_update_prompted`, `ade_tool_fetched`, `ade_brain_recovered`,
`ade_renderer_recovered`, `ade_publish_failing`, `ade_relay_suppressed`,
`ade_account_session_unreadable`, `ade_brain_action_failed`,
`ade_resource_pressure`.

Most product work is `ade_feature_used` with an allowlisted `feature`, `action`
and coarse `outcome` (producers in `featureProductAnalytics.ts` and the other
`analytics/*ProductAnalytics.ts` files).

**Properties on every event** (beside `app_version`, `runtime_mode`, `platform`,
`arch`):

- `client`: `desktop`, `web`, `cli`, `ios` (a host-recorded phone mutation) or
  `runtime` (the brain or CLI).
- `interactive`: `false` for events no person caused (daily summary, budget,
  update and recovery events, automation work, `mode: "automatic"` feature
  uses); see `productAnalyticsEventContext` in `productAnalyticsPolicy.ts`.
  Dashboards count a person as active only on `PERSON_ACTIVITY`
  (`scripts/posthog/dashboard-spec.mjs`).
- `is_internal`: `true` for a team install (`ADE_ANALYTICS_INTERNAL=1` or an
  empty `secrets/product-analytics.json.internal` file) and for a development
  runtime allowed to send.
- `environment`: `production`, `beta`, `alpha`, `development` or `ci` (the same
  value Sentry uses).
- `ade_cloud`: `true` on a DAEX Cloud computer (`ADE_CLOUD_INSTANCE_ID`).
- `release_channel`: `stable`, `beta`, `alpha`, `development` or `unknown`
  (`resolveReleaseChannel`, `shared/packageChannel.ts`).
- `machine_id`: the install on one computer, 16 hex characters
  (`machineTelemetryId.ts`). The distinct id is the person once signed in;
  `machine_id` tells their computers apart. A state file copied to another
  computer gets a new installation id and salt.

A count of real users leaves out `is_internal = true`,
`review_context = 'app_review'` and `environment = 'ci'`.

**Milestones.** `ade_app_installed` and `ade_activated` are once per
installation and count as sent only after delivery is confirmed; an unconfirmed
one is resent with the same uuid. `ade_activated` fires on the first completed
chat turn or the first agent CLI session started or imported.
`install_source` is `direct_download`, `homebrew`, `install_script`,
`development` or `unknown`. The first `ade_app_opened` from each client carries
`first_open: true`.

**Identity.** A signed-in account sends one quota-counted `$identify` with a
one-way account hash (`ade_user_…`) plus plan, platform and app version;
sign-out rotates the anonymous id. The sign-in funnel is `ade_feature_used` with
`feature: "account_sign_in"` (`accountSignInAnalytics.ts`): one start and one
end per attempt.

**Budgets.** Capture is lazy and batched, with a hard installation-wide budget
of 200 events per UTC day (`DEFAULT_DAILY_BUDGET`), tighter per-event budgets
(`EVENT_DAILY_BUDGETS`) and per-minute caps, deduplication windows and bounded
queues. `ade_analytics_budget` summarizes what was dropped. Opting out and back
in never resets the daily quota.

### Server-side events (account directory)

Some facts happen on a server, so the account-directory Worker records them
itself, on the account's `ade_user_…` distinct id with uuids derived from the
account (so retries dedupe):

- `ade_signed_up` and `ade_account_deleted` from Clerk's `user.created` /
  `user.deleted` webhook (`apps/account-directory/src/signupAnalytics.ts`,
  `POST /webhooks/clerk`, needs `CLERK_WEBHOOK_SIGNING_SECRET` and
  `POSTHOG_PROJECT_TOKEN`). Carries `signup_method`, never the email or name.
  Accounts with `ade_internal: true` in Clerk metadata are marked internal.
- `ade_welcome_email_sent` for the day-2 getting-started email
  (`src/welcomeEmail.ts`), at most one per account.
- DAEX Cloud product facts (creates, grows, refusals, plan changes) from
  `src/cloud/analytics.ts`, because the server decides them for every client.

`scripts/analytics/reconcile-signups.mjs` compares Clerk accounts with
`ade_signed_up` and backfills missing ones (`analytics-reconcile.yml`, weekly).
`scripts/analytics/data-health.mjs` checks that events still arrive
(`analytics-health.yml`, every six hours).

### Native iOS

`apps/ios/ADE/Services/ProductAnalytics.swift`, with its own installation
identity and the `ade_mobile_*` namespace so phone use never inflates desktop
counts. It sends the same account hash in `$identify` after sign-in. Every event
carries `client: "ios"`, `app_version`, `build_number`, `distribution`,
`release_channel` and `environment`. Ceiling: 20 events per UTC day
(`dailyEventLimit`), with tighter per-event limits. Host-recorded phone
mutations appear in the `ade_*` namespace with `surface: mobile` under the
machine's 200-event budget. `PrivacyInfo.xcprivacy` files declare the shipped
privacy surface.

### Public marketing site

`apps/web/src/lib/marketingAnalytics.ts` and `marketingAnalyticsBrowser.ts`,
mounted by `MarketingAnalyticsBridge.tsx`. Default-on with a browser-local
opt-out on `/privacy`, separate `ade_marketing_*` namespace, 40 events per
browser per UTC day. It sends straight from the browser to PostHog (no Vercel
function, no Vercel analytics, no log drain). Production gets the public
`VITE_POSTHOG_*` values; Preview and Development stay inert.

### LLM analytics

Each settled agent turn sends one `$ai_generation`
(`captureAgentTurnSettledAnalytics`, `agentTurnProductAnalytics.ts`, from
desktop main and the brain): `$ai_provider` (the closed provider list),
`$ai_model` (the model id only when it is in `MODEL_REGISTRY`, else `other`),
token counts, `$ai_total_cost_usd`, `$ai_latency`, `$ai_is_error`, `feature`
and `outcome`; a failed turn adds a closed `error_kind` (`turnFailureKind`).
`$ai_trace_id` is the salted session hash. There is no field for a prompt,
output or tool.

### PostHog error tracking

Every error event Sentry admits in desktop main (which carries renderer errors)
and the brain is mirrored to PostHog as `$exception`, after Sentry's filter,
budget and scrub (`setSentryEventMirror` in `shared/sentry/eventFilter.ts`,
`main/services/analytics/exceptionProductAnalytics.ts`). PostHog never sees more
than Sentry did. Release builds upload source maps with
`scripts/posthog/upload-sourcemaps.mjs`.

### Session replay

With analytics on, the desktop window records a session replay
(`renderer/lib/sessionReplay.ts`, posthog-js pinned, nothing loaded from a CDN).
It loads only when `analytics.getReplayConfig` (`registerSessionReplayIpc.ts`)
returns a config.

- Every text node is masked except DAEX's own interface text in regions marked
  `data-ph-unmask` (sidebar tabs, settings titles, `Banner`, toasts, dialog
  headers, error notices); paths, emails, secrets and the names of the person's
  projects, lanes and branches are starred out even there. Every input is
  masked.
- Never recorded: images, video, canvases, frames, webviews, `.xterm`
  terminals, Monaco, and anything marked `data-ph-block`. Autocapture,
  pageviews, console and network capture are off. The page address is reduced
  to `ade://desktop/<tab>`.
- iOS (`apps/ios/ADE/Services/SessionReplay.swift`, main app only) records
  screenshot-based replay with every text, input and image masked.
- The marketing site (`marketingReplay.ts`) keeps public page text and records
  heatmaps while its analytics preference is on.
- DAEX's own people are never recorded: the flag `session-replay-real-users` is
  false for persons with `is_internal = true`.

New UI that shows the person's content must not sit inside a `data-ph-unmask`
region. See [design/notices.md](./design/notices.md) for the notice primitives
that are unmasked.

### Worker logs (PostHog Logs)

The four Workers send sampled OTLP log records to PostHog Logs
(`src/posthogLogs.ts` in each, `/i/v1/logs`, under `ctx.waitUntil` with a
two-second timeout; a failure is swallowed). A record holds the Worker name and
environment, the event name and closed fields only.

### Dashboards and surveys

`scripts/posthog/dashboard-spec.mjs` is the declarative source of truth for the
managed dashboards and insights; `scripts/posthog/provision.mjs` validates and
upserts them. Install counts count machines
(`count(distinct coalesce(properties.machine_id, distinct_id))`), not people.
Insights leave out internal events and internal persons.

The desktop shows PostHog API surveys in its own corner card
(`main/services/analytics/surveyService.ts`), read at most once a day and only
when this install qualifies locally.

## Diagnostic reports

A diagnostic report (the desktop report dialog and automatic sends,
`daex report-issue`, the brain's automatic sends; see
[storage-and-recovery](./features/storage-and-recovery/README.md)) states the
install (channel, packaged or not, hardware), machine health
(`apps/ade-cli/src/services/diagnostics/machineHealth.ts`: memory, swap, load,
DAEX processes, recent resource-pressure episodes), the last wedge if under
seven days old, and trimmed log tails in which a line repeated five or more
times keeps only its newest copy. The upload sends `machineId` beside
`installId`, so a report can be found from a Sentry event or a PostHog machine.

## Consent and kill switches

- Product analytics and automatic diagnostic reports are on by default on every
  surface. No Settings, web or iOS control turns them on or off, and there is no
  consent prompt.
- Honored everywhere, silently: `DO_NOT_TRACK=1`, and a persisted explicit
  opt-out from an earlier build (the desktop state file's `enabled: false` or
  its `.disabled` marker, the automatic-send ledger's `enabled: false`, the
  hosted web's `ade:web-product-analytics-enabled` set to `"false"`).
- The desktop disable marker stops every local client at once and cancels
  queued delivery.
- `ADE_DISABLE_PRODUCT_ANALYTICS=1` disables the desktop and brain service.
  `ADE_USAGE_RESEARCH=0` stops only the daily usage report.
- iOS honors `DO_NOT_TRACK=1`; a Debug or simulator run is off unless it is the
  test suite or `ADE_ENABLE_PRODUCT_ANALYTICS_IN_DEVELOPMENT=1`. The marketing
  site keeps its own opt-out.
- Development builds are inert unless `ADE_ENABLE_PRODUCT_ANALYTICS_IN_DEVELOPMENT=1`
  (an unpackaged desktop, `ADE_DEV_BRAIN=1`, any `release_channel: development`);
  what that flag lets through is `is_internal: true`.
- Tests and CI disable analytics automatically (`CI`, `GITHUB_ACTIONS`,
  `GITLAB_CI`, `CIRCLECI`, `TRAVIS`, `BUILDKITE`, `TF_BUILD`, `JENKINS_URL`,
  `ADE_TEMPLATE_CHECK`). The DAEX Cloud template check sets `DO_NOT_TRACK`,
  `ADE_SENTRY_DISABLED` and `ADE_TEMPLATE_CHECK`.
- Missing or invalid configuration disables capture without affecting startup.

Opting out stops future capture immediately; where a surface owns an anonymous
installation id, opting out rotates or removes it.

## Configuration and secrets

Only the public `phc_` PostHog project token may be bundled into a client.
Build validation rejects a personal `phx_` key.

- Desktop and brain builds: `ADE_POSTHOG_PROJECT_TOKEN`, `ADE_POSTHOG_HOST`
  (`apps/desktop/tsup.config.ts`, `apps/ade-cli/tsup.config.ts`). Empty values
  keep local builds inert; release jobs inject the public values.
- iOS: `ADE_POSTHOG_PROJECT_TOKEN`, `ADE_POSTHOG_HOST`, validated by
  `apps/ios/Scripts/validate-posthog-project-token.sh` and passed through a
  temporary mode-0600 xcconfig deleted after the archive.
- Vercel Production: `VITE_POSTHOG_PROJECT_TOKEN`, `VITE_POSTHOG_HOST`
  (`apps/web/vite.config.ts` rejects non-`phc_` tokens).
- Capture origin `https://us.i.posthog.com`; management API
  `https://us.posthog.com`.

The full-access personal key lives only in encrypted DAEX secrets; map it to
`POSTHOG_PERSONAL_API_KEY` (with `POSTHOG_PROJECT_ID`, `POSTHOG_HOST`) for the
provisioner process only. Never put it in GitHub Actions, Vercel, an app bundle,
an `.env` file, source control, logs or a command argument.

Release workflows use a second, scoped personal key (GitHub secrets
`POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID`, optional `POSTHOG_HOST`) for
release annotations (`scripts/posthog/annotate-release.mjs`), source maps
(`scripts/posthog/upload-sourcemaps.mjs`) and iOS dSYMs
(`scripts/release-tools/upload-ios-dsyms.sh`). Each step skips with a notice
when the key is missing.

## Source file map

Desktop and brain:

- `apps/desktop/src/shared/types/productAnalytics.ts`: the closed event,
  surface and capture contracts.
- `apps/desktop/src/main/services/analytics/productAnalyticsPolicy.ts`:
  property allowlists, value normalization, internal-only events, budgets.
- `apps/desktop/src/main/services/analytics/productAnalyticsService.ts`:
  consent, installation identity, salted hashing, dedupe and quota state, the
  Capture API transport.
- `usageProductAnalyticsExporter.ts`, `dailyUsageAnalytics.ts`,
  `agentTurnProductAnalytics.ts`, `featureProductAnalytics.ts` and the other
  `*ProductAnalytics.ts` files in the same folder: the producers.
- `apps/desktop/src/renderer/components/analytics/ProductAnalyticsLifecycle.tsx`:
  renderer lifecycle producers behind the preload boundary.
- `apps/desktop/src/shared/sentry/`: Sentry config, capture helpers, filters,
  scrub, log bridge, diagnostics.

Clients:

- `apps/ade-cli/src/services/sync/productAnalyticsRemoteCommand.ts`: binds a
  paired client's surface and project identity at the host.
- `apps/desktop/src/renderer/webclient/adapter/analytics.ts`: the hosted web
  client's browser-local opt-out.
- `apps/ios/ADE/Services/ProductAnalytics.swift`, `CrashReporting.swift`,
  `SessionReplay.swift`.
- `apps/web/src/lib/marketingAnalytics.ts`, `marketingAnalyticsBrowser.ts`,
  `marketingReplay.ts`, `components/MarketingAnalyticsBridge.tsx`.

Servers and operations:

- `apps/account-directory/src/signupAnalytics.ts`, `src/welcomeEmail.ts`,
  `src/cloud/analytics.ts`; `src/posthogLogs.ts` in each Worker.
- `scripts/posthog/dashboard-spec.mjs`, `provision.mjs`,
  `annotate-release.mjs`, `upload-sourcemaps.mjs`.
- `scripts/analytics/reconcile-signups.mjs`, `data-health.mjs`.

## How to instrument new code

Instrument a feature when it adds a meaningful user decision, successful
mutation, coarse workflow outcome, screen, or product-level failure category
that would change a product decision. Prefer one event at the durable owner
boundary over events at every UI entry point.

1. Reuse an existing event. Most product work belongs in `ade_feature_used` with
   an allowlisted `feature`, `action` and coarse `outcome`.
2. Emit from the durable mutation ledger or owning service after the action is
   known to have happened. UI events are only for screen adoption or
   interactions with no backend mutation.
3. Add a stable deduplication key and a minimum interval that matches the fact.
4. Estimate the worst-case accepted events per installation per day. Fit inside
   the existing ceiling with a tighter per-event or per-key limit. Do not raise
   a global ceiling to fit a new event.
5. Use coarse enums. If a property needs arbitrary user or runtime text, do not
   send it.
6. Add privacy, consent, rate-limit, dedupe and configuration tests at the
   public analytics boundary.
7. Update the dashboard spec only when the event answers a concrete question.
8. Update this document and
   [analytics/tracking-plan.json](./analytics/tracking-plan.json) when
   architecture, limits, consent, configuration or taxonomy change.

Do not capture keystrokes, mouse movement, hover, focus, scrolling, render
counts, polling cycles, network attempts, sync frames, terminal chunks, token
streaming, progress ticks, or every error occurrence. Aggregate locally or
record one coarse outcome.

## Review and test gate

Every `/test` run reads this file and reviews the branch for analytics. The
change passes when every applicable item holds:

- meaningful new behavior uses the existing taxonomy, or states why analytics
  does not apply;
- no arbitrary value or forbidden content can cross the sanitizer;
- each surface's default and disable behavior stay intact;
- worst-case volume is bounded by daily, per-event and dedupe controls;
- high-frequency mechanics are aggregated locally, not sent as raw events;
- public project tokens are the only credentials shipped to clients;
- dashboard definitions and documentation match the event contract;
- focused tests prove sanitization, quota behavior and fail-closed
  configuration;
- `node scripts/posthog/provision.mjs --validate` and
  `node --test scripts/posthog/provision.test.mjs` pass when PostHog
  definitions change.

The goal is broad product visibility with a small, predictable event budget.
More call sites are not better telemetry.

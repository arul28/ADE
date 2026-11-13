# Logging, error tracking and product analytics

This is ADE's ground truth for operational logging, error tracking (Sentry) and privacy-bounded product analytics (PostHog). Read it before adding telemetry, changing an analytics event, adding a failure path, or reviewing a feature with `/test`.

ADE is local-first. Operational logs stay local and help diagnose software behavior. Error tracking sends crashes, errors and warnings to Sentry so failures are seen without anyone pressing a button (see [Error tracking](#error-tracking-sentry)). Product analytics is a separate, deliberately narrow PostHog data path that answers how installations use ADE. PostHog is not a remote log sink, crash dump service, or copy of ADE's local state. Three PostHog products sit beside it, each bounded below: error tracking (a further-scrubbed mirror of what Sentry admitted, [PostHog error tracking](#posthog-error-tracking)), LLM analytics (one content-free event per agent turn, [LLM analytics](#llm-analytics)), and session replay that shows ADE's own interface text and masks the person's content ([Session replay](#session-replay)). Sentry stays the crash and release-health system of record.

## Non-negotiable boundaries

Never send any of the following to PostHog:

- prompts, responses, transcripts, code, diffs, file contents, terminal output, clipboard contents, screenshots, or proof artifacts, and no recording in which any of them can be read (session replay shows only ADE's own interface text and error messages, from regions marked `data-ph-unmask`, with paths, emails, secrets and names of the person's projects, lanes and branches starred out; every other text node, every value and every non-layout attribute is masked, and terminals, editors, images and frames are not recorded);
- project, repository, lane, branch, file, or directory names and paths;
- command text or arguments, URLs, referrers, issue titles, PR titles, user-entered labels, raw errors, stack traces, or local log messages (the exceptions are the public marketing site's own page address, referrer, and campaign tags, see [Public marketing site](#public-marketing-site), and `$exception`, which carries an error's type, its message after Sentry's scrub plus email and absolute-path removal, and in-app frame files, functions and positions, see [PostHog error tracking](#posthog-error-tracking));
- credentials, tokens, email addresses, device names, or other user-provided strings;
- raw account identifiers anywhere but the person profile: `$identify` and the server-side `ade_signed_up` set the Clerk user id as the person property `clerk_user_id`, never as a distinct id or an event property;
- raw project IDs, session IDs, or other stable local database identifiers.

Events go through the Capture API directly; no PostHog SDK sends them. The desktop window and the marketing site link posthog-js for session replay only (`renderer/lib/sessionReplay.ts`, `apps/web/src/lib/marketingReplay.ts`), loaded on demand while analytics is on; a `before_send` filter drops everything but `$snapshot` (and, on the site, `$$heatmap`), so autocapture, automatic pageviews, surveys, feature flags, automatic crash capture, and SDK-managed offline queues remain absent from PostHog. The remote calls besides capture are the project's replay settings (`/array/<token>/config`), the survey list (`/api/surveys/`), and, only for an install that is about to be offered a survey, one read of the feature flag `surveys-real-users` (`POST /flags/?v=2` with the public token and the install's distinct id, GeoIP off; see [In-app surveys](#in-app-surveys)). (Crash capture lives in Sentry. These boundaries are PostHog's; Sentry's are in its own section below.) Ordinary events disable person profiles and GeoIP with `$process_person_profile: false` and `$geoip_disable: true`. The sole exception is a quota-counted `$identify` call after ADE knows a signed-in account; it links the current anonymous history to a one-way hash of the account ID and sets plan, platform, app version, `clerk_user_id` (the Clerk user id, so a profile can be found in Clerk) and, on desktop, `is_internal: true` when the install is marked internal (it is never sent as `false`, so a sign-in on an unmarked machine cannot clear the flag the account directory set from Clerk). The distinct id stays the hash, so history recorded before this did not split. ADE does not send the email, name, or token.

Only closed event names, closed property keys, and coarse allowlisted values may cross the analytics boundary. Desktop/runtime raw project and session IDs are installation-salted and hashed before capture. Local deduplication keys are also hashed and are never transmitted.

## PostHog error tracking

Every error event Sentry admits in the desktop main process (which also carries renderer errors) and the brain is mirrored to PostHog as `$exception`, after Sentry's expected-error filter, budget and scrub (`setSentryEventMirror` in `shared/sentry/eventFilter.ts`, `main/services/analytics/exceptionProductAnalytics.ts`). PostHog therefore never sees more than Sentry did, and sees less: `sanitizeExceptionProperties` (`exceptionPolicy.ts`) keeps at most five chained exceptions of 50 frames each, the exception type, the message cut to 500 characters with emails and absolute paths removed (`scrubFreeText`), and per frame only the file inside ADE (query, fragment, scheme and host removed; then the part after `app.asar/`, `dist/`, `src/` or `node_modules/`, else the bare script name, and nothing when that is not a `.js`/`.ts`-style file name), the function, line and column, whether it is in-app, and `chunk_id`: the bundle's Sentry debug id, a content hash of the shipped file that names nothing about the machine, copied from the event's `debug_meta` (anything not UUID-shaped is dropped). No source lines, variables, breadcrumbs, contexts or tags cross. `$exception_fingerprint` is sent only when ADE named the failure (`captureError(..., { fingerprint })`); otherwise PostHog groups by the stack. `process` (`main`, `renderer`, `brain`, `worker`), the level, and `error_app_version` (the version of the build that raised it, from Sentry's release, which differs from `app_version` for a crash reported on the first launch after an update) are the only other fields. It shares the distinct id of the product events, so an error can be read beside the session that hit it, and it is dropped whenever analytics is off. `$exception` has its own allowance (100 a day, 10 a minute per machine), outside the shared ceiling, because PostHog bills exceptions separately (100,000 a month free). The iOS app mirrors too (`CrashReporting.swift` → `ProductAnalyticsException.swift`, 10 a day outside its shared ceiling): the same message scrub, and per frame the module and file as last path component, function, line, instruction and image address, and the in-app flag, plus `screen`, the ADE screen shown last (the Sentry tag above, sent only when it is one of the closed `ADEAnalyticsScreen` names), because a hang's stack rarely names an ADE function; function names need dSYMs uploaded to PostHog. A fatal crash mirrors on the next launch, when Sentry sends it. The hosted web client does not mirror.

PostHog symbolicates a Node frame only through its `chunk_id`; the file name plays no part, so the trimmed paths cost nothing. Every release build (beta, stable and the `prepare-release` dry run, macOS, Windows and the standalone runtimes) runs `scripts/posthog/upload-sourcemaps.mjs` after its Sentry upload, over the same folders. It calls `posthog-cli sourcemap upload` (pinned `@posthog/cli`) without `inject`: the CLI uses each bundle's ECMA-426 debug id, the one `sentry-cli sourcemaps inject` stamped in `beforePack`, as the chunk id, so the shipped bytes stay exactly the ones Sentry paired its maps with and one id finds the map in both products. Maps are keyed by that content hash, not by version, so a beta and the stable built from the same bytes resolve through the same upload; a bundle whose bytes changed has a new id and is uploaded by its own build. A bundle without a debug id (a build without `ADE_BUILD_SOURCEMAPS=1`) stays minified in both.

## LLM analytics

Each settled agent turn sends one `$ai_generation` (`captureAgentTurnSettledAnalytics`, `agentTurnProductAnalytics.ts`, from desktop main and the brain): `$ai_provider` (the closed provider list), `$ai_model` (the model id only when it is in ADE's built-in catalog, `MODEL_REGISTRY`; local, custom-endpoint and runtime-discovered models report `other`, because their names are the person's), input, output, cache-read, cache-write and reasoning token counts, `$ai_total_cost_usd` (the provider's billed figure or ADE's list-price estimate), `$ai_latency` (seconds from the turn's start to its end), `$ai_is_error`, `$ai_span_name: "agent_turn"`, `feature` (`chat` or `automations`) and `outcome`. `$ai_trace_id` is the installation-salted session hash, so a chat's turns form one trace. There is no input, output, tool, prompt or system-prompt field to fill. The insert id is derived from the session and turn, so a repeated settle is one event. A failed turn also carries `error_kind`, one of a closed set (`turnFailureKind`, `agentTurnProductAnalytics.ts`): the provider classifier's categories (`permission`, `rate_limit`, `budget`, `busy`, `cli_missing`, `network`) and five more read off the error's own words where the classifier only said `network` or nothing (`timeout`, `server_overloaded` for an overloaded or 5xx provider, `context_too_long`, `model_unavailable`, `process_exited`), else `other`. Only the kind leaves; the words never do. The failed turn's `ade_error` carries the same `error_kind`, so failures can be cut by `$ai_provider` × `error_kind`. Automation turns are `interactive: false`. It has its own allowance (400 a day, 30 a minute per machine), outside the shared ceiling, because PostHog bills LLM events separately (100,000 a month free). Turns past the cap are dropped and counted as `daily_budget` in the next `ade_analytics_budget` rollup; `sent_count` there covers only the shared ceiling.

## Session replay

With analytics on, the desktop window records a session replay (`renderer/lib/sessionReplay.ts`). posthog-js (pinned, slim build, recorder bundled, nothing loaded from a CDN) loads three seconds after boot and only when `analytics.getReplayConfig` answers, a desktop-only IPC (`registerSessionReplayIpc.ts`) that returns the project token, host and main's distinct id, or null while analytics is off. It is not a runtime action, so the hosted web client, the phone and the CLI never record. The renderer re-checks on window focus and every 60 seconds, so an opt-out stops recording within a minute; chunks are sent unbatched and dropped at the gate once off.

What a desktop recording holds: layout and styling; ADE's own interface text, readable; every other text node replaced by asterisks of the same length; every input masked; and every attribute outside a layout allowlist (class, style without `url()`, role, ARIA and data state, SVG geometry) masked. `maskTextSelector: '*'` sends every text node, in the snapshot and in every mutation, through `maskTextFn` (`maskSessionReplayText`), which decides by the nearest marked ancestor: `data-ph-unmask` shows the text, `data-ph-mask` or no mark masks it. Shown text is scrubbed first (`scrubFreeText`: secrets, emails, absolute paths), then URLs, quoted strings, anything with a slash (branches, relative paths, `owner/repo`), file names, `@handles`, hex ids, and the names this window knows (projects, lanes, branches, machines from the app stores) are starred out. Inside a `data-ph-unmask` region `title`, `aria-label` and `placeholder` are shown the same way; `value` never is.

Marked `data-ph-unmask` (ADE-authored copy only): the project sidebar's tabs and footer, the Settings section list and page header, the settings primitives' titles and descriptions (`SettingsSection`, `SettingsGroup`, `SettingsRow`, `SettingsPageShell`, `SettingsSectionShell`), `Banner` (every layout), `ToastCard`, `InlineErrorNotice` and its full-error panel, `Dialog`'s header and built-in action footer (so `confirmDialog` and `promptDialog` messages), `ContextMenu` item rows, `EmptyState`, and the failure screens' head, headline, body and technical-details fold (`errorSurfaceKit`). Marked `data-ph-mask` inside them: banner `extra`, toast chips and `content`, a toast's title or message when its model sets `replayMask` (lane-event and PR toasts carry lane names and PR titles), dialog `titleContent`, `headerExtra`, `footerStart` and a custom `footer`, `EmptyState` children, the Settings Project group label (the repository name), the Providers machine picker, and a failure card's label when it names a project. Everything else (chats, the composer, Lanes, Files, PRs, the project tab strip, lists in the sidebar body) carries no mark and stays masked. A new surface that shows only ADE's words can add `data-ph-unmask`; anything inside it that can hold the person's content needs `data-ph-mask`. `sessionReplay.test.tsx` runs the real recorder against a stand-in PostHog and checks that a banner's words arrive while a path, email, token, lane and branch name, PR title, chat text and composer draft do not.

Not recorded at all: images, video, audio, canvases, frames, webviews, embeds, `.xterm` terminals, the Monaco editor and diff editor, and anything marked `data-ph-block`. Off: autocapture, rage clicks (they carry element text), pageviews, heatmaps, console logs, network capture, exception and performance capture, and surveys. The page address is reduced to `ade://desktop/<tab>`. Person profiles stay off (`person_profiles: 'never'`), and a `before_send` filter adds `$process_person_profile: false` and `$geoip_disable: true` to each `$snapshot`.

The iOS app (`apps/ios/ADE/Services/SessionReplay.swift`) links posthog-ios (pinned, main app target only; widgets and the App Clip carry none of it) for replay only, three seconds after the account is reconciled and only while analytics is on. Replay is screenshot-based, with every text, input, image and system view masked, and terminals, device and desktop streams, video, QuickLook, web scenes and MCP apps masked whole. Network, console, lifecycle, screen, rage-click and crash capture are off, and `beforeSend` drops everything but `$snapshot`. It uses the product events' distinct id and starts only after a fresh `/flags` answer for that id says `session-replay-real-users` is true (the SDK is bootstrapped with replay off, because its disk-cached flag could belong to an earlier identity); an identity change stops recording first. A phone that is signed out records under its anonymous id until it signs in.

The marketing site (`apps/web/src/lib/marketingReplay.ts`) records only while the site's analytics preference is on, with the same switches, except that public page text is kept and heatmaps are on while analytics is on (turning it off removes their listeners and drops buffered points) (`$$heatmap`: click, move and scroll positions on the page, sent beside `$snapshot`, each keyed by the masked page address; `/open` and `/pair`, whose query carries repository, branch and path, send none); inputs are masked, all text on `/open` and `/pair` (matched case-insensitively, as the router does) is masked, and so are their link-carrying attributes (`href`, `src`, `title`, `aria-*`, `data-*` and the like; those pages show paths and repository names from the link), and iframes, video and canvases (the live demo) are not recorded. Its addresses keep origin, path and `utm_*` only. On the production domain, site events and replay go through the site's own `/_t/` path, which `apps/web/vercel.json` rewrites to PostHog's US ingest and assets hosts (PostHog's documented reverse proxy), so content blockers that block PostHog's domain do not drop them; the payloads are unchanged. The rewrite sources must be `/_t/:path(.*)`, not `/_t/:path*`: Vercel matches sources strictly, so `:path*` misses every path that ends in `/` (`/_t/i/v0/e/`, `/_t/s/`, `/_t/flags/`) and those requests fall through to the site's `index.html` with a `405`. That is how site events, replay and heatmaps were lost from 2026-11-03 22:20 to the fix.

ADE's own people are never recorded. The project links recording to the flag `session-replay-real-users`, which is false for any person with `is_internal = true` (accounts flagged `ade_internal` in Clerk, copied by the account directory's sign-up webhook), so a desktop or phone signed in as one of them records nothing. That is the one reason the desktop and the site evaluate flags at all; `before_send` drops the flag-call events. The desktop also records nothing on an install marked internal (`isInternalInstall()`), which covers a machine before sign-in, and the site records nothing in a browser that once opened a page with `?ade_no_replay=1` (`=0` undoes it).

PostHog's project settings: recording on, minimum duration 5 seconds, console and performance capture off, project masking of inputs only (the desktop masks in code, as above), heatmaps on for the site. Free tier: 5,000 recordings a month, retained one month.

## Worker logs (PostHog Logs)

The four Cloudflare Workers (account directory, push relay, tunnel relay, webhook relay) send sampled OTLP log records to PostHog Logs (`src/posthogLogs.ts` in each, posted to `/i/v1/logs` under `ctx.waitUntil` with a two-second timeout; a failure is swallowed), so log alerts and the self-driving logs scout can see server-side problems. A record holds only the Worker name and environment, the event (`request_completed`, `job_failed`), level, method, a route template (only the Workers' own route words, `ROUTE_WORDS`; any other segment, such as a repository owner or name, an id or a key, becomes `:id`, and everything after `host`, `connect`, `prewarm`, `machines`, `hooks` or `webhooks` is dropped), status, duration, error class and, for a failed cron, the job name. Never URLs, queries, headers, bodies, tokens, emails, account ids or IPs; `/health` is not logged. Sampling: 2% of successes, 10% of 4xx, every 5xx and exception, at most 120 records per isolate per minute (worst case about 0.3 GB a month against the 10 GB free allowance). The deploy workflow passes the public project token as `POSTHOG_LOGS_TOKEN`; without it nothing is sent.

## Error tracking (Sentry)

Sentry is part of ADE on every surface, with no setting and no notice. The organization is `ade-app` (US region), and each surface reports to its own project.

| Project | Surface | Started in |
|---|---|---|
| `ade-desktop` | Electron main, renderer (over IPC to main), preload, native crashes of every Electron process | `apps/desktop/src/main/sentry/initMain.ts` (called right after `configureDesktopUserDataPath()` in `main.ts`); renderer `src/renderer/sentry/initRenderer.ts` |
| `ade-brain` | the brain (`ade serve`: desktop-started, background service, remote machine) | `apps/ade-cli/src/sentry/initBrain.ts` (serve path in `cli.ts`) |
| `ade-web` | hosted web client (Cloudflare Pages) | `apps/desktop/src/renderer/webclient/sentry.ts`, loaded after first paint |
| `ade-workers` | push-relay, tunnel-relay, webhook-relay, account-directory (tag `worker`); the Passwords key service (`apps/password-key-service`) carries no SDK: it has no address of its own, and the push relay, its only caller, reports each failure to reach it as one issue per cause (`passwords` / `key-service`: `not_configured`, `status_<code>`, `unreachable`, `unreadable`) | each Worker's `src/sentry.ts` |
| `ade-ios` | the iOS app (not the widgets or App Clip) | `apps/ios/ADE/Services/CrashReporting.swift` |

**When it runs.** Packaged builds only. The Workers report only where their deployed config sets `SENTRY_ENVIRONMENT` to `production` (each `wrangler.jsonc`; account-directory's `env.production`); `wrangler dev`, `npm run dev` and the development account-directory Worker are `development` and send nothing. Account-directory's minute cron checks in to the organization's one included cron monitor, `account-directory-cleanup` (`src/index.ts`); `cronTriggersIntegration` stays off because it would add a billed monitor per trigger. The webhook relay's half-hour Beta timer (`src/betaTimer.ts`) has no monitor; a refused GitHub token throws from `scheduled()` and reaches Sentry as an unhandled error, at most twice an hour. Dev builds, source-checkout brains and tests are silent. **Only a release workflow builds a release**: `.github/workflows/release-core.yml` sets `ADE_RELEASE_BUILD=1` for every job, both `tsup.config.ts` files bake it in (`__ADE_RELEASE_BUILD__`; an Alpha package from `scripts/package-channel.mjs` counts as a release of its own channel), and anything else is a development build wherever it runs or is copied to, whatever its version says: a desktop packaged on a laptop with `npm run dist` (it carries the source version `1.0.0-beta.1` and used to read as a Beta; `main/sentry/releaseBuild.ts`), a brain bundle at `0.0.0`, one the dev launcher built (`ADE_CLI_DEV_BUILD=1`), one copied to `/opt/ade-dev` (`__ADE_UNRELEASED_VERSION__`, `apps/ade-cli/tsup.config.ts`). A brain the dev launcher or `dev-machine.mjs` starts also carries `ADE_DEV_BRAIN=1` and is development even when it runs an installed bundle. The brain decides this once, in `ade-cli/src/sentry/brainBuild.ts` (`brainReportsAsRelease`), for Sentry, its PostHog `release_channel` (the serve path and every project scope) and its automatic diagnostic reports alike, so a dev brain is never production in one and development in another. A development build sends no automatic diagnostic report (`runAutoDiagnosticsSend`'s `devBuild`, logged locally as `diagnostics.auto_send_skipped` with `reason: dev_build`); a person can still send one. `ADE_SENTRY_DEV=1` (web: `?ade_sentry_dev=1`) turns it on for testing the wiring and reports as `development`. `DO_NOT_TRACK` or `ADE_SENTRY_DISABLED` set to `1`, `true` or `yes` turns it off, and so does an analytics or automatic-diagnostics opt-out recorded by an earlier build (`main/sentry/priorOptOut.ts`; on the web client, the stored analytics opt-out). iOS ignores a stored opt-out: only `DO_NOT_TRACK=1` or `ADE_SENTRY_DISABLED=1` in an Xcode launch turns it off. The forked SDK workers (Cursor, Droid, Pi, Copilot, pty host) carry no SDK, because loading one costs hundreds of milliseconds per spawn on Windows; their failures reach the parent process, which reports them (`main/sentry/workerFailures.ts`, and `pty.host_fatal` through the logger).

**What is sent.** Error messages, stack traces, file paths, ids (lane, chat session, project, account hash), counts, durations, OS, architecture, CPU, memory, locale and timezone, the package channel, and breadcrumbs of what happened before (slow or failed IPC calls with their channel or brain action, provider health changes, warnings from ADE's logger). Native crash minidumps are uploaded. The user is the same pseudonymous id PostHog uses as `distinct_id` (`setSentryUserResolver` in `shared/sentry/capture.ts`, also exported from `eventFilter.ts`): the hashed account when signed in, else the install's random id, and none when product analytics is off.

**What a report carries (`shared/sentry/diagnostics.ts`).** A report from main or the brain is meant to be enough to find the cause without asking the user anything. Beside the error and its breadcrumbs it carries:

- contexts read at send time: `process_state` (pid, start time, uptime, heap, RSS, free system memory), on desktop `electron_processes` (every Electron process with its working set and CPU, largest first) and `brain_connection` (connection state, runtime mode, the brain's pid, connect and disconnect counts and times, re-registrations, the project id this window holds for each folder, and `history`: the last 25 brain lifecycle steps, each brain connected with its pid, version and build, each disconnect, repair, install result and update window), from main and the brain `brain_service` (this machine's background service, `ade-cli/src/sentry/brainServiceDiagnostics.ts`: on Windows the supervisor's record with its restart count, last exit code and time, next restart and whether it is running; on every platform the brain's heartbeat age, the last startup failure from `last-failure.json`, the last update from `update-status.json`, and the installed app version; main leaves it off a failed call to another machine's brain), in the brain `brain_state` (its role, registered projects, booted, ready and failed scopes, the sync host), and from the renderer `renderer_state` (route, JavaScript heap against its limit, DOM size, how long the window has been open);
- `ade-log-tail.jsonl.gz`: the last 1,000 lines this process wrote to its log files, at the logger's level (`ADE_LOG_LEVEL`, info by default), up to 256 KB before compression;
- on desktop, `brain-log-tail.jsonl.gz`: the newest 256 KB of this machine's `brain.jsonl`, since most desktop work runs in the brain;
- from main and the brain, `brain-service-logs.txt.gz`: the newest part of the background service's own logs (on Windows the supervisor log and the brain's captured stdout and stderr, on macOS `launchd.err.log` and `launchd.out.log`, on Linux `systemd.err.log` and `systemd.out.log`, with the stderr copy the last trim kept) and of `install-steps.log`, about 110 KB before compression, not on a failed call to another machine's brain; the brain caps the launchd and systemd files at 10 MB, checked at start and every hour, keeping the newest 1 MB in `.1`;
- on the brain's restart loop report only (`brainRestartLoop.ts`), `desktop-logs.txt.gz`: the newest 128 KB of the desktop app's `local-runtime.jsonl` (every brain it started, replaced, repaired or stopped) and 64 KB of `desktop-main.jsonl` (each launch and quit), which say whether the app stopped the brain. The app records its `userData` folder as `userDataPath` in `runtime/desktop-app.json`; a machine without the app, or with an app older than that field, sends the machine log alone;
- `project-registry.txt.gz` on a report about the project list (the brain's "asked for a project that is not in its project list", "a registered project's id changed", and any desktop error naming `Unknown projectId`): `projects.json`, `project-aliases.json` and the newest 64 KB of `projects.journal.jsonl`.

A desktop report about a call to another machine's brain (an `ade.remoteRuntime.*` channel) gets neither of this machine's brain files; that brain reports its own. The brain does not report an unknown project id whose last journal line is its removal: a window or phone that still holds it is in an ordinary state.

A breadcrumb records each brain connect and disconnect, each project-list write that removed a project, and each step of an Electron process's memory past 500 MB (then every further 25%, sampled once a minute). UI clicks are kept only when the element has a readable name (`aria-label`, `title`, `name`, an id), so the 100 steps an event keeps are not spent on unlabeled `div`s.

The log tails go as ADE wrote them, on purpose: they hold paths, action arguments and, where a log line has it, chat text, because a report is only useful when it shows what the process did. Secrets are still removed (`scrubDiagnosticText`): each JSON line is scrubbed by key (`accessToken`, `pushToken`, `secret`, `password` and the rest of `SECRET_KEY`) and by shape, and other lines by shape. A line longer than 1,500 characters is scrubbed whole before it is cut, so a cut line keeps no secret.

**What is never sent.** In the event itself: prompt and transcript text, model output, file contents and diffs, terminal output, clipboard, and secrets (the log tail attachments above are the one place log lines go as written, secrets removed). Call sites do not pass that text, and `shared/sentry/scrub.ts` is the backstop on every desktop, brain and web process: it redacts keys, tokens, JWTs, private keys, credentials in URLs and secret query parameters, replaces fields named like content (`prompt`, `text`, `body`, `diff`, `stdout`, and so on) with their length, and drops stack-frame local variables. No IP address is stored (client `dataCollection.userInfo: false`, and server-side IP scrubbing on every project). Trace headers are never added to third-party requests (`tracePropagationTargets: []`).

**What becomes an issue.**

- every uncaught exception and unhandled rejection (all processes), renderer and page error-boundary crashes, native crashes. Native crashes group by their minidump stack, except out-of-memory crashes: an `ade-desktop` server-side fingerprint rule (Project Settings › Issue Grouping, added 2026-11-06) makes every one with `Out of Memory` in its value or `FatalProcessOutOfMemory` on its stack one issue per process type (`desktop-out-of-memory`), because each one stops in a different allocation. A crash card says "ADE got an error report automatically" only after the transport answers 2xx for that crash's event (`confirmSentryDelivery`, `shared/sentry/capture.ts`; the desktop renderer's transport answers once main has it), never on the guess that Sentry is running;
- every failed `ipcMain.handle` call, once, grouped per channel and error code (`main/sentry/ipcCapture.ts`). The two runtime-action channels (`ade.localRuntime.callAction`, `ade.remoteRuntime.callAction`) rebuild the brain's error from its reply, with no stack of its own, so they group by error code alone when the error carries one (ADE authored the code for exactly one failure; the message around it names the RPC method, which split one unreadable drive into an issue per method), and by type and normalized message otherwise (`shared/sentry/grouping.ts` strips ids, paths, quoted names and numbers), with the action as the `runtime.action` tag: one fault that every screen hits is one issue, not one per action. A programming error (a TypeError and its kin) also keeps the action in its fingerprint, so two different defects never merge. The error rebuilt from a brain's `{ ok: false, error }` action reply keeps what the reply carried (`shared/runtimeActionReplyError.ts`): ADE's string code as `.code` (it used to keep only the message, so every such failure read as code `unknown`), a JSON-RPC number as `.rpcCode` (tag `rpc.code`), the `expected` mark, and up to three of the brain's own stack frames as `function:line` with no file or path (the brain sends them beside an unexpected failure's reply as the additive `frames` field, `brainStackFrames`; an older brain sends none and an older desktop ignores them), which the report carries as `extra.brainFrames` because a rebuilt error has no stack of the brain's;
- every failed brain action (`reportFailedAction` in `adeRpcServer.ts`), grouped by its own stack and tagged `runtime.action` (`domain.action` for `run_ade_action`), and internal JSON-RPC error;
- every `logger.error` line, grouped by the error it carries and by event name when it carries only a message (`shared/sentry/logBridge.ts`), except `window.console` (renderer console output, kept as warn-level logs only: the renderer SDK reports the real errors itself, and the error-level log lines the beta gate reads stay ADE's own). `logger.warn` lines become Sentry Logs and breadcrumbs, not issues. Info and debug never leave the machine, except the release-health lines below;
- a brain that keeps restarting (`The brain kept restarting`, `ade-cli/src/sentry/brainRestartLoop.ts`), as a warning, reported by the brain itself so it works with no desktop window open. Every service brain (not one the desktop app started, which the app kills outright when it quits, and not a hand-run `ade serve` on the machine endpoint: on macOS its parent must be launchd, on Windows the supervisor whose pid the service's pid record names) records its start in `runtime/brain-starts.json` and marks it stopped when it shuts down in an orderly way (an update, the restart button, a shutdown request). A start counts when the brain before it died without that mark, ran the same build, started since the computer last booted and is gone, or when the build goes back to one an earlier brain in the window left (two installs replacing each other). Three counted starts within 10 minutes are a loop. One report per loop, sent by the first brain that stays up 2 minutes, or by whichever brain is up 5 minutes after the loop was found, so its later restarts are in it; at most once a day per machine (`lastReportedAt` in the same file), with one fingerprint per platform. It carries `desktop-logs.txt.gz` (above) beside the service's own logs;
- the first provider health transition into `runtime-failed` for each provider and kind of failure in a process, as a warning (`providerRuntimeHealth.ts`); later ones are Sentry Logs, and the in-app health display shows every one. The kind comes from a closed list matched on the message (`root-refused`, `session-missing`, `turn-active`, `method-missing`, `owned-elsewhere`, `timeout:<ACP method>`, `spawn-failed`, `exited`, else `other`), rides as the `provider.failure` tag, and is part of the fingerprint, so unrelated failures of one provider are separate issues. A Claude failure also carries `extra.stderrTail`: the CLI's last 20 stderr lines (`claudeSubprocessReaper.ts`), each scrubbed with `scrubFreeText` before it is cut, and with any line whose start fell outside the kept buffer dropped, so a secret cut off from the prefix the scrubber knows it by never goes.
- a failure of ADE Cloud's server work, every failed provider call and every billing mismatch (`reportCloudFailure`, `apps/account-directory/src/cloud/store.ts`): the Stripe webhook, claim release and both meter reports (`cloud.stripe_webhook_failed`, `cloud.stripe_claim_release_failed`, `cloud.meter_report_failed`, `cloud.disk_meter_report_failed`, `cloud.disk_report_failed`); billing mismatches and setup gaps (`cloud.stripe_unknown_subscription`, `cloud.duplicate_subscription_cancelled`, `cloud.plan_item_missing`, `cloud.plan_change_failed`, `cloud.plan_change_refused` (Stripe refused the switch; the account stays as it was), `cloud.plan_upgrade_declined`, `cloud.plan_change_unconfirmed`, `cloud.plan_change_unsaved`, `cloud.checkout_failed`, `cloud.portal_failed`, `cloud.billing_not_configured`, `cloud.extra_disk_item_failed`, `cloud.extra_disk_not_configured`, `cloud.reconcile_unexplained`, `cloud.disk_meter_unconfirmed` (a disk-day send never confirmed inside Stripe's dedupe window; it is not resent, the owner checks it), `cloud.disk_day_without_subscription`); provider calls (`cloud.provider_call_failed` for a 401, 403, 5xx or no answer, `cloud.no_provider_key`, `cloud.tick_list_failed`, `cloud.billing_read_failed`, `cloud.reconcile_read_failed`, `cloud.prepare_stop_failed`, `cloud.computer_gone`, the template refusals `cloud.create_refused_template`, `cloud.create_refused_no_template_version`, `cloud.update_refused_no_template_version`); and the cron's own work (`cloud.tick_account_failed`, `cloud.stop_failed`, `cloud.backstop_sleep_failed`, `cloud.delete_inactive_check_failed`, `cloud.delete_inactive_failed`, `cloud.delete_events_read_failed`, `cloud.cost_estimate_failed`, `cloud.daily_<step>_failed`, `cloud.account_delete_failed`), and the automatic updates, their rollbacks, the moves and the lane reads (`cloud.auto_update_start_failed`, `cloud.auto_updates_failed`, `cloud.update_check_failed`, `cloud.update_failed_rolling_back`, `cloud.update_failed_no_rollback`, `cloud.update_rollback_failed`, `cloud.update_rollback_unreported`, `cloud.move_end_failed`, `cloud.move_source_left`, `cloud.keep_lane_read_failed`). One issue per event name with the name as the fingerprint and no account or instance id (those stay in the Worker's own log line), at most one event per name per isolate per hour;
- the account project list's server work, through the same `reportCloudFailure` (tag `area: account_projects`): a failed delete of the account's project rows on Clerk `user.deleted` (`account_project.account_delete_failed`), a failed delete of a removed or replaced machine's copies (`account_project.machine_copies_delete_failed`), and a failed read of the list's cursor for the heartbeat answer (`account_project.heartbeat_cursor_failed`; the heartbeat still succeeds without the field);
- every machine-membership refusal of the account directory (`directory.register_refused`, `.remove_refused`, `.supersede_refused`; `logDirectoryRefusal` in `apps/account-directory/src/logging.ts`), as a warning titled `<event>: <code>`, one issue per event and code, tagged `refusal.code` and `correlation_id`, with the 8-character machine and device prefixes and no account id. Workers Logs keep 10% of requests, so this is the place a refusal is always recorded, within the Worker's budget (`admitEvent`: 5 events per issue and 60 in all per isolate an hour);
- a failed GitHub sign-in on the account directory (`github_app.sign_in_failed`, `logGithubApp` in `apps/account-directory/src/logging.ts`), as a warning titled `<event>: <kind>`, one issue per kind and GitHub's short OAuth error code, tagged `area: github_app`, `github_app.kind`, `github_app.oauth_error` and `github_app.client`, with only the attempt count and HTTP status as extras. Never the code, state, verifier or a token. Workers Logs keep one request in ten, so this is the one record of GitHub's reason for each failure;
- a brain that cannot keep its crash-recovery files (`area: brain_restart`): the run record that tells the next brain whether this one stopped unplanned (`run_record_write_failed`, `run_record_stop_failed`, `brainUnplannedRestart.ts`), and the list of projects with a running turn (`live_turns_write_failed`, `liveTurnProjects.ts`, once per process because it writes at each project's first and last turn). Without them a crash shows no banner, or its projects open on first use as before;
- on iOS, a Live Inspect reply the app cannot decode (`area: live_inspect`, `LiveInspectMarkupModel.fail`): the host and app disagree on the format. Offline machines, timeouts and older hosts are shown to the user and not reported.
- on iOS, a Hub removal that a computer or the account refused (`area: hub-remove-folder`, `area: hub-remove-account-project`, `run()` in `HubRemoveProjects.swift`). The remove sheet shows the reason on the row. A computer that is offline or never answered, and a signed-out phone, are shown to the user and not reported. One event per refused folder, from a person's tap, so the volume stays at the person's pace.
- a Linux lane screen that fails on its host (`linux_screen.<kind>`, `linuxDesktop/linuxScreenTelemetry.ts`), as a warning with a fixed description per kind and structured fields only (the helper's error text can carry Xvfb or ffmpeg output, so it stays in the local log), once per kind and detail per process: the helper not starting or exiting with lanes up (`helper_start_failed`, `helper_lost`), `display.create` failing for anything but a caller's mistake (`display_create_failed`), an accessibility bus that would not start (`display_degraded`), a recording whose encoder died (`recording_interrupted`), and an `ade screen setup` that failed or left something missing (`setup_failed`). Each carries the host as tags: `linux.distro`, `linux.distro_version`, `linux.distro_like` (from `/etc/os-release`), `linux.container` and `arch`, because only Ubuntu x64 is exercised by hand. What a host lacks before setup, a sudo that needs a password and a missing window manager are Sentry Logs (`linux_screen.host_report`, `linux_screen.setup_needs_user`, `linux_screen.display_degraded`), searchable by the same fields;
- a recording whose demo every engine failed to make (`demo_video.all_engines_failed`, tagged `platform`, `arch` and on Linux the distribution, with the failed stage but not the engines' errors, which can carry ffmpeg's stderr), once per process per engine set: the user gets the uncut recording, and nothing else says the demo pipeline is broken on that machine;
- a Copilot chat failure ADE could have caused (`main/services/chat/copilotSentry.ts`), tagged `provider: copilot`, `copilot.kind` and `copilot.model` and grouped per kind and cause: a `session.error` that is not sign-in, rate limit, quota or an outage (`session_error`, titled by its kind alone and grouped by error type and code, because a provider's message can quote the request; the message and both GitHub request ids are in the scrubbed extra), a failed turn that was not interrupted (`turn_failed`), the SDK worker dying under a live chat (`worker_exited`), the runtime refusing to list or run a slash command (`commands_list_failed`, `command_failed`), a refused model or permission change (`setting_failed`), and a permission or question handler that threw (`handler_failed`). Each sent turn leaves a `copilot` breadcrumb with its model, agent mode, permission level, attachment count and the command name, never the prompt. Its other failures (a lost conversation, a model list or MCP sign-in lookup that failed) are `agent_chat.copilot_*` warn lines, so Sentry Logs only;
- a Work list (`sessions` or `lanes`) whose first load has failed for 30 seconds while the machine it reads is connected, or is this computer (`Work <surface> list could not load`, `renderer/lib/firstLoadRetry.ts`), once per retry run, grouped per surface and binding kind. It carries the attempts, how long it has been failing, a fixed error class and code (never the message, which can name an address), the connection state and the `correlationId` of the failed dial, so the issue links to that machine's `remote.connect_failed`. A machine that really is offline logs `work.first_load_waiting` instead, and a list that recovers logs `work.first_load_recovered`.
- on iOS, a live machine connection (the focused one or a fleet roster link) that dropped without a close frame, code 1006 or none (`area: sync_live_drop`, `SyncLiveDropReport` in `SyncRecoveryPolicy.swift`). It carries the connection kind (`focused`, `fleet`), the route kind (`lan`, `tailnet`, `relay`), the close code and an age bucket (`under_10s` … `over_10m`), never an address or machine name, at most once per connection and route kind per 10 minutes. A saved-port change leaves a `sync.route` breadcrumb (connection kind and whether the link was live), so the report shows whether the computer's sync port moved just before. A drop with a close code (a host or relay closing on purpose) is not reported;
- on iOS, a chat that is working but draws no messages (`chat.empty_thread.<kind>`, `runEmptyThreadProbe` in `WorkSessionDestinationView.swift`), at most once per time the chat is opened. It carries the chat stream trace from `ChatStreamTrace` (subscribes, history replies applied or dropped and why, live events, socket closes) and the `chat.stream` breadcrumbs, names and counts only.

**Release-health lines.** A few info lines go to Sentry Logs (not issues, not breadcrumbs) so a release shows that it ran and updated cleanly: `app.started` (desktop, once per launch: version, running and selected track, package channel, platform, arch, whether it is the first launch after an update), `brain.started` (the brain, once per start: version, tracks, role, platform, arch), `sync.host_started` (the brain could take connections again), `autoUpdate.update_downloaded`, `autoUpdate.track_switch_started`, `autoUpdate.quit_and_install`, `db.snapshot_written` (the database copy taken before a new version opens it), `startupRecovery.went_back` (a machine left this build from the "ADE could not start" window: from and to version, trigger, databases restored) and `agent_chat.restart_resume_armed` (`RELEASE_HEALTH_EVENTS` in `shared/sentry/logBridge.ts`). They share the Sentry Logs budget below. The release skill's beta gate (`scripts/release-tools/beta-gate.mjs`) reads them, with the issues first seen in a beta and the error-level log lines, before a beta becomes stable.

**What is a Sentry Log, not an issue.** Things the user is shown or can fix, which say nothing new about ADE's code:

- an error its throw site marked as an answer: `new AdeExpectedError(message, kind)` or `markExpected(error, kind)` from `shared/expectedError.ts`, with `kind` one of `user` (the person or agent asked for something that cannot be done: a missing branch, a closed tab, a path outside the project), `environment` (the machine cannot do it: no git, no Xcode, no simulator runtime) or `network`. The mark keeps the message unchanged, and it crosses the brain-to-desktop hop as `error.expected` beside the JSON-RPC `data`, so the desktop's rebuilt error keeps it (`markExpectedFromWire`). Every `beforeSend` drops a marked error that someone caught and reported, and logs it as `sentry.expected_error`; an uncaught one (an unhandled rejection) and a crash still report, because an answer nobody caught is a bug. Prefer the mark at the throw site to a message pattern: git, for one, answers in the user's language, so "not a repository" is read from `rev-parse`'s exit code 128 on the open-folder path, not from its text;
- every error toast (`showToast` with `tone: "error"`), as the log event `toast.<start of title>` (`toastGroupKey`, so a lane or file name in the title does not make one event name per name), with the title and message cut to 300 characters. The failure behind a toast already opened its own issue, with a stack. A toast that names a `report` logs as `toast.<surface>` with its title, `code` and `technicalDetail` only, never its message (which can quote the person's words, such as an unsent prompt); `report: false` logs nothing;
- every failure notice shown (an error-tone `Banner`, `InlineErrorNotice`, or a notice given a `report`, `ui/notice/NoticeReport.tsx`), once per surface and raw error per renderer, as `notice.shown` with its surface, headline, code and the raw error cut to 300 characters; a `hint`, a `status` given no report (`noticeKind.ts`; a lane delete that left files behind is a `status` that passes one, and logs), or `report: false` logs nothing. Its "Report" action sends the manual diagnostic report (`diagnostics.sendManual`), not a Sentry event (on the hosted web client, the User Feedback note below);
- a failed connection to another machine, and the other machine's view of it. `remote.connect_failed` and `remote.connect_recovered` (`main/services/remoteRuntime/remoteDialTelemetry.ts`) come from the machine dialing, first failure of an outage and then one an hour, with each route's kind, result, fixed error token and duration but never its address (the hosts are only in the local line in `runtime/desktop-main.jsonl`, which a report's log tail carries like any other line). `sync_host.peer_accepted` and `sync_host.hello_rejected` come from the machine being dialed, through either of its hello handlers, and `sync.host_started` says when it could take connections again. `device_ref` and `peer_device_ref` are `syncDeviceTelemetryRef` hashes that both sides can compute and appear swapped on the other side, so filtering on them shows one connection from both machines;
- conditions worth counting but not worth an issue, through `forwardSignalToSentry` (`shared/sentry/logBridge.ts`): `ai.provider_status.stale_runtime_snapshot` (the CLI snapshot says a provider's runtime is missing while the tools cache says ready; once per disagreement), `work.machine_read_failed` (a paired machine failed the Work sidebar's reads twice in a row), `remote.reconnect_failed` (the fourth automatic reconnect failure of one outage), `local_runtime.service_repair_attempt` (the desktop repairing or starting the brain service, keyed by reason), and `windows_desktop.background_unavailable` (input on the Windows main desktop to an app the background table lists, keyed by exe, input and fallback, with whether the screen then changed; exe and window class only, never a title or typed text: `macDesktopBackgroundInput.ts`);
- a project open that took 5 seconds or more, as the warn line `project.open_slow` (one producer, `logSlowProjectOpen` in `projectFilesystemKind.ts`; a Sentry Log and breadcrumb where Sentry runs). The brain's scope registry (`projectScope.ts`) owns the clock of a brain open and logs it to the brain's own log, for failed opens too; `createAdeRuntime` logs it itself, to the project's log, only when no caller passed a clock (a runtime opened outside the brain's registry). Every action on a project waits for its open, so a folder on a network mount shows up as many calls timing out together; this line says which step was slow. It carries `totalMs`, `phases` (`prepare`, `queued` when it waited for a project opening alone, `root_check`, `base_ref`, `db_open`, `services`, `identity`, with milliseconds each), `filesystemKind` (`network`, `fuse`, `local`, `unknown`) and `filesystemType` (the kernel's mount type such as `nfs4`; read from `/proc/self/mountinfo` on Linux only, and only on this slow path), plus `projectId` and `outcome` (`opened`, `failed`) from the brain, or `runtimeProfile` and `hadAdeDb` from a runtime's own line. It never carries the folder path. An open that freezes the event loop cannot log anything itself, so the watchdog worker writes `brain.project_open_stalled` to stderr after 5 s blocked (each opening project's id, step, time in the open and in the step), a near miss (`brain.event_loop_near_miss`) carries the same as `openingProjects` (the step reached when the loop came back), and a kill's breadcrumb does too;
- a project refused because opening it froze the brain into the freeze guard twice in 15 minutes (a folder on a drive too slow for its database; `projectOpenStrikes.ts`). The next start logs warn `project.open_freeze_killed` (each struck project's id, step, strikes, and `blockedUntil` and `level` once refused), the first refused open of each refusal logs warn `project.open_blocked` (id, `code`, `level`, `blockedUntil`, filesystem kind), `ade projects retry` logs info `project.open_retry`, a successful open that forgot strikes logs info `project.open_strikes_cleared`, and an unreadable or unwritable strikes file logs warn `project.open_strikes_read_failed` / `project.open_strikes_write_failed`. Ids and codes only: the refusal's message names the project for the person reading it, and the sync host loop logs its code, not that message. None is a PostHog event;
- a brain that dropped under an SSH `ade rpc --stdio` relay, as `remote.brain_connection_lost` (`remoteRuntime/runtimeRpcClient.ts`, grouped by brain state), reported by the desktop because the other machine may have no route to Sentry. It carries the method, `brainState` (`alive`, `exited`, `exited_and_replaced`, `unknown`), the socket's errno, the heartbeat age in seconds and up to six of the brain log's last lines as level, code-defined event name and error code, each re-validated against a fixed shape. It never carries log message text, paths, URLs or names. A remote event read or subscribe that hit its 2-minute ceiling is `remote.event_setup_timed_out`, keyed by the step it was on (`remoteConnectionService.ts`), with the transport, step timings and total; one that was only slow (10 s) is a breadcrumb;
- a provider going `auth-failed` (signed out is the user's state);
- a resource-pressure episode on this machine, `machine.resource_pressure` (warn), from the machine brain's five-minute sample (`ade-cli/src/services/runtime/resourcePressureMonitor.ts`, below in [Resource pressure](#resource-pressure)): the kinds that breached, severity, memory, swap and commit numbers, the largest write-ahead log, the brain's own CPU, the Android emulator count, whether a developer's brain ran beside the installed one, ADE's busiest table, and MB per process group (`installed_brainMb`, `dev_brainMb`, `desktopMb`, `android_emulatorMb`, `ios_simulatorMb`, `otherMb`). Numbers and group names only. One per episode; `machine.resource_pressure_ended` (info, local) when 30 healthy minutes close it;
- expected outcomes of an IPC call or brain action (`EXPECTED_OUTCOME_PATTERNS`, and `EXPECTED_OUTCOME_CODES` for errors that carry their code (`project_data_missing`, `project_moving`, `db_path_changed`, `git_untrusted_folder`, and the project-open answers `storage_read_failed`, `storage_io_failed` and `db_busy`, whose code survives the SQL-statement rewrap and the RPC and IPC hops), in `shared/sentry/expectedFailure.ts`): a lane, chat, worktree or screenshot that no longer exists, a project runtime still connecting, a brain restarting for an update, a project mid-move or mid-switch, a paired machine that is asleep, slow, not sharing the project or whose link dropped, no network (`fetch failed` whose causes are network errors to a non-loopback address; a local service that stops answering is still an issue), a dirty worktree, nothing to commit, a missing base branch or a folder that is not a repository, a provider or GitHub login that lost access, a GitHub 5xx or timeout, a Codex thread another process is writing, the answers a caller gets for bad input (a secret name, a path that is not a file, a message no longer queued, nothing to rewind, Linear not connected, a second live-stream start while one runs), and the answers an agent gets when it drives a browser, desktop or PR wrongly (a bad selector, no matching element, no screen yet, a declined consent card, a debug port nothing listens on, a review thread from another PR). It also holds sign-ins the user fixes in Settings (GitHub, Jira, SSH, Windows), a remote machine the user disconnected, ADE quitting mid-call, a full disk or process table, a chat waiting on the user, a lane screen whose display or window went away (`MAC_DESKTOP_DISPLAY_UNAVAILABLE`), and a Mac with no Xcode. A paired machine's "domain unavailable" or "requires params.projectId" answer is marked `environment` only where it comes back from an older machine (`isPeerVersionGapMessage`, `remoteConnectionPool.ts`); from this machine's own brain it is a defect. The brain names undici's reason in a forwarded `fetch failed` (`fetch failed (ENOTFOUND)`) and marks an offline one `network` on the wire, because the cause chain does not cross RPC. Monaco's `Canceled` (an editor disposed under its own pending work) is dropped when it is the event's own error. They are logged as `ipc.expected.<action>` or `runtime_action.expected.<action>`, and every process's `beforeSend` drops an event whose own error is one of them, whatever path it took (a crash that only quotes one as its cause is kept). Add a pattern there only once Sentry shows a message is a state the user can be in rather than a defect.
- a failed brain action the caller already has the answer to. The brain logs it as `runtime_action.agent.<action>` when an agent's `ade` call failed with anything but a defect (a TypeError and the other JavaScript runtime errors, a database failure, or a machine out of files, memory or I/O stay issues), and as `runtime_action.desktop.<action>` when a desktop window made the call: the desktop reports that failure itself, with its IPC channel (`main/sentry/ipcCallScope.ts`). Calls the desktop's main process makes on its own are still reported by the brain.
- an IPC timeout whose call spanned a sleep or a pause: Electron reported a wake-up after the call's deadline, or a `suspend` during the call (the timer fires on wake before `resume` arrives), or the wall clock ran 5 s or more ahead of the monotonic clock during the call (where that clock stops in sleep, as on Linux), or the deadline timer fired 5 s or more late while the process spent under a quarter of that lateness on the CPU up to that moment (`ipcTimerFiredWhilePaused`, `main/sentry/ipcHandlerTimeout.ts`). The last rule is the one macOS needs: libuv's clock there is `mach_continuous_time`, which counts sleep, so the gap stays 0, and a dark wake sends no `suspend` or `resume`. It also covers App Nap. Nothing hung; it is logged as `ipc.expected.<channel>` with its duration, `lateMs` and `cpuMs`. A busy main thread burns CPU while its timers wait, so a real stall is still an issue.
- an IPC call, or a brain call through `RuntimeRpcClient`, whose deadline timer fires 5 s or more late is given 10 s more before it fails (`armDeadline`, `shared/deadlineTimer.ts`): on wake every overdue timer fires before the reply already waiting on the brain's socket is read, and the handler's own fallback deadlines fire at the same moment. A call that answers in that window succeeds, so nothing is reported.
- the second and later IPC timeouts of one action within 10 s: calls that wait on one thing time out together, so the first is the issue and the rest are logged as `ipc.timeout_repeat.<action>`. Across actions too: a stall times out every call in flight within seconds of each other (`attention.getSnapshot`, `lanes.list`, …), each of which used to open an issue of its own. Every reported timeout carries the tag `ipc.stall_id`; a timeout of another call within 30 s of the last one joins the same stall and is logged as `ipc.timeout_in_stall.<label>` with that `stallId` and the stall's call count, so one stall is one issue and one search for its id lists every call it took down (`main/sentry/ipcCapture.ts`). A reported timeout carries `lateMs` (how late its timer fired), `cpuMs` (CPU the main process spent until the deadline timer fired), `monotonicGapMs`, `sinceSuspendSec`, `sinceResumeSec`, `systemIdleSec` and `windowVisible`, which tell a blocked main thread from a machine that was not running ADE.
- on the hosted web client, a script chunk that a deploy removed: the host's `/assets/*` worker answers it with a 404 that is never cached (`renderer/webclient/public/_worker.js`), so Chrome says `Failed to fetch dynamically imported module`, Firefox `error loading dynamically imported module`, and Safari `Importing a module script failed`. Before that worker, the host sent the app's `index.html`, and Safari said `'text/html' is not a valid JavaScript MIME type`; a browser can still hold that answer, so the rule matches it too. The page reloads once into the new build (`renderer/lib/staleChunkReload.ts`, at most once a minute through a `sessionStorage` stamp) instead of reporting. The desktop app loads its chunks from its own package and never does this.

**Quota.** Since 2026-10-30 the organization is on a trial plan (`am3_t`) that ends 2026-11-13 14:20 UTC: 1,000,000 errors, 100,000 replays and 10 GB of attachments a month. The budgets below were set for the Team plan's 50,000 errors and 1 GB of attachments, so they keep a paid plan's numbers inside its quota. If the trial ends without an upgrade, the organization goes back to the Developer plan's 5,000 errors. Over the error quota, Sentry drops every error (`error_usage_exceeded`), as it did from 2026-10-26 to 2026-10-30; the beta gate fails while that happens, because a build's error count means nothing then. It has no server-side rate limits, so every process keeps its own budget (`shared/sentry/guardrails.ts`): at most 5 events per fingerprint and 60 in total per hour, and 15 per fingerprint and 150 in total per day, and crashes (`fatal`) on a budget of their own, 10 per fingerprint and 30 per hour (30 and 100 per day), so they never compete with ordinary errors. Attachments have their own 1 GB a month for the organization, of which minidumps used about 100 MB in October 2026: each process attaches files to the first event of an issue each day only, to at most 15 events a day, and to at most 1 MB a day after gzip (`DEFAULT_DIAGNOSTIC_ATTACHMENT_BUDGET`). The files are built only when the budget has room. Contexts and breadcrumbs cost nothing against either quota; Sentry Logs are capped at 20 per log event name and 400 in total per hour, because some warnings repeat every second while a condition lasts. The cap is the backstop, not the fix: a poll or probe that keeps failing on the same cause warns once and logs the repeats at info, which stay on disk, until it succeeds or the cause changes (`automations.github_relay_poll_failed`, `github.token_validation_failed`, `prs.discovery_failed`, `push.publish_undelivered`, `process_registry.heartbeat_failed`). `local_runtime.action_slow` warns once per action per 10 minutes for a call that was only slow (a failed call always warns), with the count it quieted since; `ipc.expected.<label>` logs the same answer on the same call once per 10 minutes; a phone alert the relay fails 20 times is dropped with one `push.publish_undelivered` warn naming `droppedAlerts`. A success is never a warn line (`account.machine_publish_ok`, slow or not, is info). `forwardSignalToSentry` events have a budget of their own per event name, so a noisy one never starves another: 2 per key and 10 in total per hour, 6 per key and 30 in total per day. Expected outcomes (aborted navigations, user cancels, EPIPE, ResizeObserver, and the list above) are dropped. The web client also drops `AdeUnavailableError`, the rejection of a desktop-only `window.ade` member called on web (`webclient/sentry.ts`). The Workers group Cloudflare's own D1 and Durable Object failures into one issue per kind (each carries a fresh `reference`; the kinds live in each Worker's `src/cloudflareTransient.ts`, which match every wording Cloudflare uses for a kind: a storage reset is "storage caused object to be reset" or "storage operation exceeded timeout which caused object to be reset"), and drop Durable Object resets caused by a deploy. A request that hits one is retried where that is safe and otherwise answered `503` with `Retry-After`, logged as `cloudflare_transient` and not sent to Sentry. Traces are sampled at 5% on desktop and brain (Workers 1%, push-relay 0.1%, tunnel frames never); the web client reports errors only, because browser tracing would add about a third to the chunk its cold-load budget counts. No profiling. iOS tags every event with the display layout (`display.family`, `display.edge_bar`, `display.fold`, set by `CrashReporting.setDisplayLayout` on change only, with one `layout` breadcrumb), so an iPhone Duo crash names its posture without an event of its own. It also tags every event with the ADE screen shown last (`screen`, the closed `ADEAnalyticsScreen` names, set by `CrashReporting.setScreen` on change only, with one `screen` breadcrumb, whether analytics is on or off), because an app hang's stack names only system code: none of the 13 hangs in ADE-IOS-1B held an ADE function. iOS keeps session replay for errors only, fully masked, and drops an app hang (fatal or not) whose main thread was idle in its run loop (the app was suspended, not blocked), judged on library names and in-app flags because the phone sends no function names; a hang with real work on the stack is kept, however long it claims to be. It also drops a non-fatal hang whose reported lower bound is over 60 seconds (a suspension, not a freeze; the events seen ran 200 to 23,000 seconds) and a MetricKit `MXHangDiagnostic` under 2 seconds (`ADEHangReportFilter`); a fatal hang and a duration it cannot read are always kept. Hangs group by kind, not by duration or system stack: the fingerprint is the exception type (`App Hang Fully Blocked`, or `Fatal App Hang Fully Blocked` for a watchdog kill) plus the innermost ADE function when the phone named one, else the library the main thread was blocked in (`groupAppHang` in `CrashReporting.swift`), because the SDK puts the hang's length in its title. iOS does not report hangs that did not fully block the main thread; MetricKit reports those from the system.

**Alerts and monitors (Sentry account, not code).** Every project keeps Sentry's default "high priority issue" email. On top of it, three org alerts email the owner: `ADE · Regressions in production (all projects)` (a resolved issue comes back), `ADE · Issue hitting 5+ users in an hour (production)`, and `ADE · Uptime: account directory down`. The plan's one uptime monitor checks `GET /health` on `ade-account-directory-production` every five minutes (`ade-workers`, three failures open an issue), and its one cron monitor is `account-directory-cleanup`, the Worker's scheduled sweep. The sweep sends one closing check-in with `Sentry.captureCheckIn` from the handler's own scope (a tick that hangs shows as missed); never wrap it in `Sentry.withMonitor`, whose isolation-scope fork loses the invocation's `waitUntil`, so Cloudflare cancels the closing check-in and every tick reads as a timeout that reopens the issue. Spike protection is on for every project. Nothing paid is enabled: pay-as-you-go stays at $0, so data over a quota is dropped, never billed, and Seer, profiling and extra monitors stay off. Check the settings with `GET /api/0/organizations/ade-app/workflows/`, `/detectors/` and `GET /api/0/customers/ade-app/` (plan, trial end, on-demand budget).

**Readable stack traces.** Release builds set `ADE_BUILD_SOURCEMAPS=1`, inject Sentry debug ids into the shipped bundles, upload the maps and delete them before packaging or deploy, so no map reaches a user. Releases are named `ade@<version>` from the `v*` tag (deploys from `main` between releases use `git describe`, for example `1.2.102-4-g3137fc9b9`), with a `dist` per artifact (`win-x64`, `mac-arm64`, `linux-x64`, `web`, `worker-<name>`). The standalone runtime (the brain on Linux, and `ade` installs without the desktop app) is a Node SEA: `build-static.mjs` stamps the bundle's debug id and writes a map for the SEA entry, moved down by the require shim's lines, to `dist-static/.sentry/<target>/` (outside the SEA work folder the build removes), and the runtime build job uploads that pair to `ade-brain` with `sentry-release.mjs upload --dir`. Uploads cost storage, not event quota. iOS keeps `<bundle id>@<version>+<build>`, and `scripts/release-tools/upload-ios-dsyms.sh` uploads each archive's dSYMs to Sentry and to PostHog (run by `ios-testflight.sh` and the TestFlight workflows). Uploads need the `SENTRY_AUTH_TOKEN` repository secret and are skipped, never failed, without it. A release's commits are read from the checkout's git history (`set-commits --local`, in `release-publish.yml`'s `sentry-commits` job, beside the publish job so it never delays a release going public), because the `arul28` GitHub account is linked to another Sentry organization and sharing it needs a Business plan.

**Tags on every event.** Each client sets the same scope tags (`sentryCommonTags` in `shared/sentry/config.ts`; Swift in `CrashReporting.start`): `surface` (`desktop`, `brain`, `web`, `ios`), `client` (`desktop`, `runtime` for the brain, `web`, `ios`), `release_channel` (`stable`, `beta`, `alpha`, `development`; on iOS the ADE Beta app (`com.ade.ios.beta`) is `beta` and the normal app is `stable` on TestFlight and the App Store alike; iOS's Sentry environment follows it, `production` for `stable`, `beta` for the ADE Beta app and `development` for a debug or simulator run, so a beta's errors never read as the store app's, `CrashReporting.sentryEnvironment`), `is_internal` (`true`/`false`, desktop and brain only, from the same marker PostHog reads; a browser and a phone cannot know), `arch` (desktop and brain) and `machine_id`. `machine_id` is which install on which computer sent the event, the same 16-hex value PostHog events and diagnostic reports carry (`main/services/analytics/machineTelemetryId.ts`): `sha256("ade-telemetry-machine-v1:" + the OS machine identifier + ":" + the ADE home)`, cut to 16 characters. The identifier is the one the account directory's anchor reads (`hardwareAnchor.ts`: `IOPlatformUUID`, `MachineGuid`, `/etc/machine-id`) and never leaves the process; the telemetry domain keeps the hash unrelated to the anchor's. Two ADE homes on one computer (`~/.ade`, Alpha's `~/.ade-alpha`) are two installs; a reinstall into the same home is the same one. It is read once per process off the main thread (one `ioreg` or `reg`, ~13 ms, only where something reports) and set on every event and Sentry Log by `beforeSend`/`beforeSendLog` (`setSentryMachineIdResolver`, `shared/sentry/capture.ts`); events before the read answers, and a VM with no identifier, carry none. The user is the person and spans every machine they own; `machine_id` tells those machines apart. On iOS it is `sha256("ade-telemetry-machine-v1:" + identifierForVendor)`, cut the same way (`DirectPostHogProductAnalyticsSink.machineID`). The OS is Sentry's own `os` tag from each event's OS context. Renderer events carry main's tags, because they travel through main's client. Desktop and brain keep `process`, `os.release` and `package.channel`; the web client keeps `process: web-client` (its `surface` tag was `web-client` before 2026-10-30). The web client's user is the same account hash, computed in the browser from the signed-in account; signed out it has none.

**User Feedback.** Settings › Send a report has an optional note, shown only where main's Sentry client runs (`diagnostics.userFeedbackAvailable`). The note goes to `ade-desktop` as Sentry User Feedback from the desktop main process (`main/sentry/userFeedback.ts`), scrubbed with `scrubString`, at most 2,000 characters, with the same user id, the common tags, `report.surface`, `report.code` and `report.reference` (the R2 report's reference), linked to the newest event that process reported. The R2 report is unchanged and never contains the note; a send the local daily limit refused sends no note either. Feedback skips `beforeSend` and its budget, so the manual-send limit is its only bound. The report describes this computer whatever machine a screen showed, so the note always goes from this app, never through a pin.

The hosted web client's **Report issue** is User Feedback too, to `ade-web`, from the browser (`renderer/webclient/adapter/diagnostics.ts`): the browser has no logs, and the account directory refuses its upload. Only where the web client's Sentry runs; otherwise the button opens the GitHub issue with the report copied. The note holds the surface, the screen's headline and technical detail through `scrubFreeText`, the code, the web version, the browser's user agent, the path through `scrubString`, and the time, at most 2,000 characters (`SENTRY_FEEDBACK_MAX_CHARS`). It carries `report.surface`, `report.code` and `report.reference` (a random 8-character reference made in the browser), the user id, and the crash event the screen captured as its associated event. The reference is shown only after Sentry answers 2xx for the note (`confirmSentryDelivery`). A browser sends at most 5 a day (`MAX_DIAGNOSTIC_REPORTS_PER_DAY`, in `localStorage`), the same number as the desktop's manual limit. The GitHub issue's title, a public field, goes through `scrubFreeText`.

**iOS error titles.** `CrashReporting.capture` reports a Swift error under its bare type name (`AccountAdoptionRoutesExhaustedError`), as an `NSError` whose domain and description are that name: sentry-cocoa otherwise titled it `String(describing:)`, associated values and all (a machine's name, route labels), behind a module path with a per-build address (`ADE.(unknown context at $10422b9a4)`), so each build and each machine was a new title. The fingerprint is `["ios", area, type name]`; `extra.error_description` keeps the shape (`String(describing:)`, scrubbed, every quoted value replaced by `"<redacted>"`, at most 1,000 characters). A Foundation error keeps its domain and code.

**Instrumenting new code.** Use `captureError(error, context)` and `captureProblem(message, context)` from `apps/desktop/src/shared/sentry/capture.ts` (Swift: `CrashReporting.capture`). They are no-ops where Sentry is not running, so never guard them. Set a `fingerprint` that names the failure (`["provider", provider, kind]`) so repeats are one issue and one budget. Tags are low-cardinality labels (provider, channel, action); detail goes in `extra`. A caught error the app recovers from silently is still a failure: report it, or log it with `logger.warn` or `logger.error` so the bridge does. Never pass user content, and never raise the budget to fit a noisy call site; fix the noise.

**Triage.** `sentry issue list ade-app/<project> --query "is:unresolved" --period 24h`, `sentry issue view <ID>`, `sentry issue events <ID>`, `sentry log list ade-app/<project> -q "severity:error"`. An event's files are under its Attachments tab, or `GET /api/0/projects/ade-app/<project>/events/<event id>/attachments/`; the `.gz` files open with `gunzip`. Test events from a dev opt-in run carry `environment:development`; resolve or delete them afterwards. To check the wiring without spending quota, point `ADE_SENTRY_DSN` at a local HTTP server (`http://key@127.0.0.1:<port>/1`) with `ADE_SENTRY_DEV=1`: the SDK posts each envelope there, chunked.

**The project list journal (`projectRegistryJournal.ts`).** Every write to `<ADE home>/projects.json` (from the desktop app, the brain, the `ade` CLI or a project move) holds `projects.json.lock` for its read and write (a lock older than 15 s counts as abandoned, whatever its pid), and appends one line to `projects.journal.jsonl` beside it: time, pid, writer, operation, the ids added or removed, and how long it waited for the lock. A record the next write would drop, or whose id changed because its folder now resolves differently, is a line too (`record_dropped`, `id_changed`), and a changed id keeps working as an alias in `project-aliases.json`. Before the lock, overlapping writers kept their own copies and the later rename erased the earlier one's projects: a 12-process test lost half of them.

## Operational logs versus analytics

Failed direct attachment uploads are reported with the stable Sentry fingerprint
`chat/attachment_upload_failed`, including failures recovered through the
authenticated attachment command. The report contains the error, never file
contents. The existing Sentry fingerprint and process budgets apply; automatic
transport recovery sends no PostHog event because it is not a new user decision.

Operational logs use ADE's local logging services and may include bounded diagnostic context appropriate for the local machine. They are for debugging a specific installation and must not be forwarded to PostHog.

When the optional CLI-status decision classifies an idle terminal as errored
with high confidence, `pty.cli_status_error_detected` records only the session
id, tool type, and confidence. It does not copy terminal text. The live CLI row
has no separate inferred-failure state, so this line is diagnostic only and is
not a product-analytics event.

The machine brain writes the same `{ts, level, event, meta}` JSONL format as the desktop logger to `~/.ade/runtime/brain.jsonl`, honoring `ADE_LOG_LEVEL` (default `info`). The file rotates at 10 MiB to `brain.1.jsonl`; warnings and errors are also mirrored to stderr with an ISO-8601 timestamp and uppercase level for launchd diagnostics.

`brain.jsonl` carries the brain process's own machine events. Everything a **project runtime** inside the brain logs goes to that project's `<project>/.ade/transcripts/logs/ade-cli.jsonl` (the `logger` `createAdeRuntime` builds in `apps/ade-cli/src/bootstrap.ts`, rotating to `ade-cli.1.jsonl`), not to the desktop's `main.jsonl`. That includes every chat-service event (`agent_chat.*`, among them the `agent_chat.turn_end_question_*` lines) and the Jev helper's `jev.*` events, because chats run in the brain. Look there first when a chat-side event seems missing.

The desktop main process has a structured logger **from process start**: `apps/desktop/src/main/services/logging/machineLogger.ts` writes `~/.ade/runtime/desktop-main.jsonl` (same format, same `createFileLogger`, same 10 MiB rotation to `desktop-main.1.jsonl`), and `main.ts` opens it in its first executable statement, before the `ade://` claim and the single-instance lock. Its location is chosen for who can *read* it: `resolveMachineAdeLayout` is the resolver `ade report-issue` uses, so a headless report on a machine where the desktop will not start finds the file by construction, and each channel's `ADE_HOME` keeps its own. Electron's `userData` — where `local-runtime.jsonl` and `ade-update.jsonl` still live — is a per-platform, per-productName directory the CLI would have to guess, which is why those two remain desktop-only sources in a report. The app records it as `userDataPath` in `runtime/desktop-app.json`; only the brain's restart loop report reads it there (`desktopLogsAttachment`).

Not everything reaches a structured logger. Lines the runtime prints on its way up go to the background service's **stdout**, which on macOS is `~/.ade/runtime/launchd.out.log` and not the `launchd.err.log` that carries stderr. Both streams are bounded by `runtimeLogMaintenance.ts` and **both** are collected into a diagnostic report; see [Diagnostic reports](features/storage-and-recovery/README.md#diagnostic-reports-report-issue). Early main-process events additionally mirror to `console` through `logMachineEvent`, so a terminal-launched app still shows them and the pathological case — an old plist that boots the whole desktop app as the background service — still leaves them in `launchd.out.log`. That mirror is a second copy, not the record: a bare `console.log` for something the machine log could carry is no longer acceptable, because it is invisible to a Finder-launched app.

Writes are batched onto an async stream, so a caller that is about to end the process (`app.exit`, a force quit, an install handoff escalation) must call `logger.flushSync()` immediately after the line that matters — while it is still queued — or the records explaining the exit die with the process. `flushSync` drains only what is still queued (a batch already handed to an in-flight async flush is not duplicated), skips rotation deliberately, and, like every other log write, never throws.

Not every operational log belongs to the active project. The rule is the **subject** of the event: if it is the computer, it goes to `desktop-main.jsonl`; if it is a repository, it goes to that project's `main.jsonl`. Machine-subject events include the launch marker `desktop.main_started`, the deeplink scheme claim and single-instance outcome (`deeplink.*`, including `deeplink.single_instance.lock_lost`), `app_navigation.queued_before_dispatcher_ready`, `app.hardware_acceleration`, `machine_trust_reset.failed`, and the `ade` CLI auto-install outcome (`ade_cli.auto_install`, `ade_cli.auto_install_failed`, `ade_cli.auto_install_skipped`) — whether this computer ever got the `ade` command is a fact about the computer, and filed per project it landed wherever the startup latch happened to win. Project-subject events (`project.init`, `ipc.*`, per-service telemetry) stay in the project log, unchanged. Auto-update events were already machine-scoped in `<Electron userData>/ade-update.jsonl` and stay there.

`createFileLogger` backs other machine-scoped sinks for the same reason: `accountBridge` writes `account.local_machines_removed` to `<machine ade dir>/runtime/account-trust.jsonl`, because dropping a paired machine credential is a machine-level mutation and the project logger follows the active project — on a remote-bound project it would ship the record to the other machine and leave nothing on the machine that actually lost its trust. Account-directory publish outcomes record only bounded per-leg durations, the failing leg, and coarse failure codes such as `token_timeout` or `http_timeout`; they never include bearer tokens or response bodies. These high-frequency health events remain local operational logs and are not product analytics.

Account sync against this machine writes local lines only:
`ai.api_key_removed_by_account` (with the provider name, content-free) when a
provider key the account reports deleted is dropped here, and
`project_secret.account_vault_pull` (added, updated and removed counts) when a
pull changes something. Neither is a PostHog event. A pull
is a sync tick, not a person, so it captures nothing — the same reason the
runtime-workload exemption below does not: an event here would report
engagement nobody generated. A credential removal the ACCOUNT performed must
not be counted as one this user performed, which is why the sync path calls the
internal removal rather than `removeApiCredential`.

The brain's sync host and memory watchdog write their own local structured
lines. `sync.host_start_failed` (signature, attempt, classified code, errno,
the human-readable failure message — the redacted sentence for a classified
storage fault, the raw error text otherwise —
provider — at the failure deduper's one-per-minute cadence) and
`sync.host_start_recovered` replace the free-text stderr lines that once made
the most frequent brain failure invisible to structured logs.
A phone or browser that taps **Fix connection** records one
`ade_feature_used` at the brain — the durable owner boundary, because only that
side knows whether the repair worked — with `feature: "connections"`,
`action: "sync_host_recovery"`, and a coarse `outcome` of `success`, `partial`
(the repair handed off to a brain restart, so the client must reconnect to
learn the result), or `failed`. `surface` is `mobile` or `web`, taken from the
pairing record rather than anything the client claims. It carries no PID,
socket path, command line, lane path, owner label, or device identifier. The
repair is serialized and rare — at most one accepted event per incident, far
inside the existing `ade_feature_used` 140-per-day / 30-per-minute limits — so
it needs no new event name, no new property key, and no raised ceiling.
Diagnosis (`sync.diagnoseHost`) is a passive read and captures nothing.

The brain-level project-host recovery path also records
`sync_brain.sync_host_recovery_forbidden`,
`sync_brain.sync_host_recovery_finished`, and
`sync_brain.sync_host_recovery_failed`. These contain only the peer device
identifier/type, command or operation identifiers, coarse result/status/state,
step identifiers/statuses, conflict reason, and an error type; they never copy
PIDs, socket paths, command lines, raw failure text, or recovery details into
the log event. They are local operational outcomes, not PostHog events. The one
product event the repair does send is a single `ade_feature_used`
(`feature: "connections"`, `action: "sync_host_recovery"`) carrying only
`outcome` (`success` / `partial` / `failed`, where `partial` is the brain
restarting and handing the answer to the client's reconnect) and the `mobile` /
`web` surface. It is captured on the brain, which is the only side that knows
whether the repair worked, so one repair is one event no matter which client
asked for it.
`brain.suspend_gap` records a sleep the watchdogs would previously have
mis-reported as an event-loop stall. Sleeps of 2 to 59 seconds are logged as
`brain.suspend_gap` too, and the watchdog's lines name the `pid` and
`socketPath` of the brain that wrote them (`brain.recovered_from_wedge` is the
exception, since it describes the previous process). A freeze the machine
caused (memory pressure, a stuck drive) is waited out instead of killed:
the worker writes `brain.loop_watchdog_waiting_on_machine` (warn, to stderr:
cause, blocked time, fault and CPU counts) once per wait and
`brain.loop_watchdog_machine_wait_ended` (info) when it ends, and every wedge
record carries a closed `freezeCause` (`self`, `memory`, `drive`). A machine
brain taking a chat back from a lane's test brain logs
`agent_chat.runtime_reclaim` (info: session id, whether it was released),
`agent_chat.runtime_reclaim_failed` (warn, so it reaches Sentry Logs through
the log bridge) when the other brain did not answer, and the releasing brain
logs `agent_chat.runtime_released_to_machine_brain`. None is a PostHog event:
both happen without a person deciding anything, and a restart that does
follow is already counted by `ade_brain_recovered`.
`brain.memory_sample` (rss, heap,
external, uptime; every five minutes) and `brain.memory_restart` /
`brain.memory_restart_deferred` record the RSS slope and the planned
idle restart that mitigates a known native leak. All of these are local
operational logs and none is a PostHog event; the only analytics adjacent to
them is the existing `ade_feature_used` `auto_sent` outcome when a sustained
storage fault triggers an automatic diagnostic send through the unchanged
consent, deduplication, and budget path.

A project folder that stops answering while the brain runs (a macOS
permission prompt waiting on the screen, or a hung drive) writes local lines
only: `project_root.not_answering` and `project_root.permission_wait_started`
(warn: root, source, platform), `project_root.permission_wait_ended` and
`project_root.recovered` (info: root, how long it waited, outcome),
`project_root.access_denied` (warn) when the listing was refused. The sync-fs
tracker writes `brain.sync_fs_call_slow` (warn: method, path, caller, duration,
at most once per call site every 10 minutes), the watchdog worker writes
`brain.sync_fs_call_blocked` to stderr after 5 s blocked, and the wedge record
carries the same as `blockedFsCall`. None is a PostHog event: a prompt is the
operating system's, not a person's decision in ADE, and a restart it causes is
already counted by `ade_brain_recovered`. They carry folder paths, which stay
in local logs.

The brain's local RPC transport writes one raw stderr line when it drops a
client that has stopped reading — `ade jsonrpc client dropped: <n> bytes
unread` — before closing the socket, so the client reconnects from its event
cursor instead of growing the brain's heap until V8 aborts. It is a local
operational line, not a PostHog event, and it carries only a byte count.

The desktop's runtime connection pool writes its own local lines around the
update window and repair throttle: `local_runtime.update_window_started` /
`_ended` / `_expired`, `local_runtime.connect_deferred_for_update`,
`local_runtime.service_repair_suppressed`, and
`local_runtime.service_repair_throttled`. They record why a repair or connect
was held back during an update transaction and carry no paths or versions
beyond the bounded fields already in `local-runtime.jsonl`; none is a PostHog
event. When the service status cannot be read (`service_status_unreadable`),
the pool re-reads it once after 3 s and starts its own no-sync brain only if it
is still unreadable, nothing owns the socket, and (on Windows) no supervisor or
brain for the channel is alive; otherwise it logs
`local_runtime.app_fallback_skipped_service_alive` and waits for the service.

Pairing with another machine logs `account.pair.route_failed` per route tried.
A challenge the other machine refuses carries that machine's `hostCode` (for
example `sealed_adoption_unavailable` from a host too old to finish the
sign-in), and the failure is classified by that code, so the user is told to
update ADE there rather than to check their account.

When isolated recovery finds a strictly older brain on the machine socket
(`olderBrainRetirement.ts`), the pool writes
`local_runtime.older_brain_shutdown_requested` (warn) after it asks that brain
to shut down, or `local_runtime.older_brain_left_running` (info, once per pid
and reason) with the coarse `reason` it left the brain alone. Both carry the
socket path, the brain's pid, version and role, and the app version. A
connection that quit drops logs `local_runtime.action_connection_dropped` with
`willRetry: false`. None is a PostHog event: these are background lifecycle
mechanics with no user action behind them.

Shutdown and startup races write local lines only. The sync service logs
`sync.role_refresh_failed` (warn) for a role refresh nobody awaited, and logs
nothing when a dispose closed the database under a status snapshot or a role
refresh. The PR watch logs `prs.watch_evaluate_failed` (warn) for a background
pass that failed outside a single watch. A runtime teardown step that fails,
including an async `dispose` that rejects after the drain, is
`runtime.teardown_step_failed` (warn). A project open that waited for a sibling
process's write lock during the CRR conversion logs `db.crr_conversion_settled`
(info, `attempt`). None is a PostHog event.

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
unnoticed. A missing parent is `agent_chat.spawn_completion_parent_gone`, not a
delivery failure. A final delivery failure against a still-reachable parent
keeps `agent_chat.spawn_completion_delivery_failed`. Explicit take over / promote
writes `agent_chat.spawn_kind_changed` with `sessionId`, `parentSessionId`,
`previousSpawnKind`, `spawnKind`, and `source` (`takeover`, `promote`, or
`parent_dispatch`). `chat.setParent` writes `agent_chat.parent_changed` with
`sessionId`, `previousParentSessionId`, `parentSessionId`,
`previousSpawnKind`, and `spawnKind`; a relink a cross-machine arrival could
not make writes `agent_chat.cross_machine_handoff_relink_failed`. None of
these spawn-coordination lines is a PostHog event.

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

A fresh Codex process's first turn waits up to 1.5 s for its skill list
(`settleCodexSkillCatalog`). When the list stays short it writes
`agent_chat.codex_skill_catalog_settle_timeout` (info, `sessionId`, `expected`,
`seen`); when `skills/list` fails it writes
`agent_chat.codex_skill_catalog_settle_failed` (warn, `sessionId`, error
message). Each fires at most once per Codex process start. Neither is a PostHog
event: the wait is runtime mechanics with no user action behind it, the same
reason the idle sweep and the archive teardown capture nothing.

The Claude subprocess reaper writes its own local lines around process
teardown: `agent_chat.claude_subprocess_terminate` (with `pid`, `sessionId`,
`reason`, and on POSIX a `groupLeader` flag recording whether the whole process
group was signalled), `agent_chat.claude_subprocess_kill` for the SIGKILL
escalation, `agent_chat.claude_subprocess_pid_reused` when an identity probe
refuses a recycled pid, and `agent_chat.claude_subprocess_taskkill_failed` on
Windows. They carry pids and session ids and no command lines, and none is a
PostHog event.

An image attachment that does not fit a provider's inline limits writes one of
two local lines, and neither is a PostHog event. `agent_chat.inline_image_resized`
(info) records an image that was re-encoded to fit, with `provider`, the `from`
and `to` byte sizes and pixel dimensions. `agent_chat.inline_image_omitted`
(warn) records one that could not be sent inline, with `provider`, `bytes`, and
the `reason`; the turn still runs and the model gets a path hint. Neither line
carries the file's path or name.

Four more local operational lines exist, and none is a PostHog event.
`sync_paired.rpc_channel_over_budget` records the host closing one paired RPC
channel because a reply would pass its send budget: the channel id, the method
label (for example `ade/actions/call stream_events`), the reply size, the bytes
already sent, and the buffered bytes. `prs.coalesced_update_failed` records a
coalesced `prs-updated` that could not be built, usually because the project
runtime closed its database while the event was waiting (at most 2 s).
`agent_chat.cursor_sdk_worker_orphan_recovered` and
`agent_chat.cursor_sdk_worker_orphan_recovery_failed` record the startup sweep
stopping a Cursor SDK worker whose brain is gone, with the pid, ppid and owner
pid and no command line. The renderer's `[ade-term] image paste failed` console
line (session id, `remote`/`local`/`bound`, and the failure reason) reaches
`main.jsonl` as `window.console`. These are connection mechanics, background
cleanup and a per-paste failure, so they stay local: the connection flaps and
the sweeps have no user action behind them, and a paste failure's reason is
free text that cannot cross the analytics boundary.

Five local lines record a provider refusing ADE's pinned build as too old, and
none is a PostHog event. `ai.claude_fall_forward` (warn) records each Claude
fall-forward attempt (`claudeFallForward.ts`) with `tool`, `signal`,
`pinnedVersion`, `rejectedClaudeCodeVersion`, `requiredVersion`,
`vendorMessage`, `outcome` (`switched` or `not_switched`), and then either
`overrideVersion` / `claudeCodeVersion` or `reason` / `detail`. It goes to the
caller's logger, else the machine log (`desktop-main.jsonl`).
`ai.codex_fall_forward` (warn) records each Codex fall-forward attempt
(`codexFallForward.ts`) with `tool`, `signal`, `model`, `pinnedVersion`,
`vendorMessage`, `modelProbes` (one-request probes run, which use the user's
quota), `outcome`, and then either `overrideVersion` / `codexVersion` or
`reason` / `detail` / `newestCodexVersion`. `ai.muse_fall_forward` (warn)
records each Muse attempt (`museFallForward.ts`) with `tool`, `signal`
(`vendor_min_version`), `pinnedVersion`, `minVersion`, `urgency`,
`channelVersion`, `outcome`, and `reason` / `detail` when it did not switch.
`ai.muse_vendor_floor` (warn) records a Meta floor ADE cannot meet without an
update, with `minVersion`, `runningVersion` and `urgency`. All three go to the
same logger as the Claude line.
`agent_chat.copilot_client_update_required` (warn) records Copilot's
organisation-policy floor (`copilotSdkPool.ts`) with `requiredVersion`,
`reportedVersion` and `pinnedVersion`; Copilot has no fall-forward. All are
rare vendor refusals with no user action behind them, and `vendorMessage` is
vendor text that cannot cross the analytics boundary.

Claude mod UI (what Claude Code plugins draw in a chat) writes three local
debug lines and no PostHog event: `agent_chat.claude_plugin_ui_render_failed`
(session id, render site, error message), `agent_chat.claude_plugin_ui_action_failed`
(session id, action kind, error message) and
`agent_chat.claude_plugin_ui_ingest_failed` (session id, message subtype, error
message). They exist because the channel is private to Claude Code and a
failure in it never reaches a turn; without them a blank dock has nothing to
read. (A press that got no answer also shows a toast in the window.)

**No product-analytics event accompanies the feature, deliberately.** What a
mod draws is a third party's text and controls, so a press, a typed value, a
status line or a toast is plugin content that cannot cross the boundary, and a
redraw is a high-frequency mechanic. The one user decision is the setting
(`ai.chat.claudePluginUiEnabled`), and it is saved through the generic
`ai.updateConfig` write, which has no per-key owner: the same reason the
compaction-point setting is not instrumented. The one-time offer banner is a
prompt, not an outcome. If a dashboard later needs to know how many
installations turn mod UI on, add one `ade_feature_used` fact at a per-key
owner then.

The capture gesture writes its own local structured line family, and it is not
a PostHog event. `capture.*` is the helper supervisor's family
(`helper_started`, `helper_spawn_failed`, `helper_exited`, `helper_error`,
`helper_stderr`, `helper_invalid_output`, `helper_output_overflow`,
`helper_path_outside_output_dir`, `input_monitoring_required`,
`chord_unavailable`, `chord_ignored`, `late_answer_dropped`); it records why a
chord was refused or a shot never arrived and carries no window title, app
name, or image. The two setup-health lines are not PostHog events: a missing
grant or a monitor that cannot start is an environment fact, not a person
using the gesture, and the settings health card is the user-facing surface.

When an agent switches its lane to a new branch during a turn, ADE adopts
the branch or leaves the choice to the user, and writes the local structured
line `lane.agent_branch_adopted` (lane id, session id, previous and new branch)
or `lane.agent_branch_not_adopted` (lane id, session id, coarse reason such as
`old_branch_has_unpushed_commits`); a failure is `lane.agent_branch_adopt_failed`.
Neither is a PostHog event. The adoption is an automatic outcome of an agent's
command, not a user decision, so an event here would report engagement nobody
generated; the user's own `Switch back` / `Keep` choice uses the existing
drift-resolution path, which this change does not instrument.

A browser command that an agent on another machine sends to the desktop the
user sits at writes local lines on the agent's brain:
`built_in_browser.remote_call` (request id, method, whether a desktop took it,
whether it succeeded, duration), `built_in_browser.remote_call_emit_failed`,
and `built_in_browser.remote_call_file_write_failed`. Broadcasts to every
desktop (an `ade browser status` tab list, a lane's release) add
`built_in_browser.remote_broadcast_emit_failed`, `built_in_browser.release_lane`
(lane id, how many desktops answered), `built_in_browser.release_lane_failed`
and `built_in_browser.owner_names_failed` (warnings), and the debug lines
`built_in_browser.list_tabs_local_skipped`,
`built_in_browser.release_lane_local_skipped` and
`built_in_browser.machine_name_unavailable`. The desktop's tab lifecycle writes
`built_in_browser.tab_kept` (tab id, `input` or `keep`),
`built_in_browser.tab_auto_closed` (tab id, `idle`, `ended`, `lane` or `stale`),
`built_in_browser.tab_auto_close_failed` and `built_in_browser.tab_sleep_failed`
(warnings), `built_in_browser.tab_slept` and `built_in_browser.tab_woke`. The desktop adds
`built_in_browser.action_observation_failed` (warning) when an agent's action
ran but the observation after it failed, and `built_in_browser.tabs_restore_skipped`
(collection, agent tabs dropped) at start. The event-loop watchdog
also writes a native `sample` of a wedged brain (macOS only) next to its wedge
report. None of these is a PostHog event: agent browser commands are
high-frequency agent activity, not a person's decision, and a wedge already has
`ade_brain_recovered`.

Chats that fix a failure by themselves write local lines only. A Claude turn
whose sign-in read hit a keychain that did not answer, and that ADE tries once
more, writes `agent_chat.claude_keychain_retry` (info) when the retry runs,
`agent_chat.claude_keychain_retry_skipped` (info, with the coarse `login`
result: `absent`, `unreadable`, or null when the chat moved on) when it does
not, and `agent_chat.claude_keychain_retry_failed` (warn) when the retry itself
threw. A lost provider thread that ADE rebuilds by itself writes
`agent_chat.continuity_auto_recovery` (info, `ok`),
`agent_chat.continuity_auto_recovery_failed` (warn) and
`agent_chat.continuity_auto_recovery_notice_failed` (warn). They carry session
and turn ids and an error message, never the transcript or the hand-off text.
None is a PostHog event: each is ADE reacting to a provider or keychain fault,
with no user action behind it, and the user's own Try again / Start a new chat
choice goes through the existing recovery path.

Two project-subject clean-ups and the account settings layer write local
lines only, to the project's `ade-cli.jsonl`. None carries a value:

- `github.saved_header_removed` (warn, the config `keys` only): the brain
  removed a GitHub sign-in header that an older ADE clone saved in the
  project's `.git/config`. It runs once per project per brain process
  (`savedGithubHeaderCleanup.ts`). `github.saved_header_cleanup_failed`
  (warn, the key and git's exit code, or the error name) is a failed removal.
- `projectConfig.account_settings_moved` (info, the moved and joined row
  keys), `projectConfig.account_move_conflict` (info, the row key),
  `projectConfig.account_settings_saved` (info, row keys),
  `projectConfig.account_setting_write_refused` (warn, the row key),
  `projectConfig.account_move_notice_resolved` (info, the row key and the
  choice), `projectConfig.account_move_failed` (warn, the row key and the
  error name), `projectConfig.account_mirror_failed` (warn, the error name),
  `projectConfig.account_store_read_failed` (warn once per process and kind
  of read, the error name; the file is used instead), and
  `projectConfig.account_move_state_read_failed`,
  `projectConfig.account_move_state_write_failed` (warn, the error code).
- `lanes.new_lane_settings.adopt_failed` (warn, the error name): the old
  per-computer new-lane choices could not be written to the account.
- `project_scope.open_hook_failed` (warn, the error name): a project-open
  hook (the clean-up above) threw; the project still opens.
  They tell where a project setting came from after it moved to the ADE
  account (`projectConfigAccountLayer.ts`). A value held on this computer
  (a credential-shaped key, a folder path, too large) is named by its row
  key and reason, never by its value.

None is a PostHog event: the clean-up has no user action behind it, and the
account move runs on its own when the account syncs. The person's answer to
a notice ("Use this computer's value" or "Keep") is not one either: it comes
at most once per setting per computer, during the one-time move, so it says
nothing about how ADE is used afterwards. The local
`projectConfig.account_move_notice_resolved` line records it.

Product analytics records a small number of meaningful product facts such as "an anonymous installation opened the Work screen" or "a chat session started." It must never inherit arbitrary fields from a log record, exception, IPC payload, database row, or UI component props. Log calls and product-analytics calls should remain separate at the call site.

## Source file map

Shared desktop/runtime boundary:

- `apps/desktop/src/shared/types/productAnalytics.ts` defines the closed event, surface, status, and capture contracts.
- `apps/desktop/src/main/services/analytics/productAnalyticsPolicy.ts` owns property allowlists, coarse value normalization, internal-only events, and the global/per-event/per-minute budgets.
- `apps/desktop/src/main/services/analytics/productAnalyticsService.ts` owns machine consent, installation identity, salted identifier hashing, persisted deduplication/quota state, and the bounded direct Capture API transport.
- `apps/desktop/src/main/services/analytics/usageProductAnalyticsExporter.ts`, `dailyUsageAnalytics.ts`, and `agentTurnProductAnalytics.ts` are the durable-ledger, daily-aggregate, and work-session producers. `agentTurnProductAnalytics.ts` also owns `captureChatHandoffReplayAnalytics`, the handoff-replay outcome described below. Their focused coverage is consolidated in `productAnalyticsService.test.ts`.
- `apps/desktop/src/main/services/analytics/featureProductAnalytics.ts` owns the closed, content-free `ade_feature_used` producers for provider accounts, API credentials, custom presets, proxy, reset-credit outcomes, and pending-question dismissal. It maps provider-shaped input to the existing coarse provider-family allowlist before capture.
- `apps/desktop/src/main/services/analytics/captureGestureProductAnalytics.ts` is the capture-gesture producer (`reportCaptureGesture`). It takes a `Pick<ProductAnalyticsService, "captureInternal">` rather than the service, so the one call site cannot reach anything else through it.
- `apps/desktop/src/main/services/ipc/registerIpc.ts`, `apps/desktop/src/preload/preload.ts`, and `apps/desktop/src/renderer/components/analytics/ProductAnalyticsLifecycle.tsx` expose the safe renderer boundary and lifecycle producers. The desktop has no analytics settings UI; the service itself honors the persisted opt-out and `DO_NOT_TRACK=1`.

Attached clients and native surfaces:

- `apps/ade-cli/src/services/sync/productAnalyticsRemoteCommand.ts` binds paired-client consent, surface, and project identity at the host boundary. `syncHostService.ts` keeps consent peer-scoped, and `syncRemoteCommandService.ts` exposes only the runtime-scoped analytics commands.
- `apps/desktop/src/renderer/webclient/adapter/analytics.ts` keeps the hosted client's browser-local opt-out. Hosted web is default-on; an explicit "false" preference in browser storage disables capture and is reasserted on every connection. It retries transient consent-sync failures, then disconnects fail-closed only when an opt-out acknowledgement still cannot be confirmed.
- `apps/ios/ADE/Services/ProductAnalytics.swift` owns the native iOS policy, identity, budget, default-on behavior, and direct transport. There is no native analytics preference or consent prompt. `PrivacyInfo.xcprivacy` files for ADE, the App Clip, and widgets declare the shipped privacy surface.
- `apps/web/src/lib/marketingAnalytics.ts`, `marketingAnalyticsBrowser.ts`, and `components/MarketingAnalyticsBridge.tsx` own the public site's separate consent, taxonomy, budget, and direct browser transport.

Build and operations:

- `apps/desktop/tsup.config.ts` and `apps/ade-cli/tsup.config.ts` validate and compile only the public capture configuration into release artifacts.
- `apps/ios/Scripts/validate-posthog-project-token.sh`, `.github/workflows/release-core.yml`, and `.github/scripts/ios-testflight-internal-build-bump-asc.sh` validate iOS configuration and pass it through a temporary mode-0600 xcconfig that is deleted after the archive command.
- `apps/web/vite.config.ts` rejects non-`phc_` tokens before a public-site build. Vercel Production supplies the two `VITE_` variables; Preview and Development intentionally do not.
- `scripts/posthog/dashboard-spec.mjs` and `provision.mjs` are the declarative dashboard/insight control plane. They accept the personal management key only in the provisioner process.

## Architecture by surface

### Desktop, runtime, and hosted web client

The canonical service is `apps/desktop/src/main/services/analytics/productAnalyticsService.ts`. The desktop main process and the ADE runtime use the same machine-scoped service and durable state file. The hosted web client sends allowlisted capture requests through the runtime action registry; they do not own independent PostHog clients.

Machine analytics state lives under the active channel home at `secrets/product-analytics.json`, with a sibling `.disabled` marker for fail-closed opt-out during lock contention. It is not project state and never enters cr-sqlite replication. The project-local `usage_events` mutation ledger is also excluded from CRR sync; its analytics export marker prevents pre-analytics, opted-out, expired, or already-handled rows from being uploaded later.

The public contract is `apps/desktop/src/shared/types/productAnalytics.ts`. Every event carries one `surface`: `desktop`, `mobile`, `cli` (the `ade` command line), `web`, or `api`. Builds before ADE Code was removed called the command line `tui`; `normalizeAdeUsageClientSurface` (`shared/types/usage.ts`) reads that as `cli` at every intake, and the `usage_events` ledger rewrites stored `tui` rows to `cli` when the database opens. PostHog history from before the rename keeps `surface: "tui"`. The allowed events are:

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
- `ade_resource_pressure`

#### Properties on every event, milestones, and first opens

The service adds these properties to every event it sends (beside
`app_version`, `runtime_mode`, `platform` and `arch`), so active-user counts
can be cut by app and build and stripped of activity no person caused. None
adds an event.

- `client` — the app a person used: `desktop`, `web`, `cli` (the `ade` command line), `ios` (a
  host-recorded mutation from the phone, surface `mobile`), or `runtime` (the
  brain or CLI, surface `api`, which cannot see a client). `platform` stays
  the OS of the machine that sent the event, so a phone action recorded by a
  Mac still says `darwin`; filter phone use with `client = ios`.
- `interactive` — `false` for events no person caused: `ade_daily_usage_summary`,
  `ade_analytics_budget`, the `ade_update_*` events, `ade_brain_recovered`,
  `ade_renderer_recovered`, `ade_publish_failing`, `ade_relay_suppressed`,
  `ade_account_session_unreadable`, `ade_tool_fetched`,
  `ade_brain_action_failed`, `ade_resource_pressure`, an automation's work session and model turns,
  and an `ade_feature_used` with `mode: "automatic"` (a status line refresh
  after a turn, an automatic diagnostic send, a chat auto-resume). `true`
  otherwise (`productAnalyticsEventContext` in `productAnalyticsPolicy.ts`).
  The dashboards count a person as active only on `PERSON_ACTIVITY`
  (`scripts/posthog/dashboard-spec.mjs`): `interactive != false`, and, for
  builds before 1.2.128 that send no `interactive`, none of those event
  names, automation runs or automatic feature uses either.
- `is_internal` — `true` on an ADE team install, marked with
  `ADE_ANALYTICS_INTERNAL=1` in the environment or an empty
  `secrets/product-analytics.json.internal` file beside the state file. Read
  once per process. Desktop `$identify` also sets it on the person.
- `release_channel` — `stable`, `beta` (a Beta-track version), `alpha` (an
  Alpha package), `development` (an unpackaged app, a package no release
  workflow built, a source-checkout or dev-launcher brain; see Sentry's "When
  it runs"), or `unknown` (a caller that passed none). `resolveReleaseChannel` in
  `shared/packageChannel.ts`, the same function Sentry's environment and
  `release_channel` tag use. Events the brain records for the web client or
  the phone carry the brain's channel.
- `machine_id` — the install on one computer, 16 hex characters
  (`machineTelemetryId.ts`; the recipe is under Sentry's "Tags on every
  event"). The distinct id is the person once they sign in, so a person's
  laptop and desktop share it; `machine_id` tells them apart, and the
  dashboards count installs by it. Absent until this process has read the
  OS identifier (one off-thread probe on the first send) and on a machine
  that has none. The state file records the `machine_id` it was written on
  (`machineId`); one that differs at load was copied from another computer (a
  migrated or restored ADE home), and gets a new installation id, anonymous id
  and hashing salt (dedupe keys reset with the salt), keeping consent and the
  signed-in person, so the copy never sends as the original install or hashes
  its projects to the same values. A state file from before the field adopts
  the current id. The raw identifier is never stored or sent. iOS sends the
  phone's own (`identifierForVendor`, hashed).

The ADE account sign-in funnel is `ade_feature_used` with
`feature: "account_sign_in"`, `action: "sign_in"`, `outcome` `started` and
then one of `completed`, `failed` (with a coarse `error_kind`: `expired`,
`network`, `permission`, `timeout`, `other`, ...) or `cancelled`, and
`source` `browser` or `device_code` (`accountSignInAnalytics.ts`). One start
and one end per attempt, keyed by the login session id, never per poll. The
desktop main process records its own sign-ins (`surface: desktop`), the brain
records `ade login` (`surface: cli`, one attempt per command even though it
runs a browser and a device sign-in side by side) and skips desktop callers.
It runs while the person is anonymous; the `$identify` after a completed
sign-in merges the id.

`ade_app_installed` and `ade_activated` are once per installation, and a
milestone counts as sent only once delivery is confirmed. The service sends it
at once instead of in the next ten-second batch (a chat runtime can be
reclaimed before the batch timer fires) and records it as pending with its
uuid and moment. When the send is confirmed the milestone is final. When it is
not (the network failed or the process died), the next trigger after two
minutes sends it again with the same uuid and timestamp, so PostHog keeps one;
the one-per-day event cap means a retry lands the next UTC day at the latest.
`ade_activated` fires on the first completed chat turn
(`trigger: "work_session_completed"`) or the first agent CLI session started
or imported (`trigger: "cli_session_started"`), since ADE sees no turns inside
a CLI.

`install_source` is `direct_download` (the Mac app in an `Applications`
folder, the Windows installer's `ADE.exe`, an AppImage, or the Linux `.deb` under `/opt/ADE`), `homebrew` (a
Homebrew path, or the Mac app with a `Caskroom/ade` entry, since the cask copies
the app to `/Applications`), `install_script` (the standalone brain from
`install.sh` / `install.ps1` in `~/.ade/bin`), `development`, or `unknown`
(including a brain run by a plain `node`). The brain reads its own location
for this, because on a brain-only machine it is the first to record the
install.

The first `ade_app_opened` from each client carries `first_open: true`, once
per installation per client (`openedSurfaces` in the state file), so a first
TUI or hosted-web open is visible without a new event. A state file written
before this existed reports no first open on any client.

#### Sign-up (server-side)

`ade_signed_up` is recorded by the account-directory Worker, not by an app,
because sign-up happens on Clerk's own pages
(`apps/account-directory/src/signupAnalytics.ts`, `POST /webhooks/clerk`).
Clerk's `user.created` webhook, Svix-signed with
`CLERK_WEBHOOK_SIGNING_SECRET`, becomes one event per account under the same
`ade_user_…` hash the apps identify with. It carries `signup_method` (`github`,
`google`, `apple`, `microsoft`, `gitlab`, `discord`, `linear`, `other_oauth`,
or `email`), `client: "account"`, `is_internal`, `$set` `is_internal`, and
`$set_once` `clerk_user_id` and `signed_up_at`; never the email or name. Its
timestamp is the account's Clerk `created_at`.

- **One per account.** The uuid is derived from the Clerk user id
  (`signupEventUuid`), so a retried delivery and the backfill below give the
  same uuid and PostHog keeps one. (Events sent before 2026-10-30 used the
  `svix-id` instead; the backfill skips accounts that already have one.)
- **Internal accounts.** `ade_internal: true` in an account's Clerk private or
  public metadata (tests, the push-relay smoke users, the team) makes
  `is_internal: true`; dashboards filter on the person property. The flag is
  read once, when the sign-up is sent: set it before the backfill sends an
  older account, and for an account already in PostHog set the person
  property there too.
- **Deletion.** Clerk's `user.deleted` becomes `ade_account_deleted` on the
  same distinct id: `client: "account"`, `interactive: true`, no person
  properties, uuid from the user id (`accountDeletedEventUuid`).
- **Reconcile.** `scripts/analytics/reconcile-signups.mjs` lists every Clerk
  account and compares it with the distinct ids that have `ade_signed_up`:
  Clerk and PostHog totals, missing, extra (in PostHog but not Clerk, usually
  deleted), by month, internal counts. `--apply` sends the missing ones through
  `/batch/` exactly as the webhook would, plus `backfilled: true`; `--since`,
  `--json` and `--max-missing` (default 0; a check run over it exits 1) are
  the other options. It prints counts only. `.github/workflows/analytics-reconcile.yml`
  runs it every Monday at 14:00 UTC (backfill, then a check that goes red if
  anything is still missing), with the secrets `CLERK_PROD_SECRET_KEY`,
  `POSTHOG_RECONCILE_API_KEY` (a personal key with query read only) and
  `ADE_POSTHOG_PROJECT_TOKEN`.
- **Internal accounts.** The PostHog transformation `Mark ADE team accounts
  internal` sets `is_internal: true` on every event whose distinct id is in its
  `internal_distinct_ids` list, so the team's accounts and the installs signed
  in to them stay out of every dashboard. `reconcile-signups.mjs
  --sync-internal [--apply]` adds the distinct ids of persons with
  `is_internal = true` to that list (it never removes one) and exits 1 when the
  transformation is off or, without `--apply`, when the list is behind. The
  Monday run applies it before the backfill, with its own key
  `POSTHOG_INTERNAL_SYNC_API_KEY` (query read, hog function read and write),
  and skips with a notice without it.
- **Health.** `.github/workflows/analytics-health.yml` runs
  `scripts/analytics/data-health.mjs` every six hours. It checks that the
  site's `/_t/` proxy answers as PostHog for capture, flags, replay and the
  script, and, with `POSTHOG_RECONCILE_API_KEY`, that the last 24 hours have
  at least 100 site events and 3 desktop app opens. Each probe and query gets
  three tries. Exit 1 means analytics are not arriving; exit 2 means the check
  could not ask PostHog.

It needs `CLERK_WEBHOOK_SIGNING_SECRET` and `POSTHOG_PROJECT_TOKEN` set on the
Worker and a Clerk webhook subscribed to `user.created` and `user.deleted`;
until then the route answers 503 and records nothing. Volume is one event per
new or deleted account.

#### ADE Cloud (server-side)

The account-directory Worker records ADE Cloud's product facts itself,
because it decides every create, grow, refusal and plan change, for every
client version and for work nobody watches
(`apps/account-directory/src/cloud/analytics.ts`). Both events go to
`/i/v0/e/` under `waitUntil` with a two-second timeout; a failure logs
`cloud.analytics_capture_failed` and never fails a request or a tick. Without
`POSTHOG_PROJECT_TOKEN` nothing is sent. The distinct id is the account's
`ade_user_…` hash; every event carries `client: "account"` and
`$geoip_disable: true`.

- **`ade_cloud_action`**: one per decided action. `action` is `create`,
  `move`, `copy`, `tier_change`, `grow`, `delete`, `plan_change` or
  `refused`; `plan` is `free`, `plus`, `pro` or `max`; `origin` is `person`,
  `agent` (the computer was made by an agent's chat, or an agent deleted it)
  or `system` (the computer's own disk grower, the idle cleanup); `tier` is
  `small`, `medium`, `large`, `xlarge` or `other`. A refusal adds `refusal`
  (`out_of_hours`, `awake_cap`, `plan_disk`, `needs_approval`,
  `extra_off`, `monthly_limit`, `tier_limit`, `owner_limit`, `over_plan_disk`) and
  `refused_action` (`create`, `move`, `copy`, `tier_change`, `grow`, `wake`).
  The uuid comes from the account, the action, a key (the instance id, hashed
  and never sent) and a time bucket: one per minute for an action, one per
  refusal kind per hour for a refusal, so a retry or a grower that asks again
  stays one event.
- **`ade_cloud_day`**: one per account with power changes on a UTC day, sent
  by the daily run for the day before: `wakes`, `sleeps`, `stops`, `starts`
  (from `cloud_power_log`) and `computers`, each capped at 1,000. The uuid
  comes from the account and the day.
- **`ade_cloud_referral`** (`referrals.ts`): `step` is `code_entered` (with
  `result` `accepted` or `refused` and, refused, `reason`: `invalid_code`,
  `unknown_code`, `own_code`, `already_referred`, `too_late`,
  `rate_limited`), `reward_paid` (with `role` `friend` or `referrer`, one each,
  and `referrer_rewarded`), `reward_refused` (with `reason` `same_computer` or
  `friend_computer_used`) or `cap_reached` (the referrer's 10th reward). One
  per account, step, reason and hour.
- **`ade_cloud_idle_cleanup`** (`idleCleanup.ts`): `step` is `warned`,
  `emailed` (a follow-up), `saved`, `push_refused` (with `reason`, a closed
  code such as `push_left_work`, `check_left_work`, `prepare_stop_failed`,
  `wake_failed`), `deleted` or `kept` (with `how`: `button`, `used`,
  `hours_back`); `plan` is the account's plan. One per account, step,
  computer (hashed into the uuid, never sent) and hour. Server log lines:
  `cloud.idle_cleanup_warned`, `_kept`, `_came_back`, `_held`, `_deleted`;
  Sentry: `cloud.idle_cleanup_push_refused`, `_save_failed`, `_delete_failed`,
  `_email_failed`, `_run_failed`, `_account_failed`, `_log_failed`,
  `_unclaim_failed`, `_report_failed`, `cloud.idle_cleanup_put_back_failed`.
- **`ade_cloud_free_plan`** (`freePlan.ts`): `step` is `claimed`, `restored`
  (a refused account claimed a computer of its own), `refused` (the computer
  already gave another account its free hours), `id_unreadable` or
  `unclaimed_use` (free hours used with no computer seen: phone or MCP only),
  with `platform` (`darwin`, `win32`, `linux`) when known. One per account,
  step and day.

Never an instance id, a name, a size in numbers, a price, an amount, a
message, a Stripe id, an invite code or link, an email, a computer id, or the
other account in a referral. Volume: a few events per account per active day.

Server log lines for referrals and the free plan: `cloud.referral.code_accepted`,
`cloud.referral.code_refused` (reason), `cloud.referral.reward_paid`,
`cloud.referral.reward_refused` (reason), `cloud.referral.cap_reached`,
`cloud.referral.created_at_fallback` (Clerk had no creation date: the ADE Cloud
account's is used), `cloud.free_plan.claimed`, `cloud.free_plan.refused`,
`cloud.free_plan.restored`, `cloud.free_plan.id_unreadable`,
`cloud.free_plan.dev_key` (no `CLOUD_CHAT_MASTER_KEY`). Sentry, tagged
`area: cloud-free-plan` or `cloud-referrals`, one issue per name:
`cloud.free_plan.many_accounts_one_computer`, `cloud.referral.cap_reached_fast`,
`cloud.referral.many_friends_one_computer`, and the failures
`cloud.free_plan.settle_failed`, `cloud.referral.reward_failed`,
`cloud.referral.summary_failed`, `cloud.referral.clerk_read_failed`.

Server log lines (Worker logs only, `logCloud`) for plans and cost:
`cloud.plan_changed` (from, to),
`cloud.daily_cost_report` (totals only), `cloud.owner_alert` (an alarm),
`cloud.owner_limit_unset` (once a day while no limit is set),
`cloud.owner_limit_reached`, `cloud.owner_cost_step` (the month's estimate
passed another $50 below the limit: step, estimate, limit; one owner email),
`cloud.extra_disk_capped` (a day of extra disk
billed only up to the person's monthly limit), and
`cloud.analytics_capture_failed`.

The new product facts reuse `ade_feature_used`; they do not add an event name or
raise a ceiling. The taxonomy is closed at the producer and again by
`productAnalyticsPolicy.ts`:

| feature | action | outcome | provider property |
| --- | --- | --- | --- |
| `provider_accounts` | `account_created`, `account_removed`, `account_signed_out`, `default_selected` | `completed` | Claude/Codex family |
| `provider_accounts` | `account_created` (a cloud login), `account_signed_out`, `default_selected` (the login in use) | `completed` | `opencode` only, never the upstream provider; at most one per action per hour by the shared dedupe |
| `provider_accounts` | `balance_changed`, `auto_start_changed` | `enabled`, `disabled` | Claude/Codex family |
| `provider_accounts` | `subagent_cache_changed` | `enabled` (1 hour), `disabled` (the Claude default) | Claude only |
| `provider_accounts` | `main_cache_changed` | `enabled` (5 minutes or 1 hour chosen), `disabled` (Automatic) | Claude only |
| `provider_accounts` | `extra_usage_stop_changed` | `enabled` (stop the turn), `disabled` (continue, the Claude default) | Claude only |
| `api_credentials` | `credential_stored`, `credential_removed` | `completed` | coarse provider family |
| `presets` | `preset_created`, `preset_deleted` | `completed` | coarse harness/provider family |
| `proxy` | `sign_in` | `success` | Claude/Codex family |
| `proxy` | `start`, `stop` | `completed` | omitted; no provider is involved |
| `usage` | `reset_credit_consumed` | `completed`, `nothing_to_reset`, `no_credit`, `already_redeemed`, `failed` | Claude/Codex family; omitted when no account was named |
| `usage` | `model_price_changed`, `model_mapping_changed` | `enabled` (set), `disabled` (cleared) | omitted; never the model id or the rates |
| `chat` | `pending_input_dismissed` | `completed` | coarse session provider family |
| `chat` | `new_lane_launch` | `completed`, `cancelled`, `failed` | coarse chat provider family |
| `chat` | `voice_conversation_started` | `completed` | coarse chat provider family |
| `work` | `session_continue_chat`, `session_copy_chat`, `session_continue_cli`, `session_copy_cli` | `completed`, `failed` | coarse provider family (Qwen, Kimi, Grok and Copilot report `other`) |
| `automations` | `webhook_url_created` | `completed` | omitted; never the URL, hook id, preset, or rule |
| `automations` | `safe_test_started`, `live_test_started` | `completed`, `failed` | omitted; never the rule, its steps, the event, or the lanes it made |
| `automations` | `run_on_changed` | `completed` | omitted; never the rule, either computer, or the repository |
| `chat` | `secret_requested` | `completed` (saved), `kept`, `cancelled` (declined), `failed` (unanswered in time or the request failed) | omitted; never the secret's name, value, reason, or chat |
| `chat` | `connect_requested` | `completed` (connected), `kept` (already connected), `cancelled` (declined), `failed` (unanswered in time or the request failed) | omitted; never the integration's account, the key, or the chat |
| `chat` | `mcp_server_requested` | `completed` (added), `kept` (already in ADE), `cancelled` (declined), `failed` (unanswered in time or the request failed) | omitted; never the server's name, its command or URL, a key, or the chat |
| `chat` | `provider_sign_in` | `completed`, `cancelled`, `failed` | coarse provider family (`other` for the CLIs outside it); never the account, link, code, machine, or chat |
| `chat` | `mcp_server_remove_requested` | `completed` (removed), `cancelled` (kept), `failed` (unanswered in time or the request failed) | omitted; never the server's name, its command or URL, or the chat |
| `chat` | `machine_removal_requested` | `completed` (removed), `cancelled` (kept, or the card closed), `failed` (unanswered in time or the request failed) | omitted; never the computer's key, name or platform, the account, or the chat |
| `home` | `tab_opened` | `tab_browser`, `tab_music` | omitted; never a URL, tab, song, or page |
| `home` | `widget_added` | `widget_<type>` (one per home widget type) | omitted; never the layout, a preset name, or a widget's settings |
| `home` | `music_connected` | `completed`, `cancelled`, `failed` | omitted; never the Apple account, storefront, or token |
| `home` | `spotify_connected` | `completed`, `cancelled`, `failed` | omitted; never the Spotify account, client ID, device, track or token |
| `mcp_servers` | `sign_in` | `completed`, `cancelled`, `failed` | omitted; never the server's name, its URL, the authorization server, or the token |
| `ade_mcp` | `server_toggled` | `enabled`, `disabled` | omitted; never the machine, its server URL, or a connection |
| `ade_mcp` | `app_connected`, `token_created`, `connection_removed` | `completed` | omitted; never the app's name, its redirect host, the access level, a token, or a command it ran |
| `connections` | `github_cli_shared`, `github_cli_removed` (the person shares this computer's gh sign-in with the account, or takes it off, from Settings › GitHub; the background sync records nothing) | `completed` (the vault accepted it) | omitted; never the login, the account, or an error. Per action, at most one an hour |
| `connections` | `github_app_connected` (how a connect of the account's ADE GitHub App sign-in ended, read in Settings once the server settles it), `github_app_disconnected` | `completed` (connected, or disconnected), `cancelled` (declined on GitHub or on ADE's confirm page, or the link ran out), `failed` | omitted; never the login, the account, the sign-in id, or an error. Per action and outcome, at most one an hour |
| `passwords` | `passwords_switched` (Passwords turned on or off on a computer), `logins_imported` (a CSV import), `agent_signed_in` (an agent's `ade browser signin` filled a login), `agent_signed_up` (`ade browser signup` made and saved a password), `secrets_exec` (an agent's `ade secrets exec` ran) | `enabled`, `disabled` (the switch); `completed`, `cancelled` (the person declined, or the page was not one to fill), `failed` (a timed-out `secrets exec` counts as failed; a command's own exit code does not) | omitted; never the site, account, item, command, a count, or an error. Captured once at the brain (surface `api`), after the call settles; per action and outcome, at most one an hour |
| `find` | `find_opened` | `chat_shortcut`, `chat_palette`, `chat_palette_hit`, `diff_shortcut` | omitted; never the query, the chat, the diff, a file, or a match count |
| `browser` | `tab_kept` (a person pressed Keep on an agent's tab, or Keep tabs on a chat group), `remote_tab_watched` (picked a tab on another machine to watch; the automatic show of the chat's own tab is not counted), `remote_tab_controlled` (took control of one) | `completed` | omitted; never the URL, title, tab, chat, lane or machine. Per action, at most one a day (`browser:<action>`) |
| `lanes` | `template_setup_started` | `from_banner`, `from_settings` | omitted; never the lane, template, or machine |
| `lanes` | `template_suggestion_hidden` | `completed` | omitted; never the lane, template, or machine |
| `lanes` | `deps_update_started` | `completed`, `failed` | omitted; never the lane, package details, machine, or error |
| `lanes` | `branch_pattern_changed` | `pattern_ade`, `pattern_user`, `pattern_none`, `pattern_custom` (which kind of branch name pattern was saved) | omitted; never the pattern text, a branch, the repository, or the machine |
| `lanes` | `start_default_changed` | `start_default`, `start_primary`, `start_branch` (where new lanes start) | omitted; never the branch name or the machine |
| `lanes` | `branch_renamed` | `completed`, `failed` | omitted; never the lane, either branch name, the machine, or the error |
| `lanes` | `auto_archive_changed`, `auto_free_up_changed`, `auto_delete_changed` | `enabled`, `disabled` (an automatic cleanup rule turned on or off) | omitted; never a day count, a lane, or the machine |
| `lanes` | `space_freed` | `completed`, `failed` (Free up space on an archived lane in Settings › Archive) | omitted; never the lane, its size, the machine, or the error |
| `lanes` | `deleted_lane_restored` | `completed`, `failed` (Restore from the notice after a delete, or from Recently deleted; `failed` includes files that did not apply) | omitted; never the lane, branch, machine, or the error |
| `star_prompt` | `star_prompt_shown`, `star_prompt_clicked`, `star_prompt_dismissed`, `repo_starred` | `prompt_first`, `prompt_second` (which showing of the pill) | omitted; never the GitHub account, a message count, or the machine |
| `onboarding` | `onboarding_welcome_shown`, `onboarding_sign_in_shown`, `onboarding_agents_shown`, `onboarding_projects_shown`, `onboarding_completed`, `onboarding_skipped` | `opened` (a first-run card came on screen), `completed`, `cancelled` (skipped) | omitted; at most one of each a day per install; never the account, a provider, or a project |

Every row is passed through `sanitizeProductAnalyticsProperties` in
`apps/desktop/src/main/services/analytics/productAnalyticsPolicy.ts`, which
keeps only the event's property keys and closed values; its `safeStringProperty`
path drops arbitrary strings. Provider mapping is also performed by
`featureProductAnalytics.ts` before capture, and local dedupe keys are hashed
by the analytics service rather than transmitted.

A browser sign-in to an MCP server (Settings › Integrations › MCP servers) records
`mcp_servers/sign_in` once when it ends, in the desktop IPC handler that runs
it (`desktop`). It is a deliberate click that waits on a browser, deduplicated
per outcome for an hour, so the worst case is three events a day inside the
existing `ade_feature_used` ceilings.

ADE MCP (Settings › App › ADE MCP, `ade mcp`) records its decisions in
the brain, after the change is stored: `server_toggled` when it is switched on
or off, `token_created` and `connection_removed` from Settings (`desktop`) or
`ade mcp` (`api`), and `app_connected` when an app finishes signing in
(`api`). Each is deduplicated per action and outcome for an hour, so the worst
case is five events a day inside the existing `ade_feature_used` ceilings. The
commands connected apps run are never captured, typed tools, prompts and the
`ade://commands` resource included; they are counted only in the local activity
log (`<ade home>/remote-mcp/activity.jsonl`) that Settings shows. A skill folder
the prompts list cannot read, and a failed read of the command catalog, log
`remote_mcp.skill_unreadable` / `remote_mcp.catalog_failed` warnings.

Making a private webhook URL records `automations/webhook_url_created` where
the URL is made: the desktop's IPC handler (`desktop`) or the
`automations.webhookCreateEndpoint` / `webhookCreateAutomation` actions
(`api`, the CLI and agents). An agent's private secret card records
`chat/secret_requested` once, when `project_secret.request` returns or fails,
at the brain action that owns it. The connect card and the MCP server card do
the same: `chat/connect_requested` at `integration_connect.request`,
`chat/mcp_server_requested` at `mcp_registry.request`, and
`chat/mcp_server_remove_requested` at `mcp_registry.remove`. The computer
removal card (`ade machines remove` from a chat) records
`chat/machine_removal_requested` once, in the brain's `account.deleteMachine`
route that raised it; a second chat told that a card is already open
(`pending_approval`) asked nothing and records nothing. When an MCP server name
is a built-in integration, the connect card runs instead and records only
`connect_requested`. Neither carries a name, URL, value, or id;
both are rare user decisions inside the existing `ade_feature_used` 140-per-day
and 30-per-minute ceilings, and the per-action-and-outcome dedupe holds a burst
(an agent creating several URLs, or re-asking) to one event per outcome per
interval. Delivery outcomes are high-frequency and stay local, in the
per-hook delivery log.

Starting a test of an automation from the builder's Test dialog or
`ade automations test` records `automations/safe_test_started` or
`automations/live_test_started` where the test starts: the desktop IPC handler
(`desktop`) or the `automations.runTest` action (`api`). `failed` means the test
did not start (a problem in its plan, or the throwaway lane could not be made).
A preview records nothing. A test is a deliberate click, and the per-action
and per-outcome dedupe holds a burst of tests to one event per outcome per
interval, inside the existing `ade_feature_used` 140-per-day and 30-per-minute
ceilings. What the test did stays in the local run history.

Choosing another computer to run an automation that follows the account
(**Runs on** in the builder, or `ade automations run-on`) records
`automations/run_on_changed` in the brain where the new home is stored
(`automationService.setRunOn`, or the planner's `saveDraft` with a new home),
surface `api`. Saving a rule with its home unchanged records nothing. It is a
deliberate choice, rare, and the per-action dedupe holds a burst to one event
an hour, inside the existing `ade_feature_used` ceilings.

Saving a model price or "Map to" on the Usage page (desktop, web, phone or
`ade usage prices set`) records `model_price_changed` or
`model_mapping_changed` at the brain's `usage.setModelPriceOverride`, with
`enabled` for a set and `disabled` for a clear. The model id and rates never
leave the machine. The one-hour dedupe per action and outcome caps it at four
events an hour, within the existing `ade_feature_used` ceilings.

A Codex voice conversation records one `voice_conversation_started` fact after
the realtime offer receives an answer. The event is scoped to the chat session
in local deduplication, with a one-hour minimum interval, and includes only the
coarse provider family. It never carries audio, a transcript, voice settings,
SDP, thread IDs, or a raw session ID; the analytics service salts and hashes
the local session ID before capture. Its volume stays within the existing
`ade_feature_used` ceilings of 140 events per UTC day and 30 per minute, with
at most one accepted event per chat session per hour.

The update and reliability events are low-frequency by construction: the five `ade_update_*` events fire at most once per install attempt or idle-apply cycle (daily caps 10–20, minute caps 3–6). `ade_update_install_did_not_land` is emitted once at startup when a requested install relaunched on the old version, so it is bounded by app launches that follow a failed handoff, and carries only a bounded `attempt` counter; `ade_brain_recovered` fires once per wedge recovery at brain startup; `ade_renderer_recovered` fires once per lost renderer and is bounded by the recovery budget itself (three reload attempts per rolling 60 seconds, after which the window stays down rather than looping), carrying `crash_reason` — Electron's closed enum, normalized to `unknown` for any future value — whether the reload was still allowed, and closed buckets for what the window held at its last memory snapshot: `heap_mb_bucket` (`under_512`, `512_1024`, `1024_2048`, `2048_3072`, `3072_plus`, from the peak heap that renderer process reported), `heap_pct_bucket` (`under_50`, `50_75`, `75_90`, `90_plus`, that heap against its limit), `duration_bucket` (`under_10s` … `over_2h`, how long the page had been open, measured at the crash from its load), `chat_pane_bucket` (`0`, `1`, `2_5`, `6_plus` open chat panes), `transcript_bucket` (`under_1k`, `1k_5k`, `5k_20k`, `20k_plus` events in the largest loaded transcript, `none` with no chat open) and `replay_active` (whether session replay was recording); the snapshot buckets read `unknown` when no snapshot arrived or the last one is more than two minutes old (snapshots stop while the window is hidden). The worst-case volume is unchanged (still once per lost renderer, inside the same recovery budget). No path, title, URL or message content is sent, and the exact numbers go to Sentry only (on the `window.render_process_gone` line: last and peak heap, heap limit, open panes, largest transcript, replay on from a fresh snapshot, plus seconds open and the snapshot's age). The renderer reports the snapshot over the fire-and-forget IPC `ade.app.reportRendererMemory` one second after load and then on every 30th tick of its existing 1 s event-loop watchdog while the window is visible (`renderer/lib/rendererMemorySnapshot.ts`, no new timer); main keeps one validated record per window (`main/rendererMemoryLedger.ts`) and starts a fresh record (and page clock) on every page load or reload, deleting it on close or crash; `ade_publish_failing` is edge-triggered once per sustained failure episode (first crossing of two minutes), never per attempt, and carries `failing_minutes`, `leg`, `code` and, for token-leg failures, a closed `cause` (`status_read_error`, `session_expired`, `session_unreadable`, `no_access_token`, `token_refresh_failed`).

Changing automatic-install preferences records the existing `ade_feature_used`
event at the update-service owner boundary with `feature: "updates"`,
`action: "preferences_changed"`, a coarse `mode` (`automatic` or `manual`), and
a coarse `outcome` (`idle_only` or `immediate`). It carries no paths, versions,
session details, or runtime activity counts. A persisted 24-hour deduplication
key per preference combination bounds this to at most four accepted events per
installation per UTC day, within the existing `ade_feature_used` and shared
daily ceilings.

Starting a switch in **Settings › About › Update track** records the same
`ade_feature_used` event at the update-service owner boundary
(`startTrackSwitch`), with `feature: "updates"`, `action: "track_switch"`, and
a closed `outcome`: `to_beta` or `to_stable`. Choosing the running build's
track again (a cancel) records nothing. It carries no version, path or
database detail. A one-hour deduplication key per direction bounds it to at
most 48 accepted events per installation per UTC day in theory, and in
practice one or two, within the existing `ade_feature_used` ceilings. Beta
builds report errors to Sentry with the environment `beta` (version read
from the build), so Beta issues never mix with production ones.

Pressing **Fix it** on the macOS banner that says ADE will ask for a password on
every update (its app bundle belongs to root or another account) records the
same `ade_feature_used` event at the IPC owner that runs the fix
(`registerAppBundleOwnershipIpc.ts`), with `feature: "updates"`,
`action: "bundle_ownership_fix"`, and one closed `outcome`: `completed`,
`partial` (the command ran but some files still are not the user's),
`cancelled` (the password prompt was dismissed), or `failed`. The product
question is how many installations end up with a root-owned app and whether the
fix clears it. It carries no path, owner name, uid, or osascript output; those
stay in the local `app_bundle_ownership.fix` line. A one-hour deduplication key
per outcome bounds it to four accepted events per installation per hour, and in
practice one per affected installation, inside the existing `ade_feature_used`
ceilings. The check itself and the banner showing capture nothing.

Choosing a keep-awake level records the same `ade_feature_used` event at the
brain keep-awake service's persist boundary — after the choice is written, so a
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

Settle records one thing at the session-service owner boundary, on the
existing `ade_feature_used` event with `feature: "work"`.

`action: "settled_lane_released"` fires from the brain when the optional
settled-lane release actually let go of something, with `mode: "automatic"` so
it never counts as user activity; it is deduplicated to one an hour, so the worst case is 24 events a day inside the `ade_feature_used` limits.

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

A side chat (`/side`) records one coarse fact on the same `ade_feature_used`
event with `feature: "chat"` and `action: "side_chat"`, at the durable owner
(`sideChatService.ts`, through the `onSideChatOutcome` hook that `main.ts`
wires to `captureChatSideChatAnalytics`): `outcome` is `started` (a side chat
opened), `delivered` (a message the user asked it to send reached the main
chat) or `failed` (that message could not). `provider` is the coarse slug.
Never the question, the reply, the sent message, or the model. A
`chat_side_chat:<main chat>:<outcome>` deduplication key (hashed locally, never
sent) with a ten-minute minimum interval bounds it: a side chat opens once and
sends only on request, so the worst case is three accepted events per chat per
ten minutes and realistic volume is a few per installation per day, inside the
existing `ade_feature_used` limits. No ceiling was raised. Opening the Side
chat tool also counts through `tool_opened` (`tool_side_chat`).

What becomes of a handoff's transcript replay records one coarse fact on the
same `ade_feature_used` event with `feature: "chat"` and
`action: "handoff_replay"`, at the durable owners: `handoffSession` once the
pre-flight has resolved, and the Claude replay-overflow recovery once per
terminal. `outcome` is a closed set of five values — `fit` (the whole
conversation reached the new model), `truncated` (only its newest turns did),
`refused` (the handoff could not be made at all), `retried` (ADE re-sent the
message with less history and the model took it), and `gave_up` (it ran out of
room and handed the turn back). `provider` rides along as the existing coarse
target-provider slug. The product question is only whether a cross-provider
handoff carries the conversation, so nothing finer crosses the boundary: no
model name, no turn counts, no share of the context window, no notice copy, and
no part of the transcript. A `share_bucket` property was considered and left
out — no bucket key for a proportion exists, and the five outcomes already
answer the question.

Volume is bounded by a `chat_handoff_replay:<session>:<outcome>` deduplication
key (the service salts and hashes it locally; it is never sent) with a one-hour
minimum interval. A handoff is a deliberate user action that emits once, and the
recovery emits at most one `retried` or `gave_up` per user message, so worst
case is five accepted events per chat per hour and realistic volume is single
digits per installation per day — inside the existing `ade_feature_used`
140-per-day / 30-per-minute limits and the shared 200-event ceiling. No ceiling
was raised, and no PostHog definition changed: the provisioning scripts
enumerate event names, not `action` or `outcome` values. The recovery's local
operational lines (`agent_chat.claude_replay_overflow_retry`,
`agent_chat.claude_replay_overflow_gave_up`), which carry session and turn ids
and turn counts, are not PostHog events.

How a context compaction ended records one coarse fact on the same
`ade_feature_used` event with `feature: "chat"` and `action: "compaction"`, at
the durable owner: the chat service's event commit, once per compaction that
ends (`completed` or `failed`), for every provider. `mode` is `manual` when the
user asked (`/compact`, **Compact now**, or Retry) and `automatic` otherwise,
including ADE's own 97% fallback and the compaction "Always compact first" runs
by itself while the prompt cache is still warm (`warmIdleCompactionScheduler.ts`,
at most one per idle hour per chat). A send made with the **Compact first** pill
records `action: "compact_first"` with the same two outcomes and
`mode: "manual"`. `provider` is the existing coarse slug and `source` is
`runtime`. The product questions are whether compaction works and how often
people ask for it, so nothing finer crosses the boundary: no token counts, no
summary, no failure text, no account, and no model. The compaction-point
setting itself is not instrumented, and neither is "Subagents compact at": both
are rare choices saved through the generic `ai.updateConfig` or account-settings
write, which has no per-key owner, and no dashboard needs them yet. Moving a
chat onto or off a saved preset (`chat.updateSession` with `presetId`) is a
model choice, which ADE does not record as a product fact: the only content-free
property would be "changed", and a preset or model id cannot cross the boundary.

Volume is bounded by a `chat_<action>:<session>:<outcome>:<mode>` deduplication
key (hashed locally, never sent) with a ten-minute minimum interval, so a chat
reports each combination at most six times an hour; realistic volume is a few
compactions per installation per day, inside the existing `ade_feature_used`
140-per-day / 30-per-minute limits and the shared 200-event ceiling. No ceiling
was raised and no PostHog definition changed. The local operational lines
(`agent_chat.claude_context_compaction_observed`,
`agent_chat.claude_context_compaction_fallback_gate`) keep their session ids and
token counts locally and are not PostHog events.

How a move of a chat to another machine ended records one coarse fact on the
same `ade_feature_used` event with `feature: "chat"` and
`action: "cross_machine_move"`, at the durable owner: the source brain's move
orchestrator (`crossMachineHandoffOrchestrator.ts`), once per terminal state,
through `onCrossMachineMoveOutcome` on the chat service and
`captureCrossMachineMoveAnalytics`, wired in the brain's bootstrap (the only
runtime with a transport, so the only one that runs moves). `outcome` is a
closed set of four values — `continued` (the destination chat started),
`failed` (a step failed or the destination refused), `cancelled` (kept here,
denied, dismissed, or a new message won), and `unknown` (the answer was lost
after acceptance started) — and `source` is the existing `runtime`. The product
question is only whether moving a chat works, so nothing finer crosses the
boundary: no session or handoff id, no machine name, no failure reason, no
branch or commit, no model, and no capsule content. Who asked (`user` or
`agent`) is left out because no existing key holds it, and no key was invented.
A move whose chat was deleted records nothing.

Volume is bounded by a `cross_machine_move:<handoffId>:<outcome>` deduplication
key (hashed locally, never sent) with a one-hour minimum interval, so a retried
move that ends `unknown` again inside the hour counts once. Moves are deliberate
actions, and one move reaches at most four terminal outcomes (`unknown`, then a
retry to `failed` or `continued`, or a dismissal to `cancelled`), so realistic
volume is a handful per installation per day — inside the existing
`ade_feature_used` 140-per-day / 30-per-minute limits and the shared 200-event
ceiling. No ceiling was raised, no PostHog definition changed (the provisioning
scripts enumerate event names, not `action` or `outcome` values), and the
dashboard spec is untouched until a product question needs it. The
orchestrator's local operational lines (`agent_chat.cross_machine_handoff_*`),
which carry session and handoff ids, are not PostHog events.

A chat that starts work on another machine (`ade shell start --machine` or an
`ade apple` call there, run in that machine's work copy) records one coarse fact
on `ade_feature_used` with `feature: "chat"`, `action: "remote_work"`,
`outcome: "started"` and `source: "runtime"`. The chat's brain records it as it
forwards a call that succeeded (`noteRemoteWork` in `agentChatService.ts`,
through `onRemoteWorkStarted` and `captureRemoteWorkAnalytics`, wired in the
brain's bootstrap). The product question is only whether people use their other
machines from a chat, so nothing finer crosses: no machine, no command, no path,
no output, and no shell or simulator split, because no closed key holds it. A
`remote_work:<sessionId>:<machineKey>` deduplication key (hashed locally, never
sent) with a one-hour minimum interval counts each chat once an hour for each
machine, however many commands it runs there. Realistic volume is a few events
per installation per day, inside the existing `ade_feature_used` limits and the
shared 200-event ceiling. No ceiling was raised and no PostHog definition
changed.

### Jev decisions

The shared Jev helper (`apps/desktop/src/main/services/jev/jevService.ts`) writes local operational lines to the project runtime's `ade-cli.jsonl`. The OpenCode Zen token, the ADE account bearer, the asked state and the answers are never logged. Its only PostHog fact is one `ade_daily_usage_summary` row per project and completed day with `summary_kind: "jev"` (`captureDailyJevAnalytics`): counts only, at most one a day per project under the daily summary's dedupe, never a prompt, a model, or a route's URL. It carries `call_count`, `error_count`, `input_token_count`, `output_token_count`, `jev_wanted_count`, `jev_ok_count`, `jev_cached_count`, `jev_answered_free_count`, `jev_answered_zen_credit_count`, `jev_answered_bonus_count` (answers per route), one count per fallback reason, `jev_breaker_open_count`, `jev_unsent_input_token_estimate`, `jev_latency_avg_ms`, `jev_slow_count`, `jev_sent_<feature>` and `jev_unsent_<feature>` per feature, and `jev_key_skip_<reason>` per reason a call with no answer never reached the ADE bonus (`key_spent`, `key_failing`, `key_rejected`, `signed_out`, `no_account_token`, `no_account_server`, `out_of_time`).

- `jev.summary` (info) — at most once per 10 minutes, and only after a window with traffic (plus once on runtime teardown): `windowMinutes` and `features`, a map from feature (`turn_end`, `cli_status`, `settle_nudge`, `palette`, `lane_emoji`, `model_hint`, `status_line`) to the count of each outcome in the window (`ok`, `cached`, or a fallback reason: `disabled`, `breaker_open` (every route spent or down), `busy`, `invalid_request`, `timeout`, `network`, `rate_limited`, `auth_rejected`, `http_error`, `bad_response`) and `p50Ms`/`p95Ms` of network calls that answered. This is the line that shows whether Jev ever ran.
- `jev.breaker_opened` (warn) — `feature` of the call that tripped it, `route` (`free`, `zen_credit`, `bonus`; each route has its own breaker), `reason` (`rate_limited`, `auth_rejected`, `transient`), `trigger` (the failure), and `until` (ISO).
- Once per UTC day per brain and problem (so each becomes one Sentry issue or log, not a flood): `jev.key_no_account_server` (error, no account directory address), `jev.key_no_token` (error, signed in but no account token could be read), `jev.key_token_slow` (warn, the token read outlasted the call's remaining `budgetMs`), `jev.key_signed_out` (info), `jev.key_rejected` (error, the bonus refused the account token: `status`), `jev.key_call_failed` (error, the bonus answered `http_error`, `bad_response` or `invalid_request`: `outcome`, `status`), `jev.key_unreachable` (warn, the bonus call hit a `timeout` or `network` failure: `outcome`), `jev.key_spent` (info, a cap or the key's spend cap), `jev.route_failed` (warn, OpenCode answered something other than a rate limit: `route`, `outcome`, `status`). `jev.decide_failed` (error) is an unexpected throw inside the helper, with `feature` and the thrown `error` itself, so Sentry groups it by stack; the caller still got `null`.

`ade actions run ai.jevStatus` returns the same counts since the runtime started, with availability and breaker state.

The turn-end check (`chat/turnEndQuestionCheck.ts`) logs `agent_chat.turn_end_question_tiebreak` (info) for every Jev/cheap-model decision with `sessionId`, `turnId`, `provider` (the cheap-model provider or null), `jev` (`ask`, `not_ask`, `unsure`, `no_answer`), `decidedBy` (`jev` or `model`), `asksUser`, `awaitingOwnWork`, `stillOpen` and `durationMs`; `agent_chat.turn_end_question_raised` (info) with `decidedBy` `rules`, `jev` or `model`; `agent_chat.turn_end_question_tiebreak_failed` (warn) when the cheap model throws; `agent_chat.turn_end_question_quiet_check` (info: `sessionId`, `turnId`, `jev`, `stillOpen`) for each Jev confirmation of a clear ask on a turn with no background work; `agent_chat.turn_end_question_jev_failed` (warn) when the Jev call itself rejects (the turn falls through as if Jev were absent); `agent_chat.turn_end_question_quiet_check_failed` and `agent_chat.turn_end_question_tiebreak_crashed` (warn) when either background check throws; and `agent_chat.turn_end_awaiting_own_work` (info, `sessionId`) when a chat is marked as waiting on its own work.

The composer's model hint (`chat/useComposerModelHint.ts`) logs `renderer.model_hint.outcome` (info) through the renderer's debug-event bridge, so it lands in the desktop's project `main.jsonl` on the machine whose window showed it. One line per hint the user saw: `outcome` (`accept` = clicked, `dismiss` = the ×, `ignore` = the prompt was sent or cleared with the hint still up), `fromModel`/`fromEffort` (the pick at the time), `toModel`/`toEffort` (the suggestion), `effortOnly`, and `fromHistory` (whether Jev had the user's similar chats). No prompt text. Hints replaced while typing log nothing. The history the hint reads (the user's recent new chats) lives in the window's localStorage (`ade.modelHint.history.v1`, see the chat composer docs), not in this log. A taken or dismissed chip is also one `ade_feature_used` event: `feature: "model_hint"`, `action` the kind of chip (`hint_model`, `hint_effort`, `hint_cheaper`), `outcome` `hint_accepted` or `hint_dismissed`, `source: "renderer_route"`, deduplicated to one per kind and answer per installation per UTC day (at most 6 a day, inside the existing `ade_feature_used` 140-a-day and 30-a-minute limits; no ceiling raised). Never the prompt, a model, or an effort. Settings › Keyboard sends two coarse facts through the same renderer path (`source: "renderer_route"`): `ade_feature_used` with `feature: "keyboard"` and `action: "shortcut_changed"` when a shortcut is saved, and `action: "quick_slot_used"` when a Quick slot runs, each `outcome: "completed"` and deduplicated to one per installation per UTC day (at most 2 a day, inside the existing `ade_feature_used` limits; no ceiling raised). Never the keys, the action, the slot or the chat. The bonus Worker (`apps/account-directory/src/jevBonus.ts`) logs one `jev_bonus_request` line per call: status, reason, TypeSafe's status, token counts and duration, never the question or the answer. Failures that are ADE's to fix (`not_configured`, `upstream_key_refused`, `upstream_spend_cap`, `upstream_rate_limited`, `upstream_failed`, `upstream_unreachable`, `upstream_body_failed`, `budget_unavailable`, `global_cap`) are also a Sentry issue each, fingerprinted by reason and capped per hour by `admitEvent`.

### Provider accounts, credentials, presets, proxy, and chat decisions

Provider-account mutations are captured at the `provider_instances` action
domain in `apps/desktop/src/main/services/adeActions/registry.ts`, after the
machine-local registry write succeeds. `create`, `remove`, `signOut`, and
`setDefault` use `provider_accounts` with `account_created`, `account_removed`,
`account_signed_out`, or `default_selected` and `outcome: "completed"` (a
sign-out is captured after the provider CLI's logout succeeds; a Remove of a
signed-in account records both, at most a handful per cleanup). The two settings carried by
`setSettings` are split into `balance_changed` and `auto_start_changed`, with
`outcome: "enabled"` or `"disabled"`. A Claude account's subagent prompt cache
choice, also carried by `setSettings`, is `subagent_cache_changed`: `enabled`
for 1 hour, `disabled` for the Claude default. The main-conversation choice is
`main_cache_changed`: `enabled` for a stated lifetime, `disabled` for
Automatic. A Claude account's extra usage
choice, on the same call, is `extra_usage_stop_changed`: `enabled` for "Stop
the turn", `disabled` for "Continue". Each of the three adds two one-hour-key
slots (48 a day at most) under the same ceilings. Both boundaries that accept
`setSettings` report through `captureProviderAccountSettingsChange`. The only other property is the Claude or
Codex family. A per-action/per-outcome/per-family key with a one-hour minimum
interval admits at most 336 events in a theoretical two-provider day before
the event budget applies; the event-level `ade_feature_used` ceiling accepts
at most 140 per UTC day and 30 per minute (and the shared ceiling remains
200).
No account id, label, config-home path, email, plan, or refresh/list activity is
captured.
The phone and the hosted web client reach the same domain through the
`providerAccounts.*` sync commands, so their mutations are captured by the same
code with the same keys and limits. The command layer cannot tell a phone from
a browser, so those events carry `surface: "api"`, like the CLI action.

API-credential store and remove mutations are captured in
`apps/desktop/src/main/services/ai/apiKeyStore.ts`, after the multi-credential
write or removal completes. They use `api_credentials` with
`credential_stored`/`credential_removed`, `outcome: "completed"`, and the
coarse provider family. The provider value is mapped before it reaches the
payload, so arbitrary gateway/provider names become `other`; two actions across
the eleven closed provider families produce at most 528 one-hour-key slots per
day before the event budget applies. The event-level 140-per-day /
30-per-minute `ade_feature_used` ceilings are the hard accepted bound, and the
shared daily budget remains 200. Legacy secret hydration, credential reads,
readiness probes, masked summaries, and the secret/key material itself remain
untracked.

Custom-preset create/delete changes are observed at the main-process
`accountSettingsSync` write callback in `apps/desktop/src/main/services/ipc/registerIpc.ts`,
after the account-settings action is confirmed. The callback diffs the
normalized local list only to identify additions/removals; it sends
`presets` with `preset_created` or `preset_deleted`, `outcome: "completed"`,
and the coarse harness/provider family. Updates with the same preset id do not
look like creates or deletes. Two actions across the eleven closed provider
families produce at most 528 one-hour-key slots per day; the event-level
`ade_feature_used` 140-per-day / 30-per-minute limits are the hard accepted
bound and the shared 200-event ceiling is unchanged. Preset ids, names, logo
data, model ids, credential ids, labels, paths, URLs, and account-setting
contents never enter the event. Account-settings list/sync reads and launch
resolution are not analytics.

Muse Code joins the same closed provider taxonomy. Its chats and daily-usage
summaries report the coarse `provider` and `model_family` value `muse`, added to
both allowlists so the provider- and model-family-adoption breakdowns separate
Muse from `other` with no new event name and no raised ceiling. Muse's own
account connection is untracked, like the credential reads and readiness probes
above, because Muse keeps its credential in its own config file rather than the
multi-credential store. Its Settings mutations — plugin install, marketplace
add/update/remove, skill activation and import, computer-use settings, and
feedback — are device-local configuration: the plugin, marketplace and skill
names and the free-text feedback note are user content that cannot cross the
analytics boundary, so none of them sends an event.

Proxy sign-in, start, and stop are captured by the durable service in
`apps/ade-cli/src/services/proxy/proxyService.ts`. A transition to running
emits `proxy/start` with `outcome: "completed"`; a successful stop emits
`proxy/stop` with the same outcome; a successful provider sign-in emits
`proxy/sign_in` with `outcome: "success"` and the Claude/Codex family. The
service emits only after the supervisor or auth-file mutation succeeds, and
never includes authorization URLs, login ids, prefixes, emails, plans,
management keys, or error text. A one-hour action/outcome/family key limits
the transition facts to at most 96 accepted events per theoretical two-provider
day before the existing `ade_feature_used` and shared ceilings; the hard
event-level bound remains 140 per day and 30 per minute. Proxy status,
login polling, health probes, and subscription launch reads stay untracked.
Lending this machine's logins to the proxy (`borrowedLogins.ts`: each lend
pass, each renewal through a provider's own CLI, the model-list cache) is
background work on a timer and stays untracked too; its failures go to Sentry
under one fingerprint each (`proxy.borrow_sync`, `proxy.borrow_list_accounts`,
`proxy.borrow_models_cache`, and `proxy.launch_start` when a launch could not
start the proxy), with the stage as a tag and never a token, path or account.

Reset-credit consume outcomes are captured in
`apps/desktop/src/main/services/usage/usageTrackingService.ts` after the
consume result is known, including invalid/missing-account failures. The event
is `usage/reset_credit_consumed`, carries the Claude/Codex provider family of
the account whose credit was spent (omitted when the caller named no account),
and maps the service statuses to `completed`, `nothing_to_reset`, `no_credit`,
`already_redeemed`, or `failed`. One key per outcome with a one-hour minimum
interval admits at most 120 events per day before the existing event-level
`ade_feature_used` 140-per-day / 30-per-minute ceilings; no polling, quota
snapshot read, probe, or account id is included. Analytics failures are
swallowed and never change the reset result.

When a user dismisses a dismissible async question, the chat service emits
`chat/pending_input_dismissed` with `outcome: "completed"` after the durable
receipt is written. The provider is reduced to the existing coarse family;
the pending item id, question text, answers, turn id, session id, transcript,
and notice copy remain local. The one-hour action/outcome/family key and the
eleven closed provider families allow at most 264 one-hour-key slots per day
before budgets. The event-level `ade_feature_used` 140-per-day /
30-per-minute limits are the hard accepted bound, and the shared daily budget
remains 200. Approval responses, pending input reads, and provider runtime
polling do not emit this fact.

When a user moves a chat to another Claude or Codex account
(`chat.switchAccount`), the chat service emits `chat/account_switched` with
`outcome: "completed"` after the thread copy and the account change succeed,
through its `onAccountSwitched` hook. It carries only the Claude/Codex family:
never the account ids, labels, emails, config-home paths, or the session. A
refused switch (a turn running, a signed-out account) emits nothing. The
one-hour action/outcome/family key admits at most 2 × 24 = 48 events per day
before the existing `ade_feature_used` 140-per-day / 30-per-minute limits and
the shared 200-event ceiling; no ceiling was raised.

A chat started in a new lane (the brain-owned launch in
`chatLaunchService`) records `chat/new_lane_launch` once per outcome per
launch, captured at the brain (surface `api`) through the service's outcome
hook: `completed` when the agent started, `cancelled` when the user deleted the
launch during setup, `failed` when a setup stage failed. Checkout progress,
stage transitions, retries, queued messages, and lane naming emit nothing; the
lane name, branch, base ref, template, prompt, and launch id stay local. The
one-hour action/outcome/family key admits at most 3 outcomes × 11 families ×
24 = 792 key slots per day before budgets; the event-level `ade_feature_used`
140-per-day / 30-per-minute limits remain the hard bound, and no ceiling was
raised.

The external sessions service (`externalSessions/externalSessionsService.ts`)
records one `work/session_<continue|copy>_<chat|cli>` per import attempt that
passed its argument checks, through its `onImportOutcome` hook: `desktop` from
the desktop main process, `api` from the brain (which also serves the phone). It carries no session id, title, folder, lane, or model. Imports are
user-initiated and rare; the hourly per-key deduplication bounds the worst case
to 4 actions × 2 outcomes × the provider families per hour, well inside the
existing `ade_feature_used` daily and per-minute limits, so no ceiling changes.

The two Claude session-capability facts are siblings on the same
`ade_feature_used` event with `feature: "chat"`, `outcome: "failed"`,
`provider: "claude"`, and `source: "runtime"`: `action: "hooks_ignored"` when
another client already configured the joined session, and
`action: "plugins_ignored"` when the CLI reports it did not apply every plugin
the query carried — the plugins are ADE's agent-skill roots, so the session
silently lacks them. Both are captured at the initialization-result owner
boundary, once per session per hour via a `chat_<action>:<session>`
deduplication key that the service salts and hashes locally. Neither carries
hook or plugin names, paths, counts, or any command or turn detail. Worst case
is two accepted events per session per hour, inside the existing
`ade_feature_used` limits and the shared 200-event ceiling; no ceiling was
raised. The local `agent_chat.claude_hooks_ignored` and
`agent_chat.claude_plugins_ignored` warn lines are the operational half. The
dashboard spec is deliberately untouched: no card asks this question yet.

Settings → Background service → "Stop and quit ADE" records the same
`ade_feature_used` event in the main process, where the stop is decided
(`services/runtime/backgroundServiceControls.ts`), with `feature:
"connections"`, `action: "background_service_stop"`, and a coarse `outcome`:
`completed` (the login service was removed and ADE is quitting), `rejected` (a
guard refused: ADE could not read what is running, an agent started after the
confirmation, a lane delete or a repair is running, or ADE is already quitting),
or `failed` (the service manager could not remove it). The product question is
whether people turn the always-on service off at all, and whether the guards get
in their way. It carries no chat titles, project names, counts, or error text.
A per-outcome one-hour deduplication key bounds a retry loop to at most 24
accepted events per outcome (72 total) per installation per UTC day, inside the
existing `ade_feature_used` limits; no ceiling was raised. The quit prompt itself
is not tracked: its answer is an app-lifecycle moment, not a product decision,
and the Repair it offers is already counted as `brain_repair` through the shared
`restartBrainForRepair` helper. The dashboard spec is untouched.

These facts intentionally remain out of `scripts/posthog/dashboard-spec.mjs`:
there is no concrete dashboard question or card for them yet. The existing
surface/feature volume views continue to include the shared event without a
dashboard contract change.

An issue made in ADE's create composer records the existing `ade_feature_used`
event with `feature: "issues"`, `action: "issue_created"`,
`source: "renderer_route"`, and the tracker on a closed `outcome`:
`tracker_linear`, `tracker_github` or `tracker_jira`. It is captured in
`IssueCreateDialog.tsx` only after the tracker accepted the issue; an issue an
agent makes through `ade linear create`, `ade github issue create` or
`ade jira create` is not
counted, because the question is whether people file issues from ADE's own
form. Nothing about the issue crosses: no repository, team, title, labels,
number or id. A per-tracker one-minute deduplication key folds a "Create more"
burst into one event, so the worst case is three events a minute, inside the
existing `ade_feature_used` 140-per-day / 30-per-minute limits; no ceiling was
raised and no dashboard card asks this yet.

Which tool an installation opens in the Work tools pane records the existing
`ade_feature_used` event at the pane's single writer (`useWorkSidebarTool`'s
`setTool`, which every entry point funnels through — a picker card, the command
palette, and the reveal channel a dev-server chip uses) with `feature: "work"`,
`action: "tool_opened"`, `source: "renderer_route"`, and the tool id on a
closed, prefixed `outcome`: `tool_terminal`, `tool_git`, `tool_files`,
`tool_ios`, `tool_android`, `tool_app_control`, `tool_browser`, `tool_pr`,
`tool_mac_desktop`, `tool_windows_desktop`, `tool_side_chat`, or `tool_issues`. It is emitted from
the renderer because tool selection has no durable backend mutation — the
runtime publish that mirrors it to iOS and the hosted web client is a
device-mirror push, not a record of the choice.

The product question is only which Work tool an installation actually
uses; `ade_screen_viewed` `work` says the surface was reached and cannot tell a
Browser install from a Git one. Nothing finer crosses the boundary: no lane,
project, tab, URL, session, ordering, or dwell time — a tool id says what was
used, and any of those would say what was being worked on. Returning to the
picker deliberately emits nothing: a null tool is not a tool, and counting it
would double every open/close pair and report closing as engagement. A seventh
tool id is dropped rather than widening the allowlist, so a new tool has to be
registered in the policy deliberately.

The dev home's adoption is three coarse facts on the same `ade_feature_used`
event with `feature: "home"`. Which machine-level top tab an installation opens
records `tab_opened` with `tab_browser` or `tab_music`, from the renderer's one
writer of the tab strip (`setBrowserTabOpen` / `setMusicTabOpen` in
`appStore.ts`) and only when a tab joins the strip, not on every visit. Which
widget a person adds to the home page records `widget_added` with a prefixed,
closed `widget_<type>` outcome, from the layout store's `add`. Both are emitted
from the renderer (`renderer/components/home/homeAnalytics.ts`) for the same
reason `tool_opened` is: neither choice has a durable backend mutation. How
connecting Apple Music ended records `music_connected` (`completed`,
`cancelled`, `failed`) at the main-process owner, the Music IPC `connect`
handler (`registerMusicIpc.ts`), through `captureFeatureUsedAnalytics`. The
product question is only whether the dev home is used and which of it, so
nothing finer crosses: no URL, tab, song, layout, preset name, widget setting,
Apple account, storefront, or token. A new widget type has to be added to the
outcome allowlist deliberately; a test adds every catalog widget and runs its
payload through the sanitizer. Per-value 24-hour deduplication keys
(`home_tab_opened:<tab>`, `home_widget_added:<widget>`) bound the renderer facts
to at most 15 accepted events per installation per UTC day, and the one-hour
per-outcome key on `music_connected` bounds a retry loop to 24 per outcome — all
inside the existing `ade_feature_used` 140-per-day / 30-per-minute limits and
the shared 200-event ceiling. No ceiling was raised, and the dashboard spec is
deliberately untouched: no card asks this yet. Widget use after it is added
(renders, polling, clipboard reads, weather and machine reads, playback
commands) stays untracked by the high-frequency rule.

Opening find (⌘F) in a chat or a diff, and the ⌘K "Find … in this chat" hand-off,
records the existing `ade_feature_used` event with `feature: "find"`,
`action: "find_opened"`, `source: "renderer_route"`, and a closed `outcome` that
says where the bar opened: `chat_shortcut` (⌘F opened a chat's bar),
`chat_palette` (the ⌘K "Find … in this chat" row), `chat_palette_hit` (a chat
opened from a ⌘K message hit, taking the words the palette handed off), or
`diff_shortcut` (⌘F opened a diff's bar). It is emitted from the renderer
(`renderer/lib/findAnalytics.ts`) for the same reason `tool_opened` is: opening a
find bar has no durable backend mutation, because the bar, its query and its
matches live in one window. The shortcut outcomes are captured where ⌘F claims
the bar (`useFindSession`), and only when the claim opens it, not when ⌘F lands on
a bar that is already open. The palette outcome is captured in the chat's
palette target, and the hand-off outcome when the chat takes the words left for
it, so a hand-off that expires unpicked emits nothing. The product question is
whether installations use find at all, on which surface, and whether the palette
hand-off gets used: `chat_palette_hit` set against `chat_palette` says whether
the palette's words are carried on. Nothing finer crosses the boundary: no query
or words, no chat or diff, no file, lane, or match count, no selected match, and
no scroll position. Typing, stepping through matches, closing the bar, and
Escape are high-frequency and stay untracked. A per-outcome `find_opened:<outcome>`
deduplication key with a 24-hour minimum interval (hashed locally, never sent)
means each outcome counts at most once per installation per UTC day, so the worst
case is four accepted events per installation per day, inside the existing
`ade_feature_used` 140-per-day / 30-per-minute limits and the shared 200-event
ceiling. No ceiling was raised. The dashboard spec is deliberately untouched: no
card asks this yet.

A chat's sign-in card (a provider signed out on the chat's machine) records
the existing `ade_feature_used` event with `feature: "chat"`,
`action: "provider_sign_in"` and `source: "renderer_route"`, once per attempt
when it ends: `outcome: "completed"` once the machine reads the login back,
`cancelled` for Cancel or a card closed mid-sign-in, and `failed` when the
sign-in could not start or finish. `provider` is the coarse family (`claude`,
`codex`, `cursor`, `droid`, `muse`; Copilot, Grok, Kimi, Devin and Antigravity
report `other`). It is emitted from the renderer (`ProviderSignInCard.tsx`)
because the host's sign-in runners also serve Settings, so only the card knows
a chat asked. Polls, codes, links, the account, the machine and the chat never
cross. Worst case is one per sign-in a person starts; a per-outcome
`chat_provider_sign_in_<outcome>` key with a 10-minute minimum interval counts
repeated tries once, inside the existing `ade_feature_used` limits, and no
ceiling was raised. The dashboard spec is untouched. The phone's card records nothing; its 7-feature-event daily budget is
kept for the surfaces it already counts.

Running a shell code block from a chat reply records the existing
`ade_feature_used` event with `feature: "chat"` and `source: "renderer_route"`:
`action: "code_block_run"`, `outcome: "started"` once the confirmed run's
terminal exists, and `action: "code_block_output_sent"`,
`outcome: "completed"` once "Send output to the agent" delivered the message.
It is emitted from the renderer (`ChatCodeBlockRun.tsx`) because a run has no
backend mutation of its own: on the desktop it is an ordinary terminal create,
and the hosted client's `work.runShellBlock` is deliberately not in the usage
ledger, so each run is counted once whatever the client. The product question
is whether people run blocks from chat and close the loop by sending the
output. Nothing finer crosses: no command, language, output, exit code, chat,
lane, folder, or machine. A cancelled confirm, a disabled button, and a failed
start emit nothing. A per-action `chat_<action>` key with a 24-hour minimum
interval bounds this to two accepted events per installation per UTC day,
inside the existing `ade_feature_used` 140-per-day / 30-per-minute limits and
the shared 200-event ceiling; no ceiling was raised. The dashboard spec is
deliberately untouched: no card asks this yet.

Which live view an installation watches an iOS simulator through records the
same `ade_feature_used` event from the drawer's single start path, with
`feature: "work"`, `action: "ios_live_view"`, `source: "renderer_route"`, and a
closed, prefixed `outcome`: `backend_window` or `backend_host_encoded`. It is
emitted from the renderer for the same reason `tool_opened` is — the backend
choice starts an ephemeral stream, not a durable record.

The product question is whether anyone drives a simulator that is not on this
Mac. `tool_ios` says the pane was opened and cannot tell those two installs
apart, and that difference is the whole reason the host-encoded backend exists.
Nothing finer crosses the boundary: no device, lane, machine name, stream
address, token, codec, resolution, frame rate, or duration — a backend id says
how the pixels arrived, and any of those would say what was being worked on. A
third backend id is dropped rather than widening the allowlist. A per-backend
`work_ios_live_view:<backend>` key with the same 24-hour minimum interval bounds
this to at most two accepted events per installation per UTC day, inside the
same limits, and no ceiling was raised.

Whether an installation uses its lane's Mac or Windows Desktop records the same
`ade_feature_used` event at the brain-side service
(`createMacDesktopService`, through an injected emitter — the service never
reaches the analytics service or an id itself) with `feature: "work"`,
`action: "mac_desktop"`, and a closed `outcome`: `started` (a display was
created), `agent_drove` (an acting command succeeded for a caller that is not
a human takeover — the action bus strips the controller id from every
agent-shaped caller, and a takeover always carries one), or `recorded` (a
recording was filed as proof). A display that was already up, a refused
action, a person's pointer, and a scratch recording that was not filed emit
nothing.

Windows shares this frozen `mac_desktop` taxonomy and the same service emitter.
Linux Desktop is the same pane and the same service on a Linux seat (its lane's
own X display), so its starts, agent drives and recordings are the same three
outcomes too. The closed Work-tool outcome list also includes
`tool_windows_desktop`, so opening the Windows pane is retained through
sanitization; a Linux host's pane is the `mac-desktop` tool and reports
`tool_mac_desktop`. Password entry, credential contents, and native-dialog
interactions are never product events. `ade screen setup` (Windows admin step
or Linux package install) emits nothing: the outcome a person acts on is the
pane's use and the recording, and a setup that changes this machine is a
mutation with no product question attached.

The product question is only whether the lane screen is used at all, and
whether agents drive it or file it. Nothing finer crosses the boundary: no
lane, chat, app name, path, window title, or error text. A per-outcome
`work_mac_desktop:<outcome>` key with a 24-hour minimum interval bounds this
to at most three accepted events per installation per UTC day, inside the
existing `ade_feature_used` 140-per-day / 30-per-minute limits and the shared
200-event ceiling; no ceiling was raised. The dashboard spec is deliberately
untouched: no card asks this yet.

Whether the Apple panel's runtime manager and iPhone Duo surface are used
records the same `ade_feature_used` event at the simulator service (the brain
or the desktop main process that owns the device, through an injected
`captureAnalytics` — the service never reaches the analytics service or an id
itself) with `feature: "work"`, `action: "apple_device"`, and a closed
`outcome` from `APPLE_DEVICE_ANALYTICS_OUTCOMES`: `runtime_installed` (an
`xcodebuild -downloadPlatform` finished), `runtime_removed` (a remove or prune
deleted at least one runtime), `duo_folded` (a fold the simulator applied),
`duo_app_store_shots` (the App Store Duo set was taken), `device_rendered` (a
3D render was filed as proof), `duo_skill_added` (Apple's
`app-resizability` skill was copied into a lane), `device_leased` (an
agent took a turn on a lane's device with `ade apple lease`; a renewal or a
busy answer is not one), or `extra_device_created` (a lane added a second
device beside its own with `ade apple device-create --extra`). A failed, refused or
no-op call emits nothing. Nothing finer crosses the boundary: no runtime or
Xcode version, device, udid, pose, angle, lane, chat, or image. A per-outcome
`work_apple_device:<outcome>` key with a 24-hour minimum interval bounds this
to at most eight accepted events per installation per UTC day, inside the
existing `ade_feature_used` 140-per-day / 30-per-minute limits and the shared
200-event ceiling; no ceiling was raised. A hinge drag sends one fold when it
settles, never per frame. The dashboard spec is untouched: no card asks this
yet.

The Android panel records the same event the same way, at the Android emulator
service in the brain (through an injected `captureAnalytics`), with
`feature: "work"`, `action: "android_device"`, and a closed `outcome` from
`ANDROID_DEVICE_ANALYTICS_OUTCOMES`: `sdk_installed` (the guided SDK install
finished and put at least one part in place), `app_installed` (an APK or a
Gradle build installed on a lane's emulator), `device_rendered` (a 3D render
was filed as proof), `device_leased` (an agent took a new lease with
`ade android lease`; a renewal or a busy answer is not one), `remote_viewed`
(the stream relay started a lane's stream for a phone or a web tab),
`start_forced` (a start past the RAM guard, "Start anyway" or
`ade android start --force`, booted the emulator), `image_installed` (a
system image install from the device picker finished and put the image in
place), `tests_run` (an instrumentation test run ran at least one test,
passed or failed), `device_folded` (a fold of a foldable AVD that the
emulator settled), `previews_rendered` (a Compose preview render wrote at
least one image), `store_screenshots` (a Play Store screenshot set was
taken: the cover and inner screens of a foldable, else one screen),
`emulator_auto_stopped` (ADE stopped an emulator by itself: nobody used it
for the one Android idle limit, or the brain that started it was gone and no
brain adopted it), `device_booted` (a start booted the lane's emulator), `boot_failed` (a start
did not boot it: a timeout, an exit, or an adb refusal), `adb_restarted`
(the adb server refused the device as `unauthorized`, and ADE restarted the
server so the boot could go on), `extra_device_created` (a lane made an extra
device beside its own with `ade android device-create --extra`, Apple's
spelling), or `device_promoted` (one of a lane's extra devices became its
device, from `ade android device-promote` or the picker; a promote of the
device the lane already holds is not one). A boot of an extra device counts
under `device_booted` and `boot_failed` as the lane device's does. Apart from
`boot_failed`, a failed, refused or no-op call emits nothing; the guard's own
refusal is not an event (it is the `android.start_low_memory` log line, with
the reason and the numbers), and a promote refused as busy is not one either.
A boot that fails with an unexpected code is one Sentry issue per code
(`["android", "boot_failed", <code>]`; tags `area`, `code`, and `extra` for
an extra device). The brain reports it only for an agent's call over RPC (one
that names its chat: a start, or a create, attach or install that boots); the
desktop's IPC capture (`main/sentry/ipcCapture.ts`) reports the desktop's own
calls once, since no "already reported" mark crosses the runtime boundary. A
boot from a person's own terminal is no Sentry issue; `boot_failed` and the
`android.emulator_start_failed` line still count it. `ANDROID_ADB_UNAUTHORIZED` is an expected
(`environment`) answer and never an issue. `android.adb_devices_failed`
(warn, once per boot, with the AVD name and the error) says that `adb devices`
did not answer during a boot wait; the refusal clock does not move on such a
read.
Android has one idle policy: the brain's machine-wide sweep
(`androidEmulatorSweep.ts`) stops an unpinned emulator ADE started that
nothing used for `ADE_ANDROID_IDLE_POWER_OFF_MINUTES` (or its other name
`ADE_ANDROID_IDLE_STOP_MINUTES`; 20 minutes by default, 0 turns it off). Use
is any lane call but the status reads, a stream someone holds, a recording, a
lease, and, checked just before the stop, input on the device itself or
another scrcpy viewer (`android.idle_stop_skipped`, with `device_input` or
`other_viewer`, and `extra` for one of a lane's extra devices, whose own boot
or install also counts as use). The cleanup pass (`androidLaneMaintenance.ts`) runs no idle
timer of its own; it records the stop for the lane's status (`poweredOff`).
Every emulator stop also writes the operational log line
`android.emulator_stopped` with its reason (`user`, `released`,
`lane_released`, `idle`, `owner_gone`, `orphan`, `cleanup`,
`project_closed`) and the AVD name; that stays in the local log and Sentry
Logs, never PostHog. An owner record that could not be written
(`android.owner_record_failed`, warn, with the AVD name) leaves that emulator
outside the idle stop and cleanup. Nothing
finer crosses: no SDK path, AVD, package, APK, angle, lane, chat, machine,
memory size, image, test class, test count, module, or preview name. A hinge
drag sends one fold when it is released, never per frame. A per-outcome
`work_android_device:<outcome>` key with a 24-hour minimum interval bounds this
to at most seventeen accepted events per installation per UTC day (one per
outcome), inside the same `ade_feature_used` limits; no ceiling was raised. The dashboard spec is
untouched.

Whether agents use the user's own browser records the same `ade_feature_used`
event once per successful `ade browser attach`, at the brain-side attach
service (`createUserBrowserAttachService`, through an injected
`captureAttached` callback — the service never reaches the analytics service
or an id itself), with `feature: "work"`, `action: "user_browser"`, and
`outcome: "started"`. A refused or cancelled attach, a detach, and every page
action in the attached tab emit nothing: those are high-frequency or say
nothing about adoption.

The product question is only whether anyone lets agents into their own
browser. Nothing finer crosses the boundary: no browser, machine name, tab,
title, URL, or chat. A single `work_user_browser:started` key with a 24-hour
minimum interval bounds this to at most one accepted event per installation
per UTC day, inside the existing `ade_feature_used` 140-per-day / 30-per-minute
limits and the shared 200-event ceiling; no ceiling was raised. The dashboard
spec is deliberately untouched: no card asks this yet.

The transcript's computer-use action rows are render-only and emit nothing:
they describe tool calls an agent already made, and counting them would
report agent activity as user engagement.

The Work tab's Focus view (busy lanes folded) and its Focus grid (every
waiting chat side by side) report adoption on the same event, emitted by the two
setters every entry point goes through (`setWorkFoldBusyLanes`,
`setWorkFocusGrid` in `useWorkSessions.ts`) and only when a mode turns on:
`feature: "work"`, `action: "focus_mode"`, `outcome` `mode_focus` or
`mode_focus_grid`, and `source: "renderer_route"`. Nothing finer crosses the
boundary: no lane, chat, waiting count, page, or layout. Turning a mode off,
paging, and roster clicks stay untracked by the high-frequency rule. A per-mode
`work_focus_mode:<mode>` key with a 24-hour minimum interval bounds this to at
most two accepted events per installation per UTC day, inside the existing
`ade_feature_used` 140-per-day / 30-per-minute limits and the shared 200-event
ceiling; no ceiling was raised. The dashboard spec is deliberately untouched:
no card asks this yet.

A per-tool `work_tool_opened:<id>` deduplication key with a 24-hour minimum
interval bounds this to at most six accepted events per installation per UTC
day no matter how often the user flips between panes, which is well inside the
existing `ade_feature_used` 140-per-day / 30-per-minute limits and the shared
200-event ceiling; no ceiling was raised. The rest of the pane stays untracked
by the high-frequency rule: browser navigation, find, zoom, device emulation,
tab switching, tab opening and closing, clearing the browser's recently-used
list, preview-stream frames, the App Control screencast and its agent
actions, dev-server discovery polls, and every read the read-only iOS/web mirror
performs. The dashboard spec is deliberately untouched: no card asks this yet.

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

When a project's ADE data went missing or was swapped, the project recovery
screen's choices record the existing `ade_feature_used` event at the IPC owner
boundary (`registerIpc.ts`, where the outcome is known) with
`feature: "storage_doctor"`, `action: "project_data_restore"` (Restore from
Trash) or `action: "project_data_start_fresh"` (Start fresh and Use this copy,
which are the same operation), and `outcome: "completed" | "failed"`. They
answer how often project data goes missing and which way people recover. They
carry no path, project identity, Trash location or error text. A per-action,
per-outcome one-hour deduplication key bounds a retry loop to 24 accepted
events per key, 96 across the four, per installation per UTC day, inside the
existing `ade_feature_used` 140-per-day / 30-per-minute limits; no ceiling was
raised. Moving a project (Settings → Location) records the
same event at the same boundary with `action: "project_move"` and
`outcome: "completed" | "failed"` once a move ran; a move refused before it
began is not counted. The same one-hour key bounds it to 48 accepted events
per installation per day. Pressing a project health fix (Settings → Location
or Lanes) records it too, with `action: "project_health_fix"` and `outcome`
from the fix result (`completed` when every step worked, else `failed`); which
fix ran is not sent. The same key bounds it to 48 accepted events per
installation per day. A fix run on another machine goes through that
machine's runtime, not this IPC handler, and is not counted. The diagnosis itself is not reported: a folder the person moved or
deleted is their action, not a fault in ADE. The dashboard spec is untouched.

Pressing "Report issue" on any of ADE's error surfaces — the project recovery
screen, the renderer and page error boundaries, the project transition alert,
the update banner — sends the redacted report to ADE first, and records the existing
`ade_feature_used` event at the IPC owner boundary where the outcome is known
(the `diagnostics.sendManual` handler, only when it carries a surface context)
with `feature: "connections"`, `action: "issue_report"`, and a coarse `outcome`:
`success` when ADE received the report, `failed` when it did not. Choosing the
secondary **Open GitHub issue** link records the same action from the
`diagnostics.openIssue` handler: `opened` when the prefilled GitHub issue page
was launched, `failed` when it could not be. That is the whole product question
— whether the one control on a broken screen gets the report to us — so nothing
else crosses the boundary: not the surface it was pressed on, not the failure
code or headline that put the screen there, not the report, its upload
reference, the clipboard result, the report file path, or the install id the
report carries. Settings' **Send a report to ADE** (no context) is not counted
here. A per-outcome one-hour deduplication key bounds a click-loop to at most
24 accepted events per outcome — 72 across `success`, `opened` and `failed` —
per installation per UTC day, inside the existing `ade_feature_used`
140-per-day / 30-per-minute limits and the shared 200-event ceiling; no ceiling
was raised. The hosted web client records the same event from its diagnostics
adapter (`renderer/webclient/adapter/diagnostics.ts`, `surface: "web"`, through
the connected machine's `analytics.capture`): `success` or `failed` when its
User Feedback send settled, `opened` or `failed` when the GitHub issue tab
opened or the browser blocked it. It uses the same deduplication keys, which the
host does not scope by surface, so the desktop and the web client on one machine
share the 72-a-day bound.
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
stub body are redacted with the same context. Automatic sending is on by default
and has no Settings control. It stops under `DO_NOT_TRACK=1` or a persisted
explicit off, and its flag is separate from analytics' own opt-out. The manual
"Send a report to ADE" button is always available.

`ade_feature_used` with `feature: "connections"` also carries `action: "remote_connect"` (a dial to another machine failed, or came back after failing) and `action: "work_first_load"` (a Work list's first load kept failing, or loaded after retrying), each with `outcome` `failed` or `completed`, deduplicated per outcome per hour and carrying nothing else. The cause is in Sentry.

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
acknowledgements, iOS widget updates, pairing-grant mint and redeem,
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

Making a cloud box for the CLI or an agent (`ade cloud create`, over the
desktop bridge) records `feature: "connections"`, `action:
"cloud_machine_create"` once per finished create, in the desktop handler that
runs it (`registerCloudIpc.ts`, where the outcome is known): `completed` (the box joined the account), `partial` (signed
in, still starting), `cancelled`, or `failed`. The product question is whether
installations make ADE Cloud machines from ADE at all and how often a create
fails. No box id, name, size, price, or error travels; those stay in
the local `cloud.*` log lines. A box takes minutes and costs money, so a
six-hour deduplication key per outcome bounds it to 16 accepted events per
installation per UTC day, inside the existing `ade_feature_used` ceilings.
The startup cleanup of half-made boxes is not analytics: it runs without a
person deciding anything.

The box actions on an ADE Cloud card record `feature: "connections"`, `action:
"cloud_machine_action"` when ADE Cloud confirms the action, in the same IPC
handler (`registerCloudIpc.ts`). The outcome is the action, prefixed:
`box_sleep`, `box_wake`, `box_resize`, `box_backup`, `box_delete`,
`box_copy` / `box_move` when a copy or move finishes, `box_reconnect` when
Reconnect to ADE brings a removed box back, or `box_push_all_work` when Push
all work to GitHub finished. The product question is which parts of the box lifecycle
people run from ADE. A
refusal (limit, no access) is not an event; it stays in the local
`cloud.machine_action_failed` log line. Remove from ADE is already
`machine_removed`. A six-hour key per outcome bounds this to 36 accepted events
per installation per UTC day, inside the existing `ade_feature_used` ceilings.
The machine list's reads (open, focus, the short settling poll) are not
analytics, and neither is sleeping on its own, waking for use, the hours
readout, or the `ade cloud` commands an agent runs: those run without a person
deciding anything, or are a setting.

The plan records `feature: "connections"`, `action: "cloud_plan"` in the same
handler: `plan_checkout` and `plan_portal` when the Stripe page opens,
`extra_on` / `extra_off` when the extra-hours switch moves. The question is
whether people buy from ADE and use extra hours. No amount, plan id or Stripe
identifier travels. A six-hour key per outcome bounds it to 16 accepted events
per installation per UTC day, inside the existing `ade_feature_used` ceilings.

ADE Cloud lanes record `feature: "connections"` with one coarse outcome
(`cloudLaneAnalytics.ts`). `cloud_lane_launch`: how a new lane on its
own computer ends, `completed`, `failed` or `cancelled`, counted once per end
when the launch host (the desktop's `registerCloudLaneLaunchIpc.ts`, surface
`desktop`, or the brain's `cloudLaneLaunchBrainHost.ts`, surface `api`) saw it
move there; a Retry that fixes a failure counts the failure, then the
completion. `cloud_lane_freed`: Keep the lane and free its computer from the
desktop, `completed` or `failed`. `cloud_clear_caches`: the computer's own
brain clears its caches, `completed`, `failed`, or `denied` (an agent's ask
declined or unanswered). `cloud_default_size`: the person picked another size
for new lanes, `size_small` to `size_xlarge` (a value another computer synced
is not counted again). No lane, project, computer, branch, prompt, size of a
computer or error travels. Each is a person's decision or a launch that makes
a computer, so the existing `ade_feature_used` ceilings bound them; there is
no dedupe key.

Sign-ins for cloud machines record `feature: "connections"`, `action:
"cloud_sign_in"` in the brain, when a sign-in is saved
(`cloudSignInActions.ts`, called from `adeActions/registry.ts`). The
outcome is the provider, prefixed: `signin_claude` once Claude Code's token is
kept, or `signin_codex`, `signin_cursor`, `signin_droid`, `signin_grok`,
`signin_copilot`, `signin_devin`, `signin_muse` or `signin_openrouter` when a
key is saved. The product question is which providers people want signed in on
their cloud machines. No key, token, account, link, code or error travels; a
failed or cancelled sign-in is not an event and stays in the local
`cloud.*` log lines. Removing one is not an event. A six-hour key per
provider bounds it to 36 accepted events per installation per UTC day, inside
the existing `ade_feature_used` ceilings. The card's status reads, and the
1.5-second poll while Claude's sign-in runs, are not analytics.

`ade_brain_action_failed` is the one new event. Every brain action the desktop
performs goes through the single `ade.localRuntime.callAction` IPC channel, and
that channel is not a meaningful usage action, so the existing `ade_error`
capture in `registerIpc` has never fired for it — an installation whose brain
rejected every action was silent. The channel is deliberately **not** added to
`MEANINGFUL_ACTIONS`: that set defines the durable `usage_events` mutation
ledger, and joining it would write a mutation row per brain call. Instead the
`callAction` error path emits four properties: `action_domain`, the ADE
action domain, allowlisted against the closed `ADE_ACTION_DOMAIN_NAMES` list in
`services/adeActions/domains.ts` — its own zero-import module, because
`registry.ts` pulls in the whole runtime service graph and the analytics policy
needs only the names, which is why it used to keep a hand-written copy of all
of them; and `error_code`, the structured code from
`codedError`/`Error.code`/the RPC `code:` prefix — the code only, never the
message, never a path, and `ipc_timeout` or `unknown` when there is no code. The code survives the brain's `{ ok: false, error }` reply: the rebuilt error keeps a string code as `.code` and a JSON-RPC number as `.rpcCode` (`runtimeActionReplyError.ts`), which names as `rpc_tool_failed`, `rpc_invalid_params`, `brain_internal_error` and the rest, else `rpc_error`; before, the rebuild kept only the message and almost every failure read as `unknown`. A project database that will not open for a reason no recovery bucket names is `db_open_failed` (was `unknown`), with its SQLite class (`sqlite_cantopen`, `sqlite_notadb`, `eacces`, …, `sqliteErrorClass`) in the brain's `project.db_open_failed` line, in the coded error and in the message the user sees. An uncoded error gets a fixed token from the RPC client's and brain's own wrapper wording first (`rpc_timeout`, `rpc_connection_lost`, `rpc_bad_response`, `rpc_response_too_large`, `rpc_<json-rpc error name>`, `brain_internal_error`, `brain_refused`), else its class name in snake case (`type_error`), never message text (`reliabilityTelemetry.ts`).
Because codes are an open code-authored vocabulary (seeing an unpredicted one is
the point), `error_code` is bounded by shape rather than a literal allowlist: a
lower-case identifier of at most 48 characters, which no path, URL, email,
hostname, or sentence fragment can satisfy. Most brain errors carry no code,
so two more properties say which call failed and how: `brain_action`, the
action's code identifier inside its domain (a lower-case slug of at most 80
characters; it names a registry entry, never anything a person typed), and
`expected_kind`, the brain's expected-failure mark (`user`, `environment`,
`network`), `expected` for an answer that carries no mark but that the Sentry
gate knows by its text or code (`shared/sentry/expectedFailure.ts`), or
`unexpected` for everything else, which is what separates
a bug from a refusal the person caused; `brain_action` names the first
action of that shape in the hour. A per-domain-per-code one-hour
deduplication key (unchanged when these two were added, so counts stay
comparable across builds) turns an error loop into one accepted event an hour, and the
event's own 20-per-day / 3-per-minute caps bound the rest without touching
`ade_error`'s budget.

#### Resource pressure

`ade_resource_pressure` is one fact per resource-pressure episode on a machine
(`ade-cli/src/services/runtime/resourcePressureMonitor.ts`). On 2026-11-06 a
36 GB Mac froze with five Android emulators running and ADE sent nothing; this
is that signal. The machine brain (only the one that serves the machine
endpoint, so one per computer; never a dev brain) samples on the loop
watchdog's existing five-minute tick (`onSampleTick`, `brainLoopWatchdog.ts`):
memory through `readHostMemorySignals` (`machineStats/hostMemorySignals.ts`,
one `sysctl` on macOS, file reads on Linux; on Windows free memory from `os`,
and the PowerShell read of the commit charge only when under 15% is free), the
size of each open database's `-wal` (an async `stat`; `state/dbActivity.ts`
tracks which are open), the writes per table since the last tick (counted in
`kvDb`'s statement wrapper, one map increment per write), and the brain's own
CPU. A breach is: available memory under 10% of RAM or the OS's pressure at
`warn` or `critical` (macOS's kernel verdict, Linux PSI, Windows commit charge
over 90%) — kind `memory`. On macOS a `warn` counts only with under 25% of RAM
available, because the kernel raises it long before memory is short; swap over 85% used (Linux, Windows), or on macOS,
whose swap grows on demand so used-of-total says nothing, more than a third of
RAM swapped — `swap`; a write-ahead log over 2 GB or grown 1 GB in one tick —
`wal`; the brain over 80% of a core for two ticks — `cpu`. Severity is
`critical` for kernel-critical pressure or under 5% available, else `warn`.

The first breach opens ONE episode, which costs one process listing
(`machineStats/processGroups.ts`: one `ps` with command lines, then
`readProcessMemory`'s `footprint` for ADE's, the emulators' and simulators'
processes; one PowerShell CIM read on Windows), grouped into `installed_brain`,
`dev_brain`, `desktop`, `android_emulator`, `ios_simulator` and `other`
(command lines are read only to sort; group names, counts, MB and CPU leave,
never a process name, path or argument). It sends one Sentry Log
`machine.resource_pressure` and one `ade_resource_pressure` with `kind` (the
first of `memory`, `swap`, `wal`, `cpu` that breached), `severity`,
`emulator_count` (`0`, `1`, `2`, `3_4`, `5_plus`), `dev_brain_running`,
`ram_gb_bucket` (`le_8`, `9_16`, `17_32`, `33_64`, `gt_64`), `available_pct`,
`ade_mb` and `ade_pct_of_ram` (the memory of ADE's own processes: the brains
and the desktop app, without emulators and simulators), and, for kind `wal` or
`cpu` only, `top_table` (ADE's own table with the most writes in the five
minutes before; a schema name, never data). The episode closes after 30 minutes without a breach;
only then can another open, and one open when the brain restarts stays open.
`runtime/resource-pressure.json` keeps the open episode, the last sample and
the last five episodes for diagnostic reports. Volume: worst case one event
per kind per six hours (persisted dedupe `resource_pressure:<kind>`), capped at
4 a day and 1 a minute per machine, inside the shared ceiling; the Sentry Log
is one per episode under the 20-per-name-per-hour log cap. Cost per tick,
measured on an M4 Max: 2.4 ms of brain CPU and one 1.2 ms `sysctl` every five
minutes on macOS (none on Linux; none on Windows unless memory is short);
an episode adds about three spawns and 1.3 s of wall time off the loop.

The default machine-wide ceiling is 200 accepted events per UTC day, shared across desktop, runtime, hosted web, and API-originated aggregates. Each event also has a tighter per-day and per-minute ceiling. Capture ingress is capped, noisy events use persisted deduplication windows, the in-memory transport queue is bounded, and the previous day's accepted/drop totals are summarized in at most two budget events per day.

Persisted `usage_events` are the preferred source for meaningful user mutations. The exporter is locally at-most-once and uses a random v4 client UUID as the PostHog insert ID; non-random or malformed client IDs are regenerated at the transport boundary. Screen events are limited to project, Hub, lanes, work, PRs, settings, and onboarding arrivals; utility/detail/loading transitions are skipped. The hosted Hub uses the existing `ade_screen_viewed` event with only `screen: "hub"`, `route_kind: "web"`, and `source: "renderer_route"`. Its two-second per-screen deduplication and the existing 12-per-minute, 80-per-day screen limits bound rapid tab switching without raising the shared 200-event ceiling. Reads, renderer commits, polling, heartbeats, stream chunks, terminal bytes, progress updates, retries, and other high-frequency mechanics must not emit product events.

Pull-request mutations reach analytics through that ledger and nowhere else.
`prs.land`, `prs.close`, `prs.reopen`, `prs.createFromLane`, `prs.updateBranch`,
`prs.retargetBase`, `prs.addComment`, `prs.submitReview`, `prs.rerunChecks`,
`prs.setDraft`, and `prs.setAutoMerge` are recorded at the IPC channel / RPC domain boundary, keyed on the action name
rather than on the presence of a local `pull_requests` row — so removing the
lane-mapping gate widened what an installation can do without needing any new
instrumentation. `prs.cleanupBranch` joined the set for the same reason: while
deleting a merged PR's branch was reachable only from a mapped PR it was a
corner of the product, and it is now an offer on every merged row.
`prs.setChatWatch` (turning PR Watch / Ship on, switching it, or off for a
chat) is in the set too: a deliberate choice, at most a few per PR — a person
in the menu, or an agent arming its own watch through the same action. Which
mode was picked is deliberately not a property — the product question is
adoption, and the ledger row already answers it. The watch's own wakes, holds,
and stops are background mechanics with no person behind them, so they stay in
the local `prs.watch_*` lines and never reach analytics. `chat.restartSession`
(a fresh provider process that keeps the conversation) joined for the same
reason: one row per press.

Chat goals, stop-mode choices, waits, and restart resume add no analytics.
Setting a goal is an ordinary `chat.send` (`/goal …`); a goal ending, a waiter
firing, a chat continuing after a restart, and an agent CLI reopened after a
planned or unclean stop are things the app does with no person behind them
(the CLI reopen writes one local line per start with counts only,
`agent_chat.cli_reopened_after_restart` or `agent_chat.cli_reopen_skipped`); and a Stop press is high-frequency enough that which of
six modes it used would be a typing signal, not a product decision.

Whether a merge also deleted the head branch is deliberately **not** a property.
It is a parameter of `prs.land`, the merge itself is already counted, and there
is no product question attached to the split — adding a coarse value to the
closed `outcome` set to answer nobody widens the dimension for free. Revisit it
when someone asks the question.

Everything else the PRs tab does is a read or a view mechanic — list polling,
snapshot refreshes, the CI graph fetch, tab and drawer toggles, commit-tick
hover, header narrowing, pane resizing, the ⋯ menu and its right-click twin,
the floating dock's bubbles and cards, the push tick rail, and the bot-row
expansion — and stays untracked by the rule above. A ⋯ chat action only puts a
prompt in the composer; the send that may follow is the chat's own event.
The `ade_screen_viewed` `prs` arrival already records that the surface was
opened.

The fresh-install milestone is stored in machine analytics state before enqueue. Activation is stored the same way and derives `time_since_install_seconds` locally. Legacy analytics state is marked as already installed and activated during migration so upgrades never create false funnel entrants. Account identification is pseudonymous and limited to three accepted identity changes per UTC day and two per minute. It still consumes PostHog ingestion quota. Explicit sign-out rotates the anonymous ID so later anonymous activity is not attached to the signed-out account.

Daily usage summaries report coarse totals and only the top coarse provider and model family. They never report provider account IDs, exact model strings, prompt content, or per-session content.

The daily usage research report is a separate sink and is not PostHog. `usageResearchUploader` sends one report for each finished local day to the account directory Worker (`POST /usage-research/daily`), which keeps one row for each install and day in D1. The report holds exact provider and model ids, token sums, list-price and billed costs, plan tier, quota readings, and the local hour of each turn, because routing research needs them. It never holds an email, an account or provider-instance id, a path, a lane, session, or turn id, a prompt, or a hostname. `installId` comes from a per-install salt that never leaves the machine, so it cannot be linked to the PostHog `distinct_id`. `accountRef` is a salted hash from the same salt. The uploader sends only while product analytics is in effect (`getStatus().effective`), checks that again before each POST, and adds no PostHog event. The Worker limits each address to 20 reports a day, the fleet to `USAGE_RESEARCH_DAILY_GLOBAL_LIMIT`, and the table to `USAGE_RESEARCH_STORAGE_CEILING_MB`, and deletes rows after `USAGE_RESEARCH_RETENTION_DAYS`. Details: `docs/features/onboarding-and-settings/usage-tracking.md`.

The storage doctor emits one `ade_feature_used` per completed maintenance run at the daemon boundary (`storageInsightsService`), with `feature: "storage_doctor"`, `action: "maintenance_run"`, a coarse `outcome` (`completed`, `partial`, or `failed`), and the numeric aggregates `bytes_freed` and `files_compressed`. It carries no paths, table names, or per-item detail. A per-project local dedupe key (`storage_doctor_run:<project>`) with a 20 h minimum interval collapses the daily run and any manual "Clean up now" into a single accepted event, so worst-case volume is well under 2 accepted events per project per day — inside the shared 200-event ceiling and the `ade_feature_used` per-day cap. The run also writes the local `storage.maintenance_completed` jsonl line (with `storage.maintenance_step_failed` per failed step); those operational lines are never forwarded to PostHog.

Desktop draft creation records the existing coarse
`ade_feature_used` mutation fact with `feature: "chat"` and
`action: "chat.createDraft"` through the durable `usage_events` ledger.
Arming a scheduled send is a draft creation with a schedule on it, so it is
the same fact, not a second event. The event contains no prompt text,
model/provider value, project path, or draft identifier, and never the
scheduled time or target. Reads, menu opens, list filtering, attaching a
draft into the composer (`chat.claimDraft`), edits (`chat.updateDraft`),
deletes, and a scheduled send firing are not product events: the decision
worth counting is the creation, and the delivery is its consequence.
The existing `ade_feature_used` limits cap this at 30 accepted events per minute
and 140 per UTC day without raising the shared 200-event ceiling.

Composer @-mention expansion records the existing coarse `ade_feature_used`
event at the expansion owner boundary (`chatMentionService` via the
`onChatMentionsExpanded` hook, produced by
`captureChatMentionsExpandedAnalytics`) with `feature: "chat"`,
`action: "mention_expanded"`, `outcome: "completed"`, and `source: "runtime"`.
It fires for chat sends and for text a CLI's input box sends
(`typeIntoAgentCliNow`), only when the text actually gained `<ade-mention>` pointer
blocks — never per keystroke, per suggestion query, or on the idempotent
second expansion pass — and carries no mention targets, titles, previews, or
counts. An installation-wide `chat_mention_expanded` deduplication key with a
one-hour minimum interval bounds it to at most 24 accepted events per UTC day,
inside the existing `ade_feature_used` and shared ceilings. The keystroke-rate
`chat.listMentionSuggestions` read stays untracked by design.

Regenerating a chat's visible metadata records the existing coarse
`ade_feature_used` event at the chat service boundary via
`captureSessionMetadataRegeneratedAnalytics`, with `feature: "chat"`,
`action: "metadata_regenerated"`, `outcome` (`completed`, `partial`, or
`failed`), `mode` (`manual` when a person or an agent asked for it,
`automatic` when ADE refreshed the status line after a turn), and
`source: "runtime"`. It counts results, not menu opens or model attempts. It
is one fact per mode and outcome per installation an hour: the automatic
refresh follows most turns and once took a quarter of a busy install's daily
budget. It carries no generated title, lane name,
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

Lane sharing records the same coarse mutation fact with `feature: "lanes"`,
through the same ledger, at the brain that runs the `lane_share` runtime
action, after the action succeeded (`usageActionFromRpcDomain`):
`lanes.share` (a share made), `lanes.shareEditRights`, `lanes.shareRevoke`,
`lanes.shareLeave` (a guest leaves), `lanes.shareMoveChat` (the owner offers to move a chat to
the other person) and `lanes.shareMoveRespond` (the owner answers a move the
other person offered). Reads, invite re-sends and the transfer steps of a move
record nothing. No email address, name, grant, lane, rights or user id of
either person crosses. These are deliberate decisions, a handful per
installation per day, inside the existing `ade_feature_used` 140-per-day and
30-per-minute limits; no ceiling was raised and no PostHog definition changed.
A guest's accept is recorded only by the account directory, which has no
product-analytics path for it.

The renderer records `template_setup_started` when the setup chat draft opens
(`from_banner` or `from_settings`), `template_suggestion_hidden` when the prompt
is hidden (`completed`), and `deps_update_started` when an install terminal
starts (`completed` or `failed`). They are emitted from
`renderer/lib/laneSetupAnalytics.ts` because the chat draft and terminal start
are renderer decisions with no durable backend mutation. They never carry a
lane, path, lockfile name, package manager, folder count, template id or name,
machine, or error text. A 24-hour per-action-and-outcome key allows at most five
accepted events per installation per UTC day, inside the existing
`ade_feature_used` 140-per-day / 30-per-minute limits; no ceiling was raised.

The same helper records the lane settings a person chose, each only after the
save or rename succeeded: `branch_pattern_changed` (which kind of branch name
pattern: ADE's `ade/` prefix, the git user name, none, or custom; never the
text), `start_default_changed` (the default branch, the primary lane's branch,
or a named branch; never its name), `branch_renamed` from the lane menu,
`auto_archive_changed` / `auto_free_up_changed` / `auto_delete_changed` when a
save in Settings › Storage & cleanup › Rules turns that automatic rule on or off
(never a day count), and `space_freed` for Free up space on an archived lane.
The archive scan's own automatic archive, free up and delete record nothing:
they are a timer with no person's action behind them, like the idle sweep. With
the same 24-hour key the lane helper's worst case is 22 accepted events per
installation per UTC day, inside the existing `ade_feature_used` limits.

The desktop "Star ADE on GitHub" pill records `star_prompt_shown` when it is
on screen, `star_prompt_clicked` when its link opens GitHub,
`star_prompt_dismissed` on `×`, and `repo_starred` when the star check first
finds a star. The outcome says which showing it was: `prompt_first` before any
dismissal, `prompt_second` for the one return 20 sent messages later. They are
emitted from `renderer/lib/starPillActivity.ts` and carry no GitHub account,
message count, or machine. Volume is bounded for the account's lifetime:
`star_prompt_shown` fires once per showing (the synced `shownReported` pref,
so a pill left up never re-sends it), `star_prompt_dismissed` at most twice,
`repo_starred` once, and `star_prompt_clicked` only on a click. A 24-hour
per-action-and-outcome dedupe key is a backstop, inside the same
`ade_feature_used` limits; no ceiling was raised. The **ADE · GitHub star prompt** dashboard in
`scripts/posthog/dashboard-spec.mjs` charts the funnel (shown → clicked →
starred) and splits it by showing.

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

Sending a custom notification — `ade notify`, an agent, or an automation's
**Send notification to mobile app** step — records the same `ade_feature_used`
event at the brain's `attention.sendNotification` / `notify.send` boundary
(`buildSendNotificationAction` in `adeActions/registry.ts`, through
`captureNotificationSentAnalytics`), with `feature: "attention"`,
`action: "notification_sent"`, `surface: "api"`, and a coarse `outcome`:
`completed` (the relay took it for at least one phone and no delivery failed),
`skipped_budget` (the account's hourly cap refused it), or `failed` (no phone on
the account, a delivery failed, or the call failed). Input the caller got wrong
(no title, a link ADE cannot open) and a signed-out machine are refused before
anything is sent and emit nothing. The title, body, link, phone count and the
sending project never cross the boundary. The product question is only whether
people and agents use custom pushes and whether the cap bites. A per-outcome
one-hour deduplication key bounds a looping automation to at most 72 accepted
events per installation per UTC day, inside the existing `ade_feature_used`
140-per-day / 30-per-minute limits and the shared 200-event ceiling; no ceiling
was raised. The dashboard spec is deliberately untouched: no card asks this yet.

`ade notify` run inside a chat takes that chat's own route
(`sendNotifyAsChatMessage` in `apps/ade-cli/src/services/push/chatMessageNotify.ts`)
and records the same event, `feature: "attention"`,
`action: "notification_sent"`, `surface: "api"`, `outcome: "completed"`, once the
message is stored as this machine's Activity message; the phone receives it only
when the machine is signed in to an account. A repeat of the same words inside
the ten-minute window, and the per-chat or per-machine hourly limit, send
nothing and emit nothing. The title, body, chat title, ids and counts never
cross the boundary, and the existing per-outcome deduplication and ceilings
apply unchanged.

### The capture gesture

The capture gesture records one `ade_feature_used` event from the main-process handler that
delivers or refuses the shot, with `feature: "cto"`,
`action: "capture_gesture"`, and one of three coarse outcomes: `delivered`,
`failed`, and `too_large` (a display ADE could not fit into an attachment even
after four halvings — the one failure that is a product fact rather than an
environment one). Never the window, its title, the app it belonged to, the temp
path the PNG passed through, the image, or the helper's error text. A
per-outcome one-minute deduplication key bounds a chord-mashing loop to at most
1,440 accepted events per outcome in theory, and the `ade_feature_used`
30-per-minute and 140-per-day limits bound it in practice; the realistic number
is single digits. No ceiling was raised, and the dashboard spec is deliberately
untouched — no card asks that question yet.

### Native iOS

Native UI analytics lives in `apps/ios/ADE/Services/ProductAnalytics.swift`. It uses a separate installation identity and `ade_mobile_*` event namespace so phone engagement cannot inflate desktop activation or retention. After sign-in, it sends the same one-way account hash used by desktop in a quota-counted `$identify` event; the raw account ID is never sent, and sign-out rotates the anonymous installation identity.

Every native event carries `client: "ios"`, `interactive` (`false` only for `ade_mobile_analytics_budget`), `app_version` (`CFBundleShortVersionString`), `build_number` (`CFBundleVersion`), `distribution` (`testflight`, `app_store`, or `development`, read from the App Store receipt name) and `release_channel` (`beta` in the ADE Beta app, `stable` in the normal app whether it came from TestFlight or the App Store, `development`). There is no `is_internal`: a phone has no team-install marker. The first open of a new install also carries `first_open: true`, once; an install that already has a stored budget from an earlier build reports none. Both are properties of the existing `ade_mobile_app_opened` and add no event.

iOS analytics is default-on when the public capture configuration is present; the former affirmative opt-in, its consent prompt, and its Settings opt-out have been removed. A stored `ade.analytics.enabled` false from an earlier build is ignored; only `DO_NOT_TRACK=1` in the launch environment turns it off. Its restart-safe ceiling remains 20 events per UTC day, with the existing event-specific limits of 3 app opens, 10 screen views, 7 feature events, 2 coarse errors, and 1 budget summary. Sign-in, machine-adoption, pairing, and quick-connect events use separate `ade_mobile_*` names with closed coarse enum properties and a limit of 2 events each. Foreground duplicate screens and outcomes are suppressed. The transport has no retry loop, redirects, cookies, cache, credential storage, background session, or persistent event queue.

Taking Control of a Mac's simulator from the phone records `ade_mobile_feature_used` with `feature: "simulator_control"`, `outcome: "started"` and nothing else: no device, lane, machine, stream or gesture detail. It answers the same question as the desktop's `ios_live_view` (does anyone drive a simulator that is not on this Mac), and the existing per-foreground deduplication and the 7-feature-events-per-day limit bound it; no ceiling was raised. Gestures, frames and the speed readout are never events.

A GitHub connect of the ADE account that the phone started records `ade_mobile_feature_used` with `feature: "github_connect"` and `outcome` `completed` (the server says the sign-in is done), `cancelled` (declined on GitHub) or `failure`. It is the phone's half of the desktop's `connections` / `github_app_connected`: never the GitHub login, the account, the sign-in id or an error. A person connects once, so the per-foreground deduplication and the 7-feature-events-per-day limit bound it; no ceiling was raised. Direct GitHub reads (PR lists, repositories) are never events.

Host-recorded mobile mutations may still appear in the canonical `ade_*` namespace with `surface: mobile`; those events use the machine installation identity and the same shared 200-event budget. Native `ade_mobile_*` events describe only interaction with the phone app itself.

### Public marketing site

The public-site implementation is `apps/web/src/lib/marketingAnalytics.ts` and `marketingAnalyticsBrowser.ts`, mounted by `MarketingAnalyticsBridge.tsx`. It is default-on with a browser-local opt-out (an explicit "false" preference, settable on /privacy) and uses a separate `ade_marketing_*` namespace.

The same preference gates the Freebuff ad pixel (`apps/web/src/lib/freebuffPixel.ts`): it loads only when website analytics is on, and any download or copy-install click reports Freebuff's `installation_completed` goal with no event id, so Freebuff keeps one per ad click. That event means a download intent; the site cannot see an install finish.

Its durable browser-local ceiling is 40 events per UTC day: 1 app open, 12 screen views, 12 conversion CTA clicks, 16 other feature clicks, 3 coarse browser error categories, and 1 budget summary. A CTA click emits only `ade_marketing_cta_clicked`, never a duplicate feature event. Per-screen/per-key caps and deduplication windows are tighter still. If durable storage is unavailable, analytics fails closed so reloads cannot bypass the budget.

Every event also carries the visit's attribution
(`readMarketingLanding`, `marketingCurrentUrl` in `marketingAnalytics.ts`, wired
in `marketingAnalyticsBrowser.ts`): `$current_url` (origin and path, plus only
`utm_*`; other query parameters and the fragment are dropped, since `/pair`
and `/open` links can carry codes), `$host`, `$pathname`, `$referrer` (the
external referrer's origin and path, or `$direct`), `$referring_domain`, and
any `utm_source` / `utm_medium` / `utm_campaign` / `utm_term` / `utm_content`
from the landing URL. The landing is read once per tab session
(sessionStorage), so moving between pages keeps the source the visit arrived
with; a referrer from this site itself counts as `$direct`. The first source
the browser ever arrived from rides along as `first_referring_domain` and
`first_utm_source` / `first_utm_medium` / `first_utm_campaign`
(localStorage, forgotten on opt-out). `$raw_user_agent` (the browser's
user-agent string, at most 512 characters) lets PostHog's traffic
classification (`$virt_is_bot`, `$virt_traffic_type`) separate crawlers, link
scanners and headless browsers from people. These are properties of the existing
events and add none; the site sends no `$pageview`, because
`ade_marketing_screen_viewed` already marks each real page view.

An install cannot be tied to the visit that downloaded it: the installers are
fixed files on GitHub, and the iPhone button opens a TestFlight public link,
which takes no campaign tag. Download clicks carry the visit's source, so
installs are attributed by comparing download clicks per source with
`ade_app_installed` over the same days, not person by person.

The install dialog (the modal behind every Mac/Windows download button and the
Linux brain link) uses the existing taxonomy: opening it records one feature
event per platform (`install_dialog_mac` / `install_dialog_windows` /
`install_dialog_linux`, emitted once from the dialog provider so every trigger
reports identically), copying a command records
`copy_install_command_<platform>` or `copy_brew_command`, and the direct
download buttons record the CTA event with closed labels
(`download_mac_arm64`, `download_mac_x64`, `download_windows_x64`) at position
`install_dialog`. Events carry no installer URL, release tag, or platform
fingerprint beyond the attribution above, and fit inside the unchanged 12-CTA / 16-feature /
40-event public-site ceilings. The `/install.sh`, `/install.ps1`, and
`/download/*` Vercel redirect endpoints are deliberately analytics-free — the
dialog's client-side click is the funnel signal, and a test pins that the
handlers make no analytics call for any method.

The pricing page (`/pricing`, screen `pricing`) reuses the same events: each
plan card's button records the CTA event with `choose_plan_free`,
`choose_plan_plus`, `choose_plan_pro` or `choose_plan_max` at position
`pricing_page` (it opens the install dialog, which records its own feature
event), and every link to the page (site header, home page masthead and
ADE Cloud teaser, footer) records the `view_pricing` feature.

The browser sends events directly to `https://us.i.posthog.com/i/v0/e/`. It does not call a Vercel Function or Edge Function, enable Vercel Web Analytics, create a Vercel log drain, or proxy events through ADE infrastructure. PostHog therefore adds no Vercel compute, function-invocation, log-ingestion, or server-side analytics usage. The site retains only its normal static asset delivery; preview and development deployments intentionally have no PostHog environment variables so internal traffic does not spend quota or skew production data.

## Account settings

Settings in the PostHog and Sentry accounts, not in code; recorded here because they change what is stored. Applied by the lead on 2026-11-06 with the owner's approval.

- **PostHog** project 510983: `anonymize_ips: true`, so PostHog stores no `$ip` for any event, whichever SDK or path sent it (ADE's capture already disables GeoIP per event; this covers the IP itself).
- **Sentry** inbound filter on `ade-desktop` and `ade-brain` (Project Settings › Inbound Filters › Releases): `ade@1.2.10*` and `ade@1.2.11*`, which drops events from releases 1.2.100–1.2.119 before they count against the quota. Those builds have aged out of support and kept spending quota on fixed issues. Raise the filter (add the next `ade@1.2.1N*`) when the next band of old stables ages out; never filter a release a meaningful share of installs still runs (check the release's sessions or PostHog's `app_version` first).

## Diagnostic reports: machine facts

What a diagnostic report (the desktop's Report issue and automatic sends, `ade report-issue`, the brain's automatic sends; `docs/features/storage-and-recovery/README.md`) says about the machine, for triage:

- **Install**: `Channel` (the release channel as Sentry and PostHog name the build; a brain launchd started has no `ADE_PACKAGE_CHANNEL`, so the CLI reads Alpha from its home `~/.ade-alpha` or its service name) and `Packaged` are always printed, `Package` when it differs; `Hardware` (the maker's model from `sysctl hw.model`, `/sys/devices/virtual/dmi/id` or the BIOS `SystemProductName` in the registry, CPU model and count, RAM; the CLI's report leaves the model out); `Machine id` (`machine_id`); `Account hash` (12 hex of the account id, desktop reports; the CLI's leaves it out because reading the session through the account service writes its key file, and its install id is the account hash once signed in anyway); `Machine key fingerprint` (12 hex of a hash of the sync machine key, to match a report to its account-directory row without the key).
- **Machine health** (`ade-cli/src/services/diagnostics/machineHealth.ts`): memory available of total and the OS's pressure, swap, commit charge (Windows), memory stall (Linux PSI), load average, ADE's processes by group with MB and CPU, Android emulators running, the brain's last read of its databases' write-ahead logs, and the last five resource-pressure episodes. The desktop's report reads memory, the load average and the process groups live (a `sysctl`, a `ps` and a `footprint`, or one PowerShell, off the main thread, under the 8 s step deadline); the two CLI builders read only what the brain recorded (its last memory and write-ahead-log sample, and the episodes with their process groups), so their reports stay identical.
- **Last wedge** is titled with its age and left out when older than seven days.
- `launchctl print` is trimmed to the lines that explain a job (program, arguments, environment, log paths, state, pid, runs, last exit); coalitions, jetsam and launchd's bookkeeping go.
- An event that repeats five or more times in one log tail keeps only its newest line, after one line `[×56] cursor.models.sdk_discovery_failed: 55 earlier occurrences in this tail left out`, so the lines it gave up go to other events.
- The upload sends `machineId` beside `installId`, and the account directory stores it as the R2 object's `machineId` metadata (16 hex or nothing), so a report can be found from a Sentry event or a PostHog machine.

## Consent and kill switches

- Product analytics and automatic diagnostic reports are part of ADE and on by default on every surface. No Settings, web, or iOS control turns them on or off, and there is no consent prompt.
- Two opt-outs are honored everywhere, silently: `DO_NOT_TRACK=1` in the environment (desktop and brain: PostHog and automatic diagnostic reports), and a persisted explicit opt-out from an earlier build (the desktop `secrets/product-analytics.json` `enabled: false` or its `.disabled` marker, the automatic-send ledger's `enabled: false`, and the hosted-web `ade:web-product-analytics-enabled` "false" preference). Nothing in the app can change either one. iOS honors only `DO_NOT_TRACK=1`. The note a person types into Send a report follows Sentry's switches: where Sentry is off the field is not shown and nothing is sent.
- The desktop machine-wide disable marker immediately stops all local clients and cancels queued delivery.
- Native iOS honors only `DO_NOT_TRACK=1` and has no in-app control; a stored opt-out from an earlier build is ignored. The public marketing site keeps its own browser-local opt-out on `/privacy`, separate from ADE's product analytics.
- `ADE_DISABLE_PRODUCT_ANALYTICS=1` disables the desktop/runtime service.
- The daily usage research report follows the product analytics state: `DO_NOT_TRACK=1`, a persisted opt-out, the disable marker, and `ADE_DISABLE_PRODUCT_ANALYTICS=1` all stop it. `ADE_USAGE_RESEARCH=0` stops only the report.
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

The full-access personal key belongs only in encrypted ADE secrets. When running the dashboard provisioner, map it to `POSTHOG_PERSONAL_API_KEY` for that process together with `POSTHOG_PROJECT_ID` and `POSTHOG_HOST`. Never put the full-access key in GitHub Actions release secrets, Vercel, an app bundle, an `.env` file, source control, logs, screenshots, test fixtures, or a command argument that may be recorded.

Release workflows use a second personal key of their own, limited to the ADE project and to the scopes `annotation:read`, `annotation:write`, `error_tracking:write` and `organization:read`, stored as the GitHub Actions secrets `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID` and `POSTHOG_HOST` (optional; defaults to `https://us.posthog.com`). It does three things, and each skips with a notice when the secrets are empty and never fails a run:

- **Release annotations** (`scripts/posthog/annotate-release.mjs`): `Desktop 1.2.130-beta.3 · beta` when the beta feed serves a beta (`beta.yml`), `Desktop 1.2.130 · stable` when `/release` publishes a stable (`release-annotation.yml`), `iOS Beta 1.4 (212) · TestFlight` after an ADE Beta upload (`ios-testflight.yml`), and `Web deploy abc1234 (webclient, push-relay)` after a web or Worker deploy (`deploy-web.yml`). Previews are not marked. A re-run finds the identical annotation and adds none.
- **Source maps** (`scripts/posthog/upload-sourcemaps.mjs`), described under [PostHog error tracking](#posthog-error-tracking).
- **iOS dSYMs** (`scripts/release-tools/upload-ios-dsyms.sh`, from `ios-testflight.yml` and `ios-testflight-internal-build-bump-self-hosted.yml`): each archive's dSYMs go to PostHog beside Sentry, so iOS `$exception` frames get function names. PostHog finds them by debug id, so no release is named.

## PostHog dashboards

`scripts/posthog/dashboard-spec.mjs` is the declarative source of truth. `scripts/posthog/provision.mjs` validates and idempotently upserts the managed objects. The spec has eleven managed dashboards and sixty-eight managed insights (the ADE · Triage dashboard is in the spec and is created by the next provisioning run):

- ADE · Growth and retention
- ADE · Surface and feature adoption
- ADE · Native mobile engagement
- ADE · Marketing acquisition
- ADE · Reliability and analytics budget
- ADE · Sign-ups & activation
- ADE · Retention & churn
- ADE · Agent turns (LLM analytics)
- ADE · GitHub star prompt
- ADE · Feedback (in-app survey answers)
- ADE · Triage: machines whose brain failed an action, by `error_code` × `release_channel`; the newest failing `action_domain`/`brain_action` with the build each first failed on (a HogQL table); `$exception` machines by `$exception_fingerprint` × `release_channel`; machines under resource pressure by `kind`; failed agent turns by `$ai_provider` × `error_kind`

Install counts ("active installations", "installs that opened ADE", the per-install denominator of the beta-vs-stable failure rate) count machines, not people: `count(distinct coalesce(properties.machine_id, distinct_id))` (`MACHINES`), because the distinct id is the account hash once someone signs in, and a person with two computers was one install. Builds that send no `machine_id` fall back to the distinct id. Every beta-vs-stable card says to read a channel's line only on a day it has at least 20 active installs (or 200 turns): beta has a few dozen installs, so one machine's bad day moves its rate. The validator checks the names inside HogQL math expressions, HogQL tables and multi-property breakdowns against the catalog, as it does for HogQL filters.

Every insight except the volume cards leaves out events with `is_internal: true` (an `is_not` filter, so events without the property still count), and, since a person with `is_internal = true` (an `ade_internal` account, copied by the sign-up webhook) can sign in on a machine nobody marked internal, events whose person has `is_internal = true` too. An install is marked internal only by `ADE_ANALYTICS_INTERNAL=1` or the `.internal` marker beside the state file; the app does not yet write that marker when an internal account signs in, because the account directory does not tell the app that an account is internal (the person filter and the `Mark ADE team accounts internal` transformation cover such sessions instead). The 30-day volume cards split the closed ingested catalog into groups of at most 26 series because PostHog formulas address series by letters `A`…`Z`, and keep internal events because billing counts them. Their sum is the volume billed against the product-analytics allowance; the overflow card includes `$identify` and the survey events so neither is treated as free. `$ai_generation` and `$exception` are left out: PostHog bills them against LLM analytics and error tracking. `docs/analytics/tracking-plan.json` lists every event; `node scripts/check-analytics-tracking-plan.mjs` (CI) fails when it, the code and this spec disagree.

### In-app surveys

The desktop app shows PostHog **API** surveys in its own corner card (no posthog-js, no session replay). `main/services/analytics/surveyService.ts` reads the project's active surveys from PostHog's public endpoint (`GET /api/surveys/?token=<public project token>`) at most once a day, and only when this install already qualifies locally. A survey is eligible only when its name starts with `[ade:pmf]`, `[ade:returning]` or `[ade:early]`; the key's rule, a 21-day per-install cooldown, never in the first session or during onboarding, and never the same survey twice are all decided on the machine from `<ade>/secrets/product-analytics-surveys.json` (local active days, last activity, launch count, shown surveys, cached survey list). The window asks only after ten minutes of use in that launch (time focused). One thing the machine cannot know is whether its account is one of ADE's own: for an install that qualifies, the service asks PostHog for the flag `surveys-real-users` (false for `is_internal` people) and offers nothing unless the answer is a clear yes. `survey dismissed` and `survey sent` carry `shown_for_ms`, the time the card was on screen, measured in the window. Answers go out as PostHog's `survey shown` / `survey dismissed` / `survey sent` events through the product analytics service, so consent, `DO_NOT_TRACK`, the daily budget and the dev-build gate all apply; with analytics off nothing is recorded, fetched or shown. Typed answers are scrubbed for secrets and home-folder paths and capped at 2,000 characters. The hosted web client and iOS show no surveys. How to write a survey ADE will show is in `docs/analytics/README.md`. When an event or property contract changes, update the dashboard spec and its tests in the same change. Run the provisioner in `--validate` mode locally. A live provisioning run requires the personal management key and should be idempotent: an immediate second run must report no changes.

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

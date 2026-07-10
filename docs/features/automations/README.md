# Automations

Automations are rule-based background workflows. Each rule has a trigger, a target execution surface, a prompt template or action chain, an optional tool palette, an optional output contract, and guardrails. Automations sit between the CTO (heavy, stateful, chat-driven) and raw cron (deterministic, no AI). The execution surface choice is the key control point.

There is no autonomous Linear intake pipeline (the CTO's Linear workflow engine was removed). Automations can react to Linear events as context or write to Linear as an action through the shared Linear client, but no rule "owns" issue dispatch — the CTO is a chat thread that reads and lightly updates issues, not a router.

## Runtime ownership

The automation rule engine, cron scheduler, deferred-cleanup sweeper, file watcher, ingress endpoints (webhook listener, GitHub relay/polling, Linear relay), and built-in action runner all execute inside the ADE runtime (`ade serve`) that owns the project. For local project bindings the local runtime hosts them; for remote project bindings the remote runtime hosts them. The desktop renderer is a view: it edits rules, watches run history, and triggers manual fires through `window.ade.automations`, but it does not own scheduling, ingress, or dispatch state.

### Availability

Automations ship **enabled in every build** — packaged desktop apps and installed daemons included. `areAutomationsEnabledForPackagedState` (`shared/automationAvailability.ts`) returns `true` regardless of the packaged flag; `ADE_DISABLE_AUTOMATIONS=1` is the kill switch and `ADE_ENABLE_AUTOMATIONS=1` still forces the feature on. The runtime reports the resolved state as `AppInfo.automationsEnabled`, and the `/automations` gate (`AutomationsProductionGate` in `AutomationsPage.tsx`) reads it, falling back to the old "off when packaged" rule only against a runtime too old to send the flag. When the kill switch is set the tab renders the disabled screen (`AutomationsComingSoon.tsx`, "Automations are disabled on this build.").

The ingress service keeps a reduced **PR-freshness-only mode** for exactly that kill-switch case. When automations are unavailable, the GitHub relay poll still runs so webhook-driven PR state updates reach `prService.ingestGithubWebhook`, while automation rule dispatch, the local webhook HTTP server, and ingress status/event reporting stay gated. See `automationIngressService.ts` in the source file map below.

Caveat: GitHub-polling and webhook ingress only work on a runtime that can reach the public internet (or your relay). A remote runtime behind a firewall may need the relay path even if the local desktop is internet-reachable.

## Source file map

### Services (apps/desktop/src/main/services/automations/)

These services are loaded by the ADE runtime's project scope (and by the desktop main process when it hosts a local project) — the path reflects the source tree, not where the code "runs".

- `automationService.ts` — main service. Rule CRUD, execution dispatch (`agent-session`, `built-in`), cron scheduling (via `node-cron`), durable deferred-lane cleanup, lane lifecycle dispatch, file-change watching (via `chokidar`), queue management, run history, confidence scoring, billing codes, ingress cursor storage.
- `automationPlannerService.ts` — natural-language rule authoring. `parseNaturalLanguage`, `validateDraft`, `saveDraft`, `simulate`. Runs a planner subprocess (Claude or Codex) to turn a free-text brief into an `AutomationRuleDraft`.
- `automationIngressService.ts` — HTTP webhook ingress (GitHub, custom webhooks) and polling-relay ingress (GitHub relay API). Signature verification for webhooks. `AutomationIngressEventRecord` is the normalized event shape. Accepts `automationService: null` for the **PR-freshness-only mode** described under [Runtime ownership](#runtime-ownership): the relay poll still feeds `prService.ingestGithubWebhook`, but rule dispatch, the local webhook server, and ingress status/event reads are skipped. In that mode the relay cursor is persisted through an injected `ingressCursorStore` — `createKvIngressCursorStore(db)`, which reads/writes `automations.ingress.cursor.<source>` in the kv table — instead of `automationService`'s cursor storage. A missing GitHub App user token puts the hosted relay poll into a quiet 5-minute auth-pending cooldown (relay status `disabled`, a single `automations.github_relay_auth_pending` info log) rather than warning every tick; `pollNow()` bypasses the cooldown.
- `githubPollingService.ts` — direct GitHub REST polling for the origin repo plus `extraRepos`. Each tick first asks `automationService.hasEnabledGithubRules()` (or the injected equivalent) and does no GitHub work unless at least one enabled rule has a canonical `github.*` trigger. Active ticks diff per-poll snapshots of issues/PRs/comments to emit `github.issue_*` and `github.pr_*` events without requiring a webhook or relay. Cursor format is `<slug>=<iso>|<slug>=<iso>` to support multi-repo state in a single stored string; see `readCursor`/`writeCursor` for the legacy-compat parser.
- `automationSecretService.ts` — secret resolution for automation actions (env-ref style). Referenced as `${env:VAR}` in action config; resolved at execution time.
- `linearIngressService.ts` — Linear event ingress over the hosted relay. Two delivery modes: a per-workspace Linear webhook that `setup()` creates through the shared Linear client (`createWebhook` / `listWebhooks` / `deleteWebhook`, resource types `Issue`/`Comment`/`IssueLabel`), or the ADE Linear OAuth app's auto-provisioned webhook (sentinel id `ade-linear-app`, surfaced as `appManaged` in status — never created or deleted here). Polls the relay's `seq:<n>` cursor for new Linear deliveries and exposes `getStatus` / `setup` / `teardown` / `pollNow`. `AutomationLinearIngressStatus` (`shared/types/automations.ts`) is the status shape; app-connected workspaces self-configure on the first poll and their teardown leaves the app webhook alone.
- `linearRelayConfig.ts` — kv + credential helpers for the Linear relay path: base-URL resolution (`ADE_LINEAR_RELAY_API_BASE_URL`, defaulting to the shared GitHub relay Worker `DEFAULT_GITHUB_RELAY_API_BASE_URL`), webhook-id/organization/secret persistence in kv (`automations.linearRelay.*`) plus the webhook secret in the credential store (`linear.webhookSecret.v1`), and `createLinearAccessTokenGetter` (Bearer-prefixes OAuth tokens, passes API keys raw) shared by desktop and headless wiring.

### GitHub relay and App

- `apps/webhook-relay/` — the hosted GitHub relay: a Cloudflare Worker (`src/index.ts` / `src/relay.ts`) plus D1 migrations. Receives ADE-GitHub-App webhooks, verifies the HMAC signature, stores deliveries idempotently by delivery id, and serves repo-scoped `/github/repos/:owner/:repo/status` and `/events` reads (monotonic `seq:<n>` cursors). Two repo-scoped webhook-maintenance routes back drift recovery and diagnostics: `POST /github/repos/:owner/:repo/webhook/heal` (repo-**admin** gated) re-syncs the GitHub App's webhook secret to the Worker's own `GITHUB_WEBHOOK_SECRET` via `PATCH /app/hook/config` — the recovery path when a rotated secret causes signature-mismatch drift, and idempotent because it can only converge on the Worker's current secret; `GET /github/repos/:owner/:repo/webhook/deliveries` (push/write gated) proxies the GitHub App delivery log filtered to the caller's repository, failing closed (a repo-scoped delivery is dropped unless its `repository_id` matches the authorized repo; app-level ping/meta deliveries with no repository are kept). The shared `assertGitHubRepoAuthorized` gate now takes a `write | admin` access level and returns the `repositoryId` used for that filter. Legacy `/projects/:projectId/github/...` project-token routes remain for self-hosted deployments. See `apps/webhook-relay/README.md` for deploy/setup.
- `apps/desktop/src/main/services/github/githubRelayConfig.ts` — resolves the relay base URL and auth mode. Defaults to the hosted Worker (`DEFAULT_GITHUB_RELAY_API_BASE_URL`) with `usesHostedDefault`; `fetchGitHubAppInstallationStatus` authenticates the hosted repo status route with a GitHub App user access token via `resolveHostedGitHubRelayAuthToken` (never the user's general GitHub token), falling back to the legacy project-token route only when `shouldUseLegacyGitHubRelayProjectRoute` (non-default base URL + project id + access token). Also exposes `createGitHubRelayAuthAuditLog`, a dedup wrapper that emits one `github.hosted_relay_auth_token_used` audit line per (event, route, repo, token source).
- `apps/desktop/src/main/services/github/githubAppUserAuth.ts` — raw GitHub device-flow HTTP helpers: `startGitHubAppDeviceFlow`, `pollGitHubAppDeviceFlow`, and `refreshGitHubAppUserToken` against GitHub's OAuth device endpoints, plus the `ADE_GITHUB_APP_CLIENT_ID` constant and the `GitHubAppUserTokenRecord` shape. No storage or lifecycle logic — pure request/response mapping.
- `apps/desktop/src/main/services/github/githubAppUserAuthService.ts` — `createGitHubAppUserAuthService`, the shared factory that owns the App user token store (`github.appUserToken.v1` in the credential store), device-auth session lifecycle (`startDeviceAuth` / `pollDeviceAuth` / `clearAuth`), single-flight refresh with an `authEpoch` guard so a clear can't re-persist an in-flight refresh, and `getValidTokenForRelay` (refreshes within a 2-minute skew). Consumed by both desktop `githubService` and the ade-cli headless services.
- `apps/desktop/src/main/services/github/githubService.ts` (`getAppInstallationStatus`, `getAppUserAuthStatus`, `startAppUserDeviceAuth`, `pollAppUserDeviceAuth`, `clearAppUserAuth`) and `apps/desktop/src/renderer/components/github/GitHubAppInstallPanel.tsx` — desktop surface for installing / checking "ADE for GitHub" per repo and authorizing the App via device flow (Settings and onboarding).

### ADE Actions registry

- `apps/desktop/src/main/services/adeActions/registry.ts` — curated allowlist of `(domain, action)` pairs exposed to automation rules as the `ade-action` action type. Each domain maps to a main-process service (`lane`, `git`, `pr`, `issue`, `chat`, `linear_*`, `file`, `pty`, etc.); the allowlist keeps the surface deterministic and audit-able. `listAllowedAdeActionNames` and `isAllowedAdeAction` gate runtime dispatch.

### Renderer

- `apps/desktop/src/renderer/components/automations/` — the `/automations` surface, rebuilt into a Linear-grade master/detail builder on the app's semantic theme tokens. See `ui-design.md` for the design brief.
  - **Page shells.** `AutomationsPage.tsx` — shell + `AutomationsProductionGate` (reads `AppInfo.automationsEnabled`) + the template-draft mailbox read. `AutomationsWorkspace.tsx` — master/detail: left rule list, right pane switching between Builder and History via a segmented control. `AutomationsTemplatesPage.tsx` — the `/automations/templates` route hosting `templates/TemplateGallery`. `AutomationsComingSoon.tsx` — the disabled-build screen.
  - **Shared data + copy.** `designTokens.ts` (semantic token class strings), `automationCopy.ts` + `automationCopy.test.ts` (`buildRuleSentence` grammar and trigger/action/disposition labels), `cronDescribe.ts` + test (cron → human gloss), `triggerCatalog.ts` (trigger sources → events → filter kinds, incl. `lane.merged`), `actionCatalog.ts` (step kinds + add-menu, incl. `delete-lane`), `variableCatalog.ts` (`{{trigger.*}}` variables per source), `localAutomationConfig.ts` (string consts), `shared.ts` (`extractError`/`parseList`), `permissionControls.ts`.
  - `list/` — left rail: `RuleList.tsx` (header, search, ingress strip, rows, empty state), `RuleRow.tsx` (sentence row with toggle/status/next-run/hover actions), `RuleSentence.tsx` (trigger→steps clauses), `AutomationsEmptyState.tsx` (first-visit flagship template cards).
  - `builder/` — `RuleBuilder.tsx` (header actions + vertical step stack), `TriggerCard.tsx`, `ScheduleEditor.tsx`, `StepStack.tsx` / `StepCard.tsx` (stacked steps + inserters + terminal cleanup zone, `alwaysRun` badge), `AgentStepEditor.tsx` (prompt + model/effort/permission + lane targeting), `LaneTargeting.tsx` (new lane / existing lane / no lane), `VariableMenu.tsx` (insert-at-cursor `{{trigger.*}}` picker), and `draftBridge.ts` + test (the `AutomationRuleDraft` ⇆ built-in-actions ⇆ agent-session normalization ported verbatim from the old editor).
  - `AdeActionEditor.tsx` + `adeActionSchemas.ts` — the ADE Actions step editor and its curated parameter schema. `adeActionSchemas.ts` drives typed forms (string / string-array / number / boolean / enum / json) with `{{trigger.*}}` hints; the runtime allowlist still lives in `apps/desktop/src/main/services/adeActions/registry.ts` — this file adds presentation metadata only, not dispatch surface.
  - `GitHubTriggerFilters.tsx` / `LinearTriggerFilters.tsx` — per-trigger filter editors (labels, authors, target branch, title/body regex, repo, team, project, assignee).
  - `history/` — `RuleHistory.tsx` (per-rule runs list + detail), `RunRow.tsx`, `RunDetail.tsx` (per-step results with lane/chat/PR deep links, queue/verify state).
  - `templates/` — `TemplateGallery.tsx`, `TemplateCard.tsx`, `templateData.ts` (grouped flagship + reworked templates), `templateIcons.ts`, and `draftHandoff.ts` — a module-scoped mailbox that carries a seeded draft from the templates route to `AutomationsPage` because the project tab host renders routes from a stored route string and strips `location.state`.
  - `settings/IngressStatusStrip.tsx` — the left-rail ingress status strip: GitHub path (App / relay / polling) plus Linear connect/status.
- `apps/desktop/src/renderer/components/usage/` — header Usage popup (`HeaderUsageControl`, `UsageQuotaPanel`) that hosts live provider quotas + the collapsible automation guardrails. `BudgetCapEditor`, `UsageMeter`, `UsagePacingBadge`, and `CostSummaryCard` continue to live under `components/settings/` but are rendered from the popup. Settings > Stats is a separate retrospective local AI + GitHub activity tab and does not host automation guardrails.
- `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` — agent-session execution surfaces as a chat thread filtered by automation owner.

### IPC and runtime RPC

- `apps/desktop/src/preload/global.d.ts` — `window.ade.automations` surface. Beyond `pollGithubNow` it now exposes `listScheduledCleanups()` / `cancelScheduledCleanup(id)` and a `linearIngress` sub-object (`getStatus` / `setup` / `teardown` / `pollNow`).
- `apps/desktop/src/main/services/ipc/registerIpc.ts` — registers `automations:*` channels including the ADE Actions registry read, GitHub polling trigger, the registry-backed `runAdeAction` dispatch, the deferred-cleanup reads (`automationsListScheduledCleanups` / `automationsCancelScheduledCleanup`), and the Linear ingress channels (`automationsLinearIngressGetStatus` / `Setup` / `Teardown` / `PollNow`, which resolve the runtime's `linearIngressService` and throw when it is absent). Each call routes through the active project binding's runtime connection (local runtime for local projects, SSH-tunneled JSON-RPC for remote projects) so the same automation rule edits or run-history reads apply to whichever runtime owns the project.
- **ADE Actions gating.** The same automations surface is reachable as `ade-action` steps: `ADE_ACTION_ALLOWLIST.automations` adds `listScheduledCleanups`, `cancelScheduledCleanup`, `linearIngressGetStatus/Setup/Teardown/PollNow`, but `ADE_ACTION_CTO_ONLY.automations` restricts `linearIngressSetup` and `linearIngressTeardown` to CTO-authored dispatch (they create/delete a real Linear webhook against the user's workspace). Status, poll, and cleanup reads stay open to ordinary automation agents.
- `apps/ade-cli/src/multiProjectRpcServer.ts` — exposes the same automation surface as JSON-RPC actions so the headless ADE CLI can manage rules, fire manual runs, and read run history without the desktop UI.

## Core model

Each `AutomationRule` carries:

- `id`, `name`, `description`, `enabled`.
- `triggers` — one or more trigger descriptors (see `triggers-and-actions.md`). Normalized to a single primary trigger for legacy compatibility.
- `execution` — which surface launches. `AutomationExecution`:
  - `{ kind: "agent-session", targetLaneId?, laneMode?, laneNamePreset?, laneNameTemplate?, session? }` — launches a scoped AI chat thread, recorded as an automation-only chat. `laneMode: "create"` creates one lane for the run; its custom name template supports `{{trigger.*}}` plus `{{date}}` (`YYYY-MM-DD`), `{{time}}` (`HH:mm`), and `{{rule.name}}`. `session` carries optional `title`, `reasoningEffort`, and `codexFastMode` (boolean); `codexFastMode` is forwarded to the chat service only when the resolved provider is Codex and the model supports fast mode, so it is safe to set on a rule that may later switch models.
  - `{ kind: "built-in", targetLaneId?, builtIn: { actions: [...] } }` — runs ADE-native deterministic actions (`AutomationAction[]`).
- `executor` — always `{ mode: "automation-bot" }` (the automation system identifies itself that way in logs).
- `reviewProfile` — `quick` | `incremental` | `full` | `security` | `release-risk` | `cross-repo-contract`. Drives confidence base and output expectations.
- `toolPalette` — explicit tool family list (`repo`, `git`, `tests`, `github`, `linear`, `browser`).
- `contextSources` — e.g. recent PRs or configured project context sources.
- `guardrails` — `confidenceThreshold`, `maxDurationMin`, `requireHuman`, path/lane allowlists (see `guardrails.md`).
- `outputs.disposition` — `comment-only` | `open-task` | `open-lane` | `prepare-patch` | `open-pr-draft`.
- `verification` — `verifyBeforePublish` + `mode` (e.g. `intervention` for human approval).
- `billingCode` — tracks spend per rule (default `auto:<id>`).

## Trigger classes

Automations support two broad trigger classes:

1. **Time-based** — `schedule` with a 5-field cron expression. `computeNextScheduleAt` walks forward in 1-minute steps (bounded at ~1 year) to find the next match using `parseCronPart` for `*`, `*/N`, ranges, and lists.
2. **Action-based** — `manual`, `git.commit`, `git.push`, `git.pr_opened`, `git.pr_updated`, `git.pr_closed`, `git.pr_merged`, `lane.created`, `lane.archived`, `lane.merged`, `file.change`, `session-end`, `webhook`, `github-webhook`, various `linear.*` events.

The `commit` trigger is an alias for `git.commit` (normalized by `normalizeTriggerType`).

Current action coverage is intentionally focused — the runtime semantics stay predictable and easy to debug. See `triggers-and-actions.md` for the full trigger and action surface.

## Execution surfaces

### agent-session

Best for lightweight autonomous text-work: reviews, audits, short summaries, status checks.

- Launches through `agentChatService.createSession` with the rule's prompt template and allowed tools.
- Records the session as an automation-scoped chat.
- Appears in Automations > History as a thread.
- Minimal orchestration overhead — no planner, no run-graph, no worker pool.

### built-in

Best for deterministic ADE operations.

- Runs a sequence of `AutomationAction` steps with typed input/output.
- `AutomationActionType` values: `create-lane` (spawns a new lane and threads it into the rest of the chain), `delete-lane` (immediate or deferred cleanup), `run-command` (shell), `run-tests`, `predict-conflicts`, `agent-session` (embedded agent step), `ade-action` (see below).
- Each action may override `targetLaneId` for that step alone; `agent-session` actions additionally accept `modelConfig` and `permissionConfig` overrides that layer on top of the rule's defaults (allowed-tool lists are merged, not replaced). `alwaysRun: true` gives a trailing action finally semantics after an earlier non-continuable failure; the original failure remains the run's overall status. See `triggers-and-actions.md` for the override resolution order.
- No separate worker thread.
- Low overhead; sandboxed to the target lane's worktree via `validateAutomationCwd` and `resolvePathWithinRoot`.

The `ade-action` action type dispatches directly into a main-process domain service through the ADE Actions registry (`apps/desktop/src/main/services/adeActions/registry.ts`). `RunAdeActionConfig` points at a `domain` + `action` on the allowlist (e.g. `pr.addComment`, `linear_sync.runSyncNow`, `issue.close`), with `args` that may embed `{{trigger.*}}` placeholders resolved from the trigger context at dispatch time, or an explicit `resolvers` map for the same. This gives built-in rules typed access to ADE services without writing a shell command or a bespoke tool.

### Lane lifecycle and cleanup

`lane.merged` is emitted when `onPullRequestChanged` observes a PR transition into `merged`. The trigger carries the lane id/name/branch and structured PR number, URL, title, repo, head/base branch, and merged state, so action templates can use both lane and PR context. `notifyLaneMerged` is also public for callers that already have a complete merge notification. A persistent kv marker keyed by project, PR identity, and PR number prevents the same merge from dispatching twice across restarts.

`delete-lane` resolves only an explicit action/rule target, a lane created for the current run, or the trigger lane. It fails instead of guessing when none exists. With `afterMinutes > 0`, the action writes an `automation_scheduled_cleanups` row and succeeds with a scheduled result; otherwise it calls `laneService.delete` immediately with `deleteBranch`, `deleteRemoteBranch`, and `force` options.

The service sweeps due cleanup rows at startup and every 60 seconds. Completed or failed cleanup is appended as another `delete-lane` action result on the originating run, so it remains visible in existing run history; a cleanup failure also leaves that run failed. A lane that is already gone is recorded as a successful no-op. `listScheduledCleanups()` exposes all statuses, and `cancelScheduledCleanup(id)` changes only a still-scheduled row to `cancelled`.

## Cron scheduling

`automationService` uses `node-cron` for in-process cron tasks. Each enabled `schedule` rule installs a `CronTask` that fires `triggerRun` on match. `computeNextScheduleAt` lets the UI preview the next fire time.

Stability rules:

- Cron tasks are stopped on rule disable or delete.
- Tasks are re-installed on restart by re-reading enabled rules.
- Seconds are not supported (the field parser expects 5 fields).
- `sunday = 0` or `sunday = 7` both match; `parseCronPart` handles the aliasing.

## File-change triggers

`file.change` triggers use `chokidar` to watch paths under the target lane's worktree (or project root if no lane). `WatchedFileRoot` scopes the watcher per lane. Changes are debounced and posted to `triggerRun` with the matched paths.

`globToRegExp` and `matchesGlob` are the primitives for path matching. `escapeRegExp` is used by the legacy path-list matcher.

## Webhook, relay, and polling ingress

Automations accept inbound events from four sources (`AutomationIngressSource`):

- `local-webhook` — `automationIngressService` opens an HTTP endpoint.
  - `github-webhook` events verify HMAC-SHA256 via `safeCompareSignature` (timing-safe). Secret read from `automations.githubWebhook.secret`.
  - `webhook` events are custom inbound webhooks with optional shared-secret verification.
- `github-relay` — the default hosted path. A Cloudflare Worker (`apps/webhook-relay/`) receives GitHub App webhooks, verifies the GitHub HMAC signature, and writes each delivery into D1. ADE polls **repo-scoped** Worker routes — `GET /github/repos/:owner/:repo/status` for App-installation/webhook state and `GET /github/repos/:owner/:repo/events?after=<cursor>` for new deliveries. Hosted relay reads use an expiring GitHub App user access token created through GitHub device flow, not the user's general ADE GitHub PAT/OAuth/`gh auth` token. The relay uses that app-limited token only to ask GitHub whether the authenticated user has push/write, maintain, or admin access, and rejects read-only public-repo callers with 403. The same Worker also exposes two repo-scoped webhook-maintenance routes for drift recovery and diagnostics — `POST .../webhook/heal` (admin-gated re-sync of the App's webhook secret) and `GET .../webhook/deliveries` (push-gated, repo-filtered proxy of the App delivery log); see the source file map above. The relay base URL defaults to `DEFAULT_GITHUB_RELAY_API_BASE_URL`. The legacy `automations.githubRelay.apiBaseUrl` + `remoteProjectId` + `accessToken` **project-token** routes (`/projects/:projectId/github/...`) remain for self-hosted relays — chosen only when a non-default base URL plus project id and access token are all set (`shouldUseLegacyGitHubRelayProjectRoute`) and do not require GitHub App user authorization.
- `linear-relay` — Linear event relay for automation triggers; Linear triggers here are context-only. Two delivery modes share the relay: a per-workspace webhook created by `linearIngressService.setup()` (requires a workspace-admin credential; per-org signing secret registered in the Worker's D1), or the ADE Linear OAuth app (`linearAppClient.ts` — client id bundled, PKCE, `read,write,admin` scope), whose webhook Linear auto-provisions on authorization and signs with the app-level `LINEAR_APP_WEBHOOK_SECRET` the Worker holds. App-connected projects self-configure on the first poll (`isAdeAppConnection` dep) — no manual connect step; teardown never deletes the app's webhook.
- `github-polling` — `githubPollingService` polls the GitHub REST API directly for the origin repo and any `extraRepos`, diffing per-poll snapshots to synthesize `github.issue_*` / `github.pr_*` events (opened / edited / labeled / closed / commented, and PR merged). No relay or webhook infra required. Cursor is a `<slug>=<iso>|<slug>=<iso>` string stored via `automationService.setIngressCursor({ source: "github-polling" })`; default interval is 30s, but each tick returns before network access when no enabled rule has a `github.*` trigger.

Ingress events normalize to `AutomationIngressEventRecord` with `source`, `eventKey`, `triggerType`, `summary`, plus `cursor` for relay/polling replay. Matching rules are resolved by `eventKey`-to-rule-id mapping. An optional `repo` filter on a rule's trigger (e.g. `github.issue_opened` with `repo: "owner/name"`) restricts dispatch when multiple repos are polled.

Enabling an externally triggered rule is capability-gated by the paths that can actually fire it. Canonical `github.*` rules need at least one configured GitHub origin for direct polling, a configured relay, a healthy/listening local webhook server, or a ready public gateway. `github-webhook` rules need relay or webhook delivery; custom `webhook` rules need the local server or public gateway. `linear.*` rules require the injected Linear-ingress capability. The enable error points to the corresponding Automations setup instead of requiring ADE Webhook Gateway for every external trigger.

## Queue and confidence

Automation runs that require review (confidence below threshold, `verifyBeforePublish`, or explicit `requireHuman`) land in a queue:

- `AutomationRunQueueStatus`: `pending-review`, `actionable-findings`, `verification-required`, `completed-clean`, `ignored`, `archived`.
- `AutomationConfidenceScore`: value 0..1, label `low` | `medium` | `high`, reason string.
- `computeConfidence(rule, procedureCount)` blends the review profile's base value with context-source and procedure boosts minus a threshold penalty.

The queue dashboard renders severity summaries and suggested actions so operators can triage without opening each run.

## Output disposition

Automations route outputs based on `outputs.disposition`:

- `comment-only` — write a comment to the automation log or PR.
- `open-pr` — open a draft PR from the target lane.
- `linear-comment` — post a Linear comment (uses the project's shared Linear client).
- `in-app-notification` — push a desktop notification.
- `evidence-only` — leave the run record; no external output.

`createArtifact: true` records proof evidence for indexing. `notificationChannel` lets a rule override the default channel.

## Budget policy

- Budget caps come from the header Usage popup → Automation guardrails. Rule-level caps via `guardrails.maxDurationMin` prevent runaway runs.
- Usage telemetry respects `billingCode` so operators can slice spend per rule.

## Boundaries

- **No autonomous Linear dispatch.** There is no CTO workflow engine to compete with; Linear triggers in automations are context-only. If a rule needs to act on an issue it does so with an explicit action (comment, state update) through the shared Linear client — nothing auto-routes issues to agents.
- **Built-in actions are deterministic.** They should not wrap an AI call. Use `agent-session` for AI-driven logic.

## Gotchas

- **Legacy `trigger` vs `triggers`.** Rules can carry either; the service normalizes via `normalizedRuleTriggers` and `primaryTrigger`. When writing new code read from `rule.triggers`.
- **`commit` is aliased to `git.commit`** by `normalizeTriggerType`. Rules persisted with `commit` still work but the dispatcher treats them as `git.commit`.
- **Legacy `git.pr_*` triggers alias to `github.pr_*`.** `LEGACY_GITHUB_PR_TRIGGER_ALIASES` is the authoritative mapping; the canonical names are `github.pr_opened`, `github.pr_updated`, `github.pr_merged`, `github.pr_closed`. Prefer the canonical names in new code and UI.
- **`lane.merged` is distinct from `github.pr_merged`.** It is lane-scoped, supports the same `namePattern` glob as other lane lifecycle triggers, and uses a persistent per-PR marker. Do not bypass `notifyLaneMerged` with a raw dispatch or the restart-safe dedupe is lost.
- **Deferred cleanup is attached to the original run.** The sweeper appends an action result instead of creating a second run; history readers must tolerate `actions_total` increasing after the original chain ends.
- **Polling cursor format is sticky.** `githubPollingService.readCursor` must handle three historical shapes: bare `<iso>` (first-ever poll, legacy), single `<slug>=<iso>` (new single-repo), and multi-repo `<slug>=<iso>|<slug>=<iso>`. Don't simplify the parser without a migration path.
- **Cron sanity-check before installing.** `cron.validate(expr)` plus the 5-field split is the safety net; otherwise `node-cron` throws.
- **Webhook secret verification is timing-safe.** Don't refactor `safeCompareSignature` into a plain string compare.
- **Legacy relay polling must respect the access token ref.** `automations.githubRelay.accessToken` is an env ref for self-hosted/project-token relays; resolve via `automationSecretService`, never hard-coded.
- **Confidence threshold is `0.65` baseline.** Rules that explicitly raise the threshold penalize confidence proportionally — document this in rule descriptions so operators understand scoring.
## Cross-links

- `triggers-and-actions.md` — full trigger and action surface.
- `guardrails.md` — approval gates, safety boundaries, verification modes.
- `../linear-integration/README.md` — the Linear read/write surface automations use for context and actions.
- `../computer-use/README.md` — automations can request computer-use proof.

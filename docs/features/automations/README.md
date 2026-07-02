# Automations

Automations are rule-based background workflows. Each rule has a trigger, a target execution surface, a prompt template or action chain, an optional tool palette, an optional output contract, and guardrails. Automations sit between the CTO (heavy, stateful, chat-driven) and raw cron (deterministic, no AI). The execution surface choice is the key control point.

Automations never duplicate Linear issue intake — the CTO owns that. Automations can consume Linear as context or write to it as an action, but the canonical intake and routing logic lives in the CTO/Linear services hosted by the ADE runtime.

## Runtime ownership

The automation rule engine, cron scheduler, file watcher, ingress endpoints (webhook listener, GitHub relay/polling, Linear relay), and built-in action runner all execute inside the ADE runtime (`ade serve`) that owns the project. For local project bindings the local runtime hosts them; for remote project bindings the remote runtime hosts them. The desktop renderer is a view: it edits rules, watches run history, and triggers manual fires through `window.ade.automations`, but it does not own scheduling, ingress, or dispatch state.

The ingress service has a reduced **PR-freshness-only mode**. In packaged builds and installed daemons where the automations feature is unavailable, the GitHub relay poll still runs so webhook-driven PR state updates reach `prService.ingestGithubWebhook`, while automation rule dispatch, the local webhook HTTP server, and ingress status/event reporting stay gated on the automations feature being enabled. See `automationIngressService.ts` in the source file map below.

Caveat: GitHub-polling and webhook ingress only work on a runtime that can reach the public internet (or your relay). A remote runtime behind a firewall may need the relay path even if the local desktop is internet-reachable.

## Source file map

### Services (apps/desktop/src/main/services/automations/)

These services are loaded by the ADE runtime's project scope (and by the desktop main process when it hosts a local project) — the path reflects the source tree, not where the code "runs".

- `automationService.ts` — main service. Rule CRUD, execution dispatch (`agent-session`, `built-in`), cron scheduling (via `node-cron`), file-change watching (via `chokidar`), queue management, run history, confidence scoring, billing codes, ingress cursor storage.
- `automationPlannerService.ts` — natural-language rule authoring. `parseNaturalLanguage`, `validateDraft`, `saveDraft`, `simulate`. Runs a planner subprocess (Claude or Codex) to turn a free-text brief into an `AutomationRuleDraft`.
- `automationIngressService.ts` — HTTP webhook ingress (GitHub, custom webhooks) and polling-relay ingress (GitHub relay API). Signature verification for webhooks. `AutomationIngressEventRecord` is the normalized event shape. Accepts `automationService: null` for the **PR-freshness-only mode** described under [Runtime ownership](#runtime-ownership): the relay poll still feeds `prService.ingestGithubWebhook`, but rule dispatch, the local webhook server, and ingress status/event reads are skipped. In that mode the relay cursor is persisted through an injected `ingressCursorStore` — `createKvIngressCursorStore(db)`, which reads/writes `automations.ingress.cursor.<source>` in the kv table — instead of `automationService`'s cursor storage. A missing GitHub App user token puts the hosted relay poll into a quiet 5-minute auth-pending cooldown (relay status `disabled`, a single `automations.github_relay_auth_pending` info log) rather than warning every tick; `pollNow()` bypasses the cooldown.
- `githubPollingService.ts` — direct GitHub REST polling for the origin repo plus `extraRepos`. Diffs per-poll snapshots of issues/PRs/comments to emit `github.issue_*` and `github.pr_*` trigger events without requiring a webhook or relay. Cursor format is `<slug>=<iso>|<slug>=<iso>` to support multi-repo state in a single stored string; see `readCursor`/`writeCursor` for the legacy-compat parser.
- `automationSecretService.ts` — secret resolution for automation actions (env-ref style, same policy as CTO workers). Referenced as `${env:VAR}` in action config; resolved at execution time.

### GitHub relay and App

- `apps/webhook-relay/` — the hosted GitHub relay: a Cloudflare Worker (`src/index.ts` / `src/relay.ts`) plus D1 migrations. Receives ADE-GitHub-App webhooks, verifies the HMAC signature, stores deliveries idempotently by delivery id, and serves repo-scoped `/github/repos/:owner/:repo/status` and `/events` reads (monotonic `seq:<n>` cursors). Two repo-scoped webhook-maintenance routes back drift recovery and diagnostics: `POST /github/repos/:owner/:repo/webhook/heal` (repo-**admin** gated) re-syncs the GitHub App's webhook secret to the Worker's own `GITHUB_WEBHOOK_SECRET` via `PATCH /app/hook/config` — the recovery path when a rotated secret causes signature-mismatch drift, and idempotent because it can only converge on the Worker's current secret; `GET /github/repos/:owner/:repo/webhook/deliveries` (push/write gated) proxies the GitHub App delivery log filtered to the caller's repository, failing closed (a repo-scoped delivery is dropped unless its `repository_id` matches the authorized repo; app-level ping/meta deliveries with no repository are kept). The shared `assertGitHubRepoAuthorized` gate now takes a `write | admin` access level and returns the `repositoryId` used for that filter. Legacy `/projects/:projectId/github/...` project-token routes remain for self-hosted deployments. See `apps/webhook-relay/README.md` for deploy/setup.
- `apps/desktop/src/main/services/github/githubRelayConfig.ts` — resolves the relay base URL and auth mode. Defaults to the hosted Worker (`DEFAULT_GITHUB_RELAY_API_BASE_URL`) with `usesHostedDefault`; `fetchGitHubAppInstallationStatus` authenticates the hosted repo status route with a GitHub App user access token via `resolveHostedGitHubRelayAuthToken` (never the user's general GitHub token), falling back to the legacy project-token route only when `shouldUseLegacyGitHubRelayProjectRoute` (non-default base URL + project id + access token). Also exposes `createGitHubRelayAuthAuditLog`, a dedup wrapper that emits one `github.hosted_relay_auth_token_used` audit line per (event, route, repo, token source).
- `apps/desktop/src/main/services/github/githubAppUserAuth.ts` — raw GitHub device-flow HTTP helpers: `startGitHubAppDeviceFlow`, `pollGitHubAppDeviceFlow`, and `refreshGitHubAppUserToken` against GitHub's OAuth device endpoints, plus the `ADE_GITHUB_APP_CLIENT_ID` constant and the `GitHubAppUserTokenRecord` shape. No storage or lifecycle logic — pure request/response mapping.
- `apps/desktop/src/main/services/github/githubAppUserAuthService.ts` — `createGitHubAppUserAuthService`, the shared factory that owns the App user token store (`github.appUserToken.v1` in the credential store), device-auth session lifecycle (`startDeviceAuth` / `pollDeviceAuth` / `clearAuth`), single-flight refresh with an `authEpoch` guard so a clear can't re-persist an in-flight refresh, and `getValidTokenForRelay` (refreshes within a 2-minute skew). Consumed by both desktop `githubService` and the ade-cli headless services.
- `apps/desktop/src/main/services/github/githubService.ts` (`getAppInstallationStatus`, `getAppUserAuthStatus`, `startAppUserDeviceAuth`, `pollAppUserDeviceAuth`, `clearAppUserAuth`) and `apps/desktop/src/renderer/components/github/GitHubAppInstallPanel.tsx` — desktop surface for installing / checking "ADE for GitHub" per repo and authorizing the App via device flow (Settings and onboarding).

### ADE Actions registry

- `apps/desktop/src/main/services/adeActions/registry.ts` — curated allowlist of `(domain, action)` pairs exposed to automation rules as the `ade-action` action type. Each domain maps to a main-process service (`lane`, `git`, `pr`, `issue`, `chat`, `linear_*`, `file`, `pty`, etc.); the allowlist keeps the surface deterministic and audit-able. `listAllowedAdeActionNames` and `isAllowedAdeAction` gate runtime dispatch.

### Renderer

- `apps/desktop/src/renderer/components/automations/` — `/automations` page.
  - `AutomationsPage.tsx` — page shell; delegates to `RulesTab` (templates are now a sibling route, `/automations/templates`).
  - `RulesTab.tsx` — rule list + editor split pane.
  - `components/RuleEditorPanel.tsx` — rule editor (trigger + execution + actions + guardrails).
  - `GitHubTriggerFilters.tsx` / `LinearTriggerFilters.tsx` — per-trigger filter editors (labels, authors, target branch, title/body regex, repo, team, project, assignee).
  - `ActionList.tsx` / `ActionRow.tsx` / `AdeActionEditor.tsx` — action chain UI for `built-in` rules, including the ADE Actions picker.
  - `adeActionSchemas.ts` — curated parameter schema (~280 entries across 29 domains) consumed by `AdeActionEditor` to render typed forms (string / string-array / number / boolean / enum / json) for `run_ade_action` step parameters with `{{trigger.*}}` placeholder hints. The runtime allowlist still lives in `apps/desktop/src/main/services/adeActions/registry.ts` — this file only adds presentation metadata and parameter shapes, not new dispatch surface.
  - `RuleHistoryPanel.tsx` — per-rule run history (replaces the old cross-rule `HistoryTab`).
  - `TemplatesTab.tsx` / `AutomationsTemplatesPage.tsx` — template picker that seeds a new draft on `/automations` via router state.
  - `EmptyStateHint.tsx` — empty-state copy shared across tabs.
- `apps/desktop/src/renderer/components/usage/` — header Usage popup (`HeaderUsageControl`, `UsageQuotaPanel`) that hosts live provider quotas + the collapsible automation guardrails. `BudgetCapEditor`, `UsageMeter`, `UsagePacingBadge`, and `CostSummaryCard` continue to live under `components/settings/` but are rendered from the popup. Settings > Stats is a separate retrospective local AI + GitHub activity tab and does not host automation guardrails.
- `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` — agent-session execution surfaces as a chat thread filtered by automation owner.

### IPC and runtime RPC

- `apps/desktop/src/preload/global.d.ts` — `window.ade.automations` surface (now includes `pollGithubNow`).
- `apps/desktop/src/main/services/ipc/registerIpc.ts` — registers `automations:*` channels including the ADE Actions registry read, GitHub polling trigger, and the registry-backed `runAdeAction` dispatch. Each call routes through the active project binding's runtime connection (local runtime for local projects, SSH-tunneled JSON-RPC for remote projects) so the same automation rule edits or run-history reads apply to whichever runtime owns the project.
- `apps/ade-cli/src/multiProjectRpcServer.ts` — exposes the same automation surface as JSON-RPC actions so the headless ADE CLI can manage rules, fire manual runs, and read run history without the desktop UI.

## Core model

Each `AutomationRule` carries:

- `id`, `name`, `description`, `enabled`.
- `triggers` — one or more trigger descriptors (see `triggers-and-actions.md`). Normalized to a single primary trigger for legacy compatibility.
- `execution` — which surface launches. `AutomationExecution`:
  - `{ kind: "agent-session", targetLaneId?, session? }` — launches a scoped AI chat thread, recorded as an automation-only chat. `session` carries optional `title`, `reasoningEffort`, and `codexFastMode` (boolean); `codexFastMode` is forwarded to the chat service only when the resolved provider is Codex and the model supports fast mode, so it is safe to set on a rule that may later switch models.
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
2. **Action-based** — `manual`, `git.commit`, `git.push`, `git.pr_opened`, `git.pr_updated`, `git.pr_closed`, `git.pr_merged`, `lane.created`, `lane.archived`, `file.change`, `session-end`, `webhook`, `github-webhook`, various `linear.*` events.

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
- `AutomationActionType` values: `create-lane` (spawns a new lane and threads it into the rest of the chain), `run-command` (shell), `run-tests`, `predict-conflicts`, `agent-session` (embedded agent step), `ade-action` (see below).
- Each action may override `targetLaneId` for that step alone; `agent-session` actions additionally accept `modelConfig` and `permissionConfig` overrides that layer on top of the rule's defaults (allowed-tool lists are merged, not replaced). See `triggers-and-actions.md` for the override resolution order.
- No separate worker thread.
- Low overhead; sandboxed to the target lane's worktree via `validateAutomationCwd` and `resolvePathWithinRoot`.

The `ade-action` action type dispatches directly into a main-process domain service through the ADE Actions registry (`apps/desktop/src/main/services/adeActions/registry.ts`). `RunAdeActionConfig` points at a `domain` + `action` on the allowlist (e.g. `pr.addComment`, `linear_sync.runSyncNow`, `issue.close`), with `args` that may embed `{{trigger.*}}` placeholders resolved from the trigger context at dispatch time, or an explicit `resolvers` map for the same. This gives built-in rules typed access to ADE services without writing a shell command or a bespoke tool.

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
- `linear-relay` — Linear event relay (shared with CTO intake; Linear triggers here are context-only).
- `github-polling` — `githubPollingService` polls the GitHub REST API directly for the origin repo and any `extraRepos`, diffing per-poll snapshots to synthesize `github.issue_*` / `github.pr_*` events (opened / edited / labeled / closed / commented, and PR merged). No relay or webhook infra required. Cursor is a `<slug>=<iso>|<slug>=<iso>` string stored via `automationService.setIngressCursor({ source: "github-polling" })`; default interval is 30s.

Ingress events normalize to `AutomationIngressEventRecord` with `source`, `eventKey`, `triggerType`, `summary`, plus `cursor` for relay/polling replay. Matching rules are resolved by `eventKey`-to-rule-id mapping. An optional `repo` filter on a rule's trigger (e.g. `github.issue_opened` with `repo: "owner/name"`) restricts dispatch when multiple repos are polled.

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
- `linear-comment` — post a Linear comment (uses CTO's Linear client).
- `in-app-notification` — push a desktop notification.
- `evidence-only` — leave the run record; no external output.

`createArtifact: true` records proof evidence for indexing. `notificationChannel` lets a rule override the default channel.

## Budget policy

- Budget caps come from the header Usage popup → Automation guardrails. Rule-level caps via `guardrails.maxDurationMin` prevent runaway runs.
- Usage telemetry respects `billingCode` so operators can slice spend per rule.

## Boundaries

- **CTO owns Linear intake.** Automations cannot define `linear.issue_created` intake logic that competes with CTO workflows. Automations can trigger on Linear events for their own context, but the CTO's `linearDispatcherService` is the canonical dispatch path for Linear issues.
- **Built-in actions are deterministic.** They should not wrap an AI call. Use `agent-session` for AI-driven logic.

## Gotchas

- **Legacy `trigger` vs `triggers`.** Rules can carry either; the service normalizes via `normalizedRuleTriggers` and `primaryTrigger`. When writing new code read from `rule.triggers`.
- **`commit` is aliased to `git.commit`** by `normalizeTriggerType`. Rules persisted with `commit` still work but the dispatcher treats them as `git.commit`.
- **Legacy `git.pr_*` triggers alias to `github.pr_*`.** `LEGACY_GITHUB_PR_TRIGGER_ALIASES` is the authoritative mapping; the canonical names are `github.pr_opened`, `github.pr_updated`, `github.pr_merged`, `github.pr_closed`. Prefer the canonical names in new code and UI.
- **Polling cursor format is sticky.** `githubPollingService.readCursor` must handle three historical shapes: bare `<iso>` (first-ever poll, legacy), single `<slug>=<iso>` (new single-repo), and multi-repo `<slug>=<iso>|<slug>=<iso>`. Don't simplify the parser without a migration path.
- **Cron sanity-check before installing.** `cron.validate(expr)` plus the 5-field split is the safety net; otherwise `node-cron` throws.
- **Webhook secret verification is timing-safe.** Don't refactor `safeCompareSignature` into a plain string compare.
- **Legacy relay polling must respect the access token ref.** `automations.githubRelay.accessToken` is an env ref for self-hosted/project-token relays; resolve via `automationSecretService`, never hard-coded.
- **Confidence threshold is `0.65` baseline.** Rules that explicitly raise the threshold penalize confidence proportionally — document this in rule descriptions so operators understand scoring.
## Cross-links

- `triggers-and-actions.md` — full trigger and action surface.
- `guardrails.md` — approval gates, safety boundaries, verification modes.
- `../cto/linear-integration.md` — the CTO owns Linear intake; automations do not duplicate it.
- `../computer-use/README.md` — automations can request computer-use proof.

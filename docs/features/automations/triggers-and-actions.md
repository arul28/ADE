# Triggers and Actions

The complete surface of triggers the automation runtime listens for, and the actions available in `built-in` execution. For execution surfaces (`mission`, `agent-session`, `built-in`) and rule structure, see the `README.md`.

## Source file map

- `apps/desktop/src/main/services/automations/automationService.ts` — trigger normalization, dispatch, cron parsing, file-change watchers, queue matching, action-chain runner.
- `apps/desktop/src/main/services/automations/automationIngressService.ts` — HTTP ingress for webhooks and relay polling.
- `apps/desktop/src/main/services/automations/githubPollingService.ts` — GitHub REST polling that emits `github.issue_*` and `github.pr_*` events by diffing per-repo snapshots.
- `apps/desktop/src/main/services/automations/automationPlannerService.ts` — natural-language rule authoring (creates triggers + actions from a free-text brief).
- `apps/desktop/src/main/services/adeActions/registry.ts` — curated allowlist for the `ade-action` action type.
- `apps/desktop/src/shared/types/config.ts` — `AutomationTriggerType`, `AutomationActionType`, `AutomationTrigger`, `AutomationAction`, `RunAdeActionConfig`, `LEGACY_GITHUB_PR_TRIGGER_ALIASES`, `AUTOMATION_TRIGGER_TYPES`.
- `apps/desktop/src/shared/types/automations.ts` — `AutomationDraftAction`, `AutomationIngressSource`, `AutomationIngressEventRecord`, `AutomationTriggerIssueContext`, `AutomationTriggerPrContext`, `AutomationTriggerLinearIssueContext`, `AdeActionRegistryEntry`.

## Trigger catalog

### Time-based

- `schedule` — cron-like cadence. Five fields: minute, hour, day-of-month, month, day-of-week. `computeNextScheduleAt` walks forward to find the next match. Seconds are not supported.
  - `schedule.cron` — the cron expression.

### Manual

- `manual` — fires on explicit operator invocation from the Automations UI. `AutomationManualTriggerRequest` carries optional context (target lane, reason, verbose trace).

### Git-lifecycle (local)

- `git.commit` (alias: `commit`) — new commit landed on a branch. Optional `branch` filter.
- `git.push` — push to a branch. Optional `branch` filter.

### GitHub

Canonical trigger names are `github.*`. The older `git.pr_*` names still work (see `LEGACY_GITHUB_PR_TRIGGER_ALIASES`) but are aliased to the canonical ones at dispatch.

- `github.pr_opened` / `github.pr_updated` / `github.pr_closed` / `github.pr_merged` — PR lifecycle. Filters: `branch`, `targetBranch`, `draftState: "draft" | "ready" | "any"`, `labels`, `authors`, `repo`, `titleRegex`, `bodyRegex`, `keywords`.
- `github.pr_commented` — a comment was added to a PR. Filters: `authors`, `keywords`, `titleRegex`/`bodyRegex`, `repo`.
- `github.pr_review_submitted` — a review was submitted on a PR.
- `github.issue_opened` / `github.issue_edited` / `github.issue_closed` — issue lifecycle. Filters: `labels`, `authors`, `titleRegex`, `bodyRegex`, `keywords`, `repo`.
- `github.issue_labeled` — label added to an issue. Filters: `labels` (the label(s) that must have been added), `repo`.
- `github.issue_commented` — comment on an issue.

GitHub triggers are emitted by three ingress paths: a real webhook (`github-webhook`), the relay (`github-relay`), or the direct `github-polling` service — the matching logic is the same regardless of source.

### Lane-lifecycle

- `lane.created` — new lane. Optional `namePattern` (glob).
- `lane.archived` — lane archived. Optional `namePattern`.

### File-change

- `file.change` — path-matched changes inside the watched lane worktree. Uses `chokidar`. Matches `paths: string[]` via `globToRegExp` + `matchesGlob`.

### Chat-lifecycle

- `session-end` — an ADE chat session ended. Useful for post-run summaries.

### Webhook

- `webhook` — custom inbound webhook. Optional `event` filter and shared-secret verification.
- `github-webhook` — GitHub-signed webhook. Signature verified via HMAC-SHA256 with a timing-safe compare. Event payload normalized before matching.

### Linear-context

Automation rules can react to Linear events as context for their own work. These do not substitute for CTO Linear intake — the CTO still owns issue dispatch.

- `linear.issue_created`
- `linear.issue_updated`
- `linear.issue_assigned`
- `linear.issue_status_changed`

Filters: `project`, `team`, `assignee`, `labels`, `stateTransition` (e.g. `"Backlog->In Progress"`), `changedFields`.

## Trigger summary (`summarizeTrigger`)

The service produces human summaries for the UI:

- `schedule` -> `"schedule <cron>"`
- `git.commit` -> `"git.commit:<branch>"` when branch is set
- `github.pr_*` -> `"github.pr_*:<branch>"` (legacy `git.pr_*` first normalizes to `github.pr_*`)
- `github.issue_*` -> `"github.issue_*:<repo>"` when `repo` is set
- `file.change` -> `"file.change:<paths.join(",")>"`
- `linear.*` -> `"<type>:<project>/<team>/<assignee>"`
- `github-webhook` -> `"github:<event>"`
- `webhook` -> `"webhook:<event>"`

These summaries surface in the rule list and in run history.

## Trigger matching

`listMatches(expected, actual)` — case-insensitive OR: a populated expected list matches when any value is present in actual. Empty expected list matches anything.

`triggerTypesMatch(ruleType, runtimeType)` — normalizes aliases before comparing (`commit` -> `git.commit`).

## Ingress payload normalization

`automationIngressService.ts` normalizes webhook payloads into `AutomationIngressEventRecord`:

- `id` — the ingress event id.
- `source` — `AutomationIngressSource` (`github-relay`, `github-polling`, `linear-relay`, `local-webhook`).
- `eventKey` — canonical key for rule-matching (e.g. `github:pull_request:opened`).
- `triggerType` — maps to one of the trigger types above.
- `status` — `AutomationIngressStatus` (`received`, `matched`, `dispatched`, `ignored`, `error`).
- `summary` — human-readable one-liner.
- `rawPayloadJson` — the full original payload.
- `cursor` — for relay polling.
- `receivedAt`.

Label normalization helper `normalizeLabels` accepts either string arrays or objects with a `.name` property (the GitHub payload shape).

## Tool palettes

`AutomationToolFamily` values and their allowed tool lists (from `automationService.ts`):

- `repo` -> `Read`, `Glob`, `Grep`, `LS`.
- `git` -> `Bash`, `bash`.
- `tests` -> `Bash`, `bash`.
- `github` -> `Bash`, `bash`, `ade.github__get_pull_request`, `ade.github__create_pull_request`, `ade.github__add_issue_comment`.
- `linear` -> `ade.linear__get_issue`, `ade.linear__save_comment`, `ade.linear__save_issue`.
- `browser` -> `agent-browser`, `get_environment_info`, `launch_app`, `interact_gui`, `screenshot_environment`, `record_environment`, `ade.playwright__*`.
- `memory` -> `memory_search`, `memory_add`.
- `mission` -> `get_mission`, `get_run_graph`, `stream_events`, `get_timeline`, `get_pending_messages`, `report_status`, `report_result`, `ask_user`.

`PUBLISH_CAPABLE_TOOL_FAMILIES` — `github`, `linear`, `browser` — are the families that can publish outputs externally. Guardrails apply specifically to these.

Baseline tools (always available) come from `buildClaudeReadOnlyWorkerAllowedTools()` plus ADE CLI actions available to terminal-capable agents. For targeted, typed access to ADE services from a built-in rule, prefer the `ade-action` action type over a shell call.

## Action catalog (built-in)

`AutomationAction` is the shape of each action in a `built-in` rule. Each action has:

- `type` — `AutomationActionType`.
- Shared step controls: `condition` (gate string), `continueOnFailure`, `timeoutMs`, `retry`.
- Action-specific config on the same object (`command`, `cwd`, `suiteId`, `adeAction`, `prompt`, `sessionTitle`).

Runtime `AutomationActionResult.status` is one of `running` | `succeeded` | `failed` | `skipped` | `cancelled`. Rows are persisted in the `automation_actions` table with `started_at`, `ended_at`, `output`, `error_message`.

Action types (`AutomationActionType`):

- `run-command` — shell command. `command` + optional `cwd`. Cwd validated via `validateAutomationCwd` + `resolvePathWithinRoot`; must stay inside the target lane worktree or project root.
- `run-tests` — invokes the ADE test runner for `suiteId`.
- `predict-conflicts` — runs the conflicts service's prediction for the target lane; no extra config.
- `launch-mission` — dispatches a mission via the mission runtime. Same surface as `execution.kind === "mission"` but from inside an action chain.
- `agent-session` — embeds an agent-session step inside a built-in chain. `prompt` + optional `sessionTitle`; the rule's tool palette applies.
- `ade-action` — dispatches a registered ADE action. `adeAction: RunAdeActionConfig`:
  - `domain` — one of the allowlisted `AdeActionDomain` values (`lane`, `git`, `pr`, `issue`, `chat`, `mission`, `memory`, `linear_sync`, `file`, `pty`, `automations`, etc.).
  - `action` — an entry on that domain's allowlist (e.g. `pr.addComment`, `issue.close`, `linear_sync.runSyncNow`).
  - `args` — object or array passed to the domain method. Strings may contain `{{trigger.*}}` placeholders resolved from the trigger context at dispatch time.
  - `resolvers` — optional explicit `{ key: "trigger.path" }` mapping for placeholders that are not embedded in `args` strings.

`isAllowedAdeAction(domain, action)` gates every `ade-action` dispatch; `listAllowedAdeActionNames(domain, service)` powers the picker in `AdeActionEditor`. The full allowlist lives in `apps/desktop/src/main/services/adeActions/registry.ts`.

## Natural-language rule authoring

`automationPlannerService.ts` exposes:

- `parseNaturalLanguage({ text, projectContext })` — runs a planner subprocess (Claude CLI or Codex CLI; resolved via `resolveClaudeCodeExecutable` / `resolveCodexExecutable`). Returns `AutomationParseNaturalLanguageResult` with a candidate `AutomationRuleDraft`, `ambiguities`, and `confirmationRequirements`.
- `validateDraft({ draft })` — static validation: `AutomationValidateDraftResult` with `issues[]`.
- `saveDraft({ draft, resolution })` — saves after resolution of ambiguities. Returns `AutomationSaveDraftResult`.
- `simulate({ rule, trigger })` — dry-run a rule against a synthetic trigger. `AutomationSimulateResult` lists the actions that would fire.

The planner output JSON is extracted with `extractFirstJsonObject` — it handles fenced code blocks, bare objects, and best-effort span extraction. Planner output is always validated before persistence.

## Gotchas

- **Cron field order is 5 fields** (minute hour day-of-month month day-of-week). Adding a seconds field breaks parsing.
- **`file.change` watchers are scoped per lane.** Moving a watched root requires tearing down the old watcher — don't mutate `WatchedFileRoot` in place.
- **Webhook payloads must be normalized before matching.** Rules match `eventKey`, not raw payload shape.
- **Relay polling needs a cursor.** Without `cursor` on `AutomationIngressEventRecord`, the relay replays the full backlog on every poll.
- **Built-in shell actions validate cwd.** Don't pass absolute paths that escape the allowed roots — `validateAutomationCwd` rejects them.
- **ADE actions are allowlisted at compile time.** A `(domain, action)` pair must appear in `ADE_ACTION_ALLOWLIST`. Adding an internal service method doesn't expose it to automations until the allowlist is updated; this is intentional — the allowlist is the audit surface.
- **`{{trigger.*}}` placeholders only interpolate from the current trigger context.** There is no cross-run state; if a placeholder resolves to `undefined`, the ADE action receives `undefined` rather than an empty string. Prefer explicit `resolvers` when a placeholder is load-bearing.
- **Planner JSON extraction is lossy on malformed output.** Budget extra validation on fields the planner set; rely on `validateDraft` rather than trusting raw output.

## Cross-links

- `README.md` — rule structure, execution surfaces, budget, memory.
- `guardrails.md` — approval gates, confidence thresholds, human review.
- `../cto/linear-integration.md` — Linear intake boundary.
- `../missions/README.md` — when a rule dispatches as `kind: "mission"`.

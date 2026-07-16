# Triggers and Actions

The complete surface of triggers the automation runtime listens for, and the actions available in `built-in` execution. For execution surfaces (`agent-session`, `built-in`) and rule structure, see the `README.md`.

## Source file map

- `apps/desktop/src/main/services/automations/automationService.ts` — trigger normalization, dispatch, cron parsing, file-change watchers, queue matching, action-chain runner, and persisted deferred-lane cleanup.
- `apps/desktop/src/main/services/automations/automationIngressService.ts` — HTTP ingress for webhooks plus GitHub relay cursor draining and repo-scoped WebSocket wake-ups.
- `apps/desktop/src/main/services/automations/githubPollingService.ts` — GitHub REST polling that emits `github.issue_*` and `github.pr_*` events by diffing per-repo snapshots, gated on the presence of an enabled `github.*` rule at each tick.
- `apps/desktop/src/main/services/automations/linearAutomationDispatch.ts` — pure translation of a `LinearIngressEventRecord` (relay event) into the `LinearAutomationDispatch[]` it implies, including the added-label diff that produces a one-shot `linear.issue_labeled` and the dedupe that suppresses the generic `issue_updated` fallthrough. `main.ts` calls `buildLinearAutomationDispatches` on each relay event and feeds the results into `automationService.dispatchIngressTrigger`.
- `apps/desktop/src/main/services/automations/automationPlannerService.ts` — natural-language rule authoring (creates triggers + actions from a free-text brief).
- `apps/desktop/src/main/services/adeActions/registry.ts` — curated allowlist for the `ade-action` action type.
- `apps/desktop/src/renderer/components/automations/adeActionSchemas.ts` — UI-side parameter schema for each allowlisted action; drives the structured form in `AdeActionEditor` (per-param input type, required flag, placeholder hints like `{{trigger.lane.id}}`, enum options).
- `apps/desktop/src/shared/types/config.ts` — `AutomationTriggerType`, `AutomationActionType`, `AutomationTrigger`, `AutomationAction`, `RunAdeActionConfig`, `LEGACY_GITHUB_PR_TRIGGER_ALIASES`, `AUTOMATION_TRIGGER_TYPES`.
- `apps/desktop/src/shared/types/automations.ts` — `AutomationDraftAction`, `AutomationIngressSource`, `AutomationIngressEventRecord`, `AutomationTriggerIssueContext`, `AutomationTriggerPrContext`, `AutomationTriggerLinearIssueContext`, `AdeActionRegistryEntry`, and the per-source delivery types `AutomationTriggerDeliveryVia`, `AutomationTriggerDeliveryStatus`, and `AutomationIngressDelivery` plus the `triggerDeliveryKeyForType` mapper.

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
- `lane.merged` — the lane's PR transitioned to merged. Optional `namePattern` uses the same glob semantics as `lane.created`. Context includes `trigger.laneId`, `trigger.laneName`, `trigger.branch`, and structured `trigger.pr` fields. `notifyLaneMerged` persists a per-PR dedupe marker before dispatch, so repeated observations do not fire another run after restart.

### File-change

- `file.change` — path-matched changes inside the watched lane worktree. Uses `chokidar`. Matches `paths: string[]` via `globToRegExp` + `matchesGlob`.

### Chat-lifecycle

- `session-end` — an ADE chat session ended. Useful for post-run summaries.

### Webhook

- `webhook` — custom inbound webhook. Optional `event` filter and shared-secret verification.
- `github-webhook` — GitHub-signed webhook. Signature verified via HMAC-SHA256 with a timing-safe compare. Event payload normalized before matching.

### Linear-context

Automation rules can react to Linear events as context for their own work. There is no autonomous Linear dispatch engine — these triggers are context-only, and any Linear write is an explicit rule action through the shared Linear client.

- `linear.issue_created`
- `linear.issue_updated`
- `linear.issue_assigned`
- `linear.issue_status_changed`
- `linear.issue_labeled` — one or more labels were *added* to an issue.

Filters: `project`, `team`, `assignee`, `labels`, `stateTransition` (e.g. `"Backlog->In Progress"`), `changedFields`.

For `linear.issue_labeled` the `labels` filter matches against the labels that were *just added* (not the issue's full label set), mirroring `github.issue_labeled`. A labeled rule with no configured `labels` still requires at least one added label to fire — `triggerMatches` (`automationService.ts`) special-cases the canonical type to read `trigger.labels` (the added names) and rejects an empty added-label set.

A single Linear relay event can fan out into more than one dispatch. `buildLinearAutomationDispatches` (`apps/desktop/src/main/services/automations/linearAutomationDispatch.ts`) translates a `LinearIngressEventRecord` into the trigger dispatches it implies:

- It diffs the current `data.labelIds` against `updatedFrom.labelIds` (only when `updatedFrom` actually carried `labelIds`, so an unrelated edit never looks like it added every label) and resolves the added ids to human-readable names via the payload's `labels` node. When any names were added it emits a one-shot `linear.issue_labeled` whose matchable `labels` are the added names only.
- A pure label add suppresses the generic `linear.issue_updated` fallthrough so a single change is not double-counted; a concurrent assignment or status change in the same payload still emits its own `linear.issue_assigned` / `linear.issue_status_changed` event alongside the labeled one.

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
- `lane.merged` -> `"Lane merged: <lane> (PR #<number>)"` when the PR number is present

These summaries surface in the rule list and in run history.

## Trigger matching

`listMatches(expected, actual)` — case-insensitive OR: a populated expected list matches when any value is present in actual. Empty expected list matches anything.

`triggerTypesMatch(ruleType, runtimeType)` — normalizes aliases before comparing (`commit` -> `git.commit`).

Lane lifecycle `namePattern` values are globs matched against the resolved lane name. For `lane.merged`, the dispatcher supplies the name from the merge notification (or resolves lane metadata before matching), and PR fields remain available independently for title/repo/author/branch filters and templates.

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

`PUBLISH_CAPABLE_TOOL_FAMILIES` — `github`, `linear`, `browser` — are the families that can publish outputs externally. Guardrails apply specifically to these.

Baseline tools (always available) come from `buildClaudeReadOnlyWorkerAllowedTools()` plus ADE CLI actions available to terminal-capable agents. For targeted, typed access to ADE services from a built-in rule, prefer the `ade-action` action type over a shell call.

## Action catalog (built-in)

`AutomationAction` is the shape of each action in a `built-in` rule. Each action has:

- `type` — `AutomationActionType`.
- Shared step controls: `condition` (gate string), `continueOnFailure`, `alwaysRun`, `timeoutMs`, `retry`. Once a non-continuable action fails, ordinary trailing actions do not run; trailing actions with `alwaysRun: true` still execute as cleanup/finally steps. Their results are recorded normally, but they never erase the original failed run status.
- Per-action overrides (apply on top of `execution.*` defaults):
  - `targetLaneId` — overrides the lane this action runs against. Resolves through `getConfiguredTargetLaneId(rule, action)` → `execution.targetLaneId` → trigger lane → primary lane.
  - `modelConfig` (`agent-session` only) — `{ modelId, thinkingLevel? }` overriding the rule's model for this step. `thinkingLevel` also feeds the agent-session reasoning effort.
  - `codexFastMode` (`agent-session` only) — boolean that enables Codex Fast Mode for this step. Only applied when the resolved provider group is `codex` AND the resolved model descriptor supports fast mode (`modelSupportsFastMode`); silently ignored otherwise. Forwarded to the chat service as `codexFastMode: true` on the session create, which causes Codex `thread/start` + `turn/start` JSON-RPC calls to carry `serviceTier: "fast"`. Mirrors the rule-level `execution.session.codexFastMode` toggle and stacks the same way as `modelConfig` / `permissionConfig`.
  - `permissionConfig` (`agent-session` only) — provider permission config whose `cli`/`providers`/`inProcess` fields are merged onto the rule's permission config; `providers.allowedTools` and `cli.allowedTools` extend (not replace) the rule's allow-list. The `cursor` provider key is supported alongside `claude`/`codex`/`opencode`.
- Action-specific config on the same object (`command`, `cwd`, `suiteId`, `adeAction`, `prompt`, `sessionTitle`, `laneNameTemplate`, `laneDescriptionTemplate`, `parentLaneId`, `laneDeleteOptions`, `afterMinutes`).

Runtime `AutomationActionResult.status` is one of `running` | `succeeded` | `failed` | `skipped` | `cancelled`. Rows are persisted in the `automation_action_results` table with `started_at`, `ended_at`, `output`, `error_message`.

Action types (`AutomationActionType`):

- `create-lane` — creates a new lane via `laneService.create` and binds the rest of the action chain to it. Subsequent actions see the new lane in `trigger.laneId` / `trigger.laneName` / `trigger.branch`.
  - `laneNameTemplate` (default `"{{trigger.issue.title}}"`) — supports `{{trigger.*}}` placeholders plus `{{date}}` (`YYYY-MM-DD`), `{{time}}` (`HH:mm`), and `{{rule.name}}`; falls back to issue title, PR title, trigger summary, then rule name. The same resolver is used by execution-level `laneMode: "create"` naming presets/templates.
  - `laneDescriptionTemplate` (optional) — placeholder-aware; defaults to a short auto-blurb that lists the issue number, source URL, and trigger summary.
  - `parentLaneId` (optional) — stack the new lane under an existing lane.
- `delete-lane` — deletes only the resolved target lane: action `targetLaneId`, execution `targetLaneId`, a lane created earlier for this run, or the trigger lane. Missing context fails with a clear error instead of falling back to the primary lane.
  - `laneDeleteOptions` — optional `deleteBranch`, `deleteRemoteBranch`, and `force` booleans forwarded to `laneService.delete`.
  - `afterMinutes` — omitted or `0` deletes immediately. A positive value writes a durable scheduled-cleanup row and returns a succeeded action result whose JSON output includes `status: "scheduled"`, cleanup id, lane id, and due time.
- `run-command` — shell command. `command` + optional `cwd`. Cwd validated via `validateAutomationCwd` + `resolvePathWithinRoot`; must stay inside the target lane worktree or project root.
- `run-tests` — invokes the ADE test runner for `suiteId`.
- `predict-conflicts` — runs the conflicts service's prediction for the target lane; no extra config.
- `agent-session` — embeds an agent-session step inside a built-in chain. `prompt` + optional `sessionTitle`; the rule's tool palette applies.
- `ade-action` — dispatches a registered ADE action. `adeAction: RunAdeActionConfig`:
  - `domain` — one of the allowlisted `AdeActionDomain` values (`lane`, `git`, `pr`, `issue`, `chat`, `linear_sync`, `file`, `pty`, `automations`, etc.).
  - `action` — an entry on that domain's allowlist (e.g. `pr.addComment`, `issue.close`, `linear_sync.runSyncNow`).
  - `args` — object or array passed to the domain method. Strings may contain `{{trigger.*}}` placeholders resolved from the trigger context at dispatch time.
  - `resolvers` — optional explicit `{ key: "trigger.path" }` mapping for placeholders that are not embedded in `args` strings.

`isAllowedAdeAction(domain, action)` gates every `ade-action` dispatch; `listAllowedAdeActionNames(domain, service)` powers the picker in `AdeActionEditor`. The full allowlist lives in `apps/desktop/src/main/services/adeActions/registry.ts`.

`AdeActionEditor` is split into two modes: a structured form driven by `adeActionSchemas.ts` (one input per declared `AdeActionParam`, with type-aware widgets — strings, numbers, booleans, comma-separated string arrays, enum dropdowns, and a JSON editor for free-form `json` params) and a raw JSON fallback (`Show JSON` toggle) for actions that have no schema entry or for users who want full control. The action picker filters by domain and search, surfaces `description` text, and inserts `{{trigger.*}}` placeholders (`trigger.lane.id`, `trigger.pr.id`, `trigger.pr.number`, `trigger.pr.title`, `trigger.pr.author`, `trigger.branch`) directly into the focused string input.

### Deferred cleanup lifecycle

`automation_scheduled_cleanups` stores the rule, originating run, lane, due time, serialized delete options, and `scheduled | executing | executed | failed | cancelled` state. `automationService` claims due work as `executing`, runs one sweep on startup and then every 60 seconds, and retries any crash-left `executing` row on the next service start. Execution calls `laneService.delete`; a missing lane is an executed no-op, while any other exception marks the cleanup failed.

The outcome is appended to the originating run as a new `delete-lane` row in `automation_action_results`, incrementing that run's action totals. This keeps cleanup visible through the existing history contract without creating a synthetic second run. Public service methods expose `listScheduledCleanups()`, `cancelScheduledCleanup(id)`, and the test/operations hook `runScheduledCleanupSweep()`.

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
- **Relay draining is page-durable.** The WebSocket is only a wake-up hint. Drain repo events with `order=asc&limit=100`, process pages in returned order, persist `nextCursor` after the page's events are all attempted, and immediately continue while `hasMore` is true; otherwise a burst can be skipped or replayed. A per-event ingest/dispatch failure is caught and the cursor advances past it (a poison event can't freeze the repo); only a page fetch/transport failure or non-advancing cursor leaves the durable cursor at the prior page for replay.
- **Direct GitHub polling is demand-gated.** The rule predicate is checked every tick, so enabling or disabling the last `github.*` rule takes effect without restarting the runtime.
- **External triggers must have a viable ingress capability before enable.** Readiness is computed per source class by `computeDeliveryStatuses` (`automationService.ts`), which returns an `AutomationIngressDelivery` map keyed by `github`, `githubWebhook`, `webhook`, and `linear`; `triggerDeliveryKeyForType` maps a trigger type to its key. Canonical `github.*` accepts direct polling, relay, local webhook, or a ready public gateway; `github-webhook`, custom `webhook`, and `linear.*` use their narrower checks. `getIngressSetupError` returns the first not-ready source's `setupError`. See the automations [README](README.md#webhook-relay-and-polling-ingress) for the full model.
- **Built-in shell actions validate cwd.** Don't pass absolute paths that escape the allowed roots — `validateAutomationCwd` rejects them.
- **ADE actions are allowlisted at compile time.** A `(domain, action)` pair must appear in `ADE_ACTION_ALLOWLIST`. Adding an internal service method doesn't expose it to automations until the allowlist is updated; this is intentional — the allowlist is the audit surface.
- **`{{trigger.*}}` placeholders only interpolate from the current trigger context.** There is no cross-run state; if a placeholder resolves to `undefined`, the ADE action receives `undefined` rather than an empty string. Prefer explicit `resolvers` when a placeholder is load-bearing.
- **Planner JSON extraction is lossy on malformed output.** Budget extra validation on fields the planner set; rely on `validateDraft` rather than trusting raw output.

## Cross-links

- `README.md` — rule structure, execution surfaces, budget.
- `guardrails.md` — approval gates, confidence thresholds, human review.
- `../linear-integration/README.md` — the Linear read/write surface.

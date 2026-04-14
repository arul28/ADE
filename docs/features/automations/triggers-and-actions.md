# Triggers and Actions

The complete surface of triggers the automation runtime listens for, and the actions available in `built-in` execution. For execution surfaces (`mission`, `agent-session`, `built-in`) and rule structure, see the `README.md`.

## Source file map

- `apps/desktop/src/main/services/automations/automationService.ts` — trigger normalization, dispatch, cron parsing, file-change watchers, queue matching.
- `apps/desktop/src/main/services/automations/automationIngressService.ts` — HTTP ingress for webhooks and relay polling.
- `apps/desktop/src/main/services/automations/automationPlannerService.ts` — natural-language rule authoring (creates triggers + actions from a free-text brief).
- `apps/desktop/src/shared/types/automations.ts` (via `shared/types`) — `AutomationTrigger`, `AutomationAction`, `AutomationIngressSource`, `AutomationToolFamily`.

## Trigger catalog

### Time-based

- `schedule` — cron-like cadence. Five fields: minute, hour, day-of-month, month, day-of-week. `computeNextScheduleAt` walks forward to find the next match. Seconds are not supported.
  - `schedule.cron` — the cron expression.

### Manual

- `manual` — fires on explicit operator invocation from the Automations UI. `AutomationManualTriggerRequest` carries optional context (target lane, reason, verbose trace).

### Git-lifecycle

- `git.commit` (alias: `commit`) — new commit landed on a branch. Optional `branch` filter.
- `git.push` — push to a branch. Optional `branch` filter.
- `git.pr_opened` / `git.pr_updated` / `git.pr_closed` — PR lifecycle events. Optional `branch`, `draftState: "draft" | "ready" | "any"`.
- `git.pr_merged` — merge event. Optional `targetBranch` or `branch`.

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

- `linear.*` — automation rules can react to Linear events (e.g. `linear.issue_updated`) as context for their own work. These do not substitute for CTO Linear intake — the CTO still owns issue dispatch. Optional `project`, `team`, `assignee` filters.

## Trigger summary (`summarizeTrigger`)

The service produces human summaries for the UI:

- `schedule` -> `"schedule <cron>"`
- `git.commit` -> `"git.commit:<branch>"` when branch is set
- `git.pr_*` -> `"git.pr_*:<branch>"`
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
- `source` — `AutomationIngressSource` (`webhook`, `github-webhook`, `relay`, `linear-relay`).
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
- `github` -> `Bash`, `bash`, `mcp__github__get_pull_request`, `mcp__github__create_pull_request`, `mcp__github__add_issue_comment`.
- `linear` -> `mcp__linear__get_issue`, `mcp__linear__save_comment`, `mcp__linear__save_issue`.
- `browser` -> `agent-browser`, `mcp__ade__get_environment_info`, `mcp__ade__launch_app`, `mcp__ade__interact_gui`, `mcp__ade__screenshot_environment`, `mcp__ade__record_environment`, `mcp__playwright__*`.
- `memory` -> `mcp__ade__memory_search`, `mcp__ade__memory_add`.
- `mission` -> `mcp__ade__get_mission`, `mcp__ade__get_run_graph`, `mcp__ade__stream_events`, `mcp__ade__get_timeline`, `mcp__ade__get_pending_messages`, `mcp__ade__report_status`, `mcp__ade__report_result`, `mcp__ade__ask_user`.
- `external-mcp` -> empty by default; actual tools resolved from the project's external MCP registry at runtime.

`PUBLISH_CAPABLE_TOOL_FAMILIES` — `github`, `linear`, `browser`, `external-mcp` are the families that can publish outputs externally. Guardrails apply specifically to these.

Baseline tools (always available) come from `buildClaudeReadOnlyWorkerAllowedTools("ade")` — the read-only ADE MCP surface.

## Action catalog (built-in)

`AutomationAction` is the shape of each action in a `built-in` rule. Each action has:

- `type` — `AutomationActionType` (see below).
- `status` — `running` | `succeeded` | `failed` | `skipped` | `cancelled`.
- Action-specific config (typed per `type`).

Action types:

- `shell` — run a shell command in a validated cwd. Cwd validated via `validateAutomationCwd` + `resolvePathWithinRoot` — must stay inside the lane worktree or project root.
- `file.read`, `file.glob`, `file.grep`, `file.ls` — read-only file operations.
- `github.comment`, `github.create_pr` — GitHub actions via `mcp__github__*`.
- `linear.get_issue`, `linear.save_comment`, `linear.save_issue` — Linear actions.
- `memory.search`, `memory.add` — memory actions.
- `mission.get`, `mission.report_status`, `mission.report_result`, `mission.ask_user` — mission tools.
- `agent-session.run` — delegated to the agent-session surface when a built-in rule needs AI.

Each action records `started_at`, `ended_at`, `output`, `error_message` in the `automation_actions` table.

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
- **`external-mcp` tool list is empty at compile time.** Resolution happens at runtime; rules referencing external MCP tools must check server availability before dispatch.
- **Planner JSON extraction is lossy on malformed output.** Budget extra validation on fields the planner set; rely on `validateDraft` rather than trusting raw output.

## Cross-links

- `README.md` — rule structure, execution surfaces, budget, memory.
- `guardrails.md` — approval gates, confidence thresholds, human review.
- `../cto/linear-integration.md` — Linear intake boundary.
- `../missions/README.md` — when a rule dispatches as `kind: "mission"`.

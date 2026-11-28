# Triggers and Actions

The triggers the automation runtime listens for and the actions a `built-in`
rule can run. Rule structure and execution surfaces are in
[README.md](./README.md).

## Source file map

- `apps/desktop/src/main/services/automations/automationService.ts`: trigger normalization and matching (`triggerMatches`, `summarizeTrigger`), dispatch, cron, file watchers, the action-chain runner, deferred cleanup, tool palettes.
- `automationIngressService.ts`, `customWebhookService.ts`, `githubPollingService.ts`: ingress.
- `linearAutomationDispatch.ts`: a Linear relay event → the dispatches it implies (`buildLinearAutomationDispatches`).
- `automationPlannerService.ts`: natural-language authoring and step validation.
- `apps/desktop/src/main/services/adeActions/`: `registry.ts` (dispatch), `actionPolicy.ts` (allowlist, CTO-only rules), `actionInputContracts.ts`.
- `apps/desktop/src/renderer/components/automations/adeActionSchemas.ts`, `builder/NotifyStepEditor.tsx`, `notifyLink.ts`: step editors.
- `apps/desktop/src/shared/types/config.ts` (`AutomationTriggerType`, `AutomationActionType`, `RunAdeActionConfig`, `LEGACY_GITHUB_PR_TRIGGER_ALIASES`), `shared/types/automations.ts` (ingress records, trigger contexts, delivery types).

## Trigger catalog

- **Time:** `schedule` (`schedule.cron`, 5 fields, no seconds).
- **Manual:** `manual` (optional lane, reason).
- **Local git:** `git.commit` (alias `commit`), `git.push`; optional `branch`.
- **GitHub** (canonical `github.*`; legacy `git.pr_*` aliases):
  - `github.pr_opened|updated|closed|merged`. Filters: `branch`, `targetBranch`, `draftState`, `labels`, `authors` (case-insensitive, ignores `@` and `[bot]`), `repo`, `titleRegex`, `bodyRegex`, `keywords`.
  - `github.pr_commented`, `github.pr_review_submitted`: `bodyRegex` reads the comment or review text. A comment names no branch; the relay fills it from the tracked PR row, so a branch-filtered rule skips untracked PRs.
  - `github.pr_checks_failed`: from DAEX's own PR poller, not a webhook. Once per head commit; a PR first seen failing does not fire. Filters: `branch`, `repo`, `titleRegex`, `keywords`, `draftState` (no author, labels or body).
  - `github.issue_opened|edited|closed|labeled|commented`.
  - Emitted by `github-webhook`, `github-relay` or `github-polling`; matching is the same.
- **Lane:** `lane.created`, `lane.archived`, `lane.merged` (optional `namePattern` glob). `lane.merged` carries `trigger.laneId`, `laneName`, `branch` and `trigger.pr`.
- **File:** `file.change` (`paths` globs under the lane worktree).
- **Chat:** `session-end`, `session.limit_reached` (with `resetAt`), `session.failed`, `session.ended_without_pr`, `session.settled`. All carry `trigger.session` (`sessionId`, `provider`, `modelId`, `laneId`). Filters: `sessionId` (a chat-menu rule sets it) and `providers`.
  - `limit_reached` / `failed` arrive through `automationService.onSessionSignal`; automations never read chat events themselves.
  - `session.settled` fires once for a settled DAEX chat (not shells, CLIs, or subagents following a parent), via `onSessionSettled`. Other chats may still use the lane; clean a whole lane on `lane.archived`.
  - `session.ended_without_pr` fires only when the lane has no open/draft PR; an unreadable projection counts as "has a PR".
- **Webhook:** `webhook` (custom URL) and `github-webhook` (GitHub-signed, local server). See below.
- **Linear** (context only): `linear.issue_created|updated|assigned|status_changed|labeled`. Filters: `project`, `team`, `assignee`, `labels`, `stateTransition`, `changedFields`. For `issue_labeled`, `labels` match only the labels just added; a pure label add suppresses the generic `issue_updated`.
- **Cursor:** `cursor.cloud_finished`, `cursor.cloud_error` (Cursor Cloud status, polled only while such a rule exists).

### Webhook

A custom `webhook` trigger carries `webhook: AutomationWebhookTriggerConfig`:

- `hookId` (`wh-…`) is in config; the **token** that makes the URL secret lives only in the machine-local `automation_webhook_hooks` table, so a copied config cannot receive on it.
- `preset` (`github`, `stripe`, `linear`, `sentry`, `generic`) drives paste instructions, signature defaults and the **Send test** sample (`shared/automationWebhooks.ts`).
- `signature`: `hmac` (HMAC-SHA256 of the raw body, configurable header/prefix/encoding) or `stripe` (`t=…,v1=…`, 5-minute tolerance from arrival at DAEX). `secretName` names a project secret that never leaves the machine.
- `filters` on `body.*`, `headers.*`, `query.*` (`equals`, `not_equals`, `contains`, `exists`, `matches`; regex over ≤ 10,000 chars), checked before anything starts. `maxAgeMinutes` skips old relay-held deliveries.
- Placeholders `{{trigger.body.a.b}}`, `{{trigger.headers.x}}`, `{{trigger.query.x}}`, `{{trigger.method}}`, `{{trigger.body}}`. Every webhook-started prompt is prefixed with `WEBHOOK_UNTRUSTED_NOTICE` (request text is data, not instructions).
- Deleting a rule retires its URLs (`retireForDeletedRule`): the relay drops the hook and the URL answers `404`. URLs no saved rule named for 7 days are retired at ingress start.

#### How a custom webhook delivery is handled

`customWebhookService.ts` handles every request, direct or relay-drained.
Checks run cheapest and least revealing first: token (direct only) → a saved
rule uses this hook → 1 MiB cap → 60/minute per hook → max age → signature →
rule enabled → filters → duplicate (sender delivery id, else relay id) → run.
A wrong token and an unknown hook both answer `404` and are not logged. The
reply is `202` before the run starts.

- **Restart-safe.** The `automation_ingress_events` row is written before `202` and before the relay is acknowledged; its `run_claim` is set when the run's turn comes. `resumeInterruptedDeliveries` re-dispatches unclaimed `ran` deliveries once, with per-dispatch claim tokens so an original and its replay never both start. A run that started is never replayed.
- Only a `ran` row keeps its duplicate key, so a resend of an event that never ran can run.
- A relay request over the rate limit is neither logged nor acknowledged and is retried about a minute later.
- **Delivery log:** `automation_webhook_deliveries` keeps the newest 50 per hook (plus any waiting), headers with secrets hidden, ≤ 64 KB of body, and one sentence per outcome (`ran`, `no_rule`, `disabled`, `filtered`, `bad_signature`, `missing_signature`, `duplicate`, `expired`, `rate_limited`, `too_large`, `error`).
- **Run it again** replays against the current rule, but never a delivery whose signature failed or was missing (it may be forged).
- **Send test** signs a sample as the sender would and posts it to the real URL with a one-time `x-ade-test` nonce. Agents test the saved rule only (the RPC layer drops the draft `config` for non-user callers).

## Matching and normalization

- `listMatches` is a case-insensitive OR; an empty expected list matches anything. `triggerTypesMatch` normalizes aliases first.
- Ingress normalizes to `AutomationIngressEventRecord` (`source`, `eventKey`, `triggerType`, `status`, `summary`, `cursor`). The raw payload is matched in memory and never stored (`raw_payload_json` is `null`).
- `summarizeTrigger` produces the row and history labels.

## Tool palettes

`AutomationToolFamily` (`repo`, `git`, `tests`, `github`, `linear`, `browser`)
maps to allowed tools in `automationService.ts`. `PUBLISH_CAPABLE_TOOL_FAMILIES`
(`github`, `linear`, `browser`) are the ones guardrails watch. Baseline tools
come from `buildClaudeReadOnlyWorkerAllowedTools()` plus the `daex` CLI. For
typed access to DAEX services, prefer an `ade-action` step over a shell call.

## Action catalog (built-in)

Each `AutomationAction` has a `type`, shared controls (`condition`,
`continueOnFailure`, `alwaysRun`, `retry`; `timeoutMs` for `run-command` only,
default 5 min, max 12 h) and per-step overrides: `targetLaneId` (→
`execution.targetLaneId` → trigger lane → main checkout), and for
`agent-session` `modelConfig`, `codexFastMode`, `stopAfterMin` /
`stopWhenIdleMin`, `permissionConfig` (allowed tools extend, never replace).
Results are stored in `automation_action_results`.

- `create-lane`: `laneService.create`, then later steps use the new lane. `laneNameTemplate` (default `{{trigger.issue.title}}`; `{{date}}`, `{{time}}`, `{{rule.name}}`), optional description and `parentLaneId`.
- `delete-lane`: only an explicit target, a lane this run made, or the trigger lane; otherwise it fails. `laneDeleteOptions`, and `afterMinutes` for a scheduled cleanup.
- `run-command`: shell in the lane worktree (`validateAutomationCwd`).
- `run-tests` (`suiteId`), `predict-conflicts`, `agent-session` (`prompt`).
- `handoff`: hands the trigger's chat to another model through `handoffSession`. `handoffMode` `brief` (default) or `fork`; `targetModelId` required; `targetLaneMode` `same` (default), `new` or `explicit` (needs `targetLaneId`). A fork must stay in the source lane (`validateHandoffLaneTarget`, at save and run). Needs a `session.*` trigger. The new session id is published on `runs-updated` (`handoffSessionId`); the renderer builds the `HandoffLaunchJob`.
- `ade-action`: `RunAdeActionConfig` `{ domain, action, args, resolvers? }` for an allowlisted pair (`isAllowedAdeAction`). Before any `chat` domain action, `stripHostAuthoredMessageProvenance` removes host-only metadata keys, so a rule cannot forge spawn provenance ([Chat](../chat/README.md#mission-ownership-decides-the-wake)).

**Send notification to mobile app** is an `ade-action` step for
`attention.sendNotification` with its own editor: `title` (≤ 64), `body`
(≤ 160) and `open` (built by `notifyLink.ts` from a picker: DAEX places, this
project's chats/PRs/lanes, trigger values, or run values like
`{{run.chatSessionId}}` and the run's history link). Saving validates it
(`sendNotificationStepProblem`). At run time it pushes to every phone on the
account, limited to 60 an hour; a link that resolves to nothing openable is
dropped and named in `linkSkipped`. See
[Custom notifications](../sync-and-multi-device/push-notifications.md#custom-notifications).

### Deferred cleanup lifecycle

`automation_scheduled_cleanups` rows move `scheduled → executing → executed |
failed | cancelled`. The sweep runs at startup and every 60 s and retries rows
left `executing` by a crash. Outcomes append to the originating run.

## Rule provenance

Optional, additive fields:

- `origin`: `user` (default), `cto`, `chat-menu`; unknown values read as `user`.
- `scope`: `{ sessionId, sessionTitle }` for a chat's rule; the title is stored so it survives the chat.
- `originRequest`: the sentence that created the rule.
- `oneShot`: deleted after the first **successful** run (a failure keeps it, because the job is not done).
- `maxRuns`: a hard ceiling on all runs, not gated on `oneShot`. A one-shot rule with none gets 3 (`ONE_SHOT_DEFAULT_MAX_RUNS`); chat-menu auto-handoff rules always set it.

`saveDraft` is the single write path and upserts by id. The run count lives in
`kv` (and `automations.runs.<id>` for account rules), so pruning history cannot
reset a budget. A one-shot deletion re-reads the config just before writing.

## Natural-language rule authoring

`automationPlannerService.ts`: `parseNaturalLanguage` (a Claude or Codex CLI
planner subprocess; returns a draft, confidence, ambiguities and issues),
`validateDraft`, `saveDraft`, and `simulate` (the builder uses test runs
instead). Planner JSON goes through `extractFirstJsonObject` and is always
validated before saving.

## Gotchas

- **Relay draining is page-durable** (see the README). The drain yields to the event loop after each event, because synchronous SQLite ingest otherwise held the brain for seconds on a fresh DAEX Cloud computer.
- **A project's first drain skips the relay's history.** With no saved cursor, DAEX reads the newest cursor, runs `reconcileGithubStacks`, and saves the cursor only after that repair (after 3 failed repairs in one run it saves anyway and reports `automations.github_relay_history_repair_failed`). Older events ran on the machines that had the project then.
- **Direct GitHub polling is demand-gated** every tick.
- **External triggers need a ready delivery path before enable** (`computeDeliveryStatuses`, `getIngressSetupError`).
- **`session.*` rules for one chat must set `trigger.sessionId`**, or they fire for every chat.
- **Actions are allowlisted** in `ADE_ACTION_ALLOWLIST`; that list is the audit surface.
- **Placeholders.** `{{trigger.*}}` reads only the current trigger. A string that is one whole placeholder keeps the raw value (and stays as written when missing); inside longer text a missing value becomes empty. `{{run.*}}` fills in as the run goes: `run.chatSessionId` exists only after an `agent-session` step, and on a DAEX Cloud run `run.laneId` and `run.chatSessionId` stay empty.
- **`file.change` watchers are per lane**; tear down the old watcher rather than mutating `WatchedFileRoot`.

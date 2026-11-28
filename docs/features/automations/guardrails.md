# Guardrails

Guardrails keep an automation from publishing (comments, PRs, Linear updates,
webhooks) silently when a run is low-confidence or held for review. Scoring,
the queue, cwd checks and secret resolution all run in the brain that owns the
project; the renderer edits and shows them.

## Source file map

- `apps/desktop/src/main/services/automations/automationService.ts`: confidence (`computeConfidence`), queue status (`deriveQueueStatus`, `normalizeQueueStatus`), publish gate (`requiresPublishGate`), dry-run permission modes, cwd checks (`resolveAutomationCwdBase`, `validateAutomationCwd`).
- `apps/desktop/src/main/services/automations/automationSecretService.ts`: env-ref-only secrets.
- `apps/desktop/src/main/services/automations/automationPlannerService.ts`: rule validation before save.
- `apps/desktop/src/shared/automationLimits.ts`: agent and step limit bounds.
- `apps/desktop/src/main/services/usage/budgetCapService.ts`: budget caps.
- `apps/desktop/src/shared/types/config.ts`: `AutomationGuardrails`, `AutomationOutputs`, `AutomationVerification`.

## Gotchas

- **Agent turns have no default clock.** Do not add one or a floor; a `0` means
  no limit.
- **The threshold penalty is fixed**: `max(0, threshold - 0.65) * 0.25`.
  Raising the threshold lowers confidence.
- **`dry-run` forces plan mode** for every provider. Do not assume a dry run
  edits files.
- **`verification_required = 1` is sticky** until the review decision is
  applied; changing it mid-run without the status transition leaves the queue
  inconsistent.
- **Publish comes after verification.** Do not publish from inside the action
  loop without the queue gate.
- **Missing env secrets fail the run** with a clear error, never a silent skip.

## Agent limits (opt-in)

An automation's agent turn has **no clock by default**: it runs until it
finishes or someone stops it. Cost is capped by the global budgets in the
header Usage popup, not by time. Two optional limits on the agent step
(`execution.session`, or an `agent-session` action), typed
`AutomationAgentLimits`:

- `stopAfterMin`: interrupt after this many minutes.
- `stopWhenIdleMin`: interrupt after this many minutes with no activity. The
  watch restarts on every event and pauses while a tool call, command,
  foreground subagent or approval is open. Background subagents are not
  tracked, so waiting only on one can read as idle.

Either calls the chat interrupt (`runSessionTurn`'s `timeoutMs` /
`idleTimeoutMs`), fails the run with the reason and leaves the chat open. With
neither, `agentTurnLimits` passes `timeoutMs: null`, so the chat service's
5-minute headless default never applies. `normalizeAutomationAgentLimits`
normalizes at save, load and dispatch and clamps to 7 days; the chat service
floors each timer at 15 s; non-positive means none. The builder shows both
behind a **Limits** row.

A turn that ends `interrupted` or `failed` never counts as success
(`unfinishedAgentTurn`): later non-`alwaysRun` steps do not run and a one-shot
rule is not retired. A stop, or a chat ended or deleted mid-turn
(`SessionTurnAbandonedError`), is not retried even with `retry`
(`NonRetryableActionError`); provider failures and limit stops are.

A `run-command` step's `timeoutMs` is separate: a kill switch for a hung
process (default 5 min, max 12 h), shown as **Time limit**. Agent steps ignore
it. There is no rule-level duration or dollar guardrail; old
`guardrails.maxDurationMin` / `budgetUsd` values are dropped on parse and save.

## Guardrails on a rule

`AutomationGuardrails`: `activeHours` (see the README gotchas),
`confidenceThreshold` (0..1; below it the run lands in
`verification-required`), `maxFindings`, `reserveBudget`.

`reviewProfile` sets the confidence base:

| Profile | Base |
| --- | --- |
| quick | 0.58 |
| incremental | 0.64 |
| full | 0.73 |
| security | 0.79 |
| release-risk | 0.75 |
| cross-repo-contract | 0.68 |

`computeConfidence(rule)`:

```
value = clamp(base + min(0.12, contextSources * 0.015) - max(0, threshold - 0.65) * 0.25, 0.2, 0.95)
```

Labels: `high` at 0.78 or more, `medium` at 0.52 or more, else `low`.

## Verification

`AutomationVerification` is `{ verifyBeforePublish, mode?: "intervention" |
"dry-run" }`. `dry-run` forces plan mode (Claude, Codex, OpenCode, Cursor) and
tells the agent not to publish. `requiresPublishGate(rule)` is true when
`verifyBeforePublish` is set and the mode is not `dry-run`; such runs set
`verification_required = 1`, land in the review queue, and get a narrower
default permission mode.

Queue statuses (`AutomationRunQueueStatus`): `pending-review`,
`actionable-findings`, `verification-required`, `completed-clean`, `ignored`,
`archived`. Run statuses (`AutomationRunStatus`): `queued`, `running`,
`succeeded`, `failed`, `cancelled`, `paused`; legacy `needs_review` reads as
`succeeded`.

## Outputs

`AutomationOutputs.disposition`: `comment-only`, `open-task`, `open-lane`,
`prepare-patch`, `open-pr-draft`; plus `createArtifact` and
`notificationChannel`. Only the `github`, `linear` and `browser` tool families
can publish (`PUBLISH_CAPABLE_TOOL_FAMILIES`); `repo`, `git` and `tests` cannot.

## Secrets

`automationSecretService.ts` accepts only `${env:VAR_NAME}` references at
sensitive keys, rejects raw secret-like values, and resolves at dispatch from
the brain's environment. This covers webhook secrets, relay access tokens and
tokens used by built-in actions.

## Scope and sandboxing

Built-in shell actions stay inside the lane worktree (or the project root with
no lane): `resolveAutomationCwdBase` picks the base and `validateAutomationCwd`
rejects any cwd outside it, through symlink-aware `resolvePathWithinRoot`.

Agent-session rules use the chat permission model. They run full-auto unless the
rule or step picks a mode. In any other mode, a card raised during the
automation's own turn is refused at once (nobody can answer it): the agent is
told, the run continues, and the chat keeps the card and a notice. Linear agent
runs are the exception; the delegator answers from Linear.

## Budget caps

Set in the header Usage popup (`HeaderUsageControl`, `UsageLimitsBand`, with
`BudgetCapEditor` from `components/settings/`). `budgetCapService` enforces
project caps; `usd-per-run` caps read usage keyed to the active run id, so a
previous run's spend does not block the next. A breach pauses the run with an
intervention. `billingCode` (default `auto:<id>`) slices spend per rule.

## Audit trail

Each run writes a run row (executor, status, queue status, confidence, spend,
trigger metadata, verification flag), one action row per step, an ingress event
row for webhook and relay triggers (normalized fields only; no raw payload), and
proof artifacts when `outputs.createArtifact` is set.

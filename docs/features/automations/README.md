# Automations

Automations are rule-based background workflows. Each rule has a trigger, a target execution surface, a prompt template or action chain, an optional tool palette, an optional output contract, and guardrails. Automations sit between the CTO (heavy, stateful, chat-driven) and raw cron (deterministic, no AI). The execution surface choice is the key control point.

There is no autonomous Linear intake pipeline. Automations can react to Linear events as context or write to Linear as an action through the shared Linear client, but no rule "owns" issue dispatch — the CTO is a chat thread that reads and lightly updates issues, not a router.

Commands below use `daex`; `ade` still works as an alias.

## Source file map

Services in `apps/desktop/src/main/services/automations/` (loaded by the brain's
project scope, and by desktop main when it hosts a project):

- `automationService.ts`: rule CRUD, dispatch (`agent-session`, `built-in`),
  cron (`node-cron`), file-change watching, queue, run history, confidence,
  billing codes, ingress cursors, deferred lane cleanup, `lane.merged`.
  Scheduled callbacks first claim a `(project, rule, trigger index, cron,
  minute)` row in machine-local `automation_schedule_occurrences`, so runtimes
  sharing a database elect one executor (claims pruned after 35 days). Ingress
  rows keep no raw payload and are pruned at write time (7 days; newest 2,000
  non-`dispatched` rows per project) with bounds from `state/dbMaintenanceApi`.
- `automationRuleAccountStore.ts`, `automationRuleAccountSync.ts`: rules that
  follow the account. See [Rules follow the account](#rules-follow-the-account).
- `automationCloudRegistrar.ts`: sends DAEX Cloud-homed rules to the server.
- `automationPlannerService.ts`: natural-language authoring
  (`parseNaturalLanguage`, `validateDraft`, `saveDraft`, `simulate`) through a
  Claude or Codex planner subprocess.
- `automationIngressService.ts`: local webhook server, GitHub relay drains and
  the repo WebSocket wake-up, signature checks, the PR-freshness-only mode
  (`automationService: null`, cursor in kv via `createKvIngressCursorStore`).
  See [Webhook, relay, and polling ingress](#webhook-relay-and-polling-ingress).
- `customWebhookService.ts`: custom webhook URLs: tokens
  (`automation_webhook_hooks`), relay registration, the check order
  ([Triggers and actions](triggers-and-actions.md#how-a-custom-webhook-delivery-is-handled)),
  the delivery log (`automation_webhook_deliveries`), replay and **Send test**.
  Renderer: `builder/WebhookTriggerPanel.tsx`, `builder/WebhookDeliveries.tsx`;
  shared: `shared/automationWebhooks.ts`.
- `automationTestRun.ts`: test runs (`createAutomationTestRuns`,
  `safeTestRule`, `safeTestHoldsBack`, `testStepEffect`). See [Test runs](#test-runs).
- `automationPrBranchLane.ts`: `resolvePrBranchLane` for `laneMode:
  "pr-branch"`: reuses the lane linked to the PR (on its head branch) or imports
  the head branch through `prService.createLaneFromPrBranch`. Before reuse,
  `advanceLaneToPrHead` fetches `pull/<n>/head` into `refs/ade/pr-head/<n>` and
  fast-forwards; a dirty or diverged lane fails the run. Never falls back to
  another lane.
- `githubPollingService.ts`: direct GitHub REST polling for the origin repo and
  `extraRepos`; does nothing unless an enabled rule has a `github.*` trigger.
- `linearAutomationDispatch.ts`: Linear relay event → trigger dispatches.
- `linearIngressService.ts`, `linearRelayConfig.ts`: Linear events over the
  relay (a workspace webhook from `setup()`, which needs a workspace admin, or
  the DAEX Linear app's own webhook, `appManaged`).
- `cursorCloudIngressService.ts`: Cursor Cloud `statusChange` events over the
  relay, polled every 45 s only while an enabled `cursor.*` rule exists.
- `automationSecretService.ts`: `${env:VAR}` secrets.

Limits: `apps/desktop/src/shared/automationLimits.ts`
(`normalizeAutomationAgentLimits`, `RUN_COMMAND_DEFAULT_TIMEOUT_MS`,
`RUN_COMMAND_MAX_TIMEOUT_MS`) and `main/services/chat/sessionTurnLimits.ts`.

Shared: `shared/automationAvailability.ts`, `shared/automationHome.ts`
(leases, handover, the cloud home), `shared/automationFeatureVersions.ts`,
`shared/types/automations.ts`, `shared/types/config.ts`.

### GitHub relay and App

- `apps/webhook-relay/`: the hosted Cloudflare Worker. Stores GitHub App
  deliveries in D1 by delivery id and serves repo-scoped
  `/github/repos/:owner/:repo/status`, `/events` (`seq:<n>` cursors,
  `order=asc&limit` with `hasMore`) and `/subscribe` (WebSocket wake-ups from
  `RepoEventsDurableObject`, about one frame a second, no payload). Events are
  kept 7 days and slimmed before storage. `POST .../webhook/heal` (admin)
  re-syncs the App webhook secret; `GET .../webhook/deliveries` proxies the
  repo's delivery log. Custom hooks live here too. See
  `apps/webhook-relay/README.md`.
- `main/services/github/githubRelayConfig.ts`: relay base URL and auth mode;
  `fetchAppInstallationStatusForRepo`; a 401 reports `appUserAuthFailure`.
- `main/services/github/githubAppUserAuth*.ts`: the App user token: device flow
  (`githubAppUserAuthDeviceFlow.ts`), token store, lease and
  `getValidTokenForRelay` (`githubAppUserAuthService.ts`), the refresh ledger
  (`githubAppUserAuthLedger.ts`), failure classification
  (`githubAppUserAuthFailure.ts`) and raw HTTP helpers (`githubAppUserAuth.ts`;
  use `isGitHubOAuthError`, not `instanceof`, since two hosts load it through
  different paths). See
  [Refresh storms](#how-ade-stops-a-github-app-refresh-storm).
- `apps/ade-cli/src/services/credentials/credentialChangeRelayRepair.ts`: in
  the brain, ends the relay's auth-pending cooldown when the App credential
  changes on disk (desktop gets this from `githubService`'s
  `onAppUserAuthChanged`).
- `main/services/github/githubService.ts`,
  `renderer/components/github/GitHubAppInstallPanel.tsx`: install, check,
  authorize and disconnect the GitHub App per repo.

### Actions, renderer, IPC

- DAEX actions (`main/services/adeActions/`): `registry.ts` (dispatch table),
  `actionPolicy.ts` (`ADE_ACTION_ALLOWLIST`, `ADE_ACTION_CTO_ONLY` and their
  predicates), `actionInputContracts.ts` (documented inputs, read by `daex
  actions describe`), `actionArgs.ts` (validators), `sessionBoardMove.ts`.
- Renderer: `apps/desktop/src/renderer/components/automations/` (see
  [ui-design.md](./ui-design.md)), `components/usage/` (the Usage popup with
  automation budgets) and `components/terminals/AutoHandoffModal.tsx` (the chat
  menu's **Hand off…** rules: `origin: "chat-menu"`, deterministic ids,
  read-only in the builder).
- IPC and RPC: `window.ade.automations` (`preload/global.d.ts`), handlers in
  `main/services/ipc/registerIpc.ts` routed to the project's runtime, and the
  brain's JSON-RPC actions (`apps/ade-cli/src/multiProjectRpcServer.ts`). As
  `ade-action` steps, `automations.linearIngressSetup` / `Teardown` are
  CTO-only.

## Gotchas

- **Read `rule.triggers`.** Legacy `trigger` is normalized by
  `normalizedRuleTriggers` / `primaryTrigger`. `commit` aliases to
  `git.commit`; legacy `git.pr_*` alias to `github.pr_*`
  (`LEGACY_GITHUB_PR_TRIGGER_ALIASES`).
- **`lane.merged` is not `github.pr_merged`.** Go through `notifyLaneMerged` or
  the restart-safe per-PR dedupe is lost.
- **Deferred cleanup appends to the original run**, so `actions_total` can grow
  after the chain ends.
- **The polling cursor parser handles three shapes** (bare `<iso>`,
  `<slug>=<iso>`, multi-repo `<slug>=<iso>|…`). Don't simplify it without a
  migration.
- **Validate cron before installing** (`cron.validate` plus the 5-field split).
- **Signature checks are timing-safe** (`safeCompareSignature`). Keep them so.
- **Relay wake-ups are not deliveries.** Drain ascending pages in order, persist
  each `nextCursor` after its events, reconcile linked PRs once per drain, and
  let a per-event failure advance the cursor (a poison event must not freeze
  ingest); only a page or transport failure leaves the cursor for replay and
  clears relay health. Shutdown and config changes close the socket and clear
  every timer.
- **Agent turns have no default clock.** `agentTurnLimits` passes `null` unless
  the step sets a limit; never add a default or floor.
- **Active hours read the zone's clock** (`trigger.activeHours.timezone`, IANA;
  `local` or unknown reads the machine's clock). A computer fires cron on its
  own clock; `trigger.timezone` is read only by DAEX Cloud.
- **Ingress runs are claimed when they start** (`run_claim` on
  `automation_ingress_events`). Pass `claimStart` through `runRule` for a new
  ingress path; never clear a claim.
- **Every rule is yours.** `.ade/ade.yaml` is no longer read, so a clone cannot
  add a rule; there is no trust gate.
- **Legacy relay tokens are env refs** (`automations.githubRelay.accessToken`),
  resolved through `automationSecretService`.

## Runtime ownership

The automation rule engine, cron scheduler, deferred-cleanup sweeper, file watcher, ingress endpoints (webhook listener, GitHub relay/polling, Linear relay), and built-in action runner all execute inside the DAEX runtime (`daex serve`) that owns the project. For local project bindings the local runtime hosts them; for remote project bindings the remote runtime hosts them. The desktop renderer is a view: it edits rules, watches run history, and triggers manual fires through `window.ade.automations`, but it does not own scheduling, ingress, or dispatch state.

The Automations tab combines rules from every machine that has the repository.
Each row carries its owner, and edit, enable/disable, delete, run, and history
reads target that machine. Creating a rule chooses its execution machine when
more than one is eligible. Moving a rule creates a paused copy on the target,
deletes the original, then enables the copy; if deletion fails, the target copy
stays paused so both machines cannot run the rule at once. A rule that follows
the account (below) is not copied: every machine already lists it once, under
the machine that runs it, and **Runs on** only changes its home.

### Rules follow the account

Rules are stored in the account, per repository, so a rule made on one
computer shows on every computer that opens the same repository. The brain's
account settings store (`accountSettingsStore`, the store lane templates and
the CTO home use) holds rows per rule under `repo:<host>/<owner>/<repo>`:
`automations.rule.<id>` (the rule), `automations.home.<id>` (the computer that
runs it) and, for a rule with a run limit, `automations.runs.<id>` (runs
counted so far). One row per rule rather than one list, and the home and the
count in rows of their own, because the store keeps the strictly newer stamp
per key: a list saved on one computer would drop a rule another had just
added, and a home inside the rule would let an edit on one computer undo a
change of home on another.

Storage is `automations/automationRuleAccountStore.ts`; the rules' account
side (merge with `local.yaml`, saves, moves, confirmations) is
`automations/automationRuleAccountSync.ts`, which `projectConfigService` calls.
The brain attaches both in `apps/ade-cli/src/bootstrap.ts` and, after every
account sync, runs `migrateAutomationRulesToAccount` then
`reconcileAutomationRules`.

- **One home runs it.** A home is `{ deviceId, name, chosenAt, checkout }`:
  the sync device id (as `ctoHomeMachine` uses) plus a hash of the checkout's
  path, so two checkouts of one repository on one computer never both run it.
  The home is the computer that created the rule, or that moved it out of
  `local.yaml`. `projectConfigService` stamps `runsHere` on each effective
  rule; `automationService` schedules, watches and dispatches only `runsHere`
  rules (`listRunnableRules`, plus a check in `runRule`), the ingress
  `listRules` is filtered the same way, and Run now elsewhere refuses with
  "runs on <computer>". Other computers show, edit, enable and delete it.
- **The lease.** A home starts a synced rule on a trigger only while it has
  synced with the account in the last `AUTOMATION_HOME_LEASE_MS` (10 minutes,
  `shared/automationHome.ts`). A home that is offline or signed out longer
  than that cannot know whether another computer took the rule over, so it
  marks it `homeOutOfTouch` ("Paused here · can't reach your DAEX account") and
  stops starting it until it syncs again. Run now still works. A brain with no
  account service (`--no-sync`) has no other computer and no lease.
- **Changing the home.** **Runs on** in the rule editor, `saveRule` with
  `draft.home`, or `ade automations run-on <id> [--device <sync-device-id>
  --name <computer>]` (`automations.setRunOn`). Only the home row is written
  when the rule itself is unchanged. The editor saves through the new home (as
  "this computer"), so the home names its own checkout; a home named for
  another computer by device id (the CLI's `--device`) has no checkout yet,
  and that computer claims it for its checkout after its next sync. The new
  home waits `AUTOMATION_HOME_HANDOVER_MS` (the lease plus 2 minutes, 12
  minutes; `homeStartsAt`) before triggered runs, so the old home has either
  seen the change or run out its lease; Run now does not wait. A rule with a
  run limit records each run in `automations.runs.<id>`, and the new home
  counts from there, so `maxRuns` and one-shot hold across a move.
- **What stays on this computer** (`localReason`, shown under **Runs on** and
  on the row): rules scoped to one chat (`chat`: the chat lives here), a
  project with no remote (`no-remote`), a rule over the relay's 16 KB per
  setting (`too-large`; an account rule that would grow past it refuses the
  save instead), and rules saved while signed out (`signed-out`) or under
  another account (`other-account`). A brain without the account store (the
  in-process test host) keeps everything in `local.yaml`.
- **Moving existing rules.** Once the store has synced in this run of DAEX
  (and after every sign-in), `local.yaml` rules move into the account and
  leave the file; before that sync the copy may lack a rule another computer
  filed under the same id, so nothing moves and no new rule is filed. Until
  then they show and run as before. An identical rule the account already
  holds is dropped (its home runs it); a different rule that only shares the
  id is filed as `<id>-<device>`.
- **Races.** Two computers can file different rules under one id before
  either sees the other's (a move or a new rule in the same moment). Each such
  write is kept in `.ade/automation-rules.state.json` until a sync has
  confirmed it; if the account kept the other computer's rule, this one is
  filed again as `<id>-<device>` (`projectConfig.automation_rule_race_readded`).
- **Stale writers.** Only the rule methods (`saveAutomationRule`,
  `deleteAutomationRule`) edit or delete an account rule. A generic
  `projectConfigService.save` carries a snapshot that may be minutes old, so it
  may only add a new rule; it can neither undo another computer's edit nor
  delete a rule by leaving it out, and a rule some computer deleted (a
  tombstone) does not come back.
- **Signed out.** The account store hides its rows while signed out, so the
  state file keeps a copy of the account's rules, read only while signed out:
  rules keep showing and the home keeps running them. Edits made signed out
  wait in `local.yaml` with their home and move on sign-in, unless another
  computer deleted the rule after the edit was made (the delete stands);
  changing the home or deleting an account rule asks you to sign in. An edit
  saved under one account never moves into another, by a move or by a later
  save; switching accounts drops the store's unsent writes, and confirmations
  bring those rules back when their account signs in again. Synced rules
  homed here stop starting on triggers once the lease runs out.
- **Remote changes.** When the repository's remote changes (a rename), the
  first read under the new key copies the rules from the old one; the old rows
  stay for computers still on the old remote.
- **Older and newer DAEX.** An older brain never reads or writes
  `automations.*` rows, so it cannot wipe them; a rule it adds to `local.yaml`
  moves the next time a new brain starts. A rule this DAEX cannot read back
  exactly (a newer DAEX's trigger, step or field) is shown paused with
  `needsNewerAde`, never run, and refuses edits, so it cannot be stripped.
- **Machine-local gaps.** A rule homed here that names what only another
  computer has (a lane, a test suite, a folder, a webhook gateway, a webhook
  URL, a secret) lists it in `homeGaps`, shown in a banner over the editor.
  Config validation does not reject a synced rule for a test suite this
  computer lacks; only its home cares, and says so here.
  Secrets never move. A delivery the old home receives for a rule that moved
  is logged as "Matched '<rule>', which runs on <computer>".

### Availability

Automations ship **enabled in every build** — packaged desktop apps and installed daemons included. `areAutomationsEnabledForPackagedState` (`shared/automationAvailability.ts`) returns `true` regardless of the packaged flag; `ADE_DISABLE_AUTOMATIONS=1` is the kill switch and `ADE_ENABLE_AUTOMATIONS=1` still forces the feature on. The runtime reports the resolved state as `AppInfo.automationsEnabled`, and the `/automations` gate (`AutomationsProductionGate` in `AutomationsPage.tsx`) reads it, falling back to the old "off when packaged" rule only against a runtime too old to send the flag. When the kill switch is set the tab renders the disabled screen (`AutomationsComingSoon.tsx`, "Automations are disabled on this build.").

The ingress service keeps a reduced **PR-freshness-only mode** for exactly that kill-switch case. When automations are unavailable, the GitHub relay poll still runs so webhook-driven PR state updates reach `prService.ingestGithubWebhook`, while automation rule dispatch, the local webhook HTTP server, and ingress status/event reporting stay gated. See `automationIngressService.ts` in the source file map below.

Caveat: GitHub-polling and webhook ingress only work on a runtime that can reach the public internet (or your relay). A remote runtime behind a firewall may need the relay path even if the local desktop is internet-reachable.

### With no computer awake

On a DAEX Cloud tab (`isAdeCloudBinding`), `AutomationsPage` shows `AutomationsAccountList` in place of the builder. It reads from the account, and it never wakes a computer:

- The rules come from the repository's account settings (`automations.rule.*` and `automations.home.*`, `accountRepoScopeKey(origin)`).
- For a rule whose home is DAEX Cloud, `GET /cloud/automations?origin=` adds the server's copy: its state (on, off, or "Paused after too many runs") and its last runs.
- Each row shows the trigger sentence, the home ("Runs on …", or "(not on now)" for an own computer that is not on), the next cron run and the last runs.
- The list is read-only. To add or edit a rule, open the project on a computer. DAEX Cloud rules keep running with no computer on.
- It reads once when the tab opens, and again on Retry. A failed read shows the account's sentence with Retry. When only one of the two reads fails, the rows that came back stay and a second banner names the part that failed. It never shows an empty list for a failed read.

## Core model

Each `AutomationRule` carries:

- `id`, `name`, `description`, `enabled`.
- `home` — the one computer (and checkout) that runs a rule that follows the account; `runsHere` (computed per brain) is false everywhere else, `homeStartsAt` is the end of a change of home's wait, `needsNewerAde` marks a rule this DAEX cannot read whole, and `localReason` says why a rule is kept on this computer only.
- `origin` — who created the rule: `user` (default), `cto`, or `chat-menu`. A config written before this field existed has no `origin` and reads as `user`.
- `scope` — the chat a rule belongs to: `{ sessionId, sessionTitle }`. The title is stored on the rule, so a rule created from a chat that was later deleted still has a readable label.
- `originRequest` — the sentence that created the rule, kept verbatim.
- `oneShot` — when true, the rule deletes itself after its first successful run.
- `maxRuns` — a hard run ceiling, counting failures too, enforced whether or not the rule is one-shot. Absent means unlimited; a one-shot rule defaults to 3.
- `triggers` — one or more trigger descriptors (see `triggers-and-actions.md`). Normalized to a single primary trigger for legacy compatibility.
- `execution` — which surface launches. `AutomationExecution`:
  - `{ kind: "agent-session", targetLaneId?, laneMode?, laneNamePreset?, laneNameTemplate?, session? }` — launches a scoped AI chat thread, recorded as an automation-only chat. `laneMode: "create"` creates one lane for the run; its custom name template supports `{{trigger.*}}` plus `{{date}}` (`YYYY-MM-DD`), `{{time}}` (`HH:mm`), and `{{rule.name}}`. `laneMode: "pr-branch"` (pull request triggers only) runs in a lane on the trigger PR's own head branch: the lane already linked to that PR, or a new lane imported through `prService.createLaneFromPrBranch`, the same path as the PRs tab. It never falls back to another lane; an archived mapped lane or a blocked import fails the run's `lane-setup` row. `session` carries optional `title`, `reasoningEffort`, and `codexFastMode` (boolean); `codexFastMode` is forwarded to the chat service only when the resolved provider is Codex and the model supports fast mode, so it is safe to set on a rule that may later switch models.
  - `{ kind: "built-in", targetLaneId?, builtIn: { actions: [...] } }` — runs DAEX-native deterministic actions (`AutomationAction[]`).
- `executor` — always `{ mode: "automation-bot" }` (the automation system identifies itself that way in logs).
- `reviewProfile` — `quick` | `incremental` | `full` | `security` | `release-risk` | `cross-repo-contract`. Drives confidence base and output expectations.
- `toolPalette` — explicit tool family list (`repo`, `git`, `tests`, `github`, `linear`, `browser`).
- `contextSources` — e.g. recent PRs or configured project context sources.
- `guardrails` — `activeHours`, `confidenceThreshold`, `maxFindings`, `reserveBudget` (see `guardrails.md`). Agent turns have no time cap unless the agent step opts into `stopAfterMin` / `stopWhenIdleMin` (see `guardrails.md` → Agent limits).
- `outputs.disposition` — `comment-only` | `open-task` | `open-lane` | `prepare-patch` | `open-pr-draft`.
- `verification` — `verifyBeforePublish` + `mode` (`intervention` or `dry-run`).
- `billingCode` — tracks spend per rule (default `auto:<id>`).

## Trigger classes

Automations support two broad trigger classes:

1. **Time-based** — `schedule` with a 5-field cron expression. `computeNextScheduleAt` walks forward in 1-minute steps (bounded at ~1 year) to find the next match using `parseCronPart` for `*`, `*/N`, ranges, and lists.
2. **Action-based** — `manual`, `git.commit`, `git.push`, `git.pr_opened`, `git.pr_updated`, `git.pr_closed`, `git.pr_merged`, `lane.created`, `lane.archived`, `lane.merged`, `file.change`, `session-end`, `session.limit_reached`, `session.failed`, `session.ended_without_pr`, `session.settled`, `webhook`, `github-webhook`, various `linear.*` events.

The `commit` trigger is an alias for `git.commit` (normalized by `normalizeTriggerType`).

Current action coverage is intentionally focused — the runtime semantics stay predictable and easy to debug. See `triggers-and-actions.md` for the full trigger and action surface.

## Execution surfaces

### agent-session

Best for lightweight autonomous text-work: reviews, audits, short summaries, status checks.

**One chat for every run.** `execution.session.chatSessionId` makes each run a new turn in that existing chat instead of a new chat per run (the builder's "Where it runs → Keep it in one chat"; it defaults to the chat the rule was created from, `rule.scope.sessionId`). No lane is created: the chat already has one. The prompt arrives with the display text `<rule name> · <trigger summary>`, and the chat keeps the whole history, which suits a triage thread that hears about every webhook delivery. Runs queue per chat (one turn at a time); while the chat is busy or waiting on the user, the run retries every 5 seconds for up to 30 minutes. A deleted chat fails the run with a message that says so.

- Launches through `agentChatService.createSession` with the rule's prompt template and allowed tools. A Cursor model, including a Cursor SDK model, stores its permission on `permissionConfig.providers.cursor`. Full Auto and Plan that an older builder saved on `providers.opencode` for that model still launch as Cursor full-auto and plan. A step or rule with no stored mode (**Rule default**) runs full-auto on every provider, and Codex then gets `danger-full-access`. Dry-run rules run in plan mode, and a rule held for review before it publishes keeps its narrower default.
- Records the session as an automation-scoped chat.
- Appears in Automations > History as a thread.
- Minimal orchestration overhead — no planner, no run-graph, no worker pool.

### built-in

Best for deterministic DAEX operations.

- Runs a sequence of `AutomationAction` steps with typed input/output.
- `AutomationActionType` values: `create-lane` (spawns a new lane and threads it into the rest of the chain), `delete-lane` (immediate or deferred cleanup), `run-command` (shell), `run-tests`, `predict-conflicts`, `agent-session` (embedded agent step), `handoff` (hands the trigger's chat to another model), `ade-action` (see below).
- Each action may override `targetLaneId` for that step alone; `agent-session` actions additionally accept `modelConfig` and `permissionConfig` overrides that layer on top of the rule's defaults (allowed-tool lists are merged, not replaced). `alwaysRun: true` gives a trailing action finally semantics after an earlier non-continuable failure; the original failure remains the run's overall status. See `triggers-and-actions.md` for the override resolution order.
- No separate worker thread.
- Low overhead; sandboxed to the target lane's worktree via `validateAutomationCwd` and `resolvePathWithinRoot`.

The `ade-action` action type dispatches directly into a main-process domain service through the DAEX Actions registry (`apps/desktop/src/main/services/adeActions/registry.ts`, gated by `actionPolicy.ts`). `RunAdeActionConfig` points at a `domain` + `action` on the allowlist (e.g. `pr.addComment`, `linear_sync.runSyncNow`, `issue.close`), with `args` that may embed `{{trigger.*}}` placeholders resolved from the trigger context at dispatch time, or an explicit `resolvers` map for the same. This gives built-in rules typed access to DAEX services without writing a shell command or a bespoke tool. A step that starts or prompts an agent CLI (`chat.launchCli`, `pty.sendToSession`, or `pty.create` with an `initialInput`) waits for the CLI's turn to end, not for its terminal to open: `dispatchAdeAction` calls `agentChatService.waitForCliTurn`, which settles on the pty service's turn-end signal (a quiet-output guess only when the CLI's composer is visibly back), the CLI's exit, or the step's stop-after limit (two hours by default). The step succeeds with the CLI's closing message (its Claude/Codex session file, else its last terminal lines), and fails when the CLI exited with an error or ran out of time. A turn that stops on a prompt is not over (the person may answer it in the terminal), so the step keeps waiting until that turn ends or the limit is reached. `waitForTurn: false` in the step's args keeps the old fire-and-forget step for a CLI meant to keep running. A plain shell never waits. The step editor labels the common ones from `renderer/components/automations/adeActionSchemas.ts`; **Send notification to mobile app** (`attention.sendNotification`) has its own Add step entry and editor, with a link picker for everything DAEX can open — see [Triggers and actions](triggers-and-actions.md). A new draft stays open while the rule list refreshes: `AutomationsWorkspace` remembers that a new draft is open (`draftingNewRef`), because "nothing selected" is otherwise the first-load state in which a refresh selects the first rule.

### Lane lifecycle and cleanup

`lane.merged` is emitted when `onPullRequestChanged` observes a PR transition into `merged`. The trigger carries the lane id/name/branch and structured PR number, URL, title, repo, head/base branch, and merged state, so action templates can use both lane and PR context. `notifyLaneMerged` is also public for callers that already have a complete merge notification. A persistent kv marker keyed by project, PR identity, and PR number prevents the same merge from dispatching twice across restarts.

`delete-lane` resolves only an explicit action/rule target, a lane created for the current run, or the trigger lane. It fails instead of guessing when none exists. With `afterMinutes > 0`, the action writes an `automation_scheduled_cleanups` row and succeeds with a scheduled result; otherwise it calls `laneService.delete` immediately with `deleteBranch`, `deleteRemoteBranch`, and `force` options.

The service sweeps due cleanup rows at startup and every 60 seconds. Completed or failed cleanup is appended as another `delete-lane` action result on the originating run, so it remains visible in existing run history; a cleanup failure also leaves that run failed. A lane that is already gone is recorded as a successful no-op. `listScheduledCleanups()` exposes all statuses, and `cancelScheduledCleanup(id)` changes only a still-scheduled row to `cancelled`.

### Run on DAEX Cloud

A rule can run its lane on DAEX Cloud (`execution.cloud`, "Run on DAEX Cloud"
under "Runs on" in the builder). The machine that runs the rule still watches
the trigger and keeps the history; each run starts its lane on a new cloud
computer through `cloud.lane_launch`, under the agent limits, never the
person's. The rule needs `laneMode` "create" or "pr-branch", no bound chat, and
no step that works in a lane on this machine (`automationCloudProblem`). See
[DAEX Cloud](../ade-cloud/README.md#a-new-lane).

**Runs on: DAEX Cloud** (C9) goes further: DAEX Cloud is the rule's home, so it
runs with no computer of the person's on. Picked in the builder's **Runs on**
(shown only to an account with DAEX Cloud) or with
`daex automations run-on <id> --cloud`.

- **The home.** `{ kind: "cloud", deviceId: "ade-cloud", name: "ADE Cloud" }`
  (`shared/automationHome.ts`). No computer has that device id, so every
  brain stamps `runsHere: false`. An older DAEX, which doesn't know `kind`,
  reads a whole home (device, name, time) of another computer and never runs
  it either (an empty or unknown home would read as "no home" there, which
  runs). A home moving to or from DAEX Cloud waits out the handover as any
  change of home does; the server is told `startsAt`.
- **What can come along** (`automationCloudHomeProblem`): an agent rule with
  "A new lane each run" and no bound chat, on a schedule, a custom webhook
  (no signing secret, no filters: secrets never move) or Run now. File-change,
  GitHub and Linear triggers and every local event are refused with a reason.
  A prompt may use only the variables the server fills as a computer does
  (`{{trigger.type}}`, `{{trigger.method}}`, `{{trigger.body}}` and its
  fields, `{{date}}`, `{{time}}`). Saving the home gives each trigger the
  saving computer's zone (`trigger.timezone`; a schedule's, and the prompt's
  date and time), so every brain compiles the same rule; a computer still
  reads a schedule on its own clock. Without DAEX Cloud on the account,
  `run-on --cloud` and a save to DAEX Cloud are refused. A cloud-bound rule is never kept in
  `.ade/local.yaml` (signed out, before a first sync): the save is refused,
  because a file rule runs on its computer.
- **Registration** (`automationCloudRegistrar.ts`, attached by the brain).
  After every account sync, each brain sends the server the cloud-homed
  rules whose version it hasn't sent (`automationService.cloudHomeSpec`
  compiles one: model, permissions, prompt, triggers), and points a webhook at
  the server (the relay's `POST /hooks/forward`). It takes a rule off the
  server only on positive evidence from the account: the home is now a
  computer, or a computer deleted the rule (`cloudHomes().released`), and
  then also when the server still lists it, so a release that failed or a
  restarted brain still ends it. The release names the version it saw
  (`DELETE ?through=`), so a newer save stays. An unreadable account, a rule
  a newer DAEX wrote, or a compile problem on this brain takes nothing off.
  A change of the agent limits in the vault sends every cloud rule again, so
  the server reads them. Nothing runs on a timer.
- **History.** The server keeps each rule's runs; a rule's summary carries
  them (`cloud`, read at most once a minute while rules are listed) and the
  builder shows them under **Runs on**. Run now on a cloud-homed rule asks the
  server; a refusal (agent limits, the storm stop, one waiting) shows as a
  toast.

## Cron scheduling

`automationService` uses `node-cron` for in-process cron tasks. Each enabled `schedule` rule installs a `CronTask` that fires `triggerRun` on match. `computeNextScheduleAt` lets the UI preview the next fire time.

Stability rules:

- Cron tasks are stopped on rule disable or delete.
- Tasks are re-installed on restart by re-reading enabled rules.
- Seconds are not supported (the field parser expects 5 fields).
- `sunday = 0` or `sunday = 7` both match; `parseCronPart` handles the aliasing.

## File-change triggers

`file.change` triggers use `watchTree` (`services/shared/treeWatcher.ts`: chokidar off macOS, one recursive native watch per root on macOS) to watch paths under the target lane's worktree (or project root if no lane). `WatchedFileRoot` scopes the watcher per lane. Changes are debounced and posted to `triggerRun` with the matched paths.

`globToRegExp` and `matchesGlob` are the primitives for path matching. `escapeRegExp` is used by the legacy path-list matcher.

## Webhook, relay, and polling ingress

Automations accept inbound events from four sources (`AutomationIngressSource`):

- `local-webhook` — `automationIngressService` opens an HTTP endpoint.
  - `github-webhook` events verify HMAC-SHA256 via `safeCompareSignature` (timing-safe). Secret read from `automations.githubWebhook.secret`.
  - `webhook` events are custom inbound webhooks with optional shared-secret verification.
- `github-relay` — the default hosted path. A Cloudflare Worker (`apps/webhook-relay/`) receives GitHub App webhooks, verifies the GitHub HMAC signature, and writes each delivery into D1. DAEX connects to the **repo-scoped** `GET /github/repos/:owner/:repo/subscribe` WebSocket and drains `GET /github/repos/:owner/:repo/events?after=<cursor>&order=asc&limit=100` on connect and each `github_delivery` frame. Returned pages are processed oldest-first without reversal, and `hasMore` immediately continues the drain. The durable cursor is persisted once per page, after every event in it has been attempted. Linked PR ids are attached to that commit boundary: a successful drain batches them into one targeted PR refresh, while a later page/transport failure still flushes ids from pages whose cursors were already committed. A **per-event** ingest or dispatch failure does not stall the drain: it is caught, logged (`automations.github_relay_pr_ingest_failed` / `automations.github_relay_dispatch_failed`), and the cursor still advances past that event — the delivery is already durably recorded relay-side and the background PR poller corrects PR state independently, so a single poison event can no longer replay from the same cursor forever and freeze all ingest for the repo. Only a **page/transport** failure (non-OK response, fetch abort, or a `nextCursor` that fails to advance) throws out of the loop, leaving the durable cursor at the prior page so that page replays on the next drain. Such failures mark relay health false, respect `Retry-After`, and enter an exponential 30-second-to-15-minute poll cooldown; a successful drain clears the cooldown and marks the relay healthy again. Socket reconnects use their own jittered exponential backoff with fresh auth and a catch-up drain. The interval poll remains a safety net: the configured 30-second cadence applies while the socket is down, stretching to five minutes while connected, subject to the failure cooldown. Hosted relay reads and subscriptions use either an expiring GitHub App user access token created through GitHub device flow or the existing DAEX account-token path, never the user's general DAEX GitHub PAT/OAuth/`gh auth` token. Account-authenticated event/subscription requests use the account's installed repository binding without a GitHub API round-trip; the App user token path remains the legacy fallback and requires push/write, maintain, or admin access. Read-only public-repo callers are rejected with 403. The same Worker also exposes `GET .../status` plus two repo-scoped webhook-maintenance routes for drift recovery and diagnostics — `POST .../webhook/heal` (admin-gated re-sync of the App's webhook secret) and `GET .../webhook/deliveries` (push-gated, repo-filtered proxy of the App delivery log); see the source file map above. The relay base URL defaults to `DEFAULT_GITHUB_RELAY_API_BASE_URL`. The legacy `automations.githubRelay.apiBaseUrl` + `remoteProjectId` + `accessToken` **project-token** routes (`/projects/:projectId/github/...`) remain poll-only for self-hosted relays — chosen only when a non-default base URL plus project id and access token are all set (`shouldUseLegacyGitHubRelayProjectRoute`) and do not require GitHub App user authorization.
- `linear-relay` — Linear event relay for automation triggers; Linear triggers here are context-only. Two delivery modes share the relay: a per-workspace webhook created by `linearIngressService.setup()` (requires a workspace-admin credential; per-org signing secret registered in the Worker's D1), or the DAEX Linear OAuth app (`linearAppClient.ts` — client id bundled, PKCE, `read,write,admin` scope), whose webhook Linear auto-provisions on authorization and signs with the app-level `LINEAR_APP_WEBHOOK_SECRET` the Worker holds. App-connected projects self-configure on the first poll (`isAdeAppConnection` dep) — no manual connect step; teardown never deletes the app's webhook.
- `webhook-relay` — custom webhook URLs (`webhook` triggers with `webhook.hookId`). `customWebhookService.createEndpoint` makes a hook id and token and registers the token's hash with the relay (`POST /hooks/register`, account-authenticated). The public URL is `<relay>/hooks/:hookId/:token`; the relay checks only the token hash, stores the raw request in D1 and answers `202`, so a sleeping machine loses nothing for up to 3 days. DAEX drains `GET /hooks/events?hooks=…` oldest-first and then acknowledges what it processed by id (`POST /hooks/ack`), which deletes it. A request whose processing threw (for example, a locked database) is not acknowledged and is tried again on the next drain, up to the relay's hold limit; so the relay keeps only undelivered requests and no cursor can go stale. A hibernating topic object (`hooks-account:<accountId>`, the shared `RepoEventsDurableObject`) sends a `hook_delivery` wake-up; a 5-minute safety poll covers missed hints. Signed out, the URL falls back to the user's public gateway URL or to this machine's loopback listener, and the builder says so. Signing secrets never reach the relay. A hook whose rule runs on DAEX Cloud is **forwarded** (`POST /hooks/forward {hookId, forward: {url, secret} | null}`, account-authenticated; migration `0015`): each delivery is POSTed to the account directory, signed with the hook's key, and kept until it answers 2xx (tried again on the hook's next delivery and from the relay's half-hourly cron); a 410 clears the forward. Machines never list or acknowledge a forwarded hook's deliveries, so a delivery runs in one place. The forward URL must be one of DAEX's account directories (`HOOK_FORWARD_ORIGINS` in `customHooks.ts`).
- `github-polling` — `githubPollingService` polls the GitHub REST API directly for the origin repo and any `extraRepos`, diffing per-poll snapshots to synthesize `github.issue_*` / `github.pr_*` events (opened / edited / labeled / closed / commented, and PR merged). No relay or webhook infra required. Cursor is a `<slug>=<iso>|<slug>=<iso>` string stored via `automationService.setIngressCursor({ source: "github-polling" })`; default interval is 30s, but each tick returns before network access when no enabled rule has a `github.*` trigger. Issue and PR list walks are capped (`GITHUB_REST_ISSUE_PR_LIST_MAX_PAGES`, three pages of 100 at the poller). Incremental issue lists drain oldest-first so the durable cursor advances through the processed prefix; `/pulls` is newest-first and has no `since`, so a full page budget does not advance the cursor to that newest timestamp. The first poll snapshots known PRs without fetching reviews for every historical row.

Ingress events normalize to `AutomationIngressEventRecord` with `source`, `eventKey`, `triggerType`, `summary`, plus `cursor` for relay/polling replay. Matching rules are resolved by `eventKey`-to-rule-id mapping. An optional `repo` filter on a rule's trigger (e.g. `github.issue_opened` with `repo: "owner/name"`) restricts dispatch when multiple repos are polled. The record no longer carries the raw payload — DAEX keeps only the normalized fields — and the `automation_ingress_events` row is bounded at write time (7 days, and the newest 2,000 non-`dispatched` rows per project), with the storage doctor sweeping the same table on its schedule. See [Storage and recovery](../storage-and-recovery/README.md#database-maintenance-hooks).

Enabling an externally triggered rule is capability-gated by the paths that can actually fire it, computed once per status read by `computeDeliveryStatuses`. It resolves the live availability of each path (relay configured, GitHub polling capable, local webhook listening/healthy, public gateway ready, Linear ingress capable) and returns an `AutomationIngressDelivery` — one `AutomationTriggerDeliveryStatus` (`ready`, the winning `via` path, and a human `setupError`) per source class: `github`, `githubWebhook`, `webhook`, and `linear`. Canonical `github.*` rules are ready if any of relay, direct polling, local webhook, or public gateway is available (in that preference order); `github-webhook` needs relay, local webhook, or public gateway; custom `webhook` needs local webhook or public gateway; `linear.*` needs the injected Linear-ingress capability. `triggerDeliveryKeyForType(type)` (`shared/types/automations.ts`) maps a trigger type to its delivery key (`github.*` and legacy `git.pr_*` → `github`, `linear.*` → `linear`, `github-webhook` → `githubWebhook`, `webhook` → `webhook`, everything else → `null`), and `getIngressSetupError(rule)` returns the first not-ready source's `setupError` — so the message points to the corresponding Automations setup rather than requiring DAEX Webhook Gateway for every external trigger. `getIngressStatus()` returns the whole `AutomationIngressDelivery` as an optional `delivery` field (optional for compatibility with remote runtimes built before per-trigger delivery reporting); the renderer reads it to gate the `TriggerCard`/`RuleRow` delivery callouts. There is no separate "does this rule need external ingress" allowlist to keep in sync — the reconcile loop calls `getIngressSetupError` for every enabled rule and lets a `null` result mean "no external ingress required".

<a id="how-ade-stops-a-github-app-refresh-storm"></a>
## How DAEX stops a GitHub App refresh storm

The GitHub App user credential is one record per machine, and its refresh token
**rotates**: each successful refresh invalidates the token that was POSTed.
GitHub treats a reuse of a rotated refresh token as theft and revokes the whole
grant. So the number of processes allowed to POST that refresh is one.

A machine runs many more than one: the desktop app and the brain each build a
service per project scope, and the CLI builds its own. A per-instance in-flight
promise coordinates nothing across processes. Four mechanisms keep it to one
POST, and all four are load-bearing.

**One file.** `github.appUserToken.v1` is a file-backed credential key
(`FILE_BACKED_CREDENTIAL_KEYS`), so it lives in the shared machine credential
file that the app, the brain, and the CLI all read. Two copies of the record
means two independent rotations. See
[ARCHITECTURE §8.1](../../ARCHITECTURE.md#81-electron-safestorage-for-secrets).

**One ledger, inside the credential.** The refresh ledger is stored in the same
record as the token, so a process cannot read the credential without also
reading the backoff and the lease that apply to it. A sidecar file would let a
process read one and miss the other.

**One lease.** `acquireRefreshLease` judges every gate and takes a 60-second
lease as a single atomic key update. A process that finds the lease held waits
for the holder in 250 ms steps, bounded at roughly three seconds, then serves
whatever the store now holds. A peer still holding the lease at the end of a
wait is remembered process-locally, so one slow refresh does not make every
project scope in the app repeat the same three-second poll.

**One backoff, shared.** A failed refresh writes `notBeforeAt` into the ledger:
exponential from 60 s, capped at one hour, and never shorter than GitHub's own
`retry-after`. Every process reads that deadline, so a failure costs the machine
one request rather than one request per process.

Only an explicit 401 or an OAuth error code naming the grant as rejected marks
the credential `dead`. Everything else keeps it and backs off. The asymmetry is
the reason: a wasted retry costs one request, while writing off a live
credential costs the user their connection until they notice and re-authorize by
hand — against the same OAuth endpoint that was already refusing them.

On top of the ledger, both request paths hold a resolved credential for
`GITHUB_CREDENTIAL_CACHE_TTL_MS` (30 s) through
`shared/expiringPromiseCache.ts`, which caches the in-flight promise rather than
the value so concurrent callers join one read. Every status read, PR call and
relay poll asks for a credential, and on a lapsed access token that ask is a
refresh POST.

## Test runs

The builder's **Test** button tries a saved automation before it runs for real. A click opens a Preview; the caret beside it lists the three kinds, each with one line:

| Kind | What it does |
|---|---|
| Preview | Shows what each step of a real run would do with the picked event. Nothing runs. |
| Safe test | Runs in a new throwaway lane. Steps that would post, push, publish, or change things outside the test are only reported. |
| Live test | Runs for real, as if the trigger fired. It asks once before it starts. |

The Test dialog (`builder/TestRunControls.tsx`) picks the event first: an open PR (or any PR number), a GitHub issue, a Linear issue, a chat, a lane, or a recent webhook request, by trigger type. A schedule or manual rule runs as if it fired now. Then it shows the plan from `automations.planTest`: the event, where the run works, each step with its inputs filled in and what the test does with it, and what is left afterwards. Problems (a PR-branch rule with no PR) block the start; warnings (no PR picked, so PR values are empty) do not. A test runs the saved rule, so unsaved changes block it.

`automationService.runTest` builds the trigger from the event (`buildTestTrigger`; a PR given by number alone gets its title, link and branches from GitHub through the PR service's preflight). Both kinds:

- use none of the rule's run budget, and run even when the rule is disabled;
- put `[Test]` before every notification title;
- record `test: { mode, event, lanes, cleanedUpAt }` on the run's trigger metadata, so no schema change is needed;
- answer as soon as the run row exists; the run goes on in the background and History follows it.

A safe test also:

- makes a throwaway lane named `Test: <rule> (<id>)` on a local branch `ade-test/<rule>-<id>`. For a PR event the lane starts at the PR's head, fetched into a private ref with `refs/pull/N/head` (or the head branch); for a lane event it starts at that lane's HEAD; otherwise at the default branch. The PR's own branch and linked lane are never touched;
- sets `branch.<branch>.pushRemote` to a remote that does not exist, so a plain `git push` fails. An explicit `git push origin …` still works, so the agent is also told it is a test (`SAFE_TEST_AGENT_NOTICE`) and the plan says so;
- runs every step in that lane: `safeTestRule` sets the lane mode to the trigger's lane and drops step lane overrides and a bound chat;
- reports instead of running: `ade-action` steps other than notifications, `handoff`, `run-command` steps whose command pushes, publishes, or posts (`isOutwardCommand`), and `delete-lane` on a lane the test did not make. The step is `skipped` with output `Test: would …`.

History marks a test run **Safe test** or **Live test**, says what it did (steps run, steps only reported, lanes made), and offers **Clean up** once it ends. `automations.cleanUpTestRun` deletes the lanes the test made (the safe-test lane, and lanes a `create-lane` step or `laneMode: "create"` made) with their local branches, then records `cleanedUpAt`. Pushed branches stay. Cleanup is not automatic, so you can look at what the test did first.

CLI: `daex automations test <id> [--mode preview|safe|live] [--pr <n>] [--issue <n>] [--linear <id>] [--lane <id>] [--chat <id>] [--body-file <json>] [--plan] [--yes]` and `daex automations cleanup-test <run-id>`. A live test needs `--yes`; without it, and with `--plan`, the command shows the plan only.

The iOS app has no automation run list, so it shows no badge; a test's notifications carry `[Test]` in the title.

## Queue and confidence

Automation runs that require review (confidence below threshold, or `verifyBeforePublish`) land in a queue:

- `AutomationRunQueueStatus`: `pending-review`, `actionable-findings`, `verification-required`, `completed-clean`, `ignored`, `archived`.
- `AutomationConfidenceScore`: value 0..1, label `low` | `medium` | `high`, reason string.
- `computeConfidence(rule)` blends the review profile's base value with a context-source boost minus a threshold penalty.

The queue dashboard renders severity summaries and suggested actions so operators can triage without opening each run.

## Output disposition

`outputs.disposition` is `comment-only`, `open-task`, `open-lane`,
`prepare-patch` or `open-pr-draft`. See [guardrails.md](./guardrails.md#outputs).

`createArtifact: true` records proof evidence for indexing. `notificationChannel` lets a rule override the default channel.

## Budget policy

- Budget caps come from the header Usage popup → Automation guardrails. There is no per-rule dollar or duration cap; an agent step can opt into `stopAfterMin` / `stopWhenIdleMin`.
- Usage telemetry respects `billingCode` so operators can slice spend per rule.

## Boundaries

- **No autonomous Linear dispatch.** There is no CTO workflow engine to compete with; Linear triggers in automations are context-only. If a rule needs to act on an issue it does so with an explicit action (comment, state update) through the shared Linear client — nothing auto-routes issues to agents.
- **Built-in actions are deterministic.** They should not wrap an AI call. Use `agent-session` for AI-driven logic.

## Cross-links

- `triggers-and-actions.md` — full trigger and action surface.
- `guardrails.md` — approval gates, safety boundaries, verification modes.
- `../linear-integration/README.md` — the Linear read/write surface automations use for context and actions.
- `../computer-use/README.md` — automations can request computer-use proof.

# Automations

Automations are rule-based background workflows. Each rule has triggers, an
execution surface (an agent chat or a built-in action chain), an optional tool
palette and output contract, and guardrails. They sit between the CTO
(stateful, chat-driven) and raw cron (deterministic, no AI).

There is no autonomous Linear intake: rules can react to Linear events or write
to Linear as an action, but nothing auto-routes issues to agents.

Commands use `daex`; `ade` still works. Detail docs:
[triggers-and-actions.md](./triggers-and-actions.md),
[guardrails.md](./guardrails.md), [ui-design.md](./ui-design.md).

## Source file map

Services in `apps/desktop/src/main/services/automations/` (loaded by the
brain's project scope, and by desktop main when it hosts a project):

| File | Owns |
|---|---|
| `automationService.ts` | Rule CRUD, dispatch, cron, file watching, queue, run history, confidence, ingress cursors, deferred lane cleanup, `lane.merged`. Scheduled fires claim a row in machine-local `automation_schedule_occurrences`, so runtimes sharing a database elect one executor. |
| `automationRuleAccountStore.ts`, `automationRuleAccountSync.ts` | Rules that follow the account. |
| `automationCloudRegistrar.ts` | Sends DAEX Cloud-homed rules to the server. |
| `automationPlannerService.ts` | Natural-language authoring through a Claude or Codex planner subprocess. |
| `automationIngressService.ts` | Local webhook server, GitHub relay drains and WebSocket wake-ups, signature checks, the PR-freshness-only mode. |
| `customWebhookService.ts` | Custom webhook URLs, delivery log, replay, **Send test** ([check order](./triggers-and-actions.md#how-a-custom-webhook-delivery-is-handled)). |
| `automationTestRun.ts` | Test runs. |
| `automationPrBranchLane.ts` | `laneMode: "pr-branch"`: the PR's linked lane fast-forwarded to the PR head, or a lane imported from the head branch; never another lane. |
| `githubPollingService.ts` | Direct GitHub REST polling; idle unless an enabled rule has a `github.*` trigger. |
| `linearAutomationDispatch.ts`, `linearIngressService.ts`, `linearRelayConfig.ts` | Linear events over the relay. |
| `cursorCloudIngressService.ts` | Cursor Cloud status events, polled every 45 s only while a `cursor.*` rule exists. |
| `automationSecretService.ts` | `${env:VAR}` secrets. |

Shared: `apps/desktop/src/shared/automationLimits.ts`, `automationAvailability.ts`,
`automationHome.ts` (leases, handover, the cloud home), `automationWebhooks.ts`,
`types/automations.ts`. Actions: `main/services/adeActions/` (`registry.ts`,
`actionPolicy.ts` with `ADE_ACTION_ALLOWLIST` / `ADE_ACTION_CTO_ONLY`,
`actionInputContracts.ts` read by `daex actions describe`). Renderer:
`apps/desktop/src/renderer/components/automations/`. IPC:
`window.ade.automations`, routed to the project's runtime.

### GitHub relay and App

- `apps/webhook-relay/`: the hosted Cloudflare Worker. Stores GitHub App deliveries in D1 (7 days, slimmed), serves repo-scoped `/status`, `/events` (`seq:<n>` cursors, ascending pages with `hasMore`) and `/subscribe` (WebSocket wake-ups, no payload), webhook heal/delivery routes, and custom hooks. See `apps/webhook-relay/README.md`.
- `main/services/github/githubRelayConfig.ts`: relay base URL and auth mode.
- `main/services/github/githubAppUserAuth*.ts`: the App user token (device flow, store, lease, `getValidTokenForRelay`, refresh ledger, failure classification). Use `isGitHubOAuthError`, not `instanceof`, since two hosts load it through different paths.
- `apps/ade-cli/src/services/credentials/credentialChangeRelayRepair.ts`: ends the relay's auth-pending cooldown when the App credential changes on disk.
- `renderer/components/github/GitHubAppInstallPanel.tsx`: install, authorize, disconnect per repo.

## Gotchas

- **Read `rule.triggers`.** Legacy `trigger` is normalized (`normalizedRuleTriggers`); `commit` aliases `git.commit`; legacy `git.pr_*` alias `github.pr_*`.
- **`lane.merged` is not `github.pr_merged`.** Go through `notifyLaneMerged`, or the restart-safe per-PR dedupe is lost.
- **Deferred cleanup appends to the original run**, so `actions_total` can grow after the chain ends.
- **The polling cursor parser handles three shapes** (`<iso>`, `<slug>=<iso>`, `<slug>=<iso>|…`); don't simplify without a migration.
- **Validate cron before installing** (`cron.validate` plus the 5-field split).
- **Signature checks are timing-safe** (`safeCompareSignature`).
- **Relay wake-ups are not deliveries.** Drain ascending pages in order, persist each `nextCursor` after its events, let a per-event failure advance the cursor (a poison event must not freeze ingest); only a page or transport failure leaves the cursor for replay.
- **Agent turns have no default clock.** `agentTurnLimits` passes `null` unless the step sets a limit.
- **Active hours read the zone's clock** (`trigger.activeHours.timezone`). A computer fires cron on its own clock; `trigger.timezone` is read only by DAEX Cloud.
- **Ingress runs are claimed when they start** (`run_claim`). Pass `claimStart` through `runRule` for a new ingress path.
- **Every rule is yours.** `.ade/ade.yaml` is not read, so a clone cannot add a rule.

## Runtime ownership

The rule engine, cron, cleanup sweeper, file watcher, ingress and built-in
actions run in the runtime (`daex serve`) that owns the project. The renderer
edits rules, reads history and fires manual runs; it owns no scheduling.

The Automations tab combines rules from every machine with the repository; each
row targets its owner. Moving a machine-local rule creates a paused copy on the
target, deletes the original, then enables the copy (a failed delete leaves the
copy paused).

### Rules follow the account

Rules are stored in the account per repository (`repo:<host>/<owner>/<repo>`),
one row each: `automations.rule.<id>`, `automations.home.<id>` (the computer
that runs it), and `automations.runs.<id>` for a run limit. Separate rows,
because the store keeps the newest stamp per key: a list would drop another
computer's addition, and a home inside the rule would let an edit undo a move.
The brain attaches the store in `apps/ade-cli/src/bootstrap.ts` and after each
account sync runs `migrateAutomationRulesToAccount` and
`reconcileAutomationRules`.

- **One home runs it.** A home is `{ deviceId, name, chosenAt, checkout }`; the checkout hash keeps two checkouts on one computer from both running it. Only `runsHere` rules are scheduled, watched or dispatched; Run now elsewhere refuses with "runs on <computer>".
- **The lease.** A home starts triggered runs only while it synced with the account in the last 10 minutes (`AUTOMATION_HOME_LEASE_MS`); otherwise the rule shows `homeOutOfTouch` and waits. Run now still works.
- **Changing the home** (**Runs on**, `daex automations run-on <id> [--device … --name …]`): the new home waits `AUTOMATION_HOME_HANDOVER_MS` (12 minutes) before triggered runs, so the old home has seen the change or lost its lease. Run counts move with the rule.
- **What stays on this computer** (`localReason`): chat-scoped rules, projects with no remote, rules over the relay's 16 KB per setting, and rules saved signed out or under another account.
- **Moving existing rules** from `local.yaml` happens only after the store has synced this run; an id clash with a different rule is filed as `<id>-<device>`. Races are tracked in `.ade/automation-rules.state.json` until a sync confirms them.
- **Stale writers.** Only `saveAutomationRule` / `deleteAutomationRule` edit or delete an account rule; a generic `projectConfigService.save` may only add one, and a tombstoned rule does not come back.
- **Signed out**, the state file's copy keeps rules showing and running; edits wait in `local.yaml` and move on sign-in under the same account only.
- **Newer DAEX.** A rule this build cannot read back exactly is shown paused with `needsNewerAde`, never run, and refuses edits.
- **Machine-local gaps** (a lane, suite, folder, webhook URL or secret only another computer has) are listed in `homeGaps`. Secrets never move.

### Availability

Automations are on in every build. `ADE_DISABLE_AUTOMATIONS=1` is the kill
switch (`shared/automationAvailability.ts`); the runtime reports
`AppInfo.automationsEnabled`. With the kill switch on, the ingress service still
drains the GitHub relay in a PR-freshness-only mode so PR state stays current.
Ingress needs the runtime to reach the internet or the relay.

### With no computer awake

On a DAEX Cloud tab, `AutomationsPage` shows the read-only
`AutomationsAccountList`: rules and homes from the account settings, plus
`GET /cloud/automations?origin=` for cloud-homed rules' state and runs. It
never wakes a computer, reads once (and on Retry), and never shows an empty list
for a failed read. DAEX Cloud rules keep running with no computer on.

## Core model

`AutomationRule` (`shared/types/automations.ts`) carries `id`, `name`,
`enabled`, `home` / `runsHere` / `homeStartsAt` / `needsNewerAde` /
`localReason`, `origin` (`user` default, `cto`, `chat-menu`), `scope` (the chat a
rule belongs to, with a stored title), `originRequest`, `oneShot`, `maxRuns`
(failures count; a one-shot defaults to 3), `triggers`, `execution`,
`reviewProfile`, `toolPalette`, `contextSources`, `guardrails`,
`outputs.disposition`, `verification`, `billingCode` (default `auto:<id>`).

`execution` is one of:

- `{ kind: "agent-session", targetLaneId?, laneMode?, laneNameTemplate?, session? }`: a scoped automation chat. `laneMode: "create"` makes a lane per run (`{{trigger.*}}`, `{{date}}`, `{{time}}`, `{{rule.name}}` in the name); `"pr-branch"` runs on the trigger PR's head branch. `session.codexFastMode` applies only when the resolved model supports it.
- `{ kind: "built-in", targetLaneId?, builtIn: { actions } }`: deterministic DAEX actions.

Triggers are time-based (`schedule`, 5-field cron) or action-based (manual,
git, GitHub, lane, file, session, webhook, Linear, Cursor). See
[triggers-and-actions.md](./triggers-and-actions.md).

## Execution surfaces

### agent-session

For autonomous text work: reviews, audits, summaries. Launches through
`agentChatService.createSession` with the rule's prompt and tools, recorded as
an automation chat in History. A step with no stored permission (**Rule
default**) runs full-auto on every provider; dry-run rules run in plan mode.

**One chat for every run:** `execution.session.chatSessionId` makes each run a
new turn in an existing chat (default: the chat the rule came from). Runs queue
per chat; a busy chat retries every 5 s for up to 30 minutes. A deleted chat
fails the run.

### built-in

Steps (`AutomationActionType`): `create-lane`, `delete-lane`, `run-command`,
`run-tests`, `predict-conflicts`, `agent-session`, `handoff`, `ade-action`.
Each may override `targetLaneId`; `alwaysRun: true` gives finally semantics.
Commands are confined to the lane worktree (`validateAutomationCwd`).

`ade-action` dispatches an allowlisted `domain.action` through the actions
registry with `{{trigger.*}}` placeholders. A step that starts or prompts an
agent CLI (`chat.launchCli`, `pty.sendToSession`, `pty.create` with
`initialInput`) waits for the CLI's turn to end (`waitForCliTurn`: the turn-end
signal, exit, or the step limit, default two hours) and returns the CLI's
closing message; `waitForTurn: false` restores fire-and-forget.
**Send notification to mobile app** (`attention.sendNotification`) has its own
editor.

### Lane lifecycle and cleanup

`lane.merged` fires when a PR transitions to merged, carrying lane and PR
context, deduped across restarts by a kv marker. `delete-lane` resolves only an
explicit target, a lane made by this run, or the trigger lane, and fails rather
than guessing. With `afterMinutes > 0` it writes an
`automation_scheduled_cleanups` row; the sweeper (startup, then every 60 s)
appends the result to the originating run. A lane already gone is a no-op
success.

### Run on DAEX Cloud

- **A run on DAEX Cloud** (`execution.cloud`): the home machine still watches the trigger and keeps history, but each run starts its lane on a new cloud computer through `cloud.lane_launch`, under the agent limits. Needs `laneMode` "create" or "pr-branch", no bound chat, no step that needs this machine (`automationCloudProblem`). See [DAEX Cloud](../ade-cloud/README.md#a-new-lane).
- **Runs on: DAEX Cloud**: the server is the home, so the rule runs with no computer on. The home `{ kind: "cloud", deviceId: "ade-cloud" }` makes every brain stamp `runsHere: false`. Only agent rules with a new lane per run and no bound chat, on a schedule, a custom webhook (no secret or filters) or Run now (`automationCloudHomeProblem`); the prompt may use only server-filled variables. `automationCloudRegistrar.ts` sends changed cloud-homed rules after each account sync and removes a rule only on positive evidence (home moved, rule deleted), naming the version it saw. Nothing runs on a timer.

## Cron and file triggers

`node-cron` installs one task per enabled schedule rule, stopped on disable or
delete and reinstalled on restart. Five fields only; Sunday is 0 or 7.
`computeNextScheduleAt` previews the next fire.

`file.change` uses `watchTree` (`services/shared/treeWatcher.ts`) under the
target lane's worktree, debounced, matched with `globToRegExp` / `matchesGlob`.

## Webhook, relay, and polling ingress

Sources (`AutomationIngressSource`):

- `local-webhook`: an HTTP endpoint; `github-webhook` events verify HMAC-SHA256 (`automations.githubWebhook.secret`); custom `webhook` events optionally verify a shared secret.
- `github-relay` (default): DAEX subscribes to the repo-scoped WebSocket and drains `/events?after=<cursor>&order=asc&limit=100` on connect and each wake-up. The cursor is persisted once per page after every event was attempted; linked PR ids batch into one targeted PR refresh. Page/transport failures mark relay health false, respect `Retry-After`, and back off 30 s–15 min; the interval poll is 30 s while the socket is down, 5 minutes while connected. Signed-in requests authorize from the account's installed repo binding; the App user token path is the legacy fallback. Self-hosted relays keep the legacy project-token routes (`shouldUseLegacyGitHubRelayProjectRoute`).
- `linear-relay`: a workspace webhook from `linearIngressService.setup()` (needs a workspace admin), or the DAEX Linear app's own webhook (`appManaged`, self-configuring; teardown never deletes it).
- `webhook-relay`: custom webhook URLs (`<relay>/hooks/:hookId/:token`). The relay checks only the token hash, stores the request (up to 3 days) and answers `202`; DAEX drains, then acknowledges processed ids (`POST /hooks/ack`), so a failed processing retries. A hook whose rule runs on DAEX Cloud is **forwarded** to the account directory (`POST /hooks/forward`) and never drained by machines. Signing secrets never reach the relay.
- `github-polling`: `githubPollingService` diffs REST snapshots into `github.issue_*` / `github.pr_*` events (30 s, list walks capped at three pages); idle without a `github.*` rule.

Ingress rows keep only normalized fields (no raw payload) and are pruned at
write time (7 days; newest 2,000 non-dispatched rows per project). See
[Storage and recovery](../storage-and-recovery/README.md#database-maintenance-hooks).

**Delivery gating.** `computeDeliveryStatuses` reports per source class
(`github`, `githubWebhook`, `webhook`, `linear`) whether a path can fire it and
which one; `triggerDeliveryKeyForType` maps a trigger to its class, and
`getIngressSetupError(rule)` returns the first not-ready reason. A `null`
result means no external ingress is needed.

<a id="how-ade-stops-a-github-app-refresh-storm"></a>
## How DAEX stops a GitHub App refresh storm

The App user credential is one record per machine, and its refresh token
**rotates**: GitHub treats reuse of a rotated token as theft and revokes the
grant. The app, the brain and the CLI each build services, so four mechanisms
keep refresh POSTs to one, and all four are load-bearing:

- **One file.** `github.appUserToken.v1` is a file-backed credential key (`FILE_BACKED_CREDENTIAL_KEYS`) in the shared machine credential file ([ARCHITECTURE §8.1](../../ARCHITECTURE.md#81-electron-safestorage-for-secrets)).
- **One ledger, inside the credential**, so no process reads the token without its backoff and lease.
- **One lease.** `acquireRefreshLease` checks every gate and takes a 60 s lease atomically; others wait in 250 ms steps (≈ 3 s), then use whatever the store holds.
- **One shared backoff.** A failure writes `notBeforeAt`: exponential from 60 s, capped at one hour, never shorter than GitHub's `retry-after`.

Only an explicit 401 or an OAuth error naming the grant as rejected marks the
credential dead; everything else backs off. A wasted retry costs one request;
writing off a live credential costs the user their connection. On top, both
request paths cache the resolved credential for 30 s
(`GITHUB_CREDENTIAL_CACHE_TTL_MS`, `shared/expiringPromiseCache.ts`), joining
concurrent callers on one promise.

## Test runs

**Test** in the builder (`builder/TestRunControls.tsx`) runs the saved rule
against a picked event (PR, issue, Linear issue, chat, lane, recent webhook):

| Kind | What it does |
|---|---|
| Preview | Shows what each step would do. Nothing runs. |
| Safe test | Runs in a throwaway lane; outward steps are only reported. |
| Live test | Runs for real after one confirmation. |

Tests use none of the run budget, run even when disabled, prefix notifications
with `[Test]`, and record `test: { mode, event, lanes, cleanedUpAt }` on the
run. A safe test makes lane `Test: <rule> (<id>)` on `ade-test/<rule>-<id>`
with a nonexistent `pushRemote` (and tells the agent it is a test), runs every
step there, and skips outward `ade-action`, `handoff`, pushing/publishing
commands and foreign `delete-lane` steps (`isOutwardCommand`). **Clean up**
deletes the test's lanes and local branches; pushed branches stay.

CLI: `daex automations test <id> [--mode preview|safe|live] [--pr|--issue|--linear|--lane|--chat …] [--plan] [--yes]`,
`daex automations cleanup-test <run-id>`.

## Queue, outputs and budget

- Runs below the confidence threshold or with `verifyBeforePublish` land in a queue (`pending-review`, `actionable-findings`, `verification-required`, `completed-clean`, `ignored`, `archived`). `computeConfidence` blends the review profile with context sources.
- `outputs.disposition`: see [guardrails.md](./guardrails.md#outputs).
- Budget caps live in the Usage popup's automation guardrails; there is no per-rule dollar cap. Usage is sliced by `billingCode`.
- Built-in actions stay deterministic; AI logic belongs in `agent-session`.

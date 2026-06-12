# Path to Merge

Path to Merge (PtM) launches a single, **visible, persistent chat agent per PR**
that watches the PR and drives it to merge itself — modelled on the `/shipLane`
loop, but the agent (not a TypeScript state machine) owns every judgment: when
CI/review are terminal, how to fix failures, how to resolve conflicts, and which
merge tactic to use. The operator can open the watcher chat in the Work tab at
any time to follow along or redirect it.

The only piece that stays deterministic is the **wake-up timer**: no chat runtime
can self-wake (a session only advances when a message is streamed into it), so a
thin main-process scheduler injects a short "watch turn" into the session every
`pollIntervalSeconds`. Ground truth for "is it merged" comes from
`prService.refresh` — never the agent's self-report — so the loop cannot be
fooled into thinking it is done.

Source:
- `apps/desktop/src/main/services/prs/pathToMergeOrchestrator.ts` — launcher + scheduler.
- `apps/desktop/src/main/services/prs/pathToMergeSeedPrompt.ts` — the standing contract handed to the agent.

## Launch flow

`createPathToMergeOrchestrator(deps)` is built once during PR-service boot.
`startPathToMerge(args)` does, in order:

1. **Resolve the lane worktree** for the PR (`laneService.getLaneBaseAndBranch(pr.laneId)`).
   PtM requires a linked PR with a live local lane worktree; if there is none it
   throws with a clear message so the operator can open the PR's lane first.
2. **Acquire the lane worktree lock** (`laneWorktreeLockService`, `ownerKind:
   "path_to_merge"`). If another owner already holds the worktree, the launch is
   blocked: the runtime is parked `paused` and the result carries `blockedBy` so
   the UI can explain who holds it. Two agents pushing the same worktree corrupt
   each other.
3. **Create a visible workflow chat** —
   `agentChatService.createSession({ surface: "work", sessionProfile: "workflow", … })`
   in the PR's lane, titled `Path to Merge #<num>`.
4. **Persist** the run args (`ptm_args_json`) and flip the convergence runtime to
   `status: running` / `pollerStatus: polling`.
5. **Seed the contract** — fire-and-forget `sendMessage` with the seed prompt so
   the operator sees a first turn immediately. The scheduler's awaitable watch
   turns drive the loop after.
6. **Arm the watch timer** for `pollIntervalSeconds`.

`StartPathToMergeArgs`:

| Field | Meaning |
|-------|---------|
| `prId` | The PR to watch. |
| `modelId` / `reasoning` / `permissionMode` | Agent config for the watcher chat. Falls back to `deps.defaultModelId` / `deps.defaultReasoningEffort`. |
| `scope` | Gating: `"checks"` (CI only), `"comments"` (review only), or `"both"` (default). Encoded as a hard rule in the seed. |
| `additionalInstructions` | Free-form operator instructions, appended verbatim to the contract. |
| `pollIntervalSeconds` | Seconds between scheduler-injected watch turns. Clamped to `[60, 3600]`; default `600`. |

## The watch loop (scheduler)

A per-PR `setTimeout` keyed by `prId` fires `runWatchTurn(prId)`. Each turn:

1. **Ground-truth short-circuit** — `prService.refresh`, then check `pr.state`. If
   it merged between turns (e.g. an armed `--auto` landed), run
   `prService.runPostMergeCleanup`, flip the runtime to `merged`/`stopped`, and
   stop. If it closed, flip to `stopped` and stop.
2. **Inject a watch turn** — `agentChatService.runSessionTurn({ sessionId, text:
   buildWatchTurnPrompt(...), timeoutMs })`. This is the same awaitable
   turn-injection the CTO heartbeat uses; it resolves when the turn completes.
   A single turn does one bounded unit of work (diagnose, fix, push, or merge)
   and ends — `WATCH_TURN_TIMEOUT_MS` is 30 min so a real CI fix is not
   interrupted mid-push. If the session is already mid-turn the orchestrator just
   re-checks next interval rather than erroring.
3. **Ground-truth again** — the agent may have merged it during the turn; re-check
   and stop if terminal.
4. **Reschedule** — still open → arm the next timer for `pollIntervalSeconds`.

A `turnInFlight` guard prevents overlapping turns for the same PR; the lane lock
is heartbeated around each turn so it does not expire mid-run.

Poll-interval bounds live in `pathToMergeOrchestrator.ts`:
`MIN_POLL_INTERVAL_SECONDS = 60`, `MAX_POLL_INTERVAL_SECONDS = 3600`,
`DEFAULT_POLL_INTERVAL_SECONDS = 600`.

## The seed prompt (standing contract)

`buildPathToMergeSeedPrompt(inputs)` builds the contract from gating + additional
instructions + merge tactics, distilled from `docs/playbooks/ship-lane.md`. It
tells the agent:

- **Mission** — drive this PR to merged into its base, autonomously, across many
  turns; you own every decision.
- **How you run** — you cannot self-schedule; a scheduler re-prompts you roughly
  every N minutes. Treat each turn as one bounded unit: re-read ground truth from
  `gh`/ADE, do the single next action, end with a one-line status. Never busy-wait
  inside a turn for CI.
- **Merge gate** — the gating mode as a hard rule (CI only / comments only / both).
- **Fixing failures** — open failing run logs, make the smallest correct fix in the
  worktree, commit, push, end the turn so CI re-runs; address actionable review
  threads; resolve conflicts (rebase/merge base in) yourself; stay scoped to this
  PR's worktree.
- **Merge ladder** — `gh pr merge <N> --squash` → on a base-branch policy block with
  admin rights, retry `--squash --admin` → otherwise arm `--squash --auto` and keep
  watching until GitHub lands it. **Never** pass `--delete-branch` (it checks out the
  base branch and breaks when it is checked out in another worktree); after the merge,
  delete the remote head ref server-side via `gh api -X DELETE repos/<owner>/<repo>/git/refs/heads/<head>`.

`buildWatchTurnPrompt` is the short per-interval nudge.

## Persistence and resume

- **`pr_convergence_state`** holds the `ConvergenceRuntimeState`
  (`status`, `pollerStatus`, `activeSessionId`, `activeLaneId`, `activeHref`,
  `pauseReason`, `errorMessage`, timestamps).
- **`pr_convergence_state.ptm_args_json`** holds the persisted launch args
  (`modelId`, `reasoning`, `permissionMode`, `scope`, `additionalInstructions`,
  `pollIntervalSeconds`). Cleared by `stopPathToMerge`.
- **In-process only** — `timersByPrId` (cancellable wake-ups), `turnInFlight`
  (overlap guard), and `watchers` (the live per-PR `{ sessionId, laneId,
  githubPrNumber, pollIntervalSeconds, lockToken }` handle, rebuilt on resume).

`resumeFromPersistedState()` runs on boot. It iterates `prService.listAll()` and
re-arms a watch timer for any PR whose runtime is still live
(`autoConvergeEnabled === true`, `pollerStatus !== "stopped"`, status not in
`{merged, stopped, cancelled}`) and that still has a persisted watcher session id.
A live flag with no session id is cleared instead of warming a doomed loop.

## IPC

| Channel | Purpose |
|---------|---------|
| `ade.prs.pathToMerge.start` | Start (or restart) PtM for a PR. Creates the visible watcher chat, persists args, flips the runtime to `running`/`polling`, seeds the contract, and arms the timer. Returns `PathToMergeStartResult` (`scheduled`, `runtime`, `blockedBy?`). |
| `ade.prs.pathToMerge.stop` | Cancel the pending wake-up, interrupt the active watcher session, clear `ptm_args_json`, and persist `status: stopped`. |

## Renderer surface

- `renderer/components/prs/shared/PrConvergencePanel.tsx` — the launch + status
  panel on `PrDetailPane`. Pre-launch config: a gating radio (CI only / comments
  only / both), an additional-instructions textarea, and a poll-interval input.
  When a watcher is live it shows running/blocked/merged status and an **Open chat**
  link to the watcher session. The detail sub-tab is labelled "Path to Merge".
- `renderer/components/prs/tabs/QueueAutomateMergingModal.tsx` — the Queue tab's
  "Automate Merging" entry point. It carries one stack-wide watcher config
  (gating / instructions / poll interval / agent config) and, for each member in
  queue order: retargets the base branch to the chain base (skipping position 0),
  launches a watcher via `pathToMergeStart`, and polls the runtime via
  `classifyWatcherOutcome` (`queueAutomateMergingRuntime.ts`) until it reports
  `merged` (success) or `halted`. Closing the modal mid-sequence stops dispatching
  new starts but leaves already-launched watchers running.

The IPC bridge for the modal also uses `ade.prs.retargetBase` (PR id + base
branch) to re-point each non-leading queue PR at the chain base before its
watcher picks it up.

## Relationship to `/shipLane`

PtM is the agent expression of the `/shipLane` playbook: the merge/wait/fix rules
in the seed prompt are distilled from `docs/playbooks/ship-lane.md`. The
difference is that `/shipLane` is a one-shot skill the operator runs, while PtM is
a standing watcher the scheduler keeps nudging until the PR lands. There is no
deterministic terminal-state gate, merge-ladder state machine, force-finalize
counter, or conflict-strategy switch in ADE anymore — the agent makes all of
those calls per its contract.

## Gotchas

- **Ground truth is `prService.refresh`, not the agent.** The loop only stops on a
  real merged/closed observation, so a confused agent claiming "done" cannot end
  the run prematurely.
- **Never pass `--delete-branch` to `gh pr merge`.** It checks out the base branch
  and breaks when it is checked out in another worktree. The seed forbids it and
  routes head-ref deletion through `gh api`.
- **The lane worktree lock is mandatory.** PtM holds it for the whole run so a
  second watcher (or a manual agent) cannot race pushes on the same worktree. A
  blocked launch returns `blockedBy` rather than starting.
- **Watch turns are bounded.** The agent must not busy-wait for CI inside a turn;
  it ends the turn and the scheduler re-checks next interval. The 30-min turn
  timeout is a backstop for a wedged turn, not the polling cadence.

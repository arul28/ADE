# Cross-machine session handoff

A handoff stops work in one Work chat and continues it on another connected
DAEX machine. The source lane and chat stay; the destination gets a compatible
lane (created or safely reused) and a chat rebuilt from portable state. It is
not database sync and not a provider-session migration.

## Source file map

- `apps/desktop/src/main/services/chat/crossMachineHandoffOrchestrator.ts` — the
  source brain's move: the durable record, approval, permission mapping, the
  outbox capsule, retry and restart.
- `apps/desktop/src/main/services/chat/crossMachineHandoffSource.ts` — the `kv`
  store, outbox files, `inspectLane` (every source blocker with its fix).
- `apps/desktop/src/main/services/chat/handoffGitBundle.ts` — opt-in transfer of
  uncommitted and unpushed work.
- `apps/desktop/src/main/services/chat/agentChatService.ts` — capsule creation
  and validation, destination preflight and acceptance, fork materialization.
- `apps/desktop/src/shared/crossMachineHandoff.ts`,
  `apps/desktop/src/shared/types/chat.ts` — capsule DTO, decoders, contracts.
- UI: `renderer/components/chat/CrossMachineHandoffModal.tsx`,
  `CrossMachineHandoffChooseStage.tsx`, `CrossMachineHandoffBanner.tsx`,
  `renderer/components/terminals/CrossMachineMoveSubmenu.tsx`,
  `renderer/components/shared/BlockedAction.tsx`.
- iOS: `Views/Work/WorkCrossMachineHandoffViews.swift`,
  `WorkSessionHandoffSheets.swift`, `Services/SyncService+SessionHandoff.swift`.
- `apps/ade-cli/src/services/cloudChats/cloudChatRestore.ts` — continue on a new
  DAEX Cloud computer.

## The source brain runs the move

The brain that owns the source chat runs every move through one `chat` action,
`startCrossMachineHandoff`, whatever started it: the desktop modal and session
menu (**Hand off › Another machine ▸**, including **Quick brief**),
`daex chat handoff <session> --to <name>` (an agent can move its own chat), or
the phone's `chat.startCrossMachineHandoff`.

Pickers offer the account's own computers; DAEX Cloud shows as one disabled row
("DAEX Cloud can't take a moved lane yet. Pick one of your computers.").

The brain reaches the destination over its agents' paired connection (as
`--machine` calls do); the destination applies its own action policy to
`preflightCrossMachineDestination`, `fastForwardCrossMachineHandoffLane` (clean
lane that is only behind) and `acceptCrossMachineHandoff`. The source runs
prepare, validate and mark locally. The modal's review step runs a read-only
preflight (`previewCrossMachineHandoff`).

### The move record

One current move per chat, `AgentChatCrossMachineHandoffRecord` in the project
`kv` (`agent-chat-cross-machine-move:v1:<sessionId>`), projected onto the
summary as `crossMachineHandoff`, with a live `cross_machine_handoff_state`
notice on each change.

| State | Meaning |
|---|---|
| `awaiting_approval` | An agent asked to move an unrelated chat. |
| `pending` | Waits for the turn to end; a newer user message cancels it. |
| `sending` | In flight; `checkpoint` is `prepared`, `destination_ready`, `accepted` or `marked`. |
| `continued` | The destination chat started; the source is locked. |
| `returned` | A chat came back to its original chat (same id). |
| `failed` | A step failed or the destination refused; a lane it already created stays and blocks a later move there. |
| `unknown` | The destination may have accepted; never replayed automatically; blocks new moves until retried or dismissed. |
| `cancelled` | Kept here, denied, superseded by a message, or dismissed. |

- The record is written before each step. When acceptance is about to start,
  the exact capsule and fingerprint go to an outbox file
  (`.ade/cache/cross-machine/outbox/<handoffId>.json`). A retry or restart
  resends that capsule, because the destination binds a `handoffId` to one
  fingerprint.
- Before resending, `validateCrossMachineSource` re-checks branch, commit,
  working tree, origin, model and chat activity (the move's own notices don't
  count). A changed chat is `source_stale`: the retry is refused and the person
  is told to check the destination. A check that cannot run changes nothing.
- A move that may have landed (`unknown`, or `failed` after acceptance started)
  blocks a new one (`move_unknown`); clear it with **Retry** or dismiss it
  (`daex chat handoff <session> --cancel`).
- A fork that failed while packing offers **Send as brief instead**
  (`retryCrossMachineHandoff { asBrief: true }`, same `handoffId`).
- On startup the brain resumes `sending` moves and starts `pending` ones whose
  turn ended. Deleting a chat clears its move.
- A move counts as lost only when the request may have reached the destination
  (timeout or dropped connection); an offline machine or a refusal is `failed`.

### Who asked, and approval

`requestedBy` is stamped by trusted entry points; anything not explicitly
`user` is `agent` (an agent's shell looks like a person's terminal). Automation
rules lose every relation stamp, so their single moves ask and their batches are
refused.

- **Agent scope follows lineage.** An agent may move its own chat or a
  descendant (`orchestrationParentSessionId` chain, max 32 links) without
  approval. An unrelated chat waits for the person, even if it is full-auto.
- **An agent's move runs at the chat's own permission level**: the orchestrator
  drops the agent's permission fields and maps the source's unified level
  (`permissionLadder.ts`, `permissionFieldsForLevel`) onto the target provider,
  stepping down, never up (`resolvePermissionLevel`).
- **Approval** cards and the batch resolver are user-only, so an agent cannot
  approve itself. Limits and the two-minute deny cooldown are per target chat; a
  card also spends the shared `ask_user` budget.
- The phone push for a failed move says only "Open the chat for details."

### After the move

After `continued` the source is locked: scheduled work, CLI resumes, recovery,
automations, subagent reports, PR Watch, usage-limit resumes and drafts start no
turn there; agent and remote turn requests get a typed refusal naming the
destination. The banner reads **Continues on <machine>** with **Open on
<machine>** and **Work here instead** (`acknowledgeCrossMachineHandoff`, sets
`resumedHere`). Desktop sends from the source composer route to the destination;
iOS asks first. A locked chat cannot be moved again (`chat_moved_away`).

### Coming back

A chat moved to the machine in its saved origin continues the original chat
(same id). A fork returns only the events written while away; a brief appends a
brief. The original lane is reused only when clean and behind (fast-forward) or
already at the commit; returned work never lands in a primary checkout that
would change. A refused return is definitive (`cross_machine_return_refused`),
ends the move `failed` with `returnRefused`, and later moves go as a new chat.

## The source is the chat's machine, not the tab

Eligibility uses the chat's effective binding (`chatRuntimePin ??
projectBinding`, from `useChatScopeDerivation` in `ChatRuntimeScope.tsx`), never
the tab's. `CrossMachineHandoffModal` takes `runtimePin` and pins every
source-side call (`getCrossMachineHandoffOptions`, `previewCrossMachineHandoff`,
`startCrossMachineHandoff`, the Publish/Update branch Git calls) to that machine,
frozen once per operation. Lanes offered come from the chat's machine
(`handoffLaneSourceLanes`).

## Product flow

1. DAEX checks the source chat and lane.
2. The user picks a connected machine (repository presence shown from the same
   `listProjects` call) and may add a note.
3. The user sets the destination model, effort, fast mode and permission with
   the composer's own pickers; the capsule carries them. Fork mode stays on the
   source provider.
4. A missing repository shows the destination path, free space and an explicit
   clone confirmation.
5. DAEX checks destination provider access, the published commit and any
   existing lane, then the user confirms.
6. The source is re-checked; the destination creates or reuses the lane, starts
   the chat, and dispatches the first turn (or completes a no-turn fork).
7. Only after that acknowledgement is the source marked.

The modal closes once the brain accepts; the banner then shows real checkpoints.
The destination gets an **Arrived from <machine>** notice (account name, not
host name). The sign-in route travels in the capsule (`crossMachineRouteFor` in
`chatLaunchRoute.ts`): a preset or key only for the same model/provider; an
account travels by email and is kept only when the destination has the same
signed-in email. A `cross_machine_handoff_route` line says which sign-in the
chat uses there. The modal can queue the move for the end of the turn.

## Batch moves

`daex chat move --to <name> <session>…` (or `--all`) moves chats with their
descendants (`--no-descendants` to limit) and every ancestor lane. An agent
batch with any unrelated chat waits for one approval card on the caller's chat.
Lanes import root-first, chats parent-first; chat moves reuse the single-move
record and outbox; lane payloads have their own outbox (`<importId>.lane.json`
with a `sent` marker). A failed parent blocks its descendants.
`daex chat move --status <id>` and `--retry <id>`. Batches fork by default
(`--brief`, `--no-changes`, `--interrupt`, `--note`). The destination starts lane
environment setup itself for lanes the import created. Every move carries live
scheduled work; the source cancels exactly the ids the destination recreated.
A destination that does not advertise batch support refuses with an update
message.

## Source contract

By default: clean worktree, no rebase or merge in progress, a named branch with
an upstream, and local `HEAD`, upstream and `git ls-remote origin
refs/heads/<branch>` at the same commit. **Publish branch** and **Update
branch** fix the simple cases; diverged branches block. Every blocker is a
`BlockedActionReason` rendered beside a `BlockedActionButton`, so a disabled
control is never the only signal.

### Moving uncommitted and unpushed work (opt-in)

With `includeChanges`, the lane may be dirty, ahead or unpushed (not diverged,
not mid-rebase). `packHandoffGitBundle` snapshots the working tree in a private
index and bundles only what origin lacks (`--not --remotes=origin`). Ignored
files, stashes, hooks, config and the staged split do not travel. Submodule
pointer and Git LFS changes are refused. Over 50 MiB raw, or past the ~20 MiB
capsule budget, is refused ("Push the branch, then hand off again."). The
destination must advertise `gitBundleSupport`; `applyHandoffGitBundle` verifies,
fetches into a temporary `refs/ade-handoff/<hash>/head`, moves the branch only
forward (compare-and-swap), imports a new lane (never the primary checkout), and
undoes every step on failure.

## Portable capsule

A brief capsule holds machine label, chat id, provider/model and title, repo
origin, branch and commit, destination settings, a brief (≤16,000 characters),
bounded file/command/error references, up to 12 Linear issues and a note
(≤4,000 characters). It never holds provider thread ids, full transcripts,
secrets, PTYs, caches or file contents (unless changes are opted in). Secret
shapes, absolute paths and URL credentials are redacted before hashing; the
destination verifies the fingerprint and bounds.

## Fork mode

Fork carries provider-native session data plus DAEX transcript envelopes,
gzip+base64 inside the capsule: main session ≤18 MiB, Claude sidecars ≤4 MiB
(dropped as a group if over budget), transcript ≤3 MiB (oldest dropped), all
under a ~20 MiB transport budget. Too large → a typed failure so the source can
offer a brief.

- **Claude:** session JSONL and sidecars; the destination assigns a new UUID and
  rewrites `sessionId` and `cwd`.
- **Codex:** the rollout JSONL installed under `CODEX_HOME/sessions/…`, then
  `thread/fork` with `excludeTurns: true` (`.jsonl.zst` falls back to brief).
- **OpenCode:** `session.export` → `session.import`, `session.fork`,
  `session.move`.

Cursor and Droid are brief-only across machines (other providers too):
`providerSupportsCrossMachineHandoffFork` / `CROSS_MACHINE_HANDOFF_FORK_PROVIDERS`
is derived from the local fork list minus Droid and replay-forked providers.
UI, `validateForkTransport` and the destination's `forkHandoffSupport` all gate
on it.

## Destination contract

Eligible machines are connected, support multi-project RPC and advertise the
handoff storage preflight; forks also need provider fork support (an older
destination never downgrades a fork). Repositories match by normalized origin.
With no match, only GitHub repos get automatic setup: path, write access,
collision, free space (1 GiB minimum), `git ls-remote` with destination
credentials, then an explicit clone (re-listed after a lost answer, never cloned
twice).

The destination verifies origin, provider auth and model, that the remote branch
is at the source commit, fetches it, and reuses a lane only when clean and at the
commit. A clean strict-ancestor lane gets a **Fetch & fast-forward there** offer
(`fastForwardCrossMachineHandoffLane`, `--ff-only`, everything re-validated);
until it resolves, Send stays blocked. A different local branch with the same
name blocks.

<a id="continue-on-a-new-ade-cloud-computer"></a>

## Continue on a new DAEX Cloud computer

A chat or CLI whose cloud computer was deleted continues on a new one in the same
row. There is no source brain: the old computer saved a provider-history capsule
at each rest save (`prepareCloudRestCapsule`; no Git facts, code comes from the
lane backup). `cloudChatRestore.ts` makes the lane, moves the saved copy to its
own machine key, holds uploads, then restores under the **same** id:

| Provider | Chat | CLI |
|---|---|---|
| Claude | Fork capsule (`materializeCrossMachineFork`) | Claude Code capsule, `launchMovedCli` |
| Codex | Fork capsule | Codex CLI capsule, `launchMovedCli` |
| OpenCode | Fork capsule (`session.import`) | Starts fresh |
| Every other provider | Replays the saved transcript | Starts fresh |

A replayed transcript is written once (`restoreSavedCloudChat`); a fresh CLI gets
an info line and the message as its first prompt (`restoreSavedCloudCli`). The
server marks a CLI continue with `continueChat.kind: "cli"`. Server side:
[DAEX Cloud](../ade-cloud/README.md#continue-a-chat-whose-computer-is-gone-fork-continue).

## Idempotency and recovery

The destination owns the transaction record, keyed by `handoffId` and bound to
the capsule SHA-256: `preparing` → `lane_ready` → `chat_ready` → `dispatched` →
`complete` (`failed` keeps known ids). The chat id is derived from the replay
key; lane import reconciles by branch and commit; acceptance is serialized per
handoff; `dispatched` is written only after the provider acknowledges. Fork
materialization runs only before `dispatched`, so a retry never forks twice.
Acceptance cannot be cancelled over the transport, so a lost answer is an
unknown outcome that a retry reconciles.

## Transport and security

The modal labels SSH and Tailscale routes encrypted, and LAN and DAEX Relay as
authenticated but not end-to-end encrypted (an informational notice; Send is the
confirmation). No step binds to a route kind and nothing replays after a
disconnect. The source and destination steps are also sync remote commands
(`chat.prepareCrossMachineHandoff`, `validateCrossMachineSource`,
`markCrossMachineHandoff`, `fastForwardCrossMachineHandoffLane`,
`acceptCrossMachineHandoff`), carried over `rpc_data` or `daex rpc --stdio`, so
the responder timeout does not bound acceptance. Clone auth resolves on the
destination; no GitHub token goes in the capsule.

## Source state after success

The source lane and chat are kept, with a durable notice naming the handoff and
the destination lane and chat.

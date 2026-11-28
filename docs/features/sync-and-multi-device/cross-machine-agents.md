# Cross-machine agents

Agents and the `daex` CLI (`ade` still works) can find, start, message and wait
on chats on the account's other machines, run commands and drive devices there,
and hear back when a child they started finishes. The words agents see
(machine, device, "your code there", `--code`, `--to`) are specified in
[devices and machines](devices-and-machines.md); this page is how it works.

## Source file map

- `apps/ade-cli/src/cliMachineTargeting.ts`, `cliChatLocate.ts`,
  `cliRemoteWork.ts` — CLI targeting, chat location, work-copy sends.
- `apps/ade-cli/src/services/account/machineBridge.ts`,
  `agentMachineBridge.ts` — brain-to-brain pools and `machines.call`.
- `apps/desktop/src/main/services/remoteWork/` — `remoteWorkCopyService.ts`
  (work copies), `remoteWorkFiles.ts` (file push/pull), `remoteWorkScratch.ts`
  (`--no-code` folders); limits in `apps/desktop/src/shared/types/remoteWork.ts`.
- `apps/desktop/src/main/services/chat/crossScopeChats.ts` — wake routing to a
  parent in another scope or on another machine.
- `apps/desktop/src/main/services/machineStats/machineStatsService.ts` — load
  stats; `renderer/components/lanes/laneMachines.ts` (`autoLaneMachine`).
- `apps/desktop/src/shared/rpcLiveness.ts` — dead-link detection.

## What an agent can do

```bash
daex machines list --projects --text
daex chat list --all-machines --text
daex chat create --machine "Mac mini" --lane <lane there> --type subagent \
  --provider claude --model anthropic/claude-opus-5 --prompt "build and test"
daex chat launch "fix the flaky test" --machine "Mac mini"     # new lane there
daex chat wait <id> --machine "Mac mini" --for idle --timeout-ms 900000
daex apple proof --machine "Mac mini" --lane <lane there> --caption "Login works"
daex usage limits --all-machines --text
```

- `--machine` takes a machine key or an unambiguous name (then folded case and
  punctuation, then whole words; only a unique match counts;
  `selectAccountMachine`). A flag quoted together with its value is refused.
- The project there is `--project` (`--machine-project` where `--project` is
  taken), else this repo's checkout by normalized origin. `--personal` targets
  projectless chats. This shell's lane is never sent.
- An offline machine fails at once with its last-seen time; nothing queues.
  `--all-machines` reports each failing machine as a row.
- `--machine` works only on `chat`, `lanes`, `projects`, `usage`, `apple`,
  `mac-desktop`, `app-control` (and aliases); other commands refuse it.
- `usage limits` runs in this repo's checkout there, else the project that
  machine opened last (`anyProject`).

### A chat id without `--machine`

Chat ids are unique across the account. Chat commands first ask this brain
`chats.locate` (booted scopes, then transcripts on disk, never a boot), then
every online machine (5 s each). One match runs there and prints
`· on <machine>`; two matches fail. Matches are cached in
`<ADE_HOME>/cache/chat-machines.json` (24 h, 200). `daex chat locate <id>` prints
it. Through DAEX MCP the server does the lookup itself
([DAEX MCP](../ade-mcp/README.md)).

## Running a command in a work copy there

`daex shell start --machine <name> [--wait] -- <command>` runs one command on
another machine for this chat, with no lane or chat there. That machine keeps a
**work copy** per chat (`remoteWorkCopyService.ts`): a git worktree under
`<project>/.ade/remote-work/`, detached at the chat's commit, with the chat's
uncommitted changes applied as one binary patch; ignored files (deps, builds)
survive between runs. A new copy waits up to 20 s, else answers
`work_copy_preparing`.

- **Background.** The shell is archived as soon as it starts, so no list there
  shows it; its owner chat still reads and stops it. Put all steps in one call.
- **Git moves code.** The CLI sends the commit, its remote branch and the patch
  (≤16 MiB). A commit not on origin is refused ("Push it first").
- **Never lose work there.** Unpushed commits or uncommitted edits made in the
  copy refuse a sync and name the files. `--code as-is` runs in the copy as it
  is; `--code fresh` resets anyway (old names `--no-sync`, `--discard`).
- **Files made there stay**: untracked, non-ignored files the last sync did not
  write are kept (`filesMadeHere`, listed as `workCopy.keptFiles`) unless the
  sync would overwrite one.
- **One synced command at a time** per copy; `--code as-is` runs beside it.
  Other chats on that machine cannot touch the shell.
- **Files.** `daex files push|pull --machine <name> <a> <b>` moves one file to or
  from the copy (4 MiB chunks, 256 MiB, sha256-checked, atomic rename). Remote
  paths are copy-relative; escapes, `.git`, device names and outward links are
  refused on every OS.
- **The run.** Once, in that machine's clean non-interactive shell
  (`remoteRunOnceShellLaunch` in `ptyService.ts`: `-c` on macOS/Linux,
  PowerShell `-EncodedCommand` on Windows, never cmd.exe). The CLI sends argv and
  the receiver renders it for its shell. `--wait` streams output and exits with
  the command's code. A Windows command line past 32,767 characters is refused
  (`command_too_long`).
- **Environment.** `ADE_LANE_ID=remote-work-<hash>`, `ADE_WORKSPACE_ROOT=<copy>`,
  and `ADE_CHAT_SESSION_ID` stays the caller's `remote:` id.
- **`--no-code`** (old `--scratch`) runs in an empty folder under
  `<ADE_HOME>/remote-work/scratch/`, removed when the shell ends.
- **Limits.** No submodules; large untracked files must be committed or ignored;
  push from the copy with `git push origin HEAD:<branch>`.
- **Cleanup.** `daex shell clean --machine <name>`; a week unused; the chat
  deleted or archived; low disk (oldest idle first). The brain sweeps
  `<ADE_HOME>/remote-work/projects.json` hourly (`sweepMachineRemoteWork`) and
  asks the chat's machine; silence never deletes. Copies holding unpushed work
  survive the soft cleanups; copies in use or whose device is in use are kept.
  An unreadable `copies.json` stops every change.
- **The simulator.** `daex apple … --machine <name>` with no `--lane` uses the
  copy as its lane (`remoteWorkLaneIdFor`), preferring one of the user's own free
  simulators; a device DAEX made is held while the copy exists.
- **Where it shows.** The chat's brain records each forwarded shell and
  simulator call in memory (`noteRemoteWork`); the chat header shows that
  machine's logo with the commands and Stop. Settings › Machines lists copies
  (`remote_work.list`, `remote_work.delete`).

## Choosing a machine for new work

Nothing moves by itself; "Least loaded" picks only when someone starts new work.

- `machine_stats.get` (domain `machine_stats`, agent-readable, through the
  machine's pin) reports CPU over a 200 ms sample, available memory (`vm_stat` on
  macOS), disk, running builds, battery, keep-awake, and (every 3 minutes at
  most) signed-in CLIs, Xcode and work copies. Cached 5 s; nothing runs unless
  asked.
- Each machine has a preference (Prefer, Normal, Less often, Manual only) in the
  account settings store (`machine.placement.<machineKey>`), with localStorage
  first for signed-out or SSH machines.
- `autoLaneMachine` scores headroom × preference (1.5 / 1 / 0.5); low disk loses
  first; **Manual only is never picked automatically**. Menus read stats only
  while open and only with two or more eligible machines.

## Moving a chat to another machine

`daex chat handoff <session> --to <name>` moves a chat **from** this machine; it
is never forwarded, and `--to` with `--cancel`, `--retry` or `--options` is an
error. Same move as the desktop and phone; see
[cross-machine session handoff](cross-machine-session-handoff.md).

```bash
daex chat handoff <session> --options --json      # machines, blockers with fixes
daex chat handoff <session> --to "Mac mini" --model … [--fork] [--include-changes] [--clone] [--when-turn-ends]
daex chat handoff <session> --cancel | --retry
```

The call returns the move record at once. An agent moving its own chat mid-turn
needs `--when-turn-ends`. Agents may move their own chat and descendants without
approval at each chat's own permission level (permission flags are dropped); an
unrelated chat waits for the person. Blockers come back one line each with a
fix.

## Policy

An agent on another machine is an **agent** there: clamped to `agent`, subject
to that machine's action policy, refused CTO-only, user-only and secret-bearing
actions and anything machine-wide. The account pairing is the trust boundary.

## How it works

- **Transport.** The CLI talks only to its own brain, wrapping requests in
  `machines.call`; the brain forwards over the agents' own paired connection
  (`agentMachineBridge.ts`), separate from the CTO's. One hop only.
- **Dead links redial.** The pool pings quiet connections every 20 s and checks a
  timed-out call once (`probeRpcLiveness`); a silent connection is dropped
  (`<prefix>.connection_dead`). Idle connections close after 90 s.
- **Identity.** Each request carries a `remoteCaller` claim; the target binds it
  to the authenticated paired device as `remote:<device>:<chat>`
  (`foreignCallerSessionId`). A local process claiming `ade-agent-remote` without
  a paired peer is refused.
- **Children and wakes.** A remote caller may parent a child only to itself. The
  brain's `externalChats` registry remembers the parent's machine and level.
  Completions go through `crossScopeChats.ts` and a durable outbox, over
  `machines.deliverWake` (retry 30 s → 5 min, give up after 24 h). Each remote
  child gets a random wake token; only a report carrying it for a child started
  there is accepted.
- **Devices and proof.** Device commands run there under the foreign owner. A
  proof capture's bytes are read back (`read_remote_caller_capture`, own
  captures, 15 minutes) and filed in this chat's drawer
  (`fileRemoteAppleProofHere`). The device pane there says "An agent on
  <machine> is driving this device" with **Free device**.
- **Clone.** `--clone` asks the target to set up the repo
  (`machines.cloneForAgent`; GitHub only, handoff storage preflight, its own
  credentials).
- **Long calls.** Three minutes by default; long verbs get their own budget plus
  a minute (`remoteMachineLongCallBudgetMs`), with `· still running …` progress
  every 30 s.
- **End of turn.** The chat service sends `release_remote_work_devices` to each
  machine whose devices the turn used (`onRemoteWorkTurnSettled`): leases and
  automatic recordings end, sessions stay running unowned. Every call carries the
  current `turnId`, so a late release is skipped. Offline machines are skipped;
  leases there expire in 10 minutes. This covers every chat provider; a
  provider's CLI using `--machine` relies on lease timeouts.

## Limits

- An agent's `daex machines list` is the agent-safe roster.
- A person's terminal with no chat starts remote children at `ask`.
- `--personal` children on another machine do not report back.
- A remote `chat create` that lost its answer leaves a child whose reports are
  refused.
- Children silent for a month are forgotten.
- Both machines need a DAEX with `agentRemoteCallers`.
- An App Control session started from another machine is not stopped at turn
  end.
- Builds run where the lane is (start a subagent on the Mac to build iOS).
- Windows: no new transports; paths compare by the target's platform rules.

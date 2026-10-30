# Cross-machine agents

Agents and the `ade` CLI can find, start, message and wait on chats on the
account's other machines, drive their devices, and hear back when a child they
started there finishes. The person's surfaces (the cross-machine Work list,
drafts on another machine, handoff) are described elsewhere; this is the agent
half.

## What an agent can do

```bash
ade machines list --text                          # roster: name, online, platform, projects
ade machines list --projects --text               # …with each machine's projects
ade chat list --machine "Mac mini" --text         # that machine's checkout of this repo
ade chat list --all-machines --text               # every machine, one table with a MACHINE column
ade lanes list --machine "Mac mini" --project Versic --text
ade chat read <id> --machine "Mac mini" --text
ade chat create --machine "Mac mini" --lane <lane there> --type subagent \
  --provider claude --model anthropic/claude-opus-5 --prompt "build and test the iOS app"
ade chat create --machine "Mac mini" --clone …    # set the repo up there first (GitHub only)
ade chat create --machine "Mac mini,Linux box" …  # one child per machine
ade chat launch "fix the flaky test" --machine "Mac mini"   # new lane there
ade chat wait <id> --machine "Mac mini" --for idle --timeout-ms 900000
ade chat message <id> --machine "Mac mini" --kind auto --text "also run the UI tests"
ade apple screenshot --machine "Mac mini" --lane <lane there>
ade apple proof --machine "Mac mini" --lane <lane there> --caption "Login works"
ade usage limits --machine "Mac mini" --text      # that machine's accounts and what is left
ade usage limits --all-machines --text            # every machine's accounts in one table
```

`--machine` takes a machine key or an unambiguous display name. On the other
machine the project is, in order: `--project <name|path|id>` (`--machine-project`
for commands that already use `--project`, such as `ade apple`), else the
checkout of this repository matched by normalized git origin. `--personal`
commands target that machine's projectless chats. This shell's lane is never
sent: name a lane there with `--lane` (from `ade lanes list --machine …`), or let
`chat launch` create one.

An offline machine fails at once with when it was last seen; nothing is queued.
`--all-machines` never fails for one machine: an offline or refusing machine is
one row saying so.

Provider quota belongs to the machine, not a project, so `usage limits` and
`usage snapshot` run in this repository's checkout there when it has one and
otherwise in the project that machine opened most recently (the `anyProject`
scope). A machine with no project open in ADE says so. A host older than
`usage.getUsageLimits` answers with its full snapshot, and the CLI cuts it down
to the same report.

`--machine` and `--all-machines` work only on the commands above (`chat`,
`lanes`, `projects`, `usage`, `apple`, `mac-desktop`, `app-control`, and their
aliases). Any other command refuses them rather than quietly answering for this
machine; `drafts` and `machines` keep their own `--machine` flag.

### A chat id without `--machine`

A chat id is unique across the account, so a chat command does not need
`--machine` to find it. Before `chat read|show|status|wait|send|message|steer|
interrupt|stop|respond|pending|resume|subagents` runs here, the CLI
(`cliChatLocate.ts`) asks this machine's brain `chats.locate`: booted scopes,
then each project's transcripts on disk, never a boot. If the chat is not here,
every online machine is asked the same at once (five seconds each; offline
machines are not asked). Exactly one match: the command runs there with the
chat's project (or `--personal`), and the CLI prints `· on <machine>` to
stderr. No match: the command runs here and fails as before, naming the
machines that were offline or did not answer. Two matches fail and list both.

The match is kept in `<ADE_HOME>/cache/chat-machines.json` (24 hours, 200
entries), so the next command asks only that machine. `ade chat locate <id>`
prints the answer. `chats.locate` is read-only and reachable by other
machines' agents; it names only the project, which `projects.list` already
shows them. A machine older than it answers "isn't available", reported as
"no answer". Through ADE MCP the CLI does not look anywhere else; ADE MCP
finds the computer and forwards the call itself (docs/features/ade-mcp).

## Running a command in a work copy there

`ade shell start --machine <name> [--wait] -- <command>` runs one command on
another machine for this chat, without a lane or a chat there. The other
machine keeps a **work copy** for the chat
(`apps/desktop/src/main/services/remoteWork/remoteWorkCopyService.ts`): a plain
git worktree under `<project>/.ade/remote-work/`, detached at the chat's commit,
with the chat's uncommitted changes applied as one binary patch. It is created
on the first command; nothing is installed in advance, and ignored files
(installed deps, build output) survive between runs.

- **Git moves code.** The CLI (`cliRemoteWork.ts`, `readLocalWorkSource`)
  sends the commit, the remote branch that holds it, and the patch as bytes
  (base64, 16 MiB at most), made with fixed diff options so the user's diff
  settings cannot break it. A commit that is not on origin is refused here:
  "Push it first". `--no-sync` and `--discard` are read only for a shell start
  or an Apple build with `--machine` and no `--lane`.
- **Never lose work there.** Before a sync the copy is compared with what the
  last sync wrote and with its checked-out commit. Unpushed commits, or files
  changed there and not committed, refuse the sync and name the files.
  `--no-sync` runs in the copy as it is (to commit and push from there);
  `--discard` resets anyway.
- **One command at a time.** A copy is busy from its sync until the command
  it was readied for has started (an Apple build: until the call returns), and
  while a shell runs in it. A synced command is refused while it is busy;
  `--no-sync` runs beside it. Another chat on the machine cannot read, type
  into or stop such a shell, and lane-wide terminal lists leave it out.
- **Limits.** Submodules are not initialised in a copy. Untracked files that
  are not ignored travel in the patch, so a large one must be committed or
  ignored. The copy follows the chat's commit, not a branch: commit and push
  from there with `git push origin HEAD:<branch>`.
- **The run.** The command runs once in that machine's shell, started clean
  and not interactive (`remoteRunOnceShellLaunch` in `ptyService.ts`: the
  saved terminal shell or Automatic, `-c` on macOS and Linux; on Windows
  PowerShell with `-EncodedCommand`, or Git Bash when that is the saved shell,
  never cmd.exe). The CLI sends ADE's canonical POSIX line, which Windows
  turns back into argv and writes for PowerShell. The shell ends with the
  command's exit code. `--wait` streams the output
  and exits with that code. The shell is owned by the caller's foreign id, so
  only that chat reads, writes or stops it (`ade terminal … --machine`).
- **Cleanup.** `ade shell clean --machine <name>`; a week unused; the source
  chat deleted or archived on its own machine; a low disk deletes other idle
  copies, oldest first, before a new copy is refused. The brain sweeps every
  project in `<ADE_HOME>/remote-work/projects.json` a minute after it starts
  and then hourly (`sweepMachineRemoteWork`), asking the chat's machine with
  `chats.locate` (which says `archived` when the project is running there);
  silence never deletes. The week-unused and low-disk cleanups keep a copy
  that holds work nobody pushed. A copy in use is never deleted. An unreadable
  `copies.json` stops every change rather than being read as empty.
- **The simulator.** `ade apple … --machine <name>` with no `--lane` uses the
  work copy as its lane there: the lane id is `remote-work-<hash>`
  (`remoteWorkLaneIdFor`), its build root is the copy, and the device registry
  treats it as live while the copy exists. Its first device is one of the
  user's own simulators on that machine that no lane holds (shut-down ones
  first; never an ADE device, which a lane's end would delete), attached so
  ADE never deletes it; only when none is free does ADE make one. `launch`, `installApp` and `runTests`
  sync the copy first; other verbs use it as it is. When the copy goes, the
  cleanup pass gives the device back.
- **Where it shows.** The chat's own brain records each shell and each
  simulator call as it forwards it (`noteRemoteWork`, in memory only, so a
  restart of that brain forgets it). The other machine returns its work
  copy's lane id with each answer (`workCopy.laneId`); an older machine does
  not, and then only the shells show. The chat header and session card show
  that machine's logo while the current turn uses it, with the commands and
  Stop. The terminal tool adds those commands, each with the machine's logo,
  read and stopped through that machine's pin. The iOS tool offers
  "Simulator · <machine>" beside "This lane" and stays visible on a host that
  cannot run a simulator; it never starts a device there, and says so when
  there is none. Settings › Machines reads `remote_work.list` (every project on that
  machine, from `<ADE_HOME>/remote-work/projects.json`) and deletes with
  `remote_work.delete` (desktop only).

## Moving a chat to another machine

`ade chat handoff <session> --machine <name>` moves a chat FROM this machine TO
that one: here `--machine` names the destination, and the command runs on this
machine's brain. The move form is never forwarded, so you cannot move a chat
that lives on another machine from here; and `--machine` with `--cancel`,
`--retry` or `--options` is an error, because those act on this machine's own
move. It is the same move
the desktop modal, the session menu and the phone start; see
[cross-machine session handoff](./cross-machine-session-handoff.md).

```bash
ade chat handoff <session> --options --json        # machines, blockers with fixes, what would travel
ade chat handoff <session> --machine "Mac mini" --model anthropic/claude-opus-5 \
  --prompt "run the UI tests next"                 # brief (default); --fork carries full history
ade chat handoff <session> --machine "Mac mini" --model … --include-changes   # bring uncommitted/unpushed work
ade chat handoff <session> --machine "Mac mini" --model … --clone             # set the repo up there first
ade chat handoff <session> --machine "Mac mini" --model … --when-turn-ends    # queue it from inside a turn
ade chat handoff <session> --cancel                # keep a queued or awaiting move here, or dismiss an unknown one
ade chat handoff <session> --retry                 # retry a failed or unknown move with the same choices
```

- The call returns the move record at once; the move continues in the brain
  and the chat's banner shows it. Read the record later with
  `ade chat handoff <session> --options --json` (`current`).
- An agent moving its own chat mid-turn needs `--when-turn-ends`. Any newer
  message from the person cancels a queued move (a scheduled wake or another
  agent's message does not).
- A chat-bound agent can move its own chat or a descendant it started. The
  brain checks the persisted parent chain up to 32 links and stops on cycles.
  Starting a move for an unrelated chat asks the person for approval even if
  that chat is full-auto; its approval card names both chats. Cancel, retry,
  acknowledge and preview stay within the caller's own chat and descendants.
- An agent's move runs at the chat's own permission level: permission flags
  (`--permissions`, `--sandbox`, …) are dropped, and the destination chat gets
  the source chat's level in the target model's provider (a provider that
  can't express it steps down, never up).
- An `unknown` move (the answer was lost) blocks a new one until it is retried
  or dismissed with `--cancel`. A retry whose chat changed since the move was
  sent is refused for `unknown` (it may have landed) and prepared afresh for
  `failed`.
- An agent may move its own chat and descendants it started without approval,
  at each chat's existing permission level. An unrelated chat always waits
  for the person's approval, regardless of its permission level. An `ade` shell
  with no chat identity counts as an agent.
  Approval request limits and the two-minute deny cooldown are scoped to the
  target chat.
- Once a move reaches `continued`, the source brain refuses agent, CLI and
  remote turn requests with the destination machine and chat id. Automatic
  work stays pending until the person chooses **Work here instead**. Desktop
  sends still route to the destination; the person's explicit work-here choice
  unlocks the source.
- Blockers come back as one line each with a fix ("run `ade git push --lane …`,
  or pass --include-changes"); nothing is sent while any remain.

## Policy

An agent on another machine is an **agent** there: the target clamps it to
`agent`, applies its own action policy, and refuses CTO-only, user-only and
secret-bearing actions. Settling, interrupting another chat, and anything
machine-wide (sync, account, updates, project registry writes) stay refused,
exactly as for a local agent. There is no extra switch; the account pairing is
the trust boundary, as it is for the person's own desktop.

## How it works

- **Transport.** The CLI talks only to this machine's brain, wrapping each
  request in `machines.call`. The brain forwards it unchanged over the agents'
  own paired connection (`services/account/agentMachineBridge.ts` on top of the
  pool in `machineBridge.ts`), separate from the CTO's (a host keeps one
  connection per paired device, and the identity a connection initializes with
  is the identity of every call on it). One hop only: a request that came from
  another machine is never relayed to a third.
- **Identity.** Each request carries a claim `remoteCaller` (calling chat,
  machine key and name, permission level). The target binds it to the paired
  device it authenticated: the caller becomes `remote:<device>:<chat>`
  (`foreignCallerSessionId`), with its own project handler, so PTY, device and
  proof ownership see a distinct, non-local chat. A local process naming itself
  `ade-agent-remote` without a paired peer is refused. A foreign caller never
  inherits the brain's environment identity.
- **Children and wakes.** A child started from another machine (or from another
  project, or a personal chat) records its parent's id as usual — the foreign id
  for a remote parent. A remote caller may parent a child only to itself; naming
  any other chat as the parent is refused. The brain's `externalChats` registry
  remembers where that parent lives and its permission level, so the child is
  clamped to the real level rather than `ask`, and is not mistaken for an
  orphan. When the child's turn ends, its chat service hands the completion to
  the brain's router (`services/chat/crossScopeChats.ts`). Only a parent the
  brain recorded is routed; any other missing parent was deleted, and the child
  says so at once, as before. A durable outbox delivers it into another scope on
  this machine (booting at most that one scope), or over the bridge
  (`machines.deliverWake`) to the parent's machine, retrying from 30 s to 5 min,
  skipping a dark machine for the rest of a pass, and giving up after 24 h with
  a notice on the child.
- **Who may wake a parent.** When an agent starts a child on another machine,
  its brain issues a random wake token with the request. The target stores it
  with the child and returns it with every report; the parent's machine accepts
  a report only for a child it started there, carrying that token. Knowing the
  ids (any machine on the account can list them) is not enough to inject a turn.
  A refused report is not retried. The parent transcript dedupes a repeat by the
  child's turn id. The parent sees the usual completion row with
  "· on <machine>", and its wake text names the `ade chat read … --machine`
  command.
- **Devices and proof.** `ade apple`, `ade mac-desktop` and `ade app-control`
  run on the other machine under the foreign owner, so the existing single-owner
  checks arbitrate between agents. Paths that name this machine's checkout are
  stripped before sending. A proof command's capture runs there; its bytes are
  read back (`read_remote_caller_capture`: only that caller's own captures, only
  for 15 minutes) and filed in THIS chat's proof drawer. That machine's Apple
  device pane says "An agent on <machine> is driving this device", with
  **Free device** (confirmed first; it ends that agent's session only if the
  same agent still holds the device, and the agent may take it again), and the
  phone's ownership ribbon names the same "an agent on <machine>".
- **Clone.** `--clone` asks the target to set the repository up
  (`machines.cloneForAgent`): GitHub only, the default projects folder, the
  handoff storage preflight, the target's own Git credentials.

## Limits

- `ade machines list` from an agent's shell shows the agent-safe roster (name,
  key, status, platform, last seen, projects with `--projects`), not the
  account directory a person's terminal gets.
- A person's terminal on another machine (no chat) starts children there at
  the cautious `ask` level: there is no chat whose level to inherit.
- `--personal` children on another machine do not report back; personal chats
  take no parent.
- If a remote `chat create` loses its answer (a timeout after the target
  created the child), this machine never learned the child, so that child's
  reports are refused and it says it could not reach its parent.
- A child that has not reported for a month is forgotten on both machines; a
  later report is refused the same way.

- Both machines need this ADE version; an older target is reported as
  "update ADE there" (capability `agentRemoteCallers`).
- Recordings started with `--machine` are filed on that machine; only stills
  (`proof`) are filed back here.
- A remote device session is not released automatically when the calling turn
  ends; the agent stops it, or the person frees the device from that machine's
  pane.
- Builds run where the lane is. To build an iOS app from a Linux box, start a
  subagent on the Mac (`ade chat create --machine …`) and let it build and drive.

## Windows

All of it is Node over the existing transports: no new sockets or pipes. Paths
on the other machine compare by that machine's platform rules. Apple and Mac
Desktop hosts remain macOS-only by capability; a Windows or Linux caller drives a
Mac host like any other.

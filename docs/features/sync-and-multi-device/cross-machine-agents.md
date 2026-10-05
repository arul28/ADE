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

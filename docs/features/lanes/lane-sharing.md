# Lane sharing

Lane sharing gives another DAEX account (the guest) limited access to one lane
on one of the owner's machines (the host). The guest sees the lane's chats and
sessions and can comment, write drafts or run turns when allowed. The lane,
worktree, chats and provider sign-ins stay on the host. The guest never gets a
pairing, a sign-in or a credential of the owner.

| Part | Where | Holds |
|---|---|---|
| Account directory | `apps/account-directory/src/laneShares/` (Worker + D1) | The index of grants (giver, receiver, lane, machine, preset label, risk label, end date, state), invites, one-use tickets, revocation. No detailed rights; a grant never opens a machine. |
| Host | `apps/ade-cli/src/services/sync/laneShare*.ts` (brain) | Rights per grant (local only), guest gates, message counters, the move service. **The only authority** over what a guest may do. |
| Clients | `apps/desktop/src/renderer/components/laneShare/**` (desktop and web) | Owner share sheet and marks, Settings › Sharing, the guest's shelf, page and connection. |

The trust statements live in
[`apps/account-directory/README.md`](../../../apps/account-directory/README.md#lane-sharing);
this page explains how the code meets them.

## Source file map

| File | Owns |
|---|---|
| `apps/account-directory/src/laneShares/` | Directory routes, invites and email limits, tickets, grant rows. |
| `apps/desktop/src/shared/laneShareRights.ts` | Rights type, parser, presets, risk, agent ceiling, display name. |
| `apps/desktop/src/shared/types/laneShare.ts`, `laneShareDirectory.ts`, `laneShareGuestDirectory.ts` | Contracts, directory shapes, the guest's account calls. |
| `apps/desktop/src/shared/laneShareMove.ts`, `messageAuthor.ts` | Move trust rules and payload; host-stamped message author. |
| `apps/ade-cli/src/services/sync/laneShareHostService.ts` | The `lane_share` owner actions. |
| `apps/ade-cli/src/services/sync/laneShareGrantService.ts` | Grant list and ticket redemption (fail closed). |
| `apps/ade-cli/src/services/sync/laneShareGuestHello.ts`, `laneShareGuestRouter.ts`, `laneShareGuestHost.ts`, `laneShareGuestGates.ts` | Guest hello and admission, routing to the right project, peers and per-envelope gates. |
| `apps/ade-cli/src/services/sync/laneShareGuestPolicy.ts`, `laneShareGuestCommandPrep.ts`, `laneShareGuestScrub.ts`, `laneShareGuestQueue.ts` | Default-refuse lists, locks and limits, payload scrubbing, queued-message re-checks. |
| `apps/ade-cli/src/services/sync/laneShareMoveService.ts` | Moving a chat. |
| `apps/desktop/src/main/services/lanes/laneShareRightsStore.ts` | Host rights and counters (two local-only tables). |
| `apps/desktop/src/main/services/chat/laneShareMoveChat.ts`, `laneShareMoveTransfer.ts` | Landing a moved chat; bundle bytes. |
| `apps/desktop/src/renderer/components/laneShare/`, `guest/` | Owner UI; guest connection, store, shelf, page, chat pane, move. |
| `apps/desktop/src/renderer/webclient/sync/relayReady.ts` | Relay ready handshake for browser sockets. |

## Gotchas

- **The host is the only authority.** Every guest envelope and command goes through the default-refuse lists in `laneShareGuestPolicy.ts`. A new guest-reachable command needs a rule there with its scope, kept arguments and right.
- **Never trust a client's lane id.** Guest commands resolve the session's lane from the host's own database.
- **Rights can change mid-command.** The host compares the rights object right before running (no await in between), refuses a stale one, and gives back the counted message.
- **Caller class comes from the session, never arguments.** Anything not exactly `person` is an agent.
- **Both host tables are local-only** (`LOCAL_ONLY_CRR_EXCLUDED_TABLES`); never let them replicate.
- **Windows hosts cannot offer CLI typing** ([Platform notes](#platform-notes)).

## Rights

`LaneShareRights` (`laneShareRights.ts`). Anything from outside the builders
goes through `parseLaneShareRights`: unknown keys are dropped, and only an
exact `true` turns a switch on.

| Group | Switches |
|---|---|
| See | `chats`, `subagentChats`, `cliSessions`, `shells` (read only), `historyBeforeShare` |
| Speak | `comment`, `drafts`, `send`, `steer`, `interruptAnyTurn` |
| Run | `startChats`, `startCliSessions`, `typeInCliSessions`, locks on `models`, `reasoningLevels`, `permissionModes` |
| Decide | `approvals`, `questions` |
| Tools | One read switch per domain; only `file`, `git`, `diff`, `pr` grant reads (`LANE_SHARE_TOOL_READS`). |
| Limits | `messagesPerDay`, `messagesTotal`, `endsAt` |
| Privacy | `hideMachines`, `hideModels` |

Presets: **Watch** (see chats, subagents, CLIs, shells from the share's
start), **Comment**, **Suggest** (drafts the owner sends), **Collaborate**
(send, steer, new chats; modes locked to `default`/`plan`; 50 messages a day;
the owner still answers approvals and questions).

`laneShareRiskLevel`: **High** for CLI typing or starts, approvals, the
terminal switch, and unlocked permission modes; **Medium** for other turn
starts, interrupting others, questions, history, tool reads; **Low**
otherwise. A high-risk share needs `confirmHighRisk: true`; the host refuses
the write without it. `laneShareMayMove` (Collaborate) gates moves.

## The owner's side

The `lane_share` action domain on the lane's machine
(`laneShareHostService.ts`): `create`, `list`, `updateRights`, `revoke`,
`resendInvite`, `listReceived`, `leave`, `move*`. A person may call all of
them; an agent only `list`, a Watch `create` and `revoke`. Other actions are
user-only (`ADE_ACTION_USER_ONLY`; `mayUseUserOnlyActions` in
`adeRpcServer.ts` admits only a DAEX desktop client with no agent identity).
A guest never reaches the domain.

The renderer calls `window.ade.laneShare.*` with the lane's pin. The hosted
web client answers `lane_share_desktop_only`.

- `create` asks the directory for an invite with the owner's token, then stores the rights locally.
- `revoke` closes the guest's connections first, removes queued messages not yet started, then tells the directory; a failed directory call leaves the share "removed here" with **Retry**.
- The host pushes `lane_share_event` (`lane_share_changed`, `lane_share_presence_changed`, `lane_share_guest_turn_running`, `lane_share_move_changed`); `laneShareStore.ts` refreshes from these, so a lane with no share costs no extra call.

### Shares made by an agent

An agent can make only a read-only share, so a share made by an agent cannot
change anything on the host.

- **Who is an agent:** caller class comes from the RPC session (`run_ade_action` drops any `callerClass` argument). A person is a DAEX desktop client with no agent identity; everyone else (the CLI, an agent's shell, a DAEX MCP connection, another brain) is an agent.
- **The ceiling:** `laneShareAgentRightsRefusal` refuses, never clamps, any switch above Watch, naming each. Privacy, end date and limits may be set. An agent's share must come out low risk (`agent_watch_only`).
- **Rate:** 5 agent shares an hour per machine (`AGENT_SHARES_PER_HOUR`, in memory).
- **Privacy defaults:** an agent's share hides at least what the person's `laneShare.defaultRights` hide; unreadable defaults hide both.
- **No change of a share:** refused when the lane and email already have a live share or a create in progress.
- **Record and notice:** rows store `created_by`; surfaces show "Made by an agent". A new agent share shows the owner a sticky toast once with **Remove** and **View** (`laneShareAgentNotice.tsx`).
- **CLI:** `daex lanes share --lane <lane>` lists; `--add <email>` makes a Watch share; `--remove <email|grant id>` stops one. `--access` takes only `watch`.
- **DAEX MCP:** a read-only connection can only list (the command policy allows only the list form, and the runtime refuses `create`/`revoke` for MCP sessions under `cto`).
- Changing `laneShare.defaultRights` is person-only.

### Surfaces

- Lane menu: **Share lane…**, **Manage sharing…**, **Stop sharing with all**.
- Share sheet (`LaneShareSheet.tsx`, `LaneShareRightsPanel.tsx`): email, people with access, access level with live risk, and a "More options" fold.
- `LaneShareMark.tsx` on the lane row and header; `LaneShareHeaderButton.tsx` in a shared lane's chat (filled while a guest is connected; "Move this chat to them…").
- A guest's messages show "From <name>"; drafts name their author.
- **Settings › Sharing** (`SharingSettingsPage.tsx`, desktop only): Lanes you shared (from the directory, `GET /lane-shares/given`, so it works with no computer online), Lanes shared with you, and Default access (`laneShare.defaultRights`). Rights changes go only through the lane's computer; a directory-side revoke takes effect at the host's next grant read (30 s).

### Host records

`laneShareRightsStore.ts` keeps rights and counters per grant in two local-only
tables. Calls are synchronous, so `claimMessage` is atomic: two requests cannot
both take the last message. The items table records a guest's drafts and
comments (the only ones it may edit), queued messages (removed on revoke) and
the chats it sent turns into.

## The guest connection

### Reaching the host

1. The guest asks the directory for a ticket (`POST /lane-shares/:id/connect`) with its own token and its DPoP key thumbprint (desktop in main via `accountBridge.ts`; web with the page's session).
2. It dials the host's **DAEX Relay** address only; the directory never gives out LAN or tailnet addresses.
3. It sends a hello with `auth: { kind: "guest", deviceId, ticket, dpop }`. `parseHelloPayload` refuses a guest hello that also carries an account or relay token or a secret.
4. The host redeems the ticket with its owner's token (`POST /lane-shares/host/redeem`), admits only a hello signed by the ticket's DPoP key, and never writes a pairing record.
5. `hello_ok.laneShareGuest` names the user and lanes. Refusals: `lane_share_refused`, `lane_share_unavailable` (retry later), `lane_share_paused` (archived lane or no rights set).

**Any project of the machine.** The shared sync listener serves one project at
a time, so a guest landing on the wrong project is redeemed there and handed
(`releasePeerForHandoff`) to `laneShareGuestRouter.ts`, which picks the project
with the grant's repository. A non-served project serves guests from a
guests-only host (`laneShareGuestsOnly`: no listener, discovery or changesets),
stopped after two idle minutes.

While a guest is connected, the host re-reads its grant list every 30 s
(`LANE_SHARE_GRANT_REFRESH_MS`); a missing grant gives no access. With no guest,
no timer runs. At most 3 devices per guest per grant.

### What the host lets through

`laneShareGuestPolicy.ts` is default refuse:

- **Inbound:** heartbeat, command, chat and terminal subscribe/history, `chat_tool_result`, `terminal_input` (a CLI session with the typing right, never a shell), `file_request` (granted lane, file switch on). Changesets, project/roster requests, resize, writes, pairing and runtime RPC are refused.
- **Commands** (`LANE_SHARE_GUEST_COMMANDS`): a fixed list of `work.*`, `chat.*`, `git.*` and `prs.getForLane`, each with scope, kept arguments and right. A spawned chat also needs `subagentChats`. `chat.getImageDataUrl` and `chat.getTurnFileDiff` have their own narrow file rules.
- **Outbound:** replies, session payloads of the granted lane the rights see, and `lane_share_guest_changed`. Brain status, the project catalog, changesets, the roster and screen streams never go to a guest.
- **Rate limit:** 200 envelopes per 10 s per connection.

`laneShareGuestCommandPrep.ts` enforces model/reasoning/mode locks (a new chat
starts with the guest's named value or the first allowed one, never a host
default), counts messages before the turn, checks ownership of drafts and
comments, and sets the verified author. `laneShareGuestScrub.ts` removes
owner-only card text, hidden model and machine names, history before the share
(item by item, by each item's own time), and DAEX's own files. File and diff
reads carry `refuseIgnored`; git reads carry `onlyLaneHistory`.

### The guest's client

- `laneShareGuestConnection.ts` never registers as a sync client, never touches a project database, and drops unknown envelope types.
- **Work shelf** (`LaneShareGuestShelf.tsx`): "Shared with me", connecting only when the user opens a shared lane.
- **`/shared` page** (`LaneShareGuestPage.tsx`, no project needed, also on the web): where invite links land (`?grant=<id>`), handling signed-out, wrong account, the owner's own link, pending (Accept and open) and active.
- **Shared chat** (`LaneShareGuestChatPane.tsx`): the real `AgentChatPane` with a `lane_share_guest` scope; every call goes through the guest connection. Locked controls show disabled with the reason.

Invite links: `https://ade-app.dev/open?type=lane-share&id=<grant>` and
`daex://lane-share/<grant>` (`shared/deeplinks.ts`; `ade://` still opens). The
grant id (`ls_` + 32 hex) is an address only.

## Message author

`messageAuthor.ts` stamps `AdeMessageAuthor` (`{ kind: "host" | "guest",
userId, name }`) as `metadata.author` on user messages,
`DraftEntry.author` and `ChatThreadComment.author`.

- The host removes any caller-sent author and stamps its own; the guest's name comes from the directory, never the guest. An absent author is the host's user.
- A guest's text is a plain prompt: messages starting with `/` or `!` are refused (`lane_share_plain_text_only`), and no `@chat:` expansion runs.
- A guest's thread comment joins a send only when the owner names it in `includeGuestComments` with the body `revision` the owner saw.
- For a guest's message, the agent's text gets a note asking for a `Co-authored-by` trailer (`laneShareCoAuthorNote`), only with a trusted name.

## Moving a chat to the other person

The owner, or a guest with Collaborate, can move a chat of the shared lane with
its unpushed work to the other person's computer. Rules: `laneShareMove.ts`
and the directory README. The directory carries none of the move.

- `laneShareMoveService.ts` plays source, destination, receiver and packer.
- Consent lives on the receiving person's machine: refused by default, 15 minutes, single use, ended by revoke, leave, end or pause. One move per share at a time.
- The payload is a fixed field list (`parseLaneShareMovePayload`); no sign-in, token, provider session or secret moves.
- The bundle goes in 384 KiB chunks over the guest connection, ≤ 50 MiB, SHA-256 checked.
- `laneShareMoveChat.ts` lands it in a new lane on a new branch with git hooks off, in plan mode on a model this machine has, shared back by the receiving account. The source chat gets a `lane_share_moved` notice.

## Platform notes

CLI typing (`run.typeInCliSessions`) is a capability of the host machine. On
Windows, DAEX starts a CLI inside a shell without exec, so the host cannot tell
which program reads keys. The host computes `cliTyping`
(`laneShareCliTypingFor`); a Windows host stores the right as off, the owner's
switch is inert with the reason, and the guest sees "Typing into a CLI is not
available on this computer of <owner>." The host still refuses typed lines with
`lane_share_cli_typing_unavailable`.

Phone guests are out of scope. Each successful owner mutation records one
`ade_feature_used` (`feature: "lanes"`); see [logging](../../logging.md).

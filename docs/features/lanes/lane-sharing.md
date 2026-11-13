# Lane sharing

Lane sharing gives another ADE account limited access to one lane on one
machine of the owner. The other person (the guest) sees the lane's chats and
sessions, and can comment, write drafts or run turns when the owner allows
it. The lane, its worktree, its chats and its provider sign-ins stay on the
owner's machine (the host). The guest never gets a pairing, a sign-in or a
credential of the owner.

Three parts work together:

| Part | Where | What it holds |
|------|-------|---------------|
| Account directory | `apps/account-directory/src/laneShares/` (Worker + D1, migrations 0023–0025) | The index of grants (giver, receiver, lane, machine, preset label, risk label, end date, state), invites, one-use tickets and revocation. No detailed rights. A grant here never opens a machine. |
| Host | `apps/ade-cli/src/services/sync/laneShare*.ts` (brain) | The rights of each grant (`laneShareRightsStore.ts`, local only), the guest connection gates, the message counters and the move service. The host is the only authority over what a guest may do. |
| Clients | `apps/desktop/src/renderer/components/laneShare/**` (desktop and hosted web) | The owner's share sheet and marks, Settings › Sharing, the guest's shelf, page and connection. |

The trust statements of the directory and the host are in
[`apps/account-directory/README.md`](../../../apps/account-directory/README.md#lane-sharing),
"Lane sharing". This page explains how the code meets them.

## Rights

`apps/desktop/src/shared/laneShareRights.ts` defines `LaneShareRights`. The
host enforces it, and the desktop and web client show and edit it. Every
rights object that comes from outside this file's builders goes through
`parseLaneShareRights`: it keeps only the keys this version knows, and only
an exact `true` turns a switch on. An unknown key, a wrong type or a value
that is not an object reads as off.

| Group | Switches |
|-------|----------|
| See | `chats`, `subagentChats`, `cliSessions`, `shells` (always read only), `historyBeforeShare` |
| Speak | `comment`, `drafts`, `send`, `steer` (own turns), `interruptAnyTurn` (turns of others) |
| Run | `startChats`, `startCliSessions`, `typeInCliSessions`, and the locks `models`, `reasoningLevels`, `permissionModes` |
| Decide | `approvals`, `questions` |
| Tools | One read switch per action domain (`file`, `git`, `diff`, `pr`, `terminal`, `built_in_browser`, `ios_simulator`, `mac_desktop`, `android_emulator`, `app_control`). Only `file`, `git`, `diff` and `pr` grant reads (`LANE_SHARE_TOOL_READS`). The other switches are kept but grant nothing. |
| Limits | `messagesPerDay` (host local day), `messagesTotal`, `endsAt` |
| Privacy | `hideMachines`, `hideModels` |

Presets (`laneSharePresetRights`):

- **Watch** sees chats, subagent chats, CLI sessions and shells from the
  share's start on.
- **Comment** adds comments on agent replies.
- **Suggest** adds drafts. Only the owner sends a draft.
- **Collaborate** adds send, steer and new chats, with the permission mode
  locked to `default` and `plan`, and a limit of 50 messages a day. The
  owner still answers every approval and question.

The directory keeps only a preset label (`laneSharePresetLabel`: the largest
preset whose switches are all on) and a risk label. It never decides access.

`laneShareRiskLevel` gives the risk level and plain reasons:

- **High:** typing into or starting CLI sessions, answering approvals, the
  terminal switch, and turns whose permission mode is not locked to
  ask-first modes.
- **Medium:** other ways to start a turn, stopping turns of others,
  answering questions, history before the share, and tool reads.
- **Low:** everything else.

A high-risk rights object needs the owner's explicit confirmation
(`confirmHighRisk: true`). The share sheet asks with the "Confirm high risk
share" dialog, and the host refuses the write without the flag
(`laneShareHighRiskRefusal`).

`laneShareMayMove` (send and start chats, that is Collaborate) decides
whether a guest may move work. `laneShareDisplayName` cleans a person's name
before a guest or a commit trailer shows it.

## The owner's side

### Making and changing a share

The owner's actions are the `lane_share` action domain on the lane's machine
(`laneShareHostService.ts`): `create`, `list`, `updateRights`, `revoke`,
`resendInvite`, `listReceived`, `leave`, and the `move*` actions. A person in
the ADE app may call all of them. An agent may call only `list`, `create` (a
Watch share) and `revoke`; see [Shares made by an agent](#shares-made-by-an-agent).

- `actionPolicy.ts` keeps every other `lane_share` action user-only
  (`ADE_ACTION_USER_ONLY`) and away from automations.
- `adeRpcServer.ts` (`mayUseUserOnlyActions`) admits to those only an RPC
  caller that names itself as an ADE desktop client and carries no agent
  identity.
- A guest never reaches the domain. Its connection has no runtime RPC
  channel.

The renderer calls `window.ade.laneShare.*` with the lane's pin
(`callLaneShareAction` in `preload.ts`). A null pin is the tab's machine.
The hosted web client has no runtime action channel for these verbs, so its
adapter answers `lane_share_desktop_only`.

`create` asks the directory for an invite with the machine owner's account
token, then stores the rights in the host's own table. `revoke` closes the
guest's connections on this machine first, removes the guest's queued
messages that have not started, and then tells the directory. When the
directory call fails, the share stays "removed here" with **Retry**
(`directoryRevoked: false`).

The host pushes `lane_share_event` on its runtime event stream:
`lane_share_changed`, `lane_share_presence_changed`,
`lane_share_guest_turn_running` and `lane_share_move_changed`.
`laneShareStore.ts` keeps one share list per machine and refreshes it from
these events, so a lane with no share costs no extra call.

### Shares made by an agent

An agent can make a share, but only a read-only one, so that in the worst
case a share made by an agent cannot change anything on the host.

- **Who is an agent.** The host's RPC server sets the caller class of every
  `lane_share` call from its own session, never from the call's arguments
  (`run_ade_action` drops any `callerClass` the caller sent, and refuses
  positional arguments for the domain). A person is
  `mayUseUserOnlyActions(session)`: an ADE desktop client name with no agent
  identity, on this machine or a paired desktop (`ade-desktop-remote`).
  Everyone else is an agent: the `ade` CLI, an agent's shell, an ADE MCP
  connection, another machine's brain. The action registry passes the class
  to the host service (`laneShareCallerOf`), and anything that is not exactly
  `person` is an agent.
- **What an agent may do.** `list`; `create` with Watch rights only; `revoke`
  of a share of this machine and project. Every other action answers "Only a
  person in the ADE app can do this." (`person_only`).
- **The ceiling.** `laneShareAgentRightsRefusal` (`laneShareRights.ts`)
  refuses, and never clamps, any switch above the Watch preset: history
  before the share, every Speak, Run, Decide and Tools switch, and any model,
  reasoning or mode entry. The refusal names each switch. Privacy switches,
  the end date and message limits may be set. No rights means the Watch
  preset. An agent cannot confirm a high-risk share, and the host refuses an
  agent's share that does not come out low risk (`agent_watch_only`).
- **Rate.** At most 5 shares an hour per machine from agents, on top of the
  directory's limits (`AGENT_SHARES_PER_HOUR`). One counter in the brain
  process serves every open project (`createLaneShareAgentRate`); a refused
  or failed create does not count. The counter is in memory, so a restart
  resets it; the directory's daily invite limit still holds.
- **Privacy defaults.** An agent's share hides at least what the person's
  saved default rights hide (`laneShare.defaultRights`: hide machines, hide
  models). The call's own switches can only add hiding. Nothing else of the
  defaults counts, and when they cannot be read the share hides both.
- **No change of a share.** The host refuses an agent's share for a lane and
  email that already have a live share, made by a person or an agent, before
  it calls the directory ("This person already has a share of this lane.
  Change it in the ADE app."). It checks its own rows (an end date in the
  past ends a row), the directory's live grants, and a create of the same
  pair still in progress.
- **Record.** The host's rights row records `created_by` (`person` or
  `agent`; a row from before reads as `person`). `lane_share.list` returns it
  as `createdBy`, and the share sheet's guest row and Settings › Sharing show
  "Made by an agent". A person may raise such a share later; the label stays.
  The share emits the usual `lane_share_changed` event.
- **Owner notice.** On each read of a machine's share list, a new live share
  that an agent made shows the owner a sticky toast once: "An agent shared
  the lane <lane> with <email>. Watch only.", with **Remove** (a revoke with
  that machine's pin) and **View** (the share sheet). The noticed grant ids
  and each list's last read time are kept in this viewer's local storage
  (`laneShareAgentNotice.tsx`, `agentSharesToNotice`). A share made while
  the app was closed shows on the next read of that list, and a reconnect
  shows nothing again. On the first read of a list (a new project, a new
  machine, a list the record forgot), only shares made in the last 24 hours
  show, so an old install does not show every share at once. The label stays
  the durable signal.
- **The CLI.** `ade lanes share --lane <lane>` lists, `--add <email>` makes a
  Watch share (`--ends`, `--hide-machines`, `--hide-models`), and `--remove
  <email|grant id>` stops one. `--preset` takes only `watch`. Each meaning has
  one flag, and the command refuses a word it does not know.
- **ADE MCP.** A read-only connection can list shares only. The command
  policy lets `lanes share` through only in its list form (`--lane`,
  `--lane-id`, `--project-root`, `--text`, `--json`, `--pretty`,
  `--compact`); any other flag or word is a write, and so is `actions run`
  of a `lane_share` write. The runtime also refuses `lane_share.create` and
  `revoke` for a session with an ADE MCP connection id and a role under
  `cto`, which is how a read-only connection runs the CLI. A full-access
  connection can list, make a Watch share and stop a share.
- **Default rights.** `account_settings.set` or `remove` of
  `laneShare.defaultRights` is for a person only, by the same test.

### Surfaces

- **Lane menu** (`laneContextMenuItems.tsx`, `useLaneShareMenu.ts`):
  **Share lane…**, and for a lane with live shares **Manage sharing…** and
  **Stop sharing with all**.
- **Share sheet** (`LaneShareSheet.tsx`, `LaneShareSheetHost.tsx`,
  `LaneShareRightsPanel.tsx`): one column. The email field, then the people
  with access (hidden while empty), then the access level of the selected
  person or of the next invite, with the risk level live. The end date, the
  privacy switches and every single right are under one "More options" fold.
- **Share mark** (`LaneShareMark.tsx`) on the lane sidebar row and the lane
  header, while the lane has a pending or active share.
- **Chat header icon** (`LaneShareHeaderButton.tsx`) in a chat of a shared
  lane, filled while a guest is connected. Its panel lists who has access,
  their access level, messages left and end date, "Move this chat to them…"
  for an accepted guest, and **Manage sharing**.
- **Author labels**: the host stamps a guest's messages, drafts and thread
  comments with an author (see [Message author](#message-author)). The
  transcript shows "From <name>" under a guest's message
  (`AgentChatMessageList.tsx`), and a guest's draft names its author
  (`draftsFormat.ts`). The owner's own messages stay unlabelled.
- **Settings › Sharing** (`SharingSettingsPage.tsx`, `sharingSettings.css`,
  account level, desktop only), three sections on one page: **Lanes you
  shared** across every machine of the account, grouped by project, one row
  per person (person, lane, access, state, and a menu with Change access,
  Re-send invite and Remove access; **Stop sharing all** per project);
  **Lanes shared with you** with Accept, Open, Decline and Leave; and
  **Default access** (`laneShareDefaults.tsx`, account settings key
  `laneShare.defaultRights`, scope `all`), the start value of the sheet for a
  new person. "Lanes you shared" is read from the account directory
  (`laneShareGuest.listGiven`, `GET /lane-shares/given`), so it lists every
  share with no project open and no computer online; an online copy of the
  open project adds its own rows' rights, usage and connections. Revoke goes
  to the lane's computer for a share of that copy (the guest drops at once)
  and to the directory otherwise (`laneShareGuest.revokeGiven`); the lane's
  computer then drops a connected guest at its next grant read (30 s) and
  refuses every new connection. Rights and the end date change only through
  the lane's computer: it holds them, and a lane whose computer is off has
  no guest to apply them to.

### Host records

`apps/desktop/src/main/services/lanes/laneShareRightsStore.ts` keeps the
rights and the message counters of each grant, keyed by grant id, in two
tables (`LANE_SHARE_RIGHTS_TABLE`, `LANE_SHARE_GUEST_ITEMS_TABLE`). Both are
in `LOCAL_ONLY_CRR_EXCLUDED_TABLES` (`kvDb.ts`), so no other replica can
change them. Every call is synchronous, which makes `claimMessage` an atomic
increment: two requests at once cannot both take the last message.

A guest command checks the rights, then awaits its preparation (a model
list, a chat summary). An owner's edit gives the connected guest a new
rights object. Right before the command runs, with no await in between, the
host refuses it when the rights object is no longer the one it started with
("Your access to this shared lane changed. Try again."), and it gives back
the counted message and any held draft or comment. A typed CLI line follows
the same rule after it waits in the input queue. A move reads the current
rights at each check.

The items table records what a guest wrote or queued on this host: its
drafts and thread comments (the only ones it may edit or remove), its queued
messages (removed on revoke) and the chats it sent turns into.

## The guest connection

### Reaching the host

1. The guest's client asks the directory for a ticket
   (`POST /lane-shares/:id/connect`) with its own account token, and names
   its DPoP key thumbprint. Desktop does this in the main process
   (`accountBridge.ts`, `window.ade.laneShareGuest.connect`). The web client
   does it with the page's account session. `laneShareGuestDirectory.ts`
   checks every id, URL and ticket the directory answers.
2. The guest dials the host's ADE Relay address only. The directory never
   gives out LAN or tailnet addresses. `relayReady.ts` runs the relay's
   ready handshake for both the paired sync connection and the guest
   connection. Desktop allows the relay origins in the renderer CSP
   (`relayConnectSources` in `rendererCsp.ts`).
3. The guest sends a hello with `auth: { kind: "guest", deviceId, ticket,
   dpop }` (`SyncHelloAuth` in `shared/types/sync.ts`).
   `parseHelloPayload` drops every other field and refuses a guest hello
   that also carries an account token, a relay token or a secret.
4. The host redeems the ticket with its owner's token
   (`POST /lane-shares/host/redeem`, `laneShareGrantService.ts`). It admits
   the user id from the directory's answer, and only for a hello signed by
   the DPoP key the ticket was minted for. It never writes a pairing record.
5. `hello_ok.laneShareGuest` tells the guest its user id and granted lanes.
   A refusal is `hello_error` with `lane_share_refused` (no active grant),
   `lane_share_unavailable` (the host could not check its grant list; retry
   later) or `lane_share_paused` (the lane is archived, or this computer has
   no rights set for the share).

### Any project of the machine

A brain serves one project on its shared sync listener at a time (the one
opened last), but a lane may be shared from any of its projects. So a guest
reaches its lane whatever project is served:

- A guest that lands on another project's host is redeemed there. When the
  grant's repository is not that project's, the host lets go of the socket
  (no close, no listener left: `releasePeerForHandoff`) and gives it, with
  the redeemed grant, to the brain's router (`laneShareGuestRouter.ts`, set
  on the shared listener). The router picks the project with that repository
  key (two checkouts of one repository: the one that has the lane), and that
  project's host runs the checks after the redeem
  (`acceptHandedOffLaneShareGuest`).
- With no project served, the brain's own ingress hands the guest, not
  redeemed, to any open project, which redeems it and routes it on.
- A project that is not the served one serves its guests from a guests-only
  host (`laneShareGuestsOnly` in `syncHostService.ts`): no listener of its
  own, no discovery, no Tailscale route, no changeset pump, no brain status.
  It starts with the first guest and stops after two idle minute checks. When
  the project becomes the served one, it closes and its guests reconnect to
  the served host. A share's revoke, pause, rights edit and move reach
  whichever of the two serves the project (`laneShareServingHost`).
- `lane_share_unavailable` now means no project of the machine could take the
  guest (a project the brain refuses to open, a missing checkout).

While a guest is connected, the host reads its grant list again on a timer
(`LANE_SHARE_GRANT_REFRESH_MS`). A grant that is not in the list gives no
access, so a revoke counts at the next read. With no guest connected, no
timer and no request run. At most 3 devices of one guest connect to one
grant at the same time.

### What the host lets through

`laneShareGuestPolicy.ts` is default refuse:

- **Inbound envelopes** (`LANE_SHARE_GUEST_INBOUND`): heartbeat, command,
  chat and terminal subscribe/unsubscribe/history, `chat_tool_result`,
  `terminal_input` (a CLI session with the typing right only, never a shell)
  and `file_request` (reads in the granted lane with the file switch on).
  Changesets, project and roster requests, terminal resize, file writes,
  pairing and the runtime RPC channel are refused.
- **Commands** (`LANE_SHARE_GUEST_COMMANDS`): a fixed list of `work.*`,
  `chat.*`, `git.*` and `prs.getForLane` commands. Each rule names its scope
  (the granted lane, or a session the host resolves to that lane from its
  own database), the only arguments the call keeps, and the right it needs.
  A lane id the client sends next to a session id is never trusted.
  A chat that another chat spawned (a subagent or a peer, from the host's
  row or the chat's own record) needs `subagentChats` as well as `chats`:
  in a list, a read, a subscribe, a command and a live event.
  `laneShare.getGuestState` and `laneShare.move` are answered by the host
  itself (`LANE_SHARE_GUEST_HOST_COMMANDS`).
  The chat pane's reads have their own limits:
  - `chat.getImageDataUrl` reads only an image in the granted lane's
    worktree (not ignored, not under `.ade/` or `.git`), or an ignored
    worktree file or a staged `.ade/attachments` file that this chat's
    events after the history cut name.
  - `chat.getTurnFileDiff` needs `tools.diff`, and the shas and file must
    match a `turn_diff_summary` event of the chat. It reads in the lane's
    worktree.
  - `chat.listPendingInputs` and `chat.getSessionCapabilities` (trimmed to
    the runtime switches) need only a visible session.
  - A chat's `session_meta_updated` and `status` events also send the
    debounced `lane_share_guest_changed`.
- **Outbound envelopes**: replies to the guest's own requests, session
  payloads of the granted lane and kinds the rights see, and
  `lane_share_guest_changed` (only the grant id; the guest reads its state
  again). Brain status, the project catalog, changesets, the roster, launch
  events and screen streams never go to a guest.
- **Rate limit**: 200 envelopes per 10 seconds per connection.

`laneShareGuestCommandPrep.ts` runs the checks that need the host's
services: the model, reasoning and mode locks against the chat as it is now
(a new chat or CLI session starts with each value the guest named, else the
first value the owner allowed, never a host or CLI default; an empty mode
lock starts in `default`),
the message limits (counted before the turn), ownership of the draft,
comment or queued message a command names, and the right for the card a
guest answers. It sets the verified author. `laneShareGuestQueue.ts` checks
a guest's queued message again when it starts.

`laneShareGuestScrub.ts` removes from each payload, before a guest gets it:
the text of cards only the owner may answer (a guest sees "Waiting for the
owner"), model and machine names the privacy switches hide, history from
before the share, and ADE's own files. The history cut checks each item of a
list that a fresh event or a summary carries by the item's own time (the
comment list in `session_meta_updated`, a summary's scheduled work); an item
with no time of its own loses its text (restored queued messages, the prompt
of a scheduled work update). File and diff reads carry
`refuseIgnored` (no ignored file, nothing under `.ade/`, also through a
link), and git reads carry `onlyLaneHistory`.

`laneShareGuestHost.ts` holds the guest peers, their roles and the grant
refresh. `laneShareGuestGates.ts` applies the policy to each envelope.

### The guest's client

- `laneShareGuestConnection.ts` is its own class. It never registers as a
  sync client, never touches a project database and drops any inbound
  envelope type it does not know. Every session envelope must name a session
  of the granted lane that this connection listed.
- `laneShareGuestStore.ts` holds the received list (one directory read,
  cached 5 minutes) and one connection per opened shared lane.
- **Work sidebar shelf** (`LaneShareGuestShelf.tsx`): a "Shared with me"
  group, apart from the project's own lanes. Each shared lane is a tree of
  its sessions (`LaneShareGuestLaneTree`, also used by the `/shared` page).
  It renders only with an accepted share, and opens no connection until the
  user expands or opens a shared lane.
- **Shared lanes page** (`LaneShareGuestPage.tsx`, route `/shared`, no
  project needed; also in the web client): a sidebar with Back, the open
  invites and the shared lanes. `?grant=<id>` is where an invite link lands:
  - signed out: sign in;
  - not this account's grant: say so, with Switch account;
  - the owner's own link: the owner's lane opens in the Work tab with a
    note (Settings › Sharing when this tab does not hold the lane);
  - pending: the lane opens with one Accept strip ("Accept and open");
  - active: the lane opens on its newest chat (`view=lane` shows the
    lane's own page, to start a chat).
  With nothing picked, the first shared lane or invite opens.
- **Shared lane view** (`LaneShareGuestView.tsx`): the header (lane,
  owner, end date, messages left), the open chat or read-only terminal, and
  Clone this project.
- **Shared chat** (`LaneShareGuestChatPane.tsx`): ADE's real chat pane
  (`AgentChatPane`) with a `lane_share_guest` chat scope. Its API
  (`laneShareGuestAgentChatApi.ts`) sends every call through the guest
  connection; history is the connection's chat subscription. The bound
  scope hides project-only parts (files, PRs, other lanes). Controls the
  rights lock show disabled: the mode with its reason as the tooltip, the
  reasoning level, the models (only the allowed ones), and Send with the
  reason (watch only, paused, no messages left, not connected). Without the
  send right but with drafts, a message becomes a draft for the owner.
- **Home** (`LaneShareHomeRows.tsx`): "Shared with you" in the Projects
  card lists invites and shared lanes; each opens the lane. A web account
  with no computer and no project sees "Shared lanes need no computer".
- The "Access changed" notice shows only when the rights or the lane state
  differ after the host let the guest back in.

Invite links are `https://ade-app.dev/open?type=lane-share&id=<grant>` and
`ade://lane-share/<grant>` (`shared/deeplinks.ts`). The grant id
(`ls_` and 32 hex characters) is an address only.

## Message author

`apps/desktop/src/shared/messageAuthor.ts` sets the author of a person-side
message, draft or thread comment. The type is `AdeMessageAuthor`
(`{ kind: "host" | "guest", userId, name }`, `shared/types/chat.ts`). It
rides as `metadata.author` on a `user_message` event, `DraftEntry.author`
(column `prompt_stashes.author_json`) and `ChatThreadComment.author`.

- The host removes any author a caller sends, then stamps its own from what
  it verified. The guest's name comes from the directory
  (`receiverName`), never from the guest.
- An absent author reads as the host's own user. Every row written before
  lane sharing reads that way.
- A guest's text is a plain prompt: no slash command, no `!` line, no custom
  command or skill, and no `@chat:`-style expansion. The host refuses a
  guest message that starts with `/` or `!` (`lane_share_plain_text_only`).
- A guest's thread comment goes with a send only when the owner names it in
  `includeGuestComments`, with the body `revision` the owner saw. The host
  adds one to `revision` on each body edit. A comment that a guest edited
  after the owner picked it stays out of that send, and the edit unticks it.
  `formatThreadReviewBlock` marks it as written by another person and breaks
  its `@word:` chips.
- The host adds a note to the text the agent gets (not the text the chat
  shows) for a guest's message. The note names the guest by its directory
  name and asks for a `Co-authored-by` trailer on any commit of that turn
  (`laneShareCoAuthorNote`). With no trusted name, the host adds no note.

## Moving a chat to the other person

The owner, or a guest with Collaborate, can move a chat of the shared lane,
with its unpushed work, to a computer of the other person. The trust rules
are in `apps/desktop/src/shared/laneShareMove.ts` and the directory README,
"Moving a chat to the other person". The directory carries none of the move.

- `laneShareMoveService.ts` (one per project runtime) plays four parts: the
  host as source (`to_guest`), the host as destination (`to_owner`), and the
  guest's own machine as receiver or packer (`moveReceive*`, `movePack*`).
- The consent lives on the machine of the person who receives the work. It
  refuses by default, ends after 15 minutes, works once, and ends with a
  revoke, a leave, the end of the share or a pause. One move at a time per
  share.
- The payload is a fixed list of fields (`parseLaneShareMovePayload`); the
  receiver refuses any other field. No sign-in, token, credential, provider
  session or secret moves.
- The bundle goes in 384 KiB chunks over the guest connection
  (`laneShare.move`), at most 50 MiB, SHA-256 checked at the end
  (`laneShareMoveTransfer.ts`, a temp folder on each side).
- `laneShareMoveChat.ts` lands the work in a NEW lane on a new branch with
  git hooks off, and makes a chat there on a model this machine signed in
  to, in plan mode. The new lane is shared back to the other person by the
  receiving machine's own account. The source chat gets a
  `lane_share_moved` notice (`AgentChatNoticeDetail.laneShareMoveId`).
- UI: `LaneShareOwnerMove.tsx` in the owner's chat, `LaneShareGuestMove.tsx`
  on the guest's side. `laneShareMoveRunner.ts` carries the payload and
  chunks between the guest connection and the guest's own machine (by that
  machine's pin). The guest client never writes a file.

## Analytics

Each successful owner mutation records one `ade_feature_used` with
`feature: "lanes"` (`lanes.share`, `lanes.shareEditRights`,
`lanes.shareRevoke`, `lanes.shareLeave`, `lanes.shareMoveChat`,
`lanes.shareMoveRespond`). See [logging](../../logging.md).

## Platform notes

- The host refuses guest typing into a CLI session when it runs Windows,
  where a shell stays after the CLI exits.
- Move temp folders use `os.tmpdir()` and `rmSync` with retries for Windows
  handles.
- Phone guests are out of scope. The iOS app decodes the new optional fields
  (`author`, the guest hello kind) without a change; see
  [iOS companion](../sync-and-multi-device/ios-companion.md).

CLI typing (`run.typeInCliSessions`) is a capability of the machine that
holds the lane, not of the viewer. On Windows, ADE starts a CLI inside a
shell without exec, so the shell stays when the CLI exits and the host
cannot tell which program reads the keys. macOS and Linux keep the
capability. The host computes `cliTyping` (`laneShareCliTypingFor`) and
sends it in the `lane_share.list` result and in `laneShare.getGuestState`.
A Windows host stores the right as off on create and edit, and lists a
stored right as off. The owner's switch is off and inert there, with the
reason, and the risk does not count it. The guest gets no typing box and no
first-line field, only the line "Typing into a CLI is not available on this
computer of <owner>.", which names neither the OS nor the machine. The host
still refuses each typed line and each first line with
`lane_share_cli_typing_unavailable`.

## Source file map

| File | Responsibility |
|------|----------------|
| `apps/account-directory/src/laneShares/{routes,contract,invites,tickets,shareRows,clerkAccount}.ts` | Directory routes, shapes, invites and email limits, one-use tickets, grant rows, Clerk verified-address reads. |
| `apps/desktop/src/shared/laneShareRights.ts` | Rights type, parser, presets, risk, the agent ceiling, display name, daily window, guest state. |
| `apps/desktop/src/shared/types/laneShare.ts` | Owner and guest contract shapes, `LaneShareEvent`. |
| `apps/desktop/src/shared/laneShareDirectory.ts`, `laneShareGuestDirectory.ts` | Directory id and ticket shapes, error mapping, the guest's account calls. |
| `apps/desktop/src/shared/laneShareMove.ts` | Move trust rules, payload parser, consents. |
| `apps/desktop/src/shared/messageAuthor.ts` | Host-stamped author of messages, drafts and comments. |
| `apps/ade-cli/src/services/sync/laneShareHostService.ts` | The `lane_share` owner actions on the host. |
| `apps/ade-cli/src/services/sync/laneShareGrantService.ts` | The host's grant list and ticket redemption. Fail closed. |
| `apps/ade-cli/src/services/sync/laneShareGuestHost.ts`, `laneShareGuestGates.ts`, `laneShareGuestTypes.ts` | Guest peers, roles and per-envelope gates. |
| `apps/ade-cli/src/services/sync/laneShareGuestHello.ts` | The guest hello: refusals, the ticket redeem, the hand-off to the lane's project, and admission. |
| `apps/ade-cli/src/services/sync/laneShareGuestRouter.ts` | Picks the project host for a handed-off guest (registry origin, then live origin; open projects only for an unredeemed socket). |
| `apps/ade-cli/src/services/sync/laneShareGuestPolicy.ts` | Default-refuse lists of envelopes and commands, locks, file reads, rate limit. |
| `apps/ade-cli/src/services/sync/laneShareGuestCommandPrep.ts` | Checks that need host services; sets the author. |
| `apps/ade-cli/src/services/sync/laneShareGuestScrub.ts` | What the host removes from a guest's payload. |
| `apps/ade-cli/src/services/sync/laneShareGuestQueue.ts` | Re-checks of a guest's queued messages. |
| `apps/ade-cli/src/services/sync/laneShareMoveService.ts`, `laneShareError.ts` | The move service and the coded service error. |
| `apps/desktop/src/main/services/lanes/laneShareRightsStore.ts` | The host's local rights and counters. |
| `apps/desktop/src/main/services/chat/laneShareMoveChat.ts`, `laneShareMoveTransfer.ts` | Landing a moved chat; the bundle bytes. |
| `apps/desktop/src/main/services/account/accountBridge.ts` | `laneShareGuest()` directory calls with this machine's token. |
| `apps/desktop/src/renderer/components/laneShare/*.tsx`, `*.ts` | Owner UI, share list store, actions, defaults. |
| `apps/desktop/src/renderer/components/laneShare/guest/**` | Guest connection, store, shelf, page, view, chat pane and its API, home rows, move. |
| `apps/desktop/src/renderer/webclient/sync/relayReady.ts` | Relay ready handshake for browser-side sockets. |

# Lane sharing: guests use ADE's real screens (open work)

Lane sharing works today (see
[docs/features/lanes/lane-sharing.md](../features/lanes/lane-sharing.md)). A
guest still uses the "Shared with me" shelf and the `/shared` page. This plan
holds only the open work: guests get the real Work tab, chat and terminal.

## Not built yet
- The guest pin (`transport: "lane_share_guest"`) and guest rows inside
  `useWorkSessions`: the shared lane stays in the "Shared with me" shelf, and
  the chat uses the guest chat scope instead of a pin.
- A project tab served by the owner's computer: `/shared` is the guest's
  page, with Back and Clone this project.
- Thread comments in the real pane for a guest (the bound scope hides them).
- Attachments on send (needs a new right).

## Owner decisions for the open work
- No separate guest UI. A shared lane uses the real Work tab, chat, prompt box,
  transcript (tool steps, diffs, images) and terminal view.
- Guest has the project (same repository): the shared lane shows in their own
  project tab's Work tab, like a lane on another computer.
- Guest does not have it: ADE opens a project tab for it, served by the
  owner's computer, with "Clone this project".
- Controls a guest cannot use show disabled, with a reason. Parts they cannot
  use (Files, PRs, other lanes) are hidden.

## Architecture
- One enforcement point: the existing guest gates on the owner's computer
  (`laneShareGuestPolicy.ts`, `laneShareGuestGates.ts`). No guest scope on the
  paired runtime RPC channel (desktop only, whole action registry).
- Guest pin: `{kind:"remote", transport:"lane_share_guest",
  targetId:"lane-share:<grantId>", projectId:"lane-share:<grantId>",
  rootPath:"", runtimeName:<giver>, gitOriginUrl}` plus
  `isLaneShareGuestPin()`. Not a third `kind`: `kind`-branches would fall to
  local. Explicit refusals in preload `callPinnedRuntimeAction` and pumps,
  main `targetForAction` (skip `reachGoneTarget`), web `federated.ts`
  `callDynamic`.
- Transport: the renderer `LaneShareGuestConnection` (desktop and web), one
  per grant, in `laneShareGuestStore`. Not `AdeSyncClient` (project catalog
  restore, projectId stamping).
- Chat: `ChatPaneScope {kind:"lane_share_guest"}` with
  `createLaneShareGuestAgentChatApi(connection, guestState)`, modelled on
  `personalAgentChatApi.ts`. Generalise the pane's `personalScope` checks to
  "scope hides X"; disabled reasons from `LaneShareGuestState.rights`.
- Work rows: `useLaneShareGuestSlices(repoKey)` appended to
  `useRetainedCrossMachineSlices()` in `useWorkSessions.ts` (not the union
  store: `applyReachability` prunes it). `pinForSession` then gives guest
  rows the guest pin.
- Tab match: grant `repoKey` = `accountRepoScopeKey(origin)` =
  `RepositoryTab.repoKeys`.
- Shared-project tab: web via `WebWorkspaceState.openBindings`; desktop as a
  tab with no window binding that shows only Work (to verify in the tab strip).

## Host additions
- `chat.getImageDataUrl` scoped to images named in the session's events or in
  the lane worktree (today the command reads any project path).
- `chat.listPendingInputs`, `chat.getTurnFileDiff` (with `tools.diff`),
  maybe `chat.getSessionCapabilities`.
- A session-list refresh on `lane_share_guest_changed`.
- Later, with a new right: attachments on send.

## Risks
- Guest pins misrouted by `kind === "remote"` branches that do more than RPC
  (machine names, attachment images, PTY pumps): audit by grep.
- Calls in `AgentChatPane` that bypass `agentChatApiRef` (`sessions.*`,
  `prs.*`, `lanes.*`): they fail closed against the unknown target; hide them.
- Trimmed summary fields the pane may assume.
- 3 devices per grant and 200 envelopes per 10 s: the real pane reads more.

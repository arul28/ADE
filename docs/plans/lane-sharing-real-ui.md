# Lane sharing: guests use DAEX's real screens (open work)

Lane sharing works today (see
[docs/features/lanes/lane-sharing.md](../features/lanes/lane-sharing.md)).
A guest's chat already runs in the real `AgentChatPane`
(`laneShare/guest/LaneShareGuestChatPane.tsx`, scope
`{ kind: "lane_share_guest" }`, through `laneShareGuestAgentChatApi.ts` and
one `LaneShareGuestConnection` per grant in `laneShareGuestStore`). The host
side (`chat.getImageDataUrl` scoped to the lane, `chat.listPendingInputs`,
`chat.getTurnFileDiff`, the `lane_share_guest_changed` refresh) is built in
`apps/ade-cli/src/services/sync/laneShareGuest*.ts`.

What is left: the shared lane shows in the guest's real Work tab and project
tab instead of the "Shared with me" shelf and the `/shared` page.

## Not built yet

- **The guest pin** (`transport: "lane_share_guest"`) and `isLaneShareGuestPin()`.
- **Guest rows in the Work tab:** a `useLaneShareGuestSlices(repoKey)` appended
  to `useRetainedCrossMachineSlices()` in `useWorkSessions.ts` (not the union
  store: `applyReachability` prunes it), so `pinForSession` gives guest rows
  the guest pin.
- **A project tab served by the owner's computer** for a guest who does not
  have the project, with "Clone this project". Today `/shared` is the guest's
  page, with Back and Clone this project.
- Thread comments in the real pane for a guest (the bound scope hides them).
- Attachments on send (needs a new right).

## Owner decisions

- No separate guest UI. A shared lane uses the real Work tab, chat, prompt
  box, transcript and terminal view.
- Guest has the project (same repository): the shared lane shows in their own
  project tab's Work tab, like a lane on another computer. Tab match: grant
  `repoKey` = `accountRepoScopeKey(origin)` = `RepositoryTab.repoKeys`.
- Guest does not have it: DAEX opens a project tab for it, served by the
  owner's computer (web via `WebWorkspaceState.openBindings`; desktop as a tab
  with no window binding that shows only Work).
- Controls a guest cannot use show disabled, with a reason. Parts they cannot
  use (Files, PRs, other lanes) are hidden.

## Architecture

- One enforcement point: the guest gates on the owner's computer
  (`laneShareGuestPolicy.ts`, `laneShareGuestGates.ts`). No guest scope on the
  paired runtime RPC channel.
- Guest pin shape: `{kind:"remote", transport:"lane_share_guest",
  targetId:"lane-share:<grantId>", projectId:"lane-share:<grantId>",
  rootPath:"", runtimeName:<giver>, gitOriginUrl}`. Not a third `kind`:
  `kind` branches would fall to local. Add explicit refusals in preload
  `callPinnedRuntimeAction` and the pumps, main `targetForAction` (skip
  `reachGoneTarget`), and the web client's `federated.ts` `callDynamic`.

## Risks

- Guest pins misrouted by `kind === "remote"` branches that do more than RPC
  (machine names, attachment images, PTY pumps): audit by grep.
- Calls in `AgentChatPane` that bypass `agentChatApiRef` (`sessions.*`,
  `prs.*`, `lanes.*`) fail closed against the unknown target; hide them.
- 3 devices per grant and 200 envelopes per 10 s: the real pane reads more.

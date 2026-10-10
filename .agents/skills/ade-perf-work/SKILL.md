---
name: ade-perf-work
description: Performance and UX patterns discovered for ADE's Work tab, including chat/CLI/shell launch surfaces, the Work tools pane, Git/Files/iOS/App Control/Browser panels, and local-runtime-disabled perf runs. Read before editing Work tab code.
metadata:
  author: ADE
  version: 0.1.0
---

# ade-perf-work

Read this before editing Work tab surfaces:

- `apps/desktop/src/renderer/components/terminals/**`
- `apps/desktop/src/renderer/components/chat/**` when mounted from Work
- `apps/desktop/src/renderer/components/lanes/LaneGitActionsPane.tsx`
- `apps/desktop/src/renderer/components/lanes/CommitTimeline.tsx`
- `apps/desktop/src/renderer/components/files/FilesPage.tsx` when embedded
- `apps/desktop/src/preload/preload.ts`
- `apps/desktop/src/main/services/ipc/registerIpc.ts`
- Work-facing tool services for iOS Simulator, App Control, and built-in browser

## Measurement pattern

Use the real Work tab first. For local perf runs, reset and open the perf-pass repo:

```bash
scripts/reset-perf-pass.sh
NO_DEVTOOLS=1 ADE_DISABLE_LOCAL_RUNTIME_DAEMON=1 ADE_LOCAL_RUNTIME_FALLBACK=1 ADE_MODEL_OVERRIDE=gpt-5-codex \
  node scripts/perf-launch.mjs --tab work --run-id work-ui-audit-<date>-<n>
```

Keep the Work audit matrix at `docs/perf/work-tab-action-inventory.md` current.
Rows start as source inventory. Promote them only when a real UI run, UI-derived
probe, or focused fixture test covers that exact control/state. Do not describe a
run as complete while rows are still `source`, `fixture-needed`,
`sandbox-only`, `prompt-only`, or `external-skip` without evidence or an explicit
reason.

Use the matrix as the Work pass queue. Enumerate the visible Work actions and
states, then handle rows one by one: drive the real control, record markers,
promote or classify the row, fix at most one discovered bottleneck/bug, re-drive
the same row to prove the change, and only then advance. Backend/source review is
supporting evidence; it does not replace trying the UI action.

Drive actual Work UI actions and record `work.audit.*` markers for:

- session search/filter, tab/grid, Chat/CLI/Shell mode switches
- model picker, attachment picker, slash command picker, parallel model configuration
- Work tools pane open/close
- Git: status, More menu, history refresh, diff selection
- Files: mount and path filtering
- iOS Sim, App Control, and Browser panel mounts

Do not start from a fixed deterministic scenario list. Scenario files are only
optional evidence after the Work UI inventory exposes a real workflow. The
important proof is a UI-derived run over
`~/.ade/perf-runs/<runId>/events.jsonl` plus focused tests for any fixed
behavior.

## Current known wins

### Skip classic GitHub repo probes during shell status

`githubService.getStatus()` must still validate the token and keep the
fine-grained-token repo access probe. For classic tokens, required scopes are
inspectable from `/user`, so do not also probe the active repo on the Work
startup status path.

Measured Work runs:

- Before: `ade.github.getStatus` `644ms` during Work startup.
- After: post-fix samples were `473ms` and `192ms` in the hot-reload run, and
  `524ms` in a clean Work launch.

Keep `repoAccessOk` / `repoAccessError` as `null` for classic-token statuses.
Do not remove the fine-grained-token repo probe; it prevents a false connected
state when a fine-grained token cannot read the active repo.

### Keep GitHub auth status out of the first Work startup window

The top-bar Publish pill only needs local origin state. It must call the
lightweight `github.getRemoteStatus` path, not full `github.getStatus`, so Work
startup does not validate GitHub auth just to decide whether to show Publish.

The AppShell GitHub banner/avatar refresh may still call full `github.getStatus`,
but keep it post-startup. Settings save/clear broadcasts still update the shell
immediately through `onStatusChanged`.

Measured Work runs:

- Before shell auth delay: first `10s` IPC total `901ms`, with
  `ade.github.getStatus` at `293ms` in the startup window.
- After: first `10s` IPC total `633ms`; `ade.github.getStatus` was absent from
  the first startup summary. The auth check still ran later at `301ms`.
- `ade.github.getRemoteStatus` stayed `0ms` in the startup path.

### Bound local usage cost-log scans

The usage tracker starts in Work perf launches after the startup delay and scans
local Claude/Codex JSONL logs for cost estimates. Do not read every recent log
file into memory. Scan only bounded recent files, skip oversized files, stream
line-by-line, and cap retained token entries.

Measured Work runs:

- Before: clean Work launch crashed with V8 heap OOM; main-process heap reached
  `1,867.7MB` around the `usage.start` window.
- After: clean Work launch stayed alive past the same window with main-process
  heap max `130.9MB` and CPU p95 `0.18%`.

If changing usage/cost telemetry, test with a large local `~/.codex` /
`~/.claude` history and re-run a Work perf launch for at least 45 seconds.

### Skip the local runtime bridge when the local daemon is disabled

In Work perf runs with `ADE_DISABLE_LOCAL_RUNTIME_DAEMON=1`, the preload bridge must not try `ade.localRuntime.callAction`, `ade.localRuntime.callSync`, or `ade.localRuntime.streamEvents` for local project bindings.

Measured Work cold run:

- Before: `67` failed `ade.localRuntime.*` IPC calls, `19,427ms` aggregate failed IPC time.
- After: `0` failed `ade.localRuntime.*` IPC calls.

Keep the preload guard in `apps/desktop/src/preload/preload.ts` intact. If changing project binding or remote runtime event pump logic, re-run a local-runtime-disabled Work audit and confirm local runtime IPC remains zero.

### Fast-path sync status when the local runtime daemon is disabled

`ade.sync.getStatus` is called during Work startup and periodically from shell chrome. In local-runtime-disabled runs it must not spawn the disabled runtime or fail before falling back.

Measured Work run:

- Before sync fix: `ade.sync.getStatus` failed and consumed `606ms` across two calls in the startup window.
- After: the same status path returned successfully in `0-1ms`.

Keep the unavailable sync snapshot in `apps/desktop/src/main/services/ipc/registerIpc.ts`. It is a perf-mode/status fallback, not a replacement for real sync service behavior.

### A web transport connect must not launch domain work

The hosted web client's socket `connected` transition is a transport fact, not
permission to refresh every product domain. Keep the adapter connect listener
limited to sync status. Do not add `github.getStatus` there: headless GitHub
discovery may touch git, `gh`, credential files, macOS Keychain, and the
network. Domain surfaces should request their own cached status when visible.

Brain-facing transcript and credential reads must use asynchronous filesystem,
zlib, and child-process APIs with hard bounds/timeouts. Coalesce same-key
in-flight work. Do not promise-read and then repeatedly inflate a large gzip
archive: globally admit streaming inflations, memory-cache only small archives,
and materialize a larger archive at most once into an unlinked, process-private
temporary file under a hard logical-size/LRU/free-space budget. Admit only one
inflate at a time and retain only the newest queued destination. Thread request
cancellation through admission, file reads, and the inflater. Put a hydration
barrier around `chat_subscribe`: capture the logical byte offset before the
snapshot, do not broadcast/pump that session before its ack, then replay from
the captured offset. For web chat, keep the initial
tail small, cap older pages at 256 KiB, preserve the cursor on transient
failures, automatically backfill an underfilled viewport, and keep a visible
manual Retry path. Use append-stable logical byte cursors for transcript paging
and advertise `cursorKind` when a legacy consumer could otherwise interpret the
number as a dense entry index. The chat list owns prepend/bottom anchoring, so keep
`overflow-anchor: none` on its scroll pane.

### Work tools pane must remain operable when narrow

The Work tools pane can be narrow after the session list, chat surface, and tools pane are all visible. Do not assume all tab labels fit. The tab strip should collapse to icon buttons under narrow widths while preserving `aria-label`, tooltips, and stable hit targets.

Measured UI pass after compact tabs:

- Git, Files, iOS Sim, App Control, and Browser tabs were all visible and clickable in the narrow tools pane.
- No tools tab had a bounding rect beyond the renderer viewport.

If changing `WorkSidebar`, verify with a small Work pane and a larger audit window. The target is no clipped or unreachable tool tabs, not merely no TypeScript errors.

### Session list filters must wrap in narrow panes

The sessions pane can be squeezed when Work, the sessions list, and the tools pane are all visible. Status/group filter pills must wrap inside the filter panel instead of assuming a single row, and embedded lane selectors must be able to fill a narrow parent without overflowing it.

Measured Work run `work-inventory-shell-session-20260512-01`:

- Before: a `120.2px` filter panel had status/group controls extending `122.8px` past the panel edge.
- After: the rightmost control ended `8.0px` inside the same narrow panel.

When editing `SessionListPane` filter controls or `LaneCombobox` trigger sizing, verify a small Work viewport with the filter panel open and record the panel/control bounds in the action inventory.

### Context menus must clamp to the renderer viewport

Session and Work-tab context menus are fixed-position menus created from the event `clientX/clientY`. Do not place them directly at the click point without measuring the rendered menu size and clamping to the viewport.

Measured Work run `work-context-menu-edge-20260512-01`:

- Before: a Work-tab context menu opened at `left=534.0px` in a `582px` viewport and overflowed right by `132.0px`.
- After: the same probe placed the `180px` menu at `left=394.0px`, ending `8.0px` inside the viewport.

When changing `SessionContextMenu`, verify with a small Work viewport and a context menu opened near the right edge. Keep the inset stable so users can still reach every menu item.

Files context menus have the same requirement. The Files tree context menu is
rendered by `FilesPage.tsx`; measure its actual rendered width/height and clamp
both axes to the viewport.

Measured Work run `work-chat-other-controls-20260512-01`:

- Before: right-clicking the `README.md` row near the viewport edge opened the
  menu at `x=1163.0px` with `width=200px` in a `1164px` viewport, overflowing
  right by `199px` and bottom by `159.1px`.
- After: the same probe placed it at `x=956.0px`, `right=1156.0px`,
  `bottom=737.0px` in the `1164x745` viewport.

When changing Files context-menu contents or row context-menu handling, verify
with a right-click near the renderer's right/bottom edges.

Embedded Files has a narrower parent than the full Files route. Keep the Work
tools pane layout responsive: the explorer/editor split should stack when
`FilesPage` is embedded rather than preserving a fixed `320px` explorer column
that pushes editor controls offscreen.

Measured Work run `work-chat-other-controls-20260512-01`:

- Before: the embedded explorer ended at `right=1170.8px` in a `1164px`
  viewport, the editor collapsed to `1.8px`, and the `CODE` button overflowed
  right by `92.2px`.
- After: explorer and editor both fit inside the tools pane at `right=1151.6px`;
  the `CODE` button ended at `right=953.8px` with no overflow.

### Chat controls depend on provider/model state

The Work Chat composer changes its visible controls after provider/model
selection. Do not mark a control missing until the matching provider state is
set through the real model picker.

Measured Work run `work-chat-controls-20260512-02`:

- `Fast mode` appeared only after selecting a Codex model with a fast service
  tier (`GPT-5.4` in the measured run). The valid marker toggled
  `aria-pressed` from `false` to `true`.
- The Codex approval preset menu exposed `Default permissions`, `Plan mode`,
  `Full access`, and `Custom (config.toml)` after a Codex model was selected.
- Parallel setup starts with two visible model slots; `Add model` should
  increase the visible slot count, `Configure` should become `Editing`, and the
  uppercase `FOCUSED` / `PARALLEL` execution controls should be checked with a
  viewport-aware probe before promotion.
- In a fresh empty perf-pass chat, the slash command menu may expose only
  `/clear Clear chat history`. Do not promote `work.chat.command.select` from
  that state; use a fixture or real session state with a non-clear command.
- Handoff controls are not an empty-draft surface. They appear only for standard
  locked Work chats. Use focused `AgentChatPane.submit.test.tsx -t "handoff"`
  evidence for open/permission/launch logic unless you intentionally create a
  real throwaway chat in perf-pass.
- The proof/artifacts drawer is also not exposed on the empty draft surface in
  Work. Use a selected standard chat/session or a focused companion-toolbar
  fixture before measuring proof drawer open/close or right-pane resize.
- In the Work tab embedding, `AgentChatPane` is rendered with
  `hideLaneToolDrawers` from `WorkViewArea` / `WorkStartSurface`, so the
  chat-toolbar iOS and App Control drawer buttons are intentionally absent.
  Verify Work coverage through the WorkSidebar tabs and panels; keep exact
  drawer-button rows as fixture-needed/non-Work `AgentChatPane` fixture
  evidence if they remain in the inventory.
- Cursor permission/mode controls and Cursor Cloud actions only appear after a
  Cursor-backed model is selected through the real model picker. In the measured
  run, selecting a Cursor SDK model exposed a native mode select with `Agent`,
  `Ask`, `Plan`, and `Full auto`; the `Cursor Cloud actions` menu exposed
  `Send to Cursor Cloud` and `Open existing cloud chat` without launching a
  cloud session. `CursorCloudInlineLaunch.test.tsx` covers canceling an inline
  Cursor Cloud send without creating a run.
- `work.chat.composer.clear` is not an empty-draft affordance in the current
  Work composer. The visible `Clear` button is gated by `turnActive` alongside
  steer/stop controls, so measure it with an active-turn fixture or sandbox chat
  session rather than by typing into the fresh draft surface.
- The Browser tools panel can be measured from the empty Work surface for tab
  creation, tab switching/closing, URL typing, and inspect toggling. Browser
  screenshot crop is different: in the empty tools panel it is disabled with
  `Chat context is unavailable here`, so measure screenshot start/cancel from a
  selected chat/context-capable surface.
- Chat attachment search uses the composer lane, not the Files tools workspace.
  In perf-pass, switch the composer lane to `Primary` before searching for
  `README.md`; a missing lane worktree legitimately returns no file results.
  For React-controlled picker inputs, prefer focused CDP text input over simply
  assigning `input.value`, because DOM-only value changes can leave the picker
  state at `Type to search files...`. Text-file chips cover select/remove only;
  `open-preview` and `copy-image` need an image attachment fixture.
- `ChatAttachmentTray.test.tsx` is valid focused fixture evidence for image
  attachment preview/copy behavior: it mocks `getImageDataUrl`, verifies the
  image lightbox opens, and verifies `writeClipboardImage` is called from the
  copy control.
- `AgentChatMessageList.test.tsx` has valid focused fixture evidence for
  transcript message copy, cloud PR browser navigation, file-link routing,
  transcript code-block copy, tool-call disclosure expansion, full-prompt
  toggles, memory/thought disclosure toggles, manual transcript scroll,
  jump-to-latest, user-message minimap jump, and inline question tab/prev-next
  controls. Keep assistant markdown code blocks routed through
  `HighlightedCode`; that component owns the `Copy code` control and copy-button
  placement preference. Match the inventory row to the exact clicked control; do
  not use the localhost URL test as PR-browser evidence. Grouped tool results
  render through `ChatWorkLogBlock`, not the old standalone `ToolResultCard`;
  keep long-result `show all` / `collapse` behavior on that reachable
  `ChatWorkLogBlock` row path.
- `AgentChatPane.submit.test.tsx` has valid focused fixture evidence for
  selecting chat tabs in the Work chat pane. Its CLI-created terminal tests only
  auto-reveal terminal tabs; use `ChatTerminalDrawer.test.tsx` for terminal
  drawer toggle, resize, and manual tab-switch evidence.
- `AgentChatPane.companionDrawers.test.tsx` covers chat companion iOS, App
  Control, proof drawer open/close, right-pane split resize, archived-chat
  restore, and persistent identity `Clear view` through the real
  `AgentChatPane` chrome. This is non-Work fixture evidence for the lane tool
  drawers: normal Work embedding passes `hideLaneToolDrawers`, so iOS/App
  Control drawer buttons are intentionally absent there.
- `ChatSubagentsPanel.test.tsx` can cover the subagents drawer toggle, detail
  view, Back navigation, hidden timeline expansion, and copy-id behavior without
  spawning real subagents.
- `AgentChatComposer.test.tsx` can cover the active-turn `Clear` composer
  control, queued steer edit/remove callbacks, prompt-suggestion Tab
  acceptance, rich visual-context chip select/remove, slash-command selection,
  and dismissing an attachment error. `FilesPage.test.tsx` can cover the
  non-embedded Files editor theme toggle, primary-workspace `TRUST & EDIT`
  toggle, and Files tree context-menu `COPY PATH`. Embedded Work Files does not
  render those non-embedded chrome controls, so keep live embedded fail markers
  separate from focused Files chrome coverage.
- `SessionListPane.test.tsx` can cover the stale running-session warning, child
  shell section collapse/expand, and bulk restore footer wiring.
  `PackedSessionGrid.test.tsx` covers persisted tile resize, while
  `WorkViewArea.test.tsx` covers selecting a tiled grid session by clicking its
  body, closing an ended tab from the tab strip, and embedded floating-pane
  minimize/expand through the actual `FloatingPane` chrome context.
- `WorkStartSurface.test.tsx` can cover the `lanes=[]` no-lanes empty state
  without mutating the perf-pass lane database.
- Browser back/forward/reload can use a localhost two-page fixture. For
  `Stop loading`, do not count a URL-open click while the toolbar is still
  `busy`; that leaves the real Stop button disabled. Use direct browser API
  navigation only as setup for a slow localhost page, wait for the visible Stop
  button to become enabled, then click the real button and verify loading
  returns to false. If `captureScreenshot` times out before crop mode appears,
  record it as invalid screenshot evidence and keep screenshot start/cancel
  fixture-needed.
- Browser selected-context rows can use direct `setBounds`/`selectPoint` only to
  seed a localhost selected element; measure the real UI controls afterward.
  The composer may be a `textarea[aria-label="Type to vibecode"]` rather than a
  rich contenteditable after cleanup, so verify `Insert draft` against the
  actual textarea value. Auto-attached browser context chips must be removed
  before handing off.
- `ChatBuiltInBrowserPanel.test.tsx` can cover starting screenshot crop mode,
  canceling crop mode, and clicking the visible Attach control for an already
  selected browser element. It does not cover dragging a crop region; keep crop
  drag sandbox-only or measure it in a browser-capable throwaway run.
- After forcing BrowserView bounds, switch the Work tools pane away from
  Browser and verify `builtInBrowser.getStatus().visible === false` before
  measuring unrelated chat-toolbar controls. The chat Git commit-message input
  can then be measured with CDP mouse input without submitting; clear the input
  value afterward, and treat close/submit behavior as separate evidence.
- The detached App Control tools pane can safely measure local text entry in
  `App Control launch command` and `CDP port` if the fields are restored and
  Run/Connect are not clicked. `Help wire CDP` is not rendered there unless
  `canAttachToChat` is true, and Control/Inspect mode plus focused-element
  typing need an active app session.
- `ChatAppControlPanel.test.tsx` can cover safe App Control state controls
  without launching or driving an app: inserting the Help wire CDP draft,
  showing the launch terminal, refreshing a
  snapshot, dismissing the message, toggling Control/Inspect, typing in the
  local focused-element text field, switching controlled windows, and re-scanning
  controlled windows. It can also cover hovering an inspected screenshot
  element, selecting a source-context point, and re-attaching that selected
  point. Do not use it as evidence for screenshot control clicks,
  element-crop attachment, Type/send, Stop, Run, or Connect.
- For iOS Simulator tools, switch the Work lane to a real existing worktree
  before measuring status, launch-target, or Preview Lab refresh. Missing lane
  worktrees produce useful fixture evidence but should not be the only proof for
  `refresh-state` or `preview-refresh`. Surface switches, Preview Control /
  Capture mode, and the preview agent-action selector are safe state-only
  controls; Create preview prompt buttons need a chat-capable fixture or
  explicit clipboard/draft handling.
- `ChatIosSimulatorPanel.test.tsx` can cover iOS stream retry/recovery by
  emitting a `stream-error` event and verifying the panel restarts the stream
  for the selected device. It can also cover state-only launch-target select,
  Preview-target select, setup install-command copy, Preview `Create closer preview`, and
  no-target `Create preview` without launching Simulator or Xcode.
  The same fixture can cover live simulator Control/Inspect mode switches,
  active-app text-field entry before Send, inspector refresh, and starting
  screenshot capture mode. It can also cover selecting a mocked ADE-inspector
  element and opening Preview Lab scoped to that element's source file; keep
  Preview rendering as separate sandbox-only evidence. It also covers clearing
  stale launch-target/project-root errors after the project root changes and a
  later `listLaunchTargets` call succeeds; preserve that behavior when editing
  iOS refresh or lane/project-root handling. It does not cover sending text or
  dragging a screenshot crop.
- The iOS Simulator device selector can be measured without booting a simulator:
  switch to the iOS Sim tools tab, change the populated device `<select>`,
  verify the label changes, then restore the original selection. Launch-target
  rows still need a project with a launchable iOS app.
- Preview Lab media toolbar controls are state-only and safe on the empty
  Preview surface: `Expand preview view` should flip to `Exit expanded preview
  view`, zoom-in should move `100% -> 125%`, zoom-out should move `125% ->
  100%`, and reset should return from a setup zoom-in to `100%`.
- Preview Lab create-preview buttons are not valid prompt-draft evidence when
  `onInsertDraft` is absent: the panel falls back to copying the prompt and
  leaves the Work composer empty. Keep `preview-ask-agent` /
  `preview-add-preview` fixture-needed until using a chat-draft-capable surface
  or an explicit clipboard-safe harness.
- CDP coordinate clicks can miss the narrow Work tools tab strip even when the
  buttons are visible and in bounds. For UI-derived probes, prefer dispatching
  DOM clicks on visible tab buttons after recording any invalid coordinate
  attempt; verify `aria-pressed` or equivalent state after every tab switch.
- When probing Work session-card selection, scope DOM queries to
  `[data-tour="work.crossLaneSwitch"]` before matching card buttons. Broad
  button selectors can accidentally click Git commit-history rows in the tools
  pane, producing invalid multi-select evidence.
- In a clean perf-pass Git pane, the Back-to-files view may show `STASHES`,
  `No changes`, and `UP TO DATE` without a `WORKING TREE` label. For
  `work.git.files.back`, verify the selected commit-file buttons disappear and
  the clean files/stashes view returns instead of requiring that label.
- For `work.git.history.hover`, verify the specific `CommitTimeline` tooltip
  container (`div.pointer-events-none.absolute.z-50`). Broad text searches can
  match ancestor nodes that include the whole Work surface.
- In embedded Files probes, distinguish tree rows from editor tabs. Tree file
  buttons have `title=<path>`; editor tab buttons are `button.truncate.text-left`
  without a `title` inside the shrinkable tab group. Use the editor-tab selector
  for `work.files.tab.switch` and `work.files.tab.close`.
- For Files Quick Open and Content Search result probes, scope clicks to the
  active overlay (`div.absolute.inset-0.z-30`). File tree rows and editor tabs
  can have the same visible path text as overlay results.
- Git changed-file rows in `LaneGitActionsPane` are clickable div rows, while
  adjacent visible buttons are per-file actions such as stage/discard. For
  `work.git.file.select`, seed a temporary fixture file if needed, click the
  visible row div containing the path, verify the diff pane header, then delete
  the fixture file and refresh/clean the perf-pass repo.
- Per-file Git stage toggles must keep accessible names. The real Work UI
  exposed unnamed icon buttons before the fix; preserve `Stage <path>` and
  `Unstage <path>` labels when changing `LaneGitActionsPane` file rows.
- Work Git Save Changes must include untracked files. The real UI previously
  reported a successful stash while leaving an untracked-only temp file in the
  working tree; preserve the `includeUntracked` flag when unstaged changes
  contain `kind: "untracked"`.
- Work Git stash refs must remain ordinal refs such as `stash@{0}`. Do not use
  `git stash list --date=... %gd` for the action ref: date-based refs can apply
  but do not reliably remove the stash entry when restoring. Keep timestamps in
  a separate `%cI` field and restore by applying, then dropping, the ordinal ref.
- `LaneGitActionsPane.test.tsx` can cover the staged/unstaged `Show all`
  controls for large change lists by asserting row 300 is hidden under the cap,
  clicking `Show all`, and verifying that row renders.
- `LaneDiffPane.test.tsx` can cover commit-diff `Show all` for large commit
  file lists and the visible `Retry` action for a failed working-tree diff. It
  is not evidence for opening the selected diff in Files or saving edited
  working-tree diffs.
- Embedded Work Files chrome does not render the non-embedded header controls
  such as `files-editor-theme-toggle` or `TRUST & EDIT`; record explicit fail
  markers if probing those rows from the Work tools pane. The embedded editor
  mode buttons are valid Work controls: with a real file open, `CHANGES` and
  `MERGE` can be measured by clicking the visible buttons and verifying their
  active background changes to the accent color, then returning to `CODE`.
- Files diff submodes are also safe state-only controls once embedded
  `CHANGES` view is active. Measure `WORKING TREE`, `STAGED`, and `COMMIT` by
  clicking the visible inner diff buttons, verifying the accent active
  background, and for `COMMIT` verifying the compare-ref select appears with at
  least one recent commit option.

### Missing lane worktrees are lane state, not raw Git errors

The perf-pass repo can contain lane records and branches while the physical `.ade/worktrees/<lane>` directory is missing. The Git history panel previously surfaced raw messages like `git working directory not found: ...` through Electron IPC.

Work UI should show an operational lane-state message:

```text
Lane worktree is missing. Restore or recreate the lane worktree at <path> before viewing history.
```

Do not expose the raw `Error invoking remote method ...` prefix in Work Git history. When reproducing, remove a lane worktree directory from perf-pass, open Work > Git > History, and refresh.

## Watch list

- `ade.ai.getStatus` is now the largest first-window Work startup IPC in the
  local-runtime-disabled perf pass, around `260ms`. Optimize only after checking
  model/provider availability behavior in Settings and launch surfaces.
- Browser panel mount creates built-in browser tabs and can cost about `400-500ms` per tab creation in UI probes. Optimize only after checking that tab reuse and hidden WebContentsView bounds behavior remain correct.
- iOS Simulator status calls are visible costs when those panels mount. Keep them lazy to the tools pane being open.
- Avoid hidden panel polling. App Control, iOS Simulator, and Browser must never
  poll. Since the tools pane became a picker plus one active tool, their
  *status* reads (one `getStatus` plus an event subscription each, in
  `useWorkToolStatuses.ts`) live for as long as the pane is open rather than for
  as long as one tool is on screen — the picker cards and the header's activity
  dots report on tools nobody is looking at. Two rules keep that honest and must
  not be regressed: a tool that is unavailable in this context
  (`workToolAvailability`) is never read from at all, and no status may be added
  that needs a new poller — a tool with no cheap read shows what it is for
  instead of a fabricated line. Attached shells have no status event, so
  `terminal.list` is taken once when the pane becomes visible, never on a timer.
- Picker skeleton lines use `steps(6)` shimmer (`.ade-tool-skeleton`) and are
  capped at 300ms. Keep both: a smooth sweep costs one compositor frame per
  display refresh, which is very expensive on the 240Hz panel this repo is
  developed on, and an uncapped skeleton turns a wedged machine into a grid of
  shimmering placeholders.

## Chat transcript: stable row keys and DOM prepend anchoring

Row keys used to embed the event's index in the loaded window
(`${sessionId}:${index}:${timestamp}`). A 30-event prepend kept 0 of 30 keys,
so every older page, background-chat trim to 1,000 events, or snapshot merge
dropped every measured height (all rows back to the estimate), remounted every
row (replayed fade-ins and async highlighting), and defeated the key-matching
prepend anchor. With the auto-loader then firing again near the top, pages
chained and the thread jumped. Preserve all of these:

- **Keys come from identity.** `allocateTranscriptEventRowKey` builds
  `<session>:<type>:m:<messageId>[:<phase>]`, `<session>:<type>:i:<turn>:<item>`,
  or `<session>:<type>@<timestamp>`, plus `#n` for repeats of one base. It is
  allocated once per event from `context.eventRowKeyOrdinals`, so the
  incremental collapse and a full recollapse agree (parity test) and no
  per-update `JSON.stringify` is needed. Never reintroduce an index into a row
  key.
- **Anchor by the DOM, not by keys.** Before a commit that changes the drawn
  row keys under a scrolled-up reader, the render pass reads up to four
  on-screen rows' tops (`readVisibleChatRows`); the list anchor layout effect
  moves `scrollTop` by exactly the first surviving row's DOM delta. The
  virtualized window for that commit is computed from the anchor's model
  position (`windowScrollTop`) so the row is mounted. Keep `overflow-anchor:
  none`; the list owns anchoring.
- **Restore holds, then releases paging.** Scroll memory saves the DOM row,
  offset, and distance from the bottom; the restore re-applies each frame until
  two stable frames, is cancelled by wheel/touch/pointerdown/scroll keys, and
  blocks older-history loading until it settles. Automatic older-page triggers
  get one page per reader scroll (`MAX_CHAINED_AUTO_OLDER_PAGES`); the
  underfilled-pane backfill is exempt.
- **Heights.** Straddling rows (`rowTop < scrollTop`) reconcile too; unmeasured
  rows use per-kind estimates cached per key; `HighlightedCode` renders cache
  hits synchronously and gives the plain and Shiki `<pre>` the same box.

Tests: `chatTranscriptRows.test.ts` "row keys are position-independent" and
`AgentChatMessageList.test.tsx` "stable row keys, list anchoring, and scroll
restore" (fake per-key layout, both render paths).

### Chat thread scrolling and history (measured with `scripts/perf-chat-scroll.mjs`)

Bench: launch the dev app with `ade app-control launch --command "NO_DEVTOOLS=1 node scripts/dev-desktop.mjs --auto"`
(`dev.cjs` forwards `ADE_APP_CONTROL_DEBUG_FLAGS`; without them a window behind
others stops painting and every frame metric reads 0), then
`node scripts/perf-chat-scroll.mjs --port <cdp> --reload --park <small chat> --session <big chat> [--scenario wheel|top|idle]`.
`--park` matters: Work reopens the last chat on reload, which pages its history
in before the run starts. CDP `Input.dispatchMouseEvent` does not ack in the
dev build, so the bench drives `scrollTop` in-page with a wheel event per frame.

Measured on a 3.6 MB Claude chat (dev build, 3000 px/s):

- A scroll event must not commit a render unless the mounted window or the
  active minimap tick changes (`scrollCommitKey`), with one exact commit after
  the scroll settles. Renderer JS 259→126 ms/s scrolling up, 281→161 down.
- Cache row offsets on the `measuredHeights` version, not on `measurementTick`:
  the tick trails measurements by a debounce, and offsets from stale heights
  misplace the spacers (prepend jumps grew 568→1333 px until fixed).
- The scroll memory is snapshotted in `handleScroll` too; a scroll that does not
  render must still be what a chat switch restores.
- Older history backfills in idle slots (immediately when the reader is in the
  prefetch runway). Cold open → whole transcript resident in ~0.65 s with two
  frames over 33 ms; jump-to-top waited 1.2 s at the top before, ~0.65 s after
  (the rest is image and markdown work for rows mounting at the top).
- Attachment image data URLs are cached per owner and path. Each uncached read
  was a multi-MB base64 reply that held transcript pages queued behind it on the
  runtime socket for ~370 ms.
- Not wins (reverted): skipping selection reads on scroll, keying row
  measurement by key. `measureNow` self time is the layout of newly mounted rows.
- Open: `backdrop-filter` is ~half the GPU while scrolling (52→26% of a core with
  it off): composer/banner ~10 pts, user bubbles (`ade-liquid-glass`) ~5, shell
  header ~4. Changing it changes the look; it is a design decision.

### Chat scenes (measured with `scripts/perf-chat-scenes.mjs`)

Scenes (```` ```scene ```` frames) are live while on screen and a still
elsewhere. Every scene frame of a window shares ONE extra renderer process
(sandboxed opaque-origin frames are out of process); it exits when the last
frame unmounts. Bench: launch the dev app with App Control, seed a chat with
scene fences, then
`node scripts/perf-chat-scenes.mjs --port <cdp> --session <scene chat> --park <small chat> --reload [--no-sampler] [--focus-scene N]`.
It reads CPU per process from `ps` (CDP's browser-process cpuTime stops
tracking across dev-app restarts) and A/Bs best in one app session by swapping
files; see the header. Use `--no-sampler` for idle numbers: the bench's own
rAF loop makes the host produce a frame every refresh, and every live frame
then costs the host an intersection update per frame (+2–3 points that an
idle app does not pay).

Preserve all of these:

- **Idle in the frame, not in the host.** Once settled and untouched, the SDK
  pauses endless CSS/WAAPI animations and SVG SMIL (`pauseAnimations`), and
  batches `requestAnimationFrame` to one flush per 250 ms. 240 Hz display, a
  canvas particle loop + a blurred CSS shimmer + SMIL spinners on screen:
  scene process 0.2% of a core, GPU 6.2% vs 6.4% for the same scenes as
  stills (`--no-sampler`). The old freeze-without-still path left those loops
  running at GPU 42%.
- **Endless animations do not hold a settle back.** A loop never finishes, so
  waiting on it only delayed the idle (and the still) to the 4 s cap.
- **Mount only where the reader stops.** A frame mounts after a 120 ms dwell
  AND 150 ms with no scroll of the scene's own scroll ancestors (not any
  scroll: a streaming terminal scrolls constantly). Without the gate a steady
  scroll through six scenes cost the scene process 12% of a core in mounts.
  It still costs ~5–8% while scrolling past frames that stay mounted (they
  linger 4 s off screen); GPU while scrolling is LOWER than with stills
  (36–51% vs 39–58%), since big PNG stills cost more to raster.
- **Remounts reuse the document and its prepared URL** (renderer cache of 24;
  main's store is LRU on read). Per-document stamps (`readySrc`,
  `settledSrc`, `revealedSrc`) are cleared when the frame unmounts, or a
  remount on the same cached URL reads as ready and shows a blank frame.
- **A scene with a still takes no new still.** Each capture is a window grab,
  a PNG encode and a file; scenes now remount on every scroll back.
- **One theme observer for the app** (`sceneTheme.ts`), and a theme change is
  posted into frames, never a document rebuild.
- **Live data is a child component** (`SceneDataFeed`) mounted only for a
  scene that asked for data and only while its frame is up, so lane and
  session store updates re-render nothing else; sends are deduped by content
  and throttled to one a second.
- Memory: the shared scene process is ~100–170 MB while any scene is live.
  A parked chat or surface (`content-visibility: hidden`) reads as off screen
  and unmounts its frames after the linger.

### Composer floats over the thread

The transcript scrolls behind the composer and its status chips
(`ChatSurfaceShell overlayFooter`). The footer's height reaches the list
through `chatComposerOverlayInset` and is written straight onto the scroll
pane's `padding-bottom` and the Jump pill's `bottom`. Keep it that way: an
inherited CSS variable on the shell would restyle every transcript node on
each prompt line, and React state would re-render the list. The list re-pins
itself when the inset grows while stuck to the bottom. A/B in one dev session
(3.6 MB chat, interleaved): wheel scroll renderer 51.5 vs 52.4%, GPU 56.3 vs
55.2% (noise); cold open to first rows median 172 vs 178 ms, same long frames.

### Background cost with no visual change (measured, second pass)

- An infinite animation over a `backdrop-filter` re-runs the blur and
  composites the window every frame. The header live-activity dot (6px opacity
  pulse, shown whenever an agent is live) cost ~32% of a GPU core and ~67% of
  the main process at idle. Its keyframes now hold eased steps of 0.02 opacity
  (`step-end`): GPU ~6.5%, main ~20%, pixel diff vs the smooth pulse ≤1/255.
  Treat any new looping animation in blurred chrome the same way. Find running
  ones with `document.getAnimations()`.
- Props into the message list and its rows must keep identity across pane
  renders (`useLatestCallback`, `useStableIdentity` in `lib/stableIdentity.ts`).
  Inline closures, a fresh `Set`, a rebuilt turn-diff array or per-turn copy
  objects re-rendered every mounted row: 1,105 row renders in 20 idle seconds
  (now 0), ~5,100 row renders per 400 streamed events (now ~450).
- `toLocaleTimeString(locales, options)` builds an `Intl.DateTimeFormat` per
  call; every row renders a timestamp. Cached formatter: streaming JS
  10.2 → 7.3 ms/event.
- Minimap previews (`summarizeInlineText`) are cached per event object; they
  were recomputed for the whole transcript on every streamed delta (~9%).
- Streaming bench: `scripts/perf-chat-stream.mjs` replays a real transcript into
  the browser-mock renderer (`window.__adeMockEmitChatEvent`) in Playwright's
  Chromium. Pass `--render-hook` with a DevTools hook to count renders; count a
  component only when its props or state object changed, because bailed-out
  subtrees keep stale PerformedWork flags.
- Not wins (reverted): gating the selection toolbar's scroll listener (its
  self time is forced layout that moves), a `Date.parse` cache in
  `chatHistoryMerge` (<1 ms per flush either way).
- Machine state drifts between dev-app launches; compare A/B in one session.
- Next candidate: `AgentChatComposer` is not memoized and gets ~100 props
  (many inline), so it re-renders ~2x per streamed event with its tooltips.

### Work list scaling and other third-pass results

- `SessionCard` uses `memoWithLatestHandlers` (lib/stableIdentity.ts): the list
  hands every card fresh `onSelect`/`onContextMenu`/PR handlers, so plain memo
  never held. TerminalsPage passes the list stable handles (`useLatestCallback`)
  and lanes without PRs share `NO_LANE_PRS`. In the real app at idle, 20 s:
  card renders 1,092 → under 100 (only cards whose session changed), lane headers 870 → 440, idle renderer JS
  270 → 184 ms per 10 s with 32 cards. Lane headers take JSX props, so they
  still re-render with the list; the rest of those renders are real session data.
- Measured and not kept: memoizing `AgentChatComposer` (renders halved, no
  time change; median 5.97 vs 5.77 ms per streamed event), dropping the blur
  on hidden (`opacity-0`) hover toolbars (Chromium already skips it).
- Background chats are cheap: streaming into a chat that is not open costs
  0.24 ms per event (`perf-chat-stream.mjs --background`).
- Cold chat open measured 21–28 ms to first rows (history read 6 ms).

### Looping animations and repeated background work (fourth pass, 240 Hz display)

Measured on a 240 Hz display with per-process CPU sampling (`ps` cputime
deltas) and CDP `Performance.getMetrics`. A smooth looping animation ticks at
the display rate. On a 240 Hz display that is 240 style passes a second.

- Hold any looping opacity animation at 0.02-opacity steps with `step-end`.
  The Work sidebar `Working` breathe used a smooth curve. With three working
  sessions the GPU process used ~19.5% of a core and the renderer ~7%. Stepped:
  3.8% and 3.2%. Derive the stops from the same ease curve, as for
  `activity-hdr-pulse`.
- Do not animate an SVG element itself. Chromium repaints an animated SVG on
  the main thread each frame. Rotate an HTML wrapper of the same size, and use
  `steps(N)` so the rate is 60 a second. The Lanes working mark (five lanes)
  went from a renderer at ~20% to 6.4%.
- Do not let xterm's DOM renderer run its CSS cursor blink. A paused animation
  that `lib/xtermCursorBlink.ts` flips every 500 ms gives the same blink. An
  idle focused shell went from a renderer at 11.7% to 3.6%.
- Do not re-tokenize a growing code block from the start. `CodeHighlighter`
  keeps the HTML of the complete lines and Shiki's grammar state. While an
  agent streamed code, highlighting fell from 14.6% to 0.5% of renderer
  main-thread samples. The output is byte-identical to `codeToHtml`.
- Keep periodic disk snapshots slow when live readers use memory. The PTY
  snapshot (full 2,000-line scrollback, ~0.5 MB) wrote every 500 ms. At 5 s the
  brain went from 6.3% to 2.2% with three busy shells.

Open finding, not fixed: a switch into a long chat (four long replies, ~48k
DOM nodes) blocks the main thread for 600–900 ms. The cost is two full style
passes over ~60k elements, the markdown parse, and `ThreadCommentLayer`
`getBoundingClientRect` reads (~150 ms). A fix needs virtualization or deferred
row mount, so measure the visual effect before you change it.

The WebGL terminal renderer was never active until the fifth pass:
`loadAddonCtor` imported a variable specifier with `@vite-ignore`, so neither
Vite nor the packaged `app.asar` resolved `@xterm/addon-webgl`. Keep the
specifier a string literal (`loadWebglAddonCtor`). A streaming shell demo:
renderer 23.7% (DOM) → 12.7% (WebGL).

### Project and page switches (fifth pass)

Measured with two warm projects, one holding a long chat (12,900 elements)
and one with a printing shell. Use long tasks, the worst frame gap, a
screencast filmstrip, and per-toggle style timings on the surface root.

- Do not let recency set the DOM order of keep-alive surfaces. Moving a
  node detaches and re-attaches its subtree: a full restyle and relayout,
  and every scroll container in it starts at 0. `mountedProjects` picks warm
  surfaces by recency and renders them in tab order. Before: a chat scrolled
  up into history reopened at its first message.
- Hide a parked surface with `content-visibility: hidden`
  (`HIDDEN_PAGE_STYLE`), not with `inert`, `pointer-events: none` or a
  `[attr] *` CSS rule. Each of those three restyled every element of the
  surface (~200 ms apiece); `content-visibility` toggles in ~3 ms, keeps the
  rendering state, stops animations and blocks hit-testing and focus. Code
  that asks "is my surface parked?" checks `[data-ade-surface-hidden]`.
  Result: switch long tasks 450–640 ms → 0, worst frame gap ~480 → ~120 ms.
- Never use a Tailwind `selection:` variant on a large container. It compiles
  to `.x *::selection`, matched against every element on every restyle (40% of
  selector time). Chromium inherits `::selection`, so one rule on the root
  (`.ade-app-selection::selection`) colors the same. Full restyle of the chat
  surface: 205 → 39 ms. Measure selector cost with a trace that includes the
  `disabled-by-default-blink.debug` category (SelectorStats events).
- A project switch must not force a machine-wide AI re-probe. Forced
  `ai.getStatus` re-reads the login shell's PATH with synchronous shells,
  which blocks the brain's event loop and every call behind it (the terminal
  stream resumed 323 ms after the click; now 83 ms). Use
  `invalidateAiDiscoveryCache(root, { forceRefresh: false })` and
  `getAiStatusCached({ revalidate: true })` for a cache bypass.
- Do not rebuild the WebGL terminal renderer on reveal. Creating the DOM
  renderer measures glyphs with a forced full-document layout (~157 ms).
- `onRuntimeStatusChanged` is also a 15 s heartbeat. Use
  `subscribeRuntimeIdentityChanges` for "the brain may have changed".

Open findings: the return to a project with a long chat still costs ~100 ms
of native layout and paint; `useWorkSessions` polls `session.list` every 5 s
for a hidden project too (~6 ms of brain time each round); opening a long
chat still forces layout in `ThreadCommentLayer` and re-parses markdown
(~45 ms).

### Focus grid and many live chats (sixth pass)

Measured in the dev app on a real project, App Control detached, `ps`
cputime over 15 s windows, one chat streaming throughout.

- **Measure with App Control detached.** An attached `ade app-control` session
  kept the Electron main process at ~86% of a core and the GPU near 60%,
  independent of the UI on screen. Detach (`ade app-control stop`) before
  sampling; toggle UI with a CDP `eval` click instead.
- **The window backdrop must not wake on other elements' scrolls.** The top
  bar's `WorkToolPickerBackdrop` listened to capture-phase `scroll` on the
  window and treated every layout read as "someone is looking", so any
  streaming chat (which scrolls itself) kept the gradient drawing at 12–30 fps
  forever, and each frame re-layered the whole page. With six chat tiles that
  was ~2.4 s of `Layerize` in 10 s. Now a scroll counts only when its target
  contains the canvas, and only a canvas that actually moved restarts the
  freeze clock. Six-tile grid: GPU 30% → 8%, renderer 44% → 7–8%; single
  chat: GPU 46% → 9.5%, renderer 26% → 6.6%.
- **Do not pulse an SVG element.** `ContextUsageDial` pulsed its `<circle>`
  while a turn ran; the pulse now runs on an HTML wrapper (same look).
- **Per-pane network reads multiply in a grid.** `useCursorCloudDraftState`
  ran in every chat pane and called Cursor's repositories endpoint (5/min per
  account) on mount; six tiles hit the limit. It now runs only for a chat that
  can still launch to Cursor Cloud (no output yet), and the repo list is
  shared in flight and cached for 5 minutes.

### Idle re-render cascades and the brain (seventh pass)

Measured with a render-counting `__REACT_DEVTOOLS_GLOBAL_HOOK__` that walks only
fibers React processed in a commit (descend only where `prev.child !==
next.child`; a walk over every fiber reads stale `PerformedWork` flags and
over-counts by 10x), plus per-component prop-diff and hook-diff logging.

- **A store write must change something.** `setWorkViewState` and
  `setLaneWorkViewState` wrote a new per-project object on every sessions
  refresh even when no field changed, re-rendering the whole chat pane about
  once a second at idle. They now return the previous state when the merge is
  shallow-equal.
- **Re-read lists keep identity.** `useWorkSessions` reconciles each IPC read
  against the previous rows (`reconcileSessionRows`: equal rows keep their
  object, an unchanged list keeps its array), and `AgentChatPane` compares its
  chat-session list by value before `setSessions`. Session cards went from
  ~15 renders/s at idle to 0.
- **Handlers into `WorkViewArea` are `useLatestCallback`.** `work` changes
  identity on any session state, and every handler depended on it, breaking
  the `useMemo` around `WorkViewArea` (30 → 2 renders per 12 idle seconds).
- **The resource chip only re-renders the top bar when it would draw
  differently** (`resourcePressureIndicatorKey`). Top bar own-updates 28 → 1
  per 15 s.
- **Closed dialogs are memo'd.** `CreateLaneDialogHost` rendered its whole
  form on every streamed event while closed.
- **Loops share one clock** (`lib/animationPhaseAlignment.ts`). Four stepped
  spinners started at different moments drew 120 frames/s; aligned to the
  document timeline they draw 30 (GPU swap 118 → 61 ms/s on the PR page).
- **Chat markdown parses once per text** (`remarkCachedParse`): warm chat
  switch settle 247 → 56 ms. Clone on hit; later plugins mutate the tree.
- **The plain composer sizes with `field-sizing: content`.** Measuring with
  `height = 0` + `scrollHeight` forced two layouts per keystroke.
- **Streaming merge skips the full pass for non-tool events**
  (`toolCallDedupedLists`) and the URL scan pre-checks `"://"`.

Brain (installed-brain CPU profile, 8 min with agents working):

- Per-message/per-tool `commandExists` spawned a login shell each time
  (`commandExistsCached`, 60 s).
- The shell PATH probe re-ran synchronously at TTL expiry (1.2 s blocked);
  now stale-while-revalidate in the background.
- `ProjectRegistry.read()` normalized every root (realpath/stat) per call and
  hot paths call `get` per project: 360 ms → 0.4 ms with a stat-keyed 5 s cache.
- The activity roster opened every recent project's DB (~450-table schema
  parse) every few seconds; cached by db+wal file signature: 43 → 2.5 ms.
- The JSON-RPC server reader concatenated each chunk onto the whole buffer
  (quadratic); 10 MB request 240 → 11 ms.
- The Files quick-open index walked the repo with one `git check-ignore`
  per directory (~540 spawns, 17.5 s); `git ls-files` once: 0.12 s.

### One streamed event must cost one event (eighth pass, ADE-175)

Measured on a Mac Studio (M4 Max) with `scripts/perf-chat-stream.mjs` against a
9,700-event Claude chat, and with `scripts/perf/service/chat-transcript.bench.mts`
on the five largest local transcripts. Renderer busy time for 400 streamed
events fell from 3,890 ms to 2,200 ms, and the row builder from 3.5 ms to
0.08 ms per event.

- **A provider resend is not a reason to rebuild the chat.** Claude sends each
  `tool_call` twice (empty arguments, then the command), and the live merge
  replaces the stored envelope in place. The row builder used to answer every
  replacement with a full pass over the transcript: 1,314 full passes for
  12,000 streamed events in real chats, up to 44 ms each. It now keeps the two
  most recent checkpoints of its state (`CollapseCheckpoint`, one each 128
  events) and replays from the newest one that ends before the replaced event.
  The context is cloned field by field (`cloneCollapseTranscriptContext`), so a
  new context field fails to compile until it is copied. Keep the parity rule:
  a replay must give the rows that a full pass gives.
- **A missing index entry must mean "no such row".** The first sighting of
  every tool call scanned all rows for a row to merge into, and every subagent
  progress tick scanned all rows for a background-job line that it never had.
  A context made by a full pass sets `rowIndexesComplete`, and the lookups
  (`findMatchingWorkLogEntryIndex`, `resolveKeyedRowIndex`) trust an absent
  entry only then. A stale entry still falls back to the scan. Repair every
  index map in `repairIndexedTranscriptRowsAfterSplice` when you add one.
- **The live merge carries its indexes forward.** `mergeAgentChatLiveEvents`
  rebuilt a `Set` of every identity key on each merge, and ran the full
  tool-call pass for each tool event. The list it returns now owns that set and
  a tool-call position map (`liveMergeIndexByList`); the next merge takes them.
  A list that is merged twice rebuilds from the start, which is correct and slow.
- **Folds over the transcript read the append, not the transcript.**
  `agentChatLiveAppendOf(list)` names the list that an append extended, where
  the new events start, and which tool calls a resend replaced. A fold that
  keeps its answer per list (`deriveRuntimeState`, `deriveActiveTurnId`,
  `deriveTurnStartedAt`, the turn-start map, `chatDisplayEvents`) looks at the
  appended events only and falls back to the full fold when one of them can
  change the answer. A derived list (the display filter) records its own
  relation with `recordAgentChatLiveAppend`, or every fold after it loses the
  shortcut. Do not build a new filtered array per event: `selectedEventsForDisplay`
  did, and that hid the append from the whole list.
- **A same-value `setState` is not free.** A locked pane wrote its own session
  id to `selectedSessionId` on every event. React cannot drop that write early
  while the component has other updates queued, so the 17,000-line pane ran
  twice per event. The setter now skips a value that was already requested.
- **Handlers that reach every row must be stable.** `onRetryCompaction` was a
  `useCallback` on a value that changes each render, and it re-rendered every
  mounted row on every event (24 row renders per event; now 0.1). The per-turn
  model descriptor had the same effect after each resend. Check new list props
  with the render counter before you merge them.
- **Measure renders by cause.** `render-hook.js` counts renders; to find why the
  pane renders, compare hooks that own a queue (`hook.queue`) and the context
  dependencies, not `memoizedState` alone. A render with no visible cause is a
  same-value write.

Open: the pane's own chrome (header, composer, three closed dialogs) still
renders once per event and once per keystroke, about 150 component renders
each. A selected chat at its resident cap (60,000 events or 32 MB) trims one
event from the front on every flush, which gives a new list each time and
sends the merge and the row builder back to full passes; trim in steps instead.

### The hosted client's sign-in stylesheet

The entry stylesheet of the hosted client was the whole of `index.css`
(672 KB). It is now `webclient/gate.css` (58 KB): Tailwind limited to the files
in `tailwind.gate.config.cjs`, plus `styles/foundation.css` (theme values,
tokens, base element rules) and the two component partials the sign-in screen
draws (`toolPickerBackdrop.css`, `smartTooltip.css`). `index.css` imports the
same partials and loads with the workspace (`loadAppStylesheet`), before the
app's modules so that it keeps its place ahead of every chunk stylesheet.

- Check a change to this split with computed styles, not screenshots: compare
  `getComputedStyle` of every element (and `::before`/`::after`) between the old
  and the new build, in the default, hover, focus-visible and active states and
  in both themes. That check found the backdrop rules, the tooltip rules, a
  theme value that Tailwind had dropped (`@theme static` keeps them), and an old
  `.ade-glass-card` rule in `index.css` that changes the sign-in card on hover.
- Do not move the desktop entry's `import "./index.css"` or make `main.tsx` a
  dynamic import. Both change the chunk graph, and with it the order of the
  stylesheets: `HomeWidgetGrid`, `music` and the primitives stylesheet then
  load before `index.css` instead of after it, and they share `.kit-*` class
  names with it. A top-level `await` in `browserMock.ts` has the same effect.
- The dev Electron window must not load the browser-mock snapshot
  (`browser-mock-ade-snapshot.generated.json`). `vite.config.ts` serves it an
  empty module. It finds the app window by the `ADEDevShell` mark that
  `main.ts` adds to the user agent in dev; a page in the built-in browser has
  the plain Electron user agent and must still get the snapshot. With a 60 MB snapshot the renderer heap was 477 MB after GC and
  the launch stalled for 6 s; it is 129 MB without.

### Parked surfaces and the router (ninth pass, four projects open)

Measure switches with more than one project open. With one project every
number below looked fine.

- **A parked surface must not see the router move.** Every mounted project
  sits under the one router, and `useLocation`, `useNavigate` and each nested
  `<Routes>` read its contexts. One project switch rendered the Work surface
  of all four mounted projects several times: 12,950 component renders and a
  170 ms first frame. `ProjectSurfaceRouterScope` (App.tsx) holds the
  location and route-match contexts at their last on-screen value for a parked
  project, and for the parked Work surface of the visible project. The Work
  element is also the same object while parked (`useMemo`). Project switch:
  173-180 ms to 53-55 ms; tab switch 59-63 ms to 28-32 ms. Routes, the selected
  chat and its scroll position survive (checked by driving the app).
- **A switch must not hand out new objects for the same project.** The
  binding and the `ProjectInfo` of each open project were rebuilt on every
  switch (`projectEntries`, `setProject`). Reuse the stored object when its
  fields are the same.
- **The top bar is memoized in the shell** (`ShellTopBar`,
  `memoWithLatestHandlers`): the shell renders several times per switch.
- Count renders per interaction with a `__REACT_DEVTOOLS_GLOBAL_HOOK__` that
  is installed before load, and read the roots (components that rendered while
  their parent did not) and the causes. Import the store through the URL the
  page loaded (`performance.getEntriesByType("resource")`): after an HMR edit
  the page uses `appStore.ts?t=...`, and a plain import is a second store.

### File watchers in the brain

- Watch a directory tree with `watchTree` (`services/shared/treeWatcher.ts`),
  not with chokidar directly. On macOS chokidar must poll (its native mode
  opens one watch per directory, and closing thousands of them blocked the
  event loop for 13 s on this repo), and a poll checks every path each second:
  16,000 paths and about 11% of a core for this repo's root. `watchTree` uses
  one recursive native watch per root on macOS and decides what happened by
  reading the path again and comparing with a snapshot, so the events are
  chokidar's. Check a change to it with
  `scripts/perf/service/tree-watcher-parity.mts` and
  `tree-watcher.bench.mts`. `withMacosSafeChokidarOptions` is still right for
  a handful of named files (`configReloadService`).
- Count polled paths in the brain with `process.getActiveResourcesInfo()`
  (`StatWatcher`; `FSEventWrap` is a native watch), after
  `process._debugProcess(<pid>)`. Poll CPU is on the libuv worker threads, so
  a JS profile of the brain shows nothing; `sample <pid>` shows `stat`.
- A watch is one reference and a stop releases one. A page that goes away
  without its cleanup never sends the stop. `fileWatchLedger.ts` keeps the
  outstanding references in two places: the desktop main process sends the
  missing stops when a page starts a new document, loses its renderer or is
  destroyed (`trackPageFileWatch`), and the brain releases a connection's
  watches when the connection closes (`adeRpcServer` `handler.dispose`). Keep
  both: the first covers a reload, the second covers the app quitting.
  The second also releases the watches of a page that only lost its
  connection, so the bridge opens them again when the page subscribes to
  events on the new connection (`restorePageFileWatches`). Do not remove
  that step, or an open Files tab stops its updates after a reconnect.

### The appearance store

`state/appearanceStore.ts` holds the theme, scene, font, motion and tooltip
values and their parsing. `appStore` imports the parsing and registers itself;
`useAppearanceStore` reads the project store in context, then the root store,
then a stand-in. Components that the hosted sign-in screen draws must use
`useAppearanceStore`, not `useAppStore`, or `appStore` (257 KB) returns to the
signed-out download. `pinKey` is in its own file for the same reason.


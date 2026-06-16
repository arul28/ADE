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
  value afterward, and treat close/submit behavior as separate evidence. Broad
  Work UI coordinate probes did not open the Quick Run Radix menu, but
  `ChatGitToolbar.test.tsx` covers the current-lane navigation button and the
  embedded `QuickRunMenu` trigger with pointerdown/up; use that as fixture
  evidence unless a future real-UI probe opens the menu reliably.
- The detached App Control tools pane can safely measure local text entry in
  `App Control launch command` and `CDP port` if the fields are restored and
  Run/Connect are not clicked. `Help wire CDP` is not rendered there unless
  `canAttachToChat` is true, and Control/Inspect mode plus focused-element
  typing need an active app session.
- `ChatAppControlPanel.test.tsx` can cover safe App Control state controls
  without launching or driving an app: selecting a configured Run-tab command,
  inserting the Help wire CDP draft, showing the launch terminal, refreshing a
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
- iOS Simulator status calls are visible costs when those panels mount. Keep them lazy to the active tools tab.
- Avoid hidden panel polling. App Control, iOS Simulator, and Browser should subscribe or poll only while their tab is active, unless a feature explicitly needs background state.

# ADE `ade code` TUI — finish Phase 3, build Phase 4 + 5

## Kickoff prompt (paste this to the agent)

> You're continuing the ADE TUI parity pass on branch `ade/tui-parity-pass` in
> this worktree. The TUI is the Ink/React terminal client at
> `apps/ade-cli/src/tuiClient/` (`ade code`). Implement, in order: the **remaining
> Phase 3** items, then **all of Phase 4**, then **all of Phase 5**, exactly as
> specified in this file (`codexGoal.md`). Work in small, committed, tested
> increments — after each task run `npx tsc -p tsconfig.json --noEmit` and the
> relevant `npx vitest run <file>` from `apps/ade-cli/`, and add a focused unit
> test for any new pure helper. Do NOT regress the 842 passing tests. `app.tsx`
> is a ~10k-line monolith touched by most tasks: edit it sequentially (no
> parallel agents writing it concurrently); use read-only agents only for
> investigation. Follow the existing patterns described below. Build with
> `npm run build` in `apps/ade-cli` before declaring a task done. The user runs
> the live TUI for validation — keep each increment shippable and eyeball-able.

---

## Context & ground rules

**Where:** `apps/ade-cli/src/tuiClient/` — `app.tsx` (the monolith: state, input
handling, command dispatch, render), plus `components/` (ChatView, RightPane,
Drawer, MultiChatGrid, ModelPicker, FooterControls, ApprovalPrompt, Header,
SlashPalette, MentionPalette), and helpers (`adeApi.ts`, `connection.ts`,
`jsonRpcClient.ts`, `hitTestRegistry.ts`, `theme.ts`, `format.ts`,
`aggregate.ts`, `spinTick.tsx`, `commands.ts`, `types.ts`). It speaks ADE
JSON-RPC to the runtime daemon and shares types/logic with the desktop under
`apps/desktop/src/shared/`. The desktop renderer (`apps/desktop/src/renderer/`)
is the design reference — match its semantics, not its layout (this is a
width-constrained terminal: Ink `Box`/`Text` only, colors from `theme.ts`).

**Build / test (from `apps/ade-cli/`):**
- Typecheck: `npx tsc -p tsconfig.json --noEmit`
- Scoped tests: `npx vitest run src/tuiClient/__tests__/<file>`
- Full TUI-ish suite: `npx vitest run`
- Bundle (must pass before "done"): `npm run build`

**Live test (the user does this; you can smoke it):** rebuild, then
`ADE_DEFAULT_ROLE=cto ADE_HOME=/Users/admin/.ade-tui-parity node apps/ade-cli/dist/cli.cjs runtime start`
and `ADE_HOME=/Users/admin/.ade-tui-parity node apps/ade-cli/dist/cli.cjs --socket code`
(a dedicated isolated daemon; rebuilding changes the build hash so restart the
daemon after each build). Shut down with `runtime stop`.

**Conventions / patterns already in place — reuse, don't reinvent:**
- **Theme:** all colors via `theme.ts` tokens (`theme.color.*`, `theme.provider(family)`,
  `theme.lane(lane)`, `theme.rail`). Brand violet `#A78BFA` is the accent;
  selected/focused = violet, neutral borders = `theme.color.border`. No raw hex,
  no green for "healthy/idle" chrome (green reads as a glitch — reserve it for
  the running spinner only).
- **Hit-test / mouse:** `hitTestRegistry.ts` — `useHitTestTarget({id, rect, onClick, zIndex})`
  returns an `isHovered` boolean; the move handler in `app.tsx` (`hoverTest`,
  grep `hoverTest`) sets `hoveredHitId` which flows via `HitTestProvider`. Mouse
  parsing: `parseTerminalMouseInput` (SGR/rxvt/X10), `decodeMouseButton`. Many
  app-level targets are registered in the render pass in `app.tsx` (grep
  `addFooterInlineTarget`, `appHitTargetIdsRef`, `registry.register`).
- **Streaming:** chat events are coalesced (`flushPendingChatEvents` /
  `scheduleChatFlush` / `CHAT_EVENT_FLUSH_MS`); a single shared `displayBlocks`
  (`aggregateChatBlocks`) is threaded into ChatView + the `render*`/`compute*`
  helpers. Don't add per-token work or new full-transcript walks.
- **Grid:** `multiView` ("grid exists") is decoupled from `gridViewActive`
  ("grid shown") via `setGridView(active)` + `gridViewActiveRef`. Submit/scroll/
  selection routing and the grid sync effect already gate on `gridViewActive`.
- **Footer inline cells:** the cell order is a single source of truth —
  `inlineRowCellOrder({providerLocked, fastSupported, reasoningSupported, subagentsVisible})`
  (exported from `app.tsx`). Keyboard nav, mouse down-cycle, and hit-tests all
  derive from it. Add new cells there.
- **Prompt input:** `applyCoalescedPromptInput` segments coalesced chunks
  (Ink merges fast keystrokes). Reuse the prompt helpers (`insertPromptText`,
  `deletePromptBackward`, etc.).
- **Right pane:** `RightPaneContent` is a discriminated union in `types.ts`;
  `RightPane.tsx` renders each `kind`. Forms use the `{kind:"form", command, fields}`
  shape; submit handled in `app.tsx` (grep `form.command ===`).
- Line numbers in this file are approximate (the monolith shifts) — **grep for
  the named symbol** to find the current site.

**Out of scope / non-goals (do not build):** 2D React-Flow graph canvas,
multi-project tabs, Monaco-grade editing, full structured automation-rule editor.

---

# PHASE 3 — remaining runtime UX + model picker

Already done (do not redo): model-picker glyph/color unification + `⌕` search +
shortId/alias search; Codex `custom` preset cycle fix; footer fast/reasoning
reachability via `inlineRowCellOrder`; shimmer working indicator.

## 3.1 — Codex approval × sandbox readout (S)
**Goal:** When provider is `codex`, show the resolved approval policy × sandbox
pair in the footer so it's legible even when the preset word is `custom`/`config-toml`.
**Files:** `app.tsx` (`resolveCodexPreset`, `permissionSummary`, `permissionOptionsDetail`),
`components/FooterControls.tsx`.
**Approach:** Add a pure helper `codexApprovalSandboxLabel(modelState)` near
`resolveCodexPreset` returning e.g. `"on-request · workspace-write"` from
`modelState.codexApprovalPolicy` / `codexSandbox`. Pass a `permissionDetail?: string|null`
prop to `FooterControls` and render it dim immediately after the permission cell
(only when provider === codex). Keep the headline preset word as-is.
**Acceptance:** Codex footer shows the approval/sandbox pair; switching presets
updates it; non-codex providers unaffected; unit-test the label helper.

## 3.2 — Cursor modes from the runtime snapshot (M)
**Goal:** Cursor permission cycling should use the session's actual available
modes, not the static `CURSOR_AVAILABLE_MODE_IDS`.
**Files:** `types.ts` (`AdeCodeModelState`), `app.tsx` (model-state normalize/
restore sites — grep `cursorModeId`, `cursorModeSnapshot`; `cyclePermission`
cursor branch; `permissionOptionsDetail` cursor branch), shared type
`AgentChatCursorModeSnapshot` in `apps/desktop/src/shared/types/chat.ts`.
**Approach:** Add `cursorAvailableModeIds: string[]` to `AdeCodeModelState`
(default `[]`); populate it from `configSession.cursorModeSnapshot?.availableModeIds`
everywhere `cursorModeId` is set from a snapshot. Add a resolver
`cursorModeIdsForState(modelState)` = snapshot ids when non-empty else the static
fallback (mirror desktop `AgentChatComposer` behavior). Use it in the
`cyclePermission` cursor branch and `permissionOptionsDetail`. `cursorModeLabel`
already handles unknown ids.
**Acceptance:** With a Cursor session whose snapshot lists a subset of modes,
cycling only visits those modes; with no snapshot, the static list is used.

## 3.3 — Plan-approval card (M)
**Goal:** Render plan-mode / approval requests as a one-key approve/reject card
instead of forcing the typed high-stakes path.
**Files:** `pendingInput.ts` (the request → `PendingApproval` mapping), 
`components/ApprovalPrompt.tsx`, `app.tsx` (the pending-approval render + the
approval resolution path — grep `pendingApproval`, `resolvePendingApproval`).
Also handle an orchestration `model_selection` request kind if present.
**Approach:** Detect plan-approval / model-selection request kinds in
`pendingInput.ts` and surface them as a structured `ApprovalPrompt` with labeled
choices; wire keys (e.g. `y`/`n` or numbered) + clickable footer buttons (reuse
the existing approval footer items pattern). Don't break the existing high-stakes
modal path.
**Acceptance:** A plan/approval request shows a readable card with one-key
accept/reject; resolving sends the right response.

## 3.4 — Structural model-picker unification (L)
**Goal:** One picker for both `/model` and the new-chat flow. Retire the duplicate
inline `model-setup` / `new-chat-setup` rows as the *model* surface; fold
Permissions / Fast / Output-style into a slim settings strip inside
`ModelPickerPane`; add auth dots + sign-in hints + per-row reasoning chips.
**Files:** `components/ModelPicker/ModelPickerPane.tsx` (presentation),
`components/ModelPicker/modelPickerLayout.ts` (+ `types.ts` in that dir),
`tuiClient/types.ts` (`ModelPickerRightPaneContent`, maybe retire `model-setup`),
`components/RightPane.tsx` (the `model-setup`/`new-chat-setup` block + `modelPickerInputs`),
`app.tsx` (`openModelRow`, `modelSetupRows`/`modelPickerRows`, `openNewChatSetup`,
`commitModelPickerSelection`, the setup-row keyboard branch, the `aiStatus`
threading). Desktop reference: `apps/desktop/src/renderer/components/.../ModelPicker/`
(`ModelListRow.tsx`, `ModelPickerRail.tsx`) and `useProviderAuthStatus.ts`
(`familiesFromStatus`).
**Approach (sequence — ship pieces independently):**
1. **Reasoning chip** on the focused/active row (port `REASONING_LABELS`); cycle
   via the existing `modelPicker:increaseEffort`/`decreaseEffort` actions.
2. **Auth dots + sign-in hint:** port pure `familiesFromStatus` into
   `modelPickerLayout.ts`; thread `aiStatus` through `modelPickerInputs`; render a
   1-cell red/amber dot after each rail glyph and a `Sign in: /login <provider>`
   hint when the active rail provider is unauthed.
3. **"Show all models" toggle** (desktop `authOnly`): add `showAll` to the picker
   state + an `authOnly` filter in `buildModelPickerLayout`; bind a key + hit-test.
4. **Settings strip + retire duplicate rows (the big one):** render Permissions/
   Fast/Output-style as a compact focusable strip at the bottom of `ModelPickerPane`
   driven by the existing `buildSetupRows` (`SetupPaneRow`); extend the picker
   state with `footerFocus?: SetupPaneRowKind`; Tab/arrows cycle into the strip and
   reuse the existing `handleSetupRow`. Repoint `/effort` and `openNewChatSetup`
   to open the unified picker; delete `openModelRow`, the `model-setup` kind, and
   the inline `model-setup`/`new-chat-setup` rendering block once their rows feed
   the strip. New-chat-only affordances (lane label, "prompt now"/background
   dispatch, Apply) survive as picker header/footer actions.
**Cautions:** the picker re-renders on every keystroke (keep it pure/cheap; no
per-row IPC — precompute auth status and pass it in). Width-degrade all chips/dots
via the existing `endTruncate`/`innerWidth` budget.
**Acceptance:** `/model` and new-chat show the same picker; reasoning chip + auth
dots + show-all work; permissions/fast/output-style are editable inside the picker;
the old inline setup rows are gone; tests for the layout function extended.

---

# PHASE 4 — full mouse control + global navigation

The hover pipeline is wired (`hoverTest` fires on move, `hoveredHitId` flows via
`HitTestProvider`, `useHitTestTarget` returns is-hovered) but **only `MultiChatGrid`
consumes it**. Make every interactive surface mouse-driven, with hover affordances.

## 4.1 — Universal hover (L)
**Goal:** Hovering any clickable row tints it. Consume `hoveredId` in `Drawer`
(lane/chat rows), `FooterControls` (cells/buttons), `ModelPicker` (rail + rows),
`RightPane` (list/diff/file rows, form fields), `ApprovalPrompt`.
**Files:** the component files above + `app.tsx` (where their hit-test targets are
registered — grep `registry.register`, `appHitTargetIdsRef`; many rows are
registered centrally in the render pass).
**Approach:** For each clickable region that already registers a hit-test target,
pass the hovered state down (or have the row call `useHitTestTarget` with its id +
rect) and tint on match (e.g. `theme.color.borderActive` background or violet
text). The move handler already re-renders on hover change, so this is mostly
plumbing. Keep the registration the single source (don't double-register).
**Acceptance:** moving the mouse over drawer lanes/chats, footer cells, model rows,
right-pane rows highlights the row under the cursor; clicking still works.

## 4.2 — Wheel routed to the pane under the cursor (M)
**Goal:** The wheel scrolls whatever pane the pointer is over, not only the center
transcript. (Grid tiles already scroll-under-cursor — keep that.)
**Files:** `app.tsx` (wheel handler — grep `mouse.kind === "wheel"`), `RightPane.tsx`.
**Approach:** Add scroll-offset state for the right pane (copy ChatView's
`sliceRows`/`maxScrollOffsetForRows`/`scrollOffsetRows` machinery) so `/diff` and
detail/list panes become scrollable instead of truncating. In the wheel handler,
dispatch by pointer region: drawer → drawer scroll; right pane → right-pane offset;
center → existing transcript/tile logic.
**Acceptance:** wheel over the drawer, right pane, and center each scroll the
correct region; long `/diff` and detail panes scroll.

## 4.3 — Clickable chat links (M)
**Goal:** URLs in chat are openable (OSC-8 + click).
**Files:** `format.ts` (link runs — grep `link`, `LINK_COLOR`; the href is
currently dropped, see the comment "doesn't render hyperlinks distinctly today"),
`components/ChatView.tsx` (`InlineSpans` link branch), `app.tsx`
(`openExternal`/external-open path — grep the PR-url open).
**Approach:** Carry the href on the link `InlineRun`; emit an OSC-8 hyperlink
escape around the visible text; register a hit target over the link rect that
calls the existing external-open helper. Verify the OSC-8 sequence is width-0 (no
layout shift).
**Acceptance:** a URL in an assistant message is underlined, OSC-8 clickable in
supporting terminals, and a mouse click opens it.

## 4.4 — Ctrl+K command / lane / chat palette (L)
**Goal:** A global fuzzy palette to jump to lanes, chats, and commands (like the
desktop `CommandPalette` / Claude Code's `/`-less quick switch).
**Files:** new overlay component (model it on `components/SlashPalette.tsx`), 
`keybindings/index.ts` (add `app:openCommandPalette`), `app.tsx` (state + render +
key handling), `commands.ts` (reuse `paletteCommands`).
**Approach:** Ctrl+K opens an overlay listing: built-in + user slash commands,
lanes (jump/switch), and chats (jump/switch). Fuzzy filter as you type (reuse the
slash/mention palette filtering); ↑↓ + mouse hover to select; Enter runs/jumps;
Esc closes. Selecting a lane/chat routes through `applyDrawerChatSelection`
(so grid re-entry works); selecting a command dispatches via the existing
command runner.
**Acceptance:** Ctrl+K opens; typing filters across commands/lanes/chats; Enter
jumps or runs; mouse hover + click work; Esc closes; no conflict with Ctrl+R
(history) or other bindings.

## 4.5 — `[` / `]` lane cycling + `/switch` restores last chat + reverse pane cycle (S)
**Files:** `app.tsx` (grep `cycleScope`/`[`/`]` currently bound only in the model
picker; `/switch` handler ~grep `"/switch"`; `tabs:previous`).
**Approach:** Bind `[`/`]` (when not in a text field/palette) to cycle the active
lane prev/next. Make `/switch <lane>` restore that lane's last-active chat
(`lastChatByLaneRef`). Fix `tabs:previous` aliasing forward (make it reverse).
**Acceptance:** `[`/`]` move between lanes; `/switch` lands on the last chat;
reverse pane-cycle goes backward.

---

# PHASE 5 — chat management completeness

## 5.1 — Delete / archive / unarchive chat (L)
**Goal:** Manage chat sessions from the TUI (the runtime supports it; the TUI has
no wrappers and never filters archived chats).
**Files:** `adeApi.ts` (add `deleteSession`/`archiveSession`/`unarchiveSession`
wrappers — confirm the exact action names via the runtime action registry,
`apps/desktop/src/main/services/adeActions/registry.ts` chat/session domain),
`app.tsx` (session list — **filter out `session.archivedAt`**; add drawer chat-row
actions + `/chat …` commands + a confirm gate), `commands.ts` (add the commands),
`components/Drawer.tsx` (a click-× / hotkey on chat rows), `types.ts` if a form is
needed.
**Approach:** Mirror the lane-management pattern already in place
(`/lane archive|unarchive|delete` + drawer hotkeys r/a/x + delete-risk preflight):
add `/chat rename|archive|unarchive|delete` (or reuse `/rename` for chat title),
drawer hotkeys on the selected chat row, and a confirm for delete. Filter
`!session.archivedAt` from the displayed session list (grep where sessions are
listed/filtered) so externally-archived chats stop polluting the drawer/grid;
add an "archived chats" listing.
**Acceptance:** can delete/archive/unarchive a chat from the drawer + slash
commands; archived chats are hidden from the normal list and listable on demand;
delete is confirmed.

## 5.2 — Browse / search chats (M)
**Goal:** `/chats` is filterable; `/switch` resolves chats (not just lanes);
Ctrl+R recalls.
**Files:** `app.tsx` (`/chats`, `/switch`, Ctrl+R history-search — grep
`"/chats"`, `"/switch"`, `historySearch`, `cycleScope` (remove dead code)).
**Approach:** Make `/chats` list the active lane's chats with a filter; make
`/switch` accept a chat reference and resolve it via `applyDrawerChatSelection`
(grid re-entry aware); make Ctrl+R recall prompt history (fix the path that
currently can't recall) and remove the dead `cycleScope`.
**Acceptance:** `/chats` filters; `/switch <chat>` switches chats; Ctrl+R recalls
prior prompts.

## 5.3 — Session legibility: tag + completion + status glyphs (M)
**Goal:** Surface session tag, completion, and a colored wait/running glyph in the
drawer/grid so state reads at a glance.
**Files:** `format.ts` (tag rendering — grep `tag`, currently invisible),
`components/Drawer.tsx`, `chatInfo.ts`.
**Approach:** Render the session tag where chats are listed; add per-chat status
glyphs (running spinner / amber awaiting / dim ended) consistent with the grid
tile glyphs already added (`ChatView` tile header). Bucket by status/time if
useful.
**Acceptance:** tagged chats show their tag; chat rows show a clear status glyph.

## 5.4 — `/context` visual breakdown + relax the Claude gate (M)
**Goal:** `/context` shows a visual token/context breakdown and works wherever the
runtime supports it (not Claude-only, text-only).
**Files:** `app.tsx` (`/context` handler — grep `"/context"`, `getContextUsage`),
`components/RightPane.tsx`, reuse the `TokenBar` from `FooterControls.tsx`.
**Approach:** Render context usage as a visual breakdown (a `TokenBar`-style bar +
per-bucket lines) in the right pane; relax the `provider === "claude"` gate where
the runtime returns usage for other providers.
**Acceptance:** `/context` shows a visual breakdown; works for supported non-Claude
providers; degrades gracefully when unavailable.

---

## Definition of done (each task)
1. Typecheck clean (`tsc --noEmit`).
2. Relevant scoped vitest green + a new unit test for any pure helper added.
3. Full `npx vitest run` green (currently 842 tests — don't regress).
4. `npm run build` succeeds (verifies the bundled CLI).
5. TUI-appropriate (Ink Box/Text, theme tokens, width-degrades) and consistent
   with the patterns above. Commit per task with a clear message.

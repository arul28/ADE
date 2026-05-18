---
name: ade-tui-web-preview
description: >-
  Guides edits to ADE's `ade code` Ink TUI when the user provides browser web-preview
  screenshots, xterm mirror context, or Cursor browser inspector output from
  `npm run dev:code:web`. Explains PTY mirror architecture, where to change layout vs
  bridge code, and how to map visible regions to `apps/ade-cli/src/tuiClient/` sources.
  Use when editing TUI code from web preview snapshots, dev:code:web, xterm mirror, or
  browser-based TUI inspection.
metadata:
  author: ADE
  version: 0.1.0
---

# ade-tui-web-preview

Read this **before** changing anything when the user attaches a web TUI screenshot, browser snapshot, or describes what they see at `http://127.0.0.1:<port>/` from `npm run dev:code:web`.

## Mental model (read first)

The browser page is **not** a React DOM clone of the TUI.

```
ade code (Ink/React) → PTY stdout (ANSI bytes) → scripts/tui-web.mjs → WebSocket → xterm.js in browser
```

- **One process:** `dev:code:web` spawns a single `ade code` in `node-pty`. Native terminal and browser show the **same** session only if both attach to that one PTY — not if you run `ade code` separately in iTerm **and** open the web URL.
- **One UI codebase:** Ink components in `apps/ade-cli/src/tuiClient/` render the layout. The browser is a terminal emulator surface (xterm cells), not `Drawer` / `ChatView` DOM nodes.
- **Parity target:** Character grid, colors, borders, focus, keyboard, and mouse behavior should match Terminal.app/iTerm at the same cols×rows. Sub-pixel font rendering may differ slightly (Menlo in browser vs native terminal).

Do **not** build a parallel browser UI, add `data-ade-*` DOM hooks, or edit the inline HTML page to fix layout bugs that belong in Ink.

## Where to edit

| Symptom | Edit here | Do not edit |
|--------|-----------|-------------|
| Layout, colors, copy, panes, chat, drawers, keybindings | `apps/ade-cli/src/tuiClient/**` | `scripts/tui-web.mjs` HTML/CSS |
| Blank page, WebSocket stuck, no colors, wrong cwd, resize/grid drift, multi-tab primary | `scripts/tui-web.mjs` | `tuiClient/` (unless the TUI itself is wrong in **both** native and web) |
| RPC, lanes, chat events, runtime data | `tuiClient/connection.ts`, `adeApi.ts`, desktop shared types/services | Browser bridge |
| Theme tokens | `tuiClient/theme.ts` | xterm `theme` (background-only; ANSI comes from Ink) |

**Default rule:** If the bug appears in a normal terminal running the same `ade code` process, fix `tuiClient/`. If it appears **only** in the browser mirror, fix `scripts/tui-web.mjs`.

For file-level map, see [reference.md](reference.md).

## How to read web preview context

### Screenshots and image descriptions

Treat the image as a **fixed-width character grid**, not a web page:

- Purple/lavender borders and headers → Ink `Box` borders + `theme.ts` brand colors
- Left **LANES** / **CHATS** column → `components/Drawer.tsx`, `drawerSelection.ts`, `laneTree.ts`
- Center splash / chat transcript → `app.tsx` layout + `components/ChatView.tsx` or welcome state in `app.tsx`
- Right **PRIMARY • FOCUSED** / lane details / chat info → `components/RightPane.tsx`, `chatInfo.ts`, `subagentPane.ts`
- Top tabs (lane, branch) → `components/Header.tsx`
- Bottom input + status → `components/FooterControls.tsx`, `components/ModelStatus.tsx`, `statusline/`
- `189×82` (or similar) in the corner → terminal dimensions from `useTerminalDimensions()` in `app.tsx`; web primary tab drives PTY size via FitAddon

When the user says "move this panel" or "this text is clipped", translate to **row/column budget** and pane width constants in `app.tsx` (e.g. `DRAWER_PANE_WIDTH`, `MIN_CENTER_PANE_WIDTH`, `RIGHT_PANE_MAX_WIDTH`), not CSS flexbox.

### Cursor browser inspector / snapshot

Inspector shows xterm internals (`.xterm-screen`, `.xterm-rows`, `.xterm-cursor`), **not** Ink component names. You cannot select `RightPane` in Elements and edit it — grep `tuiClient/` for the visible label text or pane section header instead.

### What the user might wrongly assume

| User assumption | Reality |
|----------------|---------|
| "Fix it in the browser page" | Fix Ink; refresh browser (same PTY picks up after rebuild/restart) |
| "Add DOM attributes for inspector" | Rejected pattern; use screenshots + source map |
| "Web and iTerm are two sessions" | Only one PTY unless they started two processes |
| "Inspector shows React tree" | Shows xterm grid only |

## Edit workflow

Copy this checklist:

```
- [ ] Confirm context is from dev:code:web (one PTY), not a stale tab or second ade code
- [ ] Reproduce or reason: does native terminal show the same issue?
- [ ] Map visible region → tuiClient file(s) (reference.md)
- [ ] Change tuiClient/ (or tui-web.mjs only if bridge-specific)
- [ ] Run targeted tests under apps/ade-cli/src/tuiClient/__tests__/
- [ ] npm --prefix apps/ade-cli run typecheck
- [ ] Verify in web mirror (and native terminal if layout/input changed)
```

### Run the web mirror

```bash
npm run dev:code:web -- --attach --skip-runtime-build \
  --socket ~/.ade/sock/ade.sock \
  --project-root /path/to/project \
  --workspace-root /path/to/checkout
```

After `tuiClient/` code changes, rebuild if not using tsx hot path: `npm --prefix apps/ade-cli run build`, then restart `dev:code:web` (PTY child does not hot-reload compiled output).

### Bridge-only checks

When fixing `scripts/tui-web.mjs`:

- PTY stdout → binary WebSocket frames (preserve escape sequences)
- Primary tab only sends resize + stdin
- FitAddon cols×rows must match `shell.resize(cols, rows)`
- `cwd` = `--workspace-root`; env: `TERM=xterm-256color`, `FORCE_COLOR=3`, unset `NO_COLOR`
- Mouse/alternate-scroll: enabled by TUI CSI on PTY stream; xterm forwards — do not duplicate in Ink

## Mapping common UI labels → source

| Visible label / region | Start here |
|------------------------|------------|
| LANES, CHATS, `+ new lane` | `components/Drawer.tsx`, `drawerSelection.ts` |
| Chat transcript, selection, scroll | `components/ChatView.tsx`, `app.tsx` (scroll/mouse) |
| Slash / mention palettes | `components/SlashPalette.tsx`, `components/MentionPalette.tsx` |
| Right pane git status, changes, actions | `components/RightPane.tsx`, `adeApi.ts` |
| Chat info, subagents, plan | `chatInfo.ts`, `subagentPane.ts`, `RightPane.tsx` |
| Header / wordmark | `components/Header.tsx`, `components/AdeWordmark.tsx` |
| Footer shortcuts, model line | `components/FooterControls.tsx`, `components/ModelStatus.tsx` |
| Colors, status glyphs | `theme.ts` |
| Keys, chords, paste | `keybindings/index.ts`, `app.tsx` input handlers |
| Terminal preview pane (inside TUI) | `components/TerminalPane.tsx` — distinct from web mirror |
| Mouse wheel / click in chat | `app.tsx` (`parseTerminalMouseInput`, `useTerminalMouseTracking`) |

## Tests to prefer

| Area | Test file |
|------|-----------|
| Input / mouse / scroll | `__tests__/appInput.test.ts` |
| Drawer | `__tests__/Drawer.test.tsx`, `drawerSelection.test.ts` |
| Chat rendering | `__tests__/ChatView.test.tsx` |
| Right pane | `__tests__/RightPane.test.tsx` |
| Header/footer | `__tests__/HeaderFooter.test.tsx` |
| Commands | `__tests__/commands.test.ts` |

Add or extend tests for layout math and pure helpers before touching large `app.tsx` branches.

## Anti-patterns

- Duplicating UI in `scripts/tui-web.mjs` or a new `webInspector.ts`
- Editing xterm theme foreground (flattens Ink ANSI colors)
- Using `[...str].length` vs wcwidth inconsistently when fixing truncation (match existing pane code)
- Changing desktop renderer for TUI-only layout issues
- Assuming browser snapshot refs map 1:1 to React components

## Additional resources

- Architecture and file map: [reference.md](reference.md)
- Product docs: `docs/features/ade-code/README.md`
- Bridge implementation: `scripts/tui-web.mjs`

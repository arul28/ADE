# ade-tui-web-preview reference

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser tab (primary)                                       │
│  xterm.js + FitAddon ←WebSocket→ scripts/tui-web.mjs       │
└───────────────────────────────┬─────────────────────────────┘
                                │ node-pty (stdin/stdout/resize)
                                ▼
┌─────────────────────────────────────────────────────────────┐
│  ade code  →  Ink render  →  ANSI/TTY                        │
│  apps/ade-cli/src/tuiClient/cli.tsx → app.tsx + components   │
└───────────────────────────────┬─────────────────────────────┘
                                │ JSON-RPC / Unix socket
                                ▼
┌─────────────────────────────────────────────────────────────┐
│  ade serve runtime (lanes, chat, PRs, …)                     │
└─────────────────────────────────────────────────────────────┘
```

## Entry points

| Path | Role |
|------|------|
| `package.json` → `dev:code:web` | Runs `node scripts/tui-web.mjs --auto` |
| `scripts/tui-web.mjs` | HTTP server, PTY spawn, WebSocket bridge, xterm vendor static files |
| `apps/ade-cli/src/tuiClient/cli.tsx` | TUI CLI entry (argv, Ink mount) |
| `apps/ade-cli/src/tuiClient/app.tsx` | Main layout, state, input, mouse, dimensions |

## tuiClient layout (high level)

`app.tsx` owns pane geometry:

- Left: drawer (`Drawer`) — lanes + chats
- Center: welcome splash or `ChatView` (+ palettes, approvals)
- Right: `RightPane` — lane details, diff, chat-info, help, forms
- Top: `Header`
- Bottom: `FooterControls`, `ModelStatus`

Constants near top of `app.tsx`: `DRAWER_PANE_WIDTH`, `MIN_CENTER_PANE_WIDTH`, `MIN_RIGHT_PANE_WIDTH`, `RIGHT_PANE_MAX_WIDTH`.

Terminal hooks in `app.tsx`:

- `useTerminalDimensions()` — `stdout.columns` / `rows`, resize listener
- `useTerminalAlternateScroll()` — `\x1b[?1007h/l`
- `useTerminalMouseTracking()` — SGR mouse when TTY + `ADE_TUI_MOUSE` enabled
- `parseTerminalMouseInput()` — decodes mouse events from stdin

## Web bridge behavior (`tui-web.mjs`)

| Concern | Implementation |
|---------|----------------|
| Spawn | `node-pty.spawn(node, [cliPath, code, ...], { cwd: workspaceRoot })` |
| Output | `shell.onData` → binary WebSocket to all clients |
| Input | Primary client JSON `{ type: "stdin", data }` → `shell.write` |
| Resize | Primary FitAddon → JSON `{ type: "resize", cols, rows }` → `shell.resize` + broadcast `sync_resize` |
| Roles | Latest connected tab = primary (keyboard + resize); others view-only |
| Colors | Do not set xterm `theme.foreground`; PTY env `FORCE_COLOR=3`, `COLORTERM=truecolor` |
| Vendor | Serves `@xterm/xterm` and `@xterm/addon-fit` from `apps/ade-cli/node_modules` |

## Shared types with desktop

TUI imports shared DTOs from `apps/desktop/src/shared/types/` — keep IPC contracts, preload types, shared types, and TUI usage aligned when changing interfaces.

## Verification commands

```bash
npm --prefix apps/ade-cli run typecheck
npm --prefix apps/ade-cli run test
# single file:
npm --prefix apps/ade-cli exec vitest run src/tuiClient/__tests__/ChatView.test.tsx
```

Restart web mirror after build:

```bash
npm run dev:code:web -- --attach --skip-runtime-build \
  --socket ~/.ade/sock/ade.sock \
  --project-root "$PWD" \
  --workspace-root "$PWD"
```

## Docs

- `docs/features/ade-code/README.md` — full source file map
- `apps/ade-cli/README.md` — CLI usage + browser mirror note

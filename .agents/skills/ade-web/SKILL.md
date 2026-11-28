---
name: ade-web
description: >-
  Launch the DAEX desktop app's renderer as a standalone web app (Vite-only preview)
  seeded with real data from the DAEX database. Works from any lane worktree without
  interfering with running DAEX sockets or runtimes. Use when asked to start, run, or
  preview the DAEX desktop web renderer, open the DAEX web app, or view DAEX UI in a browser.
metadata:
  author: DAEX
  version: 0.1.0
---

# ade-web — Launch the DAEX Desktop Web Renderer

Starts the DAEX desktop renderer as a browser-accessible web app on `http://localhost:5173`,
seeded with a snapshot of the real DAEX database. Safe to run alongside DAEX Beta or
any other running DAEX runtime — it does **not** touch sockets or start new runtimes.

## When to use

- User asks to run, start, preview, or open the DAEX web app / desktop web renderer
- User wants to visually inspect or iterate on DAEX desktop UI changes in a browser
- User asks to launch DAEX web from a specific lane or worktree

## Procedure

### 1. Resolve the workspace root

The web renderer must run from the **current lane's worktree**, not the main project checkout.

```
WORKTREE_ROOT="$(pwd)"
```

If `pwd` is not already inside `.ade/worktrees/<lane>/`, resolve it:

```
# If inside a worktree, pwd is already correct.
# If at the project root, there is no lane context — ask the user which lane.
```

Confirm the desktop app exists at `$WORKTREE_ROOT/apps/desktop/package.json`.

### 2. Kill any stale Vite on port 5173

```bash
lsof -ti :5173 2>/dev/null | xargs kill 2>/dev/null
```

Do **not** kill processes on any other port. Do **not** touch DAEX runtime sockets
(`/tmp/ade-runtime-dev.sock`, `~/.ade-beta/sock/ade.sock`, etc.).

### 3. Seed the database snapshot

Export real data from the project database (`.ade/ade.db`) into the browser mock:

```bash
cd "$WORKTREE_ROOT/apps/desktop" && node ./scripts/export-browser-mock-ade-snapshot.mjs
```

This reads `.ade/ade.db` from the primary project root (auto-detected even from worktrees)
and writes `src/renderer/browser-mock-ade-snapshot.generated.json`.

If this fails with "No database", the user hasn't opened the project in DAEX desktop yet.
The renderer will still work with built-in demo data.

### 4. Start the Vite dev server

```bash
cd "$WORKTREE_ROOT/apps/desktop" && npm run dev:vite
```

This runs `vite --port 5173 --strictPort`. The `predev:vite` hook re-exports the
snapshot automatically, so step 3 is optional if you go straight here.

Wait for the `VITE ready` message confirming it's listening.

### 5. Open in the DAEX browser (optional)

If the user wants it in DAEX's built-in browser:

```bash
daex actions run built_in_browser createTab --socket --text --arg url=http://localhost:5173/work
```

Or navigate an existing tab:

```bash
daex actions run built_in_browser navigate --socket --text --arg url=http://localhost:5173/work
```

Use `--socket` to communicate with the running DAEX instance. This does **not** start a
new runtime or interfere with the existing socket.

## Important constraints

- **Never start a runtime or bridge.** Do not run `dev:vite:live`, `dev:browser-bridge`,
  or `ensureRuntime`. These may detect version mismatches and restart the user's running
  DAEX Beta or dev runtime.
- **Never start or manage the DAEX socket directly.** The Vite-only preview uses
  `browserMock.ts` to stub `window.ade` — it does not need a runtime connection.
  The `--socket` flag on `daex actions run` above is fine; it connects to the
  running desktop instance rather than managing the socket itself.
- **Always run from the worktree.** All `cd` commands, file reads, and file edits must
  target paths under `$WORKTREE_ROOT`, never the main project checkout. When `grep` or
  `find` returns absolute paths rooted at the main checkout, translate them to the
  worktree before editing.
- **Port 5173 only.** Do not change the port. The desktop app's Vite config uses
  `--strictPort` so it will error if the port is taken rather than silently picking another.

## Cleanup

When done, kill the Vite server:

```bash
lsof -ti :5173 2>/dev/null | xargs kill 2>/dev/null
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Port 5173 is already in use` | Kill the stale process: `lsof -ti :5173 \| xargs kill` |
| `No database at ...` | Run `export-browser-mock-ade-snapshot.mjs` with `ADE_PROJECT_ROOT=/path/to/ADE` pointing at the main checkout |
| `ERR_CONNECTION_REFUSED` in DAEX browser | Vite died — restart with `npm run dev:vite` from the worktree |
| Mock data instead of real data | Re-run the export script, then restart Vite or hard-refresh the browser |
| `proxy error: /health ECONNREFUSED 127.0.0.1:18765` | Expected — this is the browser bridge port. Vite-only mode doesn't use it. Ignore. |

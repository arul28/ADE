# ADE Desktop

Electron client for ADE. The renderer is also runnable in a regular browser for fast UI iteration.

## Surfaces

| Surface | Command | `window.ade` source | Backend |
|--------|---------|---------------------|---------|
| **Desktop dev** | `npm run dev` (repo root) | Electron preload → main IPC → ADE runtime endpoint | Full |
| **Browser preview (mock)** | `npm run dev:vite` | `browserMock.ts` only | Synthetic demo data |
| **Browser preview (live)** | `npm run dev:vite:live` | Mock + runtime bridge patches | Partial live (see below) |

`apps/web` is the public marketing site. This document covers the **desktop renderer in a browser** (`localhost:5173`), not the marketing app.

## How the browser preview works

Opening `http://localhost:5173` without Electron loads the same React renderer as the desktop app, but there is no preload bridge. On startup:

1. **`browserMock.ts`** (imported first in `main.tsx`) installs a full `window.ade` stub so the UI can render without crashing. It returns built-in demo data for PRs, lanes, sessions, git, and so on.
2. **`attachBrowserRuntimeBridge()`** (called at the end of the mock install) probes `GET /ade-dev-rpc/health`. If the browser runtime bridge is running, it **patches** selected methods on top of the mock and dispatches `ade:runtime-bridge-ready`.

```text
Browser tab
  └─ window.ade (mock baseline)
       └─ patched methods → fetch /ade-dev-rpc/*
            └─ Vite proxy
                 └─ browser-runtime-bridge.mjs (127.0.0.1:18765)
                      └─ JSON-RPC → /tmp/ade-runtime-dev.sock
                           └─ ade serve (same dev runtime as desktop dev)
```

The mock stays the fallback for everything the bridge does not override. UI work that only reads mock data still works with `dev:vite` alone.

## Launch

> This section covers the **browser preview** of the renderer. For the full
> Electron app, use `npm run dev` from the repo root — or, to run a specific lane
> build in isolation (its own runtime + bridge endpoints), see
> [Run a specific lane worktree](../../README.md#run-a-specific-lane-worktree) in
> the root README. Do not aim `dev:desktop --socket` at a runtime you do not want
> `--auto` to shut down (e.g. the production `~/.ade/sock/ade.sock`).

### Mock-only (fast UI shell)

From `apps/desktop`:

```bash
npm run dev:vite
```

Optional: export SQLite snapshot so lanes, PRs, sessions, and run-tab config mirror a real project:

```bash
ADE_PROJECT_ROOT=/path/to/your/project npm run export:browser-mock-ade
npm run dev:vite
```

The export runs automatically (best-effort) before `dev:vite` via `predev:vite`. Output:

`src/renderer/browser-mock-ade-snapshot.generated.json`

That file is gitignored. It seeds **read-only** mock data from `.ade/ade.db` at export time. It does **not** include secrets (Linear tokens, API keys).

### Live bridge (real Linear, sync, lanes)

From `apps/desktop`:

```bash
ADE_PROJECT_ROOT=/path/to/your/project npm run dev:vite:live
```

This script:

1. Builds/refreshes the ADE CLI runtime if needed
2. Ensures the dev runtime is listening on `/tmp/ade-runtime-dev.sock` (override with `ADE_DEV_RUNTIME_SOCKET_PATH`)
3. Starts `browser-runtime-bridge.mjs` on `127.0.0.1:18765` (`ADE_BROWSER_BRIDGE_PORT` to override)
4. Starts Vite on port 5173 with a proxy from `/ade-dev-rpc` → the bridge

Open `http://localhost:5173` (or `http://127.0.0.1:5173`).

**Lane worktrees:** if you run from `.ade/worktrees/<lane>`, set `ADE_PROJECT_ROOT` to the primary project checkout (where `.ade/ade.db` and secrets live), not the worktree path. Same rule as `npm run dev`.

Skip runtime rebuild when the CLI is already fresh:

```bash
ADE_PROJECT_ROOT=/path/to/your/project npm run dev:vite:live -- --skip-runtime-build
```

Bridge only (Vite already running):

```bash
ADE_PROJECT_ROOT=/path/to/your/project npm run dev:browser-bridge
```

Verify the bridge:

```bash
curl -s http://127.0.0.1:18765/health | jq .
```

## What the live bridge covers today

When the bridge attaches, these `window.ade` methods call the real runtime instead of the mock:

| Area | Methods |
|------|---------|
| **Project** | `app.getProject`, `app.getWindowSession` — real `projectRoot` / `projectId` from `projects.add` |
| **Linear** | `cto.getLinearConnectionStatus`, `getLinearQuickView`, `getLinearIssuePickerData`, `searchLinearIssues`, `getLinearProjects`, `setLinearToken`, `clearLinearToken` |
| **Sync / mobile** | `sync.getStatus`, `refreshDiscovery`, `listDevices`, `updateLocalDevice`, `connectToBrain`, `disconnectFromBrain`, `forgetDevice`, `getTransferReadiness`, `transferBrainToLocal`, `getPin`, `setPin`, `generatePin`, `clearPin` |
| **Lanes** | `lanes.create`, `lanes.list` (e.g. Linear quick view → create lane) |

The `connectToBrain`, `disconnectFromBrain`, and `transferBrainToLocal`
method names are legacy wire/API names; prose should call these runtime
connection, runtime disconnection, and sync authority transfer.

Linear must already be connected in that project (Settings → Linear, or token in encrypted store under `.ade/secrets`). The bridge uses the same credentials as desktop dev.

## Still mock-only in the browser

Even with `dev:vite:live`, these stay on the mock until wired to the bridge or another backend:

- Terminals / PTY / live chat sessions
- PR list/detail/actions, git read/write, files on disk
- Remote runtime connection UI (Electron IPC)
- Computer use, App Control, iOS simulator
- Agent chat send/receive, orchestration runs
- Most settings persistence beyond Linear token via bridge

For full product behavior, use **`npm run dev`** (Electron + preload).

## Seeding mock data

Three layers, from lightest to richest:

1. **Built-in demo** — no setup; synthetic lanes, PRs, sessions in `browserMock.ts`.
2. **Snapshot export** — `npm run export:browser-mock-ade` with `ADE_PROJECT_ROOT` set; replaces demo rows with data from `.ade/ade.db` and optional disk walks for the Files tab.
3. **Live bridge** — real runtime for Linear, sync, and lane create/list; mock still backs everything else unless you also export a snapshot for read-only parity.

Re-export the snapshot after local DB changes you want reflected in mock-only mode:

```bash
ADE_PROJECT_ROOT=/path/to/your/project npm run export:browser-mock-ade
```

## Environment variables

| Variable | Purpose |
|----------|---------|
| `ADE_PROJECT_ROOT` | Project opened by the bridge and snapshot export (primary checkout, not lane worktree) |
| `ADE_DEV_RUNTIME_SOCKET_PATH` | Dev runtime endpoint path (default `/tmp/ade-runtime-dev.sock`) |
| `ADE_BROWSER_BRIDGE_PORT` | Bridge HTTP port (default `18765`) |

## Related files

| File | Role |
|------|------|
| `src/renderer/browserMock.ts` | Full `window.ade` stub for browser |
| `src/renderer/browserRuntimeBridge.ts` | Patches live methods when bridge is up |
| `scripts/browser-runtime-bridge.mjs` | HTTP → runtime JSON-RPC |
| `scripts/dev-vite-live.mjs` | Orchestrates runtime + bridge + Vite |
| `scripts/export-browser-mock-ade-snapshot.mjs` | SQLite → mock snapshot JSON |
| `vite.config.ts` | Proxies `/ade-dev-rpc` to the bridge |

## Validation

```bash
npm run typecheck
npm run test:unit -- src/renderer/components/app/TopBar.test.tsx
```

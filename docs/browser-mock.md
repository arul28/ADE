# Browser mock (Vite without Electron)

ADE’s renderer is built for Electron: `window.ade` comes from the preload bridge. When you open the Vite dev URL in a **normal browser** (Chrome, Safari, Edge) or in **Cursor’s Simple Browser**, there is no main process, so the app injects a **browser mock** (`src/renderer/browserMock.ts`) that returns safe defaults for every IPC-shaped API so the UI can load.

## Run the site without Electron (Vite only)

From `apps/desktop`:

```bash
npm run dev:vite
```

Open **http://localhost:5173/**. The console will log that the browser mock is active.

`dev:vite` refreshes the local browser snapshot first, using the nearest project root with `.ade/ade.db` (or `ADE_PROJECT_ROOT` when set). If no ADE database exists, Vite still starts and the mock falls back to built-in demo data.

The full dev launcher (Vite + main-process watch + Electron) is:

```bash
npm run dev
```

## Routing in the browser

On `http://localhost:5173` the app uses **path-based** routing (`/work`, `/graph`, …). The embedded Cursor browser and normal browsers share the same behavior. Hash-based routing is reserved for non-`http(s)` loads (e.g. packaged `file://`).

## Vite HMR and the mock

The mock reapplies on hot reload so `window.ade` is not left half-initialized. If you see “missing” APIs after a long session, do a full page reload.

## Use real project rows from your local `.ade` database

The mock’s default data is **demonstration data**. To mirror the **current** local ADE SQLite state (same source the desktop app uses), generate a local snapshot the mock can read:

1. Open the project in ADE (Electron) at least once so `.ade/ade.db` exists, **or** point at a project root that already has `.ade/ade.db`.
2. From `apps/desktop` run:

   ```bash
   ADE_PROJECT_ROOT=/path/to/your/repo npm run export:browser-mock-ade
   ```

   Or pass the path as the first argument:

   ```bash
   node ./scripts/export-browser-mock-ade-snapshot.mjs /path/to/your/repo
   ```

3. The script writes:

   `apps/desktop/src/renderer/browser-mock-ade-snapshot.generated.json`

   (gitignored). Restart Vite or hard-refresh the browser.

4. **While that file exists**, the browser mock prefers exported DB-backed rows and uses built-in demo data only for domains that were not exported. Delete the generated file to restore the full built-in demos.

**Scope:** The export covers project metadata, lanes, lane status snapshots, PR summaries and cached PR detail snapshots, queue landing state, integration workflow rows, rebase signals, history operations, terminal sessions, chat transcript event histories, process definitions/runtime, automation run/ingress history, CTO memory state, usage summaries, and mission summaries when those tables have rows.

It is still a static browser snapshot, not a main-process replacement. Actions that need GitHub, git, PTYs, file contents, live process control, computer use, or fresh backend computation are no-ops or safe defaults. Re-run `npm run dev:vite` or `npm run export:browser-mock-ade` after the desktop app changes the database.

## Known dev-only issues

- **Vite HMR** can log `send was called before connect` in the console; the app filters harmless cases in `main.tsx` in development.
- **WebSocket** warnings (e.g. “closed due to suspension”) can appear if the editor **backgrounds** the tab; that is the host throttling the page, not ADE logic.
- **Computer-use / proof** UI expects snapshots with an `artifacts` array; the mock uses optional chaining so partial snapshots do not crash.

## Related

- `AGENTS.md` — project norms and validation commands
- `apps/desktop/scripts/export-browser-mock-ade-snapshot.mjs` — export implementation

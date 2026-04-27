# Browser mock (Vite without Electron)

ADE’s renderer is built for Electron: `window.ade` comes from the preload bridge. When you open the Vite dev URL in a **normal browser** (Chrome, Safari, Edge) or in **Cursor’s Simple Browser**, there is no main process, so the app injects a **browser mock** (`src/renderer/browserMock.ts`) that returns safe defaults for every IPC-shaped API so the UI can load.

## Run the site without Electron (Vite only)

From `apps/desktop`:

```bash
npm run dev:vite
```

Open **http://localhost:5173/**. The console will log that the browser mock is active.

The full dev launcher (Vite + main-process watch + Electron) is:

```bash
npm run dev
```

## Routing in the browser

On `http://localhost:5173` the app uses **path-based** routing (`/work`, `/graph`, …). The embedded Cursor browser and normal browsers share the same behavior. Hash-based routing is reserved for non-`http(s)` loads (e.g. packaged `file://`).

## Vite HMR and the mock

The mock reapplies on hot reload so `window.ade` is not left half-initialized. If you see “missing” APIs after a long session, do a full page reload.

## Use real project + lane rows from your local `.ade` database

The mock’s default lanes/PRs are **demonstration data**. To mirror the **current** `projects` and `lanes` tables from **your** repo’s SQLite (same data shape the desktop app uses), generate a local snapshot the mock can read:

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

4. **While that file exists**, inline PR/queue/rebase **demo** data in the mock is **disabled** so lane IDs stay consistent. Delete the generated file to restore the full built-in PR demos.

**Scope:** The export covers **project metadata** and **lanes** (and lane status snapshots when present). It does not replace every domain (missions, real PRs, file contents, etc.)—use the **Electron** app for full backend fidelity.

## Known dev-only issues

- **Vite HMR** can log `send was called before connect` in the console; the app filters harmless cases in `main.tsx` in development.
- **WebSocket** warnings (e.g. “closed due to suspension”) can appear if the editor **backgrounds** the tab; that is the host throttling the page, not ADE logic.
- **Computer-use / proof** UI expects snapshots with an `artifacts` array; the mock uses optional chaining so partial snapshots do not crash.

## Related

- `AGENTS.md` — project norms and validation commands
- `apps/desktop/scripts/export-browser-mock-ade-snapshot.mjs` — export implementation

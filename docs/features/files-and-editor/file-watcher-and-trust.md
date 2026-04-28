# File Watcher and Trust Boundary

Detail reference for the main-process file services — how filesystem
access is gated, how `chokidar` is shared across subscriptions, and
how external changes propagate to open editor tabs without racing
against user edits.

## Trust boundary

The file services run exclusively in the main process. The renderer
has no direct `node:fs` or `node:path` access (those come from the
node runtime, not Electron). All filesystem operations go through:

1. `window.ade.files.*` from the preload bridge
   (`apps/desktop/src/preload/preload.ts`)
2. `ade.files.*` IPC channels registered in
   `apps/desktop/src/main/services/ipc/registerIpc.ts`
3. `fileService` methods, which:
   - resolve every path against the workspace root via
     `resolvePathWithinRoot`
   - refuse any path that contains `.git` at any segment
     (`containsDotGit`)
   - refuse null-byte injections via `hasNullByte`
   - refuse paths that are not inside the workspace root after
     normalization

The renderer never sees an absolute host path until the main process
has validated it. `FileContent.languageId` is a Monaco hint; it is
derived from the extension by `languageIdFromPath`, not from any path
metadata.

### Path safety invariants

`apps/desktop/src/main/services/shared/utils.ts` provides the
primitives:

- `resolvePathWithinRoot(rootPath, candidate, { allowMissing? })` —
  throws `Path escapes root` if the resolved path is not inside the
  root; optionally permits missing targets (used for create flows).
- `secureWriteTextAtomicWithinRoot(rootPath, relPath, text)` — atomic
  write via temp file + rename, guarded by the same resolution.
- `secureWriteFileWithinRoot(rootPath, relPath, buffer, encoding)` —
  non-atomic variant.
- `secureRenameWithinRoot(rootPath, oldRel, newRel)` — both old and
  new paths must be inside the root.
- `secureMkdirWithinRoot(rootPath, relPath)` — recursive mkdir, same
  gating.

These are the only APIs `fileService` uses for mutations. Any new
file-writing feature should go through the same primitives.

### Always-ignored paths

`isAlwaysIgnoredPath` rejects reads/writes against:

- `.git/` or `.git`
- `node_modules/`
- `.ade/`

Even with `includeIgnored: true` the watcher filters volatile ADE
subpaths so background rewrites do not spam the renderer (see below).

## Watcher service

File: `apps/desktop/src/main/services/files/fileWatcherService.ts`

Each subscription is keyed by `workspaceId + senderId`. A subscription
has:

```ts
type WatchSubscription = {
  watcher: FSWatcher | null;
  workspaceId: string;
  senderId: number;
  rootPath: string;
  callback: WatchCallback;
  includeIgnored: boolean;
  defaultRefCount: number;
  includeIgnoredRefCount: number;
};
```

### Ref counting

Two counters because two callers can share the watcher with different
ignore profiles:

- `defaultRefCount` — callers using `includeIgnored: false`
- `includeIgnoredRefCount` — callers using `includeIgnored: true`

`watch(args)` increments the appropriate counter. If the resulting
effective `includeIgnored` state differs from the watcher's current
state, the watcher is closed and restarted with the new ignore glob.

`unwatch(args)` decrements. When both counters are zero, the watcher
is not closed immediately — instead, an idle timer fires
(`IDLE_WATCHER_CLOSE_MS = 15_000`) and closes it only if it is still
idle. This avoids churn when the user briefly toggles views.

`stopAllForSender(senderId)` fires on window close and tears down
every subscription owned by that sender.

### Event shape and debounce

Chokidar emits per-file events (`add`, `change`, `unlink`, plus
`addDir`, `unlinkDir`). `mapEventType` collapses them to:

- `created` (`add`, `addDir`)
- `modified` (`change`)
- `deleted` (`unlink`, `unlinkDir`)

Each event is keyed by relative path and debounced for `EVENT_DEBOUNCE_MS =
140 ms` — if the same file changes again within the window, the
pending timer is reset. When the timer fires, a single `FileChangeEvent`
is emitted to the callback.

### Volatile path filter

Even in `includeIgnored` mode, these paths are always filtered to
avoid ADE watching its own transcripts and cache:

- `.ade/artifacts/`
- `.ade/cache/`
- `.ade/agent-configs/`
- `.ade/secrets/`
- `.ade/transcripts/`
- `.ade/ade.db` (and SQLite's `-wal`/`-shm` sidecars via prefix match)
- `.ade/ade.sock`

These are defined in `VOLATILE_ADE_PREFIXES` and
`VOLATILE_ADE_EXACT_PATHS`.

### Renamed detection

Chokidar does not natively emit a single `rename` event; it emits
`unlink` followed by `add`. The file service does not try to correlate
them — both events go through and the renderer handles reconciliation
on its side.

## File search index

File: `apps/desktop/src/main/services/files/fileSearchIndexService.ts`

In-memory flat list of relative paths, keyed per workspace per mode:

- `<workspaceId>::default` — excludes `.git/`, `node_modules/`, `.ade/`
- `<workspaceId>::all` — includes ignored paths

Built lazily on first quick-open or search call, then kept in sync
with the watcher:

- `add` / `addDir` → push
- `unlink` → remove matching entry
- `unlinkDir` → remove all entries under the prefix
- Mass invalidation resets the index and triggers a full rebuild on
  next query

The index has a soft cap on entries (workspaces over the cap fall
back to on-demand glob scanning).

Quick open scoring lives in `fileService.quickOpen` via a
`fuzzy-like` match (not an external library — a local implementation
tuned for path segments).

Cross-file search (`fileService.searchText`) prefers `ripgrep` if
available via `rg`, otherwise falls back to a node-side line scanner.
Output is streamed; the `limit` parameter caps the number of returned
matches.

## External change sync

The renderer's `FilesPage.tsx` subscribes to `ade.files.change` and
handles events like this:

1. **Lookup open tabs by path.** Each open Monaco editor tracks its
   relative path.
2. **Dirty tabs stay dirty.** If a tab has unsaved edits, the event is
   recorded in tab metadata but the content is not replaced. The user
   sees a "file changed on disk" indicator.
3. **Clean tabs reload.** The main process re-reads the file via
   `fileService.readFile` and the Monaco model is updated. Scroll
   position and selection are preserved when possible.
4. **File tree refresh.** Events enqueue a scoped tree refresh for the
   parent directory. A queue cap (`MAX_QUEUED_TREE_PARENT_REFRESHES =
   24`) forces a full tree refresh when bulk operations exceed the
   cap (e.g. `git checkout` touches hundreds of files at once).

Rename detection on the renderer side: because watcher events come as
`unlink` + `add`, renames surface as a tab close + a new tab path. The
renderer inspects the modified timestamp and file size to correlate
them when possible.

## IPC surface (main-process handlers)

All registered in `registerIpc.ts`:

| Channel | Handler behavior |
|---|---|
| `ade.files.listWorkspaces` | calls `laneService.getFilesWorkspaces`, sorts primary first |
| `ade.files.listTree` | resolves workspace, optionally lazy per `parentPath`/`depth`, returns `FileTreeNode[]` |
| `ade.files.readFile` | atomic read up to `MAX_EDITOR_READ_BYTES = 5 MB`, detects binary, picks `languageId` |
| `ade.files.writeTextAtomic` | temp file + rename |
| `ade.files.writeText` | plain write |
| `ade.files.createFile` | throws if exists, otherwise writes empty or provided content |
| `ade.files.createDirectory` | recursive mkdir |
| `ade.files.rename` | enforces both paths in root |
| `ade.files.delete` | recursive rm, rejects root itself |
| `ade.files.watchChanges` | increments watcher ref count, sends events via `ade.files.change` |
| `ade.files.stopWatching` | decrements ref count |
| `ade.files.quickOpen` | uses search index |
| `ade.files.searchText` | uses ripgrep/fallback scanner |

`onLaneWorktreeMutation` is an optional callback passed to
`createFileService`. It fires when the user mutates a lane worktree
so other services (lane manager, search index, and editor surfaces) can invalidate
their caches.

## Gotchas

- **Ignore caches.** The service maintains a `git check-ignore` cache
  (`ignoreCache`, `ignoredPrefixCache`) keyed by `rootPath::relPath`.
  It is invalidated by `clearIgnoreCacheForRoot` when the watcher
  reports a change that might affect gitignore rules.
- **Git status cache TTL.** Tree listings reuse the porcelain status
  for 5 seconds (`GIT_STATUS_CACHE_TTL_MS`). If you need a fresh
  status immediately after a git op, call `invalidateGitStatusCache`.
- **Watcher restart on mode change.** Adding a subscription with a
  different `includeIgnored` value than the current effective mode
  tears down the chokidar instance. Rapid toggling will churn — the
  renderer throttles toggle frequency.
- **Large repositories.** The initial `git check-ignore` batch is
  bounded by a `7_000 ms` timeout; timeouts fall back to "not
  ignored", which can briefly surface ignored files in the tree.
- **Cross-platform newlines.** The file service writes whatever the
  renderer sent. It does not normalize line endings.

## Cross-links

- Editor surfaces and how they react to events:
  [editor-surfaces.md](./editor-surfaces.md)
- Lane workspace list:
  `apps/desktop/src/main/services/lanes/laneService.ts`
  (`getFilesWorkspaces`, `resolveWorkspaceById`)
- Secure IPC primitives:
  `apps/desktop/src/main/services/shared/utils.ts`

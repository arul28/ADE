# File Watcher and Trust Boundary

How filesystem access is gated, how one watcher is shared across
subscriptions, and how external changes reach open tabs without racing user
edits. The file services run in the window's active runtime (local or remote);
desktop main hosts the same code only for the legacy IPC fallback. A remote
window does every read, write, watch and index update on the remote machine.

## Trust boundary

The renderer never touches `node:fs` or `node:path`. Every filesystem
operation goes through:

1. `window.ade.files.*` (`apps/desktop/src/preload/preload.ts`): the remote runtime, then the strict local-runtime route; in-process IPC only when no runtime route exists, never after a bound runtime rejects. An optional trailing machine pin names one machine and has no IPC fallback. `external-local:*` workspaces always go to local IPC and drop a pin, since their root exists only on this disk.
2. The `ade.files.*` IPC handlers in `registerIpc.ts` (fallback only).
3. `fileService`, which resolves every path with `resolvePathWithinRoot` and refuses `.git` segments (`containsDotGit`), null bytes (`hasNullByte`) and anything outside the root after normalization.

`FileContent.languageId` is derived from the extension (`languageIdFromPath`).

External local opens go through `externalFilesWorkspaceRegistry.ts`: only
absolute paths the user opened from the OS or dropped in, canonicalized with
`realpath`, exposed as ephemeral `external` workspaces. A path inside a known
workspace returns that workspace instead.

### Path safety primitives

`apps/desktop/src/main/services/shared/utils.ts`: `resolvePathWithinRoot`
(throws `Path escapes root`; `allowMissing` for creates),
`secureWriteAtomicWithinRoot` (temp file + rename), `secureWriteFileWithinRoot`,
`secureRenameWithinRoot` (both paths inside), `secureMkdirWithinRoot`. These are
the only mutation APIs `fileService` uses; new file-writing features must use
them too.

`isAlwaysIgnoredPath` (`.git`, `node_modules/`, `.ade/`) marks what the
default listing and search skip; `includeIgnored` shows them, except `.git`
and the volatile `.ade` paths below.

## Watcher service

`apps/desktop/src/main/services/files/fileWatcherService.ts`. One
subscription per `workspaceId + senderId`, with two counters:
`defaultRefCount` (`includeIgnored: false`) and `includeIgnoredRefCount`.
When the effective mode changes, the watcher restarts with the new ignore
glob. At zero references an idle timer (`IDLE_WATCHER_CLOSE_MS`, 15 s) closes
it, avoiding churn on quick view toggles.

The watcher is `watchTree` (`services/shared/treeWatcher.ts`): chokidar on
Linux, one recursive native watch per root on macOS and Windows (the event says
where to look; the path is re-read and compared with a snapshot). On Windows a
nameless event re-reads the whole tree and the root's parent is watched so a
recreated root is picked up again. `scripts/perf/service/tree-watcher-parity.mts`
compares the implementations.

- **Window close:** `stopAllForSender(senderId)`, only when the service runs in the desktop process.
- **Pages that vanish without cleanup:** `fileWatchLedger.ts` tracks outstanding references; the runtime bridge sends the missing stops when a page reloads, crashes or closes, and the brain does the same when a connection closes. Each is an ordinary `stopWatching`, so other clients' references are untouched.
- **A dropped connection with the page still open:** the bridge marks the entry (`notePageRuntimeDisconnected`) and reopens every held watch on the new connection (`restorePageFileWatches`).
- **Lane delete:** `stopAllForWorkspace(workspaceId)` runs in the `stop_watchers` step so handles close before `git worktree remove`; `countActiveForWorkspace` feeds the delete preflight.

Events map to `created` / `modified` / `deleted` and are debounced per path
for 140 ms (`EVENT_DEBOUNCE_MS`). Renames arrive as delete + create; the
service does not correlate them.

**Volatile paths** are filtered even with `includeIgnored`
(`VOLATILE_ADE_PREFIXES`, `VOLATILE_ADE_EXACT_PATHS`): `.ade/artifacts/`,
`cache/`, `agent-configs/`, `secrets/`, `transcripts/`, `logs/`, `tmp/`,
`runtime/`, `worktrees/`, plus `.ade/ade.db` (and its `-wal`/`-shm`) and
`.ade/ade.sock`.

## File search index

`fileSearchIndexService.ts` keeps relative paths per `<workspaceId>::default`
and `::all`, built lazily and updated from watcher events (`unlinkDir` drops a
subtree). Entries are `path`, `lowerPath`, `size`, `mtimeMs` only: the build
stats, never reads, and decoded lines would cost hundreds of megabytes. The
walk stops at `MAX_INDEXED_FILES` (25,000). In a git work tree the default
index comes from one `git ls-files -z --cached --others --exclude-standard`
(falling back to a walk for `.gitmodules`, failure or truncation);
`includeIgnored` always walks.

`quickOpen` results are cached per `(query, limit, mode)` and cleared on any
watcher change. `warmQuickOpenIndex` lets the chat composer build the index on
its first empty `@` query; the action bridge caches a chat's lane id
(`fileSearchLaneIdBySessionId`, 200 entries) for non-identity sessions only,
because the CTO can be moved to the main checkout.

Content search tiers and outcomes are described in
[README.md](./README.md#quick-open-and-content-search). `-m` needs git ≥ 2.38;
older git exits 129, which counts as `unusable`.

## External change sync

`FilesWorkbench.tsx` subscribes to `ade.files.change`:

- A clean open tab re-reads the file; a dirty tab keeps its edits.
- Tree refreshes queue per parent directory; more than 24 queued parents (`MAX_QUEUED_TREE_PARENT_REFRESHES`, e.g. a `git checkout`) forces one full refresh.
- Remote windows start their runtime event pump with `replay: false` and resume from the cursor the runtime returns, so a new Files tab sees live changes rather than old events.

The per-project session cache keeps clean text tabs up to 256 KB and dirty
tabs at any size, so unsaved edits survive lane switches.

## IPC surface

The primary route is the runtime's `file` action domain; the pin is a
preload-level argument, not a separate channel. Channels: `listWorkspaces`,
`openExternalPath`, `listTree`, `listTreeChildren`, `refreshGitDecorations`,
`readFile`, `readFileRange`, `gitBlame` (`--line-porcelain`),
`writeTextAtomic`, `writeText`, `createFile` (throws if it exists),
`createDirectory`, `rename`, `delete` (refuses the root), `watchChanges`,
`stopWatching`, `onChange` (a pinned subscription listens to that machine's
`file_change` feed and still forwards local `external-local:*` events),
`quickOpen`, `searchText`.

`createFileService`'s optional `onLaneWorktreeMutation` callback lets other
services invalidate caches after a user edit.

## Gotchas

- **Ignore cache.** `git check-ignore` answers are cached by `rootPath::relPath` and cleared by `clearIgnoreCacheForRoot` when a change may affect ignore rules. The first batch has a 7 s timeout; a timeout reads as "not ignored", so ignored files can briefly show.
- **Git status cache** is 5 s (`GIT_STATUS_CACHE_TTL_MS`); call `invalidateGitStatusCache` after a git operation that must show at once.
- **Mode toggles restart the watcher.**
- **Line endings** are written exactly as the renderer sent them.

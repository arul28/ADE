# Editor Surfaces

The renderer surfaces of the Files tab and its embedded Monaco editors. Paths
are under `apps/desktop/src/renderer/components/files/`.

## `FilesTab.tsx`

The entry for the Files route and the Work tools pane; it always renders
`FilesWorkbench`. It turns the router state a chat click leaves into one
`FilesNavigationOpenRequest`: `openFilePath`, `laneId`, `startLine` /
`startColumn`, `openPathType: "directory"` (reveal in the tree), `searchQuery`
(open search when a name matched several files) and `filesPin`. Router state is
untrusted: `filesPin` is accepted only as a complete `OpenProjectBinding`
(`local` with `displayName`; `remote` with `targetId`, `projectId`,
`runtimeName`), because the machine chip reads those unguarded.

## `v2/FilesWorkbench.tsx`

The shell: the machine pin and its bound Files API, workspace resolution, the
tree (`useFilesTree`), `FilesExplorer`, editor groups with preview and pinned
tabs, splits and drag moves, `FilesSearchPanel`, create prompts, the context
menu (open, rename, delete, copy paths and name, reveal in Finder), and the
status bar. Props: `preferredLaneId` (Work), `embedded`, `active` (gates loading
and keys for inactive project tabs), `pin`.

### Machine pin

`machinePin` is set when the files live on a machine other than the tab's (a
navigation from another machine's chat, or the Work pane's `pin`), and cleared
by **Back to this computer** or picking a bound-machine workspace. Everything
keys off `projectBinding = machinePin ?? boundProjectBinding`.

- `createPinnedFilesApi(machinePin)` (`v2/pinnedFilesApi.ts`) is cached per binding key, so its identity changes exactly when the machine does. `useFilesTree`, editor groups, `ViewerHost`, `useFileContent`, `streamFileBytes` and every viewer get it. **Viewers must use it**: a workspace id is a synced lane id, so a call to `window.ade.files` silently hits the local worktree.
- Nothing is published to the dirty-buffer map while pinned.
- Caches written under a pinned key are released on unpin in a `queueMicrotask`, after `useFilesTree` unpins the tree (`filesTreeCache` refuses to release a pinned entry). `App.tsx` cannot do this, since it never sees pin-derived keys.
- A host-supplied `pin` wins whenever its binding key changes; equal bindings rebuilt per render do not thrash the roster.

### Tree, caches and sessions

- `v2/useFilesTree.ts` owns listing, paging, expansion and decorations for one (workspace, machine), including the per-path queue that stops a watcher refresh from shrinking a window "Load more" just grew. Keep its callback identities stable: the workbench's watcher subscription keys on them.
- `v2/filesTreeCache.ts` keeps the roster and tree warm across remounts, keyed `"<bindingKey>::<projectRoot>"` (`local` or `remote:<targetId>`), so local and remote sessions of one path never mix.
- Editor state is per `filesSessionKey(projectRoot, laneId)` (`useEditorGroupsStore`), keyed by root, not binding, so tabs and dirty buffers survive a local↔remote rebind.
- **Restored-tab remap.** After every `listWorkspaces`, `store.remapTabWorkspaces` keeps tabs whose workspace still exists (and `external-local:*` tabs), remaps the rest by `laneId` (else the primary workspace), recomputes `workspaceId::path` tab ids, dedupes, and moves Monaco models with `registry.rekey` plus the dirty set and reload tokens.

### Workspaces and editability

The standalone route shows `WorkspacePicker`; embedded Files preselects the
active lane. On a computer every workspace is editable. The one read-only case
is an account-answered lane (`FilesExplorer` `readOnlyReason`; see
[README.md](./README.md#with-no-computer-awake)). Otherwise
`viewerRegistry.tabIsTextEditable` decides: code, markdown Source and CSV Source
edit when the full payload loaded; a partial streamed payload stays read-only
so a truncated buffer is never saved.

## Explorer

`FilesExplorer.tsx` renders `FileTreeNode[]`; expanding a folder pages through
`listTreeChildren` (`nextOffset`) up to a safety cap. Icons come from
`filePresentation.tsx`, colors and directory dots from git decorations. The
context menu (`v2/ContextMenu.tsx`) clamps to the viewport. The explorer owns
the search *field*; while a query is set it renders the workbench's
`searchResults` in place of the tree.

## Editor groups and Monaco

`v2/editorGroupsStore.ts` (immutable group/tab ops), `v2/EditorGroups.tsx`,
`v2/EditorGroup.tsx`, `v2/ViewerHost.tsx`. Single-click opens or reuses a
preview tab; activation, edit or save pins it.

- `monacoModelRegistry.ts` keeps one model per path; tab switches call `setModel`, preserving undo and tokenization. Dispose only on close, rename/delete, workspace switch or unmount. `registry.rekey` moves a model to a new tab id; on collision the dirty buffer wins.
- Dirty tracking uses Monaco alternative version ids. Save writes through the files bridge, updates the baseline, invalidates the content cache and refreshes decorations. Save is gated on `viewerIsEditable(viewerKind)`. The fallback save path writes only a *dirty* model (a clean parked model may be stale). ⌘S also saves a code tab shown in diff mode.
- `v2/monacoLoader.ts` defines `ade-dark` / `ade-light`, overriding only surface colors. The colors are literals because the themes are defined once inside the memoized init; keep them in step with `index.css`.

### ⌘F belongs to whoever has focus

Electron consumes ⌘F as a menu accelerator, so Monaco's own binding never
fires. `CodeViewer` claims the `find` app-menu command (`lib/appMenuCommands.ts`)
only when it is on screen (not parked or `inert`) and owns ⌘F. Every ⌘F surface
marks its root with `data-ade-find-scope`; `lib/findScope.ts` gives ⌘F to the
innermost scope around the focused element, or around the last press when
nothing has focus.

`AdeDiffViewer` has its own find bar (`useDiffFind.ts`): it searches the
`[data-line]` elements in Pierre's shadow root, highlights with
`::highlight` rules repeated in the viewer's `unsafeCSS`, and expands collapsed
lines when matches are hidden (a truncated patch cannot). `resolveDiffView`
decides what the viewer draws. `MonacoDiffView` opens Monaco's find on the
focused side.

## Viewers

`v2/viewerRegistry.ts` picks the viewer from extension and metadata; the shell
can force `diff` or `conflict`.

- `CodeViewer` (Monaco), `MarkdownViewer` (Preview↔Source; preview shows the dirty buffer when edited), `CsvViewer` (Table↔Source, Source only for a round-trippable payload).
- `ImageViewer`: fit/zoom/pan; SVG Source is read-only and the picture is drawn only through `<img>`, so SVG script never runs. TIFF/HEIC convert to JPEG on a Mac (`app.convertImageToJpeg`, `sips`), else the open-externally card.
- `MermaidViewer` (strict-mode render, keeps the last good render on error), `FontViewer` (bytes as a `FontFace`, never a URL fetch), `MediaViewer` (size-capped Blob URL), `PdfViewer`, Office viewers ([README › Office previews](./README.md#office-previews)), `DocumentViewer` (legacy Office: open in the OS default app), `LargeTextViewer`, `BinaryViewer`, `DiffViewer`.

Follow-up chunks use `readFileRange` through `ViewerProps.files` (the pinned
API), never `window.ade.files`.

## Search and create prompt

`v2/FilesSearchPanel.tsx` has two variants sharing the workbench's
`searchQuery` and `machinePin`: `sidebar` (in the explorer's results slot; keys
read a ref-backed snapshot because the field is outside the panel; stays open
after an open) and `overlay` (the modal; dismisses on open and clears the
query). The sidebar copy is suppressed while the modal is open. ⌘P and ⌘⇧F open
the modal; a content hit calls `setPendingReveal` so the next `CodeViewer` jumps
to the line. Behavior: [README › The search UI](./README.md#the-search-ui).
`v2/overlays.tsx` holds `CreatePromptModal`.

## Embedded Files in Work

`WorkSidebar` mounts `FilesTab` with `preferredLaneId`, `embedded` and
`pin={runtimePin}`: the same services and viewers, a narrower explorer, no
picker, one `WORK_TOOL_CHROME_ROW` with the breadcrumb, and monochrome file
icons (`MonochromeFileIconsContext`).

- **Below 520 px** (`EMBEDDED_SINGLE_SURFACE_PX`) it shows one surface at a time (`embeddedSurface`, `data-single-surface`), with a "Back to files" crumb. The hidden column stays mounted but `inert`, so focus claims (like ⌘F) must check `closest("[inert]")`.
- It is the only listener on `v2/filesOpenRequests.ts`: a file clicked in a chat on this machine and lane opens beside the chat. The mount that drains a request clears the hold so it cannot replay. Anything else goes to the Files tab via router state.

## Gotchas

- **External change plus dirty tab:** watcher events never overwrite unsaved models.
- **Large files** open as read-only streamed content; media has a byte cap and is handed off past it.
- **Recent files** persist per session key, bounded, and are pruned on rename, delete and tree refresh.
- Path safety is enforced by the file service and preload; renderer affordances are presentation only.

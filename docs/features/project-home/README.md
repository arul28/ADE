# Project Home

ADE's landing surface for the currently open project. Combines a
welcome/open-repo screen for fresh installs with a per-lane runtime
dashboard — managed processes, stacks, tests, and quick actions — for
loaded projects. The same surface (`RunPage`) is also the Run tab,
because "the project's home" and "the project's execution substrate"
have converged.

## Where this runs

Project metadata reads (`window.ade.project.*`), process/test
definitions, runtime queries, and command lifecycle (`start`, `stop`,
`restart`, `startStack`, `startGroup`, `getLogTail`) all flow through
`apps/desktop/src/preload/preload.ts`, which calls
`callProjectRuntimeActionIfBound("process", …)` /
`callProjectRuntimeActionOr("ade_project", …)` /
`callProjectRuntimeActionOr("ai", …)` first for the **active runtime**
(local ADE daemon for local-bound windows, SSH-attached remote runtime
for remote-bound windows) and falls through to the legacy in-process
IPC handlers when no runtime is bound. Managed processes therefore
spawn on whichever machine owns the lane's worktree: the local
machine for local bindings, the remote host for remote bindings. The
welcome screen, project icons, recent project list, project browse /
create / clone flows, and the Add Project chooser still talk to the
desktop main process directly because they precede a project binding
(no runtime is connected yet) — they live under `window.ade.project.*`
and are handled by the desktop's `projectBrowserService`,
`projectScaffoldService`, `projectDetailService`, and
`projectIconResolver`. Multi-window: each desktop window has its own
project context, so the per-lane dashboard for window A reflects
window A's binding regardless of what is open in window B.

## Source file map

Renderer:

- `apps/desktop/src/renderer/components/run/RunPage.tsx` — top-level
  page. Welcome screen + per-lane runtime dashboard (header strip,
  collapsible advanced lane drawer, group filter bar, command grid)
  in one ~1,300-line component.
- `apps/desktop/src/renderer/components/run/LaneRuntimeBar.tsx` —
  the collapsible "Advanced" drawer that surfaces the current lane's
  runtime context: health, preview, port leases, OAuth callback.
  Mounted only when the user expands the drawer (state persisted to
  `localStorage` under `ade.run.laneRuntimeBarOpen`).
- `apps/desktop/src/renderer/components/run/CommandCard.tsx` — the
  per-process card. Accepts the full `ProcessRuntime[]` for its
  `(laneId, processId)` (so concurrent/historical runs all show),
  plus the lane list, group list, selected lane, an `onSelectLane`
  callback for the per-card lane picker, and an inline log/status
  panel for each run (no separate monitor component).
- `apps/desktop/src/renderer/components/run/RunNetworkPanel.tsx` —
  drawer showing port allocations, proxy status, preview URLs.
- `apps/desktop/src/renderer/components/run/AddCommandDialog.tsx` —
  add/edit modal for processes and process groups. The advanced
  panel exposes existing group chips plus a "new groups, comma
  separated" input that materializes new `ProcessGroupDefinition`
  entries on save.
- `apps/desktop/src/renderer/components/run/QuickRunMenu.tsx` —
  compact quick-launch menu from the command palette.
- `apps/desktop/src/renderer/components/run/processUtils.ts` —
  helpers for status aggregation, restart policy labels, etc.

Related pages for the broader "home" experience:

- `apps/desktop/src/renderer/components/app/App.tsx` — project tab host,
  binding-scoped route keep-alive, built-in browser view hiding/reveal routing,
  and cold-switch transition veil. The shell keys surfaces by runtime binding
  so a remote project and local project with the same root path keep separate
  stores. Its shared local/remote LRU keeps the eight most recently used
  project surfaces mounted; inactive surfaces are inert and animation-paused,
  and an older open surface snapshots its scoped state before unmounting so it
  can be restored when revisited.
- `apps/desktop/src/renderer/state/appStore.ts` — shared project-tab
  state. Warm project switches restore cached project/lane snapshots and
  lane selection immediately. Local state uses the project root as its key;
  remote state uses the full binding key (`remote:<targetId>:<projectId>`) so
  identical paths on different machines cannot share Work, lane, session, or
  layout state. Remote opens keep cached state visible while refreshing, a
  failed reconnect leaves the existing surface intact, and explicit tab close
  or target disconnect evicts only the affected binding.
- `apps/desktop/src/renderer/components/app/TopBar.tsx` and
  `projectRouteStorage.ts` — own remote-tab close/disconnect transitions and
  binding-scoped route memory. Closing the active remote tab switches to a
  valid fallback first; only a successful switch removes that tab's cached
  state and stored route, so a failed fallback does not destroy the surface.
- `apps/desktop/src/renderer/components/app/AppShell.tsx` — top-level
  nav, routes `/run` to `RunPage`, and mounts project-transition errors below
  the TopBar where long messages can wrap without displacing header controls.
- `apps/desktop/src/renderer/components/app/ProjectTransitionErrorAlert.tsx` —
  dismissible, full-width alert for failed project open / switch / close
  operations. It hides while another project transition is active and preserves
  the complete error text with wrapping instead of truncation.
- `apps/desktop/src/renderer/components/app/CommandPalette.tsx` —
  keyboard-first project browser and create/clone/open flows used by the
  welcome screen and global command palette.
- `apps/desktop/src/renderer/components/projects/WorktreeOpenDialog.tsx` —
  interstitial shown when an in-app open targets an external linked git
  worktree (driven by `appStore.worktreeOpenPrompt`, mounted in
  `AppShell`). Offers the recommended lane action plus the
  open-as-separate-project escape hatch.
- `apps/desktop/src/renderer/components/projects/MergeWorktreeProjectDialog.tsx`
  — merges a legacy worktree-opened-as-project recents row into its owning
  project (attach as lane + `forgetRecent`), opened from the merge
  affordance on badged welcome recents rows.
- `apps/desktop/src/renderer/components/projects/worktreeLaneFlow.ts` —
  shared open-worktree-as-lane flow (`openWorktreeAsLane`,
  `deriveLaneName`) used by both dialogs, including the
  `lane_already_linked` coded-error recovery path.
- `apps/desktop/src/renderer/components/projects/WorktreeBadge.tsx` —
  "worktree of X" accent badge rendered on welcome recents rows, palette
  browse rows (compact), and the browse preview pane.
- `apps/desktop/src/renderer/components/app/ReadmeMarkdown.tsx` —
  sanitized README preview renderer for the project browser. It preserves
  common README alignment markup but renders image sources as alt text so
  browsing a folder does not make passive network or data-URL loads.
- `apps/desktop/src/renderer/lib/iconAccent.ts` — derives balanced accent
  colors from project icons for welcome rows and project tabs.
- `apps/desktop/src/renderer/components/app/TabNav.tsx` — nav rail
  where the Run tab is pinned.
- `apps/desktop/src/renderer/components/onboarding/ProjectSetupPage.tsx`
  — first-run wizard that a new project must pass through before
  `RunPage` becomes meaningful. See
  [../onboarding-and-settings/first-run.md](../onboarding-and-settings/first-run.md).

Backing services. The canonical lifecycle services run inside the
**active runtime** (local machine runtime or SSH-attached remote runtime); the
desktop main process keeps the same files as fallback targets for the
in-process IPC path. The pre-binding scaffold services
(`projectBrowserService`, `projectScaffoldService`,
`projectDetailService`, `projectIconResolver`) only run in the desktop
main process because they execute before a runtime binding exists.

- `apps/desktop/src/main/services/processes/processService.ts` —
  lifecycle, readiness, restart. See
  [../terminals-and-sessions/pty-and-processes.md](../terminals-and-sessions/pty-and-processes.md).
- `apps/desktop/src/main/services/config/projectConfigService.ts` —
  config read/merge/save for `.ade/ade.yaml` + `.ade/local.yaml`.
- `apps/desktop/src/main/services/lanes/portAllocationService.ts` —
  per-lane port leases.
- `apps/desktop/src/main/services/lanes/laneProxyService.ts` —
  hostname proxy routing and preview URL management.
- `apps/desktop/src/main/services/lanes/runtimeDiagnosticsService.ts`
  — aggregated lane runtime health.
- `apps/desktop/src/main/services/agentTools/` — detects installed
  agent CLI tools (Claude Code, Codex, Cursor, Aider, Continue).
- `apps/desktop/src/main/services/projects/projectBrowserService.ts`
  — desktop-only (runs before any project binding so it stays on the
  Electron main process). Serves the Command Palette project browser:
  expands `~`, handles
  platform-appropriate relative / absolute paths, lists matching
  subdirectories with `.git` detection (concurrency-limited, capped at
  `limit` with 500 max), and resolves any exact-directory match to an
  openable project root without shelling out while the user types. If
  the candidate path is inside an ADE-managed worktree, it resolves
  back to that lane's owning project root via
  `findAdeManagedWorktreeRoot`; otherwise it walks ancestors until it
  finds a `.git` file or directory. The eventual open flow still
  performs full git validation. Windows-style paths are rejected on
  non-Windows hosts.
- `apps/desktop/src/main/services/projects/projectScaffoldService.ts`
  — backs the "Add project → Create" and "Add project → Clone" flows.
  `createLocalProject({ name, parentDir })` makes a new directory, runs
  `git init --initial-branch=main` (with a `git init` + `symbolic-ref`
  fallback for older git), writes a starter `README.md` + `.gitignore`
  that ignores `.ade/`, and creates an "Initial commit" (retried with an `ADE <ade@local>`
  author when the user has no git identity configured).
  `cloneRepository({ url, parentDir, name })` validates the URL via
  `parseGitHubRepoFromRemoteUrl`, ensures the target is empty, and
  shells out to `git clone`. `listMyGitHubRepos({ search })` paginates
  `/user/repos` (up to 5 pages of 100, sorted by `pushed`) and caches
  the result for 60s keyed by token prefix; `search` is a
  case-insensitive `fullName` substring filter applied to the cached
  list. `getDefaultParentDir(recentProjects)` returns the parent of
  the most recent local project's `rootPath`, falling back to
  `~/Projects`; remote recents are excluded because their paths belong
  to another machine.
- `apps/desktop/src/main/services/projects/projectDetailService.ts` —
  produces the palette's preview pane: branch name, dirty-file count
  with staged / unstaged / untracked breakdown, ahead/behind counts,
  last commit (subject / ISO date / short sha),
  README excerpt (first ~1,600 chars, trimmed on paragraph / sentence
  boundary), top-four languages by file count (extension-mapped,
  depth-2 walk capped at 2,000 files), subdirectory count, and — when
  the path matches a local recent-projects row in the global state file —
  lane count and last-opened timestamp. Remote recent rows are ignored
  for local detail metadata so a remote and local project with the same
  path string cannot collide.
  The detail also carries `worktreeOf` (via `resolveWorktreeParentRef`)
  so the browse preview can badge linked worktrees; `projectBrowserService`
  populates the same field on `ProjectBrowseEntry` rows for git entries
  using only the cheap `.git` gitdir-pointer read.
  `registerIpc.ts` wraps `project.getDetail(rootPath)` in a short
  per-root promise cache (10 s, capped at 64 entries) so moving through
  the project browser does not recompute git/README/language metadata
  for the same highlighted path on every render.
- `apps/desktop/src/main/services/projects/projectPathInspector.ts` —
  backs `ade.project.inspectPath`: classifies a path as `not-git` /
  `repo-root` / `ade-managed-worktree` / `linked-worktree` via
  `git rev-parse` (toplevel, then `--git-dir` vs `--git-common-dir`),
  resolves the linked parent working tree (bare repos yield no parent),
  reads the current branch ref, looks up `parent.existingLane` in the
  owning project's `.ade/ade.db`, and counts `standaloneState`
  chats/lanes in the worktree's own `.ade/ade.db` (including legacy
  `tool_type = 'other'` chat rows). `inspectProjectPathCached` adds the
  per-path promise cache (10 s TTL, 64 entries, `fresh` bypass);
  `invalidateProjectPathInspectionCache` is called after lane
  attach/adopt from `registerIpc.ts` and `runtimeBridge.ts`.
- `apps/desktop/src/main/services/projects/worktreeParent.ts` — pure
  `.git`-file helpers: `parseGitDirPointer` / `readGitDirPointer`,
  `resolveGitMetadataDirectory` (shared with the recents lane count),
  and `resolveWorktreeParentRef`, which maps a linked worktree to its
  parent repo (`<parent>/.git/worktrees/<name>` shape) or to the owning
  project root for ADE-managed worktrees — all without shelling out.
- `apps/desktop/src/main/services/projects/readOnlySqlite.ts` — shared
  read-only `node:sqlite` `DatabaseSync` opener plus `hasTable` /
  `hasColumn` guards, used by `recentProjectSummary.ts` and
  `projectPathInspector.ts` for foreign-project `.ade/ade.db` reads.
- `apps/desktop/src/main/services/projects/projectIconResolver.ts` —
  best-effort icon discovery and user-overridable selection for a
  project root. Discovery walks a fixed list of base directories
  (`./`, `app/`, `src/`, `src/app/`, `public/`, `assets/`, `build/`)
  combined with one-deep child directories (and one-deep
  `apps/*` / `packages/*` for monorepos), checking a curated list of
  filenames (`macIcon.png`, `app-icon.{png,svg,webp}`,
  `icon.{png,svg,ico,webp}`, `logo.{png,svg,webp}`,
  `favicon.{png,svg,ico}`) and any image file whose name contains
  `icon`/`logo` or equals `favicon`. Heavy directories
  (`.ade`, `.git`, `.next`, `.open-next`, `coverage`, `dist`,
  `node_modules`, `out`) are skipped. Candidates are scored: `macicon`
  / `app-icon` win first, then `icon`, then `logo`, then any name
  containing `icon`, then `favicon`; `/app/` and `/src/app/` placement
  boosts score, `apps/desktop/build/` boosts further (so ADE's own
  app icon is preferred when developing ADE), `/docs/` and
  `/mintlify/` paths are demoted. PNG > SVG > ICO > WebP for ties,
  shallower paths win, alphabetical tiebreak last. When automatic
  discovery returns nothing, the resolver scans `index.html`,
  `public/index.html`, the TanStack Router root files
  (`app/routes/__root.tsx`, `src/routes/__root.tsx`), `app/root.tsx`,
  `src/root.tsx`, and `src/index.html` for a `<link rel="icon">` href
  (HTML attribute or JS-object form, local hrefs only) and resolves
  it against `public/` or the project root.

  An explicit user choice in `.ade/ade.yaml` (`project.iconPath`
  relative to the project root) is honoured first. `iconPath: null`
  disables automatic detection entirely so the project deliberately
  shows the fallback glyph; an unknown / removed file silently falls
  through to detection. `setProjectIconOverride(rootPath, iconPath)`
  validates the path stays inside the project root and points at a
  supported file, then writes `project.iconPath` into
  `.ade/ade.yaml`. `removeProjectIconOverride(rootPath)` writes
  `iconPath: null`. `setProjectIconOverrideFromSelection(rootPath, srcPath)`
  is the file-picker entry point: it validates the source file
  (`.ico` / `.jpg` / `.jpeg` / `.png` / `.svg` / `.webp`, ≤ 10 MB),
  copies the bytes into `.ade/project-icons/<contentHash>.<ext>` so the
  icon travels with the repo, then writes `project.iconPath` to that
  relative path. Every override write also runs
  `ensureSharedAdeProjectScaffold(projectRoot)` so a project that was
  previously local-only gets promoted to the shared scaffold the moment
  the user picks a custom icon. All three helpers return the freshly
  resolved `ProjectIcon` so the renderer can update the cache in one
  round trip.

  `resolveProjectIcon(rootPath)` returns
  `{ dataUrl, sourcePath, mimeType }`: any matched file under 10 MB is
  base64-encoded as a data URL (svg / ico / png / jpeg / webp), larger
  files report only `sourcePath`. Path traversal outside the project
  root is blocked end-to-end (probe paths run through
  `resolvePathWithinRoot`, so symlinks pointing outside the worktree
  silently fail to match instead of leaking files).
- `apps/desktop/src/main/services/projects/projectIconThumbnail.ts` —
  phone-facing thumbnail resolver for the mobile project catalog. It
  reuses `resolveProjectIcon(rootPath)`, asks Electron `nativeImage` to
  produce a 64px PNG when running in the desktop host, falls back to
  macOS `/usr/bin/sips` for SVG / ICO / WebP sources that Electron does
  not decode, and falls back to raw PNG data only when thumbnailing is
  unavailable. Results are cached by source path + file signature and
  temporary conversion files are removed after each attempt.
- `apps/desktop/src/main/services/projects/projectIconResolver.test.ts`
  — vitest coverage: direct file matches, HTML link scrapes,
  escape-attempt rejection, base64 data-URL emission, scoring
  preferences, mobile PNG thumbnail generation, and round-tripping
  `setProjectIconOverride` / `removeProjectIconOverride` against
  `.ade/ade.yaml`.

Shared types:

- `apps/desktop/src/shared/types/config.ts` — `ProcessDefinition`,
  `ProcessRuntime`, `StackButtonDefinition`, `TestSuiteDefinition`,
  `LaneOverlayPolicy`, `ProxyConfig`, `PortLease`, `LanePreviewInfo`.
- `apps/desktop/src/shared/types/core.ts` — `ProjectIcon` (`{ dataUrl,
  sourcePath, mimeType }`), `RecentProjectSummary` (`kind`, `remote`,
  `pinned`), remote `OpenProjectBinding` metadata (including
  `iconDataUrl`, the host-resolved logo for the remote project tab),
  and `ProjectDetail` dirty breakdowns consumed by the TopBar tab
  strip, welcome rows, project browser preview, and mobile-facing
  project catalog. Also home to the worktree-consolidation types:
  `WorktreeParentRef` (the optional `worktreeOf` field on
  `ProjectDetail`, `RecentProjectSummary`, and `ProjectBrowseEntry`),
  `WorktreeParentInfo`, and `ProjectPathInspection`.

Preload bridge:

- `apps/desktop/src/preload/preload.ts` — `window.ade.processes`,
  `window.ade.project`, `window.ade.remoteRuntime`, `window.ade.tests`.
  The project surface includes recent-list operations (`listRecent`,
  key-based `forgetRecent` / `reorderRecent`, `setRecentPinned`), local
  project open/create/clone/detail/icon helpers, and drag-drop path
  extraction (`getDroppedPath`). Remote project browsing/opening uses
  `window.ade.remoteRuntime.*` until a window is bound to the selected
  remote project.

## Composition

### Welcome screen

Rendered by `RunPage` when `useAppStore((s) => s.showWelcome)` is true
— typically when no project is open or the app was launched without
a prior session. Shows:

- ADE logo with a subtle pulse-glow
- "ADD PROJECT" primary button → opens the Command Palette in
  `intent="project-add"` mode (see the next subsection)
- unified recent projects list from `window.ade.project.listRecent()`,
  with local and remote rows. Local rows show display name, path, lane
  count, last-opened timestamp, and availability. Remote rows show the
  host-resolved project icon when available, keep the amber remote
  machine badge, and use live remote connection state for their
  connected / reconnecting affordance.
- per-row pin / unpin; pinned rows float above unpinned rows while
  preserving recency order inside each group.
- deferred remove with an Undo toast. The renderer hides the row
  immediately and calls `window.ade.project.forgetRecent(key)` only
  after the undo window elapses. Remote rows are forgotten by stable
  `remote:<targetId>:<projectId>` key; local rows use their root path.
- drag-and-drop folder open, routed through
  `window.ade.project.getDroppedPath(file)`.

`registerIpc.ts` caches converted recent summaries for 5 seconds keyed by
root/display/last-opened plus remote identity and pinned state, and clears
the cache after forget / reorder / pin writes.

### Worktree-as-project consolidation

Opening a directory that is an external linked git worktree (created with
`git worktree add` outside ADE) no longer silently creates a standalone
project. `appStore.switchProjectToPath(rootPath, opts?)` gates at the top of
the funnel: for paths not already open as a project tab it calls
`window.ade.project.inspectPath(path, { fresh? })` (IPC
`ade.project.inspectPath`, handled by `inspectProjectPathCached` in
`projectPathInspector.ts` — a per-path promise cache, 10 s TTL capped at 64
entries, that `fresh: true` bypasses). The cache is cleared after every
lane attach/adopt on both write paths: the in-process `IPC.lanesAttach`
handler in `registerIpc.ts` and the runtime-bridge action dispatch
(`lane` domain, `attach` / `adoptAttached`) in `runtimeBridge.ts`, which
never touches the in-process handler. When the inspection reports
`kind: "linked-worktree"` with a resolvable non-bare parent working tree,
the store sets `worktreeOpenPrompt` and returns without opening;
inspection failures fall through to the normal open so the gate can never
break project opening. `WorktreeOpenDialog` (mounted in `AppShell`) then
offers the recommended action — open the existing lane in the owning
project, attach the worktree as a lane there, or add the parent repo as the
project first — plus a quiet "Open as a separate project instead" escape
hatch (`switchProjectToPath(path, { skipWorktreeGate: true })`). Bare or
unresolvable parents skip the prompt and open standalone.

The attach flow itself lives in `worktreeLaneFlow.ts`
(`openWorktreeAsLane`): it switches to the parent project (gate skipped),
routes to `parent.existingLane` when the inspection already found one, and
otherwise calls `lanes.attach` with a lane name derived from the branch ref
(falling back to the worktree basename). `laneService.attach` now throws
coded `lane_already_linked` errors (via `codedError` /
`encodeCodedErrorMessage`) for already-linked paths and branches; the flow
recovers from that code by re-inspecting with `fresh: true` and navigating
to the lane it finds, rethrowing only when no lane resolves. Attach also
emits a `lane-created` lifecycle event, so the global lane toast fires.

The inspection carries `parent.existingLane` (read from the owning
project's `.ade/ade.db` via the shared read-only `DatabaseSync` helpers in
`readOnlySqlite.ts`) and `standaloneState` chat/lane counts read from the
worktree's own `.ade/ade.db`. `MergeWorktreeProjectDialog` (opened from a
welcome recents row's merge affordance) uses both: it re-inspects with
`fresh: true` on open, warns that existing chats/lanes stay under the
retired project, then runs `openWorktreeAsLane` and retires the recents row
with `forgetRecent`. The forget is fail-soft — the lane exists by then, so
a forget failure never reports the merge as failed — while a merge failure
after the project switch already happened surfaces a persistent
"Merge failed" error toast (the dialog's inline error is no longer
visible on the new project).

`worktreeOf` (`WorktreeParentRef`, derived from the `.git` file's
`gitdir:` pointer in `worktreeParent.ts` without shelling out to git) is
populated on `ProjectDetail`, `RecentProjectSummary`, and
`ProjectBrowseEntry`; the welcome recents rows, palette browse rows, and
`BrowsePreview` render it via `WorktreeBadge` ("worktree of X", compact
label in browse rows), and badged local recents rows expose the merge
affordance. The OS "Open repository" dialog (TopBar/AppShell Relocate) is
also gated: `appStore.openRepo` picks the folder with
`window.ade.project.chooseDirectory` first, runs the same inspect step, and
either surfaces the prompt or binds the picked path via
`openRepo({ rootPath })` — so the native dialog behaves like the in-app
flows. Remaining bypasses: inbound deeplinks reach the main process's
`switchProjectFromDialog` directly, and warm-tab switches pass
`skipWorktreeGate`, so neither shows the prompt. Local project rows open via
`appStore.switchProjectToPath(path)` and the normal project open flow
(`adeProjectService.openProject`). Connected remote rows open via
`appStore.switchRemoteProject(targetId, projectId)`; disconnected remote
rows first call `window.ade.remoteRuntime.connect(targetId)` and then bind
the project if the connection succeeds.

Project-open failures are stored in `appStore.projectTransitionError` and
rendered by `AppShell` as a full-width, wrapping alert below the TopBar; the
TopBar never truncates the only visible copy of an error. Opening a local
project requires Git because ADE validates the repository root before binding
it. On macOS, Git resolution prefers a separately installed executable over
Apple's `/usr/bin/git`, which can be blocked by an unaccepted Xcode license.
When Apple's Git is the only option, ADE explains that the license prompt is a
Git dependency rather than an iOS Simulator or code-signing requirement and
offers a separate Git installation as the alternative.

### Command Palette project flows

The Command Palette (`renderer/components/app/CommandPalette.tsx`) is a
multi-mode Radix dialog. In default mode it fuzzy-filters navigation /
action commands; with an `intent` it switches into a focused project
flow without closing. The supported intents are:

- `default` — fuzzy command list
- `project-browse` — keyboard-first opener for an existing folder
- `project-add` — three-tile chooser (Open / Create / Clone) via
  `AddProjectChooser`
- `project-create` — `CreateProjectForm` (new directory + git init)
- `project-clone` — `CloneProjectForm` (URL tab + "My repos" tab)

The palette mounts from two places:

- **`AppShell`** — global ⌘K shortcut opens the palette in default
  mode. The "Open project", "Create new project", and "Clone from
  GitHub" commands swap modes without closing the dialog.
- **`WelcomeScreen` in `RunPage`** — the "ADD PROJECT" button mounts
  a dedicated palette instance with `intent="project-add"` so the
  empty-project state lands on the chooser.

After a successful create/clone, the palette flips to a
`ProjectActionSuccess` panel offering "Open it now" (calls
`switchProjectToPath`) or "Stay here". The Back button on every form
returns to the chooser.

Project-browse behavior:

1. The input field debounces into `window.ade.project.browseDirectories({
   partialPath, cwd, limit })` for local browsing, or the matching
   remote-runtime directory browser for a selected remote target. The
   palette remembers the last browse path separately for the local
   machine and each remote target so a path from one filesystem is never
   reused on another.
2. Results render as a list: a "Go up" row if the current directory
   has a parent, then matching subdirectories (alphabetically sorted,
   `.git`-detected marked with a branch icon). Git repo rows expose an
   inline Open button in addition to keyboard activation.
3. A debounced `window.ade.project.getDetail(target)` populates a
   preview pane alongside the list — branch, dirty/ahead/behind with
   staged / unstaged / untracked tooltip, last commit, README excerpt
   (sanitized raw HTML + GitHub-flavored Markdown), project icon
   preview, language swatches, lane count, last-opened. README images
   render as alt text so browsing does not load external assets. The
   main process dedupes repeated detail reads for the same root for a
   short window.
4. Enter activates the highlighted directory (walks into it). ⌘/Ctrl+
   Enter opens the openable project root (the first ancestor with a
   `.git` entry).
5. Drag-and-drop onto the palette uses
   `window.ade.project.getDroppedPath(file)` to resolve the dropped
   folder's absolute path and then opens it.
6. A "Choose folder…" escape hatch falls through to the OS directory
   picker via `window.ade.project.chooseDirectory`.

### Add Project flows

The "Add project" forms live in
`apps/desktop/src/renderer/components/projects/`:

- `AddProjectChooser.tsx` — three large tiles (Open / Create / Clone)
  with icon, headline, tagline, and a soft hue-tinted hover state.
- `CreateProjectForm.tsx` — create flow: validates the project
  name, debounces an existence check via `browseDirectories`, fetches
  `getDefaultParentDir()` for the parent suggestion, and calls
  `window.ade.project.createLocal({ name, parentDir })`.
- `CloneProjectForm.tsx` — two tabs sharing a common parent-directory
  picker. The **URL** tab pastes any `https://` / `git@…:…` /
  `ssh://…` URL, derives the folder name on blur, and clones via
  `window.ade.project.clone({ url, parentDir, name })`. The **My
  repos** tab calls `window.ade.github.listMyRepos({ search })` (which
  returns connected-only repos sorted by `pushedAt`); each row
  expands inline into a parent-directory + folder-name editor and
  uses the repo's `cloneUrl` for the clone. If the GitHub token is
  missing, an inline `ConnectGithubPrompt` accepts a PAT and saves it
  through `window.ade.github.setToken` before re-querying.
- `ProjectActionSuccess.tsx` — shared success panel after create or
  clone, offering "Open it now" or "Stay here".

The TopBar exposes a `Publish` pill when a project has no `origin`
remote. `useGithubProjectRemote(projectRoot)`
(`renderer/lib/useGithubProjectRemote.ts`) reads
`window.ade.github.getStatus({ forceRefresh })`, treats
`status.repo == null` as "no remote", and listens to
`onStatusChanged` so the pill disappears as soon as the project gets
an origin. The pill opens `PublishToGitHubDialog`
(`renderer/components/projects/PublishToGitHubDialog.tsx`), which
collects a repo name + description + visibility, calls
`window.ade.github.publishCurrentProject(...)`, and surfaces backend
codes (`github_not_connected`, `remote_already_exists`) inline. The
backend (`githubService.publishCurrentProject`) creates the repo via
`POST /user/repos`, runs `git remote add origin`, then
`git push -u origin HEAD` if there's a commit to push (otherwise it
returns `state: "remote_added"` so the user can publish their first
commit later).

### Per-lane runtime dashboard

When a project is open and not in welcome state:

1. **Header row** — page title with the active group / count chip,
   plus the affordance buttons: "Advanced" (toggles the
   `LaneRuntimeBar` drawer below the header), "New shell" (spawns
   a tracked shell PTY for the fallback run lane), per-group
   "Run all" / "Stop all" (visible when a group is selected; calls
   `processes.startGroup` / `processes.stopGroup` with the lane map
   built from `commandLaneMap`), and "Add command".
2. **LaneRuntimeBar drawer** — collapsible. When expanded, surfaces
   the currently-selected "Running in" lane runtime: health,
   preview/proxy info, OAuth callback URL, port leases. Open/closed
   state persists to `localStorage`.
3. **Group filter chip row** — populated from
   `config.effective.processGroups`. The first chip is "All commands"
   (no group filter). Each subsequent chip corresponds to a
   `ProcessGroupDefinition` with its member count; clicking
   narrows the grid to processes that list its ID in `groupIds`.
   The row also hosts a "New group" affordance that opens an inline
   input + Add/Cancel pair, calling `projectConfig.save` to persist
   the new `ConfigProcessGroupDefinition` to `.ade/ade.yaml`.
4. **Commands grid** — renders one `CommandCard` per `ProcessDefinition`
   matching the active group filter. Each card owns:
   - name + description from config
   - a lane picker (bound to `commandLaneMap` persisted per project
     under `ade.runPageLaneState.v1`); switching lanes here rebinds
     the card's runtime view without changing the global lane
     selection
   - aggregate status pulled from the newest `ProcessRuntime` for
     that `(laneId, processId)` — status dot (gray/stopped,
     yellow/starting or degraded, green/running, red/crashed),
     pid, uptime, listening ports, active-run count when multiple
     runs are live
   - action buttons (Run / Stop) — Run always starts a fresh run with
     its own `runId`; Stop targets the most recent active run via
     `processes.kill` with that `runId`
   - inline log/status panel per run; the card is the surface that
     drills into a specific `runId`'s output (no separate
     `ProcessMonitor` component anymore)
   - overflow menu (Edit, Delete, Add to group)
5. **RunNetworkPanel** (optional drawer) — shows port leases, proxy
   routes, and preview URLs for the current lane. Pulls from
   `window.ade.ports.*` and `window.ade.proxy.*`.
6. **AddCommandDialog** — full modal for adding or editing a process.
   Covers command, args, cwd, env, restart policy, readiness config
   (none / port / logRegex), dependency list, graceful shutdown
   timeout, and process-group membership (existing groups as chips
   plus a free-form "new groups, comma separated" field that creates
   `ProcessGroupDefinition` entries on save). Saves back to config
   via `projectConfig.save`.

Stack buttons (`config.effective.stackButtons`) still exist in the
config and run through `processes.startStack` / `stopStack` /
`restartStack`, but the previous tab strip surface (`RunStackTabs`)
was removed in favor of the group-based filter — process groups are
the renderer-side organizing primitive now. Stack buttons are still
addressable from the command palette via `QuickRunMenu`.

### Quick run menu

`QuickRunMenu` is reachable through the command palette and provides
fuzzy-search over:

- processes (start/stop)
- test suites (run)
- stacks (start/stop)
- recent run-shell commands

Scoped to the current run lane.

### Project icons

Each project gets a best-effort icon resolved by
`projectIconResolver`. The renderer asks for it on demand through
`window.ade.project.resolveIcon(rootPath)` (handler:
`IPC.projectResolveIcon` →
`ipcMain.handle("ade.project.resolveIcon", …)`); the desktop TopBar
project tab strip caches the result per `rootPath` in a module-local
`Map` so a tab swap doesn't re-scan the disk. The same TopBar derives
a per-project accent colour from the resolved data URL by sampling the
icon's dominant pixel through a tiny offscreen canvas
(`deriveIconAccentColor`), then drives the project tab's active /
hovered / focused background and border via the `--project-tab-accent`
CSS variable in `index.css`; the colour is luminance-balanced and
cached per data-URL (`PROJECT_ICON_ACCENT_CACHE_MAX = 48`). When the
resolver finds no icon (or the file is over the 10 MB cap), the tab
falls back to the `Folder` Phosphor glyph and the default accent.
Missing-project tabs skip the lookup entirely.

The TopBar tab also exposes a small icon-override dialog: clicking the
icon button opens a Radix dialog with **Choose icon…** and **Reset to
auto-detected**. **Choose icon…** calls
`window.ade.project.chooseIcon(rootPath)` which opens an Electron
file picker (filtered to `ico`/`jpeg`/`jpg`/`png`/`svg`/`webp`); the
selected path is validated (must live inside the project root and be a
supported image type, ≤ 10 MB), copied into
`.ade/project-icons/<contentHash>.<ext>` so the icon ships with the
repo, persisted to `.ade/ade.yaml` under `project.iconPath`, and the
freshly resolved icon is returned to the renderer. **Reset to
auto-detected** calls `window.ade.project.removeIcon(rootPath)`, which
writes `project.iconPath: null` so the project deliberately shows the
fallback glyph (use the file picker to pick a new one to re-enable
detection or override). The override is committed to `.ade/ade.yaml`
(shared, committed) so collaborators see the same project icon, and
the `.ade/project-icons/` directory is part of the tracked shared
scaffold so the actual bytes travel with the override.

Remote project tabs and remote recent-project rows cannot run the local
resolver — the project files live on another machine. Instead the host
brain resolves the icon and inlines it: the ade-cli `projects.list` RPC
stamps each record with an `icon: { dataUrl, sourcePath, mimeType }` produced by
`resolveRemoteProjectIcon` (`apps/ade-cli/src/services/projects/projectIconResolver.ts`),
a compact electron-free port of the desktop resolver that covers the
`.ade/ade.yaml` override, the conventional icon/logo files, and an
`index.html` `<link rel="icon">` (resolution is best-effort, rendered as a
64 px thumbnail, and capped at 128 KiB per icon; a failure or exhausted
catalog budget degrades that project to a null icon rather than breaking the
list). That
icon rides through `RemoteRuntimeProjectRecord.icon` →
`OpenProjectBinding.iconDataUrl`. The desktop persists that data URL on
both `globalState.lastRemoteProjectBinding` and the matching remote recent
metadata, so the TopBar tab and welcome row can render the real logo before
the remote reconnects. `TopBar`'s `ProjectTabIcon` takes an
`iconDataUrlOverride`: when the caller owns the icon (remote tabs), it
renders the data URL directly and skips the local `resolveIcon` path
entirely (falling back to the folder glyph when the host returned no
icon). The welcome row uses the same saved data URL for its primary tile and
overlays the amber remote-machine badge so remote identity stays visible.

The mobile companion gets the icon through a dedicated path: the host's
`mobileProjectSummaryForContext` / `mobileProjectSummaryForRecent` in
`apps/desktop/src/main/main.ts` runs `resolveMobileProjectIconDataUrl`
on every project entry, which reuses `resolveProjectIcon`, downsamples
the source image to a 64px PNG via Electron `nativeImage` when possible,
and uses macOS `sips` as the conversion fallback for SVG / ICO / WebP
sources that `nativeImage` cannot decode. The ADE CLI brain uses the
same helper for its headless mobile project catalog. The resulting
PNG data URL is sent to iOS as `MobileProjectSummary.iconDataUrl`; the iOS
Hub (`HubScreen`) renders that string as the project card artwork.

## Data model

The dashboard is driven by:

- `ProjectConfigSnapshot.effective.processes: ProcessDefinition[]`
- `ProjectConfigSnapshot.effective.processGroups: ProcessGroupDefinition[]`
- `ProjectConfigSnapshot.effective.stackButtons: StackButtonDefinition[]`
- `ProjectConfigSnapshot.effective.testSuites: TestSuiteDefinition[]`
- `ProcessRuntime[]` aggregated across every lane that appears in
  `commandLaneMap` (because each command card can point at a
  different lane). `listRuntime(laneId)` includes every in-memory
  run for that lane — active ones and recent history — so the card
  sort-picks the newest run for its status.
- live `ProcessEvent` stream (`ade.processes.event`). Runtime events
  now carry `runId`; log events carry `runId`, `laneId`, and
  `processId`, so filters match the specific invocation rather than
  coalescing history.

Config comes from `projectConfigService`, which merges
`.ade/ade.yaml` (shared, committed) with `.ade/local.yaml` (local,
gitignored) into an effective config. See
[../onboarding-and-settings/configuration-schema.md](../onboarding-and-settings/configuration-schema.md)
for the schema.

## Runtime lifecycle (high level)

1. Page mounts. `refreshDefinitions` loads config + definitions in
   parallel.
2. The runtime refresh fans out across every distinct lane ID in
   `commandLaneMap` (plus any lanes hosting active run-shell
   sessions) with `processes.listRuntime(laneId)` calls in parallel,
   concatenating the results into a single `runtime: ProcessRuntime[]`.
3. The page subscribes to `processes.onEvent` without filtering out
   `runId`s — each `CommandCard` narrows by
   `(laneId, processId, runId)` as needed.
4. Start/stop/restart calls go through `window.ade.processes.*`; the
   next `runtime` event confirms or corrects. Stop/kill resolve to
   `null` when no active run exists for the card, which is treated
   as a no-op.
5. When the user switches lanes, the page disposes any user-launched
   run-shell sessions (`disposeRunShellSessions`) and re-runs
   `refreshRuntime`.
6. Per-command lane selection is persisted per project under
   `localStorage` key `ade.runPageLaneState.v1` (via the
   `PersistedRunPageLaneState` helpers) so the grid restores its
   per-card lane assignments on reopen.

## Loading model notes

The Run page hydrates in phases rather than as a cold boot on every
lane switch:

- project config and process/test definitions load independently of
  runtime state
- selected-lane runtime refreshes when the lane changes without
  reloading lane-independent metadata
- initial runtime hydration is deferred slightly behind first render
  (the 140 ms timer above)
- config saves refresh only the dependent slices instead of
  remounting the full page

## Gotchas

- `RunPage` owns both welcome and dashboard behavior; `showWelcome`
  is the gate. Side effects (e.g. process event subscription) still
  fire during welcome but return early, so the event bus stays clean.
- `runLaneId` lets Run override `selectedLaneId` without changing the
  global selection. Always read `runLaneId ?? selectedLaneId` when
  looking up runtime state.
- User-launched "run shell" sessions are tracked separately
  (`runShellSessions` in renderer state) and disposed on lane switch
  / page unmount. They share the `terminal_sessions` table but are
  tagged with `tool_type = "run-shell"`.
- Each command card can point at a different lane. `refreshRuntime`
  therefore fans out across every lane in `commandLaneMap`;
  subscribing to `processes.onEvent` without a lane filter is the
  correct default, because filtering out other lanes would hide the
  cards that target them.
- The stack aggregate status is computed in the renderer
  (`processUtils.ts`). It is not authoritative — the ultimate truth
  is the per-process `ProcessRuntime.status`.
- The inline log panel inside each `CommandCard` is focused by
  `runId` (for managed processes) or session ID (for run-shell
  sessions). Passing only `processId` picks the newest run.
- `processes.getLogTail(...)` also accepts `runId` — without it the
  main process picks the most recent run for the `(laneId, processId)`.
- Groups are a UI filter and a backing key for `processes.startGroup`
  / `stopGroup` / `restartGroup`. They are NOT a start-order
  contract: group runs are always parallel (definition order only
  affects fork order inside `Promise.all`); per-process `dependsOn`
  is not topologically sorted across mixed lanes. Use single-lane
  stacks if you need strict dependency sequencing for a bundle.

## Cross-links

- Processes and stacks lifecycle:
  [../terminals-and-sessions/pty-and-processes.md](../terminals-and-sessions/pty-and-processes.md)
- Onboarding and config:
  [../onboarding-and-settings/](../onboarding-and-settings/)
- Preview URLs, proxy, port leases: see the Lanes feature and the
  `laneProxyService`/`portAllocationService`.
- Agent tools detection (Claude Code, Codex, Cursor, Aider,
  Continue): `apps/desktop/src/main/services/agentTools/`.

# Move project location (macOS first) — research and design

Status: **built** (see `docs/features/onboarding-and-settings/project-move.md`). Research done 2026-10-14 on the Mac Studio
(internal disk 14 GB free; new 1 TB APFS drive at `/Volumes/Dev`).

The goal: move one ADE project (repo, `.ade/`, every lane worktree, and every
record that ties the project to its path) to a new folder, usually on another
disk, without losing lanes, chats, history or sync, and without the original
and the copy ever writing into each other.

## 1. Where a project path is stored

### Git (inside the project)

| Where | What | After a copy |
|---|---|---|
| `<lane>/.git` file | `gitdir: <root>/.git/worktrees/<name>` (absolute) | Points at the **original** repo |
| `<root>/.git/worktrees/<name>/gitdir` | `<lane>/.git` (absolute) | Points at the original lane |
| `<root>/.git/config` | ADE's own repo has `core.hookspath=/Users/admin/Projects/ADE/.git/hooks` | Hooks run from the original |
| Submodules (`.git` file, `core.worktree`) | Relative by default | Survive |
| Lane `node_modules` symlinks | `laneService.ts` `linkExistingDependencyInstalls` writes **absolute** links to `<root>/node_modules` and `<root>/apps/*/node_modules` (8 per ADE lane, 54 in the ADE project) | Lanes use the original's dependencies; dangling after the original is deleted |
| Other absolute symlinks | e.g. Versic `apps/web/.sst/artifacts/*/node_modules` | Same |
| Python venvs | Shebangs and `pyvenv.cfg` hold absolute paths | Not relocatable; recreate |

ADE never runs `git worktree repair` and never sets `worktree.useRelativePaths`
(`laneService.ts:3929` is a plain `git worktree add <abs path>`).

### Project database `<root>/.ade/ade.db` (`state/kvDb.ts`)

Synced (CRR) columns holding absolute paths:

- `projects.root_path`
- `lanes.worktree_path` (the primary lane's equals the root), `lanes.attached_root_path`
- `terminal_sessions.transcript_path`
- `test_runs.log_path`, `packs_index.pack_path`, `pack_versions.rendered_path`, `files_workspaces.root_path`
- `computer_use_artifacts.metadata_json` → `absolutePath` (82 rows in ADE)
- `kv` **keys**: `dock_layout:*<root>*`, `tiling_tree:*<root>*`, `graph_state:<root>` (52 keys in ADE)

Machine-only (excluded from sync) columns: `runtime_processes.project_root`,
`test_suites.cwd`, `local_worktree_residual_cleanups.worktree_path`,
`local_lane_storage_state.worktree_path`, `lane_worktree_locks.worktree_path`.

Historical text: tool output in `session_deltas`, `operations.metadata_json`,
`automation_runs.summary`, etc. Leave it alone; it records what happened.

No path: `lane_apple_devices` (lane id + UDID), automations, `claude_sessions`.

### Files under `<root>/.ade`

Move with the project and need no rewrite, except:

- `.ade/leftover-worktrees.json`: absolute path **and** device/inode per lane.
- `.ade/cache/{mac-desktop,app-control,browser}-observations/*.json`: `filePath`.
- `.ade/cache/chat-sessions/*.json`: `lastLaneDirectiveKey` contains the lane
  path (a change only re-sends the lane directive, which is what we want).
- Transcripts and terminal snapshots: paths inside history. Leave alone.
- `.ade/ade.sock`: recreated; the new root must keep it under the 104-byte
  unix-socket limit (`/Volumes/Dev/Projects/<name>/.ade/ade.sock` is fine).

### Machine state (`~/.ade` and the app)

| Store | Keyed by | Note |
|---|---|---|
| `~/.ade/projects.json` | `projectId = project_<sha256(root)[:24]>` (`projectRegistry.ts:68`) | **Identity is a hash of the path**, so a move changes it |
| `~/.ade/project-data/<projectId>.json` | `{dev, ino}` of `ade.db` | A copy to another disk changes both: ADE reports the database as *replaced* |
| Electron `userData/ade-state.json` | `recentProjects[].rootPath`, `lastProjectRoot`, `updateWorkspace.localRoots` | |
| `~/.ade/ade-code-state.json` (TUI) | root path in six maps | |
| Renderer `localStorage` | ~14 keys with the root in the key (`ade.laneCache.v1:<root>`, `ade:project-route:<key>`, PRs, Linear, Files, automations drafts) | Losing them only resets UI; the lane cache holds worktree paths, so it must be dropped, not kept stale |
| `~/.ade/provider-homes/claude/*/projects/<cwd-slug>/` | Claude history per cwd (`-Users-admin-Projects-ADE--ade-worktrees-<lane>`) | A move orphans it; `claudeSessionTransplant.ts` already moves a session and rewrites `cwd` per line |
| CoreSimulator `<udid>/ade-lane-device.json` | `projectRoot` | Stale root makes the lane's simulator look leaked |
| `~/.ade/runtime/last-failure*.json` | `projectRoot` | Diagnostic only |
| Deeplinks | `projectId` (the path hash) | Links made before the move stop resolving |

### Outside ADE

| Tool | Path-keyed state | Effect of a move |
|---|---|---|
| Claude Code (user's own CLI) | `~/.claude/projects/<slug>/` (8 GB, 272 project dirs); `~/.claude.json` `projects["<path>"]` holds `allowedTools`, `mcpServers`, trust | History and per-project permissions are orphaned |
| Codex | `~/.codex/state_5.sqlite` `threads.cwd` (7,753 rows), `project_roots.path`; `config.toml` `[projects."<path>"]` trust | Resume by thread id still works (ADE sends the new cwd); the picker and trust do not follow |
| Cursor | `~/.cursor/projects/Users-admin-Projects-ADE` | Orphaned |
| pnpm (Versic) | Store is `~/Library/pnpm/store/v11` (6.5 GB) on the internal disk | A project on another volume gets a separate store at `/Volumes/Dev/.pnpm-store` (no clones across volumes); reinstall there |
| npm (ADE) | `node_modules` (~4.5 GB in ADE) | Reinstall is cleaner than copying, and copying is still correct |
| Xcode | DerivedData 5.8 GB, CoreSimulator 11 GB | Stay on the internal disk; nothing to do |
| Docker | Own disk image setting | Out of scope; mention only |
| `CLAUDE.md` / `AGENTS.md` / memory files | Text mentioning `/Users/admin/Projects/...` | Report them; never rewrite silently |

## 2. Experiments (all on throwaway copies; drive left empty)

1. **Copy with the original still present.** Git in a copied lane resolved to
   the original `.git` (confirms the earlier finding).
2. **Bare `git worktree repair` in the copy is dangerous.** It rewrote the
   *original's* lane `.git` files to point at the copy and left the copy's
   lanes pointing at the original: both sides crossed.
3. **`git worktree repair <each new lane path>` in the copy is safe.** Both
   links in the copy were fixed, the original was untouched, and a commit in a
   copied lane landed only in the copy. It does not fix `core.hooksPath` or
   absolute symlinks.
4. **Relative worktree paths** (`git worktree repair --relative-paths`,
   `worktree.useRelativePaths=true`): a copy works with no repair at all. Git
   sets `extensions.relativeWorktrees` and repository format 1, so git older
   than 2.48 refuses the repo. This Mac: git 2.54, GitHub Desktop's git 2.53.
   No libgit2 tools found. ADE uses the git CLI only.
5. **Database rewrite** on a backup copy of ADE's real `ade.db` with cr-sqlite
   loaded: one transaction, 9 ms, 1 project + 8 lanes + 30 transcript paths +
   2 machine-only rows. It produced exactly 39 outgoing sync changes, all CRR
   path cells, in one `db_version`. The machine-only table produced none.
6. **Full dry run** on a copy of crumb (3.4 GB, 1 lane): `ditto` copy 15 s,
   database snapshot via SQLite backup, explicit repair, git config and
   symlink fix-ups. Every worktree's `git status` matched the original, no git
   metadata pointed back, file count equal except the WAL/SHM files.
7. **Unplugged drive.** `/Volumes` is `root:wheel 755`; `mkdir
   /Volumes/<anything>` as the user fails with EACCES. ADE cannot silently
   recreate an unplugged drive's path on the internal disk. The real risk is a
   *different* volume later mounted as `/Volumes/Dev` (or `Dev 1` when a stale
   directory exists), so record the volume UUID.

Created and removed: 3.3 GB crumb copy, 56 MB database copy, three ~0.5 MB
throwaway repos, 1 MB of scripts in `/tmp`. `/Volumes/Dev` holds only the
macOS files it had before (`.DS_Store`, `.Spotlight-V100`, `.fseventsd`).

## 2b. Round 2 tests (mock projects, all deleted)

Edge-case mock: 8 lanes (uncommitted + staged + untracked + stash; mid
rebase; locked with a space and `é` in its name; submodule; folder missing;
lane outside the project; detached), LFS, absolute `core.hooksPath`,
absolute/relative/escaping symlinks, a tracked file holding the old path.

| Case | Result |
|---|---|
| `git worktree repair <explicit paths>` in the copy | **Hijacked the lane outside the project**: it now pointed at the temporary copy and the original lost it. Never run repair during the move |
| Links written directly + relative paths | Every lane's status, stash, LFS, submodule, lock matched the original; GitHub Desktop's git 2.53 reads it |
| Rebase in progress | Copies fine (git stores it relatively); continuing it in the copy leaves the original mid-rebase |
| `ditto --bom` without `node_modules` | xattrs, ACL, exec bit, LFS kept |
| Destination fills up | `ditto` exits 1 with ENOSPC; original untouched; deleting `.ade-moving` restores the space |
| Drive unplugged mid-copy | `ditto` exits 1 with "Permission denied", not an I/O error: check the volume, not the error text. Partial copy survives under its `.ade-moving` name |
| Drive unplugged, other drive with the same name plugged in | The other drive takes the exact same path and is writable. ADE must check the volume UUID |
| ADE opens a plain copy (original gone) | Lanes **orphaned**: a second project row and a new primary lane; alpha/beta stay under the old project id |
| ADE opens a copy whose DB step failed | Worktrees re-adopted as lanes with **new ids** |
| ADE opens the copy after the full prototype | Same project id, same lane ids, one project row, all paths new; a new lane got a relative link |
| Path spellings | One project stored `/private/tmp/…` as root and `/tmp/…` for lanes: rewrite both |

Unrelated bug found: `ade --headless --project-root <lane folder>` treats the
lane as its own project and writes `.ade` into it (also on an unmoved project).

## 2c. Other agents (opt-in, this project only)

| Agent | Stored by | After a move | Plan |
|---|---|---|---|
| Claude | `projects/<slug>/` folder (`[^A-Za-z0-9]`→`-`), `cwd` per line; `~/.claude.json` `projects[path]` | Resume fails, ADE starts a blank thread | Rename folders (check `cwd` inside, slugs collide), rewrite `cwd`, copy the settings entry. Also in every `~/.ade/provider-homes/*` |
| Codex | `threads.cwd` in its database; `config.toml` trust | Resume works (by id) | Add trust for the new path; leave its database |
| Cursor | `~/.cursor/projects/<slug>/`, `~/.cursor/chats/<md5(path)>/` | CLI resume likely lost | Rename both, rewrite `meta.json` cwd and `.workspace-trusted` |
| Droid | `~/.factory/sessions/<slug>/` | Listing lost | Rename folder; file format to inspect before rewriting |
| OpenCode | `directory` column in its database | Resume works (by id) | Nothing; list hidden sessions under the new path in ADE |
| Pi | `~/.pi/agent/sessions/--<path>--/`, header `cwd` | Resume refused (cwd check) | Rename folder, rewrite first line |
| Muse | `workspace_root` in the log | Resume works | Nothing |
| Copilot | `session-state/<id>/workspace.yaml` cwd; trust in `config.json` | Resume likely works | Report trust prompt |
| Qwen | `~/.qwen/projects/<slug>/` | Lost | Rename folder |
| Grok | `~/.grok/sessions/<url-encoded path>/` | Lost | Rename folder, rewrite `summary.json` cwd |
| Kimi | workspace id = slug + sha256 of path; three files | Lost | Not safe until verified; report |
| Gemini | Only global trust (`/Users/admin`) here | Nothing | Nothing |

Never edit an agent's files while that agent is running.

## 3. Hazards found in ADE today

- **Lane reaper.** `removeVanishedWorktreeLanes` (`laneService.ts:3011`)
  deletes lane rows (and their proof files) when git no longer lists the stored
  path and the stored path is gone. Open a moved project with stale paths after
  the original is deleted, and every lane row is deleted, and the deletes sync
  to the phone. While the original still exists, the copy instead works on
  the **original's** worktrees.
- **Re-adoption.** `recoverManagedWorktreeRows` adopts git worktrees it has no
  row for as **new** lanes, so repairing git without the database duplicates
  lanes and strands chats on the old ids.
- **New project row.** `upsertProjectRow` looks up by `root_path` and inserts a
  new random-UUID project when it finds none; the lanes keep the old id.
- **Identity file.** A cross-disk copy changes `ade.db`'s dev/inode, which the
  data watch reads as *replaced*.
- **No relocation code exists.** The "Relocate" button in `AppShell.tsx:893`
  only opens a folder picker and adds the new path as a new project.

So the database and git must both be rewritten **offline, before anything
opens the copy**, and the project must be closed everywhere during the move.

## 4. Proposed design

### Principles

- One project at a time. Copy, never move. The original is untouched until the
  copy is verified and the user deletes it (or after a waiting period).
- Nothing opens the copy until it is fully rewritten. The copy is written to
  `<dest>.ade-moving` and renamed into place only at the end, so no agent, IDE
  or ADE scan can find a half-done project at the final path.
- The project keeps its identity: same `projects.id` and same lane ids, so
  chats, PRs, Linear links and sync rows all stay attached.
- Every step is journaled (`~/.ade/project-moves/<moveId>.json`) so a crash
  resumes or rolls back. Rollback before the switch-over = delete the partial
  copy; the original was never changed.

### Steps

1. **Preflight** (read-only, shown to the user as a checklist):
   - Destination: exists or creatable, is a local APFS/HFS+ volume (refuse
     network and cloud folders via `storageEnvironmentProbe`/`cloudPlaceholder`),
     ownership enabled, case-sensitivity matches the source, free space ≥ size
     × 1.1 (`node_modules` may be excluded from the size), socket path fits.
   - Access: the app **and** the background service can write there
     (Removable Volumes / Full Disk Access prompt surfaces here, not mid-copy).
   - Project quiet: no running chat turns, PTYs, dev servers, held lane locks
     (`lane_worktree_locks`), in-flight lane creation or reclaim; simulators
     released. List what blocks and let the user stop it.
   - Git: no rebase/merge in progress in any lane, no index locks; list lanes
     outside `.ade/worktrees` (`attached_root_path`) — those are not moved and
     keep their absolute links, which we repair.
   - Report what ADE cannot fix (section 5).
2. **Freeze**: close the project in every window and in the background service
   (the recovery service's `closeProject` + `connectionPool.removeProject`),
   refuse reopen while the move journal is active, checkpoint the WAL.
3. **Copy** with `ditto --bom <list>` (keeps permissions, xattrs, ACLs,
   symlinks, LFS files; the list leaves out every `node_modules`, which is
   reinstalled) into `<dest>.ade-moving`. macOS 27's `rsync` is openrsync and
   drops xattrs, so not rsync. The database is copied with the SQLite backup
   API on a normal connection (a read-only open of a closed WAL database
   fails). **Any failing step aborts the move**: a missing database makes ADE
   re-adopt every worktree as a new lane with a new id. Progress by bytes.
4. **Rewrite git in the copy without running `git worktree repair`** (round 2
   showed even the explicit-path form rewrites any registered lane it can
   reach outside the copy). For each `.git/worktrees/<n>/gitdir` under the
   old root (match both spellings, e.g. `/tmp` and `/private/tmp`): write the
   relative back-link and the lane's `gitdir:` file directly. Missing lanes
   keep their (prunable) entry. Lanes outside the project are left alone until
   switch-over. Then set `core.repositoryformatversion=1` **before**
   `extensions.relativeWorktrees=true` and `worktree.useRelativePaths=true`
   (the other order makes git refuse the repo). Rewrite absolute `.git/config`
   values under the old root; relink absolute symlinks under the old root.
5. **Rewrite ADE data in the copy** (cr-sqlite loaded, one transaction): the
   CRR and machine-only columns in section 1, the `kv` key renames, the
   `absolutePath`s in artifact metadata, `leftover-worktrees.json`, and the
   observation `filePath`s.
6. **Verify the copy**: every `git worktree list` path is under the new root;
   every lane's common dir is the new `.git`; `git status` per lane equals the
   original's; `git fsck --connectivity-only`; file count and byte totals
   match; `PRAGMA quick_check`; lane rows equal git worktrees.
7. **Switch over** (the only step that touches state outside the copy, done in
   one journaled batch): rename `.ade-moving` into place; update
   `projects.json` (new id) and keep an **alias** old id → new id for
   deeplinks and Activity; record the new database identity and forget the old
   one; update `ade-state.json` recents and the TUI state; drop the
   path-keyed `localStorage` caches; move the Claude history folders inside
   ADE's provider homes (`transplantClaudeSession`); rewrite simulator
   markers; reopen the project at the new path.
8. **Disarm the original**: rename it to `<name>.moved-to-Dev` (or put a
   marker file in its `.ade`) so ADE, the user and other tools cannot open it
   by accident and a stray `git` in an old lane cannot write into it.
9. **Cleanup** (separate, user-confirmed). On the Done screen the user picks:
   **Delete now**, **Remind me in 1 day / 3 days / 1 week**, or **Keep it**.
   A reminder is stored on the machine that owns the project and, when due,
   shows an ADE banner ("The old copy of ADE is still on the internal disk,
   18 GB. Delete it?") with Delete, Remind later and Keep. ADE never deletes
   without that click. The banner and Settings show the bytes it frees.

### When the drive is not connected

Already handled by `assertProjectDataAvailable`: the project shows "plug its
drive in" and ADE creates nothing. Add: record the volume UUID with the
project and refuse to open a different volume mounted at the same path; and
make the project list show a moved-but-unplugged project as *offline*, not
missing.

### Settings UI

General → **Project health** section gets a **Location** row: the current path,
the disk it is on and its free space, and a **Move…** button (`machine:
"routed"`, so it acts on the machine that owns the project).

The dialog:

1. **Where** — a destination picker that defaults to `<other volume>/Projects/<name>`
   and lists volumes with free space; toggle "reinstall dependencies instead of
   copying (smaller, faster)".
2. **Check** — the preflight checklist with green/red rows and a fix button
   per blocker; the "ADE can't move these for you" list.
3. **Move** — one progress view: copy (bytes), repair, verify, switch.
4. **Done** — "ADE now uses the new location. The original is kept at …" with
   **Delete original** (typed confirmation, shows size) and **Keep for now**.

Remote: the action runs on the machine that owns the project; a phone or
another Mac can start and watch it but the path picker lists that machine's
volumes.

## 5. What ADE cannot fix and must tell the user

- Claude Code's own history and permissions (`~/.claude/projects`,
  `~/.claude.json`), Codex's thread list and trust entries, Cursor's
  workspace state. ADE *could* offer to migrate Claude's (the transplant code
  exists), but they belong to other apps; default is to report them.
- Python virtualenvs, and other tools that bake absolute paths (`.sst`
  artifacts, IDE workspace files): recreate after the move.
- `CLAUDE.md`, `AGENTS.md`, memory and docs that mention the old path: list
  the files and lines; do not edit them.
- pnpm store: a project on another volume needs its own store there; the
  first install downloads or copies instead of cloning.
- Xcode DerivedData and simulators stay on the internal disk.
- Docker's disk image has its own setting.
- Shell history, terminal profiles, launch agents or scripts with hard-coded
  paths.
- Lanes outside the project folder are not moved.
- Deeplinks shared before the move (unless the alias is built).

## 6. Open questions

Answered:
- Deleting the original: user picks delete now, a reminder, or keep (step 9).

- Relative worktree paths: yes. The move converts every lane and sets
  `worktree.useRelativePaths=true`.
- `node_modules`: not copied; reinstalled at the new path (pnpm store on the
  new volume).
- Old links: yes. Keep an alias from the old project id to the new one.
- Other agents' history: opt-in, this project only. The history stays in each
  tool's own folder on the internal disk; only the path-named entries inside it
  are renamed or re-pointed:
  - Claude Code: rename `~/.claude/projects/<old slug>*` folders (checked by the
    `cwd` inside each file) and copy the `~/.claude.json` `projects["<old>"]`
    entry (permissions, MCP, trust) to the new path.
  - Codex: resume already works by thread id; add the new path's trust entry
    in `config.toml`. Leave Codex's own database alone.
  - Cursor: rename `~/.cursor/projects/<old slug>`.
  - OpenCode and the others: to verify during the build.

- Post-move check: offer an agent run on the primary lane (proposal in chat).

Nothing else open for the first build.

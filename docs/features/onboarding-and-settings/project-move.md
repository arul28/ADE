# Moving a project to another folder or drive

Settings → Project → **Location** shows where the open project lives
and offers **Move…**. The move copies the project with every lane, rewrites
every place that names its old path, checks the copy, then switches over. The
original is kept, renamed, until the person deletes it. macOS only for now:
on Windows and Linux the card is absent, and its manifest entry
(`macOnly`) keeps it out of the nav, search and the command palette.

Research, the full map of stored paths and the experiments behind each rule:
[`docs/plans/project-move.md`](../../plans/project-move.md).

## Source file map

| Path | Role |
|---|---|
| `apps/ade-cli/src/services/projects/projectMove/projectMovePreflight.ts` | Read-only checks before a move: destination, drive (network, format, case), space, write access (the probe also raises the macOS external-drive prompt early), agents at work, git busy or mid-operation, lanes, plus the notes ADE can't fix. |
| `apps/ade-cli/src/services/projects/projectMove/projectMoveEngine.ts` | `runProjectMove` (prepare → copy → git → data → verify → switch), `finishSwitch`, `recoverInterruptedMoves`, `deleteParkedOriginal`. |
| `apps/ade-cli/src/services/projects/projectMove/moveCopy.ts` | `du` sizes, the file list (no live database, no search index, no sockets; `node_modules` only when dependencies are copied) and the `ditto --bom` copy with progress, `--clone` for same-volume APFS moves. |
| `apps/ade-cli/src/services/projects/projectMove/moveGitLinks.ts` | Lane links written directly in the copy (never `git worktree repair`), relative worktrees, absolute git config values, absolute symlinks, outside lanes at switch-over. |
| `apps/ade-cli/src/services/projects/projectMove/moveDatabase.ts` | SQLite-backup snapshot of `ade.db`, the path rewrite with cr-sqlite loaded, and its verification. |
| `apps/ade-cli/src/services/projects/projectMove/moveAgentHistory.ts` | Renames other tools' history folders for the project (Claude, Cursor, Droid, Qwen, Grok, Pi). ADE's own Claude homes always; the rest opt-in. |
| `apps/ade-cli/src/services/projects/projectMove/moveJournal.ts` | `<ADE_HOME>/project-moves/<moveId>.json`: one record per move, the cleanup choice and reminder. |
| `apps/ade-cli/src/services/projects/projectMove/movePreviousRoots.ts` | Resolves prior roots by following this project's move records in time order, preserving each recorded path spelling without including unrelated projects that reused a destination. |
| `apps/ade-cli/src/services/projects/projectMove/moveVolumes.ts` | Drives via `df` + `diskutil info -plist`. |
| `apps/ade-cli/src/services/projects/projectRegistry.ts` | `relocate()` re-keys the registry and writes `project-aliases.json` (old id → new id); `assertProjectNotMovedAway` and `assertProjectNotBeingMoved` refuse opening the kept original or a project mid-move, on every open path. |
| `apps/desktop/src/main/services/projects/projectMoveController.ts` | One move at a time and one delete per move; activity, release, reopen and progress wiring come from `main.ts`. |
| `apps/desktop/src/main/services/projects/projectMoveController.test.ts` | Delete concurrency and repeat-delete behavior through the controller API. |
| `apps/desktop/src/main/services/ipc/registerIpc.ts` | Forwards the `copyDependencies` choice from the desktop IPC request to the move controller. |
| `apps/desktop/src/renderer/components/projectMove/` | `MoveProjectDialog` (one setup screen with the drive, folder and checks → Moving → Done), `ProjectMoveHost` (the dialog host and the old-copy banner), the agent check prompt. |
| `apps/ade-cli/src/services/projects/projectMove/projectMoveEngine.test.ts` | Whole moves on real git repos and project data, Codex trust carry-over, interrupted-move recovery, and the journal's process check. |
| `apps/desktop/src/renderer/components/projectMove/projectMove.test.tsx` | The old-copy banner shows only in the moved project's tab; the check agent launches only on Start agent, ask-first, with the edited prompt. |
| `apps/desktop/src/renderer/components/settings/ProjectLocationSection.tsx` | The Settings row. `machine: "local"`. |

## How a move runs

1. **Prepare.** Close the project in every window and in the background
   service, then wait until `lsof` shows nothing holding `ade.db`.
2. **Copy** into `<destination>.ade-moving`, a name nothing opens. The
   database goes through SQLite's backup API so its write-ahead log is kept.
   On the same volume, when the destination is APFS, the copy uses APFS clones:
   near-instant and with no preflight space check; dependencies come along as
   clones too. On other destinations, `node_modules` come along when
   **Copy dependencies too** is on (the default when there is room), including
   through the desktop IPC bridge; otherwise they are reinstalled afterwards.
   The search index is a cache and is rebuilt, not copied.
3. **Git.** For each lane inside the project, write `<lane>/.git` and
   `.git/worktrees/<name>/gitdir` as relative links computed for the final
   location; set `core.repositoryformatversion=1` *before*
   `extensions.relativeWorktrees` (the other order makes git refuse the repo)
   and `worktree.useRelativePaths=true`; rewrite git config values and
   symlinks that name the old root.
4. **Data.** Rewrite the path columns in one transaction with the sync
   extension loaded, so the change syncs like any edit. Ids are kept.
5. **Verify.** Same file count, database check, same project and lanes, no
   path column still naming the old root, every lane's git common dir is the
   copy's, and each lane's `git status` matches the original's.
6. **Switch.** Re-check the drive's UUID, rename the original to
   `<name> (moved to <drive>)`, rename the copy into place, then
   `finishSwitch`: outside lanes, the moved marker, the registry, simulator
   markers, history folders.

Any failure before the switch deletes the partial copy and reopens the
untouched original.

## After the move

- **Done** offers the check agent and the old-copy choice; neither is
  required. *Set up…* opens the issue launchers' picker in place
  (`SessionLaunchModelControls`: model, effort, permissions) with the check
  prompt editable. Permissions start ask-first (`askFirstNativeControls`, not the usual
  full-access default), since
  the prompt promises to ask before changing anything; nothing launches until
  *Start agent*, and the chat shows the whole prompt. The old
  copy's Keep / Remind me / Delete can wait: the card says it can be cleaned
  up later from Settings → Location.
- **The old-copy banner** shows only in the moved project's tab, matched to its
  move record and destination; a reused folder path does not make an unrelated
  project's move record apply.
- **Trust.** `finishSwitch` copies folder trust to the new path, append only:
  Codex `trust_level` in `$CODEX_HOME/config.toml`, Claude Code's
  `projects["<path>"]` entries (trust, allowed tools, MCP approvals) in
  `~/.claude.json` and each ADE Claude home, and Copilot's `trustedFolders`.
- **Health.** Settings → Location and Overview (and `ade health`) check a moved project for
  anything left behind and fixes it in place; see
  [`project-health.md`](./project-health.md). The check agent's prompt carries
  the preflight's notes, what ADE did and couldn't do, and points at
  `ade health`.

## External drives

- **Simulator screenshots.** CoreSimulatorService can't show macOS's
  external-drive prompt, so `simctl io screenshot`/`recordVideo` into a
  project on another drive fails with "Operation not permitted" (tested).
  `ade apple` captures into the internal temp folder and ADE writes the file.
  Installs, `xcodebuild` builds and XCTest from the drive work (tested).
- **Preflight notes** for an external drive: keep it connected, Simulator
  capture, Time Machine not backing it up (external drives are excluded by
  default).
- **Other holders.** Preflight names processes other than ADE that have
  `ade.db` open (usually a dev build started from a lane); the move stops
  before changing anything if they don't let go.

## Gotchas

- **Never run `git worktree repair` on a copy.** Even with explicit lane paths
  it also repairs any registered lane it can reach outside the copy, which
  moved an outside lane from the original to the temporary copy in testing.
- **Every step must stop the move on error.** A copy without its database
  opens as a new project and adopts every worktree as a new lane with a new
  id, stranding chats.
- **A stale `lanes.worktree_path` orphans lanes.** Opening a plain copy makes
  a second project row and a new primary lane; the old lanes hang on the old
  project id. That is why the database is rewritten before anything opens the
  copy.
- **Match every spelling of the old root.** One project can store
  `/private/tmp/x` for itself and `/tmp/x` for its lanes, and after the rename
  the old folder can no longer be resolved to its real path.
- **The drive's name is not its identity.** With the drive unplugged, another
  drive with the same name mounts at the same path and is writable; the move
  records and re-checks the volume UUID.
- **An interrupted move** is settled at startup by `recoverInterruptedMoves`:
  before the copy is in place the original is put back and the partial copy
  removed; once the copy is in place the move is only ever finished, never
  undone (with the drive unplugged it waits for a later start).
- **Remote:** the move needs this computer's disk and windows, so the section
  is `machine: "local"`, and a project open from another machine shows "Move
  it from ADE on that computer" instead of the button.

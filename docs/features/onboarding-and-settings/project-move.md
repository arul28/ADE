# Moving a project to another folder or drive

Settings → Project → **Location** shows where the open project lives and offers
**Move…**. The move copies the project with every lane, rewrites every place
that names its old path, checks the copy, then switches over. The original is
kept, renamed, until the person deletes it. macOS only: on Windows and Linux the
card is absent (`macOnly` in the manifest).

Before a move starts, the dialog measures the project with `du` (dependencies
included). That can take over a minute; a re-check joins the running
measurement. If the size cannot be read (over ten minutes, or unreadable), the
move stays disabled rather than treating the project as empty.

## Source file map

Under `apps/ade-cli/src/services/projects/projectMove/` unless noted:

- `projectMovePreflight.ts`: read-only checks (destination, drive format and
  case, space, write access, agents at work, git busy, lanes) and notes DAEX
  can't fix.
- `projectMoveEngine.ts`: `runProjectMove` (prepare → copy → git → data →
  verify → switch), `finishSwitch`, `recoverInterruptedMoves`,
  `deleteParkedOriginal`.
- `moveCopy.ts`: `du` sizes, the file list and the `ditto --bom` copy
  (`--clone` for same-volume APFS).
- `moveGitLinks.ts`: lane links written directly in the copy, relative
  worktrees, git config values, symlinks, outside lanes.
- `moveDatabase.ts`: SQLite-backup snapshot of `ade.db` and the path rewrite
  with cr-sqlite loaded.
- `moveAgentHistory.ts`: renames other tools' history folders for the project.
- `moveJournal.ts`: `<ADE_HOME>/project-moves/<moveId>.json`, one record per
  move. `movePreviousRoots.ts`: the ordered move chain.
- `moveVolumes.ts`: drives via `df` and `diskutil info -plist`.
- `apps/ade-cli/src/services/projects/projectRegistry.ts`: `relocate()` re-keys
  the registry and writes `project-aliases.json`; `assertProjectNotMovedAway` /
  `assertProjectNotBeingMoved` refuse opening the kept original or a project
  mid-move.
- `apps/desktop/src/main/services/projects/projectMoveController.ts`: one move
  at a time, one delete per move.
- `apps/desktop/src/renderer/components/projectMove/`: `MoveProjectDialog`,
  `ProjectMoveHost` (dialog host and old-copy banner).
- `apps/desktop/src/renderer/components/settings/ProjectLocationSection.tsx`:
  the Settings row (`machine: "local"`).

## How a move runs

1. **Prepare**: close the project in every window and the background service;
   wait until `lsof` shows nothing holding `ade.db`.
2. **Copy** into `<destination>.ade-moving`. The database goes through
   SQLite's backup API. Same-volume APFS moves use clones (no space check).
   Elsewhere `node_modules` come along when **Copy dependencies too** is on
   (forwarded through `registerIpc.ts`), else they are reinstalled. The search
   index is rebuilt, not copied.
3. **Git**: write each lane's `.git` and `gitdir` as relative links for the
   final location; set `core.repositoryformatversion=1` before
   `extensions.relativeWorktrees` (the other order makes git refuse the repo);
   rewrite config values and symlinks naming the old root.
4. **Data**: rewrite path columns in one transaction with the sync extension
   loaded, so the change syncs. Ids are kept.
5. **Verify**: same file count, database check, same project and lanes, no path
   still naming the old root, each lane's git common dir and `git status` match.
6. **Switch**: re-check the drive UUID, rename the original to `<name> (moved
   to <drive>)`, rename the copy into place, then `finishSwitch` (outside
   lanes, registry, simulator markers, history folders, folder trust).

Any failure before the switch deletes the partial copy and reopens the original.

## After the move

- **Done** offers a check agent (ask-first permissions, launched only on
  **Start agent**) and the old copy's Keep / Remind me / Delete, which can wait.
- **The old-copy banner** shows only in the moved project's tab.
- **Trust** is copied append-only: Codex `trust_level`, Claude Code's
  `projects["<path>"]` in `~/.claude.json` and each DAEX Claude home, Copilot's
  `trustedFolders`.
- **Health** checks for anything left behind and fixes it in place
  ([project-health.md](./project-health.md)).
- **Not changed**: other tools' history and permissions (beyond trust),
  virtualenvs and files with absolute paths, docs naming the old path, the pnpm
  store, DerivedData, simulators, Docker's disk image, shell history, lanes
  outside the project, deeplinks shared before.

External drives: `simctl io screenshot` into a project on another drive fails
("Operation not permitted"), so `daex apple` captures to internal temp and DAEX
writes the file. Preflight names other processes holding `ade.db`.

## Gotchas

- **Never run `git worktree repair` on a copy.** It also repairs lanes it can
  reach outside the copy, and moved an outside lane to the temp copy in testing.
- **Every step must stop the move on error.** A copy without its database opens
  as a new project and adopts every worktree as a new lane, stranding chats.
- **Rewrite the database before anything opens the copy**, or a stale
  `lanes.worktree_path` orphans lanes on a second project row.
- **Match every spelling of the old root** (`/private/tmp/x` vs `/tmp/x`).
- **A drive's name is not its identity**; the move records and re-checks the
  volume UUID.
- **Interrupted moves** are settled at startup by `recoverInterruptedMoves`:
  before the copy is in place the original is restored; after, the move is only
  ever finished.
- **Remote**: the move needs this computer's disk, so a project open from
  another machine shows "Move it from DAEX on that computer".

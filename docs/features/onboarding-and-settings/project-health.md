# Project health

Settings → **Health** lists what is wrong with the open project, why it
matters, and a fix for what ADE can fix. `ade health --text` prints the same
list. Checks only read; a fix runs when the person presses it (fixes are
CTO-only at the action bridge, so agents read the report and offer fixes).

Most checks matter after a project moves (see
[`project-move.md`](./project-move.md)); the rest hold for any project.

## Source file map

| Path | Role |
|---|---|
| `apps/ade-cli/src/services/projects/projectHealth/projectHealthService.ts` | `getReport` (all checks, cached 30 s) and `fix`. Runs in the brain that owns the project. |
| `apps/desktop/src/shared/types/projectHealth.ts` | Report, issue, fix and fix-result types. |
| `apps/ade-cli/src/services/projects/projectMove/moveJournal.ts` | `previousProjectRoots`: where the project lived before, from ADE's move records. |
| `apps/ade-cli/src/services/projects/projectMove/moveDatabase.ts` | `countPathsNaming` / `rewritePathsInDatabase`: the same path rewrite the move runs, on any connection. |
| `apps/desktop/src/main/services/adeActions/registry.ts` | `project_health` action domain (`getReport`, `fix`). |
| `apps/desktop/src/preload/preload.ts` | `window.ade.projectHealth.{getReport,fix}`, routed with the Settings machine pin. |
| `apps/ade-cli/src/cli.ts` | `ade health [--refresh] [--fix <id>]`. |

## Checks

| Check | Problem it finds | Fix |
|---|---|---|
| `stale-paths` | Saved paths (lanes, proof metadata, layout keys, kv path fields) still name a folder the project was moved out of | `update-paths`: the move's rewrite, through the brain's own connection so it syncs |
| `lane-folders` | Active lanes whose folder is gone | none (restore or archive) |
| `git-links` | A lane's `.git` points at another repository or a missing folder, or the repository doesn't link back | `relink-lanes` (after a move): relative links, as the move writes them |
| `symlinks` | Absolute links still pointing at the old folder | `relink-symlinks` |
| `dependencies` | A checkout's install is missing or empty, or a lane's link to the main checkout's install is broken | `install-dependencies`: a terminal per checkout running its `setup` script or `<pm> install`. Lanes linked to the main checkout are fixed by installing the main checkout, never reinstalled one by one |
| `virtualenvs` | A Python venv whose scripts name another folder | none (recreate) |
| `agent-trust` | Claude Code, Codex or Copilot trusted the old folder but not this one | `carry-trust`: copies `~/.claude.json` `projects[...]`, Codex `config.toml` trust and Copilot `trustedFolders` (append only) |
| `agent-history` | Other tools' history still filed under the old path | `move-history`: renames folders, never overwrites |
| `simulators` | Lane simulators that record the old folder | `repoint-simulators` |
| `mentions` | Files that name the old folder (git grep + common untracked config) | none; an agent goes through them with the person |
| `old-copy` | The parked original still on disk | delete from Settings → Project location |
| `drive` | A different drive mounted under the project's drive name; no Time Machine backup | none |

## Gotchas

- **No move record, no stale-path fixes.** Fixes that rewrite paths need to know
  the old folder; they read it from `<ADE_HOME>/project-moves/*.json`, which
  survives deleting the old copy. A project moved by hand (Finder) has none.
- **Dependencies in lanes.** ADE lanes usually link `node_modules` to the main
  checkout's. A lane is only expected to have its own top-level install; a
  missing `apps/*` install in a lane is normal.
- **`~/.claude.json` is always included,** even when `CLAUDE_CONFIG_DIR` points
  at an ADE Claude home (as it does inside ADE's own agent processes).
- **Remote:** every call carries the Settings machine pin; the checks run on
  the machine that owns the project.

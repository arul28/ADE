# Project health

Project health checks appear in Settings → General (Needs attention) and Settings → Project →
Location, and `ade health --text` prints the same report. Checks only read; a
fix runs when the person presses it. The `project_health.fix` action is
CTO-only at the action bridge, so agents can read the report and offer fixes
but cannot apply them. `ade health --fix <id>` returns a non-zero exit code
when the requested fix fails.

Most checks matter after a project moves (see
[`project-move.md`](./project-move.md)); the rest hold for any project.

## Source file map

| Path | Role |
|---|---|
| `apps/ade-cli/src/services/projects/projectHealth/projectHealthService.ts` | `getReport` (all checks, cached 30 s) and `fix`. Runs in the brain that owns the project. |
| `apps/desktop/src/shared/types/projectHealth.ts` | Report, issue, fix and fix-result types. |
| `apps/ade-cli/src/services/projects/projectMove/movePreviousRoots.ts` | `previousProjectRoots`: follows this project's move chain in time order and retains each recorded spelling of every prior root. |
| `apps/ade-cli/src/services/projects/projectMove/moveDatabase.ts` | `countPathsNaming` / `rewritePathsInDatabase`: the same path rewrite the move runs, on any connection. |
| `apps/desktop/src/main/services/adeActions/registry.ts` | `project_health` action domain (`getReport`, `fix`). |
| `apps/desktop/src/preload/preload.ts` | `window.ade.projectHealth.{getReport,fix}`, routed with the Settings machine pin. |
| `apps/desktop/src/main/services/adeActions/actionPolicy.ts` | Restricts `project_health.fix` to the CTO role at the action bridge. |
| `apps/ade-cli/src/cli.ts` | `ade health [--refresh] [--fix <id>]`. |

## Checks

| Check | Problem it finds | Fix |
|---|---|---|
| `stale-paths` | Saved paths (lanes, proof metadata, layout keys, kv path fields) still name a folder the project was moved out of | `update-paths`: the move's rewrite in one database transaction, through the brain's own connection so it syncs. Layout kv rows already saved at the new root are preserved; when a move itself collides, the moved row wins. |
| `Lanes` check failure | ADE could not read lane state | The report includes a failed `Lanes` check and a `lanes-failed` issue. It does not report an empty lane list as success. |
| `lane-folders` | Active lanes whose folder is gone | none (restore or archive) |
| `git-links` | A lane's `.git` points at another repository or a missing folder, or the repository doesn't link back | `relink-lanes` (after a move): relative links, as the move writes them |
| `symlinks` | Absolute links still pointing at the old folder | `relink-symlinks` |
| `dependencies` | A checkout's install is missing or empty, or a lane's link to the main checkout's install is broken | ADE skips well-formed scripts-only manifests, but unreadable manifests and workspace roots count as install units; pnpm workspaces use their shared root install. `install-dependencies` opens a terminal per checkout running its `setup` script or `<pm> install`. Lanes linked to the main checkout are fixed by installing the main checkout, never reinstalled one by one |
| `virtualenvs` | A Python venv whose scripts name another folder | none (recreate) |
| `agent-trust` | Claude Code, Codex or Copilot trusted the old folder but not this one | `carry-trust`: copies `~/.claude.json` `projects[...]`, Codex `config.toml` trust and Copilot `trustedFolders` (append only) |
| `agent-history` | Other tools' history still filed under the old path | `move-history`: renames folders, never overwrites |
| `simulators` | Lane simulators that record the old folder | `repoint-simulators` |
| `mentions` | Files that name the old folder (git grep + common untracked config) | none; an agent goes through them with the person |
| `old-copy` | The parked original still on disk | delete from Settings → Location |
| `drive` | A different drive mounted under the project's drive name; no Time Machine backup | none |
| `stale-lanes` | Lanes whose PR is merged or closed, or with no activity for 14 days (no open PR) | archive from Settings → Project → Lanes, one by one or in bulk (only lanes that are safe) |
| `stuck-sessions` | Chats or terminals marked running whose owning process is gone | none; open each and stop or resume it |
| `git-leftovers` | Lock files older than 10 minutes, a rebase/merge/cherry-pick stopped halfway | none; finish or abort it, remove the lock |

## Lanes

The report carries `lanes`: every active lane with its PR (newest for the
lane), last activity (latest chat/terminal output, creation or branch tip), git
state (`git status` and `rev-list HEAD --not --remotes`, read without locks)
and `stale`. `safeToArchive` means archiving loses nothing: no uncommitted
files and no commits that exist only in the lane. A squash-merged PR's branch is
usually deleted from the remote, so commits up to the PR's recorded head count
as saved. `safeToArchive` is about git only. The lane archive stops running
chats and terminals after confirmation. Bulk archive re-reads each lane's git
state before applying the merged-PR exception, then checks reclaim risk; it
skips and names dirty, active, or unpushed lanes (and any lane requiring
confirmation) before calling the ordinary pinned `lanes.archiveAndReclaim`
for eligible lanes.

## Gotchas

- **No move record, no stale-path fixes.** Fixes that rewrite paths need to know
  the old folder; they follow this project's ordered move chain in
  `<ADE_HOME>/project-moves/*.json`, which survives deleting the old copy. A
  project moved by hand (Finder) has none.
- **Dependencies in lanes.** ADE lanes usually link `node_modules` to the main
  checkout's. A lane is only expected to have its own top-level install; a
  missing `apps/*` install in a lane is normal.
- **Malformed manifests.** A `package.json` that cannot be parsed or is not an
  object remains an install unit so one half-edited lane manifest does not hide
  the dependency check; ADE logs read failures locally.
- **`~/.claude.json` is always included,** even when `CLAUDE_CONFIG_DIR` points
  at an ADE Claude home (as it does inside ADE's own agent processes).
- **Failed reads stay visible as failures.** A failed lane read becomes a
  failed `Lanes` check and `lanes-failed` issue, not a successful empty list;
  Overview likewise shows a "couldn't check" row if a source read fails.
- **Install containment uses real paths.** Health resolves filesystem paths
  before deciding whether an install target belongs inside the project, so a
  string-prefix sibling or a link cannot be mistaken for a contained target.
- **Relinking reports untouched lanes.** `relink-lanes` describes lanes it
  leaves alone as well as those it changes.
- **Remote:** every call carries the Settings machine pin; the checks run on
  the machine that owns the project.

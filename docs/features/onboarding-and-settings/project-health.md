# Project health

Project health checks show in Settings → General (Needs attention) and Settings
→ Project → Location; `daex health --text` prints the same report. Checks only
read; a fix runs when the person presses it. `project_health.fix` is CTO-only at
the action bridge, so agents can read the report and offer fixes but not apply
them. `daex health --fix <id>` exits non-zero when the fix fails.

Most checks matter after a project moves ([project-move.md](./project-move.md)).

## Source file map

- `apps/ade-cli/src/services/projects/projectHealth/projectHealthService.ts`:
  `getReport` (all checks, cached 30 s), `fix`, ignores. Runs in the brain that
  owns the project.
- `apps/desktop/src/shared/types/projectHealth.ts`: report, issue and fix types.
- `apps/ade-cli/src/services/projects/projectMove/movePreviousRoots.ts`
  (`previousProjectRoots`, the move chain) and `moveDatabase.ts` (the path
  rewrite the move runs).
- `apps/desktop/src/main/services/adeActions/actionPolicy.ts`: `fix` is
  CTO-only; `ignore` / `unignore` are user-only.
- `apps/desktop/src/preload/preload.ts`: `window.ade.projectHealth.*`, routed
  with the Settings machine pin.
- `apps/desktop/src/renderer/components/settings/health/ProjectIgnore.tsx`: the
  ignore button, the folded "N ignored items" list, `useProjectIgnore`.
- `apps/ade-cli/src/cli.ts`: `daex health [--refresh] [--fix <id>]`.
  `--ignore` / `--unignore` point to Settings, since the runtime cannot tell a
  terminal from an agent.

## Checks

| Check | Finds | Fix |
|---|---|---|
| `stale-paths` | Saved paths still naming a folder the project moved out of | `update-paths`: the move's rewrite in one transaction on the brain's connection, so it syncs |
| `lanes-failed` | Lane state could not be read (never reported as an empty list) | — |
| `lane-folders` | Active lanes whose folder is gone | — (restore or archive) |
| `git-links` | A lane's `.git` points elsewhere, or the repository doesn't link back | `relink-lanes` (reports untouched lanes too) |
| `symlinks` | Absolute links into the old folder | `relink-symlinks` |
| `dependencies` | A checkout's install is missing, or a lane's link to the main checkout's install is broken | `install-dependencies`: one terminal per folder running `<pm> install` in that folder (no `cd && …`, which PowerShell 5.1 cannot run); when the root has nothing installed, only the root install runs. Linked lanes are fixed by installing the main checkout |
| `virtualenvs` | A Python venv naming another folder | — (recreate) |
| `agent-trust` | Claude Code, Codex or Copilot trusted the old folder only | `carry-trust` (append only) |
| `agent-history` | Other tools' history filed under the old path | `move-history` (renames, never overwrites) |
| `simulators` | Lane simulators recording the old folder | `repoint-simulators` |
| `mentions` | Files naming the old folder | — (go through them with an agent) |
| `old-copy` | The parked original still on disk | delete from Settings → Location |
| `drive` | A different drive under the project's drive name; no Time Machine backup | — |
| `network-share` | Windows project on a WSL or network share, where SQLite can lock | — (keep projects on a local drive) |
| `stale-lanes` | Lanes with a merged/closed PR, or 14 days idle with no open PR | archive from Settings → Project → Lanes |
| `stuck-sessions` | Chats or terminals marked running whose process is gone | — |
| `git-leftovers` | Lock files older than 10 minutes; a stopped rebase, merge or cherry-pick | — |

## Ignoring a check

Two ways, from the eye-slash on a row:

- **Ignore a folder**: a line that lists `ignorablePaths` (today only
  `dependencies`, for a main-checkout folder other than the root) skips that
  folder entirely until the person shows it again.
- **Hide until it changes**: any line except a problem or a failed check. The
  client sends the line as seen; the brain refuses if it reads differently now.
  The fingerprint (id, title, items) hides it only while it reads the same.
  Reading the report never writes.

Both are `kv` rows in the project database (`project_health.ignored:<key>`, at
most 200), so they sync to every copy and two computers never overwrite each
other. A line hide records its copy; only that copy reads or retires it. Agents
cannot ignore or unignore.

General rows that are not the project's (providers, machines, MCP) hide on this
computer only, in local storage, with the same "until it changes" rule.

## Lanes

The report carries `lanes`: each active lane with its newest PR, last activity,
git state and `stale`. `safeToArchive` means archiving loses nothing in git (no
uncommitted files, no lane-only commits; commits up to a squash-merged PR's head
count as saved). Bulk archive re-reads git state, skips dirty, active or
unpushed lanes, and archives the rest through the pinned
`lanes.archiveAndReclaim`.

## Gotchas

- **No move record, no path fixes.** Rewrites follow the move chain in
  `<ADE_HOME>/project-moves/*.json`. A project moved by hand has none.
- **Lanes usually link `node_modules`** to the main checkout; a missing
  `apps/*` install in a lane is normal.
- **A malformed `package.json` stays an install unit**, so one half-edited
  manifest does not hide the check.
- **`~/.claude.json` is always included**, even when `CLAUDE_CONFIG_DIR` points
  at a DAEX Claude home.
- **Install containment uses real paths**, so a prefix sibling or a link is not
  mistaken for a contained target.
- **Remote**: every call carries the Settings machine pin; checks run on the
  project's machine.

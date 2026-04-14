# Runtime Isolation for Sessions

Every interactive terminal, every managed process run, every agent
chat session runs *inside a specific lane worktree*. The session
system encodes that as a hard invariant: `laneId` is required on
`PtyCreateArgs`, the lane's worktree directory is the only legal
spawn cwd, and resume flows will not cross lanes.

This document covers the gating, fallback behavior, and per-mission
scoping that makes "which work runs where" a deterministic answer.

## Lane gating: `resolveLaneLaunchContext`

File: `apps/desktop/src/main/services/lanes/laneLaunchContext.ts`

Single entry point for "convert `{ laneId, requestedCwd? }` into a
real, bounded cwd". Used by:

- `ptyService.create` (for every interactive terminal and agent chat
  PTY)
- `processService.startByDefinition` (indirectly — it resolves the
  lane worktree, then calls `resolvePathWithinRoot` itself using the
  same primitives)

Behavior:

1. Rejects an empty `laneId`.
2. Calls `laneService.getLaneBaseAndBranch(laneId)` to recover the
   configured worktree path. Throws if the lane has no worktree
   configured.
3. Validates the worktree directory exists on disk
   (`ensureDirectoryExists`) and resolves it through
   `fs.realpathSync`. Throws the "unavailable" error if the directory
   was deleted out from under ADE.
4. If `requestedCwd` is empty, returns `laneWorktreePath === cwd`.
5. Otherwise resolves `requestedCwd` against the lane worktree and
   requires it to stay inside the worktree root via
   `resolvePathWithinRoot`. Path escapes throw:
   `Requested cwd '<x>' escapes lane '<laneId>'. ADE only launches
   work inside the selected lane worktree '<root>'.`
6. Requires the resolved path to be an existing directory.

Consequence: there is no way for a PTY caller to spawn in the primary
worktree when a lane is selected, and no way to spawn outside the
worktree via `..` segments or symlinks.

`resolvePathWithinRoot` (in
`apps/desktop/src/main/services/shared/utils.ts`) is the shared
primitive. It resolves, normalizes, and compares against the root
prefix.

## Process cwd gating

`processService.startByDefinition` follows the same pattern:

```ts
const laneRoot = laneService.getLaneWorktreePath(laneId);
const configuredCwd = opts.overlay?.cwd?.trim() ? opts.overlay.cwd : definition.cwd;
const cwdCandidate = path.isAbsolute(configuredCwd) ? configuredCwd : path.join(laneRoot, configuredCwd);
try {
  cwd = resolvePathWithinRoot(laneRoot, cwdCandidate);
} catch (error) {
  // distinguishes "does not exist" from "escapes root"
}
```

Overlay policies can override `cwd` but the override must still resolve
within the lane worktree. `env` overrides are merged over the lane's
runtime env (from `getLaneRuntimeEnv`) over the definition's `env`.

## Per-lane runtime env

The lane environment is produced by `laneService.getLaneRuntimeEnv`
(via `laneEnvironmentService`) and usually includes:

- `PRIMARY_WORKTREE_PATH` — the primary repo root (for lane setup
  scripts that need to sync from upstream)
- lane-scoped overrides from `LaneEnvInitConfig.envFiles` (template
  substitutions like `{{port}}`, `{{hostname}}`)
- lane template `envVars`
- port allocations resolved via `portAllocationService`
- proxy hostname when a proxy route is active

Both `ptyService.create` and `processService.startByDefinition` merge
this env in before `args.env` / overlay env, so individual launches can
still override values.

## Session-to-lane binding

Every `terminal_sessions` row stores `lane_id` (NOT NULL, joined to
`lanes` on every query). The join lives in `sessionService.SESSION_COLUMNS`:

```sql
from terminal_sessions s
join lanes l on l.id = s.lane_id
```

Consequences:

- Deleting a lane cascades (lanes own the join); orphan session rows do
  not appear in `list()`.
- The session list can be filtered by `laneId`; lane panels do so to
  show only their sessions.
- `ptyService.create` validates `existingSession.laneId === args.laneId`
  on resume. Cross-lane resume fails with:
  `Terminal session '<id>' belongs to lane '<otherLaneId>', not '<laneId>'.`

## Resume isolation

A resumed session keeps its identity:

- same row (`sessionService.reattach` resets runtime fields, not identity)
- same `laneId`
- same `transcriptPath` (opened in append mode)
- same `resumeMetadata` (so the CLI reconnects to the same Claude
  session / Codex thread)

If the CLI assigns a new session ID at runtime, `ptyService`
backfills it into `resumeMetadata.targetId` via the transcript scan
and/or Claude/Codex local storage lookup.

## Mission scoping

Missions run through the orchestrator (`aiOrchestratorService`,
`missionLifecycle`) and launch PTYs or agent chats via the same
`ptyService.create` + `agentChatService` entry points. Each mission
step operates inside:

- the mission's assigned lane (missions own a `laneId`)
- optionally, an integration lane for cross-lane simulation

Missions do not bypass `resolveLaneLaunchContext`; they go through the
same gate, which means mission work stays inside its lane's worktree.

Mission-level execution policy (see
`apps/desktop/src/shared/types/missions.ts` and
`orchestrator/executionPolicy.ts`) additionally controls:

- which tools the agent may call
- permission mode (Claude `auto`/`plan`/`allow`, Codex approval
  policies and sandbox modes)
- network/fs sandboxing flags passed through as resume metadata

## Managed process scoping

A managed process defined in `.ade/ade.yaml` runs in:

- the caller-supplied lane (typically the Run tab's selected lane)
- the resolved cwd inside that lane's worktree
- the lane runtime env merged with the definition's env and the
  overlay's env

`LaneOverlayPolicy` can restrict `processIds` per lane, so you can
define dev-server processes that only run in lanes matching a name
pattern or lane type. `applyProcessFilter` is the enforcement point.

## Fallback and diagnostics

`runtimeDiagnosticsService.ts`
(`apps/desktop/src/main/services/lanes/runtimeDiagnosticsService.ts`)
aggregates lane runtime health for the Lanes tab and the proxy pane.
It marks a lane as `degraded` when:

- the proxy server is running but no route exists for this lane
- the proxy is down entirely
- fallback mode has been activated (direct port access, bypassing
  isolation)

Fallback mode is a deliberate opt-out: the user flips a lane into
"direct port access" when the proxy is misbehaving. Sessions still run
inside the lane worktree, but hostname-based isolation is off.

## What isolation does NOT cover

- **Shared filesystem locations** — `~/.claude/`, `~/.codex/`, global
  npm/yarn/pip caches, host-level docker daemon. The PTY inherits
  `process.env` including `HOME`, so CLIs write to their usual user
  paths regardless of the lane.
- **Network sockets** — lane port ranges are advisory; processes can
  bind to any free port unless explicitly constrained.
- **Shared database** — ADE's own SQLite file is per-project, not per
  lane. All lanes in a project write into the same `terminal_sessions`
  table.
- **Parent-process env leakage** — tools launched by a PTY see the
  PTY's env plus whatever the OS gives a child process. If you set a
  secret in the host shell and Electron inherits it, the lane can see
  it too.

If you need stronger isolation (containers, VPS, Daytona), use the
compute-backend hooks in `LaneOverlayOverrides.computeBackend`. That
is out of scope for `ptyService` itself.

## Cross-links

- Session lifecycle: [pty-and-processes.md](./pty-and-processes.md)
- Lanes feature (branch/worktree management): [../lanes/](../lanes/)
- Configuration schema for overlays and templates:
  [../onboarding-and-settings/configuration-schema.md](../onboarding-and-settings/configuration-schema.md)

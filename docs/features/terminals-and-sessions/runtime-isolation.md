# Runtime isolation for sessions

Every project terminal and agent chat runs inside one lane's worktree:
`laneId` is required on `PtyCreateArgs`, the worktree is the only legal spawn
cwd, and continuation never crosses lanes. (A projectless personal chat has its
own scratch-folder terminal; see the [README](./README.md).) The gate runs on
the machine that holds the lane, so for a remote binding `fs.realpathSync`
checks the remote filesystem. The renderer never spawns directly.

## Source file map

| File | Responsibility |
|------|----------------|
| `apps/desktop/src/main/services/lanes/laneLaunchContext.ts` | `resolveLaneLaunchContext`: lane id and requested cwd → a bounded cwd. |
| `apps/desktop/src/main/services/shared/utils.ts` | `resolvePathWithinRoot`, the shared containment check. |
| `apps/desktop/src/main/services/pty/ptyService.ts` | Calls the gate on every create; merges the lane env; refuses cross-lane reattach. |
| `apps/desktop/src/main/services/sessions/sessionService.ts` | `terminal_sessions` rows, joined to `lanes` on reads. |
| `apps/desktop/src/main/services/shared/providerConfigHomes.ts` | Where provider CLIs keep their homes. |

## Lane gate: `resolveLaneLaunchContext`

1. Rejects an empty `laneId`.
2. Reads the worktree path (`laneService.getLaneBaseAndBranch`); throws when
   the lane has none.
3. Checks the folder exists and resolves it with `fs.realpathSync`; a deleted
   folder throws the "unavailable" error.
4. No requested cwd → the worktree root.
5. Otherwise resolves the cwd inside the worktree with `resolvePathWithinRoot`.
   An escape throws `Requested cwd '<x>' escapes lane '<laneId>'. DAEX only
   launches work inside the selected lane worktree '<root>'.`
6. The result must be an existing directory.

So no caller can spawn in the main checkout while a lane is selected, or leave
the worktree through `..` or a symlink. Worker and subagent launches use the
same entry points and the same gate.

## Lane environment

`createPtyService` takes an optional `getLaneRuntimeEnv`. The desktop main
process passes one (`main.ts`: `PORT`, `PORT_RANGE_START`, `PORT_RANGE_END`,
`HOSTNAME`, `PROXY_HOSTNAME` from the port lease and proxy route); the
brain's `bootstrap.ts` currently passes none, so brain-spawned terminals get no
extra lane env from it. When present it is merged before `args.env`, so a
launch can override it. Setup scripts get their own lane variables; see
[Lanes › runtime](../lanes/runtime.md#setup-script-execution).

## Session-to-lane binding

Every `terminal_sessions` row has a `lane_id`; session reads `join lanes l on
l.id = s.lane_id`, so rows of a deleted lane never list. Lane panels filter by
lane. A reattach checks `existingSession.laneId === args.laneId` and otherwise
throws `Terminal session '<id>' belongs to lane '<other>', not '<laneId>'.`

A continued session keeps its row (`sessionService.reattach` resets runtime
fields only), lane, transcript path (append mode) and `resumeMetadata`. A
provider session id assigned at runtime is backfilled into
`resumeMetadata.targetId`.

## What isolation does not cover

- **Provider homes and caches** (`~/.claude`, `~/.codex`, `~/.factory`,
  package caches, the Docker daemon). The PTY inherits `HOME`, so CLIs write to
  their usual paths. Those paths follow `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
  `FACTORY_HOME_OVERRIDE` and the like, which is why every DAEX read of them goes
  through `providerConfigHomes.ts`.
- **Ports:** lane ranges are advisory.
- **The project database** is shared by all lanes of a project.
- **Inherited env:** a secret in the parent environment reaches the lane.

DAEX has no container or VM isolation for lanes. Hostname isolation and
fallback mode are in [Lanes › runtime](../lanes/runtime.md#runtime-diagnostics).

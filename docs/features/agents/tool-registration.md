# Tool Registration

Agents get their action palette through two distinct paths: in-process
tool objects for managed chat runtimes, and the ADE CLI for agents or
shell sessions that need to invoke ADE actions out of process. Both
paths converge on the same service registry and apply role-based
filtering before exposing the final list.

## Source file map

| Path | Role |
|---|---|
| `apps/ade-cli/src/adeRpcServer.ts` | Private ADE action RPC. Defines action specs, session identity, role-based filtering, the executor, and lane-scoped ADE guidance / skill-root env for worker CLI launches. `create_pr_from_lane` returns the PR payload plus GitHub and ADE PR URLs when they can be derived. |
| `apps/ade-cli/src/multiProjectRpcServer.ts` | Machine-runtime JSON-RPC surface. Owns `projects.*`, runtime events, sync methods, and project-scoped `ade/actions/*` dispatch by `projectId`. |
| `apps/ade-cli/src/bootstrap.ts` | Builds per-project `AdeRuntime` scopes for the machine runtime, SSH stdio runtime, and explicit headless CLI execution. |
| `apps/ade-cli/src/cli.ts` | User-facing `ade` command, text/JSON formatters, command plans, runtime-socket client wiring, and explicit headless fallback. |
| `apps/ade-cli/src/jsonrpc.ts` | JSON-RPC server and socket transport helpers. |
| `apps/desktop/src/main/services/localRuntime/localRuntimeConnectionPool.ts` | Desktop-side client for the local machine runtime at `~/.ade/sock/ade.sock`; registers projects and dispatches runtime-backed actions. |
| `apps/desktop/src/main/services/ai/tools/` | In-process tool implementations (universal, workflow, CTO operator, Linear, and orchestration lead/worker/validator tools). |
| `apps/desktop/src/main/services/agentTools/agentToolsService.ts` | External CLI detection (Claude Code, Codex, Cursor, Aider, Continue). |
| `apps/desktop/src/main/services/cli/adeCliService.ts` | Desktop-side CLI install / status / uninstall. Resolves the launcher target (`$HOME/.local/bin/ade` on POSIX, `%LOCALAPPDATA%\ADE\bin\ade.cmd` on Windows) and, on POSIX install, appends a marked `export PATH=...` block to the user's shell rc when the install dir isn't already on `$PATH`. |
| `apps/desktop/src/shared/adeCliGuidance.ts` | ADE guidance builders injected into agent system prompts and inline CLI preambles. Tells the agent how to find `ade` (PATH → `$ADE_CLI_PATH` → `$ADE_CLI_BIN_DIR/ade` → `node apps/ade-cli/dist/cli.cjs ...`), which bundled ADE skills exist, how Agent Skills are shaped (`<skill>/SKILL.md` plus optional `references/`, `scripts/`, `assets/`), which ADE-hosted surfaces receive the guidance, to try `ade doctor` / typed commands / `ade actions list` before reporting an ADE task as blocked, and to track and clean up stale or finished processes it starts. |
| `apps/desktop/src/shared/agentSkillRoots.ts` | Resolves generic Agent Skill roots for prompts and `ADE_AGENT_SKILLS_DIRS`: ancestor and home `.claude/skills`, `.agents/skills`, `.ade/skills`, `.codex/skills`, inherited env roots, packaged resources, and source fallbacks. |

## Two-path tool dispatch

### In-process path

The chat runtime (`agentChatService.ts`) instantiates tool objects
directly from `universalTools.ts`, `workflowTools.ts`,
`ctoOperatorTools.ts`, `linearTools.ts`, and `orchestrationTools.ts`,
then hands them to the provider adapter:

- **Claude Agent SDK:** the SDK `query()` stream receives ADE tools as
  SDK tool definitions alongside the runtime options for that session.
- **Codex app-server:** native provider tools are registered with the
  Codex app-server. ADE workflow actions are available through the
  `ade` CLI.
- **OpenCode:** tools are registered with the OpenCode runtime.
- **Cursor SDK:** the embedded `@cursor/sdk` exposes its own tool model
  and ADE supplies a permission/hook bridge through `cursorSdkPool.ts`
  and `cursorSdkPolicy.ts`. ADE workflow actions are available through
  the `ade` CLI.
- **Orchestration sessions:** `interactionMode` selects
  `orchestrator-lead`, `orchestrator-worker`, or
  `orchestrator-validator`. The lead receives a read-mostly base plus
  gated orchestration tools (`recordCodebaseIntake`,
  `askPlanningRound`, `proposeValidationSteps`, model selection, plan
  approval, spawning, and stale-task recovery). Workers and validators
  keep their edit-capable base tools plus task/validation reporting
  tools.

Orchestration planning state is server-enforced. The lead must record
codebase intake, run the functional/UI/extras planning rounds, derive
validation steps, and capture model routing before approval or spawning
unlocks. Raw manifest patches cannot write `leadState.planning` or
`planSpec`; those fields only change through privileged service methods.
The planning→developing transition is likewise the sole province of
`setPlanApprovalState` (which stamps `currentPhase = developing` and
`planApprovedAt` together): manifest normalization and task-release
phase-transition logic in `manifestNormalization.ts` explicitly refuse
to auto-advance the `planning` phase, so a completed planning-phase task
can never bypass plan approval.

#### Delegation lineage ledger

The manifest carries an optional `lineage: DelegationEdge[]` ledger
(`apps/desktop/src/shared/types/orchestration.ts`) that records the
otherwise-implicit "who spawned whom, for what, and what came back" as
first-class state — the agent row itself has no parent link. Each
`DelegationEdge` captures the `parentSessionId` (the lead today),
`childSessionId`, `childRole`, a `briefDigest` (sha256 of the dispatched
brief), the `spawnFingerprint` (provider / model / reasoning effort / fast
mode / routing key), and a `status` that moves `running` →
`completed`/`failed` with a contract-level `resultSummary`. Edges are
written only by service methods: `recordDelegationSpawn` at spawn time
(best-effort — it never fails the spawn, since the agent row is the source
of truth and the edge is supplementary provenance), the result side is
recorded eagerly in `releaseTask`, and `releaseStaleClaims` is the
lead-triggered reconcile backstop for validators or any missed terminal
transition. The lead is denied raw `/lineage` patches in `patchPolicy`
(the `/lineage` and `/lineage/**` deny patterns), so edges are
authoritative coordination state rather than lead-authored prose. The
field is additive and optional for back-compat — `manifestNormalization.ts`
defaults it to `[]` on load and drops malformed edges, so an in-memory
runtime manifest always has a lineage array. Scope is deliberately
lead↔worker/validator only: a worker's own provider-native subagents stay
in the observability pane and are not ingested here.

### ADE CLI path

CLI-wrapped providers and ordinary shell sessions invoke ADE through the
`ade` command:

1. By default, the CLI connects to the machine runtime endpoint at
   `~/.ade/sock/ade.sock` and starts `ade serve` if the endpoint is
   missing.
2. If `--headless` is passed, the CLI bootstraps the same project
   services directly from the project directory for one command.
3. The CLI sends machine-runtime JSON-RPC methods such as
   `projects.add`, `ade/actions/list`, and `ade/actions/call`.
4. `apps/ade-cli/src/multiProjectRpcServer.ts` resolves the project
   scope by `projectId`; `apps/ade-cli/src/adeRpcServer.ts` filters
   actions by caller role and dispatches to runtime-owned services.

## Machine runtime endpoint

`ade serve` listens on the machine ADE endpoint:

```text
~/.ade/sock/ade.sock
```

Key properties:

- **Machine endpoint.** The normal endpoint is resolved from the
  machine ADE home. `ADE_RPC_SOCKET_PATH` can override it for tests,
  dev launches, and compatibility scripts.
- **Stale socket cleanup.** On startup, the service attempts to
  `unlink` the socket in case a prior crash left it.
- **Active connection tracking.** Each connection is registered so the
  service can destroy it cleanly on shutdown.
- **Static action-list capability.** The action surface is resolved during
  initialization and action listing; live action-list notifications are not
  advertised until there is a concrete change source to publish.

### Identity propagation

ADE identity now flows through environment variables and CLI flags:

- The desktop app sets ADE context env vars when it launches managed
  shells or agents.
- The CLI reads `ADE_CHAT_SESSION_ID`, `ADE_RUN_ID`,
  `ADE_OWNER_ID`, and
  `ADE_DEFAULT_ROLE`.
- The private RPC handler merges those values into its caller context
  before action filtering.

## ADE CLI: identity and role

When the CLI connects to ADE RPC, it builds caller context from CLI
flags and ADE environment variables:

```ts
const callerCtx = resolveEnvCallerContext();
await connection.request("ade/initialize", { caller: callerCtx });
```

Roles:

- `cto` -- CTO session. Gets CTO operator + Linear tools.
- `agent` -- Worker agent. Gets agent-visible coordinator subset.
- `external` -- External callers. Gets only the base action set.
- `evaluator` -- Evaluation runs.

The trusted server role comes from `ADE_DEFAULT_ROLE` and the other ADE
context environment variables. The `identity.role` field in
`ade/initialize` is compatibility metadata for older clients; it does
not grant access by itself. Direct headless CLI mode sets
`ADE_DEFAULT_ROLE` from `--role`, and socket-backed launchers restart
stale runtimes when the runtime's reported `runtimeInfo.defaultRole`
does not match the requested role.

The initialize response advertises the runtime contract used by clients
to detect stale runtimes:

```json
{
  "runtimeInfo": {
    "version": "0.0.0",
    "buildHash": "<sha256-or-null>",
    "defaultRole": "cto",
    "projectRoot": "/path/to/project",
    "pid": 12345
  },
  "capabilities": {
    "actions": { "listChanged": false }
  }
}
```

## Tool filtering

`listAdeActionsForSession` builds the visible action list:

`listToolSpecsForSession` builds the visible action list by resolving
the caller context and then branching on role:

- `cto` — base tools + CTO operator tools + Linear sync tools.
- `agent`, `external`, `orchestrator`, `evaluator` — base tools only.

A visibility filter removes computer-use tools when those backends are
unavailable or when the caller lacks local-computer-use permission.

The final `.filter(...)` applies standalone-chat restrictions: if the
session has `chatSessionId` but no worker context,
`STANDALONE_CHAT_HIDDEN_TOOL_NAMES` (`spawn_agent`) is stripped from
the list.

### Role-to-toolset summary

| Role | Base tools | Elevated access |
|---|---|---|
| `external` | Yes | No |
| `agent` | Yes | No |
| `cto` | Yes | CTO operator + Linear sync tools |
| `orchestrator` | Yes | No (base tools only) |
| `evaluator` | Yes | No |

## Rate limits

Per-session rate limits (tracked in `SessionState`):

- `askUserRateLimit` -- caps `ask_user` tool calls.
Each uses a sliding-window counter (maxCalls, windowMs). Exceeded
calls return a structured error with retry-after guidance.

## Capability mode

When a session starts, the ADE CLI records the resolved
`capabilityMode` for the session log:

- `full_tooling` -- the session connected to the ADE CLI and the
  action list resolved successfully.
- `fallback` -- the ADE CLI/action bridge was unavailable; only the
  provider adapter's built-in tools are available.

`agentChatService` persists this mode on the session log entry so
history shows which mode the agent actually ran in.

## Tool execution flow

For a tool call:

1. Client sends `ade/actions/call` with `{ name, arguments }`.
2. ADE CLI validates against the JSON schema in the action spec.
3. `canCallerAccessCoordinatorTool(name, callerCtx)` checks whether
   the caller may invoke coordinator actions.
4. Rate limit check (for rate-limited tools).
5. Dispatch to the implementation:
   - Built-in ADE actions -> inline handlers in `adeRpcServer.ts`.
   - `CTO_OPERATOR_TOOL_SPECS` -> `createCtoOperatorTools()` output.
   - `COORDINATOR_TOOL_SPECS` -> `createCoordinatorToolSet()` output.
   - `LINEAR_SYNC_TOOL_SPECS` -> Linear tool implementations.
6. Result is returned as structured JSON.
7. If the tool mutates resources visible to other clients, the
   server may fire `ade/resources/list_changed`. Action-list changes are
   currently not advertised as live notifications.

## External CLI detection

`agentToolsService.ts` is unrelated to the ADE CLI registration path --
it probes the user's PATH for external AI tools:

```ts
const TOOL_SPECS: ToolSpec[] = [
  { id: "claude", label: "Claude Code", command: "claude", versionArgs: ["--version"] },
  { id: "codex", label: "Codex", command: "codex", versionArgs: ["--version"] },
  { id: "cursor", label: "Cursor", command: "cursor", versionArgs: ["--version"] },
  { id: "aider", label: "Aider", command: "aider", versionArgs: ["--version"] },
  { id: "continue", label: "Continue", command: "continue", versionArgs: ["--version"] },
];
```

Results are cached for 30 seconds. The UI uses this to show
"installed" badges for each tool.

## CLI modes

The `ade` command has two runtime modes:

| Mode | When | Behavior |
|---|---|---|
| Runtime-backed | Default for normal CLI use. | Connects to `~/.ade/sock/ade.sock`, registers the project when needed, and calls runtime-owned services. |
| Headless | `--headless` is passed. | Bootstraps the project services directly from `apps/ade-cli/src/bootstrap.ts` for one command. |

Both modes expose the same action protocol and output formatters. Agent
prompts should prefer documented commands such as `ade lanes list`,
`ade prs show`, or the generic `ade actions run <domain.action>`.

### Agent-prompt fallbacks for missing `ade` on PATH

`apps/desktop/src/shared/adeCliGuidance.ts` builds the canonical text
the chat / agent system prompt embeds whenever a session has CLI
access. Callers pass skill roots from `agentSkillRoots.ts`, usually
using the active lane worktree as `cwd`, so lane-local
`.claude/skills`, `.agents/skills`, `.ade/skills`, `.codex/skills`,
and bundled ADE resources appear before inherited environment,
packaged app, and source-fallback roots. The same full root list is
joined into `ADE_AGENT_SKILLS_DIRS` for ADE-launched CLI sessions,
headless worker launches, Work-tab CLI launches, ADE Code/TUI
sessions, CTO worker prompts, and mobile-started work that
runs through ADE's runtime.

The guidance tells the agent that `ade` *should* be available, and
gives it an ordered fallback chain when `command -v ade` fails:

1. try `${ADE_CLI_PATH:-}` (set by managed shells when the launcher
   path is known up front),
2. then `${ADE_CLI_BIN_DIR:-}/ade` (set when only the install dir is
   known),
3. and as a last resort, in an ADE source checkout, `node
   apps/ade-cli/dist/cli.cjs ...` after confirming the file exists.

The wording explicitly tells agents to use the relevant ADE skill
instead of long prompt guidance, to try `ade doctor`, typed
`ade ... --text` commands, and `ade actions list --text` /
`ade actions run ...` *before* claiming an ADE task is blocked. It also
tells agents that any process they start is their responsibility: track
it, and clean up old, stale, or finished processes before leaving the
task. `buildAdeCliAgentGuidance()` and `buildAdeCliInlineGuidance()`
currently share the same compact guidance body so system prompts,
worker launches, and inline Work-tab preambles stay aligned.

Lane launch directives pair this ADE CLI guidance with worktree write
boundaries. Agents may inspect files outside the launched lane when they
need read-only context, but edits and mutating shell commands are only
allowed inside the lane worktree unless ADE relaunches the session in a
different lane.

## Fragile and tricky wiring

- **Identity must come from env or trusted CLI flags.** A rogue client
  should not be able to claim elevated role access by inventing caller
  metadata.
- **Socket path collision across projects.** `ADE_RPC_SOCKET_PATH`
  only hands out the raw path to the first project; subsequent ones
  get a hash suffix. Agents should use `ade doctor` to inspect the
  resolved path rather than guessing.
- **Stale socket after crash.** The service deletes any leftover
  socket before binding. If two instances start simultaneously (rare
  but possible in CI), the second may delete the first's socket and
  EADDRINUSE on re-bind. `packagedRuntimeSmoke.ts` covers this
  sequence.
- **Standalone-chat detection uses env context.** If a managed shell
  forgets to forward `ADE_CHAT_SESSION_ID`, the session becomes
  `external` role instead of standalone. Always make sure managed
  runtime launchers set ADE context env vars.
- **Rate-limit events array grows unbounded.** `SessionState.askUserEvents`
  etc. are arrays of timestamps; old entries are trimmed at the
  next rate-limit check. Very bursty sessions can transiently carry
  thousands of timestamps. Consider ring buffers if this becomes a
  footprint issue.
- **CLI detection uses `which` which ignores shell aliases.** Users
  who rely on shell aliases for their CLI install paths see the tool
  as "not installed". Either point `TOOL_SPECS[i].command` at the
  real binary path or have the user add the install dir to PATH.
- **`ade agent spawn` vs. universal `spawnChat`.** The CLI command
  spawns a tracked terminal with Codex/Claude CLI via PTY. The CTO
  operator tool `spawnChat` creates an in-app chat session. Different
  use cases, easy to confuse -- watch which one is in scope for the
  caller role.

## Related docs

- [Agents README](README.md) -- three agent surfaces, tool tiers.
- [Identity and Personas](identity-and-personas.md) -- where the
  identity env vars come from.
- [Chat Tool System](../chat/tool-system.md) -- in-process tool
  implementations and their tiers.
- [Chat Agent Routing](../chat/agent-routing.md) -- how providers
  consume the tool set.

# Tool Registration

Agents get their action palette through two distinct paths: in-process
tool objects for managed chat runtimes, and the ADE CLI for agents or
shell sessions that need to invoke ADE actions out of process. Both
paths converge on the same service registry and apply role-based
filtering before exposing the final list.

## Source file map

| Path | Role |
|---|---|
| `apps/ade-cli/src/adeRpcServer.ts` | Private ADE action RPC. Defines action specs, session identity, role-based filtering, and the executor. |
| `apps/ade-cli/src/bootstrap.ts` | Builds `AdeRuntime` from desktop services for headless CLI execution. |
| `apps/ade-cli/src/cli.ts` | User-facing `ade` command, text/JSON formatters, command plans, and socket/headless client wiring. |
| `apps/ade-cli/src/jsonrpc.ts` | JSON-RPC server and socket transport helpers. |
| `apps/desktop/src/main/main.ts` | Creates the per-project ADE RPC socket server and binds `createAdeRpcRequestHandler`. |
| `apps/desktop/src/main/services/ai/tools/` | In-process tool implementations (universal, workflow, CTO operator, Linear). |
| `apps/desktop/src/main/services/orchestrator/coordinatorTools.ts` | Coordinator tool set for the mission orchestrator. |
| `apps/desktop/src/main/services/agentTools/agentToolsService.ts` | External CLI detection (Claude Code, Codex, Cursor, Aider, Continue). |

## Two-path tool dispatch

### In-process path

The chat runtime (`agentChatService.ts`) instantiates tool objects
directly from `universalTools.ts`, `workflowTools.ts`,
`ctoOperatorTools.ts`, and `linearTools.ts`, then hands them to the
provider adapter:

- **Claude V2:** the Claude Agent SDK's `unstable_v2_createSession`
  accepts the tools as `Record<string, ExecutableTool>`.
- **Codex app-server:** native provider tools are registered with the
  Codex app-server. ADE workflow actions are available through the
  `ade` CLI.
- **OpenCode:** tools are registered with the OpenCode runtime.
- **Cursor ACP:** Cursor exposes its own tool model; ADE workflow
  actions are available through the `ade` CLI.

### ADE CLI path

CLI-wrapped providers and ordinary shell sessions invoke ADE through the
`ade` command:

1. If ADE desktop is running, the CLI connects to the per-project
   `.ade/ade.sock` socket.
2. If desktop is not running, `--headless` bootstraps the same services
   from the project directory.
3. The CLI sends private ADE JSON-RPC methods such as
   `ade/actions/list` and `ade/actions/call`.
4. `apps/ade-cli/src/adeRpcServer.ts` filters actions by caller role and
   dispatches to desktop services.

## Socket server

In `main.ts`:

```ts
const rpcSocketServer = net.createServer((conn) => {
  const transport: JsonRpcTransport = {
    onData(callback) { conn.on("data", callback); },
    write(data) { conn.write(data); },
    close() { if (!conn.destroyed) conn.destroy(); },
  };
  const rpcHandler = createAdeRpcRequestHandler({
    runtime: rpcRuntime,
    serverVersion: app.getVersion(),
    onActionsListChanged: () => stop?.notify("ade/actions/list_changed", {}),
  });
  const stop = startJsonRpcServer(rpcHandler, transport, { nonFatal: true });
  // ... cleanup wiring
});
rpcSocketServer.listen(rpcSocketPath);
```

Key properties:

- **Per-project sockets.** When `ADE_RPC_SOCKET_PATH` is set, the first
  project context uses the env path; subsequent contexts append a
  base64-encoded project-root hash suffix to avoid EADDRINUSE.
- **Stale socket cleanup.** On startup, the service attempts to
  `unlink` the socket in case a prior crash left it.
- **Active connection tracking.** Each connection is registered so the
  service can destroy it cleanly on shutdown.
- **Live action-list updates.** `onActionsListChanged` notifies clients
  via `ade/actions/list_changed` when the action surface changes.

### Identity propagation

ADE identity now flows through environment variables and CLI flags:

- The desktop app sets ADE context env vars when it launches managed
  shells or agents.
- The CLI reads `ADE_CHAT_SESSION_ID`, `ADE_MISSION_ID`, `ADE_RUN_ID`,
  `ADE_STEP_ID`, `ADE_ATTEMPT_ID`, `ADE_OWNER_ID`, and
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
- `orchestrator` -- Mission coordinator. Gets coordinator tools.
- `agent` -- Worker agent. Gets agent-visible coordinator subset.
- `external` -- External callers. Gets only the base action set.
- `evaluator` -- Evaluation runs.

The role is locked to what the env context reports; the
`identity.role` field in the payload is honored only when the env
context agrees. This prevents a rogue client from claiming elevated
access by forging `identity.role`.

## Tool filtering

`listAdeActionsForSession` builds the visible action list:

```ts
async function listAdeActionsForSession(runtime, session): Promise<AdeActionSpec[]> {
  const callerCtx = await resolveEffectiveCallerContext(runtime, session);
  const baseActions = listBaseAdeActions(runtime);
  const coordinatorActions = callerCtx.role === "orchestrator"
    ? listCoordinatorActions(runtime)
    : listAgentCoordinatorActions(runtime, callerCtx);
  return filterActionsForCaller([...baseActions, ...coordinatorActions], callerCtx);
}
```

The final `.filter(...)` applies standalone-chat restrictions: if the
session has `chatSessionId` but no mission/run/step/attempt context,
`STANDALONE_CHAT_HIDDEN_TOOL_NAMES` (including `spawn_agent` and
coordinator tools) are stripped from the list.

### Role-to-toolset summary

| Role | Base tools | Coordinator access |
|---|---|---|
| `external` | Yes | No |
| `agent` | Yes | Agent-visible subset (tools with run/step/attempt context) |
| `cto` | Yes | No; has CTO operator + Linear sync instead |
| `orchestrator` | Yes | Full coordinator tool set |
| `evaluator` | Yes (limited; case-by-case) | No |

## Rate limits

Per-session rate limits (tracked in `SessionState`):

- `askUserRateLimit` -- caps `ask_user` tool calls.
- `memoryAddRateLimit` -- caps `memory_add` calls.
- `memorySearchRateLimit` -- caps `memory_search` calls.

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
   server may fire `ade/resources/list_changed` or
   `ade/actions/list_changed`.

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
| Socket-backed | ADE desktop is running for the project. | Connects to `.ade/ade.sock` and calls desktop-owned services. |
| Headless | `--headless` is passed or the socket is unavailable. | Bootstraps the project services directly from `apps/ade-cli/src/bootstrap.ts`. |

Both modes expose the same action protocol and output formatters. Agent
prompts should prefer documented commands such as `ade lanes list`,
`ade prs path-to-merge`, or the generic `ade actions run <domain.action>`.

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
  memory issue.
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

# Tool Registration

Agents get their tool palette through two distinct paths: in-process
tool objects (for the chat runtime that owns the session) and MCP
server registration (for CLI-wrapped providers and external clients).
Both paths converge on a shared tool registry and apply role-based
filtering before exposing the final list.

## Source file map

| Path | Role |
|---|---|
| `apps/mcp-server/src/mcpServer.ts` | Main-process MCP server. Defines tool specs, session identity, role-based filtering, and the tool executor. |
| `apps/mcp-server/src/bootstrap.ts` | Builds `AdeMcpRuntime` from desktop services so the MCP server can call through to them. |
| `apps/mcp-server/src/jsonrpc.ts` | JSON-RPC server and transport (socket, stdio). |
| `apps/mcp-server/src/transport.ts` | Stdio framing helpers (JSONL + `Content-Length`). |
| `apps/desktop/src/main/adeMcpProxy.ts` | Bundled stdio proxy: child process connecting to the ADE socket server with identity injection. |
| `apps/desktop/src/main/adeMcpProxyUtils.ts` | `ProxyIdentity`, `injectIdentityIntoInitializePayload`, stdio framing helpers. |
| `apps/desktop/src/main/services/runtime/adeMcpLaunch.ts` | Resolves MCP launch mode + command line + env. |
| `apps/desktop/src/main/main.ts` | Creates the MCP socket server and binds `createMcpRequestHandler`. |
| `apps/desktop/src/main/services/ai/tools/` | In-process tool implementations (universal, workflow, CTO operator, Linear). |
| `apps/desktop/src/main/services/orchestrator/coordinatorTools.ts` | Coordinator tool set for the mission orchestrator. |
| `apps/desktop/src/main/services/agentTools/agentToolsService.ts` | External CLI detection (Claude Code, Codex, Cursor, Aider, Continue). |
| `apps/desktop/src/main/services/externalMcp/` | External MCP server integration (user-configured MCP servers). |

## Two-path tool dispatch

### In-process path

The chat runtime (`agentChatService.ts`) instantiates tool objects
directly from `universalTools.ts`, `workflowTools.ts`,
`ctoOperatorTools.ts`, and `linearTools.ts`, then hands them to the
provider adapter:

- **Claude V2:** the Claude Agent SDK's `unstable_v2_createSession`
  accepts the tools as `Record<string, ExecutableTool>`.
- **Codex app-server:** tools are exposed via MCP (see below); the
  Codex subprocess connects to ADE's MCP socket to call them.
- **OpenCode:** tools are registered with the OpenCode runtime.
- **Cursor ACP:** Cursor exposes its own tool model; ADE-specific tools
  surface via the MCP path.

### MCP path

CLI-wrapped providers (Claude Code, Codex, Cursor) spawn as subprocesses
and need a way to invoke ADE's tools. The MCP server bridges them:

1. ADE's main process starts a Unix-domain socket server at the
   resolved socket path (per-project, under `.ade/`).
2. When a CLI subprocess spawns, its `mcp.json` points at the bundled
   proxy (`apps/desktop/src/main/adeMcpProxy.ts`).
3. The proxy connects to the socket and relays stdio both directions,
   injecting identity env-vars into the JSON-RPC `initialize` payload.
4. The MCP server in `apps/mcp-server/src/mcpServer.ts` handles the
   request, filters tools by role, and dispatches.

## Socket server

In `main.ts`:

```ts
const mcpSocketServer = net.createServer((conn) => {
  const transport: JsonRpcTransport = {
    onData(callback) { conn.on("data", callback); },
    write(data) { conn.write(data); },
    close() { if (!conn.destroyed) conn.destroy(); },
  };
  const mcpHandler = createMcpRequestHandler({
    runtime: mcpRuntime,
    serverVersion: app.getVersion(),
    onToolsListChanged: () => stop?.notify("notifications/tools/list_changed", {}),
  });
  const stop = startJsonRpcServer(mcpHandler, transport, { nonFatal: true });
  // ... cleanup wiring
});
mcpSocketServer.listen(mcpSocketPath);
```

Key properties:

- **Per-project sockets.** When `ADE_MCP_SOCKET_PATH` is set, the first
  project context uses the env path; subsequent contexts append a
  base64-encoded project-root hash suffix to avoid EADDRINUSE.
- **Stale socket cleanup.** On startup, the service attempts to
  `unlink` the socket in case a prior crash left it.
- **Active connection tracking.** Each connection is registered in
  `activeMcpConnections` so the service can destroy them cleanly on
  shutdown.
- **Live tool-list updates.** `onToolsListChanged` notifies clients
  via `notifications/tools/list_changed` when external MCP servers
  come online or the computer-use backend changes.

## Bundled proxy

`adeMcpProxy.ts` is the spawnable proxy shipped with each build. CLIs
reference it in their MCP config, so the ADE environment variables
flow through the subprocess into the proxy. The proxy's job:

1. Resolve project root, workspace root, and socket path from
   env/CLI args.
2. Read `ADE_CHAT_SESSION_ID`, `ADE_MISSION_ID`, `ADE_RUN_ID`,
   `ADE_STEP_ID`, `ADE_ATTEMPT_ID`, `ADE_OWNER_ID`, `ADE_DEFAULT_ROLE`,
   and the `ADE_COMPUTER_USE_*` policy vars.
3. Connect to the socket server. Connect retries `ENOENT`/`ECONNREFUSED`
   every 150 ms for up to 5 s so a CLI that spawns the proxy
   fractionally before the desktop's socket server is listening still
   succeeds; other socket errors fail fast.
4. For each incoming JSON-RPC message, if it is an `initialize`
   request, inject the identity into `params.identity` via
   `injectIdentityIntoInitializePayload`. Otherwise pass through
   untouched.
5. Forward socket output back to stdout.

### Identity injection

`injectIdentityIntoInitializePayload(payloadText, identity)`:

- Parses the payload as JSON.
- If it is an `initialize` request, merges the proxy identity into
  `params.identity` (without overwriting fields the caller already
  provided).
- Preserves existing `computerUsePolicy` values in the payload; only
  fills gaps with proxy values.
- Returns the re-serialised payload.

The `hasProxyIdentity()` gate ensures the proxy only does this work
when at least one identity field is set; otherwise it relays stdin
directly.

## MCP server: identity and role

When the server receives an `initialize` request:

```ts
function parseInitializeIdentity(runtime, params): SessionIdentity {
  const data = safeObject(params);
  const identity = safeObject(data.identity);
  const envContext = resolveEnvCallerContext();  // env vars
  const identityRole = asOptionalTrimmedString(identity.role);
  // Role from identity.role if valid, else env, else "external"
  const validRole = envContext.role ?? "external";
  // ... build SessionIdentity
}
```

Roles:

- `cto` -- CTO session. Gets CTO operator + Linear tools.
- `orchestrator` -- Mission coordinator. Gets coordinator tools.
- `agent` -- Worker agent. Gets agent-visible coordinator subset.
- `external` -- External MCP clients. Gets only the base tool set.
- `evaluator` -- Evaluation runs.

The role is locked to what the env context reports; the
`identity.role` field in the payload is honored only when the env
context agrees. This prevents a rogue client from claiming elevated
access by forging `identity.role`.

## Tool filtering

`listToolSpecsForSession` builds the visible tool list:

```ts
async function listToolSpecsForSession(runtime, session): Promise<ToolSpec[]> {
  const callerCtx = await resolveEffectiveCallerContext(runtime, session);
  const externalToolSpecs = await runtime.externalMcpService?.listToolsForIdentity(...) ?? [];
  const shouldHideLocalComputerUse = !localComputerUseAllowed || externalComputerUseAvailable;

  const visibleBaseTools = shouldHideLocalComputerUse
    ? TOOL_SPECS.filter((tool) => !LOCAL_COMPUTER_USE_TOOL_NAMES.has(tool.name))
    : TOOL_SPECS;

  const allVisibleTools = (() => {
    if (callerCtx.role === "external" || !callerCtx.role) return [...visibleBaseTools, ...externalToolSpecs];
    if (callerCtx.role === "agent") return [...visibleBaseTools, ...AGENT_VISIBLE_COORDINATOR_TOOL_SPECS, ...externalToolSpecs];
    if (callerCtx.role === "cto") return [...visibleBaseTools, ...CTO_OPERATOR_TOOL_SPECS, ...CTO_LINEAR_SYNC_TOOL_SPECS, ...externalToolSpecs];
    return [...visibleBaseTools, ...visibleCoordinatorTools, ...externalToolSpecs];  // orchestrator default
  })();

  return allVisibleTools.filter((tool) => !isToolHiddenForStandaloneChat(tool.name, callerCtx));
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

## External MCP servers

Users can configure additional MCP servers (e.g., `mcp__linear__*`,
`mcp__github__*`) via Settings -> Context & Docs -> External MCP. The
`externalMcpService` manages them:

- `listToolsForIdentity(identity)` returns tools scoped to the
  identity's `externalMcpAccess` policy.
- Tool names are namespaced as `mcp__<serverName>__<toolName>`.
- `systemPrompt.ts`'s `normalizeToolName` unwraps this prefix when
  deciding which prompt sections to emit.

When an external MCP server is added, removed, or reconnects, the
`onToolsListChanged` callback fires and clients receive
`notifications/tools/list_changed`.

## Rate limits

Per-session rate limits (tracked in `SessionState`):

- `askUserRateLimit` -- caps `ask_user` tool calls.
- `memoryAddRateLimit` -- caps `memory_add` calls.
- `memorySearchRateLimit` -- caps `memory_search` calls.

Each uses a sliding-window counter (maxCalls, windowMs). Exceeded
calls return a structured error with retry-after guidance.

## Capability mode

When a session starts, the MCP server records the resolved
`capabilityMode` for the session log:

- `full_mcp` -- the session connected to the ADE MCP server and the
  tool list resolved successfully.
- `fallback` -- the MCP connection failed; only the adapter's
  built-in tools are available.

`agentChatService` persists this mode on the session log entry so
history shows which mode the agent actually ran in.

## Tool execution flow

For a tool call:

1. Client sends `tools/call` with `{ name, arguments }`.
2. MCP server validates against the JSON schema in the tool spec.
3. `canCallerAccessCoordinatorTool(name, callerCtx)` checks whether
   the caller may invoke the tool.
4. Rate limit check (for rate-limited tools).
5. Dispatch to the implementation:
   - `TOOL_SPECS` tools -> inline handlers in `mcpServer.ts`.
   - `CTO_OPERATOR_TOOL_SPECS` -> `createCtoOperatorTools()` output.
   - `COORDINATOR_TOOL_SPECS` -> `createCoordinatorToolSet()` output.
   - `LINEAR_SYNC_TOOL_SPECS` -> Linear tool implementations.
   - External MCP tools -> forwarded to the remote server.
6. Result is returned as structured JSON.
7. If the tool mutates resources visible to other clients, the
   server may fire `notifications/resources/list_changed` or
   `notifications/tools/list_changed`.

## External CLI detection

`agentToolsService.ts` is unrelated to the MCP registration path --
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

## Launch modes

`adeMcpLaunch.ts` resolves one of three launch modes:

| Mode | When | Command |
|---|---|---|
| `bundled_proxy` | Packaged production build with the proxy script available under `process.resourcesPath`. | Spawns the proxy Node script with `--project-root`, `--workspace-root`. |
| `headless_built` | Dev or packaged where the compiled headless MCP server binary is present. | Spawns the compiled binary directly. |
| `headless_source` | Local dev with TypeScript sources only. | Spawns `tsx` against the source entry. |

The launch result includes `command`, `cmdArgs`, `env`, `entryPath`,
`socketPath`, `packaged`, and `resourcesPath` so callers can diagnose
packaging or PATH issues.

## Fragile and tricky wiring

- **Identity must come from env, not payload.** `parseInitializeIdentity`
  treats `identity.role` as advisory and reconciles with
  `resolveEnvCallerContext()`. A rogue client could otherwise claim to
  be the orchestrator. Keep this asymmetry when extending.
- **Socket path collision across projects.** `ADE_MCP_SOCKET_PATH`
  only hands out the raw path to the first project; subsequent ones
  get a hash suffix. Tests and external tooling must use the suffix
  to find the right socket.
- **Stale socket after crash.** The service deletes any leftover
  socket before binding. If two instances start simultaneously (rare
  but possible in CI), the second may delete the first's socket and
  EADDRINUSE on re-bind. `packagedRuntimeSmoke.ts` covers this
  sequence.
- **`notifications/tools/list_changed` storms.** Every external MCP
  add/remove/reconnect fires the notification; clients that re-fetch
  aggressively can overload the server. The current code debounces
  within each client, but large external MCP configs can still cause
  bursts.
- **Standalone-chat detection uses env context, not payload.** If the
  proxy forgets to forward `ADE_CHAT_SESSION_ID`, the session becomes
  `external` role instead of standalone -- the filter fails open for
  coordinator tools unless the caller also lacks mission context.
  Always make sure the proxy sets the env vars.
- **External MCP tool names may collide with ADE tool names.** The
  `mcp__<server>__<tool>` prefix keeps the namespace flat; ADE's
  `normalizeToolName` unwraps it for prompt composition. If an
  external MCP uses double-underscores in its server name, the
  regex misidentifies the structure. Validate server names at
  registration time.
- **Rate-limit events array grows unbounded.** `SessionState.askUserEvents`
  etc. are arrays of timestamps; old entries are trimmed at the
  next rate-limit check. Very bursty sessions can transiently carry
  thousands of timestamps. Consider ring buffers if this becomes a
  memory issue.
- **CLI detection uses `which` which ignores shell aliases.** Users
  who rely on shell aliases for their CLI install paths see the tool
  as "not installed". Either point `TOOL_SPECS[i].command` at the
  real binary path or have the user add the install dir to PATH.
- **`spawn_agent` tool vs. universal `spawnChat`.** The MCP
  `spawn_agent` tool spawns a tracked terminal with Codex/Claude CLI
  via PTY. The CTO operator tool `spawnChat` creates an in-app chat
  session. Different use cases, easy to confuse -- watch which one
  is in scope for the caller role.

## Related docs

- [Agents README](README.md) -- three agent surfaces, tool tiers.
- [Identity and Personas](identity-and-personas.md) -- where the
  identity env vars come from.
- [Chat Tool System](../chat/tool-system.md) -- in-process tool
  implementations and their tiers.
- [Chat Agent Routing](../chat/agent-routing.md) -- how providers
  consume the tool set.
</content>
</invoke>
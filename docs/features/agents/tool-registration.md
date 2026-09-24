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
| `apps/ade-cli/src/services/runtime/adeCliShim.ts` | Body and directory name of the `ADE_CLI_PATH` shim a brain writes for the agents it launches. |
| `apps/ade-cli/src/lib/cliDelegation.ts`, `cliDelegationEntry.ts`, `cliGlobalArgs.ts` | Hands an `ade` run to `ADE_CLI_PATH` when that path runs a different CLI entry. `cliGlobalArgs.ts` lists the global flags that take a value, so the check skips the same tokens as the CLI. |
| `apps/desktop/src/shared/runtimeClientNames.ts` | The names the desktop connects to a brain with. The RPC server allows user-only actions only to these names. |
| `apps/desktop/src/main/services/localRuntime/localRuntimeConnectionPool.ts` | Desktop-side client for the local machine runtime at `~/.ade/sock/ade.sock`; registers projects and dispatches runtime-backed actions. |
| `apps/desktop/src/main/services/ai/tools/` | In-process tool implementations (universal, workflow, CTO operator, and Linear tools). |
| `apps/desktop/src/main/services/ai/tools/systemPrompt.ts` | Shared provider-runtime prompt assembly. Injects the same timezone-safe scheduled-work guidance into Claude, Codex, Cursor, Droid, and OpenCode sessions. |
| `apps/desktop/src/main/services/adeActions/registry.ts` | Runtime action contracts and examples, including the mutually exclusive `cron` / `runAt` / `delaySeconds` scheduling inputs. |
| `apps/desktop/src/main/services/agentTools/agentToolsService.ts` | External CLI detection (Claude Code, Codex, Cursor, Aider, Continue). |
| `apps/desktop/src/main/services/cli/adeCliService.ts` | Desktop-side CLI install / status / uninstall. Resolves the launcher target (`$HOME/.local/bin/ade` on POSIX, `%LOCALAPPDATA%\ADE\bin\ade.cmd` on Windows) and, on POSIX install, appends a marked `export PATH=...` block to the user's shell rc when the install dir isn't already on `$PATH`. |
| `apps/desktop/src/shared/adeCliGuidance.ts` | ADE guidance builders injected into agent system prompts and inline CLI preambles. Tells the agent how to find `ade` (PATH → `$ADE_CLI_PATH` → `$ADE_CLI_BIN_DIR/ade` → `node apps/ade-cli/dist/cli.cjs ...`), which bundled ADE skills exist, how Agent Skills are shaped (`<skill>/SKILL.md` plus optional `references/`, `scripts/`, `assets/`), which ADE-hosted surfaces receive the guidance, to try `ade doctor` / typed commands / `ade actions list` before reporting an ADE task as blocked, and to track and clean up stale or finished processes it starts. |
| `apps/desktop/src/shared/agentSkillRoots.ts` | Resolves generic Agent Skill roots for prompts and `ADE_AGENT_SKILLS_DIRS`: ancestor and home `.claude/skills`, `.agents/skills`, `.ade/skills`, `.codex/skills`, inherited env roots, packaged resources, and source fallbacks. |

## Two-path tool dispatch

### In-process path

The chat runtime (`agentChatService.ts`) instantiates tool objects
directly from `universalTools.ts` and `ctoOperatorTools.ts`, then hands
them to the provider adapter:

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
- **CTO sessions:** `createCtoRuntimeToolMap` (gated on
  `identityKey === "cto"`) registers `ctoOperatorTools.ts` on the live
  session through the per-provider transports below. Every set is
  described by one `HTTP_MCP_TOOL_SETS` table (server
  name, Codex namespace, tool factory), and the CTO entry resolves to an
  `ade-cto` SDK MCP server for Claude (injected without
  `allowManagedMcpServersOnly`, so the user's own MCP servers survive), the
  `ade_cto` dynamic-tool namespace inside `refreshCodexDynamicTools` for
  Codex, and a dedicated HTTP MCP lease (`ensureHttpMcpServer(managed,
  "cto")`, cached in `managed.httpMcpServers`) for Cursor, Droid, and
  OpenCode. `buildCtoOperatorToolDeps` was shared with
  `previewSessionToolNames`, a name-enumeration helper removed for having no
  non-test caller; there is no prompt manifest to keep in step today, so the
  runtime map is the single definition.
  What the transports advertise is `createCtoAdvertisedToolMap` — the runtime
  map passed through `applyCtoToolPackVisibility`, which trims an unloaded
  pack's tool to a one-line description without ever adding or dropping a key.
  Deferral is a description-level economy, never a capability gate: every CTO
  tool stays registered and callable on every transport at all times. Claude
  layers ToolSearch on top, Codex layers per-tool `deferLoading`, and the
  providers with no native mechanism get the trimmed descriptions alone. See
  [CTO › Tool packs](../cto/README.md#tool-packs) and
  [chat/tool-system.md](../chat/tool-system.md#cto-operator-tools).
- **Spawned helpers:** there is no separate orchestration mode. A
  coordinating agent spawns its own helpers from any thread with
  `ade chat create --type subagent --provider <p> --model <m>
  [--instance <id>] [--preset <id>]`, and each child is an ordinary agent
  with the same runtime, permissions, and tools.

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
- `agent`, `external`, `evaluator` — base tools only.

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

Scheduled-work creation is also identical across both modes. The typed CLI
accepts exactly one of `--in`, `--at`, or `--cron`; the generic action accepts
the matching `delaySeconds`, `runAt`, or `cron` field. Relative and absolute
forms are one-shot, absolute timestamps require `Z` or an offset, and cron uses
the brain machine's local timezone. Both the typed command and generic action
select the same text formatter, which prints the authoritative brain timezone
and the next run in brain-local and ISO forms.

### Agent-prompt fallbacks for missing `ade` on PATH

`apps/desktop/src/shared/adeCliGuidance.ts` builds the canonical text
the chat / agent system prompt embeds whenever a session has CLI
access. Callers pass skill roots from `agentSkillRoots.ts`, usually
using the active lane worktree as `cwd`, so lane-local
`.claude/skills`, `.agents/skills`, `.ade/skills`, `.codex/skills`,
and bundled ADE resources appear before inherited environment,
packaged app, and source-fallback roots. The same full root list is
joined into `ADE_AGENT_SKILLS_DIRS` for ADE-launched CLI sessions,
Work-tab CLI launches, ADE Code/TUI sessions, the CTO, and
mobile-started work that runs through ADE's runtime.

The guidance tells the agent that `ade` *should* be available, and
gives it an ordered fallback chain when `command -v ade` fails:

1. try `${ADE_CLI_PATH:-}` (set by managed shells when the launcher
   path is known up front),
2. then `${ADE_CLI_BIN_DIR:-}/ade` (set when only the install dir is
   known),
3. and as a last resort, in an ADE source checkout, `node
   apps/ade-cli/dist/cli.cjs ...` after confirming the file exists.

For agents a brain launches, `ADE_CLI_PATH` is a shim written by
`createHeadlessAdeCliAgentEnv` (`apps/ade-cli/src/bootstrap.ts`, body from
`apps/ade-cli/src/services/runtime/adeCliShim.ts`) under
`<tmpdir>/ade-cli-shims/<hash>/`. It names the brain that wrote it: when
the caller's env sets neither `ADE_HOME` nor `ADE_RUNTIME_SOCKET_PATH`, it
defaults both to that brain's (`ade serve` records the socket it serves in
`ADE_RUNTIME_SOCKET_PATH`, including a launchd brain started with only
`ADE_HOME`). This matters for the Cursor SDK worker, which strips both from
its env. Without the defaults, its `ade` falls back to `~/.ade` and can reach
the stable brain from an Alpha chat. The hash covers the entry, runtime, socket
and home, so two brains sharing one CLI entry never share a shim. An explicit
`--socket <path>` still wins. The brain also sets `ADE_CLI_ENTRY_PATH` next to
the shim, to name the CLI entry that the shim runs.

A shell rc file that rebuilds `PATH` can drop the shim directory, so a plain
`ade` can resolve to an older install. For that case, every `ade` run first
checks `ADE_CLI_PATH` (`apps/ade-cli/src/lib/cliDelegation.ts`, loaded before
the rest of the CLI by `cliDelegationEntry.ts`). When `ADE_CLI_PATH` runs a
different CLI entry, the CLI re-runs the same argv through it. The check only
reads a few files. It never delegates from a source-checkout build, so a lane
can test its own `apps/ade-cli/dist/cli.cjs`. The child gets
`ADE_CLI_DELEGATED=1`, which stops a loop. `ADE_CLI_NO_DELEGATE=1` turns
delegation off.

The wording explicitly tells agents to use the relevant ADE skill
instead of long prompt guidance, to try `ade doctor`, typed
`ade ... --text` commands, and `ade actions list --text` /
`ade actions run ...` *before* claiming an ADE task is blocked. It also
tells agents that any process they start is their responsibility: track
it, and clean up old, stale, or finished processes before leaving the
task. `buildAdeCliAgentGuidance()` and `buildAdeCliInlineGuidance()`
currently share the same compact guidance body so system prompts,
worker launches, and inline Work-tab preambles stay aligned.

Scheduled-work semantics are additionally enforced in the provider runtime
prompt assembled by `systemPrompt.ts` and documented in the bundled
`ade-cli-control-plane` skill. All provider runtimes receive the same guidance:
prefer relative one-shots for elapsed-time intent, use offset-qualified
timestamps for absolute intent, treat cron as brain-local, and verify the
server-returned next-run values.

Lane launch directives pair this ADE CLI guidance with worktree write
boundaries. Agents may inspect files outside the launched lane when they
need read-only context, but edits and mutating shell commands are only
allowed inside the lane worktree unless ADE relaunches the session in a
different lane.

### Per-turn directive cadence

`composeLaunchDirectives` prepends ADE-authored blocks to the user's message.
Each block states its own cadence, and none of them repeats without a reason:

- **Lane worktree directive** — once per lane epoch.
- **ADE guidance** (`buildAdeGuidanceForLane`) — every turn, and only for a
  provider with no trusted instruction channel. Claude, Codex, and OpenCode
  carry it in a persistent system prompt instead. Droid is the exception in
  the other direction: its SDK takes no system prompt, so ADE re-sends the
  whole harness prompt every turn, and that harness already ends with the
  shared `## ADE` block — so Droid receives only the session lineage lines
  here, never a second copy of the block.
- **Computer Use directive** — once per lane epoch, and again whenever the
  available capture backends change. The gate is a fingerprint of the rendered
  directive, so a changed capability set is re-announced and an unchanged one
  never costs a second delivery. Two honest limits: a transition to no available
  backend emits no directive at all (there is nothing to announce), so a
  capability lost entirely is not explicitly revoked; and a session with no
  artifact broker gets no directive rather than a claim it cannot honor.

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

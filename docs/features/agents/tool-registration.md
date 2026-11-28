# Tool Registration

Agents reach DAEX actions two ways: in-process tool objects for managed chat
runtimes, and the CLI (`daex`, with `ade` as a permanent alias) for agents and
shells that call DAEX out of process. Both end at the same service registry
and the same role filtering.

## Source file map

| Path | Role |
|---|---|
| `apps/ade-cli/src/adeRpcServer.ts` | The private action RPC: `TOOL_SPECS` (base tools), `CTO_OPERATOR_TOOL_SPECS`, `CTO_LINEAR_SYNC_TOOL_SPECS`, session identity, `listToolSpecsForSession`, the executor, `run_ade_action` for domain actions, and the lane guidance / skill-root env for worker CLI launches. |
| `apps/ade-cli/src/multiProjectRpcServer.ts` | The machine-runtime JSON-RPC surface: `projects.*`, runtime events, sync methods, and `ade/actions/*` dispatch by `projectId`. |
| `apps/ade-cli/src/runtimeRoles.ts` | Role normalization and `resolveSessionBoundRole`. |
| `apps/ade-cli/src/bootstrap.ts` | Per-project `AdeRuntime` scopes for the machine runtime, SSH stdio and `--headless`; `createHeadlessAdeCliAgentEnv`. |
| `apps/ade-cli/src/cli.ts`, `jsonrpc.ts` | The CLI, formatters, command plans and socket client; JSON-RPC transport. |
| `apps/ade-cli/src/services/runtime/adeCliShim.ts` | Body of the `ADE_CLI_PATH` shim a brain writes for the agents it launches. |
| `apps/ade-cli/src/lib/cliDelegation.ts`, `cliDelegationEntry.ts`, `cliGlobalArgs.ts` | Re-runs a CLI call through `ADE_CLI_PATH` when that path is a different CLI entry. |
| `apps/desktop/src/shared/runtimeClientNames.ts` | Client names the desktop connects with; user-only actions are allowed only to these. |
| `apps/desktop/src/main/services/localRuntime/localRuntimeConnectionPool.ts` | Desktop client for the machine socket (`<ADE home>/sock/ade.sock`). |
| `apps/desktop/src/main/services/ai/tools/` | In-process tools (universal, workflow, CTO operator, Linear) and `systemPrompt.ts`. |
| `apps/desktop/src/main/services/adeActions/registry.ts` | Action contracts and examples (for example the exclusive `cron` / `runAt` / `delaySeconds` scheduling inputs). |
| `apps/desktop/src/main/services/cli/adeCliService.ts` | Installs the launcher (`$HOME/.local/bin` on POSIX, `%LOCALAPPDATA%` on Windows) under both names (`daexCommandName`: `ade` → `daex`, `ade-alpha` → `daex-alpha`) and adds a marked PATH block to the shell rc when needed. |
| `apps/desktop/src/main/services/cli/windowsCliLauncher.ts`, `apps/desktop/native/ADECliLauncherWin/` | The Windows launcher exe used instead of a batch shim. |
| `apps/desktop/src/shared/adeCliGuidance.ts` | `buildAdeCliAgentGuidance` / `buildAdeCliInlineGuidance` (one shared body): finding the CLI, the bundled `daex-*` skills, skill shape, live surfaces, `daex doctor` and `daex actions list` before reporting a blocker, process cleanup. |
| `apps/desktop/src/shared/agentSkillRoots.ts` | Skill roots for prompts and `ADE_AGENT_SKILLS_DIRS`. |

## Gotchas / fragile areas

- **Role comes from the environment, not the client.** The trusted role is
  `ADE_DEFAULT_ROLE` plus the other `ADE_*` context vars (named for historical
  reasons). `identity.role` in `ade/initialize` is metadata only.
- **A command inside the brain cannot restart it.** If its role is compatible
  it runs despite a version mismatch and warns on stderr; otherwise it fails
  instead of opening a separate headless runtime. Launchers outside the brain
  restart a stale runtime whose `runtimeInfo.defaultRole` cannot serve them.
- **Standalone-chat detection needs the env.** A managed launcher that drops
  `ADE_CHAT_SESSION_ID` turns the session into the `external` role.
- **The shim names its brain.** The Cursor SDK worker strips `ADE_HOME` and
  `ADE_RUNTIME_SOCKET_PATH`; without the shim's defaults its CLI would fall
  back to `~/.ade` and could reach the stable brain from a Beta chat.
- **No batch file on Windows when avoidable.** cmd.exe ends a command at the
  first line feed, so `ade.cmd` cut multi-line `--prompt` / `--text`. Agents
  get the launcher exe; `ade.cmd` stays on PATH for people and sets
  `ADE_CLI_VIA_CMD=1`, which prints a one-line note for inline prompts.
- **`spawn_agent` vs `spawnChat`.** `spawn_agent` (RPC tool, hidden from
  standalone chats) starts a tracked CLI in a PTY. `spawnChat` (CTO operator
  tool) creates an in-app chat. Agents start work with `daex new chat`.
- **External CLI detection uses PATH.** `agentToolsService.ts` probes Claude
  Code, Codex, Cursor, Devin, Aider and Continue (30 s cache); shell aliases are
  invisible to it. It is informational only.
- **`ask_user` is rate-limited per session** (`askUserRateLimit`, a sliding
  window over `askUserEvents`, trimmed on each check).

## In-process tools

`agentChatService.ts` builds tools from `universalTools.ts` and
`ctoOperatorTools.ts` and hands them to the provider adapter. Regular chats
reach DAEX workflow actions through the CLI; the in-process set is mostly the
CTO's.

CTO sessions: `createCtoRuntimeToolMap` (identity `cto`) builds the operator
tools. `HTTP_MCP_TOOL_SETS` describes each set (server name, Codex namespace,
factory). The CTO set is delivered as:

| Provider | Transport |
|---|---|
| Claude | In-process SDK MCP server `daex-cto` (without `allowManagedMcpServersOnly`, so the user's MCP servers survive) |
| Codex | Dynamic-tool namespace `daex_cto` in `refreshCodexDynamicTools` |
| Cursor, Droid, OpenCode, Copilot, Pi, Muse | A dedicated HTTP MCP lease (`ensureHttpMcpServer(managed, "cto")`) with a bearer header |

Only Claude, Codex, Cursor, OpenCode and Copilot can be the CTO
(`CTO_LIVE_REDIRECT_PROVIDERS`). What transports advertise is
`createCtoAdvertisedToolMap`: the runtime map through
`applyCtoToolPackVisibility`, which trims an unloaded pack's tools to a
one-line description without adding or removing a key. Deferral never gates a
capability; every CTO tool stays callable. Claude adds ToolSearch and Codex
per-tool `deferLoading` on top. See [CTO › Tool packs](../cto/README.md#tool-packs).

The internal server was renamed `ade-cto` → `daex-cto` (Codex `ade_cto` →
`daex_cto`); permission policies still accept `ade-cto`.

## CLI path

1. The CLI connects to the machine socket `<ADE home>/sock/ade.sock` and starts
   `daex serve` if it is missing. `ADE_RPC_SOCKET_PATH` overrides the path
   (tests, dev, scripts).
2. `--headless` bootstraps the project services directly for one command
   (same action protocol and formatters).
3. It sends `projects.add`, `ade/actions/list`, `ade/actions/call`.
4. `multiProjectRpcServer.ts` resolves the project; `adeRpcServer.ts` filters
   by role and dispatches.

The server unlinks a stale socket on start and tracks connections for clean
shutdown. `ade/initialize` returns `runtimeInfo` (`version`, `buildHash`,
`defaultRole`, `projectRoot`, `workspaceRoot`, `pid`, `cliEntryPath`) and
`capabilities.actions.listChanged: true`.

### Identity and roles

The CLI reads `ADE_CHAT_SESSION_ID`, `ADE_RUN_ID`, `ADE_OWNER_ID` and
`ADE_DEFAULT_ROLE` and sends them on `ade/initialize`. Roles: `cto`, `agent`,
`external`, `evaluator`.

`listToolSpecsForSession`:

- `cto`: base tools + CTO operator tools + CTO Linear sync tools.
- everyone else: base tools.
- Local computer-use tools are hidden when the caller may not use local
  computer use or an external backend is available.
- Standalone chats (a `chatSessionId` with no worker context) lose
  `STANDALONE_CHAT_HIDDEN_TOOL_NAMES` (`spawn_agent`).

`ade/actions/call` runs `callAction`, which validates input, applies the role
and policy checks and rate limits, and dispatches. Failures come back as
`{ ok: false, error: { code, message, expected?, frames? } }`, keeping DAEX
coded errors across the wire.

### Capability mode

`capabilityMode` on the chat session is `fallback` for lightweight sessions
and `full_tooling` otherwise.

### Finding the CLI from an agent

The guidance tells the agent the CLI should be on PATH, then to try
`$ADE_CLI_PATH`, then `$ADE_CLI_BIN_DIR/ade`, then (in a DAEX source checkout)
`node apps/ade-cli/dist/cli.cjs`.

For agents a brain launches, `ADE_CLI_PATH` is a shim written by
`createHeadlessAdeCliAgentEnv` under `<tmpdir>/ade-cli-shims/<hash>/`
(`ade-cli-shims-<uid>` on Linux, `defaultCliShimsRoot`). When the caller sets
neither `ADE_HOME` nor `ADE_RUNTIME_SOCKET_PATH`, the shim defaults both to its
brain's. The hash covers entry, runtime, socket and home. An explicit
`--socket` still wins. `ADE_CLI_ENTRY_PATH` names the entry the shim runs; a
standalone brain (Node SEA) is its own entry (`process.execPath`). On Windows
the app's brain uses a copy of `ade-cli-launcher.exe` at
`<shim>\launcher\ade.exe` beside an `ade.launch` file; it keeps the Node compile
cache under `<ADE_HOME>\cache\node-compile`.

A shell rc that rebuilds PATH can hide the shim, so every CLI run first checks
`ADE_CLI_PATH` (`cliDelegation.ts`, loaded first by `cliDelegationEntry.ts`)
and re-runs through it when it is a different entry. It never delegates from
a source-checkout build. `ADE_CLI_DELEGATED=1` stops loops;
`ADE_CLI_NO_DELEGATE=1` turns delegation off.

### Scheduled work

The typed CLI takes exactly one of `--in`, `--at` or `--cron`; the generic
action takes `delaySeconds`, `runAt` or `cron`. Relative and absolute forms
are one-shot, absolute times need `Z` or an offset, cron is brain-local. Both
paths print the brain timezone and the next run in local and ISO form. The
same rules are in `systemPrompt.ts` and the `daex-cli-control-plane` skill.

### Per-turn directives

`composeLaunchDirectives` prepends DAEX-authored blocks to the user message:

- **Lane worktree directive:** once per lane epoch. Agents may read outside the
  lane; edits and mutating commands stay inside it.
- **DAEX guidance** (`buildAdeGuidanceForLane`): every turn, only for providers
  with no trusted instruction channel. Claude, Codex and OpenCode carry it in a
  persistent system prompt. Droid's SDK takes no system prompt, so the whole
  harness prompt (which already ends with the `## DAEX` block) is re-sent each
  turn and only the lineage lines come from here.
- **Computer Use directive:** once per lane epoch and again when the available
  capture backends change (fingerprint of the rendered text). Losing every
  backend emits nothing; a session with no artifact broker gets nothing.

## Related docs

- [Agents README](README.md), [Chat Tool System](../chat/tool-system.md),
  [Chat Agent Routing](../chat/agent-routing.md).

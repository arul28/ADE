# ADE SDK

Embeddable chat sidecar for third-party apps. A host process owns an isolated
ADE runtime as a child, talks to it over NDJSON JSON-RPC, and presents chat as
durable named threads. The runtime is a guest: sync is off, it has no machine
brain authority, and it dies with the host.

This is not ADE desktop, ADE Code, or personal chats in the product UI. Those
surfaces stay first-party. The SDK is how a *different* app embeds ADE chat.

## Source file map

| Path | Role |
|---|---|
| `packages/sdk/src/client.ts` | `createAdeChat()` — public client: threads, models, providers, doctor, export, dispose. |
| `packages/sdk/src/thread.ts` | `AdeThread` — send, steer, interrupt, history, `setModel` (refuses mid-turn unless `{ force: true }`). |
| `packages/sdk/src/sidecar.ts` | Spawns `ade runtime run --socket <path> --profile embedded`, scrubs host `ADE_*` env, sets `ADE_EMBEDDED_PARENT_PID`. |
| `packages/sdk/src/jsonRpc.ts` | NDJSON JSON-RPC 2.0 over a Unix socket or Windows named pipe. |
| `packages/sdk/src/personalChats.ts` | Typed `personalChats.call` / push subscribe / cursor drain. |
| `packages/sdk/src/download.ts` | Fail-closed GitHub release fetch: binary + `.native.tar.gz` + `SHA256SUMS`. |
| `packages/sdk/src/binary.ts` | Resolves a local `ade` binary (explicit path, cache, PATH, else download). |
| `packages/sdk/src/runtimePidfile.ts` | `<home>/runtime.pid` reclaim with pid-recycling and start-time guards. |
| `packages/sdk/src/socketPath.ts` | Per-home Unix socket or hashed Windows named pipe. |
| `packages/sdk/src/windowsInvocation.ts` | `.cmd` / `.bat` spawn through `ComSpec`; argument quoting. |
| `packages/sdk/src/windowsSystemTools.ts` | Resolves `taskkill` / `tar` through `\\?\GLOBALROOT\SystemRoot\System32`, never PATH. |
| `packages/sdk/src/types.ts` | Hand-copied wire subset of `apps/desktop/src/shared/types/chat.ts` and `personalChats.ts` (the package does not import across the repo boundary). |
| `packages/sdk/src/permissions.ts` | `always-allow` → per-provider full-auto create args. |
| `apps/ade-cli/src/bootstrap.ts` | `runtimeProfile: "embedded"` — chat-only trim plus withheld machine-update/power controls and forced-off sync. |
| `apps/ade-cli/src/services/runtime/parentDeathWatchdog.ts` | Polls `ADE_EMBEDDED_PARENT_PID`; shuts the guest down if the host dies without unwinding. |
| `apps/desktop/src/shared/callerMcpServers.ts` | Caller MCP validation + the per-provider honesty table (`CALLER_MCP_SUPPORT`). |
| `packages/chat-ui/src/` | Embeddable React chat: Composer, Transcript, ModelPicker, activity labels, CSS-token theme. |
| `packages/chat-ui/src/adapters/sdkClient.ts` | `adaptSdkClient` — maps `@ade-dev/sdk` (or any SDK-shaped client) onto chat-ui props. |
| `packages/demo/` | DataDesk reference app (Vite renderer + WS bridge host) and live e2e. |

## Three packages

| Package | What it is |
|---|---|
| `@ade-dev/sdk` | Node / Electron-main client. Spawns and owns the sidecar. Zero runtime dependencies. |
| `@ade-dev/chat-ui` | React components. React is a peer; `@ade-dev/sdk` is an optional peer used for types only. No lanes, projects, or worktrees in any prop. |
| `@ade-dev/demo` | Private DataDesk reference. `e2e:preflight` is the CI-safe check; `e2e:live` spends provider tokens and is **not** in root `npm test`. |

Published as `@ade-dev/sdk` and `@ade-dev/chat-ui` on npm (`npm install @ade-dev/sdk`). In this repo, `npm run install:apps` covers `packages/sdk` and `packages/chat-ui`. Each package builds with tsup to `dist/`, which is gitignored — CI's `test-chat-ui` job builds `@ade-dev/sdk` first because chat-ui's `file:../sdk` exports point at that dist.

## Sidecar architecture

```
host process
  └─ @ade-dev/sdk  createAdeChat({ home })
        ├─ resolve / download `ade` (SHA256SUMS, fail closed)
        ├─ reclaim <home>/runtime.pid if a dead host left a live child
        └─ spawn: ade runtime run --socket <path> --profile embedded
              ADE_HOME=<home>
              ADE_EMBEDDED_PARENT_PID=<host pid>
              ADE_DEFAULT_ROLE=agent
              NDJSON JSON-RPC on the socket / named pipe
                personalChats.call / subscribeEvents / streamEvents
```

- Isolated `home`. Never the developer's `~/.ade`.
- `--profile embedded` is the only `--profile` value `ade runtime run` accepts. Anything else is a usage error, not a silent fall back to a full brain.
- Sync is forced off. `machine.updateAndRestart` and machine power transitions are withheld, not merely role-gated.
- The parent-death watchdog polls the host pid every 3 s. POSIX does not kill orphans on parent death; without this, a SIGKILL'd host leaks runtimes.
- Reclaim refuses to kill a pid it cannot corroborate (endpoint + start time). A recycled pid that predates the pidfile is left alone.

## Wire contract

The SDK speaks the machine JSON-RPC surface, not desktop IPC.

| Method | Role |
|---|---|
| `ade/initialize` / `ade/initialized` | Handshake. Client identity is `agent` by default. |
| `personalChats.call` | Allowlisted actions: create, send, steer, interrupt, models, … |
| `personalChats.subscribeEvents` / `unsubscribeEvents` | Push `runtime/event` notifications (`scope: "personal"`). Advertised as `capabilities.personalChats.pushEvents`. |
| `personalChats.streamEvents` | Cursor drain. Fallback when the runtime omits `pushEvents`. |
| `runtime/info` | Capabilities, including `personalChats.mcpServers`. |

Create args the SDK actually sends:

- `mcpServers` — caller-owned servers for this thread only.
- `strictMcpConfig` — tristate. Omitted = session-profile default (lightweight / SDK / personal is strict). `true` = withhold the user's MCP. `false` = load the user's MCP (`loadUserMcpServers: true`). An explicit `false` is not the same as absent.
- Orchestrator-lead markers are refused on this surface. A projectless chat cannot be an orchestration lead.

Durable threads: `threads.open("support", { provider, model })` creates or resumes by key stored under the home. Reopening the same key after a restart continues the conversation.

`setModel` refuses while a turn is in flight (`interrupt()` first, or `{ force: true }` to accept losing the turn). `dispose()` is not guarded that way — a shutdown that can refuse is worse than a truncated reply; the transcript is durable either way.

## Strict MCP honesty

`loadUserMcpServers: false` (the default when you supply servers) is a real guarantee **only on Claude**. Everywhere else ADE applies the strongest mechanism the provider exposes. Pi has no MCP surface and the create is refused rather than opening a tool-less thread.

| Provider | Strict level | What still loads under strict |
|---|---|---|
| claude | enforced | nothing MCP-wise (user rules/commands/output styles still load — they are not MCP) |
| codex | best-effort | servers contributed by a Codex *plugin* |
| cursor | best-effort | user-layer servers (`~/.cursor`; ADE's own preToolUse hook lives there) |
| droid | best-effort | tools that appear only after the first disable pass |
| opencode | best-effort | the global OpenCode config directory (for auth) |
| pi | unsupported | n/a — create refuses injected servers |

Source of truth: `CALLER_MCP_SUPPORT` in `apps/desktop/src/shared/callerMcpServers.ts`. The session summary carries `mcpCapability`:

```
{ level, mechanism, residual, delivered, strictRequested }
```

Read `strictRequested` first, then branch on `level`. `"enforced"` is the only value that means "nothing but the servers I supplied". Presence of the object is not a guarantee. `residual` is non-null only when strict was requested and something still leaks.

Do not market strict mode as uniform across providers.

## chat-ui contract

- CSS custom properties only (`createTheme({ accent, background })`). No Tailwind, no class overrides.
- Tool activity is renamed through an activity-label map + optional `resolve()` callback (wildcards, phase verbs, elapsed, icons).
- Transcript collapses streamed text and upgrades `tool_call` chips in place when `tool_result` lands on the same item id.
- `adaptSdkClient(client)` accepts `@ade-dev/sdk` or any SDK-shaped proxy (DataDesk's renderer talks over a WebSocket and still fits).

## Windows

Parity is required. The SDK never shells out to `taskkill` / `tar` from PATH; it resolves them through the kernel `GLOBALROOT` System32 alias. Named pipes are hashed from home + user identity and compared case-insensitively. `.cmd` / `.bat` wrappers go through `ComSpec`. File-lock retries cover `EBUSY` / `EPERM` / `EACCES`. `PATHEXT` is applied when discovering `ade` on PATH.

Native `windows-latest` CI still has to repeat the Windows-sensitive files; parameterized `win32` contract tests are the local proof.

## Gotchas

- Never point a sidecar `home` at the developer's `~/.ade` or the default machine socket.
- Never treat `mcpCapability` truthiness as "strict was enforced".
- Never add typed `--mcp-servers` / `--strict-mcp` CLI flags as a second spelling of `--arg-json`; the nested JSON is what that hatch already carries. The SDK is the intended embedder API.
- `packages/sdk/dist` is gitignored. Anything that typechecks against `@ade-dev/sdk` from source must build it first.
- `packages/demo` live e2e spends provider tokens. Do not add it to root `npm test`.

## Related docs

- Public Mintlify: [ADE SDK](https://www.ade-app.dev/docs/sdk/overview) — user-facing install, threads, MCP honesty, chat-ui, runtime, reference. Keep `sdk/*.mdx` in lockstep with this page when the contract changes.
- [Chat](../chat/README.md#caller-injected-mcp) — engine-side injection, tristate, capability report.
- [Personal chats](../personal-chats/README.md) — the machine RPC the sidecar actually calls.
- [ARCHITECTURE.md](../../ARCHITECTURE.md) §2.1 — embedded runtime profile and parent-death watchdog.
- [ADE CLI README](../../../apps/ade-cli/README.md) — `ade runtime run --profile embedded`.

# DAEX SDK

An embeddable chat sidecar for third-party apps. A host process owns an isolated
DAEX runtime as a child, talks to it over NDJSON JSON-RPC, and presents chat as
durable named threads. The runtime is a guest: sync is off, it has no machine
brain authority, and it dies with the host. This is how a *different* app embeds
DAEX chat; DAEX's own surfaces stay first-party.

Packages are `@daex-dev/sdk` and `@daex-dev/chat-ui` (0.7.1). The old
`@ade-dev/*` names and every `Ade*` export (`createAdeChat`, `AdeError`, …) are
deprecated aliases of the `Daex*` names. The runtime platform packages keep
their `@ade-dev/runtime*` names (the SDK resolves them by that name). See
`packages/MIGRATING-TO-DAEX-DEV.md`.

## Source file map

| Path | Role |
|---|---|
| `packages/sdk/src/client.ts`, `clientOptions.ts` | `createDaexChat()`: accounts, credentials, presets, providers, threads, models, doctor, export, events, `autoRestart`, resume/recreate, runtime-lost handling; the public option types. |
| `packages/sdk/src/thread.ts` | `DaexThread`: send, steer, queue, stop, slash commands, recovery, usage-limit actions, account switching, retry/edit, interrupt, update, history, model, approvals (and the opt-in approval timeout). |
| `packages/sdk/src/run.ts` | `client.run()`: temporary one-shot thread with JSON Schema subset validation and one repair attempt. |
| `packages/sdk/src/accounts.ts`, `usage.ts` | Accounts, credentials and presets over feature-detected actions; per-thread token/cost usage and budgets. |
| `packages/sdk/src/server.ts`, `remoteClient.ts` | `@daex-dev/sdk/server`: host-owned WebSocket bridge and `createDaexRemoteClient`; the browser-safe remote proxy. |
| `packages/sdk/src/testing.ts` | `@daex-dev/sdk/testing`: scripted mock client. |
| `packages/sdk/src/electron/` | The Electron bridge: `main.ts` (`registerDaexIpc`), `preload.ts`, `preload-auto.ts`, `renderer.ts`, `global.ts`, `protocol.ts`. |
| `packages/sdk/src/sidecar.ts`, `jsonRpc.ts`, `socketPath.ts`, `runtimePidfile.ts` | Spawn `daex runtime run --profile embedded`, JSON-RPC over socket or pipe, per-home endpoint, pidfile reclaim. |
| `packages/sdk/src/binary.ts`, `bundledRuntime.ts`, `packagedRuntime.ts`, `download.ts`, `runtimeSignature.ts`, `compatibility.ts` | Runtime resolution (explicit, bundled package, packaged in an app, cache, PATH, download), fail-closed download, signature probe, `SUPPORTED_RUNTIME_RANGE`. |
| `packages/sdk/src/threadStore.ts`, `mcpHeaders.ts` | `<home>/threads.json` and MCP header-name persistence. |
| `packages/sdk/src/hostConfig.ts`, `permissions.ts`, `approvals.ts`, `threadWarnings.ts` | Host config normalization and checks, permission presets and policy validation, approval mapping, resume/open warnings. |
| `packages/sdk/src/providers.ts`, `providerStatusPublisher.ts`, `doctorReport.ts` | Provider catalog, `pickDefaultModel`, `providers.status` merge, `client.providers`, `doctor()`. |
| `packages/sdk/src/types.ts`, `scripts/check-wire-types.mjs` | Hand-copied wire subset of the desktop chat types; the CI drift check. |
| `packages/sdk/src/attachments.ts`, `toolIdentity.ts`, `fsProbe.ts`, `personalChats.ts`, `windowsInvocation.ts`, `windowsSystemTools.ts` | Attachment type inference, tool-name parsing, path probes, personal-chat calls, Windows spawning. |
| `packages/sdk/examples/electron/` | Runnable reference app (not installed by CI). |
| `packages/chat-ui/src/` | Embeddable React chat (`adapters/sdkClient.ts`, `transcript/ApprovalCard.tsx`, …). |
| `packages/demo/` | DataDesk reference app and live e2e. |
| `apps/ade-cli/src/bootstrap.ts`, `services/runtime/parentDeathWatchdog.ts` | `runtimeProfile: "embedded"` and the parent-death watchdog. |
| `apps/desktop/src/shared/callerMcpServers.ts`, `hostSessionConfig.ts`, `permissionPolicy.ts`, `providers.ts`, `pathContainment.ts` | Engine-side honesty tables, policy rules, `ShippedProvider`, path containment. |
| `apps/desktop/src/main/services/chat/personalSession.ts`, `claudeToolGate.ts`, `codexApprovalContainment.ts`, `codexMcpElicitation.ts` | Personal chat cwd and prompt; the Claude tool gate; Codex approval containment and MCP elicitation. |
| `apps/desktop/src/main/services/ai/providerStatusProbe.ts` (+ `providerBinaryResolvers.ts`, `providerAuthResolvers.ts`, `providerProbeSeams.ts`, `providerStatusDetails.ts`), `apps/desktop/src/shared/providerRemediation.ts` | The `providers.status` probe and the shared install/login/docs table. |
| `apps/ade-cli/scripts/build-runtime-npm-packages.mjs`, `verify-runtime-package-contents.mjs`, `.github/workflows/publish-runtime-packages.yml` | Build, verify and publish the `@ade-dev/runtime*` packages on `release.published`. |
| `scripts/check-package-licenses.mjs` | License consistency check for published packages. |

## Gotchas / fragile areas

- Never point a sidecar `home` at the developer's `~/.ade` or the default machine
  socket.
- Never treat a capability report's presence as a guarantee. Read `level`, and for
  MCP read `strictRequested` first. A null report means "never asked" or "an older
  runtime said nothing"; neither is a pass.
- Never read `ProviderStatus.installed` without `source`: on `"derived"` it only
  means DAEX knows models for that provider.
- `doctor().runtime.signature === null` means "not known", not "unsigned".
- Never add a `canUseTool` to the Claude personal path without a policy: a chat
  that starts emitting `approval_request` parks turns for embedders that render
  no card.
- Never infer a tool's risk from its name. The Claude read-only exemption is a
  literal name-set test.
- Never rely on `canUseTool` alone for Claude. It does not fire for commands
  Claude Code deems read-only, and `settingSources` layers can pre-approve.
  Enforcement goes in `allowedTools` / `disallowedTools` and
  `allowManagedMcpServersOnly`.
- Never persist MCP header values on either side. Store `headerNames`.
- Never assign over `opts.managedSettings.allowedMcpServers`; merge (DAEX's own
  servers are already in it).
- Derive capability reports in one place (the persisted-state loader) and
  resolve a personal host cwd in one place (`resolvePersonalHostCwd`); a second
  site drifts and restarts the provider every turn.
- `packages/sdk/dist` is gitignored; build before typechecking against it.
- `packages/demo` live e2e spends provider tokens; keep it out of root `npm test`.
- `@daex-dev/sdk/server` creates no listener and picks no WebSocket package; the
  host owns networking, auth and `authorize` / `allowThreadKey`.

## Packages

| Package | What it is |
|---|---|
| `@daex-dev/sdk` | Node / Electron-main client. Spawns and owns the sidecar. Zero runtime dependencies. |
| `@daex-dev/chat-ui` | React components. React is a peer; `@daex-dev/sdk` an optional types-only peer. No lanes, projects or worktrees in any prop. |
| `@daex-dev/demo` | Private DataDesk reference. `e2e:preflight` is CI-safe; `e2e:live` spends tokens. |

In this repo `npm run install:apps` covers `packages/sdk` and `packages/chat-ui`.
Both build with tsup to `dist/`; CI builds the SDK before chat-ui because
chat-ui's `file:../sdk` exports point at that dist. Source maps are off in
package builds (they tripled the packed size).

## Sidecar architecture

```
host process
  └─ @daex-dev/sdk  createDaexChat({ home })
        ├─ resolve runtime: binaryPath → @ade-dev/runtime-<target> → home cache → PATH → download
        │    (download verifies SHA256SUMS, fails closed; allowDownload:false throws runtime_unavailable)
        ├─ reclaim <home>/runtime.pid if a dead host left a live child
        └─ spawn: daex runtime run --socket <path> --profile embedded
              ADE_HOME=<home>, ADE_EMBEDDED_PARENT_PID=<host pid>, ADE_DEFAULT_ROLE=agent
              NDJSON JSON-RPC: personalChats.call / subscribeEvents / streamEvents
```

- `--profile embedded` is the only profile `daex runtime run` accepts; anything
  else is a usage error.
- Sync is forced off; `machine.updateAndRestart` and power transitions are
  withheld entirely.
- The parent-death watchdog polls the host pid every 3 s (POSIX does not kill
  orphans).
- Reclaim never kills a pid it cannot corroborate (endpoint + start time).
- The sidecar scrubs host `ADE_*` env and starts with isolated provider logins
  (`useMachineLogin` defaults to `false`; `ADE_EMBEDDED_PROVIDER_LOGINS=isolated`
  puts provider homes under `<ADE_HOME>/provider-homes/<provider>/default`).

### Bundled runtime

A signed, notarized app cannot download an executable at first run, so each
release also publishes five `@ade-dev/runtime-<target>` packages (`bin/ade[.exe]`
plus the embedded-profile `native/` tree, `LICENSE`,
`RUNTIME-EMBEDDING-EXCEPTION.md`) and the `@ade-dev/runtime` meta package that
lists them as `optionalDependencies`. The embedded tree omits UI-only packages,
`@linear/sdk` and cr-sqlite.

- `runtimeRoot` (`ADE_RUNTIME_ROOT`) and `runtimeNodeModules`
  (`ADE_RUNTIME_NODE_MODULES`) must travel together; both are validated at
  create.
- `resolveBundledRuntime()` returns `null` when no package is installed and throws
  `binary_not_found` for a malformed one. `resolvePackagedRuntime(resourcesPath)`
  finds `<resources>/ade-runtime` (with a Mach-O arch check, `source: "packaged"`).
- Pinned and bundled routes skip `SHA256SUMS`: the OS verifies signed bundles.
- `doctor().runtime` reports `source`, paths, `signature`, `checksumVerified` and
  `compatibility`. On macOS `signature.accepted` assesses the outermost `.app`.
- Public guide: `sdk/bundling.mdx`.

## Wire contract

| Method | Role |
|---|---|
| `ade/initialize` / `ade/initialized` | Handshake; client role `agent` by default. Returns `runtimeInfo.version`. |
| `personalChats.call` | Allowlisted actions (create, send, steer, interrupt, models, approve, pendingInputs, delete, archive, updateSession, getEventHistoryPage, …). |
| `personalChats.subscribeEvents` / `unsubscribeEvents` | Push `runtime/event` (`scope: "personal"`), advertised as `capabilities.personalChats.pushEvents`. |
| `personalChats.streamEvents` | Cursor drain fallback. |
| `providerAccounts.call`, `credentials.call`, `presets.call` | Accounts and login flow, multi-key storage (summaries only, never key values), harness presets. |
| `providers.status` | Machine-scope provider probe (below). |
| `runtime/info` | Capabilities. |

The SDK feature-detects everything through `runtime/info` and throws
`unsupported` naming the action when absent. Outside `SUPPORTED_RUNTIME_RANGE`
(`>=1.2.82 <2.0.0`) it logs once, or throws `runtime_incompatible` with
`requireCompatibleRuntime: true`.

**Host token.** Outside the embedded profile, accounts, credentials and presets
are CTO-only. In an embedded runtime, socket access is not proof (the runtime's
own agents get a CLI pointed at it), so the SDK puts a fresh secret in
`ADE_EMBEDDED_HOST_TOKEN` per spawn; the runtime takes and deletes it
(`takeEmbeddedHostToken`), and only the connection whose `ade/initialize` carries
`embeddedHostToken` may call those three. Attach mode and adopted runtimes have
no token and fail `unsupported`.

**`BufferedEvent.category` is open.** A newer runtime may send categories this SDK
does not know; only `"runtime"` is decoded as chat, and the drain fallback polls
with no category filter so the cursor advances.

### Create args

- `mcpServers`: caller-owned servers for this thread, with optional per-server
  `allowedTools` / `disallowedTools` (gated on
  `capabilities.personalChats.mcpToolFilters`; Codex enforces both, Claude only
  `disallowedTools`, others refuse).
- `strictMcpConfig`: tristate. Omitted = profile default (strict for personal);
  `true` withholds the user's MCP; `false` loads it.
- `instructions`: `{ mode: "append" | "replace", text }` (a bare string means
  append).
- `requestedCwd`: absolute, validated on both sides.
- `settingSources`: `none` (default) | `project` | `user` | `all`.
- `permissionPolicy`: the policy form of `permissions`, sent with
  `permissionMode: "default"` so a runtime that ignores it prompts more, never
  less.

**Create only.** Resume reads all host configuration from the stored record and
ignores the call's values, logging one line per differing option
(`threadResumeMismatchWarnings`). Recreate (record exists, session lost) also
uses the record, so a caller who can name a key cannot rebuild a thread under a
looser policy. To change configuration, open a different key. The exception is
`refresh.mcpServers`.

`updateSession` changes `title`, `reasoningEffort`, `fastMode`, and for personal
sessions `mcpServers` (full validation, provider restart). Mid-turn it is queued
and installed at the turn's end (`mcpServersPending: true` until then); an older
runtime refuses with `turn_in_flight`.

`setModel`, reasoning updates, retry and edit refuse while a turn runs
(`interrupt()` first, or `{ force: true }` for model/reasoning). `dispose()` is
never refused. `thread.retry()` and `editLast()` work for Claude and Codex.

**Attachments.** `AgentChatFileRef.type` is inferred by the SDK; `hydrate: false`
sends only a path hint. Relative paths resolve in the chat's working directory;
absolute ones must be inside it, the project root or an `attachmentRoots` entry.
Inline images are downscaled per provider limits. `filterAttachmentRoots` drops
roots the runtime would refuse (one bad root fails the whole open).

### MCP header persistence

Header values never reach durable state. Stores keep `headerNames`; values are
resolved at every create, resume, recreate and `autoRestart` from explicit
headers, then `refresh.mcpServers`, then the `mcpHeaders` callback (sync or
async). With a callback, `send`, `retry` and `editLast` re-resolve and push
through `updateSession` when the fingerprint changed;
`thread.refreshMcpHeaders()` does it on demand. After a runtime restart a
server with withheld headers connects without them and the transcript gets a
`system_notice`. `redactCallerMcpText` scrubs secrets from MCP error text.

## Provider honesty

Each provider is told the same host options through the strongest mechanism it
has. The levels live in four tables keyed by `ShippedProvider` (`claude`,
`codex`, `cursor`, `droid`, `opencode`, `pi`, `muse`): `CALLER_MCP_SUPPORT`
(`callerMcpServers.ts`), `INSTRUCTIONS_SUPPORT`, `SETTING_SOURCES_SUPPORT` and
`PERMISSION_POLICY_SUPPORT` (`hostSessionConfig.ts`). A provider with no row
gets a null report. Read the tables for the `mechanism` and `residual` text; the
summary today:

| Provider | Strict MCP | Instructions | settingSources | Permission policy |
|---|---|---|---|---|
| claude | enforced | applied | applied (all four) | enforced with `fallback: "deny"` (best-effort if an allow names one MCP tool); best-effort with `"ask"` |
| codex | best-effort (plugin servers load) | applied | `project`/`all` best-effort, `none`/`user` ignored | best-effort |
| cursor | best-effort (user-layer servers) | best-effort | ignored | unsupported |
| droid | best-effort | best-effort | ignored | unsupported |
| opencode | best-effort | applied | ignored | unsupported |
| pi | unsupported (create refuses servers) | applied | ignored | unsupported |
| muse | best-effort (user's `~/.config/muse` servers) | best-effort | `project`/`all` best-effort, `none`/`user` ignored | unsupported |

## Strict MCP honesty

`loadUserMcpServers: false` is a real guarantee only on Claude. The session
summary's `mcpCapability` is `{ level, mechanism, residual, delivered,
strictRequested }`: read `strictRequested`, then `level`; only `"enforced"` means
"nothing but my servers"; `residual` names what leaks. Codex refuses `sse`
servers. Reserved names: `computer_use`, `daex-cto` and its old name `ade-cto`.
At most 32 servers. Do not market strict mode as uniform.

## Instructions, cwd, settingSources

All three are optional (omitting them reproduces 0.1.x behavior) and persist on
the session.

- **`instructions`**: `append` keeps DAEX's personal-chat prompt and adds the
  host text; `replace` sends only the host text (needed for a chat branded as the
  host's assistant). Cursor, Droid and Muse have no instruction field, so the text
  joins the prompt DAEX already prefixes. Summary: `instructionsCapability`
  `{ level, mode, mechanism, detail }`, absent when not asked.
- **`requestedCwd`**: default `<ADE_HOME>/personal-chats/workspaces` (0700); a host
  directory is created at 0755. Refused: relative, `~`, filesystem or drive or UNC
  root, the home directory, anything inside DAEX state (`invalid_argument:`). The
  path is canonicalized (`realpathSync.native` on the deepest existing ancestor)
  before checks, on both sides; `canonicalThreadCwd` is the non-refusing form for
  resume comparison. It replaces `laneWorktreePath` for personal sessions only,
  through `resolvePersonalHostCwd`, and callers must withhold `requestedCwd` from
  `resolveLaneLaunchContext` (which would reject it as an escape).
- **`settingSources`**: on Claude maps to `[]`, `["project"]`, `["user"]`,
  `["user", "project", "local"]`, always set explicitly. Codex always reads
  `AGENTS.md` and `~/.codex/AGENTS.md`, so `project`/`all` describe what already
  happens and `none`/`user` cannot be honored. Summary:
  `settingSourcesCapability` `{ level, value, mechanism, detail }`, per value.

## Permission policy and approvals

`permissions` on `threads.open` is `"default"`, `"always-allow"`, or a policy:

```
{
  allowedTools?: string[];          // exact names, or a trailing "*" prefix
  deniedTools?: string[];           // wins over allowedTools
  autoApproveMcpServers?: string[]; // every tool of these servers
  sandboxRoot?: string;             // absolute; commands and writes inside it
  fallback: "ask" | "deny";         // required
  approvalTimeoutMs?: number;       // SDK-only, see below
}
```

Precedence: `deniedTools`, then `allowedTools` / `autoApproveMcpServers`, then
`sandboxRoot` containment, then `fallback`. A call that names no path (Claude's
`Bash`) is decided by tool rules and fallback. A policy with no `sandboxRoot`
contains nothing. MCP tools are `mcp:<server>:<tool>` (`mcp:<server>:*` for the
whole server); other names match the provider's own tool names
case-insensitively. `ade-cto` and `daex-cto` match each other
(`mcpServerNameAliases`). Rules live in `shared/permissionPolicy.ts`, read by
both the Claude gate and the Codex handlers.

- Under `fallback: "ask"`, Claude's read-only built-ins (`Read`, `Glob`, `Grep`,
  `ToolSearch`, `TaskList`, `TaskGet`, `WebFetch`, `WebSearch`) run without a card
  (literal names; never MCP tools). Under `"deny"` nothing unmatched runs.
- `deniedTools` beats everything, including `AskUserQuestion` / `ask_user`, which
  normally skip the card. An allow entry lets a tool run; it does not skip its
  own UI.
- **Claude, `fallback: "deny"`**: unnamed mutating built-ins
  (`CLAUDE_MUTATING_BUILTIN_TOOLS`) go into `disallowedTools`; MCP is limited to
  servers the policy names via `allowManagedMcpServersOnly` (a supplied server
  the policy does not name is unreachable); `canUseTool` is a second line.
  `sandboxRoot` is not applied (refusal is stricter), and naming one MCP tool
  admits its whole server; both are in `residual`.
- **Codex**: `approvalPolicy: on-request` with `sandbox: workspace-write`, so the
  policy only answers what Codex raises: sandbox escapes
  (`codexApprovalContainment.ts`) and MCP tool calls. Codex asks before every MCP
  tool call via `mcpServer/elicitation/request`; the tool name comes from
  `_meta.tool_name` or the message (`codexMcpElicitation.ts`), and is judged on
  `mcp:<server>:<tool>`. Unparseable names are judged on the server alone.
- Summary: `permissionCapability` `{ level, mechanism, residual }`.

**Answering.** An `approval_request` blocks the turn indefinitely by design; a
host must render a card for each, or use `fallback: "deny"`. Answer with
`approve` (`{ sessionId, itemId, decision, responseText? }`, decision `accept`,
`accept_for_session`, `decline`, `cancel`) or `interrupt()`. On Codex,
`accept_for_session` sends `_meta.persist: "session"` when offered (never
`"always"`, which writes to the user's `config.toml`, unless it is the only
scope). On Claude it records a session override unless the ask sets
`suppressAlwaysAllowRule`. With `fallback: "deny"` on Codex the transcript still
records the request and a declined `pending_input_resolved`. `pendingInputs`
lists what is still waiting (resident state only; empty after a restart). The
SDK raises `approval_not_found` for an already-settled item.
`approvalTimeoutMs` is stripped before the wire and enforced in `thread.ts`: an
approval this client saw that nobody answered in time is declined.

## Provider status

`providers.status` (top-level RPC, `capabilities.providers.status`) answers which
coding CLIs the machine has, where, which version, and whether they are signed
in, from the same resolvers that pick what a chat spawns. Params
`{ refresh?: boolean }`. Each record: `provider`, `displayName`, `installed`,
`binaryPath`, `version`, `authenticated`, `authMethod`, `installCommand` (always
`null`: DAEX downloads its own pinned copy), `loginCommand`, `docsUrl`,
`source: "probed"`, `stale`, `checkedAt`, `detail`, `capabilities` (permission
modes, efforts, fast mode, accounts, sign-in kind, API keys, presets, MCP level)
and `isolation`. Without the RPC the SDK derives records from the catalog
(`source: "derived"`).

- A bare command name from a resolver counts only after a PATH lookup.
- `version` is the first line of `--version`, 5 s cap.
- `authenticated`: Claude and Codex climb a ladder (credentials file, API key env,
  for Claude `~/.claude.json` `oauthAccount`, the auth detector's cache, then one
  bounded `auth status` spawn for an installed CLI). Others read disk and env only.
  The probe never reads the Keychain and makes no network call.
- Cache 60 s per provider (`PROVIDER_STATUS_CACHE_TTL_MS`); `stale` means "from
  cache". `refresh: true` is for an "I just signed in" button, never polling.
  Concurrent callers share one probe; the report is capped at 8 s.
- Login strings come from `shared/providerRemediation.ts`. Droid's is bare
  `droid`; Pi's is bare `pi` (`/login` inside).

Dispatch: `apps/ade-cli/src/multiProjectRpcServer.ts`.

## Electron bridge

The SDK runs in the main process; the bridge gives a sandboxed renderer a client.

| Export | Function |
|---|---|
| `@daex-dev/sdk/electron` | `registerDaexIpc(ipcMain, clientOrGetter, opts?)` → dispose |
| `@daex-dev/sdk/electron/preload` | `exposeDaexBridge(contextBridge, ipcRenderer, opts?)` (exported, not called) |
| `@daex-dev/sdk/electron/preload-auto` | Calls it with key and prefix `ade`; point `webPreferences.preload` here |
| `@daex-dev/sdk/electron/renderer` | `createDaexIpcClient(bridge)` |
| `@daex-dev/sdk/electron/global` | Types only: `window.ade: DaexBridge` (kept as `ade` for compatibility) |

- No dependency on `electron`; structural interfaces only. The preload is one
  file with zero imports (sandboxed preloads have no module loader).
- Channels `<prefix>:invoke` and `<prefix>:event`; a per-`webContents` registry
  is disposed on destroy or navigation.
- Errors rehydrate as `DaexError` with `code`.
- The renderer client subscribes before `history()` and dedupes on
  `sessionId:sequence:timestamp:type`, so each envelope arrives once, in order.
- Host gates: `authorize`, `allowThreadKey` (also filters `threads.list`),
  `allowModel`, `allowAccountManagement`. `onThreadRemoved(key, kind)` fires once
  per delete/archive.
- The renderer never configures a thread: an `openOptions` hook decides, else only
  `provider`, `model`, `title` and `reasoningEffort` pass
  (`ADE_IPC_RENDERER_OPEN_FIELDS`). `thread.updateMcpServers` is not exposed.
- A getter that returns a new client moves renderer threads and subscriptions
  across on the next call.
- Attachments cross as `{ path }` only.

Public guide `sdk/electron.mdx`; reference app `packages/sdk/examples/electron/`.

## Other host APIs

- `client.run()` uses a random temporary thread deleted in `finally`, supports
  only the exported `JsonSchema` subset, strips one code fence, makes one repair
  attempt, times out per turn (default 10 minutes), and rejects a turn that asks
  for input with `unsupported`.
- Budgets persist with the thread key. Cost totals include only provider-reported
  costs. `thread.usage().complete` is false when history could not be read; with a
  budget the SDK then refuses new turns.
- `createDaexRemoteClient(url)` needs a global `WebSocket` (or pass one).
- `models.defaultModel({ prefer })` ranks within one provider's models.

## chat-ui contract

- CSS custom properties only (`createTheme`); no Tailwind or class overrides.
- `adaptSdkClient(client)` accepts the SDK or any SDK-shaped proxy.
- The transcript collapses streamed text and upgrades `tool_call` and
  `approval_request` rows in place.
- Approvals render inline and settle in place; `approve` and `pendingApprovals`
  are optional (read-only card without them). Questions and plan approvals use
  optional `thread.respond`.
- Queue, slash-command, usage-limit, account and credential surfaces are optional
  and hidden when absent. Standalone exports include `AccountList`, `SignInCard`,
  `ApiKeyForm`, `UsageMeter`, `AccountSwitcher`, `QueueStrip`, `PendingInputCard`,
  `UsageLimitNotice`, `ProviderCard` (reads `source` before claiming "Not
  installed").

## Windows

The SDK resolves `taskkill` / `tar` through the `GLOBALROOT` System32 alias, never
PATH. Named pipes are hashed from home + user. `.cmd` / `.bat` go through
`ComSpec`. File-lock retries cover `EBUSY` / `EPERM` / `EACCES`. `PATHEXT` applies
on PATH discovery.

## Related docs

- Public docs: pages under `sdk/*.mdx` (nav in `docs.json`). Keep them in step
  with this page.
- [Chat](../chat/README.md#caller-injected-mcp): engine-side injection.
- [Personal chats](../personal-chats/README.md): the RPC the sidecar calls.
- [ARCHITECTURE.md](../../ARCHITECTURE.md) §2.1: embedded profile and watchdog.

## License

`@daex-dev/sdk` and `@daex-dev/chat-ui` are MIT. The runtime and DAEX are
AGPL-3.0-only, with the DAEX Runtime Embedding Exception
([`RUNTIME-EMBEDDING-EXCEPTION.md`](../../../RUNTIME-EMBEDDING-EXCEPTION.md)) on
the runtime binary. [`sdk/license.mdx`](../../../sdk/license.mdx) records the
per-artifact decision; update it first. `scripts/check-package-licenses.mjs`
(run in the `packages` CI job with `--require-pack`) asserts each published
package's SPDX field, `LICENSE`, tarball list and README section agree. The
runtime package builder copies `LICENSE` and the exception into each
`@ade-dev/runtime-*` package.

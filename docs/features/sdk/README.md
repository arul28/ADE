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
| `packages/sdk/src/binary.ts` | Resolves a local `ade` binary: explicit path, bundled platform package, home cache, PATH, else download. |
| `packages/sdk/src/bundledRuntime.ts` | `resolveBundledRuntime()` — finds an installed `@ade-dev/runtime-<target>` package and its `bin/` + `native/` halves. |
| `packages/sdk/src/runtimeSignature.ts` | `probeRuntimeSignature()` — `codesign` + `spctl` on macOS, `Get-AuthenticodeSignature` on Windows. Never throws; null means "not known". |
| `packages/sdk/src/electron/main.ts` | `registerAdeIpc()` — one `ipcMain.handle`, a per-`webContents.id` registry, `authorize` / `allowThreadKey` gates, teardown on destroy and navigation. |
| `packages/sdk/src/electron/preload.ts` | `exposeAdeBridge()` — single-file, zero-import preload safe under `sandbox: true`. |
| `packages/sdk/src/electron/renderer.ts` | `createAdeIpcClient()` — the renderer-side client that structurally satisfies chat-ui's `SdkLikeChatClient`. |
| `packages/sdk/src/electron/protocol.ts` | Channel names, error serialization, `envelopeDedupeKey`, and the history/live merge. |
| `packages/sdk/examples/electron/` | Runnable reference app: `sandbox: true`, `contextIsolation: true`, strict CSP. Not installed by CI. |
| `apps/ade-cli/scripts/build-runtime-npm-packages.mjs` | Builds the six `@ade-dev/runtime*` packages from a release's artifacts. |
| `apps/ade-cli/scripts/verify-runtime-package-contents.mjs` | Re-runs the packed-file assertion between build and publish, against the directories about to be published rather than the ones the build believed it wrote. |
| `.github/workflows/publish-runtime-packages.yml` | Publishes those packages when a GitHub release is published (`release.published`), the same event `/release` uses when it undrafts. `workflow_dispatch` (`tag` + confirm `publish`) is recovery. Checksum-verified, skip-if-version-exists. |
| `scripts/check-package-licenses.mjs` | Asserts the SPDX field, `LICENSE` file, tarball file list, and README `## License` section agree for every published package. |
| `packages/sdk/src/runtimePidfile.ts` | `<home>/runtime.pid` reclaim with pid-recycling and start-time guards. |
| `packages/sdk/src/socketPath.ts` | Per-home Unix socket or hashed Windows named pipe. |
| `packages/sdk/src/windowsInvocation.ts` | `.cmd` / `.bat` spawn through `ComSpec`; argument quoting. |
| `packages/sdk/src/windowsSystemTools.ts` | Resolves `taskkill` / `tar` through `\\?\GLOBALROOT\SystemRoot\System32`, never PATH. |
| `packages/sdk/src/types.ts` | Hand-copied wire subset of `apps/desktop/src/shared/types/chat.ts` and `personalChats.ts` (the package does not import across the repo boundary). |
| `packages/sdk/src/permissions.ts` | `always-allow` → per-provider full-auto create args; `ThreadPermissionPolicy` validation (`fallback` required, absolute `sandboxRoot`). |
| `packages/sdk/src/hostConfig.ts` | `instructions` / `cwd` / `settingSources` normalization and the three capability reports. |
| `packages/sdk/src/approvals.ts` | `ApprovalDecision` → engine decision, and `PendingInputRequest` → `ApprovalRequest`. |
| `packages/sdk/src/providers.ts` | Catalog derivation, the `providers.status` merge rule, and the `onChange` fingerprint. |
| `packages/sdk/src/providerStatusPublisher.ts` | The `client.providers` surface: probe, merge, cache, listener set, poll timer. The poll never asks to refresh. |
| `packages/sdk/src/clientOptions.ts` | The public option types for `createAdeChat` and `threads.open`, kept apart from the lifecycle file because they are mostly prose an embedder must read. |
| `packages/sdk/src/threadWarnings.ts` | Every line a newly opened or resumed thread earns: unreported capabilities, the two deny-policy holes, and one line per option a resume ignored. Pure, so the honesty rules are testable without a runtime. |
| `packages/sdk/src/doctorReport.ts` | Assembles `doctor()` from values the client already holds, including the `ok` judgement. Pure. |
| `packages/sdk/src/fsProbe.ts` | One copy of "does this path exist and is it the kind I expect". Missing, unreadable, and wrong-kind are all "no", so a resolution step falls through instead of throwing. |
| `apps/ade-cli/src/bootstrap.ts` | `runtimeProfile: "embedded"` — chat-only trim plus withheld machine-update/power controls and forced-off sync. |
| `apps/ade-cli/src/services/runtime/parentDeathWatchdog.ts` | Polls `ADE_EMBEDDED_PARENT_PID`; shuts the guest down if the host dies without unwinding. |
| `apps/desktop/src/shared/callerMcpServers.ts` | Caller MCP validation + the per-provider honesty table (`CALLER_MCP_SUPPORT`). |
| `apps/desktop/src/shared/hostSessionConfig.ts` | Host session configuration: the three per-provider honesty tables (`INSTRUCTIONS_SUPPORT`, `SETTING_SOURCES_SUPPORT`, `PERMISSION_POLICY_SUPPORT`), the Claude `settingSources` map, and the normalizers and capability resolvers. |
| `apps/desktop/src/shared/permissionPolicy.ts` | The permission policy's rules: normalization, neutral ⇄ Claude tool-name translation, pattern matching, and the Claude tool lists. |
| `apps/desktop/src/shared/pathContainment.ts` | `pathIsWithinRoot` / `pathsEqual` — the one containment rule, its platform case-fold, and the base a relative target resolves against. Used by the permission policy and by the CLI's personal-chat cwd guard. |
| `apps/desktop/src/shared/providers.ts` | `ShippedProvider` — the one closed provider union the three per-provider tables are keyed by. |
| `apps/desktop/src/main/services/chat/personalSession.ts` | What a personal chat is (`isPersonalSession`), where it runs (`resolvePersonalHostCwd`), and what its provider is told (`PERSONAL_CHAT_SYSTEM_PROMPT`, `resolvePersonalSystemPrompt`). |
| `apps/desktop/src/main/services/chat/claudeToolGate.ts` | What ADE knows about one Claude tool call before deciding: name normalization, the read-only built-in set, the paths a call names, and the pre-policy prompting heuristic. |
| `apps/desktop/src/main/services/chat/codexApprovalContainment.ts` | Which Codex approvals ADE answers itself, and the containment root each is checked against. The only place a host `sandboxRoot` takes effect on Codex. |
| `apps/desktop/src/shared/providerRemediation.ts` | `PROVIDER_REMEDIATION` — one table of install command, login command, docs URL and display name per provider, with win32 spellings. Read by the Settings CLI cards, the model picker's empty states, the CLI agent registry, and `providers.status`; none of the four keeps its own copy. |
| `apps/desktop/src/main/services/ai/providerStatusProbe.ts` | The `providers.status` probe: per-provider orchestration, 60 s cache, shared in-flight probe, 8 s overall budget. |
| `apps/desktop/src/main/services/ai/providerBinaryResolvers.ts` | Where each provider's binary is, per provider. A resolver that produced only a bare command name is confirmed on PATH or reported absent. |
| `apps/desktop/src/main/services/ai/providerAuthResolvers.ts` | Whether each provider has usable credentials, read from disk and the environment first, with one bounded `auth status` spawn as the last rung for Claude and Codex. Never opens the Keychain. |
| `apps/desktop/src/main/services/ai/providerProbeSeams.ts` | The injectable edges of the probe — env, platform, filesystem, PATH lookup, spawn, file read, process termination — so the probe is testable without a real CLI on the machine. The clock is not a seam; `now` is a probe option. |
| `apps/desktop/src/main/services/ai/providerStatusDetails.ts` | The probe's shared numbers and its generic `detail` builders. Zero imports, so anything may depend on it. Per-provider detail copy lives with the resolver that emits it — Cursor's in `providerBinaryResolvers.ts`, OpenCode's in `providerAuthResolvers.ts`. |
| `packages/chat-ui/src/` | Embeddable React chat: Composer, Transcript, ModelPicker, activity labels, CSS-token theme. |
| `packages/chat-ui/src/adapters/sdkClient.ts` | `adaptSdkClient` — maps `@ade-dev/sdk` (or any SDK-shaped client) onto chat-ui props. |
| `packages/chat-ui/src/transcript/ApprovalCard.tsx` | The inline approval row: Allow once / Always allow / Reject, settled in place, read-only without `approve`. |
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
        ├─ resolve `ade`: binaryPath → @ade-dev/runtime-<target> → home cache → PATH → download
        │    (download only; SHA256SUMS, fail closed. allowDownload:false throws runtime_unavailable)
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

### Bundled runtime (platform packages)

An embedder shipping a signed, notarized app cannot download an executable at first run: the bundle is one signed artifact. So the same released bytes also publish to npm as five platform packages plus a meta package, the pattern esbuild and swc use.

| Package | Contents |
|---|---|
| `@ade-dev/runtime-<target>` | `bin/ade[.exe]` (mode 0755), `native/` = the extracted `<binary>.native.tar.gz`, `LICENSE`, `RUNTIME-EMBEDDING-EXCEPTION.md`, `README.md`. `os` + `cpu` set. |
| `@ade-dev/runtime` | Meta package; lists the five as `optionalDependencies` pinned to the same version, so npm installs exactly one. |

- `runtimeRoot` is `<pkg>/native` (`ADE_RUNTIME_ROOT`); `nodeModulesPath` is `<pkg>/native/node_modules` (`ADE_RUNTIME_NODE_MODULES`). The binary dlopens out of the latter, so both must travel together.
- `resolveBundledRuntime()` (`packages/sdk/src/bundledRuntime.ts`) resolves the package by `require.resolve("<name>/package.json")`. Missing package → `null`. Present but malformed → `AdeError("binary_not_found")` naming the missing path.
- `createAdeChat` accepts `binaryPath`, `runtimeNodeModules`, `runtimeRoot` and `allowDownload`. Both directories are validated at create, not at spawn.
- The pinned and bundled routes skip `SHA256SUMS` by design: bytes signed into the embedder's bundle are verified by the OS.
- `doctor().runtime` reports `source` (`explicit` | `bundled-package` | `cached-download` | `path` | `downloaded` | `attached`), the two runtime paths, `signature`, `downloadedThisSession` and `checksumVerified`. `doctor().binary` keeps its 0.1.x four-value `source`.
- Built by `apps/ade-cli/scripts/build-runtime-npm-packages.mjs` from a release's artifacts; published by `.github/workflows/publish-runtime-packages.yml` when that GitHub release is published. `/release` undrafts; the workflow then publishes. `workflow_dispatch` is recovery. Checksum-verified, skip-if-version-exists.
- Public guide: `sdk/bundling.mdx` — signing, entitlements, and an electron-builder fragment.

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
- `instructions` — `{ mode: "append" | "replace", text }`. A bare string from the caller normalizes to append before it reaches the wire.
- `requestedCwd` — absolute, validated client-side first (no relative path, no `~`, no root, not `os.homedir()`, not inside the SDK home).
- `settingSources` — `none` (default) | `project` | `user` | `all`.
- `permissionPolicy` — the policy form of `permissions`, sent alongside `permissionMode: "default"` so a runtime that ignores it degrades toward more prompting, never toward full-auto.
- Orchestrator-lead markers are refused on this surface. A projectless chat cannot be an orchestration lead.

Actions beyond the original nine: `approve` (answers one blocked request) and `pendingInputs` (read-only list, gated on the advertised action list — when it is absent the SDK derives the pending set from observed `approval_request` minus `pending_input_resolved` events and logs the hole once).

`providers.status` is a top-level machine RPC, not a `personalChats.call` action, advertised as `capabilities.providers.status`. The SDK merges its probe with the catalog derivation and stamps `source: "probed"`; with no RPC every record is `source: "derived"` with `installed: modelCount > 0` and null probe fields.

Durable threads: `threads.open("support", { provider, model })` creates or resumes by key stored under the home. Reopening the same key after a restart continues the conversation.

Every host-configuration arg above applies on CREATE ONLY. A resume rebuilds the thread the key was created with, reading `requestedCwd`, `instructions`, `settingSources`, `permissionPolicy`, `mcpServers` and `strictMcpConfig` off the stored record and ignoring what the call passed. Silence there was the dangerous part: an embedder that reopens with a tighter policy and a new cwd, and is told nothing, may believe an agent is confined to a directory and a rule set it is not confined to. So the SDK logs one line per differing option, naming the stored value it used instead (`threadResumeMismatchWarnings`). The rule itself is unchanged — to run under different configuration, open a different key.

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

## Instructions, cwd, settingSources

Three create args let a host shape the session itself. All three are optional, and
omitting all three reproduces 0.1.x behavior byte for byte. All three persist on the
session, so reopening a thread by key re-applies them without the host resending
anything — which matters, because a reopen sends no first message.

Source of truth for the two capability tables: `INSTRUCTIONS_SUPPORT` and
`SETTING_SOURCES_SUPPORT` in `apps/desktop/src/shared/hostSessionConfig.ts`.

### `instructions`

`{ mode: "append" | "replace", text }`, or a bare string meaning
`{ mode: "append", text }`. `append` keeps ADE's own personal-chat prompt and puts
the host text after it. `replace` sends the host text alone, which is what a chat
branded as the host's own assistant needs: ADE's text names ADE, and the model
eventually repeats it.

| Provider | Level | Channel |
|---|---|---|
| claude | applied | Agent SDK `systemPrompt` (string) |
| codex | applied | `developerInstructions` on `thread/start` |
| opencode | applied | the prompt's `system` field |
| pi | applied | `systemPromptOverride` |
| cursor | best-effort | merged into the system text ADE already prefixes into the first user prompt |
| droid | best-effort | merged into the harness prompt ADE already prefixes onto every turn |

Cursor and Droid are "best-effort" because neither SDK carries an instruction field,
so ADE joins the text to the prompt it already injects rather than inventing a new
hidden-message trick. The text is part of the prompt the model reads, not a pinned
system prompt.

The session summary carries `instructionsCapability`:

```
{ level, mode, mechanism, detail }
```

It is absent when the caller supplied no instructions. Absent means "never asked",
not "ignored" — the same rule `mcpCapability` follows.

### `requestedCwd`

An absolute directory the provider runs in. Default stays
`<ADE_HOME>/personal-chats/workspaces`, mode 0700. A host directory is created
recursively at mode 0755, because the point of naming one is a folder the user can
open in a file browser.

`personalChatScope.create` validates the path before any session row exists and
throws an `Error` whose message starts with `invalid_argument:`. It refuses a
relative path, anything starting with `~`, a filesystem root, a Windows drive root,
a bare UNC share root, the home directory itself, and anything inside ADE's own
state directory. The SDK checks the same rules client-side first, so a bad path
fails before any RPC.

The accepted path is then CANONICALIZED — `realpathSync.native` on the deepest
existing ancestor, with the missing tail rejoined, so an ordinary "create this
directory" case does not throw. The session stores and the summary echoes that
canonical form rather than the caller's string. This is a containment rule, not
a tidiness one: without it a symlink into ADE's own state directory, or a
Windows path differing only in case, would pass a check the real directory would
fail. `adeDir` and `homeDir` are canonicalized the same way, or a symlinked ADE
home would not match a canonical candidate genuinely inside it.

The SDK canonicalizes the same way, client-side, before it applies the refusals,
so a path is judged by the same rules on both sides of the wire. `hostConfig.ts`
keeps two entry points: `validateThreadCwd` canonicalizes and refuses, and
`canonicalThreadCwd` canonicalizes without refusing. The second is for the
resume comparison, which asks "is this the same directory?" rather than "may
this directory be used?" — without it, macOS temp paths differ between the
caller's spelling and the engine's, and a caller who passed the SAME string
twice was told their `cwd` had been ignored.

The directory replaces `laneWorktreePath` for personal sessions only. Every provider
adapter reads that field, so all six follow. A work chat's lane worktree is a git
invariant and is never moved.

The replacement happens in `resolvePersonalHostCwd`, and every caller must both use
it AND withhold `requestedCwd` from `resolveLaneLaunchContext`. That launch context
takes a cwd it expects to be inside the lane worktree and refuses anything outside
it, so a host directory passed through it is rejected as an escape — the bug the
live seam test caught. A refresh that resolves a different directory than the create
did also rebuilds the lane directive key every turn, which tears the runtime down
and starts it again, so the resolution lives in one helper rather than at each site.

### `settingSources`

`"none" | "project" | "user" | "all"`, defaulting to `"none"`.

| Provider | none | project | user | all |
|---|---|---|---|---|
| claude | applied | applied | applied | applied |
| codex | ignored | best-effort | ignored | best-effort |
| cursor | ignored | ignored | ignored | ignored |
| droid | ignored | ignored | ignored | ignored |
| opencode | ignored | ignored | ignored | ignored |
| pi | ignored | ignored | ignored | ignored |

On Claude the four values map to `[]`, `["project"]`, `["user"]`, and
`["user", "project", "local"]`. ADE sets the Agent SDK option explicitly in all four
cases, including the empty array, so the behavior belongs to ADE rather than to a
dependency default.

Codex always reads `AGENTS.md` from the thread's working directory and always loads
`~/.codex/AGENTS.md`, and the app-server exposes no switch for either. So `"project"`
and `"all"` describe what Codex already does rather than something ADE turns on, and
`"none"` and `"user"` cannot be honored at all. The remaining four ignore the value for
their own reasons, each recorded in the table's `mechanism`: Droid and Pi expose no
configuration-layer switch, OpenCode runs against an ADE-authored server config with
project config disabled, and Cursor's `settingSources` is pinned from the session
permission policy, because dropping the user layer would also drop ADE's own tool-gate
hook.

The session summary carries `settingSourcesCapability`:

```
{ level, value, mechanism, detail }
```

The level is per requested value, not per provider, for exactly the Codex reason
above. `detail` is null when the value was applied.

## Permission policy and approvals

`permissions` on `threads.open` takes three forms. The two presets, `"default"`
and `"always-allow"`, keep their 0.1.x behavior. The third form is a structured
policy object, and it is the only one that expresses a rule.

```
{
  allowedTools?: string[];          // exact names, or a trailing "*" prefix
  deniedTools?: string[];           // wins over allowedTools
  autoApproveMcpServers?: string[]; // every tool of these servers
  sandboxRoot?: string;             // absolute; commands and writes inside it
  fallback: "ask" | "deny";         // required
}
```

Precedence runs highest to lowest: `deniedTools`, then `allowedTools` and
`autoApproveMcpServers`, then `sandboxRoot` containment, then `fallback`.
`sandboxRoot` applies to file writes, and on Codex to commands, file changes,
and permission escalations. A tool call that names no path is decided by the
tool rules and the fallback — Claude's `Bash` names none, so a command is judged
by `allowedTools`/`deniedTools` and then by `fallback`, never by the directory
the session happens to run in. A relative path is judged against the working
directory of the request that carries it, and falls through when there is none.

A policy with no `sandboxRoot` contains nothing. On Codex that means no approval
is auto-accepted: every request Codex raises goes to `fallback`, so `"ask"`
raises an `approval_request` and `"deny"` declines.

On Codex the sandbox decides first, and the policy only answers what the sandbox
raises: under `sandbox: workspace-write` a command or file change inside the
thread's `cwd`, `$TMPDIR` or `/tmp` raises no approval request at all, so the
policy governs sandbox escapes only.

Tool names are provider-neutral. An MCP tool is `mcp:<server>:<tool>`, and
`mcp:<server>:*` names every tool of that server. Any other string matches the
provider's own tool name, case-insensitively. Built-in names are
provider-specific: `Bash` is a Claude name and matches nothing on Codex.

`fallback` is required. A policy with no fallback has no obvious default, and
defaulting to "ask" would park a turn for a host that renders no approval card.

Under `fallback: "ask"` there is one exemption from asking: Claude's own
read-only built-ins (`Read`, `Glob`, `Grep`, `ToolSearch`, `TaskList`,
`TaskGet`, `WebFetch`, `WebSearch`) run without a card. Otherwise a host that
wanted to be asked about writes would be asked about every file read, which
teaches a user to click Allow without reading it. The check is literal name
membership, never a substring, and it never covers a host MCP tool — an MCP
tool's risk is not knowable from its name, so `mcp__srv__read` asks like any
other. Under `fallback: "deny"` there is no exemption: nothing unmatched runs.

`deniedTools` outranks everything, including a tool that would otherwise let
itself through. Claude's `AskUserQuestion` and ADE's own `ask_user` normally
skip the approval card, because each carries its own answer UI and a generic
"Allow this tool?" card would only hide the real question behind an extra
click. Naming either in `deniedTools` still refuses it.

An `allowedTools` entry means the tool may run, not that it skips its own
machinery. Allow-listing `AskUserQuestion` lets it ask; it does not return
success without the user ever seeing the question.

### What `fallback: "deny"` does on Claude

Measured against Agent SDK 0.3.258: `allowedTools` and `disallowedTools` are
enforced, because the CLI removes a denied tool from the model's catalog. But
`canUseTool` did not fire on any permission mode tried, so the prompt path
cannot be relied on to enforce anything.

A deny fallback is therefore expressed entirely in what the session is given,
not in what it is asked:

- Every Claude mutating built-in the policy does not name is added to
  `disallowedTools`. The list is literal and fixed: `Bash`, `Write`, `Edit`,
  `MultiEdit`, `NotebookEdit`, `Agent`, `Task`, `KillShell`
  (`CLAUDE_MUTATING_BUILTIN_TOOLS`). Only an explicit `allowedTools` entry
  keeps one. Read-only built-ins stay available — a deny fallback stops the
  agent changing things, it does not blind it.
- MCP is scoped to the servers the policy names, through
  `allowManagedMcpServersOnly` with an allowlist built from
  `autoApproveMcpServers` and every `mcp:<server>:…` entry in `allowedTools`.
  A server the policy never names is unreachable, **including one the same
  caller supplied in `mcpServers`**. Name it in the policy to use it.
- `canUseTool` stays wired behind both, so a future SDK that does call back
  finds a gate that already denies.

Two clauses do not survive this, and both are reported rather than hidden.

`sandboxRoot` is a per-call decision about a path, and the per-call hook is the
one that does not fire, so under a deny fallback a mutating built-in is denied
outright rather than allowed inside the root. This does not lower the level —
refusing is stricter than the root, never looser — but the `residual` says it,
so nothing implies the root was applied. If you want containment on Claude
rather than refusal, use `fallback: "ask"` and answer the approvals.

An `allowedTools` entry that names ONE MCP tool admits its whole server. The
allowlist is per-server, so letting `mcp:srv:search` run makes `srv` reachable,
and the per-tool refusal would have to come from the hook that does not fire.
A policy in that shape reports `best-effort`, with a residual naming the
servers whose unnamed tools are not refused. Use `mcp:<server>:*` or
`autoApproveMcpServers` when you mean the whole server, and split the rest onto
a separate server if you need tool-level separation on Claude.

The `residual` also lists any server you supplied in `mcpServers` that the
policy does not name, since those are unreachable under a deny fallback.

Under `fallback: "ask"` none of the above applies: no tools are removed from
the catalog, MCP is not scoped, and the policy is applied by the gate.

The rules live in `apps/desktop/src/shared/permissionPolicy.ts`. Both the Claude
tool gate and the Codex approval handlers read that module, so an embedder and
the engine never disagree about what a rule means.

### What each provider does with it

| Provider | Level | Mechanism |
|---|---|---|
| claude, `fallback: "deny"` | enforced, or best-effort when an allow entry names one MCP tool | `allowedTools` / `disallowedTools`, which remove a denied tool from the model's catalog, plus `allowManagedMcpServersOnly` scoped to the servers the policy names. Residual: `sandboxRoot` is not applied; any blocked caller MCP servers are named |
| claude, `fallback: "ask"` | best-effort | the same two lists, plus a `canUseTool` gate. Residual: the ask verdict needs the Agent SDK permission prompt, which a user-level Claude setting can pre-empt |
| codex | best-effort | `approvalPolicy: on-request` with `sandbox: workspace-write`. The policy governs sandbox escapes only, and auto-accepts nothing without a `sandboxRoot` — see the precedence section above |
| cursor | unsupported | the Cursor SDK takes a mode preset, not a rule set |
| droid | unsupported | the Factory SDK takes an autonomy level, not a rule set |
| opencode | unsupported | OpenCode takes an agent profile, not a rule set |
| pi | unsupported | the Pi SDK takes a tool policy ADE derives from the session mode |

Codex does not raise an approval for a plain MCP tool call. Its three approval
methods cover shell commands, patches, and permission escalations. So
`allowedTools`, `deniedTools`, and `autoApproveMcpServers` do not gate MCP tools
on Codex, and the session reports that in `permissionCapability.residual`.

Source of truth: `PERMISSION_POLICY_SUPPORT` in
`apps/desktop/src/shared/hostSessionConfig.ts`. The session summary carries
`permissionCapability`:

```
{ level, mechanism, residual }
```

### Answering an approval

When the policy says "ask", the engine emits an `approval_request` event and the
turn stops until someone answers it. **An unanswered approval blocks the turn
indefinitely.** There is no timeout, by design: proceeding after sixty seconds is
a security decision no default should make, and refusing after sixty seconds
breaks a long human review. A host must render a card for every
`approval_request` it receives, or the thread appears frozen.

Two ways out. Answer it with the `approve` action
(`{ sessionId, itemId, decision, responseText? }`, decision one of `accept`,
`accept_for_session`, `decline`, `cancel`), or call `interrupt()`, which aborts
the turn without answering. `accept_for_session` records the tool in the
session's approval overrides, so the same tool does not ask again.

`fallback: "deny"` is the option for a host that renders no card at all. Nothing
ever prompts. On Claude the call returns a denial to the model. On Codex the
request is answered immediately with a decline, and the transcript still records
both the `approval_request` and a `pending_input_resolved` with
`resolution: "declined"` — a refusal the transcript never mentions reads to the
user as the agent silently choosing not to act.

A host that reloads its UI loses the events it already received. The
`pendingInputs` action (`{ sessionId }` → `{ requests: PendingInputRequest[] }`)
returns everything still awaiting an answer, so the cards can be redrawn. It is
read-only, viewer-allowed, and reads resident runtime state only — it is empty
after a runtime restart, because the provider process that raised each request
died with it.

Answering an item that is already settled is not an error on the wire: the
engine logs `*_approval_not_found` and settles silently. The SDK checks
`pendingInputs` first and raises `approval_not_found` instead.

## Provider status

`providers.status` is a machine-scope RPC. It answers "which coding CLIs does
this machine have, where, which version, and are they signed in" from the
runtime's own resolvers — the same ones that decide which executable a chat
spawns. Before it existed, an embedder's setup screen could only derive that
answer from the model catalog, where "not installed", "signed out", and "the
first catalog poll has not finished" all look identical.

Params: `{ refresh?: boolean }`. Result:

```ts
{
  checkedAt: string;                 // ISO, when this report was assembled
  providers: Record<string, {
    provider: string;                // "claude" | "codex" | "cursor" | "droid" | "opencode" | "pi"
    displayName: string;
    installed: boolean;              // a usable binary or package was found
    binaryPath: string | null;       // what the runtime would spawn or load
    version: string | null;          // verbatim first line of `--version`
    authenticated: boolean;
    authMethod: "subscription" | "api-key" | "oauth" | "unknown" | null;
    installCommand: string | null;
    loginCommand: string | null;
    docsUrl: string | null;
    source: "probed";
    stale: boolean;                  // served from cache rather than probed by this call
    checkedAt: string;
    detail: string | null;
  }>;
}
```

Feature-detect it on `ade/initialize`:
`capabilities.providers = { status: true, cacheTtlMs: 60000 }`. An older
runtime omits the key, which is the SDK's cue to keep deriving status from the
model catalog and to report `source: "derived"`.

### What "probed" means

- `installed` and `binaryPath` come from the provider's own resolver
  (`resolveClaudeCodeExecutable`, `resolveCodexExecutable`,
  `resolveDroidExecutable`, `resolveOpenCodeBinaryPath`, `resolvePiInstallation`,
  and for Cursor the `@cursor/sdk` package plus the `cursor-agent` CLI).
- A resolver that produced only a bare command name is **not** an install. The
  probe confirms it with a PATH lookup (PATHEXT-aware on win32) or reports
  `installed: false`.
- `version` is the first line of `--version`, capped at 5 s. A non-zero exit or
  a timeout yields `null`, never a hung call. A `.cmd` or `.bat` shim runs
  through `cmd.exe`, and every spawn passes `windowsHide: true`.

### How `authenticated` is decided

Claude and Codex use a ladder, cheapest rung first, and stop at the first rung
that knows. The ladder exists because the credentials file alone is not enough:
on macOS the live token sits in the Keychain, which this path will not read, so
a file-only answer reports "signed out" on a machine where the CLI works every
day.

Claude:

1. `readClaudeCredentials({ allowKeychain: false })` — a hit means
   `authMethod: "subscription"`.
2. `ANTHROPIC_API_KEY` — `authMethod: "api-key"`.
3. `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`) carrying a non-empty
   `oauthAccount` object — `authMethod: "subscription"`. A plain file read that
   proves a browser sign-in happened, with no dialog and no process.
4. The auth detector's cached verdict, when its cache is warm.
5. Only when the CLI is installed and nothing above knows: one
   `claude auth status --json`, capped at 5 s, parsed by the same
   `parseJsonAuthStatus` the auth detector uses.

Codex is the same shape: `~/.codex/auth.json` → `OPENAI_API_KEY` → the cached
verdict → one `codex login status`.

The last rung costs at most one process per provider per cache lifetime, and
only for an installed CLI. A timeout there reports `authenticated: false` with
`detail: "login state could not be verified"` rather than a confident
"signed out".

Cursor, Droid, OpenCode, and Pi read credentials only from disk and the
environment; they never spawn.

### What is NOT probed

- No macOS Keychain read. A Keychain read can put an unlock dialog in front of
  the user, so the probe passes `allowKeychain: false`.
- No network call, and no model catalog fetch.
- No auth spawn for a provider that is not installed, and none on any rung
  above the last.
- Cursor's `binaryPath` may be a package directory rather than a binary; the
  `detail` line says so. OpenCode reports `authenticated: false` with a detail,
  because its credentials live inside its own server.

### Caching

Each provider's record is cached for **60 s** (`PROVIDER_STATUS_CACHE_TTL_MS`).
`stale` means "served from the cache rather than probed on this call", so a
record served from inside the TTL carries `stale: true` too — it is not a claim
that the record is expired. `refresh: true` bypasses
the cache, which is what an embedder's "I just installed it" button calls;
`providers.onChange` polling must not use it. Concurrent callers share one
in-flight probe, so mounting several provider cards does not multiply spawns.
The whole report is capped at 8 s: a provider that overruns falls back to its
last record or to an empty one, and never removes the other five from the
report.

Install and login strings come from one shared table,
`apps/desktop/src/shared/providerRemediation.ts`, which ADE's own Settings
cards, model-picker empty states and CLI agent registry read from too. So an
embedder rendering `installCommand` shows the same string ADE shows, and a
vendor command that changes is corrected in one place for all four.

Embedders should render those rather than hardcoding a vendor command. Two of
them are not the obvious guess and would be wrong if invented: Droid has no
non-interactive login subcommand, so its `loginCommand` is the bare `droid`,
and Pi signs in through the interactive CLI's own `/login`, so its
`loginCommand` is the bare `pi`. On win32 the table returns the vendor's
PowerShell installer for Claude, Cursor and Droid rather than the POSIX line.

Source: `apps/desktop/src/main/services/ai/providerStatusProbe.ts`; dispatch in
`apps/ade-cli/src/multiProjectRpcServer.ts`.

## Electron bridge

`@ade-dev/sdk` runs in the main process: it owns a child process and a socket,
and a sandboxed renderer has neither. Every embedder was therefore writing the
same bridge by hand, and getting the same two things wrong — listeners that
survive a reload, and a `history()` that races the live stream.

Three subpath exports, one per process, three tsup entries and three `exports`
keys in `packages/sdk/package.json`:

| Export | Function |
|---|---|
| `@ade-dev/sdk/electron` | `registerAdeIpc(ipcMain, client, opts?)` → dispose function |
| `@ade-dev/sdk/electron/preload` | `exposeAdeBridge(contextBridge, ipcRenderer, opts?)` |
| `@ade-dev/sdk/electron/renderer` | `createAdeIpcClient(bridge)` → an `SdkLikeChatClient`-shaped client |

- **No dependency on `electron`, runtime or dev.** The three functions take
  minimal structural interfaces (`IpcMainLike`, `WebContentsLike`,
  `IpcRendererLike`, `ContextBridgeLike`), so the package still installs in a
  plain Node host and the tests use fakes rather than a real Electron.
- The preload bundle is a single file with zero imports and no `node:`
  specifiers, because `sandbox: true` gives a preload no module loader.
- Channels are `<prefix>:invoke` (one `ipcMain.handle` taking `{ method, args }`)
  and `<prefix>:event`, pushed only to the `webContents` that subscribed.
- Main keeps a registry per `webContents.id`. On `destroyed` and on a navigation
  that ends the renderer world it disposes every subscription and forgets the
  threads. The SDK's own `liveSessions` keeps the thread; the bridge only drops
  listeners.
- Errors serialize as `{ name: "AdeError", code, message }` and rehydrate to a
  real `AdeError` in the renderer, so `error.code` survives the boundary.
- Ordering: the renderer client subscribes BEFORE calling `history()`, buffers
  live envelopes, and merges on `sessionId:sequence:timestamp:type` — the same
  dedupe key chat-ui uses. Each envelope is delivered exactly once, in envelope
  order. Unknown event types pass through untouched.
- `authorize(event, method, args)` and `allowThreadKey(key)` are host gates. A
  refusal throws `AdeError("unauthorized")` and the SDK is never called.
- Attachments cross as `{ path }` refs only. A renderer needs a real path from a
  main-side dialog; bytes do not travel.

Public guide: `sdk/electron.mdx`. Reference app: `packages/sdk/examples/electron/`
(`sandbox: true`, `contextIsolation: true`, strict CSP meta, its own
`package.json` with the `electron` devDependency). CI does not install it.

## chat-ui contract

- CSS custom properties only (`createTheme({ accent, background })`). No Tailwind, no class overrides.
- Tool activity is renamed through an activity-label map + optional `resolve()` callback (wildcards, phase verbs, elapsed, icons).
- Transcript collapses streamed text and upgrades `tool_call` chips in place when `tool_result` lands on the same item id. `approval_request` → `pending_input_resolved` uses the same upgrade-in-place rule.
- `adaptSdkClient(client)` accepts `@ade-dev/sdk` or any SDK-shaped proxy (DataDesk's renderer talks over a WebSocket and still fits).
- Approvals render inline, never as a modal, and settle in place rather than vanishing. `thread.approve` and `thread.pendingApprovals` are OPTIONAL on the view contract: a client without `approve` gets a read-only card, never a throw.
- `ProviderCard` reads `ProviderStatus.source` before claiming anything about the machine: `"probed"` may say "Not installed", `"derived"` says "Not detected".
- `commandHints` is an override of the runtime's own install/login strings, not the source of them.

## Windows

Parity is required. The SDK never shells out to `taskkill` / `tar` from PATH; it resolves them through the kernel `GLOBALROOT` System32 alias. Named pipes are hashed from home + user identity and compared case-insensitively. `.cmd` / `.bat` wrappers go through `ComSpec`. File-lock retries cover `EBUSY` / `EPERM` / `EACCES`. `PATHEXT` is applied when discovering `ade` on PATH.

Native `windows-latest` CI still has to repeat the Windows-sensitive files; parameterized `win32` contract tests are the local proof.

## Gotchas

- Never point a sidecar `home` at the developer's `~/.ade` or the default machine socket.
- Never treat `mcpCapability` truthiness as "strict was enforced".
- Never treat any capability report's presence as a guarantee. Read `level` —
  and for MCP, read `strictRequested` first. A null report means "never asked"
  OR "asked, and an older runtime said nothing", and the second is not a pass.
- Never read `ProviderStatus.installed` without reading `source`. On a
  `"derived"` record it means "ADE knows models for this provider", which is a
  different question from "a binary is on this disk".
- Never read `doctor().runtime.signature === null` as "not signed". It is "not
  known": Linux, attach mode, and any probe that could not run all report null.
- Never add a `canUseTool` to the Claude personal path without a policy. A
  personal chat that suddenly starts emitting `approval_request` parks turns for
  every 0.1.x embedder that renders no card.
- Never infer a tool's risk from its name. That substring heuristic is the bug
  `permissionPolicy.ts` exists to replace, and the read-only exemption in the
  Claude gate is a literal name-set membership test for the same reason.
- Never rely on `canUseTool` to enforce a Claude policy. It did not fire on any
  permission mode measured against Agent SDK 0.3.258. Enforcement that matters
  goes in `allowedTools` / `disallowedTools` and `allowManagedMcpServersOnly`,
  which the CLI applies itself; the gate stays wired as a second line only.
- Never assign over `opts.managedSettings.allowedMcpServers`. ADE's own managed
  servers are already in that object on the paths that build one, and replacing
  it takes the orchestration or CTO tools away with no diagnostic. Merge.
- Never re-derive a capability report at a second site. The persisted-state
  loader already re-derives all three from the stored args plus the live
  provider before it returns, so a record written before a table row changed
  cannot keep reporting the old verdict. Deriving again at the session-rehydrate
  site would be two copies of one rule, which is how the rule starts disagreeing
  with itself.
- Never resolve a personal host cwd at more than one site. A refresh that
  disagrees with the create rebuilds the lane directive key every turn and
  restarts the provider runtime.
- Never add typed `--mcp-servers` / `--strict-mcp` CLI flags as a second spelling of `--arg-json`; the nested JSON is what that hatch already carries. The SDK is the intended embedder API.
- `packages/sdk/dist` is gitignored. Anything that typechecks against `@ade-dev/sdk` from source must build it first.
- `packages/demo` live e2e spends provider tokens. Do not add it to root `npm test`.

## Related docs

- Public Mintlify: [ADE SDK](https://www.ade-app.dev/docs/sdk/overview) — twelve pages under `sdk/*.mdx`, nav in `docs.json`. Keep them in lockstep with this page when the contract changes; `node scripts/validate-docs.mjs` fails on a page missing from the nav.
  - `overview`, `install`, `quickstart` — what it is and the first client.
  - `threads`, `mcp`, `permissions` — the per-thread contract and the three honesty tables.
  - `chat-ui`, `electron` — the two host-side surfaces.
  - `runtime`, `bundling` — the sidecar and shipping it inside a signed app.
  - `reference`, `license` — the full shapes, and what each artifact is licensed under.
- [Chat](../chat/README.md#caller-injected-mcp) — engine-side injection, tristate, capability report.
- [Personal chats](../personal-chats/README.md) — the machine RPC the sidecar actually calls.
- [ARCHITECTURE.md](../../ARCHITECTURE.md) §2.1 — embedded runtime profile and parent-death watchdog.
- [ADE CLI README](../../../apps/ade-cli/README.md) — `ade runtime run --profile embedded`.

## License

`@ade-dev/sdk` and `@ade-dev/chat-ui` are MIT. The runtime binary and ADE itself are AGPL-3.0-only, with the ADE Runtime Embedding Exception on the runtime binary (#1211).

- Public page: [`sdk/license.mdx`](../../../sdk/license.mdx) states the per-artifact table and answers whether a proprietary app may ship the runtime. It is the one place a decision gets recorded, so update it first.
- Exception: [`RUNTIME-EMBEDDING-EXCEPTION.md`](../../../RUNTIME-EMBEDDING-EXCEPTION.md) at the repository root. It permits an unmodified runtime binary inside a larger work that consumes it through the documented `@ade-dev/sdk` interface. Modifying the runtime, or linking ADE source, keeps the AGPL in force.
- Check: `scripts/check-package-licenses.mjs` asserts, for every non-private `packages/*`, that the SPDX field, the package `LICENSE` file, the tarball file list, and the README `## License` section all agree. The `test-sdk` CI job runs it with `--pack`; `scripts/check-package-licenses.test.mjs` unit-tests it.
- Runtime packages: `apps/ade-cli/scripts/build-runtime-npm-packages.mjs` copies both the root `LICENSE` and `RUNTIME-EMBEDDING-EXCEPTION.md` into each of the six `@ade-dev/runtime-*` packages, and its pack assertion fails a tarball missing either. That script's packages live in `runtime-packages/`, which the check script never walks.

A relicense is four coordinated edits per package plus the docs page. The check script exists so none of the five can be forgotten.

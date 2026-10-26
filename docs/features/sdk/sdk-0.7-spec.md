# ADE SDK 0.7 — spec

Status: in progress (branch `ade/ade-sdk-improvement-ideas`).

## Principle

The SDK owns **everything about the agent and the credentials it runs on**.
The host app owns everything else. Nothing unique to ADE (lanes, worktrees,
PRs, sync, proof, machines) appears in the SDK surface. An adopter needs no
ADE install and no ADE account.

Three pillars:

1. **Parity.** Every provider, permission mode, thinking level and turn
   control ADE itself supports, read from the runtime rather than
   hand-listed in the SDK.
2. **Accounts and credentials.** End users bring their own logins and keys:
   several accounts per provider (Claude, Codex), a headless sign-in the host
   renders, stored API keys, custom endpoints (presets), per-thread account
   pinning and switching, usage-limit failover.
3. **Developer experience and size.** A minimal install, a server bridge for
   non-Electron hosts, a testing kit, one-shot structured runs, generated wire
   types, usage and budget caps.

Version skew rule (unchanged): the runtime may be newer or older than the SDK.
Every new wire surface is advertised in `runtime/info` capabilities and the SDK
feature-detects it; an absent capability is `AdeError("unsupported")` with a
clear message, never a silent no-op.

---

## 1. Runtime wire (apps/ade-cli + apps/desktop shared/main)

### 1.1 New machine RPC methods

Served in `apps/ade-cli/src/multiProjectRpcServer.ts` next to
`personalChats.call`, added to `RUNTIME_METHODS`.

| Method | Actions | Backed by |
|---|---|---|
| `providerAccounts.call {action,args}` | `list`, `create`, `remove`, `signOut`, `rename`, `setDefault`, `refresh`, `loginStart`, `loginStatus`, `loginSubmitCode`, `loginCancel` | the same store + machine login runner as the `provider_instances` action domain (`buildProviderInstancesDomainService`) — one implementation, two doors |
| `credentials.call {action,args}` | `list`, `store`, `remove`, `verify` | the multi-key credential store (`listApiCredentials`, `storeApiCredential`, `removeApiCredential`, `verifyApiKeyConnection`). Summaries only: a key value never leaves the runtime. |
| `presets.call {action,args}` | `list`, `create`, `update`, `remove` | harness presets (custom endpoint + key + model). If presets cannot live in an embedded home, ship `list` only and document why. |

**Who may call.** In ADE these writes are the owner's (CTO-only, "only you"
settings). An embedded runtime has exactly one client — the host that spawned
it on a private per-home socket — and that host *is* the owner. So:

- `runtimeProfile === "embedded"` → allowed for the host's connection.
- any other profile → CTO role only; an agent gets the same refusal the
  `provider_instances` domain gives today. ADE's own rule must not loosen.

**Capabilities** (in `runtime/info`):
`capabilities.providerAccounts: { actions: string[] }`,
`capabilities.credentials: { actions: string[] }`,
`capabilities.presets: { actions: string[] }`,
`capabilities.providers.capabilities: true`,
`capabilities.personalChats.actions` must already list `switchAccount` when it
is served.

### 1.2 Personal chat additions

- New personal action `switchAccount { sessionId, instanceId }` → the existing
  `agentChatService` account switch (`busy` / `signed_out` / `failed` results
  preserved). Added to `PERSONAL_CHAT_ACTIONS`.
- `create` already forwards `instanceId`, `credentialId`, `presetId`,
  `reasoningEffort`, `fastMode`, `permissionMode` through `...forwarded`.
  Verify each one actually lands for a personal/embedded session and is
  validated (unknown instance → refused, not silently defaulted).
- Every personal action the SDK will call (`respondToInput`, the steer queue
  family, `stopTask`, `recoverTurn`, `resolveUnprocessedMessage`,
  `slashCommands`, `resumeUsageLimitNow`, `continueUsageLimitOnAlternate`)
  must work under `--profile embedded`. Fix any that do not.

### 1.3 Provider capabilities

`providers.status` records gain `capabilities` (gated by
`capabilities.providers.capabilities`), derived from the tables ADE already
has — never a new hand list:

```ts
type ProviderCapabilities = {
  permissionModes: AgentChatPermissionMode[];   // what this harness honours
  reasoningEfforts: string[];                   // union over its models; per-model detail stays on catalog rows
  fastMode: boolean;
  multipleAccounts: boolean;                    // claude, codex today
  signIn: "cli-login" | "device-code" | "api-key" | "none";
  apiKeys: boolean;                             // can run on a stored key
  presets: boolean;                             // can run on a custom endpoint preset
  mcp: "full" | "partial" | "none";             // from CALLER_MCP_SUPPORT
};
```

### 1.4 Login isolation

An embedded runtime started with `ADE_EMBEDDED_PROVIDER_LOGINS=isolated`
resolves every provider's default config home inside its own `ADE_HOME`
(`<home>/provider-homes/<provider>/default`) instead of the user's machine
login, for each provider that has a config-home override
(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `FACTORY_HOME_OVERRIDE`, …). The value
must win over a login-shell env that sets the same variable. Providers with no
override report `isolation: "shared"` in their status record so the host can
tell the user. `=machine` (or unset, for older SDKs) keeps today's behaviour.

---

## 2. SDK (`packages/sdk`)

### 2.1 Parity

- Providers: no hard-coded gate. Any provider the runtime catalog lists is
  accepted. `SUPPORTED_PROVIDERS` stays as a known-list export for autocomplete
  (now including the ACP providers) but is no longer a validator.
- `threads.open` options: `permissionMode` (all six ADE modes), `reasoningEffort`,
  `fastMode`, `account` (instance id), `credential` (credential id), `preset`
  (preset id). Existing `permissions` presets/policy keep working.
  Validated against `providers.capabilities` when the runtime reports it.
- `AdeThread` additions:
  - `respond(requestId, response)` where `response` is exactly
    `{ answers?: Record<string, string | string[]>; decision?:
    "accept" | "accept_for_session" | "decline" | "cancel";
    responseText?: string | null }` — forwarded to `respondToInput` as
    `{ sessionId, itemId: requestId, ...response }`. Question answers use
    question ids. Plan approval is an explicit `"accept"` or `"decline"`,
    never inferred from option labels. `pendingApprovals()` returns supported
    requests as actionable, not read-only, when the runtime serves the action.
  - `queue` — `list()`, `cancel(id)`, `edit(id, text)`, `move(id, index)`,
    `dispatch(id)`, `cancelDispatched(id)`, `restore()`;
    `interrupt({ queue: "keep" | "drop" | ... })` via `interruptWithQueueMode`.
  - `stopTask(taskId)`, `slashCommands()`, `recover()`,
    `resolveUnprocessed(...)`.
  - `usageLimit.resumeNow()`, `usageLimit.continueOnAlternate()`,
    `switchAccount(instanceId)`.

### 2.2 Accounts, credentials, presets

```ts
client.accounts.list(provider?)        // AccountInfo: id, provider, label, email, plan, signedIn, isDefault, usage room
client.accounts.add(provider, { label })
client.accounts.remove(id) / rename(id, label) / setDefault(id) / signOut(id) / refresh()
client.accounts.signIn(id, { deviceAuth? }) // → SignInHandle
//   handle.on("update", s => s.url / s.deviceCode / s.needsCode / s.state)
//   handle.submitCode(code); handle.cancel(); await handle.done  // → AccountInfo
client.credentials.list(provider?) / add({ provider, key, label }) / remove(id) / verify(provider)
client.presets.list() / add(...) / update(...) / remove(id)
client.providers.capabilities(provider)
client.on("usageLimit", ...)
createAdeChat({ useMachineLogin?: boolean /* default false */, resolveSecret?, onUsageLimit?: "failover" | "wait" | "ask" })
```

- `useMachineLogin: false` (default) spawns the runtime with
  `ADE_EMBEDDED_PROVIDER_LOGINS=isolated`. **Breaking** vs 0.6: an app that
  relied on the user's machine Claude/Codex login must pass
  `useMachineLogin: true` or sign the user in. `doctor()` reports
  `logins: { mode, perProvider: { claude: "isolated" | "shared" } }`.
- `resolveSecret(provider, credentialId)` — optional host vault. When set, the
  SDK does not store the key in the runtime; it pushes it per thread at
  open/resume the way `mcpHeaders` does, and never persists it.
- `onUsageLimit: "failover"` calls `continueUsageLimitOnAlternate` when another
  signed-in account exists, else waits; `"ask"` emits the event only.
- Electron bridge: accounts/credentials/presets are **off** for renderers
  unless the host passes `allowAccountManagement` (sync or async gate). Key
  values may be submitted from a renderer only through `credentials.add`; they
  are never echoed back.

### 2.3 DX

- `@ade-dev/sdk/server` — the demo's WebSocket bridge turned into a package
  subpath: `createAdeServer({ client, authorize })` speaking a documented
  JSON protocol, plus `createAdeRemoteClient(url)` that satisfies the same
  `SdkLikeChatClient` contract chat-ui uses.
- `@ade-dev/sdk/testing` — `createMockAdeChat()` / transcript replay so hosts
  test without a runtime or tokens.
- `client.run(prompt, { provider, model, schema? })` — one-shot ephemeral
  thread; with a JSON Schema, returns the parsed, validated object (re-asks
  once on invalid output, then throws `invalid_output`).
- Generated wire types: a script that regenerates `packages/sdk/src/types.ts`
  wire subset from `apps/desktop/src/shared/types/*` and a CI check that fails
  on drift.
- Usage: `thread.usage()` totals (tokens, cost when reported) and
  `threads.open(..., { budget: { maxCostUsd?, maxTokens? } })` — the SDK
  interrupts and emits `budget_exceeded` when crossed.

### 2.4 Size

See §4.

---

## 3. chat-ui (`packages/chat-ui`)

- Question / structured-question / plan-approval cards that answer through
  `thread.respond` (read-only when the client lacks it).
- Queue strip: queued sends with edit / cancel / reorder.
- Usage-limit notice with "Resume now" / "Continue on <account>".
- Slash-command autocomplete in the Composer.
- Accounts kit: `<AccountList>`, `<SignInCard>` (link, device code, paste-code),
  `<ApiKeyForm>`, `<UsageMeter>`, `<AccountSwitcher>`. All optional, all
  CSS-token themed, no ADE concepts in props.

---

## 4. Size

Measured baseline (npm, 1.2.123 / 0.6.0): `@ade-dev/runtime-darwin-arm64`
251.8 MB unpacked; `@ade-dev/sdk` 2.7 MB; `@ade-dev/chat-ui` 1.3 MB.
Breakdown (unpacked MB): darwin-arm64 = bin 134.8 + native/node_modules 109.5
+ other native 7.4; win32-x64 = bin 109.1 + node_modules 353.7 + 7.6. The bin
is a Node SEA (22 MB JS blob); the embedded profile gates behaviour but ships
the full dependency graph.

Plan, in order of savings:

1. Stop shipping Windows `@opencode/cli/bin/opencode.exe` (212.9 MB): ADE
   already fetches a pinned OpenCode into its tools cache.
2. Windows `node-pty` PDBs and wrong-arch binaries (29.8 MB).
3. Strip declarations, docs, examples and tests from copied packages
   (up to ~37 MB, overlapping later steps). Licenses stay.
4. Drop the copied `@factory/droid-sdk` if tsup already bundles it (17.4 MB).
5. Embedded-only npm packages exclude the TUI bundle and UI packages,
   `@linear/sdk` and cr-sqlite (~33.5 MB). The CLI installer keeps them.
6. `@ade-dev/sdk` / `@ade-dev/chat-ui`: stop publishing sourcemaps
   (66% / 62% of each package).

Deferred: Cursor as an on-demand pack (36 MB) — a product trade (offline
first use), not taken without a decision.

SDK DX build measurement (Node 22, `npm pack --dry-run --json`): 1.095 MB
unpacked / 290 kB packed with the new `server` and `testing` entries. A
source-map-enabled measurement of this track was 3.38 MB / 889 kB, so published
source maps are disabled to keep the package smaller. The runtime package and
chat-ui are unchanged by this track.

---

## Release

SDK and chat-ui go to 0.7.0; `SUPPORTED_RUNTIME_RANGE` lower bound moves to the
runtime version that ships §1. Older runtimes keep working for everything
except the feature-detected additions.

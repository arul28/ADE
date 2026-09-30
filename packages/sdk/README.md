# @ade-dev/sdk

Typed Node / Electron-main client that spawns a slim ADE runtime as a sidecar
and exposes chat as durable named threads.

**Docs:** [ADE SDK](https://www.ade-app.dev/docs/sdk/overview) — install, threads, MCP honesty table, chat UI, runtime, and API reference.

| Page | What it covers |
|---|---|
| [Threads](https://www.ade-app.dev/docs/sdk/threads) | Lifecycle, attachments, paged history, instructions, working directory, configuration layers, model switching |
| [MCP servers](https://www.ade-app.dev/docs/sdk/mcp) | Injected tools, credentials that change, resource links, and the strict-mode honesty table |
| [Permissions](https://www.ade-app.dev/docs/sdk/permissions) | The policy object, per-provider enforcement, answering approvals |
| [Chat UI](https://www.ade-app.dev/docs/sdk/chat-ui) | `@ade-dev/chat-ui`, theming, approval cards, provider cards |
| [Electron](https://www.ade-app.dev/docs/sdk/electron) | The main / preload / renderer bridge under `sandbox: true` |
| [Bundling](https://www.ade-app.dev/docs/sdk/bundling) | Platform packages, `codesign`, entitlements, electron-builder |
| [Runtime](https://www.ade-app.dev/docs/sdk/runtime) | The sidecar, exit events and `autoRestart`, version compatibility, and `doctor().runtime` provenance |
| [Reference](https://www.ade-app.dev/docs/sdk/reference) | Every option, shape, and error code |
| [License](https://www.ade-app.dev/docs/sdk/license) | What each artifact is licensed under |

```bash
npm install @ade-dev/sdk
```

Requires Node 22. The sidecar is a guest: isolated `home`, sync off, no
machine-brain authority. It dies with your process.

SDK 0.5.0 supports runtime `>=1.2.82 <2.0.0` (`SUPPORTED_RUNTIME_RANGE`). The
lower bound did not move in 0.5.0 — nothing in that release needs a new wire,
so a host on runtime 1.2.82 keeps working. An older or newer runtime still
connects, logs one warning, and degrades feature by feature. Pass
`requireCompatibleRuntime: true` to refuse it with
`runtime_incompatible`. `doctor().runtime.compatibility` reports the verdict.

## Quickstart

```ts
import { createAdeChat } from "@ade-dev/sdk";

const ade = await createAdeChat({ home: "./.ade-embed" });
const thread = await ade.threads.open("support", {
  provider: "claude",
  model: "claude-sonnet-4-5",
});
thread.on("event", (envelope) => console.log(envelope.event.type));
await thread.send("Summarise today's incidents");
```

Reopening `"support"` after a restart resumes the same conversation. Call
`ade.dispose()` when the host shuts down.

## Provider auth

The sidecar reuses the provider CLIs and logins already on the machine
(`claude`, `codex`, `cursor`, …). ADE state under `home` is isolated; Claude /
Codex / Cursor credentials still live in those tools' own config homes
(`~/.claude`, `~/.codex`, `~/.cursor`). If the host user can already run that
provider in a terminal, the sidecar can too.

`ade.providers.status()` reports, per provider, whether a binary was found, at
which path and version, and whether credentials are present. Read `source`
first: `"probed"` means the runtime looked at the filesystem, `"derived"` means
it is an older runtime inferring from the model catalog. `ade.providers.refresh()`
bypasses the runtime's 60-second probe cache.

`ade.doctor()` is the structured health check: binary path and provenance,
socket, event transport, providers, and known threads.

```ts
const report = await ade.doctor();
if (!report.ok) console.error(report);
```

Pin a specific ADE build with `binaryPath`, or let the client download a
release. Downloads are fail-closed against that release's `SHA256SUMS`.

## Threads

```ts
const thread = await ade.threads.open("support", {
  provider: "claude",
  model: "claude-sonnet-4-5",
  permissions: "always-allow",
});

await thread.send("What changed?");
await thread.steer("Focus on the outage");   // mid-turn follow-up
await thread.steer("", { attachments: [{ path: "/abs/path/log.txt" }] });
await thread.interrupt();
await thread.setModel("claude-opus-4");      // see setModel below
await thread.update({ title: "Outage review" });

const page = await thread.historyPage({ limit: 200 });   // newest page
const rows = await ade.threads.list();                   // title, archived, updatedAt, modelSelection
await ade.threads.archive("support");                    // or unarchive / delete
```

`threads.open(key)` is open-or-resume by key stored under `home`. Keys survive
host restarts. `exportThread(key)` returns the transcript as one JSON envelope
per line. `thread.title` and `thread.model` (with `displayName`) are on the
handle.

`threads.delete(key)` removes the runtime session, the transcript and the key.
`archive` keeps both. Each interrupts a running turn first.

`thread.update({ title, reasoningEffort, fastMode }, { force })` renames at any
time. The other two fields are refused mid-turn unless `{ force: true }`.

Attachments are `{ path, name?, mimeType?, type?, hydrate? }` refs. `type`
(`"file"` or `"image"`) is inferred from the MIME type or extension when
absent, so an image reaches the model as an image. `hydrate: false` sends the
path only and the runtime never reads the bytes. An absolute path must be
inside the chat's `cwd`, `<home>/personal-chats/state`, or a directory in the
thread's `attachmentRoots` (0.4, runtime 1.2.82). See
[Attachments](https://www.ade-app.dev/docs/sdk/threads#attachments) for the
size limits.

One refused `attachmentRoots` entry fails the whole open, and a host normally
sends the same roots every time. Test a candidate with `checkAttachmentRoot`,
or prepare the whole list with `filterAttachmentRoots`, which drops a bad entry
and reports why (both 0.5). A list identical to the one already in use is not
sent again, so a repeated list costs no update call.

`thread.retry()` and `thread.editLast(text)` (0.4, runtime 1.2.82) roll the
provider back and run the last user message again, and the transcript shows it
once. Claude and Codex only; another provider throws `unsupported`, and a
running turn throws `turn_in_flight`. The rollback covers the conversation, not
the disk: files the old turn wrote stay, and the result does not report them.
If you allow writes, inspect the events at or after `retractedFromSequence` in
your own history copy and warn the user.

`models.defaultModel({ prefer })` (0.5) takes your own ranking inside one
provider's models. Return a number above zero to prefer a model — the highest
score wins — so a host that wants the newest Sonnet, not the provider's
default, states it here instead of keeping its own copy of the rule. A model
nobody scores falls back to `isDefault`, then to catalog order.

Host configuration applies on **create only**. A resume re-applies what the key
was created with and ignores the `cwd`, `instructions`, `settingSources`,
`permissions`, `mcpServers` and `loadUserMcpServers` passed to that call,
logging one line per option it ignored. Open a different key to run under
different configuration — do not assume a tighter policy took effect because you
passed one. The one exception is `refresh.mcpServers` (see below).

When the runtime lost a key's session, the SDK **recreates** it from the stored
record. The record wins for `provider`, `model`, `cwd`, `instructions`,
`settingSources`, `permissions`, `mcpServers` and `loadUserMcpServers`; the
call's options only fill a field the record lacks. Before 0.3 the call's
options won. A recreate changes `thread.id`, so key your state on `key`.

`setModel` returns the resolved model with `displayName` and the four
capability reports on the new provider, and emits `capabilities_changed` on the
`status` channel.

`setModel` refuses while a turn is in flight — call `interrupt()` first, or
pass `{ force: true }` to accept losing the turn. `dispose()` is not guarded
that way: a shutdown that can refuse is worse than a truncated reply. The
transcript is durable either way.

## MCP servers and strict mode

```ts
const thread = await ade.threads.open("ops", {
  provider: "claude",
  model: "claude-sonnet-4-5",
  mcpServers: {
    docs: { type: "http", url: "https://mcp.example/mcp" },
  },
  // default: withhold the user's own MCP config
  // loadUserMcpServers: true  // opt back in
});

if (thread.mcpCapability?.strictRequested && thread.mcpCapability.level !== "enforced") {
  console.warn(thread.mcpCapability.residual);
}
```

Supplying `mcpServers` turns on strict mode unless you set
`loadUserMcpServers: true`. **False is not a uniform guarantee.** Only Claude
can enforce it. Everywhere else ADE applies the strongest mechanism that
provider exposes, and Pi has no MCP surface at all (injected servers are
refused rather than opening a tool-less thread):

| Provider | Strict mode | What still loads under strict |
|---|---|---|
| claude | enforced | nothing MCP-wise (user rules/commands/output styles still load — they are not MCP) |
| codex | best-effort | servers contributed by a Codex *plugin* |
| cursor | best-effort | user-layer servers (`~/.cursor`; ADE's own preToolUse hook lives there) |
| droid | best-effort | tools that appear only after the first disable pass |
| opencode | best-effort | the global OpenCode config directory (for auth) |
| pi | unsupported | n/a — create refuses injected servers |

The server shape is checked against the selected provider before launch. Codex
does not support `sse`, so a Codex request containing an SSE entry is rejected.
Server names `computer_use` and `ade-cto` are reserved, and a request may
contain at most 32 servers.

Read `thread.mcpCapability` after open. `strictRequested` first, then `level`.
`"enforced"` is the only value that means "nothing but the servers I supplied".
Do not tell your users "only your tools are loaded" without checking that.

### Credentials that change

The SDK never writes MCP header values to disk. The thread store keeps header
names only, and a pre-0.3 store is migrated on first read. The runtime does the
same. So supply current values in one of three ways:

```ts
const ade = await createAdeChat({
  home,
  mcpHeaders: (key, server) => (server === "app" ? { Authorization: `Bearer ${token()}` } : undefined),
});
await ade.threads.open("support", { refresh: { mcpServers: { app: { type: "http", url, headers } } } });
await thread.updateMcpServers({ app: { type: "http", url: newUrl, headers: newHeaders } });
```

`refresh.mcpServers` replaces the servers on a resume or a recreate.
`thread.updateMcpServers()` replaces them on a live thread, for the next turn;
it is refused mid-turn and on a runtime before 1.2.81. Without any of the
three, a server connects without its headers and the SDK logs a line. URL query
strings and stdio `env` values are still stored; do not put secrets there.

Tool results carry MCP `resource_link` items as `event.resourceLinks` on Codex
and on Claude (MCP tools only). Other providers do not pass them.

## Shaping the session

`threads.open` takes four options beyond the provider and model. Each one is
optional, each persists on the thread record, and omitting all four reproduces
0.1.x behavior exactly.

```ts
const thread = await ade.threads.open("assistant", {
  provider: "claude",
  model: "claude-sonnet-4-5",
  instructions: { mode: "replace", text: "You are Ada, MyApp's assistant." },
  cwd: "/Users/me/Library/Application Support/MyApp/work",
  settingSources: "project",
  permissions: {
    allowedTools: ["mcp:catalog:*", "Read"],
    deniedTools: ["Bash"],
    fallback: "deny",
  },
});
```

- **`instructions`** — your own system instructions, never a hidden first
  message. A bare string means append. See [Threads](https://www.ade-app.dev/docs/sdk/threads).
- **`cwd`** — the absolute directory the provider runs in. Defaults to a scratch
  workspace under `home`. Relative paths and `~` are refused.
- **`settingSources`** — which on-disk config the provider loads. `"none"` is the
  default and is what every 0.1.x thread got.
- **`permissions`** — a policy object is the third form, alongside `"default"`
  and `"always-allow"`. `fallback` is required. See
  [Permissions](https://www.ade-app.dev/docs/sdk/permissions).

Each one reports back what the provider actually did, the same way
`mcpCapability` does. Read `thread.instructionsCapability`,
`thread.settingSourcesCapability` and `thread.permissionCapability`, and branch
on `level` — the presence of a report is never itself a guarantee.

An approval blocks the turn until it is answered. Handle `approval_request` with
`thread.approve(itemId, decision)`, restore cards after a reload with
`thread.pendingApprovals()`, or pass `fallback: "deny"` so nothing ever asks.
`approvalTimeoutMs` on the policy (opt-in, enforced by the SDK) declines an
approval-shaped request that this client saw and nobody answered in time.

On Codex, every MCP tool call raises an approval, and the policy judges it as
`mcp:<server>:<tool>`: `deniedTools`, then `allowedTools` /
`autoApproveMcpServers`, then `fallback`. `accept_always` remembers the answer
for the session only. On Codex, `sandboxRoot` still decides command and file
escapes, and the tool fields do not.

On Claude (Agent SDK 0.3.280), `canUseTool` fires for MCP tools and for
commands that change things, not for commands Claude Code classifies as
read-only. `fallback: "ask"` stays `best-effort` for that reason.

On Claude a deny fallback does more than skip the prompt. It removes every
mutating built-in the policy does not name from the model's catalog, and scopes
MCP to the servers the policy names — including servers you injected yourself,
so name those in the policy too. `sandboxRoot` is not applied in that mode: an
unnamed tool is refused outright rather than contained. Read
`thread.permissionCapability.residual`, and see
[Permissions](https://www.ade-app.dev/docs/sdk/permissions).

## Electron

Run this from the main process, not the renderer. Spawn owns a child process
and a socket / named pipe.

```ts
const ade = await createAdeChat({
  home: path.join(app.getPath("userData"), "ade"),
});
```

Do not write the bridge yourself. `@ade-dev/sdk/electron`,
`@ade-dev/sdk/electron/preload` and `@ade-dev/sdk/electron/renderer` ship one
function per process, with listener teardown on reload and the history-and-live
ordering rule already in code. None of the three depends on `electron`.
`@ade-dev/sdk/electron/global` types `window.ade`. For a `sandbox: true`
preload, point `webPreferences.preload` at
`require.resolve("@ade-dev/sdk/electron/preload-auto")` (default key and
prefix), copy the ten-line preload from the docs, or bundle `exposeAdeBridge`
into one file. `@ade-dev/sdk/electron/preload` alone only exports the function
and exposes nothing. See
[Electron](https://www.ade-app.dev/docs/sdk/electron).

The renderer does not configure threads. Pass `openOptions: (key, rendererOptions) => ThreadOpenOptions`
to `registerAdeIpc` and main decides; without it, only `provider`, `model`,
`title` and `reasoningEffort` cross (breaking in 0.3). `allowModel` gates model
choice. `registerAdeIpc` also accepts `() => client`, for a host that replaces
its client per account.

`onThreadRemoved(key, kind)` (0.5) fires for every delete and archive the served
client reports, whether the renderer or your own main-process code made it, so
your chat list stays exact. It follows a client swapped per account as soon as
the bridge serves a call. Refuse `threads.delete` or `threads.archive` in
`authorize` to stop the renderer from making them at all — there is no separate
deny list.

To ship the runtime inside a signed app instead of downloading it, install
`@ade-dev/runtime`, copy it into your resources, and pass
`...resolvePackagedRuntime(process.resourcesPath)` with `allowDownload: false`.
`doctor().runtime.source` then reports `"packaged"`. See
[Bundling](https://www.ade-app.dev/docs/sdk/bundling).

## Runtime exits

```ts
const ade = await createAdeChat({ home, autoRestart: true });
ade.on("exit", ({ code, signal, error }) => {});
ade.on("transport", ({ state }) => {});          // "closed" | "reconnected"
ade.on("restart", ({ attempt, ok }) => {});
```

When the runtime exits, each live thread gets a synthetic
`{ type: "status", turnStatus: "failed", message, synthetic: true }` envelope.
`autoRestart` (off by default; `true` = 5 attempts, 1 s doubling backoff)
respawns the runtime and re-opens every live thread. The client object stays
the same. A turn in flight is not resumed. See
[Runtime](https://www.ade-app.dev/docs/sdk/runtime#when-the-runtime-exits).

## The live seam test

`npm test` runs against an in-process fake runtime, so it can only prove the SDK
agrees with itself. `test/live.integration.test.ts` boots a real ADE runtime and
checks that both sides agree on the wire. It is opt-in and skips itself when the
binary is not named.

Build the runtime first, then point the test at it:

```sh
cd apps/ade-cli && npm run build
cd packages/sdk
ADE_SDK_LIVE_BINARY=../../apps/ade-cli/dist/cli.cjs npm run test:live
```

That run spends no provider tokens. It covers the advertised capabilities, the
`providers.status` probe, the host configuration on the raw session summary,
the cwd refusals on both sides, `pendingApprovals()`, and a cold resume.

Add `ADE_SDK_LIVE_SPEND=1` to also run the cases that need a model turn. They
need a provider that is installed and logged in, and they cost a few cents on
the cheapest model in the catalog:

```sh
ADE_SDK_LIVE_BINARY=../../apps/ade-cli/dist/cli.cjs ADE_SDK_LIVE_SPEND=1 npm run test:live
```

Read the header of `test/live.integration.test.ts` before you trust a green
spending run. Claude's own permission default can accept every tool without
asking, and on a machine configured that way the approval cases record that
fact instead of proving the round trip.

## License

MIT. See [LICENSE](./LICENSE). ADE itself remains AGPL-3.0-only; see the [ADE Runtime Embedding Exception](https://github.com/arul28/ADE/blob/main/RUNTIME-EMBEDDING-EXCEPTION.md) for shipping the runtime binary in your app.

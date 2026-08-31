# @ade-dev/sdk

Typed Node / Electron-main client that spawns a slim ADE runtime as a sidecar
and exposes chat as durable named threads.

**Docs:** [ADE SDK](https://www.ade-app.dev/docs/sdk/overview) — install, threads, MCP honesty table, chat UI, runtime, and API reference.

```bash
npm install @ade-dev/sdk
```

Requires Node 22. The sidecar is a guest: isolated `home`, sync off, no
machine-brain authority. It dies with your process.

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

`ade.providers.status()` reports which providers currently have usable models.
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
await thread.interrupt();
await thread.setModel("claude-opus-4");      // see setModel below
```

`threads.open(key)` is open-or-resume by key stored under `home`. Keys survive
host restarts. `exportThread(key)` returns the transcript as one JSON envelope
per line.

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
| claude | **enforced** | nothing MCP-wise (user rules/commands/output styles still load — they are not MCP) |
| codex | best-effort | servers contributed by a Codex *plugin* |
| cursor | best-effort | user-layer servers (`~/.cursor`) |
| droid | best-effort | tools that appear only after the first disable pass |
| opencode | best-effort | the global OpenCode config directory (for auth) |
| pi | unsupported | n/a — create refuses injected servers |

Read `thread.mcpCapability` after open. `strictRequested` first, then `level`.
`"enforced"` is the only value that means "nothing but the servers I supplied".
Do not tell your users "only your tools are loaded" without checking that.

## Electron

Run this from the main process, not the renderer. Spawn owns a child process
and a socket / named pipe.

```ts
const ade = await createAdeChat({
  home: path.join(app.getPath("userData"), "ade"),
});
```

## License

AGPL-3.0-only. See [LICENSE](./LICENSE).

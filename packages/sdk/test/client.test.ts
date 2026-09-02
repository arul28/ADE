import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdeChat, type InternalAdeChatOptions } from "../src/client.js";
import type { AdeChatClient } from "../src/client.js";
import { SDK_VERSION } from "../src/version.js";
import type { AgentChatEventEnvelope } from "../src/types.js";
import { MockRuntime } from "./mockRuntime.js";

const homes: string[] = [];
const clients: AdeChatClient[] = [];
const runtimes: MockRuntime[] = [];

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sdk-home-"));
  homes.push(home);
  return home;
}

async function connect(
  runtime: MockRuntime,
  overrides: Partial<InternalAdeChatOptions> = {},
): Promise<AdeChatClient> {
  const client = await createAdeChat({
    home: makeHome(),
    attach: true,
    socketPath: runtime.socketPath,
    pollIntervalMs: 10,
    ...overrides,
  } as InternalAdeChatOptions);
  clients.push(client);
  return client;
}

async function startRuntime(options?: ConstructorParameters<typeof MockRuntime>[0]) {
  const runtime = new MockRuntime(options);
  await runtime.start();
  runtimes.push(runtime);
  return runtime;
}

/** Async-predicate variant of waitFor, for conditions that need a round trip. */
function waitForAsync(
  predicate: () => Promise<boolean>,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      predicate()
        .then((done) => {
          if (done) return resolve();
          if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${label}`));
          setTimeout(tick, 10).unref?.();
        })
        .catch(() => {
          if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${label}`));
          setTimeout(tick, 10).unref?.();
        });
    };
    tick();
  });
}

/** Resolves when `predicate` holds, driven by events rather than a sleep. */
function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 5).unref?.();
    };
    tick();
  });
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose().catch(() => {})));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop().catch(() => {})));
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("handshake", () => {
  it("initializes with the ADE protocol version and identity, then signals initialized", async () => {
    const runtime = await startRuntime();
    await connect(runtime);

    const initialize = runtime.calls.find((call) => call.method === "ade/initialize");
    expect(initialize).toBeDefined();
    expect(initialize!.params).toMatchObject({
      protocolVersion: "2025-06-18",
      clientName: "ade-sdk",
      // Least privilege: "cto" is the TUI's trusted-operator role and grants
      // far more than personal chats need. A silent upgrade here would be
      // invisible until it mattered.
      identity: { role: "agent" },
    });
    expect(runtime.calls.some((call) => call.method === "ade/initialized")).toBe(true);
  });

  it("selects the push transport when the runtime advertises pushEvents", async () => {
    const runtime = await startRuntime({ pushEvents: true });
    const client = await connect(runtime);
    const report = await client.doctor();
    expect(report.events.mode).toBe("push");
    expect(runtime.calls.some((call) => call.method === "personalChats.subscribeEvents")).toBe(true);
  });
});

describe("threads", () => {
  it("creates a session on first open and resumes the same one by key", async () => {
    const runtime = await startRuntime();
    const home = makeHome();
    const first = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    const thread = await first.threads.open("support", {
      provider: "claude",
      model: "claude-sonnet-4-5",
    });
    const sessionId = thread.id;
    expect(runtime.sessions.has(sessionId)).toBe(true);
    await first.dispose();

    // A brand-new client over the same home must land on the same session.
    const second = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    clients.push(second);
    const resumed = await second.threads.open("support", {
      provider: "claude",
      model: "claude-sonnet-4-5",
    });
    expect(resumed.id).toBe(sessionId);
    expect(resumed.key).toBe("support");
    expect(runtime.sessions.size).toBe(1);

    const stored = JSON.parse(fs.readFileSync(path.join(home, "threads.json"), "utf8"));
    expect(stored.threads.support.sessionId).toBe(sessionId);
  });

  it("recreates the session when the stored mapping points at a session the runtime lost", async () => {
    const runtime = await startRuntime();
    const home = makeHome();
    const client = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    clients.push(client);
    const original = await client.threads.open("k", { provider: "claude", model: "m" });

    // Simulate a wiped runtime state root behind an intact threads.json.
    runtime.sessions.clear();
    fs.writeFileSync(
      path.join(home, "threads.json"),
      JSON.stringify({
        version: 1,
        threads: {
          k: {
            key: "k",
            sessionId: original.id,
            provider: "claude",
            model: "m",
            createdAt: new Date().toISOString(),
            lastOpenedAt: new Date().toISOString(),
          },
        },
      }),
    );
    const reopened = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    clients.push(reopened);
    const thread = await reopened.threads.open("k", { provider: "claude", model: "m" });
    expect(thread.id).not.toBe(original.id);
    expect(runtime.sessions.has(thread.id)).toBe(true);
  });

  it("recreates a lost session with the stored MCP servers, not a tool-less twin", async () => {
    const runtime = await startRuntime({ mcpServers: true });
    const home = makeHome();
    const client = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    clients.push(client);
    const original = await client.threads.open("k", {
      provider: "claude",
      model: "m",
      mcpServers: { docs: { type: "http", url: "https://example.test/mcp" } },
    });
    runtime.sessions.clear();
    const reopened = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    clients.push(reopened);
    const thread = await reopened.threads.open("k");
    expect(thread.id).not.toBe(original.id);
    expect(runtime.sessions.get(thread.id)?.createArgs).toMatchObject({
      mcpServers: { docs: { type: "http", url: "https://example.test/mcp" } },
      strictMcpConfig: true,
    });
    expect(thread.mcpCapability).toMatchObject({ level: "enforced", strictRequested: true });
  });

  it("does not recreate a durable key when getSummary times out", async () => {
    const runtime = await startRuntime();
    const home = makeHome();
    const first = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    clients.push(first);
    const original = await first.threads.open("k", { provider: "claude", model: "m" });
    runtime.failNextGetSummary = "request timed out";
    const second = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    clients.push(second);
    await expect(second.threads.open("k")).rejects.toMatchObject({ code: "rpc_error" });
    expect(runtime.sessions.size).toBe(1);
    expect(runtime.sessions.has(original.id)).toBe(true);
  });

  it("maps always-allow to each provider's full-auto create args", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    await client.threads.open("c", {
      provider: "claude",
      model: "m",
      permissions: "always-allow",
    });
    await client.threads.open("x", {
      provider: "codex",
      model: "m",
      permissions: "always-allow",
    });
    const args = [...runtime.sessions.values()].map((session) => session.createArgs);
    expect(args[0]).toMatchObject({
      permissionMode: "full-auto",
      claudePermissionMode: "bypassPermissions",
    });
    expect(args[1]).toMatchObject({
      permissionMode: "full-auto",
      codexApprovalPolicy: "never",
      codexSandbox: "danger-full-access",
    });
  });

  it("sets strictMcpConfig from loadUserMcpServers and forwards mcpServers", async () => {
    const runtime = await startRuntime({ mcpServers: true });
    const client = await connect(runtime);
    await client.threads.open("with-mcp", {
      provider: "claude",
      model: "m",
      mcpServers: { docs: { type: "http", url: "https://example.test/mcp" } },
    });
    const [session] = [...runtime.sessions.values()];
    expect(session!.createArgs).toMatchObject({
      strictMcpConfig: true,
      mcpServers: { docs: { type: "http", url: "https://example.test/mcp" } },
    });

    await client.threads.open("user-mcp", {
      provider: "claude",
      model: "m",
      loadUserMcpServers: true,
    });
    const second = [...runtime.sessions.values()][1];
    expect(second!.createArgs.strictMcpConfig).toBe(false);
  });

  it("treats an empty mcpServers map as no MCP request at all", async () => {
    // `{}` is truthy. A truthiness check sent it on the wire AND turned strict
    // mode on, while every local decision read it as "nothing supplied" — so
    // the caller silently got isolation they never asked for, on a record that
    // says no MCP was requested.
    const runtime = await startRuntime({ mcpServers: true });
    const client = await connect(runtime);
    await client.threads.open("empty-mcp", { provider: "claude", model: "m", mcpServers: {} });

    const [session] = [...runtime.sessions.values()];
    expect(session!.createArgs).not.toHaveProperty("strictMcpConfig");
    expect(session!.createArgs).not.toHaveProperty("mcpServers");
  });

  it("does not warn on a delivery-only thread the runtime never reports on", async () => {
    // `loadUserMcpServers: true` with no servers asks for nothing to be
    // withheld and nothing to be injected, so the runtime emits no capability
    // report by design. A warning here would fire on every correct thread of
    // this shape, and a warning that cries wolf stops being read.
    const runtime = await startRuntime({ mcpServers: true });
    const lines: string[] = [];
    const client = await connect(runtime, { logger: (line) => lines.push(line) });
    const thread = await client.threads.open("delivery-only", {
      provider: "codex",
      model: "m",
      loadUserMcpServers: true,
    });

    expect(thread.mcpCapability).toBeNull();
    expect(lines.some((line) => line.includes("requested MCP but the runtime"))).toBe(false);
    // Still an explicit choice on the wire: omitting the key would give the
    // caller the opposite of what they asked for.
    const [session] = [...runtime.sessions.values()];
    expect(session!.createArgs.strictMcpConfig).toBe(false);
  });

  it("keeps the provider's real level on a delivery-only thread", async () => {
    // `level` is what the PROVIDER could do, not what this call asked for.
    // Reporting delivery-only Codex as "enforced" would let a client that
    // ignores `strictRequested` look correct.
    const runtime = await startRuntime({ mcpServers: true });
    const lines: string[] = [];
    const client = await connect(runtime, { logger: (line) => lines.push(line) });
    const thread = await client.threads.open("codex-delivery-level", {
      provider: "codex",
      model: "m",
      mcpServers: { docs: { type: "stdio", command: "node" } },
      loadUserMcpServers: true,
    });

    expect(thread.mcpCapability).toMatchObject({
      level: "best-effort",
      strictRequested: false,
      residual: null,
    });
    // No residual means no best-effort warning: there was no exclusion to leak.
    expect(lines.some((line) => line.includes("best-effort"))).toBe(false);
  });

  it("exposes the provider's MCP capability report, including the best-effort residual", async () => {
    const runtime = await startRuntime({ mcpServers: true });
    const client = await connect(runtime);

    const enforced = await client.threads.open("claude-mcp", {
      provider: "claude",
      model: "m",
      mcpServers: { docs: { type: "stdio", command: "node" } },
    });
    expect(enforced.mcpCapability).toEqual({
      level: "enforced",
      mechanism: "strictMcpConfig",
      residual: null,
      delivered: true,
      strictRequested: true,
    });

    const bestEffort = await client.threads.open("codex-mcp", {
      provider: "codex",
      model: "m",
      mcpServers: { docs: { type: "stdio", command: "node" } },
    });
    expect(bestEffort.mcpCapability).toMatchObject({ level: "best-effort", delivered: true });
    expect(bestEffort.mcpCapability!.residual).toContain("plugin-contributed");
    expect(bestEffort.mcpCapability!.strictRequested).toBe(true);
  });

  it("reads a pre-field runtime's report as not strict rather than guessing", async () => {
    // Understating isolation is the only safe direction: the alternative is
    // telling a user their tools are the whole surface on no evidence.
    const runtime = await startRuntime({ mcpServers: true });
    runtime.omitStrictRequested = true;
    const client = await connect(runtime);
    const thread = await client.threads.open("legacy-mcp", {
      provider: "claude",
      model: "m",
      mcpServers: { docs: { type: "stdio", command: "node" } },
    });
    expect(thread.mcpCapability).toMatchObject({
      level: "enforced",
      strictRequested: false,
      // Dropped with it: a residual is a statement about strict mode, and this
      // report cannot establish that strict mode was even asked for.
      residual: null,
    });
  });

  it("warns rather than staying silent when MCP was requested but no capability came back", async () => {
    const runtime = await startRuntime({ mcpServers: true });
    // Reproduces the live-runtime gap found in the integration smoke: create
    // succeeds and the capability flag is set, but the summary carries no
    // report. A missing report must never read as "nothing was requested".
    runtime.suppressMcpCapability = true;
    const lines: string[] = [];
    const client = await connect(runtime, { logger: (line) => lines.push(line) });
    const thread = await client.threads.open("silent-mcp", {
      provider: "claude",
      model: "m",
      mcpServers: { docs: { type: "stdio", command: "node" } },
    });
    expect(thread.mcpCapability).toBeNull();
    expect(lines.some((line) => line.includes("reported no capability"))).toBe(true);
  });

  it("does not cry failure on a strict-only request that a stale runtime marks undelivered", async () => {
    // A strict-only request — isolate this chat from the user's MCP, supply no
    // servers of my own — is a success. Older runtimes reported it with
    // `delivered: false`, so a client branching on that field announced a
    // working isolation request as a dropped one. Branch on `level`.
    const runtime = await startRuntime({ mcpServers: true });
    runtime.strictOnlyReportsUndelivered = true;
    const lines: string[] = [];
    const client = await connect(runtime, { logger: (line) => lines.push(line) });

    const thread = await client.threads.open("strict-only", {
      provider: "claude",
      model: "m",
      loadUserMcpServers: false,
    });
    expect(thread.mcpCapability).toMatchObject({ level: "enforced", delivered: false });
    expect(lines.some((line) => line.includes("WITHOUT the requested MCP servers"))).toBe(false);
    // It is still a real request, so a missing report would still warn.
    expect(lines.some((line) => line.includes("reported no capability"))).toBe(false);
  });

  it("still warns when supplied servers genuinely could not be delivered", async () => {
    // The inverse of the case above: `level: "unsupported"` with servers
    // actually supplied is the one situation the warning is for.
    const runtime = await startRuntime({ mcpServers: true });
    runtime.forceUnsupportedCapability = true;
    const lines: string[] = [];
    const client = await connect(runtime, { logger: (line) => lines.push(line) });
    await client.threads.open("dropped", {
      provider: "claude",
      model: "m",
      mcpServers: { docs: { type: "stdio", command: "node" } },
    });
    expect(lines.some((line) => line.includes("WITHOUT the requested MCP servers"))).toBe(true);
  });

  it("still reads strict as false when a pre-field runtime also drops the servers", async () => {
    // The two mock switches are independent runtime defects and compose: an old
    // runtime that omits `strictRequested` can also report the servers as
    // undeliverable. The omission has to survive the other switch, or this case
    // silently tests the modern shape instead of the legacy one.
    const runtime = await startRuntime({ mcpServers: true });
    runtime.forceUnsupportedCapability = true;
    runtime.omitStrictRequested = true;
    const client = await connect(runtime);
    const thread = await client.threads.open("legacy-dropped", {
      provider: "claude",
      model: "m",
      mcpServers: { docs: { type: "stdio", command: "node" } },
    });
    expect(thread.mcpCapability).toMatchObject({
      level: "unsupported",
      delivered: false,
      strictRequested: false,
      residual: null,
    });
  });

  it("surfaces a best-effort residual even when the report also says undelivered", async () => {
    // The two warnings are independent. Chaining them behind else-if hid the
    // residual on any report that also carried delivered:false.
    const runtime = await startRuntime({ mcpServers: true });
    runtime.strictOnlyReportsUndelivered = true;
    const lines: string[] = [];
    const client = await connect(runtime, { logger: (line) => lines.push(line) });
    await client.threads.open("residual", {
      provider: "codex",
      model: "m",
      loadUserMcpServers: false,
    });
    expect(lines.some((line) => line.includes("best-effort"))).toBe(true);
  });

  it("ignores a volunteered capability stub on resume for a thread that asked for nothing", async () => {
    // Guards the failure mode that would silently invert `mcpCapability ===
    // null` for every chat: a runtime that starts defaulting a stub onto every
    // summary. A thread on record as having requested nothing must keep
    // reporting null no matter what the wire says.
    const runtime = await startRuntime({ mcpServers: true });
    const home = makeHome();
    const first = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    const thread = await first.threads.open("no-mcp", { provider: "claude", model: "m" });
    expect(thread.mcpCapability).toBeNull();
    await first.dispose();

    runtime.sessions.get(thread.id)!.mcpCapability = {
      level: "unsupported",
      mechanism: "stub",
      residual: null,
      delivered: false,
    };

    const second = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    clients.push(second);
    const resumed = await second.threads.open("no-mcp", { provider: "claude", model: "m" });
    expect(resumed.id).toBe(thread.id);
    expect(resumed.mcpCapability).toBeNull();
  });

  it("still trusts the runtime on resume for a record written before requestedMcp existed", async () => {
    // Backward compatibility: a legacy record (or a chat created outside the
    // SDK) has no stored answer, so suppressing would lose a real report.
    const runtime = await startRuntime({ mcpServers: true });
    const home = makeHome();
    const client = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    clients.push(client);
    const thread = await client.threads.open("legacy", {
      provider: "codex",
      model: "m",
      mcpServers: { docs: { type: "stdio", command: "node" } },
    });
    await client.dispose();

    const store = JSON.parse(fs.readFileSync(path.join(home, "threads.json"), "utf8"));
    delete store.threads.legacy.requestedMcp;
    fs.writeFileSync(path.join(home, "threads.json"), JSON.stringify(store));

    const reopened = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    clients.push(reopened);
    const resumed = await reopened.threads.open("legacy", { provider: "codex", model: "m" });
    expect(resumed.id).toBe(thread.id);
    expect(resumed.mcpCapability).toMatchObject({ level: "best-effort" });
  });

  it("reports no MCP capability for a thread that never asked for one", async () => {
    const runtime = await startRuntime({ mcpServers: true });
    const client = await connect(runtime);
    const thread = await client.threads.open("plain", { provider: "claude", model: "m" });
    expect(thread.mcpCapability).toBeNull();
  });

  it("carries the MCP capability across a resume", async () => {
    const runtime = await startRuntime({ mcpServers: true });
    const home = makeHome();
    const first = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    await first.threads.open("resumed-mcp", {
      provider: "codex",
      model: "m",
      mcpServers: { docs: { type: "stdio", command: "node" } },
    });
    await first.dispose();

    const second = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    clients.push(second);
    // The resumed thread must report the same caveat: an embedder that only
    // checked on first open would show a stale guarantee after a restart.
    const resumed = await second.threads.open("resumed-mcp", { provider: "codex", model: "m" });
    expect(resumed.mcpCapability).toMatchObject({ level: "best-effort", delivered: true });
  });

  it("surfaces the runtime's refusal when a provider has no MCP surface", async () => {
    const runtime = await startRuntime({ mcpServers: true });
    const client = await connect(runtime);
    // Pi is refused by the runtime before a session row is written, so the
    // rejection must reach the caller rather than becoming a silent no-tool chat.
    await expect(
      client.threads.open("pi-mcp", {
        provider: "pi",
        model: "m",
        mcpServers: { docs: { type: "stdio", command: "node" } },
      }),
    ).rejects.toMatchObject({ code: "rpc_error" });
    expect(runtime.sessions.size).toBe(0);
  });

  it("refuses mcpServers against a runtime that does not advertise support", async () => {
    const runtime = await startRuntime({ mcpServers: false });
    const client = await connect(runtime);
    await expect(
      client.threads.open("mcp", {
        provider: "claude",
        model: "m",
        mcpServers: { docs: { type: "stdio", command: "node" } },
      }),
    ).rejects.toMatchObject({ code: "invalid_option" });
  });

  it("lists runtime sessions with their SDK keys attached", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const thread = await client.threads.open("named", { provider: "claude", model: "m" });
    const list = await client.threads.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: "named", sessionId: thread.id, provider: "claude" });
  });
  it("resumes a stored key with no provider or model", async () => {
    // A durable thread already recorded both. Requiring the caller to remember
    // them after a restart makes the headline feature (stable keys) unusable.
    const runtime = await startRuntime();
    const home = makeHome();
    const first = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    const created = await first.threads.open("support", {
      provider: "claude",
      model: "claude-sonnet-4-5",
    });
    await first.dispose();

    const second = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    clients.push(second);
    const resumed = await second.threads.open("support");
    expect(resumed.id).toBe(created.id);
    expect(runtime.sessions.size).toBe(1);
  });

  it("still refuses to CREATE a thread with no provider or model", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    await expect(client.threads.open("brand-new")).rejects.toThrow(/needs a provider/);
    await expect(
      client.threads.open("brand-new", { provider: "claude" }),
    ).rejects.toThrow(/needs a model id/);
    expect(runtime.sessions.size).toBe(0);
  });

  it("collapses concurrent opens of one key into a single session", async () => {
    // A React effect that re-runs (StrictMode, a changed model id) fires
    // overlapping opens. Two sessions for one key orphans a provider process
    // and leaves the store pointing at only one of them.
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const opts = { provider: "claude" as const, model: "claude-sonnet-4-5" };
    const [a, b, c] = await Promise.all([
      client.threads.open("main", opts),
      client.threads.open("main", opts),
      client.threads.open("main", opts),
    ]);
    expect(a.id).toBe(b.id);
    expect(b.id).toBe(c.id);
    expect(runtime.sessions.size).toBe(1);
  });
});

describe("streaming", () => {
  it("delivers pushed events to the matching thread only", async () => {
    const runtime = await startRuntime({ pushEvents: true });
    const client = await connect(runtime);
    const a = await client.threads.open("a", { provider: "claude", model: "m" });
    const b = await client.threads.open("b", { provider: "claude", model: "m" });

    const seenByA: AgentChatEventEnvelope[] = [];
    const seenByB: AgentChatEventEnvelope[] = [];
    a.on("event", (envelope) => seenByA.push(envelope));
    b.on("event", (envelope) => seenByB.push(envelope));

    runtime.emitChatEvent(a.id, { type: "text", text: "hello from a" });
    await waitFor(() => seenByA.length === 1, "thread a event");
    expect(seenByA[0]!.event).toMatchObject({ type: "text", text: "hello from a" });
    expect(seenByB).toHaveLength(0);
  });

  it("routes usage and status events to their channels", async () => {
    const runtime = await startRuntime({ pushEvents: true });
    const client = await connect(runtime);
    const thread = await client.threads.open("t", { provider: "claude", model: "m" });

    const usage: AgentChatEventEnvelope[] = [];
    const status: AgentChatEventEnvelope[] = [];
    thread.on("usage", (envelope) => usage.push(envelope));
    thread.on("status", (envelope) => status.push(envelope));

    runtime.emitChatEvent(thread.id, { type: "text", text: "ignored" });
    runtime.emitChatEvent(thread.id, { type: "tokens", input: 10, output: 4 });
    runtime.emitChatEvent(thread.id, { type: "done" });
    await waitFor(() => usage.length === 1 && status.length === 1, "channel routing");
    expect(usage[0]!.event.type).toBe("tokens");
    expect(status[0]!.event.type).toBe("done");
  });

  it("falls back to the drain transport when subscribe is unavailable", async () => {
    const runtime = await startRuntime({ pushEvents: true, rejectSubscribe: true });
    const client = await connect(runtime);
    const thread = await client.threads.open("t", { provider: "claude", model: "m" });

    const seen: AgentChatEventEnvelope[] = [];
    thread.on("event", (envelope) => seen.push(envelope));
    runtime.emitChatEvent(thread.id, { type: "text", text: "polled" });

    await waitFor(() => seen.some((e) => e.event.text === "polled"), "drained event");
    const report = await client.doctor();
    expect(report.events.mode).toBe("drain");
  });

  it("uses the drain transport when the runtime never advertises pushEvents", async () => {
    const runtime = await startRuntime({ pushEvents: false });
    const client = await connect(runtime);
    const thread = await client.threads.open("t", { provider: "claude", model: "m" });
    const seen: AgentChatEventEnvelope[] = [];
    thread.on("event", (envelope) => seen.push(envelope));
    runtime.emitChatEvent(thread.id, { type: "text", text: "no-push" });
    await waitFor(() => seen.length === 1, "drained event without push capability");
    expect(runtime.calls.some((call) => call.method === "personalChats.subscribeEvents")).toBe(false);
  });

  it("reports a gap and keeps streaming after the buffer evicts unread events", async () => {
    const runtime = await startRuntime({ pushEvents: false });
    const client = await connect(runtime);
    const thread = await client.threads.open("t", { provider: "claude", model: "m" });

    const seen: AgentChatEventEnvelope[] = [];
    thread.on("event", (envelope) => seen.push(envelope));
    runtime.emitChatEvent(thread.id, { type: "text", text: "first" });
    await waitFor(() => seen.length === 1, "first event");

    runtime.emitChatEvent(thread.id, { type: "text", text: "lost" });
    runtime.evictAll();
    runtime.emitChatEvent(thread.id, { type: "text", text: "after-gap" });

    await waitFor(() => seen.some((e) => e.event.text === "after-gap"), "post-gap event");
    const report = await client.doctor();
    expect(report.events.gapsRecovered).toBeGreaterThan(0);
    expect(seen.some((e) => e.event.text === "lost")).toBe(false);
  });
});

describe("send, history and export", () => {
  it("sends text and reads it back through history", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const thread = await client.threads.open("t", { provider: "claude", model: "m" });
    await thread.send("hello runtime");
    const history = await thread.history();
    expect(history.map((entry) => entry.event.text)).toContain("hello runtime");
  });

  it("rejects an empty send rather than firing a no-op turn", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const thread = await client.threads.open("t", { provider: "claude", model: "m" });
    await expect(thread.send("   ")).rejects.toMatchObject({ code: "invalid_option" });
  });

  it("exports a thread as one JSON envelope per line", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const thread = await client.threads.open("export-me", { provider: "claude", model: "m" });
    await thread.send("one");
    await thread.send("two");
    const jsonl = await client.exportThread("export-me");
    const lines = jsonl.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      sessionId: thread.id,
      event: { type: "user_message", text: "one" },
    });
  });

  it("rejects exporting an unknown key", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    await expect(client.exportThread("nope")).rejects.toMatchObject({
      code: "thread_not_found",
    });
  });
});

describe("providers, models and doctor", () => {
  it("derives per-provider status from the model catalog", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const status = await client.providers.status();
    expect(status.claude).toMatchObject({ authenticated: true, available: true, modelCount: 2 });
    expect(status.codex).toMatchObject({
      authenticated: false,
      available: true,
      requiresConfiguration: true,
    });
  });

  it("flattens the catalog into model rows", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const models = await client.models.list();
    expect(models.map((model) => model.id)).toEqual([
      "claude-sonnet-4-5",
      "claude-opus-4-1",
      "gpt-5-codex",
    ]);
    expect(models[0]).toMatchObject({
      provider: "claude",
      runtimeModelId: "claude-sonnet-4-5-20250929",
      reasoningEfforts: ["high"],
    });
  });

  it("returns a doctor report covering binary, socket, events, providers and threads", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    await client.threads.open("t", { provider: "claude", model: "m" });
    const report = await client.doctor();
    expect(report.ok).toBe(true);
    expect(report.socket).toMatchObject({ connected: true, runtimeVersion: "1.2.69", pid: 4242 });
    expect(report.socket.path).toBe(runtime.socketPath);
    expect(report.events.mode).toBe("push");
    expect(report.threads).toEqual({ tracked: 1, live: 1 });
    expect(Object.keys(report.providers).sort()).toEqual(["claude", "codex"]);
    expect(Array.isArray(report.recentErrors)).toBe(true);
    // The SDK half of the version pair. It must be the real package version,
    // not a placeholder, or a support report says nothing.
    expect(report.sdkVersion).toBe(SDK_VERSION);
    expect(report.sdkVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("records a failing RPC in the doctor report instead of throwing it away", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    runtime.failCatalog = true;

    // A catalog failure must not take the whole client down: status degrades to
    // "no providers" and the reason is retained for doctor to report.
    await expect(client.providers.status()).resolves.toEqual({});
    const report = await client.doctor();
    expect(report.ok).toBe(false);
    expect(report.recentErrors.length).toBeGreaterThan(0);
    expect(report.recentErrors.at(-1)).toMatchObject({ scope: "modelCatalog" });
    expect(report.recentErrors.at(-1)!.message).toContain("model catalog unavailable");
  });

  it("notifies providers.onChange when the catalog verdict changes, and stops after unsubscribe", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime, { providerPollIntervalMs: 10 });

    const seen: Array<Record<string, unknown>> = [];
    const unsubscribe = client.providers.onChange((status) => seen.push(status));
    await waitFor(() => seen.length === 1, "initial provider snapshot");
    expect(seen[0]!.claude).toMatchObject({ authenticated: true });

    // Flip codex to connected; the next poll must report exactly one change.
    const catalog = runtime.catalog as {
      groups: Array<{ key: string; providers: Array<{ subsections: Array<{ models: Array<Record<string, unknown>> }> }> }>;
    };
    catalog.groups[1]!.providers[0]!.subsections[0]!.models[0]!.connected = true;
    await waitFor(() => seen.length === 2, "provider change notification");
    expect(seen[1]!.codex).toMatchObject({ authenticated: true });

    unsubscribe();
    const countAtUnsubscribe = seen.length;
    catalog.groups[0]!.providers[0]!.subsections[0]!.models[0]!.connected = false;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(seen).toHaveLength(countAtUnsubscribe);
  });
});

describe("dispose", () => {
  it("closes the socket and rejects further calls", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    await client.dispose();
    await expect(client.models.list()).rejects.toMatchObject({ code: "disposed" });
    await expect(client.threads.list()).rejects.toMatchObject({ code: "disposed" });
    // Second dispose must be a no-op, not a crash.
    await client.dispose();
  });

  it("unsubscribes the push subscription on dispose", async () => {
    const runtime = await startRuntime({ pushEvents: true });
    const client = await connect(runtime);
    await client.dispose();
    expect(
      runtime.calls.some((call) => call.method === "personalChats.unsubscribeEvents"),
    ).toBe(true);
  });
});

/**
 * Mid-thread model switching. Before this existed the SDK had no way to reach
 * the engine's `updateSession`, so a host's model picker could only ever choose
 * at create time — a picker that silently ignored every later change.
 */
describe("thread.setModel", () => {
  it("switches the model on an open thread and reports what it became", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const thread = await client.threads.open("switcher", {
      provider: "claude",
      model: "claude-sonnet-4-5",
    });

    const selection = await thread.setModel("gpt-5-codex");

    // The runtime's answer is authoritative: it resolves the catalog id to a
    // provider GROUP, which a caller cannot infer from the id string.
    expect(selection).toEqual({
      modelId: "gpt-5-codex",
      provider: "codex",
      model: "gpt-5-codex",
    });
    // Verified against the runtime's own state, not the SDK's cache — the
    // switch has to have actually landed server-side.
    expect(runtime.sessions.get(thread.id)?.provider).toBe("codex");
    expect(runtime.calls.some((call) =>
      call.method === "personalChats.call"
      && (call.params as { action?: string }).action === "updateSession",
    )).toBe(true);
  });

  it("crosses providers without starting a new conversation", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const thread = await client.threads.open("keeper", {
      provider: "claude",
      model: "claude-sonnet-4-5",
    });
    const sessionIdBefore = thread.id;

    await thread.setModel("gpt-5-codex");

    // The whole point of setModel over close-and-reopen: the engine replays the
    // transcript into the new provider thread, so the conversation continues.
    // A new session id here would mean the user silently lost their history.
    expect(thread.id).toBe(sessionIdBefore);
    expect(runtime.sessions.size).toBe(1);
  });

  it("persists the switch so a resume does not restore the old model", async () => {
    const runtime = await startRuntime();
    const home = makeHome();
    const first = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    clients.push(first);
    const thread = await first.threads.open("durable", {
      provider: "claude",
      model: "claude-sonnet-4-5",
    });
    await thread.setModel("gpt-5-codex");

    // Resume reads provider/model straight out of threads.json. Without the
    // store write the switch would survive only until the next app start, and
    // the thread would quietly snap back to the model it was created with.
    const second = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    clients.push(second);
    const listed = await second.threads.list();
    const record = listed.find((entry) => entry.key === "durable");
    expect(record?.provider).toBe("codex");
    expect(record?.model).toBe("gpt-5-codex");
  });

  it("rejects an empty model id before touching the runtime", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const thread = await client.threads.open("guard", {
      provider: "claude",
      model: "claude-sonnet-4-5",
    });
    await expect(thread.setModel("   ")).rejects.toThrow(/catalog model id/);
  });

  it("refuses a mid-turn switch that would kill the turn silently", async () => {
    // Every provider but Cursor tears the runtime down on a model switch, and
    // that teardown emits no `error` and no `done` — the consumer just sees
    // events stop. An SDK caller has no composer UI telling them a turn is
    // running, so this must not be the default outcome.
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const thread = await client.threads.open("busy", { provider: "claude", model: "m" });
    runtime.sessions.get(thread.id)!.status = "active";

    await expect(thread.setModel("gpt-5-codex")).rejects.toMatchObject({
      code: "invalid_option",
    });
    await expect(thread.setModel("gpt-5-codex")).rejects.toThrow(/turn in flight/);
    // Nothing was changed on the way to refusing.
    expect(runtime.sessions.get(thread.id)!.model).toBe("m");
  });

  it("switches mid-turn when the caller explicitly forces it", async () => {
    // The way out has to exist: a caller who knows the turn is disposable must
    // be able to say so rather than being blocked.
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const thread = await client.threads.open("busy-force", { provider: "claude", model: "m" });
    runtime.sessions.get(thread.id)!.status = "active";

    const selection = await thread.setModel("gpt-5-codex", { force: true });
    expect(selection.modelId).toBe("gpt-5-codex");
  });

  it("does not pay a status round trip when forcing", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const thread = await client.threads.open("no-probe", { provider: "claude", model: "m" });
    const before = runtime.calls.filter(
      (call) => (call.params as { action?: string })?.action === "getSummary",
    ).length;
    await thread.setModel("gpt-5-codex", { force: true });
    const after = runtime.calls.filter(
      (call) => (call.params as { action?: string })?.action === "getSummary",
    ).length;
    expect(after).toBe(before);
  });

  it("surfaces the runtime's rejection of an unknown model", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const thread = await client.threads.open("unknown-model", {
      provider: "claude",
      model: "claude-sonnet-4-5",
    });
    // Must not be swallowed into a silent no-op: a picker showing a model the
    // engine cannot resolve has to fail loudly, or the user sees the new name
    // in the UI while the old model keeps answering.
    await expect(thread.setModel("not-a-real-model")).rejects.toThrow(/not-a-real-model/);
  });

  it("refreshes mcpCapability after a cross-provider switch", async () => {
    const runtime = await startRuntime({ mcpServers: true });
    const client = await connect(runtime);
    const thread = await client.threads.open("switch-mcp", {
      provider: "claude",
      model: "claude-sonnet-4-5",
      mcpServers: { docs: { type: "stdio", command: "node" } },
    });
    expect(thread.mcpCapability).toMatchObject({ level: "enforced", strictRequested: true });

    await thread.setModel("gpt-5-codex");

    expect(thread.mcpCapability).toMatchObject({
      level: "best-effort",
      strictRequested: true,
    });
    expect(thread.mcpCapability?.residual).toContain("plugin-contributed");
  });

  it("refuses setModel when status cannot be read, unless forced", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const thread = await client.threads.open("opaque", { provider: "claude", model: "m" });
    runtime.failNextGetSummary = "socket hung";
    await expect(thread.setModel("gpt-5-codex")).rejects.toMatchObject({ code: "rpc_error" });
    expect(runtime.sessions.get(thread.id)!.model).toBe("m");
    runtime.failNextGetSummary = "socket hung";
    const selection = await thread.setModel("gpt-5-codex", { force: true });
    expect(selection.modelId).toBe("gpt-5-codex");
  });
});

describe("event stream liveness", () => {
  it("stops claiming ok once the socket drops in push mode", async () => {
    // Push mode has no poll loop to notice a dead connection, so doctor()
    // previously kept reporting a healthy "push" stream over a dead socket.
    const runtime = await startRuntime({ pushEvents: true });
    const client = await connect(runtime);
    expect((await client.doctor()).events.mode).toBe("push");

    await runtime.stop();
    await waitForAsync(async () => (await client.doctor()).events.mode === "unavailable", "stream marked unavailable");
    const report = await client.doctor();
    expect(report.events.mode).toBe("unavailable");
    expect(report.ok).toBe(false);
  });
});

/**
 * A canonical path under the temp root.
 *
 * `os.tmpdir()` is a symlink on macOS, and the SDK canonicalizes a `cwd` before
 * it sends or records one, so a fixture built from `os.tmpdir()` alone names a
 * directory by a spelling the SDK will never produce.
 */
function canonicalTmpPath(...segments: string[]): string {
  return path.join(fs.realpathSync.native(os.tmpdir()), ...segments);
}

describe("host configuration on create", () => {
  const createArgsOf = (runtime: MockRuntime, index = 0): Record<string, unknown> =>
    [...runtime.sessions.values()][index]!.createArgs;

  it("normalizes a bare instructions string to an append on the wire", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    await client.threads.open("a", { provider: "claude", model: "m", instructions: "Be brief." });
    expect(createArgsOf(runtime).instructions).toEqual({ mode: "append", text: "Be brief." });
  });

  it("sends a replace instruction verbatim", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    await client.threads.open("a", {
      provider: "claude",
      model: "m",
      instructions: { mode: "replace", text: "You are Ada." },
    });
    expect(createArgsOf(runtime).instructions).toEqual({ mode: "replace", text: "You are Ada." });
  });

  it("falls back to the client-level instructions, and lets a thread override them", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime, { instructions: "House style." });
    await client.threads.open("a", { provider: "claude", model: "m" });
    await client.threads.open("b", {
      provider: "claude",
      model: "m",
      instructions: "Thread style.",
    });
    expect(createArgsOf(runtime, 0).instructions).toEqual({
      mode: "append",
      text: "House style.",
    });
    // The per-thread text REPLACES the client default rather than concatenating:
    // two personas silently glued together is nobody's intent.
    expect(createArgsOf(runtime, 1).instructions).toEqual({
      mode: "append",
      text: "Thread style.",
    });
  });

  it("sends an absolute cwd as requestedCwd and a setting-source layer verbatim", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const dir = path.join(os.tmpdir(), "ade-sdk-thread-cwd");
    await client.threads.open("a", {
      provider: "claude",
      model: "m",
      cwd: dir,
      settingSources: "project",
    });
    // Canonical, not the caller's spelling: the SDK resolves symlinks before it
    // sends the path so the value it records and the value the engine stores are
    // one string. Two spellings of one directory is how a resume reports an
    // unchanged `cwd` as ignored.
    expect(createArgsOf(runtime)).toMatchObject({
      requestedCwd: canonicalTmpPath("ade-sdk-thread-cwd"),
      settingSources: "project",
    });
  });

  it("records the canonical cwd the runtime echoes, not the caller's spelling", async () => {
    // The engine resolves the path before it binds the session, so one
    // directory reached through a symlink or in another case comes back as one
    // string. Recording the caller's spelling made a later open with the
    // runtime's own spelling of the SAME directory report a resume mismatch.
    const runtime = await startRuntime();
    const home = makeHome();
    // A real canonical path, since that is what a real runtime echoes. Built
    // from the resolved temp root rather than `os.tmpdir()`, which on macOS is
    // the symlinked spelling.
    const canonical = canonicalTmpPath("ade-sdk-canonical-cwd");
    runtime.canonicalCwd = canonical;
    const logs: string[] = [];
    const first = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    clients.push(first);
    await first.threads.open("a", {
      provider: "claude",
      model: "m",
      cwd: path.join(os.tmpdir(), "ade-sdk-caller-spelling"),
    });
    await first.dispose();

    const reopened = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
      logger: (line) => logs.push(line),
    } as InternalAdeChatOptions);
    clients.push(reopened);
    await reopened.threads.open("a", { cwd: canonical });
    expect(logs.filter((line) => line.includes("was ignored"))).toHaveLength(0);
  });

  it("falls back to the resolved path when the runtime echoes no cwd", async () => {
    const runtime = await startRuntime();
    runtime.suppressRequestedCwd = true;
    const home = makeHome();
    const dir = path.join(os.tmpdir(), "ade-sdk-no-echo-cwd");
    const logs: string[] = [];
    const first = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    clients.push(first);
    await first.threads.open("a", { provider: "claude", model: "m", cwd: dir });
    await first.dispose();

    const reopened = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
      logger: (line) => logs.push(line),
    } as InternalAdeChatOptions);
    clients.push(reopened);
    await reopened.threads.open("a", { cwd: dir });
    expect(logs.filter((line) => line.includes("was ignored"))).toHaveLength(0);
  });

  it("refuses a relative cwd before any RPC is made", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    await expect(
      client.threads.open("a", { provider: "claude", model: "m", cwd: "./work" }),
    ).rejects.toMatchObject({ name: "AdeError", code: "invalid_option" });
    // Nothing was created: a refused option must not leave a half-open thread
    // that a retry under the same key would then resume.
    expect(runtime.sessions.size).toBe(0);
  });

  it("sends a policy as permissionMode default plus permissionPolicy", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    await client.threads.open("a", {
      provider: "claude",
      model: "m",
      permissions: { fallback: "deny", allowedTools: ["mcp:tools:*"], deniedTools: ["Bash"] },
    });
    expect(createArgsOf(runtime)).toMatchObject({
      permissionMode: "default",
      permissionPolicy: {
        fallback: "deny",
        allowedTools: ["mcp:tools:*"],
        deniedTools: ["Bash"],
      },
    });
    expect(createArgsOf(runtime).claudePermissionMode).toBeUndefined();
  });

  it("sends none of the new fields for a thread that asked for none", async () => {
    // Backward compatibility, on the wire rather than in a comment: a 0.1.x
    // caller's create payload must not gain keys it never set.
    const runtime = await startRuntime();
    const client = await connect(runtime);
    await client.threads.open("a", { provider: "claude", model: "m" });
    const args = createArgsOf(runtime);
    expect(args.instructions).toBeUndefined();
    expect(args.requestedCwd).toBeUndefined();
    expect(args.settingSources).toBeUndefined();
    expect(args.permissionPolicy).toBeUndefined();
    expect(args.permissionMode).toBe("default");
  });

  it("maps the engine's invalid_argument refusal onto invalid_option", async () => {
    // The engine answers a bad cwd with a message starting `invalid_argument:`,
    // which arrives as a generic rpc_error. A caller cannot branch on prose.
    const runtime = await startRuntime();
    const client = await connect(runtime);
    runtime.failNextCreate = "invalid_argument: cwd is inside ADE_HOME";
    await expect(
      client.threads.open("a", { provider: "claude", model: "m" }),
    ).rejects.toMatchObject({ code: "invalid_option" });

    // A failure that is NOT an argument refusal keeps its own code.
    runtime.failNextCreate = "the provider process died";
    await expect(
      client.threads.open("b", { provider: "claude", model: "m" }),
    ).rejects.toMatchObject({ code: "rpc_error" });
  });
});

describe("host configuration capabilities", () => {
  it("reports what each provider did with instructions, settingSources and a policy", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const claude = await client.threads.open("c", {
      provider: "claude",
      model: "m",
      instructions: "Be brief.",
      settingSources: "project",
      permissions: { fallback: "ask" },
    });
    expect(claude.instructionsCapability).toMatchObject({
      requested: true,
      level: "applied",
      mode: "append",
    });
    expect(claude.settingSourcesCapability).toMatchObject({ level: "applied", value: "project" });
    expect(claude.permissionCapability).toMatchObject({ level: "enforced", residual: null });

    const cursor = await client.threads.open("x", {
      provider: "cursor",
      model: "m",
      instructions: "Be brief.",
      settingSources: "project",
      permissions: { fallback: "ask" },
    });
    // The honesty half: the same three options, three weaker answers.
    expect(cursor.instructionsCapability!.level).toBe("best-effort");
    expect(cursor.settingSourcesCapability!.level).toBe("ignored");
    expect(cursor.permissionCapability!.level).toBe("unsupported");
    expect(cursor.permissionCapability!.residual).toBeTruthy();
  });

  it("reports null for a thread that requested none of them", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const thread = await client.threads.open("a", { provider: "claude", model: "m" });
    expect(thread.instructionsCapability).toBeNull();
    expect(thread.settingSourcesCapability).toBeNull();
    expect(thread.permissionCapability).toBeNull();
  });

  it("reports null, not a guess, when an older runtime omits the report", async () => {
    const runtime = await startRuntime();
    runtime.suppressInstructionsCapability = true;
    runtime.suppressPermissionCapability = true;
    const client = await connect(runtime);
    const thread = await client.threads.open("a", {
      provider: "claude",
      model: "m",
      instructions: "Be brief.",
      permissions: { fallback: "ask" },
    });
    expect(thread.instructionsCapability).toBeNull();
    expect(thread.permissionCapability).toBeNull();
  });

  it("carries the reports across a resume", async () => {
    const runtime = await startRuntime();
    const home = makeHome();
    const first = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    clients.push(first);
    await first.threads.open("a", {
      provider: "claude",
      model: "m",
      instructions: "Be brief.",
      settingSources: "user",
      permissions: { fallback: "deny" },
    });
    await first.dispose();

    const second = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    clients.push(second);
    const resumed = await second.threads.open("a");
    expect(resumed.instructionsCapability).toMatchObject({ level: "applied", mode: "append" });
    expect(resumed.settingSourcesCapability).toMatchObject({ value: "user" });
    expect(resumed.permissionCapability).toMatchObject({ level: "enforced" });
  });

  it("rebuilds the host configuration when a lost session has to be recreated", async () => {
    const runtime = await startRuntime();
    const home = makeHome();
    const client = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    clients.push(client);
    const dir = path.join(os.tmpdir(), "ade-sdk-recreate-cwd");
    await client.threads.open("a", {
      provider: "claude",
      model: "m",
      instructions: { mode: "replace", text: "You are Ada." },
      cwd: dir,
      settingSources: "project",
      permissions: { fallback: "deny", allowedTools: ["mcp:tools:*"] },
    });
    // The runtime loses the session; reopening the key recreates it. A recreate
    // that dropped the policy would hand the caller a differently-permissioned
    // thread under the same durable name.
    runtime.sessions.clear();
    await client.dispose();
    const reopened = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    clients.push(reopened);
    await reopened.threads.open("a");
    const recreated = [...runtime.sessions.values()].at(-1)!.createArgs;
    expect(recreated).toMatchObject({
      instructions: { mode: "replace", text: "You are Ada." },
      requestedCwd: canonicalTmpPath("ade-sdk-recreate-cwd"),
      settingSources: "project",
      permissionMode: "default",
      permissionPolicy: { fallback: "deny", allowedTools: ["mcp:tools:*"] },
    });
  });

  it("names every host-config option a resume ignored", async () => {
    // A resume re-applies what the key was created with. That is the rule, and
    // silence about it let a caller believe an agent was confined to a new
    // directory under a new policy while it ran in the old one under the old.
    const runtime = await startRuntime();
    const home = makeHome();
    const logs: string[] = [];
    const first = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    clients.push(first);
    const oldDir = path.join(os.tmpdir(), "ade-sdk-resume-old");
    await first.threads.open("a", {
      provider: "claude",
      model: "m",
      cwd: oldDir,
      settingSources: "project",
      permissions: { fallback: "ask" },
    });
    await first.dispose();

    const reopened = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
      logger: (line) => logs.push(line),
    } as InternalAdeChatOptions);
    clients.push(reopened);
    const thread = await reopened.threads.open("a", {
      cwd: path.join(os.tmpdir(), "ade-sdk-resume-new"),
      settingSources: "all",
      permissions: { fallback: "deny" },
    });
    expect(thread.key).toBe("a");

    const ignored = logs.filter((line) => line.includes("was ignored"));
    expect(ignored).toHaveLength(3);
    expect(ignored.join("\n")).toContain(`stored cwd (${canonicalTmpPath("ade-sdk-resume-old")})`);
    expect(ignored.join("\n")).toContain("stored settingSources (project)");
    expect(ignored.join("\n")).toContain("stored permissions");
  });

  it("says nothing on a resume that re-supplies the stored values", async () => {
    const runtime = await startRuntime();
    const home = makeHome();
    const logs: string[] = [];
    const dir = path.join(os.tmpdir(), "ade-sdk-resume-same");
    const first = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    clients.push(first);
    await first.threads.open("a", { provider: "claude", model: "m", cwd: dir });
    await first.dispose();

    const reopened = await createAdeChat({
      home,
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
      logger: (line) => logs.push(line),
    } as InternalAdeChatOptions);
    clients.push(reopened);
    await reopened.threads.open("a", { cwd: dir });
    expect(logs.filter((line) => line.includes("was ignored"))).toEqual([]);
  });

  it("re-derives the settingSources verdict after a cross-provider switch", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const thread = await client.threads.open("a", {
      provider: "claude",
      model: "claude-sonnet-4-5",
      settingSources: "project",
    });
    expect(thread.settingSourcesCapability!.level).toBe("applied");
    await thread.setModel("gpt-5-codex");
    // A stale non-silent answer is worse than silence on a surface whose whole
    // contract is honesty: Codex only approximates the setting, and the thread
    // must say so rather than keep reporting Claude's "applied".
    expect(thread.settingSourcesCapability!.level).toBe("best-effort");
  });

  it("recovers a report a first provider never sent, after a switch", async () => {
    // "Did the caller ask for a policy?" and "do we currently hold a report?"
    // are two questions, and they diverge exactly here. Deriving the first from
    // the second made a thread that opened with a live policy — and got no
    // report — unable to ever report one again.
    const runtime = await startRuntime();
    runtime.suppressPermissionCapability = true;
    const client = await connect(runtime);
    const thread = await client.threads.open("a", {
      provider: "claude",
      model: "claude-sonnet-4-5",
      permissions: { fallback: "deny" },
    });
    expect(thread.permissionCapability).toBeNull();

    runtime.suppressPermissionCapability = false;
    await thread.setModel("gpt-5-codex");
    expect(thread.permissionCapability).toMatchObject({ level: "best-effort" });
  });

  it("re-derives the policy verdict after a cross-provider switch", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const thread = await client.threads.open("a", {
      provider: "claude",
      model: "claude-sonnet-4-5",
      permissions: { fallback: "ask" },
    });
    expect(thread.permissionCapability!.level).toBe("enforced");
    await thread.setModel("gpt-5-codex");
    // A thread that landed on Codex must not keep advertising Claude's verdict.
    expect(thread.permissionCapability!.level).toBe("best-effort");
  });
});

describe("approvals", () => {
  const pendingRequest = (itemId: string) => ({
    requestId: `req-${itemId}`,
    itemId,
    source: "codex" as const,
    kind: "approval" as const,
    description: "Run `ls`",
    questions: [],
    allowsFreeform: false,
    blocking: true,
    canProceedWithoutAnswer: false,
    providerMetadata: { command: "ls" },
  });

  it("lists pending approvals through the runtime action", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const thread = await client.threads.open("a", { provider: "codex", model: "m" });
    runtime.pendingInputsBySession.set(thread.id, [pendingRequest("i1")]);

    const pending = await thread.pendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      itemId: "i1",
      kind: "command",
      requestKind: "approval",
      description: "Run `ls`",
      provider: "codex",
    });
  });

  it("maps each decision onto the engine's spelling", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const thread = await client.threads.open("a", { provider: "codex", model: "m" });

    runtime.pendingInputsBySession.set(thread.id, [pendingRequest("i1")]);
    await thread.approve("i1", "accept");
    runtime.pendingInputsBySession.set(thread.id, [pendingRequest("i2")]);
    await thread.approve("i2", "accept_always");
    runtime.pendingInputsBySession.set(thread.id, [pendingRequest("i3")]);
    await thread.approve("i3", "reject", "not this time");

    expect(runtime.approvals.map((entry) => entry.decision)).toEqual([
      "accept",
      "accept_for_session",
      "decline",
    ]);
    expect(runtime.approvals[2]).toMatchObject({ itemId: "i3", responseText: "not this time" });
  });

  it("throws approval_not_found rather than sending a silent no-op", async () => {
    // The engine settles an unknown item silently, so without the pre-check a
    // second click on Allow would resolve as though it worked and the host
    // would wait forever for a turn that is not coming back.
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const thread = await client.threads.open("a", { provider: "codex", model: "m" });
    await expect(thread.approve("gone", "accept")).rejects.toMatchObject({
      name: "AdeError",
      code: "approval_not_found",
    });
    expect(runtime.approvals).toHaveLength(0);
  });

  it("refuses a decision word it cannot map", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const thread = await client.threads.open("a", { provider: "codex", model: "m" });
    await expect(thread.approve("i1", "cancel" as never)).rejects.toMatchObject({
      code: "invalid_option",
    });
    await expect(thread.approve("  ", "accept")).rejects.toMatchObject({ code: "invalid_option" });
  });

  it("enriches the runtime's answer with the kind from the observed event", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const thread = await client.threads.open("a", { provider: "codex", model: "m" });
    runtime.emitChatEvent(thread.id, {
      type: "approval_request",
      itemId: "i1",
      logicalItemId: "L1",
      kind: "file_change",
      description: "Apply a patch",
      requestKind: "approval",
    });
    runtime.pendingInputsBySession.set(thread.id, [pendingRequest("i1")]);
    await waitForAsync(
      async () => (await thread.pendingApprovals())[0]?.kind === "file_change",
      "observed kind to win over the payload inference",
    );
    const [request] = await thread.pendingApprovals();
    // `providerMetadata.command` would have inferred "command"; the engine's own
    // event says file_change, and the event wins.
    expect(request).toMatchObject({ kind: "file_change", logicalItemId: "L1" });
  });

  it("derives pending approvals from events against a runtime with no pendingInputs action", async () => {
    const runtime = await startRuntime({ pendingInputs: false });
    const logs: string[] = [];
    const client = await connect(runtime, { logger: (line) => logs.push(line) });
    const thread = await client.threads.open("a", { provider: "codex", model: "m" });

    runtime.emitChatEvent(thread.id, {
      type: "approval_request",
      itemId: "i1",
      kind: "command",
      description: "Run `ls`",
    });
    await waitForAsync(
      async () => (await thread.pendingApprovals()).length === 1,
      "the derived pending set to see the request",
    );
    expect((await thread.pendingApprovals())[0]).toMatchObject({ itemId: "i1", kind: "command" });
    // Said once, and it names the hole: this path cannot see anything raised
    // before the client connected.
    expect(logs.filter((line) => line.includes("no pendingInputs action"))).toHaveLength(1);

    runtime.emitChatEvent(thread.id, {
      type: "pending_input_resolved",
      itemId: "i1",
      resolution: "accepted",
    });
    await waitForAsync(
      async () => (await thread.pendingApprovals()).length === 0,
      "the resolved request to leave the derived set",
    );
    await expect(thread.approve("i1", "accept")).rejects.toMatchObject({
      code: "approval_not_found",
    });
  });

  it("stops watching the event stream once the thread is disposed", async () => {
    // The constructor's subscription is permanent otherwise: one listener plus
    // one map per distinct thread key opened, for the client's lifetime, with
    // every envelope fanned out to all of them.
    const runtime = await startRuntime({ pendingInputs: false });
    const client = await connect(runtime);
    const thread = await client.threads.open("a", { provider: "codex", model: "m" });

    runtime.emitChatEvent(thread.id, {
      type: "approval_request",
      itemId: "i1",
      kind: "command",
      description: "Run `ls`",
    });
    await waitForAsync(
      async () => (await thread.pendingApprovals()).length === 1,
      "the derived pending set to see the request",
    );

    (thread as unknown as { dispose(): void }).dispose();
    // The map is cleared and nothing new is observed.
    expect(await thread.pendingApprovals()).toHaveLength(0);
    runtime.emitChatEvent(thread.id, {
      type: "approval_request",
      itemId: "i2",
      kind: "command",
      description: "Run `pwd`",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await thread.pendingApprovals()).toHaveLength(0);
    // Idempotent: a second call must not throw.
    (thread as unknown as { dispose(): void }).dispose();
  });

  it("sends the matched request's real itemId when given a logicalItemId", async () => {
    // `logicalItemId` is published as the stable id that groups retries of one
    // action, so a host keys its cards on it. Forwarding it verbatim sent the
    // engine an id it has never seen — and the engine settles unknown items
    // silently, so the call resolved while the turn stayed parked forever.
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const thread = await client.threads.open("a", { provider: "codex", model: "m" });
    runtime.emitChatEvent(thread.id, {
      type: "approval_request",
      itemId: "i1",
      logicalItemId: "L1",
      kind: "command",
      description: "Run `ls`",
      requestKind: "approval",
    });
    runtime.pendingInputsBySession.set(thread.id, [pendingRequest("i1")]);
    await waitForAsync(
      async () => (await thread.pendingApprovals())[0]?.logicalItemId === "L1",
      "the observed logicalItemId to reach the pending set",
    );

    await thread.approve("L1", "accept");
    expect(runtime.approvals).toHaveLength(1);
    expect(runtime.approvals[0]).toMatchObject({ itemId: "i1", decision: "accept" });
  });

  it("refuses to answer a request kind that wants prose, not a verdict", async () => {
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const thread = await client.threads.open("a", { provider: "codex", model: "m" });
    runtime.pendingInputsBySession.set(thread.id, [
      { ...pendingRequest("q1"), kind: "question" as never },
    ]);
    await expect(thread.approve("q1", "accept")).rejects.toMatchObject({
      code: "invalid_option",
    });
    expect(runtime.approvals).toHaveLength(0);
  });

  it("drops a turn's observed approvals when that turn ends", async () => {
    // The engine's Claude teardown resolves every waiter WITHOUT emitting a
    // `pending_input_resolved` receipt, so the derived set kept listing cards
    // the runtime had already answered — and each one passed the pre-check in
    // approve() and then settled nothing.
    const runtime = await startRuntime({ pendingInputs: false });
    const client = await connect(runtime);
    const thread = await client.threads.open("a", { provider: "codex", model: "m" });
    runtime.emitChatEvent(thread.id, {
      type: "approval_request",
      itemId: "i1",
      turnId: "t1",
      kind: "command",
      description: "Run `ls`",
    });
    await waitForAsync(
      async () => (await thread.pendingApprovals()).length === 1,
      "the derived set to see the request",
    );

    runtime.emitChatEvent(thread.id, { type: "done", turnId: "t1" });
    await waitForAsync(
      async () => (await thread.pendingApprovals()).length === 0,
      "the ended turn to clear its approvals",
    );
    await expect(thread.approve("i1", "accept")).rejects.toMatchObject({
      code: "approval_not_found",
    });
  });

  it("keeps a live approval when a mid-turn error arrives, because error does not end a turn", async () => {
    // `error` is not turn-ending in the engine: an OpenCode per-tool failure
    // emits one and keeps streaming the same turn, and the Codex
    // planning-approval guard emits one to decline a single request. Treating
    // it as an ending dropped a LIVE approval out of the derived set, and
    // approve() then threw approval_not_found for a request the runtime was
    // still blocked on — leaving interrupt() as the only exit.
    const runtime = await startRuntime({ pendingInputs: false });
    const client = await connect(runtime);
    const thread = await client.threads.open("a", { provider: "codex", model: "m" });
    runtime.emitChatEvent(thread.id, {
      type: "approval_request",
      itemId: "i1",
      turnId: "t1",
      kind: "command",
      description: "Run `ls`",
    });
    await waitForAsync(
      async () => (await thread.pendingApprovals()).length === 1,
      "the derived set to see the request",
    );

    runtime.emitChatEvent(thread.id, { type: "error", turnId: "t1", message: "one tool failed" });
    // A `done` for the same turn afterwards proves the event was delivered and
    // ordered before this assertion, rather than the set merely not having
    // been touched yet.
    runtime.emitChatEvent(thread.id, {
      type: "approval_request",
      itemId: "i2",
      turnId: "t1",
      kind: "command",
      description: "Run `pwd`",
    });
    await waitForAsync(
      async () => (await thread.pendingApprovals()).length === 2,
      "the second request to reach the derived set after the error",
    );
    expect((await thread.pendingApprovals()).map((request) => request.itemId)).toEqual(["i1", "i2"]);
  });

  it("keeps every approval when a turn-less error arrives", async () => {
    // The sharper case: `emitCodexError` spreads `turnId` conditionally, so a
    // turn-less error is reachable, and a turn-less ENDING drops every approval
    // regardless of turn. An error must not do that.
    const runtime = await startRuntime({ pendingInputs: false });
    const client = await connect(runtime);
    const thread = await client.threads.open("a", { provider: "codex", model: "m" });
    runtime.emitChatEvent(thread.id, {
      type: "approval_request",
      itemId: "i1",
      turnId: "t1",
      kind: "command",
      description: "Run `ls`",
    });
    await waitForAsync(
      async () => (await thread.pendingApprovals()).length === 1,
      "the derived set to see the request",
    );

    runtime.emitChatEvent(thread.id, { type: "error", message: "no turn named" });
    runtime.emitChatEvent(thread.id, {
      type: "approval_request",
      itemId: "i2",
      turnId: "t1",
      kind: "command",
      description: "Run `pwd`",
    });
    await waitForAsync(
      async () => (await thread.pendingApprovals()).length === 2,
      "the second request to reach the derived set after the turn-less error",
    );
  });

  it("leaves another turn's approval pending when one turn ends", async () => {
    const runtime = await startRuntime({ pendingInputs: false });
    const client = await connect(runtime);
    const thread = await client.threads.open("a", { provider: "codex", model: "m" });
    for (const [itemId, turnId] of [["i1", "t1"], ["i2", "t2"]]) {
      runtime.emitChatEvent(thread.id, {
        type: "approval_request",
        itemId,
        turnId,
        kind: "command",
        description: "Run `ls`",
      });
    }
    await waitForAsync(
      async () => (await thread.pendingApprovals()).length === 2,
      "both requests to reach the derived set",
    );

    // `done`, not `error`: only `done` ends a turn. An `error` is emitted
    // mid-turn by OpenCode per-tool failures and by the Codex planning guard,
    // and must leave both approvals live.
    runtime.emitChatEvent(thread.id, { type: "done", turnId: "t1" });
    await waitForAsync(
      async () => (await thread.pendingApprovals()).length === 1,
      "only the ended turn's approval to be dropped",
    );
    expect((await thread.pendingApprovals())[0]).toMatchObject({ itemId: "i2" });
  });

  it("drops every observed approval on an ending that names no turn", async () => {
    const runtime = await startRuntime({ pendingInputs: false });
    const client = await connect(runtime);
    const thread = await client.threads.open("a", { provider: "codex", model: "m" });
    runtime.emitChatEvent(thread.id, {
      type: "approval_request",
      itemId: "i1",
      turnId: "t1",
      kind: "command",
      description: "Run `ls`",
    });
    await waitForAsync(
      async () => (await thread.pendingApprovals()).length === 1,
      "the derived set to see the request",
    );
    // Nothing is left running that could still be waiting on one.
    runtime.emitChatEvent(thread.id, { type: "done" });
    await waitForAsync(
      async () => (await thread.pendingApprovals()).length === 0,
      "an untyped ending to clear everything",
    );
  });

  it("does not deliver another thread's approval into this thread's pending set", async () => {
    const runtime = await startRuntime({ pendingInputs: false });
    const client = await connect(runtime);
    const a = await client.threads.open("a", { provider: "codex", model: "m" });
    const b = await client.threads.open("b", { provider: "codex", model: "m" });
    runtime.emitChatEvent(a.id, {
      type: "approval_request",
      itemId: "i1",
      kind: "command",
      description: "Run `ls`",
    });
    await waitForAsync(
      async () => (await a.pendingApprovals()).length === 1,
      "thread a to see its own approval",
    );
    expect(await b.pendingApprovals()).toEqual([]);
  });
});

describe("providers.status", () => {
  it("probes through the RPC and merges the catalog's model facts", async () => {
    const runtime = await startRuntime({ providersStatus: true });
    const client = await connect(runtime);
    const status = await client.providers.status();
    expect(status.claude).toMatchObject({
      source: "probed",
      installed: true,
      binaryPath: "/usr/local/bin/claude",
      version: "1.0.99 (Claude Code)",
      authenticated: true,
      loginCommand: "claude login",
      modelCount: 2,
      available: true,
    });
    expect(status.codex).toMatchObject({
      source: "probed",
      installed: false,
      binaryPath: null,
      // The distinction the derivation could never draw: installed and logged
      // out looks exactly like not installed when you only have a catalog.
      authenticated: false,
      requiresConfiguration: true,
    });
  });

  it("derives from the catalog against a runtime with no probe, and says so once", async () => {
    const runtime = await startRuntime();
    const logs: string[] = [];
    const client = await connect(runtime, { logger: (line) => logs.push(line) });
    const status = await client.providers.status();
    await client.providers.status();
    expect(status.claude).toMatchObject({
      source: "derived",
      installed: true,
      binaryPath: null,
      version: null,
      installCommand: null,
    });
    expect(logs.filter((line) => line.includes("no providers.status RPC"))).toHaveLength(1);
  });

  it("falls back to the derivation when an advertised probe fails", async () => {
    const runtime = await startRuntime({ providersStatus: true });
    runtime.failProviderStatus = "probe exploded";
    const logs: string[] = [];
    const client = await connect(runtime, { logger: (line) => logs.push(line) });
    const status = await client.providers.status();
    expect(status.claude!.source).toBe("derived");
    expect(logs.some((line) => line.includes("advertised providers.status"))).toBe(true);
    const report = await client.doctor();
    expect(report.recentErrors.some((entry) => entry.scope === "providers.status")).toBe(true);
  });

  it("bypasses the runtime's probe cache only for refresh()", async () => {
    const runtime = await startRuntime({ providersStatus: true });
    const client = await connect(runtime);
    await client.providers.status();
    await client.providers.refresh();
    const probes = runtime.calls
      .filter((call) => call.method === "providers.status")
      .map((call) => (call.params as { refresh?: boolean }).refresh);
    expect(probes).toEqual([false, true]);
  });

  it("notifies onChange when a CLI appears with no catalog change", async () => {
    const runtime = await startRuntime({ providersStatus: true });
    const client = await connect(runtime, { providerPollIntervalMs: 10 });
    const seen: Array<Record<string, unknown>> = [];
    const unsubscribe = client.providers.onChange((status) => seen.push(status));
    await waitFor(() => seen.length === 1, "initial provider snapshot");

    runtime.providerStatusResult = {
      checkedAt: new Date().toISOString(),
      providers: {
        ...runtime.providerStatusResult.providers,
        codex: {
          ...runtime.providerStatusResult.providers.codex,
          installed: true,
          binaryPath: "/usr/local/bin/codex",
          version: "0.50.0",
        },
      },
    };
    await waitFor(() => seen.length === 2, "install detected without a catalog change");
    expect((seen[1] as Record<string, { binaryPath: string | null }>).codex!.binaryPath).toBe(
      "/usr/local/bin/codex",
    );
    unsubscribe();
  });

  it("keeps the poll on the cached probe", async () => {
    const runtime = await startRuntime({ providersStatus: true });
    const client = await connect(runtime, { providerPollIntervalMs: 10 });
    const unsubscribe = client.providers.onChange(() => {});
    await waitFor(
      () => runtime.calls.filter((call) => call.method === "providers.status").length >= 3,
      "several provider polls",
    );
    unsubscribe();
    // A poll that refreshed would spawn `--version` for every provider every
    // 30 seconds for the life of the app.
    expect(
      runtime.calls
        .filter((call) => call.method === "providers.status")
        .every((call) => (call.params as { refresh?: boolean }).refresh === false),
    ).toBe(true);
  });

  it("reports the probed fields through doctor()", async () => {
    const runtime = await startRuntime({ providersStatus: true });
    const client = await connect(runtime);
    const report = await client.doctor();
    expect(report.providers.claude).toMatchObject({ source: "probed", installed: true });
    expect(report.ok).toBe(true);
  });
});

describe("instructions never reach the transcript", () => {
  it("exportThread never carries host instructions as a user message", async () => {
    // The whole point of the option. The workaround it replaces — sending the
    // persona as a hidden first user message — leaks into every export, and an
    // embedder auditing its own transcripts would find its system prompt
    // sitting there as something the user apparently typed.
    const nonce = "NONCE-Zamboni-7";
    const runtime = await startRuntime();
    const client = await connect(runtime);
    const thread = await client.threads.open("leak", {
      provider: "claude",
      model: "m",
      instructions: { mode: "replace", text: nonce },
    });

    // The create args DID carry the text: this test must fail because the
    // instructions leaked, never because they were silently dropped.
    const [session] = [...runtime.sessions.values()];
    expect(session!.createArgs.instructions).toEqual({ mode: "replace", text: nonce });

    await thread.send("What is your name?");
    runtime.emitChatEvent(thread.id, { type: "text", text: "I am Zamboni-7." });

    const jsonl = await client.exportThread("leak");
    const events = jsonl
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { event: { type: string; text?: string } });
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((envelope) => envelope.event.type === "user_message")).toBe(true);
    expect(
      events.some(
        (envelope) =>
          envelope.event.type === "user_message" &&
          typeof envelope.event.text === "string" &&
          envelope.event.text.includes(nonce),
      ),
    ).toBe(false);
  });
});

describe("a deny policy that blocks its own MCP servers", () => {
  const servers = {
    catalog: { type: "http" as const, url: "https://mcp.example/catalog" },
    studio: { type: "http" as const, url: "https://mcp.example/studio" },
  };

  it("names the MCP servers a deny fallback blocks entirely", async () => {
    // Injecting a server and then denying all of it has no symptom: the tools
    // are never called, and the model reports it could not do the thing.
    const runtime = await startRuntime({ mcpServers: true });
    const logs: string[] = [];
    const client = await connect(runtime, { logger: (line) => logs.push(line) });
    await client.threads.open("a", {
      provider: "claude",
      model: "m",
      mcpServers: servers,
      permissions: { fallback: "deny", allowedTools: ["mcp:catalog:*"] },
    });

    const blocked = logs.filter((line) => line.includes("blocks every tool of MCP servers"));
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toContain("studio");
    expect(blocked[0]).not.toContain("catalog");
    // The policy is reported, never widened: the wire still says exactly what
    // the caller asked for.
    const [session] = [...runtime.sessions.values()];
    expect(session!.createArgs.permissionPolicy).toEqual({
      allowedTools: ["mcp:catalog:*"],
      fallback: "deny",
    });
  });

  it("counts autoApproveMcpServers and a single-tool entry as naming the server", async () => {
    const runtime = await startRuntime({ mcpServers: true });
    const logs: string[] = [];
    const client = await connect(runtime, { logger: (line) => logs.push(line) });
    await client.threads.open("a", {
      provider: "claude",
      model: "m",
      mcpServers: servers,
      permissions: {
        fallback: "deny",
        autoApproveMcpServers: ["catalog"],
        allowedTools: ["mcp:studio:render"],
      },
    });
    expect(logs.filter((line) => line.includes("blocks every tool of MCP servers"))).toHaveLength(0);
  });

  it("warns that an individual MCP tool entry admits the whole server on Claude", async () => {
    const runtime = await startRuntime({ mcpServers: true });
    const logs: string[] = [];
    const client = await connect(runtime, { logger: (line) => logs.push(line) });
    await client.threads.open("a", {
      provider: "claude",
      model: "m",
      mcpServers: servers,
      permissions: {
        fallback: "deny",
        allowedTools: ["mcp:catalog:search", "mcp:studio:*", "Read"],
      },
    });
    const granularity = logs.filter((line) => line.includes("admits the whole server"));
    expect(granularity).toHaveLength(1);
    expect(granularity[0]).toContain("mcp:catalog:search");
    // A whole-server entry and a built-in name are not tool-level entries.
    expect(granularity[0]).not.toContain("mcp:studio:*");
    expect(granularity[0]).not.toContain("Read");
  });

  it("says nothing when the policy covers every server at server granularity", async () => {
    const runtime = await startRuntime({ mcpServers: true });
    const logs: string[] = [];
    const client = await connect(runtime, { logger: (line) => logs.push(line) });
    await client.threads.open("a", {
      provider: "claude",
      model: "m",
      mcpServers: servers,
      permissions: { fallback: "deny", allowedTools: ["mcp:catalog:*", "mcp:studio:*"] },
    });
    expect(logs.filter((line) => line.includes("blocks every tool of MCP servers"))).toHaveLength(0);
    expect(logs.filter((line) => line.includes("admits the whole server"))).toHaveLength(0);
  });

  it("says nothing under fallback ask, where an unnamed server is asked about", async () => {
    // Neither warning applies: nothing is refused outright, so an unnamed
    // server raises an approval rather than silently doing nothing.
    const runtime = await startRuntime({ mcpServers: true });
    const logs: string[] = [];
    const client = await connect(runtime, { logger: (line) => logs.push(line) });
    await client.threads.open("a", {
      provider: "claude",
      model: "m",
      mcpServers: servers,
      permissions: { fallback: "ask", allowedTools: ["mcp:catalog:search"] },
    });
    expect(logs.filter((line) => line.includes("blocks every tool of MCP servers"))).toHaveLength(0);
    expect(logs.filter((line) => line.includes("admits the whole server"))).toHaveLength(0);
  });
});

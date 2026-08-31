import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdeChat, type InternalAdeChatOptions } from "../src/client.js";
import type { AdeChatClient } from "../src/client.js";
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

  it("treats an empty mcpServers map as no MCP request at all (A3-1)", async () => {
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

  it("does not warn on a delivery-only thread the runtime never reports on (A3-2)", async () => {
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

  it("keeps the provider's real level on a delivery-only thread (A3-2)", async () => {
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
});

describe("event stream liveness (A15)", () => {
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

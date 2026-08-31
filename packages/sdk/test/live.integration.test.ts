import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdeChat, type InternalAdeChatOptions } from "../src/client.js";
import type { AdeChatClient } from "../src/client.js";
import { JsonRpcConnection } from "../src/jsonRpc.js";
import { startSidecar, type Sidecar } from "../src/sidecar.js";
import { resolveRuntimeSocketPath } from "../src/socketPath.js";
import type { AdeInitializeResult, PersonalChatCallResponse } from "../src/types.js";

/**
 * Live wire-contract test. Opt-in: set `ADE_SDK_LIVE_BINARY` to an `ade`
 * binary (or a shim that execs one) and this boots a real runtime against a
 * throwaway ADE_HOME.
 *
 *   ADE_SDK_LIVE_BINARY=/path/to/ade npx vitest run test/live.integration.test.ts
 *
 * WHY THIS EXISTS. The mock server in `mockRuntime.ts` answers whatever shape
 * the SDK expects, so it can only ever prove the SDK is self-consistent. It
 * cannot catch a field that the runtime persists but never puts on the wire —
 * and that is exactly the bug this file was written for: `mcpCapability` was
 * added to the chat service's persisted-state builder but not to
 * `summarizeSessionRow`, so `create`/`getSummary`/`list` all returned a summary
 * with no MCP report at all. Every engine-side test was green because they
 * asserted on `createSession`'s live return value rather than on the summary
 * that external callers actually receive.
 *
 * The load-bearing assertion is therefore the RAW KEY DUMP below, taken from a
 * second connection that bypasses the SDK entirely. It pins the summary field
 * set as a contract. The next field that gets added to persistence and
 * forgotten in the summary builder fails here.
 *
 * Deliberately not part of `npm test`: it needs a built runtime and boots a
 * real brain, so the default suite stays hermetic and sub-two-second.
 */

const LIVE_BINARY = process.env.ADE_SDK_LIVE_BINARY?.trim();
const BOOT_TIMEOUT_MS = 120_000;

/** Fields the SDK reads off a session summary. Absence of any is a regression. */
const REQUIRED_SUMMARY_FIELDS = [
  "sessionId",
  "provider",
  "model",
  "status",
  "startedAt",
  "lastActivityAt",
] as const;

describe.skipIf(!LIVE_BINARY)("live runtime wire contract", () => {
  let home: string;
  let client: AdeChatClient;
  let raw: JsonRpcConnection;
  let model: string;
  let initialize: AdeInitializeResult;

  /** Raw `personalChats.call`, bypassing the SDK's own unwrapping and typing. */
  const rawCall = async <T>(action: string, args: unknown): Promise<T> => {
    const response = await raw.request<PersonalChatCallResponse<T>>(
      "personalChats.call",
      { action, args },
      { timeoutMs: 120_000 },
    );
    return response.result;
  };

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sdk-live-"));
    client = await createAdeChat({
      home,
      binaryPath: LIVE_BINARY,
      logger: () => {},
      startupTimeoutMs: BOOT_TIMEOUT_MS,
    } as InternalAdeChatOptions);

    const report = await client.doctor();
    raw = await JsonRpcConnection.connect(report.socket.path);
    initialize = await raw.request<AdeInitializeResult>("ade/initialize", {
      protocolVersion: "2025-06-18",
      clientName: "ade-sdk-wire-probe",
      identity: { role: "cto", callerId: "ade-sdk-wire-probe" },
    });
    await raw.request("ade/initialized");

    const available = (await client.models.list()).filter((entry) => entry.isAvailable);
    const claude = available.find((entry) => entry.provider === "claude");
    model = (claude ?? available[0])!.id;
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    raw?.close();
    await client?.dispose().catch(() => {});
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  it("boots the embedded profile and advertises the personal chat capabilities", () => {
    const capabilities = initialize.capabilities?.personalChats;
    expect(capabilities).toBeDefined();
    expect(capabilities!.actions.length).toBeGreaterThan(0);
    // These two drive transport and MCP selection in `createAdeChat`. A runtime
    // that stops advertising them silently downgrades every SDK consumer.
    expect(capabilities!.pushEvents).toBe(true);
    expect(capabilities!.mcpServers).toBe(true);
  });

  it("selects the push transport against a real runtime", async () => {
    const report = await client.doctor();
    expect(report.events.mode).toBe("push");
    expect(report.socket.connected).toBe(true);
  });

  it("puts every field the SDK reads on the raw create summary", async () => {
    const summary = await rawCall<Record<string, unknown>>("create", {
      provider: "claude",
      model,
      title: "wire contract",
    });
    for (const field of REQUIRED_SUMMARY_FIELDS) {
      expect(summary, `summary is missing "${field}"`).toHaveProperty(field);
    }
  });

  it("carries the MCP report on create, getSummary AND list — not just in persisted state", async () => {
    // The exact regression this file exists for. `create` returning the report
    // is not enough: `getSummary` and `list` are separate read paths and a
    // resumed thread goes through them, so all three are asserted.
    const created = await rawCall<Record<string, unknown>>("create", {
      provider: "claude",
      model,
      title: "wire contract mcp",
      mcpServers: { probe: { type: "stdio", command: "echo", args: ["hi"] } },
      strictMcpConfig: true,
    });
    const sessionId = String(created.sessionId);

    expect(created.mcpCapability, "create summary dropped mcpCapability").toBeDefined();
    expect(created.mcpServers, "create summary dropped mcpServers").toBeDefined();
    expect(created.strictMcpConfig).toBe(true);
    expect(created.mcpCapability).toMatchObject({ level: "enforced", delivered: true });

    const fetched = await rawCall<Record<string, unknown>>("getSummary", { sessionId });
    expect(fetched.mcpCapability, "getSummary dropped mcpCapability").toBeDefined();

    const listed = await rawCall<Array<Record<string, unknown>>>("list", {});
    const row = listed.find((entry) => entry.sessionId === sessionId);
    expect(row, "list did not return the created session").toBeDefined();
    expect(row!.mcpCapability, "list dropped mcpCapability").toBeDefined();
  });

  it("reports a strict-only request as enforced and delivered", async () => {
    // Strict mode with NO servers of the caller's own — "isolate this chat from
    // the user's MCP". It is a success, and an earlier engine build reported it
    // with `delivered: false`, which made `!delivered` read a working isolation
    // request as a dropped one. Pinned here so it cannot silently come back.
    const summary = await rawCall<Record<string, unknown>>("create", {
      provider: "claude",
      model,
      title: "wire contract strict-only",
      strictMcpConfig: true,
    });
    expect(summary.strictMcpConfig).toBe(true);
    expect(summary.mcpCapability).toMatchObject({ level: "enforced", delivered: true });
  });

  it("omits the MCP fields entirely when the caller asked for nothing", async () => {
    // An absent report is a signal the SDK relies on. If these keys start
    // showing up unconditionally, "null means nothing was requested" breaks.
    const summary = await rawCall<Record<string, unknown>>("create", {
      provider: "claude",
      model,
      title: "wire contract plain",
    });
    expect(summary).not.toHaveProperty("mcpCapability");
    expect(summary).not.toHaveProperty("mcpServers");
    expect(summary).not.toHaveProperty("strictMcpConfig");
  });

  it("refuses injected MCP servers on a provider with no MCP surface", async () => {
    // Must be an error, not a silently tool-less chat.
    await expect(
      rawCall("create", {
        provider: "pi",
        model,
        mcpServers: { probe: { type: "stdio", command: "echo" } },
      }),
    ).rejects.toThrow(/pi/i);
  });

  it("surfaces the capability through the public thread API on create and on resume", async () => {
    const thread = await client.threads.open("live-mcp", {
      provider: "claude",
      model,
      mcpServers: { probe: { type: "stdio", command: "echo", args: ["hi"] } },
    });
    expect(thread.mcpCapability).toMatchObject({ level: "enforced", delivered: true });

    // A second client over the same home must resume the session AND rebuild
    // the same guarantee — a resumed thread reporting null would silently
    // downgrade what the embedder tells its users.
    //
    // It ATTACHES to the running runtime rather than spawning a second one:
    // two brains over one ADE_HOME would contend for the same SQLite state
    // root. Attaching still exercises the whole resume path — a cold
    // ThreadStore read, then `getSummary` — which is where the capability
    // report has to survive.
    const report = await client.doctor();
    const second = await createAdeChat({
      home,
      attach: true,
      socketPath: report.socket.path,
      logger: () => {},
    } as InternalAdeChatOptions);
    try {
      const resumed = await second.threads.open("live-mcp", { provider: "claude", model });
      expect(resumed.id).toBe(thread.id);
      expect(resumed.mcpCapability).toMatchObject({ level: "enforced", delivered: true });
    } finally {
      await second.dispose();
    }
  }, BOOT_TIMEOUT_MS);
});

/**
 * The embedded profile must not carry machine-lifecycle authority.
 *
 * `runServe` omits `machineUpdateControls` and `reportMachinePowerTransition`
 * when the profile is "embedded", so a guest runtime inside somebody else's
 * process cannot update-and-restart the MACHINE's ADE. That wiring is a spread
 * inside a 900-line function: no unit test reaches it and typecheck cannot see
 * it, which is exactly the gap this boots a real runtime to close.
 *
 * WHY THIS RUNS WITH ADE_DEFAULT_ROLE=cto. Both handlers check the caller's
 * role BEFORE they check whether the controls exist, and an SDK-spawned runtime
 * defaults to the "agent" role. Booted normally, the refusal would come from
 * the role gate and this test would pass without the profile wiring existing at
 * all — the precise "invariant lives in the role default, not the profile"
 * failure the finding described. Raising the role to cto removes that gate so
 * the only thing left to refuse is the missing controls, and the assertions
 * below explicitly reject the role-gate message.
 */
describe.skipIf(!LIVE_BINARY)("embedded profile has no machine authority", () => {
  let home: string;
  let sidecar: Sidecar;
  let raw: JsonRpcConnection;

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sdk-live-embed-"));
    const socketPath = resolveRuntimeSocketPath(home);
    // Spawned through `startSidecar` rather than `createAdeChat` so the role
    // can be passed EXPLICITLY. Mutating `process.env` in a hook and relying on
    // it reaching the child does not survive vitest's environment handling —
    // and an explicit env is the better test regardless: no global mutation,
    // nothing for a parallel test to observe or clobber.
    sidecar = await startSidecar({
      binaryPath: LIVE_BINARY!,
      runtimeRoot: null,
      socketPath,
      home,
      logger: () => {},
      // `startSidecar` scrubs ADE_* out of the inherited environment and PINS
      // the role, so setting it via `env` would be silently overridden — that
      // scrubbing is deliberate hardening, not something to work around. This
      // is the supported knob.
      adeDefaultRole: "cto",
      startupTimeoutMs: BOOT_TIMEOUT_MS,
    });
    raw = await JsonRpcConnection.connect(socketPath);
    await raw.request<AdeInitializeResult>("ade/initialize", {
      protocolVersion: "2025-06-18",
      clientName: "ade-sdk-embedded-authority-probe",
      identity: { role: "cto", callerId: "ade-sdk-embedded-authority-probe" },
    });
    await raw.request("ade/initialized");
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    raw?.close();
    await sidecar?.stop().catch(() => {});
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  it("refuses machine.updateAndRestart because the profile withheld the controls", async () => {
    let message = "";
    try {
      await raw.request("machine.updateAndRestart", {}, { timeoutMs: 30_000 });
      throw new Error("machine.updateAndRestart was accepted by an embedded runtime");
    } catch (error) {
      message = (error as Error).message;
    }
    // The refusal must come from the ABSENT CONTROLS, not the role gate. Both
    // handlers check the role FIRST, so a runtime booted at the default "agent"
    // role refuses either way and this test would pass with no profile wiring
    // at all — the exact "invariant lives in the role default, not the profile"
    // failure the finding described. Hence cto above, and this second
    // assertion, which is what makes the test discriminating.
    expect(message).toMatch(/cannot update itself/i);
    expect(message).not.toMatch(/requires the cto role/i);
  }, BOOT_TIMEOUT_MS);

  it("reports machine power transitions as unsupported", async () => {
    // Same wiring, quieter contract: this one answers rather than throwing.
    // `accepted: false` tells a desktop peer to keep retrying elsewhere instead
    // of believing this runtime recorded the transition.
    //
    // NOT a regression guard, and verified as such: with the profile trim
    // reverted this assertion still passes, because a headless reporter answers
    // `accepted: false` regardless of whether it was wired. The
    // updateAndRestart test above is the one that actually fails when the
    // wiring goes away. This documents the contract; do not read it as cover.
    const outcome = await raw.request<{ accepted: boolean; reason?: string }>(
      "machine.reportPowerTransition",
      { kind: "suspend" },
      { timeoutMs: 30_000 },
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe("unsupported");
  }, BOOT_TIMEOUT_MS);

  it("still serves personal chats — the trim is machine authority only", async () => {
    // The profile must remove machine-lifecycle power WITHOUT removing the
    // capability it exists to provide. A trim that broke chats would otherwise
    // look identical to a trim that worked.
    const initialize = await raw.request<AdeInitializeResult>("ade/initialize", {
      protocolVersion: "2025-06-18",
      clientName: "ade-sdk-embedded-authority-probe",
      identity: { role: "cto", callerId: "ade-sdk-embedded-authority-probe" },
    });
    expect(initialize.capabilities?.personalChats?.actions.length).toBeGreaterThan(0);
    const listed = await raw.request<{ result?: unknown }>(
      "personalChats.call",
      { action: "list", args: {} },
      { timeoutMs: 60_000 },
    );
    expect(listed).toBeTruthy();
  }, BOOT_TIMEOUT_MS);
});

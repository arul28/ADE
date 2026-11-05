import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseCodedErrorMessage } from "../../../../desktop/src/shared/codedError";
import { createMachineConnectionPool, MachineCallTimeoutError } from "./machineBridge";

// The network boundary only: the account, its directory, and opening a paired
// connection, which here is an in-memory pipe into a host whose `ping` answers
// can be switched off, like a relay socket that went half-open.
const host = vi.hoisted(() => ({ answersPing: true, opened: 0, pings: 0 }));

vi.mock("./sharedAccountAuthService", async (importActual) => ({
  ...(await importActual<typeof import("./sharedAccountAuthService")>()),
  getSharedAccountAuthService: () => ({
    getStatus: () => ({ signedIn: true, userId: "user-1", source: "loopback" }),
    getAccessToken: async () => "token",
  }),
  getSharedAccountDirectoryBaseUrl: () => "https://directory.invalid",
}));

vi.mock("./accountMachineDirectoryService", async (importActual) => ({
  ...(await importActual<typeof import("./accountMachineDirectoryService")>()),
  AccountMachineDirectoryService: class {
    async listMachines() { return { state: "ok", machines: [] }; }
    async pairListedMachine() {}
  },
}));

vi.mock("./pairedRemoteConnector", async () => {
  const { startJsonRpcServer } = await import("../../jsonrpc");
  return {
    openPairedCandidate: async (args: { acceptTransport: (transport: unknown) => Promise<unknown> }) => {
      host.opened += 1;
      const toServer = new PassThrough();
      const toClient = new PassThrough();
      startJsonRpcServer(async (request) => {
        const method = String(request.method ?? "");
        if (method === "ade/initialize") return { runtimeInfo: { multiProject: true }, capabilities: { projects: true } };
        if (method === "ade/initialized") return null;
        if (method === "ping") {
          host.pings += 1;
          return host.answersPing ? "pong" : new Promise(() => {});
        }
        // Every other call is busy work that outlives the caller's deadline.
        return new Promise(() => {});
      }, {
        onData: (cb) => toServer.on("data", cb),
        write: (data) => { toClient.write(data); },
        close: () => { toClient.end(); },
      });
      return {
        value: await args.acceptTransport({
          onData: (cb: (chunk: Buffer) => void) => toClient.on("data", cb),
          write: (data: string) => { toServer.write(data); },
          close: () => { toServer.end(); },
        }),
      };
    },
  };
});

describe("machine connection action responses", () => {
  it("preserves a definitive destination refusal code", () => {
    const bridge = createMachineConnectionPool({
      poolId: "machine-bridge-return-refusal-test",
      pairedStoreFile: "unused-test-store.json",
      deviceName: () => "ADE agents test",
      initializeParams: () => ({}),
      appVersion: "test",
      projectRoots: () => [],
      who: "agents",
      requestNoun: "chat actions",
      logPrefix: "machine_bridge_test",
    });
    let refusal: unknown;
    try {
      bridge.checkActionResponse("Mac mini", "chat.acceptCrossMachineHandoff", {
        ok: false,
        error: {
          code: "cross_machine_return_refused",
          message: "The original chat stays as it is.",
        },
      }, "machine-b");
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).toMatchObject({ code: "cross_machine_return_refused" });
    expect(parseCodedErrorMessage(refusal)).toEqual({
      code: "cross_machine_return_refused",
      message: "Mac mini refused chat.acceptCrossMachineHandoff: The original chat stays as it is.",
    });
  });
});

describe("pooled machine connection liveness", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-machine-bridge-"));
  const previousHome = process.env.ADE_HOME;
  beforeAll(() => { process.env.ADE_HOME = home; });
  afterAll(() => {
    if (previousHome == null) delete process.env.ADE_HOME;
    else process.env.ADE_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it.each([
    ["a silent link (never closes, answers nothing) is dropped and the next call redials", false],
    ["a slow host that still answers ping keeps its link", true],
  ] as const)("after a call times out, %s", async (label, answersPing) => {
    // Streams stay real; only the clocks move.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      host.answersPing = answersPing;
      host.opened = 0;
      host.pings = 0;
      const pool = createMachineConnectionPool({
        poolId: `machine-bridge-liveness-${answersPing ? "slow" : "silent"}`,
        pairedStoreFile: "liveness-test-store.json",
        deviceName: () => "ADE agents test",
        initializeParams: () => ({}),
        appVersion: "test",
        projectRoots: () => [],
        who: "agents",
        requestNoun: "chat actions",
        logPrefix: "machine_bridge_test",
      });
      const machine = {
        machineKey: "machine-b",
        deviceId: "device-b",
        name: "Mac mini",
        online: true,
        platform: "darwin",
        lastSeenAt: Date.now(),
      } as Parameters<typeof pool.acquire>[0];

      const first = await pool.acquire(machine);
      expect(host.opened).toBe(1);
      // Longer than the recent-traffic window, so only a ping can vouch for the link.
      const call = pool.request(machine, first, "busy.call", "busy.call", {}, 20_000);
      const outcome = call.then(() => null, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20_000);
      // Past the liveness ping's own deadline.
      await vi.advanceTimersByTimeAsync(16_000);

      expect(await outcome, label).toBeInstanceOf(MachineCallTimeoutError);
      expect(host.pings).toBeGreaterThan(0);
      expect(first.client.isClosed()).toBe(!answersPing);
      expect(pool.hasLiveConnection("machine-b")).toBe(answersPing);

      const next = await pool.acquire(machine);
      expect(next === first).toBe(answersPing);
      expect(host.opened).toBe(answersPing ? 1 : 2);
      expect(next.client.isClosed()).toBe(false);
      pool.dropConnection("device-b", next);
    } finally {
      vi.useRealTimers();
    }
  });
});

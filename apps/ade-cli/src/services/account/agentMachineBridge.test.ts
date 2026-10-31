import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The network boundary only: the account directory, the account token, and
// opening a paired connection, which here is an in-memory pipe into a target
// that records what it was sent.
const target = vi.hoisted(() => ({
  received: [] as Array<{ method: string; params: Record<string, unknown> }>,
  externalWakeNotices: false,
}));

vi.mock("./sharedAccountAuthService", async (importActual) => ({
  ...(await importActual<typeof import("./sharedAccountAuthService")>()),
  getSharedAccountAuthService: () => ({
    getStatus: () => ({ signedIn: true, userId: "user-1", source: "loopback" }),
    getAccessToken: async () => "token",
  }),
  getSharedAccountDirectoryBaseUrl: () => "https://directory.invalid",
}));

vi.mock("./accountAuthService", async (importActual) => ({
  ...(await importActual<typeof import("./accountAuthService")>()),
  getSignedInAccountAccessToken: async () => "token",
}));

vi.mock("./accountMachineDirectoryService", async (importActual) => ({
  ...(await importActual<typeof import("./accountMachineDirectoryService")>()),
  AccountMachineDirectoryService: class {
    async listMachines() {
      return {
        state: "ok",
        machines: [
          {
            machineKey: "machine-b",
            deviceId: "device-b",
            name: "Mac mini",
            online: true,
            platform: "darwin",
            lastSeenAt: Date.now(),
          },
          {
            machineKey: "machine-new",
            deviceId: "device-new",
            name: "New brain",
            online: true,
            platform: "darwin",
            lastSeenAt: Date.now(),
          },
          {
            machineKey: "machine-old",
            deviceId: "device-old",
            name: "Old brain",
            online: true,
            platform: "darwin",
            lastSeenAt: Date.now(),
          },
        ],
      };
    }
    async pairListedMachine() {}
  },
}));

vi.mock("./pairedRemoteConnector", async () => {
  const { startJsonRpcServer } = await import("../../jsonrpc");
  return {
    openPairedCandidate: async (args: { acceptTransport: (transport: unknown) => Promise<unknown> }) => {
      const toServer = new PassThrough();
      const toClient = new PassThrough();
      startJsonRpcServer(async (request) => {
        const method = String(request.method ?? "");
        const params = (request.params ?? {}) as Record<string, unknown>;
        if (method === "ade/initialize") {
          return {
            runtimeInfo: { multiProject: true },
            capabilities: {
              projects: true,
              agentRemoteCallers: true,
              ...(target.externalWakeNotices ? { externalWakeNotices: true } : {}),
            },
          };
        }
        if (method === "ade/initialized") return null;
        target.received.push({ method, params });
        if (method === "machines.deliverWake") return "delivered";
        if (method === "projects.list") {
          return [{ projectId: "project-b", rootPath: "/srv/repo", displayName: "repo", gitOriginUrl: "https://github.com/example/repo.git" }];
        }
        return { domain: "chat", action: "createSession", result: { id: "child-1" } };
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

describe("agent machine bridge", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-agent-bridge-"));
  const previousHome = process.env.ADE_HOME;
  beforeAll(() => { process.env.ADE_HOME = home; });
  afterAll(() => {
    if (previousHome == null) delete process.env.ADE_HOME;
    else process.env.ADE_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it.each([
    ["a child-creating request carries the wake token", "wake-token-1"],
    ["a caller that sends no token forwards none", null],
  ] as const)("forwards the caller's claim to the target: %s", async (_label, wakeToken) => {
    const { createAgentMachineBridge } = await import("./agentMachineBridge");
    const bridge = createAgentMachineBridge({ appVersion: "test", projectRoots: () => [] });
    target.received.length = 0;

    const answer = await bridge.call({
      machine: "Mac mini",
      scope: { kind: "repo", originUrl: "git@github.com:example/repo.git" },
      method: "ade/actions/call",
      params: { name: "run_ade_action", arguments: { domain: "chat", action: "createSession", args: {} } },
      caller: { chatSessionId: "chat-a", permissionLevel: "full-auto", ...(wakeToken ? { wakeToken } : {}) },
    });

    const forwarded = target.received.find((entry) => entry.method === "ade/actions/call");
    expect(forwarded?.params.projectId).toBe("project-b");
    expect(forwarded?.params.remoteCaller).toMatchObject({ chatSessionId: "chat-a", permissionLevel: "full-auto" });
    if (wakeToken) expect(forwarded?.params.remoteCaller).toMatchObject({ wakeToken });
    else expect(forwarded?.params.remoteCaller).not.toHaveProperty("wakeToken");
    expect(answer.machine).toEqual({ machineKey: "machine-b", name: "Mac mini", platform: "darwin" });
  });

  it("refuses a secret-bearing action before anything is sent", async () => {
    const { createAgentMachineBridge } = await import("./agentMachineBridge");
    const bridge = createAgentMachineBridge({ appVersion: "test", projectRoots: () => [] });
    target.received.length = 0;
    await expect(bridge.call({
      machine: "Mac mini",
      scope: { kind: "repo", originUrl: "git@github.com:example/repo.git" },
      method: "ade/actions/call",
      params: { name: "run_ade_action", arguments: { domain: "account_vault", action: "get", args: {} } },
      caller: { chatSessionId: "chat-a" },
    })).rejects.toThrow(/returns secrets/);
    expect(target.received).toHaveLength(0);
  });

  // A notice ("the child waits on the user") is not a finished turn: a brain
  // older than the field would file it as one and close the parent's card. A
  // target advertises the capability in its handshake; an older one gets
  // nothing at all, and the sender still counts it delivered so the outbox
  // does not retry a notice that can never be understood.
  it("sends an awaiting-user notice only to a brain that advertises it", async () => {
    const { createAgentMachineBridge } = await import("./agentMachineBridge");
    const bridge = createAgentMachineBridge({ appVersion: "test", projectRoots: () => [] });
    const notice = {
      parentChatSessionId: "chat-a",
      wakeToken: "wake-token-1",
      wake: { childSessionId: "child-1", notice: "awaiting_user" },
    };
    const delivered = () => target.received.filter((entry) => entry.method === "machines.deliverWake");
    target.received.length = 0;

    target.externalWakeNotices = true;
    expect(await bridge.deliverWake("machine-new", notice)).toBe("delivered");
    expect(delivered()).toHaveLength(1);

    // A different machine key, so this is its own handshake and not the one
    // connection above (the pool keeps one connection per machine).
    target.externalWakeNotices = false;
    expect(await bridge.deliverWake("machine-old", notice)).toBe("delivered");
    expect(delivered()).toHaveLength(1);
  });
});

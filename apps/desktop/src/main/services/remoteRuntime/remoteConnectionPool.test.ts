import type { Client } from "ssh2";
import net from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RemoteRuntimeConnectResult,
  RemoteRuntimeTarget,
} from "../../../shared/types/remoteRuntime";
import type { RuntimeRpcClient } from "./runtimeRpcClient";
import type { RemoteTargetRegistry } from "./remoteTargetRegistry";

const bootstrapRemoteRuntimeMock = vi.hoisted(() => vi.fn());
const bootstrapPairedRuntimeMock = vi.hoisted(() => vi.fn());
const ensureRemoteProjectMock = vi.hoisted(() => vi.fn());
const getSshHostKeyTrustForTargetMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/mock/app",
  },
}));

vi.mock("./remoteBootstrap", () => ({
  bootstrapRemoteRuntime: bootstrapRemoteRuntimeMock,
  ensureRemoteProject: ensureRemoteProjectMock,
}));

vi.mock("./pairedRuntimeBootstrap", () => ({
  bootstrapPairedRuntime: bootstrapPairedRuntimeMock,
}));

vi.mock("./sshTransport", () => ({
  getSshHostKeyTrustForTarget: getSshHostKeyTrustForTargetMock,
}));

import { RemoteConnectionPool } from "./remoteConnectionPool";
import {
  PairedRuntimeCompatibilityError,
  PairedRuntimeRelayAuthRequiredError,
  PairedRuntimeTransportUnavailableError,
} from "./pairedRuntimeErrors";

type DisconnectListener = (error: Error) => void;

type FakeRuntimeRpcClient = RuntimeRpcClient & {
  call: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  emitDisconnect(error?: Error): void;
  emitNotification(method: string, params: unknown): void;
  onDisconnect: ReturnType<typeof vi.fn>;
  onNotification: ReturnType<typeof vi.fn>;
};

type SshListener = (...args: unknown[]) => void;

type FakeSshClient = Client & {
  emitOnce(event: "close" | "error", ...args: unknown[]): void;
  destroy: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  forwardOut: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
};

const target: RemoteRuntimeTarget = {
  id: "target-1",
  name: "Remote",
  hostname: "remote.example.test",
  sshUser: "ade",
  port: 22,
  sshKeyPath: null,
  lastSeenArch: null,
  runtimeBinaryVersion: null,
  lastConnectedAt: null,
};

const pairedTarget: RemoteRuntimeTarget = {
  ...target,
  id: "paired-target-1",
  transport: "paired",
  pairedMachine: {
    hostIdentity: "host-1",
    machineKey: "machine-1",
  },
  sshUser: null,
  routes: [{
    hostname: "studio.local",
    port: 22,
    source: "manual",
    lastSucceededAt: null,
  }],
};

function connectResult(version: string): RemoteRuntimeConnectResult {
  return {
    target,
    arch: "linux-x64",
    version,
    capabilities: {
      projects: true,
      machineProjects: {
        browseDirectories: true,
        getDetail: true,
        getWorkSummary: true,
        getDefaultParentDir: true,
        create: true,
        clone: true,
        listMyGitHubRepos: true,
      },
    },
    projects: [],
  };
}

function createClient(): FakeRuntimeRpcClient {
  const listeners = new Set<DisconnectListener>();
  const notificationListeners = new Map<
    string,
    Set<(params: unknown) => void>
  >();
  const client = {
    call: vi.fn(),
    close: vi.fn(() => {
      for (const listener of [...listeners]) {
        listener(new Error("closed"));
      }
    }),
    onDisconnect: vi.fn((callback: DisconnectListener) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    }),
    onNotification: vi.fn(
      (method: string, callback: (params: unknown) => void) => {
        const existing =
          notificationListeners.get(method) ??
          new Set<(params: unknown) => void>();
        existing.add(callback);
        notificationListeners.set(method, existing);
        return () => {
          existing.delete(callback);
          if (existing.size === 0) {
            notificationListeners.delete(method);
          }
        };
      },
    ),
    emitDisconnect(error = new Error("lost")) {
      for (const listener of [...listeners]) {
        listener(error);
      }
    },
    emitNotification(method: string, params: unknown) {
      for (const listener of [...(notificationListeners.get(method) ?? [])]) {
        listener(params);
      }
    },
  };
  return client as unknown as FakeRuntimeRpcClient;
}

function createSsh(): FakeSshClient {
  const listeners = new Map<string, SshListener[]>();
  const fake = {} as {
    emitOnce?: FakeSshClient["emitOnce"];
    destroy?: ReturnType<typeof vi.fn>;
    end?: ReturnType<typeof vi.fn>;
    forwardOut?: ReturnType<typeof vi.fn>;
    once?: ReturnType<typeof vi.fn>;
  };
  fake.destroy = vi.fn();
  fake.end = vi.fn();
  fake.forwardOut = vi.fn((
    _sourceHost: string,
    _sourcePort: number,
    destinationHost: string,
    destinationPort: number,
    callback: (error: Error | undefined, stream?: net.Socket) => void,
  ) => {
    const stream = net.createConnection({ host: destinationHost, port: destinationPort });
    stream.once("connect", () => callback(undefined, stream));
    stream.once("error", (error) => callback(error));
  });
  fake.once = vi.fn((event: string, callback: SshListener): FakeSshClient => {
    const existing = listeners.get(event) ?? [];
    existing.push(callback);
    listeners.set(event, existing);
    return fake as unknown as FakeSshClient;
  });
  fake.emitOnce = (event: "close" | "error", ...args: unknown[]): void => {
    const callbacks = listeners.get(event) ?? [];
    listeners.delete(event);
    for (const callback of callbacks) {
      callback(...args);
    }
  };
  return fake as unknown as FakeSshClient;
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("server did not bind to a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

describe("RemoteConnectionPool", () => {
  beforeEach(() => {
    bootstrapRemoteRuntimeMock.mockReset();
    bootstrapPairedRuntimeMock.mockReset();
    ensureRemoteProjectMock.mockReset();
    getSshHostKeyTrustForTargetMock.mockReset();
    getSshHostKeyTrustForTargetMock.mockResolvedValue({ state: "trusted" });
  });

  it("uses and disposes a port-forward client on the paired transport connection", async () => {
    const client = createClient();
    const ensureForward = vi.fn(async () => ({
      remoteHost: "127.0.0.1",
      remotePort: 4173,
      localHost: "127.0.0.1" as const,
      localPort: 43111,
      localUrl: "http://127.0.0.1:43111",
      createdAt: 10,
      lastUsedAt: 11,
    }));
    const dispose = vi.fn();
    bootstrapPairedRuntimeMock.mockResolvedValueOnce({
      client,
      transport: { connection: { endpoint: "ws://studio.local:8787/" } },
      portForwardClient: { ensureForward, dispose },
      result: {
        ...connectResult("1.0.0"),
        target: pairedTarget,
        route: {
          kind: "lan",
          endpoint: "ws://studio.local:8787/",
          latencyMs: 2,
        },
      },
    });

    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");
    await pool.connect(pairedTarget);
    await expect(pool.ensureLocalPortForward(pairedTarget.id, {
      remotePort: 4173,
      label: "Preview",
    })).resolves.toEqual({
      targetId: pairedTarget.id,
      remoteHost: "127.0.0.1",
      remotePort: 4173,
      localHost: "127.0.0.1",
      localPort: 43111,
      localUrl: "http://127.0.0.1:43111",
      label: "Preview",
      createdAt: 10,
      lastUsedAt: 11,
    });

    await pool.disconnect(pairedTarget.id);
    expect(ensureForward).toHaveBeenCalledWith("127.0.0.1", 4173);
    expect(dispose).toHaveBeenCalledWith(false);
  });

  it("closes a manual Relay connection on sign-out and keeps direct reconnect eligible", async () => {
    const relayClient = createClient();
    const relayDispose = vi.fn();
    const directClient = createClient();
    const directDispose = vi.fn();
    bootstrapPairedRuntimeMock
      .mockResolvedValueOnce({
        client: relayClient,
        transport: { connection: { endpoint: "wss://relay.example/connect/machine-1" } },
        portForwardClient: { ensureForward: vi.fn(), dispose: relayDispose },
        relayAccountOwnerUserId: "account-a",
        result: {
          ...connectResult("1.0.0"),
          target: pairedTarget,
          route: {
            kind: "relay",
            endpoint: "wss://relay.example/connect/machine-1",
            latencyMs: 2,
          },
        },
      })
      .mockResolvedValueOnce({
        client: directClient,
        transport: { connection: { endpoint: "ws://studio.local:8787/" } },
        portForwardClient: { ensureForward: vi.fn(), dispose: directDispose },
        relayAccountOwnerUserId: null,
        result: {
          ...connectResult("1.0.0"),
          target: pairedTarget,
          route: {
            kind: "lan",
            endpoint: "ws://studio.local:8787/",
            latencyMs: 2,
          },
        },
      });

    let accountOwnerUserId: string | null = "account-a";
    const pool = new RemoteConnectionPool(
      {} as RemoteTargetRegistry,
      "1.0.0",
      undefined,
      {
        getAccountRelayProof: async () => accountOwnerUserId
          ? { userId: accountOwnerUserId, token: "account-token" }
          : null,
      },
    );
    await expect(pool.connect(pairedTarget)).resolves.toMatchObject({
      route: { kind: "relay" },
    });
    expect(pool.reconcileAccountRelayOwner("account-a")).toEqual([]);
    expect(relayClient.close).not.toHaveBeenCalled();

    accountOwnerUserId = null;
    expect(pool.reconcileAccountRelayOwner(null)).toEqual([pairedTarget.id]);
    await vi.waitFor(() => {
      expect(relayClient.close).toHaveBeenCalledTimes(1);
      expect(relayDispose).toHaveBeenCalledWith(false);
    });

    await expect(pool.connect(pairedTarget)).resolves.toMatchObject({
      route: { kind: "lan" },
    });
    expect(bootstrapPairedRuntimeMock).toHaveBeenCalledTimes(2);
    expect(directClient.close).not.toHaveBeenCalled();
  });

  it("closes a paired RPC transport exactly once when client failure evicts it", async () => {
    const client = createClient();
    const dispose = vi.fn();
    bootstrapPairedRuntimeMock.mockResolvedValueOnce({
      client,
      transport: { connection: { endpoint: "ws://studio.local:8787/" } },
      portForwardClient: { ensureForward: vi.fn(), dispose },
      result: {
        ...connectResult("1.0.0"),
        target: pairedTarget,
        route: {
          kind: "lan",
          endpoint: "ws://studio.local:8787/",
          latencyMs: 2,
        },
      },
    });

    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");
    const onEvicted = vi.fn();
    pool.onEntryEvicted(onEvicted);
    await pool.connect(pairedTarget);

    client.emitDisconnect(new Error("Remote ADE service connection failed: ECONNRESET"));
    await Promise.resolve();

    expect(client.close).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith(false);
    expect(onEvicted).toHaveBeenCalledTimes(1);

    await pool.disconnect(pairedTarget.id);
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("falls back to SSH when the paired host lacks rpcChannel support", async () => {
    bootstrapPairedRuntimeMock.mockRejectedValueOnce(
      new PairedRuntimeTransportUnavailableError(
        "The paired machine does not advertise runtime RPC support.",
      ),
    );
    const client = createClient();
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client,
      ssh: createSsh(),
      result: { ...connectResult("1.0.0"), target: pairedTarget },
    });

    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");
    await expect(pool.connect(pairedTarget)).resolves.toMatchObject({
      target: { id: pairedTarget.id },
      version: "1.0.0",
    });
    expect(bootstrapPairedRuntimeMock).toHaveBeenCalledTimes(1);
    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(1);
  });

  it("re-throws a paired compatibility error when the target has no SSH routes", async () => {
    const pairedWithoutSshRoutes = { ...pairedTarget, routes: [] };
    bootstrapPairedRuntimeMock.mockRejectedValueOnce(
      new PairedRuntimeCompatibilityError(
        "The paired machine runs an older ADE runtime.",
      ),
    );

    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");
    await expect(pool.connect(pairedWithoutSshRoutes)).rejects.toBeInstanceOf(
      PairedRuntimeCompatibilityError,
    );
    expect(bootstrapPairedRuntimeMock).toHaveBeenCalledTimes(1);
    expect(bootstrapRemoteRuntimeMock).not.toHaveBeenCalled();
  });

  it("uses preserved paired-target SSH credentials during compatibility fallback", async () => {
    const pairedWithSshRoutes: RemoteRuntimeTarget = {
      ...pairedTarget,
      id: "paired-ssh-target-1",
      sshUser: "fallback-user",
      port: 2201,
      sshKeyPath: "/keys/fallback_ed25519",
      routes: [
        {
          hostname: "studio.local",
          port: 2201,
          source: "manual",
          lastSucceededAt: null,
        },
      ],
    };
    bootstrapPairedRuntimeMock.mockRejectedValueOnce(
      new PairedRuntimeCompatibilityError(
        "The paired machine runs an older ADE runtime.",
      ),
    );
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: createClient(),
      ssh: createSsh(),
      result: { ...connectResult("1.0.0"), target: pairedWithSshRoutes },
    });

    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");
    await expect(pool.connect(pairedWithSshRoutes)).resolves.toMatchObject({
      target: { id: pairedWithSshRoutes.id },
    });
    expect(bootstrapPairedRuntimeMock).toHaveBeenCalledTimes(1);
    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          id: pairedWithSshRoutes.id,
          hostname: "studio.local",
          sshUser: "fallback-user",
          port: 2201,
          sshKeyPath: "/keys/fallback_ed25519",
        }),
      }),
    );
  });

  it("falls back to SSH when every paired WebSocket dial fails", async () => {
    bootstrapPairedRuntimeMock.mockRejectedValueOnce(
      new PairedRuntimeTransportUnavailableError(
        "Failed to connect to sync endpoint: ECONNREFUSED.",
      ),
    );
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: createClient(),
      ssh: createSsh(),
      result: { ...connectResult("1.0.0"), target: pairedTarget },
    });

    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");
    await expect(pool.connect(pairedTarget)).resolves.toMatchObject({
      target: { id: pairedTarget.id },
    });
    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          id: pairedTarget.id,
          hostname: "studio.local",
        }),
      }),
    );
  });

  it("surfaces SSH trust required only after the paired route fails", async () => {
    const trustStatus = {
      state: "needs_trust" as const,
      targetId: pairedTarget.id,
      host: "studio.local",
      port: 22,
      route: pairedTarget.routes![0]!,
      keyType: "ssh-ed25519",
      fingerprintSha256: "SHA256:paired-fallback",
      knownHostsPath: "/home/test/.ssh/known_hosts",
    };
    bootstrapPairedRuntimeMock.mockRejectedValueOnce(
      new PairedRuntimeTransportUnavailableError("Paired route is offline."),
    );
    getSshHostKeyTrustForTargetMock.mockResolvedValueOnce(trustStatus);

    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");
    await expect(pool.connect(pairedTarget)).rejects.toMatchObject({
      name: "PairedRuntimeSshTrustRequiredError",
      trustStatus,
    });

    expect(getSshHostKeyTrustForTargetMock).toHaveBeenCalledTimes(1);
    expect(bootstrapRemoteRuntimeMock).not.toHaveBeenCalled();
  });

  it("does not treat a relay-only paired target as SSH-capable", async () => {
    const relayOnlyTarget: RemoteRuntimeTarget = {
      ...pairedTarget,
      id: "relay-only-target",
      hostname: "relay.example.test",
      routes: [{
        hostname: "relay.example.test",
        port: null,
        source: "manual",
        lastSucceededAt: null,
      }],
    };
    const pairedError = new PairedRuntimeTransportUnavailableError(
      "Relay route is offline.",
    );
    bootstrapPairedRuntimeMock.mockRejectedValueOnce(pairedError);
    const pairedStore = {
      getForReference: vi.fn(() => ({
        endpoints: ["wss://relay.example.test/connect/machine-1"],
        relayUrl: "wss://relay.example.test/connect/machine-1",
      })),
    };

    const pool = new RemoteConnectionPool(
      {} as RemoteTargetRegistry,
      "1.0.0",
      pairedStore as any,
    );
    await expect(pool.connect(relayOnlyTarget)).rejects.toBe(pairedError);

    expect(getSshHostKeyTrustForTargetMock).not.toHaveBeenCalled();
    expect(bootstrapRemoteRuntimeMock).not.toHaveBeenCalled();
  });

  it("does not infer SSH fallback from discovery routes", async () => {
    const discoveredTarget: RemoteRuntimeTarget = {
      ...pairedTarget,
      id: "discovered-paired-target",
      routes: [{
        hostname: "studio.local",
        port: 22,
        source: "bonjour",
        lastSucceededAt: null,
      }],
    };
    const pairedError = new PairedRuntimeTransportUnavailableError(
      "Paired routes are offline.",
    );
    bootstrapPairedRuntimeMock.mockRejectedValueOnce(pairedError);

    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");
    await expect(pool.connect(discoveredTarget)).rejects.toBe(pairedError);

    expect(getSshHostKeyTrustForTargetMock).not.toHaveBeenCalled();
    expect(bootstrapRemoteRuntimeMock).not.toHaveBeenCalled();
  });

  it("does not back off a relay sign-in requirement", async () => {
    const noSshTarget: RemoteRuntimeTarget = {
      ...pairedTarget,
      id: "relay-auth-no-ssh-target",
      routes: [{
        hostname: "studio.local",
        port: 22,
        source: "bonjour",
        lastSucceededAt: null,
      }],
    };
    bootstrapPairedRuntimeMock.mockRejectedValue(
      new PairedRuntimeRelayAuthRequiredError(),
    );
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    await expect(pool.connect(noSshTarget)).rejects.toBeInstanceOf(
      PairedRuntimeRelayAuthRequiredError,
    );
    await expect(pool.connect(noSshTarget)).rejects.toBeInstanceOf(
      PairedRuntimeRelayAuthRequiredError,
    );

    expect(bootstrapPairedRuntimeMock).toHaveBeenCalledTimes(2);
  });

  it("uses explicitly configured SSH when relay needs sign-in", async () => {
    bootstrapPairedRuntimeMock.mockRejectedValueOnce(
      new PairedRuntimeRelayAuthRequiredError(),
    );
    getSshHostKeyTrustForTargetMock.mockResolvedValueOnce({ state: "trusted" });
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: createClient(),
      ssh: createSsh(),
      result: { ...connectResult("1.0.0"), target: pairedTarget },
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    await expect(pool.connect(pairedTarget)).resolves.toMatchObject({
      target: { id: pairedTarget.id },
    });
    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(1);
  });

  it("evicts cached entries after the RPC client disconnects", async () => {
    const firstClient = createClient();
    const firstSsh = createSsh();
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: firstClient,
      ssh: firstSsh,
      result: connectResult("1.0.0"),
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");
    const onEvicted = vi.fn();
    pool.onEntryEvicted(onEvicted);

    await expect(pool.connect(target)).resolves.toMatchObject({
      version: "1.0.0",
    });
    firstClient.emitDisconnect(new Error("stream closed"));

    expect(firstSsh.end).toHaveBeenCalledTimes(1);
    expect(onEvicted).toHaveBeenCalledWith(target.id, expect.objectContaining({
      message: "stream closed",
    }));

    const secondClient = createClient();
    const secondSsh = createSsh();
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: secondClient,
      ssh: secondSsh,
      result: connectResult("1.0.1"),
    });

    await expect(pool.connect(target)).resolves.toMatchObject({
      version: "1.0.1",
    });
    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
  });

  it("does not emit an eviction notification for intentional disconnects", async () => {
    const client = createClient();
    const ssh = createSsh();
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client,
      ssh,
      result: connectResult("1.0.0"),
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");
    const onEvicted = vi.fn();
    pool.onEntryEvicted(onEvicted);

    await pool.connect(target);
    pool.disconnect(target.id);
    await Promise.resolve();

    expect(client.close).toHaveBeenCalledTimes(1);
    expect(ssh.end).toHaveBeenCalledTimes(1);
    expect(ssh.destroy).toHaveBeenCalledTimes(1);
    expect(onEvicted).not.toHaveBeenCalled();
  });

  it("reuses an in-flight bootstrap when reconnect follows disconnect", async () => {
    const client = createClient();
    const ssh = createSsh();
    type BootstrapResolve = (value: {
      client: RuntimeRpcClient;
      ssh: Client;
      result: RemoteRuntimeConnectResult;
    }) => void;
    let resolveBootstrap: BootstrapResolve | undefined;
    bootstrapRemoteRuntimeMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveBootstrap = resolve;
    }));
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    const firstConnect = pool.connect(target);
    pool.disconnect(target.id);
    const secondConnect = pool.connect(target);

    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(1);
    const resolveBootstrapNow = resolveBootstrap as BootstrapResolve;
    resolveBootstrapNow({
      client,
      ssh,
      result: connectResult("1.0.0"),
    });

    await expect(firstConnect).resolves.toMatchObject({ version: "1.0.0" });
    await expect(secondConnect).resolves.toMatchObject({ version: "1.0.0" });
    expect(client.close).not.toHaveBeenCalled();
    expect(ssh.end).not.toHaveBeenCalled();
  });

  it("evicts cached entries and closes the RPC client after SSH closes", async () => {
    const firstClient = createClient();
    const firstSsh = createSsh();
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: firstClient,
      ssh: firstSsh,
      result: connectResult("1.0.0"),
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    await pool.connect(target);
    firstSsh.emitOnce("close");

    expect(firstClient.close).toHaveBeenCalledTimes(1);
    expect(firstSsh.end).toHaveBeenCalledTimes(1);
    expect(firstSsh.destroy).toHaveBeenCalledTimes(1);

    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: createClient(),
      ssh: createSsh(),
      result: connectResult("1.0.1"),
    });

    await expect(pool.connect(target)).resolves.toMatchObject({
      version: "1.0.1",
    });
    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
  });

  it("opens a reusable local SSH forward and closes it on disconnect", async () => {
    const upstream = net.createServer((socket) => {
      socket.once("data", (chunk) => {
        socket.end(`remote:${chunk.toString("utf8")}`);
      });
    });
    const upstreamPort = await listen(upstream);
    const client = createClient();
    const ssh = createSsh();
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client,
      ssh,
      result: connectResult("1.0.0"),
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    try {
      await pool.connect(target);
      const [firstForward, secondForward] = await Promise.all([
        pool.ensureLocalPortForward(target.id, {
          remotePort: upstreamPort,
          label: "preview",
        }),
        pool.ensureLocalPortForward(target.id, {
          remotePort: upstreamPort,
          label: "preview",
        }),
      ]);

      expect(secondForward.localPort).toBe(firstForward.localPort);
      expect(ssh.forwardOut).not.toHaveBeenCalled();

      const response = await new Promise<string>((resolve, reject) => {
        const socket = net.createConnection({
          host: firstForward.localHost,
          port: firstForward.localPort,
        });
        socket.once("connect", () => socket.write("ok"));
        socket.once("data", (chunk) => {
          resolve(chunk.toString("utf8"));
          socket.end();
        });
        socket.once("error", reject);
      });

      expect(response).toBe("remote:ok");
      expect(ssh.forwardOut).toHaveBeenCalledWith(
        "127.0.0.1",
        0,
        "127.0.0.1",
        upstreamPort,
        expect.any(Function),
      );

      await pool.disconnect(target.id);
      await expect(pool.ensureLocalPortForward(target.id, {
        remotePort: upstreamPort,
        label: "preview",
      })).rejects.toThrow(/not connected/i);
      expect(ssh.forwardOut).toHaveBeenCalledTimes(1);
    } finally {
      await pool.dispose();
      await closeServer(upstream);
    }
  });

  it("uses the live SSH entry when a local SSH forward accepts connections", async () => {
    const upstream = net.createServer((socket) => {
      socket.once("data", (chunk) => {
        socket.end(`remote:${chunk.toString("utf8")}`);
      });
    });
    const upstreamPort = await listen(upstream);
    const firstClient = createClient();
    const firstSsh = createSsh();
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: firstClient,
      ssh: firstSsh,
      result: connectResult("1.0.0"),
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    try {
      await pool.connect(target);
      const forward = await pool.ensureLocalPortForward(target.id, {
        remotePort: upstreamPort,
        label: "preview",
      });
      const secondClient = createClient();
      const secondSsh = createSsh();
      (
        pool as unknown as {
          entries: Map<string, Promise<{
            client: FakeRuntimeRpcClient;
            transport: "ssh";
            ssh: FakeSshClient;
            result: RemoteRuntimeConnectResult;
          }>>;
        }
      ).entries.set(target.id, Promise.resolve({
        client: secondClient,
        transport: "ssh",
        ssh: secondSsh,
        result: connectResult("1.0.1"),
      }));

      const response = await new Promise<string>((resolve, reject) => {
        const socket = net.createConnection({
          host: forward.localHost,
          port: forward.localPort,
        });
        socket.once("connect", () => socket.write("ok"));
        socket.once("data", (chunk) => {
          resolve(chunk.toString("utf8"));
          socket.end();
        });
        socket.once("error", reject);
      });

      expect(response).toBe("remote:ok");
      expect(firstSsh.forwardOut).not.toHaveBeenCalled();
      expect(secondSsh.forwardOut).toHaveBeenCalledWith(
        "127.0.0.1",
        0,
        "127.0.0.1",
        upstreamPort,
        expect.any(Function),
      );
    } finally {
      pool.dispose();
      await closeServer(upstream);
    }
  });

  it("connects before streaming events and reconnects after disconnect", async () => {
    const firstClient = createClient();
    firstClient.call.mockResolvedValueOnce({
      ok: true,
      events: [
        {
          id: 1,
          timestamp: "2026-05-10T00:00:00.000Z",
          category: "runtime",
          payload: {},
        },
      ],
      nextCursor: 2,
      hasMore: false,
    });
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: firstClient,
      ssh: createSsh(),
      result: connectResult("1.0.0"),
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    await expect(
      pool.streamEventsForTarget(target, "project-1", { cursor: 1, limit: 10 }),
    ).resolves.toMatchObject({
      nextCursor: 2,
      events: [{ id: 1, category: "runtime" }],
    });
    expect(firstClient.call).toHaveBeenCalledWith("ade/actions/call", {
      projectId: "project-1",
      name: "stream_events",
      arguments: {
        cursor: 1,
        limit: 10,
      },
    });

    firstClient.emitDisconnect(new Error("lost"));

    const secondClient = createClient();
    secondClient.call.mockResolvedValueOnce({
      ok: true,
      events: [],
      nextCursor: 2,
      hasMore: false,
    });
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: secondClient,
      ssh: createSsh(),
      result: connectResult("1.0.1"),
    });

    await expect(
      pool.streamEventsForTarget(target, "project-1", { cursor: 2 }),
    ).resolves.toMatchObject({
      nextCursor: 2,
      events: [],
    });
    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
  });

  it("retries idempotent reads once when the connection closes during the request", async () => {
    const firstClient = createClient();
    const firstSsh = createSsh();
    firstClient.call.mockRejectedValueOnce(
      new Error("Remote runtime connection closed."),
    );
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: firstClient,
      ssh: firstSsh,
      result: connectResult("1.0.0"),
    });
    const secondClient = createClient();
    secondClient.call.mockResolvedValueOnce([
      {
        projectId: "project-1",
        rootPath: "/srv/app",
        displayName: "app",
        addedAt: 1,
        lastOpenedAt: 2,
        gitOriginUrl: null,
      },
    ]);
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: secondClient,
      ssh: createSsh(),
      result: connectResult("1.0.1"),
    });
    const pool = new RemoteConnectionPool({ get: () => null } as unknown as RemoteTargetRegistry, "1.0.0");

    await expect(pool.projectsForTarget(target)).resolves.toEqual([
      {
        projectId: "project-1",
        rootPath: "/srv/app",
        displayName: "app",
        addedAt: 1,
        lastOpenedAt: 2,
        gitOriginUrl: null,
      },
    ]);

    expect(firstSsh.end).toHaveBeenCalledTimes(1);
    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
    expect(firstClient.call).toHaveBeenCalledWith("projects.list", {});
    expect(secondClient.call).toHaveBeenCalledWith("projects.list", {});
  });

  it("propagates request timeouts without reconnecting or replaying retryable reads", async () => {
    const client = createClient();
    const ssh = createSsh();
    const timeout = new Error(
      "Remote ADE service timed out waiting for method projects.list (5000ms).",
    );
    client.call.mockRejectedValueOnce(timeout);
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client,
      ssh,
      result: connectResult("1.0.0"),
    });
    const pool = new RemoteConnectionPool({ get: () => null } as unknown as RemoteTargetRegistry, "1.0.0");

    await expect(pool.projectsForTarget(target)).rejects.toThrow(timeout.message);

    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(1);
    expect(client.call).toHaveBeenCalledTimes(1);
    expect(client.call).toHaveBeenCalledWith("projects.list", {});
    expect(client.close).not.toHaveBeenCalled();
    expect(ssh.end).not.toHaveBeenCalled();
  });

  it("backs off new SSH bootstraps after a connect failure", async () => {
    bootstrapRemoteRuntimeMock.mockRejectedValueOnce(
      new Error("kex_exchange_identification: read: Connection reset by peer"),
    );
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    await expect(pool.connect(target)).rejects.toThrow(
      /kex_exchange_identification/i,
    );
    await expect(pool.connect(target)).rejects.toThrow(/Retrying in \d+s/i);
    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(1);
  });

  it("lets an explicit connect bypass a stale bootstrap backoff", async () => {
    bootstrapRemoteRuntimeMock.mockRejectedValueOnce(
      new Error("kex_exchange_identification: read: Connection reset by peer"),
    );
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    await expect(pool.connect(target)).rejects.toThrow(
      /kex_exchange_identification/i,
    );
    await expect(pool.connect(target)).rejects.toThrow(/Retrying in \d+s/i);

    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: createClient(),
      ssh: createSsh(),
      result: connectResult("1.0.1"),
    });

    await expect(
      pool.connect(target, { bypassFailureBackoff: true }),
    ).resolves.toMatchObject({ version: "1.0.1" });
    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
  });

  it("does not reconnect a retryable request after an explicit disconnect during the request", async () => {
    const firstClient = createClient();
    const firstSsh = createSsh();
    let rejectCall!: (error: Error) => void;
    firstClient.call.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectCall = reject;
        }),
    );
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: firstClient,
      ssh: firstSsh,
      result: connectResult("1.0.0"),
    });
    const pool = new RemoteConnectionPool(
      { get: () => null } as unknown as RemoteTargetRegistry,
      "1.0.0",
    );

    const pending = pool.callActionForTarget(target, "project-1", {
      domain: "lane",
      action: "list",
    });
    while (firstClient.call.mock.calls.length === 0) {
      await Promise.resolve();
    }
    pool.disconnect(target.id);
    rejectCall(new Error("Remote runtime connection closed."));

    await expect(pending).rejects.toThrow(/connection closed/i);
    expect(firstSsh.end).toHaveBeenCalledTimes(1);
    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(1);
  });

  it("does not replay non-idempotent machine calls after a connection interruption", async () => {
    const firstClient = createClient();
    firstClient.call.mockRejectedValueOnce(
      new Error("Remote ADE service connection closed."),
    );
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: firstClient,
      ssh: createSsh(),
      result: connectResult("1.0.0"),
    });
    const secondClient = createClient();
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: secondClient,
      ssh: createSsh(),
      result: connectResult("1.0.1"),
    });
    const pool = new RemoteConnectionPool({ get: () => null } as unknown as RemoteTargetRegistry, "1.0.0");

    await expect(
      pool.callMachineForTarget(
        target,
        "projects.clone",
        { url: "https://github.com/acme/app", parentDir: "/srv" },
        { retryOnConnectionError: false },
      ),
    ).rejects.toThrow(/retry the action/i);

    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
    expect(firstClient.call).toHaveBeenCalledWith("projects.clone", {
      url: "https://github.com/acme/app",
      parentDir: "/srv",
    });
    expect(secondClient.call).not.toHaveBeenCalled();
  });

  it("fails machine project actions with a specific compatibility message when the remote lacks the capability", async () => {
    const client = createClient();
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client,
      ssh: createSsh(),
      result: {
        ...connectResult("0.9.0"),
        capabilities: {
          projects: true,
          machineProjects: {
            browseDirectories: false,
          },
        },
      },
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    await expect(
      pool.callMachineForTarget(target, "projects.browseDirectories", {}),
    ).rejects.toThrow(
      /Remote ADE service 0\.9\.0 does not support browsing remote directories/i,
    );
    expect(client.call.mock.calls.some(([method]) => method === "ade/actions/call")).toBe(false);
  });

  it("reconnects after interrupted mutating actions and asks the caller to retry", async () => {
    const firstClient = createClient();
    firstClient.call.mockRejectedValueOnce(
      new Error("Remote runtime connection failed: channel closed"),
    );
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: firstClient,
      ssh: createSsh(),
      result: connectResult("1.0.0"),
    });
    const secondClient = createClient();
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: secondClient,
      ssh: createSsh(),
      result: connectResult("1.0.1"),
    });
    const pool = new RemoteConnectionPool({ get: () => null } as unknown as RemoteTargetRegistry, "1.0.0");

    await expect(
      pool.callActionForTarget(target, "project-1", {
        domain: "lane",
        action: "create",
        args: { name: "work" },
      }),
    ).rejects.toThrow(/retry the action/i);

    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
    expect(firstClient.call).toHaveBeenCalledTimes(1);
    expect(firstClient.call).toHaveBeenCalledWith("ade/actions/call", {
      projectId: "project-1",
      name: "run_ade_action",
      arguments: {
        domain: "lane",
        action: "create",
        args: { name: "work" },
      },
    });
    expect(secondClient.call).not.toHaveBeenCalled();
  });

  it("does not reconnect or replay a timed-out mutation", async () => {
    const client = createClient();
    const ssh = createSsh();
    const timeout = new Error(
      "Remote ADE service timed out waiting for method ade/actions/call (600000ms).",
    );
    client.call.mockRejectedValueOnce(timeout);
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client,
      ssh,
      result: connectResult("1.0.0"),
    });
    const pool = new RemoteConnectionPool(
      { get: () => null } as unknown as RemoteTargetRegistry,
      "1.0.0",
    );

    await expect(pool.callActionForTarget(target, "project-1", {
      domain: "lane",
      action: "create",
      args: { name: "work" },
    })).rejects.toThrow(timeout.message);

    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(1);
    expect(client.call).toHaveBeenCalledTimes(1);
    expect(client.call).toHaveBeenCalledWith("ade/actions/call", {
      projectId: "project-1",
      name: "run_ade_action",
      arguments: {
        domain: "lane",
        action: "create",
        args: { name: "work" },
      },
    });
    expect(client.close).not.toHaveBeenCalled();
    expect(ssh.end).not.toHaveBeenCalled();
  });

  it("blocks a handoff when the active transport differs from the route the user reviewed", async () => {
    const client = createClient();
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client,
      ssh: createSsh(),
      result: {
        ...connectResult("1.0.0"),
        route: { kind: "lan", endpoint: "studio.local:48888" },
      },
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    await expect(pool.callActionForTarget(target, "project-1", {
      domain: "chat",
      action: "acceptCrossMachineHandoff",
      args: { capsule: {}, capsuleFingerprint: "a".repeat(64) },
      requiredRouteKind: "tailnet",
    })).rejects.toThrow(/route changed from 'tailnet' to 'lan'/i);

    expect(client.call.mock.calls.some(([method]) => method === "ade/actions/call")).toBe(false);
  });

  it("does not automatically replay destination acceptance after an interrupted connection", async () => {
    const firstClient = createClient();
    firstClient.call.mockRejectedValueOnce(new Error("Remote runtime connection failed: channel closed"));
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: firstClient,
      ssh: createSsh(),
      result: {
        ...connectResult("1.0.0"),
        route: { kind: "tailnet", endpoint: "100.64.0.2", latencyMs: 1 },
      },
    });
    const secondClient = createClient();
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: secondClient,
      ssh: createSsh(),
      result: {
        ...connectResult("1.0.1"),
        route: { kind: "relay", endpoint: "relay.example.test", latencyMs: 1 },
      },
    });
    const pool = new RemoteConnectionPool(
      { get: () => null } as unknown as RemoteTargetRegistry,
      "1.0.0",
    );

    await expect(pool.callActionForTarget(target, "project-1", {
      domain: "chat",
      action: "acceptCrossMachineHandoff",
      args: { capsule: {}, capsuleFingerprint: "a".repeat(64) },
      requiredRouteKind: "tailnet",
    })).rejects.toThrow(/retry the action/i);

    expect(firstClient.call.mock.calls.some(([method]) => method === "ade/actions/call")).toBe(true);
    expect(secondClient.call.mock.calls.some(([method]) => method === "ade/actions/call")).toBe(false);
  });

  it("preserves the unknown destination outcome when reconnecting also fails", async () => {
    const firstClient = createClient();
    firstClient.call.mockRejectedValueOnce(new Error("Remote runtime connection failed: channel closed"));
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: firstClient,
      ssh: createSsh(),
      result: {
        ...connectResult("1.0.0"),
        route: { kind: "tailnet", endpoint: "100.64.0.2", latencyMs: 1 },
      },
    });
    bootstrapRemoteRuntimeMock.mockRejectedValueOnce(
      new Error("Could not reach the paired ADE runtime over LAN, tailnet, or relay."),
    );
    const pool = new RemoteConnectionPool(
      { get: () => null } as unknown as RemoteTargetRegistry,
      "1.0.0",
    );

    await expect(pool.callActionForTarget(target, "project-1", {
      domain: "chat",
      action: "acceptCrossMachineHandoff",
      args: { capsule: {}, capsuleFingerprint: "a".repeat(64) },
      requiredRouteKind: "tailnet",
    })).rejects.toThrow(/could not reconnect.*check the destination/i);

    expect(firstClient.call.mock.calls.filter(([method]) => method === "ade/actions/call")).toHaveLength(1);
    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
  });

  it("extends remote lane naming actions without adding a timeout to unrelated mutations", async () => {
    const client = createClient();
    client.call.mockResolvedValue({
      ok: true,
      domain: "chat",
      action: "suggestLaneNameFromPrompt",
      result: { name: "update-modal-flow" },
      statusHints: {},
    });
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client,
      ssh: createSsh(),
      result: connectResult("1.0.0"),
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    await pool.callActionForTarget(target, "project-1", {
      domain: "chat",
      action: "suggestLaneNameFromPrompt",
      args: { prompt: "Fix update modal flow" },
    });
    await pool.callActionForTarget(target, "project-1", {
      domain: "chat",
      action: "deleteSession",
      args: { sessionId: "chat-1" },
    });

    expect(client.call).toHaveBeenNthCalledWith(
      1,
      "ade/actions/call",
      expect.objectContaining({
        arguments: expect.objectContaining({
          domain: "chat",
          action: "suggestLaneNameFromPrompt",
        }),
      }),
      { timeoutMs: 120_000 },
    );
    expect(client.call).toHaveBeenNthCalledWith(
      2,
      "ade/actions/call",
      expect.objectContaining({
        arguments: expect.objectContaining({
          domain: "chat",
          action: "deleteSession",
        }),
      }),
    );
  });

  it("retries read-only project actions once after ECONNRESET", async () => {
    const firstClient = createClient();
    const firstSsh = createSsh();
    firstClient.call.mockRejectedValueOnce(
      new Error("read ECONNRESET"),
    );
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: firstClient,
      ssh: firstSsh,
      result: connectResult("1.0.0"),
    });
    const secondClient = createClient();
    secondClient.call.mockResolvedValueOnce({
      ok: true,
      domain: "lane",
      action: "list",
      result: [{ id: "lane-main" }],
      statusHints: { reconnected: true },
    });
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: secondClient,
      ssh: createSsh(),
      result: connectResult("1.0.1"),
    });
    const pool = new RemoteConnectionPool({ get: () => null } as unknown as RemoteTargetRegistry, "1.0.0");

    await expect(
      pool.callActionForTarget(target, "project-1", {
        domain: "lane",
        action: "list",
      }),
    ).resolves.toEqual({
      domain: "lane",
      action: "list",
      result: [{ id: "lane-main" }],
      statusHints: { reconnected: true },
    });

    expect(firstSsh.end).toHaveBeenCalledTimes(1);
    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
    expect(firstClient.call).toHaveBeenCalledTimes(1);
    expect(firstClient.call).toHaveBeenCalledWith("ade/actions/call", {
      projectId: "project-1",
      name: "run_ade_action",
      arguments: {
        domain: "lane",
        action: "list",
      },
    }, { timeoutMs: 25_000 });
    expect(secondClient.call).toHaveBeenCalledTimes(1);
    expect(secondClient.call).toHaveBeenCalledWith("ade/actions/call", {
      projectId: "project-1",
      name: "run_ade_action",
      arguments: {
        domain: "lane",
        action: "list",
      },
    }, { timeoutMs: 25_000 });
  });

  it("retries file git decoration refresh once after ECONNRESET", async () => {
    const firstClient = createClient();
    const firstSsh = createSsh();
    firstClient.call.mockRejectedValueOnce(new Error("read ECONNRESET"));
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: firstClient,
      ssh: firstSsh,
      result: connectResult("1.0.0"),
    });
    const secondClient = createClient();
    secondClient.call.mockResolvedValueOnce({
      ok: true,
      domain: "file",
      action: "refreshGitDecorations",
      result: { workspaceId: "primary", files: [], directories: [] },
      statusHints: { reconnected: true },
    });
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: secondClient,
      ssh: createSsh(),
      result: connectResult("1.0.1"),
    });
    const pool = new RemoteConnectionPool({ get: () => null } as unknown as RemoteTargetRegistry, "1.0.0");

    await expect(
      pool.callActionForTarget(target, "project-1", {
        domain: "file",
        action: "refreshGitDecorations",
        args: { workspaceId: "primary", forceFresh: true },
      }),
    ).resolves.toEqual({
      domain: "file",
      action: "refreshGitDecorations",
      result: { workspaceId: "primary", files: [], directories: [] },
      statusHints: { reconnected: true },
    });

    expect(firstSsh.end).toHaveBeenCalledTimes(1);
    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
    expect(secondClient.call).toHaveBeenCalledWith("ade/actions/call", {
      projectId: "project-1",
      name: "run_ade_action",
      arguments: {
        domain: "file",
        action: "refreshGitDecorations",
        args: { workspaceId: "primary", forceFresh: true },
      },
    }, { timeoutMs: 25_000 });
  });

  it("falls back to empty git decorations when an older runtime lacks that optional action", async () => {
    const client = createClient();
    client.call.mockRejectedValueOnce(new Error("Action 'file.refreshGitDecorations' is not callable."));
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client,
      ssh: createSsh(),
      result: connectResult("0.9.0"),
    });
    const pool = new RemoteConnectionPool({ get: () => null } as unknown as RemoteTargetRegistry, "1.0.0");

    await expect(
      pool.callActionForTarget(target, "project-1", {
        domain: "file",
        action: "refreshGitDecorations",
        args: { workspaceId: "primary", forceFresh: true },
      }),
    ).resolves.toEqual({
      domain: "file",
      action: "refreshGitDecorations",
      result: { workspaceId: "primary", files: [], directories: [] },
      statusHints: { optionalActionMissing: true },
    });

    await expect(
      pool.callActionForTarget(target, "project-1", {
        domain: "file",
        action: "refreshGitDecorations",
        args: { workspaceId: "primary", forceFresh: true },
      }),
    ).resolves.toEqual({
      domain: "file",
      action: "refreshGitDecorations",
      result: { workspaceId: "primary", files: [], directories: [] },
      statusHints: { optionalActionMissing: true },
    });

    expect(client.call).toHaveBeenCalledTimes(1);
    expect(client.call).toHaveBeenCalledWith("ade/actions/call", {
      projectId: "project-1",
      name: "run_ade_action",
      arguments: {
        domain: "file",
        action: "refreshGitDecorations",
        args: { workspaceId: "primary", forceFresh: true },
      },
    }, { timeoutMs: 25_000 });
  });

  it("falls back to empty PR queue states when an older runtime lacks that optional action", async () => {
    const client = createClient();
    client.call.mockResolvedValueOnce({
      ok: false,
      error: { message: "Action 'pr.listQueueStates' is not callable." },
    });
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client,
      ssh: createSsh(),
      result: connectResult("0.9.0"),
    });
    const pool = new RemoteConnectionPool({ get: () => null } as unknown as RemoteTargetRegistry, "1.0.0");

    await expect(
      pool.callActionForTarget(target, "project-1", {
        domain: "pr",
        action: "listQueueStates",
        args: { includeCompleted: true, limit: 50 },
      }),
    ).resolves.toEqual({
      domain: "pr",
      action: "listQueueStates",
      result: [],
      statusHints: { optionalActionMissing: true },
    });

    await expect(
      pool.callActionForTarget(target, "project-1", {
        domain: "pr",
        action: "listQueueStates",
        args: { includeCompleted: true, limit: 50 },
      }),
    ).resolves.toEqual({
      domain: "pr",
      action: "listQueueStates",
      result: [],
      statusHints: { optionalActionMissing: true },
    });

    expect(client.call).toHaveBeenCalledTimes(1);
    expect(client.call).toHaveBeenCalledWith("ade/actions/call", {
      projectId: "project-1",
      name: "run_ade_action",
      arguments: {
        domain: "pr",
        action: "listQueueStates",
        args: { includeCompleted: true, limit: 50 },
      },
    }, { timeoutMs: 25_000 });
  });

  it("lists remote ADE actions as grouped registry entries", async () => {
    const client = createClient();
    client.call.mockResolvedValueOnce({
      count: 3,
      actions: [
        {
          domain: "git",
          action: "push",
          name: "git.push",
          usage: "ade actions run git.push",
        },
        {
          domain: "chat",
          action: "launchCli",
          name: "chat.launchCli",
          usage: "ade actions run chat.launchCli",
        },
        {
          domain: "git",
          action: "status",
          name: "git.status",
          usage: "ade actions run git.status",
        },
      ],
    });
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client,
      ssh: createSsh(),
      result: connectResult("1.0.0"),
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    await expect(
      pool.listActionRegistryForTarget(target, "project-1"),
    ).resolves.toEqual([
      {
        domain: "chat",
        actions: [{ name: "launchCli" }],
      },
      {
        domain: "git",
        actions: [{ name: "push" }, { name: "status" }],
      },
    ]);

    expect(client.call).toHaveBeenCalledWith("ade/actions/call", {
      projectId: "project-1",
      name: "list_ade_actions",
      arguments: { domain: "all" },
    });
  });

  it("reconnects before running a target-scoped action after the cached SSH session drops", async () => {
    const firstClient = createClient();
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: firstClient,
      ssh: createSsh(),
      result: connectResult("1.0.0"),
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    await expect(pool.connect(target)).resolves.toMatchObject({
      version: "1.0.0",
    });
    firstClient.emitDisconnect(new Error("lost"));

    const secondClient = createClient();
    secondClient.call.mockResolvedValueOnce({
      ok: true,
      domain: "lane",
      action: "list",
      result: [{ id: "lane-main" }],
      statusHints: { reconnected: true },
    });
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: secondClient,
      ssh: createSsh(),
      result: connectResult("1.0.1"),
    });

    await expect(
      pool.callActionForTarget(target, "project-1", {
        domain: "lane",
        action: "list",
      }),
    ).resolves.toEqual({
      domain: "lane",
      action: "list",
      result: [{ id: "lane-main" }],
      statusHints: { reconnected: true },
    });

    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
    expect(firstClient.call).not.toHaveBeenCalled();
    expect(secondClient.call).toHaveBeenCalledWith("ade/actions/call", {
      projectId: "project-1",
      name: "run_ade_action",
      arguments: {
        domain: "lane",
        action: "list",
      },
    }, { timeoutMs: 25_000 });
  });

  it("calls project-scoped sync methods on the connected runtime", async () => {
    const client = createClient();
    client.call.mockResolvedValueOnce({
      pairingPin: "123456",
      connectedPeers: [],
    });
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client,
      ssh: createSsh(),
      result: connectResult("1.0.0"),
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    await expect(
      pool.callSyncForTarget(target, "project-1", "sync.getStatus", {
        includeTransferReadiness: true,
      }),
    ).resolves.toEqual({ pairingPin: "123456", connectedPeers: [] });

    expect(client.call).toHaveBeenCalledWith("sync.getStatus", {
      projectId: "project-1",
      includeTransferReadiness: true,
    });
  });

  it("retries project-scoped sync reads once when the connection closes during the request", async () => {
    const firstClient = createClient();
    const firstSsh = createSsh();
    firstClient.call.mockRejectedValueOnce(
      new Error("Remote ADE service connection closed."),
    );
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: firstClient,
      ssh: firstSsh,
      result: connectResult("1.0.0"),
    });
    const secondClient = createClient();
    secondClient.call.mockResolvedValueOnce({
      pairingPin: "654321",
      connectedPeers: [{ id: "phone-1" }],
    });
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: secondClient,
      ssh: createSsh(),
      result: connectResult("1.0.1"),
    });
    const pool = new RemoteConnectionPool({ get: () => null } as unknown as RemoteTargetRegistry, "1.0.0");

    await expect(
      pool.callSyncForTarget(target, "project-1", "sync.getStatus", {
        includeTransferReadiness: true,
      }),
    ).resolves.toEqual({
      pairingPin: "654321",
      connectedPeers: [{ id: "phone-1" }],
    });

    expect(firstSsh.end).toHaveBeenCalledTimes(1);
    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
    expect(firstClient.call).toHaveBeenCalledWith("sync.getStatus", {
      projectId: "project-1",
      includeTransferReadiness: true,
    });
    expect(secondClient.call).toHaveBeenCalledWith("sync.getStatus", {
      projectId: "project-1",
      includeTransferReadiness: true,
    });
  });

  it("does not retry mutating sync RPCs after a connection drop", async () => {
    const firstClient = createClient();
    const firstSsh = createSsh();
    firstClient.call.mockRejectedValueOnce(
      new Error("Remote ADE service connection closed."),
    );
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: firstClient,
      ssh: firstSsh,
      result: connectResult("1.0.0"),
    });
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: createClient(),
      ssh: createSsh(),
      result: connectResult("1.0.1"),
    });
    const pool = new RemoteConnectionPool({ get: () => null } as unknown as RemoteTargetRegistry, "1.0.0");

    await expect(
      pool.callSyncForTarget(target, "project-1", "sync.connectToBrain", {
        host: "brain.local",
        port: 8765,
      }),
    ).rejects.toThrow(/connection was interrupted before ADE could confirm the action result/i);

    expect(firstSsh.end).toHaveBeenCalledTimes(1);
    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
    expect(firstClient.call).toHaveBeenCalledTimes(1);
    expect(firstClient.call).toHaveBeenCalledWith("sync.connectToBrain", {
      projectId: "project-1",
      host: "brain.local",
      port: 8765,
    });
  });

  it("subscribes to runtime event notifications and unsubscribes on cleanup", async () => {
    const client = createClient();
    client.call.mockImplementation(async (method: string) => {
      if (method === "runtimeEvents.subscribe") {
        client.emitNotification("runtime/event", {
          subscriptionId: "runtime-events-7",
          projectId: "project-1",
          event: {
            id: 12,
            timestamp: "2026-05-10T12:00:00.000Z",
            category: "pty",
            payload: { type: "pty_data" },
          },
          eventEpoch: "epoch-remote-1",
        });
        client.emitNotification("runtime/event", {
          subscriptionId: "runtime-events-8",
          projectId: "project-1",
          event: {
            id: 13,
            timestamp: "2026-05-10T12:00:01.000Z",
            category: "runtime",
            payload: { type: "other_subscription" },
          },
          eventEpoch: "epoch-remote-1",
        });
        return {
          subscriptionId: "runtime-events-7",
          nextCursor: 13,
          hasMore: false,
          eventEpoch: "epoch-remote-1",
        };
      }
      if (method === "runtimeEvents.unsubscribe") {
        return { removed: true };
      }
      return null;
    });
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client,
      ssh: createSsh(),
      result: connectResult("1.0.0"),
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");
    const onEvent = vi.fn();

    const cleanup = await pool.subscribeEventsForTarget(
      target,
      "project-1",
      {
        cursor: 5,
        limit: 10,
        category: "pty",
        replay: false,
      },
      onEvent,
    );

    expect(client.call).toHaveBeenCalledWith("runtimeEvents.subscribe", {
      projectId: "project-1",
      cursor: 5,
      limit: 10,
      category: "pty",
      replay: false,
    });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({
      id: 12,
      timestamp: "2026-05-10T12:00:00.000Z",
      category: "pty",
      payload: { type: "pty_data" },
    }, "epoch-remote-1");

    client.emitNotification("runtime/event", {
      subscriptionId: "runtime-events-7",
      projectId: "project-1",
      event: {
        id: 14,
        timestamp: "2026-05-10T12:00:02.000Z",
        category: "runtime",
        payload: { type: "live" },
      },
      eventEpoch: "epoch-remote-1",
    });
    expect(onEvent).toHaveBeenCalledTimes(2);

    cleanup();
    expect(client.call).toHaveBeenCalledWith("runtimeEvents.unsubscribe", {
      subscriptionId: "runtime-events-7",
    });
    client.emitNotification("runtime/event", {
      subscriptionId: "runtime-events-7",
      projectId: "project-1",
      event: {
        id: 15,
        timestamp: "2026-05-10T12:00:03.000Z",
        category: "runtime",
        payload: { type: "after_cleanup" },
      },
    });
    expect(onEvent).toHaveBeenCalledTimes(2);
  });
});

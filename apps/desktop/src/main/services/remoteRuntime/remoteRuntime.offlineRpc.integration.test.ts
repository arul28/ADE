import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "ssh2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startJsonRpcServer, type JsonRpcHandler, type JsonRpcTransport } from "../../../../../ade-cli/src/jsonrpc";
import { createMultiProjectRpcRequestHandler } from "../../../../../ade-cli/src/multiProjectRpcServer";
import { createEventBuffer } from "../../../../../ade-cli/src/eventBuffer";
import { ProjectRegistry } from "../../../../../ade-cli/src/services/projects/projectRegistry";
import type { ProjectScopeRegistry } from "../../../../../ade-cli/src/services/projects/projectScope";
import type { RemoteRuntimeTarget } from "../../../shared/types/remoteRuntime";
import type { RemoteTargetRegistry } from "./remoteTargetRegistry";
import { RuntimeRpcClient, type RuntimeRpcTransport } from "./runtimeRpcClient";

const bootstrapRemoteRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/mock/app",
  },
}));

vi.mock("./remoteBootstrap", () => ({
  bootstrapRemoteRuntime: bootstrapRemoteRuntimeMock,
  ensureRemoteProject: vi.fn(),
}));

import { RemoteConnectionPool } from "./remoteConnectionPool";

type NotifiableHandler = JsonRpcHandler & {
  dispose?: () => void;
  setNotifier?: (notify: ((method: string, params?: unknown) => void) | null) => void;
};

class LinkedRuntimeTransport implements RuntimeRpcTransport {
  private readonly dataCallbacks = new Set<(chunk: Buffer) => void>();
  private readonly closeCallbacks = new Set<() => void>();
  private readonly errorCallbacks = new Set<(error: Error) => void>();
  private peer: LinkedRuntimeTransport | null = null;
  private closed = false;

  connect(peer: LinkedRuntimeTransport): void {
    this.peer = peer;
  }

  onData(callback: (chunk: Buffer) => void): void {
    this.dataCallbacks.add(callback);
  }

  onClose(callback: () => void): void {
    this.closeCallbacks.add(callback);
  }

  onError(callback: (error: Error) => void): void {
    this.errorCallbacks.add(callback);
  }

  write(data: string): void {
    if (this.closed) throw new Error("Transport is closed.");
    const peer = this.peer;
    if (!peer || peer.closed) throw new Error("Remote runtime connection closed.");
    queueMicrotask(() => peer.emitData(Buffer.from(data, "utf8")));
  }

  close(): void {
    this.closeBoth();
  }

  fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const callback of [...this.errorCallbacks]) callback(error);
    for (const callback of [...this.closeCallbacks]) callback();
    this.peer?.closeLocal();
  }

  private closeBoth(): void {
    this.closeLocal();
    this.peer?.closeLocal();
  }

  private closeLocal(): void {
    if (this.closed) return;
    this.closed = true;
    for (const callback of [...this.closeCallbacks]) callback();
  }

  private emitData(chunk: Buffer): void {
    if (this.closed) return;
    for (const callback of [...this.dataCallbacks]) callback(chunk);
  }
}

function linkedTransports(): { client: LinkedRuntimeTransport; server: LinkedRuntimeTransport } {
  const client = new LinkedRuntimeTransport();
  const server = new LinkedRuntimeTransport();
  client.connect(server);
  server.connect(client);
  return { client, server };
}

function startRuntimeClient(handler: NotifiableHandler): {
  client: RuntimeRpcClient;
  close: () => void;
  serverTransport: LinkedRuntimeTransport;
} {
  const transports = linkedTransports();
  const stop = startJsonRpcServer(handler, transports.server as JsonRpcTransport, { nonFatal: true });
  handler.setNotifier?.((method, params) => stop.notify(method, params));
  const client = new RuntimeRpcClient(transports.client, 5_000);
  return {
    client,
    serverTransport: transports.server,
    close: () => {
      stop();
      handler.dispose?.();
      client.close();
    },
  };
}

function createSsh(): Client {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const ssh: {
    end: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
  } = {
    end: vi.fn(),
    once: vi.fn((event: string, callback: (...args: unknown[]) => void): typeof ssh => {
      const existing = listeners.get(event) ?? [];
      existing.push(callback);
      listeners.set(event, existing);
      return ssh;
    }),
  };
  return ssh as unknown as Client;
}

function createRegistry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-desktop-remote-rpc-"));
  const projectRoot = path.join(root, "project");
  fs.mkdirSync(projectRoot, { recursive: true });
  const registry = new ProjectRegistry({
    adeDir: path.join(root, "home"),
    projectsPath: path.join(root, "home", "projects.json"),
    secretsDir: path.join(root, "home", "secrets"),
    sockDir: path.join(root, "home", "sock"),
    socketPath: path.join(root, "home", "sock", "ade.sock"),
    binDir: path.join(root, "home", "bin"),
    runtimeDir: path.join(root, "home", "runtime"),
  });
  return { root, projectRoot, registry };
}

function createRuntime(projectRoot: string) {
  const operation = { operationId: "op-1" };
  const runGraph = {
    run: {
      id: "run-1",
      missionId: "mission-1",
      status: "running",
      metadata: {},
    },
    steps: [],
    attempts: [],
    edges: [],
    timeline: [],
    contextSnapshots: [],
    handoffs: [],
    runtimeEvents: [],
  };
  return {
    projectRoot,
    workspaceRoot: projectRoot,
    projectId: "project-1",
    project: { rootPath: projectRoot, displayName: "project", baseRef: "main" },
    paths: {
      adeDir: path.join(projectRoot, ".ade"),
      logsDir: path.join(projectRoot, ".ade", "logs"),
      processLogsDir: path.join(projectRoot, ".ade", "logs", "processes"),
      testLogsDir: path.join(projectRoot, ".ade", "logs", "tests"),
      transcriptsDir: path.join(projectRoot, ".ade", "transcripts"),
      worktreesDir: path.join(projectRoot, ".ade", "worktrees"),
      dbPath: path.join(projectRoot, ".ade", "ade.db"),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    laneService: {
      list: vi.fn(async () => [{ id: "lane-main", name: "Main", archivedAt: null }]),
      listUnregisteredWorktrees: vi.fn(async () => []),
    },
    sessionService: {
      get: vi.fn(),
      readTranscriptTail: vi.fn(() => ""),
    },
    operationService: {
      start: vi.fn(() => operation),
      finish: vi.fn(),
      list: vi.fn(() => []),
    },
    eventBuffer: createEventBuffer(),
    orchestratorService: {
      listRuns: vi.fn(() => [runGraph.run]),
      getRunGraph: vi.fn(() => runGraph),
    },
    dispose: vi.fn(),
  };
}

function createScopeRegistry(projectId: string, runtime: ReturnType<typeof createRuntime>): ProjectScopeRegistry {
  return {
    get: vi.fn(async () => ({
      registryProjectId: projectId,
      record: {
        projectId,
        rootPath: runtime.projectRoot,
        displayName: "project",
        addedAt: 1,
        lastOpenedAt: 1,
        gitOriginUrl: null,
      },
      runtime,
      dispose: vi.fn(),
    })),
    ensureSyncHost: vi.fn(),
    dispose: vi.fn(),
    disposeAll: vi.fn(),
  } as unknown as ProjectScopeRegistry;
}

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

describe("remote runtime offline RPC integration", () => {
  const clients: Array<{ close: () => void }> = [];

  beforeEach(() => {
    bootstrapRemoteRuntimeMock.mockReset();
  });

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close();
    }
  });

  it("routes a remote lane action through real JSON-RPC and the multi-project handler", async () => {
    const { projectRoot, registry } = createRegistry();
    const project = registry.add(projectRoot);
    const runtime = createRuntime(projectRoot);
    const scopeRegistry = createScopeRegistry(project.projectId, runtime);
    const handler = createMultiProjectRpcRequestHandler({
      serverVersion: "1.2.3",
      projectRegistry: registry,
      scopeRegistry,
      disposeScopesOnDispose: false,
    });
    const runtimeClient = startRuntimeClient(handler);
    clients.push(runtimeClient);
    await runtimeClient.client.initialize("desktop-offline-test", "1.2.3");
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: runtimeClient.client,
      ssh: createSsh(),
      result: {
        target,
        arch: "linux-x64",
        version: "1.2.3",
        projects: [project],
      },
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.2.3");

    await expect(pool.callActionForTarget(target, project.projectId, {
      domain: "lane",
      action: "list",
      args: { includeArchived: false },
    })).resolves.toEqual({
      domain: "lane",
      action: "list",
      result: [{ id: "lane-main", name: "Main", archivedAt: null }],
      statusHints: {
        operationId: null,
        testRunId: null,
        chatSessionId: null,
        runId: null,
        missionId: null,
      },
    });

    expect(runtime.laneService.list).toHaveBeenCalledWith({ includeArchived: false });
    expect(scopeRegistry.get).toHaveBeenCalledWith(project.projectId);
  });

  it("retries a project registry read after the JSON-RPC transport disconnects mid-request", async () => {
    const { projectRoot, registry } = createRegistry();
    const project = registry.add(projectRoot);
    const firstHandler: JsonRpcHandler = async (request) => {
      if (request.method === "projects.list") {
        firstRuntime.serverTransport.fail(new Error("channel closed"));
        await new Promise(() => {});
      }
      return request.method === "ade/initialize"
        ? { runtimeInfo: { version: "1.2.3", multiProject: true }, capabilities: { projects: true } }
        : {};
    };
    const firstRuntime = startRuntimeClient(firstHandler);
    const secondHandler = createMultiProjectRpcRequestHandler({
      serverVersion: "1.2.4",
      projectRegistry: registry,
      disposeScopesOnDispose: false,
    });
    const secondRuntime = startRuntimeClient(secondHandler);
    clients.push(firstRuntime, secondRuntime);
    await firstRuntime.client.initialize("desktop-offline-test", "1.2.3");
    await secondRuntime.client.initialize("desktop-offline-test", "1.2.4");
    bootstrapRemoteRuntimeMock
      .mockResolvedValueOnce({
        client: firstRuntime.client,
        ssh: createSsh(),
        result: { target, arch: "linux-x64", version: "1.2.3", projects: [] },
      })
      .mockResolvedValueOnce({
        client: secondRuntime.client,
        ssh: createSsh(),
        result: { target, arch: "linux-x64", version: "1.2.4", projects: [project] },
      });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.2.4");

    await expect(pool.projectsForTarget(target)).resolves.toEqual([project]);
    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
  });

  it("reconnects but does not replay an interrupted mutating action", async () => {
    const { projectRoot, registry } = createRegistry();
    const project = registry.add(projectRoot);
    const firstHandler: JsonRpcHandler = async (request) => {
      if (request.method === "ade/actions/call") {
        firstRuntime.serverTransport.fail(new Error("channel closed"));
        await new Promise(() => {});
      }
      return request.method === "ade/initialize"
        ? { runtimeInfo: { version: "1.2.3", multiProject: true }, capabilities: { projects: true } }
        : {};
    };
    const firstRuntime = startRuntimeClient(firstHandler);
    const secondHandler = vi.fn(async () => ({
      runtimeInfo: { version: "1.2.4", multiProject: true },
      capabilities: { projects: true },
    }));
    const secondRuntime = startRuntimeClient(secondHandler);
    clients.push(firstRuntime, secondRuntime);
    await firstRuntime.client.initialize("desktop-offline-test", "1.2.3");
    await secondRuntime.client.initialize("desktop-offline-test", "1.2.4");
    bootstrapRemoteRuntimeMock
      .mockResolvedValueOnce({
        client: firstRuntime.client,
        ssh: createSsh(),
        result: { target, arch: "linux-x64", version: "1.2.3", projects: [project] },
      })
      .mockResolvedValueOnce({
        client: secondRuntime.client,
        ssh: createSsh(),
        result: { target, arch: "linux-x64", version: "1.2.4", projects: [project] },
      });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.2.4");

    await expect(pool.callActionForTarget(target, project.projectId, {
      domain: "orchestrator_core",
      action: "resumeRun",
      args: { runId: "run-1" },
    })).rejects.toThrow(/retry the action/i);

    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
    expect(secondHandler).not.toHaveBeenCalledWith(expect.objectContaining({ method: "ade/actions/call" }));
  });

  it("reattaches to checkpointed run state and missed events after reconnect", async () => {
    const { projectRoot, registry } = createRegistry();
    const project = registry.add(projectRoot);
    const runtime = createRuntime(projectRoot);
    const scopeRegistry = createScopeRegistry(project.projectId, runtime);
    const handler = createMultiProjectRpcRequestHandler({
      serverVersion: "1.2.4",
      projectRegistry: registry,
      scopeRegistry,
      disposeScopesOnDispose: false,
    });
    runtime.eventBuffer.push({
      timestamp: "2026-05-10T12:00:00.000Z",
      category: "mission",
      payload: { type: "mission_started", missionId: "mission-1", runId: "run-1" },
    });
    const firstRuntime = startRuntimeClient(handler);
    const secondRuntime = startRuntimeClient(handler);
    clients.push(firstRuntime, secondRuntime);
    await firstRuntime.client.initialize("desktop-offline-test", "1.2.3");
    await secondRuntime.client.initialize("desktop-offline-test", "1.2.4");
    bootstrapRemoteRuntimeMock
      .mockResolvedValueOnce({
        client: firstRuntime.client,
        ssh: createSsh(),
        result: { target, arch: "linux-x64", version: "1.2.3", projects: [project] },
      })
      .mockResolvedValueOnce({
        client: secondRuntime.client,
        ssh: createSsh(),
        result: { target, arch: "linux-x64", version: "1.2.4", projects: [project] },
      });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.2.4");

    const initialEvents = await pool.streamEventsForTarget(target, project.projectId, {
      cursor: 0,
      limit: 10,
    });
    expect(initialEvents.events.map((event) => event.payload.type)).toEqual(["mission_started"]);
    expect(initialEvents.nextCursor).toBe(1);

    runtime.eventBuffer.push({
      timestamp: "2026-05-10T12:00:01.000Z",
      category: "mission",
      payload: { type: "mission_resume_recovered", missionId: "mission-1", runId: "run-1" },
    });
    firstRuntime.serverTransport.fail(new Error("channel closed"));

    await expect(pool.streamEventsForTarget(target, project.projectId, {
      cursor: initialEvents.nextCursor,
      limit: 10,
    })).resolves.toMatchObject({
      events: [{
        id: 2,
        category: "mission",
        payload: { type: "mission_resume_recovered", missionId: "mission-1", runId: "run-1" },
      }],
      nextCursor: 2,
      hasMore: false,
    });

    await expect(pool.callActionForTarget(target, project.projectId, {
      domain: "orchestrator_core",
      action: "getRunGraph",
      args: { runId: "run-1", timelineLimit: 0 },
    })).resolves.toMatchObject({
      domain: "orchestrator_core",
      action: "getRunGraph",
      result: {
        run: { id: "run-1", missionId: "mission-1", status: "running" },
      },
    });
    expect(runtime.orchestratorService.getRunGraph).toHaveBeenCalledWith({ runId: "run-1", timelineLimit: 0 });
    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
  });
});

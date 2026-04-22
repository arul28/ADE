import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { openKvDb } from "../state/kvDb";
import { isCrsqliteAvailable } from "../state/crsqliteExtension";
import { createSyncHostService } from "./syncHostService";
import type { SyncPinStore } from "./syncPinStore";
import { encodeSyncEnvelope, parseSyncEnvelope } from "./syncProtocol";
import type { ParsedSyncEnvelope } from "./syncProtocol";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

function createStubPinStore(initialPin: string | null = null): SyncPinStore {
  let pin = initialPin;
  return {
    getPin: () => pin,
    hasPin: () => pin != null,
    verifyPin: (value: string) => pin === value.trim(),
    setPin: (value: string) => {
      if (!/^\d{6}$/.test(value)) throw new Error("PIN must be 6 digits.");
      pin = value;
    },
    clearPin: () => { pin = null; },
  };
}

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

function makeProjectRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, ".ade", "artifacts"), { recursive: true });
  return root;
}

function makeDbPath(prefix: string): string {
  return path.join(makeProjectRoot(prefix), ".ade", "ade.db");
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition.");
}

function toText(raw: Buffer | ArrayBuffer | Buffer[]): string {
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

function createMessageQueue(ws: WebSocket) {
  const queued: ParsedSyncEnvelope[] = [];
  const waiters: Array<{
    type: string;
    resolve: (value: ParsedSyncEnvelope) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  ws.on("message", (raw) => {
    const parsed = parseSyncEnvelope(toText(raw as Buffer));
    const matchIndex = waiters.findIndex((entry) => entry.type === parsed.type);
    if (matchIndex >= 0) {
      const waiter = waiters.splice(matchIndex, 1)[0]!;
      clearTimeout(waiter.timer);
      waiter.resolve(parsed);
      return;
    }
    queued.push(parsed);
  });

  return {
    next(type: ParsedSyncEnvelope["type"], timeoutMs = 5_000): Promise<ParsedSyncEnvelope> {
      const queuedIndex = queued.findIndex((entry) => entry.type === type);
      if (queuedIndex >= 0) {
        return Promise.resolve(queued.splice(queuedIndex, 1)[0]!);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((entry) => entry.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for ${type}`));
        }, timeoutMs);
        waiters.push({ type, resolve, reject, timer });
      });
    },
  };
}

async function connectClient(args: {
  port: number;
  token: string;
  deviceId: string;
  deviceName: string;
  siteId: string;
  dbVersion: number;
  platform?: "macOS" | "linux" | "windows" | "iOS" | "unknown";
  deviceType?: "desktop" | "phone" | "vps" | "unknown";
}) {
  const ws = new WebSocket(`ws://127.0.0.1:${args.port}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const queue = createMessageQueue(ws);
  ws.send(encodeSyncEnvelope({
    type: "hello",
    requestId: "hello",
    payload: {
      token: args.token,
      peer: {
        deviceId: args.deviceId,
        deviceName: args.deviceName,
        platform: args.platform ?? "macOS",
        deviceType: args.deviceType ?? "desktop",
        siteId: args.siteId,
        dbVersion: args.dbVersion,
      },
    },
    compressionThresholdBytes: 100_000,
  }));
  const helloOk = await queue.next("hello_ok");
  return {
    ws,
    queue,
    helloOk,
    close: async () => {
      ws.close();
      await new Promise((resolve) => ws.once("close", resolve));
    },
  };
}

function createStubFileService(workspaceRoot: string) {
  const resolveWorkspacePath = (relPath: string) => {
    const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    const absolute = path.resolve(workspaceRoot, normalized);
    if (!absolute.startsWith(workspaceRoot)) {
      throw new Error("Refusing to access path outside workspace");
    }
    if (absolute.split(path.sep).includes(".git")) {
      throw new Error("Refusing to access .git internals");
    }
    return absolute;
  };

  return {
    listWorkspaces: () => [{
      id: "workspace-1",
      kind: "primary",
      laneId: "lane-1",
      name: "Primary",
      rootPath: workspaceRoot,
      isReadOnlyByDefault: false,
      mobileReadOnly: true,
    }],
    listTree: async () => [{
      name: "notes.txt",
      path: "notes.txt",
      type: "file",
      changeStatus: null,
      size: fs.existsSync(path.join(workspaceRoot, "notes.txt")) ? fs.statSync(path.join(workspaceRoot, "notes.txt")).size : 0,
    }],
    readFile: ({ path: relPath }: { path: string }) => {
      const absolute = resolveWorkspacePath(relPath);
      const content = fs.readFileSync(absolute, "utf8");
      return {
        content,
        encoding: "utf-8",
        size: Buffer.byteLength(content, "utf8"),
        languageId: "plaintext",
        isBinary: false,
      };
    },
    writeWorkspaceText: ({ path: relPath, text }: { path: string; text: string }) => {
      const absolute = resolveWorkspacePath(relPath);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, text, "utf8");
    },
    createFile: ({ path: relPath, content }: { path: string; content?: string }) => {
      const absolute = resolveWorkspacePath(relPath);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content ?? "", "utf8");
    },
    createDirectory: ({ path: relPath }: { path: string }) => {
      fs.mkdirSync(resolveWorkspacePath(relPath), { recursive: true });
    },
    rename: ({ oldPath, newPath }: { oldPath: string; newPath: string }) => {
      fs.mkdirSync(path.dirname(resolveWorkspacePath(newPath)), { recursive: true });
      fs.renameSync(resolveWorkspacePath(oldPath), resolveWorkspacePath(newPath));
    },
    deletePath: ({ path: relPath }: { path: string }) => {
      fs.rmSync(resolveWorkspacePath(relPath), { recursive: true, force: true });
    },
    quickOpen: async ({ query }: { query: string }) => [{ path: `${query}.txt`, score: 1 }],
    searchText: async ({ query }: { query: string }) => [{ path: "notes.txt", line: 1, column: 1, preview: query }],
    dispose: () => {},
  };
}

function createStubChatService() {
  let listener: ((event: unknown) => void) | null = null;
  const baseSession = {
    sessionId: "session-1",
    laneId: "lane-1",
    provider: "claude",
    model: "claude-3.5-sonnet",
    status: "idle",
    startedAt: "2026-03-17T00:10:00.000Z",
    lastActivityAt: "2026-03-17T00:10:00.000Z",
  };

  const service = {
    subscribeToEvents: vi.fn((callback: (event: unknown) => void) => {
      listener = callback;
      return () => {
        if (listener === callback) {
          listener = null;
        }
      };
    }),
    interrupt: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    approveToolUse: vi.fn().mockResolvedValue(undefined),
    respondToInput: vi.fn().mockResolvedValue(undefined),
    resumeSession: vi.fn().mockResolvedValue(baseSession),
    updateSession: vi.fn().mockResolvedValue(baseSession),
    dispose: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockResolvedValue([]),
    getSessionSummary: vi.fn().mockResolvedValue(null),
    getChatTranscript: vi.fn().mockResolvedValue([]),
    createSession: vi.fn().mockResolvedValue(baseSession),
    getAvailableModels: vi.fn().mockResolvedValue([]),
    getSlashCommands: vi.fn().mockResolvedValue([]),
  } as const;

  return {
    service: service as any,
    emit: (event: unknown) => {
      listener?.(event);
    },
  };
}

async function sendCommand(ws: WebSocket, queue: ReturnType<typeof createMessageQueue>, payload: {
  commandId: string;
  action: string;
  args: Record<string, unknown>;
}) {
  ws.send(encodeSyncEnvelope({
    type: "command",
    requestId: payload.commandId,
    payload,
  }));
  const ack = await queue.next("command_ack");
  const result = await queue.next("command_result");
  return { ack, result };
}

const activeDisposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (activeDisposers.length > 0) {
    const dispose = activeDisposers.pop();
    if (dispose) await dispose();
  }
  execFileMock.mockReset();
});

describe.skipIf(!isCrsqliteAvailable())("syncHostService", () => {
  it("retries tailnet discovery after a serve failure", async () => {
    const previousEnv = {
      ADE_TAILSCALE_CLI: process.env.ADE_TAILSCALE_CLI,
      ADE_TAILSCALE_SERVE: process.env.ADE_TAILSCALE_SERVE,
      NODE_ENV: process.env.NODE_ENV,
      VITEST: process.env.VITEST,
    };
    process.env.ADE_TAILSCALE_CLI = "tailscale-test";
    process.env.ADE_TAILSCALE_SERVE = "1";
    process.env.NODE_ENV = "development";
    delete process.env.VITEST;
    execFileMock.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      const error = Object.assign(new Error("tailscale serve failed"), { stderr: "pending approval" });
      queueMicrotask(() => callback(error, "", "pending approval"));
      return {} as never;
    });

    const projectRoot = makeProjectRoot("ade-sync-host-tailnet-retry-");
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const db = await openKvDb(makeDbPath("ade-sync-host-tailnet-retry-db-"), createLogger() as any);
    const host = createSyncHostService({
      db,
      logger: createLogger() as any,
      projectRoot,
      port: 0,
      pinStore: createStubPinStore(),
      fileService: createStubFileService(workspaceRoot) as any,
      laneService: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        archive: vi.fn(),
      } as any,
      prService: {
        listAll: async () => [],
        getDetail: async () => null,
        getStatus: async () => null,
        getChecks: async () => [],
        getReviews: async () => [],
        getComments: async () => [],
        getFiles: async () => [],
        createFromLane: async () => ({}),
        land: async () => ({}),
        closePr: async () => {},
        requestReviewers: async () => {},
      } as any,
      sessionService: { list: () => [] } as any,
      ptyService: {
        enrichSessions: (rows: any[]) => rows,
      } as any,
      computerUseArtifactBrokerService: {} as any,
    });
    activeDisposers.push(async () => {
      await host.dispose();
      db.close();
      if (previousEnv.ADE_TAILSCALE_CLI === undefined) {
        delete process.env.ADE_TAILSCALE_CLI;
      } else {
        process.env.ADE_TAILSCALE_CLI = previousEnv.ADE_TAILSCALE_CLI;
      }
      if (previousEnv.ADE_TAILSCALE_SERVE === undefined) {
        delete process.env.ADE_TAILSCALE_SERVE;
      } else {
        process.env.ADE_TAILSCALE_SERVE = previousEnv.ADE_TAILSCALE_SERVE;
      }
      if (previousEnv.NODE_ENV === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousEnv.NODE_ENV;
      }
      if (previousEnv.VITEST === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = previousEnv.VITEST;
      }
    });

    await host.waitUntilListening();
    await waitFor(() => execFileMock.mock.calls.length === 1);
    await waitFor(() => host.getTailnetDiscoveryStatus().state === "pending_approval");

    host.refreshLanDiscovery();

    await waitFor(() => execFileMock.mock.calls.length === 2);
  });

  it("rejects host startup quickly when the requested port is already taken", async () => {
    const projectRoot = makeProjectRoot("ade-sync-host-port-conflict-");
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const db = await openKvDb(makeDbPath("ade-sync-host-port-conflict-db-"), createLogger() as any);
    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, () => resolve());
    });
    const blockedPort = (blocker.address() as net.AddressInfo).port;

    const host = createSyncHostService({
      db,
      logger: createLogger() as any,
      projectRoot,
      port: blockedPort,
      pinStore: createStubPinStore(),
      fileService: createStubFileService(workspaceRoot) as any,
      laneService: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        archive: vi.fn(),
      } as any,
      prService: {
        listAll: async () => [],
        getDetail: async () => null,
        getStatus: async () => null,
        getChecks: async () => [],
        getReviews: async () => [],
        getComments: async () => [],
        getFiles: async () => [],
        createFromLane: async () => ({}),
        land: async () => ({}),
        closePr: async () => {},
        requestReviewers: async () => {},
      } as any,
      sessionService: { list: () => [] } as any,
      ptyService: {
        enrichSessions: (rows: any[]) => rows,
      } as any,
      computerUseArtifactBrokerService: {} as any,
    });

    activeDisposers.push(async () => {
      await host.dispose();
      db.close();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    });

    await expect(host.waitUntilListening()).rejects.toMatchObject({ code: "EADDRINUSE" });
  }, 30_000);

  it("advertises the mobile project catalog and handles project switch requests", async () => {
    const brainDb = await openKvDb(makeDbPath("ade-sync-project-catalog-"), createLogger() as any);
    const projectRoot = makeProjectRoot("ade-sync-project-catalog-project-");
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const project = {
      id: "project-1",
      displayName: "ADE",
      rootPath: projectRoot,
      defaultBaseRef: "main",
      lastOpenedAt: "2026-04-22T12:00:00.000Z",
      laneCount: 4,
      isAvailable: true,
      isCached: false,
    };
    const connection = {
      authKind: "bootstrap" as const,
      token: "project-bootstrap-token",
      hostIdentity: {
        deviceId: "host-1",
        siteId: "host-site-1",
        name: "ADE Desktop",
        platform: "macOS" as const,
        deviceType: "desktop" as const,
      },
      port: 8788,
      addressCandidates: [{ host: "192.168.1.24", kind: "lan" as const }],
    };
    const projectCatalogProvider = {
      listProjects: vi.fn(async () => ({ projects: [project] })),
      prepareProjectConnection: vi.fn(async () => ({
        ok: true,
        project: { ...project, id: "project-row-1", isCached: true },
        connection,
      })),
    };

    const host = createSyncHostService({
      db: brainDb,
      logger: createLogger() as any,
      projectRoot,
      port: 0,
      pinStore: createStubPinStore(),
      fileService: createStubFileService(workspaceRoot) as any,
      laneService: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        archive: vi.fn(),
      } as any,
      prService: {
        listAll: vi.fn().mockResolvedValue([]),
        getDetail: vi.fn(),
        getStatus: vi.fn(),
        getChecks: vi.fn(),
        getReviews: vi.fn(),
        getComments: vi.fn(),
        getFiles: vi.fn(),
        createFromLane: vi.fn(),
        land: vi.fn(),
        closePr: vi.fn(),
        requestReviewers: vi.fn(),
      } as any,
      sessionService: {
        list: () => [],
        get: () => null,
        readTranscriptTail: async () => "",
      } as any,
      ptyService: {
        create: vi.fn(),
        enrichSessions: (rows: any[]) => rows,
      } as any,
      computerUseArtifactBrokerService: {
        listArtifacts: () => [],
      } as any,
      projectCatalogProvider,
    });
    activeDisposers.push(async () => {
      await host.dispose();
      brainDb.close();
    });

    const port = await host.waitUntilListening();
    const client = await connectClient({
      port,
      token: host.getBootstrapToken(),
      deviceId: "ios-phone-1",
      deviceName: "Arul iPhone",
      siteId: "ios-site-1",
      dbVersion: 0,
      platform: "iOS",
      deviceType: "phone",
    });

    const helloPayload = client.helloOk.payload as {
      projects?: unknown[];
      features: { projectCatalog?: { enabled: boolean } };
    };
    expect(helloPayload.projects).toEqual([project]);
    expect(helloPayload.features.projectCatalog?.enabled).toBe(true);

    client.ws.send(encodeSyncEnvelope({
      type: "project_catalog_request",
      requestId: "catalog-1",
      payload: {},
    }));
    const catalog = await client.queue.next("project_catalog");
    expect(catalog.requestId).toBe("catalog-1");
    expect(catalog.payload).toEqual({ projects: [project] });

    client.ws.send(encodeSyncEnvelope({
      type: "project_switch_request",
      requestId: "switch-1",
      payload: {
        projectId: project.id,
        rootPath: project.rootPath,
      },
    }));
    const switchResult = await client.queue.next("project_switch_result");
    expect(switchResult.requestId).toBe("switch-1");
    expect(switchResult.payload).toEqual({
      ok: true,
      project: { ...project, id: "project-row-1", isCached: true },
      connection,
    });
    expect(projectCatalogProvider.prepareProjectConnection).toHaveBeenCalledWith({
      projectId: project.id,
      rootPath: project.rootPath,
    });

    await client.close();
  });

  it("authenticates peers, relays CRDT changes, and rebroadcasts to other peers", async () => {
    const brainDb = await openKvDb(makeDbPath("ade-sync-brain-"), createLogger() as any);
    const dbA = await openKvDb(makeDbPath("ade-sync-peer-a-"), createLogger() as any);
    const dbB = await openKvDb(makeDbPath("ade-sync-peer-b-"), createLogger() as any);
    const projectRoot = makeProjectRoot("ade-sync-host-project-");
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const host = createSyncHostService({
      db: brainDb,
      logger: createLogger() as any,
      projectRoot,
      port: 0,
      pinStore: createStubPinStore(),
      fileService: createStubFileService(workspaceRoot) as any,
      laneService: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        archive: vi.fn(),
      } as any,
      prService: {
        listAll: vi.fn().mockResolvedValue([]),
        refresh: vi.fn().mockResolvedValue([
          {
            id: "pr-1",
            laneId: "lane-1",
            projectId: "project-1",
            repoOwner: "arul",
            repoName: "ade",
            githubPrNumber: 42,
            githubUrl: "https://github.com/arul/ade/pull/42",
            githubNodeId: "node-42",
            title: "Fix mobile hydration",
            state: "open",
            baseBranch: "main",
            headBranch: "ade/mobile-hydration",
            checksStatus: "pending",
            reviewStatus: "requested",
            additions: 12,
            deletions: 4,
            lastSyncedAt: "2026-03-17T00:10:00.000Z",
            createdAt: "2026-03-17T00:10:00.000Z",
            updatedAt: "2026-03-17T00:10:00.000Z",
          },
        ]),
        listSnapshots: vi.fn().mockReturnValue([
          {
            prId: "pr-1",
            detail: {
              prId: "pr-1",
              body: "Hydration fix",
              assignees: [],
              author: { login: "arul", avatarUrl: null },
              isDraft: false,
              labels: [],
              requestedReviewers: [],
              milestone: null,
              linkedIssues: [],
            },
            status: {
              prId: "pr-1",
              state: "open",
              checksStatus: "pending",
              reviewStatus: "requested",
              isMergeable: true,
              mergeConflicts: false,
              behindBaseBy: 0,
            },
            checks: [],
            reviews: [],
            comments: [],
            files: [],
            updatedAt: "2026-03-17T00:10:00.000Z",
          },
        ]),
        getDetail: vi.fn(),
        getStatus: vi.fn(),
        getChecks: vi.fn(),
        getReviews: vi.fn(),
        getComments: vi.fn(),
        getFiles: vi.fn(),
        createFromLane: vi.fn(),
        land: vi.fn(),
        closePr: vi.fn(),
        requestReviewers: vi.fn(),
      } as any,
      sessionService: {
        list: () => [],
        get: () => null,
        readTranscriptTail: async () => "",
      } as any,
      ptyService: {
        create: vi.fn(),
        enrichSessions: (rows: any[]) => rows,
      } as any,
      computerUseArtifactBrokerService: {
        listArtifacts: () => [],
      } as any,
    });
    activeDisposers.push(async () => {
      await host.dispose();
      brainDb.close();
      dbA.close();
      dbB.close();
    });

    const port = await host.waitUntilListening();
    const token = host.getBootstrapToken();
    const clientA = await connectClient({
      port,
      token,
      deviceId: "peer-a",
      deviceName: "Peer A",
      siteId: dbA.sync.getSiteId(),
      dbVersion: dbA.sync.getDbVersion(),
    });
    const clientB = await connectClient({
      port,
      token,
      deviceId: "peer-b",
      deviceName: "Peer B",
      siteId: dbB.sync.getSiteId(),
      dbVersion: dbB.sync.getDbVersion(),
    });
    activeDisposers.push(clientA.close, clientB.close);

    const beforeVersion = dbA.sync.getDbVersion();
    dbA.setJson("replicated-state", { value: "hello" });
    const changes = dbA.sync.exportChangesSince(beforeVersion);
    clientA.ws.send(encodeSyncEnvelope({
      type: "changeset_batch",
      requestId: "changes-a",
      payload: {
        reason: "relay",
        fromDbVersion: beforeVersion,
        toDbVersion: dbA.sync.getDbVersion(),
        changes,
      },
      compressionThresholdBytes: 100_000,
    }));

    await waitFor(() => {
      const replicated = brainDb.getJson<{ value: string }>("replicated-state");
      return replicated?.value === "hello";
    });

    const rebroadcast = await clientB.queue.next("changeset_batch");
    const payload = rebroadcast.payload as { changes: unknown[] };
    expect(payload.changes.length).toBeGreaterThan(0);
    dbB.sync.applyChanges(payload.changes as any);
    expect(dbB.getJson<{ value: string }>("replicated-state")).toEqual({ value: "hello" });
  }, 60_000);

  it("serves workspace file operations and artifact reads while blocking .git access", async () => {
    const brainDb = await openKvDb(makeDbPath("ade-sync-files-"), createLogger() as any);
    const projectRoot = makeProjectRoot("ade-sync-files-project-");
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(path.join(workspaceRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, ".ade", "artifacts", "computer-use"), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, "notes.txt"), "initial", "utf8");
    fs.writeFileSync(path.join(workspaceRoot, ".git", "config"), "[core]\n", "utf8");
    const artifactPath = path.join(projectRoot, ".ade", "artifacts", "computer-use", "shot.png");
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sync-artifact-outside-"));
    const outsideArtifact = path.join(outsideDir, "outside-artifact.txt");
    fs.writeFileSync(artifactPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

    const host = createSyncHostService({
      db: brainDb,
      logger: createLogger() as any,
      projectRoot,
      port: 0,
      pinStore: createStubPinStore(),
      fileService: createStubFileService(workspaceRoot) as any,
      laneService: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        archive: vi.fn(),
      } as any,
      prService: {
        listAll: vi.fn().mockResolvedValue([
          {
            id: "pr-1",
            laneId: "lane-1",
            projectId: "project-1",
            repoOwner: "arul",
            repoName: "ade",
            githubPrNumber: 42,
            githubUrl: "https://github.com/arul/ade/pull/42",
            githubNodeId: "node-42",
            title: "Fix mobile hydration",
            state: "open",
            baseBranch: "main",
            headBranch: "ade/mobile-hydration",
            checksStatus: "pending",
            reviewStatus: "requested",
            additions: 12,
            deletions: 4,
            lastSyncedAt: "2026-03-17T00:10:00.000Z",
            createdAt: "2026-03-17T00:10:00.000Z",
            updatedAt: "2026-03-17T00:10:00.000Z",
          },
        ]),
        refresh: vi.fn().mockResolvedValue([
          {
            id: "pr-1",
          },
        ]),
        listSnapshots: vi.fn().mockReturnValue([
          {
            prId: "pr-1",
            detail: {
              prId: "pr-1",
              body: "Hydration fix",
              assignees: [],
              author: { login: "arul", avatarUrl: null },
              isDraft: false,
              labels: [],
              requestedReviewers: [],
              milestone: null,
              linkedIssues: [],
            },
            status: {
              prId: "pr-1",
              state: "open",
              checksStatus: "pending",
              reviewStatus: "requested",
              isMergeable: true,
              mergeConflicts: false,
              behindBaseBy: 0,
            },
            checks: [],
            reviews: [],
            comments: [],
            files: [],
            updatedAt: "2026-03-17T00:10:00.000Z",
          },
        ]),
        getDetail: vi.fn(),
        getStatus: vi.fn(),
        getChecks: vi.fn(),
        getReviews: vi.fn(),
        getComments: vi.fn(),
        getFiles: vi.fn(),
        createFromLane: vi.fn(),
        land: vi.fn(),
        closePr: vi.fn(),
        requestReviewers: vi.fn(),
      } as any,
      sessionService: {
        list: () => [],
        get: () => null,
        readTranscriptTail: async () => "",
      } as any,
      ptyService: {
        create: vi.fn(),
        enrichSessions: (rows: any[]) => rows,
      } as any,
      computerUseArtifactBrokerService: {
        listArtifacts: ({ artifactId }: { artifactId?: string }) => artifactId === "artifact-1"
          ? [{ id: "artifact-1", uri: path.relative(projectRoot, artifactPath) }]
          : [],
      } as any,
    });
    activeDisposers.push(async () => {
      await host.dispose();
      brainDb.close();
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    const client = await connectClient({
      port: await host.waitUntilListening(),
      token: host.getBootstrapToken(),
      deviceId: "peer-files",
      deviceName: "Peer Files",
      siteId: brainDb.sync.getSiteId(),
      dbVersion: brainDb.sync.getDbVersion(),
    });
    activeDisposers.push(client.close);

    client.ws.send(encodeSyncEnvelope({
      type: "file_request",
      requestId: "write-text",
      payload: {
        action: "writeText",
        args: {
          workspaceId: "workspace-1",
          path: "notes.txt",
          text: "updated",
        },
      },
    }));
    const writeResponse = await client.queue.next("file_response");
    expect(writeResponse.requestId).toBe("write-text");
    expect(fs.readFileSync(path.join(workspaceRoot, "notes.txt"), "utf8")).toBe("updated");

    const phoneClient = await connectClient({
      port: await host.waitUntilListening(),
      token: host.getBootstrapToken(),
      deviceId: "peer-files-phone",
      deviceName: "Peer Files Phone",
      platform: "iOS",
      deviceType: "phone",
      siteId: "peer-files-phone-site",
      dbVersion: brainDb.sync.getDbVersion(),
    });
    activeDisposers.push(phoneClient.close);
    phoneClient.ws.send(encodeSyncEnvelope({
      type: "file_request",
      requestId: "mobile-write-text",
      payload: {
        action: "writeText",
        args: {
          workspaceId: "workspace-1",
          path: "notes.txt",
          text: "mobile update",
        },
      },
    }));
    const mobileWriteResponse = await phoneClient.queue.next("file_response");
    const mobileWritePayload = mobileWriteResponse.payload as { ok: boolean; error?: { message: string } };
    expect(mobileWriteResponse.requestId).toBe("mobile-write-text");
    expect(mobileWritePayload.ok).toBe(false);
    expect(mobileWritePayload.error?.message).toMatch(/read-only/i);
    expect(fs.readFileSync(path.join(workspaceRoot, "notes.txt"), "utf8")).toBe("updated");

    const atomicWrite = await sendCommand(phoneClient.ws, phoneClient.queue, {
      commandId: "mobile-atomic-write",
      action: "files.writeTextAtomic",
      args: {
        laneId: "lane-1",
        path: "notes.txt",
        text: "mobile atomic update",
      },
    });
    const atomicAckPayload = atomicWrite.ack.payload as { accepted: boolean; status: string };
    const atomicResultPayload = atomicWrite.result.payload as { ok: boolean; error?: { code: string; message: string } };
    expect(atomicAckPayload.accepted).toBe(false);
    expect(atomicAckPayload.status).toBe("rejected");
    expect(atomicResultPayload.ok).toBe(false);
    expect(atomicResultPayload.error?.code).toBe("mobile_read_only");
    expect(atomicResultPayload.error?.message).toMatch(/read-only/i);
    expect(fs.readFileSync(path.join(workspaceRoot, "notes.txt"), "utf8")).toBe("updated");

    client.ws.send(encodeSyncEnvelope({
      type: "file_request",
      requestId: "artifact-read",
      payload: {
        action: "readArtifact",
        args: {
          artifactId: "artifact-1",
        },
      },
    }));
    const artifactResponse = await client.queue.next("file_response");
    const artifactPayload = artifactResponse.payload as { ok: boolean; result: { encoding: string; content: string } };
    expect(artifactPayload.ok).toBe(true);
    expect(artifactPayload.result.encoding).toBe("base64");
    expect(Buffer.from(artifactPayload.result.content, "base64").length).toBeGreaterThan(0);

    const artifactLinkPath = path.join(projectRoot, ".ade", "artifacts", "linked-secret.txt");
    fs.writeFileSync(outsideArtifact, "secret", "utf8");
    fs.symlinkSync(outsideArtifact, artifactLinkPath);

    client.ws.send(encodeSyncEnvelope({
      type: "file_request",
      requestId: "artifact-link-read",
      payload: {
        action: "readArtifact",
        args: {
          path: path.relative(projectRoot, artifactLinkPath),
        },
      },
    }));
    const linkedArtifactResponse = await client.queue.next("file_response");
    const linkedArtifactPayload = linkedArtifactResponse.payload as { ok: boolean; error?: { message: string } };
    expect(linkedArtifactPayload.ok).toBe(false);
    expect(linkedArtifactPayload.error?.message).toMatch(/\.ade\/artifacts/i);

    client.ws.send(encodeSyncEnvelope({
      type: "file_request",
      requestId: "git-blocked",
      payload: {
        action: "readFile",
        args: {
          workspaceId: "workspace-1",
          path: ".git/config",
        },
      },
    }));
    const blockedResponse = await client.queue.next("file_response");
    const blockedPayload = blockedResponse.payload as { ok: boolean; error?: { message: string } };
    expect(blockedPayload.ok).toBe(false);
    expect(blockedPayload.error?.message).toMatch(/\.git/i);

    fs.rmSync(artifactLinkPath, { force: true });
    fs.rmSync(outsideArtifact, { force: true });
  });

  it("streams terminal snapshots, live output, exit events, and supports the quick-run seed command", async () => {
    const brainDb = await openKvDb(makeDbPath("ade-sync-terminal-"), createLogger() as any);
    const projectRoot = makeProjectRoot("ade-sync-terminal-project-");
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const createSpy = vi.fn().mockResolvedValue({ ptyId: "pty-1", sessionId: "session-1" });

    const host = createSyncHostService({
      db: brainDb,
      logger: createLogger() as any,
      projectRoot,
      port: 0,
      pinStore: createStubPinStore(),
      fileService: createStubFileService(workspaceRoot) as any,
      laneService: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        archive: vi.fn(),
      } as any,
      prService: {
        listAll: vi.fn().mockResolvedValue([
          {
            id: "pr-1",
            laneId: "lane-1",
            projectId: "project-1",
            repoOwner: "arul",
            repoName: "ade",
            githubPrNumber: 42,
            githubUrl: "https://github.com/arul/ade/pull/42",
            githubNodeId: "node-42",
            title: "Fix mobile hydration",
            state: "open",
            baseBranch: "main",
            headBranch: "ade/mobile-hydration",
            checksStatus: "pending",
            reviewStatus: "requested",
            additions: 12,
            deletions: 4,
            lastSyncedAt: "2026-03-17T00:10:00.000Z",
            createdAt: "2026-03-17T00:10:00.000Z",
            updatedAt: "2026-03-17T00:10:00.000Z",
          },
        ]),
        refresh: vi.fn().mockResolvedValue([
          {
            id: "pr-1",
          },
        ]),
        listSnapshots: vi.fn().mockReturnValue([
          {
            prId: "pr-1",
            detail: {
              prId: "pr-1",
              body: "Hydration fix",
              assignees: [],
              author: { login: "arul", avatarUrl: null },
              isDraft: false,
              labels: [],
              requestedReviewers: [],
              milestone: null,
              linkedIssues: [],
            },
            status: {
              prId: "pr-1",
              state: "open",
              checksStatus: "pending",
              reviewStatus: "requested",
              isMergeable: true,
              mergeConflicts: false,
              behindBaseBy: 0,
            },
            checks: [],
            reviews: [],
            comments: [],
            files: [],
            updatedAt: "2026-03-17T00:10:00.000Z",
          },
        ]),
        getDetail: vi.fn(),
        getStatus: vi.fn(),
        getChecks: vi.fn(),
        getReviews: vi.fn(),
        getComments: vi.fn(),
        getFiles: vi.fn(),
        createFromLane: vi.fn(),
        land: vi.fn(),
        closePr: vi.fn(),
        requestReviewers: vi.fn(),
      } as any,
      sessionService: {
        list: () => [
          {
            id: "session-1",
            laneId: "lane-1",
            laneName: "Primary",
            ptyId: "pty-1",
            tracked: true,
            pinned: false,
            goal: "Run tests",
            toolType: "run-shell",
            title: "npm test",
            status: "running",
            startedAt: "2026-03-17T00:10:00.000Z",
            endedAt: null,
            exitCode: null,
            transcriptPath: path.join(projectRoot, ".ade", "transcripts", "session-1.log"),
            headShaStart: null,
            headShaEnd: null,
            lastOutputPreview: "prior output",
            summary: null,
            runtimeState: "running",
            resumeCommand: "npm test",
          },
        ],
        get: () => ({
          id: "session-1",
          transcriptPath: path.join(projectRoot, ".ade", "transcripts", "session-1.log"),
          status: "running",
          runtimeState: "running",
          lastOutputPreview: "echo hi",
        }),
        readTranscriptTail: async () => "prior output\n",
      } as any,
      ptyService: {
        create: createSpy,
        enrichSessions: (rows: any[]) => rows,
      } as any,
      computerUseArtifactBrokerService: {
        listArtifacts: () => [],
      } as any,
    });
    activeDisposers.push(async () => {
      await host.dispose();
      brainDb.close();
    });

    const client = await connectClient({
      port: await host.waitUntilListening(),
      token: host.getBootstrapToken(),
      deviceId: "peer-terminal",
      deviceName: "Peer Terminal",
      siteId: brainDb.sync.getSiteId(),
      dbVersion: brainDb.sync.getDbVersion(),
    });
    activeDisposers.push(client.close);

    client.ws.send(encodeSyncEnvelope({
      type: "terminal_subscribe",
      requestId: "sub-1",
      payload: {
        sessionId: "session-1",
        maxBytes: 32_000,
      },
    }));
    const snapshot = await client.queue.next("terminal_snapshot");
    expect(snapshot.requestId).toBe("sub-1");
    expect((snapshot.payload as { transcript: string }).transcript).toContain("prior output");

    host.handlePtyData({
      ptyId: "pty-1",
      sessionId: "session-1",
      data: "live output\n",
    });
    const liveData = await client.queue.next("terminal_data");
    expect((liveData.payload as { data: string }).data).toBe("live output\n");

    host.handlePtyExit({
      ptyId: "pty-1",
      sessionId: "session-1",
      exitCode: 0,
    });
    const exitEvent = await client.queue.next("terminal_exit");
    expect((exitEvent.payload as { exitCode: number | null }).exitCode).toBe(0);

    client.ws.send(encodeSyncEnvelope({
      type: "command",
      requestId: "cmd-quick-run",
      payload: {
        commandId: "cmd-quick-run",
        action: "work.runQuickCommand",
        args: {
          laneId: "lane-1",
          title: "Run tests",
          startupCommand: "npm test",
        },
      },
    }));
    const ack = await client.queue.next("command_ack");
    expect((ack.payload as { accepted: boolean }).accepted).toBe(true);
    const result = await client.queue.next("command_result");
    expect((result.payload as { ok: boolean; result: { sessionId: string } }).result.sessionId).toBe("session-1");
    expect(createSpy).toHaveBeenCalledTimes(1);

    client.ws.send(encodeSyncEnvelope({
      type: "command",
      requestId: "cmd-work-list",
      payload: {
        commandId: "cmd-work-list",
        action: "work.listSessions",
        args: {},
      },
    }));
    const workListAck = await client.queue.next("command_ack");
    expect((workListAck.payload as { accepted: boolean }).accepted).toBe(true);
    const workListResult = await client.queue.next("command_result");
    const workSessions = (workListResult.payload as { ok: boolean; result: Array<{ id: string }> }).result;
    expect(workSessions.map((entry) => entry.id)).toEqual(["session-1"]);

    client.ws.send(encodeSyncEnvelope({
      type: "command",
      requestId: "cmd-pr-refresh",
      payload: {
        commandId: "cmd-pr-refresh",
        action: "prs.refresh",
        args: {},
      },
    }));
    const prRefreshAck = await client.queue.next("command_ack");
    expect((prRefreshAck.payload as { accepted: boolean }).accepted).toBe(true);
    const prRefreshResult = await client.queue.next("command_result");
    const prRefreshPayload = prRefreshResult.payload as {
      ok: boolean;
      result: {
        refreshedCount: number;
        prs: Array<{ id: string }>;
        snapshots: Array<{ prId: string }>;
      };
    };
    expect(prRefreshPayload.result.refreshedCount).toBe(1);
    expect(prRefreshPayload.result.prs.map((entry) => entry.id)).toEqual(["pr-1"]);
    expect(prRefreshPayload.result.snapshots.map((entry) => entry.prId)).toEqual(["pr-1"]);

    client.ws.send(encodeSyncEnvelope({
      type: "command",
      requestId: "cmd-unsupported",
      payload: {
        commandId: "cmd-unsupported",
        action: "prs.create",
        args: {},
      },
    }));
    const rejectedAck = await client.queue.next("command_ack");
    expect((rejectedAck.payload as { accepted: boolean }).accepted).toBe(false);
    const rejectedResult = await client.queue.next("command_result");
    expect((rejectedResult.payload as { ok: boolean; error?: { code: string } }).ok).toBe(false);
    expect((rejectedResult.payload as { ok: boolean; error?: { code: string } }).error?.code).toBe("unsupported_command");
  });

  it("broadcasts chat events to subscribed peers, supports multiple subscriptions, and stops after unsubscribe", async () => {
    const brainDb = await openKvDb(makeDbPath("ade-sync-chat-events-"), createLogger() as any);
    const projectRoot = makeProjectRoot("ade-sync-chat-events-project-");
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const chatService = createStubChatService();

    const host = createSyncHostService({
      db: brainDb,
      logger: createLogger() as any,
      projectRoot,
      port: 0,
      fileService: createStubFileService(workspaceRoot) as any,
      laneService: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        archive: vi.fn(),
      } as any,
      prService: {
        listAll: vi.fn().mockResolvedValue([]),
        refresh: vi.fn().mockResolvedValue([]),
        listSnapshots: vi.fn().mockReturnValue([]),
        getDetail: vi.fn(),
        getStatus: vi.fn(),
        getChecks: vi.fn(),
        getReviews: vi.fn(),
        getComments: vi.fn(),
        getFiles: vi.fn(),
        createFromLane: vi.fn(),
        land: vi.fn(),
        closePr: vi.fn(),
        requestReviewers: vi.fn(),
      } as any,
      sessionService: {
        list: () => [],
        get: () => null,
        readTranscriptTail: async () => "",
      } as any,
      ptyService: {
        create: vi.fn(),
      } as any,
      agentChatService: chatService.service,
      computerUseArtifactBrokerService: {
        listArtifacts: () => [],
      } as any,
      pinStore: createStubPinStore(),
    });
    activeDisposers.push(async () => {
      await host.dispose();
      brainDb.close();
    });

    const port = await host.waitUntilListening();
    const token = host.getBootstrapToken();
    const clientA = await connectClient({
      port,
      token,
      deviceId: "peer-chat-a",
      deviceName: "Peer Chat A",
      siteId: brainDb.sync.getSiteId(),
      dbVersion: brainDb.sync.getDbVersion(),
    });
    const clientB = await connectClient({
      port,
      token,
      deviceId: "peer-chat-b",
      deviceName: "Peer Chat B",
      siteId: brainDb.sync.getSiteId(),
      dbVersion: brainDb.sync.getDbVersion(),
    });
    activeDisposers.push(clientA.close, clientB.close);

    clientA.ws.send(encodeSyncEnvelope({
      type: "chat_subscribe",
      payload: { sessionId: "session-1" },
    }));
    clientB.ws.send(encodeSyncEnvelope({
      type: "chat_subscribe",
      payload: { sessionId: "session-1" },
    }));
    clientB.ws.send(encodeSyncEnvelope({
      type: "chat_subscribe",
      payload: { sessionId: "session-2" },
    }));
    await waitFor(() => {
      const peerA = host.getChatSubscriptionSnapshot().find((peer) => peer.deviceId === "peer-chat-a");
      const peerB = host.getChatSubscriptionSnapshot().find((peer) => peer.deviceId === "peer-chat-b");
      return Boolean(
        peerA?.subscribedChatSessionIds.includes("session-1")
        && peerB?.subscribedChatSessionIds.includes("session-1")
        && peerB?.subscribedChatSessionIds.includes("session-2")
      );
    });

    chatService.emit({
      sessionId: "session-1",
      timestamp: "2026-03-17T00:10:00.000Z",
      event: { type: "text", text: "hello from session 1", turnId: "turn-1", itemId: "item-1" },
      sequence: 1,
    });

    const eventA = await clientA.queue.next("chat_event");
    const eventB = await clientB.queue.next("chat_event");
    expect((eventA.payload as { sessionId: string; event: { text: string } }).sessionId).toBe("session-1");
    expect((eventA.payload as { sessionId: string; event: { text: string } }).event.text).toBe("hello from session 1");
    expect((eventB.payload as { sessionId: string }).sessionId).toBe("session-1");

    chatService.emit({
      sessionId: "session-2",
      timestamp: "2026-03-17T00:10:01.000Z",
      event: { type: "text", text: "hello from session 2", turnId: "turn-2", itemId: "item-2" },
      sequence: 2,
    });

    const session2Event = await clientB.queue.next("chat_event");
    expect((session2Event.payload as { sessionId: string; event: { text: string } }).sessionId).toBe("session-2");

    clientB.ws.send(encodeSyncEnvelope({
      type: "chat_unsubscribe",
      payload: { sessionId: "session-1" },
    }));
    await waitFor(() => !host.getChatSubscriptionSnapshot().find((peer) => peer.deviceId === "peer-chat-b")?.subscribedChatSessionIds.includes("session-1"));

    chatService.emit({
      sessionId: "session-1",
      timestamp: "2026-03-17T00:10:02.000Z",
      event: { type: "text", text: "still live for A only", turnId: "turn-3", itemId: "item-3" },
      sequence: 3,
    });

    const replayA = await clientA.queue.next("chat_event");
    expect((replayA.payload as { sessionId: string; event: { text: string } }).sessionId).toBe("session-1");
    await expect(clientB.queue.next("chat_event", 250)).rejects.toThrow(/Timed out waiting for chat_event/);
  }, 15_000);

  it("resubscribes chat listeners after reconnect and routes chat remote commands", async () => {
    const brainDb = await openKvDb(makeDbPath("ade-sync-chat-commands-"), createLogger() as any);
    const projectRoot = makeProjectRoot("ade-sync-chat-commands-project-");
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const chatService = createStubChatService();
    const baseSession = {
      sessionId: "session-1",
      laneId: "lane-1",
      provider: "claude",
      model: "claude-3.5-sonnet",
      status: "idle",
      startedAt: "2026-03-17T00:10:00.000Z",
      lastActivityAt: "2026-03-17T00:10:00.000Z",
    };
    chatService.service.resumeSession.mockResolvedValue(baseSession);
    chatService.service.updateSession.mockResolvedValue({ ...baseSession, title: "Updated title" });

    const host = createSyncHostService({
      db: brainDb,
      logger: createLogger() as any,
      projectRoot,
      port: 0,
      fileService: createStubFileService(workspaceRoot) as any,
      laneService: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        archive: vi.fn(),
      } as any,
      prService: {
        listAll: vi.fn().mockResolvedValue([]),
        refresh: vi.fn().mockResolvedValue([]),
        listSnapshots: vi.fn().mockReturnValue([]),
        getDetail: vi.fn(),
        getStatus: vi.fn(),
        getChecks: vi.fn(),
        getReviews: vi.fn(),
        getComments: vi.fn(),
        getFiles: vi.fn(),
        createFromLane: vi.fn(),
        land: vi.fn(),
        closePr: vi.fn(),
        requestReviewers: vi.fn(),
      } as any,
      sessionService: {
        list: () => [],
        get: () => null,
        readTranscriptTail: async () => "",
      } as any,
      ptyService: {
        create: vi.fn(),
      } as any,
      agentChatService: chatService.service,
      computerUseArtifactBrokerService: {
        listArtifacts: () => [],
      } as any,
      pinStore: createStubPinStore(),
    });
    activeDisposers.push(async () => {
      await host.dispose();
      brainDb.close();
    });

    const port = await host.waitUntilListening();
    const token = host.getBootstrapToken();
    const firstClient = await connectClient({
      port,
      token,
      deviceId: "peer-chat-command-a",
      deviceName: "Peer Chat Command A",
      siteId: brainDb.sync.getSiteId(),
      dbVersion: brainDb.sync.getDbVersion(),
    });
    activeDisposers.push(firstClient.close);

    firstClient.ws.send(encodeSyncEnvelope({
      type: "chat_subscribe",
      payload: { sessionId: "session-1" },
    }));
    await waitFor(() => Boolean(
      host.getChatSubscriptionSnapshot()
        .find((peer) => peer.deviceId === "peer-chat-command-a")
        ?.subscribedChatSessionIds.includes("session-1")
    ));
    chatService.emit({
      sessionId: "session-1",
      timestamp: "2026-03-17T00:10:03.000Z",
      event: { type: "text", text: "before reconnect", turnId: "turn-1" },
      sequence: 1,
    });
    const firstReconnectEvent = await firstClient.queue.next("chat_event");
    expect((firstReconnectEvent.payload as { sessionId: string }).sessionId).toBe("session-1");

    await firstClient.close();
    activeDisposers.pop();

    const secondClient = await connectClient({
      port,
      token,
      deviceId: "peer-chat-command-a",
      deviceName: "Peer Chat Command A",
      siteId: brainDb.sync.getSiteId(),
      dbVersion: brainDb.sync.getDbVersion(),
    });
    activeDisposers.push(secondClient.close);
    secondClient.ws.send(encodeSyncEnvelope({
      type: "chat_subscribe",
      payload: { sessionId: "session-1" },
    }));
    await waitFor(() => Boolean(
      host.getChatSubscriptionSnapshot()
        .find((peer) => peer.deviceId === "peer-chat-command-a")
        ?.subscribedChatSessionIds.includes("session-1")
    ));
    chatService.emit({
      sessionId: "session-1",
      timestamp: "2026-03-17T00:10:04.000Z",
      event: { type: "text", text: "after reconnect", turnId: "turn-2" },
      sequence: 2,
    });
    const secondReconnectEvent = await secondClient.queue.next("chat_event");
    expect((secondReconnectEvent.payload as { sessionId: string; event: { text: string } }).event.text).toBe("after reconnect");

    const interrupt = await sendCommand(secondClient.ws, secondClient.queue, {
      commandId: "chat-interrupt",
      action: "chat.interrupt",
      args: { sessionId: "session-1" },
    });
    expect((interrupt.result.payload as { ok: boolean }).ok).toBe(true);
    expect(chatService.service.interrupt).toHaveBeenCalledWith({ sessionId: "session-1" });

    const steer = await sendCommand(secondClient.ws, secondClient.queue, {
      commandId: "chat-steer",
      action: "chat.steer",
      args: { sessionId: "session-1", text: "Please continue." },
    });
    expect((steer.result.payload as { ok: boolean }).ok).toBe(true);
    expect(chatService.service.steer).toHaveBeenCalledWith({ sessionId: "session-1", text: "Please continue." });

    const approve = await sendCommand(secondClient.ws, secondClient.queue, {
      commandId: "chat-approve",
      action: "chat.approve",
      args: { sessionId: "session-1", itemId: "item-approve", decision: "accept", responseText: "Ship it" },
    });
    expect((approve.result.payload as { ok: boolean }).ok).toBe(true);
    expect(chatService.service.approveToolUse).toHaveBeenCalledWith({
      sessionId: "session-1",
      itemId: "item-approve",
      decision: "accept",
      responseText: "Ship it",
    });

    const respond = await sendCommand(secondClient.ws, secondClient.queue, {
      commandId: "chat-respond",
      action: "chat.respondToInput",
      args: {
        sessionId: "session-1",
        itemId: "item-question",
        decision: "decline",
        answers: { answer: "yes" },
        responseText: "No thanks",
      },
    });
    expect((respond.result.payload as { ok: boolean }).ok).toBe(true);
    expect(chatService.service.respondToInput).toHaveBeenCalledWith({
      sessionId: "session-1",
      itemId: "item-question",
      decision: "decline",
      answers: { answer: "yes" },
      responseText: "No thanks",
    });

    const resume = await sendCommand(secondClient.ws, secondClient.queue, {
      commandId: "chat-resume",
      action: "chat.resume",
      args: { sessionId: "session-1" },
    });
    expect((resume.result.payload as { ok: boolean; result: { sessionId: string } }).result.sessionId).toBe("session-1");
    expect(chatService.service.resumeSession).toHaveBeenCalledWith({ sessionId: "session-1" });

    const update = await sendCommand(secondClient.ws, secondClient.queue, {
      commandId: "chat-update",
      action: "chat.updateSession",
      args: {
        sessionId: "session-1",
        title: "Updated title",
        reasoningEffort: "high",
        permissionMode: "edit",
      },
    });
    expect((update.result.payload as { ok: boolean; result: { title?: string } }).result.title).toBe("Updated title");
    expect(chatService.service.updateSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      title: "Updated title",
      reasoningEffort: "high",
      permissionMode: "edit",
    }));

    const dispose = await sendCommand(secondClient.ws, secondClient.queue, {
      commandId: "chat-dispose",
      action: "chat.dispose",
      args: { sessionId: "session-1" },
    });
    expect((dispose.result.payload as { ok: boolean }).ok).toBe(true);
    expect(chatService.service.dispose).toHaveBeenCalledWith({ sessionId: "session-1" });
  }, 15_000);

  it("pairs a phone peer using the desktop PIN and allows paired reconnect auth", async () => {
    const brainDb = await openKvDb(makeDbPath("ade-sync-pairing-"), createLogger() as any);
    const projectRoot = makeProjectRoot("ade-sync-pairing-project-");
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const host = createSyncHostService({
      db: brainDb,
      logger: createLogger() as any,
      projectRoot,
      port: 0,
      pinStore: createStubPinStore("428193"),
      fileService: createStubFileService(workspaceRoot) as any,
      laneService: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        archive: vi.fn(),
      } as any,
      prService: {
        listAll: vi.fn().mockResolvedValue([]),
        getDetail: vi.fn(),
        getStatus: vi.fn(),
        getChecks: vi.fn(),
        getReviews: vi.fn(),
        getComments: vi.fn(),
        getFiles: vi.fn(),
        createFromLane: vi.fn(),
        land: vi.fn(),
        closePr: vi.fn(),
        requestReviewers: vi.fn(),
      } as any,
      sessionService: {
        list: () => [],
        get: () => null,
        readTranscriptTail: async () => "",
      } as any,
      ptyService: {
        create: vi.fn(),
        enrichSessions: (rows: any[]) => rows,
      } as any,
      computerUseArtifactBrokerService: {
        listArtifacts: () => [],
      } as any,
    });
    activeDisposers.push(async () => {
      await host.dispose();
      brainDb.close();
    });

    const port = await host.waitUntilListening();
    const pairWs = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      pairWs.once("open", () => resolve());
      pairWs.once("error", reject);
    });
    const pairQueue = createMessageQueue(pairWs);
    pairWs.send(encodeSyncEnvelope({
      type: "pairing_request",
      requestId: "pair-me",
      payload: {
        code: "428193",
        peer: {
          deviceId: "ios-phone-1",
          deviceName: "Arul iPhone",
          platform: "iOS",
          deviceType: "phone",
          siteId: "ios-site-1",
          dbVersion: 0,
        },
      },
    }));
    const pairingResponse = await pairQueue.next("pairing_result");
    const pairingPayload = pairingResponse.payload as { ok: boolean; deviceId?: string; secret?: string };
    expect(pairingPayload.ok).toBe(true);
    expect(pairingPayload.deviceId).toBe("ios-phone-1");
    expect(pairingPayload.secret).toBeTruthy();
    pairWs.close();
    await new Promise((resolve) => pairWs.once("close", resolve));

    const authWs = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      authWs.once("open", () => resolve());
      authWs.once("error", reject);
    });
    const authQueue = createMessageQueue(authWs);
    authWs.send(encodeSyncEnvelope({
      type: "hello",
      requestId: "hello-paired",
      payload: {
        peer: {
          deviceId: "ios-phone-1",
          deviceName: "Arul iPhone",
          platform: "iOS",
          deviceType: "phone",
          siteId: "ios-site-1",
          dbVersion: 0,
        },
        auth: {
          kind: "paired",
          deviceId: "ios-phone-1",
          secret: pairingPayload.secret,
        },
      },
    }));
    const helloOk = await authQueue.next("hello_ok");
    const helloPayload = helloOk.payload as {
      features: {
        chatStreaming: { enabled: boolean };
        pairingAuth: { enabled: boolean };
        commandRouting: {
          supportedActions: string[];
          actions: Array<{ action: string; policy: { queueable?: boolean; viewerAllowed: boolean } }>;
        };
      };
    };
    expect(helloPayload.features.chatStreaming.enabled).toBe(true);
    expect(helloPayload.features.pairingAuth.enabled).toBe(true);
    expect(helloPayload.features.commandRouting.supportedActions).toContain("lanes.getDetail");
    expect(helloPayload.features.commandRouting.supportedActions).toContain("lanes.rename");
    const getDetailDescriptor = helloPayload.features.commandRouting.actions.find(
      (entry) => entry.action === "lanes.getDetail",
    );
    expect(getDetailDescriptor?.policy.viewerAllowed).toBe(true);
    expect(getDetailDescriptor?.policy.queueable).toBeUndefined();
    expect(helloPayload.features.commandRouting.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "lanes.rename",
          policy: expect.objectContaining({ viewerAllowed: true, queueable: true }),
        }),
        expect.objectContaining({
          action: "chat.interrupt",
          policy: expect.objectContaining({ viewerAllowed: true, queueable: false }),
        }),
        expect.objectContaining({
          action: "chat.steer",
          policy: expect.objectContaining({ viewerAllowed: true, queueable: false }),
        }),
        expect.objectContaining({
          action: "chat.approve",
          policy: expect.objectContaining({ viewerAllowed: true, queueable: false }),
        }),
        expect.objectContaining({
          action: "chat.respondToInput",
          policy: expect.objectContaining({ viewerAllowed: true, queueable: false }),
        }),
      ]),
    );
    expect(host.getPeerStates().map((peer) => peer.deviceId)).toContain("ios-phone-1");

    host.revokePairedDevice("ios-phone-1");
    if (authWs.readyState !== WebSocket.CLOSED) {
      await new Promise((resolve) => authWs.once("close", resolve));
    }
    await waitFor(() => !host.getPeerStates().some((peer) => peer.deviceId === "ios-phone-1"));
    const revokedWs = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      revokedWs.once("open", () => resolve());
      revokedWs.once("error", reject);
    });
    const revokedQueue = createMessageQueue(revokedWs);
    revokedWs.send(encodeSyncEnvelope({
      type: "hello",
      requestId: "hello-revoked",
      payload: {
        peer: {
          deviceId: "ios-phone-1",
          deviceName: "Arul iPhone",
          platform: "iOS",
          deviceType: "phone",
          siteId: "ios-site-1",
          dbVersion: 0,
        },
        auth: {
          kind: "paired",
          deviceId: "ios-phone-1",
          secret: pairingPayload.secret,
        },
      },
    }));
    const revokedHello = await revokedQueue.next("hello_error");
    const revokedPayload = revokedHello.payload as { code: string; message: string };
    expect(revokedPayload.code).toBe("auth_failed");
    revokedWs.close();
    await new Promise((resolve) => revokedWs.once("close", resolve));
  });

  it("clears prior PIN failures after a successful pair and still allows paired hello", async () => {
    const brainDb = await openKvDb(makeDbPath("ade-sync-pairing-cooldown-"), createLogger() as any);
    const projectRoot = makeProjectRoot("ade-sync-pairing-cooldown-project-");
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const host = createSyncHostService({
      db: brainDb,
      logger: createLogger() as any,
      projectRoot,
      port: 0,
      pinStore: createStubPinStore("428193"),
      fileService: createStubFileService(workspaceRoot) as any,
      laneService: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        archive: vi.fn(),
      } as any,
      prService: {
        listAll: vi.fn().mockResolvedValue([]),
        getDetail: vi.fn(),
        getStatus: vi.fn(),
        getChecks: vi.fn(),
        getReviews: vi.fn(),
        getComments: vi.fn(),
        getFiles: vi.fn(),
        createFromLane: vi.fn(),
        land: vi.fn(),
        closePr: vi.fn(),
        requestReviewers: vi.fn(),
      } as any,
      sessionService: {
        list: () => [],
        get: () => null,
        readTranscriptTail: async () => "",
      } as any,
      ptyService: {
        create: vi.fn(),
        enrichSessions: (rows: any[]) => rows,
      } as any,
      computerUseArtifactBrokerService: {
        listArtifacts: () => [],
      } as any,
    });
    activeDisposers.push(async () => {
      await host.dispose();
      brainDb.close();
    });

    const port = await host.waitUntilListening();

    const sendPairRequest = async (requestId: string, code: string, deviceId: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      const queue = createMessageQueue(ws);
      ws.send(encodeSyncEnvelope({
        type: "pairing_request",
        requestId,
        payload: {
          code,
          peer: {
            deviceId,
            deviceName: "Audit iPhone",
            platform: "iOS",
            deviceType: "phone",
            siteId: `${deviceId}-site`,
            dbVersion: 0,
          },
        },
      }));
      const response = await queue.next("pairing_result");
      return {
        ws,
        payload: response.payload as {
          ok: boolean;
          secret?: string;
          error?: { code?: string; message?: string };
        },
      };
    };

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const failed = await sendPairRequest(`pair-bad-${attempt}`, "000000", `ios-bad-${attempt}`);
      expect(failed.payload.ok).toBe(false);
      expect(failed.payload.error?.code).toBe("invalid_pin");
      await new Promise((resolve) => failed.ws.once("close", resolve));
    }

    const paired = await sendPairRequest("pair-good", "428193", "ios-phone-2");
    expect(paired.payload.ok).toBe(true);
    expect(paired.payload.secret).toBeTruthy();
    paired.ws.close();
    await new Promise((resolve) => paired.ws.once("close", resolve));

    const failedAfterSuccess = await sendPairRequest("pair-after-success", "000000", "ios-after-success");
    expect(failedAfterSuccess.payload.ok).toBe(false);
    expect(failedAfterSuccess.payload.error?.code).toBe("invalid_pin");
    expect(failedAfterSuccess.payload.error?.message).not.toMatch(/Too many failed PIN attempts/i);
    await new Promise((resolve) => failedAfterSuccess.ws.once("close", resolve));

    const authWs = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      authWs.once("open", () => resolve());
      authWs.once("error", reject);
    });
    const authQueue = createMessageQueue(authWs);
    authWs.send(encodeSyncEnvelope({
      type: "hello",
      requestId: "hello-after-success",
      payload: {
        peer: {
          deviceId: "ios-phone-2",
          deviceName: "Audit iPhone",
          platform: "iOS",
          deviceType: "phone",
          siteId: "ios-phone-2-site",
          dbVersion: 0,
        },
        auth: {
          kind: "paired",
          deviceId: "ios-phone-2",
          secret: paired.payload.secret,
        },
      },
    }));
    const helloOk = await authQueue.next("hello_ok");
    expect(helloOk.type).toBe("hello_ok");
    authWs.close();
    await new Promise((resolve) => authWs.once("close", resolve));
  });
});

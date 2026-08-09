import fs from "node:fs";
import { randomBytes } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { openKvDb } from "../state/kvDb";
import { isCrsqliteAvailable } from "../state/crsqliteExtension";
import {
  assertFileRequestWorkspaceVisibleToPeer,
  createSyncHostService,
  parseNativeLanDiscoveryProcessList,
  shouldDeferSyncHostBackgroundChangesForChat,
  syncHostChangesetBatchOptionsForChat,
  syncFileRequestWorkspaceId,
  syncHeartbeatMissLimitForPeerMetadata,
  SYNC_HOST_CHAT_ACTIVE_BACKGROUND_BACKPRESSURE_BYTES,
  SYNC_HOST_CHAT_ACTIVE_CHANGESET_BATCH_BYTES,
  visibleFileWorkspacesForPeer,
} from "./syncHostService";
import type { SyncFileRequest } from "../../../shared/types";
import type { SyncPinStore } from "./syncPinStore";
import { encodeSyncEnvelope, parseSyncEnvelope } from "./syncProtocol";
import type { ParsedSyncEnvelope } from "./syncProtocol";

const { execFileMock, spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  spawnMock: vi.fn(() => ({
    kill: vi.fn(),
    once: vi.fn(),
    unref: vi.fn(),
  })),
  spawnSyncMock: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })),
}));
const resolveCodexComputerUseMcpConfigMock = vi.hoisted(() => vi.fn(async () => null));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

vi.mock("../../utils/codexComputerUse", () => ({
  resolveCodexComputerUseMcpConfig: resolveCodexComputerUseMcpConfigMock,
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
  deviceType?: "desktop" | "phone" | "vps" | "browser" | "unknown";
  capabilities?: string[];
  auth?: { kind: "bootstrap"; token: string } | { kind: "paired"; deviceId: string; secret: string };
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
      ...(args.auth ? { auth: args.auth } : { token: args.token }),
      peer: {
        deviceId: args.deviceId,
        deviceName: args.deviceName,
        platform: args.platform ?? "macOS",
        deviceType: args.deviceType ?? "desktop",
        siteId: args.siteId,
        dbVersion: args.dbVersion,
        capabilities: args.capabilities ?? ["changesetAck"],
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
    writeTextAtomic: ({ relPath, text }: { laneId: string; relPath: string; text: string }) => {
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
    steerUserMessage: vi.fn().mockResolvedValue(undefined),
    approveToolUse: vi.fn().mockResolvedValue(undefined),
    respondToInput: vi.fn().mockResolvedValue(undefined),
    resumeSession: vi.fn().mockResolvedValue(baseSession),
    updateSession: vi.fn().mockResolvedValue(baseSession),
    dispose: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockResolvedValue([]),
    getSessionSummary: vi.fn().mockResolvedValue(null),
    getChatEventHistory: vi.fn((sessionId: string) => ({
      sessionId,
      events: [],
      truncated: false,
      transcriptTruncated: false,
      windowTruncated: false,
      sessionFound: true,
    })),
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
  projectId?: string | null;
  args: Record<string, unknown>;
}) {
  ws.send(encodeSyncEnvelope({
    type: "command",
    requestId: payload.commandId,
    payload: {
      projectId: "project-1",
      ...payload,
    },
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

it("allows a wider heartbeat grace window for mobile peers", () => {
  expect(syncHeartbeatMissLimitForPeerMetadata({ platform: "iOS", deviceType: "phone" })).toBeGreaterThan(
    syncHeartbeatMissLimitForPeerMetadata({ platform: "macOS", deviceType: "desktop" }),
  );
  expect(syncHeartbeatMissLimitForPeerMetadata({ platform: "unknown", deviceType: "phone" })).toBeGreaterThan(
    syncHeartbeatMissLimitForPeerMetadata(null),
  );
});

it("prioritizes active chat by deferring and slicing background sync batches", () => {
  expect(shouldDeferSyncHostBackgroundChangesForChat({
    subscribedChatSessionCount: 0,
    bufferedAmount: SYNC_HOST_CHAT_ACTIVE_BACKGROUND_BACKPRESSURE_BYTES,
  })).toBe(false);
  expect(shouldDeferSyncHostBackgroundChangesForChat({
    subscribedChatSessionCount: 1,
    bufferedAmount: SYNC_HOST_CHAT_ACTIVE_BACKGROUND_BACKPRESSURE_BYTES - 1,
  })).toBe(false);
  expect(shouldDeferSyncHostBackgroundChangesForChat({
    subscribedChatSessionCount: 1,
    bufferedAmount: SYNC_HOST_CHAT_ACTIVE_BACKGROUND_BACKPRESSURE_BYTES,
  })).toBe(true);

  expect(syncHostChangesetBatchOptionsForChat({
    subscribedChatSessionCount: 0,
    maxRows: 250,
    maxBytes: 256 * 1024,
  })).toBeUndefined();
  expect(syncHostChangesetBatchOptionsForChat({
    subscribedChatSessionCount: 1,
    maxRows: 250,
    maxBytes: 256 * 1024,
  })).toEqual({
    maxRows: 64,
    maxBytes: SYNC_HOST_CHAT_ACTIVE_CHANGESET_BATCH_BYTES,
  });
  expect(syncHostChangesetBatchOptionsForChat({
    subscribedChatSessionCount: 1,
    maxRows: 12,
    maxBytes: 16 * 1024,
  })).toEqual({
    maxRows: 12,
    maxBytes: 16 * 1024,
  });
});

function makeAckRetryChange(dbVersion: number) {
  return {
    table: "kv",
    pk: "key-0",
    cid: "value",
    val: "value-0",
    col_version: dbVersion,
    db_version: dbVersion,
    site_id: "site-host-ack",
    cl: 1,
    seq: 0,
  };
}

function createAckRetryHost(projectRoot: string) {
  const changes = [makeAckRetryChange(1)];
  return createSyncHostService({
    db: {
      sync: {
        getSiteId: () => "site-host-ack",
        getDbVersion: () => 1,
        exportChangesSince: (fromDbVersion: number) =>
          changes.filter((change) => Number(change.db_version) > fromDbVersion),
        applyChanges: () => ({ appliedCount: 0 }),
        discardUnpublishedChangesForTables: () => {},
      },
    } as any,
    logger: createLogger() as any,
    projectId: "project-1",
    projectRoot,
    port: 0,
    pollIntervalMs: 25,
    discoveryEnabled: false,
    pinStore: createStubPinStore("428193"),
    fileService: createStubFileService(projectRoot) as any,
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
      readTranscriptTail: vi.fn(async () => ""),
      hasLivePty: () => true,
      enrichSessions: (rows: unknown[]) => rows,
    } as any,
    computerUseArtifactBrokerService: {
      listArtifacts: () => [],
    } as any,
    projectCatalogProvider: {
      listProjects: vi.fn(async () => ({ projects: [] })),
      prepareProjectConnection: vi.fn(),
    } as any,
  });
}

it("processes pending ACK retries before active-chat background deferral through the desktop host", async () => {
  const projectRoot = makeProjectRoot("ade-sync-desktop-ack-retry-");
  const host = createAckRetryHost(projectRoot);
  let client: Awaited<ReturnType<typeof connectClient>> | null = null;
  let bufferedAmountSpy: { mockRestore(): void } | null = null;
  let dateNowSpy: { mockRestore(): void } | null = null;
  try {
    const port = await host.waitUntilListening();
    const pairWs = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      pairWs.once("open", () => resolve());
      pairWs.once("error", reject);
    });
    const pairQueue = createMessageQueue(pairWs);
    pairWs.send(encodeSyncEnvelope({
      type: "pairing_request",
      requestId: "pair-ack-retry",
      payload: {
        code: "428193",
        peer: {
          deviceId: "ios-ack-retry",
          deviceName: "iOS ACK retry",
          platform: "iOS",
          deviceType: "phone",
          siteId: "ios-ack-retry-site",
          dbVersion: 0,
        },
      },
    }));
    const pairingResponse = await pairQueue.next("pairing_result");
    const pairingPayload = pairingResponse.payload as { ok: boolean; deviceId?: string; secret?: string };
    expect(pairingPayload.ok).toBe(true);
    expect(pairingPayload.secret).toBeTruthy();
    pairWs.close();
    await new Promise((resolve) => pairWs.once("close", resolve));

    client = await connectClient({
      port,
      token: host.getBootstrapToken(),
      deviceId: "ios-ack-retry",
      deviceName: "iOS ACK retry",
      siteId: "ios-ack-retry-site",
      dbVersion: 0,
      platform: "iOS",
      deviceType: "phone",
      capabilities: ["changesetAck"],
      auth: {
        kind: "paired",
        deviceId: "ios-ack-retry",
        secret: pairingPayload.secret ?? "",
      },
    });

    const firstBatch = await client.queue.next("changeset_batch");
    const firstPayload = firstBatch.payload as { batchId: string; toDbVersion: number };

    client.ws.send(encodeSyncEnvelope({
      type: "chat_subscribe",
      requestId: "chat-subscribe",
      payload: { sessionId: "session-1" },
    }));
    await client.queue.next("chat_subscribe");

    bufferedAmountSpy = vi
      .spyOn(WebSocket.prototype, "bufferedAmount", "get")
      .mockReturnValue(SYNC_HOST_CHAT_ACTIVE_BACKGROUND_BACKPRESSURE_BYTES);
    const realDateNow = Date.now.bind(Date);
    dateNowSpy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => realDateNow() + 11_000);

    const resentBatch = await client.queue.next("changeset_batch");
    expect(resentBatch.payload).toMatchObject({
      batchId: firstPayload.batchId,
      toDbVersion: firstPayload.toDbVersion,
    });
  } finally {
    dateNowSpy?.mockRestore();
    bufferedAmountSpy?.mockRestore();
    try {
      await client?.close();
    } catch {
      // ignore
    }
    await host.dispose();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

it("hides external file workspaces from mobile peers", () => {
  const workspaces = [
    {
      id: "workspace-1",
      kind: "primary" as const,
      laneId: "lane-1",
      name: "Primary",
      rootPath: "/project",
      isReadOnlyByDefault: false,
    },
    {
      id: "external-local:test",
      kind: "external" as const,
      laneId: null,
      name: "External",
      rootPath: "/Users/me/Downloads",
      isReadOnlyByDefault: false,
      mobileReadOnly: true,
    },
  ];

  expect(visibleFileWorkspacesForPeer(workspaces, { isMobile: true }).map((workspace) => workspace.id)).toEqual(["workspace-1"]);
  expect(visibleFileWorkspacesForPeer(workspaces, { isMobile: false }).map((workspace) => workspace.id)).toEqual([
    "workspace-1",
    "external-local:test",
  ]);
});

it("blocks mobile file requests that target external workspaces", () => {
  const externalWorkspace = {
    id: "external-local:test",
    kind: "external" as const,
    laneId: null,
    name: "External",
    rootPath: "/Users/me/Downloads",
    isReadOnlyByDefault: false,
    mobileReadOnly: true,
  };

  expect(() => assertFileRequestWorkspaceVisibleToPeer({
    isMobile: true,
    workspace: externalWorkspace,
  })).toThrow(/external local files/i);
  expect(() => assertFileRequestWorkspaceVisibleToPeer({
    isMobile: false,
    workspace: externalWorkspace,
  })).not.toThrow();
});

it("extracts workspace ids from every workspace-scoped file request", () => {
  const requests: SyncFileRequest[] = [
    { action: "listTree", args: { workspaceId: "external-local:test" } },
    { action: "listTreeChildren", args: { workspaceId: "external-local:test", parentPath: "nested" } },
    { action: "refreshGitDecorations", args: { workspaceId: "external-local:test" } },
    { action: "readFile", args: { workspaceId: "external-local:test", path: "notes.txt" } },
    { action: "readFileRange", args: { workspaceId: "external-local:test", path: "notes.txt", offset: 0 } },
    { action: "gitBlame", args: { workspaceId: "external-local:test", path: "notes.txt" } },
    { action: "writeText", args: { workspaceId: "external-local:test", path: "notes.txt", text: "hi" } },
    { action: "createFile", args: { workspaceId: "external-local:test", path: "new.txt" } },
    { action: "createDirectory", args: { workspaceId: "external-local:test", path: "new-dir" } },
    { action: "rename", args: { workspaceId: "external-local:test", oldPath: "a.txt", newPath: "b.txt" } },
    { action: "deletePath", args: { workspaceId: "external-local:test", path: "b.txt" } },
    { action: "watchChanges", args: { workspaceId: "external-local:test", includeIgnored: true } },
    { action: "stopWatching", args: { workspaceId: "external-local:test", includeIgnored: true } },
    { action: "quickOpen", args: { workspaceId: "external-local:test", query: "note" } },
    { action: "searchText", args: { workspaceId: "external-local:test", query: "note" } },
  ];

  for (const request of requests) {
    expect(syncFileRequestWorkspaceId(request)).toBe("external-local:test");
  }
  expect(syncFileRequestWorkspaceId({ action: "listWorkspaces", args: {} })).toBeNull();
  expect(syncFileRequestWorkspaceId({ action: "readArtifact", args: { artifactId: "artifact-1" } })).toBeNull();
});

it("parses ADE dns-sd discovery processes for orphan recovery", () => {
  const stdout = [
    " 111 1 dns-sd -R ADE Sync lappy 8788 _ade-sync._tcp local 8788 version=1",
    " 112 44 dns-sd -R ADE Sync current 8788 _ade-sync._tcp local 8788 version=1",
    " 113 1 dns-sd -B _http._tcp local",
    " 114 1 /usr/bin/other -R ADE Sync lappy 8788 _ade-sync._tcp local",
  ].join("\n");

  expect(parseNativeLanDiscoveryProcessList(stdout)).toEqual([
    expect.objectContaining({ pid: 111, ppid: 1 }),
    expect.objectContaining({ pid: 112, ppid: 44 }),
  ]);
});

describe.skipIf(!isCrsqliteAvailable())("syncHostService", () => {
  it("retries tailnet discovery after a serve failure only when forced", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(execFileMock).toHaveBeenCalledTimes(1);

    host.refreshLanDiscovery({ forceTailnet: true });
    await waitFor(() => execFileMock.mock.calls.length === 2);
  });

  it("marks missing Tailscale CLI unavailable without retry spam", async () => {
    const previousEnv = {
      ADE_TAILSCALE_CLI: process.env.ADE_TAILSCALE_CLI,
      ADE_TAILSCALE_SERVE: process.env.ADE_TAILSCALE_SERVE,
      NODE_ENV: process.env.NODE_ENV,
      VITEST: process.env.VITEST,
    };
    process.env.ADE_TAILSCALE_CLI = "tailscale-missing";
    process.env.ADE_TAILSCALE_SERVE = "1";
    process.env.NODE_ENV = "development";
    delete process.env.VITEST;
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    execFileMock.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      const error = Object.assign(new Error("spawn tailscale ENOENT"), {
        code: "ENOENT",
        stderr: "",
      });
      queueMicrotask(() => callback(error, "", ""));
      return {} as never;
    });

    const projectRoot = makeProjectRoot("ade-sync-host-tailnet-missing-");
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const db = await openKvDb(makeDbPath("ade-sync-host-tailnet-missing-db-"), createLogger() as any);
    const host = createSyncHostService({
      db,
      logger: logger as any,
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
      onStateChanged: vi.fn(),
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
    await waitFor(() => host.getTailnetDiscoveryStatus().state === "unavailable");
    expect(host.getTailnetDiscoveryStatus().error).toBe("Tailscale CLI was not found.");

    host.refreshLanDiscovery();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalledWith(
      "sync_host.tailnet_discovery_failed",
      expect.anything(),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "sync_host.tailnet_discovery_unavailable",
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("keeps newer forced tailnet publishes when an older serve attempt fails", async () => {
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
    const callbacks: Array<(error: Error | null, stdout: string, stderr: string) => void> = [];
    execFileMock.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      if (_args.includes("off")) {
        queueMicrotask(() => callback(null, { stdout: "", stderr: "" } as any, ""));
        return {} as never;
      }
      callbacks.push(callback);
      return {} as never;
    });

    const projectRoot = makeProjectRoot("ade-sync-host-tailnet-overlap-");
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const db = await openKvDb(makeDbPath("ade-sync-host-tailnet-overlap-db-"), createLogger() as any);
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

    host.refreshLanDiscovery({ forceTailnet: true });
    await waitFor(() => execFileMock.mock.calls.length === 2);

    callbacks[1]?.(null, { stdout: "", stderr: "" } as any, "");
    await waitFor(() => host.getTailnetDiscoveryStatus().state === "published");

    const staleError = Object.assign(new Error("older tailscale serve failed"), { stderr: "temporary failure" });
    callbacks[0]?.(staleError, "", "temporary failure");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.getTailnetDiscoveryStatus().state).toBe("published");
    host.refreshLanDiscovery();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const publishCalls = execFileMock.mock.calls.filter(([, args]) => args.includes("--bg"));
    expect(publishCalls).toHaveLength(2);
  });

  it("rejects host startup quickly when the requested port is already taken", async () => {
    const projectRoot = makeProjectRoot("ade-sync-host-port-conflict-");
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const db = await openKvDb(makeDbPath("ade-sync-host-port-conflict-db-"), createLogger() as any);
    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", () => resolve());
    });
    const blockedPort = (blocker.address() as net.AddressInfo).port;

    const host = createSyncHostService({
      db,
      logger: createLogger() as any,
      projectId: "project-1",
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
      isOpen: false,
    };
    const browseResult = {
      inputPath: "~/Projects",
      resolvedPath: "/Users/admin/Projects",
      directoryPath: "/Users/admin/Projects",
      parentPath: "/Users/admin",
      exactDirectoryPath: "/Users/admin/Projects",
      openableProjectRoot: null,
      entries: [
        {
          name: "ADE",
          fullPath: projectRoot,
          isGitRepo: true,
        },
      ],
    };
    const openedProject = {
      ...project,
      id: "project-opened",
      rootPath: path.join(projectRoot, "opened"),
      displayName: "Opened",
      isOpen: true,
      isCached: true,
    };
    const createdProject = {
      ...project,
      id: "project-created",
      rootPath: path.join(projectRoot, "created"),
      displayName: "Created",
      isOpen: true,
      isCached: true,
    };
    const clonedProject = {
      ...project,
      id: "project-cloned",
      rootPath: path.join(projectRoot, "cloned"),
      displayName: "Cloned",
      isOpen: true,
      isCached: true,
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
      completeProjectConnection: vi.fn(async () => {}),
      browseDirectories: vi.fn(async () => browseResult),
      getDefaultParentDir: vi.fn(async () => "/Users/admin/Projects"),
      openProject: vi.fn(async () => openedProject),
      createProject: vi.fn(async () => createdProject),
      cloneProject: vi.fn(async () => clonedProject),
      listMyGitHubRepos: vi.fn(async () => ({
        repos: [
          {
            owner: "ade",
            name: "mobile",
            fullName: "ade/mobile",
            isPrivate: true,
            pushedAt: "2026-04-22T12:00:00.000Z",
            defaultBranch: "main",
            htmlUrl: "https://github.com/ade/mobile",
            cloneUrl: "https://github.com/ade/mobile.git",
            sshUrl: "git@github.com:ade/mobile.git",
          },
        ],
      })),
    };

    const host = createSyncHostService({
      db: brainDb,
      logger: createLogger() as any,
      projectId: "project-1",
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
    const observerClient = await connectClient({
      port,
      token: host.getBootstrapToken(),
      deviceId: "ios-phone-2",
      deviceName: "Arul iPad",
      siteId: "ios-site-2",
      dbVersion: 0,
      platform: "iOS",
      deviceType: "phone",
    });

    const helloPayload = client.helloOk.payload as {
      projects?: unknown[];
      features: {
        projectCatalog?: { enabled: boolean };
        projectActions?: { enabled: boolean };
      };
    };
    expect(helloPayload.projects).toEqual([project]);
    expect(helloPayload.features.projectCatalog?.enabled).toBe(true);
    expect(helloPayload.features.projectActions?.enabled).toBe(true);

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
    await vi.waitFor(() => {
      expect(projectCatalogProvider.completeProjectConnection).toHaveBeenCalledWith({
        projectId: project.id,
        rootPath: project.rootPath,
      }, switchResult.payload);
    });

    client.ws.send(encodeSyncEnvelope({
      type: "project_browse_request",
      requestId: "browse-1",
      payload: {
        partialPath: "~/Projects",
        limit: 20,
      },
    }));
    const browse = await client.queue.next("project_browse_result");
    expect(browse.requestId).toBe("browse-1");
    expect(projectCatalogProvider.browseDirectories).toHaveBeenCalledWith({
      partialPath: "~/Projects",
      limit: 20,
    });
    expect(browse.payload).toEqual({ ok: true, result: browseResult });

    client.ws.send(encodeSyncEnvelope({
      type: "project_default_parent_dir_request",
      requestId: "parent-1",
      payload: {},
    }));
    const defaultParent = await client.queue.next("project_default_parent_dir");
    expect(defaultParent.requestId).toBe("parent-1");
    expect(defaultParent.payload).toEqual({ ok: true, parentDir: "/Users/admin/Projects" });

    client.ws.send(encodeSyncEnvelope({
      type: "project_open_request",
      requestId: "open-1",
      payload: { rootPath: openedProject.rootPath },
    }));
    const openResult = await client.queue.next("project_open_result");
    expect(openResult.requestId).toBe("open-1");
    expect(projectCatalogProvider.openProject).toHaveBeenCalledWith({ rootPath: openedProject.rootPath });
    expect(openResult.payload).toEqual({ ok: true, project: openedProject });
    expect((await client.queue.next("project_catalog")).payload).toEqual({ projects: [project] });
    expect((await observerClient.queue.next("project_catalog")).payload).toEqual({ projects: [project] });

    client.ws.send(encodeSyncEnvelope({
      type: "project_create_request",
      requestId: "create-1",
      payload: { name: "Created", parentDir: "/Users/admin/Projects" },
    }));
    const createResult = await client.queue.next("project_create_result");
    expect(createResult.requestId).toBe("create-1");
    expect(projectCatalogProvider.createProject).toHaveBeenCalledWith({
      name: "Created",
      parentDir: "/Users/admin/Projects",
    });
    expect(createResult.payload).toEqual({ ok: true, project: createdProject });
    await client.queue.next("project_catalog");

    client.ws.send(encodeSyncEnvelope({
      type: "project_clone_request",
      requestId: "clone-1",
      payload: {
        url: "https://github.com/ade/mobile.git",
        name: "mobile",
        parentDir: "/Users/admin/Projects",
      },
    }));
    const cloneResult = await client.queue.next("project_clone_result");
    expect(cloneResult.requestId).toBe("clone-1");
    expect(projectCatalogProvider.cloneProject).toHaveBeenCalledWith({
      url: "https://github.com/ade/mobile.git",
      name: "mobile",
      parentDir: "/Users/admin/Projects",
    });
    expect(cloneResult.payload).toEqual({ ok: true, project: clonedProject });
    await client.queue.next("project_catalog");

    client.ws.send(encodeSyncEnvelope({
      type: "project_list_my_github_repos_request",
      requestId: "repos-1",
      payload: { search: "mobile" },
    }));
    const reposResult = await client.queue.next("project_list_my_github_repos_result");
    expect(reposResult.requestId).toBe("repos-1");
    expect(projectCatalogProvider.listMyGitHubRepos).toHaveBeenCalledWith({ search: "mobile" });
    expect(reposResult.payload).toEqual({
      ok: true,
      result: {
        repos: [
          {
            owner: "ade",
            name: "mobile",
            fullName: "ade/mobile",
            isPrivate: true,
            pushedAt: "2026-04-22T12:00:00.000Z",
            defaultBranch: "main",
            htmlUrl: "https://github.com/ade/mobile",
            cloneUrl: "https://github.com/ade/mobile.git",
            sshUrl: "git@github.com:ade/mobile.git",
          },
        ],
      },
    });

    projectCatalogProvider.listProjects.mockResolvedValueOnce({
      projects: [{ ...project, id: "project-row-2", isOpen: true }],
    });
    await host.broadcastProjectCatalog();
    const broadcastCatalog = await client.queue.next("project_catalog");
    expect(broadcastCatalog.payload).toEqual({
      projects: [{ ...project, id: "project-row-2", isOpen: true }],
    });

    await client.close();
    await observerClient.close();
  });

  it("chunks oversized mobile project catalog responses", async () => {
    const brainDb = await openKvDb(makeDbPath("ade-sync-project-catalog-large-"), createLogger() as any);
    const projectRoot = makeProjectRoot("ade-sync-project-catalog-large-project-");
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const projects = Array.from({ length: 2_000 }, (_, index) => {
      const entropy = randomBytes(256).toString("hex");
      return {
        id: `project-${index}-${entropy.slice(0, 16)}`,
        displayName: `Project ${index} ${entropy.slice(16, 80)}`,
        rootPath: path.join(projectRoot, entropy),
        defaultBaseRef: "main",
        lastOpenedAt: "2026-04-22T12:00:00.000Z",
        laneCount: index % 7,
        isAvailable: true,
        isCached: false,
        isOpen: false,
      };
    });

    const host = createSyncHostService({
      db: brainDb,
      logger: createLogger() as any,
      projectId: "project-1",
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
      projectCatalogProvider: {
        listProjects: vi.fn(async () => ({ projects })),
        prepareProjectConnection: vi.fn(),
      },
    });
    activeDisposers.push(async () => {
      await host.dispose();
      brainDb.close();
    });

    const port = await host.waitUntilListening();
    const client = await connectClient({
      port,
      token: host.getBootstrapToken(),
      deviceId: "ios-phone-large-catalog",
      deviceName: "Arul iPhone",
      siteId: "ios-site-large-catalog",
      dbVersion: 0,
      platform: "iOS",
      deviceType: "phone",
    });

    const helloPayload = client.helloOk.payload as { projects?: unknown[] };
    expect(helloPayload.projects).toEqual([]);

    client.ws.send(encodeSyncEnvelope({
      type: "project_catalog_request",
      requestId: "catalog-large",
      payload: {},
    }));

    const receivedProjects: unknown[] = [];
    let chunkCount = 0;
    let done = false;
    while (!done) {
      const chunk = await client.queue.next("project_catalog_chunk");
      expect(chunk.requestId).toBe("catalog-large");
      const payload = chunk.payload as {
        index: number;
        total: number;
        done: boolean;
        projects: unknown[];
      };
      chunkCount += 1;
      done = payload.done;
      expect(payload.index).toBe(chunkCount - 1);
      expect(payload.total).toBeGreaterThan(1);
      receivedProjects.push(...payload.projects);
    }
    expect(chunkCount).toBeGreaterThan(1);
    expect(receivedProjects).toHaveLength(projects.length);

    await host.broadcastProjectCatalog();
    const broadcastProjects: unknown[] = [];
    chunkCount = 0;
    done = false;
    while (!done) {
      const chunk = await client.queue.next("project_catalog_chunk");
      expect(chunk.requestId).toBeNull();
      const payload = chunk.payload as {
        index: number;
        total: number;
        done: boolean;
        projects: unknown[];
      };
      chunkCount += 1;
      done = payload.done;
      expect(payload.index).toBe(chunkCount - 1);
      expect(payload.total).toBeGreaterThan(1);
      broadcastProjects.push(...payload.projects);
    }
    expect(chunkCount).toBeGreaterThan(1);
    expect(broadcastProjects).toHaveLength(projects.length);

    await client.close();
  }, 30_000);

  it("authenticates peers, relays CRDT changes, and rebroadcasts to other peers", async () => {
    const brainDb = await openKvDb(makeDbPath("ade-sync-brain-"), createLogger() as any);
    const dbA = await openKvDb(makeDbPath("ade-sync-peer-a-"), createLogger() as any);
    const dbB = await openKvDb(makeDbPath("ade-sync-peer-b-"), createLogger() as any);
    const dbC = await openKvDb(makeDbPath("ade-sync-peer-c-"), createLogger() as any);
    const projectRoot = makeProjectRoot("ade-sync-host-project-");
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const host = createSyncHostService({
      db: brainDb,
      logger: createLogger() as any,
      projectId: "project-1",
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
      dbC.close();
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
        batchId: "changes-a",
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
    const sourceAck = await clientA.queue.next("changeset_ack");
    expect((sourceAck.payload as { ok: boolean; batchId?: string }).ok).toBe(true);
    expect((sourceAck.payload as { ok: boolean; batchId?: string }).batchId).toBe("changes-a");
    await waitFor(() => host.getPeerStates().find((peer) => peer.deviceId === "peer-a")?.syncLag === 0);
    await expect(clientA.queue.next("changeset_batch", 250)).rejects.toThrow(/Timed out waiting for changeset_batch/);

    const rebroadcast = await clientB.queue.next("changeset_batch");
    const payload = rebroadcast.payload as {
      batchId: string;
      fromDbVersion: number;
      toDbVersion: number;
      changes: unknown[];
    };
    expect(payload.changes.length).toBeGreaterThan(0);
    dbB.sync.applyChanges(payload.changes as any);
    expect(dbB.getJson<{ value: string }>("replicated-state")).toEqual({ value: "hello" });
    expect(host.getPeerStates().find((peer) => peer.deviceId === "peer-b")?.syncLag).toBeGreaterThan(0);
    clientB.ws.send(encodeSyncEnvelope({
      type: "changeset_ack",
      requestId: payload.batchId,
      payload: {
        batchId: payload.batchId,
        fromDbVersion: payload.fromDbVersion,
        toDbVersion: payload.toDbVersion,
        appliedDbVersion: dbB.sync.getDbVersion(),
        appliedCount: payload.changes.length,
        ok: true,
      },
      compressionThresholdBytes: 100_000,
    }));
    await waitFor(() => host.getPeerStates().find((peer) => peer.deviceId === "peer-b")?.syncLag === 0);

    const legacyClient = await connectClient({
      port,
      token,
      deviceId: "peer-legacy",
      deviceName: "Peer Legacy",
      siteId: dbC.sync.getSiteId(),
      dbVersion: 0,
      capabilities: [],
    });
    activeDisposers.push(legacyClient.close);
    const legacyBatch = await legacyClient.queue.next("changeset_batch");
    const legacyPayload = legacyBatch.payload as {
      batchId: string;
      toDbVersion: number;
      changes: unknown[];
    };
    expect(legacyPayload.batchId).toBeTruthy();
    expect(legacyPayload.changes.length).toBeGreaterThan(0);
    await waitFor(() => host.getPeerStates().find((peer) => peer.deviceId === "peer-legacy")?.syncLag === 0);
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
      projectId: "project-1",
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
    expect(mobileWritePayload.ok).toBe(true);
    expect(mobileWritePayload.error).toBeUndefined();
    expect(fs.readFileSync(path.join(workspaceRoot, "notes.txt"), "utf8")).toBe("mobile update");

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
    expect(atomicAckPayload.accepted).toBe(true);
    expect(atomicAckPayload.status).toBe("accepted");
    expect(atomicResultPayload.ok).toBe(true);
    expect(atomicResultPayload.error).toBeUndefined();
    expect(fs.readFileSync(path.join(workspaceRoot, "notes.txt"), "utf8")).toBe("mobile atomic update");

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

  it("streams terminal snapshots, live output, exit events, and supports mobile terminal seed commands", async () => {
    const brainDb = await openKvDb(makeDbPath("ade-sync-terminal-"), createLogger() as any);
    const projectRoot = makeProjectRoot("ade-sync-terminal-project-");
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const createSpy = vi.fn().mockResolvedValue({ ptyId: "pty-1", sessionId: "session-1" });
    const writeBySessionId = vi.fn().mockReturnValue(true);
    const resizeBySessionId = vi.fn().mockReturnValue(true);
    const readTranscriptTail = vi.fn(async () => "prior output\n");
    const readTranscriptSnapshot = vi.fn(async () => ({
      data: "prior output\n",
      startOffset: 0,
      endOffset: Buffer.byteLength("prior output\n", "utf8"),
    }));
    const updateSessionMeta = vi.fn();

    const host = createSyncHostService({
      db: brainDb,
      logger: createLogger() as any,
      projectId: "project-1",
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
            toolType: "shell",
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
          laneId: "lane-1",
          laneName: "Primary",
          ptyId: "pty-1",
          tracked: true,
          pinned: false,
          goal: "Run tests",
          toolType: "codex",
          title: "Codex",
          transcriptPath: path.join(projectRoot, ".ade", "transcripts", "session-1.log"),
          status: "running",
          runtimeState: "running",
          lastOutputPreview: "echo hi",
          startedAt: "2026-03-17T00:10:00.000Z",
          endedAt: null,
          exitCode: null,
          headShaStart: null,
          headShaEnd: null,
          summary: null,
          resumeCommand: "codex resume picker",
        }),
        updateMeta: updateSessionMeta,
        readTranscriptTail: async () => "prior output\n",
      } as any,
      ptyService: {
        create: createSpy,
        readTranscriptTail,
        readTranscriptSnapshot,
        writeBySessionId,
        resizeBySessionId,
        hasLivePty: () => true,
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
    expect(readTranscriptSnapshot).toHaveBeenCalledWith({
      sessionId: "session-1",
      maxBytes: 32_000,
      alignStartToSafeBoundary: true,
    });

    client.ws.send(encodeSyncEnvelope({
      type: "terminal_input",
      payload: {
        sessionId: "session-1",
        data: "npm test\r",
      },
    }));
    await waitFor(() => writeBySessionId.mock.calls.length === 1);
    expect(writeBySessionId).toHaveBeenCalledWith("session-1", "npm test\r");

    client.ws.send(encodeSyncEnvelope({
      type: "terminal_resize",
      payload: {
        sessionId: "session-1",
        cols: 120.8,
        rows: 34.2,
      },
    }));
    await waitFor(() => resizeBySessionId.mock.calls.length === 1);
    expect(resizeBySessionId).toHaveBeenCalledWith("session-1", 120, 34, { source: "mobile" });

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
      requestId: "cmd-terminal-command",
      payload: {
        commandId: "cmd-terminal-command",
        action: "work.runQuickCommand",
        projectId: "project-1",
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
    await waitFor(() => fs.existsSync(path.join(projectRoot, ".ade", "cache", "sync-mobile-command-ledger.json")));
    const commandLedgerPath = path.join(projectRoot, ".ade", "cache", "sync-mobile-command-ledger.json");
    const commandLedger = fs.readFileSync(commandLedgerPath, "utf8");
    expect(commandLedger).toContain("cmd-terminal-command");
    expect(commandLedger).toContain("argsFingerprint");
    expect(commandLedger).not.toContain("argsKey");
    expect(commandLedger).not.toContain("npm test");

    client.ws.send(encodeSyncEnvelope({
      type: "command",
      requestId: "cmd-terminal-command-retry",
      payload: {
        commandId: "cmd-terminal-command",
        action: "work.runQuickCommand",
        projectId: "project-1",
        args: {
          laneId: "lane-1",
          title: "Run tests",
          startupCommand: "npm test",
        },
      },
    }));
    const replayAck = await client.queue.next("command_ack");
    expect((replayAck.payload as { accepted: boolean }).accepted).toBe(true);
    const replayResult = await client.queue.next("command_result");
    expect((replayResult.payload as { ok: boolean; result: { sessionId: string } }).result.sessionId).toBe("session-1");
    expect(createSpy).toHaveBeenCalledTimes(1);

    client.ws.send(encodeSyncEnvelope({
      type: "command",
      requestId: "cmd-terminal-command-conflict",
      payload: {
        commandId: "cmd-terminal-command",
        action: "work.runQuickCommand",
        projectId: "project-1",
        args: {
          laneId: "lane-2",
          title: "Run a different command",
          startupCommand: "npm run lint",
        },
      },
    }));
    const mismatchAck = await client.queue.next("command_ack");
    expect((mismatchAck.payload as { accepted: boolean }).accepted).toBe(false);
    const mismatchResult = await client.queue.next("command_result");
    expect((mismatchResult.payload as { ok: boolean; error?: { code: string } }).error?.code).toBe("duplicate_command_mismatch");
    expect(createSpy).toHaveBeenCalledTimes(1);

    client.ws.send(encodeSyncEnvelope({
      type: "command",
      requestId: "cmd-start-cli",
      payload: {
        commandId: "cmd-start-cli",
        action: "work.startCliSession",
        projectId: "project-1",
        args: {
          laneId: "lane-1",
          provider: "codex",
          permissionMode: "edit",
          initialInput: "fix from phone",
        },
      },
    }));
    const startCliAck = await client.queue.next("command_ack");
    expect((startCliAck.payload as { accepted: boolean }).accepted).toBe(true);
    const startCliResult = await client.queue.next("command_result");
    const startCliPayload = startCliResult.payload as {
      ok: boolean;
      error?: { message?: string };
      result: { sessionId: string; ptyId: string; session: { id: string; toolType: string } };
    };
    expect(startCliPayload.ok, startCliPayload.error?.message).toBe(true);
    expect(startCliPayload.result.sessionId).toBe("session-1");
    expect(startCliPayload.result.ptyId).toBe("pty-1");
    expect(startCliPayload.result.session).toEqual(expect.objectContaining({
      id: "session-1",
      toolType: "codex",
    }));
    expect(createSpy).toHaveBeenCalledTimes(2);
    const startCliCreateCall = createSpy.mock.calls.at(-1)?.[0];
    expect(startCliCreateCall?.command).toBe("codex");
    expect(startCliCreateCall?.args).not.toContain(expect.stringContaining("fix from phone"));
    expect(startCliCreateCall?.initialInput).toContain("fix from phone");
    expect(startCliCreateCall?.initialInputDelayMs).toBe(750);
    expect(startCliCreateCall).not.toHaveProperty("awaitInitialInput");
    expect(writeBySessionId).toHaveBeenCalledTimes(1);
    expect(updateSessionMeta).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      title: "Fix from phone",
      manuallyNamed: false,
    }));

    await waitFor(() => fs.readFileSync(commandLedgerPath, "utf8").includes("cmd-start-cli"));
    const startCliLedger = fs.readFileSync(commandLedgerPath, "utf8");
    expect(startCliLedger).toContain("cmd-start-cli");
    expect(startCliLedger).toContain("argsFingerprint");
    expect(startCliLedger).not.toContain("fix from phone");

    client.ws.send(encodeSyncEnvelope({
      type: "command",
      requestId: "cmd-start-cli-retry",
      payload: {
        commandId: "cmd-start-cli",
        action: "work.startCliSession",
        projectId: "project-1",
        args: {
          laneId: "lane-1",
          provider: "codex",
          permissionMode: "edit",
          initialInput: "fix from phone",
        },
      },
    }));
    const startCliReplayAck = await client.queue.next("command_ack");
    expect((startCliReplayAck.payload as { accepted: boolean }).accepted).toBe(true);
    const startCliReplayResult = await client.queue.next("command_result");
    const startCliReplayPayload = startCliReplayResult.payload as {
      ok: boolean;
      error?: { message?: string };
      result: { sessionId: string; ptyId: string; session: { id: string; toolType: string } };
    };
    expect(startCliReplayPayload.ok, startCliReplayPayload.error?.message).toBe(true);
    expect(startCliReplayPayload.result.sessionId).toBe("session-1");
    expect(startCliReplayPayload.result.ptyId).toBe("pty-1");
    expect(startCliReplayPayload.result.session).toEqual(expect.objectContaining({
      id: "session-1",
      toolType: "codex",
    }));
    expect(createSpy).toHaveBeenCalledTimes(2);

    client.ws.send(encodeSyncEnvelope({
      type: "command",
      requestId: "cmd-work-list",
      payload: {
        commandId: "cmd-work-list",
        action: "work.listSessions",
        projectId: "project-1",
        args: {},
      },
    }));
    const workListAck = await client.queue.next("command_ack");
    expect((workListAck.payload as { accepted: boolean }).accepted).toBe(true);
    const workListResult = await client.queue.next("command_result");
    const workSessions = (workListResult.payload as { ok: boolean; result: Array<{ id: string }> }).result;
    expect(workSessions.map((entry) => entry.id)).toEqual(["session-1"]);
    const afterWorkListLedger = fs.readFileSync(commandLedgerPath, "utf8");
    expect(afterWorkListLedger).not.toContain("cmd-work-list");
    expect(afterWorkListLedger).not.toContain("prior output");

    client.ws.send(encodeSyncEnvelope({
      type: "command",
      requestId: "cmd-pr-refresh",
      payload: {
        commandId: "cmd-pr-refresh",
        action: "prs.refresh",
        projectId: "project-1",
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
        projectId: "project-1",
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
      projectId: "project-1",
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

    const inlineImage = `data:image/png;base64,${"A".repeat(80 * 1024)}`;
    const desktopImageEvent = {
      sessionId: "session-1",
      timestamp: "2026-03-17T00:10:00.500Z",
      event: {
        type: "codex_image_generation" as const,
        itemId: "droid-image-1",
        result: inlineImage,
        status: "completed" as const,
      },
      sequence: 2,
    };
    chatService.emit(desktopImageEvent);

    const imageEventA = await clientA.queue.next("chat_event");
    const imageEventB = await clientB.queue.next("chat_event");
    for (const imageEvent of [imageEventA, imageEventB]) {
      expect((imageEvent.payload as {
        event: { result: string | null; resultOriginalBytes?: number; resultOmittedBytes?: number };
      }).event).toMatchObject({
        result: null,
        resultOriginalBytes: Buffer.byteLength(inlineImage, "utf8"),
        resultOmittedBytes: Buffer.byteLength(inlineImage, "utf8"),
      });
      expect(JSON.stringify(imageEvent.payload)).not.toContain("A".repeat(1024));
    }
    expect(desktopImageEvent.event.result).toBe(inlineImage);

    const nestedToolResult = {
      output: {
        preview: inlineImage,
        message: "desktop keeps the full preview",
      },
    };
    const desktopToolEvent = {
      sessionId: "session-1",
      timestamp: "2026-03-17T00:10:00.750Z",
      event: {
        type: "tool_result" as const,
        tool: "mcp__images__generate",
        itemId: "image-tool-result-1",
        result: nestedToolResult,
        status: "completed" as const,
      },
      sequence: 3,
    };
    chatService.emit(desktopToolEvent);

    const toolEventA = await clientA.queue.next("chat_event");
    const toolEventB = await clientB.queue.next("chat_event");
    for (const toolEvent of [toolEventA, toolEventB]) {
      const payload = toolEvent.payload as {
        event: {
          result: { output: { preview: string; message: string } };
          resultOriginalBytes?: number;
          resultOmittedBytes?: number;
        };
      };
      expect(payload.event.result.output).toMatchObject({
        // The wire runs the same compaction the stored transcript does, so the
        // redaction notice is the storage policy's wording.
        preview: expect.stringContaining("Inline image was left out"),
        message: "desktop keeps the full preview",
      });
      expect(payload.event.resultOmittedBytes).toBe(Buffer.byteLength(inlineImage, "utf8"));
      expect(JSON.stringify(toolEvent.payload)).not.toContain("A".repeat(1024));
    }
    expect(desktopToolEvent.event.result).toBe(nestedToolResult);
    expect(nestedToolResult.output.preview).toBe(inlineImage);

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
      sequence: 4,
    });

    const replayA = await clientA.queue.next("chat_event");
    expect((replayA.payload as { sessionId: string; event: { text: string } }).sessionId).toBe("session-1");
    await expect(clientB.queue.next("chat_event", 250)).rejects.toThrow(/Timed out waiting for chat_event/);
  }, 15_000);

  it("ships live turn state on the chat_subscribe ack so mid-turn subscribers see streaming state", async () => {
    const brainDb = await openKvDb(makeDbPath("ade-sync-chat-turnstate-"), createLogger() as any);
    const projectRoot = makeProjectRoot("ade-sync-chat-turnstate-project-");
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const chatService = createStubChatService();
    // Snapshot tails can miss a long turn's `status: started` event, so the
    // ack itself must carry the live "a turn is running" state.
    chatService.service.getSessionSummary.mockImplementation(async (sessionId: string) =>
      sessionId === "session-awaiting"
        ? { sessionId, status: "active", awaitingInput: true }
        : { sessionId, status: "active" });

    const host = createSyncHostService({
      db: brainDb,
      logger: createLogger() as any,
      projectId: "project-1",
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
    const client = await connectClient({
      port,
      token: host.getBootstrapToken(),
      deviceId: "peer-chat-turnstate",
      deviceName: "Peer Chat Turn State",
      siteId: brainDb.sync.getSiteId(),
      dbVersion: brainDb.sync.getDbVersion(),
    });
    activeDisposers.push(client.close);

    client.ws.send(encodeSyncEnvelope({
      type: "chat_subscribe",
      payload: { sessionId: "session-running" },
    }));
    const runningAck = await client.queue.next("chat_subscribe");
    expect(runningAck.payload).toMatchObject({
      sessionId: "session-running",
      turnActive: true,
    });

    // Awaiting-input sessions still report an active turn — the turn is
    // running, just paused on a prompt; clients keep their stop affordance.
    client.ws.send(encodeSyncEnvelope({
      type: "chat_subscribe",
      payload: { sessionId: "session-awaiting" },
    }));
    const awaitingAck = await client.queue.next("chat_subscribe");
    expect(awaitingAck.payload).toMatchObject({
      sessionId: "session-awaiting",
      turnActive: true,
    });

    // When the chat service has no summary for the session, the ack must
    // omit the field rather than fabricate state — clients treat absence as
    // "no live signal" and fall back to transcript-derived streaming state.
    chatService.service.getSessionSummary.mockResolvedValue(null);
    client.ws.send(encodeSyncEnvelope({
      type: "chat_subscribe",
      payload: { sessionId: "session-unknown" },
    }));
    const unknownAck = await client.queue.next("chat_subscribe");
    expect(unknownAck.payload).toMatchObject({ sessionId: "session-unknown" });
    expect(unknownAck.payload).not.toHaveProperty("turnActive");
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
      projectId: "project-1",
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
    expect(chatService.service.steerUserMessage).toHaveBeenCalledWith({ sessionId: "session-1", text: "Please continue." });

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

    const restart = await sendCommand(secondClient.ws, secondClient.queue, {
      commandId: "chat-restart",
      action: "chat.restart",
      args: { sessionId: "session-1" },
    });
    expect((restart.result.payload as { ok: boolean; result: { sessionId: string } }).result.sessionId).toBe("session-1");
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

    const deleteResult = await sendCommand(secondClient.ws, secondClient.queue, {
      commandId: "chat-delete",
      action: "chat.delete",
      args: { sessionId: "session-1" },
    });
    expect((deleteResult.result.payload as { ok: boolean }).ok).toBe(true);
    expect(chatService.service.deleteSession).toHaveBeenCalledWith({ sessionId: "session-1" });
  }, 15_000);

  it("pairs a phone peer and preserves paired reconnect identity even if hello metadata is spoofed", async () => {
    const brainDb = await openKvDb(makeDbPath("ade-sync-pairing-"), createLogger() as any);
    const projectRoot = makeProjectRoot("ade-sync-pairing-project-");
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, "notes.txt"), "original", "utf8");

    const host = createSyncHostService({
      db: brainDb,
      logger: createLogger() as any,
      projectId: "project-1",
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

    const bootstrapSpoofWs = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      bootstrapSpoofWs.once("open", () => resolve());
      bootstrapSpoofWs.once("error", reject);
    });
    const bootstrapSpoofQueue = createMessageQueue(bootstrapSpoofWs);
    bootstrapSpoofWs.send(encodeSyncEnvelope({
      type: "hello",
      requestId: "hello-bootstrap-spoof",
      payload: {
        token: host.getBootstrapToken(),
        peer: {
          deviceId: "ios-phone-1",
          deviceName: "Spoofed Mac",
          platform: "macOS",
          deviceType: "desktop",
          siteId: "spoofed-mac-site",
          dbVersion: 0,
        },
      },
    }));
    // Desktop unit tests force the sync host into loopback-only mode. That local
    // trust boundary keeps the historical bootstrap-token path available; the
    // LAN-bound production default rejects this path and requires paired auth.
    const bootstrapSpoofOk = await bootstrapSpoofQueue.next("hello_ok");
    expect(bootstrapSpoofOk.type).toBe("hello_ok");
    if (bootstrapSpoofWs.readyState !== WebSocket.CLOSED) {
      bootstrapSpoofWs.close();
      await new Promise((resolve) => bootstrapSpoofWs.once("close", resolve));
    }

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
          deviceName: "Spoofed Mac",
          platform: "macOS",
          deviceType: "desktop",
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

    authWs.send(encodeSyncEnvelope({
      type: "file_request",
      requestId: "paired-spoofed-write",
      payload: {
        action: "writeText",
        args: {
          workspaceId: "workspace-1",
          path: "notes.txt",
          text: "spoofed update",
        },
      },
    }));
    const spoofedWriteResponse = await authQueue.next("file_response");
    const spoofedWritePayload = spoofedWriteResponse.payload as { ok: boolean; error?: { message: string } };
    expect(spoofedWritePayload.ok).toBe(true);
    expect(spoofedWritePayload.error).toBeUndefined();
    expect(fs.readFileSync(path.join(workspaceRoot, "notes.txt"), "utf8")).toBe("spoofed update");

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
    const revokedPayload = revokedHello.payload as {
      code: string;
      message: string;
      host?: { deviceId?: string; name?: string };
    };
    // A revoked device is an unknown device, and an unknown device must look
    // exactly like a stale secret on the wire — so the handshake never tells a
    // caller whether a device id exists. Both answer `repair_required`, which
    // clients read the same way they read `auth_failed`: pair it again.
    expect(revokedPayload.code).toBe("repair_required");
    // The rejection must be attributed: clients only drop a saved pairing
    // when the rejecting machine's identity matches the one they paired with.
    expect(typeof revokedPayload.host?.deviceId).toBe("string");
    expect(revokedPayload.host?.deviceId?.length).toBeGreaterThan(0);
    revokedWs.close();
    await new Promise((resolve) => revokedWs.once("close", resolve));
  });

  it("rejects project-scoped commands without projectId when the host is project-bound", async () => {
    const brainDb = await openKvDb(makeDbPath("ade-sync-command-project-scope-"), createLogger() as any);
    const projectRoot = makeProjectRoot("ade-sync-command-project-scope-project-");
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const host = createSyncHostService({
      db: brainDb,
      logger: createLogger() as any,
      projectId: "project-1",
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
        refresh: vi.fn().mockResolvedValue([]),
      } as any,
      ptyService: {
        create: vi.fn(),
        enrichSessions: (rows: any[]) => rows,
      } as any,
      sessionService: { list: () => [] } as any,
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
      deviceId: "peer-project-scope",
      deviceName: "Project Scope Phone",
      siteId: brainDb.sync.getSiteId(),
      dbVersion: brainDb.sync.getDbVersion(),
      deviceType: "phone",
    });
    activeDisposers.push(client.close);

    client.ws.send(encodeSyncEnvelope({
      type: "command",
      requestId: "cmd-missing-project",
      payload: {
        commandId: "cmd-missing-project",
        action: "lanes.list",
        args: {},
      },
    }));

    const ack = await client.queue.next("command_ack");
    expect((ack.payload as { accepted: boolean }).accepted).toBe(false);
    const result = await client.queue.next("command_result");
    expect((result.payload as { ok: boolean; error?: { code: string } }).ok).toBe(false);
    expect((result.payload as { ok: boolean; error?: { code: string } }).error?.code).toBe("missing_project");
  });

  it("routes project-scoped commands for another registered project through the remote command executor", async () => {
    const brainDb = await openKvDb(makeDbPath("ade-sync-command-project-route-"), createLogger() as any);
    const projectRoot = makeProjectRoot("ade-sync-command-project-route-project-");
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const execute = vi.fn(async (payload: { projectId?: string | null; action?: string }) => ({
      routedProjectId: payload.projectId,
      routedAction: payload.action,
    }));
    const laneList = vi.fn().mockResolvedValue([]);

    const host = createSyncHostService({
      db: brainDb,
      logger: createLogger() as any,
      projectId: "project-1",
      projectRoot,
      port: 0,
      pinStore: createStubPinStore(),
      fileService: createStubFileService(workspaceRoot) as any,
      laneService: {
        list: laneList,
        create: vi.fn(),
        archive: vi.fn(),
      } as any,
      prService: {
        listAll: vi.fn().mockResolvedValue([]),
        refresh: vi.fn().mockResolvedValue([]),
      } as any,
      ptyService: {
        create: vi.fn(),
        enrichSessions: (rows: any[]) => rows,
      } as any,
      sessionService: { list: () => [] } as any,
      computerUseArtifactBrokerService: {
        listArtifacts: () => [],
      } as any,
      remoteCommandExecutor: { execute },
    });
    activeDisposers.push(async () => {
      await host.dispose();
      brainDb.close();
    });

    const client = await connectClient({
      port: await host.waitUntilListening(),
      token: host.getBootstrapToken(),
      deviceId: "peer-project-route",
      deviceName: "Project Route Phone",
      siteId: brainDb.sync.getSiteId(),
      dbVersion: brainDb.sync.getDbVersion(),
      deviceType: "phone",
    });
    activeDisposers.push(client.close);

    client.ws.send(encodeSyncEnvelope({
      type: "command",
      projectId: "project-2",
      requestId: "cmd-other-project",
      payload: {
        commandId: "cmd-other-project",
        action: "lanes.list",
        args: {},
      },
    }));

    const ack = await client.queue.next("command_ack");
    expect((ack.payload as { accepted: boolean }).accepted).toBe(true);
    const result = await client.queue.next("command_result");
    expect((result.payload as { ok: boolean; result?: unknown }).ok).toBe(true);
    expect((result.payload as { result: { routedProjectId: string; routedAction: string } }).result).toEqual({
      routedProjectId: "project-2",
      routedAction: "lanes.list",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(laneList).not.toHaveBeenCalled();
  });

  it("executes project-scoped commands locally when the phone sends the hosted DB project id alias", async () => {
    const brainDb = await openKvDb(makeDbPath("ade-sync-command-project-alias-"), createLogger() as any);
    const projectRoot = makeProjectRoot("ade-sync-command-project-alias-project-");
    const workspaceRoot = path.join(projectRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const execute = vi.fn(async () => ({ routed: true }));
    const laneList = vi.fn().mockResolvedValue([]);

    const host = createSyncHostService({
      db: brainDb,
      logger: createLogger() as any,
      projectId: "project_80c9b7785de5e4060adf68c2",
      projectIdAliases: ["24b96ceb-7ff6-4852-af99-2c36ffa6e9bf"],
      projectRoot,
      port: 0,
      pinStore: createStubPinStore(),
      fileService: createStubFileService(workspaceRoot) as any,
      laneService: {
        list: laneList,
        create: vi.fn(),
        archive: vi.fn(),
      } as any,
      prService: {
        listAll: vi.fn().mockResolvedValue([]),
        refresh: vi.fn().mockResolvedValue([]),
      } as any,
      ptyService: {
        create: vi.fn(),
        enrichSessions: (rows: any[]) => rows,
      } as any,
      sessionService: { list: () => [] } as any,
      computerUseArtifactBrokerService: {
        listArtifacts: () => [],
      } as any,
      remoteCommandExecutor: { execute },
    });
    activeDisposers.push(async () => {
      await host.dispose();
      brainDb.close();
    });

    const client = await connectClient({
      port: await host.waitUntilListening(),
      token: host.getBootstrapToken(),
      deviceId: "peer-project-alias",
      deviceName: "Project Alias Phone",
      siteId: brainDb.sync.getSiteId(),
      dbVersion: brainDb.sync.getDbVersion(),
      deviceType: "phone",
    });
    activeDisposers.push(client.close);

    client.ws.send(encodeSyncEnvelope({
      type: "command",
      projectId: "24b96ceb-7ff6-4852-af99-2c36ffa6e9bf",
      requestId: "cmd-db-project-alias",
      payload: {
        commandId: "cmd-db-project-alias",
        action: "lanes.list",
        args: {},
      },
    }));

    const ack = await client.queue.next("command_ack");
    expect((ack.payload as { accepted: boolean }).accepted).toBe(true);
    const result = await client.queue.next("command_result");
    expect((result.payload as { ok: boolean }).ok).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(laneList).toHaveBeenCalledTimes(1);
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

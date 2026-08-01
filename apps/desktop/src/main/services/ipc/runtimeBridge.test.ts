import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IPC } from "../../../shared/ipc";
import { ATTENTION_CONTRACT_VERSION, type AttentionItem } from "../../../shared/types/attention";
import { PushRelayRequestError } from "../../../../../ade-cli/src/services/push/pushRelayClient";
import type {
  OpenProjectBinding,
  RemoteRuntimeTarget,
} from "../../../shared/types";

const ipcHandlers = vi.hoisted(
  () => new Map<string, (...args: any[]) => unknown>(),
);
const browserWindowFromWebContents = vi.hoisted(() => vi.fn());
const browserWindowFromId = vi.hoisted(() => vi.fn());
const browserWindowGetAllWindows = vi.hoisted(() => vi.fn(() => []));
const showOpenDialogMock = vi.hoisted(() => vi.fn());
const remoteRegistryGetMock = vi.hoisted(() => vi.fn());
const remoteRegistryListMock = vi.hoisted(() => vi.fn<[], RemoteRuntimeTarget[]>(() => []));
const remoteRegistrySaveMock = vi.hoisted(() => vi.fn());
const remoteRegistryRemoveMock = vi.hoisted(() => vi.fn());
const remoteRegistryUpdateMock = vi.hoisted(() => vi.fn());
const remoteRegistryPruneAccountOwnedMock = vi.hoisted(() => vi.fn(() => []));
const remoteConnectMock = vi.hoisted(() => vi.fn());
const remoteProjectsForTargetMock = vi.hoisted(() => vi.fn());
const remoteCallActionForTargetMock = vi.hoisted(() => vi.fn());
const remoteCallSyncForTargetMock = vi.hoisted(() => vi.fn());
const remoteEnsureLocalPortForwardMock = vi.hoisted(() => vi.fn());
const remoteListActionRegistryForTargetMock = vi.hoisted(() => vi.fn());
const remoteCallMachineForTargetMock = vi.hoisted(() => vi.fn());
const remoteStreamEventsForTargetMock = vi.hoisted(() => vi.fn());
const remoteSubscribeEventsForTargetMock = vi.hoisted(() => vi.fn());
const remoteDisconnectMock = vi.hoisted(() => vi.fn());
const hasKnownSshHostKeyForTargetMock = vi.hoisted(() => vi.fn(() => false));
const getSshHostKeyTrustForTargetMock = vi.hoisted(() => vi.fn());
const trustSshHostKeyForTargetMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp"),
    getVersion: vi.fn(() => "1.0.0"),
    isPackaged: false,
  },
  BrowserWindow: {
    fromWebContents: browserWindowFromWebContents,
    fromId: browserWindowFromId,
    getAllWindows: browserWindowGetAllWindows,
  },
  clipboard: {
    readImage: vi.fn(() => ({ isEmpty: () => true })),
    readText: vi.fn(() => ""),
    writeText: vi.fn(),
  },
  desktopCapturer: {
    getSources: vi.fn(async () => []),
  },
  dialog: {
    showOpenDialog: showOpenDialogMock,
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
  powerMonitor: {
    on: vi.fn(),
  },
  nativeImage: {
    createFromPath: vi.fn(() => ({ isEmpty: () => true })),
  },
  shell: {
    openExternal: vi.fn(),
    openPath: vi.fn(),
    showItemInFolder: vi.fn(),
  },
}));

vi.mock("../remoteRuntime/remoteTargetRegistry", () => ({
  RemoteTargetRegistry: vi.fn().mockImplementation(() => ({
    get: remoteRegistryGetMock,
    list: remoteRegistryListMock,
    save: remoteRegistrySaveMock,
    remove: remoteRegistryRemoveMock,
    update: remoteRegistryUpdateMock,
    pruneAccountOwned: remoteRegistryPruneAccountOwnedMock,
  })),
}));

vi.mock("../remoteRuntime/remoteConnectionPool", () => ({
  RemoteConnectionPool: vi.fn().mockImplementation(() => ({
    connect: remoteConnectMock,
    projectsForTarget: remoteProjectsForTargetMock,
    callActionForTarget: remoteCallActionForTargetMock,
    callSyncForTarget: remoteCallSyncForTargetMock,
    ensureLocalPortForward: remoteEnsureLocalPortForwardMock,
    listActionRegistryForTarget: remoteListActionRegistryForTargetMock,
    callMachineForTarget: remoteCallMachineForTargetMock,
    streamEventsForTarget: remoteStreamEventsForTargetMock,
    subscribeEventsForTarget: remoteSubscribeEventsForTargetMock,
    disconnect: remoteDisconnectMock,
    onEntryEvicted: vi.fn(() => () => {}),
  })),
}));

vi.mock("../remoteRuntime/runtimeDiscovery", () => ({
  discoverLanRuntimes: vi.fn(() => ({ machines: [], diagnostics: [] })),
}));

vi.mock("../remoteRuntime/sshTransport", () => ({
  hasKnownSshHostKeyForTarget: hasKnownSshHostKeyForTargetMock,
  getSshHostKeyTrustForTarget: getSshHostKeyTrustForTargetMock,
  trustSshHostKeyForTarget: trustSshHostKeyForTargetMock,
}));

vi.mock("../git/git", () => ({
  runGit: vi.fn(),
}));

import {
  getOrCreateLocalAccountMachineIdentity,
  registerRuntimeBridge,
} from "./runtimeBridge";
import { registerIpc } from "./registerIpc";

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

function sender(id = 42) {
  return {
    id,
    isDestroyed: vi.fn(() => false),
    once: vi.fn(),
    send: vi.fn(),
  } as any;
}

function eventForSender(nextSender = sender()) {
  return { sender: nextSender } as any;
}

function localBinding(rootPath = "/repo"): OpenProjectBinding {
  return {
    kind: "local",
    key: `local:${rootPath}`,
    rootPath,
    displayName: "Repo",
  };
}

describe("registerRuntimeBridge", () => {
  beforeEach(() => {
    ipcHandlers.clear();
    browserWindowFromWebContents.mockReset();
    browserWindowFromId.mockReset().mockReturnValue({
      id: 7,
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false) },
    });
    browserWindowGetAllWindows.mockReset().mockReturnValue([]);
    remoteRegistryGetMock.mockReset();
    remoteRegistryListMock.mockReset().mockReturnValue([]);
    remoteRegistrySaveMock.mockReset();
    remoteRegistryRemoveMock.mockReset();
    remoteRegistryUpdateMock.mockReset().mockImplementation((_id, patch) => ({
      ...target,
      ...patch,
    }));
    remoteRegistryPruneAccountOwnedMock.mockReset().mockReturnValue([]);
    remoteConnectMock.mockReset().mockResolvedValue({
      target,
      arch: "darwin-arm64",
      version: null,
      projects: [],
    });
    remoteProjectsForTargetMock.mockReset();
    remoteCallActionForTargetMock.mockReset();
    remoteCallSyncForTargetMock.mockReset();
    remoteEnsureLocalPortForwardMock.mockReset();
    remoteListActionRegistryForTargetMock.mockReset();
    remoteCallMachineForTargetMock.mockReset();
    remoteStreamEventsForTargetMock.mockReset();
    remoteSubscribeEventsForTargetMock.mockReset().mockResolvedValue(vi.fn());
    remoteDisconnectMock.mockReset();
    hasKnownSshHostKeyForTargetMock.mockReset().mockReturnValue(false);
    getSshHostKeyTrustForTargetMock.mockReset().mockResolvedValue({
      state: "trusted",
    });
    trustSshHostKeyForTargetMock.mockReset().mockResolvedValue({
      trusted: true,
      identity: {
        targetId: target.id,
        host: target.hostname,
        port: target.port ?? 22,
        route: {
          hostname: target.hostname,
          port: target.port,
          source: "manual",
          lastSucceededAt: null,
        },
        keyType: "ssh-ed25519",
        fingerprintSha256: "SHA256:test-key",
        knownHostsPath: "/tmp/known_hosts",
      },
    });
    browserWindowFromWebContents.mockReturnValue({ id: 7 });
  });

  it("reads stable local account identity from the relay and sync device stores", () => {
    const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-account-identity-"));
    try {
      const first = getOrCreateLocalAccountMachineIdentity({
        secretsDir,
        randomUUID: () => "local-device-id",
      });
      const second = getOrCreateLocalAccountMachineIdentity({
        secretsDir,
        randomUUID: () => "should-not-replace-device-id",
      });

      expect(first).toEqual({
        machineKey: expect.stringMatching(/^[a-f0-9]{32}$/),
        deviceId: "local-device-id",
      });
      expect(second).toEqual(first);
      expect(fs.readFileSync(path.join(secretsDir, "sync-device-id"), "utf8").trim())
        .toBe("local-device-id");
    } finally {
      fs.rmSync(secretsDir, { recursive: true, force: true });
    }
  });

  it("reads local pairing info from the local runtime connection", async () => {
    const callSync = vi.fn(async () => ({
      pairingUrl: "https://app.ade-app.dev/pair#payload",
      code: "123456",
      pinConfigured: true,
      machineName: "Studio",
      relayEnabled: true,
      hasRelayCandidate: true,
    }));
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
      localRuntimeConnectionPool: { callSync } as any,
      getWindowSession: () => ({
        windowId: 7,
        project: null,
        binding: null,
      }),
    });

    await expect(
      ipcHandlers.get(IPC.remoteRuntimeGetLocalPairingInfo)?.(eventForSender()),
    ).resolves.toEqual({
      url: "https://app.ade-app.dev/pair#payload",
      pin: "123456",
      machineName: "Studio",
      relayAvailable: true,
    });
    expect(callSync).toHaveBeenCalledWith("sync.getDesktopPairingInfo");
  });

  it.each([
    ["machine name", { pairingUrl: "https://app.ade-app.dev/pair#payload" }],
    ["pairing URL", { machineName: "Studio" }],
  ])("rejects local pairing info missing its %s", async (_field, pairingInfo) => {
    const callSync = vi.fn(async () => pairingInfo);
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
      localRuntimeConnectionPool: { callSync } as any,
      getWindowSession: () => ({
        windowId: 7,
        project: null,
        binding: null,
      }),
    });

    await expect(
      ipcHandlers.get(IPC.remoteRuntimeGetLocalPairingInfo)?.(eventForSender()),
    ).rejects.toThrow("Local ADE runtime did not return pairing information.");
    expect(callSync).toHaveBeenCalledWith("sync.getDesktopPairingInfo");
  });

  it("does not start saved remote autoconnect when disabled for dev/test runs", async () => {
    const previous = process.env.ADE_DISABLE_REMOTE_AUTOCONNECT;
    process.env.ADE_DISABLE_REMOTE_AUTOCONNECT = "1";
    vi.useFakeTimers();
    remoteRegistryListMock.mockReturnValue([
      { ...target, lastConnectedAt: Date.now() },
    ]);

    try {
      registerRuntimeBridge({
        appVersion: "1.0.0",
        globalStatePath: "/tmp/ade-state.json",
        localRuntimeConnectionPool: {} as any,
        getWindowSession: () => ({
          windowId: 7,
          project: null,
          binding: localBinding("/repo"),
        }),
      });

      await vi.runOnlyPendingTimersAsync();

      expect(remoteConnectMock).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.ADE_DISABLE_REMOTE_AUTOCONNECT;
      } else {
        process.env.ADE_DISABLE_REMOTE_AUTOCONNECT = previous;
      }
      vi.useRealTimers();
    }
  });

  it("forwards local project runtime actions with renderer client metadata for file watches", async () => {
    const localRuntimeConnectionPool = {
      callActionForRoot: vi.fn(async () => ({
        ok: true,
        domain: "file",
        action: "watchWorkspace",
        result: { ok: true },
        statusHints: {},
      })),
    };
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
      localRuntimeConnectionPool: localRuntimeConnectionPool as any,
      getWindowSession: () => ({
        windowId: 7,
        project: null,
        binding: localBinding("/repo"),
      }),
    });

    await expect(
      ipcHandlers.get(IPC.localRuntimeCallAction)?.(
        eventForSender(sender(101)),
        {
          request: {
            domain: "file",
            action: "watchWorkspace",
            args: { workspaceId: "main" },
          },
        },
      ),
    ).resolves.toMatchObject({ result: { ok: true } });

    expect(localRuntimeConnectionPool.callActionForRoot).toHaveBeenCalledWith(
      "/repo",
      {
        domain: "file",
        action: "watchWorkspace",
        args: {
          workspaceId: "main",
          __adeRuntimeClientId: 101,
        },
      },
    );
  });

  it("uses an explicit local runtime root when it is already open in the window", async () => {
    const localRuntimeConnectionPool = {
      callActionForRoot: vi.fn(async () => ({
        ok: true,
        domain: "lane",
        action: "list",
        result: [],
        statusHints: {},
      })),
    };
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
      localRuntimeConnectionPool: localRuntimeConnectionPool as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/old-repo", displayName: "Old", baseRef: "main" },
        binding: localBinding("/old-repo"),
        openProjectTabs: [
          { rootPath: "/old-repo", displayName: "Old", baseRef: "main" },
          { rootPath: "/new-repo", displayName: "New", baseRef: "main" },
        ],
      }),
    });

    await expect(
      ipcHandlers.get(IPC.localRuntimeCallAction)?.(
        eventForSender(sender(101)),
        {
          rootPath: "/new-repo",
          request: {
            domain: "lane",
            action: "list",
            args: {},
          },
        },
      ),
    ).resolves.toMatchObject({ result: [] });

    expect(localRuntimeConnectionPool.callActionForRoot).toHaveBeenCalledWith(
      "/new-repo",
      expect.objectContaining({
        domain: "lane",
        action: "list",
      }),
    );
  });

  it("allows a caller-authorized unopened checkout without expanding path authority", async () => {
    const localRuntimeConnectionPool = {
      callActionForRoot: vi.fn(async () => ({
        ok: true,
        domain: "lane",
        action: "list",
        result: [],
        statusHints: {},
      })),
    };
    const authorizeLocalRuntimeRoot = vi.fn((_session, requestedRootPath: string) =>
      requestedRootPath === "/same-repo" ? requestedRootPath : null
    );
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
      localRuntimeConnectionPool: localRuntimeConnectionPool as any,
      authorizeLocalRuntimeRoot,
      getWindowSession: () => ({
        windowId: 7,
        project: null,
        binding: {
          kind: "remote",
          key: "remote:studio:ade",
          targetId: "studio",
          projectId: "ade",
          rootPath: "/Users/arul/ADE",
          displayName: "ADE",
          runtimeName: "Studio",
          hostname: "studio.local",
        },
      }),
    });

    await expect(
      ipcHandlers.get(IPC.localRuntimeCallAction)?.(
        eventForSender(sender(101)),
        {
          rootPath: "/same-repo",
          request: { domain: "lane", action: "list", args: {} },
        },
      ),
    ).resolves.toMatchObject({ result: [] });

    expect(authorizeLocalRuntimeRoot).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 7 }),
      "/same-repo",
    );
    expect(localRuntimeConnectionPool.callActionForRoot).toHaveBeenCalledWith(
      "/same-repo",
      expect.objectContaining({ domain: "lane", action: "list" }),
    );

    await expect(
      ipcHandlers.get(IPC.localRuntimeCallAction)?.(
        eventForSender(sender(101)),
        {
          rootPath: "/different-repo",
          request: { domain: "lane", action: "list", args: {} },
        },
      ),
    ).rejects.toThrow(/not available/i);
  });

  it("rejects explicit local runtime roots that are not bound to the window session", async () => {
    const localRuntimeConnectionPool = {
      callActionForRoot: vi.fn(),
      callSyncForRoot: vi.fn(),
      listActionRegistryForRoot: vi.fn(),
      subscribeEventsForRoot: vi.fn(async () => vi.fn()),
    };
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
      localRuntimeConnectionPool: localRuntimeConnectionPool as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo", baseRef: "main" },
        binding: localBinding("/repo"),
        openProjectTabs: [
          { rootPath: "/repo", displayName: "Repo", baseRef: "main" },
        ],
      }),
    });

    await expect(
      ipcHandlers.get(IPC.localRuntimeCallAction)?.(
        eventForSender(sender(101)),
        {
          rootPath: "/other-repo",
          request: {
            domain: "lane",
            action: "list",
            args: {},
          },
        },
      ),
    ).rejects.toThrow(/not available/i);
    await expect(
      ipcHandlers.get(IPC.localRuntimeCallSync)?.(eventForSender(), {
        rootPath: "/other-repo",
        method: "sync.getStatus",
        params: {},
      }),
    ).rejects.toThrow(/not available/i);
    await expect(
      ipcHandlers.get(IPC.localRuntimeStreamEvents)?.(eventForSender(), {
        rootPath: "/other-repo",
        request: { cursor: 0, limit: 10 },
      }),
    ).rejects.toThrow(/not available/i);
    await expect(
      ipcHandlers.get(IPC.localRuntimeListActionRegistry)?.(eventForSender(), {
        rootPath: "/other-repo",
      }),
    ).rejects.toThrow(/not available/i);

    expect(localRuntimeConnectionPool.callActionForRoot).not.toHaveBeenCalled();
    expect(localRuntimeConnectionPool.callSyncForRoot).not.toHaveBeenCalled();
    expect(localRuntimeConnectionPool.listActionRegistryForRoot).not.toHaveBeenCalled();
    expect(localRuntimeConnectionPool.subscribeEventsForRoot).not.toHaveBeenCalled();
  });

  it("authorizes a pending local runtime root while a project switch is binding", async () => {
    const localRuntimeConnectionPool = {
      callActionForRoot: vi.fn(async () => ({
        ok: true,
        domain: "lane",
        action: "list",
        result: [],
        statusHints: {},
      })),
      subscribeEventsForRoot: vi.fn(async () => vi.fn()),
    };
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
      localRuntimeConnectionPool: localRuntimeConnectionPool as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/old-repo", displayName: "Old", baseRef: "main" },
        binding: localBinding("/old-repo"),
        openProjectTabs: [
          { rootPath: "/old-repo", displayName: "Old", baseRef: "main" },
        ],
        pendingLocalProjectRoots: ["/new-repo"],
      }),
    });

    await expect(
      ipcHandlers.get(IPC.localRuntimeCallAction)?.(
        eventForSender(sender(101)),
        {
          rootPath: "/new-repo",
          request: { domain: "lane", action: "list", args: {} },
        },
      ),
    ).resolves.toMatchObject({ result: [] });
    await expect(
      ipcHandlers.get(IPC.localRuntimeStreamEvents)?.(
        eventForSender(sender(102)),
        {
          rootPath: "/new-repo",
          request: { cursor: 3, limit: 10 },
        },
      ),
    ).resolves.toEqual({ events: [], nextCursor: 3, hasMore: false });

    expect(localRuntimeConnectionPool.callActionForRoot).toHaveBeenCalledWith(
      "/new-repo",
      expect.objectContaining({ domain: "lane", action: "list" }),
    );
    expect(localRuntimeConnectionPool.subscribeEventsForRoot).toHaveBeenCalledWith(
      "/new-repo",
      expect.objectContaining({ cursor: 3, limit: 10 }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("forwards local action registry listing through the authorized local runtime root", async () => {
    const registry = [
      { domain: "chat", actions: [{ name: "launchCli" }] },
      { domain: "git", actions: [{ name: "status" }] },
    ];
    const localRuntimeConnectionPool = {
      listActionRegistryForRoot: vi.fn(async () => registry),
    };
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
      localRuntimeConnectionPool: localRuntimeConnectionPool as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo", baseRef: "main" },
        binding: localBinding("/repo"),
        openProjectTabs: [
          { rootPath: "/repo", displayName: "Repo", baseRef: "main" },
          { rootPath: "/other-repo", displayName: "Other", baseRef: "main" },
        ],
      }),
    });

    await expect(
      ipcHandlers.get(IPC.localRuntimeListActionRegistry)?.(eventForSender(), {
        rootPath: "/other-repo",
      }),
    ).resolves.toEqual(registry);

    expect(localRuntimeConnectionPool.listActionRegistryForRoot).toHaveBeenCalledWith(
      "/other-repo",
    );
  });

  it("authorizes explicit local roots for sync and event streams from open tabs", async () => {
    const localRuntimeConnectionPool = {
      callSyncForRoot: vi.fn(async () => ({ connectedPeers: [] })),
      subscribeEventsForRoot: vi.fn(async () => vi.fn()),
    };
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
      localRuntimeConnectionPool: localRuntimeConnectionPool as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo", baseRef: "main" },
        binding: localBinding("/repo"),
        openProjectTabs: [
          { rootPath: "/repo", displayName: "Repo", baseRef: "main" },
          { rootPath: "/other-repo", displayName: "Other", baseRef: "main" },
        ],
      }),
    });

    await expect(
      ipcHandlers.get(IPC.localRuntimeCallSync)?.(eventForSender(), {
        rootPath: "/other-repo",
        method: "sync.getStatus",
        params: { includeTransferReadiness: true },
      }),
    ).resolves.toEqual({ connectedPeers: [] });
    await expect(
      ipcHandlers.get(IPC.localRuntimeStreamEvents)?.(
        eventForSender(sender(102)),
        {
          rootPath: "/other-repo",
          request: { cursor: 2, limit: 10, category: "sync" },
        },
      ),
    ).resolves.toEqual({ events: [], nextCursor: 2, hasMore: false });

    expect(localRuntimeConnectionPool.callSyncForRoot).toHaveBeenCalledWith(
      "/other-repo",
      "sync.getStatus",
      { includeTransferReadiness: true },
    );
    expect(localRuntimeConnectionPool.subscribeEventsForRoot).toHaveBeenCalledWith(
      "/other-repo",
      { cursor: 2, limit: 10, category: undefined, replay: undefined },
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
  });

  describe("runtime event subscriptions", () => {
    type RecordedSubscription = {
      rootPath: string;
      request: Record<string, unknown>;
      emit: (event: unknown, eventEpoch?: string | null) => void;
      end: () => void;
      cleanup: ReturnType<typeof vi.fn>;
    };

    function recordingLocalRuntimePool() {
      const subscriptions: RecordedSubscription[] = [];
      const pool = {
        subscribeEventsForRoot: vi.fn(
          async (
            rootPath: string,
            request: Record<string, unknown>,
            onEvent: (event: unknown, eventEpoch?: string | null) => void,
            onEnded: () => void,
            onSubscribed?: (result: Record<string, unknown>) => void,
          ) => {
            const cleanup = vi.fn();
            onSubscribed?.({ nextCursor: request.cursor ?? 0, hasMore: false });
            subscriptions.push({
              rootPath,
              request,
              emit: onEvent,
              end: onEnded,
              cleanup,
            });
            return cleanup;
          },
        ),
        streamEventsForRoot: vi.fn(),
      };
      return { subscriptions, pool };
    }

    function destroyableSender(id: number) {
      const destroyedHandlers: Array<() => void> = [];
      const webContents = {
        id,
        isDestroyed: vi.fn(() => false),
        once: vi.fn((channel: string, handler: () => void) => {
          if (channel === "destroyed") destroyedHandlers.push(handler);
        }),
        send: vi.fn(),
      } as any;
      return {
        webContents,
        destroy: () => {
          webContents.isDestroyed.mockReturnValue(true);
          for (const handler of [...destroyedHandlers]) handler();
        },
      };
    }

    function ptyEvent(id: number) {
      return {
        id,
        timestamp: "2026-08-01T00:00:00.000Z",
        category: "pty" as const,
        payload: {
          type: "pty_data",
          event: { ptyId: "pty-1", sessionId: "session-1", data: "out" },
        },
      };
    }

    function registerWithPool(pool: unknown) {
      registerRuntimeBridge({
        appVersion: "1.0.0",
        globalStatePath: "/tmp/ade-state.json",
        localRuntimeConnectionPool: pool as any,
        getWindowSession: () => ({
          windowId: 7,
          project: { rootPath: "/repo", displayName: "Repo", baseRef: "main" },
          binding: localBinding("/repo"),
          openProjectTabs: [
            { rootPath: "/repo", displayName: "Repo", baseRef: "main" },
          ],
        }),
      });
      return ipcHandlers.get(IPC.localRuntimeStreamEvents)!;
    }

    const activePumpRequest = { cursor: 0, limit: 100 };
    const pinnedPtyPumpRequest = { cursor: 0, limit: 200, category: "pty" };

    it("holds the active and pinned pumps as independent subscriptions on one window", async () => {
      const { subscriptions, pool } = recordingLocalRuntimePool();
      const stream = registerWithPool(pool);
      const active = destroyableSender(210);
      const poll = (request: Record<string, unknown>) =>
        stream(eventForSender(active.webContents), {
          rootPath: "/repo",
          request,
        });

      await poll(activePumpRequest);
      await poll(pinnedPtyPumpRequest);

      // Distinct request keys must not evict one another.
      expect(subscriptions).toHaveLength(2);
      expect(subscriptions[0].request).toMatchObject({ category: undefined });
      expect(subscriptions[1].request).toMatchObject({ category: "pty" });
      expect(subscriptions[0].cleanup).not.toHaveBeenCalled();
      expect(subscriptions[1].cleanup).not.toHaveBeenCalled();

      subscriptions[0].emit(ptyEvent(1), "epoch-1");
      subscriptions[1].emit(ptyEvent(2), "epoch-1");
      expect(active.webContents.send).toHaveBeenCalledTimes(2);

      // Re-polling either pump reuses its subscription instead of resubscribing.
      await poll(activePumpRequest);
      await poll(pinnedPtyPumpRequest);
      expect(subscriptions).toHaveLength(2);
      expect(pool.subscribeEventsForRoot).toHaveBeenCalledTimes(2);

      subscriptions[1].emit(ptyEvent(3), "epoch-1");
      expect(active.webContents.send).toHaveBeenCalledTimes(3);
    });

    it("releases every subscription a window holds when its sender is destroyed", async () => {
      const { subscriptions, pool } = recordingLocalRuntimePool();
      const stream = registerWithPool(pool);
      const active = destroyableSender(211);
      const other = destroyableSender(212);

      await stream(eventForSender(active.webContents), {
        rootPath: "/repo",
        request: activePumpRequest,
      });
      await stream(eventForSender(active.webContents), {
        rootPath: "/repo",
        request: pinnedPtyPumpRequest,
      });
      await stream(eventForSender(other.webContents), {
        rootPath: "/repo",
        request: activePumpRequest,
      });
      expect(subscriptions).toHaveLength(3);

      active.destroy();

      expect(subscriptions[0].cleanup).toHaveBeenCalledTimes(1);
      expect(subscriptions[1].cleanup).toHaveBeenCalledTimes(1);
      expect(subscriptions[2].cleanup).not.toHaveBeenCalled();

      subscriptions[1].emit(ptyEvent(4), "epoch-1");
      expect(active.webContents.send).not.toHaveBeenCalled();
      subscriptions[2].emit(ptyEvent(5), "epoch-1");
      expect(other.webContents.send).toHaveBeenCalledTimes(1);
    });

    it("expires subscriptions whose pump stopped polling so they cannot accumulate", async () => {
      const previous = process.env.ADE_DISABLE_REMOTE_AUTOCONNECT;
      process.env.ADE_DISABLE_REMOTE_AUTOCONNECT = "1";
      vi.useFakeTimers();
      try {
        const { subscriptions, pool } = recordingLocalRuntimePool();
        const stream = registerWithPool(pool);
        const active = destroyableSender(213);
        const poll = (request: Record<string, unknown>) =>
          stream(eventForSender(active.webContents), {
            rootPath: "/repo",
            request,
          });

        await poll(activePumpRequest);
        await poll(pinnedPtyPumpRequest);
        expect(subscriptions).toHaveLength(2);

        // The active pump keeps polling; the pinned PTY pump goes away silently.
        for (let tick = 0; tick < 12; tick += 1) {
          await vi.advanceTimersByTimeAsync(10_000);
          await poll(activePumpRequest);
        }

        expect(subscriptions[1].cleanup).toHaveBeenCalledTimes(1);
        expect(subscriptions[0].cleanup).not.toHaveBeenCalled();
        // The surviving pump never resubscribed, so nothing churned either.
        expect(pool.subscribeEventsForRoot).toHaveBeenCalledTimes(2);

        active.webContents.send.mockClear();
        subscriptions[1].emit(ptyEvent(6), "epoch-1");
        expect(active.webContents.send).not.toHaveBeenCalled();
        subscriptions[0].emit(ptyEvent(7), "epoch-1");
        expect(active.webContents.send).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
        if (previous === undefined) {
          delete process.env.ADE_DISABLE_REMOTE_AUTOCONNECT;
        } else {
          process.env.ADE_DISABLE_REMOTE_AUTOCONNECT = previous;
        }
      }
    });

    it("drops every subscription a window holds against a disconnected remote target", async () => {
      remoteRegistryGetMock.mockReturnValue(target);
      const cleanups: Array<ReturnType<typeof vi.fn>> = [];
      remoteSubscribeEventsForTargetMock.mockImplementation(
        async (
          _target: unknown,
          _projectId: string,
          _request: unknown,
          _onEvent: unknown,
          _onEnded: unknown,
          onSubscribed?: (result: Record<string, unknown>) => void,
        ) => {
          const cleanup = vi.fn();
          onSubscribed?.({ nextCursor: 0, hasMore: false });
          cleanups.push(cleanup);
          return cleanup;
        },
      );
      const { pool } = recordingLocalRuntimePool();
      registerWithPool(pool);
      const streamRemote = ipcHandlers.get(IPC.remoteRuntimeStreamEvents)!;
      const disconnect = ipcHandlers.get(IPC.remoteRuntimeDisconnect)!;
      const active = destroyableSender(214);

      await streamRemote(eventForSender(active.webContents), {
        id: target.id,
        projectId: "project-1",
        request: { cursor: 0, limit: 100, replay: false },
      });
      await streamRemote(eventForSender(active.webContents), {
        id: target.id,
        projectId: "project-1",
        request: { cursor: 0, limit: 200, category: "pty", replay: false },
      });
      expect(cleanups).toHaveLength(2);

      await disconnect(eventForSender(active.webContents), { id: target.id });

      expect(cleanups[0]).toHaveBeenCalledTimes(1);
      expect(cleanups[1]).toHaveBeenCalledTimes(1);
    });

    it("releases a local pump's subscription as soon as the renderer says it stopped reading", async () => {
      const { subscriptions, pool } = recordingLocalRuntimePool();
      const stream = registerWithPool(pool);
      const release = ipcHandlers.get(IPC.runtimeEventsRelease)!;
      const active = destroyableSender(215);
      const poll = (request: Record<string, unknown>) =>
        stream(eventForSender(active.webContents), {
          rootPath: "/repo",
          request,
        });

      await poll(activePumpRequest);
      await poll(pinnedPtyPumpRequest);
      expect(subscriptions).toHaveLength(2);

      await expect(
        release(eventForSender(active.webContents), {
          rootPath: "/repo",
          category: "pty",
        }),
      ).resolves.toEqual({ released: 1 });

      // Only the pinned PTY pump's subscription went; the active pump keeps its
      // own, and the released one stops reaching the renderer immediately —
      // without waiting out the 60s idle expiry.
      expect(subscriptions[1].cleanup).toHaveBeenCalledTimes(1);
      expect(subscriptions[0].cleanup).not.toHaveBeenCalled();
      subscriptions[1].emit(ptyEvent(8), "epoch-1");
      expect(active.webContents.send).not.toHaveBeenCalled();
      subscriptions[0].emit(ptyEvent(9), "epoch-1");
      expect(active.webContents.send).toHaveBeenCalledTimes(1);

      await expect(
        release(eventForSender(active.webContents), { rootPath: "/repo" }),
      ).resolves.toEqual({ released: 1 });
      expect(subscriptions[0].cleanup).toHaveBeenCalledTimes(1);
    });

    it("releases both replay variants a remote pinned pump accumulated", async () => {
      remoteRegistryGetMock.mockReturnValue(target);
      const cleanups: Array<ReturnType<typeof vi.fn>> = [];
      remoteSubscribeEventsForTargetMock.mockImplementation(
        async (
          _target: unknown,
          _projectId: string,
          _request: unknown,
          _onEvent: unknown,
          _onEnded: unknown,
          onSubscribed?: (result: Record<string, unknown>) => void,
        ) => {
          const cleanup = vi.fn();
          onSubscribed?.({ nextCursor: 0, hasMore: false });
          cleanups.push(cleanup);
          return cleanup;
        },
      );
      const { pool } = recordingLocalRuntimePool();
      registerWithPool(pool);
      const streamRemote = ipcHandlers.get(IPC.remoteRuntimeStreamEvents)!;
      const release = ipcHandlers.get(IPC.runtimeEventsRelease)!;
      const active = destroyableSender(216);

      // A pinned pump suppresses replay on its first poll and stops suppressing
      // once caught up, so it owns both request-key variants over its life.
      await streamRemote(eventForSender(active.webContents), {
        id: target.id,
        projectId: "project-1",
        request: { cursor: 0, limit: 200, category: "pty", replay: false },
      });
      remoteStreamEventsForTargetMock.mockResolvedValue({
        events: [],
        nextCursor: 5,
        hasMore: false,
      });
      await streamRemote(eventForSender(active.webContents), {
        id: target.id,
        projectId: "project-1",
        request: { cursor: 5, limit: 200, category: "pty" },
      });
      // The replay-bearing path subscribes fire-and-forget alongside its poll.
      await new Promise((resolve) => setImmediate(resolve));
      expect(cleanups).toHaveLength(2);

      await expect(
        release(eventForSender(active.webContents), {
          id: target.id,
          projectId: "project-1",
          category: "pty",
        }),
      ).resolves.toEqual({ released: 2 });
      expect(cleanups[0]).toHaveBeenCalledTimes(1);
      expect(cleanups[1]).toHaveBeenCalledTimes(1);
    });

    it("stops the idle sweeper when an ended subscription empties the registry", async () => {
      const previous = process.env.ADE_DISABLE_REMOTE_AUTOCONNECT;
      process.env.ADE_DISABLE_REMOTE_AUTOCONNECT = "1";
      vi.useFakeTimers();
      try {
        const { subscriptions, pool } = recordingLocalRuntimePool();
        const stream = registerWithPool(pool);
        const active = destroyableSender(217);
        await stream(eventForSender(active.webContents), {
          rootPath: "/repo",
          request: activePumpRequest,
        });
        expect(subscriptions).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(1);

        // The runtime connection dropped, so the subscription ends itself. That
        // path used to leave the sweeper running over an empty registry.
        subscriptions[0].end();

        expect(subscriptions[0].cleanup).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
        if (previous === undefined) {
          delete process.env.ADE_DISABLE_REMOTE_AUTOCONNECT;
        } else {
          process.env.ADE_DISABLE_REMOTE_AUTOCONNECT = previous;
        }
      }
    });
  });

  it("forwards remote project runtime actions through the selected target and project", async () => {
    remoteRegistryGetMock.mockReturnValue(target);
    remoteConnectMock.mockResolvedValue({
      target,
      arch: "linux-x64",
      version: "1.0.0",
      projects: [],
    });
    remoteCallActionForTargetMock.mockResolvedValue({
      ok: true,
      domain: "pty",
      action: "create",
      result: { ptyId: "pty-1" },
      statusHints: {},
    });
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.remoteRuntimeCallAction)?.(
        eventForSender(sender(202)),
        {
          id: "target-1",
          projectId: "project-1",
          request: {
            domain: "pty",
            action: "create",
            args: { startupCommand: "codex login" },
          },
        },
      ),
    ).resolves.toMatchObject({ result: { ptyId: "pty-1" } });

    expect(remoteConnectMock).not.toHaveBeenCalled();
    expect(remoteCallActionForTargetMock).toHaveBeenCalledWith(
      target,
      "project-1",
      {
        domain: "pty",
        action: "create",
        args: { startupCommand: "codex login" },
      },
    );
  });

  it("creates remote port forwards through the selected target", async () => {
    remoteRegistryGetMock.mockReturnValue(target);
    remoteEnsureLocalPortForwardMock.mockResolvedValue({
      targetId: "target-1",
      remoteHost: "127.0.0.1",
      remotePort: 3000,
      localHost: "127.0.0.1",
      localPort: 49152,
      localUrl: "http://127.0.0.1:49152",
      label: "preview",
      createdAt: 1,
      lastUsedAt: 1,
    });
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.remoteRuntimeEnsurePortForward)?.(
        eventForSender(sender(202)),
        {
          id: " target-1 ",
          request: {
            remoteHost: " 127.0.0.1 ",
            remotePort: 3000,
            label: " preview ",
          },
        },
      ),
    ).resolves.toMatchObject({
      localUrl: "http://127.0.0.1:49152",
    });

    expect(remoteConnectMock).toHaveBeenCalledWith(target);
    expect(remoteEnsureLocalPortForwardMock).toHaveBeenCalledWith(
      target.id,
      {
        remoteHost: "127.0.0.1",
        remotePort: 3000,
        label: "preview",
      },
    );
  });

  it("forwards remote project action registry listing through the selected target and project", async () => {
    const registry = [
      { domain: "chat", actions: [{ name: "launchCli" }] },
      { domain: "git", actions: [{ name: "status" }] },
    ];
    remoteRegistryGetMock.mockReturnValue(target);
    remoteConnectMock.mockResolvedValue({
      target,
      arch: "linux-x64",
      version: "1.0.0",
      projects: [],
    });
    remoteListActionRegistryForTargetMock.mockResolvedValue(registry);
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.remoteRuntimeListActionRegistry)?.(
        eventForSender(sender(202)),
        {
          id: "target-1",
          projectId: "project-1",
        },
      ),
    ).resolves.toEqual(registry);

    expect(remoteConnectMock).not.toHaveBeenCalled();
    expect(remoteListActionRegistryForTargetMock).toHaveBeenCalledWith(
      target,
      "project-1",
    );
  });

  it("opens remote event subscriptions without replaying buffered history", async () => {
    remoteRegistryGetMock.mockReturnValue(target);
    remoteStreamEventsForTargetMock.mockResolvedValue({
      events: [{ id: 1, timestamp: "now", category: "runtime", payload: { type: "stale" } }],
      nextCursor: 1,
      hasMore: false,
    });
    remoteSubscribeEventsForTargetMock.mockImplementation(
      async (_target, _projectId, _request, _onEvent, _onEnded, onSubscribed) => {
        onSubscribed?.({
          events: [],
          nextCursor: 7,
          hasMore: false,
          eventEpoch: "epoch-remote-1",
        });
        return vi.fn();
      },
    );
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.remoteRuntimeStreamEvents)?.(
        eventForSender(sender(202)),
        {
          id: "target-1",
          projectId: "project-1",
          request: { cursor: 0, limit: 100, replay: false },
        },
      ),
    ).resolves.toEqual({
      events: [],
      nextCursor: 7,
      hasMore: false,
      eventEpoch: "epoch-remote-1",
    });

    expect(remoteStreamEventsForTargetMock).not.toHaveBeenCalled();
    expect(remoteSubscribeEventsForTargetMock).toHaveBeenCalledWith(
      target,
      "project-1",
      { cursor: 0, limit: 100, category: undefined, replay: false },
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("normalizes malformed remote event stream requests before forwarding", async () => {
    remoteRegistryGetMock.mockReturnValue(target);
    remoteStreamEventsForTargetMock.mockResolvedValue({
      events: [],
      nextCursor: 0,
      hasMore: false,
    });
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.remoteRuntimeStreamEvents)?.(
        eventForSender(sender(202)),
        {
          id: "target-1",
          projectId: "project-1",
          request: ["invalid"] as any,
        },
      ),
    ).resolves.toEqual({ events: [], nextCursor: 0, hasMore: false });

    expect(remoteStreamEventsForTargetMock).toHaveBeenCalledWith(
      target,
      "project-1",
      {},
    );
    expect(remoteSubscribeEventsForTargetMock).toHaveBeenCalledWith(
      target,
      "project-1",
      {
        cursor: undefined,
        limit: undefined,
        category: undefined,
        replay: undefined,
      },
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("cleans a remote event subscription before disconnecting that target", async () => {
    const cleanup = vi.fn();
    remoteRegistryGetMock.mockReturnValue(target);
    remoteSubscribeEventsForTargetMock.mockResolvedValue(cleanup);
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
    });
    const webContents = sender(202);

    await expect(
      ipcHandlers.get(IPC.remoteRuntimeStreamEvents)?.(
        eventForSender(webContents),
        {
          id: "target-1",
          projectId: "project-1",
          request: { cursor: 0, limit: 100, replay: false },
        },
      ),
    ).resolves.toEqual({ events: [], nextCursor: 0, hasMore: false });
    await Promise.resolve();

    await expect(
      ipcHandlers.get(IPC.remoteRuntimeDisconnect)?.(
        eventForSender(webContents),
        { id: "target-1" },
      ),
    ).resolves.toEqual({ disconnected: true });

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(remoteDisconnectMock).toHaveBeenCalledWith("target-1");
  });

  it("rejects unexposed sync methods before calling local or remote runtimes", async () => {
    const localRuntimeConnectionPool = {
      callSyncForRoot: vi.fn(),
    };
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
      localRuntimeConnectionPool: localRuntimeConnectionPool as any,
      getWindowSession: () => ({
        windowId: 7,
        project: null,
        binding: localBinding("/repo"),
      }),
    });
    remoteRegistryGetMock.mockReturnValue(target);

    await expect(
      ipcHandlers.get(IPC.localRuntimeCallSync)?.(eventForSender(), {
        method: "git.status",
        params: {},
      }),
    ).rejects.toThrow(/not exposed/i);
    await expect(
      ipcHandlers.get(IPC.remoteRuntimeCallSync)?.(eventForSender(), {
        id: "target-1",
        projectId: "project-1",
        method: "git.status",
        params: {},
      }),
    ).rejects.toThrow(/not exposed/i);

    expect(localRuntimeConnectionPool.callSyncForRoot).not.toHaveBeenCalled();
    expect(remoteCallSyncForTargetMock).not.toHaveBeenCalled();
  });

  it("forwards allowlisted sync methods with project scope", async () => {
    remoteRegistryGetMock.mockReturnValue(target);
    remoteCallSyncForTargetMock.mockResolvedValue({ connectedPeers: [] });
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.remoteRuntimeCallSync)?.(eventForSender(), {
        id: "target-1",
        projectId: "project-1",
        method: "sync.getStatus",
        params: { includeTransferReadiness: true },
      }),
    ).resolves.toEqual({ connectedPeers: [] });

    expect(remoteCallSyncForTargetMock).toHaveBeenCalledWith(
      target,
      "project-1",
      "sync.getStatus",
      {
        includeTransferReadiness: true,
      },
    );
  });

  it("opens a remote project after refreshing a stale connect project list", async () => {
    const project = {
      projectId: "project-1",
      rootPath: "/srv/ade",
      displayName: "ADE",
      addedAt: 1,
      lastOpenedAt: 2,
      gitOriginUrl: "git@github.com:example/ade.git",
    };
    const bindRemoteProject = vi.fn();
    remoteRegistryGetMock.mockReturnValue(target);
    remoteConnectMock.mockResolvedValue({
      target,
      arch: "linux-x64",
      version: "1.0.0",
      projects: [],
    });
    remoteProjectsForTargetMock.mockResolvedValue([project]);
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
      bindRemoteProject,
    });

    await expect(
      ipcHandlers.get(IPC.remoteRuntimeOpenProject)?.(
        eventForSender(sender(303)),
        {
          id: " target-1 ",
          projectId: " project-1 ",
        },
      ),
    ).resolves.toEqual({
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      hostname: "remote.example.test",
      projectId: "project-1",
      rootPath: "/srv/ade",
      displayName: "ADE",
      gitOriginUrl: "git@github.com:example/ade.git",
      iconDataUrl: null,
    });

    expect(remoteConnectMock).toHaveBeenCalledWith(target, {
      bypassFailureBackoff: true,
    });
    expect(remoteProjectsForTargetMock).toHaveBeenCalledWith(target);
    expect(bindRemoteProject).toHaveBeenCalledWith(7, {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      hostname: "remote.example.test",
      projectId: "project-1",
      rootPath: "/srv/ade",
      displayName: "ADE",
      gitOriginUrl: "git@github.com:example/ade.git",
      iconDataUrl: null,
    });
  });

  it("does not bind a remote project after the sender window is gone", async () => {
    const project = {
      projectId: "project-1",
      rootPath: "/srv/ade",
      displayName: "ADE",
      addedAt: 1,
      lastOpenedAt: 2,
      gitOriginUrl: null,
    };
    type ConnectResult = {
      target: RemoteRuntimeTarget;
      arch: string;
      version: string | null;
      projects: typeof project[];
    };
    let resolveConnect!: (value: ConnectResult) => void;
    const pendingConnect = new Promise<ConnectResult>((resolve) => {
      resolveConnect = resolve;
    });
    const bindRemoteProject = vi.fn();
    remoteRegistryGetMock.mockReturnValue(target);
    remoteConnectMock.mockReturnValue(pendingConnect);
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
      bindRemoteProject,
    });

    const promise = ipcHandlers.get(IPC.remoteRuntimeOpenProject)?.(
      eventForSender(sender(303)),
      {
        id: "target-1",
        projectId: "project-1",
      },
    ) as Promise<OpenProjectBinding & { kind: "remote" }>;
    browserWindowFromId.mockReturnValue(null);
    resolveConnect({
      target,
      arch: "linux-x64",
      version: "1.0.0",
      projects: [project],
    });

    await expect(promise).resolves.toMatchObject({
      projectId: "project-1",
      rootPath: "/srv/ade",
    });
    expect(bindRemoteProject).not.toHaveBeenCalled();
  });

  it("does not bind a stale remote project after overlapping opens resolve out of order", async () => {
    const projectA = {
      projectId: "project-a",
      rootPath: "/srv/a",
      displayName: "Project A",
      addedAt: 1,
      lastOpenedAt: 2,
      gitOriginUrl: null,
    };
    const projectB = {
      projectId: "project-b",
      rootPath: "/srv/b",
      displayName: "Project B",
      addedAt: 1,
      lastOpenedAt: 2,
      gitOriginUrl: null,
    };
    type ConnectResult = {
      target: RemoteRuntimeTarget;
      arch: string;
      version: string | null;
      projects: typeof projectA[];
    };
    let resolveFirst!: (value: ConnectResult) => void;
    let resolveSecond!: (value: ConnectResult) => void;
    const firstConnect = new Promise<ConnectResult>((resolve) => {
      resolveFirst = resolve;
    });
    const secondConnect = new Promise<ConnectResult>((resolve) => {
      resolveSecond = resolve;
    });
    const bindRemoteProject = vi.fn();
    remoteRegistryGetMock.mockReturnValue(target);
    remoteConnectMock
      .mockReturnValueOnce(firstConnect)
      .mockReturnValueOnce(secondConnect);
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
      bindRemoteProject,
    });

    const handler = ipcHandlers.get(IPC.remoteRuntimeOpenProject)!;
    const first = handler(eventForSender(sender(303)), {
      id: "target-1",
      projectId: "project-a",
    }) as Promise<OpenProjectBinding & { kind: "remote" }>;
    const second = handler(eventForSender(sender(303)), {
      id: "target-1",
      projectId: "project-b",
    }) as Promise<OpenProjectBinding & { kind: "remote" }>;

    resolveSecond({
      target,
      arch: "darwin-arm64",
      version: "1.0.0",
      projects: [projectB],
    });
    await expect(second).resolves.toMatchObject({
      projectId: "project-b",
      rootPath: "/srv/b",
    });
    expect(bindRemoteProject).toHaveBeenCalledTimes(1);
    expect(bindRemoteProject).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({ projectId: "project-b" }),
    );

    resolveFirst({
      target,
      arch: "darwin-arm64",
      version: "1.0.0",
      projects: [projectA],
    });
    await expect(first).resolves.toMatchObject({
      projectId: "project-a",
      rootPath: "/srv/a",
    });
    expect(bindRemoteProject).toHaveBeenCalledTimes(1);
  });

  it("forwards a one-shot local GitHub auth header for known remote clone hosts", async () => {
    remoteRegistryGetMock.mockReturnValue(target);
    hasKnownSshHostKeyForTargetMock.mockReturnValue(true);
    remoteCallMachineForTargetMock.mockResolvedValue({
      projectId: "project-cloned",
      rootPath: "/srv/ADE",
      displayName: "ADE",
      addedAt: 1,
      lastOpenedAt: 1,
      gitOriginUrl: "https://github.com/example/ADE.git",
    });
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
      getGitHubTokenForRemoteClone: () => "ghp_local_secret",
    });

    await expect(
      ipcHandlers.get(IPC.remoteRuntimeCloneProject)?.(eventForSender(), {
        id: "target-1",
        input: {
          url: "https://github.com/example/ADE.git",
          parentDir: "/srv",
        },
      }),
    ).resolves.toMatchObject({ rootPath: "/srv/ADE" });

    const expectedBasic = Buffer.from(
      "x-access-token:ghp_local_secret",
      "utf8",
    ).toString("base64");
    expect(remoteCallMachineForTargetMock).toHaveBeenCalledWith(
      target,
      "projects.clone",
      {
        url: "https://github.com/example/ADE.git",
        parentDir: "/srv",
        githubAuthHeader: `basic ${expectedBasic}`,
        catalogVisibility: "recent",
        registrationSource: "desktop",
      },
      { retryOnConnectionError: false },
    );
    expect(hasKnownSshHostKeyForTargetMock).toHaveBeenCalledWith(target);
  });

  it("never forwards source credentials for destination-owned handoff clones", async () => {
    const getGitHubTokenForRemoteClone = vi.fn(() => "ghp_local_secret");
    remoteRegistryGetMock.mockReturnValue(target);
    hasKnownSshHostKeyForTargetMock.mockReturnValue(true);
    remoteCallMachineForTargetMock.mockResolvedValue({
      projectId: "project-cloned",
      rootPath: "/srv/ADE",
      displayName: "ADE",
      addedAt: 1,
      lastOpenedAt: 1,
      gitOriginUrl: "https://github.com/example/ADE.git",
    });
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
      getGitHubTokenForRemoteClone,
    });

    await expect(
      ipcHandlers.get(IPC.remoteRuntimeCloneProject)?.(eventForSender(), {
        id: "target-1",
        input: {
          url: "https://github.com/example/ADE.git",
          parentDir: "/srv",
          githubAuthHeader: "basic renderer-supplied-secret",
        },
        options: { credentialMode: "destination_only" },
      }),
    ).resolves.toMatchObject({ rootPath: "/srv/ADE" });

    expect(getGitHubTokenForRemoteClone).not.toHaveBeenCalled();
    expect(hasKnownSshHostKeyForTargetMock).not.toHaveBeenCalled();
    expect(remoteCallMachineForTargetMock).toHaveBeenCalledWith(
      target,
      "projects.clone",
      {
        url: "https://github.com/example/ADE.git",
        parentDir: "/srv",
        catalogVisibility: "recent",
        registrationSource: "desktop",
      },
      { retryOnConnectionError: false },
    );
  });

  it("does not forward clone auth headers to unknown remote hosts", async () => {
    const getGitHubTokenForRemoteClone = vi.fn(() => "ghp_local_secret");
    remoteRegistryGetMock.mockReturnValue(target);
    remoteCallMachineForTargetMock.mockResolvedValue({
      projectId: "project-cloned",
      rootPath: "/srv/ADE",
      displayName: "ADE",
      addedAt: 1,
      lastOpenedAt: 1,
      gitOriginUrl: "https://github.com/example/ADE.git",
    });
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
      getGitHubTokenForRemoteClone,
    });

    await expect(
      ipcHandlers.get(IPC.remoteRuntimeCloneProject)?.(eventForSender(), {
        id: "target-1",
        input: {
          url: "https://github.com/example/ADE.git",
          parentDir: "/srv",
          githubAuthHeader: "basic renderer-supplied-secret",
        },
      }),
    ).resolves.toMatchObject({ rootPath: "/srv/ADE" });

    expect(getGitHubTokenForRemoteClone).not.toHaveBeenCalled();
    expect(remoteCallMachineForTargetMock).toHaveBeenCalledWith(
      target,
      "projects.clone",
      {
        url: "https://github.com/example/ADE.git",
        parentDir: "/srv",
        catalogVisibility: "recent",
        registrationSource: "desktop",
      },
      { retryOnConnectionError: false },
    );
  });

  it("routes personal chat calls through the local machine runtime without a project", async () => {
    const callSync = vi.fn().mockResolvedValue({ action: "list", result: [] });
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
      localRuntimeConnectionPool: { callSync } as any,
      getWindowSession: () => ({ windowId: 7, project: null, binding: null }),
    });

    await expect(
      ipcHandlers.get(IPC.personalChatsCall)?.(eventForSender(), {
        action: "list",
        args: { includeArchived: false },
      }),
    ).resolves.toEqual({ action: "list", result: [] });
    expect(callSync).toHaveBeenCalledWith("personalChats.call", {
      action: "list",
      args: { includeArchived: false },
    });
    expect(remoteCallMachineForTargetMock).not.toHaveBeenCalled();
  });

  it("routes personal chat calls to the bound remote machine", async () => {
    remoteRegistryGetMock.mockReturnValue(target);
    remoteCallMachineForTargetMock.mockResolvedValue({
      action: "send",
      result: { accepted: true },
    });
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/remote", displayName: "Remote" } as any,
        binding: {
          kind: "remote",
          key: "remote:target-1:project-1",
          targetId: "target-1",
          projectId: "project-1",
          rootPath: "/remote",
          displayName: "Remote",
          runtimeName: "Remote",
        },
      }),
    });

    await expect(
      ipcHandlers.get(IPC.personalChatsCall)?.(eventForSender(), {
        action: "send",
        args: { sessionId: "personal-1", text: "hello" },
      }),
    ).resolves.toEqual({ action: "send", result: { accepted: true } });
    expect(remoteCallMachineForTargetMock).toHaveBeenCalledWith(
      target,
      "personalChats.call",
      {
        action: "send",
        args: { sessionId: "personal-1", text: "hello" },
      },
      {},
    );
    expect(remoteRegistryGetMock).toHaveBeenCalledWith("target-1");
  });

  it("routes personal chat event polling to the bound remote machine", async () => {
    remoteRegistryGetMock.mockReturnValue(target);
    remoteCallMachineForTargetMock.mockResolvedValue({ events: [], nextCursor: 12, hasMore: false });
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/remote", displayName: "Remote" } as any,
        binding: {
          kind: "remote",
          key: "remote:target-1:project-1",
          targetId: "target-1",
          projectId: "project-1",
          rootPath: "/remote",
          displayName: "Remote",
          runtimeName: "Remote",
        },
      }),
    });

    await expect(
      ipcHandlers.get(IPC.personalChatsStreamEvents)?.(eventForSender(), { cursor: 12, limit: 50 }),
    ).resolves.toEqual({ events: [], nextCursor: 12, hasMore: false });
    expect(remoteCallMachineForTargetMock).toHaveBeenCalledWith(
      target,
      "personalChats.streamEvents",
      { cursor: 12, limit: 50 },
      {},
    );
    expect(remoteRegistryGetMock).toHaveBeenCalledWith("target-1");
  });

  it("routes personal chat event polling through the local machine runtime", async () => {
    const callSync = vi.fn().mockResolvedValue({ events: [], nextCursor: 0, hasMore: false });
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
      localRuntimeConnectionPool: { callSync } as any,
      getWindowSession: () => ({ windowId: 7, project: null, binding: null }),
    });

    await expect(
      ipcHandlers.get(IPC.personalChatsStreamEvents)?.(eventForSender(), {
        cursor: -2.4,
        limit: 900,
      }),
    ).resolves.toEqual({ events: [], nextCursor: 0, hasMore: false });
    expect(callSync).toHaveBeenCalledWith("personalChats.streamEvents", {
      cursor: 0,
      limit: 500,
    });
    expect(remoteCallMachineForTargetMock).not.toHaveBeenCalled();
  });
});

describe("registerIpc sync bridge", () => {
  beforeEach(() => {
    ipcHandlers.clear();
    browserWindowFromWebContents.mockReset().mockReturnValue({ id: 7 });
    showOpenDialogMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches lane archived automation once after IPC reclaim archives, even when removal later fails", async () => {
    const onLaneArchived = vi.fn();
    const archiveAndReclaim = vi.fn()
      .mockImplementationOnce(async (
        _args: unknown,
        options?: { onArchived?: () => void },
      ) => {
        expect(onLaneArchived).not.toHaveBeenCalled();
        options?.onArchived?.();
        throw new Error("disk is busy");
      })
      .mockRejectedValueOnce(new Error("confirmation required"));
    registerIpc({
      getCtx: () => ({
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
        laneService: {
          list: vi.fn(async () => [{
            id: "lane-1",
            name: "Feature",
            branchRef: "refs/heads/feature",
            folder: "feature",
          }]),
          archiveAndReclaim,
        },
        automationService: { onLaneArchived },
      }) as any,
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    const handler = ipcHandlers.get(IPC.lanesArchiveAndReclaim);
    await expect(handler?.(eventForSender(), {
      laneId: "lane-1",
      confirmation: "RECLAIM",
    })).rejects.toThrow(/disk is busy/i);
    expect(onLaneArchived).toHaveBeenCalledTimes(1);
    expect(onLaneArchived).toHaveBeenCalledWith({
      laneId: "lane-1",
      laneName: "Feature",
      branchRef: "refs/heads/feature",
      folder: "feature",
    });

    await expect(handler?.(eventForSender(), {
      laneId: "lane-1",
      confirmation: "invalid",
    })).rejects.toThrow(/confirmation required/i);
    expect(onLaneArchived).toHaveBeenCalledTimes(1);
  });

  it("routes account Attention directly to the relay regardless of the selected remote project", async () => {
    const snapshot = {
      contractVersion: ATTENTION_CONTRACT_VERSION,
      streamId: "account-stream",
      revision: 5,
      generatedAt: "2026-07-28T12:00:00.000Z",
      items: [{ id: "attention-1", revision: 5 } as never],
      tombstones: [],
    };
    const callAttention = vi.fn();
    const accountAttentionClient = {
      getAttentionSnapshot: vi.fn(async () => snapshot),
      acknowledgeAttention: vi.fn(async () => ({
        applied: ["attention-1"],
        stale: [],
      })),
      reportAttentionPresence: vi.fn(async () => undefined),
      getAttentionPreferences: vi.fn(async () => ({ account: { hideDetails: true } })),
      putAttentionPreferences: vi.fn(async () => undefined),
      putActivityMachinePreferences: vi.fn(async () => undefined),
    };
    const openAttentionItem = vi.fn(async () => undefined);
    registerIpc({
      getCtx: () => ({
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }) as any,
      localRuntimeConnectionPool: { callAttention } as any,
      accountAttentionClient: accountAttentionClient as any,
      getCurrentAccountOwnerId: () => "account-a",
      getWindowSession: () => ({
        windowId: 7,
        project: null,
        binding: {
          kind: "remote",
          key: "remote:other-machine:project",
          targetId: "other-machine",
          runtimeName: "Other machine",
          projectId: "remote-project",
          rootPath: "/srv/remote",
          displayName: "Remote",
        },
      }),
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
      openAttentionItem,
    });

    await expect(
      ipcHandlers.get(IPC.attentionGetSnapshot)?.(eventForSender(), {
        since: 4,
        streamId: "account-stream",
      }),
    ).resolves.toMatchObject({
      ...snapshot,
      scope: "account",
      availability: { state: "ready" },
    });
    await ipcHandlers.get(IPC.attentionAcknowledge)?.(eventForSender(), {
      itemIds: ["attention-1"],
      sourceRevisions: { "attention-1": 5 },
      expectedAccountOwnerId: "account-a",
      seenAt: "2026-07-28T12:01:00.000Z",
    });
    await ipcHandlers.get(IPC.attentionReportPresence)?.(eventForSender(), {
      deviceId: "desktop-1",
      platform: "macOS",
    });
    await expect(
      ipcHandlers.get(IPC.attentionGetPreferences)?.(eventForSender(), {
        accountOwnerId: "account-a",
      }),
    ).resolves.toEqual({ account: { hideDetails: true } });
    await ipcHandlers.get(IPC.attentionPutPreferences)?.(
      eventForSender(),
      {
        accountOwnerId: "account-a",
        preferences: { account: { hideDetails: false } },
      },
    );
    await ipcHandlers.get(IPC.attentionPutMachinePreferences)?.(
      eventForSender(),
      {
        accountOwnerId: "account-a",
        machineKey: "machine-a",
        preferences: { notificationsEnabled: false },
      },
    );
    const attentionItem: AttentionItem = {
      contractVersion: ATTENTION_CONTRACT_VERSION,
      id: "attention-1",
      revision: 5,
      fingerprint: "attention-1:5",
      kind: "agent",
      eventKind: "agent_needs_you",
      phase: "needs_you",
      machine: {
        machineKey: "machine-a",
        name: "Machine A",
        online: true,
        lastSeenAt: "2026-07-28T12:00:00.000Z",
      },
      project: {
        projectId: "project-a",
        name: "Project A",
        rootPath: "/repo",
      },
      provider: "codex",
      model: "gpt-5",
      title: "Needs approval",
      preview: "Approve the command",
      privacyPreview: "Agent needs attention",
      detail: null,
      recentActivity: [],
      planProgress: null,
      destination: {
        kind: "session",
        sessionId: "session-a",
        itemId: "attention-1",
        eventId: null,
      },
      actions: [],
      occurredAt: "2026-07-28T12:00:00.000Z",
      updatedAt: "2026-07-28T12:00:00.000Z",
      seenAt: null,
      dismissedAt: null,
      expiresAt: null,
    };
    await ipcHandlers.get(IPC.attentionOpenItem)?.(eventForSender(), attentionItem);

    expect(callAttention).not.toHaveBeenCalled();
    expect(accountAttentionClient.getAttentionSnapshot).toHaveBeenCalledWith(
      4,
      "account-stream",
    );
    expect(accountAttentionClient.acknowledgeAttention).toHaveBeenCalledWith({
      itemIds: ["attention-1"],
      sourceRevisions: { "attention-1": 5 },
      expectedAccountOwnerId: "account-a",
      seenAt: "2026-07-28T12:01:00.000Z",
    });
    expect(accountAttentionClient.getAttentionPreferences).toHaveBeenCalledWith("account-a");
    expect(accountAttentionClient.putAttentionPreferences).toHaveBeenCalledWith(
      "account-a",
      { account: { hideDetails: false } },
    );
    expect(accountAttentionClient.putActivityMachinePreferences).toHaveBeenCalledWith(
      "account-a",
      "machine-a",
      { notificationsEnabled: false },
    );
    expect(openAttentionItem).toHaveBeenCalledWith(attentionItem);

    openAttentionItem.mockRejectedValueOnce(
      new Error("No ADE window is available for this project."),
    );
    await expect(
      ipcHandlers.get(IPC.attentionOpenItem)?.(eventForSender(), attentionItem),
    ).rejects.toThrow("No ADE window is available for this project.");
  });

  it("falls back to an explicitly machine-scoped snapshot when signed out", async () => {
    const machineSnapshot = {
      contractVersion: ATTENTION_CONTRACT_VERSION,
      scope: "machine" as const,
      streamId: "machine:local",
      revision: 2,
      generatedAt: "2026-07-28T12:00:00.000Z",
      items: [],
      tombstones: [],
    };
    const callAttention = vi.fn(async (action: string) => {
      if (action === "getMachineSnapshot") return machineSnapshot;
      throw new Error(`unexpected action ${action}`);
    });
    registerIpc({
      getCtx: () => ({
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }) as any,
      localRuntimeConnectionPool: { callAttention } as any,
      getCurrentAccountOwnerId: () => null,
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.attentionGetSnapshot)?.(eventForSender(), {
        since: 99,
        streamId: "account-old",
      }),
    ).resolves.toMatchObject({
      streamId: "machine:local",
      scope: "machine",
      availability: {
        state: "signed_out",
        recovery: "sign_in",
      },
    });
    expect(callAttention).toHaveBeenCalledWith("getMachineSnapshot", {});
  });

  it("sanitizes account auth failures and names the machine fallback", async () => {
    const accountAttentionClient = {
      getAttentionSnapshot: vi.fn(async () => {
        throw new PushRelayRequestError(
          "getAttentionSnapshot",
          401,
          "account token rejected",
        );
      }),
    };
    const callAttention = vi.fn(async (action: string) => {
      if (action === "getMachineSnapshot") {
        return {
          contractVersion: ATTENTION_CONTRACT_VERSION,
          scope: "machine",
          streamId: "machine:macbook",
          revision: 3,
          generatedAt: "2026-07-28T12:00:00.000Z",
          machines: [{ name: "Arul's MacBook Pro" }],
          items: [],
          tombstones: [],
        };
      }
      throw new Error(`unexpected action ${action}`);
    });
    registerIpc({
      getCtx: () => ({
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }) as any,
      localRuntimeConnectionPool: { callAttention } as any,
      accountAttentionClient: accountAttentionClient as any,
      getCurrentAccountOwnerId: () => "account-a",
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    const snapshot = await ipcHandlers.get(IPC.attentionGetSnapshot)?.(
      eventForSender(),
      { since: 0, streamId: null },
    ) as Record<string, any>;

    expect(snapshot.availability).toMatchObject({
      state: "degraded",
      title: "Account session needs attention",
      recovery: "sign_in",
      hostName: "Arul's MacBook Pro",
    });
    expect(snapshot.availability.message).toContain("Showing work from Arul's MacBook Pro");
    expect(snapshot.availability.message).not.toMatch(/push relay|HTTP 401|account token rejected/i);
  });

  it("reports an old brain Attention contract once instead of returning an empty notch", async () => {
    const logger = {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };
    const callAttention = vi.fn(async () => {
      throw new Error(
        "Remote ADE service method attention.call failed (code -32601): Method not found",
      );
    });
    registerIpc({
      getCtx: () => ({ logger }) as any,
      localRuntimeConnectionPool: { callAttention } as any,
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    const readSnapshot = () =>
      ipcHandlers.get(IPC.attentionGetSnapshot)?.(eventForSender(), {
        since: 0,
        streamId: null,
      });
    await expect(readSnapshot()).rejects.toThrow(
      /requires a newer connected ADE brain.*update and restart ADE.*host machine/i,
    );
    await expect(readSnapshot()).rejects.toThrow(/requires a newer connected ADE brain/i);

    expect(callAttention).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "attention.runtime_incompatible",
      expect.objectContaining({
        recovery: "update_and_restart_ade_brain",
      }),
    );
  });

  it("rejects a stale renderer Attention preference owner before calling the runtime", async () => {
    const callAttention = vi.fn();
    registerIpc({
      getCtx: () => ({
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }) as any,
      localRuntimeConnectionPool: { callAttention } as any,
      getCurrentAccountOwnerId: () => "account-b",
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.attentionGetPreferences)?.(eventForSender(), {
        accountOwnerId: "account-a",
      }),
    ).rejects.toThrow(/account changed/i);
    await expect(
      ipcHandlers.get(IPC.attentionPutPreferences)?.(eventForSender(), {
        accountOwnerId: "account-a",
        preferences: { account: { hideDetails: true } },
      }),
    ).rejects.toThrow(/account changed/i);
    expect(callAttention).not.toHaveBeenCalled();
  });

  it("validates recovery identifiers and target ownership before mutating chat state", async () => {
    const assertRecoveryTargetOwned = vi.fn(async (args: {
      sessionId: string;
      turnId?: string;
      steerId?: string;
    }) => {
      if (
        args.sessionId !== "chat-1"
        || (args.turnId !== undefined && args.turnId !== "turn-1")
        || (args.steerId !== undefined && args.steerId !== "steer-1")
      ) {
        throw new Error("Recovery target does not belong to this project chat.");
      }
    });
    const recoverTurn = vi.fn(async (args) => ({
      action: args.action,
      turnId: args.turnId,
      status: "waiting",
    }));
    const recoverCodexTurn = vi.fn(async (args) => ({
      action: args.action,
      turnId: args.turnId,
      status: "waiting",
    }));
    const resolveUnprocessedMessage = vi.fn(async (args) => ({
      steerId: args.steerId,
      action: args.action,
      status: "completed",
    }));
    registerIpc({
      getCtx: () => ({
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        agentChatService: {
          assertRecoveryTargetOwned,
          recoverTurn,
          recoverCodexTurn,
          resolveUnprocessedMessage,
        },
      }) as any,
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(ipcHandlers.get(IPC.agentChatRecoverTurn)?.(eventForSender(), {
      sessionId: "chat-1",
      turnId: "turn-1",
      action: "wait",
    })).resolves.toMatchObject({ action: "wait", turnId: "turn-1" });
    await expect(ipcHandlers.get(IPC.agentChatRecoverCodexTurn)?.(eventForSender(), {
      sessionId: "chat-1",
      turnId: "turn-1",
      action: "steer",
    })).resolves.toMatchObject({ action: "steer", turnId: "turn-1" });
    await expect(ipcHandlers.get(IPC.agentChatResolveUnprocessedMessage)?.(eventForSender(), {
      sessionId: "chat-1",
      steerId: "steer-1",
      action: "dismiss",
    })).resolves.toMatchObject({ action: "dismiss", steerId: "steer-1" });

    await expect(ipcHandlers.get(IPC.agentChatRecoverTurn)?.(eventForSender(), {
      sessionId: "../foreign-chat",
      turnId: "turn-1",
      action: "wait",
    })).rejects.toThrow(/sessionId is malformed/i);
    await expect(ipcHandlers.get(IPC.agentChatRecoverTurn)?.(eventForSender(), {
      sessionId: "chat-1",
      turnId: "turn-from-another-chat",
      action: "wait",
    })).rejects.toThrow(/does not belong/i);
    await expect(ipcHandlers.get(IPC.agentChatResolveUnprocessedMessage)?.(eventForSender(), {
      sessionId: "chat-1",
      steerId: "steer-from-another-chat",
      action: "run_next",
    })).rejects.toThrow(/does not belong/i);

    expect(recoverTurn).toHaveBeenCalledTimes(1);
    expect(recoverCodexTurn).toHaveBeenCalledTimes(1);
    expect(resolveUnprocessedMessage).toHaveBeenCalledTimes(1);
  });

  it("preserves and validates exact lookup and launch overrides across external-session IPC parsing", async () => {
    const list = vi.fn(async () => []);
    const importExternalSession = vi.fn(async () => ({
      kind: "cli" as const,
      sessionId: "terminal-1",
      ptyId: "pty-1",
      laneId: "lane-1",
    }));
    registerIpc({
      getCtx: () => ({
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        externalSessionsService: { list, importExternalSession },
      }) as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo" } as any,
        binding: localBinding("/repo"),
      }),
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await ipcHandlers.get(IPC.externalSessionsList)?.(eventForSender(), {
      providers: ["codex"],
      sessionId: "native-session-1",
      limit: 1,
    });
    await ipcHandlers.get(IPC.externalSessionsImport)?.(eventForSender(), {
      provider: "codex",
      sessionId: "native-session-1",
      laneId: "lane-1",
      target: "cli",
      mode: "resume",
      model: "gpt-5.6-codex",
      reasoningEffort: "high",
      fastMode: true,
      permissionMode: "default",
    });
    await ipcHandlers.get(IPC.externalSessionsList)?.(eventForSender(), {
      sessionId: 42,
    });
    await ipcHandlers.get(IPC.externalSessionsImport)?.(eventForSender(), {
      provider: "codex",
      sessionId: "native-session-1",
      laneId: "lane-1",
      target: "cli",
      mode: "resume",
      reasoningEffort: 42,
      fastMode: "yes",
    });

    expect(list).toHaveBeenNthCalledWith(1, {
      providers: ["codex"],
      sessionId: "native-session-1",
      limit: 1,
    });
    expect(importExternalSession).toHaveBeenNthCalledWith(1, {
      provider: "codex",
      sessionId: "native-session-1",
      laneId: "lane-1",
      target: "cli",
      mode: "resume",
      model: "gpt-5.6-codex",
      reasoningEffort: "high",
      fastMode: true,
      permissionMode: "default",
    });
    expect(list).toHaveBeenNthCalledWith(2, {});
    expect(importExternalSession).toHaveBeenNthCalledWith(2, {
      provider: "codex",
      sessionId: "native-session-1",
      laneId: "lane-1",
      target: "cli",
      mode: "resume",
    });
  });

  it("shows hidden dotenv variants in the import picker", async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] });
    registerIpc({
      getCtx: () => ({
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }) as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo" } as any,
        binding: localBinding("/repo"),
      }),
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.projectSecretsChooseEnvFile)?.(eventForSender()),
    ).resolves.toBeNull();

    expect(showOpenDialogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        properties: ["openFile", "showHiddenFiles"],
      }),
    );
    expect(showOpenDialogMock.mock.calls[0]?.[1]).not.toHaveProperty("filters");
  });

  it("preserves browser actor identity and lease fields across renderer IPC parsing", async () => {
    const previousDevServerUrl = process.env.VITE_DEV_SERVER_URL;
    process.env.VITE_DEV_SERVER_URL = "http://localhost:5173";
    const requestOriginAccess = vi.fn(async (input: unknown) => input);
    browserWindowFromWebContents.mockReturnValue({ id: 7, isDestroyed: () => false });
    try {
      registerIpc({
        getCtx: () => ({
          logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        }) as any,
        getWindowSession: () => ({
          windowId: 7,
          project: { rootPath: "/repo", displayName: "Repo" } as any,
          binding: localBinding("/repo"),
        }),
        switchProjectFromDialog: vi.fn(),
        closeCurrentProject: vi.fn(),
        closeProjectByPath: vi.fn(),
        globalStatePath: "/tmp/ade-state.json",
        builtInBrowserService: { requestOriginAccess } as any,
      });
      const handler = ipcHandlers.get(IPC.builtInBrowserRequestOriginAccess)!;
      const senderWebContents = {
        ...sender(),
        getURL: () => "http://localhost:5173/work",
      };

      await expect(handler({
        sender: senderWebContents,
        senderFrame: { url: "http://localhost:5173/work" },
      }, {
        projectRoot: "/repo",
        tabId: "tab-1",
        sessionId: "browser-session-1",
        laneId: "lane-1",
        chatSessionId: "chat-1",
        force: true,
        leaseTtlMs: 5_000,
      })).resolves.toMatchObject({
        projectRoot: "/repo",
        tabId: "tab-1",
        sessionId: "browser-session-1",
        laneId: "lane-1",
        chatSessionId: "chat-1",
        force: true,
        leaseTtlMs: 5_000,
      });
      expect(requestOriginAccess).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-1",
        chatSessionId: "chat-1",
        force: true,
        leaseTtlMs: 5_000,
      }), expect.objectContaining({ id: 7 }));
    } finally {
      if (previousDevServerUrl == null) delete process.env.VITE_DEV_SERVER_URL;
      else process.env.VITE_DEV_SERVER_URL = previousDevServerUrl;
    }
  });

  it("validates usage range arguments before forwarding renderer IPC", async () => {
    const getAdeUsageStats = vi.fn(async () => ({ generatedAt: "2026-07-09T12:00:00.000Z" }));
    registerIpc({
      getCtx: () => ({
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        usageTrackingService: { getAdeUsageStats },
      }) as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo" } as any,
        binding: localBinding("/repo"),
      }),
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });
    const handler = ipcHandlers.get(IPC.usageGetAdeStats)!;

    await expect(handler(eventForSender(), { preset: "decade" })).rejects.toThrow(
      "usage stats preset must be today, 7d, 30d, year, or all.",
    );
    await expect(handler(eventForSender(), { since: "not-a-date" })).rejects.toThrow(
      "usage stats since must be an ISO timestamp.",
    );
    await expect(handler(eventForSender(), { until: "not-a-date" })).rejects.toThrow(
      "usage stats until must be an ISO timestamp.",
    );
    expect(getAdeUsageStats).not.toHaveBeenCalled();

    const args = {
      preset: "30d",
      since: "2026-07-01T12:00:00.000Z",
      until: "2026-07-02T12:00:00.000Z",
    };
    await expect(handler(eventForSender(), args)).resolves.toEqual({
      generatedAt: "2026-07-09T12:00:00.000Z",
    });
    expect(getAdeUsageStats).toHaveBeenCalledWith(args);
  });

  it("uses the sender window's bound local project for iOS Simulator window sources", async () => {
    const repoGetStatus = vi.fn(async () => ({
      platform: "darwin",
      supported: false,
      tools: [],
      activeDevice: null,
      activeSession: null,
    }));
    const otherGetStatus = vi.fn(async () => ({
      platform: "darwin",
      supported: false,
      tools: [],
      activeDevice: null,
      activeSession: null,
    }));
    const contexts = new Map<string, any>([
      ["/repo", {
        project: { rootPath: "/repo" },
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        iosSimulatorService: { getStatus: repoGetStatus },
      }],
      ["/other", {
        project: { rootPath: "/other" },
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        iosSimulatorService: { getStatus: otherGetStatus },
      }],
    ]);
    const getProjectContext = vi.fn((root: string) => contexts.get(root) ?? null);
    registerIpc({
      getCtx: () => ({
        project: { rootPath: "/fallback" },
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        iosSimulatorService: { getStatus: vi.fn(async () => ({ supported: false })) },
      }) as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo" } as any,
        binding: localBinding("/repo"),
      }),
      getProjectContext,
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.iosSimulatorListWindowSources)?.(
        eventForSender(),
        { projectRoot: "/repo" },
      ),
    ).resolves.toEqual([]);

    expect(getProjectContext).toHaveBeenCalledWith("/repo");
    expect(repoGetStatus).toHaveBeenCalledTimes(1);
    expect(otherGetStatus).not.toHaveBeenCalled();
  });

  it("uses the bound local runtime for iOS Simulator window sources when no in-process project context is loaded", async () => {
    const getProjectContext = vi.fn(() => null);
    const localRuntimeConnectionPool = {
      callActionForRoot: vi.fn(async () => ({
        domain: "ios_simulator",
        action: "getStatus",
        result: {
          platform: "darwin",
          supported: false,
          tools: [],
          activeDevice: null,
          activeSession: null,
        },
        statusHints: {},
      })),
    };
    registerIpc({
      getCtx: () => ({
        project: { rootPath: "/fallback" },
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }) as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo" } as any,
        binding: localBinding("/repo"),
      }),
      getProjectContext,
      localRuntimeConnectionPool: localRuntimeConnectionPool as any,
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.iosSimulatorListWindowSources)?.(
        eventForSender(),
        { projectRoot: "/repo" },
      ),
    ).resolves.toEqual([]);

    expect(getProjectContext).toHaveBeenCalledWith("/repo");
    expect(localRuntimeConnectionPool.callActionForRoot).toHaveBeenCalledWith(
      "/repo",
      {
        domain: "ios_simulator",
        action: "getStatus",
        args: {},
      },
    );
  });

  it("rejects malformed local-runtime iOS Simulator status for window sources", async () => {
    const getProjectContext = vi.fn(() => null);
    const localRuntimeConnectionPool = {
      callActionForRoot: vi.fn(async () => ({
        domain: "ios_simulator",
        action: "getStatus",
        result: {
          platform: "darwin",
          supported: true,
        },
        statusHints: {},
      })),
    };
    registerIpc({
      getCtx: () => ({
        project: { rootPath: "/fallback" },
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }) as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo" } as any,
        binding: localBinding("/repo"),
      }),
      getProjectContext,
      localRuntimeConnectionPool: localRuntimeConnectionPool as any,
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.iosSimulatorListWindowSources)?.(
        eventForSender(),
        { projectRoot: "/repo" },
      ),
    ).rejects.toThrow("iOS Simulator service is not available for /repo.");
  });

  it("does not fall back to the active project for unbound iOS Simulator window-source requests", async () => {
    const getStatus = vi.fn(async () => ({
      platform: "darwin",
      supported: false,
      tools: [],
      activeDevice: null,
      activeSession: null,
    }));
    registerIpc({
      getCtx: () => ({
        project: { rootPath: "/fallback" },
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        iosSimulatorService: { getStatus },
      }) as any,
      getWindowSession: () => ({
        windowId: 7,
        project: null,
        binding: null,
      }),
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.iosSimulatorListWindowSources)?.(
        eventForSender(),
        {},
      ),
    ).rejects.toThrow("no local project is bound");

    expect(getStatus).not.toHaveBeenCalled();
  });

  it("rejects iOS Simulator window-source requests for an unbound project root", async () => {
    const getProjectContext = vi.fn(() => ({
      project: { rootPath: "/other" },
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      iosSimulatorService: { getStatus: vi.fn(async () => ({ supported: false })) },
    }) as any);
    registerIpc({
      getCtx: () => ({
        project: { rootPath: "/fallback" },
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      }) as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo" } as any,
        binding: localBinding("/repo"),
      }),
      getProjectContext,
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.iosSimulatorListWindowSources)?.(
        eventForSender(),
        { projectRoot: "/other" },
      ),
    ).rejects.toThrow("bound local project");

    expect(getProjectContext).not.toHaveBeenCalled();
  });

  it("falls back to the active context for matching iOS Simulator roots when no project context lookup is registered", async () => {
    const getStatus = vi.fn(async () => ({
      platform: "darwin",
      supported: false,
      tools: [],
      activeDevice: null,
      activeSession: null,
    }));
    registerIpc({
      getCtx: () => ({
        project: { rootPath: "/repo" },
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        iosSimulatorService: { getStatus },
      }) as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo" } as any,
        binding: localBinding("/repo"),
      }),
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.iosSimulatorListWindowSources)?.(
        eventForSender(),
        { projectRoot: "/repo" },
      ),
    ).resolves.toEqual([]);

    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it("surfaces missing sync service for active lane presence when no runtime pool is bound", async () => {
    const resolveSyncService = vi.fn(async () => null);
    registerIpc({
      getCtx: () => ({
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        syncService: null,
      }) as any,
      resolveSyncService,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo" } as any,
        binding: localBinding("/repo"),
      }),
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.syncSetActiveLanePresence)?.(
        eventForSender(),
        { laneIds: ["lane-1"] },
      ),
    ).rejects.toThrow("Sync service is not available.");

    expect(resolveSyncService).toHaveBeenCalledTimes(1);
  });

  it("uses the machine runtime sync bridge when no local project is bound", async () => {
    const status = { mode: "standalone", role: "brain" };
    const resolveSyncService = vi.fn(async () => null);
    const localRuntimeConnectionPool = {
      callSync: vi.fn(async () => status),
    };
    registerIpc({
      getCtx: () => ({
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        syncService: null,
      }) as any,
      resolveSyncService,
      getWindowSession: () => ({
        windowId: 7,
        project: null,
        binding: null,
      }),
      localRuntimeConnectionPool: localRuntimeConnectionPool as any,
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.syncGetStatus)?.(
        eventForSender(),
        { includeTransferReadiness: true },
      ),
    ).resolves.toBe(status);

    expect(localRuntimeConnectionPool.callSync).toHaveBeenCalledWith(
      "sync.getStatus",
      {
        includeTransferReadiness: true,
        forceTransferReadiness: false,
      },
    );
    expect(resolveSyncService).not.toHaveBeenCalled();
  });

  it("reads local sync status from the machine runtime when the window is remote-bound", async () => {
    const localStatus = { mode: "standalone", role: "brain", machine: "local" };
    const localRuntimeConnectionPool = {
      callSync: vi.fn(async () => localStatus),
      syncStatusForRoot: vi.fn(),
    };
    registerIpc({
      getCtx: () => ({
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        syncService: null,
      }) as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/remote/repo", displayName: "Remote Repo" } as any,
        binding: {
          kind: "remote",
          key: "remote:target-1:project-1",
          targetId: "target-1",
          runtimeName: "Remote",
          projectId: "project-1",
          rootPath: "/remote/repo",
          displayName: "Remote Repo",
        },
      }),
      localRuntimeConnectionPool: localRuntimeConnectionPool as any,
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.syncGetLocalStatus)?.(
        eventForSender(),
        { includeTransferReadiness: true },
      ),
    ).resolves.toBe(localStatus);

    expect(localRuntimeConnectionPool.callSync).toHaveBeenCalledWith(
      "sync.getStatus",
      {
        includeTransferReadiness: true,
        forceTransferReadiness: false,
      },
    );
    expect(localRuntimeConnectionPool.syncStatusForRoot).not.toHaveBeenCalled();
  });

  it("falls back to machine runtime sync when project sync is unavailable", async () => {
    const status = { mode: "standalone", role: "brain" };
    const localRuntimeConnectionPool = {
      syncStatusForRoot: vi.fn(async () => {
        throw new Error("Sync service is not available. Register a project first.");
      }),
      callSync: vi.fn(async () => status),
    };
    registerIpc({
      getCtx: () => ({
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        syncService: null,
      }) as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo" } as any,
        binding: localBinding("/repo"),
      }),
      localRuntimeConnectionPool: localRuntimeConnectionPool as any,
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.syncGetStatus)?.(
        eventForSender(),
        {},
      ),
    ).resolves.toBe(status);

    expect(localRuntimeConnectionPool.syncStatusForRoot).toHaveBeenCalledWith("/repo", {});
    expect(localRuntimeConnectionPool.callSync).toHaveBeenCalledWith(
      "sync.getStatus",
      {
        includeTransferReadiness: false,
        forceTransferReadiness: false,
      },
    );
  });

  it("treats null machine runtime sync responses as handled", async () => {
    const resolveSyncService = vi.fn(async () => null);
    const localRuntimeConnectionPool = {
      callSync: vi.fn(async () => null),
    };
    registerIpc({
      getCtx: () => ({
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        syncService: null,
      }) as any,
      resolveSyncService,
      getWindowSession: () => ({
        windowId: 7,
        project: null,
        binding: null,
      }),
      localRuntimeConnectionPool: localRuntimeConnectionPool as any,
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.syncSetActiveLanePresence)?.(
        eventForSender(),
        { laneIds: ["lane-1"] },
      ),
    ).resolves.toBeUndefined();

    expect(localRuntimeConnectionPool.callSync).toHaveBeenCalledWith(
      "sync.setActiveLanePresence",
      { laneIds: ["lane-1"] },
    );
    expect(resolveSyncService).not.toHaveBeenCalled();
  });

  it("returns a dev-tools snapshot instead of throwing when the service is unavailable", async () => {
    registerIpc({
      getCtx: () => ({
        devToolsService: null,
      }) as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo" } as any,
        binding: localBinding("/repo"),
      }),
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.devToolsDetect)?.(eventForSender(), { force: true }),
    ).resolves.toMatchObject({
      platform: process.platform,
      tools: [
        {
          id: "git",
          installed: false,
          required: true,
        },
      ],
    });
  });

  it("returns an empty agent chat list when the service is unavailable", async () => {
    registerIpc({
      getCtx: () => ({
        agentChatService: null,
      }) as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo" } as any,
        binding: localBinding("/repo"),
      }),
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.agentChatList)?.(
        eventForSender(),
        { laneId: " lane-1 ", includeAutomation: true },
      ),
    ).resolves.toEqual([]);
  });

  it("forwards agent chat list arguments when the service is available", async () => {
    const sessions = [{ sessionId: "chat-1" }];
    const listSessions = vi.fn(async () => sessions);
    registerIpc({
      getCtx: () => ({
        agentChatService: { listSessions },
      }) as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo" } as any,
        binding: localBinding("/repo"),
      }),
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.agentChatList)?.(
        eventForSender(),
        { laneId: " lane-1 ", includeAutomation: true },
      ),
    ).resolves.toBe(sessions);

    expect(listSessions).toHaveBeenCalledWith("lane-1", { includeAutomation: true });
  });

  it("returns an empty chat event history when the agent chat service is unavailable", async () => {
    registerIpc({
      getCtx: () => ({
        agentChatService: null,
      }) as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo" } as any,
        binding: localBinding("/repo"),
      }),
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.agentChatGetEventHistory)?.(
        eventForSender(),
        { sessionId: " chat-1 ", maxEvents: 10 },
      ),
    ).resolves.toEqual({
      sessionId: "chat-1",
      events: [],
      truncated: false,
      sessionFound: false,
    });
  });

  it("returns an empty chat event history when the agent chat service lacks event history support", async () => {
    registerIpc({
      getCtx: () => ({
        agentChatService: {},
      }) as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo" } as any,
        binding: localBinding("/repo"),
      }),
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.agentChatGetEventHistory)?.(
        eventForSender(),
        { sessionId: " chat-1 ", maxEvents: 10 },
      ),
    ).resolves.toEqual({
      sessionId: "chat-1",
      events: [],
      truncated: false,
      sessionFound: false,
    });
  });

  it("forwards chat event history requests when the agent chat service is available", async () => {
    const snapshot = {
      sessionId: "chat-1",
      events: [],
      truncated: false,
      sessionFound: true,
    };
    const getChatEventHistory = vi.fn(() => snapshot);
    registerIpc({
      getCtx: () => ({
        agentChatService: {
          getChatEventHistory,
        },
      }) as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo" } as any,
        binding: localBinding("/repo"),
      }),
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.agentChatGetEventHistory)?.(
        eventForSender(),
        { sessionId: " chat-1 ", maxEvents: 25, maxBytes: 256 * 1024 },
      ),
    ).resolves.toBe(snapshot);

    expect(getChatEventHistory).toHaveBeenCalledWith("chat-1", {
      maxEvents: 25,
      maxBytes: 256 * 1024,
    });
  });

  it("validates and forwards main transcript requests", async () => {
    const transcript = [{ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }];
    const getMainTranscript = vi.fn(async () => transcript);
    registerIpc({
      getCtx: () => ({
        logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
        agentChatService: { getMainTranscript },
      }) as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo" } as any,
        binding: localBinding("/repo"),
      }),
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.agentChatGetMainTranscript)?.(
        eventForSender(),
        { sessionId: "   " },
      ),
    ).rejects.toThrow("sessionId is required");
    expect(getMainTranscript).not.toHaveBeenCalled();

    const args = { sessionId: " chat-1 ", limit: 100, offset: 5 };
    await expect(
      ipcHandlers.get(IPC.agentChatGetMainTranscript)?.(eventForSender(), args),
    ).resolves.toBe(transcript);
    expect(getMainTranscript).toHaveBeenCalledWith(args);
  });

  it("disposes a live terminal runtime before deleting the session", async () => {
    const terminalSession = {
      id: "terminal-1",
      toolType: "shell",
      status: "running",
      ptyId: null,
    };
    const disposedSession = {
      ...terminalSession,
      status: "disposed",
      ptyId: null,
    };
    const dispose = vi.fn();
    const deleteSession = vi.fn();
    const enrichSessions = vi.fn((sessions: any[]) => {
      const session = sessions[0];
      if (session.status === "running") {
        return [{
          ...session,
          status: "running",
          ptyId: "pty-1",
        }];
      }
      return sessions;
    });
    const getSession = vi.fn()
      .mockReturnValueOnce(terminalSession)
      .mockReturnValueOnce(disposedSession);

    registerIpc({
      getCtx: () => ({
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        sessionService: {
          get: getSession,
          deleteSession,
        },
        ptyService: {
          enrichSessions,
          isSessionOwnedByLivePeerRuntime: vi.fn(() => false),
          dispose,
        },
      }) as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo" } as any,
        binding: localBinding("/repo"),
      }),
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.sessionsDelete)?.(
        eventForSender(),
        { sessionId: " terminal-1 " },
      ),
    ).resolves.toBeUndefined();

    expect(enrichSessions).toHaveBeenCalledWith([terminalSession]);
    expect(dispose).toHaveBeenCalledWith({ ptyId: "pty-1", sessionId: "terminal-1" });
    expect(deleteSession).toHaveBeenCalledWith("terminal-1");
  });

  it("degrades chat rows when list projection fails instead of leaking persisted running state", async () => {
    const chatSession = {
      id: "chat-1",
      laneId: "lane-1",
      toolType: "claude-chat",
      status: "running",
      runtimeState: "running",
      tracked: false,
    };
    const warn = vi.fn();

    registerIpc({
      getCtx: () => ({
        logger: { warn, info: vi.fn(), error: vi.fn() },
        sessionService: {
          list: vi.fn(() => [chatSession]),
        },
        ptyService: {
          enrichSessions: vi.fn((sessions: any[]) => sessions),
        },
        agentChatService: {
          listSessions: vi.fn(async () => {
            throw new Error("chat runtime unavailable");
          }),
        },
      }) as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo" } as any,
        binding: localBinding("/repo"),
      }),
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.sessionsList)?.(eventForSender(), {}),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "chat-1",
        runtimeState: "idle",
      }),
    ]);
    expect(warn).toHaveBeenCalledWith(
      "sessions.chat_projection_failed",
      expect.objectContaining({ error: "chat runtime unavailable" }),
    );
  });

  it("projects active automation chats without exposing projection filtering to the UI", async () => {
    const chatSession = {
      id: "automation-chat-1",
      laneId: "lane-1",
      toolType: "claude-chat",
      status: "running",
      runtimeState: "idle",
      tracked: false,
    };
    const listSessions = vi.fn(async () => [{
      sessionId: "automation-chat-1",
      laneId: "lane-1",
      surface: "automation",
      status: "active",
      awaitingInput: false,
    }]);

    registerIpc({
      getCtx: () => ({
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        sessionService: {
          list: vi.fn(() => [chatSession]),
        },
        ptyService: {
          enrichSessions: vi.fn((sessions: any[]) => sessions),
        },
        agentChatService: {
          listSessions,
        },
      }) as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo" } as any,
        binding: localBinding("/repo"),
      }),
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.sessionsList)?.(eventForSender(), {}),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "automation-chat-1",
        runtimeState: "running",
      }),
    ]);
    expect(listSessions).toHaveBeenCalledWith(undefined, {
      includeIdentity: true,
      includeAutomation: true,
    });
  });

  it("degrades a chat detail when its projection fails instead of leaking persisted running state", async () => {
    const chatSession = {
      id: "chat-1",
      laneId: "lane-1",
      toolType: "claude-chat",
      status: "running",
      runtimeState: "running",
      tracked: false,
    };
    const warn = vi.fn();

    registerIpc({
      getCtx: () => ({
        logger: { warn, info: vi.fn(), error: vi.fn() },
        sessionService: {
          get: vi.fn(() => chatSession),
        },
        ptyService: {
          enrichSessions: vi.fn((sessions: any[]) => sessions),
          getRuntimeState: vi.fn(() => "running"),
        },
        agentChatService: {
          getSessionSummary: vi.fn(async () => {
            throw new Error("chat runtime unavailable");
          }),
        },
      }) as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo" } as any,
        binding: localBinding("/repo"),
      }),
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.sessionsGet)?.(eventForSender(), { sessionId: "chat-1" }),
    ).resolves.toEqual(expect.objectContaining({
      id: "chat-1",
      runtimeState: "idle",
    }));
    expect(warn).toHaveBeenCalledWith(
      "sessions.chat_projection_failed",
      expect.objectContaining({
        sessionId: "chat-1",
        error: "chat runtime unavailable",
      }),
    );
  });

  it("refuses to delete a running terminal owned by another ADE runtime", async () => {
    const terminalSession = {
      id: "terminal-1",
      toolType: "shell",
      status: "running",
      ptyId: null,
      ownerPid: 12345,
    };
    const dispose = vi.fn();
    const deleteSession = vi.fn();

    registerIpc({
      getCtx: () => ({
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
        sessionService: {
          get: vi.fn(() => terminalSession),
          deleteSession,
        },
        ptyService: {
          enrichSessions: vi.fn((sessions: any[]) => [
            {
              ...sessions[0],
              status: "detached",
              ptyId: null,
            },
          ]),
          isSessionOwnedByLivePeerRuntime: vi.fn(() => true),
          dispose,
        },
      }) as any,
      getWindowSession: () => ({
        windowId: 7,
        project: { rootPath: "/repo", displayName: "Repo" } as any,
        binding: localBinding("/repo"),
      }),
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.sessionsDelete)?.(
        eventForSender(),
        { sessionId: "terminal-1" },
      ),
    ).rejects.toThrow("still owned by another ADE runtime");

    expect(dispose).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("routes running PR AI input through human steer semantics and keeps idle input on send", async () => {
    vi.useFakeTimers();
    let sessionStatus: "running" | "idle" = "running";
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const steer = vi.fn().mockResolvedValue(undefined);
    const steerUserMessage = vi.fn().mockResolvedValue({ steerId: "steer-1", queued: true });
    const interrupt = vi.fn().mockResolvedValue(undefined);
    const finalizeResolverSession = vi.fn().mockResolvedValue(undefined);
    const sessionId = "pr-ai-session-1";

    registerIpc({
      getCtx: () => ({
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
        project: { rootPath: process.cwd() },
        agentChatService: {
          createSession: vi.fn().mockResolvedValue({ id: sessionId }),
          sendMessage,
          steer,
          steerUserMessage,
          interrupt,
        },
        conflictService: {
          prepareResolverSession: vi.fn().mockResolvedValue({
            runId: "resolver-run-1",
            status: "ready",
            cwdLaneId: "lane-target",
            integrationLaneId: null,
            promptFilePath: path.resolve("package.json"),
            contextGaps: [],
          }),
          attachResolverSession: vi.fn().mockResolvedValue(undefined),
          finalizeResolverSession,
        },
        sessionService: {
          get: vi.fn(() => ({
            id: sessionId,
            status: sessionStatus,
            exitCode: null,
          })),
        },
      }) as any,
      switchProjectFromDialog: vi.fn(),
      closeCurrentProject: vi.fn(),
      closeProjectByPath: vi.fn(),
      globalStatePath: "/tmp/ade-state.json",
    });

    await expect(
      ipcHandlers.get(IPC.prsAiResolutionStart)?.(eventForSender(), {
        context: {
          sourceTab: "normal",
          sourceLaneId: "lane-source",
          targetLaneId: "lane-target",
        },
        model: "openai/gpt-5.4",
      }),
    ).resolves.toMatchObject({ sessionId, status: "started" });
    sendMessage.mockClear();

    await ipcHandlers.get(IPC.prsAiResolutionInput)?.(eventForSender(), {
      sessionId,
      text: "Keep the user's attention lifecycle.",
    });
    expect(steerUserMessage).toHaveBeenCalledWith({
      sessionId,
      text: "Keep the user's attention lifecycle.",
    });
    expect(steer).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    sessionStatus = "idle";
    await ipcHandlers.get(IPC.prsAiResolutionInput)?.(eventForSender(), {
      sessionId,
      text: "Start the next resolver turn.",
    });
    expect(sendMessage).toHaveBeenCalledWith({
      sessionId,
      text: "Start the next resolver turn.",
    });

    await ipcHandlers.get(IPC.prsAiResolutionStop)?.(eventForSender(), { sessionId });
    expect(interrupt).toHaveBeenCalledWith({ sessionId });
    expect(finalizeResolverSession).toHaveBeenCalled();
  });
});

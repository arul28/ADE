import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../../shared/ipc";
import type {
  OpenProjectBinding,
  RemoteRuntimeTarget,
} from "../../../shared/types";

const ipcHandlers = vi.hoisted(
  () => new Map<string, (...args: any[]) => unknown>(),
);
const browserWindowFromWebContents = vi.hoisted(() => vi.fn());
const browserWindowGetAllWindows = vi.hoisted(() => vi.fn(() => []));
const remoteRegistryGetMock = vi.hoisted(() => vi.fn());
const remoteRegistryListMock = vi.hoisted(() => vi.fn(() => []));
const remoteRegistrySaveMock = vi.hoisted(() => vi.fn());
const remoteRegistryRemoveMock = vi.hoisted(() => vi.fn());
const remoteConnectMock = vi.hoisted(() => vi.fn());
const remoteProjectsForTargetMock = vi.hoisted(() => vi.fn());
const remoteCallActionForTargetMock = vi.hoisted(() => vi.fn());
const remoteCallSyncForTargetMock = vi.hoisted(() => vi.fn());
const remoteCallMachineForTargetMock = vi.hoisted(() => vi.fn());
const remoteDisconnectMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp"),
    getVersion: vi.fn(() => "1.0.0"),
    isPackaged: false,
  },
  BrowserWindow: {
    fromWebContents: browserWindowFromWebContents,
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
    showOpenDialog: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
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
  })),
}));

vi.mock("../remoteRuntime/remoteConnectionPool", () => ({
  RemoteConnectionPool: vi.fn().mockImplementation(() => ({
    connect: remoteConnectMock,
    projectsForTarget: remoteProjectsForTargetMock,
    callActionForTarget: remoteCallActionForTargetMock,
    callSyncForTarget: remoteCallSyncForTargetMock,
    callMachineForTarget: remoteCallMachineForTargetMock,
    disconnect: remoteDisconnectMock,
  })),
}));

vi.mock("../remoteRuntime/runtimeDiscovery", () => ({
  discoverLanRuntimes: vi.fn(() => []),
}));

vi.mock("../git/git", () => ({
  runGit: vi.fn(),
}));

import { registerRuntimeBridge } from "./runtimeBridge";
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
    delete process.env.ADE_DISABLE_LOCAL_RUNTIME_DAEMON;
    ipcHandlers.clear();
    browserWindowFromWebContents.mockReset();
    browserWindowGetAllWindows.mockReset().mockReturnValue([]);
    remoteRegistryGetMock.mockReset();
    remoteRegistryListMock.mockReset().mockReturnValue([]);
    remoteRegistrySaveMock.mockReset();
    remoteRegistryRemoveMock.mockReset();
    remoteConnectMock.mockReset().mockResolvedValue({
      target,
      arch: "darwin-arm64",
      version: null,
      projects: [],
    });
    remoteProjectsForTargetMock.mockReset();
    remoteCallActionForTargetMock.mockReset();
    remoteCallSyncForTargetMock.mockReset();
    remoteCallMachineForTargetMock.mockReset();
    remoteDisconnectMock.mockReset();
    browserWindowFromWebContents.mockReturnValue({ id: 7 });
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

  it("uses an explicit local runtime root over the window session binding during project switches", async () => {
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
        project: null,
        binding: localBinding("/old-repo"),
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

    expect(remoteConnectMock).toHaveBeenCalledWith(target);
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
      projectId: "project-1",
      rootPath: "/srv/ade",
      displayName: "ADE",
    });

    expect(remoteConnectMock).toHaveBeenCalledWith(target);
    expect(remoteProjectsForTargetMock).toHaveBeenCalledWith(target);
    expect(bindRemoteProject).toHaveBeenCalledWith(7, {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/srv/ade",
      displayName: "ADE",
    });
  });

  it("forwards a one-shot local GitHub auth header for remote clones", async () => {
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
      },
      { retryOnConnectionError: false },
    );
  });
});

describe("registerIpc sync bridge", () => {
  beforeEach(() => {
    delete process.env.ADE_DISABLE_LOCAL_RUNTIME_DAEMON;
    ipcHandlers.clear();
    browserWindowFromWebContents.mockReset().mockReturnValue({ id: 7 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns an unavailable sync snapshot without probing local runtime when the daemon is disabled", async () => {
    process.env.ADE_DISABLE_LOCAL_RUNTIME_DAEMON = "1";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T12:00:00.000Z"));
    const localRuntimeConnectionPool = {
      syncStatusForRoot: vi.fn(),
      callSyncForRoot: vi.fn(),
    };
    registerIpc({
      getCtx: () => ({
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

    const snapshot = await ipcHandlers.get(IPC.syncGetStatus)?.(
      eventForSender(),
      { includeTransferReadiness: true },
    ) as any;
    vi.setSystemTime(new Date("2026-05-11T12:00:05.000Z"));
    const secondSnapshot = await ipcHandlers.get(IPC.syncGetStatus)?.(
      eventForSender(),
      { includeTransferReadiness: true },
    ) as any;
    const devices = await ipcHandlers.get(IPC.syncListDevices)?.(
      eventForSender(),
    ) as any[];
    const readiness = await ipcHandlers.get(IPC.syncGetTransferReadiness)?.(
      eventForSender(),
    ) as any;
    const pin = await ipcHandlers.get(IPC.syncGetPin)?.(eventForSender()) as any;

    expect(localRuntimeConnectionPool.syncStatusForRoot).not.toHaveBeenCalled();
    expect(secondSnapshot).not.toBe(snapshot);
    expect(snapshot.mode).toBe("standalone");
    expect(snapshot.localDevice.createdAt).toBe("2026-05-11T12:00:00.000Z");
    expect(secondSnapshot.localDevice.updatedAt).toBe("2026-05-11T12:00:05.000Z");
    expect(secondSnapshot.localDevice.lastSeenAt).toBe("2026-05-11T12:00:05.000Z");
    expect(snapshot.localDevice.metadata).toEqual({
      unavailableReason: "local_runtime_daemon_disabled",
    });
    expect(snapshot.transferReadiness.ready).toBe(false);
    expect(snapshot.transferReadiness.blockers[0]).toEqual({
      kind: "managed_process",
      id: "local-runtime-disabled",
      label: "Sync unavailable",
      detail: "Sync service unavailable in local runtime disabled mode.",
    });
    expect(snapshot.client.message).toBe("Sync service unavailable in local runtime disabled mode.");
    expect(devices[0]).toMatchObject({
      deviceId: "local-runtime-disabled",
      isLocal: true,
      isBrain: false,
      connectionState: "disconnected",
    });
    expect(readiness).toEqual(snapshot.transferReadiness);
    expect(pin).toEqual({ pin: null });
  });

  it("drops active lane presence updates instead of probing unavailable sync services when the daemon is disabled", async () => {
    process.env.ADE_DISABLE_LOCAL_RUNTIME_DAEMON = "1";
    const localRuntimeConnectionPool = {
      callSyncForRoot: vi.fn(),
    };
    const resolveSyncService = vi.fn(async () => null);
    registerIpc({
      getCtx: () => ({
        syncService: null,
      }) as any,
      resolveSyncService,
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
      ipcHandlers.get(IPC.syncSetActiveLanePresence)?.(
        eventForSender(),
        { laneIds: ["lane-1"] },
      ),
    ).resolves.toBeUndefined();

    expect(localRuntimeConnectionPool.callSyncForRoot).not.toHaveBeenCalled();
    expect(resolveSyncService).toHaveBeenCalledTimes(1);
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
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../../shared/ipc";
import type { OpenProjectBinding, RemoteRuntimeTarget } from "../../../shared/types";

const ipcHandlers = vi.hoisted(() => new Map<string, (...args: any[]) => unknown>());
const browserWindowFromWebContents = vi.hoisted(() => vi.fn());
const remoteRegistryGetMock = vi.hoisted(() => vi.fn());
const remoteRegistryListMock = vi.hoisted(() => vi.fn(() => []));
const remoteRegistrySaveMock = vi.hoisted(() => vi.fn());
const remoteRegistryRemoveMock = vi.hoisted(() => vi.fn());
const remoteConnectMock = vi.hoisted(() => vi.fn());
const remoteProjectsForTargetMock = vi.hoisted(() => vi.fn());
const remoteCallActionForTargetMock = vi.hoisted(() => vi.fn());
const remoteCallSyncForTargetMock = vi.hoisted(() => vi.fn());
const remoteDisconnectMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: browserWindowFromWebContents,
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
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
    remoteRegistryGetMock.mockReset();
    remoteRegistryListMock.mockReset().mockReturnValue([]);
    remoteRegistrySaveMock.mockReset();
    remoteRegistryRemoveMock.mockReset();
    remoteConnectMock.mockReset();
    remoteProjectsForTargetMock.mockReset();
    remoteCallActionForTargetMock.mockReset();
    remoteCallSyncForTargetMock.mockReset();
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

    await expect(ipcHandlers.get(IPC.localRuntimeCallAction)?.(eventForSender(sender(101)), {
      request: {
        domain: "file",
        action: "watchWorkspace",
        args: { workspaceId: "main" },
      },
    })).resolves.toMatchObject({ result: { ok: true } });

    expect(localRuntimeConnectionPool.callActionForRoot).toHaveBeenCalledWith("/repo", {
      domain: "file",
      action: "watchWorkspace",
      args: {
        workspaceId: "main",
        __adeRuntimeClientId: 101,
      },
    });
  });

  it("forwards remote project runtime actions through the selected target and project", async () => {
    remoteRegistryGetMock.mockReturnValue(target);
    remoteConnectMock.mockResolvedValue({ target, arch: "linux-x64", version: "1.0.0", projects: [] });
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

    await expect(ipcHandlers.get(IPC.remoteRuntimeCallAction)?.(eventForSender(sender(202)), {
      id: "target-1",
      projectId: "project-1",
      request: {
        domain: "pty",
        action: "create",
        args: { startupCommand: "codex login" },
      },
    })).resolves.toMatchObject({ result: { ptyId: "pty-1" } });

    expect(remoteConnectMock).toHaveBeenCalledWith(target);
    expect(remoteCallActionForTargetMock).toHaveBeenCalledWith(target, "project-1", {
      domain: "pty",
      action: "create",
      args: { startupCommand: "codex login" },
    });
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

    await expect(ipcHandlers.get(IPC.localRuntimeCallSync)?.(eventForSender(), {
      method: "git.status",
      params: {},
    })).rejects.toThrow(/not exposed/i);
    await expect(ipcHandlers.get(IPC.remoteRuntimeCallSync)?.(eventForSender(), {
      id: "target-1",
      projectId: "project-1",
      method: "git.status",
      params: {},
    })).rejects.toThrow(/not exposed/i);

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

    await expect(ipcHandlers.get(IPC.remoteRuntimeCallSync)?.(eventForSender(), {
      id: "target-1",
      projectId: "project-1",
      method: "sync.getStatus",
      params: { includeTransferReadiness: true },
    })).resolves.toEqual({ connectedPeers: [] });

    expect(remoteCallSyncForTargetMock).toHaveBeenCalledWith(target, "project-1", "sync.getStatus", {
      includeTransferReadiness: true,
    });
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
    remoteConnectMock.mockResolvedValue({ target, arch: "linux-x64", version: "1.0.0", projects: [] });
    remoteProjectsForTargetMock.mockResolvedValue([project]);
    registerRuntimeBridge({
      appVersion: "1.0.0",
      globalStatePath: "/tmp/ade-state.json",
      bindRemoteProject,
    });

    await expect(ipcHandlers.get(IPC.remoteRuntimeOpenProject)?.(eventForSender(sender(303)), {
      id: " target-1 ",
      projectId: " project-1 ",
    })).resolves.toEqual({
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
});

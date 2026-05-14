import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../shared/ipc";

describe("preload OAuth bridge", () => {
  beforeEach(() => {
    vi.resetModules();
    delete (globalThis as any).__adeBridge;
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("electron");
    delete process.env.ADE_DISABLE_LOCAL_RUNTIME_DAEMON;
    delete process.env.ADE_LOCAL_RUNTIME_FALLBACK;
    delete (globalThis as any).__adeBridge;
  });

  it("exposes OAuth IPC methods and cleans up listeners", async () => {
    const invoke = vi.fn(async () => undefined);
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    expect((globalThis as any).__bridgeName).toBe("ade");
    expect(bridge.lanes).toBeTruthy();

    await bridge.lanes.oauthGetStatus();
    await bridge.lanes.oauthUpdateConfig({ enabled: true });
    await bridge.lanes.oauthGenerateRedirectUris({ provider: "google" });
    await bridge.lanes.oauthEncodeState({
      laneId: "lane-1",
      originalState: "state-1",
    });
    await bridge.lanes.oauthDecodeState({ encodedState: "ade:encoded" });
    await bridge.lanes.oauthListSessions();

    expect(invoke).toHaveBeenCalledWith(IPC.lanesOAuthGetStatus);
    expect(invoke).toHaveBeenCalledWith(IPC.lanesOAuthUpdateConfig, {
      enabled: true,
    });
    expect(invoke).toHaveBeenCalledWith(IPC.lanesOAuthGenerateRedirectUris, {
      provider: "google",
    });
    expect(invoke).toHaveBeenCalledWith(IPC.lanesOAuthEncodeState, {
      laneId: "lane-1",
      originalState: "state-1",
    });
    expect(invoke).toHaveBeenCalledWith(IPC.lanesOAuthDecodeState, {
      encodedState: "ade:encoded",
    });
    expect(invoke).toHaveBeenCalledWith(IPC.lanesOAuthListSessions);

    const callback = vi.fn();
    const unsubscribe = bridge.lanes.onOAuthEvent(callback);
    expect(on).toHaveBeenCalledWith(IPC.lanesOAuthEvent, expect.any(Function));

    const listener = on.mock.calls.at(-1)?.[1];
    expect(typeof listener).toBe("function");
    listener({}, { type: "oauth-config-changed" });
    expect(callback).toHaveBeenCalledWith({ type: "oauth-config-changed" });

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(IPC.lanesOAuthEvent, listener);
  });

  it("exposes review IPC methods and cleans up listeners", async () => {
    const invoke = vi.fn(async () => undefined);
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    expect(bridge.review).toBeTruthy();
    await bridge.review.listLaunchContext();
    await bridge.review.listRuns({ laneId: "lane-1", limit: 5 });
    await bridge.review.getRunDetail("run-1");
    await bridge.review.startRun({ target: { mode: "lane_diff", laneId: "lane-1" } });
    await bridge.review.rerun("run-1");

    expect(invoke).toHaveBeenCalledWith(IPC.reviewListLaunchContext);
    expect(invoke).toHaveBeenCalledWith(IPC.reviewListRuns, { laneId: "lane-1", limit: 5 });
    expect(invoke).toHaveBeenCalledWith(IPC.reviewGetRunDetail, { runId: "run-1" });
    expect(invoke).toHaveBeenCalledWith(IPC.reviewStartRun, { target: { mode: "lane_diff", laneId: "lane-1" } });
    expect(invoke).toHaveBeenCalledWith(IPC.reviewRerun, { runId: "run-1" });

    const callback = vi.fn();
    const unsubscribe = bridge.review.onEvent(callback);
    expect(on).toHaveBeenCalledWith(IPC.reviewEvent, expect.any(Function));

    const listener = on.mock.calls.at(-1)?.[1];
    expect(typeof listener).toBe("function");
    listener({}, { type: "runs-updated", runId: "run-1", status: "completed" });
    expect(callback).toHaveBeenCalledWith({ type: "runs-updated", runId: "run-1", status: "completed" });

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(IPC.reviewEvent, listener);
  });

  it("exposes macOS VM IPC methods and cleans up listeners", async () => {
    const invoke = vi.fn(async () => undefined);
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    expect(bridge.macosVm).toBeTruthy();

    await bridge.macosVm.getStatus({ laneId: "lane-1" });
    await bridge.macosVm.provision({ laneId: "lane-1", mode: "pull-image" });
    await bridge.macosVm.start({ laneId: "lane-1", openDisplay: true });
    await bridge.macosVm.stop({ laneId: "lane-1" });
    await bridge.macosVm.delete({ laneId: "lane-1", force: true });
    await bridge.macosVm.getAgentGuide({ laneId: "lane-1" });
    await bridge.macosVm.focusWindow({ laneId: "lane-1" });
    await bridge.macosVm.captureScreenshot({ laneId: "lane-1" });
    await bridge.macosVm.selectPoint({ laneId: "lane-1", x: 40, y: 60, includeScreenshot: true });
    await bridge.macosVm.click({ laneId: "lane-1", x: 40, y: 60 });
    await bridge.macosVm.typeText({ laneId: "lane-1", text: "hello" });

    expect(invoke).toHaveBeenCalledWith(IPC.macosVmGetStatus, { laneId: "lane-1" });
    expect(invoke).toHaveBeenCalledWith(IPC.macosVmProvision, { laneId: "lane-1", mode: "pull-image" });
    expect(invoke).toHaveBeenCalledWith(IPC.macosVmStart, { laneId: "lane-1", openDisplay: true });
    expect(invoke).toHaveBeenCalledWith(IPC.macosVmStop, { laneId: "lane-1" });
    expect(invoke).toHaveBeenCalledWith(IPC.macosVmDelete, { laneId: "lane-1", force: true });
    expect(invoke).toHaveBeenCalledWith(IPC.macosVmGetAgentGuide, { laneId: "lane-1" });
    expect(invoke).toHaveBeenCalledWith(IPC.macosVmFocusWindow, { laneId: "lane-1" });
    expect(invoke).toHaveBeenCalledWith(IPC.macosVmCaptureScreenshot, { laneId: "lane-1" });
    expect(invoke).toHaveBeenCalledWith(IPC.macosVmSelectPoint, { laneId: "lane-1", x: 40, y: 60, includeScreenshot: true });
    expect(invoke).toHaveBeenCalledWith(IPC.macosVmClick, { laneId: "lane-1", x: 40, y: 60 });
    expect(invoke).toHaveBeenCalledWith(IPC.macosVmTypeText, { laneId: "lane-1", text: "hello" });

    const callback = vi.fn();
    const unsubscribe = bridge.macosVm.onEvent(callback);
    expect(on).toHaveBeenCalledWith(IPC.macosVmEvent, expect.any(Function));

    const listener = on.mock.calls.at(-1)?.[1];
    expect(typeof listener).toBe("function");
    listener({}, { type: "operation", operation: "start", state: "completed" });
    expect(callback).toHaveBeenCalledWith({ type: "operation", operation: "start", state: "completed" });

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(IPC.macosVmEvent, listener);
  });

  it("clears the AI status bridge cache after API key verification", async () => {
    const status = {
      mode: "guest",
      availableProviders: {
        claude: {
          binary: { present: false, source: "missing", path: null },
          auth: { ready: false, mode: "none", detail: null },
        },
        codex: false,
        cursor: false,
        droid: false,
      },
      models: { claude: [], codex: [], cursor: [], droid: [] },
      features: [],
    };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.aiGetStatus) return status;
      if (channel === IPC.aiVerifyApiKey) {
        return {
          provider: "cursor",
          ok: true,
          message: "Verified",
          verifiedAt: "2026-03-17T19:00:00.000Z",
        };
      }
      return undefined;
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await bridge.ai.getStatus();
    await bridge.ai.getStatus();
    expect(invoke.mock.calls.filter(([channel]) => channel === IPC.aiGetStatus)).toHaveLength(1);

    await bridge.ai.verifyApiKey("cursor");
    await bridge.ai.getStatus();

    expect(invoke).toHaveBeenCalledWith(IPC.aiVerifyApiKey, { provider: "cursor" });
    expect(invoke.mock.calls.filter(([channel]) => channel === IPC.aiGetStatus)).toHaveLength(2);
  });

  it("rejects lane folder opens for remote project bindings before local lane IPC", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Project",
    };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      return undefined;
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await expect(bridge.lanes.openFolder({ laneId: "lane-1" })).rejects.toThrow(/remote lane folders/i);

    expect(invoke).toHaveBeenCalledWith(IPC.appGetWindowSession);
    expect(invoke).not.toHaveBeenCalledWith(IPC.lanesOpenFolder, { laneId: "lane-1" });
  });

  it("keeps lane folder opens on local project bindings routed to local lane IPC", async () => {
    const binding = {
      kind: "local",
      key: "local:/repo",
      rootPath: "/repo",
      displayName: "Project",
    };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: { rootPath: "/repo", displayName: "Project" }, binding };
      }
      return undefined;
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await bridge.lanes.openFolder({ laneId: "lane-1" });

    expect(invoke).toHaveBeenCalledWith(IPC.appGetWindowSession);
    expect(invoke).toHaveBeenCalledWith(IPC.lanesOpenFolder, { laneId: "lane-1" });
  });

  it("skips local runtime IPC when the local runtime daemon is disabled", async () => {
    process.env.ADE_DISABLE_LOCAL_RUNTIME_DAEMON = "1";
    const binding = {
      kind: "local",
      key: "local:/repo",
      rootPath: "/repo",
      displayName: "Project",
    };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: { rootPath: "/repo", displayName: "Project" }, binding };
      }
      if (channel === IPC.lanesList) return [];
      throw new Error(`unexpected IPC: ${channel}`);
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await expect(bridge.lanes.list()).resolves.toEqual([]);

    expect(invoke).toHaveBeenCalledWith(IPC.appGetWindowSession);
    expect(invoke).toHaveBeenCalledWith(IPC.lanesList, {});
    expect(invoke).not.toHaveBeenCalledWith(
      IPC.localRuntimeCallAction,
      expect.anything(),
    );
  });

  it("falls back to in-process IPC when a local runtime action times out", async () => {
    process.env.ADE_LOCAL_RUNTIME_FALLBACK = "1";
    const binding = {
      kind: "local",
      key: "local:/repo",
      rootPath: "/repo",
      displayName: "Project",
    };
    const lanes = [{ id: "lane-1", name: "Main" }];
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: { rootPath: "/repo", displayName: "Project" }, binding };
      }
      if (channel === IPC.localRuntimeCallAction) {
        throw new Error(
          "Error invoking remote method 'ade.localRuntime.callAction': Error: IPC handler for 'ade.localRuntime.callAction' timed out after 30000ms (callId=286)",
        );
      }
      if (channel === IPC.lanesList) return lanes;
      throw new Error(`unexpected IPC: ${channel}`);
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await expect(bridge.lanes.list()).resolves.toEqual(lanes);

    expect(invoke).toHaveBeenCalledWith(IPC.localRuntimeCallAction, {
      request: { domain: "lane", action: "list", args: {} },
    });
    expect(invoke).toHaveBeenCalledWith(IPC.lanesList, {});
  });

  it("uses in-process IPC for local PR tab reads instead of waiting on the runtime daemon", async () => {
    const binding = {
      kind: "local",
      key: "local:/repo",
      rootPath: "/repo",
      displayName: "Project",
    };
    const detail = {
      prId: "pr-1",
      body: "Ready to merge",
      labels: [],
      assignees: [],
      requestedReviewers: [],
      author: null,
      isDraft: false,
      milestone: null,
      linkedIssues: [],
    };
    const prs = [
      {
        id: "pr-1",
        laneId: "lane-1",
        projectId: "project-1",
        repoOwner: "owner",
        repoName: "repo",
        githubPrNumber: 12,
        githubUrl: "https://github.com/owner/repo/pull/12",
        githubNodeId: null,
        title: "Fix detail load",
        state: "open",
        baseBranch: "main",
        headBranch: "lane/fix-detail-load",
        checksStatus: "none",
        reviewStatus: "none",
        additions: 0,
        deletions: 0,
        lastSyncedAt: null,
        createdAt: "2026-05-14T12:00:00.000Z",
        updatedAt: "2026-05-14T12:00:00.000Z",
        conflictAnalysis: null,
      },
    ];
    const snapshot = {
      repo: { owner: "owner", name: "repo" },
      viewerLogin: "arul",
      repoPullRequests: [],
      externalPullRequests: [],
      syncedAt: "2026-05-14T12:00:00.000Z",
    };
    const invoke = vi.fn(async (channel: string, arg?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: { rootPath: "/repo", displayName: "Project" }, binding };
      }
      if (channel === IPC.localRuntimeCallAction) {
        throw new Error("PR tab reads should not call the local runtime daemon");
      }
      if (channel === IPC.prsGetDetail) return detail;
      if (channel === IPC.prsListWithConflicts) return prs;
      if (channel === IPC.prsGetGitHubSnapshot) return snapshot;
      throw new Error(`unexpected IPC: ${channel} ${JSON.stringify(arg)}`);
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await expect(bridge.prs.getDetail("pr-1")).resolves.toEqual(detail);
    await expect(bridge.prs.listWithConflicts()).resolves.toEqual(prs);
    await expect(bridge.prs.getGitHubSnapshot()).resolves.toEqual(snapshot);

    expect(invoke).toHaveBeenCalledWith(IPC.prsGetDetail, { prId: "pr-1" });
    expect(invoke).toHaveBeenCalledWith(IPC.prsListWithConflicts, {});
    expect(invoke).toHaveBeenCalledWith(IPC.prsGetGitHubSnapshot, {});
    expect(invoke).not.toHaveBeenCalledWith(
      IPC.localRuntimeCallAction,
      expect.anything(),
    );
  });

  it("keeps remote runtime routing for PR tab reads when the project is remote", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Project",
    };
    const detail = {
      prId: "pr-1",
      body: "Loaded remotely",
      labels: [],
      assignees: [],
      requestedReviewers: [],
      author: null,
      isDraft: false,
      milestone: null,
      linkedIssues: [],
    };
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeCallAction) {
        const request = (payload as { request?: { domain?: string; action?: string } } | undefined)?.request;
        return { ok: true, domain: request?.domain, action: request?.action, result: detail, statusHints: {} };
      }
      if (channel === IPC.prsGetDetail) {
        throw new Error("remote PR reads should not call desktop PR IPC");
      }
      return undefined;
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await expect(bridge.prs.getDetail("pr-1")).resolves.toEqual(detail);

    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: { domain: "pr", action: "getDetail", arg: "pr-1" },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.prsGetDetail, expect.anything());
  });

  it("uses in-process file IPC when no local runtime binding exists", async () => {
    const workspaces = [{ id: "primary", label: "Primary", rootPath: "/repo" }];
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: { rootPath: "/repo", displayName: "Project" }, binding: null };
      }
      if (channel === IPC.filesListWorkspaces) return workspaces;
      if (channel === IPC.filesWatchChanges) return undefined;
      if (channel === IPC.localRuntimeCallAction) {
        throw new Error("files should not call the local runtime daemon");
      }
      throw new Error(`unexpected IPC: ${channel}`);
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await expect(bridge.files.listWorkspaces()).resolves.toEqual(workspaces);
    await expect(bridge.files.watchChanges({ workspaceId: "primary" })).resolves.toBeUndefined();

    expect(invoke).toHaveBeenCalledWith(IPC.filesListWorkspaces, {});
    expect(invoke).toHaveBeenCalledWith(IPC.filesWatchChanges, { workspaceId: "primary" });
    expect(invoke).not.toHaveBeenCalledWith(
      IPC.localRuntimeCallAction,
      expect.anything(),
    );
  });

  it("routes local project file operations through the local runtime when bound", async () => {
    const binding = {
      kind: "local",
      key: "local:/repo",
      rootPath: "/repo",
      displayName: "Project",
    };
    const workspaces = [{ id: "primary", label: "Primary", rootPath: "/repo" }];
    const invoke = vi.fn(async (channel: string, arg?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: { rootPath: "/repo", displayName: "Project" }, binding };
      }
      if (channel === IPC.localRuntimeCallAction) {
        return {
          domain: "file",
          action: "listWorkspaces",
          result: workspaces,
          statusHints: {},
        };
      }
      if (channel === IPC.filesListWorkspaces) {
        throw new Error("runtime-bound files should not use in-process IPC");
      }
      throw new Error(`unexpected IPC: ${channel} ${JSON.stringify(arg)}`);
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await expect(bridge.files.listWorkspaces()).resolves.toEqual(workspaces);

    expect(invoke).toHaveBeenCalledWith(IPC.localRuntimeCallAction, {
      request: { domain: "file", action: "listWorkspaces", args: {} },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.filesListWorkspaces, expect.anything());
  });

  it("does not fall through to in-process file IPC when a bound local runtime file call fails", async () => {
    const binding = {
      kind: "local",
      key: "local:/repo",
      rootPath: "/repo",
      displayName: "Project",
    };
    const runtimeError = new Error(
      "Error invoking remote method 'ade.localRuntime.callAction': Error: IPC handler for 'ade.localRuntime.callAction' timed out after 30000ms",
    );
    const invoke = vi.fn(async (channel: string, arg?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: { rootPath: "/repo", displayName: "Project" }, binding };
      }
      if (channel === IPC.localRuntimeCallAction) {
        throw runtimeError;
      }
      if (channel === IPC.filesListWorkspaces) {
        throw new Error("runtime-bound files should not fall through to missing in-process IPC");
      }
      throw new Error(`unexpected IPC: ${channel} ${JSON.stringify(arg)}`);
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await expect(bridge.files.listWorkspaces()).rejects.toThrow("ade.localRuntime.callAction");

    expect(invoke).toHaveBeenCalledWith(IPC.localRuntimeCallAction, {
      request: { domain: "file", action: "listWorkspaces", args: {} },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.filesListWorkspaces, expect.anything());
  });

  it("keeps remote runtime routing for remote project file operations", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/repo",
      displayName: "Project",
    };
    const workspaces = [{ id: "primary", label: "Primary", rootPath: "/remote/repo" }];
    const invoke = vi.fn(async (channel: string, arg?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeCallAction) {
        return {
          domain: "file",
          action: "listWorkspaces",
          result: workspaces,
          statusHints: {},
        };
      }
      if (channel === IPC.filesListWorkspaces) {
        throw new Error("remote files should not use in-process IPC");
      }
      throw new Error(`unexpected IPC: ${channel} ${JSON.stringify(arg)}`);
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await expect(bridge.files.listWorkspaces()).resolves.toEqual(workspaces);

    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: { domain: "file", action: "listWorkspaces", args: {} },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.filesListWorkspaces, expect.anything());
  });

  it("backs off local runtime event polling after a safe local stream timeout", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const binding = {
        kind: "local",
        key: "local:/repo",
        rootPath: "/repo",
        displayName: "Project",
      };
      const invoke = vi.fn(async (channel: string) => {
        if (channel === IPC.appGetWindowSession) {
          return { windowId: 1, project: { rootPath: "/repo", displayName: "Project" }, binding };
        }
        if (channel === IPC.localRuntimeStreamEvents) {
          throw new Error("Timed out waiting for remote ADE service method ade/actions/call.");
        }
        throw new Error(`unexpected IPC: ${channel}`);
      });
      const on = vi.fn();
      const removeListener = vi.fn();
      const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
        (globalThis as any).__bridgeName = name;
        (globalThis as any).__adeBridge = value;
      });

      vi.doMock("electron", () => ({
        contextBridge: { exposeInMainWorld },
        ipcRenderer: { invoke, on, removeListener },
        webFrame: {
          getZoomLevel: vi.fn(() => 0),
          setZoomLevel: vi.fn(),
          getZoomFactor: vi.fn(() => 1),
        },
      }));

      await import("./preload");

      const bridge = (globalThis as any).__adeBridge;
      const unsubscribe = bridge.project.onStateEvent(vi.fn());
      await vi.advanceTimersByTimeAsync(0);

      const streamCallCount = () =>
        invoke.mock.calls.filter(([channel]) => channel === IPC.localRuntimeStreamEvents).length;
      expect(streamCallCount()).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        "Local ADE service event polling failed; backing off while the local service recovers.",
        expect.any(Error),
      );

      await vi.advanceTimersByTimeAsync(2_000);
      expect(streamCallCount()).toBe(1);

      unsubscribe();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("clears local runtime event polling backoff when the project binding changes", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const localBinding = {
        kind: "local",
        key: "local:/repo",
        rootPath: "/repo",
        displayName: "Project",
      };
      const remoteBinding = {
        kind: "remote",
        key: "remote:target-1:project-1",
        targetId: "target-1",
        runtimeName: "Remote",
        projectId: "project-1",
        rootPath: "/remote/repo",
        displayName: "Project",
      };
      let binding: typeof localBinding | typeof remoteBinding = localBinding;
      const invoke = vi.fn(async (channel: string) => {
        if (channel === IPC.appGetWindowSession) {
          return { windowId: 1, project: { rootPath: "/repo", displayName: "Project" }, binding };
        }
        if (channel === IPC.localRuntimeStreamEvents) {
          throw new Error("Timed out waiting for remote ADE service method ade/actions/call.");
        }
        if (channel === IPC.remoteRuntimeStreamEvents) {
          return { events: [], nextCursor: 0, hasMore: false };
        }
        throw new Error(`unexpected IPC: ${channel}`);
      });
      const on = vi.fn();
      const removeListener = vi.fn();
      const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
        (globalThis as any).__bridgeName = name;
        (globalThis as any).__adeBridge = value;
      });

      vi.doMock("electron", () => ({
        contextBridge: { exposeInMainWorld },
        ipcRenderer: { invoke, on, removeListener },
        webFrame: {
          getZoomLevel: vi.fn(() => 0),
          setZoomLevel: vi.fn(),
          getZoomFactor: vi.fn(() => 1),
        },
      }));

      await import("./preload");

      const bridge = (globalThis as any).__adeBridge;
      const unsubscribeState = bridge.project.onStateEvent(vi.fn());
      const unsubscribeBinding = bridge.app.onProjectBindingChanged(vi.fn());
      await vi.advanceTimersByTimeAsync(0);

      const localStreamCallCount = () =>
        invoke.mock.calls.filter(([channel]) => channel === IPC.localRuntimeStreamEvents).length;
      const remoteStreamCallCount = () =>
        invoke.mock.calls.filter(([channel]) => channel === IPC.remoteRuntimeStreamEvents).length;
      expect(localStreamCallCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(localStreamCallCount()).toBe(1);
      expect(remoteStreamCallCount()).toBe(0);

      const bindingListener = on.mock.calls.find(([channel]) => channel === IPC.appProjectBindingChanged)?.[1];
      expect(typeof bindingListener).toBe("function");
      binding = remoteBinding;
      bindingListener({}, remoteBinding);
      await vi.advanceTimersByTimeAsync(0);

      expect(remoteStreamCallCount()).toBe(1);

      unsubscribeBinding();
      unsubscribeState();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("uses desktop usage IPC directly for local project usage reads", async () => {
    const binding = {
      kind: "local",
      key: "local:/repo",
      rootPath: "/repo",
      displayName: "Project",
    };
    const snapshot = {
      windows: [],
      pacing: {
        status: "on-track",
        projectedWeeklyPercent: 0,
        weekElapsedPercent: 0,
        expectedPercent: 0,
        deltaPercent: 0,
        etaHours: null,
        willLastToReset: true,
        resetsInHours: 0,
      },
      pacingByProvider: {},
      costs: [],
      extraUsage: [],
      dailyUsage7d: {},
      lastPolledAt: "2026-05-14T14:00:00.000Z",
      errors: [],
    };
    const refreshed = { ...snapshot, lastPolledAt: "2026-05-14T14:01:00.000Z" };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: { rootPath: "/repo", displayName: "Project" }, binding };
      }
      if (channel === IPC.usageGetSnapshot) return snapshot;
      if (channel === IPC.usageRefresh) return refreshed;
      if (channel === IPC.localRuntimeCallAction) {
        throw new Error("usage should not call the local runtime daemon");
      }
      return undefined;
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await expect(bridge.usage.getSnapshot()).resolves.toEqual(snapshot);
    await expect(bridge.usage.refresh()).resolves.toEqual(refreshed);

    expect(invoke).toHaveBeenCalledWith(IPC.usageGetSnapshot);
    expect(invoke).toHaveBeenCalledWith(IPC.usageRefresh);
    expect(invoke).not.toHaveBeenCalledWith(
      IPC.localRuntimeCallAction,
      expect.anything(),
    );
  });

  it("routes usage reads through a remote project runtime when bound", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Project",
    };
    const snapshot = {
      windows: [],
      pacing: {
        status: "on-track",
        projectedWeeklyPercent: 0,
        weekElapsedPercent: 0,
        expectedPercent: 0,
        deltaPercent: 0,
        etaHours: null,
        willLastToReset: true,
        resetsInHours: 0,
      },
      pacingByProvider: {},
      costs: [],
      extraUsage: [],
      dailyUsage7d: {},
      lastPolledAt: "2026-05-14T14:00:00.000Z",
      errors: [],
    };
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeCallAction) {
        const request = (payload as { request?: { domain?: string; action?: string } } | undefined)?.request;
        return { ok: true, domain: request?.domain, action: request?.action, result: snapshot, statusHints: {} };
      }
      if (channel === IPC.usageGetSnapshot || channel === IPC.usageRefresh) {
        throw new Error("remote usage should not call desktop usage IPC");
      }
      return undefined;
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await expect(bridge.usage.getSnapshot()).resolves.toEqual(snapshot);
    await expect(bridge.usage.refresh()).resolves.toEqual(snapshot);

    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: { domain: "usage", action: "getUsageSnapshot" },
    });
    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: { domain: "usage", action: "forceRefresh" },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.usageGetSnapshot);
    expect(invoke).not.toHaveBeenCalledWith(IPC.usageRefresh);
  });

  it("routes project local-data cleanup through a remote project runtime when bound", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Project",
    };
    const args = { packs: true, logs: true };
    const result = {
      deletedPaths: ["/remote/project/.ade/artifacts", "/remote/project/.ade/transcripts/logs"],
      clearedAt: "2026-05-10T12:00:00.000Z",
    };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeCallAction) {
        return { ok: true, domain: "ade_project", action: "clearLocalData", result, statusHints: {} };
      }
      return undefined;
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await expect(bridge.project.clearLocalData(args)).resolves.toEqual(result);

    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: {
        domain: "ade_project",
        action: "clearLocalData",
        args,
      },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.projectClearLocalData, args);
  });

  it("routes session deltas and artifact previews through a remote project runtime when bound", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Project",
    };
    const delta = { sessionId: "session-1", filesChanged: 2 };
    const preview = "data:image/png;base64,AAAA";
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeCallAction) {
        const request = (payload as { request?: { domain?: string; action?: string } } | undefined)?.request;
        if (request?.domain === "session" && request.action === "getDelta") {
          return { ok: true, domain: "session", action: "getDelta", result: delta, statusHints: {} };
        }
        if (request?.domain === "computer_use_artifacts" && request.action === "readArtifactPreview") {
          return {
            ok: true,
            domain: "computer_use_artifacts",
            action: "readArtifactPreview",
            result: preview,
            statusHints: {},
          };
        }
      }
      return undefined;
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await expect(bridge.sessions.getDelta("session-1")).resolves.toEqual(delta);
    await expect(bridge.computerUse.readArtifactPreview({ uri: ".ade/artifacts/proof.png" })).resolves.toBe(preview);

    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: {
        domain: "session",
        action: "getDelta",
        args: { sessionId: "session-1" },
      },
    });
    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: {
        domain: "computer_use_artifacts",
        action: "readArtifactPreview",
        args: { uri: ".ade/artifacts/proof.png" },
      },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.sessionsGetDelta, { sessionId: "session-1" });
    expect(invoke).not.toHaveBeenCalledWith(IPC.computerUseReadArtifactPreview, { uri: ".ade/artifacts/proof.png" });
  });

  it("routes Linear CTO read-model calls through a remote project runtime when bound", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Project",
    };
    const catalog = { users: [{ id: "user-1" }], labels: [{ id: "label-1" }], states: [{ id: "state-1" }] };
    const ingressStatus = { configured: true, webhookUrl: "https://linear.example/webhook" };
    const projects = [{ id: "project-1", name: "ADE" }];
    const picker = { projects, users: catalog.users, states: catalog.states };
    const search = { issues: [{ id: "issue-1", title: "Fix routing" }], pageInfo: { hasNextPage: false, endCursor: null } };
    const connection = { tokenStored: true, connected: true, viewerId: "user-1", viewerName: "Arul", checkedAt: "2026-05-10T00:00:00.000Z", message: null };
    const quickView = { connection, organization: { id: "org-1" }, viewer: { id: "user-1" }, projects, teams: [], assignedIssues: [], recentIssues: [], fetchedAt: "2026-05-10T00:00:00.000Z", sdk: { packageName: "@linear/sdk", surfaces: [] } };
    const route = { workflowId: "workflow-1", reason: "matched" };
    const oauthStart = { sessionId: "linear-oauth-1", authUrl: "https://linear.app/oauth/authorize", redirectUri: "http://127.0.0.1:19836/oauth/callback" };
    const oauthSession = { status: "completed", connection };
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeCallAction) {
        const request = (payload as { request?: { domain?: string; action?: string } } | undefined)?.request;
        if (request?.domain === "linear_issue_tracker" && request.action === "getWorkflowCatalog") {
          return { ok: true, domain: request.domain, action: request.action, result: catalog, statusHints: {} };
        }
        if (
          request?.domain === "linear_credentials" &&
          (
            request.action === "setToken" ||
            request.action === "clearToken" ||
            request.action === "setOAuthClientCredentials" ||
            request.action === "clearOAuthClientCredentials"
          )
        ) {
          return { ok: true, domain: request.domain, action: request.action, result: undefined, statusHints: {} };
        }
        if (request?.domain === "linear_issue_tracker" && request.action === "getConnectionStatus") {
          return { ok: true, domain: request.domain, action: request.action, result: connection, statusHints: {} };
        }
        if (request?.domain === "linear_issue_tracker" && request.action === "getQuickView") {
          return { ok: true, domain: request.domain, action: request.action, result: quickView, statusHints: {} };
        }
        if (request?.domain === "linear_routing" && request.action === "simulateRoute") {
          return { ok: true, domain: request.domain, action: request.action, result: route, statusHints: {} };
        }
        if (request?.domain === "linear_oauth" && request.action === "startSession") {
          return { ok: true, domain: request.domain, action: request.action, result: oauthStart, statusHints: {} };
        }
        if (request?.domain === "linear_oauth" && request.action === "getSession") {
          return { ok: true, domain: request.domain, action: request.action, result: oauthSession, statusHints: {} };
        }
        if (request?.domain === "linear_ingress" && request.action === "ensureRelayWebhook") {
          return { ok: true, domain: request.domain, action: request.action, result: undefined, statusHints: {} };
        }
        if (request?.domain === "linear_ingress" && request.action === "getStatus") {
          return { ok: true, domain: request.domain, action: request.action, result: ingressStatus, statusHints: {} };
        }
        if (request?.domain === "linear_issue_tracker" && request.action === "listProjects") {
          return { ok: true, domain: request.domain, action: request.action, result: projects, statusHints: {} };
        }
        if (request?.domain === "linear_issue_tracker" && request.action === "getIssuePickerData") {
          return { ok: true, domain: request.domain, action: request.action, result: picker, statusHints: {} };
        }
        if (request?.domain === "linear_issue_tracker" && request.action === "searchIssues") {
          return { ok: true, domain: request.domain, action: request.action, result: search, statusHints: {} };
        }
      }
      return undefined;
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await expect(bridge.cto.getLinearWorkflowCatalog()).resolves.toEqual(catalog);
    await expect(bridge.cto.getLinearConnectionStatus()).resolves.toEqual(connection);
    await expect(bridge.cto.setLinearToken({ token: "lin-token" })).resolves.toEqual(connection);
    await expect(bridge.cto.clearLinearToken()).resolves.toEqual(connection);
    await expect(bridge.cto.setLinearOAuthClient({ clientId: "client-id", clientSecret: "secret" })).resolves.toEqual(connection);
    await expect(bridge.cto.clearLinearOAuthClient()).resolves.toEqual(connection);
    await expect(bridge.cto.getLinearQuickView()).resolves.toEqual(quickView);
    await expect(bridge.cto.simulateFlowRoute({ issue: { title: "Fix routing" } })).resolves.toEqual(route);
    await expect(bridge.cto.startLinearOAuth()).resolves.toEqual(oauthStart);
    await expect(bridge.cto.getLinearOAuthSession({ sessionId: "linear-oauth-1" })).resolves.toEqual(oauthSession);
    await expect(bridge.cto.ensureLinearWebhook({ force: true })).resolves.toEqual(ingressStatus);
    await expect(bridge.cto.getLinearProjects()).resolves.toEqual(projects);
    await expect(bridge.cto.getLinearIssuePickerData()).resolves.toEqual(picker);
    await expect(bridge.cto.searchLinearIssues({ query: "routing" })).resolves.toEqual(search);

    const actions = invoke.mock.calls
      .filter(([channel]) => channel === IPC.remoteRuntimeCallAction)
      .map(([, payload]) => (payload as { request: { domain: string; action: string; args?: unknown; arg?: unknown } }).request);
    expect(actions).toEqual([
      { domain: "linear_issue_tracker", action: "getWorkflowCatalog" },
      { domain: "linear_issue_tracker", action: "getConnectionStatus" },
      { domain: "linear_credentials", action: "setToken", arg: "lin-token" },
      { domain: "linear_issue_tracker", action: "getConnectionStatus" },
      { domain: "linear_credentials", action: "clearToken" },
      { domain: "linear_issue_tracker", action: "getConnectionStatus" },
      { domain: "linear_credentials", action: "setOAuthClientCredentials", args: { clientId: "client-id", clientSecret: "secret" } },
      { domain: "linear_issue_tracker", action: "getConnectionStatus" },
      { domain: "linear_credentials", action: "clearOAuthClientCredentials" },
      { domain: "linear_issue_tracker", action: "getConnectionStatus" },
      { domain: "linear_issue_tracker", action: "getQuickView" },
      { domain: "linear_routing", action: "simulateRoute", args: { issue: { title: "Fix routing" } } },
      { domain: "linear_oauth", action: "startSession" },
      { domain: "linear_oauth", action: "getSession", arg: "linear-oauth-1" },
      { domain: "linear_ingress", action: "ensureRelayWebhook", arg: true },
      { domain: "linear_ingress", action: "getStatus" },
      { domain: "linear_issue_tracker", action: "listProjects" },
      { domain: "linear_issue_tracker", action: "getIssuePickerData" },
      { domain: "linear_issue_tracker", action: "searchIssues", args: { query: "routing" } },
    ]);
    expect(invoke).not.toHaveBeenCalledWith(IPC.ctoGetLinearWorkflowCatalog);
    expect(invoke).not.toHaveBeenCalledWith(IPC.ctoGetLinearConnectionStatus);
    expect(invoke).not.toHaveBeenCalledWith(IPC.ctoSetLinearToken, { token: "lin-token" });
    expect(invoke).not.toHaveBeenCalledWith(IPC.ctoClearLinearToken);
    expect(invoke).not.toHaveBeenCalledWith(IPC.ctoSetLinearOAuthClient, { clientId: "client-id", clientSecret: "secret" });
    expect(invoke).not.toHaveBeenCalledWith(IPC.ctoClearLinearOAuthClient);
    expect(invoke).not.toHaveBeenCalledWith(IPC.ctoGetLinearQuickView);
    expect(invoke).not.toHaveBeenCalledWith(IPC.ctoSimulateFlowRoute, { issue: { title: "Fix routing" } });
    expect(invoke).not.toHaveBeenCalledWith(IPC.ctoStartLinearOAuth);
    expect(invoke).not.toHaveBeenCalledWith(IPC.ctoGetLinearOAuthSession, { sessionId: "linear-oauth-1" });
    expect(invoke).not.toHaveBeenCalledWith(IPC.ctoEnsureLinearWebhook, { force: true });
    expect(invoke).not.toHaveBeenCalledWith(IPC.ctoGetLinearProjects);
    expect(invoke).not.toHaveBeenCalledWith(IPC.ctoGetLinearIssuePickerData);
    expect(invoke).not.toHaveBeenCalledWith(IPC.ctoSearchLinearIssues, { query: "routing" });
  });

  it("routes CTO identity session and project scan calls through a remote project runtime when bound", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Project",
    };
    const ctoSession = { id: "session-cto", identityKey: "cto" };
    const workerSession = { id: "session-worker", identityKey: "agent:worker-1" };
    const scan = { detection: null, coreMemoryPatch: { projectSummary: "Detected project setup." }, createdMemoryIds: ["mem-1"] };
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeCallAction) {
        const request = (payload as { request?: { domain?: string; action?: string } } | undefined)?.request;
        if (request?.domain === "chat" && request.action === "ensureCtoSession") {
          return { ok: true, domain: request.domain, action: request.action, result: ctoSession, statusHints: {} };
        }
        if (request?.domain === "chat" && request.action === "ensureAgentIdentitySession") {
          return { ok: true, domain: request.domain, action: request.action, result: workerSession, statusHints: {} };
        }
        if (request?.domain === "cto_state" && request.action === "runProjectScan") {
          return { ok: true, domain: request.domain, action: request.action, result: scan, statusHints: {} };
        }
      }
      return undefined;
    });
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await expect(bridge.cto.ensureSession({ modelId: "claude-sonnet", reasoningEffort: "high" })).resolves.toEqual(ctoSession);
    await expect(bridge.cto.ensureAgentSession({ agentId: "worker-1", modelId: "gpt-5.4-mini" })).resolves.toEqual(workerSession);
    await expect(bridge.cto.runProjectScan()).resolves.toEqual(scan);

    const actions = invoke.mock.calls
      .filter(([channel]) => channel === IPC.remoteRuntimeCallAction)
      .map(([, payload]) => (payload as { request: { domain: string; action: string; args?: unknown } }).request);
    expect(actions).toEqual([
      { domain: "chat", action: "ensureCtoSession", args: { modelId: "claude-sonnet", reasoningEffort: "high" } },
      { domain: "chat", action: "ensureAgentIdentitySession", args: { agentId: "worker-1", modelId: "gpt-5.4-mini" } },
      { domain: "cto_state", action: "runProjectScan" },
    ]);
    expect(invoke).not.toHaveBeenCalledWith(IPC.ctoEnsureSession, { modelId: "claude-sonnet", reasoningEffort: "high" });
    expect(invoke).not.toHaveBeenCalledWith(IPC.ctoEnsureAgentSession, { agentId: "worker-1", modelId: "gpt-5.4-mini" });
    expect(invoke).not.toHaveBeenCalledWith(IPC.ctoRunProjectScan);
  });

  it("routes history list operations through a remote project runtime when bound", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Project",
    };
    const operation = {
      id: "operation-1",
      kind: "git",
      status: "completed",
      startedAt: "2026-05-10T12:00:00.000Z",
      completedAt: "2026-05-10T12:00:01.000Z",
    };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeCallAction) {
        return { ok: true, domain: "operation", action: "list", result: [operation], statusHints: {} };
      }
      return undefined;
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await expect(bridge.history.listOperations({ limit: 10 })).resolves.toEqual([operation]);

    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: {
        domain: "operation",
        action: "list",
        args: { limit: 10 },
      },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.historyListOperations, { limit: 10 });
  });

  it("exports history using rows from a bound remote project runtime", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Remote Project",
    };
    const operation = {
      id: "operation-1",
      laneId: "lane-1",
      laneName: "Lane 1",
      kind: "git_push",
      status: "succeeded",
      startedAt: "2026-05-10T12:00:00.000Z",
      endedAt: "2026-05-10T12:00:01.000Z",
      preHeadSha: "abc",
      postHeadSha: "def",
      metadataJson: "{}",
    };
    const exportResult = {
      cancelled: false,
      savedPath: "/tmp/ade-history.json",
      bytesWritten: 120,
      exportedAt: "2026-05-10T12:00:02.000Z",
      rowCount: 1,
      format: "json",
    };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeCallAction) {
        return { ok: true, domain: "operation", action: "list", result: [operation], statusHints: {} };
      }
      if (channel === IPC.historyExportOperations) {
        return exportResult;
      }
      return undefined;
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await expect(bridge.history.exportOperations({
      format: "json",
      status: "succeeded",
      laneId: "lane-1",
      limit: 25,
    })).resolves.toEqual(exportResult);

    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: {
        domain: "operation",
        action: "list",
        args: {
          laneId: "lane-1",
          limit: 25,
        },
      },
    });
    expect(invoke).toHaveBeenCalledWith(IPC.historyExportOperations, {
      format: "json",
      status: "succeeded",
      laneId: "lane-1",
      limit: 25,
      rows: [operation],
      project: {
        rootPath: "/remote/project",
        displayName: "Remote Project",
      },
    });
  });

  it("routes Phase 3 acceptance actions through a bound remote runtime", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Project",
    };
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeCallAction) {
        const request = (payload as { request?: { domain?: string; action?: string } } | undefined)?.request;
        return {
          ok: true,
          domain: request?.domain,
          action: request?.action,
          result: { ok: true },
          statusHints: {},
        };
      }
      return undefined;
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await bridge.lanes.create({ name: "Remote lane" });
    await bridge.agentChat.create({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
    await bridge.agentChat.send({ sessionId: "chat-1", text: "hello" });
    await bridge.git.commit({ laneId: "lane-1", message: "checkpoint" });
    await bridge.git.push({ laneId: "lane-1" });
    await bridge.prs.createFromLane({ laneId: "lane-1", title: "Remote PR", body: "Proof" });

    const actions = invoke.mock.calls
      .filter(([channel]) => channel === IPC.remoteRuntimeCallAction)
      .map(([, payload]) => (payload as { request: { domain: string; action: string } }).request);
    expect(actions.map((request) => `${request.domain}.${request.action}`)).toEqual([
      "lane.create",
      "chat.createSession",
      "chat.sendMessage",
      "git.commit",
      "git.push",
      "pr.createFromLane",
    ]);
    expect(invoke).not.toHaveBeenCalledWith(IPC.lanesCreate, expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(IPC.agentChatCreate, expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(IPC.gitCommit, expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(IPC.gitPush, expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(IPC.prsCreateFromLane, expect.anything());
  });

  it("routes bulk PR merge context hydration with positional runtime args", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Project",
    };
    const contexts = { "pr-1": { prId: "pr-1", members: [] } };
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeCallAction) {
        const request = (payload as { request?: { domain?: string; action?: string } } | undefined)?.request;
        return { ok: true, domain: request?.domain, action: request?.action, result: contexts, statusHints: {} };
      }
      return undefined;
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await expect(bridge.prs.getMergeContexts(["pr-1", "pr-2"])).resolves.toEqual(contexts);
    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: {
        domain: "pr",
        action: "getMergeContexts",
        argsList: [["pr-1", "pr-2"]],
      },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.prsGetMergeContexts, expect.anything());
  });

  it("routes GitHub repo metadata through a remote project runtime when bound", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Project",
    };
    const labels = [{ name: "bug", color: "d73a4a" }];
    const collaborators = [{ login: "octocat", avatarUrl: "https://example.test/octocat.png" }];
    const remoteStatus = { repo: { owner: "acme", name: "repo" }, hasOrigin: true };
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeCallAction) {
        const request = (payload as { request?: { action?: string } } | undefined)?.request;
        if (request?.action === "listRepoLabels") {
          return { ok: true, domain: "github", action: "listRepoLabels", result: labels, statusHints: {} };
        }
        if (request?.action === "listRepoCollaborators") {
          return {
            ok: true,
            domain: "github",
            action: "listRepoCollaborators",
            result: collaborators,
            statusHints: {},
          };
        }
        if (request?.action === "getRemoteStatus") {
          return {
            ok: true,
            domain: "github",
            action: "getRemoteStatus",
            result: remoteStatus,
            statusHints: {},
          };
        }
      }
      return undefined;
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await expect(bridge.github.listRepoLabels({ owner: "acme", name: "repo" })).resolves.toEqual(labels);
    await expect(bridge.github.listRepoCollaborators({ owner: "acme", name: "repo" })).resolves.toEqual(collaborators);
    await expect(bridge.github.getRemoteStatus({ forceRefresh: true })).resolves.toEqual(remoteStatus);

    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: {
        domain: "github",
        action: "listRepoLabels",
        args: { owner: "acme", name: "repo" },
      },
    });
    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: {
        domain: "github",
        action: "listRepoCollaborators",
        args: { owner: "acme", name: "repo" },
      },
    });
    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: {
        domain: "github",
        action: "getRemoteStatus",
        args: { forceRefresh: true },
      },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.githubListRepoLabels, { owner: "acme", name: "repo" });
    expect(invoke).not.toHaveBeenCalledWith(IPC.githubListRepoCollaborators, { owner: "acme", name: "repo" });
    expect(invoke).not.toHaveBeenCalledWith(IPC.githubGetRemoteStatus, expect.anything());
  });

  it("routes GitHub publish through a remote project runtime when bound", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Project",
    };
    const result = { owner: "acme", name: "repo", url: "https://github.com/acme/repo" };
    const input = { name: "repo", private: true };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeCallAction) {
        return { ok: true, domain: "github", action: "publishCurrentProject", result, statusHints: {} };
      }
      return undefined;
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await expect(bridge.github.publishCurrentProject(input)).resolves.toEqual(result);

    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: {
        domain: "github",
        action: "publishCurrentProject",
        args: input,
      },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.githubPublishCurrentProject, input);
  });

  it("routes PTY creation through a remote project runtime when bound", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Project",
    };
    const input = {
      laneId: "lane-1",
      startupCommand: "codex login",
      tracked: true,
      toolType: "shell",
    };
    const result = { ptyId: "pty-1", sessionId: "session-1" };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeCallAction) {
        return { ok: true, domain: "pty", action: "create", result, statusHints: {} };
      }
      return undefined;
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await expect(bridge.pty.create(input)).resolves.toEqual(result);

    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: {
        domain: "pty",
        action: "create",
        args: input,
      },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.ptyCreate, input);
  });

  it("fans out project state events from local IPC and remote runtime events", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Project",
    };
    const projectEvent = {
      type: "config-changed",
      at: "2026-05-10T12:00:00.000Z",
      filePath: "/remote/project/.ade/ade.yaml",
      snapshot: {
        rootPath: "/remote/project",
        adeDir: "/remote/project/.ade",
        lastCheckedAt: "2026-05-10T12:00:00.000Z",
        entries: [],
        health: [],
        cleanup: { changed: false, actions: [] },
        config: {
          sharedPath: "/remote/project/.ade/ade.yaml",
          localPath: "/remote/project/.ade/local.yaml",
          secretPath: "/remote/project/.ade/local.secret.yaml",
          trust: {
            sharedHash: "shared",
            localHash: "local",
            approvedSharedHash: null,
            requiresSharedTrust: false,
          },
        },
      },
    };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeStreamEvents) {
        return { events: [], nextCursor: 0, hasMore: false };
      }
      return undefined;
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await bridge.app.getWindowSession();

    const callback = vi.fn();
    const unsubscribe = bridge.project.onStateEvent(callback);

    const projectStateListener = on.mock.calls.find(([channel]) => channel === IPC.projectStateEvent)?.[1];
    expect(typeof projectStateListener).toBe("function");
    projectStateListener({}, projectEvent);
    expect(callback).toHaveBeenCalledWith(projectEvent);

    const runtimeListener = on.mock.calls.find(([channel]) => channel === IPC.runtimeEvent)?.[1];
    expect(typeof runtimeListener).toBe("function");
    runtimeListener({}, {
      bindingKey: binding.key,
      event: {
        id: 1,
        timestamp: "2026-05-10T12:00:01.000Z",
        category: "runtime",
        payload: { type: "project_state_event", event: projectEvent },
      },
    });
    expect(callback).toHaveBeenCalledTimes(2);

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(IPC.projectStateEvent, projectStateListener);

    runtimeListener({}, {
      bindingKey: binding.key,
      event: {
        id: 2,
        timestamp: "2026-05-10T12:00:02.000Z",
        category: "runtime",
        payload: { type: "project_state_event", event: projectEvent },
      },
    });
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("fans out PR events from local IPC and remote runtime events", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Project",
    };
    const prEvent = {
      type: "prs-updated",
      polledAt: "2026-05-10T12:00:00.000Z",
      prs: [],
    };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeStreamEvents) {
        return { events: [], nextCursor: 0, hasMore: false };
      }
      return undefined;
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    await bridge.app.getWindowSession();

    const callback = vi.fn();
    const unsubscribe = bridge.prs.onEvent(callback);

    const prListener = on.mock.calls.find(([channel]) => channel === IPC.prsEvent)?.[1];
    expect(typeof prListener).toBe("function");
    prListener({}, prEvent);
    expect(callback).toHaveBeenCalledWith(prEvent);

    const runtimeListener = on.mock.calls.find(([channel]) => channel === IPC.runtimeEvent)?.[1];
    expect(typeof runtimeListener).toBe("function");
    runtimeListener({}, {
      bindingKey: binding.key,
      event: {
        id: 1,
        timestamp: "2026-05-10T12:00:01.000Z",
        category: "runtime",
        payload: { type: "pr_event", event: prEvent },
      },
    });
    expect(callback).toHaveBeenCalledTimes(2);

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(IPC.prsEvent, prListener);

    runtimeListener({}, {
      bindingKey: binding.key,
      event: {
        id: 2,
        timestamp: "2026-05-10T12:00:02.000Z",
        category: "runtime",
        payload: { type: "pr_event", event: prEvent },
      },
    });
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("multiplexes local session and PR event subscriptions through one IPC listener", async () => {
    const sessionEvent = {
      sessionId: "session-1",
      reason: "meta-updated",
    };
    const prEvent = {
      type: "prs-updated",
      polledAt: "2026-05-10T12:00:00.000Z",
      prs: [],
    };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding: null };
      }
      return undefined;
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((name: string, value: unknown) => {
      (globalThis as any).__bridgeName = name;
      (globalThis as any).__adeBridge = value;
    });

    vi.doMock("electron", () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
      webFrame: {
        getZoomLevel: vi.fn(() => 0),
        setZoomLevel: vi.fn(),
        getZoomFactor: vi.fn(() => 1),
      },
    }));

    await import("./preload");

    const bridge = (globalThis as any).__adeBridge;
    const sessionCallbackA = vi.fn();
    const sessionCallbackB = vi.fn();
    const prCallbackA = vi.fn();
    const prCallbackB = vi.fn();

    const unsubscribeSessionA = bridge.sessions.onChanged(sessionCallbackA);
    const unsubscribeSessionB = bridge.sessions.onChanged(sessionCallbackB);
    const unsubscribePrA = bridge.prs.onEvent(prCallbackA);
    const unsubscribePrB = bridge.prs.onEvent(prCallbackB);

    const sessionListeners = on.mock.calls.filter(([channel]) => channel === IPC.sessionsChanged);
    const prListeners = on.mock.calls.filter(([channel]) => channel === IPC.prsEvent);
    expect(sessionListeners).toHaveLength(1);
    expect(prListeners).toHaveLength(1);

    const sessionListener = sessionListeners[0]![1];
    const prListener = prListeners[0]![1];
    sessionListener({}, sessionEvent);
    prListener({}, prEvent);

    expect(sessionCallbackA).toHaveBeenCalledWith(sessionEvent);
    expect(sessionCallbackB).toHaveBeenCalledWith(sessionEvent);
    expect(prCallbackA).toHaveBeenCalledWith(prEvent);
    expect(prCallbackB).toHaveBeenCalledWith(prEvent);

    unsubscribeSessionA();
    unsubscribePrA();
    expect(removeListener).not.toHaveBeenCalledWith(IPC.sessionsChanged, sessionListener);
    expect(removeListener).not.toHaveBeenCalledWith(IPC.prsEvent, prListener);

    sessionListener({}, sessionEvent);
    prListener({}, prEvent);
    expect(sessionCallbackA).toHaveBeenCalledTimes(1);
    expect(sessionCallbackB).toHaveBeenCalledTimes(2);
    expect(prCallbackA).toHaveBeenCalledTimes(1);
    expect(prCallbackB).toHaveBeenCalledTimes(2);

    unsubscribeSessionB();
    unsubscribePrB();
    expect(removeListener).toHaveBeenCalledWith(IPC.sessionsChanged, sessionListener);
    expect(removeListener).toHaveBeenCalledWith(IPC.prsEvent, prListener);
  });
});

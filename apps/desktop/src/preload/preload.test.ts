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

  it("exposes per-window project tab session IPC", async () => {
    const project = { rootPath: "/repo/a", displayName: "A", baseRef: "main" };
    const openProjectTabs = [
      project,
      { rootPath: "/repo/b", displayName: "B", baseRef: "main" },
    ];
    const invoke = vi.fn(async (channel: string, _payload?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 7, project, binding: null, openProjectTabs };
      }
      if (channel === IPC.appSetWindowProjectTabs) {
        return { openProjectTabs: [openProjectTabs[1]] };
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
    await expect(bridge.app.getWindowSession()).resolves.toEqual({
      windowId: 7,
      project,
      binding: null,
      openProjectTabs,
    });
    await expect(bridge.app.setWindowProjectTabs(["/repo/b"])).resolves.toEqual({
      openProjectTabs: [openProjectTabs[1]],
    });
    expect(invoke).toHaveBeenCalledWith(IPC.appSetWindowProjectTabs, { rootPaths: ["/repo/b"] });
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

  it("routes review.startRun through a bound local runtime without dropping config fields", async () => {
    const binding = {
      kind: "local",
      key: "local:/repo",
      rootPath: "/repo",
      displayName: "Project",
    };
    const startArgs = {
      target: { mode: "lane_diff", laneId: "lane-1" },
      config: {
        compareAgainst: { kind: "default_branch" },
        selectionMode: "full_diff",
        dirtyOnly: false,
        modelId: "openai/gpt-5.4",
        reasoningEffort: "medium",
        publishBehavior: "local_only",
      },
    };
    const run = {
      id: "review-run-1",
      projectId: "project-1",
      laneId: "lane-1",
      target: startArgs.target,
      config: startArgs.config,
      targetLabel: "Lane 1",
      compareTarget: null,
      status: "queued",
      summary: null,
      errorMessage: null,
      findingCount: 0,
      severitySummary: {},
      chatSessionId: null,
      createdAt: "2026-05-19T12:00:00.000Z",
      startedAt: "2026-05-19T12:00:00.000Z",
      endedAt: null,
      updatedAt: "2026-05-19T12:00:00.000Z",
    };
    const invoke = vi.fn(async (channel: string, arg?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: { rootPath: "/repo", displayName: "Project" }, binding };
      }
      if (channel === IPC.localRuntimeCallAction) {
        const request = (arg as { request?: { domain?: string; action?: string; args?: unknown } } | undefined)?.request;
        expect(request?.domain).toBe("review");
        expect(request?.action).toBe("startRun");
        expect(request?.args).toEqual(startArgs);
        return { result: run };
      }
      if (channel === IPC.reviewStartRun) {
        throw new Error("runtime-bound review.startRun should not call desktop review IPC");
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
    await expect(bridge.review.startRun(startArgs)).resolves.toEqual(run);

    expect(invoke).toHaveBeenCalledWith(IPC.localRuntimeCallAction, {
      rootPath: "/repo",
      request: { domain: "review", action: "startRun", args: startArgs },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.reviewStartRun, expect.anything());
  });

  it("does not fall through to in-process review IPC when a bound local runtime cannot call review.startRun", async () => {
    const binding = {
      kind: "local",
      key: "local:/repo",
      rootPath: "/repo",
      displayName: "Project",
    };
    const invoke = vi.fn(async (channel: string, arg?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: { rootPath: "/repo", displayName: "Project" }, binding };
      }
      if (channel === IPC.localRuntimeCallAction) {
        const request = (arg as { request?: { domain?: string; action?: string } } | undefined)?.request;
        throw new Error(`Action '${request?.domain}.${request?.action}' is not callable.`);
      }
      if (channel === IPC.reviewStartRun) {
        throw new Error("runtime-bound review.startRun should not call desktop review IPC");
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
    const args = { target: { mode: "lane_diff", laneId: "lane-1" } };

    await expect(bridge.review.startRun(args)).rejects.toThrow("not callable");

    expect(invoke).toHaveBeenCalledWith(IPC.localRuntimeCallAction, {
      rootPath: "/repo",
      request: { domain: "review", action: "startRun", args },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.reviewStartRun, expect.anything());
  });

  it("rejects sensitive local host helpers for remote project bindings before local IPC", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Project",
    };
    const invoke = vi.fn(async (channel: string, _payload?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
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
    await expect(bridge.iosSimulator.getSimulatorWindowState()).rejects.toThrow(/local project host/i);
    await expect(bridge.iosSimulator.listSimulatorWindowSources()).rejects.toThrow(/local project host/i);

    expect(invoke).toHaveBeenCalledWith(IPC.appGetWindowSession);
    expect(invoke).not.toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(IPC.iosSimulatorGetWindowState);
    expect(invoke).not.toHaveBeenCalledWith(IPC.iosSimulatorListWindowSources);
  });

  it("rejects iOS Simulator window sources when no local project is bound", async () => {
    const invoke = vi.fn(async (channel: string, _payload?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding: null };
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
    await expect(bridge.iosSimulator.listSimulatorWindowSources()).rejects.toThrow(/open local project/i);

    expect(invoke).toHaveBeenCalledWith(IPC.appGetWindowSession);
    expect(invoke).not.toHaveBeenCalledWith(IPC.iosSimulatorListWindowSources, expect.anything());
  });

  it("passes the bound local project root when reading iOS Simulator window sources", async () => {
    const binding = {
      kind: "local",
      key: "local:/repo",
      rootPath: "/repo",
      displayName: "Project",
    };
    const sources = [{ id: "window:1", name: "Simulator", thumbnailDataUrl: null }];
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: { rootPath: "/repo", displayName: "Project" }, binding };
      }
      if (channel === IPC.iosSimulatorListWindowSources) {
        expect(payload).toEqual({ projectRoot: "/repo" });
        return sources;
      }
      throw new Error(`unexpected IPC: ${channel} ${JSON.stringify(payload)}`);
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
    await expect(bridge.iosSimulator.listSimulatorWindowSources()).resolves.toEqual(sources);

    expect(invoke).toHaveBeenCalledWith(IPC.appGetWindowSession);
    expect(invoke).toHaveBeenCalledWith(IPC.iosSimulatorListWindowSources, { projectRoot: "/repo" });
  });

  it("routes local lane creation through the local runtime when a local project runtime is bound", async () => {
    const binding = {
      kind: "local",
      key: "local:/repo",
      rootPath: "/repo",
      displayName: "Project",
    };
    const result = { id: "lane-plain", name: "Plain lane" };
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: { rootPath: "/repo", displayName: "Project" }, binding };
      }
      if (channel === IPC.localRuntimeCallAction) {
        return {
          domain: "lane",
          action: "create",
          result,
          statusHints: {},
        };
      }
      throw new Error(`unexpected IPC: ${channel} ${JSON.stringify(payload)}`);
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
    await expect(bridge.lanes.create({ name: "Plain lane" })).resolves.toEqual(result);

    expect(invoke).toHaveBeenCalledWith(IPC.appGetWindowSession);
    expect(invoke).toHaveBeenCalledWith(IPC.localRuntimeCallAction, {
      rootPath: "/repo",
      request: {
        domain: "lane",
        action: "create",
        args: { name: "Plain lane" },
      },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.lanesCreate, expect.anything());
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

  it("rejects local desktop path actions for remote project bindings before local IPC", async () => {
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
    await expect(bridge.app.revealPath("/remote/project/file.txt")).rejects.toThrow(/remote project paths/i);
    await expect(bridge.app.openPath("/remote/project/file.txt")).rejects.toThrow(/remote project paths/i);
    await expect(bridge.app.getImageDataUrl("/remote/project/image.png")).rejects.toThrow(/remote project paths/i);
    await expect(bridge.app.writeClipboardImage("/remote/project/image.png")).rejects.toThrow(/remote project paths/i);
    await expect(
      bridge.app.openPathInEditor({
        rootPath: "/remote/project",
        relativePath: "file.txt",
        target: "cursor",
      }),
    ).rejects.toThrow(/remote project paths/i);

    expect(invoke).toHaveBeenCalledWith(IPC.appGetWindowSession);
    expect(invoke).not.toHaveBeenCalledWith(IPC.appRevealPath, expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(IPC.appOpenPath, expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(IPC.appGetImageDataUrl, expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(IPC.appWriteClipboardImage, expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(IPC.appOpenPathInEditor, expect.anything());
  });

  it("allows local temp path actions while a remote project is bound", async () => {
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
      if (channel === IPC.appGetImageDataUrl) return { dataUrl: "data:image/png;base64,AA==" };
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
    await expect(bridge.app.revealPath("/tmp/local-file.txt")).resolves.toBeUndefined();
    await expect(bridge.app.openPath("/tmp/local-file.txt")).resolves.toBeUndefined();
    await expect(bridge.app.getImageDataUrl("/tmp/local-image.png")).resolves.toEqual({ dataUrl: "data:image/png;base64,AA==" });
    await expect(bridge.app.writeClipboardImage("/tmp/local-image.png")).resolves.toBeUndefined();
    await expect(
      bridge.app.openPathInEditor({
        rootPath: "/tmp/local-project",
        relativePath: "file.txt",
        target: "cursor",
      }),
    ).resolves.toBeUndefined();

    expect(invoke).toHaveBeenCalledWith(IPC.appRevealPath, { path: "/tmp/local-file.txt" });
    expect(invoke).toHaveBeenCalledWith(IPC.appOpenPath, { path: "/tmp/local-file.txt" });
    expect(invoke).toHaveBeenCalledWith(IPC.appGetImageDataUrl, { path: "/tmp/local-image.png" });
    expect(invoke).toHaveBeenCalledWith(IPC.appWriteClipboardImage, { path: "/tmp/local-image.png" });
    expect(invoke).toHaveBeenCalledWith(IPC.appOpenPathInEditor, {
      rootPath: "/tmp/local-project",
      relativePath: "file.txt",
      target: "cursor",
    });
  });

  it("does not let stale window-session refreshes overwrite a newer project binding", async () => {
    const oldLocalBinding = {
      kind: "local",
      key: "local:/old",
      rootPath: "/old",
      displayName: "Old",
    };
    const newerRemoteBinding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Project",
    };
    let resolveSession: (value: unknown) => void = () => {};
    const sessionPromise = new Promise((resolve) => {
      resolveSession = resolve;
    });
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) return sessionPromise;
      if (channel === IPC.lanesOpenFolder) throw new Error("stale local IPC should not run");
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
    bridge.app.onProjectBindingChanged(vi.fn());
    const openFolder = bridge.lanes.openFolder({ laneId: "lane-1" });

    expect(invoke).toHaveBeenCalledWith(IPC.appGetWindowSession);

    const bindingListener = on.mock.calls.find(([channel]) => channel === IPC.appProjectBindingChanged)?.[1];
    expect(typeof bindingListener).toBe("function");
    bindingListener({}, newerRemoteBinding);
    resolveSession({ windowId: 1, project: { rootPath: "/old", displayName: "Old" }, binding: oldLocalBinding });

    await expect(openFolder).rejects.toThrow(/remote lane folders/i);
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

  it("surfaces local runtime action failures instead of falling back to in-process IPC", async () => {
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
      if (channel === IPC.localRuntimeCallAction) {
        throw new Error(
          "Error invoking remote method 'ade.localRuntime.callAction': Error: IPC handler for 'ade.localRuntime.callAction' timed out after 30000ms (callId=286)",
        );
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
    await expect(bridge.lanes.list()).rejects.toThrow(/timed out after 30000ms/);

    expect(invoke).toHaveBeenCalledWith(IPC.localRuntimeCallAction, {
      rootPath: "/repo",
      request: { domain: "lane", action: "list", args: {} },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.lanesList, {});
  });

  it("does not fall back chat create when local runtime callAction times out", async () => {
    const binding = {
      kind: "local",
      key: "local:/repo",
      rootPath: "/repo",
      displayName: "Project",
    };
    const created = { id: "chat-1", laneId: "lane-1", provider: "cursor", model: "composer-2.5-fast", modelId: "cursor/composer-2.5-fast" };
    const invoke = vi.fn(async (channel: string, arg?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: { rootPath: "/repo", displayName: "Project" }, binding };
      }
      if (channel === IPC.localRuntimeCallAction) {
        const request = (arg as { request?: { domain?: string; action?: string } } | undefined)?.request;
        if (request?.domain === "chat" && request.action === "createSession") {
          throw new Error(
            "Error invoking remote method 'ade.localRuntime.callAction': Error: IPC handler for 'ade.localRuntime.callAction' timed out after 30000ms (callId=286)",
          );
        }
      }
      if (channel === IPC.agentChatCreate) return created;
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
    await expect(bridge.agentChat.create({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2.5-fast",
      modelId: "cursor/composer-2.5-fast",
    })).rejects.toThrow(/timed out after 30000ms/);

    expect(invoke).toHaveBeenCalledWith(IPC.localRuntimeCallAction, {
      rootPath: "/repo",
      request: {
        domain: "chat",
        action: "createSession",
        args: expect.objectContaining({ laneId: "lane-1" }),
      },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.agentChatCreate, expect.objectContaining({
      laneId: "lane-1",
      provider: "cursor",
    }));
  });

  it("does not fall back when the local runtime does not expose a new action yet", async () => {
    const binding = {
      kind: "local",
      key: "local:/repo",
      rootPath: "/repo",
      displayName: "Project",
    };
    const catalog = {
      generatedAt: "2026-05-18T18:00:00.000Z",
      stale: false,
      availableModelIds: [],
      models: [],
      providers: [],
      groups: [],
    };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: { rootPath: "/repo", displayName: "Project" }, binding };
      }
      if (channel === IPC.localRuntimeCallAction) {
        throw new Error("Action 'chat.modelCatalog' is not callable.");
      }
      if (channel === IPC.agentChatModelCatalog) return catalog;
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
    await expect(bridge.agentChat.modelCatalog({ mode: "cached" })).rejects.toThrow(/not callable/);

    expect(invoke).toHaveBeenCalledWith(IPC.localRuntimeCallAction, {
      rootPath: "/repo",
      request: { domain: "chat", action: "modelCatalog", args: { mode: "cached" } },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.agentChatModelCatalog, { mode: "cached" });
  });

  it("routes local PR tab reads through the project runtime", async () => {
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
        const request = (arg as { request?: { action?: string } } | undefined)?.request;
        if (request?.action === "getDetail") return { result: detail };
        if (request?.action === "listWithConflicts") return { result: prs };
        if (request?.action === "getGithubSnapshot") return { result: snapshot };
        throw new Error(`unexpected local PR action: ${request?.action}`);
      }
      if (channel === IPC.prsGetDetail || channel === IPC.prsListWithConflicts || channel === IPC.prsGetGitHubSnapshot) {
        throw new Error("local runtime PR reads should not call desktop PR IPC");
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
    await expect(bridge.prs.getDetail("pr-1")).resolves.toEqual(detail);
    await expect(bridge.prs.listWithConflicts()).resolves.toEqual(prs);
    await expect(bridge.prs.getGitHubSnapshot()).resolves.toEqual(snapshot);

    expect(invoke).toHaveBeenCalledWith(IPC.localRuntimeCallAction, {
      rootPath: "/repo",
      request: { domain: "pr", action: "getDetail", arg: "pr-1" },
    });
    expect(invoke).toHaveBeenCalledWith(IPC.localRuntimeCallAction, {
      rootPath: "/repo",
      request: { domain: "pr", action: "listWithConflicts", args: {} },
    });
    expect(invoke).toHaveBeenCalledWith(IPC.localRuntimeCallAction, {
      rootPath: "/repo",
      request: { domain: "pr", action: "getGithubSnapshot", args: {} },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.prsGetDetail, expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(IPC.prsListWithConflicts, expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(IPC.prsGetGitHubSnapshot, expect.anything());
  });

  it("does not fall through to in-process PR branch import IPC when a bound local runtime action is missing", async () => {
    const binding = {
      kind: "local",
      key: "local:/repo",
      rootPath: "/repo",
      displayName: "Project",
    };
    const invoke = vi.fn(async (channel: string, arg?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: { rootPath: "/repo", displayName: "Project" }, binding };
      }
      if (channel === IPC.localRuntimeCallAction) {
        const request = (arg as { request?: { domain?: string; action?: string } } | undefined)?.request;
        throw new Error(`Action '${request?.domain}.${request?.action}' is not callable.`);
      }
      if (channel === IPC.prsPreflightCreateLaneFromPrBranch || channel === IPC.prsCreateLaneFromPrBranch) {
        throw new Error("runtime-bound PR branch import should not call desktop PR IPC");
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
    const args = { repoOwner: "owner", repoName: "repo", githubPrNumber: 12 };

    await expect(bridge.prs.preflightCreateLaneFromPrBranch(args)).rejects.toThrow("not callable");
    await expect(bridge.prs.createLaneFromPrBranch(args)).rejects.toThrow("not callable");

    expect(invoke).toHaveBeenCalledWith(IPC.localRuntimeCallAction, {
      rootPath: "/repo",
      request: { domain: "pr", action: "preflightCreateLaneFromPrBranch", args },
    });
    expect(invoke).toHaveBeenCalledWith(IPC.localRuntimeCallAction, {
      rootPath: "/repo",
      request: { domain: "pr", action: "createLaneFromPrBranch", args },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.prsPreflightCreateLaneFromPrBranch, expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(IPC.prsCreateLaneFromPrBranch, expect.anything());
  });

  it("falls back to in-process PR branch import IPC when no runtime is bound", async () => {
    const args = { repoOwner: "owner", repoName: "repo", githubPrNumber: 12 };
    const preflightResult = {
      preflight: {
        repoOwner: "owner",
        repoName: "repo",
        githubPrNumber: 12,
        githubUrl: "https://github.com/owner/repo/pull/12",
        title: "Import branch",
        headBranch: "feature/import",
        headSha: "abc123",
        headRepoOwner: "owner",
        headRepoName: "repo",
        remoteBranch: "origin/feature/import",
        importBranchRef: "origin/feature/import",
        targetLaneName: "Import branch",
        baseBranch: "main",
        canCreate: true,
        status: "ready",
        blockingConflict: null,
        blockingConflicts: [],
      },
      lane: null,
      pr: null,
    };
    const createResult = {
      ...preflightResult,
      lane: { id: "lane-created" },
      pr: { id: "pr-created" },
    };
    const invoke = vi.fn(async (channel: string, arg?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: { rootPath: "/repo", displayName: "Project" }, binding: null };
      }
      if (channel === IPC.prsPreflightCreateLaneFromPrBranch) return preflightResult;
      if (channel === IPC.prsCreateLaneFromPrBranch) return createResult;
      if (channel === IPC.localRuntimeCallAction || channel === IPC.remoteRuntimeCallAction) {
        throw new Error("unbound project should not call runtime IPC");
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
    await expect(bridge.prs.preflightCreateLaneFromPrBranch(args)).resolves.toEqual(preflightResult);
    await expect(bridge.prs.createLaneFromPrBranch(args)).resolves.toEqual(createResult);

    expect(invoke).toHaveBeenCalledWith(IPC.prsPreflightCreateLaneFromPrBranch, args);
    expect(invoke).toHaveBeenCalledWith(IPC.prsCreateLaneFromPrBranch, args);
    expect(invoke).not.toHaveBeenCalledWith(IPC.localRuntimeCallAction, expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, expect.anything());
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

  it("routes ADE action registry listing through a remote project runtime when bound", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Project",
    };
    const registry = [
      { domain: "chat", actions: [{ name: "launchCli" }] },
      { domain: "git", actions: [{ name: "status" }] },
    ];
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeListActionRegistry) {
        return registry;
      }
      if (channel === IPC.adeActionsListRegistry) {
        throw new Error("remote action registry should not use local IPC");
      }
      throw new Error(`unexpected IPC: ${channel} ${JSON.stringify(payload)}`);
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
    await expect(bridge.actions.listRegistry()).resolves.toEqual(registry);

    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeListActionRegistry, {
      id: "target-1",
      projectId: "project-1",
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.adeActionsListRegistry);
  });

  it("routes ADE action registry listing through the local project runtime when bound", async () => {
    const binding = {
      kind: "local",
      key: "local:/repo",
      rootPath: "/repo",
      displayName: "Project",
    };
    const registry = [{ domain: "git", actions: [{ name: "status" }] }];
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: { rootPath: "/repo", displayName: "Project" }, binding };
      }
      if (channel === IPC.localRuntimeListActionRegistry) {
        return registry;
      }
      if (channel === IPC.remoteRuntimeListActionRegistry) {
        throw new Error("local action registry should not use remote IPC");
      }
      if (channel === IPC.adeActionsListRegistry) {
        throw new Error("bound local action registry should use ADE runtime");
      }
      throw new Error(`unexpected IPC: ${channel} ${JSON.stringify(payload)}`);
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
    await expect(bridge.actions.listRegistry()).resolves.toEqual(registry);

    expect(invoke).toHaveBeenCalledWith(IPC.localRuntimeListActionRegistry, {
      rootPath: "/repo",
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.adeActionsListRegistry);
    expect(invoke).not.toHaveBeenCalledWith(
      IPC.remoteRuntimeListActionRegistry,
      expect.anything(),
    );
  });

  it("uses the in-process ADE action registry when no project runtime is bound", async () => {
    const registry = [{ domain: "git", actions: [{ name: "status" }] }];
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding: null };
      }
      if (channel === IPC.adeActionsListRegistry) {
        return registry;
      }
      if (channel === IPC.localRuntimeListActionRegistry || channel === IPC.remoteRuntimeListActionRegistry) {
        throw new Error("unbound action registry should not use a project runtime");
      }
      throw new Error(`unexpected IPC: ${channel} ${JSON.stringify(payload)}`);
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
    await expect(bridge.actions.listRegistry()).resolves.toEqual(registry);
    expect(invoke).toHaveBeenCalledWith(IPC.adeActionsListRegistry);
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
      rootPath: "/repo",
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
      rootPath: "/repo",
      request: { domain: "file", action: "listWorkspaces", args: {} },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.filesListWorkspaces, expect.anything());
  });

  it("routes local project diff reads through the local runtime when bound", async () => {
    const binding = {
      kind: "local",
      key: "local:/repo",
      rootPath: "/repo",
      displayName: "Project",
    };
    const patch = {
      path: "src/app.ts",
      mode: "working",
      patch: "diff --git a/src/app.ts b/src/app.ts\n",
    };
    const invoke = vi.fn(async (channel: string, arg?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: { rootPath: "/repo", displayName: "Project" }, binding };
      }
      if (channel === IPC.localRuntimeCallAction) {
        return {
          domain: "diff",
          action: "getFilePatch",
          result: patch,
          statusHints: {},
        };
      }
      if (channel === IPC.diffGetFilePatch) {
        throw new Error("runtime-bound diff reads should not use in-process IPC");
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
    await expect(
      bridge.diff.getFilePatch({ laneId: "lane-1", path: "src/app.ts", mode: "working" }),
    ).resolves.toEqual(patch);

    expect(invoke).toHaveBeenCalledWith(
      IPC.localRuntimeCallAction,
      expect.objectContaining({
        rootPath: "/repo",
        request: expect.objectContaining({ domain: "diff", action: "getFilePatch" }),
      }),
    );
    expect(invoke).not.toHaveBeenCalledWith(IPC.diffGetFilePatch, expect.anything());
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

  it("keeps polling local runtime events after a stream timeout", async () => {
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
        "ADE runtime event polling failed",
        expect.any(Error),
      );

      await vi.advanceTimersByTimeAsync(2_000);
      expect(streamCallCount()).toBe(2);

      unsubscribe();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("switches event polling to the new runtime binding", async () => {
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
      expect(localStreamCallCount()).toBe(2);
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

  it("ignores stale stream errors after switching event polling bindings", async () => {
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
      let rejectLocalStream = (_error: Error): void => {
        throw new Error("local stream was not started");
      };
      const invoke = vi.fn(async (channel: string) => {
        if (channel === IPC.appGetWindowSession) {
          return { windowId: 1, project: { rootPath: "/repo", displayName: "Project" }, binding };
        }
        if (channel === IPC.localRuntimeStreamEvents) {
          return await new Promise((_resolve, reject) => {
            rejectLocalStream = reject;
          });
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
      expect(remoteStreamCallCount()).toBe(0);

      const bindingListener = on.mock.calls.find(([channel]) => channel === IPC.appProjectBindingChanged)?.[1];
      expect(typeof bindingListener).toBe("function");
      binding = remoteBinding;
      bindingListener({}, remoteBinding);
      rejectLocalStream?.(new Error("Local runtime project is not available for this window."));
      await vi.advanceTimersByTimeAsync(0);

      expect(warn).not.toHaveBeenCalled();
      expect(remoteStreamCallCount()).toBe(1);

      unsubscribeBinding();
      unsubscribeState();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("routes local project usage reads through the shared project runtime when bound", async () => {
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
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: { rootPath: "/repo", displayName: "Project" }, binding };
      }
      if (channel === IPC.localRuntimeCallAction) {
        const request = (payload as { request?: { domain?: string; action?: string } } | undefined)?.request;
        if (request?.domain !== "usage") throw new Error("unexpected local runtime domain");
        return {
          ok: true,
          domain: request.domain,
          action: request.action,
          result: request.action === "forceRefresh" ? refreshed : snapshot,
          statusHints: {},
        };
      }
      if (channel === IPC.usageGetSnapshot || channel === IPC.usageRefresh) {
        throw new Error("local bound usage should not fall back to desktop usage IPC");
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

    expect(invoke).toHaveBeenCalledWith(IPC.localRuntimeCallAction, {
      rootPath: "/repo",
      request: { domain: "usage", action: "getUsageSnapshot" },
    });
    expect(invoke).toHaveBeenCalledWith(IPC.localRuntimeCallAction, {
      rootPath: "/repo",
      request: { domain: "usage", action: "forceRefresh" },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.usageGetSnapshot);
    expect(invoke).not.toHaveBeenCalledWith(IPC.usageRefresh);
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
    const scan = { detection: null };
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

  it("guards git conflict actions against malformed lane args", async () => {
    const result = { success: true };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding: null };
      }
      if (channel === IPC.gitRebaseContinue) return result;
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
    await expect(bridge.git.rebaseContinue(null)).rejects.toThrow("laneId is required.");
    await expect(bridge.git.mergeAbort({})).rejects.toThrow("laneId is required.");
    await expect(bridge.git.rebaseContinue(" lane-1 ")).resolves.toEqual(result);

    expect(invoke).toHaveBeenCalledWith(IPC.gitRebaseContinue, { laneId: "lane-1" });
    expect(invoke).not.toHaveBeenCalledWith(IPC.gitMergeAbort, expect.anything());
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
          status: "succeeded",
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
    await bridge.prs.preflightCreateLaneFromPrBranch({
      repoOwner: "owner",
      repoName: "repo",
      githubPrNumber: 12,
    });
    await bridge.prs.createLaneFromPrBranch({
      repoOwner: "owner",
      repoName: "repo",
      githubPrNumber: 12,
    });

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
      "pr.preflightCreateLaneFromPrBranch",
      "pr.createLaneFromPrBranch",
    ]);
    expect(invoke).not.toHaveBeenCalledWith(IPC.lanesCreate, expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(IPC.agentChatCreate, expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(IPC.gitCommit, expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(IPC.gitPush, expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(IPC.prsCreateFromLane, expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(IPC.prsPreflightCreateLaneFromPrBranch, expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(IPC.prsCreateLaneFromPrBranch, expect.anything());
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
    const autolinks = [{ id: 1, keyPrefix: "ADE-", urlTemplate: "https://example.test/<num>", isAlphanumeric: false }];
    const createdAutolink = { id: 2, keyPrefix: "ADEPR-", urlTemplate: "https://ade-app.dev/open?number=<num>", isAlphanumeric: false };
    const remoteStatus = { repo: { owner: "acme", name: "repo" }, hasOrigin: true };
    const myRepos = {
      repos: [{
        owner: "acme",
        name: "repo",
        fullName: "acme/repo",
        isPrivate: false,
        pushedAt: null,
        defaultBranch: "main",
        htmlUrl: "https://github.com/acme/repo",
        cloneUrl: "https://github.com/acme/repo.git",
        sshUrl: "git@github.com:acme/repo.git",
      }],
    };
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeListMyGitHubRepos) {
        return myRepos;
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
        if (request?.action === "listRepoAutolinks") {
          return {
            ok: true,
            domain: "github",
            action: "listRepoAutolinks",
            result: autolinks,
            statusHints: {},
          };
        }
        if (request?.action === "createRepoAutolink") {
          return {
            ok: true,
            domain: "github",
            action: "createRepoAutolink",
            result: createdAutolink,
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
    await expect(bridge.github.listRepoAutolinks({ owner: "acme", name: "repo" })).resolves.toEqual(autolinks);
    await expect(bridge.github.createRepoAutolink({
      owner: "acme",
      name: "repo",
      keyPrefix: "ADEPR-",
      urlTemplate: "https://ade-app.dev/open?number=<num>",
      isAlphanumeric: false,
    })).resolves.toEqual(createdAutolink);
    await expect(bridge.github.getRemoteStatus({ forceRefresh: true })).resolves.toEqual(remoteStatus);
    await expect(bridge.github.listMyRepos({ search: "repo" })).resolves.toEqual(myRepos);

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
        action: "listRepoAutolinks",
        args: { owner: "acme", name: "repo" },
      },
    });
    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: {
        domain: "github",
        action: "createRepoAutolink",
        args: {
          owner: "acme",
          name: "repo",
          keyPrefix: "ADEPR-",
          urlTemplate: "https://ade-app.dev/open?number=<num>",
          isAlphanumeric: false,
        },
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
    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeListMyGitHubRepos, {
      id: "target-1",
      input: { search: "repo" },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.githubListRepoLabels, { owner: "acme", name: "repo" });
    expect(invoke).not.toHaveBeenCalledWith(IPC.githubListRepoCollaborators, { owner: "acme", name: "repo" });
    expect(invoke).not.toHaveBeenCalledWith(IPC.githubListRepoAutolinks, { owner: "acme", name: "repo" });
    expect(invoke).not.toHaveBeenCalledWith(IPC.githubCreateRepoAutolink, expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(IPC.githubGetRemoteStatus, expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(IPC.githubListMyRepos, expect.anything());
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
	    const result = {
	      state: "pushed",
	      owner: "acme",
	      name: "repo",
	      fullName: "acme/repo",
	      htmlUrl: "https://github.com/acme/repo",
	    };
	    const input = { owner: "acme", name: "repo", isPrivate: true };
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

  it("does not fall back to local slash commands after a remote empty result", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Project",
    };
    const input = { laneId: "lane-1", provider: "codex" };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeCallAction) {
        return { ok: true, domain: "chat", action: "getSlashCommands", result: [], statusHints: {} };
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
    await expect(bridge.agentChat.slashCommands(input)).resolves.toEqual([]);

    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: {
        domain: "chat",
        action: "getSlashCommands",
        args: input,
      },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.agentChatSlashCommands, input);
  });

  it("routes CLI agent launches through a remote project runtime when bound", async () => {
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
      provider: "codex",
      model: "gpt-5.5",
      kickoffPrompt: "Work this issue",
      linearIssues: [{ id: "issue-1" }],
    };
    const result = {
      sessionId: "term-1",
      ptyId: "pty-1",
      pid: 123,
      attachedLinearIssueIds: ["issue-1"],
    };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeCallAction) {
        return { ok: true, domain: "chat", action: "launchCli", result, statusHints: {} };
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
    await expect(bridge.agentChat.launchCli(input)).resolves.toEqual(result);

    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: {
        domain: "chat",
        action: "launchCli",
        args: input,
      },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.agentChatLaunchCli, input);
  });

  it("does not fall back to a local PR lookup when remote open-in-GitHub misses", async () => {
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
      if (channel === IPC.remoteRuntimeCallAction) {
        return { ok: true, domain: "pr", action: "listAll", result: [], statusHints: {} };
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
    await expect(bridge.prs.openInGitHub("pr-404")).rejects.toThrow(/Remote PR pr-404/);

    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: {
        domain: "pr",
        action: "listAll",
        args: {},
      },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.prsOpenInGitHub, { prId: "pr-404" });
    expect(invoke).not.toHaveBeenCalledWith(IPC.appOpenExternal, expect.anything());
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

  it("routes PTY sendToSession through a remote project runtime when bound", async () => {
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
      sessionId: "session-1",
      text: "keep going",
      cols: 100,
      rows: 30,
    };
    const result = {
      ptyId: "pty-1",
      sessionId: "session-1",
      pid: 123,
      session: null,
      resumed: true,
      reusedExistingRuntime: true,
    };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeCallAction) {
        return { ok: true, domain: "pty", action: "sendToSession", result, statusHints: {} };
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
    await expect(bridge.pty.sendToSession(input)).resolves.toEqual(result);

    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: {
        domain: "pty",
        action: "sendToSession",
        args: input,
      },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.ptySendToSession, input);
  });

  it("routes PTY resumeSession through a remote project runtime when bound", async () => {
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
      sessionId: "session-1",
      cols: 100,
      rows: 30,
    };
    const result = {
      ptyId: "pty-1",
      sessionId: "session-1",
      pid: 123,
      session: null,
      resumed: true,
      reusedExistingRuntime: false,
    };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeCallAction) {
        return { ok: true, domain: "pty", action: "resumeSession", result, statusHints: {} };
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
    await expect(bridge.pty.resumeSession(input)).resolves.toEqual(result);

    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: {
        domain: "pty",
        action: "resumeSession",
        args: input,
      },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.ptyResumeSession, input);
  });

  it("routes App Control attachToTarget through the remote runtime with positional args", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Project",
    };
    const result = {
      id: "session-1",
      status: "connected",
      targetId: "target-2",
    };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeCallAction) {
        return {
          ok: true,
          domain: "app_control",
          action: "attachToTarget",
          result,
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
    await expect(bridge.appControl.attachToTarget({ targetId: "target-2" })).resolves.toEqual(result);

    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: {
        domain: "app_control",
        action: "attachToTarget",
        argsList: ["target-2"],
      },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.appControlAttachToTarget, expect.anything());
  });

  it("routes OpenCode diagnostics and Cursor Cloud stream subscriptions through a remote runtime", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Project",
    };
    const diagnostics = { version: 1, sessions: [] };
    const installed = { installed: true, source: "bundled" };
    const stream = { subscriptionId: "cursor-cloud-stream-agent-1-run-1" };
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeCallAction) {
        const request = (payload as { request?: { action?: string } }).request;
        if (request?.action === "getOpenCodeRuntimeDiagnostics") {
          return { ok: true, domain: "ai", action: request.action, result: diagnostics, statusHints: {} };
        }
        if (request?.action === "isOpenCodeInstalled") {
          return { ok: true, domain: "ai", action: request.action, result: installed, statusHints: {} };
        }
        if (request?.action === "cursorCloudStreamRun") {
          return { ok: true, domain: "ai", action: request.action, result: stream, statusHints: {} };
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
    await expect(bridge.ai.getOpenCodeRuntimeDiagnostics()).resolves.toEqual(diagnostics);
    await expect(bridge.ai.isOpenCodeInstalled()).resolves.toEqual(installed);
    await expect(bridge.ai.cursorCloudStreamRun({ agentId: "agent-1", runId: "run-1" })).resolves.toEqual(stream);

    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: { domain: "ai", action: "getOpenCodeRuntimeDiagnostics" },
    });
    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: { domain: "ai", action: "isOpenCodeInstalled" },
    });
    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: {
        domain: "ai",
        action: "cursorCloudStreamRun",
        args: { agentId: "agent-1", runId: "run-1" },
      },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.aiGetOpenCodeRuntimeDiagnostics);
    expect(invoke).not.toHaveBeenCalledWith(IPC.aiIsOpenCodeInstalled);
    expect(invoke).not.toHaveBeenCalledWith(IPC.aiCursorCloudStreamRun, expect.anything());
  });

  it("routes APNs settings reads through a bound remote runtime", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Project",
    };
    const status = {
      enabled: true,
      configured: true,
      keyStored: true,
      keyId: "KEY123",
      teamId: "TEAM123",
      bundleId: "com.ade.ios",
      env: "sandbox",
    };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding };
      }
      if (channel === IPC.remoteRuntimeCallAction) {
        return { ok: true, domain: "notifications_apns", action: "getStatus", result: status, statusHints: {} };
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
    await expect(bridge.notifications.apns.getStatus()).resolves.toEqual(status);
    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-1",
      request: {
        domain: "notifications_apns",
        action: "getStatus",
      },
    });
    expect(invoke).not.toHaveBeenCalledWith(IPC.notificationsApnsGetStatus);
  });

  it("fans out remote PTY data notifications from the live runtime event stream", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Project",
    };
    const ptyEvent = {
      ptyId: "pty-1",
      sessionId: "session-1",
      data: "hello from studio",
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
    const unsubscribe = bridge.pty.onData(callback);

    const runtimeListener = on.mock.calls.find(([channel]) => channel === IPC.runtimeEvent)?.[1];
    expect(typeof runtimeListener).toBe("function");
    runtimeListener({}, {
      bindingKey: binding.key,
      event: {
        id: 1,
        timestamp: "2026-05-10T12:00:01.000Z",
        category: "pty",
        payload: { type: "pty_data", event: ptyEvent },
      },
    });
    expect(callback).toHaveBeenCalledWith(ptyEvent);

    unsubscribe();
    runtimeListener({}, {
      bindingKey: binding.key,
      event: {
        id: 2,
        timestamp: "2026-05-10T12:00:02.000Z",
        category: "pty",
        payload: { type: "pty_data", event: { ...ptyEvent, data: "later" } },
      },
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("filters remote PTY data notifications to subscribed terminal ids", async () => {
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
    bridge.pty.onData(callback);
    await bridge.pty.setDataSubscriptions({ ptyIds: ["pty-visible"] });

    expect(invoke).toHaveBeenCalledWith(IPC.ptyDataSubscriptions, {
      ptyIds: ["pty-visible"],
    });

    const runtimeListener = on.mock.calls.find(([channel]) => channel === IPC.runtimeEvent)?.[1];
    expect(typeof runtimeListener).toBe("function");
    runtimeListener({}, {
      bindingKey: binding.key,
      event: {
        id: 1,
        timestamp: "2026-05-10T12:00:01.000Z",
        category: "pty",
        payload: {
          type: "pty_data",
          event: { ptyId: "pty-hidden", sessionId: "session-hidden", data: "hidden" },
        },
      },
    });
    runtimeListener({}, {
      bindingKey: binding.key,
      event: {
        id: 2,
        timestamp: "2026-05-10T12:00:02.000Z",
        category: "pty",
        payload: {
          type: "pty_data",
          event: { ptyId: "pty-visible", sessionId: "session-visible", data: "visible" },
        },
      },
    });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({
      ptyId: "pty-visible",
      sessionId: "session-visible",
      data: "visible",
    });
  });

  it("fans out remote runtime events for routed project utility domains", async () => {
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

    const usageUpdate = vi.fn();
    const automations = vi.fn();
    const conflicts = vi.fn();
    const rebase = vi.fn();
    const githubStatusChanged = vi.fn();
    const linearWorkflow = vi.fn();
    const feedback = vi.fn();
    const computerUse = vi.fn();
    const iosSimulator = vi.fn();
    const appControl = vi.fn();

    const unsubscribers = [
      bridge.usage.onUpdate(usageUpdate),
      bridge.automations.onEvent(automations),
      bridge.conflicts.onEvent(conflicts),
      bridge.rebase.onEvent(rebase),
      bridge.github.onStatusChanged(githubStatusChanged),
      bridge.cto.onLinearWorkflowEvent(linearWorkflow),
      bridge.feedback.onUpdate(feedback),
      bridge.computerUse.onEvent(computerUse),
      bridge.iosSimulator.onEvent(iosSimulator),
      bridge.appControl.onEvent(appControl),
    ];

    const runtimeListener = on.mock.calls.find(([channel]) => channel === IPC.runtimeEvent)?.[1];
    expect(typeof runtimeListener).toBe("function");
    const emit = (
      id: number,
      payload: Record<string, unknown>,
      category = "runtime",
    ) => {
      runtimeListener({}, {
        bindingKey: binding.key,
        event: {
          id,
          timestamp: `2026-05-10T12:00:${String(id).padStart(2, "0")}.000Z`,
          category,
          payload,
        },
      });
    };

    const usageSnapshot = { windows: [], pacing: {}, costs: [], extraUsage: [], lastPolledAt: "now", errors: [] };
    const automationEvent = { type: "runs-updated", automationId: "auto-1" };
    const conflictEvent = { type: "rebase-started", laneId: "lane-1", timestamp: "now" };
    const githubStatus = {
      tokenStored: true,
      patTokenStored: true,
      tokenDecryptionFailed: false,
      storageScope: "app",
      authSource: "pat",
      tokenType: "classic",
      repo: { owner: "acme", name: "repo" },
      hasOrigin: true,
      userLogin: "octocat",
      scopes: ["repo"],
      ghCliPath: null,
      ghAuthError: null,
      checkedAt: "now",
      repoAccessOk: true,
      repoAccessError: null,
      connected: true,
    };
    const linearWorkflowEvent = {
      type: "linear-workflow-ingress",
      projectId: "project-1",
      source: "manual",
      issueId: "issue-1",
      issueIdentifier: "ADE-1",
      summary: "Received Linear issue",
      createdAt: "now",
    };
    const feedbackEvent = { type: "feedback-submission-updated", submission: { id: "sub-1" } };
    const computerUseEvent = { type: "artifact-ingested", artifactId: "artifact-1", at: "now" };
    const iosEvent = { type: "session-updated", session: null };
    const appControlEvent = { type: "session-updated", session: null };

    emit(1, { type: "usage", snapshot: usageSnapshot });
    emit(3, { ...automationEvent, source: "automations" });
    emit(4, { type: "conflict_event", event: conflictEvent }, "dag_mutation");
    emit(5, { type: "github_status_changed", event: githubStatus });
    emit(6, { type: "linear_workflow_event", event: linearWorkflowEvent }, "orchestrator");
    emit(7, { type: "feedback_submission_event", event: feedbackEvent });
    emit(8, { type: "computer_use_event", event: computerUseEvent });
    emit(9, { type: "ios_simulator_event", event: iosEvent });
    emit(10, { type: "app_control_event", event: appControlEvent });

    expect(usageUpdate).toHaveBeenCalledWith(usageSnapshot);
    expect(automations).toHaveBeenCalledWith(automationEvent);
    expect(conflicts).toHaveBeenCalledWith(conflictEvent);
    expect(rebase).toHaveBeenCalledWith(conflictEvent);
    expect(githubStatusChanged).toHaveBeenCalledWith(githubStatus);
    expect(linearWorkflow).toHaveBeenCalledWith(linearWorkflowEvent);
    expect(feedback).toHaveBeenCalledWith(feedbackEvent);
    expect(computerUse).toHaveBeenCalledWith(computerUseEvent);
    expect(iosSimulator).toHaveBeenCalledWith(iosEvent);
    expect(appControl).toHaveBeenCalledWith(appControlEvent);

    for (const unsubscribe of unsubscribers) unsubscribe();
    emit(11, { type: "usage", snapshot: { ...usageSnapshot, lastPolledAt: "later" } });
    expect(usageUpdate).toHaveBeenCalledTimes(1);
  });

  it("starts remote runtime event subscriptions without replaying buffered history", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T12:00:00.000Z"));
    try {
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
        at: "2026-05-10T11:55:00.000Z",
        filePath: "/remote/project/.ade/ade.yaml",
      };
      const invoke = vi.fn(async (channel: string) => {
        if (channel === IPC.appGetWindowSession) {
          return { windowId: 1, project: null, binding };
        }
        if (channel === IPC.remoteRuntimeStreamEvents) {
          return {
            events: [],
            nextCursor: 0,
            hasMore: false,
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
      const callback = vi.fn();
      const unsubscribe = bridge.project.onStateEvent(callback);

      await vi.advanceTimersByTimeAsync(0);

      expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeStreamEvents, {
        id: "target-1",
        projectId: "project-1",
        request: { cursor: 0, limit: 100, replay: false },
      });
      expect(callback).not.toHaveBeenCalledWith(projectEvent);

      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off idle remote runtime event polling after empty batches", async () => {
    vi.useFakeTimers();
    try {
      const binding = {
        kind: "remote",
        key: "remote:target-1:project-1",
        targetId: "target-1",
        runtimeName: "Remote",
        projectId: "project-1",
        rootPath: "/remote/project",
        displayName: "Project",
      };
      const streamRequests: unknown[] = [];
      const invoke = vi.fn(async (channel: string, arg?: unknown) => {
        if (channel === IPC.appGetWindowSession) {
          return { windowId: 1, project: null, binding };
        }
        if (channel === IPC.remoteRuntimeStreamEvents) {
          streamRequests.push(arg);
          return {
            events: [],
            nextCursor: 0,
            hasMore: false,
            eventEpoch: "epoch-a",
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
      const unsubscribe = bridge.project.onStateEvent(vi.fn());

      await vi.advanceTimersByTimeAsync(0);
      expect(streamRequests).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(2_499);
      expect(streamRequests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(streamRequests).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(streamRequests).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(streamRequests).toHaveLength(3);

      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops remote event polling after disconnecting the active remote target", async () => {
    vi.useFakeTimers();
    try {
      const binding = {
        kind: "remote",
        key: "remote:target-1:project-1",
        targetId: "target-1",
        runtimeName: "Remote",
        projectId: "project-1",
        rootPath: "/remote/project",
        displayName: "Project",
      };
      const streamRequests: unknown[] = [];
      const invoke = vi.fn(async (channel: string, arg?: unknown) => {
        if (channel === IPC.appGetWindowSession) {
          return { windowId: 1, project: null, binding };
        }
        if (channel === IPC.remoteRuntimeStreamEvents) {
          streamRequests.push(arg);
          return {
            events: [],
            nextCursor: 0,
            hasMore: false,
            eventEpoch: "epoch-a",
          };
        }
        if (channel === IPC.remoteRuntimeDisconnect) {
          return { disconnected: true };
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
      const unsubscribe = bridge.project.onStateEvent(vi.fn());

      await vi.advanceTimersByTimeAsync(0);
      expect(streamRequests).toHaveLength(1);

      await expect(bridge.remoteRuntime.disconnect("target-1")).resolves.toEqual({
        disconnected: true,
      });
      expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeDisconnect, {
        id: "target-1",
        manual: true,
      });

      await vi.advanceTimersByTimeAsync(20_000);
      expect(streamRequests).toHaveLength(1);

      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops stale remote runtime catch-up when the project binding changes mid-poll", async () => {
    vi.useFakeTimers();
    try {
      const firstBinding = {
        kind: "remote",
        key: "remote:target-1:project-1",
        targetId: "target-1",
        runtimeName: "Remote",
        projectId: "project-1",
        rootPath: "/remote/project",
        displayName: "Project",
      };
      const secondBinding = {
        kind: "remote",
        key: "remote:target-2:project-2",
        targetId: "target-2",
        runtimeName: "Studio",
        projectId: "project-2",
        rootPath: "/studio/project",
        displayName: "Studio project",
      };
      let binding = firstBinding;
      let resolveFirstStream!: (value: {
        events: unknown[];
        nextCursor: number;
        hasMore: boolean;
        eventEpoch: string;
      }) => void;
      const firstStream = new Promise<{
        events: unknown[];
        nextCursor: number;
        hasMore: boolean;
        eventEpoch: string;
      }>((resolve) => {
        resolveFirstStream = resolve;
      });
      const projectEvent = {
        type: "config-changed",
        at: "2026-05-10T11:55:00.000Z",
        filePath: "/remote/project/.ade/ade.yaml",
      };
      const streamRequests: unknown[] = [];
      const invoke = vi.fn(async (channel: string, arg?: unknown) => {
        if (channel === IPC.appGetWindowSession) {
          return { windowId: 1, project: null, binding };
        }
        if (channel === IPC.remoteRuntimeStreamEvents) {
          streamRequests.push(arg);
          if (streamRequests.length === 1) return firstStream;
          return { events: [], nextCursor: 0, hasMore: false, eventEpoch: "epoch-2" };
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
      const callback = vi.fn();
      const unsubscribe = bridge.project.onStateEvent(callback);
      const unsubscribeBinding = bridge.app.onProjectBindingChanged(vi.fn());
      await vi.advanceTimersByTimeAsync(0);

      expect(streamRequests).toHaveLength(1);
      const bindingListener = on.mock.calls.find(
        ([channel]) => channel === IPC.appProjectBindingChanged,
      )?.[1];
      expect(typeof bindingListener).toBe("function");
      binding = secondBinding;
      bindingListener({}, secondBinding);
      resolveFirstStream({
        events: [
          {
            id: 1,
            timestamp: "2026-05-10T11:55:00.000Z",
            category: "runtime",
            payload: { type: "project_state_event", event: projectEvent },
          },
        ],
        nextCursor: 1,
        hasMore: false,
        eventEpoch: "epoch-1",
      });
      await vi.runOnlyPendingTimersAsync();

      expect(callback).not.toHaveBeenCalled();
      expect(streamRequests).toHaveLength(2);
      expect(streamRequests[1]).toEqual({
        id: "target-2",
        projectId: "project-2",
        request: { cursor: 0, limit: 100, replay: false },
      });

      unsubscribeBinding();
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the remote runtime event cursor when the runtime event epoch changes", async () => {
    vi.useFakeTimers();
    try {
      const binding = {
        kind: "remote",
        key: "remote:target-1:project-1",
        targetId: "target-1",
        runtimeName: "Remote",
        projectId: "project-1",
        rootPath: "/remote/project",
        displayName: "Project",
      };
      const oldEvent = {
        type: "config-changed",
        at: "2026-05-10T11:55:00.000Z",
        filePath: "/remote/project/.ade/ade.yaml",
      };
      const newEvent = {
        type: "config-changed",
        at: "2026-05-10T12:05:00.000Z",
        filePath: "/remote/project/.ade/local.yaml",
      };
      const streamRequests: unknown[] = [];
      const invoke = vi.fn(async (channel: string, arg?: unknown) => {
        if (channel === IPC.appGetWindowSession) {
          return { windowId: 1, project: null, binding };
        }
        if (channel === IPC.remoteRuntimeStreamEvents) {
          streamRequests.push(arg);
          if (streamRequests.length === 1) {
            return {
              events: [
                {
                  id: 12,
                  timestamp: "2026-05-10T11:55:00.000Z",
                  category: "runtime",
                  payload: { type: "project_state_event", event: oldEvent },
                },
              ],
              nextCursor: 12,
              hasMore: false,
              eventEpoch: "epoch-a",
            };
          }
          if (streamRequests.length === 2) {
            return {
              events: [],
              nextCursor: 12,
              hasMore: false,
              eventEpoch: "epoch-b",
            };
          }
          return {
            events: [
              {
                id: 1,
                timestamp: "2026-05-10T12:05:00.000Z",
                category: "runtime",
                payload: { type: "project_state_event", event: newEvent },
              },
            ],
            nextCursor: 1,
            hasMore: false,
            eventEpoch: "epoch-b",
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
      const callback = vi.fn();
      const unsubscribe = bridge.project.onStateEvent(callback);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(750);
      await vi.runOnlyPendingTimersAsync();

      expect(streamRequests).toEqual([
        {
          id: "target-1",
          projectId: "project-1",
          request: { cursor: 0, limit: 100, replay: false },
        },
        {
          id: "target-1",
          projectId: "project-1",
          request: { cursor: 12, limit: 100 },
        },
        {
          id: "target-1",
          projectId: "project-1",
          request: { cursor: 0, limit: 100, replay: false },
        },
      ]);
      expect(callback).toHaveBeenCalledWith(oldEvent);
      expect(callback).toHaveBeenCalledWith(newEvent);

      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets a stale nonzero cursor when a runtime first reports an event epoch", async () => {
    vi.useFakeTimers();
    try {
      const binding = {
        kind: "remote",
        key: "remote:target-1:project-1",
        targetId: "target-1",
        runtimeName: "Remote",
        projectId: "project-1",
        rootPath: "/remote/project",
        displayName: "Project",
      };
      const oldEvent = {
        type: "config-changed",
        at: "2026-05-10T11:55:00.000Z",
        filePath: "/remote/project/.ade/ade.yaml",
      };
      const newEvent = {
        type: "config-changed",
        at: "2026-05-10T12:05:00.000Z",
        filePath: "/remote/project/.ade/local.yaml",
      };
      const streamRequests: unknown[] = [];
      const invoke = vi.fn(async (channel: string, arg?: unknown) => {
        if (channel === IPC.appGetWindowSession) {
          return { windowId: 1, project: null, binding };
        }
        if (channel === IPC.remoteRuntimeStreamEvents) {
          streamRequests.push(arg);
          if (streamRequests.length === 1) {
            return {
              events: [
                {
                  id: 12,
                  timestamp: "2026-05-10T11:55:00.000Z",
                  category: "runtime",
                  payload: { type: "project_state_event", event: oldEvent },
                },
              ],
              nextCursor: 12,
              hasMore: false,
            };
          }
          if (streamRequests.length === 2) {
            return {
              events: [],
              nextCursor: 12,
              hasMore: false,
              eventEpoch: "epoch-a",
            };
          }
          return {
            events: [
              {
                id: 1,
                timestamp: "2026-05-10T12:05:00.000Z",
                category: "runtime",
                payload: { type: "project_state_event", event: newEvent },
              },
            ],
            nextCursor: 1,
            hasMore: false,
            eventEpoch: "epoch-a",
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
      const callback = vi.fn();
      const unsubscribe = bridge.project.onStateEvent(callback);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(750);
      await vi.runOnlyPendingTimersAsync();

      expect(streamRequests).toEqual([
        {
          id: "target-1",
          projectId: "project-1",
          request: { cursor: 0, limit: 100, replay: false },
        },
        {
          id: "target-1",
          projectId: "project-1",
          request: { cursor: 12, limit: 100 },
        },
        {
          id: "target-1",
          projectId: "project-1",
          request: { cursor: 0, limit: 100, replay: false },
        },
      ]);
      expect(callback).toHaveBeenCalledWith(oldEvent);
      expect(callback).toHaveBeenCalledWith(newEvent);

      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
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
    const sessionDelta = {
      sessionId: "session-1",
      laneId: "lane-1",
      startedAt: "2026-05-10T12:00:00.000Z",
      endedAt: null,
      headShaStart: null,
      headShaEnd: null,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      touchedFiles: [],
      failureLines: [],
      computedAt: "2026-05-10T12:00:00.000Z",
    };
    const prEvent = {
      type: "prs-updated",
      polledAt: "2026-05-10T12:00:00.000Z",
      prs: [],
    };
    const invoke = vi.fn(async (channel: string, arg?: { sessionId?: string }) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding: null };
      }
      if (channel === IPC.sessionsGetDelta) {
        return { ...sessionDelta, computedAt: `${sessionDelta.computedAt}:${arg?.sessionId ?? "unknown"}` };
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
    const cachedDelta = await bridge.sessions.getDelta("session-1");
    expect(cachedDelta.computedAt).toBe("2026-05-10T12:00:00.000Z:session-1");
    invoke.mockClear();

    const sessionListeners = on.mock.calls.filter(([channel]) => channel === IPC.sessionsChanged);
    const prListeners = on.mock.calls.filter(([channel]) => channel === IPC.prsEvent);
    expect(sessionListeners).toHaveLength(1);
    expect(prListeners).toHaveLength(1);

    const sessionListener = sessionListeners[0]![1];
    const prListener = prListeners[0]![1];
    sessionListener({}, sessionEvent);
    prListener({}, prEvent);
    await bridge.sessions.getDelta("session-1");

    expect(sessionCallbackA).toHaveBeenCalledWith(sessionEvent);
    expect(sessionCallbackB).toHaveBeenCalledWith(sessionEvent);
    expect(prCallbackA).toHaveBeenCalledWith(prEvent);
    expect(prCallbackB).toHaveBeenCalledWith(prEvent);
    expect(invoke).toHaveBeenCalledWith(IPC.sessionsGetDelta, { sessionId: "session-1" });

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

  it("blocks chat actions while a project switch is in flight", async () => {
    let resolveSwitch!: (project: unknown) => void;
    const switchPromise = new Promise((resolve) => {
      resolveSwitch = resolve;
    });
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.projectSwitchToPath) {
        return switchPromise;
      }
      if (channel === IPC.appGetWindowSession) {
        return {
          windowId: 1,
          project: { rootPath: "/old", displayName: "Old", baseRef: "main" },
          binding: {
            kind: "local",
            key: "local:/old",
            rootPath: "/old",
            displayName: "Old",
          },
        };
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
    const pendingSwitch = bridge.project.switchToPath("/next");
    await expect(
      bridge.agentChat.send({ sessionId: "session-1", text: "hello" }),
    ).rejects.toThrow(/Project is switching/i);

    expect(invoke).toHaveBeenCalledWith(IPC.projectSwitchToPath, { rootPath: "/next" });
    expect(invoke).not.toHaveBeenCalledWith(IPC.appGetWindowSession);
    expect(invoke).not.toHaveBeenCalledWith(IPC.agentChatSend, expect.anything());

    resolveSwitch({ rootPath: "/next", displayName: "Next", baseRef: "main" });
    await pendingSwitch;
  });

  it("blocks mutating local file actions while a project switch is in flight", async () => {
    let resolveSwitch!: (project: unknown) => void;
    const switchPromise = new Promise((resolve) => {
      resolveSwitch = resolve;
    });
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.projectSwitchToPath) {
        return switchPromise;
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
    const pendingSwitch = bridge.project.switchToPath("/next");

    await expect(
      bridge.files.writeText({ workspaceId: "primary", path: "src/app.ts", text: "next" }),
    ).rejects.toThrow(/Project is switching/i);

    expect(invoke).toHaveBeenCalledWith(IPC.projectSwitchToPath, { rootPath: "/next" });
    expect(invoke).not.toHaveBeenCalledWith(IPC.filesWriteText, expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(IPC.localRuntimeCallAction, expect.anything());

    resolveSwitch({ rootPath: "/next", displayName: "Next", baseRef: "main" });
    await pendingSwitch;
  });

  it("routes local runtime reads to the target project while a project switch is in flight", async () => {
    let resolveSwitch!: (project: unknown) => void;
    const switchPromise = new Promise((resolve) => {
      resolveSwitch = resolve;
    });
    const localRuntimeRoots: string[] = [];
    const localRuntimeRequests: Array<{ domain?: string; action?: string }> = [];
    const invoke = vi.fn(async (channel: string, arg?: unknown) => {
      if (channel === IPC.projectSwitchToPath) {
        return switchPromise;
      }
      if (channel === IPC.localRuntimeCallAction) {
        const request = arg as {
          rootPath?: string;
          request?: { domain?: string; action?: string };
        };
        localRuntimeRoots.push(request.rootPath ?? "");
        localRuntimeRequests.push({
          domain: request.request?.domain,
          action: request.request?.action,
        });
        return { result: [] };
      }
      if (channel === IPC.appGetWindowSession) {
        return {
          windowId: 1,
          project: { rootPath: "/old", displayName: "Old", baseRef: "main" },
          binding: {
            kind: "local",
            key: "local:/old",
            rootPath: "/old",
            displayName: "Old",
          },
        };
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
    const pendingSwitch = bridge.project.switchToPath("/next");

    await expect(bridge.lanes.list()).resolves.toEqual([]);
    await expect(bridge.iosSimulator.resolvePreviewMatch({ projectRoot: "/next" })).resolves.toEqual([]);
    expect(invoke).not.toHaveBeenCalledWith(IPC.lanesList, expect.anything());
    expect(localRuntimeRoots).toEqual(["/next", "/next"]);
    expect(localRuntimeRequests).toEqual([
      { domain: "lane", action: "list" },
      { domain: "ios_simulator", action: "resolvePreviewMatch" },
    ]);

    resolveSwitch({ rootPath: "/next", displayName: "Next", baseRef: "main" });
    await pendingSwitch;

    await expect(bridge.lanes.list()).resolves.toEqual([]);
    expect(localRuntimeRoots).toEqual(["/next", "/next", "/next"]);
  });

  it("rejects empty project switch paths before updating local runtime binding", async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.appGetWindowSession) {
        return {
          windowId: 1,
          project: { rootPath: "/old", displayName: "Old", baseRef: "main" },
          binding: {
            kind: "local",
            key: "local:/old",
            rootPath: "/old",
            displayName: "Old",
          },
        };
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
    await expect(bridge.project.switchToPath("   ")).rejects.toThrow(/required/i);

    expect(invoke).not.toHaveBeenCalledWith(IPC.projectSwitchToPath, expect.anything());
  });

  it("falls through read-only chat actions to IPC while a project switch is in flight", async () => {
    let resolveSwitch!: (project: unknown) => void;
    const switchPromise = new Promise((resolve) => {
      resolveSwitch = resolve;
    });
    const listResult = [{ id: "summary-1" }];
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.projectSwitchToPath) {
        return switchPromise;
      }
      if (channel === IPC.agentChatList) {
        return listResult;
      }
      if (channel === IPC.appGetWindowSession) {
        return {
          windowId: 1,
          project: { rootPath: "/old", displayName: "Old", baseRef: "main" },
          binding: {
            kind: "local",
            key: "local:/old",
            rootPath: "/old",
            displayName: "Old",
          },
        };
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
    const pendingSwitch = bridge.project.switchToPath("/next");
    // Read-only chat call must fall through to the IPC-backed read API
    // instead of rejecting because a project transition is in flight.
    await expect(
      bridge.agentChat.list({ laneId: "lane-1" }),
    ).resolves.toEqual(listResult);

    expect(invoke).toHaveBeenCalledWith(IPC.agentChatList, { laneId: "lane-1" });

    resolveSwitch({ rootPath: "/next", displayName: "Next", baseRef: "main" });
    await pendingSwitch;
  });
});

describe("preload openRepo binding", () => {
  beforeEach(() => {
    vi.resetModules();
    delete (globalThis as any).__adeBridge;
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("electron");
    delete (globalThis as any).__adeBridge;
  });

  it("restores the previous binding when openRepo is cancelled", async () => {
    const remoteRuntimeProjects: string[] = [];
    const invoke = vi.fn(async (channel: string, arg?: unknown) => {
      if (channel === IPC.projectOpenRepo) {
        return null;
      }
      if (channel === IPC.remoteRuntimeCallAction) {
        const request = (arg as { projectId?: string; request?: { domain?: string; action?: string } }).request;
        remoteRuntimeProjects.push((arg as { projectId?: string }).projectId ?? "");
        return {
          ok: true,
          domain: request?.domain,
          action: request?.action,
          result: [],
          statusHints: {},
        };
      }
      if (channel === IPC.appGetWindowSession) {
        return {
          windowId: 1,
          project: null,
          binding: {
            kind: "remote",
            key: "remote:target-1:project-1",
            targetId: "target-1",
            runtimeName: "Remote",
            projectId: "project-1",
            rootPath: "/remote/project",
            displayName: "Project",
          },
        };
      }
      throw new Error(`unexpected IPC: ${channel}`);
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((_name: string, value: unknown) => {
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
    await expect(bridge.project.openRepo()).resolves.toBeNull();
    await expect(bridge.lanes.list()).resolves.toEqual([]);
    expect(remoteRuntimeProjects).toEqual(["project-1", "project-1"]);
  });
});

describe("preload remote project binding", () => {
  beforeEach(() => {
    vi.resetModules();
    delete (globalThis as any).__adeBridge;
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("electron");
    delete (globalThis as any).__adeBridge;
  });

  it("keeps the latest remote project binding when openProject calls overlap", async () => {
    const bindingA = {
      kind: "remote",
      key: "remote:target-1:project-a",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-a",
      rootPath: "/remote/a",
      displayName: "Project A",
    };
    const bindingB = {
      kind: "remote",
      key: "remote:target-1:project-b",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-b",
      rootPath: "/remote/b",
      displayName: "Project B",
    };
    let resolveSlowOpen: (value: typeof bindingA) => void = () => {};
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding: null };
      }
      if (channel === IPC.remoteRuntimeOpenProject) {
        const projectId = (payload as { projectId?: string } | undefined)?.projectId;
        if (projectId === "project-a") {
          return await new Promise<typeof bindingA>((resolve) => {
            resolveSlowOpen = resolve as (value: typeof bindingA) => void;
          });
        }
        if (projectId === "project-b") {
          return bindingB;
        }
      }
      if (channel === IPC.remoteRuntimeCallSync) {
        return { ok: true };
      }
      if (channel === IPC.remoteRuntimeCallAction) {
        return { result: [{ id: "lane-b" }] };
      }
      throw new Error(`unexpected IPC: ${channel}`);
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((_name: string, value: unknown) => {
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

    const slowOpen = bridge.remoteRuntime.openProject("target-1", "project-a");
    await bridge.remoteRuntime.openProject("target-1", "project-b");
    await expect(bridge.lanes.list()).resolves.toEqual([{ id: "lane-b" }]);
    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallAction, {
      id: "target-1",
      projectId: "project-b",
      request: { domain: "lane", action: "list", args: {} },
    });
    resolveSlowOpen(bindingA);
    await slowOpen;

    await bridge.sync.getStatus();
    expect(invoke).toHaveBeenCalledWith(IPC.remoteRuntimeCallSync, {
      id: "target-1",
      projectId: "project-b",
      method: "sync.getStatus",
      params: {},
    });
  });

  it("waits for remote project open before routing read-only project calls", async () => {
    const binding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Remote",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Project",
    };
    let resolveOpen: (value: typeof binding) => void = () => {};
    const remoteRuntimeProjects: string[] = [];
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === IPC.appGetWindowSession) {
        return { windowId: 1, project: null, binding: null };
      }
      if (channel === IPC.remoteRuntimeOpenProject) {
        return await new Promise<typeof binding>((resolve) => {
          resolveOpen = resolve as (value: typeof binding) => void;
        });
      }
      if (channel === IPC.remoteRuntimeCallAction) {
        remoteRuntimeProjects.push(
          (payload as { projectId?: string } | undefined)?.projectId ?? "",
        );
        return { result: [{ id: "lane-remote" }] };
      }
      throw new Error(`unexpected IPC: ${channel}`);
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((_name: string, value: unknown) => {
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

    const pendingOpen = bridge.remoteRuntime.openProject("target-1", "project-1");
    const pendingLaneList = bridge.lanes.list();
    await Promise.resolve();

    expect(invoke).not.toHaveBeenCalledWith(
      IPC.remoteRuntimeCallAction,
      expect.anything(),
    );
    expect(invoke.mock.calls.some(([channel]) => channel === IPC.lanesList))
      .toBe(false);

    resolveOpen(binding);
    await pendingOpen;
    await expect(pendingLaneList).resolves.toEqual([{ id: "lane-remote" }]);
    expect(remoteRuntimeProjects).toEqual(["project-1"]);
  });

  it("blocks mutating sync calls while a remote project switch is in flight", async () => {
    let resolveOpen: (value: unknown) => void = () => {};
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
      if (channel === IPC.remoteRuntimeOpenProject) {
        return await new Promise((resolve) => {
          resolveOpen = resolve as (value: unknown) => void;
        });
      }
      throw new Error(`unexpected IPC: ${channel}`);
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((_name: string, value: unknown) => {
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

    const pendingOpen = bridge.remoteRuntime.openProject("target-1", "project-2");
    await expect(bridge.sync.setPin({ pin: "123456" })).rejects.toThrow(
      /Project is switching/i,
    );
    expect(invoke).not.toHaveBeenCalledWith(
      IPC.remoteRuntimeCallSync,
      expect.objectContaining({ method: "sync.setPin" }),
    );

    resolveOpen(binding);
    await pendingOpen;
  });

  it("blocks file mutations while a remote project switch is in flight", async () => {
    let resolveOpen: (value: unknown) => void = () => {};
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
      if (channel === IPC.remoteRuntimeOpenProject) {
        return await new Promise((resolve) => {
          resolveOpen = resolve as (value: unknown) => void;
        });
      }
      throw new Error(`unexpected IPC: ${channel}`);
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((_name: string, value: unknown) => {
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

    const pendingOpen = bridge.remoteRuntime.openProject("target-1", "project-2");
    await expect(
      bridge.files.writeText({
        workspaceId: "workspace-1",
        path: "README.md",
        text: "updated",
      }),
    ).rejects.toThrow(/Project is switching/i);
    expect(invoke).not.toHaveBeenCalledWith(
      IPC.remoteRuntimeCallAction,
      expect.objectContaining({
        request: expect.objectContaining({
          domain: "file",
          action: "writeWorkspaceText",
        }),
      }),
    );

    resolveOpen(binding);
    await pendingOpen;
  });

  it("blocks lane port lease allocation while a remote project switch is in flight", async () => {
    let resolveOpen: (value: unknown) => void = () => {};
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
      if (channel === IPC.remoteRuntimeOpenProject) {
        return await new Promise((resolve) => {
          resolveOpen = resolve as (value: unknown) => void;
        });
      }
      throw new Error(`unexpected IPC: ${channel}`);
    });
    const on = vi.fn();
    const removeListener = vi.fn();
    const exposeInMainWorld = vi.fn((_name: string, value: unknown) => {
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

    const pendingOpen = bridge.remoteRuntime.openProject("target-1", "project-2");
    await expect(bridge.lanes.portGetLease({ laneId: "lane-1", port: 5173 }))
      .rejects.toThrow(/Project is switching/i);
    expect(invoke).not.toHaveBeenCalledWith(
      IPC.remoteRuntimeCallAction,
      expect.objectContaining({
        request: expect.objectContaining({
          domain: "lane",
          action: "portGetLease",
        }),
      }),
    );

    resolveOpen(binding);
    await pendingOpen;
  });
});

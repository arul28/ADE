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
    await bridge.macosVm.createBase({ name: "default", ipsw: "latest" });
    await bridge.macosVm.startBase({ name: "default", openDisplay: true });
    await bridge.macosVm.stopBase({ name: "default" });
    await bridge.macosVm.markBaseReady({ name: "default" });
    await bridge.macosVm.deleteBase({ name: "default", force: true });
    await bridge.macosVm.provision({ laneId: "lane-1", mode: "create" });
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
    expect(invoke).toHaveBeenCalledWith(IPC.macosVmCreateBase, { name: "default", ipsw: "latest" });
    expect(invoke).toHaveBeenCalledWith(IPC.macosVmStartBase, { name: "default", openDisplay: true });
    expect(invoke).toHaveBeenCalledWith(IPC.macosVmStopBase, { name: "default" });
    expect(invoke).toHaveBeenCalledWith(IPC.macosVmMarkBaseReady, { name: "default" });
    expect(invoke).toHaveBeenCalledWith(IPC.macosVmDeleteBase, { name: "default", force: true });
    expect(invoke).toHaveBeenCalledWith(IPC.macosVmProvision, { laneId: "lane-1", mode: "create" });
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
      availableProviders: { claude: false, codex: false, cursor: false, droid: false },
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
});

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
});

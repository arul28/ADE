/* Shared jsdom scaffolding for the drawer tests. Not a test file. */
import { vi } from "vitest";
import type { MutableRefObject } from "react";
import type { AppleLaneDevice, IosSimulatorDeviceSettings, OpenProjectBinding } from "../../../../shared/types";
import type { AppleDrawerContext } from "./drawerContext";
import type { AppleDrawerActions } from "./useAppleDrawerActions";

export const DEVICE: AppleLaneDevice = {
  laneId: "lane-1",
  udid: "UDID-1",
  name: "iPhone 17 Pro",
  origin: "attached",
  family: "iphone",
  runtime: "iOS 26.2",
  createdAt: "2026-09-21T00:00:00.000Z",
  templateUdid: null,
};

export const SETTINGS: IosSimulatorDeviceSettings = {
  deviceUdid: "UDID-1",
  appearance: "light",
  contentSize: "medium",
  accessibility: {
    "increase-contrast": false,
    "reduce-motion": true,
    "reduce-transparency": false,
    "button-shapes": false,
    "bold-text": null,
    "invert-colors": false,
    grayscale: false,
    "voice-over": null,
  },
  location: null,
  statusBarOverridden: false,
  readAt: "2026-09-21T00:00:00.000Z",
};

/** A `window.ade` with every iosSimulator call resolved, and spies to assert on. */
export function installAdeMock(overrides: Record<string, unknown> = {}) {
  const iosSimulator: Record<string, ReturnType<typeof vi.fn>> = {
    getStatus: vi.fn(async () => ({ platform: "darwin", supported: true, tools: [], activeDevice: null, activeSession: null })),
    getDeviceSettings: vi.fn(async () => SETTINGS),
    getForegroundApp: vi.fn(async () => null),
    setAppearance: vi.fn(async () => SETTINGS),
    setContentSize: vi.fn(async () => SETTINGS),
    setAccessibilityOption: vi.fn(async () => SETTINGS),
    setLocation: vi.fn(async () => SETTINGS),
    clearLocation: vi.fn(async () => SETTINGS),
    setPermission: vi.fn(async () => ({ ok: true })),
    sendPushNotification: vi.fn(async () => ({ ok: true })),
    openUrl: vi.fn(async () => ({ ok: true })),
    relaunchApp: vi.fn(async () => ({ bundleId: "x", running: true, pid: 1, checkedAt: "" })),
    terminateApp: vi.fn(async () => ({ ok: true })),
    launch: vi.fn(async () => ({})),
    recordList: vi.fn(async () => []),
    recordStart: vi.fn(async () => ({})),
    recordStop: vi.fn(async () => null),
    recordDelete: vi.fn(async () => undefined),
    captureProofBundle: vi.fn(async () => ({})),
    listPreviewTargets: vi.fn(async () => []),
    renderPreview: vi.fn(async () => ({ ok: true, dataUrl: "data:image/png;base64,AAA", error: null })),
    renderCurrentPreview: vi.fn(async () => ({ ok: true, render: { dataUrl: "data:image/png;base64,BBB", error: null }, target: null, error: null })),
    ensurePreviewWorkspace: vi.fn(async () => ({ ok: true, error: null })),
    openPreviewWorkspace: vi.fn(async () => ({ ok: true, path: "/x" })),
    startEventLog: vi.fn(async () => ({ deviceUdid: "UDID-1", running: true, rows: [], cursor: 0, dropped: 0, lastError: null })),
    stopEventLog: vi.fn(async () => ({ deviceUdid: "UDID-1", running: false, rows: [], cursor: 0, dropped: 0, lastError: null })),
    getEventLog: vi.fn(async () => ({ deviceUdid: "UDID-1", running: true, rows: [], cursor: 0, dropped: 0, lastError: null })),
    ...(overrides.iosSimulator as Record<string, ReturnType<typeof vi.fn>> | undefined),
  };
  const files = {
    onChange: vi.fn(() => () => {}),
    listWorkspaces: vi.fn(async () => [{ id: "ws-1", laneId: "lane-1", kind: "worktree", name: "lane", rootPath: "/r", isReadOnlyByDefault: false }]),
    watchChanges: vi.fn(async () => undefined),
    stopWatching: vi.fn(async () => undefined),
    ...(overrides.files as Record<string, unknown> | undefined),
  };
  const app = {
    revealPath: vi.fn(async () => undefined),
    writeClipboardText: vi.fn(async () => undefined),
  };
  (window as unknown as { ade: unknown }).ade = { iosSimulator, files, app };
  return { iosSimulator, files, app };
}

export function makeActions(overrides: Partial<AppleDrawerActions> = {}): AppleDrawerActions {
  const act = vi.fn(async (work: () => Promise<unknown>) => {
    try {
      await work();
      return true;
    } catch {
      return false;
    }
  });
  return {
    settings: SETTINGS,
    pending: false,
    error: null,
    clearError: vi.fn(),
    reportError: vi.fn(),
    act,
    refresh: vi.fn(),
    disabled: false,
    ...overrides,
  };
}

export function makeCtx(overrides: Partial<AppleDrawerContext> = {}): AppleDrawerContext {
  const pinRef: MutableRefObject<OpenProjectBinding | null> = { current: null };
  return {
    scope: { laneId: "lane-1", deviceUdid: "UDID-1", chatSessionId: null },
    device: DEVICE,
    pinRef,
    visible: true,
    actions: makeActions(),
    foregroundApp: "com.acme.app",
    setForegroundApp: vi.fn(),
    ...overrides,
  };
}

/** Every switch/button/input/menu-trigger inside a section. */
export function controlsIn(section: HTMLElement): HTMLElement[] {
  return [...section.querySelectorAll<HTMLElement>("button, input")];
}

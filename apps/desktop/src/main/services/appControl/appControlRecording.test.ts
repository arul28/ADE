import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppControlSession } from "../../../shared/types/appControl";
import type { Logger } from "../logging/logger";
import {
  APP_CONTROL_RECORDING_NOT_RUNNING_CODE,
  appControlRecordingKey,
  createAppControlRecording,
  type AppControlWindowRecorder,
} from "./appControlRecording";
import { createAppControlScreencastRecorderHost } from "./appControlScreencastRecorderHost";

const roots: string[] = [];

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const session: AppControlSession = {
  id: "session-1",
  appKind: "electron",
  label: "ADE Test",
  projectRoot: "/repo",
  laneId: "lane-1",
  cwd: "/repo",
  command: "pnpm dev",
  pid: 42,
  terminalSessionId: null,
  terminalPtyId: null,
  cdpPort: 9222,
  cdpEndpoint: null,
  cdpTargetId: "target-1",
  provider: "cdp",
  driver: "cdp",
  chatSessionId: "chat-1",
  startedAt: "2026-09-25T00:00:00.000Z",
  connectedAt: "2026-09-25T00:00:01.000Z",
  status: "connected",
  lastError: null,
  lastObservationId: null,
  lastTraceEntryId: null,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((inner) => {
    resolve = inner;
  });
  return { promise, resolve };
}

function windowRecorder(startGate: { promise: Promise<void> }): AppControlWindowRecorder {
  return {
    readPermissions: vi.fn(async () => null),
    listWindowsForPid: vi.fn(async () => [{
      id: 7,
      title: "ADE Test",
      width: 800,
      height: 600,
      minimized: false,
    }]),
    start: vi.fn(async (_args: {
      key: string;
      windowId: number;
      fps: number;
      filePath: string;
      keepIdle: boolean;
    }) => {
      await startGate.promise;
    }),
    stop: vi.fn(async (_key: string) => ({
      filePath: "",
      durationMs: 0,
      wallDurationMs: 0,
      idleCutMs: 0,
    })),
    onInterrupted: vi.fn(() => () => undefined),
    dispose: vi.fn(),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("createAppControlRecording", () => {
  function harness(platform: NodeJS.Platform, recorder: AppControlWindowRecorder, screencast: ReturnType<typeof vi.fn> | null = null) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-app-control-recording-"));
    roots.push(root);
    let current: AppControlSession | null = { ...session };
    const recording = createAppControlRecording({
      logger,
      projectRoot: root,
      platform,
      emit: () => undefined,
      getSession: () => current,
      getLastFrame: () => null,
      resolveAppProcessId: async () => 42,
      windowRecorder: platform === "darwin" ? recorder : recorder,
      screencastRecorder: () => screencast as never,
    });
    return {
      recording,
      replaceSession: (next: AppControlSession | null) => {
        current = next;
      },
    };
  }

  it("joins a second start for the same lane onto the one engine start", async () => {
    const gate = deferred();
    const recorder = windowRecorder(gate);
    const { recording } = harness("darwin", recorder);
    const first = recording.startRecording("lane-1", {});
    const second = recording.startRecording("lane-1", { caption: "later" });
    await vi.waitFor(() => expect(recorder.start).toHaveBeenCalledTimes(1));
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(a.running).toBe(true);
    expect(b).toBe(a);
    expect(recorder.start).toHaveBeenCalledTimes(1);
  });

  it("discards an engine start whose lane was forgotten or whose session changed", async () => {
    const forgotten = deferred();
    const forgottenRecorder = windowRecorder(forgotten);
    const forgottenHarness = harness("darwin", forgottenRecorder);
    const forgottenStart = forgottenHarness.recording.startRecording("lane-1", {});
    await vi.waitFor(() => expect(forgottenRecorder.start).toHaveBeenCalledTimes(1));
    forgottenHarness.recording.forgetLane("lane-1");
    forgotten.resolve();
    await expect(forgottenStart).rejects.toMatchObject({ code: APP_CONTROL_RECORDING_NOT_RUNNING_CODE });
    expect(forgottenRecorder.stop).toHaveBeenCalledWith(appControlRecordingKey("lane-1"));

    const changed = deferred();
    const changedRecorder = windowRecorder(changed);
    const changedHarness = harness("darwin", changedRecorder);
    const changedStart = changedHarness.recording.startRecording("lane-1", {});
    await vi.waitFor(() => expect(changedRecorder.start).toHaveBeenCalledTimes(1));
    changedHarness.replaceSession({ ...session, id: "session-2" });
    changed.resolve();
    await expect(changedStart).rejects.toMatchObject({ code: APP_CONTROL_RECORDING_NOT_RUNNING_CODE });
    expect(changedRecorder.stop).toHaveBeenCalledWith(appControlRecordingKey("lane-1"));
  });

  it("records a Windows lane through the screencast engine, not the Mac window recorder", async () => {
    const recorder = windowRecorder(deferred());
    const backend = {
      start: vi.fn(async (args: { filePath: string }) => ({ filePath: args.filePath })),
      pushFrame: vi.fn(),
      stop: vi.fn(),
      cancel: vi.fn(),
    };
    const { recording } = harness("win32", recorder, backend as never);
    const status = await recording.startRecording("lane-1", {});
    expect(status.engine).toBe("screencast");
    expect(status.running).toBe(true);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(recorder.start).not.toHaveBeenCalled();
  });
});

const screencastWindows = vi.hoisted(() => ({
  list: [] as Array<{
    loadGate: { promise: Promise<void>; resolve: () => void };
    destroy: () => void;
  }>,
}));

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(function MockWindow(this: {
    loadGate: { promise: Promise<void>; resolve: () => void };
    webContents: { executeJavaScript: (source: string) => Promise<string | undefined>; once: () => void };
    loadURL: () => Promise<void>;
    isDestroyed: () => boolean;
    destroy: () => void;
  }) {
    let resolveLoad!: () => void;
    const loadGate = {
      promise: new Promise<void>((resolve) => {
        resolveLoad = resolve;
      }),
      resolve: () => resolveLoad(),
    };
    this.loadGate = loadGate;
    this.webContents = {
      executeJavaScript: async (source: string) => (String(source).includes("pickMime") ? "video/webm" : undefined),
      once: () => undefined,
    };
    this.loadURL = () => loadGate.promise;
    this.isDestroyed = () => false;
    this.destroy = () => undefined;
    screencastWindows.list.push(this);
  }),
}));

describe("createAppControlScreencastRecorderHost", () => {
  it("refuses a second start for a reserved key, and a cancel during start removes the file", async () => {
    const host = createAppControlScreencastRecorderHost({ logger });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-screencast-"));
    roots.push(dir);
    const filePath = path.join(dir, "take.webm");

    const first = host.start({ key: "app-control:lane-1", filePath, fps: 15, keepIdle: false });
    await vi.waitFor(() => expect(screencastWindows.list).toHaveLength(1));
    await expect(host.start({ key: "app-control:lane-1", filePath, fps: 15, keepIdle: false }))
      .rejects.toThrow(/already running/);
    expect(screencastWindows.list).toHaveLength(1);

    if (!host.cancel) throw new Error("recorder cancel missing");
    host.cancel("app-control:lane-1");
    const started = screencastWindows.list[0];
    if (!started) throw new Error("recorder window missing");
    started.loadGate.resolve();
    await expect(first).rejects.toThrow(/cancelled while it was starting/);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

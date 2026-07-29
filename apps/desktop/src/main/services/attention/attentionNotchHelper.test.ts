import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
const existsSyncMock = vi.fn((_filePath: unknown) => true);

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[], options: object) =>
    spawnMock(command, args, options),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: (filePath: unknown) => existsSyncMock(filePath),
  },
}));

import {
  AttentionNotchHelper,
  resolveAttentionNotchExecutablePath,
} from "./attentionNotchHelper";

function fakeChild(): ChildProcessWithoutNullStreams & EventEmitter {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & EventEmitter;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 42,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  });
  return child;
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("AttentionNotchHelper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
  });

  it("resolves packaged and development helper paths", () => {
    expect(resolveAttentionNotchExecutablePath({
      isPackaged: true,
      resourcesPath: "/Applications/ADE.app/Contents/Resources",
      appPath: "/repo/apps/desktop",
    })).toBe("/Applications/ADE.app/Contents/Resources/native/ade-attention-notch");
    expect(resolveAttentionNotchExecutablePath({
      isPackaged: false,
      resourcesPath: "/unused",
      appPath: "/repo/apps/desktop",
    })).toBe("/repo/apps/desktop/resources/native/ade-attention-notch");
  });

  it("publishes exact helper actions and rejects malformed output", () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const onOutput = vi.fn();
    const helper = new AttentionNotchHelper({
      executablePath: "/tmp/notch",
      logger,
      onOutput,
      platform: "darwin",
    });
    helper.updateSettings({
      enabled: true,
      revealMode: "hover",
      expandedPanelEnabled: true,
      preferredDisplayId: null,
      hideDetails: true,
      celebrationsEnabled: true,
      soundsEnabled: false,
    });
    child.emit("spawn");
    (child.stdout as PassThrough).write([
      JSON.stringify({
        type: "open",
        itemId: "agent-1",
        destination: { kind: "session", sessionId: "session-1" },
        deepLink: "ade://session/session-1",
      }),
      JSON.stringify({ type: "open_center" }),
      JSON.stringify({ type: "refresh" }),
      JSON.stringify({
        type: "settings",
        settings: {
          enabled: false,
          revealMode: "click",
          expandedPanelEnabled: false,
          preferredDisplayId: null,
          hideDetails: true,
          celebrationsEnabled: true,
          soundsEnabled: false,
        },
      }),
      JSON.stringify({
        type: "settings",
        settings: { enabled: false, revealMode: "telepathy" },
      }),
      "{\"type\":\"open\"}",
      "",
    ].join("\n"));

    expect(onOutput).toHaveBeenCalledTimes(4);
    expect(onOutput.mock.calls[0]?.[0]).toMatchObject({
      type: "open",
      itemId: "agent-1",
    });
    expect(onOutput.mock.calls.slice(1).map((call) => call[0]?.type)).toEqual([
      "open_center",
      "refresh",
      "settings",
    ]);
    expect(logger.warn).toHaveBeenCalledWith("attention.notch_helper_invalid_output");
    helper.dispose();
  });

  it("does not start on non-macOS or when the binary is missing", () => {
    const unsupported = new AttentionNotchHelper({
      executablePath: "/tmp/notch",
      logger,
      onOutput: vi.fn(),
      platform: "win32",
    });
    unsupported.updateSettings({
      enabled: true,
      revealMode: "hover",
      expandedPanelEnabled: true,
      preferredDisplayId: null,
      hideDetails: true,
      celebrationsEnabled: true,
      soundsEnabled: false,
    });
    expect(unsupported.start()).toBe(false);
    expect(unsupported.getHealth()).toMatchObject({
      state: "unsupported",
      recovery: null,
    });

    existsSyncMock.mockReturnValue(false);
    const missing = new AttentionNotchHelper({
      executablePath: "/tmp/notch",
      logger,
      onOutput: vi.fn(),
      platform: "darwin",
    });
    missing.updateSettings({
      enabled: true,
      revealMode: "hover",
      expandedPanelEnabled: true,
      preferredDisplayId: null,
      hideDetails: true,
      celebrationsEnabled: true,
      soundsEnabled: false,
    });
    expect(missing.start()).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(missing.getHealth()).toMatchObject({
      state: "missing",
      recovery: "reinstall_or_update",
    });
  });

  it("reports running surface, protocol incompatibility, and crash-loop recovery", () => {
    vi.useFakeTimers();
    try {
      const children = Array.from({ length: 5 }, () => fakeChild());
      children.forEach((child) => spawnMock.mockReturnValueOnce(child));
      const helper = new AttentionNotchHelper({
        executablePath: "/tmp/notch",
        logger,
        onOutput: vi.fn(),
        restartDelayMs: 10,
        platform: "darwin",
      });
      helper.updateSettings({
        enabled: true,
        revealMode: "hover",
        expandedPanelEnabled: true,
        preferredDisplayId: null,
        hideDetails: true,
        celebrationsEnabled: true,
        soundsEnabled: false,
      });
      children[0]?.emit("spawn");
      (children[0]?.stdout as PassThrough).write(
        `${JSON.stringify({ type: "surface", displayId: 1, surface: "physical_notch" })}\n`,
      );
      expect(helper.getHealth()).toMatchObject({
        state: "running",
        surface: "physical_notch",
      });
      (children[0]?.stdout as PassThrough).write(
        `${JSON.stringify({ type: "protocol_error", message: "unsupported contract" })}\n`,
      );
      expect(helper.getHealth()).toMatchObject({
        state: "protocol_error",
        recovery: "reinstall_or_update",
      });

      helper.retry();
      children[0]?.emit("close", 1, null);
      for (let index = 1; index < 4; index += 1) {
        vi.advanceTimersByTime(100);
        children[index]?.emit("close", 1, null);
      }
      expect(helper.getHealth()).toMatchObject({
        state: "crash_loop",
        recovery: "reinstall_or_update",
      });

      helper.retry();
      expect(spawnMock).toHaveBeenCalledTimes(5);
      helper.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed until enabled settings arrive, then sends settings before the cached snapshot", () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const helper = new AttentionNotchHelper({
      executablePath: "/tmp/notch",
      logger,
      onOutput: vi.fn(),
      platform: "darwin",
    });
    const snapshot = {
      contractVersion: 1 as const,
      revision: 1,
      generatedAt: "2026-07-28T12:00:00.000Z",
      items: [],
    };
    const lines: string[] = [];
    (child.stdin as PassThrough).setEncoding("utf8");
    child.stdin.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      lines.push(...text.trim().split("\n"));
    });

    helper.publishSnapshot(snapshot);

    expect(helper.start()).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();

    helper.updateSettings({
      enabled: true,
      revealMode: "hover",
      expandedPanelEnabled: true,
      preferredDisplayId: null,
      hideDetails: true,
      celebrationsEnabled: true,
      soundsEnabled: false,
    });
    expect(spawnMock).toHaveBeenCalledOnce();

    child.emit("spawn");

    expect(lines.map((line) => JSON.parse(line).type)).toEqual(["settings", "snapshot"]);
    expect(JSON.parse(lines[0] ?? "{}").settings).toMatchObject({
      enabled: true,
      hideDetails: true,
      soundsEnabled: false,
    });
    expect(JSON.parse(lines[1] ?? "{}").snapshot).toEqual(snapshot);
    helper.dispose();
  });

  it("keeps device-local disabled state from spawning on snapshot refresh", () => {
    const helper = new AttentionNotchHelper({
      executablePath: "/tmp/notch",
      logger,
      onOutput: vi.fn(),
      platform: "darwin",
    });
    helper.updateSettings({
      enabled: false,
      revealMode: "hover",
      expandedPanelEnabled: true,
      preferredDisplayId: null,
      hideDetails: false,
      celebrationsEnabled: true,
      soundsEnabled: false,
    });
    helper.publishSnapshot({
      contractVersion: 1,
      revision: 1,
      generatedAt: "2026-07-28T12:00:00.000Z",
      items: [],
    });

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("requests account refreshes only while the native notch is enabled", () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const onRefreshRequested = vi.fn();
      const helper = new AttentionNotchHelper({
        executablePath: "/tmp/notch",
        logger,
        onOutput: vi.fn(),
        onRefreshRequested,
        refreshIntervalMs: 1_000,
        platform: "darwin",
      });

      helper.updateSettings({
        enabled: true,
        revealMode: "hover",
        expandedPanelEnabled: true,
        preferredDisplayId: null,
        hideDetails: true,
        celebrationsEnabled: false,
        soundsEnabled: false,
      });
      child.emit("spawn");
      vi.advanceTimersByTime(2_100);
      expect(onRefreshRequested).toHaveBeenCalledTimes(2);

      helper.updateSettings({
        enabled: false,
        revealMode: "hover",
        expandedPanelEnabled: true,
        preferredDisplayId: null,
        hideDetails: true,
        celebrationsEnabled: false,
        soundsEnabled: false,
      });
      vi.advanceTimersByTime(2_000);
      expect(onRefreshRequested).toHaveBeenCalledTimes(2);
      helper.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts after a spawn error without leaving a refresh timer running", () => {
    vi.useFakeTimers();
    try {
      const failedChild = fakeChild();
      const restartedChild = fakeChild();
      spawnMock
        .mockReturnValueOnce(failedChild)
        .mockReturnValueOnce(restartedChild);
      const onRefreshRequested = vi.fn();
      const helper = new AttentionNotchHelper({
        executablePath: "/tmp/notch",
        logger,
        onOutput: vi.fn(),
        onRefreshRequested,
        refreshIntervalMs: 1_000,
        restartDelayMs: 100,
        platform: "darwin",
      });

      helper.updateSettings({
        enabled: true,
        revealMode: "hover",
        expandedPanelEnabled: true,
        preferredDisplayId: null,
        hideDetails: true,
        celebrationsEnabled: true,
        soundsEnabled: false,
      });
      helper.updateSettings({
        enabled: true,
        revealMode: "hover",
        expandedPanelEnabled: true,
        preferredDisplayId: null,
        hideDetails: false,
        celebrationsEnabled: true,
        soundsEnabled: false,
      });
      failedChild.emit("error", new Error("spawn ENOEXEC"));
      failedChild.emit("close", -2, null);
      vi.advanceTimersByTime(1_000);

      expect(onRefreshRequested).not.toHaveBeenCalled();
      expect(spawnMock).toHaveBeenCalledTimes(2);

      restartedChild.emit("spawn");
      vi.advanceTimersByTime(1_000);
      expect(onRefreshRequested).toHaveBeenCalledOnce();
      helper.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces rapid snapshots while native stdin is backpressured", () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const lines: string[] = [];
    (child.stdin as PassThrough).setEncoding("utf8");
    child.stdin.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      lines.push(...text.trim().split("\n"));
    });
    const originalWrite = child.stdin.write.bind(child.stdin);
    let writeCount = 0;
    vi.spyOn(child.stdin, "write").mockImplementation(((...args: Parameters<typeof child.stdin.write>) => {
      writeCount += 1;
      const accepted = originalWrite(...args);
      return writeCount === 2 ? false : accepted;
    }) as typeof child.stdin.write);

    const helper = new AttentionNotchHelper({
      executablePath: "/tmp/notch",
      logger,
      onOutput: vi.fn(),
      platform: "darwin",
    });
    helper.updateSettings({
      enabled: true,
      revealMode: "hover",
      expandedPanelEnabled: true,
      preferredDisplayId: null,
      hideDetails: true,
      celebrationsEnabled: false,
      soundsEnabled: false,
    });
    child.emit("spawn");

    for (const revision of [1, 2, 3]) {
      helper.publishSnapshot({
        contractVersion: 1,
        revision,
        generatedAt: `2026-07-28T12:00:0${revision}.000Z`,
        items: [],
      });
    }
    helper.updateSettings({
      enabled: true,
      revealMode: "hover",
      expandedPanelEnabled: true,
      preferredDisplayId: null,
      hideDetails: false,
      celebrationsEnabled: false,
      soundsEnabled: false,
    });
    helper.updateSettings({
      enabled: true,
      revealMode: "hover",
      expandedPanelEnabled: true,
      preferredDisplayId: null,
      hideDetails: true,
      celebrationsEnabled: false,
      soundsEnabled: false,
    });
    helper.setVisible(true);
    helper.setVisible(false);

    expect(lines.map((line) => JSON.parse(line).type)).toEqual(["settings", "snapshot"]);
    expect(JSON.parse(lines[1] ?? "{}").snapshot.revision).toBe(1);

    child.stdin.emit("drain");

    expect(lines.map((line) => JSON.parse(line).type)).toEqual([
      "settings",
      "snapshot",
      "snapshot",
      "settings",
      "visibility",
    ]);
    expect(JSON.parse(lines[2] ?? "{}").snapshot.revision).toBe(3);
    expect(JSON.parse(lines[3] ?? "{}").settings.hideDetails).toBe(true);
    expect(JSON.parse(lines[4] ?? "{}").visible).toBe(false);
    helper.dispose();
  });
});

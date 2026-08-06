import { EventEmitter } from "node:events";
import path from "node:path";
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
    })).toBe(path.join(
      "/Applications/ADE.app/Contents/Resources",
      "native",
      "ade-attention-notch",
    ));
    expect(resolveAttentionNotchExecutablePath({
      isPackaged: false,
      resourcesPath: "/unused",
      appPath: "/repo/apps/desktop",
    })).toBe(path.join(
      "/repo/apps/desktop",
      "resources",
      "native",
      "ade-attention-notch",
    ));
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
          revealMode: "always",
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

  it("reconciles refresh cadence across surface, screen, and enabled state", () => {
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
        idleRefreshIntervalMs: 4_000,
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
      vi.advanceTimersByTime(3_999);
      expect(onRefreshRequested).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onRefreshRequested).toHaveBeenCalledTimes(1);

      (child.stdout as PassThrough).write(
        `${JSON.stringify({ type: "surface", displayId: 1, surface: "menu_bar" })}\n`,
      );
      vi.advanceTimersByTime(999);
      expect(onRefreshRequested).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(onRefreshRequested).toHaveBeenCalledTimes(2);

      helper.setScreenAwake(false);
      vi.advanceTimersByTime(3_999);
      expect(onRefreshRequested).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1);
      expect(onRefreshRequested).toHaveBeenCalledTimes(3);

      helper.setScreenAwake(true);
      vi.advanceTimersByTime(1_000);
      expect(onRefreshRequested).toHaveBeenCalledTimes(4);

      helper.updateSettings({
        enabled: false,
        revealMode: "hover",
        expandedPanelEnabled: true,
        preferredDisplayId: null,
        hideDetails: true,
        celebrationsEnabled: false,
        soundsEnabled: false,
      });
      vi.advanceTimersByTime(8_000);
      expect(onRefreshRequested).toHaveBeenCalledTimes(4);
      helper.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts after a spawn error without retaining the previous surface or refresh timer", () => {
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
        idleRefreshIntervalMs: 4_000,
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
      failedChild.emit("spawn");
      (failedChild.stdout as PassThrough).write(
        `${JSON.stringify({ type: "surface", displayId: 1, surface: "menu_bar" })}\n`,
      );
      failedChild.emit("error", new Error("spawn ENOEXEC"));
      failedChild.emit("close", -2, null);
      expect(helper.getHealth()).toMatchObject({
        state: "starting",
        surface: null,
      });
      vi.advanceTimersByTime(1_000);

      expect(onRefreshRequested).not.toHaveBeenCalled();
      expect(spawnMock).toHaveBeenCalledTimes(2);

      restartedChild.emit("spawn");
      vi.advanceTimersByTime(1_000);
      expect(onRefreshRequested).not.toHaveBeenCalled();
      vi.advanceTimersByTime(3_000);
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
  const enabledSettings = {
    enabled: true as const,
    revealMode: "hover" as const,
    expandedPanelEnabled: true,
    preferredDisplayId: null,
    hideDetails: true,
    celebrationsEnabled: false,
    soundsEnabled: false,
  };

  const toast = {
    itemId: "agent-1",
    eventKind: "agent_needs_you" as const,
    treatment: "alert" as const,
    title: "Agent needs you",
    subtitle: "Approve the command",
    tone: null,
    durationMs: null,
  };

  // The router now writes up to 192KB; if this buffer were still 256KB a
  // legitimately large frame would be accepted and then silently dropped here.
  it("parses an output line far larger than the old 256KB buffer", () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const onOutput = vi.fn();
    const helper = new AttentionNotchHelper({
      executablePath: "/tmp/notch",
      logger,
      onOutput,
      platform: "darwin",
    });
    helper.updateSettings(enabledSettings);
    child.emit("spawn");

    const line = JSON.stringify({
      type: "protocol_error",
      message: "x".repeat(300 * 1024),
    });
    expect(Buffer.byteLength(line, "utf8")).toBeGreaterThan(256 * 1024);
    (child.stdout as PassThrough).write(`${line}\n`);

    expect(logger.warn).not.toHaveBeenCalledWith("attention.notch_helper_output_overflow");
    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput.mock.calls[0]?.[0]?.type).toBe("protocol_error");
    helper.dispose();
  });

  it("accepts the two new output types and ignores the retired presentation keys", () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const onOutput = vi.fn();
    const helper = new AttentionNotchHelper({
      executablePath: "/tmp/notch",
      logger,
      onOutput,
      platform: "darwin",
    });
    helper.updateSettings(enabledSettings);
    child.emit("spawn");

    (child.stdout as PassThrough).write([
      JSON.stringify({ type: "open_settings" }),
      JSON.stringify({
        type: "dismiss_item",
        itemId: "agent-1",
        destination: { kind: "session", sessionId: "session-1" },
      }),
      // A dismiss without an item is not routable and must be rejected.
      JSON.stringify({ type: "dismiss_item" }),
      JSON.stringify({
        type: "settings",
        settings: {
          enabled: true,
          revealMode: "always",
          expandedPanelEnabled: false,
          preferredDisplayId: null,
          hideDetails: true,
          celebrationsEnabled: true,
          soundsEnabled: false,
        },
      }),
      // A helper still emitting the retired keys — with any value at all —
      // must still land: they are no longer part of the contract, so they can
      // neither be validated nor be a reason to drop the whole message.
      JSON.stringify({
        type: "settings",
        settings: {
          enabled: true,
          revealMode: "always",
          expandedPanelEnabled: false,
          automaticRevealEnabled: false,
          tickerEnabled: "yes",
          preferredDisplayId: null,
          hideDetails: true,
          celebrationsEnabled: true,
          soundsEnabled: false,
        },
      }),
      "",
    ].join("\n"));

    expect(onOutput.mock.calls.map((call) => call[0]?.type)).toEqual([
      "open_settings",
      "dismiss_item",
      "settings",
      "settings",
    ]);
    expect(onOutput.mock.calls[1]?.[0]).toMatchObject({ itemId: "agent-1" });
    helper.dispose();
  });

  it("writes a toast only when the helper is already running", () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const lines: string[] = [];
    (child.stdin as PassThrough).setEncoding("utf8");
    child.stdin.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      lines.push(...text.trim().split("\n"));
    });
    const helper = new AttentionNotchHelper({
      executablePath: "/tmp/notch",
      logger,
      onOutput: vi.fn(),
      platform: "darwin",
    });

    // No child yet: a toast must never be the thing that starts the surface,
    // and must not be retained for replay.
    helper.publishToast(toast);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(lines).toEqual([]);

    helper.updateSettings(enabledSettings);
    child.emit("spawn");
    helper.publishToast(toast);

    const parsed = lines.map((line) => JSON.parse(line));
    expect(parsed.map((entry) => entry.type)).toEqual(["settings", "toast"]);
    expect(parsed[1]?.toast).toMatchObject({
      itemId: "agent-1",
      eventKind: "agent_needs_you",
      treatment: "alert",
    });
    helper.dispose();
  });

  it("never collapses two queued toasts into one", () => {
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
      return writeCount === 1 ? false : accepted;
    }) as typeof child.stdin.write);

    const helper = new AttentionNotchHelper({
      executablePath: "/tmp/notch",
      logger,
      onOutput: vi.fn(),
      platform: "darwin",
    });
    helper.updateSettings(enabledSettings);
    child.emit("spawn");

    helper.publishToast({ ...toast, itemId: "agent-1", title: "First" });
    helper.publishToast({ ...toast, itemId: "agent-2", title: "Second" });
    child.stdin.emit("drain");

    const toasts = lines
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "toast")
      .map((entry) => entry.toast.title);
    expect(toasts).toEqual(["First", "Second"]);
    helper.dispose();
  });
});

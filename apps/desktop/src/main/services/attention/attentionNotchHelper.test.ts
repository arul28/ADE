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
      "{\"type\":\"open\"}",
      "",
    ].join("\n"));

    expect(onOutput).toHaveBeenCalledOnce();
    expect(onOutput.mock.calls[0]?.[0]).toMatchObject({
      type: "open",
      itemId: "agent-1",
    });
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
      preferredDisplayId: null,
      hideDetails: true,
      celebrationsEnabled: true,
      soundsEnabled: false,
    });
    expect(unsupported.start()).toBe(false);

    existsSyncMock.mockReturnValue(false);
    const missing = new AttentionNotchHelper({
      executablePath: "/tmp/notch",
      logger,
      onOutput: vi.fn(),
      platform: "darwin",
    });
    missing.updateSettings({
      enabled: true,
      preferredDisplayId: null,
      hideDetails: true,
      celebrationsEnabled: true,
      soundsEnabled: false,
    });
    expect(missing.start()).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
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
});

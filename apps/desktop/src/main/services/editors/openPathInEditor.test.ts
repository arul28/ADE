import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { openLocalWorkspaceInEditor } from "./openPathInEditor";
import { resolveCliSpawnInvocation } from "../shared/processExecution";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { unref: () => void; kill: () => void };
  child.unref = vi.fn();
  child.kill = vi.fn();
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

describe("openLocalWorkspaceInEditor", () => {
  const originalPlatform = process.platform;
  const originalComSpec = process.env.ComSpec;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    if (originalComSpec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = originalComSpec;
    spawnMock.mockReset();
  });

  it("launches Windows editors through resolveCliSpawnInvocation instead of a bare spawn", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
    spawnMock.mockImplementation(() => fakeChild());

    await openLocalWorkspaceInEditor({
      target: "vscode",
      targetPath: "C:\\Users\\me\\Projects\\ade",
      openDefault: async () => {
        throw new Error("default opener should not run");
      },
      revealInFolder: () => {
        throw new Error("folder reveal should not run");
      },
    });

    const expected = resolveCliSpawnInvocation(
      "code",
      ["C:\\Users\\me\\Projects\\ade"],
      process.env,
      "win32",
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![0]).toBe(expected.command);
    expect(spawnMock.mock.calls[0]![1]).toEqual(expected.args);
    expect(spawnMock.mock.calls[0]![2]).toEqual(
      expect.objectContaining({
        windowsVerbatimArguments: expected.windowsVerbatimArguments,
        windowsHide: true,
        detached: true,
      }),
    );
    expect(expected.command).not.toBe("code");
  });
});

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, it, expect, vi } from "vitest";
import {
  APPLE_HELPER_UNAVAILABLE_CODE,
  createSimHelperClient,
  resolveSimHelperExecutablePath,
  simHelperExecutableCandidates,
  SimHelperError,
} from "./simHelperClient";

const noopLogger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
};

/**
 * A stand-in for the Swift helper: a child whose stdin this test can read and
 * whose stdout it can write. Everything below asserts on the NDJSON that
 * crosses that boundary, because that IS the contract.
 */
function fakeHelperProcess(): ChildProcess & { writeLine: (value: unknown) => void; lines: () => string[] } {
  const child = new EventEmitter() as ChildProcess & { writeLine: (value: unknown) => void; lines: () => string[] };
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const written: string[] = [];
  stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim()) written.push(line.trim());
    }
  });
  child.stdin = stdin as unknown as ChildProcess["stdin"];
  child.stdout = stdout as unknown as ChildProcess["stdout"];
  child.stderr = stderr as unknown as ChildProcess["stderr"];
  Object.assign(child, { pid: 5150, exitCode: null, signalCode: null });
  child.kill = (() => true) as ChildProcess["kill"];
  child.writeLine = (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`);
  child.lines = () => [...written];
  return child;
}

describe("simHelperClient binary resolution", () => {
  it("prefers the override, then the packaged drop, then a dev swift build", () => {
    const candidates = simHelperExecutableCandidates({
      resourcesPath: "/Applications/ADE.app/Contents/Resources",
      searchRoots: ["/repo/apps/desktop"],
      env: { ADE_SIM_HELPER_PATH: "/tmp/mine" },
    });

    expect(candidates[0]).toBe("/tmp/mine");
    expect(candidates[1]).toBe("/Applications/ADE.app/Contents/Resources/native/ade-sim-helper");
    expect(candidates).toContain("/repo/apps/desktop/resources/native/ade-sim-helper");
    // `npm run build:sim-helper` is not part of `dev`, so the raw swift build
    // product has to be reachable or the whole surface is dead in a checkout.
    expect(candidates).toContain("/repo/apps/desktop/native/ADESimHelper/.build/release/ADESimHelper");
  });

  it("answers a concrete absent path when nothing exists, so the error names a file", () => {
    const resolved = resolveSimHelperExecutablePath({
      resourcesPath: "/res",
      searchRoots: [],
      env: {},
      exists: () => false,
    });

    expect(resolved).toBe("/res/native/ade-sim-helper");
  });
});

describe("simHelperClient protocol", () => {
  it("correlates replies by id, not by arrival order", async () => {
    // One helper drives every simulator on the Mac, so two devices' replies
    // interleave. Correlating by order is the obvious way to hand device A's
    // accessibility tree to device B.
    const child = fakeHelperProcess();
    const client = createSimHelperClient({
      binaryPath: __filename,
      logger: noopLogger,
      platform: "darwin",
      spawnHelper: () => child,
    });

    try {
      const first = client.send({ type: "ax-describe", udid: "device-1" });
      const second = client.send({ type: "ax-describe", udid: "device-2" });
      await vi.waitFor(() => expect(child.lines()).toHaveLength(2));
      const ids = child.lines().map((line) => JSON.parse(line).id as string);

      // Answered in reverse.
      child.writeLine({ type: "ok", id: ids[1], tree: "second" });
      child.writeLine({ type: "ok", id: ids[0], tree: "first" });

      expect(await first).toMatchObject({ tree: "first" });
      expect(await second).toMatchObject({ tree: "second" });
    } finally {
      client.dispose();
    }
  });

  it("rejects with the helper's own code and message", async () => {
    const child = fakeHelperProcess();
    const client = createSimHelperClient({
      binaryPath: __filename,
      logger: noopLogger,
      platform: "darwin",
      spawnHelper: () => child,
    });

    try {
      const pending = client.send({ type: "touch", udid: "nope" });
      await vi.waitFor(() => expect(child.lines()).toHaveLength(1));
      const id = JSON.parse(child.lines()[0]).id as string;
      child.writeLine({ type: "error", id, code: "unknown-device", message: "No simulator with UDID nope." });

      await expect(pending).rejects.toMatchObject({ code: "unknown-device" });
      await expect(pending).rejects.toBeInstanceOf(SimHelperError);
    } finally {
      client.dispose();
    }
  });

  it("fans out unsolicited events and reports ready", async () => {
    const child = fakeHelperProcess();
    const client = createSimHelperClient({
      binaryPath: __filename,
      logger: noopLogger,
      platform: "darwin",
      spawnHelper: () => child,
    });
    const seen: string[] = [];
    client.onEvent((event) => seen.push(event.type));

    try {
      // A send is what starts the child; nothing subscribes to a dead process.
      void client.send({ type: "list-devices" }).catch(() => {});
      child.writeLine({ type: "ready", protocol: 1, pid: 5150 });
      await vi.waitFor(() => expect(client.isReady()).toBe(true));
      expect(client.protocolVersion()).toBe(1);

      // Unit 2C's record-* events have no request id and must still arrive.
      child.writeLine({ type: "record-stopped", udid: "device-1", path: "/tmp/a.mp4" });
      await vi.waitFor(() => expect(seen).toContain("record-stopped"));
      expect(seen).toContain("ready");
    } finally {
      client.dispose();
    }
  });

  it("fails every in-flight request when the helper dies", async () => {
    // A command whose helper died did not run. Resolving it after the restart
    // would report a tap that never landed.
    const child = fakeHelperProcess();
    const client = createSimHelperClient({
      binaryPath: __filename,
      logger: noopLogger,
      platform: "darwin",
      restartDelayMs: 10_000,
      spawnHelper: () => child,
    });

    try {
      const pending = client.send({ type: "ax-describe", udid: "device-1" });
      await vi.waitFor(() => expect(child.lines()).toHaveLength(1));
      child.emit("exit", 1, null);

      await expect(pending).rejects.toMatchObject({ code: APPLE_HELPER_UNAVAILABLE_CODE });
      expect(client.isReady()).toBe(false);
      expect(client.pid()).toBeNull();
    } finally {
      client.dispose();
    }
  });

  it("refuses off macOS instead of spawning anything", async () => {
    const spawnHelper = vi.fn();
    const client = createSimHelperClient({
      binaryPath: __filename,
      logger: noopLogger,
      platform: "win32",
      spawnHelper: spawnHelper as never,
    });

    try {
      await expect(client.send({ type: "list-devices" })).rejects.toMatchObject({
        code: APPLE_HELPER_UNAVAILABLE_CODE,
      });
      expect(spawnHelper).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  it("sends an in-band quit before any signal on dispose", async () => {
    const child = fakeHelperProcess();
    const client = createSimHelperClient({
      binaryPath: __filename,
      logger: noopLogger,
      platform: "darwin",
      spawnHelper: () => child,
    });
    void client.send({ type: "list-devices" }).catch(() => {});
    await vi.waitFor(() => expect(child.lines()).toHaveLength(1));

    client.dispose();

    await vi.waitFor(() => {
      expect(child.lines().map((line) => JSON.parse(line).type)).toContain("quit");
    });
  });
});

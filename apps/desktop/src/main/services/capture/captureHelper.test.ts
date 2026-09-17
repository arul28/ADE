import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Type-only: `node:fs` is mocked below, so the symlink test reaches for the
// real modules through `vi.importActual` and borrows only their types here.
import type * as NodeFs from "node:fs";
import type * as NodeOs from "node:os";
import type * as NodePath from "node:path";

const spawnMock = vi.fn();
const existsSyncMock = vi.fn((_filePath: unknown) => true);
/**
 * Typed by the shape the helper reads — `isFile()` and `size` — not by the
 * literal fixture, so the symlink test can hand it a real `fs.Stats`.
 */
const statSyncMock = vi.fn(
  (_filePath: unknown): { isFile: () => boolean; size: number } => ({ isFile: () => true, size: 12 }),
);
const readFileSyncMock = vi.fn((_filePath: unknown) => Buffer.from("PNGBYTES"));
const rmSyncMock = vi.fn();
/** Identity by default: no symlinks in the fixture paths the other tests use. */
const realpathSyncMock = vi.fn((filePath: unknown) => filePath as string);
const mkdirSyncMock = vi.fn();
const spawnSyncMock = vi.fn((_command: string, _args: string[], _options: object) => ({
  error: undefined,
  status: 0,
}));

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[], options: object) =>
    spawnMock(command, args, options),
  // The real `terminateChildProcessTree` is used, so its Windows branch needs a
  // `spawnSync` to reach for; the test asserts the `taskkill` it builds.
  spawnSync: (command: string, args: string[], options: object) =>
    spawnSyncMock(command, args, options),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: (filePath: unknown) => existsSyncMock(filePath),
    statSync: (filePath: unknown) => statSyncMock(filePath),
    readFileSync: (filePath: unknown) => readFileSyncMock(filePath),
    rmSync: (filePath: unknown, options: unknown) => rmSyncMock(filePath, options),
    realpathSync: (filePath: unknown) => realpathSyncMock(filePath),
    mkdirSync: (filePath: unknown, options: unknown) => mkdirSyncMock(filePath, options),
  },
}));

import { CaptureHelper } from "./captureHelper";

/**
 * The stream types are narrowed to `PassThrough` deliberately: the real
 * `stdout` is a `Readable`, which the test has to WRITE to in order to play the
 * helper's side of the protocol.
 */
type FakeChild = ChildProcessWithoutNullStreams & EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  });
  return child;
}

/** Mirrors `GRACEFUL_SHUTDOWN_MS` in the supervisor. */
const GRACE_MS = 500;

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function stdinLines(child: FakeChild): string[] {
  const written: string[] = [];
  child.stdin.on("data", (chunk: Buffer | string) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) written.push(line.trim());
    }
  });
  return written;
}

function createHelper(overrides: Partial<{
  onShot: ReturnType<typeof vi.fn>;
  onFailure: ReturnType<typeof vi.fn>;
  selfPid: number;
}> = {}) {
  const onShot = overrides.onShot ?? vi.fn();
  const onFailure = overrides.onFailure ?? vi.fn();
  const helper = new CaptureHelper({
    executablePath: "/tmp/ade-capture-helper",
    outputDirectory: "/tmp/ade-capture",
    logger,
    onShot,
    onFailure,
    platform: "darwin",
    selfPid: overrides.selfPid ?? 999,
    chordCooldownMs: 0,
  });
  return { helper, onShot, onFailure };
}

describe("CaptureHelper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({ isFile: () => true, size: 12 });
    readFileSyncMock.mockReturnValue(Buffer.from("PNGBYTES"));
    realpathSyncMock.mockImplementation((filePath: unknown) => filePath as string);
  });

  it("does not spawn until the setting turns it on", () => {
    const { helper } = createHelper();
    expect(helper.start()).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();

    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    helper.updateSettings({ enabled: true });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][2]).toMatchObject({ windowsHide: true });
    expect(spawnMock.mock.calls[0][2].env.ADE_CAPTURE_OUTPUT_DIR).toBe("/tmp/ade-capture");
  });

  it("refuses to run on a platform with no helper", () => {
    const helper = new CaptureHelper({
      executablePath: "/tmp/ade-capture-helper",
      outputDirectory: "/tmp/ade-capture",
      logger,
      onShot: vi.fn(),
      onFailure: vi.fn(),
      platform: "linux",
    });
    helper.updateSettings({ enabled: true });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(helper.getHealth().state).toBe("unsupported");
  });

  it("turns a chord into a capture request and delivers the shot", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const { helper, onShot } = createHelper({ selfPid: 4242 });
    helper.updateSettings({ enabled: true });
    child.emit("spawn");
    const written = stdinLines(child);

    child.stdout.write('{"type":"chord"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(written).toContain('{"type":"capture"}');

    child.stdout.write(JSON.stringify({
      type: "captured",
      path: "/tmp/ade-capture/capture-1.png",
      appName: "ADE",
      windowTitle: "ADE — lanes",
      ownerPid: 4242,
      bounds: { x: 1, y: 2, width: 3, height: 4 },
    }) + "\n");
    await new Promise((resolve) => setImmediate(resolve));

    expect(onShot).toHaveBeenCalledTimes(1);
    const shot = onShot.mock.calls[0][0];
    expect(shot.pngBase64).toBe(Buffer.from("PNGBYTES").toString("base64"));
    expect(shot.source).toBe("chord");
    // The helper's pid matched this process's, so the renderer is told to add
    // its structured view state alongside the image.
    expect(shot.isAdeWindow).toBe(true);
    expect(shot.bounds).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    // The transport file is deleted as it is read; the staged attachment is the
    // durable copy.
    expect(rmSyncMock).toHaveBeenCalledWith("/tmp/ade-capture/capture-1.png", { force: true });
  });

  it("marks a foreign window as not ADE's", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const { helper, onShot } = createHelper({ selfPid: 999 });
    helper.updateSettings({ enabled: true });
    child.emit("spawn");
    // The helper never emits `captured` unsolicited — it answers a request.
    child.stdout.write('{"type":"chord"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write(JSON.stringify({
      type: "captured",
      path: "/tmp/ade-capture/capture-2.png",
      ownerPid: 31337,
    }) + "\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(onShot.mock.calls[0][0].isAdeWindow).toBe(false);
  });

  it("refuses a capture file written outside the directory it was given", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const { helper, onShot, onFailure } = createHelper();
    helper.updateSettings({ enabled: true });
    child.emit("spawn");
    // The helper never emits `captured` unsolicited — it answers a request.
    child.stdout.write('{"type":"chord"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write('{"type":"captured","path":"/etc/passwd"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onShot).not.toHaveBeenCalled();
    expect(readFileSyncMock).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0].reason).toBe("capture-failed");
  });

  /**
   * The lexical jail check clears the NAME. A symlink planted inside the
   * capture directory has a name that passes and a target anywhere on disk, so
   * the read has to be re-checked against the path the filesystem will open.
   *
   * Driven against the REAL filesystem — a real symlink, a real
   * `fs.realpathSync` — because a mocked one would only prove the test's own
   * idea of what a symlink is.
   */
  it("refuses a symlink inside the capture directory that points outside it", async () => {
    const realFs = await vi.importActual<typeof NodeFs>("node:fs");
    const realOs = await vi.importActual<typeof NodeOs>("node:os");
    const realPath = await vi.importActual<typeof NodePath>("node:path");

    const root = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), "ade-capture-symlink-"));
    const outsideDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), "ade-capture-secret-"));
    const secret = realPath.join(outsideDir, "secret.png");
    realFs.writeFileSync(secret, "SECRETBYTES");
    const planted = realPath.join(root, "capture-1.png");
    realFs.symlinkSync(secret, planted);
    const honest = realPath.join(root, "capture-2.png");
    realFs.writeFileSync(honest, "PNGBYTES");

    // Real fs for everything the delivery path touches, so nothing about the
    // escape is simulated.
    realpathSyncMock.mockImplementation((filePath: unknown) => realFs.realpathSync(filePath as string));
    statSyncMock.mockImplementation((filePath: unknown) => realFs.statSync(filePath as string));
    readFileSyncMock.mockImplementation((filePath: unknown) => realFs.readFileSync(filePath as string));

    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const onShot = vi.fn();
    const onFailure = vi.fn();
    const helper = new CaptureHelper({
      executablePath: "/tmp/ade-capture-helper",
      outputDirectory: root,
      logger,
      onShot,
      onFailure,
      platform: "darwin",
      chordCooldownMs: 0,
    });
    helper.updateSettings({ enabled: true });
    child.emit("spawn");

    child.stdout.write('{"type":"chord"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write(JSON.stringify({ type: "captured", path: planted }) + "\n");
    await new Promise((resolve) => setImmediate(resolve));

    expect(onShot).not.toHaveBeenCalled();
    expect(readFileSyncMock).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0].reason).toBe("capture-failed");
    // The file it pointed at is still there: refusing is not deleting.
    expect(realFs.existsSync(secret)).toBe(true);

    // ...and an ordinary file in the same directory is still read.
    child.stdout.write('{"type":"chord"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write(JSON.stringify({ type: "captured", path: honest }) + "\n");
    await new Promise((resolve) => setImmediate(resolve));

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onShot).toHaveBeenCalledTimes(1);
    expect(onShot.mock.calls[0][0].pngBase64).toBe(Buffer.from("PNGBYTES").toString("base64"));

    realFs.rmSync(root, { recursive: true, force: true });
    realFs.rmSync(outsideDir, { recursive: true, force: true });
  });

  /**
   * Windows spells the same directory several ways — drive-letter case, `/`
   * versus `\\` — so the jail check has to fold case. It only does so when it
   * is told the platform: leaving `isPathInside` to default to
   * `process.platform` meant this test exercised the HOST's rules, and a
   * perfectly good Windows capture would have been rejected in production
   * with nothing failing here.
   */
  it("accepts a win32 capture path that differs only by case and separator", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const onShot = vi.fn();
    const onFailure = vi.fn();
    const helper = new CaptureHelper({
      executablePath: "C:\\ADE\\ade-capture-helper.exe",
      outputDirectory: "C:\\Users\\Sam\\AppData\\Local\\Temp\\ade-capture-stable",
      logger,
      onShot,
      onFailure,
      platform: "win32",
      chordCooldownMs: 0,
    });
    helper.updateSettings({ enabled: true });
    child.emit("spawn");
    child.stdout.write('{"type":"chord"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write(JSON.stringify({
      type: "captured",
      path: "c:/users/sam/appdata/local/temp/ade-capture-stable/capture-1.png",
    }) + "\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(onFailure).not.toHaveBeenCalled();
    expect(onShot).toHaveBeenCalledTimes(1);

    // ...and a sibling directory that merely shares a prefix is still refused.
    child.stdout.write('{"type":"chord"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write(JSON.stringify({
      type: "captured",
      path: "c:\\users\\sam\\appdata\\local\\temp\\ade-capture-stable-old\\x.png",
    }) + "\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(onShot).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("surfaces a permission refusal and keeps reporting it in health", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const { helper, onFailure } = createHelper();
    helper.updateSettings({ enabled: true });
    child.emit("spawn");
    child.stdout.write('{"type":"permission-denied"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onFailure.mock.calls[0][0].reason).toBe("permission-denied");
    expect(helper.getHealth().state).toBe("permission_denied");
    // Retry clears the sticky refusal so a user who granted the permission is
    // not stuck reading a stale error.
    expect(helper.retry().state).toBe("running");
  });

  it("ignores a chord while a capture is already in flight", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const { helper } = createHelper();
    helper.updateSettings({ enabled: true });
    child.emit("spawn");
    const written = stdinLines(child);
    child.stdout.write('{"type":"chord"}\n{"type":"chord"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(written.filter((line) => line === '{"type":"capture"}')).toHaveLength(1);
  });

  it("refuses captureNow when the gesture is off and says why", () => {
    const { helper, onFailure } = createHelper();
    expect(helper.captureNow()).toBe(false);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0].source).toBe("command");
  });

  it("shuts down in band, because Windows has no deliverable SIGTERM", () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const { helper } = createHelper();
    helper.updateSettings({ enabled: true });
    child.emit("spawn");
    const written = stdinLines(child);
    helper.dispose();
    expect(written).toContain('{"type":"quit"}');
    // The kill is a backstop on a timer, not the mechanism — nothing is killed
    // synchronously.
    expect(child.kill).not.toHaveBeenCalled();
    expect(rmSyncMock).toHaveBeenCalledWith("/tmp/ade-capture", { recursive: true, force: true });
  });

  /**
   * The helper shells out to `/usr/sbin/screencapture` per shot, so killing the
   * supervisor alone orphans whatever it was waiting on. Reaching that
   * grandchild needs two halves and neither works without the other: the child
   * is spawned `detached` so its pid IS a process group id, and the kill
   * signals the NEGATIVE pid so the whole group goes.
   */
  it("spawns the helper as its own process group leader on POSIX", () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const { helper } = createHelper();
    helper.updateSettings({ enabled: true });
    expect(spawnMock.mock.calls[0][2]).toMatchObject({ detached: true, windowsHide: true });
  });

  it("signals the whole process group on POSIX, not just the supervisor", async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    try {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const { helper } = createHelper();
      helper.updateSettings({ enabled: true });
      child.emit("spawn");
      helper.dispose();

      // Grace window first: the in-band quit is the mechanism, the signal is
      // the backstop.
      expect(killSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(GRACE_MS + 1);
      expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
      expect(child.kill).not.toHaveBeenCalled();

      // ...escalating to SIGKILL across the same window if it is still there.
      await vi.advanceTimersByTimeAsync(GRACE_MS + 1);
      expect(killSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  /**
   * Windows has no process groups at all — `child.kill()` is a
   * `TerminateProcess` on the leader alone — so the same backstop has to reach
   * the tree through `taskkill /T /F` instead. One helper, two mechanisms.
   */
  it("still kills the tree through taskkill on Windows", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const { helper } = createHelper();
      helper.updateSettings({ enabled: true });
      child.emit("spawn");
      child.stdin.write = () => {
        throw new Error("EPIPE");
      };
      helper.dispose();

      const [command, args] = spawnSyncMock.mock.calls[0] as unknown as [string, string[]];
      expect(command.toLowerCase()).toContain("taskkill");
      expect(args).toEqual(["/PID", "4242", "/T", "/F"]);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("kills the group immediately when the quit message cannot be written", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    try {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const { helper } = createHelper();
      helper.updateSettings({ enabled: true });
      child.emit("spawn");
      // A wedged or already-broken pipe: there is no orderly path left.
      child.stdin.write = () => {
        throw new Error("EPIPE");
      };
      helper.dispose();
      expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("stops the child when the setting is turned off", () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const { helper } = createHelper();
    helper.updateSettings({ enabled: true });
    child.emit("spawn");
    const written = stdinLines(child);
    helper.updateSettings({ enabled: false });
    expect(written).toContain('{"type":"quit"}');
    expect(helper.getHealth().state).toBe("disabled");
  });

  /**
   * `stopChild()` gives the old child a grace window before the forced kill,
   * so a toggle off and straight back on has the NEW child spawned and healthy
   * when the old one finally closes. An unguarded close handler then cleared
   * the new child's readiness and scheduled a restart for a live process.
   */
  it("ignores a superseded child closing after a quick off/on toggle", async () => {
    const first = fakeChild();
    const second = fakeChild();
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const { helper, onShot } = createHelper();
    helper.updateSettings({ enabled: true });
    first.emit("spawn");
    helper.updateSettings({ enabled: false });
    helper.updateSettings({ enabled: true });
    second.emit("spawn");
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(helper.getHealth().state).toBe("running");

    // The first child only now notices it was asked to quit.
    first.emit("close", 0, null);
    expect(helper.getHealth().state).toBe("running");

    // ...and the live child still delivers.
    second.stdout.write('{"type":"chord"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    second.stdout.write('{"type":"captured","path":"/tmp/ade-capture/ok.png"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onShot).toHaveBeenCalledTimes(1);
  });

  /**
   * A `captured` line that arrives after the 8 s timeout already reported a
   * failure must not also deliver a shot: the user has been told it did not
   * happen, and the file is deleted rather than left for the dispose purge.
   */
  it("drops a capture answer that arrives after its own timeout", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const { helper, onShot, onFailure } = createHelper();
      helper.updateSettings({ enabled: true });
      child.emit("spawn");
      child.stdout.write('{"type":"chord"}\n');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(onFailure).toHaveBeenCalledTimes(1);

      child.stdout.write('{"type":"captured","path":"/tmp/ade-capture/late.png"}\n');
      await vi.advanceTimersByTimeAsync(0);
      expect(onShot).not.toHaveBeenCalled();
      expect(rmSyncMock).toHaveBeenCalledWith("/tmp/ade-capture/late.png", { force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a missing binary rather than spawning it", () => {
    existsSyncMock.mockReturnValue(false);
    const { helper } = createHelper();
    helper.updateSettings({ enabled: true });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(helper.getHealth().state).toBe("missing");
  });

  it("drops junk lines without taking down the stream", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const { helper, onShot } = createHelper();
    helper.updateSettings({ enabled: true });
    child.emit("spawn");
    // The helper never emits `captured` unsolicited — it answers a request.
    child.stdout.write('{"type":"chord"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write('not json\n{"type":"captured","path":"/tmp/ade-capture/ok.png"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.warn).toHaveBeenCalledWith("capture.helper_invalid_output");
    expect(onShot).toHaveBeenCalledTimes(1);
  });
});

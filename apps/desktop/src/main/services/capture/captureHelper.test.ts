import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
const existsSyncMock = vi.fn((_filePath: unknown) => true);
const statSyncMock = vi.fn((_filePath: unknown) => ({ isFile: () => true, size: 12 }));
const readFileSyncMock = vi.fn((_filePath: unknown) => Buffer.from("PNGBYTES"));
const rmSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[], options: object) =>
    spawnMock(command, args, options),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: (filePath: unknown) => existsSyncMock(filePath),
    statSync: (filePath: unknown) => statSyncMock(filePath),
    readFileSync: (filePath: unknown) => readFileSyncMock(filePath),
    rmSync: (filePath: unknown, options: unknown) => rmSyncMock(filePath, options),
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
    child.stdout.write('{"type":"captured","path":"/etc/passwd"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onShot).not.toHaveBeenCalled();
    expect(readFileSyncMock).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0].reason).toBe("capture-failed");
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
    child.stdout.write('not json\n{"type":"captured","path":"/tmp/ade-capture/ok.png"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.warn).toHaveBeenCalledWith("capture.helper_invalid_output");
    expect(onShot).toHaveBeenCalledTimes(1);
  });
});

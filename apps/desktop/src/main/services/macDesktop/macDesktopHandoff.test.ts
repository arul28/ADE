import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAC_DESKTOP_DRIVER_UNAVAILABLE_CODE } from "../../../shared/types/macDesktop";
import { createMacDesktopHandoff, type MacDesktopHandoffDeps } from "./macDesktopHandoff";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const handoffNow = 1_800_000_000_000;
const handoffMaxAgeMs = 15 * 60_000;
let tempDir: string | null = null;
let liveChild: ChildProcess | null = null;

afterEach(async () => {
  vi.useRealTimers();
  if (liveChild && liveChild.exitCode === null && liveChild.signalCode === null) {
    const exited = once(liveChild, "exit");
    liveChild.kill("SIGTERM");
    await exited;
  }
  liveChild = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function handoffPath(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mac-desktop-handoff-test-"));
  return path.join(tempDir, "handoff.json");
}

function app(pid: number, laneId = "lane-a", handedOffAt = handoffNow) {
  return {
    laneId,
    pid,
    handedOffAt,
    appName: `pid ${pid}`,
    bundleId: null,
    launchedAt: null,
    launched: false,
    windows: [],
  };
}

function lane(laneId = "lane-a") {
  return { laneId, width: 1280, height: 720 };
}

function writeHandoff(file: string, apps: ReturnType<typeof app>[], lanes = [lane()]): void {
  fs.writeFileSync(file, JSON.stringify({ apps, lanes }), "utf8");
}

function makeHandoff(
  file: string,
  now: () => number,
  overrides: Partial<MacDesktopHandoffDeps> = {},
) {
  const deps: MacDesktopHandoffDeps = {
    logger,
    now,
    handoffPath: file,
    isDisposed: () => false,
    hasDisplay: vi.fn(() => true),
    startLane: vi.fn(async () => undefined),
    adopt: vi.fn(async () => true),
    ...overrides,
  };
  return { handoff: createMacDesktopHandoff(deps), deps };
}

async function startLiveProcess(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  liveChild = child;
  return child;
}

function assertDeadPid(pid: number): void {
  let error: NodeJS.ErrnoException | null = null;
  try {
    process.kill(pid, 0);
  } catch (caught) {
    error = caught as NodeJS.ErrnoException;
  }
  expect(error?.code).toBe("ESRCH");
}

describe("createMacDesktopHandoff", () => {
  it("lets only one scheduled instance claim and restore a shared file", async () => {
    const file = handoffPath();
    const child = await startLiveProcess();
    const now = () => handoffNow;
    const adopt = vi.fn<MacDesktopHandoffDeps["adopt"]>(async () => true);
    writeHandoff(file, [app(process.pid), app(child.pid)]);
    const first = makeHandoff(file, now, { adopt });
    const second = makeHandoff(file, now, { adopt });
    vi.useFakeTimers();

    first.handoff.schedule(1_000);
    second.handoff.schedule(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(adopt).toHaveBeenCalledTimes(2);
    expect(adopt.mock.calls.map(([restored]) => restored.pid).sort((a, b) => a - b))
      .toEqual([process.pid, child.pid].sort((a, b) => a - b));
    expect(fs.existsSync(file)).toBe(false);
    first.handoff.dispose();
    second.handoff.dispose();
  });

  it("merges a transient requeue with another writer and preserves per-app expiry", async () => {
    const file = handoffPath();
    const child = await startLiveProcess();
    const deadPid = 2_147_483_647;
    assertDeadPid(deadPid);
    let nowMs = handoffNow;
    const originalHandedOffAt = handoffNow - 5_000;
    let firstAttempt = true;
    const adopt = vi.fn<MacDesktopHandoffDeps["adopt"]>(async () => {
      if (firstAttempt) {
        firstAttempt = false;
        writeHandoff(file, [
          app(child.pid, "lane-b", nowMs),
          app(deadPid, "lane-expired", nowMs - handoffMaxAgeMs - 1),
        ], [lane("lane-b"), lane("lane-expired")]);
        throw Object.assign(new Error("driver disappeared"), { code: MAC_DESKTOP_DRIVER_UNAVAILABLE_CODE });
      }
      return true;
    });
    writeHandoff(file, [app(process.pid, "lane-a", originalHandedOffAt)]);
    const { handoff } = makeHandoff(file, () => nowMs, { adopt });
    vi.useFakeTimers();

    handoff.schedule(0);
    await vi.advanceTimersByTimeAsync(0);

    const requeued = JSON.parse(fs.readFileSync(file, "utf8")) as { apps: Array<{ pid: number; handedOffAt: number }>; lanes: Array<{ laneId: string }> };
    expect(requeued.apps.map((entry) => entry.pid).sort((a, b) => a - b)).toEqual([process.pid, child.pid].sort((a, b) => a - b));
    expect(requeued.apps.find((entry) => entry.pid === process.pid)?.handedOffAt).toBe(originalHandedOffAt);
    expect(requeued.apps.some((entry) => entry.pid === deadPid)).toBe(false);
    expect(requeued.lanes.map((entry) => entry.laneId).sort()).toEqual(["lane-a", "lane-b"]);

    adopt.mockImplementation(async () => true);
    handoff.schedule(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(adopt).toHaveBeenCalledTimes(3);
    expect(adopt.mock.calls.slice(1).map(([restored]) => restored.pid).sort((a, b) => a - b))
      .toEqual([process.pid, child.pid].sort((a, b) => a - b));
    expect(fs.existsSync(file)).toBe(false);
    handoff.dispose();
  });

  it("cancels pre-stop apps while allowing a later handoff for the same lane", async () => {
    const file = handoffPath();
    let nowMs = handoffNow;
    const startLane = vi.fn(async () => undefined);
    const adopt = vi.fn<MacDesktopHandoffDeps["adopt"]>(async () => true);
    const { handoff } = makeHandoff(file, () => nowMs, {
      hasDisplay: vi.fn(() => false),
      startLane,
      adopt,
    });
    vi.useFakeTimers();
    handoff.cancelLane("lane-a");

    writeHandoff(file, [app(process.pid, "lane-a", handoffNow - 1)]);
    handoff.schedule(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(startLane).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);

    nowMs = handoffNow + 1;
    writeHandoff(file, [app(process.pid, "lane-a", nowMs)]);
    handoff.schedule(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(startLane).toHaveBeenCalledWith("lane-a", { width: 1280, height: 720 });
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(adopt.mock.calls[0][0].handedOffAt).toBe(nowMs);
    handoff.dispose();
  });

  it("checks for the handoff file when the scheduled timer fires", async () => {
    const file = handoffPath();
    const adopt = vi.fn<MacDesktopHandoffDeps["adopt"]>(async () => true);
    const { handoff } = makeHandoff(file, () => handoffNow, { adopt });
    vi.useFakeTimers();

    handoff.schedule(2_000);
    await vi.advanceTimersByTimeAsync(1_000);
    writeHandoff(file, [app(process.pid)]);
    expect(adopt).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(adopt.mock.calls[0][0].pid).toBe(process.pid);
    expect(fs.existsSync(file)).toBe(false);
    handoff.dispose();
  });
});

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { IosSimulatorEventPayload } from "../../../shared/types";
import { createAppleRuntimeManager, type AppleRuntimeManagerDeps } from "./appleRuntimeManager";

const SDKS = JSON.stringify([{ platform: "iphonesimulator", platformVersion: "27.1" }]);

type FakeChild = ChildProcess & { killed: boolean };

/** A stand-in `xcodebuild -downloadPlatform`: it runs until killed or closed by the test. */
function fakeDownload(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter() as never;
  child.stderr = new EventEmitter() as never;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return true;
  }) as never;
  return child;
}

/**
 * One project's manager. Only the process boundary is faked: `xcodebuild` and
 * `simctl` answers (`run`), the download child (`spawn`) and the free space.
 */
function managerFor(options: {
  run?: AppleRuntimeManagerDeps["run"];
  spawned: FakeChild[];
  events?: IosSimulatorEventPayload[];
}) {
  const run: AppleRuntimeManagerDeps["run"] = options.run ?? (async (command, args) => {
    if (command === "xcodebuild" && args[0] === "-showsdks") return { stdout: SDKS, stderr: "" };
    return { stdout: "{}", stderr: "" };
  });
  return createAppleRuntimeManager({
    run,
    spawn: () => {
      const child = fakeDownload();
      options.spawned.push(child);
      return child;
    },
    emit: (event) => options.events?.push(event),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    freeBytes: async () => 100 * 1024 ** 3,
    laneHeldUdids: () => new Set(),
    isAdeSimulator: () => false,
    powerOff: async () => undefined,
    invalidate: () => undefined,
    releasesFeed: async () => "",
    store: null,
    arch: "arm64",
  });
}

const managers: Array<ReturnType<typeof createAppleRuntimeManager>> = [];
afterEach(() => {
  // The install is machine-wide: every manager a test made goes, so the next
  // test starts with no install running.
  for (const manager of managers.splice(0)) manager.dispose();
});

describe("appleRuntimeManager: one runtime download per machine", () => {
  it("shares one download across projects, keeps it while any is open, and stops it with the last", async () => {
    const spawned: FakeChild[] = [];
    const secondEvents: IosSimulatorEventPayload[] = [];
    const first = managerFor({ spawned });
    const second = managerFor({ spawned, events: secondEvents });
    managers.push(first, second);

    const started = await first.runtimeInstall();
    expect(started.phase).toBe("preparing");
    // The other project neither starts its own download nor misses this one.
    const again = await second.runtimeInstall();
    expect(again.phase).toBe("preparing");
    expect(spawned).toHaveLength(1);
    expect(secondEvents.some((event) => event.type === "apple.runtime.install" && event.install.phase === "preparing")).toBe(true);

    first.dispose();
    managers.splice(managers.indexOf(first), 1);
    expect(spawned[0]!.killed).toBe(false);

    second.dispose();
    managers.splice(managers.indexOf(second), 1);
    expect(spawned[0]!.killed).toBe(true);
    // A project opened afterwards sees no download it would have to wait on.
    const reopened = managerFor({ spawned });
    managers.push(reopened);
    expect((await reopened.runtimeInstallCancel())?.phase).not.toBe("downloading");
    expect((await reopened.runtimeInstall()).phase).toBe("preparing");
    expect(spawned).toHaveLength(2);
  });

  it("starts exactly one download when a cancel lands while the first install is still checking", async () => {
    const spawned: FakeChild[] = [];
    // The first install's SDK read hangs until the test lets it go.
    let releaseFirstRead: (() => void) | null = null;
    let reads = 0;
    const run: AppleRuntimeManagerDeps["run"] = async (command, args) => {
      if (command === "xcodebuild" && args[0] === "-showsdks") {
        reads += 1;
        if (reads === 1) await new Promise<void>((resolve) => { releaseFirstRead = resolve; });
        return { stdout: SDKS, stderr: "" };
      }
      return { stdout: "{}", stderr: "" };
    };
    const manager = managerFor({ run, spawned });
    managers.push(manager);

    const first = manager.runtimeInstall();
    await vi.waitFor(() => expect(releaseFirstRead).not.toBeNull());
    expect((await manager.runtimeInstallCancel())?.phase).toBe("cancelled");
    const second = await manager.runtimeInstall();
    expect(second.phase).toBe("preparing");

    // The first call wakes to a cancel and a newer install: it stands down.
    releaseFirstRead!();
    expect((await first).phase).toBe("preparing");
    expect(spawned).toHaveLength(1);
  });
});

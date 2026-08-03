import childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDroidSpawnsAreWindowless, resetDroidSpawnPatchForTests } from "./droidSdkWindowsHide";

const originalSpawn = childProcess.spawn;
const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

afterEach(() => {
  resetDroidSpawnPatchForTests(originalSpawn);
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
});

describe("ensureDroidSpawnsAreWindowless", () => {
  it("defaults windowsHide for droid spawns on win32", () => {
    setPlatform("win32");
    const seen: unknown[][] = [];
    (childProcess as { spawn: unknown }).spawn = (...args: unknown[]) => {
      seen.push(args);
      return {} as unknown;
    };
    ensureDroidSpawnsAreWindowless();

    childProcess.spawn("C:\\Users\\dev\\bin\\droid.exe", ["exec"], { stdio: "pipe" } as never);
    childProcess.spawn("droid", ["exec"] as never);
    childProcess.spawn("git", ["status"], { stdio: "pipe" } as never);

    expect((seen[0]?.[2] as { windowsHide?: boolean }).windowsHide).toBe(true);
    expect((seen[1]?.[2] as { windowsHide?: boolean }).windowsHide).toBe(true);
    // Untouched: only the droid executable is matched.
    expect((seen[2]?.[2] as { windowsHide?: boolean }).windowsHide).toBeUndefined();
  });

  it("never overrides an explicit windowsHide", () => {
    setPlatform("win32");
    const seen: unknown[][] = [];
    (childProcess as { spawn: unknown }).spawn = (...args: unknown[]) => {
      seen.push(args);
      return {} as unknown;
    };
    ensureDroidSpawnsAreWindowless();

    childProcess.spawn("droid.exe", ["exec"], { windowsHide: false } as never);

    expect((seen[0]?.[2] as { windowsHide?: boolean }).windowsHide).toBe(false);
  });

  it("is a no-op off win32", () => {
    setPlatform("darwin");
    const spy = vi.fn();
    (childProcess as { spawn: unknown }).spawn = spy;
    ensureDroidSpawnsAreWindowless();
    expect(childProcess.spawn).toBe(spy);
  });
});

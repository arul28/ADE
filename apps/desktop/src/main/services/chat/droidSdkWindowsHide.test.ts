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

/** Replaces spawn with a recorder, then installs the droid patch over it. */
function patchOverRecorder(): unknown[][] {
  const seen: unknown[][] = [];
  (childProcess as { spawn: unknown }).spawn = (...args: unknown[]) => {
    seen.push(args);
    return {} as unknown;
  };
  ensureDroidSpawnsAreWindowless();
  return seen;
}

const optionsOf = (call: unknown[] | undefined) => call?.[2] as { windowsHide?: boolean } | undefined;

describe("ensureDroidSpawnsAreWindowless", () => {
  it("defaults windowsHide for droid spawns on win32 and never overrides an explicit one", () => {
    setPlatform("win32");
    const seen = patchOverRecorder();

    childProcess.spawn("C:\\Users\\dev\\bin\\droid.exe", ["exec"], { stdio: "pipe" } as never);
    childProcess.spawn("droid", ["exec"] as never);
    childProcess.spawn("git", ["status"], { stdio: "pipe" } as never);
    childProcess.spawn("droid.exe", ["exec"], { windowsHide: false } as never);

    expect(optionsOf(seen[0])?.windowsHide).toBe(true);
    // A real .exe keeps the SDK's own argv; nothing is wrapped.
    expect(seen[0]?.[0]).toBe("C:\\Users\\dev\\bin\\droid.exe");
    expect(seen[0]?.[1]).toEqual(["exec"]);
    expect(optionsOf(seen[1])?.windowsHide).toBe(true);
    // Untouched: only the droid executable is matched.
    expect(optionsOf(seen[2])?.windowsHide).toBeUndefined();
    expect(seen[2]?.[0]).toBe("git");
    expect(optionsOf(seen[3])?.windowsHide).toBe(false);
  });

  // @factory/droid-sdk's ProcessTransport calls spawn(execPath, args) with no
  // shell. Node has refused bare .cmd/.bat spawns since CVE-2024-27980, so a
  // shim-only install died with `spawn ... EINVAL errno:-4071` before the
  // session produced a single message. The exact cmd/PowerShell argv is
  // resolveCliSpawnInvocation's contract (processExecution.test.ts).
  it("routes .cmd and .ps1 shims through their shell so the shell-less SDK spawn can succeed", () => {
    setPlatform("win32");
    const previousComSpec = process.env.ComSpec;
    process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
    const seen = patchOverRecorder();
    try {
      childProcess.spawn(
        "C:\\Users\\dev\\AppData\\Roaming\\npm\\droid.cmd",
        ["--session-id", "abc"],
        { stdio: "pipe" } as never,
      );
      childProcess.spawn("C:\\shims\\droid.ps1", ["--session-id", "abc"] as never);
    } finally {
      if (previousComSpec == null) delete process.env.ComSpec;
      else process.env.ComSpec = previousComSpec;
    }

    expect(seen[0]?.[0]).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(seen[0]?.[1]).toEqual(expect.arrayContaining(["/c"]));
    expect(seen[0]?.[2]).toMatchObject({
      stdio: "pipe",
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    expect(String(seen[1]?.[0]).toLowerCase()).toMatch(/powershell\.exe$/);
    expect(seen[1]?.[1]).toEqual(expect.arrayContaining(["-File", "C:\\shims\\droid.ps1", "--session-id", "abc"]));
    expect(optionsOf(seen[1])?.windowsHide).toBe(true);
  });

  it("is a no-op off win32", () => {
    setPlatform("darwin");
    const spy = vi.fn();
    (childProcess as { spawn: unknown }).spawn = spy;
    ensureDroidSpawnsAreWindowless();
    expect(childProcess.spawn).toBe(spy);
  });
});

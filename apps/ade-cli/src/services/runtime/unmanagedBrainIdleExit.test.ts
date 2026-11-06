import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UNMANAGED_BRAIN_IDLE_EXIT_MS, isOrphanedProcess, unmanagedBrainIdleExitMs, type UnmanagedBrainFacts } from "./unmanagedBrainIdleExit";

// A brain that idles out takes its lanes' emulators with it. Wrong on the
// managed side, it kills the installed brain under the user; wrong on the
// other, a test brain sits for days holding gigabytes (2026-11-06).
const scratchHome = path.join(os.tmpdir(), "ade-test-home-1234");
const base: UnmanagedBrainFacts = {
  env: { XPC_SERVICE_NAME: "0" },
  platform: "darwin",
  adeHome: scratchHome,
  serviceName: "com.ade.runtime",
  windowsSupervised: null,
};

describe("unmanagedBrainIdleExitMs", () => {
  it.each<[string, Partial<UnmanagedBrainFacts>, number | null]>([
    ["a test brain on a scratch home", {}, UNMANAGED_BRAIN_IDLE_EXIT_MS],
    ["the installed app's home, whoever started it", { adeHome: path.join(os.homedir(), ".ade") }, null],
    ["the Alpha channel's home", { adeHome: path.join(os.homedir(), ".ade-alpha") }, null],
    ["launchd's job (its label in XPC_SERVICE_NAME)", { env: { XPC_SERVICE_NAME: "com.ade.runtime" } }, null],
    ["a desktop's brain (it exits with its parent)", { env: { XPC_SERVICE_NAME: "0", ADE_RUNTIME_PARENT_PID: "4242" } }, null],
    ["an explicit idle setting, 0 included", { env: { XPC_SERVICE_NAME: "0", ADE_RUNTIME_IDLE_EXIT_MS: "0" } }, null],
    ["a systemd unit's brain", { platform: "linux", env: { INVOCATION_ID: "abc123" } }, null],
    ["a Linux test brain", { platform: "linux", env: {} }, UNMANAGED_BRAIN_IDLE_EXIT_MS],
    ["the Windows supervisor's brain", { platform: "win32", env: {}, windowsSupervised: true }, null],
    ["a Windows test brain", { platform: "win32", env: {}, windowsSupervised: false }, UNMANAGED_BRAIN_IDLE_EXIT_MS],
  ])("%s", (_label, change, expected) => {
    expect(unmanagedBrainIdleExitMs({ ...base, ...change })).toBe(expected);
  });

  it.each<[string, number, boolean, string | null, boolean]>([
    ["reparented to launchd or init", 1, true, null, true],
    ["a parent that is gone (Windows does not reparent)", 4242, false, null, true],
    ["reparented to a Linux subreaper", 4242, true, "systemd", true],
    ["a live harness still running it", 4242, true, "node", false],
  ])("is orphaned when %s", (_label, ppid, parentAlive, parentName, orphaned) => {
    expect(isOrphanedProcess({ ppid, platform: "linux", isPidAlive: () => parentAlive, readParentName: () => parentName })).toBe(orphaned);
  });
});

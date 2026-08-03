import { afterEach, describe, expect, it } from "vitest";
import { availableRuntimes, cursorInstallCommand } from "./AiRuntimesBand";

describe("cursorInstallCommand", () => {
  it("uses Cursor's PowerShell installer on Windows", () => {
    const command = cursorInstallCommand("win32");
    expect(command).toContain("powershell.exe");
    expect(command).toContain("cursor.com/install?win32=true");
    expect(command).not.toContain("curl");
    expect(command).not.toContain("mkdir -p");
    expect(command).not.toContain("$HOME");
  });

  it("keeps the documented POSIX one-liner elsewhere", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const command = cursorInstallCommand(platform);
      expect(command).toContain("curl https://cursor.com/install -fsS | bash");
      expect(command).not.toContain("powershell");
    }
  });
});

// Onboarding must not offer a runtime that cannot be installed usefully:
// @cursor/sdk has no win32-arm64 build. See shared/providerPlatformSupport.ts.
describe("availableRuntimes", () => {
  function setRuntimeTarget(platform: string, arch: string) {
    (globalThis as { window?: unknown }).window = {
      ade: { app: { runtimeTarget: { platform, arch } } },
    };
  }

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("drops Cursor on Windows on ARM and keeps every other runtime", () => {
    setRuntimeTarget("win32", "arm64");
    const ids = availableRuntimes().map((rt) => rt.id);
    expect(ids).not.toContain("cursor");
    expect(ids).toEqual(["claude", "codex", "droid", "opencode"]);
  });

  it("keeps Cursor on Windows x64 and on macOS", () => {
    for (const [platform, arch] of [["win32", "x64"], ["darwin", "arm64"], ["darwin", "x64"]] as const) {
      setRuntimeTarget(platform, arch);
      const ids = availableRuntimes().map((rt) => rt.id);
      expect(ids, `${platform}-${arch}`).toEqual(["claude", "codex", "cursor", "droid", "opencode"]);
    }
  });
});

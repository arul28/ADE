import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { checkKimiWindowsPrerequisites, resolveAcpExecutable } from "./acpExecutables";

describe("resolveAcpExecutable", () => {
  it("prefers an explicit env override over PATH", () => {
    const resolved = resolveAcpExecutable("grok", {
      env: { GROK_EXECUTABLE: "/opt/custom/grok", PATH: "/usr/bin" },
    });
    expect(resolved).toEqual({ path: "/opt/custom/grok", source: "env" });
  });

  it("falls back to the bare command when nothing is installed", () => {
    vi.spyOn(fs, "statSync").mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    });
    try {
      const resolved = resolveAcpExecutable("qwen", { env: { PATH: "", HOME: "/no-such-ade-home" } });
      expect(resolved).toEqual({ path: "qwen", source: "fallback-command" });
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("checkKimiWindowsPrerequisites", () => {
  it("is a no-op off Windows", () => {
    expect(checkKimiWindowsPrerequisites({ platform: "darwin" })).toEqual({ ok: true });
    expect(checkKimiWindowsPrerequisites({ platform: "linux" })).toEqual({ ok: true });
  });

  it("passes when Git Bash is in a well-known Program Files path", () => {
    const result = checkKimiWindowsPrerequisites({
      platform: "win32",
      env: { PROGRAMFILES: "C:\\Program Files" },
      exists: (candidate) => candidate === "C:\\Program Files\\Git\\bin\\bash.exe",
    });
    expect(result).toEqual({ ok: true });
  });

  it("fails with an actionable message when Git Bash is missing", () => {
    const result = checkKimiWindowsPrerequisites({
      platform: "win32",
      env: { PROGRAMFILES: "C:\\Program Files", PATH: "C:\\Windows\\System32" },
      exists: () => false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.message).toMatch(/Git for Windows/i);
    expect(result.message).toMatch(/git-scm.com/i);
  });
});

import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkKimiWindowsPrerequisites, resolveAcpExecutable } from "./acpExecutables";

const pathFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-acp-path-cli-"));
const pathFixtureBin = path.join(pathFixtureRoot, "bin");
fs.mkdirSync(pathFixtureBin);
for (const command of ["qwen", "kimi", "grok", "devin"]) {
  const file = path.join(pathFixtureBin, command);
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(file, 0o755);
}
afterAll(() => fs.rmSync(pathFixtureRoot, { recursive: true, force: true }));

describe("resolveAcpExecutable", () => {
  it("prefers an explicit env override over PATH", () => {
    const resolved = resolveAcpExecutable("grok", {
      env: { GROK_EXECUTABLE: "/opt/custom/grok", PATH: "/usr/bin" },
    });
    expect(resolved).toEqual({ path: "/opt/custom/grok", source: "env" });
  });

  it("reports a missing pinned copy with an empty path", () => {
    const resolved = resolveAcpExecutable("qwen", {
      env: { PATH: "", HOME: "/no-such-ade-home", ADE_TOOLS_ROOT: path.join(pathFixtureRoot, "empty-tools") },
    });
    expect(resolved).toEqual({ path: "", source: "fallback-command" });
  });

  it.each([
    ["qwen", "qwen"],
    ["kimi", "kimi"],
    ["grok", "grok"],
    ["devin", "devin"],
  ] as const)("never selects %s from PATH when ADE has no pin for this target", (provider, command) => {
    const resolved = resolveAcpExecutable(provider, {
      env: { PATH: pathFixtureBin, ADE_TOOLS_ROOT: path.join(pathFixtureRoot, "empty-tools") },
      platform: "freebsd",
      arch: "x64",
    });

    expect(fs.existsSync(path.join(pathFixtureBin, command))).toBe(true);
    expect(resolved).toEqual({ path: "", source: "fallback-command" });
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

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _testing,
  collectGrokUpdateInfo,
  compareGrokVersions,
  decideGrokUpdate,
  resolveGrokInstaller,
  runGrokUpdate,
  type GrokInstallerIo,
  type GrokRunResult,
  type GrokSpawn,
} from "./grokUpdate";

beforeEach(() => {
  _testing.resetLatestVersionCache();
});

function installerIo(files: Record<string, string | null>): GrokInstallerIo {
  return {
    exists: (path) => path in files,
    readFirstLine: (path) => files[path] ?? null,
  };
}

describe("resolveGrokInstaller", () => {
  it("treats a real executable as the native installer and builds its update command", () => {
    const io = installerIo({ "/usr/local/bin/grok": null });
    expect(resolveGrokInstaller("/usr/local/bin/grok", io)).toEqual({
      installer: "native",
      updateCommand: ["/usr/local/bin/grok", "update"],
    });
  });

  it("recognizes a Windows npm shim", () => {
    const io = installerIo({ "C:\\Users\\me\\AppData\\Roaming\\npm\\grok.cmd": "@echo off" });
    expect(resolveGrokInstaller("C:\\Users\\me\\AppData\\Roaming\\npm\\grok.cmd", io).installer).toBe("npm");
  });

  it("recognizes a Node-shebang script under node_modules", () => {
    const io = installerIo({ "/usr/local/lib/node_modules/@xai-official/grok/bin/grok.js": "#!/usr/bin/env node" });
    expect(resolveGrokInstaller("/usr/local/lib/node_modules/@xai-official/grok/bin/grok.js", io).installer).toBe("npm");
  });

  it("returns null for a binary that does not exist, so the candidate stays manual", () => {
    expect(resolveGrokInstaller("/opt/bin/grok", installerIo({}))).toEqual({
      installer: null,
      updateCommand: null,
    });
    expect(resolveGrokInstaller(null, installerIo({}))).toEqual({ installer: null, updateCommand: null });
  });
});

describe("compareGrokVersions", () => {
  it.each([
    ["1.0.13", "1.0.34", -1],
    ["1.0.40", "1.0.40", 0],
    ["grok 1.0.41", "1.0.40", 1],
    ["2.0.0", "1.9.9", 1],
  ])("compares %j to %j", (current, latest, sign) => {
    const result = compareGrokVersions(current, latest);
    expect(result).not.toBeNull();
    expect(Math.sign(result!)).toBe(sign);
  });

  it("returns null when a version cannot be parsed", () => {
    expect(compareGrokVersions("unknown", "1.0.0")).toBeNull();
    expect(compareGrokVersions("1.0.0", null)).toBeNull();
  });
});

describe("decideGrokUpdate", () => {
  it("offers an update when the native install is behind latest", () => {
    expect(decideGrokUpdate({ currentVersion: "1.0.13", latestVersion: "1.0.34", installer: "native" })).toEqual({
      latestVersion: "1.0.34",
      updateAvailable: true,
      installer: "native",
      canUpdate: true,
      note: null,
    });
  });

  it("does not offer an update when the version is current", () => {
    const info = decideGrokUpdate({ currentVersion: "1.0.40", latestVersion: "1.0.40", installer: "npm" });
    expect(info.updateAvailable).toBe(false);
    expect(info.canUpdate).toBe(true);
  });

  it("keeps an unresolvable install manual with a note and no button", () => {
    const info = decideGrokUpdate({ currentVersion: "1.0.13", latestVersion: "1.0.34", installer: null });
    expect(info.updateAvailable).toBe(true);
    expect(info.canUpdate).toBe(false);
    expect(info.note).toContain("could not tell how this Grok was installed");
  });

  it("notes when the registry read failed", () => {
    const info = decideGrokUpdate({ currentVersion: "1.0.13", latestVersion: null, installer: "native" });
    expect(info.updateAvailable).toBe(false);
    expect(info.note).toContain("npm");
  });
});

describe("collectGrokUpdateInfo", () => {
  it("skips the registry entirely when the installer cannot be resolved", async () => {
    const fetchImpl = vi.fn();
    const info = await collectGrokUpdateInfo({
      binaryPath: "/opt/bin/grok",
      currentVersion: "1.0.13",
      installerIo: installerIo({}),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(info.installer).toBeNull();
  });

  it("reads the registry and offers the update for a resolved native install", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: "1.0.34" }),
    })) as unknown as typeof fetch;
    const info = await collectGrokUpdateInfo({
      binaryPath: "/usr/local/bin/grok",
      currentVersion: "1.0.13",
      installerIo: installerIo({ "/usr/local/bin/grok": null }),
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(info).toMatchObject({ installer: "native", latestVersion: "1.0.34", updateAvailable: true, canUpdate: true });
  });
});

describe("runGrokUpdate", () => {
  it("runs update then --version with the instance GROK_HOME", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const run: GrokSpawn = async (_command, args, opts): Promise<GrokRunResult> => {
      calls.push({ args, env: opts.env });
      return args[0] === "update"
        ? { status: 0, stdout: "updated\n", stderr: "" }
        : { status: 0, stdout: "1.0.34\n", stderr: "" };
    };
    const result = await runGrokUpdate({
      binaryPath: "/usr/local/bin/grok",
      configHome: "/tmp/grok-custom",
      env: { PATH: "/usr/bin" },
      run,
    });
    expect(result).toEqual({ ok: true, message: "Grok updated to 1.0.34.", version: "1.0.34" });
    expect(calls.map((call) => call.args)).toEqual([["update"], ["--version"]]);
    expect(calls.every((call) => call.env.GROK_HOME === "/tmp/grok-custom")).toBe(true);
  });

  it("reports a failed update without inventing a version", async () => {
    const run: GrokSpawn = async () => ({ status: 1, stdout: "", stderr: "network unreachable\n" });
    const result = await runGrokUpdate({ binaryPath: "grok", run });
    expect(result.ok).toBe(false);
    expect(result.version).toBeNull();
    expect(result.message).toContain("network unreachable");
  });
});

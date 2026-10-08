import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ACP_PROVIDER_VERSION_POLICY,
  compareVersions,
  decideAcpProviderUpdate,
  resolveAcpInstaller,
  runAcpProviderInstall,
  type AcpInstaller,
  type AcpInstallerIo,
  type AcpRunResult,
  type AcpSpawn,
} from "./acpProviderUpdate";

/** A fake disk: `files` maps a path to its first line, `links` maps a path to its real path. */
function installerIo(files: Record<string, string | null>, links: Record<string, string> = {}): AcpInstallerIo {
  const known = new Set([...Object.keys(files), ...Object.values(links)]);
  return {
    exists: (path) => known.has(path),
    realpath: (path) => links[path] ?? path,
    readFirstLine: (path) => files[path] ?? null,
  };
}

const GROK_MAX = ACP_PROVIDER_VERSION_POLICY.grok.tested.max;
const GROK_MIN = ACP_PROVIDER_VERSION_POLICY.grok.tested.min;

describe("resolveAcpInstaller", () => {
  it.each<[string, Parameters<typeof resolveAcpInstaller>[0], string | null, AcpInstallerIo, AcpInstaller | null]>([
    [
      "an npm global install on POSIX resolves its prefix through the bin symlink",
      "grok",
      "/opt/homebrew/bin/grok",
      installerIo({ "/opt/homebrew/bin/grok": null }, { "/opt/homebrew/bin/grok": "/opt/homebrew/lib/node_modules/@xai-official/grok/bin/grok.js" }),
      { kind: "npm", binaryPath: "/opt/homebrew/bin/grok", prefix: "/opt/homebrew" },
    ],
    [
      "a Windows npm .cmd shim resolves to the folder that holds node_modules",
      "qwen",
      "C:\\Users\\me\\AppData\\Roaming\\npm\\qwen.cmd",
      installerIo({
        "C:\\Users\\me\\AppData\\Roaming\\npm\\qwen.cmd": "@echo off",
        [path.win32.join("C:\\Users\\me\\AppData\\Roaming\\npm", "node_modules", "@qwen-code", "qwen-code")]: null,
      }),
      { kind: "npm", binaryPath: "C:\\Users\\me\\AppData\\Roaming\\npm\\qwen.cmd", prefix: "C:\\Users\\me\\AppData\\Roaming\\npm" },
    ],
    [
      "a vendor-native Grok binary uses Grok's own updater",
      "grok",
      "/Users/me/.grok/bin/grok",
      installerIo({ "/Users/me/.grok/bin/grok": "\u007fELF" }),
      { kind: "native", binaryPath: "/Users/me/.grok/bin/grok" },
    ],
    [
      "a project-local install stays manual: a global install would not change it",
      "qwen",
      "/Users/me/proj/node_modules/.bin/qwen",
      installerIo({ "/Users/me/proj/node_modules/.bin/qwen": "#!/usr/bin/env node" }, { "/Users/me/proj/node_modules/.bin/qwen": "/Users/me/proj/node_modules/@qwen-code/qwen-code/cli.js" }),
      null,
    ],
    [
      "a Node script ADE cannot place stays manual instead of guessing a prefix",
      "grok",
      "/somewhere/grok",
      installerIo({ "/somewhere/grok": "#!/usr/bin/env node" }),
      null,
    ],
    [
      "a native Copilot has no exact-version updater, so it stays manual",
      "copilot",
      "/opt/homebrew/bin/copilot",
      installerIo({ "/opt/homebrew/bin/copilot": null }),
      null,
    ],
    [
      "Kimi has no npm package and no updater ADE can drive",
      "kimi",
      "/Users/me/.kimi-code/bin/kimi",
      installerIo({ "/Users/me/.kimi-code/bin/kimi": null }),
      null,
    ],
    ["a missing binary stays manual", "grok", "/opt/bin/grok", installerIo({}), null],
    ["no binary path stays manual", "grok", null, installerIo({}), null],
  ])("%s", (_label, provider, binaryPath, io, expected) => {
    expect(resolveAcpInstaller(provider, binaryPath, io)).toEqual(expected);
  });
});

describe("compareVersions", () => {
  it.each([
    ["1.0.13", "1.0.34", -1],
    ["1.0.40", "1.0.40", 0],
    ["grok 1.0.41 (4220f3b224a6) [stable]", "1.0.40", 1],
    ["2.0.0", "1.9.9", 1],
  ])("compares %j to %j", (current, other, sign) => {
    const result = compareVersions(current, other);
    expect(result).not.toBeNull();
    expect(Math.sign(result!)).toBe(sign);
  });

  it("returns null when a version cannot be parsed", () => {
    expect(compareVersions("unknown", "1.0.0")).toBeNull();
    expect(compareVersions("1.0.0", null)).toBeNull();
  });
});

describe("decideAcpProviderUpdate", () => {
  const native: AcpInstaller = { kind: "native", binaryPath: "/Users/me/.grok/bin/grok" };

  it.each([
    ["below the tested range", "grok 1.0.13", "below", true, true],
    ["inside the range, not at the top", `grok ${GROK_MIN}`, "tested", true, true],
    ["at the top of the range", `grok ${GROK_MAX}`, "tested", false, false],
    ["newer than ADE has tested", "grok 9.0.0", "above", false, false],
    ["an unreadable version", "grok (dev build)", "unknown", false, false],
  ] as const)("%s", (_label, versionLine, standing, updateAvailable, canUpdate) => {
    const info = decideAcpProviderUpdate({ provider: "grok", versionLine, installer: native });
    expect(info.standing).toBe(standing);
    expect(info.updateAvailable).toBe(updateAvailable);
    expect(info.canUpdate).toBe(canUpdate);
    // An update always targets the top of the tested range, never npm `latest`.
    expect(info.targetVersion).toBe(GROK_MAX);
    expect(info.note).toBeNull();
  });

  it("names the manual command when ADE cannot place the install", () => {
    const info = decideAcpProviderUpdate({ provider: "qwen", versionLine: "0.22.3", installer: null });
    expect(info.updateAvailable).toBe(true);
    expect(info.canUpdate).toBe(false);
    expect(info.installer).toBeNull();
    expect(info.note).toContain(`@qwen-code/qwen-code@${ACP_PROVIDER_VERSION_POLICY.qwen.tested.max}`);
  });
});

describe("runAcpProviderInstall", () => {
  function recordingRun(results: Record<string, AcpRunResult>) {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run: AcpSpawn = async (command, args) => {
      calls.push({ command, args });
      return results[args[0] ?? ""] ?? { status: 0, stdout: "", stderr: "" };
    };
    return { calls, run };
  }

  it("installs the newest tested version into the binary's own npm prefix, then reads the version", async () => {
    const { calls, run } = recordingRun({ "--version": { status: 0, stdout: `${ACP_PROVIDER_VERSION_POLICY.qwen.tested.max}\n`, stderr: "" } });
    const io = installerIo({ "/usr/local/bin/npm": null });
    const result = await runAcpProviderInstall({
      provider: "qwen",
      installer: { kind: "npm", binaryPath: "/usr/local/bin/qwen", prefix: "/usr/local" },
      env: { PATH: "/usr/bin" },
      run,
      io,
    });
    expect(result.ok).toBe(true);
    expect(result.version).toBe(ACP_PROVIDER_VERSION_POLICY.qwen.tested.max);
    expect(calls[0]).toEqual({
      command: "/usr/local/bin/npm",
      args: ["install", "-g", "--prefix", "/usr/local", `@qwen-code/qwen-code@${ACP_PROVIDER_VERSION_POLICY.qwen.tested.max}`],
    });
    expect(calls[1]).toEqual({ command: "/usr/local/bin/qwen", args: ["--version"] });
  });

  it("finds the version among warning lines around it", async () => {
    const max = ACP_PROVIDER_VERSION_POLICY.qwen.tested.max;
    const { run } = recordingRun({
      "--version": { status: 0, stdout: `${max}\nRun qwen --help for usage\n`, stderr: "(node:1) ExperimentalWarning: fetch is experimental\n" },
    });
    const result = await runAcpProviderInstall({
      provider: "qwen",
      installer: { kind: "npm", binaryPath: "/usr/local/bin/qwen", prefix: "/usr/local" },
      run,
      io: installerIo({}),
    });
    expect(result.ok).toBe(true);
    expect(result.version).toBe(max);
    expect(result.message).toContain(max);
  });

  it("asks a native Grok for the exact tested version", async () => {
    const { calls, run } = recordingRun({});
    await runAcpProviderInstall({ provider: "grok", installer: { kind: "native", binaryPath: "/g/grok" }, run, io: installerIo({}) });
    expect(calls[0]).toEqual({ command: "/g/grok", args: ["update", "--version", GROK_MAX] });
  });

  it.each([
    ["still reports the old version", { status: 0, stdout: "0.22.3\n", stderr: "" }, /still reports 0\.22\.3/],
    ["cannot report a version", { status: 1, stdout: "", stderr: "" }, /could not confirm/],
  ])("fails an install that exited 0 when the binary %s", async (_label, versionResult, message) => {
    const { run } = recordingRun({ "--version": versionResult });
    const result = await runAcpProviderInstall({
      provider: "qwen",
      installer: { kind: "npm", binaryPath: "/usr/local/bin/qwen", prefix: "/usr/local" },
      run,
      io: installerIo({}),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(message);
  });

  it("reports a failed update without inventing a version", async () => {
    const { calls, run } = recordingRun({ install: { status: 1, stdout: "", stderr: "EACCES: permission denied\n" } });
    const result = await runAcpProviderInstall({
      provider: "copilot",
      installer: { kind: "npm", binaryPath: "/usr/local/bin/copilot", prefix: "/usr/local" },
      run,
      io: installerIo({}),
    });
    expect(result.ok).toBe(false);
    expect(result.version).toBeNull();
    expect(result.message).toContain("EACCES");
    // No version re-read after a failed install.
    expect(calls).toHaveLength(1);
  });
});

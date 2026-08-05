import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  brainUpdateAssetUrl,
  detectRuntimeTarget,
  readBrainUpdateStatus,
  runBrainUpdateCommand,
} from "./brainUpdate";

const tempRoots: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function checksumFileFor(target: string, binaryContent: string, archiveContent = "archive"): string {
  const binaryName = `ade-${target}${target.startsWith("win32-") ? ".exe" : ""}`;
  return [
    `${sha256(binaryContent)}  ${binaryName}`,
    `${sha256(archiveContent)}  ade-${target}.native.tar.gz`,
    "",
  ].join("\n");
}

function downloadRuntimeFixture(target: string, version = "v1.2.13") {
  const binaryName = `ade-${target}${target.startsWith("win32-") ? ".exe" : ""}`;
  const binaryUrl = brainUpdateAssetUrl("arul28/ADE", version, binaryName);
  return async (url: string, outPath: string) => {
    if (url.endsWith("/SHA256SUMS")) {
      fs.writeFileSync(outPath, checksumFileFor(target, binaryUrl));
    } else {
      fs.writeFileSync(outPath, url.endsWith(".tar.gz") ? "archive" : url);
    }
  };
}

/**
 * On Windows the updater extracts with System32's bsdtar resolved through the
 * kernel SystemRoot alias, not a bare PATH "tar", so fixtures must recognise
 * both spellings.
 */
function isTarCommand(command: string): boolean {
  return command === "tar" || command.toLowerCase().endsWith("\\tar.exe");
}

function extractRuntimeFixture(command: string, args: string[]) {
  if (isTarCommand(command)) {
    const targetDir = args[args.indexOf("-C") + 1];
    fs.mkdirSync(path.join(targetDir, "node_modules"), { recursive: true });
  }
  return { status: 0, stdout: "", stderr: "" };
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-brain-update-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("brain update command", () => {
  it("detects supported runtime targets", () => {
    expect(detectRuntimeTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(detectRuntimeTarget("darwin", "x86_64")).toBe("darwin-x64");
    expect(detectRuntimeTarget("linux", "aarch64")).toBe("linux-arm64");
    expect(detectRuntimeTarget("linux", "amd64")).toBe("linux-x64");
    expect(detectRuntimeTarget("win32", "x64")).toBe("win32-x64");
    expect(() => detectRuntimeTarget("win32", "arm64")).toThrow(/unsupported/i);
  });

  it("builds latest and tagged release asset URLs", () => {
    expect(brainUpdateAssetUrl("arul28/ADE", "latest", "ade-darwin-arm64"))
      .toBe("https://github.com/arul28/ADE/releases/latest/download/ade-darwin-arm64");
    expect(brainUpdateAssetUrl("arul28/ADE", "v1.2.13", "ade-darwin-arm64"))
      .toBe("https://github.com/arul28/ADE/releases/download/v1.2.13/ade-darwin-arm64");
    expect(() => brainUpdateAssetUrl("../nope", "latest", "ade-darwin-arm64")).toThrow(/owner\/repo/);
  });

  it("reports dry-run update inputs without downloading assets", async () => {
    const root = tempRoot();
    const result = await runBrainUpdateCommand(
      ["update", "--dry-run", "--version", "v1.2.13", "--repo", "arul28/ADE"],
      {
        env: { ADE_HOME: root },
        platform: "darwin",
        arch: "arm64",
        currentVersion: "1.2.12",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      action: "update",
      dryRun: true,
      requestedVersion: "v1.2.13",
      currentVersion: "1.2.12",
      target: "darwin-arm64",
      binaryPath: path.join(root, "bin", "ade"),
      runtimePath: path.join(root, "runtime", "darwin-arm64"),
      restartService: true,
    });
    expect(String(result.binaryUrl)).toContain("/releases/download/v1.2.13/ade-darwin-arm64");
  });

  it("stages downloads and launches a detached staged helper by default", async () => {
    const root = tempRoot();
    const downloads: string[] = [];
    const execEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
    const spawns: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];

    const result = await runBrainUpdateCommand(
      ["update", "--version", "v1.2.13"],
      {
        env: { ADE_HOME: root },
        platform: "linux",
        arch: "x64",
        currentVersion: "1.2.12",
        downloadFile: async (url, outPath) => {
          downloads.push(url);
          if (url.endsWith("/SHA256SUMS")) {
            fs.writeFileSync(
              outPath,
              checksumFileFor(
                "linux-x64",
                "https://github.com/arul28/ADE/releases/download/v1.2.13/ade-linux-x64",
              ),
            );
          } else {
            fs.writeFileSync(outPath, url.endsWith(".tar.gz") ? "archive" : url);
          }
        },
        execFile: async (_command, _args, options) => {
          execEnvs.push(options.env);
          return { stdout: "ade 1.2.13\n", stderr: "" };
        },
        runCommand: (command, args) => {
          if (isTarCommand(command)) {
            const targetDir = args[args.indexOf("-C") + 1];
            fs.mkdirSync(path.join(targetDir, "node_modules"), { recursive: true });
          }
          return { status: 0, stdout: "", stderr: "" };
        },
        spawnDetached: (command, args, options) => {
          spawns.push({ command, args, env: options.env });
        },
      },
    );

    expect(downloads).toEqual([
      "https://github.com/arul28/ADE/releases/download/v1.2.13/ade-linux-x64",
      "https://github.com/arul28/ADE/releases/download/v1.2.13/ade-linux-x64.native.tar.gz",
      "https://github.com/arul28/ADE/releases/download/v1.2.13/SHA256SUMS",
    ]);
    const stagingDir = path.dirname(spawns[0]?.command ?? "");
    expect(stagingDir.startsWith(path.join(root, "runtime", "updates", "update-"))).toBe(true);
    expect(spawns).toEqual([
      {
        command: path.join(stagingDir, "ade"),
        args: ["brain", "update", "--apply-staged", path.join(stagingDir, "manifest.json")],
        env: expect.objectContaining({
          ADE_HOME: root,
          ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION: "1",
          ADE_RUNTIME_ROOT: path.join(stagingDir, "runtime", "linux-x64"),
          ADE_RUNTIME_NODE_MODULES: path.join(stagingDir, "runtime", "linux-x64", "node_modules"),
          NODE_PATH: path.join(stagingDir, "runtime", "linux-x64", "node_modules"),
        }),
      },
    ]);
    expect(execEnvs[0]).toMatchObject({
      ADE_RUNTIME_ROOT: path.join(stagingDir, "runtime", "linux-x64"),
      ADE_RUNTIME_NODE_MODULES: path.join(stagingDir, "runtime", "linux-x64", "node_modules"),
      NODE_PATH: path.join(stagingDir, "runtime", "linux-x64", "node_modules"),
    });
    expect(result).toMatchObject({
      ok: true,
      detached: true,
      stagedVersion: "1.2.13",
    });
    expect(readBrainUpdateStatus({ ADE_HOME: root })).toMatchObject({
      state: "staged",
      version: "1.2.13",
      currentVersion: "1.2.12",
      target: "linux-x64",
    });
  });

  it("can apply a staged update in the foreground without restarting the service", async () => {
    const root = tempRoot();
    const tmp = path.join(root, "tmp");
    fs.mkdirSync(tmp, { recursive: true });
    const tarCalls: string[][] = [];

    const result = await runBrainUpdateCommand(
      ["update", "--version", "v1.2.13", "--foreground", "--no-restart"],
      {
        env: { ADE_HOME: root },
        platform: "darwin",
        arch: "arm64",
        tmpDir: async () => tmp,
        downloadFile: async (url, outPath) => {
          if (url.endsWith("/SHA256SUMS")) {
            fs.writeFileSync(
              outPath,
              checksumFileFor(
                "darwin-arm64",
                "https://github.com/arul28/ADE/releases/download/v1.2.13/ade-darwin-arm64",
              ),
            );
          } else {
            fs.writeFileSync(outPath, url.endsWith(".tar.gz") ? "archive" : url);
          }
        },
        execFile: async () => ({ stdout: "ade 1.2.13\n", stderr: "" }),
        runCommand: (command, args) => {
          tarCalls.push([command, ...args]);
          if (isTarCommand(command)) {
            const targetDir = args[args.indexOf("-C") + 1];
            fs.mkdirSync(path.join(targetDir, "node_modules"), { recursive: true });
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      applied: true,
      restarted: false,
      version: "1.2.13",
    });
    expect(fs.existsSync(path.join(root, "bin", "ade"))).toBe(true);
    expect(fs.existsSync(path.join(root, "runtime", "darwin-arm64", "node_modules"))).toBe(true);
    expect(tarCalls[0]).toEqual([
      "tar",
      "-xzf",
      path.join(tmp, "ade-darwin-arm64.native.tar.gz"),
      "-C",
      path.join(tmp, "runtime", "darwin-arm64"),
    ]);
    expect(tarCalls).toHaveLength(1);
    expect(readBrainUpdateStatus({ ADE_HOME: root })).toMatchObject({
      state: "succeeded",
      version: "1.2.13",
    });
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it.each([
    {
      label: "and reinstalls it afterward",
      updateArgs: ["update", "--version", "v1.2.13", "--foreground"],
      serviceWasInstalled: true,
      failInstall: false,
      ok: true,
      restarted: true,
      expectedServiceArgs: [["serve", "--uninstall-service"], ["serve", "--install-service"]],
    },
    {
      label: "without restoring a service that was not previously installed",
      updateArgs: ["update", "--version", "v1.2.13", "--foreground"],
      serviceWasInstalled: false,
      failInstall: true,
      ok: false,
      restarted: false,
      expectedServiceArgs: [["serve", "--uninstall-service"], ["serve", "--install-service"]],
    },
  ])("stops a Windows brain before replacing its executable $label", async ({
    updateArgs,
    serviceWasInstalled,
    failInstall,
    ok,
    restarted,
    expectedServiceArgs,
  }) => {
    const root = tempRoot();
    const tmp = path.join(root, "tmp");
    const installedBinary = path.join(root, "bin", "ade.exe");
    fs.mkdirSync(path.dirname(installedBinary), { recursive: true });
    fs.writeFileSync(installedBinary, "old-binary");
    fs.mkdirSync(tmp, { recursive: true });
    const serviceCalls: string[][] = [];

    const result = await runBrainUpdateCommand(
      updateArgs,
      {
        env: { ADE_HOME: root },
        platform: "win32",
        arch: "x64",
        tmpDir: async () => tmp,
        downloadFile: async (url, outPath) => {
          if (url.endsWith("/SHA256SUMS")) {
            fs.writeFileSync(
              outPath,
              checksumFileFor(
                "win32-x64",
                "https://github.com/arul28/ADE/releases/download/v1.2.13/ade-win32-x64.exe",
              ),
            );
          } else {
            fs.writeFileSync(outPath, url.endsWith(".tar.gz") ? "archive" : url);
          }
        },
        execFile: async () => ({ stdout: "ade 1.2.13\n", stderr: "" }),
        runCommand: (command, args) => {
          if (isTarCommand(command)) {
            const targetDir = args[args.indexOf("-C") + 1];
            fs.mkdirSync(path.join(targetDir, "node_modules"), { recursive: true });
          } else if (args.includes("--service-status")) {
            return {
              status: 0,
              stdout: JSON.stringify({ installed: serviceWasInstalled, running: serviceWasInstalled }),
              stderr: "",
            };
          } else {
            serviceCalls.push([command, ...args]);
            if (failInstall && args.includes("--install-service")) {
              return { status: 1, stdout: "", stderr: "service start failed" };
            }
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );

    expect(result).toMatchObject({ ok, applied: ok, restarted, target: "win32-x64" });
    expect(serviceCalls).toEqual(expectedServiceArgs.map((args) => [installedBinary, ...args]));
    if (ok) {
      expect(fs.readFileSync(installedBinary, "utf8")).toContain("ade-win32-x64.exe");
    } else {
      expect(fs.readFileSync(installedBinary, "utf8")).toBe("old-binary");
    }
    expect(fs.existsSync(path.join(root, "runtime", "win32-x64", "node_modules"))).toBe(ok);
  });

  it("rejects --no-restart on Windows before downloading or removing startup registration", async () => {
    const downloadFile = vi.fn(async () => undefined);
    const runCommand = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    await expect(runBrainUpdateCommand(
      ["update", "--version", "v1.2.13", "--foreground", "--no-restart"],
      {
        env: { ADE_HOME: tempRoot() },
        platform: "win32",
        arch: "x64",
        downloadFile,
        runCommand,
      },
    )).rejects.toThrow(/--no-restart is not supported on Windows/);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("defers Windows staging cleanup until the staged helper executable exits", async () => {
    const root = tempRoot();
    const tmp = path.join(root, "tmp");
    fs.mkdirSync(tmp, { recursive: true });
    const cleanupSpawns: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];

    const result = await runBrainUpdateCommand(
      ["update", "--version", "v1.2.13", "--foreground"],
      {
        env: { ADE_HOME: root },
        platform: "win32",
        arch: "x64",
        execPath: path.join(tmp, "ade.exe"),
        tmpDir: async () => tmp,
        downloadFile: downloadRuntimeFixture("win32-x64"),
        execFile: async () => ({ stdout: "ade 1.2.13\n", stderr: "" }),
        runCommand: extractRuntimeFixture,
        spawnDetached: (command, args, options) => {
          cleanupSpawns.push({ command, args, env: options.env });
        },
      },
    );

    expect(result).toMatchObject({ ok: true, applied: true, restarted: true });
    expect(fs.existsSync(tmp)).toBe(true);
    expect(cleanupSpawns).toHaveLength(1);
    expect(cleanupSpawns[0]).toMatchObject({
      command: "powershell.exe",
      args: expect.arrayContaining(["-NonInteractive", "-Command"]),
      env: expect.objectContaining({
        ADE_BRAIN_UPDATE_CLEANUP_DIR: tmp,
        ADE_BRAIN_UPDATE_CLEANUP_PARENT_PID: String(process.pid),
      }),
    });
    expect(cleanupSpawns[0]?.args.join(" ")).toContain("Wait-Process");
    expect(cleanupSpawns[0]?.args.join(" ")).toContain("Remove-Item");
    if (process.platform === "win32") {
      const cleanupScript = cleanupSpawns[0]?.args.at(-1) ?? "";
      const parsed = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "[void][scriptblock]::Create($env:ADE_TEST_CLEANUP_SCRIPT)"],
        {
          encoding: "utf8",
          env: { ...process.env, ADE_TEST_CLEANUP_SCRIPT: cleanupScript },
        },
      );
      expect(parsed.status, parsed.stderr).toBe(0);
    }
  });

  it("keeps a completed update applied when deferred staging cleanup cannot launch", async () => {
    const root = tempRoot();
    const tmp = path.join(root, "tmp");
    fs.mkdirSync(tmp, { recursive: true });

    const result = await runBrainUpdateCommand(
      ["update", "--version", "v1.2.13", "--foreground"],
      {
        env: { ADE_HOME: root },
        platform: "win32",
        arch: "x64",
        execPath: path.join(tmp, "ade.exe"),
        tmpDir: async () => tmp,
        downloadFile: downloadRuntimeFixture("win32-x64"),
        execFile: async () => ({ stdout: "ade 1.2.13\n", stderr: "" }),
        runCommand: extractRuntimeFixture,
        spawnDetached: () => {
          throw new Error("cleanup launch denied");
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      applied: true,
      restarted: true,
      message: expect.stringContaining("Staging cleanup could not complete: cleanup launch denied"),
    });
    expect(String(result.message)).toContain(`Remove ${tmp} manually.`);
    expect(readBrainUpdateStatus({ ADE_HOME: root })).toMatchObject({
      state: "succeeded",
      message: expect.stringContaining("Staging cleanup could not complete"),
    });
    expect(fs.existsSync(tmp)).toBe(true);
  });

  it("rolls back promoted assets when the service restart fails", async () => {
    const root = tempRoot();
    const tmp = path.join(root, "tmp");
    const installedBinary = path.join(root, "bin", "ade");
    const installedNativeMarker = path.join(root, "runtime", "linux-x64", "node_modules", ".keep");
    fs.mkdirSync(path.dirname(installedBinary), { recursive: true });
    fs.mkdirSync(path.dirname(installedNativeMarker), { recursive: true });
    fs.writeFileSync(installedBinary, "old-binary");
    fs.writeFileSync(installedNativeMarker, "old-native");
    fs.mkdirSync(tmp, { recursive: true });

    const result = await runBrainUpdateCommand(
      ["update", "--version", "v1.2.13", "--foreground"],
      {
        env: { ADE_HOME: root },
        platform: "linux",
        arch: "x64",
        tmpDir: async () => tmp,
        downloadFile: async (url, outPath) => {
          if (url.endsWith("/SHA256SUMS")) {
            fs.writeFileSync(
              outPath,
              checksumFileFor(
                "linux-x64",
                "https://github.com/arul28/ADE/releases/download/v1.2.13/ade-linux-x64",
              ),
            );
          } else {
            fs.writeFileSync(outPath, url.endsWith(".tar.gz") ? "archive" : url);
          }
        },
        execFile: async () => ({ stdout: "ade 1.2.13\n", stderr: "" }),
        runCommand: (command, args) => {
          if (isTarCommand(command)) {
            const targetDir = args[args.indexOf("-C") + 1];
            fs.mkdirSync(path.join(targetDir, "node_modules"), { recursive: true });
            fs.writeFileSync(path.join(targetDir, "node_modules", ".keep"), "new-native");
            return { status: 0, stdout: "", stderr: "" };
          }
          return { status: 1, stdout: "", stderr: "restart failed" };
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      applied: false,
      restarted: false,
      message: "restart failed Update was rolled back.",
    });
    expect(fs.readFileSync(installedBinary, "utf8")).toBe("old-binary");
    expect(fs.readFileSync(installedNativeMarker, "utf8")).toBe("old-native");
    expect(readBrainUpdateStatus({ ADE_HOME: root })).toMatchObject({
      state: "failed",
      error: "restart failed Update was rolled back.",
    });
  });

  it("reports and preserves recovery files when native promotion compensation fails", async () => {
    const root = tempRoot();
    const tmp = path.join(root, "tmp");
    const installedBinary = path.join(root, "bin", "ade");
    const runtimeTarget = path.join(root, "runtime", "linux-x64");
    const stagedRuntime = path.join(tmp, "runtime", "linux-x64");
    const nativeBackup = path.join(root, "runtime", `.linux-x64.previous-${process.pid}`);
    fs.mkdirSync(path.dirname(installedBinary), { recursive: true });
    fs.mkdirSync(path.join(runtimeTarget, "node_modules"), { recursive: true });
    fs.writeFileSync(installedBinary, "old-binary");
    fs.mkdirSync(tmp, { recursive: true });

    const originalRename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, "rename").mockImplementation(async (source, destination) => {
      const from = String(source);
      const to = String(destination);
      if (from === stagedRuntime && to === runtimeTarget) {
        throw new Error("native promotion denied");
      }
      if (from === nativeBackup && to === runtimeTarget) {
        throw new Error("native restore denied");
      }
      return originalRename(source, destination);
    });

    const result = await runBrainUpdateCommand(
      ["update", "--version", "v1.2.13", "--foreground", "--no-restart"],
      {
        env: { ADE_HOME: root },
        platform: "linux",
        arch: "x64",
        tmpDir: async () => tmp,
        downloadFile: downloadRuntimeFixture("linux-x64"),
        execFile: async () => ({ stdout: "ade 1.2.13\n", stderr: "" }),
        runCommand: extractRuntimeFixture,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      applied: false,
      message: expect.stringContaining("native promotion denied"),
    });
    expect(String(result.message)).toContain("restoring the previous runtime also failed: native restore denied");
    expect(String(result.message)).toContain(`Recovery files remain at ${nativeBackup}`);
    expect(fs.readFileSync(installedBinary, "utf8")).toBe("old-binary");
    expect(fs.existsSync(nativeBackup)).toBe(true);
  });

  it("continues every rollback leg and reports failed asset compensation", async () => {
    const root = tempRoot();
    const tmp = path.join(root, "tmp");
    const installedBinary = path.join(root, "bin", "ade");
    const runtimeTarget = path.join(root, "runtime", "linux-x64");
    const nativeBackup = path.join(root, "runtime", `.linux-x64.previous-${process.pid}`);
    fs.mkdirSync(path.dirname(installedBinary), { recursive: true });
    fs.mkdirSync(path.join(runtimeTarget, "node_modules"), { recursive: true });
    fs.writeFileSync(installedBinary, "old-binary");
    fs.mkdirSync(tmp, { recursive: true });

    const originalRename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, "rename").mockImplementation(async (source, destination) => {
      const from = String(source);
      const to = String(destination);
      if (from.includes(`.ade.updating-${process.pid}`) && to === installedBinary) {
        throw new Error("binary promotion denied");
      }
      if (from === nativeBackup && to === runtimeTarget) {
        throw new Error("native rollback denied");
      }
      return originalRename(source, destination);
    });

    const result = await runBrainUpdateCommand(
      ["update", "--version", "v1.2.13", "--foreground", "--no-restart"],
      {
        env: { ADE_HOME: root },
        platform: "linux",
        arch: "x64",
        tmpDir: async () => tmp,
        downloadFile: downloadRuntimeFixture("linux-x64"),
        execFile: async () => ({ stdout: "ade 1.2.13\n", stderr: "" }),
        runCommand: extractRuntimeFixture,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      applied: false,
      message: expect.stringContaining("ADE runtime asset promotion failed (binary promotion denied)"),
    });
    expect(String(result.message)).toContain("previous native runtime restoration: native rollback denied");
    expect(String(result.message)).toContain("Recovery files were retained");
    expect(fs.readFileSync(installedBinary, "utf8")).toBe("old-binary");
    expect(fs.existsSync(nativeBackup)).toBe(true);
  });

  it("keeps the installed binary when staged native dependencies are incomplete", async () => {
    const root = tempRoot();
    const tmp = path.join(root, "tmp");
    const installedBinary = path.join(root, "bin", "ade");
    fs.mkdirSync(path.dirname(installedBinary), { recursive: true });
    fs.writeFileSync(installedBinary, "old-binary");
    fs.mkdirSync(tmp, { recursive: true });

    const result = await runBrainUpdateCommand(
      ["update", "--version", "v1.2.13", "--foreground", "--no-restart"],
      {
        env: { ADE_HOME: root },
        platform: "linux",
        arch: "x64",
        tmpDir: async () => tmp,
        downloadFile: async (url, outPath) => {
          if (url.endsWith("/SHA256SUMS")) {
            fs.writeFileSync(
              outPath,
              checksumFileFor(
                "linux-x64",
                "https://github.com/arul28/ADE/releases/download/v1.2.13/ade-linux-x64",
              ),
            );
          } else {
            fs.writeFileSync(outPath, url.endsWith(".tar.gz") ? "archive" : url);
          }
        },
        execFile: async () => ({ stdout: "ade 1.2.13\n", stderr: "" }),
        runCommand: () => ({ status: 0, stdout: "", stderr: "" }),
      },
    );

    expect(result).toMatchObject({
      ok: false,
      applied: false,
      restarted: false,
      message: "Staged ADE native runtime dependencies are missing node_modules.",
    });
    expect(fs.readFileSync(installedBinary, "utf8")).toBe("old-binary");
    expect(readBrainUpdateStatus({ ADE_HOME: root })).toMatchObject({
      state: "failed",
      error: "Staged ADE native runtime dependencies are missing node_modules.",
    });
  });

  it("fails staging and records status when release checksums do not match", async () => {
    const root = tempRoot();
    const tmp = path.join(root, "tmp");

    await expect(
      runBrainUpdateCommand(
        ["update", "--version", "v1.2.13"],
        {
          env: { ADE_HOME: root },
          platform: "linux",
          arch: "arm64",
          tmpDir: async () => {
            fs.mkdirSync(tmp, { recursive: true });
            return tmp;
          },
          downloadFile: async (url, outPath) => {
            if (url.endsWith("/SHA256SUMS")) {
              fs.writeFileSync(outPath, checksumFileFor("linux-arm64", "not-the-binary"));
            } else {
              fs.writeFileSync(outPath, url.endsWith(".tar.gz") ? "archive" : url);
            }
          },
          execFile: async () => {
            throw new Error("staged binary should not execute after checksum failure");
          },
        },
      ),
    ).rejects.toThrow(/checksum mismatch/);

    expect(readBrainUpdateStatus({ ADE_HOME: root })).toMatchObject({
      state: "failed",
      target: "linux-arm64",
      error: expect.stringContaining("checksum mismatch"),
    });
  });
});

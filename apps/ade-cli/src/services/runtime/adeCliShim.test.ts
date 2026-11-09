import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  adeCliShimDirName,
  installAdeCliShim,
  publishServedRuntimeSocket,
  renderAdeCliShim,
  renderAdeCliGitBashShim,
  resolveAdeCliShimBrain,
} from "./adeCliShim";

describe("publishServedRuntimeSocket", () => {
  it("gives a launchd brain, which has only ADE_HOME, the socket it serves", () => {
    const env: NodeJS.ProcessEnv = { ADE_HOME: "/Users/a/.ade-alpha" };
    publishServedRuntimeSocket("/Users/a/.ade-alpha/sock/ade.sock", env);
    expect(env.ADE_RUNTIME_SOCKET_PATH).toBe("/Users/a/.ade-alpha/sock/ade.sock");
    expect(resolveAdeCliShimBrain(env)).toEqual({
      socketPath: "/Users/a/.ade-alpha/sock/ade.sock",
      adeHome: "/Users/a/.ade-alpha",
    });
  });

  it("replaces an inherited socket with the one this brain answers on", () => {
    const env: NodeJS.ProcessEnv = { ADE_RUNTIME_SOCKET_PATH: "/Users/a/.ade/sock/ade.sock" };
    publishServedRuntimeSocket("/tmp/ade-runtime-lane.sock", env);
    expect(env.ADE_RUNTIME_SOCKET_PATH).toBe("/tmp/ade-runtime-lane.sock");
    expect(env.ADE_RPC_SOCKET_PATH).toBeUndefined();
  });
});

describe("resolveAdeCliShimBrain", () => {
  it("keeps named pipes and tcp endpoints, drops relative values it cannot place", () => {
    expect(resolveAdeCliShimBrain({
      ADE_RUNTIME_SOCKET_PATH: "\\\\.\\pipe\\ade-runtime-x",
    }).socketPath).toBe("\\\\.\\pipe\\ade-runtime-x");
    expect(resolveAdeCliShimBrain({ ADE_RUNTIME_SOCKET_PATH: "tcp://127.0.0.1:9" }).socketPath)
      .toBe("tcp://127.0.0.1:9");
    expect(resolveAdeCliShimBrain({ ADE_RUNTIME_SOCKET_PATH: "rel/ade.sock", ADE_HOME: ".ade" }))
      .toEqual({ socketPath: null, adeHome: null });
    expect(resolveAdeCliShimBrain({})).toEqual({ socketPath: null, adeHome: null });
  });
});

describe("renderAdeCliShim", () => {
  const alpha = { socketPath: "/Users/a/.ade-alpha/sock/ade.sock", adeHome: "/Users/a/.ade-alpha" };

  it.skipIf(process.platform === "win32")("runs the shim with brain defaults and respects caller cache settings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-shim-run-"));
    try {
      const entry = path.join(dir, "entry.cjs");
      const shim = path.join(dir, "ade");
      fs.writeFileSync(entry, 'process.stdout.write(JSON.stringify({home: process.env.ADE_HOME, socket: process.env.ADE_RUNTIME_SOCKET_PATH, cache: process.env.NODE_COMPILE_CACHE, args: process.argv.slice(2)}))');
      fs.writeFileSync(shim, renderAdeCliShim({ entryPath: entry, execPath: process.execPath, brain: alpha, platform: "darwin" }));
      const run = (env: NodeJS.ProcessEnv) => {
        const result = spawnSync("sh", [shim, "two words", "line one\nline two"], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(result.stdout);
      };
      expect(run({})).toEqual({ home: alpha.adeHome, socket: alpha.socketPath, cache: `${alpha.adeHome}/cache/node-compile`, args: ["two words", "line one\nline two"] });
      expect(run({ ADE_HOME: "/other", NODE_COMPILE_CACHE: "/custom" })).toEqual({ home: "/other", cache: "/custom", args: ["two words", "line one\nline two"] });
      expect(run({ NODE_DISABLE_COMPILE_CACHE: "1" }).cache).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")("runs the Windows command shim with caller cache settings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-shim-run-"));
    try {
      const entry = path.join(dir, "entry.cjs");
      const shim = path.join(dir, "ade.cmd");
      fs.writeFileSync(entry, 'process.stdout.write(JSON.stringify({home: process.env.ADE_HOME, cache: process.env.NODE_COMPILE_CACHE, args: process.argv.slice(2)}))');
      fs.writeFileSync(shim, renderAdeCliShim({ entryPath: entry, execPath: process.execPath, brain: { adeHome: dir, socketPath: null }, platform: "win32" }));
      const result = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${shim}" "two words""`], { env: { ...process.env, ADE_HOME: dir, NODE_COMPILE_CACHE: "", NODE_DISABLE_COMPILE_CACHE: "" }, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ home: dir, cache: path.join(dir, "cache", "node-compile"), args: ["two words"] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")("runs the Git Bash shim with Windows paths", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-shim-bash-"));
    try {
      const entry = path.join(dir, "entry.cjs");
      const shim = path.join(dir, "ade");
      fs.writeFileSync(entry, 'process.stdout.write(JSON.stringify({cache: process.env.NODE_COMPILE_CACHE, args: process.argv.slice(2)}))');
      fs.writeFileSync(shim, renderAdeCliGitBashShim({ entryPath: entry, execPath: process.execPath, brain: { adeHome: dir, socketPath: null } }));
      const result = spawnSync("bash", [shim, "two words"], { env: { ...process.env, ADE_HOME: dir, NODE_COMPILE_CACHE: "", NODE_DISABLE_COMPILE_CACHE: "" }, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ cache: `${dir}/cache/node-compile`, args: ["two words"] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives two brains that share one CLI entry separate shim directories", () => {
    const entry = "/repo/apps/ade-cli/dist/cli.cjs";
    const dev = adeCliShimDirName(entry, "/node", { socketPath: "/tmp/ade-runtime-lane.sock", adeHome: null });
    const stable = adeCliShimDirName(entry, "/node", { socketPath: "/Users/a/.ade/sock/ade.sock", adeHome: null });
    expect(dev).not.toBe(stable);
    expect(adeCliShimDirName(entry, "/node", alpha)).not.toBe(
      adeCliShimDirName(entry, "/node", { ...alpha, adeHome: null }),
    );
    expect(adeCliShimDirName(entry, "/node", alpha)).toBe(adeCliShimDirName(entry, "/node", { ...alpha }));
  });
});

// ADE_CLI_PATH on Windows must not be a batch file: cmd.exe ends a command at
// its first line feed, so `ade.cmd` cut every multi-line --prompt (#46, W2).
describe("installAdeCliShim on Windows", () => {
  const brain = { socketPath: "\\\\.\\pipe\\ade-runtime-1", adeHome: "C:\\Users\\a\\.ade" };
  const shimsRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "ade-shims-"));

  it.each([
    ["the standalone ade.exe", "C:\\Users\\a\\.ade\\bin\\ade.exe", "C:\\Users\\a\\.ade\\bin\\ade.exe", /ade\.exe$/],
    ["the app's cli.cjs without the launcher", "C:\\ADE\\resources\\ade-cli\\cli.cjs", "C:\\ADE\\ADE.exe", /ade\.cmd$/],
  ] as const)("names a runnable command for %s", (_label, entryPath, execPath, commandPattern) => {
    const shim = installAdeCliShim({ entryPath, execPath, brain, shimsRoot: shimsRoot(), platform: "win32" });
    expect(shim).not.toBeNull();
    expect(shim!.commandPath).toMatch(commandPattern);
    // Git Bash's extensionless `ade` is always there.
    expect(fs.existsSync(path.join(shim!.dir, "ade"))).toBe(true);
  });

  // The launcher is found through the resources directory with Windows paths,
  // so only a Windows host can stand one up.
  it.skipIf(process.platform !== "win32")("names the shipped launcher for the app's cli.cjs", () => {
    const root = shimsRoot();
    const resourcesPath = path.join(root, "resources");
    fs.mkdirSync(path.join(resourcesPath, "native"), { recursive: true });
    fs.writeFileSync(path.join(resourcesPath, "native", "ade-cli-launcher.exe"), "MZ launcher");
    const entryPath = "C:\\ADE\\resources\\ade-cli\\cli.cjs";
    const execPath = "C:\\ADE\\ADE.exe";
    const shim = installAdeCliShim({ entryPath, execPath, brain, shimsRoot: root, platform: "win32", resourcesPath });
    expect(shim!.commandPath).toMatch(/launcher[\\/]ade\.exe$/);
    const launch = fs.readFileSync(path.join(shim!.dir, "launcher", "ade.launch"), "utf8").split("\r\n");
    expect(launch[0]).toBe("ade-launch 1");
    expect(launch).toContain(`exe ${execPath}`);
    expect(launch).toContain(`arg ${entryPath}`);
    expect(launch).toContain("env ELECTRON_RUN_AS_NODE=1");
    expect(launch).toContain(`default ADE_HOME=${brain.adeHome}`);
    // What ade.cmd also did: a warm compile cache, and ADE_CLI_NODE when set.
    expect(launch).toContain(`ifnone NODE_COMPILE_CACHE,NODE_DISABLE_COMPILE_CACHE NODE_COMPILE_CACHE=${brain.adeHome}\\cache\\node-compile`);
    expect(launch).toContain("ttynode 1");
  });
});

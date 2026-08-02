import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync as spawnChildSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADE_RUNTIME_SERVICE_NAME,
  isCurrentProcessDescendantOfPid,
  isStaleChannelServeCommandLine,
  renderCommand,
  resolveAdeServeCommand,
  type AdeServiceCommand,
  type ServiceManagerProcessResult,
  type ServiceManagerSpawnSync,
} from "./common";
import {
  installLaunchdService,
  isLaunchdPrintRunning,
  launchAgentPath,
  parseLaunchdPrintPid,
  renderLaunchdPlist,
  uninstallLaunchdService,
} from "./installLaunchd";
import { installSystemdService, renderSystemdEnvironment, renderSystemdUnit, servicePath as systemdServicePath } from "./installSystemd";
import { isWindowsTaskStateRunning } from "./installWindows";

const originalArgv = [...process.argv];
const originalNodePath = process.env.NODE_PATH;
const originalAdeRuntimeRoot = process.env.ADE_RUNTIME_ROOT;
const originalAdeRuntimeNodeModules = process.env.ADE_RUNTIME_NODE_MODULES;
const originalAdeDefaultRole = process.env.ADE_DEFAULT_ROLE;
const originalAllowSelfMutation = process.env.ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION;
const tempDirs: string[] = [];

afterEach(() => {
  process.argv.splice(0, process.argv.length, ...originalArgv);
  if (originalNodePath === undefined) delete process.env.NODE_PATH;
  else process.env.NODE_PATH = originalNodePath;
  if (originalAdeRuntimeRoot === undefined) delete process.env.ADE_RUNTIME_ROOT;
  else process.env.ADE_RUNTIME_ROOT = originalAdeRuntimeRoot;
  if (originalAdeRuntimeNodeModules === undefined) delete process.env.ADE_RUNTIME_NODE_MODULES;
  else process.env.ADE_RUNTIME_NODE_MODULES = originalAdeRuntimeNodeModules;
  if (originalAdeDefaultRole === undefined) delete process.env.ADE_DEFAULT_ROLE;
  else process.env.ADE_DEFAULT_ROLE = originalAdeDefaultRole;
  if (originalAllowSelfMutation === undefined) {
    delete process.env.ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION;
  } else {
    process.env.ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION = originalAllowSelfMutation;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempHome(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function fileSha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeSyncHostSingletonLock(args: {
  lockPath: string;
  pid: number;
  port: number;
  appName: string;
  quitCommand: string;
  packageChannel?: string | null;
  adeHome?: string;
  serviceName?: string;
}): void {
  const now = "2026-06-09T00:00:00.000Z";
  const adeHome = args.adeHome ?? path.join(os.homedir(), ".ade");
  fs.mkdirSync(path.dirname(args.lockPath), { recursive: true });
  fs.writeFileSync(
    args.lockPath,
    `${JSON.stringify({
      version: 1,
      owner: {
        id: "existing-brain",
        pid: args.pid,
        port: args.port,
        appName: args.appName,
        packageChannel: args.packageChannel ?? null,
        adeHome,
        serviceName: args.serviceName ?? "com.ade.runtime",
        socketPath: path.join(adeHome, "sock", "ade.sock"),
        projectRoot: "/Users/admin/Projects/ADE",
        commandLine: null,
        quitCommand: args.quitCommand,
        createdAt: now,
        updatedAt: now,
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

function currentLaunchdDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
  return `gui/${uid}/${ADE_RUNTIME_SERVICE_NAME}`;
}

describe("resolveAdeServeCommand", () => {
  it("uses node plus the CLI script when argv points at a real script", () => {
    process.argv[1] = path.resolve("src/cli.ts");

    expect(resolveAdeServeCommand()).toMatchObject({
      command: process.execPath,
      args: [path.resolve("src/cli.ts"), "serve"],
    });
  });

  it("uses the executable directly when SEA argv contains the synthetic CLI script name", () => {
    process.argv[1] = path.resolve("definitely-not-real-cli.cjs");

    expect(resolveAdeServeCommand()).toMatchObject({
      command: process.execPath,
      args: ["serve"],
    });
  });

  it("preserves NODE_PATH for standalone runtime sidecar dependencies", () => {
    process.argv[1] = path.resolve("definitely-not-real-cli.cjs");
    process.env.NODE_PATH = "/opt/ade/runtime/node_modules";
    process.env.ADE_RUNTIME_ROOT = "/opt/ade/runtime";
    process.env.ADE_RUNTIME_NODE_MODULES = "/opt/ade/runtime/node_modules";

    expect(resolveAdeServeCommand()).toMatchObject({
      command: process.execPath,
      args: ["serve"],
      env: {
        NODE_PATH: "/opt/ade/runtime/node_modules",
        ADE_RUNTIME_ROOT: "/opt/ade/runtime",
        ADE_RUNTIME_NODE_MODULES: "/opt/ade/runtime/node_modules",
      },
    });
  });

  it("preserves ADE_DEFAULT_ROLE for launch-managed runtime services", () => {
    process.argv[1] = path.resolve("definitely-not-real-cli.cjs");
    process.env.ADE_DEFAULT_ROLE = "cto";

    expect(resolveAdeServeCommand()).toMatchObject({
      command: process.execPath,
      args: ["serve"],
      env: {
        ADE_DEFAULT_ROLE: "cto",
      },
    });
  });

  it("sets the runtime build hash from the CLI script", () => {
    const tempDir = makeTempHome("ade-service-command-");
    const scriptPath = path.join(tempDir, "cli.cjs");
    fs.writeFileSync(scriptPath, "console.log('ade runtime')\n", "utf8");
    process.argv[1] = scriptPath;

    expect(resolveAdeServeCommand()).toMatchObject({
      command: process.execPath,
      args: [scriptPath, "serve"],
      env: {
        ADE_RUNTIME_BUILD_HASH: fileSha256(scriptPath),
      },
    });
  });

  it("sets the runtime build hash from a standalone executable entrypoint", () => {
    const tempDir = makeTempHome("ade-service-command-bin-");
    const binaryPath = path.join(tempDir, "ade");
    fs.writeFileSync(binaryPath, "ade runtime binary\n", "utf8");
    process.argv[1] = binaryPath;

    expect(resolveAdeServeCommand()).toMatchObject({
      command: binaryPath,
      args: ["serve"],
      env: {
        ADE_RUNTIME_BUILD_HASH: fileSha256(binaryPath),
      },
    });
  });

  it("does not hash node when the node serve fallback has no dist CLI", () => {
    const tempDir = makeTempHome("ade-service-command-no-dist-");
    process.argv[1] = path.join(tempDir, "missing-cli.cjs");

    const command = resolveAdeServeCommand();

    expect(command).toMatchObject({
      command: process.execPath,
      args: ["serve"],
    });
    expect(command.env?.ADE_RUNTIME_BUILD_HASH).toBeUndefined();
  });

  it("sets the runtime build hash from dist cli for the node serve fallback", () => {
    const tempDir = makeTempHome("ade-service-command-dist-");
    const srcDir = path.join(tempDir, "src");
    const distDir = path.join(tempDir, "dist");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, "package.json"), "{\"name\":\"ade-cli\"}\n", "utf8");
    fs.writeFileSync(path.join(srcDir, "cli.ts"), "export {}\n", "utf8");
    const distPath = path.join(distDir, "cli.cjs");
    fs.writeFileSync(distPath, "console.log('dist runtime')\n", "utf8");
    process.argv[1] = path.join(tempDir, "missing-cli.cjs");

    expect(resolveAdeServeCommand()).toMatchObject({
      command: process.execPath,
      args: ["serve"],
      env: {
        ADE_RUNTIME_BUILD_HASH: fileSha256(distPath),
      },
    });
  });
});

describe("isCurrentProcessDescendantOfPid", () => {
  it("detects when the current process descends from the target pid", () => {
    const parentPid = (pid: number) => ({
      400: 300,
      300: 100,
      100: 1,
    })[pid] ?? null;

    expect(isCurrentProcessDescendantOfPid({
      targetPid: 100,
      currentPid: 400,
      parentPid,
    })).toBe(true);
  });

  it("returns false when the current process is in an unrelated process tree", () => {
    expect(isCurrentProcessDescendantOfPid({
      targetPid: 100,
      currentPid: 400,
      parentPid: (pid) => ({
        400: 300,
        300: 1,
      })[pid] ?? null,
    })).toBe(false);
  });

  it("returns false for parent cycles", () => {
    expect(isCurrentProcessDescendantOfPid({
      targetPid: 100,
      currentPid: 400,
      parentPid: (pid) => ({
        400: 300,
        300: 200,
        200: 300,
      })[pid] ?? null,
    })).toBe(false);
  });
});

describe("isStaleChannelServeCommandLine", () => {
  const cliScriptPath = "/Applications/ADE Beta.app/Contents/Resources/ade-cli/cli.cjs";
  const primarySocketPath = "/Users/example/.ade-beta/sock/ade.sock";
  const opts = { cliScriptPath, primarySocketPath };
  const electron = "/Applications/ADE Beta.app/Contents/MacOS/ADE Beta";

  it("matches channel brains with and without an explicit primary socket", () => {
    expect(isStaleChannelServeCommandLine(`${electron} ${cliScriptPath} serve`, opts)).toBe(true);
    expect(isStaleChannelServeCommandLine(
      `${electron} ${cliScriptPath} serve --socket ${primarySocketPath}`,
      opts,
    )).toBe(true);
  });

  it("matches old ADE CLI builds when they explicitly serve this channel socket", () => {
    expect(isStaleChannelServeCommandLine(
      `/Applications/ADE.app/Contents/MacOS/ADE /Applications/ADE.app/Contents/Resources/ade-cli/cli.cjs serve --socket ${primarySocketPath}`,
      opts,
    )).toBe(true);
  });

  it("ignores isolated, installer, and foreign-socket runtimes", () => {
    expect(isStaleChannelServeCommandLine(`${electron} ${cliScriptPath} serve --no-sync`, opts)).toBe(false);
    expect(isStaleChannelServeCommandLine(`${electron} ${cliScriptPath} serve --install-service`, opts)).toBe(false);
    expect(isStaleChannelServeCommandLine(
      `${electron} ${cliScriptPath} serve --socket /tmp/ade-runtime-dev.sock`,
      opts,
    )).toBe(false);
    expect(isStaleChannelServeCommandLine(
      `${electron} ${cliScriptPath} serve --socket /Users/example/.ade-beta/sock/i-0c362cb4.sock --no-sync`,
      opts,
    )).toBe(false);
    expect(isStaleChannelServeCommandLine(
      `/Applications/ADE.app/Contents/MacOS/ADE /Applications/ADE.app/Contents/Resources/ade-cli/cli.cjs serve --socket ${primarySocketPath} --no-sync`,
      opts,
    )).toBe(false);
  });

  it("ignores other binaries and non-serve commands", () => {
    expect(isStaleChannelServeCommandLine(`${electron}`, opts)).toBe(false);
    expect(isStaleChannelServeCommandLine(`${electron} ${cliScriptPath} doctor`, opts)).toBe(false);
    expect(isStaleChannelServeCommandLine(
      "/Applications/ADE.app/Contents/Resources/ade-cli/cli.cjs serve",
      opts,
    )).toBe(false);
  });
});

describe("service manager status parsers", () => {
  it("detects running launchd services from launchctl print output", () => {
    expect(isLaunchdPrintRunning("state = running\npid = 123\n")).toBe(true);
    expect(isLaunchdPrintRunning("state = waiting\n")).toBe(false);
    expect(parseLaunchdPrintPid("state = running\npid = 123\n")).toBe(123);
    expect(parseLaunchdPrintPid("state = waiting\n")).toBeNull();
  });

  it("detects invariant Task Scheduler state values without parsing localized field labels", () => {
    expect(isWindowsTaskStateRunning("Running\r\n")).toBe(true);
    expect(isWindowsTaskStateRunning("Ready\r\n")).toBe(false);
    expect(isWindowsTaskStateRunning("Status: Running\r\n")).toBe(false);
  });
});

describe("launchd service rendering", () => {
  it("renders the launch agent path under the user home directory", () => {
    expect(launchAgentPath("/Users/example")).toBe(
      path.join("/Users/example", "Library", "LaunchAgents", `${ADE_RUNTIME_SERVICE_NAME}.plist`),
    );
  });

  it("renders plist content with escaped command, logs, and environment values", () => {
    const plist = renderLaunchdPlist({
      command: "/Applications/ADE & Tools/ade",
      args: ["serve", "--name", "A<B"],
      env: {
        NODE_PATH: "/opt/ADE & deps",
        ADE_HOME: "/Users/example/'ade'",
      },
    }, "/Users/example");

    expect(plist).toContain(`<string>${ADE_RUNTIME_SERVICE_NAME}</string>`);
    expect(plist).toContain("<key>ProgramArguments</key>");
    expect(plist).toContain("<string>/Applications/ADE &amp; Tools/ade</string>");
    expect(plist).toContain("<string>A&lt;B</string>");
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>NODE_PATH</key>");
    expect(plist).toContain("<string>/opt/ADE &amp; deps</string>");
    expect(plist).toContain("<key>ADE_HOME</key>");
    expect(plist).toContain("<string>/Users/example/&apos;ade&apos;</string>");
    expect(plist).toContain(
      `<string>${path.join("/Users/example/'ade'", "runtime", "launchd.out.log").replace(/'/g, "&apos;")}</string>`,
    );
    expect(plist).toContain(
      `<string>${path.join("/Users/example/'ade'", "runtime", "launchd.err.log").replace(/'/g, "&apos;")}</string>`,
    );
  });
});

describe("launchd service install", () => {
  const serviceCommand: AdeServiceCommand = {
    command: "/Applications/ADE.app/Contents/MacOS/ade",
    args: ["serve"],
    env: { NODE_PATH: "/opt/ade/node_modules" },
  };
  const install = (
    deps: NonNullable<Parameters<typeof installLaunchdService>[0]>,
  ) => installLaunchdService({
    responsivenessProbe: () => true,
    ...deps,
  });

  it("writes the plist and loads the launch agent", async () => {
    const homeDir = makeTempHome("ade-launchd-install-");
    const servicePath = launchAgentPath(homeDir);
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ]);

    const result = await install({ command: serviceCommand, spawnSync, homeDir });

    expect(result).toMatchObject({
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: servicePath,
    });
    expect(fs.readFileSync(servicePath, "utf8")).toBe(renderLaunchdPlist(serviceCommand, homeDir));
    expect(calls).toEqual([
      { command: "launchctl", args: ["print", currentLaunchdDomain()] },
      { command: "launchctl", args: ["unload", servicePath] },
      { command: "ps", args: ["-axo", "pid=,command="] },
      { command: "launchctl", args: ["load", servicePath] },
    ]);
  });

  it("leaves an unchanged running launch agent loaded", async () => {
    const homeDir = makeTempHome("ade-launchd-running-");
    const servicePath = launchAgentPath(homeDir);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, renderLaunchdPlist(serviceCommand, homeDir), "utf8");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "state = running\n", stderr: "" },
    ]);

    const result = await install({ command: serviceCommand, spawnSync, homeDir });

    expect(result).toMatchObject({
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: servicePath,
      message: "ADE service launchd service is already installed and running.",
    });
    expect(calls).toEqual([
      { command: "launchctl", args: ["print", currentLaunchdDomain()] },
    ]);
  });

  it("reinstalls an unchanged running launch agent when its runtime socket is wedged", async () => {
    const homeDir = makeTempHome("ade-launchd-wedged-");
    const servicePath = launchAgentPath(homeDir);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, renderLaunchdPlist(serviceCommand, homeDir), "utf8");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "state = running\npid = 1234\n", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ]);
    const responsivenessProbe = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    const result = await install({
      command: serviceCommand,
      spawnSync,
      homeDir,
      responsivenessProbe,
      currentPid: 9999,
      parentPid: () => null,
      handoverPidAlive: () => false,
      terminateDeps: { kill: () => {}, pidAlive: () => false },
    });

    expect(result.ok).toBe(true);
    expect(responsivenessProbe).toHaveBeenCalledTimes(2);
    expect(calls.map((call) => call.args[0])).toEqual([
      "print",
      "unload",
      "-axo",
      "load",
    ]);
  });

  it("returns a typed failure when the replacement never becomes responsive", async () => {
    const homeDir = makeTempHome("ade-launchd-handover-fail-");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ]);

    const result = await install({
      command: serviceCommand,
      spawnSync,
      homeDir,
      responsivenessProbe: () => false,
      handoverPidAlive: () => false,
      handoverTimeoutMs: 0,
    });

    expect(result).toMatchObject({
      ok: false,
      action: "install",
      failureStep: "replacement_responsive",
    });
  });

  it("reloads an unchanged running launch agent when a packaged trust reset requests it", async () => {
    const homeDir = makeTempHome("ade-launchd-trust-reset-");
    const servicePath = launchAgentPath(homeDir);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, renderLaunchdPlist(serviceCommand, homeDir), "utf8");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "state = running\npid = 1234\n", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ]);

    const result = await install({
      command: serviceCommand,
      spawnSync,
      homeDir,
      env: { ...process.env, ADE_FORCE_RUNTIME_SERVICE_RESTART: "1" },
      currentPid: 9999,
      parentPid: () => null,
      terminateDeps: { kill: () => {}, pidAlive: () => false },
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { command: "launchctl", args: ["print", currentLaunchdDomain()] },
      { command: "launchctl", args: ["unload", servicePath] },
      { command: "ps", args: ["-axo", "pid=,command="] },
      { command: "launchctl", args: ["load", servicePath] },
    ]);
  });

  it("reloads an unchanged launch agent when it is loaded but stopped", async () => {
    const homeDir = makeTempHome("ade-launchd-stopped-");
    const servicePath = launchAgentPath(homeDir);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, renderLaunchdPlist(serviceCommand, homeDir), "utf8");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "state = waiting\n", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ]);

    const result = await install({ command: serviceCommand, spawnSync, homeDir });

    expect(result).toMatchObject({
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: servicePath,
    });
    expect(calls).toEqual([
      { command: "launchctl", args: ["print", currentLaunchdDomain()] },
      { command: "launchctl", args: ["unload", servicePath] },
      { command: "ps", args: ["-axo", "pid=,command="] },
      { command: "launchctl", args: ["load", servicePath] },
    ]);
  });

  it("does not load a launch agent when another channel's brain hosts sync", async () => {
    const homeDir = makeTempHome("ade-launchd-conflict-");
    const servicePath = launchAgentPath(homeDir);
    const lockPath = path.join(homeDir, "sync-host-lock.json");
    const existingPid = 1234;
    writeSyncHostSingletonLock({
      lockPath,
      pid: existingPid,
      port: 8801,
      appName: "ADE Beta",
      packageChannel: "beta",
      adeHome: path.join(os.homedir(), ".ade-beta"),
      serviceName: "com.ade.runtime.beta",
      quitCommand: "ADE_PACKAGE_CHANNEL=beta ADE_HOME='/Users/example/.ade-beta' '/Applications/ADE Beta.app/Contents/Resources/ade-cli/bin/ade-beta' brain stop --text",
    });
    const calls: Array<{ command: string; args: string[] }> = [];
    const killed: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    const spawnSync = spawnSequence(calls, []);

    const result = await install({
      command: serviceCommand,
      spawnSync,
      homeDir,
      env: { ...process.env, ADE_HOME: path.join(homeDir, ".ade") },
      syncHostSingletonDeps: {
        lockPath,
        pidAlive: (pid) => pid === existingPid,
        scanListeners: () => [],
      },
      terminateDeps: {
        kill: (pid, signal) => killed.push({ pid, signal }),
        pidAlive: () => false,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: servicePath,
    });
    expect(result.message).toContain("Another ADE brain is already hosting mobile sync on port 8801.");
    expect(result.message).toContain(
      process.platform === "win32"
        ? `Stop-Process -Id ${existingPid}`
        : "brain stop --text",
    );
    expect(killed).toEqual([]);
    expect(calls).toEqual([
      { command: "launchctl", args: ["print", currentLaunchdDomain()] },
    ]);
    expect(fs.existsSync(servicePath)).toBe(true);
    expect(fs.readFileSync(servicePath, "utf8")).toBe(renderLaunchdPlist(serviceCommand, homeDir));
  });

  it("reaps a stale same-channel sync brain and installs anyway", async () => {
    const homeDir = makeTempHome("ade-launchd-reap-");
    const adeHome = path.join(homeDir, ".ade");
    const servicePath = launchAgentPath(homeDir);
    const lockPath = path.join(homeDir, "sync-host-lock.json");
    const existingPid = 1234;
    writeSyncHostSingletonLock({
      lockPath,
      pid: existingPid,
      port: 8801,
      appName: "ADE",
      adeHome,
      quitCommand: "ADE_HOME='/Users/example/.ade' '/Applications/ADE.app/Contents/Resources/ade-cli/bin/ade' brain stop --text",
    });
    const calls: Array<{ command: string; args: string[] }> = [];
    const killed: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    const spawnSync = spawnSequence(calls, []);

    const result = await install({
      command: serviceCommand,
      spawnSync,
      homeDir,
      env: { ...process.env, ADE_HOME: adeHome },
      syncHostSingletonDeps: {
        lockPath,
        pidAlive: (pid) => pid === existingPid,
        scanListeners: () => [],
      },
      terminateDeps: {
        kill: (pid, signal) => killed.push({ pid, signal }),
        pidAlive: () => false,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: servicePath,
    });
    expect(killed).toEqual([{ pid: existingPid, signal: "SIGTERM" }]);
    expect(calls.map((call) => [call.command, call.args[0]])).toEqual([
      ["launchctl", "print"],
      ["launchctl", "unload"],
      ["ps", "-axo"],
      ["launchctl", "load"],
    ]);
  });

  it("terminates the previous service child and stale serve processes on restart", async () => {
    const homeDir = makeTempHome("ade-launchd-sweep-");
    const adeHome = path.join(homeDir, ".ade");
    const staleServeLine = `  4242 ${serviceCommand.command} serve --socket ${path.join(adeHome, "sock", "ade.sock")}`;
    const calls: Array<{ command: string; args: string[] }> = [];
    const killed: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "state = running\npid = 9876\n", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: `${staleServeLine}\n  4243 ${serviceCommand.command} serve --no-sync\n`, stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ]);

    const result = await install({
      command: serviceCommand,
      spawnSync,
      homeDir,
      env: { ...process.env, ADE_HOME: adeHome },
      parentPid: () => null,
      terminateDeps: {
        kill: (pid, signal) => killed.push({ pid, signal }),
        pidAlive: () => false,
      },
    });

    expect(result.ok).toBe(true);
    expect(killed).toEqual([
      { pid: 9876, signal: "SIGTERM" },
      { pid: 4242, signal: "SIGTERM" },
    ]);
  });

  it("refuses to restart a launch agent from a descendant of the loaded service", async () => {
    const homeDir = makeTempHome("ade-launchd-self-install-");
    const servicePath = launchAgentPath(homeDir);
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "state = running\npid = 100\n", stderr: "" },
    ]);
    const parentPid = (pid: number) => ({
      400: 300,
      300: 100,
      100: 1,
    })[pid] ?? null;

    const result = await install({
      command: serviceCommand,
      spawnSync,
      homeDir,
      currentPid: 400,
      parentPid,
      terminateDeps: {
        kill: () => {},
        pidAlive: () => false,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: servicePath,
    });
    expect(result.message).toContain("Refusing to restart ADE brain");
    expect(calls).toEqual([
      { command: "launchctl", args: ["print", currentLaunchdDomain()] },
    ]);
    expect(fs.existsSync(servicePath)).toBe(false);
  });

  it("allows launch agent restart from a descendant when self-mutation is explicitly enabled", async () => {
    const homeDir = makeTempHome("ade-launchd-self-install-override-");
    const servicePath = launchAgentPath(homeDir);
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "state = running\npid = 100\n", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ]);
    const parentPid = (pid: number) => ({
      400: 300,
      300: 100,
      100: 1,
    })[pid] ?? null;
    process.env.ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION = "1";

    const result = await install({
      command: serviceCommand,
      spawnSync,
      homeDir,
      currentPid: 400,
      parentPid,
      terminateDeps: {
        kill: () => {},
        pidAlive: () => false,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: servicePath,
    });
    expect(fs.existsSync(servicePath)).toBe(true);
    expect(calls.map((call) => call.args[0])).toEqual(["print", "unload", "-axo", "load"]);
  });

  it("refuses to uninstall a launch agent from a descendant of the loaded service", () => {
    const homeDir = makeTempHome("ade-launchd-self-uninstall-");
    const servicePath = launchAgentPath(homeDir);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, renderLaunchdPlist(serviceCommand, homeDir), "utf8");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "state = running\npid = 100\n", stderr: "" },
    ]);
    const parentPid = (pid: number) => ({
      400: 300,
      300: 100,
      100: 1,
    })[pid] ?? null;

    const result = uninstallLaunchdService({
      spawnSync,
      homeDir,
      currentPid: 400,
      parentPid,
    });

    expect(result).toMatchObject({
      ok: false,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "uninstall",
      path: servicePath,
    });
    expect(result.message).toContain("Refusing to stop ADE brain");
    expect(calls).toEqual([
      { command: "launchctl", args: ["print", currentLaunchdDomain()] },
    ]);
    expect(fs.existsSync(servicePath)).toBe(true);
  });

  it("allows launch agent uninstall from a descendant when self-mutation is explicitly enabled", () => {
    const homeDir = makeTempHome("ade-launchd-self-uninstall-override-");
    const servicePath = launchAgentPath(homeDir);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, renderLaunchdPlist(serviceCommand, homeDir), "utf8");
    const calls: Array<{ command: string; args: string[] }> = [];
    const killed: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "state = running\npid = 100\n", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ]);
    const parentPid = (pid: number) => ({
      400: 300,
      300: 100,
      100: 1,
    })[pid] ?? null;
    process.env.ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION = "1";

    const result = uninstallLaunchdService({
      spawnSync,
      homeDir,
      currentPid: 400,
      parentPid,
      terminateDeps: {
        kill: (pid, signal) => killed.push({ pid, signal }),
        pidAlive: () => false,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "uninstall",
      path: servicePath,
    });
    expect(calls.map((call) => call.args[0])).toEqual(["print", "bootout", "bootout", "unload"]);
    expect(killed).toEqual([{ pid: 100, signal: "SIGTERM" }]);
    expect(fs.existsSync(servicePath)).toBe(false);
  });

  it("surfaces launchctl load failures", async () => {
    const homeDir = makeTempHome("ade-launchd-fail-");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 5, stdout: "", stderr: "Load failed" },
    ]);

    const result = await install({ command: serviceCommand, spawnSync, homeDir });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("Load failed");
    expect(calls.map((call) => call.args[0])).toEqual(["print", "unload", "-axo", "load"]);
  });
});

describe("systemd service rendering", () => {
  it("renders the user service path under the home directory", () => {
    expect(systemdServicePath("/home/example")).toBe(
      path.join("/home/example", ".config", "systemd", "user", `${ADE_RUNTIME_SERVICE_NAME}.service`),
    );
  });

  it("renders unit content with quoted ExecStart and escaped environment values", () => {
    const unit = renderSystemdUnit({
      command: "/opt/ADE CLI/node",
      args: ["/opt/ade/cli.cjs", "serve"],
      env: {
        NODE_PATH: "/tmp/100%/node modules",
        ADE_HOME: "/home/example/ade path\\with\"quotes",
      },
    });

    expect(unit).toContain("Description=ADE runtime service");
    expect(unit).toContain("Type=simple");
    expect(unit).toContain("ExecStart='/opt/ADE CLI/node' '/opt/ade/cli.cjs' 'serve'");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("Environment=\"NODE_PATH=/tmp/100%%/node modules\"");
    expect(unit).toContain("Environment=\"ADE_HOME=/home/example/ade path\\\\with\\\"quotes\"");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("quotes systemd environment assignments for whitespace, backslashes, quotes, and percent signs", () => {
    expect(renderSystemdEnvironment("NODE_PATH", "C:\\ADE deps\\100% \"runtime\"")).toBe(
      "Environment=\"NODE_PATH=C:\\\\ADE deps\\\\100%% \\\"runtime\\\"\"",
    );
  });
});

describe("systemd service install", () => {
  const serviceCommand: AdeServiceCommand = {
    command: "/opt/ade/bin/ade",
    args: ["serve"],
    env: { NODE_PATH: "/opt/ade/node_modules" },
  };

  it("writes the user unit and enables it immediately", () => {
    const homeDir = makeTempHome("ade-systemd-install-");
    const targetPath = systemdServicePath(homeDir);
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ]);

    const result = installSystemdService({ command: serviceCommand, spawnSync, homeDir });

    expect(result).toMatchObject({
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: targetPath,
    });
    expect(fs.readFileSync(targetPath, "utf8")).toBe(renderSystemdUnit(serviceCommand));
    expect(calls).toEqual([
      { command: "systemctl", args: ["--user", "daemon-reload"] },
      { command: "systemctl", args: ["--user", "enable", "--now", `${ADE_RUNTIME_SERVICE_NAME}.service`] },
      { command: "systemctl", args: ["--user", "restart", `${ADE_RUNTIME_SERVICE_NAME}.service`] },
    ]);
  });

  it("does not enable when daemon-reload fails", () => {
    const homeDir = makeTempHome("ade-systemd-reload-fail-");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 1, stdout: "", stderr: "reload failed" },
    ]);

    const result = installSystemdService({ command: serviceCommand, spawnSync, homeDir });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("reload failed");
    expect(calls).toEqual([
      { command: "systemctl", args: ["--user", "daemon-reload"] },
    ]);
  });

  it("surfaces enable failures after a successful reload", () => {
    const homeDir = makeTempHome("ade-systemd-enable-fail-");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "", stderr: "" },
      { status: 1, stdout: "", stderr: "enable failed" },
    ]);

    const result = installSystemdService({ command: serviceCommand, spawnSync, homeDir });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("enable failed");
    expect(calls.map((call) => call.args)).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "enable", "--now", `${ADE_RUNTIME_SERVICE_NAME}.service`],
    ]);
  });

  it("surfaces restart failures after enabling the user unit", () => {
    const homeDir = makeTempHome("ade-systemd-restart-fail-");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 1, stdout: "", stderr: "restart failed" },
    ]);

    const result = installSystemdService({ command: serviceCommand, spawnSync, homeDir });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("restart failed");
    expect(calls.map((call) => call.args)).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "enable", "--now", `${ADE_RUNTIME_SERVICE_NAME}.service`],
      ["--user", "restart", `${ADE_RUNTIME_SERVICE_NAME}.service`],
    ]);
  });
});


function spawnSequence(
  calls: Array<{ command: string; args: string[] }>,
  results: ServiceManagerProcessResult[],
): ServiceManagerSpawnSync {
  let loadSeen = false;
  return (command, args) => {
    const next = results.shift();
    if (
      !next
      && loadSeen
      && command === "launchctl"
      && args[0] === "print"
    ) {
      return { status: 0, stdout: "state = running\npid = 7777\n", stderr: "" };
    }
    calls.push({ command, args });
    if (command === "launchctl" && args[0] === "load") loadSeen = true;
    return next ?? { status: 0, stdout: "", stderr: "" };
  };
}

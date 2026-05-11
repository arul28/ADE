import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADE_RUNTIME_SERVICE_NAME,
  renderCommand,
  resolveAdeServeCommand,
  type AdeServiceCommand,
  type ServiceManagerProcessResult,
  type ServiceManagerSpawnSync,
} from "./common";
import { installLaunchdService, isLaunchdPrintRunning, launchAgentPath, renderLaunchdPlist } from "./installLaunchd";
import { installSystemdService, renderSystemdUnit, servicePath as systemdServicePath } from "./installSystemd";
import {
  buildWindowsCreateTaskArgs,
  buildWindowsQueryTaskArgs,
  buildWindowsRunTaskArgs,
  installWindowsService,
  isSchtasksOutputRunning,
  parseSchtasksListStatus,
  TASK_NAME,
} from "./installWindows";

const originalArgv = [...process.argv];
const originalNodePath = process.env.NODE_PATH;
const tempDirs: string[] = [];

afterEach(() => {
  process.argv.splice(0, process.argv.length, ...originalArgv);
  if (originalNodePath === undefined) delete process.env.NODE_PATH;
  else process.env.NODE_PATH = originalNodePath;
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

    expect(resolveAdeServeCommand()).toMatchObject({
      command: process.execPath,
      args: ["serve"],
      env: {
        NODE_PATH: "/opt/ade/runtime/node_modules",
      },
    });
  });
});

describe("service manager status parsers", () => {
  it("detects running launchd services from launchctl print output", () => {
    expect(isLaunchdPrintRunning("state = running\npid = 123\n")).toBe(true);
    expect(isLaunchdPrintRunning("state = waiting\n")).toBe(false);
  });

  it("detects running Windows scheduled tasks from schtasks output", () => {
    expect(isSchtasksOutputRunning("TaskName: ADE Runtime\r\nStatus: Running\r\n")).toBe(true);
    expect(isSchtasksOutputRunning("TaskName: ADE Runtime\r\nStatus: Ready\r\n")).toBe(false);
  });

  it("parses Windows scheduled task status from schtasks LIST output", () => {
    expect(parseSchtasksListStatus("TaskName: ADE Runtime\r\nStatus: Ready\r\n")).toBe("Ready");
    expect(parseSchtasksListStatus("TaskName: ADE Runtime\r\n")).toBeNull();
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
    expect(plist).toContain(`<string>${path.join("/Users/example", ".ade", "runtime", "launchd.out.log")}</string>`);
    expect(plist).toContain(`<string>${path.join("/Users/example", ".ade", "runtime", "launchd.err.log")}</string>`);
  });
});

describe("launchd service install", () => {
  const serviceCommand: AdeServiceCommand = {
    command: "/Applications/ADE.app/Contents/MacOS/ade",
    args: ["serve"],
    env: { NODE_PATH: "/opt/ade/node_modules" },
  };

  it("writes the plist and loads the launch agent", () => {
    const homeDir = makeTempHome("ade-launchd-install-");
    const servicePath = launchAgentPath(homeDir);
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ]);

    const result = installLaunchdService({ command: serviceCommand, spawnSync, homeDir });

    expect(result).toMatchObject({
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: servicePath,
    });
    expect(fs.readFileSync(servicePath, "utf8")).toBe(renderLaunchdPlist(serviceCommand, homeDir));
    expect(calls).toEqual([
      { command: "launchctl", args: ["unload", servicePath] },
      { command: "launchctl", args: ["load", servicePath] },
    ]);
  });

  it("surfaces launchctl load failures", () => {
    const homeDir = makeTempHome("ade-launchd-fail-");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "", stderr: "" },
      { status: 5, stdout: "", stderr: "Load failed" },
    ]);

    const result = installLaunchdService({ command: serviceCommand, spawnSync, homeDir });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("Load failed");
    expect(calls.map((call) => call.args[0])).toEqual(["unload", "load"]);
  });
});

describe("systemd service rendering", () => {
  it("renders the user service path under the home directory", () => {
    expect(systemdServicePath("/home/example")).toBe(
      path.join("/home/example", ".config", "systemd", "user", "ade-runtime.service"),
    );
  });

  it("renders unit content with quoted ExecStart and escaped percent environment values", () => {
    const unit = renderSystemdUnit({
      command: "/opt/ADE CLI/node",
      args: ["/opt/ade/cli.cjs", "serve"],
      env: {
        NODE_PATH: "/tmp/100%/node_modules",
      },
    });

    expect(unit).toContain("Description=ADE service daemon");
    expect(unit).toContain("Type=simple");
    expect(unit).toContain("ExecStart='/opt/ADE CLI/node' '/opt/ade/cli.cjs' 'serve'");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("Environment=NODE_PATH=/tmp/100%%/node_modules");
    expect(unit).toContain("WantedBy=default.target");
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
      { command: "systemctl", args: ["--user", "enable", "--now", "ade-runtime.service"] },
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
      ["--user", "enable", "--now", "ade-runtime.service"],
    ]);
  });
});

describe("Windows scheduled task helpers", () => {
  const serviceCommand: AdeServiceCommand = {
    command: "C:\\Program Files\\ADE\\ade.exe",
    args: ["serve"],
  };

  it("builds schtasks create, run, and query arguments without invoking schtasks", () => {
    const renderedCommand = renderCommand(serviceCommand);

    expect(buildWindowsCreateTaskArgs(renderedCommand)).toEqual([
      "/Create",
      "/SC",
      "ONLOGON",
      "/TN",
      TASK_NAME,
      "/TR",
      renderedCommand,
      "/F",
    ]);
    expect(buildWindowsRunTaskArgs()).toEqual(["/Run", "/TN", TASK_NAME]);
    expect(buildWindowsQueryTaskArgs()).toEqual(["/Query", "/TN", TASK_NAME, "/FO", "LIST", "/V"]);
  });

  it("starts the scheduled task immediately after a successful create", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "SUCCESS: created", stderr: "" },
      { status: 0, stdout: "SUCCESS: attempted to run", stderr: "" },
    ]);

    const result = installWindowsService({ command: serviceCommand, spawnSync });

    expect(result).toMatchObject({
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: TASK_NAME,
      message: "ADE service scheduled task installed and started.",
    });
    expect(calls).toEqual([
      { command: "schtasks.exe", args: buildWindowsCreateTaskArgs(renderCommand(serviceCommand)) },
      { command: "schtasks.exe", args: buildWindowsRunTaskArgs() },
    ]);
  });

  it("surfaces a clear install failure when create succeeds but immediate start fails", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "SUCCESS: created", stderr: "" },
      { status: 1, stdout: "", stderr: "ERROR: access is denied" },
    ]);

    const result = installWindowsService({ command: serviceCommand, spawnSync });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("ADE service scheduled task installed, but failed to start: ERROR: access is denied");
    expect(calls.map((call) => call.args)).toEqual([
      buildWindowsCreateTaskArgs(renderCommand(serviceCommand)),
      buildWindowsRunTaskArgs(),
    ]);
  });

  it("does not try to run the task when create fails", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 1, stdout: "", stderr: "ERROR: create failed" },
    ]);

    const result = installWindowsService({ command: serviceCommand, spawnSync });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("ERROR: create failed");
    expect(calls).toHaveLength(1);
  });
});

function spawnSequence(
  calls: Array<{ command: string; args: string[] }>,
  results: ServiceManagerProcessResult[],
): ServiceManagerSpawnSync {
  return (command, args) => {
    calls.push({ command, args });
    return results.shift() ?? { status: 0, stdout: "", stderr: "" };
  };
}

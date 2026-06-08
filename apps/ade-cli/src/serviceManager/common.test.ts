import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADE_RUNTIME_SERVICE_NAME,
  renderCommand,
  renderWindowsCommand,
  resolveAdeServeCommand,
  type AdeServiceCommand,
  type ServiceManagerProcessResult,
  type ServiceManagerSpawnSync,
} from "./common";
import { installLaunchdService, isLaunchdPrintRunning, launchAgentPath, renderLaunchdPlist } from "./installLaunchd";
import { installSystemdService, renderSystemdEnvironment, renderSystemdUnit, servicePath as systemdServicePath } from "./installSystemd";
import {
  buildWindowsCreateTaskArgs,
  buildWindowsDeleteTaskArgs,
  buildWindowsQueryTaskArgs,
  buildWindowsRunTaskArgs,
  installWindowsService,
  isSchtasksOutputRunning,
  parseSchtasksListStatus,
  resolveWindowsTaskUser,
  TASK_NAME,
  uninstallWindowsService,
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

function fileSha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
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
    expect(plist).toContain("<string>/Users/example/&apos;ade&apos;/runtime/launchd.out.log</string>");
    expect(plist).toContain("<string>/Users/example/&apos;ade&apos;/runtime/launchd.err.log</string>");
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

describe("Windows scheduled task helpers", () => {
  const serviceCommand: AdeServiceCommand = {
    command: "C:\\Program Files\\ADE\\ade.exe",
    args: ["serve"],
  };
  const taskUser = "ADEBOX\\arul";

  it("builds schtasks create, run, query, and delete arguments without invoking schtasks", () => {
    const renderedCommand = renderWindowsCommand(serviceCommand);

    expect(buildWindowsCreateTaskArgs(renderedCommand, taskUser)).toEqual([
      "/Create",
      "/SC",
      "ONLOGON",
      "/TN",
      TASK_NAME,
      "/TR",
      renderedCommand,
      "/RU",
      taskUser,
      "/IT",
      "/F",
    ]);
    expect(buildWindowsRunTaskArgs()).toEqual(["/Run", "/TN", TASK_NAME]);
    expect(buildWindowsQueryTaskArgs()).toEqual(["/Query", "/TN", TASK_NAME, "/FO", "LIST", "/V"]);
    expect(buildWindowsDeleteTaskArgs()).toEqual(["/Delete", "/TN", TASK_NAME, "/F"]);
  });

  it("resolves the Windows scheduled task user from domain and username environment values", () => {
    expect(resolveWindowsTaskUser({ USERDOMAIN: "ADEBOX", USERNAME: "arul" })).toBe("ADEBOX\\arul");
    expect(resolveWindowsTaskUser({ USERNAME: "LOCALUSER" })).toBe("LOCALUSER");
    expect(resolveWindowsTaskUser({ USERDOMAIN: "ADEBOX", USERNAME: "ADEBOX\\arul" })).toBe("ADEBOX\\arul");
  });

  it("renders Windows scheduled task commands with double-quoted argv tokens", () => {
    expect(renderWindowsCommand({
      command: "C:\\Program Files\\ADE\\ade.exe",
      args: ["serve", "--root", "C:\\path with space\\"],
    })).toBe("\"C:\\Program Files\\ADE\\ade.exe\" \"serve\" \"--root\" \"C:\\path with space\\\\\"");
    expect(renderCommand(serviceCommand)).toBe("'C:\\Program Files\\ADE\\ade.exe' 'serve'");
  });

  it("rejects embedded double quotes in Windows scheduled task command tokens", () => {
    expect(() => renderWindowsCommand({
      command: "C:\\Program Files\\ADE\\ade.exe",
      args: ["serve", "--name", "quoted \"value\""],
    })).toThrow("Windows service command arguments cannot contain double quotes.");
  });

  it("starts the scheduled task immediately after a successful create", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "SUCCESS: created", stderr: "" },
      { status: 0, stdout: "SUCCESS: attempted to run", stderr: "" },
    ]);

    const result = installWindowsService({ command: serviceCommand, spawnSync, userName: taskUser });

    expect(result).toMatchObject({
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: TASK_NAME,
      message: "ADE service scheduled task installed and started.",
    });
    expect(calls).toEqual([
      { command: "schtasks.exe", args: buildWindowsCreateTaskArgs(renderWindowsCommand(serviceCommand), taskUser) },
      { command: "schtasks.exe", args: buildWindowsRunTaskArgs() },
    ]);
  });

  it("surfaces a clear install failure when create succeeds but immediate start fails", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "SUCCESS: created", stderr: "" },
      { status: 1, stdout: "", stderr: "ERROR: access is denied" },
    ]);

    const result = installWindowsService({ command: serviceCommand, spawnSync, userName: taskUser });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("ADE service scheduled task installed, but failed to start: ERROR: access is denied");
    expect(calls.map((call) => call.args)).toEqual([
      buildWindowsCreateTaskArgs(renderWindowsCommand(serviceCommand), taskUser),
      buildWindowsRunTaskArgs(),
    ]);
  });

  it("does not try to run the task when create fails", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 1, stdout: "", stderr: "ERROR: create failed" },
    ]);

    const result = installWindowsService({ command: serviceCommand, spawnSync, userName: taskUser });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("ERROR: create failed");
    expect(calls).toHaveLength(1);
  });

  it("reports successful scheduled task removal", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "SUCCESS: deleted", stderr: "" },
    ]);

    const result = uninstallWindowsService({ spawnSync });

    expect(result).toMatchObject({
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "uninstall",
      path: TASK_NAME,
      message: "ADE service scheduled task removed.",
    });
    expect(calls).toEqual([
      { command: "schtasks.exe", args: buildWindowsDeleteTaskArgs() },
    ]);
  });

  it("surfaces scheduled task removal failures", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." },
    ]);

    const result = uninstallWindowsService({ spawnSync });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("ERROR: The system cannot find the file specified.");
    expect(calls).toEqual([
      { command: "schtasks.exe", args: buildWindowsDeleteTaskArgs() },
    ]);
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

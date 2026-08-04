import fs from "node:fs";
import { spawnSync as spawnChildSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  renderCommand,
  renderWindowsCommand,
  resolveRuntimeServiceName,
  type AdeServiceCommand,
  type ServiceManagerProcessResult,
  type ServiceManagerSpawnSync,
} from "./common";
import {
  buildWindowsCreateTaskArgs,
  buildWindowsDeleteTaskArgs,
  buildWindowsEndTaskArgs,
  buildWindowsQueryTaskActionArgs,
  buildWindowsQueryTaskArgs,
  buildWindowsRunKeyAddArgs,
  buildWindowsRunKeyDeleteArgs,
  buildWindowsRunKeyQueryArgs,
  buildWindowsRunTaskArgs,
  buildWindowsStartLauncherArgs,
  buildWindowsStartTaskArgs,
  buildWindowsWmiStartArgs,
  getWindowsServiceStatus,
  installWindowsService,
  isWindowsLegacyTaskOwnedByCommand,
  readWindowsServicePidRecord,
  resolveWindowsServiceLauncherPath,
  resolveWindowsStartTaskName,
  resolveWindowsTaskName,
  resolveWindowsTaskUser,
  uninstallWindowsService,
  WINDOWS_POWERSHELL_COMMAND,
  WINDOWS_REG_COMMAND,
  WINDOWS_SCHTASKS_COMMAND,
  WINDOWS_TASK_ACTION_FIELD_SEPARATOR,
  WINDOWS_TASKKILL_COMMAND,
  renderWindowsServiceLauncher,
} from "./installWindows";

const tempDirs: string[] = [];

afterEach(() => {
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

function spawnSequence(
  calls: Array<{ command: string; args: string[] }>,
  results: ServiceManagerProcessResult[],
): ServiceManagerSpawnSync {
  return (command, args) => {
    calls.push({ command, args });
    return results.shift() ?? { status: 0, stdout: "", stderr: "" };
  };
}

describe("Windows background service helpers", () => {
  const serviceCommand: AdeServiceCommand = {
    command: "C:\\Program Files\\ADE\\ade.exe",
    args: ["C:\\Program Files\\ADE\\resources\\ade-cli\\cli.cjs", "serve"],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      NODE_PATH: "C:\\Program Files\\ADE\\resources\\ade-cli\\node_modules",
      ADE_HOME: "C:\\Users\\arul\\.ade-beta",
      ADE_PACKAGE_CHANNEL: "beta",
    },
  };
  const taskUser = "ADEBOX\\arul";
  const serviceName = "com.ade.runtime.beta";
  const taskName = resolveWindowsTaskName({ serviceName, userName: taskUser });
  const readyPidRecord = {
    supervisorPid: 1234,
    runtimePid: 5678,
    runtimeStartedAtMs: Date.now(),
    restartCount: 0,
    lastExitCode: null,
    lastExitAt: null,
    nextRestartAt: null,
    lastLaunchError: null,
    sessionBound: false,
  };
  const immediateReadiness = {
    readPidRecord: () => readyPidRecord,
    readinessProbe: () => ({ ready: true, diagnostic: "ready" }),
  };
  // Get-ScheduledTask reports each action as an Execute/Arguments pair; the
  // helper emits them unit-separator delimited in that order.
  function taskActionOutput(execute: string, argumentsText: string): string {
    return [execute, argumentsText].join(WINDOWS_TASK_ACTION_FIELD_SEPARATOR);
  }
  // A legacy `ADE Runtime` task that this Beta install created before the
  // channel-scoped naming scheme existed.
  const ownLegacyAction = taskActionOutput(
    "C:\\Program Files\\ADE\\ade.exe",
    "\"C:\\Program Files\\ADE\\resources\\ade-cli\\cli.cjs\" \"serve\"",
  );
  // A legacy `ADE Runtime` task owned by a side-by-side Stable install.
  const stableLegacyAction = taskActionOutput(
    "C:\\Program Files\\ADE Stable\\ADE.exe",
    "\"C:\\Program Files\\ADE Stable\\resources\\ade-cli\\cli.cjs\" \"serve\"",
  );

  it("builds schtasks create, run, query, and delete arguments without invoking schtasks", () => {
    const renderedCommand = renderWindowsCommand({
      command: WINDOWS_POWERSHELL_COMMAND,
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\Users\\arul\\.ade-beta\\runtime\\brain-service.ps1",
      ],
    });

    expect(buildWindowsCreateTaskArgs(renderedCommand, taskUser, taskName)).toEqual([
      "/Create",
      "/SC",
      "ONLOGON",
      "/TN",
      taskName,
      "/TR",
      renderedCommand,
      "/RU",
      taskUser,
      "/IT",
      "/F",
    ]);
    expect(buildWindowsRunTaskArgs(taskName)).toEqual(["/Run", "/TN", taskName]);
    expect(buildWindowsEndTaskArgs(taskName)).toEqual(["/End", "/TN", taskName]);
    expect(buildWindowsQueryTaskArgs(taskName)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      expect.stringContaining(`$_.TaskName -eq '${taskName}'`),
    ]);
    expect(buildWindowsDeleteTaskArgs(taskName)).toEqual(["/Delete", "/TN", taskName, "/F"]);
  });

  it("resolves the Windows scheduled task user from domain and username environment values", () => {
    expect(resolveWindowsTaskUser({ USERDOMAIN: "ADEBOX", USERNAME: "arul" })).toBe("ADEBOX\\arul");
    expect(resolveWindowsTaskUser({ USERNAME: "LOCALUSER" })).toBe("LOCALUSER");
    expect(resolveWindowsTaskUser({ USERDOMAIN: "ADEBOX", USERNAME: "ADEBOX\\arul" })).toBe("ADEBOX\\arul");
    expect(resolveWindowsTaskUser({
      USERDOMAIN: "MicrosoftAccount",
      USERNAME: "owner@example.com",
    })).toBe("MicrosoftAccount\\owner@example.com");
  });

  it("isolates scheduled task names by release channel and Windows principal", () => {
    const stableArul = resolveWindowsTaskName({
      serviceName: "com.ade.runtime",
      userName: "ADEBOX\\arul",
    });
    const betaArul = resolveWindowsTaskName({
      serviceName: "com.ade.runtime.beta",
      userName: "ADEBOX\\arul",
    });
    const betaOtherUser = resolveWindowsTaskName({
      serviceName: "com.ade.runtime.beta",
      userName: "ADEBOX\\other",
    });

    expect(stableArul).toMatch(/^ADE Runtime \(stable-[a-f0-9]{12}\)$/);
    expect(betaArul).toMatch(/^ADE Runtime \(beta-[a-f0-9]{12}\)$/);
    expect(new Set([stableArul, betaArul, betaOtherUser])).toHaveLength(3);
    expect(resolveWindowsTaskName({
      serviceName: "com.ade.runtime.beta",
      userName: "adebox\\ARUL",
    })).toBe(betaArul);
  });

  it("resolves service identity from the command channel at operation time", async () => {
    expect(resolveRuntimeServiceName({})).toBe("com.ade.runtime");
    expect(resolveRuntimeServiceName({ ADE_PACKAGE_CHANNEL: "beta" })).toBe(
      "com.ade.runtime.beta",
    );
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = await installWindowsService({
      ...immediateReadiness,
      command: serviceCommand,
      env: { USERDOMAIN: "ADEBOX", USERNAME: "arul" },
      launcherPath: path.join(makeTempHome("ade-windows-service-channel-"), "brain-service.ps1"),
      spawnSync: spawnSequence(calls, [
        { status: 3, stdout: "", stderr: "" },
        { status: 3, stdout: "", stderr: "" },
        { status: 1, stdout: "", stderr: "" },
        { status: 0, stdout: "SUCCESS: created", stderr: "" },
        { status: 0, stdout: "1234", stderr: "" },
      ]),
      userName: taskUser,
    });

    expect(result.serviceName).toBe("com.ade.runtime.beta");
    expect(result.path).toBe(taskName);
  });

  it("renders Windows scheduled task commands with double-quoted argv tokens", () => {
    expect(renderWindowsCommand({
      command: "C:\\Program Files\\ADE\\ade.exe",
      args: ["serve", "--root", "C:\\path with space\\"],
    })).toBe("\"C:\\Program Files\\ADE\\ade.exe\" \"serve\" \"--root\" \"C:\\path with space\\\\\"");
    expect(renderCommand(serviceCommand)).toBe(
      "'C:\\Program Files\\ADE\\ade.exe' 'C:\\Program Files\\ADE\\resources\\ade-cli\\cli.cjs' 'serve'",
    );
  });

  it("escapes embedded double quotes in Windows scheduled task command tokens", () => {
    expect(renderWindowsCommand({
      command: "C:\\Program Files\\ADE\\ade.exe",
      args: ["serve", "--name", "quoted \"value\""],
    })).toBe(
      "\"C:\\Program Files\\ADE\\ade.exe\" \"serve\" \"--name\" \"quoted \\\"value\\\"\"",
    );
  });

  it("renders a PowerShell launcher that preserves the service environment and quotes data literally", () => {
    const script = renderWindowsServiceLauncher({
      command: "C:\\Program Files\\ADE\\ADE.exe",
      args: ["C:\\Program Files\\ADE\\cli.cjs", "serve", "quoted \"value\"", "O'Brien"],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        NODE_PATH: "C:\\ADE deps\\100% & O'Brien",
        ADE_HOME: "C:\\Users\\arul\\.ade-beta",
      },
    }, { pidPath: "C:\\Users\\arul\\.ade-beta\\runtime\\brain.pid.json" });

    expect(script).toContain(
      "[System.Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', '1', 'Process')",
    );
    expect(script).toContain(
      "[System.Environment]::SetEnvironmentVariable('NODE_PATH', 'C:\\ADE deps\\100% & O''Brien', 'Process')",
    );
    expect(script).toContain("$startInfo.FileName = 'C:\\Program Files\\ADE\\ADE.exe'");
    expect(script).toContain(
      "$startInfo.Arguments = '\"C:\\Program Files\\ADE\\cli.cjs\" \"serve\" \"quoted \\\"value\\\"\" \"O''Brien\"'",
    );
    expect(script).toContain("$startInfo.CreateNoWindow = $true");
    expect(script).toContain(
      "$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden",
    );
    expect(script).toContain("$process = [System.Diagnostics.Process]::Start($startInfo)");
  });

  (process.platform === "win32" ? it : it.skip)(
    "bootstraps a spaced-path PowerShell supervisor with literal environment and argv values",
    async () => {
      const launcherPath = path.join(
        makeTempHome("ade windows service exec-"),
        "brain-service.ps1",
      );
      const outputPath = path.join(path.dirname(launcherPath), "result.json");
      fs.writeFileSync(
        launcherPath,
        `\uFEFF${renderWindowsServiceLauncher({
          command: process.execPath,
          args: [
            "-e",
            "require('node:fs').writeFileSync(process.env.ADE_TEST_OUTPUT, JSON.stringify({ value: process.env.ADE_TEST_VALUE, args: process.argv.slice(1) }), 'utf8')",
            "quoted \"value\"",
            "O'Brien",
            "100% & $HOME",
            "naïve-東京-🚀",
          ],
          env: {
            ADE_TEST_VALUE: "C:\\ADE deps\\naïve-東京-🚀\\100% & O'Brien",
            ADE_TEST_OUTPUT: outputPath,
          },
        }, { pidPath: `${launcherPath}.pid.json`, initialRestartDelayMs: 100 })}`,
        "utf8",
      );

      const bootstrap = spawnChildSync(
        WINDOWS_POWERSHELL_COMMAND,
        buildWindowsStartLauncherArgs(launcherPath),
        { encoding: "utf8", windowsHide: true },
      );
      try {
        expect(bootstrap.status).toBe(0);
        // Waits on a detached powershell.exe cold start plus a node child; 5s
        // is not enough headroom on a loaded Windows CI runner.
        const deadline = Date.now() + 45_000;
        while (!fs.existsSync(outputPath) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(JSON.parse(fs.readFileSync(outputPath, "utf8"))).toEqual({
          value: "C:\\ADE deps\\naïve-東京-🚀\\100% & O'Brien",
          args: ["quoted \"value\"", "O'Brien", "100% & $HOME", "naïve-東京-🚀"],
        });
      } finally {
        // The supervisor is detached via Start-Process, so this pid record is
        // the only handle on it. Reading it once races the supervisor's first
        // Write-PidRecord: when the read lost, the supervisor was never killed
        // and kept restarting its child for the rest of the run, holding the
        // temp tree open (EBUSY on unlink) and starving every later suite.
        // Wait for the record before giving up on the kill.
        const pidPath = `${launcherPath}.pid.json`;
        const killDeadline = Date.now() + 15_000;
        let record = readWindowsServicePidRecord({ pidPath });
        while (!record?.supervisorPid && Date.now() < killDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          record = readWindowsServicePidRecord({ pidPath });
        }
        if (record?.supervisorPid) {
          spawnChildSync("taskkill.exe", ["/PID", String(record.supervisorPid), "/T", "/F"], {
            encoding: "utf8",
            windowsHide: true,
          });
        }
      }
    },
    90_000,
  );

  it("registers and starts the per-user background service without Task Scheduler", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 3, stdout: "", stderr: "" },
      { status: 3, stdout: "", stderr: "" },
      { status: 1, stdout: "", stderr: "ERROR: value not found" },
      { status: 0, stdout: "The operation completed successfully.", stderr: "" },
      { status: 0, stdout: "1234", stderr: "" },
    ]);
    const launcherPath = path.join(makeTempHome("ade-windows-service-"), "brain-service.ps1");
    const pidPath = `${launcherPath}.pid.json`;
    const readinessProbe = vi.fn(immediateReadiness.readinessProbe);

    const result = await installWindowsService({
      command: serviceCommand,
      launcherPath,
      readPidRecord: immediateReadiness.readPidRecord,
      readinessProbe,
      serviceName,
      spawnSync,
      userName: taskUser,
    });

    expect(result).toMatchObject({
      ok: true,
      serviceName,
      action: "install",
      path: taskName,
      message: "ADE per-user startup entry installed and channel brain is ready.",
    });
    expect(fs.readFileSync(launcherPath, "utf8")).toBe(
      `\uFEFF${renderWindowsServiceLauncher(serviceCommand, {
        pidPath,
        logPath: `${launcherPath}.log`,
      })}`,
    );
    expect(readinessProbe).toHaveBeenCalledWith(expect.objectContaining({
      command: serviceCommand,
      launcherPath,
      pidRecord: readyPidRecord,
      socketPath: expect.stringMatching(/^\\\\\.\\pipe\\ade-runtime-beta-/),
    }));
    const scheduledCommand = renderWindowsCommand({
      command: WINDOWS_POWERSHELL_COMMAND,
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        launcherPath,
      ],
    });
    expect(path.win32.isAbsolute(WINDOWS_POWERSHELL_COMMAND)).toBe(true);
    expect(scheduledCommand).toContain(WINDOWS_POWERSHELL_COMMAND);
    expect(scheduledCommand.toLowerCase()).not.toMatch(/^powershell\.exe\b/);
    expect(calls).toEqual([
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskArgs("ADE Runtime") },
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskArgs(taskName) },
      { command: WINDOWS_REG_COMMAND, args: buildWindowsRunKeyQueryArgs(taskName) },
      { command: WINDOWS_REG_COMMAND, args: buildWindowsRunKeyAddArgs(taskName, scheduledCommand) },
      {
        command: WINDOWS_POWERSHELL_COMMAND,
        args: buildWindowsStartTaskArgs(launcherPath, resolveWindowsStartTaskName(taskName)),
      },
    ]);
  });

  it.each([
    { label: "an ordinary install", forceEnv: {} },
    { label: "a Repair-forced install", forceEnv: { ADE_FORCE_RUNTIME_SERVICE_RESTART: "1" } },
  ])("restarts the running supervisor on $label", async ({ forceEnv }) => {
    // The desktop Repair button sets ADE_FORCE_RUNTIME_SERVICE_RESTART, and
    // ONLY installLaunchd reads it — it exists to defeat launchd's "unchanged
    // plist + loaded + responsive => skip" fast path. Windows honours the flag
    // by construction rather than by reading it: this install has no skip path,
    // so it always taskkills the supervisor tree and starts a fresh one. Assert
    // that for BOTH env shapes, so a future "already installed, leave it alone"
    // optimisation here cannot silently turn Repair into a no-op on Windows.
    const home = makeTempHome("ade-windows-service-force-restart-");
    const launcherPath = path.join(home, "brain-service.ps1");
    fs.writeFileSync(`${launcherPath}.pid.json`, JSON.stringify(readyPidRecord), "utf8");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 3, stdout: "", stderr: "" },                     // legacy task: absent
      { status: 3, stdout: "", stderr: "" },                     // channel task: absent
      { status: 0, stdout: `    ${taskName}    REG_SZ    x`, stderr: "" }, // Run entry: installed
      { status: 0, stdout: "", stderr: "" },                     // supervisor probe: running
      { status: 0, stdout: "SUCCESS", stderr: "" },              // taskkill /T /F
      { status: 0, stdout: "SUCCESS: deleted", stderr: "" },     // reg delete
      { status: 0, stdout: "SUCCESS: created", stderr: "" },     // reg add
      { status: 0, stdout: "1234", stderr: "" },                 // start task
    ]);

    const result = await installWindowsService({
      ...immediateReadiness,
      command: serviceCommand,
      env: { USERDOMAIN: "ADEBOX", USERNAME: "arul", ...forceEnv },
      launcherPath,
      serviceName,
      spawnSync,
      userName: taskUser,
    });

    expect(result.ok).toBe(true);
    expect(calls).toContainEqual({
      command: WINDOWS_TASKKILL_COMMAND,
      args: ["/PID", String(readyPidRecord.supervisorPid), "/T", "/F"],
    });
    expect(calls.at(-1)).toEqual({
      command: WINDOWS_POWERSHELL_COMMAND,
      args: buildWindowsStartTaskArgs(launcherPath, resolveWindowsStartTaskName(taskName)),
    });
  });

  it("ends and replaces a running channel task before starting the repaired runtime", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 3, stdout: "", stderr: "" },
      { status: 0, stdout: "Running", stderr: "" },
      { status: 0, stdout: "SUCCESS: ended", stderr: "" },
      { status: 0, stdout: "SUCCESS: deleted", stderr: "" },
      { status: 1, stdout: "", stderr: "" },
      { status: 0, stdout: "SUCCESS: created", stderr: "" },
      { status: 0, stdout: "1234", stderr: "" },
    ]);
    const launcherPath = path.join(makeTempHome("ade-windows-service-repair-"), "brain-service.ps1");

    const result = await installWindowsService({
      ...immediateReadiness,
      command: serviceCommand,
      launcherPath,
      serviceName,
      spawnSync,
      userName: taskUser,
    });

    expect(result.ok).toBe(true);
    expect(calls.slice(0, 4)).toEqual([
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskArgs("ADE Runtime") },
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskArgs(taskName) },
      { command: WINDOWS_SCHTASKS_COMMAND, args: buildWindowsEndTaskArgs(taskName) },
      { command: WINDOWS_SCHTASKS_COMMAND, args: buildWindowsDeleteTaskArgs(taskName) },
    ]);
    expect(calls.at(-2)?.args).toEqual(expect.arrayContaining(["ADD", "/V", taskName]));
    expect(calls.at(-1)?.args).toEqual(
      buildWindowsStartTaskArgs(launcherPath, resolveWindowsStartTaskName(taskName)),
    );
  });

  it("ends and deletes only the exact legacy task it owns before installing the channel task", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "Running", stderr: "" },
      { status: 0, stdout: ownLegacyAction, stderr: "" },
      { status: 0, stdout: "SUCCESS: ended", stderr: "" },
      { status: 0, stdout: "SUCCESS: deleted", stderr: "" },
      { status: 3, stdout: "", stderr: "" },
      { status: 1, stdout: "", stderr: "" },
      { status: 0, stdout: "SUCCESS: created", stderr: "" },
      { status: 0, stdout: "1234", stderr: "" },
    ]);
    const launcherPath = path.join(makeTempHome("ade-windows-service-migrate-"), "brain-service.ps1");

    const result = await installWindowsService({
      ...immediateReadiness,
      command: serviceCommand,
      launcherPath,
      serviceName,
      spawnSync,
      userName: taskUser,
    });

    expect(result.ok).toBe(true);
    expect(calls.slice(0, 4)).toEqual([
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskArgs("ADE Runtime") },
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskActionArgs("ADE Runtime") },
      { command: WINDOWS_SCHTASKS_COMMAND, args: buildWindowsEndTaskArgs("ADE Runtime") },
      { command: WINDOWS_SCHTASKS_COMMAND, args: buildWindowsDeleteTaskArgs("ADE Runtime") },
    ]);
    expect(calls.flatMap((call) => call.args)).not.toContain("ADE Runtime ");
  });

  it("leaves another channel's legacy scheduled task running when Beta installs", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "Running", stderr: "" },
      { status: 0, stdout: stableLegacyAction, stderr: "" },
      { status: 3, stdout: "", stderr: "" },
      { status: 1, stdout: "", stderr: "ERROR: value not found" },
      { status: 0, stdout: "The operation completed successfully.", stderr: "" },
      { status: 0, stdout: "1234", stderr: "" },
    ]);
    const launcherPath = path.join(
      makeTempHome("ade-windows-service-foreign-legacy-"),
      "brain-service.ps1",
    );
    const scheduledCommand = renderWindowsCommand({
      command: WINDOWS_POWERSHELL_COMMAND,
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        launcherPath,
      ],
    });

    const result = await installWindowsService({
      ...immediateReadiness,
      command: serviceCommand,
      launcherPath,
      serviceName,
      spawnSync,
      userName: taskUser,
    });

    expect(result.ok).toBe(true);
    // The Stable brain is never ended or deleted: no schtasks call names the
    // global legacy task, and the recorded argv proves it.
    expect(calls).toEqual([
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskArgs("ADE Runtime") },
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskActionArgs("ADE Runtime") },
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskArgs(taskName) },
      { command: WINDOWS_REG_COMMAND, args: buildWindowsRunKeyQueryArgs(taskName) },
      { command: WINDOWS_REG_COMMAND, args: buildWindowsRunKeyAddArgs(taskName, scheduledCommand) },
      {
        command: WINDOWS_POWERSHELL_COMMAND,
        args: buildWindowsStartTaskArgs(launcherPath, resolveWindowsStartTaskName(taskName)),
      },
    ]);
    expect(calls.filter((call) => call.command === WINDOWS_SCHTASKS_COMMAND)).toEqual([]);
    expect(calls.some((call) => call.args.includes("ADE Runtime") && call.args.includes("/End")))
      .toBe(false);
    expect(calls.some((call) => call.args.includes("ADE Runtime") && call.args.includes("/Delete")))
      .toBe(false);
  });

  it("leaves another channel's legacy scheduled task running when Beta uninstalls", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 3, stdout: "", stderr: "" },
      { status: 0, stdout: "Running", stderr: "" },
      { status: 0, stdout: stableLegacyAction, stderr: "" },
      { status: 1, stdout: "", stderr: "ERROR: value not found" },
    ]);
    const launcherPath = path.join(
      makeTempHome("ade-windows-service-foreign-legacy-uninstall-"),
      "brain-service.ps1",
    );
    fs.writeFileSync(launcherPath, "old launcher", "utf8");

    const result = uninstallWindowsService({
      command: serviceCommand,
      launcherPath,
      serviceName,
      spawnSync,
      userName: taskUser,
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskArgs(taskName) },
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskArgs("ADE Runtime") },
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskActionArgs("ADE Runtime") },
      { command: WINDOWS_REG_COMMAND, args: buildWindowsRunKeyQueryArgs(taskName) },
    ]);
    expect(calls.filter((call) => call.command === WINDOWS_SCHTASKS_COMMAND)).toEqual([]);
    expect(fs.existsSync(launcherPath)).toBe(false);
  });

  it("fails the install instead of guessing when the legacy task action cannot be read", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "Running", stderr: "" },
      { status: 4, stdout: "", stderr: "ERROR: access is denied" },
    ]);
    const launcherPath = path.join(
      makeTempHome("ade-windows-service-legacy-owner-fail-"),
      "brain-service.ps1",
    );

    const result = await installWindowsService({
      command: serviceCommand,
      launcherPath,
      serviceName,
      spawnSync,
      userName: taskUser,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      "Unable to query the legacy ADE Runtime scheduled task: ERROR: access is denied",
    );
    expect(calls).toEqual([
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskArgs("ADE Runtime") },
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskActionArgs("ADE Runtime") },
    ]);
  });

  it("recognises only the current channel install as the legacy task owner", () => {
    expect(isWindowsLegacyTaskOwnedByCommand(ownLegacyAction, serviceCommand)).toBe(true);
    expect(isWindowsLegacyTaskOwnedByCommand(stableLegacyAction, serviceCommand)).toBe(false);
    expect(isWindowsLegacyTaskOwnedByCommand("", serviceCommand)).toBe(false);
    expect(isWindowsLegacyTaskOwnedByCommand(null, serviceCommand)).toBe(false);
    // Same executable, different packaged CLI entry: still not ours. Development
    // builds of every channel share process.execPath.
    expect(isWindowsLegacyTaskOwnedByCommand(
      taskActionOutput(
        "C:\\Program Files\\ADE\\ade.exe",
        "\"C:\\Program Files\\ADE Stable\\resources\\ade-cli\\cli.cjs\" \"serve\"",
      ),
      serviceCommand,
    )).toBe(false);
    // Quoting and path-separator differences must not defeat the match.
    expect(isWindowsLegacyTaskOwnedByCommand(
      taskActionOutput(
        "\"C:/Program Files/ADE/ADE.EXE\"",
        "\"C:/Program Files/ADE/resources/ade-cli/cli.cjs\" \"serve\"",
      ),
      serviceCommand,
    )).toBe(true);
  });

  it("does not register or start a channel task when the running legacy task cannot be ended", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "Running", stderr: "" },
      { status: 0, stdout: ownLegacyAction, stderr: "" },
      { status: 1, stdout: "", stderr: "ERROR: access is denied" },
    ]);
    const launcherPath = path.join(makeTempHome("ade-windows-service-migrate-fail-"), "brain-service.ps1");

    const result = await installWindowsService({
      command: serviceCommand,
      launcherPath,
      serviceName,
      spawnSync,
      userName: taskUser,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("legacy ADE Runtime scheduled task");
    expect(calls).toEqual([
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskArgs("ADE Runtime") },
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskActionArgs("ADE Runtime") },
      { command: WINDOWS_SCHTASKS_COMMAND, args: buildWindowsEndTaskArgs("ADE Runtime") },
    ]);
  });

  it("removes the per-user startup entry when immediate start fails", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 3, stdout: "", stderr: "" },
      { status: 3, stdout: "", stderr: "" },
      { status: 1, stdout: "", stderr: "" },
      { status: 0, stdout: "SUCCESS: created", stderr: "" },
      // Both job-escaping handovers are unavailable, so the launch falls all the
      // way back to the in-session PowerShell start, which also fails.
      { status: 1, stdout: "", stderr: "ERROR: task scheduler unavailable" },
      { status: 5, stdout: "", stderr: "Win32_Process.Create failed with return value 2." },
      { status: 1, stdout: "", stderr: "ERROR: access is denied" },
      { status: 0, stdout: "SUCCESS: deleted", stderr: "" },
    ]);
    const launcherPath = path.join(makeTempHome("ade-windows-service-start-fail-"), "brain-service.ps1");

    const result = await installWindowsService({
      command: serviceCommand,
      launcherPath,
      serviceName,
      spawnSync,
      userName: taskUser,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("ADE per-user startup entry was installed, but the background service failed to start: ERROR: access is denied");
    const scheduledCommand = renderWindowsCommand({
      command: WINDOWS_POWERSHELL_COMMAND,
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        launcherPath,
      ],
    });
    expect(calls.map((call) => call.args)).toEqual([
      buildWindowsQueryTaskArgs("ADE Runtime"),
      buildWindowsQueryTaskArgs(taskName),
      buildWindowsRunKeyQueryArgs(taskName),
      buildWindowsRunKeyAddArgs(taskName, scheduledCommand),
      buildWindowsStartTaskArgs(launcherPath, resolveWindowsStartTaskName(taskName)),
      buildWindowsWmiStartArgs(launcherPath),
      buildWindowsStartLauncherArgs(launcherPath),
      buildWindowsRunKeyDeleteArgs(taskName),
    ]);
  });

  it("does not start the service when per-user registration fails", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 3, stdout: "", stderr: "" },
      { status: 3, stdout: "", stderr: "" },
      { status: 1, stdout: "", stderr: "" },
      { status: 1, stdout: "", stderr: "ERROR: registration failed" },
    ]);
    const launcherPath = path.join(makeTempHome("ade-windows-service-create-fail-"), "brain-service.ps1");

    const result = await installWindowsService({
      command: serviceCommand,
      launcherPath,
      serviceName,
      spawnSync,
      userName: taskUser,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("ERROR: registration failed");
    expect(calls).toEqual([
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskArgs("ADE Runtime") },
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskArgs(taskName) },
      { command: WINDOWS_REG_COMMAND, args: buildWindowsRunKeyQueryArgs(taskName) },
      expect.objectContaining({ command: WINDOWS_REG_COMMAND, args: expect.arrayContaining(["ADD"]) }),
    ]);
  });

  it("removes legacy tasks and the per-user startup entry", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "Ready", stderr: "" },
      { status: 0, stdout: "SUCCESS: deleted", stderr: "" },
      { status: 0, stdout: "Running", stderr: "" },
      { status: 0, stdout: ownLegacyAction, stderr: "" },
      { status: 0, stdout: "SUCCESS: ended", stderr: "" },
      { status: 0, stdout: "SUCCESS: deleted", stderr: "" },
      { status: 0, stdout: "startup value", stderr: "" },
      { status: 0, stdout: "SUCCESS: deleted", stderr: "" },
    ]);
    const launcherPath = path.join(makeTempHome("ade-windows-service-remove-"), "brain-service.ps1");
    fs.writeFileSync(launcherPath, "old launcher", "utf8");

    const result = uninstallWindowsService({
      command: serviceCommand,
      launcherPath,
      serviceName,
      spawnSync,
      userName: taskUser,
    });

    expect(result).toMatchObject({
      ok: true,
      serviceName,
      action: "uninstall",
      path: taskName,
      message: "ADE background service startup entry removed.",
    });
    expect(calls).toEqual([
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskArgs(taskName) },
      { command: WINDOWS_SCHTASKS_COMMAND, args: buildWindowsDeleteTaskArgs(taskName) },
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskArgs("ADE Runtime") },
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskActionArgs("ADE Runtime") },
      { command: WINDOWS_SCHTASKS_COMMAND, args: buildWindowsEndTaskArgs("ADE Runtime") },
      { command: WINDOWS_SCHTASKS_COMMAND, args: buildWindowsDeleteTaskArgs("ADE Runtime") },
      { command: WINDOWS_REG_COMMAND, args: buildWindowsRunKeyQueryArgs(taskName) },
      { command: WINDOWS_REG_COMMAND, args: buildWindowsRunKeyDeleteArgs(taskName) },
    ]);
    expect(fs.existsSync(launcherPath)).toBe(false);
  });

  it("surfaces scheduled task removal failures", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "Ready", stderr: "" },
      { status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." },
      { status: 3, stdout: "", stderr: "" },
      { status: 1, stdout: "", stderr: "" },
    ]);

    const result = uninstallWindowsService({ serviceName, spawnSync, userName: taskUser });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("ERROR: The system cannot find the file specified.");
    expect(calls).toEqual([
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskArgs(taskName) },
      { command: WINDOWS_SCHTASKS_COMMAND, args: buildWindowsDeleteTaskArgs(taskName) },
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskArgs("ADE Runtime") },
      { command: WINDOWS_REG_COMMAND, args: buildWindowsRunKeyQueryArgs(taskName) },
    ]);
  });

  it("fails uninstall when the scheduled task launcher cannot be removed", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 3, stdout: "", stderr: "" },
      { status: 3, stdout: "", stderr: "" },
      { status: 1, stdout: "", stderr: "" },
    ]);
    const launcherPath = makeTempHome("ade-windows-service-launcher-dir-");

    const result = uninstallWindowsService({
      launcherPath,
      serviceName,
      spawnSync,
      userName: taskUser,
    });

    expect(result).toMatchObject({
      ok: false,
      serviceName,
      action: "uninstall",
      path: launcherPath,
    });
    expect(result.message).toContain("launcher could not be deleted");
  });

  it("reports a running legacy Scheduled Task as installed but not readiness-verified", () => {
    const calls: Array<{
      command: string;
      args: string[];
      options: import("node:child_process").SpawnSyncOptions | undefined;
    }> = [];
    const spawnSync: ServiceManagerSpawnSync = (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "Running", stderr: "" };
    };

    expect(getWindowsServiceStatus({ serviceName, spawnSync, userName: taskUser })).toMatchObject({
      ok: true,
      installed: true,
      running: false,
      path: taskName,
    });
    expect(calls).toEqual([
      {
        command: WINDOWS_POWERSHELL_COMMAND,
        args: buildWindowsQueryTaskArgs(taskName),
        options: expect.objectContaining({ windowsHide: true }),
      },
    ]);
  });

  it("hides every Windows scheduled-task lifecycle subprocess", async () => {
    const calls: Array<{
      command: string;
      args: string[];
      options: import("node:child_process").SpawnSyncOptions | undefined;
    }> = [];
    const results: ServiceManagerProcessResult[] = [
      { status: 0, stdout: "Running", stderr: "" },
      { status: 0, stdout: ownLegacyAction, stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 3, stdout: "", stderr: "" },
      { status: 1, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "1234", stderr: "" },
    ];
    const spawnSync: ServiceManagerSpawnSync = (command, args, options) => {
      calls.push({ command, args, options });
      return results.shift() ?? { status: 0, stdout: "", stderr: "" };
    };
    const launcherPath = path.join(
      makeTempHome("ade-windows-service-hidden-"),
      "brain-service.ps1",
    );

    const result = await installWindowsService({
      ...immediateReadiness,
      command: serviceCommand,
      launcherPath,
      serviceName,
      spawnSync,
      userName: taskUser,
    });

    expect(result.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.options?.windowsHide === true)).toBe(true);
  });

  it("reports a legacy global runtime task this channel owns as migratable", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const status = getWindowsServiceStatus({
      command: serviceCommand,
      serviceName,
      spawnSync: spawnSequence(calls, [
        { status: 3, stdout: "", stderr: "" },
        { status: 1, stdout: "", stderr: "" },
        { status: 0, stdout: "Ready", stderr: "" },
        { status: 0, stdout: ownLegacyAction, stderr: "" },
      ]),
      userName: taskUser,
    });

    expect(status).toMatchObject({
      ok: true,
      installed: true,
      running: false,
      path: "ADE Runtime",
    });
    expect(status.message).toBe(
      "A legacy ADE Runtime scheduled task from a pre-channel install belongs to this channel, "
      + "but runtime readiness cannot be verified for it. Run `ade brain start` to migrate it to "
      + "the per-user startup supervisor.",
    );
    expect(calls).toEqual([
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskArgs(taskName) },
      { command: WINDOWS_REG_COMMAND, args: buildWindowsRunKeyQueryArgs(taskName) },
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskArgs("ADE Runtime") },
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskActionArgs("ADE Runtime") },
    ]);
  });

  it("reports another install's legacy global runtime task without claiming it", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const status = getWindowsServiceStatus({
      command: serviceCommand,
      serviceName,
      spawnSync: spawnSequence(calls, [
        { status: 3, stdout: "", stderr: "" },
        { status: 1, stdout: "", stderr: "" },
        { status: 0, stdout: "Running", stderr: "" },
        { status: 0, stdout: stableLegacyAction, stderr: "" },
      ]),
      userName: taskUser,
    });

    expect(status).toMatchObject({
      ok: true,
      installed: false,
      running: false,
      path: taskName,
    });
    expect(status.message).toBe(
      "ADE background service startup entry is not installed for this channel. A legacy ADE "
      + "Runtime scheduled task belongs to a different ADE install and was left running. Run "
      + "`ade brain start` to install this channel's startup entry, and uninstall the other ADE "
      + "to clear its legacy task.",
    );
    expect(calls.at(-1)?.args).toEqual(buildWindowsQueryTaskActionArgs("ADE Runtime"));
  });

  it("does not claim ownership when the legacy global task action cannot be read", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const status = getWindowsServiceStatus({
      command: serviceCommand,
      serviceName,
      spawnSync: spawnSequence(calls, [
        { status: 3, stdout: "", stderr: "" },
        { status: 1, stdout: "", stderr: "" },
        { status: 0, stdout: "Running", stderr: "" },
        { status: 4, stdout: "", stderr: "ERROR: access is denied" },
      ]),
      userName: taskUser,
    });

    expect(status).toMatchObject({ ok: true, installed: false, running: false });
    expect(status.message).toContain("its owning install could not be determined");
  });

  it("keeps status answerable when the legacy global task probe itself fails", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const status = getWindowsServiceStatus({
      command: serviceCommand,
      serviceName,
      spawnSync: spawnSequence(calls, [
        { status: 3, stdout: "", stderr: "" },
        { status: 1, stdout: "", stderr: "" },
        { status: 4, stdout: "", stderr: "PowerShell unavailable" },
      ]),
      userName: taskUser,
    });

    expect(status).toMatchObject({ ok: true, installed: false, running: false });
    expect(status.message).toBe("ADE background service startup entry is not installed.");
    expect(calls).toEqual([
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskArgs(taskName) },
      { command: WINDOWS_REG_COMMAND, args: buildWindowsRunKeyQueryArgs(taskName) },
      { command: WINDOWS_POWERSHELL_COMMAND, args: buildWindowsQueryTaskArgs("ADE Runtime") },
    ]);
  });

  it("distinguishes an absent task from a failed locale-independent status query", () => {
    const absentCalls: Array<{ command: string; args: string[] }> = [];
    const absent = getWindowsServiceStatus({
      command: serviceCommand,
      serviceName,
      spawnSync: spawnSequence(absentCalls, [
        { status: 3, stdout: "", stderr: "" },
        { status: 1, stdout: "", stderr: "" },
        { status: 3, stdout: "", stderr: "" },
      ]),
      userName: taskUser,
    });
    const failedCalls: Array<{ command: string; args: string[] }> = [];
    const failed = getWindowsServiceStatus({
      serviceName,
      spawnSync: spawnSequence(failedCalls, [
        { status: 1, stdout: "", stderr: "PowerShell unavailable" },
        { status: 1, stdout: "", stderr: "" },
      ]),
      userName: taskUser,
    });

    expect(absent).toMatchObject({ ok: true, installed: false, running: false });
    expect(absent.message).toBe("ADE background service startup entry is not installed.");
    // The failing query short-circuits before the supplementary legacy probe.
    expect(failedCalls).toHaveLength(2);
    expect(failed).toMatchObject({ ok: false, installed: null, running: null });
  });

  (
    process.platform === "win32"
    && !os.userInfo().username.toLowerCase().startsWith("codexsandbox")
      ? it
      : it.skip
  )(
    "returns the dedicated not-found exit code from a real locale-independent task query",
    () => {
      const missingTaskName = `ADE Runtime Test ${process.pid} ${Date.now()}`;
      const result = spawnChildSync(
        WINDOWS_POWERSHELL_COMMAND,
        buildWindowsQueryTaskArgs(missingTaskName),
        { encoding: "utf8" },
      );

      expect(result.status, result.stderr).toBe(3);
      expect(result.stdout).toBe("");
    },
  );

  it("derives the launcher path from the channel-local ADE home", () => {
    expect(resolveWindowsServiceLauncherPath({
      env: { ADE_HOME: "C:\\Users\\arul\\.ade-beta" },
      serviceName,
    })).toMatch(/^C:\\Users\\arul\\\.ade-beta\\runtime\\brain-service-[a-f0-9]{12}\.ps1$/i);
  });
});

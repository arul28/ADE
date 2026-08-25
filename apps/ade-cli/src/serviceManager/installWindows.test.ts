import fs from "node:fs";
import { spawn, spawnSync, spawnSync as spawnChildSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { resolveMachineAdeLayout } from "../services/projects/machineLayout";
import { resolveTrustedWindowsTool, trustedWindowsToolKernelPath } from "../lib/trustedWindowsTools";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWindowsProcessCommandLineQueryArgs,
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
  windowsPowerShellCommand,
  windowsRegCommand,
  windowsSchtasksCommand,
  windowsTaskkillCommand,
  WINDOWS_TASK_ACTION_FIELD_SEPARATOR,
  buildWindowsRuntimeQueryArgs,
  renderWindowsServiceLauncher,
} from "./installWindows";
import {
  BRAIN_HEARTBEAT_INTERVAL_MS,
  BRAIN_HEARTBEAT_STALE_MS,
} from "../services/runtime/brainHeartbeat";
import {
  buildWindowsSupervisorQueryArgs,
  waitForWindowsRuntimeReadiness,
} from "./windowsSupervisor";

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
  // The install scans for stale same-channel `serve` brains before it registers
  // the startup entry, the same way the launchd install does. On Windows that
  // scan is a Win32_Process command-line enumeration, not `ps -axo`.
  const staleServeScanCall = {
    command: windowsPowerShellCommand(),
    args: buildWindowsProcessCommandLineQueryArgs(),
  };
  // A legacy `ADE Runtime` task owned by a side-by-side Stable install.
  const stableLegacyAction = taskActionOutput(
    "C:\\Program Files\\ADE Stable\\ADE.exe",
    "\"C:\\Program Files\\ADE Stable\\resources\\ade-cli\\cli.cjs\" \"serve\"",
  );

  it("builds schtasks create, run, query, and delete arguments without invoking schtasks", () => {
    const renderedCommand = renderWindowsCommand({
      command: windowsPowerShellCommand(),
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
        windowsPowerShellCommand(),
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
      // launchd parity: the install now scans for stale same-channel serve
      // brains before registering. Nothing running.
      { status: 0, stdout: "", stderr: "" },
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
    const machineLayout = resolveMachineAdeLayout(
      { ...process.env, ...(serviceCommand.env ?? {}) },
      "win32",
    );
    expect(fs.readFileSync(launcherPath, "utf8")).toBe(
      `\uFEFF${renderWindowsServiceLauncher(serviceCommand, {
        pidPath,
        logPath: `${launcherPath}.log`,
        // The supervisor loop doubles as this platform's wedge watchdog.
        heartbeatPath: path.win32.join(machineLayout.runtimeDir, "heartbeat.json"),
        wedgeBreadcrumbPath: path.win32.join(
          machineLayout.runtimeDir,
          "event-loop-wedge.json",
        ),
      })}`,
    );
    expect(fs.readFileSync(launcherPath, "utf8")).toContain("Get-StaleBeatTs");
    expect(readinessProbe).toHaveBeenCalledWith(expect.objectContaining({
      command: serviceCommand,
      launcherPath,
      pidRecord: readyPidRecord,
      socketPath: expect.stringMatching(/^\\\\\.\\pipe\\ade-runtime-beta-/),
    }));
    const scheduledCommand = renderWindowsCommand({
      command: windowsPowerShellCommand(),
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
    expect(path.win32.isAbsolute(windowsPowerShellCommand())).toBe(true);
    expect(scheduledCommand).toContain(windowsPowerShellCommand());
    expect(scheduledCommand.toLowerCase()).not.toMatch(/^powershell\.exe\b/);
    expect(calls).toEqual([
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskArgs("ADE Runtime") },
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskArgs(taskName) },
      { command: windowsRegCommand(), args: buildWindowsRunKeyQueryArgs(taskName) },
      staleServeScanCall,
      { command: windowsRegCommand(), args: buildWindowsRunKeyAddArgs(taskName, scheduledCommand) },
      {
        command: windowsPowerShellCommand(),
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
      { status: 0, stdout: "SUCCESS", stderr: "" },              // taskkill supervisor
      { status: 0, stdout: "SUCCESS: deleted", stderr: "" },     // reg delete
      { status: 0, stdout: "", stderr: "" },                     // stale same-channel serve scan: none
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
    // The supervisor is killed on its own, WITHOUT `/T`. The brain is its
    // child, so a tree kill took the brain down mid-write — no SQLite/CRDT
    // flush, no lock release — and the next start had to recover from a lock
    // whose owner never got to release it. The brain is talked down separately
    // once the supervisor can no longer relaunch it. Repair is still a real
    // restart, which is what this test exists to protect: the supervisor dies
    // and a fresh one is started below.
    expect(calls).toContainEqual({
      command: windowsTaskkillCommand(),
      args: ["/PID", String(readyPidRecord.supervisorPid), "/F"],
    });
    expect(calls.at(-1)).toEqual({
      command: windowsPowerShellCommand(),
      args: buildWindowsStartTaskArgs(launcherPath, resolveWindowsStartTaskName(taskName)),
    });
  });

  it("reports a supervised brain that has not answered yet as starting, not failed", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 3, stdout: "", stderr: "" },
      { status: 3, stdout: "", stderr: "" },
      { status: 1, stdout: "", stderr: "ERROR: value not found" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "The operation completed successfully.", stderr: "" },
      { status: 0, stdout: "1234", stderr: "" },
    ]);
    const launcherPath = path.join(makeTempHome("ade-windows-service-starting-"), "brain-service.ps1");

    const result = await installWindowsService({
      command: serviceCommand,
      launcherPath,
      readPidRecord: immediateReadiness.readPidRecord,
      // The probe's Win32_Process identity check confirmed the recorded pid IS
      // our supervisor; it is the brain behind it that has not answered.
      readinessProbe: () => ({
        ready: false,
        supervised: true,
        diagnostic: "Runtime PID 5678 has not bound the pipe yet.",
      }),
      handoverTimeoutMs: 0,
      serviceName,
      spawnSync,
      userName: taskUser,
    });

    expect(result).toMatchObject({
      ok: true,
      starting: true,
      serviceName,
      action: "install",
      path: taskName,
    });
    expect(result.failureStep).toBeUndefined();
    expect(result.message).toContain("still starting");
  });

  it("fails, not starting, when the recorded supervisor pid is not ours", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 3, stdout: "", stderr: "" },
      { status: 3, stdout: "", stderr: "" },
      { status: 1, stdout: "", stderr: "ERROR: value not found" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "The operation completed successfully.", stderr: "" },
      { status: 0, stdout: "1234", stderr: "" },
    ]);
    const launcherPath = path.join(makeTempHome("ade-windows-service-dead-sup-"), "brain-service.ps1");

    const result = await installWindowsService({
      command: serviceCommand,
      launcherPath,
      readPidRecord: immediateReadiness.readPidRecord,
      // Recycled pid: alive, but `Win32_Process` says it is not a powershell
      // running our launcher. `pidAlive` would call this "our brain, starting";
      // only the identity check can tell, and it says no.
      readinessProbe: () => ({
        ready: false,
        supervised: false,
        diagnostic: "Supervisor PID 1234 is stale or belongs to another process.",
      }),
      handoverTimeoutMs: 0,
      pidAlive: () => true,
      serviceName,
      spawnSync,
      userName: taskUser,
    });

    expect(result).toMatchObject({ ok: false, failureStep: "replacement_responsive" });
    expect(result.starting).toBeUndefined();
  });

  it("waits for a young unresponsive brain instead of replacing it", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      // legacy task lookups (none)
      { status: 3, stdout: "", stderr: "" },
      { status: 3, stdout: "", stderr: "" },
    ]);
    const launcherPath = path.join(makeTempHome("ade-windows-service-young-"), "brain-service.ps1");
    const pidPath = `${launcherPath}.pid.json`;
    // Pre-render the launcher exactly as the install would, so it reads as unchanged.
    const machineLayout = resolveMachineAdeLayout(
      { ...process.env, ...(serviceCommand.env ?? {}) },
      "win32",
    );
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(launcherPath, `\uFEFF${renderWindowsServiceLauncher(serviceCommand, {
      pidPath,
      logPath: `${launcherPath}.log`,
      heartbeatPath: path.win32.join(machineLayout.runtimeDir, "heartbeat.json"),
      wedgeBreadcrumbPath: path.win32.join(machineLayout.runtimeDir, "event-loop-wedge.json"),
    })}`, "utf8");
    const youngRecord = { ...readyPidRecord, runtimeStartedAtMs: Date.now() - 5_000 };
    const readinessProbe = vi.fn()
      .mockReturnValueOnce({ ready: false, diagnostic: "not yet" })
      .mockReturnValue({ ready: true, diagnostic: "ready" });

    const result = await installWindowsService({
      command: serviceCommand,
      launcherPath,
      pidPath,
      readPidRecord: () => youngRecord,
      readinessProbe,
      handoverTimeoutMs: 5_000,
      handoverPollMs: 10,
      pidAlive: () => true,
      serviceName,
      spawnSync,
      userName: taskUser,
    });

    expect(result).toMatchObject({ ok: true, action: "install" });
    expect(result.restarted).toBeUndefined();
    // No run-key rewrite, no supervisor start: the brain was left alone.
    expect(calls.some((call) => call.args.some((arg) => /Add|\/Run|Start-Process/i.test(arg)))).toBe(false);
  });

  it("still fails the install when the supervisor never publishes a brain at all", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 3, stdout: "", stderr: "" },
      { status: 3, stdout: "", stderr: "" },
      { status: 1, stdout: "", stderr: "ERROR: value not found" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "The operation completed successfully.", stderr: "" },
      { status: 0, stdout: "1234", stderr: "" },
    ]);
    const launcherPath = path.join(makeTempHome("ade-windows-service-no-brain-"), "brain-service.ps1");

    const result = await installWindowsService({
      command: serviceCommand,
      launcherPath,
      readPidRecord: () => null,
      readinessProbe: () => ({ ready: false, diagnostic: "unused" }),
      handoverTimeoutMs: 0,
      serviceName,
      spawnSync,
      userName: taskUser,
    });

    expect(result).toMatchObject({
      ok: false,
      failureStep: "replacement_responsive",
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
      // launchd parity: the install now scans for stale same-channel serve
      // brains before registering. Nothing running.
      { status: 0, stdout: "", stderr: "" },
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
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskArgs("ADE Runtime") },
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskArgs(taskName) },
      { command: windowsSchtasksCommand(), args: buildWindowsEndTaskArgs(taskName) },
      { command: windowsSchtasksCommand(), args: buildWindowsDeleteTaskArgs(taskName) },
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
      // launchd parity: the install now scans for stale same-channel serve
      // brains before registering. Nothing running.
      { status: 0, stdout: "", stderr: "" },
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
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskArgs("ADE Runtime") },
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskActionArgs("ADE Runtime") },
      { command: windowsSchtasksCommand(), args: buildWindowsEndTaskArgs("ADE Runtime") },
      { command: windowsSchtasksCommand(), args: buildWindowsDeleteTaskArgs("ADE Runtime") },
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
      // launchd parity: the install now scans for stale same-channel serve
      // brains before registering. Nothing running.
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "The operation completed successfully.", stderr: "" },
      { status: 0, stdout: "1234", stderr: "" },
    ]);
    const launcherPath = path.join(
      makeTempHome("ade-windows-service-foreign-legacy-"),
      "brain-service.ps1",
    );
    const scheduledCommand = renderWindowsCommand({
      command: windowsPowerShellCommand(),
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
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskArgs("ADE Runtime") },
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskActionArgs("ADE Runtime") },
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskArgs(taskName) },
      { command: windowsRegCommand(), args: buildWindowsRunKeyQueryArgs(taskName) },
      staleServeScanCall,
      { command: windowsRegCommand(), args: buildWindowsRunKeyAddArgs(taskName, scheduledCommand) },
      {
        command: windowsPowerShellCommand(),
        args: buildWindowsStartTaskArgs(launcherPath, resolveWindowsStartTaskName(taskName)),
      },
    ]);
    expect(calls.filter((call) => call.command === windowsSchtasksCommand())).toEqual([]);
    expect(calls.some((call) => call.args.includes("ADE Runtime") && call.args.includes("/End")))
      .toBe(false);
    expect(calls.some((call) => call.args.includes("ADE Runtime") && call.args.includes("/Delete")))
      .toBe(false);
  });

  it("leaves another channel's legacy scheduled task running when Beta uninstalls", async () => {
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

    const result = await uninstallWindowsService({
      command: serviceCommand,
      launcherPath,
      serviceName,
      spawnSync,
      userName: taskUser,
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskArgs(taskName) },
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskArgs("ADE Runtime") },
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskActionArgs("ADE Runtime") },
      { command: windowsRegCommand(), args: buildWindowsRunKeyQueryArgs(taskName) },
    ]);
    expect(calls.filter((call) => call.command === windowsSchtasksCommand())).toEqual([]);
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
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskArgs("ADE Runtime") },
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskActionArgs("ADE Runtime") },
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
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskArgs("ADE Runtime") },
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskActionArgs("ADE Runtime") },
      { command: windowsSchtasksCommand(), args: buildWindowsEndTaskArgs("ADE Runtime") },
    ]);
  });

  it("removes the per-user startup entry when immediate start fails", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 3, stdout: "", stderr: "" },
      { status: 3, stdout: "", stderr: "" },
      { status: 1, stdout: "", stderr: "" },
      // launchd parity: the install now scans for stale same-channel serve
      // brains before registering. Nothing running.
      { status: 0, stdout: "", stderr: "" },
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
      command: windowsPowerShellCommand(),
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
      buildWindowsProcessCommandLineQueryArgs(),
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
      // launchd parity: the install now scans for stale same-channel serve
      // brains before registering. Nothing running.
      { status: 0, stdout: "", stderr: "" },
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
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskArgs("ADE Runtime") },
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskArgs(taskName) },
      { command: windowsRegCommand(), args: buildWindowsRunKeyQueryArgs(taskName) },
      staleServeScanCall,
      expect.objectContaining({ command: windowsRegCommand(), args: expect.arrayContaining(["ADD"]) }),
    ]);
  });

  it("removes legacy tasks and the per-user startup entry", async () => {
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

    const result = await uninstallWindowsService({
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
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskArgs(taskName) },
      { command: windowsSchtasksCommand(), args: buildWindowsDeleteTaskArgs(taskName) },
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskArgs("ADE Runtime") },
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskActionArgs("ADE Runtime") },
      { command: windowsSchtasksCommand(), args: buildWindowsEndTaskArgs("ADE Runtime") },
      { command: windowsSchtasksCommand(), args: buildWindowsDeleteTaskArgs("ADE Runtime") },
      { command: windowsRegCommand(), args: buildWindowsRunKeyQueryArgs(taskName) },
      { command: windowsRegCommand(), args: buildWindowsRunKeyDeleteArgs(taskName) },
    ]);
    expect(fs.existsSync(launcherPath)).toBe(false);
  });

  it("surfaces scheduled task removal failures", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "Ready", stderr: "" },
      { status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." },
      { status: 3, stdout: "", stderr: "" },
      { status: 1, stdout: "", stderr: "" },
    ]);

    const result = await uninstallWindowsService({ serviceName, spawnSync, userName: taskUser });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("ERROR: The system cannot find the file specified.");
    expect(calls).toEqual([
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskArgs(taskName) },
      { command: windowsSchtasksCommand(), args: buildWindowsDeleteTaskArgs(taskName) },
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskArgs("ADE Runtime") },
      { command: windowsRegCommand(), args: buildWindowsRunKeyQueryArgs(taskName) },
    ]);
  });

  it("fails uninstall when the scheduled task launcher cannot be removed", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 3, stdout: "", stderr: "" },
      { status: 3, stdout: "", stderr: "" },
      { status: 1, stdout: "", stderr: "" },
    ]);
    const launcherPath = makeTempHome("ade-windows-service-launcher-dir-");

    const result = await uninstallWindowsService({
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
        command: windowsPowerShellCommand(),
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
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskArgs(taskName) },
      { command: windowsRegCommand(), args: buildWindowsRunKeyQueryArgs(taskName) },
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskArgs("ADE Runtime") },
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskActionArgs("ADE Runtime") },
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
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskArgs(taskName) },
      { command: windowsRegCommand(), args: buildWindowsRunKeyQueryArgs(taskName) },
      { command: windowsPowerShellCommand(), args: buildWindowsQueryTaskArgs("ADE Runtime") },
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
        windowsPowerShellCommand(),
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

describe("Windows runtime supervisor", () => {
  it("renders bounded restart state for both child exits and launch failures", () => {
    const script = renderWindowsServiceLauncher({
      command: "C:\\Program Files\\ADE\\ade.exe",
      args: ["C:\\Program Files\\ADE\\resources\\ade-cli\\cli.cjs", "serve"],
    }, {
      pidPath: "C:\\Users\\arul\\.ade-beta\\runtime\\brain.pid.json",
      initialRestartDelayMs: 250,
      maxRestartDelayMs: 5_000,
      healthyRuntimeMs: 30_000,
    });

    expect(script).toContain("while ($true)");
    expect(script).toContain("$initialRestartDelayMs = 250");
    expect(script).toContain("$maxRestartDelayMs = 5000");
    expect(script).toContain("lastLaunchError = $lastLaunchError");
    expect(script).toContain("} catch {");
    expect(script).toContain("Start-Sleep -Milliseconds ([int]$restartDelayMs)");
  });

  it("reads legacy and current PID records with bounded diagnostics", () => {
    const pidPath = path.join(makeTempHome("ade-windows-supervisor-"), "brain.pid.json");
    fs.writeFileSync(pidPath, JSON.stringify({ supervisorPid: 101, runtimePid: 202 }), "utf8");
    expect(readWindowsServicePidRecord({ pidPath })).toEqual({
      supervisorPid: 101,
      runtimePid: 202,
      runtimeStartedAtMs: null,
      restartCount: 0,
      lastExitCode: null,
      lastExitAt: null,
      nextRestartAt: null,
      lastLaunchError: null,
      sessionBound: null,
    });

    fs.writeFileSync(pidPath, JSON.stringify({
      supervisorPid: 101,
      runtimePid: null,
      restartCount: 3,
      lastLaunchError: "x".repeat(800),
    }), "utf8");
    expect(readWindowsServicePidRecord({ pidPath })).toMatchObject({
      runtimePid: null,
      restartCount: 3,
      lastLaunchError: "x".repeat(512),
    });
  });

  it("binds runtime PID inspection to the executable, entrypoint, and serve command", () => {
    const args = buildWindowsRuntimeQueryArgs(202, {
      command: "C:\\Program Files\\ADE\\ade.exe",
      args: ["C:\\Program Files\\ADE\\resources\\ade-cli\\cli.cjs", "serve"],
    });
    const query = args.at(-1) ?? "";
    expect(query).toContain("ProcessId = 202");
    expect(query).toContain("C:\\Program Files\\ADE\\ade.exe");
    expect(query).toContain("C:\\Program Files\\ADE\\resources\\ade-cli\\cli.cjs");
    expect(query).toContain("matchesServe");
  });

  it("waits asynchronously for semantic readiness without blocking the caller", async () => {
    const sleepStarted: number[] = [];
    const wait = waitForWindowsRuntimeReadiness({
      command: { command: "C:\\ADE\\ade.exe", args: ["serve"] },
      launcherPath: "C:\\ADE\\brain-service.ps1",
      pidPath: "C:\\ADE\\brain.pid.json",
      socketPath: "\\\\.\\pipe\\ade-test",
      spawnSync,
      readPidRecord: () => null,
      // Comfortably more than one poll: the helper computes `remaining` from a
      // deadline captured a few statements earlier, so a budget close to
      // `pollMs` lets a stalled runner skip the first sleep and turn the
      // synchronous `sleepStarted` assertion into a flake. Every iteration is
      // free here (`readPidRecord` always answers null).
      timeoutMs: 60,
      pollMs: 10,
      sleep: async (ms) => {
        sleepStarted.push(ms);
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
      },
    });

    expect(wait).toBeInstanceOf(Promise);
    expect(sleepStarted).toEqual([10]);
    await expect(wait).resolves.toMatchObject({
      ready: false,
      diagnostic: expect.stringContaining("did not publish a PID record"),
    });
  });

  it("reports `supervised` from the probe's identity check, never from pid liveness", async () => {
    const record = {
      supervisorPid: 4321,
      runtimePid: 5678,
      runtimeStartedAtMs: Date.now(),
      restartCount: 0,
      lastExitCode: null,
      lastExitAt: null,
      nextRestartAt: null,
      lastLaunchError: null,
      sessionBound: null,
    };
    const wait = (supervised: boolean | undefined) => waitForWindowsRuntimeReadiness({
      command: { command: "C:\\ADE\\ade.exe", args: ["serve"] },
      launcherPath: "C:\\ADE\\brain-service.ps1",
      pidPath: "C:\\ADE\\brain.pid.json",
      socketPath: "\\\\.\\pipe\\ade-test",
      spawnSync,
      readPidRecord: () => record,
      readinessProbe: () => ({ ready: false, supervised, diagnostic: "not yet" }),
      timeoutMs: 0,
      pollMs: 10,
    });

    // The recorded pids are alive as far as `process.kill(pid, 0)` is
    // concerned in every one of these cases -- what differs is whether
    // `Win32_Process` says the pid is a powershell running OUR launcher. Only
    // that answer may promote a failed install to "still starting".
    await expect(wait(true)).resolves.toMatchObject({ ready: false, supervised: true });
    await expect(wait(false)).resolves.toMatchObject({ ready: false, supervised: false });
    // A probe that says nothing is unknown, and unknown is not healthy.
    await expect(wait(undefined)).resolves.toMatchObject({ ready: false, supervised: false });
  });

  (process.platform === "win32" ? it : it.skip)(
    "keeps supervising a missing executable and publishes launch-error backoff diagnostics",
    async () => {
      const dir = makeTempHome("ade-windows-supervisor-");
      const launcherPath = path.join(dir, "brain-service.ps1");
      const pidPath = `${launcherPath}.pid.json`;
      fs.writeFileSync(launcherPath, `\uFEFF${renderWindowsServiceLauncher({
        command: path.join(dir, "missing-ade.exe"),
        args: ["serve"],
      }, {
        pidPath,
        initialRestartDelayMs: 100,
        maxRestartDelayMs: 200,
      })}`, "utf8");
      const supervisor = spawn(windowsPowerShellCommand(), [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        launcherPath,
      ], { stdio: "ignore", windowsHide: true });
      try {
        // The supervisor is a real detached PowerShell process, so this waits on
        // powershell.exe cold start plus two full launch-failure backoff cycles.
        // A 5s budget is a coin flip on a loaded Windows CI runner, where the
        // record simply had not been written yet and the assertion below read
        // null. Widen the patience; the assertion itself is unchanged.
        const deadline = Date.now() + 45_000;
        let record = readWindowsServicePidRecord({ pidPath });
        while ((!record?.lastLaunchError || record.restartCount < 2) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          record = readWindowsServicePidRecord({ pidPath });
        }
        expect(record).toMatchObject({
          supervisorPid: supervisor.pid,
          runtimePid: null,
          restartCount: expect.any(Number),
          lastLaunchError: expect.any(String),
          nextRestartAt: expect.any(String),
        });
        expect(record?.restartCount).toBeGreaterThanOrEqual(2);
      } finally {
        if (supervisor.pid) {
          spawnSync("taskkill.exe", ["/PID", String(supervisor.pid), "/T", "/F"], {
            encoding: "utf8",
            windowsHide: true,
          });
        }
      }
    },
    60_000,
  );
});

describe("windows supervisor wedge guard", () => {
  const command = {
    command: "C:\\ade\\node.exe",
    args: ["C:\\ade\\cli.cjs", "serve"],
    env: { ADE_HOME: "C:\\Users\\example\\.ade" },
  };

  it("waits in slices and stops a brain that stopped beating", () => {
    const script = renderWindowsServiceLauncher(command, {
      pidPath: "C:\\ade\\launcher.pid.json",
      heartbeatPath: "C:\\ade\\runtime\\heartbeat.json",
      wedgeBreadcrumbPath: "C:\\ade\\runtime\\event-loop-wedge.json",
    });

    // An unbounded WaitForExit is exactly what makes a wedge invisible.
    expect(script).not.toContain("$process.WaitForExit()\r\n      $lastExitCode");
    expect(script).toContain("while (-not $process.WaitForExit($heartbeatPollMs))");
    expect(script).toContain("Get-StaleBeatTs -runtimePid $process.Id -nowMs $nowMs");
    expect(script).toContain("Write-WedgeBreadcrumb $wedgeAgeMs");
    // Kill($true) is .NET Core only; the supervisor must run under PS 5.1.
    expect(script).toContain("$process.Kill()");
    expect(script).not.toContain("$process.Kill($true)");
  });

  it("treats a suspended machine as sleep rather than as a wedge", () => {
    const script = renderWindowsServiceLauncher(command, {
      pidPath: "C:\\ade\\launcher.pid.json",
      heartbeatPath: "C:\\ade\\runtime\\heartbeat.json",
      wedgeBreadcrumbPath: "C:\\ade\\runtime\\event-loop-wedge.json",
    });

    // The same floor the macOS watchdog uses (`brainWatcherSuspendFloorMs`), so
    // one rule decides sleep on both platforms.
    expect(script).toContain(
      "$watcherSuspendFloorMs = [Math]::Max($heartbeatStaleMs, $heartbeatPollMs * 3)",
    );
    // The supervisor measures its OWN lateness. Nothing about a suspended brain
    // can be asked of the suspended brain.
    expect(script).toContain("$watcherGapMs = $nowMs - $lastPollAtMs");
    expect(script).toContain(
      "if ($watcherGapMs -ge $watcherSuspendFloorMs -and $beatAgeMs -le ($watcherGapMs + $heartbeatStaleMs))",
    );
    expect(script).toContain("machine slept pid=");
  });

  it("requires the same stale beat twice before killing", () => {
    const script = renderWindowsServiceLauncher(command, {
      pidPath: "C:\\ade\\launcher.pid.json",
      heartbeatPath: "C:\\ade\\runtime\\heartbeat.json",
      wedgeBreadcrumbPath: "C:\\ade\\runtime\\event-loop-wedge.json",
    });

    // The beat's timestamp, not its age: the age changes between two polls of
    // the same unchanged beat, so only the timestamp can identify it.
    expect(script).toContain("return [long]$beat.ts");
    expect(script).toContain("elseif ($confirmedStaleBeatTs -ne $staleBeatTs)");
    expect(script).toContain("waiting for a second check before acting");
    // A beat that came back fresh clears the strike, so two stale polls have to
    // be consecutive.
    expect(script).toContain("if ($null -eq $staleBeatTs) { $confirmedStaleBeatTs = $null }");
    // The kill is the last branch, reachable only once both rules pass.
    expect(script).toContain("else { $wedgeAgeMs = $beatAgeMs }");
  });

  it("stops the wedged brain's whole process tree, through an absolute taskkill", () => {
    const script = renderWindowsServiceLauncher(command, {
      pidPath: "C:\\ade\\launcher.pid.json",
      heartbeatPath: "C:\\ade\\runtime\\heartbeat.json",
      wedgeBreadcrumbPath: "C:\\ade\\runtime\\event-loop-wedge.json",
    });

    // Absolute System32 path, never a bare `taskkill` off PATH. On a real
    // Windows host the resolver returns the verified filesystem form
    // (C:\Windows\System32\taskkill.exe); elsewhere it falls back to the
    // kernel GLOBALROOT form — both end in System32\taskkill.exe.
    expect(script).toMatch(/\$taskkillPath = '[^']*System32\\taskkill\.exe'/i);
    expect(script).toContain("& $taskkillPath '/PID' $process.Id '/T' '/F'");
    // Kill() alone orphans ConPTYs and agent CLIs, so the tree kill must come
    // first and Kill() must only mop up what taskkill could not.
    const taskkillAt = script.indexOf("& $taskkillPath");
    const killAt = script.indexOf("$process.Kill()");
    expect(taskkillAt).toBeGreaterThan(-1);
    expect(taskkillAt).toBeLessThan(killAt);
    expect(script).toContain("if (-not $process.HasExited) { $process.Kill() }");
    // Bounded, and never a bare WaitForExit(): if taskkill was unresolvable and
    // Kill() threw, an unbounded wait parks the supervisor on the wedge forever.
    expect(script).not.toContain("$process.WaitForExit()");
    const waitAt = script.indexOf("if ($process.WaitForExit(30000)) { break }", killAt);
    expect(waitAt).toBeGreaterThan(killAt);
    expect(script).toContain("did not exit after the kill");
    // Leaving the wait loop is conditional on the process being GONE. An
    // unconditional break after a timed-out kill would start a second brain
    // beside an unkillable one, both wanting the same ports and worktrees.
    expect(script).not.toMatch(/WaitForExit\(30000\)[^\r\n]*[\r\n]+\s*break/);
    const wedgeRetryAt = script.indexOf("retrying on the next heartbeat check", waitAt);
    expect(wedgeRetryAt).toBeGreaterThan(waitAt);
    // The bounded wait can fall through with the process still alive, and
    // `.ExitCode` throws on a live process -- which would surface the wedge as
    // a launch failure. Read it only once the process has actually exited.
    expect(script).toContain(
      "if ($process.HasExited) { $lastExitCode = $process.ExitCode } else { $lastExitCode = $null }",
    );
    // ...and never as an unguarded statement of its own.
    expect(script).not.toMatch(/(?:^|[\r\n])\s*\$lastExitCode = \$process\.ExitCode/);
  });

  it("keeps the beat interval and stale threshold bound to the brain's own", () => {
    const script = renderWindowsServiceLauncher(command, {
      pidPath: "C:\\ade\\launcher.pid.json",
      heartbeatPath: "C:\\ade\\runtime\\heartbeat.json",
    });
    expect(script).toContain(`$heartbeatStaleMs = ${BRAIN_HEARTBEAT_STALE_MS}`);
    expect(script).toContain(`$heartbeatPollMs = ${BRAIN_HEARTBEAT_INTERVAL_MS}`);
  });

  it("only judges a beat that belongs to the child it started", () => {
    const script = renderWindowsServiceLauncher(command, {
      pidPath: "C:\\ade\\launcher.pid.json",
      heartbeatPath: "C:\\ade\\runtime\\heartbeat.json",
      wedgeBreadcrumbPath: "C:\\ade\\runtime\\event-loop-wedge.json",
    });
    expect(script).toContain("if ([int]$beat.pid -ne $runtimePid) { return $null }");
    expect(script).toContain("if ($ageMs -le $heartbeatStaleMs) { return $null }");
  });

  it("keeps its old exit-only behaviour when no heartbeat path is configured", () => {
    const script = renderWindowsServiceLauncher(command, {
      pidPath: "C:\\ade\\launcher.pid.json",
    });
    expect(script).toContain("$heartbeatPath = $null");
    expect(script).toContain("if ([string]::IsNullOrEmpty($heartbeatPath)) { return $null }");
  });

  it("refuses a stale threshold short enough to fire on an ordinary gap", () => {
    const script = renderWindowsServiceLauncher(command, {
      pidPath: "C:\\ade\\launcher.pid.json",
      heartbeatPath: "C:\\ade\\runtime\\heartbeat.json",
      heartbeatStaleMs: 500,
    });
    expect(script).toContain("$heartbeatStaleMs = 30000");
  });

  it("reads the same runtime staleness override the macOS watchdog reads", () => {
    const script = renderWindowsServiceLauncher(command, {
      pidPath: "C:\\ade\\launcher.pid.json",
      heartbeatPath: "C:\\ade\\runtime\\heartbeat.json",
    });
    expect(script).toContain("$staleOverrideRaw = $env:ADE_BRAIN_HEARTBEAT_STALE_MS");
    // Same rules as `resolveBrainHeartbeatStaleMs`: leading digits only, a
    // positive value only, and never below the 30s floor.
    expect(script).toContain("if ($staleOverrideRaw -match '^\\s*[+-]?\\d+') {");
    expect(script).toContain(
      "if ([long]::TryParse($Matches[0].Trim(), [ref]$staleOverrideMs) -and $staleOverrideMs -gt 0) {",
    );
    expect(script).toContain("$heartbeatStaleMs = [Math]::Max(30000, $staleOverrideMs)");
    // The rendered default still has to be there for the override to fall back to.
    expect(script).toContain(`$heartbeatStaleMs = ${BRAIN_HEARTBEAT_STALE_MS}`);
  });

  it("computes the suspend floor after the override so it rescales", () => {
    const script = renderWindowsServiceLauncher(command, {
      pidPath: "C:\\ade\\launcher.pid.json",
      heartbeatPath: "C:\\ade\\runtime\\heartbeat.json",
    });
    const overrideAt = script.indexOf("$heartbeatStaleMs = [Math]::Max(30000, $staleOverrideMs)");
    const floorAt = script.indexOf(
      "$watcherSuspendFloorMs = [Math]::Max($heartbeatStaleMs, $heartbeatPollMs * 3)",
    );
    expect(overrideAt).toBeGreaterThan(-1);
    expect(floorAt).toBeGreaterThan(overrideAt);
  });

  it("does not override the poll interval, which macOS has no override for", () => {
    const script = renderWindowsServiceLauncher(command, {
      pidPath: "C:\\ade\\launcher.pid.json",
      heartbeatPath: "C:\\ade\\runtime\\heartbeat.json",
    });
    expect(script).not.toContain("ADE_BRAIN_HEARTBEAT_POLL_MS");
    expect(script).toContain(`$heartbeatPollMs = ${BRAIN_HEARTBEAT_INTERVAL_MS}`);
  });
});

/**
 * Every other assertion in this file checks that the generated PowerShell
 * CONTAINS some text. None of them can tell whether the result parses: a stray
 * brace or a branch split the wrong way produces a script that matches every
 * substring and still dies at launch, on a user's machine, with the supervisor
 * never starting. These tests close that gap by handing the rendered text to
 * PowerShell's own parser.
 *
 * `Parser::ParseFile` and `Parser::ParseInput` only build a syntax tree. They do
 * not execute the script, dot-source it, or run anything it names, so this is
 * safe on CI and safe here -- the launcher these tests parse would start a brain
 * if it were ever run, and it never is.
 *
 * PowerShell exists only on Windows hosts, so the probe below resolves to null
 * on macOS and Linux and every test here skips. The `windows-foundation` CI job
 * (.github/workflows/ci.yml) runs this file on `windows-latest`, which is where
 * they actually execute -- so the parse gate holds on every PR without anyone
 * running a manual smoke test.
 */
function resolvePowerShellForParsing(): string | null {
  if (process.platform !== "win32") return null;
  // The same canonical System32 resolution the product code uses, rather than a
  // bare name a PATH-planted powershell.exe could answer.
  let candidate: string;
  try {
    candidate = resolveTrustedWindowsTool("powershell");
  } catch {
    return null;
  }
  try {
    const probe = spawnChildSync(
      candidate,
      ["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
      { encoding: "utf8" },
    );
    if (!probe.error && probe.status === 0) return candidate;
  } catch {
    // An interpreter that will not start is not a test failure; the tests skip.
  }
  return null;
}

const powerShellForParsing = resolvePowerShellForParsing();
const itWithPowerShell = powerShellForParsing ? it : it.skip;

/**
 * Parses a file and reports the parser's own diagnostics. Written as a one-line
 * `-Command` program on purpose: it is the form that tolerates no split
 * branches, which is exactly the property being tested for elsewhere.
 */
function parsePowerShellFile(scriptPath: string): { status: number | null; output: string } {
  const literal = scriptPath.replace(/'/g, "''");
  const program = [
    "$tokens = $null",
    "$errs = $null",
    `[void][System.Management.Automation.Language.Parser]::ParseFile('${literal}', [ref]$tokens, [ref]$errs)`,
    "if ($errs -and $errs.Count -gt 0) { $errs | ForEach-Object { Write-Output $_.Message }; exit 1 }",
    "exit 0",
  ].join("; ");
  const result = spawnChildSync(
    powerShellForParsing ?? trustedWindowsToolKernelPath("powershell"),
    ["-NoProfile", "-NonInteractive", "-Command", program],
    { encoding: "utf8" },
  );
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

function writeScript(dir: string, name: string, contents: string): string {
  const scriptPath = path.join(dir, name);
  // The BOM the installer writes is part of what ships, so parse what ships.
  fs.writeFileSync(scriptPath, `\uFEFF${contents}`, "utf8");
  return scriptPath;
}

describe("generated PowerShell parses", () => {
  const command = {
    command: "C:\\ade\\node.exe",
    args: ["C:\\ade\\cli.cjs", "serve"],
    env: { ADE_HOME: "C:\\Users\\example\\.ade" },
  };

  (process.platform === "win32" ? it : it.skip)(
    "resolves a PowerShell interpreter on a Windows host",
    () => {
      // The guard on the guard. Every parse check below is skipped when the
      // probe finds no interpreter, so a probe that quietly stopped working
      // would skip all of them on CI and leave a green job proving nothing.
      // On a Windows host, failing to find PowerShell is a failure, not a skip.
      expect(powerShellForParsing).not.toBeNull();
    },
  );

  itWithPowerShell("the supervisor launcher is syntactically valid", () => {
    const dir = makeTempHome("ade-windows-parse-");
    const scriptPath = writeScript(
      dir,
      "brain-service.ps1",
      renderWindowsServiceLauncher(command, {
        pidPath: "C:\\ade\\launcher.pid.json",
        logPath: "C:\\ade\\launcher.log",
        heartbeatPath: "C:\\ade\\runtime\\heartbeat.json",
        wedgeBreadcrumbPath: "C:\\ade\\runtime\\event-loop-wedge.json",
      }),
    );

    const parsed = parsePowerShellFile(scriptPath);
    expect(parsed.output).toBe("");
    expect(parsed.status).toBe(0);
  });

  itWithPowerShell("the launcher still parses with every optional path absent", () => {
    // The `$null` branches of the renderer produce different text, so the
    // minimal launcher is a genuinely different program from the full one.
    const dir = makeTempHome("ade-windows-parse-minimal-");
    const scriptPath = writeScript(
      dir,
      "brain-service.ps1",
      renderWindowsServiceLauncher(command, { pidPath: "C:\\ade\\launcher.pid.json" }),
    );

    const parsed = parsePowerShellFile(scriptPath);
    expect(parsed.output).toBe("");
    expect(parsed.status).toBe(0);
  });

  itWithPowerShell("the one-line -Command query builders are syntactically valid", () => {
    const dir = makeTempHome("ade-windows-parse-queries-");
    // These are joined with "; " into a single line and passed to `-Command`,
    // where a branch split across lines would NOT parse. Parsing them as files
    // is equivalent: a one-line program is valid script-file content too.
    const builders: Array<[string, string[]]> = [
      ["supervisor-query.ps1", buildWindowsSupervisorQueryArgs(1234, "C:\\ade\\brain-service.ps1")],
      ["runtime-query.ps1", buildWindowsRuntimeQueryArgs(1234, command)],
    ];

    for (const [name, args] of builders) {
      const program = args[args.indexOf("-Command") + 1];
      expect(program).toBeTruthy();
      const parsed = parsePowerShellFile(writeScript(dir, name, program));
      expect(parsed.output, name).toBe("");
      expect(parsed.status, name).toBe(0);
    }
  });
});

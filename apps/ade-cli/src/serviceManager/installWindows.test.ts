import fs from "node:fs";
import { createHash } from "node:crypto";
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
  buildWindowsRunKeyListArgs,
  resolveWindowsAdeDir,
  parseWindowsRunKeyValues,
  windowsRunCommandNamesLauncher,
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
  resolveWindowsBrainOutputLogPath,
  buildWindowsBrainReportFunction,
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

/**
 * Kills a supervisor started detached through Start-Process. Its pid record is
 * the only handle on it, and one read races the supervisor's first
 * Write-PidRecord: when the read lost, the supervisor was never killed and
 * kept restarting its child for the rest of the run, holding the temp tree
 * open (EBUSY on unlink) and starving every later suite. So wait for the
 * record before giving up on the kill.
 */
async function killDetachedSupervisor(pidPath: string): Promise<void> {
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
    // These legacy scenarios have no extra Run values or unrecorded
    // supervisors. Model the new maintenance boundaries independently of
    // their lifecycle result sequence; the repair test below owns them.
    if (command === windowsRegCommand() && JSON.stringify(args) === JSON.stringify(buildWindowsRunKeyListArgs())) return { status: 0, stdout: "", stderr: "" };
    if (command === windowsPowerShellCommand() && args.at(-1)?.includes("GetOwnerSid")) return { status: 0, stdout: "0", stderr: "" };
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

    // The one-shot start task runs the supervisor, and the brain and the
    // desktop driver inherit its priority. Task Scheduler's default (7) is
    // below normal with low memory and I/O priority, which paged the brain out
    // for 2-45 s at a time on a real PC; the task must ask for normal (4).
    const startTask = buildWindowsStartTaskArgs("C:\\Users\\arul\\.ade\\runtime\\brain-service.ps1", resolveWindowsStartTaskName(taskName));
    const program = startTask[startTask.indexOf("-Command") + 1] ?? "";
    const settings = program.match(/\$settings = New-ScheduledTaskSettingsSet ([^;]*)/)?.[1] ?? "";
    expect(settings.match(/-Priority (\d+)/)?.[1]).toBe("4");
    expect(program).toMatch(/Register-ScheduledTask [^;]*-Settings \$settings/);
    expect(settings).toContain("-ExecutionTimeLimit ([TimeSpan]::Zero)");
  });

  it("keeps the user identity stable across SSH and desktop domain labels", () => {
    const desktop = resolveWindowsTaskUser({ USERDOMAIN: "ADEBOX", USERNAME: "arul" });
    expect(resolveWindowsTaskUser({ USERDOMAIN: "WORKGROUP", USERNAME: "arul" })).toBe(desktop);
    expect(resolveWindowsTaskUser({ USERDOMAIN: "ADEBOX", USERNAME: "ADEBOX\\arul" })).toBe(desktop);
    if (process.platform !== "win32") expect(desktop).toBe("arul");
  });

  it.each([
    ['powershell.exe -File "C:\\ADE\\brain.ps1"', true],
    ['powershell.exe "-File" "c:/ade/brain.ps1"', true],
    ['powershell.exe -File "C:\\ADE\\brain.ps1.old"', false],
    ['powershell.exe -File "C:\\Other\\brain.ps1" -Log "C:\\ADE\\brain.ps1"', false],
  ])("recognizes the exact launcher argument: %s", (command, matches) => {
    expect(windowsRunCommandNamesLauncher(command, "C:\\ADE\\brain.ps1")).toBe(matches);
  });

  it("reads named Run values without consuming registry headers", () => {
    expect(parseWindowsRunKeyValues("HKEY_CURRENT_USER\\Run\r\n    ADE Runtime (beta-old)    REG_SZ    powershell -File \"C:\\ADE\\brain.ps1\"\r\n    unrelated    REG_DWORD    1\r\n"))
      .toEqual([
        { name: "ADE Runtime (beta-old)", command: 'powershell -File "C:\\ADE\\brain.ps1"' },
        { name: "unrelated", command: "1" },
      ]);
  });

  it.each(["install", "uninstall"] as const)("%s prunes duplicate channel entries while retaining other apps and channels", async (operation) => {
    const launcherPath = path.join(makeTempHome("ade-windows-service-prune-"), "brain.ps1");
    const startup = new Map([
      ["ADE Runtime (beta-old-ssh)", `powershell.exe -File "${launcherPath}"`],
      ["Old ADE launcher", `powershell.exe -File "${launcherPath}"`],
      ["ADE Runtime (stable-other)", 'powershell.exe -File "C:\\Other\\brain.ps1"'],
      ["Other app", `powershell.exe -File "${launcherPath}.old"`],
    ]);
    const run: ServiceManagerSpawnSync = (command, args) => {
      if (command === windowsRegCommand()) {
        const valueAt = args.indexOf("/V");
        const name = valueAt < 0 ? null : args[valueAt + 1]!;
        if (args[0] === "QUERY" && !name) return { status: 0, stdout: [...startup].map(([key, value]) => `    ${key}    REG_SZ    ${value}`).join("\r\n"), stderr: "" };
        if (args[0] === "QUERY") return { status: startup.has(name!) ? 0 : 1, stdout: startup.get(name!) ?? "", stderr: "" };
        if (args[0] === "DELETE") startup.delete(name!);
        if (args[0] === "ADD") startup.set(name!, args[args.indexOf("/D") + 1]!);
        return { status: 0, stdout: "", stderr: "" };
      }
      if ([taskName, "ADE Runtime"].some((name) => JSON.stringify(args) === JSON.stringify(buildWindowsQueryTaskArgs(name)))) return { status: 3, stdout: "", stderr: "" };
      return { status: 0, stdout: "0", stderr: "" };
    };
    const deps = { ...immediateReadiness, command: serviceCommand, launcherPath, serviceName, userName: taskUser, spawnSync: run };
    const result = operation === "install" ? await installWindowsService(deps) : await uninstallWindowsService(deps);
    expect(result.ok).toBe(true);
    expect([...startup.keys()].sort()).toEqual([
      "ADE Runtime (stable-other)", "Other app", ...(operation === "install" ? [taskName] : []),
    ].sort());
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
        await killDetachedSupervisor(`${launcherPath}.pid.json`);
      }
    },
    90_000,
  );

  // The drain is C# compiled by Add-Type at supervisor start, so only a real
  // Windows PowerShell run can prove it compiles, never blocks the brain on a
  // full pipe, splits a line with no newline, keeps stderr, and rotates.
  (process.platform === "win32" ? it : it.skip)(
    "drains the brain's stdout and stderr into a bounded, rotating output log",
    async () => {
      const home = makeTempHome("ade windows brain output-");
      const launcherPath = path.join(home, "brain-service.ps1");
      const outputLogPath = path.join(home, "brain-output.log");
      const donePath = path.join(home, "child-done");
      // ~220 KB of lines first (past the 64 KiB rotation floor, so the log
      // rotates; only one previous file is kept, so the lines checked below
      // come last), then 20,000 chars with no newline, then stderr. The child
      // then stays alive (a finished child would be restarted and write
      // everything again).
      const childScript = [
        "const fs = require('node:fs');",
        "for (let i = 0; i < 2000; i += 1) process.stdout.write(`line-${i} ${'x'.repeat(72)}\\n`);",
        "process.stdout.write('L'.repeat(20000));",
        "process.stdout.write('\\n');",
        "process.stderr.write('stderr-marker\\n');",
        "process.stdout.write('last-line\\n', () => fs.writeFileSync(process.env.ADE_TEST_DONE, 'ok'));",
        "setInterval(() => {}, 1000);",
      ].join(" ");
      fs.writeFileSync(
        launcherPath,
        `\uFEFF${renderWindowsServiceLauncher({
          command: process.execPath,
          args: ["-e", childScript],
          env: { ADE_TEST_DONE: donePath },
        }, {
          pidPath: `${launcherPath}.pid.json`,
          initialRestartDelayMs: 100,
          brainOutputLogPath: outputLogPath,
          brainOutputMaxBytes: 64 * 1024,
        })}`,
        "utf8",
      );

      const bootstrap = spawnChildSync(
        windowsPowerShellCommand(),
        buildWindowsStartLauncherArgs(launcherPath),
        { encoding: "utf8", windowsHide: true },
      );
      try {
        expect(bootstrap.status).toBe(0);
        // The supervisor rotates by renaming the live file, so a file can
        // vanish between listing and reading; a missing file reads as empty.
        const readIfPresent = (file: string): string => {
          try {
            return fs.readFileSync(file, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
            throw error;
          }
        };
        const readLog = (): string =>
          [`${outputLogPath}.1`, outputLogPath].map(readIfPresent).join("");
        // The child's done file only says its writes returned; the drain
        // threads (one per stream) append after that, so wait for both.
        const drained = (log: string): boolean =>
          log.includes(" out last-line") && log.includes(" err stderr-marker");
        const deadline = Date.now() + 60_000;
        while (!drained(readLog()) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(fs.existsSync(donePath)).toBe(true);
        const lines = readLog().split("\r\n").filter(Boolean);
        expect(lines.some((line) => line.endsWith(" err stderr-marker"))).toBe(true);
        expect(lines.some((line) => line.endsWith(" out last-line"))).toBe(true);
        // The no-newline line comes out in bounded pieces (a pending buffer
        // under 8,192 chars plus one 8,192-char read), and none of it is lost.
        const longPieces = lines
          .map((line) => /^\S+ out (L+)$/.exec(line)?.[1] ?? null)
          .filter((piece): piece is string => piece !== null);
        expect(longPieces.length).toBeGreaterThan(1);
        expect(longPieces.every((piece) => piece.length < 2 * 8192)).toBe(true);
        expect(longPieces.join("").length).toBe(20000);
        // Rotation: one previous file, and the live file stays near the cap.
        expect(fs.existsSync(`${outputLogPath}.1`)).toBe(true);
        expect(fs.statSync(outputLogPath).size).toBeLessThan(64 * 1024 + 16 * 1024);
      } finally {
        await killDetachedSupervisor(`${launcherPath}.pid.json`);
      }
    },
    120_000,
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
    expect(fs.existsSync(launcherPath)).toBe(true);
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
      brainOutputLogPath: resolveWindowsBrainOutputLogPath({ launcherPath }),
      heartbeatPath: path.win32.join(machineLayout.runtimeDir, "heartbeat.json"),
      wedgeBreadcrumbPath: path.win32.join(machineLayout.runtimeDir, "event-loop-wedge.json"),
      adeDir: resolveWindowsAdeDir({ ...process.env, ...(serviceCommand.env ?? {}) }),
      mutexName: `Global\\ade-supervisor-${createHash("sha256").update(launcherPath).digest("hex").slice(0, 12)}-${createHash("sha256").update(taskUser).digest("hex").slice(0, 12)}`,
      socketPath: machineLayout.socketPath,
      lastFailurePath: path.win32.join(machineLayout.runtimeDir, "last-failure.json"),
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

// The predecessor sweep's PowerShell script is the only one that carries this text.
const PREDECESSOR_SWEEP_MARKER = "Existing ADE supervisor did not stop.";
// The identity-checked forced kill is the only PowerShell script that runs a
// tree kill against a single literal pid.
const IDENTITY_KILL_MARKER = "'/T' '/F' | Out-Null";

/**
 * Answers the predecessor sweep with `sweepStdout` and records every spawn. The
 * identity-checked forced kill is answered by `forcedKill`, which defaults to a
 * clean exit. Every other query finds nothing, so an uninstall reaches the sweep
 * and nothing else that would need a real Windows host.
 */
function predecessorSweepSpawn(options: {
  calls: Array<{ command: string; args: string[] }>;
  sweepStdout: string;
  sweepStatus?: number;
  forcedKill?: (script: string) => ServiceManagerProcessResult;
}): ServiceManagerSpawnSync {
  return (command, args) => {
    options.calls.push({ command, args });
    const script = args.at(-1) ?? "";
    if (command === windowsPowerShellCommand() && script.includes(PREDECESSOR_SWEEP_MARKER)) {
      return { status: options.sweepStatus ?? 0, stdout: options.sweepStdout, stderr: "" };
    }
    if (command === windowsPowerShellCommand() && script.includes(IDENTITY_KILL_MARKER)) {
      return options.forcedKill?.(script) ?? { status: 0, stdout: "exited", stderr: "" };
    }
    if (command === windowsPowerShellCommand()) return { status: 3, stdout: "", stderr: "" };
    if (command === windowsRegCommand() && JSON.stringify(args) === JSON.stringify(buildWindowsRunKeyListArgs())) {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === windowsRegCommand()) return { status: 1, stdout: "", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
}

function predecessorSweepScript(calls: Array<{ command: string; args: string[] }>): string {
  const sweep = calls.find((call) => call.command === windowsPowerShellCommand() && call.args.at(-1)?.includes(PREDECESSOR_SWEEP_MARKER));
  if (!sweep) throw new Error("the uninstall never ran the predecessor sweep");
  return sweep.args.at(-1) ?? "";
}

describe("Windows predecessor supervisor sweep", () => {
  const serviceName = "com.ade.runtime.beta";
  const taskUser = "ADEBOX\\arul";
  const serviceCommand: AdeServiceCommand = {
    command: "C:\\Program Files\\ADE\\ade.exe",
    args: ["C:\\Program Files\\ADE\\resources\\ade-cli\\cli.cjs", "serve"],
    env: { ADE_HOME: "C:\\Users\\arul\\.ade-beta", ADE_PACKAGE_CHANNEL: "beta" },
  };
  const brainPid = 4242;
  const brainStartFileTime = "133000000000000000";
  const brainLine = `brain ${brainPid} ${brainStartFileTime}`;

  function launcherForSweep(): string {
    const launcherPath = path.join(makeTempHome("ade-windows-sweep-"), "brain-service.ps1");
    fs.writeFileSync(launcherPath, "old launcher", "utf8");
    return launcherPath;
  }

  it("never kills the predecessor brain from PowerShell; the sweep only reports its pid and start time", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    await uninstallWindowsService({
      command: serviceCommand,
      launcherPath: launcherForSweep(),
      serviceName,
      spawnSync: predecessorSweepSpawn({ calls, sweepStdout: "" }),
      userName: taskUser,
    });

    const script = predecessorSweepScript(calls);
    expect(script).not.toMatch(/\$child\.Kill\(\)/);
    // The supervisor is still stopped in PowerShell: a brain stopped while its
    // supervisor lives is relaunched at once.
    expect(script).toContain("$target.Process.Kill()");
    expect(script).toContain("StartTime.ToFileTimeUtc()");
    expect(script).toContain("foreach ($child in $target.Children) { Write-BrainReport $child }");
  });

  it("asks a predecessor brain to shut down over RPC before any tree kill", async () => {
    const events: string[] = [];
    let brainAlive = true;
    const result = await uninstallWindowsService({
      command: serviceCommand,
      launcherPath: launcherForSweep(),
      serviceName,
      spawnSync: predecessorSweepSpawn({
        calls: [],
        sweepStdout: `supervisor\n${brainLine}\n`,
        forcedKill: () => {
          events.push("forced");
          return { status: 0, stdout: "exited", stderr: "" };
        },
      }),
      userName: taskUser,
      terminateDeps: {
        pidAlive: () => brainAlive,
        requestRuntimeShutdown: async ({ pid }) => {
          events.push(`rpc ${pid}`);
          brainAlive = false;
          return { requested: true };
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(events).toEqual([`rpc ${brainPid}`]);
  });

  it("force-kills a predecessor brain as a tree, identity-checked, only after its RPC shutdown is refused", async () => {
    const events: string[] = [];
    const forcedScripts: string[] = [];
    const result = await uninstallWindowsService({
      command: serviceCommand,
      launcherPath: launcherForSweep(),
      serviceName,
      spawnSync: predecessorSweepSpawn({
        calls: [],
        sweepStdout: `supervisor\n${brainLine}\n`,
        forcedKill: (script) => {
          events.push("forced");
          forcedScripts.push(script);
          return { status: 0, stdout: "exited", stderr: "" };
        },
      }),
      userName: taskUser,
      terminateDeps: {
        pidAlive: () => true,
        requestRuntimeShutdown: async ({ pid }) => {
          events.push(`rpc ${pid}`);
          return { requested: false, reason: "wedged" };
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(events).toEqual([`rpc ${brainPid}`, "forced"]);
    expect(forcedScripts).toHaveLength(1);
    expect(forcedScripts[0]).toContain(`GetProcessById(${brainPid})`);
    expect(forcedScripts[0]).toContain(`$started -ne ${brainStartFileTime}`);
    expect(forcedScripts[0]).toContain(`'/PID' '${brainPid}' '/T' '/F'`);
  });

  it("compares the brain's start time exactly, with no tolerance window", async () => {
    const forcedScripts: string[] = [];
    await uninstallWindowsService({
      command: serviceCommand,
      launcherPath: launcherForSweep(),
      serviceName,
      spawnSync: predecessorSweepSpawn({
        calls: [],
        sweepStdout: `supervisor\n${brainLine}\n`,
        forcedKill: (script) => {
          forcedScripts.push(script);
          return { status: 0, stdout: "exited", stderr: "" };
        },
      }),
      userName: taskUser,
      terminateDeps: {
        pidAlive: () => true,
        requestRuntimeShutdown: async () => ({ requested: false, reason: "wedged" }),
      },
    });

    // Both sides read Process.StartTime, so a live brain matches its own ticks
    // exactly. A window of even one millisecond let a reused pid be tree-killed.
    const script = forcedScripts[0] ?? "";
    expect(script).not.toMatch(/TotalMilliseconds|-gt 1000/);
    expect(script).toContain(`$started -ne ${brainStartFileTime}`);
  });

  it("holds the brain's process open across the identity check, the tree kill and the exit wait", async () => {
    const forcedScripts: string[] = [];
    await uninstallWindowsService({
      command: serviceCommand,
      launcherPath: launcherForSweep(),
      serviceName,
      spawnSync: predecessorSweepSpawn({
        calls: [],
        sweepStdout: `supervisor\n${brainLine}\n`,
        forcedKill: (script) => {
          forcedScripts.push(script);
          return { status: 0, stdout: "exited", stderr: "" };
        },
      }),
      userName: taskUser,
      terminateDeps: {
        pidAlive: () => true,
        requestRuntimeShutdown: async () => ({ requested: false, reason: "wedged" }),
      },
    });

    // A pid is not reused while a handle to its process is open, so the check
    // and the kill must both run inside the process that holds the handle.
    const script = forcedScripts[0] ?? "";
    const opened = script.indexOf("GetProcessById");
    const identity = script.indexOf("$started -ne");
    const kill = script.indexOf("'/T' '/F'");
    const waited = script.indexOf("WaitForExit(5000)");
    expect(opened).toBeGreaterThanOrEqual(0);
    expect(identity).toBeGreaterThan(opened);
    expect(kill).toBeGreaterThan(identity);
    expect(waited).toBeGreaterThan(kill);
  });

  it("still stops a brain already reported when a later supervisor fails the sweep", async () => {
    const events: string[] = [];
    let brainAlive = true;
    const result = await uninstallWindowsService({
      command: serviceCommand,
      launcherPath: launcherForSweep(),
      serviceName,
      spawnSync: predecessorSweepSpawn({
        calls: [],
        sweepStdout: `supervisor\n${brainLine}\n`,
        sweepStatus: 1,
      }),
      userName: taskUser,
      terminateDeps: {
        pidAlive: () => brainAlive,
        requestRuntimeShutdown: async ({ pid }) => {
          events.push(`rpc ${pid}`);
          brainAlive = false;
          return { requested: true };
        },
      },
    });

    expect(events).toEqual([`rpc ${brainPid}`]);
    expect(result).toMatchObject({ ok: false, action: "uninstall" });
    expect(result.ok ? "" : result.message).toContain("Unable to stop ADE supervisors");
  });

  it("reports a brain that survives its identity-checked kill, and still tries every other brain", async () => {
    const forcedScripts: string[] = [];
    const outcomes = ["survived", "exited"];
    const result = await uninstallWindowsService({
      command: serviceCommand,
      launcherPath: launcherForSweep(),
      serviceName,
      spawnSync: predecessorSweepSpawn({
        calls: [],
        sweepStdout: `supervisor\n${brainLine}\nbrain 4243 133000000000000001\n`,
        forcedKill: (script) => {
          forcedScripts.push(script);
          return { status: 0, stdout: outcomes.shift() ?? "exited", stderr: "" };
        },
      }),
      userName: taskUser,
      terminateDeps: {
        pidAlive: () => true,
        requestRuntimeShutdown: async () => ({ requested: false, reason: "wedged" }),
      },
    });

    expect(forcedScripts).toHaveLength(2);
    expect(forcedScripts[1]).toContain("GetProcessById(4243)");
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toContain("Existing ADE brain did not stop.");
  });

  it("keeps stopping the other brains when one brain's stop throws", async () => {
    const forcedScripts: string[] = [];
    const result = await uninstallWindowsService({
      command: serviceCommand,
      launcherPath: launcherForSweep(),
      serviceName,
      spawnSync: predecessorSweepSpawn({
        calls: [],
        sweepStdout: `supervisor\n${brainLine}\nbrain 4243 133000000000000001\n`,
        forcedKill: (script) => {
          forcedScripts.push(script);
          if (script.includes(`GetProcessById(${brainPid})`)) throw new Error("trusted tool unavailable");
          return { status: 0, stdout: "exited", stderr: "" };
        },
      }),
      userName: taskUser,
      terminateDeps: {
        pidAlive: () => true,
        requestRuntimeShutdown: async () => ({ requested: false, reason: "wedged" }),
      },
    });

    expect(forcedScripts).toHaveLength(2);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toContain("trusted tool unavailable");
  });

  it("identity-checks every candidate before any kill or report, with no time window", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    await uninstallWindowsService({
      command: serviceCommand,
      launcherPath: launcherForSweep(),
      serviceName,
      spawnSync: predecessorSweepSpawn({ calls, sweepStdout: "" }),
      userName: taskUser,
    });

    // A candidate is named by an earlier CIM query, and its pid can be reused
    // before it is opened. The check has to run first, and it has to be exact.
    const script = predecessorSweepScript(calls);
    expect(script).not.toMatch(/TotalMilliseconds|-gt 1000/);
    const supervisorCheck = script.indexOf("Test-AdeProcessIdentity $process");
    const brainCheck = script.indexOf("Test-AdeProcessIdentity $child");
    expect(supervisorCheck).toBeGreaterThan(0);
    expect(brainCheck).toBeGreaterThan(supervisorCheck);
    // Every candidate is identified first. Only then may anything be killed or reported.
    const gate = script.indexOf("if (-not $unresolved)");
    expect(gate).toBeGreaterThan(brainCheck);
    expect(script.indexOf("$target.Process.Kill()")).toBeGreaterThan(gate);
    expect(script.indexOf("foreach ($child in $target.Children) { Write-BrainReport $child }")).toBeGreaterThan(brainCheck);
    // A brain that exits while its start time is read is gone, not a failed sweep.
    expect(script).toContain("catch { if ($child.HasExited) { continue }; throw }");
  });

  it("leaves a pid whose identity no longer matches alone, logs it, and still succeeds", async () => {
    const forcedScripts: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await uninstallWindowsService({
        command: serviceCommand,
        launcherPath: launcherForSweep(),
        serviceName,
        spawnSync: predecessorSweepSpawn({
          calls: [],
          sweepStdout: "skipped 4242\nskipped 4243\n",
          forcedKill: (script) => {
            forcedScripts.push(script);
            return { status: 0, stdout: "exited", stderr: "" };
          },
        }),
        userName: taskUser,
        terminateDeps: {
          pidAlive: () => true,
          requestRuntimeShutdown: async () => ({ requested: false, reason: "wedged" }),
        },
      });

      expect(result.ok).toBe(true);
      expect(forcedScripts).toHaveLength(0);
      const logged = stderr.mock.calls.map(([text]) => String(text)).join("");
      expect(logged).toContain("ADE left pid 4242 alone");
      expect(logged).toContain("ADE left pid 4243 alone");
    } finally {
      stderr.mockRestore();
    }
  });

  it("fails the uninstall closed and stops nothing when a live candidate's owner cannot be read", async () => {
    const events: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await uninstallWindowsService({
        command: serviceCommand,
        launcherPath: launcherForSweep(),
        serviceName,
        spawnSync: predecessorSweepSpawn({
          calls: [],
          sweepStdout: `unresolved ${brainPid}\n`,
          forcedKill: () => {
            events.push("forced");
            return { status: 0, stdout: "exited", stderr: "" };
          },
        }),
        userName: taskUser,
        terminateDeps: {
          pidAlive: () => true,
          requestRuntimeShutdown: async ({ pid }) => {
            events.push(`rpc ${pid}`);
            return { requested: true };
          },
        },
      });

      expect(result).toMatchObject({ ok: false, action: "uninstall" });
      expect(result.ok ? "" : result.message).toContain(`Unable to read the owner of ADE process ${brainPid}`);
      expect(result.ok ? "" : result.message).toContain("stopped nothing");
      // The owner check failed, so nothing is asked to shut down and nothing is killed.
      expect(events).toEqual([]);
      const logged = stderr.mock.calls.map(([text]) => String(text)).join("");
      expect(logged).toContain(`could not read the owner of pid ${brainPid}`);
    } finally {
      stderr.mockRestore();
    }
  });

  it("does not register or start the replacement when a predecessor's owner cannot be read", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = await installWindowsService({
      command: serviceCommand,
      launcherPath: launcherForSweep(),
      serviceName,
      spawnSync: predecessorSweepSpawn({ calls, sweepStdout: `unresolved ${brainPid}\n` }),
      userName: taskUser,
    });

    expect(result).toMatchObject({ ok: false, action: "install" });
    expect(result.ok ? "" : result.message).toContain("stopped nothing");
    expect(calls.some((call) => call.command === windowsRegCommand() && call.args[0] === "ADD")).toBe(false);
  });

  it("stops the install before starting the replacement when the orphaned-brain scan cannot answer", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const sweepAndAnswer = predecessorSweepSpawn({ calls, sweepStdout: "" });
    const result = await installWindowsService({
      command: serviceCommand,
      launcherPath: launcherForSweep(),
      serviceName,
      spawnSync: (command, args) => {
        // A scan that fails is not an empty scan: an orphan it could not see would
        // survive next to the replacement.
        if (command === windowsPowerShellCommand() && JSON.stringify(args) === JSON.stringify(buildWindowsProcessCommandLineQueryArgs())) {
          calls.push({ command, args });
          return { status: 1, stdout: "", stderr: "Access is denied." };
        }
        return sweepAndAnswer(command, args);
      },
      userName: taskUser,
    });

    expect(result).toMatchObject({ ok: false, action: "install" });
    expect(result.ok ? "" : result.message).toContain("orphaned ADE brains");
    expect(result.ok ? "" : result.message).toContain("Access is denied.");
    expect(calls.some((call) => call.command === windowsRegCommand() && call.args[0] === "ADD")).toBe(false);
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

  // The cross-session guards run against the real session API here. A Windows
  // CI runner works in session 0 and a developer may be on Remote Desktop, so
  // neither is the console session: exactly where the launcher used to refuse
  // to start any brain.
  (process.platform === "win32" ? it : it.skip)(
    "starts its brain in whatever session it runs in, and a second supervisor leaves the owner alone",
    async () => {
      const dir = makeTempHome("ade-windows-supervisor-guard-");
      const launcherPath = path.join(dir, "brain-service.ps1");
      const pidPath = `${launcherPath}.pid.json`;
      const brainMarker = path.join(dir, "brains.txt");
      fs.writeFileSync(launcherPath, `﻿${renderWindowsServiceLauncher({
        command: process.execPath,
        args: ["-e", "require('node:fs').appendFileSync(process.env.ADE_TEST_BRAIN_MARKER, process.pid + '\\n'); setInterval(() => {}, 1000)"],
        env: { ADE_TEST_BRAIN_MARKER: brainMarker },
      }, {
        pidPath,
        logPath: `${launcherPath}.log`,
        adeDir: dir,
        mutexName: `Global\\ade-supervisor-test-${process.pid}-${path.basename(dir)}`,
      })}`, "utf8");
      const startSupervisor = () => spawn(windowsPowerShellCommand(), [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcherPath,
      ], { stdio: "ignore", windowsHide: true });
      const owner = startSupervisor();
      try {
        const deadline = Date.now() + 45_000;
        while (!fs.existsSync(brainMarker) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const supervisorLog = () => fs.existsSync(`${launcherPath}.log`) ? fs.readFileSync(`${launcherPath}.log`, "utf8") : "";
        expect(fs.existsSync(brainMarker), supervisorLog()).toBe(true);
        const [brainPid] = fs.readFileSync(brainMarker, "utf8").trim().split("\n").map(Number);
        expect(readWindowsServicePidRecord({ pidPath })).toMatchObject({
          supervisorPid: owner.pid,
          runtimePid: brainPid,
        });

        const second = startSupervisor();
        const secondExit = await new Promise<number | null | "running">((resolve) => {
          const timer = setTimeout(() => resolve("running"), 30_000);
          second.once("exit", (code) => {
            clearTimeout(timer);
            resolve(code);
          });
        });
        if (secondExit === "running" && second.pid) {
          spawnSync("taskkill.exe", ["/PID", String(second.pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
        }
        expect(secondExit).toBe(0);
        expect(supervisorLog()).toContain("another ADE supervisor already owns");
        expect(fs.readFileSync(brainMarker, "utf8").trim().split("\n")).toEqual([String(brainPid)]);
        expect(readWindowsServicePidRecord({ pidPath })?.supervisorPid).toBe(owner.pid);
      } finally {
        if (owner.pid) {
          spawnSync("taskkill.exe", ["/PID", String(owner.pid), "/T", "/F"], {
            encoding: "utf8",
            windowsHide: true,
          });
        }
      }
    },
    90_000,
  );

  (process.platform === "win32" && windowsTestRunsOutsideConsoleSession() ? it : it.skip)(
    "outside the console session, a usable Windows Desktop launch request starts only the driver, even with no brain running",
    async () => {
      const dir = makeTempHome("ade-windows-supervisor-child-");
      const launcherPath = path.join(dir, "brain-service.ps1");
      const pidPath = `${launcherPath}.pid.json`;
      const brainMarker = path.join(dir, "brain.txt");
      const driverMarker = path.join(dir, "driver.txt");
      const driverPath = path.join(dir, "ade-desktop-driver.exe");
      fs.copyFileSync(process.execPath, driverPath);
      fs.mkdirSync(path.join(dir, "windows-desktop"));
      fs.writeFileSync(path.join(dir, "windows-desktop", "child-launch.json"), JSON.stringify({
        driverPath,
        // Start-Process joins these with spaces and no quoting, so no spaces.
        args: ["-e", "require('node:fs').writeFileSync(process.env.ADE_TEST_DRIVER_MARKER,'driver')"],
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      }));
      fs.writeFileSync(launcherPath, `﻿${renderWindowsServiceLauncher({
        command: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync(process.env.ADE_TEST_BRAIN_MARKER, 'brain'); setInterval(() => {}, 1000)"],
        env: { ADE_TEST_BRAIN_MARKER: brainMarker },
      }, {
        pidPath,
        adeDir: dir,
        mutexName: `Global\\ade-supervisor-test-${process.pid}-${path.basename(dir)}`,
      })}`, "utf8");
      const supervisor = spawn(windowsPowerShellCommand(), [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcherPath,
      ], { stdio: "ignore", windowsHide: true, env: { ...process.env, ADE_TEST_DRIVER_MARKER: driverMarker } });
      try {
        // Bounded, so a supervisor that wrongly goes on to run a brain fails
        // here and the finally below still stops it.
        const exitCode = await new Promise<number | null | "running">((resolve) => {
          const timer = setTimeout(() => resolve("running"), 30_000);
          supervisor.once("exit", (code) => {
            clearTimeout(timer);
            resolve(code);
          });
        });
        expect(exitCode).toBe(0);
        const deadline = Date.now() + 30_000;
        while (!fs.existsSync(driverMarker) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(fs.readFileSync(driverMarker, "utf8")).toBe("driver");
        expect(fs.existsSync(brainMarker)).toBe(false);
        expect(fs.existsSync(pidPath)).toBe(false);
      } finally {
        if (supervisor.pid) {
          spawnSync("taskkill.exe", ["/PID", String(supervisor.pid), "/T", "/F"], {
            encoding: "utf8",
            windowsHide: true,
          });
        }
      }
    },
    90_000,
  );
});

/** Whether this test process runs outside the active console session (CI's session 0, Remote Desktop). */
function windowsTestRunsOutsideConsoleSession(): boolean {
  const probe = spawnSync(windowsPowerShellCommand(), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Add-Type -Namespace AdeTest -Name SessionApi -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint WTSGetActiveConsoleSessionId();'; [Console]::Out.Write([AdeTest.SessionApi]::WTSGetActiveConsoleSessionId() -ne [uint32][System.Diagnostics.Process]::GetCurrentProcess().SessionId)",
  ], { encoding: "utf8", windowsHide: true });
  return probe.status === 0 && probe.stdout.trim() === "True";
}

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

  itWithPowerShell("the predecessor sweep script is syntactically valid", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    await uninstallWindowsService({
      command,
      launcherPath: writeScript(makeTempHome("ade-windows-parse-sweep-launcher-"), "brain-service.ps1", "old launcher"),
      serviceName: "com.ade.runtime.beta",
      spawnSync: predecessorSweepSpawn({ calls, sweepStdout: "" }),
      userName: "ADEBOX\\arul",
    });

    const parsed = parsePowerShellFile(
      writeScript(makeTempHome("ade-windows-parse-sweep-"), "predecessor-sweep.ps1", predecessorSweepScript(calls)),
    );
    expect(parsed.output).toBe("");
    expect(parsed.status).toBe(0);
  });

  itWithPowerShell("the identity-checked brain kill script is syntactically valid", async () => {
    const forcedScripts: string[] = [];
    await uninstallWindowsService({
      command,
      launcherPath: writeScript(makeTempHome("ade-windows-parse-forced-launcher-"), "brain-service.ps1", "old launcher"),
      serviceName: "com.ade.runtime.beta",
      spawnSync: predecessorSweepSpawn({
        calls: [],
        sweepStdout: "supervisor\nbrain 4242 133000000000000000\n",
        forcedKill: (script) => {
          forcedScripts.push(script);
          return { status: 0, stdout: "exited", stderr: "" };
        },
      }),
      userName: "ADEBOX\\arul",
      terminateDeps: {
        pidAlive: () => true,
        requestRuntimeShutdown: async () => ({ requested: false, reason: "wedged" }),
      },
    });

    expect(forcedScripts).toHaveLength(1);
    const parsed = parsePowerShellFile(
      writeScript(makeTempHome("ade-windows-parse-forced-"), "brain-kill.ps1", forcedScripts[0] ?? ""),
    );
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
      ["start-task.ps1", buildWindowsStartTaskArgs("C:\\ade\\brain-service.ps1", "ADE Runtime Start")],
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

// These run the generated PowerShell for real, against throwaway processes this
// test starts itself. They execute on the `windows-foundation` job, where PowerShell
// and taskkill are real; elsewhere they skip, as the parse checks above do.
describe("Windows brain identity check and report, run in PowerShell", () => {
  const serviceCommand: AdeServiceCommand = {
    command: "C:\\Program Files\\ADE\\ade.exe",
    args: ["C:\\Program Files\\ADE\\resources\\ade-cli\\cli.cjs", "serve"],
    env: { ADE_HOME: "C:\\Users\\arul\\.ade-beta", ADE_PACKAGE_CHANNEL: "beta" },
  };

  function runPowerShell(program: string): { status: number | null; stdout: string; stderr: string } {
    const result = spawnChildSync(windowsPowerShellCommand(), ["-NoProfile", "-NonInteractive", "-Command", program], {
      encoding: "utf8",
      windowsHide: true,
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  function startThrowawayProcess(): { pid: number; child: ReturnType<typeof spawn> } {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    if (child.pid === undefined) throw new Error("the throwaway process did not start");
    return { pid: child.pid, child };
  }

  function startFileTimeOf(pid: number): string {
    const result = runPowerShell(`[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToFileTimeUtc()`);
    const ticks = result.stdout.trim();
    if (!/^\d+$/.test(ticks)) throw new Error(`no start time for pid ${pid}: ${result.stderr}`);
    return ticks;
  }

  function isAlive(pid: number): boolean {
    const result = runPowerShell(
      `try { $p = [System.Diagnostics.Process]::GetProcessById(${pid}); if ($p.HasExited) { 'gone' } else { 'alive' } } catch [ArgumentException] { 'gone' }`,
    );
    return result.stdout.trim() === "alive";
  }

  /**
   * The identity-checked kill the sweep would run for `brainLine`, captured
   * rather than run: the stub answers `absent`, so nothing is killed while
   * capturing, and the test then runs the captured script itself.
   */
  async function identityKillScriptFor(brainLine: string): Promise<string> {
    const forcedScripts: string[] = [];
    await uninstallWindowsService({
      command: serviceCommand,
      launcherPath: writeScript(makeTempHome("ade-windows-identity-launcher-"), "brain-service.ps1", "old launcher"),
      serviceName: "com.ade.runtime.beta",
      spawnSync: predecessorSweepSpawn({
        calls: [],
        sweepStdout: `supervisor\n${brainLine}\n`,
        forcedKill: (script) => {
          forcedScripts.push(script);
          return { status: 0, stdout: "absent", stderr: "" };
        },
      }),
      userName: "ADEBOX\\arul",
      terminateDeps: {
        pidAlive: () => true,
        requestRuntimeShutdown: async () => ({ requested: false, reason: "wedged" }),
      },
    });
    expect(forcedScripts).toHaveLength(1);
    return forcedScripts[0] ?? "";
  }

  itWithPowerShell("leaves a reused pid alone when its start time differs by one tick or one millisecond", async () => {
    const { pid, child } = startThrowawayProcess();
    try {
      const exact = BigInt(startFileTimeOf(pid));
      for (const drift of [-10_000n, -1n, 1n, 10_000n]) {
        const script = await identityKillScriptFor(`brain ${pid} ${exact + drift}`);
        const result = runPowerShell(script);
        expect(result.stdout.trim(), `drift ${drift} ticks`).toBe("absent");
        expect(isAlive(pid), `drift ${drift} ticks`).toBe(true);
      }
    } finally {
      child.kill();
    }
  }, 120_000);

  itWithPowerShell("tree-kills the brain when its start time matches exactly", async () => {
    const { pid, child } = startThrowawayProcess();
    try {
      const script = await identityKillScriptFor(`brain ${pid} ${startFileTimeOf(pid)}`);
      const result = runPowerShell(script);
      expect(result.stdout.trim()).toBe("exited");
      expect(isAlive(pid)).toBe(false);
    } finally {
      child.kill();
    }
  }, 120_000);

  /**
   * The identity script with its process swapped for a stand-in whose `StartTime`
   * read either exits the process first (the race) or fails while it still runs.
   * Nothing is killed: both outcomes return before the tree kill.
   */
  async function identityScriptWithRacingProcess(exitsDuringRead: boolean): Promise<string> {
    const script = await identityKillScriptFor("brain 4242 133000000000000000");
    const standIn = [
      "$script:exited = $false",
      "function Get-RacingProcess([int]$Id) {",
      "  $p = [pscustomobject]@{ Id = $Id }",
      "  $p | Add-Member -MemberType ScriptProperty -Name Handle -Value { 1 }",
      "  $p | Add-Member -MemberType ScriptProperty -Name HasExited -Value { $script:exited }",
      `  $p | Add-Member -MemberType ScriptProperty -Name StartTime -Value { ${exitsDuringRead ? "$script:exited = $true; " : ""}throw 'Process has exited, so the requested information is not available.' }`,
      "  $p | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($ms) $true }",
      "  $p | Add-Member -MemberType ScriptMethod -Name Dispose -Value { }",
      "  return $p",
      "}",
    ].join("\n");
    const raced = script.replace("[System.Diagnostics.Process]::GetProcessById(4242)", "Get-RacingProcess 4242");
    expect(raced).not.toBe(script);
    return `${standIn}\n${raced}`;
  }

  itWithPowerShell("treats a brain that exits between its running check and its start-time read as gone", async () => {
    const result = runPowerShell(await identityScriptWithRacingProcess(true));
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("absent");
  });

  itWithPowerShell("fails the identity check when its start-time read fails while the brain still runs", async () => {
    const result = runPowerShell(await identityScriptWithRacingProcess(false));
    expect(result.status).not.toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  function brainReportScript(mode: "running" | "exits-during-read" | "read-fails" | "already-exited"): string {
    const startTime = {
      running: "[DateTime]::FromFileTimeUtc(133000000000000000)",
      "exits-during-read": "$script:exited = $true; throw 'Process has exited, so the requested information is not available.'",
      "read-fails": "throw 'Access is denied.'",
      "already-exited": "throw 'StartTime was read for a process that had already exited.'",
    }[mode];
    return [
      "$ErrorActionPreference = 'Stop'",
      buildWindowsBrainReportFunction(),
      `$script:exited = ${mode === "already-exited" ? "$true" : "$false"}`,
      "$child = [pscustomobject]@{ Id = 4242 }",
      "$child | Add-Member -MemberType ScriptProperty -Name HasExited -Value { $script:exited }",
      `$child | Add-Member -MemberType ScriptProperty -Name StartTime -Value { ${startTime} }`,
      "Write-BrainReport $child",
    ].join("\n");
  }

  itWithPowerShell("reports a running brain as one start-time line", () => {
    const result = runPowerShell(brainReportScript("running"));
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("brain 4242 133000000000000000");
  });

  itWithPowerShell("treats a brain that exits during its start-time read as gone, not as a failed sweep", () => {
    const result = runPowerShell(brainReportScript("exits-during-read"));
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  itWithPowerShell("does not read the start time of a brain that has already exited", () => {
    const result = runPowerShell(brainReportScript("already-exited"));
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  itWithPowerShell("rethrows a start-time read that fails while the brain is still running", () => {
    const result = runPowerShell(brainReportScript("read-fails"));
    expect(result.status).not.toBe(0);
    expect(result.stdout.trim()).toBe("");
  });
});

// The sweep's candidate identity check, run for real. The live test lets WMI answer
// every read, so it proves the whole-microsecond comparison against real CIM rows.
// The reuse cases answer only the CIM reads from a stub: the open handle, the start
// time comparison and the kill are the product's own code. Windows only.
describe("Windows predecessor sweep identity, run in PowerShell", () => {
  const serviceCommand: AdeServiceCommand = {
    command: "C:\\Program Files\\ADE\\ade.exe",
    args: ["C:\\Program Files\\ADE\\resources\\ade-cli\\cli.cjs", "serve"],
    env: { ADE_HOME: "C:\\Users\\arul\\.ade-beta", ADE_PACKAGE_CHANNEL: "beta" },
  };
  // The sweep's Win32_Process reads. `supervisors` and `brains` are the enumerated
  // candidates; `fresh` is the one-pid read made while the candidate's handle is held.
  type StubRow = { ProcessId: number; ParentProcessId: number; CreatedFt: string; CommandLine: string };
  // `owners` answers GetOwnerSid for the listed pids: `ReturnValue` 0 with a SID is
  // an owner, anything else is a lookup that failed. Unlisted pids are this user's.
  type StubOwner = { ProcessId: number; ReturnValue: number; Sid: string | null };
  type StubCim = { supervisors: StubRow[]; brains: StubRow[]; fresh: StubRow[]; owners?: StubOwner[] };
  const CIM_STUB = [
    "$global:CimStub = Get-Content -Raw -LiteralPath $env:ADE_SWEEP_STUB | ConvertFrom-Json",
    "function ConvertTo-StubCimRow($row) {",
    "  [pscustomobject]@{ ProcessId = [uint32]$row.ProcessId; ParentProcessId = [uint32]$row.ParentProcessId; CreationDate = [DateTime]::FromFileTimeUtc([long]$row.CreatedFt).ToLocalTime(); CommandLine = [string]$row.CommandLine }",
    "}",
    "function Get-CimInstance {",
    "  param([string]$ClassName, [string]$Filter)",
    "  if ($Filter -eq \"Name = 'powershell.exe'\") { return @($global:CimStub.supervisors | ForEach-Object { ConvertTo-StubCimRow $_ }) }",
    "  if ($Filter -match '^ParentProcessId = (\\d+)$') { return @($global:CimStub.brains | Where-Object { [int]$_.ParentProcessId -eq [int]$Matches[1] } | ForEach-Object { ConvertTo-StubCimRow $_ }) }",
    "  if ($Filter -match '^ProcessId = (\\d+)$') { return @($global:CimStub.fresh | Where-Object { [int]$_.ProcessId -eq [int]$Matches[1] } | ForEach-Object { ConvertTo-StubCimRow $_ }) }",
    "  throw \"unstubbed CIM filter: $Filter\"",
    "}",
    "function Invoke-CimMethod {",
    "  param($InputObject, $MethodName)",
    "  $listed = @($global:CimStub.owners | Where-Object { [int]$_.ProcessId -eq [int]$InputObject.ProcessId })",
    "  if ($listed.Count -gt 0) { return [pscustomobject]@{ ReturnValue = [int]$listed[0].ReturnValue; Sid = $listed[0].Sid } }",
    "  [pscustomobject]@{ ReturnValue = 0; Sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value }",
    "}",
  ].join("\n");
  const REUSE_OFFSETS: Array<[string, bigint]> = [
    ["1 us early", -10n],
    ["1 us late", 10n],
    ["1 ms early", -10_000n],
    ["1 ms late", 10_000n],
    ["900 ms early", -9_000_000n],
    ["900 ms late", 9_000_000n],
  ];
  const brainCommandLine = "node.exe -e setInterval(()=>{},1000) serve";
  const supervisorCommandLine = (launcherPath: string) => `powershell.exe -NoProfile -File "${launcherPath}"`;

  function runPs(script: string, env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
    const result = spawnChildSync(windowsPowerShellCommand(), ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", timeout: 60_000, windowsHide: true, env: { ...process.env, ...env },
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  function fileTimeOf(pid: number): string {
    const result = runPs(`[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToFileTimeUtc()`);
    const ticks = result.stdout.trim();
    if (!/^\d+$/.test(ticks)) throw new Error(`no start time for pid ${pid}: ${result.stderr}`);
    return ticks;
  }

  function isAlive(pid: number): boolean {
    const result = runPs(
      `try { $p = [System.Diagnostics.Process]::GetProcessById(${pid}); if ($p.HasExited) { 'gone' } else { 'alive' } } catch [ArgumentException] { 'gone' }`,
    );
    return result.stdout.trim() === "alive";
  }

  function startThrowawayProcess(): { pid: number; child: ReturnType<typeof spawn> } {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    if (child.pid === undefined) throw new Error("the throwaway process did not start");
    return { pid: child.pid, child };
  }

  function stubRow(processId: number, parentProcessId: number, createdFt: string, commandLine: string): StubRow {
    return { ProcessId: processId, ParentProcessId: parentProcessId, CreatedFt: createdFt, CommandLine: commandLine };
  }

  function shiftedFileTime(ticks: string, offset: bigint): string {
    return (BigInt(ticks) + offset).toString();
  }

  async function sweepScriptFor(launcherPath: string): Promise<string> {
    const calls: Array<{ command: string; args: string[] }> = [];
    await uninstallWindowsService({
      command: serviceCommand,
      launcherPath,
      serviceName: "com.ade.runtime.beta",
      spawnSync: predecessorSweepSpawn({ calls, sweepStdout: "" }),
      userName: "ADEBOX\\arul",
    });
    return predecessorSweepScript(calls);
  }

  function sweepLines(stdout: string): string[] {
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  function runSweepWithStubCim(script: string, stub: StubCim): { status: number | null; lines: string[]; stderr: string } {
    const stubFile = path.join(makeTempHome("ade-windows-sweep-cim-"), "cim.json");
    fs.writeFileSync(stubFile, JSON.stringify({ owners: [], ...stub }), "utf8");
    const result = runPs(`${CIM_STUB}\n${script}`, { ADE_SWEEP_STUB: stubFile });
    return { status: result.status, lines: sweepLines(result.stdout), stderr: result.stderr };
  }

  async function waitForPidFile(file: string): Promise<number> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, "utf8").trim();
        if (/^\d+$/.test(text)) return Number(text);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`the launcher never reported its brain pid (${file})`);
  }

  itWithPowerShell("reports a live predecessor and its brain from real CIM rows, at their exact start times", async () => {
    const dir = makeTempHome("ade-windows-sweep-live-");
    const brainPidFile = path.join(dir, "brain.pid");
    // A stand-in for the supervisor: a real powershell.exe running the launcher path,
    // with a real child whose command line ends in `serve`, the way the brain runs.
    const launcherPath = writeScript(dir, "brain-service.ps1", [
      `$brain = Start-Process -FilePath '${process.execPath}' -ArgumentList '-e','setInterval(()=>{},1000)','serve' -WindowStyle Hidden -PassThru`,
      `Set-Content -LiteralPath '${brainPidFile}' -Value $brain.Id`,
      "Start-Sleep -Seconds 600",
    ].join("\n"));
    const supervisor = spawn(windowsPowerShellCommand(), ["-NoProfile", "-NonInteractive", "-File", launcherPath], {
      stdio: "ignore", windowsHide: true,
    });
    let brainPid: number | undefined;
    try {
      brainPid = await waitForPidFile(brainPidFile);
      const brainTicks = fileTimeOf(brainPid);
      const result = runPs(await sweepScriptFor(launcherPath));
      expect(result.status, result.stderr).toBe(0);
      const lines = sweepLines(result.stdout);
      // CIM's CreationDate has whole microseconds and Process.StartTime has 100 ns ticks.
      // Both are cut to whole microseconds before they are compared, so a live process
      // matches its own CIM row. A process that did not match would be left alone here.
      expect(lines).toContain("supervisor");
      expect(lines).toContain(`brain ${brainPid} ${brainTicks}`);
      expect(isAlive(supervisor.pid ?? 0)).toBe(false);
      expect(isAlive(brainPid)).toBe(true);
    } finally {
      if (brainPid !== undefined) {
        try { process.kill(brainPid); } catch { /* already gone */ }
      }
      supervisor.kill();
    }
  }, 120_000);

  itWithPowerShell("leaves a supervisor pid alone when its enumerated start time is 1 us, 1 ms or 900 ms off", async () => {
    for (const [label, offset] of REUSE_OFFSETS) {
      const { pid, child } = startThrowawayProcess();
      try {
        const launcherPath = writeScript(makeTempHome("ade-windows-sweep-reuse-"), "brain-service.ps1", "old launcher");
        const script = await sweepScriptFor(launcherPath);
        const ticks = fileTimeOf(pid);
        const result = runSweepWithStubCim(script, {
          supervisors: [stubRow(pid, 1, shiftedFileTime(ticks, offset), supervisorCommandLine(launcherPath))],
          brains: [],
          fresh: [stubRow(pid, 1, ticks, supervisorCommandLine(launcherPath))],
        });
        expect(result.lines, label).toEqual([`skipped ${pid}`]);
        expect(isAlive(pid), label).toBe(true);
      } finally {
        child.kill();
      }
    }
  }, 240_000);

  itWithPowerShell("leaves a brain pid alone when its enumerated start time is 1 us, 1 ms or 900 ms off", async () => {
    for (const [label, offset] of REUSE_OFFSETS) {
      const supervisor = startThrowawayProcess();
      const brain = startThrowawayProcess();
      try {
        const launcherPath = writeScript(makeTempHome("ade-windows-sweep-brain-"), "brain-service.ps1", "old launcher");
        const script = await sweepScriptFor(launcherPath);
        const supervisorTicks = fileTimeOf(supervisor.pid);
        const brainTicks = fileTimeOf(brain.pid);
        const result = runSweepWithStubCim(script, {
          supervisors: [stubRow(supervisor.pid, 1, supervisorTicks, supervisorCommandLine(launcherPath))],
          brains: [stubRow(brain.pid, supervisor.pid, shiftedFileTime(brainTicks, offset), brainCommandLine)],
          fresh: [
            stubRow(supervisor.pid, 1, supervisorTicks, supervisorCommandLine(launcherPath)),
            stubRow(brain.pid, supervisor.pid, brainTicks, brainCommandLine),
          ],
        });
        expect(result.lines, label).toContain(`skipped ${brain.pid}`);
        expect(result.lines.some((line) => line.startsWith("brain ")), label).toBe(false);
        expect(isAlive(brain.pid), label).toBe(true);
      } finally {
        brain.child.kill();
        supervisor.child.kill();
      }
    }
  }, 240_000);

  itWithPowerShell("leaves a brain alone when its command line or its parent changed since it was enumerated", async () => {
    const variants: Array<[string, (pid: number, parent: number, ticks: string) => StubRow]> = [
      ["command line", (pid, parent, ticks) => stubRow(pid, parent, ticks, "node.exe -e x unrelated")],
      ["parent", (pid, _parent, ticks) => stubRow(pid, 1, ticks, brainCommandLine)],
    ];
    for (const [label, freshRow] of variants) {
      const supervisor = startThrowawayProcess();
      const brain = startThrowawayProcess();
      try {
        const launcherPath = writeScript(makeTempHome("ade-windows-sweep-changed-"), "brain-service.ps1", "old launcher");
        const script = await sweepScriptFor(launcherPath);
        const supervisorTicks = fileTimeOf(supervisor.pid);
        const brainTicks = fileTimeOf(brain.pid);
        const result = runSweepWithStubCim(script, {
          supervisors: [stubRow(supervisor.pid, 1, supervisorTicks, supervisorCommandLine(launcherPath))],
          brains: [stubRow(brain.pid, supervisor.pid, brainTicks, brainCommandLine)],
          fresh: [
            stubRow(supervisor.pid, 1, supervisorTicks, supervisorCommandLine(launcherPath)),
            freshRow(brain.pid, supervisor.pid, brainTicks),
          ],
        });
        expect(result.lines, label).toContain(`skipped ${brain.pid}`);
        expect(result.lines.some((line) => line.startsWith("brain ")), label).toBe(false);
        expect(isAlive(brain.pid), label).toBe(true);
      } finally {
        brain.child.kill();
        supervisor.child.kill();
      }
    }
  }, 240_000);

  itWithPowerShell("leaves a supervisor alone when its command line changed while its handle was held", async () => {
    const { pid, child } = startThrowawayProcess();
    try {
      const launcherPath = writeScript(makeTempHome("ade-windows-sweep-cmdline-"), "brain-service.ps1", "old launcher");
      const script = await sweepScriptFor(launcherPath);
      const ticks = fileTimeOf(pid);
      const result = runSweepWithStubCim(script, {
        supervisors: [stubRow(pid, 1, ticks, supervisorCommandLine(launcherPath))],
        brains: [],
        fresh: [stubRow(pid, 1, ticks, "powershell.exe -NoProfile -Command Start-Sleep")],
      });
      expect(result.lines).toEqual([`skipped ${pid}`]);
      expect(isAlive(pid)).toBe(true);
    } finally {
      child.kill();
    }
  }, 120_000);

  async function waitUntilExited(pid: number): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (isAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  itWithPowerShell("stops nothing when a live brain's owner cannot be read, even though its supervisor checks out", async () => {
    const supervisor = startThrowawayProcess();
    const brain = startThrowawayProcess();
    try {
      const launcherPath = writeScript(makeTempHome("ade-windows-sweep-unresolved-"), "brain-service.ps1", "old launcher");
      const script = await sweepScriptFor(launcherPath);
      const supervisorTicks = fileTimeOf(supervisor.pid);
      const brainTicks = fileTimeOf(brain.pid);
      const result = runSweepWithStubCim(script, {
        supervisors: [stubRow(supervisor.pid, 1, supervisorTicks, supervisorCommandLine(launcherPath))],
        brains: [stubRow(brain.pid, supervisor.pid, brainTicks, brainCommandLine)],
        fresh: [
          stubRow(supervisor.pid, 1, supervisorTicks, supervisorCommandLine(launcherPath)),
          stubRow(brain.pid, supervisor.pid, brainTicks, brainCommandLine),
        ],
        owners: [{ ProcessId: brain.pid, ReturnValue: 9, Sid: null }],
      });
      expect(result.status, result.stderr).toBe(0);
      // The supervisor checks out, but one unresolved candidate means no kill and no brain report.
      expect(result.lines).toEqual([`unresolved ${brain.pid}`]);
      expect(isAlive(supervisor.pid)).toBe(true);
      expect(isAlive(brain.pid)).toBe(true);
    } finally {
      brain.child.kill();
      supervisor.child.kill();
    }
  }, 120_000);

  itWithPowerShell("stops nothing when a live supervisor's owner cannot be read, and does not kill the one that checks out", async () => {
    const unreadable = startThrowawayProcess();
    const verified = startThrowawayProcess();
    try {
      const launcherPath = writeScript(makeTempHome("ade-windows-sweep-unreadable-"), "brain-service.ps1", "old launcher");
      const script = await sweepScriptFor(launcherPath);
      const unreadableTicks = fileTimeOf(unreadable.pid);
      const verifiedTicks = fileTimeOf(verified.pid);
      const result = runSweepWithStubCim(script, {
        supervisors: [
          stubRow(unreadable.pid, 1, unreadableTicks, supervisorCommandLine(launcherPath)),
          stubRow(verified.pid, 1, verifiedTicks, supervisorCommandLine(launcherPath)),
        ],
        brains: [],
        fresh: [stubRow(verified.pid, 1, verifiedTicks, supervisorCommandLine(launcherPath))],
        owners: [{ ProcessId: unreadable.pid, ReturnValue: 2, Sid: null }],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.lines).toEqual([`unresolved ${unreadable.pid}`]);
      expect(isAlive(unreadable.pid)).toBe(true);
      expect(isAlive(verified.pid)).toBe(true);
    } finally {
      unreadable.child.kill();
      verified.child.kill();
    }
  }, 120_000);

  itWithPowerShell("treats a candidate whose owner lookup fails after it exited as gone, not as unresolved", async () => {
    const { pid, child } = startThrowawayProcess();
    try {
      const launcherPath = writeScript(makeTempHome("ade-windows-sweep-exited-"), "brain-service.ps1", "old launcher");
      const script = await sweepScriptFor(launcherPath);
      const ticks = fileTimeOf(pid);
      child.kill();
      await waitUntilExited(pid);
      const result = runSweepWithStubCim(script, {
        supervisors: [stubRow(pid, 1, ticks, supervisorCommandLine(launcherPath))],
        brains: [],
        fresh: [],
        owners: [{ ProcessId: pid, ReturnValue: 9, Sid: null }],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.lines).toEqual([]);
    } finally {
      child.kill();
    }
  }, 120_000);

  itWithPowerShell("skips a candidate owned by another user without reporting it or touching it", async () => {
    const { pid, child } = startThrowawayProcess();
    try {
      const launcherPath = writeScript(makeTempHome("ade-windows-sweep-owner-"), "brain-service.ps1", "old launcher");
      const script = await sweepScriptFor(launcherPath);
      const ticks = fileTimeOf(pid);
      const result = runSweepWithStubCim(script, {
        supervisors: [stubRow(pid, 1, ticks, supervisorCommandLine(launcherPath))],
        brains: [],
        fresh: [stubRow(pid, 1, ticks, supervisorCommandLine(launcherPath))],
        owners: [{ ProcessId: pid, ReturnValue: 0, Sid: "S-1-5-21-OTHER" }],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.lines).toEqual([]);
      expect(isAlive(pid)).toBe(true);
    } finally {
      child.kill();
    }
  }, 120_000);

  itWithPowerShell("gives each candidate one verdict, and reads an owner that cannot be read as unresolved, not skipped", async () => {
    const launcherPath = writeScript(makeTempHome("ade-windows-sweep-fn-"), "brain-service.ps1", "old launcher");
    const script = await sweepScriptFor(launcherPath);
    // The identity functions as the sweep ships them, run against fake process objects
    // and a CIM stub, so each mismatch is named and the expected verdict is explicit.
    const start = script.indexOf("function Get-AdeWholeMicroseconds");
    const end = script.indexOf("$launcher = ");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);

    type Verdict = "match" | "skipped" | "unresolved";
    type Case = { name: string; proc: string; candidate: string; fresh: string; owner?: string; pattern?: string; parent?: string; expect: Verdict };
    const cases: Case[] = [
      { name: "exact start cim equal", proc: "Proc $T", candidate: "Row 1 $T $cmdOk", fresh: "@(Row 1 $T $cmdOk)", expect: "match" },
      { name: "sub microsecond only", proc: "Proc $X", candidate: "Row 1 $T $cmdOk", fresh: "@(Row 1 $T $cmdOk)", expect: "match" },
      { name: "brain sub microsecond only parent matches", proc: "Proc $X", candidate: "Row 77 $T $serveCmd", fresh: "@(Row 77 $T $serveCmd)", pattern: "$brainPattern", parent: "77", expect: "match" },
      { name: "reused 1 us later", proc: "Proc $T", candidate: "Row 1 ($T + 10) $cmdOk", fresh: "@(Row 1 $T $cmdOk)", expect: "skipped" },
      { name: "reused 1 us earlier", proc: "Proc $T", candidate: "Row 1 ($T - 10) $cmdOk", fresh: "@(Row 1 $T $cmdOk)", expect: "skipped" },
      { name: "reused 1 ms late", proc: "Proc $T", candidate: "Row 1 ($T + 10000) $cmdOk", fresh: "@(Row 1 $T $cmdOk)", expect: "skipped" },
      { name: "reused 1 ms early", proc: "Proc $T", candidate: "Row 1 ($T - 10000) $cmdOk", fresh: "@(Row 1 $T $cmdOk)", expect: "skipped" },
      { name: "reused 900 ms late", proc: "Proc $T", candidate: "Row 1 ($T + 9000000) $cmdOk", fresh: "@(Row 1 $T $cmdOk)", expect: "skipped" },
      { name: "reused 900 ms early", proc: "Proc $T", candidate: "Row 1 ($T - 9000000) $cmdOk", fresh: "@(Row 1 $T $cmdOk)", expect: "skipped" },
      { name: "fresh read 1 us off", proc: "Proc $T", candidate: "Row 1 $T $cmdOk", fresh: "@(Row 1 ($T + 10) $cmdOk)", expect: "skipped" },
      { name: "fresh command line changed", proc: "Proc $T", candidate: "Row 1 $T $cmdOk", fresh: "@(Row 1 $T 'powershell.exe -NoProfile -Command Start-Sleep')", expect: "skipped" },
      { name: "brain command line not a serve", proc: "Proc $T", candidate: "Row 77 $T 'node.exe -e x serve'", fresh: "@(Row 77 $T 'node.exe -e x unrelated')", pattern: "$brainPattern", parent: "77", expect: "skipped" },
      { name: "brain parent differs", proc: "Proc $T", candidate: "Row 77 $T 'node.exe -e x serve'", fresh: "@(Row 1 $T 'node.exe -e x serve')", pattern: "$brainPattern", parent: "77", expect: "skipped" },
      { name: "fresh row missing", proc: "Proc $T", candidate: "Row 1 $T $cmdOk", fresh: "@()", expect: "skipped" },
      { name: "owner is another user", proc: "Proc $T", candidate: "Row 1 $T $cmdOk", fresh: "@(Row 1 $T $cmdOk)", owner: "[pscustomobject]@{ ReturnValue = 0; Sid = 'S-1-5-21-OTHER' }", expect: "skipped" },
      // An owner that cannot be read while the process still runs is not another owner.
      { name: "owner unreadable while running", proc: "Proc $T", candidate: "Row 1 $T $cmdOk", fresh: "@(Row 1 $T $cmdOk)", owner: "[pscustomobject]@{ ReturnValue = 9; Sid = $null }", expect: "unresolved" },
      { name: "owner unreadable after exit", proc: "ExitedAfterStart $T", candidate: "Row 1 $T $cmdOk", fresh: "@(Row 1 $T $cmdOk)", owner: "[pscustomobject]@{ ReturnValue = 9; Sid = $null }", expect: "skipped" },
      { name: "start time read throws after exit", proc: "ExitedProc", candidate: "Row 1 $T $cmdOk", fresh: "@(Row 1 $T $cmdOk)", expect: "skipped" },
    ];
    const program = [
      "$ErrorActionPreference = 'Stop'",
      script.slice(start, end),
      "$sid = 'S-1-5-21-TEST'",
      "$pattern = '(?i)(?:^|\\s)-File\\s+(?:\"D:/ade/brain-service\\.ps1\"|D:/ade/brain-service\\.ps1)(?=\\s|$)'",
      "$brainPattern = '(?i)(?:^|\\s)serve\\s*$'",
      "$X = 133000000000000007",
      "$T = $X - 7",
      "$cmdOk = 'powershell.exe -NoProfile -File \"D:/ade/brain-service.ps1\"'",
      "$serveCmd = 'node.exe -e x serve'",
      "$global:Fresh = @()",
      "$global:Owner = $null",
      "function Get-CimInstance { param($ClassName, $Filter) return @($global:Fresh) }",
      "function Invoke-CimMethod { param($InputObject, $MethodName) return $global:Owner }",
      "function Row($ppid, $ft, $cmd) { [pscustomobject]@{ ProcessId = 4242; ParentProcessId = $ppid; CreationDate = [DateTime]::FromFileTimeUtc([long]$ft).ToLocalTime(); CommandLine = $cmd } }",
      "function Proc($ft) { [pscustomobject]@{ Id = 4242; HasExited = $false; StartTime = [DateTime]::FromFileTimeUtc([long]$ft).ToLocalTime() } }",
      "function ExitedAfterStart($ft) { [pscustomobject]@{ Id = 4242; HasExited = $true; StartTime = [DateTime]::FromFileTimeUtc([long]$ft).ToLocalTime() } }",
      "function ExitedProc { $q = [pscustomobject]@{ Id = 4242; HasExited = $true }; $q | Add-Member ScriptProperty StartTime { throw 'Process has exited' }; return $q }",
      ...cases.map((c, i) => [
        `$global:Fresh = ${c.fresh}`,
        `$global:Owner = ${c.owner ?? "[pscustomobject]@{ ReturnValue = 0; Sid = $sid }"}`,
        `$r${i} = try { Test-AdeProcessIdentity (${c.proc}) (${c.candidate}) ${c.pattern ?? "$pattern"} $sid ${c.parent ?? "$null"} } catch { 'threw' }`,
        `Write-Output ('${c.name}|' + $r${i})`,
      ].join("\n")),
    ].join("\n");
    const result = runPs(program);
    expect(result.status, result.stderr).toBe(0);
    const verdicts = new Map(sweepLines(result.stdout).map((line) => {
      const bar = line.lastIndexOf("|");
      return [line.slice(0, bar), line.slice(bar + 1)];
    }));
    for (const c of cases) {
      expect(verdicts.get(c.name), c.name).toBe(c.expect);
    }
  }, 120_000);
});

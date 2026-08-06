import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWindowsRuntimeQueryArgs,
  readWindowsServicePidRecord,
  windowsPowerShellCommand,
} from "./installWindows";
import {
  BRAIN_HEARTBEAT_INTERVAL_MS,
  BRAIN_HEARTBEAT_STALE_MS,
} from "../services/runtime/brainHeartbeat";
import {
  renderWindowsServiceLauncher,
  waitForWindowsRuntimeReadiness,
} from "./windowsSupervisor";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-windows-supervisor-"));
  tempDirs.push(dir);
  return dir;
}

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
    const pidPath = path.join(tempDir(), "brain.pid.json");
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
      timeoutMs: 12,
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

  (process.platform === "win32" ? it : it.skip)(
    "keeps supervising a missing executable and publishes launch-error backoff diagnostics",
    async () => {
      const dir = tempDir();
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
    expect(script).toContain("Test-BrainWedged $process.Id");
    expect(script).toContain("Write-WedgeBreadcrumb $wedgeAgeMs");
    // Kill($true) is .NET Core only; the supervisor must run under PS 5.1.
    expect(script).toContain("$process.Kill()");
    expect(script).not.toContain("$process.Kill($true)");
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
});

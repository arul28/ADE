import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWindowsRuntimeQueryArgs,
  readWindowsServicePidRecord,
  WINDOWS_POWERSHELL_COMMAND,
} from "./installWindows";
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
      const supervisor = spawn(WINDOWS_POWERSHELL_COMMAND, [
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

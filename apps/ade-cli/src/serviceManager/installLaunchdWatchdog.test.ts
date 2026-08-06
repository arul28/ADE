import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  installLaunchdWatchdogAgent,
  renderWatchdogLaunchdPlist,
  resolveWatchdogServiceName,
  uninstallLaunchdWatchdogAgent,
  watchdogCommand,
  watchdogLaunchAgentPath,
} from "./installLaunchdWatchdog";
import type { AdeServiceCommand } from "./common";

const serviceCommand: AdeServiceCommand = {
  command: "/usr/local/bin/node",
  args: ["/opt/ade/cli.cjs", "serve"],
  env: { ADE_HOME: "/Users/example/.ade" },
};

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ade-watchdog-home-"));
}

function recordingSpawn(calls: Array<{ command: string; args: string[] }>) {
  return (command: string, args: string[]) => {
    calls.push({ command, args });
    return { status: 0, stdout: "", stderr: "" };
  };
}

describe("resolveWatchdogServiceName", () => {
  it("keeps each channel on its own watchdog", () => {
    expect(resolveWatchdogServiceName("com.ade.runtime")).toBe("com.ade.watchdog");
    expect(resolveWatchdogServiceName("com.ade.runtime.beta")).toBe("com.ade.watchdog.beta");
    expect(resolveWatchdogServiceName("com.example.custom")).toBe("com.example.custom.watchdog");
  });
});

describe("watchdogCommand", () => {
  it("runs the same binary the brain was installed from", () => {
    expect(watchdogCommand(serviceCommand)).toEqual({
      command: "/usr/local/bin/node",
      args: ["/opt/ade/cli.cjs", "runtime", "watchdog-check"],
      env: {
        ADE_HOME: "/Users/example/.ade",
        ADE_DISABLE_RUNTIME_SERVICE_INSTALL: "1",
      },
    });
  });

  it("appends the check when the command has no serve argument", () => {
    expect(watchdogCommand({ command: "/opt/ade/ade", args: [] }).args)
      .toEqual(["runtime", "watchdog-check"]);
  });
});

describe("renderWatchdogLaunchdPlist", () => {
  it("runs on an interval and never keeps itself alive", () => {
    const plist = renderWatchdogLaunchdPlist({
      command: serviceCommand,
      homeDir: "/Users/example",
    });
    expect(plist).toContain("<string>com.ade.watchdog</string>");
    expect(plist).toContain("<key>StartInterval</key>");
    expect(plist).toContain("<integer>60</integer>");
    expect(plist).toContain("<string>watchdog-check</string>");
    // KeepAlive would make launchd respawn a one-shot check in a tight loop.
    expect(plist).not.toContain("<key>KeepAlive</key>");
  });

  it("refuses an interval short enough to thrash", () => {
    const plist = renderWatchdogLaunchdPlist({
      command: serviceCommand,
      homeDir: "/Users/example",
      startIntervalSeconds: 1,
    });
    expect(plist).toContain("<integer>15</integer>");
  });
});

describe("installLaunchdWatchdogAgent", () => {
  it("writes and loads the agent", () => {
    const homeDir = tempHome();
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = installLaunchdWatchdogAgent({
      command: serviceCommand,
      homeDir,
      spawnSync: recordingSpawn(calls),
    });

    const servicePath = watchdogLaunchAgentPath(homeDir);
    expect(result.installed).toBe(true);
    expect(fs.existsSync(servicePath)).toBe(true);
    expect(calls.map((call) => call.args[0])).toEqual(["unload", "load"]);
  });

  it("reports a load failure instead of claiming the agent is armed", () => {
    const homeDir = tempHome();
    const result = installLaunchdWatchdogAgent({
      command: serviceCommand,
      homeDir,
      spawnSync: (command, args) =>
        args[0] === "load"
          ? { status: 1, stdout: "", stderr: "Load failed" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(result.installed).toBe(false);
  });

  it("removes the agent with the brain it guards", () => {
    const homeDir = tempHome();
    installLaunchdWatchdogAgent({
      command: serviceCommand,
      homeDir,
      spawnSync: recordingSpawn([]),
    });
    const servicePath = watchdogLaunchAgentPath(homeDir);
    expect(fs.existsSync(servicePath)).toBe(true);

    const calls: Array<{ command: string; args: string[] }> = [];
    uninstallLaunchdWatchdogAgent({ homeDir, spawnSync: recordingSpawn(calls) });

    expect(fs.existsSync(servicePath)).toBe(false);
    expect(calls.map((call) => call.args[0])).toEqual(["bootout", "unload"]);
  });
});

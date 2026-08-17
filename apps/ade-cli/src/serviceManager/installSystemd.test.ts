import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADE_RUNTIME_SERVICE_NAME,
  type AdeServiceCommand,
  type ServiceManagerProcessResult,
  type ServiceManagerSpawnSync,
} from "./common";
import {
  getSystemdUnitState,
  installSystemdService,
  parseSystemdShowOutput,
  renderSystemdEnvironment,
  renderSystemdUnit,
  servicePath as systemdServicePath,
} from "./installSystemd";

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

type SystemdShowState = { activeState: string; mainPid: number };

/**
 * A fake `systemctl` that answers `show` from a script of unit states (the last
 * entry repeats) and lets individual subcommands be failed. Everything the
 * systemd installer runs goes through `systemctl`, so one stub covers it.
 */
function systemdSpawn(options: {
  calls: Array<{ command: string; args: string[] }>;
  states: SystemdShowState[];
  failures?: Record<string, ServiceManagerProcessResult>;
}): ServiceManagerSpawnSync {
  const states = [...options.states];
  return (command, args) => {
    options.calls.push({ command, args });
    if (command !== "systemctl") return { status: 0, stdout: "", stderr: "" };
    const subcommand = args[1];
    if (subcommand === "show") {
      const state = states.length > 1 ? states.shift()! : states[0];
      return {
        status: 0,
        stdout: `ActiveState=${state.activeState}\nMainPID=${state.mainPid}\n`,
        stderr: "",
      };
    }
    const failure = options.failures?.[subcommand ?? ""];
    if (failure) return failure;
    return { status: 0, stdout: "", stderr: "" };
  };
}

const INACTIVE: SystemdShowState = { activeState: "inactive", mainPid: 0 };

function systemdCallArgs(calls: Array<{ command: string; args: string[] }>): string[][] {
  return calls.filter((call) => call.args[1] !== "show").map((call) => call.args);
}

describe("systemd service install", () => {
  const serviceCommand: AdeServiceCommand = {
    command: "/opt/ade/bin/ade",
    args: ["serve"],
    env: { NODE_PATH: "/opt/ade/node_modules" },
  };
  const unitName = `${ADE_RUNTIME_SERVICE_NAME}.service`;

  function installDeps(homeDir: string, spawnSync: ServiceManagerSpawnSync, overrides: Record<string, unknown> = {}) {
    return {
      command: serviceCommand,
      spawnSync,
      homeDir,
      env: {} as NodeJS.ProcessEnv,
      handoverTimeoutMs: 200,
      handoverPollMs: 10,
      sleep: async () => {},
      recentCrashLoop: () => false,
      ...overrides,
    };
  }

  it("writes the user unit, enables it, and waits for the replacement to answer", async () => {
    const homeDir = makeTempHome("ade-systemd-install-");
    const targetPath = systemdServicePath(homeDir);
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = systemdSpawn({
      calls,
      states: [INACTIVE, { activeState: "active", mainPid: 4242 }],
    });

    const result = await installSystemdService(installDeps(homeDir, spawnSync, {
      responsivenessProbe: () => true,
      handoverPidAlive: () => true,
    }));

    expect(result).toMatchObject({
      ok: true,
      restarted: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: targetPath,
    });
    expect(result.starting).toBeUndefined();
    expect(fs.readFileSync(targetPath, "utf8")).toBe(renderSystemdUnit(serviceCommand));
    expect(systemdCallArgs(calls)).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "enable", "--now", unitName],
      ["--user", "restart", unitName],
    ]);
  });

  it("reports a live replacement that has not answered yet as starting, not failed", async () => {
    const homeDir = makeTempHome("ade-systemd-starting-");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = systemdSpawn({
      calls,
      states: [INACTIVE, { activeState: "active", mainPid: 4242 }],
    });

    const result = await installSystemdService(installDeps(homeDir, spawnSync, {
      responsivenessProbe: () => false,
      handoverPidAlive: () => true,
    }));

    expect(result).toMatchObject({ ok: true, starting: true, restarted: true });
    expect(result.failureStep).toBeUndefined();
    expect(result.message).toContain("pid 4242");
  });

  it("still fails the install when the replacement died without answering", async () => {
    const homeDir = makeTempHome("ade-systemd-dead-");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = systemdSpawn({
      calls,
      states: [INACTIVE, { activeState: "active", mainPid: 4242 }],
    });

    const result = await installSystemdService(installDeps(homeDir, spawnSync, {
      responsivenessProbe: () => false,
      handoverPidAlive: (pid: number) => pid !== 4242,
    }));

    expect(result).toMatchObject({ ok: false, failureStep: "replacement_responsive" });
    expect(result.starting).toBeUndefined();
  });

  it("waits for a young unresponsive brain instead of restarting it", async () => {
    const homeDir = makeTempHome("ade-systemd-young-");
    const targetPath = systemdServicePath(homeDir);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, renderSystemdUnit(serviceCommand), "utf8");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = systemdSpawn({ calls, states: [{ activeState: "active", mainPid: 909 }] });

    const result = await installSystemdService(installDeps(homeDir, spawnSync, {
      responsivenessProbe: () => false,
      handoverPidAlive: () => true,
      pidElapsedMs: () => 5_000,
    }));

    expect(result).toMatchObject({ ok: true, starting: true });
    expect(result.restarted).toBeUndefined();
    // The whole point: nothing was restarted out from under the booting brain.
    expect(systemdCallArgs(calls)).toEqual([]);
  });

  it("restarts a young brain when a fresh crash-loop record vetoes the wait", async () => {
    const homeDir = makeTempHome("ade-systemd-crashloop-");
    const targetPath = systemdServicePath(homeDir);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, renderSystemdUnit(serviceCommand), "utf8");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = systemdSpawn({
      calls,
      states: [{ activeState: "active", mainPid: 909 }, { activeState: "active", mainPid: 910 }],
    });

    const result = await installSystemdService(installDeps(homeDir, spawnSync, {
      responsivenessProbe: () => false,
      handoverPidAlive: (pid: number) => pid !== 909,
      pidElapsedMs: () => 5_000,
      recentCrashLoop: () => true,
    }));

    expect(result).toMatchObject({ ok: true, starting: true, restarted: true });
    expect(systemdCallArgs(calls)).toContainEqual(["--user", "restart", unitName]);
  });

  it("does not restart an unchanged unit whose brain already answers", async () => {
    const homeDir = makeTempHome("ade-systemd-noop-");
    const targetPath = systemdServicePath(homeDir);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, renderSystemdUnit(serviceCommand), "utf8");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = systemdSpawn({ calls, states: [{ activeState: "active", mainPid: 909 }] });

    const result = await installSystemdService(installDeps(homeDir, spawnSync, {
      responsivenessProbe: () => true,
    }));

    expect(result).toMatchObject({ ok: true });
    expect(result.restarted).toBeUndefined();
    expect(systemdCallArgs(calls)).toEqual([]);
  });

  it("treats a unit systemd reports as activating as a live brain, not a dead one", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = systemdSpawn({ calls, states: [{ activeState: "activating", mainPid: 77 }] });
    expect(getSystemdUnitState(spawnSync)).toEqual({ active: true, mainPid: 77 });
  });

  it("reads MainPID=0 as no pid", () => {
    expect(parseSystemdShowOutput("ActiveState=inactive\nMainPID=0\n").get("MainPID")).toBe("0");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = systemdSpawn({ calls, states: [INACTIVE] });
    expect(getSystemdUnitState(spawnSync)).toEqual({ active: false, mainPid: null });
  });

  it("does not enable when daemon-reload fails", async () => {
    const homeDir = makeTempHome("ade-systemd-reload-fail-");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = systemdSpawn({
      calls,
      states: [INACTIVE],
      failures: { "daemon-reload": { status: 1, stdout: "", stderr: "reload failed" } },
    });

    const result = await installSystemdService(installDeps(homeDir, spawnSync));

    expect(result.ok).toBe(false);
    expect(result.message).toBe("reload failed");
    expect(systemdCallArgs(calls)).toEqual([["--user", "daemon-reload"]]);
  });

  it("surfaces enable failures after a successful reload", async () => {
    const homeDir = makeTempHome("ade-systemd-enable-fail-");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = systemdSpawn({
      calls,
      states: [INACTIVE],
      failures: { enable: { status: 1, stdout: "", stderr: "enable failed" } },
    });

    const result = await installSystemdService(installDeps(homeDir, spawnSync));

    expect(result.ok).toBe(false);
    expect(result.message).toBe("enable failed");
    expect(systemdCallArgs(calls)).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "enable", "--now", unitName],
    ]);
  });

  it("surfaces restart failures after enabling the user unit", async () => {
    const homeDir = makeTempHome("ade-systemd-restart-fail-");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = systemdSpawn({
      calls,
      states: [INACTIVE],
      failures: { restart: { status: 1, stdout: "", stderr: "restart failed" } },
    });

    const result = await installSystemdService(installDeps(homeDir, spawnSync));

    expect(result.ok).toBe(false);
    expect(result.message).toBe("restart failed");
    expect(systemdCallArgs(calls)).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "enable", "--now", unitName],
      ["--user", "restart", unitName],
    ]);
  });
});

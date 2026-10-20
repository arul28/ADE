import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SpawnCall = { command: string; args: string[]; env: NodeJS.ProcessEnv };

const machine = vi.hoisted(() => ({
  appOpen: false,
  installerSubject: "CN=ADE",
  installerExit: 0 as number,
  spawnSyncCalls: [] as SpawnCall[],
  spawnCalls: [] as SpawnCall[],
}));

// The PC, at the process boundary: PowerShell answers the signature and
// "is the app open" questions, the app's CLI starts its service, and the
// installer runs and exits.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      machine.spawnSyncCalls.push({ command, args, env: options.env });
      const script = args[args.length - 1] ?? "";
      if (/powershell/i.test(command) && script.includes("Get-AuthenticodeSignature")) {
        const stdout = JSON.stringify({
          installerStatus: "Valid",
          installerSubject: machine.installerSubject,
          appStatus: "Valid",
          appSubject: "CN=ADE",
        });
        return { status: 0, stdout, stderr: "" };
      }
      if (/powershell/i.test(command)) return { status: 0, stdout: machine.appOpen ? "1" : "0", stderr: "" };
      return { status: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
    },
    spawn: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      machine.spawnCalls.push({ command, args, env: options.env });
      const child = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null, kill: () => true });
      setImmediate(() => child.emit("exit", machine.installerExit));
      return child;
    },
  };
});

const { runWindowsDesktopRescue } = await import("./windowsDesktopRescue");

const APP_EXE = "C:\\Users\\me\\AppData\\Local\\Programs\\ADE\\ADE.exe";
const plan = {
  appExe: APP_EXE,
  installDir: "C:\\Users\\me\\AppData\\Local\\Programs\\ADE",
  installedVersion: "1.2.112",
  targetVersion: "1.2.120",
};

/** The env `brain update --apply-staged` runs in: the standalone runtime's, from an ADE terminal. */
const helperEnv: NodeJS.ProcessEnv = {
  ADE_HOME: "C:\\Users\\me\\.ade",
  ADE_RUNTIME_ROOT: "C:\\Users\\me\\.ade\\runtime\\updates\\u1\\runtime\\win32-x64",
  ADE_RUNTIME_NODE_MODULES: "C:\\Users\\me\\.ade\\runtime\\updates\\u1\\runtime\\win32-x64\\node_modules",
  NODE_PATH: "C:\\Users\\me\\.ade\\runtime\\updates\\u1\\runtime\\win32-x64\\node_modules",
  ADE_CLI_PATH: "C:\\Users\\me\\AppData\\Local\\Temp\\ade-cli-shims\\x\\ade.cmd",
  ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION: "1",
  ADE_BRAIN_UPDATE_APPLY: "1",
  ELECTRON_RUN_AS_NODE: "1",
};

const HELPER_ONLY_KEYS = ["ADE_RUNTIME_ROOT", "ADE_RUNTIME_NODE_MODULES", "ADE_CLI_PATH", "ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION", "ADE_BRAIN_UPDATE_APPLY"];

let stagingDir: string;

beforeEach(() => {
  stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-desktop-rescue-"));
  Object.assign(machine, { appOpen: false, installerSubject: "CN=ADE", installerExit: 0, spawnSyncCalls: [], spawnCalls: [] });
});

afterEach(() => {
  fs.rmSync(stagingDir, { recursive: true, force: true });
});

async function rescue() {
  const stopService = vi.fn(() => ({ ok: true, message: "" }));
  const installerBytes = Buffer.from("signed installer");
  const sha512 = createHash("sha512").update(installerBytes).digest("base64");
  const outcome = runWindowsDesktopRescue(plan, {
    repo: "arul28/ADE",
    stagingDir,
    env: helperEnv,
    stopService,
    onStep: async () => {},
    downloadFile: async (url, outPath) => {
      fs.writeFileSync(outPath, url.endsWith("latest.yml")
        ? `version: 1.2.120\nfiles:\n  - url: ADE-1.2.120-win-x64.exe\n    sha512: ${sha512}\n`
        : installerBytes);
    },
  });
  return { outcome, stopService };
}

/** The installed app's CLI runs that start its background service. */
function serviceStarts(): SpawnCall[] {
  return machine.spawnSyncCalls.filter((call) => call.command === APP_EXE && call.args.includes("start"));
}

describe("runWindowsDesktopRescue", () => {
  it.each([
    { label: "app closed: the update itself starts the new build's service", appOpen: false, installerExit: 0, ok: true, reopens: false, starts: 1 },
    { label: "app open: the reopened app starts its own service", appOpen: true, installerExit: 0, ok: true, reopens: true, starts: 0 },
    { label: "installer fails: the old build's service is started again", appOpen: false, installerExit: 2, ok: false, reopens: false, starts: 1 },
  ])("leaves the PC with a running service — $label", async ({ appOpen, installerExit, ok, reopens, starts }) => {
    Object.assign(machine, { appOpen, installerExit });

    const { outcome, stopService } = await rescue();

    expect((await outcome).ok).toBe(ok);
    expect(stopService).toHaveBeenCalledTimes(1);
    const [installer] = machine.spawnCalls;
    expect(installer?.args).toEqual(["--updated", "/S", ...(reopens ? ["--force-run"] : [])]);
    // The reopened app and its agent shells must not inherit the helper's runtime or permissions.
    for (const key of [...HELPER_ONLY_KEYS, "NODE_PATH", "ELECTRON_RUN_AS_NODE"]) expect(installer?.env[key]).toBeUndefined();
    expect(serviceStarts()).toHaveLength(starts);
    for (const start of serviceStarts()) {
      expect(start.args).toEqual([`${plan.installDir}\\resources\\ade-cli\\cli.cjs`, "brain", "start", "--json"]);
      // A service registered with the staging folder's paths loads from a folder about to be deleted.
      for (const key of HELPER_ONLY_KEYS) expect(start.env[key]).toBeUndefined();
      expect(start.env.NODE_PATH).toContain(`${plan.installDir}\\resources\\app.asar`);
      expect(start.env).toMatchObject({ ELECTRON_RUN_AS_NODE: "1", ADE_HOME: helperEnv.ADE_HOME });
    }
  });

  it("refuses an installer from another publisher before touching the service", async () => {
    machine.installerSubject = "CN=Someone Else";

    const { outcome, stopService } = await rescue();

    await expect(outcome).rejects.toThrow(/not by the installed app's signer/);
    expect(stopService).not.toHaveBeenCalled();
    expect(machine.spawnCalls).toHaveLength(0);
    expect(serviceStarts()).toHaveLength(0);
  });
});

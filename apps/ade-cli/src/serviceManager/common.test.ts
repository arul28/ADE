import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync as spawnChildSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADE_RUNTIME_SERVICE_NAME,
  buildWindowsParentPidQueryArgs,
  buildWindowsProcessCommandLineQueryArgs,
  listStaleChannelServePids,
  isCurrentProcessDescendantOfPid,
  isStaleChannelServeCommandLine,
  PARENT_PID_UNKNOWN,
  readParentPid,
  renderCommand,
  resolveAdeServeCommand,
  serviceManagerOwnsRuntimeRecovery,
  terminatePidGracefullyAsync,
  type AdeServiceCommand,
  type ServiceManagerProcessResult,
  type ServiceManagerSpawnSync,
} from "./common";

describe("serviceManagerOwnsRuntimeRecovery", () => {
  const base = {
    serviceName: "com.ade.runtime",
    action: "install" as const,
    path: "runtime",
    message: "test",
  };

  it("keeps manual fallback blocked while a registered replacement owns readiness retries", () => {
    expect(serviceManagerOwnsRuntimeRecovery({
      ...base,
      ok: false,
      failureStep: "replacement_responsive",
    })).toBe(true);
  });

  it("allows fallback before the replacement reaches supervisor-owned recovery", () => {
    expect(serviceManagerOwnsRuntimeRecovery({
      ...base,
      ok: false,
      failureStep: "replacement_pid",
    })).toBe(false);
    expect(serviceManagerOwnsRuntimeRecovery({ ...base, ok: true })).toBe(false);
  });
});
import {
  installLaunchdService,
  isLaunchdPrintRunning,
  launchAgentPath,
  parseLaunchdPrintPid,
  renderLaunchdPlist,
  uninstallLaunchdService,
} from "./installLaunchd";
import { resolveWatchdogServiceName } from "./installLaunchdWatchdog";
import { installSystemdService, renderSystemdEnvironment, renderSystemdUnit, servicePath as systemdServicePath } from "./installSystemd";
import { isWindowsTaskStateRunning } from "./installWindows";

const originalArgv = [...process.argv];
const originalNodePath = process.env.NODE_PATH;
const originalAdeRuntimeRoot = process.env.ADE_RUNTIME_ROOT;
const originalAdeRuntimeNodeModules = process.env.ADE_RUNTIME_NODE_MODULES;
const originalAdeDefaultRole = process.env.ADE_DEFAULT_ROLE;
const originalAllowSelfMutation = process.env.ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION;
const tempDirs: string[] = [];

afterEach(() => {
  process.argv.splice(0, process.argv.length, ...originalArgv);
  if (originalNodePath === undefined) delete process.env.NODE_PATH;
  else process.env.NODE_PATH = originalNodePath;
  if (originalAdeRuntimeRoot === undefined) delete process.env.ADE_RUNTIME_ROOT;
  else process.env.ADE_RUNTIME_ROOT = originalAdeRuntimeRoot;
  if (originalAdeRuntimeNodeModules === undefined) delete process.env.ADE_RUNTIME_NODE_MODULES;
  else process.env.ADE_RUNTIME_NODE_MODULES = originalAdeRuntimeNodeModules;
  if (originalAdeDefaultRole === undefined) delete process.env.ADE_DEFAULT_ROLE;
  else process.env.ADE_DEFAULT_ROLE = originalAdeDefaultRole;
  if (originalAllowSelfMutation === undefined) {
    delete process.env.ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION;
  } else {
    process.env.ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION = originalAllowSelfMutation;
  }
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

function writeSyncHostSingletonLock(args: {
  lockPath: string;
  pid: number;
  port: number;
  appName: string;
  quitCommand: string;
  packageChannel?: string | null;
  adeHome?: string;
  serviceName?: string;
}): void {
  const now = "2026-06-09T00:00:00.000Z";
  const adeHome = args.adeHome ?? path.join(os.homedir(), ".ade");
  fs.mkdirSync(path.dirname(args.lockPath), { recursive: true });
  fs.writeFileSync(
    args.lockPath,
    `${JSON.stringify({
      version: 1,
      owner: {
        id: "existing-brain",
        pid: args.pid,
        port: args.port,
        appName: args.appName,
        packageChannel: args.packageChannel ?? null,
        adeHome,
        serviceName: args.serviceName ?? "com.ade.runtime",
        socketPath: path.join(adeHome, "sock", "ade.sock"),
        projectRoot: "/Users/admin/Projects/ADE",
        commandLine: null,
        quitCommand: args.quitCommand,
        createdAt: now,
        updatedAt: now,
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

function watchdogPath(homeDir: string): string {
  return path.join(homeDir, "Library", "LaunchAgents", `${resolveWatchdogServiceName()}.plist`);
}

function currentLaunchdDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
  return `gui/${uid}/${ADE_RUNTIME_SERVICE_NAME}`;
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
    process.env.ADE_RUNTIME_ROOT = "/opt/ade/runtime";
    process.env.ADE_RUNTIME_NODE_MODULES = "/opt/ade/runtime/node_modules";

    expect(resolveAdeServeCommand()).toMatchObject({
      command: process.execPath,
      args: ["serve"],
      env: {
        NODE_PATH: "/opt/ade/runtime/node_modules",
        ADE_RUNTIME_ROOT: "/opt/ade/runtime",
        ADE_RUNTIME_NODE_MODULES: "/opt/ade/runtime/node_modules",
      },
    });
  });

  it("preserves ADE_DEFAULT_ROLE for launch-managed runtime services", () => {
    process.argv[1] = path.resolve("definitely-not-real-cli.cjs");
    process.env.ADE_DEFAULT_ROLE = "cto";

    expect(resolveAdeServeCommand()).toMatchObject({
      command: process.execPath,
      args: ["serve"],
      env: {
        ADE_DEFAULT_ROLE: "cto",
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

  it("does not hash node when the node serve fallback has no dist CLI", () => {
    const tempDir = makeTempHome("ade-service-command-no-dist-");
    process.argv[1] = path.join(tempDir, "missing-cli.cjs");

    const command = resolveAdeServeCommand();

    expect(command).toMatchObject({
      command: process.execPath,
      args: ["serve"],
    });
    expect(command.env?.ADE_RUNTIME_BUILD_HASH).toBeUndefined();
  });

  it("sets the runtime build hash from dist cli for the node serve fallback", () => {
    const tempDir = makeTempHome("ade-service-command-dist-");
    const srcDir = path.join(tempDir, "src");
    const distDir = path.join(tempDir, "dist");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, "package.json"), "{\"name\":\"ade-cli\"}\n", "utf8");
    fs.writeFileSync(path.join(srcDir, "cli.ts"), "export {}\n", "utf8");
    const distPath = path.join(distDir, "cli.cjs");
    fs.writeFileSync(distPath, "console.log('dist runtime')\n", "utf8");
    process.argv[1] = path.join(tempDir, "missing-cli.cjs");

    expect(resolveAdeServeCommand()).toMatchObject({
      command: process.execPath,
      args: ["serve"],
      env: {
        ADE_RUNTIME_BUILD_HASH: fileSha256(distPath),
      },
    });
  });
});

describe("isCurrentProcessDescendantOfPid", () => {
  it("detects when the current process descends from the target pid", () => {
    const parentPid = (pid: number) => ({
      400: 300,
      300: 100,
      100: 1,
    })[pid] ?? null;

    expect(isCurrentProcessDescendantOfPid({
      targetPid: 100,
      currentPid: 400,
      parentPid,
    })).toBe(true);
  });

  it("returns false when the current process is in an unrelated process tree", () => {
    expect(isCurrentProcessDescendantOfPid({
      targetPid: 100,
      currentPid: 400,
      parentPid: (pid) => ({
        400: 300,
        300: 1,
      })[pid] ?? null,
    })).toBe(false);
  });

  it("returns false for parent cycles", () => {
    expect(isCurrentProcessDescendantOfPid({
      targetPid: 100,
      currentPid: 400,
      parentPid: (pid) => ({
        400: 300,
        300: 200,
        200: 300,
      })[pid] ?? null,
    })).toBe(false);
  });
});

// These exercise the DEFAULT parent-pid backend. The suite above injects a fake
// `parentPid` every time, which is exactly how a Windows host could ship a
// `readParentPid` that always returned null — and therefore a self-shutdown
// guard that never fired — with a green Windows CI job.
describe("readParentPid on win32", () => {
  // A trusted powershell path, never a bare `powershell` resolved off PATH.
  const TRUSTED_POWERSHELL = /[\\/]system32[\\/]windowspowershell[\\/]v1\.0[\\/]powershell\.exe$/i;

  const recordingRun = (
    reply: (pid: number) => ServiceManagerProcessResult,
  ): { run: ServiceManagerSpawnSync; calls: Array<{ command: string; args: string[] }> } => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run: ServiceManagerSpawnSync = (command, args) => {
      calls.push({ command, args });
      if (!TRUSTED_POWERSHELL.test(command)) {
        // Mirror the real host: Git Bash's `ps` is found and rejects the POSIX
        // flags with status 1; a clean Windows box reports ENOENT. Both land on
        // a non-zero status with no usable stdout.
        return { status: 1, stdout: "", stderr: "ps: unknown option -- o\n" };
      }
      const filter = /ProcessId = (\d+)/.exec(args.join(" "));
      return reply(Number(filter?.[1] ?? 0));
    };
    return { run, calls };
  };

  it("queries Win32_Process through the trusted PowerShell for the parent pid", () => {
    const { run, calls } = recordingRun(() => ({ status: 0, stdout: "4321\r\n" }));

    expect(readParentPid(run, 1234, "win32")).toBe(4321);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toMatch(TRUSTED_POWERSHELL);
    expect(calls[0]!.command).not.toBe("ps");
    expect(calls[0]!.args).toEqual(buildWindowsParentPidQueryArgs(1234));
    const script = calls[0]!.args.join(" ");
    expect(script).toContain("Get-CimInstance Win32_Process");
    expect(script).toContain("ParentProcessId");
    // wmic is deprecated and is being removed from Windows.
    expect(script).not.toMatch(/wmic/i);
  });

  it("treats a missing process as the definitive end of the chain", () => {
    const { run } = recordingRun(() => ({ status: 3, stdout: "" }));
    expect(readParentPid(run, 1234, "win32")).toBeNull();
  });

  it("treats ParentProcessId 0 as the top of the tree", () => {
    const { run } = recordingRun(() => ({ status: 0, stdout: "0" }));
    expect(readParentPid(run, 1234, "win32")).toBeNull();
  });

  it("reports an undetermined ancestry when the query itself fails", () => {
    const failures: ServiceManagerProcessResult[] = [
      { status: 1, stdout: "", stderr: "Get-CimInstance is not recognized" },
      { status: null, stdout: null, stderr: null },
      { status: 0, stdout: "not-a-pid" },
      { status: 0, stdout: "" },
    ];
    for (const failure of failures) {
      const { run } = recordingRun(() => failure);
      expect(readParentPid(run, 1234, "win32")).toBe(PARENT_PID_UNKNOWN);
    }
  });
});

describe("isCurrentProcessDescendantOfPid on win32", () => {
  const win32Tree = (tree: Record<number, number>): ServiceManagerSpawnSync =>
    (command, args) => {
      if (!/powershell\.exe$/i.test(command)) {
        // Anything that is not the Windows query is the old POSIX `ps` path,
        // which cannot answer on this platform.
        return { status: 1, stdout: "", stderr: "ps: unknown option -- o\n" };
      }
      const pid = Number(/ProcessId = (\d+)/.exec(args.join(" "))?.[1] ?? 0);
      const parent = tree[pid];
      return parent == null
        ? { status: 3, stdout: "" }
        : { status: 0, stdout: String(parent) };
    };

  it("blocks a self-shutdown issued from inside the runtime's process tree", () => {
    // No `parentPid` injection: this drives the real default backend, so a
    // Windows build without a win32 branch answers false and fails here.
    expect(isCurrentProcessDescendantOfPid({
      targetPid: 100,
      currentPid: 400,
      platform: "win32",
      run: win32Tree({ 400: 300, 300: 100, 100: 0 }),
    })).toBe(true);
  });

  it("allows a shutdown issued from an unrelated process tree", () => {
    expect(isCurrentProcessDescendantOfPid({
      targetPid: 100,
      currentPid: 400,
      platform: "win32",
      run: win32Tree({ 400: 300, 300: 1, 1: 0 }),
    })).toBe(false);
  });

  it("fails closed when the ancestry query is unavailable", () => {
    // Destroying a live runtime is unrecoverable; a refusal that names the
    // ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION override is not.
    expect(isCurrentProcessDescendantOfPid({
      targetPid: 100,
      currentPid: 400,
      platform: "win32",
      run: () => ({ status: 1, stdout: "", stderr: "powershell unavailable" }),
    })).toBe(true);
  });
});

describe.runIf(process.platform === "win32")("readParentPid against the real Windows host", () => {
  it("resolves this process's actual parent pid", () => {
    // process.ppid is an independent oracle for the same fact. Before the win32
    // branch existed this returned null on every Windows host.
    expect(readParentPid(spawnChildSync, process.pid)).toBe(process.ppid);
  }, 30_000);

  it("reports the real parent as an ancestor of this process", () => {
    expect(isCurrentProcessDescendantOfPid({ targetPid: process.ppid })).toBe(true);
  }, 30_000);
});

describe("isStaleChannelServeCommandLine", () => {
  const cliScriptPath = "/Applications/ADE Beta.app/Contents/Resources/ade-cli/cli.cjs";
  const primarySocketPath = "/Users/example/.ade-beta/sock/ade.sock";
  const opts = { cliScriptPath, primarySocketPath };
  const electron = "/Applications/ADE Beta.app/Contents/MacOS/ADE Beta";

  it("matches channel brains with and without an explicit primary socket", () => {
    expect(isStaleChannelServeCommandLine(`${electron} ${cliScriptPath} serve`, opts)).toBe(true);
    expect(isStaleChannelServeCommandLine(
      `${electron} ${cliScriptPath} serve --socket ${primarySocketPath}`,
      opts,
    )).toBe(true);
  });

  it("matches old ADE CLI builds when they explicitly serve this channel socket", () => {
    expect(isStaleChannelServeCommandLine(
      `/Applications/ADE.app/Contents/MacOS/ADE /Applications/ADE.app/Contents/Resources/ade-cli/cli.cjs serve --socket ${primarySocketPath}`,
      opts,
    )).toBe(true);
  });

  it("ignores isolated, installer, and foreign-socket runtimes", () => {
    expect(isStaleChannelServeCommandLine(`${electron} ${cliScriptPath} serve --no-sync`, opts)).toBe(false);
    expect(isStaleChannelServeCommandLine(`${electron} ${cliScriptPath} serve --install-service`, opts)).toBe(false);
    expect(isStaleChannelServeCommandLine(
      `${electron} ${cliScriptPath} serve --socket /tmp/ade-runtime-dev.sock`,
      opts,
    )).toBe(false);
    expect(isStaleChannelServeCommandLine(
      `${electron} ${cliScriptPath} serve --socket /Users/example/.ade-beta/sock/i-0c362cb4.sock --no-sync`,
      opts,
    )).toBe(false);
    expect(isStaleChannelServeCommandLine(
      `/Applications/ADE.app/Contents/MacOS/ADE /Applications/ADE.app/Contents/Resources/ade-cli/cli.cjs serve --socket ${primarySocketPath} --no-sync`,
      opts,
    )).toBe(false);
  });

  it("ignores other binaries and non-serve commands", () => {
    expect(isStaleChannelServeCommandLine(`${electron}`, opts)).toBe(false);
    expect(isStaleChannelServeCommandLine(`${electron} ${cliScriptPath} doctor`, opts)).toBe(false);
    expect(isStaleChannelServeCommandLine(
      "/Applications/ADE.app/Contents/Resources/ade-cli/cli.cjs serve",
      opts,
    )).toBe(false);
  });
});

// Windows quotes EVERY spawned argument, so a live supervisor-launched brain's
// command line is `"...\node.exe" "...\cli.cjs" "serve"`. Measured against a
// real process read back through `Get-CimInstance Win32_Process`, the
// whitespace-only spellings this predicate used to require made it ALWAYS false
// on Windows, so `findStaleHolder` could never recognise a wedged same-channel
// brain and mobile sync drifted onto a fallback port after every crash.
describe("isStaleChannelServeCommandLine on Windows-quoted command lines", () => {
  const node = "C:\\Program Files\\nodejs\\node.exe";
  // A home directory with a space is the ordinary case, not an exotic one --
  // and Node quotes those arguments too.
  const cliScriptPath = "C:\\Users\\John Smith\\.ade\\runtime\\cli.cjs";
  const primarySocketPath = "\\\\.\\pipe\\ade-runtime-stable-0123456789abcdef";
  const opts = { cliScriptPath, primarySocketPath };
  const live = `"${node}" "${cliScriptPath}" "serve"`;

  it("matches the quoted command line a Windows supervisor actually produces", () => {
    expect(isStaleChannelServeCommandLine(live, opts)).toBe(true);
    expect(isStaleChannelServeCommandLine(`${live} "--socket" "${primarySocketPath}"`, opts)).toBe(true);
  });

  it("compares named pipes case-insensitively, because Windows does", () => {
    expect(isStaleChannelServeCommandLine(
      `${live} "--socket" "${primarySocketPath.toUpperCase()}"`,
      opts,
    )).toBe(true);
  });

  it("still ignores isolated, installer, and foreign-socket Windows runtimes", () => {
    expect(isStaleChannelServeCommandLine(`${live} "--no-sync"`, opts)).toBe(false);
    expect(isStaleChannelServeCommandLine(`${live} "--install-service"`, opts)).toBe(false);
    expect(isStaleChannelServeCommandLine(
      `${live} "--socket" "\\\\.\\pipe\\ade-runtime-beta-ffffffffffffffff"`,
      opts,
    )).toBe(false);
    expect(isStaleChannelServeCommandLine(`"${node}" "${cliScriptPath}" "doctor"`, opts)).toBe(false);
    // `serveless` must not be mistaken for the `serve` verb.
    expect(isStaleChannelServeCommandLine(`"${node}" "${cliScriptPath}" "serveless"`, opts)).toBe(false);
  });
});

describe("listStaleChannelServePids", () => {
  const opts = {
    cliScriptPath: "C:\\ADE\\resources\\ade-cli\\cli.cjs",
    primarySocketPath: "\\\\.\\pipe\\ade-runtime-stable-0123456789abcdef",
  };

  it("enumerates Windows processes through Win32_Process, never `ps`", () => {
    const calls: string[] = [];
    const scan = listStaleChannelServePids(
      (command, args) => {
        calls.push(command);
        expect(args).toEqual(buildWindowsProcessCommandLineQueryArgs());
        return {
          status: 0,
          stdout: [
            `4242\t"C:\\ADE\\ade.exe" "${opts.cliScriptPath}" "serve"`,
            `4243\t"C:\\ADE\\ade.exe" "${opts.cliScriptPath}" "serve" "--no-sync"`,
            "4244\t\"C:\\Windows\\explorer.exe\"",
          ].join("\r\n"),
          stderr: "",
        };
      },
      opts,
      "win32",
    );
    expect(calls.some((command) => /powershell\.exe$/i.test(command))).toBe(true);
    expect(calls).not.toContain("ps");
    expect(scan).toEqual({ ok: true, pids: [4242] });
  });

  it("keeps using `ps -axo` off win32", () => {
    const calls: string[] = [];
    const scan = listStaleChannelServePids(
      (command) => {
        calls.push(command);
        return { status: 0, stdout: "  4242 /Applications/ADE.app/Contents/MacOS/ADE /a/ade-cli/cli.cjs serve\n", stderr: "" };
      },
      { cliScriptPath: "/a/ade-cli/cli.cjs", primarySocketPath: "/Users/x/.ade/sock/ade.sock" },
      "darwin",
    );
    expect(calls).toEqual(["ps"]);
    expect(scan).toEqual({ ok: true, pids: [4242] });
  });

  it("reports a failed scan explicitly instead of returning an empty list", () => {
    // `status: null` is exactly what spawnSync returns when the executable does
    // not exist -- which is how the Windows scan used to look like a clean bill
    // of health while never having run at all.
    const scan = listStaleChannelServePids(
      () => ({ status: null, stdout: "", stderr: "" }),
      opts,
      "win32",
    );
    expect(scan.ok).toBe(false);
    expect(scan).not.toEqual({ ok: true, pids: [] });
  });
});

describe("terminatePidGracefullyAsync on win32", () => {
  // `process.kill(pid, "SIGTERM")` is TerminateProcess on Windows: the target's
  // SIGTERM handler never runs and it is gone in ~19ms (measured), so the whole
  // grace loop was dead code and the brain was killed mid-write.
  it("asks the runtime to shut down and never signals the pid", async () => {
    const signals: Array<string | number> = [];
    const forced: number[] = [];
    let alive = true;
    const requests: Array<{ pid: number; socketPath: string }> = [];
    await terminatePidGracefullyAsync(4242, {
      platform: "win32",
      runtimeSocketPath: "\\\\.\\pipe\\ade-runtime-stable-0123456789abcdef",
      kill: (_pid, signal) => { signals.push(signal); },
      forceKill: (pid) => { forced.push(pid); },
      pidAlive: () => alive,
      requestRuntimeShutdown: async ({ pid, socketPath }) => {
        requests.push({ pid, socketPath });
        alive = false;
        return { requested: true };
      },
    });
    expect(requests).toEqual([
      { pid: 4242, socketPath: "\\\\.\\pipe\\ade-runtime-stable-0123456789abcdef" },
    ]);
    expect(signals).toEqual([]);
    expect(forced).toEqual([]);
  });

  it("escalates to a forced kill when the runtime will not answer", async () => {
    const forced: number[] = [];
    await terminatePidGracefullyAsync(4242, {
      platform: "win32",
      runtimeSocketPath: "\\\\.\\pipe\\ade-runtime-stable-0123456789abcdef",
      forceKill: (pid) => { forced.push(pid); },
      pidAlive: () => true,
      requestRuntimeShutdown: async () => ({ requested: false, reason: "wedged" }),
    });
    expect(forced).toEqual([4242]);
  });

  it("escalates when a brain accepts the request but does not leave in time", async () => {
    const forced: number[] = [];
    await terminatePidGracefullyAsync(4242, {
      platform: "win32",
      graceTimeoutMs: 120,
      runtimeSocketPath: "\\\\.\\pipe\\ade-runtime-stable-0123456789abcdef",
      forceKill: (pid) => { forced.push(pid); },
      pidAlive: () => true,
      requestRuntimeShutdown: async () => ({ requested: true }),
    });
    expect(forced).toEqual([4242]);
  });

  // The 5s default exists because this loop is the ONLY thing standing between
  // a mid-flush brain and `taskkill /F`. It used to be exercised by nothing:
  // `graceTimeoutMs` fed both the RPC request timeout and this deadline, so
  // every test that wanted a fast handshake also collapsed the grace window.
  it("gives an accepted shutdown the documented default grace budget", async () => {
    vi.useFakeTimers();
    try {
      const forced: number[] = [];
      const settled = terminatePidGracefullyAsync(4242, {
        platform: "win32",
        runtimeSocketPath: "\\\\.\\pipe\\ade-runtime-stable-0123456789abcdef",
        forceKill: (pid) => { forced.push(pid); },
        pidAlive: () => true,
        requestRuntimeShutdown: async () => ({ requested: true }),
      });
      await vi.advanceTimersByTimeAsync(4_800);
      expect(forced).toEqual([]);
      await vi.advanceTimersByTimeAsync(400);
      expect(forced).toEqual([4242]);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a short handshake budget shorten the grace window", async () => {
    vi.useFakeTimers();
    try {
      const timeouts: number[] = [];
      const forced: number[] = [];
      const settled = terminatePidGracefullyAsync(4242, {
        platform: "win32",
        shutdownRequestTimeoutMs: 300,
        runtimeSocketPath: "\\\\.\\pipe\\ade-runtime-stable-0123456789abcdef",
        forceKill: (pid) => { forced.push(pid); },
        pidAlive: () => true,
        requestRuntimeShutdown: async ({ timeoutMs }) => {
          timeouts.push(timeoutMs);
          return { requested: true };
        },
      });
      await vi.advanceTimersByTimeAsync(4_800);
      expect(timeouts).toEqual([300]);
      expect(forced).toEqual([]);
      await vi.advanceTimersByTimeAsync(400);
      expect(forced).toEqual([4242]);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the POSIX SIGTERM/SIGKILL sequence off win32", async () => {
    const signals: Array<string | number> = [];
    await terminatePidGracefullyAsync(4242, {
      platform: "darwin",
      graceTimeoutMs: 60,
      kill: (_pid, signal) => { signals.push(signal); },
      pidAlive: () => true,
      requestRuntimeShutdown: async () => {
        throw new Error("the POSIX path must never open an RPC channel");
      },
    });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

describe("service manager status parsers", () => {
  it("detects running launchd services from launchctl print output", () => {
    expect(isLaunchdPrintRunning("state = running\npid = 123\n")).toBe(true);
    expect(isLaunchdPrintRunning("state = waiting\n")).toBe(false);
    expect(parseLaunchdPrintPid("state = running\npid = 123\n")).toBe(123);
    expect(parseLaunchdPrintPid("state = waiting\n")).toBeNull();
  });

  it("detects invariant Task Scheduler state values without parsing localized field labels", () => {
    expect(isWindowsTaskStateRunning("Running\r\n")).toBe(true);
    expect(isWindowsTaskStateRunning("Ready\r\n")).toBe(false);
    expect(isWindowsTaskStateRunning("Status: Running\r\n")).toBe(false);
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
    expect(plist).toContain(
      `<string>${path.join("/Users/example/'ade'", "runtime", "launchd.out.log").replace(/'/g, "&apos;")}</string>`,
    );
    expect(plist).toContain(
      `<string>${path.join("/Users/example/'ade'", "runtime", "launchd.err.log").replace(/'/g, "&apos;")}</string>`,
    );
  });
});

describe("launchd service install", () => {
  const serviceCommand: AdeServiceCommand = {
    command: "/Applications/ADE.app/Contents/MacOS/ade",
    args: ["serve"],
    env: { NODE_PATH: "/opt/ade/node_modules" },
  };
  const install = (
    deps: NonNullable<Parameters<typeof installLaunchdService>[0]>,
  ) => installLaunchdService({
    responsivenessProbe: () => true,
    ...deps,
  });

  it("writes the plist and loads the launch agent", async () => {
    const homeDir = makeTempHome("ade-launchd-install-");
    const servicePath = launchAgentPath(homeDir);
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ]);

    const result = await install({ command: serviceCommand, spawnSync, homeDir });

    expect(result).toMatchObject({
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: servicePath,
    });
    expect(fs.readFileSync(servicePath, "utf8")).toBe(renderLaunchdPlist(serviceCommand, homeDir));
    expect(calls).toEqual([
      { command: "launchctl", args: ["print", currentLaunchdDomain()] },
      { command: "launchctl", args: ["unload", servicePath] },
      { command: "ps", args: ["-axo", "pid=,command="] },
      { command: "launchctl", args: ["load", servicePath] },
      // A successful install also arms the wedge watchdog.
      { command: "launchctl", args: ["unload", watchdogPath(homeDir)] },
      { command: "launchctl", args: ["load", watchdogPath(homeDir)] },
    ]);
  });

  it("leaves an unchanged running launch agent loaded", async () => {
    const homeDir = makeTempHome("ade-launchd-running-");
    const servicePath = launchAgentPath(homeDir);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, renderLaunchdPlist(serviceCommand, homeDir), "utf8");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "state = running\n", stderr: "" },
    ]);

    const result = await install({ command: serviceCommand, spawnSync, homeDir });

    expect(result).toMatchObject({
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: servicePath,
      message: "ADE service launchd service is already installed and running.",
    });
    expect(calls).toEqual([
      { command: "launchctl", args: ["print", currentLaunchdDomain()] },
      // Machines that were already running when the watchdog shipped take this
      // path, so it has to arm one too.
      { command: "launchctl", args: ["unload", watchdogPath(homeDir)] },
      { command: "launchctl", args: ["load", watchdogPath(homeDir)] },
    ]);
  });

  it("reinstalls an unchanged running launch agent when its runtime socket is wedged", async () => {
    const homeDir = makeTempHome("ade-launchd-wedged-");
    const servicePath = launchAgentPath(homeDir);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, renderLaunchdPlist(serviceCommand, homeDir), "utf8");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "state = running\npid = 1234\n", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ]);
    const responsivenessProbe = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    const result = await install({
      command: serviceCommand,
      spawnSync,
      homeDir,
      responsivenessProbe,
      currentPid: 9999,
      parentPid: () => null,
      handoverPidAlive: () => false,
      terminateDeps: { kill: () => {}, pidAlive: () => false },
    });

    expect(result.ok).toBe(true);
    expect(responsivenessProbe).toHaveBeenCalledTimes(2);
    expect(calls.map((call) => call.args[0])).toEqual([
      "print",
      "unload",
      "-axo",
      "load",
      // The watchdog agent is (re)armed alongside the repaired brain.
      "unload",
      "load",
    ]);
  });

  it("returns a typed failure when the replacement never becomes responsive", async () => {
    const homeDir = makeTempHome("ade-launchd-handover-fail-");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ]);

    const result = await install({
      command: serviceCommand,
      spawnSync,
      homeDir,
      responsivenessProbe: () => false,
      handoverPidAlive: () => false,
      handoverTimeoutMs: 0,
    });

    expect(result).toMatchObject({
      ok: false,
      action: "install",
      failureStep: "replacement_responsive",
    });
  });

  it("reloads an unchanged running launch agent when a packaged trust reset requests it", async () => {
    const homeDir = makeTempHome("ade-launchd-trust-reset-");
    const servicePath = launchAgentPath(homeDir);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, renderLaunchdPlist(serviceCommand, homeDir), "utf8");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "state = running\npid = 1234\n", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ]);

    const result = await install({
      command: serviceCommand,
      spawnSync,
      homeDir,
      env: { ...process.env, ADE_FORCE_RUNTIME_SERVICE_RESTART: "1" },
      currentPid: 9999,
      parentPid: () => null,
      terminateDeps: { kill: () => {}, pidAlive: () => false },
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { command: "launchctl", args: ["print", currentLaunchdDomain()] },
      { command: "launchctl", args: ["unload", servicePath] },
      { command: "ps", args: ["-axo", "pid=,command="] },
      { command: "launchctl", args: ["load", servicePath] },
      // A successful install also arms the wedge watchdog.
      { command: "launchctl", args: ["unload", watchdogPath(homeDir)] },
      { command: "launchctl", args: ["load", watchdogPath(homeDir)] },
    ]);
  });

  it("reloads an unchanged launch agent when it is loaded but stopped", async () => {
    const homeDir = makeTempHome("ade-launchd-stopped-");
    const servicePath = launchAgentPath(homeDir);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, renderLaunchdPlist(serviceCommand, homeDir), "utf8");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "state = waiting\n", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ]);

    const result = await install({ command: serviceCommand, spawnSync, homeDir });

    expect(result).toMatchObject({
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: servicePath,
    });
    expect(calls).toEqual([
      { command: "launchctl", args: ["print", currentLaunchdDomain()] },
      { command: "launchctl", args: ["unload", servicePath] },
      { command: "ps", args: ["-axo", "pid=,command="] },
      { command: "launchctl", args: ["load", servicePath] },
      // A successful install also arms the wedge watchdog.
      { command: "launchctl", args: ["unload", watchdogPath(homeDir)] },
      { command: "launchctl", args: ["load", watchdogPath(homeDir)] },
    ]);
  });

  it("does not load a launch agent when another channel's brain hosts sync", async () => {
    const homeDir = makeTempHome("ade-launchd-conflict-");
    const servicePath = launchAgentPath(homeDir);
    const lockPath = path.join(homeDir, "sync-host-lock.json");
    const existingPid = 1234;
    writeSyncHostSingletonLock({
      lockPath,
      pid: existingPid,
      port: 8801,
      appName: "ADE Beta",
      packageChannel: "beta",
      adeHome: path.join(os.homedir(), ".ade-beta"),
      serviceName: "com.ade.runtime.beta",
      quitCommand: "ADE_PACKAGE_CHANNEL=beta ADE_HOME='/Users/example/.ade-beta' '/Applications/ADE Beta.app/Contents/Resources/ade-cli/bin/ade-beta' brain stop --text",
    });
    const calls: Array<{ command: string; args: string[] }> = [];
    const killed: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    const spawnSync = spawnSequence(calls, []);

    const result = await install({
      command: serviceCommand,
      spawnSync,
      homeDir,
      env: { ...process.env, ADE_HOME: path.join(homeDir, ".ade") },
      syncHostSingletonDeps: {
        lockPath,
        pidAlive: (pid) => pid === existingPid,
        scanListeners: () => [],
      },
      terminateDeps: {
        kill: (pid, signal) => killed.push({ pid, signal }),
        pidAlive: () => false,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: servicePath,
    });
    expect(result.message).toContain("Another ADE brain is already hosting mobile sync on port 8801.");
    expect(result.message).toContain(
      process.platform === "win32"
        ? `Stop-Process -Id ${existingPid}`
        : "brain stop --text",
    );
    expect(killed).toEqual([]);
    expect(calls).toEqual([
      { command: "launchctl", args: ["print", currentLaunchdDomain()] },
    ]);
    expect(fs.existsSync(servicePath)).toBe(true);
    expect(fs.readFileSync(servicePath, "utf8")).toBe(renderLaunchdPlist(serviceCommand, homeDir));
  });

  it("reaps a stale same-channel sync brain and installs anyway", async () => {
    const homeDir = makeTempHome("ade-launchd-reap-");
    const adeHome = path.join(homeDir, ".ade");
    const servicePath = launchAgentPath(homeDir);
    const lockPath = path.join(homeDir, "sync-host-lock.json");
    const existingPid = 1234;
    writeSyncHostSingletonLock({
      lockPath,
      pid: existingPid,
      port: 8801,
      appName: "ADE",
      adeHome,
      quitCommand: "ADE_HOME='/Users/example/.ade' '/Applications/ADE.app/Contents/Resources/ade-cli/bin/ade' brain stop --text",
    });
    const calls: Array<{ command: string; args: string[] }> = [];
    const killed: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    const spawnSync = spawnSequence(calls, []);

    const result = await install({
      command: serviceCommand,
      spawnSync,
      homeDir,
      env: { ...process.env, ADE_HOME: adeHome },
      syncHostSingletonDeps: {
        lockPath,
        pidAlive: (pid) => pid === existingPid,
        scanListeners: () => [],
      },
      terminateDeps: {
        kill: (pid, signal) => killed.push({ pid, signal }),
        pidAlive: () => false,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: servicePath,
    });
    expect(killed).toEqual([{ pid: existingPid, signal: "SIGTERM" }]);
    expect(calls.map((call) => [call.command, call.args[0]])).toEqual([
      ["launchctl", "print"],
      ["launchctl", "unload"],
      ["ps", "-axo"],
      ["launchctl", "load"],
      ["launchctl", "unload"],
      ["launchctl", "load"],
    ]);
  });

  it("terminates the previous service child and stale serve processes on restart", async () => {
    const homeDir = makeTempHome("ade-launchd-sweep-");
    const adeHome = path.join(homeDir, ".ade");
    const staleServeLine = `  4242 ${serviceCommand.command} serve --socket ${path.join(adeHome, "sock", "ade.sock")}`;
    const calls: Array<{ command: string; args: string[] }> = [];
    const killed: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "state = running\npid = 9876\n", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: `${staleServeLine}\n  4243 ${serviceCommand.command} serve --no-sync\n`, stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ]);

    const result = await install({
      command: serviceCommand,
      spawnSync,
      homeDir,
      env: { ...process.env, ADE_HOME: adeHome },
      parentPid: () => null,
      terminateDeps: {
        kill: (pid, signal) => killed.push({ pid, signal }),
        pidAlive: () => false,
      },
    });

    expect(result.ok).toBe(true);
    expect(killed).toEqual([
      { pid: 9876, signal: "SIGTERM" },
      { pid: 4242, signal: "SIGTERM" },
    ]);
  });

  it("refuses to restart a launch agent from a descendant of the loaded service", async () => {
    const homeDir = makeTempHome("ade-launchd-self-install-");
    const servicePath = launchAgentPath(homeDir);
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "state = running\npid = 100\n", stderr: "" },
    ]);
    const parentPid = (pid: number) => ({
      400: 300,
      300: 100,
      100: 1,
    })[pid] ?? null;

    const result = await install({
      command: serviceCommand,
      spawnSync,
      homeDir,
      currentPid: 400,
      parentPid,
      terminateDeps: {
        kill: () => {},
        pidAlive: () => false,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: servicePath,
    });
    expect(result.message).toContain("Refusing to restart ADE brain");
    expect(calls).toEqual([
      { command: "launchctl", args: ["print", currentLaunchdDomain()] },
    ]);
    expect(fs.existsSync(servicePath)).toBe(false);
  });

  it("allows launch agent restart from a descendant when self-mutation is explicitly enabled", async () => {
    const homeDir = makeTempHome("ade-launchd-self-install-override-");
    const servicePath = launchAgentPath(homeDir);
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "state = running\npid = 100\n", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ]);
    const parentPid = (pid: number) => ({
      400: 300,
      300: 100,
      100: 1,
    })[pid] ?? null;
    process.env.ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION = "1";

    const result = await install({
      command: serviceCommand,
      spawnSync,
      homeDir,
      currentPid: 400,
      parentPid,
      terminateDeps: {
        kill: () => {},
        pidAlive: () => false,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: servicePath,
    });
    expect(fs.existsSync(servicePath)).toBe(true);
    expect(calls.map((call) => call.args[0]))
      .toEqual(["print", "unload", "-axo", "load", "unload", "load"]);
  });

  it("refuses to uninstall a launch agent from a descendant of the loaded service", () => {
    const homeDir = makeTempHome("ade-launchd-self-uninstall-");
    const servicePath = launchAgentPath(homeDir);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, renderLaunchdPlist(serviceCommand, homeDir), "utf8");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "state = running\npid = 100\n", stderr: "" },
    ]);
    const parentPid = (pid: number) => ({
      400: 300,
      300: 100,
      100: 1,
    })[pid] ?? null;

    const result = uninstallLaunchdService({
      spawnSync,
      homeDir,
      currentPid: 400,
      parentPid,
    });

    expect(result).toMatchObject({
      ok: false,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "uninstall",
      path: servicePath,
    });
    expect(result.message).toContain("Refusing to stop ADE brain");
    expect(calls).toEqual([
      { command: "launchctl", args: ["print", currentLaunchdDomain()] },
    ]);
    expect(fs.existsSync(servicePath)).toBe(true);
  });

  it("allows launch agent uninstall from a descendant when self-mutation is explicitly enabled", () => {
    const homeDir = makeTempHome("ade-launchd-self-uninstall-override-");
    const servicePath = launchAgentPath(homeDir);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, renderLaunchdPlist(serviceCommand, homeDir), "utf8");
    const calls: Array<{ command: string; args: string[] }> = [];
    const killed: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "state = running\npid = 100\n", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ]);
    const parentPid = (pid: number) => ({
      400: 300,
      300: 100,
      100: 1,
    })[pid] ?? null;
    process.env.ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION = "1";

    const result = uninstallLaunchdService({
      spawnSync,
      homeDir,
      currentPid: 400,
      parentPid,
      terminateDeps: {
        kill: (pid, signal) => killed.push({ pid, signal }),
        pidAlive: () => false,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "uninstall",
      path: servicePath,
    });
    expect(calls.map((call) => call.args[0]))
      .toEqual(["print", "bootout", "bootout", "unload", "bootout", "unload"]);
    expect(killed).toEqual([{ pid: 100, signal: "SIGTERM" }]);
    expect(fs.existsSync(servicePath)).toBe(false);
  });

  it("surfaces launchctl load failures", async () => {
    const homeDir = makeTempHome("ade-launchd-fail-");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 5, stdout: "", stderr: "Load failed" },
    ]);

    const result = await install({ command: serviceCommand, spawnSync, homeDir });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("Load failed");
    expect(calls.map((call) => call.args[0])).toEqual(["print", "unload", "-axo", "load"]);
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


function spawnSequence(
  calls: Array<{ command: string; args: string[] }>,
  results: ServiceManagerProcessResult[],
): ServiceManagerSpawnSync {
  let loadSeen = false;
  return (command, args) => {
    const next = results.shift();
    if (
      !next
      && loadSeen
      && command === "launchctl"
      && args[0] === "print"
    ) {
      return { status: 0, stdout: "state = running\npid = 7777\n", stderr: "" };
    }
    calls.push({ command, args });
    if (command === "launchctl" && args[0] === "load") loadSeen = true;
    return next ?? { status: 0, stdout: "", stderr: "" };
  };
}

import fs from "node:fs";
import net from "node:net";
import { EventEmitter } from "node:events";
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
  parsePsElapsedMs,
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
  MATERIALIZE_DATALESS_FILES_KEY,
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
import { requestAdeRuntimeShutdown } from "./runtimeShutdownRequest";
import {
  installLaunchdWatchdogAgent,
  renderWatchdogLaunchdPlist,
  resolveWatchdogServiceName,
  uninstallLaunchdWatchdogAgent,
  watchdogCommand,
  watchdogLaunchAgentPath,
} from "./installLaunchdWatchdog";
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

  // A blown `timeout` budget is the one failure that is purely about the host
  // being busy: powershell.exe cold start plus the first CIM call of a session
  // can outrun the budget on a saturated box. Treating that as "ancestry
  // unknown" refuses a teardown the user is entitled to, so it gets one retry.
  const timedOut = (): ServiceManagerProcessResult => ({
    status: null,
    stdout: null,
    stderr: null,
    signal: "SIGTERM",
    error: Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), {
      code: "ETIMEDOUT",
    }),
  });

  const budgetRecordingRun = (
    replies: Array<() => ServiceManagerProcessResult>,
  ): { run: ServiceManagerSpawnSync; timeouts: Array<number | undefined> } => {
    const timeouts: Array<number | undefined> = [];
    const run: ServiceManagerSpawnSync = (_command, _args, options) => {
      const reply = replies[timeouts.length];
      timeouts.push(options?.timeout);
      if (!reply) throw new Error("readWindowsParentPid ran more attempts than expected");
      return reply();
    };
    return { run, timeouts };
  };

  it("retries a timed-out query once, on a longer budget", () => {
    const { run, timeouts } = budgetRecordingRun([timedOut, () => ({ status: 0, stdout: "77" })]);
    expect(readParentPid(run, 1234, "win32")).toBe(77);
    expect(timeouts).toHaveLength(2);
    // The retry must be strictly more generous, or it just repeats the failure.
    expect(timeouts[1]).toBeGreaterThan(timeouts[0] ?? 0);
  });

  it("stops after the retry also times out", () => {
    const { run, timeouts } = budgetRecordingRun([timedOut, timedOut]);
    expect(readParentPid(run, 1234, "win32")).toBe(PARENT_PID_UNKNOWN);
    expect(timeouts).toHaveLength(2);
  });

  it("does not retry a query that actually answered", () => {
    // Every non-timeout outcome is final: a real answer, "no such process", a
    // real tool failure, and a spawn that never ran (powershell absent, so no
    // ETIMEDOUT and no SIGTERM) all cost exactly one powershell start.
    for (const [reply, expected] of [
      [() => ({ status: 0, stdout: "42" }), 42],
      [() => ({ status: 3, stdout: "" }), null],
      [() => ({ status: 1, stdout: "", stderr: "CIM unavailable" }), PARENT_PID_UNKNOWN],
      [() => ({ status: null, stdout: null, stderr: null }), PARENT_PID_UNKNOWN],
    ] as const) {
      const { run, timeouts } = budgetRecordingRun([reply]);
      expect(readParentPid(run, 1234, "win32")).toBe(expected);
      expect(timeouts).toHaveLength(1);
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
    // 90s, not 30s: the lookup's own worst case is a cold-start timeout plus its
    // retry, and this suite runs alongside other Windows suites on a 2-core
    // runner. A test budget under the code's budget turns a slow host into a
    // failure that reads like a broken parent-pid query.
  }, 90_000);

  it("reports the real parent as an ancestor of this process", () => {
    expect(isCurrentProcessDescendantOfPid({ targetPid: process.ppid })).toBe(true);
  }, 90_000);
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

  it("grants the brain the policy it needs to read cloud-evicted project files", () => {
    const plist = renderLaunchdPlist({
      command: "/Applications/ADE.app/Contents/MacOS/ade",
      args: ["serve"],
    }, "/Users/example");

    // Without this key macOS refuses to download a dataless placeholder for
    // this job and `read(2)` answers EDEADLK, which libuv reports as the
    // unnamed "Unknown system error -11".
    expect(plist).toContain(`<key>${MATERIALIZE_DATALESS_FILES_KEY}</key>`);
    // The brain is on the blocking path of every user action, so it must not
    // take launchd's default CPU and I/O throttling.
    expect(plist).toContain("<key>ProcessType</key>");
    expect(plist).toContain("<string>Interactive</string>");
    expect(plist).toContain("<key>LowPriorityIO</key>");
  });
});

describe("parsePsElapsedMs", () => {
  it("reads every `ps -o etime=` shape", () => {
    expect(parsePsElapsedMs("00:05")).toBe(5_000);
    expect(parsePsElapsedMs("   12:34\n")).toBe((12 * 60 + 34) * 1_000);
    expect(parsePsElapsedMs("01:02:03")).toBe(((1 * 60 + 2) * 60 + 3) * 1_000);
    expect(parsePsElapsedMs("2-01:02:03")).toBe((((2 * 24 + 1) * 60 + 2) * 60 + 3) * 1_000);
  });

  it("fails open on anything it does not recognise", () => {
    expect(parsePsElapsedMs("")).toBeNull();
    expect(parsePsElapsedMs("garbage")).toBeNull();
    expect(parsePsElapsedMs("1:2:3:4")).toBeNull();
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
    // Unknown age by default, so a running-but-quiet agent takes the restart
    // path these tests were written for; the young-brain tests inject an age.
    pidElapsedMs: () => null,
    recentCrashLoop: () => false,
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

  it("rewrites a healthy launch agent that predates the materialization policy", async () => {
    const homeDir = makeTempHome("ade-launchd-materialize-");
    const servicePath = launchAgentPath(homeDir);
    const current = renderLaunchdPlist(serviceCommand, homeDir);
    const legacy = current
      .replace("  <key>ProcessType</key>\n  <string>Interactive</string>\n", "")
      .replace(`  <key>${MATERIALIZE_DATALESS_FILES_KEY}</key>\n  <true/>\n`, "")
      .replace("  <key>LowPriorityIO</key>\n  <false/>\n", "");
    expect(legacy).not.toBe(current);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, legacy, "utf8");
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
      // The installed brain is running and answering. Every existing macOS
      // install is in exactly this state, so out-of-date plist content is the
      // only thing that can carry the new policy to them.
      responsivenessProbe: () => true,
      currentPid: 9999,
      parentPid: () => null,
      handoverPidAlive: () => false,
      terminateDeps: { kill: () => {}, pidAlive: () => false },
    });

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(servicePath, "utf8")).toBe(current);
    expect(calls.map((call) => call.args[0])).toEqual([
      "print",
      "unload",
      "-axo",
      "load",
      "unload",
      "load",
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

  it("reports a live replacement that has not answered yet as starting, not failed", async () => {
    const homeDir = makeTempHome("ade-launchd-handover-starting-");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = spawnSequence(calls, [
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      // The handover poll sees launchd's replacement child running.
      { status: 0, stdout: "state = running\npid = 4321\n", stderr: "" },
    ]);

    const result = await install({
      command: serviceCommand,
      spawnSync,
      homeDir,
      responsivenessProbe: () => false,
      handoverPidAlive: (pid) => pid === 4321,
      handoverTimeoutMs: 0,
    });

    expect(result).toMatchObject({
      ok: true,
      starting: true,
      action: "install",
    });
    expect(result.failureStep).toBeUndefined();
    expect(result.message).toContain("still starting");
  });

  it("waits for a young unresponsive brain instead of restarting it", async () => {
    const homeDir = makeTempHome("ade-launchd-young-brain-");
    const servicePath = launchAgentPath(homeDir);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, renderLaunchdPlist(serviceCommand, homeDir), "utf8");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = runningAgentSpawn(calls, 1234);
    // Not answering on the first probe, answering once waited for.
    const responsivenessProbe = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const kill = vi.fn();

    const result = await install({
      command: serviceCommand,
      spawnSync,
      homeDir,
      env: { ...process.env, ADE_FORCE_RUNTIME_SERVICE_RESTART: "1" },
      responsivenessProbe,
      pidElapsedMs: () => 5_000,
      handoverPidAlive: () => true,
      terminateDeps: { kill, pidAlive: () => true },
    });

    expect(result.ok).toBe(true);
    expect(result.starting).toBeUndefined();
    expect(kill).not.toHaveBeenCalled();
    // No unload/load of the brain agent: only the watchdog is (re)armed.
    expect(calls.filter((call) => call.command === "launchctl" && call.args[1] === servicePath)).toEqual([]);
  });

  it("restarts a young quiet brain anyway when the machine is crash-looping", async () => {
    const homeDir = makeTempHome("ade-launchd-young-crashloop-");
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
    const kill = vi.fn();

    const result = await install({
      command: serviceCommand,
      spawnSync,
      homeDir,
      env: { ...process.env, ADE_FORCE_RUNTIME_SERVICE_RESTART: "1" },
      responsivenessProbe: () => true,
      pidElapsedMs: () => 5_000,
      recentCrashLoop: () => true,
      currentPid: 9999,
      parentPid: () => null,
      terminateDeps: { kill, pidAlive: () => false },
    });

    expect(result).toMatchObject({ ok: true, restarted: true });
    expect(calls.map((call) => call.args[0])).toContain("load");
  });

  it("does not restart a young brain that answers, even when a restart was forced", async () => {
    const homeDir = makeTempHome("ade-launchd-young-answering-");
    const servicePath = launchAgentPath(homeDir);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, renderLaunchdPlist(serviceCommand, homeDir), "utf8");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = runningAgentSpawn(calls, 1234);
    const kill = vi.fn();

    const result = await install({
      command: serviceCommand,
      spawnSync,
      homeDir,
      env: { ...process.env, ADE_FORCE_RUNTIME_SERVICE_RESTART: "1" },
      responsivenessProbe: () => true,
      pidElapsedMs: () => 5_000,
      handoverPidAlive: () => true,
      terminateDeps: { kill, pidAlive: () => true },
    });

    expect(result.ok).toBe(true);
    // Not a restart: the trust-reset caller must see that and try again later.
    expect(result.restarted).toBeUndefined();
    expect(kill).not.toHaveBeenCalled();
  });

  it("returns starting for a young brain that is still quiet after the wait", async () => {
    const homeDir = makeTempHome("ade-launchd-young-brain-quiet-");
    const servicePath = launchAgentPath(homeDir);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, renderLaunchdPlist(serviceCommand, homeDir), "utf8");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = runningAgentSpawn(calls, 1234);
    const kill = vi.fn();

    const result = await install({
      command: serviceCommand,
      spawnSync,
      homeDir,
      responsivenessProbe: () => false,
      pidElapsedMs: () => 5_000,
      handoverPidAlive: () => true,
      handoverTimeoutMs: 0,
      terminateDeps: { kill, pidAlive: () => true },
    });

    expect(result).toMatchObject({ ok: true, starting: true });
    expect(kill).not.toHaveBeenCalled();
  });

  // Regression: the young-brain wait and the real handover used to share one
  // install-wide deadline. A young brain that died late in its wait left the
  // restart that followed with ~0 ms, so a replacement launchd had not named
  // yet was reported as a `replacement_pid` handover failure.
  it("gives the restart a full handover window after a young brain dies mid-wait", async () => {
    const homeDir = makeTempHome("ade-launchd-young-died-");
    const servicePath = launchAgentPath(homeDir);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, renderLaunchdPlist(serviceCommand, homeDir), "utf8");

    let loadSeen = false;
    let printsAfterLoad = 0;
    const spawnSync: ServiceManagerSpawnSync = (command, args) => {
      if (command === "launchctl" && args[0] === "load") {
        loadSeen = true;
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "launchctl" && args[0] === "print") {
        if (!loadSeen) return { status: 0, stdout: "state = running\npid = 1234\n", stderr: "" };
        // launchd has not named the replacement yet for the first few polls.
        printsAfterLoad += 1;
        if (printsAfterLoad <= 3) return { status: 1, stdout: "", stderr: "not found" };
        return { status: 0, stdout: "state = running\npid = 5678\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    const result = await install({
      command: serviceCommand,
      spawnSync,
      homeDir,
      responsivenessProbe: () => false,
      // Young enough to wait for; it dies during the wait.
      pidElapsedMs: () => 5_000,
      handoverPidAlive: (pid) => pid !== 1234,
      handoverTimeoutMs: 300,
      handoverPollMs: 10,
      terminateDeps: { kill: vi.fn(), pidAlive: () => false },
      // This test's spawn stub answers only `launchctl`, so the ancestry probe
      // would read an empty parent list and, on a host whose backend reports
      // "unknown" for that, fail safe into the self-mutation block. Inject the
      // chain like every other install test here: this case is about handover
      // windows, not about who our parent is.
      currentPid: 9999,
      parentPid: () => null,
    });

    expect(result).toMatchObject({ ok: true, starting: true, restarted: true });
    expect(result.message).toContain("5678");
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

/** launchd that keeps reporting one running agent child, whatever is asked of it. */
function runningAgentSpawn(
  calls: Array<{ command: string; args: string[] }>,
  pid: number,
): ServiceManagerSpawnSync {
  return (command, args) => {
    calls.push({ command, args });
    if (command === "launchctl" && args[0] === "print") {
      return { status: 0, stdout: `state = running\npid = ${pid}\n`, stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}

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

const watchdogServiceCommand: AdeServiceCommand = {
  command: "/usr/local/bin/node",
  args: ["/opt/ade/cli.cjs", "serve"],
  env: { ADE_HOME: "/Users/example/.ade" },
};

describe("resolveWatchdogServiceName", () => {
  it("keeps each channel on its own watchdog", () => {
    expect(resolveWatchdogServiceName("com.ade.runtime")).toBe("com.ade.watchdog");
    expect(resolveWatchdogServiceName("com.ade.runtime.beta")).toBe("com.ade.watchdog.beta");
    expect(resolveWatchdogServiceName("com.example.custom")).toBe("com.example.custom.watchdog");
  });
});

describe("watchdogCommand", () => {
  it("runs the same binary the brain was installed from", () => {
    expect(watchdogCommand(watchdogServiceCommand)).toEqual({
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
      command: watchdogServiceCommand,
      homeDir: "/Users/example",
    });
    expect(plist).toContain("<string>com.ade.watchdog</string>");
    expect(plist).toContain("<key>StartInterval</key>");
    expect(plist).toContain("<integer>60</integer>");
    expect(plist).toContain("<string>watchdog-check</string>");
    // KeepAlive would make launchd respawn a one-shot check in a tight loop.
    expect(plist).not.toContain("<key>KeepAlive</key>");
  });

  it("can read a heartbeat file the cloud has evicted", () => {
    const plist = renderWatchdogLaunchdPlist({
      command: watchdogServiceCommand,
      homeDir: "/Users/example",
    });
    // A heartbeat this agent cannot read yields no verdict at all, so a storage
    // policy would leave it permanently blind to a wedged brain.
    expect(plist).toContain(`<key>${MATERIALIZE_DATALESS_FILES_KEY}</key>`);
    // Nothing waits on a once-a-minute check, so it claims no app-grade
    // resource exemption the way the brain does.
    expect(plist).not.toContain("<key>ProcessType</key>");
  });

  it("refuses an interval short enough to thrash", () => {
    const plist = renderWatchdogLaunchdPlist({
      command: watchdogServiceCommand,
      homeDir: "/Users/example",
      startIntervalSeconds: 1,
    });
    expect(plist).toContain("<integer>15</integer>");
  });
});

describe("installLaunchdWatchdogAgent", () => {
  it("writes and loads the agent", () => {
    const homeDir = makeTempHome("ade-watchdog-home-");
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = installLaunchdWatchdogAgent({
      command: watchdogServiceCommand,
      homeDir,
      spawnSync: spawnSequence(calls, []),
    });

    const servicePath = watchdogLaunchAgentPath(homeDir);
    expect(result.installed).toBe(true);
    expect(fs.existsSync(servicePath)).toBe(true);
    expect(calls.map((call) => call.args[0])).toEqual(["unload", "load"]);
  });

  it("rewrites an agent that predates the materialization policy", () => {
    const homeDir = makeTempHome("ade-watchdog-home-");
    const servicePath = watchdogLaunchAgentPath(homeDir);
    const current = renderWatchdogLaunchdPlist({
      command: watchdogServiceCommand,
      homeDir,
    });
    const legacy = current.replace(`  <key>${MATERIALIZE_DATALESS_FILES_KEY}</key>\n  <true/>\n`, "");
    expect(legacy).not.toBe(current);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, legacy, "utf8");

    installLaunchdWatchdogAgent({
      command: watchdogServiceCommand,
      homeDir,
      spawnSync: spawnSequence([], []),
    });

    expect(fs.readFileSync(servicePath, "utf8")).toBe(current);
  });

  it("reports a load failure instead of claiming the agent is armed", () => {
    const homeDir = makeTempHome("ade-watchdog-home-");
    const result = installLaunchdWatchdogAgent({
      command: watchdogServiceCommand,
      homeDir,
      spawnSync: (command, args) =>
        args[0] === "load"
          ? { status: 1, stdout: "", stderr: "Load failed" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(result.installed).toBe(false);
  });

  it("removes the agent with the brain it guards", () => {
    const homeDir = makeTempHome("ade-watchdog-home-");
    installLaunchdWatchdogAgent({
      command: watchdogServiceCommand,
      homeDir,
      spawnSync: spawnSequence([], []),
    });
    const servicePath = watchdogLaunchAgentPath(homeDir);
    expect(fs.existsSync(servicePath)).toBe(true);

    const calls: Array<{ command: string; args: string[] }> = [];
    uninstallLaunchdWatchdogAgent({ homeDir, spawnSync: spawnSequence(calls, []) });

    expect(fs.existsSync(servicePath)).toBe(false);
    expect(calls.map((call) => call.args[0])).toEqual(["bootout", "unload"]);
  });
});

/**
 * A stand-in for the brain's JSON-RPC endpoint. `replies` maps a method to the
 * result it answers with; anything absent is simply not answered, which is how
 * a wedged brain behaves. `closeOnShutdown` models the brain whose orderly exit
 * drops the socket before its own response gets out.
 */
function fakeEndpoint(
  replies: Record<string, unknown>,
  options: { closeOnShutdown?: boolean } = {},
): {
  socket: net.Socket;
  written: string[];
} {
  const written: string[] = [];
  const socket = new EventEmitter() as unknown as net.Socket & { destroy: () => void };
  let buffer = "";
  (socket as unknown as { write: unknown }).write = (payload: string) => {
    written.push(payload);
    buffer += payload;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const message = JSON.parse(line) as { id: number; method: string };
      if (options.closeOnShutdown && message.method === "shutdown") {
        queueMicrotask(() => socket.emit("close"));
        continue;
      }
      if (!(message.method in replies)) continue;
      queueMicrotask(() => {
        socket.emit(
          "data",
          Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: replies[message.method] })}\n`),
        );
      });
    }
    return true;
  };
  (socket as unknown as { destroy: () => void }).destroy = () => {};
  queueMicrotask(() => socket.emit("connect"));
  return { socket, written };
}

describe("requestAdeRuntimeShutdown", () => {
  const socketPath = String.raw`\\.\pipe\ade-runtime-stable-0123456789abcdef`;

  it("identifies the endpoint before asking it to leave", async () => {
    const endpoint = fakeEndpoint({ "runtime/info": { pid: 4242 }, shutdown: {} });
    const result = await requestAdeRuntimeShutdown({
      pid: 4242,
      socketPath,
      connect: () => endpoint.socket,
    });
    expect(result).toEqual({ requested: true });
    const methods = endpoint.written.map((line) => (JSON.parse(line) as { method: string }).method);
    expect(methods).toEqual(["runtime/info", "shutdown"]);
  });

  it("refuses to shut down a pid the endpoint does not belong to", async () => {
    // A pid scraped from a port diagnosis or a supervisor record can have been
    // recycled; shutting down whoever happens to answer would be a stranger.
    const endpoint = fakeEndpoint({ "runtime/info": { pid: 999 }, shutdown: {} });
    const result = await requestAdeRuntimeShutdown({
      pid: 4242,
      socketPath,
      connect: () => endpoint.socket,
    });
    expect(result.requested).toBe(false);
    const methods = endpoint.written.map((line) => (JSON.parse(line) as { method: string }).method);
    expect(methods).toEqual(["runtime/info"]);
  });

  /**
   * The orderly exit this path asks for tears down the brain's listening
   * socket, which races the JSON-RPC response back to us. Reading the close as
   * a refusal would send the caller to `taskkill /F` and cut the flush short.
   */
  it("treats a close after the request as the shutdown taking effect", async () => {
    const endpoint = fakeEndpoint({ "runtime/info": { pid: 4242 } }, { closeOnShutdown: true });
    const result = await requestAdeRuntimeShutdown({
      pid: 4242,
      socketPath,
      connect: () => endpoint.socket,
    });
    expect(result).toEqual({ requested: true });
  });

  it("reports a close before the request as the endpoint hanging up", async () => {
    const endpoint = fakeEndpoint({});
    queueMicrotask(() => endpoint.socket.emit("close"));
    const result = await requestAdeRuntimeShutdown({
      pid: 4242,
      socketPath,
      connect: () => endpoint.socket,
    });
    expect(result).toEqual({
      requested: false,
      reason: "the runtime endpoint closed before it could be asked to stop",
    });
  });

  it("gives up on a wedged endpoint instead of hanging the caller", async () => {
    const endpoint = fakeEndpoint({});
    const result = await requestAdeRuntimeShutdown({
      pid: 4242,
      socketPath,
      timeoutMs: 250,
      connect: () => endpoint.socket,
    });
    expect(result).toEqual({
      requested: false,
      reason: "the runtime endpoint did not answer within 250ms",
    });
  });

  it("never dials a tcp runtime endpoint", async () => {
    const result = await requestAdeRuntimeShutdown({
      pid: 4242,
      socketPath: "tcp://127.0.0.1:9999?token=secret",
      connect: () => {
        throw new Error("must not connect");
      },
    });
    expect(result.requested).toBe(false);
  });
});

import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";

export type ServiceManagerResult = {
  ok: boolean;
  serviceName: string;
  action: "install" | "uninstall";
  path: string | null;
  message: string;
  // Set when the result was refused because the caller is running inside the
  // very brain it tried to mutate. Consumers must branch on this typed flag,
  // never on the human-readable `message` text.
  selfMutationBlocked?: boolean;
  /** Typed install verification stage for callers that need repair diagnostics. */
  failureStep?: "predecessor_exit" | "replacement_pid" | "replacement_responsive";
};

export type ServiceManagerStatusResult = {
  ok: boolean;
  serviceName: string;
  action: "status";
  installed: boolean | null;
  running: boolean | null;
  path: string | null;
  message: string;
};

export type AdeServiceCommand = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

function resolveRuntimeServiceName(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ADE_RUNTIME_SERVICE_NAME?.trim();
  if (explicit) return explicit;
  const channel = env.ADE_PACKAGE_CHANNEL?.trim().toLowerCase();
  if (channel === "alpha") return "com.ade.runtime.alpha";
  if (channel === "beta") return "com.ade.runtime.beta";
  return "com.ade.runtime";
}

export const ADE_RUNTIME_SERVICE_NAME = resolveRuntimeServiceName();

export type ServiceManagerProcessResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

export type ServiceManagerSpawnSync = (
  command: string,
  args: string[],
  options?: SpawnSyncOptions,
) => ServiceManagerProcessResult;

function processOutputText(result: ServiceManagerProcessResult): string {
  if (typeof result.stdout === "string") return result.stdout.trim();
  if (Buffer.isBuffer(result.stdout)) return result.stdout.toString("utf8").trim();
  return "";
}

function readParentPid(
  run: ServiceManagerSpawnSync,
  pid: number,
): number | null {
  const result = run("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const parentPid = Number.parseInt(processOutputText(result), 10);
  return Number.isFinite(parentPid) && parentPid > 0 ? parentPid : null;
}

export function isCurrentProcessDescendantOfPid(args: {
  targetPid: number;
  run?: ServiceManagerSpawnSync;
  currentPid?: number;
  parentPid?: (pid: number) => number | null;
}): boolean {
  const targetPid = Math.floor(args.targetPid);
  if (!Number.isFinite(targetPid) || targetPid <= 0) return false;
  const run = args.run ?? spawnSync;
  const readPid = args.parentPid ?? ((pid) => readParentPid(run, pid));
  const seen = new Set<number>();
  let cursor = Math.floor(args.currentPid ?? process.pid);
  while (Number.isFinite(cursor) && cursor > 0 && !seen.has(cursor)) {
    if (cursor === targetPid) return true;
    seen.add(cursor);
    const next = readPid(cursor);
    if (!next || next === cursor) return false;
    cursor = next;
  }
  return false;
}

const RUNTIME_ENV_PASSTHROUGH = [
  "NODE_PATH",
  "ADE_HOME",
  "ADE_PACKAGE_CHANNEL",
  "ADE_DESKTOP_APP_NAME",
  "ADE_RUNTIME_SERVICE_NAME",
  "ADE_RUNTIME_ROOT",
  "ADE_RUNTIME_NODE_MODULES",
  "ADE_DEFAULT_ROLE",
] as const;

function runtimeEnvironment(): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  if (process.versions.electron) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  for (const key of RUNTIME_ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value?.trim()) {
      env[key] = value;
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function fileSha256(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function resolveCliPackageRoot(entryPath: string): string | null {
  const seen = new Set<string>();
  const starts = entryPath ? [path.dirname(entryPath)] : [process.cwd()];
  for (const start of starts) {
    if (!start) continue;
    let cursor = path.resolve(start);
    while (!seen.has(cursor)) {
      seen.add(cursor);
      const packageJson = path.join(cursor, "package.json");
      const srcCli = path.join(cursor, "src", "cli.ts");
      if (fs.existsSync(packageJson) && fs.existsSync(srcCli)) {
        return cursor;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  return null;
}

function resolveCliDistPath(entryPath: string): string | null {
  const packageRoot = resolveCliPackageRoot(entryPath);
  if (!packageRoot) return null;
  const distPath = path.join(packageRoot, "dist", "cli.cjs");
  return fs.existsSync(distPath) ? distPath : null;
}

export function resolveAdeServiceCommandBuildHash(command: AdeServiceCommand): string | null {
  const firstArg = command.args[0] ? path.resolve(command.args[0]) : "";
  const isNodeServeFallback =
    command.command === process.execPath
    && command.args.length === 1
    && command.args[0] === "serve";
  if (isNodeServeFallback) {
    const entry = typeof process.argv[1] === "string" && process.argv[1].trim()
      ? path.resolve(process.argv[1])
      : "";
    const distPath = resolveCliDistPath(entry);
    return distPath ? fileSha256(distPath) : null;
  }
  if (command.command === process.execPath && firstArg && fs.existsSync(firstArg)) {
    return fileSha256(firstArg);
  }
  if (command.command !== process.execPath && fs.existsSync(command.command)) {
    return fileSha256(path.resolve(command.command));
  }
  return null;
}

function withRuntimeBuildHash(command: AdeServiceCommand): AdeServiceCommand {
  const buildHash = resolveAdeServiceCommandBuildHash(command);
  if (!buildHash) return command;
  return {
    ...command,
    env: {
      ...(command.env ?? {}),
      ADE_RUNTIME_BUILD_HASH: buildHash,
    },
  };
}

export type TerminatePidDeps = {
  kill?: (pid: number, signal: NodeJS.Signals | number) => void;
  pidAlive?: (pid: number) => boolean;
  graceTimeoutMs?: number;
};

function defaultKill(pid: number, signal: NodeJS.Signals | number): void {
  process.kill(pid, signal);
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function terminatePidGracefully(pid: number | null, deps: TerminatePidDeps = {}): void {
  if (!pid || pid <= 0 || pid === process.pid) return;
  const kill = deps.kill ?? defaultKill;
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  try {
    kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + (deps.graceTimeoutMs ?? 1_500);
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    sleepSync(50);
  }
  try {
    kill(pid, "SIGKILL");
  } catch {
    // best effort
  }
}

export async function terminatePidGracefullyAsync(
  pid: number | null,
  deps: TerminatePidDeps = {},
): Promise<void> {
  if (!pid || pid <= 0 || pid === process.pid) return;
  const kill = deps.kill ?? defaultKill;
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  try {
    kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + (deps.graceTimeoutMs ?? 1_500);
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 50);
      timer.unref?.();
    });
  }
  try {
    kill(pid, "SIGKILL");
  } catch {
    // best effort
  }
}

export function resolveAdeServeCliScriptPath(command: AdeServiceCommand): string {
  const first = command.args[0]?.trim();
  if (first && first !== "serve") return first;
  return command.command;
}

// A ps command line counts as a stale channel brain when it runs this
// channel's packaged CLI in `serve` mode against the channel's primary
// socket. Isolated (--no-sync), installer, and foreign-socket runtimes are
// other lifecycles and must not be reaped by a service install.
export function isStaleChannelServeCommandLine(
  commandLine: string,
  opts: { cliScriptPath: string; primarySocketPath: string },
): boolean {
  const line = commandLine.trim();
  if (!line || !opts.cliScriptPath) return false;
  const socketMatch = line.match(/--socket(?:=|\s+)(\S+)/);
  const explicitPrimarySocket = socketMatch
    ? path.resolve(socketMatch[1]) === path.resolve(opts.primarySocketPath)
    : false;
  const cliIndex = line.indexOf(opts.cliScriptPath);
  const alternateCliMatch = line.match(
    /\b(?:ade-cli[\\/](?:bin[\\/]ade|cli\.cjs)|apps[\\/]ade-cli[\\/]dist[\\/]cli\.cjs|cli\.cjs)(?=\s+serve(?:\s|$))/,
  );
  const tail = cliIndex >= 0
    ? line.slice(cliIndex + opts.cliScriptPath.length)
    : alternateCliMatch?.index != null
      ? line.slice(alternateCliMatch.index + alternateCliMatch[0].length)
      : "";
  if (!/^\s+serve(?:\s|$)/.test(tail)) return false;
  if (/--(?:install-service|uninstall-service|service-status|no-sync)\b/.test(tail)) return false;
  if (socketMatch && !explicitPrimarySocket) {
    return false;
  }
  if (cliIndex < 0 && !explicitPrimarySocket) return false;
  return true;
}

export function listStaleChannelServePids(
  run: ServiceManagerSpawnSync,
  opts: { cliScriptPath: string; primarySocketPath: string; excludePids?: number[] },
): number[] {
  const result = run("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (result.status !== 0) return [];
  const output = typeof result.stdout === "string"
    ? result.stdout
    : Buffer.isBuffer(result.stdout)
      ? result.stdout.toString("utf8")
      : "";
  const exclude = new Set([process.pid, ...(opts.excludePids ?? [])]);
  const pids: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isFinite(pid) || pid <= 0 || exclude.has(pid)) continue;
    if (isStaleChannelServeCommandLine(match[2], opts)) pids.push(pid);
  }
  return pids;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function cmdQuote(value: string): string {
  if (value.includes("\"")) {
    throw new Error("Windows service command arguments cannot contain double quotes.");
  }
  let quoted = "\"";
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    quoted += "\\".repeat(backslashes);
    quoted += char;
    backslashes = 0;
  }
  quoted += "\\".repeat(backslashes * 2);
  quoted += "\"";
  return quoted;
}

export function resolveAdeServeCommand(): AdeServiceCommand {
  const entry = typeof process.argv[1] === "string" && process.argv[1].trim()
    ? path.resolve(process.argv[1])
    : "";
  const isNodeScript = /\.(?:cjs|mjs|js|ts)$/i.test(entry) && fs.existsSync(entry);
  if (isNodeScript) {
    return withRuntimeBuildHash({
      command: process.execPath,
      args: [entry, "serve"],
      env: runtimeEnvironment(),
    });
  }
  if (entry && fs.existsSync(entry)) {
    return withRuntimeBuildHash({
      command: entry,
      args: ["serve"],
      env: runtimeEnvironment(),
    });
  }
  return withRuntimeBuildHash({
    command: process.execPath,
    args: ["serve"],
    env: runtimeEnvironment(),
  });
}

export function renderCommand(command: AdeServiceCommand): string {
  return [command.command, ...command.args].map(shellQuote).join(" ");
}

export function renderWindowsCommand(command: AdeServiceCommand): string {
  return [command.command, ...command.args].map(cmdQuote).join(" ");
}

function streamToText(value: string | Buffer | null | undefined): string {
  if (typeof value === "string") return value.trim();
  if (Buffer.isBuffer(value)) return value.toString("utf8").trim();
  return "";
}

export function serviceManagerResultText(result: ServiceManagerProcessResult): string {
  return streamToText(result.stderr) || streamToText(result.stdout);
}

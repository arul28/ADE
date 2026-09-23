/**
 * Hand an `ade` invocation to the CLI ADE launched the agent with.
 *
 * ADE puts a per-channel shim directory first on an agent's PATH and records it
 * in `ADE_CLI_PATH`. A shell rc that rebuilds PATH from scratch (`export
 * PATH=/opt/homebrew/bin:...`) and then prepends `~/.local/bin` drops that shim,
 * so the agent's `ade` resolves to whatever older install lives there and fails
 * on newer commands ("Unknown command 'apple'"). rc files never touch
 * `ADE_CLI_PATH`, so the CLI that did get run can notice it is not the one ADE
 * meant and re-run the same argv through it.
 *
 * This runs on every `ade` call, before the rest of the CLI bundle is even
 * evaluated, so it only stats a few files: no network, no heavy imports.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPathInside, pathsEqual } from "../../../desktop/src/main/services/shared/pathCompare";
import {
  resolveCliSpawnInvocation,
  shouldUseWindowsCmdWrapper,
} from "../../../desktop/src/main/services/shared/processExecution";
import { isSourceCheckoutRuntimeModule } from "../runtimePackaging";
import { isCliGlobalValueFlag, looksLikeSocketPathOverride } from "./cliGlobalArgs";

/** Set on the delegated child: never delegate again (loop guard). */
export const CLI_DELEGATED_ENV = "ADE_CLI_DELEGATED";
/** Set to 1 to always run the CLI that was invoked. */
export const CLI_NO_DELEGATE_ENV = "ADE_CLI_NO_DELEGATE";

const CLI_MAIN_ARGV_PATTERN = /(^|[/\\])cli\.(?:ts|js|cjs)$/;
const JS_ENTRY_PATTERN = /\.(?:cjs|mjs|js)$/i;
/** Shims are a few KB; never read more than this looking for an entry path. */
const SHIM_SCAN_BYTES = 64 * 1024;

export type CliDelegationFs = {
  isFile(filePath: string): boolean;
  realpath(filePath: string): string | null;
  /** First `maxBytes` of the file as UTF-8, or null when unreadable. */
  readHead(filePath: string, maxBytes: number): string | null;
};

export const nodeCliDelegationFs: CliDelegationFs = {
  isFile(filePath) {
    try {
      return fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  },
  realpath(filePath) {
    try {
      return fs.realpathSync(filePath);
    } catch {
      return null;
    }
  },
  readHead(filePath, maxBytes) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(filePath, "r");
      const buffer = Buffer.alloc(maxBytes);
      const read = fs.readSync(fd, buffer, 0, maxBytes, 0);
      return buffer.subarray(0, read).toString("utf8");
    } catch {
      return null;
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Nothing to recover; the read already succeeded or failed.
        }
      }
    }
  },
};

export type CliDelegationTarget = {
  /** What to spawn: `ADE_CLI_PATH` as given. */
  command: string;
  /** The CLI entry it runs, when known. */
  entry: string | null;
};

function canonical(filePath: string, fsLike: CliDelegationFs): string {
  return fsLike.realpath(filePath) ?? path.resolve(filePath);
}

/**
 * Decide whether this `ade` run should hand off to `ADE_CLI_PATH`.
 *
 * Delegates only when the target provably or plausibly runs a different CLI
 * entry than `currentEntry`:
 * - `ADE_CLI_ENTRY_PATH` (set next to every ADE shim) is the identity when it
 *   exists; compared by realpath.
 * - Otherwise the target itself, the packaged `bin/ade` -> `../cli.cjs` layout,
 *   or a small shim that names the current entry all count as "same CLI".
 *
 * Never delegates when the guard or opt-out is set, when the target is missing,
 * when the current entry is unknown, or when the running CLI is a source
 * checkout build (a lane's `apps/ade-cli/dist/cli.cjs` run on purpose to test
 * it must not be swapped for the installed app).
 */
export function resolveCliDelegationTarget(
  env: NodeJS.ProcessEnv,
  currentEntry: string | null,
  fsLike: CliDelegationFs = nodeCliDelegationFs,
  platform: NodeJS.Platform = process.platform,
): CliDelegationTarget | null {
  if (env[CLI_DELEGATED_ENV] === "1" || env[CLI_NO_DELEGATE_ENV] === "1") return null;
  const command = env.ADE_CLI_PATH?.trim();
  if (!command || !fsLike.isFile(command)) return null;
  if (!currentEntry) return null;

  const current = canonical(currentEntry, fsLike);
  if (isSourceCheckoutRuntimeModule(current)) return null;
  const same = (candidate: string) => pathsEqual(candidate, current, platform);

  const declaredEntry = env.ADE_CLI_ENTRY_PATH?.trim();
  if (declaredEntry && fsLike.isFile(declaredEntry)) {
    const entry = canonical(declaredEntry, fsLike);
    return same(entry) ? null : { command, entry };
  }

  const target = canonical(command, fsLike);
  if (same(target)) return null;
  if (JS_ENTRY_PATTERN.test(target)) return { command, entry: target };

  // Packaged layout: <Resources>/ade-cli/bin/ade(.cmd) runs <Resources>/ade-cli/cli.cjs.
  if (path.basename(path.dirname(target)).toLowerCase() === "bin") {
    const sibling = path.join(path.dirname(path.dirname(target)), "cli.cjs");
    if (fsLike.isFile(sibling)) {
      const entry = canonical(sibling, fsLike);
      return same(entry) ? null : { command, entry };
    }
  }

  // A generated shim names its entry verbatim; a binary (static runtime) will not.
  const head = fsLike.readHead(target, SHIM_SCAN_BYTES);
  if (head && (head.includes(current) || head.includes(currentEntry))) return null;
  return { command, entry: null };
}

/**
 * The file that identifies the running CLI: the static runtime binary for a
 * Node SEA build (whose argv[1] is rewritten to a bare "cli.cjs"), else argv[1].
 */
export function resolveCurrentCliEntry(proc: Pick<NodeJS.Process, "argv" | "execPath"> = process): string | null {
  try {
    const sea = (process as NodeJS.Process & {
      getBuiltinModule?: (id: string) => unknown;
    }).getBuiltinModule?.("node:sea") as { isSea?: () => boolean } | undefined;
    if (sea?.isSea?.()) return proc.execPath;
  } catch {
    // Older runtimes without node:sea are never SEA builds.
  }
  const argv1 = proc.argv[1]?.trim();
  return argv1 ? path.resolve(argv1) : null;
}

function filterPathList(value: string | undefined, isStale: (entry: string) => boolean): string | undefined {
  if (!value) return value;
  const kept = value.split(path.delimiter).filter((entry) => entry && !isStale(entry));
  return kept.length ? kept.join(path.delimiter) : undefined;
}

/**
 * The env for the delegated child: the loop guard, minus what the stale
 * install's own launcher injected. A packaged `bin/ade` prepends its app's
 * module dirs to NODE_PATH (and may seed the skills dir); a static runtime
 * records its runtime root. Left in place, the target CLI would resolve its
 * externals from the older install.
 */
export function buildDelegatedCliEnv(env: NodeJS.ProcessEnv, currentEntry: string): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, [CLI_DELEGATED_ENV]: "1" };
  const staleRoots: string[] = [];
  if (path.basename(path.dirname(currentEntry)).toLowerCase() === "ade-cli") {
    staleRoots.push(path.dirname(path.dirname(currentEntry)));
  }
  const resolvedRuntimeRoot = env.ADE_RESOLVED_RUNTIME_ROOT?.trim();
  if (resolvedRuntimeRoot) {
    staleRoots.push(resolvedRuntimeRoot);
    delete next.ADE_RESOLVED_RUNTIME_ROOT;
    if (env.ADE_RUNTIME_ROOT?.trim() === resolvedRuntimeRoot) delete next.ADE_RUNTIME_ROOT;
  }
  if (staleRoots.length === 0) return next;
  const isStale = (entry: string) => staleRoots.some((root) => isPathInside(path.resolve(entry), path.resolve(root)));
  for (const key of ["NODE_PATH", "ADE_AGENT_SKILLS_DIRS"] as const) {
    const filtered = filterPathList(next[key], isStale);
    if (filtered === undefined) delete next[key];
    else next[key] = filtered;
  }
  return next;
}

type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** The variables an ADE shim defaults when the caller set neither. */
const SHIM_DEFAULT_NAMES = new Set(["ADE_HOME", "ADE_RUNTIME_SOCKET_PATH"]);

export type AdeCmdShimLaunch = {
  execPath: string;
  entryPath: string;
  defaults: Array<[string, string]>;
};

/**
 * Read a Windows `ade.cmd` exactly as `renderAdeCliShim` writes it for a JS
 * entry. Null for anything else, including a hand-edited shim, so the caller
 * falls back to running it through cmd.exe.
 */
export function parseAdeCmdShim(text: string): AdeCmdShimLaunch | null {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines[0] !== "@echo off" || lines[1] !== "setlocal") return null;
  const unbatch = (value: string) => value.replace(/%%/g, "%");
  const defaults: Array<[string, string]> = [];
  let runtimeFlag = false;
  for (const line of lines.slice(2, -1)) {
    const set = /^set "([A-Z_]+)=([^"]*)"$/.exec(line);
    if (set && SHIM_DEFAULT_NAMES.has(set[1]!)) {
      defaults.push([set[1]!, unbatch(set[2]!)]);
    } else if (line === "set ELECTRON_RUN_AS_NODE=1") {
      runtimeFlag = true;
    } else if (
      line !== ":ade_run"
      && line !== "if defined ADE_HOME goto ade_run"
      && line !== "if defined ADE_RUNTIME_SOCKET_PATH goto ade_run"
    ) {
      return null;
    }
  }
  const exec = /^"([^"]+)" "([^"]+)" %\*$/.exec(lines[lines.length - 1] ?? "");
  if (!runtimeFlag || !exec) return null;
  return { execPath: unbatch(exec[1]!), entryPath: unbatch(exec[2]!), defaults };
}

type DelegatedInvocation = { command: string; args: string[]; env: NodeJS.ProcessEnv; windowsVerbatimArguments?: boolean };

/**
 * How to start the target. A JS entry runs under this process's runtime. On
 * Windows, an ADE `.cmd` shim is read and its runtime and entry are started
 * directly: cmd.exe would expand `%VAR%` in the arguments a second time, and
 * `%` cannot be escaped on a command line. Any other `.cmd` still goes through
 * cmd.exe with each argument quoted by the shared helper.
 */
function resolveDelegatedInvocation(args: {
  command: string;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  execPath: string;
  platform: NodeJS.Platform;
  fsLike: CliDelegationFs;
}): DelegatedInvocation {
  if (JS_ENTRY_PATTERN.test(args.command)) {
    return {
      command: args.execPath,
      args: [args.command, ...args.argv],
      env: { ...args.env, ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  if (shouldUseWindowsCmdWrapper(args.command, args.platform)) {
    const shim = parseAdeCmdShim(args.fsLike.readHead(args.command, SHIM_SCAN_BYTES) ?? "");
    if (shim) {
      const callerPicked = Boolean(args.env.ADE_HOME || args.env.ADE_RUNTIME_SOCKET_PATH);
      return {
        command: shim.execPath,
        args: [shim.entryPath, ...args.argv],
        env: {
          ...args.env,
          ...(callerPicked ? {} : Object.fromEntries(shim.defaults)),
          ELECTRON_RUN_AS_NODE: "1",
        },
      };
    }
  }
  return {
    ...resolveCliSpawnInvocation(args.command, [...args.argv], args.env, args.platform),
    env: args.env,
  };
}

export type DelegatedCliExit = { code: number | null; signal: NodeJS.Signals | null };

/**
 * Run `argv` through the target CLI with inherited stdio, forwarding signals.
 * argv is passed as structured arguments (see `resolveDelegatedInvocation`).
 * Resolves with the child's exit; rejects when the child cannot be started.
 */
export function runDelegatedCli(args: {
  target: CliDelegationTarget;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  execPath?: string;
  platform?: NodeJS.Platform;
  spawnFn?: SpawnLike;
  signalSource?: Pick<NodeJS.Process, "on" | "removeListener">;
  fsLike?: CliDelegationFs;
}): Promise<DelegatedCliExit> {
  const platform = args.platform ?? process.platform;
  const spawnFn = args.spawnFn ?? (spawn as SpawnLike);
  const signalSource = args.signalSource ?? process;
  const invocation = resolveDelegatedInvocation({
    command: args.target.command,
    argv: args.argv,
    env: args.env,
    execPath: args.execPath ?? process.execPath,
    platform,
    fsLike: args.fsLike ?? nodeCliDelegationFs,
  });

  return new Promise<DelegatedCliExit>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnFn(invocation.command, invocation.args, {
        env: invocation.env,
        stdio: "inherit",
        // A parent with no console (an agent host spawns `ade` hidden) would
        // otherwise get a visible console window for the child.
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments ?? false,
      });
    } catch (error) {
      reject(error);
      return;
    }
    // Windows delivers Ctrl+C to every process on the console already; keeping
    // a listener only stops this parent from dying before its child does.
    const forwarded: NodeJS.Signals[] = platform === "win32" ? ["SIGINT"] : ["SIGINT", "SIGTERM", "SIGHUP"];
    const forward = (signal: NodeJS.Signals) => {
      if (platform === "win32") return;
      try {
        child.kill(signal);
      } catch {
        // The child already exited; its exit event settles the promise.
      }
    };
    for (const signal of forwarded) signalSource.on(signal, forward);
    const cleanup = () => {
      for (const signal of forwarded) signalSource.removeListener(signal, forward);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve({ code, signal });
    });
  });
}

export function isCliMainArgv(argv1: string | undefined): boolean {
  return CLI_MAIN_ARGV_PATTERN.test(argv1 ?? "");
}

function exitLike(result: DelegatedCliExit): never {
  if (result.signal) {
    try {
      process.kill(process.pid, result.signal);
    } catch {
      // Fall through to the conventional 128 + n exit below.
    }
    process.exit(128 + (os.constants.signals[result.signal] ?? 1));
  }
  process.exit(result.code ?? 1);
}

/**
 * Commands that start or serve a runtime. They run the CLI of the app that
 * launched them, never another install's: `ade serve` handed to an older CLI
 * would start an older brain on this app's socket.
 */
const RUNTIME_OWNING_COMMANDS = new Set(["serve", "runtime", "rpc"]);

/** The first command word of an `ade` argv, after the global flags. */
export function cliCommandWord(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") return null;
    if (!token.startsWith("-")) return token;
    if (isCliGlobalValueFlag(token)) {
      index += 1;
    } else if (token === "--socket" && looksLikeSocketPathOverride(argv[index + 1] ?? "")) {
      // Bare, `--socket` means "the default socket".
      index += 1;
    }
  }
  return null;
}

export function cliArgvOwnsRuntime(argv: readonly string[]): boolean {
  const word = cliCommandWord(argv);
  return word !== null && RUNTIME_OWNING_COMMANDS.has(word);
}

/**
 * Entry-point hook, called once at the top of the CLI bundle. Returns null when
 * this process should run normally. Otherwise the child is already running and
 * the returned promise resolves `false` only if it could not be started (the
 * caller then runs normally); on a started child it never resolves, because the
 * process exits with the child's status.
 */
export function startCliDelegationIfNeeded(): Promise<boolean> | null {
  const guardSet = process.env[CLI_DELEGATED_ENV] === "1";
  // Read once, then drop it so agents and runtimes this CLI launches can still
  // delegate their own `ade` calls.
  if (guardSet) delete process.env[CLI_DELEGATED_ENV];
  if (guardSet || process.env.VITEST || !isCliMainArgv(process.argv[1])) return null;
  if (cliArgvOwnsRuntime(process.argv.slice(2))) return null;

  const currentEntry = resolveCurrentCliEntry();
  const target = resolveCliDelegationTarget(process.env, currentEntry);
  if (!target || !currentEntry) return null;

  return runDelegatedCli({
    target,
    argv: process.argv.slice(2),
    env: buildDelegatedCliEnv(process.env, canonical(currentEntry, nodeCliDelegationFs)),
  }).then(
    (result) => exitLike(result),
    (error: unknown) => {
      process.stderr.write(
        `ade: could not run ${target.command} (${error instanceof Error ? error.message : String(error)}); continuing with this CLI.\n`,
      );
      return false;
    },
  );
}

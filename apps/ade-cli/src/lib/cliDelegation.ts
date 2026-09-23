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
import { resolveCliSpawnInvocation } from "../../../desktop/src/main/services/shared/processExecution";
import { isSourceCheckoutRuntimeModule } from "../runtimePackaging";

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

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin" ? a.toLowerCase() === b.toLowerCase() : a === b;
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
  const same = (candidate: string) => samePath(candidate, current, platform);

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
  const isStale = (entry: string) => {
    const resolved = path.resolve(entry);
    return staleRoots.some((root) => {
      const relative = path.relative(path.resolve(root), resolved);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });
  };
  for (const key of ["NODE_PATH", "ADE_AGENT_SKILLS_DIRS"] as const) {
    const filtered = filterPathList(next[key], isStale);
    if (filtered === undefined) delete next[key];
    else next[key] = filtered;
  }
  return next;
}

type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export type DelegatedCliExit = { code: number | null; signal: NodeJS.Signals | null };

/**
 * Run `argv` through the target CLI with inherited stdio, forwarding signals.
 * argv is passed as structured arguments: POSIX spawns the shim directly; a
 * Windows `.cmd` shim goes through `cmd.exe /d /s /c` with each argument quoted
 * by the shared helper; a bare JS entry runs under this process's runtime.
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
}): Promise<DelegatedCliExit> {
  const platform = args.platform ?? process.platform;
  const spawnFn = args.spawnFn ?? (spawn as SpawnLike);
  const signalSource = args.signalSource ?? process;
  let env = args.env;
  let invocation: { command: string; args: string[]; windowsVerbatimArguments?: boolean };
  if (JS_ENTRY_PATTERN.test(args.target.command)) {
    env = { ...env, ELECTRON_RUN_AS_NODE: "1" };
    invocation = { command: args.execPath ?? process.execPath, args: [args.target.command, ...args.argv] };
  } else {
    invocation = resolveCliSpawnInvocation(args.target.command, [...args.argv], env, platform);
  }

  return new Promise<DelegatedCliExit>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnFn(invocation.command, invocation.args, {
        env,
        stdio: "inherit",
        windowsHide: false,
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
 * Entry-point hook, called once at the top of the CLI bundle. Returns null when
 * this process should run normally. Otherwise the child is already running and
 * the returned promise resolves `false` only if it could not be started (the
 * caller then runs normally); on a started child it never resolves, because the
 * process exits with the child's status.
 */
/** Global flags that take the next token as their value. */
const GLOBAL_VALUE_FLAGS = new Set(["--project-root", "--workspace-root", "--role", "--timeout", "--timeout-ms"]);
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
    if (GLOBAL_VALUE_FLAGS.has(token)) {
      index += 1;
    } else if (token === "--socket") {
      // `--socket` takes a path only when one follows; bare, it means "the default socket".
      const next = argv[index + 1] ?? "";
      if (/[/\\]|\.sock$/i.test(next)) index += 1;
    }
  }
  return null;
}

export function cliArgvOwnsRuntime(argv: readonly string[]): boolean {
  const word = cliCommandWord(argv);
  return word !== null && RUNTIME_OWNING_COMMANDS.has(word);
}

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

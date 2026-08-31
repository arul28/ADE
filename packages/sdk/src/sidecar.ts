import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runtimeSpawnEnv } from "./download.js";
import { AdeError, errorMessage } from "./errors.js";
import { JsonRpcConnection } from "./jsonRpc.js";
import { removeRuntimePidfile, writeRuntimePidfile } from "./runtimePidfile.js";
import { ensurePrivateSocketDirectory, isNamedPipePath } from "./socketPath.js";
import { resolveTrustedWindowsTool } from "./windowsSystemTools.js";
import { resolveSpawnInvocation } from "./windowsInvocation.js";

/**
 * Owns the child `ade runtime run --socket <path> --profile embedded` process.
 *
 * The runtime prints its ready banner to stderr and only creates the endpoint
 * once it is listening, so there is no stdout handshake to wait on (confirmed
 * with the engine agent). Readiness is therefore "a connect succeeded": retry
 * ECONNREFUSED/ENOENT with backoff until the deadline, and fail fast if the
 * child exits while we are waiting.
 */

export type SidecarOptions = {
  binaryPath: string;
  runtimeRoot: string | null;
  socketPath: string;
  home: string;
  logger: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Overall budget for spawn + first successful connect. */
  startupTimeoutMs?: number;
  /**
   * Value pinned into the child's ADE_DEFAULT_ROLE. Least privilege by default;
   * see the note on the handshake identity in client.ts.
   */
  adeDefaultRole?: string;
};

export type Sidecar = {
  readonly child: ChildProcess;
  readonly connection: JsonRpcConnection;
  readonly socketPath: string;
  /** Resolves once the child has exited (or immediately if it already had). */
  stop(): Promise<void>;
};

/**
 * ADE_* variables the sidecar sets deliberately. Everything else with that
 * prefix is the HOST's configuration and is removed before spawning.
 */
/**
 * Least privilege that still serves every personal-chat action the SDK calls.
 * Verified against a real runtime through the live fixture rather than assumed
 * — an over-privileged default is invisible until it is exploited.
 */
export const DEFAULT_ADE_ROLE = "agent";

export const FORWARDED_ADE_ENV_VARS = new Set([
  "ADE_HOME",
  "ADE_EMBEDDED_PARENT_PID",
  "ADE_DEFAULT_ROLE",
  // Set by runtimeSpawnEnv so the binary can dlopen its native modules; without
  // these a downloaded runtime cannot start at all.
  "ADE_RUNTIME_ROOT",
  "ADE_RUNTIME_NODE_MODULES",
]);

/** Pure and exported so the scrub list is testable without spawning. */
export function scrubAdeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("ADE_") && !FORWARDED_ADE_ENV_VARS.has(key)) continue;
    result[key] = value;
  }
  return result;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const CONNECT_RETRY_INITIAL_MS = 25;
const CONNECT_RETRY_MAX_MS = 250;
const SHUTDOWN_GRACE_MS = 5_000;
/**
 * How long a Windows child gets to unwind on its own before the tree is torn
 * down. Windows has no SIGTERM, so this window — with the RPC connection
 * already closed and the parent-death watchdog running — is the only graceful
 * shutdown available there.
 */
const WINDOWS_GRACEFUL_EXIT_MS = 1_500;

export const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * The slice of `process` the exit hooks touch. Injected so the whole
 * install/signal/re-raise/remove cycle is testable without arming real signal
 * handlers in the test runner.
 */
export type ExitHookHost = {
  pid: number;
  listenerCount(event: string): number;
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
  kill(pid: number, signal: NodeJS.Signals): unknown;
};

export type ExitHooks = { install(): void; remove(): void };

/**
 * Kills every live sidecar when the host process goes down.
 *
 * Attaching ANY listener to SIGINT/SIGTERM/SIGHUP suppresses Node's default
 * action for that signal, which is to terminate. A library that quietly does
 * that takes Ctrl-C away from every plain host that embeds it — the process
 * kills its children and then keeps running. So this hook restores the default
 * when, and only when, it is the one suppressing it.
 *
 * "Am I the only listener" is answered AFTER detaching our own handlers, at
 * signal time — never from a snapshot taken at install. A host that registers
 * its SIGINT handler after `createAdeChat` (an Electron main, a CLI that wires
 * shutdown late) would fail an install-time snapshot in the worst way: we would
 * re-raise, that host handler would run a SECOND time, and the default exit
 * would still not apply because its listener is attached. Counting after
 * `remove()` describes the world as it actually is when the signal arrives.
 */
export function createExitHooks(host: ExitHookHost, killAll: () => void): ExitHooks {
  let exitHandler: (() => void) | null = null;
  const signalHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];

  const remove = (): void => {
    if (exitHandler) {
      host.off("exit", exitHandler);
      exitHandler = null;
    }
    for (const { signal, handler } of signalHandlers.splice(0)) {
      host.off(signal, handler);
    }
  };

  return {
    install(): void {
      if (exitHandler) return;
      exitHandler = killAll;
      host.on("exit", exitHandler);
      for (const signal of TERMINATION_SIGNALS) {
        const handler = (): void => {
          killAll();
          // Detach first: the count below must not see our own handler, and a
          // re-raise must reach Node's default rather than recurse into here.
          remove();
          if (host.listenerCount(signal) === 0) {
            try {
              host.kill(host.pid, signal);
            } catch {
              // Nothing better to do while dying.
            }
          }
        };
        signalHandlers.push({ signal, handler });
        host.on(signal, handler);
      }
    },
    remove,
  };
}

/**
 * Process-exit hooks are registered once per process and fan out to every live
 * sidecar. Registering per-instance would blow past Node's max-listeners warning
 * for an app that opens several clients, and would leak listeners on dispose.
 */
const liveSidecars = new Set<{ kill(): void }>();

function killAllSidecars(): void {
  for (const entry of [...liveSidecars]) {
    try {
      entry.kill();
    } catch {
      // Best-effort during teardown.
    }
  }
  liveSidecars.clear();
}

const exitHooks = createExitHooks(process as unknown as ExitHookHost, killAllSidecars);

/**
 * Drops a sidecar from the process-wide set, and uninstalls the hooks once the
 * set is empty. A host that opens and disposes a client must not be left with
 * our signal handlers still suppressing its own Ctrl-C.
 */
function releaseSidecar(handle: { kill(): void }): void {
  liveSidecars.delete(handle);
  if (liveSidecars.size === 0) exitHooks.remove();
}

export async function startSidecar(options: SidecarOptions): Promise<Sidecar> {
  const {
    binaryPath,
    runtimeRoot,
    socketPath,
    home,
    logger,
    env = process.env,
    startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    adeDefaultRole = DEFAULT_ADE_ROLE,
  } = options;

  await prepareEndpoint(socketPath);

  const childEnv: NodeJS.ProcessEnv = {
    // Scrubbed: the host's own ADE_* variables are NOT this sidecar's config.
    // A developer running the SDK from inside a configured ADE shell would
    // otherwise leak ADE_PROJECT_ROOT, ADE_DEFAULT_ROLE, ADE_SOCKET and friends
    // into an isolated runtime, silently pointing it at their real state.
    ...scrubAdeEnv(runtimeRoot ? runtimeSpawnEnv(runtimeRoot, env) : env),
    // The isolated per-app state root. Everything the embedded profile writes
    // (db, secrets, personal chat state) lands under here rather than in the
    // developer's real ~/.ade.
    ADE_HOME: home,
    // The runtime polls this pid and exits when it disappears.
    //
    // `detached: false` below is NOT a lifetime guarantee: on POSIX it only
    // keeps the child in our process group, and an orphan is reparented to init
    // rather than killed. So `stop()` and the exit hooks cover graceful teardown
    // and this covers the case they structurally cannot — the host dying without
    // unwinding (SIGKILL, a crashed renderer, `kill -9` from a harness). Without
    // it, every hard kill of the host leaks a runtime holding this home.
    ADE_EMBEDDED_PARENT_PID: String(process.pid),
    // Pinned rather than inherited. The runtime derives a caller's default
    // privilege from this, so leaving it to the ambient environment would make
    // the SDK's effective permissions depend on the shell it was launched from.
    ADE_DEFAULT_ROLE: adeDefaultRole,
  };

  const args = ["runtime", "run", "--socket", socketPath, "--profile", "embedded"];
  // A PATH-discovered `ade` may be a .cmd/.bat shim, which Node refuses to
  // spawn directly (CVE-2024-27980). Identity on every other platform/target.
  const invocation = resolveSpawnInvocation(binaryPath, args, childEnv);
  logger(`ade sdk: spawning ${binaryPath} ${args.join(" ")}`);

  let child: ChildProcess;
  try {
    child = spawn(invocation.command, invocation.args, {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      // Keeps the child in this process group so a Ctrl-C in a shell reaches it
      // too. It does NOT make the child die with us — see
      // ADE_EMBEDDED_PARENT_PID above for the mechanism that actually does.
      detached: false,
    });
  } catch (error) {
    throw new AdeError("spawn_failed", `Could not start ${binaryPath}: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  const handle = { kill: () => killChild(child) };
  liveSidecars.add(handle);
  exitHooks.install();

  const stderrTail: string[] = [];
  const pipe = (stream: NodeJS.ReadableStream | null, label: string): void => {
    stream?.setEncoding?.("utf8");
    stream?.on("data", (chunk: string) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        logger(`ade runtime ${label}: ${line}`);
        if (label !== "stderr") continue;
        stderrTail.push(line);
        if (stderrTail.length > 40) stderrTail.shift();
      }
    });
  };
  pipe(child.stdout, "stdout");
  pipe(child.stderr, "stderr");

  // Held in a box rather than a bare `let`: TypeScript cannot see the
  // assignment made inside the exit listener, so a plain variable narrows to
  // `null` for the rest of the function and the fields below stop type-checking.
  const exit: { value: { code: number | null; signal: NodeJS.Signals | null } | null } = {
    value: null,
  };
  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      exit.value = { code, signal };
      releaseSidecar(handle);
      resolve();
    });
  });
  // A spawn failure (EACCES on a non-executable binary, ENOENT on a bad path)
  // surfaces as an "error" event, not a throw. Without capturing it the startup
  // loop would retry a connection to a process that never existed and only give
  // up at the timeout — minutes of silence instead of the real reason.
  const spawnError: { value: Error | null } = { value: null };
  child.once("error", (error) => {
    spawnError.value = error;
    logger(`ade runtime spawn error: ${errorMessage(error)}`);
  });

  const deadline = Date.now() + startupTimeoutMs;
  let delay = CONNECT_RETRY_INITIAL_MS;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    if (spawnError.value) {
      killChild(child);
      releaseSidecar(handle);
      throw new AdeError(
        "spawn_failed",
        `Could not start ${binaryPath}: ${errorMessage(spawnError.value)}`,
        { cause: spawnError.value },
      );
    }
    if (exit.value) {
      throw new AdeError(
        "spawn_failed",
        `The ADE runtime exited during startup (code ${exit.value.code ?? "null"}, signal ${
          exit.value.signal ?? "null"
        }).${stderrTail.length ? `\n${stderrTail.join("\n")}` : ""}`,
      );
    }
    try {
      const connection = await JsonRpcConnection.connect(socketPath);
      // Written only after a successful connect, so the file always names a
      // runtime that actually reached "listening" — a pid recorded for a
      // process that died during startup would be a reclaim target that never
      // existed as a runtime.
      if (child.pid != null) {
        try {
          await writeRuntimePidfile(home, {
            pid: child.pid,
            socketPath,
            parentPid: process.pid,
            startedAt: new Date().toISOString(),
          });
        } catch (error) {
          // Diagnostics and reclaim are both best-effort; a home on a read-only
          // volume should still get a working chat client.
          logger(`ade sdk: could not record the runtime pidfile: ${errorMessage(error)}`);
        }
      }
      return {
        child,
        connection,
        socketPath,
        stop: async () => {
          releaseSidecar(handle);
          if (!exit.value) await stopChild(child, exitPromise);
          // Removed after the child is confirmed gone: a file deleted before
          // the process dies would leave an unreclaimable orphan if the kill
          // then failed.
          await removeRuntimePidfile(home);
        },
      };
    } catch (error) {
      lastError = error;
      if (!isRetryableConnectError(error)) break;
      await sleep(delay);
      delay = Math.min(delay * 2, CONNECT_RETRY_MAX_MS);
    }
  }

  killChild(child);
  releaseSidecar(handle);
  throw new AdeError(
    "connect_failed",
    `The ADE runtime never accepted a connection on ${socketPath}: ${errorMessage(lastError)}${
      stderrTail.length ? `\n${stderrTail.join("\n")}` : ""
    }`,
    { cause: lastError },
  );
}

function isRetryableConnectError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return (
    code === "ENOENT" ||
    code === "ECONNREFUSED" ||
    code === "EAGAIN" ||
    // Windows returns EPIPE/ENOENT while a named pipe exists but has no free
    // instance yet; busy is a normal state during startup, not a failure.
    code === "EPIPE" ||
    code === "EBUSY"
  );
}

/**
 * A unix socket file left behind by a crashed runtime makes `bind()` fail with
 * EADDRINUSE, so a stale endpoint is cleared before the spawn. Only ever a
 * socket file is removed — never a regular file, which would be someone else's
 * data. Windows named pipes have no filesystem entry and need no cleanup.
 */
async function prepareEndpoint(socketPath: string): Promise<void> {
  if (isNamedPipePath(socketPath)) return;
  // 0700 AND owned by us: the tmpdir fallback lands in shared /tmp on Linux,
  // where another local user could otherwise pre-create the directory (and the
  // socket in it) and answer our connect.
  await ensurePrivateSocketDirectory(path.dirname(socketPath));
  try {
    const stat = await fs.promises.lstat(socketPath);
    if (stat.isSocket()) await fs.promises.rm(socketPath, { force: true });
  } catch {
    // Nothing there is the normal case.
  }
}

/**
 * Resolves true if the child exited within `ms`, false if the wait timed out.
 *
 * One spelling for all three waits below. Writing the race inline three times
 * produced three different polarities (`forced`, `exitedOnItsOwn`), which is
 * exactly the shape of bug that inverts a shutdown path silently.
 */
export function waitForExit(exitPromise: Promise<void>, ms: number): Promise<boolean> {
  return Promise.race([exitPromise.then(() => true), sleep(ms).then(() => false)]);
}

/** Seams for the platform branches; production passes none of them. */
export type StopChildOverrides = {
  hardKill?: (child: ChildProcess, platform: NodeJS.Platform) => void;
  gracefulExitMs?: number;
  hardKillWaitMs?: number;
};

export async function stopChild(
  child: ChildProcess,
  exitPromise: Promise<void>,
  platform: NodeJS.Platform = process.platform,
  overrides: StopChildOverrides = {},
): Promise<void> {
  const {
    hardKill = killChild,
    gracefulExitMs = WINDOWS_GRACEFUL_EXIT_MS,
    hardKillWaitMs = SHUTDOWN_GRACE_MS,
  } = overrides;
  if (platform === "win32") {
    // Windows has no signals: `child.kill("SIGTERM")` is TerminateProcess on
    // the LEADER only, so it is neither graceful nor complete — the runtime's
    // own descendants (provider CLIs, node helpers) survive as orphans. The
    // graceful step here is therefore not a signal at all: the caller has
    // already closed the RPC connection, and the child's parent-death watchdog
    // is polling us, so a bounded wait gives it a real chance to unwind itself.
    if (await waitForExit(exitPromise, gracefulExitMs)) return;
    hardKill(child, platform);
    // Bounded, unlike the POSIX branch below: there the escalation is SIGKILL,
    // which the kernel always delivers, so the wait cannot hang. Here it is an
    // out-of-process `taskkill` that can itself fail or be blocked, and a
    // dispose() that never resolves would be worse than a leaked process.
    await waitForExit(exitPromise, hardKillWaitMs);
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  if (await waitForExit(exitPromise, hardKillWaitMs)) return;
  hardKill(child, platform);
  await exitPromise;
}

/**
 * Invocation that ends a process AND its descendants on Windows.
 *
 * POSIX gets this from process groups; Windows has none, so the only way to
 * reach the runtime's children is `taskkill /T`. The executable is resolved
 * through the kernel's SystemRoot alias, not PATH and not `%SystemRoot%` — see
 * windowsSystemTools.ts; this command kills a whole process tree, so who
 * provides it is a security question. Returns null when the tool cannot be
 * trusted, or for a pid that is not safe to pass on (a non-positive pid
 * addresses more than one process on POSIX and is meaningless here).
 */
export function windowsTreeKillInvocation(
  pid: number,
  resolveTool: (tool: "taskkill") => string = resolveTrustedWindowsTool,
): { command: string; args: string[] } | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let command: string;
  try {
    command = resolveTool("taskkill");
  } catch {
    // No trusted taskkill: skip the tree kill rather than run an untrusted one.
    // The leader kill still happens, so this degrades to the old behaviour
    // instead of failing the dispose.
    return null;
  }
  return { command, args: ["/T", "/F", "/PID", String(pid)] };
}

function killChild(child: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  // The pid is captured at spawn time — this never matches by name or path.
  const pid = child.pid;
  if (pid == null) return;
  // A pid whose process has already been reaped is a pid the OS may have handed
  // to somebody else, and `taskkill /T` would take their whole tree with it.
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (platform === "win32") {
    const invocation = windowsTreeKillInvocation(pid);
    if (invocation) {
      try {
        // Synchronous on purpose: this also runs from the `exit` hook, where an
        // async spawn would never get to start.
        spawnSync(invocation.command, invocation.args, {
          stdio: "ignore",
          windowsHide: true,
          timeout: 10_000,
        });
      } catch {
        // Best-effort; the leader kill below still runs.
      }
    }
  }
  try {
    if (!child.killed) child.kill("SIGKILL");
  } catch {
    // Best-effort.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

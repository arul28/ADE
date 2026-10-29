import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { withTimeout } from "../../../../desktop/src/main/services/shared/withTimeout";
import { isEmbeddedAdeRuntime } from "../../../../desktop/src/main/services/shared/processExecution";
import { signalChildProcessTree, terminateChildProcessTree } from "../../../../desktop/src/main/services/shared/utils";
import {
  BRAIN_INHERITED_AGENT_LOCATION_ENV_KEYS,
  BRAIN_INHERITED_CALLER_ENV_KEYS,
} from "../runtime/brainInheritedIdentity";

/**
 * Runs one `ade` command for a remote AI app, as a child of this brain.
 *
 * The CLI is started the way ADE's own `ade` shim starts it (this runtime plus
 * the CLI entry, or the native binary), but directly: no shell and no `.cmd`
 * wrapper, so nothing a model sends is ever parsed as shell or cmd.exe syntax
 * on any platform. `--socket` pins the call to this brain; the CLI never falls
 * back to an in-process runtime.
 */

export const MAX_OUTPUT_BYTES = 200 * 1024;
/** Text a call may pipe to the command's stdin (`files write --stdin`). */
export const MAX_STDIN_BYTES = 256 * 1024;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 2_000;
const ENV_CACHE_MS = 5 * 60_000;

export type RemoteRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  /** Of `durationMs`, how long finding the CLI and building its environment took. */
  launchMs?: number;
};

type Launch = { command: string; prefixArgs: string[]; env: NodeJS.ProcessEnv };

let cachedLaunch: { at: number; launch: Launch } | null = null;

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** How long the start folder's check may take; a hung mount is left to the spawn, as before. */
const CWD_CHECK_BUDGET_MS = 1_000;

/** Whether `cwd` is confirmed not there (missing, or not a folder). Unknown counts as there. */
async function isMissingFolder(cwd: string): Promise<boolean> {
  const check = fs.promises.stat(cwd).then(
    (stat) => !stat.isDirectory(),
    (error: NodeJS.ErrnoException) => error?.code === "ENOENT" || error?.code === "ENOTDIR",
  );
  return (await withTimeout(check, CWD_CHECK_BUDGET_MS)) === true;
}

/** A launcher that needs a shell (`ade.cmd`, `.bat`, `.ps1`): never run. */
const SCRIPT_WRAPPER = /\.(?:cmd|bat|ps1)$/i;

/**
 * The CLI this brain runs, as an absolute path to a file that exists now.
 * Tried in order: the standalone runtime's own executable, the entry the
 * agent environment resolved, its `ade` shim, this process's script, and the
 * standalone `ade` in the ADE home. The agent environment alone came back
 * empty on a brain an update had moved (the activity log's "could not find
 * its own ade command"); the brain's own script and the standalone binary
 * still answer then. A script wrapper (Windows' `ade.cmd` shim) is never a
 * candidate: it would need a shell, so the search goes on past it.
 */
function resolveCliEntry(env: NodeJS.ProcessEnv, isEmbedded: boolean, adeDir: string | null): { entry: string | null; tried: string[] } {
  const script = typeof process.argv[1] === "string" && process.argv[1].trim() ? path.resolve(process.argv[1].trim()) : "";
  const candidates = [
    isEmbedded ? process.execPath : "",
    env.ADE_CLI_ENTRY_PATH?.trim() ?? "",
    env.ADE_CLI_PATH?.trim() ?? "",
    /\.(?:cjs|mjs|js)$/i.test(script) ? script : "",
    adeDir ? path.join(adeDir, "bin", process.platform === "win32" ? "ade.exe" : "ade") : "",
  ].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);
  const runnable = candidates.filter((candidate) => !SCRIPT_WRAPPER.test(candidate));
  const entry = runnable.find((candidate) => path.isAbsolute(candidate) && isFile(candidate)) ?? null;
  // A skipped wrapper is still named, so "could not find" says what was there.
  const tried = candidates.map((candidate) => (SCRIPT_WRAPPER.test(candidate) ? `${candidate} (skipped: script wrapper)` : candidate));
  return { entry, tried };
}

async function resolveLaunch(): Promise<Launch> {
  // An update can replace the files under a cached launch: check it still exists.
  if (cachedLaunch && Date.now() - cachedLaunch.at < ENV_CACHE_MS && isFile(cachedLaunch.launch.prefixArgs[0] ?? cachedLaunch.launch.command)) {
    return cachedLaunch.launch;
  }
  cachedLaunch = null;
  const [{ createHeadlessAdeCliAgentEnv }, { resolveAdeCliShimBrain, packagedCliNodeModulePaths }, { resolveMachineAdeLayout }] = await Promise.all([
    import("../../bootstrap"),
    import("../runtime/adeCliShim"),
    import("../projects/machineLayout"),
  ]);
  const env = createHeadlessAdeCliAgentEnv(process.env);
  // The brain's own location and caller (a brain started from a lane's
  // terminal inherits its ADE_LANE_ID) are not the app's: without --lane, a
  // command must not land in that lane.
  for (const key of [...BRAIN_INHERITED_AGENT_LOCATION_ENV_KEYS, ...BRAIN_INHERITED_CALLER_ENV_KEYS]) delete env[key];
  let adeDir: string | null = null;
  try {
    adeDir = resolveMachineAdeLayout().adeDir;
  } catch {
    adeDir = null;
  }
  const { entry, tried } = resolveCliEntry(env, isEmbeddedAdeRuntime(), adeDir);
  if (!entry) {
    throw new Error(
      `This computer's ADE could not find its own ade command (looked at ${tried.join(", ") || "nothing"}). `
      + "Restarting ADE on it usually fixes this.",
    );
  }
  // What the shim would set: the brain this process is, unless already named.
  const brain = resolveAdeCliShimBrain(process.env);
  if (!env.ADE_HOME && !env.ADE_RUNTIME_SOCKET_PATH) {
    if (brain.adeHome) env.ADE_HOME = brain.adeHome;
    if (brain.socketPath) env.ADE_RUNTIME_SOCKET_PATH = brain.socketPath;
  }
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  env.TERM = "dumb";
  let launch: Launch;
  if (/\.(?:cjs|mjs|js)$/i.test(entry)) {
    env.ELECTRON_RUN_AS_NODE = "1";
    const modulePaths = packagedCliNodeModulePaths(entry);
    if (modulePaths.length) {
      env.NODE_PATH = [...modulePaths, env.NODE_PATH].filter(Boolean).join(path.delimiter);
    }
    launch = { command: process.execPath, prefixArgs: [entry], env };
  } else {
    launch = { command: entry, prefixArgs: [], env };
  }
  cachedLaunch = { at: Date.now(), launch };
  return launch;
}

const running = new Set<ChildProcess>();

/** How many commands connected apps have running right now. */
export function activeRemoteRunCount(): number {
  return running.size;
}

/** Stops every command still running, e.g. when the brain shuts down. */
export function stopAllRemoteRuns(): void {
  for (const child of running) signalChildProcessTree(child, "SIGKILL");
  running.clear();
}

export async function runAdeForRemote(args: {
  argv: string[];
  cwd: string;
  timeoutMs: number;
  connectionId: string;
  /**
   * The role the CLI asserts. Full access runs as the operator, like a
   * person's own terminal; read-only runs as an agent, so the brain's role
   * gates back up the command allowlist. Either way the brain still refuses
   * user-only actions (granting remote access among them) to any CLI.
   */
  role: "cto" | "agent";
  /** The app's name, so turns it sends to a chat can say who sent them. */
  connectionLabel: string;
  /** Piped to the command's stdin; without it, stdin is closed. */
  stdin?: string | null;
  /** Per-stream cap. Typed tools raise it, then trim the parsed JSON themselves. */
  maxOutputBytes?: number;
  /** The answer when `cwd` is not there (a drive unplugged since the project was picked). */
  missingCwdMessage?: string;
}): Promise<RemoteRunResult> {
  const launchStarted = Date.now();
  // Never start in a folder that is not there: the spawn would fail with a
  // misleading "spawn … ENOENT" that names the CLI, not the folder.
  if (await isMissingFolder(args.cwd)) {
    return {
      exitCode: null,
      stdout: "",
      stderr: args.missingCwdMessage ?? `The folder ${args.cwd} isn't on this computer.`,
      timedOut: false,
      truncated: false,
      durationMs: Date.now() - launchStarted,
    };
  }
  const launch = await resolveLaunch();
  const launchMs = Date.now() - launchStarted;
  const started = Date.now();
  const timeoutMs = Math.max(1_000, Math.min(MAX_TIMEOUT_MS, args.timeoutMs));
  const maxOutputBytes = args.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const hasStdin = typeof args.stdin === "string";
  return await new Promise<RemoteRunResult>((resolve) => {
    const child = spawn(launch.command, [...launch.prefixArgs, "--socket", ...args.argv], {
      cwd: args.cwd,
      env: {
        ...launch.env,
        ADE_DEFAULT_ROLE: args.role,
        ADE_REMOTE_MCP_CONNECTION_ID: args.connectionId,
        ADE_REMOTE_MCP_CONNECTION_LABEL: args.connectionLabel,
        // What the connection may run, so `ade help` lists only that.
        ADE_REMOTE_MCP_SCOPE: args.role === "cto" ? "write" : "read",
      },
      stdio: [hasStdin ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      shell: false,
    });
    running.add(child);
    if (hasStdin && child.stdin) {
      // A command that exits without reading its stdin closes the pipe early.
      child.stdin.on("error", () => {});
      child.stdin.end(args.stdin, "utf8");
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const collect = (target: Buffer[], chunk: Buffer, size: number): number => {
      const room = maxOutputBytes - size;
      if (room <= 0) {
        truncated = true;
        return size;
      }
      if (chunk.length > room) {
        truncated = true;
        target.push(chunk.subarray(0, room));
        return maxOutputBytes;
      }
      target.push(chunk);
      return size + chunk.length;
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      outBytes = collect(out, chunk, outBytes);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errBytes = collect(err, chunk, errBytes);
    });
    let killTimer: NodeJS.Timeout | null = null;
    let abandonTimer: NodeJS.Timeout | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM to the group (the CLI was started detached, so it leads one), then SIGKILL.
      killTimer = terminateChildProcessTree(child, null, KILL_GRACE_MS);
      killTimer.unref?.();
      // A descendant that left the group (or that taskkill missed) can keep the
      // pipes open, and then `close` never comes. Stop waiting for it, so the
      // run's slot is freed.
      abandonTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(child.exitCode);
      }, KILL_GRACE_MS * 2);
      abandonTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    const finish = (exitCode: number | null, spawnError?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (abandonTimer) clearTimeout(abandonTimer);
      running.delete(child);
      resolve({
        exitCode,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: spawnError ? `Could not start ade: ${spawnError.message}` : Buffer.concat(err).toString("utf8"),
        timedOut,
        truncated,
        durationMs: Date.now() - started + launchMs,
        launchMs,
      });
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(typeof code === "number" ? code : null));
  });
}

/**
 * The injection seams every provider probe runs through, and the one bounded
 * command runner that spawns a CLI.
 *
 * Separated from `providerStatusProbe.ts` so the two per-provider tables
 * (`providerBinaryResolvers.ts`, `providerAuthResolvers.ts`) and the probe loop
 * can all depend on the seams without depending on each other. Every
 * filesystem, PATH, spawn and process-kill question a resolver asks goes
 * through {@link ProbeContext}, which is what makes a provider's verdict
 * testable without a disk or a child process.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { resolveCliSpawnInvocation, terminateProcessTree } from "../shared/processExecution";
import fs from "node:fs";
import { PROVIDER_OUTPUT_CAP_BYTES } from "./providerStatusDetails";

// ---------------------------------------------------------------------------
// Injection seams
// ---------------------------------------------------------------------------

type StreamLike = { on(event: "data", listener: (chunk: unknown) => void): unknown } | null | undefined;

export type ChildProcessLike = {
  stdout?: StreamLike;
  stderr?: StreamLike;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
  /**
   * The three fields `terminateProcessTree` reads. `pid` is what `taskkill /T`
   * needs to reach the descendants of a `cmd.exe` wrapper; `exitCode` and
   * `signalCode` are its PID-reuse guard, which is why the LIVE child is passed
   * rather than a `{ pid }` snapshot. A test fake supplies a number for `pid`.
   */
  pid?: number | undefined;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
};

/**
 * Kills a probe child and everything it started.
 *
 * Injected so a test can assert the timeout reaches the tree terminator with
 * the live child. Production is `terminateProcessTree`.
 */
export type TerminateTreeLike = (child: ChildProcessLike, signal: NodeJS.Signals) => void;

/**
 * Node's own `spawn`, in the seam's shape.
 *
 * One cast, and it is here rather than at the use site because it is a
 * narrowing, not a coercion: `SpawnLike` accepts fewer option shapes and
 * promises fewer child fields than Node's real signature, so a `ChildProcess`
 * satisfies it in every way that matters and TypeScript still wants the
 * `stdio` tuple spelled its way.
 */
export const defaultSpawn = nodeSpawn as unknown as SpawnLike;

export const defaultTerminateTree: TerminateTreeLike = (child, signal) => {
  terminateProcessTree(
    child as Parameters<typeof terminateProcessTree>[0],
    signal,
  );
};

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: {
    windowsHide: boolean;
    windowsVerbatimArguments?: boolean;
    env: NodeJS.ProcessEnv;
    stdio: readonly ["ignore", "pipe", "pipe"];
  },
) => ChildProcessLike;

export type FsLike = {
  statSync(target: string): { isFile(): boolean; mode: number };
  /**
   * Every filesystem question a resolver asks goes through this seam, so a test
   * can control any provider's verdict without a disk. Pi's credential rung
   * used to reach around it with its own `node:fs` import, which made Pi the
   * one provider whose authenticated verdict `ProviderStatusProbeOptions.fs`
   * could not steer.
   */
  existsSync(target: string): boolean;
};

/** What a per-provider resolver hands back before the common install/version rules run. */
export type ResolvedProviderBinary = {
  /** The path the runtime would use, exactly as the resolver produced it. */
  path: string | null;
  /**
   * The resolver only produced a bare command name and is hoping PATH has it.
   * `findOnPath` decides; without a hit the provider is not installed.
   */
  requiresPathConfirmation?: boolean;
  /** Bare command to look up when `requiresPathConfirmation` is set. */
  command?: string;
  /** Reported as-is when the resolver already knows the version (Pi reads package.json). */
  version?: string | null;
  /** Set when spawning `--version` is wrong for this provider. */
  skipVersionProbe?: boolean;
  /** True when the resolver proved an install without a spawnable binary (Cursor's SDK). */
  installedWithoutBinary?: boolean;
  detail?: string | null;
};

export type ProviderBinaryResolver = (context: ProbeContext) => ResolvedProviderBinary | Promise<ResolvedProviderBinary>;

/** How a provider proved it is signed in, when the probe could tell. */
export type ProviderAuthMethod = "subscription" | "api-key" | "oauth" | "unknown";

export type ProviderAuthResult = {
  authenticated: boolean;
  authMethod: ProviderAuthMethod | null;
  detail?: string | null;
};

/** What the install probe already learned, so a credential rung can use it. */
export type ProviderInstallFacts = {
  installed: boolean;
  binaryPath: string | null;
};

export type ProviderAuthResolver = (
  context: ProbeContext,
  install: ProviderInstallFacts,
) => Promise<ProviderAuthResult>;

export type ProbeContext = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /**
   * The CPU architecture, beside `platform` because availability is decided by
   * the pair. `@cursor/sdk` ships no `win32-arm64` build, and a probe that knew
   * only the platform offered a Windows-on-ARM user a CLI ADE refuses to load.
   */
  arch: NodeJS.Architecture;
  fs: FsLike;
  /**
   * PATH lookup. Takes no platform argument, and this is the one seam that does
   * NOT honour `ProbeContext.platform`.
   *
   * The default implementation is `resolveExecutableFromKnownLocations`, which
   * reads the real `process.platform` in eleven places and has seventy-odd
   * callers outside the probe; threading a platform through it is its own
   * change, not this seam's. Production is correct either way, because
   * `process.platform` and `context.platform` are the same value there. The
   * cost is that a test which sets `platform: "win32"` gets POSIX PATH rules
   * from the default, so any Windows PATHEXT assertion has to inject its own
   * `findOnPath`.
   */
  findOnPath: (command: string, env: NodeJS.ProcessEnv) => string | null;
  spawn: SpawnLike;
  /** Reads a config file, or null when it does not exist or is unreadable. */
  readTextFile: (target: string) => string | null;
  terminateTree: TerminateTreeLike;
};


// ---------------------------------------------------------------------------
// Executable + version helpers
// ---------------------------------------------------------------------------

/**
 * Windows has no execute bit and `chmod` is a no-op there, so a regular file is
 * as executable as the filesystem can say. POSIX keeps the bit check, which is
 * what makes "present but not executable" a real, distinguishable state.
 */
/** Reads a config file, or null when it does not exist or is unreadable. */
export function defaultReadTextFile(target: string): string | null {
  try {
    return fs.readFileSync(target, "utf8");
  } catch {
    return null;
  }
}

export function isExecutableFile(target: string, deps: Pick<ProbeContext, "fs" | "platform">): boolean {
  try {
    const stat = deps.fs.statSync(target);
    if (!stat.isFile()) return false;
    if (deps.platform === "win32") return true;
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function firstVersionLine(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function readStream(stream: StreamLike, onChunk: (text: string) => void): void {
  stream?.on("data", (chunk) => {
    onChunk(typeof chunk === "string" ? chunk : String(chunk));
  });
}

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** The command overran its budget and was killed, or never started. */
  failed: boolean;
};

/**
 * Run one short provider command, bounded and never throwing.
 *
 * A timeout is reported, not raised: a hung CLI is a fact about the machine,
 * not a failure of the RPC. `resolveCliSpawnInvocation` routes a `.cmd`/`.bat`
 * shim through `cmd.exe /d /s /c` and a `.ps1` through PowerShell, because
 * since CVE-2024-27980 Node refuses to spawn a bare shim (`EINVAL`).
 * `windowsHide` keeps a console window from flashing on every status refresh —
 * omitting it is what piled up visible PowerShell windows in the Windows
 * host-loss incident.
 */
export async function runProviderCommand(
  binaryPath: string,
  args: readonly string[],
  context: ProbeContext,
  timeoutMs: number,
): Promise<CommandResult> {
  const invocation = resolveCliSpawnInvocation(binaryPath, [...args], context.env, context.platform);
  return await new Promise<CommandResult>((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child: ChildProcessLike;
    try {
      child = context.spawn(invocation.command, invocation.args, {
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        env: context.env,
        stdio: ["ignore", "pipe", "pipe"] as const,
      });
    } catch {
      resolve({ stdout: "", stderr: "", exitCode: null, failed: true });
      return;
    }

    const timer = setTimeout(() => {
      try {
        // The whole tree, not the leader. On Windows `resolveCliSpawnInvocation`
        // wraps a `.cmd`/`.bat` shim in `cmd.exe /d /s /c`, and every
        // npm-installed provider CLI takes that wrapper. Windows has no process
        // groups, so `child.kill()` is a `TerminateProcess` on `cmd.exe` alone
        // and the real CLI runs on — one leaked process per provider per poll.
        // The live child is passed, not a `{ pid }` snapshot, because
        // `exitCode`/`signalCode` are the terminator's PID-reuse guard.
        context.terminateTree(child, "SIGKILL");
      } catch {
        // The child may already be gone; the timeout result stands either way.
      }
      finish({ stdout, stderr, exitCode: null, failed: true });
    }, timeoutMs);
    // A pending probe must never hold the process open.
    (timer as unknown as { unref?: () => void }).unref?.();

    // Bounded accumulation. A chatty or looping CLI would otherwise allocate
    // freely inside the brain process for the whole timeout window, and no
    // version line or auth verdict is ever found past the first few kilobytes.
    readStream(child.stdout, (text) => {
      if (stdout.length < PROVIDER_OUTPUT_CAP_BYTES) stdout += text;
    });
    readStream(child.stderr, (text) => {
      if (stderr.length < PROVIDER_OUTPUT_CAP_BYTES) stderr += text;
    });
    child.on("error", () => finish({ stdout, stderr, exitCode: null, failed: true }));
    child.on("exit", (code) => finish({ stdout, stderr, exitCode: code, failed: false }));
  });
}

export async function probeVersion(
  binaryPath: string,
  context: ProbeContext,
  timeoutMs: number,
): Promise<string | null> {
  const result = await runProviderCommand(binaryPath, ["--version"], context, timeoutMs);
  // A non-zero exit is not a version. Reporting stdout anyway would print a
  // usage banner into a field a host renders as "v1.2.3".
  if (result.failed || result.exitCode !== 0) return null;
  return firstVersionLine(result.stdout) ?? firstVersionLine(result.stderr);
}


import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_RELEASE_REPO,
  downloadRuntime,
  readChannelMarker,
  resolveRuntimeTarget,
  runtimePaths,
  runtimeSpawnEnv,
  type RuntimeDownloader,
} from "./download.js";
import { AdeError, errorMessage } from "./errors.js";
import { resolveSpawnInvocation } from "./windowsInvocation.js";

const execFileAsync = promisify(execFile);

export type ResolvedBinary = {
  binaryPath: string;
  /**
   * True when the install behind this binary verified a published checksum —
   * either because this call performed the download, or because the cached
   * install's channel marker records that its download did. A pinned path and
   * a PATH discovery are always false: their provenance is the caller's or the
   * system installer's, and this package never checked it.
   */
  checksumVerified: boolean;
  /**
   * Native runtime root to put on NODE_PATH. Null for a binary discovered on
   * PATH or supplied by the caller: those installs carry their own environment
   * (the installer's shim exports it, or the binary is a static build).
   */
  runtimeRoot: string | null;
  source: "option" | "path" | "cache" | "download";
};

export type ResolveBinaryOptions = {
  home: string;
  binaryPath?: string;
  channel?: string;
  repo?: string;
  logger: (line: string) => void;
  download?: RuntimeDownloader;
  /** Set false to skip PATH discovery (tests, hermetic installs). */
  allowPathDiscovery?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
};

/**
 * Resolution order, most explicit first:
 *   1. `binaryPath` — the caller pinned a build; never second-guessed.
 *   2. A previous download cached under `<home>`.
 *   3. An `ade` already installed on PATH.
 *   4. Download the platform runtime into `<home>/bin`.
 *
 * PATH sits below the cache deliberately: once an app has downloaded its own
 * pinned runtime, a developer installing a different `ade` globally must not
 * silently change which binary that app runs.
 */
export async function resolveBinary(options: ResolveBinaryOptions): Promise<ResolvedBinary> {
  const {
    home,
    logger,
    binaryPath,
    channel = "latest",
    repo = DEFAULT_RELEASE_REPO,
    download = downloadRuntime,
    allowPathDiscovery = true,
    env = process.env,
    platform = process.platform,
    arch = process.arch,
  } = options;

  if (binaryPath?.trim()) {
    const resolved = path.resolve(binaryPath.trim());
    if (!fs.existsSync(resolved)) {
      throw new AdeError(
        "binary_not_found",
        `The ADE binary at ${resolved} does not exist.`,
      );
    }
    return { binaryPath: resolved, runtimeRoot: null, source: "option", checksumVerified: false };
  }

  const target = resolveRuntimeTarget(platform, arch);
  const cached = runtimePaths(home, target, platform);
  if (
    fs.existsSync(cached.binaryPath) &&
    fs.existsSync(path.join(cached.runtimeRoot, "node_modules"))
  ) {
    // The verification outcome belongs to the install, so it is read back from
    // the marker that install wrote rather than reported as false. A runtime
    // this SDK downloaded and verified must not be indistinguishable, in
    // doctor(), from one that was never checked.
    return {
      ...cached,
      source: "cache",
      checksumVerified: readChannelMarker(cached.runtimeRoot)?.checksumVerified === true,
    };
  }

  if (allowPathDiscovery) {
    const onPath = findOnPath("ade", env, platform);
    if (onPath) {
      logger(`ade sdk: using the ade already installed at ${onPath}`);
      return { binaryPath: onPath, runtimeRoot: null, source: "path", checksumVerified: false };
    }
  }

  const result = await download({ home, channel, repo, target, logger });
  return {
    binaryPath: result.binaryPath,
    runtimeRoot: result.runtimeRoot,
    source: "download",
    checksumVerified: result.checksumVerified,
  };
}

/**
 * PATH lookup — no shell, no `which`, so it behaves the same on Windows.
 *
 * A candidate must be executable, not merely present. On POSIX an `ade` that is
 * a plain non-executable file (a stray text file, a partially written install,
 * a `pip`-style shim someone lost the +x on) would otherwise win the lookup and
 * fail later at spawn with EACCES, blaming the SDK for a broken PATH entry
 * while a perfectly good `ade` sat in the next directory. `which` skips those;
 * so do we. Windows has no execute bit — extension matching via PATHEXT is the
 * equivalent test there, and `X_OK` degrades to `F_OK`, so the check is
 * POSIX-only.
 */
export function findOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const rawPath = env.PATH ?? env.Path ?? env.path ?? "";
  if (!rawPath) return null;
  const separator = platform === "win32" ? ";" : ":";
  const extensions =
    platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const entry of rawPath.split(separator)) {
    const dir = entry.trim();
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, `${command}${extension}`);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Missing or unreadable entries are simply not matches.
      }
    }
  }
  return null;
}

/** `<binary> --version`, best-effort — used by `doctor()` and download sanity. */
export async function readBinaryVersion(
  binaryPath: string,
  runtimeRoot: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  try {
    const resolvedEnv = runtimeRoot ? runtimeSpawnEnv(runtimeRoot, env) : env;
    // A PATH-discovered `ade` can be a .cmd shim, which Node refuses to execute
    // directly (CVE-2024-27980). Without this, doctor() reported a null version
    // for a perfectly working install.
    const invocation = resolveSpawnInvocation(binaryPath, ["--version"], resolvedEnv);
    const { stdout } = await execFileAsync(invocation.command, invocation.args, {
      env: resolvedEnv,
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    const line = stdout.trim().split(/\r?\n/).pop()?.trim();
    return line || null;
  } catch (error) {
    void errorMessage(error);
    return null;
  }
}

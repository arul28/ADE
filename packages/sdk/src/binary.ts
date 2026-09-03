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
import { resolveBundledRuntime, type BundledRuntime } from "./bundledRuntime.js";
import { AdeError, errorMessage } from "./errors.js";
import { isDirectory, isFile } from "./fsProbe.js";
import { resolveSpawnInvocation } from "./windowsInvocation.js";

const execFileAsync = promisify(execFile);

/**
 * Which of the five resolution steps produced the binary. Reported verbatim on
 * `doctor().runtime.source`, where it is the difference between a five-minute
 * diagnosis of a packaging mistake and a day of one.
 */
export type ResolvedBinarySource =
  | "explicit"
  | "bundled-package"
  | "cached-download"
  | "path"
  | "downloaded";

/**
 * The 0.1.x spelling, kept for `doctor().binary.source`. That field predates the
 * bundled route and is read by shipped support tooling, so it keeps its four
 * values: a bundled package is a build the caller pinned by installing it, and
 * so reads back as `option` there.
 */
export type LegacyResolvedBinarySource = "option" | "path" | "cache" | "download";

export const LEGACY_BINARY_SOURCE: Record<ResolvedBinarySource, LegacyResolvedBinarySource> = {
  explicit: "option",
  "bundled-package": "option",
  "cached-download": "cache",
  path: "path",
  downloaded: "download",
};

export type ResolvedBinary = {
  binaryPath: string;
  /**
   * True when the install behind this binary verified a published checksum —
   * either because this call performed the download, or because the cached
   * install's channel marker records that its download did. A pinned path, a
   * bundled package and a PATH discovery are always false: their provenance is
   * the caller's or the system installer's, and this package never checked it.
   * For a bundled package that is deliberate — a signed bundle is verified by
   * the OS, and re-checking it against a GitHub release would prove nothing
   * about the bytes the embedder actually signed.
   */
  checksumVerified: boolean;
  /**
   * Native runtime root, which becomes `ADE_RUNTIME_ROOT`. Null for a binary
   * discovered on PATH, or supplied by the caller without one: those installs
   * carry their own environment (the installer's shim exports it, or the binary
   * is a static build).
   */
  runtimeRoot: string | null;
  /**
   * Directory that becomes `ADE_RUNTIME_NODE_MODULES`. Usually
   * `<runtimeRoot>/node_modules`, and reported separately because an embedder
   * may relocate the two halves inside their bundle.
   */
  nodeModulesPath: string | null;
  /**
   * Which resolution step produced this binary.
   *
   * The 0.1.x `doctor().binary.source` spelling is NOT stored beside it: it is
   * `LEGACY_BINARY_SOURCE[source]` by construction, so carrying both would give
   * five return sites a pair to keep in step for one consumer's benefit.
   */
  source: ResolvedBinarySource;
};

export type ResolveBinaryOptions = {
  home: string;
  binaryPath?: string;
  /** Explicit `ADE_RUNTIME_NODE_MODULES`. Only meaningful with `binaryPath`. */
  runtimeNodeModules?: string;
  /** Explicit `ADE_RUNTIME_ROOT`. Defaults to the parent of `runtimeNodeModules`. */
  runtimeRoot?: string;
  /** Set false to refuse the network and throw `runtime_unavailable` instead. */
  allowDownload?: boolean;
  channel?: string;
  repo?: string;
  logger: (line: string) => void;
  download?: RuntimeDownloader;
  /** Set false to skip PATH discovery (tests, hermetic installs). */
  allowPathDiscovery?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Injected so the resolution order is table-testable without a filesystem. */
  fileExists?: (candidate: string) => boolean;
  directoryExists?: (candidate: string) => boolean;
  discoverOnPath?: (
    command: string,
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
  ) => string | null;
  resolveBundled?: (options: {
    platform: NodeJS.Platform;
    arch: string;
  }) => BundledRuntime | null;
};

const defaultFileExists = isFile;
const defaultDirectoryExists = isDirectory;

/**
 * Resolution order, most explicit first:
 *   1. `binaryPath` — the caller pinned a build; never second-guessed.
 *   2. An installed `@ade-dev/runtime-<target>` platform package.
 *   3. A previous download cached under `<home>`.
 *   4. An `ade` already installed on PATH.
 *   5. Download the platform runtime into `<home>/bin`.
 *
 * The bundled package sits directly below the pinned path because installing it
 * is itself an explicit act: it is in the embedder's lockfile and inside their
 * signed bundle, and a download must never quietly take precedence over the
 * copy they signed.
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
    runtimeNodeModules,
    runtimeRoot: explicitRuntimeRoot,
    allowDownload = true,
    channel = "latest",
    repo = DEFAULT_RELEASE_REPO,
    download = downloadRuntime,
    allowPathDiscovery = true,
    env = process.env,
    platform = process.platform,
    arch = process.arch,
    fileExists = defaultFileExists,
    directoryExists = defaultDirectoryExists,
    discoverOnPath = findOnPath,
    resolveBundled = (bundleOptions) => resolveBundledRuntime(bundleOptions),
  } = options;

  /** Every step that did not produce a binary, for the `runtime_unavailable` message. */
  const tried: string[] = [];

  if (binaryPath?.trim()) {
    const resolved = path.resolve(binaryPath.trim());
    if (!fileExists(resolved)) {
      throw new AdeError("binary_not_found", `The ADE binary at ${resolved} does not exist.`);
    }
    const explicit = resolveExplicitRuntimeLayout({
      runtimeNodeModules,
      runtimeRoot: explicitRuntimeRoot,
      directoryExists,
    });
    return {
      binaryPath: resolved,
      runtimeRoot: explicit.runtimeRoot,
      nodeModulesPath: explicit.nodeModulesPath,
      source: "explicit",
      checksumVerified: false,
    };
  }
  tried.push("no binaryPath was supplied");

  const bundled = resolveBundled({ platform, arch });
  if (bundled) {
    logger(
      `ade sdk: using the runtime bundled in ${bundled.packageName}` +
        (bundled.version ? `@${bundled.version}` : ""),
    );
    return {
      binaryPath: bundled.binaryPath,
      runtimeRoot: bundled.runtimeRoot,
      nodeModulesPath: bundled.nodeModulesPath,
      source: "bundled-package",
      checksumVerified: false,
    };
  }
  tried.push("no @ade-dev/runtime-* platform package is installed");

  const target = resolveRuntimeTarget(platform, arch);
  const cached = runtimePaths(home, target, platform);
  const cachedNodeModules = path.join(cached.runtimeRoot, "node_modules");
  if (fileExists(cached.binaryPath) && directoryExists(cachedNodeModules)) {
    // The verification outcome belongs to the install, so it is read back from
    // the marker that install wrote rather than reported as false. A runtime
    // this SDK downloaded and verified must not be indistinguishable, in
    // doctor(), from one that was never checked.
    return {
      ...cached,
      nodeModulesPath: cachedNodeModules,
      source: "cached-download",
      checksumVerified: readChannelMarker(cached.runtimeRoot)?.checksumVerified === true,
    };
  }
  tried.push(`no previous download is cached at ${cached.binaryPath}`);

  if (allowPathDiscovery) {
    const onPath = discoverOnPath("ade", env, platform);
    if (onPath) {
      logger(`ade sdk: using the ade already installed at ${onPath}`);
      return {
        binaryPath: onPath,
        runtimeRoot: null,
        nodeModulesPath: null,
        source: "path",
        checksumVerified: false,
      };
    }
    tried.push("no `ade` was found on PATH");
  } else {
    tried.push("PATH discovery is disabled");
  }

  if (!allowDownload) {
    throw new AdeError(
      "runtime_unavailable",
      `No ADE runtime is available for ${target.target} and allowDownload is false, so none was ` +
        `fetched. Tried, in order: ${tried.join("; ")}. Install ` +
        `@ade-dev/runtime-${target.target}, or pass binaryPath (with runtimeNodeModules when the ` +
        `native modules are not beside the binary).`,
    );
  }

  const result = await download({ home, channel, repo, target, logger });
  return {
    binaryPath: result.binaryPath,
    runtimeRoot: result.runtimeRoot,
    nodeModulesPath: path.join(result.runtimeRoot, "node_modules"),
    source: "downloaded",
    checksumVerified: result.checksumVerified,
  };
}

/**
 * The native-module layout that goes with a pinned `binaryPath`.
 *
 * Both directories are checked here rather than at spawn time, because the
 * failure they cause is a dlopen error from inside a child process that names
 * no path. `runtimeRoot` defaults to the parent of `runtimeNodeModules` since
 * that is the layout every ADE installer and the platform packages produce.
 */
function resolveExplicitRuntimeLayout(options: {
  runtimeNodeModules?: string;
  runtimeRoot?: string;
  directoryExists: (candidate: string) => boolean;
}): { runtimeRoot: string | null; nodeModulesPath: string | null } {
  const { directoryExists } = options;
  const nodeModules = options.runtimeNodeModules?.trim();
  const root = options.runtimeRoot?.trim();
  if (!nodeModules && !root) return { runtimeRoot: null, nodeModulesPath: null };

  const resolvedNodeModules = nodeModules
    ? path.resolve(nodeModules)
    : path.join(path.resolve(root as string), "node_modules");
  const resolvedRoot = root ? path.resolve(root) : path.dirname(resolvedNodeModules);

  if (!directoryExists(resolvedNodeModules)) {
    throw new AdeError(
      "binary_not_found",
      `runtimeNodeModules names ${resolvedNodeModules}, which is not a directory. The runtime ` +
        `dlopens its native modules out of that directory and cannot start without it.`,
    );
  }
  if (!directoryExists(resolvedRoot)) {
    throw new AdeError(
      "binary_not_found",
      `runtimeRoot names ${resolvedRoot}, which is not a directory.`,
    );
  }
  return { runtimeRoot: resolvedRoot, nodeModulesPath: resolvedNodeModules };
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
  binary: Pick<ResolvedBinary, "binaryPath" | "runtimeRoot" | "nodeModulesPath">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const { binaryPath, runtimeRoot, nodeModulesPath } = binary;
  try {
    // The sidecar env must be in place before ANY `--version` run: the binary
    // loads its native modules through it, so a preflight without it tests a
    // configuration the real runtime never uses.
    const resolvedEnv = runtimeRoot
      ? runtimeSpawnEnv(runtimeRoot, env, nodeModulesPath ?? undefined)
      : env;
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

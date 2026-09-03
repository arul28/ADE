import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { AdeError, errorMessage } from "./errors.js";
import { resolveTrustedWindowsTool } from "./windowsSystemTools.js";

const execFileAsync = promisify(execFile);

/** Default GitHub repository that publishes the standalone runtime assets. */
export const DEFAULT_RELEASE_REPO = "arul28/ADE";

/**
 * Asset naming and URL scheme, mirrored from
 * `apps/ade-cli/scripts/install-runtime.sh` and `apps/web/api/install.ts`:
 *
 *   https://github.com/<repo>/releases/latest/download/<asset>
 *   https://github.com/<repo>/releases/download/<tag>/<asset>
 *
 * with `<asset>` one of `ade-<platform>-<arch>[.exe]`, the matching
 * `<binary>.native.tar.gz`, and `SHA256SUMS`.
 *
 * The runtime binary alone is NOT runnable: it dlopens native modules out of
 * the archive's `node_modules`, which is why both assets are fetched and why
 * `spawnEnv` below exists.
 */
export type RuntimeTarget = {
  /** e.g. `darwin-arm64`, `linux-x64`, `win32-x64`. */
  target: string;
  binaryAsset: string;
  archiveAsset: string;
};

export type DownloadRequest = {
  /** Directory that receives `bin/ade` and `runtime/<target>/node_modules`. */
  home: string;
  /** Release channel: `latest` (default) or an explicit tag such as `v1.2.69`. */
  channel: string;
  repo: string;
  target: RuntimeTarget;
  logger: (line: string) => void;
  signal?: AbortSignal;
  /**
   * Refuse to install a runtime whose checksum cannot be verified. Defaults to
   * true; set false only for a channel that genuinely publishes no SHA256SUMS.
   */
  requireChecksum?: boolean;
};

export type DownloadResult = {
  /** Absolute path of the installed `ade` binary. */
  binaryPath: string;
  /** Absolute path of the extracted native runtime root. */
  runtimeRoot: string;
  /** True when a checksum from a published SHA256SUMS was verified. */
  checksumVerified: boolean;
};

/**
 * Injectable so tests never touch the network. `createAdeChat` accepts one via
 * the internal options bag; the default is `downloadRuntime`.
 */
export type RuntimeDownloader = (request: DownloadRequest) => Promise<DownloadResult>;

export function resolveRuntimeTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): RuntimeTarget {
  const os =
    platform === "darwin"
      ? "darwin"
      : platform === "linux"
        ? "linux"
        : platform === "win32"
          ? "win32"
          : null;
  if (!os) {
    throw new AdeError("binary_not_found", `ADE has no runtime build for ${platform}.`);
  }
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (!cpu) {
    throw new AdeError("binary_not_found", `ADE has no runtime build for ${arch}.`);
  }
  if (os === "win32" && cpu !== "x64") {
    throw new AdeError("binary_not_found", "ADE only publishes a Windows x64 runtime.");
  }
  const target = `${os}-${cpu}`;
  const binaryAsset = os === "win32" ? `ade-${target}.exe` : `ade-${target}`;
  return { target, binaryAsset, archiveAsset: `${binaryAsset}.native.tar.gz` };
}

export function assetUrl(repo: string, channel: string, asset: string): string {
  const normalized = channel.trim() || "latest";
  return normalized === "latest"
    ? `https://github.com/${repo}/releases/latest/download/${asset}`
    : `https://github.com/${repo}/releases/download/${normalized}/${asset}`;
}

/**
 * Parses a `SHA256SUMS` body into asset -> hex digest.
 *
 * Format is the coreutils one: `<hex>  <name>` (two spaces, or ` *` for the
 * binary marker). Names may carry a directory prefix in some release layouts,
 * so only the basename is keyed — the same normalization the install script's
 * awk does.
 */
export function parseChecksums(body: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([0-9a-fA-F]{64})\s+[*]?(.+)$/.exec(line);
    if (!match) continue;
    const name = path.posix.basename(match[2]!.trim());
    result.set(name, match[1]!.toLowerCase());
  }
  return result;
}

/**
 * Environment a spawned ADE runtime binary needs so it can load the native
 * modules that ship in the archive rather than whatever happens to be on the
 * host's NODE_PATH. Mirrors `set_runtime_env` in install-runtime.sh.
 *
 * `nodeModulesPath` defaults to `<runtimeRoot>/node_modules`, which is the
 * layout every ADE installer produces. An embedder who relocated the two halves
 * inside their bundle passes it explicitly, and it is then used verbatim: the
 * binary resolves `ADE_RUNTIME_NODE_MODULES` on its own, so silently deriving
 * the path would point a signed app at a directory that is not there.
 */
export function runtimeSpawnEnv(
  runtimeRoot: string,
  base: NodeJS.ProcessEnv = process.env,
  nodeModulesPath?: string,
): NodeJS.ProcessEnv {
  const nodeModules = nodeModulesPath?.trim()
    ? path.resolve(nodeModulesPath.trim())
    : path.join(runtimeRoot, "node_modules");
  const previous = base.NODE_PATH?.trim();
  return {
    ...base,
    ADE_RUNTIME_ROOT: runtimeRoot,
    ADE_RUNTIME_NODE_MODULES: nodeModules,
    NODE_PATH: previous ? `${nodeModules}${path.delimiter}${previous}` : nodeModules,
  };
}

/** Layout of a cached download inside the caller's ADE home. */
export function runtimePaths(
  home: string,
  target: RuntimeTarget,
  platform: NodeJS.Platform = process.platform,
): { binaryPath: string; runtimeRoot: string } {
  return {
    binaryPath: path.join(home, "bin", platform === "win32" ? "ade.exe" : "ade"),
    runtimeRoot: path.join(home, "runtime", target.target),
  };
}

/**
 * Fetches, verifies and installs the platform runtime into `<home>/bin` and
 * `<home>/runtime/<target>`, reusing a previous download when one is present.
 */
export const downloadRuntime: RuntimeDownloader = async (request) => {
  const { home, channel, repo, target, logger, signal, requireChecksum = true } = request;
  const { binaryPath, runtimeRoot } = runtimePaths(home, target);

  const cachedMarker = readChannelMarker(runtimeRoot);
  if (
    isUsableCachedRuntime(binaryPath, runtimeRoot) &&
    cachedMarker != null &&
    cachedMarker.channel === channel.trim()
  ) {
    logger(`ade sdk: reusing cached runtime at ${binaryPath}`);
    // The verification outcome is a property of the INSTALL, not of this call.
    // Reporting false for a reuse told doctor() that a checksum-verified
    // runtime was unverified, which is the same answer it gives for a genuinely
    // unverified one — so the distinction the flag exists to carry was lost the
    // moment the cache was hit.
    return { binaryPath, runtimeRoot, checksumVerified: cachedMarker.checksumVerified };
  }

  const staging = path.join(home, "cache", `download-${process.pid}-${Date.now()}`);
  await fs.promises.mkdir(staging, { recursive: true });
  try {
    logger(`ade sdk: downloading ${target.binaryAsset} (${channel}) from ${repo}`);
    const binaryBytes = await fetchAsset(assetUrl(repo, channel, target.binaryAsset), signal);
    const archiveBytes = await fetchAsset(assetUrl(repo, channel, target.archiveAsset), signal);

    // FAIL CLOSED. This writes an executable that is then spawned, so a missing
    // SHA256SUMS is an integrity failure, not a reason to relax: the previous
    // behaviour let anything able to suppress that one file downgrade the whole
    // check to "is it big enough", which a hostile payload passes trivially.
    // The release does publish SHA256SUMS (install-runtime.sh verifies against
    // it), so the absent case is an anomaly, and `requireChecksum: false` is the
    // deliberate, caller-owned opt-out for a channel that genuinely lacks one.
    let checksumVerified = false;
    const checksums = await fetchChecksums(assetUrl(repo, channel, "SHA256SUMS"), signal);
    if (checksums) {
      verifyChecksum(target.binaryAsset, binaryBytes, checksums);
      verifyChecksum(target.archiveAsset, archiveBytes, checksums);
      checksumVerified = true;
    } else if (requireChecksum) {
      throw new AdeError(
        "checksum_mismatch",
        `The ${channel} channel published no SHA256SUMS, so the ADE runtime download could not be verified. ` +
          `Pass requireChecksum: false to install it unverified.`,
      );
    } else {
      // Opted out. A size floor catches a truncated download or an HTML error
      // page; it does NOT establish authenticity, and the flag on the result
      // carries that distinction to doctor() rather than hiding it.
      assertPlausibleSize(target.binaryAsset, binaryBytes);
      assertPlausibleSize(target.archiveAsset, archiveBytes);
      logger(
        `ade sdk: ${channel} published no SHA256SUMS and requireChecksum is off; verified download size only`,
      );
    }

    const stagedBinary = path.join(staging, "ade");
    await fs.promises.writeFile(stagedBinary, binaryBytes, { mode: 0o755 });
    const stagedArchive = path.join(staging, "native.tar.gz");
    await fs.promises.writeFile(stagedArchive, archiveBytes);

    const stagedRuntime = path.join(staging, "runtime");
    await fs.promises.mkdir(stagedRuntime, { recursive: true });
    await extractTarGz(stagedArchive, stagedRuntime);
    if (!fs.existsSync(path.join(stagedRuntime, "node_modules"))) {
      throw new AdeError(
        "download_failed",
        "The ADE native dependency archive is missing node_modules.",
      );
    }

    // Promote with same-directory renames so a crash mid-install never leaves a
    // half-written binary or runtime behind.
    await fs.promises.mkdir(path.dirname(binaryPath), { recursive: true });
    await fs.promises.mkdir(path.dirname(runtimeRoot), { recursive: true });
    await replaceDirectory(stagedRuntime, runtimeRoot);
    await replaceFile(stagedBinary, binaryPath);
    await fs.promises.chmod(binaryPath, 0o755).catch(() => {});

    await writeChannelMarker(runtimeRoot, channel, checksumVerified);

    logger(`ade sdk: installed ADE runtime at ${binaryPath}`);
    return { binaryPath, runtimeRoot, checksumVerified };
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
};

function isUsableCachedRuntime(binaryPath: string, runtimeRoot: string): boolean {
  return (
    fs.existsSync(binaryPath) &&
    fs.existsSync(path.join(runtimeRoot, "node_modules"))
  );
}

async function fetchAsset(url: string, signal?: AbortSignal): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow", ...(signal ? { signal } : {}) });
  } catch (error) {
    throw new AdeError("download_failed", `Could not reach ${url}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new AdeError(
      "download_failed",
      `Downloading ${url} failed with HTTP ${response.status}.`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

async function fetchChecksums(
  url: string,
  signal?: AbortSignal,
): Promise<Map<string, string> | null> {
  try {
    const response = await fetch(url, { redirect: "follow", ...(signal ? { signal } : {}) });
    if (!response.ok) return null;
    const parsed = parseChecksums(await response.text());
    return parsed.size > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function verifyChecksum(
  asset: string,
  bytes: Buffer,
  checksums: Map<string, string>,
): void {
  const expected = checksums.get(asset);
  if (!expected) {
    throw new AdeError("checksum_mismatch", `SHA256SUMS has no entry for ${asset}.`);
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new AdeError(
      "checksum_mismatch",
      `Checksum mismatch for ${asset}: expected ${expected}, got ${actual}.`,
    );
  }
}

/** A truncated download or an HTML error page never reaches this floor. */
const MIN_PLAUSIBLE_ASSET_BYTES = 1024 * 1024;

function assertPlausibleSize(asset: string, bytes: Buffer): void {
  if (bytes.byteLength >= MIN_PLAUSIBLE_ASSET_BYTES) return;
  throw new AdeError(
    "download_failed",
    `${asset} downloaded only ${bytes.byteLength} bytes, which cannot be the ADE runtime.`,
  );
}

/**
 * Node has no bundled tar reader and the package carries no dependencies, so
 * extraction shells out. `tar` is present on macOS and Linux and ships as
 * bsdtar on Windows 10+ — the same assumption install-runtime.sh makes.
 */
async function extractTarGz(archivePath: string, destination: string): Promise<void> {
  try {
    await execFileAsync(tarExecutable(), ["-xzf", archivePath, "-C", destination], {
      maxBuffer: 8 * 1024 * 1024,
      // Without this a packaged Electron app flashes a console window on every
      // extraction.
      windowsHide: true,
    });
  } catch (error) {
    throw new AdeError(
      "download_failed",
      `Could not extract the ADE native dependency archive: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

async function replaceDirectory(from: string, to: string): Promise<void> {
  await removeWithRetry(to, { recursive: true });
  await fs.promises.rename(from, to);
}

async function replaceFile(from: string, to: string): Promise<void> {
  await removeWithRetry(to, {});
  await fs.promises.rename(from, to);
}

/** Retryable on Windows: the file is locked now but usually not for long. */
export const TRANSIENT_REMOVE_ERROR_CODES = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);

export const REMOVE_RETRY_ATTEMPTS = 40;
export const REMOVE_RETRY_DELAY_MS = 250;

export function isTransientRemoveError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code !== undefined && TRANSIENT_REMOVE_ERROR_CODES.has(code);
}

/**
 * Windows keeps a mandatory lock on any file that is open or mapped, and an
 * antivirus scanner opens every freshly written executable. `rm` on the old
 * runtime therefore fails with EPERM/EBUSY for a second or two after an
 * upgrade, and failing the install over that is wrong — the lock is transient.
 * POSIX effectively never hits this path, so the retry costs nothing there.
 */
async function removeWithRetry(
  target: string,
  options: { recursive?: boolean },
  attempts = REMOVE_RETRY_ATTEMPTS,
  delayMs = REMOVE_RETRY_DELAY_MS,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.promises.rm(target, { force: true, ...options });
      return;
    } catch (error) {
      if (attempt >= attempts || !isTransientRemoveError(error)) {
        throw new AdeError(
          "download_failed",
          `Could not replace ${target}: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        timer.unref?.();
      });
    }
  }
}

/**
 * `tar` on Windows is the bundled bsdtar in System32, resolved through the
 * kernel's SystemRoot alias rather than `SystemRoot`/PATH — both are
 * caller-controlled, and this extracts an archive we then execute. There is no
 * fallback: if System32 cannot be reached, `resolveTrustedWindowsTool` throws
 * and the install fails rather than extracting with an unknown tar.
 */
function tarExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? resolveTrustedWindowsTool("tar") : "tar";
}

const CHANNEL_MARKER_NAME = ".ade-sdk-channel";

export type ChannelMarker = {
  channel: string;
  /** Whether the install this marker describes verified a published checksum. */
  checksumVerified: boolean;
};

/**
 * Parses the channel marker.
 *
 * Two formats, because the first shipped as a bare channel line. A marker with
 * no verification field is reported as UNVERIFIED rather than assumed good:
 * "we do not know" and "we checked" must never collapse into the same answer on
 * a provenance flag.
 */
export function parseChannelMarker(raw: string): ChannelMarker | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Partial<ChannelMarker> | null;
      const channel = typeof parsed?.channel === "string" ? parsed.channel.trim() : "";
      if (!channel) return null;
      return { channel, checksumVerified: parsed?.checksumVerified === true };
    } catch {
      return null;
    }
  }
  return { channel: text, checksumVerified: false };
}

export function serializeChannelMarker(marker: ChannelMarker): string {
  return `${JSON.stringify({ channel: marker.channel.trim(), checksumVerified: marker.checksumVerified })}\n`;
}

/**
 * A cached runtime carries the channel it came from, and whether that install
 * was checksum-verified. Without the channel, switching from "latest" to a
 * pinned tag silently kept running the previously downloaded build: the cache
 * check only asked "is a binary present".
 *
 * Returns null when there is no readable marker — written by an older SDK, so
 * the channel is unknown. The caller re-downloads rather than assume; one extra
 * download beats running the wrong build.
 */
export function readChannelMarker(runtimeRoot: string): ChannelMarker | null {
  try {
    return parseChannelMarker(fs.readFileSync(path.join(runtimeRoot, CHANNEL_MARKER_NAME), "utf8"));
  } catch {
    return null;
  }
}

async function writeChannelMarker(
  runtimeRoot: string,
  channel: string,
  checksumVerified: boolean,
): Promise<void> {
  try {
    await fs.promises.writeFile(
      path.join(runtimeRoot, CHANNEL_MARKER_NAME),
      serializeChannelMarker({ channel, checksumVerified }),
      "utf8",
    );
  } catch {
    // Best-effort: a missing marker costs a re-download, never correctness.
  }
}

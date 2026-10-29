import { createHash } from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pipeline } from "node:stream/promises";

/**
 * Shared primitives for reading ADE's published GitHub release assets.
 *
 * Two consumers need the exact same download + SHA256SUMS discipline:
 * `ade brain update` (self-update on the machine running the brain) and the
 * desktop remote-runtime bootstrap (provisioning a *foreign* target over SSH
 * now that desktop bundles ship only their own `ade-<target>` sidecar). Keeping
 * one implementation keeps the redirect/timeout/partial-file rules honest in
 * both places.
 */

/**
 * The five targets every ADE release publishes. This is the single source of
 * truth: the tools cache (`services/tools/paths.ts`) and the brain self-updater
 * (`commands/brainUpdate.ts`) both wrap the detection below rather than keeping
 * their own copy of the list. Keep this module a leaf — it must import nothing
 * but node builtins so either consumer can depend on it without a cycle.
 */
export const RUNTIME_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
] as const;

export type RuntimeTarget = (typeof RUNTIME_TARGETS)[number];

export function isRuntimeTarget(value: string): value is RuntimeTarget {
  return (RUNTIME_TARGETS as readonly string[]).includes(value);
}

export function normalizeRuntimeArch(arch: string): "arm64" | "x64" | null {
  const normalized = arch.trim().toLowerCase();
  if (normalized === "arm64" || normalized === "aarch64") return "arm64";
  if (normalized === "x64" || normalized === "x86_64" || normalized === "amd64") return "x64";
  return null;
}

/**
 * `unsupported-host` = the platform or arch is not one ADE builds for at all;
 * `unsupported-target` = both normalized, but the pair is not published (only
 * `win32-arm64` can reach this today). Callers keep their own error types and
 * distinguish the two so their existing messages stay byte-identical.
 */
export type RuntimeTargetDetection =
  | { ok: true; target: RuntimeTarget }
  | { ok: false; reason: "unsupported-host" }
  | { ok: false; reason: "unsupported-target"; target: string };

export function detectRuntimeTargetResult(platform: string, arch: string): RuntimeTargetDetection {
  const normalizedArch = normalizeRuntimeArch(arch);
  const normalizedPlatform = platform === "darwin" || platform === "linux" || platform === "win32"
    ? platform
    : null;
  if (!normalizedPlatform || !normalizedArch) return { ok: false, reason: "unsupported-host" };
  const target = `${normalizedPlatform}-${normalizedArch}`;
  if (!isRuntimeTarget(target)) return { ok: false, reason: "unsupported-target", target };
  return { ok: true, target };
}

export const RELEASE_CHECKSUMS_ASSET = "SHA256SUMS";
export const DEFAULT_ADE_RELEASE_REPO = "arul28/ADE";
export const RELEASE_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_RELEASE_DOWNLOAD_REDIRECTS = 5;

export class ReleaseAssetDownloadError extends Error {
  readonly url: string;
  readonly statusCode: number | null;

  constructor(message: string, args: { url: string; statusCode?: number | null }) {
    super(message);
    this.name = "ReleaseAssetDownloadError";
    this.url = args.url;
    this.statusCode = args.statusCode ?? null;
  }
}

/**
 * ADE release tags are `v<semver>`. Clients often carry the bare app version
 * (`1.2.74` from the desktop's package version or the update feed), so a bare
 * semver is mapped onto its tag here rather than producing a 404 download URL.
 *
 * This is the official SemVer 2.0.0 pattern, anchored at both ends. Anything
 * that is not a whole, VALID semver is passed through untouched, because
 * prefixing it would request a tag nobody published while the caller's own
 * string may well exist as a custom tag. That rules out both a partial match
 * (`1.2.74foo`) and the near-misses a looser character class would wave
 * through — `01.2.3` (leading zero) and `1.2.3-.` (empty prerelease
 * identifier) are legal custom tag names, not versions to rewrite.
 *
 * The optional prerelease and build segments are deliberate: `1.2.74-beta.1`
 * must still map to `v1.2.74-beta.1`, and ADE does not publish `+build` tags
 * but accepting the segment beats silently rewriting such input.
 */
const BARE_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

export function releaseTagForVersion(version: string): string {
  const trimmed = version.trim();
  return BARE_SEMVER.test(trimmed) ? `v${trimmed}` : trimmed;
}

export function releaseAssetUrl(repo: string, version: string, assetName: string): string {
  const trimmedRepo = repo.trim();
  const trimmedVersion = version.trim();
  if (!trimmedVersion || trimmedVersion === "latest") {
    return `https://github.com/${trimmedRepo}/releases/latest/download/${assetName}`;
  }
  return `https://github.com/${trimmedRepo}/releases/download/${releaseTagForVersion(trimmedVersion)}/${assetName}`;
}

const RELEASE_MANIFEST_FETCH_TIMEOUT_MS = 15_000;

/**
 * Reads a release's `release-manifest.json` (or the Beta feed's `beta.json`).
 * Null for a 404: the file is not there, which callers explain in their own
 * words. Throws on any other failure. The desktop app, the brain and the CLI
 * all read manifests through this one function.
 */
export async function fetchReleaseManifestJson(url: string): Promise<unknown | null> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(RELEASE_MANIFEST_FETCH_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}

/** Canonical published asset name for a runtime binary, e.g. `ade-linux-arm64`. */
export function runtimeBinaryAssetName(target: string): string {
  return `ade-${target}${target.startsWith("win32-") ? ".exe" : ""}`;
}

/** Canonical published asset name for a runtime's native dependency bundle. */
export function runtimeNativeArchiveAssetName(target: string): string {
  return `ade-${target}.native.tar.gz`;
}

function resolveDownloadModule(url: string): typeof https | typeof http {
  if (url.startsWith("https://")) return https;
  if (url.startsWith("http://")) return http;
  throw new ReleaseAssetDownloadError(`Unsupported ADE release asset URL: ${url}`, { url });
}

/**
 * Download `url` to `outPath`, following redirects (never downgrading to
 * plaintext) and leaving no partial file behind on failure.
 */
export async function downloadReleaseAsset(
  url: string,
  outPath: string,
  options: { userAgent?: string; timeoutMs?: number } = {},
): Promise<void> {
  await downloadReleaseAssetInternal(url, outPath, options, 0);
}

async function downloadReleaseAssetInternal(
  url: string,
  outPath: string,
  options: { userAgent?: string; timeoutMs?: number },
  redirects: number,
): Promise<void> {
  if (redirects > MAX_RELEASE_DOWNLOAD_REDIRECTS) {
    throw new ReleaseAssetDownloadError(`Too many redirects while downloading ${url}`, { url });
  }
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.${process.pid}.download`;
  await new Promise<void>((resolve, reject) => {
    const request = resolveDownloadModule(url).get(
      url,
      {
        headers: { "user-agent": options.userAgent ?? "ADE release asset fetcher" },
        timeout: options.timeoutMs ?? RELEASE_DOWNLOAD_TIMEOUT_MS,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          const redirected = new URL(location, url).toString();
          if (url.startsWith("https://") && !redirected.startsWith("https://")) {
            reject(new ReleaseAssetDownloadError(
              `Refusing insecure redirect from ${url} to ${redirected}`,
              { url, statusCode: status },
            ));
            return;
          }
          downloadReleaseAssetInternal(redirected, outPath, options, redirects + 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new ReleaseAssetDownloadError(`Download failed with HTTP ${status}: ${url}`, {
            url,
            statusCode: status,
          }));
          return;
        }
        pipeline(response, fs.createWriteStream(tmp))
          .then(() => fsp.rename(tmp, outPath))
          .then(resolve, reject);
      },
    );
    request.on("timeout", () => {
      request.destroy(new ReleaseAssetDownloadError(`Timed out downloading ${url}`, { url }));
    });
    request.on("error", reject);
  }).catch(async (error) => {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  });
}

/** Parse a `sha256sum`-style manifest into `basename -> lowercase hex digest`. */
export function parseSha256Sums(content: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);
    if (!match) continue;
    sums.set(path.basename(match[2].trim()), match[1].toLowerCase());
  }
  return sums;
}

export function readSha256SumsFile(filePath: string): Map<string, string> {
  return parseSha256Sums(fs.readFileSync(filePath, "utf8"));
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

export function manifestNameForPlatform(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "latest-mac.yml" : "latest.yml";
}

/**
 * Streamed, not buffered: the file this hashes is the ~1 GB desktop installer,
 * and a single allocation that size is an out-of-memory kill mid-install on a
 * small VM or container -- one that grows with every release. The shell code
 * this replaced streamed it too (`[IO.File]::OpenRead` -> `ComputeHash`).
 */
export async function sha512Base64(filePath: string): Promise<string> {
  const hash = createHash("sha512");
  // Fed by hand rather than piped into `hash` as a stream: ending its writable
  // side finalizes the digest internally, and `hash.digest()` would then throw.
  await pipeline(fs.createReadStream(filePath), async (source) => {
    for await (const chunk of source) hash.update(chunk as Uint8Array);
  });
  return hash.digest("base64");
}

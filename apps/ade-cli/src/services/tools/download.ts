import { createHash } from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import https from "node:https";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ToolError } from "./errors";

/** Idle-socket timeout. Matches the ADE brain updater's download budget. */
export const TOOL_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = "ADE agent tools fetcher";

export type ToolDownloadResult = {
  bytes: number;
  /** Streaming digest of what was written, as an SRI string. */
  integrity: string;
  /**
   * Streaming sha256 of what was written, lowercase hex. Present only when the
   * caller asked for it (`sha256: true`), so a custom downloader may omit it and
   * the installer then hashes the file itself.
   */
  sha256?: string;
};

/** The built-in downloader's result when the caller asked for `sha256`. */
export type ToolDownloadResultWithSha256 = ToolDownloadResult & { sha256: string };

export type ToolDownloadProgress = {
  receivedBytes: number;
  totalBytes: number | null;
};

export type ToolDownloadOptions = {
  onProgress?: (progress: ToolDownloadProgress) => void;
  /**
   * Invoked once, as soon as the response headers arrive, with the declared
   * Content-Length. Returning a rejected promise aborts before any body bytes
   * are written — this is where the disk-space preflight runs, because the
   * manifest cannot carry a byte size that npm does not publish in the lockfile.
   */
  onSize?: (totalBytes: number | null) => void | Promise<void>;
  /**
   * Refuse to write past this many bytes. The download aborts with a `network`
   * ToolError on the first chunk that would exceed it, before that chunk is
   * written. File pins pass their pinned size here.
   */
  maxBytes?: number;
  /**
   * Also compute the sha256 of the written bytes. Off by default: npm tarballs
   * are verified by their sha512 SRI alone, so hashing twice would be waste.
   */
  sha256?: boolean;
  /**
   * Refuse any redirect that leaves the host of the first URL. File pins name
   * one vendor host, and a redirect off it is not something ADE will follow.
   */
  sameHostRedirectsOnly?: boolean;
};

export type ToolDownloader = (
  url: string,
  destPath: string,
  options?: ToolDownloadOptions,
) => Promise<ToolDownloadResult>;

/**
 * Stream `url` into `destPath`, hashing as it goes.
 *
 * Writes to a sibling `.part` file and renames only after the body completes,
 * so an interrupted download can never be mistaken for a whole tarball. The
 * `.part` file is removed on every failure path.
 */
export function downloadToolTarball(
  url: string,
  destPath: string,
  options: ToolDownloadOptions & { sha256: true },
): Promise<ToolDownloadResultWithSha256>;
export function downloadToolTarball(
  url: string,
  destPath: string,
  options?: ToolDownloadOptions,
): Promise<ToolDownloadResult>;
export async function downloadToolTarball(
  url: string,
  destPath: string,
  options: ToolDownloadOptions = {},
): Promise<ToolDownloadResult> {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const partPath = `${destPath}.${process.pid}.part`;
  const originHost = options.sameHostRedirectsOnly ? hostOf(url) : null;
  try {
    const result = await streamToFile(url, partPath, options, 0, originHost);
    await fsp.rename(partPath, destPath);
    return result;
  } catch (error) {
    await fsp.rm(partPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function networkError(message: string, cause?: unknown): ToolError {
  return new ToolError(message, { kind: "network", cause });
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

async function streamToFile(
  url: string,
  partPath: string,
  options: ToolDownloadOptions,
  redirects: number,
  originHost: string | null,
): Promise<ToolDownloadResult> {
  if (redirects > MAX_REDIRECTS) {
    throw networkError(`Too many redirects while downloading ${url}`);
  }
  if (!url.startsWith("https://")) {
    throw networkError(`Refusing to download ADE agent tools over a non-HTTPS URL: ${url}`);
  }

  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { "user-agent": USER_AGENT }, timeout: TOOL_DOWNLOAD_IDLE_TIMEOUT_MS },
      resolve,
    );
    request.on("timeout", () => {
      request.destroy(networkError(`Timed out connecting to ${url}`));
    });
    request.on("error", (error) => reject(networkError(`Download failed for ${url}: ${error.message}`, error)));
  });

  const status = response.statusCode ?? 0;
  const location = response.headers.location;
  if (status >= 300 && status < 400 && location) {
    response.resume();
    const redirected = new URL(location, url).toString();
    if (!redirected.startsWith("https://")) {
      throw networkError(`Refusing insecure redirect from ${url} to ${redirected}`);
    }
    if (originHost !== null && hostOf(redirected) !== originHost) {
      throw networkError(`Refusing redirect from ${url} to ${redirected}: this download must stay on ${originHost}.`);
    }
    return await streamToFile(redirected, partPath, options, redirects + 1, originHost);
  }
  if (status !== 200) {
    response.resume();
    throw networkError(`Download failed with HTTP ${status}: ${url}`);
  }

  const declared = Number.parseInt(String(response.headers["content-length"] ?? ""), 10);
  const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : null;
  try {
    await options.onSize?.(totalBytes);
  } catch (error) {
    response.destroy();
    throw error;
  }

  const hash = createHash("sha512");
  const sha256 = options.sha256 ? createHash("sha256") : null;
  let receivedBytes = 0;
  const sink = fs.createWriteStream(partPath);
  // Counts and hashes each chunk before it reaches the file. A chunk that would
  // take the body past `maxBytes` fails the stream here, so nothing past the
  // pinned size is ever written; `pipeline` then tears down the response and sink.
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (options.maxBytes !== undefined && receivedBytes + chunk.length > options.maxBytes) {
        callback(networkError(
          `Download of ${url} is larger than the ${options.maxBytes} bytes pinned for it.`,
        ));
        return;
      }
      receivedBytes += chunk.length;
      hash.update(chunk);
      sha256?.update(chunk);
      options.onProgress?.({ receivedBytes, totalBytes });
      callback(null, chunk);
    },
  });
  // Idle-socket enforcement for the body, not just the handshake: a stalled
  // CDN that holds the connection open must not hang an install forever.
  response.setTimeout(TOOL_DOWNLOAD_IDLE_TIMEOUT_MS, () => {
    response.destroy(networkError(`Timed out receiving ${url}`));
  });

  try {
    await pipeline(response, guard, sink);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOSPC") {
      throw new ToolError(`Ran out of disk space while downloading ${url}.`, {
        kind: "disk-space",
        cause: error,
      });
    }
    throw networkError(`Download failed for ${url}`, error);
  }

  if (totalBytes !== null && receivedBytes !== totalBytes) {
    throw networkError(`Truncated download for ${url}: expected ${totalBytes} bytes, got ${receivedBytes}.`);
  }

  return {
    bytes: receivedBytes,
    integrity: `sha512-${hash.digest("base64")}`,
    ...(sha256 ? { sha256: sha256.digest("hex") } : {}),
  };
}

/** Streaming sha512 of an existing file, as an SRI string. */
export async function fileIntegrity(filePath: string): Promise<string> {
  return `sha512-${await fileDigest(filePath, "sha512", "base64")}`;
}

/** Streaming sha256 of an existing file, as lowercase hex. */
export async function fileSha256(filePath: string): Promise<string> {
  return await fileDigest(filePath, "sha256", "hex");
}

async function fileDigest(filePath: string, algorithm: "sha256" | "sha512", encoding: "hex" | "base64"): Promise<string> {
  const hash = createHash(algorithm);
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest(encoding);
}

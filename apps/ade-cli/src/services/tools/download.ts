import { createHash } from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import https from "node:https";
import path from "node:path";
import { ToolError } from "./errors";

/** Idle-socket timeout. Matches the ADE brain updater's download budget. */
export const TOOL_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = "ADE agent tools fetcher";

export type ToolDownloadResult = {
  bytes: number;
  /** Streaming digest of what was written, as an SRI string. */
  integrity: string;
};

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
export const downloadToolTarball: ToolDownloader = async (url, destPath, options = {}) => {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const partPath = `${destPath}.${process.pid}.part`;
  try {
    const result = await streamToFile(url, partPath, options, 0);
    await fsp.rename(partPath, destPath);
    return result;
  } catch (error) {
    await fsp.rm(partPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

function networkError(message: string, cause?: unknown): ToolError {
  return new ToolError(message, { kind: "network", cause });
}

async function streamToFile(
  url: string,
  partPath: string,
  options: ToolDownloadOptions,
  redirects: number,
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
    return await streamToFile(redirected, partPath, options, redirects + 1);
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
  let receivedBytes = 0;
  const sink = fs.createWriteStream(partPath);

  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown) => {
      response.destroy();
      sink.destroy();
      reject(error instanceof ToolError ? error : networkError(`Download failed for ${url}`, error));
    };
    // Idle-socket enforcement for the body, not just the handshake: a stalled
    // CDN that holds the connection open must not hang an install forever.
    response.setTimeout(TOOL_DOWNLOAD_IDLE_TIMEOUT_MS, () => {
      fail(networkError(`Timed out receiving ${url}`));
    });
    response.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      receivedBytes += chunk.length;
      options.onProgress?.({ receivedBytes, totalBytes });
    });
    response.on("error", fail);
    sink.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOSPC") {
        response.destroy();
        sink.destroy();
        reject(new ToolError(`Ran out of disk space while downloading ${url}.`, {
          kind: "disk-space",
          cause: error,
        }));
        return;
      }
      fail(error);
    });
    sink.on("finish", resolve);
    response.pipe(sink);
  });

  if (totalBytes !== null && receivedBytes !== totalBytes) {
    throw networkError(`Truncated download for ${url}: expected ${totalBytes} bytes, got ${receivedBytes}.`);
  }

  return { bytes: receivedBytes, integrity: `sha512-${hash.digest("base64")}` };
};

/** Streaming sha512 of an existing file, as an SRI string. */
export async function fileIntegrity(filePath: string): Promise<string> {
  const hash = createHash("sha512");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return `sha512-${hash.digest("base64")}`;
}

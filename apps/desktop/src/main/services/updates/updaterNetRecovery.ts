/**
 * electron-updater fetches the feed through Chromium's `net` module, on one
 * session it caches for the life of the process. That session can stop
 * working while the machine is online: every request then fails with
 * `net::ERR_FAILED` a few milliseconds after it starts, and only a relaunch
 * used to clear it. These helpers tell that apart from a real outage by asking
 * Node's own HTTP stack, which shares nothing with Chromium's, and hand the
 * updater a fresh session when Node gets through.
 */

const FEED_PROBE_TIMEOUT_MS = 8_000;
/** A channel file is a few hundred bytes; this only bounds a wrong answer. */
const FEED_PROBE_MAX_CHARS = 64 * 1024;
/** electron-builder channel files open with the release they describe. */
const CHANNEL_FILE_PATTERN = /^version:\s*\S+/m;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown");
}

/** A failure raised by Chromium's network stack (`net::ERR_*`). */
export function isChromiumNetError(error: unknown): boolean {
  return /\bnet::ERR_[A-Z0-9_]+/.test(errorMessage(error));
}

/** The channel file electron-updater reads for this platform. */
export function updateFeedChannelFile(
  platform: NodeJS.Platform,
  arch: string = process.arch,
): string {
  if (platform === "darwin") return "latest-mac.yml";
  if (platform === "linux") return arch === "x64" ? "latest-linux.yml" : `latest-linux-${arch}.yml`;
  return "latest.yml";
}

/**
 * The channel file's URL on the configured feed: the generic override when
 * one is set (dev only), otherwise the GitHub release of `repository`.
 */
export function buildUpdateFeedProbeUrl(args: {
  platform: NodeJS.Platform;
  repository: string;
  genericFeedUrl?: string | null;
}): string | null {
  const file = updateFeedChannelFile(args.platform);
  const genericFeedUrl = args.genericFeedUrl?.trim().replace(/\/+$/, "");
  if (genericFeedUrl) return `${genericFeedUrl}/${file}`;
  const repository = args.repository.trim().replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return null;
  return `https://github.com/${repository}/releases/latest/download/${file}`;
}

export type UpdateFeedProbeResult = {
  /**
   * The feed answered with a real channel file. A 404, a 5xx or a captive
   * portal's sign-in page means the feed itself is unavailable, which a fresh
   * Chromium session cannot fix, so none of them count.
   */
  reachable: boolean;
  url: string;
  status: number | null;
  elapsedMs: number;
  error: string | null;
};

/** At most `maxChars` of the body, without buffering the rest of it. */
async function readBounded(response: Response, maxChars: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  while (text.length < maxChars) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  void reader.cancel().catch(() => {});
  return text.slice(0, maxChars);
}

/** Requests the feed with Node's fetch, never Chromium's. Never rejects. */
export async function probeUpdateFeed(url: string): Promise<UpdateFeedProbeResult> {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(FEED_PROBE_TIMEOUT_MS),
    });
    const body = response.ok ? await readBounded(response, FEED_PROBE_MAX_CHARS) : "";
    void response.body?.cancel().catch(() => {});
    const isChannelFile = CHANNEL_FILE_PATTERN.test(body);
    return {
      reachable: response.ok && isChannelFile,
      url,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      error: !response.ok ? `HTTP ${response.status}` : isChannelFile ? null : "not an update channel file",
    };
  } catch (error) {
    return { reachable: false, url, status: null, elapsedMs: Date.now() - startedAt, error: errorMessage(error) };
  }
}

type NetSessionExecutor = { cachedSession: unknown };

function netSessionExecutor(updater: unknown): NetSessionExecutor | null {
  const executor = updater && typeof updater === "object"
    ? (updater as { httpExecutor?: unknown }).httpExecutor
    : null;
  return executor && typeof executor === "object" && "cachedSession" in executor
    ? executor as NetSessionExecutor
    : null;
}

/** True when the updater fetches through electron-updater's ElectronHttpExecutor. */
export function canReplaceUpdaterNetSession(updater: unknown): boolean {
  return netSessionExecutor(updater) != null;
}

/**
 * Points the updater's executor at a new in-memory session. The executor only
 * creates a session while `cachedSession` is null, and the feed provider holds
 * this same executor, so the next request of every kind uses the new one. The
 * old partition cannot be reused: `fromPartition` returns the same session for
 * the same name.
 */
export function replaceUpdaterNetSession(updater: unknown, partition: string): boolean {
  const executor = netSessionExecutor(updater);
  if (!executor || typeof require !== "function") return false;
  try {
    // Resolved through require for the same reason as the native updater in
    // autoUpdateService: tests mock "electron" as `{ app }`.
    const electron = require("electron") as {
      session?: { fromPartition?: (partition: string, options: { cache: boolean }) => unknown };
    };
    const fresh = electron.session?.fromPartition?.(partition, { cache: false });
    if (!fresh) return false;
    executor.cachedSession = fresh;
    return true;
  } catch {
    return false;
  }
}

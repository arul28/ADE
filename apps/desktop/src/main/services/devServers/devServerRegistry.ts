import type { DevServerRecord, DevServersArgs } from "../../../shared/types";

/**
 * Passive dev-server discovery.
 *
 * Every terminal chunk already flows through one place in `ptyService`
 * (`processOutputData`), so this module rides that pass rather than adding a
 * second observer: one bounded regex over the chunk plus a small carry for the
 * line that got split across a chunk boundary. Nothing here opens a socket or
 * makes a request — a dev server is "discovered" only because the user's own
 * command printed its address.
 *
 * The registry is a plain in-memory map with no persistence: a port that was
 * live last week says nothing about this app session, and resurrecting one
 * would make ADE navigate somewhere the user never started.
 */

/** Matches the ready lines every common dev server prints. */
const DEV_SERVER_URL_PATTERN =
  /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::(\d{2,5}))?(?:\/[^\s"'`<>]*)?/gi;

/**
 * Lines that mean "a server is up". A bare URL in a log line (a docs link, a
 * stack frame, an npm advisory) is not enough on its own — the chunk has to
 * look like a server announcing itself.
 */
const READY_LINE_PATTERN =
  /(^|[\s│|>*-])(local(?:host)?\s*:|ready\s+(?:on|in|at)|listening\s+(?:on|at)|server\s+(?:running|started|listening)|running\s+at|started\s+server\s+on|available\s+on|app\s+running\s+at|preview\s*:|network\s*:|➜)/i;

/** A single output chunk can be huge (a `cat` of a log); bound the scan. */
const MAX_SCAN_CHARS = 8_000;
/** Carry for a ready line split across two PTY chunks. */
const MAX_CARRY_CHARS = 512;
/** Ports below this are almost never a user's dev server. */
const MIN_DEV_SERVER_PORT = 1_024;

const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;

export type DevServerDetection = {
  port: number;
  url: string;
};

/** Strips ANSI so a colourized `➜  Local:   http://localhost:5173/` still matches. */
function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

function defaultPortForProtocol(protocol: string): number {
  return protocol === "https:" ? 443 : 80;
}

/**
 * Finds dev-server URLs in one chunk of terminal output.
 *
 * Pure and synchronous so it can be unit-tested without a PTY. Callers that
 * stream should keep the returned `carry` and prepend it to the next chunk so a
 * URL split across a chunk boundary is still found exactly once.
 */
export function detectDevServersInChunk(
  chunk: string,
  carry = "",
): { detections: DevServerDetection[]; carry: string } {
  const text = stripAnsi(`${carry}${chunk}`).slice(-MAX_SCAN_CHARS);
  const lines = text.split(/\r?\n/);
  // The final segment may be a half-written line; hold it back for next time
  // rather than matching a truncated URL.
  const nextCarry = (lines.pop() ?? "").slice(-MAX_CARRY_CHARS);
  const detections: DevServerDetection[] = [];
  const seen = new Set<number>();
  for (const line of lines) {
    if (!READY_LINE_PATTERN.test(line)) continue;
    DEV_SERVER_URL_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DEV_SERVER_URL_PATTERN.exec(line)) != null) {
      const parsed = safeUrl(match[0]);
      if (!parsed) continue;
      const port = parsed.port ? Number(parsed.port) : defaultPortForProtocol(parsed.protocol);
      if (!Number.isInteger(port) || port < MIN_DEV_SERVER_PORT || port > 65_535) continue;
      if (seen.has(port)) continue;
      seen.add(port);
      // Normalize the wildcard host: 0.0.0.0 is not reachable as a URL on
      // Windows and reads badly in a tab strip.
      if (parsed.hostname === "0.0.0.0" || parsed.hostname === "[::1]" || parsed.hostname === "::1") {
        parsed.hostname = "localhost";
      }
      detections.push({ port, url: parsed.toString() });
    }
  }
  return { detections, carry: nextCarry };
}

function safeUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

export type DevServerRegistry = ReturnType<typeof createDevServerRegistry>;

/** Keyed by `${laneId}:${port}` so two lanes can serve the same port. */
function registryKey(laneId: string | null, port: number): string {
  return `${laneId ?? ""}:${port}`;
}

export function createDevServerRegistry(options: { maxEntries?: number } = {}) {
  const maxEntries = Math.max(1, options.maxEntries ?? 64);
  const records = new Map<string, DevServerRecord>();
  const listeners = new Set<(record: DevServerRecord) => void>();

  return {
    /**
     * Records a detection. Returns the record when it is new (or has moved to a
     * different URL/session), and `null` when it is a repeat — callers use that
     * to fire "once per (lane, port)" side effects without their own bookkeeping.
     */
    record(input: {
      port: number;
      url: string;
      sessionId?: string | null;
      laneId?: string | null;
      /**
       * The detecting terminal's project. Only the caller knows it — a lane id
       * is not resolvable to a project anywhere downstream — and consumers
       * route the detection by it, so it is captured here and never re-derived.
       */
      projectRoot?: string | null;
      detectedAt?: string;
    }): DevServerRecord | null {
      if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) return null;
      const laneId = input.laneId?.trim() || null;
      const key = registryKey(laneId, input.port);
      const previous = records.get(key) ?? null;
      const next: DevServerRecord = {
        port: input.port,
        url: input.url,
        source: {
          sessionId: input.sessionId?.trim() || null,
          laneId,
          projectRoot: input.projectRoot?.trim() || null,
        },
        detectedAt: input.detectedAt ?? new Date().toISOString(),
      };
      records.set(key, next);
      if (records.size > maxEntries) {
        const oldest = records.keys().next();
        if (!oldest.done && oldest.value !== key) records.delete(oldest.value);
      }
      if (previous && previous.url === next.url && previous.source.sessionId === next.source.sessionId) {
        return null;
      }
      for (const listener of [...listeners]) {
        try {
          listener(next);
        } catch {
          // A bad subscriber must not break terminal output processing.
        }
      }
      return next;
    },
    list(args: DevServersArgs = {}): DevServerRecord[] {
      const laneId = args.laneId?.trim() || null;
      return [...records.values()]
        .filter((record) => (laneId ? record.source.laneId === laneId : true))
        .sort((left, right) => right.detectedAt.localeCompare(left.detectedAt));
    },
    /** Forgets everything a terminal session discovered (session closed). */
    forgetSession(sessionId: string): void {
      for (const [key, record] of [...records.entries()]) {
        if (record.source.sessionId === sessionId) records.delete(key);
      }
    },
    onDetected(listener: (record: DevServerRecord) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear(): void {
      records.clear();
    },
  };
}

/**
 * Process-wide registry. The PTY pipeline writes, the browser service and the
 * `localhost.getDevServers` IPC read; a singleton keeps the two from having to
 * be constructed in a particular order during main-process boot.
 */
export const devServerRegistry = createDevServerRegistry();

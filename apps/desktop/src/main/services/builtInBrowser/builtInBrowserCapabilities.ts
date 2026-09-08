import path from "node:path";
import { resolvePathWithinRoot } from "../shared/utils";
import type {
  BuiltInBrowserNetworkHeader,
  BuiltInBrowserNetworkLogArgs,
  BuiltInBrowserNetworkLogEntry,
} from "../../../shared/types";

/**
 * Pure helpers behind the browser capability surface (zoom, the opt-in full
 * network log, HAR export and upload-path validation). Kept free of Electron so
 * the interesting rules — clamping, redaction, HAR shape, allowed upload roots —
 * are unit-testable without a live `WebContentsView`.
 */

export const BUILT_IN_BROWSER_MIN_ZOOM_FACTOR = 0.25;
export const BUILT_IN_BROWSER_MAX_ZOOM_FACTOR = 5;
export const BUILT_IN_BROWSER_DEFAULT_ZOOM_FACTOR = 1;

export const BUILT_IN_BROWSER_NETWORK_LOG_CAPACITY = 500;
export const BUILT_IN_BROWSER_DEFAULT_NETWORK_LOG_LIMIT = 50;
export const BUILT_IN_BROWSER_MAX_NETWORK_LOG_LIMIT = BUILT_IN_BROWSER_NETWORK_LOG_CAPACITY;
export const BUILT_IN_BROWSER_OBSERVATION_NETWORK_LOG_LIMIT = 10;

export const BUILT_IN_BROWSER_REDACTED_HEADER_VALUE = "[redacted by ADE]";

/**
 * Credential-bearing headers whose values never reach an observation, a HAR
 * file, or a chat transcript. The global browser profile is authenticated, so a
 * verbatim network log would otherwise hand an agent live session cookies and
 * bearer tokens for every site the human is signed into.
 */
export const BUILT_IN_BROWSER_REDACTED_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  // `location` carries the OAuth `code` on every IdP redirect, which is the
  // whole sign-in in one header; the other two are the same class of secret.
  "location",
  "www-authenticate",
  "x-csrf-token",
]);

/**
 * Query parameters whose value is a credential rather than a request detail.
 *
 * Redacting only headers left the bigger hole open: an IdP callback, a
 * magic-link, and a presigned URL all carry the secret in the query string, and
 * a HAR export explodes every parameter into the file by name and value.
 */
export const BUILT_IN_BROWSER_REDACTED_QUERY_PARAMS: ReadonlySet<string> = new Set([
  "code",
  "access_token",
  "id_token",
  "token",
  "state",
  "session",
  "sig",
  "signature",
  "api_key",
  "refresh_token",
  "client_secret",
]);

export function isRedactedBuiltInBrowserQueryParam(name: string): boolean {
  return BUILT_IN_BROWSER_REDACTED_QUERY_PARAMS.has(name.trim().toLowerCase());
}

/**
 * Same URL with credential-bearing query values replaced. Returns the input
 * unchanged when it does not parse or carries nothing to redact, so a log entry
 * never turns into `"[redacted by ADE]"` wholesale and lose its identity.
 */
export function redactBuiltInBrowserUrl(url: string): string {
  if (!url.includes("?")) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  let changed = false;
  for (const name of [...parsed.searchParams.keys()]) {
    if (!isRedactedBuiltInBrowserQueryParam(name)) continue;
    parsed.searchParams.set(name, BUILT_IN_BROWSER_REDACTED_HEADER_VALUE);
    changed = true;
  }
  return changed ? parsed.toString() : url;
}

export function clampBuiltInBrowserZoomFactor(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Browser zoom factor must be a finite number.");
  }
  return Math.min(
    BUILT_IN_BROWSER_MAX_ZOOM_FACTOR,
    Math.max(BUILT_IN_BROWSER_MIN_ZOOM_FACTOR, value),
  );
}

export function isRedactedBuiltInBrowserHeader(name: string): boolean {
  return BUILT_IN_BROWSER_REDACTED_HEADERS.has(name.trim().toLowerCase());
}

export function normalizeBuiltInBrowserHeaders(
  raw: unknown,
): BuiltInBrowserNetworkHeader[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const headers: BuiltInBrowserNetworkHeader[] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalizedName = name.trim();
    if (!normalizedName) continue;
    const redacted = isRedactedBuiltInBrowserHeader(normalizedName);
    headers.push({
      name: normalizedName,
      value: redacted
        ? BUILT_IN_BROWSER_REDACTED_HEADER_VALUE
        : stringifyHeaderValue(value),
      redacted,
    });
  }
  return headers;
}

function stringifyHeaderValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(", ");
  if (value == null) return "";
  return String(value);
}

/** Bounded per-tab request log. Oldest entries fall off the front. */
export function createBuiltInBrowserNetworkLog(
  capacity = BUILT_IN_BROWSER_NETWORK_LOG_CAPACITY,
) {
  let entries: BuiltInBrowserNetworkLogEntry[] = [];
  let droppedCount = 0;
  return {
    get size(): number {
      return entries.length;
    },
    get droppedCount(): number {
      return droppedCount;
    },
    push(entry: BuiltInBrowserNetworkLogEntry): void {
      entries.push(entry);
      if (entries.length > capacity) {
        droppedCount += entries.length - capacity;
        entries = entries.slice(-capacity);
      }
    },
    /** Updates an existing entry in place, or appends when it is new. */
    upsert(entry: BuiltInBrowserNetworkLogEntry): void {
      const index = entries.findIndex((existing) => existing.id === entry.id);
      if (index >= 0) {
        entries[index] = entry;
        return;
      }
      this.push(entry);
    },
    find(id: string): BuiltInBrowserNetworkLogEntry | null {
      return entries.find((entry) => entry.id === id) ?? null;
    },
    list(): BuiltInBrowserNetworkLogEntry[] {
      return [...entries];
    },
    clear(): void {
      entries = [];
      droppedCount = 0;
    },
  };
}

export type BuiltInBrowserNetworkLogStore = ReturnType<typeof createBuiltInBrowserNetworkLog>;

export function normalizeNetworkLogLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return BUILT_IN_BROWSER_DEFAULT_NETWORK_LOG_LIMIT;
  }
  const rounded = Math.floor(value);
  if (rounded <= 0) return BUILT_IN_BROWSER_DEFAULT_NETWORK_LOG_LIMIT;
  return Math.min(BUILT_IN_BROWSER_MAX_NETWORK_LOG_LIMIT, rounded);
}

export function filterBuiltInBrowserNetworkLog(
  entries: readonly BuiltInBrowserNetworkLogEntry[],
  args: Pick<BuiltInBrowserNetworkLogArgs, "filter" | "failedOnly"> = {},
): BuiltInBrowserNetworkLogEntry[] {
  const needle = typeof args.filter === "string" ? args.filter.trim().toLowerCase() : "";
  return entries.filter((entry) => {
    if (args.failedOnly && !isFailedNetworkEntry(entry)) return false;
    if (!needle) return true;
    const haystack = [
      entry.method ?? "",
      entry.url,
      entry.status == null ? "" : String(entry.status),
      entry.mimeType ?? "",
      entry.resourceType ?? "",
      entry.error ?? "",
    ].join(" ").toLowerCase();
    return haystack.includes(needle);
  });
}

export function isFailedNetworkEntry(entry: BuiltInBrowserNetworkLogEntry): boolean {
  return Boolean(entry.error) || (entry.status != null && entry.status >= 400);
}

/* ── HAR 1.2 ──────────────────────────────────────────────────────────────── */

export type BuiltInBrowserHarLog = {
  log: {
    version: "1.2";
    creator: { name: string; version: string };
    pages: Array<{
      startedDateTime: string;
      id: string;
      title: string;
      pageTimings: { onContentLoad: number; onLoad: number };
    }>;
    entries: unknown[];
  };
};

export function buildBuiltInBrowserHar(args: {
  entries: readonly BuiltInBrowserNetworkLogEntry[];
  pageUrl: string | null;
  pageTitle: string | null;
  creatorVersion: string;
  exportedAt: string;
}): BuiltInBrowserHarLog {
  const pageId = "page_1";
  const pageStartedDateTime = args.entries[0]?.timings.startedAt ?? args.exportedAt;
  return {
    log: {
      version: "1.2",
      creator: { name: "ADE built-in browser", version: args.creatorVersion },
      pages: [
        {
          startedDateTime: pageStartedDateTime,
          id: pageId,
          title: args.pageTitle ?? args.pageUrl ?? "ADE browser tab",
          pageTimings: { onContentLoad: -1, onLoad: -1 },
        },
      ],
      entries: args.entries.map((entry) => harEntry(entry, pageId)),
    },
  };
}

function harEntry(entry: BuiltInBrowserNetworkLogEntry, pageId: string): Record<string, unknown> {
  const waitMs = entry.timings.waitMs ?? -1;
  const receiveMs = entry.timings.receiveMs ?? -1;
  const totalMs = entry.timings.durationMs ?? (waitMs >= 0 && receiveMs >= 0 ? waitMs + receiveMs : -1);
  return {
    pageref: pageId,
    startedDateTime: entry.timings.startedAt,
    time: totalMs,
    request: {
      method: entry.method ?? "GET",
      url: entry.url,
      httpVersion: entry.protocol ?? "HTTP/1.1",
      cookies: [],
      headers: harHeaders(entry.requestHeaders),
      queryString: harQueryString(entry.url),
      headersSize: -1,
      bodySize: entry.requestBodySize ?? -1,
    },
    response: {
      status: entry.status ?? 0,
      statusText: entry.statusText ?? "",
      httpVersion: entry.protocol ?? "HTTP/1.1",
      cookies: [],
      headers: harHeaders(entry.responseHeaders),
      content: {
        size: entry.responseBodySize ?? -1,
        mimeType: entry.mimeType ?? "",
      },
      redirectURL: "",
      headersSize: entry.responseHeaderSize ?? -1,
      bodySize: entry.responseBodySize ?? -1,
    },
    cache: entry.fromCache ? { beforeRequest: null, afterRequest: null } : {},
    timings: {
      send: 0,
      wait: waitMs,
      receive: receiveMs,
    },
    ...(entry.error ? { comment: `error: ${entry.error}` } : {}),
  };
}

function harHeaders(headers: readonly BuiltInBrowserNetworkHeader[]): Array<{ name: string; value: string }> {
  return headers.map((header) => ({ name: header.name, value: header.value }));
}

function harQueryString(url: string): Array<{ name: string; value: string }> {
  try {
    const parsed = new URL(url);
    return [...parsed.searchParams.entries()].map(([name, value]) => ({
      name,
      value: isRedactedBuiltInBrowserQueryParam(name) ? BUILT_IN_BROWSER_REDACTED_HEADER_VALUE : value,
    }));
  } catch {
    return [];
  }
}

/* ── Upload path validation ───────────────────────────────────────────────── */

/**
 * `uploadFile` hands real filesystem paths to a page's `<input type=file>`, so
 * a bad target would exfiltrate arbitrary files to whatever site the tab is on.
 * Only the project worktree, its `.ade/tmp` scratch dir, the tab's observation
 * cache, and the OS temp dir are allowed, and each candidate must resolve
 * inside one of them.
 */
export function builtInBrowserUploadRoots(args: {
  projectRoot: string | null;
  observationRoot: string | null;
  tmpDir: string;
}): string[] {
  const roots = new Set<string>();
  const add = (value: string | null | undefined): void => {
    if (typeof value !== "string" || !value.trim()) return;
    roots.add(path.resolve(value));
  };
  add(args.projectRoot);
  if (args.projectRoot) add(path.join(args.projectRoot, ".ade", "tmp"));
  add(args.observationRoot);
  add(args.tmpDir);
  return [...roots];
}

/**
 * Resolve every candidate against the real filesystem layout and keep only the
 * ones that land inside an allowed root.
 *
 * The containment check has to realpath: an agent can write inside the project
 * root by design, so `ln -s ~/.ssh/id_ed25519 .ade/tmp/report.txt` would pass a
 * lexical `path.relative` test and upload the private key to whatever origin
 * the tab is on. `resolvePathWithinRoot` walks the candidate segment by segment
 * through `realpath`, and is the same helper the rest of the main process uses
 * (it also handles the Windows `\\?\` spellings a hand-rolled compare misses).
 *
 * Returns the resolved real paths, which are what CDP is handed.
 */
export function resolveBuiltInBrowserUploadPaths(
  rawPaths: readonly unknown[],
  roots: readonly string[],
): string[] {
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
    throw new Error("Browser upload requires at least one file path.");
  }
  if (roots.length === 0) {
    throw new Error("Browser upload is unavailable because no allowed file root is configured.");
  }
  const normalizedRoots = roots.map((root) => path.resolve(root));
  return rawPaths.map((value) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("Browser upload paths must be non-empty strings.");
    }
    if (value.includes("\0")) {
      throw new Error("Browser upload paths cannot contain null bytes.");
    }
    const candidate = value.trim();
    for (const root of normalizedRoots) {
      try {
        // `allowMissing` keeps the "not a readable file" error at the caller,
        // where it names the path; a missing root just fails this root.
        return resolvePathWithinRoot(root, candidate, { allowMissing: true });
      } catch {
        // Outside this root (or the root does not exist) — try the next one.
      }
    }
    throw new Error(
      `Browser upload path is outside the allowed roots (${normalizedRoots.join(", ")}): ${path.resolve(candidate)}`,
    );
  });
}

/* ── Recording ────────────────────────────────────────────────────────────── */

export const BUILT_IN_BROWSER_RECORDING_FPS_OPTIONS = [30, 60] as const;

export type BuiltInBrowserRecordingFps = (typeof BUILT_IN_BROWSER_RECORDING_FPS_OPTIONS)[number];

/**
 * Wall-clock cap on a single recording, enforced by the session's own timer.
 *
 * A recording is a `getDisplayMedia` capture of a live tab writing to the
 * project's scratch dir; an agent that forgets to call `stopRecording` (or dies
 * mid-run) would otherwise capture until the app quits. Five minutes is long
 * enough for any "show me this flow" and short enough that the forgotten case
 * costs a bounded file.
 *
 * What the caller sees when it fires: the recording is finalized exactly as a
 * `stopRecording` would have finalized it — same file, same manifest — and the
 * agent is told through two channels rather than a return value it never
 * asked for. A `recording` event carries `endedBy: "max_duration"` (so the
 * pane can say why the REC pill vanished), and a `stopRecording`-shaped entry
 * with the same `endedBy` lands in the tab's action trace, which is where the
 * skill tells an agent to look. A later `stopRecording` then throws
 * `Browser tab <id> is not recording.` A login hand-off is the other automatic
 * ending (`endedBy: "handoff"`), and unlike this one it ABORTS rather than
 * finalizes — see `suspendAgentCaptureForHandoff`. Neither resumes; an agent
 * that wants more has to start a new recording.
 *
 * CHANGING THE NUMBER: the pane's "5-minute limit reached" toast carries its own
 * copy of this value (`renderer/components/chat/browserToolbarLabels.ts`) because
 * this module is main-process-only and the cap is not on the wire. Change both.
 */
export const BUILT_IN_BROWSER_MAX_RECORDING_MS = 5 * 60_000;

/** Frame budget the wall-clock cap implies at the highest supported rate. */
export const BUILT_IN_BROWSER_MAX_RECORDING_FRAMES =
  (BUILT_IN_BROWSER_MAX_RECORDING_MS / 1_000) * Math.max(...BUILT_IN_BROWSER_RECORDING_FPS_OPTIONS);

const RECORDING_FPS_ERROR = `Browser recording fps must be ${BUILT_IN_BROWSER_RECORDING_FPS_OPTIONS.join(" or ")}.`;

export function normalizeBuiltInBrowserRecordingFps(value: unknown): BuiltInBrowserRecordingFps {
  if (value == null) return BUILT_IN_BROWSER_RECORDING_FPS_OPTIONS[0];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(RECORDING_FPS_ERROR);
  }
  const rounded = Math.round(value);
  const match = BUILT_IN_BROWSER_RECORDING_FPS_OPTIONS.find((option) => option === rounded);
  if (match == null) throw new Error(RECORDING_FPS_ERROR);
  return match;
}

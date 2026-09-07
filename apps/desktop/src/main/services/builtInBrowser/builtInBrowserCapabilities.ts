import path from "node:path";
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
]);

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
    return [...parsed.searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

/* ── Upload path validation ───────────────────────────────────────────────── */

/**
 * `uploadFile` hands real filesystem paths to a page's `<input type=file>`, so
 * a bad target would exfiltrate arbitrary files to whatever site the tab is on.
 * Only the project worktree, ADE's own scratch dirs, and the OS temp dir are
 * allowed, and each candidate must resolve inside one of them.
 */
export function builtInBrowserUploadRoots(args: {
  projectRoot: string | null;
  observationRoot: string | null;
  adeHome: string | null;
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
  if (args.adeHome) add(path.join(args.adeHome, "tmp"));
  add(args.tmpDir);
  return [...roots];
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "") return true;
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return !relative.split(path.sep).includes("..");
}

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
    const resolved = path.resolve(value.trim());
    const allowed = normalizedRoots.some((root) => isPathInsideRoot(root, resolved));
    if (!allowed) {
      throw new Error(
        `Browser upload path is outside the allowed roots (${normalizedRoots.join(", ")}): ${resolved}`,
      );
    }
    return resolved;
  });
}

/* ── Recording ────────────────────────────────────────────────────────────── */

export const BUILT_IN_BROWSER_RECORDING_FPS_OPTIONS = [30, 60] as const;
export const BUILT_IN_BROWSER_MAX_RECORDING_FRAMES = 60 * 60 * 5; // ~5 min at 60fps

export function normalizeBuiltInBrowserRecordingFps(value: unknown): 30 | 60 {
  if (value == null) return 30;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Browser recording fps must be 30 or 60.");
  }
  const rounded = Math.round(value);
  if (rounded !== 30 && rounded !== 60) {
    throw new Error("Browser recording fps must be 30 or 60.");
  }
  return rounded;
}

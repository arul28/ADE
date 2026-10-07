import type {
  AppControlConsoleDiagnostic,
  AppControlNetworkDiagnostic,
} from "../../../shared/types";
import {
  isRecord,
  normalizePositiveInteger,
  optionalFiniteNumber,
  stringOrNull,
} from "../../../shared/agentObservationNormalizers";
import type { CdpCommandChannel } from "./cdpClient";
import { nowIso } from "./utils";

/**
 * Console, network and main-frame navigation tracking for one CDP page, as the
 * agent action engine's `observe` / `wait` read it.
 *
 * Shared by App Control (a page-level connection to the app under test) and the
 * user-browser attachment (a flattened session on the user's own tab). The two
 * deliberately keep different policies — which console levels count, whether
 * `Log.entryAdded` and uncaught exceptions are captured, how values print, which
 * field wins when a failed request names two URLs — so each one is an explicit
 * option rather than a default either caller silently inherits.
 */

export type CdpPendingRequest = {
  url: string;
  method: string | null;
  resourceType: string | null;
  startedAt: string;
  startedAtMs: number;
};

export type CdpPageDiagnosticsSink = {
  pushConsole: (entry: AppControlConsoleDiagnostic) => void;
  pushNetwork: (entry: AppControlNetworkDiagnostic) => void;
  /** Requests in flight; the caller owns it so it can count and clear it. */
  pendingRequests: Map<string, CdpPendingRequest>;
  /** Any request started or settled (the idle clock `wait` reads). */
  noteNetworkActivity: () => void;
  /** The top-level frame committed a new document. */
  onMainFrameNavigated: (frame: { url: string | null }) => void;
};

export type CdpPageDiagnosticsOptions = {
  /** Console levels kept from `Runtime.consoleAPICalled`; every level when absent. */
  consoleLevels?: ReadonlySet<AppControlConsoleDiagnostic["level"]>;
  /**
   * How a non-string console argument prints: `"json"` stringifies a by-value
   * argument before falling back to its description; `"description"` prints
   * the description only.
   */
  consoleValues: "json" | "description";
  /** Capture `Log.entryAdded` (browser-side messages) and enable the Log domain. */
  logEntries: boolean;
  /** Capture `Runtime.exceptionThrown` as console errors. */
  exceptions: boolean;
  /**
   * Which side names a failed request's URL and resource type when both do:
   * the event (`"event-first"`) or the request recorded when it started
   * (`"request-first"`).
   */
  failedRequestFields: "event-first" | "request-first";
  /** Whether an HTTP 4xx/5xx response resets the network idle clock. */
  httpErrorIsActivity: boolean;
  /** Pending requests kept before the oldest is dropped (streams never settle). */
  maxPendingRequests: number;
};

const MAX_CONSOLE_MESSAGE_CHARS = 2_000;

function consoleLevel(value: unknown): AppControlConsoleDiagnostic["level"] {
  const raw = typeof value === "string" ? value.toLowerCase() : "";
  if (raw === "error" || raw === "assert") return "error";
  if (raw === "warning" || raw === "warn") return "warning";
  if (raw === "debug" || raw === "verbose") return "debug";
  return "info";
}

/** Subscribe `channel`'s page events into `sink`, and enable the domains they need. */
export function subscribeCdpPageDiagnostics(
  channel: CdpCommandChannel,
  sink: CdpPageDiagnosticsSink,
  options: CdpPageDiagnosticsOptions,
): void {
  const keepsLevel = (level: AppControlConsoleDiagnostic["level"]): boolean =>
    !options.consoleLevels || options.consoleLevels.has(level);
  const pick = <T,>(fromEvent: T | null, fromRequest: T | null): T | null =>
    options.failedRequestFields === "event-first"
      ? fromEvent ?? fromRequest
      : fromRequest ?? fromEvent;

  channel.on("Runtime.consoleAPICalled", (params) => {
    if (!isRecord(params)) return;
    const level = consoleLevel(params.type);
    if (!keepsLevel(level)) return;
    const message = (Array.isArray(params.args) ? params.args : [])
      .map((entry) => {
        if (!isRecord(entry)) return "";
        if (typeof entry.value === "string") return entry.value;
        if (options.consoleValues === "json" && entry.value !== undefined) return JSON.stringify(entry.value);
        return stringOrNull(entry.description) ?? "";
      })
      .filter(Boolean)
      .join(" ")
      .slice(0, MAX_CONSOLE_MESSAGE_CHARS);
    if (!message) return;
    sink.pushConsole({ level, message, sourceId: null, line: null, column: null, timestamp: nowIso() });
  });

  if (options.logEntries) {
    channel.on("Log.entryAdded", (params) => {
      const entry = isRecord(params) && isRecord(params.entry) ? params.entry : null;
      if (!entry) return;
      const message = stringOrNull(entry.text);
      if (!message) return;
      const level = consoleLevel(entry.level);
      if (!keepsLevel(level)) return;
      sink.pushConsole({
        level,
        message: message.slice(0, MAX_CONSOLE_MESSAGE_CHARS),
        sourceId: stringOrNull(entry.url),
        line: normalizePositiveInteger(entry.lineNumber),
        column: null,
        timestamp: nowIso(),
      });
    });
  }

  if (options.exceptions) {
    channel.on("Runtime.exceptionThrown", (params) => {
      const details = isRecord(params) && isRecord(params.exceptionDetails) ? params.exceptionDetails : null;
      if (!details || !keepsLevel("error")) return;
      const exception = isRecord(details.exception) ? details.exception : null;
      const message = stringOrNull(exception?.description) ?? stringOrNull(details.text) ?? "Uncaught exception";
      sink.pushConsole({
        level: "error",
        message: message.slice(0, MAX_CONSOLE_MESSAGE_CHARS),
        sourceId: stringOrNull(details.url),
        line: typeof details.lineNumber === "number" ? details.lineNumber + 1 : null,
        column: typeof details.columnNumber === "number" ? details.columnNumber + 1 : null,
        timestamp: nowIso(),
      });
    });
  }

  channel.on("Network.requestWillBeSent", (params) => {
    if (!isRecord(params)) return;
    const requestId = stringOrNull(params.requestId);
    const request = isRecord(params.request) ? params.request : {};
    const url = stringOrNull(request.url);
    if (!requestId || !url) return;
    sink.noteNetworkActivity();
    // A long-lived page can start requests that never emit a finished/failed
    // event (streams, aborted sockets). Bound the map so the pending count
    // stays meaningful and the session cannot leak entries.
    if (sink.pendingRequests.size >= options.maxPendingRequests) {
      const oldest = sink.pendingRequests.keys().next();
      if (!oldest.done) sink.pendingRequests.delete(oldest.value);
    }
    sink.pendingRequests.set(requestId, {
      url,
      method: stringOrNull(request.method),
      resourceType: stringOrNull(params.type),
      startedAt: nowIso(),
      startedAtMs: Date.now(),
    });
  });

  const settle = (requestId: string | null): CdpPendingRequest | null => {
    sink.noteNetworkActivity();
    if (!requestId) return null;
    const pending = sink.pendingRequests.get(requestId) ?? null;
    sink.pendingRequests.delete(requestId);
    return pending;
  };

  const failure = (
    pending: CdpPendingRequest | null,
    fields: { url: string | null; resourceType: string | null; statusCode: number | null; error: string | null },
  ): AppControlNetworkDiagnostic => ({
    url: pick(fields.url, pending?.url ?? null) ?? "about:blank",
    method: pending?.method ?? null,
    resourceType: pick(fields.resourceType, pending?.resourceType ?? null),
    statusCode: fields.statusCode,
    error: fields.error,
    startedAt: pending?.startedAt ?? null,
    endedAt: nowIso(),
    durationMs: pending ? Math.max(0, Date.now() - pending.startedAtMs) : null,
  });

  channel.on("Network.responseReceived", (params) => {
    if (!isRecord(params)) return;
    const response = isRecord(params.response) ? params.response : {};
    const statusCode = optionalFiniteNumber(response.status);
    if (statusCode == null || statusCode < 400) {
      sink.noteNetworkActivity();
      return;
    }
    if (options.httpErrorIsActivity) sink.noteNetworkActivity();
    // The request stays pending: its body is still loading.
    const requestId = stringOrNull(params.requestId);
    const pending = requestId ? sink.pendingRequests.get(requestId) ?? null : null;
    sink.pushNetwork(failure(pending, {
      url: stringOrNull(response.url),
      resourceType: stringOrNull(params.type),
      statusCode,
      error: null,
    }));
  });

  channel.on("Network.loadingFinished", (params) => {
    settle(isRecord(params) ? stringOrNull(params.requestId) : null);
  });

  channel.on("Network.loadingFailed", (params) => {
    if (!isRecord(params)) return;
    const pending = settle(stringOrNull(params.requestId));
    if (params.canceled === true) return;
    sink.pushNetwork(failure(pending, {
      url: null,
      resourceType: stringOrNull(params.type),
      statusCode: null,
      error: stringOrNull(params.errorText) ?? "Request failed.",
    }));
  });

  channel.on("Page.frameNavigated", (params) => {
    // Main frame only: an iframe swapping documents is not a new page, and
    // clearing the diagnostics on one would hide errors the page just logged.
    const frame = isRecord(params) && isRecord(params.frame) ? params.frame : null;
    if (!frame || stringOrNull(frame.parentId)) return;
    sink.onMainFrameNavigated({ url: stringOrNull(frame.url) });
  });

  // Best effort: a target that refuses one of these still serves input and
  // screenshots, it just reports fewer diagnostics.
  void channel.send("Runtime.enable").catch(() => {});
  if (options.logEntries) void channel.send("Log.enable").catch(() => {});
  void channel.send("Network.enable").catch(() => {});
}

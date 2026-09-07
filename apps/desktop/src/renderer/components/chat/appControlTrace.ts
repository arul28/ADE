/**
 * Pure formatting helpers for the App Control panel's trace surfaces.
 *
 * Kept dependency-free (no React, no `window`) so the bottom status line, the
 * trace drawer and the tests all read the same rules, and so "what does this
 * row say" can be asserted without rendering a panel.
 */

import type {
  AppControlActionTraceEntry,
  AppControlDiagnostics,
  AppControlElementSnapshot,
} from "../../../shared/types";
import { parseObservationElementHandle } from "../../../shared/agentObservation";

/** ①..⑳ (U+2460..U+2473). Past that a badge reads better as a plain number. */
const CIRCLED_ONE = 0x2460;
const MAX_CIRCLED = 20;

/**
 * The glyph for an observation element index (1-based). The circled digits are
 * what the overlay paints, so the trace line and the badge on screen have to
 * agree — read "click ① Sign in" and look for ① in the frame.
 */
export function observeBadgeGlyph(index: number): string {
  if (!Number.isFinite(index) || index < 1) return "?";
  const rounded = Math.floor(index);
  if (rounded > MAX_CIRCLED) return String(rounded);
  return String.fromCharCode(CIRCLED_ONE + rounded - 1);
}

/** The 1-based element index a handle points at, or null when it is not one. */
export function observeIndexForHandle(handle: string | null | undefined): number | null {
  if (typeof handle !== "string" || !handle) return null;
  return parseObservationElementHandle(handle)?.index ?? null;
}

/** "840ms" under a second, "1.2s" up to a minute, "1m 04s" beyond it. */
export function formatTraceDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "—";
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  const seconds = durationMs / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

/**
 * Relative age of a trace entry. Deliberately coarse: the drawer is scanned,
 * not read, and a ticking "37s ago" would repaint the whole list every second.
 */
export function formatRelativeTime(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const deltaMs = Math.max(0, nowMs - at);
  if (deltaMs < 5_000) return "just now";
  if (deltaMs < 60_000) return `${Math.floor(deltaMs / 1_000)}s ago`;
  if (deltaMs < 3_600_000) return `${Math.floor(deltaMs / 60_000)}m ago`;
  if (deltaMs < 86_400_000) return `${Math.floor(deltaMs / 3_600_000)}h ago`;
  return `${Math.floor(deltaMs / 86_400_000)}d ago`;
}

const ACTION_LABELS: Record<string, string> = {
  click: "click",
  hover: "hover",
  fill: "fill",
  clear: "clear",
  type: "type",
  press: "press",
  scroll: "scroll",
  wait: "wait",
  observe: "observe",
};

/** Sentence-case, house style: an action name is a verb, never SHOUTED. */
export function traceActionLabel(action: string): string {
  const normalized = (action || "").trim().toLowerCase();
  return ACTION_LABELS[normalized] ?? (normalized || "action");
}

function trimTo(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function stringField(target: Record<string, unknown> | null, key: string): string | null {
  const value = target?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberField(target: Record<string, unknown> | null, key: string): number | null {
  const value = target?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * What the agent aimed at, in the most human form the trace actually carries.
 * A handle wins because it is the one identifier the user can also see on the
 * frame; coordinates lose because they say the least.
 */
export function traceTargetLabel(
  entry: AppControlActionTraceEntry,
  elements: AppControlElementSnapshot[] = [],
): string {
  const target = entry.target;
  const handle = stringField(target, "handle");
  const handleIndex = observeIndexForHandle(handle) ?? numberField(target, "elementIndex");
  if (handleIndex != null && handleIndex >= 1) {
    const match = elements.find((element) => element.index === handleIndex);
    const name = match ? elementSummary(match) : null;
    return name ? `${observeBadgeGlyph(handleIndex)} ${trimTo(name, 40)}` : observeBadgeGlyph(handleIndex);
  }
  const testId = stringField(target, "testId");
  if (testId) return trimTo(testId, 40);
  const text = stringField(target, "text");
  if (text) return `"${trimTo(text, 36)}"`;
  const selector = stringField(target, "selector");
  if (selector) return trimTo(selector, 40);
  const key = stringField(target, "key");
  if (key) return key;
  const url = stringField(target, "url");
  if (url) return trimTo(url.replace(/^https?:\/\//, ""), 40);
  const x = numberField(target, "x");
  const y = numberField(target, "y");
  if (x != null && y != null) return `${Math.round(x)}, ${Math.round(y)}`;
  const deltaY = numberField(target, "deltaY");
  if (deltaY != null) return `${deltaY > 0 ? "down" : "up"} ${Math.abs(Math.round(deltaY))}`;
  const textLength = numberField(target, "textLength") ?? numberField(target, "valueLength");
  if (textLength != null) return `${textLength} chars`;
  return "—";
}

/** The short human name for an observed element, or null when it has none. */
export function elementSummary(element: AppControlElementSnapshot): string | null {
  const candidate = element.label
    ?? element.text
    ?? element.placeholder
    ?? element.value
    ?? element.testId
    ?? element.role
    ?? element.tagName;
  if (!candidate) return null;
  const trimmed = candidate.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type TraceRow = {
  id: string;
  action: string;
  target: string;
  duration: string;
  relative: string;
  failed: boolean;
  error: string | null;
};

/** One drawer row: action, target, duration, status. Failed rows carry why. */
export function formatTraceRow(
  entry: AppControlActionTraceEntry,
  nowMs: number,
  elements: AppControlElementSnapshot[] = [],
): TraceRow {
  return {
    id: entry.id,
    action: traceActionLabel(entry.action),
    target: traceTargetLabel(entry, elements),
    duration: formatTraceDuration(entry.durationMs),
    relative: formatRelativeTime(entry.endedAt, nowMs),
    failed: entry.status === "error",
    error: entry.error,
  };
}

/**
 * The bottom row's one-liner: `last: click ① Sign in · 1.2s`. Returns null with
 * no trace so the caller can render a hint instead of an empty label.
 */
export function formatLastActionLine(
  entry: AppControlActionTraceEntry | null | undefined,
  nowMs: number,
  elements: AppControlElementSnapshot[] = [],
): string | null {
  if (!entry) return null;
  const row = formatTraceRow(entry, nowMs, elements);
  const target = row.target === "—" ? "" : ` ${row.target}`;
  const failed = row.failed ? " · failed" : "";
  return `last: ${row.action}${target} · ${row.duration}${failed}`;
}

/** Console errors worth surfacing. Warnings are noise at this size. */
export function countConsoleErrors(diagnostics: AppControlDiagnostics | null | undefined): number {
  if (!diagnostics) return 0;
  return diagnostics.console.filter((entry) => entry.level === "error").length;
}

/** A request counts as failed when it errored or came back 4xx/5xx. */
export function countNetworkFailures(diagnostics: AppControlDiagnostics | null | undefined): number {
  if (!diagnostics) return 0;
  return diagnostics.network.filter((entry) => (
    Boolean(entry.error) || (typeof entry.statusCode === "number" && entry.statusCode >= 400)
  )).length;
}

/**
 * Where an agent cursor should fly for a trace entry, in CSS viewport pixels.
 * Prefers the observed element's own centre over the raw coordinates the agent
 * passed, because the element is what the user can see on the frame.
 */
export function traceCursorPoint(
  entry: AppControlActionTraceEntry,
  elements: AppControlElementSnapshot[] = [],
): { x: number; y: number } | null {
  const target = entry.target;
  const handleIndex = observeIndexForHandle(stringField(target, "handle"))
    ?? numberField(target, "elementIndex");
  if (handleIndex != null) {
    const match = elements.find((element) => element.index === handleIndex);
    if (match) return { x: match.center.x, y: match.center.y };
  }
  const selector = stringField(target, "selector");
  const testId = stringField(target, "testId");
  if (selector || testId) {
    const match = elements.find((element) => (
      (selector != null && element.selector === selector)
      || (testId != null && element.testId === testId)
    ));
    if (match) return { x: match.center.x, y: match.center.y };
  }
  const x = numberField(target, "x");
  const y = numberField(target, "y");
  if (x != null && y != null) return { x, y };
  return null;
}

/** Trace actions that are worth animating a cursor for. */
export const CURSOR_TRACE_ACTIONS = new Set(["click", "hover", "fill"]);

/**
 * Normalizers for the values `AGENT_DOM_COLLECTOR_FUNCTION` hands back, and
 * the trace-target redactor that decides what an agent may read back about its
 * own action.
 *
 * The built-in browser and App Control evaluate the *same* collector, so they
 * get the same untrusted `unknown` shapes out of CDP and need the same
 * validation. Keeping one copy here also keeps one redaction rule: a forked
 * `actionTargetForTrace` had already drifted, so typing an API key wrote a
 * `textLength` on one surface and the key itself on the other.
 *
 * Dependency-free (no Electron, no node built-ins) so the Electron-hosted
 * browser and the headless-daemon App Control service can both import it.
 */

import { formatObservationElementHandle } from "./agentObservation";
import type {
  AgentDomSnapshot,
  AgentElementSnapshot,
  AgentFrame,
} from "./types/agentObservation";

/** Structural subset of both surfaces' element-target argument bags. */
export type AgentElementTargetInput = {
  selector?: string | null;
  text?: string | null;
  testId?: string | null;
  elementIndex?: number | null;
  handle?: string | null;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function optionalFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizePositiveInteger(value: unknown): number | null {
  const raw = optionalFiniteNumber(value);
  if (raw == null) return null;
  const floored = Math.floor(raw);
  return floored > 0 ? floored : null;
}

export function normalizeAgentFrame(value: unknown): AgentFrame {
  const record = isRecord(value) ? value : {};
  return {
    x: finiteNumber(record.x),
    y: finiteNumber(record.y),
    width: Math.max(0, finiteNumber(record.width)),
    height: Math.max(0, finiteNumber(record.height)),
  };
}

export function normalizeNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .map((entry) => (typeof entry === "number" && Number.isFinite(entry) ? Math.floor(entry) : null))
    .filter((entry): entry is number => entry != null && entry >= 0);
  return entries.length ? entries : undefined;
}

export function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .map((entry) => stringOrNull(entry))
    .filter((entry): entry is string => Boolean(entry));
  return entries.length ? entries : undefined;
}

/** Zero-area elements are dropped: nothing can be clicked or screenshotted there. */
export function normalizeAgentElementSnapshot(value: unknown): AgentElementSnapshot | null {
  if (!isRecord(value)) return null;
  const frame = normalizeAgentFrame(value.frame);
  const centerRecord = isRecord(value.center) ? value.center : {};
  const index = normalizePositiveInteger(value.index) ?? 0;
  const framePath = normalizeNumberArray(value.framePath);
  const shadowPath = normalizeStringArray(value.shadowPath);
  if (frame.width <= 0 || frame.height <= 0) return null;
  return {
    index,
    handle: stringOrNull(value.handle),
    ...(framePath ? { framePath } : {}),
    ...(shadowPath ? { shadowPath } : {}),
    tagName: stringOrNull(value.tagName),
    role: stringOrNull(value.role),
    label: stringOrNull(value.label),
    text: stringOrNull(value.text),
    value: stringOrNull(value.value),
    placeholder: stringOrNull(value.placeholder),
    selector: stringOrNull(value.selector),
    testId: stringOrNull(value.testId),
    href: stringOrNull(value.href),
    disabled: typeof value.disabled === "boolean" ? value.disabled : null,
    frame,
    center: {
      x: finiteNumber(centerRecord.x, frame.x + frame.width / 2),
      y: finiteNumber(centerRecord.y, frame.y + frame.height / 2),
    },
  };
}

export function normalizeAgentDomSnapshot(value: unknown): AgentDomSnapshot | null {
  if (!isRecord(value)) return null;
  const scrollRecord = isRecord(value.scroll) ? value.scroll : {};
  const elements = Array.isArray(value.elements)
    ? value.elements
        .map(normalizeAgentElementSnapshot)
        .filter((entry): entry is AgentElementSnapshot => Boolean(entry))
    : [];
  return {
    url: stringOrNull(value.url),
    title: stringOrNull(value.title),
    capturedAt: stringOrNull(value.capturedAt) ?? new Date().toISOString(),
    viewport: normalizeAgentFrame(value.viewport),
    scroll: { x: finiteNumber(scrollRecord.x), y: finiteNumber(scrollRecord.y) },
    elementCount: normalizePositiveInteger(value.elementCount) ?? elements.length,
    elements,
  };
}

/** Stamp `obs-…:e:N` handles onto every element of a fresh DOM snapshot. */
export function applyAgentObservationHandles(
  dom: AgentDomSnapshot,
  observationId: string,
): AgentDomSnapshot {
  return {
    ...dom,
    elements: dom.elements.map((element) => ({
      ...element,
      handle: formatObservationElementHandle(observationId, element.index),
    })),
  };
}

export function agentHasElementTarget(input: AgentElementTargetInput): boolean {
  return Boolean(
    stringOrNull(input.selector)
    || stringOrNull(input.text)
    || stringOrNull(input.testId)
    || normalizePositiveInteger(input.elementIndex) != null
    || stringOrNull(input.handle),
  );
}

export function agentElementLocatePayload(input: AgentElementTargetInput): Record<string, unknown> {
  const selector = stringOrNull(input.selector);
  const text = stringOrNull(input.text);
  const testId = stringOrNull(input.testId);
  const elementIndex = normalizePositiveInteger(input.elementIndex);
  return {
    ...(selector ? { selector } : {}),
    ...(text ? { text } : {}),
    ...(testId ? { testId } : {}),
    ...(elementIndex == null ? {} : { elementIndex }),
  };
}

/* ── Trace target ─────────────────────────────────────────────────────────── */

/**
 * Actions whose `text` is keystrokes the human never typed into a form field —
 * a password, a TOTP code, an API key. Both surfaces name the same concept
 * differently (`type` in App Control, `typeText` in the browser), so the rule
 * lists both rather than living in two forked function bodies.
 */
export const AGENT_TEXT_ENTRY_ACTIONS: ReadonlySet<string> = new Set(["type", "typeText"]);

/** Locator/coordinate keys every agent-driveable surface copies verbatim. */
export const AGENT_TRACE_STRING_KEYS = [
  "selector", "testId", "handle", "button", "key", "url", "loadState",
] as const;

export const AGENT_TRACE_NUMBER_KEYS = [
  "elementIndex", "x", "y", "deltaX", "deltaY", "clickCount", "timeoutMs", "networkIdleMs",
] as const;

export type AgentTraceTargetOptions = {
  /** Surface-specific string keys copied on top of {@link AGENT_TRACE_STRING_KEYS}. */
  stringKeys?: readonly string[];
  /** Surface-specific number keys copied on top of {@link AGENT_TRACE_NUMBER_KEYS}. */
  numberKeys?: readonly string[];
  /** Surface-specific boolean keys copied when the input value is a boolean. */
  booleanKeys?: readonly string[];
  /** Last word for anything the key lists cannot express (upload path counts, handoff reasons). */
  decorate?: (
    target: Record<string, unknown>,
    helpers: { action: string; input: Record<string, unknown>; copyString: (key: string) => void; copyNumber: (key: string) => void },
  ) => void;
};

/**
 * Bounded, redacted description of what an action targeted.
 *
 * Free text is capped at 300 characters and typed secrets are reduced to a
 * length, because the trace is read back by the agent, by `ade browser proof`,
 * and by the Work-tab corner card.
 */
export function agentActionTargetForTrace(
  action: string,
  input: Record<string, unknown>,
  options: AgentTraceTargetOptions = {},
): Record<string, unknown> | null {
  const target: Record<string, unknown> = {};
  const copyString = (key: string): void => {
    const value = stringOrNull(input[key]);
    if (value) target[key] = value;
  };
  const copyNumber = (key: string): void => {
    const value = optionalFiniteNumber(input[key]);
    if (value != null) target[key] = value;
  };
  for (const key of AGENT_TRACE_STRING_KEYS) copyString(key);
  for (const key of options.stringKeys ?? []) copyString(key);
  for (const key of AGENT_TRACE_NUMBER_KEYS) copyNumber(key);
  for (const key of options.numberKeys ?? []) copyNumber(key);
  for (const key of options.booleanKeys ?? []) {
    if (typeof input[key] === "boolean") target[key] = input[key];
  }
  if (typeof input.text === "string") {
    if (AGENT_TEXT_ENTRY_ACTIONS.has(action)) {
      target.textLength = input.text.length;
    } else {
      target.text = input.text.slice(0, 300);
    }
  }
  if (action === "fill") {
    const fillValue = typeof input.value === "string"
      ? input.value
      : (typeof input.text === "string" ? input.text : null);
    if (fillValue != null) target.valueLength = fillValue.length;
  }
  options.decorate?.(target, { action, input, copyString, copyNumber });
  return Object.keys(target).length ? target : null;
}

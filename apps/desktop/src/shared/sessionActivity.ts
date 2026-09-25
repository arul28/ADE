import {
  SESSION_ACTIVITY_VALUES,
  type SessionActivityReport,
  type SessionActivitySource,
  type SessionActivityValue,
} from "./types/sessions";

const SESSION_ACTIVITY_VALUE_SET: ReadonlySet<string> = new Set(SESSION_ACTIVITY_VALUES);

/** Agent CLI target for activity reports; unlike ADE_CHAT_SESSION_ID this is a PTY row id. */
export const SESSION_ACTIVITY_SESSION_ID_ENV = "ADE_ACTIVITY_SESSION_ID";

export function isSessionActivityValue(value: unknown): value is SessionActivityValue {
  return typeof value === "string" && SESSION_ACTIVITY_VALUE_SET.has(value);
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

/**
 * Parse the single persisted activity-status atom at an input boundary.
 * Unknown values, sources, timestamps, or malformed JSON are treated as absent
 * so an old or corrupt row cannot invent a card status.
 */
export function normalizeSessionActivityReport(value: unknown): SessionActivityReport | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;

  const record = candidate as Record<string, unknown>;
  if (!isSessionActivityValue(record.value) || !isSessionActivitySource(record.source)) return null;
  const updatedAt = normalizeTimestamp(record.updatedAt);
  if (!updatedAt) return null;
  const reportedAt = normalizeTimestamp(record.reportedAt);

  return { value: record.value, source: record.source, updatedAt, ...(reportedAt ? { reportedAt } : {}) };
}

function isSessionActivitySource(value: unknown): value is SessionActivitySource {
  return value === "agent" || value === "detected";
}

/**
 * The detected activities an agent's own report still describes truthfully.
 *
 * Tool calls cannot tell debugging from testing, or planning from reading
 * code, so an agent's report is the finer word when the evidence fits it. It
 * is kept while the detector sees work inside this set and replaced when the
 * detector moves somewhere the report does not cover: "implementing" while two
 * review subagents run is a stale label, not a finer one.
 */
const AGENT_REPORT_COVERS: Record<SessionActivityValue, ReadonlySet<SessionActivityValue>> = {
  planning: new Set(["planning", "exploring"]),
  exploring: new Set(["exploring"]),
  implementing: new Set(["implementing", "exploring"]),
  testing: new Set(["testing", "implementing", "exploring"]),
  debugging: new Set(["debugging", "testing", "implementing", "exploring"]),
  reviewing: new Set(["reviewing", "exploring"]),
  shipping: new Set(["shipping", "testing", "exploring"]),
  monitoring: new Set(["monitoring", "exploring"]),
};

/**
 * The row an agent report writes. Confirming the activity ADE already detected
 * keeps its entry time, so the elapsed does not reset. An agent's own earlier
 * report is not kept: it may be from an earlier turn, which the presentation
 * hides, and hiding the report the agent just made would be wrong.
 */
export function nextAgentActivityReport(
  current: SessionActivityReport | null,
  value: SessionActivityValue,
  nowIso: string,
): SessionActivityReport {
  const keepsEntryTime = current?.source === "detected" && current.value === value;
  return {
    value,
    source: "agent",
    updatedAt: keepsEntryTime ? current.updatedAt : nowIso,
    reportedAt: nowIso,
  };
}

/**
 * The row the tool-call detector writes, or `undefined` when the row should
 * stay as it is.
 *
 * A same-valued detected row stays, keeping its entry time. An agent report
 * from this turn stays while it still covers what the detector sees; one from
 * an earlier turn is replaced. Anything else is replaced: detection is the
 * primary source and the agent's word only refines it.
 *
 * Only agent reports are turn-scoped. A detected row may carry across a
 * continuation turn (a subagent finishing, a background wake) because the
 * detector itself does: the host clears both whenever the user engages.
 */
export function nextDetectedActivityReport(
  current: SessionActivityReport | null,
  detected: SessionActivityValue,
  args: { turnStartedAt: string | null; nowIso: string },
): SessionActivityReport | undefined {
  if (current?.source === "detected" && current.value === detected) return undefined;
  if (
    current?.source === "agent"
    && isReportFromTurn(current, args.turnStartedAt)
    && AGENT_REPORT_COVERS[current.value].has(detected)
  ) {
    return undefined;
  }
  return { value: detected, source: "detected", updatedAt: args.nowIso };
}

/** Whether a report was made at or after `turnStartedAt` (no turn marker: yes). */
export function isReportFromTurn(
  report: SessionActivityReport,
  turnStartedAt: string | null | undefined,
): boolean {
  const turnStartedMs = turnStartedAt ? Date.parse(turnStartedAt) : Number.NaN;
  const reportedAt = report.source === "agent" ? report.reportedAt ?? report.updatedAt : report.updatedAt;
  return !Number.isFinite(turnStartedMs) || Date.parse(reportedAt) >= turnStartedMs;
}

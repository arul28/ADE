import type { AgentChatEvent, AgentChatEventEnvelope, AgentChatUserMessageDeliveryState } from "./types";

const MATERIAL_WORKER_EVENT_TYPES = new Set<AgentChatEvent["type"]>([
  "text",
  "reasoning",
  "tool_call",
  "tool_result",
  "command",
  "file_change",
]);

function compactText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function readSummaryCandidate(event: AgentChatEvent): string | null {
  switch (event.type) {
    case "text":
    case "reasoning":
      return typeof event.text === "string" ? event.text : null;
    case "error":
      return typeof event.message === "string" ? event.message : null;
    case "status":
      return typeof event.message === "string" ? event.message : null;
    default:
      return null;
  }
}

export function parseAgentChatTranscript(raw: string): AgentChatEventEnvelope[] {
  const events: AgentChatEventEnvelope[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.length) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<AgentChatEventEnvelope>;
      const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId.trim() : "";
      const timestamp = typeof parsed.timestamp === "string" && parsed.timestamp.trim().length > 0
        ? parsed.timestamp
        : new Date().toISOString();
      const event = parsed.event;
      if (!sessionId || !event || typeof event !== "object") continue;
      events.push({
        sessionId,
        timestamp,
        event: event as AgentChatEvent,
        ...(typeof parsed.sequence === "number" && Number.isFinite(parsed.sequence)
          ? { sequence: parsed.sequence }
          : {}),
        provenance:
          parsed.provenance && typeof parsed.provenance === "object" && !Array.isArray(parsed.provenance)
            ? parsed.provenance as AgentChatEventEnvelope["provenance"]
            : undefined,
      });
    } catch {
      // Ignore malformed transcript lines.
    }
  }
  return events;
}

export function hasMaterialWorkerChatEvent(events: AgentChatEventEnvelope[]): boolean {
  return events.some((entry) => MATERIAL_WORKER_EVENT_TYPES.has(entry.event.type));
}

export function hasWorkerChatLifecycleEvent(events: AgentChatEventEnvelope[]): boolean {
  return events.some((entry) => entry.event.type !== "user_message");
}

export function deriveAgentChatTranscriptSummary(
  events: AgentChatEventEnvelope[],
  maxChars = 280,
): string | null {
  const candidates = events
    .map((entry) => readSummaryCandidate(entry.event))
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  if (!candidates.length) return null;
  return compactText(candidates[candidates.length - 1]!, maxChars);
}

/**
 * True when a steer row is final. Only `queued` and `accepted` can still move:
 * a Cursor or OpenCode turn can refuse an inline steer it was offered, and the
 * same steerId comes back as `queued`. A row with no state is a plain message.
 *
 * iOS keeps a copy in `WorkErrorAndMessageHelpers.swift`.
 */
export function isSettledSteerDeliveryState(
  state: AgentChatUserMessageDeliveryState | undefined,
): boolean {
  switch (state) {
    case "queued":
    case "accepted":
      return false;
    case "inline":
    case "delivered":
    case "processed":
    case "unprocessed":
    case "failed":
    case undefined:
      return true;
    default: {
      const _exhaustive: never = state;
      void _exhaustive;
      return true;
    }
  }
}

/**
 * True when a steer settled without the model ever reading it: `failed` went
 * nowhere, and Codex's `unprocessed` ended its turn unread.
 */
export function isDroppedSteerDeliveryState(
  state: AgentChatUserMessageDeliveryState | undefined,
): boolean {
  switch (state) {
    case "failed":
    case "unprocessed":
      return true;
    case "queued":
    case "accepted":
    case "inline":
    case "delivered":
    case "processed":
    case undefined:
      return false;
    default: {
      const _exhaustive: never = state;
      void _exhaustive;
      return false;
    }
  }
}

/**
 * True when a steer settled on a row the model read: settled, and not
 * dropped. An `accepted` row alone never counts — the live turn may still
 * refuse it.
 */
export function steerReachedModel(
  state: AgentChatUserMessageDeliveryState | undefined,
): boolean {
  return isSettledSteerDeliveryState(state) && !isDroppedSteerDeliveryState(state);
}

export type UserMessageChatEvent = Extract<AgentChatEvent, { type: "user_message" }>;

/**
 * What to emit at a steer's place: the canonical row's event, stamped with
 * the time of the row it is emitted at.
 */
type CanonicalSteerRow = { event: UserMessageChatEvent; timestamp: string };

/**
 * One steer is one message, but the host writes its row once per lifecycle
 * state on the same steerId (`queued` then `delivered`, `accepted` then
 * `inline`, Codex's `accepted` then `processed`). This picks the one row that
 * stands for each steer:
 *
 * - Content (turnId, messageId, text, state) comes from the last settled row,
 *   else the latest row: that is where the message actually landed.
 * - Position is the first row on that row's turn, so an in-turn steer keeps
 *   the place it was shown at. `queued` rows are skipped once the steer left
 *   the queue — staging is not where the model saw it. A steer the live turn
 *   refused and then sent as its own turn sits at that turn, not where it was
 *   first offered.
 * - The timestamp is the placement row's own, so entry times stay in order
 *   and a `--since` read does not return the same steer twice.
 *
 * Returns, for every steer row index, what to emit at that index, or `null`
 * when the row folds into its steer's canonical row. Rows without a steerId
 * (and, with `sessionId`, rows of other sessions) are not in the map.
 */
export function canonicalSteerRows(
  envelopes: readonly AgentChatEventEnvelope[],
  options?: { sessionId?: string },
): Map<number, CanonicalSteerRow | null> {
  const rowsBySteerId = new Map<string, Array<{ index: number; event: UserMessageChatEvent }>>();
  for (let index = 0; index < envelopes.length; index += 1) {
    const envelope = envelopes[index]!;
    const event = envelope.event;
    if (event?.type !== "user_message") continue;
    if (options?.sessionId != null && envelope.sessionId !== options.sessionId) continue;
    const steerId = event.steerId?.trim();
    if (!steerId) continue;
    const rows = rowsBySteerId.get(steerId);
    if (rows) rows.push({ index, event });
    else rowsBySteerId.set(steerId, [{ index, event }]);
  }
  const plan = new Map<number, CanonicalSteerRow | null>();
  for (const rows of rowsBySteerId.values()) {
    let canonical = rows[rows.length - 1]!;
    for (let k = rows.length - 1; k >= 0; k -= 1) {
      if (isSettledSteerDeliveryState(rows[k]!.event.deliveryState)) {
        canonical = rows[k]!;
        break;
      }
    }
    const stillQueued = canonical.event.deliveryState === "queued";
    const turnId = canonical.event.turnId?.trim() ?? "";
    const position = rows.find((row) => {
      if (!stillQueued && row.event.deliveryState === "queued") return false;
      return (row.event.turnId?.trim() ?? "") === turnId;
    }) ?? canonical;
    for (const row of rows) {
      plan.set(
        row.index,
        row === position ? { event: canonical.event, timestamp: envelopes[row.index]!.timestamp } : null,
      );
    }
  }
  return plan;
}

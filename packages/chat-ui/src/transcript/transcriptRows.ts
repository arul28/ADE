/**
 * Transcript row collapsing and grouping.
 *
 * PROVENANCE: ported from
 * `apps/desktop/src/renderer/components/chat/chatTranscriptRows.ts` (ADE
 * desktop renderer). That module is dependency-free by design; this is a
 * trimmed copy carrying over only the row kinds `@ade-dev/chat-ui` renders.
 *
 * Kept from the original, with behaviour intact:
 *  - `mergeStreamingText` (prefix-aware streaming append)
 *  - `getTextIdentity` / `turnAndItemMatch` / `shouldMergeTextRows`
 *  - `buildRenderKey` / `buildTextRenderKey` / `buildCollapseKey`
 *  - tool call → tool result upgrade-in-place keyed on `logicalItemId ?? itemId`
 *  - consecutive-reasoning merge and consecutive-status dedupe from
 *    `groupConsecutiveWorkLogRows`
 *  - `formatStructuredValue`, `eventHasPayload`, `readRecord`
 *
 * Deliberately dropped (ADE-internal, unsupported here): work-log entries and
 * work-log groups, activity bundles, subagent spawn/result/stopped rows,
 * background job lines, scheduled-wake dividers, plan and todo rows, approval
 * requests, `ade_card` merging, localhost URL extraction, diff stats, and the
 * incremental `CollapseTranscriptContext` (this package re-collapses whole
 * histories; they are bounded by the host's `history()` window).
 */

import type {
  AgentChatEvent,
  AgentChatEventEnvelope,
  ChatEventError,
  ChatEventReasoning,
  ChatEventStatus,
  ChatEventText,
  ChatEventUserMessage,
  RenderedChatEvent,
  ToolCallStatus,
} from "../sdkTypes";

/** A tool call and its eventual result, collapsed into one chip row. */
export type ToolChipRow = {
  type: "tool_chip";
  /** Stable id across the call/result pair. */
  id: string;
  tool: string;
  args: unknown;
  result?: unknown;
  status: ToolCallStatus;
  turnId: string | null;
};

export type TranscriptRowEvent =
  | ChatEventUserMessage
  | ChatEventText
  | ChatEventReasoning
  | ChatEventError
  | ChatEventStatus
  | ToolChipRow;

export type TranscriptRow = {
  key: string;
  timestamp: string;
  event: TranscriptRowEvent;
};

/* -------------------------------------------------------------------------- */
/* Pure helpers (ported verbatim in behaviour)                                 */
/* -------------------------------------------------------------------------- */

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function eventHasPayload(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return false;
}

export function formatStructuredValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Providers stream text either as growing snapshots or as deltas. A snapshot
 * that starts with what we already have replaces it; anything else appends.
 */
export function mergeStreamingText(existing: string, incoming: string): string {
  if (!existing.length) return incoming;
  if (!incoming.length) return existing;
  if (incoming.startsWith(existing)) return incoming;
  return `${existing}${incoming}`;
}

function buildRenderKey(envelope: AgentChatEventEnvelope, sequence: number): string {
  return `${envelope.sessionId}:${sequence}:${envelope.timestamp}`;
}

function buildTextRenderKey(
  event: ChatEventText,
  envelope: AgentChatEventEnvelope,
  sequence: number,
): string {
  const messageId = event.messageId?.trim();
  if (messageId) return `${envelope.sessionId}:text:${messageId}:${sequence}`;
  return buildRenderKey(envelope, sequence);
}

function getTextIdentity(event: ChatEventText): string | null {
  const messageId = event.messageId?.trim();
  return messageId?.length ? messageId : null;
}

function turnAndItemMatch(
  a: { turnId?: string; itemId?: string },
  b: { turnId?: string; itemId?: string },
): boolean {
  const aTurnId = a.turnId ?? null;
  const bTurnId = b.turnId ?? null;
  if (!aTurnId || !bTurnId || aTurnId !== bTurnId) return false;
  const aItemId = a.itemId ?? null;
  const bItemId = b.itemId ?? null;
  return !aItemId || !bItemId || aItemId === bItemId;
}

/**
 * Two adjacent `text` events belong in one bubble when they carry the same
 * message identity, or (identity-free) the same turn+item, or when neither
 * carries any identity at all.
 */
export function shouldMergeTextRows(previous: ChatEventText, next: ChatEventText): boolean {
  const previousIdentity = getTextIdentity(previous);
  const nextIdentity = getTextIdentity(next);

  if (previousIdentity || nextIdentity) {
    if (previousIdentity && nextIdentity) return previousIdentity === nextIdentity;
    return turnAndItemMatch(previous, next);
  }

  if (turnAndItemMatch(previous, next)) return true;

  return !previous.turnId && !next.turnId && !previous.itemId && !next.itemId;
}

function buildCollapseKey(
  prefix: string,
  event: { turnId?: string; itemId?: string; logicalItemId?: string },
  suffix?: string,
): string {
  const parts = [prefix];
  if (event.turnId) parts.push(event.turnId);
  const stableItemId = event.logicalItemId ?? event.itemId;
  if (stableItemId) parts.push(stableItemId);
  if (suffix) parts.push(suffix);
  return parts.join("::");
}

function isGenericToolIdentifier(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  return !normalized.length || normalized === "other" || normalized === "tool";
}

function readToolTitle(value: unknown): string | null {
  const record = readRecord(value);
  if (!record) return null;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  return title.length ? title : null;
}

/** Prefer a payload-supplied title when the provider only said "tool". */
export function resolveToolName(tool: string, payload: unknown): string {
  const titleFallback = readToolTitle(payload);
  return isGenericToolIdentifier(tool) && titleFallback ? titleFallback : tool;
}

/* -------------------------------------------------------------------------- */
/* Collapse                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Typed as `ReadonlySet<string>` so membership can be tested against a raw
 * `type` without a cast, while the literal is still checked against the union.
 */
const RENDERED_TYPES: ReadonlySet<string> = new Set<RenderedChatEvent["type"]>([
  "user_message",
  "text",
  "reasoning",
  "tool_call",
  "tool_result",
  "error",
  "status",
]);

/**
 * `AgentChatEvent` is open — a runtime may emit kinds this package has never
 * heard of. This is the one place they are filtered out, and it is what lets
 * every branch below read a narrowed shape without a cast.
 */
function isRenderedEvent(event: AgentChatEvent | undefined): event is RenderedChatEvent {
  return event ? RENDERED_TYPES.has(event.type) : false;
}

/**
 * Fold a raw envelope stream into render rows: streaming text merges into one
 * bubble, a `tool_result` upgrades its `tool_call` chip in place, and event
 * kinds this package does not draw are dropped.
 */
export function collapseTranscriptEvents(
  envelopes: readonly AgentChatEventEnvelope[],
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  /** collapseKey -> index in `rows`, so a result can find its call. */
  const toolRowIndex = new Map<string, number>();

  envelopes.forEach((envelope, position) => {
    const event = envelope.event;
    if (!isRenderedEvent(event)) return;
    const sequence = envelope.sequence ?? position;

    if (event.type === "text") {
      const previous = rows[rows.length - 1];
      if (
        previous
        && previous.event.type === "text"
        && shouldMergeTextRows(previous.event, event)
      ) {
        rows[rows.length - 1] = {
          key: previous.key,
          timestamp: envelope.timestamp,
          event: {
            ...previous.event,
            text: mergeStreamingText(previous.event.text, event.text),
          },
        };
        return;
      }
      rows.push({
        key: buildTextRenderKey(event, envelope, sequence),
        timestamp: envelope.timestamp,
        event,
      });
      return;
    }

    if (event.type === "tool_call") {
      const collapseKey = buildCollapseKey("tool", event);
      const chip: ToolChipRow = {
        type: "tool_chip",
        id: collapseKey,
        tool: resolveToolName(event.tool, event.args),
        args: event.args,
        status: "running",
        turnId: event.turnId ?? null,
      };
      const existing = toolRowIndex.get(collapseKey);
      if (existing !== undefined && rows[existing]) {
        rows[existing] = { ...rows[existing]!, timestamp: envelope.timestamp, event: chip };
        return;
      }
      toolRowIndex.set(collapseKey, rows.length);
      rows.push({ key: collapseKey, timestamp: envelope.timestamp, event: chip });
      return;
    }

    if (event.type === "tool_result") {
      const collapseKey = buildCollapseKey("tool", event);
      const index = toolRowIndex.get(collapseKey);
      const previousChip =
        index !== undefined && rows[index]?.event.type === "tool_chip"
          ? (rows[index]!.event as ToolChipRow)
          : null;
      const chip: ToolChipRow = {
        type: "tool_chip",
        id: collapseKey,
        tool: resolveToolName(event.tool, event.result) || previousChip?.tool || event.tool,
        args: previousChip?.args,
        result: event.result,
        status: event.status ?? "completed",
        turnId: event.turnId ?? previousChip?.turnId ?? null,
      };
      if (index !== undefined && rows[index]) {
        rows[index] = { ...rows[index]!, timestamp: envelope.timestamp, event: chip };
        return;
      }
      // Result with no matching call (history windowed mid-turn): stand alone.
      toolRowIndex.set(collapseKey, rows.length);
      rows.push({ key: collapseKey, timestamp: envelope.timestamp, event: chip });
      return;
    }

    rows.push({
      key: buildRenderKey(envelope, sequence),
      timestamp: envelope.timestamp,
      event,
    });
  });

  return rows;
}

/* -------------------------------------------------------------------------- */
/* Group                                                                       */
/* -------------------------------------------------------------------------- */

function sameReasoningBlock(a: ChatEventReasoning, b: ChatEventReasoning): boolean {
  return (
    (a.turnId ?? null) === (b.turnId ?? null)
    && (a.itemId ?? null) === (b.itemId ?? null)
    && (a.summaryIndex ?? null) === (b.summaryIndex ?? null)
  );
}

function sameStatusRow(a: ChatEventStatus, b: ChatEventStatus): boolean {
  return (
    a.turnStatus === b.turnStatus
    && (a.turnId ?? null) === (b.turnId ?? null)
    && (a.message ?? "") === (b.message ?? "")
  );
}

/**
 * Second pass: merge consecutive reasoning from the same block into one
 * collapsible row and drop repeated identical status rows.
 */
export function groupTranscriptRows(rows: readonly TranscriptRow[]): TranscriptRow[] {
  const grouped: TranscriptRow[] = [];
  let index = 0;

  while (index < rows.length) {
    const row = rows[index]!;

    if (row.event.type === "reasoning") {
      const head = row.event;
      let mergedText = head.text ?? "";
      let cursor = index + 1;
      while (cursor < rows.length) {
        const candidate = rows[cursor]!;
        if (candidate.event.type !== "reasoning") break;
        if (!sameReasoningBlock(head, candidate.event)) break;
        mergedText += `\n\n---\n\n${candidate.event.text ?? ""}`;
        cursor += 1;
      }
      if (cursor > index + 1) {
        grouped.push({
          key: `reasoning-group:${row.key}`,
          timestamp: rows[cursor - 1]!.timestamp,
          event: { ...head, text: mergedText },
        });
        index = cursor;
        continue;
      }
    }

    if (row.event.type === "status") {
      const previous = grouped[grouped.length - 1];
      if (previous && previous.event.type === "status" && sameStatusRow(previous.event, row.event)) {
        grouped[grouped.length - 1] = row;
        index += 1;
        continue;
      }
    }

    grouped.push(row);
    index += 1;
  }

  return grouped;
}

/** Collapse then group, in the order the renderer needs. */
export function buildTranscriptRows(
  envelopes: readonly AgentChatEventEnvelope[],
): TranscriptRow[] {
  return groupTranscriptRows(collapseTranscriptEvents(envelopes));
}

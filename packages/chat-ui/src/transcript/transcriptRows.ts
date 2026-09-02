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
 *    (the same template drives approval request → decision)
 *  - consecutive-reasoning merge and consecutive-status dedupe from
 *    `groupConsecutiveWorkLogRows`
 *  - `formatStructuredValue`, `eventHasPayload`, `readRecord`
 *
 * Deliberately dropped (ADE-internal, unsupported here): work-log entries and
 * work-log groups, activity bundles, subagent spawn/result/stopped rows,
 * background job lines, scheduled-wake dividers, plan and todo rows,
 * `ade_card` merging, localhost URL extraction, diff stats, and the
 * incremental `CollapseTranscriptContext` (this package re-collapses whole
 * histories; they are bounded by the host's `history()` window).
 */

import type {
  AgentChatEvent,
  AgentChatEventEnvelope,
  ApprovalKind,
  ApprovalRequest,
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

/**
 * How far an approval has got.
 *
 * `expired` is this package's word for "the turn ended without an answer" — the
 * request can no longer be answered, but the card stays on screen, because a
 * card that vanishes is indistinguishable from one that was never answered.
 *
 * `accepted_always` never comes out of `collapseTranscriptEvents`:
 * `pending_input_resolved` reports only `accepted`, so the runtime cannot tell
 * a one-off allow from a session-wide one. The card remembers which button was
 * pressed and shows the distinction for the reader who pressed it.
 */
export type ApprovalRowState =
  | "pending"
  | "accepted"
  | "accepted_always"
  | "rejected"
  | "cancelled"
  | "expired";

/** An approval request and its eventual decision, collapsed into one card row. */
export type ApprovalRow = {
  type: "approval";
  /** The request's `itemId`. Stable across the request/resolution pair. */
  id: string;
  kind: ApprovalKind;
  requestKind?: string;
  description: string;
  detail?: unknown;
  turnId: string | null;
  state: ApprovalRowState;
};

export type TranscriptRowEvent =
  | ChatEventUserMessage
  | ChatEventText
  | ChatEventReasoning
  | ChatEventError
  | ChatEventStatus
  | ToolChipRow
  | ApprovalRow;

export type TranscriptRow = {
  key: string;
  timestamp: string;
  event: TranscriptRowEvent;
};

/* -------------------------------------------------------------------------- */
/* Pure helpers (ported verbatim in behaviour)                                 */
/* -------------------------------------------------------------------------- */

/** Exported because `ApprovalCard.tsx` needs the same reader and had a copy. */
export function readRecord(value: unknown): Record<string, unknown> | null {
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
  "approval_request",
  "pending_input_resolved",
]);

/** `pending_input_resolved` wording -> the state the card should settle into. */
const APPROVAL_RESOLUTION_STATE: Record<string, ApprovalRowState> = {
  accepted: "accepted",
  declined: "rejected",
  cancelled: "cancelled",
};

function readTurnId(event: AgentChatEvent): string | null {
  const value = (event as { turnId?: unknown }).turnId;
  return typeof value === "string" && value ? value : null;
}

/**
 * Does this envelope end a turn?
 *
 * `done` is not a rendered kind and never will be, so this is checked BEFORE
 * the `RENDERED_TYPES` filter — otherwise the most common turn ending would be
 * dropped and every unanswered approval would sit "pending" forever.
 *
 * Two endings count here: `done`, and a `status` whose `turnStatus` is
 * `completed`, `failed` or `interrupted`.
 *
 * `packages/sdk/src/thread.ts` applies the narrower `done`-only rule to the
 * same stream, and that difference is deliberate. The SDK's set decides whether
 * `approve()` may still forward an id, so dropping an approval one envelope too
 * early throws `approval_not_found` for a request the runtime is still blocked
 * on. This function only decides when a card stops accepting clicks, so an
 * extra envelope of latency costs nothing. Every terminal `status` in
 * `agentChatService.ts` is followed by `done` in the next statement, so the
 * `status` branch never expires a row that `done` would not expire anyway.
 *
 * An `error` ends no turn on either layer. An OpenCode per-tool failure emits
 * one and keeps streaming the same turn, and the Codex planning-approval guard
 * emits one to decline a single request. Treating those as endings marks a LIVE
 * approval `expired` and disables its buttons, and the runtime then stays
 * blocked until someone interrupts it.
 */
function turnEndingOf(event: AgentChatEvent | undefined): { turnId: string | null } | null {
  if (!event) return null;
  if (event.type === "done") return { turnId: readTurnId(event) };
  if (event.type === "status") {
    const turnStatus = (event as ChatEventStatus).turnStatus;
    if (turnStatus === "completed" || turnStatus === "failed" || turnStatus === "interrupted") {
      return { turnId: readTurnId(event) };
    }
  }
  return null;
}

/**
 * Mark every still-pending approval of a finished turn `expired`.
 *
 * A turn ending settles its approvals whether or not anyone answered them: the
 * provider is gone and a button press would now throw. An ending that names no
 * turn expires every pending row, because there is nothing left running that
 * could still be waiting on one.
 */
function expirePendingApprovals(rows: TranscriptRow[], turnId: string | null): void {
  rows.forEach((row, index) => {
    const event = row.event;
    if (event.type !== "approval" || event.state !== "pending") return;
    // A row carrying no `turnId` of its own expires on ANY turn ending, which
    // is deliberate and is the safer of the two options: a stuck "pending" card
    // with live buttons that now throw is worse than one marked expired.
    if (turnId !== null && event.turnId !== null && event.turnId !== turnId) return;
    rows[index] = { ...row, event: { ...event, state: "expired" } };
  });
}

/**
 * The state a RESTORED approval row is born in.
 *
 * A restored row is live by construction. It comes from `pendingApprovals()`,
 * which the runtime answers from `chats.pendingInputs` — the engine's
 * authoritative "still blocked right now" list, read AFTER the history window
 * was fetched. Nothing in that history can outrank it, so no turn ending
 * expires it. An ending recorded before the request was even restored says
 * only that some earlier turn finished.
 *
 * The one thing that can settle it is an explicit resolution: a
 * `pending_input_resolved` whose request fell outside the window is parked in
 * `orphanResolutions`, and it says what the decision WAS.
 *
 * Getting this wrong is a hang. A genuinely blocked request drawn `expired`
 * renders read-only buttons and "The turn ended before this was answered.", and
 * the runtime waits on an answer the user can no longer give.
 */
function resolveRestoredApprovalState(input: {
  itemId: string;
  logicalItemId?: string;
  orphanResolutions: Map<string, ApprovalRowState>;
}): ApprovalRowState {
  const held =
    input.orphanResolutions.get(input.itemId)
    ?? (input.logicalItemId ? input.orphanResolutions.get(input.logicalItemId) : undefined);
  return held ?? "pending";
}

/**
 * Put a restored approval row where its timestamp says it belongs.
 *
 * Appending it instead pinned it below every message that streamed in later,
 * for the life of the mount: the restore loop runs on every rebuild and the
 * grouping pass never re-sorts, so a card answered ten messages ago still read
 * as the newest thing in the transcript.
 *
 * Only the restored rows move. The envelope rows keep the order `sortEnvelopes`
 * gave them, which is by `sequence` and not by clock.
 */
function insertByTimestamp(rows: TranscriptRow[], row: TranscriptRow): void {
  const index = rows.findIndex((existing) => existing.timestamp > row.timestamp);
  if (index === -1) rows.push(row);
  else rows.splice(index, 0, row);
}

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
  /**
   * Requests the runtime is still blocked on, from `thread.pendingApprovals()`.
   *
   * Passed as data rather than as synthesized `approval_request` envelopes. A
   * reload drops the live events that carried the originals, and `history()`
   * may not reach back far enough to replay them — without these a blocked
   * thread comes back looking merely silent, with nothing on screen able to
   * unblock it. Any request already drawn from the envelope stream is skipped,
   * so a replayed one is never drawn twice.
   */
  pendingApprovals: readonly ApprovalRequest[] = [],
  /**
   * When `pendingApprovals` was read, as an ISO timestamp.
   *
   * The restored rows sort into the transcript at this instant instead of being
   * appended, so a message that streams in afterwards renders BELOW them. The
   * caller captures it once, when it restores, and passes the same value on
   * every rebuild — deriving it per rebuild would walk the card down the
   * transcript as new envelopes arrive. Omitted, the rows land at the tail as
   * they did before.
   */
  restoredAt?: string,
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  /** collapseKey -> index in `rows`, so a result can find its call. */
  const toolRowIndex = new Map<string, number>();
  /** itemId AND logicalItemId -> index, so a resolution can find its request. */
  const approvalRowIndex = new Map<string, number>();
  /**
   * Resolutions that arrived before the request they settle.
   *
   * The engine emits the request first and `mergeHistoryWithBuffer` sorts by
   * `sequence`, so this needs a runtime that renumbers — but when it happens,
   * dropping the resolution left a live card with working buttons on a request
   * that is already settled. Held here and applied when the request lands.
   */
  const orphanResolutions = new Map<string, ApprovalRowState>();

  envelopes.forEach((envelope, position) => {
    const event = envelope.event;
    // Before the rendered-kind filter: `done` ends turns and is not drawn.
    // `approvalRowIndex` is empty until the first approval row exists, and an
    // ending can only settle an approval row, so the whole-array scan is
    // skipped for the histories that carry no approval at all.
    if (approvalRowIndex.size > 0) {
      const ending = turnEndingOf(event);
      if (ending) expirePendingApprovals(rows, ending.turnId);
    }

    if (!isRenderedEvent(event)) return;
    const sequence = envelope.sequence ?? position;

    if (event.type === "approval_request") {
      const row: ApprovalRow = {
        type: "approval",
        id: event.itemId,
        kind: event.kind,
        description: event.description,
        turnId: event.turnId ?? null,
        state: "pending",
      };
      if (event.requestKind !== undefined) row.requestKind = event.requestKind;
      if (event.detail !== undefined) row.detail = event.detail;

      const held =
        orphanResolutions.get(event.itemId)
        ?? (event.logicalItemId ? orphanResolutions.get(event.logicalItemId) : undefined);
      if (held) {
        row.state = held;
        orphanResolutions.delete(event.itemId);
        if (event.logicalItemId) orphanResolutions.delete(event.logicalItemId);
      }

      const existing = approvalRowIndex.get(event.itemId);
      if (existing !== undefined && rows[existing]) {
        // Same request replayed (history overlapping live, or a re-ask). Keep
        // the decision already recorded rather than resurrecting the buttons.
        const previous = rows[existing]!.event;
        const state = previous.type === "approval" ? previous.state : "pending";
        rows[existing] = {
          ...rows[existing]!,
          timestamp: envelope.timestamp,
          event: { ...row, state },
        };
        return;
      }
      approvalRowIndex.set(event.itemId, rows.length);
      if (event.logicalItemId) approvalRowIndex.set(event.logicalItemId, rows.length);
      rows.push({ key: `approval:${event.itemId}`, timestamp: envelope.timestamp, event: row });
      return;
    }

    if (event.type === "pending_input_resolved") {
      const index =
        approvalRowIndex.get(event.itemId)
        ?? (event.logicalItemId ? approvalRowIndex.get(event.logicalItemId) : undefined);
      const row = index !== undefined ? rows[index] : undefined;
      const state = APPROVAL_RESOLUTION_STATE[event.resolution];
      if (!state) return;
      // A resolution with no request in the window carries no description, so
      // there is no card to draw yet. Remember it rather than inventing one or
      // dropping it: if the request arrives later in the same list, it must
      // come back settled, not with live buttons on a finished decision.
      if (index === undefined || !row || row.event.type !== "approval") {
        orphanResolutions.set(event.itemId, state);
        if (event.logicalItemId) orphanResolutions.set(event.logicalItemId, state);
        return;
      }
      rows[index] = { ...row, timestamp: envelope.timestamp, event: { ...row.event, state } };
      return;
    }

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

  // Rows built directly from the request shape — no envelope is fabricated for
  // them. An envelope needs a `sessionId` and a `sequence`, and a caller that
  // has neither can only invent them; an invented sequence then collides with
  // the first real envelopes that arrive.
  const at = restoredAt ?? rows[rows.length - 1]?.timestamp ?? new Date(0).toISOString();
  for (const request of pendingApprovals) {
    if (!request.itemId) continue;
    if (approvalRowIndex.has(request.itemId)) continue;
    if (request.logicalItemId && approvalRowIndex.has(request.logicalItemId)) continue;
    const row: ApprovalRow = {
      type: "approval",
      id: request.itemId,
      kind: request.kind,
      description: request.description,
      turnId: request.turnId ?? null,
      state: resolveRestoredApprovalState({
        itemId: request.itemId,
        ...(request.logicalItemId ? { logicalItemId: request.logicalItemId } : {}),
        orphanResolutions,
      }),
    };
    if (request.requestKind !== undefined) row.requestKind = request.requestKind;
    if (request.detail !== undefined) row.detail = request.detail;
    // Only membership is read after the walk, so the stale indices a splice
    // leaves behind are never dereferenced.
    approvalRowIndex.set(request.itemId, rows.length);
    if (request.logicalItemId) approvalRowIndex.set(request.logicalItemId, rows.length);
    insertByTimestamp(rows, { key: `approval:${request.itemId}`, timestamp: at, event: row });
  }

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
  pendingApprovals: readonly ApprovalRequest[] = [],
  restoredAt?: string,
): TranscriptRow[] {
  return groupTranscriptRows(collapseTranscriptEvents(envelopes, pendingApprovals, restoredAt));
}

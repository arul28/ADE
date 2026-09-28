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
 *  - consecutive-reasoning merge (same turn, deduped through
 *    `mergeReasoningTextFragments`) and consecutive-status dedupe from
 *    `groupConsecutiveWorkLogRows`
 *  - `formatStructuredValue`, `eventHasPayload`, `readRecord`
 *
 * Deliberately dropped (ADE-internal, unsupported here): work-log entries and
 * work-log groups, activity bundles, subagent spawn/result/stopped rows,
 * background job lines, scheduled-wake dividers, plan and todo rows,
 * `ade_card` merging, localhost URL extraction, and diff stats.
 *
 * Incremental building: `TranscriptRowBuilder` holds the collapse state
 * between calls, so a live envelope patches the tail (or the one earlier row it
 * settles) instead of re-collapsing the whole history. `collapseTranscriptEvents`
 * and `buildTranscriptRows` are the same builder run once over a full list.
 *
 * Also deliberately dropped: the CTO voice-call fold (`voice_call_group`).
 * ADE folds a consecutive run of rows sharing `provenance.voiceCallId` into one
 * call card. That id is stamped only while a CTO voice turn is running, and a
 * voice call belongs to the CTO's own thread — which an `@ade-dev/sdk` sidecar
 * holds the `agent` role against and therefore never reads. Porting the fold
 * would add a row kind that can never be produced here. If the id does somehow
 * appear on an envelope, it rides through untouched: it is one more key under
 * the provenance index signature, and the rows render individually, which is
 * the honest reading of events this package cannot attribute to a call.
 */

import { parseToolIdentity, type ToolIdentity } from "../activity/toolIdentity";
import type {
  AgentChatEvent,
  AgentChatEventEnvelope,
  ApprovalKind,
  ApprovalRequest,
  ChatEventMcpSource,
  AgentChatResourceLink,
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
  /** The tool name as the provider spelled it (or its payload title). */
  tool: string;
  /**
   * `{ server, tool }` for this call, one shape whatever the provider's
   * spelling (`mcp__srv__x`, `srv:x`, `mcp:srv:x`). Taken from the event's own
   * `mcp` field when the runtime sent one, else parsed from `tool`.
   */
  identity: ToolIdentity;
  args: unknown;
  result?: unknown;
  /**
   * MCP `resource_link` items the tool returned, as data (`{ uri, name?,
   * title?, mimeType? }`). Present only when the runtime passed them on; a host
   * builds "open this" actions from these rather than scraping the result text.
   */
  resourceLinks?: AgentChatResourceLink[];
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

/** The event's own MCP identity wins; the tool string is parsed otherwise. */
function toolIdentityOf(tool: string, mcp: ChatEventMcpSource | undefined): ToolIdentity {
  const server = typeof mcp?.server === "string" ? mcp.server.trim() : "";
  const name = typeof mcp?.tool === "string" ? mcp.tool.trim() : "";
  if (server && name) return { server, tool: name };
  return parseToolIdentity(tool);
}

function readResourceLinks(value: unknown): AgentChatResourceLink[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const links: AgentChatResourceLink[] = [];
  for (const entry of value) {
    const record = readRecord(entry);
    const uri = typeof record?.uri === "string" ? record.uri.trim() : "";
    if (!record || !uri) continue;
    const link: AgentChatResourceLink = { uri };
    if (typeof record.name === "string" && record.name) link.name = record.name;
    if (typeof record.title === "string" && record.title) link.title = record.title;
    if (typeof record.mimeType === "string" && record.mimeType) link.mimeType = record.mimeType;
    links.push(link);
  }
  return links.length ? links : undefined;
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
 * `completed`, `failed`, or `interrupted` — `failed` including the SDK's
 * synthetic one (`synthetic: true`) for a runtime that exited mid-turn, which
 * no `done` follows.
 *
 * `packages/sdk/src/approvalTracker.ts` applies the narrower `done`-only rule to the
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
    if (
      turnStatus === "completed"
      || turnStatus === "failed"
      || turnStatus === "interrupted"
    ) {
      return { turnId: readTurnId(event) };
    }
  }
  return null;
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
 * `AgentChatEvent` is open — a runtime may emit kinds this package has never
 * heard of. This is the one place they are filtered out, and it is what lets
 * every branch below read a narrowed shape without a cast.
 */
function isRenderedEvent(event: AgentChatEvent | undefined): event is RenderedChatEvent {
  return event ? RENDERED_TYPES.has(event.type) : false;
}

/**
 * The collapse pass, holding its state between calls.
 *
 * `append` folds envelopes into `raw` rows exactly as a single pass over the
 * whole list would — streaming text merges into one bubble, a `tool_result`
 * upgrades its `tool_call` chip in place, kinds this package does not draw are
 * dropped — and records the lowest row index it touched. `groupFrom` then
 * re-runs the grouping pass from the group that contains that index only, so a
 * streamed delta costs the tail, not the transcript.
 */
class RowCollapser {
  readonly raw: TranscriptRow[] = [];
  /** collapseKey -> index in `raw`, so a result can find its call. */
  private readonly toolRowIndex = new Map<string, number>();
  /** itemId AND logicalItemId -> index, so a resolution can find its request. */
  private readonly approvalRowIndex = new Map<string, number>();
  /**
   * Resolutions that arrived before the request they settle.
   *
   * The engine emits the request first and `mergeHistoryWithBuffer` sorts by
   * `sequence`, so this needs a runtime that renumbers — but when it happens,
   * dropping the resolution left a live card with working buttons on a request
   * that is already settled. Held here and applied when the request lands.
   */
  private readonly orphanResolutions = new Map<string, ApprovalRowState>();
  /**
   * Item ids of rows built from `restore()` rather than from an envelope.
   *
   * A turn ending never expires these (see `resolveRestoredApprovalState`).
   * A single-pass collapse got that for free by restoring after the walk; an
   * incremental one restores first and then keeps walking, so it has to say so.
   */
  private readonly restoredIds = new Set<string>();
  /** Envelopes consumed so far: the positional fallback for `sequence`. */
  private position = 0;
  /** Lowest `raw` index changed since the last `takeDirty()`. */
  private dirtyFrom = Number.POSITIVE_INFINITY;

  private mark(index: number): void {
    if (index < this.dirtyFrom) this.dirtyFrom = index;
  }

  private set(index: number, row: TranscriptRow): void {
    this.raw[index] = row;
    this.mark(index);
  }

  private push(row: TranscriptRow): number {
    const index = this.raw.length;
    this.raw.push(row);
    this.mark(index);
    return index;
  }

  /** The lowest changed index, and reset. Infinity when nothing changed. */
  takeDirty(): number {
    const dirty = this.dirtyFrom;
    this.dirtyFrom = Number.POSITIVE_INFINITY;
    return dirty;
  }

  /**
   * Mark every still-pending approval of a finished turn `expired`.
   *
   * A turn ending settles its approvals whether or not anyone answered them: the
   * provider is gone and a button press would now throw. An ending that names no
   * turn expires every pending row, because there is nothing left running that
   * could still be waiting on one.
   */
  private expirePendingApprovals(turnId: string | null): void {
    this.raw.forEach((row, index) => {
      const event = row.event;
      if (event.type !== "approval" || event.state !== "pending") return;
      if (this.restoredIds.has(event.id)) return;
      // A row carrying no `turnId` of its own expires on ANY turn ending, which
      // is deliberate and is the safer of the two options: a stuck "pending"
      // card with live buttons that now throw is worse than one marked expired.
      if (turnId !== null && event.turnId !== null && event.turnId !== turnId) return;
      this.set(index, { ...row, event: { ...event, state: "expired" } });
    });
  }

  append(envelopes: readonly AgentChatEventEnvelope[]): void {
    for (const envelope of envelopes) {
      this.step(envelope, this.position);
      this.position += 1;
    }
  }

  private step(envelope: AgentChatEventEnvelope, position: number): void {
    const rows = this.raw;
    const event = envelope.event;
    // Before the rendered-kind filter: `done` ends turns and is not drawn.
    // `approvalRowIndex` is empty until the first approval row exists, and an
    // ending can only settle an approval row, so the whole-array scan is
    // skipped for the histories that carry no approval at all.
    if (this.approvalRowIndex.size > 0) {
      const ending = turnEndingOf(event);
      if (ending) this.expirePendingApprovals(ending.turnId);
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
        this.orphanResolutions.get(event.itemId)
        ?? (event.logicalItemId ? this.orphanResolutions.get(event.logicalItemId) : undefined);
      if (held) {
        row.state = held;
        this.orphanResolutions.delete(event.itemId);
        if (event.logicalItemId) this.orphanResolutions.delete(event.logicalItemId);
      }

      const existing = this.approvalRowIndex.get(event.itemId);
      if (existing !== undefined && rows[existing]) {
        // Same request replayed (history overlapping live, or a re-ask). Keep
        // the decision already recorded rather than resurrecting the buttons.
        const previous = rows[existing]!.event;
        const state = previous.type === "approval" ? previous.state : "pending";
        // From here on the envelope owns this card, so a turn ending may
        // expire it like any other.
        this.restoredIds.delete(event.itemId);
        this.set(existing, {
          ...rows[existing]!,
          timestamp: envelope.timestamp,
          event: { ...row, state },
        });
        return;
      }
      this.approvalRowIndex.set(event.itemId, rows.length);
      if (event.logicalItemId) this.approvalRowIndex.set(event.logicalItemId, rows.length);
      this.push({ key: `approval:${event.itemId}`, timestamp: envelope.timestamp, event: row });
      return;
    }

    if (event.type === "pending_input_resolved") {
      const index =
        this.approvalRowIndex.get(event.itemId)
        ?? (event.logicalItemId ? this.approvalRowIndex.get(event.logicalItemId) : undefined);
      const row = index !== undefined ? rows[index] : undefined;
      const state = APPROVAL_RESOLUTION_STATE[event.resolution];
      if (!state) return;
      // A resolution with no request in the window carries no description, so
      // there is no card to draw yet. Remember it rather than inventing one or
      // dropping it: if the request arrives later in the same list, it must
      // come back settled, not with live buttons on a finished decision.
      if (index === undefined || !row || row.event.type !== "approval") {
        this.orphanResolutions.set(event.itemId, state);
        if (event.logicalItemId) this.orphanResolutions.set(event.logicalItemId, state);
        return;
      }
      this.set(index, { ...row, timestamp: envelope.timestamp, event: { ...row.event, state } });
      return;
    }

    if (event.type === "text") {
      const lastIndex = rows.length - 1;
      const previous = rows[lastIndex];
      if (
        previous
        && previous.event.type === "text"
        && shouldMergeTextRows(previous.event, event)
      ) {
        this.set(lastIndex, {
          key: previous.key,
          timestamp: envelope.timestamp,
          event: {
            ...previous.event,
            text: mergeStreamingText(previous.event.text, event.text),
          },
        });
        return;
      }
      this.push({
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
        identity: toolIdentityOf(event.tool, event.mcp),
        args: event.args,
        status: "running",
        turnId: event.turnId ?? null,
      };
      const existing = this.toolRowIndex.get(collapseKey);
      if (existing !== undefined && rows[existing]) {
        this.set(existing, { ...rows[existing]!, timestamp: envelope.timestamp, event: chip });
        return;
      }
      this.toolRowIndex.set(collapseKey, rows.length);
      this.push({ key: collapseKey, timestamp: envelope.timestamp, event: chip });
      return;
    }

    if (event.type === "tool_result") {
      const collapseKey = buildCollapseKey("tool", event);
      const index = this.toolRowIndex.get(collapseKey);
      const previousChip =
        index !== undefined && rows[index]?.event.type === "tool_chip"
          ? (rows[index]!.event as ToolChipRow)
          : null;
      const tool = resolveToolName(event.tool, event.result) || previousChip?.tool || event.tool;
      const chip: ToolChipRow = {
        type: "tool_chip",
        id: collapseKey,
        tool,
        identity:
          event.mcp || !previousChip
            ? toolIdentityOf(event.tool || tool, event.mcp)
            : previousChip.identity,
        args: previousChip?.args,
        result: event.result,
        status: event.status ?? "completed",
        turnId: event.turnId ?? previousChip?.turnId ?? null,
      };
      const resourceLinks = readResourceLinks(event.resourceLinks) ?? previousChip?.resourceLinks;
      if (resourceLinks) chip.resourceLinks = resourceLinks;
      if (index !== undefined && rows[index]) {
        this.set(index, { ...rows[index]!, timestamp: envelope.timestamp, event: chip });
        return;
      }
      // Result with no matching call (history windowed mid-turn): stand alone.
      this.toolRowIndex.set(collapseKey, rows.length);
      this.push({ key: collapseKey, timestamp: envelope.timestamp, event: chip });
      return;
    }

    this.push({
      key: buildRenderKey(envelope, sequence),
      timestamp: envelope.timestamp,
      event,
    });
  }

  /**
   * Put a restored approval row where its timestamp says it belongs.
   *
   * Appending it instead pinned it below every message that streamed in later,
   * for the life of the mount: a card answered ten messages ago still read as
   * the newest thing in the transcript. Only the restored rows move; the
   * envelope rows keep the order `sortEnvelopes` gave them, which is by
   * `sequence` and not by clock. Every stored index at or past the insertion
   * point shifts by one, because later envelopes still look rows up by index.
   */
  private insertByTimestamp(row: TranscriptRow): number {
    const index = this.raw.findIndex((existing) => existing.timestamp > row.timestamp);
    if (index === -1) return this.push(row);
    this.raw.splice(index, 0, row);
    for (const map of [this.toolRowIndex, this.approvalRowIndex]) {
      for (const [key, value] of map) if (value >= index) map.set(key, value + 1);
    }
    this.mark(index);
    return index;
  }

  /**
   * Rows built directly from the request shape — no envelope is fabricated for
   * them. An envelope needs a `sessionId` and a `sequence`, and a caller that
   * has neither can only invent them; an invented sequence then collides with
   * the first real envelopes that arrive.
   */
  restore(pendingApprovals: readonly ApprovalRequest[], restoredAt?: string): void {
    const at =
      restoredAt ?? this.raw[this.raw.length - 1]?.timestamp ?? new Date(0).toISOString();
    for (const request of pendingApprovals) {
      if (!request.itemId) continue;
      if (this.approvalRowIndex.has(request.itemId)) continue;
      if (request.logicalItemId && this.approvalRowIndex.has(request.logicalItemId)) continue;
      const row: ApprovalRow = {
        type: "approval",
        id: request.itemId,
        kind: request.kind,
        description: request.description,
        turnId: request.turnId ?? null,
        state: resolveRestoredApprovalState({
          itemId: request.itemId,
          ...(request.logicalItemId ? { logicalItemId: request.logicalItemId } : {}),
          orphanResolutions: this.orphanResolutions,
        }),
      };
      if (request.requestKind !== undefined) row.requestKind = request.requestKind;
      if (request.detail !== undefined) row.detail = request.detail;
      this.restoredIds.add(request.itemId);
      const index = this.insertByTimestamp({
        key: `approval:${request.itemId}`,
        timestamp: at,
        event: row,
      });
      this.approvalRowIndex.set(request.itemId, index);
      if (request.logicalItemId) this.approvalRowIndex.set(request.logicalItemId, index);
    }
  }
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
  const collapser = new RowCollapser();
  collapser.append(envelopes);
  collapser.restore(pendingApprovals, restoredAt);
  return collapser.raw.slice();
}

/* -------------------------------------------------------------------------- */
/* Group                                                                       */
/* -------------------------------------------------------------------------- */

function sameStatusRow(a: ChatEventStatus, b: ChatEventStatus): boolean {
  return (
    a.turnStatus === b.turnStatus
    && (a.turnId ?? null) === (b.turnId ?? null)
    && (a.message ?? "") === (b.message ?? "")
  );
}

/**
 * Join two reasoning fragments of the SAME item without repeating a re-emit.
 *
 * Ported from `apps/desktop/src/shared/chatActivityPhase.ts`. Providers stream a
 * thought as deltas and may re-emit the completed block; cumulative, exact, and
 * full-suffix re-emits collapse to the text once. A partial boundary overlap is
 * deliberately NOT spliced — two genuine deltas can share a boundary character
 * ("look" then "keep going"), and dropping the overlap would eat real text.
 */
function mergeReasoningFragment(existing: string, incoming: string): string {
  if (!existing.length) return incoming;
  if (!incoming.length) return existing;
  if (existing === incoming) return existing;
  if (incoming.startsWith(existing)) return incoming;
  if (existing.startsWith(incoming)) return existing;
  if (incoming.trim().length > 0 && existing.trimEnd().endsWith(incoming.trim())) return existing;
  return `${existing}${incoming}`;
}

/**
 * Collapse a list of reasoning blocks into the blocks that actually differ.
 *
 * Ported from `apps/desktop/src/shared/chatActivityPhase.ts`: providers stream a
 * thought as deltas and then re-emit the completed block (Claude can persist one
 * thought twice, under the stream index and the snapshot index), so identical
 * and contained blocks drop instead of repeating. Genuinely distinct blocks are
 * joined by `---`.
 */
function mergeReasoningTextFragments(texts: readonly string[]): string {
  const fragments: string[] = [];
  for (const raw of texts) {
    const text = raw.trim();
    if (!text.length) continue;
    if (fragments.includes(text)) continue;
    const contained = fragments
      .map((fragment, index) => (text.includes(fragment) ? index : -1))
      .filter((index) => index >= 0);
    if (contained.length) {
      const firstIndex = contained[0]!;
      fragments[firstIndex] = text;
      for (const index of contained.slice(1).sort((left, right) => right - left)) {
        fragments.splice(index, 1);
      }
      continue;
    }
    if (fragments.some((fragment) => fragment.includes(text))) continue;
    fragments.push(text);
  }
  return fragments.join("\n\n---\n\n");
}

/**
 * The grouping pass over `rows`, starting at raw index `from` and appending to
 * `grouped` / `starts` (the raw index each grouped row began at).
 *
 * Left to right, and its only state is what it has already emitted, which is
 * what lets `TranscriptRowBuilder` truncate at a group boundary and resume.
 */
function groupInto(
  rows: readonly TranscriptRow[],
  from: number,
  grouped: TranscriptRow[],
  starts: number[],
): void {
  let index = from;

  while (index < rows.length) {
    const row = rows[index]!;

    if (row.event.type === "reasoning") {
      const head = row.event;
      // Fold deltas of the same item first (so a delta split across rows rejoins
      // as "Hello world", not two `---` blocks), then dedupe distinct blocks.
      const blocks: string[] = [];
      let currentItemKey = `${head.itemId ?? ""}\u0000${head.summaryIndex ?? ""}`;
      let currentText = head.text ?? "";
      let cursor = index + 1;
      const flushBlock = () => {
        if (currentText.length) blocks.push(currentText);
      };
      while (cursor < rows.length) {
        const candidate = rows[cursor]!;
        if (candidate.event.type !== "reasoning") break;
        if ((candidate.event.turnId ?? null) !== (head.turnId ?? null)) break;
        const nextItemKey = `${candidate.event.itemId ?? ""}\u0000${candidate.event.summaryIndex ?? ""}`;
        if (nextItemKey === currentItemKey) {
          currentText = mergeReasoningFragment(currentText, candidate.event.text ?? "");
        } else {
          flushBlock();
          currentText = candidate.event.text ?? "";
          currentItemKey = nextItemKey;
        }
        cursor += 1;
      }
      if (cursor > index + 1) {
        flushBlock();
        grouped.push({
          key: `reasoning-group:${row.key}`,
          timestamp: rows[cursor - 1]!.timestamp,
          event: { ...head, text: mergeReasoningTextFragments(blocks) },
        });
        starts.push(index);
        index = cursor;
        continue;
      }
    }

    if (row.event.type === "status") {
      const previous = grouped[grouped.length - 1];
      if (previous && previous.event.type === "status" && sameStatusRow(previous.event, row.event)) {
        // The run keeps the raw index it started at, so a resume re-reads it whole.
        grouped[grouped.length - 1] = row;
        index += 1;
        continue;
      }
    }

    grouped.push(row);
    starts.push(index);
    index += 1;
  }
}

/**
 * Second pass: merge consecutive reasoning from the same turn into one
 * collapsible row and drop repeated identical status rows.
 */
export function groupTranscriptRows(rows: readonly TranscriptRow[]): TranscriptRow[] {
  const grouped: TranscriptRow[] = [];
  groupInto(rows, 0, grouped, []);
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

/**
 * `buildTranscriptRows`, incrementally.
 *
 * Feed it the history once, then each live envelope as it lands: an append
 * re-collapses nothing and re-groups only from the group that holds the lowest
 * row it changed — the tail, for a streamed delta or a new message; an earlier
 * chip, for a tool result; an earlier card, for an approval decision. `rows`
 * is a new array after any change and the SAME array otherwise, and rows that
 * did not change keep their object identity, so a memoised row view skips them.
 *
 * Equivalent to `buildTranscriptRows` over the same envelopes with one caveat,
 * both for restored approvals only: a live `approval_request` for a restored
 * card settles it where it was restored (a single pass would draw it at the
 * envelope's position), and a live envelope stamped earlier than `restoredAt`
 * lands below the restored card. Prepending older history is not an append:
 * start a new builder over the full list for that.
 */
export class TranscriptRowBuilder {
  private readonly collapser = new RowCollapser();
  private readonly grouped: TranscriptRow[] = [];
  private readonly starts: number[] = [];
  private snapshot: TranscriptRow[] = [];

  /** The grouped rows, as a stable array until the next change. */
  get rows(): TranscriptRow[] {
    return this.snapshot;
  }

  /** Fold envelopes onto the end. Returns `rows`. */
  append(envelopes: readonly AgentChatEventEnvelope[]): TranscriptRow[] {
    this.collapser.append(envelopes);
    return this.flush();
  }

  /**
   * Add the approvals the runtime is still blocked on (see
   * `collapseTranscriptEvents`). Call once, after the history append.
   */
  restore(pendingApprovals: readonly ApprovalRequest[], restoredAt?: string): TranscriptRow[] {
    this.collapser.restore(pendingApprovals, restoredAt);
    return this.flush();
  }

  private flush(): TranscriptRow[] {
    const dirty = this.collapser.takeDirty();
    if (!Number.isFinite(dirty)) return this.snapshot;
    // The last group starting at or before the first changed row; everything
    // before it is untouched by construction.
    let group = this.starts.length - 1;
    while (group >= 0 && this.starts[group]! > dirty) group -= 1;
    const resumeGroup = Math.max(0, group);
    const resumeRaw = this.starts[resumeGroup] ?? 0;
    this.grouped.length = resumeGroup;
    this.starts.length = resumeGroup;
    groupInto(this.collapser.raw, resumeRaw, this.grouped, this.starts);
    this.snapshot = this.grouped.slice();
    return this.snapshot;
  }
}

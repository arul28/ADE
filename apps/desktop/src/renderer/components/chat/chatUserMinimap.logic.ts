import type { ChatTranscriptGroupedEnvelope } from "./chatTranscriptRows";
import { summarizeInlineText } from "./chatTranscriptRows";

/** Comfortable-density default; keep aligned with `transcriptRowGapPx("comfortable")` in chatAppearance. */
export const CHAT_TIMELINE_ROW_GAP_PX = 14;

/** Vertical distance between two adjacent ticks at natural (uncompressed) density. */
export const CHAT_USER_MINIMAP_TICK_SPACING_PX = 8;

/** Rail is inset from the list's left edge by this much; the hit strip starts here. */
export const CHAT_USER_MINIMAP_HIT_STRIP_LEFT_PX = 12;

/** Widest the invisible pointer strip may ever get, even in a very wide gutter. */
export const CHAT_USER_MINIMAP_HIT_STRIP_MAX_WIDTH_PX = 40;

/** At/above this gutter the ticks can stay visible without crowding the message column. */
export const CHAT_USER_MINIMAP_PERSISTENT_GUTTER_PX = 48;

/** Once a preview is open, keep the strip wide enough to cover the preview card. */
export const CHAT_USER_MINIMAP_EXPANDED_HIT_STRIP_WIDTH = "22rem";

/** Breathing room kept above + below the rail inside its available column. */
export const CHAT_USER_MINIMAP_RAIL_PADDING_PX = 32;

/** Below this available height the rail is more noise than navigation. */
export const CHAT_USER_MINIMAP_RAIL_MIN_AVAILABLE_PX = 140;

/** Breathing room kept between the floating PR pane's bottom edge and the rail. */
export const CHAT_USER_MINIMAP_PR_PANE_GAP_PX = 12;

const PREVIEW_MAX_CHARS = 140;
const ASSISTANT_PREVIEW_MAX_CHARS = 220;

export type ChatUserMinimapTurnOutcome = "completed" | "interrupted" | "failed";

export type ChatUserMinimapSourceEntry = {
  /** Index in `groupedRows` for this user message. */
  rowIndex: number;
  /** Stable key for React lists. */
  key: string;
  /** Truncated prompt preview. */
  preview: string;
  /** Index into the full user-message list, 0..fullCount-1 (also this entry's array index). */
  fullUserOrdinal: number;
  /** Last assistant `text` reply produced before the next user message; `null` when none. */
  assistantPreview: string | null;
  /** How this user message's turn ended; `null` while it is still running. */
  turnOutcome: ChatUserMinimapTurnOutcome | null;
};

type TimelineUserMessageRow = ChatTranscriptGroupedEnvelope & {
  event: Extract<ChatTranscriptGroupedEnvelope["event"], { type: "user_message" }>;
};

/** User bubbles shown in the timeline (excludes queued composer-only steers). */
export function isTimelineUserMessageRow(row: ChatTranscriptGroupedEnvelope): row is TimelineUserMessageRow {
  const { event } = row;
  if (event.type !== "user_message") return false;
  if (event.deliveryState === "queued" && event.steerId) return false;
  return true;
}

function terminalTurnOutcome(value: string | undefined): ChatUserMinimapTurnOutcome | null {
  return value === "completed" || value === "interrupted" || value === "failed" ? value : null;
}

/**
 * Per-user-message span state, folded in the same forward pass that collects the
 * entries: everything between a user row and the next one belongs to that turn.
 */
type MinimapSpanAccumulator = {
  entry: ChatUserMinimapSourceEntry;
  lastAssistantText: string | null;
  lastDoneStatus: ChatUserMinimapTurnOutcome | null;
  /** `undefined` until a `status` row is seen; "started" stays non-terminal. */
  lastStatusTurnStatus: string | undefined;
};

function settleSpan(span: MinimapSpanAccumulator | null): void {
  if (!span) return;
  const assistantPreview = span.lastAssistantText
    ? summarizeInlineText(span.lastAssistantText, ASSISTANT_PREVIEW_MAX_CHARS)
    : "";
  span.entry.assistantPreview = assistantPreview.length ? assistantPreview : null;
  // `done` is authoritative; `status` only fills in for runtimes that never emit one.
  span.entry.turnOutcome = span.lastDoneStatus ?? terminalTurnOutcome(span.lastStatusTurnStatus);
}

export function collectUserMessageMinimapSourceEntries(
  groupedRows: readonly ChatTranscriptGroupedEnvelope[],
): ChatUserMinimapSourceEntry[] {
  const out: ChatUserMinimapSourceEntry[] = [];
  let fullUserOrdinal = 0;
  let span: MinimapSpanAccumulator | null = null;
  for (let rowIndex = 0; rowIndex < groupedRows.length; rowIndex += 1) {
    const row = groupedRows[rowIndex]!;
    if (isTimelineUserMessageRow(row)) {
      // A user row closes the previous span even when it produces no entry of
      // its own (hidden handoff prompts), so a later turn can never leak into it.
      settleSpan(span);
      span = null;
      const event = row.event;
      const hideFullPrompt = event.metadata?.hideFullPrompt === true;
      const previewSource = hideFullPrompt ? (event.displayText?.trim() ?? "") : (event.text ?? "");
      const preview = summarizeInlineText(previewSource, PREVIEW_MAX_CHARS);
      if (hideFullPrompt && preview.length === 0) continue;
      const entry: ChatUserMinimapSourceEntry = {
        rowIndex,
        key: row.key,
        preview: preview.length ? preview : "(empty message)",
        fullUserOrdinal,
        assistantPreview: null,
        turnOutcome: null,
      };
      out.push(entry);
      fullUserOrdinal += 1;
      span = { entry, lastAssistantText: null, lastDoneStatus: null, lastStatusTurnStatus: undefined };
      continue;
    }

    if (!span) continue;
    const { event } = row;
    if (event.type === "text") {
      const text = event.text.trim();
      if (text.length) span.lastAssistantText = text;
      continue;
    }
    if (event.type === "done") {
      span.lastDoneStatus = terminalTurnOutcome(event.status);
      continue;
    }
    if (event.type === "status") {
      span.lastStatusTurnStatus = event.turnStatus;
    }
  }
  settleSpan(span);
  return out;
}

/** Y-offset of each row's top edge within the scrollable timeline (matches list virtualizer math). */
export function computeRowStartOffsets(
  rowCount: number,
  rowHeight: (index: number) => number,
  rowGap: number = CHAT_TIMELINE_ROW_GAP_PX,
): number[] {
  const offsets = new Array<number>(rowCount);
  let y = 0;
  for (let i = 0; i < rowCount; i += 1) {
    offsets[i] = y;
    y += rowHeight(i) + rowGap;
  }
  return offsets;
}

export function computeScrollTopForRow(
  rowIndex: number,
  offsets: readonly number[],
): number {
  if (rowIndex < 0 || rowIndex >= offsets.length) return 0;
  return offsets[rowIndex] ?? 0;
}

/** Row occupying a given scroll position, plus how far into it that position sits. */
export type ChatRowScrollAnchor = {
  index: number;
  offsetPx: number;
};

/**
 * Inverse of `computeScrollTopForRow`: which row a scroll position lands in.
 *
 * The prepend anchor, the scroll restore and the unmount snapshot all have to
 * agree about where a row starts, so they all read the SAME offsets array rather
 * than each re-accumulating `height + gap` by hand. A scroll position past the
 * end resolves to the last row (with a positive overshoot in `offsetPx`), which
 * is what restoring a reader parked at the tail needs.
 */
export function resolveRowAnchorAtScrollTop(
  offsets: readonly number[],
  scrollTop: number,
): ChatRowScrollAnchor | null {
  if (offsets.length === 0) return null;
  for (let i = 0; i < offsets.length; i += 1) {
    const nextTop = offsets[i + 1];
    if (nextTop === undefined || scrollTop < nextTop) {
      return { index: i, offsetPx: scrollTop - (offsets[i] ?? 0) };
    }
  }
  const lastIndex = offsets.length - 1;
  return { index: lastIndex, offsetPx: scrollTop - (offsets[lastIndex] ?? 0) };
}

/**
 * Which user message (ordinal in the full user list) is closest to the top of the viewport.
 *
 * Ticks are positioned by percentage, so they compress instead of overflowing and
 * the rail never needs a marker cap or subsampling. Sampling would also break the
 * strict 1:1 index↔entry correspondence that pointer→index mapping depends on
 * (the lens and preview would select the wrong message), so this ordinal doubles
 * as the active tick index — no display-index translation step exists.
 */
export function computeActiveFullUserOrdinal(
  scrollTop: number,
  fullEntries: readonly ChatUserMinimapSourceEntry[],
  offsets: readonly number[],
): number | null {
  if (!fullEntries.length || offsets.length === 0) return null;
  let bestOrdinal = 0;
  for (let i = 0; i < fullEntries.length; i += 1) {
    const rowIndex = fullEntries[i]!.rowIndex;
    const top = offsets[rowIndex];
    if (top == null) continue;
    if (top <= scrollTop + 1) {
      bestOrdinal = fullEntries[i]!.fullUserOrdinal;
    } else {
      break;
    }
  }
  return bestOrdinal;
}

/**
 * Empty space between the list's left edge and the centered content column.
 *
 * Both widths are MEASURED at runtime (list root and content wrapper) rather than
 * assumed from the column's max-width: that is what makes the pane-reserve padding
 * and narrow grid tiles line up automatically instead of drifting.
 */
export function resolveMinimapSideGutter(listWidthPx: number, columnWidthPx: number): number {
  if (!Number.isFinite(listWidthPx) || listWidthPx <= 0) return 0;
  if (!Number.isFinite(columnWidthPx) || columnWidthPx <= 0) return 0;
  return Math.max(0, (listWidthPx - Math.min(listWidthPx, columnWidthPx)) / 2);
}

/**
 * The rail overlays the list's left edge while the content column is centered, so
 * the gutter shrinks under zoom or in a narrow pane. A fixed-width hover strip
 * would then sit on top of message text and swallow its pointer events. Cap the
 * strip so it never reaches into the column; 0 means the rail must be rendered
 * `pointer-events-none` so it can never block text selection.
 */
export function resolveMinimapHitStripWidth(listWidthPx: number, columnWidthPx: number): number {
  const gutter = resolveMinimapSideGutter(listWidthPx, columnWidthPx);
  return Math.max(
    0,
    Math.min(
      CHAT_USER_MINIMAP_HIT_STRIP_MAX_WIDTH_PX,
      Math.floor(gutter) - CHAT_USER_MINIMAP_HIT_STRIP_LEFT_PX,
    ),
  );
}

/** Wide enough that ticks can stay visible instead of only appearing on hover. */
export function minimapHasPersistentGutter(listWidthPx: number, columnWidthPx: number): boolean {
  return resolveMinimapSideGutter(listWidthPx, columnWidthPx) >= CHAT_USER_MINIMAP_PERSISTENT_GUTTER_PX;
}

/** Tick position as a percentage of rail height — compresses instead of overflowing. */
export function resolveMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) return 0;
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function resolveMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) return null;
  if (input.itemCount === 1) return 0;
  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

/**
 * OFF-SCREEN-PREVIEW FIX: a preview centered on its tick hangs off the top of the
 * list at the first tick and off the bottom at the last one. Anchor the card's top
 * edge to the first tick and its bottom edge to the last, centering only in between.
 */
export function resolveMinimapPreviewTranslateY(index: number, itemCount: number): string {
  if (index <= 0) return "0%";
  if (index >= itemCount - 1) return "-100%";
  return "-50%";
}

/**
 * Rail starts below the floating PR pane when one is mounted.
 *
 * BOTH inputs are viewport-space edges, and that is the whole point: the pane is
 * positioned against the chat SURFACE (`absolute top-3`) while the rail is
 * positioned against the message-list root, which sits below the chat header and
 * the sync hairline. Measuring a pane HEIGHT and adding its `top-3` back as a
 * constant would silently be wrong by the height of everything between those two
 * origins — a header, a banner, a hairline — and no constant can fix that. A
 * viewport-space subtraction stays correct for any future chrome above the list.
 */
export function resolveMinimapRailTopInset(
  prPaneBottomViewportPx: number | null,
  listRootTopViewportPx: number,
): number {
  if (prPaneBottomViewportPx === null) return 0;
  if (!Number.isFinite(prPaneBottomViewportPx) || !Number.isFinite(listRootTopViewportPx)) return 0;
  return Math.max(
    0,
    prPaneBottomViewportPx - listRootTopViewportPx + CHAT_USER_MINIMAP_PR_PANE_GAP_PX,
  );
}

/**
 * Height in px (not vh): the rail centres in the space REMAINING below the PR
 * pane, which is not the viewport height.
 */
export function resolveMinimapRailHeightStyle(itemCount: number, availablePx: number): string {
  const naturalHeight = (itemCount - 1) * CHAT_USER_MINIMAP_TICK_SPACING_PX;
  const cappedHeight = Math.min(naturalHeight, availablePx - CHAT_USER_MINIMAP_RAIL_PADDING_PX);
  return `${Math.max(1, cappedHeight)}px`;
}

/** Too little room left to render a usable rail. */
export function minimapRailInert(availablePx: number): boolean {
  return availablePx < CHAT_USER_MINIMAP_RAIL_MIN_AVAILABLE_PX;
}

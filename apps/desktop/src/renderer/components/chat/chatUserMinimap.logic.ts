import type { ChatTranscriptGroupedEnvelope } from "./chatTranscriptRows";
import { summarizeInlineText } from "./chatTranscriptRows";

/** Comfortable-density default; keep aligned with `transcriptRowGapPx("comfortable")` in chatAppearance. */
export const CHAT_TIMELINE_ROW_GAP_PX = 14;

/** Cap marker count on very long threads (avoids rail overflow). */
export const CHAT_USER_MINIMAP_MAX_MARKERS = 80;

const PREVIEW_MAX_CHARS = 140;

export type ChatUserMinimapSourceEntry = {
  /** Index in `groupedRows` for this user message. */
  rowIndex: number;
  /** Stable key for React lists. */
  key: string;
  /** Truncated prompt preview. */
  preview: string;
  /** Index into the full (unsampled) user-message list, 0..fullCount-1. */
  fullUserOrdinal: number;
};

export type ChatUserMinimapDisplayEntry = ChatUserMinimapSourceEntry & {
  /** Ordinal among displayed markers (0..displayedCount-1). */
  displayOrdinal: number;
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

export function collectUserMessageMinimapSourceEntries(
  groupedRows: readonly ChatTranscriptGroupedEnvelope[],
): ChatUserMinimapSourceEntry[] {
  const out: ChatUserMinimapSourceEntry[] = [];
  let fullUserOrdinal = 0;
  for (let rowIndex = 0; rowIndex < groupedRows.length; rowIndex += 1) {
    const row = groupedRows[rowIndex]!;
    if (!isTimelineUserMessageRow(row)) continue;
    const event = row.event;
    const preview = summarizeInlineText(event.text ?? "", PREVIEW_MAX_CHARS);
    out.push({
      rowIndex,
      key: row.key,
      preview: preview.length ? preview : "(empty message)",
      fullUserOrdinal,
    });
    fullUserOrdinal += 1;
  }
  return out;
}

/**
 * Evenly subsamples user markers when there are too many for the rail.
 * Always keeps the first and last user message.
 */
export function sampleMinimapSourceEntries(
  entries: readonly ChatUserMinimapSourceEntry[],
  maxMarkers: number = CHAT_USER_MINIMAP_MAX_MARKERS,
): ChatUserMinimapSourceEntry[] {
  if (entries.length <= maxMarkers) return [...entries];
  if (maxMarkers < 2) return entries.length ? [entries[0]!] : [];

  const pickedOrdinals = new Set<number>();
  pickedOrdinals.add(0);
  pickedOrdinals.add(entries.length - 1);
  const innerSlots = maxMarkers - 2;
  for (let k = 1; k <= innerSlots; k += 1) {
    const idx = Math.round((k * (entries.length - 1)) / (innerSlots + 1));
    pickedOrdinals.add(Math.max(0, Math.min(entries.length - 1, idx)));
  }

  return [...pickedOrdinals]
    .sort((a, b) => a - b)
    .map((ordinal) => entries[ordinal]!);
}

export function buildMinimapDisplayEntries(
  groupedRows: readonly ChatTranscriptGroupedEnvelope[],
  maxMarkers: number = CHAT_USER_MINIMAP_MAX_MARKERS,
): ChatUserMinimapDisplayEntry[] {
  const source = collectUserMessageMinimapSourceEntries(groupedRows);
  const sampled = sampleMinimapSourceEntries(source, maxMarkers);
  return sampled.map((entry, displayOrdinal) => ({ ...entry, displayOrdinal }));
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

/**
 * Which user message (ordinal in the full user list) is closest to the top of the viewport.
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
 * Maps the active full user ordinal to an index in the (possibly sampled) display list.
 */
export function computeActiveDisplayIndex(
  activeFullUserOrdinal: number | null,
  displayEntries: readonly ChatUserMinimapDisplayEntry[],
): number | null {
  if (activeFullUserOrdinal == null || !displayEntries.length) return null;
  let bestIndex = 0;
  for (let i = 0; i < displayEntries.length; i += 1) {
    if (displayEntries[i]!.fullUserOrdinal <= activeFullUserOrdinal) {
      bestIndex = i;
    } else {
      break;
    }
  }
  return bestIndex;
}

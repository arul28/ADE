import { useMemo, useRef } from "react";
import type { AgentChatEvent, AgentChatEventEnvelope } from "../../../shared/types/chat";
import type { ChatTranscriptGroupedEnvelope, ChatWorkLogEntry } from "./chatTranscriptRows";
import { dedupeChatToolActivityEntries } from "./ChatWorkLogBlock";
import {
  classifyProviderRetryCause,
  formatLegacyProviderRetryActivityDetail,
  formatProviderRetryActivityDetail,
  isLegacyProviderRetryNotice,
  isProviderRetryActivityEvent,
  isProviderRetryTurnBoundary,
  isSameTurnProviderRetrySteer,
} from "../../../shared/providerRetryPresentation";

export type TranscriptToolActivity = {
  byDoneRowKey: Map<string, ChatWorkLogEntry[]>;
  activeEntries: ChatWorkLogEntry[];
  fileEntriesByDoneRowKey: Map<string, ChatWorkLogEntry[]>;
  activeFileEntries: ChatWorkLogEntry[];
};

export function getEventTurnId(event: AgentChatEvent): string | null {
  if (!("turnId" in event) || typeof event.turnId !== "string") return null;
  const turnId = event.turnId.trim();
  return turnId.length ? turnId : null;
}

/**
 * Dedupe by entry id, KEEPING `file_change` entries.
 *
 * `deriveTranscriptToolActivity` builds a turn's entries by concatenating the
 * by-turn-id accumulator with the pending segment, and a group carrying a
 * turnId lands in both — so the raw list holds every entry twice.
 * `dedupeChatToolActivityEntries` happens to absorb that for the tool panel,
 * but it also drops file changes, which the files-changed summary needs. Undo
 * this doubling here or every diffstat renders at 2x.
 */
function dedupeWorkLogEntriesById(entries: ChatWorkLogEntry[]): ChatWorkLogEntry[] {
  const byId = new Map<string, ChatWorkLogEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  return Array.from(byId.values());
}

function sameEntryList(left: readonly ChatWorkLogEntry[], right: readonly ChatWorkLogEntry[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function stabilizeEntryMap(
  previous: Map<string, ChatWorkLogEntry[]>,
  next: Map<string, ChatWorkLogEntry[]>,
): Map<string, ChatWorkLogEntry[]> {
  const stabilized = new Map<string, ChatWorkLogEntry[]>();
  for (const [key, entries] of next) {
    const before = previous.get(key);
    stabilized.set(key, before && sameEntryList(before, entries) ? before : entries);
  }
  return stabilized;
}

function entryMapsIdentical(
  previous: Map<string, ChatWorkLogEntry[]>,
  next: Map<string, ChatWorkLogEntry[]>,
): boolean {
  if (previous.size !== next.size) return false;
  for (const [key, entries] of next) {
    if (previous.get(key) !== entries) return false;
  }
  return true;
}

/**
 * Reuse the previous arrays wherever a turn's entries did not actually change.
 *
 * `deriveTranscriptToolActivity` re-runs on every transcript change — including
 * each streaming delta — and builds fresh arrays for EVERY completed turn. Those
 * arrays are props on the done rows, so a new identity per tick defeated
 * `React.memo` on every turn in the thread: a 50-turn thread re-rendered 50 rows
 * per delta, and a 200-event prepend re-rendered all of them. The entries
 * themselves come from the cached collapse pipeline, so identity comparison is
 * enough to tell "unchanged" from "changed".
 */
export function stabilizeTranscriptToolActivity(
  previous: TranscriptToolActivity,
  next: TranscriptToolActivity,
): TranscriptToolActivity {
  const byDoneRowKey = stabilizeEntryMap(previous.byDoneRowKey, next.byDoneRowKey);
  const fileEntriesByDoneRowKey = stabilizeEntryMap(
    previous.fileEntriesByDoneRowKey,
    next.fileEntriesByDoneRowKey,
  );
  const activeEntries = sameEntryList(previous.activeEntries, next.activeEntries)
    ? previous.activeEntries
    : next.activeEntries;
  const activeFileEntries = sameEntryList(previous.activeFileEntries, next.activeFileEntries)
    ? previous.activeFileEntries
    : next.activeFileEntries;
  // Both maps must be checked: they are derived from the same turn entries
  // through different filters (`byDoneRowKey` drops `file_change` entries), so a
  // turn whose file changes moved while its tool entries did not would otherwise
  // pass this guard and have its fresh file entries discarded.
  if (
    activeEntries === previous.activeEntries
    && activeFileEntries === previous.activeFileEntries
    && entryMapsIdentical(previous.byDoneRowKey, byDoneRowKey)
    && entryMapsIdentical(previous.fileEntriesByDoneRowKey, fileEntriesByDoneRowKey)
  ) {
    return previous;
  }
  return { byDoneRowKey, activeEntries, fileEntriesByDoneRowKey, activeFileEntries };
}

/**
 * Element-wise identity reuse for the small derived collections the transcript
 * memoizes on `events`.
 *
 * Same rationale as `stabilizeTranscriptToolActivity` above, one level down:
 * `events` gets a fresh array identity on every streaming delta, so every
 * `useMemo([events])` rebuilds its Map/Set even though the contents almost
 * never move mid-turn. Those collections are props on EVERY row, so a new
 * identity per delta defeats `React.memo` on the whole thread — and, in
 * virtualized mode, an identity change on the derived `rowHeight`/`onMeasure`
 * callbacks also tears down and recreates each row's ResizeObserver. Reuse the
 * previous object whenever a shallow comparison says nothing changed. Values
 * are read straight off the (stable) event envelopes, so `===` on members is
 * enough to tell "unchanged" from "changed".
 */
export function deriveTranscriptToolActivity(rows: ChatTranscriptGroupedEnvelope[]): TranscriptToolActivity {
  const entriesByTurnId = new Map<string, ChatWorkLogEntry[]>();
  const byDoneRowKey = new Map<string, ChatWorkLogEntry[]>();
  const fileEntriesByDoneRowKey = new Map<string, ChatWorkLogEntry[]>();
  let pendingSegment: Array<{ entries: ChatWorkLogEntry[]; turnId: string | null }> = [];

  for (const row of rows) {
    if (row.event.type === "work_log_group") {
      const turnId = row.event.turnId ?? row.event.entries.find((entry) => entry.turnId)?.turnId ?? null;
      pendingSegment.push({ entries: row.event.entries, turnId });
      if (turnId) {
        const existing = entriesByTurnId.get(turnId) ?? [];
        existing.push(...row.event.entries);
        entriesByTurnId.set(turnId, existing);
      }
      continue;
    }
    if (row.event.type === "user_message" && row.event.deliveryState !== "queued") {
      pendingSegment = [];
      continue;
    }
    if (row.event.type !== "done") continue;
    const doneTurnId = row.event.turnId;
    const segmentEntries = pendingSegment
      .filter((group) => !doneTurnId || !group.turnId || group.turnId === doneTurnId)
      .flatMap((group) => group.entries);
    const turnEntries = doneTurnId
      ? [...(entriesByTurnId.get(doneTurnId) ?? []), ...segmentEntries]
      : segmentEntries;
    byDoneRowKey.set(row.key, dedupeChatToolActivityEntries(turnEntries));
    fileEntriesByDoneRowKey.set(row.key, dedupeWorkLogEntriesById(turnEntries));
    pendingSegment = [];
  }

  const lastBoundaryIndex = rows.findLastIndex((row) => (
    row.event.type === "done"
    || (row.event.type === "user_message" && row.event.deliveryState !== "queued")
  ));
  const activeEntries = rows
    .slice(lastBoundaryIndex + 1)
    .flatMap((row) => row.event.type === "work_log_group" ? row.event.entries : []);
  return {
    byDoneRowKey,
    activeEntries: dedupeChatToolActivityEntries(activeEntries),
    fileEntriesByDoneRowKey,
    activeFileEntries: dedupeWorkLogEntriesById(activeEntries),
  };
}

function deriveLatestActivity(events: AgentChatEventEnvelope[]): { activity: string; detail?: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i]!.event;
    if (evt.type === "activity") {
      return { activity: evt.activity, detail: evt.detail };
    }
    if (evt.type === "done") return null;
    if (evt.type === "status" && evt.turnStatus !== "started") return null;
  }
  return null;
}

// The latest provider retry for the live turn, but only while it is the newest
// signal — assistant output, tool work, or another working activity means the
// retry resolved, so the inline status clears. This also understands the old
// persisted notice shape during replay.
function deriveActiveProviderRetryActivity(
  events: AgentChatEventEnvelope[],
  activeTurnId: string | null,
): string | null {
  if (!activeTurnId) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i]!.event;
    if (isProviderRetryTurnBoundary(evt)) return null;
    const eventTurnId = getEventTurnId(evt);
    if (eventTurnId && eventTurnId !== activeTurnId) continue;
    if (isProviderRetryActivityEvent(evt)) {
      return evt.detail?.trim() || null;
    }
    if (evt.type === "api_retry") {
      const cause = evt.errorStatus === 429
        ? "rate_limit"
        : evt.errorStatus === 529
          ? "overloaded"
          : classifyProviderRetryCause("", evt.errorStatus);
      return formatProviderRetryActivityDetail({
        provider: "claude",
        attempt: evt.attempt,
        maxAttempts: evt.maxRetries,
        retryDelayMs: evt.retryDelayMs,
        cause,
      });
    }
    if (evt.type === "system_notice" && isLegacyProviderRetryNotice(evt)) {
      return formatLegacyProviderRetryActivityDetail(evt);
    }
    if (
      evt.type === "text"
      || evt.type === "reasoning"
      || evt.type === "tool_call"
      || evt.type === "tool_result"
      || evt.type === "activity"
      || evt.type === "done"
      || evt.type === "error"
      || (evt.type === "user_message" && !isSameTurnProviderRetrySteer(evt))
      || (evt.type === "status" && evt.turnStatus !== "started")
    ) {
      return null;
    }
  }
  return null;
}

function deriveActiveTurnId(events: AgentChatEventEnvelope[]): string | null {
  const completedTurnIds = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i]!.event;
    if (evt.type === "done" && evt.turnId?.trim()) {
      completedTurnIds.add(evt.turnId.trim());
      continue;
    }
    const turnId = getEventTurnId(evt);
    if (!turnId || completedTurnIds.has(turnId)) continue;
    return turnId;
  }
  return null;
}

// Wall-clock start time (ms) of the given turn — the earliest event timestamp
// tagged with that turnId. Used to anchor the working-indicator elapsed timer
// so it survives remounts (leaving/returning to the chat).
function deriveTurnStartedAt(events: AgentChatEventEnvelope[], turnId: string | null): number | null {
  if (!turnId) return null;
  let startedAt: number | null = null;
  for (const envelope of events) {
    if (getEventTurnId(envelope.event) !== turnId) continue;
    const ts = Date.parse(envelope.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (startedAt === null || ts < startedAt) startedAt = ts;
  }
  return startedAt;
}

/** When each turn started: its first `status: started` event. */
export function deriveTurnStartedAtMs(events: readonly AgentChatEventEnvelope[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const envelope of events) {
    const { event } = envelope;
    if (event.type !== "status" || event.turnStatus !== "started" || !event.turnId || map.has(event.turnId)) continue;
    const ts = Date.parse(envelope.timestamp);
    if (Number.isFinite(ts)) map.set(event.turnId, ts);
  }
  return map;
}

export function useTranscriptPresentation({
  events,
  rows,
  showStreamingIndicator,
  sessionEnded = false,
}: {
  events: AgentChatEventEnvelope[];
  rows: ChatTranscriptGroupedEnvelope[];
  showStreamingIndicator: boolean;
  sessionEnded?: boolean;
}): {
  activeTurnId: string | null;
  activeTurnStartedAt: number | null;
  latestActivity: { activity: string; detail?: string } | null;
  activeProviderRetryActivity: string | null;
  transcriptToolActivity: TranscriptToolActivity;
  turnStartedAtMs: Map<string, number>;
} {
  const previousToolActivityRef = useRef<TranscriptToolActivity | null>(null);
  const livePresentation = showStreamingIndicator && !sessionEnded;
  const transcriptToolActivity = useMemo(() => {
    const next = deriveTranscriptToolActivity(rows);
    const previous = previousToolActivityRef.current;
    const stabilized = previous ? stabilizeTranscriptToolActivity(previous, next) : next;
    previousToolActivityRef.current = stabilized;
    return stabilized;
  }, [rows]);
  const activeTurnId = useMemo(
    () => (livePresentation ? deriveActiveTurnId(events) : null),
    [events, livePresentation],
  );
  const activeTurnStartedAt = useMemo(
    () => (livePresentation ? deriveTurnStartedAt(events, activeTurnId) : null),
    [events, livePresentation, activeTurnId],
  );
  const latestActivity = useMemo(
    () => (livePresentation ? deriveLatestActivity(events) : null),
    [events, livePresentation],
  );
  const activeProviderRetryActivity = useMemo(
    () => (livePresentation ? deriveActiveProviderRetryActivity(events, activeTurnId) : null),
    [events, livePresentation, activeTurnId],
  );
  const turnStartedAtMs = useMemo(() => deriveTurnStartedAtMs(events), [events]);
  return {
    activeTurnId,
    activeTurnStartedAt,
    latestActivity,
    activeProviderRetryActivity,
    transcriptToolActivity,
    turnStartedAtMs,
  };
}

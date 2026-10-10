import type { AgentChatEventEnvelope } from "./types/chat";

export type AgentChatEventIdentity = (entry: AgentChatEventEnvelope) => string;

export interface AgentChatHistorySnapshotMergeOptions {
  /**
   * Identity keys already resident when the asynchronous history read began.
   * Existing entries absent from this watermark arrived while hydration was in
   * flight and must survive even when their timestamp sorts inside the
   * authoritative snapshot range.
   */
  arrivalWatermark?: ReadonlySet<string>;
  identityKey?: AgentChatEventIdentity;
}

const agentChatEventIdentityCache = new WeakMap<AgentChatEventEnvelope, string>();

/**
 * Cross-run event identity. Provider sequence numbers restart, so an event is
 * only a duplicate when its timestamp, type, and payload all match.
 */
export function agentChatEventIdentityKey(entry: AgentChatEventEnvelope): string {
  const cached = agentChatEventIdentityCache.get(entry);
  if (cached !== undefined) return cached;
  const key = `${entry.timestamp}#${entry.event.type}#${JSON.stringify(entry.event)}`;
  agentChatEventIdentityCache.set(entry, key);
  return key;
}

/**
 * Capture the identities already resident at the start of an asynchronous
 * history read so reconciliation can distinguish stale pre-read replay rows
 * from events received while that read was in flight.
 */
export function captureAgentChatHistoryArrivalWatermark(
  events: readonly AgentChatEventEnvelope[],
  identityKey: AgentChatEventIdentity = agentChatEventIdentityKey,
): ReadonlySet<string> {
  return new Set(events.map(identityKey));
}

function isAtOrAfter(
  candidate: AgentChatEventEnvelope,
  anchor: AgentChatEventEnvelope,
): boolean {
  const candidateTime = Date.parse(candidate.timestamp);
  const anchorTime = Date.parse(anchor.timestamp);
  if (Number.isFinite(candidateTime) && Number.isFinite(anchorTime)) {
    return candidateTime >= anchorTime;
  }
  return candidate.timestamp >= anchor.timestamp;
}

function isAfter(
  candidate: AgentChatEventEnvelope,
  anchor: AgentChatEventEnvelope,
): boolean {
  const candidateTime = Date.parse(candidate.timestamp);
  const anchorTime = Date.parse(anchor.timestamp);
  if (Number.isFinite(candidateTime) && Number.isFinite(anchorTime)) {
    return candidateTime > anchorTime;
  }
  return candidate.timestamp > anchor.timestamp;
}

function compareAgentChatEventTime(
  left: AgentChatEventEnvelope,
  right: AgentChatEventEnvelope,
): number {
  const leftTime = Date.parse(left.timestamp);
  const rightTime = Date.parse(right.timestamp);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return leftTime - rightTime;
  }
  return left.timestamp.localeCompare(right.timestamp);
}

function logicalToolItemKey(entry: AgentChatEventEnvelope): string | null {
  const event = entry.event;
  if (event.type !== "tool_call" && event.type !== "tool_result") return null;
  const itemId = event.logicalItemId?.trim() || event.itemId?.trim();
  return itemId ? `${event.turnId ?? ""}\u0000${itemId}` : null;
}

/**
 * Lists this module produced through {@link upsertRepeatedToolCalls}: no two
 * tool calls in them share a logical item key. Appending events that are not
 * tool calls or results to such a list cannot create a duplicate, so the live
 * merge skips the full-history pass for them (two scans of the whole transcript
 * per streamed event otherwise).
 */
const toolCallDedupedLists = new WeakSet<readonly AgentChatEventEnvelope[]>();

function isToolEvent(entry: AgentChatEventEnvelope): boolean {
  return entry.event.type === "tool_call" || entry.event.type === "tool_result";
}

/** Replace streamed tool-call payloads in place, retaining their original order and results. */
function upsertRepeatedToolCalls(
  events: AgentChatEventEnvelope[],
  previous: readonly AgentChatEventEnvelope[] = [],
  shouldRetainPreviousResult: (entry: AgentChatEventEnvelope) => boolean = () => true,
): AgentChatEventEnvelope[] {
  const result = upsertRepeatedToolCallsUnmarked(events, previous, shouldRetainPreviousResult);
  toolCallDedupedLists.add(result);
  return result;
}

function upsertRepeatedToolCallsUnmarked(
  events: AgentChatEventEnvelope[],
  previous: readonly AgentChatEventEnvelope[],
  shouldRetainPreviousResult: (entry: AgentChatEventEnvelope) => boolean,
): AgentChatEventEnvelope[] {
  let result = events;
  const callIndexes = new Map<string, number>();
  const callSources = new Map<string, AgentChatEventEnvelope>();
  const duplicateIndexes = new Set<number>();
  const previousCalls = new Map<string, AgentChatEventEnvelope>();
  for (const entry of previous) {
    if (entry.event.type !== "tool_call") continue;
    const key = logicalToolItemKey(entry);
    if (!key) continue;
    const previousCall = previousCalls.get(key);
    if (!previousCall || compareAgentChatEventTime(previousCall, entry) <= 0) previousCalls.set(key, entry);
  }
  for (let index = 0; index < events.length; index += 1) {
    const entry = events[index]!;
    if (entry.event.type !== "tool_call") continue;
    const key = logicalToolItemKey(entry);
    if (!key) continue;
    const earlier = callIndexes.get(key);
    if (earlier === undefined) {
      callIndexes.set(key, index);
      const previousCall = previousCalls.get(key);
      let selectedSource = entry;
      let timestamp = entry.timestamp;
      if (previousCall) {
        const comparison = compareAgentChatEventTime(previousCall, entry);
        if (comparison < 0) timestamp = previousCall.timestamp;
        // Existing live history wins an equal-millisecond tie: the incoming
        // snapshot can be stale even when both envelopes share one timestamp.
        if (comparison >= 0) selectedSource = previousCall;
      }
      callSources.set(key, selectedSource);
      if (selectedSource !== entry || timestamp !== entry.timestamp) {
        if (result === events) result = [...events];
        result[index] = { ...entry, event: selectedSource.event, timestamp };
      }
      continue;
    }
    if (result === events) result = [...events];
    const kept = result[earlier]!;
    const selectedSource = callSources.get(key)!;
    // For equal millisecond stamps, array order is the available arrival order.
    const useIncomingPayload = compareAgentChatEventTime(selectedSource, entry) <= 0;
    const timestamp = compareAgentChatEventTime(kept, entry) <= 0 ? kept.timestamp : entry.timestamp;
    if (useIncomingPayload || timestamp !== kept.timestamp) {
      result[earlier] = {
        ...kept,
        ...(useIncomingPayload ? { event: entry.event } : {}),
        timestamp,
      };
      if (useIncomingPayload) callSources.set(key, entry);
    }
    duplicateIndexes.add(index);
  }
  if (duplicateIndexes.size > 0) result = result.filter((_entry, index) => !duplicateIndexes.has(index));

  if (callIndexes.size === 0) return result;
  const resultKeys = new Set(result
    .filter((entry) => entry.event.type === "tool_result")
    .map(logicalToolItemKey)
    .filter((key): key is string => key !== null));
  const previousResults = previous.filter((entry) => entry.event.type === "tool_result");
  const missingResults = previousResults.filter((entry) => {
    const key = logicalToolItemKey(entry);
    if (!shouldRetainPreviousResult(entry) || !key || !callIndexes.has(key) || resultKeys.has(key)) return false;
    resultKeys.add(key);
    return true;
  });
  return missingResults.length ? orderAgentChatEventsChronologically([...result, ...missingResults]) : result;
}

/**
 * Keep physical event order chronological without allocating on the common
 * already-ordered path. JavaScript's stable sort preserves arrival order for
 * same-timestamp provider fragments.
 */
export function orderAgentChatEventsChronologically(
  events: AgentChatEventEnvelope[],
): AgentChatEventEnvelope[] {
  for (let index = 1; index < events.length; index += 1) {
    if (compareAgentChatEventTime(events[index]!, events[index - 1]!) < 0) {
      return [...events].sort(compareAgentChatEventTime);
    }
  }
  return events;
}

/**
 * What the live merge knows about a list it produced, so the next merge costs
 * the new events and not the whole transcript: every identity key in the list,
 * and where each tool call sits by logical item key. A list hands this on to
 * the list made from it and gives it up (the maps then describe the longer
 * list), so a list merged a second time rebuilds from scratch.
 */
type LiveMergeIndex = {
  identityKeys: Set<string>;
  /** Null until a tool event first needs it. */
  toolCallIndexByKey: Map<string, number> | null;
};

const liveMergeIndexByList = new WeakMap<readonly AgentChatEventEnvelope[], LiveMergeIndex>();

/**
 * How a list the live merge produced relates to the list it was made from:
 * the same events up to `appendedFrom` and new ones after it. The one
 * exception is a tool call a resend updated in place; `replacedIndexes` are
 * their positions (the same in both lists).
 */
export type AgentChatLiveAppend = {
  base: readonly AgentChatEventEnvelope[];
  appendedFrom: number;
  replacedIndexes: readonly number[];
};

const NO_REPLACED_INDEXES: readonly number[] = [];
const liveAppendByList = new WeakMap<readonly AgentChatEventEnvelope[], AgentChatLiveAppend>();

/**
 * The append that produced `events`, or null when the list came from anywhere
 * else (a history snapshot, a trim, an out-of-order arrival). A value derived
 * from the base list can be carried forward by looking at the appended events
 * alone, instead of folding the whole transcript again on every streamed event.
 */
export function agentChatLiveAppendOf(events: readonly AgentChatEventEnvelope[]): AgentChatLiveAppend | null {
  return liveAppendByList.get(events) ?? null;
}

/**
 * Declare the same relation for a list derived from a merged one (a filtered
 * view of it), so what is folded from the view carries forward too.
 */
export function recordAgentChatLiveAppend(
  events: readonly AgentChatEventEnvelope[],
  append: AgentChatLiveAppend,
): void {
  liveAppendByList.set(events, append);
}

function toolCallIndexFor(events: readonly AgentChatEventEnvelope[]): Map<string, number> {
  const indexByKey = new Map<string, number>();
  for (let index = 0; index < events.length; index += 1) {
    const entry = events[index]!;
    if (entry.event.type !== "tool_call") continue;
    const key = logicalToolItemKey(entry);
    if (key && !indexByKey.has(key)) indexByKey.set(key, index);
  }
  return indexByKey;
}

/**
 * {@link upsertRepeatedToolCalls} for events appended to a list that already
 * holds one tool call per logical item: only the appended events can repeat
 * one, so only they are visited. Same result as the full pass over
 * `[...existing, ...fresh]` with `existing` as the previous list; that pass
 * also restores results the new list lost, and an append loses none.
 */
function appendToToolCallDedupedList(
  existing: AgentChatEventEnvelope[],
  fresh: readonly AgentChatEventEnvelope[],
  index: LiveMergeIndex,
): AgentChatEventEnvelope[] {
  const toolCallIndexByKey = index.toolCallIndexByKey ??= toolCallIndexFor(existing);
  const result = existing.slice();
  const replacedIndexes: number[] = [];
  // The envelope whose payload a call currently shows; the stored one until a
  // resend in this batch replaces it.
  const sources = new Map<string, AgentChatEventEnvelope>();
  for (const entry of fresh) {
    const key = entry.event.type === "tool_call" ? logicalToolItemKey(entry) : null;
    const earlier = key ? toolCallIndexByKey.get(key) : undefined;
    if (!key || earlier === undefined) {
      if (key) toolCallIndexByKey.set(key, result.length);
      result.push(entry);
      continue;
    }
    // A resend: it updates the stored call and takes no row of its own.
    const kept = result[earlier]!;
    const source = sources.get(key) ?? kept;
    // For equal millisecond stamps, array order is the available arrival order.
    const useIncomingPayload = compareAgentChatEventTime(source, entry) <= 0;
    const timestamp = compareAgentChatEventTime(kept, entry) <= 0 ? kept.timestamp : entry.timestamp;
    index.identityKeys.delete(agentChatEventIdentityKey(entry));
    if (useIncomingPayload || timestamp !== kept.timestamp) {
      const replaced = {
        ...kept,
        ...(useIncomingPayload ? { event: entry.event } : {}),
        timestamp,
      };
      index.identityKeys.delete(agentChatEventIdentityKey(kept));
      index.identityKeys.add(agentChatEventIdentityKey(replaced));
      result[earlier] = replaced;
      // A call first seen in this same batch sits in the appended part.
      if (earlier < existing.length && !replacedIndexes.includes(earlier)) replacedIndexes.push(earlier);
      if (useIncomingPayload) sources.set(key, entry);
    }
  }
  liveAppendByList.set(result, { base: existing, appendedFrom: existing.length, replacedIndexes });
  return result;
}

/**
 * Merge genuinely live envelopes into their chronological position. The common
 * append-only path costs the new events (plus one array copy) and avoids
 * sorting; only a delayed or replayed envelope pays for a stable sort.
 */
export function mergeAgentChatLiveEvents(
  existing: AgentChatEventEnvelope[],
  incoming: readonly AgentChatEventEnvelope[],
): AgentChatEventEnvelope[] {
  if (!incoming.length) return existing;

  const carried = liveMergeIndexByList.get(existing);
  const seen = carried?.identityKeys ?? new Set(existing.map(agentChatEventIdentityKey));
  const fresh: AgentChatEventEnvelope[] = [];
  for (const entry of incoming) {
    const key = agentChatEventIdentityKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(entry);
  }
  if (!fresh.length) return existing;
  // `seen` now also holds the new events: it describes the merged list, so the
  // old list must not keep it.
  liveMergeIndexByList.delete(existing);
  const index: LiveMergeIndex = { identityKeys: seen, toolCallIndexByKey: carried?.toolCallIndexByKey ?? null };

  let appendAnchor = existing[existing.length - 1];
  let appendOnly = true;
  for (const entry of fresh) {
    if (appendAnchor && compareAgentChatEventTime(entry, appendAnchor) < 0) {
      appendOnly = false;
      break;
    }
    appendAnchor = entry;
  }
  if (appendOnly && toolCallDedupedLists.has(existing)) {
    let appended: AgentChatEventEnvelope[];
    if (fresh.some(isToolEvent)) {
      appended = appendToToolCallDedupedList(existing, fresh, index);
    } else {
      // New entries sit after every stored tool call, so its positions hold.
      appended = [...existing, ...fresh];
      liveAppendByList.set(appended, {
        base: existing,
        appendedFrom: existing.length,
        replacedIndexes: NO_REPLACED_INDEXES,
      });
    }
    toolCallDedupedLists.add(appended);
    liveMergeIndexByList.set(appended, index);
    return appended;
  }
  if (appendOnly) return upsertRepeatedToolCalls([...existing, ...fresh], existing);

  return upsertRepeatedToolCalls(orderAgentChatEventsChronologically([...existing, ...fresh]), existing);
}

/**
 * Reconcile an authoritative ordered history snapshot with an already-rendered
 * window without disturbing either side's physical row order.
 *
 * The snapshot owns its covered range. Existing rows before its first overlap
 * are paged scrollback; rows after its last overlap are retained only when they
 * are chronologically at or after the snapshot tail. That final check is
 * load-bearing: runtime subscription replay can otherwise append an old turn
 * after a completed latest turn and make the composer look active again.
 * Entries absent from an optional arrival watermark are the explicit exception:
 * they arrived during hydration and must not be discarded by the stale snapshot.
 */
export function mergeAgentChatHistorySnapshot(
  snapshot: AgentChatEventEnvelope[],
  existing: AgentChatEventEnvelope[],
  options: AgentChatHistorySnapshotMergeOptions = {},
): AgentChatEventEnvelope[] {
  if (!existing.length) return upsertRepeatedToolCalls(snapshot);
  if (!snapshot.length) return existing;

  const identityKey = options.identityKey ?? agentChatEventIdentityKey;
  const existingByKey = new Map<string, AgentChatEventEnvelope>();
  const existingIndexByKey = new Map<string, number>();
  for (let index = 0; index < existing.length; index += 1) {
    const entry = existing[index]!;
    const key = identityKey(entry);
    if (!existingByKey.has(key)) existingByKey.set(key, entry);
    if (!existingIndexByKey.has(key)) existingIndexByKey.set(key, index);
  }

  const snapshotKeys = new Set<string>();
  const normalizedSnapshot = snapshot.map((entry) => {
    const key = identityKey(entry);
    snapshotKeys.add(key);
    return existingByKey.get(key) ?? entry;
  });

  let firstOverlapIndex = -1;
  for (const entry of snapshot) {
    const index = existingIndexByKey.get(identityKey(entry)) ?? -1;
    if (index >= 0 && (firstOverlapIndex < 0 || index < firstOverlapIndex)) {
      firstOverlapIndex = index;
    }
  }

  const snapshotTail = snapshot[snapshot.length - 1]!;
  const lastSnapshotKey = identityKey(snapshotTail);
  let lastOverlapIndex = -1;
  for (let index = existing.length - 1; index >= 0; index -= 1) {
    if (identityKey(existing[index]!) === lastSnapshotKey) {
      lastOverlapIndex = index;
      break;
    }
  }

  const tailCandidates = lastOverlapIndex >= 0
    ? existing.slice(lastOverlapIndex + 1)
    : existing;
  const liveTail = tailCandidates.filter((entry) => (
    !snapshotKeys.has(identityKey(entry))
    && (
      lastOverlapIndex >= 0
        ? isAtOrAfter(entry, snapshotTail)
        : isAfter(entry, snapshotTail)
    )
  ));
  // The prefix is scrollback only when it joins the snapshot: the snapshot's
  // first event is already on screen, or the prefix reaches into the
  // snapshot's span. A prefix that ends before a snapshot head it never saw
  // (a stale cached view that then took live events) ends at a hole. Keeping
  // it would pin that hole, and every agent whose result fell in it would
  // read "running" forever.
  const snapshotHead = snapshot[0]!;
  const prefixJoinsSnapshot = firstOverlapIndex > 0 && (
    existingIndexByKey.has(identityKey(snapshotHead))
    || isAtOrAfter(existing[firstOverlapIndex - 1]!, snapshotHead)
  );
  const olderPrefix = prefixJoinsSnapshot
    ? existing
      .slice(0, firstOverlapIndex)
      .filter((entry) => !snapshotKeys.has(identityKey(entry)))
    : [];
  const baseMerged = olderPrefix.length || liveTail.length
    ? [...olderPrefix, ...normalizedSnapshot, ...liveTail]
    : normalizedSnapshot;
  const baseKeys = new Set(baseMerged.map(identityKey));
  const arrivalWatermark = options.arrivalWatermark;
  const inFlightEvents = arrivalWatermark
    ? existing.filter((entry) => {
      const key = identityKey(entry);
      return (
        !snapshotKeys.has(key)
        && !baseKeys.has(key)
        && !arrivalWatermark.has(key)
      );
    })
    : [];
  const merged = inFlightEvents.length
    ? orderAgentChatEventsChronologically([...baseMerged, ...inFlightEvents])
    : baseMerged;
  const reconciled = upsertRepeatedToolCalls(
    merged,
    existing,
    (entry) => arrivalWatermark !== undefined && !arrivalWatermark.has(identityKey(entry)),
  );

  if (
    reconciled.length === existing.length
    && reconciled.every((entry, index) => entry === existing[index])
  ) {
    return existing;
  }
  return reconciled;
}

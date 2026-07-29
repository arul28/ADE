import type { AgentChatEventEnvelope } from "./types/chat";

export type AgentChatEventIdentity = (entry: AgentChatEventEnvelope) => string;

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
 * Merge genuinely live envelopes into their chronological position. The common
 * append-only path keeps O(n) identity and avoids sorting; only a delayed or
 * replayed envelope pays for a stable sort.
 */
export function mergeAgentChatLiveEvents(
  existing: AgentChatEventEnvelope[],
  incoming: readonly AgentChatEventEnvelope[],
): AgentChatEventEnvelope[] {
  if (!incoming.length) return existing;

  const seen = new Set(existing.map(agentChatEventIdentityKey));
  const fresh: AgentChatEventEnvelope[] = [];
  for (const entry of incoming) {
    const key = agentChatEventIdentityKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(entry);
  }
  if (!fresh.length) return existing;

  let appendAnchor = existing[existing.length - 1];
  let appendOnly = true;
  for (const entry of fresh) {
    if (appendAnchor && compareAgentChatEventTime(entry, appendAnchor) < 0) {
      appendOnly = false;
      break;
    }
    appendAnchor = entry;
  }
  if (appendOnly) {
    return [...existing, ...fresh];
  }

  return orderAgentChatEventsChronologically([...existing, ...fresh]);
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
 */
export function mergeAgentChatHistorySnapshot(
  snapshot: AgentChatEventEnvelope[],
  existing: AgentChatEventEnvelope[],
  identityKey: AgentChatEventIdentity = agentChatEventIdentityKey,
): AgentChatEventEnvelope[] {
  if (!existing.length) return snapshot;
  if (!snapshot.length) return existing;

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
  const olderPrefix = firstOverlapIndex > 0
    ? existing
      .slice(0, firstOverlapIndex)
      .filter((entry) => !snapshotKeys.has(identityKey(entry)))
    : [];
  const merged = olderPrefix.length || liveTail.length
    ? [...olderPrefix, ...normalizedSnapshot, ...liveTail]
    : normalizedSnapshot;

  if (
    merged.length === existing.length
    && merged.every((entry, index) => entry === existing[index])
  ) {
    return existing;
  }
  return merged;
}

/**
 * Which of two usage snapshots is the later one.
 *
 * This used to be a wall-clock comparison on `lastPolledAt` alone, which is
 * only sound when every snapshot a window sees was stamped by the same clock.
 * It is not: a window can be fed by the local main process, by the brain
 * daemon, and by a remote host, and those clocks are unrelated. One
 * future-stamped snapshot from any of them latched the window permanently —
 * every genuinely newer push afterwards compared "older" and was dropped. Two
 * windows on one machine then showed different numbers forever, which is the
 * bug this file exists to close.
 *
 * The producer now stamps `revision` (`producerId` + a per-producer `seq`), so
 * ordering is decided by a counter that only ever moves forward, and only
 * within one producer. A snapshot from a *different* producer is always
 * accepted: two producers' sequences are incomparable, and the newest thing
 * this window was handed is the best answer it has.
 *
 * The unstamped path below is the legacy one — an on-disk cache written before
 * `revision` existed. It stays lenient on purpose: a cache read that cannot be
 * ordered must not be able to latch the window against live pushes.
 */
import type { UsageSnapshot } from "../../../shared/types";

function parseMs(timestamp: string | null | undefined): number | null {
  if (typeof timestamp !== "string") return null;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The newest `providerStatus[*].updatedAt` in a snapshot.
 *
 * A poll that only re-checked one provider advances this without necessarily
 * advancing `lastPolledAt`, so on the legacy path it is a second piece of
 * evidence that the snapshot is fresher than what is on screen.
 */
function latestProviderStatusMs(snapshot: UsageSnapshot): number | null {
  const statuses = snapshot.providerStatus;
  if (!statuses) return null;
  let latest: number | null = null;
  for (const status of Object.values(statuses)) {
    const updated = parseMs(status?.updatedAt);
    if (updated == null) continue;
    if (latest == null || updated > latest) latest = updated;
  }
  return latest;
}

/** True when `next` advanced past `current`, treating "absent before" as advanced. */
function advanced(next: number | null, current: number | null): boolean {
  if (next == null) return false;
  if (current == null) return true;
  return next > current;
}

export function shouldApplyUsageSnapshot(
  nextSnapshot: UsageSnapshot | null,
  currentSnapshot: UsageSnapshot | null,
): boolean {
  if (!nextSnapshot) return false;
  if (!currentSnapshot) return true;

  const nextRevision = nextSnapshot.revision;
  const currentRevision = currentSnapshot.revision;
  if (nextRevision && currentRevision) {
    // Sequences are only comparable inside one producer. Across producers the
    // arriving snapshot wins; `>=` inside a producer keeps a re-emitted
    // snapshot (the same seq returned by a read) from being dropped.
    if (nextRevision.producerId !== currentRevision.producerId) return true;
    return nextRevision.seq >= currentRevision.seq;
  }
  // Exactly one side is stamped. A stamped push must be able to replace an
  // unstamped cache, and an unstamped cache read must not be able to latch the
  // window either — neither direction has an ordering to appeal to, so accept.
  if (nextRevision || currentRevision) return true;

  // Legacy: neither side is stamped.
  const nextPolled = parseMs(nextSnapshot.lastPolledAt);
  // An unparsable stamp is accepted rather than rejected: it carries no
  // ordering, and refusing it would let one bad value freeze the meters.
  if (nextPolled == null) return true;
  const currentPolled = parseMs(currentSnapshot.lastPolledAt);
  if (currentPolled == null || nextPolled >= currentPolled) return true;

  // `lastPolledAt` went backwards, but another freshness marker moved forward,
  // so this snapshot still carries news the one on screen does not.
  if (advanced(parseMs(nextSnapshot.costsLastPolledAt), parseMs(currentSnapshot.costsLastPolledAt))) {
    return true;
  }
  return advanced(latestProviderStatusMs(nextSnapshot), latestProviderStatusMs(currentSnapshot));
}

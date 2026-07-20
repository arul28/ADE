import type { UsageSnapshot } from "../../../shared/types";

function snapshotLastPolledMs(snapshot: UsageSnapshot | null): number | null {
  if (!snapshot) return null;
  const timestamp = Date.parse(snapshot.lastPolledAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function shouldApplyUsageSnapshot(
  nextSnapshot: UsageSnapshot | null,
  currentSnapshot: UsageSnapshot | null,
): boolean {
  if (!currentSnapshot) return true;
  if (!nextSnapshot) return false;
  const nextTimestamp = snapshotLastPolledMs(nextSnapshot);
  const currentTimestamp = snapshotLastPolledMs(currentSnapshot);
  if (currentTimestamp != null && nextTimestamp == null) return false;
  return currentTimestamp == null || nextTimestamp == null || nextTimestamp >= currentTimestamp;
}

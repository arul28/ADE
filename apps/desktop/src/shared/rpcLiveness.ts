/**
 * When a call to an ADE brain times out, is the connection gone or is the
 * brain only busy? A busy brain (removing a large folder, say) still sends
 * replies and notifications, and answers `ping` from its event loop without
 * touching disk. Dropping a live connection fails every other call on it, so
 * every RPC client keeps it unless both checks below fail.
 */

/** Anything received this recently shows the connection is alive. */
export const RPC_RECENT_TRAFFIC_MS = 12_000;

/**
 * How long the `ping` that checks a timed-out connection waits. Only a brain
 * that is gone, or an event loop stalled this long, misses it. Any reply counts,
 * an error reply included (an older brain without `ping`).
 */
export const RPC_LIVENESS_PROBE_TIMEOUT_MS = 15_000;

export function hasRecentTraffic(lastInboundAt: number | null, now = Date.now()): boolean {
  return lastInboundAt != null && now - lastInboundAt < RPC_RECENT_TRAFFIC_MS;
}

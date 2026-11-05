/**
 * When a call to an ADE brain times out, is the connection gone or is the
 * brain only busy? A busy brain (removing a large folder, say) still sends
 * replies and notifications, and answers `ping` from its event loop without
 * touching disk. Dropping a live connection fails every other call on it, so
 * every RPC client keeps it unless both checks below fail.
 */

import { isRuntimeTransportTimeoutError } from "./runtimeErrors";

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

/** The part of an RPC client the liveness check needs. */
export type RpcLivenessClient = {
  isClosed(): boolean;
  lastInboundAt(): number | null;
  call(method: string, params: Record<string, unknown>, options: { timeoutMs?: number }): Promise<unknown>;
};

/**
 * Whether a connection still carries traffic: closed reads as gone, anything
 * received recently reads as alive, and otherwise one `ping` decides. Every
 * check that runs while that ping is out shares it through `inflight`, so a
 * burst of timed-out calls sends one ping, not one each. Any reply counts;
 * only a transport timeout or a close reads as gone.
 */
export function probeRpcLiveness(
  client: RpcLivenessClient,
  inflight: WeakMap<RpcLivenessClient, Promise<boolean>>,
): Promise<boolean> {
  if (client.isClosed()) return Promise.resolve(false);
  if (hasRecentTraffic(client.lastInboundAt())) return Promise.resolve(true);
  const pending = inflight.get(client);
  if (pending) return pending;
  const probe = client
    .call("ping", {}, { timeoutMs: RPC_LIVENESS_PROBE_TIMEOUT_MS })
    .then(() => true, (error: unknown) => !client.isClosed() && !isRuntimeTransportTimeoutError(error))
    .finally(() => {
      if (inflight.get(client) === probe) inflight.delete(client);
    });
  inflight.set(client, probe);
  return probe;
}

import type { OpenProjectBinding } from "../../../shared/types";

/**
 * The renderer's ref-counted live-view lease for one lane.
 *
 * The pane, full screen and the corner card all want the same picture, and the
 * Mac only ever encodes it once — but the renderer must still decide two
 * things per lane: when the stream should be running at all, and which surface
 * holds the one WebCodecs decoder. A second decoder is a second loopback
 * reader and a second decode pipeline, and a `stopStream` from the first
 * surface to unmount (the pane switching tools) is what killed the stream the
 * corner card was still showing.
 *
 * So ownership is explicit here, not implied by mount order:
 *
 * - The stream lives while at least one holder wants it: the first acquire
 *   starts it (the holder's own live view does that), the last release stops
 *   it. A pane→card hand-off never reaches zero, so the encoder never dies.
 * - The decoder belongs to the highest-priority holder, earliest first. The
 *   pane (and with it full screen) outranks the card, so reopening the pane
 *   demotes the card instead of leaving a passive pane staring at nothing.
 *
 * Pure and injectable: `stopStream` is the only side effect, and tests reset
 * the module between cases.
 */

/** The pane and full screen: the surface the picture is actually shown in. */
export const MAC_DESKTOP_LIVE_VIEW_PANE_PRIORITY = 2;
/** The corner card: a fallback holder that keeps the stream alive unseen. */
export const MAC_DESKTOP_LIVE_VIEW_CARD_PRIORITY = 1;

type LeaseHolder = {
  id: number;
  priority: number;
  runtimePin: OpenProjectBinding | null;
  onDecoderOwnershipChange: (ownsDecoder: boolean) => void;
};

type LaneLease = {
  /** Insertion order is arrival order, which is the tie-break. */
  holders: Map<number, LeaseHolder>;
  decoderOwnerId: number | null;
  nextId: number;
};

const leases = new Map<string, LaneLease>();

function bestHolder(lane: LaneLease): LeaseHolder | null {
  let best: LeaseHolder | null = null;
  for (const holder of lane.holders.values()) {
    if (!best || holder.priority > best.priority) best = holder;
  }
  return best;
}

/** Points `decoderOwnerId` at the best remaining holder, notifying both ends. */
function electDecoderOwner(lane: LaneLease): void {
  const nextId = bestHolder(lane)?.id ?? null;
  if (lane.decoderOwnerId === nextId) return;
  const previous = lane.decoderOwnerId == null ? null : lane.holders.get(lane.decoderOwnerId) ?? null;
  lane.decoderOwnerId = nextId;
  previous?.onDecoderOwnershipChange(false);
  if (nextId != null) lane.holders.get(nextId)?.onDecoderOwnershipChange(true);
}

/**
 * Stops the lane's stream once nobody holds it.
 *
 * Fire-and-forget, like every other stream stop: the encoder also stops on its
 * own when the last reader detaches, so a failed stop costs a grace period.
 */
function stopLaneStream(laneId: string, runtimePin: OpenProjectBinding | null): void {
  const api = globalThis.window?.ade?.macDesktop;
  if (!api?.stopStream) return;
  void api.stopStream({ laneId }, runtimePin).catch(() => {});
}

export type MacDesktopLiveViewLease = {
  /** Stops wanting the lane's stream. The last release stops the encoder. */
  release: () => void;
  /** True while this holder owns the decoder. */
  ownsDecoder: () => boolean;
};

export function acquireMacDesktopLiveViewLease(args: {
  laneId: string;
  /** Higher wins the decoder. Defaults to the pane's priority. */
  priority?: number;
  runtimePin?: OpenProjectBinding | null;
  onDecoderOwnershipChange?: (ownsDecoder: boolean) => void;
}): MacDesktopLiveViewLease {
  const laneId = args.laneId;
  let lane = leases.get(laneId);
  if (!lane) {
    lane = { holders: new Map(), decoderOwnerId: null, nextId: 1 };
    leases.set(laneId, lane);
  }
  const laneRef = lane;
  const holder: LeaseHolder = {
    id: laneRef.nextId,
    priority: args.priority ?? MAC_DESKTOP_LIVE_VIEW_PANE_PRIORITY,
    runtimePin: args.runtimePin ?? null,
    onDecoderOwnershipChange: args.onDecoderOwnershipChange ?? (() => {}),
  };
  laneRef.nextId += 1;
  laneRef.holders.set(holder.id, holder);
  electDecoderOwner(laneRef);

  return {
    ownsDecoder: () => laneRef.decoderOwnerId === holder.id,
    release: () => {
      const current = leases.get(laneId);
      if (current !== laneRef) return;
      if (!laneRef.holders.delete(holder.id)) return;
      if (laneRef.holders.size === 0) {
        leases.delete(laneId);
        laneRef.decoderOwnerId = null;
        holder.onDecoderOwnershipChange(false);
        stopLaneStream(laneId, holder.runtimePin);
        return;
      }
      electDecoderOwner(laneRef);
    },
  };
}

/** Test seam: how many holders and who owns the decoder. */
export function macDesktopLiveViewLeaseState(
  laneId: string,
): { holders: number; decoderOwnerId: number | null } | null {
  const lane = leases.get(laneId);
  return lane ? { holders: lane.holders.size, decoderOwnerId: lane.decoderOwnerId } : null;
}

/** Test-only reset. Module state outlives a test file otherwise. */
export function resetMacDesktopLiveViewLeasesForTests(): void {
  leases.clear();
}

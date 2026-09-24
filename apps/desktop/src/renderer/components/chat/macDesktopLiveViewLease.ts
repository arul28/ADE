import type { OpenProjectBinding } from "../../../shared/types";
import type { MacDesktopStreamStatus } from "../../../shared/types/macDesktop";

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
 * - A release tells the service only that ITS viewer left, a beat later
 *   (`MAC_DESKTOP_LIVE_VIEW_STOP_GRACE_MS`). The service drops that chat from
 *   the viewer list and stops the capture only when no chat and no phone or
 *   web viewer is left, so the desktop's last viewer leaving never cuts off a
 *   phone watching the same lane.
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
/**
 * How long a released viewer's stop waits for another viewer to arrive.
 *
 * A handover is one viewer replacing another, and the order is not always
 * "arrive, then leave": the card can go a beat before the pane mounts. The
 * wait also lets a promoted holder's own `startStream` reach the service
 * first, so the stop never finds the capture ownerless for a moment.
 */
export const MAC_DESKTOP_LIVE_VIEW_STOP_GRACE_MS = 1_000;

type LeaseHolder = {
  id: number;
  priority: number;
  /** The chat this viewer registered with `startStream`; null when none. */
  chatSessionId: string | null;
  runtimePin: OpenProjectBinding | null;
  onDecoderOwnershipChange: (ownsDecoder: boolean) => void;
};

type LaneLease = {
  /** Insertion order is arrival order, which is the tie-break. */
  holders: Map<number, LeaseHolder>;
  decoderOwnerId: number | null;
  nextId: number;
};

/**
 * One bucket per lane, keyed by the lane id alone.
 *
 * Never by the runtime pin: the pane passes a null pin ("this window's
 * machine") and the card can hold the same machine resolved. Keyed by pin,
 * the two viewers of one capture would count in two buckets, and each one
 * leaving would be "the last viewer" of its own (the Apple tool's
 * 2026-09-23 bug).
 */
const leases = new Map<string, LaneLease>();
/**
 * Viewer stops waiting out the grace, one per lane and chat. A second release
 * of the same chat inside the grace (pane, then card) replaces the first, so
 * the service hears "this chat left" once.
 */
const pendingStops = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * `startStream` calls still waiting on the host, one per lane and chat.
 *
 * A handover starts the new decoder owner while the old one's start may still
 * be in flight: the floating player asks, the pane mounts a beat later and
 * takes the decoder, and the pane asked again. The second ask joins the first,
 * so one viewer's arrival is one start on the host. A different chat still
 * asks for itself, because the host keeps a viewer list per chat.
 */
const pendingStarts = new Map<string, Promise<MacDesktopStreamStatus>>();

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

function normalizeChat(chatSessionId: string | null | undefined): string | null {
  return chatSessionId?.trim() || null;
}

/**
 * Tells the service one viewer left, after the grace.
 *
 * Skipped when a holder of the same chat is on the lane by then: the chat is
 * still watching, and dropping it would take it off the viewer list. The
 * service stops the capture only when it has nobody left at all.
 *
 * Fire-and-forget, like every other stream stop: the encoder also stops on its
 * own when the last reader detaches, so a failed stop costs a grace period.
 */
function scheduleViewerStop(
  laneId: string,
  chatSessionId: string | null,
  runtimePin: OpenProjectBinding | null,
): void {
  const key = `${laneId}\u0000${chatSessionId ?? ""}`;
  const previous = pendingStops.get(key);
  if (previous !== undefined) clearTimeout(previous);
  const timer = setTimeout(() => {
    pendingStops.delete(key);
    const lane = leases.get(laneId);
    if (lane && [...lane.holders.values()].some((holder) => holder.chatSessionId === chatSessionId)) return;
    const api = globalThis.window?.ade?.macDesktop;
    if (!api?.stopStream) return;
    void api.stopStream({ laneId, chatSessionId, localViewer: true }, runtimePin).catch(() => {});
  }, MAC_DESKTOP_LIVE_VIEW_STOP_GRACE_MS);
  pendingStops.set(key, timer);
}

/**
 * Asks the host for the lane's stream on behalf of a decoder owner.
 *
 * `fresh` is a Reconnect: the host restarts a run that has sent nothing for a
 * while instead of handing it back. It only joins another Reconnect in
 * flight: an ordinary ask in flight may be the host handing back the very
 * stale run the Reconnect is meant to replace.
 */
export function startMacDesktopLiveStream(args: {
  laneId: string;
  chatSessionId: string | null;
  runtimePin: OpenProjectBinding | null;
  fresh?: boolean;
}): Promise<MacDesktopStreamStatus> {
  const key = `${args.laneId}\u0000${normalizeChat(args.chatSessionId) ?? ""}\u0000${args.fresh ? "fresh" : ""}`;
  const pending = pendingStarts.get(key);
  if (pending) return pending;
  const started = window.ade.macDesktop.startStream(
    { laneId: args.laneId, chatSessionId: args.chatSessionId, ...(args.fresh ? { fresh: true } : {}) },
    args.runtimePin,
  ).finally(() => {
    if (pendingStarts.get(key) === started) pendingStarts.delete(key);
  });
  pendingStarts.set(key, started);
  return started;
}

export type MacDesktopLiveViewLease = {
  /**
   * Stops wanting the lane's stream. The service hears of it after the grace,
   * and stops the encoder once nobody at all watches.
   */
  release: () => void;
  /** True while this holder owns the decoder. */
  ownsDecoder: () => boolean;
};

export function acquireMacDesktopLiveViewLease(args: {
  laneId: string;
  /** Higher wins the decoder. Defaults to the pane's priority. */
  priority?: number;
  /** The chat this viewer passes to `startStream`. */
  chatSessionId?: string | null;
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
    chatSessionId: normalizeChat(args.chatSessionId),
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
      } else {
        electDecoderOwner(laneRef);
      }
      scheduleViewerStop(laneId, holder.chatSessionId, holder.runtimePin);
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
  for (const timer of pendingStops.values()) clearTimeout(timer);
  pendingStops.clear();
  pendingStarts.clear();
}

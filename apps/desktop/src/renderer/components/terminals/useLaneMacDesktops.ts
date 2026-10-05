import { useCallback, useSyncExternalStore } from "react";
import {
  desktopSeatKind,
  type DesktopSeatKind,
  type MacDesktopDisplay,
  type MacDesktopEventPayload,
  type MacDesktopLaneSummary,
} from "../../../shared/types/macDesktop";
import { isWebClientMode } from "../../lib/webClientMode";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";

/**
 * Which lanes on the tab's machine hold a Mac Desktop display, for the Work
 * sidebar's lane mark.
 *
 * One read and one subscription for the whole list, never one per row and
 * never a timer:
 *
 * - `getStatus({})` with no lane answers `lanes`, every lane holding a display
 *   on the host. It is the same capability read `useMacDesktopSupport` makes,
 *   and it runs once per project and machine.
 * - `display-created` and `display-destroyed` then move the set directly. Both
 *   carry the lane id, so a change costs no second read.
 *
 * No pin: the rows this feeds are the bound machine's lanes, and an unpinned
 * call goes to the bound runtime. The web client is left out, as it is for the
 * Apple mark.
 */

export type LaneMacDesktops = ReadonlySet<string>;

const EMPTY: LaneMacDesktops = new Set();

/** The tooltip and accessible name for a lane's desktop mark. */
export const LANE_MAC_DESKTOP_LABEL = "Mac Desktop running on this lane";

/** The mark's tooltip and accessible name for each kind of lane screen. */
export const LANE_DESKTOP_LABELS: Record<DesktopSeatKind, string> = {
  mac: LANE_MAC_DESKTOP_LABEL,
  "windows-private": "Private Windows screen",
  "windows-shared": "Using your main Windows desktop",
};

/**
 * The kind of screen a lane holds, by the shared `desktopSeatKind` rule.
 *
 * `platform` is the host's, from the feed's status read. Only a display event
 * that arrives when that read failed has no platform; a display that names a
 * seat mode is then a Windows one, because only Windows displays carry it.
 */
export function laneDesktopKind(args: {
  platform: NodeJS.Platform | null;
  display: Pick<MacDesktopDisplay, "seatMode" | "mode"> | Pick<MacDesktopLaneSummary, "seatMode">;
}): DesktopSeatKind {
  const platform = args.platform ?? (args.display.seatMode ? "win32" : null);
  return desktopSeatKind({ platform, display: args.display });
}

export type LaneDesktopSeats = {
  lanes: LaneMacDesktops;
  kinds: ReadonlyMap<string, DesktopSeatKind>;
};

/** Lane ids holding a display, from one status answer's lane list. */
export function buildLaneMacDesktops(
  lanes: ReadonlyArray<Pick<MacDesktopLaneSummary, "laneId">> | null | undefined,
): Set<string> {
  const next = new Set<string>();
  for (const lane of lanes ?? []) {
    const laneId = lane.laneId?.trim();
    if (laneId) next.add(laneId);
  }
  return next;
}

/** The set after one event, or the same set when the event changes nothing. */
export function applyLaneMacDesktopEvent(
  current: LaneMacDesktops,
  event: MacDesktopEventPayload,
): LaneMacDesktops {
  if (event.type === "display-created") {
    const laneId = event.display.laneId?.trim();
    if (!laneId || current.has(laneId)) return current;
    return new Set(current).add(laneId);
  }
  if (event.type === "display-destroyed") {
    if (!current.has(event.laneId)) return current;
    const next = new Set(current);
    next.delete(event.laneId);
    return next;
  }
  return current;
}

function sameLanes(a: LaneMacDesktops, b: LaneMacDesktops): boolean {
  if (a.size !== b.size) return false;
  for (const laneId of a) if (!b.has(laneId)) return false;
  return true;
}

export function useLaneMacDesktops(): LaneMacDesktops {
  return useLaneDesktopSeats().lanes;
}

const EMPTY_KINDS: ReadonlyMap<string, DesktopSeatKind> = new Map();
const EMPTY_SEATS: LaneDesktopSeats = { lanes: EMPTY, kinds: EMPTY_KINDS };

/**
 * One read and one subscription per project and machine, however many
 * surfaces ask: the sidebar's lane marks and the chat header's desktop button
 * share it. Reference counted, and dropped with its last reader.
 */
type SeatFeed = {
  seats: LaneDesktopSeats;
  listeners: Set<() => void>;
  dispose: () => void;
};

const feeds = new Map<string, SeatFeed>();

function openSeatFeed(): SeatFeed {
  const feed: SeatFeed = { seats: EMPTY_SEATS, listeners: new Set(), dispose: () => undefined };
  const publish = (next: LaneDesktopSeats) => {
    if (next === feed.seats) return;
    feed.seats = next;
    for (const listener of [...feed.listeners]) listener();
  };
  const api = window.ade?.macDesktop;
  if (!api?.getStatus) return feed;
  let cancelled = false;
  let platform: NodeJS.Platform | null = null;
  const applyLanes = (lanes: LaneMacDesktops, kinds: ReadonlyMap<string, DesktopSeatKind>) => {
    const sameSet = sameLanes(lanes, feed.seats.lanes);
    if (sameSet && kinds === feed.seats.kinds) return;
    publish({ lanes: sameSet ? feed.seats.lanes : lanes, kinds });
  };
  /** One event applied to a lane set and its kinds; the kind uses `platform` as known now. */
  const applyEvent = (
    lanes: LaneMacDesktops,
    kinds: ReadonlyMap<string, DesktopSeatKind>,
    event: MacDesktopEventPayload,
  ): [LaneMacDesktops, ReadonlyMap<string, DesktopSeatKind>] => {
    const nextLanes = applyLaneMacDesktopEvent(lanes, event);
    if (event.type !== "display-created") return [nextLanes, kinds];
    const laneId = event.display.laneId?.trim();
    if (!laneId) return [nextLanes, kinds];
    const kind = laneDesktopKind({ platform, display: event.display });
    return [nextLanes, kinds.get(laneId) === kind ? kinds : new Map(kinds).set(laneId, kind)];
  };
  // Events that land while the first read is in flight are held and replayed
  // onto its answer, once the host's platform is known, so a display created in
  // that gap is neither lost nor given the wrong kind.
  let pending: MacDesktopEventPayload[] | null = [];
  let unsubscribe: (() => void) | null = api.onEvent?.((event: MacDesktopEventPayload) => {
    if (event.type !== "display-created" && event.type !== "display-destroyed") return;
    if (pending) {
      pending.push(event);
      return;
    }
    applyLanes(...applyEvent(feed.seats.lanes, feed.seats.kinds, event));
  }) ?? null;
  const settle = (base: LaneMacDesktops, baseKinds: ReadonlyMap<string, DesktopSeatKind>) => {
    let lanes = base;
    let kinds = baseKinds;
    for (const event of pending ?? []) [lanes, kinds] = applyEvent(lanes, kinds, event);
    pending = null;
    applyLanes(lanes, kinds);
  };
  void api.getStatus({})
    .then((status) => {
      if (cancelled) return;
      // A host that cannot host a display has nothing to mark, now or later.
      if (!status?.supported) {
        pending = null;
        unsubscribe?.();
        unsubscribe = null;
        return;
      }
      platform = status.platform ?? null;
      const kinds = new Map<string, DesktopSeatKind>();
      for (const lane of status.lanes ?? []) {
        const laneId = lane.laneId?.trim();
        if (laneId) kinds.set(laneId, laneDesktopKind({ platform, display: lane }));
      }
      settle(buildLaneMacDesktops(status.lanes), kinds);
    })
    .catch(() => {
      // An unreachable host is not "no displays"; events still move the set.
      if (!cancelled) settle(feed.seats.lanes, feed.seats.kinds);
    });
  feed.dispose = () => {
    cancelled = true;
    unsubscribe?.();
    unsubscribe = null;
  };
  return feed;
}

function retainSeatFeed(scope: string, listener: () => void): () => void {
  let feed = feeds.get(scope);
  if (!feed) {
    feed = openSeatFeed();
    feeds.set(scope, feed);
  }
  feed.listeners.add(listener);
  const held = feed;
  return () => {
    held.listeners.delete(listener);
    if (held.listeners.size > 0) return;
    held.dispose();
    if (feeds.get(scope) === held) feeds.delete(scope);
  };
}

/** The same read as `useLaneMacDesktops`, plus which screen each lane holds. */
export function useLaneDesktopSeats(): LaneDesktopSeats {
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const bindingKey = useAppStore((state) => state.projectBinding?.key ?? null);
  const scope = isWebClientMode() ? null : `${bindingKey ?? ""}\u0000${projectRoot ?? ""}`;
  const subscribe = useCallback(
    (listener: () => void) => (scope ? retainSeatFeed(scope, listener) : () => undefined),
    [scope],
  );
  // A new project or machine starts empty rather than showing the last one's marks.
  const read = useCallback(() => (scope ? feeds.get(scope)?.seats ?? EMPTY_SEATS : EMPTY_SEATS), [scope]);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * The desktop a single lane holds, or null. For the chat header's button; it
 * shares the list's one read rather than opening a per-lane one.
 */
export function useLaneDesktopSeat(laneId: string | null | undefined): DesktopSeatKind | null {
  return laneDesktopSeat(useLaneDesktopSeats(), laneId);
}

/** The desktop a lane holds in one seats answer, or null when it holds none. */
export function laneDesktopSeat(seats: LaneDesktopSeats, laneId: string | null | undefined): DesktopSeatKind | null {
  if (!laneId || !seats.lanes.has(laneId)) return null;
  return seats.kinds.get(laneId) ?? null;
}

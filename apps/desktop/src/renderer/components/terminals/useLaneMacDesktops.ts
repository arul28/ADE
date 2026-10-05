import { useCallback, useSyncExternalStore } from "react";
import type {
  MacDesktopDisplay,
  MacDesktopEventPayload,
  MacDesktopLaneSummary,
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

/**
 * Which screen a lane holds, for the mark's glyph and words. A Windows host
 * runs either the private child session or the user's own desktop.
 */
export type LaneDesktopKind = "mac" | "windows-private" | "windows-shared";

export const LANE_DESKTOP_LABELS: Record<LaneDesktopKind, string> = {
  mac: LANE_MAC_DESKTOP_LABEL,
  "windows-private": "Private Windows screen",
  "windows-shared": "Using your main Windows desktop",
};

/** The kind from what the host reported: its platform and the lane's seat. */
export function laneDesktopKind(args: {
  platform: NodeJS.Platform | null;
  seatMode?: string | null;
  mode?: MacDesktopDisplay["mode"] | null;
}): LaneDesktopKind {
  const windows = args.platform === "win32" || Boolean(args.seatMode);
  if (!windows) return "mac";
  return args.seatMode === "shared" || (!args.seatMode && args.mode === "offscreen-region")
    ? "windows-shared"
    : "windows-private";
}

export type LaneDesktopSeats = {
  lanes: LaneMacDesktops;
  kinds: ReadonlyMap<string, LaneDesktopKind>;
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

const EMPTY_KINDS: ReadonlyMap<string, LaneDesktopKind> = new Map();
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
  const withKind = (laneId: string, kind: LaneDesktopKind): ReadonlyMap<string, LaneDesktopKind> => {
    if (feed.seats.kinds.get(laneId) === kind) return feed.seats.kinds;
    return new Map(feed.seats.kinds).set(laneId, kind);
  };
  const applyLanes = (lanes: LaneMacDesktops, kinds: ReadonlyMap<string, LaneDesktopKind>) => {
    const sameSet = sameLanes(lanes, feed.seats.lanes);
    if (sameSet && kinds === feed.seats.kinds) return;
    publish({ lanes: sameSet ? feed.seats.lanes : lanes, kinds });
  };
  // Events that land while the first read is in flight are replayed onto its
  // answer, so a display created in that gap is not lost.
  let pending: MacDesktopEventPayload[] | null = [];
  let unsubscribe: (() => void) | null = api.onEvent?.((event: MacDesktopEventPayload) => {
    if (event.type !== "display-created" && event.type !== "display-destroyed") return;
    const kinds = event.type === "display-created"
      ? withKind(event.display.laneId, laneDesktopKind({
        platform,
        seatMode: event.display.seatMode,
        mode: event.display.mode,
      }))
      : feed.seats.kinds;
    if (pending) {
      pending.push(event);
      if (kinds !== feed.seats.kinds) publish({ lanes: feed.seats.lanes, kinds });
    } else {
      applyLanes(applyLaneMacDesktopEvent(feed.seats.lanes, event), kinds);
    }
  }) ?? null;
  const settle = (base: LaneMacDesktops, kinds: ReadonlyMap<string, LaneDesktopKind>) => {
    let next = base;
    for (const event of pending ?? []) next = applyLaneMacDesktopEvent(next, event);
    pending = null;
    applyLanes(next, kinds);
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
      const fromRead = (status.lanes ?? []).flatMap((lane) => {
        const laneId = lane.laneId?.trim();
        return laneId ? [[laneId, laneDesktopKind({ platform, seatMode: lane.seatMode })] as const] : [];
      });
      // An event that landed while the read was out is newer than the read.
      settle(buildLaneMacDesktops(status.lanes), new Map([...fromRead, ...feed.seats.kinds]));
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
export function useLaneDesktopSeat(laneId: string | null | undefined): LaneDesktopKind | null {
  const seats = useLaneDesktopSeats();
  if (!laneId || !seats.lanes.has(laneId)) return null;
  return seats.kinds.get(laneId) ?? "mac";
}

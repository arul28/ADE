import { useEffect, useRef, useState } from "react";
import type { MacDesktopEventPayload, MacDesktopLaneSummary } from "../../../shared/types/macDesktop";
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
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const bindingKey = useAppStore((state) => state.projectBinding?.key ?? null);
  const scope = isWebClientMode() ? null : `${bindingKey ?? ""}\u0000${projectRoot ?? ""}`;
  const [desktops, setDesktops] = useState<LaneMacDesktops>(EMPTY);
  const desktopsRef = useRef<LaneMacDesktops>(EMPTY);

  // A new project or machine starts empty rather than showing the last one's marks.
  useEffect(() => {
    desktopsRef.current = EMPTY;
    setDesktops(EMPTY);
    if (!scope) return undefined;
    const api = window.ade?.macDesktop;
    if (!api?.getStatus) return undefined;
    let cancelled = false;
    const apply = (next: LaneMacDesktops) => {
      if (sameLanes(next, desktopsRef.current)) return;
      desktopsRef.current = next;
      setDesktops(next);
    };
    // Events that land while the first read is in flight are replayed onto its
    // answer, so a display created in that gap is not lost.
    let pending: MacDesktopEventPayload[] | null = [];
    let unsubscribe: (() => void) | null = api.onEvent?.((event: MacDesktopEventPayload) => {
      if (event.type !== "display-created" && event.type !== "display-destroyed") return;
      if (pending) pending.push(event);
      else apply(applyLaneMacDesktopEvent(desktopsRef.current, event));
    }) ?? null;
    const settle = (base: LaneMacDesktops) => {
      let next = base;
      for (const event of pending ?? []) next = applyLaneMacDesktopEvent(next, event);
      pending = null;
      apply(next);
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
        settle(buildLaneMacDesktops(status.lanes));
      })
      .catch(() => {
        // An unreachable host is not "no displays"; events still move the set.
        if (!cancelled) settle(desktopsRef.current);
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [scope]);

  return desktops;
}

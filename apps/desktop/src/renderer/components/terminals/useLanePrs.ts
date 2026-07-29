import { useEffect, useMemo, useState } from "react";
import type { PrSummary } from "../../../shared/types";
import { listPrsCoalesced } from "../../lib/prReadCache";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";

/**
 * ADE-mapped PRs grouped by lane id. One lazy read plus the `prs-updated` push
 * keeps it fresh without polling.
 *
 * Extracted from SessionListPane so the Work session hook can answer the
 * "Has PR" chip filter from the same data the lane-header badge renders. The
 * underlying read is coalesced and the event subscription is idempotent, so
 * more than one caller costs a listener and nothing else.
 *
 */
export function useLanePrsByLaneId(): Map<string, PrSummary[]> {
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const [prs, setPrs] = useState<PrSummary[]>([]);
  useEffect(() => {
    // `window.ade.prs` is absent in some renders (e.g. tests with a partial
    // `window.ade` mock); no-op gracefully so the badge just doesn't render.
    if (!window.ade?.prs) return;
    let cancelled = false;
    void listPrsCoalesced({ projectRoot })
      .then((list) => {
        if (!cancelled) setPrs(list);
      })
      .catch(() => {});
    const unsubscribe = window.ade.prs.onEvent((event) => {
      if (event.type === "prs-updated") setPrs(event.prs);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectRoot]);
  return useMemo(() => {
    const byLane = new Map<string, PrSummary[]>();
    for (const pr of prs) {
      const list = byLane.get(pr.laneId);
      if (list) list.push(pr);
      else byLane.set(pr.laneId, [pr]);
    }
    return byLane;
  }, [prs]);
}

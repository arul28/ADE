import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LaneSummary, OpenProjectBinding } from "../../../shared/types";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import { getGitHubSnapshotCoalesced, listPrsCoalesced } from "../../lib/prReadCache";
import { selectLaneTabPrTag, type LaneTabPrTag } from "../lanes/lanePageModel";
import { useActiveRepositoryReader } from "../../state/repositoryScope";

type CommandPaletteLanePrResult = {
  status: "loading" | "ready" | "unavailable";
  tag: LaneTabPrTag | null;
};

/**
 * Read the focused lane's PR through the same coalesced, event-driven source
 * as lane badges. The lane's PR rows come from `pin` (the lane's machine); the
 * GitHub snapshot comes from the repository reader. With no machine for
 * either, nothing is asked and the tag is unavailable.
 */
export function useCommandPaletteLanePr({
  active,
  lane,
  pin,
}: {
  active: boolean;
  lane: LaneSummary | null;
  pin: OpenProjectBinding | null;
}): CommandPaletteLanePrResult | null {
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const readerPin = useActiveRepositoryReader(active);
  const readerPinRef = useRef(readerPin);
  readerPinRef.current = readerPin;
  const readerPinKey = readerPin?.key ?? null;
  const pinKey = pin?.key ?? null;
  const laneKey = lane
    ? JSON.stringify([lane.id, lane.laneType, lane.branchRef, lane.baseRef, pinKey, readerPinKey])
    : null;
  const [result, setResult] = useState<{ key: string } & CommandPaletteLanePrResult | null>(null);
  const canRead = typeof window.ade?.prs?.listAll === "function"
    && typeof window.ade.prs.getGitHubSnapshot === "function";

  useLayoutEffect(() => {
    if (!active || !laneKey || !canRead) return;
    setResult((current) => current?.key === laneKey && current.status === "ready"
      ? { ...current, status: "loading", tag: null }
      : current);
  }, [active, canRead, laneKey]);

  useEffect(() => {
    if (
      !active
      || !lane
      || typeof window.ade?.prs?.listAll !== "function"
      || typeof window.ade.prs.getGitHubSnapshot !== "function"
      || !pin
      || !readerPinRef.current
    ) {
      if (active && lane && laneKey) setResult({ key: laneKey, status: "unavailable", tag: null });
      return undefined;
    }

    let cancelled = false;
    const publish = (prs: Parameters<typeof selectLaneTabPrTag>[1], githubPrs: Parameters<typeof selectLaneTabPrTag>[2]) => {
      if (cancelled || !laneKey) return;
      setResult({ key: laneKey, status: "ready", tag: selectLaneTabPrTag(lane, prs, githubPrs) });
    };
    const snapshotPin = readerPinRef.current;
    const refresh = () => Promise.all([
      listPrsCoalesced({ projectRoot, pin }),
      getGitHubSnapshotCoalesced({}, { projectRoot, pin: snapshotPin }),
    ]).then(([prs, snapshot]) => {
      publish(prs, snapshot?.repoPullRequests ?? []);
    }).catch(() => {
      if (!cancelled && laneKey) setResult({ key: laneKey, status: "unavailable", tag: null });
    });

    void refresh();
    const unsubscribe = typeof window.ade.prs.onEvent === "function"
      ? window.ade.prs.onEvent((event) => {
        if (event.type !== "prs-updated") return;
        void getGitHubSnapshotCoalesced({}, { projectRoot, pin: snapshotPin }).then((snapshot) => {
          publish(event.prs, snapshot?.repoPullRequests ?? []);
        }).catch(() => {});
      }, pin)
      : () => {};

    return () => {
      cancelled = true;
      unsubscribe();
    };
    // Runtime bindings can be rebuilt with the same key; preserve the in-flight
    // request and subscription unless the actual target changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, laneKey, projectRoot, pinKey, readerPinKey]);

  if (!laneKey) return null;
  if (result?.key === laneKey) return { status: result.status, tag: result.tag };
  return { status: active && canRead ? "loading" : "unavailable", tag: null };
}

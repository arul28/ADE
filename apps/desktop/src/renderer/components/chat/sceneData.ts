import { useEffect, useRef, useState } from "react";

import type { SceneDataSource } from "../../../shared/chatScene";
import type { LaneListSnapshot, PrSummary } from "../../../shared/types";
import {
  projectSceneLanes,
  projectScenePrs,
  projectSceneSessions,
  type SceneDataPayload,
} from "../../../shared/sceneDataProjection";
import { listPrsCoalesced } from "../../lib/prReadCache";
import { useAppStore } from "../../state/appStore";
import { useSessionsForPin } from "../../state/crossMachineLanes";
import { useChatMachineLanes, useChatRuntimeScope } from "./ChatRuntimeScope";

/**
 * Live ADE data for a scene that asked for it.
 *
 * A scene opts in on its marker line (`<!-- @scene data="lanes,prs" -->`) and
 * then reads `ade.data` / `ade.on("data", fn)`. The point over a scene with the
 * numbers typed into it is that it stays true: a lanes board drawn yesterday
 * shows today's lanes when it is scrolled back into view.
 *
 * The data is the CHAT's machine's, not the tab's: a chat pinned to another
 * machine sees that machine's lanes, sessions and PRs (`useChatRuntimeScope`).
 *
 * Cost rules, because a scene can sit in any transcript:
 *
 *  - Nothing new is polled. Lanes and sessions come from the stores ADE already
 *    keeps current; PRs from the coalesced `prs.listAll` read (ADE's own
 *    database, never GitHub), refreshed on the machine's `prs-updated` events
 *    (a check or review that changed) and when lanes change.
 *  - It is a component, mounted by `SceneFrame` only for a scene that asked for
 *    data and only while its frame is up, so its store subscriptions re-render
 *    nothing but itself, and a scene showing its still costs nothing.
 *  - Nothing is sent unless the snapshot's content changed, at most once per
 *    {@link SCENE_DATA_MIN_INTERVAL_MS}.
 *
 * What a scene gets is a small read-only projection: names, branches, counts
 * and states, plus `ade://` links a scene can pass to `ade.open`. No paths, no
 * transcripts, no file contents.
 */

export const SCENE_DATA_MIN_INTERVAL_MS = 1_000;
const NO_SNAPSHOTS: LaneListSnapshot[] = [];

/**
 * Feeds `send` with the requested sources while mounted. Renders nothing.
 */
export function SceneDataFeed({
  sources,
  send,
}: {
  sources: readonly SceneDataSource[];
  send: (payload: SceneDataPayload) => void;
}): null {
  const scope = useChatRuntimeScope();
  const wantLanes = sources.includes("lanes");
  const wantSessions = sources.includes("sessions");
  const wantPrs = sources.includes("prs");
  const lanes = useChatMachineLanes(scope.pin);
  // Run counts exist only in the tab's own Lanes snapshots.
  const snapshots = useAppStore((state) => (scope.pin ? NO_SNAPSHOTS : state.laneSnapshots));
  const sessions = useSessionsForPin(scope.binding);
  const [prs, setPrs] = useState<PrSummary[] | null>(null);
  /** Bumped by every PR change the chat's machine announces (checks, reviews, state). */
  const [prRevision, setPrRevision] = useState(0);
  useEffect(() => {
    if (!wantPrs) return;
    return window.ade.prs.onEvent((event) => {
      if (event.type === "prs-updated") setPrRevision((value) => value + 1);
    }, scope.pin);
  }, [wantPrs, scope.pin]);

  // PRs: once, on every announced PR change, and when lanes change. Coalesced
  // with every other reader of the same list.
  useEffect(() => {
    if (!wantPrs) return;
    let cancelled = false;
    void listPrsCoalesced({ projectRoot: scope.rootPath, pin: scope.pin })
      .then((list) => { if (!cancelled) setPrs(Array.isArray(list) ? list : []); })
      .catch(() => { if (!cancelled) setPrs((existing) => existing ?? []); });
    return () => { cancelled = true; };
  }, [wantPrs, lanes, prRevision, scope.rootPath, scope.pin]);

  const sendRef = useRef(send);
  sendRef.current = send;
  const lastSentRef = useRef("");
  const lastSentAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef<SceneDataPayload | null>(null);

  useEffect(() => {
    // Wait for the PR read before the first send, so a board that shows PRs
    // does not flash "none" first.
    if (wantPrs && prs === null) return;
    const content = {
      ...(wantLanes ? { lanes: projectSceneLanes(lanes, snapshots) } : {}),
      ...(wantSessions ? { sessions: projectSceneSessions(sessions ?? []) } : {}),
      ...(wantPrs ? { prs: projectScenePrs(prs ?? []) } : {}),
    };
    const signature = JSON.stringify(content);
    if (signature === lastSentRef.current) return;
    pendingRef.current = { at: new Date().toISOString(), ...content };
    const flush = () => {
      timerRef.current = null;
      const payload = pendingRef.current;
      if (!payload) return;
      pendingRef.current = null;
      lastSentRef.current = signature;
      lastSentAtRef.current = Date.now();
      sendRef.current(payload);
    };
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    const wait = Math.max(0, lastSentAtRef.current + SCENE_DATA_MIN_INTERVAL_MS - Date.now());
    timerRef.current = window.setTimeout(flush, wait);
  }, [wantLanes, wantSessions, wantPrs, lanes, snapshots, sessions, prs]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  return null;
}

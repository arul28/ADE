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
import { useAppStore, projectStateKeyForBinding } from "../../state/appStore";
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
  const sessionsForPin = useSessionsForPin(scope.binding);
  // A project transition can leave the chat unpinned with a null binding while
  // the project's session cache still holds its rows; read that cache by root
  // so a scene does not flash "none" for the sessions it can already see.
  const boundSessions = useAppStore((state) => {
    const key = projectStateKeyForBinding(scope.binding, scope.rootPath);
    return key ? state.sessionsCacheByProject[key] ?? null : null;
  });
  const sessions = sessionsForPin ?? boundSessions;
  const [prs, setPrs] = useState<PrSummary[] | null>(null);
  useEffect(() => {
    if (!wantPrs) return;
    return window.ade.prs.onEvent((event) => {
      // The event carries the machine's PR list, as `useLanePrs` reads it.
      if (event.type === "prs-updated") setPrs(event.prs);
    }, scope.pin);
  }, [wantPrs, scope.pin]);

  // PRs: read once and when lanes change (coalesced with every other reader of
  // the same list), and taken from each `prs-updated` the machine announces.
  useEffect(() => {
    if (!wantPrs) return;
    let cancelled = false;
    void listPrsCoalesced({ projectRoot: scope.rootPath, pin: scope.pin })
      .then((list) => { if (!cancelled) setPrs(Array.isArray(list) ? list : []); })
      .catch(() => { if (!cancelled) setPrs((existing) => existing ?? []); });
    return () => { cancelled = true; };
  }, [wantPrs, lanes, scope.rootPath, scope.pin]);

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
    if (signature === lastSentRef.current) {
      // Back to what the frame already has: drop any newer snapshot still queued,
      // or the timer would send it and the scene would show stale state.
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      pendingRef.current = null;
      return;
    }
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

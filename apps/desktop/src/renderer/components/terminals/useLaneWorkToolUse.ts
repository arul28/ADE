import { useEffect, useRef, useState } from "react";
import type {
  AppControlEventPayload,
  AppControlSession,
  BuiltInBrowserEventPayload,
  BuiltInBrowserStatus,
} from "../../../shared/types";
import { isWebClientMode } from "../../lib/webClientMode";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import { browserEventMatchesProject } from "../chat/browser/browserPanelNormalizers";
import { asBuiltInBrowserStatus } from "./useNativeToolSessions";

/**
 * Which lanes have a live App Control app, and which have browser tabs an agent
 * of theirs owns — for the Work sidebar's lane marks, beside the Apple device
 * and the Mac Desktop.
 *
 * The same shape as `useLaneMacDesktops`: one read and one subscription for the
 * whole list, never one per row and never a timer.
 *
 * - App Control: `getStatus({})` names no lane, so a user client gets every
 *   lane's session in `sessions`; `session-started` / `-updated` / `-stopped`
 *   then move the set directly. Frames (30 fps) are dropped on the first
 *   comparison.
 * - Browser: `getStatus` lists every tab with its owner lane; each `status`
 *   event carries the whole list again, so the set is rebuilt from it and only
 *   a changed set re-renders.
 *
 * No pin, as for the other marks: the rows are the bound machine's lanes. The
 * web client is left out.
 */

export type LaneWorkToolUse = {
  /** Lanes whose App Control session is running (not stopped or exited). */
  appControl: ReadonlySet<string>;
  /** Lane id to the number of browser tabs an agent of that lane owns. */
  browserTabs: ReadonlyMap<string, number>;
};

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_MAP: ReadonlyMap<string, number> = new Map();

/** The tooltip and accessible name for a lane's App Control mark. */
export const LANE_APP_CONTROL_LABEL = "App Control running on this lane";

/** The tooltip and accessible name for a lane's browser mark. */
export function laneBrowserLabel(count: number): string {
  return count === 1
    ? "An agent on this lane owns a browser tab"
    : `An agent on this lane owns ${count} browser tabs`;
}

function appControlSessionLive(session: Pick<AppControlSession, "status"> | null | undefined): boolean {
  return Boolean(session) && session?.status !== "stopped" && session?.status !== "exited";
}

/** Lanes with a live session, from one status answer's session list. */
export function buildLaneAppControls(
  sessions: ReadonlyArray<Pick<AppControlSession, "laneId" | "status">> | null | undefined,
): Set<string> {
  const next = new Set<string>();
  for (const session of sessions ?? []) {
    const laneId = session.laneId?.trim();
    if (laneId && appControlSessionLive(session)) next.add(laneId);
  }
  return next;
}

/** The set after one event, or the same set when the event changes nothing. */
export function applyLaneAppControlEvent(
  current: ReadonlySet<string>,
  event: AppControlEventPayload,
): ReadonlySet<string> {
  if (event.type !== "session-started" && event.type !== "session-updated" && event.type !== "session-stopped") {
    return current;
  }
  const laneId = event.laneId?.trim();
  if (!laneId) return current;
  const live = event.type === "session-stopped" ? false : appControlSessionLive(event.session);
  if (live === current.has(laneId)) return current;
  const next = new Set(current);
  if (live) next.add(laneId);
  else next.delete(laneId);
  return next;
}

/** Lane id to its agent-owned tab count, from one browser status. */
export function buildLaneBrowserTabs(status: Pick<BuiltInBrowserStatus, "tabs"> | null | undefined): Map<string, number> {
  const next = new Map<string, number>();
  for (const tab of status?.tabs ?? []) {
    // The lease, not the tab-strip group: a tab a person opened in a lane is
    // grouped with it and still belongs to nobody.
    const laneId = tab.ownerLaneId?.trim();
    if (!laneId || !tab.ownerChatSessionId) continue;
    next.set(laneId, (next.get(laneId) ?? 0) + 1);
  }
  return next;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function sameCounts(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

export function useLaneWorkToolUse(): LaneWorkToolUse {
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const bindingKey = useAppStore((state) => state.projectBinding?.key ?? null);
  const scope = isWebClientMode() ? null : `${bindingKey ?? ""}\u0000${projectRoot ?? ""}`;
  const [appControl, setAppControl] = useState<ReadonlySet<string>>(EMPTY_SET);
  const appControlRef = useRef<ReadonlySet<string>>(EMPTY_SET);
  const [browserTabs, setBrowserTabs] = useState<ReadonlyMap<string, number>>(EMPTY_MAP);
  const browserTabsRef = useRef<ReadonlyMap<string, number>>(EMPTY_MAP);

  // App Control. A new project or machine starts empty.
  useEffect(() => {
    appControlRef.current = EMPTY_SET;
    setAppControl(EMPTY_SET);
    if (!scope) return undefined;
    const api = window.ade?.appControl;
    if (!api?.getStatus) return undefined;
    let cancelled = false;
    const apply = (next: ReadonlySet<string>) => {
      if (sameSet(next, appControlRef.current)) return;
      appControlRef.current = next;
      setAppControl(next);
    };
    // Events that land while the first read is in flight are replayed onto its
    // answer, so a session started in that gap is not lost.
    let pending: AppControlEventPayload[] | null = [];
    const unsubscribe = api.onEvent?.((event: AppControlEventPayload) => {
      if (event.type !== "session-started" && event.type !== "session-updated" && event.type !== "session-stopped") {
        return;
      }
      if (pending) pending.push(event);
      else apply(applyLaneAppControlEvent(appControlRef.current, event));
    }) ?? null;
    const settle = (base: ReadonlySet<string>) => {
      let next = base;
      for (const event of pending ?? []) next = applyLaneAppControlEvent(next, event);
      pending = null;
      apply(next);
    };
    void api.getStatus({})
      .then((status) => {
        if (!cancelled) settle(buildLaneAppControls(status?.sessions));
      })
      .catch(() => {
        // An unreachable host is not "no apps"; events still move the set.
        if (!cancelled) settle(appControlRef.current);
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [scope]);

  // Browser. The status is the project's collection, like the tools pane's.
  useEffect(() => {
    browserTabsRef.current = EMPTY_MAP;
    setBrowserTabs(EMPTY_MAP);
    if (!scope) return undefined;
    const api = window.ade?.builtInBrowser;
    if (!api?.getStatus || !api.onEvent) return undefined;
    let cancelled = false;
    let heardEvent = false;
    const apply = (status: BuiltInBrowserStatus | null) => {
      if (!status) return;
      const next = buildLaneBrowserTabs(status);
      if (sameCounts(next, browserTabsRef.current)) return;
      browserTabsRef.current = next;
      setBrowserTabs(next);
    };
    const unsubscribe = api.onEvent((event: BuiltInBrowserEventPayload) => {
      // One event stream carries every open project's collection.
      if (event.type !== "status" || !browserEventMatchesProject(event, projectRoot)) return;
      heardEvent = true;
      apply(asBuiltInBrowserStatus(event.status));
    });
    void api.getStatus(projectRoot ? { projectRoot } : {})
      .then((status) => {
        // A status event is newer than a read that was in flight with it.
        if (!cancelled && !heardEvent) apply(asBuiltInBrowserStatus(status));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [projectRoot, scope]);

  return { appControl, browserTabs };
}

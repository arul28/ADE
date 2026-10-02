import React, { Suspense, useEffect, useCallback, useRef, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Clock } from "@phosphor-icons/react";
import { ArrowLeft } from "@phosphor-icons/react";
import { getLaneAccent } from "../lanes/laneColorPalette";
import {
  readForeignLaneSelection,
  setForeignLaneSelection,
  useForeignLaneSelection,
} from "../lanes/useLanesPageMachines";
import { selectActiveProjectStateKey, useAppStore, useAppStoreApi } from "../../state/appStore";
import { cachedCtoHomeResolution } from "../../state/ctoHome";
import { EmptyState } from "../ui/EmptyState";
import { Group, Panel } from "react-resizable-panels";
import { ResizeGutter } from "../ui/ResizeGutter";
import { useDockLayout } from "../ui/DockLayoutState";
import { TimelineToolbar } from "./TimelineToolbar";
import { TimelineListView } from "./TimelineListView";
import { TimelineCompactView } from "./TimelineCompactView";
import { CommitHistoryView } from "./CommitHistoryView";
import {
  TimelineStoreProvider,
  createTimelineStore,
  enrichEvent,
  useTimelineStore,
  type TimelineStoreApi,
} from "./useTimelineStore";
import { shouldHydrateCommitShaFromUrl } from "./historyUrlHydration";
import { useCommitViewPrefs } from "./commitViewPrefs";
import type { TimelineEvent } from "./timelineTypes";
import type { GitCommitSummary, OpenProjectBinding, OperationRecord } from "../../../shared/types";
import {
  createLaneMachineRouter,
  foreignLaneKey,
  routableMachines,
  useAllMachineLanes,
  useStableBinding,
} from "../../state/laneMachineRouting";
import { pinKey } from "../../state/projectMachines";
import { machineScopedId, type MachineReadLoad } from "../../state/foreignMachineReads";
import type { HistoryMachineSource } from "./useTimelineStore";

const TimelineGraph = React.lazy(async () => {
  const mod = await import("./TimelineGraph");
  return { default: mod.TimelineGraph };
});

const EventDetailPanel = React.lazy(async () => {
  const mod = await import("./EventDetailPanel");
  return { default: mod.EventDetailPanel };
});

const LaneDiffPane = React.lazy(async () => {
  const mod = await import("../lanes/LaneDiffPane");
  return { default: mod.LaneDiffPane };
});

const CommitDetailPanel = React.lazy(async () => {
  const mod = await import("./CommitDetailPanel");
  return { default: mod.CommitDetailPanel };
});

/** How long a lane's operations, read for a commit's details, stay fresh. */
const LANE_OPERATIONS_TTL_MS = 15_000;

/** Saved split sizes of the timeline and detail panes, in percent. */
const HISTORY_SPLIT_LAYOUT_ID = "history:split:v1";

export function HistoryPage({ active = true }: { active?: boolean } = {}) {
  const storeRef = useRef<TimelineStoreApi | null>(null);
  if (!storeRef.current) {
    storeRef.current = createTimelineStore();
  }
  return (
    <TimelineStoreProvider store={storeRef.current}>
      <HistoryPageContent active={active} />
    </TimelineStoreProvider>
  );
}

function HistoryPageContent({ active = true }: { active?: boolean } = {}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const syncingFromUrlRef = useRef(false);
  const lastWrittenUrlRef = useRef<string>("");
  const [commitRefreshToken, setCommitRefreshToken] = useState(0);
  /** False when the selected commit object exists but is not reachable from the lane head. */
  const [commitOnLaneHistory, setCommitOnLaneHistory] = useState(true);
  const [selectedCommitLaneId, setSelectedCommitLaneId] = useState<string | null>(null);
  /** The lane whose work a commit is (null: base history), as the graph's rows say. */
  const [commitOwner, setCommitOwner] = useState<{ sha: string; laneId: string | null } | null>(null);
  /** The selected commit's changes fill the page (Enter / double-click / "Changes"). */
  const [diffTarget, setDiffTarget] = useState<{ commit: GitCommitSummary; path: string | null } | null>(null);
  const openCommitChanges = useCallback((commit: GitCommitSummary, path: string | null = null) => {
    setDiffTarget({ commit, path });
  }, []);

  const events = useTimelineStore((s) => s.events);
  const rawEvents = useTimelineStore((s) => s.rawEvents);
  const wipNodes = useTimelineStore((s) => s.wipNodes);
  const viewMode = useTimelineStore((s) => s.viewMode);
  const surface = useTimelineStore((s) => s.surface);
  const focusLaneId = useTimelineStore((s) => s.focusLaneId);
  const focusLaneMachineId = useTimelineStore((s) => s.focusLaneMachineId);
  const setFocusLane = useTimelineStore((s) => s.setFocusLane);
  const selectedCommitSha = useTimelineStore((s) => s.selectedCommitSha);
  const selectedCommit = useTimelineStore((s) => s.selectedCommit);
  const selectedCommitRef = useRef(selectedCommit);
  selectedCommitRef.current = selectedCommit;
  // The selected commit's owner. Until the graph's rows say: in This lane every
  // row is on the focused lane (undefined → the focused lane); in All lanes it
  // is never assumed (null → no lane).
  const commitScope = useCommitViewPrefs((s) => s.scope);
  const commitOwnerLaneId: string | null | undefined = commitOwner && commitOwner.sha === selectedCommitSha
    ? commitOwner.laneId
    : commitScope === "lanes" ? null : undefined;
  /** The lane the selected commit's git actions, details and changes read and act on. */
  const actionLaneId = typeof commitOwnerLaneId === "string" ? commitOwnerLaneId : focusLaneId;
  const selectedEventId = useTimelineStore((s) => s.selectedEventId);
  const hoveredLaneId = useTimelineStore((s) => s.hoveredLaneId);
  const columns = useTimelineStore((s) => s.columns);
  const loading = useTimelineStore((s) => s.loading);
  const error = useTimelineStore((s) => s.error);
  const fetchEvents = useTimelineStore((s) => s.fetchEvents);
  const setSelectedEventId = useTimelineStore((s) => s.setSelectedEventId);
  const setSelectedCommit = useTimelineStore((s) => s.setSelectedCommit);
  const setSelectedCommitSha = useTimelineStore((s) => s.setSelectedCommitSha);
  const setFocusLaneId = useTimelineStore((s) => s.setFocusLaneId);
  const setSurface = useTimelineStore((s) => s.setSurface);
  const setHoveredLaneId = useTimelineStore((s) => s.setHoveredLaneId);
  const setMachines = useTimelineStore((s) => s.setMachines);
  const setCtoRoute = useTimelineStore((s) => s.setCtoRoute);
  const projectStateKey = useAppStore(selectActiveProjectStateKey);
  const machineLoads = useTimelineStore((s) => s.machineLoads);

  // One timeline across every machine that holds this project, and every
  // machine's lanes for the commit view. The union is joined while History is
  // on screen.
  const allMachineLanes = useAllMachineLanes(active);
  const machineSources = useMemo<HistoryMachineSource[]>(
    () => routableMachines(allMachineLanes.machines).map((machine) => ({
      machineId: machine.machineId,
      machineName: machine.machineName,
      pin: machine.pin,
      online: machine.online,
      isThisMachine: machine.isThisMachine,
      isActiveBinding: machine.isActiveBinding,
    })),
    [allMachineLanes.machines],
  );
  // Lane lists churn the machine objects; only membership, naming, pin and
  // reachability matter to the timeline.
  const machineSignature = machineSources
    .map((machine) => [
      machine.machineId,
      machine.machineName,
      machine.online ? 1 : 0,
      machine.isActiveBinding ? 1 : 0,
      pinKey(machine.pin),
    ].join("\u0000"))
    .join("\u0001");
  const machineSourcesRef = useRef(machineSources);
  machineSourcesRef.current = machineSources;
  useEffect(() => {
    setMachines(machineSourcesRef.current);
  }, [machineSignature, setMachines]);

  const lanes = useAppStore((s) => s.lanes ?? []);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const requestLaneStatusRead = useAppStore((s) => s.requestLaneStatusRead);

  // The drift pill and the base divider show this machine's lane status. It
  // must be measured, not inherited: on opening History unless it was read a
  // moment ago, and again whenever the commit list reloads (a commit action, a
  // fetch, an agent's operation), since that is when the branch moved.
  // A running head-changing operation is replaced by its completed row on a
  // later poll without changing the list length, so include each row's head
  // SHAs: completing one (a commit, a fetch) still re-measures the lane.
  // Unchanged polls produce the same string, so the effect stays put.
  const laneMovedToken = useMemo(
    () => [
      String(commitRefreshToken),
      ...rawEvents.map((event) => `${event.id}:${event.preHeadSha ?? ""}:${event.postHeadSha ?? ""}`),
    ].join("|"),
    [commitRefreshToken, rawEvents],
  );
  const laneMovedTokenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const moved = laneMovedTokenRef.current != null && laneMovedTokenRef.current !== laneMovedToken;
    laneMovedTokenRef.current = laneMovedToken;
    requestLaneStatusRead(moved ? { maxAgeMs: 0 } : undefined);
  }, [active, laneMovedToken, requestLaneStatusRead]);

  // A lane on another machine is read through that machine's pin. Writes
  // (lane git actions, commit actions) stay with lanes on this tab's machine:
  // `laneHasWorktree` is false for the others, which is what gates them.
  const laneRouter = useMemo(() => createLaneMachineRouter(allMachineLanes), [allMachineLanes]);
  const focusRoute = focusLaneMachineId ? laneRouter.route(focusLaneId, focusLaneMachineId) : null;
  const commitPin = useStableBinding(focusRoute?.kind === "pinned" ? focusRoute.pin : null);
  const focusLaneReadable = !focusLaneMachineId || focusRoute?.kind === "pinned";
  const focusRemoteMachineName = focusLaneMachineId
    ? laneRouter.machine(focusLaneMachineId)?.machineName ?? "another machine"
    : null;

  // Hydrate store from URL (single effect to avoid sync loops)
  useEffect(() => {
    if (!active) return;
    const paramsKey = searchParams.toString();
    if (paramsKey === lastWrittenUrlRef.current) return;

    syncingFromUrlRef.current = true;

    const surfaceFromUrl = searchParams.get("surface");
    const requestedSurface =
      surfaceFromUrl === "activity" || surfaceFromUrl === "commits"
        ? surfaceFromUrl
        : null;
    const cleanedParams = new URLSearchParams(searchParams);
    let cleanedUrl = false;

    if (surfaceFromUrl === "activity" || surfaceFromUrl === "commits") {
      setSurface(surfaceFromUrl);
    } else if (surfaceFromUrl != null) {
      // Strip unrecognized surface values so we fall back to the store default.
      cleanedParams.delete("surface");
      cleanedUrl = true;
    }

    const laneFromUrl = searchParams.get("laneId");
    const machineFromUrl = searchParams.get("machineId") || null;
    // A lane on another machine waits until that machine has reported in:
    // until then "unknown" is not "gone".
    const machinePending = machineFromUrl != null && laneRouter.machine(machineFromUrl) == null;
    const foreignFromUrl = machineFromUrl != null && laneRouter.machine(machineFromUrl)?.isActiveBinding !== true;
    const laneIsKnown = laneFromUrl != null && (
      foreignFromUrl
        ? laneRouter.route(laneFromUrl, machineFromUrl).kind !== "unknown"
        : lanes.some((l) => l.id === laneFromUrl)
    );
    let focusLaneChanged = false;
    if (machinePending) {
      // Leave the focus alone; this effect re-runs when the machine arrives.
    } else if (laneFromUrl && laneIsKnown) {
      const nextMachineId = foreignFromUrl ? machineFromUrl : null;
      if (focusLaneId !== laneFromUrl || focusLaneMachineId !== nextMachineId) {
        setFocusLane(laneFromUrl, nextMachineId);
        focusLaneChanged = true;
      }
    } else {
      if (laneFromUrl && !laneIsKnown && lanes.length > 0) {
        // Lane referenced in URL no longer exists — strip it and the dependent commit hash.
        cleanedParams.delete("laneId");
        cleanedParams.delete("machineId");
        cleanedParams.delete("commitSha");
        cleanedUrl = true;
      }
      const commitShaInUrl = searchParams.get("commitSha");
      const needsLaneForCommit =
        commitShaInUrl != null &&
        commitShaInUrl.length > 0 &&
        (requestedSurface === "commits" || surface === "commits");
      // Do not guess a lane when a commit deeplink omits laneId — destructive git
      // actions would run against the wrong worktree.
      if (
        !needsLaneForCommit &&
        !focusLaneMachineId &&
        (!focusLaneId || !lanes.some((l) => l.id === focusLaneId))
      ) {
        const fallback =
          (selectedLaneId && lanes.some((l) => l.id === selectedLaneId) ? selectedLaneId : null) ??
          lanes[0]?.id ??
          null;
        if (fallback && focusLaneId !== fallback) setFocusLaneId(fallback);
      }
    }

    const eventId = searchParams.get("eventId");
    if (eventId && requestedSurface === "commits") {
      cleanedParams.delete("eventId");
      cleanedUrl = true;
    } else if (eventId && eventId !== selectedEventId) {
      setSelectedEventId(eventId);
      setSurface("activity");
    }

    const commitSha = searchParams.get("commitSha");
    if (commitSha && requestedSurface === "activity") {
      cleanedParams.delete("commitSha");
      cleanedUrl = true;
    } else if (
      shouldHydrateCommitShaFromUrl({
        commitSha,
        requestedSurface,
        selectedCommitSha,
        focusLaneChanged,
      })
    ) {
      setSelectedCommitSha(commitSha);
      setSurface("commits");
    }

    // A URL lane that is still waiting on data (its machine has not reported,
    // or the lane list has not loaded) is left unconsumed so this effect can
    // hydrate it when that data arrives.
    const laneHydrationPending =
      machinePending || (laneFromUrl != null && !laneIsKnown && lanes.length === 0);

    if (cleanedUrl) {
      lastWrittenUrlRef.current = cleanedParams.toString();
      setSearchParams(cleanedParams, { replace: true });
    } else if (!laneHydrationPending) {
      // Record that this URL was consumed, so a later store change (a lane
      // pick) flows store→URL instead of this effect re-hydrating the stale
      // URL and reverting the pick.
      lastWrittenUrlRef.current = paramsKey;
    }

    queueMicrotask(() => {
      syncingFromUrlRef.current = false;
    });
  }, [
    active,
    lanes,
    laneRouter,
    selectedLaneId,
    focusLaneId,
    focusLaneMachineId,
    surface,
    searchParams,
    selectedEventId,
    selectedCommitSha,
    setFocusLaneId,
    setFocusLane,
    setSurface,
    setSelectedEventId,
    setSelectedCommitSha,
    setSearchParams,
  ]);

  // History and the lane list beside it (the Lanes or Work sidebar held under
  // History) show one lane. The list's selection is the store's lane on this
  // machine, or the Lanes list's row key (`machineId:laneId`) for a lane on
  // another machine. `sidebarLaneRef` is the selection the two last agreed on,
  // so each side only reacts to a change the other did not make.
  const appStoreApi = useAppStoreApi();
  const selectLane = useAppStore((s) => s.selectLane);
  const foreignListKey = useForeignLaneSelection(projectStateKey);
  const readListSelection = useCallback(
    () => readForeignLaneSelection(projectStateKey) ?? appStoreApi.getState().selectedLaneId,
    [appStoreApi, projectStateKey],
  );
  const sidebarLaneRef = useRef<string | null>(null);
  if (sidebarLaneRef.current === null) sidebarLaneRef.current = foreignListKey ?? selectedLaneId ?? "";

  // History's lane → the list's highlight.
  useEffect(() => {
    if (!active || !focusLaneId) return;
    if (focusLaneMachineId) {
      const key = foreignLaneKey(focusLaneMachineId, focusLaneId);
      sidebarLaneRef.current = key;
      setForeignLaneSelection(projectStateKey, key);
      return;
    }
    sidebarLaneRef.current = focusLaneId;
    setForeignLaneSelection(projectStateKey, null);
    if (appStoreApi.getState().selectedLaneId !== focusLaneId) selectLane(focusLaneId);
  }, [active, appStoreApi, focusLaneId, focusLaneMachineId, projectStateKey, selectLane]);

  // A lane picked in the list → History shows it (and the URL follows).
  useEffect(() => {
    if (!active) return;
    // Read live: the effect above may have just moved the selection to the
    // lane a URL focused, and this render's value is the one it replaced.
    const picked = readListSelection();
    if ((picked ?? "") === sidebarLaneRef.current) return;
    if (!picked) {
      sidebarLaneRef.current = "";
      return;
    }
    let target: { laneId: string; machineId: string | null } | null = null;
    if (lanes.some((lane) => lane.id === picked)) {
      target = { laneId: picked, machineId: null };
    } else {
      const row = allMachineLanes.lanesByKey.get(picked);
      if (row) target = { laneId: row.lane.id, machineId: row.isActiveBinding ? null : row.machineId };
    }
    // Not listed yet (another machine still reporting): retried when it is.
    if (!target) return;
    sidebarLaneRef.current = picked;
    if (target.laneId !== focusLaneId || target.machineId !== focusLaneMachineId) {
      setFocusLane(target.laneId, target.machineId);
      setDiffTarget(null);
    }
  }, [
    active,
    allMachineLanes.lanesByKey,
    focusLaneId,
    focusLaneMachineId,
    foreignListKey,
    lanes,
    readListSelection,
    selectedLaneId,
    setFocusLane,
  ]);

  useEffect(() => {
    if (!active || surface === "commits") return;
    // CTO sessions come from the CTO's home machine. While it is unknown (the
    // CTO page hasn't resolved it yet) they are read from the tab's machine.
    const home = cachedCtoHomeResolution(projectStateKey);
    setCtoRoute(
      home?.status === "unreachable"
        ? { skip: true, pin: null }
        : { skip: false, pin: home?.status === "resolved" ? home.pin : null },
    );
    void fetchEvents();
  }, [active, surface, fetchEvents, projectStateKey, setCtoRoute]);

  // A machine that joins, returns, or comes back online is read right away;
  // the bound machine's own list is never held for it.
  const foreignMachineSignature = machineSources
    .filter((machine) => !machine.isActiveBinding && machine.online)
    .map((machine) => machine.machineId)
    .join("\u0001");
  const lastForeignSignatureRef = useRef(foreignMachineSignature);
  useEffect(() => {
    if (lastForeignSignatureRef.current === foreignMachineSignature) return;
    lastForeignSignatureRef.current = foreignMachineSignature;
    if (!active || surface === "commits" || !foreignMachineSignature) return;
    void fetchEvents({ silent: true, skipSupplemental: true });
  }, [active, fetchEvents, foreignMachineSignature, surface]);

  useEffect(() => {
    if (!active || surface !== "activity") return;
    // Tight polling only refreshes the cheap operations feed; supplemental sources
    // Supplemental sources refresh on focus/visibility change instead.
    const tightRefresh = () => {
      if (document.visibilityState !== "visible") return;
      void fetchEvents({ silent: true, skipSupplemental: true, skipForeign: true });
    };
    const fullRefresh = () => {
      if (document.visibilityState !== "visible") return;
      void fetchEvents({ silent: true });
    };
    const hasRunning = events.some((e) => e.status === "running");
    const interval = hasRunning ? setInterval(tightRefresh, 4_000) : undefined;
    window.addEventListener("focus", fullRefresh);
    document.addEventListener("visibilitychange", fullRefresh);
    return () => {
      if (interval) clearInterval(interval);
      window.removeEventListener("focus", fullRefresh);
      document.removeEventListener("visibilitychange", fullRefresh);
    };
  }, [active, surface, events, fetchEvents]);

  useEffect(() => {
    const selectedCommitIsCurrentLane =
      selectedCommit?.sha === selectedCommitSha &&
      selectedCommitLaneId === actionLaneId;
    if (!active || !actionLaneId || !focusLaneReadable || !selectedCommitSha || selectedCommitIsCurrentLane) {
      if (!selectedCommitSha) {
        setCommitOnLaneHistory(true);
        setSelectedCommitLaneId(null);
      }
      return;
    }
    let cancelled = false;
    void window.ade.git
      .listRecentCommits({ laneId: actionLaneId, limit: 500, scope: "lane" }, commitPin)
      .then(async (rows) => {
        if (cancelled) return;
        const found = rows.find((r) => r.sha === selectedCommitSha);
        if (found) {
          setCommitOnLaneHistory(true);
          setSelectedCommitLaneId(actionLaneId);
          // Keep the row the graph handed over: it carries email and co-authors.
          if (selectedCommitRef.current?.sha !== found.sha) setSelectedCommit(found);
          return;
        }
        // Outside the loaded window — fall back to a targeted single-commit lookup.
        if (typeof window.ade.git.getCommit !== "function") {
          setCommitOnLaneHistory(false);
          return;
        }
        try {
          const targeted = await window.ade.git.getCommit({
            laneId: actionLaneId,
            commitSha: selectedCommitSha,
          }, commitPin);
          if (!cancelled) {
            const isOnLane = targeted
              ? await window.ade.git.isCommitInLaneHistory({
                laneId: actionLaneId,
                commitSha: selectedCommitSha,
              }, commitPin).catch(() => false)
              : false;
            if (cancelled) return;
            setCommitOnLaneHistory(isOnLane);
            setSelectedCommitLaneId(actionLaneId);
            if (targeted && selectedCommitRef.current?.sha !== targeted.sha) setSelectedCommit(targeted);
          }
        } catch {
          if (!cancelled) {
            setCommitOnLaneHistory(false);
            setSelectedCommitLaneId(actionLaneId);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCommitOnLaneHistory(false);
          setSelectedCommitLaneId(actionLaneId);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active, actionLaneId, commitPin, focusLaneReadable, selectedCommitLaneId, selectedCommitSha, selectedCommit?.sha, setSelectedCommit]);

  useEffect(() => {
    if (!active || syncingFromUrlRef.current) return;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      let changed = false;
      if (next.get("surface") !== surface) {
        next.set("surface", surface);
        changed = true;
      }
      const laneParam = focusLaneId ?? "";
      if ((next.get("laneId") ?? "") !== laneParam) {
        if (laneParam) next.set("laneId", laneParam);
        else next.delete("laneId");
        changed = true;
      }
      const machineParam = focusLaneId ? focusLaneMachineId ?? "" : "";
      if ((next.get("machineId") ?? "") !== machineParam) {
        if (machineParam) next.set("machineId", machineParam);
        else next.delete("machineId");
        changed = true;
      }
      const commitParam = selectedCommitSha ?? "";
      if (surface === "commits") {
        if (commitParam && next.get("commitSha") !== commitParam) {
          next.set("commitSha", commitParam);
          changed = true;
        } else if (!commitParam && next.has("commitSha")) {
          next.delete("commitSha");
          changed = true;
        }
      } else if (next.has("commitSha")) {
        next.delete("commitSha");
        changed = true;
      }
      const eventParam = selectedEventId ?? "";
      if (surface === "activity") {
        if (eventParam && next.get("eventId") !== eventParam) {
          next.set("eventId", eventParam);
          changed = true;
        } else if (!eventParam && next.has("eventId")) {
          next.delete("eventId");
          changed = true;
        }
      } else if (next.has("eventId")) {
        next.delete("eventId");
        changed = true;
      }
      if (!changed) return prev;
      lastWrittenUrlRef.current = next.toString();
      return next;
    }, { replace: true });
  }, [active, surface, focusLaneId, focusLaneMachineId, selectedCommitSha, selectedEventId, setSearchParams]);

  const handleSelectEvent = useCallback(
    (id: string) => {
      setSelectedEventId(id);
      setSelectedCommit(null);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("eventId", id);
        next.delete("commitSha");
        next.set("surface", "activity");
        lastWrittenUrlRef.current = next.toString();
        return next;
      });
    },
    [setSelectedEventId, setSelectedCommit, setSearchParams],
  );

  const handleSelectCommit = useCallback(
    (commit: GitCommitSummary, ownerLaneId?: string | null) => {
      setCommitOwner({ sha: commit.sha, laneId: ownerLaneId ?? null });
      // Settle the destructive-action gate from the row's owner immediately: a
      // lane's own commit is on that lane, which its actions act on. Base
      // history acts on the focused lane; the reachability effect checks it.
      setSelectedCommitLaneId(ownerLaneId ?? null);
      setCommitOnLaneHistory(true);
      setSelectedCommit(commit);
      setSelectedEventId(null);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("commitSha", commit.sha);
        next.delete("eventId");
        next.set("surface", "commits");
        if (focusLaneId) next.set("laneId", focusLaneId);
        if (focusLaneId && focusLaneMachineId) next.set("machineId", focusLaneMachineId);
        else next.delete("machineId");
        lastWrittenUrlRef.current = next.toString();
        return next;
      });
    },
    [setSelectedCommit, setSelectedEventId, setSearchParams, focusLaneId, focusLaneMachineId],
  );

  const handleCloseDetail = useCallback(() => {
    setSelectedEventId(null);
    setSelectedCommit(null);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("eventId");
      next.delete("commitSha");
      lastWrittenUrlRef.current = next.toString();
      return next;
    });
  }, [setSelectedEventId, setSelectedCommit, setSearchParams]);

  const handleNavigateToLane = useCallback(
    (laneId: string, machineId?: string | null) => {
      // A lane on another machine opens there: its id is only unique on it.
      const params = new URLSearchParams({ laneId });
      if (machineId) params.set("machineId", machineId);
      navigate(`/lanes?${params.toString()}`);
    },
    [navigate],
  );

  const handleFocusLane = useCallback(
    (laneId: string) => {
      // Ref badges name lanes of the machine whose graph is on screen.
      setFocusLane(laneId, focusLaneMachineId);
      setSelectedCommit(null);
      setDiffTarget(null);
    },
    [focusLaneMachineId, setFocusLane, setSelectedCommit],
  );

  // However a commit was selected, the graph names its owner once its rows hold it.
  const commitOwnerRef = useRef(commitOwner);
  commitOwnerRef.current = commitOwner;
  const handleSelectionOwner = useCallback((sha: string, ownerLaneId: string | null) => {
    const prev = commitOwnerRef.current;
    if (prev?.sha === sha && prev.laneId === ownerLaneId) return;
    commitOwnerRef.current = { sha, laneId: ownerLaneId };
    setCommitOwner(commitOwnerRef.current);
    if (ownerLaneId) {
      setSelectedCommitLaneId(ownerLaneId);
      setCommitOnLaneHistory(true);
    }
  }, []);

  // Ref badges name lanes of the machine whose graph is on screen.
  const handleOpenGraphLane = useCallback(
    (laneId: string) => handleNavigateToLane(laneId, focusLaneMachineId),
    [focusLaneMachineId, handleNavigateToLane],
  );

  // A lane switch closes a full-page diff of the previous lane's commit.
  useEffect(() => {
    setDiffTarget(null);
    setCommitOwner(null);
  }, [focusLaneId, focusLaneMachineId, surface]);

  // An event opened from a commit's details can be one the Activity filters
  // hide; the details pane still shows it.
  const selectedEvent: TimelineEvent | null = useMemo(() => {
    if (!selectedEventId) return null;
    const visible = events.find((e) => e.id === selectedEventId);
    if (visible) return visible;
    const raw = rawEvents.find((e) => e.id === selectedEventId);
    return raw ? enrichEvent(raw) : null;
  }, [events, rawEvents, selectedEventId]);

  // The details pane's "ADE activity" rows on the Commits surface. The full
  // Activity feed loads only on that surface, so the commit's lane operations
  // are read here: once per lane, again after a git action or when the read
  // is older than LANE_OPERATIONS_TTL_MS, never once per commit click.
  const [laneOperations, setLaneOperations] = useState<Record<string, OperationRecord[]>>({});
  /** When each lane's read started, keyed with the git-action refresh token. */
  const laneOperationsReadsRef = useRef(new Map<string, number>());
  // In All lanes the graph names the lane whose work the commit is; its
  // operations were recorded on that lane (on the same machine).
  const operationsLaneId = commitOwnerLaneId ?? focusLaneId;
  const laneOperationsKey = operationsLaneId ? `${focusLaneMachineId ?? ""}\u0000${operationsLaneId}` : null;
  useEffect(() => {
    if (!active || surface !== "commits" || !selectedCommitSha || !operationsLaneId || !laneOperationsKey || !focusLaneReadable) return;
    const readKey = `${laneOperationsKey}\u0000${commitRefreshToken}`;
    const reads = laneOperationsReadsRef.current;
    const startedAt = reads.get(readKey);
    if (startedAt != null && Date.now() - startedAt < LANE_OPERATIONS_TTL_MS) return;
    reads.set(readKey, Date.now());
    void window.ade.history
      .listOperations({ laneId: operationsLaneId, limit: 500 }, commitPin)
      .then((rows) => {
        setLaneOperations((prev) => ({ ...prev, [laneOperationsKey]: Array.isArray(rows) ? rows : [] }));
      })
      .catch(() => {
        // The rows from the Activity feed (when loaded) still show; try again next time.
        reads.delete(readKey);
      });
  }, [active, commitPin, commitRefreshToken, focusLaneReadable, laneOperationsKey, operationsLaneId, selectedCommitSha, surface]);

  const relatedEventsForCommit = useMemo(() => {
    if (!selectedCommitSha) return [];
    const matches = (op: OperationRecord) =>
      op.preHeadSha === selectedCommitSha || op.postHeadSha === selectedCommitSha;
    const byId = new Map<string, TimelineEvent>();
    // Ids as the Activity feed has them, so a row opens the same event there.
    const laneRows = laneOperationsKey ? laneOperations[laneOperationsKey] ?? [] : [];
    for (const op of laneRows) {
      if (!matches(op)) continue;
      const id = focusLaneMachineId ? machineScopedId(focusLaneMachineId, op.id) : op.id;
      byId.set(id, enrichEvent({ ...op, id }));
    }
    for (const op of rawEvents) {
      if (matches(op) && !byId.has(op.id)) byId.set(op.id, enrichEvent(op));
    }
    return [...byId.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }, [focusLaneMachineId, laneOperations, laneOperationsKey, rawEvents, selectedCommitSha]);

  const focusLane = focusLaneMachineId
    ? (focusLaneId ? allMachineLanes.lanesByKey.get(foreignLaneKey(focusLaneMachineId, focusLaneId))?.lane ?? null : null)
    : lanes.find((l) => l.id === focusLaneId) ?? null;
  const focusLaneHasWorktree = !focusLaneMachineId && Boolean(focusLane?.worktreePath?.trim());
  const actionLane = actionLaneId === focusLaneId ? focusLane : lanes.find((l) => l.id === actionLaneId) ?? null;
  const actionLaneHasWorktree = !focusLaneMachineId && Boolean(actionLane?.worktreePath?.trim());
  const machineLanes = useMemo(
    () => (focusLaneMachineId
      ? allMachineLanes.lanes.filter((row) => row.machineId === focusLaneMachineId).map((row) => row.lane)
      : lanes),
    [allMachineLanes.lanes, focusLaneMachineId, lanes],
  );

  const laneData = useMemo(
    () =>
      lanes.map((l) => ({
        id: l.id,
        name: l.name,
        color: l.color ?? null,
      })),
    [lanes],
  );

  const commitOwnerLane = commitOwnerLaneId === undefined
    ? focusLane
    : commitOwnerLaneId
      ? machineLanes.find((lane) => lane.id === commitOwnerLaneId) ?? null
      : null;
  const commitOwnerLaneColor = commitOwnerLane
    ? getLaneAccent(commitOwnerLane, Math.max(0, machineLanes.filter((lane) => !lane.archivedAt).indexOf(commitOwnerLane)))
    : null;

  const { layout: splitLayout, loaded: splitLoaded, saveLayout: saveSplitLayout } = useDockLayout(HISTORY_SPLIT_LAYOUT_ID, {});

  const panelFallback = (
    <div className="flex flex-1 items-center justify-center font-mono text-[11px] text-muted-fg/40">
      Loading view…
    </div>
  );

  let timelineBody: React.ReactNode;

  if (surface === "commits" && focusLaneMachineId && !focusLaneReadable) {
    timelineBody = (
      <EmptyState
        icon={Clock}
        title={`${focusRemoteMachineName ?? "That machine"} is unavailable`}
        description="Its lanes' commits load once it is back online"
      />
    );
  } else if (surface === "commits") {
    timelineBody = (
      <CommitHistoryView
        // The same lane id on another machine is another lane: remount so
        // nothing read from the previous machine is shown for it.
        key={pinKey(commitPin)}
        laneId={focusLaneReadable ? focusLaneId : null}
        pin={commitPin}
        remoteMachineName={focusRemoteMachineName}
        laneName={focusLane?.name ?? null}
        laneHasWorktree={focusLaneHasWorktree}
        lanes={machineLanes}
        selectedSha={selectedCommitSha}
        onSelectCommit={handleSelectCommit}
        onSelectionOwner={handleSelectionOwner}
        onOpenCommit={openCommitChanges}
        onFocusLane={handleFocusLane}
        onOpenLane={handleOpenGraphLane}
        active={active}
        refreshToken={rawEvents.length + commitRefreshToken}
      />
    );
  } else if (loading && events.length === 0) {
    timelineBody = (
      <EmptyState
        icon={Clock}
        title="Loading timeline…"
        description="Fetching operations history"
      />
    );
  } else if (error) {
    timelineBody = (
      <EmptyState icon={Clock} title="Failed to load" description={error} />
    );
  } else if (events.length === 0) {
    timelineBody = (
      <EmptyState
        icon={Clock}
        title={rawEvents.length > 0 ? "No matching events" : "No events yet"}
        description={
          rawEvents.length > 0
            ? "The current scope and filters hide all recorded activity"
            : "Operations will appear here as you work"
        }
      />
    );
  } else {
    switch (viewMode) {
      case "graph":
        timelineBody = (
          <Suspense fallback={panelFallback}>
            <TimelineGraph
              events={events}
              lanes={laneData}
              wipNodes={wipNodes}
              selectedEventId={selectedEventId}
              hoveredLaneId={hoveredLaneId}
              onSelectEvent={handleSelectEvent}
              onHoverLane={setHoveredLaneId}
            />
          </Suspense>
        );
        break;
      case "list":
        timelineBody = (
          <TimelineListView
            events={events}
            columns={columns}
            selectedEventId={selectedEventId}
            onSelectEvent={handleSelectEvent}
          />
        );
        break;
      case "compact":
        timelineBody = (
          <TimelineCompactView
            events={events}
            columns={columns}
            selectedEventId={selectedEventId}
            onSelectEvent={handleSelectEvent}
          />
        );
        break;
    }
  }

  const detailBody =
    surface === "commits" ? (
      <Suspense fallback={panelFallback}>
        <CommitDetailPanel
          laneId={focusLaneReadable ? actionLaneId : null}
          pin={commitPin}
          remoteMachineName={focusRemoteMachineName}
          laneMachineId={focusLaneMachineId}
          laneHasWorktree={actionLaneHasWorktree}
          commit={selectedCommit}
          commitOnLaneHistory={commitOnLaneHistory}
          ownerLane={commitOwnerLane}
          relatedEvents={relatedEventsForCommit}
          ownerLaneColor={commitOwnerLaneColor}
          onOpenChanges={openCommitChanges}
          onSelectSha={setSelectedCommitSha}
          onOpenEvent={handleSelectEvent}
          onClose={handleCloseDetail}
          onNavigateToLane={handleNavigateToLane}
          navigate={(path) => navigate(path)}
        />
      </Suspense>
    ) : (
      <Suspense fallback={panelFallback}>
        <EventDetailPanel
          event={selectedEvent}
          onClose={handleCloseDetail}
          onNavigateToLane={handleNavigateToLane}
          navigate={(path) => navigate(path)}
        />
      </Suspense>
    );

  // A plain page: the toolbar is the top rail, then the timeline and the
  // detail side by side, split by a hairline.
  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      <TimelineToolbar
        commitListControls={!diffTarget}
        onCommitGitActionComplete={() => setCommitRefreshToken((value) => value + 1)}
      />
      {surface === "commits" && diffTarget && focusLaneReadable && actionLaneId ? (
        <CommitChangesPage
          laneId={actionLaneId}
          pin={commitPin}
          commit={diffTarget.commit}
          initialPath={diffTarget.path}
          fallback={panelFallback}
          onBack={() => setDiffTarget(null)}
        />
      ) : (
      <Group
        // Remount once the saved sizes arrive so they apply.
        key={splitLoaded ? "loaded" : "pending"}
        orientation="horizontal"
        className="min-h-0 flex-1"
        onLayoutChanged={(next) => {
          if (next && Object.keys(next).length > 1) saveSplitLayout(next);
        }}
      >
        <Panel
          id="history-timeline"
          defaultSize={`${splitLayout["history-timeline"] ?? 60}%`}
          minSize="30%"
          className="flex min-h-0 min-w-0 flex-col"
        >
          {surface === "activity" ? <MachineLoadNotes loads={machineLoads} /> : null}
          {timelineBody}
        </Panel>
        <ResizeGutter orientation="vertical" thin />
        <Panel
          id="history-detail"
          defaultSize={`${splitLayout["history-detail"] ?? 40}%`}
          minSize="20%"
          className="flex min-h-0 min-w-0 flex-col border-l border-white/[0.06]"
        >
          {detailBody}
        </Panel>
      </Group>
      )}
    </div>
  );
}

/** A commit's files and diffs over the whole page; Esc or Back returns to the list. */
function CommitChangesPage({
  laneId,
  pin,
  commit,
  initialPath,
  fallback,
  onBack,
}: {
  laneId: string;
  pin: OpenProjectBinding | null;
  commit: GitCommitSummary;
  initialPath: string | null;
  fallback: React.ReactNode;
  onBack: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, [contenteditable=true], .monaco-editor")) return;
      onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="history-commit-changes">
      <Suspense fallback={fallback}>
        <LaneDiffPane
          laneId={laneId}
          selectedPath={null}
          selectedFileMode={null}
          selectedCommit={commit}
          runtimePin={pin}
          initialCommitFilePath={initialPath}
          commitHeaderStart={(
            <button
              type="button"
              onClick={onBack}
              title="Back to commits (Esc)"
              className="-ml-1.5 mr-1 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[7px] px-2 text-[12px] font-medium text-fg/80 transition-colors duration-100 hover:bg-white/[0.06] hover:text-fg"
              data-testid="history-changes-back"
            >
              <ArrowLeft size={13} />
              Commits
            </button>
          )}
        />
      </Suspense>
    </div>
  );
}

/**
 * One quiet line per machine that is still loading, offline, or unreachable.
 * The rest of the timeline is already on screen; this only says what's missing.
 */
function MachineLoadNotes({ loads }: { loads: Record<string, MachineReadLoad> }) {
  const entries = Object.entries(loads);
  if (entries.length === 0) return null;
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-white/[0.04] px-3 py-1 font-mono text-[10px] text-muted-fg/50"
      data-testid="history-machine-notes"
    >
      {entries.map(([key, load]) => (
        <span key={key} title={load.message ?? undefined}>
          {load.status === "loading"
            ? `Loading ${load.machineName}…`
            : load.status === "offline"
              ? `${load.machineName} is offline · showing last reported`
              : `Couldn't reach ${load.machineName}`}
        </span>
      ))}
    </div>
  );
}

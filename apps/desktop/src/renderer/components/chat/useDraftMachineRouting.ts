import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { remoteProjectBindingKey } from "../../../shared/projectIdentity";
import type {
  LaneSummary,
  OpenProjectBinding,
  RecentProjectSummary,
  RemoteRuntimeConnectionSnapshot,
} from "../../../shared/types";
import type { CrossMachineMachineLanes } from "../../state/appStore";
import { requestCrossMachineLanesForMachine } from "../../state/crossMachineLanes";
import {
  AUTO_CREATE_LANE_OPTION_ID,
  autoCreateLaneOptionId,
  isAutoCreateLaneOptionId,
  machineLaneFromOptionId,
  type LaneComboboxLane,
  type LaneComboboxMachine,
} from "../terminals/LaneCombobox";
import {
  canCreateLaneOnMachine,
  deriveLaneMachineOptions,
  type LaneMachineOption,
  type LaneMachineProjectRef,
} from "../lanes/laneMachines";

export const AUTO_CREATE_DRAFT_LANE_OPTION = {
  id: AUTO_CREATE_LANE_OPTION_ID,
  name: "Auto-create lane",
  color: null,
  branchRef: null,
};

const NO_LANES: readonly RoutedDraftLane[] = [];

/**
 * How long the composer may claim it is still reading a machine's lanes. The
 * union's foreign read lands well inside this; past it the catalog is not
 * coming — a machine the union never reads, or one whose reads keep failing —
 * and continuing to promise one is a lie the user cannot act on.
 */
const LANE_CATALOG_HOLD_MS = 12_000;

export type RoutedDraftLane = LaneComboboxLane & {
  laneType?: string | null;
  baseRef?: string | null;
  worktreePath?: string | null;
};

type DraftLaneInput = LaneComboboxLane & {
  laneType?: string | null;
};

/**
 * Lane ids are per-machine: every machine has its own Primary with its own id.
 * A machine switch therefore has to re-derive the selection by IDENTITY, not
 * carry the id across — carrying it is what produced a lane chip reading
 * "Primary (unavailable on selected machine)" next to that machine's own
 * Primary in the same list.
 */
export function isPrimaryDraftLane(lane: { laneType?: string | null; name: string }): boolean {
  return lane.laneType === "primary" || lane.name.trim().toLowerCase() === "primary";
}

/** `laneType` wins over a lane merely NAMED "Primary" — matches the auto-create rule. */
export function findPrimaryDraftLane<T extends { laneType?: string | null; name: string }>(
  lanes: readonly T[],
): T | null {
  return lanes.find((lane) => lane.laneType === "primary")
    ?? lanes.find((lane) => lane.name.trim().toLowerCase() === "primary")
    ?? null;
}

/**
 * The lane on `lanes` that means the same thing `previous` meant on the machine
 * it came from: the same lane if the id happens to exist there, else the
 * machine's own primary when the old lane was primary, else a same-named lane,
 * else that machine's primary. `null` only when the machine has no lanes at all.
 */
export function remapDraftLaneToMachine(
  previous: RoutedDraftLane | null,
  lanes: readonly RoutedDraftLane[],
): RoutedDraftLane | null {
  const primary = findPrimaryDraftLane(lanes);
  if (!previous) return primary;
  const sameId = lanes.find((candidate) => candidate.id === previous.id);
  if (sameId) return sameId;
  if (isPrimaryDraftLane(previous)) return primary;
  const sameName = lanes.find(
    (candidate) => candidate.name.trim().toLowerCase() === previous.name.trim().toLowerCase(),
  );
  return sameName ?? primary;
}

type UseDraftMachineRoutingInput = {
  enabled: boolean;
  projectBinding: OpenProjectBinding | null;
  openProjectTabRoots: readonly string[];
  crossMachineLanesByMachineId: Readonly<Record<string, CrossMachineMachineLanes>>;
  /**
   * The machine ids the union intends to READ, or `null`/empty while it has not
   * resolved that set yet. A machine the picker offers but the union will never
   * read has no catalog coming, which is what the lane-loading hold below turns
   * on.
   */
  crossMachineLaneIntendedMachineIds?: readonly string[] | null;
  lanes: readonly LaneSummary[];
  availableLanes?: readonly DraftLaneInput[];
  laneId: string | null;
  initialDraftMachineId: string | null;
  draftLaunchTargetIsAutoCreate: boolean;
  onDraftMachineChange?: (machineId: string | null) => void;
  onLaneChange?: (laneId: string) => void;
  setDraftLaunchTargetId: (targetId: string | null) => void;
  setError: (message: string | null) => void;
};

/**
 * Owns the draft-only machine and lane routing state.
 *
 * Selecting a machine here never rebinds the project tab. The returned binding
 * pins only the launch that consumes it, which lets a MacBook-bound Work tab
 * create a chat or lane on a connected Studio without moving Lanes/PRs/Files.
 */
export function useDraftMachineRouting({
  enabled,
  projectBinding,
  openProjectTabRoots,
  crossMachineLanesByMachineId,
  crossMachineLaneIntendedMachineIds = null,
  lanes,
  availableLanes,
  laneId,
  initialDraftMachineId,
  draftLaunchTargetIsAutoCreate,
  onDraftMachineChange,
  onLaneChange,
  setDraftLaunchTargetId,
  setError,
}: UseDraftMachineRoutingInput) {
  const [connectionSnapshot, setConnectionSnapshot] =
    useState<RemoteRuntimeConnectionSnapshot | null>(null);
  const [connectionCatalogResolved, setConnectionCatalogResolved] = useState(!enabled);
  const connectionCatalogResolvedRef = useRef(connectionCatalogResolved);
  const [knownLocalProjects, setKnownLocalProjects] = useState<RecentProjectSummary[]>([]);

  useEffect(() => {
    if (!enabled) {
      connectionCatalogResolvedRef.current = true;
      setConnectionCatalogResolved(true);
      return;
    }
    // Update the ref before the reconciliation effect runs so an enabled draft
    // cannot treat its previous disabled state as a resolved catalog.
    connectionCatalogResolvedRef.current = false;
    setConnectionCatalogResolved(false);
    const remoteRuntime = window.ade?.remoteRuntime;
    if (!remoteRuntime?.getConnectionSnapshot) {
      // A missing remote bridge is a resolved local-only catalog, not an
      // indefinitely loading one. This matters for a persisted remote choice:
      // the local machine must remain usable when the remote feature is absent.
      connectionCatalogResolvedRef.current = true;
      setConnectionCatalogResolved(true);
      return;
    }
    let cancelled = false;
    const apply = (snapshot: RemoteRuntimeConnectionSnapshot) => {
      if (cancelled) return;
      connectionCatalogResolvedRef.current = true;
      setConnectionCatalogResolved(true);
      setConnectionSnapshot((current) =>
        current && current.updatedAt > snapshot.updatedAt ? current : snapshot,
      );
    };
    void remoteRuntime.getConnectionSnapshot().then(apply).catch(() => {
      if (!cancelled) {
        setConnectionSnapshot(null);
        connectionCatalogResolvedRef.current = true;
        setConnectionCatalogResolved(true);
      }
    });
    const unsubscribe = remoteRuntime.onConnectionSnapshotChanged?.(apply) ?? (() => {});
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const projectApi = window.ade?.project;
    if (!projectApi?.listRecent) return;
    let cancelled = false;
    void projectApi.listRecent()
      .then((projects) => {
        if (!cancelled) {
          setKnownLocalProjects(projects.filter(
            (candidate) => candidate.kind !== "remote" && candidate.exists !== false,
          ));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const machineOptions = useMemo<LaneMachineOption[]>(() => {
    if (!enabled) return [];
    const boundProject: LaneMachineProjectRef | null = projectBinding
      ? {
          matchedBy: "origin",
          projectId: projectBinding.kind === "remote" ? projectBinding.projectId : null,
          rootPath: projectBinding.rootPath,
          displayName: projectBinding.displayName,
        }
      : null;
    const boundTargetId = projectBinding?.kind === "remote" ? projectBinding.targetId : null;
    const boundConnection = boundTargetId
      ? connectionSnapshot?.connections.find(
        (candidate) => candidate.target.id === boundTargetId,
      )
      : null;
    const repoOriginUrl = projectBinding?.gitOriginUrl
      ?? (projectBinding?.kind === "remote"
        ? boundConnection?.projects.find(
          (candidate) => candidate.projectId === projectBinding.projectId,
        )?.gitOriginUrl
        : knownLocalProjects.find(
          (candidate) => candidate.rootPath === projectBinding?.rootPath,
        )?.gitOriginUrl)
      ?? null;
    const options = deriveLaneMachineOptions({
      connections: connectionSnapshot?.connections ?? [],
      boundTargetId,
      boundProject,
      repoOriginUrl,
      repoDisplayName: boundProject?.displayName ?? null,
      localProjectRoots: openProjectTabRoots,
      localProjects: knownLocalProjects,
    }).filter(canCreateLaneOnMachine);
    return [
      ...options.filter((option) => option.isBound),
      ...options.filter((option) => !option.isBound),
    ];
  }, [
    connectionSnapshot,
    enabled,
    knownLocalProjects,
    openProjectTabRoots,
    projectBinding,
  ]);

  const selectorMachines = useMemo<LaneComboboxMachine[]>(
    () => machineOptions.length < 2
      ? []
      : machineOptions.map((option) => ({ id: option.id, name: option.name })),
    [machineOptions],
  );

  const boundMachineId = projectBinding?.kind === "remote"
    ? projectBinding.targetId
    : "this-mac";
  const desiredMachineId = initialDraftMachineId?.trim() || boundMachineId;
  const routingInputKey = JSON.stringify([projectBinding?.key ?? null, desiredMachineId]);
  /**
   * Whether the BOUND machine's lane list has actually been read. That list is
   * handed in directly, so "no lanes" and "not read yet" are the same shape —
   * an explicit `availableLanes` (even empty) or any lane at all is the only
   * evidence of a read. The hook owns this predicate so no consumer has to
   * restate it.
   */
  const boundLaneCatalogLoaded = availableLanes !== undefined || lanes.length > 0;
  const lanesByMachineId = useMemo(() => {
    const byMachine = new Map<string, RoutedDraftLane[]>();
    byMachine.set(
      boundMachineId,
      (availableLanes ?? lanes).map((lane) => ({
        ...lane,
        machineId: boundMachineId,
      })),
    );
    for (const machine of Object.values(crossMachineLanesByMachineId)) {
      if (!machineOptions.some((option) => option.id === machine.machineId)) continue;
      byMachine.set(
        machine.machineId,
        machine.lanes.map((lane) => ({ ...lane, machineId: machine.machineId })),
      );
    }
    return byMachine;
  }, [
    availableLanes,
    boundMachineId,
    crossMachineLanesByMachineId,
    lanes,
    machineOptions,
  ]);

  const [machineId, setMachineId] = useState(() => desiredMachineId);
  // Reconciliation tracks whether the latest project/persisted input was
  // applied. A user's machine choice inside that scope must remain ready even
  // before the parent echoes the persisted value back through props.
  const [reconciledRoutingInputKey, setReconciledRoutingInputKey] =
    useState(() => routingInputKey);
  const chooseMachine = useCallback((nextMachineId: string) => {
    setMachineId(nextMachineId);
    onDraftMachineChange?.(nextMachineId === boundMachineId ? null : nextMachineId);
  }, [boundMachineId, onDraftMachineChange]);

  useEffect(() => {
    setMachineId((currentMachineId) =>
      currentMachineId === desiredMachineId ? currentMachineId : desiredMachineId,
    );
    setReconciledRoutingInputKey(routingInputKey);
  }, [desiredMachineId, routingInputKey]);

  useEffect(() => {
    // A disabled draft has no catalog at all (`machineOptions` is empty by
    // construction), so falling back here would clear the user's persisted
    // machine every time the composer is replaced by a selected session.
    if (!enabled) return;
    if (machineOptions.some((option) => option.id === machineId)) return;
    // Preserve a persisted foreign choice only while the asynchronous catalog
    // is still loading. Once the catalog resolves (including a failed probe),
    // the local/bound machine is the safe fallback instead of leaving the
    // composer pinned to a machine that no longer exists in the options.
    if (!connectionCatalogResolvedRef.current && initialDraftMachineId?.trim() === machineId) return;
    chooseMachine(
      machineOptions.find((option) => option.isBound)?.id
        ?? machineOptions[0]?.id
        ?? boundMachineId,
    );
  }, [
    boundMachineId,
    chooseMachine,
    connectionCatalogResolved,
    enabled,
    initialDraftMachineId,
    machineId,
    machineOptions,
  ]);

  const executionLanes = lanesByMachineId.get(machineId) ?? NO_LANES;
  const machineIsKnown = machineOptions.some((option) => option.id === machineId);
  /**
   * Whether we have actually READ a lane list from the picked machine. A machine
   * that is merely known (it is in the picker) is not the same as a machine
   * whose catalog has landed: routing a selection against an empty, unread
   * catalog is what made "This computer" look like it had no Primary while the
   * tab was bound remotely.
   *
   * The clock has to be the LANE-specific one. `lastSyncedAtMs` advances on any
   * merge — including the sessions-only slice an optimistic foreign launch
   * writes — so reading it here declared an empty, never-read lane list "loaded":
   * that suppressed the pull-forward read below and remapped the selection
   * against nothing, surfacing "Selected lane is not available on the selected
   * machine" until the slow foreign cadence eventually landed.
   */
  const unionSlice = crossMachineLanesByMachineId[machineId];
  const executionLaneCatalogLoaded = machineId === boundMachineId
    ? boundLaneCatalogLoaded
    : unionSlice != null && (unionSlice.lanesSyncedAtMs != null || unionSlice.lanes.length > 0);
  /**
   * `null` means the union has not resolved its read set yet, so a catalog may
   * still be coming. Once it HAS resolved and this machine is not in it, no read
   * will ever arrive — claiming "loading" there would be a promise we cannot
   * keep, so fall back to the actionable unavailable message instead.
   *
   * An EMPTY list is the union's pre-resolution state at project open (the store
   * seeds the needle from an as-yet-empty slice map), not a resolved verdict, so
   * it must not be read as "this machine will never be read" — doing so makes the
   * composer flap to "unavailable" and back while the real read set resolves.
   */
  const unionWillReadMachine = crossMachineLaneIntendedMachineIds == null
    || crossMachineLaneIntendedMachineIds.length === 0
    || crossMachineLaneIntendedMachineIds.includes(machineId);
  /**
   * The union tried and failed. Retaining "still reading" past a recorded error
   * promises a catalog that is not coming; the unavailable message is at least
   * true and actionable.
   */
  const laneReadFailed = unionSlice != null && unionSlice.error != null && unionSlice.lanes.length === 0;
  const [laneCatalogHoldExpired, setLaneCatalogHoldExpired] = useState(false);
  useEffect(() => {
    if (!enabled || machineId === boundMachineId || executionLaneCatalogLoaded) {
      setLaneCatalogHoldExpired(false);
      return;
    }
    setLaneCatalogHoldExpired(false);
    const timer = setTimeout(() => setLaneCatalogHoldExpired(true), LANE_CATALOG_HOLD_MS);
    return () => clearTimeout(timer);
  }, [boundMachineId, enabled, executionLaneCatalogLoaded, machineId]);
  /**
   * True while a machine OTHER than the tab's own has been picked and we have
   * never read its lanes. The selection is held UNRESOLVED for that window
   * rather than falling back to another machine's lane: showing a foreign lane
   * is what let a launch be attempted against a lane id that machine has never
   * heard of.
   *
   * Scoped to foreign machines on purpose. The bound machine's lane list is
   * handed in directly and a draft can legitimately arrive before it hydrates —
   * that case keeps its existing tolerant launch path.
   *
   * The hold is BOUNDED: it ends on a recorded read failure, and in any case
   * after `LANE_CATALOG_HOLD_MS`. A hold that can never end turns "Loading lanes
   * for X…" into a permanent state that refuses every launch on that machine,
   * which is strictly worse than the unavailable message it was replacing.
   */
  const laneCatalogLoading = Boolean(
    enabled
    && machineId !== boundMachineId
    && !executionLaneCatalogLoaded
    && unionWillReadMachine
    && !laneReadFailed
    && !laneCatalogHoldExpired,
  );
  const selectorLanes = useMemo<RoutedDraftLane[]>(() => {
    if (!enabled) return (availableLanes ?? lanes) as RoutedDraftLane[];
    // Strictly the picked machine's lanes. A lane id from another machine is
    // not a row here — each machine has exactly one Primary, so preserving a
    // foreign one duplicated it in the list.
    return [AUTO_CREATE_DRAFT_LANE_OPTION, ...executionLanes];
  }, [availableLanes, enabled, executionLanes, lanes]);

  /**
   * The lane catalog of a machine the union has not read yet is fetched on its
   * slow foreign cadence. Picking that machine in the composer is a direct
   * request for it, so pull the read forward instead of leaving the composer
   * without lanes for up to `FOREIGN_LANE_REFRESH_MS`.
   */
  useEffect(() => {
    // `laneCatalogLoading` already implies a foreign machine. Depend on the
    // boolean rather than on `machineOptions`, which is a fresh array on every
    // connection snapshot and would re-fire this expensive status-depth read.
    if (!laneCatalogLoading || !machineIsKnown) return;
    requestCrossMachineLanesForMachine(machineId);
  }, [laneCatalogLoading, machineIsKnown, machineId]);

  /**
   * Re-resolve the selected lane against the machine that will run the launch.
   *
   * Only a machine CHANGE remaps. An unknown lane id on a machine that never
   * changed is a genuinely unavailable selection (a deleted lane, a deeplink
   * into another checkout) and must keep failing loudly rather than silently
   * retargeting the user's prompt at some other lane.
   */
  const laneRoutingRef = useRef<{ machineId: string; laneId: string | null }>({
    machineId,
    laneId,
  });
  useEffect(() => {
    if (!enabled) return;
    const previous = laneRoutingRef.current;
    if (previous.machineId === machineId) {
      laneRoutingRef.current = { machineId, laneId };
      return;
    }
    // Hold the selection unresolved until the new machine's catalog lands;
    // remapping against an empty list would pick nothing and then look like the
    // dropdown had rejected the user's machine.
    if (!executionLaneCatalogLoaded) return;
    // Lane ids are per-machine, so the only list that can explain the previous
    // lane is the machine it came from — flattening every machine would match a
    // same-id lane somewhere else.
    const previousLane = previous.laneId
      ? lanesByMachineId.get(previous.machineId)?.find(
        (candidate) => candidate.id === previous.laneId,
      )
        // That machine was never read (a persisted machine that turned out to be
        // unavailable), so its lane is unknowable. The id is still the user's
        // selection: let the TARGET machine answer for it — the same answer the
        // remap's same-id branch would give — rather than forcing a primary.
        ?? executionLanes.find((candidate) => candidate.id === previous.laneId)
        ?? null
      : null;
    const nextLane = remapDraftLaneToMachine(previousLane, executionLanes);
    // Nothing resolved (the catalog decoded to zero lanes): stay unresolved so
    // the remap runs again when that machine's real lane list lands. Committing
    // `machineId` here would short-circuit this effect forever.
    if (!nextLane) return;
    laneRoutingRef.current = { machineId, laneId: nextLane.id };
    if (nextLane.id !== laneId) onLaneChange?.(nextLane.id);
  }, [
    enabled,
    executionLaneCatalogLoaded,
    executionLanes,
    laneId,
    lanesByMachineId,
    machineId,
    onLaneChange,
  ]);

  const selectedLane = executionLanes.find((candidate) => candidate.id === laneId) ?? null;
  const selectedLaneIsPrimary = selectedLane != null && isPrimaryDraftLane(selectedLane);
  const selectedMachine = machineOptions.find((candidate) => candidate.id === machineId) ?? null;
  const machineUnavailable = Boolean(
    enabled && machineId !== boundMachineId && !selectedMachine,
  );

  const executionBinding = useMemo<OpenProjectBinding | null>(() => {
    if (!selectedMachine) {
      return machineOptions.length === 0 ? projectBinding : null;
    }
    if (selectedMachine.isBound) return projectBinding;
    const unionBinding = crossMachineLanesByMachineId[selectedMachine.id]?.binding ?? null;
    if (unionBinding) return unionBinding;
    if (!selectedMachine.project) return null;
    if (!selectedMachine.targetId) {
      return {
        kind: "local",
        key: `local:${selectedMachine.project.rootPath}`,
        rootPath: selectedMachine.project.rootPath,
        displayName: selectedMachine.project.displayName,
        gitOriginUrl: projectBinding?.gitOriginUrl ?? null,
      };
    }
    const connection = connectionSnapshot?.connections.find(
      (candidate) => candidate.target.id === selectedMachine.targetId,
    );
    const remoteProject = connection?.projects.find(
      (candidate) => candidate.projectId === selectedMachine.project?.projectId,
    );
    if (!remoteProject || !connection) return null;
    return {
      kind: "remote",
      key: remoteProjectBindingKey(connection.target.id, remoteProject.projectId),
      targetId: connection.target.id,
      runtimeName: connection.target.name,
      hostname: connection.target.hostname,
      projectId: remoteProject.projectId,
      rootPath: remoteProject.rootPath,
      displayName: remoteProject.displayName,
      gitOriginUrl: remoteProject.gitOriginUrl,
      iconDataUrl: remoteProject.icon?.dataUrl ?? null,
    };
  }, [
    connectionSnapshot,
    crossMachineLanesByMachineId,
    machineOptions.length,
    projectBinding,
    selectedMachine,
  ]);

  const selectorValue = draftLaunchTargetIsAutoCreate
    ? autoCreateLaneOptionId(null)
    : (
      laneId && executionLanes.some((candidate) => candidate.id === laneId)
        ? laneId
        : ""
    );

  const handleMachineChange = useCallback((nextMachineId: string) => {
    const nextMachine = machineOptions.find((candidate) => candidate.id === nextMachineId);
    if (!nextMachine) return;
    setError(null);
    chooseMachine(nextMachineId);
  }, [
    chooseMachine,
    machineOptions,
    setError,
  ]);

  const handleLaneSelectionChange = useCallback((nextLaneId: string) => {
    if (isAutoCreateLaneOptionId(nextLaneId)) {
      setDraftLaunchTargetId(AUTO_CREATE_LANE_OPTION_ID);
      return;
    }
    const routed = machineLaneFromOptionId(nextLaneId);
    const actualLaneId = routed?.laneId ?? nextLaneId;
    if (routed?.machineId && routed.machineId !== machineId) return;
    const nextLane = lanesByMachineId.get(machineId)?.find(
      (candidate) => candidate.id === actualLaneId,
    );
    if (!nextLane) return;
    setDraftLaunchTargetId(null);
    onLaneChange?.(actualLaneId);
  }, [
    lanesByMachineId,
    machineId,
    onLaneChange,
    setDraftLaunchTargetId,
  ]);

  return {
    machineOptions,
    selectorMachines,
    selectorLanes,
    boundMachineId,
    selectedMachineId: machineId,
    selectionReconciled: reconciledRoutingInputKey === routingInputKey,
    laneCatalogLoading,
    boundLaneCatalogLoaded,
    executionLanes,
    executionBinding,
    selectedMachine,
    selectedLaneIsPrimary,
    machineUnavailable,
    selectorValue,
    handleMachineChange,
    handleLaneSelectionChange,
  };
}

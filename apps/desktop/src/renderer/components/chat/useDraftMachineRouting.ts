import { useCallback, useEffect, useMemo, useState } from "react";
import { remoteProjectBindingKey } from "../../../shared/projectIdentity";
import type {
  LaneSummary,
  OpenProjectBinding,
  RecentProjectSummary,
  RemoteRuntimeConnectionSnapshot,
} from "../../../shared/types";
import type { CrossMachineMachineLanes } from "../../state/appStore";
import {
  AUTO_CREATE_LANE_OPTION_ID,
  autoCreateLaneOptionId,
  isAutoCreateLaneOptionId,
  machineIdFromAutoCreateLaneOptionId,
  machineLaneFromOptionId,
  machineLaneOptionId,
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

export type RoutedDraftLane = LaneComboboxLane & {
  laneType?: string | null;
  baseRef?: string | null;
  worktreePath?: string | null;
};

type DraftLaneInput = LaneComboboxLane & {
  laneType?: string | null;
};

type UseDraftMachineRoutingInput = {
  enabled: boolean;
  projectBinding: OpenProjectBinding | null;
  openProjectTabRoots: readonly string[];
  crossMachineLanesByMachineId: Readonly<Record<string, CrossMachineMachineLanes>>;
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
  const [knownLocalProjects, setKnownLocalProjects] = useState<RecentProjectSummary[]>([]);

  useEffect(() => {
    if (!enabled) return;
    const remoteRuntime = window.ade?.remoteRuntime;
    if (!remoteRuntime?.getConnectionSnapshot) return;
    let cancelled = false;
    const apply = (snapshot: RemoteRuntimeConnectionSnapshot) => {
      if (cancelled) return;
      setConnectionSnapshot((current) =>
        current && current.updatedAt > snapshot.updatedAt ? current : snapshot,
      );
    };
    void remoteRuntime.getConnectionSnapshot().then(apply).catch(() => {});
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

  const [machineId, setMachineId] = useState(
    () => initialDraftMachineId?.trim() || boundMachineId,
  );
  const chooseMachine = useCallback((nextMachineId: string) => {
    setMachineId(nextMachineId);
    onDraftMachineChange?.(nextMachineId === boundMachineId ? null : nextMachineId);
  }, [boundMachineId, onDraftMachineChange]);

  useEffect(() => {
    const requestedMachineId = initialDraftMachineId?.trim();
    if (
      requestedMachineId
      && requestedMachineId !== machineId
      && machineOptions.some((option) => option.id === requestedMachineId)
    ) {
      setMachineId(requestedMachineId);
    }
  }, [initialDraftMachineId, machineId, machineOptions]);

  useEffect(() => {
    if (machineOptions.some((option) => option.id === machineId)) return;
    // Preserve a persisted foreign choice while the asynchronous catalog is
    // still loading. If it remains unavailable, the launch path reports that
    // exact machine instead of silently falling back to the tab binding.
    if (initialDraftMachineId?.trim() === machineId) return;
    chooseMachine(
      machineOptions.find((option) => option.isBound)?.id
        ?? machineOptions[0]?.id
        ?? boundMachineId,
    );
  }, [boundMachineId, chooseMachine, initialDraftMachineId, machineId, machineOptions]);

  const selectorLanes = useMemo<RoutedDraftLane[]>(() => {
    if (!enabled) return (availableLanes ?? lanes) as RoutedDraftLane[];
    const routed = machineOptions.flatMap(
      (machine) => lanesByMachineId.get(machine.id) ?? [],
    );
    return [AUTO_CREATE_DRAFT_LANE_OPTION, ...routed];
  }, [availableLanes, enabled, lanes, lanesByMachineId, machineOptions]);

  const primaryLaneForMachine = useCallback((candidateMachineId: string) => {
    const machineLanes = lanesByMachineId.get(candidateMachineId) ?? [];
    return machineLanes.find((candidate) => candidate.laneType === "primary")
      ?? machineLanes.find((candidate) => candidate.name.trim().toLowerCase() === "primary")
      ?? machineLanes[0]
      ?? null;
  }, [lanesByMachineId]);

  const executionLanes = lanesByMachineId.get(machineId) ?? [];
  const selectedLane = executionLanes.find((candidate) => candidate.id === laneId) ?? null;
  const selectedLaneIsPrimary = selectedLane?.laneType === "primary"
    || selectedLane?.name.trim().toLowerCase() === "primary";
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
    ? autoCreateLaneOptionId(
      selectorMachines.length < 2 || machineId === selectorMachines[0]?.id
        ? null
        : machineId,
    )
    : (
      laneId && selectorMachines.length > 0
        ? machineLaneOptionId(machineId, laneId)
        : (laneId ?? "")
    );

  /**
   * Switching machines re-points the lane, but how far depends on what was
   * selected. Auto-create and the primary lane are the two targets ADE
   * guarantees exist on every machine running it, so a selection sitting on
   * either is still meaningful after the switch and is preserved — primary
   * re-points to the new machine's own primary (same role, different lane id),
   * and auto-create needs no re-pointing at all. Any other lane is specific to
   * the machine it was created on and cannot follow, so it lands on that
   * machine's primary instead of leaving the picker pointing at a lane that
   * does not exist there.
   */
  const handleMachineChange = useCallback((nextMachineId: string) => {
    const nextMachine = machineOptions.find((candidate) => candidate.id === nextMachineId);
    if (!nextMachine) return;
    setError(null);
    const wasAutoCreate = draftLaunchTargetIsAutoCreate;
    chooseMachine(nextMachineId);

    const fallback = primaryLaneForMachine(nextMachineId);
    if (fallback) {
      onLaneChange?.(fallback.id);
    }
    // Re-assert auto-create *after* re-pointing the lane. `onLaneChange` moves
    // the lane pointer to the new machine's primary, and a bare lane pointer
    // reads as "a specific lane is selected" — which would silently convert an
    // auto-create draft into a primary-lane draft, change the composer's draft
    // key, and discard whatever the user had typed. A machine with no lanes at
    // all lands here too: auto-create is the one target always launchable.
    if (wasAutoCreate || !fallback) {
      setDraftLaunchTargetId(AUTO_CREATE_LANE_OPTION_ID);
    }
  }, [
    chooseMachine,
    draftLaunchTargetIsAutoCreate,
    machineOptions,
    onLaneChange,
    primaryLaneForMachine,
    setDraftLaunchTargetId,
    setError,
  ]);

  const handleLaneSelectionChange = useCallback((nextLaneId: string) => {
    if (isAutoCreateLaneOptionId(nextLaneId)) {
      setDraftLaunchTargetId(AUTO_CREATE_LANE_OPTION_ID);
      // A bare auto-create id carries no machine. That used to mean "the first
      // machine", which was right when one grouped list owned both choices —
      // every auto-create row was machine-qualified. The shelf now picks the
      // machine in its own control and passes bare ids, so defaulting here
      // would silently drag the selection back to the bound machine. Keep
      // whatever the machine picker already chose.
      const explicitMachineId = machineIdFromAutoCreateLaneOptionId(nextLaneId);
      const machineIsAvailable = (candidate: string | null | undefined) =>
        Boolean(candidate && machineOptions.some((option) => option.id === candidate));
      const nextMachineId = machineIsAvailable(explicitMachineId)
        ? explicitMachineId!
        : machineIsAvailable(machineId)
          ? machineId
          : (
              machineOptions.find((option) => option.isBound)?.id
              ?? machineOptions[0]?.id
              ?? boundMachineId
            );
      chooseMachine(nextMachineId);
      const primary = primaryLaneForMachine(nextMachineId);
      if (primary) onLaneChange?.(primary.id);
      return;
    }
    const routed = machineLaneFromOptionId(nextLaneId);
    const actualLaneId = routed?.laneId ?? nextLaneId;
    const selectedMachineId = routed?.machineId ?? machineId;
    const nextLane = lanesByMachineId.get(selectedMachineId)?.find(
      (candidate) => candidate.id === actualLaneId,
    );
    if (!nextLane) return;
    chooseMachine(selectedMachineId);
    setDraftLaunchTargetId(null);
    onLaneChange?.(actualLaneId);
  }, [
    chooseMachine,
    boundMachineId,
    lanesByMachineId,
    machineId,
    machineOptions,
    onLaneChange,
    primaryLaneForMachine,
    setDraftLaunchTargetId,
  ]);

  return {
    machineOptions,
    selectorMachines,
    selectorLanes,
    boundMachineId,
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

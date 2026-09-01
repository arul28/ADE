import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
    initialDraftMachineId,
    machineId,
    machineOptions,
  ]);

  const executionLanes = lanesByMachineId.get(machineId) ?? [];
  const preservedLane = laneId
    ? Array.from(lanesByMachineId.values()).flat().find((candidate) => candidate.id === laneId) ?? {
        id: laneId,
        name: laneId,
        color: null,
        branchRef: null,
      }
    : null;
  const selectorLanes = useMemo<RoutedDraftLane[]>(() => {
    if (!enabled) return (availableLanes ?? lanes) as RoutedDraftLane[];
    const unavailableLane = preservedLane && !executionLanes.some((candidate) => candidate.id === preservedLane.id)
      ? [{
          ...preservedLane,
          name: `${preservedLane.name} (unavailable on selected machine)`,
        }]
      : [];
    return [AUTO_CREATE_DRAFT_LANE_OPTION, ...unavailableLane, ...executionLanes];
  }, [availableLanes, enabled, executionLanes, lanes, preservedLane]);

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
    ? autoCreateLaneOptionId(null)
    : (
      laneId && (executionLanes.some((candidate) => candidate.id === laneId) || preservedLane?.id === laneId)
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

import { useEffect, useMemo, useRef, useState } from "react";
import type { LaneSummary, OpenProjectBinding, RecentProjectSummary } from "../../../shared/types";
import { remoteProjectBindingKey } from "../../../shared/projectIdentity";
import { useAppStore, useRootAppStore } from "../../state/appStore";
import { buildAllMachineLanes } from "../../state/laneMachineRouting";
import { useRemoteConnectionSnapshot } from "../../state/projectMachines";
import {
  canCreateLaneOnMachine,
  deriveLaneMachineOptions,
  originUrlForBinding,
  rememberProjectOriginSummaries,
  withoutAdeCloudLaneComputers,
  type LaneMachineOption,
  type LaneMachineProjectRef,
} from "./laneMachines";
import { useMachinePlacement } from "./useMachinePlacement";
import { ADE_CLOUD_MACHINE_ID, useAdeCloudLaneTarget } from "./useAdeCloudLaneTarget";
import { useAdeCloudLaneComputers } from "../../state/adeCloudLaneIndex";

export type LaneMachineTarget = {
  /** Null for the tab's machine (unpinned path); else that machine's binding. */
  pin: OpenProjectBinding | null;
  /** That machine's lanes from the union, when known; null for the tab's. */
  lanes: LaneSummary[] | null;
};

/**
 * "Which machine does this new lane go on" — the always-ask machine choice
 * shared by every lane-creation entry (the create-lane dialog, the Linear
 * batch launch).
 *
 * There is no silent default: `selectedMachineId` is "" until the user picks,
 * except when exactly one machine can hold the lane (once the connection
 * snapshot has answered), which is then selected since there is nothing to
 * choose. Picking never rebinds the project tab; callers pin their calls to
 * `targetPin`.
 *
 * A machine is a target only when the cross-machine union resolved its
 * checkout's binding, or its checkout was matched by git origin. A checkout
 * matched only by folder name is never a target: it may be another repository.
 *
 * ADE Cloud is one more choice (`ADE_CLOUD_MACHINE_ID`) when the account has
 * access. It has no pin and no lanes here: the lane is made on a new computer
 * by an ADE Cloud launch, and the form reads the tab's machine meanwhile.
 *
 * Reads: one connection-snapshot read + one subscription to the existing
 * broadcast, both only while `open`. No polling. ADE Cloud adds the shared
 * cloud computer list while `open` (`useAdeCloudLaneTarget`).
 */
export function useLaneMachineChoice(open: boolean) {
  const projectBinding = useAppStore((s) => s.projectBinding);
  const project = useAppStore((s) => s.project);
  const openProjectTabRoots = useAppStore((s) => s.openProjectTabRoots);
  const unionMachines = useRootAppStore((s) => s.crossMachineLanesByMachineId);

  const { snapshot: remoteSnapshot, loaded: snapshotLoaded } = useRemoteConnectionSnapshot(open);
  /** The machine the user picked; "" until they pick one. */
  const [pickedMachineId, setPickedMachineId] = useState<string>("");
  /** This computer's checkouts with their origins, read while the dialog is open. */
  const [localProjects, setLocalProjects] = useState<RecentProjectSummary[] | undefined>(undefined);
  /** This computer's checkouts have been read (or cannot be), so the machine list is final. */
  const [localProjectsSettled, setLocalProjectsSettled] = useState(false);

  useEffect(() => {
    // Every open asks again.
    if (open) return;
    setPickedMachineId("");
    // A reopen reads them again; the old list must not match machines first.
    setLocalProjects(undefined);
    setLocalProjectsSettled(false);
  }, [open]);

  const boundProject = useMemo<LaneMachineProjectRef | null>(() => {
    if (projectBinding) {
      return {
        // The active binding IS this repo by definition — no inference involved.
        matchedBy: "origin" as const,
        projectId: projectBinding.kind === "remote" ? projectBinding.projectId : null,
        rootPath: projectBinding.rootPath,
        displayName: projectBinding.displayName,
      };
    }
    if (!project) return null;
    return {
      // The open project is the repo lanes are being created for, not a guess.
      matchedBy: "origin" as const,
      projectId: null,
      rootPath: project.rootPath,
      displayName: project.displayName,
    };
  }, [project, projectBinding]);

  const boundTargetId = projectBinding?.kind === "remote" ? projectBinding.targetId : null;

  /**
   * This computer's checkouts, with their origins, read while the dialog is
   * open. A project open on this computer is identified by its origin from
   * here: without it, the same repo on another machine matched only by folder
   * name and could not be picked.
   */
  useEffect(() => {
    if (!open) return;
    const listRecent = window.ade?.project?.listRecent;
    if (typeof listRecent !== "function") {
      setLocalProjectsSettled(true);
      return;
    }
    let cancelled = false;
    void listRecent()
      .then((projects) => {
        if (cancelled) return;
        rememberProjectOriginSummaries(projects, { replace: true });
        setLocalProjects(projects.filter(
          (candidate) => candidate.kind !== "remote" && candidate.exists !== false,
        ));
      })
      .catch((error: unknown) => {
        // Origins then fall back to what the binding and snapshot carry.
        console.warn("[useLaneMachineChoice] listRecent failed", error);
      })
      .finally(() => {
        if (!cancelled) setLocalProjectsSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  /** `origin` of the bound checkout: stamped, from the snapshot, or from this computer's recents. */
  const repoOriginUrl = useMemo(() => {
    const known = originUrlForBinding(projectBinding);
    if (known) return known;
    if (projectBinding?.kind === "remote") {
      const connection = remoteSnapshot?.connections.find(
        (candidate) => candidate.target.id === projectBinding.targetId,
      );
      return connection?.projects.find(
        (candidate) => candidate.projectId === projectBinding.projectId,
      )?.gitOriginUrl ?? null;
    }
    const rootPath = projectBinding?.rootPath ?? project?.rootPath ?? null;
    if (!rootPath) return null;
    return localProjects?.find((candidate) => candidate.rootPath === rootPath)?.gitOriginUrl ?? null;
  }, [localProjects, project, projectBinding, remoteSnapshot]);

  // A lane's own ADE Cloud computer is never a place for a new lane (one lane per computer).
  const { computers: adeCloudLaneComputers } = useAdeCloudLaneComputers();
  const baseMachines = useMemo(
    () =>
      withoutAdeCloudLaneComputers(deriveLaneMachineOptions({
        connections: remoteSnapshot?.connections ?? [],
        boundTargetId,
        boundProject,
        repoOriginUrl,
        repoDisplayName: boundProject?.displayName ?? null,
        localProjectRoots: openProjectTabRoots,
        ...(localProjects ? { localProjects } : {}),
      }), adeCloudLaneComputers),
    [adeCloudLaneComputers, boundProject, boundTargetId, localProjects, openProjectTabRoots, remoteSnapshot, repoOriginUrl],
  );
  // Stats and preferences for "Least loaded", read while the dialog is open.
  const machines = useMachinePlacement(baseMachines, open);

  /**
   * Where a create on each machine is sent. The tab's machine takes the
   * unpinned path. Another machine is addressed by the binding the union
   * resolved for it by git origin, else by an origin-proven checkout from the
   * snapshot. A checkout matched only by folder name is never a target: it may
   * be a different repository with the same name.
   */
  // The union's view of each machine: its binding (and so its pin) and lanes.
  const unionView = useMemo(
    () => buildAllMachineLanes({ activeBinding: projectBinding ?? null, activeLanes: [], machines: unionMachines ?? {} }),
    [projectBinding, unionMachines],
  );

  const machineTargets = useMemo(() => {
    const targets = new Map<string, { pin: OpenProjectBinding | null; lanes: LaneSummary[] | null }>();
    for (const machine of baseMachines) {
      if (machine.isBound) {
        targets.set(machine.id, { pin: null, lanes: null });
        continue;
      }
      const unionMachine = unionView.machinesById.get(machine.id);
      if (unionMachine?.binding) {
        const pin = unionMachine.pin;
        targets.set(machine.id, { pin, lanes: pin ? unionView.lanesByMachineId.get(machine.id) ?? [] : null });
        continue;
      }
      const checkout = machine.project;
      if (!checkout || checkout.matchedBy !== "origin") continue;
      if (machine.targetId && checkout.projectId) {
        targets.set(machine.id, {
          pin: {
            kind: "remote",
            key: remoteProjectBindingKey(machine.targetId, checkout.projectId),
            targetId: machine.targetId,
            runtimeName: machine.name,
            ...(machine.transport ? { transport: machine.transport } : {}),
            ...(machine.hostname ? { hostname: machine.hostname } : {}),
            projectId: checkout.projectId,
            rootPath: checkout.rootPath,
            displayName: checkout.displayName,
          },
          lanes: null,
        });
      } else if (!machine.targetId && checkout.rootPath) {
        targets.set(machine.id, {
          pin: {
            kind: "local",
            key: `local:${checkout.rootPath}`,
            rootPath: checkout.rootPath,
            displayName: checkout.displayName,
          },
          lanes: null,
        });
      }
    }
    return targets;
  }, [baseMachines, unionView]);

  const eligibleMachineIds = useMemo(
    () => machines
      .filter((machine) => canCreateLaneOnMachine(machine) && machineTargets.has(machine.id))
      .map((machine) => machine.id),
    [machineTargets, machines],
  );
  const adeCloud = useAdeCloudLaneTarget(open, repoOriginUrl);
  // ADE Cloud stays the pick only while it can be picked.
  const adeCloudPicked = pickedMachineId === ADE_CLOUD_MACHINE_ID && adeCloud.offered && !adeCloud.unavailableReason;
  // The picked machine while it is still eligible. With exactly one eligible
  // machine (once the snapshot has answered) there is nothing to ask.
  const selectedMachineId = adeCloudPicked
    ? ADE_CLOUD_MACHINE_ID
    : pickedMachineId && eligibleMachineIds.includes(pickedMachineId)
    ? pickedMachineId
    // Not before the origin read settles: until then other machines' copies
    // of the repo are unconfirmed, and "only one machine" may be wrong.
    : snapshotLoaded && localProjectsSettled && eligibleMachineIds.length === 1
      ? eligibleMachineIds[0]!
      : "";
  const selectedTarget = selectedMachineId ? machineTargets.get(selectedMachineId) ?? null : null;
  /** Pin for every call this dialog makes; null = the tab's machine. */
  const targetPin = selectedTarget?.pin ?? null;
  const targetPinKey = targetPin?.key ?? null;
  const targetPinRef = useRef<OpenProjectBinding | null>(targetPin);
  targetPinRef.current = targetPin;

  return {
    machines: machines as LaneMachineOption[],
    machineTargets: machineTargets as ReadonlyMap<string, LaneMachineTarget>,
    eligibleMachineIds,
    selectedMachineId,
    selectedTarget,
    targetPin,
    targetPinKey,
    targetPinRef,
    /** "" clears the pick. Only eligible machines (and ADE Cloud, when it can be picked) can end up selected. */
    setPickedMachineId,
    /** ADE Cloud as a choice: offered, why not, sizes, free computers. */
    adeCloud,
    /** The lane goes to ADE Cloud: no pin, no machine lanes; an ADE Cloud launch makes it. */
    adeCloudPicked,
    /** `origin` of the repo lanes are created for, when known. */
    repoOriginUrl,
  };
}

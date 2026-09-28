import { useEffect, useMemo, useRef, useState } from "react";
import type {
  LaneSummary,
  OpenProjectBinding,
  RemoteRuntimeConnectionSnapshot,
} from "../../../shared/types";
import { remoteProjectBindingKey } from "../../../shared/projectIdentity";
import { useAppStore, useRootAppStore } from "../../state/appStore";
import {
  canCreateLaneOnMachine,
  deriveLaneMachineOptions,
  type LaneMachineOption,
  type LaneMachineProjectRef,
} from "./laneMachines";

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
 * Reads: one connection-snapshot read + one subscription to the existing
 * broadcast, both only while `open`. No polling.
 */
export function useLaneMachineChoice(open: boolean) {
  const projectBinding = useAppStore((s) => s.projectBinding);
  const project = useAppStore((s) => s.project);
  const openProjectTabRoots = useAppStore((s) => s.openProjectTabRoots);
  const unionMachines = useRootAppStore((s) => s.crossMachineLanesByMachineId);

  const [remoteSnapshot, setRemoteSnapshot] = useState<RemoteRuntimeConnectionSnapshot | null>(null);
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);
  /** The machine the user picked; "" until they pick one. */
  const [pickedMachineId, setPickedMachineId] = useState<string>("");

  useEffect(() => {
    if (!open) {
      setSnapshotLoaded(false);
      // Every open asks again.
      setPickedMachineId("");
      return;
    }
    const remoteRuntime = window.ade.remoteRuntime;
    if (!remoteRuntime?.getConnectionSnapshot) {
      // No other machines can exist without the remote runtime bridge.
      setSnapshotLoaded(true);
      return;
    }
    let cancelled = false;
    const apply = (snapshot: RemoteRuntimeConnectionSnapshot) => {
      if (cancelled) return;
      setRemoteSnapshot((current) =>
        current && current.updatedAt > snapshot.updatedAt ? current : snapshot,
      );
      setSnapshotLoaded(true);
    };
    void remoteRuntime.getConnectionSnapshot().then(apply).catch(() => {
      if (!cancelled) setSnapshotLoaded(true);
    });
    const unsubscribe = remoteRuntime.onConnectionSnapshotChanged?.(apply) ?? (() => {});
    return () => {
      cancelled = true;
      unsubscribe();
    };
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

  /** `origin` of the bound checkout, taken straight from the snapshot record. */
  const repoOriginUrl = useMemo(() => {
    if (!boundTargetId || !projectBinding || projectBinding.kind !== "remote") return null;
    const connection = remoteSnapshot?.connections.find(
      (candidate) => candidate.target.id === boundTargetId,
    );
    const record = connection?.projects.find(
      (candidate) => candidate.projectId === projectBinding.projectId,
    );
    return record?.gitOriginUrl ?? null;
  }, [boundTargetId, projectBinding, remoteSnapshot]);

  const machines = useMemo(
    () =>
      deriveLaneMachineOptions({
        connections: remoteSnapshot?.connections ?? [],
        boundTargetId,
        boundProject,
        repoOriginUrl,
        repoDisplayName: boundProject?.displayName ?? null,
        localProjectRoots: openProjectTabRoots,
      }),
    [boundProject, boundTargetId, openProjectTabRoots, remoteSnapshot, repoOriginUrl],
  );

  /**
   * Where a create on each machine is sent. The tab's machine takes the
   * unpinned path. Another machine is addressed by the binding the union
   * resolved for it by git origin, else by an origin-proven checkout from the
   * snapshot. A checkout matched only by folder name is never a target: it may
   * be a different repository with the same name.
   */
  const machineTargets = useMemo(() => {
    const targets = new Map<string, { pin: OpenProjectBinding | null; lanes: LaneSummary[] | null }>();
    for (const machine of machines) {
      if (machine.isBound) {
        targets.set(machine.id, { pin: null, lanes: null });
        continue;
      }
      const entry = unionMachines?.[machine.id];
      if (entry?.binding) {
        const pin = entry.binding.key === projectBinding?.key ? null : entry.binding;
        targets.set(machine.id, { pin, lanes: pin ? entry.lanes : null });
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
  }, [machines, projectBinding?.key, unionMachines]);

  const eligibleMachineIds = useMemo(
    () => machines
      .filter((machine) => canCreateLaneOnMachine(machine) && machineTargets.has(machine.id))
      .map((machine) => machine.id),
    [machineTargets, machines],
  );
  // The picked machine while it is still eligible. With exactly one eligible
  // machine (once the snapshot has answered) there is nothing to ask.
  const selectedMachineId = pickedMachineId && eligibleMachineIds.includes(pickedMachineId)
    ? pickedMachineId
    : snapshotLoaded && eligibleMachineIds.length === 1
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
    /** "" clears the pick. Only eligible machines can end up selected. */
    setPickedMachineId,
  };
}

import React from "react";
import { useNavigate } from "react-router-dom";
import type {
  CreateLaneFromPrBranchPreflightResult,
  CreateLaneFromPrBranchResult,
  GitHubPrListItem,
} from "../../../../shared/types";
import { openLaneInLanesTabPath } from "../../../lib/laneNavigation";
import { selectActiveProjectRoot, useAppStore, useAppStoreApi } from "../../../state/appStore";
import { requestCrossMachineLanesForMachine } from "../../../state/crossMachineLanes";
import type { LaneMachine } from "../../../state/laneMachineRouting";
import { withMachineTimeout } from "../../../state/projectMachines";
import { useProjectMachinePicker } from "../../lanes/ProjectMachinePicker";
import type { PrMachineIndex } from "../state/prMachines";
import {
  CreateLaneFromPrBranchDialog,
  createLaneFromPrBranchApi,
  createLaneFromPrBranchArgs,
  createLaneFromPrBranchRequestKey,
  formatActionError,
} from "./GitHubTabCreateLaneDialog";

/** `openLaneInLanesTabPath` plus the owning machine, which the Lanes tab resolves. */
export function openLaneOnMachinePath(laneId: string, machineId: string): string {
  return `${openLaneInLanesTabPath(laneId)}&machineId=${encodeURIComponent(machineId)}`;
}

const CREATE_LANE_MACHINE_COPY = {
  title: "Where should this lane live?",
  description: "The pull request's branch is checked out into a new lane on the machine you pick. Its chats and runs stay on that machine.",
  confirmLabel: "Continue",
};

/**
 * "Create a lane from this PR's branch", on the machine the user picks.
 *
 * A new lane always names its machine. Preflight and create run on the chosen
 * machine (pinned, timed out, for another machine). A lane created on another
 * machine is never folded into the tab machine's state: that machine's slice
 * of the union is re-read and the lane opens where it lives. A lane created on
 * the tab's own machine is handed to `onCreatedOnTabMachine`, which owns the
 * PR list's bookkeeping.
 */
export function useCreateLaneFromPrBranch({
  machineIndex,
  onCreatedOnTabMachine,
}: {
  machineIndex: PrMachineIndex;
  onCreatedOnTabMachine: (
    result: CreateLaneFromPrBranchResult,
    item: GitHubPrListItem,
    createProjectRoot: string | null,
  ) => Promise<void>;
}): { open: (item: GitHubPrListItem) => Promise<void>; element: React.ReactNode } {
  const navigate = useNavigate();
  const appStore = useAppStoreApi();
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const { ask: askForMachine, element: machinePicker } = useProjectMachinePicker();
  const [item, setItem] = React.useState<GitHubPrListItem | null>(null);
  /** The machine the open dialog creates on; null = the tab's machine. */
  const [target, setTarget] = React.useState<LaneMachine | null>(null);
  /** Shown in the dialog whenever there was a machine to choose. */
  const [machineName, setMachineName] = React.useState<string | null>(null);
  const [preflight, setPreflight] = React.useState<CreateLaneFromPrBranchPreflightResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const requestIdRef = React.useRef(0);
  const requestRef = React.useRef<{ id: number; itemKey: string } | null>(null);
  const onCreatedRef = React.useRef(onCreatedOnTabMachine);
  onCreatedRef.current = onCreatedOnTabMachine;

  const close = React.useCallback(() => {
    requestRef.current = null;
    setItem(null);
    setTarget(null);
    setPreflight(null);
    setError(null);
    setLoading(false);
  }, []);

  const open = React.useCallback(async (next: GitHubPrListItem) => {
    const laneCountByMachineId = new Map(
      machineIndex.machines.map((machine) => [
        machine.machineId,
        machineIndex.lanesByMachineId.get(machine.machineId)?.length ?? 0,
      ] as const),
    );
    const chosen = await askForMachine(machineIndex.machines, { ...CREATE_LANE_MACHINE_COPY, laneCountByMachineId });
    if (!chosen) return;
    const nextTarget = chosen.isActiveBinding ? null : chosen;
    const requestId = requestIdRef.current + 1;
    const itemKey = createLaneFromPrBranchRequestKey(next);
    requestIdRef.current = requestId;
    requestRef.current = { id: requestId, itemKey };
    const isCurrent = () => requestRef.current?.id === requestId && requestRef.current.itemKey === itemKey;
    setItem(next);
    setTarget(nextTarget);
    setMachineName(machineIndex.machines.length > 1 ? chosen.machineName : null);
    setPreflight(null);
    setError(null);
    setLoading(true);
    const api = createLaneFromPrBranchApi();
    const preflightArgs = createLaneFromPrBranchArgs(next);
    void (nextTarget?.pin
      ? withMachineTimeout(api.preflightCreateLaneFromPrBranch(preflightArgs, nextTarget.pin), nextTarget.machineName)
      : api.preflightCreateLaneFromPrBranch(preflightArgs))
      .then((result) => {
        if (isCurrent()) setPreflight(result);
      })
      .catch((err) => {
        if (isCurrent()) setError(formatActionError(err));
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
  }, [askForMachine, machineIndex.lanesByMachineId, machineIndex.machines]);

  const cancel = React.useCallback(() => {
    if (!busy) close();
  }, [busy, close]);

  const confirm = React.useCallback(async (laneName: string) => {
    if (!item) return;
    setBusy(true);
    setError(null);
    const createProjectRoot = projectRoot;
    const createTarget = target;
    try {
      const api = createLaneFromPrBranchApi();
      const createArgs = createLaneFromPrBranchArgs(item, laneName);
      const result = createTarget?.pin
        ? await api.createLaneFromPrBranch(createArgs, createTarget.pin)
        : await api.createLaneFromPrBranch(createArgs);
      close();
      if (!createTarget?.pin) {
        await onCreatedRef.current(result, item, createProjectRoot);
        return;
      }
      // The lane and its PR row now live on that machine. Nothing here may
      // hold their ids as the tab machine's: refresh that machine's slice of
      // the union instead, and let the lane open where it lives.
      requestCrossMachineLanesForMachine(createTarget.machineId);
      const createdLaneId = result.lane?.id ?? null;
      const currentProjectRoot = selectActiveProjectRoot(appStore.getState());
      if (createdLaneId && (!createProjectRoot || currentProjectRoot === createProjectRoot)) {
        navigate(openLaneOnMachinePath(createdLaneId, createTarget.machineId));
      }
    } catch (err) {
      setError(formatActionError(err));
    } finally {
      setBusy(false);
    }
  }, [appStore, close, item, navigate, projectRoot, target]);

  const element = (
    <>
      {item ? (
        <CreateLaneFromPrBranchDialog
          item={item}
          preflight={preflight?.preflight ?? null}
          loading={loading}
          busy={busy}
          error={error}
          onCancel={cancel}
          onConfirm={confirm}
          machineName={machineName}
        />
      ) : null}
      {machinePicker}
    </>
  );
  return { open, element };
}

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog } from "../ui/dialog";
import { LaneMachineSelector } from "./LaneMachineSelector";
import type { LaneMachineOption } from "./laneMachines";
import type { LaneMachine } from "../../state/laneMachineRouting";

/**
 * "Which machine?" for a lane created outside the create-lane dialog (a lane
 * from a PR's branch). Reuses the lane dialog's machine cards so the choice
 * reads the same everywhere. There is no default: nothing submits until a
 * machine is picked.
 */

function optionFor(machine: LaneMachine, laneCount: number | null): LaneMachineOption {
  const binding = machine.binding;
  return {
    id: machine.machineId,
    name: machine.machineName,
    targetId: binding?.kind === "remote" ? binding.targetId : null,
    hostname: binding?.kind === "remote" ? binding.hostname ?? null : null,
    ...(binding?.kind === "remote" ? { transport: binding.transport ?? "ssh" } : {}),
    version: machine.version,
    freeBytes: null,
    activeLaneCount: laneCount,
    // Every offered machine is a checkout of this repo by construction: the
    // union only carries machines matched on the repo's origin.
    repoMatch: "matched",
    project: binding
      ? {
          projectId: binding.kind === "remote" ? binding.projectId : null,
          rootPath: binding.rootPath,
          displayName: binding.displayName,
          matchedBy: "origin",
        }
      : null,
    isBound: machine.isActiveBinding,
  };
}

type MachineRequest = {
  title: string;
  description: string;
  confirmLabel: string;
  machines: LaneMachine[];
  laneCountByMachineId: ReadonlyMap<string, number>;
  resolve: (machine: LaneMachine | null) => void;
};

export type AskForMachine = (
  machines: readonly LaneMachine[],
  copy: {
    title: string;
    description: string;
    confirmLabel?: string;
    /** Lanes each machine already has, for the placement hint. */
    laneCountByMachineId?: ReadonlyMap<string, number>;
  },
) => Promise<LaneMachine | null>;

/**
 * `ask(machines, copy)` resolves with the chosen machine, or null on cancel.
 * Only reachable machines are offered. With one reachable machine there is no
 * choice to make, so it resolves to that machine without a dialog.
 */
export function useProjectMachinePicker(): { ask: AskForMachine; element: ReactNode } {
  const [request, setRequest] = useState<MachineRequest | null>(null);
  const requestRef = useRef<MachineRequest | null>(null);

  const settle = useCallback((machine: LaneMachine | null) => {
    const current = requestRef.current;
    requestRef.current = null;
    setRequest(null);
    current?.resolve(machine);
  }, []);

  const ask = useCallback<AskForMachine>((machines, copy) => {
    const reachable = machines.filter((machine) => machine.online && machine.routable);
    if (reachable.length <= 1) return Promise.resolve(reachable[0] ?? null);
    // A second ask supersedes the first; the first resolves as cancelled.
    requestRef.current?.resolve(null);
    return new Promise((resolve) => {
      const next: MachineRequest = {
        title: copy.title,
        description: copy.description,
        confirmLabel: copy.confirmLabel ?? "Continue",
        machines: reachable,
        laneCountByMachineId: copy.laneCountByMachineId ?? new Map(),
        resolve,
      };
      requestRef.current = next;
      setRequest(next);
    });
  }, []);

  const element = request ? (
    <ProjectMachinePickerDialog request={request} onSettle={settle} />
  ) : null;
  return { ask, element };
}

function ProjectMachinePickerDialog({
  request,
  onSettle,
}: {
  request: MachineRequest;
  onSettle: (machine: LaneMachine | null) => void;
}) {
  const [selectedMachineId, setSelectedMachineId] = useState("");
  const options = useMemo(
    () => request.machines.map((machine) => optionFor(machine, request.laneCountByMachineId.get(machine.machineId) ?? null)),
    [request.laneCountByMachineId, request.machines],
  );
  const selected = request.machines.find((machine) => machine.machineId === selectedMachineId) ?? null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onSettle(null);
      }}
      title={request.title}
      description={request.description}
      width={480}
      actions={[
        { label: "Cancel", variant: "secondary", onClick: () => onSettle(null) },
        {
          label: request.confirmLabel,
          variant: "solid",
          disabled: !selected,
          onClick: () => {
            if (selected) onSettle(selected);
          },
        },
      ]}
    >
      <LaneMachineSelector
        machines={options}
        selectedMachineId={selectedMachineId}
        onSelectMachine={setSelectedMachineId}
      />
    </Dialog>
  );
}

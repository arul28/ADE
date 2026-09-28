import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog } from "../ui/dialog";
import { LaneMachineSelector } from "../lanes/LaneMachineSelector";
import type { LaneMachineOption } from "../lanes/laneMachines";
import type { ProjectMachineTarget } from "./projectMachines";

/**
 * "Which machine?" for create actions outside the create-lane dialog (a new
 * automation, a lane from a PR). Reuses the lane dialog's machine cards so the
 * choice reads the same everywhere. There is no default: nothing submits until
 * a machine is picked.
 */

function optionForTarget(target: ProjectMachineTarget): LaneMachineOption {
  const binding = target.binding;
  return {
    id: target.machineId,
    name: target.machineName,
    targetId: binding?.kind === "remote" ? binding.targetId : null,
    hostname: binding?.kind === "remote" ? binding.hostname ?? null : null,
    ...(binding?.kind === "remote" ? { transport: binding.transport ?? "ssh" } : {}),
    version: null,
    freeBytes: null,
    activeLaneCount: target.lanes.length,
    // Every target is a checkout of this repo by construction: the union only
    // carries machines matched on the repo's origin.
    repoMatch: "matched",
    project: binding
      ? {
          projectId: binding.kind === "remote" ? binding.projectId : null,
          rootPath: binding.rootPath,
          displayName: binding.displayName,
          matchedBy: "origin",
        }
      : null,
    isBound: target.isActive,
  };
}

type MachineRequest = {
  title: string;
  description: string;
  confirmLabel: string;
  targets: ProjectMachineTarget[];
  resolve: (target: ProjectMachineTarget | null) => void;
};

export type AskForMachine = (
  targets: readonly ProjectMachineTarget[],
  copy: { title: string; description: string; confirmLabel?: string },
) => Promise<ProjectMachineTarget | null>;

/**
 * `ask(targets, copy)` resolves with the chosen machine, or null on cancel.
 * Offline machines are not offered. With one reachable machine there is no
 * choice to make, so it resolves to that machine without a dialog.
 */
export function useProjectMachinePicker(): { ask: AskForMachine; element: ReactNode } {
  const [request, setRequest] = useState<MachineRequest | null>(null);
  const requestRef = useRef<MachineRequest | null>(null);

  const settle = useCallback((target: ProjectMachineTarget | null) => {
    const current = requestRef.current;
    requestRef.current = null;
    setRequest(null);
    current?.resolve(target);
  }, []);

  const ask = useCallback<AskForMachine>((targets, copy) => {
    const reachable = targets.filter((target) => target.online);
    if (reachable.length <= 1) return Promise.resolve(reachable[0] ?? null);
    // A second ask supersedes the first; the first resolves as cancelled.
    requestRef.current?.resolve(null);
    return new Promise((resolve) => {
      const next: MachineRequest = {
        title: copy.title,
        description: copy.description,
        confirmLabel: copy.confirmLabel ?? "Continue",
        targets: reachable,
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
  onSettle: (target: ProjectMachineTarget | null) => void;
}) {
  const [selectedMachineId, setSelectedMachineId] = useState("");
  const options = useMemo(() => request.targets.map(optionForTarget), [request.targets]);
  const selected = request.targets.find((target) => target.machineId === selectedMachineId) ?? null;
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

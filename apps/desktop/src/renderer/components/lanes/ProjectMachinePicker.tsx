import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog } from "../ui/dialog";
import { LaneMachineSelector } from "./LaneMachineSelector";
import { isAdeCloudLaneComputer, type LaneMachineOption } from "./laneMachines";
import type { LaneMachine } from "../../state/laneMachineRouting";
import { adeCloudEnabled } from "../../state/cloudAccess";
import { cloudLaneStartBlock } from "../../../shared/cloudLaneLaunch";
import type { CloudTierId } from "../../../shared/cloudTiers";
import { CloudSizeButton } from "../chat/AdeCloudComposerParts";
import { ADE_CLOUD_MACHINE_ID, useAdeCloudLaneTarget } from "./useAdeCloudLaneTarget";
import { useMachineLabelForMachine } from "../cloudLane/useMachineLabelForMachine";

/** ADE Cloud was picked: the lane gets a new computer of this size. */
export type AdeCloudPick = { kind: "ade-cloud"; sizeId: CloudTierId };

export function isAdeCloudPick(value: LaneMachine | AdeCloudPick | null): value is AdeCloudPick {
  return value != null && "kind" in value && value.kind === "ade-cloud";
}

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
  /** Offer ADE Cloud, for a project with this origin; undefined = never. */
  adeCloudOriginUrl: string | null | undefined;
  resolve: (machine: LaneMachine | AdeCloudPick | null) => void;
};

export type AskForMachine = (
  machines: readonly LaneMachine[],
  copy: {
    title: string;
    description: string;
    confirmLabel?: string;
    /** Lanes each machine already has, for the placement hint. */
    laneCountByMachineId?: ReadonlyMap<string, number>;
    /**
     * Offer ADE Cloud as one more place (the project's origin), when the
     * account has access. Left out: machines only.
     */
    adeCloudOriginUrl?: string | null;
  },
) => Promise<LaneMachine | AdeCloudPick | null>;

/**
 * `ask(machines, copy)` resolves with the chosen machine, ADE Cloud (when
 * offered), or null on cancel. Only reachable machines are offered. With one
 * reachable machine and no ADE Cloud there is no choice to make, so it
 * resolves to that machine without a dialog.
 */
export function useProjectMachinePicker(): { ask: AskForMachine; element: ReactNode } {
  const [request, setRequest] = useState<MachineRequest | null>(null);
  const requestRef = useRef<MachineRequest | null>(null);

  const settle = useCallback((machine: LaneMachine | AdeCloudPick | null) => {
    const current = requestRef.current;
    requestRef.current = null;
    setRequest(null);
    current?.resolve(machine);
  }, []);

  const ask = useCallback<AskForMachine>((machines, copy) => {
    // A lane's own ADE Cloud computer never takes a new lane: only "ADE Cloud" (a new computer) shows.
    const reachable = machines.filter((machine) =>
      machine.online
      && machine.routable
      && !isAdeCloudLaneComputer({ hostname: machine.hostname, machineKey: machine.machineId }));
    const offerCloud = copy.adeCloudOriginUrl !== undefined && adeCloudEnabled();
    if (reachable.length <= 1 && !offerCloud) return Promise.resolve(reachable[0] ?? null);
    // A second ask supersedes the first; the first resolves as cancelled.
    requestRef.current?.resolve(null);
    return new Promise((resolve) => {
      const next: MachineRequest = {
        title: copy.title,
        description: copy.description,
        confirmLabel: copy.confirmLabel ?? "Continue",
        machines: reachable,
        laneCountByMachineId: copy.laneCountByMachineId ?? new Map(),
        adeCloudOriginUrl: offerCloud ? copy.adeCloudOriginUrl : undefined,
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
  onSettle: (machine: LaneMachine | AdeCloudPick | null) => void;
}) {
  const [selectedMachineId, setSelectedMachineId] = useState("");
  // The cloud read runs only while this dialog is open.
  const offerCloud = request.adeCloudOriginUrl !== undefined;
  const adeCloud = useAdeCloudLaneTarget(offerCloud, request.adeCloudOriginUrl ?? null);
  const cloudPicked = offerCloud && selectedMachineId === ADE_CLOUD_MACHINE_ID;
  const cloudProblem = cloudPicked ? cloudLaneStartBlock(adeCloud.account, { newLane: true })?.message ?? null : null;
  // An ADE Cloud lane's computer reads "Cloud · <lane>".
  const labelOf = useMachineLabelForMachine();
  const options = useMemo(
    () => request.machines.map((machine) => ({
      ...optionFor(machine, request.laneCountByMachineId.get(machine.machineId) ?? null),
      name: labelOf({ machineId: machine.machineId, binding: machine.binding, name: machine.machineName }),
    })),
    [labelOf, request.laneCountByMachineId, request.machines],
  );
  const selected = request.machines.find((machine) => machine.machineId === selectedMachineId) ?? null;
  const canConfirm = cloudPicked ? !cloudProblem : Boolean(selected);
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
          disabled: !canConfirm,
          onClick: () => {
            if (cloudPicked && !cloudProblem) onSettle({ kind: "ade-cloud", sizeId: adeCloud.tierId });
            else if (selected) onSettle(selected);
          },
        },
      ]}
    >
      <LaneMachineSelector
        machines={options}
        selectedMachineId={cloudPicked ? "" : selectedMachineId}
        onSelectMachine={setSelectedMachineId}
        adeCloud={offerCloud && adeCloud.offered
          ? {
            selected: cloudPicked,
            unavailableReason: adeCloud.unavailableReason,
            detail: adeCloud.detail,
            onSelect: () => setSelectedMachineId(ADE_CLOUD_MACHINE_ID),
          }
          : null}
      />
      {cloudPicked ? (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-fg/75">
          <CloudSizeButton
            tiers={adeCloud.tiers}
            tierId={adeCloud.tierId}
            defaultTier={adeCloud.defaultTier}
            onChoose={adeCloud.chooseTier}
            onSetDefault={adeCloud.setDefaultTier}
          />
          <span className={cloudProblem ? "text-[color:var(--kit-warn)]" : undefined}>
            {cloudProblem ?? `A new ${adeCloud.tiers.find((tier) => tier.id === adeCloud.tierId)?.label ?? "Small"} computer for this lane.`}
          </span>
        </div>
      ) : null}
    </Dialog>
  );
}

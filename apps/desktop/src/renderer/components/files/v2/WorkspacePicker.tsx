import React from "react";
import { Stack } from "@phosphor-icons/react";
import type { FilesWorkspace } from "../../../../shared/types";
import { COLORS } from "../../lanes/laneDesignTokens";
import type { LaneMachineChipModel } from "../../lanes/LaneMachineChip";
import {
  MachineLaneSelect,
  laneOptionLabel,
  type MachineLaneSelectGroup,
} from "../../lanes/MachineLaneSelect";

/** Lanes on a machine other than the one Files is reading from right now. */
export type WorkspacePickerMachineGroup = {
  machine: LaneMachineChipModel;
  /** Why nothing here can be opened ("Mac Studio is offline"), or null. */
  disabledReason: string | null;
  lanes: Array<{
    /** Opaque option value the host decodes; never a workspace id. */
    value: string;
    name: string;
    branchRef: string | null;
  }>;
};

/**
 * Compact workspace/lane picker pinned above the file tree (purple-accented).
 *
 * With `machine` + `otherMachines` it lists every lane on every machine,
 * grouped by machine. Picking a lane on another machine is how Files moves to
 * that machine; the lane implies the machine, so there is no separate switch.
 */
export function WorkspacePicker({
  workspaces,
  workspaceId,
  onChange,
  machine = null,
  otherMachines = [],
  onPickOtherMachineLane,
}: {
  workspaces: FilesWorkspace[];
  workspaceId: string;
  onChange: (workspaceId: string) => void;
  /** The machine the listed `workspaces` are on; names their group heading. */
  machine?: LaneMachineChipModel | null;
  otherMachines?: WorkspacePickerMachineGroup[];
  onPickOtherMachineLane?: (value: string) => void;
}) {
  const active = workspaces.find((w) => w.id === workspaceId);
  // Lanes on other machines are listed only when there are some to pick.
  const multiMachine = machine != null && otherMachines.length > 0 && onPickOtherMachineLane != null;
  const otherValues = React.useMemo(() => {
    const values = new Set<string>();
    for (const group of otherMachines) for (const lane of group.lanes) values.add(lane.value);
    return values;
  }, [otherMachines]);
  const groups = React.useMemo<MachineLaneSelectGroup[]>(() => {
    const current: MachineLaneSelectGroup = {
      key: machine?.machineId ?? "current",
      machineName: machine?.machineName ?? "",
      online: machine?.online ?? true,
      disabledReason: null,
      options: workspaces.map((ws) => ({ value: ws.id, label: laneOptionLabel(ws) })),
    };
    if (!multiMachine) return [current];
    return [
      current,
      ...otherMachines.map((group) => ({
        key: group.machine.machineId,
        machineName: group.machine.machineName,
        online: group.machine.online,
        disabledReason: group.disabledReason,
        options: group.lanes.map((lane) => {
          const label = laneOptionLabel({ name: lane.name, branchRef: lane.branchRef, kind: "worktree" });
          return { value: lane.value, label, title: `${label} · ${group.machine.machineName}` };
        }),
      })),
    ];
  }, [machine, multiMachine, otherMachines, workspaces]);
  return (
    <div
      className="flex shrink-0 items-center gap-1.5 px-2 py-1.5"
      style={{ borderBottom: `1px solid ${COLORS.border}` }}
    >
      <Stack size={13} color={COLORS.accent} weight="fill" />
      <MachineLaneSelect
        value={workspaceId}
        groups={groups}
        title={active ? laneOptionLabel(active) : undefined}
        onChange={(value) => {
          if (multiMachine && otherValues.has(value)) {
            onPickOtherMachineLane?.(value);
            return;
          }
          onChange(value);
        }}
      />
    </div>
  );
}

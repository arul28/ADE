import { Desktop, DesktopTower, Plus } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { formatBytes } from "../../lib/format";
import { LABEL_CLASS_NAME, SECTION_CLASS_NAME, CARD_CLASS_NAME, CARD_ACTIVE_CLASS_NAME } from "./laneDialogTokens";
import {
  canCreateLaneOnMachine,
  isLowLaneMachineDisk,
  THIS_MACHINE_ID,
  type LaneMachineOption,
} from "./laneMachines";

/**
 * "Create on" — the machine a new lane (and therefore every chat inside it)
 * will live on.
 *
 * Deliberately does NOT reuse the dialog's "Remote"/"Local" vocabulary: that
 * pair already means the git base-branch source a few rows below. Machines are
 * named absolutely instead ("This Mac", "MacBook Pro (97)").
 */
export function LaneMachineSelector({
  machines,
  selectedMachineId,
  onSelectMachine,
  onConnectMachine,
  disabled,
}: {
  machines: LaneMachineOption[];
  selectedMachineId: string;
  onSelectMachine: (machineId: string) => void;
  onConnectMachine?: () => void;
  disabled?: boolean;
}) {
  return (
    <section className={SECTION_CLASS_NAME} data-tour="lanes.createDialog.machine">
      <span className={LABEL_CLASS_NAME}>Create on</span>
      <div
        className="mt-2 grid grid-cols-2 gap-2"
        role="radiogroup"
        aria-label="Machine for this lane"
      >
        {machines.map((machine) => (
          <LaneMachineCard
            key={machine.id}
            machine={machine}
            selected={machine.id === selectedMachineId}
            disabled={disabled}
            onSelect={() => onSelectMachine(machine.id)}
          />
        ))}
      </div>
      {onConnectMachine ? (
        <button
          type="button"
          className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-fg/70 transition-colors hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
          disabled={disabled}
          onClick={onConnectMachine}
        >
          <Plus size={11} weight="bold" />
          Connect another machine…
        </button>
      ) : null}
    </section>
  );
}

function LaneMachineCard({
  machine,
  selected,
  disabled,
  onSelect,
}: {
  machine: LaneMachineOption;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  const available = canCreateLaneOnMachine(machine);
  const Icon = machine.id === THIS_MACHINE_ID ? Desktop : DesktopTower;
  const lowDisk = isLowLaneMachineDisk(machine.freeBytes);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled || !available}
      title={available ? undefined : `${machine.name} doesn't have this repo yet.`}
      onClick={onSelect}
      className={cn(CARD_CLASS_NAME, "!p-2.5", selected && CARD_ACTIVE_CLASS_NAME)}
    >
      <div className="flex items-start gap-2">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-muted-fg"
          aria-hidden="true"
        >
          <Icon size={14} weight="duotone" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-fg">{machine.name}</div>
          {machine.freeBytes !== null ? (
            <div
              className={cn(
                "mt-0.5 text-[10px]",
                lowDisk ? "text-amber-300" : "text-muted-fg/70",
              )}
            >
              {formatBytes(machine.freeBytes)} free
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-1 truncate text-[10px] leading-snug text-muted-fg/60">
        {machineDetailLine(machine, available)}
      </div>
    </button>
  );
}

function machineDetailLine(machine: LaneMachineOption, available: boolean): string {
  if (!available) return "This repo isn't here yet";
  if (machine.project) return machine.project.rootPath;
  if (machine.hostname) return machine.hostname;
  return "Connected";
}

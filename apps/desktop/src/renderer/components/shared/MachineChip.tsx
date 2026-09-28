import { Desktop, DesktopTower } from "@phosphor-icons/react";
import { SmartTooltip } from "../ui/SmartTooltip";
import { cn } from "../ui/cn";
import type { MachineChipModel } from "../../state/laneMachineRouting";

/**
 * The machine chip for a row that belongs to one machine: a lane, a PR's lane,
 * an automation rule, a history event. One neutral identity pill everywhere.
 *
 * Unlike the Work sidebar's amber `LaneMachineMarker`, which flags only other
 * machines' lanes, this goes on every row (this computer's included) once the
 * project spans more than one machine (`shouldShowMachineChips`), because a
 * list across machines needs the owner on each row; amber would read as a
 * warning on every row. An offline machine's chip is greyed and its tooltip
 * says so. Build the model with `machineChipFor`.
 */
export function MachineChip({
  machine,
  subject,
  className,
  compact = false,
}: {
  machine: MachineChipModel;
  /** What the chip belongs to, for the tooltip: "This lane", "This rule", "This event". */
  subject: string;
  className?: string;
  /** Icon only, for dense rows; the name stays in the tooltip and label. */
  compact?: boolean;
}) {
  const Icon = machine.isThisMachine ? Desktop : DesktopTower;
  return (
    <SmartTooltip
      forceEnabled
      content={{
        label: machine.machineName,
        description: machine.online
          ? `${subject} lives on ${machine.machineName}. Its actions run there.`
          : `${machine.machineName} is offline. Shown as last reported; its actions are unavailable.`,
      }}
    >
      <span
        role="img"
        className={cn(
          "inline-flex min-w-0 shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium leading-none",
          machine.online
            ? "border-border/60 bg-fg/[0.04] text-muted-fg/80"
            : "border-border/30 bg-transparent text-muted-fg/45",
          className,
        )}
        aria-label={machine.online ? machine.machineName : `${machine.machineName}, offline`}
        data-machine-id={machine.machineId}
        data-machine-online={machine.online ? "true" : "false"}
      >
        <Icon
          size={10}
          weight="duotone"
          className={cn("shrink-0", machine.online ? "text-muted-fg/70" : "text-muted-fg/40")}
        />
        {compact ? null : <span className="max-w-20 truncate">{machine.machineName}</span>}
      </span>
    </SmartTooltip>
  );
}

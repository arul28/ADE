import { Desktop, DesktopTower } from "@phosphor-icons/react";
import { SmartTooltip } from "../ui/SmartTooltip";
import { cn } from "../ui/cn";
import type { MachineChipModel } from "./projectMachines";
import { shouldShowMachineChips } from "../../state/laneMachineRouting";
import { useTimelineStore } from "./useTimelineStore";
import type { TimelineMachineTag } from "./timelineTypes";

/**
 * The machine chip for PR, automation and history rows. Same neutral identity
 * pill as the Lanes tab's `LaneMachineChip`; the tooltip names what lives
 * there ("this rule", "this lane"), since these rows are not all lanes.
 * Callers decide whether to render it with `shouldShowMachineChips`.
 */
export function MachineChip({
  machine,
  subject,
  className,
  compact = false,
}: {
  machine: MachineChipModel;
  /** What the chip belongs to, for the tooltip: "This rule", "This lane", … */
  subject: string;
  className?: string;
  /** Icon only, for dense table rows; the name stays in the tooltip and label. */
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

/** Which machine recorded an event; shown on every row once History spans machines. */
export function EventMachineChip({
  event,
  compact = false,
}: {
  event: TimelineMachineTag;
  /** Icon only: the dense timeline tables have no width to spare. */
  compact?: boolean;
}) {
  const machineCount = useTimelineStore((s) => s.machines.length);
  if (!event.machineName || !shouldShowMachineChips({ length: machineCount })) return null;
  return (
    <MachineChip
      subject="This event"
      compact={compact}
      machine={{
        machineId: event.machineId ?? event.machineKey ?? event.machineName,
        machineName: event.machineName,
        online: event.machineOnline !== false,
        isThisMachine: event.machineIsHere === true,
      }}
    />
  );
}

/** Rows from an offline machine stay visible but read as inert. */
export function isEventMachineOffline(event: TimelineMachineTag): boolean {
  return event.machineOnline === false;
}

import { MachineChip } from "../shared/MachineChip";
import { machineChipFor, shouldShowMachineChips } from "../../state/laneMachineRouting";
import { useTimelineStore } from "./useTimelineStore";
import type { TimelineMachineTag } from "./timelineTypes";

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
  if (!event.machine || !shouldShowMachineChips(machineCount)) return null;
  return <MachineChip subject="This event" compact={compact} machine={machineChipFor(event.machine)} />;
}

/** Rows from an offline machine stay visible but read as inert. */
export function isEventMachineOffline(event: TimelineMachineTag): boolean {
  return event.machine?.online === false;
}

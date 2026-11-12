import { MachineChip } from "../shared/MachineChip";
import { rowMachineChip } from "../../state/laneMachineRouting";
import type { TimelineMachineTag } from "./timelineTypes";

/** Which machine recorded an event; shown only when it is not this computer. */
export function EventMachineChip({
  event,
  compact = false,
}: {
  event: TimelineMachineTag;
  /** Icon only: the dense timeline tables have no width to spare. */
  compact?: boolean;
}) {
  const chip = rowMachineChip(event.machine);
  return chip ? <MachineChip subject="This event" compact={compact} machine={chip} /> : null;
}

/** Rows from an offline machine stay visible but read as inert. */
export function isEventMachineOffline(event: TimelineMachineTag): boolean {
  return event.machine?.online === false;
}

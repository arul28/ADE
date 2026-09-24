import { TerminalWindow } from "@phosphor-icons/react";

import { LaneAccentDot } from "../../lanes/LaneAccentDot";
import type { ToastChip, ToastInput } from "./toastStore";

/** One id, so a re-detection updates the visible notice in place. */
export const STALE_CLI_TOAST_ID = "stale-cli-sessions";

/** How many lanes get their own chip before the rest fold into "+N more". */
const MAX_LANE_CHIPS = 4;

export type StaleCliToastLane = {
  laneId: string;
  laneName: string;
  count: number;
  color: string | null;
};

/**
 * Pure: the idle CLI/shell sessions notice. Sticky — it leaves only when the
 * user acts on it, dismisses it (which snoozes it for an hour), or the idle
 * sessions go away.
 */
export function buildStaleCliToast({
  count,
  ageHours,
  lanes,
  onViewProcesses,
  onDismiss,
}: {
  count: number;
  ageHours: number;
  lanes: StaleCliToastLane[];
  onViewProcesses: () => void;
  onDismiss: () => void;
}): ToastInput & { id: string } {
  const chips: ToastChip[] = lanes.slice(0, MAX_LANE_CHIPS).map((lane) => ({
    label: lane.count > 1 ? `${lane.laneName} ×${lane.count}` : lane.laneName,
    icon: <LaneAccentDot color={lane.color ?? "currentColor"} size={6} ringed={false} />,
    title: `${lane.count} idle session${lane.count === 1 ? "" : "s"} in ${lane.laneName}`,
  }));
  if (lanes.length > MAX_LANE_CHIPS) {
    chips.push({ label: `+${lanes.length - MAX_LANE_CHIPS} more` });
  }
  return {
    id: STALE_CLI_TOAST_ID,
    tone: "warning",
    icon: <TerminalWindow size={15} weight="fill" />,
    badge: "Idle sessions",
    title: `${count} CLI or shell session${count === 1 ? "" : "s"} sitting idle`,
    message: `No activity for about ${ageHours} hours. Close anything you're done with to free up memory.`,
    chips: chips.length > 0 ? chips : undefined,
    actions: [{ label: "View processes", variant: "solid", onClick: onViewProcesses }],
    closeTitle: "Dismiss for an hour",
    onClose: onDismiss,
    durationMs: 0,
  };
}

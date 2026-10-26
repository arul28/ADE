import { COLORS } from "../lanes/laneDesignTokens";
import { WORK_BOARD_COLUMNS } from "./WorkKanbanBoard";
import type { WorkLaneFocusStatus } from "./workLaneFocus";

/**
 * A collapsed lane's rolled-up status in the board column's own accent and
 * words, so a lane header and the board never describe the same work
 * differently: yellow needs you, blue working, grey waiting, green done. A
 * failed chat in the lane turns it red, whatever the column.
 */
export function LaneFocusStatusDot({ status, failed = false }: { status: WorkLaneFocusStatus; failed?: boolean }) {
  const column = WORK_BOARD_COLUMNS.find((entry) => entry.key === status);
  if (!column) return null;
  const label = failed ? "Lane: a chat failed" : `Lane: ${column.label}`;
  return (
    <span
      role="img"
      aria-label={label}
      title={failed ? label : `${label} — ${column.hint}`}
      data-testid="lane-focus-status"
      data-status={failed ? "failed" : status}
      className="h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ background: failed ? COLORS.danger : column.accent }}
    />
  );
}

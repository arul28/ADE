import { WORK_BOARD_COLUMNS } from "./WorkKanbanBoard";
import type { WorkLaneFocusStatus } from "./workLaneFocus";

/**
 * A lane's rolled-up status in the board column's own accent and words, so a
 * lane header and the board never describe the same work differently.
 */
export function LaneFocusStatusDot({ status }: { status: WorkLaneFocusStatus }) {
  const column = WORK_BOARD_COLUMNS.find((entry) => entry.key === status);
  if (!column) return null;
  const label = `Lane: ${column.label}`;
  return (
    <span
      role="img"
      aria-label={label}
      title={`${label} — ${column.hint}`}
      data-testid="lane-focus-status"
      data-status={status}
      className="h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ background: column.accent }}
    />
  );
}

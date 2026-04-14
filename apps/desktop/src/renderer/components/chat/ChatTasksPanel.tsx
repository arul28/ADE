import React, { useMemo, useState } from "react";
import {
  CheckCircle,
  Circle,
  CircleNotch,
  ListChecks,
} from "@phosphor-icons/react";
import type { TodoItemSnapshot } from "./chatExecutionSummary";
import { cn } from "../ui/cn";
import { BottomDrawerSection } from "./BottomDrawerSection";

/* ── Status visuals ── */

function statusIcon(status: TodoItemSnapshot["status"]) {
  switch (status) {
    case "completed":
      return <CheckCircle size={14} weight="fill" className="text-emerald-400/80" />;
    case "in_progress":
      return <CircleNotch size={14} weight="bold" className="text-sky-400/80 animate-spin" />;
    default:
      return <Circle size={14} weight="regular" className="text-fg/20" />;
  }
}

function statusTextClass(status: TodoItemSnapshot["status"]) {
  switch (status) {
    case "completed":
      return "text-fg/40 line-through decoration-fg/15";
    case "in_progress":
      return "text-fg/75";
    default:
      return "text-fg/55";
  }
}

// In-progress first, then pending, then completed.
const STATUS_SORT_ORDER: Record<TodoItemSnapshot["status"], number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
};

/* ── Component ── */

export const ChatTasksPanel = React.memo(function ChatTasksPanel({
  items,
}: {
  items: TodoItemSnapshot[];
}) {
  const [expanded, setExpanded] = useState(true);

  const { completedCount, inProgressCount, pendingCount } = useMemo(() => {
    let completed = 0;
    let inProgress = 0;
    let pending = 0;
    for (const item of items) {
      if (item.status === "completed") completed++;
      else if (item.status === "in_progress") inProgress++;
      else pending++;
    }
    return { completedCount: completed, inProgressCount: inProgress, pendingCount: pending };
  }, [items]);

  const sortedItems = useMemo(
    () => [...items].sort((a, b) => STATUS_SORT_ORDER[a.status] - STATUS_SORT_ORDER[b.status]),
    [items],
  );

  if (!items.length) return null;

  const summaryContent = (
    <span className="flex items-center gap-2 text-[12px]">
      <span className="text-fg/50">{completedCount}/{items.length} complete</span>
      {inProgressCount > 0 ? <span className="text-sky-400/70">{inProgressCount} active</span> : null}
      {pendingCount > 0 ? <span className="text-fg/30">{pendingCount} pending</span> : null}
    </span>
  );

  return (
    <BottomDrawerSection
      label="Tasks"
      icon={ListChecks}
      summary={summaryContent}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      <div className="space-y-px py-1">
        {sortedItems.map((item) => (
          <div
            key={item.id}
            className={cn(
              "flex items-start gap-2.5 px-3 py-1.5 transition-colors",
              item.status === "in_progress" && "bg-sky-500/[0.03]",
            )}
          >
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
              {statusIcon(item.status)}
            </span>
            <span className={cn("text-[13px] leading-snug", statusTextClass(item.status))}>
              {item.description}
            </span>
          </div>
        ))}
      </div>
    </BottomDrawerSection>
  );
});

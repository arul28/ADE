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

const STATUS_ORDER = ["in_progress", "pending", "completed"] as const;
const STATUS_SORT_ORDER = new Map<TodoItemSnapshot["status"], number>(
  STATUS_ORDER.map((status, index) => [status, index]),
);

const STATUS_GROUP_LABEL: Record<TodoItemSnapshot["status"], string> = {
  in_progress: "In progress",
  pending: "Pending",
  completed: "Done",
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
    () => [...items].sort((a, b) => (STATUS_SORT_ORDER.get(a.status) ?? 0) - (STATUS_SORT_ORDER.get(b.status) ?? 0)),
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
      <ChatTaskList items={sortedItems} />
    </BottomDrawerSection>
  );
});

export const ChatTaskList = React.memo(function ChatTaskList({
  items,
  className,
}: {
  items: TodoItemSnapshot[];
  className?: string;
}) {
  const groupedItems = useMemo(
    () => STATUS_ORDER
      .map((status) => ({
        status,
        items: items
          .filter((item) => item.status === status),
      }))
      .filter((group) => group.items.length > 0),
    [items],
  );

  if (!items.length) return null;

  return (
    <div className={cn("space-y-2 py-1", className)}>
      {groupedItems.map((group) => (
        <section key={group.status} className="min-w-0">
          <div className="flex h-5 items-center justify-between px-3 font-sans text-[10px] font-medium uppercase tracking-[0.06em] text-fg/35">
            <span>{STATUS_GROUP_LABEL[group.status]}</span>
            <span className="tabular-nums">{group.items.length}</span>
          </div>
          <div className="space-y-px">
            {group.items.map((item) => (
              <div
                key={item.id}
                className={cn(
                  "ade-chat-task-row flex min-h-8 items-start gap-2.5 rounded-md px-3 py-1.5",
                  item.status === "in_progress" && "ade-chat-task-row-active bg-sky-400/[0.035]",
                )}
              >
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                  {statusIcon(item.status)}
                </span>
                <span className={cn("min-w-0 flex-1 break-words text-[13px] leading-snug", statusTextClass(item.status))}>
                  {item.description}
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
});

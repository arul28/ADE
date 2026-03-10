import React from "react";
import { Lightning, ChatCircle, Brain } from "@phosphor-icons/react";
import type { WorkerAgentRun, AgentSessionLogEntry } from "../../../shared/types";
import { TimelineEntry } from "./shared/TimelineEntry";
import { cn } from "../ui/cn";
import { labelCls } from "./shared/designTokens";

type ActivityItem = {
  id: string;
  type: "run" | "session";
  timestamp: string;
  title: string;
  subtitle?: string;
  status?: string;
  statusVariant?: "info" | "success" | "warning" | "error" | "muted";
  icon: React.ElementType;
};

function mergeActivity(runs: WorkerAgentRun[], sessions: AgentSessionLogEntry[]): ActivityItem[] {
  const items: ActivityItem[] = [];

  for (const run of runs) {
    items.push({
      id: `run-${run.id}`,
      type: "run",
      timestamp: run.createdAt,
      title: `Heartbeat: ${run.wakeupReason}`,
      subtitle: [run.taskKey, run.issueKey, run.errorMessage].filter(Boolean).join(" · "),
      status: run.status,
      statusVariant: run.status === "running" ? "info"
        : run.status === "completed" ? "success"
        : run.status === "failed" ? "error"
        : run.status === "deferred" ? "warning"
        : "muted",
      icon: Lightning,
    });
  }

  for (const session of sessions) {
    items.push({
      id: `session-${session.id}`,
      type: "session",
      timestamp: session.createdAt,
      title: session.summary,
      status: session.capabilityMode,
      statusVariant: session.capabilityMode === "full_mcp" ? "success" : "muted",
      icon: ChatCircle,
    });
  }

  items.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return items;
}

export function WorkerActivityFeed({
  runs,
  sessions,
}: {
  runs: WorkerAgentRun[];
  sessions: AgentSessionLogEntry[];
}) {
  const items = mergeActivity(runs, sessions);

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8">
        <Brain size={24} weight="thin" className="text-muted-fg/20 mb-2" />
        <div className="font-mono text-[10px] text-muted-fg/50">No activity recorded yet.</div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className={cn(labelCls, "mb-1")}>Activity ({items.length})</div>
      {items.map((item) => (
        <TimelineEntry
          key={item.id}
          timestamp={item.timestamp}
          title={item.title}
          subtitle={item.subtitle}
          status={item.status}
          statusVariant={item.statusVariant}
          icon={item.icon}
        />
      ))}
    </div>
  );
}

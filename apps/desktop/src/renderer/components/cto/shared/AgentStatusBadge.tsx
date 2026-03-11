import React from "react";
import type { AgentStatus } from "../../../../shared/types";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";
import { agentStatusMap } from "./designTokens";

type Size = "sm" | "md";

export function AgentStatusBadge({
  status,
  size = "sm",
  showDot = true,
  showLabel = true,
}: {
  status: AgentStatus;
  size?: Size;
  showDot?: boolean;
  showLabel?: boolean;
}) {
  const info = agentStatusMap[status] ?? agentStatusMap.idle;

  return (
    <span className="inline-flex items-center gap-1.5">
      {showDot && (
        <span
          className={cn(
            "shrink-0 rounded-full",
            size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2",
            info.dotCls,
          )}
        />
      )}
      {showLabel && (
        <Chip
          className={cn(
            info.textCls,
            size === "sm" ? "text-[8px]" : "text-[9px]",
          )}
        >
          {info.label}
        </Chip>
      )}
    </span>
  );
}

export function AgentStatusDot({
  status,
  size = "sm",
}: {
  status: AgentStatus;
  size?: Size;
}) {
  const info = agentStatusMap[status] ?? agentStatusMap.idle;
  return (
    <span
      className={cn(
        "inline-block shrink-0 rounded-full",
        size === "sm" ? "h-2 w-2" : "h-2.5 w-2.5",
        info.dotCls,
      )}
    />
  );
}

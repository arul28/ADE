import React from "react";
import { cn } from "../../ui/cn";

type ConnectionStatus = "connected" | "degraded" | "disconnected";

const STATUS_MAP: Record<ConnectionStatus, { dotCls: string; label: string }> = {
  connected: { dotCls: "bg-success animate-none", label: "Connected" },
  degraded: { dotCls: "bg-warning animate-pulse", label: "Degraded" },
  disconnected: { dotCls: "bg-error", label: "Disconnected" },
};

export function ConnectionStatusDot({
  status,
  label,
  className,
}: {
  status: ConnectionStatus;
  label?: string;
  className?: string;
}) {
  const info = STATUS_MAP[status];
  const displayLabel = label ?? info.label;

  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border border-border/10 bg-surface-recessed px-2 py-1", className)}>
      <span className={cn("h-2 w-2 shrink-0 rounded-full", info.dotCls)} />
      <span className="font-sans text-[9px] text-muted-fg">{displayLabel}</span>
    </span>
  );
}

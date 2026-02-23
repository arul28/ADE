import React from "react";
import { Warning as AlertTriangle, CheckCircle as CheckCircle2 } from "@phosphor-icons/react";
import { cn } from "../ui/cn";

type PrConflictBadgeProps = {
  riskLevel: "high" | "medium" | "low" | "none" | null;
  overlappingFileCount?: number;
  className?: string;
};

export function PrConflictBadge({ riskLevel, overlappingFileCount, className }: PrConflictBadgeProps) {
  if (!riskLevel || riskLevel === "none") {
    return (
      <span className={cn("inline-flex items-center gap-1 text-[11px] text-emerald-500", className)}>
        <CheckCircle2 size={12} weight="regular" />
        clean
      </span>
    );
  }

  const colors = {
    high: "text-red-500",
    medium: "text-amber-500",
    low: "text-yellow-500",
  }[riskLevel];

  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px]", colors, className)}>
      <AlertTriangle size={12} weight="regular" />
      {riskLevel}
      {overlappingFileCount != null && overlappingFileCount > 0 && (
        <span className="text-muted-fg">({overlappingFileCount})</span>
      )}
    </span>
  );
}

import React from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { cn } from "../ui/cn";

type PrConflictBadgeProps = {
  riskLevel: "high" | "medium" | "low" | "none" | null;
  overlappingFileCount?: number;
  className?: string;
};

export function PrConflictBadge({ riskLevel, overlappingFileCount, className }: PrConflictBadgeProps) {
  if (!riskLevel || riskLevel === "none") {
    return (
      <span className={cn("inline-flex items-center gap-1 text-[10px] text-emerald-500", className)}>
        <CheckCircle2 className="h-3 w-3" />
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
    <span className={cn("inline-flex items-center gap-1 text-[10px]", colors, className)}>
      <AlertTriangle className="h-3 w-3" />
      {riskLevel}
      {overlappingFileCount != null && overlappingFileCount > 0 && (
        <span className="text-muted-fg">({overlappingFileCount})</span>
      )}
    </span>
  );
}

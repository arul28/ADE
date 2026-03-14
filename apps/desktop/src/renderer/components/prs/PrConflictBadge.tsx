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
      <span className={cn(
        "inline-flex items-center gap-1 text-[11px] text-emerald-500 rounded-md px-1.5 py-0.5 bg-emerald-500/8 border border-emerald-500/15 shadow-[0_0_6px_-1px_rgba(16,185,129,0.2)]",
        className
      )}>
        <CheckCircle2 size={12} weight="regular" className="ade-glow-pulse-green" />
        clean
      </span>
    );
  }

  const colors = {
    high: "text-red-500 bg-red-500/8 border-red-500/20",
    medium: "text-amber-500 bg-amber-500/8 border-amber-500/20",
    low: "text-yellow-500 bg-yellow-500/8 border-yellow-500/20",
  }[riskLevel];

  return (
    <span className={cn(
      "inline-flex items-center gap-1 text-[11px] rounded-md px-1.5 py-0.5 border transition-all duration-200",
      colors,
      riskLevel === "high" && "ade-glow-pulse-red shadow-[0_0_8px_-2px_rgba(239,68,68,0.2)]",
      riskLevel === "medium" && "ade-conflict-breathe shadow-[0_0_6px_-2px_rgba(245,158,11,0.15)]",
      riskLevel === "low" && "shadow-[0_0_4px_-1px_rgba(234,179,8,0.1)]",
      className
    )}>
      <AlertTriangle size={12} weight="regular" />
      {riskLevel}
      {overlappingFileCount != null && overlappingFileCount > 0 && (
        <span className="text-muted-fg">({overlappingFileCount})</span>
      )}
    </span>
  );
}

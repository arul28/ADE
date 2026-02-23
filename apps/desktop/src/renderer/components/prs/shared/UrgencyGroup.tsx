import React from "react";
import { CaretRight, CaretDown } from "@phosphor-icons/react";
import { cn } from "../../ui/cn";

type UrgencyGroupProps = {
  title: string;
  count: number;
  color: string;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
};

export function UrgencyGroup({
  title,
  count,
  color,
  collapsed,
  onToggle,
  children,
}: UrgencyGroupProps) {
  return (
    <div className="rounded-xl border border-border/20 bg-card/45 backdrop-blur-sm shadow-card overflow-hidden">
      {/* Header */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-muted/20 transition-colors"
      >
        {collapsed ? (
          <CaretRight size={14} className="text-muted-fg/60 shrink-0" />
        ) : (
          <CaretDown size={14} className="text-muted-fg/60 shrink-0" />
        )}
        <span
          className={cn("h-2 w-2 rounded-full shrink-0")}
          style={{ backgroundColor: color }}
        />
        <span className="font-medium text-foreground/90">{title}</span>
        <span
          className="ml-auto inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none"
          style={{ backgroundColor: `${color}20`, color }}
        >
          {count}
        </span>
      </button>

      {/* Collapsible body */}
      {!collapsed && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

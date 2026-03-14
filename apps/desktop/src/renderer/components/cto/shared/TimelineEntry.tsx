import React, { useState } from "react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function TimelineEntry({
  timestamp,
  title,
  subtitle,
  status,
  statusVariant,
  icon: Icon,
  children,
  defaultExpanded = false,
}: {
  timestamp: string;
  title: string;
  subtitle?: string;
  status?: string;
  statusVariant?: "info" | "success" | "warning" | "error" | "muted";
  icon?: React.ElementType;
  children?: React.ReactNode;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasChildren = Boolean(children);

  const variantClasses: Record<string, string> = {
    info: "text-info bg-info/10 border-info/20",
    success: "text-success bg-success/10 border-success/20",
    warning: "text-warning bg-warning/10 border-warning/20",
    error: "text-error bg-error/10 border-error/20",
    muted: "text-muted-fg bg-muted/10 border-border/10",
  };

  return (
    <div className="bg-surface-recessed border border-border/10 px-2.5 py-2">
      <div className="flex items-start gap-2">
        {/* Left: icon or expand toggle */}
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="mt-0.5 shrink-0 text-muted-fg/50 hover:text-fg transition-colors"
          >
            {expanded ? <CaretDown size={10} /> : <CaretRight size={10} />}
          </button>
        ) : Icon ? (
          <Icon size={10} weight="bold" className="mt-0.5 shrink-0 text-muted-fg/40" />
        ) : (
          <span className="w-2.5 shrink-0" />
        )}

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] text-muted-fg truncate">
              {title}
            </span>
            <div className="flex items-center gap-2 shrink-0">
              {status && (
                <Chip
                  className={cn(
                    "text-[8px]",
                    variantClasses[statusVariant ?? "muted"],
                  )}
                >
                  {status}
                </Chip>
              )}
              <span className="font-mono text-[9px] text-muted-fg/40">
                {formatTimestamp(timestamp)}
              </span>
            </div>
          </div>
          {subtitle && (
            <div className="font-mono text-[9px] text-muted-fg/50 mt-0.5 line-clamp-2">
              {subtitle}
            </div>
          )}
        </div>
      </div>

      {/* Expandable content */}
      {hasChildren && expanded && (
        <div className="ml-4 mt-2 pl-2 border-l border-border/20">
          {children}
        </div>
      )}
    </div>
  );
}

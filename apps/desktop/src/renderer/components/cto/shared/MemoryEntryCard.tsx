import React from "react";
import {
  PushPin,
  ArrowUp,
  Archive,
  Trash,
} from "@phosphor-icons/react";
import type { MemoryEntryDto } from "../../../../shared/types";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";

const tierLabel = (tier: number) =>
  tier === 1 ? "T1" : tier === 2 ? "T2" : tier === 3 ? "T3" : "ARC";

const tierColor = (tier: number) =>
  tier === 1
    ? "text-success bg-success/10 border-success/20"
    : tier === 2
      ? "text-info bg-info/10 border-info/20"
      : tier === 3
        ? "text-warning bg-warning/10 border-warning/20"
        : "text-muted-fg bg-muted/10 border-border/10";

const importanceColor = (imp: string) =>
  imp === "high"
    ? "text-error"
    : imp === "medium"
      ? "text-warning"
      : "text-muted-fg/50";

export function MemoryEntryCard({
  entry,
  compact = false,
  selected = false,
  onClick,
  onPin,
  onPromote,
  onArchive,
  onDelete,
}: {
  entry: MemoryEntryDto;
  compact?: boolean;
  selected?: boolean;
  onClick?: () => void;
  onPin?: () => void;
  onPromote?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
}) {
  const hasActions = onPin || onPromote || onArchive || onDelete;

  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter") onClick(); } : undefined}
      className={cn(
        "group border bg-surface-recessed transition-all duration-100",
        selected
          ? "border-accent/30 bg-accent/5"
          : "border-border/10 hover:border-border/30",
        onClick && "cursor-pointer",
        compact ? "px-2.5 py-1.5" : "px-3 py-2.5",
      )}
    >
      {/* Top row: category + tier + importance */}
      <div className="flex items-center gap-1.5">
        <Chip className="text-[8px] text-accent bg-accent/10 border-accent/20">
          {entry.category}
        </Chip>
        <Chip className={cn("text-[8px]", tierColor(entry.tier))}>
          {tierLabel(entry.tier)}
        </Chip>
        {entry.pinned && (
          <PushPin size={8} weight="fill" className="text-accent" />
        )}
        <span className={cn("ml-auto text-[8px] font-mono", importanceColor(entry.importance))}>
          {entry.importance}
        </span>
      </div>

      {/* Content */}
      <div
        className={cn(
          "font-mono text-fg/80 mt-1.5 leading-relaxed",
          compact ? "text-[9px] line-clamp-1" : "text-[10px] line-clamp-2",
        )}
      >
        {entry.content}
      </div>

      {/* Bottom row: confidence + access count + actions */}
      <div className="flex items-center justify-between mt-1.5">
        <div className="flex items-center gap-2">
          {/* Confidence bar */}
          <div className="flex items-center gap-1">
            <span className="font-mono text-[8px] text-muted-fg/40">conf</span>
            <div className="w-12 h-1 bg-border/20 overflow-hidden">
              <div
                className="h-full bg-accent/60 transition-all"
                style={{ width: `${Math.round(entry.confidence * 100)}%` }}
              />
            </div>
          </div>
          <span className="font-mono text-[8px] text-muted-fg/30">
            {entry.accessCount}x
          </span>
        </div>

        {/* Quick actions — visible on hover */}
        {hasActions && (
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {onPin && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onPin(); }}
                className="p-1 text-muted-fg/40 hover:text-accent transition-colors"
                title={entry.pinned ? "Unpin" : "Pin"}
              >
                <PushPin size={10} weight={entry.pinned ? "fill" : "regular"} />
              </button>
            )}
            {onPromote && entry.status === "candidate" && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onPromote(); }}
                className="p-1 text-muted-fg/40 hover:text-success transition-colors"
                title="Promote"
              >
                <ArrowUp size={10} />
              </button>
            )}
            {onArchive && entry.status !== "archived" && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onArchive(); }}
                className="p-1 text-muted-fg/40 hover:text-warning transition-colors"
                title="Archive"
              >
                <Archive size={10} />
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="p-1 text-muted-fg/40 hover:text-error transition-colors"
                title="Delete"
              >
                <Trash size={10} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

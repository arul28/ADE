import React from "react";
import { ChevronDown, ChevronRight, GripVertical } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "./cn";
import type { DropEdge } from "./paneTreeOps";

/* ---- Drop zone overlay position mapping ---- */

function getDropZoneStyle(edge: DropEdge): React.CSSProperties | null {
  switch (edge) {
    case "top":
      return { top: 0, left: 0, right: 0, height: "50%" };
    case "bottom":
      return { bottom: 0, left: 0, right: 0, height: "50%" };
    case "left":
      return { top: 0, left: 0, bottom: 0, width: "50%" };
    case "right":
      return { top: 0, right: 0, bottom: 0, width: "50%" };
    case "center":
      return null;
  }
}

export function FloatingPane({
  id,
  title,
  icon: Icon,
  meta,
  headerActions,
  minimized,
  onMinimizeToggle,
  minimizable = true,
  draggable: isDraggable,
  isDragging,
  isDropTarget,
  dropEdge,
  onDragStart,
  onDragOverRaw,
  onDragEnd,
  onDrop,
  onDragLeave,
  minimizeBehavior = "css",
  className,
  bodyClassName,
  children
}: {
  id: string;
  title: string;
  icon?: LucideIcon;
  meta?: React.ReactNode;
  headerActions?: React.ReactNode;
  minimized?: boolean;
  onMinimizeToggle?: () => void;
  minimizable?: boolean;
  draggable?: boolean;
  isDragging?: boolean;
  isDropTarget?: boolean;
  dropEdge?: DropEdge | null;
  onDragStart?: () => void;
  onDragOverRaw?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  onDrop?: () => void;
  onDragLeave?: () => void;
  minimizeBehavior?: "css" | "native";
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
    onDragStart?.();
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    onDragOverRaw?.(e);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    onDrop?.();
  };

  const handleDragEnd = () => {
    onDragEnd?.();
  };

  const handleDragLeave = (e: React.DragEvent) => {
    // Only fire if leaving the pane itself, not a child
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    onDragLeave?.();
  };

  const dropZoneStyle = dropEdge ? getDropZoneStyle(dropEdge) : null;
  const usesCssMinimize = minimizeBehavior === "css";
  const hideBody = usesCssMinimize && minimized;

  return (
    <div
      data-pane-id={id}
      className={cn(
        "ade-floating-pane relative",
        usesCssMinimize && minimized && "minimized",
        isDragging && "dragging",
        isDropTarget && !dropZoneStyle && "drop-target",
        className
      )}
      onDragOver={isDraggable ? handleDragOver : undefined}
      onDrop={isDraggable ? handleDrop : undefined}
      onDragLeave={isDraggable ? handleDragLeave : undefined}
    >
      <div
        className={cn("ade-floating-pane-header", minimized && "ade-floating-pane-header-minimized")}
        draggable={isDraggable}
        onDragStart={isDraggable ? handleDragStart : undefined}
        onDragEnd={isDraggable ? handleDragEnd : undefined}
      >
        <div className="flex items-center gap-1 min-w-0">
          {isDraggable ? (
            <GripVertical className="h-2.5 w-2.5 text-muted-fg/30 shrink-0 cursor-grab" />
          ) : null}
          {minimizable ? (
            <button
              type="button"
              className={cn(
                "flex h-4 w-4 items-center justify-center rounded-sm transition-colors",
                minimized
                  ? "text-accent"
                  : "text-muted-fg/50 hover:text-fg"
              )}
              onClick={(event) => {
                event.stopPropagation();
                onMinimizeToggle?.();
              }}
              onMouseDown={(event) => event.stopPropagation()}
              title={minimized ? "Expand pane" : "Minimize pane"}
            >
              {minimized ? (
                <ChevronRight className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
            </button>
          ) : null}
          {Icon ? (
            <Icon className={cn(
              "shrink-0",
              minimized ? "h-3.5 w-3.5 text-fg/70" : "h-3 w-3 text-muted-fg/50"
            )} />
          ) : null}
          <span className={cn("ade-pane-title truncate")}>{title}</span>
          {meta && !minimized ? <span className="font-mono text-[9px] text-muted-fg/40 truncate">{meta}</span> : null}
        </div>
        {headerActions ? (
          <div className={cn("flex items-center gap-0.5 shrink-0 ml-1", minimized && "opacity-60")}>
            {headerActions}
          </div>
        ) : null}
      </div>
      <div className={cn("flex-1 min-h-0 overflow-auto", hideBody && "hidden", bodyClassName)}>
        {children}
      </div>
      {/* Drop zone overlay */}
      {dropZoneStyle ? (
        <div className="ade-drop-zone-overlay" style={dropZoneStyle} />
      ) : null}
    </div>
  );
}

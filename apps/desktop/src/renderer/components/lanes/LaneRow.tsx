import React from "react";
import { ExternalLink, GitBranch, TerminalSquare } from "lucide-react";
import type { LaneSummary } from "../../state/appStore";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { cn } from "../ui/cn";

export function LaneRow({
  lane,
  selected,
  onSelect
}: {
  lane: LaneSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card/60 p-3 transition-colors hover:bg-card/80",
        selected && "ring-2 ring-accent/40"
      )}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect();
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-muted-fg" />
            <div className="truncate text-sm font-semibold">{lane.name}</div>
          </div>
          {lane.description ? <div className="mt-1 truncate text-xs text-muted-fg">{lane.description}</div> : null}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" disabled title="New terminal (Phase 0)">
            <TerminalSquare className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" disabled title="Open folder (Phase 1)">
            <ExternalLink className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <Chip>dirty: ?</Chip>
        <Chip>ahead/behind: ?</Chip>
        <Chip>tests: ?</Chip>
        <Chip>PR: ?</Chip>
        <Chip>conflicts: ?</Chip>
      </div>
    </div>
  );
}


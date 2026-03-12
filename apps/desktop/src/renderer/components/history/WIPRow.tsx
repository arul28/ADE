import React from "react";
import { Spinner } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import type { WIPNode } from "./timelineTypes";

type WIPRowProps = {
  wipNodes: WIPNode[];
};

export function WIPRow({ wipNodes }: WIPRowProps) {
  if (wipNodes.length === 0) return null;

  return (
    <div className={cn(
      "flex items-center gap-3 px-3 py-2 border-b border-border/20",
      "bg-amber-500/5"
    )}>
      <Spinner size={14} weight="bold" className="text-amber-400 animate-spin" />
      <span className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-amber-400">
        Running
      </span>
      <div className="flex gap-2">
        {wipNodes.map((wip) => (
          <span
            key={wip.laneId || "__project__"}
            className="font-mono text-[10px] text-muted-fg"
          >
            {wip.laneName}
            <span className="text-amber-400/60 ml-1">
              ({wip.operations.length})
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

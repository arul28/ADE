import React, { useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { cn } from "../ui/cn";
import { LaneTerminalsPanel } from "./LaneTerminalsPanel";
import { PackViewer } from "../packs/PackViewer";

const tabTrigger =
  "px-2.5 py-1.5 text-xs font-semibold rounded-lg text-muted-fg transition-colors data-[state=active]:text-fg data-[state=active]:bg-accent/10";

export function LaneWorkPane({
  laneId
}: {
  laneId: string | null;
}) {
  const [tab, setTab] = useState<"terminals" | "packs">("terminals");

  return (
    <Tabs.Root
      value={tab}
      onValueChange={(v) => setTab(v as "terminals" | "packs")}
      className="flex h-full flex-col"
    >
      <Tabs.List className="flex gap-1 border-b border-border/10 px-2 shrink-0">
        <Tabs.Trigger className={cn(tabTrigger)} value="terminals">
          Terminals
        </Tabs.Trigger>
        <Tabs.Trigger className={cn(tabTrigger)} value="packs">
          Packs
        </Tabs.Trigger>
      </Tabs.List>
      <div className="relative flex-1 min-h-0 p-2">
        <div className={cn("absolute inset-0 p-2", tab !== "terminals" && "invisible pointer-events-none")}>
          <LaneTerminalsPanel overrideLaneId={laneId} />
        </div>
        <div className={cn("absolute inset-0 p-2 overflow-auto", tab !== "packs" && "hidden")}>
          <PackViewer laneId={laneId} />
        </div>
      </div>
    </Tabs.Root>
  );
}

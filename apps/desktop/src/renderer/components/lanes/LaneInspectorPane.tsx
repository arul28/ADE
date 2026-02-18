import React, { useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { cn } from "../ui/cn";
import { PackViewer } from "../packs/PackViewer";
import { LanePrPanel } from "../prs/LanePrPanel";
import { LaneConflictsPanel } from "./LaneConflictsPanel";

const tabTrigger =
  "px-3 py-1.5 text-xs font-semibold rounded-md cursor-pointer select-none text-muted-fg border border-transparent transition-all hover:text-fg hover:bg-white/5 data-[state=active]:text-fg data-[state=active]:bg-accent/15 data-[state=active]:border-border/30 data-[state=active]:shadow-sm";

export function LaneInspectorPane({
  laneId,
  defaultTab
}: {
  laneId: string | null;
  defaultTab?: "context" | "pr" | "conflicts";
}) {
  const [tab, setTab] = useState<"context" | "pr" | "conflicts">(defaultTab ?? "context");

  return (
    <Tabs.Root
      value={tab}
      onValueChange={(v) => setTab(v as "context" | "pr" | "conflicts")}
      className="flex h-full flex-col"
    >
      <Tabs.List className="flex gap-1 border-b border-border/10 px-2 shrink-0">
        <Tabs.Trigger className={cn(tabTrigger)} value="context">
          Context
        </Tabs.Trigger>
        <Tabs.Trigger className={cn(tabTrigger)} value="pr">
          PR
        </Tabs.Trigger>
        <Tabs.Trigger className={cn(tabTrigger)} value="conflicts">
          Conflicts
        </Tabs.Trigger>
      </Tabs.List>
      <div className="flex-1 min-h-0 p-2">
        <Tabs.Content value="context" className="h-full overflow-auto">
          <PackViewer laneId={laneId} />
        </Tabs.Content>
        <Tabs.Content value="pr" className="h-full overflow-auto">
          <LanePrPanel laneId={laneId} />
        </Tabs.Content>
        <Tabs.Content value="conflicts" className="h-full">
          <LaneConflictsPanel laneId={laneId} />
        </Tabs.Content>
      </div>
    </Tabs.Root>
  );
}

import React, { useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { cn } from "../ui/cn";
import { LanePrPanel } from "../prs/LanePrPanel";
import { LaneConflictsPanel } from "./LaneConflictsPanel";

const tabTrigger =
  "px-2.5 py-1.5 text-xs font-semibold rounded-lg text-muted-fg transition-colors data-[state=active]:text-fg data-[state=active]:bg-accent/10";

export function LaneMergePane({
  laneId,
  defaultTab
}: {
  laneId: string | null;
  defaultTab?: "pr" | "conflicts";
}) {
  const [tab, setTab] = useState<"pr" | "conflicts">(defaultTab ?? "pr");

  return (
    <Tabs.Root
      value={tab}
      onValueChange={(v) => setTab(v as "pr" | "conflicts")}
      className="flex h-full flex-col"
    >
      <Tabs.List className="flex gap-1 border-b border-border/10 px-2 shrink-0">
        <Tabs.Trigger className={cn(tabTrigger)} value="pr">
          PR
        </Tabs.Trigger>
        <Tabs.Trigger className={cn(tabTrigger)} value="conflicts">
          Conflicts
        </Tabs.Trigger>
      </Tabs.List>
      <div className="flex-1 min-h-0 p-2">
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

import React from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import { PaneHeader } from "../ui/PaneHeader";
import { LaneTerminalsPanel } from "./LaneTerminalsPanel";
import { PackViewer } from "../packs/PackViewer";
import { useAppStore } from "../../state/appStore";

const tabTrigger =
  "px-2.5 py-2 text-xs font-semibold text-muted-fg data-[state=active]:text-fg data-[state=active]:border-b-2 data-[state=active]:border-accent";

export function LaneInspector({
  overrideLaneId,
  hideHeader
}: {
  overrideLaneId?: string | null;
  hideHeader?: boolean;
} = {}) {
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const laneId = overrideLaneId ?? selectedLaneId;

  return (
    <div className="flex h-full flex-col">
      {!hideHeader ? <PaneHeader title="Inspector" meta="lane-scoped" /> : null}
      <Tabs.Root defaultValue="terminals" className="flex h-full flex-col">
        <Tabs.List className="flex gap-2 border-b border-border px-2">
          <Tabs.Trigger className={cn(tabTrigger)} value="terminals">
            Terminals
          </Tabs.Trigger>
          <Tabs.Trigger className={cn(tabTrigger)} value="packs">
            Packs
          </Tabs.Trigger>
          <Tabs.Trigger className={cn(tabTrigger)} value="conflicts">
            Conflicts
          </Tabs.Trigger>
          <Tabs.Trigger className={cn(tabTrigger)} value="pr">
            PR
          </Tabs.Trigger>
        </Tabs.List>
        <div className="flex-1 overflow-auto p-3">
          <Tabs.Content value="terminals">
            <LaneTerminalsPanel overrideLaneId={laneId} />
          </Tabs.Content>
          <Tabs.Content value="packs">
            <PackViewer laneId={laneId} />
          </Tabs.Content>
          <Tabs.Content value="conflicts">
            <EmptyState title="Conflicts (stub)" description="Phase 4 adds conflict radar and guided resolution." />
          </Tabs.Content>
          <Tabs.Content value="pr">
            <EmptyState title="PR (stub)" description="Phase 1+ adds PR linkage and checks." />
          </Tabs.Content>
        </div>
      </Tabs.Root>
    </div>
  );
}

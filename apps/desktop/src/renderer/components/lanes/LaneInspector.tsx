import React, { useMemo, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import { PaneHeader } from "../ui/PaneHeader";
import { LaneTerminalsPanel } from "./LaneTerminalsPanel";
import { PackViewer } from "../packs/PackViewer";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { Layers3 } from "lucide-react";

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
  const lanes = useAppStore((s) => s.lanes);
  const selectLane = useAppStore((s) => s.selectLane);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const laneId = overrideLaneId ?? selectedLaneId;
  const lane = useMemo(() => lanes.find((entry) => entry.id === laneId) ?? null, [lanes, laneId]);
  const parentLane = useMemo(
    () => (lane?.parentLaneId ? lanes.find((entry) => entry.id === lane.parentLaneId) ?? null : null),
    [lane, lanes]
  );
  const childLanes = useMemo(
    () => lanes.filter((entry) => (lane ? entry.parentLaneId === lane.id : false)),
    [lanes, lane]
  );
  const [restackBusy, setRestackBusy] = useState(false);
  const [restackError, setRestackError] = useState<string | null>(null);
  const [reparentBusy, setReparentBusy] = useState(false);
  const [reparentError, setReparentError] = useState<string | null>(null);
  const [reparentTargetId, setReparentTargetId] = useState("");

  const descendantIds = useMemo(() => {
    if (!lane) return new Set<string>();
    const out = new Set<string>();
    const queue = [lane.id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const child of lanes.filter((entry) => entry.parentLaneId === current)) {
        if (out.has(child.id)) continue;
        out.add(child.id);
        queue.push(child.id);
      }
    }
    return out;
  }, [lane, lanes]);

  const reparentOptions = useMemo(() => {
    if (!lane) return [];
    return lanes.filter((entry) => entry.id !== lane.id && !descendantIds.has(entry.id));
  }, [descendantIds, lane, lanes]);

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
          <Tabs.Trigger className={cn(tabTrigger)} value="stack">
            Stack
          </Tabs.Trigger>
          <Tabs.Trigger className={cn(tabTrigger)} value="conflicts">
            Conflicts
          </Tabs.Trigger>
          <Tabs.Trigger className={cn(tabTrigger)} value="pr">
            PR
          </Tabs.Trigger>
        </Tabs.List>
        <div className="flex-1 min-h-0 p-3">
          <Tabs.Content value="terminals" forceMount className="h-full data-[state=inactive]:hidden">
            <LaneTerminalsPanel overrideLaneId={laneId} />
          </Tabs.Content>
          <Tabs.Content value="packs" className="h-full overflow-auto">
            <PackViewer laneId={laneId} />
          </Tabs.Content>
          <Tabs.Content value="stack" className="h-full overflow-auto">
            {!lane ? (
              <EmptyState title="No lane selected" />
            ) : (
              <div className="space-y-3 text-xs">
                <div className="rounded border border-border bg-card/50 p-2">
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-fg">Depth</div>
                  <div className="font-semibold text-fg">{lane.stackDepth}</div>
                </div>
                <div className="rounded border border-border bg-card/50 p-2">
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-fg">Parent</div>
                  {parentLane ? (
                    <button
                      type="button"
                      className="rounded border border-border bg-bg px-2 py-1 text-fg hover:border-accent"
                      onClick={() => selectLane(parentLane.id)}
                    >
                      {parentLane.name}
                    </button>
                  ) : (
                    <div className="text-muted-fg">None (root lane)</div>
                  )}
                </div>
                <div className="rounded border border-border bg-card/50 p-2">
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-fg">Children</div>
                  {childLanes.length === 0 ? (
                    <div className="text-muted-fg">No child lanes</div>
                  ) : (
                    <div className="space-y-1">
                      {childLanes.map((child) => (
                        <button
                          key={child.id}
                          type="button"
                          className="block w-full rounded border border-border bg-bg px-2 py-1 text-left text-fg hover:border-accent"
                          onClick={() => selectLane(child.id)}
                        >
                          {child.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {lane.parentLaneId ? (
                  <div className="rounded border border-border bg-card/50 p-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={restackBusy || !laneId}
                      onClick={() => {
                        if (!laneId) return;
                        setRestackBusy(true);
                        setRestackError(null);
                        window.ade.lanes
                          .restack({ laneId, recursive: true })
                          .then(async (result) => {
                            if (result.error) {
                              throw new Error(result.failedLaneId ? `${result.error} (failed: ${result.failedLaneId})` : result.error);
                            }
                            await refreshLanes();
                          })
                          .catch((error) => {
                            setRestackError(error instanceof Error ? error.message : String(error));
                          })
                          .finally(() => {
                            setRestackBusy(false);
                          });
                      }}
                    >
                      <Layers3 className="mr-1 h-3.5 w-3.5" />
                      {restackBusy ? "Rebasing..." : "Rebase"}
                    </Button>
                    {restackError ? <div className="mt-2 text-[11px] text-red-400">{restackError}</div> : null}
                  </div>
                ) : null}
                <div className="rounded border border-border bg-card/50 p-2">
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-fg">Reparent</div>
                  <div className="flex items-center gap-2">
                    <select
                      value={reparentTargetId}
                      onChange={(event) => setReparentTargetId(event.target.value)}
                      className="h-8 flex-1 rounded border border-border bg-bg px-2 text-xs"
                    >
                      <option value="">Select new parent…</option>
                      {reparentOptions.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.name}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!reparentTargetId || reparentBusy}
                      onClick={() => {
                        if (!lane || !reparentTargetId) return;
                        setReparentBusy(true);
                        setReparentError(null);
                        window.ade.lanes
                          .reparent({ laneId: lane.id, newParentLaneId: reparentTargetId })
                          .then(async () => {
                            setReparentTargetId("");
                            await refreshLanes();
                          })
                          .catch((error) => {
                            setReparentError(error instanceof Error ? error.message : String(error));
                          })
                          .finally(() => {
                            setReparentBusy(false);
                          });
                      }}
                    >
                      {reparentBusy ? "Working..." : "Reparent"}
                    </Button>
                  </div>
                  {reparentError ? <div className="mt-2 text-[11px] text-red-400">{reparentError}</div> : null}
                </div>
              </div>
            )}
          </Tabs.Content>
          <Tabs.Content value="conflicts" className="h-full">
            <div className="flex h-full items-center justify-center p-3">
              <EmptyState title="Conflicts (stub)" description="Phase 4 adds conflict radar and guided resolution." />
            </div>
          </Tabs.Content>
          <Tabs.Content value="pr" className="h-full">
            <div className="flex h-full items-center justify-center p-3">
              <EmptyState title="PR (stub)" description="Phase 1+ adds PR linkage and checks." />
            </div>
          </Tabs.Content>
        </div>
      </Tabs.Root>
    </div>
  );
}

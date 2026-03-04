import React from "react";
import { ArrowsClockwise } from "@phosphor-icons/react";
import { useAppStore } from "../../../state/appStore";
import { useConflictsState, useConflictsDispatch } from "../state/ConflictsContext";
import { fetchPrsWithConflicts } from "../state/conflictsActions";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";
import type { ConflictStatus } from "../../../../shared/types";
import type { LaneStatusFilter } from "../state/types";

function statusRank(value: ConflictStatus["status"]): number {
  if (value === "conflict-active") return 5;
  if (value === "conflict-predicted") return 4;
  if (value === "behind-base") return 3;
  if (value === "unknown") return 2;
  return 1;
}

function statusDotClass(status: ConflictStatus["status"] | null): string {
  if (status === "conflict-active") return "bg-red-600";
  if (status === "conflict-predicted") return "bg-orange-500";
  if (status === "behind-base") return "bg-amber-500";
  if (status === "merge-ready") return "bg-emerald-500";
  return "bg-muted-fg";
}

function statusBorderClass(status: ConflictStatus["status"] | null): string {
  if (status === "conflict-active") return "border-l-red-500";
  if (status === "conflict-predicted") return "border-l-orange-500";
  if (status === "behind-base") return "border-l-amber-500";
  if (status === "merge-ready") return "border-l-emerald-500";
  return "border-l-muted-fg/40";
}

function classifyStatus(status: ConflictStatus["status"] | undefined): Exclude<LaneStatusFilter, null> {
  if (status === "conflict-active" || status === "conflict-predicted") return "conflict";
  if (status === "behind-base") return "at-risk";
  if (status === "merge-ready") return "clean";
  return "unknown";
}

export function LaneListPane() {
  const lanes = useAppStore((s) => s.lanes);
  const dispatch = useConflictsDispatch();
  const { batch, selectedLaneId, statusFilter, laneListView, rebaseSuggestions, prsWithConflicts, prsLoading } =
    useConflictsState();

  const statusByLane = React.useMemo(() => {
    const map = new Map<string, ConflictStatus>();
    for (const status of batch?.lanes ?? []) map.set(status.laneId, status);
    return map;
  }, [batch]);

  const rebaseByLaneId = React.useMemo(() => {
    const map = new Map<string, (typeof rebaseSuggestions)[0]>();
    for (const s of rebaseSuggestions) map.set(s.laneId, s);
    return map;
  }, [rebaseSuggestions]);

  const sortedLanes = React.useMemo(() => {
    return [...lanes].sort((a, b) => {
      const statusA = statusByLane.get(a.id)?.status ?? "unknown";
      const statusB = statusByLane.get(b.id)?.status ?? "unknown";
      const rankDelta = statusRank(statusB) - statusRank(statusA);
      if (rankDelta !== 0) return rankDelta;
      return a.name.localeCompare(b.name);
    });
  }, [lanes, statusByLane]);

  const counts = React.useMemo(() => {
    const c: Record<Exclude<LaneStatusFilter, null>, number> = { conflict: 0, "at-risk": 0, clean: 0, unknown: 0 };
    for (const lane of sortedLanes) c[classifyStatus(statusByLane.get(lane.id)?.status)] += 1;
    return c;
  }, [sortedLanes, statusByLane]);

  const filteredLanes = React.useMemo(
    () => sortedLanes.filter((lane) => !statusFilter || classifyStatus(statusByLane.get(lane.id)?.status) === statusFilter),
    [sortedLanes, statusByLane, statusFilter]
  );

  const toggleFilter = (f: Exclude<LaneStatusFilter, null>) => {
    dispatch({ type: "SET_STATUS_FILTER", filter: statusFilter === f ? null : f });
  };

  // Fetch PRs when switching to "By PR" view
  React.useEffect(() => {
    if (laneListView === "by-pr") fetchPrsWithConflicts(dispatch);
  }, [laneListView, dispatch]);

  return (
    <div className="h-full overflow-auto p-2">
      {/* By Lane / By PR toggle */}
      <div className="mb-2 flex rounded-lg border border-border/50 text-[11px] font-medium">
        {(["by-lane", "by-pr"] as const).map((v) => (
          <button
            key={v}
            onClick={() => dispatch({ type: "SET_LANE_LIST_VIEW", view: v })}
            className={cn(
              "flex-1 px-2 py-1 transition-colors first:rounded-l-lg last:rounded-r-lg",
              laneListView === v ? "bg-accent/15 text-accent" : "text-muted-fg hover:text-fg"
            )}
          >
            {v === "by-lane" ? "By Lane" : "By PR"}
          </button>
        ))}
      </div>

      {laneListView === "by-lane" ? (
        <>
          {/* Filter chips */}
          <div className="mb-3 flex flex-wrap gap-1.5">
            {(() => {
              const colorClasses: Record<string, { active: string; inactive: string }> = {
                red: { active: "bg-red-500/25 text-red-200 ring-1 ring-inset ring-red-500/50 shadow-sm", inactive: "text-red-300/80 hover:bg-red-500/10 hover:text-red-200" },
                amber: { active: "bg-amber-500/25 text-amber-200 ring-1 ring-inset ring-amber-500/50 shadow-sm", inactive: "text-amber-300/80 hover:bg-amber-500/10 hover:text-amber-200" },
                emerald: { active: "bg-emerald-500/25 text-emerald-200 ring-1 ring-inset ring-emerald-500/50 shadow-sm", inactive: "text-emerald-300/80 hover:bg-emerald-500/10 hover:text-emerald-200" },
                muted: { active: "bg-muted/40 text-fg ring-1 ring-inset ring-muted/50 shadow-sm", inactive: "text-muted-fg hover:bg-muted/40 hover:text-fg/80" },
              };
              return ([
                { key: "conflict" as const, color: "red", label: `${counts.conflict} conflict` },
                { key: "at-risk" as const, color: "amber", label: `${counts["at-risk"]} at-risk` },
                { key: "clean" as const, color: "emerald", label: `${counts.clean} clean` },
                { key: "unknown" as const, color: "muted", label: `${counts.unknown} unknown` },
              ] as const).map(({ key, color, label }) => (
                <Chip
                  key={key}
                  role="button"
                  onClick={() => toggleFilter(key)}
                  className={cn(
                    "cursor-pointer px-3 py-1 transition-all",
                    statusFilter === key
                      ? colorClasses[color].active
                      : colorClasses[color].inactive
                  )}
                >
                  {label}
                </Chip>
              ));
            })()}
          </div>

          {/* Lane list */}
          {filteredLanes.map((lane) => {
            const status = statusByLane.get(lane.id) ?? null;
            const selected = lane.id === selectedLaneId;
            const rebase = rebaseByLaneId.get(lane.id) ?? null;
            return (
              <button
                key={lane.id}
                type="button"
                onClick={() => {
                  dispatch({ type: "SET_SELECTED_LANE", laneId: lane.id });
                  dispatch({ type: "SET_VIEW_MODE", mode: "summary" });
                }}
                className={cn(
                  "mb-2 block w-full rounded border-l-[3px] px-2.5 py-2.5 text-left transition-all",
                  statusBorderClass(status?.status ?? null),
                  selected
                    ? "shadow-card-hover bg-accent/10 ring-1 ring-accent/20"
                    : "shadow-card bg-card/50 hover:shadow-card-hover hover:bg-card/70"
                )}
              >
                <div className="flex items-center gap-2">
                  <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full ring-2 ring-black/20", statusDotClass(status?.status ?? null))} />
                  <span className="truncate text-xs font-semibold text-fg">{lane.name}</span>
                  {rebase && (
                    <span
                      className="ml-auto inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-amber-200 ring-1 ring-inset ring-amber-500/30"
                      title={`Parent advanced; behind ${rebase.behindCount} commit(s).`}
                    >
                      <ArrowsClockwise size={10} />
                      rebase
                    </span>
                  )}
                </div>
                <div className="mt-1.5 pl-4 text-xs text-muted-fg">
                  {status?.status ?? "unknown"} · overlaps {status?.overlappingFileCount ?? 0}
                </div>
              </button>
            );
          })}
        </>
      ) : (
        /* By PR view */
        <div>
          {prsLoading && <div className="py-4 text-center text-xs text-muted-fg">Loading PRs...</div>}
          {!prsLoading && prsWithConflicts.length === 0 && (
            <div className="py-4 text-center text-xs text-muted-fg">No PRs with conflict data.</div>
          )}
          {prsWithConflicts.map((pr) => {
            const selected = pr.laneId === selectedLaneId;
            const risk = pr.conflictAnalysis?.riskLevel ?? "none";
            return (
              <button
                key={pr.id}
                type="button"
                onClick={() => dispatch({ type: "SET_SELECTED_LANE", laneId: pr.laneId })}
                className={cn(
                  "mb-2 block w-full rounded border-l-[3px] px-2.5 py-2.5 text-left transition-all",
                  risk === "high" ? "border-l-red-500" : risk === "medium" ? "border-l-amber-500" : "border-l-emerald-500",
                  selected
                    ? "shadow-card-hover bg-accent/10 ring-1 ring-accent/20"
                    : "shadow-card bg-card/50 hover:shadow-card-hover hover:bg-card/70"
                )}
              >
                <div className="truncate text-xs font-semibold text-fg">
                  #{pr.githubPrNumber} {pr.title}
                </div>
                <div className="mt-1 text-xs text-muted-fg">
                  {risk} risk · {pr.conflictAnalysis?.overlapCount ?? 0} overlapping files
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

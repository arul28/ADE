import React from "react";
import { useNavigate } from "react-router-dom";
import type { LandResult, MergeMethod, PrSummary } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";

type ViewMode = "chains" | "all";

function sortByCreatedAtAsc<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aTs = Date.parse(a.createdAt);
    const bTs = Date.parse(b.createdAt);
    if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && aTs !== bTs) return aTs - bTs;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

function stateChip(state: PrSummary["state"]): { label: string; className: string } {
  if (state === "draft") return { label: "draft", className: "text-purple-200 border-purple-700/60 bg-purple-900/20" };
  if (state === "open") return { label: "open", className: "text-sky-200 border-sky-700/60 bg-sky-900/20" };
  if (state === "merged") return { label: "merged", className: "text-emerald-200 border-emerald-700/60 bg-emerald-900/20" };
  return { label: "closed", className: "text-muted-fg border-border bg-card/30" };
}

function checksChip(status: PrSummary["checksStatus"]): { label: string; className: string } {
  if (status === "passing") return { label: "checks: passing", className: "text-emerald-200 border-emerald-700/60 bg-emerald-900/20" };
  if (status === "failing") return { label: "checks: failing", className: "text-red-200 border-red-700/60 bg-red-900/20" };
  if (status === "pending") return { label: "checks: pending", className: "text-amber-200 border-amber-700/60 bg-amber-900/20" };
  return { label: "checks: none", className: "text-muted-fg border-border bg-card/30" };
}

function reviewsChip(status: PrSummary["reviewStatus"]): { label: string; className: string } {
  if (status === "approved") return { label: "reviews: approved", className: "text-emerald-200 border-emerald-700/60 bg-emerald-900/20" };
  if (status === "changes_requested") return { label: "reviews: changes requested", className: "text-amber-200 border-amber-700/60 bg-amber-900/20" };
  if (status === "requested") return { label: "reviews: requested", className: "text-sky-200 border-sky-700/60 bg-sky-900/20" };
  return { label: "reviews: none", className: "text-muted-fg border-border bg-card/30" };
}

export function PRsPage() {
  const navigate = useNavigate();
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);

  const [prs, setPrs] = React.useState<PrSummary[]>([]);
  const [viewMode, setViewMode] = React.useState<ViewMode>("chains");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [mergeMethod, setMergeMethod] = React.useState<MergeMethod>("squash");
  const [landStackDialog, setLandStackDialog] = React.useState<{
    rootLaneId: string;
    rootLaneName: string;
    running: boolean;
    results: LandResult[] | null;
    error: string | null;
  } | null>(null);

  const laneById = React.useMemo(() => new Map(lanes.map((lane) => [lane.id, lane] as const)), [lanes]);
  const prByLaneId = React.useMemo(() => new Map(prs.map((pr) => [pr.laneId, pr] as const)), [prs]);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!lanes.length) await refreshLanes();
      const next = await window.ade.prs.refresh();
      setPrs(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPrs([]);
    } finally {
      setLoading(false);
    }
  }, [lanes.length, refreshLanes]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    const unsub = window.ade.prs.onEvent((event) => {
      if (event.type !== "prs-updated") return;
      setPrs(event.prs);
    });
    return () => {
      unsub();
    };
  }, []);

  const chainRoots = React.useMemo(() => lanes.filter((lane) => !lane.parentLaneId), [lanes]);
  const childrenByParent = React.useMemo(() => {
    const map = new Map<string, typeof lanes>();
    for (const lane of lanes) {
      if (!lane.parentLaneId) continue;
      const list = map.get(lane.parentLaneId) ?? [];
      list.push(lane);
      map.set(lane.parentLaneId, list);
    }
    for (const [k, v] of map.entries()) {
      map.set(k, sortByCreatedAtAsc(v));
    }
    return map;
  }, [lanes]);

  const stackedChains = React.useMemo(() => {
    const out: Array<{
      rootLaneId: string;
      rootLaneName: string;
      items: Array<{ laneId: string; laneName: string; depth: number; pr: PrSummary | null }>;
      hasAnyPr: boolean;
    }> = [];

    const visit = (laneId: string, depth: number, acc: Array<{ laneId: string; laneName: string; depth: number; pr: PrSummary | null }>) => {
      const lane = laneById.get(laneId);
      if (!lane) return;
      const pr = prByLaneId.get(laneId) ?? null;
      acc.push({ laneId, laneName: lane.name, depth, pr });
      for (const child of childrenByParent.get(laneId) ?? []) {
        visit(child.id, depth + 1, acc);
      }
    };

    for (const root of sortByCreatedAtAsc(chainRoots)) {
      const items: Array<{ laneId: string; laneName: string; depth: number; pr: PrSummary | null }> = [];
      visit(root.id, 0, items);
      const hasAnyPr = items.some((i) => i.pr != null);
      if (!hasAnyPr) continue;
      out.push({ rootLaneId: root.id, rootLaneName: root.name, items, hasAnyPr });
    }
    return out;
  }, [chainRoots, childrenByParent, laneById, prByLaneId]);

  const allPrsSorted = React.useMemo(() => {
    const laneName = (laneId: string) => laneById.get(laneId)?.name ?? laneId;
    return [...prs].sort((a, b) => {
      const aTs = Date.parse(a.updatedAt);
      const bTs = Date.parse(b.updatedAt);
      if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && aTs !== bTs) return bTs - aTs;
      return laneName(a.laneId).localeCompare(laneName(b.laneId));
    });
  }, [laneById, prs]);

  const runLandStack = async () => {
    if (!landStackDialog) return;
    setLandStackDialog((prev) => (prev ? { ...prev, running: true, results: null, error: null } : prev));
    try {
      const results = await window.ade.prs.landStack({ rootLaneId: landStackDialog.rootLaneId, method: mergeMethod });
      setLandStackDialog((prev) => (prev ? { ...prev, running: false, results } : prev));
      await Promise.all([refreshLanes().catch(() => {}), refresh().catch(() => {})]);
    } catch (err) {
      setLandStackDialog((prev) => (prev ? { ...prev, running: false, error: err instanceof Error ? err.message : String(err) } : prev));
    }
  };

  if (error) {
    return <EmptyState title="PRs" description={`Failed to load PRs: ${error}`} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border/15 px-3 py-2">
        <div className="text-sm font-semibold text-fg">PRs</div>
        <div className="text-xs text-muted-fg">{prs.length} linked</div>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant={viewMode === "chains" ? "primary" : "outline"} onClick={() => setViewMode("chains")}>
            Stacked Chains
          </Button>
          <Button size="sm" variant={viewMode === "all" ? "primary" : "outline"} onClick={() => setViewMode("all")}>
            All PRs
          </Button>
          <select
            value={mergeMethod}
            onChange={(e) => setMergeMethod(e.target.value as MergeMethod)}
            className="h-8 rounded-lg bg-muted/30 px-2 text-xs"
            title="Default merge method"
          >
            <option value="squash">squash</option>
            <option value="merge">merge</option>
            <option value="rebase">rebase</option>
          </select>
          <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => navigate("/settings")}>
            GitHub Settings
          </Button>
        </div>
      </div>

      {landStackDialog ? (
        <div className="fixed inset-0 z-[96] flex items-center justify-center bg-black/45 p-4">
          <div className="w-[min(720px,100%)] rounded-2xl bg-card/95 p-4 shadow-float backdrop-blur-xl">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-fg">Land Stack</div>
              <Button size="sm" variant="ghost" onClick={() => setLandStackDialog(null)}>
                Close
              </Button>
            </div>
            <div className="mt-1 text-xs text-muted-fg">Root: {landStackDialog.rootLaneName}</div>
            <div className="mt-3 flex items-center justify-between gap-2">
              <div className="text-xs text-muted-fg">Merge method: {mergeMethod}</div>
              <Button size="sm" variant="primary" disabled={landStackDialog.running} onClick={() => void runLandStack()}>
                {landStackDialog.running ? "Landing…" : "Land Stack"}
              </Button>
            </div>
            {landStackDialog.error ? (
              <div className="mt-3 rounded-lg bg-red-500/10 p-2 text-xs text-red-200">{landStackDialog.error}</div>
            ) : null}
            {landStackDialog.results ? (
              <div className="mt-3 max-h-[50vh] overflow-auto rounded-lg bg-muted/20">
                <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-fg">Results</div>
                <div className="divide-y divide-border/10">
                  {landStackDialog.results.map((r, idx) => (
                    <div key={`${r.prNumber}:${idx}`} className="px-2 py-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-semibold text-fg">#{r.prNumber}</div>
                        <div className={cn("text-[11px]", r.success ? "text-emerald-200" : "text-red-200")}>
                          {r.success ? "merged" : "failed"}
                        </div>
                      </div>
                      {r.error ? <div className="mt-1 text-[11px] text-red-200">{r.error}</div> : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="flex-1 min-h-0 overflow-auto p-3">
        {viewMode === "chains" ? (
          <div className="space-y-3">
            {stackedChains.map((chain) => {
              const rootPr = prByLaneId.get(chain.rootLaneId) ?? null;
              return (
                <div key={chain.rootLaneId} className="rounded-xl shadow-card bg-card/60">
                  <div className="flex items-center justify-between gap-2 px-3 py-2">
                    <div className="text-xs font-semibold text-fg">{chain.rootLaneName}</div>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={!rootPr}
                      onClick={() => {
                        if (!rootPr) return;
                        setLandStackDialog({
                          rootLaneId: chain.rootLaneId,
                          rootLaneName: chain.rootLaneName,
                          running: false,
                          results: null,
                          error: null
                        });
                      }}
                    >
                      Land stack
                    </Button>
                  </div>
                  <div className="divide-y divide-border/10">
                    {chain.items.map((item) => {
                      const pr = item.pr;
                      return (
                        <button
                          key={item.laneId}
                          type="button"
                          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-muted/40"
                          onClick={() => {
                            // Navigate to lane inspector; Lanes page will show it selected.
                            navigate("/lanes");
                          }}
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-muted-fg" style={{ width: item.depth * 14 }} />
                              <span className="font-semibold text-fg truncate">{item.laneName}</span>
                              {pr ? <span className="text-[11px] text-muted-fg">#{pr.githubPrNumber}</span> : <span className="text-[11px] text-muted-fg">(no PR)</span>}
                            </div>
                          </div>
                          {pr ? (
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              <Chip className={cn("text-[10px] px-1.5", stateChip(pr.state).className)}>{stateChip(pr.state).label}</Chip>
                              <Chip className={cn("text-[10px] px-1.5", checksChip(pr.checksStatus).className)}>{checksChip(pr.checksStatus).label}</Chip>
                              <Chip className={cn("text-[10px] px-1.5", reviewsChip(pr.reviewStatus).className)}>{reviewsChip(pr.reviewStatus).label}</Chip>
                            </div>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            {!stackedChains.length ? (
              <EmptyState title="No stacked PR chains yet" description="Create PRs from lane inspectors to see chains here." />
            ) : null}
          </div>
        ) : (
          <div className="rounded-xl shadow-card bg-card/60">
            <div className="grid grid-cols-12 gap-2 border-b border-border/15 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-fg">
              <div className="col-span-2">PR</div>
              <div className="col-span-4">Title</div>
              <div className="col-span-2">Lane</div>
              <div className="col-span-4 text-right">Status</div>
            </div>
            <div className="divide-y divide-border/10">
              {allPrsSorted.map((pr) => {
                const laneName = laneById.get(pr.laneId)?.name ?? pr.laneId;
                return (
                  <div key={pr.id} className="grid grid-cols-12 items-center gap-2 px-3 py-2 text-xs hover:bg-muted/40">
                    <div className="col-span-2 font-mono text-[11px] text-muted-fg">#{pr.githubPrNumber}</div>
                    <div className="col-span-4 truncate text-fg">{pr.title}</div>
                    <div className="col-span-2 truncate text-muted-fg">{laneName}</div>
                    <div className="col-span-4 flex flex-wrap items-center justify-end gap-2">
                      <Chip className={cn("text-[10px] px-1.5", stateChip(pr.state).className)}>{stateChip(pr.state).label}</Chip>
                      <Chip className={cn("text-[10px] px-1.5", checksChip(pr.checksStatus).className)}>{checksChip(pr.checksStatus).label}</Chip>
                      <Chip className={cn("text-[10px] px-1.5", reviewsChip(pr.reviewStatus).className)}>{reviewsChip(pr.reviewStatus).label}</Chip>
                      <Button size="sm" variant="outline" className="h-7" onClick={() => void window.ade.prs.openInGitHub(pr.id)}>
                        Open
                      </Button>
                    </div>
                  </div>
                );
              })}
              {!allPrsSorted.length ? <div className="px-3 py-3 text-xs text-muted-fg">No linked PRs yet.</div> : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

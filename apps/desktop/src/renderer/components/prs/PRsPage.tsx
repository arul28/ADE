import React from "react";
import { useNavigate } from "react-router-dom";
import { Eye, GitPullRequest, Plus } from "lucide-react";
import type { LandResult, MergeMethod, PrSummary } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../ui/PaneTilingLayout";
import { CreatePrModal } from "./CreatePrModal";
import { PrConflictBadge } from "./PrConflictBadge";

type ViewMode = "chains" | "all";

/* ---- Default tiling layout ---- */

const PRS_TILING_TREE: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    { node: { type: "pane", id: "pr-list" }, defaultSize: 35, minSize: 20 },
    { node: { type: "pane", id: "pr-detail" }, defaultSize: 65, minSize: 30 }
  ]
};

/* ---- Utility functions ---- */

function sortByCreatedAtAsc<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aTs = Date.parse(a.createdAt);
    const bTs = Date.parse(b.createdAt);
    if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && aTs !== bTs) return aTs - bTs;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

function stateChip(state: PrSummary["state"]): { label: string; className: string } {
  if (state === "draft") return { label: "draft", className: "text-purple-200 border-l-2 border-l-purple-400 border-purple-700/60 bg-purple-900/20" };
  if (state === "open") return { label: "open", className: "text-sky-200 border-l-2 border-l-sky-400 border-sky-700/60 bg-sky-900/20" };
  if (state === "merged") return { label: "merged", className: "text-emerald-200 border-l-2 border-l-emerald-400 border-emerald-700/60 bg-emerald-900/20" };
  return { label: "closed", className: "text-muted-fg border-l-2 border-l-muted-fg/40 border-border bg-card/30" };
}

function checksChip(status: PrSummary["checksStatus"]): { label: string; className: string } {
  if (status === "passing") return { label: "checks: passing", className: "text-emerald-200 border-l-2 border-l-emerald-400 border-emerald-700/60 bg-emerald-900/20" };
  if (status === "failing") return { label: "checks: failing", className: "text-red-200 border-l-2 border-l-red-400 border-red-700/60 bg-red-900/20" };
  if (status === "pending") return { label: "checks: pending", className: "text-amber-200 border-l-2 border-l-amber-400 border-amber-700/60 bg-amber-900/20" };
  return { label: "checks: none", className: "text-muted-fg border-l-2 border-l-muted-fg/40 border-border bg-card/30" };
}

function reviewsChip(status: PrSummary["reviewStatus"]): { label: string; className: string } {
  if (status === "approved") return { label: "reviews: approved", className: "text-emerald-200 border-l-2 border-l-emerald-400 border-emerald-700/60 bg-emerald-900/20" };
  if (status === "changes_requested") return { label: "reviews: changes requested", className: "text-amber-200 border-l-2 border-l-amber-400 border-amber-700/60 bg-amber-900/20" };
  if (status === "requested") return { label: "reviews: requested", className: "text-sky-200 border-l-2 border-l-sky-400 border-sky-700/60 bg-sky-900/20" };
  return { label: "reviews: none", className: "text-muted-fg border-l-2 border-l-muted-fg/40 border-border bg-card/30" };
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
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
  const [selectedPrId, setSelectedPrId] = React.useState<string | null>(null);
  const [landStackDialog, setLandStackDialog] = React.useState<{
    rootLaneId: string;
    rootLaneName: string;
    running: boolean;
    results: LandResult[] | null;
    error: string | null;
  } | null>(null);

  const [createPrOpen, setCreatePrOpen] = React.useState(false);

  const laneById = React.useMemo(() => new Map(lanes.map((lane) => [lane.id, lane] as const)), [lanes]);
  const prByLaneId = React.useMemo(() => new Map(prs.map((pr) => [pr.laneId, pr] as const)), [prs]);
  const prById = React.useMemo(() => new Map(prs.map((pr) => [pr.id, pr] as const)), [prs]);

  const selectedPr = selectedPrId ? prById.get(selectedPrId) ?? null : null;

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

  // Auto-select first PR when list changes and nothing is selected
  React.useEffect(() => {
    if (selectedPrId && prById.has(selectedPrId)) return;
    const first = prs[0] ?? null;
    setSelectedPrId(first?.id ?? null);
  }, [prs, selectedPrId, prById]);

  /* ---- Pane configs ---- */

  const paneConfigs: Record<string, PaneConfig> = React.useMemo(() => ({
    "pr-list": {
      title: "PR List",
      icon: GitPullRequest,
      meta: <span className="text-[11px] text-muted-fg">{prs.length} linked</span>,
      bodyClassName: "overflow-auto",
      children: (
        <div className="p-2">
          {viewMode === "chains" ? (
            <div className="space-y-3">
              {stackedChains.map((chain) => {
                const rootPr = prByLaneId.get(chain.rootLaneId) ?? null;
                return (
                  <div key={chain.rootLaneId} className="rounded shadow-card bg-card/60 ring-1 ring-border/10 overflow-hidden">
                    <div className="flex items-center justify-between gap-2 px-3 py-2.5 bg-gradient-to-r from-muted/40 via-muted/20 to-transparent border-b border-border/15">
                      <div className="text-xs font-bold text-fg tracking-tight">{chain.rootLaneName}</div>
                      <Button
                        size="sm"
                        variant="primary"
                        className="shadow-card text-[11px] font-semibold tracking-wide uppercase"
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
                    <div className="divide-y divide-border/15">
                      {chain.items.map((item) => {
                        const pr = item.pr;
                        const isSelected = pr && pr.id === selectedPrId;
                        return (
                          <button
                            key={item.laneId}
                            type="button"
                            className={cn(
                              "flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-xs transition-colors duration-100 hover:bg-muted/40",
                              isSelected && "bg-accent/10 border-l-2 border-l-accent"
                            )}
                            onClick={() => {
                              if (pr) setSelectedPrId(pr.id);
                            }}
                          >
                            <div className="min-w-0 flex items-center gap-0">
                              {item.depth > 0 && (
                                <span className="flex items-center shrink-0" style={{ width: item.depth * 16 }}>
                                  {Array.from({ length: item.depth }).map((_, i) => (
                                    <span key={i} className={cn(
                                      "inline-block w-4 text-center text-border/60",
                                      i === item.depth - 1 ? "text-muted-fg/50" : ""
                                    )}>
                                      {i === item.depth - 1 ? "\u2514" : "\u2502"}
                                    </span>
                                  ))}
                                </span>
                              )}
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="font-semibold text-fg truncate">{item.laneName}</span>
                                  {pr ? <span className="font-mono text-[11px] text-muted-fg/70">#{pr.githubPrNumber}</span> : <span className="text-[11px] italic text-muted-fg/50">(no PR)</span>}
                                </div>
                              </div>
                            </div>
                            {pr ? (
                              <div className="flex flex-wrap items-center justify-end gap-1 shrink-0">
                                <Chip className={cn("text-[10px] px-1.5 rounded-md", stateChip(pr.state).className)}>{stateChip(pr.state).label}</Chip>
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
            <div className="rounded shadow-card bg-card/60 ring-1 ring-border/10 overflow-hidden">
              <div className="divide-y divide-border/15">
                {allPrsSorted.map((pr) => {
                  const laneName = laneById.get(pr.laneId)?.name ?? pr.laneId;
                  const isSelected = pr.id === selectedPrId;
                  return (
                    <button
                      key={pr.id}
                      type="button"
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-xs transition-colors duration-100 hover:bg-muted/40",
                        isSelected && "bg-accent/10 border-l-2 border-l-accent"
                      )}
                      onClick={() => setSelectedPrId(pr.id)}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[11px] text-muted-fg/70">#{pr.githubPrNumber}</span>
                          <span className="truncate font-medium text-fg">{pr.title}</span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted-fg/60 truncate">{laneName}</div>
                      </div>
                      <Chip className={cn("text-[10px] px-1.5 shrink-0 rounded-md", stateChip(pr.state).className)}>{stateChip(pr.state).label}</Chip>
                    </button>
                  );
                })}
                {!allPrsSorted.length ? <div className="px-3 py-4 text-xs text-muted-fg text-center">No linked PRs yet.</div> : null}
              </div>
            </div>
          )}
        </div>
      )
    },
    "pr-detail": {
      title: selectedPr ? `#${selectedPr.githubPrNumber} ${selectedPr.title}` : "PR Detail",
      icon: Eye,
      bodyClassName: "overflow-auto",
      children: selectedPr ? (
        <div className="p-4 space-y-5">
          {/* Header */}
          <div>
            <div className="flex items-baseline gap-2.5">
              <span className="font-mono text-lg text-muted-fg/70">#{selectedPr.githubPrNumber}</span>
              <span className="text-lg font-bold text-fg tracking-tight">{selectedPr.title}</span>
            </div>
            <div className="mt-1.5 text-xs text-muted-fg/60 font-mono">
              {selectedPr.repoOwner}/{selectedPr.repoName}
            </div>
          </div>

          {/* Status badges */}
          <div className="flex flex-wrap items-center gap-2.5 py-1">
            <Chip className={cn("text-[11px] px-2.5 py-1 rounded-md font-medium", stateChip(selectedPr.state).className)}>{stateChip(selectedPr.state).label}</Chip>
            <Chip className={cn("text-[11px] px-2.5 py-1 rounded-md font-medium", checksChip(selectedPr.checksStatus).className)}>{checksChip(selectedPr.checksStatus).label}</Chip>
            <Chip className={cn("text-[11px] px-2.5 py-1 rounded-md font-medium", reviewsChip(selectedPr.reviewStatus).className)}>{reviewsChip(selectedPr.reviewStatus).label}</Chip>
          </div>

          {/* Branch info */}
          <div className="rounded shadow-card bg-card/60 ring-1 ring-border/10 p-3.5 space-y-2.5">
            <div className="text-xs font-semibold text-fg uppercase tracking-wider">Branches</div>
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
              <span className="text-muted-fg/70 font-medium">Base</span>
              <span className="font-mono text-fg bg-muted/30 rounded-md px-2 py-0.5 w-fit">{selectedPr.baseBranch}</span>
              <span className="text-muted-fg/70 font-medium">Head</span>
              <span className="font-mono text-fg bg-muted/30 rounded-md px-2 py-0.5 w-fit">{selectedPr.headBranch}</span>
            </div>
          </div>

          {/* Changes */}
          <div className="rounded shadow-card bg-card/60 ring-1 ring-border/10 p-3.5 space-y-2.5">
            <div className="text-xs font-semibold text-fg uppercase tracking-wider">Changes</div>
            <div className="flex items-center gap-5">
              <span className="text-sm font-bold font-mono text-emerald-400">+{selectedPr.additions}</span>
              <span className="text-sm font-bold font-mono text-red-400">-{selectedPr.deletions}</span>
            </div>
          </div>

          {/* Lane info */}
          <div className="rounded shadow-card bg-card/60 ring-1 ring-border/10 p-3.5 space-y-2.5">
            <div className="text-xs font-semibold text-fg uppercase tracking-wider">Lane</div>
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-fg font-medium">{laneById.get(selectedPr.laneId)?.name ?? selectedPr.laneId}</span>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                onClick={() => navigate(`/lanes?laneId=${encodeURIComponent(selectedPr.laneId)}`)}
              >
                Go to lane
              </Button>
            </div>
          </div>

          {/* Timestamps */}
          <div className="rounded shadow-card bg-card/60 ring-1 ring-border/10 p-3.5 space-y-2.5">
            <div className="text-xs font-semibold text-fg uppercase tracking-wider">Timestamps</div>
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
              <span className="text-muted-fg/60 font-medium">Created</span>
              <span className="text-fg tabular-nums">{formatTimestamp(selectedPr.createdAt)}</span>
              <span className="text-muted-fg/60 font-medium">Updated</span>
              <span className="text-fg tabular-nums">{formatTimestamp(selectedPr.updatedAt)}</span>
              {selectedPr.lastSyncedAt ? (
                <>
                  <span className="text-muted-fg/60 font-medium">Last synced</span>
                  <span className="text-fg tabular-nums">{formatTimestamp(selectedPr.lastSyncedAt)}</span>
                </>
              ) : null}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3 pt-1">
            <Button size="sm" variant="primary" className="shadow-card" onClick={() => void window.ade.prs.openInGitHub(selectedPr.id)}>
              Open on GitHub
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate(`/lanes?laneId=${encodeURIComponent(selectedPr.laneId)}`)}
            >
              View lane
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex h-full items-center justify-center">
          <EmptyState title="No PR selected" description="Select a pull request from the list to view its details." />
        </div>
      )
    }
  }), [prs.length, viewMode, stackedChains, allPrsSorted, selectedPrId, selectedPr, laneById, prByLaneId, navigate]);

  if (error) {
    return <EmptyState title="PRs" description={`Failed to load PRs: ${error}`} />;
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      {/* Header bar */}
      <div className="flex items-center gap-4 border-b border-border/15 px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <div className="text-sm font-bold text-fg tracking-tight">PRs</div>
          <span className="text-[11px] text-muted-fg/60 font-medium tabular-nums">{prs.length} linked</span>
        </div>

        {/* Segmented control */}
        <div className="flex items-center rounded-lg bg-muted/30 p-0.5 gap-0.5">
          <button
            type="button"
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150",
              viewMode === "chains"
                ? "bg-accent text-accent-fg shadow-sm"
                : "text-muted-fg hover:text-fg hover:bg-muted/40"
            )}
            onClick={() => setViewMode("chains")}
          >
            Stacked Chains
          </button>
          <button
            type="button"
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150",
              viewMode === "all"
                ? "bg-accent text-accent-fg shadow-sm"
                : "text-muted-fg hover:text-fg hover:bg-muted/40"
            )}
            onClick={() => setViewMode("all")}
          >
            All PRs
          </button>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <select
            value={mergeMethod}
            onChange={(e) => setMergeMethod(e.target.value as MergeMethod)}
            className="h-8 rounded-lg bg-muted/30 px-2 text-xs text-fg border border-border/15 focus:outline-none focus:ring-1 focus:ring-accent/30"
            title="Default merge method"
          >
            <option value="squash">squash</option>
            <option value="merge">merge</option>
            <option value="rebase">rebase</option>
          </select>
          <Button size="sm" variant="primary" onClick={() => setCreatePrOpen(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Create PR
          </Button>
          <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => navigate("/settings")}>
            GitHub Settings
          </Button>
        </div>
      </div>

      {/* Land Stack modal */}
      {landStackDialog ? (
        <div className="fixed inset-0 z-[96] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="w-[min(720px,100%)] rounded bg-card border border-border/40 p-4 shadow-float ring-1 ring-border/20">
            <div className="flex items-center justify-between gap-2">
              <div className="text-base font-bold text-fg tracking-tight">Land Stack</div>
              <Button size="sm" variant="ghost" onClick={() => setLandStackDialog(null)}>
                Close
              </Button>
            </div>
            <div className="mt-1.5 text-xs text-muted-fg/70">Root: <span className="font-semibold text-fg">{landStackDialog.rootLaneName}</span></div>
            <div className="mt-4 flex items-center justify-between gap-2 rounded bg-muted/20 px-3 py-2.5">
              <div className="text-xs text-muted-fg">Merge method: <span className="font-mono font-medium text-fg">{mergeMethod}</span></div>
              <Button size="sm" variant="primary" className="shadow-card font-semibold" disabled={landStackDialog.running} onClick={() => void runLandStack()}>
                {landStackDialog.running ? "Landing..." : "Land Stack"}
              </Button>
            </div>
            {landStackDialog.error ? (
              <div className="mt-4 rounded bg-red-500/10 border border-red-500/20 p-3 text-xs text-red-200">{landStackDialog.error}</div>
            ) : null}
            {landStackDialog.results ? (
              <div className="mt-4 max-h-[50vh] overflow-auto rounded bg-muted/15 ring-1 ring-border/10">
                <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-fg/60 font-semibold border-b border-border/10">Results</div>
                <div className="divide-y divide-border/10">
                  {landStackDialog.results.map((r, idx) => (
                    <div key={`${r.prNumber}:${idx}`} className="px-3 py-2.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className={cn("text-sm", r.success ? "text-emerald-400" : "text-red-400")}>
                            {r.success ? "\u2713" : "\u2717"}
                          </span>
                          <span className="font-mono font-semibold text-fg">#{r.prNumber}</span>
                        </div>
                        <Chip className={cn(
                          "text-[10px] px-2 rounded-md font-medium",
                          r.success
                            ? "text-emerald-200 border-l-2 border-l-emerald-400 bg-emerald-900/20"
                            : "text-red-200 border-l-2 border-l-red-400 bg-red-900/20"
                        )}>
                          {r.success ? "merged" : "failed"}
                        </Chip>
                      </div>
                      {r.error ? <div className="mt-1.5 text-[11px] text-red-300/80 pl-6">{r.error}</div> : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Create PR modal */}
      <CreatePrModal
        open={createPrOpen}
        onOpenChange={setCreatePrOpen}
        onCreated={() => void refresh()}
      />

      {/* Pane tiling layout */}
      <PaneTilingLayout
        layoutId="prs:tiling:v1"
        tree={PRS_TILING_TREE}
        panes={paneConfigs}
        className="flex-1 min-h-0"
      />
    </div>
  );
}

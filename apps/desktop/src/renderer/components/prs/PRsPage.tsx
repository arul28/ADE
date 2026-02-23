import React from "react";
import { ArrowsDownUp, GitMerge, GitPullRequest, ListNumbers, Plus } from "@phosphor-icons/react";
import type { MergeMethod, PrMergeContext, PrWithConflicts } from "../../../shared/types";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { EmptyState } from "../ui/EmptyState";
import { PrsProvider, usePrs } from "./state/PrsContext";
import { NormalTab } from "./tabs/NormalTab";
import { QueueTab } from "./tabs/QueueTab";
import { IntegrationTab } from "./tabs/IntegrationTab";
import { RebaseTab } from "./tabs/RebaseTab";
import { CreatePrModal } from "./CreatePrModal";

type PrTab = "normal" | "queue" | "integration" | "rebase";

const TAB_DEFS: Array<{ id: PrTab; label: string; icon: React.ElementType }> = [
  { id: "normal", label: "Normal", icon: GitPullRequest },
  { id: "queue", label: "Queue", icon: ListNumbers },
  { id: "integration", label: "Integration", icon: GitMerge },
  { id: "rebase", label: "Rebase", icon: ArrowsDownUp },
];

function classifyPr(pr: PrWithConflicts, ctx: PrMergeContext | null): "normal" | "queue" | "integration" {
  if (ctx?.groupType === "integration") return "integration";
  if (ctx?.groupType === "queue") return "queue";
  return "normal";
}

function PRsPageInner() {
  const {
    activeTab,
    setActiveTab,
    prs,
    lanes,
    mergeContextByPrId,
    mergeMethod,
    setMergeMethod,
    selectedPrId,
    setSelectedPrId,
    selectedQueueGroupId,
    setSelectedQueueGroupId,
    selectedRebaseItemId,
    setSelectedRebaseItemId,
    rebaseNeeds,
    resolverModel,
    resolverReasoningLevel,
    setResolverModel,
    setResolverReasoningLevel,
    loading,
    error,
    refresh,
  } = usePrs();

  const [createPrOpen, setCreatePrOpen] = React.useState(false);

  // Classify PRs by type
  const { normalPrs, queuePrs, integrationPrs } = React.useMemo(() => {
    const normal: PrWithConflicts[] = [];
    const queue: PrWithConflicts[] = [];
    const integration: PrWithConflicts[] = [];
    for (const pr of prs) {
      const t = classifyPr(pr, mergeContextByPrId[pr.id] ?? null);
      if (t === "integration") integration.push(pr);
      else if (t === "queue") queue.push(pr);
      else normal.push(pr);
    }
    return { normalPrs: normal, queuePrs: queue, integrationPrs: integration };
  }, [prs, mergeContextByPrId]);

  const tabCounts: Record<PrTab, number> = {
    normal: normalPrs.length,
    queue: queuePrs.length,
    integration: integrationPrs.length,
    rebase: rebaseNeeds.filter((n) => n.behindBy > 0 && !n.dismissedAt).length,
  };

  if (error) {
    return <EmptyState title="PRs" description={`Failed to load PRs: ${error}`} />;
  }

  // Show loading skeleton on initial load (no cached PRs yet)
  if (loading && prs.length === 0) {
    return (
      <div className="flex h-full min-w-0 flex-col bg-bg items-center justify-center gap-3">
        <div className="animate-pulse flex flex-col items-center gap-2">
          <div className="h-4 w-48 rounded bg-muted/30" />
          <div className="h-3 w-32 rounded bg-muted/20" />
          <div className="mt-4 grid gap-2 w-72">
            <div className="h-10 rounded-lg bg-muted/15" />
            <div className="h-10 rounded-lg bg-muted/15" />
            <div className="h-10 rounded-lg bg-muted/15" />
          </div>
        </div>
        <div className="text-xs text-muted-fg/60">Loading PRs...</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      {/* Tab bar */}
      <div className="flex items-center gap-4 px-4 py-2.5 bg-card/20 backdrop-blur-sm border-b border-border/10">
        <div className="flex items-center gap-2.5">
          <div className="text-sm font-bold text-fg tracking-tight">PRs</div>
          <span className="text-xs text-muted-fg/65 tabular-nums">{prs.length} linked</span>
        </div>

        <div role="tablist" aria-label="PR categories" className="flex items-center rounded-lg bg-card/80 p-0.5 gap-0.5 border border-border/20">
          {TAB_DEFS.map((tab) => {
            const isActive = activeTab === tab.id;
            const Icon = tab.icon;
            const count = tabCounts[tab.id];
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls={`pr-tabpanel-${tab.id}`}
                id={`pr-tab-${tab.id}`}
                className={cn(
                  "px-2.5 py-1.5 rounded-md text-xs font-medium transition-all duration-150 flex items-center gap-1.5",
                  isActive
                    ? "bg-accent text-accent-fg shadow-sm"
                    : "text-muted-fg hover:text-fg hover:bg-muted/40",
                )}
                onClick={() => setActiveTab(tab.id)}
              >
                <Icon size={12} weight="regular" />
                <span>{tab.label}</span>
                <span className={cn("tabular-nums", isActive ? "text-accent-fg/90" : "text-muted-fg/75")}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <select
            value={mergeMethod}
            onChange={(e) => setMergeMethod(e.target.value as MergeMethod)}
            className="h-8 rounded-lg border border-border/20 bg-surface-recessed px-2 text-xs text-fg focus:outline-none focus:ring-1 focus:ring-accent/30"
            title="Default merge method"
          >
            <option value="squash">squash</option>
            <option value="merge">merge</option>
            <option value="rebase">rebase</option>
          </select>
          <Button size="sm" variant="primary" onClick={() => setCreatePrOpen(true)}>
            <Plus size={14} weight="regular" className="mr-1" />
            Create PR
          </Button>
          <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </Button>
        </div>
      </div>

      {/* Active tab */}
      {activeTab === "normal" && (
        <div role="tabpanel" id="pr-tabpanel-normal" aria-labelledby="pr-tab-normal" className="min-h-0 flex-1">
          <NormalTab
            prs={normalPrs}
            lanes={lanes}
            mergeContextByPrId={mergeContextByPrId}
            mergeMethod={mergeMethod}
            selectedPrId={selectedPrId}
            onSelectPr={setSelectedPrId}
            onRefresh={refresh}
          />
        </div>
      )}
      {activeTab === "queue" && (
        <div role="tabpanel" id="pr-tabpanel-queue" aria-labelledby="pr-tab-queue" className="min-h-0 flex-1">
          <QueueTab
            prs={queuePrs}
            lanes={lanes}
            mergeContextByPrId={mergeContextByPrId}
            mergeMethod={mergeMethod}
            selectedGroupId={selectedQueueGroupId}
            onSelectGroup={setSelectedQueueGroupId}
            onRefresh={refresh}
          />
        </div>
      )}
      {activeTab === "integration" && (
        <div role="tabpanel" id="pr-tabpanel-integration" aria-labelledby="pr-tab-integration" className="min-h-0 flex-1">
          <IntegrationTab
            prs={integrationPrs}
            lanes={lanes}
            mergeContextByPrId={mergeContextByPrId}
            mergeMethod={mergeMethod}
            selectedPrId={selectedPrId}
            onSelectPr={setSelectedPrId}
            onRefresh={refresh}
          />
        </div>
      )}
      {activeTab === "rebase" && (
        <div role="tabpanel" id="pr-tabpanel-rebase" aria-labelledby="pr-tab-rebase" className="min-h-0 flex-1">
          <RebaseTab
            rebaseNeeds={rebaseNeeds}
            lanes={lanes}
            selectedItemId={selectedRebaseItemId}
            onSelectItem={setSelectedRebaseItemId}
            resolverModel={resolverModel}
            resolverReasoningLevel={resolverReasoningLevel}
            onResolverChange={(m, l) => {
              setResolverModel(m);
              setResolverReasoningLevel(l);
            }}
            onRefresh={refresh}
          />
        </div>
      )}

      <CreatePrModal open={createPrOpen} onOpenChange={setCreatePrOpen} onCreated={() => void refresh()} />
    </div>
  );
}

export function PRsPage() {
  return (
    <PrsProvider>
      <PRsPageInner />
    </PrsProvider>
  );
}

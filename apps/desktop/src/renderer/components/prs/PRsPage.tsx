import React from "react";
import { ArrowsDownUp, GitMerge, GitPullRequest, ListNumbers, Plus, ArrowsClockwise } from "@phosphor-icons/react";
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

const TAB_DEFS: Array<{ id: PrTab; num: string; label: string; icon: React.ElementType }> = [
  { id: "normal", num: "01", label: "NORMAL", icon: GitPullRequest },
  { id: "queue", num: "02", label: "QUEUE", icon: ListNumbers },
  { id: "integration", num: "03", label: "INTEGRATION", icon: GitMerge },
  { id: "rebase", num: "04", label: "REBASE", icon: ArrowsDownUp },
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
      <div className="flex h-full min-w-0 flex-col" style={{ background: "#0F0D14" }}>
        <div className="flex flex-col items-center justify-center flex-1 gap-3">
          <div className="animate-pulse flex flex-col items-center gap-2">
            <div className="h-4 w-48 bg-[#1E1B26]" />
            <div className="h-3 w-32 bg-[#1E1B26]/60" />
            <div className="mt-4 grid gap-2 w-72">
              <div className="h-10 bg-[#13101A]" />
              <div className="h-10 bg-[#13101A]" />
              <div className="h-10 bg-[#13101A]" />
            </div>
          </div>
          <div className="text-[10px] font-mono uppercase tracking-[1px] text-[#71717A]">LOADING PRS...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col" style={{ background: "#0F0D14" }}>
      {/* Header — 64px, industrial design */}
      <div className="flex items-center gap-6 h-16 px-6 shrink-0" style={{ borderBottom: "1px solid #1E1B26" }}>
        {/* Title block */}
        <div className="flex items-center gap-3">
          <GitPullRequest size={18} weight="bold" className="text-[#A78BFA]" />
          <span className="text-[16px] font-bold tracking-[-0.3px] text-[#FAFAFA]" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
            PULL REQUESTS
          </span>
          <span
            className="px-2.5 py-1 text-[9px] font-mono font-bold uppercase tracking-[1px] text-[#A78BFA]"
            style={{ background: "#A78BFA18", border: "1px solid #A78BFA30" }}
          >
            {prs.length} LINKED
          </span>
        </div>

        {/* Tab bar — numbered tabs */}
        <div role="tablist" aria-label="PR categories" className="flex items-center gap-0.5">
          {TAB_DEFS.map((tab) => {
            const isActive = activeTab === tab.id;
            const count = tabCounts[tab.id];
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls={`pr-tabpanel-${tab.id}`}
                id={`pr-tab-${tab.id}`}
                className="relative flex items-center gap-2 px-4 py-2.5 text-[10px] font-mono font-bold uppercase tracking-[1px] transition-colors duration-150"
                style={isActive ? {
                  background: "#A78BFA18",
                  borderLeft: "2px solid #A78BFA",
                  color: "#FAFAFA",
                } : {
                  background: "transparent",
                  borderLeft: "2px solid transparent",
                  color: "#71717A",
                }}
                onClick={() => setActiveTab(tab.id)}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.color = "#A1A1AA"; }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.color = "#71717A"; }}
              >
                <span style={{ color: isActive ? "#A78BFA" : "#52525B" }}>{tab.num}</span>
                <span>{tab.label}</span>
                {count > 0 && (
                  <span
                    className="tabular-nums text-[9px] min-w-[16px] text-center px-1.5 py-0.5"
                    style={isActive ? {
                      background: "#A78BFA30",
                      color: "#A78BFA",
                    } : {
                      background: "#27272A",
                      color: "#71717A",
                    }}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Right actions */}
        <div className="ml-auto flex items-center gap-3">
          <select
            value={mergeMethod}
            onChange={(e) => setMergeMethod(e.target.value as MergeMethod)}
            className="h-8 px-3 text-[10px] font-mono font-bold uppercase tracking-[1px] text-[#A1A1AA] focus:outline-none transition-colors"
            style={{ background: "#0C0A10", border: "1px solid #27272A" }}
            title="Default merge method"
          >
            <option value="squash">SQUASH</option>
            <option value="merge">MERGE</option>
            <option value="rebase">REBASE</option>
          </select>
          <button
            onClick={() => setCreatePrOpen(true)}
            className="flex items-center gap-2 h-8 px-5 text-[10px] font-mono font-bold uppercase tracking-[1px] text-[#0F0D14] transition-all duration-100 hover:brightness-110 active:scale-[0.97]"
            style={{ background: "#A78BFA" }}
          >
            <Plus size={14} weight="bold" />
            NEW PR
          </button>
          <button
            onClick={() => void refresh()}
            disabled={loading}
            className={cn(
              "flex items-center justify-center h-8 w-8 text-[#71717A] hover:text-[#FAFAFA] transition-colors duration-150",
              loading && "animate-spin text-[#A78BFA]",
            )}
            style={{ border: "1px solid #27272A" }}
            title="Refresh"
          >
            <ArrowsClockwise size={14} weight="bold" />
          </button>
        </div>
      </div>

      {/* Active tab panel */}
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

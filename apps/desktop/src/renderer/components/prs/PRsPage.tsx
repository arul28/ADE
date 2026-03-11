import React from "react";
import { GitPullRequest, Plus } from "@phosphor-icons/react";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import { PrsProvider, usePrs } from "./state/PrsContext";
import { CreatePrModal } from "./CreatePrModal";
import { useAppStore } from "../../state/appStore";
import { GitHubTab } from "./tabs/GitHubTab";
import { WorkflowsTab, type WorkflowCategory } from "./tabs/WorkflowsTab";

type SurfaceMode = "github" | "workflows";

function PRsPageInner() {
  const refreshLanes = useAppStore((state) => state.refreshLanes);
  const {
    activeTab,
    setActiveTab,
    prs,
    lanes,
    mergeMethod,
    selectedPrId,
    setSelectedPrId,
    setSelectedRebaseItemId,
    loading,
    error,
    refresh,
  } = usePrs();

  const [createPrOpen, setCreatePrOpen] = React.useState(false);
  const [lastWorkflowTab, setLastWorkflowTab] = React.useState<WorkflowCategory>("integration");

  React.useEffect(() => {
    if (activeTab !== "normal") {
      setLastWorkflowTab(activeTab);
    }
  }, [activeTab]);

  const handleRefresh = React.useCallback(async () => {
    await Promise.all([
      refresh(),
      refreshLanes().catch(() => {}),
    ]);
  }, [refresh, refreshLanes]);

  React.useEffect(() => {
    const syncFromLocation = () => {
      try {
        const searchParams = new URLSearchParams(window.location.search);
        const fromSearch = searchParams.get("tab");
        const workflow = searchParams.get("workflow");
        const searchLaneId = searchParams.get("laneId");
        const fromHash = (() => {
          const hash = window.location.hash ?? "";
          const queryIndex = hash.indexOf("?");
          if (queryIndex < 0) return null;
          const hashParams = new URLSearchParams(hash.slice(queryIndex + 1));
          return {
            tab: hashParams.get("tab"),
            workflow: hashParams.get("workflow"),
            laneId: hashParams.get("laneId"),
          };
        })();

        const tab = fromSearch ?? fromHash?.tab ?? null;
        const workflowTab = workflow ?? fromHash?.workflow ?? null;
        const laneId = searchLaneId ?? fromHash?.laneId ?? null;

        if (tab === "github" || tab === "normal") {
          setActiveTab("normal");
        } else if (tab === "workflows") {
          const nextWorkflowTab = workflowTab === "queue" || workflowTab === "integration" || workflowTab === "rebase"
            ? workflowTab
            : "integration";
          setActiveTab(nextWorkflowTab);
        } else if (tab === "queue" || tab === "integration" || tab === "rebase") {
          setActiveTab(tab);
        }

        if ((tab === "rebase" || workflowTab === "rebase") && laneId) {
          setSelectedRebaseItemId(laneId);
        }
      } catch {
        // Ignore malformed URLs and fall back to current state.
      }
    };

    syncFromLocation();
    window.addEventListener("popstate", syncFromLocation);
    window.addEventListener("hashchange", syncFromLocation);
    return () => {
      window.removeEventListener("popstate", syncFromLocation);
      window.removeEventListener("hashchange", syncFromLocation);
    };
  }, [setActiveTab, setSelectedRebaseItemId]);

  const activeMode: SurfaceMode = activeTab === "normal" ? "github" : "workflows";

  if (error) {
    return <EmptyState title="PRs" description={`Failed to load PRs: ${error}`} />;
  }

  if (loading && prs.length === 0) {
    return (
      <div className="flex h-full min-w-0 flex-col" style={{ background: "#0F0D14" }}>
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <div className="animate-pulse flex flex-col items-center gap-2">
            <div className="h-4 w-48 bg-[#1E1B26]" />
            <div className="h-3 w-32 bg-[#1E1B26]/60" />
            <div className="mt-4 grid w-72 gap-2">
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
      <div className="flex h-16 shrink-0 items-center gap-6 px-6" style={{ borderBottom: "1px solid #1E1B26" }}>
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

        <div role="tablist" aria-label="PR surfaces" className="flex items-center gap-0.5">
          {([
            { id: "github", num: "01", label: "GITHUB" },
            { id: "workflows", num: "02", label: "WORKFLOWS" },
          ] as Array<{ id: SurfaceMode; num: string; label: string }>).map((surface) => {
            const active = activeMode === surface.id;
            return (
              <button
                key={surface.id}
                type="button"
                role="tab"
                aria-selected={active}
                className="relative flex items-center gap-2 px-4 py-2.5 text-[10px] font-mono font-bold uppercase tracking-[1px] transition-colors duration-150"
                style={active ? {
                  background: "#A78BFA18",
                  borderLeft: "2px solid #A78BFA",
                  color: "#FAFAFA",
                } : {
                  background: "transparent",
                  borderLeft: "2px solid transparent",
                  color: "#71717A",
                }}
                onClick={() => {
                  if (surface.id === "github") {
                    setActiveTab("normal");
                  } else {
                    setActiveTab(lastWorkflowTab);
                  }
                }}
              >
                <span style={{ color: active ? "#A78BFA" : "#52525B" }}>{surface.num}</span>
                <span>{surface.label}</span>
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-3">
          <button
            type="button"
            onClick={() => setCreatePrOpen(true)}
            className={cn(
              "flex items-center gap-2 h-8 px-5 text-[10px] font-mono font-bold uppercase tracking-[1px] text-[#0F0D14] transition-all duration-100 hover:brightness-110 active:scale-[0.97]"
            )}
            style={{ background: "#A78BFA" }}
          >
            <Plus size={14} weight="bold" />
            Create
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {activeMode === "github" ? (
          <GitHubTab
            lanes={lanes}
            mergeMethod={mergeMethod}
            selectedPrId={selectedPrId}
            onSelectPr={setSelectedPrId}
            onRefreshAll={handleRefresh}
          />
        ) : (
          <WorkflowsTab
            activeCategory={activeTab === "normal" ? lastWorkflowTab : activeTab}
            onChangeCategory={(category) => setActiveTab(category)}
            onRefreshAll={handleRefresh}
            onOpenGitHubTab={(prId) => {
              setSelectedPrId(prId);
              setActiveTab("normal");
            }}
          />
        )}
      </div>

      <CreatePrModal open={createPrOpen} onOpenChange={setCreatePrOpen} />
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

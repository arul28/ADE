import React from "react";
import { GitPullRequest, Plus } from "@phosphor-icons/react";
import { useLocation, useNavigate } from "react-router-dom";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import { PrsProvider, usePrs } from "./state/PrsContext";
import { CreatePrModal } from "./CreatePrModal";
import { useAppStore } from "../../state/appStore";
import { GitHubTab } from "./tabs/GitHubTab";
import { WorkflowsTab, type WorkflowCategory } from "./tabs/WorkflowsTab";
import { SANS_FONT } from "../lanes/laneDesignTokens";
import { isMissionLaneHiddenByDefault } from "../lanes/laneUtils";
import { buildPrsRouteSearch, parsePrsRouteState } from "./prsRouteState";
import { resolveRouteRebaseSelection } from "./shared/rebaseNeedUtils";

type SurfaceMode = "github" | "workflows";

function PRsPageInner() {
  const navigate = useNavigate();
  const location = useLocation();
  const refreshLanes = useAppStore((state) => state.refreshLanes);
  const {
    activeTab,
    setActiveTab,
    prs,
    lanes,
    mergeMethod,
    selectedPrId,
    setSelectedPrId,
    selectedQueueGroupId,
    setSelectedQueueGroupId,
    rebaseNeeds,
    selectedRebaseItemId,
    setSelectedRebaseItemId,
    loading,
    error,
    refresh,
  } = usePrs();

  const [createPrOpen, setCreatePrOpen] = React.useState(false);
  const [lastWorkflowTab, setLastWorkflowTab] = React.useState<WorkflowCategory>("integration");
  const [integrationRefreshNonce, setIntegrationRefreshNonce] = React.useState(0);
  const visibleLanes = React.useMemo(
    () => lanes.filter((lane) => !isMissionLaneHiddenByDefault(lane)),
    [lanes],
  );

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
    setIntegrationRefreshNonce((prev) => prev + 1);
  }, [refresh, refreshLanes]);

  React.useEffect(() => {
    const syncFromLocation = () => {
      try {
        const routeState = parsePrsRouteState({
          search: location.search,
          hash: window.location.hash,
        });
        const tab = routeState.tab;
        const workflowTab = routeState.workflowTab;
        const routeRebaseItemId = resolveRouteRebaseSelection({
          rebaseNeeds,
          routeItemId: routeState.laneId,
        });

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

        if (tab === "normal" || tab === "github") {
          setSelectedPrId(routeState.prId ?? null);
        }
        if (tab === "queue" || workflowTab === "queue") {
          setSelectedQueueGroupId(routeState.queueGroupId ?? null);
        }
        if (tab === "rebase" || workflowTab === "rebase") {
          setSelectedRebaseItemId(routeRebaseItemId);
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
  }, [location.search, rebaseNeeds, setActiveTab, setSelectedPrId, setSelectedQueueGroupId, setSelectedRebaseItemId]);

  React.useEffect(() => {
    const nextSearch = buildPrsRouteSearch({
      activeTab,
      selectedPrId,
      selectedQueueGroupId,
      selectedRebaseItemId,
    });
    if (location.search === nextSearch) return;
    void navigate({ pathname: location.pathname, search: nextSearch }, { replace: true });
  }, [
    activeTab,
    selectedPrId,
    selectedQueueGroupId,
    selectedRebaseItemId,
    location.pathname,
    location.search,
    navigate,
  ]);

  const activeMode: SurfaceMode = activeTab === "normal" ? "github" : "workflows";

  if (error) {
    return <EmptyState title="PRs" description={`Failed to load PRs: ${error}`} />;
  }

  if (loading && prs.length === 0) {
    return (
      <div className="flex h-full min-w-0 flex-col" style={{ background: "#0F0D14" }}>
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          {/* Shimmer skeleton loader */}
          <style>{`
            @keyframes prs-shimmer {
              0% { background-position: -200% 0; }
              100% { background-position: 200% 0; }
            }
            .prs-shimmer-bar {
              background: linear-gradient(90deg, rgba(167,139,250,0.04) 25%, rgba(167,139,250,0.10) 50%, rgba(167,139,250,0.04) 75%);
              background-size: 200% 100%;
              animation: prs-shimmer 1.8s ease-in-out infinite;
            }
          `}</style>
          <div className="flex flex-col items-center gap-3">
            <div className="prs-shimmer-bar h-5 w-52 rounded-lg" />
            <div className="prs-shimmer-bar h-3 w-36 rounded-lg" style={{ opacity: 0.7 }} />
          </div>
          <div className="mt-2 grid w-80 gap-2.5">
            <div className="prs-shimmer-bar h-12 rounded-xl" style={{ border: "1px solid rgba(167,139,250,0.08)" }} />
            <div className="prs-shimmer-bar h-12 rounded-xl" style={{ border: "1px solid rgba(167,139,250,0.06)", animationDelay: "0.15s" }} />
            <div className="prs-shimmer-bar h-12 rounded-xl" style={{ border: "1px solid rgba(167,139,250,0.04)", animationDelay: "0.3s" }} />
          </div>
          <div
            style={{
              fontFamily: SANS_FONT,
              fontSize: 12,
              fontWeight: 500,
              letterSpacing: "0.3px",
              color: "#71717A",
              marginTop: 4,
            }}
          >
            Loading pull requests...
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col" style={{ background: "#0F0D14" }}>
      {/* Header bar with subtle gradient */}
      <div
        className="flex h-16 shrink-0 items-center gap-6 px-6"
        style={{
          background: "linear-gradient(180deg, rgba(167,139,250,0.06) 0%, rgba(167,139,250,0.01) 100%)",
          borderBottom: "1px solid rgba(167,139,250,0.10)",
        }}
      >
        <div className="flex items-center gap-3">
          <div
            className="flex items-center justify-center"
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: "linear-gradient(135deg, rgba(167,139,250,0.18) 0%, rgba(139,92,246,0.08) 100%)",
              border: "1px solid rgba(167,139,250,0.15)",
            }}
          >
            <GitPullRequest size={16} weight="bold" className="text-[#A78BFA]" />
          </div>
          <span
            style={{
              fontFamily: SANS_FONT,
              fontSize: 15,
              fontWeight: 700,
              letterSpacing: "-0.3px",
              color: "#FAFAFA",
            }}
          >
            Pull Requests
          </span>
          <span
            className="rounded-full px-2.5 py-0.5"
            style={{
              fontFamily: SANS_FONT,
              fontSize: 11,
              fontWeight: 600,
              color: "#A78BFA",
              background: "linear-gradient(135deg, rgba(167,139,250,0.14) 0%, rgba(139,92,246,0.08) 100%)",
              border: "1px solid rgba(167,139,250,0.18)",
            }}
          >
            {prs.length} linked
          </span>
        </div>

        <div role="tablist" aria-label="PR surfaces" className="flex items-center gap-1">
          {([
            { id: "github", label: "GitHub" },
            { id: "workflows", label: "Workflows" },
          ] as Array<{ id: SurfaceMode; label: string }>).map((surface) => {
            const active = activeMode === surface.id;
            return (
              <button
                key={surface.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={cn(
                  "relative flex items-center gap-2 rounded-lg px-4 py-2 transition-all duration-200",
                  active
                    ? "text-[#FAFAFA]"
                    : "text-[#71717A] hover:text-[#A1A1AA]"
                )}
                style={{
                  fontFamily: SANS_FONT,
                  fontSize: 13,
                  fontWeight: active ? 600 : 500,
                  ...(active
                    ? {
                        background: "linear-gradient(135deg, rgba(167,139,250,0.14) 0%, rgba(139,92,246,0.06) 100%)",
                        border: "1px solid rgba(167,139,250,0.20)",
                        boxShadow: "0 0 12px rgba(167,139,250,0.08)",
                      }
                    : {
                        border: "1px solid transparent",
                        background: "transparent",
                      }),
                }}
                onClick={() => {
                  if (surface.id === "github") {
                    setActiveTab("normal");
                  } else {
                    setActiveTab(lastWorkflowTab);
                  }
                }}
              >
                <span>{surface.label}</span>
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-3">
          <button
            type="button"
            onClick={() => setCreatePrOpen(true)}
            className="flex items-center gap-2 active:scale-[0.97]"
            style={{
              height: 34,
              padding: "0 16px",
              borderRadius: 10,
              fontFamily: SANS_FONT,
              fontSize: 13,
              fontWeight: 600,
              color: "#fff",
              background: "linear-gradient(135deg, #A78BFA 0%, #8B5CF6 100%)",
              border: "none",
              cursor: "pointer",
              boxShadow: "0 2px 8px rgba(139,92,246,0.30), inset 0 1px 0 rgba(255,255,255,0.10)",
              transition: "all 150ms ease",
            }}
          >
            <Plus size={14} weight="bold" />
            Create PR
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {activeMode === "github" ? (
          <GitHubTab
            lanes={visibleLanes}
            mergeMethod={mergeMethod}
            selectedPrId={selectedPrId}
            onSelectPr={setSelectedPrId}
            onRefreshAll={handleRefresh}
            onOpenRebaseTab={(laneId) => {
              if (laneId) setSelectedRebaseItemId(laneId);
              setActiveTab("rebase");
            }}
            onOpenQueueView={(groupId) => {
              setSelectedQueueGroupId(groupId);
              setActiveTab("queue");
            }}
          />
        ) : (
          <WorkflowsTab
            activeCategory={activeTab === "normal" ? lastWorkflowTab : activeTab}
            onChangeCategory={(category) => setActiveTab(category)}
            onRefreshAll={handleRefresh}
            selectedPrId={selectedPrId}
            onSelectPr={setSelectedPrId}
            onOpenGitHubTab={(prId) => {
              setSelectedPrId(prId);
              setActiveTab("normal");
            }}
            integrationRefreshNonce={integrationRefreshNonce}
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

import React from "react";
import { GitPullRequest, GithubLogo, Plus } from "@phosphor-icons/react";
import { useLocation, useNavigate } from "react-router-dom";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import { PrsProvider, usePrs } from "./state/PrsContext";
import { CreatePrModal, type CreatePrModalInitialValues } from "./CreatePrModal";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import { useDialogBus } from "../../lib/useDialogBus";
import { GitHubTab, type GitHubHeaderChromeState } from "./tabs/GitHubTab";
import { WorkflowsTab, type WorkflowCategory } from "./tabs/WorkflowsTab";
import { GitHubRepoSyncBar } from "./shared/GitHubRepoSyncBar";
import { GitHubPrSearchInput } from "./shared/GitHubPrSearchInput";
import { SANS_FONT } from "../lanes/laneDesignTokens";
import {
  buildPrsRouteSearch,
  parsePrsRouteState,
  resolvePrsActiveTab,
  writeStoredPrsRoute,
  type PrDetailRouteTab,
} from "./prsRouteState";
import { resolveRouteRebaseSelection } from "./shared/rebaseNeedUtils";
import type { PrSummary } from "../../../shared/types";

type SurfaceMode = "github" | "workflows";
type PrRefreshArgs = { prId?: string; prIds?: string[] };

const LAST_WORKFLOW_TAB_KEY = "ade:prs:lastWorkflowTab";

function scopedLastWorkflowTabKey(projectRoot?: string | null): string {
  const root = projectRoot?.trim();
  return root ? `${LAST_WORKFLOW_TAB_KEY}:${root}` : LAST_WORKFLOW_TAB_KEY;
}

function readLastWorkflowTab(projectRoot?: string | null): WorkflowCategory {
  try {
    const value = window.localStorage.getItem(scopedLastWorkflowTabKey(projectRoot));
    if (value === "integration" || value === "queue" || value === "rebase") return value;
  } catch {
    /* ignore */
  }
  return "integration";
}

function writeLastWorkflowTab(projectRoot: string | null, tab: WorkflowCategory): void {
  try {
    window.localStorage.setItem(scopedLastWorkflowTabKey(projectRoot), tab);
  } catch {
    /* ignore */
  }
}

function parseParams(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
}

function parseHashParams(hash: string): URLSearchParams {
  const queryIndex = hash.indexOf("?");
  if (queryIndex < 0) return new URLSearchParams();
  return parseParams(hash.slice(queryIndex + 1));
}

function createInitialValuesFromParams(params: URLSearchParams): CreatePrModalInitialValues | null {
  const create = params.get("create");
  if (create !== "1" && create !== "true") return null;

  const sourceLaneId = (params.get("sourceLaneId") ?? params.get("laneId") ?? "").trim();
  const target = params.get("target") === "primary" ? "primary" : null;
  return {
    sourceLaneId: sourceLaneId || null,
    target,
  };
}

function readCreatePrRouteRequest(args: { search: string; hash: string }): {
  key: string;
  initialValues: CreatePrModalInitialValues;
} | null {
  const searchParams = parseParams(args.search);
  const searchInitialValues = createInitialValuesFromParams(searchParams);
  if (searchInitialValues) {
    return {
      key: searchParams.toString(),
      initialValues: searchInitialValues,
    };
  }

  const hashParams = parseHashParams(args.hash);
  if (!args.hash.startsWith("#/prs")) return null;
  const initialValues = createInitialValuesFromParams(hashParams);
  if (!initialValues) return null;
  return {
    key: hashParams.toString(),
    initialValues,
  };
}

function createInitialValuesFromDialogProps(props?: Record<string, unknown>): CreatePrModalInitialValues | null {
  if (!props) return null;
  const sourceLaneId = typeof props.sourceLaneId === "string" ? props.sourceLaneId.trim() : "";
  const target = props.target === "primary" ? "primary" : null;
  if (!sourceLaneId && !target) return null;
  return { sourceLaneId: sourceLaneId || null, target };
}

function PRsPageInner() {
  const navigate = useNavigate();
  const location = useLocation();
  const projectRoot = useAppStore(selectActiveProjectRoot);
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
  const [createPrInitialValues, setCreatePrInitialValues] = React.useState<CreatePrModalInitialValues | null>(null);
  const consumedCreateRouteKeyRef = React.useRef<string | null>(null);
  const [lastWorkflowTab, setLastWorkflowTab] = React.useState<WorkflowCategory>(() => readLastWorkflowTab(projectRoot));
  const [integrationRefreshNonce, setIntegrationRefreshNonce] = React.useState(0);
  const [githubHeaderChrome, setGithubHeaderChrome] = React.useState<GitHubHeaderChromeState | null>(null);
  const lastRouteLocationKeyRef = React.useRef<string | null>(null);
  const [selectedDetailTab, setSelectedDetailTab] = React.useState<PrDetailRouteTab | null>(() => {
    try {
      return parsePrsRouteState({ search: window.location.search, hash: window.location.hash }).detailTab;
    } catch {
      return null;
    }
  });
  const visibleLanes = lanes;

  React.useEffect(() => {
    if (activeTab !== "normal") {
      setLastWorkflowTab(activeTab);
      writeLastWorkflowTab(projectRoot, activeTab);
    }
  }, [activeTab, projectRoot]);

  React.useEffect(() => {
    if (activeTab === "normal") {
      setLastWorkflowTab(readLastWorkflowTab(projectRoot));
    }
  }, [activeTab, projectRoot]);

  const handleRefresh = React.useCallback(async (args: PrRefreshArgs = {}) => {
    const targeted = Boolean(args.prId || (args.prIds?.length ?? 0) > 0);
    await Promise.all([
      refresh(args),
      targeted ? Promise.resolve() : refreshLanes({ includeStatus: false, includeSnapshots: false }).catch(() => {}),
    ]);
    if (!targeted) setIntegrationRefreshNonce((prev) => prev + 1);
  }, [refresh, refreshLanes]);

  const openCreatePr = React.useCallback((props?: Record<string, unknown>) => {
    setCreatePrInitialValues(createInitialValuesFromDialogProps(props));
    setCreatePrOpen(true);
  }, []);
  const closeCreatePr = React.useCallback(() => setCreatePrOpen(false), []);

  useDialogBus("prs.create", {
    onOpen: openCreatePr,
    onClose: closeCreatePr,
  });

  const handlePrCreated = React.useCallback(async (created: PrSummary[]) => {
    await handleRefresh();
    const first = created[0];
    if (!first) return;
    setActiveTab("normal");
    setSelectedPrId(first.id);
  }, [handleRefresh, setActiveTab, setSelectedPrId]);

  React.useEffect(() => {
    const syncFromLocation = () => {
      try {
        const locationKey = `${location.pathname}${location.search}${window.location.hash}`;
        const locationChanged = lastRouteLocationKeyRef.current !== locationKey;
        lastRouteLocationKeyRef.current = locationKey;
        const routeState = parsePrsRouteState({
          search: location.search,
          hash: window.location.hash,
        });
        const resolved = resolvePrsActiveTab(routeState);
        const createRequest = readCreatePrRouteRequest({
          search: location.search,
          hash: window.location.hash,
        });
        const routeRebaseItemId = resolveRouteRebaseSelection({
          rebaseNeeds,
          routeItemId: routeState.laneId,
        });

        setActiveTab(resolved.activeTab);

        if (!resolved.isWorkflowRoute) {
          const hasExplicitPrSelection = Boolean(routeState.prId) || routeState.prNumber != null;
          const prNumberMatch = routeState.prNumber == null
            ? null
            : prs.find((pr) => pr.githubPrNumber === routeState.prNumber)?.id ?? null;
          if (hasExplicitPrSelection || locationChanged) {
            setSelectedPrId(routeState.prId ?? prNumberMatch);
          }
          if (hasExplicitPrSelection || locationChanged || routeState.detailTab) {
            setSelectedDetailTab(routeState.detailTab);
          }
        }
        if (resolved.effectiveWorkflow === "queue") {
          setSelectedQueueGroupId(routeState.queueGroupId ?? null);
        }
        if (resolved.effectiveWorkflow === "rebase") {
          setSelectedRebaseItemId(routeRebaseItemId);
        }
        if (createRequest && consumedCreateRouteKeyRef.current !== createRequest.key) {
          consumedCreateRouteKeyRef.current = createRequest.key;
          setCreatePrInitialValues(createRequest.initialValues);
          setCreatePrOpen(true);
        } else if (!createRequest) {
          consumedCreateRouteKeyRef.current = null;
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
  }, [location.search, prs, rebaseNeeds, setActiveTab, setSelectedPrId, setSelectedQueueGroupId, setSelectedRebaseItemId]);

  React.useEffect(() => {
    const current = parsePrsRouteState({ search: location.search });
    // Preserve per-PR deep-link params (eventId/threadId/commitSha) as long as
    // the URL still points at the currently selected PR. When the PR changes,
    // stale deep-link params for the old PR get dropped.
    const preserveDeepLinks =
      activeTab === "normal" &&
      selectedPrId !== null &&
      current.prId === selectedPrId;
    const deepLinks = preserveDeepLinks
      ? { eventId: current.eventId, threadId: current.threadId, commitSha: current.commitSha }
      : { eventId: null, threadId: null, commitSha: null };
    const nextSearch = buildPrsRouteSearch({
      activeTab,
      selectedPrId,
      selectedQueueGroupId,
      selectedRebaseItemId,
      detailTab: activeTab === "normal" ? selectedDetailTab : null,
      ...deepLinks,
    });
    if (location.search === nextSearch) return;
    void navigate({ pathname: location.pathname, search: nextSearch }, { replace: true });
  }, [
    activeTab,
    selectedPrId,
    selectedQueueGroupId,
    selectedRebaseItemId,
    selectedDetailTab,
    location.pathname,
    location.search,
    navigate,
  ]);

  React.useEffect(() => {
    if (location.pathname !== "/prs") return;
    if (readCreatePrRouteRequest({ search: location.search, hash: window.location.hash })) return;
    writeStoredPrsRoute(`${location.pathname}${location.search}`, projectRoot);
  }, [location.pathname, location.search, projectRoot]);

  const activeMode: SurfaceMode = activeTab === "normal" ? "github" : "workflows";

  React.useEffect(() => {
    if (activeMode !== "github") {
      setGithubHeaderChrome(null);
    }
  }, [activeMode]);

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
        className="flex h-12 shrink-0 items-center gap-4 px-5"
        style={{
          background: "linear-gradient(180deg, rgba(167,139,250,0.06) 0%, rgba(167,139,250,0.01) 100%)",
          borderBottom: "1px solid rgba(167,139,250,0.10)",
        }}
      >
        <div className="flex items-center gap-2.5">
          <div
            className="flex items-center justify-center"
            style={{
              width: 26,
              height: 26,
              borderRadius: 7,
              background: "linear-gradient(135deg, rgba(167,139,250,0.18) 0%, rgba(139,92,246,0.08) 100%)",
              border: "1px solid rgba(167,139,250,0.15)",
            }}
          >
            <GitPullRequest size={14} weight="bold" className="text-[#A78BFA]" />
          </div>
          <span
            style={{
              fontFamily: SANS_FONT,
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: "-0.3px",
              color: "#FAFAFA",
            }}
          >
            Pull Requests
          </span>
        </div>

        <div role="tablist" aria-label="PR surfaces" className="flex items-center gap-1">
          {([
            { id: "github", label: "GitHub", icon: GithubLogo },
            { id: "workflows", label: "Workflows" },
          ] as Array<{ id: SurfaceMode; label: string; icon?: React.ElementType }>).map((surface) => {
            const active = activeMode === surface.id;
            const Icon = surface.icon;
            return (
              <button
                key={surface.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={cn(
                  "relative flex items-center gap-1.5 rounded-lg px-3 py-1.5 transition-all duration-200",
                  active
                    ? "text-[#FAFAFA]"
                    : "text-[#71717A] hover:text-[#A1A1AA]"
                )}
                style={{
                  fontFamily: SANS_FONT,
                  fontSize: 12,
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
                {Icon ? <Icon size={14} weight={active ? "fill" : "regular"} /> : null}
                <span>{surface.label}</span>
              </button>
            );
          })}
        </div>

        {activeMode === "github" && githubHeaderChrome ? (
          <GitHubPrSearchInput
            value={githubHeaderChrome.searchQuery}
            onChange={githubHeaderChrome.onSearchQueryChange}
            compact
          />
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-3">
          {activeMode === "github" && githubHeaderChrome?.repoLabel ? (
            <GitHubRepoSyncBar
              repoLabel={githubHeaderChrome.repoLabel}
              syncing={githubHeaderChrome.syncing}
              onSync={githubHeaderChrome.onSync}
              compact
            />
          ) : null}
          <button
            type="button"
            data-tour="prs.createBtn"
            onClick={() => openCreatePr()}
            className="flex items-center gap-2 active:scale-[0.97]"
            style={{
              height: 30,
              padding: "0 14px",
              borderRadius: 9,
              fontFamily: SANS_FONT,
              fontSize: 12,
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
            selectedDetailTab={selectedDetailTab}
            onDetailTabChange={setSelectedDetailTab}
            onRefreshAll={handleRefresh}
            relocateHeaderChrome
            onHeaderChromeChange={setGithubHeaderChrome}
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

      <CreatePrModal
        open={createPrOpen}
        onOpenChange={setCreatePrOpen}
        onCreated={handlePrCreated}
        initialValues={createPrInitialValues}
      />
    </div>
  );
}

export function PRsPage({ active = true }: { active?: boolean } = {}) {
  const providerKey = useAppStore((state) =>
    state.projectBinding?.key ?? state.project?.rootPath ?? "__no_project__"
  );

  return (
    <PrsProvider key={providerKey} active={active}>
      <PRsPageInner />
    </PrsProvider>
  );
}

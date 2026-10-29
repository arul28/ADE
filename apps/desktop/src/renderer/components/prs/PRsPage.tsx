import React from "react";
import { Plus } from "@phosphor-icons/react";
import { useLocation, useNavigate } from "react-router-dom";
import { EmptyState } from "../ui/EmptyState";
import { PrsProvider, usePrs } from "./state/PrsContext";
import { CreatePrModal, type CreatePrModalInitialValues } from "./CreatePrModal";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import { useDialogBus } from "../../lib/useDialogBus";
import { GitHubTab } from "./tabs/GitHubTab";
import type { GitHubTabSort } from "./tabs/prBlockedSort";
import { PrsListHostProvider } from "./shared/PrsListHost";
import { ProjectSidebarSlot, useHasProjectSidebar } from "../app/projectSidebar/ProjectSidebarSlot";
import { SANS_FONT, fgTint } from "../lanes/laneDesignTokens";
import {
  buildPrsRouteSearch,
  parsePrsRouteState,
  prRouteCoordinatesMatch,
  prRouteSelectionTarget,
  prRouteTargetsEqual,
  writeStoredPrsRoute,
  type PrDetailRouteTab,
  type PrRouteSelectionTarget,
} from "./prsRouteState";
import type { PrSummary } from "../../../shared/types";

type PrRefreshArgs = { prId?: string; prIds?: string[] };

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

function PRsPageInner({ active }: { active: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const refreshLanes = useAppStore((state) => state.refreshLanes);
  const {
    prs,
    lanes,
    mergeMethod,
    selectedPrId,
    setSelectedPrId,
    loading,
    error,
    refresh,
  } = usePrs();

  const [createPrOpen, setCreatePrOpen] = React.useState(false);
  const [createPrInitialValues, setCreatePrInitialValues] = React.useState<CreatePrModalInitialValues | null>(null);
  const consumedCreateRouteKeyRef = React.useRef<string | null>(null);
  const hasProjectSidebar = useHasProjectSidebar();
  const [listHost, setListHost] = React.useState<HTMLElement | null>(null);
  const lastRouteLocationKeyRef = React.useRef<string | null>(null);
  const lastAppliedSelectionKeyRef = React.useRef<string | null>(null);
  const [selectedPrTarget, setSelectedPrTarget] = React.useState<PrRouteSelectionTarget | null>(() => {
    try {
      return prRouteSelectionTarget(parsePrsRouteState({
        search: window.location.search,
        hash: window.location.hash,
      }));
    } catch {
      return null;
    }
  });
  const [selectedDetailTab, setSelectedDetailTab] = React.useState<PrDetailRouteTab | null>(() => {
    try {
      return parsePrsRouteState({ search: window.location.search, hash: window.location.hash }).detailTab;
    } catch {
      return null;
    }
  });
  const [githubSort, setGithubSort] = React.useState<GitHubTabSort | null>(() => {
    try {
      return parsePrsRouteState({ search: window.location.search, hash: window.location.hash }).githubSort;
    } catch {
      return null;
    }
  });
  const visibleLanes = lanes;

  const handleRefresh = React.useCallback(async (args: PrRefreshArgs = {}) => {
    const targeted = Boolean(args.prId || (args.prIds?.length ?? 0) > 0);
    await Promise.all([
      refresh(args),
      targeted ? Promise.resolve() : refreshLanes({ includeStatus: false, includeSnapshots: false }).catch(() => {}),
    ]);
  }, [refresh, refreshLanes]);

  const handleSelectPr = React.useCallback((id: string | null, target: PrRouteSelectionTarget | null) => {
    setSelectedPrId(id);
    setSelectedPrTarget(target ? { ...target, prId: id ?? target.prId } : null);
  }, [setSelectedPrId]);

  // Only "blocked" is a durable URL preference; the default (updated) clears it.
  const handleGithubSortChange = React.useCallback((next: GitHubTabSort) => {
    setGithubSort(next === "blocked" ? "blocked" : null);
  }, []);

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
    setSelectedPrId(first.id);
    setSelectedPrTarget({
      prId: first.id,
      prNumber: first.githubPrNumber,
      repoOwner: first.repoOwner,
      repoName: first.repoName,
    });
  }, [handleRefresh, setSelectedPrId, setSelectedPrTarget]);

  React.useEffect(() => {
    if (!active || location.pathname !== "/prs") return;
    const syncFromLocation = () => {
      try {
        const locationKey = `${location.pathname}${location.search}${window.location.hash}`;
        const locationChanged = lastRouteLocationKeyRef.current !== locationKey;
        lastRouteLocationKeyRef.current = locationKey;
        const routeState = parsePrsRouteState({
          search: location.search,
          hash: window.location.hash,
        });
        const createRequest = readCreatePrRouteRequest({
          search: location.search,
          hash: window.location.hash,
        });
        const routeTarget = prRouteSelectionTarget(routeState);
        const hasExplicitPrSelection = routeTarget !== null;
        const prNumberMatch = routeState.prNumber == null
          ? null
          : prs.find((pr) => prRouteCoordinatesMatch(
            {
              prNumber: pr.githubPrNumber,
              repoOwner: pr.repoOwner,
              repoName: pr.repoName,
            },
            routeState,
          ))?.id ?? null;
        const localRouteId = routeState.prId && (
          loading || prs.some((pr) => pr.id === routeState.prId)
        )
          ? routeState.prId
          : null;
        // Re-applied only when the URL or what it resolves to changes (the
        // ADE row arriving after load). A plain reload of the PR list must
        // not put the URL's previous PR back over a row the user just picked
        // (the list then highlighted one PR while the detail showed another).
        const selectionKey = `${locationKey}|${localRouteId ?? prNumberMatch ?? ""}`;
        const selectionChanged = lastAppliedSelectionKeyRef.current !== selectionKey;
        lastAppliedSelectionKeyRef.current = selectionKey;
        if ((hasExplicitPrSelection && selectionChanged) || locationChanged) {
          // A coordinate route is still valid without an ADE row. Keep the
          // route target alive, but only hand a local id to PrsContext once
          // that row is actually present.
          setSelectedPrId(localRouteId ?? prNumberMatch);
          setSelectedPrTarget((previous) => (
            prRouteTargetsEqual(previous, routeTarget) ? previous : routeTarget
          ));
          setSelectedDetailTab(routeState.detailTab);
          setGithubSort(routeState.githubSort);
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
  }, [active, location.hash, location.pathname, location.search, loading, prs, setSelectedPrId]);

  React.useEffect(() => {
    if (!active || location.pathname !== "/prs") return;
    const current = parsePrsRouteState({ search: location.search, hash: location.hash });
    const localSelectedPr = selectedPrId ? prs.find((pr) => pr.id === selectedPrId) ?? null : null;
    const target = selectedPrTarget ?? (localSelectedPr ? {
      prId: localSelectedPr.id,
      prNumber: localSelectedPr.githubPrNumber,
      repoOwner: localSelectedPr.repoOwner,
      repoName: localSelectedPr.repoName,
    } : null);
    // A route can carry only a local id while the matching ADE row already
    // provides coordinates. Enrich that partial target once, then serialize
    // the single resolved target consistently.
    const routeTarget = target && localSelectedPr ? {
      ...target,
      prNumber: target.prNumber ?? localSelectedPr.githubPrNumber,
      repoOwner: target.repoOwner ?? localSelectedPr.repoOwner,
      repoName: target.repoName ?? localSelectedPr.repoName,
    } : target;
    const hasPrNumber = routeTarget?.prNumber != null;
    const hasCoordinates = Boolean(routeTarget?.repoOwner && routeTarget.repoName && hasPrNumber);
    // Coordinate targets deliberately omit a missing local id. This keeps the
    // route addressable on the GitHub surface instead of sending a foreign or
    // not-yet-hydrated ADE id back through PrsContext.
    const routePrId = selectedPrId ?? (hasCoordinates ? null : routeTarget?.prId ?? null);
    // Preserve per-PR deep-link params (eventId/threadId/commitSha) as long as
    // the URL still points at the same selected PR, including coordinate-only
    // routes. When the PR changes, stale deep-link params get dropped.
    const sameCoordinateTarget = Boolean(
      routeTarget?.prNumber != null
      && current.prNumber != null
      && prRouteCoordinatesMatch(routeTarget, current),
    );
    const preserveDeepLinks = current.prId === routePrId || sameCoordinateTarget;
    const deepLinks = preserveDeepLinks
      ? { eventId: current.eventId, threadId: current.threadId, commitSha: current.commitSha }
      : { eventId: null, threadId: null, commitSha: null };
    const nextSearch = buildPrsRouteSearch({
      activeTab: "normal",
      selectedPrId: routePrId,
      selectedPrNumber: hasPrNumber ? routeTarget?.prNumber ?? null : null,
      repoOwner: hasCoordinates ? routeTarget?.repoOwner ?? null : null,
      repoName: hasCoordinates ? routeTarget?.repoName ?? null : null,
      detailTab: selectedDetailTab,
      githubSort,
      ...deepLinks,
    });
    if (location.search === nextSearch) return;
    void navigate({ pathname: location.pathname, search: nextSearch }, { replace: true });
  }, [
    active,
    prs,
    selectedPrId,
    selectedPrTarget,
    selectedDetailTab,
    githubSort,
    location.pathname,
    location.search,
    location.hash,
    navigate,
  ]);

  React.useEffect(() => {
    if (location.pathname !== "/prs") return;
    if (readCreatePrRouteRequest({ search: location.search, hash: window.location.hash })) return;
    const hash = location.hash ?? "";
    const hashRoute = hash.startsWith("#/prs") ? hash.slice(1) : null;
    writeStoredPrsRoute(hashRoute ?? `${location.pathname}${location.search}`, projectRoot);
  }, [location.hash, location.pathname, location.search, projectRoot]);

  const errorContent = error && prs.length === 0 ? (
    <EmptyState title="PRs" description={`Failed to load PRs: ${error}`}>
      <button
        type="button"
        onClick={() => void handleRefresh()}
        className="mt-4 flex items-center gap-2"
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
          boxShadow: `0 2px 8px rgba(139,92,246,0.30), inset 0 1px 0 ${fgTint(10)}`,
          transition: "all 150ms ease",
        }}
      >
        Retry
      </button>
    </EmptyState>
  ) : null;

  const loadingContent = !errorContent && loading && prs.length === 0 ? (
    <div className="flex flex-1 flex-col items-center justify-center gap-3">
      <style>{`
        @keyframes prs-shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        .prs-shimmer-bar {
          background: linear-gradient(90deg, rgba(167,139,250,0.04) 25%, rgba(167,139,250,0.10) 50%, rgba(167,139,250,0.04) 75%);
          background-size: 200% 100%;
          /* steps = 1.8s x 30; see ade-launch-rail-sheen in index.css. */
          animation: prs-shimmer 1.8s steps(54) infinite;
        }
      `}</style>
      <div className="prs-shimmer-bar h-4 w-44 rounded-md" />
      <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: "var(--color-muted-fg)" }}>
        Loading pull requests...
      </div>
    </div>
  ) : null;

  const createPrButton = (
    <button
      type="button"
      data-tour="prs.createBtn"
      aria-label="Create PR"
      title="Create PR"
      onClick={() => openCreatePr()}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-tone-[#C4B5FD] transition-colors duration-150 hover:bg-[rgba(167,139,250,0.14)] hover:text-tone-[#EDE9FE]"
      style={{ background: "rgba(167,139,250,0.08)", border: "1px solid rgba(167,139,250,0.16)" }}
    >
      <Plus size={13} weight="bold" />
    </button>
  );
  const listReady = !errorContent && !loadingContent;

  // The list column: an empty host that the GitHub view fills with its own
  // controls and list. Create PR sits at the end of its search row; while the
  // list is loading or failed, it has a row of its own.
  const listColumn = (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="prs-list-column" data-tour="prs.list">
      {listReady ? null : (
        <div className="flex shrink-0 items-center justify-end px-2.5 pb-2 pt-1">{createPrButton}</div>
      )}
      <div ref={setListHost} className="flex min-h-0 flex-1 flex-col" />
    </div>
  );

  return (
    <div className="flex h-full min-w-0" style={{ background: "var(--chat-canvas-bg)" }}>
      {hasProjectSidebar ? (
        <ProjectSidebarSlot active={active}>{listColumn}</ProjectSidebarSlot>
      ) : (
        <div className="flex h-full w-[320px] shrink-0 flex-col" style={{ borderRight: `1px solid ${fgTint(6)}` }}>
          {listColumn}
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <PrsListHostProvider host={listHost}>
          {errorContent ?? loadingContent ?? (
            <GitHubTab
              lanes={visibleLanes}
              mergeMethod={mergeMethod}
              selectedPrId={selectedPrId}
              selectedPrTarget={selectedPrTarget}
              onSelectPr={handleSelectPr}
              selectedDetailTab={selectedDetailTab}
              onDetailTabChange={setSelectedDetailTab}
              selectedSort={githubSort}
              onSortChange={handleGithubSortChange}
              onRefreshAll={handleRefresh}
              active={active}
              searchRowAction={createPrButton}
            />
          )}
        </PrsListHostProvider>
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
      <PRsPageInner active={active} />
    </PrsProvider>
  );
}

import React from "react";
import { CircleNotch, GitMerge, GithubLogo, XCircle } from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Group, Panel } from "react-resizable-panels";
import type {
  GitHubPrListItem,
  GitHubPrStack,
  PrSummary,
} from "../../../../shared/types";
import { EmptyState } from "../../ui/EmptyState";
import { ResizeGutter } from "../../ui/ResizeGutter";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  cardStyle,
  outlineButton,
  primaryButton,
} from "../../lanes/laneDesignTokens";
import { PrDetailPane } from "../detail/PrDetailPane";
import { GitHubPrSearchInput } from "../shared/GitHubPrSearchInput";
import { GitHubRepoSyncBar } from "../shared/GitHubRepoSyncBar";
import { GitHubStackInspector } from "../shared/GitHubStackInspector";
import { GitHubTabPrRow, PrListGroupHeaderRow } from "../shared/GitHubTabPrRow";
import {
  prListHeaderIndices,
  type PrListRow,
} from "../shared/prListGrouping";
import {
  GITHUB_TAB_VIRTUALIZE_AT,
  bucketForState,
  type GitHubFilter,
  type GitHubFilterCounts,
} from "./githubTabModel";
import { prRouteCoordinatesMatch } from "../prsRouteState";

const FILTER_ACCENTS: Record<GitHubFilter, string> = {
  open: "#60A5FA",
  closed: "#A1A1AA",
  merged: "#4ADE80",
};

const GITHUB_PR_LIST_WIDTH_KEY = "ade.prs.githubListWidth";
const GITHUB_PR_LIST_MIN_PX = 260;
const GITHUB_PR_LIST_MAX_PX = 560;
const GITHUB_PR_LIST_DEFAULT_PX = 380;

function readPersistedGithubPrListPx(): number {
  try {
    const raw = localStorage.getItem(GITHUB_PR_LIST_WIDTH_KEY);
    if (raw) {
      const value = Number(raw);
      if (Number.isFinite(value) && value >= GITHUB_PR_LIST_MIN_PX && value <= GITHUB_PR_LIST_MAX_PX) {
        return value;
      }
    }
  } catch {
    /* ignore */
  }
  return GITHUB_PR_LIST_DEFAULT_PX;
}

function persistGithubPrListPx(px: number): void {
  try {
    localStorage.setItem(GITHUB_PR_LIST_WIDTH_KEY, String(Math.round(px)));
  } catch {
    /* ignore */
  }
}

type GitHubTabViewChrome = {
  relocated: boolean;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  repoLabel: string;
  syncing: boolean;
  syncedAt: string | null;
  onSync: () => void;
  error: string | null;
  onConnectGitHub: () => void;
};

type GitHubTabViewList = {
  parentRef: React.RefObject<HTMLDivElement>;
  filter: GitHubFilter;
  filterCounts: GitHubFilterCounts;
  loading: boolean;
  loadingFilter: GitHubFilter | null;
  loadingOlderHistory: boolean;
  showLoadingIndicator: boolean;
  hasSnapshot: boolean;
  filteredItems: GitHubPrListItem[];
  rows: PrListRow[];
  selectedItemId: string | null;
  prsByIdMap: Map<string, PrSummary>;
  canLoadOlderHistory: boolean;
  onFilterChange: (filter: GitHubFilter) => void;
  onSelect: (item: GitHubPrListItem) => void;
  onHydrationItemsChange: (items: GitHubPrListItem[]) => void;
  onLoadOlderHistory: () => void;
};

type GitHubTabViewDetail = {
  selectedItem: GitHubPrListItem | null;
  selectedBucketMismatch: boolean;
  selectedStack: GitHubPrStack | null;
  displayedItems: GitHubPrListItem[];
  paneProps: React.ComponentProps<typeof PrDetailPane> | null;
  onSelect: (item: GitHubPrListItem) => void;
  onSync: () => void;
  onAddStackPullRequests: (pullRequests: number[]) => Promise<void>;
  onUnstack: () => Promise<void>;
  onFilterChange: (filter: GitHubFilter) => void;
};

export type GitHubTabViewProps = {
  chrome: GitHubTabViewChrome;
  list: GitHubTabViewList;
  detail: GitHubTabViewDetail;
};

export function GitHubTabView({ chrome, list, detail }: GitHubTabViewProps) {
  const selectedItem = detail.selectedItem;
  const selectedStack = detail.selectedStack;
  const defaultListPx = React.useMemo(() => readPersistedGithubPrListPx(), []);

  if (chrome.error && !list.hasSnapshot) {
    return (
      <EmptyState title="GitHub" description={chrome.error}>
        <button
          type="button"
          onClick={chrome.onConnectGitHub}
          style={primaryButton({ marginTop: 16 })}
        >
          <GithubLogo size={14} weight="fill" />
          Connect GitHub
        </button>
      </EmptyState>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {!chrome.relocated ? (
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 16px",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          background: "rgba(255,255,255,0.01)",
        }}>
          <GitHubPrSearchInput value={chrome.searchQuery} onChange={chrome.onSearchQueryChange} />
          <GitHubRepoSyncBar
            repoLabel={chrome.repoLabel}
            syncing={chrome.syncing}
            syncedAt={chrome.syncedAt}
            onSync={chrome.onSync}
          />
        </div>
      ) : null}

      {chrome.error ? (
        <div style={{
          padding: "10px 16px",
          borderBottom: "1px solid rgba(239,68,68,0.2)",
          background: "rgba(239,68,68,0.06)",
          color: COLORS.danger,
          fontFamily: SANS_FONT,
          fontSize: 12,
          borderRadius: 0,
        }}>
          {chrome.error}
        </div>
      ) : null}

      <div style={{ display: "flex", minHeight: 0, flex: 1 }}>
        <Group id="github-pr-layout" orientation="horizontal" className="flex h-full min-h-0 w-full">
          <Panel
            id="github-pr-list"
            data-tour="prs.list"
            defaultSize={defaultListPx}
            minSize={GITHUB_PR_LIST_MIN_PX}
            maxSize={GITHUB_PR_LIST_MAX_PX}
            onResize={(size) => persistGithubPrListPx(size.inPixels)}
            className="min-h-0 min-w-0"
            style={{ overflow: "hidden", borderRight: "1px solid rgba(255,255,255,0.06)" }}
          >
            <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
              <div style={{
                display: "flex",
                alignItems: "center",
                gap: 0,
                padding: "0 16px",
                flexShrink: 0,
                borderBottom: "1px solid rgba(255,255,255,0.06)",
                background: "rgba(255,255,255,0.01)",
              }}>
                {(["open", "merged", "closed"] as GitHubFilter[]).map((state) => {
                  const active = list.filter === state;
                  const accent = FILTER_ACCENTS[state];
                  const count = list.filterCounts[state];
                  const icon = state === "merged" ? <GitMerge size={12} weight="bold" /> : null;
                  const tabLoading = active && (
                    list.loading
                    || chrome.syncing
                    || list.loadingFilter === state
                    || list.loadingOlderHistory
                  );
                  return (
                    <button
                      key={state}
                      type="button"
                      onClick={() => list.onFilterChange(state)}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 5,
                        height: 36,
                        padding: "0 14px",
                        fontSize: 12,
                        fontWeight: active ? 600 : 400,
                        fontFamily: SANS_FONT,
                        color: active ? accent : COLORS.textMuted,
                        background: "transparent",
                        border: "none",
                        borderBottom: active ? `2px solid ${accent}` : "2px solid transparent",
                        cursor: "pointer",
                        textTransform: "capitalize",
                        transition: "all 150ms ease",
                      }}
                    >
                      {icon}
                      {state}
                      {tabLoading ? (
                        <CircleNotch
                          size={12}
                          className="animate-spin"
                          weight="bold"
                          aria-label={`Loading ${state} pull requests`}
                          style={{ color: active ? accent : COLORS.accent, opacity: 0.9 }}
                        />
                      ) : (
                        <span style={{
                          fontFamily: MONO_FONT,
                          fontSize: 10,
                          fontWeight: 600,
                          color: active ? accent : COLORS.textDim,
                          opacity: active ? 0.8 : 0.6,
                        }}>
                          {count}
                        </span>
                      )}
                    </button>
                  );
                })}
                <div style={{ flex: 1 }} />
                {list.showLoadingIndicator ? (
                  <span
                    role="status"
                    aria-label="Loading pull requests"
                    title="Loading pull requests"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 24,
                      height: 24,
                      color: COLORS.accent,
                      opacity: 0.9,
                    }}
                  >
                    <CircleNotch size={14} className="animate-spin" weight="bold" />
                  </span>
                ) : null}
              </div>
              <div ref={list.parentRef} style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
                {list.filteredItems.length === 0 ? (
                  <div style={{ padding: 20 }}>
                    <EmptyState
                      title={list.loading && !list.hasSnapshot ? "Preparing pull requests" : "No pull requests"}
                      description={list.loading && !list.hasSnapshot ? "ADE is syncing GitHub in the background." : "No pull requests match the current filters."}
                    />
                  </div>
                ) : list.filteredItems.length > GITHUB_TAB_VIRTUALIZE_AT ? (
                  <GitHubTabVirtualList
                    parentRef={list.parentRef}
                    rows={list.rows}
                    selectedItemId={list.selectedItemId}
                    prsByIdMap={list.prsByIdMap}
                    onSelect={list.onSelect}
                    onHydrationItemsChange={list.onHydrationItemsChange}
                  />
                ) : (
                  list.rows.map((row) => (
                    row.kind === "header" ? (
                      <PrListGroupHeaderRow key={`header-${row.id}`} header={row} />
                    ) : (
                      <GitHubTabPrRow
                        key={row.item.id}
                        item={row.item}
                        selected={row.item.id === list.selectedItemId}
                        linkedPr={row.item.linkedPrId ? list.prsByIdMap.get(row.item.linkedPrId) ?? null : null}
                        onSelect={list.onSelect}
                      />
                    )
                  ))
                )}
                {list.canLoadOlderHistory ? (
                  <div style={{ padding: "12px 14px 16px", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                    <button
                      type="button"
                      aria-label="Load older pull requests"
                      disabled={list.loadingOlderHistory}
                      onClick={list.onLoadOlderHistory}
                      style={{
                        ...outlineButton({ height: 32, width: "100%", opacity: list.loadingOlderHistory ? 0.6 : 1 }),
                        justifyContent: "center",
                      }}
                    >
                      {list.loadingOlderHistory ? "Loading older..." : "Load older PRs"}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </Panel>
          <ResizeGutter orientation="vertical" thin narrow />
          <Panel
            id="github-pr-detail"
            data-tour="prs.detailDrawer"
            minSize="30%"
            className="min-h-0 min-w-0"
            style={{ overflow: "hidden" }}
          >
            {selectedItem && detail.paneProps ? (
              <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
                {detail.selectedBucketMismatch ? (
                  <div style={{ padding: "10px 12px 0", flexShrink: 0 }}>
                    <PrBucketTransitionBanner
                      state={selectedItem.state}
                      onShow={() => detail.onFilterChange(bucketForState(selectedItem.state))}
                    />
                  </div>
                ) : null}
                {selectedStack ? (
                  <GitHubStackInspector
                    stack={selectedStack}
                    items={detail.displayedItems.filter(
                      (item) => prRouteCoordinatesMatch(
                        { prNumber: item.githubPrNumber, repoOwner: item.repoOwner, repoName: item.repoName },
                        { prNumber: null, repoOwner: selectedStack.repoOwner, repoName: selectedStack.repoName },
                      ),
                    )}
                    selectedPrNumber={selectedItem.githubPrNumber}
                    syncing={chrome.syncing}
                    onSelectPr={detail.onSelect}
                    onOpenGitHub={() => {
                      void window.ade.app.openExternal(selectedItem.githubUrl);
                    }}
                    onSync={detail.onSync}
                    onAddPullRequests={detail.onAddStackPullRequests}
                    onUnstack={detail.onUnstack}
                  />
                ) : null}
                <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                  <PrDetailPane key={detail.paneProps.pr.id} {...detail.paneProps} />
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
                <EmptyState
                  icon={GithubLogo}
                  iconSize={64}
                  title="No pull request selected"
                  description="Choose a GitHub pull request to inspect details."
                />
              </div>
            )}
          </Panel>
        </Group>
      </div>
    </div>
  );
}

function PrBucketTransitionBanner({
  state,
  onShow,
}: {
  state: GitHubPrListItem["state"];
  onShow: () => void;
}) {
  const isMerged = state === "merged";
  const label = isMerged ? "Merged" : "Closed";
  const accent = isMerged ? COLORS.success : COLORS.danger;
  return (
    <div style={{ ...cardStyle({ padding: 0, overflow: "hidden" }), flexShrink: 0, borderColor: `color-mix(in srgb, ${accent} 30%, transparent)` }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: "8px 12px",
        background: `color-mix(in srgb, ${accent} 7%, transparent)`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {isMerged ? (
            <GitMerge size={14} weight="bold" style={{ color: accent, flexShrink: 0 }} />
          ) : (
            <XCircle size={14} weight="fill" style={{ color: accent, flexShrink: 0 }} />
          )}
          <span style={{ fontFamily: SANS_FONT, fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }}>
            This PR is now {label}
          </span>
        </div>
        <button
          type="button"
          onClick={onShow}
          style={{ ...outlineButton({ height: 24, padding: "0 10px", fontSize: 11 }), color: COLORS.textMuted, flexShrink: 0 }}
        >
          Show in {label}
        </button>
      </div>
    </div>
  );
}

function GitHubTabVirtualList({
  parentRef,
  rows,
  selectedItemId,
  prsByIdMap,
  onSelect,
  onHydrationItemsChange,
}: {
  parentRef: React.RefObject<HTMLDivElement>;
  rows: PrListRow[];
  selectedItemId: string | null;
  prsByIdMap: Map<string, PrSummary>;
  onSelect: (item: GitHubPrListItem) => void;
  onHydrationItemsChange: (items: GitHubPrListItem[]) => void;
}) {
  const headerIndices = React.useMemo(() => prListHeaderIndices(rows), [rows]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (rows[index]?.kind === "header" ? 30 : 108),
    overscan: 6,
    rangeExtractor: React.useCallback(
      (range: { startIndex: number; endIndex: number; overscan: number; count: number }) => {
        const pinned = activeHeaderFor(headerIndices, range.startIndex);
        const start = Math.max(0, range.startIndex - range.overscan);
        const end = Math.min(range.count - 1, range.endIndex + range.overscan);
        const indices = new Set<number>();
        if (pinned != null) indices.add(pinned);
        for (let index = start; index <= end; index += 1) indices.add(index);
        return [...indices].sort((a, b) => a - b);
      },
      [headerIndices],
    ),
  });

  const virtualItems = virtualizer.getVirtualItems();
  const activeHeaderIndex = activeHeaderFor(headerIndices, virtualizer.range?.startIndex ?? 0);

  React.useEffect(() => {
    onHydrationItemsChange(
      virtualItems
        .map((virtualRow) => rows[virtualRow.index])
        .filter((row): row is Extract<PrListRow, { kind: "item" }> => row?.kind === "item")
        .map((row) => row.item),
    );
  }, [rows, onHydrationItemsChange, virtualItems]);

  return (
    <div
      data-testid="pr-github-list-virtual"
      style={{ height: virtualizer.getTotalSize(), position: "relative" }}
    >
      {virtualItems.map((virtualRow) => {
        const row = rows[virtualRow.index]!;
        const pinned = row.kind === "header" && virtualRow.index === activeHeaderIndex;
        return (
          <div
            key={row.kind === "header" ? `header-${row.id}` : row.item.id}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            style={{
              position: pinned ? "sticky" : "absolute",
              top: 0,
              left: 0,
              width: "100%",
              zIndex: pinned ? 2 : undefined,
              ...(pinned ? {} : { transform: `translateY(${virtualRow.start}px)` }),
            }}
          >
            {row.kind === "header" ? (
              <PrListGroupHeaderRow header={row} />
            ) : (
              <GitHubTabPrRow
                item={row.item}
                selected={row.item.id === selectedItemId}
                linkedPr={row.item.linkedPrId ? prsByIdMap.get(row.item.linkedPrId) ?? null : null}
                onSelect={onSelect}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function activeHeaderFor(headerIndices: number[], startIndex: number): number | null {
  let active: number | null = null;
  for (const index of headerIndices) {
    if (index > startIndex) break;
    active = index;
  }
  return active;
}

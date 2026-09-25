import React from "react";
import { CircleNotch, GitMerge, GithubLogo, HandPalm } from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  GitHubPrListItem,
  GitHubPrStack,
  PrSummary,
} from "../../../../shared/types";
import { EmptyState } from "../../ui/EmptyState";
import { Banner } from "../../ui/notice";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
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
import type { GitHubTabSort } from "./prBlockedSort";
import { prRouteCoordinatesMatch } from "../prsRouteState";
import { PRS_LIST_ROOT_CLASS, PrsListPortal, usePrsListHost } from "../shared/PrsListHost";

const FILTER_ACCENTS: Record<GitHubFilter, string> = {
  open: "#60A5FA",
  closed: "#A1A1AA",
  merged: "#4ADE80",
};

/** Width of the list column when there is no project sidebar to hold it. */
const INLINE_LIST_WIDTH_PX = 340;

type GitHubTabViewChrome = {
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
  sort: GitHubTabSort;
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
  onSortChange: (sort: GitHubTabSort) => void;
  onSelect: (item: GitHubPrListItem) => void;
  onHydrationItemsChange: (items: GitHubPrListItem[]) => void;
  onLoadOlderHistory: () => void;
  /** A right-click menu action changed a PR; refresh it. */
  onRowActionDone?: (prId: string) => void;
  onRowActionError?: (message: string) => void;
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
  const listHost = usePrsListHost();
  const connectNeeded = Boolean(chrome.error && !list.hasSnapshot);

  const detailContent = connectNeeded ? (
    <EmptyState title="GitHub" description={chrome.error ?? undefined}>
      <button
        type="button"
        onClick={chrome.onConnectGitHub}
        style={primaryButton({ marginTop: 16 })}
      >
        <GithubLogo size={14} weight="fill" />
        Connect GitHub
      </button>
    </EmptyState>
  ) : (
    <GitHubTabDetail chrome={chrome} detail={detail} />
  );
  const listColumn = connectNeeded ? null : <GitHubTabListColumn chrome={chrome} list={list} />;

  // No PRs page above (tests): keep a plain list column on the left.
  if (listHost === undefined) {
    return (
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        {listColumn ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              width: INLINE_LIST_WIDTH_PX,
              flexShrink: 0,
              minHeight: 0,
              borderRight: "1px solid rgba(255,255,255,0.06)",
            }}
          >
            {listColumn}
          </div>
        ) : null}
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 }}>
          {detailContent}
        </div>
      </div>
    );
  }

  return (
    <>
      {listColumn ? <PrsListPortal>{listColumn}</PrsListPortal> : null}
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 }}>
        {detailContent}
      </div>
    </>
  );
}

/**
 * The list side: search, the open/merged/closed filter, the rows, and the
 * repo sync line at the bottom.
 */
function GitHubTabListColumn({
  chrome,
  list,
}: {
  chrome: GitHubTabViewChrome;
  list: GitHubTabViewList;
}) {
  return (
    <div className={PRS_LIST_ROOT_CLASS}>
      <div style={{ display: "flex", padding: "0 10px 6px", flexShrink: 0 }}>
        <GitHubPrSearchInput value={chrome.searchQuery} onChange={chrome.onSearchQueryChange} />
      </div>
      <div
        role="group"
        aria-label="Pull request state"
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0 6px",
          flexShrink: 0,
          borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        {(["open", "merged", "closed"] as GitHubFilter[]).map((state) => {
          const active = list.filter === state;
          const accent = FILTER_ACCENTS[state];
          const count = list.filterCounts[state];
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
              aria-pressed={active}
              onClick={() => list.onFilterChange(state)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
                height: 32,
                padding: "0 8px",
                fontSize: 12,
                fontWeight: active ? 600 : 400,
                fontFamily: SANS_FONT,
                color: active ? accent : COLORS.textMuted,
                background: "transparent",
                border: "none",
                borderBottom: active ? `2px solid ${accent}` : "2px solid transparent",
                cursor: "pointer",
                textTransform: "capitalize",
                whiteSpace: "nowrap",
                transition: "all 150ms ease",
              }}
            >
              {state}
              {tabLoading ? (
                <CircleNotch
                  size={11}
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
        <button
          type="button"
          aria-pressed={list.sort === "blocked"}
          aria-label="Sort pull requests by blocked on me"
          title={list.sort === "blocked"
            ? "Sorted by what is blocked on you — click for recently updated"
            : "Sort by what is blocked on you"}
          onClick={() => list.onSortChange(list.sort === "blocked" ? "updated" : "blocked")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            height: 22,
            padding: "0 7px",
            marginRight: 4,
            borderRadius: 6,
            border: `1px solid ${list.sort === "blocked" ? `color-mix(in srgb, ${COLORS.warning} 40%, transparent)` : "rgba(255,255,255,0.08)"}`,
            background: list.sort === "blocked" ? `color-mix(in srgb, ${COLORS.warning} 14%, transparent)` : "transparent",
            color: list.sort === "blocked" ? COLORS.warning : COLORS.textMuted,
            fontFamily: SANS_FONT,
            fontSize: 10.5,
            fontWeight: 600,
            cursor: "pointer",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          <HandPalm size={11} weight={list.sort === "blocked" ? "fill" : "regular"} aria-hidden />
          Blocked
        </button>
        {list.showLoadingIndicator ? (
          <span
            role="status"
            aria-label="Loading pull requests"
            title="Loading pull requests"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              flexShrink: 0,
              color: COLORS.accent,
              opacity: 0.9,
            }}
          >
            <CircleNotch size={13} className="animate-spin" weight="bold" />
          </span>
        ) : null}
      </div>

      {chrome.error ? (
        <Banner
          layout="inline"
          style={{ margin: "6px 8px", flexShrink: 0 }}
          model={{ id: "github-tab-error", tone: "error", title: chrome.error }}
        />
      ) : null}

      <div ref={list.parentRef} style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {list.filteredItems.length === 0 ? (
          <div style={{
            padding: "28px 16px",
            textAlign: "center",
            fontFamily: SANS_FONT,
            fontSize: 12,
            color: COLORS.textMuted,
          }}>
            {list.loading && !list.hasSnapshot ? "Loading pull requests..." : "No pull requests"}
          </div>
        ) : list.filteredItems.length > GITHUB_TAB_VIRTUALIZE_AT ? (
          <GitHubTabVirtualList
            parentRef={list.parentRef}
            rows={list.rows}
            selectedItemId={list.selectedItemId}
            prsByIdMap={list.prsByIdMap}
            onSelect={list.onSelect}
            onRowActionDone={list.onRowActionDone}
            onRowActionError={list.onRowActionError}
            onHydrationItemsChange={list.onHydrationItemsChange}
          />
        ) : (
          <GitHubTabPlainList
            parentRef={list.parentRef}
            rows={list.rows}
            selectedItemId={list.selectedItemId}
            prsByIdMap={list.prsByIdMap}
            onSelect={list.onSelect}
            onRowActionDone={list.onRowActionDone}
            onRowActionError={list.onRowActionError}
          />
        )}
        {list.canLoadOlderHistory ? (
          <div style={{ padding: "12px 12px 16px", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
            <button
              type="button"
              aria-label="Load older pull requests"
              disabled={list.loadingOlderHistory}
              onClick={list.onLoadOlderHistory}
              style={{
                ...outlineButton({ height: 30, width: "100%", opacity: list.loadingOlderHistory ? 0.6 : 1 }),
                justifyContent: "center",
              }}
            >
              {list.loadingOlderHistory ? "Loading older..." : "Load older PRs"}
            </button>
          </div>
        ) : null}
      </div>

      {chrome.repoLabel ? (
        <div style={{ flexShrink: 0, padding: "4px 8px 4px 12px", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
          <GitHubRepoSyncBar
            repoLabel={chrome.repoLabel}
            syncing={chrome.syncing}
            syncedAt={chrome.syncedAt}
            onSync={chrome.onSync}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The detail side: the selected PR, full width, or one quiet line. */
function GitHubTabDetail({
  chrome,
  detail,
}: {
  chrome: GitHubTabViewChrome;
  detail: GitHubTabViewDetail;
}) {
  const selectedItem = detail.selectedItem;
  const selectedStack = detail.selectedStack;
  if (!selectedItem || !detail.paneProps) {
    return (
      <div
        data-tour="prs.detailDrawer"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flex: 1,
          minHeight: 0,
          fontFamily: SANS_FONT,
          fontSize: 12,
          color: COLORS.textDim,
        }}
      >
        Select a pull request
      </div>
    );
  }
  return (
    <div data-tour="prs.detailDrawer" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
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
  );
}

/**
 * Short lists render every row. When the selection changes (a click, or a
 * deep link), bring the selected row into view once if it is off screen.
 */
function GitHubTabPlainList({
  parentRef,
  rows,
  selectedItemId,
  prsByIdMap,
  onSelect,
  onRowActionDone,
  onRowActionError,
}: {
  parentRef: React.RefObject<HTMLDivElement>;
  rows: PrListRow[];
  selectedItemId: string | null;
  prsByIdMap: Map<string, PrSummary>;
  onSelect: (item: GitHubPrListItem) => void;
  onRowActionDone?: (prId: string) => void;
  onRowActionError?: (message: string) => void;
}) {
  const scrolledToIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!selectedItemId || scrolledToIdRef.current === selectedItemId) return;
    const rowEls = parentRef.current?.querySelectorAll<HTMLElement>("[data-pr-row-id]") ?? [];
    const row = Array.from(rowEls).find((el) => el.dataset.prRowId === selectedItemId);
    if (!row) return;
    scrolledToIdRef.current = selectedItemId;
    row.scrollIntoView?.({ block: "nearest" });
  }, [parentRef, rows, selectedItemId]);

  return (
    <>
      {rows.map((row) => (
        row.kind === "header" ? (
          <PrListGroupHeaderRow key={`header-${row.id}`} header={row} />
        ) : (
          <div key={row.item.id} data-pr-row-id={row.item.id}>
            <GitHubTabPrRow
              item={row.item}
              selected={row.item.id === selectedItemId}
              linkedPr={row.item.linkedPrId ? prsByIdMap.get(row.item.linkedPrId) ?? null : null}
              onSelect={onSelect}
              onActionDone={onRowActionDone}
              onActionError={onRowActionError}
            />
          </div>
        )
      ))}
    </>
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
  return (
    <Banner
      layout="inline"
      style={{ margin: "10px 12px 0", flexShrink: 0 }}
      model={{
        id: `pr-bucket-transition:${state}`,
        tone: isMerged ? "success" : "error",
        icon: isMerged ? <GitMerge size={13} weight="bold" /> : undefined,
        title: `This PR is now ${label}`,
        actions: [{ label: `Show in ${label}`, variant: "secondary", onClick: onShow }],
      }}
    />
  );
}

function GitHubTabVirtualList({
  parentRef,
  rows,
  selectedItemId,
  prsByIdMap,
  onSelect,
  onHydrationItemsChange,
  onRowActionDone,
  onRowActionError,
}: {
  parentRef: React.RefObject<HTMLDivElement>;
  rows: PrListRow[];
  selectedItemId: string | null;
  prsByIdMap: Map<string, PrSummary>;
  onSelect: (item: GitHubPrListItem) => void;
  onHydrationItemsChange: (items: GitHubPrListItem[]) => void;
  onRowActionDone?: (prId: string) => void;
  onRowActionError?: (message: string) => void;
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

  // Bring the selected row into view once per selection, so a deep link to a
  // PR far down the list lands on it. The rows may arrive after the selection,
  // so wait for them; later row updates must not pull the list back.
  const scrolledToIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!selectedItemId || scrolledToIdRef.current === selectedItemId) return;
    const index = rows.findIndex((row) => row.kind === "item" && row.item.id === selectedItemId);
    if (index < 0) return;
    scrolledToIdRef.current = selectedItemId;
    const frame = requestAnimationFrame(() => virtualizer.scrollToIndex(index, { align: "auto" }));
    return () => cancelAnimationFrame(frame);
  }, [rows, selectedItemId, virtualizer]);

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
                onActionDone={onRowActionDone}
                onActionError={onRowActionError}
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

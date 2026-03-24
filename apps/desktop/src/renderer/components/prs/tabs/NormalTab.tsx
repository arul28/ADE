import React from "react";
import {
  MagnifyingGlass, Funnel, XCircle,
} from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type {
  MergeMethod, PrMergeContext, PrWithConflicts, LaneSummary,
} from "../../../../shared/types";
import { EmptyState } from "../../ui/EmptyState";
import { PrConflictBadge } from "../PrConflictBadge";
import { PrDetailPane } from "../detail/PrDetailPane";
import { usePrs } from "../state/PrsContext";
import { IntegrationPrContextPanel } from "../shared/IntegrationPrContextPanel";
import { COLORS, MONO_FONT, LABEL_STYLE, outlineButton } from "../../lanes/laneDesignTokens";
import { getPrChecksBadge, getPrReviewsBadge, getPrStateBadge, InlinePrBadge } from "../shared/prVisuals";
import { formatTimeAgoCompact } from "../shared/prFormatters";

function statusDotColor(state: string): string {
  if (state === "open") return COLORS.success;
  if (state === "merged") return COLORS.accent;
  if (state === "draft") return COLORS.warning;
  return COLORS.textMuted;
}

/* ---- Filter types ---- */
type FilterState = {
  search: string;
  status: "all" | "open" | "closed" | "merged" | "draft";
  checks: "all" | "passing" | "failing" | "pending";
  review: "all" | "approved" | "changes_requested" | "requested" | "none";
};

const INITIAL_FILTERS: FilterState = { search: "", status: "all", checks: "all", review: "all" };

/* ---- Props ---- */
type NormalTabProps = {
  prs: PrWithConflicts[];
  lanes: LaneSummary[];
  mergeContextByPrId: Record<string, PrMergeContext>;
  mergeMethod: MergeMethod;
  selectedPrId: string | null;
  onSelectPr: (id: string | null) => void;
  onRefresh: () => Promise<void>;
};

export function NormalTab({ prs, lanes, mergeContextByPrId, mergeMethod, selectedPrId, onSelectPr, onRefresh }: NormalTabProps) {
  const navigate = useNavigate();
  const laneById = React.useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);
  const {
    detailStatus, detailChecks, detailReviews, detailComments, detailBusy,
    setActiveTab,
    setSelectedRebaseItemId,
  } = usePrs();

  const [filters, setFilters] = React.useState<FilterState>(INITIAL_FILTERS);
  const [showFilters, setShowFilters] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement>(null);

  const selectedPr = React.useMemo(() => prs.find((p) => p.id === selectedPrId) ?? null, [prs, selectedPrId]);
  const selectedMergeContext = React.useMemo(
    () => (selectedPr ? mergeContextByPrId[selectedPr.id] ?? null : null),
    [mergeContextByPrId, selectedPr],
  );
  const showIntegrationContext = Boolean(
    selectedPr
    && selectedMergeContext?.groupType === "integration"
    && selectedMergeContext.integrationLaneId,
  );

  // Auto-select first PR
  React.useEffect(() => {
    if (prs.length === 0 && selectedPrId === null) return;
    if (selectedPrId && prs.some((p) => p.id === selectedPrId)) return;
    onSelectPr(prs[0]?.id ?? null);
  }, [prs, selectedPrId, onSelectPr]);

  // Filter PRs
  const filteredPrs = React.useMemo(() => {
    return prs.filter((pr) => {
      if (filters.search) {
        const q = filters.search.toLowerCase();
        const laneName = laneById.get(pr.laneId)?.name ?? "";
        if (!pr.title.toLowerCase().includes(q) && !`#${pr.githubPrNumber}`.includes(q) && !laneName.toLowerCase().includes(q) && !pr.headBranch.toLowerCase().includes(q)) {
          return false;
        }
      }
      if (filters.status !== "all" && pr.state !== filters.status) return false;
      if (filters.checks !== "all" && pr.checksStatus !== filters.checks) return false;
      if (filters.review !== "all" && pr.reviewStatus !== filters.review) return false;
      return true;
    });
  }, [prs, filters, laneById]);

  // Keyboard shortcuts
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't capture when typing in inputs
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        const idx = filteredPrs.findIndex((p) => p.id === selectedPrId);
        if (idx < filteredPrs.length - 1) onSelectPr(filteredPrs[idx + 1].id);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = filteredPrs.findIndex((p) => p.id === selectedPrId);
        if (idx > 0) onSelectPr(filteredPrs[idx - 1].id);
      } else if (e.key === "/" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setShowFilters(true);
        // Focus search input
        setTimeout(() => {
          const searchInput = document.querySelector('[data-pr-search]') as HTMLInputElement;
          searchInput?.focus();
        }, 50);
      } else if (e.key === "Escape") {
        if (showFilters) {
          setShowFilters(false);
          setFilters(INITIAL_FILTERS);
        }
      } else if (e.key === "r" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        void onRefresh();
      } else if (e.key === "o" && !e.metaKey && !e.ctrlKey && selectedPr) {
        e.preventDefault();
        void window.ade.prs.openInGitHub(selectedPr.id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [filteredPrs, selectedPrId, selectedPr, showFilters, onSelectPr, onRefresh]);

  const hasActiveFilters = filters.search || filters.status !== "all" || filters.checks !== "all" || filters.review !== "all";

  return (
    <div style={{ display: "flex", height: "100%", background: COLORS.pageBg }}>
      {/* ==== LEFT: PR LIST ==== */}
      <div style={{ width: 360, minWidth: 280, maxWidth: 500, borderRight: `1px solid ${COLORS.border}`, display: "flex", flexDirection: "column", flexShrink: 0 }}>
        {/* Search & Filter bar */}
        <div style={{ padding: "10px 12px", borderBottom: `1px solid ${COLORS.border}`, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, height: 30, padding: "0 10px", background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
              <MagnifyingGlass size={13} style={{ color: COLORS.textMuted, flexShrink: 0 }} />
              <input
                data-pr-search
                value={filters.search}
                onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
                placeholder="Search PRs... (press /)"
                style={{ flex: 1, background: "transparent", border: "none", outline: "none", fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textPrimary }}
              />
              {filters.search && (
                <button type="button" onClick={() => setFilters((f) => ({ ...f, search: "" }))} style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.textMuted, padding: 0 }}>
                  <XCircle size={12} />
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => setShowFilters(!showFilters)}
              style={{
                ...outlineButton({ height: 30, padding: "0 8px" }),
                background: hasActiveFilters ? `${COLORS.accent}18` : "transparent",
                borderColor: hasActiveFilters ? COLORS.accent : COLORS.border,
                color: hasActiveFilters ? COLORS.accent : COLORS.textMuted,
              }}
              title="Toggle filters"
            >
              <Funnel size={14} weight={hasActiveFilters ? "fill" : "regular"} />
            </button>
          </div>

          {/* Filter dropdowns */}
          {showFilters && (
            <div style={{ display: "flex", gap: 6 }}>
              <FilterSelect
                label="Status"
                value={filters.status}
                options={[{ value: "all", label: "All" }, { value: "open", label: "Open" }, { value: "draft", label: "Draft" }, { value: "merged", label: "Merged" }, { value: "closed", label: "Closed" }]}
                onChange={(v) => setFilters((f) => ({ ...f, status: v as FilterState["status"] }))}
              />
              <FilterSelect
                label="CI"
                value={filters.checks}
                options={[{ value: "all", label: "All" }, { value: "passing", label: "Pass" }, { value: "failing", label: "Fail" }, { value: "pending", label: "Pend" }]}
                onChange={(v) => setFilters((f) => ({ ...f, checks: v as FilterState["checks"] }))}
              />
              <FilterSelect
                label="Review"
                value={filters.review}
                options={[{ value: "all", label: "All" }, { value: "approved", label: "Approved" }, { value: "changes_requested", label: "Changes" }, { value: "requested", label: "Requested" }, { value: "none", label: "None" }]}
                onChange={(v) => setFilters((f) => ({ ...f, review: v as FilterState["review"] }))}
              />
              {hasActiveFilters && (
                <button type="button" onClick={() => setFilters(INITIAL_FILTERS)} style={{ ...outlineButton({ height: 26, padding: "0 6px", fontSize: 9 }), color: COLORS.accent }}>
                  CLEAR
                </button>
              )}
            </div>
          )}
        </div>

        {/* PR count */}
        <div style={{ padding: "8px 12px", borderBottom: `1px solid ${COLORS.border}` }}>
          <span style={LABEL_STYLE}>
            {filteredPrs.length === prs.length ? `${prs.length} PRS` : `${filteredPrs.length} / ${prs.length} PRS`}
          </span>
        </div>

        {/* PR list */}
        <div ref={listRef} style={{ flex: 1, overflow: "auto" }}>
          {filteredPrs.length === 0 ? (
            <div style={{ padding: 20 }}>
              <EmptyState title={hasActiveFilters ? "No matching PRs" : "No PRs"} description={hasActiveFilters ? "Try adjusting your filters." : "Create a PR from a lane or link an existing GitHub PR."} />
            </div>
          ) : (
            filteredPrs.map((pr) => {
              const isSelected = pr.id === selectedPrId;
              const laneName = laneById.get(pr.laneId)?.name ?? pr.laneId;
              const sc = getPrStateBadge(pr.state);
              const cc = getPrChecksBadge(pr.checksStatus);
              const rc = getPrReviewsBadge(pr.reviewStatus);

              return (
                <button
                  key={pr.id}
                  type="button"
                  onClick={() => onSelectPr(pr.id)}
                  style={{
                    display: "flex", width: "100%", alignItems: "flex-start", gap: 10,
                    padding: "12px 14px", textAlign: "left", border: "none", cursor: "pointer",
                    borderLeft: isSelected ? `3px solid ${COLORS.accent}` : "3px solid transparent",
                    background: isSelected ? `${COLORS.accent}12` : "transparent",
                    borderBottom: `1px solid ${COLORS.border}`, transition: "background 100ms",
                  }}
                  onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = COLORS.hoverBg; }}
                  onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
                >
                  {/* Status dot */}
                  <div style={{
                    width: 8, height: 8, borderRadius: "50%", marginTop: 5, flexShrink: 0,
                    background: statusDotColor(pr.state),
                  }} />

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>#{pr.githubPrNumber}</span>
                      <span style={{ fontWeight: 600, fontSize: 12, color: COLORS.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                        {pr.title}
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                      <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                        {laneName}
                      </span>
                      <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim, flexShrink: 0 }}>
                        {formatTimeAgoCompact(pr.updatedAt)}
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 6, flexWrap: "wrap" }}>
                      <PrConflictBadge riskLevel={pr.conflictAnalysis?.riskLevel ?? null} overlappingFileCount={pr.conflictAnalysis?.overlapCount} />
                      <InlinePrBadge {...cc} />
                      <InlinePrBadge {...rc} />
                      <InlinePrBadge {...sc} />
                      {/* Diff stats mini */}
                      <span style={{ fontFamily: MONO_FONT, fontSize: 9, color: COLORS.success }}>+{pr.additions}</span>
                      <span style={{ fontFamily: MONO_FONT, fontSize: 9, color: COLORS.danger }}>-{pr.deletions}</span>
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Keyboard shortcut hints */}
        <div style={{ padding: "6px 12px", borderTop: `1px solid ${COLORS.border}`, display: "flex", gap: 12 }}>
          <KbdHint keys="j/k" label="navigate" />
          <KbdHint keys="/" label="search" />
          <KbdHint keys="r" label="refresh" />
          <KbdHint keys="o" label="github" />
        </div>
      </div>

      {/* ==== RIGHT: PR DETAIL ==== */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {selectedPr ? (
          <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            {showIntegrationContext && selectedMergeContext ? (
              <div style={{ padding: 16, paddingBottom: 0, background: COLORS.pageBg, borderBottom: `1px solid ${COLORS.border}` }}>
                <IntegrationPrContextPanel
                  pr={selectedPr}
                  lanes={lanes}
                  mergeContext={selectedMergeContext}
                  actions={(
                    <button
                      type="button"
                      onClick={() => setActiveTab("integration")}
                      style={outlineButton({ height: 28, padding: "0 10px", color: COLORS.accent, borderColor: `${COLORS.accent}40` })}
                    >
                      OPEN INTEGRATION VIEW
                    </button>
                  )}
                />
              </div>
            ) : null}
            <div style={{ flex: 1, minHeight: 0 }}>
              <PrDetailPane
                pr={selectedPr}
                status={detailStatus}
                checks={detailChecks}
                reviews={detailReviews}
                comments={detailComments}
                detailBusy={detailBusy}
                lanes={lanes}
                mergeMethod={mergeMethod}
                onRefresh={onRefresh}
                onNavigate={(path) => navigate(path)}
                onShowInGraph={(laneId) => navigate(`/graph?focusLane=${encodeURIComponent(laneId)}`)}
                onOpenRebaseTab={(laneId) => {
                  if (laneId) setSelectedRebaseItemId(laneId);
                  setActiveTab("rebase");
                }}
              />
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center", background: COLORS.pageBg }}>
            <EmptyState title="No PR selected" description="Select a PR to view details, checks, comments, and merge workflow." />
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- Filter Select ---- */
function FilterSelect({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        height: 26, padding: "0 6px", fontFamily: MONO_FONT, fontSize: 10, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: "0.5px",
        color: value === "all" ? COLORS.textMuted : COLORS.accent,
        background: COLORS.recessedBg, border: `1px solid ${value === "all" ? COLORS.border : COLORS.accent}`,
        outline: "none", cursor: "pointer",
      }}
      title={label}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  );
}

/* ---- Keyboard shortcut hint ---- */
function KbdHint({ keys, label }: { keys: string; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span style={{
        fontFamily: MONO_FONT, fontSize: 9, fontWeight: 700,
        color: COLORS.textMuted, padding: "1px 4px",
        border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg,
      }}>
        {keys}
      </span>
      <span style={{ fontFamily: MONO_FONT, fontSize: 9, color: COLORS.textDim }}>{label}</span>
    </div>
  );
}

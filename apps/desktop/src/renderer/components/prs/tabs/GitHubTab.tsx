import React from "react";
import { ArrowsClockwise, ArrowSquareOut, ChatText, CheckCircle, CircleNotch, GitMerge, GithubLogo, Link, MagnifyingGlass, Warning, XCircle } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { GitHubPrListItem, GitHubPrSnapshot, LaneSummary, MergeMethod, PrSummary } from "../../../../shared/types";
import { EmptyState } from "../../ui/EmptyState";
import { COLORS, LABEL_STYLE, MONO_FONT, SANS_FONT, cardStyle, inlineBadge, outlineButton, primaryButton } from "../../lanes/laneDesignTokens";
import { isMissionResultLane } from "../../lanes/laneUtils";
import { PrDetailPane } from "../detail/PrDetailPane";
import { formatTimestampShort, formatTimeAgoCompact } from "../shared/prFormatters";
import { PrCiRunningIndicator } from "../shared/prVisuals";
import { usePrs } from "../state/PrsContext";

const VIRTUALIZE_AT = 50;

type GitHubTabProps = {
  lanes: LaneSummary[];
  mergeMethod: MergeMethod;
  selectedPrId: string | null;
  onSelectPr: (id: string | null) => void;
  onRefreshAll: () => Promise<void>;
  onOpenRebaseTab?: (laneId?: string) => void;
  onOpenQueueView?: (groupId: string) => void;
};

type GitHubFilter = "open" | "closed" | "merged" | "all";
type ScopeFilter = "all" | "ade" | "external";

function matchesFilter(item: GitHubPrListItem, filter: GitHubFilter): boolean {
  if (filter === "all") return true;
  if (filter === "open") return item.state === "open" || item.state === "draft";
  return item.state === filter;
}

/* -- Color-coded state badge with distinct colors per state -- */
function stateColor(state: string): { bg: string; border: string; text: string } {
  switch (state) {
    case "open":
      return { bg: "rgba(59,130,246,0.10)", border: "rgba(59,130,246,0.20)", text: "#60A5FA" };
    case "draft":
      return { bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.20)", text: "#FBBF24" };
    case "merged":
      return { bg: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.20)", text: "#4ADE80" };
    default:
      return { bg: "rgba(161,161,170,0.08)", border: "rgba(161,161,170,0.15)", text: "#A1A1AA" };
  }
}

function stateBadgeStyle(item: GitHubPrListItem): React.CSSProperties {
  const c = stateColor(item.state);
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 7px",
    fontSize: 10,
    fontWeight: 600,
    fontFamily: SANS_FONT,
    color: c.text,
    background: c.bg,
    border: `1px solid ${c.border}`,
    borderRadius: 5,
    textTransform: "capitalize",
  };
}

/* -- CI status dot color -- */
function ciDotColor(linkedPr: PrSummary | null): { color: string; title: string } | null {
  if (!linkedPr) return null;
  switch (linkedPr.checksStatus) {
    case "passing":
      return { color: COLORS.success, title: "CI passing" };
    case "failing":
      return { color: COLORS.danger, title: "CI failing" };
    case "pending":
      return { color: COLORS.warning, title: "CI pending" };
    default:
      return null;
  }
}

/* -- Review status indicator -- */
function reviewIndicator(linkedPr: PrSummary | null): { color: string; label: string } | null {
  if (!linkedPr) return null;
  switch (linkedPr.reviewStatus) {
    case "approved":
      return { color: COLORS.success, label: "Approved" };
    case "changes_requested":
      return { color: COLORS.danger, label: "Changes" };
    case "requested":
      return { color: COLORS.warning, label: "Review required" };
    default:
      return null;
  }
}

/* -- adeKind badge with distinctive styling -- */
const ADE_KIND_STYLES: Record<string, { color: string; background: string; border: string }> = {
  integration: {
    color: "#FBBF24",
    background: "linear-gradient(135deg, rgba(245,158,11,0.14) 0%, rgba(217,119,6,0.06) 100%)",
    border: "1px solid rgba(245,158,11,0.22)",
  },
  queue: {
    color: "#60A5FA",
    background: "linear-gradient(135deg, rgba(59,130,246,0.14) 0%, rgba(37,99,235,0.06) 100%)",
    border: "1px solid rgba(59,130,246,0.22)",
  },
  single: {
    color: "#A1A1AA",
    background: "rgba(161,161,170,0.06)",
    border: "1px solid rgba(161,161,170,0.12)",
  },
};

function adeKindBadge(kind: GitHubPrListItem["adeKind"]): React.CSSProperties | null {
  const style = ADE_KIND_STYLES[kind ?? ""];
  if (!style) return null;
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 7px",
    fontSize: 10,
    fontWeight: 600,
    fontFamily: SANS_FONT,
    color: style.color,
    background: style.background,
    border: style.border,
    borderRadius: 5,
  };
}

/* -- Label text color from hex background (luminance-aware) -- */
function labelTextColor(hexColor: string): string {
  const hex = hexColor.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16) || 0;
  const g = parseInt(hex.substring(2, 4), 16) || 0;
  const b = parseInt(hex.substring(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#1a1a2e" : "#f0f0f0";
}

/* -- Scope filter match -- */
function matchesScope(item: GitHubPrListItem, scope: ScopeFilter): boolean {
  if (scope === "all") return true;
  if (scope === "ade") return item.adeKind !== null;
  return item.adeKind === null;
}

/* -- Filter button styles -- */
const FILTER_COLORS: Record<GitHubFilter, { active: { bg: string; border: string; text: string; shadow: string }; inactive: { text: string } }> = {
  open: {
    active: { bg: "linear-gradient(135deg, rgba(59,130,246,0.16) 0%, rgba(37,99,235,0.08) 100%)", border: "rgba(59,130,246,0.30)", text: "#60A5FA", shadow: "0 0 10px rgba(59,130,246,0.12)" },
    inactive: { text: "#60A5FA" },
  },
  closed: {
    active: { bg: "linear-gradient(135deg, rgba(161,161,170,0.14) 0%, rgba(113,113,122,0.06) 100%)", border: "rgba(161,161,170,0.25)", text: "#A1A1AA", shadow: "0 0 10px rgba(161,161,170,0.08)" },
    inactive: { text: "#71717A" },
  },
  merged: {
    active: { bg: "linear-gradient(135deg, rgba(34,197,94,0.14) 0%, rgba(22,163,74,0.06) 100%)", border: "rgba(34,197,94,0.28)", text: "#4ADE80", shadow: "0 0 10px rgba(34,197,94,0.10)" },
    inactive: { text: "#4ADE80" },
  },
  all: {
    active: { bg: "linear-gradient(135deg, rgba(167,139,250,0.14) 0%, rgba(139,92,246,0.06) 100%)", border: "rgba(167,139,250,0.25)", text: "#C4B5FD", shadow: "0 0 10px rgba(167,139,250,0.10)" },
    inactive: { text: "#A1A1AA" },
  },
};

function GitHubReadOnlyPane({
  item,
  lanes,
  linkingBusy,
  linkLaneId,
  onLinkLaneChange,
  onLink,
}: {
  item: GitHubPrListItem;
  lanes: LaneSummary[];
  linkingBusy: boolean;
  linkLaneId: string;
  onLinkLaneChange: (laneId: string) => void;
  onLink: () => Promise<void>;
}) {
  const linkableLanes = React.useMemo(
    () => lanes.filter((lane) => !lane.archivedAt && lane.laneType !== "primary" && isMissionResultLane(lane)),
    [lanes],
  );

  const sc = stateColor(item.state);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "auto", padding: 20, gap: 16, backdropFilter: "blur(20px)" }}>
      <div style={cardStyle({ background: "rgba(255,255,255,0.035)", border: "1px solid rgba(255,255,255,0.07)" })}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span style={stateBadgeStyle(item)}>{item.state}</span>
              {adeKindBadge(item.adeKind) ? <span style={adeKindBadge(item.adeKind)!}>{item.adeKind}</span> : null}
              {item.scope === "external" ? <span style={inlineBadge(COLORS.textMuted)}>external</span> : null}
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
              {item.title}
            </div>
            <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
              {item.author ? (
                <img
                  src={`https://avatars.githubusercontent.com/${item.author}?size=32`}
                  alt=""
                  style={{ width: 18, height: 18, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.08)" }}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
              ) : null}
              <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
                {item.author ?? "unknown"}
              </span>
              <span style={{ color: COLORS.textDim }}>in</span>
              <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>
                {item.repoOwner}/{item.repoName}
              </span>
              <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: sc.text }}>
                #{item.githubPrNumber}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void window.ade.app.openExternal(item.githubUrl)}
            style={outlineButton({ flexShrink: 0, borderRadius: 10, gap: 8 })}
          >
            <GithubLogo size={14} weight="fill" /> View on GitHub
          </button>
        </div>
      </div>

      <div style={{ ...cardStyle({ background: "rgba(255,255,255,0.035)", border: "1px solid rgba(255,255,255,0.07)" }), display: "grid", gap: 12 }}>
        <div>
          <div style={LABEL_STYLE}>ADE Status</div>
          {item.linkedPrId ? (
            <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textSecondary, marginTop: 4 }}>
              Linked to <span style={{ fontFamily: MONO_FONT, color: COLORS.accent }}>{item.linkedLaneName ?? item.linkedLaneId ?? "lane"}</span>
            </div>
          ) : item.scope === "external" ? (
            <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6, marginTop: 4 }}>
              External pull request, not modeled as a local lane.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              <div style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "10px 12px",
                borderRadius: 10,
                background: "rgba(245,158,11,0.06)",
                border: "1px solid rgba(245,158,11,0.12)",
                marginTop: 4,
              }}>
                <Warning size={16} weight="fill" style={{ marginTop: 2, flexShrink: 0, color: COLORS.warning }} />
                <div style={{ fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.6, color: "#FBBF24" }}>
                  This PR exists on GitHub but is not linked to an ADE lane.
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <select
                  value={linkLaneId}
                  onChange={(event) => onLinkLaneChange(event.target.value)}
                  aria-label="Select result lane to link"
                  style={{
                    flex: 1,
                    height: 34,
                    background: COLORS.recessedBg,
                    border: `1px solid ${COLORS.border}`,
                    color: COLORS.textPrimary,
                    fontFamily: SANS_FONT,
                    fontSize: 12,
                    padding: "0 10px",
                    borderRadius: 8,
                  }}
                >
                  <option value="">Select lane to link</option>
                  {linkableLanes.map((lane) => (
                    <option key={lane.id} value={lane.id}>
                      {lane.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!linkLaneId || linkingBusy}
                  onClick={() => void onLink()}
                  aria-label={linkingBusy ? "Linking result lane to pull request" : "Link selected result lane to pull request"}
                  style={primaryButton({ opacity: !linkLaneId || linkingBusy ? 0.5 : 1, borderRadius: 8 })}
                >
                  <Link size={14} /> {linkingBusy ? "Linking..." : "Link"}
                </button>
              </div>
            </div>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
          <div>
            <div style={LABEL_STYLE}>Head</div>
            <div style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textSecondary, marginTop: 2 }}>{item.headBranch ?? "---"}</div>
          </div>
          <div>
            <div style={LABEL_STYLE}>Base</div>
            <div style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textSecondary, marginTop: 2 }}>{item.baseBranch ?? "---"}</div>
          </div>
          <div>
            <div style={LABEL_STYLE}>Author</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
              {item.author ? (
                <img
                  src={`https://avatars.githubusercontent.com/${item.author}?size=24`}
                  alt=""
                  style={{ width: 16, height: 16, borderRadius: "50%" }}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
              ) : null}
              <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textSecondary }}>{item.author ?? "---"}</span>
            </div>
          </div>
          <div>
            <div style={LABEL_STYLE}>Updated</div>
            <div style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textSecondary, marginTop: 2 }}>{formatTimestampShort(item.updatedAt)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function GitHubTab({ lanes, mergeMethod, selectedPrId, onSelectPr, onRefreshAll, onOpenRebaseTab, onOpenQueueView }: GitHubTabProps) {
  const navigate = useNavigate();
  const {
    prs,
    mergeContextByPrId,
    detailStatus,
    detailChecks,
    detailReviews,
    detailComments,
    detailBusy,
  } = usePrs();

  const [snapshot, setSnapshot] = React.useState<GitHubPrSnapshot | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<GitHubFilter>("open");
  const [selectedItemId, setSelectedItemId] = React.useState<string | null>(null);
  const [scopeFilter, setScopeFilter] = React.useState<ScopeFilter>("all");
  const [linkLaneId, setLinkLaneId] = React.useState("");
  const [linkingItemId, setLinkingItemId] = React.useState<string | null>(null);
  const [syncing, setSyncing] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  const lastHandledSelectedPrIdRef = React.useRef<string | null | undefined>(undefined);
  const pendingSelectedItemIdRef = React.useRef<string | null>(null);
  const snapshotRef = React.useRef<GitHubPrSnapshot | null>(null);
  const hasInitializedSelectionRef = React.useRef(false);
  const lastPrFingerprintRef = React.useRef<string>("");
  const hotRefreshUntilRef = React.useRef(0);
  const hotRefreshTimerRef = React.useRef<number | null>(null);
  const inFlightSnapshotRef = React.useRef<Promise<GitHubPrSnapshot> | null>(null);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  snapshotRef.current = snapshot;

  /* Build a lookup from linkedPrId -> PrSummary for CI/review indicators */
  const prsByIdMap = React.useMemo(() => {
    const map = new Map<string, PrSummary>();
    for (const pr of prs) {
      map.set(pr.id, pr);
    }
    return map;
  }, [prs]);

  const loadSnapshot = React.useCallback(async (options?: { force?: boolean; silent?: boolean }) => {
    if (inFlightSnapshotRef.current) return inFlightSnapshotRef.current;
    if (!options?.silent) {
      setLoading((prev) => options?.force || snapshotRef.current == null ? true : prev);
    }
    setError(null);
    const pending = window.ade.prs.getGitHubSnapshot({ force: options?.force === true })
      .then((next) => {
        setSnapshot(next);
        return next;
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        return snapshotRef.current as GitHubPrSnapshot;
      })
      .finally(() => {
        inFlightSnapshotRef.current = null;
        if (!options?.silent) {
          setLoading(false);
        }
      });
    inFlightSnapshotRef.current = pending;
    return pending;
  }, []);

  const startHotRefreshWindow = React.useCallback(() => {
    const now = Date.now();
    hotRefreshUntilRef.current = Math.max(hotRefreshUntilRef.current, now + 180_000);
    if (hotRefreshTimerRef.current != null) return;

    const schedule = () => {
      const remaining = hotRefreshUntilRef.current - Date.now();
      if (remaining <= 0) {
        hotRefreshTimerRef.current = null;
        return;
      }
      const elapsed = 180_000 - remaining;
      const delay = elapsed < 60_000 ? 5_000 : 15_000;
      hotRefreshTimerRef.current = window.setTimeout(() => {
        hotRefreshTimerRef.current = null;
        void loadSnapshot({ force: true, silent: true }).finally(() => {
          schedule();
        });
      }, delay);
    };

    schedule();
  }, [loadSnapshot]);

  React.useEffect(() => {
    void loadSnapshot();
    return () => {
      if (hotRefreshTimerRef.current != null) {
        window.clearTimeout(hotRefreshTimerRef.current);
        hotRefreshTimerRef.current = null;
      }
      hotRefreshUntilRef.current = 0;
    };
  }, [loadSnapshot]);

  React.useEffect(() => {
    const nextFingerprint = JSON.stringify(
      prs
        .map((pr) => [
          pr.id,
          pr.state,
          pr.checksStatus,
          pr.reviewStatus,
          pr.title,
          pr.githubPrNumber,
          pr.updatedAt,
        ])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    );
    if (!lastPrFingerprintRef.current) {
      lastPrFingerprintRef.current = nextFingerprint;
      return;
    }
    if (lastPrFingerprintRef.current === nextFingerprint) return;
    lastPrFingerprintRef.current = nextFingerprint;
    startHotRefreshWindow();
    void loadSnapshot({ force: true, silent: true });
  }, [loadSnapshot, prs, startHotRefreshWindow]);

  const matchesSearch = React.useCallback((item: GitHubPrListItem) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.trim().toLowerCase();
    return (
      item.title.toLowerCase().includes(q) ||
      (item.author?.toLowerCase().includes(q) ?? false) ||
      (item.headBranch?.toLowerCase().includes(q) ?? false) ||
      String(item.githubPrNumber).includes(q)
    );
  }, [searchQuery]);

  const allItems = React.useMemo(
    () => [...(snapshot?.repoPullRequests ?? []), ...(snapshot?.externalPullRequests ?? [])],
    [snapshot],
  );

  const filteredItems = React.useMemo(
    () => allItems
      .filter((item) => matchesFilter(item, filter) && matchesScope(item, scopeFilter) && matchesSearch(item))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [allItems, filter, scopeFilter, matchesSearch],
  );

  // Counts for filter tabs (scoped but not search-filtered)
  const filterCounts = React.useMemo(() => {
    const scoped = allItems.filter((item) => matchesScope(item, scopeFilter));
    return {
      open: scoped.filter((item) => item.state === "open" || item.state === "draft").length,
      closed: scoped.filter((item) => item.state === "closed").length,
      merged: scoped.filter((item) => item.state === "merged").length,
      all: scoped.length,
    };
  }, [allItems, scopeFilter]);

  // Counts for scope sub-tabs (status-filtered but not search-filtered)
  const scopeCounts = React.useMemo(() => {
    const statusFiltered = allItems.filter((item) => matchesFilter(item, filter));
    return {
      all: statusFiltered.length,
      ade: statusFiltered.filter((item) => item.adeKind !== null).length,
      external: statusFiltered.filter((item) => item.adeKind === null).length,
    };
  }, [allItems, filter]);

  React.useEffect(() => {
    if (!snapshot) return;
    if (selectedPrId === lastHandledSelectedPrIdRef.current) return;
    lastHandledSelectedPrIdRef.current = selectedPrId;

    if (!selectedPrId) {
      pendingSelectedItemIdRef.current = null;
      return;
    }

    const linkedItem = allItems.find((item) => item.linkedPrId === selectedPrId);
    if (!linkedItem) {
      pendingSelectedItemIdRef.current = null;
      return;
    }

    pendingSelectedItemIdRef.current = linkedItem.id;
    if (!matchesFilter(linkedItem, filter)) {
      setFilter(linkedItem.state === "merged" ? "merged" : linkedItem.state === "closed" ? "closed" : "open");
    }
    setSelectedItemId(linkedItem.id);
    hasInitializedSelectionRef.current = true;
  }, [snapshot, selectedPrId, filter]);

  React.useEffect(() => {
    if (!snapshot) return;
    if (pendingSelectedItemIdRef.current) {
      if (selectedItemId === pendingSelectedItemIdRef.current) {
        pendingSelectedItemIdRef.current = null;
      } else {
        return;
      }
    }

    if (selectedItemId && filteredItems.some((item) => item.id === selectedItemId)) return;
    if (!hasInitializedSelectionRef.current) {
      const next = filteredItems[0] ?? null;
      if (next) {
        hasInitializedSelectionRef.current = true;
        setSelectedItemId(next.id);
        onSelectPr(next.linkedPrId ?? null);
      }
    }
  }, [snapshot, filteredItems, selectedItemId, onSelectPr]);

  const selectedItem = React.useMemo(
    () => allItems.find((item) => item.id === selectedItemId) ?? null,
    [allItems, selectedItemId],
  );

  const selectedLinkedPr = React.useMemo(
    () => (selectedItem?.linkedPrId ? prs.find((pr) => pr.id === selectedItem.linkedPrId) ?? null : null),
    [prs, selectedItem],
  );
  const selectedQueueContext = React.useMemo(() => {
    if (!selectedLinkedPr) return null;
    const mergeContext = mergeContextByPrId[selectedLinkedPr.id];
    if (mergeContext?.groupType !== "queue" || !mergeContext.groupId) return null;
    return {
      groupId: mergeContext.groupId,
      label: "Open queue",
    };
  }, [mergeContextByPrId, selectedLinkedPr]);

  const handleSync = React.useCallback(async () => {
    setSyncing(true);
    startHotRefreshWindow();
    try {
      await Promise.all([
        onRefreshAll().catch(() => {}),
        loadSnapshot({ force: true }),
      ]);
    } finally {
      setSyncing(false);
    }
  }, [loadSnapshot, onRefreshAll, startHotRefreshWindow]);

  const handleSelectItem = React.useCallback((item: GitHubPrListItem) => {
    hasInitializedSelectionRef.current = true;
    setSelectedItemId(item.id);
    onSelectPr(item.linkedPrId ?? null);
    setLinkLaneId("");
  }, [onSelectPr]);

  const handleLink = React.useCallback(async () => {
    if (!selectedItem || !linkLaneId) return;
    setLinkingItemId(selectedItem.id);
    setError(null);
    try {
      await window.ade.prs.linkToLane({ laneId: linkLaneId, prUrlOrNumber: selectedItem.githubUrl });
      await handleSync();
      setLinkLaneId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLinkingItemId(null);
    }
  }, [handleSync, linkLaneId, selectedItem]);

  if (loading && !snapshot) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <CircleNotch size={16} className="animate-spin" style={{ color: COLORS.accent }} />
          <span style={{ fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textMuted }}>Syncing with GitHub...</span>
        </div>
      </div>
    );
  }

  if (error && !snapshot) {
    return <EmptyState title="GitHub" description={error} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Search + Filter bar (Better-Hub inspired) */}
      <div style={{
        display: "flex",
        flexDirection: "column",
        gap: 0,
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        background: "rgba(255,255,255,0.01)",
      }}>
        {/* Search row */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 16px", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
          <div style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            gap: 8,
            height: 32,
            padding: "0 10px",
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 8,
          }}>
            <MagnifyingGlass size={13} style={{ color: COLORS.textDim, flexShrink: 0 }} />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search pull requests..."
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                outline: "none",
                fontFamily: SANS_FONT,
                fontSize: 12,
                color: COLORS.textPrimary,
              }}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: COLORS.textDim, display: "flex" }}
              >
                <span style={{ fontSize: 11 }}>×</span>
              </button>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim }}>
              {snapshot?.repo ? `${snapshot.repo.owner}/${snapshot.repo.name}` : ""}
            </span>
            <button
              type="button"
              onClick={() => void handleSync()}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
                height: 28,
                padding: "0 10px",
                fontSize: 11,
                fontWeight: 500,
                fontFamily: SANS_FONT,
                color: syncing ? COLORS.accent : COLORS.textSecondary,
                background: syncing ? "rgba(167,139,250,0.08)" : "rgba(255,255,255,0.03)",
                border: syncing ? "1px solid rgba(167,139,250,0.15)" : "1px solid rgba(255,255,255,0.06)",
                borderRadius: 7,
                cursor: "pointer",
                transition: "all 150ms ease",
              }}
            >
              <ArrowsClockwise size={12} className={syncing ? "animate-spin" : ""} />
              {syncing ? "Syncing..." : "Sync"}
            </button>
          </div>
        </div>
        {/* Filter tabs with counts (Better-Hub style) */}
        <div style={{ display: "flex", alignItems: "center", gap: 0, padding: "0 16px" }}>
          {(["open", "merged", "closed"] as GitHubFilter[]).map((state) => {
            const active = filter === state;
            const fc = FILTER_COLORS[state];
            const count = filterCounts[state];
            const icon = state === "merged" ? <GitMerge size={12} weight="bold" /> : null;
            return (
              <button
                key={state}
                type="button"
                onClick={() => {
                  pendingSelectedItemIdRef.current = null;
                  setFilter(state);
                  setSelectedItemId(null);
                  onSelectPr(null);
                  setLinkLaneId("");
                }}
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
                  color: active ? fc.active.text : COLORS.textMuted,
                  background: "transparent",
                  border: "none",
                  borderBottom: active ? `2px solid ${fc.active.text}` : "2px solid transparent",
                  cursor: "pointer",
                  textTransform: "capitalize",
                  transition: "all 150ms ease",
                }}
              >
                {icon}
                {state}
                <span style={{
                  fontFamily: MONO_FONT,
                  fontSize: 10,
                  fontWeight: 600,
                  color: active ? fc.active.text : COLORS.textDim,
                  opacity: active ? 0.8 : 0.6,
                }}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
        {/* Scope sub-tabs: All / ADE / External */}
        <div style={{ display: "flex", alignItems: "center", gap: 2, padding: "4px 16px 6px", borderTop: "1px solid rgba(255,255,255,0.03)" }}>
          {(["all", "ade", "external"] as ScopeFilter[]).map((scope) => {
            const active = scopeFilter === scope;
            const count = scopeCounts[scope];
            const label = scope === "ade" ? "ADE" : scope === "external" ? "External" : "All";
            return (
              <button
                key={scope}
                type="button"
                onClick={() => {
                  setScopeFilter(scope);
                  setSelectedItemId(null);
                  onSelectPr(null);
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  height: 24,
                  padding: "0 10px",
                  fontSize: 11,
                  fontWeight: active ? 600 : 400,
                  fontFamily: SANS_FONT,
                  color: active ? "#C4B5FD" : COLORS.textMuted,
                  background: active ? "rgba(167,139,250,0.10)" : "transparent",
                  border: active ? "1px solid rgba(167,139,250,0.15)" : "1px solid transparent",
                  borderRadius: 6,
                  cursor: "pointer",
                  transition: "all 150ms ease",
                }}
              >
                {label}
                <span style={{ fontSize: 10, fontFamily: MONO_FONT, opacity: 0.7 }}>{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {error ? (
        <div style={{
          padding: "10px 16px",
          borderBottom: "1px solid rgba(239,68,68,0.2)",
          background: "rgba(239,68,68,0.06)",
          color: COLORS.danger,
          fontFamily: SANS_FONT,
          fontSize: 12,
          borderRadius: 0,
        }}>
          {error}
        </div>
      ) : null}

      <div style={{ display: "flex", minHeight: 0, flex: 1 }}>
        {/* PR list sidebar */}
        <div ref={listRef} data-tour="prs.list" style={{ width: 380, borderRight: "1px solid rgba(255,255,255,0.06)", overflow: "auto", flexShrink: 0 }}>
          {/* Section header */}
          <div style={{
            padding: "10px 14px",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}>
            <div style={{ fontFamily: SANS_FONT, fontSize: 11, fontWeight: 600, color: COLORS.textMuted, letterSpacing: "0.3px" }}>
              Pull Requests
            </div>
            <span style={{
              fontFamily: MONO_FONT,
              fontSize: 10,
              fontWeight: 600,
              color: COLORS.accent,
              background: "rgba(167,139,250,0.08)",
              padding: "2px 7px",
              borderRadius: 4,
            }}>
              {filteredItems.length}
            </span>
          </div>

          {filteredItems.length === 0 ? (
            <div style={{ padding: 20 }}>
              <EmptyState title="No pull requests" description="No pull requests match the current filters." />
            </div>
          ) : filteredItems.length > VIRTUALIZE_AT ? (
            <GitHubTabVirtualList
              parentRef={listRef}
              items={filteredItems}
              selectedItemId={selectedItemId}
              prsByIdMap={prsByIdMap}
              onSelect={handleSelectItem}
              onOpenQueueView={onOpenQueueView}
            />
          ) : (
            filteredItems.map((item) => (
              <GitHubTabPrRow
                key={item.id}
                item={item}
                selected={item.id === selectedItemId}
                linkedPr={item.linkedPrId ? prsByIdMap.get(item.linkedPrId) ?? null : null}
                onSelect={handleSelectItem}
                onOpenQueueView={onOpenQueueView}
              />
            ))
          )}
        </div>

        {/* Detail pane */}
        <div data-tour="prs.detailDrawer" style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          {selectedItem && selectedLinkedPr ? (
            <PrDetailPane
              pr={selectedLinkedPr}
              status={detailStatus}
              checks={detailChecks}
              reviews={detailReviews}
              comments={detailComments}
              detailBusy={detailBusy}
              lanes={lanes}
              mergeMethod={mergeMethod}
              onRefresh={handleSync}
              onNavigate={navigate}
              onOpenRebaseTab={onOpenRebaseTab}
              queueContext={selectedQueueContext}
              onOpenQueueView={onOpenQueueView}
            />
          ) : selectedItem ? (
            <GitHubReadOnlyPane
              item={selectedItem}
              lanes={lanes}
              linkingBusy={linkingItemId === selectedItem.id}
              linkLaneId={linkLaneId}
              onLinkLaneChange={setLinkLaneId}
              onLink={handleLink}
            />
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
              <EmptyState title="No pull request selected" description="Choose a GitHub pull request to inspect details." />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---- PR row (shared between list and virtualizer) ---- */
function GitHubTabPrRow({
  item,
  selected,
  linkedPr,
  onSelect,
  onOpenQueueView,
}: {
  item: GitHubPrListItem;
  selected: boolean;
  linkedPr: PrSummary | null;
  onSelect: (item: GitHubPrListItem) => void;
  onOpenQueueView?: (groupId: string) => void;
}) {
  const sc = stateColor(item.state);
  const ci = ciDotColor(linkedPr);
  const ciRunning = linkedPr?.checksStatus === "pending";
  const review = reviewIndicator(linkedPr);
  const ago = formatTimeAgoCompact(item.createdAt);
  const visibleLabels = item.labels.slice(0, 4);
  const overflowCount = item.labels.length - 4;
  return (
    <button
      type="button"
      data-tour="prs.listRow"
      onClick={() => onSelect(item)}
      style={{
        display: "flex",
        width: "100%",
        flexDirection: "column",
        gap: 6,
        padding: "11px 14px",
        textAlign: "left",
        border: "none",
        borderLeft: selected ? `3px solid ${sc.text}` : "3px solid transparent",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
        background: selected
          ? `linear-gradient(90deg, ${sc.bg} 0%, rgba(255,255,255,0.02) 100%)`
          : "transparent",
        cursor: "pointer",
        transition: "background 150ms ease",
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "rgba(255,255,255,0.025)"; }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
    >
      {/* Row 1: avatar, bot badge, PR number, title, CI icon, time, comments */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        {item.author ? (
          <img
            src={`https://avatars.githubusercontent.com/${item.author}?size=32`}
            alt=""
            style={{
              width: 22,
              height: 22,
              borderRadius: "50%",
              flexShrink: 0,
              border: `1.5px solid ${sc.bg}`,
            }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
        ) : (
          <div style={{
            width: 22,
            height: 22,
            borderRadius: "50%",
            flexShrink: 0,
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.08)",
          }} />
        )}
        {item.isBot ? (
          <span style={{
            fontSize: 9,
            fontWeight: 700,
            fontFamily: SANS_FONT,
            textTransform: "uppercase",
            padding: "1px 5px",
            borderRadius: 3,
            background: "rgba(255,255,255,0.06)",
            color: COLORS.textDim,
            flexShrink: 0,
            letterSpacing: "0.3px",
          }}>
            bot
          </span>
        ) : null}
        <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: sc.text, flexShrink: 0 }}>
          #{item.githubPrNumber}
        </span>
        <span style={{
          fontSize: 12,
          fontWeight: 600,
          color: COLORS.textPrimary,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: SANS_FONT,
          flex: 1,
          minWidth: 0,
        }}>
          {item.title}
        </span>
        {ci ? (
          <span title={ci.title} style={{ display: "inline-flex", flexShrink: 0 }}>
            {linkedPr?.checksStatus === "passing" ? (
              <CheckCircle size={14} weight="fill" style={{ color: "#4ADE80" }} />
            ) : linkedPr?.checksStatus === "failing" ? (
              <XCircle size={14} weight="fill" style={{ color: "#EF4444" }} />
            ) : ciRunning ? (
              <PrCiRunningIndicator color="#FBBF24" size={14} />
            ) : null}
          </span>
        ) : null}
        {ago ? (
          <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim, flexShrink: 0 }}>
            {ago}
          </span>
        ) : null}
        {item.commentCount > 0 ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0, color: COLORS.textDim }}>
            <ChatText size={12} />
            <span style={{ fontFamily: MONO_FONT, fontSize: 10 }}>{item.commentCount}</span>
          </span>
        ) : null}
      </div>
      {/* Row 1.5: labels */}
      {visibleLabels.length > 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: 30, flexWrap: "wrap" }}>
          {visibleLabels.map((label) => {
            const bg = `#${label.color}`;
            const textColor = labelTextColor(label.color);
            return (
              <span
                key={label.name}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "1px 8px",
                  fontSize: 10,
                  fontWeight: 600,
                  fontFamily: SANS_FONT,
                  color: textColor,
                  background: bg,
                  borderRadius: 10,
                  lineHeight: "16px",
                }}
              >
                {label.name}
              </span>
            );
          })}
          {overflowCount > 0 ? (
            <span style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim }}>
              +{overflowCount}
            </span>
          ) : null}
        </div>
      ) : null}
      {/* Row 2: branch info */}
      {item.baseBranch && item.headBranch ? (
        <div style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: 30, fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
          <span>{item.baseBranch}</span>
          <span style={{ color: COLORS.textMuted }}>←</span>
          <span style={{ color: COLORS.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.headBranch}</span>
        </div>
      ) : null}
      {/* Row 3: inline stats */}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, paddingLeft: 30 }}>
        <span style={stateBadgeStyle(item)}>{item.state}</span>
        {adeKindBadge(item.adeKind) ? <span style={adeKindBadge(item.adeKind)!}>{item.adeKind}</span> : null}
        {item.scope === "external" ? (
          <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
            {item.repoOwner}/{item.repoName}
          </span>
        ) : null}
        {item.linkedLaneName ? (
          <span style={{ ...inlineBadge(COLORS.textSecondary), fontSize: 10, padding: "2px 7px", borderRadius: 5 }}>
            {item.linkedLaneName}
          </span>
        ) : (
          <span style={{ display: "inline-flex", alignItems: "center", padding: "2px 7px", fontSize: 10, fontWeight: 600, fontFamily: SANS_FONT, color: "#FBBF24", background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.18)", borderRadius: 5 }}>
            unmapped
          </span>
        )}
        {review ? (
          <span style={{ display: "inline-flex", alignItems: "center", padding: "2px 6px", fontSize: 10, fontWeight: 500, fontFamily: SANS_FONT, color: review.color, background: `${review.color}10`, borderRadius: 4 }}>
            {review.label}
          </span>
        ) : null}
        {linkedPr ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontFamily: MONO_FONT }}>
            <span style={{ color: COLORS.success }}>+{linkedPr.additions}</span>
            <span style={{ color: COLORS.danger }}>-{linkedPr.deletions}</span>
          </span>
        ) : null}
        {item.cleanupState === "required" ? (
          <span style={{ ...inlineBadge(COLORS.warning), fontSize: 10, padding: "2px 7px", borderRadius: 5 }}>cleanup</span>
        ) : null}
        {item.adeKind === "queue" && item.linkedGroupId && onOpenQueueView ? (
          <span
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.stopPropagation();
              onOpenQueueView(item.linkedGroupId!);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                onOpenQueueView(item.linkedGroupId!);
              }
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "2px 7px",
              fontSize: 10,
              fontWeight: 600,
              fontFamily: SANS_FONT,
              color: COLORS.info,
              background: "rgba(59,130,246,0.10)",
              border: "1px solid rgba(59,130,246,0.18)",
              borderRadius: 5,
              cursor: "pointer",
            }}
            title="Open queue workflow"
          >
            open queue
          </span>
        ) : null}
        <span
          role="link"
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); void window.ade.app.openExternal(item.githubUrl); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); void window.ade.app.openExternal(item.githubUrl); } }}
          style={{ display: "inline-flex", alignItems: "center", marginLeft: "auto", padding: 0, cursor: "pointer", color: COLORS.textDim, transition: "color 100ms ease" }}
          title="Open on GitHub"
          onMouseEnter={(e) => { e.currentTarget.style.color = COLORS.textSecondary; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = COLORS.textDim; }}
        >
          <ArrowSquareOut size={13} />
        </span>
      </div>
    </button>
  );
}

/* ---- Virtual list for GitHub PR sidebar (activated above VIRTUALIZE_AT) ---- */
function GitHubTabVirtualList({
  parentRef,
  items,
  selectedItemId,
  prsByIdMap,
  onSelect,
  onOpenQueueView,
}: {
  parentRef: React.RefObject<HTMLDivElement | null>;
  items: GitHubPrListItem[];
  selectedItemId: string | null;
  prsByIdMap: Map<string, PrSummary>;
  onSelect: (item: GitHubPrListItem) => void;
  onOpenQueueView?: (groupId: string) => void;
}) {
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 108,
    overscan: 6,
  });
  return (
    <div
      data-testid="pr-github-list-virtual"
      style={{ height: virtualizer.getTotalSize(), position: "relative" }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const item = items[virtualRow.index]!;
        return (
          <div
            key={item.id}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            <GitHubTabPrRow
              item={item}
              selected={item.id === selectedItemId}
              linkedPr={item.linkedPrId ? prsByIdMap.get(item.linkedPrId) ?? null : null}
              onSelect={onSelect}
              onOpenQueueView={onOpenQueueView}
            />
          </div>
        );
      })}
    </div>
  );
}

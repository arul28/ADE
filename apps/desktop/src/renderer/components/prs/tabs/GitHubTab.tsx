import React from "react";
import { ArrowsClockwise, ArrowSquareOut, CaretDown, CaretRight, CircleNotch, GitMerge, GithubLogo, Link, MagnifyingGlass, Warning } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type { GitHubPrListItem, GitHubPrSnapshot, LaneSummary, MergeMethod, PrSummary } from "../../../../shared/types";
import { EmptyState } from "../../ui/EmptyState";
import { COLORS, LABEL_STYLE, MONO_FONT, SANS_FONT, cardStyle, inlineBadge, outlineButton, primaryButton } from "../../lanes/laneDesignTokens";
import { PrDetailPane } from "../detail/PrDetailPane";
import { usePrs } from "../state/PrsContext";

type GitHubTabProps = {
  lanes: LaneSummary[];
  mergeMethod: MergeMethod;
  selectedPrId: string | null;
  onSelectPr: (id: string | null) => void;
  onRefreshAll: () => Promise<void>;
  onOpenRebaseTab?: () => void;
  onOpenQueueView?: (groupId: string) => void;
};

type GitHubFilter = "open" | "closed" | "merged" | "all";
const GITHUB_SNAPSHOT_TTL_MS = 120_000;

let cachedGitHubSnapshot: GitHubPrSnapshot | null = null;
let cachedGitHubSnapshotAt = 0;
let inFlightGitHubSnapshot: Promise<GitHubPrSnapshot> | null = null;

function hasFreshGitHubSnapshot(): boolean {
  return cachedGitHubSnapshot != null && Date.now() - cachedGitHubSnapshotAt < GITHUB_SNAPSHOT_TTL_MS;
}

async function fetchGitHubSnapshot(options?: { force?: boolean }): Promise<GitHubPrSnapshot> {
  if (!options?.force && hasFreshGitHubSnapshot()) {
    return cachedGitHubSnapshot!;
  }
  if (inFlightGitHubSnapshot) {
    return inFlightGitHubSnapshot;
  }
  inFlightGitHubSnapshot = window.ade.prs.getGitHubSnapshot({ force: options?.force === true }).then((snapshot) => {
    cachedGitHubSnapshot = snapshot;
    cachedGitHubSnapshotAt = Date.now();
    return snapshot;
  }).finally(() => {
    inFlightGitHubSnapshot = null;
  });
  return inFlightGitHubSnapshot;
}

function formatTimestampLabel(iso: string | null): string {
  if (!iso) return "---";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const now = Date.now();
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = now - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

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
      return { color: COLORS.warning, label: "Review" };
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
    () => lanes.filter((lane) => !lane.archivedAt && lane.laneType !== "primary"),
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
            <div style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textSecondary, marginTop: 2 }}>{formatTimestampLabel(item.updatedAt)}</div>
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

  const [snapshot, setSnapshot] = React.useState<GitHubPrSnapshot | null>(() => cachedGitHubSnapshot);
  const [loading, setLoading] = React.useState(() => cachedGitHubSnapshot == null);
  const [error, setError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<GitHubFilter>("open");
  const [selectedItemId, setSelectedItemId] = React.useState<string | null>(null);
  const [showExternal, setShowExternal] = React.useState(false);
  const [linkLaneId, setLinkLaneId] = React.useState("");
  const [linkingItemId, setLinkingItemId] = React.useState<string | null>(null);
  const [syncing, setSyncing] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  const lastHandledSelectedPrIdRef = React.useRef<string | null | undefined>(undefined);
  const pendingSelectedItemIdRef = React.useRef<string | null>(null);

  /* Build a lookup from linkedPrId -> PrSummary for CI/review indicators */
  const prsByIdMap = React.useMemo(() => {
    const map = new Map<string, PrSummary>();
    for (const pr of prs) {
      map.set(pr.id, pr);
    }
    return map;
  }, [prs]);

  const loadSnapshot = React.useCallback(async (options?: { force?: boolean; silent?: boolean }) => {
    if (!options?.silent) {
      setLoading((prev) => options?.force || snapshot == null ? true : prev);
    }
    setError(null);
    try {
      const next = await fetchGitHubSnapshot({ force: options?.force });
      setSnapshot(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  }, [snapshot]);

  React.useEffect(() => {
    if (cachedGitHubSnapshot) {
      setSnapshot(cachedGitHubSnapshot);
      setLoading(false);
      if (!hasFreshGitHubSnapshot()) {
        void loadSnapshot({ silent: true });
      }
      return;
    }
    void loadSnapshot();
  }, [loadSnapshot]);

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

  const repoItems = React.useMemo(
    () => (snapshot?.repoPullRequests ?? []).filter((item) => matchesFilter(item, filter) && matchesSearch(item)),
    [snapshot, filter, matchesSearch],
  );
  const externalItems = React.useMemo(
    () => (snapshot?.externalPullRequests ?? []).filter((item) => matchesFilter(item, filter) && matchesSearch(item)),
    [snapshot, filter, matchesSearch],
  );

  // Counts for filter tabs (unfiltered by search to show totals)
  const filterCounts = React.useMemo(() => {
    const all = snapshot?.repoPullRequests ?? [];
    return {
      open: all.filter((item) => item.state === "open" || item.state === "draft").length,
      closed: all.filter((item) => item.state === "closed").length,
      merged: all.filter((item) => item.state === "merged").length,
      all: all.length,
    };
  }, [snapshot]);

  React.useEffect(() => {
    if (!snapshot) return;
    if (selectedPrId === lastHandledSelectedPrIdRef.current) return;
    lastHandledSelectedPrIdRef.current = selectedPrId;

    if (!selectedPrId) {
      pendingSelectedItemIdRef.current = null;
      return;
    }

    const linkedItem = snapshot.repoPullRequests.find((item) => item.linkedPrId === selectedPrId);
    if (!linkedItem) {
      pendingSelectedItemIdRef.current = null;
      return;
    }

    pendingSelectedItemIdRef.current = linkedItem.id;
    if (!matchesFilter(linkedItem, filter)) {
      setFilter(linkedItem.state === "merged" ? "merged" : linkedItem.state === "closed" ? "closed" : "open");
    }
    setSelectedItemId(linkedItem.id);
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

    const visibleItems = [...repoItems, ...externalItems];
    if (selectedItemId && visibleItems.some((item) => item.id === selectedItemId)) return;
    const next = visibleItems[0] ?? null;
    setSelectedItemId(next?.id ?? null);
    onSelectPr(next?.linkedPrId ?? null);
  }, [snapshot, repoItems, externalItems, selectedItemId, selectedPrId, onSelectPr]);

  const selectedItem = React.useMemo(() => {
    const allItems = [...(snapshot?.repoPullRequests ?? []), ...(snapshot?.externalPullRequests ?? [])];
    return allItems.find((item) => item.id === selectedItemId) ?? null;
  }, [snapshot, selectedItemId]);

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
    try {
      await Promise.all([
        onRefreshAll().catch(() => {}),
        loadSnapshot({ force: true }),
      ]);
    } finally {
      setSyncing(false);
    }
  }, [loadSnapshot, onRefreshAll]);

  const handleSelectItem = React.useCallback((item: GitHubPrListItem) => {
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
        <div style={{ width: 380, borderRight: "1px solid rgba(255,255,255,0.06)", overflow: "auto", flexShrink: 0 }}>
          {/* Section header: Repo PRs */}
          <div style={{
            padding: "10px 14px",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}>
            <div style={{ fontFamily: SANS_FONT, fontSize: 11, fontWeight: 600, color: COLORS.textMuted, letterSpacing: "0.3px" }}>
              Repo Pull Requests
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
              {repoItems.length}
            </span>
          </div>

          {repoItems.length === 0 ? (
            <div style={{ padding: 20 }}>
              <EmptyState title="No pull requests" description="No pull requests match the current GitHub filter." />
            </div>
          ) : (
            repoItems.map((item) => {
              const selected = item.id === selectedItemId;
              const sc = stateColor(item.state);
              const linkedPr = item.linkedPrId ? prsByIdMap.get(item.linkedPrId) ?? null : null;
              const ci = ciDotColor(linkedPr);
              const review = reviewIndicator(linkedPr);
              const ago = timeAgo(item.updatedAt);
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleSelectItem(item)}
                  style={{
                    display: "flex",
                    width: "100%",
                    flexDirection: "column",
                    gap: 8,
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
                  {/* Row 1: avatar, PR number, title, time ago */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
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
                    {ago ? (
                      <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim, flexShrink: 0, marginLeft: "auto" }}>
                        {ago}
                      </span>
                    ) : null}
                  </div>
                  {/* Row 2: branch info (Better-Hub style: base ← head) */}
                  {item.baseBranch && item.headBranch ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: 30, fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
                      <span>{item.baseBranch}</span>
                      <span style={{ color: COLORS.textMuted }}>←</span>
                      <span style={{ color: COLORS.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.headBranch}</span>
                    </div>
                  ) : null}
                  {/* Row 3: inline stats (Better-Hub style) */}
                  <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, paddingLeft: 30 }}>
                    <span style={stateBadgeStyle(item)}>{item.state}</span>
                    {adeKindBadge(item.adeKind) ? <span style={adeKindBadge(item.adeKind)!}>{item.adeKind}</span> : null}
                    {item.linkedLaneName ? (
                      <span style={{ ...inlineBadge(COLORS.textSecondary), fontSize: 10, padding: "2px 7px", borderRadius: 5 }}>
                        {item.linkedLaneName}
                      </span>
                    ) : (
                      <span style={{ display: "inline-flex", alignItems: "center", padding: "2px 7px", fontSize: 10, fontWeight: 600, fontFamily: SANS_FONT, color: "#FBBF24", background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.18)", borderRadius: 5 }}>
                        unmapped
                      </span>
                    )}
                    {ci ? (
                      <span title={ci.title} style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontFamily: SANS_FONT, color: ci.color }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: ci.color, display: "inline-block", boxShadow: `0 0 4px ${ci.color}44` }} />
                        CI
                      </span>
                    ) : null}
                    {review ? (
                      <span style={{ display: "inline-flex", alignItems: "center", padding: "2px 6px", fontSize: 10, fontWeight: 500, fontFamily: SANS_FONT, color: review.color, background: `${review.color}10`, borderRadius: 4 }}>
                        {review.label}
                      </span>
                    ) : null}
                    {/* +/- stats from linked PR (Better-Hub style) */}
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
            })
          )}

          {/* External / Unmapped section */}
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
            <button
              type="button"
              onClick={() => setShowExternal((value) => !value)}
              style={{
                display: "flex",
                width: "100%",
                alignItems: "center",
                gap: 8,
                padding: "11px 14px",
                border: "none",
                borderBottom: "1px solid rgba(255,255,255,0.04)",
                background: showExternal ? "rgba(245,158,11,0.03)" : "transparent",
                cursor: "pointer",
                transition: "background 150ms ease",
              }}
            >
              <span style={{ color: COLORS.warning, display: "flex" }}>
                {showExternal ? <CaretDown size={13} weight="bold" /> : <CaretRight size={13} weight="bold" />}
              </span>
              <span style={{
                fontFamily: SANS_FONT,
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.3px",
                color: COLORS.textMuted,
              }}>
                External / Unmapped
              </span>
              <span style={{
                marginLeft: "auto",
                fontFamily: MONO_FONT,
                fontSize: 10,
                fontWeight: 600,
                color: "#FBBF24",
                background: "rgba(245,158,11,0.10)",
                padding: "2px 7px",
                borderRadius: 4,
              }}>
                {externalItems.length}
              </span>
            </button>
            {showExternal ? (
              externalItems.length === 0 ? (
                <div style={{ padding: "12px 14px", fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
                  No external pull requests match this filter.
                </div>
              ) : (
                externalItems.map((item) => {
                  const selected = item.id === selectedItemId;
                  const sc = stateColor(item.state);
                  const ago = timeAgo(item.updatedAt);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleSelectItem(item)}
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
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
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
                        <span style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: COLORS.textPrimary,
                          fontFamily: SANS_FONT,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          flex: 1,
                          minWidth: 0,
                        }}>
                          {item.title}
                        </span>
                        {ago ? (
                          <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim, flexShrink: 0 }}>
                            {ago}
                          </span>
                        ) : null}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 30 }}>
                        <span style={stateBadgeStyle(item)}>{item.state}</span>
                        <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
                          {item.repoOwner}/{item.repoName} #{item.githubPrNumber}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void window.ade.app.openExternal(item.githubUrl);
                          }}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            marginLeft: "auto",
                            padding: 0,
                            background: "transparent",
                            border: "none",
                            cursor: "pointer",
                            color: COLORS.textDim,
                            transition: "color 100ms ease",
                          }}
                          title="Open on GitHub"
                          onMouseEnter={(e) => { e.currentTarget.style.color = COLORS.textSecondary; }}
                          onMouseLeave={(e) => { e.currentTarget.style.color = COLORS.textDim; }}
                        >
                          <ArrowSquareOut size={13} />
                        </button>
                      </div>
                    </button>
                  );
                })
              )
            ) : null}
          </div>
        </div>

        {/* Detail pane */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
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

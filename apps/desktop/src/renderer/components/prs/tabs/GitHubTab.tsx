import React from "react";
import { ArrowsClockwise, CaretDown, CaretRight, GithubLogo, Link, Warning } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type { GitHubPrListItem, GitHubPrSnapshot, LaneSummary, MergeMethod } from "../../../../shared/types";
import { EmptyState } from "../../ui/EmptyState";
import { COLORS, LABEL_STYLE, MONO_FONT, cardStyle, inlineBadge, outlineButton, primaryButton } from "../../lanes/laneDesignTokens";
import { PrDetailPane } from "../detail/PrDetailPane";
import { usePrs } from "../state/PrsContext";

type GitHubTabProps = {
  lanes: LaneSummary[];
  mergeMethod: MergeMethod;
  selectedPrId: string | null;
  onSelectPr: (id: string | null) => void;
  onRefreshAll: () => Promise<void>;
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

function matchesFilter(item: GitHubPrListItem, filter: GitHubFilter): boolean {
  if (filter === "all") return true;
  if (filter === "open") return item.state === "open" || item.state === "draft";
  return item.state === filter;
}

function stateBadge(item: GitHubPrListItem): React.CSSProperties {
  if (item.state === "merged") return inlineBadge(COLORS.success);
  if (item.state === "closed") return inlineBadge(COLORS.textMuted);
  if (item.state === "draft") return inlineBadge(COLORS.warning);
  return inlineBadge(COLORS.accent);
}

function workflowBadge(item: GitHubPrListItem): React.CSSProperties | null {
  if (item.adeKind === "integration") return inlineBadge(COLORS.warning);
  if (item.adeKind === "queue") return inlineBadge(COLORS.info);
  if (item.adeKind === "single") return inlineBadge(COLORS.textSecondary);
  return null;
}

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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "auto", padding: 20, gap: 16, backdropFilter: "blur(20px)" }}>
      <div style={cardStyle()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span style={{ ...stateBadge(item), flexShrink: 0 }}>{item.state}</span>
              {workflowBadge(item) ? <span style={workflowBadge(item)!}>{item.adeKind}</span> : null}
              {item.scope === "external" ? <span style={inlineBadge(COLORS.textMuted)}>external</span> : null}
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, color: COLORS.textPrimary, fontFamily: "'Space Grotesk', sans-serif" }}>
              {item.title}
            </div>
            <div style={{ marginTop: 6, fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>
              {item.repoOwner}/{item.repoName} #{item.githubPrNumber}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void window.ade.app.openExternal(item.githubUrl)}
            style={outlineButton({ flexShrink: 0 })}
          >
            <GithubLogo size={14} /> Open On GitHub
          </button>
        </div>
      </div>

      <div style={{ ...cardStyle(), display: "grid", gap: 12 }}>
        <div>
          <div style={LABEL_STYLE}>ADE STATUS</div>
          {item.linkedPrId ? (
            <div style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textSecondary }}>
              Linked to {item.linkedLaneName ?? item.linkedLaneId ?? "lane"}.
            </div>
          ) : item.scope === "external" ? (
            <div style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textSecondary }}>
              External pull request. ADE can open it on GitHub, but it is not modeled as a local lane-backed item.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, color: COLORS.warning }}>
                <Warning size={16} weight="fill" style={{ marginTop: 2, flexShrink: 0 }} />
                <div style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: 1.6 }}>
                  This repo PR exists on GitHub but is not linked to an ADE lane yet.
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
                    fontFamily: MONO_FONT,
                    fontSize: 11,
                    padding: "0 10px",
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
                  style={primaryButton({ opacity: !linkLaneId || linkingBusy ? 0.5 : 1 })}
                >
                  <Link size={14} /> {linkingBusy ? "Linking..." : "Link / Import"}
                </button>
              </div>
            </div>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
          <div>
            <div style={LABEL_STYLE}>HEAD</div>
            <div style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textSecondary }}>{item.headBranch ?? "---"}</div>
          </div>
          <div>
            <div style={LABEL_STYLE}>BASE</div>
            <div style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textSecondary }}>{item.baseBranch ?? "---"}</div>
          </div>
          <div>
            <div style={LABEL_STYLE}>AUTHOR</div>
            <div style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textSecondary }}>{item.author ?? "---"}</div>
          </div>
          <div>
            <div style={LABEL_STYLE}>UPDATED</div>
            <div style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textSecondary }}>{formatTimestampLabel(item.updatedAt)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function GitHubTab({ lanes, mergeMethod, selectedPrId, onSelectPr, onRefreshAll }: GitHubTabProps) {
  const navigate = useNavigate();
  const {
    prs,
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
  const lastHandledSelectedPrIdRef = React.useRef<string | null | undefined>(undefined);
  const pendingSelectedItemIdRef = React.useRef<string | null>(null);

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

  const repoItems = React.useMemo(
    () => (snapshot?.repoPullRequests ?? []).filter((item) => matchesFilter(item, filter)),
    [snapshot, filter],
  );
  const externalItems = React.useMemo(
    () => (snapshot?.externalPullRequests ?? []).filter((item) => matchesFilter(item, filter)),
    [snapshot, filter],
  );

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

  const handleSync = React.useCallback(async () => {
    await Promise.all([
      onRefreshAll().catch(() => {}),
      loadSnapshot({ force: true }),
    ]);
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
        <div style={{ ...LABEL_STYLE, color: COLORS.textMuted }}>SYNCING GITHUB...</div>
      </div>
    );
  }

  if (error && !snapshot) {
    return <EmptyState title="GitHub" description={error} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {(["open", "closed", "merged", "all"] as GitHubFilter[]).map((state) => {
            const active = filter === state;
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
                style={active ? primaryButton({ height: 28, padding: "0 10px" }) : outlineButton({ height: 28, padding: "0 10px" })}
              >
                {state}
              </button>
            );
          })}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>
            {snapshot?.repo ? `${snapshot.repo.owner}/${snapshot.repo.name}` : "No repo detected"}
            {snapshot?.syncedAt ? ` · synced ${formatTimestampLabel(snapshot.syncedAt)}` : ""}
          </div>
          <button type="button" onClick={() => void handleSync()} style={outlineButton({ height: 28, padding: "0 10px" })}>
            <ArrowsClockwise size={14} /> Sync GitHub
          </button>
        </div>
      </div>

      {error ? (
        <div style={{ padding: "10px 16px", borderBottom: "1px solid rgba(239,68,68,0.2)", background: "rgba(239,68,68,0.06)", color: COLORS.danger, fontFamily: MONO_FONT, fontSize: 11, borderRadius: 0 }}>
          {error}
        </div>
      ) : null}

      <div style={{ display: "flex", minHeight: 0, flex: 1 }}>
        <div style={{ width: 360, borderRight: "1px solid rgba(255,255,255,0.06)", overflow: "auto", flexShrink: 0 }}>
          <div style={{ padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
            <div style={LABEL_STYLE}>Repo Pull Requests</div>
            <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>{repoItems.length} visible</div>
          </div>

          {repoItems.length === 0 ? (
            <div style={{ padding: 20 }}>
              <EmptyState title="No pull requests" description="No pull requests match the current GitHub filter." />
            </div>
          ) : (
            repoItems.map((item) => {
              const selected = item.id === selectedItemId;
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
                    padding: "12px 14px",
                    textAlign: "left",
                    border: "none",
                    borderLeft: selected ? "3px solid #A78BFA" : "3px solid transparent",
                    borderBottom: "1px solid rgba(255,255,255,0.04)",
                    background: selected ? "rgba(167, 139, 250, 0.08)" : "transparent",
                    cursor: "pointer",
                    transition: "background 150ms ease",
                  }}
                  onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "rgba(255,255,255,0.03)"; }}
                  onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>#{item.githubPrNumber}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "'Space Grotesk', sans-serif" }}>
                      {item.title}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                    <span style={stateBadge(item)}>{item.state}</span>
                    {workflowBadge(item) ? <span style={workflowBadge(item)!}>{item.adeKind}</span> : null}
                    {item.linkedLaneName ? <span style={inlineBadge(COLORS.textSecondary)}>{item.linkedLaneName}</span> : <span style={inlineBadge(COLORS.warning)}>unmapped</span>}
                    {item.cleanupState === "required" ? <span style={inlineBadge(COLORS.warning)}>cleanup available</span> : null}
                  </div>
                </button>
              );
            })
          )}

          <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
            <button
              type="button"
              onClick={() => setShowExternal((value) => !value)}
              style={{
                display: "flex",
                width: "100%",
                alignItems: "center",
                gap: 8,
                padding: "12px 14px",
                border: "none",
                borderBottom: "1px solid rgba(255,255,255,0.04)",
                background: "transparent",
                cursor: "pointer",
                color: COLORS.textPrimary,
                fontFamily: MONO_FONT,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "1px",
                textTransform: "uppercase",
                transition: "background 150ms ease",
              }}
            >
              {showExternal ? <CaretDown size={14} /> : <CaretRight size={14} />}
              External / Unmapped
              <span style={{ marginLeft: "auto", color: COLORS.textMuted }}>{externalItems.length}</span>
            </button>
            {showExternal ? (
              externalItems.length === 0 ? (
                <div style={{ padding: "12px 14px", fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>
                  No external pull requests match this filter.
                </div>
              ) : (
                externalItems.map((item) => {
                  const selected = item.id === selectedItemId;
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
                        padding: "12px 14px",
                        textAlign: "left",
                        border: "none",
                        borderLeft: selected ? "3px solid #A78BFA" : "3px solid transparent",
                        borderBottom: "1px solid rgba(255,255,255,0.04)",
                        background: selected ? "rgba(167, 139, 250, 0.08)" : "transparent",
                        cursor: "pointer",
                        transition: "background 150ms ease",
                      }}
                      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "rgba(255,255,255,0.03)"; }}
                      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
                    >
                      <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary, fontFamily: "'Space Grotesk', sans-serif" }}>{item.title}</div>
                      <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>
                        {item.repoOwner}/{item.repoName} #{item.githubPrNumber}
                      </div>
                    </button>
                  );
                })
              )
            ) : null}
          </div>
        </div>

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
              onTabChange={() => {}}
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

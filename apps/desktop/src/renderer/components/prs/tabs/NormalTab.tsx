import React from "react";
import { ArrowRight, Eye, Sparkle, Trash, GitBranch, GitMerge, Plus, Minus, CheckCircle, XCircle, Circle, GithubLogo, CircleNotch } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type {
  LandResult,
  MergeMethod,
  PrCheck,
  PrMergeContext,
  PrReview,
  PrSummary,
  PrWithConflicts,
  LaneSummary,
} from "../../../../shared/types";
import { EmptyState } from "../../ui/EmptyState";
import { PaneTilingLayout, type PaneConfig } from "../../ui/PaneTilingLayout";
import { PrConflictBadge } from "../PrConflictBadge";
import { PrRebaseBanner } from "../PrRebaseBanner";
import { ResolverTerminalModal } from "../../shared/conflictResolver/ResolverTerminalModal";
import { usePrs } from "../state/PrsContext";
import { COLORS, LABEL_STYLE, inlineBadge } from "../../lanes/laneDesignTokens";
import { PR_TAB_TILING_TREE } from "../shared/tilingConstants";
import { normalizeBranchName, type BackgroundResolverSession } from "../shared/prHelpers";

/* ---- Badge helpers ---- */

function colorBadge(color: string): { color: string; bg: string; border: string } {
  return { color, bg: `${color}18`, border: `${color}30` };
}

function stateChip(state: PrSummary["state"]): { label: string; color: string; bg: string; border: string } {
  if (state === "draft") return { label: "DRAFT", ...colorBadge(COLORS.accent) };
  if (state === "open") return { label: "OPEN", ...colorBadge(COLORS.info) };
  if (state === "merged") return { label: "MERGED", ...colorBadge(COLORS.success) };
  return { label: "CLOSED", ...colorBadge(COLORS.textSecondary) };
}

function checksChip(status: PrSummary["checksStatus"]): { label: string; color: string; bg: string; border: string } {
  if (status === "passing") return { label: "CHECKS", ...colorBadge(COLORS.success) };
  if (status === "failing") return { label: "CHECKS", ...colorBadge(COLORS.danger) };
  if (status === "pending") return { label: "CHECKS", ...colorBadge(COLORS.warning) };
  return { label: "CHECKS", ...colorBadge(COLORS.textMuted) };
}

function reviewsChip(status: PrSummary["reviewStatus"]): { label: string; color: string; bg: string; border: string } {
  if (status === "approved") return { label: "APPROVED", ...colorBadge(COLORS.success) };
  if (status === "changes_requested") return { label: "CHANGES", ...colorBadge(COLORS.warning) };
  if (status === "requested") return { label: "REVIEW", ...colorBadge(COLORS.info) };
  return { label: "REVIEW", ...colorBadge(COLORS.textMuted) };
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function InlineBadge({ label, color, bg, border }: { label: string; color: string; bg: string; border: string }) {
  return (
    <span style={inlineBadge(color, { background: bg, border: `1px solid ${border}` })}>
      {label}
    </span>
  );
}

/* ---- Check status icon ---- */

function CheckStatusIcon({ check }: { check: PrCheck }) {
  if (check.status === "completed") {
    if (check.conclusion === "success") return <CheckCircle size={14} weight="fill" style={{ color: COLORS.success }} />;
    if (check.conclusion === "failure") return <XCircle size={14} weight="fill" style={{ color: COLORS.danger }} />;
    if (check.conclusion === "skipped" || check.conclusion === "cancelled") return <Circle size={14} weight="regular" style={{ color: COLORS.textMuted }} />;
    return <CheckCircle size={14} weight="regular" style={{ color: COLORS.textSecondary }} />;
  }
  if (check.status === "in_progress") return <Circle size={14} weight="fill" style={{ color: COLORS.warning }} />;
  return <Circle size={14} weight="regular" style={{ color: COLORS.textMuted }} />;
}

/* ---- Review status label ---- */

function reviewStateLabel(state: PrReview["state"]): { label: string; color: string } {
  if (state === "approved") return { label: "APPROVED", color: COLORS.success };
  if (state === "changes_requested") return { label: "CHANGES REQUESTED", color: COLORS.warning };
  if (state === "commented") return { label: "COMMENTED", color: COLORS.info };
  if (state === "dismissed") return { label: "DISMISSED", color: COLORS.textMuted };
  return { label: "PENDING", color: COLORS.textSecondary };
}

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

export function NormalTab({ prs, lanes, mergeContextByPrId: _mergeContextByPrId, mergeMethod, selectedPrId, onSelectPr, onRefresh }: NormalTabProps) {
  const navigate = useNavigate();
  const laneById = React.useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);

  const {
    detailStatus,
    detailChecks,
    detailReviews,
    detailBusy,
    rebaseNeeds,
    autoRebaseStatuses,
    setActiveTab,
    resolverModel,
    resolverReasoningLevel,
    setResolverModel,
    setResolverReasoningLevel
  } = usePrs();

  const [actionBusy, setActionBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [actionResult, setActionResult] = React.useState<LandResult | null>(null);
  const [resolverOpen, setResolverOpen] = React.useState(false);
  const [backgroundSession, setBackgroundSession] = React.useState<BackgroundResolverSession | null>(null);
  const [deleteConfirm, setDeleteConfirm] = React.useState(false);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [deleteCloseGh, setDeleteCloseGh] = React.useState(false);

  const selectedPr = React.useMemo(() => prs.find((p) => p.id === selectedPrId) ?? null, [prs, selectedPrId]);

  // Auto-select first PR (guard against no-op updates when list is empty and nothing selected)
  React.useEffect(() => {
    if (prs.length === 0 && selectedPrId === null) return;
    if (selectedPrId && prs.some((p) => p.id === selectedPrId)) return;
    onSelectPr(prs[0]?.id ?? null);
  }, [prs, selectedPrId, onSelectPr]);

  React.useEffect(() => {
    setActionBusy(false);
    setActionError(null);
    setActionResult(null);
    setDeleteConfirm(false);
    setBackgroundSession(null);
  }, [selectedPrId]);

  React.useEffect(() => {
    if (!backgroundSession?.ptyId) return;
    const unsubscribe = window.ade.pty.onExit((event) => {
      if (event.ptyId !== backgroundSession.ptyId) return;
      setBackgroundSession((prev) => {
        if (!prev || prev.ptyId !== event.ptyId) return prev;
        return { ...prev, exitCode: event.exitCode ?? -1 };
      });
    });
    return unsubscribe;
  }, [backgroundSession?.ptyId]);

  const resolverTargetLaneId = React.useMemo(() => {
    if (!selectedPr) return null;
    return lanes.find((l) => normalizeBranchName(l.branchRef) === normalizeBranchName(selectedPr.baseBranch))?.id ?? null;
  }, [lanes, selectedPr]);

  const handleMerge = async () => {
    if (!selectedPr) return;
    setActionBusy(true); setActionError(null); setActionResult(null);
    try {
      const res = await window.ade.prs.land({ prId: selectedPr.id, method: mergeMethod });
      setActionResult(res);
      await onRefresh();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally { setActionBusy(false); }
  };

  const handleDelete = async () => {
    if (!selectedPr) return;
    setDeleteBusy(true); setActionError(null);
    try {
      await window.ade.prs.delete({ prId: selectedPr.id, closeOnGitHub: deleteCloseGh });
      setDeleteConfirm(false);
      onSelectPr(null);
      await onRefresh();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally { setDeleteBusy(false); }
  };

  const paneConfigs: Record<string, PaneConfig> = React.useMemo(() => ({
    list: {
      title: "Normal PRs",
      bodyClassName: "overflow-auto",
      children: (
        <div style={{ background: "#0F0D14", minHeight: "100%" }}>
          {/* Panel header label */}
          <div style={{ padding: "14px 16px 8px 16px" }}>
            <span style={LABEL_STYLE}>NORMAL PRS</span>
          </div>

          {!prs.length ? (
            <div style={{ padding: "16px" }}>
              <EmptyState title="No normal PRs" description="Create a PR from a lane or link an existing GitHub PR." />
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {prs.map((pr) => {
                const laneName = laneById.get(pr.laneId)?.name ?? pr.laneId;
                const isSelected = pr.id === selectedPrId;
                const sc = stateChip(pr.state);
                const cc = checksChip(pr.checksStatus);
                return (
                  <button
                    key={pr.id}
                    type="button"
                    onClick={() => onSelectPr(pr.id)}
                    style={{
                      display: "flex",
                      width: "100%",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: 8,
                      padding: "10px 14px",
                      textAlign: "left",
                      fontSize: 12,
                      border: "none",
                      borderLeft: isSelected ? "3px solid #A78BFA" : "3px solid transparent",
                      background: isSelected ? "#A78BFA12" : "transparent",
                      cursor: "pointer",
                      borderBottom: "1px solid #1E1B26",
                      transition: "background 100ms",
                    }}
                    onMouseEnter={(e) => { if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = "#13101A"; }}
                    onMouseLeave={(e) => { if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#71717A" }}>
                          #{pr.githubPrNumber}
                        </span>
                        <span style={{ fontWeight: 600, color: "#FAFAFA", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {pr.title}
                        </span>
                      </div>
                      <div style={{ marginTop: 4, fontSize: 11, color: "#71717A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {laneName}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, marginTop: 2 }}>
                      <PrConflictBadge riskLevel={pr.conflictAnalysis?.riskLevel ?? null} overlappingFileCount={pr.conflictAnalysis?.overlapCount} />
                      <InlineBadge {...cc} />
                      <InlineBadge {...sc} />
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ),
    },
    detail: {
      title: selectedPr ? `#${selectedPr.githubPrNumber} ${selectedPr.title}` : "PR Detail",
      icon: Eye,
      bodyClassName: "overflow-auto",
      children: selectedPr ? (
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 20, background: "#0F0D14" }}>

          <PrRebaseBanner laneId={selectedPr.laneId} rebaseNeeds={rebaseNeeds} autoRebaseStatuses={autoRebaseStatuses} onTabChange={(tab) => setActiveTab(tab as "normal" | "queue" | "integration" | "rebase")} />

          {/* ===== TOP HEADER CARD ===== */}
          <div style={{ background: "#13101A", border: "1px solid #1E1B26", padding: 20 }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 16, color: "#71717A" }}>
                    #{selectedPr.githubPrNumber}
                  </span>
                  <span style={{ fontSize: 18, fontWeight: 700, color: "#FAFAFA", fontFamily: "Space Grotesk, sans-serif", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {selectedPr.title}
                  </span>
                </div>
                <div style={{ marginTop: 6, fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#71717A" }}>
                  {selectedPr.repoOwner}/{selectedPr.repoName}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                <InlineBadge {...stateChip(selectedPr.state)} />
                <InlineBadge {...checksChip(selectedPr.checksStatus)} />
                <InlineBadge {...reviewsChip(selectedPr.reviewStatus)} />
              </div>
            </div>
          </div>

          {/* ===== PR METADATA ===== */}
          <div style={{ background: "#13101A", border: "1px solid #1E1B26", padding: 20 }}>
            <div style={{ ...LABEL_STYLE, marginBottom: 14 }}>PR METADATA</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
              <div style={{ background: "#0C0A10", padding: 12 }}>
                <div style={{ ...LABEL_STYLE, marginBottom: 6 }}>BASE</div>
                <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#FAFAFA", display: "flex", alignItems: "center", gap: 6 }}>
                  <GitBranch size={14} style={{ color: "#A78BFA" }} />
                  {selectedPr.baseBranch}
                </div>
              </div>
              <div style={{ background: "#0C0A10", padding: 12 }}>
                <div style={{ ...LABEL_STYLE, marginBottom: 6 }}>HEAD</div>
                <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#FAFAFA", display: "flex", alignItems: "center", gap: 6 }}>
                  <GitBranch size={14} style={{ color: "#A78BFA" }} />
                  {selectedPr.headBranch}
                </div>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
              <div style={{ background: "#0C0A10", padding: 12 }}>
                <div style={{ ...LABEL_STYLE, marginBottom: 6 }}>CREATED</div>
                <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#FAFAFA", fontVariantNumeric: "tabular-nums" }}>
                  {formatTimestamp(selectedPr.createdAt)}
                </div>
              </div>
              <div style={{ background: "#0C0A10", padding: 12 }}>
                <div style={{ ...LABEL_STYLE, marginBottom: 6 }}>UPDATED</div>
                <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#FAFAFA", fontVariantNumeric: "tabular-nums" }}>
                  {formatTimestamp(selectedPr.updatedAt)}
                </div>
              </div>
              <div style={{ background: "#0C0A10", padding: 12 }}>
                <div style={{ ...LABEL_STYLE, marginBottom: 6 }}>ADDITIONS</div>
                <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#22C55E", display: "flex", alignItems: "center", gap: 4 }}>
                  <Plus size={12} weight="bold" />
                  {selectedPr.additions}
                </div>
              </div>
              <div style={{ background: "#0C0A10", padding: 12 }}>
                <div style={{ ...LABEL_STYLE, marginBottom: 6 }}>DELETIONS</div>
                <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#EF4444", display: "flex", alignItems: "center", gap: 4 }}>
                  <Minus size={12} weight="bold" />
                  {selectedPr.deletions}
                </div>
              </div>
            </div>
          </div>

          {/* ===== GITHUB SIGNALS ===== */}
          <div style={{ background: "#13101A", border: "1px solid #1E1B26", padding: 20 }}>
            <div style={{ ...LABEL_STYLE, marginBottom: 14 }}>GITHUB SIGNALS</div>
            {detailBusy ? (
              <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#71717A" }}>Loading...</div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
                {/* Mergeable */}
                <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "10px 0" }}>
                  <span style={LABEL_STYLE}>MERGEABLE</span>
                  <span style={{
                    fontFamily: "JetBrains Mono, monospace",
                    fontSize: 13,
                    fontWeight: 700,
                    color: detailStatus?.isMergeable ? "#22C55E" : detailStatus ? "#EF4444" : "#71717A",
                  }}>
                    {detailStatus ? (detailStatus.isMergeable ? "YES" : "NO") : "---"}
                  </span>
                </div>
                <div style={{ width: 1, height: 36, background: "#1E1B26" }} />
                {/* Conflicts */}
                <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "10px 0" }}>
                  <span style={LABEL_STYLE}>CONFLICTS</span>
                  <span style={{
                    fontFamily: "JetBrains Mono, monospace",
                    fontSize: 13,
                    fontWeight: 700,
                    color: detailStatus?.mergeConflicts ? "#EF4444" : detailStatus ? "#22C55E" : "#71717A",
                  }}>
                    {detailStatus ? (detailStatus.mergeConflicts ? "YES" : "NO") : "---"}
                  </span>
                </div>
                <div style={{ width: 1, height: 36, background: "#1E1B26" }} />
                {/* Behind base */}
                <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "10px 0" }}>
                  <span style={LABEL_STYLE}>BEHIND BASE</span>
                  <span style={{
                    fontFamily: "JetBrains Mono, monospace",
                    fontSize: 13,
                    fontWeight: 700,
                    color: (detailStatus?.behindBaseBy ?? 0) > 0 ? "#F59E0B" : detailStatus ? "#FAFAFA" : "#71717A",
                  }}>
                    {detailStatus?.behindBaseBy ?? 0}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* ===== CI CHECKS ===== */}
          <div style={{ background: "#13101A", border: "1px solid #1E1B26", padding: 20 }}>
            <div style={{ ...LABEL_STYLE, marginBottom: 14 }}>CI CHECKS</div>
            {detailBusy ? (
              <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#71717A" }}>Loading...</div>
            ) : detailChecks.length === 0 ? (
              <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#52525B" }}>No checks found</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                {detailChecks.map((check, idx) => (
                  <div
                    key={`${check.name}-${idx}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "8px 0",
                      borderBottom: idx < detailChecks.length - 1 ? "1px solid #1E1B26" : "none",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <CheckStatusIcon check={check} />
                      <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#FAFAFA" }}>
                        {check.name}
                      </span>
                    </div>
                    <span style={{
                      fontSize: 10,
                      fontWeight: 700,
                      fontFamily: "JetBrains Mono, monospace",
                      textTransform: "uppercase",
                      letterSpacing: "1px",
                      color: check.conclusion === "success" ? "#22C55E"
                        : check.conclusion === "failure" ? "#EF4444"
                        : check.status === "in_progress" ? "#F59E0B"
                        : "#71717A",
                    }}>
                      {check.conclusion ?? check.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ===== REVIEWS ===== */}
          <div style={{ background: "#13101A", border: "1px solid #1E1B26", padding: 20 }}>
            <div style={{ ...LABEL_STYLE, marginBottom: 14 }}>REVIEWS</div>
            {detailBusy ? (
              <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#71717A" }}>Loading...</div>
            ) : detailReviews.length === 0 ? (
              <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#52525B" }}>No reviews yet</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                {detailReviews.map((review, idx) => {
                  const rs = reviewStateLabel(review.state);
                  return (
                    <div
                      key={`${review.reviewer}-${idx}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "8px 0",
                        borderBottom: idx < detailReviews.length - 1 ? "1px solid #1E1B26" : "none",
                      }}
                    >
                      <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#FAFAFA" }}>
                        {review.reviewer}
                      </span>
                      <span style={{
                        fontSize: 10,
                        fontWeight: 700,
                        fontFamily: "JetBrains Mono, monospace",
                        textTransform: "uppercase",
                        letterSpacing: "1px",
                        color: rs.color,
                      }}>
                        {rs.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ===== ACTION BAR ===== */}
          <div style={{ background: "#13101A", border: "1px solid #1E1B26", padding: 16 }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              {/* Merge button - green primary when PR is open */}
              {(selectedPr.state === "open" || selectedPr.state === "draft") && (
                <button
                  type="button"
                  disabled={actionBusy || selectedPr.state !== "open"}
                  onClick={() => void handleMerge()}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    height: 32,
                    padding: "0 14px",
                    fontSize: 11,
                    fontWeight: 700,
                    fontFamily: "JetBrains Mono, monospace",
                    textTransform: "uppercase",
                    letterSpacing: "1px",
                    color: "#0F0D14",
                    background: "#22C55E",
                    border: "none",
                    cursor: actionBusy || selectedPr.state !== "open" ? "not-allowed" : "pointer",
                    opacity: actionBusy || selectedPr.state !== "open" ? 0.4 : 1,
                    transition: "opacity 100ms",
                  }}
                >
                  <GitMerge size={14} weight="bold" />
                  {actionBusy ? "MERGING..." : "MERGE PR"}
                </button>
              )}

              {/* Open in GitHub */}
              <button
                type="button"
                onClick={() => void window.ade.prs.openInGitHub(selectedPr.id)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  height: 32,
                  padding: "0 14px",
                  fontSize: 11,
                  fontWeight: 700,
                  fontFamily: "JetBrains Mono, monospace",
                  textTransform: "uppercase",
                  letterSpacing: "1px",
                  color: "#FAFAFA",
                  background: "transparent",
                  border: "1px solid #27272A",
                  cursor: "pointer",
                }}
              >
                <GithubLogo size={14} weight="regular" />
                OPEN IN GITHUB
              </button>

              {/* View lane */}
              <button
                type="button"
                onClick={() => navigate(`/lanes?laneId=${encodeURIComponent(selectedPr.laneId)}`)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  height: 32,
                  padding: "0 14px",
                  fontSize: 11,
                  fontWeight: 700,
                  fontFamily: "JetBrains Mono, monospace",
                  textTransform: "uppercase",
                  letterSpacing: "1px",
                  color: "#FAFAFA",
                  background: "transparent",
                  border: "1px solid #27272A",
                  cursor: "pointer",
                }}
              >
                <ArrowRight size={14} weight="regular" />
                VIEW LANE
              </button>

              {/* Rerun with AI */}
              <button
                type="button"
                disabled={actionBusy}
                onClick={() => setResolverOpen(true)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  height: 32,
                  padding: "0 14px",
                  fontSize: 11,
                  fontWeight: 700,
                  fontFamily: "JetBrains Mono, monospace",
                  textTransform: "uppercase",
                  letterSpacing: "1px",
                  color: "#A78BFA",
                  background: "transparent",
                  border: "1px solid #A78BFA30",
                  cursor: actionBusy ? "not-allowed" : "pointer",
                  opacity: actionBusy ? 0.4 : 1,
                }}
              >
                <Sparkle size={14} weight="regular" />
                RERUN WITH AI
              </button>

              {/* Remove PR - danger */}
              <button
                type="button"
                onClick={() => setDeleteConfirm(true)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  height: 32,
                  padding: "0 14px",
                  fontSize: 11,
                  fontWeight: 700,
                  fontFamily: "JetBrains Mono, monospace",
                  textTransform: "uppercase",
                  letterSpacing: "1px",
                  color: "#EF4444",
                  background: "transparent",
                  border: "1px solid #EF444430",
                  cursor: "pointer",
                  marginLeft: "auto",
                }}
              >
                <Trash size={14} weight="regular" />
                REMOVE PR
              </button>
            </div>

            {backgroundSession && !resolverOpen ? (
              <div
                className="flex items-center justify-between gap-2"
                style={{ marginTop: 10, padding: "8px 10px", background: "#A78BFA10", border: "1px solid #A78BFA30" }}
              >
                <div className="flex items-center gap-2" style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#A1A1AA" }}>
                  {backgroundSession.exitCode == null ? (
                    <CircleNotch size={12} className="animate-spin" style={{ color: "#A78BFA" }} />
                  ) : (
                    <CheckCircle size={12} style={{ color: backgroundSession.exitCode === 0 ? "#22C55E" : "#F59E0B" }} />
                  )}
                  {backgroundSession.exitCode == null
                    ? "AI resolver running in background."
                    : (backgroundSession.exitCode === 0 ? "Background AI resolver finished." : "Background AI resolver exited with errors.")}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setResolverOpen(true)}
                    style={{
                      height: 26,
                      padding: "0 10px",
                      fontSize: 10,
                      fontWeight: 700,
                      fontFamily: "JetBrains Mono, monospace",
                      letterSpacing: "1px",
                      color: "#A78BFA",
                      border: "1px solid #A78BFA30",
                      background: "transparent",
                      cursor: "pointer",
                    }}
                  >
                    REOPEN RUN
                  </button>
                  {backgroundSession.exitCode != null ? (
                    <button
                      type="button"
                      onClick={() => setBackgroundSession(null)}
                      style={{
                        height: 26,
                        padding: "0 10px",
                        fontSize: 10,
                        fontWeight: 700,
                        fontFamily: "JetBrains Mono, monospace",
                        letterSpacing: "1px",
                        color: "#71717A",
                        border: "1px solid #27272A",
                        background: "transparent",
                        cursor: "pointer",
                      }}
                    >
                      DISMISS
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {/* Delete confirmation */}
            {deleteConfirm && (
              <div style={{ marginTop: 12, background: "#EF444408", border: "1px solid #EF444420", padding: 14 }}>
                <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, fontWeight: 600, color: "#EF4444", marginBottom: 10 }}>
                  Remove this PR from ADE?
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontFamily: "JetBrains Mono, monospace", color: "#A1A1AA", cursor: "pointer", marginBottom: 10 }}>
                  <input type="checkbox" checked={deleteCloseGh} onChange={(e) => setDeleteCloseGh(e.target.checked)} />
                  Also close on GitHub
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    type="button"
                    disabled={deleteBusy}
                    onClick={() => void handleDelete()}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      height: 28,
                      padding: "0 12px",
                      fontSize: 11,
                      fontWeight: 700,
                      fontFamily: "JetBrains Mono, monospace",
                      textTransform: "uppercase",
                      letterSpacing: "1px",
                      color: "#EF4444",
                      background: "transparent",
                      border: "1px solid #EF444440",
                      cursor: deleteBusy ? "not-allowed" : "pointer",
                      opacity: deleteBusy ? 0.4 : 1,
                    }}
                  >
                    {deleteBusy ? "REMOVING..." : "CONFIRM REMOVE"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteConfirm(false)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      height: 28,
                      padding: "0 12px",
                      fontSize: 11,
                      fontWeight: 700,
                      fontFamily: "JetBrains Mono, monospace",
                      textTransform: "uppercase",
                      letterSpacing: "1px",
                      color: "#A1A1AA",
                      background: "transparent",
                      border: "1px solid #27272A",
                      cursor: "pointer",
                    }}
                  >
                    CANCEL
                  </button>
                </div>
              </div>
            )}

            {/* Error display */}
            {actionError && (
              <div style={{ marginTop: 10, background: "#EF444408", border: "1px solid #EF444420", padding: "8px 12px", fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#EF4444" }}>
                {actionError}
              </div>
            )}

            {/* Success/failure result */}
            {actionResult && (
              <div style={{
                marginTop: 10,
                background: actionResult.success ? "#22C55E08" : "#EF444408",
                border: `1px solid ${actionResult.success ? "#22C55E20" : "#EF444420"}`,
                padding: "8px 12px",
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 11,
                color: actionResult.success ? "#22C55E" : "#EF4444",
              }}>
                {actionResult.success ? `Merged PR #${actionResult.prNumber}` : `Failed: ${actionResult.error ?? "unknown"}`}
              </div>
            )}
          </div>

          {resolverTargetLaneId ? (
            <ResolverTerminalModal
              open={resolverOpen}
              onOpenChange={setResolverOpen}
              sourceLaneId={selectedPr.laneId}
              targetLaneId={resolverTargetLaneId}
              cwdLaneId={resolverTargetLaneId}
              scenario="single-merge"
              sourceTab="normal"
              initialModel={resolverModel}
              initialReasoningEffort={resolverReasoningLevel}
              onModelChange={(model, effort) => {
                setResolverModel(model);
                setResolverReasoningLevel(effort ?? resolverReasoningLevel);
              }}
              onBackgroundSession={(session) => {
                setBackgroundSession({ ...session, exitCode: null });
              }}
              onCompleted={() => {
                setBackgroundSession(null);
                void onRefresh();
              }}
            />
          ) : null}
        </div>
      ) : (
        <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center", background: "#0F0D14" }}>
          <EmptyState title="No PR selected" description="Select a PR to inspect checks, comments, and merge workflow." />
        </div>
      ),
    },
  }), [prs, selectedPr, selectedPrId, laneById, detailStatus, detailBusy, detailChecks, detailReviews, actionBusy, actionError, actionResult, resolverOpen, resolverTargetLaneId, mergeMethod, deleteConfirm, deleteBusy, deleteCloseGh, rebaseNeeds, autoRebaseStatuses, setActiveTab, navigate, onSelectPr, onRefresh]);

  return <PaneTilingLayout layoutId="prs:normal:v1" tree={PR_TAB_TILING_TREE} panes={paneConfigs} className="flex-1 min-h-0" />;
}

import React from "react";
import {
  GitBranch, GitMerge, GithubLogo, Plus, Minus, CheckCircle, XCircle, Circle,
  CircleNotch, Sparkle, Trash, ArrowRight, Eye, ChatText, Code, ClockCounterClockwise,
  Tag, Users, PencilSimple, X, Check, ArrowsClockwise, Warning, Play,
  CaretDown, CaretRight, Copy, UserCircle,
} from "@phosphor-icons/react";
import type {
  PrWithConflicts, PrCheck, PrReview, PrComment, PrStatus, PrDetail,
  PrFile, PrActionRun, PrActivityEvent, AiReviewSummary,
  LaneSummary, MergeMethod, LandResult,
} from "../../../../shared/types";
import { COLORS, MONO_FONT, LABEL_STYLE, cardStyle, recessedStyle, inlineBadge, outlineButton, primaryButton, dangerButton } from "../../lanes/laneDesignTokens";
import { getPrChecksBadge, getPrReviewsBadge, getPrStateBadge, InlinePrBadge } from "../shared/prVisuals";

// ---- Sub-tab type ----
type DetailTab = "overview" | "files" | "checks" | "activity";

function formatTs(iso: string | null): string {
  if (!iso) return "---";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatTsFull(iso: string | null): string {
  if (!iso) return "---";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ---- Avatar component ----
function Avatar({ user, size = 20 }: { user: { login: string; avatarUrl?: string | null }; size?: number }) {
  return user.avatarUrl ? (
    <img src={user.avatarUrl} alt={user.login} width={size} height={size} style={{ borderRadius: "50%", border: `1px solid ${COLORS.border}` }} />
  ) : (
    <UserCircle size={size} weight="fill" style={{ color: COLORS.textMuted }} />
  );
}

// ---- Check status icon ----
function CheckIcon({ check }: { check: PrCheck }) {
  if (check.status === "completed") {
    if (check.conclusion === "success") return <CheckCircle size={14} weight="fill" style={{ color: COLORS.success }} />;
    if (check.conclusion === "failure") return <XCircle size={14} weight="fill" style={{ color: COLORS.danger }} />;
    return <Circle size={14} weight="regular" style={{ color: COLORS.textMuted }} />;
  }
  if (check.status === "in_progress") return <CircleNotch size={14} className="animate-spin" style={{ color: COLORS.warning }} />;
  return <Circle size={14} weight="regular" style={{ color: COLORS.textMuted }} />;
}

// ---- File status color ----
function fileStatusColor(status: string): string {
  if (status === "added") return COLORS.success;
  if (status === "removed") return COLORS.danger;
  if (status === "modified") return COLORS.warning;
  if (status === "renamed") return COLORS.info;
  return COLORS.textSecondary;
}

function fileStatusLabel(status: string): string {
  if (status === "added") return "A";
  if (status === "removed") return "D";
  if (status === "modified") return "M";
  if (status === "renamed") return "R";
  if (status === "copied") return "C";
  return "?";
}

// ---- Props ----
type PrDetailPaneProps = {
  pr: PrWithConflicts;
  status: PrStatus | null;
  checks: PrCheck[];
  reviews: PrReview[];
  comments: PrComment[];
  detailBusy: boolean;
  lanes: LaneSummary[];
  mergeMethod: MergeMethod;
  onRefresh: () => Promise<void>;
  onNavigate: (path: string) => void;
  onTabChange: (tab: string) => void;
  onShowInGraph?: (laneId: string) => void;
};

export function PrDetailPane({ pr, status, checks, reviews, comments, detailBusy, lanes, mergeMethod, onRefresh, onNavigate, onTabChange, onShowInGraph }: PrDetailPaneProps) {
  const [activeTab, setActiveTab] = React.useState<DetailTab>("overview");
  const [detail, setDetail] = React.useState<PrDetail | null>(null);
  const [files, setFiles] = React.useState<PrFile[]>([]);
  const [actionRuns, setActionRuns] = React.useState<PrActionRun[]>([]);
  const [activity, setActivity] = React.useState<PrActivityEvent[]>([]);
  const [aiSummary, setAiSummary] = React.useState<AiReviewSummary | null>(null);
  const [aiSummaryBusy, setAiSummaryBusy] = React.useState(false);

  // Action states
  const [actionBusy, setActionBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [actionResult, setActionResult] = React.useState<LandResult | null>(null);
  const [commentDraft, setCommentDraft] = React.useState("");
  const [editingTitle, setEditingTitle] = React.useState(false);
  const [titleDraft, setTitleDraft] = React.useState("");
  const [editingBody, setEditingBody] = React.useState(false);
  const [bodyDraft, setBodyDraft] = React.useState("");
  const [labelInput, setLabelInput] = React.useState("");
  const [showLabelEditor, setShowLabelEditor] = React.useState(false);
  const [reviewerInput, setReviewerInput] = React.useState("");
  const [showReviewerEditor, setShowReviewerEditor] = React.useState(false);
  const [showReviewModal, setShowReviewModal] = React.useState(false);
  const [reviewBody, setReviewBody] = React.useState("");
  const [reviewEvent, setReviewEvent] = React.useState<"APPROVE" | "REQUEST_CHANGES" | "COMMENT">("APPROVE");
  const [expandedRun, setExpandedRun] = React.useState<number | null>(null);
  const [expandedFile, setExpandedFile] = React.useState<string | null>(null);

  // Load detail on PR change
  React.useEffect(() => {
    setDetail(null);
    setFiles([]);
    setActionRuns([]);
    setActivity([]);
    setAiSummary(null);
    setActionError(null);
    setActionResult(null);
    setEditingTitle(false);
    setEditingBody(false);
    setShowLabelEditor(false);
    setShowReviewerEditor(false);
    setShowReviewModal(false);

    void loadDetail();
  }, [pr.id]);

  const loadDetail = async () => {
    try {
      const [d, f, a, act] = await Promise.all([
        window.ade.prs.getDetail(pr.id).catch(() => null),
        window.ade.prs.getFiles(pr.id).catch(() => []),
        window.ade.prs.getActionRuns(pr.id).catch(() => []),
        window.ade.prs.getActivity(pr.id).catch(() => []),
      ]);
      setDetail(d);
      setFiles(f);
      setActionRuns(a);
      setActivity(act);
    } catch {
      // silently fail - basic data still available from context
    }
  };

  // ---- Actions ----
  const handleMerge = async () => {
    setActionBusy(true); setActionError(null); setActionResult(null);
    try {
      const res = await window.ade.prs.land({ prId: pr.id, method: mergeMethod });
      setActionResult(res);
      await onRefresh();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally { setActionBusy(false); }
  };

  const handleAddComment = async () => {
    if (!commentDraft.trim()) return;
    setActionBusy(true); setActionError(null);
    try {
      await window.ade.prs.addComment({ prId: pr.id, body: commentDraft });
      setCommentDraft("");
      await onRefresh();
      await loadDetail();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally { setActionBusy(false); }
  };

  const handleUpdateTitle = async () => {
    if (!titleDraft.trim()) return;
    setActionBusy(true); setActionError(null);
    try {
      await window.ade.prs.updateTitle({ prId: pr.id, title: titleDraft });
      setEditingTitle(false);
      await onRefresh();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally { setActionBusy(false); }
  };

  const handleUpdateBody = async () => {
    setActionBusy(true); setActionError(null);
    try {
      await window.ade.prs.updateBody({ prId: pr.id, body: bodyDraft });
      setEditingBody(false);
      await onRefresh();
      await loadDetail();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally { setActionBusy(false); }
  };

  const handleSetLabels = async (labels: string[]) => {
    setActionBusy(true); setActionError(null);
    try {
      await window.ade.prs.setLabels({ prId: pr.id, labels });
      setShowLabelEditor(false);
      await loadDetail();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally { setActionBusy(false); }
  };

  const handleRequestReviewers = async (reviewers: string[]) => {
    setActionBusy(true); setActionError(null);
    try {
      await window.ade.prs.requestReviewers({ prId: pr.id, reviewers });
      setShowReviewerEditor(false);
      await onRefresh();
      await loadDetail();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally { setActionBusy(false); }
  };

  const handleSubmitReview = async () => {
    setActionBusy(true); setActionError(null);
    try {
      await window.ade.prs.submitReview({ prId: pr.id, event: reviewEvent, body: reviewBody || undefined });
      setShowReviewModal(false);
      setReviewBody("");
      await onRefresh();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally { setActionBusy(false); }
  };

  const handleClosePr = async () => {
    setActionBusy(true); setActionError(null);
    try {
      await window.ade.prs.close({ prId: pr.id });
      await onRefresh();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally { setActionBusy(false); }
  };

  const handleReopenPr = async () => {
    setActionBusy(true); setActionError(null);
    try {
      await window.ade.prs.reopen({ prId: pr.id });
      await onRefresh();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally { setActionBusy(false); }
  };

  const handleRerunChecks = async () => {
    setActionBusy(true); setActionError(null);
    try {
      await window.ade.prs.rerunChecks({ prId: pr.id });
      await onRefresh();
      await loadDetail();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally { setActionBusy(false); }
  };

  const handleAiSummary = async () => {
    setAiSummaryBusy(true);
    try {
      const summary = await window.ade.prs.aiReviewSummary({ prId: pr.id });
      setAiSummary(summary);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally { setAiSummaryBusy(false); }
  };

  const sc = getPrStateBadge(pr.state);
  const cc = getPrChecksBadge(pr.checksStatus);
  const rc = getPrReviewsBadge(pr.reviewStatus);
  const DETAIL_TABS: Array<{ id: DetailTab; label: string; icon: React.ElementType; count?: number }> = [
    { id: "overview", label: "OVERVIEW", icon: Eye },
    { id: "files", label: "FILES", icon: Code, count: files.length },
    { id: "checks", label: "CI / CHECKS", icon: Play, count: checks.length },
    { id: "activity", label: "ACTIVITY", icon: ClockCounterClockwise, count: (comments.length + reviews.length) },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: COLORS.pageBg }}>
      {/* ===== HEADER ===== */}
      <div style={{ padding: "16px 20px", borderBottom: `1px solid ${COLORS.border}`, flexShrink: 0 }}>
        {/* Title row */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            {editingTitle ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void handleUpdateTitle(); if (e.key === "Escape") setEditingTitle(false); }}
                  autoFocus
                  style={{
                    flex: 1, height: 32, padding: "0 10px", fontSize: 16, fontWeight: 700,
                    fontFamily: "'Space Grotesk', sans-serif", color: COLORS.textPrimary,
                    background: COLORS.recessedBg, border: `1px solid ${COLORS.accent}`, outline: "none",
                  }}
                />
                <button type="button" onClick={() => void handleUpdateTitle()} style={outlineButton({ height: 28, padding: "0 8px", color: COLORS.success, borderColor: `${COLORS.success}40` })}>
                  <Check size={14} weight="bold" />
                </button>
                <button type="button" onClick={() => setEditingTitle(false)} style={outlineButton({ height: 28, padding: "0 8px" })}>
                  <X size={14} weight="bold" />
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontFamily: MONO_FONT, fontSize: 16, color: COLORS.textMuted }}>#{pr.githubPrNumber}</span>
                <span style={{ fontSize: 18, fontWeight: 700, color: COLORS.textPrimary, fontFamily: "'Space Grotesk', sans-serif", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {pr.title}
                </span>
                <button
                  type="button"
                  onClick={() => { setTitleDraft(pr.title); setEditingTitle(true); }}
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 2, color: COLORS.textMuted, flexShrink: 0 }}
                  title="Edit title"
                >
                  <PencilSimple size={14} />
                </button>
              </div>
            )}
            <div style={{ marginTop: 4, fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted, display: "flex", alignItems: "center", gap: 8 }}>
              <span>{pr.repoOwner}/{pr.repoName}</span>
              <span style={{ color: COLORS.border }}>|</span>
              <GitBranch size={12} style={{ color: COLORS.accent }} />
              <span>{pr.headBranch}</span>
              <ArrowRight size={10} style={{ color: COLORS.textMuted }} />
              <span>{pr.baseBranch}</span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            <InlinePrBadge {...sc} />
            <InlinePrBadge {...cc} />
            <InlinePrBadge {...rc} />
          </div>
        </div>

        {/* Sub-tab bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 0, marginTop: 14 }}>
          {DETAIL_TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "8px 14px", fontSize: 10, fontWeight: 700, fontFamily: MONO_FONT,
                  textTransform: "uppercase", letterSpacing: "1px",
                  color: isActive ? COLORS.textPrimary : COLORS.textMuted,
                  background: isActive ? `${COLORS.accent}18` : "transparent",
                  borderBottom: isActive ? `2px solid ${COLORS.accent}` : "2px solid transparent",
                  border: "none", borderTop: "none", borderLeft: "none", borderRight: "none",
                  cursor: "pointer", transition: "all 100ms",
                }}
              >
                <Icon size={14} weight={isActive ? "fill" : "regular"} />
                {tab.label}
                {tab.count != null && tab.count > 0 && (
                  <span style={{
                    fontSize: 9, padding: "1px 5px", fontVariantNumeric: "tabular-nums",
                    background: isActive ? `${COLORS.accent}30` : COLORS.border,
                    color: isActive ? COLORS.accent : COLORS.textMuted,
                  }}>
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}

          {/* Right-side action buttons */}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
            <button type="button" onClick={() => void onRefresh()} style={outlineButton({ height: 28, padding: "0 8px" })} title="Refresh">
              <ArrowsClockwise size={14} weight="bold" />
            </button>
            {onShowInGraph ? (
              <button type="button" onClick={() => onShowInGraph(pr.laneId)} style={outlineButton({ height: 28, padding: "0 10px", color: COLORS.info, borderColor: `${COLORS.info}40` })}>
                <GitBranch size={14} /> GRAPH
              </button>
            ) : null}
            <button type="button" onClick={() => void window.ade.prs.openInGitHub(pr.id)} style={outlineButton({ height: 28, padding: "0 10px" })}>
              <GithubLogo size={14} /> GITHUB
            </button>
          </div>
        </div>
      </div>

      {/* ===== ERROR BAR ===== */}
      {actionError && (
        <div style={{ padding: "8px 20px", background: `${COLORS.danger}08`, borderBottom: `1px solid ${COLORS.danger}20`, fontFamily: MONO_FONT, fontSize: 11, color: COLORS.danger, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.danger }}><X size={14} /></button>
        </div>
      )}
      {actionResult && (
        <div style={{
          padding: "8px 20px",
          background: actionResult.success ? `${COLORS.success}08` : `${COLORS.danger}08`,
          borderBottom: `1px solid ${actionResult.success ? `${COLORS.success}20` : `${COLORS.danger}20`}`,
          fontFamily: MONO_FONT, fontSize: 11,
          color: actionResult.success ? COLORS.success : COLORS.danger,
        }}>
          {actionResult.success ? `Merged PR #${actionResult.prNumber}` : `Failed: ${actionResult.error ?? "unknown"}`}
        </div>
      )}

      {/* ===== TAB CONTENT ===== */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {activeTab === "overview" && (
          <OverviewTab
            pr={pr} detail={detail} status={status} checks={checks} reviews={reviews} comments={comments}
            detailBusy={detailBusy} aiSummary={aiSummary} aiSummaryBusy={aiSummaryBusy}
            actionBusy={actionBusy} mergeMethod={mergeMethod}
            commentDraft={commentDraft} setCommentDraft={setCommentDraft}
            editingBody={editingBody} setEditingBody={setEditingBody}
            bodyDraft={bodyDraft} setBodyDraft={setBodyDraft}
            showLabelEditor={showLabelEditor} setShowLabelEditor={setShowLabelEditor}
            labelInput={labelInput} setLabelInput={setLabelInput}
            showReviewerEditor={showReviewerEditor} setShowReviewerEditor={setShowReviewerEditor}
            reviewerInput={reviewerInput} setReviewerInput={setReviewerInput}
            showReviewModal={showReviewModal} setShowReviewModal={setShowReviewModal}
            reviewBody={reviewBody} setReviewBody={setReviewBody}
            reviewEvent={reviewEvent} setReviewEvent={setReviewEvent}
            onMerge={handleMerge} onAddComment={handleAddComment}
            onUpdateBody={handleUpdateBody}
            onSetLabels={handleSetLabels} onRequestReviewers={handleRequestReviewers}
            onSubmitReview={handleSubmitReview}
            onClose={handleClosePr} onReopen={handleReopenPr}
            onAiSummary={handleAiSummary}
            onNavigate={onNavigate}
          />
        )}
        {activeTab === "files" && (
          <FilesTab files={files} expandedFile={expandedFile} setExpandedFile={setExpandedFile} />
        )}
        {activeTab === "checks" && (
          <ChecksTab
            checks={checks} actionRuns={actionRuns} expandedRun={expandedRun}
            setExpandedRun={setExpandedRun} actionBusy={actionBusy}
            onRerunChecks={handleRerunChecks}
          />
        )}
        {activeTab === "activity" && (
          <ActivityTab
            activity={activity} comments={comments} reviews={reviews}
            commentDraft={commentDraft} setCommentDraft={setCommentDraft}
            actionBusy={actionBusy} onAddComment={handleAddComment}
          />
        )}
      </div>
    </div>
  );
}

// ================================================================
// OVERVIEW TAB
// ================================================================

type OverviewTabProps = {
  pr: PrWithConflicts;
  detail: PrDetail | null;
  status: PrStatus | null;
  checks: PrCheck[];
  reviews: PrReview[];
  comments: PrComment[];
  detailBusy: boolean;
  aiSummary: AiReviewSummary | null;
  aiSummaryBusy: boolean;
  actionBusy: boolean;
  mergeMethod: MergeMethod;
  commentDraft: string;
  setCommentDraft: (v: string) => void;
  editingBody: boolean;
  setEditingBody: (v: boolean) => void;
  bodyDraft: string;
  setBodyDraft: (v: string) => void;
  showLabelEditor: boolean;
  setShowLabelEditor: (v: boolean) => void;
  labelInput: string;
  setLabelInput: (v: string) => void;
  showReviewerEditor: boolean;
  setShowReviewerEditor: (v: boolean) => void;
  reviewerInput: string;
  setReviewerInput: (v: string) => void;
  showReviewModal: boolean;
  setShowReviewModal: (v: boolean) => void;
  reviewBody: string;
  setReviewBody: (v: string) => void;
  reviewEvent: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  setReviewEvent: (v: "APPROVE" | "REQUEST_CHANGES" | "COMMENT") => void;
  onMerge: () => void;
  onAddComment: () => void;
  onUpdateBody: () => void;
  onSetLabels: (labels: string[]) => void;
  onRequestReviewers: (reviewers: string[]) => void;
  onSubmitReview: () => void;
  onClose: () => void;
  onReopen: () => void;
  onAiSummary: () => void;
  onNavigate: (path: string) => void;
};

function OverviewTab(props: OverviewTabProps) {
  const { pr, detail, status, checks, reviews, comments, detailBusy, aiSummary, aiSummaryBusy, actionBusy, mergeMethod } = props;

  return (
    <div style={{ display: "flex", gap: 0, height: "100%" }}>
      {/* Main content */}
      <div style={{ flex: 1, minWidth: 0, overflow: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>

        {/* ---- Merge Status Bar ---- */}
        <div style={cardStyle()}>
          <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
            <StatusSignal label="MERGEABLE" value={status?.isMergeable ? "YES" : status ? "NO" : "---"} color={status?.isMergeable ? COLORS.success : status ? COLORS.danger : COLORS.textMuted} />
            <div style={{ width: 1, height: 36, background: COLORS.border }} />
            <StatusSignal label="CONFLICTS" value={status?.mergeConflicts ? "YES" : status ? "NO" : "---"} color={status?.mergeConflicts ? COLORS.danger : status ? COLORS.success : COLORS.textMuted} />
            <div style={{ width: 1, height: 36, background: COLORS.border }} />
            <StatusSignal label="BEHIND" value={String(status?.behindBaseBy ?? 0)} color={(status?.behindBaseBy ?? 0) > 0 ? COLORS.warning : COLORS.textPrimary} />
            <div style={{ width: 1, height: 36, background: COLORS.border }} />
            <StatusSignal label="ADDITIONS" value={`+${pr.additions}`} color={COLORS.success} />
            <div style={{ width: 1, height: 36, background: COLORS.border }} />
            <StatusSignal label="DELETIONS" value={`-${pr.deletions}`} color={COLORS.danger} />
          </div>
        </div>

        {/* ---- PR Description ---- */}
        <div style={cardStyle()}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <span style={LABEL_STYLE}>DESCRIPTION</span>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" onClick={props.onAiSummary} disabled={aiSummaryBusy} style={outlineButton({ height: 26, padding: "0 10px", color: COLORS.accent, borderColor: `${COLORS.accent}40` })}>
                <Sparkle size={12} weight="fill" />
                {aiSummaryBusy ? "ANALYZING..." : "AI REVIEW"}
              </button>
              {!props.editingBody && (
                <button type="button" onClick={() => { props.setBodyDraft(detail?.body ?? ""); props.setEditingBody(true); }} style={outlineButton({ height: 26, padding: "0 8px" })}>
                  <PencilSimple size={12} /> EDIT
                </button>
              )}
            </div>
          </div>
          {props.editingBody ? (
            <div>
              <textarea
                value={props.bodyDraft}
                onChange={(e) => props.setBodyDraft(e.target.value)}
                style={{
                  width: "100%", minHeight: 200, resize: "vertical", padding: 12,
                  fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textPrimary,
                  background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, outline: "none",
                }}
                placeholder="Write PR description (markdown)..."
              />
              <div style={{ display: "flex", gap: 6, marginTop: 8, justifyContent: "flex-end" }}>
                <button type="button" onClick={() => props.setEditingBody(false)} style={outlineButton({ height: 28 })}>CANCEL</button>
                <button type="button" onClick={() => void props.onUpdateBody()} disabled={actionBusy} style={primaryButton({ height: 28 })}>
                  {actionBusy ? "SAVING..." : "SAVE"}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textSecondary, whiteSpace: "pre-wrap", lineHeight: 1.6, maxHeight: 300, overflow: "auto" }}>
              {detail?.body || pr.title || "No description provided."}
            </div>
          )}
        </div>

        {/* ---- AI Review Summary ---- */}
        {aiSummary && (
          <div style={{ ...cardStyle(), borderColor: `${COLORS.accent}40` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <Sparkle size={16} weight="fill" style={{ color: COLORS.accent }} />
              <span style={{ ...LABEL_STYLE, color: COLORS.accent }}>AI REVIEW SUMMARY</span>
              <span style={inlineBadge(
                aiSummary.mergeReadiness === "ready" ? COLORS.success : aiSummary.mergeReadiness === "needs_work" ? COLORS.warning : COLORS.danger,
              )}>
                {aiSummary.mergeReadiness === "ready" ? "READY TO MERGE" : aiSummary.mergeReadiness === "needs_work" ? "NEEDS WORK" : "BLOCKED"}
              </span>
            </div>
            <div style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6, marginBottom: 12 }}>
              {aiSummary.summary}
            </div>
            {aiSummary.potentialIssues.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <span style={{ ...LABEL_STYLE, color: COLORS.warning, marginBottom: 6, display: "block" }}>POTENTIAL ISSUES</span>
                {aiSummary.potentialIssues.map((issue, i) => (
                  <div key={i} style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textSecondary, padding: "4px 0", display: "flex", gap: 6 }}>
                    <Warning size={12} style={{ color: COLORS.warning, flexShrink: 0, marginTop: 2 }} />
                    {issue}
                  </div>
                ))}
              </div>
            )}
            {aiSummary.recommendations.length > 0 && (
              <div>
                <span style={{ ...LABEL_STYLE, color: COLORS.info, marginBottom: 6, display: "block" }}>RECOMMENDATIONS</span>
                {aiSummary.recommendations.map((rec, i) => (
                  <div key={i} style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textSecondary, padding: "4px 0", display: "flex", gap: 6 }}>
                    <CheckCircle size={12} style={{ color: COLORS.info, flexShrink: 0, marginTop: 2 }} />
                    {rec}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ---- Reviews Section ---- */}
        <div style={cardStyle()}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <span style={LABEL_STYLE}>REVIEWS ({reviews.length})</span>
            <button type="button" onClick={() => props.setShowReviewModal(true)} style={outlineButton({ height: 26, padding: "0 10px" })}>
              <Check size={12} weight="bold" /> SUBMIT REVIEW
            </button>
          </div>
          {reviews.length === 0 ? (
            <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textDim }}>No reviews yet</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {reviews.map((review, idx) => (
                <div key={`${review.reviewer}-${idx}`} style={{
                  display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 0",
                  borderBottom: idx < reviews.length - 1 ? `1px solid ${COLORS.border}` : "none",
                }}>
                  <UserCircle size={24} weight="fill" style={{ color: COLORS.textMuted, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontFamily: MONO_FONT, fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }}>{review.reviewer}</span>
                      <span style={inlineBadge(
                        review.state === "approved" ? COLORS.success : review.state === "changes_requested" ? COLORS.warning : COLORS.textMuted,
                      )}>
                        {review.state === "approved" ? "APPROVED" : review.state === "changes_requested" ? "CHANGES REQUESTED" : review.state.toUpperCase()}
                      </span>
                      {review.submittedAt && <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>{formatTs(review.submittedAt)}</span>}
                    </div>
                    {review.body && <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textSecondary, marginTop: 6, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{review.body}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ---- Comments Section ---- */}
        <div style={cardStyle()}>
          <span style={{ ...LABEL_STYLE, marginBottom: 12, display: "block" }}>COMMENTS ({comments.length})</span>
          {comments.length === 0 ? (
            <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textDim, marginBottom: 12 }}>No comments yet</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 0, marginBottom: 12 }}>
              {comments.map((comment, idx) => (
                <div key={comment.id} style={{
                  padding: "10px 0",
                  borderBottom: idx < comments.length - 1 ? `1px solid ${COLORS.border}` : "none",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <UserCircle size={20} weight="fill" style={{ color: COLORS.textMuted }} />
                    <span style={{ fontFamily: MONO_FONT, fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }}>{comment.author}</span>
                    {comment.path && (
                      <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.accent, background: `${COLORS.accent}18`, padding: "1px 6px" }}>{comment.path}{comment.line ? `:${comment.line}` : ""}</span>
                    )}
                    <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>{formatTs(comment.createdAt)}</span>
                  </div>
                  <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textSecondary, lineHeight: 1.5, whiteSpace: "pre-wrap", paddingLeft: 28 }}>
                    {comment.body || "(empty comment)"}
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* Add comment */}
          <div style={{ display: "flex", gap: 8 }}>
            <textarea
              value={props.commentDraft}
              onChange={(e) => props.setCommentDraft(e.target.value)}
              placeholder="Write a comment..."
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void props.onAddComment(); }}
              style={{
                flex: 1, minHeight: 60, resize: "vertical", padding: 10,
                fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textPrimary,
                background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, outline: "none",
              }}
            />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
            <button type="button" onClick={() => void props.onAddComment()} disabled={actionBusy || !props.commentDraft.trim()} style={primaryButton({ height: 28, opacity: actionBusy || !props.commentDraft.trim() ? 0.4 : 1 })}>
              <ChatText size={12} /> COMMENT
            </button>
          </div>
        </div>

        {/* ---- Action Bar ---- */}
        <div style={cardStyle()}>
          <span style={{ ...LABEL_STYLE, marginBottom: 12, display: "block" }}>ACTIONS</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {(pr.state === "open" || pr.state === "draft") && (
              <button type="button" disabled={actionBusy || pr.state !== "open"} onClick={() => void props.onMerge()} style={primaryButton({ background: COLORS.success, borderColor: COLORS.success, opacity: actionBusy || pr.state !== "open" ? 0.4 : 1 })}>
                <GitMerge size={14} weight="bold" /> MERGE ({mergeMethod.toUpperCase()})
              </button>
            )}
            {pr.state === "open" && (
              <button type="button" disabled={actionBusy} onClick={() => void props.onClose()} style={outlineButton({ color: COLORS.danger, borderColor: `${COLORS.danger}40` })}>
                <XCircle size={14} /> CLOSE PR
              </button>
            )}
            {pr.state === "closed" && (
              <button type="button" disabled={actionBusy} onClick={() => void props.onReopen()} style={outlineButton({ color: COLORS.success, borderColor: `${COLORS.success}40` })}>
                <ArrowsClockwise size={14} /> REOPEN PR
              </button>
            )}
            <button type="button" onClick={() => props.onNavigate(`/lanes?laneId=${encodeURIComponent(pr.laneId)}`)} style={outlineButton()}>
              <ArrowRight size={14} /> VIEW LANE
            </button>
          </div>
        </div>
      </div>

      {/* ---- Right Sidebar ---- */}
      <div style={{ width: 240, borderLeft: `1px solid ${COLORS.border}`, overflow: "auto", padding: 16, flexShrink: 0, display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Reviewers */}
        <SidebarSection title="REVIEWERS" onEdit={() => props.setShowReviewerEditor(!props.showReviewerEditor)}>
          {detail?.requestedReviewers?.length ? (
            detail.requestedReviewers.map((r) => (
              <div key={r.login} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 0" }}>
                <Avatar user={r} size={18} />
                <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textPrimary }}>{r.login}</span>
              </div>
            ))
          ) : (
            <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textDim }}>None</span>
          )}
          {props.showReviewerEditor && (
            <div style={{ marginTop: 8 }}>
              <input
                value={props.reviewerInput}
                onChange={(e) => props.setReviewerInput(e.target.value)}
                placeholder="username1, username2"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const reviewers = props.reviewerInput.split(",").map(s => s.trim()).filter(Boolean);
                    if (reviewers.length) void props.onRequestReviewers(reviewers);
                  }
                }}
                style={{ width: "100%", height: 26, padding: "0 8px", fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textPrimary, background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, outline: "none" }}
              />
            </div>
          )}
        </SidebarSection>

        {/* Labels */}
        <SidebarSection title="LABELS" onEdit={() => props.setShowLabelEditor(!props.showLabelEditor)}>
          {detail?.labels?.length ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {detail.labels.map((l) => (
                <span key={l.name} style={{
                  display: "inline-flex", alignItems: "center", padding: "2px 8px",
                  fontSize: 10, fontWeight: 600, fontFamily: MONO_FONT,
                  color: `#${l.color}`, background: `#${l.color}20`,
                  border: `1px solid #${l.color}40`,
                }}>
                  {l.name}
                </span>
              ))}
            </div>
          ) : (
            <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textDim }}>None</span>
          )}
          {props.showLabelEditor && (
            <div style={{ marginTop: 8 }}>
              <input
                value={props.labelInput}
                onChange={(e) => props.setLabelInput(e.target.value)}
                placeholder="bug, enhancement"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const labels = props.labelInput.split(",").map(s => s.trim()).filter(Boolean);
                    if (labels.length) void props.onSetLabels(labels);
                  }
                }}
                style={{ width: "100%", height: 26, padding: "0 8px", fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textPrimary, background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, outline: "none" }}
              />
            </div>
          )}
        </SidebarSection>

        {/* Author */}
        <SidebarSection title="AUTHOR">
          {detail?.author ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Avatar user={detail.author} size={20} />
              <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textPrimary }}>{detail.author.login}</span>
            </div>
          ) : (
            <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textDim }}>---</span>
          )}
        </SidebarSection>

        {/* Quick Stats */}
        <SidebarSection title="STATS">
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <StatRow label="Created" value={formatTsFull(pr.createdAt)} />
            <StatRow label="Updated" value={formatTsFull(pr.updatedAt)} />
            <StatRow label="Checks" value={`${checks.filter(c => c.conclusion === "success").length}/${checks.length} passing`} />
            <StatRow label="Reviews" value={`${reviews.filter(r => r.state === "approved").length} approved`} />
          </div>
        </SidebarSection>
      </div>

      {/* ---- Review Modal ---- */}
      {props.showReviewModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: 24, width: 480, maxHeight: "80vh", overflow: "auto" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <span style={{ ...LABEL_STYLE, fontSize: 12 }}>SUBMIT REVIEW</span>
              <button type="button" onClick={() => props.setShowReviewModal(false)} style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.textMuted }}><X size={16} /></button>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              {(["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const).map((ev) => (
                <button key={ev} type="button" onClick={() => props.setReviewEvent(ev)} style={{
                  ...outlineButton(),
                  height: 32,
                  background: props.reviewEvent === ev ? `${COLORS.accent}18` : "transparent",
                  borderColor: props.reviewEvent === ev ? COLORS.accent : COLORS.border,
                  color: props.reviewEvent === ev ? COLORS.accent : COLORS.textSecondary,
                }}>
                  {ev === "APPROVE" && <CheckCircle size={14} />}
                  {ev === "REQUEST_CHANGES" && <Warning size={14} />}
                  {ev === "COMMENT" && <ChatText size={14} />}
                  {ev.replace("_", " ")}
                </button>
              ))}
            </div>
            <textarea
              value={props.reviewBody}
              onChange={(e) => props.setReviewBody(e.target.value)}
              placeholder="Leave a review comment (optional for approve)..."
              style={{
                width: "100%", minHeight: 120, resize: "vertical", padding: 12,
                fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textPrimary,
                background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, outline: "none",
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button type="button" onClick={() => void props.onSubmitReview()} disabled={actionBusy} style={primaryButton({
                background: props.reviewEvent === "APPROVE" ? COLORS.success : props.reviewEvent === "REQUEST_CHANGES" ? COLORS.warning : COLORS.accent,
                borderColor: props.reviewEvent === "APPROVE" ? COLORS.success : props.reviewEvent === "REQUEST_CHANGES" ? COLORS.warning : COLORS.accent,
              })}>
                {actionBusy ? "SUBMITTING..." : `SUBMIT ${props.reviewEvent.replace("_", " ")}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ================================================================
// FILES TAB
// ================================================================

function FilesTab({ files, expandedFile, setExpandedFile }: { files: PrFile[]; expandedFile: string | null; setExpandedFile: (f: string | null) => void }) {
  const totalAdd = files.reduce((s, f) => s + f.additions, 0);
  const totalDel = files.reduce((s, f) => s + f.deletions, 0);

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={LABEL_STYLE}>FILES CHANGED ({files.length})</span>
          <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.success }}>+{totalAdd}</span>
          <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.danger }}>-{totalDel}</span>
        </div>
      </div>
      {files.length === 0 ? (
        <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textDim }}>No files changed</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {files.map((file) => {
            const isExpanded = expandedFile === file.filename;
            return (
              <div key={file.filename}>
                <button
                  type="button"
                  onClick={() => setExpandedFile(isExpanded ? null : file.filename)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, width: "100%",
                    padding: "8px 12px", border: "none", cursor: "pointer",
                    background: isExpanded ? `${COLORS.accent}08` : "transparent",
                    borderBottom: `1px solid ${COLORS.border}`, textAlign: "left",
                    transition: "background 100ms",
                  }}
                  onMouseEnter={(e) => { if (!isExpanded) e.currentTarget.style.background = COLORS.hoverBg; }}
                  onMouseLeave={(e) => { if (!isExpanded) e.currentTarget.style.background = "transparent"; }}
                >
                  {isExpanded ? <CaretDown size={12} style={{ color: COLORS.textMuted }} /> : <CaretRight size={12} style={{ color: COLORS.textMuted }} />}
                  <span style={{
                    fontFamily: MONO_FONT, fontSize: 10, fontWeight: 700,
                    color: fileStatusColor(file.status), width: 16, textAlign: "center",
                  }}>
                    {fileStatusLabel(file.status)}
                  </span>
                  <span style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textPrimary, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {file.filename}
                  </span>
                  <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.success }}>+{file.additions}</span>
                  <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.danger }}>-{file.deletions}</span>
                </button>
                {isExpanded && file.patch && (
                  <div style={{ background: COLORS.recessedBg, borderBottom: `1px solid ${COLORS.border}`, overflow: "auto", maxHeight: 500 }}>
                    <pre style={{ fontFamily: MONO_FONT, fontSize: 11, lineHeight: 1.6, margin: 0, padding: 12 }}>
                      {file.patch.split("\n").map((line, i) => {
                        let color: string = COLORS.textSecondary;
                        let bg: string = "transparent";
                        if (line.startsWith("+")) { color = COLORS.success; bg = `${COLORS.success}08`; }
                        else if (line.startsWith("-")) { color = COLORS.danger; bg = `${COLORS.danger}08`; }
                        else if (line.startsWith("@@")) { color = COLORS.accent; bg = `${COLORS.accent}08`; }
                        return (
                          <div key={i} style={{ color, background: bg, padding: "0 4px", minHeight: "1.6em" }}>
                            {line}
                          </div>
                        );
                      })}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ================================================================
// CHECKS TAB
// ================================================================

function ChecksTab({ checks, actionRuns, expandedRun, setExpandedRun, actionBusy, onRerunChecks }: {
  checks: PrCheck[];
  actionRuns: PrActionRun[];
  expandedRun: number | null;
  setExpandedRun: (id: number | null) => void;
  actionBusy: boolean;
  onRerunChecks: () => void;
}) {
  const passing = checks.filter(c => c.conclusion === "success").length;
  const failing = checks.filter(c => c.conclusion === "failure").length;
  const pending = checks.filter(c => c.status !== "completed").length;

  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Summary bar */}
      <div style={cardStyle()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span style={LABEL_STYLE}>CI / CHECKS</span>
            <div style={{ display: "flex", gap: 8 }}>
              {passing > 0 && <span style={inlineBadge(COLORS.success)}>{passing} PASSING</span>}
              {failing > 0 && <span style={inlineBadge(COLORS.danger)}>{failing} FAILING</span>}
              {pending > 0 && <span style={inlineBadge(COLORS.warning)}>{pending} PENDING</span>}
            </div>
          </div>
          <button type="button" disabled={actionBusy} onClick={onRerunChecks} style={outlineButton({ height: 28, color: COLORS.warning, borderColor: `${COLORS.warning}40` })}>
            <ArrowsClockwise size={14} /> RERUN FAILED
          </button>
        </div>
      </div>

      {/* Check runs list */}
      <div style={cardStyle()}>
        <span style={{ ...LABEL_STYLE, marginBottom: 12, display: "block" }}>CHECK RUNS ({checks.length})</span>
        {checks.length === 0 ? (
          <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textDim }}>No checks found</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {checks.map((check, idx) => (
              <div key={`${check.name}-${idx}`} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "10px 0", borderBottom: idx < checks.length - 1 ? `1px solid ${COLORS.border}` : "none",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <CheckIcon check={check} />
                  <span style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textPrimary }}>{check.name}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {check.startedAt && check.completedAt && (
                    <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
                      {Math.round((new Date(check.completedAt).getTime() - new Date(check.startedAt).getTime()) / 1000)}s
                    </span>
                  )}
                  <span style={{
                    fontFamily: MONO_FONT, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px",
                    color: check.conclusion === "success" ? COLORS.success : check.conclusion === "failure" ? COLORS.danger : check.status === "in_progress" ? COLORS.warning : COLORS.textMuted,
                  }}>
                    {check.conclusion ?? check.status}
                  </span>
                  {check.detailsUrl && (
                    <button type="button" onClick={() => void window.ade.app.openExternal(check.detailsUrl!)} style={outlineButton({ height: 22, padding: "0 6px", fontSize: 9 })}>
                      LOGS
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Action Runs (expanded detail) */}
      {actionRuns.length > 0 && (
        <div style={cardStyle()}>
          <span style={{ ...LABEL_STYLE, marginBottom: 12, display: "block" }}>WORKFLOW RUNS ({actionRuns.length})</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {actionRuns.map((run) => {
              const isExpanded = expandedRun === run.id;
              return (
                <div key={run.id}>
                  <button
                    type="button"
                    onClick={() => setExpandedRun(isExpanded ? null : run.id)}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
                      padding: "10px 0", border: "none", background: "transparent", cursor: "pointer", textAlign: "left",
                      borderBottom: `1px solid ${COLORS.border}`,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {isExpanded ? <CaretDown size={12} style={{ color: COLORS.textMuted }} /> : <CaretRight size={12} style={{ color: COLORS.textMuted }} />}
                      {run.conclusion === "success" ? <CheckCircle size={14} weight="fill" style={{ color: COLORS.success }} /> :
                       run.conclusion === "failure" ? <XCircle size={14} weight="fill" style={{ color: COLORS.danger }} /> :
                       run.status === "in_progress" ? <CircleNotch size={14} className="animate-spin" style={{ color: COLORS.warning }} /> :
                       <Circle size={14} style={{ color: COLORS.textMuted }} />}
                      <span style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textPrimary }}>{run.name}</span>
                    </div>
                    <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>{formatTs(run.createdAt)}</span>
                  </button>
                  {isExpanded && run.jobs.length > 0 && (
                    <div style={{ paddingLeft: 24, background: COLORS.recessedBg, borderBottom: `1px solid ${COLORS.border}` }}>
                      {run.jobs.map((job) => (
                        <div key={job.id} style={{ padding: "8px 12px", borderBottom: `1px solid ${COLORS.border}` }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                            {job.conclusion === "success" ? <CheckCircle size={12} weight="fill" style={{ color: COLORS.success }} /> :
                             job.conclusion === "failure" ? <XCircle size={12} weight="fill" style={{ color: COLORS.danger }} /> :
                             <CircleNotch size={12} className="animate-spin" style={{ color: COLORS.warning }} />}
                            <span style={{ fontFamily: MONO_FONT, fontSize: 11, fontWeight: 600, color: COLORS.textPrimary }}>{job.name}</span>
                          </div>
                          {job.steps.length > 0 && (
                            <div style={{ paddingLeft: 20 }}>
                              {job.steps.map((step) => (
                                <div key={step.number} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 0", fontFamily: MONO_FONT, fontSize: 10 }}>
                                  {step.conclusion === "success" ? <CheckCircle size={10} weight="fill" style={{ color: COLORS.success }} /> :
                                   step.conclusion === "failure" ? <XCircle size={10} weight="fill" style={{ color: COLORS.danger }} /> :
                                   step.conclusion === "skipped" ? <Circle size={10} style={{ color: COLORS.textDim }} /> :
                                   <CircleNotch size={10} className="animate-spin" style={{ color: COLORS.warning }} />}
                                  <span style={{ color: step.conclusion === "failure" ? COLORS.danger : COLORS.textSecondary }}>{step.name}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ================================================================
// ACTIVITY TAB
// ================================================================

function ActivityTab({ activity, comments, reviews, commentDraft, setCommentDraft, actionBusy, onAddComment }: {
  activity: PrActivityEvent[];
  comments: PrComment[];
  reviews: PrReview[];
  commentDraft: string;
  setCommentDraft: (v: string) => void;
  actionBusy: boolean;
  onAddComment: () => void;
}) {
  // Merge comments and reviews into a timeline if activity is empty
  const timeline = React.useMemo(() => {
    if (activity.length > 0) return activity;
    const events: PrActivityEvent[] = [];
    for (const c of comments) {
      events.push({
        id: c.id, type: "comment", author: c.author, avatarUrl: null,
        body: c.body, timestamp: c.createdAt ?? "", metadata: { path: c.path, line: c.line },
      });
    }
    for (const r of reviews) {
      events.push({
        id: `review-${r.reviewer}-${r.submittedAt}`, type: "review", author: r.reviewer, avatarUrl: null,
        body: r.body, timestamp: r.submittedAt ?? "", metadata: { state: r.state },
      });
    }
    return events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [activity, comments, reviews]);

  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Comment input at top */}
      <div style={cardStyle()}>
        <div style={{ display: "flex", gap: 8 }}>
          <textarea
            value={commentDraft}
            onChange={(e) => setCommentDraft(e.target.value)}
            placeholder="Write a comment... (Cmd+Enter to submit)"
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void onAddComment(); }}
            style={{
              flex: 1, minHeight: 60, resize: "vertical", padding: 10,
              fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textPrimary,
              background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, outline: "none",
            }}
          />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <button type="button" onClick={() => void onAddComment()} disabled={actionBusy || !commentDraft.trim()} style={primaryButton({ height: 28, opacity: actionBusy || !commentDraft.trim() ? 0.4 : 1 })}>
            <ChatText size={12} /> COMMENT
          </button>
        </div>
      </div>

      {/* Timeline */}
      <div style={cardStyle()}>
        <span style={{ ...LABEL_STYLE, marginBottom: 14, display: "block" }}>TIMELINE ({timeline.length})</span>
        {timeline.length === 0 ? (
          <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textDim }}>No activity yet</div>
        ) : (
          <div style={{ position: "relative", paddingLeft: 24 }}>
            {/* Vertical line */}
            <div style={{ position: "absolute", left: 8, top: 0, bottom: 0, width: 1, background: COLORS.border }} />
            {timeline.map((event, idx) => (
              <div key={event.id} style={{ position: "relative", paddingBottom: idx < timeline.length - 1 ? 16 : 0 }}>
                {/* Dot */}
                <div style={{
                  position: "absolute", left: -20, top: 4, width: 10, height: 10,
                  borderRadius: "50%",
                  background: event.type === "review" ? COLORS.accent :
                    event.type === "comment" ? COLORS.info :
                    event.type === "commit" ? COLORS.success :
                    event.type === "ci_run" ? COLORS.warning : COLORS.textMuted,
                  border: `2px solid ${COLORS.pageBg}`,
                }} />
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ fontFamily: MONO_FONT, fontSize: 11, fontWeight: 600, color: COLORS.textPrimary }}>{event.author}</span>
                    <span style={inlineBadge(
                      event.type === "review" ? COLORS.accent :
                      event.type === "comment" ? COLORS.info :
                      event.type === "ci_run" ? COLORS.warning : COLORS.textMuted,
                    )}>
                      {event.type === "review" ? (event.metadata?.state as string ?? "REVIEW").toUpperCase() : event.type.toUpperCase()}
                    </span>
                    <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>{formatTs(event.timestamp)}</span>
                  </div>
                  {event.body && (
                    <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textSecondary, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                      {event.body}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ================================================================
// SHARED COMPONENTS
// ================================================================

function StatusSignal({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "8px 0" }}>
      <span style={LABEL_STYLE}>{label}</span>
      <span style={{ fontFamily: MONO_FONT, fontSize: 14, fontWeight: 700, color }}>{value}</span>
    </div>
  );
}

function SidebarSection({ title, children, onEdit }: { title: string; children: React.ReactNode; onEdit?: () => void }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={LABEL_STYLE}>{title}</span>
        {onEdit && (
          <button type="button" onClick={onEdit} style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.textMuted, padding: 2 }}>
            <PencilSimple size={12} />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
      <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted }}>{label}</span>
      <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textPrimary, textAlign: "right" }}>{value}</span>
    </div>
  );
}

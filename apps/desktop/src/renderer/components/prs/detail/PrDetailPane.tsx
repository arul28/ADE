import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import {
  GitBranch, GitMerge, GitCommit, GithubLogo, CheckCircle, XCircle, Circle,
  CircleNotch, Sparkle, ArrowRight, Eye, ChatText, Code, ClockCounterClockwise,
  PencilSimple, X, Check, ArrowsClockwise, Warning, Play, Rocket, Tag,
  CaretDown, CaretRight, UserCircle, DotsThreeVertical, Robot,
} from "@phosphor-icons/react";
import type {
  PrWithConflicts, PrCheck, PrReview, PrComment, PrStatus, PrDetail,
  PrFile, PrActionRun, PrActivityEvent, AiReviewSummary,
  LaneSummary, MergeMethod, LandResult,
} from "../../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, LABEL_STYLE, cardStyle, recessedStyle, inlineBadge, outlineButton, primaryButton, dangerButton } from "../../lanes/laneDesignTokens";
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
    <img src={user.avatarUrl} alt={user.login} width={size} height={size} style={{ borderRadius: "50%", border: `1.5px solid ${COLORS.accentBorder}`, boxShadow: `0 0 0 1px ${COLORS.pageBg}` }} />
  ) : (
    <UserCircle size={size} weight="fill" style={{ color: COLORS.accent, opacity: 0.7 }} />
  );
}

function MarkdownBody({ markdown }: { markdown: string }) {
  // Strip HTML comments (e.g. <!-- coderabbit:... -->) before rendering
  const cleaned = markdown.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!cleaned) return null;

  return (
    <div style={{ fontSize: 13, lineHeight: 1.7, color: COLORS.textSecondary, fontFamily: SANS_FONT, wordBreak: "break-word", overflowWrap: "break-word" }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw]}
        components={{
          p: ({ children }) => <p style={{ margin: "0 0 10px", whiteSpace: "pre-wrap", fontFamily: SANS_FONT }}>{children}</p>,
          ul: ({ children }) => <ul style={{ margin: "0 0 10px", paddingLeft: 20 }}>{children}</ul>,
          ol: ({ children }) => <ol style={{ margin: "0 0 10px", paddingLeft: 20 }}>{children}</ol>,
          li: ({ children }) => <li style={{ marginBottom: 4, fontFamily: SANS_FONT }}>{children}</li>,
          h1: ({ children }) => <h1 style={{ fontSize: 18, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary, margin: "16px 0 8px", paddingBottom: 6, borderBottom: `1px solid ${COLORS.border}` }}>{children}</h1>,
          h2: ({ children }) => <h2 style={{ fontSize: 16, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary, margin: "14px 0 6px", paddingBottom: 4, borderBottom: `1px solid ${COLORS.border}` }}>{children}</h2>,
          h3: ({ children }) => <h3 style={{ fontSize: 14, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary, margin: "12px 0 4px" }}>{children}</h3>,
          h4: ({ children }) => <h4 style={{ fontSize: 13, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary, margin: "10px 0 4px" }}>{children}</h4>,
          h5: ({ children }) => <h5 style={{ fontSize: 12, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary, margin: "8px 0 4px" }}>{children}</h5>,
          h6: ({ children }) => <h6 style={{ fontSize: 11, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textMuted, margin: "8px 0 4px" }}>{children}</h6>,
          blockquote: ({ children }) => (
            <blockquote style={{
              margin: "8px 0",
              padding: "4px 14px",
              borderLeft: `3px solid ${COLORS.accent}40`,
              color: COLORS.textMuted,
              fontStyle: "italic",
            }}>
              {children}
            </blockquote>
          ),
          hr: () => <hr style={{ border: "none", borderTop: `1px solid ${COLORS.border}`, margin: "12px 0" }} />,
          pre: ({ children }) => (
            <pre style={{
              overflow: "auto",
              margin: "10px 0",
              padding: 12,
              border: `1px solid ${COLORS.border}`,
              background: COLORS.recessedBg,
              borderRadius: 8,
              fontFamily: MONO_FONT,
              fontSize: 11,
              lineHeight: 1.6,
              color: COLORS.textSecondary,
            }}>
              {children}
            </pre>
          ),
          code: ({ className, children }) => {
            const text = String(children ?? "");
            const isBlock = /\n/.test(text) || (typeof className === "string" && className.length > 0);
            return isBlock ? (
              <code style={{ fontFamily: MONO_FONT, fontSize: 11 }}>{children}</code>
            ) : (
              <code style={{
                padding: "2px 5px",
                border: `1px solid ${COLORS.border}`,
                background: COLORS.recessedBg,
                borderRadius: 4,
                fontFamily: MONO_FONT,
                fontSize: 11,
                color: COLORS.accent,
              }}>
                {children}
              </code>
            );
          },
          a: ({ children, href }) => (
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); if (href) void window.ade.app.openExternal(href); }}
              style={{ color: COLORS.accent, textDecoration: "underline", cursor: "pointer" }}
            >
              {children}
            </a>
          ),
          img: ({ src, alt }) => (
            <img
              src={src}
              alt={alt ?? ""}
              style={{ maxWidth: "100%", height: "auto", borderRadius: 6, margin: "6px 0", border: `1px solid ${COLORS.border}` }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          ),
          table: ({ children }) => (
            <div style={{ overflowX: "auto", margin: "10px 0" }}>
              <table style={{
                width: "100%",
                borderCollapse: "collapse",
                fontFamily: SANS_FONT,
                fontSize: 12,
              }}>
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead style={{ background: COLORS.recessedBg }}>{children}</thead>
          ),
          th: ({ children }) => (
            <th style={{
              padding: "6px 10px",
              textAlign: "left",
              fontWeight: 600,
              color: COLORS.textPrimary,
              borderBottom: `1px solid ${COLORS.border}`,
              fontSize: 11,
            }}>
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td style={{
              padding: "6px 10px",
              borderBottom: `1px solid ${COLORS.borderMuted}`,
              color: COLORS.textSecondary,
              fontSize: 12,
            }}>
              {children}
            </td>
          ),
          details: ({ children }) => (
            <details style={{
              margin: "8px 0",
              border: `1px solid ${COLORS.border}`,
              borderRadius: 8,
              overflow: "hidden",
            }}>
              {children}
            </details>
          ),
          summary: ({ children }) => (
            <summary style={{
              padding: "8px 12px",
              cursor: "pointer",
              fontWeight: 600,
              fontFamily: SANS_FONT,
              fontSize: 12,
              color: COLORS.textPrimary,
              background: COLORS.recessedBg,
              borderBottom: `1px solid ${COLORS.border}`,
              listStyle: "none",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}>
              <CaretRight size={11} style={{ color: COLORS.textMuted }} />
              {children}
            </summary>
          ),
          strong: ({ children }) => <strong style={{ fontWeight: 600, color: COLORS.textPrimary }}>{children}</strong>,
          em: ({ children }) => <em style={{ fontStyle: "italic" }}>{children}</em>,
          del: ({ children }) => <del style={{ textDecoration: "line-through", opacity: 0.7 }}>{children}</del>,
          input: ({ type, checked, disabled }) => {
            if (type === "checkbox") {
              return (
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  readOnly
                  style={{ marginRight: 6, accentColor: COLORS.accent, verticalAlign: "middle" }}
                />
              );
            }
            return null;
          },
        }}
      >
        {cleaned}
      </ReactMarkdown>
    </div>
  );
}

// ---- Check status icon ----
function CheckIcon({ check }: { check: PrCheck }) {
  if (check.status === "completed") {
    if (check.conclusion === "success") return <CheckCircle size={16} weight="fill" style={{ color: COLORS.success, filter: "drop-shadow(0 0 4px rgba(34,197,94,0.4))" }} />;
    if (check.conclusion === "failure") return <XCircle size={16} weight="fill" style={{ color: COLORS.danger, filter: "drop-shadow(0 0 4px rgba(239,68,68,0.4))" }} />;
    return <Circle size={16} weight="regular" style={{ color: COLORS.textMuted }} />;
  }
  if (check.status === "in_progress") return <CircleNotch size={16} className="animate-spin" style={{ color: COLORS.warning, filter: "drop-shadow(0 0 4px rgba(245,158,11,0.4))" }} />;
  return <Circle size={16} weight="regular" style={{ color: COLORS.textMuted }} />;
}

const FILE_STATUS_COLORS: Record<string, string> = {
  added: COLORS.success,
  removed: COLORS.danger,
  modified: COLORS.warning,
  renamed: COLORS.info,
};

function fileStatusColor(status: string): string {
  return FILE_STATUS_COLORS[status] ?? COLORS.textSecondary;
}

const FILE_STATUS_LABELS: Record<string, string> = {
  added: "A",
  removed: "D",
  modified: "M",
  renamed: "R",
  copied: "C",
};

function fileStatusLabel(status: string): string {
  return FILE_STATUS_LABELS[status] ?? "?";
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
  onOpenRebaseTab?: () => void;
};

export function PrDetailPane({ pr, status, checks, reviews, comments, detailBusy, lanes, mergeMethod, onRefresh, onNavigate, onTabChange, onShowInGraph, onOpenRebaseTab }: PrDetailPaneProps) {
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
  const detailLoadSeqRef = React.useRef(0);

  const loadDetail = React.useCallback(async () => {
    const requestId = ++detailLoadSeqRef.current;
    try {
      const [d, f, a, act] = await Promise.all([
        window.ade.prs.getDetail(pr.id).catch(() => null),
        window.ade.prs.getFiles(pr.id).catch(() => []),
        window.ade.prs.getActionRuns(pr.id).catch(() => []),
        window.ade.prs.getActivity(pr.id).catch(() => []),
      ]);
      if (requestId !== detailLoadSeqRef.current) return;
      setDetail(d);
      setFiles(f);
      setActionRuns(a);
      setActivity(act);
    } catch {
      // silently fail - basic data still available from context
    }
  }, [pr.id]);

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
    return () => {
      detailLoadSeqRef.current += 1;
    };
  }, [loadDetail, pr.id]);

  // ---- Action helper to reduce repetitive try/catch/finally ----
  const runAction = async (fn: () => Promise<void>) => {
    setActionBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  // ---- Actions ----
  const handleMerge = () => {
    setActionResult(null);
    return runAction(async () => {
      const res = await window.ade.prs.land({ prId: pr.id, method: mergeMethod });
      setActionResult(res);
      await onRefresh();
    });
  };

  const handleAddComment = async () => {
    if (!commentDraft.trim()) return;
    return runAction(async () => {
      await window.ade.prs.addComment({ prId: pr.id, body: commentDraft });
      setCommentDraft("");
      await onRefresh();
      await loadDetail();
    });
  };

  const handleUpdateTitle = async () => {
    if (!titleDraft.trim()) return;
    return runAction(async () => {
      await window.ade.prs.updateTitle({ prId: pr.id, title: titleDraft });
      setEditingTitle(false);
      await onRefresh();
    });
  };

  const handleUpdateBody = () => runAction(async () => {
    await window.ade.prs.updateBody({ prId: pr.id, body: bodyDraft });
    setEditingBody(false);
    await onRefresh();
    await loadDetail();
  });

  const handleSetLabels = (labels: string[]) => runAction(async () => {
    await window.ade.prs.setLabels({ prId: pr.id, labels });
    setShowLabelEditor(false);
    await loadDetail();
  });

  const handleRequestReviewers = (reviewers: string[]) => runAction(async () => {
    await window.ade.prs.requestReviewers({ prId: pr.id, reviewers });
    setShowReviewerEditor(false);
    await onRefresh();
    await loadDetail();
  });

  const handleSubmitReview = () => runAction(async () => {
    await window.ade.prs.submitReview({ prId: pr.id, event: reviewEvent, body: reviewBody || undefined });
    setShowReviewModal(false);
    setReviewBody("");
    await onRefresh();
  });

  const handleClosePr = () => runAction(async () => {
    await window.ade.prs.close({ prId: pr.id });
    await onRefresh();
  });

  const handleReopenPr = () => runAction(async () => {
    await window.ade.prs.reopen({ prId: pr.id });
    await onRefresh();
  });

  const handleRerunChecks = () => runAction(async () => {
    await window.ade.prs.rerunChecks({ prId: pr.id });
    await onRefresh();
    await loadDetail();
  });

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
  const TAB_ACTIVE_COLORS: Record<DetailTab, string> = {
    overview: COLORS.accent,
    files: COLORS.info,
    checks: COLORS.success,
    activity: COLORS.warning,
  };

  const DETAIL_TABS: Array<{ id: DetailTab; label: string; icon: React.ElementType; count?: number }> = [
    { id: "overview", label: "Overview", icon: Eye },
    { id: "files", label: "Files", icon: Code, count: files.length },
    { id: "checks", label: "CI / Checks", icon: Play, count: checks.length },
    { id: "activity", label: "Activity", icon: ClockCounterClockwise, count: activity.length > 0 ? activity.length : (comments.length + reviews.length) },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: COLORS.pageBg }}>
      {/* ===== HEADER ===== */}
      <div style={{ padding: "18px 20px 0", borderBottom: `1px solid ${COLORS.border}`, flexShrink: 0, background: `linear-gradient(180deg, rgba(167,139,250,0.04) 0%, transparent 100%)` }}>
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
                    flex: 1, height: 36, padding: "0 12px", fontSize: 16, fontWeight: 700,
                    fontFamily: SANS_FONT, color: COLORS.textPrimary,
                    background: COLORS.recessedBg, border: `1px solid ${COLORS.accent}`, borderRadius: 8, outline: "none",
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
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontFamily: MONO_FONT, fontSize: 14, color: COLORS.accent, fontWeight: 600, opacity: 0.8 }}>#{pr.githubPrNumber}</span>
                <span style={{ fontSize: 18, fontWeight: 700, color: COLORS.textPrimary, fontFamily: SANS_FONT, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: "-0.01em" }}>
                  {pr.title}
                </span>
                <button
                  type="button"
                  onClick={() => { setTitleDraft(pr.title); setEditingTitle(true); }}
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 2, color: COLORS.textMuted, flexShrink: 0, opacity: 0.6 }}
                  title="Edit title"
                >
                  <PencilSimple size={14} />
                </button>
              </div>
            )}
            <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted, fontWeight: 500 }}>{pr.repoOwner}/{pr.repoName}</span>
              <span style={{ color: COLORS.border }}>|</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, background: `${COLORS.accent}12`, padding: "2px 8px", borderRadius: 6, border: `1px solid ${COLORS.accent}20` }}>
                <GitBranch size={12} style={{ color: COLORS.accent }} />
                <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.accent }}>{pr.headBranch}</span>
              </span>
              <ArrowRight size={10} style={{ color: COLORS.textDim }} />
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, background: `${COLORS.info}12`, padding: "2px 8px", borderRadius: 6, border: `1px solid ${COLORS.info}20` }}>
                <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.info }}>{pr.baseBranch}</span>
              </span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            <InlinePrBadge {...sc} />
            <InlinePrBadge {...cc} />
            <InlinePrBadge {...rc} />
          </div>
        </div>

        {/* Sub-tab bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 2, marginTop: 16 }}>
          {DETAIL_TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            const tabColor = TAB_ACTIVE_COLORS[tab.id];
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "9px 16px", fontSize: 12, fontWeight: isActive ? 600 : 500, fontFamily: SANS_FONT,
                  color: isActive ? COLORS.textPrimary : COLORS.textMuted,
                  background: isActive ? `${tabColor}14` : "transparent",
                  borderBottom: isActive ? `2.5px solid ${tabColor}` : "2.5px solid transparent",
                  borderTop: "none",
                  borderLeft: "none",
                  borderRight: "none",
                  borderRadius: isActive ? "8px 8px 0 0" : "8px 8px 0 0",
                  cursor: "pointer", transition: "all 120ms ease",
                }}
              >
                <Icon size={15} weight={isActive ? "fill" : "regular"} style={{ color: isActive ? tabColor : COLORS.textMuted, transition: "color 120ms ease" }} />
                {tab.label}
                {tab.count != null && tab.count > 0 && (
                  <span style={{
                    fontSize: 10, fontFamily: MONO_FONT, padding: "1px 6px", fontVariantNumeric: "tabular-nums",
                    borderRadius: 10,
                    background: isActive ? `${tabColor}28` : `${COLORS.textDim}30`,
                    color: isActive ? tabColor : COLORS.textMuted,
                    fontWeight: 600,
                  }}>
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}

          {/* Right-side action buttons */}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
            <button type="button" onClick={() => void onRefresh()} style={outlineButton({ height: 30, padding: "0 8px" })} title="Refresh">
              <ArrowsClockwise size={14} weight="bold" />
            </button>
            {onShowInGraph ? (
              <button type="button" onClick={() => onShowInGraph(pr.laneId)} style={outlineButton({ height: 30, padding: "0 10px", color: COLORS.info, borderColor: `${COLORS.info}40` })}>
                <GitBranch size={14} /> Graph
              </button>
            ) : null}
            <button type="button" onClick={() => void window.ade.prs.openInGitHub(pr.id)} style={outlineButton({ height: 30, padding: "0 10px" })}>
              <GithubLogo size={14} /> GitHub
            </button>
          </div>
        </div>
      </div>

      {/* ===== ERROR BAR ===== */}
      {actionError && (
        <div style={{ padding: "10px 20px", background: `${COLORS.danger}0C`, borderBottom: `1px solid ${COLORS.danger}20`, fontFamily: SANS_FONT, fontSize: 12, color: COLORS.danger, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <XCircle size={14} weight="fill" />
            <span>{actionError}</span>
          </div>
          <button type="button" onClick={() => setActionError(null)} style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.danger, padding: 4 }}><X size={14} /></button>
        </div>
      )}
      {actionResult && (
        <div style={{
          padding: "10px 20px",
          background: actionResult.success ? `${COLORS.success}0C` : `${COLORS.danger}0C`,
          borderBottom: `1px solid ${actionResult.success ? `${COLORS.success}20` : `${COLORS.danger}20`}`,
          fontFamily: SANS_FONT, fontSize: 12,
          color: actionResult.success ? COLORS.success : COLORS.danger,
          display: "flex", alignItems: "center", gap: 8,
        }}>
          {actionResult.success ? <CheckCircle size={14} weight="fill" /> : <XCircle size={14} weight="fill" />}
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
            onOpenRebaseTab={onOpenRebaseTab}
            localBehindCount={(() => {
              const lane = lanes.find((l) => l.id === pr.laneId);
              return lane?.status?.behind ?? 0;
            })()}
            activity={activity}
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

const BOT_NAMES = new Set([
  "github-actions", "vercel", "mintlify", "coderabbitai",
  "copilot", "dependabot", "renovate", "codecov", "netlify",
]);

function isBot(author: string): boolean {
  return author.endsWith("[bot]") || BOT_NAMES.has(author);
}

function CommentAvatar({ author, avatarUrl, size = 24 }: { author: string; avatarUrl?: string | null; size?: number }) {
  // Prefer the actual avatar URL from the API; fall back to constructing one from the login
  // For bot users like "coderabbitai[bot]", strip the [bot] suffix to get the correct avatar
  const cleanLogin = author.replace(/\[bot\]$/, "");
  const url = avatarUrl || `https://avatars.githubusercontent.com/${encodeURIComponent(cleanLogin)}?size=${size * 2}`;
  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <img
        src={url}
        alt={author}
        width={size}
        height={size}
        style={{ borderRadius: "50%", border: `1.5px solid ${COLORS.accentBorder}`, boxShadow: `0 0 0 1px ${COLORS.pageBg}`, display: "block" }}
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = "none";
          (e.target as HTMLImageElement).nextElementSibling?.setAttribute("style", "display:flex");
        }}
      />
      <div style={{ display: "none", width: size, height: size, borderRadius: "50%", background: `${COLORS.accent}20`, alignItems: "center", justifyContent: "center" }}>
        <UserCircle size={size} weight="fill" style={{ color: COLORS.accent, opacity: 0.7 }} />
      </div>
      {isBot(author) && (
        <div style={{
          position: "absolute", bottom: -2, right: -2,
          width: 14, height: 14, borderRadius: "50%",
          background: COLORS.cardBgSolid, border: `1.5px solid ${COLORS.border}`,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <Robot size={8} weight="fill" style={{ color: COLORS.textMuted }} />
        </div>
      )}
    </div>
  );
}

// ---- Comment menu dropdown ----
function CommentMenu({ url }: { url: string | null }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (!url) return null;

  return (
    <div ref={ref} style={{ position: "relative", marginLeft: "auto", flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          background: "none", border: "none", cursor: "pointer", padding: 4,
          color: COLORS.textDim, borderRadius: 6, display: "flex", alignItems: "center",
          transition: "color 100ms ease",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = COLORS.textSecondary; e.currentTarget.style.background = COLORS.hoverBg; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = COLORS.textDim; e.currentTarget.style.background = "none"; }}
      >
        <DotsThreeVertical size={16} weight="bold" />
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "100%", right: 0, marginTop: 4,
          background: COLORS.cardBgSolid, border: `1px solid ${COLORS.outlineBorder}`,
          borderRadius: 10, padding: 4, minWidth: 160, zIndex: 20,
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        }}>
          <button
            type="button"
            onClick={() => { void window.ade.app.openExternal(url); setOpen(false); }}
            style={{
              display: "flex", alignItems: "center", gap: 8, width: "100%",
              padding: "8px 12px", background: "none", border: "none", cursor: "pointer",
              fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textSecondary, borderRadius: 6,
              textAlign: "left",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; e.currentTarget.style.color = COLORS.textPrimary; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = COLORS.textSecondary; }}
          >
            <GithubLogo size={14} /> Open on GitHub
          </button>
          <button
            type="button"
            onClick={() => { void navigator.clipboard.writeText(url); setOpen(false); }}
            style={{
              display: "flex", alignItems: "center", gap: 8, width: "100%",
              padding: "8px 12px", background: "none", border: "none", cursor: "pointer",
              fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textSecondary, borderRadius: 6,
              textAlign: "left",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; e.currentTarget.style.color = COLORS.textPrimary; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = COLORS.textSecondary; }}
          >
            <Code size={14} /> Copy link
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Merge readiness status row ----
function MergeStatusRow({ color, icon, title, description, children, expandable, expanded, onToggle }: {
  color: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  children?: React.ReactNode;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const content = (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 12, padding: "14px 16px",
      borderLeft: `3px solid ${color}`,
      background: `${color}06`,
      borderBottom: `1px solid ${COLORS.border}`,
      cursor: expandable ? "pointer" : "default",
      transition: "background 100ms ease",
    }}>
      <div style={{ flexShrink: 0, marginTop: 1 }}>{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>{title}</span>
          {expandable && (
            expanded ? <CaretDown size={12} style={{ color: COLORS.textMuted }} /> : <CaretRight size={12} style={{ color: COLORS.textMuted }} />
          )}
        </div>
        <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted, marginTop: 2, display: "block" }}>{description}</span>
      </div>
    </div>
  );

  return expandable ? (
    <div>
      {/* biome-ignore lint: onClick on wrapper */}
      <div onClick={onToggle} onKeyDown={(e) => { if (e.key === "Enter") onToggle?.(); }} role="button" tabIndex={0}>
        {content}
      </div>
      {expanded && children && (
        <div style={{ borderLeft: `3px solid ${color}`, background: `${color}04`, borderBottom: `1px solid ${COLORS.border}` }}>
          {children}
        </div>
      )}
    </div>
  ) : (
    <div>{content}</div>
  );
}

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
  onOpenRebaseTab?: () => void;
  localBehindCount: number;
  activity: PrActivityEvent[];
};

function OverviewTab(props: OverviewTabProps) {
  const { pr, detail, status, checks, reviews, comments, detailBusy, aiSummary, aiSummaryBusy, actionBusy, mergeMethod, activity } = props;
  const [checksExpanded, setChecksExpanded] = React.useState(false);
  const [localMergeMethod, setLocalMergeMethod] = React.useState<MergeMethod>(mergeMethod);

  // Sort comments chronologically (oldest first, like GitHub)
  const sortedComments = React.useMemo(
    () => [...comments].sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return ta - tb;
    }),
    [comments],
  );

  // Checks summary
  const passing = checks.filter(c => c.conclusion === "success").length;
  const failing = checks.filter(c => c.conclusion === "failure").length;
  const pending = checks.filter(c => c.status !== "completed").length;
  const allChecksPassed = checks.length > 0 && failing === 0 && pending === 0;
  const someChecksFailing = failing > 0;

  // Review status from pr
  const reviewStatus = pr.reviewStatus;

  // Merge readiness
  const canMerge = status?.isMergeable && !status?.mergeConflicts && pr.state === "open";

  return (
    <div style={{ display: "flex", gap: 0, height: "100%" }}>
      {/* Main content */}
      <div style={{ flex: 1, minWidth: 0, overflow: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>

        {/* ---- Merge Status Bar ---- */}
        <div style={{ ...cardStyle({ padding: 0, overflow: "hidden" }), flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
            <StatusSignal label="Mergeable" value={status?.isMergeable ? "YES" : status ? "NO" : "---"} color={status?.isMergeable ? COLORS.success : status ? COLORS.danger : COLORS.textMuted} glow={status?.isMergeable === true} />
            <div style={{ width: 1, alignSelf: "stretch", background: COLORS.border }} />
            <StatusSignal label="Conflicts" value={status?.mergeConflicts ? "YES" : status ? "NO" : "---"} color={status?.mergeConflicts ? COLORS.danger : status ? COLORS.success : COLORS.textMuted} glow={status?.mergeConflicts === false} />
            <div style={{ width: 1, alignSelf: "stretch", background: COLORS.border }} />
            <StatusSignal label="Behind" value={String(status?.behindBaseBy ?? 0)} color={(status?.behindBaseBy ?? 0) > 0 ? COLORS.warning : COLORS.textPrimary} />
            <div style={{ width: 1, alignSelf: "stretch", background: COLORS.border }} />
            <StatusSignal label="Additions" value={`+${pr.additions}`} color={COLORS.success} />
            <div style={{ width: 1, alignSelf: "stretch", background: COLORS.border }} />
            <StatusSignal label="Deletions" value={`-${pr.deletions}`} color={COLORS.danger} />
          </div>
        </div>

        {/* ---- Rebase Banner (when PR is behind base branch — checks both GitHub API and local lane status) ---- */}
        {(() => {
          const ghBehind = status?.behindBaseBy ?? 0;
          const effectiveBehind = Math.max(ghBehind, props.localBehindCount);
          const hasConflicts = status?.mergeConflicts ?? false;
          if (effectiveBehind <= 0 || pr.state !== "open") return null;
          return (
            <div style={{
              ...cardStyle({ padding: 0, overflow: "hidden" }),
              flexShrink: 0,
              borderColor: hasConflicts ? `${COLORS.danger}30` : `${COLORS.warning}30`,
              background: hasConflicts
                ? `linear-gradient(135deg, ${COLORS.danger}08 0%, transparent 60%)`
                : `linear-gradient(135deg, ${COLORS.warning}08 0%, transparent 60%)`,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px" }}>
                <Warning size={18} weight="fill" style={{ color: hasConflicts ? COLORS.danger : COLORS.warning, flexShrink: 0, filter: `drop-shadow(0 0 4px ${hasConflicts ? COLORS.danger : COLORS.warning}40)` }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>
                    {hasConflicts
                      ? `${effectiveBehind} commit${effectiveBehind !== 1 ? "s" : ""} behind ${pr.baseBranch} with conflicts`
                      : `${effectiveBehind} commit${effectiveBehind !== 1 ? "s" : ""} behind ${pr.baseBranch}`}
                  </span>
                  <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted, marginLeft: 8 }}>
                    {hasConflicts ? "Rebase required to resolve conflicts" : "Rebase recommended before merging"}
                  </span>
                </div>
                {props.onOpenRebaseTab && (
                  <button
                    type="button"
                    onClick={props.onOpenRebaseTab}
                    style={outlineButton({
                      height: 30, padding: "0 14px",
                      color: hasConflicts ? COLORS.danger : COLORS.warning,
                      borderColor: hasConflicts ? `${COLORS.danger}40` : `${COLORS.warning}40`,
                    })}
                  >
                    <ArrowsClockwise size={13} weight="bold" /> View Rebase Details
                  </button>
                )}
              </div>
            </div>
          );
        })()}

        {/* ---- PR Description ---- */}
        <div style={cardStyle()}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <span style={{ ...LABEL_STYLE, fontSize: 12, fontWeight: 600, color: COLORS.textSecondary }}>Description</span>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" onClick={props.onAiSummary} disabled={aiSummaryBusy} style={outlineButton({ height: 28, padding: "0 12px", color: COLORS.accent, borderColor: `${COLORS.accent}40` })}>
                <Sparkle size={12} weight="fill" />
                {aiSummaryBusy ? "Analyzing..." : "AI Review"}
              </button>
              {!props.editingBody && (
                <button type="button" onClick={() => { props.setBodyDraft(detail?.body ?? ""); props.setEditingBody(true); }} style={outlineButton({ height: 28, padding: "0 10px" })}>
                  <PencilSimple size={12} /> Edit
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
                  width: "100%", minHeight: 200, resize: "vertical", padding: 14,
                  fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textPrimary,
                  background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, borderRadius: 10, outline: "none",
                }}
                placeholder="Write PR description (markdown)..."
              />
              <div style={{ display: "flex", gap: 6, marginTop: 10, justifyContent: "flex-end" }}>
                <button type="button" onClick={() => props.setEditingBody(false)} style={outlineButton({ height: 30 })}>Cancel</button>
                <button type="button" onClick={() => void props.onUpdateBody()} disabled={actionBusy} style={primaryButton({ height: 30 })}>
                  {actionBusy ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ maxHeight: 300, overflow: "auto" }}>
              <MarkdownBody markdown={detail?.body || pr.title || "No description provided."} />
            </div>
          )}
        </div>

        {/* ---- AI Review Summary ---- */}
        {aiSummary && (
          <div style={{ ...cardStyle(), borderColor: `${COLORS.accent}30`, background: `linear-gradient(135deg, ${COLORS.accent}08 0%, transparent 60%)` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
              <Sparkle size={16} weight="fill" style={{ color: COLORS.accent, filter: "drop-shadow(0 0 6px rgba(167,139,250,0.5))" }} />
              <span style={{ fontFamily: SANS_FONT, fontSize: 12, fontWeight: 600, color: COLORS.accent }}>AI Review Summary</span>
              <span style={inlineBadge(
                aiSummary.mergeReadiness === "ready" ? COLORS.success : aiSummary.mergeReadiness === "needs_work" ? COLORS.warning : COLORS.danger,
              )}>
                {aiSummary.mergeReadiness === "ready" ? "Ready to merge" : aiSummary.mergeReadiness === "needs_work" ? "Needs work" : "Blocked"}
              </span>
            </div>
            <div style={{ fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textSecondary, lineHeight: 1.7, marginBottom: 14 }}>
              {aiSummary.summary}
            </div>
            {aiSummary.potentialIssues.length > 0 && (
              <div style={{ marginBottom: 12, padding: 12, background: `${COLORS.warning}08`, borderRadius: 10, border: `1px solid ${COLORS.warning}15` }}>
                <span style={{ fontFamily: SANS_FONT, fontSize: 11, fontWeight: 600, color: COLORS.warning, marginBottom: 8, display: "block" }}>Potential Issues</span>
                {aiSummary.potentialIssues.map((issue, i) => (
                  <div key={i} style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textSecondary, padding: "4px 0", display: "flex", gap: 8, lineHeight: 1.5 }}>
                    <Warning size={13} style={{ color: COLORS.warning, flexShrink: 0, marginTop: 2 }} />
                    {issue}
                  </div>
                ))}
              </div>
            )}
            {aiSummary.recommendations.length > 0 && (
              <div style={{ padding: 12, background: `${COLORS.info}08`, borderRadius: 10, border: `1px solid ${COLORS.info}15` }}>
                <span style={{ fontFamily: SANS_FONT, fontSize: 11, fontWeight: 600, color: COLORS.info, marginBottom: 8, display: "block" }}>Recommendations</span>
                {aiSummary.recommendations.map((rec, i) => (
                  <div key={i} style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textSecondary, padding: "4px 0", display: "flex", gap: 8, lineHeight: 1.5 }}>
                    <CheckCircle size={13} style={{ color: COLORS.info, flexShrink: 0, marginTop: 2 }} />
                    {rec}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ---- Reviews Section ---- */}
        <div style={cardStyle()}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <span style={{ ...LABEL_STYLE, fontSize: 12, fontWeight: 600, color: COLORS.textSecondary }}>Reviews ({reviews.length})</span>
            <button type="button" onClick={() => props.setShowReviewModal(true)} style={outlineButton({ height: 26, padding: "0 10px" })}>
              <Check size={12} weight="bold" /> Submit Review
            </button>
          </div>
          {reviews.length === 0 ? (
            <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textDim, padding: "8px 0" }}>No reviews yet</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {reviews.map((review, idx) => {
                const isApproved = review.state === "approved";
                const isChangesRequested = review.state === "changes_requested";
                const reviewBg = isApproved ? `${COLORS.success}0A` : isChangesRequested ? `${COLORS.danger}0A` : "transparent";
                const reviewBorder = isApproved ? `${COLORS.success}25` : isChangesRequested ? `${COLORS.danger}25` : COLORS.border;
                const reviewLeftBorder = isApproved ? COLORS.success : isChangesRequested ? COLORS.danger : COLORS.border;
                return (
                  <div key={`${review.reviewer}-${idx}`} style={{
                    display: "flex", alignItems: "flex-start", gap: 12, padding: 12,
                    background: reviewBg, borderRadius: 10, border: `1px solid ${reviewBorder}`,
                    borderLeft: `3px solid ${reviewLeftBorder}`,
                  }}>
                    <CommentAvatar author={review.reviewer} avatarUrl={review.reviewerAvatarUrl} size={28} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>{review.reviewer}</span>
                        {isBot(review.reviewer) && (
                          <span style={{ fontFamily: SANS_FONT, fontSize: 9, fontWeight: 700, color: COLORS.textMuted, background: `${COLORS.textMuted}18`, padding: "1px 5px", borderRadius: 4, textTransform: "uppercase", letterSpacing: "0.5px" }}>bot</span>
                        )}
                        <span style={{
                          ...inlineBadge(
                            isApproved ? COLORS.success : isChangesRequested ? COLORS.danger : COLORS.textMuted,
                          ),
                          fontWeight: 600,
                          background: isApproved ? `${COLORS.success}18` : isChangesRequested ? `${COLORS.danger}18` : undefined,
                        }}>
                          {isApproved && <CheckCircle size={12} weight="fill" style={{ marginRight: 4 }} />}
                          {isChangesRequested && <Warning size={12} weight="fill" style={{ marginRight: 4 }} />}
                          {isApproved ? "Approved" : isChangesRequested ? "Changes Requested" : review.state.replace(/_/g, " ")}
                        </span>
                        {review.submittedAt && <span style={{ fontFamily: SANS_FONT, fontSize: 10, color: COLORS.textMuted }}>{formatTs(review.submittedAt)}</span>}
                      </div>
                      {review.body ? (
                        <div style={{ marginTop: 8 }}>
                          <MarkdownBody markdown={review.body} />
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ---- Activity & Comments Section ---- */}
        <div style={cardStyle()}>
          <span style={{ ...LABEL_STYLE, fontSize: 12, fontWeight: 600, color: COLORS.textSecondary, marginBottom: 14, display: "block" }}>
            Activity ({activity.length > 0 ? activity.length : comments.length})
          </span>
          {(() => {
            // Use full activity timeline if available, else fall back to comments.
            // Filter out ci_run events — they're shown in the CI/Checks tab.
            const timeline = activity.length > 0
              ? [...activity].filter((ev) => ev.type !== "ci_run").sort((a, b) => {
                  const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
                  const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
                  return ta - tb;
                })
              : sortedComments.map((c) => ({
                  id: c.id, type: "comment" as const, author: c.author,
                  avatarUrl: c.authorAvatarUrl, body: c.body,
                  timestamp: c.createdAt ?? "", metadata: { source: c.source, path: c.path, line: c.line, url: c.url },
                }));

            if (timeline.length === 0) {
              return <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textDim, marginBottom: 14, padding: "8px 0" }}>No activity yet</div>;
            }

            const eventColor = (ev: PrActivityEvent) => {
              if (ev.type === "comment") return ev.metadata?.source === "review" ? COLORS.warning : COLORS.info;
              if (ev.type === "review") return COLORS.accent;
              if (ev.type === "deployment") return COLORS.success;
              if (ev.type === "force_push") return COLORS.warning;
              if (ev.type === "commit") return COLORS.accent;
              if (ev.type === "ci_run") return COLORS.warning;
              if (ev.type === "label") return COLORS.info;
              return COLORS.textMuted;
            };

            const eventLabel = (ev: PrActivityEvent) => {
              if (ev.type === "comment") return ev.metadata?.source === "review" ? "review comment" : "comment";
              if (ev.type === "review") return "review";
              if (ev.type === "deployment") return "deployed";
              if (ev.type === "force_push") return "force push";
              if (ev.type === "commit") return "commit";
              if (ev.type === "ci_run") return "CI";
              if (ev.type === "label") return "label";
              if (ev.type === "review_request") return "review request";
              return String(ev.type).replace(/_/g, " ");
            };

            const eventIcon = (ev: PrActivityEvent) => {
              const col = eventColor(ev);
              const s = { color: col, flexShrink: 0 } as const;
              if (ev.type === "comment") return <ChatText size={12} weight="fill" style={s} />;
              if (ev.type === "review") return <Check size={12} weight="bold" style={s} />;
              if (ev.type === "deployment") return <Rocket size={12} weight="fill" style={s} />;
              if (ev.type === "force_push") return <ArrowsClockwise size={12} weight="bold" style={s} />;
              if (ev.type === "commit") return <GitCommit size={12} weight="bold" style={s} />;
              if (ev.type === "ci_run") return <Play size={12} weight="fill" style={s} />;
              if (ev.type === "label") return <Tag size={12} weight="fill" style={s} />;
              if (ev.type === "review_request") return <Eye size={12} weight="fill" style={s} />;
              return <Circle size={10} weight="fill" style={s} />;
            };

            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
                {timeline.map((ev) => {
                  const col = eventColor(ev);
                  const isComment = ev.type === "comment";
                  const isReviewComment = isComment && ev.metadata?.source === "review";
                  const authorIsBot = isBot(ev.author);

                  return (
                    <div key={ev.id} style={{
                      padding: isComment ? "14px 14px 12px" : "10px 14px",
                      borderRadius: 10,
                      background: isReviewComment
                        ? "rgba(245,158,11,0.04)"
                        : isComment
                          ? "rgba(255,245,235,0.03)"
                          : `${col}06`,
                      border: `1px solid ${isReviewComment ? "rgba(245,158,11,0.12)" : isComment ? "rgba(255,255,255,0.06)" : `${col}18`}`,
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: isComment && ev.body ? 8 : 0 }}>
                        {ev.avatarUrl ? (
                          <CommentAvatar author={ev.author} avatarUrl={ev.avatarUrl} size={isComment ? 24 : 20} />
                        ) : (
                          <div style={{ width: isComment ? 24 : 20, height: isComment ? 24 : 20, display: "flex", alignItems: "center", justifyContent: "center" }}>
                            {eventIcon(ev)}
                          </div>
                        )}
                        <span style={{ fontFamily: SANS_FONT, fontSize: isComment ? 13 : 12, fontWeight: 600, color: COLORS.textPrimary }}>{ev.author}</span>
                        {authorIsBot && (
                          <span style={{ fontFamily: SANS_FONT, fontSize: 9, fontWeight: 700, color: COLORS.textMuted, background: `${COLORS.textMuted}18`, padding: "1px 5px", borderRadius: 4, textTransform: "uppercase", letterSpacing: "0.5px" }}>bot</span>
                        )}
                        <span style={inlineBadge(col, { padding: "1px 8px", fontSize: 10 })}>
                          {eventLabel(ev)}
                        </span>
                        {isComment && typeof ev.metadata?.path === "string" && (
                          <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.accent, background: `${COLORS.accent}14`, padding: "2px 8px", borderRadius: 6 }}>
                            {String(ev.metadata.path)}{typeof ev.metadata?.line === "number" ? `:${ev.metadata.line}` : ""}
                          </span>
                        )}
                        {ev.type === "deployment" && typeof ev.metadata?.environment === "string" && (
                          <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.success, background: `${COLORS.success}14`, padding: "2px 8px", borderRadius: 6 }}>
                            {String(ev.metadata.environment)}
                          </span>
                        )}
                        {ev.type === "commit" && typeof ev.metadata?.shortSha === "string" && (
                          <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.accent, background: `${COLORS.accent}14`, padding: "2px 8px", borderRadius: 6 }}>
                            {String(ev.metadata.shortSha)}
                          </span>
                        )}
                        {ev.type === "force_push" && (
                          <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.warning, background: `${COLORS.warning}14`, padding: "2px 8px", borderRadius: 6 }}>
                            {typeof ev.metadata?.beforeSha === "string" ? `${String(ev.metadata.beforeSha).slice(0, 7)} → ${String(ev.metadata?.afterSha ?? "").slice(0, 7)}` : "branch updated"}
                          </span>
                        )}
                        <span style={{ marginLeft: "auto", fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted, flexShrink: 0 }}>{formatTs(ev.timestamp)}</span>
                        {isComment && typeof ev.metadata?.url === "string" && (
                          <CommentMenu url={String(ev.metadata.url)} />
                        )}
                      </div>
                      {isComment && ev.body ? (
                        <div style={{ paddingLeft: 32 }}>
                          <MarkdownBody markdown={ev.body} />
                        </div>
                      ) : !isComment && ev.body ? (
                        <div style={{ paddingLeft: isComment ? 32 : 28, marginTop: 4 }}>
                          <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textSecondary }}>{ev.body}</span>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            );
          })()}
          {/* Add comment */}
          <div style={{ position: "relative" }}>
            <textarea
              value={props.commentDraft}
              onChange={(e) => props.setCommentDraft(e.target.value)}
              placeholder="Leave a comment... Supports Markdown. Cmd+Enter to submit."
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void props.onAddComment(); }}
              style={{
                width: "100%", minHeight: 80, resize: "vertical", padding: "14px 14px 36px",
                fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textPrimary,
                background: "rgba(255,255,255,0.02)", border: `1px solid ${COLORS.border}`, borderRadius: 10, outline: "none",
                transition: "border-color 150ms ease",
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = `${COLORS.accent}50`; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = COLORS.border; }}
            />
            {!props.commentDraft && (
              <div style={{ position: "absolute", bottom: 10, left: 14, display: "flex", gap: 10, pointerEvents: "none" }}>
                <span style={{ fontFamily: SANS_FONT, fontSize: 10, color: COLORS.textDim }}>**bold**</span>
                <span style={{ fontFamily: SANS_FONT, fontSize: 10, color: COLORS.textDim }}>_italic_</span>
                <span style={{ fontFamily: SANS_FONT, fontSize: 10, color: COLORS.textDim }}>`code`</span>
                <span style={{ fontFamily: SANS_FONT, fontSize: 10, color: COLORS.textDim }}>[link](url)</span>
              </div>
            )}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
            <button type="button" onClick={() => void props.onAddComment()} disabled={actionBusy || !props.commentDraft.trim()} style={{
              ...primaryButton({
                height: 34, padding: "0 20px", fontSize: 13, fontWeight: 600,
                opacity: actionBusy || !props.commentDraft.trim() ? 0.4 : 1,
                boxShadow: actionBusy || !props.commentDraft.trim() ? "none" : `0 2px 8px ${COLORS.accent}30`,
              }),
            }}>
              <ChatText size={14} weight="fill" /> Comment
            </button>
          </div>
        </div>

        {/* ---- Merge Readiness Section ---- */}
        <div style={{ ...cardStyle({ padding: 0, overflow: "hidden" }), flexShrink: 0, borderColor: canMerge ? `${COLORS.success}30` : someChecksFailing ? `${COLORS.danger}20` : COLORS.border }}>
          <div style={{ padding: "12px 16px", borderBottom: `1px solid ${COLORS.border}`, display: "flex", alignItems: "center", gap: 8 }}>
            <GitMerge size={16} weight="bold" style={{ color: canMerge ? COLORS.success : COLORS.textMuted }} />
            <span style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 700, color: COLORS.textPrimary }}>Merge Readiness</span>
          </div>

          {/* Review status */}
          <MergeStatusRow
            color={reviewStatus === "approved" ? COLORS.success : reviewStatus === "changes_requested" ? COLORS.danger : COLORS.warning}
            icon={
              reviewStatus === "approved"
                ? <CheckCircle size={18} weight="fill" style={{ color: COLORS.success, filter: "drop-shadow(0 0 4px rgba(34,197,94,0.4))" }} />
                : reviewStatus === "changes_requested"
                  ? <XCircle size={18} weight="fill" style={{ color: COLORS.danger, filter: "drop-shadow(0 0 4px rgba(239,68,68,0.4))" }} />
                  : <Warning size={18} weight="fill" style={{ color: COLORS.warning, filter: "drop-shadow(0 0 4px rgba(245,158,11,0.4))" }} />
            }
            title={
              reviewStatus === "approved" ? "Approved"
                : reviewStatus === "changes_requested" ? "Changes requested"
                  : "Review required"
            }
            description={
              reviewStatus === "approved" ? "Review has been approved"
                : reviewStatus === "changes_requested" ? "Changes are requested by reviewers"
                  : "At least 1 approving review is required"
            }
          />

          {/* Checks status */}
          <MergeStatusRow
            color={allChecksPassed ? COLORS.success : someChecksFailing ? COLORS.danger : COLORS.warning}
            icon={
              allChecksPassed
                ? <CheckCircle size={18} weight="fill" style={{ color: COLORS.success, filter: "drop-shadow(0 0 4px rgba(34,197,94,0.4))" }} />
                : someChecksFailing
                  ? <XCircle size={18} weight="fill" style={{ color: COLORS.danger, filter: "drop-shadow(0 0 4px rgba(239,68,68,0.4))" }} />
                  : <CircleNotch size={18} className="animate-spin" style={{ color: COLORS.warning, filter: "drop-shadow(0 0 4px rgba(245,158,11,0.4))" }} />
            }
            title={
              allChecksPassed ? "All checks have passed"
                : someChecksFailing ? "Some checks failing"
                  : checks.length === 0 ? "No checks" : "Checks in progress"
            }
            description={
              allChecksPassed ? `${passing} successful check${passing !== 1 ? "s" : ""}`
                : someChecksFailing ? `${passing}/${checks.length} checks passing`
                  : checks.length === 0 ? "No status checks are required" : `${pending} check${pending !== 1 ? "s" : ""} pending`
            }
            expandable={checks.length > 0}
            expanded={checksExpanded}
            onToggle={() => setChecksExpanded(!checksExpanded)}
          >
            <div style={{ padding: "4px 0" }}>
              {checks.map((check, idx) => {
                const checkColor = check.conclusion === "success" ? COLORS.success : check.conclusion === "failure" ? COLORS.danger : check.status === "in_progress" ? COLORS.warning : COLORS.textMuted;
                return (
                  <div key={`${check.name}-${idx}`} style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "8px 16px",
                    borderBottom: idx < checks.length - 1 ? `1px solid ${COLORS.borderMuted}` : "none",
                  }}>
                    <CheckIcon check={check} />
                    <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textPrimary, flex: 1 }}>{check.name}</span>
                    <span style={{ fontFamily: SANS_FONT, fontSize: 10, fontWeight: 600, color: checkColor, textTransform: "uppercase", letterSpacing: "0.3px" }}>
                      {check.conclusion ?? check.status}
                    </span>
                    {check.detailsUrl && (
                      <button
                        type="button"
                        onClick={() => void window.ade.app.openExternal(check.detailsUrl!)}
                        style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.textDim, padding: 2 }}
                      >
                        <GithubLogo size={12} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </MergeStatusRow>

          {/* Merge conflicts / mergeable status */}
          <MergeStatusRow
            color={status?.isMergeable && !status?.mergeConflicts ? COLORS.success : status?.mergeConflicts ? COLORS.danger : COLORS.warning}
            icon={
              status?.isMergeable && !status?.mergeConflicts
                ? <CheckCircle size={18} weight="fill" style={{ color: COLORS.success, filter: "drop-shadow(0 0 4px rgba(34,197,94,0.4))" }} />
                : status?.mergeConflicts
                  ? <XCircle size={18} weight="fill" style={{ color: COLORS.danger, filter: "drop-shadow(0 0 4px rgba(239,68,68,0.4))" }} />
                  : <Warning size={18} weight="fill" style={{ color: COLORS.warning, filter: "drop-shadow(0 0 4px rgba(245,158,11,0.4))" }} />
            }
            title={
              status?.isMergeable && !status?.mergeConflicts ? "Ready to merge"
                : status?.mergeConflicts ? "Merge conflicts"
                  : status ? "Merging is blocked" : "Checking merge status..."
            }
            description={
              status?.isMergeable && !status?.mergeConflicts ? "This branch has no conflicts with the base branch"
                : status?.mergeConflicts ? "This branch has conflicts that must be resolved"
                  : status && !status.isMergeable ? "Required conditions have not been met"
                    : "Waiting for merge status check"
            }
          />

          {/* Merge action area */}
          {(pr.state === "open" || pr.state === "draft") && (
            <div style={{ padding: "16px", borderTop: `1px solid ${COLORS.border}`, background: canMerge ? `${COLORS.success}06` : "transparent" }}>
              {/* Merge method selector */}
              <div style={{ display: "flex", alignItems: "center", gap: 2, marginBottom: 14, background: COLORS.recessedBg, borderRadius: 8, padding: 3, border: `1px solid ${COLORS.border}` }}>
                {(["squash", "merge", "rebase"] as const).map((m) => {
                  const isActive = localMergeMethod === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setLocalMergeMethod(m)}
                      style={{
                        flex: 1, height: 30, border: "none", borderRadius: 6, cursor: "pointer",
                        fontFamily: SANS_FONT, fontSize: 12, fontWeight: isActive ? 600 : 400,
                        color: isActive ? COLORS.textPrimary : COLORS.textMuted,
                        background: isActive ? `${COLORS.success}18` : "transparent",
                        boxShadow: isActive ? `0 0 0 1px ${COLORS.success}30` : "none",
                        transition: "all 120ms ease",
                        textTransform: "capitalize",
                      }}
                    >
                      {m === "squash" ? "Squash and merge" : m === "merge" ? "Create merge commit" : "Rebase and merge"}
                    </button>
                  );
                })}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button
                  type="button"
                  disabled={actionBusy || !canMerge}
                  onClick={() => void props.onMerge()}
                  style={{
                    ...primaryButton({
                      background: canMerge ? `linear-gradient(135deg, ${COLORS.success} 0%, #16a34a 100%)` : COLORS.recessedBg,
                      borderColor: canMerge ? COLORS.success : COLORS.border,
                      opacity: actionBusy || !canMerge ? 0.5 : 1,
                      height: 40,
                      padding: "0 24px",
                      fontSize: 14,
                      fontWeight: 700,
                      boxShadow: canMerge && !actionBusy ? `0 2px 16px ${COLORS.success}40, 0 0 0 1px ${COLORS.success}30` : "none",
                    }),
                    color: canMerge ? "#fff" : COLORS.textMuted,
                    flex: 1,
                  }}
                >
                  <GitMerge size={16} weight="bold" />
                  {actionBusy ? "Merging..." : "Merge pull request"}
                </button>

                {pr.state === "open" && (
                  <button type="button" disabled={actionBusy} onClick={() => void props.onClose()} style={dangerButton({ height: 40, opacity: actionBusy ? 0.4 : 1, padding: "0 16px" })}>
                    <XCircle size={14} /> Close
                  </button>
                )}
              </div>

              {pr.state === "open" && (
                <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 12 }}>
                  <button type="button" onClick={() => props.onNavigate(`/lanes?laneId=${encodeURIComponent(pr.laneId)}`)} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim, padding: 0, textDecoration: "underline", textUnderlineOffset: 2 }}>
                    View lane
                  </button>
                </div>
              )}
            </div>
          )}
          {pr.state === "closed" && (
            <div style={{ padding: "16px", borderTop: `1px solid ${COLORS.border}` }}>
              <button type="button" disabled={actionBusy} onClick={() => void props.onReopen()} style={outlineButton({ color: COLORS.success, borderColor: `${COLORS.success}40`, height: 36 })}>
                <ArrowsClockwise size={14} /> Reopen PR
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ---- Right Sidebar ---- */}
      <div style={{ width: 250, borderLeft: `1px solid ${COLORS.border}`, overflow: "auto", padding: 18, flexShrink: 0, display: "flex", flexDirection: "column", gap: 0, background: `linear-gradient(180deg, rgba(167,139,250,0.02) 0%, transparent 40%)` }}>
        {/* Reviewers */}
        <SidebarSection title="Reviewers" onEdit={() => props.setShowReviewerEditor(!props.showReviewerEditor)}>
          {detail?.requestedReviewers?.length ? (
            detail.requestedReviewers.map((r) => (
              <div key={r.login} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                <Avatar user={r} size={22} />
                <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textPrimary, fontWeight: 500 }}>{r.login}</span>
              </div>
            ))
          ) : (
            <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textDim }}>None</span>
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
        <SidebarSection title="Labels" onEdit={() => props.setShowLabelEditor(!props.showLabelEditor)}>
          {detail?.labels?.length ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {detail.labels.map((l) => (
                <span key={l.name} style={{
                  display: "inline-flex", alignItems: "center", padding: "3px 10px",
                  fontSize: 11, fontWeight: 600, fontFamily: SANS_FONT,
                  color: `#${l.color}`,
                  background: `#${l.color}18`,
                  border: `1px solid #${l.color}35`,
                  borderRadius: 12,
                  boxShadow: `0 0 8px #${l.color}10`,
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: `#${l.color}`, marginRight: 6, flexShrink: 0 }} />
                  {l.name}
                </span>
              ))}
            </div>
          ) : (
            <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textDim }}>None</span>
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
        <SidebarSection title="Author">
          {detail?.author ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Avatar user={detail.author} size={24} />
              <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textPrimary, fontWeight: 500 }}>{detail.author.login}</span>
            </div>
          ) : (
            <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textDim }}>---</span>
          )}
        </SidebarSection>

        {/* Quick Stats */}
        <SidebarSection title="Stats">
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
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div style={{ background: COLORS.cardBgSolid, border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 16, padding: 24, width: 500, maxHeight: "80vh", overflow: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
              <span style={{ fontFamily: SANS_FONT, fontSize: 15, fontWeight: 600, color: COLORS.textPrimary }}>Submit Review</span>
              <button type="button" onClick={() => props.setShowReviewModal(false)} style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.textMuted, padding: 4 }}><X size={16} /></button>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
              {(["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const).map((ev) => {
                const isSelected = props.reviewEvent === ev;
                const evColor = ev === "APPROVE" ? COLORS.success : ev === "REQUEST_CHANGES" ? COLORS.warning : COLORS.info;
                return (
                  <button key={ev} type="button" onClick={() => props.setReviewEvent(ev)} style={{
                    ...outlineButton(),
                    flex: 1, height: 36,
                    background: isSelected ? `${evColor}18` : "transparent",
                    borderColor: isSelected ? `${evColor}60` : COLORS.border,
                    color: isSelected ? evColor : COLORS.textSecondary,
                    boxShadow: isSelected ? `0 0 12px ${evColor}15` : "none",
                  }}>
                    {ev === "APPROVE" && <CheckCircle size={14} weight={isSelected ? "fill" : "regular"} />}
                    {ev === "REQUEST_CHANGES" && <Warning size={14} weight={isSelected ? "fill" : "regular"} />}
                    {ev === "COMMENT" && <ChatText size={14} weight={isSelected ? "fill" : "regular"} />}
                    {ev === "APPROVE" ? "Approve" : ev === "REQUEST_CHANGES" ? "Request Changes" : "Comment"}
                  </button>
                );
              })}
            </div>
            <textarea
              value={props.reviewBody}
              onChange={(e) => props.setReviewBody(e.target.value)}
              placeholder="Leave a review comment (optional for approve)..."
              style={{
                width: "100%", minHeight: 120, resize: "vertical", padding: 14,
                fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textPrimary,
                background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, borderRadius: 10, outline: "none",
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14, gap: 8 }}>
              <button type="button" onClick={() => props.setShowReviewModal(false)} style={outlineButton({ height: 36 })}>Cancel</button>
              <button type="button" onClick={() => void props.onSubmitReview()} disabled={actionBusy} style={{
                ...primaryButton({
                  background: props.reviewEvent === "APPROVE" ? `linear-gradient(135deg, ${COLORS.success} 0%, #16a34a 100%)` : props.reviewEvent === "REQUEST_CHANGES" ? `linear-gradient(135deg, ${COLORS.warning} 0%, #d97706 100%)` : `linear-gradient(135deg, ${COLORS.accent} 0%, #7c3aed 100%)`,
                  height: 36,
                  boxShadow: `0 2px 12px ${props.reviewEvent === "APPROVE" ? COLORS.success : props.reviewEvent === "REQUEST_CHANGES" ? COLORS.warning : COLORS.accent}30`,
                }),
                color: "#fff",
              }}>
                {actionBusy ? "Submitting..." : `Submit ${props.reviewEvent === "APPROVE" ? "Approval" : props.reviewEvent === "REQUEST_CHANGES" ? "Changes Request" : "Comment"}`}
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
          <span style={{ ...LABEL_STYLE, fontSize: 12, fontWeight: 600, color: COLORS.textSecondary }}>Files Changed ({files.length})</span>
          <span style={{ fontFamily: MONO_FONT, fontSize: 12, fontWeight: 600, color: COLORS.success, background: `${COLORS.success}12`, padding: "2px 8px", borderRadius: 6 }}>+{totalAdd}</span>
          <span style={{ fontFamily: MONO_FONT, fontSize: 12, fontWeight: 600, color: COLORS.danger, background: `${COLORS.danger}12`, padding: "2px 8px", borderRadius: 6 }}>-{totalDel}</span>
        </div>
      </div>
      {files.length === 0 ? (
        <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textDim }}>No files changed</div>
      ) : (
        <div style={{ ...cardStyle(), padding: 0, overflow: "hidden" }}>
          {files.map((file, idx) => {
            const isExpanded = expandedFile === file.filename;
            const statusCol = fileStatusColor(file.status);
            return (
              <div key={file.filename}>
                <button
                  type="button"
                  onClick={() => setExpandedFile(isExpanded ? null : file.filename)}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, width: "100%",
                    padding: "10px 14px", border: "none", cursor: "pointer",
                    background: isExpanded ? `${statusCol}08` : "transparent",
                    borderBottom: idx < files.length - 1 || isExpanded ? `1px solid ${COLORS.border}` : "none",
                    textAlign: "left",
                    transition: "background 120ms ease",
                    borderLeft: isExpanded ? `3px solid ${statusCol}` : "3px solid transparent",
                  }}
                  onMouseEnter={(e) => { if (!isExpanded) e.currentTarget.style.background = COLORS.hoverBg; }}
                  onMouseLeave={(e) => { if (!isExpanded) e.currentTarget.style.background = "transparent"; }}
                >
                  {isExpanded ? <CaretDown size={12} style={{ color: statusCol }} /> : <CaretRight size={12} style={{ color: COLORS.textMuted }} />}
                  <span style={{
                    fontFamily: MONO_FONT, fontSize: 10, fontWeight: 700,
                    color: statusCol, width: 20, height: 20, textAlign: "center",
                    background: `${statusCol}15`, borderRadius: 4, lineHeight: "20px",
                  }}>
                    {fileStatusLabel(file.status)}
                  </span>
                  <span style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textPrimary, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {file.filename}
                  </span>
                  <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.success, fontWeight: 600 }}>+{file.additions}</span>
                  <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.danger, fontWeight: 600 }}>-{file.deletions}</span>
                </button>
                {isExpanded && file.patch && (
                  <div style={{ background: "rgba(0,0,0,0.2)", borderBottom: `1px solid ${COLORS.border}`, overflow: "auto", maxHeight: 500 }}>
                    <pre style={{ fontFamily: MONO_FONT, fontSize: 11, lineHeight: 1.7, margin: 0, padding: 0 }}>
                      {file.patch.split("\n").map((line, i) => {
                        let color: string = COLORS.textSecondary;
                        let bg: string = "transparent";
                        if (line.startsWith("+")) { color = "#4ade80"; bg = "rgba(34,197,94,0.12)"; }
                        else if (line.startsWith("-")) { color = "#f87171"; bg = "rgba(239,68,68,0.12)"; }
                        else if (line.startsWith("@@")) { color = COLORS.accent; bg = `${COLORS.accent}0A`; }
                        return (
                          <div key={i} style={{ color, background: bg, padding: "1px 14px", minHeight: "1.7em", borderLeft: line.startsWith("+") ? `3px solid ${COLORS.success}50` : line.startsWith("-") ? `3px solid ${COLORS.danger}50` : "3px solid transparent" }}>
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
  const [collapsedGroups, setCollapsedGroups] = React.useState<Record<string, boolean>>({});

  const passing = checks.filter(c => c.conclusion === "success").length;
  const failing = checks.filter(c => c.conclusion === "failure").length;
  const pending = checks.filter(c => c.status !== "completed").length;
  const total = checks.length;

  // Group checks by provider: slash-delimited prefix or "CI" default
  const checkGroups = React.useMemo(() => {
    const groups: Record<string, PrCheck[]> = {};
    for (const check of checks) {
      const slashIdx = check.name.indexOf("/");
      const provider = slashIdx > 0 ? check.name.slice(0, slashIdx).trim() : "CI";
      if (!groups[provider]) groups[provider] = [];
      groups[provider].push(check);
    }
    // Sort: groups with failures first, then alphabetically
    return Object.entries(groups).sort(([aName, aChecks], [bName, bChecks]) => {
      const aFail = aChecks.some(c => c.conclusion === "failure") ? 0 : 1;
      const bFail = bChecks.some(c => c.conclusion === "failure") ? 0 : 1;
      if (aFail !== bFail) return aFail - bFail;
      return aName.localeCompare(bName);
    });
  }, [checks]);

  // Group action runs by workflow name
  const runGroups = React.useMemo(() => {
    const groups: Record<string, PrActionRun[]> = {};
    for (const run of actionRuns) {
      if (!groups[run.name]) groups[run.name] = [];
      groups[run.name].push(run);
    }
    return Object.entries(groups);
  }, [actionRuns]);

  const toggleGroup = (key: string) => {
    setCollapsedGroups(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const groupStateColor = (items: PrCheck[]) => {
    if (items.some(c => c.conclusion === "failure")) return "#EF4444";
    if (items.some(c => c.status !== "completed")) return "#F59E0B";
    return "#22C55E";
  };

  const summaryText = failing > 0
    ? `${failing} failing, ${passing} passing${pending > 0 ? `, ${pending} pending` : ""}`
    : pending > 0
      ? `${passing} passing, ${pending} pending`
      : `${passing}/${total} checks passing`;

  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Summary bar with segmented progress */}
      <div style={cardStyle({ padding: 0, overflow: "hidden" })}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px" }}>
          <span style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>
            {summaryText}
          </span>
          <button type="button" disabled={actionBusy} onClick={onRerunChecks} style={outlineButton({ height: 30, color: COLORS.warning, borderColor: `${COLORS.warning}40` })}>
            <ArrowsClockwise size={14} /> Re-run Failed
          </button>
        </div>
        {total > 0 && (
          <div style={{ display: "flex", height: 4 }}>
            {passing > 0 && <div style={{ flex: passing, background: "#22C55E", transition: "flex 300ms ease" }} />}
            {failing > 0 && <div style={{ flex: failing, background: "#EF4444", transition: "flex 300ms ease" }} />}
            {pending > 0 && <div style={{ flex: pending, background: "#F59E0B", transition: "flex 300ms ease" }} />}
          </div>
        )}
      </div>

      {/* Grouped check runs */}
      {checks.length === 0 ? (
        <div style={cardStyle()}>
          <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textDim }}>No checks found</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {checkGroups.map(([provider, groupChecks]) => {
            const groupKey = `check-${provider}`;
            const isCollapsed = collapsedGroups[groupKey] ?? false;
            const groupPassing = groupChecks.filter(c => c.conclusion === "success").length;
            const groupTotal = groupChecks.length;
            const stateColor = groupStateColor(groupChecks);
            const allPassing = groupPassing === groupTotal;

            return (
              <div key={groupKey} style={cardStyle({ padding: 0, overflow: "hidden" })}>
                {/* Provider group header */}
                <button
                  type="button"
                  onClick={() => toggleGroup(groupKey)}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
                    padding: "11px 16px", border: "none", cursor: "pointer", textAlign: "left",
                    background: `${stateColor}08`,
                    transition: "background 120ms ease",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {isCollapsed
                      ? <CaretRight size={12} style={{ color: COLORS.textMuted }} />
                      : <CaretDown size={12} style={{ color: stateColor }} />}
                    <span style={{ fontFamily: SANS_FONT, fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }}>{provider}</span>
                  </div>
                  <span style={{
                    fontFamily: MONO_FONT, fontSize: 11, fontWeight: 600,
                    color: allPassing ? "#22C55E" : "#EF4444",
                    padding: "2px 8px", borderRadius: 6,
                    background: allPassing ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)",
                  }}>
                    {groupPassing}/{groupTotal}
                  </span>
                </button>

                {/* Individual checks within group */}
                {!isCollapsed && (
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    {groupChecks.map((check, idx) => {
                      // Strip provider prefix from display name for slash-grouped checks
                      const slashIdx = check.name.indexOf("/");
                      const displayName = slashIdx > 0 && check.name.slice(0, slashIdx).trim() === provider
                        ? check.name.slice(slashIdx + 1).trim()
                        : check.name;

                      return (
                        <div key={`${check.name}-${idx}`} style={{
                          display: "flex", alignItems: "center", justifyContent: "space-between",
                          padding: "9px 16px", borderTop: `1px solid ${COLORS.border}`,
                          background: check.conclusion === "failure" ? `${COLORS.danger}06` : "transparent",
                          transition: "background 100ms ease",
                        }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <CheckIcon check={check} />
                            <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textPrimary }}>{displayName}</span>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            {check.startedAt && check.completedAt && (
                              <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted }}>
                                {Math.round((new Date(check.completedAt).getTime() - new Date(check.startedAt).getTime()) / 1000)}s
                              </span>
                            )}
                            {check.detailsUrl && (
                              <button type="button" onClick={() => void window.ade.app.openExternal(check.detailsUrl!)} style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10, gap: 4 })}>
                                <GithubLogo size={11} /> View
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Action runs grouped by workflow */}
      {runGroups.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {runGroups.map(([workflowName, runs]) => {
            const groupKey = `run-${workflowName}`;
            const isGroupCollapsed = collapsedGroups[groupKey] ?? false;
            const latestRun = runs[0];
            const wfColor = latestRun.conclusion === "success" ? COLORS.success
              : latestRun.conclusion === "failure" ? COLORS.danger
              : latestRun.status === "in_progress" ? COLORS.warning
              : COLORS.textMuted;

            return (
              <div key={groupKey} style={cardStyle({ padding: 0, overflow: "hidden" })}>
                {/* Workflow group header */}
                <button
                  type="button"
                  onClick={() => toggleGroup(groupKey)}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
                    padding: "11px 16px", border: "none", cursor: "pointer", textAlign: "left",
                    background: `${wfColor}08`,
                    transition: "background 120ms ease",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {isGroupCollapsed
                      ? <CaretRight size={12} style={{ color: COLORS.textMuted }} />
                      : <CaretDown size={12} style={{ color: wfColor }} />}
                    {latestRun.conclusion === "success" ? <CheckCircle size={15} weight="fill" style={{ color: COLORS.success }} /> :
                     latestRun.conclusion === "failure" ? <XCircle size={15} weight="fill" style={{ color: COLORS.danger }} /> :
                     latestRun.status === "in_progress" ? <CircleNotch size={15} className="animate-spin" style={{ color: COLORS.warning }} /> :
                     <Circle size={15} style={{ color: COLORS.textMuted }} />}
                    <span style={{ fontFamily: SANS_FONT, fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }}>{workflowName}</span>
                    {runs.length > 1 && (
                      <span style={{ fontFamily: SANS_FONT, fontSize: 10, color: COLORS.textMuted }}>{runs.length} runs</span>
                    )}
                  </div>
                  <span style={{
                    fontFamily: MONO_FONT, fontSize: 10, fontWeight: 600, textTransform: "uppercase",
                    color: wfColor, padding: "2px 8px", borderRadius: 4, background: `${wfColor}12`,
                  }}>
                    {latestRun.conclusion ?? latestRun.status}
                  </span>
                </button>

                {/* Expanded runs inside the workflow group */}
                {!isGroupCollapsed && runs.map((run) => {
                  const isExpanded = expandedRun === run.id;
                  const runColor = run.conclusion === "success" ? COLORS.success
                    : run.conclusion === "failure" ? COLORS.danger
                    : run.status === "in_progress" ? COLORS.warning
                    : COLORS.textMuted;

                  return (
                    <div key={run.id} style={{ borderTop: `1px solid ${COLORS.border}` }}>
                      {/* Run row */}
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => setExpandedRun(isExpanded ? null : run.id)}
                        onKeyDown={(e) => { if (e.key === "Enter") setExpandedRun(isExpanded ? null : run.id); }}
                        style={{
                          display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
                          padding: "9px 16px 9px 32px", border: "none",
                          background: isExpanded ? `${runColor}06` : "transparent",
                          cursor: "pointer", textAlign: "left", transition: "background 120ms ease",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          {isExpanded
                            ? <CaretDown size={11} style={{ color: runColor }} />
                            : <CaretRight size={11} style={{ color: COLORS.textMuted }} />}
                          <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textSecondary }}>#{run.id}</span>
                          <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted }}>{formatTs(run.createdAt)}</span>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); void window.ade.app.openExternal(run.htmlUrl); }}
                          style={outlineButton({ height: 22, padding: "0 8px", fontSize: 10, gap: 4 })}
                        >
                          <GithubLogo size={11} /> View
                        </button>
                      </div>

                      {/* Expanded jobs and steps */}
                      {isExpanded && run.jobs.length > 0 && (
                        <div style={{ paddingLeft: 32, background: "rgba(0,0,0,0.12)" }}>
                          {run.jobs.map((job, jIdx) => (
                            <div key={job.id} style={{ padding: "10px 14px", borderBottom: jIdx < run.jobs.length - 1 ? `1px solid ${COLORS.border}` : "none" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                                {job.conclusion === "success" ? <CheckCircle size={14} weight="fill" style={{ color: COLORS.success }} /> :
                                 job.conclusion === "failure" ? <XCircle size={14} weight="fill" style={{ color: COLORS.danger }} /> :
                                 <CircleNotch size={14} className="animate-spin" style={{ color: COLORS.warning }} />}
                                <span style={{ fontFamily: SANS_FONT, fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }}>{job.name}</span>
                              </div>
                              {job.steps.length > 0 && (
                                <div style={{ paddingLeft: 22 }}>
                                  {job.steps.map((step) => (
                                    <div key={step.number} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
                                      {step.conclusion === "success" ? <CheckCircle size={11} weight="fill" style={{ color: COLORS.success }} /> :
                                       step.conclusion === "failure" ? <XCircle size={11} weight="fill" style={{ color: COLORS.danger }} /> :
                                       step.conclusion === "skipped" ? <Circle size={11} style={{ color: COLORS.textDim }} /> :
                                       <CircleNotch size={11} className="animate-spin" style={{ color: COLORS.warning }} />}
                                      <span style={{
                                        fontFamily: SANS_FONT, fontSize: 11,
                                        color: step.conclusion === "failure" ? COLORS.danger
                                          : step.conclusion === "success" ? COLORS.textSecondary
                                          : COLORS.textMuted,
                                      }}>{step.name}</span>
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
            );
          })}
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
        id: c.id, type: "comment", author: c.author, avatarUrl: c.authorAvatarUrl || null,
        body: c.body, timestamp: c.createdAt ?? "", metadata: { path: c.path, line: c.line },
      });
    }
    for (const r of reviews) {
      events.push({
        id: `review-${r.reviewer}-${r.submittedAt}`, type: "review", author: r.reviewer, avatarUrl: r.reviewerAvatarUrl || null,
        body: r.body, timestamp: r.submittedAt ?? "", metadata: { state: r.state },
      });
    }
    return events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [activity, comments, reviews]);

  const activityColor = React.useCallback((event: PrActivityEvent) => {
    if (event.type === "review") return COLORS.accent;
    if (event.type === "comment") {
      return event.metadata?.source === "review" ? COLORS.warning : COLORS.info;
    }
    if (event.type === "ci_run") return COLORS.warning;
    if (event.type === "state_change") return COLORS.success;
    if (event.type === "deployment") return COLORS.success;
    if (event.type === "force_push") return COLORS.warning;
    if (event.type === "commit") return COLORS.accent;
    if (event.type === "label") return COLORS.info;
    return COLORS.textMuted;
  }, []);

  const activityLabel = React.useCallback((event: PrActivityEvent) => {
    if (event.type === "comment") {
      return event.metadata?.source === "review" ? "review comment" : "comment";
    }
    if (event.type === "review") return "review";
    if (event.type === "ci_run") return "CI";
    if (event.type === "state_change") return "state change";
    if (event.type === "review_request") return "review request";
    if (event.type === "deployment") return "deployed";
    if (event.type === "force_push") return "force push";
    if (event.type === "commit") return "commit";
    if (event.type === "label") return "label";
    return String(event.type).replace(/_/g, " ");
  }, []);

  const activityIcon = React.useCallback((event: PrActivityEvent) => {
    const col = activityColor(event);
    const iconStyle = { color: col, filter: `drop-shadow(0 0 3px ${col}40)` };
    if (event.type === "review") return <Check size={12} weight="bold" style={iconStyle} />;
    if (event.type === "comment") return <ChatText size={12} weight="fill" style={iconStyle} />;
    if (event.type === "ci_run") return <Play size={12} weight="fill" style={iconStyle} />;
    if (event.type === "state_change") return <GitMerge size={12} weight="fill" style={iconStyle} />;
    if (event.type === "review_request") return <Eye size={12} weight="fill" style={iconStyle} />;
    if (event.type === "deployment") return <Rocket size={12} weight="fill" style={iconStyle} />;
    if (event.type === "force_push") return <ArrowsClockwise size={12} weight="bold" style={iconStyle} />;
    if (event.type === "commit") return <GitCommit size={12} weight="bold" style={iconStyle} />;
    if (event.type === "label") return <Tag size={12} weight="fill" style={iconStyle} />;
    return <Circle size={10} weight="fill" style={iconStyle} />;
  }, [activityColor]);

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
              flex: 1, minHeight: 60, resize: "vertical", padding: 12,
              fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textPrimary,
              background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, borderRadius: 10, outline: "none",
            }}
          />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <button type="button" onClick={() => void onAddComment()} disabled={actionBusy || !commentDraft.trim()} style={primaryButton({ height: 30, opacity: actionBusy || !commentDraft.trim() ? 0.4 : 1 })}>
            <ChatText size={13} /> Comment
          </button>
        </div>
      </div>

      {/* Timeline */}
      <div style={cardStyle()}>
        <span style={{ ...LABEL_STYLE, fontSize: 12, fontWeight: 600, color: COLORS.textSecondary, marginBottom: 16, display: "block" }}>Timeline ({timeline.length})</span>
        {timeline.length === 0 ? (
          <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textDim }}>No activity yet</div>
        ) : (
          <div style={{ position: "relative", paddingLeft: 32 }}>
            {/* Vertical timeline line with gradient */}
            <div style={{
              position: "absolute", left: 11, top: 4, bottom: 4, width: 2,
              background: `linear-gradient(180deg, ${COLORS.accent}40 0%, ${COLORS.border} 50%, ${COLORS.textDim}20 100%)`,
              borderRadius: 1,
            }} />
            {timeline.map((event, idx) => {
              const evColor = activityColor(event);
              return (
                <div key={event.id} style={{ position: "relative", paddingBottom: idx < timeline.length - 1 ? 20 : 0 }}>
                  {/* Icon dot */}
                  <div style={{
                    position: "absolute", left: -26, top: 2, width: 24, height: 24,
                    borderRadius: "50%",
                    background: `${evColor}18`,
                    border: `2px solid ${evColor}40`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    boxShadow: `0 0 8px ${evColor}20`,
                  }}>
                    {activityIcon(event)}
                  </div>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <span style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>{event.author}</span>
                      <span style={inlineBadge(evColor)}>
                        {activityLabel(event)}
                      </span>
                      {event.type === "review" && typeof event.metadata?.state === "string" ? (
                        <span style={inlineBadge(event.metadata.state === "approved" ? COLORS.success : event.metadata.state === "changes_requested" ? COLORS.warning : COLORS.textSecondary)}>
                          {String(event.metadata.state).replace(/_/g, " ")}
                        </span>
                      ) : null}
                      {event.type === "comment" && typeof event.metadata?.path === "string" ? (
                        <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.accent, background: `${COLORS.accent}14`, padding: "2px 8px", borderRadius: 6 }}>
                          {String(event.metadata.path)}{typeof event.metadata?.line === "number" ? `:${event.metadata.line}` : ""}
                        </span>
                      ) : null}
                      {event.type === "deployment" && typeof event.metadata?.environment === "string" ? (
                        <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.success, background: `${COLORS.success}14`, padding: "2px 8px", borderRadius: 6 }}>
                          {String(event.metadata.environment)}
                        </span>
                      ) : null}
                      {event.type === "commit" && typeof event.metadata?.shortSha === "string" ? (
                        <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.accent, background: `${COLORS.accent}14`, padding: "2px 8px", borderRadius: 6 }}>
                          {String(event.metadata.shortSha)}
                        </span>
                      ) : null}
                      {event.type === "force_push" && (
                        <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.warning, background: `${COLORS.warning}14`, padding: "2px 8px", borderRadius: 6 }}>
                          {typeof event.metadata?.beforeSha === "string" ? `${String(event.metadata.beforeSha).slice(0, 7)} → ${String(event.metadata?.afterSha ?? "").slice(0, 7)}` : "branch updated"}
                        </span>
                      )}
                      <span style={{ marginLeft: "auto", fontFamily: MONO_FONT, fontSize: 10, color: "#8B7355" }}>{formatTs(event.timestamp)}</span>
                    </div>
                    {event.body && (
                      <div style={{ padding: "4px 0 4px 0" }}>
                        <MarkdownBody markdown={event.body} />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ================================================================
// SHARED COMPONENTS
// ================================================================

function StatusSignal({ label, value, color, glow }: { label: string; value: string; color: string; glow?: boolean }) {
  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 5, padding: "12px 8px",
      background: glow ? `${color}08` : "transparent",
      transition: "background 200ms ease",
    }}>
      <span style={{ ...LABEL_STYLE, fontSize: 10, letterSpacing: "0.02em" }}>{label}</span>
      <span style={{
        fontFamily: MONO_FONT, fontSize: 15, fontWeight: 700, color,
        textShadow: glow ? `0 0 10px ${color}50` : "none",
      }}>{value}</span>
    </div>
  );
}

function SidebarSection({ title, children, onEdit }: { title: string; children: React.ReactNode; onEdit?: () => void }) {
  return (
    <div style={{ padding: "14px 0", borderBottom: `1px solid ${COLORS.border}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontFamily: SANS_FONT, fontSize: 11, fontWeight: 600, color: COLORS.textMuted, letterSpacing: "0.02em" }}>{title}</span>
        {onEdit && (
          <button type="button" onClick={onEdit} style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.textDim, padding: 2, opacity: 0.7 }}>
            <PencilSimple size={12} />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  const colorMap: Record<string, string> = { "Checks": COLORS.success, "Reviews": COLORS.accent };
  const accentColor = colorMap[label];
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "3px 0" }}>
      <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>{label}</span>
      <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: accentColor ?? COLORS.textPrimary, textAlign: "right", fontWeight: accentColor ? 600 : 400 }}>{value}</span>
    </div>
  );
}

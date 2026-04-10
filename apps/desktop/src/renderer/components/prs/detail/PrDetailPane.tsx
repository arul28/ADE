import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import {
  GitBranch, GitMerge, GitCommit, GithubLogo, CheckCircle, XCircle, Circle,
  CircleNotch, Sparkle, ArrowRight, Eye, ChatText, Code, ClockCounterClockwise,
  PencilSimple, X, Check, ArrowsClockwise, Warning, Play, Rocket, Tag,
  CaretDown, CaretRight, UserCircle, DotsThreeVertical, Robot, Stack as Layers,
} from "@phosphor-icons/react";
import type {
  PrWithConflicts, PrCheck, PrReview, PrComment, PrStatus, PrDetail,
  PrFile, PrActionRun, PrActivityEvent, AiReviewSummary, PrReviewThread,
  LaneSummary, MergeMethod, LandResult,
  IssueInventorySnapshot,
  PipelineSettings,
  PrConvergenceState,
  PrConvergenceStatePatch,
} from "../../../../shared/types";
import { DEFAULT_PIPELINE_SETTINGS } from "../../../../shared/types";
import { getPrIssueResolutionAvailability } from "../../../../shared/prIssueResolution";
import { COLORS, MONO_FONT, SANS_FONT, LABEL_STYLE, cardStyle, inlineBadge, outlineButton, primaryButton, dangerButton } from "../../lanes/laneDesignTokens";
import { getPrChecksBadge, getPrReviewsBadge, getPrStateBadge, InlinePrBadge, PrCiRunningIndicator } from "../shared/prVisuals";
import { PrIssueResolverModal } from "../shared/PrIssueResolverModal";
import { PrConvergencePanel } from "../shared/PrConvergencePanel";
import type { IssueInventoryItem as PanelIssueItem, ConvergenceStatus as PanelConvergence, AutoConvergeWaitState } from "../shared/PrConvergencePanel";
import { PrLaneCleanupBanner } from "../shared/PrLaneCleanupBanner";
import { formatTimeAgo, formatTimestampFull } from "../shared/prFormatters";
import { describePrTargetDiff } from "../shared/laneBranchTargets";
import { findMatchingRebaseNeed, rebaseNeedItemKey } from "../shared/rebaseNeedUtils";
import { usePrs } from "../state/PrsContext";

// ---- Sub-tab type ----
type DetailTab = "overview" | "convergence" | "files" | "checks" | "activity";

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
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
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

// ---- Shared activity event helpers (used by OverviewTab and ActivityTab) ----
function activityEventColor(ev: PrActivityEvent): string {
  if (ev.type === "comment") return ev.metadata?.source === "review" ? COLORS.warning : COLORS.info;
  if (ev.type === "review") return COLORS.accent;
  if (ev.type === "state_change") return COLORS.success;
  if (ev.type === "deployment") return COLORS.success;
  if (ev.type === "force_push") return COLORS.warning;
  if (ev.type === "commit") return COLORS.accent;
  if (ev.type === "ci_run") return COLORS.warning;
  if (ev.type === "label") return COLORS.info;
  return COLORS.textMuted;
}

function activityEventLabel(ev: PrActivityEvent): string {
  if (ev.type === "comment") return ev.metadata?.source === "review" ? "review comment" : "comment";
  if (ev.type === "review") return "review";
  if (ev.type === "state_change") return "state change";
  if (ev.type === "deployment") return "deployed";
  if (ev.type === "force_push") return "force push";
  if (ev.type === "commit") return "commit";
  if (ev.type === "ci_run") return "CI";
  if (ev.type === "label") return "label";
  if (ev.type === "review_request") return "review request";
  return String(ev.type).replace(/_/g, " ");
}

function ActivityEventIcon({ event, withGlow }: { event: PrActivityEvent; withGlow?: boolean }) {
  const col = activityEventColor(event);
  const s = withGlow
    ? { color: col, filter: `drop-shadow(0 0 3px ${col}40)` }
    : { color: col, flexShrink: 0 as const };

  if (event.type === "comment") return <ChatText size={12} weight="fill" style={s} />;
  if (event.type === "review") return <Check size={12} weight="bold" style={s} />;
  if (event.type === "state_change") return <GitMerge size={12} weight="fill" style={s} />;
  if (event.type === "deployment") return <Rocket size={12} weight="fill" style={s} />;
  if (event.type === "force_push") return <ArrowsClockwise size={12} weight="bold" style={s} />;
  if (event.type === "commit") return <GitCommit size={12} weight="bold" style={s} />;
  if (event.type === "ci_run") return <Play size={12} weight="fill" style={s} />;
  if (event.type === "label") return <Tag size={12} weight="fill" style={s} />;
  if (event.type === "review_request") return <Eye size={12} weight="fill" style={s} />;
  return <Circle size={10} weight="fill" style={s} />;
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

type ChecksSummary = {
  passing: number;
  failing: number;
  pending: number;
  total: number;
  allChecksPassed: boolean;
  someChecksFailing: boolean;
  checksRunning: boolean;
};

function summarizeChecks(checks: PrCheck[]): ChecksSummary {
  const passing = checks.filter((check) => check.conclusion === "success" || check.conclusion === "neutral" || check.conclusion === "skipped").length;
  const failing = checks.filter((check) => check.conclusion === "failure" || check.conclusion === "cancelled").length;
  const pending = checks.filter((check) => check.status !== "completed").length;
  return {
    passing,
    failing,
    pending,
    total: checks.length,
    allChecksPassed: checks.length > 0 && failing === 0 && pending === 0,
    someChecksFailing: failing > 0,
    checksRunning: pending > 0,
  };
}

function getChecksRowVisuals(summary: ChecksSummary): { color: string; title: string; description: string } {
  const { passing, pending, total, allChecksPassed, someChecksFailing, checksRunning } = summary;

  if (allChecksPassed) {
    return {
      color: COLORS.success,
      title: "All checks have passed",
      description: `${passing} successful check${passing !== 1 ? "s" : ""}`,
    };
  }
  if (someChecksFailing) {
    return {
      color: COLORS.danger,
      title: "Some checks failing",
      description: checksRunning
        ? `${passing}/${total} checks passing, ${pending} still running`
        : `${passing}/${total} checks passing`,
    };
  }
  if (total === 0) {
    return {
      color: COLORS.textMuted,
      title: "No checks",
      description: "No status checks are required",
    };
  }
  return {
    color: COLORS.warning,
    title: "Checks in progress",
    description: `${pending} check${pending !== 1 ? "s" : ""} pending`,
  };
}

function getChecksRowIcon(summary: ChecksSummary): React.ReactNode {
  if (summary.allChecksPassed) {
    return <CheckCircle size={18} weight="fill" style={{ color: COLORS.success, filter: "drop-shadow(0 0 4px rgba(34,197,94,0.4))" }} />;
  }
  if (summary.someChecksFailing) {
    return <XCircle size={18} weight="fill" style={{ color: COLORS.danger, filter: "drop-shadow(0 0 4px rgba(239,68,68,0.4))" }} />;
  }
  if (summary.total === 0) {
    return <CheckCircle size={18} weight="fill" style={{ color: COLORS.textMuted }} />;
  }
  return <CircleNotch size={18} className="animate-spin" style={{ color: COLORS.warning, filter: "drop-shadow(0 0 4px rgba(245,158,11,0.4))" }} />;
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
  onShowInGraph?: (laneId: string) => void;
  onOpenRebaseTab?: (laneId?: string) => void;
  queueContext?: { groupId: string; label?: string | null } | null;
  onOpenQueueView?: (groupId: string) => void;
};

export function PrDetailPane({
  pr,
  status,
  checks,
  reviews,
  comments,
  detailBusy,
  lanes,
  mergeMethod,
  onRefresh,
  onNavigate,
  onShowInGraph,
  onOpenRebaseTab,
  queueContext,
  onOpenQueueView,
}: PrDetailPaneProps) {
  const {
    convergenceStatesByPrId,
    loadConvergenceState,
    saveConvergenceState,
    resetConvergenceState,
    rebaseNeeds,
    resolverModel,
    resolverReasoningLevel,
    resolverPermissionMode,
    setResolverModel,
    setResolverReasoningLevel,
    setResolverPermissionMode,
  } = usePrs();
  const [activeTab, setActiveTab] = React.useState<DetailTab>("overview");
  const [detail, setDetail] = React.useState<PrDetail | null>(null);
  const [files, setFiles] = React.useState<PrFile[]>([]);
  const [actionRuns, setActionRuns] = React.useState<PrActionRun[]>([]);
  const [activity, setActivity] = React.useState<PrActivityEvent[]>([]);
  const [reviewThreads, setReviewThreads] = React.useState<PrReviewThread[]>([]);
  const [aiSummary, setAiSummary] = React.useState<AiReviewSummary | null>(null);
  const [aiSummaryBusy, setAiSummaryBusy] = React.useState(false);
  const [showIssueResolverModal, setShowIssueResolverModal] = React.useState(false);
  const [issueResolverBusy, setIssueResolverBusy] = React.useState(false);
  const [issueResolverCopyBusy, setIssueResolverCopyBusy] = React.useState(false);
  const [issueResolverCopyNotice, setIssueResolverCopyNotice] = React.useState<string | null>(null);
  const [issueResolverError, setIssueResolverError] = React.useState<string | null>(null);

  // Convergence panel state
  const [inventorySnapshot, setInventorySnapshot] = React.useState<IssueInventorySnapshot | null>(null);
  const [convergenceChecks, setConvergenceChecks] = React.useState<PrCheck[]>(checks);
  const [convergenceBusy, setConvergenceBusy] = React.useState(false);
  const [autoConverge, setAutoConverge] = React.useState(false);
  const [convergenceSessionId, setConvergenceSessionId] = React.useState<string | null>(null);
  const [, setConvergenceMerged] = React.useState(false);
  const [, setConvergencePauseReason] = React.useState<string | null>(null);
  const [convergenceSessionHref, setConvergenceSessionHref] = React.useState<string | null>(null);
  const autoConvergeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const convergenceSessionPollerRef = React.useRef<number | null>(null);
  const convergenceLoadSeqRef = React.useRef(0);
  const convergenceTabLoadSeqRef = React.useRef(0);
  const cachedConvergenceRuntimeRef = React.useRef<PrConvergenceState | null>(null);
  const behindCountRef = React.useRef<number>(0);
  const [autoConvergeWaitState, setAutoConvergeWaitState] = React.useState<AutoConvergeWaitState>({ phase: "idle" });
  const [pipelineSettings, setPipelineSettings] = React.useState<PipelineSettings>(DEFAULT_PIPELINE_SETTINGS);
  const pipelineSettingsRef = React.useRef<PipelineSettings>(DEFAULT_PIPELINE_SETTINGS);
  const mergeMethodRef = React.useRef<MergeMethod>(mergeMethod);
  mergeMethodRef.current = mergeMethod;
  const onRefreshRef = React.useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  cachedConvergenceRuntimeRef.current = convergenceStatesByPrId[pr.id] ?? null;

  React.useEffect(() => {
    setConvergenceChecks(checks);
  }, [checks, pr.id]);

  const buildSessionHref = React.useCallback((laneId: string, sessionId: string) => {
    const lane = encodeURIComponent(laneId);
    const session = encodeURIComponent(sessionId);
    return `/work?laneId=${lane}&sessionId=${session}`;
  }, []);

  const deriveWaitStateFromRuntime = React.useCallback((runtime: PrConvergenceState): AutoConvergeWaitState => {
    if (runtime.status === "merged") return { phase: "merged" };
    if (runtime.status === "converged") return { phase: "complete" };
    if (runtime.status === "paused") {
      return { phase: "paused", reason: runtime.pauseReason ?? "Auto-converge paused" };
    }
    if (runtime.status === "stopped") {
      return { phase: "idle" };
    }
    if (runtime.status === "failed" || runtime.status === "cancelled") {
      return {
        phase: "paused",
        reason: runtime.errorMessage ?? runtime.pauseReason ?? `Auto-converge ${runtime.status}`,
      };
    }
    if (runtime.activeSessionId) {
      return { phase: "agent_running", sessionId: runtime.activeSessionId };
    }
    if (runtime.pollerStatus === "waiting_for_checks") {
      return { phase: "waiting_checks", pendingCount: 0, totalCount: 0 };
    }
    if (runtime.pollerStatus === "waiting_for_comments") {
      return { phase: "waiting_comments", stablePollCount: 0 };
    }
    if (runtime.autoConvergeEnabled && (runtime.status === "launching" || runtime.status === "running" || runtime.status === "polling")) {
      return { phase: "waiting_checks", pendingCount: 0, totalCount: 0 };
    }
    return { phase: "idle" };
  }, []);

  const applyConvergenceRuntime = React.useCallback((runtime: PrConvergenceState | null) => {
    if (!runtime) {
      setConvergenceBusy(false);
      setAutoConverge(false);
      setConvergenceSessionId(null);
      setConvergenceSessionHref(null);
      setConvergenceMerged(false);
      setConvergencePauseReason(null);
      setAutoConvergeWaitState({ phase: "idle" });
      return;
    }

    const nextHref = runtime.activeHref ?? (
      runtime.activeLaneId && runtime.activeSessionId
        ? buildSessionHref(runtime.activeLaneId, runtime.activeSessionId)
        : null
    );

    setAutoConverge(runtime.autoConvergeEnabled);
    setConvergenceBusy(Boolean(runtime.activeSessionId) || runtime.status === "launching" || runtime.status === "running" || runtime.status === "polling");
    setConvergenceSessionId(runtime.activeSessionId);
    setConvergenceSessionHref(nextHref);
    setConvergenceMerged(runtime.status === "merged");
    setConvergencePauseReason(runtime.pauseReason);
    setAutoConvergeWaitState(deriveWaitStateFromRuntime(runtime));
  }, [buildSessionHref, deriveWaitStateFromRuntime]);

  const saveConvergenceRuntime = React.useCallback((partial: PrConvergenceStatePatch) => {
    void saveConvergenceState(pr.id, partial).catch((error: unknown) => {
      console.error("pr_detail.save_convergence_runtime_failed", {
        prId: pr.id,
        state: partial,
        error,
      });
    });
  }, [pr.id, saveConvergenceState]);

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
  // expandedRun state removed — the unified ChecksTab manages its own expand state
  const [expandedFile, setExpandedFile] = React.useState<string | null>(null);
  const detailLoadSeqRef = React.useRef(0);
  const inventoryLoadSeqRef = React.useRef(0);

  const loadDetail = React.useCallback(async () => {
    const requestId = ++detailLoadSeqRef.current;
    try {
      const [d, f, a, act, threads] = await Promise.all([
        window.ade.prs.getDetail(pr.id).catch(() => null),
        window.ade.prs.getFiles(pr.id).catch(() => []),
        window.ade.prs.getActionRuns(pr.id).catch(() => []),
        window.ade.prs.getActivity(pr.id).catch(() => []),
        window.ade.prs.getReviewThreads(pr.id).catch(() => []),
      ]);
      if (requestId !== detailLoadSeqRef.current) return;
      setDetail(d);
      setFiles(f);
      setActionRuns(a);
      setActivity(act);
      setReviewThreads(threads);
    } catch {
      // silently fail - basic data still available from context
    }
  }, [pr.id]);

  // Load detail on PR change
  React.useEffect(() => {
    setActionError(null);
    setActionResult(null);
    setIssueResolverError(null);
    setIssueResolverBusy(false);
    setIssueResolverCopyBusy(false);
    setIssueResolverCopyNotice(null);
    setShowIssueResolverModal(false);
    setInventorySnapshot(null);
    setConvergenceBusy(false);
    setPipelineSettings(DEFAULT_PIPELINE_SETTINGS);
    pipelineSettingsRef.current = DEFAULT_PIPELINE_SETTINGS;
    if (autoConvergeTimerRef.current) {
      clearTimeout(autoConvergeTimerRef.current);
      autoConvergeTimerRef.current = null;
    }
    if (autoConvergePollerRef.current) {
      clearTimeout(autoConvergePollerRef.current);
      autoConvergePollerRef.current = null;
    }
    lastCommentCountRef.current = -1;
    stableCountRef.current = 0;
    behindCountRef.current = 0;
    autoConvergeAdditionalRef.current = "";
    setEditingTitle(false);
    setEditingBody(false);
    setShowLabelEditor(false);
    setShowReviewerEditor(false);
    setShowReviewModal(false);

    const requestId = ++convergenceLoadSeqRef.current;
    const cachedRuntime = cachedConvergenceRuntimeRef.current;
    applyConvergenceRuntime(cachedRuntime);
    void loadConvergenceState(pr.id, { force: true })
      .then((runtime) => {
        if (requestId !== convergenceLoadSeqRef.current) return;
        applyConvergenceRuntime(runtime);
      })
      .catch(() => {
        if (requestId !== convergenceLoadSeqRef.current) return;
        if (!cachedRuntime) {
          applyConvergenceRuntime(null);
        }
      });

    void loadDetail();
    return () => {
      detailLoadSeqRef.current += 1;
      inventoryLoadSeqRef.current += 1;
      convergenceLoadSeqRef.current += 1;
    };
  }, [applyConvergenceRuntime, loadConvergenceState, loadDetail, pr.id]);

  // Poll actionRuns + activity + reviewThreads every 60s so CI data stays fresh.
  // PrsContext polls checks/status/reviews/comments, but action runs are only loaded
  // in PrDetailPane and would otherwise go stale after the initial fetch.
  React.useEffect(() => {
    const id = window.setInterval(() => {
      const reqId = detailLoadSeqRef.current;
      Promise.allSettled([
        window.ade.prs.getActionRuns(pr.id),
        window.ade.prs.getActivity(pr.id),
        window.ade.prs.getReviewThreads(pr.id),
      ]).then(([arResult, actResult, thrResult]) => {
        if (reqId !== detailLoadSeqRef.current) return;
        if (arResult.status === "fulfilled") setActionRuns(arResult.value);
        if (actResult.status === "fulfilled") setActivity(actResult.value);
        if (thrResult.status === "fulfilled") setReviewThreads(thrResult.value);
      });
    }, 60_000);
    return () => window.clearInterval(id);
  }, [pr.id]);

  React.useEffect(() => {
    if (!issueResolverCopyNotice) return;
    const timer = window.setTimeout(() => setIssueResolverCopyNotice(null), 2500);
    return () => window.clearTimeout(timer);
  }, [issueResolverCopyNotice]);

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
  const handleMerge = (method: MergeMethod) => {
    setActionResult(null);
    return runAction(async () => {
      const res = await window.ade.prs.land({ prId: pr.id, method });
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

  const laneForPr = React.useMemo(
    () => lanes.find((lane) => lane.id === pr.laneId && !lane.archivedAt) ?? null,
    [lanes, pr.laneId],
  );
  const matchingRebaseItemId = React.useMemo(() => {
    const need = findMatchingRebaseNeed({
      rebaseNeeds,
      laneId: pr.laneId,
      baseBranch: pr.baseBranch,
      prId: pr.id,
    });
    return need ? rebaseNeedItemKey(need) : null;
  }, [pr.baseBranch, pr.id, pr.laneId, rebaseNeeds]);
  const issueResolutionAvailability = React.useMemo(() => {
    const availability = getPrIssueResolutionAvailability(checks, reviewThreads);
    if (laneForPr) return availability;
    return {
      ...availability,
      hasActionableChecks: false,
      hasActionableComments: false,
      hasAnyActionableIssues: false,
    };
  }, [checks, laneForPr, reviewThreads]);

  const handleOpenIssueResolver = React.useCallback(() => {
    setIssueResolverError(null);
    setIssueResolverCopyNotice(null);
    setShowIssueResolverModal(true);
    void loadDetail();
    void onRefresh(); // Also refresh checks/status from PrsContext
  }, [loadDetail, onRefresh]);

  const handleLaunchIssueResolver = React.useCallback(async (
    args: { scope: "checks" | "comments" | "both"; additionalInstructions: string },
  ) => {
    setIssueResolverBusy(true);
    setIssueResolverError(null);
    try {
      const result = await window.ade.prs.issueResolutionStart({
        prId: pr.id,
        scope: args.scope,
        modelId: resolverModel,
        reasoning: resolverReasoningLevel || null,
        permissionMode: resolverPermissionMode,
        additionalInstructions: args.additionalInstructions,
      });
      setShowIssueResolverModal(false);
      setConvergenceSessionId(result.sessionId);
      setConvergenceSessionHref(result.href);
      saveConvergenceRuntime({
        autoConvergeEnabled: autoConverge,
        status: "running",
        pollerStatus: "idle",
        activeSessionId: result.sessionId,
        activeLaneId: pr.laneId,
        activeHref: result.href,
        pauseReason: null,
        errorMessage: null,
        lastStartedAt: new Date().toISOString(),
      });
      onNavigate(result.href);
    } catch (err: unknown) {
      setIssueResolverError(err instanceof Error ? err.message : String(err));
    } finally {
      setIssueResolverBusy(false);
    }
  }, [autoConverge, onNavigate, pr.id, pr.laneId, resolverModel, resolverPermissionMode, resolverReasoningLevel, saveConvergenceRuntime]);

  const handleCopyIssueResolverPrompt = React.useCallback(async (
    args: { scope: "checks" | "comments" | "both"; additionalInstructions: string },
  ) => {
    setIssueResolverCopyBusy(true);
    setIssueResolverError(null);
    setIssueResolverCopyNotice(null);
    try {
      const preview = await window.ade.prs.issueResolutionPreviewPrompt({
        prId: pr.id,
        scope: args.scope,
        modelId: resolverModel,
        reasoning: resolverReasoningLevel || null,
        permissionMode: resolverPermissionMode,
        additionalInstructions: args.additionalInstructions,
      });
      if (window.ade?.app?.writeClipboardText) {
        await window.ade.app.writeClipboardText(preview.prompt);
      } else if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(preview.prompt);
      } else {
        throw new Error("Clipboard access is not available in this environment.");
      }
      setIssueResolverCopyNotice("Prompt copied to clipboard.");
    } catch (err: unknown) {
      setIssueResolverError(err instanceof Error ? err.message : String(err));
    } finally {
      setIssueResolverCopyBusy(false);
    }
  }, [pr.id, resolverModel, resolverPermissionMode, resolverReasoningLevel]);

  // ---------------------------------------------------------------------------
  // Convergence panel: inventory sync & type mapping
  // ---------------------------------------------------------------------------

  const syncInventory = React.useCallback(async () => {
    const requestId = ++inventoryLoadSeqRef.current;
    try {
      const [snapshot, freshChecks] = await Promise.all([
        window.ade.prs.issueInventorySync(pr.id),
        window.ade.prs.getChecks(pr.id).catch(() => checks),
      ]);
      if (requestId !== inventoryLoadSeqRef.current) return null;
      setInventorySnapshot(snapshot);
      setConvergenceChecks(freshChecks);
      return snapshot;
    } catch {
      return null;
    }
  }, [checks, pr.id]);

  const refreshDetailSurface = React.useCallback(async (options: { includeInventory?: boolean } = {}) => {
    const tasks: Array<Promise<unknown>> = [onRefresh(), loadDetail()];
    if (options.includeInventory) {
      tasks.push(syncInventory());
    }
    await Promise.all(tasks);
  }, [loadDetail, onRefresh, syncInventory]);

  const handleRefresh = React.useCallback(async () => {
    try {
      await refreshDetailSurface({ includeInventory: activeTab === "convergence" });
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, [activeTab, refreshDetailSurface]);

  const mapInventoryItems = React.useCallback((snapshot: IssueInventorySnapshot | null): PanelIssueItem[] => {
    if (!snapshot) return [];
    return snapshot.items.map((item) => ({
      id: item.id,
      state: item.state === "sent_to_agent" ? "in_progress" : item.state,
      severity: item.severity ?? "minor",
      headline: item.headline,
      filePath: item.filePath,
      line: item.line,
      source: item.source === "unknown" ? "human" : item.source,
      dismissReason: item.dismissReason,
      agentSessionId: item.agentSessionId,
    })) as PanelIssueItem[];
  }, []);

  const mapConvergenceStatus = React.useCallback((snapshot: IssueInventorySnapshot | null): PanelConvergence => {
    if (!snapshot) return { state: "not_started", currentRound: 1, maxRounds: 5 };
    const c = snapshot.convergence;
    const displayRound = Math.max(1, c.currentRound);
    let state: PanelConvergence["state"] = "not_started";
    if (c.currentRound > 0) {
      if (c.totalNew === 0 && c.totalSentToAgent === 0) {
        state = "complete";
      } else if (c.isConverging) {
        state = "converging";
      } else {
        state = "stalled";
      }
    }
    return { state, currentRound: displayRound, maxRounds: c.maxRounds };
  }, []);

  // Sync inventory and load pipeline settings on convergence tab open
  React.useEffect(() => {
    if (activeTab === "convergence") {
      const runId = ++convergenceTabLoadSeqRef.current;
      const capturedPrId = pr.id;
      void loadConvergenceState(capturedPrId, { force: true }).then((runtime) => {
        if (runId !== convergenceTabLoadSeqRef.current) return; // stale
        applyConvergenceRuntime(runtime);
      }).catch(() => undefined);
      void syncInventory();
      void window.ade.prs.pipelineSettingsGet(capturedPrId).then((s) => {
        if (runId !== convergenceTabLoadSeqRef.current) return; // stale
        setPipelineSettings(s);
        pipelineSettingsRef.current = s;
      }).catch(() => undefined);
    }
  }, [activeTab, applyConvergenceRuntime, loadConvergenceState, syncInventory, pr.id]);

  // Auto-converge: hybrid polling (checks complete + comment stabilization)
  // After agent session completes, polls every 60s. Triggers next round when:
  //   1. All GitHub checks are done (no queued/in_progress), AND
  //   2. Comment/thread count hasn't changed for 2 consecutive polls (~2 min stability)
  const autoConvergePollerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const startAutoConvergePollerRef = React.useRef<() => void>(() => undefined);
  const lastCommentCountRef = React.useRef<number>(-1);
  const stableCountRef = React.useRef<number>(0);
  const autoConvergeAdditionalRef = React.useRef<string>("");
  const handleRunNextRoundRef = React.useRef<(instructions: string) => Promise<void>>();

  // Refs for mutable values read inside the poller tick so we never
  // capture stale closure values.
  const autoConvergeRef = React.useRef(autoConverge);
  autoConvergeRef.current = autoConverge;
  const convergenceSessionIdRef = React.useRef(convergenceSessionId);
  convergenceSessionIdRef.current = convergenceSessionId;
  const convergenceSessionHrefRef = React.useRef<string | null>(convergenceSessionHref);
  convergenceSessionHrefRef.current = convergenceSessionHref;

  const stopAutoConvergePoller = React.useCallback(() => {
    if (autoConvergePollerRef.current) {
      clearTimeout(autoConvergePollerRef.current);
      autoConvergePollerRef.current = null;
    }
    lastCommentCountRef.current = -1;
    stableCountRef.current = 0;
    behindCountRef.current = 0;
  }, []);

  const stopConvergenceSessionPoller = React.useCallback(() => {
    if (convergenceSessionPollerRef.current) {
      clearTimeout(convergenceSessionPollerRef.current);
      convergenceSessionPollerRef.current = null;
    }
  }, []);

  const getConvergencePublishBlocker = React.useCallback(async (sessionId: string): Promise<string | null> => {
    const sessionDetailPromise = typeof window.ade?.sessions?.get === "function"
      ? window.ade.sessions.get(sessionId).catch(() => null)
      : Promise.resolve(null);
    const syncStatusPromise = typeof window.ade?.git?.getSyncStatus === "function"
      ? window.ade.git.getSyncStatus({ laneId: pr.laneId }).catch(() => null)
      : Promise.resolve(null);
    const laneListPromise = typeof window.ade?.lanes?.list === "function"
      ? window.ade.lanes.list({ includeStatus: true }).catch(() => lanes)
      : Promise.resolve(lanes);
    const [sessionDetail, syncStatus, freshLanes] = await Promise.all([
      sessionDetailPromise,
      syncStatusPromise,
      laneListPromise,
    ]);
    const lane = freshLanes.find((entry) => entry.id === pr.laneId) ?? lanes.find((entry) => entry.id === pr.laneId) ?? null;
    const hasDirtyChanges = Boolean(lane?.status.dirty);
    const sessionHeadChanged = Boolean(sessionDetail?.headShaStart)
      && Boolean(sessionDetail?.headShaEnd)
      && sessionDetail?.headShaStart !== sessionDetail?.headShaEnd;
    const hasUnpublishedCommits = syncStatus
      ? syncStatus.ahead > 0
        || syncStatus.recommendedAction === "force_push_lease"
        || (
          !syncStatus.hasUpstream
          && sessionHeadChanged
        )
      : false;

    if (!hasDirtyChanges && !hasUnpublishedCommits) return null;

    const pendingStates: string[] = [];
    if (hasDirtyChanges) pendingStates.push("uncommitted changes");
    if (hasUnpublishedCommits) {
      pendingStates.push(
        syncStatus?.recommendedAction === "force_push_lease"
          ? "commits that still need a force push"
          : "commits that are not pushed to the PR branch",
      );
    }
    return `Agent session exited, but the lane still has ${pendingStates.join(" and ")}. Commit and push the lane before continuing.`;
  }, [lanes, pr.laneId]);

  const handleConvergenceSessionTerminal = React.useCallback(async (
    args: { sessionId: string; status: "completed" | "failed" | "cancelled" | "disposed"; message?: string | null },
  ) => {
    if (convergenceSessionIdRef.current !== args.sessionId) return;

    const now = new Date().toISOString();
    const activeHref = convergenceSessionHrefRef.current;
    const failureReason = (() => {
      const message = args.message?.trim();
      if (message) return message;
      if (args.status === "cancelled") return "Agent session was cancelled.";
      if (args.status === "disposed") return "Agent session stopped before completion.";
      if (args.status === "failed") return "Agent session failed before completion.";
      return null;
    })();

    setConvergenceBusy(false);
    setConvergenceSessionId(null);
    stopConvergenceSessionPoller();

    await refreshDetailSurface({ includeInventory: true }).catch(() => {});

    if (args.status === "completed") {
      const publishBlocker = await getConvergencePublishBlocker(args.sessionId).catch(() => null);
      if (publishBlocker) {
        if (autoConvergeRef.current) {
          stopAutoConvergePoller();
          setConvergencePauseReason(publishBlocker);
          setAutoConvergeWaitState({ phase: "paused", reason: publishBlocker });
          saveConvergenceRuntime({
            status: "paused",
            pollerStatus: "paused",
            activeSessionId: null,
            activeHref,
            pauseReason: publishBlocker,
            errorMessage: publishBlocker,
            lastPausedAt: now,
            lastStoppedAt: now,
          });
        } else {
          setActionError(publishBlocker);
          saveConvergenceRuntime({
            status: "failed",
            pollerStatus: "stopped",
            activeSessionId: null,
            activeHref,
            pauseReason: null,
            errorMessage: publishBlocker,
            lastStoppedAt: now,
          });
          setAutoConvergeWaitState({ phase: "idle" });
        }
        return;
      }

      if (autoConvergeRef.current) {
        saveConvergenceRuntime({
          status: "polling",
          pollerStatus: "waiting_for_checks",
          activeSessionId: null,
          activeHref,
          pauseReason: null,
          errorMessage: null,
          lastPolledAt: now,
        });
        setAutoConvergeWaitState({ phase: "waiting_checks", pendingCount: 0, totalCount: 0 });
        startAutoConvergePollerRef.current();
      } else {
        saveConvergenceRuntime({
          status: "idle",
          pollerStatus: "idle",
          activeSessionId: null,
          activeHref,
          pauseReason: null,
          errorMessage: null,
          lastStoppedAt: now,
        });
        setAutoConvergeWaitState({ phase: "idle" });
      }
      return;
    }

    if (autoConvergeRef.current) {
      const reason = failureReason ?? "Agent session ended unexpectedly.";
      stopAutoConvergePoller();
      setConvergencePauseReason(reason);
      setAutoConvergeWaitState({ phase: "paused", reason });
      saveConvergenceRuntime({
        status: "paused",
        pollerStatus: "paused",
        activeSessionId: null,
        activeHref,
        pauseReason: reason,
        errorMessage: reason,
        lastPausedAt: now,
        lastStoppedAt: now,
      });
      return;
    }

    saveConvergenceRuntime({
      status: args.status === "cancelled" ? "cancelled" : "failed",
      pollerStatus: "stopped",
      activeSessionId: null,
      activeHref,
      pauseReason: null,
      errorMessage: failureReason,
      lastStoppedAt: now,
    });
    setAutoConvergeWaitState({ phase: "idle" });
  }, [getConvergencePublishBlocker, refreshDetailSurface, saveConvergenceRuntime, stopAutoConvergePoller, stopConvergenceSessionPoller]);

  const startAutoConvergePoller = React.useCallback(() => {
    stopAutoConvergePoller();

    const scheduleTick = (delayMs = 60_000) => {
      autoConvergePollerRef.current = setTimeout(async () => {
        if (!autoConvergeRef.current) { stopAutoConvergePoller(); return; }
        try {
          // Poll checks and inventory
          const [freshChecks, snapshot] = await Promise.all([
            window.ade.prs.getChecks(pr.id),
            window.ade.prs.issueInventorySync(pr.id),
          ]);
          setInventorySnapshot(snapshot);
          setConvergenceChecks(freshChecks);

          // Skip rebase logic while an agent session is still active
          if (!convergenceSessionIdRef.current) {
            // Rebase detection: check if the PR is behind its base branch
            const freshStatus = await window.ade.prs.getStatus(pr.id);
            const isBehind = (freshStatus?.behindBaseBy ?? 0) > 0;

            if (isBehind) {
              const rebasePolicy = pipelineSettingsRef.current.onRebaseNeeded;
              if (rebasePolicy === "pause") {
                stopAutoConvergePoller();
                setConvergencePauseReason("PR is behind base branch. Rebase needed to continue.");
                setAutoConvergeWaitState({ phase: "paused", reason: "PR is behind base branch. Rebase needed to continue." });
                saveConvergenceRuntime({
                  status: "paused",
                  pollerStatus: "paused",
                  activeSessionId: null,
                  activeHref: convergenceSessionHref,
                  pauseReason: "PR is behind base branch. Rebase needed to continue.",
                  errorMessage: null,
                  lastPausedAt: new Date().toISOString(),
                });
                return;
              }
              // rebasePolicy === "auto_rebase"
              // The existing auto-rebase system should handle this. After rebase push,
              // checks go to in_progress and Gate 1 naturally blocks until they finish.
              // If the PR has been behind for 3+ consecutive polls (~3 min), rebase is stuck.
              behindCountRef.current++;
              if (behindCountRef.current >= 3) {
                stopAutoConvergePoller();
                setConvergencePauseReason("PR needs rebase but auto-rebase appears stuck. Resolve conflicts manually.");
                setAutoConvergeWaitState({ phase: "paused", reason: "PR needs rebase but auto-rebase appears stuck. Resolve conflicts manually." });
                saveConvergenceRuntime({
                  status: "paused",
                  pollerStatus: "paused",
                  activeSessionId: null,
                  activeHref: convergenceSessionHref,
                  pauseReason: "PR needs rebase but auto-rebase appears stuck. Resolve conflicts manually.",
                  errorMessage: null,
                  lastPausedAt: new Date().toISOString(),
                });
                return;
              }
              scheduleTick(); // Keep polling, give auto-rebase time to work
              return;
            }
            behindCountRef.current = 0; // Reset if not behind
          }

          // Check 1: Are all GitHub checks done?
          const checksStillRunning = freshChecks.some(
            (c: PrCheck) => c.status === "queued" || c.status === "in_progress",
          );
          if (checksStillRunning) {
            const pendingCount = freshChecks.filter((c: PrCheck) => c.status === "queued" || c.status === "in_progress").length;
            setAutoConvergeWaitState({ phase: "waiting_checks", pendingCount, totalCount: freshChecks.length });
            saveConvergenceRuntime({
              status: "polling",
              pollerStatus: "waiting_for_checks",
              currentRound: snapshot.convergence.currentRound,
              activeSessionId: null,
              activeHref: convergenceSessionHref,
              pauseReason: null,
              errorMessage: null,
              lastPolledAt: new Date().toISOString(),
            });
            lastCommentCountRef.current = -1;
            stableCountRef.current = 0;
            scheduleTick(); // Keep polling
            return;
          }

          // Check 2: Has the comment count stabilized?
          const currentCount = snapshot.items.filter((i) => i.state === "new").length;
          if (currentCount === lastCommentCountRef.current) {
            stableCountRef.current++;
          } else {
            stableCountRef.current = 0;
          }
          lastCommentCountRef.current = currentCount;

          // Trigger next round: checks done + 2 consecutive stable polls + has new items
          if (stableCountRef.current < 2) {
            setAutoConvergeWaitState({ phase: "waiting_comments", stablePollCount: stableCountRef.current });
            saveConvergenceRuntime({
              status: "polling",
              pollerStatus: "waiting_for_comments",
              currentRound: snapshot.convergence.currentRound,
              activeSessionId: null,
              activeHref: convergenceSessionHref,
              pauseReason: null,
              errorMessage: null,
              lastPolledAt: new Date().toISOString(),
            });
          }
          if (stableCountRef.current >= 2 && currentCount > 0) {
            stopAutoConvergePoller();
            setAutoConvergeWaitState({ phase: "ready" });
            const convergence = snapshot.convergence;
            if (convergence.currentRound >= convergence.maxRounds) {
              const reason = "Maximum auto-converge rounds reached.";
              setConvergencePauseReason(reason);
              setAutoConvergeWaitState({ phase: "paused", reason });
              saveConvergenceRuntime({
                status: "paused",
                pollerStatus: "paused",
                currentRound: snapshot.convergence.currentRound,
                activeSessionId: null,
                activeHref: convergenceSessionHrefRef.current,
                pauseReason: reason,
                errorMessage: null,
                lastPausedAt: new Date().toISOString(),
              });
              return;
            }
            // Launch next round
            void handleRunNextRoundRef.current?.(autoConvergeAdditionalRef.current);
          } else if (stableCountRef.current >= 2 && currentCount === 0) {
            // No new items after stabilization — convergence is done
            stopAutoConvergePoller();
            setAutoConvergeWaitState({ phase: "complete" });
            saveConvergenceRuntime({
              status: "converged",
              pollerStatus: "idle",
              currentRound: snapshot.convergence.currentRound,
              activeSessionId: null,
              activeHref: convergenceSessionHref,
              pauseReason: null,
              errorMessage: null,
              lastStoppedAt: new Date().toISOString(),
            });

            // Auto-merge if enabled
            const settings = pipelineSettingsRef.current;
            if (settings.autoMerge) {
              // Verify all checks are passing
              const allChecksPassed = freshChecks.every(
                (c: PrCheck) =>
                  c.conclusion === "success" ||
                  c.conclusion === "neutral" ||
                  c.conclusion === "skipped",
              );
              if (allChecksPassed) {
                try {
                  // Map pipeline merge method to MergeMethod for the land call
                  const method: MergeMethod =
                    settings.mergeMethod === "repo_default"
                      ? mergeMethodRef.current // fall back to the repo/component-level default
                      : settings.mergeMethod;
                  const res = await window.ade.prs.land({ prId: pr.id, method });
                  if (res.success) {
                    setAutoConvergeWaitState({ phase: "merged" });
                    setConvergenceMerged(true);
                    setAutoConverge(false);
                    saveConvergenceRuntime({
                      status: "merged",
                      pollerStatus: "idle",
                      activeSessionId: null,
                      activeHref: convergenceSessionHref,
                      pauseReason: null,
                      errorMessage: null,
                      lastStoppedAt: new Date().toISOString(),
                    });
                    await onRefreshRef.current();
                  } else {
                    setActionError(res.error ?? "Auto-merge failed");
                    setAutoConverge(false);
                    saveConvergenceRuntime({
                      status: "failed",
                      pollerStatus: "idle",
                      activeSessionId: null,
                      activeHref: convergenceSessionHref,
                      pauseReason: null,
                      errorMessage: res.error ?? "Auto-merge failed",
                      lastStoppedAt: new Date().toISOString(),
                    });
                  }
                } catch (err: unknown) {
                  setActionError(
                    err instanceof Error ? err.message : "Auto-merge failed",
                  );
                  setAutoConverge(false);
                  saveConvergenceRuntime({
                    status: "failed",
                    pollerStatus: "idle",
                    activeSessionId: null,
                    activeHref: convergenceSessionHref,
                    pauseReason: null,
                    errorMessage: err instanceof Error ? err.message : "Auto-merge failed",
                    lastStoppedAt: new Date().toISOString(),
                  });
                }
              } else {
                // Checks not passing — cannot auto-merge
                setActionError("Auto-merge skipped: some checks are not passing");
                setAutoConverge(false);
                saveConvergenceRuntime({
                  status: "failed",
                  pollerStatus: "idle",
                  activeSessionId: null,
                  activeHref: convergenceSessionHref,
                  pauseReason: null,
                  errorMessage: "Auto-merge skipped: some checks are not passing",
                  lastStoppedAt: new Date().toISOString(),
                });
              }
            } else {
              setAutoConverge(false);
            }
          } else {
            scheduleTick(); // Not yet stable, keep polling
          }
        } catch {
          // Poll failed, schedule retry
          scheduleTick();
        }
      }, delayMs); // Poll every delayMs (default 60 s)
    };

    scheduleTick(0);
  }, [convergenceSessionHref, pr.id, saveConvergenceRuntime, stopAutoConvergePoller]);
  startAutoConvergePollerRef.current = startAutoConvergePoller;

  // Listen for agent session completion to start polling
  React.useEffect(() => {
    if (!convergenceSessionId) return;
    const unsubscribe = window.ade.prs.onAiResolutionEvent((event) => {
      if (event.sessionId !== convergenceSessionId) return;
      if (event.status === "completed" || event.status === "failed" || event.status === "cancelled") {
        void handleConvergenceSessionTerminal({
          sessionId: event.sessionId,
          status: event.status,
          message: event.message,
        });
      }
    });
    return unsubscribe;
  }, [convergenceSessionId, handleConvergenceSessionTerminal]);

  React.useEffect(() => {
    stopConvergenceSessionPoller();
    if (!convergenceSessionId) return;

    let cancelled = false;
    const pollSessionState = async () => {
      try {
        const detail = await window.ade.sessions.get(convergenceSessionId);
        if (cancelled || convergenceSessionIdRef.current !== convergenceSessionId) return;
        if (!detail || detail.status === "running") {
          convergenceSessionPollerRef.current = window.setTimeout(() => {
            void pollSessionState();
          }, 2_000);
          return;
        }
        const terminalStatus: "completed" | "failed" | "disposed" =
          detail.status === "completed"
            ? "completed"
            : detail.status === "disposed"
              ? "disposed"
              : "failed";
        void handleConvergenceSessionTerminal({
          sessionId: convergenceSessionId,
          status: terminalStatus,
        });
      } catch {
        if (cancelled || convergenceSessionIdRef.current !== convergenceSessionId) return;
        convergenceSessionPollerRef.current = window.setTimeout(() => {
          void pollSessionState();
        }, 5_000);
      }
    };

    void pollSessionState();
    return () => {
      cancelled = true;
      stopConvergenceSessionPoller();
    };
  }, [convergenceSessionId, handleConvergenceSessionTerminal, stopConvergenceSessionPoller]);

  React.useEffect(() => {
    if (!autoConverge || convergenceSessionId) {
      if (!convergenceSessionId) stopAutoConvergePoller();
      return;
    }
    if (autoConvergeWaitState.phase === "waiting_checks" || autoConvergeWaitState.phase === "waiting_comments") {
      if (!autoConvergePollerRef.current) {
        startAutoConvergePoller();
      }
      return;
    }
    if (
      autoConvergeWaitState.phase === "idle"
      || autoConvergeWaitState.phase === "paused"
      || autoConvergeWaitState.phase === "complete"
      || autoConvergeWaitState.phase === "merged"
    ) {
      stopAutoConvergePoller();
    }
  }, [autoConverge, autoConvergeWaitState.phase, convergenceSessionId, startAutoConvergePoller, stopAutoConvergePoller]);

  // Cleanup poller on unmount
  React.useEffect(() => {
    return () => {
      if (autoConvergeTimerRef.current) clearTimeout(autoConvergeTimerRef.current);
      stopAutoConvergePoller();
      stopConvergenceSessionPoller();
    };
  }, [stopAutoConvergePoller, stopConvergenceSessionPoller]);

  const resolveIssueScope = React.useCallback((): "both" | "checks" | "comments" => {
    const a = issueResolutionAvailability;
    if (a.hasActionableChecks && a.hasActionableComments) return "both";
    if (a.hasActionableChecks) return "checks";
    return "comments";
  }, [issueResolutionAvailability]);

  const handleRunNextRound = React.useCallback(async (additionalInstructions: string) => {
    const launchingAutoConverge = autoConverge;
    setConvergenceBusy(true);
    setActionError(null);
    autoConvergeAdditionalRef.current = additionalInstructions;
    try {
      const snapshot = await syncInventory();
      if (!snapshot) throw new Error("Failed to sync inventory");
      const hasNew = snapshot.items.some((item) => item.state === "new");
      if (!hasNew) {
        if (launchingAutoConverge) {
          setAutoConvergeWaitState({ phase: "complete" });
          saveConvergenceRuntime({
            autoConvergeEnabled: true,
            status: "converged",
            pollerStatus: "idle",
            currentRound: snapshot.convergence.currentRound,
            activeSessionId: null,
            activeHref: convergenceSessionHrefRef.current,
            pauseReason: null,
            errorMessage: null,
            lastStoppedAt: new Date().toISOString(),
          });
        }
        setConvergenceBusy(false);
        return;
      }

      const result = await window.ade.prs.issueResolutionStart({
        prId: pr.id,
        scope: resolveIssueScope(),
        modelId: resolverModel,
        reasoning: resolverReasoningLevel || null,
        permissionMode: resolverPermissionMode,
        additionalInstructions,
      });

      const currentRound = snapshot.convergence.currentRound + 1;
      setConvergenceSessionId(result.sessionId);
      setConvergenceSessionHref(result.href);
      setAutoConvergeWaitState({ phase: "agent_running", sessionId: result.sessionId });
      setConvergencePauseReason(null);
      setConvergenceMerged(false);
      saveConvergenceRuntime({
        autoConvergeEnabled: launchingAutoConverge,
        status: "running",
        pollerStatus: "idle",
        currentRound,
        activeSessionId: result.sessionId,
        activeLaneId: pr.laneId,
        activeHref: result.href,
        pauseReason: null,
        errorMessage: null,
        lastStartedAt: new Date().toISOString(),
      });
      void syncInventory();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to launch agent";
      setActionError(message);
      setConvergenceBusy(false);
      if (launchingAutoConverge) {
        setConvergencePauseReason(message);
        setAutoConvergeWaitState({ phase: "paused", reason: message });
        saveConvergenceRuntime({
          autoConvergeEnabled: true,
          status: "paused",
          pollerStatus: "paused",
          activeSessionId: null,
          activeHref: convergenceSessionHrefRef.current,
          pauseReason: message,
          errorMessage: message,
          lastPausedAt: new Date().toISOString(),
        });
      }
    }
  }, [autoConverge, pr.id, pr.laneId, resolverModel, resolverPermissionMode, resolverReasoningLevel, resolveIssueScope, saveConvergenceRuntime, syncInventory]);

  // Keep ref in sync for the auto-converge poller
  handleRunNextRoundRef.current = handleRunNextRound;

  const handleConvergenceCopyPrompt = React.useCallback(async (additionalInstructions: string) => {
    try {
      const preview = await window.ade.prs.issueResolutionPreviewPrompt({
        prId: pr.id,
        scope: resolveIssueScope(),
        modelId: resolverModel,
        reasoning: resolverReasoningLevel || null,
        permissionMode: resolverPermissionMode,
        additionalInstructions,
      });
      if (window.ade?.app?.writeClipboardText) {
        await window.ade.app.writeClipboardText(preview.prompt);
      }
    } catch {
      // silently fail
    }
  }, [pr.id, resolverModel, resolverPermissionMode, resolverReasoningLevel, resolveIssueScope]);

  const handleAutoConvergeToggle = React.useCallback(async (enabled: boolean) => {
    setAutoConverge(enabled);
    if (!enabled) {
      stopAutoConvergePoller();
      const activeSessionId = convergenceSessionIdRef.current;
      if (activeSessionId) {
        // Try to stop the running session. Only clear the session handle on
        // confirmed success so the user retains the ability to retry if the
        // stop call fails.
        try {
          await window.ade.prs.aiResolutionStop({ sessionId: activeSessionId });
          // Stop succeeded -- clear session handle and mark stopped.
          setConvergenceBusy(false);
          setConvergenceSessionId(null);
          setConvergenceSessionHref(null);
          setAutoConvergeWaitState({ phase: "idle" });
          setConvergencePauseReason(null);
          saveConvergenceRuntime({
            autoConvergeEnabled: false,
            status: "stopped",
            pollerStatus: "stopped",
            activeSessionId: null,
            activeHref: null,
            pauseReason: null,
            errorMessage: null,
            lastStoppedAt: new Date().toISOString(),
          });
        } catch (err: unknown) {
          // Stop failed -- keep the session handle so the user can retry.
          setActionError(
            `Failed to stop session: ${err instanceof Error ? err.message : String(err)}`,
          );
          saveConvergenceRuntime({
            autoConvergeEnabled: false,
            status: "running",
            pollerStatus: "idle",
            activeSessionId,
            activeHref: convergenceSessionHrefRef.current,
            pauseReason: null,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        setAutoConvergeWaitState({ phase: "idle" });
        setConvergenceSessionHref(null);
        setConvergencePauseReason(null);
        saveConvergenceRuntime({
          autoConvergeEnabled: false,
          status: "stopped",
          pollerStatus: "stopped",
          activeSessionId: null,
          activeHref: null,
          pauseReason: null,
          errorMessage: null,
          lastStoppedAt: new Date().toISOString(),
        });
      }
      if (autoConvergeTimerRef.current) {
        clearTimeout(autoConvergeTimerRef.current);
        autoConvergeTimerRef.current = null;
      }
    } else {
      saveConvergenceRuntime({
        autoConvergeEnabled: true,
      });
    }
  }, [saveConvergenceRuntime, stopAutoConvergePoller]);

  const handleMarkDismissed = React.useCallback(async (itemIds: string[], reason: string) => {
    try {
      await window.ade.prs.issueInventoryMarkDismissed(pr.id, itemIds, reason);
      void syncInventory();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, [pr.id, syncInventory]);

  const handleMarkEscalated = React.useCallback(async (itemIds: string[]) => {
    try {
      await window.ade.prs.issueInventoryMarkEscalated(pr.id, itemIds);
      void syncInventory();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, [pr.id, syncInventory]);

  const handleResetInventory = React.useCallback(async () => {
    try {
      await window.ade.prs.issueInventoryReset(pr.id);
      await resetConvergenceState(pr.id);
      setInventorySnapshot(null);
      setConvergenceBusy(false);
      setAutoConverge(false);
      setConvergenceSessionId(null);
      setConvergenceSessionHref(null);
      setConvergenceMerged(false);
      setConvergencePauseReason(null);
      setAutoConvergeWaitState({ phase: "idle" });
      await refreshDetailSurface({ includeInventory: true });
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      if (autoConvergeTimerRef.current) {
        clearTimeout(autoConvergeTimerRef.current);
        autoConvergeTimerRef.current = null;
      }
      stopAutoConvergePoller();
    }
  }, [pr.id, refreshDetailSurface, resetConvergenceState, stopAutoConvergePoller]);

  const localBehindCount = laneForPr?.status?.behind ?? 0;

  const sc = getPrStateBadge(pr.state);
  const cc = getPrChecksBadge(pr.checksStatus);
  const rc = getPrReviewsBadge(pr.reviewStatus);
  const TAB_ACTIVE_COLORS: Record<DetailTab, string> = {
    overview: COLORS.accent,
    convergence: COLORS.accent,
    files: COLORS.info,
    checks: COLORS.success,
    activity: COLORS.warning,
  };

  const newIssueCount = inventorySnapshot?.items.filter(i => i.state === "new").length ?? 0;

  const DETAIL_TABS: Array<{ id: DetailTab; label: string; icon: React.ElementType; count?: number }> = [
    { id: "overview", label: "Overview", icon: Eye },
    { id: "convergence", label: "Path to Merge", icon: Sparkle, count: newIssueCount > 0 ? newIssueCount : undefined },
    { id: "files", label: "Files", icon: Code, count: files.length },
    { id: "checks", label: "CI / Checks", icon: Play, count: buildUnifiedChecks(checks, actionRuns).length },
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
                  borderRadius: "8px 8px 0 0",
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
            <button type="button" onClick={() => void handleRefresh()} style={outlineButton({ height: 30, padding: "0 8px" })} title="Refresh">
              <ArrowsClockwise size={14} weight="bold" />
            </button>
            {queueContext && onOpenQueueView ? (
              <button
                type="button"
                onClick={() => onOpenQueueView(queueContext.groupId)}
                style={outlineButton({ height: 30, padding: "0 10px", color: COLORS.accent, borderColor: `${COLORS.accent}40` })}
                title={queueContext.label ?? "Open queue"}
              >
                <Layers size={14} /> Queue
              </button>
            ) : null}
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
            pr={pr} detail={detail} status={status} checks={checks} actionRuns={actionRuns} reviews={reviews} comments={comments}
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
            matchingRebaseItemId={matchingRebaseItemId}
            localBehindCount={localBehindCount}
            activity={activity}
            lanes={lanes}
          />
        )}
        {activeTab === "convergence" && (
          <PrConvergencePanel
            prNumber={pr.githubPrNumber}
            prTitle={pr.title}
            headBranch={pr.headBranch}
            baseBranch={pr.baseBranch}
            items={mapInventoryItems(inventorySnapshot)}
            convergence={mapConvergenceStatus(inventorySnapshot)}
            checks={convergenceChecks}
            modelId={resolverModel}
            reasoningEffort={resolverReasoningLevel}
            permissionMode={resolverPermissionMode}
            busy={convergenceBusy}
            autoConverge={autoConverge}
            pipelineSettings={pipelineSettings}
            waitState={autoConvergeWaitState}
            onPipelineSettingsChange={(partial) => {
              const prev = pipelineSettings;
              const next = { ...pipelineSettings, ...partial };
              setPipelineSettings(next);
              pipelineSettingsRef.current = next;
              window.ade.prs.pipelineSettingsSave(pr.id, partial).catch((err: unknown) => {
                setPipelineSettings(prev);
                pipelineSettingsRef.current = prev;
                setActionError(err instanceof Error ? err.message : String(err));
              });
            }}
            onModelChange={setResolverModel}
            onReasoningEffortChange={setResolverReasoningLevel}
            onPermissionModeChange={setResolverPermissionMode}
            onRunNextRound={handleRunNextRound}
            onAutoConvergeChange={handleAutoConvergeToggle}
            onCopyPrompt={handleConvergenceCopyPrompt}
            onMarkDismissed={handleMarkDismissed}
            onMarkEscalated={handleMarkEscalated}
            onResetInventory={handleResetInventory}
            onViewAgentSession={(sessionId) => {
              const href = convergenceSessionHref
                ?? (sessionId.startsWith("http://") || sessionId.startsWith("https://") || sessionId.startsWith("/")
                  ? sessionId
                  : (pr.laneId ? buildSessionHref(pr.laneId, sessionId) : null));
              if (href && onNavigate) {
                onNavigate(href);
              }
            }}
            onStopAutoConverge={() => handleAutoConvergeToggle(false)}
            onResumePause={() => {
              setConvergencePauseReason(null);
              setAutoConvergeWaitState({ phase: "idle" });
              behindCountRef.current = 0;
              saveConvergenceRuntime({
                status: "polling",
                pollerStatus: "scheduled",
                pauseReason: null,
              });
              startAutoConvergePoller();
            }}
            onDismissPause={() => {
              setConvergencePauseReason(null);
              setAutoConvergeWaitState({ phase: "idle" });
              behindCountRef.current = 0;
              setAutoConverge(false);
              saveConvergenceRuntime({
                autoConvergeEnabled: false,
                status: "stopped",
                pollerStatus: "stopped",
                pauseReason: null,
                errorMessage: null,
              });
            }}
            onDismissMerged={() => {
              setConvergenceMerged(false);
              setAutoConvergeWaitState({ phase: "idle" });
              saveConvergenceRuntime({
                status: "idle",
                pollerStatus: "idle",
                pauseReason: null,
                errorMessage: null,
              });
            }}
          />
        )}
        {activeTab === "files" && (
          <FilesTab files={files} expandedFile={expandedFile} setExpandedFile={setExpandedFile} />
        )}
        {activeTab === "checks" && (
          <ChecksTab
            checks={checks} actionRuns={actionRuns}
            actionBusy={actionBusy}
            onRerunChecks={handleRerunChecks}
            showIssueResolverAction={issueResolutionAvailability.hasAnyActionableIssues}
            onOpenIssueResolver={handleOpenIssueResolver}
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

      <PrIssueResolverModal
        open={showIssueResolverModal}
        prNumber={pr.githubPrNumber}
        prTitle={pr.title}
        availability={issueResolutionAvailability}
        checks={checks}
        reviewThreads={reviewThreads}
        modelId={resolverModel}
        reasoningEffort={resolverReasoningLevel}
        permissionMode={resolverPermissionMode}
        busy={issueResolverBusy}
        copyBusy={issueResolverCopyBusy}
        copyNotice={issueResolverCopyNotice}
        error={issueResolverError}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setIssueResolverError(null);
            setIssueResolverCopyNotice(null);
          }
          setShowIssueResolverModal(nextOpen);
        }}
        onModelChange={setResolverModel}
        onReasoningEffortChange={setResolverReasoningLevel}
        onPermissionModeChange={setResolverPermissionMode}
        onLaunch={handleLaunchIssueResolver}
        onCopyPrompt={handleCopyIssueResolverPrompt}
      />
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
function MergeStatusRow({ color, icon, title, titleAccessory, description, children, expandable, expanded, onToggle }: {
  color: string;
  icon: React.ReactNode;
  title: string;
  titleAccessory?: React.ReactNode;
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
          {titleAccessory}
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
  actionRuns: PrActionRun[];
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
  onMerge: (method: MergeMethod) => void;
  onAddComment: () => void;
  onUpdateBody: () => void;
  onSetLabels: (labels: string[]) => void;
  onRequestReviewers: (reviewers: string[]) => void;
  onSubmitReview: () => void;
  onClose: () => void;
  onReopen: () => void;
  onAiSummary: () => void;
  onNavigate: (path: string) => void;
  onOpenRebaseTab?: (laneId?: string) => void;
  matchingRebaseItemId: string | null;
  localBehindCount: number;
  activity: PrActivityEvent[];
  lanes: LaneSummary[];
};

function OverviewTab(props: OverviewTabProps) {
  const { pr, detail, status, checks, actionRuns, reviews, comments, aiSummary, aiSummaryBusy, actionBusy, mergeMethod, activity, lanes } = props;
  const [checksExpanded, setChecksExpanded] = React.useState(false);
  const [localMergeMethod, setLocalMergeMethod] = React.useState<MergeMethod>(mergeMethod);
  const [allowBlockedMerge, setAllowBlockedMerge] = React.useState(false);
  const laneForPr = React.useMemo(
    () => lanes.find((lane) => lane.id === pr.laneId && !lane.archivedAt) ?? null,
    [lanes, pr.laneId],
  );

  React.useEffect(() => {
    setLocalMergeMethod(mergeMethod);
  }, [mergeMethod]);

  // Reset bypass opt-in when the selected PR changes
  React.useEffect(() => {
    setAllowBlockedMerge(false);
  }, [pr.id]);

  // Sort comments chronologically (oldest first, like GitHub)
  const sortedComments = React.useMemo(
    () => [...comments].sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return ta - tb;
    }),
    [comments],
  );

  // Unified checks: merge check-runs API data with action-runs API data so that
  // merge readiness, stats sidebar, and convergence panel all reflect the same reality.
  const allChecks: PrCheck[] = React.useMemo(() => {
    const unified = buildUnifiedChecks(checks, actionRuns);
    return unified.map((c): PrCheck => ({
      name: c.displayName,
      status: (c.status === "queued" || c.status === "in_progress" || c.status === "completed") ? c.status : "completed",
      conclusion: (c.conclusion === "success" || c.conclusion === "failure" || c.conclusion === "neutral" || c.conclusion === "skipped" || c.conclusion === "cancelled") ? c.conclusion : null,
      detailsUrl: c.detailsUrl,
      startedAt: null,
      completedAt: null,
    }));
  }, [checks, actionRuns]);

  // Checks summary — uses unified checks (check-runs + action-runs)
  const checksSummary = summarizeChecks(allChecks);
  const { someChecksFailing, checksRunning } = checksSummary;
  const checksRowVisuals = getChecksRowVisuals(checksSummary);

  // Review status from pr
  const reviewStatus = pr.reviewStatus;

  // Merge readiness
  const canMerge = Boolean(status?.isMergeable) && !status?.mergeConflicts && pr.state === "open";
  const canAttemptBlockedMerge = Boolean(status) && !status?.isMergeable && !status?.mergeConflicts && pr.state === "open";
  const isBypassMerge = allowBlockedMerge && canAttemptBlockedMerge;
  const mergeActionEnabled = canMerge || isBypassMerge;
  const mergeActionLabel = actionBusy
    ? (isBypassMerge ? "Attempting merge..." : "Merging...")
    : (isBypassMerge ? "Attempt merge anyway" : "Merge pull request");
  // Derive merge button styling from the merge/bypass state in one place:
  const mergeAccentColor = canMerge ? COLORS.success : isBypassMerge ? COLORS.warning : null;
  const mergeActionBackground = mergeAccentColor
    ? `linear-gradient(135deg, ${mergeAccentColor} 0%, ${canMerge ? "#16a34a" : "#d97706"} 100%)`
    : COLORS.recessedBg;
  const mergeActionBorderColor = mergeAccentColor ?? COLORS.border;
  const mergeActionShadow = mergeAccentColor
    ? `0 2px 16px ${mergeAccentColor}${canMerge ? "40" : "35"}, 0 0 0 1px ${mergeAccentColor}${canMerge ? "30" : "25"}`
    : "none";

  React.useEffect(() => {
    if (!canAttemptBlockedMerge) {
      setAllowBlockedMerge(false);
    }
  }, [canAttemptBlockedMerge]);

  return (
    <div style={{ display: "flex", gap: 0, height: "100%" }}>
      {/* Main content */}
      <div style={{ flex: 1, minWidth: 0, overflow: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>

        {/* ---- Lane cleanup banner (shown when PR is merged/closed and lane still exists) ---- */}
        <PrLaneCleanupBanner pr={pr} lane={laneForPr} actionBusy={actionBusy} onNavigate={props.onNavigate} />

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

        {(() => {
          const targetDiffMessage = describePrTargetDiff({
            lane: laneForPr,
            lanes,
            targetBranch: pr.baseBranch,
          });
          if (!targetDiffMessage || pr.state !== "open") return null;
          return (
            <div style={{
              ...cardStyle({ padding: 0, overflow: "hidden" }),
              flexShrink: 0,
              borderColor: `${COLORS.info}30`,
              background: `linear-gradient(135deg, ${COLORS.info}08 0%, transparent 60%)`,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px" }}>
                <Warning size={18} weight="fill" style={{ color: COLORS.info, flexShrink: 0, filter: `drop-shadow(0 0 4px ${COLORS.info}40)` }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>
                    PR target differs from lane base
                  </span>
                  <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted, marginLeft: 8 }}>
                    {targetDiffMessage}
                  </span>
                </div>
                {props.onOpenRebaseTab && props.matchingRebaseItemId && (
                  <button
                    type="button"
                    onClick={() => props.onOpenRebaseTab?.(props.matchingRebaseItemId ?? undefined)}
                    style={outlineButton({
                      height: 30, padding: "0 14px",
                      color: COLORS.info,
                      borderColor: `${COLORS.info}40`,
                    })}
                  >
                    <ArrowsClockwise size={13} weight="bold" /> View Rebase Details
                  </button>
                )}
              </div>
            </div>
          );
        })()}

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
                {props.onOpenRebaseTab && props.matchingRebaseItemId && (
                  <button
                    type="button"
                    onClick={() => props.onOpenRebaseTab?.(props.matchingRebaseItemId ?? undefined)}
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

            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
                {timeline.map((ev) => {
                  const col = activityEventColor(ev);
                  const isComment = ev.type === "comment";
                  const supportsRichBody = isComment || ev.type === "review";
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
                            <ActivityEventIcon event={ev} />
                          </div>
                        )}
                        <span style={{ fontFamily: SANS_FONT, fontSize: isComment ? 13 : 12, fontWeight: 600, color: COLORS.textPrimary }}>{ev.author}</span>
                        {authorIsBot && (
                          <span style={{ fontFamily: SANS_FONT, fontSize: 9, fontWeight: 700, color: COLORS.textMuted, background: `${COLORS.textMuted}18`, padding: "1px 5px", borderRadius: 4, textTransform: "uppercase", letterSpacing: "0.5px" }}>bot</span>
                        )}
                        <span style={inlineBadge(col, { padding: "1px 8px", fontSize: 10 })}>
                          {activityEventLabel(ev)}
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
                        <span style={{ marginLeft: "auto", fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted, flexShrink: 0 }}>{formatTimeAgo(ev.timestamp)}</span>
                        {isComment && typeof ev.metadata?.url === "string" && (
                          <CommentMenu url={String(ev.metadata.url)} />
                        )}
                      </div>
                      {supportsRichBody && ev.body ? (
                        <div style={{ paddingLeft: 32 }}>
                          <MarkdownBody markdown={ev.body} />
                        </div>
                      ) : ev.body ? (
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
            color={checksRowVisuals.color}
            icon={getChecksRowIcon(checksSummary)}
            title={checksRowVisuals.title}
            titleAccessory={checksRunning && checksSummary.total > 0 ? <PrCiRunningIndicator showLabel label="running" /> : undefined}
            description={checksRowVisuals.description}
            expandable={allChecks.length > 0}
            expanded={checksExpanded}
            onToggle={() => setChecksExpanded(!checksExpanded)}
          >
            <div style={{ padding: "4px 0" }}>
              {allChecks.map((check, idx) => {
                const checkColor = check.conclusion === "success" ? COLORS.success : check.conclusion === "failure" ? COLORS.danger : check.status === "in_progress" ? COLORS.warning : check.conclusion === "skipped" || check.conclusion === "neutral" ? COLORS.textDim : COLORS.textMuted;
                return (
                  <div key={`${check.name}-${idx}`} style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "8px 16px",
                    borderBottom: idx < allChecks.length - 1 ? `1px solid ${COLORS.borderMuted}` : "none",
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
                  : status && !status.isMergeable ? "Required conditions have not been met. If GitHub offers bypass rules for your account, you can still attempt the merge below."
                    : "Waiting for merge status check"
            }
          />

          {/* Merge action area */}
          {(pr.state === "open" || pr.state === "draft") && (
            <div
              style={{
                padding: "16px",
                borderTop: `1px solid ${COLORS.border}`,
                background: canMerge ? `${COLORS.success}06` : isBypassMerge ? `${COLORS.warning}06` : "transparent",
              }}
            >
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

              {canAttemptBlockedMerge && (
                <label
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    marginBottom: 14,
                    padding: 12,
                    borderRadius: 10,
                    border: `1px solid ${COLORS.warning}24`,
                    background: `${COLORS.warning}08`,
                    cursor: actionBusy ? "default" : "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={allowBlockedMerge}
                    disabled={actionBusy}
                    onChange={(event) => setAllowBlockedMerge(event.target.checked)}
                    style={{ marginTop: 2, accentColor: COLORS.warning }}
                  />
                  <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontFamily: SANS_FONT, fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }}>
                      Attempt merge anyway if GitHub allows bypass rules
                    </span>
                    <span style={{ fontFamily: SANS_FONT, fontSize: 11, lineHeight: 1.55, color: COLORS.textMuted }}>
                      ADE will still ask GitHub to merge this PR. If your account is allowed to bypass the current requirements, the merge can succeed even while this panel still shows the PR as blocked.
                    </span>
                  </span>
                </label>
              )}

              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button
                  type="button"
                  disabled={actionBusy || !mergeActionEnabled}
                  onClick={() => void props.onMerge(localMergeMethod)}
                  style={{
                    ...primaryButton({
                      background: mergeActionBackground,
                      borderColor: mergeActionBorderColor,
                      opacity: actionBusy || !mergeActionEnabled ? 0.5 : 1,
                      height: 40,
                      padding: "0 24px",
                      fontSize: 14,
                      fontWeight: 700,
                      boxShadow: mergeActionEnabled && !actionBusy ? mergeActionShadow : "none",
                    }),
                    color: mergeActionEnabled ? "#fff" : COLORS.textMuted,
                    flex: 1,
                  }}
                >
                  <GitMerge size={16} weight="bold" />
                  {mergeActionLabel}
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
        {/* Quick actions */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingBottom: 14, marginBottom: 2, borderBottom: `1px solid ${COLORS.border}` }}>
          <button type="button" onClick={props.onAiSummary} disabled={aiSummaryBusy} style={outlineButton({ height: 30, padding: "0 10px", color: COLORS.accent, borderColor: `${COLORS.accent}40`, width: "100%", justifyContent: "center" })}>
            <Sparkle size={13} weight="fill" />
            {aiSummaryBusy ? "Analyzing..." : "AI Review"}
          </button>
          <button type="button" onClick={() => props.setShowReviewModal(true)} style={outlineButton({ height: 30, padding: "0 10px", width: "100%", justifyContent: "center" })}>
            <Check size={13} weight="bold" /> Submit Review
          </button>
        </div>
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
            <StatRow label="Created" value={formatTimestampFull(pr.createdAt)} />
            <StatRow label="Updated" value={formatTimestampFull(pr.updatedAt)} />
            <StatRow label="Checks" value={`${allChecks.filter(c => c.conclusion === "success" || c.conclusion === "neutral" || c.conclusion === "skipped").length}/${allChecks.length} passing`} />
            <StatRow label="Reviews" value={`${reviews.filter(r => r.state === "approved").length} approved`} />
            <StatRow label="Additions" value={`+${pr.additions}`} />
            <StatRow label="Deletions" value={`-${pr.deletions}`} />
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

type UnifiedCheckItem = {
  id: string;
  name: string;
  displayName: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "skipped" | "cancelled" | null;
  duration: number | null; // seconds
  detailsUrl: string | null;
  source: "actions_job" | "check";
  // Actions job details
  steps?: Array<{ number: number; name: string; status: string; conclusion: string | null }>;
  workflowName?: string;
};

function buildUnifiedChecks(checks: PrCheck[], actionRuns: PrActionRun[]): UnifiedCheckItem[] {
  const items: UnifiedCheckItem[] = [];
  const coveredNames = new Set<string>();

  // Collapse reruns: for each workflow name, keep only the newest run
  // (multiple runs with the same name are reruns of the same workflow)
  const latestRunByWorkflow = new Map<string, PrActionRun>();
  for (const run of actionRuns) {
    const existing = latestRunByWorkflow.get(run.name);
    if (!existing || new Date(run.createdAt).getTime() > new Date(existing.createdAt).getTime()) {
      latestRunByWorkflow.set(run.name, run);
    }
  }
  const dedupedRuns = Array.from(latestRunByWorkflow.values());

  // First: add all jobs from the latest action runs (these have the most detail)
  for (const run of dedupedRuns) {
    for (const job of run.jobs) {
      // Build the canonical name to match against checks API
      const canonicalName = `${run.name} / ${job.name}`;
      coveredNames.add(canonicalName.toLowerCase());
      // Use composite key to avoid collisions across workflows (e.g. two workflows both having a "build" job)
      coveredNames.add(`${run.name}/${job.name}`.toLowerCase());

      const duration = job.startedAt && job.completedAt
        ? Math.round((new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime()) / 1000)
        : null;

      items.push({
        id: `job-${job.id}`,
        name: canonicalName,
        displayName: canonicalName,
        status: job.status,
        conclusion: job.conclusion,
        duration,
        detailsUrl: run.htmlUrl,
        source: "actions_job",
        steps: job.steps,
        workflowName: run.name,
      });
    }
  }

  // Second: add checks that aren't covered by action run jobs (third-party checks)
  for (const check of checks) {
    const lowerName = check.name.toLowerCase();
    // Skip if this check is already covered by an action run job
    if (coveredNames.has(lowerName)) continue;
    // Also check if the check name matches "{workflow} / {job}" pattern
    const slashIdx = check.name.indexOf("/");
    if (slashIdx > 0) {
      const workflowPart = check.name.slice(0, slashIdx).trim().toLowerCase();
      const jobPart = check.name.slice(slashIdx + 1).trim().toLowerCase();
      // Use composite key to match against workflow/job keys stored above
      if (coveredNames.has(`${workflowPart}/${jobPart}`)) continue;
    }

    const duration = check.startedAt && check.completedAt
      ? Math.round((new Date(check.completedAt).getTime() - new Date(check.startedAt).getTime()) / 1000)
      : null;

    items.push({
      id: `check-${check.name}`,
      name: check.name,
      displayName: check.name,
      status: check.status,
      conclusion: check.conclusion,
      duration,
      detailsUrl: check.detailsUrl,
      source: "check",
    });
  }

  // Sort: failures first, then in-progress, then by name
  items.sort((a, b) => {
    const aPriority = a.conclusion === "failure" ? 0 : a.status !== "completed" ? 1 : 2;
    const bPriority = b.conclusion === "failure" ? 0 : b.status !== "completed" ? 1 : 2;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return a.name.localeCompare(b.name);
  });

  return items;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function ChecksTab({ checks, actionRuns, actionBusy, onRerunChecks, showIssueResolverAction, onOpenIssueResolver }: {
  checks: PrCheck[];
  actionRuns: PrActionRun[];
  actionBusy: boolean;
  onRerunChecks: () => void;
  showIssueResolverAction: boolean;
  onOpenIssueResolver: () => void;
}) {
  const [expandedItems, setExpandedItems] = React.useState<Set<string>>(new Set());

  const unifiedChecks = React.useMemo(() => buildUnifiedChecks(checks, actionRuns), [checks, actionRuns]);

  const passing = unifiedChecks.filter(c => c.conclusion === "success").length;
  const failing = unifiedChecks.filter(c => c.conclusion === "failure").length;
  const pending = unifiedChecks.filter(c => c.status !== "completed").length;
  const skipped = unifiedChecks.filter(c => c.status === "completed" && (c.conclusion === "neutral" || c.conclusion === "skipped" || c.conclusion === "cancelled")).length;
  const total = unifiedChecks.length;

  const toggleExpand = (id: string) => {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const summaryText = total === 0
    ? "No checks"
    : failing > 0
      ? `${failing} failing, ${passing} passing${pending > 0 ? `, ${pending} pending` : ""}${skipped > 0 ? `, ${skipped} skipped` : ""}`
      : pending > 0
        ? `${passing} passing, ${pending} pending${skipped > 0 ? `, ${skipped} skipped` : ""}`
        : skipped > 0 && passing === 0
          ? `All ${total} checks skipped`
          : skipped > 0
            ? `${passing} passing, ${skipped} skipped`
            : `All ${total} checks passing`;

  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Summary bar */}
      <div style={cardStyle({ padding: 0, overflow: "hidden" })}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px" }}>
          <span style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>
            {summaryText}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {showIssueResolverAction && (
              <button type="button" onClick={onOpenIssueResolver} style={outlineButton({ height: 30, padding: "0 10px", color: COLORS.accent, borderColor: `${COLORS.accent}40` })}>
                <Sparkle size={14} weight="fill" /> Resolve issues with agent
              </button>
            )}
            <button type="button" disabled={actionBusy} onClick={onRerunChecks} style={outlineButton({ height: 30, color: COLORS.warning, borderColor: `${COLORS.warning}40` })}>
              <ArrowsClockwise size={14} /> Re-run Failed
            </button>
          </div>
        </div>
        {total > 0 && (
          <div style={{ display: "flex", height: 4 }}>
            {passing > 0 && <div style={{ flex: passing, background: "#22C55E", transition: "flex 300ms ease" }} />}
            {failing > 0 && <div style={{ flex: failing, background: "#EF4444", transition: "flex 300ms ease" }} />}
            {pending > 0 && <div style={{ flex: pending, background: "#F59E0B", transition: "flex 300ms ease" }} />}
            {skipped > 0 && <div style={{ flex: skipped, background: "#6B7280", transition: "flex 300ms ease" }} />}
          </div>
        )}
      </div>

      {/* Unified check list */}
      {total === 0 ? (
        <div style={cardStyle()}>
          <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textDim }}>No checks found</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {unifiedChecks.map((item) => {
            const isExpanded = expandedItems.has(item.id);
            const hasSteps = item.source === "actions_job" && item.steps && item.steps.length > 0;
            const stateColor = item.conclusion === "success" ? COLORS.success
              : item.conclusion === "failure" ? COLORS.danger
              : item.status === "in_progress" ? COLORS.warning
              : item.status === "queued" ? COLORS.textMuted
              : COLORS.textMuted;

            const conclusionLabel = item.conclusion === "failure" ? "FAILED"
              : item.conclusion === "success" ? "PASSED"
              : item.conclusion === "neutral" ? "NEUTRAL"
              : item.conclusion === "skipped" ? "SKIPPED"
              : item.conclusion === "cancelled" ? "CANCELLED"
              : item.status === "in_progress" ? "RUNNING"
              : item.status === "queued" ? "QUEUED"
              : "PENDING";

            return (
              <div key={item.id} style={cardStyle({ padding: 0, overflow: "hidden" })}>
                <div
                  role={hasSteps ? "button" : undefined}
                  tabIndex={hasSteps ? 0 : undefined}
                  onClick={hasSteps ? () => toggleExpand(item.id) : undefined}
                  onKeyDown={hasSteps ? (e) => { if (e.key === "Enter") toggleExpand(item.id); } : undefined}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "10px 16px",
                    background: item.conclusion === "failure" ? `${COLORS.danger}06` : "transparent",
                    cursor: hasSteps ? "pointer" : "default",
                    transition: "background 100ms ease",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
                    {hasSteps && (
                      isExpanded
                        ? <CaretDown size={11} style={{ color: stateColor, flexShrink: 0 }} />
                        : <CaretRight size={11} style={{ color: COLORS.textMuted, flexShrink: 0 }} />
                    )}
                    {item.conclusion === "success" ? <CheckCircle size={15} weight="fill" style={{ color: COLORS.success, flexShrink: 0 }} /> :
                     item.conclusion === "failure" ? <XCircle size={15} weight="fill" style={{ color: COLORS.danger, flexShrink: 0 }} /> :
                     item.status === "in_progress" ? <CircleNotch size={15} className="animate-spin" style={{ color: COLORS.warning, flexShrink: 0 }} /> :
                     <Circle size={15} style={{ color: COLORS.textMuted, flexShrink: 0 }} />}
                    <span style={{ fontFamily: SANS_FONT, fontSize: 12, fontWeight: 500, color: COLORS.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {item.displayName}
                    </span>
                    {item.source === "check" && (
                      <span style={{ fontFamily: MONO_FONT, fontSize: 9, color: COLORS.textDim, flexShrink: 0, padding: "1px 5px", border: `1px solid ${COLORS.border}` }}>
                        3RD PARTY
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                    {item.duration != null && (
                      <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted }}>
                        {formatDuration(item.duration)}
                      </span>
                    )}
                    <span style={{
                      fontFamily: MONO_FONT, fontSize: 9, fontWeight: 600, textTransform: "uppercase",
                      color: stateColor, padding: "2px 8px",
                      background: `${stateColor}14`, border: `1px solid ${stateColor}30`,
                    }}>
                      {conclusionLabel}
                    </span>
                    {item.detailsUrl && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); void window.ade.app.openExternal(item.detailsUrl!); }}
                        style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10, gap: 4 })}
                      >
                        <GithubLogo size={11} /> View
                      </button>
                    )}
                  </div>
                </div>

                {/* Expanded steps for GitHub Actions jobs */}
                {isExpanded && hasSteps && (
                  <div style={{ borderTop: `1px solid ${COLORS.border}`, background: "rgba(0,0,0,0.08)", padding: "8px 16px 8px 52px" }}>
                    {item.steps!.map((step) => {
                      return (
                        <div key={step.number} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                          {step.conclusion === "success" ? <CheckCircle size={12} weight="fill" style={{ color: COLORS.success }} /> :
                           step.conclusion === "failure" ? <XCircle size={12} weight="fill" style={{ color: COLORS.danger }} /> :
                           step.conclusion === "skipped" ? <Circle size={12} style={{ color: COLORS.textDim }} /> :
                           <CircleNotch size={12} className="animate-spin" style={{ color: COLORS.warning }} />}
                          <span style={{
                            fontFamily: SANS_FONT, fontSize: 11,
                            color: step.conclusion === "failure" ? COLORS.danger
                              : step.conclusion === "success" ? COLORS.textSecondary
                              : COLORS.textMuted,
                          }}>{step.name}</span>
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
    for (let ri = 0; ri < reviews.length; ri++) {
      const r = reviews[ri];
      events.push({
        id: `review-${r.reviewer}-${r.submittedAt}-${ri}`, type: "review", author: r.reviewer, avatarUrl: r.reviewerAvatarUrl || null,
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
              const evColor = activityEventColor(event);
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
                    <ActivityEventIcon event={event} withGlow />
                  </div>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <span style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>{event.author}</span>
                      <span style={inlineBadge(evColor)}>
                        {activityEventLabel(event)}
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
                      <span style={{ marginLeft: "auto", fontFamily: MONO_FONT, fontSize: 10, color: "#8B7355" }}>{formatTimeAgo(event.timestamp)}</span>
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

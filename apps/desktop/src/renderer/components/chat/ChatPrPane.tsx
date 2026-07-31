import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  ArrowsClockwise,
  ArrowSquareOut,
  CheckCircle,
  Clock,
  Copy,
  Check,
  GithubLogo,
  GitPullRequest,
  Lightning,
  Sparkle,
  X,
  XCircle,
} from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import type { PrCheck, PrReview, PrState, PrStatus, PrSummary } from "../../../shared/types";
import { formatPrBadgeLabel } from "../prs/shared/prFormatters";
import { PrUserAvatar } from "../prs/shared/PrUserAvatar";
import { ChatPrInlineCreator } from "./ChatPrInlineCreator";
import { refreshLinkedPrCoalesced } from "../../lib/prReadCache";
import { useAppStore } from "../../state/appStore";
import { pipelineStateOf } from "../../../shared/prPipelineState";
import { GitHubStackBadge } from "../prs/shared/GitHubStackBadge";

/**
 * Left floating info-pane for an ADE chat's pull request. Mirrors the right
 * Chat-actions pane: when a PR exists we show its live, webhook-driven status +
 * quick actions; when none exists we embed a compact inline PR creator
 * (ChatPrInlineCreator) so the user never leaves the Work tab.
 *
 * Live data flow: the GitHub webhook relay lands events in the main process,
 * which fires `prs-updated`; we re-read the lane's summary and hot-refresh the
 * enriched detail (checks / reviews / merge status) immediately rather than
 * waiting for the next background polling tick. The parent (AgentChatPane) owns
 * the auto-pop decision and hands us a `delta` describing what just changed.
 */

// ---------------------------------------------------------------------------
// Delta detection — shared with AgentChatPane, which owns the auto-pop.
// ---------------------------------------------------------------------------

export type ChatPrDeltaKind =
  | "created"
  | "merged"
  | "closed"
  | "reopened"
  | "ready"
  | "draft"
  | "commit";

export type ChatPrDeltaTone = "good" | "bad" | "warn" | "info";

export type ChatPrDelta = {
  kind: ChatPrDeltaKind;
  label: string;
  tone: ChatPrDeltaTone;
  /** Bumped each time a new delta fires so the pane restarts its fade timer. */
  nonce: number;
};

export type ChatPrSignature = {
  exists: boolean;
  state: PrState | null;
  headSha: string | null;
};

export function chatPrSignature(pr: PrSummary | null): ChatPrSignature {
  return { exists: Boolean(pr), state: pr?.state ?? null, headSha: pr?.headSha ?? null };
}

/**
 * Returns a pop-worthy delta when the transition from `prev` → `next` warrants
 * an auto-pop: a newly created / linked PR, a lifecycle change (merged /
 * closed / reopened / ready / draft), or a new commit push. Check and review
 * changes intentionally return null — they update in the panel but must not
 * pop it. Returns null when nothing pop-worthy changed.
 */
export function detectChatPrDelta(
  prev: ChatPrSignature,
  next: PrSummary | null,
): Omit<ChatPrDelta, "nonce"> | null {
  if (!next) return null; // PR removed / unlinked — never pop.
  if (!prev.exists) {
    return { kind: "created", label: "Pull request opened", tone: "good" };
  }
  if (prev.state !== next.state) {
    switch (next.state) {
      case "merged":
        return { kind: "merged", label: "Merged", tone: "good" };
      case "closed":
        return { kind: "closed", label: "Closed", tone: "bad" };
      case "draft":
        return { kind: "draft", label: "Converted to draft", tone: "warn" };
      case "open":
        return prev.state === "draft"
          ? { kind: "ready", label: "Marked ready for review", tone: "good" }
          : { kind: "reopened", label: "Reopened", tone: "info" };
      default:
        return { kind: "reopened", label: "Updated", tone: "info" };
    }
  }
  if (prev.headSha && next.headSha && prev.headSha !== next.headSha) {
    return { kind: "commit", label: "New commit pushed", tone: "info" };
  }
  return null;
}

const DELTA_VISIBLE_MS = 4200;

const titleBarIconButton =
  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg/45 transition-colors hover:bg-white/[0.06] hover:text-fg/85 disabled:pointer-events-none disabled:opacity-40";

const paneAction =
  "inline-flex w-full items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 text-left text-[12px] font-medium text-fg/65 transition-colors hover:border-white/[0.10] hover:bg-white/[0.04] hover:text-fg/85";

const deltaToneClass: Record<ChatPrDeltaTone, string> = {
  good: "text-emerald-300/90",
  bad: "text-red-300/90",
  warn: "text-amber-300/90",
  info: "text-sky-300/90",
};

function stateTone(state: PrSummary["state"]): { dot: string; label: string } {
  switch (state) {
    case "open": return { dot: "bg-emerald-400", label: "Open" };
    case "draft": return { dot: "bg-amber-400/70", label: "Draft" };
    case "merged": return { dot: "bg-violet-400", label: "Merged" };
    case "closed": return { dot: "bg-red-400/70", label: "Closed" };
    default: return { dot: "bg-fg/25", label: String(state) };
  }
}

/** Human relative age for a sync timestamp. Computed at render (no ticking). */
function relTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "live";
  const s = Math.floor(ms / 1000);
  if (s < 10) return "live";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

type RelayState = { configured: boolean; webhookActive: boolean } | null;

/** green = fresh via webhook, amber = stale, grey = webhook not connected. */
function liveDot(pr: PrSummary, relay: RelayState): { dot: string; label: string; title: string } {
  const label = relTime(pr.lastSyncedAt);
  if (relay && !relay.configured) {
    return { dot: "bg-fg/30", label: "polling", title: "Webhook relay not connected — falling back to polling" };
  }
  const ageMs = pr.lastSyncedAt ? Date.now() - new Date(pr.lastSyncedAt).getTime() : Infinity;
  const fresh = Number.isFinite(ageMs) && ageMs < 120_000;
  const via = relay?.webhookActive ? "webhook" : "sync";
  return fresh
    ? { dot: "bg-emerald-400", label, title: `Live via GitHub ${via} · updated ${label} ago` }
    : { dot: "bg-amber-400/70", label, title: `Last ${via} ${label} ago` };
}

type ChecksView = { icon: React.ReactNode; text: string; tone: string };

function checksView(checks: PrCheck[] | null, fallback: PrSummary["checksStatus"]): ChecksView | null {
  if (checks && checks.length > 0) {
    const total = checks.length;
    const failing = checks.filter((check) => pipelineStateOf(check) === "failed").length;
    const running = checks.filter((c) => c.status !== "completed").length;
    const passing = checks.filter((c) => c.conclusion === "success").length;
    if (failing > 0) {
      return { icon: <XCircle size={11} weight="fill" />, text: `${failing}/${total} checks failing`, tone: "text-red-300/85" };
    }
    if (running > 0) {
      return { icon: <Clock size={11} weight="fill" />, text: `${passing}/${total} checks running`, tone: "text-amber-300/80" };
    }
    return { icon: <CheckCircle size={11} weight="fill" />, text: `${passing}/${total} checks`, tone: "text-emerald-300/80" };
  }
  switch (fallback) {
    case "passing": return { icon: <CheckCircle size={11} weight="fill" />, text: "Checks passing", tone: "text-emerald-300/80" };
    case "failing": return { icon: <XCircle size={11} weight="fill" />, text: "Checks failing", tone: "text-red-300/85" };
    case "pending": return { icon: <Clock size={11} weight="fill" />, text: "Checks running", tone: "text-amber-300/80" };
    default: return null;
  }
}

type ReviewView = { reviewer: string | null; avatarUrl: string | null; text: string; tone: string };

function reviewView(reviews: PrReview[] | null, fallback: PrSummary["reviewStatus"]): ReviewView | null {
  const decisive = reviews
    ?.filter((r) => r.state === "approved" || r.state === "changes_requested")
    .slice(-1)[0];
  if (decisive) {
    return decisive.state === "approved"
      ? { reviewer: decisive.reviewer, avatarUrl: decisive.reviewerAvatarUrl, text: "Approved", tone: "text-emerald-300/80" }
      : { reviewer: decisive.reviewer, avatarUrl: decisive.reviewerAvatarUrl, text: "Changes requested", tone: "text-amber-300/80" };
  }
  switch (fallback) {
    case "approved": return { reviewer: null, avatarUrl: null, text: "Approved", tone: "text-emerald-300/80" };
    case "changes_requested": return { reviewer: null, avatarUrl: null, text: "Changes requested", tone: "text-amber-300/80" };
    case "requested": return { reviewer: null, avatarUrl: null, text: "Review requested", tone: "text-fg/50" };
    default: return null;
  }
}

function isMergeReady(pr: PrSummary, status: PrStatus | null): boolean {
  if (pr.state !== "open") return false;
  if (!status) return false;
  const approved = status.reviewDecision === "approved" || status.reviewStatus === "approved";
  return (
    status.checksStatus === "passing" &&
    approved &&
    status.isMergeable &&
    !status.mergeConflicts &&
    (status.behindBaseBy ?? 0) === 0
  );
}

/** One-shot highlight flash replayed whenever `nonce` changes; plain otherwise. */
function FieldPulse({ nonce, active, children }: { nonce: number; active: boolean; children: React.ReactNode }) {
  if (!active) return <>{children}</>;
  return (
    <motion.div
      key={nonce}
      initial={{ backgroundColor: "rgba(255,255,255,0)" }}
      animate={{ backgroundColor: ["rgba(255,255,255,0.10)", "rgba(255,255,255,0)"] }}
      transition={{ duration: 1.1, ease: "easeOut" }}
      className="-mx-1 rounded px-1"
    >
      {children}
    </motion.div>
  );
}

function PrDetails({
  pr,
  checks,
  reviews,
  status,
  relay,
  delta,
  deltaVisible,
  copied,
  onOpenAde,
  onOpenGitHub,
  onCopy,
}: {
  pr: PrSummary;
  checks: PrCheck[] | null;
  reviews: PrReview[] | null;
  status: PrStatus | null;
  relay: RelayState;
  delta: ChatPrDelta | null;
  deltaVisible: boolean;
  copied: boolean;
  onOpenAde: () => void;
  onOpenGitHub: () => void;
  onCopy: () => void;
}) {
  const tone = stateTone(pr.state);
  const live = liveDot(pr, relay);
  const checksInfo = pr.state === "open" || pr.state === "draft" ? checksView(checks, pr.checksStatus) : null;
  const reviewInfo = reviewView(reviews, pr.reviewStatus);
  const mergeReady = isMergeReady(pr, status);
  const pulseHeader = deltaVisible && Boolean(delta) && delta!.kind !== "commit";
  const pulseChecks = deltaVisible && delta?.kind === "commit";
  const nonce = delta?.nonce ?? 0;

  return (
    <div className="space-y-3">
      <FieldPulse nonce={nonce} active={pulseHeader}>
        <div className="flex items-center gap-2">
          <span className={cn("inline-block h-2 w-2 rounded-full", tone.dot)} />
          <span className="text-[11px] font-medium uppercase tracking-wide text-fg/55">{tone.label}</span>
          <span className="font-mono text-[11px] text-fg/45">{formatPrBadgeLabel(pr)}</span>
          <span className="ml-auto inline-flex items-center gap-1.5" title={live.title}>
            <span className={cn("inline-block h-1.5 w-1.5 rounded-full", live.dot)} />
            <span className="text-[10.5px] tabular-nums text-fg/40">{live.label}</span>
          </span>
        </div>
      </FieldPulse>

      <AnimatePresence initial={false}>
        {delta && deltaVisible ? (
          <motion.button
            key={delta.nonce}
            type="button"
            onClick={onOpenAde}
            initial={{ opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className={cn(
              "group flex w-full items-center gap-1.5 text-left text-[11.5px] font-medium",
              deltaToneClass[delta.tone],
            )}
          >
            <Lightning size={12} weight="fill" className="shrink-0" />
            <span className="truncate">{delta.label}</span>
            <span className="ml-auto text-[10px] text-fg/35">just now</span>
            <ArrowRight size={10} className="shrink-0 opacity-0 transition-opacity group-hover:opacity-70" />
          </motion.button>
        ) : null}
      </AnimatePresence>

      <h3 className="text-[14px] font-semibold leading-snug text-fg/90">{pr.title}</h3>

      {pr.stack ? (
        <div className="rounded-lg border border-violet-400/15 bg-violet-500/[0.06] px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <GitHubStackBadge stack={pr.stack} />
            <span className="font-mono text-[10px] text-fg/35">base {pr.stack.baseBranch}</span>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-fg/50">
            This pull request belongs to GitHub Stack #{pr.stack.number}. Review rebases and merge the stack on GitHub.
          </p>
        </div>
      ) : mergeReady ? (
        <div className="inline-flex items-center gap-1.5 rounded-md bg-emerald-400/10 px-2 py-1 text-[11px] font-medium text-emerald-300/90">
          <Sparkle size={12} weight="fill" />
          Ready to merge
        </div>
      ) : null}

      <FieldPulse nonce={nonce} active={pulseChecks}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg/50">
          {checksInfo ? (
            <span className={cn("inline-flex items-center gap-1", checksInfo.tone)}>
              {checksInfo.icon}
              {checksInfo.text}
            </span>
          ) : null}
          {pr.additions > 0 || pr.deletions > 0 ? (
            <span className="inline-flex items-center gap-1">
              <span className="text-emerald-400/60">+{pr.additions}</span>
              <span className="text-red-400/60">−{pr.deletions}</span>
            </span>
          ) : null}
        </div>
      </FieldPulse>

      {reviewInfo ? (
        <div className={cn("flex items-center gap-1.5 text-[11px]", reviewInfo.tone)}>
          {reviewInfo.reviewer ? (
            <PrUserAvatar user={{ login: reviewInfo.reviewer, avatarUrl: reviewInfo.avatarUrl }} size={16} />
          ) : null}
          <span>{reviewInfo.text}</span>
          {reviewInfo.reviewer ? <span className="text-fg/35">· {reviewInfo.reviewer}</span> : null}
        </div>
      ) : null}

      {typeof pr.behindBaseBy === "number" && pr.behindBaseBy > 0 ? (
        <div className="text-[11px] text-amber-300/70">⚠ {pr.behindBaseBy} behind base</div>
      ) : pr.mergeConflicts ? (
        <div className="text-[11px] text-red-300/75">⚠ Merge conflicts</div>
      ) : null}

      <div className="flex flex-col gap-1.5 pt-1">
        <button type="button" onClick={onOpenAde} className={paneAction}>
          <GitPullRequest size={12} weight="bold" />
          Open in ADE
        </button>
        <button type="button" onClick={onOpenGitHub} className={paneAction}>
          <GithubLogo size={12} weight="bold" />
          Open on GitHub
          <ArrowSquareOut size={10} className="ml-auto opacity-60" />
        </button>
        <button type="button" onClick={onCopy} className={paneAction}>
          {copied ? <Check size={12} weight="bold" /> : <Copy size={12} weight="bold" />}
          {copied ? "Copied link" : "Copy link"}
        </button>
      </div>
    </div>
  );
}

export const ChatPrPane = React.memo(function ChatPrPane({
  laneId,
  branchName,
  sessionTitle = null,
  delta = null,
  onClose,
}: {
  laneId: string;
  branchName?: string | null;
  /**
   * Title of the chat this pane belongs to. Forwarded to the inline creator so a
   * new PR defaults to a title that describes the work. Optional — surfaces
   * without a session (the Work grid) fall back to the lane → target derivation.
   */
  sessionTitle?: string | null;
  /** Describes the PR change that triggered this pane's auto-pop (owned by the parent). */
  delta?: ChatPrDelta | null;
  /** Closes the pane — wired to the title bar's ✕ (the header PR pill also toggles it). */
  onClose?: () => void;
}) {
  const navigate = useNavigate();
  const projectRoot = useAppStore((s) => s.project?.rootPath ?? s.projectBinding?.rootPath ?? null);
  const [pr, setPr] = useState<PrSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [checks, setChecks] = useState<PrCheck[] | null>(null);
  const [reviews, setReviews] = useState<PrReview[] | null>(null);
  const [status, setStatus] = useState<PrStatus | null>(null);
  const [relay, setRelay] = useState<RelayState>(null);
  const [deltaVisible, setDeltaVisible] = useState(false);
  // Manual title-bar ↻ sync in flight.
  const [syncing, setSyncing] = useState(false);
  // Backend reconcile-on-focus running (project-scoped); drives the subtle
  // "syncing" spin on the ↻. Hidden on idle after a short debounce so a fast
  // reconcile does not flicker.
  const [reconciling, setReconciling] = useState(false);
  const reconcileHideTimerRef = useRef<number | null>(null);
  const currentPrIdRef = useRef<string | null>(null);
  const laneIdRef = useRef(laneId);
  const refreshRequestRef = useRef(0);
  laneIdRef.current = laneId;

  const setCurrentPr = useCallback((nextPr: PrSummary | null) => {
    currentPrIdRef.current = nextPr?.id ?? null;
    setPr(nextPr);
  }, []);

  const refresh = useCallback(async (options: { live?: boolean } = {}) => {
    const requestId = refreshRequestRef.current + 1;
    refreshRequestRef.current = requestId;
    const requestIsCurrent = () => laneIdRef.current === laneId && refreshRequestRef.current === requestId;
    let cached: PrSummary | null = null;
    try {
      cached = await window.ade.prs.getForLane(laneId);
      if (!requestIsCurrent()) return;
      setCurrentPr(cached);
      setLoading(false);
      if (options.live && cached && !cached.unmapped) {
        const refreshed = await refreshLinkedPrCoalesced(cached, { projectRoot });
        if (!requestIsCurrent()) return;
        setCurrentPr(refreshed);
      }
    } catch {
      if (!cached && requestIsCurrent()) setCurrentPr(null);
    } finally {
      if (requestIsCurrent()) setLoading(false);
    }
  }, [laneId, projectRoot, setCurrentPr]);

  // The inline creator hands us the freshly-created PR the moment createFromLane
  // resolves — swap to the details view instantly rather than waiting for the
  // next relay round-trip (`prs-updated`) to refresh the row.
  const handleCreated = useCallback((created: PrSummary) => {
    setCurrentPr(created);
  }, [setCurrentPr]);

  useEffect(() => { void refresh({ live: true }); }, [refresh]);

  // Manual title-bar ↻: force a best-effort sync of this lane's PR (heals
  // merged/closed state, or maps a merged-but-unmapped PR on the branch), then
  // re-read the pane's PR. Moved here from ChatGitToolbar so the chat header
  // stays a status strip and every PR affordance lives in this pane.
  const handleSyncLanePr = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await window.ade.prs.syncLanePr(laneId);
    } catch {
      // best-effort
    } finally {
      setSyncing(false);
    }
    void refresh({ live: true });
  }, [laneId, refresh, syncing]);

  // Backend reconcile-on-focus spinner (project-scoped), in its OWN subscription
  // keyed only on stable deps (laneId/projectRoot via refresh) — NOT the PR row.
  // Previously this lived in the PR-row-dependent subscription below, so the
  // idle branch's own refresh() (which mutates the PR row) re-ran that effect
  // within the 300ms window and its cleanup clearTimeout'd the pending hide,
  // stranding `reconciling` at true and spinning the ↻ forever. Here the hide
  // timer lives in a ref cleared only on unmount, so a PR-row change can no
  // longer strand it.
  useEffect(() => {
    const unsubscribe = window.ade.prs.onEvent((event) => {
      if (event.type !== "pr-reconcile") return;
      // Debounce the hide so a fast reconcile doesn't flicker.
      if (event.state === "running") {
        if (reconcileHideTimerRef.current != null) {
          window.clearTimeout(reconcileHideTimerRef.current);
          reconcileHideTimerRef.current = null;
        }
        setReconciling(true);
      } else {
        if (reconcileHideTimerRef.current != null) {
          window.clearTimeout(reconcileHideTimerRef.current);
        }
        reconcileHideTimerRef.current = window.setTimeout(() => {
          setReconciling(false);
          reconcileHideTimerRef.current = null;
        }, 300);
        // A reconcile just healed backend state — re-read the lane's PR.
        void refresh();
      }
    });
    return () => {
      unsubscribe();
    };
  }, [refresh]);

  // Clear the reconcile hide timer ONLY on unmount — never on a re-subscribe —
  // so the debounce can't be stranded mid-flight.
  useEffect(() => {
    return () => {
      if (reconcileHideTimerRef.current != null) {
        window.clearTimeout(reconcileHideTimerRef.current);
        reconcileHideTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const unsubscribe = window.ade.prs.onEvent((event) => {
      const currentPrId = currentPrIdRef.current;
      if (event.type === "pr-notification") {
        if (event.laneId === laneId || event.prId === currentPrId) void refresh();
        return;
      }
      if (event.type !== "prs-updated") return;
      const eventIncludesLanePr = event.prs.some((next) => next.laneId === laneId);
      const eventIncludesCurrentPr = currentPrId ? event.prs.some((next) => next.id === currentPrId) : false;
      if (eventIncludesLanePr || eventIncludesCurrentPr || !currentPrId) {
        void refresh();
      } else {
        setCurrentPr(null);
      }
    });
    return unsubscribe;
  }, [laneId, refresh, setCurrentPr]);

  // Hot-refresh enriched detail (checks / reviews / merge status) whenever this
  // PR's content changes — driven by the relay's `prs-updated`, not a timer.
  const enrichedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pr) {
      enrichedKeyRef.current = null;
      setChecks(null);
      setReviews(null);
      setStatus(null);
      return;
    }
    if (pr.unmapped) {
      enrichedKeyRef.current = null;
      setChecks(null);
      setReviews(null);
      setStatus(null);
      return;
    }
    const key = `${pr.id}:${pr.updatedAt}:${pr.headSha ?? ""}`;
    if (enrichedKeyRef.current === key) return;
    enrichedKeyRef.current = key;
    const prId = pr.id;
    let cancelled = false;
    void Promise.allSettled([
      window.ade.prs.getChecks(prId),
      window.ade.prs.getReviews(prId),
      window.ade.prs.getStatus(prId),
    ]).then(([c, r, s]) => {
      if (cancelled) return;
      if (c.status === "fulfilled") setChecks(c.value);
      if (r.status === "fulfilled") setReviews(r.value);
      if (s.status === "fulfilled") setStatus(s.value);
    });
    return () => { cancelled = true; };
  }, [pr]);

  // Best-effort: is the webhook relay actually connected for this repo? Drives
  // the live/stale/offline dot so the pane reflects real webhook status.
  const prRepoOwner = pr?.repoOwner ?? null;
  const prRepoName = pr?.repoName ?? null;
  useEffect(() => {
    if (!prRepoOwner || !prRepoName) return;
    let cancelled = false;
    window.ade.github
      .getAppInstallationStatus({ owner: prRepoOwner, name: prRepoName })
      .then((s) => {
        if (cancelled || !s) return;
        setRelay({ configured: Boolean(s.relayConfigured), webhookActive: s.webhookState === "active" });
      })
      .catch(() => { /* leave relay unknown → recency-based dot */ });
    return () => { cancelled = true; };
  }, [prRepoOwner, prRepoName]);

  // Show the delta line for a few seconds after each new delta, then fade it.
  useEffect(() => {
    if (!delta) { setDeltaVisible(false); return; }
    setDeltaVisible(true);
    const id = window.setTimeout(() => setDeltaVisible(false), DELTA_VISIBLE_MS);
    return () => window.clearTimeout(id);
  }, [delta?.nonce, delta]);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);

  const openInAde = useCallback(() => {
    if (!pr) return;
    navigate(`/prs?tab=normal&prId=${encodeURIComponent(pr.id)}`);
  }, [pr, navigate]);

  const openInGitHub = useCallback(async () => {
    if (!pr) return;
    try {
      await window.ade.app.openExternal(pr.githubUrl);
    } catch {
      try { window.open(pr.githubUrl, "_blank", "noopener,noreferrer"); } catch { /* noop */ }
    }
  }, [pr]);

  const copyLink = useCallback(async () => {
    if (!pr) return;
    try {
      await navigator.clipboard.writeText(pr.githubUrl);
      setCopied(true);
    } catch {
      /* clipboard denied */
    }
  }, [pr]);

  // Ambient status accent on the pane's inner edge: red while checks fail,
  // green while it's merge-ready. Kept as an inset shadow so it never shifts
  // layout. Recomputed from the same enriched data the body renders.
  const accentShadow = useMemo(() => {
    if (!pr) return undefined;
    if (isMergeReady(pr, status)) return "inset 3px 0 0 0 rgba(52,211,153,0.55)";
    const failing =
      pr.checksStatus === "failing" ||
      (checks?.some((check) => pipelineStateOf(check) === "failed") ?? false);
    if (failing) return "inset 3px 0 0 0 rgba(248,113,113,0.5)";
    return undefined;
  }, [pr, status, checks]);

  // The ↻ spins for a manual sync in flight OR a backend reconcile-on-focus.
  const syncSpinning = syncing || reconciling;

  return (
    <div className="flex h-full min-h-0 flex-col font-sans" style={accentShadow ? { boxShadow: accentShadow } : undefined}>
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-white/[0.06] px-3">
        <GitPullRequest size={12} weight="bold" className="shrink-0 text-fg/45" />
        <span className="min-w-0 truncate text-[11.5px] font-medium text-fg/70">Pull request</span>
        <button
          type="button"
          onClick={() => void handleSyncLanePr()}
          disabled={syncing}
          className={cn(titleBarIconButton, "ml-auto")}
          title={syncSpinning ? "Syncing PR status…" : "Refresh pull request"}
          aria-label="Refresh pull request"
        >
          <ArrowsClockwise size={12} weight="bold" className={cn(syncSpinning && "animate-spin")} />
        </button>
        <button
          type="button"
          onClick={onClose}
          className={titleBarIconButton}
          title="Close"
          aria-label="Close pull request panel"
        >
          <X size={12} weight="bold" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
        {loading ? (
          <p className="px-1 py-6 text-center text-[12px] text-fg/40">Loading…</p>
        ) : pr ? (
          <PrDetails
            pr={pr}
            checks={checks}
            reviews={reviews}
            status={status}
            relay={relay}
            delta={delta}
            deltaVisible={deltaVisible}
            copied={copied}
            onOpenAde={openInAde}
            onOpenGitHub={() => void openInGitHub()}
            onCopy={() => void copyLink()}
          />
        ) : (
          <ChatPrInlineCreator
            laneId={laneId}
            branchName={branchName ?? null}
            sessionTitle={sessionTitle}
            onCreated={handleCreated}
          />
        )}
      </div>
    </div>
  );
});

export default ChatPrPane;

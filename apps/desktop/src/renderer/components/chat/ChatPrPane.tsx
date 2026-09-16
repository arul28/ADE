import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowsClockwise,
  ArrowSquareOut,
  CaretDown,
  CheckCircle,
  Clock,
  Copy,
  Check,
  File,
  GithubLogo,
  GitPullRequest,
  LinkBreak,
  MinusCircle,
  Plus,
  Sparkle,
  X,
  XCircle,
} from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import type {
  OpenProjectBinding,
  PrCheck,
  PrFile,
  PrReview,
  PrStatus,
  PrSummary,
  StackLinkOffer,
} from "../../../shared/types";
import { formatPrBadgeLabel } from "../prs/shared/prFormatters";
import { PrUserAvatar } from "../prs/shared/PrUserAvatar";
import { ChatPrInlineCreator } from "./ChatPrInlineCreator";
import { refreshLinkedPrCoalesced } from "../../lib/prReadCache";
import { useMachineEntryForBinding } from "../../state/crossMachineLanes";
import { useChatRuntimeScopeForPin } from "./ChatRuntimeScope";
import { pipelineStateOf } from "../../../shared/prPipelineState";
import { openLanePr, selectPrimaryLanePr } from "../../lib/lanePrBadge";
import { rankPrFilesByChurn, selectPrsForChat } from "../../../shared/prChatScope";
import { GitHubStackBadge } from "../prs/shared/GitHubStackBadge";
import { buildPrsRouteSearch } from "../prs/prsRouteState";
import { NO_CI_REASON } from "../../../shared/prChecksRollup";
import { ChatPrStackOffer } from "./ChatPrStackOffer";

/**
 * Left floating info-pane for an ADE chat's pull request. Mirrors the right
 * Chat-actions pane: when a PR exists we show its live, webhook-driven status +
 * quick actions; when none exists we embed a compact inline PR creator
 * (ChatPrInlineCreator) so the user never leaves the Work tab.
 *
 * Live data flow: the GitHub webhook relay lands events in the main process,
 * which fires `prs-updated`; we re-read the lane's summary and hot-refresh the
 * enriched detail (checks / reviews / merge status) immediately rather than
 * waiting for the next background polling tick.
 */

const titleBarIconButton =
  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg/45 transition-colors hover:bg-white/[0.06] hover:text-fg/85 disabled:pointer-events-none disabled:opacity-40";

const paneAction =
  "inline-flex w-full items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 text-left text-[12px] font-medium text-fg/65 transition-colors hover:border-white/[0.10] hover:bg-white/[0.04] hover:text-fg/85";

const paneActionPrimary =
  "inline-flex w-full items-center gap-2 rounded-lg border border-violet-400/25 bg-violet-500/[0.10] px-2.5 py-1.5 text-left text-[12px] font-medium text-violet-100/90 transition-colors hover:border-violet-400/40 hover:bg-violet-500/[0.16]";

function filePeekLabel(filename: string): string {
  const parts = filename.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/") || filename;
  return parts.slice(-2).join("/");
}

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

type ChecksView = { icon: React.ReactNode; text: string; tone: string; title?: string };

const NOT_RUN_TONE = "text-fg/45";

function notRunView(reason: string | null | undefined): ChecksView {
  return {
    icon: <MinusCircle size={11} weight="fill" />,
    text: "CI not run",
    tone: NOT_RUN_TONE,
    title: reason ?? NO_CI_REASON,
  };
}

function checksView(
  checks: PrCheck[] | null,
  fallback: PrSummary["checksStatus"],
  reason?: string | null,
): ChecksView | null {
  // ADE-135: the rollup knows two things the per-job rows cannot show — which
  // app produced each run, and which required contexts never reported at all.
  // When it says nothing verified this commit, that verdict outranks any count
  // of green rows; PR #988 had three third-party successes and zero CI.
  if (fallback === "not_run") return notRunView(reason);
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
    // Every row settled and not one of them succeeded (all skipped/neutral/
    // cancelled). "0/3 checks" in green read as a pass; it is an absence.
    if (passing === 0) return notRunView(reason);
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

function PrDetails({
  pr,
  checks,
  reviews,
  status,
  relay,
  copied,
  files,
  filesRemaining,
  onOpenFiles,
  onOpenGitHub,
  onCopy,
}: {
  pr: PrSummary;
  checks: PrCheck[] | null;
  reviews: PrReview[] | null;
  status: PrStatus | null;
  relay: RelayState;
  copied: boolean;
  files: PrFile[];
  filesRemaining: number;
  onOpenFiles: () => void;
  onOpenGitHub: () => void;
  onCopy: () => void;
}) {
  const tone = stateTone(pr.state);
  const live = liveDot(pr, relay);
  // The live status wins over the stored summary when we have it, and its
  // reason must travel with the status it explains.
  const checksStatus = status?.checksStatus ?? pr.checksStatus;
  const checksReason = (status ? status.checksReason : pr.checksReason) ?? null;
  const checksInfo = pr.state === "open" || pr.state === "draft"
    ? checksView(checks, checksStatus, checksReason)
    : null;
  const reviewInfo = reviewView(reviews, pr.reviewStatus);
  const mergeReady = isMergeReady(pr, status);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className={cn("inline-block h-2 w-2 rounded-full", tone.dot)} />
        <span className="text-[11px] font-medium uppercase tracking-wide text-fg/55">{tone.label}</span>
        <span className="font-mono text-[11px] text-fg/45">{formatPrBadgeLabel(pr)}</span>
        <span className="ml-auto inline-flex items-center gap-1.5" title={live.title}>
          <span className={cn("inline-block h-1.5 w-1.5 rounded-full", live.dot)} />
          <span className="text-[10.5px] tabular-nums text-fg/40">{live.label}</span>
        </span>
      </div>

      <h3 className="text-[14px] font-semibold leading-snug text-fg/90">{pr.title}</h3>

      {pr.stack ? (
        <div className="rounded-lg border border-violet-400/15 bg-violet-500/[0.06] px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <GitHubStackBadge stack={pr.stack} />
            <span className="font-mono text-[10px] text-fg/35">base {pr.stack.baseBranch}</span>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-fg/50">
            Merge and rebase this stack on the PRs tab.
          </p>
        </div>
      ) : mergeReady ? (
        <div className="inline-flex items-center gap-1.5 rounded-md bg-emerald-400/10 px-2 py-1 text-[11px] font-medium text-emerald-300/90">
          <Sparkle size={12} weight="fill" />
          Ready to merge
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg/50">
        {checksInfo ? (
          <span className={cn("inline-flex items-center gap-1", checksInfo.tone)} title={checksInfo.title}>
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

      {files.length > 0 ? (
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wide text-fg/40">
            <File size={11} weight="bold" />
            Files
          </div>
          <div className="space-y-1">
            {files.map((file) => (
              <div key={file.filename} className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg/70" title={file.filename}>
                  {filePeekLabel(file.filename)}
                </span>
                <span className="shrink-0 font-mono text-[10px] tabular-nums">
                  <span className="text-emerald-400/70">+{file.additions}</span>
                  {" "}
                  <span className="text-red-400/70">−{file.deletions}</span>
                </span>
              </div>
            ))}
          </div>
          {filesRemaining > 0 ? (
            <div className="mt-1.5 text-[10.5px] text-fg/40">+{filesRemaining} more files</div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5 pt-1">
        <button type="button" onClick={onOpenFiles} className={paneActionPrimary}>
          <File size={12} weight="bold" />
          {files.length > 0 ? "Open files on PRs tab" : "Open files"}
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
  sessionId = null,
  preferredPrId = null,
  onClose,
  runtimePin = null,
}: {
  laneId: string;
  branchName?: string | null;
  /**
   * Title of the chat this pane belongs to. Forwarded to the inline creator so a
   * new PR defaults to a title that describes the work. Optional — surfaces
   * without a session (the Work grid) fall back to the lane → target derivation.
   */
  sessionTitle?: string | null;
  /** The chat whose explicit PR links should be shown first. */
  sessionId?: string | null;
  /** Toolbar pick: show this linked PR instead of the lane primary. */
  preferredPrId?: string | null;
  /** Closes the pane — wired to the title bar's ✕ (the header PR pill also toggles it). */
  onClose?: () => void;
  /** See `ChatGitToolbar.runtimePin` — the machine this lane's PR row lives on. */
  runtimePin?: OpenProjectBinding | null;
}) {
  const navigate = useNavigate();
  // Also rendered from the Work view area, which has no chat scope above it,
  // so the scope is derived from the pin this pane is handed.
  const scope = useChatRuntimeScopeForPin(runtimePin, laneId);
  const projectRoot = scope.rootPath;
  // Keep the PR refresh callback keyed to the lane identity, not the lanes
  // collection. Lane status refreshes replace that array frequently, and
  // making it a dependency would tear down/recreate the PR event pump.
  const laneType = scope.lane?.laneType ?? "worktree";
  const laneBranchRef = scope.lane?.branchRef ?? null;
  const laneBaseRef = scope.lane?.baseRef ?? null;
  const laneForPr = useMemo(() => ({
    id: laneId,
    laneType,
    branchRef: laneBranchRef ?? branchName ?? "",
    baseRef: laneBaseRef ?? "",
  }), [branchName, laneBaseRef, laneBranchRef, laneId, laneType]);
  // See `ChatGitToolbar`: a local pin is a fresh object on every cross-machine
  // merge, so effects key on the stable pin key and read the object via a ref.
  const runtimePinRef = useRef<OpenProjectBinding | null>(runtimePin);
  runtimePinRef.current = runtimePin;
  const runtimePinKey = runtimePin?.key ?? null;
  const pinMachineName = useMachineEntryForBinding(runtimePin)?.machineName ?? null;
  const [linkedPrs, setLinkedPrs] = useState<PrSummary[]>([]);
  const [selectedPrId, setSelectedPrId] = useState<string | null>(null);
  const [catalogPrs, setCatalogPrs] = useState<PrSummary[]>([]);
  const [pr, setPr] = useState<PrSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const { copy, copied } = useCopyToClipboard();
  const [checks, setChecks] = useState<PrCheck[] | null>(null);
  const [reviews, setReviews] = useState<PrReview[] | null>(null);
  const [status, setStatus] = useState<PrStatus | null>(null);
  const [relay, setRelay] = useState<RelayState>(null);
  const [peekFiles, setPeekFiles] = useState<PrFile[]>([]);
  const [filesRemaining, setFilesRemaining] = useState(0);
  const [stackOffer, setStackOffer] = useState<StackLinkOffer | null>(null);
  const [dismissedOfferKey, setDismissedOfferKey] = useState<string | null>(null);
  const [stackLinkError, setStackLinkError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  // Manual title-bar ↻ sync in flight.
  const [syncing, setSyncing] = useState(false);
  // Backend reconcile-on-focus running (project-scoped); drives the subtle
  // "syncing" spin on the ↻. Hidden on idle after a short debounce so a fast
  // reconcile does not flicker.
  const [reconciling, setReconciling] = useState(false);
  const reconcileHideTimerRef = useRef<number | null>(null);
  const currentPrIdRef = useRef<string | null>(null);
  const selectedPrIdRef = useRef<string | null>(null);
  const laneIdRef = useRef(laneId);
  const refreshRequestRef = useRef(0);
  laneIdRef.current = laneId;
  selectedPrIdRef.current = selectedPrId;

  const clearPeekDetails = useCallback(() => {
    setChecks(null);
    setReviews(null);
    setStatus(null);
    setPeekFiles([]);
    setFilesRemaining(0);
    setStackOffer(null);
  }, []);

  const showPr = useCallback((nextPr: PrSummary | null) => {
    if (nextPr?.id !== currentPrIdRef.current) clearPeekDetails();
    setSelectedPrId(nextPr?.id ?? null);
    currentPrIdRef.current = nextPr?.id ?? null;
    setPr(nextPr);
  }, [clearPeekDetails]);

  const applyScopedPrs = useCallback((scoped: PrSummary[], preferredId?: string | null) => {
    const preferred = String(preferredId ?? preferredPrId ?? selectedPrIdRef.current ?? "").trim();
    const nextPr = (preferred ? scoped.find((candidate) => candidate.id === preferred) : null)
      ?? selectPrimaryLanePr(laneForPr, scoped)
      ?? scoped[0]
      ?? null;
    setLinkedPrs(scoped);
    showPr(nextPr);
    return nextPr;
  }, [laneForPr, preferredPrId, showPr]);

  const refresh = useCallback(async (options: { live?: boolean } = {}) => {
    const requestId = refreshRequestRef.current + 1;
    refreshRequestRef.current = requestId;
    const requestIsCurrent = () => laneIdRef.current === laneId && refreshRequestRef.current === requestId;
    let cached: PrSummary | null = null;
    try {
      if (typeof window.ade.prs.listAll === "function") {
        const allPrs = await window.ade.prs.listAll(runtimePinRef.current);
        if (!requestIsCurrent()) return;
        const livePrs = allPrs.filter((candidate) => !candidate.detached);
        setCatalogPrs(livePrs);
        const scopedPrs = sessionId
          ? selectPrsForChat(livePrs, sessionId, { currentBranch: branchName ?? laneBranchRef })
          : selectPrsForChat(
            livePrs.filter((candidate) => candidate.laneId === laneId),
            null,
          );
        cached = applyScopedPrs(scopedPrs);
      } else {
        const legacy = await window.ade.prs.getForLane(laneId, runtimePinRef.current);
        if (!requestIsCurrent()) return;
        const scoped = legacy ? [legacy] : [];
        setCatalogPrs(scoped);
        cached = applyScopedPrs(scoped);
      }
      if (!requestIsCurrent()) return;
      setLoading(false);
      if (options.live && cached && !cached.unmapped) {
        const refreshed = await refreshLinkedPrCoalesced(cached, { projectRoot, pin: runtimePinRef.current });
        if (!requestIsCurrent() || !refreshed) return;
        setLinkedPrs((current) => {
          const next = current.map((candidate) => (
            candidate.id === refreshed.id ? { ...candidate, ...refreshed } : candidate
          ));
          return next.some((candidate) => candidate.id === refreshed.id) ? next : [...next, refreshed];
        });
        currentPrIdRef.current = refreshed.id;
        setSelectedPrId(refreshed.id);
        setPr(refreshed);
      }
    } catch {
      if (!cached && requestIsCurrent()) {
        applyScopedPrs([]);
      }
    } finally {
      if (requestIsCurrent()) setLoading(false);
    }
    // See ChatGitToolbar: read via ref, but the identity must still follow the
    // pin so the effects keyed on it re-read from the new machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyScopedPrs, branchName, laneBranchRef, laneId, projectRoot, runtimePinKey, sessionId]);

  // The inline creator hands us the freshly-created PR the moment createFromLane
  // resolves — swap to the details view instantly rather than waiting for the
  // next relay round-trip (`prs-updated`) to refresh the row.
  const handleCreated = useCallback((created: PrSummary) => {
    setLinkedPrs((current) => {
      const next = current.some((candidate) => candidate.id === created.id)
        ? current.map((candidate) => (candidate.id === created.id ? created : candidate))
        : [...current, created];
      setCatalogPrs((catalog) => (
        catalog.some((candidate) => candidate.id === created.id)
          ? catalog.map((candidate) => (candidate.id === created.id ? { ...candidate, ...created } : candidate))
          : [...catalog, created]
      ));
      showPr(created);
      return next;
    });
  }, [showPr]);

  useEffect(() => { void refresh({ live: true }); }, [refresh]);

  // Manual title-bar ↻: force a best-effort sync of this lane's PR (heals
  // merged/closed state, or maps a merged-but-unmapped PR on the branch), then
  // re-read the pane's PR. Moved here from ChatGitToolbar so the chat header
  // stays a status strip and every PR affordance lives in this pane.
  const handleSyncLanePr = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await window.ade.prs.syncLanePr(laneId, runtimePinRef.current);
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
    }, runtimePinRef.current);
    return () => {
      unsubscribe();
    };
  }, [refresh, runtimePinKey]);

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
      } else if (typeof window.ade.prs.listAll !== "function") {
        applyScopedPrs([]);
      } else {
        void refresh();
      }
    }, runtimePinRef.current);
    return unsubscribe;
  }, [applyScopedPrs, laneId, refresh, runtimePinKey]);

  useEffect(() => {
    const preferred = String(preferredPrId ?? "").trim();
    if (!preferred) return;
    const candidate = linkedPrs.find((entry) => entry.id === preferred);
    if (candidate) showPr(candidate);
  }, [linkedPrs, preferredPrId, showPr]);

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
      window.ade.prs.getChecks(prId, runtimePinRef.current),
      window.ade.prs.getReviews(prId, runtimePinRef.current),
      window.ade.prs.getStatus(prId, runtimePinRef.current),
    ]).then(([c, r, s]) => {
      if (cancelled) return;
      if (c.status === "fulfilled") setChecks(c.value);
      if (r.status === "fulfilled") setReviews(r.value);
      if (s.status === "fulfilled") setStatus(s.value);
    });
    return () => { cancelled = true; };
  }, [pr, runtimePinKey]);

  const peekFileKey = pr && !pr.unmapped ? `${pr.id}:${pr.headSha ?? pr.updatedAt}` : null;
  useEffect(() => {
    if (!peekFileKey || !pr || typeof window.ade.prs.getFiles !== "function") {
      setPeekFiles([]);
      setFilesRemaining(0);
      return;
    }
    let cancelled = false;
    void window.ade.prs.getFiles(pr.id, runtimePinRef.current).then((files) => {
      if (cancelled) return;
      const ranked = rankPrFilesByChurn(files, 3);
      setPeekFiles(ranked.files);
      setFilesRemaining(ranked.remaining);
    }).catch(() => {
      if (!cancelled) {
        setPeekFiles([]);
        setFilesRemaining(0);
      }
    });
    return () => { cancelled = true; };
  }, [peekFileKey, pr, runtimePinKey]);

  useEffect(() => {
    if (!sessionId || !pr?.stack || typeof window.ade.prs.getStackLinkOffer !== "function") {
      setStackOffer(null);
      return;
    }
    let cancelled = false;
    void window.ade.prs.getStackLinkOffer({ sessionId, prId: pr.id })
      .then((offer) => {
        if (cancelled) return;
        const linkable = (offer?.siblings ?? []).filter((sibling) => !sibling.claimedByOtherChat);
        setStackOffer(linkable.length > 0 ? offer : null);
      })
      .catch(() => {
        if (!cancelled) setStackOffer(null);
      });
    return () => { cancelled = true; };
  }, [pr, runtimePinKey, sessionId]);

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

  // Same rule the sidebar badge follows: a PR id only resolves on the machine
  // that owns it, so a pinned pane's "Open files" would land on an empty PRs
  // tab. `openLanePr` sends a foreign PR to GitHub instead.
  const openFiles = useCallback(() => {
    if (!pr) return;
    openLanePr(pr, {
      foreign: Boolean(runtimePin),
      navigate,
      localPath: `/prs${buildPrsRouteSearch({
        activeTab: "normal",
        selectedPrId: pr.id,
        selectedPrNumber: pr.githubPrNumber,
        repoOwner: pr.repoOwner,
        repoName: pr.repoName,
        selectedRebaseItemId: null,
        detailTab: "files",
      })}`,
    });
  }, [pr, navigate, runtimePin]);

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
    await copy(pr.githubUrl);
  }, [copy, pr]);

  const offerKey = stackOffer ? `${stackOffer.sessionId}:${stackOffer.stackNumber}` : null;
  const visibleOffer = stackOffer && offerKey !== dismissedOfferKey ? stackOffer : null;
  const linkableCatalog = useMemo(() => {
    if (!sessionId) return [];
    const linkedIds = new Set(linkedPrs.map((candidate) => candidate.id));
    return catalogPrs.filter((candidate) => {
      if (linkedIds.has(candidate.id)) return false;
      const claimed = (candidate.chatSessionIds ?? []).some((id) => id !== sessionId);
      return !claimed;
    });
  }, [catalogPrs, linkedPrs, sessionId]);

  const linkPr = useCallback(async (prId: string, allowCrossLane = false) => {
    if (!sessionId || typeof window.ade.prs.linkChatSession !== "function") return;
    setLinkBusy(true);
    setLinkError(null);
    try {
      const result = await window.ade.prs.linkChatSession({ prId, sessionId, allowCrossLane });
      if (!result?.ok) {
        setLinkError("Could not link this pull request.");
        return;
      }
      setLinkPickerOpen(false);
      await refresh({ live: true });
    } finally {
      setLinkBusy(false);
    }
  }, [refresh, sessionId]);

  const unlinkCurrent = useCallback(async () => {
    if (!sessionId || !pr || typeof window.ade.prs.unlinkChatSession !== "function") return;
    setLinkBusy(true);
    setLinkError(null);
    try {
      const result = await window.ade.prs.unlinkChatSession({ prId: pr.id, sessionId });
      if (!result?.ok) {
        setLinkError("Could not unlink this pull request.");
        return;
      }
      await refresh();
    } finally {
      setLinkBusy(false);
    }
  }, [pr, refresh, sessionId]);

  const linkStack = useCallback(async () => {
    if (!visibleOffer) return;
    setLinkBusy(true);
    setStackLinkError(null);
    try {
      const result = await window.ade.prs.linkChatStack({
        sessionId: visibleOffer.sessionId,
        stackNumber: visibleOffer.stackNumber,
        prId: visibleOffer.prId,
      });
      if (!result?.ok) {
        setStackLinkError("Could not link this GitHub stack.");
        return;
      }
      setDismissedOfferKey(`${visibleOffer.sessionId}:${visibleOffer.stackNumber}`);
      await refresh({ live: true });
    } catch (error) {
      setStackLinkError(error instanceof Error ? error.message : "Could not link this GitHub stack.");
    } finally {
      setLinkBusy(false);
    }
  }, [refresh, visibleOffer]);

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
        {linkedPrs.length > 1 ? (
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            {linkedPrs.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                onClick={() => showPr(candidate)}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10.5px] tabular-nums transition-colors",
                  candidate.id === pr?.id
                    ? "bg-white/[0.08] text-fg/85"
                    : "text-fg/40 hover:bg-white/[0.04] hover:text-fg/70",
                )}
                aria-pressed={candidate.id === pr?.id}
                aria-label={`Show pull request #${candidate.githubPrNumber}`}
                title={candidate.title}
              >
                <span
                  className={cn(
                    "inline-block h-1.5 w-1.5 rounded-full",
                    candidate.state === "merged"
                      ? "bg-violet-400"
                      : candidate.state === "closed"
                        ? "bg-red-400/70"
                        : candidate.checksStatus === "failing"
                          ? "bg-red-400"
                          : candidate.checksStatus === "passing"
                            ? "bg-emerald-400"
                            : "bg-fg/30",
                  )}
                />
                #{candidate.githubPrNumber}
              </button>
            ))}
          </div>
        ) : (
          <span
            className="min-w-0 truncate font-mono text-[11.5px] font-medium tabular-nums text-fg/70"
            title={pr?.title ?? undefined}
          >
            {pr?.githubPrNumber ? `#${pr.githubPrNumber}` : "Pull request"}
          </span>
        )}
        <button
          type="button"
          onClick={() => void handleSyncLanePr()}
          disabled={syncing}
          className={cn(titleBarIconButton, linkedPrs.length > 1 ? "ml-1" : "ml-auto")}
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
          <div className="space-y-3">
            {visibleOffer ? (
              <ChatPrStackOffer
                offer={visibleOffer}
                busy={linkBusy}
                error={stackLinkError}
                onLink={() => void linkStack()}
                onDismiss={() => setDismissedOfferKey(offerKey)}
              />
            ) : null}
            <PrDetails
              pr={pr}
              checks={checks}
              reviews={reviews}
              status={status}
              relay={relay}
              copied={copied}
              files={peekFiles}
              filesRemaining={filesRemaining}
              onOpenFiles={openFiles}
              onOpenGitHub={() => void openInGitHub()}
              onCopy={() => void copyLink()}
            />
            {sessionId && !runtimePin ? (
              <div className="space-y-1.5 border-t border-white/[0.06] pt-3">
                {linkPickerOpen ? (
                  <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-2">
                    <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wide text-fg/40">
                      Link another PR
                    </div>
                    {linkableCatalog.length === 0 ? (
                      <p className="px-1 py-2 text-[11px] text-fg/40">No other unclaimed pull requests.</p>
                    ) : (
                      <div className="max-h-40 space-y-0.5 overflow-y-auto">
                        {linkableCatalog.map((candidate) => (
                          <button
                            key={candidate.id}
                            type="button"
                            disabled={linkBusy}
                            onClick={() => void linkPr(candidate.id, candidate.laneId !== laneId)}
                            className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-white/[0.05] disabled:opacity-50"
                          >
                            <span className="shrink-0 font-mono text-[11px] text-fg/55">#{candidate.githubPrNumber}</span>
                            <span className="min-w-0 truncate text-[11px] text-fg/75">{candidate.title}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => setLinkPickerOpen(false)}
                      className="mt-1 text-[11px] text-fg/40 hover:text-fg/65"
                    >
                      Cancel
                    </button>
                    {linkError ? (
                      <p role="alert" className="mt-1.5 text-[11px] leading-relaxed text-red-300/85">{linkError}</p>
                    ) : null}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setLinkPickerOpen(true)}
                    className={paneAction}
                  >
                    <Plus size={12} weight="bold" />
                    Link another PR
                    <CaretDown size={10} className="ml-auto opacity-50" />
                  </button>
                )}
                <button
                  type="button"
                  disabled={linkBusy}
                  onClick={() => void unlinkCurrent()}
                  className={paneAction}
                >
                  <LinkBreak size={12} weight="bold" />
                  Unlink this PR
                </button>
                {!linkPickerOpen && linkError ? (
                  <p role="alert" className="text-[11px] leading-relaxed text-red-300/85">{linkError}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : runtimePin ? (
          // Reading a foreign lane's PR is now routed to its machine; CREATING
          // one is not. The creator derives its branch, base and Linear link
          // from `state.lanes` — the bound machine's lanes, which do not contain
          // this lane — and `createFromLane` is unpinned, so it would run
          // against the wrong machine. Say so instead of offering a button that
          // cannot work.
          <p className="px-1 py-6 text-center text-[12px] leading-relaxed text-fg/40">
            No pull request yet.
            <br />
            Switch to {pinMachineName ?? "this chat's machine"} to open one.
          </p>
        ) : (
          <ChatPrInlineCreator
            laneId={laneId}
            branchName={branchName ?? null}
            sessionTitle={sessionTitle}
            sessionId={sessionId}
            onCreated={handleCreated}
          />
        )}
      </div>
    </div>
  );
});

export default ChatPrPane;

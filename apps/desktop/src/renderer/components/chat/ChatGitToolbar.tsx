import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  GitPullRequest,
  CircleNotch,
  CheckCircle,
  XCircle,
  Clock,
  MinusCircle,
  CaretRight,
  GithubLogo,
  Copy,
  Check,
} from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "../ui/cn";
import type { DiffChanges, OpenProjectBinding, PrSummary, PrCheck } from "../../../shared/types";
import { armLaneBranchDriftWarning } from "../lanes/LaneBranchDrift";
import { useLaneGitActionRuntimeState } from "../lanes/LaneGitActionsPane";
import { formatPrBadgeLabel } from "../prs/shared/prFormatters";
import { buildPrsRouteSearch } from "../prs/prsRouteState";
import { useAppStore } from "../../state/appStore";
import { refreshLinkedPrCoalesced } from "../../lib/prReadCache";
import { rollupPrChecks } from "../../../shared/prChecksRollup";
import type { PrChecksStatus } from "../../../shared/types/prs";
import {
  lanePrAggregateAttention,
  lanePrAttentionColor,
  openLanePr,
  selectPrimaryLanePr,
} from "../../lib/lanePrBadge";
import { selectPrsForChat } from "../../lib/prChatScope";
import { GitHubStackBadge } from "../prs/shared/GitHubStackBadge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ChatGitToolbarProps = {
  laneId: string;
  /** The chat owning this header; its explicit PR links win over lane fallback. */
  sessionId?: string | null;
  /**
   * When provided (ADE chat surfaces), the PR pill/button toggles this instead
   * of opening the inline slide-out or navigating to the PRs tab. CLI surfaces
   * omit it, preserving the original menu behaviour.
   */
  onTogglePrPane?: () => void;
  prPaneOpen?: boolean;
  /**
   * The machine this lane lives on, when it is not the machine the project tab
   * is bound to. A lane's PR record lives in its own machine's database, so
   * without this the pill reads the bound machine's rows, finds nothing, and
   * shows the bare "PR" create button for a session that already has one.
   */
  runtimePin?: OpenProjectBinding | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dirtyFileCount(changes: DiffChanges): number {
  return changes.staged.length + changes.unstaged.length;
}

function checksIcon(status: PrSummary["checksStatus"], state: PrSummary["state"]) {
  if (state !== "open" && state !== "draft") return null;
  switch (status) {
    case "passing":
      return <CheckCircle size={10} weight="fill" className="text-emerald-400/80" />;
    case "failing":
      return <XCircle size={10} weight="fill" className="text-red-400/80" />;
    case "pending":
      return <Clock size={10} weight="fill" className="text-amber-400/80 animate-pulse" />;
    // ADE-135: rendered, but muted and never green — nothing verified this
    // commit. Returning null here (the old `default`) hid the finding entirely
    // and left the pill looking identical to a repo with no CI.
    case "not_run":
      return <MinusCircle size={10} weight="fill" className="text-fg/40" />;
    default:
      return null;
  }
}

function formatRelativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  const deltaMs = Date.now() - ts;
  if (deltaMs < 0) return "just now";
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * ADE-135: this carried its own tally and was producer-blind, so a PR whose
 * only checks were CodeRabbit and Vercel rendered a green "3" here — the
 * ticket's bug, beside a pill that had already been fixed to say "not run".
 * The shared row rollup decides; this only reshapes the counts for the JSX.
 */
function summarizeChecks(
  checks: PrCheck[],
): { passed: number; failed: number; running: number; skipped: number; total: number; status: PrChecksStatus } {
  const { status, counts } = rollupPrChecks(checks);
  return {
    passed: counts.passing,
    failed: counts.failing,
    running: counts.pending,
    skipped: counts.skipped,
    total: counts.total,
    status,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ChatGitToolbar = React.memo(function ChatGitToolbar({
  laneId,
  sessionId = null,
  onTogglePrPane,
  prPaneOpen,
  runtimePin = null,
}: ChatGitToolbarProps) {
  const navigate = useNavigate();
  const runtime = useLaneGitActionRuntimeState(laneId);
  const isRemoteProject = useAppStore((s) => s.projectBinding?.kind === "remote");
  const projectRoot = useAppStore((s) => s.project?.rootPath ?? s.projectBinding?.rootPath ?? null);
  // Keep PR refresh identity stable across unrelated lane-list updates. The
  // array is replaced by status refreshes, which otherwise re-subscribes the
  // PR event pump even when this lane's identity is unchanged.
  const laneType = useAppStore((s) => s.lanes.find((candidate) => candidate.id === laneId)?.laneType ?? "worktree");
  const laneBranchRef = useAppStore((s) => s.lanes.find((candidate) => candidate.id === laneId)?.branchRef ?? "");
  const laneBaseRef = useAppStore((s) => s.lanes.find((candidate) => candidate.id === laneId)?.baseRef ?? "");
  const laneForPr = useMemo(() => ({
    id: laneId,
    laneType,
    branchRef: laneBranchRef,
    baseRef: laneBaseRef,
  }), [laneBaseRef, laneBranchRef, laneId, laneType]);

  const [dirtyCount, setDirtyCount] = useState(0);
  const [linkedPrs, setLinkedPrs] = useState<PrSummary[]>([]);
  const [linkedPr, setLinkedPr] = useState<PrSummary | null>(null);
  const [prLoaded, setPrLoaded] = useState(false);
  const [prActionBusy, setPrActionBusy] = useState(false);
  const [prMenuOpen, setPrMenuOpen] = useState(false);
  const [prChecks, setPrChecks] = useState<PrCheck[] | null>(null);
  const [prChecksLoading, setPrChecksLoading] = useState(false);
  const [copyConfirmed, setCopyConfirmed] = useState(false);
  const laneIdRef = React.useRef(laneId);
  const refreshPrRequestRef = React.useRef(0);
  laneIdRef.current = laneId;
  // Read inside the event handler through a ref, never as an effect dep. On the
  // PINNED path `prs.onEvent` is a polling pump that re-anchors to the live head
  // on every subscribe (`suppressReplay`), so making the subscription depend on
  // the PR row — which every event replaces — drops whatever the runtime
  // buffered in the teardown gap. ChatPrPane keeps its subscription stable the
  // same way.
  const linkedPrRef = React.useRef<PrSummary | null>(null);
  linkedPrRef.current = linkedPr;
  // Effects key on the pin's KEY, never its object identity: a local pin is
  // reconstructed on every cross-machine merge (~10s), and depending on the
  // object made the reset effect blank the pill and the pinned event pump
  // re-anchor on that timer. The object itself is read through this ref.
  const runtimePinRef = React.useRef<OpenProjectBinding | null>(runtimePin);
  runtimePinRef.current = runtimePin;
  const runtimePinKey = runtimePin?.key ?? null;

  // -----------------------------------------------------------------------
  // Refresh git status + PR link
  // -----------------------------------------------------------------------

  const refreshStatus = useCallback(async () => {
    try {
      const changes = await window.ade.diff.getChanges({ laneId });
      setDirtyCount(dirtyFileCount(changes));
    } catch {
      // best-effort
    }
  }, [laneId]);

  const refreshPr = useCallback(async (options: { live?: boolean } = {}) => {
    const requestId = refreshPrRequestRef.current + 1;
    refreshPrRequestRef.current = requestId;
    const requestIsCurrent = () => laneIdRef.current === laneId && refreshPrRequestRef.current === requestId;
    try {
      let lanePrs: PrSummary[];
      if (typeof window.ade.prs.listAll === "function") {
        const allPrs = await window.ade.prs.listAll(runtimePinRef.current);
        const ownedPrs = allPrs.filter((pr) => pr.laneId === laneId && !pr.detached);
        lanePrs = selectPrsForChat(ownedPrs, sessionId);
      } else {
        // Older web-preview/test bridges only expose the original single-PR
        // lookup. Keep that compatibility path while the desktop bridge rolls
        // forward to the plural list.
        const legacy = await window.ade.prs.getForLane(laneId, runtimePinRef.current);
        lanePrs = legacy ? [legacy] : [];
      }
      const pr = selectPrimaryLanePr(laneForPr, lanePrs) ?? lanePrs[0] ?? null;
      if (!requestIsCurrent()) return null;
      setLinkedPrs(lanePrs);
      setLinkedPr(pr);
      setPrLoaded(true);
      if (options.live && pr && !pr.unmapped) {
        try {
          const refreshed = await refreshLinkedPrCoalesced(pr, { projectRoot, pin: runtimePinRef.current });
          if (!requestIsCurrent()) return null;
          if (!refreshed) return pr;
          const enriched = refreshed.chatSessionIds || !pr.chatSessionIds
            ? refreshed
            : { ...refreshed, chatSessionIds: pr.chatSessionIds };
          setLinkedPrs((current) => current.map((candidate) => candidate.id === enriched.id ? enriched : candidate));
          setLinkedPr(enriched);
          return enriched;
        } catch {
          return pr;
        }
      }
      return pr;
    } catch {
      if (requestIsCurrent()) {
        setLinkedPrs([]);
        setLinkedPr(null);
        setPrLoaded(true);
      }
      return null;
    }
    // `runtimePinKey` is read through `runtimePinRef`, so the linter cannot see
    // it — but a callback that reads machine A must not be reused as if it reads
    // machine B, and its identity is what re-runs the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneForPr, laneId, projectRoot, runtimePinKey, sessionId]);

  useEffect(() => {
    setDirtyCount(0);
    setLinkedPrs([]);
    setLinkedPr(null);
    setPrLoaded(false);
    setPrMenuOpen(false);
    setPrChecks(null);
    // `diff.getChanges` is not pinned, so for a lane on another machine it can
    // only ask the bound machine about a lane it does not have. Skip it.
    if (!isRemoteProject && !runtimePinKey) void refreshStatus();
    void refreshPr();
  }, [isRemoteProject, refreshStatus, refreshPr, runtimePinKey]);

  // Re-poll after the runtime finishes an action (from either pane or toolbar)
  const prevBusy = React.useRef(runtime.busyAction);
  useEffect(() => {
    if (prevBusy.current && !runtime.busyAction) {
      if (!isRemoteProject && !runtimePinKey) void refreshStatus();
      void refreshPr();
    }
    prevBusy.current = runtime.busyAction;
  }, [isRemoteProject, runtime.busyAction, refreshStatus, refreshPr, runtimePinKey]);

  // Backend reconcile-on-focus, in its OWN subscription keyed only on stable
  // deps (laneId/projectRoot via refreshPr) — NOT linkedPr, so the idle branch's
  // own refreshPr() can't re-run and tear down this subscription mid-reconcile.
  // The visible ⟳ affordance and its spin/debounce state now live in
  // ChatPrPane's title bar; the header only needs the heal-the-pill re-read.
  useEffect(() => {
    const unsubscribe = window.ade.prs.onEvent((event) => {
      if (event.type !== "pr-reconcile") return;
      if (event.state === "running") return;
      // A reconcile just healed backend state — re-read the linked PR.
      void refreshPr();
    }, runtimePinRef.current);
    return () => {
      unsubscribe();
    };
  }, [refreshPr, runtimePinKey]);

  // Subscribe to backend PR events so the linked-PR pill reflects external
  // changes (PR closed, merged, checks finished, etc.) without a manual refresh.
  useEffect(() => {
    const unsubscribe = window.ade.prs.onEvent((event) => {
      const current = linkedPrRef.current;
      if (event.type === "pr-notification") {
        if (event.laneId === laneId || event.prId === current?.id) void refreshPr();
        return;
      }
      if (event.type !== "prs-updated") return;
      const eventIncludesLanePr = event.prs.some((pr) => (
        pr.laneId === laneId && (
          !sessionId
          || !pr.chatSessionIds?.length
          || pr.chatSessionIds.includes(sessionId)
        )
      ));
      const eventIncludesLinkedPr = current ? event.prs.some((pr) => pr.id === current.id) : false;
      if (eventIncludesLanePr || eventIncludesLinkedPr) {
        void refreshPr();
      } else if (current) {
        // The linked PR vanished from the latest snapshot — clear the pill.
        setLinkedPrs([]);
        setLinkedPr(null);
      }
    }, runtimePinRef.current);
    return () => {
      unsubscribe();
    };
  }, [laneId, refreshPr, runtimePinKey, sessionId]);

  const openPr = useCallback((pr: PrSummary) => {
    // The PRs tab resolves a PR id against the bound machine only, so a lane
    // on another machine goes to GitHub — the one destination that means the
    // same thing from either machine. The local branch keeps this surface's
    // richer route (it also selects the lane), so it passes its own path.
    openLanePr(pr, {
      foreign: Boolean(runtimePin),
      navigate,
      localPath: `/prs${buildPrsRouteSearch({
        activeTab: "normal",
        selectedPrId: pr.id,
        selectedLaneId: laneId,
        selectedRebaseItemId: null,
      })}`,
    });
  }, [laneId, navigate, runtimePin]);

  const handlePr = useCallback(async () => {
    // A PR operation is about to run against this worktree — arm the drift
    // warning strip so a wrong-branch PR is caught before it is opened.
    armLaneBranchDriftWarning(laneId);
    if (linkedPr) {
      openPr(linkedPr);
      return;
    }

    if (!prLoaded) {
      setPrActionBusy(true);
      const latestPr = await refreshPr().finally(() => setPrActionBusy(false));
      if (latestPr) {
        openPr(latestPr);
        return;
      }
    }

    // Creating a PR is a write against the lane's worktree and the create form
    // derives its branches from the bound machine's lanes, so it is offered only
    // on the machine that owns the lane. Reading one is not so restricted.
    if (runtimePin) return;

    const params = new URLSearchParams({
      tab: "normal",
      create: "1",
      sourceLaneId: laneId,
      target: "primary",
    });
    navigate(`/prs?${params.toString()}`);
  }, [laneId, linkedPr, openPr, prLoaded, refreshPr, runtimePin]);

  const handlePrClick = useCallback(() => {
    if (prActionBusy) return;
    void handlePr();
  }, [handlePr, prActionBusy]);

  // Reset menu state when the linked PR identity changes (lane switch, PR
  // unlinked) so stale data from another PR doesn't show.
  const linkedPrId = linkedPr?.id ?? null;
  useEffect(() => {
    setPrMenuOpen(false);
    setPrChecks(null);
  }, [linkedPrId]);

  useEffect(() => {
    if (!linkedPrId) return;
    if (!prPaneOpen && !prMenuOpen) return;
    void refreshPr({ live: true });
  }, [linkedPrId, prMenuOpen, prPaneOpen, refreshPr]);

  // Fetch live check details when the PR menu opens. Lazy: only fetched while
  // the menu is open so closed-state idles cost zero.
  useEffect(() => {
    if (!prMenuOpen || !linkedPr || linkedPr.unmapped) return;
    let cancelled = false;
    setPrChecksLoading(true);
    window.ade.prs.getChecks(linkedPr.id, runtimePinRef.current)
      .then((checks) => {
        if (!cancelled) setPrChecks(checks);
      })
      .catch(() => {
        if (!cancelled) setPrChecks(null);
      })
      .finally(() => {
        if (!cancelled) setPrChecksLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [prMenuOpen, linkedPr, runtimePinKey]);

  // Reset the copy-confirmed checkmark a moment after it's shown.
  useEffect(() => {
    if (!copyConfirmed) return;
    const id = window.setTimeout(() => setCopyConfirmed(false), 1500);
    return () => window.clearTimeout(id);
  }, [copyConfirmed]);

  const handleOpenInAde = useCallback(() => {
    if (!linkedPr) return;
    setPrMenuOpen(false);
    // Same rule as the pill: a PR id only resolves on the machine that owns it.
    openLanePr(linkedPr, { foreign: Boolean(runtimePin), navigate });
  }, [linkedPr, navigate, runtimePin]);

  const handleOpenInGitHub = useCallback(async () => {
    if (!linkedPr) return;
    try {
      await window.ade.app.openExternal(linkedPr.githubUrl);
    } catch {
      // Best-effort fallback: let the OS handle the URL directly.
      try { window.open(linkedPr.githubUrl, "_blank", "noopener,noreferrer"); } catch { /* noop */ }
    }
  }, [linkedPr]);

  const handleCopyLink = useCallback(async () => {
    if (!linkedPr) return;
    try {
      await navigator.clipboard.writeText(linkedPr.githubUrl);
      setCopyConfirmed(true);
    } catch {
      /* clipboard denied; surface a notice another time */
    }
  }, [linkedPr]);

  const isBusy = Boolean(runtime.busyAction) || prActionBusy;

  // -----------------------------------------------------------------------
  // PR badge
  // -----------------------------------------------------------------------

  // When the chat surface owns a PR floating pane, the pill reflects + toggles
  // the pane; otherwise it drives the inline slide-out menu.
  // Set only when the create affordance cannot do anything: a lane on another
  // machine, on a surface whose PR pane (which explains the same thing) is
  // absent. With a pane present the click opens it and the pane speaks.
  const createBlockedReason = runtimePin && !linkedPr && !onTogglePrPane
    ? `Switch to ${runtimePin.kind === "remote" ? runtimePin.runtimeName : "this lane's machine"} to open a pull request for it.`
    : null;
  const prPillActive = onTogglePrPane ? Boolean(prPaneOpen) : prMenuOpen;
  const prBadge = useMemo(() => {
    if (!linkedPr) return null;
    const allPrs = linkedPrs.length > 0 ? linkedPrs : [linkedPr];
    const label = formatPrBadgeLabel(linkedPr);
    return (
      <div className="group relative inline-flex items-center gap-1">
        <button
          type="button"
          className={cn(btnBase, "gap-1.5", prPillActive && "border-violet-400/25 bg-violet-500/[0.08] text-fg/80")}
          onClick={() => {
            if (onTogglePrPane) { onTogglePrPane(); return; }
            setPrMenuOpen((open) => !open);
          }}
          aria-expanded={prPillActive}
          aria-haspopup="menu"
          title={`${label}: ${linkedPr.title}`}
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: lanePrAttentionColor(lanePrAggregateAttention(allPrs)) }} />
          <span>{label}</span>
          <GitHubStackBadge stack={linkedPr.stack} compact bare />
          {checksIcon(linkedPr.checksStatus, linkedPr.state)}
          <CaretRight
            size={9}
            weight="bold"
            className={cn("text-fg/35 transition-transform duration-150", prPillActive && "rotate-90 text-fg/65")}
          />
        </button>
        {allPrs.length > 1 ? (
          <button
            type="button"
            className={cn(btnBase, "px-1.5 font-mono text-[9px] tabular-nums")}
            onClick={() => {
              if (runtimePin) {
                // The local PR tab cannot resolve a foreign machine's rows.
                // The hover list still exposes every PR; the counter opens the
                // owning machine's primary PR instead of a misleading empty tab.
                openPr(linkedPr);
                return;
              }
              navigate(`/prs${buildPrsRouteSearch({
                activeTab: "normal",
                selectedPrId: null,
                selectedLaneId: laneId,
                selectedRebaseItemId: null,
              })}`);
            }}
            title={runtimePin
              ? "Open the primary pull request on its owning machine; hover for all"
              : `Show all ${allPrs.length} pull requests for this lane`}
            aria-label={runtimePin
              ? "Open the primary pull request on its owning machine"
              : `Show all ${allPrs.length} pull requests for this lane`}
          >
            +{allPrs.length - 1}
          </button>
        ) : null}
        {allPrs.length > 1 ? (
          <div className="pointer-events-none invisible absolute right-0 top-full z-[90] w-[280px] pt-2 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:visible group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:visible group-focus-within:opacity-100">
            <div className="rounded-lg border border-white/[0.10] bg-[#17171b] p-1.5 shadow-2xl shadow-black/30">
              <div className="px-2 pb-1.5 pt-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-fg/45">Pull requests · {allPrs.length}</div>
              {allPrs.map((candidate) => (
                <button
                  type="button"
                  key={candidate.id}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.06]"
                  onClick={() => openPr(candidate)}
                  title={candidate.title || `PR #${candidate.githubPrNumber}`}
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: lanePrAttentionColor(lanePrAggregateAttention([candidate])) }} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[10px] font-semibold text-fg/80">
                      <span className="font-mono">#{candidate.githubPrNumber}</span>
                      <span className="text-fg/55">{candidate.state}</span>
                    </span>
                    <span className="block truncate text-[9px] text-muted-fg/55">{candidate.title || "Untitled pull request"}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1" aria-label={`CI ${candidate.checksStatus}; review ${candidate.reviewStatus}`}>
                    <span className={cn("h-1.5 w-1.5 rounded-full", candidate.checksStatus === "failing" ? "bg-red-400" : candidate.checksStatus === "passing" ? "bg-emerald-400" : "bg-fg/25")} />
                    <span className={cn("h-1.5 w-1.5 rounded-full", candidate.reviewStatus === "changes_requested" ? "bg-red-400" : candidate.reviewStatus === "approved" ? "bg-emerald-400" : candidate.reviewStatus === "requested" ? "bg-amber-400" : "bg-fg/25")} />
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    );
  }, [laneId, linkedPr, linkedPrs, navigate, onTogglePrPane, openPr, prPillActive]);

  // Slide-out panel that appears to the right of the PR badge when toggled.
  const prMenu = useMemo(() => {
    if (!linkedPr) return null;
    const summary = prChecks ? summarizeChecks(prChecks) : null;
    const updatedRelative = formatRelativeTime(linkedPr.updatedAt);
    return (
      <motion.div
        key="pr-menu"
        className="flex items-center gap-1 overflow-hidden"
        initial={{ width: 0, opacity: 0 }}
        animate={{ width: "auto", opacity: 1 }}
        exit={{ width: 0, opacity: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
      >
        {/* Action buttons */}
        <button
          type="button"
          className={cn(btnBase, "gap-1")}
          onClick={handleOpenInAde}
          title="Open PR in ADE"
        >
          <GitPullRequest size={10} weight="bold" />
          <span>ADE</span>
        </button>
        <button
          type="button"
          className={cn(btnBase, "gap-1")}
          onClick={() => void handleOpenInGitHub()}
          title="Open PR on GitHub"
        >
          <GithubLogo size={10} weight="bold" />
          <span>GitHub</span>
        </button>
        <button
          type="button"
          className={cn(btnBase, "gap-1", copyConfirmed && "border-emerald-400/25 bg-emerald-500/[0.06] text-emerald-300/80")}
          onClick={() => void handleCopyLink()}
          title="Copy PR link"
        >
          {copyConfirmed ? <Check size={10} weight="bold" /> : <Copy size={10} weight="bold" />}
          <span>{copyConfirmed ? "Copied" : "Copy"}</span>
        </button>

        {/* Vertical separator */}
        <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-white/[0.08]" />

        {/* Live status preview */}
        <div className="flex items-center gap-2 whitespace-nowrap rounded-lg border border-white/[0.04] bg-white/[0.015] px-2.5 py-1 font-mono text-[10px] text-fg/55">
          {prChecksLoading && !prChecks ? (
            <span className="inline-flex items-center gap-1 text-fg/35">
              <CircleNotch size={9} className="animate-spin" />
              <span>checking</span>
            </span>
          ) : summary && summary.total > 0 ? (
            <span className="inline-flex items-center gap-2">
              {summary.passed > 0 ? (
                <span className="inline-flex items-center gap-1 text-emerald-300/80">
                  <CheckCircle size={9} weight="fill" />
                  {summary.passed}
                </span>
              ) : null}
              {summary.failed > 0 ? (
                <span className="inline-flex items-center gap-1 text-red-300/85">
                  <XCircle size={9} weight="fill" />
                  {summary.failed}
                </span>
              ) : null}
              {summary.running > 0 ? (
                <span className="inline-flex items-center gap-1 text-amber-300/80">
                  <Clock size={9} weight="fill" />
                  {summary.running}
                </span>
              ) : null}
              {summary.skipped > 0 && summary.status !== "not_run" ? (
                // Previously folded into `passed`, so a 3-pass/2-skip PR read
                // "5". Shown in its own muted bucket rather than silently
                // dropped, which would under-report the suite instead.
                <span className="inline-flex items-center gap-1 text-fg/35">
                  <MinusCircle size={9} weight="fill" />
                  {summary.skipped}
                </span>
              ) : null}
              {summary.status === "not_run" ? (
                // Nothing verified this commit — either every row was skipped,
                // or the only reporters were preview/review bots. Say so rather
                // than showing a bare count that reads as merely neutral.
                <span className="text-fg/35" title="No CI has run on this commit.">
                  {`not run · ${summary.total} check${summary.total === 1 ? "" : "s"}`}
                </span>
              ) : null}
            </span>
          ) : (
            <span className="text-fg/35">no checks</span>
          )}
          {linkedPr.additions > 0 || linkedPr.deletions > 0 ? (
            <>
              <span aria-hidden className="text-fg/15">·</span>
              <span className="inline-flex items-center gap-1">
                <span className="text-emerald-400/55">+{linkedPr.additions}</span>
                <span className="text-red-400/55">−{linkedPr.deletions}</span>
              </span>
            </>
          ) : null}
          {updatedRelative ? (
            <>
              <span aria-hidden className="text-fg/15">·</span>
              <span className="text-fg/45">{updatedRelative}</span>
            </>
          ) : null}
        </div>
      </motion.div>
    );
  }, [linkedPr, prChecks, prChecksLoading, copyConfirmed, handleOpenInAde, handleOpenInGitHub, handleCopyLink]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="flex items-center gap-1.5">
      {/* Files-changed (dirty count) badge intentionally removed from the header —
          the Git actions pane in the Tools sidebar already surfaces this. */}

      {/* PR badge or create button. When the badge is open it expands into a
          slide-out with action buttons + live PR status preview. */}
      {prBadge ? (
        <div className="flex items-center gap-1.5">
          {prBadge}
          <AnimatePresence initial={false}>
            {prMenuOpen ? prMenu : null}
          </AnimatePresence>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className={cn(btnBase, onTogglePrPane && prPaneOpen && "border-violet-400/25 bg-violet-500/[0.08] text-fg/80")}
            onClick={() => {
              armLaneBranchDriftWarning(laneId);
              if (onTogglePrPane) onTogglePrPane();
              else void handlePr();
            }}
            disabled={isBusy || createBlockedReason !== null}
            title={createBlockedReason ?? undefined}
          >
            <GitPullRequest size={10} weight="bold" />
            <span>PR</span>
          </button>
        </div>
      )}

      {/* Runtime notice / error (synced with git actions pane) */}
      <AnimatePresence>
        {runtime.error ? (
          <motion.span
            key="error"
            className="max-w-[180px] truncate font-mono text-[9px] text-red-400/80"
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -4 }}
            transition={{ duration: 0.15 }}
          >
            {runtime.error}
          </motion.span>
        ) : runtime.notice ? (
          <motion.span
            key="notice"
            className="max-w-[180px] truncate font-mono text-[9px] text-emerald-400/60"
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -4 }}
            transition={{ duration: 0.15 }}
          >
            {runtime.notice}
          </motion.span>
        ) : null}
      </AnimatePresence>
    </div>
  );
});

const btnBase =
  "inline-flex items-center gap-1 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-0.5 font-sans text-[10px] font-medium text-fg/50 transition-all hover:border-violet-400/15 hover:bg-violet-500/[0.04] hover:text-fg/80 disabled:pointer-events-none disabled:opacity-40";

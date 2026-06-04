import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  GitPullRequest,
  CircleNotch,
  CheckCircle,
  XCircle,
  Clock,
  CaretRight,
  GithubLogo,
  Copy,
  Check,
} from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "../ui/cn";
import type { DiffChanges, PrSummary, PrCheck } from "../../../shared/types";
import { useLaneGitActionRuntimeState } from "../lanes/LaneGitActionsPane";
import { formatPrBadgeLabel } from "../prs/shared/prFormatters";
import { useAppStore } from "../../state/appStore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ChatGitToolbarProps = {
  laneId: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dirtyFileCount(changes: DiffChanges): number {
  return changes.staged.length + changes.unstaged.length;
}

function checksIcon(status: PrSummary["checksStatus"]) {
  switch (status) {
    case "passing":
      return <CheckCircle size={10} weight="fill" className="text-emerald-400/80" />;
    case "failing":
      return <XCircle size={10} weight="fill" className="text-red-400/80" />;
    case "pending":
      return <Clock size={10} weight="fill" className="text-amber-400/80 animate-pulse" />;
    default:
      return null;
  }
}

function prStateDot(state: PrSummary["state"]) {
  switch (state) {
    case "open":
      return "bg-emerald-400";
    case "draft":
      return "bg-amber-400/60";
    case "merged":
      return "bg-violet-400";
    case "closed":
      return "bg-red-400/60";
    default:
      return "bg-fg/20";
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

function summarizeChecks(checks: PrCheck[]): { passed: number; failed: number; running: number; total: number } {
  let passed = 0;
  let failed = 0;
  let running = 0;
  for (const c of checks) {
    if (c.status !== "completed") {
      running += 1;
    } else if (c.conclusion === "success" || c.conclusion === "neutral" || c.conclusion === "skipped") {
      passed += 1;
    } else if (c.conclusion === "failure" || c.conclusion === "cancelled") {
      failed += 1;
    }
  }
  return { passed, failed, running, total: checks.length };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ChatGitToolbar = React.memo(function ChatGitToolbar({
  laneId,
}: ChatGitToolbarProps) {
  const navigate = useNavigate();
  const runtime = useLaneGitActionRuntimeState(laneId);
  const isRemoteProject = useAppStore((s) => s.projectBinding?.kind === "remote");

  const [dirtyCount, setDirtyCount] = useState(0);
  const [linkedPr, setLinkedPr] = useState<PrSummary | null>(null);
  const [prLoaded, setPrLoaded] = useState(false);
  const [prActionBusy, setPrActionBusy] = useState(false);
  const [prMenuOpen, setPrMenuOpen] = useState(false);
  const [prChecks, setPrChecks] = useState<PrCheck[] | null>(null);
  const [prChecksLoading, setPrChecksLoading] = useState(false);
  const [copyConfirmed, setCopyConfirmed] = useState(false);

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

  const refreshPr = useCallback(async () => {
    try {
      const pr = await window.ade.prs.getForLane(laneId);
      setLinkedPr(pr);
      setPrLoaded(true);
      return pr;
    } catch {
      setLinkedPr(null);
      setPrLoaded(true);
      return null;
    }
  }, [laneId]);

  useEffect(() => {
    setDirtyCount(0);
    setLinkedPr(null);
    setPrLoaded(false);
    setPrMenuOpen(false);
    setPrChecks(null);
    if (isRemoteProject) return;
    void refreshStatus();
    void refreshPr();
  }, [isRemoteProject, refreshStatus, refreshPr]);

  // Re-poll after the runtime finishes an action (from either pane or toolbar)
  const prevBusy = React.useRef(runtime.busyAction);
  useEffect(() => {
    if (prevBusy.current && !runtime.busyAction) {
      if (isRemoteProject && !prLoaded) {
        prevBusy.current = runtime.busyAction;
        return;
      }
      void refreshStatus();
      void refreshPr();
    }
    prevBusy.current = runtime.busyAction;
  }, [isRemoteProject, prLoaded, runtime.busyAction, refreshStatus, refreshPr]);

  // Subscribe to backend PR events so the linked-PR pill reflects external
  // changes (PR closed, merged, checks finished, etc.) without a manual refresh.
  useEffect(() => {
    const unsubscribe = window.ade.prs.onEvent((event) => {
      if (event.type !== "prs-updated") return;
      // Only re-fetch when an update could plausibly touch this lane's PR.
      if (event.prs.some((pr) => pr.laneId === laneId)) {
        if (isRemoteProject && !prLoaded && !linkedPr) return;
        void refreshPr();
      } else if (linkedPr && !event.prs.some((pr) => pr.id === linkedPr.id)) {
        // The linked PR vanished from the latest snapshot — clear the pill.
        setLinkedPr(null);
      }
    });
    return unsubscribe;
  }, [isRemoteProject, laneId, linkedPr, prLoaded, refreshPr]);

  const handlePr = useCallback(async () => {
    if (linkedPr) {
      navigate(`/prs?tab=normal&prId=${encodeURIComponent(linkedPr.id)}`);
      return;
    }

    if (!prLoaded) {
      setPrActionBusy(true);
      const latestPr = await refreshPr().finally(() => setPrActionBusy(false));
      if (latestPr) {
        navigate(`/prs?tab=normal&prId=${encodeURIComponent(latestPr.id)}`);
        return;
      }
    }

    const params = new URLSearchParams({
      tab: "normal",
      create: "1",
      sourceLaneId: laneId,
      target: "primary",
    });
    navigate(`/prs?${params.toString()}`);
  }, [laneId, linkedPr, navigate, prLoaded, refreshPr]);

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

  // Fetch live check details when the PR menu opens. Lazy: only fetched while
  // the menu is open so closed-state idles cost zero.
  useEffect(() => {
    if (!prMenuOpen || !linkedPr) return;
    let cancelled = false;
    setPrChecksLoading(true);
    window.ade.prs.getChecks(linkedPr.id)
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
  }, [prMenuOpen, linkedPr]);

  // Reset the copy-confirmed checkmark a moment after it's shown.
  useEffect(() => {
    if (!copyConfirmed) return;
    const id = window.setTimeout(() => setCopyConfirmed(false), 1500);
    return () => window.clearTimeout(id);
  }, [copyConfirmed]);

  const handleOpenInAde = useCallback(() => {
    if (!linkedPr) return;
    setPrMenuOpen(false);
    navigate(`/prs?tab=normal&prId=${encodeURIComponent(linkedPr.id)}`);
  }, [linkedPr, navigate]);

  const handleOpenInGitHub = useCallback(async () => {
    if (!linkedPr) return;
    try {
      await window.ade.prs.openInGitHub(linkedPr.id);
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

  const prBadge = useMemo(() => {
    if (!linkedPr) return null;
    const label = formatPrBadgeLabel(linkedPr);
    return (
      <button
        type="button"
        className={cn(btnBase, "gap-1.5", prMenuOpen && "border-violet-400/25 bg-violet-500/[0.08] text-fg/80")}
        onClick={() => setPrMenuOpen((open) => !open)}
        aria-expanded={prMenuOpen}
        aria-haspopup="menu"
        title={`${label}: ${linkedPr.title}`}
      >
        <span className={cn("inline-block h-1.5 w-1.5 rounded-full", prStateDot(linkedPr.state))} />
        <span>{label}</span>
        {checksIcon(linkedPr.checksStatus)}
        <CaretRight
          size={9}
          weight="bold"
          className={cn("text-fg/35 transition-transform duration-150", prMenuOpen && "rotate-90 text-fg/65")}
        />
      </button>
    );
  }, [linkedPr, prMenuOpen]);

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
              {summary.passed === 0 && summary.failed === 0 && summary.running === 0 ? (
                <span className="text-fg/35">{summary.total} check{summary.total === 1 ? "" : "s"}</span>
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
      {/* Dirty count badge */}
      {dirtyCount > 0 ? (
        <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 font-mono text-[9px] font-bold bg-amber-500/15 text-amber-300/80">
          {dirtyCount}
        </span>
      ) : null}

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
        <button type="button" className={cn(btnBase)} onClick={handlePrClick} disabled={isBusy}>
          <GitPullRequest size={10} weight="bold" />
          <span>PR</span>
        </button>
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

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  GitBranch,
  GitCommit,
  ArrowUp,
  GitPullRequest,
  Sparkle,
  CircleNotch,
  CheckCircle,
  XCircle,
  Clock,
} from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "../ui/cn";
import type { DiffChanges, GitBranchSummary, PrSummary } from "../../../shared/types";
import {
  beginLaneGitActionRuntime,
  patchLaneGitActionRuntimeStateIfCurrent,
  scheduleLaneGitActionRuntimeClear,
  useLaneGitActionRuntimeState,
} from "../lanes/LaneGitActionsPane";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ChatGitToolbarProps = {
  laneId: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentBranchName(branches: GitBranchSummary[]): string | null {
  const current = branches.find((b) => b.isCurrent && !b.isRemote);
  return current?.name ?? null;
}

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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ChatGitToolbar = React.memo(function ChatGitToolbar({
  laneId,
}: ChatGitToolbarProps) {
  const navigate = useNavigate();
  const runtime = useLaneGitActionRuntimeState(laneId);

  const [branch, setBranch] = useState<string | null>(null);
  const [dirtyCount, setDirtyCount] = useState(0);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [linkedPr, setLinkedPr] = useState<PrSummary | null>(null);

  // -----------------------------------------------------------------------
  // Refresh git status + PR link
  // -----------------------------------------------------------------------

  const refreshStatus = useCallback(async () => {
    try {
      const [branches, changes] = await Promise.all([
        window.ade.git.listBranches({ laneId }),
        window.ade.diff.getChanges({ laneId }),
      ]);
      setBranch(currentBranchName(branches));
      setDirtyCount(dirtyFileCount(changes));
    } catch {
      // best-effort
    }
  }, [laneId]);

  const refreshPr = useCallback(async () => {
    try {
      const pr = await window.ade.prs.getForLane(laneId);
      setLinkedPr(pr);
    } catch {
      setLinkedPr(null);
    }
  }, [laneId]);

  useEffect(() => {
    void refreshStatus();
    void refreshPr();
  }, [refreshStatus, refreshPr]);

  // Re-poll after the runtime finishes an action (from either pane or toolbar)
  const prevBusy = React.useRef(runtime.busyAction);
  useEffect(() => {
    if (prevBusy.current && !runtime.busyAction) {
      void refreshStatus();
      void refreshPr();
    }
    prevBusy.current = runtime.busyAction;
  }, [runtime.busyAction, refreshStatus, refreshPr]);

  // -----------------------------------------------------------------------
  // Shared action wrapper — mirrors LaneGitActionsPane.runAction
  // -----------------------------------------------------------------------

  const runAction = useCallback(
    async (actionName: string, fn: () => Promise<void>) => {
      const v = beginLaneGitActionRuntime(laneId, {
        busyAction: actionName,
        notice: null,
        error: null,
      });
      try {
        await fn();
        patchLaneGitActionRuntimeStateIfCurrent(laneId, v, {
          busyAction: null,
          notice: `${actionName} completed`,
          error: null,
        });
        scheduleLaneGitActionRuntimeClear(laneId, v, 3_000, { notice: null });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        patchLaneGitActionRuntimeStateIfCurrent(laneId, v, {
          busyAction: null,
          notice: null,
          error: `${actionName} failed: ${message}`,
        });
      }
    },
    [laneId],
  );

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  const handleGenerateMessage = useCallback(async () => {
    const v = beginLaneGitActionRuntime(laneId, {
      busyAction: "Generating message",
      notice: null,
      error: null,
    });
    try {
      const result = await window.ade.git.generateCommitMessage({ laneId });
      setCommitMsg(result.message);
      patchLaneGitActionRuntimeStateIfCurrent(laneId, v, {
        busyAction: null,
        notice: null,
        error: null,
      });
    } catch (err: unknown) {
      patchLaneGitActionRuntimeStateIfCurrent(laneId, v, {
        busyAction: null,
        notice: null,
        error: err instanceof Error ? err.message : "Failed to generate message",
      });
    }
  }, [laneId]);

  const handleCommit = useCallback(async () => {
    const msg = commitMsg.trim();
    if (!msg) return;
    await runAction("Commit", async () => {
      const changes = await window.ade.diff.getChanges({ laneId });
      const unstaged = changes.unstaged.map((f) => f.path);
      if (unstaged.length > 0) {
        await window.ade.git.stageAll({ laneId, paths: unstaged });
      }
      await window.ade.git.commit({ laneId, message: msg });
      setCommitMsg("");
      setCommitOpen(false);
    });
  }, [laneId, commitMsg, runAction]);

  const handlePush = useCallback(async () => {
    await runAction("Push", async () => {
      await window.ade.git.push({ laneId });
    });
  }, [laneId, runAction]);

  const handlePr = useCallback(() => {
    if (linkedPr) {
      navigate(`/prs?tab=normal&prId=${encodeURIComponent(linkedPr.id)}`);
    } else {
      navigate("/prs");
    }
  }, [linkedPr, navigate]);

  const handleCommitKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleCommit();
      } else if (e.key === "Escape") {
        setCommitOpen(false);
        setCommitMsg("");
      }
    },
    [handleCommit],
  );

  const isBusy = Boolean(runtime.busyAction);

  // -----------------------------------------------------------------------
  // PR badge
  // -----------------------------------------------------------------------

  const prBadge = useMemo(() => {
    if (!linkedPr) return null;
    return (
      <button
        type="button"
        className={cn(btnBase, "gap-1.5")}
        onClick={handlePr}
        title={`${linkedPr.title} — ${linkedPr.state}`}
      >
        <span className={cn("inline-block h-1.5 w-1.5 rounded-full", prStateDot(linkedPr.state))} />
        <span>#{linkedPr.githubPrNumber}</span>
        {checksIcon(linkedPr.checksStatus)}
      </button>
    );
  }, [linkedPr, handlePr]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="flex items-center gap-1.5">
      {/* Branch name */}
      {branch ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-white/[0.06] px-2 py-0.5 font-mono text-[10px] text-fg/45">
          <GitBranch size={10} weight="bold" className="shrink-0 text-fg/35" />
          <span className="max-w-[120px] truncate">{branch}</span>
        </span>
      ) : null}

      {/* Dirty count badge */}
      {dirtyCount > 0 ? (
        <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 font-mono text-[9px] font-bold bg-amber-500/15 text-amber-300/80">
          {dirtyCount}
        </span>
      ) : null}

      {/* Commit button / inline input */}
      <AnimatePresence mode="wait">
        {commitOpen ? (
          <motion.div
            key="commit-input"
            className="flex items-center gap-1"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: "auto", opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
          >
            <input
              type="text"
              autoFocus
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              onKeyDown={handleCommitKeyDown}
              placeholder="Commit message..."
              className="h-[22px] w-[160px] rounded-full border border-white/[0.08] bg-white/[0.03] px-2 font-mono text-[10px] text-fg/70 placeholder:text-fg/25 outline-none focus:border-white/[0.14]"
              disabled={isBusy}
            />
            <button
              type="button"
              className={cn(btnBase, "px-1.5")}
              title="Generate commit message with AI"
              onClick={() => void handleGenerateMessage()}
              disabled={isBusy}
            >
              {runtime.busyAction === "Generating message" ? (
                <CircleNotch size={10} className="animate-spin" />
              ) : (
                <Sparkle size={10} weight="fill" />
              )}
            </button>
            <button
              type="button"
              className={cn(btnBase)}
              onClick={() => void handleCommit()}
              disabled={isBusy || !commitMsg.trim()}
            >
              {runtime.busyAction === "Commit" ? (
                <CircleNotch size={10} className="animate-spin" />
              ) : (
                <GitCommit size={10} weight="bold" />
              )}
              <span>Go</span>
            </button>
          </motion.div>
        ) : (
          <motion.button
            key="commit-btn"
            type="button"
            className={cn(btnBase)}
            onClick={() => setCommitOpen(true)}
            disabled={isBusy}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.1 }}
          >
            <GitCommit size={10} weight="bold" />
            <span>Commit</span>
          </motion.button>
        )}
      </AnimatePresence>

      {/* Push */}
      <button
        type="button"
        className={cn(btnBase)}
        onClick={() => void handlePush()}
        disabled={isBusy}
      >
        {runtime.busyAction === "Push" ? (
          <CircleNotch size={10} className="animate-spin" />
        ) : (
          <ArrowUp size={10} weight="bold" />
        )}
        <span>Push</span>
      </button>

      {/* PR badge or create button */}
      {prBadge ?? (
        <button type="button" className={cn(btnBase)} onClick={handlePr} disabled={isBusy}>
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
  "inline-flex items-center gap-1 rounded-full border border-white/[0.06] px-2 py-0.5 font-mono text-[10px] text-fg/50 transition-all hover:border-white/[0.12] hover:text-fg/75 disabled:pointer-events-none disabled:opacity-40";

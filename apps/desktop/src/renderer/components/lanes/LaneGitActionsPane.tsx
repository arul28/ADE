import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel } from "react-resizable-panels";
import {
  ArrowDown,
  Check,
  CaretDown,
  Stack,
  DotsThree,
  ArrowsClockwise,
  Upload
} from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";
import { COLORS, LABEL_STYLE, MONO_FONT, inlineBadge, outlineButton, primaryButton } from "./laneDesignTokens";
import { ResizeGutter } from "../ui/ResizeGutter";
import { CommitTimeline } from "./CommitTimeline";
import type {
  DiffChanges,
  FileChange,
  GitCommitSummary,
  GitRecommendedAction,
  GitStashSummary,
  GitSyncMode,
  GitUpstreamSyncStatus,
  AutoRebaseLaneStatus
} from "../../../shared/types";

type LaneTextPromptState = {
  title: string;
  message?: string;
  placeholder?: string;
  value: string;
  confirmLabel: string;
  validate?: (value: string) => string | null;
  resolve: (value: string | null) => void;
};

type NextActionHint = {
  action: GitRecommendedAction | "rebase_push";
  label: string;
  detail: string;
};

function formatRelativeTime(ts: string | null): string {
  if (!ts) return "unknown time";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

export function LaneGitActionsPane({
  laneId,
  autoRebaseEnabled,
  onOpenSettings,
  onRebaseNowLocal,
  onRebaseAndPush,
  onViewRebaseDetails,
  onResolveRebaseConflict,
  onSelectFile,
  onSelectCommit,
  selectedPath,
  selectedMode,
  selectedCommitSha
}: {
  laneId: string | null;
  autoRebaseEnabled: boolean;
  onOpenSettings: () => void;
  onRebaseNowLocal?: (laneId: string) => Promise<void> | void;
  onRebaseAndPush?: (laneId: string) => Promise<void> | void;
  onViewRebaseDetails?: () => void;
  onResolveRebaseConflict?: (laneId: string, parentLaneId: string | null) => void;
  onSelectFile: (path: string, mode: "staged" | "unstaged") => void;
  onSelectCommit: (commit: GitCommitSummary | null) => void;
  selectedPath: string | null;
  selectedMode: "staged" | "unstaged" | null;
  selectedCommitSha: string | null;
}) {
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);

  const lane = useMemo(() => lanes.find((entry) => entry.id === laneId) ?? null, [lanes, laneId]);

  const parentLane = useMemo(() => {
    if (!lane?.parentLaneId) return null;
    return lanes.find((l) => l.id === lane.parentLaneId) ?? null;
  }, [lanes, lane]);

  const originLabel = useMemo(() => {
    if (!lane) return null;
    if (lane.laneType === "primary") return null;
    if (parentLane) return `from ${parentLane.name}/${parentLane.branchRef}`;
    return `from primary/${lane.baseRef}`;
  }, [lane, parentLane]);

  const [loading, setLoading] = useState(false);
  const [changes, setChanges] = useState<DiffChanges>({ unstaged: [], staged: [] });
  const [commitMessage, setCommitMessage] = useState("");
  const [syncMode, setSyncMode] = useState<GitSyncMode>("merge");
  const [stashes, setStashes] = useState<GitStashSummary[]>([]);
  const [recentCommits, setRecentCommits] = useState<GitCommitSummary[]>([]);
  const [syncStatus, setSyncStatus] = useState<GitUpstreamSyncStatus | null>(null);
  const [forcePushSuggested, setForcePushSuggested] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [textPrompt, setTextPrompt] = useState<LaneTextPromptState | null>(null);
  const [textPromptError, setTextPromptError] = useState<string | null>(null);
  const [commitTimelineKey, setCommitTimelineKey] = useState(0);
  const [pullDropdownOpen, setPullDropdownOpen] = useState(false);
  const [pushDropdownOpen, setPushDropdownOpen] = useState(false);
  const [moreDropdownOpen, setMoreDropdownOpen] = useState(false);
  const [showStashes, setShowStashes] = useState(true);
  const [amendCommit, setAmendCommit] = useState(false);
  const [autoRebaseStatus, setAutoRebaseStatus] = useState<AutoRebaseLaneStatus | null>(null);
  const pullDropdownRef = useRef<HTMLDivElement>(null);
  const pushDropdownRef = useRef<HTMLDivElement>(null);
  const moreDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (pullDropdownRef.current && !pullDropdownRef.current.contains(e.target as Node)) {
        setPullDropdownOpen(false);
      }
      if (pushDropdownRef.current && !pushDropdownRef.current.contains(e.target as Node)) {
        setPushDropdownOpen(false);
      }
      if (moreDropdownRef.current && !moreDropdownRef.current.contains(e.target as Node)) {
        setMoreDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const requestTextInput = useCallback(
    (args: {
      title: string;
      message?: string;
      placeholder?: string;
      defaultValue?: string;
      confirmLabel?: string;
      validate?: (value: string) => string | null;
    }): Promise<string | null> => {
      return new Promise((resolve) => {
        setTextPromptError(null);
        setTextPrompt({
          title: args.title,
          message: args.message,
          placeholder: args.placeholder,
          value: args.defaultValue ?? "",
          confirmLabel: args.confirmLabel ?? "Confirm",
          validate: args.validate,
          resolve
        });
      });
    },
    []
  );

  const cancelTextPrompt = useCallback(() => {
    setTextPrompt((prev) => {
      if (prev) prev.resolve(null);
      return null;
    });
    setTextPromptError(null);
  }, []);

  const submitTextPrompt = useCallback(() => {
    setTextPrompt((prev) => {
      if (!prev) return prev;
      const value = prev.value.trim();
      const validationError = prev.validate?.(value) ?? null;
      if (validationError) {
        setTextPromptError(validationError);
        return prev;
      }
      setTextPromptError(null);
      prev.resolve(value);
      return null;
    });
  }, []);

  const refreshChanges = async () => {
    if (!laneId) return;
    setLoading(true);
    try {
      const next = await window.ade.diff.getChanges({ laneId });
      setChanges(next);
    } finally {
      setLoading(false);
    }
  };

  const refreshGitMeta = async () => {
    if (!laneId) return;
    const [stashesResult, commitsResult, syncStatusResult] = await Promise.allSettled([
      window.ade.git.stashList({ laneId }),
      window.ade.git.listRecentCommits({ laneId, limit: 20 }),
      window.ade.git.getSyncStatus({ laneId })
    ]);
    if (stashesResult.status === "fulfilled") {
      setStashes(stashesResult.value);
    }
    if (commitsResult.status === "fulfilled") {
      setRecentCommits(commitsResult.value);
    }
    if (syncStatusResult.status === "fulfilled") {
      setSyncStatus(syncStatusResult.value);
    } else {
      // Avoid leaving stale "next action" guidance visible when sync refresh fails.
      setSyncStatus(null);
    }
  };

  const refreshAll = async (options?: { fetchRemote?: boolean }) => {
    if (laneId && options?.fetchRemote) {
      try {
        await window.ade.git.fetch({ laneId });
      } catch {
        // best effort
      }
    }
    await Promise.all([refreshChanges(), refreshLanes(), refreshGitMeta()]);
    setCommitTimelineKey((prev) => prev + 1);
  };

  const refreshAutoRebaseStatus = useCallback(async () => {
    if (!laneId) {
      setAutoRebaseStatus(null);
      return;
    }
    try {
      const statuses = await window.ade.lanes.listAutoRebaseStatuses();
      setAutoRebaseStatus(statuses.find((entry) => entry.laneId === laneId) ?? null);
    } catch {
      setAutoRebaseStatus(null);
    }
  }, [laneId]);

  const isNonFastForwardError = useCallback((rawMessage: string): boolean => {
    const lower = rawMessage.toLowerCase();
    return lower.includes("non-fast-forward") || lower.includes("failed to push some refs");
  }, []);

  const formatActionError = useCallback((actionName: string, rawMessage: string): string => {
    if ((actionName === "push" || actionName === "force push") && isNonFastForwardError(rawMessage)) {
      return "Push rejected because branch history changed on remote (often after rebase). Use Force Push (lease) for this lane.";
    }
    return rawMessage;
  }, [isNonFastForwardError]);

  const runAction = async (actionName: string, fn: () => Promise<void>) => {
    setBusyAction(actionName);
    setNotice(null);
    setError(null);
    try {
      await fn();
      const shouldFetchRemote =
        actionName === "pull" ||
        actionName === "fetch" ||
        actionName === "push" ||
        actionName === "force push" ||
        actionName === "rebase" ||
        actionName === "rebase + push";
      await refreshAll({ fetchRemote: shouldFetchRemote });
      if (
        actionName === "push" ||
        actionName === "force push" ||
        actionName === "pull" ||
        actionName === "fetch" ||
        actionName === "rebase" ||
        actionName === "rebase + push"
      ) {
        setForcePushSuggested(false);
      }
      setNotice(`${actionName} completed`);
      setTimeout(() => setNotice(null), 3000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "__ade_cancelled__") return;
      if (actionName === "push" && isNonFastForwardError(message)) {
        setForcePushSuggested(true);
      }
      setError(formatActionError(actionName, message));
    } finally {
      setBusyAction(null);
    }
  };

  useEffect(() => {
    setChanges({ staged: [], unstaged: [] });
    setStashes([]);
    setRecentCommits([]);
    setSyncStatus(null);
    setForcePushSuggested(false);
    setNotice(null);
    setError(null);
    setPullDropdownOpen(false);
    setPushDropdownOpen(false);
    setMoreDropdownOpen(false);
    setAmendCommit(false);
    setAutoRebaseStatus(null);
    if (!laneId) return;
    refreshAll().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    void refreshAutoRebaseStatus();
  }, [laneId, lane?.branchRef, refreshAutoRebaseStatus]);

  useEffect(() => {
    if (!laneId) return;
    let refreshTimer: number | null = null;
    const refreshSyncStatus = () => {
      void window.ade.git
        .getSyncStatus({ laneId })
        .then((nextStatus) => setSyncStatus(nextStatus))
        .catch(() => setSyncStatus(null));
    };
    const scheduleRefreshSyncStatus = (delayMs = 0) => {
      if (refreshTimer != null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        if (document.visibilityState !== "visible") return;
        refreshSyncStatus();
      }, delayMs);
    };
    scheduleRefreshSyncStatus();
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      scheduleRefreshSyncStatus(250);
    }, 20_000);
    const onFocus = () => scheduleRefreshSyncStatus();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") scheduleRefreshSyncStatus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [laneId]);

  useEffect(() => {
    const unsubscribe = window.ade.lanes.onAutoRebaseEvent((event) => {
      if (event.type !== "auto-rebase-updated") return;
      if (!laneId) {
        setAutoRebaseStatus(null);
        return;
      }
      setAutoRebaseStatus(event.statuses.find((entry) => entry.laneId === laneId) ?? null);
    });
    return unsubscribe;
  }, [laneId]);

  const changedFileCount = useMemo(() => {
    const paths = new Set<string>();
    for (const file of changes.staged) paths.add(file.path);
    for (const file of changes.unstaged) paths.add(file.path);
    return paths.size;
  }, [changes]);

  const stagedCount = changes.staged.length;
  const hasStaged = stagedCount > 0;
  const stagedPathSet = useMemo(() => new Set(changes.staged.map((file) => file.path)), [changes.staged]);
  const unstagedPathSet = useMemo(() => new Set(changes.unstaged.map((file) => file.path)), [changes.unstaged]);

  const toggleStageFile = async (path: string, isStaged: boolean) => {
    if (!laneId) return;
    if (isStaged) {
      await window.ade.git.unstageFile({ laneId, path });
    } else {
      await window.ade.git.stageFile({ laneId, path });
    }
    await refreshChanges();
  };

  const stageAll = () => {
    if (!laneId) return;
    runAction("stage all", async () => {
      await window.ade.git.stageAll({ laneId, paths: changes.unstaged.map((f) => f.path) });
    });
  };

  const unstageAll = () => {
    if (!laneId) return;
    runAction("unstage all", async () => {
      await window.ade.git.unstageAll({ laneId, paths: changes.staged.map((f) => f.path) });
    });
  };

  const runPush = (forceWithLease: boolean) => {
    if (!laneId) return;
    setPushDropdownOpen(false);
    runAction(forceWithLease ? "force push" : "push", async () => {
      await window.ade.git.push({ laneId, forceWithLease });
    });
  };

  const runPull = (mode: GitSyncMode) => {
    if (!laneId) return;
    setPullDropdownOpen(false);
    runAction("pull", async () => {
      const latestSyncStatus = await window.ade.git.getSyncStatus({ laneId }).catch(() => null);
      if (latestSyncStatus) setSyncStatus(latestSyncStatus);
      const targetBaseRef = latestSyncStatus?.hasUpstream && latestSyncStatus.upstreamRef
        ? latestSyncStatus.upstreamRef
        : (lane?.baseRef ?? undefined);
      await window.ade.git.sync({ laneId, mode, baseRef: targetBaseRef });
    });
  };

  const runRebaseAndPushFlow = (confirmPublish = true) => {
    if (!laneId) return;
    runAction("rebase and push", async () => {
      if (onRebaseAndPush) {
        await onRebaseAndPush(laneId);
        return;
      }

      const start = await window.ade.lanes.rebaseStart({
        laneId,
        scope: "lane_only",
        pushMode: "none",
        actor: "user"
      });
      if (start.run.state === "failed" || start.run.failedLaneId || start.run.error) {
        throw new Error(start.run.error ?? "Rebase failed.");
      }

      await window.ade.git.fetch({ laneId }).catch(() => {});
      const latestSyncStatus = await window.ade.git.getSyncStatus({ laneId });
      setSyncStatus(latestSyncStatus);

      if (!latestSyncStatus.hasUpstream) {
        if (confirmPublish) {
          const ok = window.confirm(`Publish lane '${lane?.name ?? laneId}' to origin/${lane?.branchRef ?? "current branch"}?`);
          if (!ok) throw new Error("__ade_cancelled__");
        }
        await window.ade.git.push({ laneId });
        return;
      }

      if (latestSyncStatus.diverged && latestSyncStatus.ahead > 0) {
        if (confirmPublish) {
          const ok = window.confirm(
            `Lane '${lane?.name ?? laneId}' diverged from remote (${latestSyncStatus.ahead} local ahead, ${latestSyncStatus.behind} remote ahead). Force push with lease now?`
          );
          if (!ok) throw new Error("__ade_cancelled__");
        }
        await window.ade.git.push({ laneId, forceWithLease: true });
        return;
      }

      if (latestSyncStatus.ahead > 0) {
        if (confirmPublish) {
          const ok = window.confirm(
            `Push ${latestSyncStatus.ahead} commit${latestSyncStatus.ahead === 1 ? "" : "s"} for lane '${lane?.name ?? laneId}' now?`
          );
          if (!ok) throw new Error("__ade_cancelled__");
        }
        await window.ade.git.push({ laneId });
      }
    });
  };

  const nextActionHint = useMemo<NextActionHint | null>(() => {
    if (!laneId) return null;
    if (lane?.parentLaneId && lane.status.behind > 0) {
      return {
        action: "rebase_push",
        label: "Rebase and push (local + remote)",
        detail: `Behind parent by ${lane.status.behind} commit${lane.status.behind === 1 ? "" : "s"}. Rebase locally, then push rewritten history to remote.`
      };
    }
    if (forcePushSuggested) {
      return {
        action: "force_push_lease",
        label: "Force Push (lease)",
        detail: "The previous push was rejected as non-fast-forward."
      };
    }
    if (!syncStatus) return null;
    if (!syncStatus.hasUpstream) {
      return {
        action: "push",
        label: "Publish lane",
        detail: "No remote branch exists yet. Push once to publish this lane."
      };
    }
    if (syncStatus.recommendedAction === "push") {
      return {
        action: "push",
        label: "Push",
        detail: `${syncStatus.ahead} commit${syncStatus.ahead === 1 ? "" : "s"} ready to push to remote.`
      };
    }
    if (syncStatus.recommendedAction === "pull") {
      if (syncStatus.diverged) {
        return {
          action: "pull",
          label: "Resolve divergence",
          detail: "Local and remote both changed. Pull (rebase) keeps remote commits; Force Push (lease) publishes your rewritten local history."
        };
      }
      return {
        action: "pull",
        label: "Pull",
        detail: `${syncStatus.behind} upstream commit${syncStatus.behind === 1 ? "" : "s"} not in this lane yet.`
      };
    }
    return null;
  }, [forcePushSuggested, lane, laneId, syncStatus]);

  const divergedSync = Boolean(syncStatus?.diverged);
  const pullHighlighted = nextActionHint?.action === "pull";
  const pushHighlighted = nextActionHint?.action === "push" || nextActionHint?.action === "force_push_lease" || divergedSync;
  const forcePushHighlighted = nextActionHint?.action === "force_push_lease" || divergedSync;
  const rebasePushHighlighted = nextActionHint?.action === "rebase_push";
  const pushButtonTitle = syncStatus?.hasUpstream === false ? "Publish lane (first push)" : "Push to remote";
  const rebaseConflictParentLaneId = autoRebaseStatus?.parentLaneId ?? lane?.parentLaneId ?? null;

  // --- Shared inline style helpers for the new design ---
  const splitBtnLeft = (solid: boolean): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: 32,
    padding: "0 10px",
    fontSize: 11,
    fontWeight: 700,
    fontFamily: MONO_FONT,
    textTransform: "uppercase",
    letterSpacing: "1px",
    border: solid ? `1px solid ${COLORS.accent}` : `1px solid ${COLORS.outlineBorder}`,
    borderRight: "none",
    borderRadius: 0,
    background: solid ? COLORS.accent : "transparent",
    color: solid ? COLORS.pageBg : COLORS.textSecondary,
    cursor: "pointer",
  });

  const splitBtnRight = (solid: boolean): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: 32,
    padding: "0 6px",
    fontSize: 11,
    fontFamily: MONO_FONT,
    border: solid ? `1px solid ${COLORS.accent}` : `1px solid ${COLORS.outlineBorder}`,
    borderLeft: solid ? `1px solid ${COLORS.pageBg}40` : `1px solid ${COLORS.outlineBorder}`,
    borderRadius: 0,
    background: solid ? COLORS.accent : "transparent",
    color: solid ? COLORS.pageBg : COLORS.textSecondary,
    cursor: "pointer",
  });

  const headerDotColor = lane?.laneType === "primary"
    ? COLORS.accent
    : lane?.status.dirty
      ? COLORS.warning
      : "#10B981";

  const renderFileRow = (file: FileChange, mode: "staged" | "unstaged") => {
    const rowSelected = selectedPath === file.path && selectedMode === mode;
    const alsoStaged = mode === "unstaged" && stagedPathSet.has(file.path);
    const alsoUnstaged = mode === "staged" && unstagedPathSet.has(file.path);
    const kindColor = file.kind === "modified" ? COLORS.info : file.kind === "added" ? COLORS.success : file.kind === "deleted" ? COLORS.danger : COLORS.warning;

    return (
      <div
        key={`${mode}:${file.path}`}
        className="group flex items-center gap-1.5 cursor-pointer transition-all duration-150"
        style={{
          padding: "5px 8px", fontSize: 12, fontFamily: MONO_FONT,
          borderLeft: rowSelected ? `3px solid ${COLORS.accent}` : "3px solid transparent",
          background: rowSelected ? COLORS.accentSubtle : "transparent",
          color: rowSelected ? COLORS.textPrimary : COLORS.textMuted,
        }}
        onClick={() => {
          onSelectCommit(null);
          onSelectFile(file.path, mode);
        }}
        onMouseEnter={(e) => { if (!rowSelected) e.currentTarget.style.background = COLORS.hoverBg; }}
        onMouseLeave={(e) => { if (!rowSelected) e.currentTarget.style.background = "transparent"; }}
      >
        <button
          type="button"
          className="shrink-0 flex items-center justify-center"
          style={{
            width: 14, height: 14,
            background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`,
            cursor: "pointer",
          }}
          onClick={(e) => {
            e.stopPropagation();
            toggleStageFile(file.path, mode === "staged");
          }}
          title={mode === "staged" ? "Unstage" : "Stage"}
        >
          {mode === "staged" ? <Check size={8} style={{ color: COLORS.accent }} /> : null}
        </button>
        <span className="shrink-0" style={{ width: 6, height: 6, borderRadius: "50%", background: kindColor }} />
        <span className="truncate flex-1" style={{ fontSize: 11 }}>{file.path}</span>
        {(alsoStaged || alsoUnstaged) ? (
          <span style={inlineBadge(COLORS.warning, { fontSize: 9 })}>PARTIAL</span>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col" style={{ background: COLORS.pageBg }}>
      {/* Section A -- Lane Header */}
      <div className="shrink-0" style={{ padding: "10px 16px", background: COLORS.cardBg, borderBottom: `1px solid ${COLORS.border}` }}>
        <div className="flex items-center" style={{ gap: 12 }}>
          <span className="shrink-0" style={{
            width: 10, height: 10, borderRadius: "50%",
            background: headerDotColor,
          }} />
          <span style={{
            fontSize: 12, fontWeight: 700, fontFamily: MONO_FONT,
            letterSpacing: "1px", textTransform: "uppercase",
            color: COLORS.textPrimary,
          }} className="truncate" title={lane?.name}>{lane?.name ?? "NO LANE"}</span>
          {lane ? (
            <>
              <span style={{
                padding: "3px 8px", fontSize: 10, fontWeight: 600, fontFamily: MONO_FONT,
                color: COLORS.accent, background: `${COLORS.accent}15`, letterSpacing: "0.5px",
              }}>{lane.branchRef}</span>
              <span style={{
                padding: "3px 8px", fontSize: 10, fontWeight: 600, fontFamily: MONO_FONT,
                color: lane.status.dirty ? COLORS.warning : "#10B981",
                background: lane.status.dirty ? `${COLORS.warning}15` : "#10B98115",
                letterSpacing: "0.5px",
              }}>{lane.status.dirty ? "DIRTY" : "CLEAN"}</span>
            </>
          ) : null}
          {lane ? (
            <span style={{
              fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim,
              letterSpacing: "0.5px", marginLeft: "auto", whiteSpace: "nowrap",
            }}>
              base {"\u2191"}{lane.status.ahead} {"\u2193"}{lane.status.behind}
              {syncStatus ? (
                <>
                  {" \u00B7 "}
                  {syncStatus.hasUpstream ? (
                    <span title={`Compared to ${syncStatus.upstreamRef ?? "upstream"}`}>
                      remote {"\u2191"}{syncStatus.ahead} {"\u2193"}{syncStatus.behind}
                    </span>
                  ) : (
                    <span style={{ color: COLORS.warning }}>remote unpublished</span>
                  )}
                </>
              ) : null}
            </span>
          ) : null}
        </div>
        {lane && originLabel ? (
          <div style={{ marginTop: 4, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim, letterSpacing: "0.5px" }}>
            {originLabel}
          </div>
        ) : null}
      </div>

      {/* Section B -- Sync Actions Bar */}
      <div className="shrink-0 flex items-center" style={{ padding: "8px 16px", gap: 8, borderBottom: `1px solid ${COLORS.border}` }}>
        {/* Pull split button */}
        <div className="relative" ref={pullDropdownRef}>
          <div style={{ display: "inline-flex" }}>
            <button
              type="button"
              style={{
                ...splitBtnLeft(false),
                opacity: (!laneId || busyAction != null) ? 0.4 : 1,
                pointerEvents: (!laneId || busyAction != null) ? "none" : "auto",
              }}
              disabled={!laneId || busyAction != null}
              onClick={() => { if (laneId) runPull(syncMode); }}
              title={`Pull (${syncMode})`}
            >
              <ArrowDown size={14} weight={pullHighlighted ? "bold" : "regular"} />
            </button>
            <button
              type="button"
              style={splitBtnRight(false)}
              onClick={() => setPullDropdownOpen((prev) => !prev)}
            >
              <CaretDown size={12} />
            </button>
          </div>
          {pullDropdownOpen ? (
            <div style={{ position: "absolute", left: 0, top: "100%", zIndex: 50, marginTop: 4, width: 192, background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "2px 0" }}>
              {(["merge", "rebase"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  style={{ display: "flex", width: "100%", alignItems: "center", gap: 8, padding: "6px 12px", textAlign: "left", fontSize: 11, fontFamily: MONO_FONT, fontWeight: 600, letterSpacing: "0.5px", color: syncMode === mode ? COLORS.accent : COLORS.textSecondary, background: "transparent", border: "none", cursor: "pointer" }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  onClick={() => { setSyncMode(mode); if (laneId) runPull(mode); }}
                >
                  {syncMode === mode ? <Check size={12} /> : <span style={{ width: 12 }} />}
                  <span>PULL ({mode.toUpperCase()})</span>
                </button>
              ))}
              <div style={{ margin: "4px 0", height: 1, background: COLORS.border }} />
              <button
                type="button"
                style={{ display: "flex", width: "100%", alignItems: "center", gap: 8, padding: "6px 12px", textAlign: "left", fontSize: 11, fontFamily: MONO_FONT, fontWeight: 600, letterSpacing: "0.5px", color: COLORS.textSecondary, background: "transparent", border: "none", cursor: "pointer" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                onClick={() => { setPullDropdownOpen(false); if (laneId) runAction("fetch", async () => { await window.ade.git.fetch({ laneId }); }); }}
              >
                <span style={{ width: 12 }} />
                <span>FETCH ONLY</span>
              </button>
            </div>
          ) : null}
        </div>

        {/* Push split button */}
        <div className="relative" ref={pushDropdownRef}>
          <div style={{ display: "inline-flex" }}>
            <button
              type="button"
              style={{
                ...splitBtnLeft(true),
                opacity: (!laneId || busyAction != null) ? 0.4 : 1,
                pointerEvents: (!laneId || busyAction != null) ? "none" : "auto",
              }}
              disabled={!laneId || busyAction != null}
              onClick={() => runPush(false)}
              title={pushButtonTitle}
            >
              <Upload size={14} weight={pushHighlighted ? "bold" : "regular"} />
            </button>
            <button
              type="button"
              style={{
                ...splitBtnRight(true),
                opacity: (!laneId || busyAction != null) ? 0.4 : 1,
                pointerEvents: (!laneId || busyAction != null) ? "none" : "auto",
              }}
              disabled={!laneId || busyAction != null}
              onClick={() => setPushDropdownOpen((prev) => !prev)}
              title="Push options"
            >
              <CaretDown size={12} />
            </button>
          </div>
          {pushDropdownOpen ? (
            <div style={{ position: "absolute", left: 0, top: "100%", zIndex: 50, marginTop: 4, width: 208, background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "2px 0" }}>
              <button
                type="button"
                style={{ display: "flex", width: "100%", alignItems: "center", gap: 8, padding: "6px 12px", textAlign: "left", fontSize: 11, fontFamily: MONO_FONT, fontWeight: 600, letterSpacing: "0.5px", color: COLORS.textSecondary, background: "transparent", border: "none", cursor: "pointer" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                onClick={() => runPush(false)}
              >
                <span>{syncStatus?.hasUpstream === false ? "PUBLISH LANE" : "PUSH UPDATES"}</span>
              </button>
              <button
                type="button"
                style={{ display: "flex", width: "100%", alignItems: "center", gap: 8, padding: "6px 12px", textAlign: "left", fontSize: 11, fontFamily: MONO_FONT, fontWeight: 600, letterSpacing: "0.5px", color: COLORS.textSecondary, background: "transparent", border: "none", cursor: "pointer" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                onClick={() => runPush(true)}
              >
                <div>
                  <div style={{ fontWeight: 600, color: forcePushHighlighted ? COLORS.warning : COLORS.textSecondary }}>
                    FORCE PUSH (LEASE){forcePushHighlighted ? " \u00B7 RECOMMENDED" : ""}
                  </div>
                  <div style={{ fontSize: 10, color: COLORS.textMuted, marginTop: 2 }}>Use after rebase or rewritten history</div>
                </div>
              </button>
            </div>
          ) : null}
        </div>

        {lane?.parentLaneId ? (
          <button
            type="button"
            style={{
              ...outlineButton({ height: 32, padding: "0 10px", fontSize: 10 }),
              opacity: (!laneId || busyAction != null) ? 0.4 : 1,
              pointerEvents: (!laneId || busyAction != null) ? "none" : "auto",
            }}
            title="Rebase now (local only)"
            disabled={!laneId || busyAction != null}
            onClick={() => {
              if (!laneId) return;
              if (onRebaseNowLocal) {
                runAction("rebase", async () => {
                  await onRebaseNowLocal(laneId);
                });
                return;
              }
              runAction("rebase", async () => {
                const start = await window.ade.lanes.rebaseStart({
                  laneId,
                  scope: "lane_only",
                  pushMode: "none",
                  actor: "user"
                });
                if (start.run.state === "failed" || start.run.failedLaneId || start.run.error) {
                  throw new Error(start.run.error ?? "Rebase failed.");
                }
              });
            }}
          >
            <Stack size={14} />
            Rebase now (local only)
          </button>
        ) : null}
        {lane?.parentLaneId ? (
          <button
            type="button"
            style={{
              ...(rebasePushHighlighted
                ? primaryButton({ height: 32, padding: "0 12px", fontSize: 10 })
                : outlineButton({ height: 32, padding: "0 12px", fontSize: 10 })),
              opacity: (!laneId || busyAction != null) ? 0.4 : 1,
              pointerEvents: (!laneId || busyAction != null) ? "none" : "auto",
            }}
            title="Rebase and push (local + remote)"
            disabled={!laneId || busyAction != null}
            onClick={() => runRebaseAndPushFlow(true)}
          >
            Rebase and push (local + remote)
          </button>
        ) : null}
        {lane?.parentLaneId ? (
          <button
            type="button"
            style={{
              ...outlineButton({ height: 32, padding: "0 10px", fontSize: 10 }),
              opacity: (!laneId || busyAction != null) ? 0.4 : 1,
              pointerEvents: (!laneId || busyAction != null) ? "none" : "auto",
            }}
            title="View rebase details"
            disabled={!laneId || busyAction != null}
            onClick={() => onViewRebaseDetails?.()}
          >
            View rebase details
          </button>
        ) : null}

        <div style={{ flex: 1 }} />

        {/* Refresh button */}
        <button
          type="button"
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 32, height: 32,
            border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 0,
            background: "transparent", color: COLORS.textMuted, cursor: "pointer",
          }}
          onClick={() => refreshAll({ fetchRemote: true }).catch(() => {})}
          title="Refresh (fetches remote)"
        >
          <ArrowsClockwise size={14} className={cn(loading && "animate-spin")} />
        </button>

        {/* More dropdown */}
        <div className="relative" ref={moreDropdownRef}>
          <button
            type="button"
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 32, height: 32,
              border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 0,
              background: "transparent", color: COLORS.textMuted, cursor: "pointer",
            }}
            title="More actions"
            onClick={() => setMoreDropdownOpen((prev) => !prev)}
          >
            <DotsThree size={16} weight="bold" />
          </button>
          {moreDropdownOpen ? (
            <div style={{ position: "absolute", right: 0, top: "100%", zIndex: 50, marginTop: 4, width: 224, background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "2px 0" }}>
              {[
                { label: "STASH CHANGES", disabled: false, onClick: () => { setMoreDropdownOpen(false); if (!laneId) return; runAction("stash push", async () => { const msg = await requestTextInput({ title: "Stash message", placeholder: "optional" }); if (msg == null) throw new Error("__ade_cancelled__"); await window.ade.git.stashPush({ laneId, message: msg || undefined }); }); } },
                { label: `POP STASH${stashes.length > 0 ? ` (${stashes[0]?.ref})` : ""}`, disabled: stashes.length === 0, onClick: () => { setMoreDropdownOpen(false); if (!laneId || stashes.length === 0) return; runAction("stash pop", async () => { await window.ade.git.stashPop({ laneId, stashRef: stashes[0]!.ref }); }); } },
                null,
                { label: "REVERT COMMIT...", disabled: recentCommits.length === 0, onClick: () => { setMoreDropdownOpen(false); if (!laneId || recentCommits.length === 0) return; runAction("revert commit", async () => { const sha = await requestTextInput({ title: "Commit SHA to revert", defaultValue: recentCommits[0]!.sha, validate: (value) => (value ? null : "Commit SHA is required") }); if (!sha) throw new Error("__ade_cancelled__"); await window.ade.git.revertCommit({ laneId, commitSha: sha }); }); } },
                { label: "CHERRY-PICK...", disabled: false, onClick: () => { setMoreDropdownOpen(false); if (!laneId) return; runAction("cherry-pick", async () => { const sha = await requestTextInput({ title: "Commit SHA to cherry-pick", validate: (value) => (value ? null : "Commit SHA is required") }); if (!sha) throw new Error("__ade_cancelled__"); await window.ade.git.cherryPickCommit({ laneId, commitSha: sha }); }); } },
              ].map((item, idx) =>
                item === null ? (
                  <div key={`sep-${idx}`} style={{ margin: "4px 0", height: 1, background: COLORS.border }} />
                ) : (
                  <button
                    key={item.label}
                    type="button"
                    style={{ display: "flex", width: "100%", alignItems: "center", gap: 8, padding: "6px 12px", textAlign: "left", fontSize: 10, fontWeight: 600, fontFamily: MONO_FONT, letterSpacing: "1px", color: COLORS.textSecondary, background: "transparent", border: "none", cursor: item.disabled ? "default" : "pointer", opacity: item.disabled ? 0.4 : 1, pointerEvents: item.disabled ? "none" : "auto" }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                    onClick={item.onClick}
                  >
                    {item.label}
                  </button>
                )
              )}
            </div>
          ) : null}
        </div>
      </div>

      {/* Section C -- Commit Area */}
      <div className="shrink-0 flex items-center" style={{ padding: "8px 16px", gap: 8, borderBottom: `1px solid ${COLORS.border}` }}>
        <span style={{ ...LABEL_STYLE, color: COLORS.textDim, fontSize: 10, fontWeight: 600 }}>COMMIT</span>
        <input
          style={{
            height: 32, flex: 1,
            padding: "0 12px", fontSize: 10, fontFamily: MONO_FONT,
            letterSpacing: "0.5px",
            background: COLORS.recessedBg, border: `1px solid ${COLORS.outlineBorder}`,
            color: COLORS.textSecondary, outline: "none",
          }}
          placeholder="COMMIT MESSAGE..."
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              if (laneId && commitMessage.trim() && (hasStaged || amendCommit)) {
                runAction(amendCommit ? "amend commit" : "commit", async () => {
                  await window.ade.git.commit({ laneId, message: commitMessage.trim(), amend: amendCommit });
                  setCommitMessage("");
                  setAmendCommit(false);
                });
              }
            }
          }}
        />
        <button
          type="button"
          style={{
            ...outlineButton({ height: 32, padding: "0 12px", fontSize: 10 }),
            color: amendCommit ? COLORS.warning : COLORS.textSecondary,
            borderColor: amendCommit ? `${COLORS.warning}40` : COLORS.outlineBorder,
            background: amendCommit ? `${COLORS.warning}10` : "transparent",
          }}
          title="Amend the latest commit using this message"
          disabled={busyAction != null}
          onClick={() => setAmendCommit((prev) => !prev)}
        >
          AMEND
        </button>
        <button
          type="button"
          style={{
            ...primaryButton({ height: 32, padding: "0 18px", fontSize: 11 }),
            opacity: (!commitMessage.trim() || (!hasStaged && !amendCommit) || busyAction != null) ? 0.4 : 1,
            pointerEvents: (!commitMessage.trim() || (!hasStaged && !amendCommit) || busyAction != null) ? "none" : "auto",
          }}
          disabled={!commitMessage.trim() || (!hasStaged && !amendCommit) || busyAction != null}
          onClick={() => {
            if (laneId)
              runAction(amendCommit ? "amend commit" : "commit", async () => {
                await window.ade.git.commit({ laneId, message: commitMessage.trim(), amend: amendCommit });
                setCommitMessage("");
                setAmendCommit(false);
              });
          }}
        >
          COMMIT
        </button>
      </div>

      {/* Section D -- Next Action Hint */}
      {nextActionHint ? (
        <div className="shrink-0 flex items-center" style={{
          padding: "8px 16px", gap: 12, borderBottom: `1px solid ${COLORS.border}`,
          background: COLORS.recessedBg,
        }}>
          <span style={{
            fontSize: 10, fontWeight: 700, fontFamily: MONO_FONT,
            textTransform: "uppercase", letterSpacing: "1px",
            color: COLORS.accent,
          }}>
            NEXT: {nextActionHint.label.toUpperCase()}
          </span>
          <span className="truncate" style={{
            fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted,
            letterSpacing: "0.5px",
          }}>{nextActionHint.detail}</span>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            {nextActionHint.action === "pull" ? (
              <button type="button" style={{ ...outlineButton({ height: 28, padding: "0 10px", fontSize: 10 }), borderColor: `${COLORS.accent}50` }} disabled={!laneId || busyAction != null} onClick={() => { if (laneId) runPull(syncMode); }}>
                PULL ({syncMode.toUpperCase()})
              </button>
            ) : null}
            {nextActionHint.action === "rebase_push" ? (
              <button type="button" style={{ ...outlineButton({ height: 28, padding: "0 10px", fontSize: 10 }), borderColor: `${COLORS.accent}50` }} disabled={!laneId || busyAction != null} onClick={() => runRebaseAndPushFlow(true)}>
                Rebase and push (local + remote)
              </button>
            ) : null}
            {nextActionHint.action === "pull" && divergedSync ? (
              <button type="button" style={{ ...outlineButton({ height: 28, padding: "0 10px", fontSize: 10 }), borderColor: `${COLORS.accent}50` }} disabled={!laneId || busyAction != null} onClick={() => runPush(true)}>
                FORCE PUSH (LEASE)
              </button>
            ) : null}
            {nextActionHint.action === "push" ? (
              <button type="button" style={{ ...outlineButton({ height: 28, padding: "0 10px", fontSize: 10 }), borderColor: `${COLORS.accent}50` }} disabled={!laneId || busyAction != null} onClick={() => runPush(false)}>
                {syncStatus?.hasUpstream === false ? "PUBLISH NOW" : "PUSH NOW"}
              </button>
            ) : null}
            {nextActionHint.action === "force_push_lease" ? (
              <button type="button" style={{ ...outlineButton({ height: 28, padding: "0 10px", fontSize: 10 }), borderColor: `${COLORS.accent}50` }} disabled={!laneId || busyAction != null} onClick={() => runPush(true)}>
                FORCE PUSH NOW
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {nextActionHint?.action === "rebase_push" && !autoRebaseEnabled ? (
        <div className="shrink-0" style={{ padding: "8px 16px", fontSize: 10, fontFamily: MONO_FONT, letterSpacing: "0.5px", borderBottom: `1px solid ${COLORS.border}`, background: `${COLORS.info}08`, color: COLORS.info }}>
          <div className="flex items-center gap-2">
            <span className="truncate">Auto-rebase is off. Enable it in Settings to auto-rebase child lanes when parent/main advances.</span>
            <button type="button" style={{ ...outlineButton({ height: 28, padding: "0 10px", fontSize: 10 }), marginLeft: "auto", flexShrink: 0 }} onClick={onOpenSettings}>
              SETTINGS
            </button>
          </div>
        </div>
      ) : null}

      {autoRebaseStatus ? (() => {
        const arColor = autoRebaseStatus.state === "autoRebased" ? COLORS.success : autoRebaseStatus.state === "rebaseConflict" ? COLORS.danger : COLORS.warning;
        return (
          <div className="shrink-0 flex items-center" style={{ padding: "8px 16px", gap: 12, fontSize: 10, fontFamily: MONO_FONT, borderBottom: `1px solid ${COLORS.border}`, background: `${arColor}08`, color: arColor }}>
            <span style={{ ...LABEL_STYLE, color: "inherit" }}>
              {autoRebaseStatus.state === "autoRebased" ? "AUTO REBASED" : autoRebaseStatus.state === "rebaseConflict" ? "AUTO REBASE BLOCKED" : "AUTO REBASE PENDING"}
            </span>
            <span className="truncate" style={{ color: COLORS.textMuted, letterSpacing: "0.5px" }}>
              {autoRebaseStatus.message ??
                (autoRebaseStatus.state === "autoRebased"
                  ? "Lane was rebased automatically."
                  : autoRebaseStatus.state === "rebaseConflict"
                    ? "Conflicts are expected. Resolve manually, then publish."
                    : "Waiting for manual rebase.")}
            </span>
            {autoRebaseStatus.state !== "autoRebased" ? (
              <div style={{ marginLeft: "auto", flexShrink: 0 }}>
                {autoRebaseStatus.state === "rebaseConflict" ? (
                  <button type="button" style={{ ...outlineButton({ height: 28, padding: "0 10px", fontSize: 10 }), borderColor: `${COLORS.accent}50` }} disabled={!laneId || busyAction != null} onClick={() => { if (laneId) onResolveRebaseConflict?.(laneId, rebaseConflictParentLaneId); }}>
                    RESOLVE IN CONFLICTS
                  </button>
                ) : (
                  <button type="button" style={{ ...outlineButton({ height: 28, padding: "0 10px", fontSize: 10 }), borderColor: `${COLORS.accent}50` }} disabled={!laneId || busyAction != null} onClick={() => runRebaseAndPushFlow(true)}>
                    Rebase and push (local + remote)
                  </button>
                )}
              </div>
            ) : null}
          </div>
        );
      })() : null}

      {/* Section E -- Git Body (files + commits) */}
      <div className="flex-1 min-h-0">
        <Group id={`lane-git-sections:${laneId ?? "none"}`} orientation="horizontal" className="h-full w-full min-h-0">
          {/* Left: File Panel */}
          <Panel id={`lane-git-files:${laneId ?? "none"}`} defaultSize="58%" minSize="22%" className="min-h-0 min-w-0">
            <div className="flex h-full min-h-0 flex-col">
              {/* File header */}
              <div className="shrink-0 flex items-center justify-between" style={{ padding: "8px 16px", background: COLORS.recessedBg, borderBottom: `1px solid ${COLORS.border}`, borderRight: `1px solid ${COLORS.border}` }}>
                <div className="flex items-center" style={{ gap: 8 }}>
                  <span style={LABEL_STYLE}>FILES</span>
                  <span style={inlineBadge(COLORS.accent, { fontSize: 9 })}>{changedFileCount}</span>
                  {stagedCount > 0 ? (
                    <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim, letterSpacing: "0.5px" }}>({stagedCount} STAGED)</span>
                  ) : null}
                </div>
                <div className="flex items-center" style={{ gap: 8 }}>
                  <button
                    type="button"
                    style={{ fontSize: 10, fontFamily: MONO_FONT, fontWeight: 600, letterSpacing: "0.5px", padding: "0 4px", color: COLORS.textMuted, background: "transparent", border: "none", cursor: "pointer" }}
                    onClick={() => setShowStashes((prev) => !prev)}
                  >
                    {showStashes ? "HIDE STASHES" : `STASHES (${stashes.length})`}
                  </button>
                  {changes.unstaged.length > 0 ? (
                    <button type="button" style={{ fontSize: 10, fontFamily: MONO_FONT, fontWeight: 600, letterSpacing: "1px", padding: "0 4px", color: COLORS.accent, background: "transparent", border: "none", cursor: "pointer" }} onClick={stageAll}>
                      STAGE ALL
                    </button>
                  ) : null}
                  {changes.staged.length > 0 ? (
                    <button type="button" style={{ fontSize: 10, fontFamily: MONO_FONT, fontWeight: 600, letterSpacing: "1px", padding: "0 4px", color: COLORS.textMuted, background: "transparent", border: "none", cursor: "pointer" }} onClick={unstageAll}>
                      UNSTAGE ALL
                    </button>
                  ) : null}
                </div>
              </div>

              {/* File list area */}
              <div className="flex-1 min-h-0" style={{ borderRight: `1px solid ${COLORS.border}` }}>
                {showStashes ? (
                  <Group id={`lane-git-left:${laneId ?? "none"}`} orientation="vertical" className="h-full w-full min-h-0">
                    <Panel id={`lane-git-stashes:${laneId ?? "none"}`} defaultSize="38%" minSize="14%" className="min-h-0 min-w-0">
                      <div className="h-full overflow-auto" style={{ background: COLORS.pageBg, padding: "6px 8px" }}>
                        <div style={{ marginBottom: 4, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                          <div className="flex items-center gap-1.5">
                            <span style={LABEL_STYLE}>STASHES</span>
                            <span style={inlineBadge(COLORS.accent, { fontSize: 9 })}>{stashes.length}</span>
                          </div>
                          <button
                            type="button"
                            style={outlineButton({ height: 24, padding: "0 10px", fontSize: 10 })}
                            disabled={!laneId || busyAction != null}
                            onClick={() => {
                              if (!laneId) return;
                              runAction("stash push", async () => {
                                const msg = await requestTextInput({ title: "Stash message", placeholder: "optional" });
                                if (msg == null) throw new Error("__ade_cancelled__");
                                await window.ade.git.stashPush({ laneId, message: msg || undefined });
                              });
                            }}
                          >
                            STASH NOW
                          </button>
                        </div>
                        {stashes.length === 0 ? (
                          <div style={{ border: `1px solid ${COLORS.border}`, background: COLORS.cardBg, padding: "4px 8px", fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, letterSpacing: "0.5px" }}>No stashes in this lane.</div>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            {stashes.slice(0, 4).map((stash) => (
                              <div key={stash.ref} className="flex items-center gap-2" style={{ border: `1px solid ${COLORS.border}`, background: COLORS.cardBg, padding: "4px 8px" }}>
                                <div className="min-w-0 flex-1">
                                  <div className="truncate" style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>{stash.subject || stash.ref}</div>
                                  <div className="truncate" style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>{stash.ref} · {formatRelativeTime(stash.createdAt)}</div>
                                </div>
                                <button type="button" style={{ padding: "2px 6px", fontSize: 10, fontFamily: MONO_FONT, fontWeight: 600, letterSpacing: "0.5px", color: COLORS.info, background: "transparent", border: "none", cursor: "pointer" }} disabled={!laneId || busyAction != null} onClick={() => { if (laneId) runAction("stash apply", async () => { await window.ade.git.stashApply({ laneId, stashRef: stash.ref }); }); }}>
                                  APPLY
                                </button>
                                <button type="button" style={{ padding: "2px 6px", fontSize: 10, fontFamily: MONO_FONT, fontWeight: 600, letterSpacing: "0.5px", color: COLORS.warning, background: "transparent", border: "none", cursor: "pointer" }} disabled={!laneId || busyAction != null} onClick={() => { if (laneId) runAction("stash pop", async () => { await window.ade.git.stashPop({ laneId, stashRef: stash.ref }); }); }}>
                                  POP
                                </button>
                                <button type="button" style={{ padding: "2px 6px", fontSize: 10, fontFamily: MONO_FONT, fontWeight: 600, letterSpacing: "0.5px", color: COLORS.danger, background: "transparent", border: "none", cursor: "pointer" }} disabled={!laneId || busyAction != null} onClick={() => { if (laneId) runAction("stash drop", async () => { await window.ade.git.stashDrop({ laneId, stashRef: stash.ref }); }); }}>
                                  DROP
                                </button>
                              </div>
                            ))}
                            {stashes.length > 4 ? (
                              <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim, letterSpacing: "0.5px" }}>+{stashes.length - 4} more stash entries.</div>
                            ) : null}
                          </div>
                        )}
                      </div>
                    </Panel>
                    <ResizeGutter orientation="horizontal" thin />
                    <Panel id={`lane-git-file-list:${laneId ?? "none"}`} defaultSize="62%" minSize="16%" className="min-h-0 min-w-0">
                      <div className="h-full overflow-auto" style={{ padding: 4, display: "flex", flexDirection: "column", gap: 8 }}>
                        {changes.staged.length > 0 ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            <div style={{ padding: "0 8px 2px", ...LABEL_STYLE }}>STAGED ({changes.staged.length})</div>
                            {changes.staged.map((file) => renderFileRow(file, "staged"))}
                          </div>
                        ) : null}
                        {changes.unstaged.length > 0 ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            <div style={{ padding: "0 8px 2px", ...LABEL_STYLE }}>UNSTAGED ({changes.unstaged.length})</div>
                            {changes.unstaged.map((file) => renderFileRow(file, "unstaged"))}
                          </div>
                        ) : null}
                        {changes.staged.length === 0 && changes.unstaged.length === 0 ? (
                          <div style={{ padding: 12, textAlign: "center", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textDim, fontStyle: "italic", letterSpacing: "0.5px" }}>No changes</div>
                        ) : null}
                      </div>
                    </Panel>
                  </Group>
                ) : (
                  <div className="h-full overflow-auto" style={{ padding: 4, display: "flex", flexDirection: "column", gap: 8 }}>
                    {changes.staged.length > 0 ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <div style={{ padding: "0 8px 2px", ...LABEL_STYLE }}>STAGED ({changes.staged.length})</div>
                        {changes.staged.map((file) => renderFileRow(file, "staged"))}
                      </div>
                    ) : null}
                    {changes.unstaged.length > 0 ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <div style={{ padding: "0 8px 2px", ...LABEL_STYLE }}>UNSTAGED ({changes.unstaged.length})</div>
                        {changes.unstaged.map((file) => renderFileRow(file, "unstaged"))}
                      </div>
                    ) : null}
                    {changes.staged.length === 0 && changes.unstaged.length === 0 ? (
                      <div style={{ padding: 12, textAlign: "center", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textDim, fontStyle: "italic", letterSpacing: "0.5px" }}>No changes</div>
                    ) : null}
                  </div>
                )}
              </div>
            </div>
          </Panel>
          <ResizeGutter orientation="vertical" thin />
          {/* Right: Commit Timeline */}
          <Panel id={`lane-git-commits:${laneId ?? "none"}`} defaultSize="42%" minSize="18%" className="min-h-0 min-w-0">
            <CommitTimeline
              laneId={laneId ?? null}
              selectedSha={selectedCommitSha}
              refreshTrigger={commitTimelineKey}
              hasUpstream={syncStatus?.hasUpstream ?? null}
              onSelectCommit={(commit) => {
                onSelectCommit(commit);
              }}
            />
          </Panel>
        </Group>
      </div>

      {/* Status bar */}
      {(notice || error || busyAction) && (
        <div className="shrink-0 flex items-center justify-between" style={{
          padding: "4px 16px", fontSize: 10, fontFamily: MONO_FONT,
          letterSpacing: "0.5px", borderTop: `1px solid ${COLORS.border}`,
          background: error ? `${COLORS.danger}15` : `${COLORS.accent}12`,
          color: error ? COLORS.danger : COLORS.accent,
        }}>
          <span>{error ? `ERROR: ${error}` : notice ? notice.toUpperCase() : busyAction ? `RUNNING ${busyAction.toUpperCase()}...` : ""}</span>
        </div>
      )}

      {/* Text prompt modal */}
      {textPrompt ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}>
          <div style={{ width: "min(460px, 100%)", background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 700, fontFamily: MONO_FONT, letterSpacing: "1px", textTransform: "uppercase", color: COLORS.textPrimary }}>{textPrompt.title}</div>
            {textPrompt.message ? <div style={{ marginTop: 6, fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted }}>{textPrompt.message}</div> : null}
            <input
              autoFocus
              value={textPrompt.value}
              onChange={(event) => {
                const nextValue = event.target.value;
                setTextPrompt((prev) => (prev ? { ...prev, value: nextValue } : prev));
                if (textPromptError) setTextPromptError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelTextPrompt();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  submitTextPrompt();
                }
              }}
              placeholder={textPrompt.placeholder}
              style={{
                marginTop: 12, height: 36, width: "100%",
                padding: "0 12px", fontSize: 11, fontFamily: MONO_FONT,
                letterSpacing: "0.5px",
                background: COLORS.recessedBg, border: `1px solid ${COLORS.outlineBorder}`,
                color: COLORS.textSecondary, outline: "none",
              }}
            />
            {textPromptError ? <div style={{ marginTop: 8, fontSize: 11, fontFamily: MONO_FONT, color: COLORS.danger }}>{textPromptError}</div> : null}
            <div className="flex justify-end gap-2" style={{ marginTop: 16 }}>
              <button type="button" style={outlineButton({ height: 32, padding: "0 14px", fontSize: 10 })} onClick={cancelTextPrompt}>
                CANCEL
              </button>
              <button type="button" style={primaryButton({ height: 32, padding: "0 14px", fontSize: 10 })} onClick={submitTextPrompt}>
                {textPrompt.confirmLabel.toUpperCase()}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

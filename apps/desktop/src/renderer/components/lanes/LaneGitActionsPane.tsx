import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel } from "react-resizable-panels";
import {
  ArrowDown,
  Check,
  ChevronDown,
  Layers3,
  MoreHorizontal,
  RefreshCw,
  Upload
} from "lucide-react";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { cn } from "../ui/cn";
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
  action: GitRecommendedAction | "restack_publish";
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
        actionName === "restack + publish";
      await refreshAll({ fetchRemote: shouldFetchRemote });
      if (
        actionName === "push" ||
        actionName === "force push" ||
        actionName === "pull" ||
        actionName === "fetch" ||
        actionName === "rebase" ||
        actionName === "restack + publish"
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
    const refreshSyncStatus = () => {
      void window.ade.git
        .getSyncStatus({ laneId })
        .then((nextStatus) => setSyncStatus(nextStatus))
        .catch(() => setSyncStatus(null));
      void refreshLanes().catch(() => {});
    };
    const intervalId = window.setInterval(refreshSyncStatus, 15_000);
    const onFocus = () => refreshSyncStatus();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshSyncStatus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [laneId, refreshLanes]);

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

  const runRestackAndPublishFlow = (confirmPublish = true) => {
    if (!laneId) return;
    runAction("restack + publish", async () => {
      const result = await window.ade.lanes.restack({ laneId, recursive: true });
      if (result.error) {
        throw new Error(result.error);
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
        action: "restack_publish",
        label: "Restack + Publish",
        detail: `Behind parent by ${lane.status.behind} commit${lane.status.behind === 1 ? "" : "s"}. Rebase on parent, then publish rewritten history.`
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
  const restackPublishHighlighted = nextActionHint?.action === "restack_publish";
  const pushButtonTitle = syncStatus?.hasUpstream === false ? "Publish lane (first push)" : "Push to remote";
  const rebaseConflictParentLaneId = autoRebaseStatus?.parentLaneId ?? lane?.parentLaneId ?? null;

  const renderFileRow = (file: FileChange, mode: "staged" | "unstaged") => {
    const rowSelected = selectedPath === file.path && selectedMode === mode;
    const alsoStaged = mode === "unstaged" && stagedPathSet.has(file.path);
    const alsoUnstaged = mode === "staged" && unstagedPathSet.has(file.path);

    return (
      <div
        key={`${mode}:${file.path}`}
        className={cn(
          "group flex items-center gap-1.5 px-2 py-1 rounded-lg cursor-pointer text-[11px]",
          rowSelected ? "bg-accent/10 text-fg shadow-card" : "hover:bg-muted/30 text-muted-fg hover:text-fg"
        )}
        onClick={() => {
          onSelectCommit(null);
          onSelectFile(file.path, mode);
        }}
      >
        <button
          type="button"
          className="shrink-0 h-3.5 w-3.5 rounded bg-muted/30 flex items-center justify-center hover:bg-accent/10"
          onClick={(e) => {
            e.stopPropagation();
            toggleStageFile(file.path, mode === "staged");
          }}
          title={mode === "staged" ? "Unstage" : "Stage"}
        >
          {mode === "staged" ? <Check className="h-2 w-2 text-accent" /> : null}
        </button>
        <span className={cn("inline-block w-1.5 h-1.5 rounded-full shrink-0",
          file.kind === "modified" ? "bg-blue-400" :
            file.kind === "added" ? "bg-emerald-400" :
              file.kind === "deleted" ? "bg-red-400" : "bg-amber-400"
        )} />
        <span className="truncate flex-1">{file.path}</span>
        {(alsoStaged || alsoUnstaged) ? (
          <span className="rounded px-1 py-0.5 text-[9px] uppercase tracking-wide bg-amber-500/15 text-amber-700">partial</span>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="shrink-0 border-b border-border/15 bg-card/30 px-2 py-1">
        <div className="flex flex-wrap items-center gap-1">
          <span className={cn(
            "h-2 w-2 rounded-full shrink-0",
            lane?.laneType === "primary" ? "bg-emerald-500" : lane?.status.dirty ? "bg-amber-500" : "bg-sky-500"
          )} />
          <span className="text-[11px] font-semibold truncate max-w-[100px]">{lane?.name ?? "No lane"}</span>
          {lane ? (
            <span className="text-[10px] text-muted-fg font-mono shrink-0">
              {lane.laneType === "primary" ? (
                <>Primary · <span className="text-emerald-600">{lane.branchRef}</span></>
              ) : (
                <>{originLabel} · </>
              )}
              <span title={`Compared to base ${lane.baseRef}`}>base {"\u2191"}{lane.status.ahead} {"\u2193"}{lane.status.behind}</span>
              {syncStatus ? (
                <>
                  {" · "}
                  {syncStatus.hasUpstream ? (
                    <span title={`Compared to ${syncStatus.upstreamRef ?? "upstream"}`}>
                      remote {"\u2191"}{syncStatus.ahead} {"\u2193"}{syncStatus.behind}
                    </span>
                  ) : (
                    <span>remote unpublished</span>
                  )}
                </>
              ) : null}
            </span>
          ) : null}

          <div className="flex-1 min-w-[4px]" />

          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => refreshAll({ fetchRemote: true }).catch(() => {})} title="Refresh (fetches remote)">
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
          </Button>

          {/* Pull dropdown */}
          <div className="relative" ref={pullDropdownRef}>
            <div className="inline-flex">
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "h-6 rounded-r-none border-r-0 px-1.5 text-[11px]",
                  pullHighlighted && "ring-2 ring-sky-500/60 bg-sky-500/10 text-sky-700"
                )}
                disabled={!laneId || busyAction != null}
                onClick={() => {
                  if (!laneId) return;
                  runPull(syncMode);
                }}
                title={`Pull (${syncMode})`}
              >
                <ArrowDown className="h-3 w-3" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className={cn("h-6 rounded-l-none px-0.5", pullHighlighted && "ring-2 ring-sky-500/60 bg-sky-500/10 text-sky-700")}
                onClick={() => setPullDropdownOpen((prev) => !prev)}
              >
                <ChevronDown className="h-3 w-3" />
              </Button>
            </div>
            {pullDropdownOpen ? (
              <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-xl border border-border/60 bg-[--color-surface-overlay] py-1 shadow-float backdrop-blur-xl">
                <button
                  type="button"
                  className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg hover:bg-muted/50", syncMode === "merge" && "text-accent")}
                  onClick={() => {
                    setSyncMode("merge");
                    if (laneId) runPull("merge");
                  }}
                >
                  {syncMode === "merge" ? <Check className="h-3 w-3 shrink-0" /> : <span className="w-3 shrink-0" />}
                  <div>
                    <div className="font-medium">Pull (merge)</div>
                  </div>
                </button>
                <button
                  type="button"
                  className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg hover:bg-muted/50", syncMode === "rebase" && "text-accent")}
                  onClick={() => {
                    setSyncMode("rebase");
                    if (laneId) runPull("rebase");
                  }}
                >
                  {syncMode === "rebase" ? <Check className="h-3 w-3 shrink-0" /> : <span className="w-3 shrink-0" />}
                  <div>
                    <div className="font-medium">Pull (rebase)</div>
                  </div>
                </button>
                <div className="my-1 h-px bg-border/15" />
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg hover:bg-muted/50"
                  onClick={() => { setPullDropdownOpen(false); if (laneId) runAction("fetch", async () => { await window.ade.git.fetch({ laneId }); }); }}
                >
                  <span className="w-3 shrink-0" />
                  <div className="font-medium">Fetch only</div>
                </button>
              </div>
            ) : null}
          </div>

          <div className="relative" ref={pushDropdownRef}>
            <div className="inline-flex">
              <Button
                variant="primary"
                size="sm"
                className={cn(
                  "h-6 rounded-r-none px-1.5 text-[11px]",
                  pushHighlighted && "ring-2 ring-amber-500/60 bg-amber-600 text-white"
                )}
                disabled={!laneId || busyAction != null}
                onClick={() => runPush(false)}
                title={pushButtonTitle}
              >
                <Upload className="h-3 w-3" />
              </Button>
              <Button
                variant="primary"
                size="sm"
                className={cn(
                  "h-6 rounded-l-none border-l border-white/20 px-0.5",
                  pushHighlighted && "ring-2 ring-amber-500/60 bg-amber-600 text-white"
                )}
                disabled={!laneId || busyAction != null}
                onClick={() => setPushDropdownOpen((prev) => !prev)}
                title="Push options"
              >
                <ChevronDown className="h-3 w-3" />
              </Button>
            </div>
            {pushDropdownOpen ? (
              <div className="absolute right-0 top-full z-50 mt-1 w-52 rounded-xl border border-border/60 bg-[--color-surface-overlay] py-1 shadow-float backdrop-blur-xl">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg hover:bg-muted/50"
                  onClick={() => runPush(false)}
                >
                  <span className="w-3 shrink-0" />
                  <div className="font-medium">{syncStatus?.hasUpstream === false ? "Publish lane" : "Push updates"}</div>
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg hover:bg-muted/50"
                  onClick={() => runPush(true)}
                >
                  <span className="w-3 shrink-0" />
                  <div>
                    <div className={cn("font-medium", forcePushHighlighted && "text-amber-700")}>
                      Force Push (lease){forcePushHighlighted ? " · Recommended" : ""}
                    </div>
                    <div className="text-[10px] text-muted-fg">Use after rebase or rewritten history</div>
                  </div>
                </button>
              </div>
            ) : null}
          </div>

          {lane?.parentLaneId ? (
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-1.5 text-[11px]"
              title="Rebase onto parent"
              disabled={!laneId || busyAction != null}
              onClick={() => {
                if (!laneId) return;
                runAction("rebase", async () => {
                  const result = await window.ade.lanes.restack({ laneId, recursive: true });
                  if (result.error) {
                    throw new Error(result.failedLaneId ? `${result.error} (failed: ${result.failedLaneId})` : result.error);
                  }
                });
              }}
            >
              <Layers3 className="h-3 w-3" />
            </Button>
          ) : null}
          {lane?.parentLaneId ? (
            <Button
              variant="outline"
              size="sm"
              className={cn("h-6 px-1.5 text-[11px]", restackPublishHighlighted && "ring-2 ring-amber-500/60 bg-amber-500/10 text-amber-800")}
              title="Restack onto parent, then publish with confirmation"
              disabled={!laneId || busyAction != null}
              onClick={() => runRestackAndPublishFlow(true)}
            >
              Sync
            </Button>
          ) : null}

          {/* More dropdown */}
          <div className="relative" ref={moreDropdownRef}>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              title="More actions"
              onClick={() => setMoreDropdownOpen((prev) => !prev)}
            >
              <MoreHorizontal className="h-3 w-3" />
            </Button>
            {moreDropdownOpen ? (
              <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-xl border border-border/60 bg-[--color-surface-overlay] py-1 shadow-float backdrop-blur-xl">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg hover:bg-muted/50"
                  onClick={() => {
                    setMoreDropdownOpen(false);
                    if (!laneId) return;
                    runAction("stash push", async () => {
                      const msg = await requestTextInput({ title: "Stash message", placeholder: "optional" });
                      if (msg == null) throw new Error("__ade_cancelled__");
                      await window.ade.git.stashPush({ laneId, message: msg || undefined });
                    });
                  }}
                >
                  Stash changes
                </button>
                <button
                  type="button"
                  className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg hover:bg-muted/50", stashes.length === 0 && "opacity-40 pointer-events-none")}
                  onClick={() => {
                    setMoreDropdownOpen(false);
                    if (!laneId || stashes.length === 0) return;
                    runAction("stash pop", async () => {
                      await window.ade.git.stashPop({ laneId, stashRef: stashes[0]!.ref });
                    });
                  }}
                >
                  Pop stash{stashes.length > 0 ? ` (${stashes[0]?.ref})` : ""}
                </button>
                <div className="my-1 h-px bg-border/15" />
                <button
                  type="button"
                  className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg hover:bg-muted/50", recentCommits.length === 0 && "opacity-40 pointer-events-none")}
                  onClick={() => {
                    setMoreDropdownOpen(false);
                    if (!laneId || recentCommits.length === 0) return;
                    runAction("revert commit", async () => {
                      const sha = await requestTextInput({
                        title: "Commit SHA to revert",
                        defaultValue: recentCommits[0]!.sha,
                        validate: (value) => (value ? null : "Commit SHA is required")
                      });
                      if (!sha) throw new Error("__ade_cancelled__");
                      await window.ade.git.revertCommit({ laneId, commitSha: sha });
                    });
                  }}
                >
                  Revert commit...
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg hover:bg-muted/50"
                  onClick={() => {
                    setMoreDropdownOpen(false);
                    if (!laneId) return;
                    runAction("cherry-pick", async () => {
                      const sha = await requestTextInput({
                        title: "Commit SHA to cherry-pick",
                        validate: (value) => (value ? null : "Commit SHA is required")
                      });
                      if (!sha) throw new Error("__ade_cancelled__");
                      await window.ade.git.cherryPickCommit({ laneId, commitSha: sha });
                    });
                  }}
                >
                  Cherry-pick...
                </button>
              </div>
            ) : null}
          </div>

          <div className="h-4 w-px bg-border/20" />

          <input
            className="h-6 min-w-[80px] max-w-[160px] flex-1 rounded-lg bg-muted/30 px-1.5 text-[11px] outline-none focus:ring-1 focus:ring-accent/30"
            placeholder="Commit message..."
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
          <Button
            variant="outline"
            size="sm"
            className={cn("h-6 px-1.5 text-[11px]", amendCommit && "bg-amber-500/10 border-amber-500/40 text-amber-800")}
            title="Amend the latest commit using this message"
            disabled={busyAction != null}
            onClick={() => setAmendCommit((prev) => !prev)}
          >
            Amend
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="h-6 px-1.5 text-[11px]"
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
            {amendCommit ? "Amend" : "Commit"}
          </Button>
        </div>
      </div>

      {nextActionHint ? (
        <div className={cn(
          "shrink-0 border-b border-border/15 px-2 py-1 text-[10px] flex items-center gap-2",
          nextActionHint.action === "restack_publish" && "bg-amber-500/12 text-amber-800",
          nextActionHint.action === "pull" && !divergedSync && "bg-sky-500/8 text-sky-700",
          nextActionHint.action === "push" && "bg-emerald-500/8 text-emerald-700",
          nextActionHint.action === "force_push_lease" && "bg-amber-500/12 text-amber-800",
          divergedSync && "bg-amber-500/12 text-amber-800"
        )}>
          <span className="font-semibold uppercase tracking-wide">Next: {nextActionHint.label}</span>
          <span className="truncate text-muted-fg">{nextActionHint.detail}</span>
          <div className="ml-auto flex items-center gap-1">
            {nextActionHint.action === "pull" ? (
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-[10px] border border-sky-500/30 hover:bg-sky-500/15"
                disabled={!laneId || busyAction != null}
                onClick={() => {
                  if (!laneId) return;
                  runPull(syncMode);
                }}
              >
                Pull ({syncMode}) now
              </button>
            ) : null}
            {nextActionHint.action === "restack_publish" ? (
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-[10px] border border-amber-500/40 hover:bg-amber-500/20"
                disabled={!laneId || busyAction != null}
                onClick={() => runRestackAndPublishFlow(true)}
              >
                Restack + publish
              </button>
            ) : null}
            {nextActionHint.action === "pull" && divergedSync ? (
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-[10px] border border-amber-500/40 hover:bg-amber-500/20"
                disabled={!laneId || busyAction != null}
                onClick={() => runPush(true)}
              >
                Force push (lease)
              </button>
            ) : null}
            {nextActionHint.action === "push" ? (
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-[10px] border border-emerald-500/30 hover:bg-emerald-500/15"
                disabled={!laneId || busyAction != null}
                onClick={() => runPush(false)}
              >
                {syncStatus?.hasUpstream === false ? "Publish now" : "Push now"}
              </button>
            ) : null}
            {nextActionHint.action === "force_push_lease" ? (
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-[10px] border border-amber-500/40 hover:bg-amber-500/20"
                disabled={!laneId || busyAction != null}
                onClick={() => runPush(true)}
              >
                Force push now
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {nextActionHint?.action === "restack_publish" && !autoRebaseEnabled ? (
        <div className="shrink-0 border-b border-border/15 bg-sky-500/8 px-2 py-1 text-[10px] text-sky-700">
          <div className="flex items-center gap-2">
            <span className="truncate">Auto-rebase is off. Enable it in Settings to auto-sync child lanes when parent/main advances.</span>
            <button
              type="button"
              className="ml-auto rounded px-1.5 py-0.5 text-[10px] border border-sky-500/30 hover:bg-sky-500/15"
              onClick={onOpenSettings}
            >
              Open settings
            </button>
          </div>
        </div>
      ) : null}

      {autoRebaseStatus ? (
        <div
          className={cn(
            "shrink-0 border-b border-border/15 px-2 py-1 text-[10px] flex items-center gap-2",
            autoRebaseStatus.state === "autoRebased" && "bg-emerald-500/8 text-emerald-700",
            autoRebaseStatus.state === "rebasePending" && "bg-amber-500/12 text-amber-800",
            autoRebaseStatus.state === "rebaseConflict" && "bg-red-500/12 text-red-200"
          )}
        >
          <span className="font-semibold uppercase tracking-wide">
            {autoRebaseStatus.state === "autoRebased" ? "Auto rebased" : autoRebaseStatus.state === "rebaseConflict" ? "Auto rebase blocked" : "Auto rebase pending"}
          </span>
          <span className="truncate text-muted-fg">
            {autoRebaseStatus.message ??
              (autoRebaseStatus.state === "autoRebased"
                ? "Lane was rebased automatically."
                : autoRebaseStatus.state === "rebaseConflict"
                  ? "Conflicts are expected. Resolve manually, then publish."
                  : "Waiting for manual sync.")}
          </span>
          {autoRebaseStatus.state !== "autoRebased" ? (
            <div className="ml-auto">
              {autoRebaseStatus.state === "rebaseConflict" ? (
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 text-[10px] border border-red-500/35 hover:bg-red-500/20"
                  disabled={!laneId || busyAction != null}
                  onClick={() => {
                    if (!laneId) return;
                    onResolveRebaseConflict?.(laneId, rebaseConflictParentLaneId);
                  }}
                >
                  Resolve in Conflicts
                </button>
              ) : (
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 text-[10px] border border-amber-500/40 hover:bg-amber-500/20"
                  disabled={!laneId || busyAction != null}
                  onClick={() => runRestackAndPublishFlow(true)}
                >
                  Restack + publish
                </button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* File list + commit timeline */}
      <div className="flex-1 min-h-0">
        <Group id={`lane-git-sections:${laneId ?? "none"}`} orientation="horizontal" className="h-full w-full min-h-0">
          <Panel id={`lane-git-files:${laneId ?? "none"}`} defaultSize="58%" minSize="22%" className="min-h-0 min-w-0">
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex items-center justify-between px-2 py-1 bg-card/30 shrink-0 border-r border-border/10">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-muted-fg/70">Files</span>
                  <Chip className="text-[10px] h-4 px-1">{changedFileCount}</Chip>
                  {stagedCount > 0 ? (
                    <span className="text-[10px] text-muted-fg">({stagedCount} staged)</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className="text-[10px] px-1 text-muted-fg hover:text-fg"
                    onClick={() => setShowStashes((prev) => !prev)}
                  >
                    {showStashes ? "Hide stashes" : `Show stashes (${stashes.length})`}
                  </button>
                  {changes.unstaged.length > 0 ? (
                    <button type="button" className="text-[10px] text-muted-fg hover:text-fg px-1" onClick={stageAll}>
                      Stage All
                    </button>
                  ) : null}
                  {changes.staged.length > 0 ? (
                    <button type="button" className="text-[10px] text-muted-fg hover:text-fg px-1" onClick={unstageAll}>
                      Unstage All
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="flex-1 min-h-0 border-r border-border/10">
                {showStashes ? (
                  <Group id={`lane-git-left:${laneId ?? "none"}`} orientation="vertical" className="h-full w-full min-h-0">
                    <Panel id={`lane-git-stashes:${laneId ?? "none"}`} defaultSize="38%" minSize="14%" className="min-h-0 min-w-0">
                      <div className="h-full overflow-auto bg-card/20 px-2 py-1.5">
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] uppercase tracking-wide text-muted-fg">Stashes</span>
                            <Chip className="h-4 px-1 text-[10px]">{stashes.length}</Chip>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-5 px-1.5 text-[10px]"
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
                            Stash now
                          </Button>
                        </div>
                        {stashes.length === 0 ? (
                          <div className="rounded-lg bg-muted/20 px-2 py-1 text-[10px] text-muted-fg">No stashes in this lane.</div>
                        ) : (
                          <div className="space-y-1">
                            {stashes.slice(0, 4).map((stash) => (
                              <div key={stash.ref} className="flex items-center gap-2 rounded-lg bg-muted/20 px-2 py-1">
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-[11px] text-fg">{stash.subject || stash.ref}</div>
                                  <div className="truncate text-[10px] text-muted-fg">{stash.ref} · {formatRelativeTime(stash.createdAt)}</div>
                                </div>
                                <button
                                  type="button"
                                  className="rounded px-1 py-0.5 text-[10px] text-sky-700 hover:bg-sky-500/10"
                                  disabled={!laneId || busyAction != null}
                                  onClick={() => {
                                    if (!laneId) return;
                                    runAction("stash apply", async () => {
                                      await window.ade.git.stashApply({ laneId, stashRef: stash.ref });
                                    });
                                  }}
                                >
                                  apply
                                </button>
                                <button
                                  type="button"
                                  className="rounded px-1 py-0.5 text-[10px] text-amber-700 hover:bg-amber-500/10"
                                  disabled={!laneId || busyAction != null}
                                  onClick={() => {
                                    if (!laneId) return;
                                    runAction("stash pop", async () => {
                                      await window.ade.git.stashPop({ laneId, stashRef: stash.ref });
                                    });
                                  }}
                                >
                                  pop
                                </button>
                                <button
                                  type="button"
                                  className="rounded px-1 py-0.5 text-[10px] text-red-700 hover:bg-red-500/10"
                                  disabled={!laneId || busyAction != null}
                                  onClick={() => {
                                    if (!laneId) return;
                                    runAction("stash drop", async () => {
                                      await window.ade.git.stashDrop({ laneId, stashRef: stash.ref });
                                    });
                                  }}
                                >
                                  drop
                                </button>
                              </div>
                            ))}
                            {stashes.length > 4 ? (
                              <div className="text-[10px] text-muted-fg">+{stashes.length - 4} more stash entries.</div>
                            ) : null}
                          </div>
                        )}
                      </div>
                    </Panel>
                    <ResizeGutter orientation="horizontal" thin />
                    <Panel id={`lane-git-file-list:${laneId ?? "none"}`} defaultSize="62%" minSize="16%" className="min-h-0 min-w-0">
                      <div className="h-full overflow-auto p-1 space-y-2">
                        {changes.staged.length > 0 ? (
                          <div className="space-y-0.5">
                            <div className="px-2 pb-0.5 text-[10px] uppercase tracking-wide text-muted-fg">Staged ({changes.staged.length})</div>
                            {changes.staged.map((file) => renderFileRow(file, "staged"))}
                          </div>
                        ) : null}
                        {changes.unstaged.length > 0 ? (
                          <div className="space-y-0.5">
                            <div className="px-2 pb-0.5 text-[10px] uppercase tracking-wide text-muted-fg">Unstaged ({changes.unstaged.length})</div>
                            {changes.unstaged.map((file) => renderFileRow(file, "unstaged"))}
                          </div>
                        ) : null}
                        {changes.staged.length === 0 && changes.unstaged.length === 0 ? (
                          <div className="p-3 text-center text-[11px] text-muted-fg opacity-50 italic">No changes</div>
                        ) : null}
                      </div>
                    </Panel>
                  </Group>
                ) : (
                  <div className="h-full overflow-auto p-1 space-y-2">
                    {changes.staged.length > 0 ? (
                      <div className="space-y-0.5">
                        <div className="px-2 pb-0.5 text-[10px] uppercase tracking-wide text-muted-fg">Staged ({changes.staged.length})</div>
                        {changes.staged.map((file) => renderFileRow(file, "staged"))}
                      </div>
                    ) : null}
                    {changes.unstaged.length > 0 ? (
                      <div className="space-y-0.5">
                        <div className="px-2 pb-0.5 text-[10px] uppercase tracking-wide text-muted-fg">Unstaged ({changes.unstaged.length})</div>
                        {changes.unstaged.map((file) => renderFileRow(file, "unstaged"))}
                      </div>
                    ) : null}
                    {changes.staged.length === 0 && changes.unstaged.length === 0 ? (
                      <div className="p-3 text-center text-[11px] text-muted-fg opacity-50 italic">No changes</div>
                    ) : null}
                  </div>
                )}
              </div>
            </div>
          </Panel>
          <ResizeGutter orientation="vertical" thin />
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
        <div className={cn("shrink-0 flex items-center justify-between border-t border-border/15 px-2 py-0.5 text-[11px]", error ? "bg-red-50 text-red-800" : "bg-accent/10 text-accent")}>
          <span>{error ? `Error: ${error}` : notice ? notice : busyAction ? `Running ${busyAction}...` : ""}</span>
        </div>
      )}

      {/* Text prompt modal */}
      {textPrompt ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4">
          <div className="w-[min(460px,100%)] rounded-2xl bg-card/95 backdrop-blur-xl p-4 shadow-float">
            <div className="text-sm font-semibold text-fg">{textPrompt.title}</div>
            {textPrompt.message ? <div className="mt-1 text-xs text-muted-fg">{textPrompt.message}</div> : null}
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
              className="mt-3 h-9 w-full rounded-xl bg-muted/30 shadow-card px-2 text-sm outline-none focus:ring-1 focus:ring-accent/30"
            />
            {textPromptError ? <div className="mt-2 text-xs text-red-400">{textPromptError}</div> : null}
            <div className="mt-4 flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={cancelTextPrompt}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" onClick={submitTextPrompt}>
                {textPrompt.confirmLabel}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

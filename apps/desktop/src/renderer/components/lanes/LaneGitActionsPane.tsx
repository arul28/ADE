import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { CommitTimeline } from "./CommitTimeline";
import type {
  DiffChanges,
  FileChange,
  GitCommitSummary,
  GitStashSummary,
  GitSyncMode
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
  onSelectFile,
  onSelectCommit,
  selectedPath,
  selectedCommitSha
}: {
  laneId: string | null;
  onSelectFile: (path: string, mode: "staged" | "unstaged") => void;
  onSelectCommit: (commit: GitCommitSummary | null) => void;
  selectedPath: string | null;
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
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [textPrompt, setTextPrompt] = useState<LaneTextPromptState | null>(null);
  const [textPromptError, setTextPromptError] = useState<string | null>(null);
  const [commitTimelineKey, setCommitTimelineKey] = useState(0);
  const [pullDropdownOpen, setPullDropdownOpen] = useState(false);
  const [moreDropdownOpen, setMoreDropdownOpen] = useState(false);
  const [showStashes, setShowStashes] = useState(true);
  const pullDropdownRef = useRef<HTMLDivElement>(null);
  const moreDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (pullDropdownRef.current && !pullDropdownRef.current.contains(e.target as Node)) {
        setPullDropdownOpen(false);
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
    try {
      const [nextStashes, nextCommits] = await Promise.all([
        window.ade.git.stashList({ laneId }),
        window.ade.git.listRecentCommits({ laneId, limit: 20 })
      ]);
      setStashes(nextStashes);
      setRecentCommits(nextCommits);
    } catch {
      // best effort
    }
  };

  const refreshAll = async () => {
    await Promise.all([refreshChanges(), refreshLanes(), refreshGitMeta()]);
    setCommitTimelineKey((prev) => prev + 1);
  };

  const runAction = async (actionName: string, fn: () => Promise<void>) => {
    setBusyAction(actionName);
    setNotice(null);
    setError(null);
    try {
      await fn();
      await refreshAll();
      setNotice(`${actionName} completed`);
      setTimeout(() => setNotice(null), 3000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "__ade_cancelled__") return;
      setError(message);
    } finally {
      setBusyAction(null);
    }
  };

  useEffect(() => {
    setChanges({ staged: [], unstaged: [] });
    setStashes([]);
    setRecentCommits([]);
    setNotice(null);
    setError(null);
    if (!laneId) return;
    refreshAll().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [laneId, lane?.branchRef]);

  const unifiedFiles = useMemo(() => {
    const files: Array<FileChange & { staged: boolean }> = [];
    const seenPaths = new Set<string>();
    for (const f of changes.staged) {
      files.push({ ...f, staged: true });
      seenPaths.add(f.path);
    }
    for (const f of changes.unstaged) {
      if (!seenPaths.has(f.path)) {
        files.push({ ...f, staged: false });
      }
    }
    return files;
  }, [changes]);

  const stagedCount = changes.staged.length;
  const hasStaged = stagedCount > 0;

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
              {"\u2191"}{lane.status.ahead} {"\u2193"}{lane.status.behind}
            </span>
          ) : null}

          <div className="flex-1 min-w-[4px]" />

          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => refreshAll().catch(() => {})} title="Refresh">
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
          </Button>

          {/* Pull dropdown */}
          <div className="relative" ref={pullDropdownRef}>
            <div className="inline-flex">
              <Button
                variant="outline"
                size="sm"
                className="h-6 rounded-r-none border-r-0 px-1.5 text-[11px]"
                disabled={!laneId || busyAction != null}
                onClick={() => {
                  if (!laneId) return;
                  setPullDropdownOpen(false);
                  runAction("pull", async () => { await window.ade.git.sync({ laneId, mode: syncMode }); });
                }}
                title={`Pull (${syncMode})`}
              >
                <ArrowDown className="h-3 w-3" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-6 rounded-l-none px-0.5"
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
                  onClick={() => { setSyncMode("merge"); setPullDropdownOpen(false); if (laneId) runAction("pull", async () => { await window.ade.git.sync({ laneId, mode: "merge" }); }); }}
                >
                  {syncMode === "merge" ? <Check className="h-3 w-3 shrink-0" /> : <span className="w-3 shrink-0" />}
                  <div>
                    <div className="font-medium">Pull (merge)</div>
                  </div>
                </button>
                <button
                  type="button"
                  className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg hover:bg-muted/50", syncMode === "rebase" && "text-accent")}
                  onClick={() => { setSyncMode("rebase"); setPullDropdownOpen(false); if (laneId) runAction("pull", async () => { await window.ade.git.sync({ laneId, mode: "rebase" }); }); }}
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

          <Button
            variant="primary"
            size="sm"
            className="h-6 px-1.5 text-[11px]"
            disabled={!laneId || busyAction != null}
            onClick={() => { if (laneId) runAction("push", async () => { await window.ade.git.push({ laneId }); }); }}
            title="Push"
          >
            <Upload className="h-3 w-3" />
          </Button>

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
                if (laneId && commitMessage.trim() && hasStaged) {
                  runAction("commit", async () => {
                    await window.ade.git.commit({ laneId, message: commitMessage.trim() });
                    setCommitMessage("");
                  });
                }
              }
            }}
          />
          <Button
            variant="primary"
            size="sm"
            className="h-6 px-1.5 text-[11px]"
            disabled={!commitMessage.trim() || !hasStaged || busyAction != null}
            onClick={() => {
              if (laneId)
                runAction("commit", async () => {
                  await window.ade.git.commit({ laneId, message: commitMessage.trim() });
                  setCommitMessage("");
                });
            }}
          >
            Commit
          </Button>
        </div>
      </div>

      {/* File list + commit timeline */}
      <div className="flex-1 min-h-0 flex">
        {/* Files */}
        <div className="flex-1 min-w-0 flex flex-col border-r border-border/10">
          <div className="flex items-center justify-between px-2 py-1 bg-card/30 shrink-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-fg/70">Files</span>
              <Chip className="text-[10px] h-4 px-1">{unifiedFiles.length}</Chip>
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
          {showStashes ? (
            <div className="shrink-0 border-b border-border/10 bg-card/20 px-2 py-1.5">
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
          ) : null}
          <div className="flex-1 overflow-auto p-1 space-y-0.5">
            {unifiedFiles.map((file) => (
              <div
                key={file.path}
                className={cn(
                  "group flex items-center gap-1.5 px-2 py-1 rounded-lg cursor-pointer text-[11px]",
                  selectedPath === file.path ? "bg-accent/10 text-fg shadow-card" : "hover:bg-muted/30 text-muted-fg hover:text-fg"
                )}
                onClick={() => {
                  onSelectCommit(null);
                  const mode = file.staged ? "staged" : "unstaged";
                  onSelectFile(file.path, mode);
                }}
              >
                <button
                  type="button"
                  className="shrink-0 h-3.5 w-3.5 rounded bg-muted/30 flex items-center justify-center hover:bg-accent/10"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleStageFile(file.path, file.staged);
                  }}
                  title={file.staged ? "Unstage" : "Stage"}
                >
                  {file.staged ? <Check className="h-2 w-2 text-accent" /> : null}
                </button>
                <span className={cn("inline-block w-1.5 h-1.5 rounded-full shrink-0",
                  file.kind === "modified" ? "bg-blue-400" :
                    file.kind === "added" ? "bg-emerald-400" :
                      file.kind === "deleted" ? "bg-red-400" : "bg-amber-400"
                )} />
                <span className="truncate flex-1">{file.path}</span>
              </div>
            ))}
            {unifiedFiles.length === 0 && (
              <div className="p-3 text-center text-[11px] text-muted-fg opacity-50 italic">
                No changes
              </div>
            )}
          </div>
        </div>

        {/* Commit timeline */}
        <div className="w-[40%] min-w-[120px] shrink-0">
          <CommitTimeline
            laneId={laneId ?? null}
            selectedSha={selectedCommitSha}
            refreshTrigger={commitTimelineKey}
            onSelectCommit={(commit) => {
              onSelectCommit(commit);
            }}
          />
        </div>
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

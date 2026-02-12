import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ArrowRight, Columns, GitMerge, Layers3, MoreHorizontal, RefreshCw, Save, Undo2, Upload } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { EmptyState } from "../ui/EmptyState";
import { useAppStore } from "../../state/appStore";
import { PaneHeader } from "../ui/PaneHeader";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { cn } from "../ui/cn";
import type {
  DiffChanges,
  FileDiff,
  FileChange,
  GitCommitSummary,
  GitStashSummary,
  GitSyncMode
} from "../../../shared/types";
import { MonacoDiffView, type MonacoDiffHandle } from "./MonacoDiffView";

function formatTs(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleString();
}

type LaneTextPromptState = {
  title: string;
  message?: string;
  placeholder?: string;
  value: string;
  confirmLabel: string;
  validate?: (value: string) => string | null;
  resolve: (value: string | null) => void;
};

export function LaneDetail({
  overrideLaneId,
  isPrimary,
  onSplit
}: {
  overrideLaneId?: string;
  isPrimary?: boolean;
  onSplit?: () => void;
}) {
  const globalLaneId = useAppStore((s) => s.selectedLaneId);
  const laneId = overrideLaneId ?? globalLaneId;
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const selectLane = useAppStore((s) => s.selectLane);

  const lane = useMemo(() => lanes.find((entry) => entry.id === laneId) ?? null, [lanes, laneId]);
  const laneName = lane?.name ?? null;
  const parentLane = useMemo(
    () => (lane?.parentLaneId ? lanes.find((entry) => entry.id === lane.parentLaneId) ?? null : null),
    [lane, lanes]
  );
  const childLanes = useMemo(
    () =>
      lane
        ? lanes
          .filter((entry) => entry.parentLaneId === lane.id)
          .sort((a, b) => {
            const aTs = Date.parse(a.createdAt);
            const bTs = Date.parse(b.createdAt);
            if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && aTs !== bTs) return aTs - bTs;
            return a.name.localeCompare(b.name);
          })
        : [],
    [lane, lanes]
  );

  const [loading, setLoading] = useState(false);
  const [changes, setChanges] = useState<DiffChanges>({ unstaged: [], staged: [] });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);

  const [commitMessage, setCommitMessage] = useState("");
  const [syncMode, setSyncMode] = useState<GitSyncMode>("merge");

  const [stashes, setStashes] = useState<GitStashSummary[]>([]);
  const [recentCommits, setRecentCommits] = useState<GitCommitSummary[]>([]);
  const [gitActionsOpen, setGitActionsOpen] = useState(false);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [textPrompt, setTextPrompt] = useState<LaneTextPromptState | null>(null);
  const [textPromptError, setTextPromptError] = useState<string | null>(null);

  const diffRef = useRef<MonacoDiffHandle | null>(null);

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
      // If selected path is gone, clear selection
      if (selectedPath && ![...next.staged, ...next.unstaged].some((f) => f.path === selectedPath)) {
        setSelectedPath(null);
        setDiff(null);
      }
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
    } catch (e) {
      console.error("Failed to refresh git meta", e);
    }
  };

  const refreshAll = async () => {
    await Promise.all([refreshChanges(), refreshLanes(), refreshGitMeta()]);
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
    setSelectedPath(null);
    setDiff(null);
    setChanges({ staged: [], unstaged: [] });
    setStashes([]);
    setRecentCommits([]);
    setNotice(null);
    setError(null);
    if (!laneId) return;
    refreshAll().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [laneId]);

  // Determine which mode (staged/unstaged) the selected file belongs to for diff fetching
  const selectedFileMode = useMemo(() => {
    if (!selectedPath) return null;
    if (changes.unstaged.some(f => f.path === selectedPath)) return "unstaged";
    if (changes.staged.some(f => f.path === selectedPath)) return "staged";
    return null;
  }, [changes, selectedPath]);

  useEffect(() => {
    setDiff(null);
    if (!laneId || !selectedPath || !selectedFileMode) return;
    const mode = selectedFileMode as "staged" | "unstaged"; // Help TS
    window.ade.diff
      .getFile({ laneId, path: selectedPath, mode })
      .then((value) => setDiff(value))
      .catch(() => setDiff(null));
  }, [laneId, selectedPath, selectedFileMode]);

  const stageFile = async (path: string) => {
    if (!laneId) return;
    await window.ade.git.stageFile({ laneId, path });
  };

  const unstageFile = async (path: string) => {
    if (!laneId) return;
    await window.ade.git.unstageFile({ laneId, path });
  };

  const stageAll = async () => {
    if (!laneId) return;
    // MVP: simple loop or specialized IPC. Loop is fine for small checks.
    // Better: use '.'? But let's act on specific files to be safe or use IPC if available.
    // We'll map mostly.
    runAction("stage all", async () => {
      // Sequentially to avoid race? Parallel usually ok.
      await Promise.all(changes.unstaged.map(f => window.ade.git.stageFile({ laneId, path: f.path })));
    });
  };

  const unstageAll = async () => {
    if (!laneId) return;
    runAction("unstage all", async () => {
      await Promise.all(changes.staged.map(f => window.ade.git.unstageFile({ laneId, path: f.path })));
    });
  };

  const renderFileList = (title: string, files: FileChange[], actionLabel: string, onAction: (path: string) => void, onAll?: () => void) => (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-border bg-card/50">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-fg">{title}</span>
          <Chip className="text-[10px] h-4 px-1">{files.length}</Chip>
        </div>
        {files.length > 0 && onAll ? (
          <Button variant="ghost" size="sm" className="h-5 text-[10px] px-1" onClick={onAll}>
            {actionLabel} All
          </Button>
        ) : null}
      </div>
      <div className="flex-1 overflow-auto p-1 space-y-0.5">
        {files.map(file => (
          <div
            key={file.path}
            className={cn(
              "group flex items-center justify-between gap-2 px-2 py-1 rounded cursor-pointer text-xs border border-transparent",
              selectedPath === file.path ? "bg-accent/10 border-accent/20 text-fg" : "hover:bg-muted/50 text-muted-fg hover:text-fg"
            )}
            onClick={() => setSelectedPath(file.path)}
          >
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span className={cn("inline-block w-1.5 h-1.5 rounded-full shrink-0",
                file.kind === "modified" ? "bg-blue-400" :
                  file.kind === "added" ? "bg-emerald-400" :
                    file.kind === "deleted" ? "bg-red-400" : "bg-amber-400"
              )} />
              <span className="truncate">{file.path}</span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100"
              onClick={(e) => { e.stopPropagation(); runAction(actionLabel, () => Promise.resolve(onAction(file.path))); }}
              title={actionLabel}
            >
              {actionLabel === "Stage" ? <ArrowRight className="h-3 w-3" /> : <Undo2 className="h-3 w-3" />}
            </Button>
          </div>
        ))}
        {files.length === 0 && (
          <div className="p-4 text-center text-xs text-muted-fg opacity-50 italic">
            No files
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <PaneHeader
        title="Changes"
        meta={laneName}
        right={
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => refreshAll().catch(() => { })} title="Refresh">
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            </Button>
            {lane?.parentLaneId ? (
              <>
                <div className="h-4 w-px bg-border mx-1" />
                <Button
                  variant="outline"
                  size="sm"
                  title="Rebase reapplies this lane (and descendants) onto the current parent lane HEAD."
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
                  <Layers3 className="h-3.5 w-3.5 mr-1.5" /> Rebase
                </Button>
              </>
            ) : null}
            <div className="h-4 w-px bg-border mx-1" />
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              title="More git actions"
              onClick={() => setGitActionsOpen(true)}
            >
              <MoreHorizontal className="mr-1 h-4 w-4" />
              Git actions
            </Button>
            <div className="h-4 w-px bg-border mx-1" />

            {onSplit && (
              <Button variant="ghost" size="sm" onClick={onSplit} title="Split View">
                <Columns className="h-4 w-4" />
              </Button>
            )}

            <div className="h-4 w-px bg-border mx-1" />
            <Button
              variant="outline"
              size="sm"
              disabled={!laneId || busyAction != null}
              onClick={() => { if (laneId) runAction("fetch", async () => { await window.ade.git.fetch({ laneId }); }) }}
              title="Fetch updates from remotes into this lane's git metadata."
            >
              <ArrowDownToLine className="h-3.5 w-3.5 mr-1.5" /> Fetch
            </Button>
            <select
              value={syncMode}
              onChange={(event) => setSyncMode(event.target.value as GitSyncMode)}
              className="h-7 rounded border border-border bg-card/70 px-2 text-xs"
              title="Pull strategy: merge creates a merge commit. rebase rewrites lane commits on top of base."
            >
              <option value="merge">pull: merge</option>
              <option value="rebase">pull: rebase</option>
            </select>
            <Button
              variant="outline"
              size="sm"
              disabled={!laneId || busyAction != null}
              onClick={() => { if (laneId) runAction("pull", async () => { await window.ade.git.sync({ laneId, mode: syncMode }); }) }}
              title={`Pull brings ${lane?.baseRef ?? "base ref"} into this lane using ${syncMode}.`}
            >
              <GitMerge className="h-3.5 w-3.5 mr-1.5" /> Pull
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!laneId || busyAction != null}
              onClick={() => { if (laneId) runAction("push", async () => { await window.ade.git.push({ laneId }); }) }}
              title="Push this lane branch to remote."
            >
              <Upload className="h-3.5 w-3.5 mr-1.5" /> Push
            </Button>
          </div>
        }
      />

      {lane && (parentLane || childLanes.length > 0) ? (
        <div className="border-b border-border bg-card/25 px-3 py-1.5 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            {parentLane ? (
              <>
                <span className="font-semibold text-muted-fg">Parent:</span>
                <button
                  type="button"
                  className="rounded border border-border bg-card/60 px-1.5 py-0.5 text-fg hover:border-accent"
                  onClick={() => selectLane(parentLane.id)}
                >
                  {parentLane.name}
                </button>
              </>
            ) : (
              <span className="text-muted-fg">Stack root</span>
            )}
            {childLanes.length > 0 ? (
              <>
                <span className="ml-2 font-semibold text-muted-fg">Children:</span>
                {childLanes.map((child) => (
                  <button
                    key={child.id}
                    type="button"
                    className="rounded border border-border bg-card/60 px-1.5 py-0.5 text-fg hover:border-accent"
                    onClick={() => selectLane(child.id)}
                  >
                    {child.name}
                  </button>
                ))}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      {lane ? (
        <div className="border-b border-border bg-card/20 px-3 py-1.5 text-[11px] text-muted-fg">
          <span className="font-semibold text-fg">Rebase</span>: rebase lane commits onto parent lane head.
          <span className="mx-2">|</span>
          <span className="font-semibold text-fg">Pull ({syncMode})</span>: bring <code>{lane.baseRef}</code> into this lane.
        </div>
      ) : null}

      <div className="flex-1 flex flex-col min-h-0">
        {/* Top Section: 2 Columns for Staging */}
        <div className="flex-none h-[42%] min-h-[180px] flex border-b border-border">
          {/* Unstaged Column */}
          <div className="flex-1 flex flex-col border-r border-border min-w-0">
            {renderFileList("Unstaged", changes.unstaged, "Stage", stageFile, stageAll)}
          </div>

          {/* Staged Column + Commit */}
          <div className="flex-1 flex flex-col min-w-0 bg-muted/10">
            <div className="flex-1 min-h-0">
              {renderFileList("Staged", changes.staged, "Unstage", unstageFile, unstageAll)}
            </div>
            {/* Commit Box */}
            <div className="p-3 border-t border-border bg-card">
              <div className="flex gap-2">
                <textarea
                  className="flex-1 h-[60px] p-2 text-xs bg-bg border border-border rounded resize-none focus:border-accent outline-none"
                  placeholder="Commit message..."
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      if (laneId && commitMessage.trim()) {
                        runAction("commit", async () => {
                          await window.ade.git.commit({ laneId, message: commitMessage.trim() });
                          setCommitMessage("");
                        });
                      }
                    }
                  }}
                />
                <div className="flex flex-col gap-1 w-[80px]">
                  <Button
                    variant="primary"
                    className="flex-1 h-full"
                    disabled={!commitMessage.trim() || changes.staged.length === 0 || busyAction != null}
                    onClick={() => {
                      if (laneId) runAction("commit", async () => {
                        await window.ade.git.commit({ laneId, message: commitMessage.trim() });
                        setCommitMessage("");
                      });
                    }}
                  >
                    Commit
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Section: Diff View */}
        <div className="flex-1 min-h-0 bg-bg">
          {!laneId ? (
            <div className="flex h-full items-center justify-center p-3">
              <EmptyState title="No lane selected" />
            </div>
          ) : !selectedPath ? (
            <div className="flex h-full items-center justify-center p-3">
              <EmptyState title="Select a file" description="View diff and quick edit" />
            </div>
          ) : !diff ? (
            <div className="flex items-center justify-center h-full text-muted-fg text-xs">Loading diff...</div>
          ) : (
            <div className="h-full flex flex-col">
              <div className="flex items-center justify-between px-3 py-1 border-b border-border bg-card/30">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-muted-fg">{selectedFileMode === "unstaged" ? "Working Tree" : "Index"}</span>
                  <span className="text-muted-fg">/</span>
                  <span className="font-semibold">{diff.path}</span>
                </div>
                {selectedFileMode === "unstaged" && !diff.isBinary && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6"
                    onClick={() => {
                      if (!laneId || !selectedPath) return;
                      const text = diffRef.current?.getModifiedValue();
                      if (text == null) return;
                      runAction("save edit", async () => {
                        await window.ade.files.writeTextAtomic({ laneId, path: selectedPath, text });
                      });
                    }}
                  >
                    <Save className="h-3.5 w-3.5 mr-1" />
                    Save
                  </Button>
                )}
              </div>
              <MonacoDiffView ref={diffRef} diff={diff} editable={selectedFileMode === "unstaged"} className="flex-1" />
            </div>
          )}
        </div>
      </div>

      <Dialog.Root open={gitActionsOpen} onOpenChange={setGitActionsOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-[18%] z-50 w-[min(560px,calc(100vw-24px))] -translate-x-1/2 rounded border border-border bg-card p-4 shadow-2xl focus:outline-none">
            <div className="mb-3 flex items-center justify-between gap-2">
              <Dialog.Title className="text-sm font-semibold">Git actions</Dialog.Title>
              <Dialog.Close asChild>
                <Button size="sm" variant="ghost">Esc</Button>
              </Dialog.Close>
            </div>

            <div className="space-y-3">
              <div className="rounded border border-border bg-bg/40 p-2">
                <div className="mb-2 text-xs font-semibold text-muted-fg">Stash</div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (!laneId) return;
                      setGitActionsOpen(false);
                      runAction("stash push", async () => {
                        const msg = await requestTextInput({
                          title: "Stash message",
                          placeholder: "optional"
                        });
                        if (msg == null) throw new Error("__ade_cancelled__");
                        await window.ade.git.stashPush({ laneId, message: msg || undefined });
                      });
                    }}
                  >
                    Push changes
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={stashes.length === 0}
                    onClick={() => {
                      if (!laneId || stashes.length === 0) return;
                      setGitActionsOpen(false);
                      runAction("stash pop", async () => {
                        await window.ade.git.stashPop({ laneId, stashRef: stashes[0]!.ref });
                      });
                    }}
                  >
                    Pop latest ({stashes[0]?.ref ?? "none"})
                  </Button>
                </div>
              </div>

              <div className="rounded border border-border bg-bg/40 p-2">
                <div className="mb-2 text-xs font-semibold text-muted-fg">History</div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={recentCommits.length === 0}
                    onClick={() => {
                      if (!laneId || recentCommits.length === 0) return;
                      setGitActionsOpen(false);
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
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (!laneId) return;
                      setGitActionsOpen(false);
                      runAction("cherry-pick commit", async () => {
                        const sha = await requestTextInput({
                          title: "Commit SHA to cherry-pick",
                          validate: (value) => (value ? null : "Commit SHA is required")
                        });
                        if (!sha) throw new Error("__ade_cancelled__");
                        await window.ade.git.cherryPickCommit({ laneId, commitSha: sha });
                      });
                    }}
                  >
                    Cherry-pick commit...
                  </Button>
                </div>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {textPrompt ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4">
          <div className="w-[min(460px,100%)] rounded border border-border bg-card p-4 shadow-2xl">
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
              className="mt-3 h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
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

      {/* Footer Info / Status Bar (optional, maybe specific lane errors/notices) */}
      {(notice || error || busyAction) && (
        <div className={cn("flex items-center justify-between border-t border-border px-3 py-1 text-xs", error ? "bg-red-50 text-red-800" : "bg-accent/10 text-accent")}>
          <span>{error ? `Error: ${error}` : notice ? notice : busyAction ? `Running ${busyAction}...` : ""}</span>
        </div>
      )}
    </div>
  );
}

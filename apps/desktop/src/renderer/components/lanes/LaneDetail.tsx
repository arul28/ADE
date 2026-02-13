import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Check, ChevronDown, Columns, FolderOpen, GitMerge, GripVertical, Layers3, MoreHorizontal, RefreshCw, Save, Upload } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Group, Panel, Separator } from "react-resizable-panels";
import { EmptyState } from "../ui/EmptyState";
import { useAppStore } from "../../state/appStore";
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
import { CommitTimeline } from "./CommitTimeline";

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
  const navigate = useNavigate();
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);

  const lane = useMemo(() => lanes.find((entry) => entry.id === laneId) ?? null, [lanes, laneId]);
  const laneName = lane?.name ?? null;

  const [loading, setLoading] = useState(false);
  const [changes, setChanges] = useState<DiffChanges>({ unstaged: [], staged: [] });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<GitCommitSummary | null>(null);
  const [commitFiles, setCommitFiles] = useState<string[]>([]);
  const [selectedCommitFilePath, setSelectedCommitFilePath] = useState<string | null>(null);
  const [commitDiff, setCommitDiff] = useState<FileDiff | null>(null);

  const [commitMessage, setCommitMessage] = useState("");
  const [syncMode, setSyncMode] = useState<GitSyncMode>("merge");

  const [stashes, setStashes] = useState<GitStashSummary[]>([]);
  const [recentCommits, setRecentCommits] = useState<GitCommitSummary[]>([]);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [textPrompt, setTextPrompt] = useState<LaneTextPromptState | null>(null);
  const [textPromptError, setTextPromptError] = useState<string | null>(null);

  // Dropdown state
  const [pullDropdownOpen, setPullDropdownOpen] = useState(false);
  const [moreDropdownOpen, setMoreDropdownOpen] = useState(false);
  const pullDropdownRef = useRef<HTMLDivElement>(null);
  const moreDropdownRef = useRef<HTMLDivElement>(null);

  const diffRef = useRef<MonacoDiffHandle | null>(null);

  // Close dropdowns on outside click
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
    setSelectedCommit(null);
    setCommitFiles([]);
    setSelectedCommitFilePath(null);
    setCommitDiff(null);
    setChanges({ staged: [], unstaged: [] });
    setStashes([]);
    setRecentCommits([]);
    setNotice(null);
    setError(null);
    if (!laneId) return;
    refreshAll().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [laneId]);

  // Unified file list: merge unstaged + staged, track which is which
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
    const mode = selectedFileMode as "staged" | "unstaged";
    window.ade.diff
      .getFile({ laneId, path: selectedPath, mode })
      .then((value) => setDiff(value))
      .catch(() => setDiff(null));
  }, [laneId, selectedPath, selectedFileMode]);

  useEffect(() => {
    setCommitFiles([]);
    setSelectedCommitFilePath(null);
    setCommitDiff(null);
    if (!laneId || !selectedCommit) return;

    let cancelled = false;
    window.ade.git
      .listCommitFiles({ laneId, commitSha: selectedCommit.sha })
      .then((files) => {
        if (cancelled) return;
        setCommitFiles(files);
        setSelectedCommitFilePath(files[0] ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setCommitFiles([]);
        setSelectedCommitFilePath(null);
      });
    return () => {
      cancelled = true;
    };
  }, [laneId, selectedCommit]);

  useEffect(() => {
    setCommitDiff(null);
    if (!laneId || !selectedCommit || !selectedCommitFilePath) return;
    let cancelled = false;
    window.ade.diff
      .getFile({
        laneId,
        path: selectedCommitFilePath,
        mode: "commit",
        compareRef: selectedCommit.sha,
        compareTo: "parent"
      })
      .then((value) => {
        if (!cancelled) setCommitDiff(value);
      })
      .catch(() => {
        if (!cancelled) setCommitDiff(null);
      });
    return () => {
      cancelled = true;
    };
  }, [laneId, selectedCommit, selectedCommitFilePath]);

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
      await Promise.all(changes.unstaged.map(f => window.ade.git.stageFile({ laneId, path: f.path })));
    });
  };

  const unstageAll = () => {
    if (!laneId) return;
    runAction("unstage all", async () => {
      await Promise.all(changes.staged.map(f => window.ade.git.unstageFile({ laneId, path: f.path })));
    });
  };

  const stagedCount = changes.staged.length;
  const hasStaged = stagedCount > 0;

  // --- Render ---

  const renderDiffSection = () => {
    if (!laneId) {
      return (
        <div className="flex h-full items-center justify-center p-3">
          <EmptyState title="No lane selected" />
        </div>
      );
    }

    if (selectedCommit) {
      return (
        <div className="h-full flex flex-col">
          <div className="flex items-center justify-between gap-2 px-3 py-1 border-b border-border bg-card/30">
            <div className="min-w-0 flex items-center gap-2 text-xs">
              <span className="font-mono text-muted-fg">Commit</span>
              <span className="text-muted-fg">/</span>
              <span className="font-mono text-fg">{selectedCommit.shortSha}</span>
              <span className="truncate text-muted-fg">{selectedCommit.subject}</span>
            </div>
            <div className="shrink-0">
              <Chip className="text-[10px]">{commitFiles.length} file{commitFiles.length === 1 ? "" : "s"}</Chip>
            </div>
          </div>
          <div className="flex-1 min-h-0">
            <Group
              id={`lane-commit-view:${laneId ?? "none"}:${selectedCommit.sha}`}
              orientation="horizontal"
              className="h-full min-h-0"
            >
              <Panel id="lane-commit-files" minSize={15} defaultSize={26} className="min-w-0 bg-card/20">
                <div className="flex h-full min-h-0 flex-col">
                  <div className="flex items-center justify-between border-b border-border bg-card/50 px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wider text-muted-fg">Files</span>
                      <Chip className="h-4 px-1 text-[10px]">{commitFiles.length}</Chip>
                    </div>
                  </div>
                  <div className="flex-1 min-h-0 overflow-auto p-1 space-y-0.5">
                    {commitFiles.length ? (
                      commitFiles.map((file) => (
                        <button
                          key={file}
                          type="button"
                          className={cn(
                            "group flex w-full items-center justify-between gap-2 rounded border px-2 py-1 text-left text-xs transition-colors",
                            selectedCommitFilePath === file
                              ? "border-accent/30 bg-accent/10 text-fg"
                              : "border-transparent text-muted-fg hover:border-border hover:bg-muted/40 hover:text-fg"
                          )}
                          onClick={() => setSelectedCommitFilePath(file)}
                          title={file}
                        >
                          <span className="truncate">{file}</span>
                        </button>
                      ))
                    ) : (
                      <div className="p-3 text-center text-xs text-muted-fg opacity-60 italic">
                        {selectedCommit ? "Loading files..." : "No commit selected"}
                      </div>
                    )}
                  </div>
                </div>
              </Panel>
              <Separator className="relative w-2 shrink-0 cursor-col-resize border-x border-border bg-card/40 transition-colors hover:bg-accent/30 data-[resize-handle-active]:bg-accent/30">
                <div className="absolute inset-0 flex items-center justify-center text-muted-fg/50">
                  <GripVertical className="h-3 w-3" />
                </div>
              </Separator>
              <Panel id="lane-commit-diff" minSize={30} defaultSize={74} className="min-w-0">
                {!selectedCommitFilePath ? (
                  <div className="flex h-full items-center justify-center p-3">
                    <EmptyState title="No files found" description="This commit may be empty or metadata-only." />
                  </div>
                ) : !commitDiff ? (
                  <div className="flex h-full items-center justify-center text-xs text-muted-fg">Loading commit diff...</div>
                ) : (
                  <MonacoDiffView diff={commitDiff} editable={false} className="h-full" />
                )}
              </Panel>
            </Group>
          </div>
        </div>
      );
    }

    if (!selectedPath) {
      return (
        <div className="flex h-full items-center justify-center p-3">
          <EmptyState title="Select a file or commit" description="Choose a changed file or pick a commit from the timeline." />
        </div>
      );
    }

    if (!diff) {
      return <div className="flex items-center justify-center h-full text-muted-fg text-xs">Loading diff...</div>;
    }

    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center justify-between px-3 py-1 border-b border-border bg-card/30">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-mono text-muted-fg">{selectedFileMode === "unstaged" ? "Working Tree" : "Index"}</span>
            <span className="text-muted-fg">/</span>
            <span className="font-semibold">{diff.path}</span>
          </div>
          <div className="flex items-center gap-2">
            {selectedFileMode === "unstaged" ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-6"
                onClick={() => {
                  if (!laneId || !selectedPath) return;
                  navigate("/files", { state: { openFilePath: selectedPath, laneId } });
                }}
                title="Open this file in the Files tab"
              >
                <FolderOpen className="h-3.5 w-3.5 mr-1" />
                Files
              </Button>
            ) : null}
            {selectedFileMode === "unstaged" && !diff.isBinary ? (
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
            ) : null}
          </div>
        </div>
        <MonacoDiffView ref={diffRef} diff={diff} editable={selectedFileMode === "unstaged"} className="flex-1" />
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      {/* === Header: two rows - lane info on left, toolbar wraps === */}
      <div className="shrink-0 border-b border-border bg-card/30 px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {/* Lane identity */}
          <span className={cn(
            "h-2 w-2 rounded-full shrink-0",
            lane?.laneType === "primary" ? "bg-emerald-500" : lane?.status.dirty ? "bg-amber-500" : "bg-sky-500"
          )} />
          <span className="text-xs font-semibold truncate max-w-[120px]">{laneName ?? "No lane"}</span>
          {lane ? (
            <span className="text-[10px] text-muted-fg font-mono shrink-0">
              {lane.branchRef} · ↑{lane.status.ahead} ↓{lane.status.behind}
            </span>
          ) : null}

          <div className="flex-1 min-w-[8px]" />

          {/* Git actions - wraps when space is tight */}
          <div className="flex flex-wrap items-center gap-1">
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => refreshAll().catch(() => {})} title="Refresh all data">
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </Button>

            {/* Pull with strategy dropdown */}
            <div className="relative" ref={pullDropdownRef}>
              <div className="inline-flex">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 rounded-r-none border-r-0 px-2 text-xs"
                  disabled={!laneId || busyAction != null}
                  onClick={() => {
                    if (!laneId) return;
                    setPullDropdownOpen(false);
                    runAction("pull", async () => { await window.ade.git.sync({ laneId, mode: syncMode }); });
                  }}
                  title={`Download remote changes and apply them to this lane.\nCurrent strategy: ${syncMode === "merge" ? "merge (creates a merge commit)" : "rebase (replays your commits on top)"}`}
                >
                  <ArrowDown className="h-3 w-3 mr-1" />
                  Pull
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 rounded-l-none px-1"
                  onClick={() => setPullDropdownOpen(prev => !prev)}
                  title="Choose pull strategy"
                >
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </div>
              {pullDropdownOpen ? (
                <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded border border-border bg-bg shadow-xl py-1">
                  <button
                    type="button"
                    className={cn("flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-muted/50 text-left", syncMode === "merge" && "text-accent")}
                    onClick={() => { setSyncMode("merge"); setPullDropdownOpen(false); if (laneId) runAction("pull", async () => { await window.ade.git.sync({ laneId, mode: "merge" }); }); }}
                  >
                    {syncMode === "merge" ? <Check className="h-3 w-3 shrink-0" /> : <span className="w-3 shrink-0" />}
                    <div>
                      <div className="font-medium">Pull (merge)</div>
                      <div className="text-[10px] text-muted-fg">Fetch + merge remote into your branch</div>
                    </div>
                  </button>
                  <button
                    type="button"
                    className={cn("flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-muted/50 text-left", syncMode === "rebase" && "text-accent")}
                    onClick={() => { setSyncMode("rebase"); setPullDropdownOpen(false); if (laneId) runAction("pull", async () => { await window.ade.git.sync({ laneId, mode: "rebase" }); }); }}
                  >
                    {syncMode === "rebase" ? <Check className="h-3 w-3 shrink-0" /> : <span className="w-3 shrink-0" />}
                    <div>
                      <div className="font-medium">Pull (rebase)</div>
                      <div className="text-[10px] text-muted-fg">Fetch + replay your commits on top of remote</div>
                    </div>
                  </button>
                  <div className="border-t border-border my-1" />
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-muted/50 text-left"
                    onClick={() => { setPullDropdownOpen(false); if (laneId) runAction("fetch", async () => { await window.ade.git.fetch({ laneId }); }); }}
                  >
                    <span className="w-3 shrink-0" />
                    <div>
                      <div className="font-medium">Fetch only</div>
                      <div className="text-[10px] text-muted-fg">Download remote data without changing your branch</div>
                    </div>
                  </button>
                </div>
              ) : null}
            </div>

            <Button
              variant="primary"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={!laneId || busyAction != null}
              onClick={() => { if (laneId) runAction("push", async () => { await window.ade.git.push({ laneId }); }); }}
              title="Upload your commits to the remote repository"
            >
              <Upload className="h-3 w-3 mr-1" /> Push
            </Button>

            {/* Rebase onto parent - only for stacked (child) lanes */}
            {lane?.parentLaneId ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                title={`Rebase onto parent: replay this lane's commits on top of the parent lane's latest changes.\nUse this when the parent lane has new commits you want to incorporate.`}
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
                <Layers3 className="h-3 w-3 mr-1" /> Rebase
              </Button>
            ) : null}

            {/* More actions dropdown */}
            <div className="relative" ref={moreDropdownRef}>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                title="More git actions (stash, revert, cherry-pick)"
                onClick={() => setMoreDropdownOpen(prev => !prev)}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
              {moreDropdownOpen ? (
                <div className="absolute right-0 top-full z-50 mt-1 w-52 rounded border border-border bg-bg shadow-xl py-1">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-muted/50 text-left"
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
                    <div>
                      <div className="font-medium">Stash changes</div>
                      <div className="text-[10px] text-muted-fg">Temporarily save uncommitted changes</div>
                    </div>
                  </button>
                  <button
                    type="button"
                    className={cn("flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-muted/50 text-left", stashes.length === 0 && "opacity-40 pointer-events-none")}
                    onClick={() => {
                      setMoreDropdownOpen(false);
                      if (!laneId || stashes.length === 0) return;
                      runAction("stash pop", async () => {
                        await window.ade.git.stashPop({ laneId, stashRef: stashes[0]!.ref });
                      });
                    }}
                  >
                    <div>
                      <div className="font-medium">Pop stash{stashes.length > 0 ? ` (${stashes[0]?.ref})` : ""}</div>
                      <div className="text-[10px] text-muted-fg">Restore previously stashed changes</div>
                    </div>
                  </button>
                  <div className="border-t border-border my-1" />
                  <button
                    type="button"
                    className={cn("flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-muted/50 text-left", recentCommits.length === 0 && "opacity-40 pointer-events-none")}
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
                    <div>
                      <div className="font-medium">Revert commit...</div>
                      <div className="text-[10px] text-muted-fg">Create a new commit that undoes a previous one</div>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-muted/50 text-left"
                    onClick={() => {
                      setMoreDropdownOpen(false);
                      if (!laneId) return;
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
                    <div>
                      <div className="font-medium">Cherry-pick commit...</div>
                      <div className="text-[10px] text-muted-fg">Copy a commit from another branch into this one</div>
                    </div>
                  </button>
                </div>
              ) : null}
            </div>

            <div className="h-4 w-px bg-border" />

            {/* Inline commit input */}
            <input
              className="h-7 min-w-[100px] max-w-[220px] flex-1 rounded border border-border bg-bg px-2 text-xs outline-none focus:border-accent transition-colors"
              placeholder="Commit message..."
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              title="Type a commit message, then press Cmd/Ctrl+Enter or click Commit"
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
              className="h-7 px-2 text-xs"
              disabled={!commitMessage.trim() || !hasStaged || busyAction != null}
              title={!hasStaged ? "Stage files first (click checkboxes), then commit" : "Save staged changes as a new commit"}
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

            {onSplit ? (
              <>
                <div className="h-4 w-px bg-border" />
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onSplit} title="Open side-by-side split view">
                  <Columns className="h-3.5 w-3.5" />
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {/* === Main content: vertical resizable split === */}
      <div className="flex-1 min-h-0">
        <Group
          id={`lane-detail-vsplit:${laneId ?? "none"}`}
          orientation="vertical"
          className="h-full"
        >
          {/* Top panel: files + commits side by side */}
          <Panel id={`lane-detail-top:${laneId ?? "none"}`} minSize={15} defaultSize={38}>
            <Group
              id={`lane-detail-top-cols:${laneId ?? "none"}`}
              orientation="horizontal"
              className="h-full"
            >
              {/* Unified file list */}
              <Panel id={`lane-detail-files:${laneId ?? "none"}`} minSize={20} defaultSize={55} className="min-w-0">
                <div className="flex flex-col h-full min-h-0">
                  <div className="flex items-center justify-between px-2 py-1.5 border-b border-border bg-card/50">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wider text-muted-fg">Changed Files</span>
                      <Chip className="text-[10px] h-4 px-1">{unifiedFiles.length}</Chip>
                      {stagedCount > 0 ? (
                        <span className="text-[10px] text-muted-fg">({stagedCount} staged)</span>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-1">
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
                  <div className="flex-1 overflow-auto p-1 space-y-0.5">
                    {unifiedFiles.map(file => (
                      <div
                        key={file.path}
                        className={cn(
                          "group flex items-center gap-2 px-2 py-1 rounded cursor-pointer text-xs border border-transparent",
                          selectedPath === file.path ? "bg-accent/10 border-accent/20 text-fg" : "hover:bg-muted/50 text-muted-fg hover:text-fg"
                        )}
                        onClick={() => {
                          setSelectedCommit(null);
                          setCommitFiles([]);
                          setSelectedCommitFilePath(null);
                          setCommitDiff(null);
                          setSelectedPath(file.path);
                        }}
                      >
                        {/* Staging checkbox */}
                        <button
                          type="button"
                          className="shrink-0 h-4 w-4 rounded border border-border flex items-center justify-center hover:border-accent"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleStageFile(file.path, file.staged);
                          }}
                          title={file.staged ? "Unstage" : "Stage"}
                        >
                          {file.staged ? <Check className="h-2.5 w-2.5 text-accent" /> : null}
                        </button>
                        {/* Status dot */}
                        <span className={cn("inline-block w-1.5 h-1.5 rounded-full shrink-0",
                          file.kind === "modified" ? "bg-blue-400" :
                            file.kind === "added" ? "bg-emerald-400" :
                              file.kind === "deleted" ? "bg-red-400" : "bg-amber-400"
                        )} />
                        <span className="truncate flex-1">{file.path}</span>
                      </div>
                    ))}
                    {unifiedFiles.length === 0 && (
                      <div className="p-4 text-center text-xs text-muted-fg opacity-50 italic">
                        No changes
                      </div>
                    )}
                  </div>
                </div>
              </Panel>

              <Separator className="relative w-2 shrink-0 cursor-col-resize border-x border-border bg-card/40 transition-colors hover:bg-accent/30 data-[resize-handle-active]:bg-accent/30">
                <div className="absolute inset-0 flex items-center justify-center text-muted-fg/50">
                  <GripVertical className="h-3 w-3" />
                </div>
              </Separator>

              {/* Commits timeline */}
              <Panel id={`lane-detail-commits:${laneId ?? "none"}`} minSize={20} defaultSize={45} className="min-w-0">
                <CommitTimeline
                  laneId={laneId ?? null}
                  selectedSha={selectedCommit?.sha ?? null}
                  onSelectCommit={(commit) => {
                    setSelectedPath(null);
                    setDiff(null);
                    setSelectedCommit(commit);
                  }}
                />
              </Panel>
            </Group>
          </Panel>

          {/* Vertical resizable divider */}
          <Separator className="relative h-2 shrink-0 cursor-row-resize border-y border-border bg-card/40 transition-colors hover:bg-accent/30 data-[resize-handle-active]:bg-accent/30">
            <div className="absolute inset-0 flex items-center justify-center text-muted-fg/50">
              <GripVertical className="h-3 w-3 rotate-90" />
            </div>
          </Separator>

          {/* Bottom panel: diff viewer */}
          <Panel id={`lane-detail-bottom:${laneId ?? "none"}`} minSize={20} defaultSize={62} className="min-h-0">
            <div className="h-full bg-bg">
              {renderDiffSection()}
            </div>
          </Panel>
        </Group>
      </div>

      {/* Text prompt modal (reused) */}
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

      {/* Status bar */}
      {(notice || error || busyAction) && (
        <div className={cn("flex items-center justify-between border-t border-border px-3 py-1 text-xs", error ? "bg-red-50 text-red-800" : "bg-accent/10 text-accent")}>
          <span>{error ? `Error: ${error}` : notice ? notice : busyAction ? `Running ${busyAction}...` : ""}</span>
        </div>
      )}
    </div>
  );
}

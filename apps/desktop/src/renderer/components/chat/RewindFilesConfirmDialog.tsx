import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CaretDown,
  CaretRight,
  FileCode,
  FilePlus,
  FileX,
  GitDiff,
  WarningCircle,
} from "@phosphor-icons/react";
import type {
  AgentChatGetTurnFileDiffArgs,
  AgentChatRewindFilesResult,
  FileDiff,
  TurnDiffFile,
} from "../../../shared/types";
import { AdeDiffViewer } from "../shared/AdeDiffViewer";
import { cn } from "../ui/cn";
import type { RewindPreviewFile } from "./rewindFilesPreview";

export type RewindFilesConfirmRequest = {
  messageId: string;
  timestamp: string;
  text: string;
};

export type RewindFilesConfirmDialogState = {
  request: RewindFilesConfirmRequest;
  preview: AgentChatRewindFilesResult;
  files: RewindPreviewFile[];
};

type DiffLoadState = "idle" | "loading" | "loaded" | "missing" | "error";

const MAX_DIFF_CACHE_ENTRIES = 16;
const EMPTY_REWIND_FILES: RewindPreviewFile[] = [];

function formatMessagePreview(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 120) return compact;
  return `${compact.slice(0, 120).trimEnd()}...`;
}

function formatSentAt(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "sent time unavailable";
  const deltaMs = Date.now() - date.getTime();
  const deltaMinutes = Math.max(0, Math.round(deltaMs / 60_000));
  if (deltaMinutes < 1) return "sent just now";
  if (deltaMinutes < 60) return `sent ${deltaMinutes} minute${deltaMinutes === 1 ? "" : "s"} ago`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return `sent ${deltaHours} hour${deltaHours === 1 ? "" : "s"} ago`;
  return `sent ${date.toLocaleString()}`;
}

function statusIcon(status: TurnDiffFile["status"]) {
  switch (status) {
    case "A":
      return <FilePlus size={13} weight="regular" className="text-emerald-300/80" />;
    case "D":
      return <FileX size={13} weight="regular" className="text-red-300/80" />;
    default:
      return <FileCode size={13} weight="regular" className="text-sky-300/75" />;
  }
}

function statusLabel(status: TurnDiffFile["status"]): string {
  if (status === "A") return "new file";
  if (status === "D") return "deleted";
  if (status === "R") return "renamed";
  if (status === "C") return "copied";
  return "modified";
}

function getDiffCacheKey(args: AgentChatGetTurnFileDiffArgs): string {
  return [args.sessionId, args.beforeSha, args.afterSha, args.filePath].join("\u0000");
}

function rememberCachedDiff(cache: Map<string, FileDiff>, cacheKey: string, diff: FileDiff): void {
  cache.delete(cacheKey);
  cache.set(cacheKey, diff);
  while (cache.size > MAX_DIFF_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

function DiffPreview({
  selectedFile,
  activeDiff,
  loadState,
}: {
  selectedFile: RewindPreviewFile;
  activeDiff: FileDiff | null;
  loadState: DiffLoadState;
}) {
  if (!selectedFile.diffAvailable) {
    return (
      <div className="flex min-h-[170px] items-center justify-center border-t border-white/[0.05] bg-black/15 px-4 py-5 text-center">
        <div className="max-w-[420px] text-[12px] leading-5 text-fg/45">
          ADE can restore this file from the checkpoint, but no turn-level diff summary was captured for a preview.
        </div>
      </div>
    );
  }

  if (loadState === "loading" || loadState === "idle") {
    return (
      <div className="flex min-h-[170px] items-center justify-center border-t border-white/[0.05] bg-black/15">
        <span className="animate-pulse text-[12px] text-fg/35">Loading diff...</span>
      </div>
    );
  }

  if (activeDiff) {
    return (
      <div className="min-h-[210px] border-t border-white/[0.05] bg-black/15" style={{ maxHeight: 360 }}>
        <AdeDiffViewer diff={activeDiff} editable={false} theme="dark" compact showToolbar={false} className="h-full rounded-none border-0" />
      </div>
    );
  }

  return (
    <div className="flex min-h-[170px] items-center justify-center border-t border-white/[0.05] bg-black/15 px-4 py-5 text-center">
      <div className="max-w-[420px] text-[12px] leading-5 text-fg/45">
        {loadState === "missing" ? "No diff was available for this file." : "Failed to load this diff preview."}
      </div>
    </div>
  );
}

export function RewindFilesConfirmDialog({
  state,
  sessionId,
  onCancel,
  onConfirm,
}: {
  state: RewindFilesConfirmDialogState | null;
  sessionId: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [activeDiff, setActiveDiff] = useState<FileDiff | null>(null);
  const [activeDiffLoadState, setActiveDiffLoadState] = useState<DiffLoadState>("idle");
  const diffCache = useRef<Map<string, FileDiff>>(new Map());
  const latestDiffRequestKey = useRef<string | null>(null);

  const files = state?.files ?? EMPTY_REWIND_FILES;
  const firstPreviewablePath = useMemo(
    () => files.find((file) => file.diffAvailable)?.path ?? files[0]?.path ?? null,
    [files],
  );

  const loadDiff = useCallback(async (file: RewindPreviewFile) => {
    if (!state || !sessionId || !file.beforeSha || !file.afterSha) {
      setActiveDiff(null);
      setActiveDiffLoadState(file.diffAvailable ? "missing" : "idle");
      return;
    }

    const args: AgentChatGetTurnFileDiffArgs = {
      sessionId,
      beforeSha: file.beforeSha,
      afterSha: file.afterSha,
      filePath: file.path,
    };
    const cacheKey = getDiffCacheKey(args);
    latestDiffRequestKey.current = cacheKey;

    const cached = diffCache.current.get(cacheKey);
    if (cached) {
      rememberCachedDiff(diffCache.current, cacheKey, cached);
      setActiveDiff(cached);
      setActiveDiffLoadState("loaded");
      return;
    }

    setActiveDiff(null);
    setActiveDiffLoadState("loading");

    try {
      const diff = await window.ade.agentChat.getTurnFileDiff(args);
      if (latestDiffRequestKey.current !== cacheKey) return;
      if (!diff) {
        setActiveDiffLoadState("missing");
        return;
      }
      rememberCachedDiff(diffCache.current, cacheKey, diff);
      setActiveDiff(diff);
      setActiveDiffLoadState("loaded");
    } catch (error) {
      if (latestDiffRequestKey.current !== cacheKey) return;
      console.error("[RewindFilesConfirmDialog] Failed to load diff", file.path, error);
      setActiveDiffLoadState("error");
    }
  }, [sessionId, state]);

  useEffect(() => {
    if (!state) return;
    setExpandedPath(firstPreviewablePath);
    setActiveDiff(null);
    setActiveDiffLoadState("idle");
    diffCache.current.clear();
    latestDiffRequestKey.current = null;
    const first = files.find((file) => file.path === firstPreviewablePath);
    if (first) void loadDiff(first);
  }, [files, firstPreviewablePath, loadDiff, state]);

  useEffect(() => {
    if (!state) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onCancel, state]);

  if (!state) return null;

  const { request, preview } = state;
  const filesCount = preview.filesChanged.length;
  const messagePreview = formatMessagePreview(request.text);
  const contextRollback = preview.conversationRollback === true;

  const handleOverlayClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onCancel();
  };

  const toggleFile = (file: RewindPreviewFile) => {
    if (expandedPath === file.path) {
      setExpandedPath(null);
      setActiveDiff(null);
      setActiveDiffLoadState("idle");
      return;
    }
    setExpandedPath(file.path);
    void loadDiff(file);
  };

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 px-5 py-6"
      onClick={handleOverlayClick}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rewind-files-title"
        className="flex max-h-[88vh] w-full max-w-[860px] flex-col overflow-hidden border border-white/[0.10] bg-[#101018] shadow-[0_30px_90px_-38px_rgba(0,0,0,0.9)]"
      >
        <div className="border-b border-white/[0.07] bg-white/[0.025] px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <GitDiff size={16} weight="regular" className="text-amber-200/75" />
            <h2 id="rewind-files-title" className="text-[14px] font-semibold text-fg/92">
              {contextRollback ? "Rewind Codex context" : "Undo file changes"}
            </h2>
            <span className="rounded-md border border-amber-200/10 bg-amber-300/[0.06] px-2 py-0.5 font-mono text-[10px] text-amber-100/58">
              +{preview.insertions} / -{preview.deletions}
            </span>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="rounded-md border border-white/[0.06] bg-black/18 px-4 py-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-fg/35">Revert to before</div>
            <div className="mt-2 text-[13px] leading-5 text-fg/86">"{messagePreview || "User message"}"</div>
            <div className="mt-1 font-mono text-[11px] text-fg/38">{formatSentAt(request.timestamp)}</div>
          </div>

          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="text-[12px] font-medium text-fg/70">
                {contextRollback ? "Files ADE can restore" : "Files that will be restored"}
              </div>
              <div className="font-mono text-[11px] text-fg/42">
                {filesCount} file{filesCount === 1 ? "" : "s"}
              </div>
            </div>

            <div className="overflow-hidden rounded-md border border-white/[0.07] bg-white/[0.018]">
              {files.length ? files.map((file) => {
                const expanded = expandedPath === file.path;
                return (
                  <div key={file.path} className="border-b border-white/[0.045] last:border-b-0">
                    <button
                      type="button"
                      className={cn(
                        "grid w-full grid-cols-[18px_18px_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2.5 text-left transition-colors",
                        expanded ? "bg-white/[0.045]" : "hover:bg-white/[0.028]",
                      )}
                      onClick={() => toggleFile(file)}
                    >
                      {expanded ? <CaretDown size={12} className="text-fg/45" /> : <CaretRight size={12} className="text-fg/35" />}
                      {statusIcon(file.status)}
                      <div className="min-w-0">
                        <div className="truncate text-[12px] text-fg/78" title={file.path}>{file.path}</div>
                        <div className="mt-0.5 font-mono text-[10px] text-fg/35">{statusLabel(file.status)}</div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2 font-mono text-[11px]">
                        <span className="text-emerald-300/70">+{file.additions}</span>
                        <span className="text-red-300/70">-{file.deletions}</span>
                        {!file.diffAvailable ? (
                          <span title="Diff preview unavailable">
                            <WarningCircle size={13} className="text-amber-200/55" />
                          </span>
                        ) : null}
                      </div>
                    </button>
                    {expanded ? (
                      <DiffPreview
                        selectedFile={file}
                        activeDiff={activeDiff}
                        loadState={activeDiffLoadState}
                      />
                    ) : null}
                  </div>
                );
              }) : (
                <div className="px-3 py-6 text-center text-[12px] text-fg/38">
                  {contextRollback
                    ? "No git-backed file changes were found for this rewind."
                    : "No file paths were reported by the checkpoint preview."}
                </div>
              )}
            </div>
          </div>

          <div className="mt-4 rounded-md border border-white/[0.055] bg-black/14 px-3 py-2 text-[12px] text-fg/48">
            {contextRollback
              ? "Codex conversation context will roll back. Saved ADE transcript stays visible."
              : "Conversation history is not affected."}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-white/[0.07] bg-white/[0.018] px-5 py-3">
          <button
            type="button"
            className="rounded-md border border-white/[0.12] bg-white/[0.035] px-3 py-1.5 text-[12px] font-medium text-fg/70 transition-colors hover:bg-white/[0.06]"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md border border-red-300/20 bg-red-500/18 px-3 py-1.5 text-[12px] font-semibold text-red-50/90 transition-colors hover:bg-red-500/24"
            onClick={onConfirm}
            autoFocus
          >
            {contextRollback && filesCount === 0
              ? "Rollback context"
              : `Revert ${filesCount} file${filesCount === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

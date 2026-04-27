import React, { useEffect, useMemo, useState } from "react";
import { CaretDown, CaretRight, Check, Warning, XCircle } from "@phosphor-icons/react";
import type { OperatorNavigationSuggestion } from "../../../shared/types";
import {
  formatStructuredValue,
  readRecord,
  summarizeDiffStats,
  summarizeInlineText,
  type ChatWorkLogGroupEvent,
  type ChatWorkLogEntry,
  type ChatWorkLogFileChange,
} from "./chatTranscriptRows";
import { cn } from "../ui/cn";
import { getToolMeta } from "./chatToolAppearance";
import { replaceInternalToolNames } from "./toolPresentation";

const NAVIGATION_SURFACES = new Set(["work", "missions", "lanes", "cto"]);

function readOperatorNavigationSuggestion(value: unknown): OperatorNavigationSuggestion | null {
  const record = readRecord(value);
  if (!record) return null;
  const surface = typeof record.surface === "string" ? record.surface : "";
  const href = typeof record.href === "string" ? record.href : "";
  const label = typeof record.label === "string" ? record.label : "";
  if (!NAVIGATION_SURFACES.has(surface) || !href.trim().length || !label.trim().length) return null;
  return {
    surface: surface as OperatorNavigationSuggestion["surface"],
    href,
    label,
    ...(typeof record.laneId === "string" ? { laneId: record.laneId } : {}),
    ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
    ...(typeof record.missionId === "string" ? { missionId: record.missionId } : {}),
  };
}

function readNavigationSuggestions(value: unknown): OperatorNavigationSuggestion[] {
  const record = readRecord(value);
  if (!record) return [];
  const suggestions: OperatorNavigationSuggestion[] = [];
  const navigationSuggestions = Array.isArray(record.navigationSuggestions)
    ? record.navigationSuggestions
    : [];
  for (const candidate of navigationSuggestions) {
    const parsed = readOperatorNavigationSuggestion(candidate);
    if (parsed) suggestions.push(parsed);
  }
  const fallback = readOperatorNavigationSuggestion(record.navigation);
  if (fallback) suggestions.push(fallback);
  return suggestions;
}

function basenamePathLabel(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const basename = normalized.split("/").pop()?.trim();
  return basename?.length ? basename : normalized;
}

function formatFileAction(kind: ChatWorkLogFileChange["kind"]): string {
  switch (kind) {
    case "create":
      return "Created";
    case "delete":
      return "Deleted";
    default:
      return "Edited";
  }
}

type EntryStatus = ChatWorkLogEntry["status"];

function isCodeChangeEntry(entry: ChatWorkLogEntry): boolean {
  if (entry.entryKind === "file_change") return true;
  if (entry.entryKind === "tool" && entry.toolName) {
    return getToolMeta(entry.toolName).category === "write";
  }
  return false;
}

function entryArgText(entry: ChatWorkLogEntry): string {
  if (entry.entryKind === "command") {
    return summarizeInlineText(entry.command ?? "", 140);
  }
  if (entry.entryKind === "web_search") {
    return summarizeInlineText(entry.query ?? "", 140);
  }
  if (entry.entryKind === "tool" && entry.toolName) {
    const meta = getToolMeta(entry.toolName);
    const args = readRecord(entry.args) ?? {};
    const target = meta.getTarget ? meta.getTarget(args) : null;
    if (target) return summarizeInlineText(target, 140);
    if (entry.detail) return summarizeInlineText(entry.detail, 140);
  }
  return "";
}

/** Short slug for the tool rail (e.g. `bash`, `grep`, `spawn_chat`) — not a full sentence. */
function workLogEntryKindSlug(entry: ChatWorkLogEntry): string {
  if (entry.entryKind === "command") return "shell";
  if (entry.entryKind === "web_search") return "search";
  if (entry.entryKind === "tool" && entry.toolName?.trim()) {
    let raw = entry.toolName.trim();
    if (raw.includes(".")) {
      raw = raw.split(".").pop() ?? raw;
    }
    const snake = raw
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[-\s.]+/g, "_")
      .toLowerCase();
    if (snake === "exec_command") return "shell";
    return snake;
  }
  return entry.label.replace(/\s+/g, "_").toLowerCase() || "tool";
}

function workLogStatusGlyph(status: EntryStatus) {
  if (status === "completed") {
    return <Check size={12} weight="bold" className="shrink-0 text-emerald-400" aria-hidden />;
  }
  if (status === "failed") {
    return <XCircle size={12} weight="bold" className="shrink-0 text-red-400/90" aria-hidden />;
  }
  if (status === "interrupted") {
    return <Warning size={12} weight="fill" className="shrink-0 text-amber-400/90" aria-hidden />;
  }
  return (
    <span
      className="inline-block h-2 w-2 shrink-0 rounded-full bg-violet-400/80 ade-thinking-pulse"
      aria-hidden
    />
  );
}

function workLogEntryKindToneClass(status: EntryStatus): string {
  if (status === "failed") return "text-red-300/80";
  if (status === "running") return "text-violet-200/75";
  if (status === "interrupted") return "text-amber-200/75";
  return "text-fg/60";
}

function fileExtBadge(path: string): string {
  const basename = basenamePathLabel(path);
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return "FILE";
  const ext = basename.slice(dot + 1).toUpperCase();
  return ext.length > 4 ? "FILE" : ext;
}

type AggregatedFile = {
  path: string;
  kind: ChatWorkLogFileChange["kind"];
  additions: number;
  deletions: number;
  diff: string;
  status: EntryStatus;
};

function aggregateFilesFromEntries(entries: ChatWorkLogEntry[]): AggregatedFile[] {
  const map = new Map<string, AggregatedFile>();
  for (const entry of entries) {
    if (entry.entryKind === "file_change" && entry.changedFiles?.length) {
      for (const file of entry.changedFiles) {
        const existing = map.get(file.path);
        if (existing) {
          existing.additions += file.additions;
          existing.deletions += file.deletions;
          if (file.diff.length > existing.diff.length) existing.diff = file.diff;
        } else {
          map.set(file.path, {
            path: file.path,
            kind: file.kind,
            additions: file.additions,
            deletions: file.deletions,
            diff: file.diff,
            status: entry.status,
          });
        }
      }
      continue;
    }
    if (entry.entryKind === "tool" && entry.toolName) {
      const meta = getToolMeta(entry.toolName);
      if (meta.category !== "write") continue;
      const args = readRecord(entry.args) ?? {};
      const path = meta.getTarget ? meta.getTarget(args) : null;
      if (!path) continue;
      const resultRecord = readRecord(entry.result);
      const diff = typeof resultRecord?.diff === "string" ? resultRecord.diff : "";
      const stats = diff ? summarizeDiffStats(diff) : { additions: 0, deletions: 0 };
      const existing = map.get(path);
      if (existing) {
        existing.additions += stats.additions;
        existing.deletions += stats.deletions;
        if (diff.length > existing.diff.length) existing.diff = diff;
      } else {
        map.set(path, {
          path,
          kind: "modify",
          additions: stats.additions,
          deletions: stats.deletions,
          diff,
          status: entry.status,
        });
      }
    }
  }
  return [...map.values()];
}

function FlatPre({ children }: { children: React.ReactNode }) {
  return (
    <pre className="mt-1 ml-[18px] max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-white/[0.05] pt-2 font-mono text-[11px] leading-[1.55] text-fg/55">
      {children}
    </pre>
  );
}

function DiffBody({ diff }: { diff: string }) {
  const lines = diff.split(/\r?\n/);
  return (
    <pre className="mt-1 ml-[18px] max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-white/[0.05] pt-2 font-mono text-[11px] leading-[1.55] text-fg/65">
      {lines.map((line, index) => {
        let tone = "text-fg/65";
        if (line.startsWith("+")) tone = "text-emerald-400/85";
        else if (line.startsWith("-")) tone = "text-red-400/85";
        else if (line.startsWith("@@")) tone = "text-violet-400/55";
        return (
          <div key={`${index}:${line}`} className={tone}>
            {line}
          </div>
        );
      })}
    </pre>
  );
}

function ToolCallRow({
  entry,
  onNavigateSuggestion,
}: {
  entry: ChatWorkLogEntry;
  onNavigateSuggestion?: (suggestion: OperatorNavigationSuggestion) => void;
}) {
  const navigationSuggestions = useMemo(
    () => readNavigationSuggestions(entry.result),
    [entry.result],
  );
  const [open, setOpen] = useState(entry.status === "failed" || navigationSuggestions.length > 0);

  useEffect(() => {
    if (navigationSuggestions.length > 0) setOpen(true);
  }, [navigationSuggestions.length]);

  const kindSlug = workLogEntryKindSlug(entry);
  const argText = replaceInternalToolNames(entryArgText(entry));
  const kindTone = workLogEntryKindToneClass(entry.status);

  const detailBody = useMemo(() => buildEntryDetail(entry), [entry]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-[6px] px-1.5 py-1 text-left transition-colors hover:bg-white/[0.025]"
      >
        {workLogStatusGlyph(entry.status)}
        <span className={cn("shrink-0 font-mono text-[11px] font-medium tracking-tight", kindTone)}>
          {kindSlug}
        </span>
        {argText ? (
          <span className="min-w-0 truncate font-mono text-[11px] text-fg/40">{argText}</span>
        ) : null}
      </button>
      {open && navigationSuggestions.length > 0 && onNavigateSuggestion ? (
        <div className="mt-1 ml-[18px] flex flex-wrap gap-1.5 border-t border-white/[0.05] pt-2">
          {navigationSuggestions.map((suggestion) => (
            <button
              key={`${suggestion.surface}:${suggestion.href}`}
              type="button"
              onClick={() => onNavigateSuggestion(suggestion)}
              className="rounded-[6px] border border-accent/20 px-2 py-0.5 font-mono text-[10px] font-semibold text-accent/85 transition-colors hover:border-accent/40 hover:text-accent"
            >
              {suggestion.label}
            </button>
          ))}
        </div>
      ) : null}
      {open && detailBody ? <FlatPre>{detailBody}</FlatPre> : null}
    </div>
  );
}

function buildEntryDetail(entry: ChatWorkLogEntry): string | null {
  if (entry.entryKind === "command") {
    const out = entry.output?.trim();
    if (!out) return null;
    return out;
  }
  if (entry.entryKind === "web_search") {
    const action = entry.action?.trim();
    return action && action.length ? action : null;
  }
  if (entry.entryKind === "tool") {
    if (entry.result !== undefined) {
      return formatStructuredValue(entry.result);
    }
    const args = readRecord(entry.args);
    if (args && Object.keys(args).length > 0) return formatStructuredValue(args);
  }
  if (entry.detail?.trim().length) {
    return replaceInternalToolNames(entry.detail);
  }
  return null;
}

function ToolCallsPanel({
  entries,
  onNavigateSuggestion,
}: {
  entries: ChatWorkLogEntry[];
  onNavigateSuggestion?: (suggestion: OperatorNavigationSuggestion) => void;
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  if (entries.length === 0) return null;

  const latest = entries[entries.length - 1]!;
  const latestArg = replaceInternalToolNames(entryArgText(latest));
  const latestSlug = workLogEntryKindSlug(latest);
  const latestTone = workLogEntryKindToneClass(latest.status);
  const Caret = panelOpen ? CaretDown : CaretRight;

  return (
    <div className="w-full min-w-0 font-sans text-[11px]">
      <button
        type="button"
        onClick={() => setPanelOpen((v) => !v)}
        aria-expanded={panelOpen}
        className="flex w-full min-w-0 max-w-full items-center gap-1.5 py-0.5 text-left transition-colors hover:text-fg/80"
      >
        <Caret size={9} weight="bold" className="shrink-0 text-violet-400/45" />
        <span className="shrink-0 font-medium text-fg/45">Tool calls</span>
        <span className="shrink-0 text-[10px] tabular-nums text-fg/30">({entries.length})</span>
        {panelOpen ? null : (
          <span className="ml-1 flex min-w-0 flex-1 items-center justify-end gap-1.5">
            {workLogStatusGlyph(latest.status)}
            <span className={cn("shrink-0 font-mono text-[11px] font-medium tracking-tight", latestTone)}>
              {latestSlug}
            </span>
            {latestArg ? (
              <span className="min-w-0 max-w-[min(52ch,50%)] truncate font-mono text-[10px] text-fg/38">{latestArg}</span>
            ) : null}
          </span>
        )}
      </button>
      {panelOpen ? (
        <div className="mt-1.5 w-full min-w-0 space-y-0.5 pl-4">
          {entries.map((entry) => (
            <ToolCallRow key={entry.id} entry={entry} onNavigateSuggestion={onNavigateSuggestion} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FilesChangedPanel({
  files,
  onUndo,
}: {
  files: AggregatedFile[];
  onUndo?: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});

  if (files.length === 0) return null;
  const fileWord = files.length === 1 ? "file" : "files";
  const Caret = open ? CaretDown : CaretRight;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-2 rounded-[6px] px-1 py-0.5 text-left transition-colors hover:bg-white/[0.025]"
        >
          <Caret size={10} weight="bold" className="text-fg/35" />
          <span className="font-sans text-[11px] font-medium text-fg/70">
            {files.length} {fileWord} changed
          </span>
        </button>
        {onUndo ? (
          <button
            type="button"
            onClick={onUndo}
            className="font-sans text-[11px] text-fg/40 transition-colors hover:text-fg/65"
          >
            Undo
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="space-y-0.5 pl-[18px]">
          {files.map((file) => {
            const expanded = expandedFiles[file.path] ?? false;
            return (
              <div key={file.path}>
                <button
                  type="button"
                  onClick={() =>
                    setExpandedFiles((current) => ({ ...current, [file.path]: !expanded }))
                  }
                  aria-expanded={expanded}
                  className="flex w-full items-center gap-3 rounded-[6px] px-1.5 py-1 text-left transition-colors hover:bg-white/[0.025]"
                >
                  <span className="inline-flex h-3.5 w-7 shrink-0 items-center justify-center rounded-[3px] border border-white/[0.06] bg-white/[0.02] font-mono text-[8px] font-bold tracking-wider text-fg/40">
                    {fileExtBadge(file.path)}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg/65">
                    {file.path}
                  </span>
                  {file.kind !== "modify" ? (
                    <span className="shrink-0 font-sans text-[10px] text-fg/40">
                      {formatFileAction(file.kind)}
                    </span>
                  ) : null}
                  {file.additions > 0 ? (
                    <span className="shrink-0 font-mono text-[11px] text-emerald-400/80">
                      +{file.additions}
                    </span>
                  ) : null}
                  {file.deletions > 0 ? (
                    <span className="shrink-0 font-mono text-[11px] text-red-400/80">
                      −{file.deletions}
                    </span>
                  ) : null}
                </button>
                {expanded && file.diff.trim().length ? <DiffBody diff={file.diff} /> : null}
                {expanded && !file.diff.trim().length ? (
                  <div className="mt-1 ml-[18px] border-t border-white/[0.05] pt-2 font-mono text-[11px] text-fg/35">
                    No diff payload available.
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function ChatWorkLogBlock({
  entries,
  summary: _summary,
  className,
  onNavigateSuggestion,
  onUndoChanges,
  animate: _animate = true,
}: {
  entries: ChatWorkLogEntry[];
  summary?: ChatWorkLogGroupEvent["summary"];
  className?: string;
  onNavigateSuggestion?: (suggestion: OperatorNavigationSuggestion) => void;
  onUndoChanges?: () => void;
  animate?: boolean;
}) {
  const { readOnlyEntries, codeChangeEntries } = useMemo(() => {
    const readOnly: ChatWorkLogEntry[] = [];
    const codeChange: ChatWorkLogEntry[] = [];
    for (const entry of entries) {
      if (isCodeChangeEntry(entry)) codeChange.push(entry);
      else readOnly.push(entry);
    }
    return { readOnlyEntries: readOnly, codeChangeEntries: codeChange };
  }, [entries]);

  const aggregatedFiles = useMemo(
    () => aggregateFilesFromEntries(codeChangeEntries),
    [codeChangeEntries],
  );

  const hasReadOnly = readOnlyEntries.length > 0;
  const hasCodeChange = aggregatedFiles.length > 0;
  if (!hasReadOnly && !hasCodeChange) return null;

  return (
    <div className={cn("max-w-full space-y-3", className)}>
      {hasReadOnly ? (
        <ToolCallsPanel
          entries={readOnlyEntries}
          onNavigateSuggestion={onNavigateSuggestion}
        />
      ) : null}
      {hasCodeChange ? (
        <FilesChangedPanel files={aggregatedFiles} onUndo={onUndoChanges} />
      ) : null}
    </div>
  );
}

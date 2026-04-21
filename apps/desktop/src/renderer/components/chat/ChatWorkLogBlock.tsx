import React, { useEffect, useMemo, useState } from "react";
import {
  CaretDown,
  CaretRight,
  FileCode,
  Globe,
  Terminal,
  Warning,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
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
import { ChatStatusGlyph, chatStatusTextClass, type ChatStatusVisualState } from "./chatStatusVisuals";
import { replaceInternalToolNames } from "./toolPresentation";

const MAX_SUMMARY_WORK_LOG_ENTRIES = 4;
const RECESSED_BLOCK_CLASS =
  "ade-chat-recessed overflow-auto whitespace-pre-wrap break-words rounded-[10px] px-4 py-3 font-mono text-[11px] leading-[1.6] text-fg/78";

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

function DiffPreview({ diff }: { diff: string }) {
  const lines = diff.split(/\r?\n/);
  return (
    <pre className={cn("max-h-64", RECESSED_BLOCK_CLASS)}>
      {lines.map((line, index) => {
        let tone = "text-fg/70";
        let background = "";
        if (line.startsWith("+")) {
          tone = "text-emerald-400/90";
          background = "bg-emerald-500/[0.05]";
        } else if (line.startsWith("-")) {
          tone = "text-red-400/90";
          background = "bg-rose-500/[0.05]";
        } else if (line.startsWith("@@")) {
          tone = "text-violet-400/60";
        }
        return (
          <div key={`${index}:${line}`} className={cn(tone, background, "px-1 -mx-1")}>
            {line}
          </div>
        );
      })}
    </pre>
  );
}

const FAILED_ICON_CLASS = "text-red-300/80";

const MEMORY_TOOL_LABELS = new Set(["Memory", "Core Memory", "Memory Add", "Memory Pin"]);

function isMemoryToolEntry(entry: ChatWorkLogEntry): boolean {
  if (entry.entryKind !== "tool" || !entry.toolName) return false;
  return MEMORY_TOOL_LABELS.has(getToolMeta(entry.toolName).label);
}

function workToneIcon(entry: ChatWorkLogEntry): { icon: Icon; className: string } {
  const isFailed = entry.status === "failed";

  switch (entry.entryKind) {
    case "tool":
      if (entry.toolName) {
        return { icon: getToolMeta(entry.toolName).icon, className: isFailed ? FAILED_ICON_CLASS : "text-fg/34" };
      }
      break;
    case "command":
      return { icon: Terminal, className: isFailed ? FAILED_ICON_CLASS : "text-amber-300/75" };
    case "file_change":
      return { icon: FileCode, className: isFailed ? FAILED_ICON_CLASS : "text-violet-300/75" };
    case "web_search":
      return { icon: Globe, className: isFailed ? FAILED_ICON_CLASS : "text-cyan-300/75" };
  }

  return { icon: Warning, className: "text-fg/34" };
}

function workStatusState(status: ChatWorkLogEntry["status"], animate = true): ChatStatusVisualState {
  if (status === "completed" || status === "failed") return status;
  if (status === "interrupted") return animate ? "waiting" : "completed";
  return animate ? "working" : "completed";
}

function workStatusLabel(status: ChatWorkLogEntry["status"], animate = true): string {
  if (status === "completed" || status === "failed") return status;
  if (status === "interrupted") return animate ? "interrupted" : "completed";
  return animate ? "running" : "completed";
}

function workEntryHeading(entry: ChatWorkLogEntry): string {
  if (entry.entryKind === "tool" && entry.toolName) {
    const meta = getToolMeta(entry.toolName);
    const args = readRecord(entry.args) ?? {};
    const targetLine = meta.getTarget ? meta.getTarget(args) : null;

    if (meta.label === "Shell") {
      return targetLine ? `Run ${summarizeInlineText(targetLine, 72)}` : "Run shell";
    }
    if (meta.label === "Read") {
      return targetLine ? `Read ${basenamePathLabel(targetLine)}` : "Read files";
    }
    if (meta.label === "Search") {
      return meta.category === "web"
        ? "Search web"
        : targetLine ? `Search ${summarizeInlineText(targetLine, 72)}` : "Search";
    }
    if (meta.label === "Find Files") {
      return targetLine ? `Find ${summarizeInlineText(targetLine, 72)}` : "Find files";
    }
    if (meta.label === "List Files" || meta.label === "List") {
      return targetLine ? `List ${summarizeInlineText(targetLine, 72)}` : "List files";
    }
    if (meta.label === "Write") {
      return targetLine ? `Write ${basenamePathLabel(targetLine)}` : "Write file";
    }
    if (meta.label === "Edit" || meta.label === "Multi Edit" || meta.label === "Patch") {
      return targetLine ? `Edit ${basenamePathLabel(targetLine)}` : "Edit files";
    }
    if (meta.label === "Plan") {
      return "Update plan";
    }
    if (meta.label === "Plan Approval") {
      return "Review plan";
    }
    if (meta.label === "Memory" || meta.label === "Core Memory" || meta.label === "Memory Add" || meta.label === "Memory Pin") {
      return "Update memory";
    }

    return targetLine ? `${meta.label} ${summarizeInlineText(targetLine, 72)}`.trim() : meta.label;
  }

  if (entry.entryKind === "command") {
    const cmdText = summarizeInlineText(entry.command ?? "", 72);
    return cmdText.length > 0 ? `Run ${cmdText}` : "Run shell";
  }

  if (entry.entryKind === "file_change") {
    const firstFile = entry.changedFiles?.[0];
    if (!firstFile) return "File change";
    const action = formatFileAction(firstFile.kind);
    if (entry.changedFiles!.length === 1) return `${action} ${basenamePathLabel(firstFile.path)}`;
    return `${action} ${basenamePathLabel(firstFile.path)} +${entry.changedFiles!.length - 1} more`;
  }

  if (entry.entryKind === "web_search") {
    return "Search web";
  }

  return entry.label;
}

function workEntryPreview(entry: ChatWorkLogEntry): string {
  if (entry.entryKind === "command") {
    const cmdText = summarizeInlineText(entry.command ?? "", 110);
    return cmdText.length > 0 ? cmdText : "Run shell";
  }

  if (entry.entryKind === "file_change") {
    const firstFile = entry.changedFiles?.[0];
    if (!firstFile) return "";
    const stats = summarizeDiffStats(firstFile.diff);
    const statsText = [
      stats.additions > 0 ? `+${stats.additions}` : null,
      stats.deletions > 0 ? `-${stats.deletions}` : null,
    ].filter(Boolean).join(" ");
    return summarizeInlineText(
      statsText.length ? `${basenamePathLabel(firstFile.path)} ${statsText}` : basenamePathLabel(firstFile.path),
      110,
    );
  }

  if (entry.entryKind === "web_search") {
    const queryText = summarizeInlineText(entry.query ?? "", 110);
    return queryText.length > 0 ? queryText : "Search web";
  }

  if (entry.entryKind === "tool") {
    if (entry.toolName) {
      const meta = getToolMeta(entry.toolName);
      if (meta.label === "Shell") {
        const args = readRecord(entry.args);
        const shellCmd = summarizeInlineText(typeof args?.command === "string" ? args.command : "", 110);
        return shellCmd.length > 0 ? shellCmd : "Run shell";
      }
      if (meta.label === "Search" && meta.category === "web") return "Search web";
    }
    const resultRecord = readRecord(entry.result);
    const resultSummary = typeof resultRecord?.summary === "string" ? resultRecord.summary.trim() : "";
    if (resultSummary.length > 0) {
      return summarizeInlineText(resultSummary, 110);
    }
    if (typeof entry.result === "string" && entry.result.trim().length > 0) {
      return summarizeInlineText(entry.result, 110);
    }
    const argsRecord = readRecord(entry.args);
    if (argsRecord) {
      const values = Object.values(argsRecord)
        .map((value) => typeof value === "string" ? value : JSON.stringify(value))
        .filter((value): value is string => Boolean(value && value.trim().length));
      if (values.length > 0) return summarizeInlineText(values.join(" "), 110);
    }
  }

  return summarizeInlineText(entry.detail ?? "", 110);
}

function workGroupSummaryLabel(entry: ChatWorkLogEntry): string {
  if (entry.entryKind === "command") return "ran shell";
  if (entry.entryKind === "file_change") {
    const firstFile = entry.changedFiles?.[0];
    if (firstFile?.kind === "create") return "created files";
    if (firstFile?.kind === "delete") return "deleted files";
    return "edited files";
  }
  if (entry.entryKind === "web_search") return "searched web";
  if (entry.entryKind === "tool" && entry.toolName) {
    const meta = getToolMeta(entry.toolName);
    if (meta.label === "Shell") return "ran shell";
    if (meta.label === "Read" || meta.label === "List Files" || meta.label === "List" || meta.label === "Find Files") return "read files";
    if (meta.label === "Search") return "searched";
    if (meta.label === "Write" || meta.label === "Edit" || meta.label === "Multi Edit" || meta.label === "Patch") return "edited files";
    if (meta.label === "Plan") return "updated plan";
    if (meta.label === "Plan Approval") return "reviewed plan";
    if (meta.label === "Memory" || meta.label === "Core Memory" || meta.label === "Memory Add" || meta.label === "Memory Pin") return "updated memory";
    return summarizeInlineText(replaceInternalToolNames(meta.label).toLowerCase(), 32);
  }
  return summarizeInlineText(replaceInternalToolNames(entry.label).toLowerCase(), 32);
}

function buildWorkGroupSummary({
  summary,
  entries,
}: {
  summary?: string;
  entries: ChatWorkLogEntry[];
}): string {
  const cleanedSummary = replaceInternalToolNames(summary?.trim() ?? "");
  if (cleanedSummary.length > 0) return cleanedSummary;

  const latestEntries = entries.slice(Math.max(0, entries.length - MAX_SUMMARY_WORK_LOG_ENTRIES));
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const entry of latestEntries) {
    const label = workGroupSummaryLabel(entry);
    if (!label.length || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  if (labels.length === 0) return "Recent tool calls";
  const summaryText = labels.slice(0, 3).join(", ");
  return `${summaryText.charAt(0).toUpperCase()}${summaryText.slice(1)}`;
}

function WorkLogEntryDetail({
  entry,
  onNavigateSuggestion,
}: {
  entry: ChatWorkLogEntry;
  onNavigateSuggestion?: (suggestion: OperatorNavigationSuggestion) => void;
}) {
  const sections: React.ReactNode[] = [];
  const navigationSuggestions = readNavigationSuggestions(entry.result);

  if (navigationSuggestions.length > 0 && onNavigateSuggestion) {
    sections.push(
      <div key="navigation" className="flex flex-wrap gap-2">
        {navigationSuggestions.map((suggestion) => (
          <button
            key={`${suggestion.surface}:${suggestion.href}`}
            type="button"
            className="ade-liquid-glass-pill rounded-full px-2.5 py-1 font-mono text-[10px] font-semibold text-accent/85 transition-colors hover:border-accent/25 hover:bg-accent/[0.14] hover:text-accent"
            onClick={() => onNavigateSuggestion(suggestion)}
          >
            {suggestion.label}
          </button>
        ))}
      </div>,
    );
  }

  if (entry.entryKind === "tool") {
    const args = readRecord(entry.args);
    if (args && Object.keys(args).length > 0) {
      sections.push(
        <div key="args">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-fg/35">Arguments</div>
          <pre className={cn("max-h-52", RECESSED_BLOCK_CLASS)}>
            {formatStructuredValue(args)}
          </pre>
        </div>,
      );
    }
    if (entry.result !== undefined) {
      sections.push(
        <div key="result">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-fg/35">Result</div>
          <pre className={cn("max-h-52", RECESSED_BLOCK_CLASS)}>
            {formatStructuredValue(entry.result)}
          </pre>
        </div>,
      );
    }
  }

  if (entry.entryKind === "command") {
    if (entry.command) {
      sections.push(
        <div key="command">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-fg/35">Command</div>
          <pre className={cn("max-h-40", RECESSED_BLOCK_CLASS)}>
            <span className="select-none text-amber-500/40">$ </span>
            {entry.command}
          </pre>
        </div>,
      );
    }
    if (entry.output?.trim().length) {
      sections.push(
        <div key="output">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-fg/35">Output</div>
          <pre className={cn("max-h-52", RECESSED_BLOCK_CLASS)}>
            {entry.output}
          </pre>
        </div>,
      );
    }
  }

  if (entry.entryKind === "file_change" && entry.changedFiles?.length) {
    sections.push(
      <div key="files" className="space-y-3">
        {entry.changedFiles.map((file) => (
          <div key={`${file.path}:${file.kind}`} className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-fg/45">
              <span>{formatFileAction(file.kind)}</span>
              <span className="normal-case tracking-normal text-fg/70">{file.path}</span>
              {file.additions > 0 ? <span className="text-emerald-400/70">+{file.additions}</span> : null}
              {file.deletions > 0 ? <span className="text-red-400/70">-{file.deletions}</span> : null}
            </div>
            {file.diff.trim().length ? (
              <DiffPreview diff={file.diff} />
            ) : (
              <div className="font-mono text-[11px] text-muted-fg/40">No diff payload available.</div>
            )}
          </div>
        ))}
      </div>,
    );
  }

  if (entry.entryKind === "web_search") {
    sections.push(
      <div key="web" className="space-y-2">
        {entry.query?.trim().length ? (
          <div>
            <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-fg/35">Query</div>
            <pre className={cn("max-h-40", RECESSED_BLOCK_CLASS)}>
              {entry.query}
            </pre>
          </div>
        ) : null}
        {entry.action?.trim().length ? (
          <div>
            <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-fg/35">Action</div>
            <pre className={cn("max-h-32", RECESSED_BLOCK_CLASS)}>
              {entry.action}
            </pre>
          </div>
        ) : null}
      </div>,
    );
  }

  if (sections.length === 0 && entry.detail?.trim().length) {
    sections.push(
      <div key="detail">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-fg/35">Detail</div>
        <pre className={cn("max-h-52", RECESSED_BLOCK_CLASS)}>
          {replaceInternalToolNames(entry.detail)}
        </pre>
      </div>,
    );
  }

  if (sections.length === 0) {
    return <div className="font-mono text-[11px] text-muted-fg/40">No additional detail available.</div>;
  }

  return <div className="space-y-3">{sections}</div>;
}

export function ChatWorkLogBlock({
  entries,
  summary,
  className,
  onNavigateSuggestion,
  animate = true,
}: {
  entries: ChatWorkLogEntry[];
  summary?: ChatWorkLogGroupEvent["summary"];
  className?: string;
  onNavigateSuggestion?: (suggestion: OperatorNavigationSuggestion) => void;
  animate?: boolean;
}) {
  const hasNavigationSuggestions = useMemo(
    () => entries.some((e) => readNavigationSuggestions(e.result).length > 0),
    [entries],
  );
  const [expanded, setExpanded] = useState(hasNavigationSuggestions);
  const [expandedEntries, setExpandedEntries] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (hasNavigationSuggestions) {
      setExpanded(true);
    }
  }, [hasNavigationSuggestions]);

  const groupSummary = useMemo(() => buildWorkGroupSummary({ summary, entries }), [entries, summary]);

  const groupStatus: ChatStatusVisualState = useMemo(() => {
    if (entries.some((e) => e.status === "failed")) return "failed";
    if (!animate) return "completed";
    if (entries.some((e) => e.status === "running")) return "working";
    if (entries.some((e) => e.status === "interrupted")) return "waiting";
    return "completed";
  }, [entries, animate]);

  const groupStatusLabel = useMemo(() => {
    if (groupStatus === "failed") return "failed";
    if (groupStatus === "working") return "running";
    if (groupStatus === "waiting") return "interrupted";
    return "completed";
  }, [groupStatus]);

  const latestEntry = entries[entries.length - 1];
  const { icon: LatestIcon, className: latestIconClass } = latestEntry
    ? workToneIcon(latestEntry)
    : { icon: Warning, className: "text-fg/34" };
  const latestIsMemory = latestEntry ? isMemoryToolEntry(latestEntry) : false;

  const toggleEntry = (entryId: string) => {
    setExpandedEntries((current) => ({
      ...current,
      [entryId]: !current[entryId],
    }));
  };

  const summaryText = entries.length === 1 && latestEntry
    ? replaceInternalToolNames(workEntryHeading(latestEntry))
    : groupSummary;

  return (
    <div className={cn(
      "ade-chat-work-card max-w-full rounded-[16px] px-3 py-2.5 transition-all",
      groupStatus === "failed" && "border-red-400/14 bg-red-500/[0.05] shadow-[0_16px_32px_-28px_rgba(239,68,68,0.45)]",
      className,
    )}>
      {/* Collapsed one-line summary */}
      <button
        type="button"
        className="group flex w-full items-center gap-2 rounded-[12px] px-1 py-1.5 text-left transition-colors hover:bg-white/[0.03]"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span className="inline-flex h-3 w-3 shrink-0 items-center justify-center">
          <ChatStatusGlyph status={groupStatus} size={11} />
        </span>
        {latestIsMemory ? (
          <span className="ade-memory-chip inline-flex h-5 w-5 shrink-0 items-center justify-center">
            <LatestIcon size={11} weight="regular" className={latestIconClass} />
          </span>
        ) : (
          <LatestIcon size={12} weight="regular" className={cn("shrink-0", latestIconClass)} />
        )}
        <span className="min-w-0 truncate font-mono text-[11px] text-fg/58">
          {summaryText}
        </span>
        {entries.length > 1 ? (
          <>
            <span className="shrink-0 text-[10px] text-fg/20">&middot;</span>
            <span className="ade-liquid-glass-pill shrink-0 rounded-full px-2 py-0.5 font-mono text-[9px] text-fg/34">
              {entries.length} calls
            </span>
          </>
        ) : null}
        <span className="shrink-0 text-[10px] text-fg/20">&middot;</span>
        <span className={cn(
          "ade-liquid-glass-pill shrink-0 rounded-full px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em]",
          chatStatusTextClass(groupStatus),
        )}>
          {groupStatusLabel}
        </span>
        {expanded ? (
          <CaretDown size={10} weight="bold" className="ml-auto shrink-0 text-fg/20" />
        ) : (
          <CaretRight size={10} weight="bold" className="ml-auto shrink-0 text-fg/20 transition-colors group-hover:text-fg/40" />
        )}
      </button>

      {/* Expanded entry list */}
      {expanded ? (
        <div className="ml-[23px] mt-1 space-y-1 border-l border-white/[0.06] pl-3 pb-1">
          {entries.map((entry) => {
            const { icon: EntryIcon, className: iconClassName } = workToneIcon(entry);
            const entryIsMemory = isMemoryToolEntry(entry);
            const hasSuggestions = readNavigationSuggestions(entry.result).length > 0;
            const isEntryExpanded = expandedEntries[entry.id] ?? (hasSuggestions || entry.status === "failed");
            const heading = replaceInternalToolNames(workEntryHeading(entry));
            const preview = workEntryPreview(entry);
            const statusLabel = workStatusLabel(entry.status, animate);
            const entryStatusState = workStatusState(entry.status, animate);

            return (
              <div key={entry.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-[10px] px-2 py-1.5 text-left transition-colors hover:bg-white/[0.03]"
                  onClick={() => toggleEntry(entry.id)}
                >
                  {isEntryExpanded ? (
                    <CaretDown size={9} weight="bold" className="shrink-0 text-fg/25" />
                  ) : (
                    <CaretRight size={9} weight="bold" className="shrink-0 text-fg/25" />
                  )}
                  <span className="inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center">
                    <ChatStatusGlyph status={entryStatusState} size={10} />
                  </span>
                  {entryIsMemory ? (
                    <span className="ade-memory-chip inline-flex h-5 w-5 shrink-0 items-center justify-center">
                      <EntryIcon size={10} weight="regular" className={iconClassName} />
                    </span>
                  ) : (
                    <EntryIcon size={11} weight="regular" className={cn("shrink-0", iconClassName)} />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[11px] text-fg/70">
                    {heading}
                  </span>
                  {preview.length > 0 && preview !== heading ? (
                    <span className="hidden max-w-[240px] shrink truncate font-mono text-[10px] text-fg/30 sm:inline">
                      {replaceInternalToolNames(preview)}
                    </span>
                  ) : null}
                  <span className={cn(
                    "ml-auto shrink-0 font-mono text-[9px] uppercase tracking-[0.12em]",
                    chatStatusTextClass(entryStatusState),
                  )}>
                    {statusLabel}
                  </span>
                </button>

                {isEntryExpanded ? (
                  <div className="ade-liquid-glass ml-5 mb-1.5 mt-1 rounded-[14px] px-3 py-2.5">
                    <WorkLogEntryDetail entry={entry} onNavigateSuggestion={onNavigateSuggestion} />
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

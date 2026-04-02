import React, { useMemo, useState } from "react";
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

const MAX_VISIBLE_WORK_LOG_ENTRIES = 4;
const RECESSED_BLOCK_CLASS =
  "overflow-auto whitespace-pre-wrap break-words rounded-[10px] border border-white/[0.05] bg-[#09090b] px-4 py-3 font-mono text-[11px] leading-[1.6] text-fg/76";

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
          background = "bg-emerald-500/[0.06]";
        } else if (line.startsWith("-")) {
          tone = "text-red-400/90";
          background = "bg-rose-500/[0.06]";
        } else if (line.startsWith("@@")) {
          tone = "text-accent/60";
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
      return { icon: FileCode, className: isFailed ? FAILED_ICON_CLASS : "text-emerald-300/75" };
    case "web_search":
      return { icon: Globe, className: isFailed ? FAILED_ICON_CLASS : "text-cyan-300/75" };
  }

  return { icon: Warning, className: "text-fg/34" };
}

function workStatusState(status: ChatWorkLogEntry["status"]): ChatStatusVisualState {
  if (status === "completed" || status === "failed") return status;
  if (status === "interrupted") return "waiting";
  return "working";
}

function workStatusLabel(status: ChatWorkLogEntry["status"]): string {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return "running";
  }
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

  const latestEntries = entries.slice(Math.max(0, entries.length - MAX_VISIBLE_WORK_LOG_ENTRIES));
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const entry of latestEntries) {
    const label = workGroupSummaryLabel(entry);
    if (!label.length || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  if (labels.length === 0) return "Recent agent activity";
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
            className="rounded-[8px] border border-accent/20 bg-accent/[0.08] px-2.5 py-1 font-mono text-[10px] font-semibold text-accent/85 transition-colors hover:bg-accent/[0.14] hover:text-accent"
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
              {file.additions > 0 ? <span className="text-emerald-300/70">+{file.additions}</span> : null}
              {file.deletions > 0 ? <span className="text-red-300/70">-{file.deletions}</span> : null}
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
}: {
  entries: ChatWorkLogEntry[];
  summary?: ChatWorkLogGroupEvent["summary"];
  className?: string;
  onNavigateSuggestion?: (suggestion: OperatorNavigationSuggestion) => void;
}) {
  const [expandedGroup, setExpandedGroup] = useState(false);
  const [expandedEntries, setExpandedEntries] = useState<Record<string, boolean>>({});
  const hasOverflow = entries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleEntries = hasOverflow && !expandedGroup
    ? entries.slice(Math.max(0, entries.length - MAX_VISIBLE_WORK_LOG_ENTRIES))
    : entries;
  const hiddenCount = entries.length - visibleEntries.length;
  const groupSummary = useMemo(() => buildWorkGroupSummary({ summary, entries }), [entries, summary]);

  const toggleEntry = (entryId: string) => {
    setExpandedEntries((current) => ({
      ...current,
      [entryId]: !current[entryId],
    }));
  };

  return (
    <div className={cn("rounded-2xl border border-white/[0.06] bg-[#111317]/78 px-3 py-3", className)}>
      <div className="mb-2.5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-fg/50">
            Activity
          </p>
          <p className="mt-1 text-[13px] leading-5 text-fg/82">
            {groupSummary}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-fg/46">
            {entries.length} step{entries.length === 1 ? "" : "s"}
          </span>
          {hasOverflow ? (
            <button
              type="button"
              className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-fg/55 transition-colors duration-150 hover:text-fg/75"
              onClick={() => setExpandedGroup((current) => !current)}
            >
              {expandedGroup ? "Show fewer" : `Show ${hiddenCount} earlier`}
            </button>
          ) : null}
        </div>
      </div>

      <div className="space-y-1.5">
        {visibleEntries.map((entry) => {
          const { icon: EntryIcon, className: iconClassName } = workToneIcon(entry);
          const hasSuggestions = readNavigationSuggestions(entry.result).length > 0;
          const isExpanded = (expandedEntries[entry.id] ?? hasSuggestions) || entry.status === "failed";
          const heading = replaceInternalToolNames(workEntryHeading(entry));
          const preview = workEntryPreview(entry);
          const statusLabel = workStatusLabel(entry.status);

          return (
            <div key={entry.id} className="rounded-xl border border-white/[0.05] bg-black/15">
              <button
                type="button"
                className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left"
                onClick={() => toggleEntry(entry.id)}
              >
                {isExpanded ? (
                  <CaretDown size={10} weight="bold" className="mt-1 text-fg/30" />
                ) : (
                  <CaretRight size={10} weight="bold" className="mt-1 text-fg/30" />
                )}
                <span className="mt-0.5 inline-flex h-3 w-3 items-center justify-center">
                  <ChatStatusGlyph status={workStatusState(entry.status)} size={11} />
                </span>
                <EntryIcon size={12} weight="regular" className={cn("mt-0.5", iconClassName)} />
                <div className="min-w-0 flex-1 overflow-hidden">
                  <p className="truncate text-[12px] leading-5 text-fg/80">{heading}</p>
                  {preview.length > 0 && preview !== heading ? (
                    <p className="truncate font-mono text-[10px] leading-4 text-fg/42">
                      {replaceInternalToolNames(preview)}
                    </p>
                  ) : null}
                </div>
                <span className={cn(
                  "mt-0.5 shrink-0 font-mono text-[9px] uppercase tracking-[0.12em]",
                  chatStatusTextClass(workStatusState(entry.status)),
                )}>
                  {statusLabel}
                </span>
              </button>

              {isExpanded ? (
                <div className="border-t border-white/[0.04] px-3 py-3">
                  <WorkLogEntryDetail entry={entry} onNavigateSuggestion={onNavigateSuggestion} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

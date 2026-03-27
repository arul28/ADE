import React, { useState } from "react";
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
  type ChatWorkLogEntry,
  type ChatWorkLogFileChange,
} from "./chatTranscriptRows";
import { cn } from "../ui/cn";
import { getToolMeta } from "./chatToolAppearance";
import { ChatStatusGlyph, chatStatusTextClass } from "./chatStatusVisuals";
import { describeToolIdentifier, replaceInternalToolNames } from "./toolPresentation";

const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;
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

function workStatusState(status: ChatWorkLogEntry["status"]): "working" | "completed" | "failed" {
  if (status === "completed" || status === "failed") return status;
  return "working";
}

function workStatusLabel(status: ChatWorkLogEntry["status"]): string {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "running";
  }
}

function workEntryHeading(entry: ChatWorkLogEntry): string {
  if (entry.entryKind === "tool" && entry.toolName) {
    const meta = getToolMeta(entry.toolName);
    const toolDisplay = describeToolIdentifier(entry.toolName);
    const args = readRecord(entry.args) ?? {};
    const targetLine = meta.getTarget ? meta.getTarget(args) : null;
    if (targetLine) return `${meta.label} ${targetLine}`.trim();
    if (toolDisplay.secondaryLabel) return `${meta.label} ${toolDisplay.secondaryLabel}`.trim();
    return meta.label;
  }

  if (entry.entryKind === "command") {
    return "Shell";
  }

  if (entry.entryKind === "file_change") {
    const firstFile = entry.changedFiles?.[0];
    if (!firstFile) return "File change";
    const action = formatFileAction(firstFile.kind);
    if (entry.changedFiles!.length === 1) return `${action} ${basenamePathLabel(firstFile.path)}`;
    return `${action} ${basenamePathLabel(firstFile.path)} +${entry.changedFiles!.length - 1} more`;
  }

  if (entry.entryKind === "web_search") {
    return "Web search";
  }

  return entry.label;
}

function workEntryPreview(entry: ChatWorkLogEntry): string {
  if (entry.entryKind === "command") {
    return summarizeInlineText(entry.command ?? "", 110);
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
    return summarizeInlineText(entry.query ?? "", 110);
  }

  if (entry.entryKind === "tool") {
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
  className,
  onNavigateSuggestion,
}: {
  entries: ChatWorkLogEntry[];
  className?: string;
  onNavigateSuggestion?: (suggestion: OperatorNavigationSuggestion) => void;
}) {
  const [expandedGroup, setExpandedGroup] = useState(false);
  const [expandedEntries, setExpandedEntries] = useState<Record<string, boolean>>({});
  const reversedEntries = [...entries].reverse();
  const hasOverflow = entries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleEntries = hasOverflow && !expandedGroup
    ? reversedEntries.slice(0, MAX_VISIBLE_WORK_LOG_ENTRIES)
    : reversedEntries;
  const hiddenCount = entries.length - visibleEntries.length;
  const onlyToolEntries = entries.every((entry) => entry.entryKind === "tool");
  const groupLabel = onlyToolEntries ? "Tool calls" : "Work log";

  const toggleEntry = (entryId: string) => {
    setExpandedEntries((current) => ({
      ...current,
      [entryId]: !current[entryId],
    }));
  };

  return (
    <div className={cn("rounded-xl border border-white/[0.06] bg-[#111317]/70 px-2 py-1.5", className)}>
      <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
        <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-fg/55">
          {groupLabel} ({entries.length})
        </p>
        {hasOverflow ? (
          <button
            type="button"
            className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-fg/55 transition-colors duration-150 hover:text-fg/75"
            onClick={() => setExpandedGroup((current) => !current)}
          >
            {expandedGroup ? "Show less" : `Show ${hiddenCount} more`}
          </button>
        ) : null}
      </div>

      <div className="space-y-1">
        {visibleEntries.map((entry) => {
          const { icon: EntryIcon, className: iconClassName } = workToneIcon(entry);
          const hasSuggestions = readNavigationSuggestions(entry.result).length > 0;
          const isExpanded = (expandedEntries[entry.id] ?? hasSuggestions) || entry.status === "failed";
          const heading = workEntryHeading(entry);
          const preview = workEntryPreview(entry);
          const statusLabel = workStatusLabel(entry.status);

          return (
            <div key={entry.id} className="rounded-lg border border-white/[0.04] bg-black/15">
              <button
                type="button"
                className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
                onClick={() => toggleEntry(entry.id)}
              >
                {isExpanded ? (
                  <CaretDown size={10} weight="bold" className="text-fg/30" />
                ) : (
                  <CaretRight size={10} weight="bold" className="text-fg/30" />
                )}
                <span className="inline-flex h-3 w-3 items-center justify-center">
                  <ChatStatusGlyph status={workStatusState(entry.status)} size={11} />
                </span>
                <EntryIcon size={12} weight="regular" className={iconClassName} />
                <div className="min-w-0 flex-1 overflow-hidden">
                  <p className="truncate font-mono text-[11px] leading-5 text-fg/78">
                    {preview.length ? `${heading} - ${preview}` : heading}
                  </p>
                </div>
                <span className={cn(
                  "shrink-0 font-mono text-[9px] uppercase tracking-[0.12em]",
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

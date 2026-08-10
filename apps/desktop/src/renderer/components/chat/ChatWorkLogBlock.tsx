import React, { useEffect, useMemo, useState } from "react";
import { ArrowSquareOut, CaretDown, CaretRight, Check, Globe, Terminal, Warning, XCircle } from "@phosphor-icons/react";
import type { OperatorNavigationSuggestion } from "../../../shared/types";
import {
  deriveWebSearchResultDisplay,
  formatStructuredValue,
  readRecord,
  summarizeDiffStats,
  summarizeInlineText,
  type ChatLocalhostUrl,
  type ChatWorkLogGroupEvent,
  type ChatWorkLogEntry,
  type ChatWorkLogFileChange,
} from "./chatTranscriptRows";
import { cn } from "../ui/cn";
import { getToolMeta } from "./chatToolAppearance";
import { replaceInternalToolNames } from "./toolPresentation";
import { openUrlInAdeBrowser } from "../../lib/openExternal";
import { useChatWorkspacePaths } from "./chatWorkspacePaths";

const NAVIGATION_SURFACES = new Set(["work", "lanes", "cto"]);
const WORK_LOG_DETAIL_TRUNCATE_LIMIT = 500;

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
  if (entry.entryKind === "hook") {
    return summarizeInlineText(entry.detail ?? entry.label, 140);
  }
  if (entry.entryKind === "tool" && entry.toolName) {
    if (entry.mcp) {
      const args = readRecord(entry.args) ?? {};
      for (const key of ["query", "url", "path", "file_path", "name", "id"] as const) {
        const value = args[key];
        if (typeof value === "string" && value.trim().length) {
          return summarizeInlineText(value, 140);
        }
      }
      return summarizeInlineText(entry.detail ?? entry.mcp.tool, 140);
    }
    const meta = getToolMeta(entry.toolName);
    const args = readRecord(entry.args) ?? {};
    const target = meta.getTarget ? meta.getTarget(args) : null;
    if (target) return summarizeInlineText(target, 140);
    if (entry.detail) return summarizeInlineText(entry.detail, 140);
  }
  return "";
}

function collectLocalhostUrls(entries: ChatWorkLogEntry[]): ChatLocalhostUrl[] {
  const urls: ChatLocalhostUrl[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const url of entry.localUrls ?? []) {
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      urls.push(url);
    }
  }
  return urls.slice(0, 4);
}

const PORT_PROBE_POSITIVE_TTL_MS = 5 * 60 * 1000;
const PORT_PROBE_NEGATIVE_TTL_MS = 30 * 1000;

type PortProbeCacheEntry = { alive: boolean; checkedAtMs: number };

const portProbeCache = new Map<number, PortProbeCacheEntry>();
const portProbeInFlight = new Map<number, Promise<boolean>>();

function isCacheEntryFresh(entry: PortProbeCacheEntry, nowMs: number): boolean {
  const ttl = entry.alive ? PORT_PROBE_POSITIVE_TTL_MS : PORT_PROBE_NEGATIVE_TTL_MS;
  return nowMs - entry.checkedAtMs < ttl;
}

async function runPortProbe(port: number): Promise<boolean> {
  const existing = portProbeInFlight.get(port);
  if (existing) return existing;
  const probe = window.ade?.localhost?.probePort;
  if (typeof probe !== "function") return false;
  const promise = (async () => {
    try {
      const alive = Boolean(await probe(port));
      portProbeCache.set(port, { alive, checkedAtMs: Date.now() });
      return alive;
    } catch {
      portProbeCache.set(port, { alive: false, checkedAtMs: Date.now() });
      return false;
    } finally {
      portProbeInFlight.delete(port);
    }
  })();
  portProbeInFlight.set(port, promise);
  return promise;
}

function useLiveLocalhostUrls(urls: ChatLocalhostUrl[]): ChatLocalhostUrl[] {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const now = Date.now();
    const portsToProbe = new Set<number>();
    for (const url of urls) {
      if (url.port === null) continue;
      const cached = portProbeCache.get(url.port);
      if (!cached || !isCacheEntryFresh(cached, now)) portsToProbe.add(url.port);
    }
    if (portsToProbe.size === 0) return;
    void Promise.all(Array.from(portsToProbe, (port) => runPortProbe(port))).then(() => {
      if (!cancelled) setTick((value) => value + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [urls]);

  return useMemo(() => {
    const now = Date.now();
    return urls.filter((url) => {
      if (url.port === null) return false;
      const cached = portProbeCache.get(url.port);
      if (!cached || !isCacheEntryFresh(cached, now)) return false;
      return cached.alive;
    });
  }, [urls, tick]);
}

function localhostUrlLabel(url: ChatLocalhostUrl): string {
  if (url.port !== null) return `localhost:${url.port}`;
  try {
    const parsed = new URL(url.href);
    return parsed.host || url.host;
  } catch {
    return url.host;
  }
}

function commandForLocalhostUrl(entries: ChatWorkLogEntry[], url: ChatLocalhostUrl): string | null {
  const sourceEntry = entries.find((entry) =>
    (entry.localUrls ?? []).some((candidate) => candidate.href === url.href),
  ) ?? entries[0];
  if (!sourceEntry) return null;
  const trimmed = (sourceEntry.command ?? entryArgText(sourceEntry)).trim();
  return trimmed.length ? trimmed : null;
}

function terminalizePrompt(args: {
  url: ChatLocalhostUrl;
  command: string | null;
  sessionId?: string | null;
}): string {
  const lines = [
    `Please reopen or move the local server for ${args.url.href} into this ADE chat terminal so I can watch the logs here.`,
  ];
  if (args.command) lines.push("", `Detected command: \`${args.command}\``);
  if (args.sessionId) lines.push("", `Chat session: \`${args.sessionId}\``);
  lines.push(
    "",
    "Use ADE CLI terminal/app-control commands where helpful, for example `ade terminal list --chat-session <id> --text`, `ade terminal read --chat-session <id> --text`, or `ade app-control launch --command \"<command>\" --text`.",
    "After it is running, verify the localhost URL and keep the process logs readable from the chat terminal.",
  );
  return lines.join("\n");
}

/** Short slug for the tool rail (e.g. `bash`, `grep`, `spawn_chat`) — not a full sentence. */
function workLogEntryKindSlug(entry: ChatWorkLogEntry): string {
  if (entry.entryKind === "command") return "shell";
  if (entry.entryKind === "web_search") return "search";
  if (entry.entryKind === "hook") return "hook";
  if (entry.entryKind === "tool" && entry.toolName?.trim()) {
    let raw = entry.mcp
      ? (entry.mcp.appContext?.appName ?? entry.mcp.pluginId ?? entry.mcp.server)
      : entry.toolName.trim();
    if (raw.includes(".")) {
      raw = raw.split(".").pop() ?? raw;
    }
    const snake = raw
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase();
    if (snake === "exec_command") return "shell";
    return snake || "tool";
  }
  return entry.label.replace(/\s+/g, "_").toLowerCase() || "tool";
}

function entryHasResolvedPayload(entry: ChatWorkLogEntry): boolean {
  if (entry.result !== undefined) return true;
  if (typeof entry.output === "string" && /\S/.test(entry.output)) return true;
  if (entry.changedFiles && entry.changedFiles.length > 0) return true;
  return false;
}

function resolvedEntryStatus(entry: ChatWorkLogEntry): EntryStatus {
  if (entry.status === "failed") return "failed";
  if (entry.status === "interrupted") return "interrupted";
  if (entry.status === "completed") return "completed";
  if (entry.status === "running" && entryHasResolvedPayload(entry)) return "completed";
  return entry.status;
}

function workLogStatusGlyph(entry: ChatWorkLogEntry) {
  const status = resolvedEntryStatus(entry);
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

function workLogEntryKindToneClass(entry: ChatWorkLogEntry): string {
  const status = resolvedEntryStatus(entry);
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

export function dedupeChatToolActivityEntries(entries: ChatWorkLogEntry[]): ChatWorkLogEntry[] {
  const byId = new Map<string, ChatWorkLogEntry>();
  for (const entry of entries) {
    // Canonical file-change events keep their own chronological transcript
    // panel. A write tool can still appear here as an action, but the resulting
    // file event itself should not be duplicated inside activity details.
    if (entry.entryKind === "file_change") continue;
    byId.set(entry.id, entry);
  }
  return Array.from(byId.values());
}

function FlatPre({ children }: { children: React.ReactNode }) {
  return (
    <pre className="mt-1 ml-[18px] max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-white/[0.05] pt-2 font-mono text-[length:calc(var(--chat-font-size)*11/14)] leading-[1.55] text-fg/55">
      {children}
    </pre>
  );
}

function DiffBody({ diff }: { diff: string }) {
  const lines = diff.split(/\r?\n/);
  return (
    <pre className="mt-1 ml-[18px] max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-white/[0.05] pt-2 font-mono text-[length:calc(var(--chat-font-size)*11/14)] leading-[1.55] text-fg/65">
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

function webSearchUrlActions(entry: ChatWorkLogEntry): NonNullable<ChatWorkLogEntry["actions"]> {
  if (entry.entryKind !== "web_search" || !entry.actions?.length) return [];
  return entry.actions.filter((action) => typeof action.url === "string" && action.url.trim().length > 0);
}

const WEB_SEARCH_RESULT_LIMIT = 8;

function webSearchResults(entry: ChatWorkLogEntry): NonNullable<ChatWorkLogEntry["results"]> {
  if (entry.entryKind !== "web_search" || !entry.results?.length) return [];
  return entry.results.slice(0, WEB_SEARCH_RESULT_LIMIT);
}

function WebSearchResultRows({ entry }: { entry: ChatWorkLogEntry }) {
  const results = webSearchResults(entry);
  if (results.length === 0) return null;
  const total = typeof entry.resultsTotal === "number" ? entry.resultsTotal : results.length;
  const moreCount = Math.max(0, total - results.length);
  return (
    <div className="mt-1 ml-[18px] flex min-w-0 max-w-full flex-col gap-0.5 border-t border-white/[0.05] pt-2">
      {results.map((result, index) => {
        const display = deriveWebSearchResultDisplay(result);
        const body = (
          <>
            <Globe size={10} weight="bold" className="shrink-0 text-cyan-100/45" aria-hidden />
            <span className="min-w-0 truncate">{display.title}</span>
            {display.domain ? (
              <span className="shrink-0 truncate text-cyan-100/45">{display.domain}</span>
            ) : null}
            {display.href ? (
              <ArrowSquareOut size={10} weight="bold" className="ml-auto shrink-0 text-cyan-100/40" aria-hidden />
            ) : null}
          </>
        );
        const className =
          "flex min-w-0 max-w-full items-center gap-1.5 rounded-[5px] px-1 py-0.5 text-left font-sans text-[length:calc(var(--chat-font-size)*11/14)] text-cyan-100/78";
        return display.href ? (
          <button
            key={`${display.href}:${index}`}
            type="button"
            onClick={() => openUrlInAdeBrowser(display.href!)}
            className={cn(className, "transition-colors hover:bg-cyan-400/[0.06] hover:text-cyan-50")}
            title={display.href}
          >
            {body}
          </button>
        ) : (
          <span key={`result:${index}`} className={className}>
            {body}
          </span>
        );
      })}
      {moreCount > 0 ? (
        <span className="ml-1 font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-fg/35">
          +{moreCount} more
        </span>
      ) : null}
    </div>
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
  const [detailExpanded, setDetailExpanded] = useState(false);

  useEffect(() => {
    if (navigationSuggestions.length > 0) setOpen(true);
  }, [navigationSuggestions.length]);

  const kindSlug = workLogEntryKindSlug(entry);
  const argText = replaceInternalToolNames(entryArgText(entry));
  const kindTone = workLogEntryKindToneClass(entry);
  const searchResults = webSearchResults(entry);
  // Structured results are the richer, deduped surface; fall back to raw action
  // URLs only when the provider didn't send a results array.
  const searchUrlActions = searchResults.length > 0 ? [] : webSearchUrlActions(entry);

  const detailBody = useMemo(() => buildEntryDetail(entry), [entry]);
  const detailIsTruncated = Boolean(detailBody && detailBody.length > WORK_LOG_DETAIL_TRUNCATE_LIMIT);
  const visibleDetailBody = detailBody && detailIsTruncated && !detailExpanded
    ? `${detailBody.slice(0, WORK_LOG_DETAIL_TRUNCATE_LIMIT)}...`
    : detailBody;

  return (
    <div className="min-w-0 max-w-full overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full min-w-0 max-w-full items-center gap-2.5 rounded-[6px] px-1.5 py-1 text-left transition-colors hover:bg-white/[0.025]"
      >
        {workLogStatusGlyph(entry)}
        <span className={cn("shrink-0 font-mono text-[length:calc(var(--chat-font-size)*11/14)] font-medium tracking-tight", kindTone)}>
          {kindSlug}
        </span>
        {argText ? (
          <span className="min-w-0 truncate font-sans text-[length:calc(var(--chat-font-size)*13/14)] leading-[1.55] text-fg/88">{argText}</span>
        ) : null}
      </button>
      {open && navigationSuggestions.length > 0 && onNavigateSuggestion ? (
        <div className="mt-1 ml-[18px] flex min-w-0 max-w-full flex-wrap gap-1.5 border-t border-white/[0.05] pt-2">
          {navigationSuggestions.map((suggestion) => (
            <button
              key={`${suggestion.surface}:${suggestion.href}`}
              type="button"
              onClick={() => onNavigateSuggestion(suggestion)}
              className="rounded-[6px] border border-accent/20 px-2 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*10/14)] font-semibold text-accent/85 transition-colors hover:border-accent/40 hover:text-accent"
            >
              {suggestion.label}
            </button>
          ))}
        </div>
      ) : null}
      {open && searchResults.length > 0 ? <WebSearchResultRows entry={entry} /> : null}
      {open && searchUrlActions.length > 0 ? (
        <div className="mt-1 ml-[18px] flex min-w-0 max-w-full flex-wrap gap-1.5 border-t border-white/[0.05] pt-2">
          {searchUrlActions.slice(0, 6).map((action, index) => {
            const label = action.title ?? action.url ?? `Result ${index + 1}`;
            return (
              <button
                key={`${action.url}:${index}`}
                type="button"
                onClick={() => openUrlInAdeBrowser(action.url)}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-cyan-300/15 bg-cyan-400/[0.06] px-2 py-0.5 text-left font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-cyan-100/78 transition-colors hover:border-cyan-300/30 hover:bg-cyan-400/[0.11] hover:text-cyan-50"
                title={action.url}
              >
                <Globe size={10} weight="bold" className="shrink-0" aria-hidden />
                <span className="min-w-0 truncate">{label}</span>
                <ArrowSquareOut size={10} weight="bold" className="shrink-0 text-cyan-100/45" aria-hidden />
              </button>
            );
          })}
        </div>
      ) : null}
      {open && visibleDetailBody ? (
        <>
          <FlatPre>{visibleDetailBody}</FlatPre>
          {detailIsTruncated ? (
            <button
              type="button"
              className="mt-1 ml-[18px] font-mono text-[length:calc(var(--chat-font-size)*10/14)] text-accent/60 hover:text-accent"
              onClick={() => setDetailExpanded((current) => !current)}
            >
              {detailExpanded ? "collapse" : `show all (${detailBody!.length} chars)`}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function buildEntryDetail(entry: ChatWorkLogEntry): string | null {
  if (entry.entryKind === "command") {
    const out = entry.output?.trim();
    if (!out) return null;
    return out;
  }
  if (entry.entryKind === "hook") {
    const out = entry.output?.trim();
    if (out) return out;
    return entry.detail?.trim().length ? entry.detail : null;
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
  const latestTone = workLogEntryKindToneClass(latest);
  const Caret = panelOpen ? CaretDown : CaretRight;

  return (
    <div className="w-full min-w-0 font-sans text-[length:calc(var(--chat-font-size)*11/14)]">
      <button
        type="button"
        onClick={() => setPanelOpen((v) => !v)}
        aria-expanded={panelOpen}
        className="flex w-full min-w-0 max-w-full items-center gap-1.5 py-0.5 text-left transition-colors hover:text-fg/80"
      >
        <Caret size={9} weight="bold" className="shrink-0 text-violet-400/45" />
        <span className="shrink-0 font-medium text-fg/45">Tool calls</span>
        <span className="shrink-0 text-[length:calc(var(--chat-font-size)*10/14)] tabular-nums text-fg/30">({entries.length})</span>
        {panelOpen ? null : (
          <span className="ml-1 flex min-w-0 flex-1 items-center gap-1.5">
            {workLogStatusGlyph(latest)}
            <span className={cn("shrink-0 font-mono text-[length:calc(var(--chat-font-size)*11/14)] font-medium tracking-tight", latestTone)}>
              {latestSlug}
            </span>
            {latestArg ? (
              <span className="min-w-0 flex-1 truncate font-sans text-[length:calc(var(--chat-font-size)*13/14)] leading-[1.55] text-fg/88">{latestArg}</span>
            ) : null}
          </span>
        )}
      </button>
      {panelOpen ? (
        <div className="mt-1.5 w-full min-w-0 max-w-full space-y-0.5 overflow-hidden pl-4">
          {entries.map((entry) => (
            <ToolCallRow key={entry.id} entry={entry} onNavigateSuggestion={onNavigateSuggestion} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ChatToolActivityDetails({
  entries,
  className,
  onNavigateSuggestion,
  onInsertDraft,
  onRevealChatTerminal,
  sessionId,
}: {
  entries: ChatWorkLogEntry[];
  className?: string;
  onNavigateSuggestion?: (suggestion: OperatorNavigationSuggestion) => void;
  onInsertDraft?: (text: string) => void;
  onRevealChatTerminal?: (terminal: { terminalId: string; ptyId: string; label: string }) => void;
  sessionId?: string | null;
}) {
  const activityEntries = useMemo(() => dedupeChatToolActivityEntries(entries), [entries]);
  // Keep the LAST call — the one that says what the agent is doing now — plus
  // anything that FAILED, and fold the quiet successes behind a count. A 50-row
  // scroll box of finished tool calls is noise; a rejected hook or a failed
  // command is not, and must never be what the fold hides.
  const [showHistory, setShowHistory] = useState(false);
  const visibleEntries = useMemo(() => {
    if (showHistory || activityEntries.length <= 1) return activityEntries;
    const lastIndex = activityEntries.length - 1;
    return activityEntries.filter((entry, index) => (
      index === lastIndex
      || entry.tone === "error"
      || entry.status === "failed"
      || entry.status === "interrupted"
      || entry.status === "running"
    ));
  }, [activityEntries, showHistory]);
  if (activityEntries.length === 0) return null;
  const hiddenCount = activityEntries.length - visibleEntries.length;
  return (
    <div className={cn("min-w-0 max-w-full overflow-hidden", className)}>
      <LocalhostServersStrip
        entries={activityEntries}
        sessionId={sessionId}
        onInsertDraft={onInsertDraft}
        onRevealChatTerminal={onRevealChatTerminal}
      />
      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setShowHistory(true)}
          aria-expanded={false}
          className="flex items-center gap-1.5 px-1 py-0.5 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-fg/40 transition-colors hover:text-fg/70"
        >
          <CaretDown size={10} weight="bold" aria-hidden />
          +{hiddenCount} previous tool call{hiddenCount === 1 ? "" : "s"}
        </button>
      ) : null}
      <div className="max-h-72 min-w-0 max-w-full space-y-0.5 overflow-x-hidden overflow-y-auto overscroll-contain pr-1">
        {visibleEntries.map((entry) => (
          <ToolCallRow key={entry.id} entry={entry} onNavigateSuggestion={onNavigateSuggestion} />
        ))}
      </div>
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
    <div className="min-w-0 max-w-full space-y-1.5 overflow-hidden">
      <div className="flex min-w-0 max-w-full items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-[6px] px-1 py-0.5 text-left transition-colors hover:bg-white/[0.025]"
        >
          <Caret size={10} weight="bold" className="text-fg/35" />
          <span className="font-sans text-[length:calc(var(--chat-font-size)*11/14)] font-medium text-fg/70">
            {files.length} {fileWord} changed
          </span>
        </button>
        {onUndo ? (
          <button
            type="button"
            onClick={onUndo}
            className="font-sans text-[length:calc(var(--chat-font-size)*11/14)] text-fg/40 transition-colors hover:text-fg/65"
          >
            Undo
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="min-w-0 max-w-full space-y-0.5 overflow-hidden pl-[18px]">
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
                  className="flex w-full min-w-0 max-w-full items-center gap-3 rounded-[6px] px-1.5 py-1 text-left transition-colors hover:bg-white/[0.025]"
                >
                  <span className="inline-flex h-3.5 w-7 shrink-0 items-center justify-center rounded-[3px] border border-white/[0.06] bg-white/[0.02] font-mono text-[length:calc(var(--chat-font-size)*8/14)] font-bold tracking-wider text-fg/40">
                    {fileExtBadge(file.path)}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-fg/65">
                    {file.path}
                  </span>
                  {file.kind !== "modify" ? (
                    <span className="shrink-0 font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-fg/40">
                      {formatFileAction(file.kind)}
                    </span>
                  ) : null}
                  {file.additions > 0 ? (
                    <span className="shrink-0 font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-emerald-400/80">
                      +{file.additions}
                    </span>
                  ) : null}
                  {file.deletions > 0 ? (
                    <span className="shrink-0 font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-red-400/80">
                      −{file.deletions}
                    </span>
                  ) : null}
                </button>
                {expanded && file.diff.trim().length ? <DiffBody diff={file.diff} /> : null}
                {expanded && !file.diff.trim().length ? (
                  <div className="mt-1 ml-[18px] border-t border-white/[0.05] pt-2 font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-fg/35">
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

/**
 * Turn-level "Files changed" — ONE collapsed row at the end of a turn.
 *
 * The timeline drops `work_log_group` rows wholesale, so this is the only
 * per-turn files summary in the thread. It replaced a per-burst panel that
 * rendered once per uninterrupted run of tool entries — a turn whose runs were
 * broken up by prose stacked six near-identical panels through one reply. This
 * aggregates the whole turn's entries, deduped by path with a net diffstat, and
 * starts collapsed.
 *
 * It is the harness-independent fallback: it reads only `ChatWorkLogEntry`
 * file/tool events, so it works for every runtime (claude/codex/cursor/droid/
 * opencode/pi) whether or not the turn produced a git checkpoint. When a turn
 * DID move HEAD, the checkpoint-backed `turn_diff_summary` event renders
 * instead — that one can offer real diffs and a SHA-scoped revert.
 *
 * Paths render lane-relative (the absolute path the tool reported stays in the
 * row's tooltip) and open in the Files tab, both via the chat's workspace-path
 * context.
 */
export const ChatTurnFilesChangedSummary = React.memo(function ChatTurnFilesChangedSummary({
  entries,
  onReviewInFiles,
}: {
  entries: ChatWorkLogEntry[];
  onReviewInFiles?: () => void;
}) {
  // Opening and display-formatting are two halves of the same hook, so both ride
  // the chat's workspace-path context rather than being threaded as props.
  const workspacePaths = useChatWorkspacePaths();
  const onOpenPath = workspacePaths?.openWorkspacePath;
  const formatDisplayPath = workspacePaths?.formatWorkspaceDisplayPath;
  const ensureWorkspacesLoaded = workspacePaths?.ensureWorkspacesLoaded;
  const [open, setOpen] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
  const files = useMemo(
    () => aggregateFilesFromEntries(entries.filter(isCodeChangeEntry)),
    [entries],
  );
  if (files.length === 0) return null;

  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const Caret = open ? CaretDown : CaretRight;

  return (
    <div className="mt-2 w-full min-w-0 max-w-[var(--chat-content-width,52rem)] space-y-1.5 overflow-hidden">
      <div className="flex min-w-0 max-w-full items-center gap-2">
        <button
          type="button"
          onClick={() => {
            // Paths are only rendered once expanded, so this is the moment the
            // lane-relative form is needed — and the cheapest point to warm the
            // workspace roots without an IPC call on every chat mount.
            if (!open) ensureWorkspacesLoaded?.();
            setOpen((value) => !value);
          }}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-[6px] px-1 py-0.5 text-left transition-colors hover:bg-white/[0.025]"
        >
          <Caret size={10} weight="bold" className="text-fg/35" />
          <span className="font-sans text-[length:calc(var(--chat-font-size)*11/14)] font-medium text-fg/70">
            {files.length} file{files.length === 1 ? "" : "s"} changed
          </span>
          {additions > 0 ? (
            <span className="shrink-0 font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-emerald-400/80">
              +{additions}
            </span>
          ) : null}
          {deletions > 0 ? (
            <span className="shrink-0 font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-red-400/80">
              −{deletions}
            </span>
          ) : null}
        </button>
        {onReviewInFiles ? (
          <button
            type="button"
            onClick={onReviewInFiles}
            className="font-sans text-[length:calc(var(--chat-font-size)*11/14)] text-fg/40 transition-colors hover:text-fg/65"
          >
            Review in Files
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="min-w-0 max-w-full space-y-0.5 overflow-hidden pl-[18px]">
          {files.map((file) => {
            const display = formatDisplayPath ? formatDisplayPath(file.path) : file.path;
            const hasDiff = file.diff.trim().length > 0;
            const expanded = expandedFiles[file.path] ?? false;
            return (
              <div key={file.path}>
              <div
                className={cn(
                  "group/file relative flex w-full min-w-0 max-w-full items-center gap-3 rounded-[6px] px-1.5 py-1",
                  hasDiff && "hover:bg-white/[0.025]",
                )}
              >
                {/* The diff payload rides on the work-log entry, so it is the
                    only in-thread way to see what changed on a turn that never
                    moved HEAD (no checkpoint, hence no `turn_diff_summary`).
                    The toggle covers the whole row — a 28x14 badge is below the
                    minimum pointer target — and the path button sits above it. */}
                {hasDiff ? (
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={`${expanded ? "Hide" : "Show"} diff for ${display}`}
                    onClick={() => setExpandedFiles((current) => ({ ...current, [file.path]: !expanded }))}
                    className="absolute inset-0 rounded-[6px]"
                  />
                ) : null}
                <span className="pointer-events-none inline-flex h-3.5 w-7 shrink-0 items-center justify-center rounded-[3px] border border-white/[0.06] bg-white/[0.02] font-mono text-[length:calc(var(--chat-font-size)*8/14)] font-bold tracking-wider text-fg/40">
                  {fileExtBadge(file.path)}
                </span>
                {onOpenPath ? (
                  <button
                    type="button"
                    onClick={() => onOpenPath(file.path)}
                    title={file.path}
                    className="relative min-w-0 flex-1 truncate text-left font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-fg/65 underline decoration-transparent underline-offset-2 transition-colors hover:text-accent hover:decoration-accent/50"
                  >
                    {display}
                  </button>
                ) : (
                  <span
                    title={file.path}
                    className="pointer-events-none min-w-0 flex-1 truncate font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-fg/65"
                  >
                    {display}
                  </span>
                )}
                {file.kind !== "modify" ? (
                  <span className="shrink-0 font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-fg/40">
                    {formatFileAction(file.kind)}
                  </span>
                ) : null}
                {file.additions > 0 ? (
                  <span className="shrink-0 font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-emerald-400/80">
                    +{file.additions}
                  </span>
                ) : null}
                {file.deletions > 0 ? (
                  <span className="shrink-0 font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-red-400/80">
                    −{file.deletions}
                  </span>
                ) : null}
              </div>
              {expanded && hasDiff ? <DiffBody diff={file.diff} /> : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
});

function LocalhostServersStrip({
  entries,
  sessionId,
  onInsertDraft,
  onRevealChatTerminal,
}: {
  entries: ChatWorkLogEntry[];
  sessionId?: string | null;
  onInsertDraft?: (text: string) => void;
  onRevealChatTerminal?: (terminal: { terminalId: string; ptyId: string; label: string }) => void;
}) {
  const detectedUrls = useMemo(() => collectLocalhostUrls(entries), [entries]);
  const urls = useLiveLocalhostUrls(detectedUrls);
  const [busy, setBusy] = useState(false);
  if (urls.length === 0) return null;

  const primary = urls[0]!;
  const extraCount = Math.max(0, urls.length - 1);
  const command = commandForLocalhostUrl(entries, primary);
  const openTitle = extraCount > 0
    ? `Open ${primary.href} in ADE browser (${extraCount} more detected)`
    : `Open ${primary.href} in ADE browser`;
  const logsTitle = "Open the active chat terminal for logs. If there is no terminal yet, draft a request for the agent to run this server there.";

  async function handleTerminalClick() {
    if (busy) return;
    setBusy(true);
    try {
      let terminal: Awaited<ReturnType<NonNullable<NonNullable<typeof window.ade>["terminal"]>["activeForChat"]>> | undefined;
      if (sessionId && onRevealChatTerminal) {
        try {
          terminal = await window.ade?.terminal?.activeForChat?.({ chatSessionId: sessionId });
        } catch (error) {
          console.error("[ChatWorkLogBlock] activeForChat lookup failed", error);
          terminal = undefined;
        }
        if (terminal?.ptyId) {
          onRevealChatTerminal({
            terminalId: terminal.terminalId,
            ptyId: terminal.ptyId,
            label: terminal.title || "Terminal",
          });
          return;
        }
      }
      const prompt = terminalizePrompt({ url: primary, command, sessionId });
      if (onInsertDraft) {
        onInsertDraft(prompt);
      } else {
        window.dispatchEvent(new CustomEvent("ade:agent-chat:insert-draft", {
          detail: { text: prompt },
        }));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-1.5 flex max-w-full flex-wrap items-center gap-1.5 font-sans text-[length:calc(var(--chat-font-size)*10/14)]">
      <button
        type="button"
        onClick={() => openUrlInAdeBrowser(primary.href)}
        title={openTitle}
        aria-label={openTitle}
        className="group inline-flex max-w-full items-center gap-1.5 rounded-full border border-sky-300/15 bg-sky-400/[0.06] py-0.5 pr-1.5 pl-2 text-sky-100/80 transition-colors hover:border-sky-300/30 hover:bg-sky-400/[0.11] hover:text-sky-50"
      >
        <span className="relative inline-flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full rounded-full bg-sky-300/45 ade-thinking-pulse" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-300/80" />
        </span>
        <Globe size={11} weight="bold" className="shrink-0" aria-hidden />
        <span className="min-w-0 truncate font-mono">{localhostUrlLabel(primary)}</span>
        {extraCount > 0 ? (
          <span className="shrink-0 text-sky-100/45">+{extraCount}</span>
        ) : null}
        <span className="rounded-full bg-sky-200/[0.10] px-1.5 py-px font-sans text-[length:calc(var(--chat-font-size)*9/14)] font-semibold text-sky-100/60 transition-colors group-hover:text-sky-50/85">
          Browser
        </span>
        <ArrowSquareOut size={11} weight="bold" className="shrink-0 text-sky-100/45 transition-colors group-hover:text-sky-50/80" aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => {
          handleTerminalClick().catch((error) => {
            console.error("[ChatWorkLogBlock] handleTerminalClick failed", error);
          });
        }}
        disabled={busy}
        title={logsTitle}
        aria-label="Open terminal logs or ask the agent to run this server in the chat terminal"
        className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full border border-white/[0.07] bg-white/[0.03] px-2 text-fg/45 transition-colors hover:border-white/[0.13] hover:bg-white/[0.06] hover:text-fg/75 disabled:cursor-progress disabled:opacity-50"
      >
        <Terminal size={12} weight="bold" aria-hidden />
        <span className="font-sans text-[length:calc(var(--chat-font-size)*9/14)] font-semibold">Logs</span>
      </button>
    </div>
  );
}

export function ChatWorkLogBlock({
  entries,
  summary: _summary,
  className,
  onNavigateSuggestion,
  onUndoChanges,
  onInsertDraft,
  onRevealChatTerminal,
  sessionId,
  animate: _animate = true,
}: {
  entries: ChatWorkLogEntry[];
  summary?: ChatWorkLogGroupEvent["summary"];
  className?: string;
  onNavigateSuggestion?: (suggestion: OperatorNavigationSuggestion) => void;
  onUndoChanges?: () => void;
  onInsertDraft?: (text: string) => void;
  onRevealChatTerminal?: (terminal: { terminalId: string; ptyId: string; label: string }) => void;
  sessionId?: string | null;
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
    <div className={cn("min-w-0 max-w-full space-y-3 overflow-hidden", className)}>
      <LocalhostServersStrip
        entries={entries}
        sessionId={sessionId}
        onInsertDraft={onInsertDraft}
        onRevealChatTerminal={onRevealChatTerminal}
      />
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

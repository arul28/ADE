import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useLocation, useNavigate } from "react-router-dom";
import {
  CaretDown,
  CaretRight,
  Warning,
  Terminal,
  FileCode,
  Check,
  CheckCircle,
  XCircle,
  Circle,
  Checks,
  ListChecks,
  User,
  Robot,
  Note,
  ChatCircleText,
  Info,
  Lightning,
  MagnifyingGlass,
  Globe,
  ShieldCheck,
  CopySimple,
} from "@phosphor-icons/react";
import type {
  AgentChatApprovalDecision,
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatNoticeDetail,
  ChatSurfaceChipTone,
  FilesWorkspace,
  ChatSurfaceProfile,
  ChatSurfaceMode,
  OperatorNavigationSuggestion,
} from "../../../shared/types";
import { getModelById, resolveModelDescriptor } from "../../../shared/modelRegistry";
import { cn } from "../ui/cn";
import { formatTime } from "../../lib/format";
import { describeToolIdentifier, replaceInternalToolNames } from "./toolPresentation";
import { chatChipToneClass } from "./chatSurfaceTheme";
import { ChatAttachmentTray } from "./ChatAttachmentTray";
import { getToolMeta } from "./chatToolAppearance";
import { ClaudeLogo, CodexLogo, CursorAgentLogo } from "../terminals/ToolLogos";
import type { ChatSubagentSnapshot } from "./chatExecutionSummary";
import { ChatWorkLogBlock } from "./ChatWorkLogBlock";
import { ChatStatusGlyph } from "./chatStatusVisuals";
import {
  collapseChatTranscriptEventsIncremental,
  formatStructuredValue,
  groupConsecutiveWorkLogRows,
  readRecord,
  summarizeDiffStats,
  summarizeInlineText,
  type ChatTranscriptGroupedEnvelope as TranscriptGroupedEnvelope,
  type ChatTranscriptRenderEnvelope as TranscriptRenderEnvelope,
} from "./chatTranscriptRows";

const NAVIGATION_SURFACES = new Set(["work", "missions", "lanes", "cto"]);

function readOperatorNavigationSuggestion(value: unknown): OperatorNavigationSuggestion | null {
  const record = readRecord(value);
  if (!record) return null;
  const surface = typeof record.surface === "string" ? record.surface : "";
  const href = typeof record.href === "string" ? record.href : "";
  const label = typeof record.label === "string" ? record.label : "";
  if (!NAVIGATION_SURFACES.has(surface) || !href.trim() || !label.trim()) return null;
  const result: OperatorNavigationSuggestion = { surface: surface as OperatorNavigationSuggestion["surface"], href, label };
  if (typeof record.laneId === "string") result.laneId = record.laneId;
  if (typeof record.sessionId === "string") result.sessionId = record.sessionId;
  if (typeof record.missionId === "string") result.missionId = record.missionId;
  return result;
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
  if (suggestions.length > 0) return suggestions;
  const fallback = readOperatorNavigationSuggestion(record.navigation);
  return fallback ? [fallback] : [];
}

function summarizeStructuredValue(value: unknown, maxChars = 160): string {
  const text = formatStructuredValue(value).replace(/\s+/g, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function getEventTurnId(event: AgentChatEvent): string | null {
  if (!("turnId" in event) || typeof event.turnId !== "string") return null;
  const turnId = event.turnId.trim();
  return turnId.length ? turnId : null;
}

function basenamePathLabel(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const basename = normalized.split("/").pop()?.trim();
  return basename?.length ? basename : normalized;
}

function dirnamePathLabel(value: string): string | null {
  const normalized = value.replace(/\\/g, "/");
  const basename = basenamePathLabel(normalized);
  if (basename === normalized) return null;
  const suffix = `/${basename}`;
  return normalized.endsWith(suffix) ? normalized.slice(0, -suffix.length) : null;
}

function formatFileAction(kind: Extract<AgentChatEvent, { type: "file_change" }>["kind"]): string {
  switch (kind) {
    case "create":
      return "Created";
    case "delete":
      return "Deleted";
    default:
      return "Edited";
  }
}

function hasNoticeDetail(detail: string | AgentChatNoticeDetail | undefined): boolean {
  if (detail == null) return false;
  if (typeof detail === "string") return detail.trim().length > 0;
  return Boolean(
    detail.title?.trim()
    || detail.summary?.trim()
    || detail.metrics?.length
    || detail.sections?.length,
  );
}

function renderNoticeDetail(detail: string | AgentChatNoticeDetail): React.ReactNode {
  if (typeof detail === "string") {
    return <div className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-fg/60">{detail}</div>;
  }

  return (
    <div className="space-y-3 text-[11px] leading-relaxed text-fg/60">
      {detail.title?.trim() ? <div className="font-medium text-fg/75">{detail.title.trim()}</div> : null}
      {detail.summary?.trim() ? <div className="whitespace-pre-wrap break-words">{detail.summary.trim()}</div> : null}
      {detail.metrics?.length ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {detail.metrics.map((metric) => (
            <div
              key={`${metric.label}:${metric.value}`}
              className="rounded-lg border border-border/12 bg-black/10 px-2.5 py-2"
            >
              <div className="text-[10px] uppercase tracking-[0.14em] text-muted-fg/55">{metric.label}</div>
              <div className={cn("mt-1 text-sm font-medium", metric.tone ? chatChipToneClass(metric.tone) : "text-fg/75")}>
                {metric.value}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {detail.sections?.map((section) => (
        <div key={section.title} className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-[0.14em] text-muted-fg/55">{section.title}</div>
          <div className="space-y-1.5">
            {section.items.map((item, index) => (
              typeof item === "string" ? (
                <div
                  key={`${section.title}:text:${index}`}
                  className="whitespace-pre-wrap break-words rounded-lg border border-border/12 bg-black/10 px-2.5 py-2"
                >
                  {item}
                </div>
              ) : (
                <div
                  key={`${section.title}:${item.label}:${item.value}:${index}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/12 bg-black/10 px-2.5 py-2"
                >
                  <span className="text-muted-fg/60">{item.label}</span>
                  <span className={cn("text-right font-medium", item.tone ? chatChipToneClass(item.tone) : "text-fg/75")}>
                    {item.value}
                  </span>
                </div>
              )
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function formatTokenCount(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function renderSubagentUsage(usage: {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
} | undefined): React.ReactNode {
  if (!usage) return null;
  return (
    <div className="flex flex-wrap gap-3 border-t border-violet-500/8 pt-2.5 font-mono text-[10px] text-muted-fg/45">
      {usage.totalTokens != null ? (
        <span>{formatTokenCount(usage.totalTokens)} tokens</span>
      ) : null}
      {usage.toolUses != null ? (
        <span>{usage.toolUses} tool use{usage.toolUses === 1 ? "" : "s"}</span>
      ) : null}
      {usage.durationMs != null ? (
        <span>{(usage.durationMs / 1000).toFixed(1)}s</span>
      ) : null}
    </div>
  );
}

const GLASS_CARD_CLASS =
  "overflow-hidden rounded-[14px] border border-white/[0.08] bg-[#121216]";

const WORK_LOG_CARD_CLASS =
  "border border-white/[0.06] bg-[#111317]/70";

const RECESSED_BLOCK_CLASS =
  "overflow-auto whitespace-pre-wrap break-words rounded-[10px] border border-white/[0.05] bg-[#09090b] px-4 py-3 font-mono text-[11px] leading-[1.6] text-fg/76";

function toolSourceChip(toolName: string): { label: string; tone: ChatSurfaceChipTone } | null {
  if (toolName.startsWith("mcp__")) {
    const [, namespace] = toolName.split("__");
    const label = namespace ? `${namespace.replace(/[_-]/g, " ")} MCP` : "MCP";
    return { label, tone: "info" };
  }
  if (toolName.startsWith("functions.")) {
    return { label: "Local tool", tone: "muted" };
  }
  if (toolName.startsWith("multi_tool_use.")) {
    return { label: "Parallel", tone: "accent" };
  }
  if (toolName.includes(".")) {
    const namespace = toolName.split(".")[0]?.trim();
    if (namespace) return { label: namespace.replace(/[_-]/g, " "), tone: "muted" };
  }
  return null;
}

const MESSAGE_CARD_STYLE: React.CSSProperties = {
  borderColor: "rgba(245, 158, 11, 0.16)",
  background: "#171412",
};

const SURFACE_INLINE_CARD_STYLE: React.CSSProperties = {
  borderColor: "rgba(255, 255, 255, 0.08)",
  background: "#14161a",
};

const ASSISTANT_MESSAGE_CARD_STYLE: React.CSSProperties = {
  borderColor: "rgba(148, 163, 184, 0.14)",
  background: "#101318",
};

function describeUserDeliveryState(event: Extract<AgentChatEvent, { type: "user_message" }>): { label: string; className: string } | null {
  if (event.deliveryState === "failed") {
    return {
      label: "failed",
      className: "border-red-500/18 bg-red-500/[0.08] text-red-300",
    };
  }
  if (event.deliveryState === "queued") {
    return {
      label: "queued",
      className: "border-amber-500/18 bg-amber-500/[0.08] text-amber-300",
    };
  }
  if (event.processed) {
    return {
      label: "processed",
      className: "border-emerald-500/18 bg-emerald-500/[0.08] text-emerald-300",
    };
  }
  if (event.deliveryState === "delivered") {
    return {
      label: "sent",
      className: "border-sky-500/18 bg-sky-500/[0.08] text-sky-300",
    };
  }
  return null;
}

type RenderEnvelope = {
  key: string;
  timestamp: string;
  event: AgentChatEvent | {
    type: "tool_invocation";
    tool: string;
    args: unknown;
    itemId: string;
    parentItemId?: string;
    turnId?: string;
    result?: unknown;
    status: "running" | "completed" | "failed";
  };
};

function MessageCopyButton({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(value)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_500);
      })
      .catch(() => {
        setCopied(false);
      });
  }, [value]);

  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 font-sans text-[9px] text-fg/45 transition-all hover:border-white/[0.14] hover:bg-white/[0.05] hover:text-fg/72",
        className,
      )}
      onClick={handleCopy}
      title={copied ? "Copied" : "Copy message"}
      aria-label={copied ? "Copied" : "Copy message"}
    >
      {copied ? <Checks size={10} weight="bold" /> : <CopySimple size={10} weight="regular" />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

/* ── Status indicators ── */

function StatusIcon({ status }: { status: "running" | "completed" | "failed" }) {
  if (status === "completed" || status === "failed") return <ChatStatusGlyph status={status} size={13} />;
  return <ChatStatusGlyph status="working" size={13} />;
}

function PlanStepIcon({ status }: { status: string }) {
  if (status === "completed") return <Checks size={13} weight="bold" className="text-emerald-400" />;
  if (status === "failed") return <XCircle size={13} weight="bold" className="text-red-400" />;
  if (status === "in_progress") return <Circle size={11} weight="fill" className="text-sky-400/80" />;
  return <Circle size={11} weight="regular" className="text-muted-fg/40" />;
}

function todoItemStatusClass(status: string): string {
  switch (status) {
    case "completed":
      return "border-emerald-400/18 bg-emerald-500/[0.08] text-emerald-300/80";
    case "in_progress":
      return "border-sky-400/18 bg-sky-500/[0.08] text-sky-300/80";
    default:
      return "border-amber-400/18 bg-amber-500/[0.08] text-amber-300/80";
  }
}

function statusColorClass(status: string | undefined): string {
  switch (status) {
    case "failed":
      return "text-red-400/70";
    case "running":
      return "text-amber-400/70";
    default:
      return "text-emerald-400/70";
  }
}

function isExternalHref(href: string): boolean {
  return /^(?:[a-z]+:)?\/\//i.test(href) || /^mailto:/i.test(href) || /^tel:/i.test(href);
}

function normalizeWorkspacePathCandidate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.length) return null;
  if (/^(?:https?|mailto|tel):/i.test(trimmed)) return null;
  if (/^#/.test(trimmed)) return null;
  const withoutScheme = trimmed.replace(/^file:\/\//i, "");
  const withoutQuery = withoutScheme.split(/[?#]/, 1)[0]?.trim().replace(/\\/g, "/") ?? "";
  if (!withoutQuery.length) return null;
  // Normalize Windows drive-letter paths: /C:/... → C:/...
  if (/^\/[A-Za-z]:\//.test(withoutQuery)) return withoutQuery.slice(1);
  return withoutQuery;
}

function looksLikeWorkspacePath(value: string): boolean {
  const candidate = normalizeWorkspacePathCandidate(value);
  if (!candidate) return false;
  if (candidate.startsWith("./")) {
    return true;
  }
  // Reject directory-traversal and home-relative paths
  if (candidate.startsWith("../") || candidate.startsWith("~/")) {
    return false;
  }
  if (candidate.startsWith("/")) {
    return candidate.slice(1).includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(candidate);
  }
  return candidate.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(candidate);
}

function resolveWorkspacePathFromHref(href: string | undefined): string | null {
  if (!href) return null;
  const candidate = normalizeWorkspacePathCandidate(href);
  if (!candidate) return null;
  if (isExternalHref(candidate)) return null;
  return looksLikeWorkspacePath(candidate) ? candidate : null;
}

function InlineDisclosureRow({
  summary,
  children,
  defaultOpen = false,
  className,
}: {
  summary: React.ReactNode;
  children?: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const prevDefaultOpen = useRef(defaultOpen);
  const expandable = Boolean(children);

  useEffect(() => {
    if (!prevDefaultOpen.current && defaultOpen) {
      setOpen(true);
    }
    prevDefaultOpen.current = defaultOpen;
  }, [defaultOpen]);

  return (
    <div className={cn("rounded-lg", className)}>
      <button
        type="button"
        aria-expanded={expandable ? open : undefined}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-white/[0.03]",
          !expandable && "cursor-default hover:bg-transparent",
        )}
        onClick={() => {
          if (expandable) setOpen((value) => !value);
        }}
      >
        {expandable ? (
          open ? <CaretDown size={10} weight="bold" className="text-fg/28" /> : <CaretRight size={10} weight="bold" className="text-fg/28" />
        ) : (
          <span className="ml-[2px] inline-flex h-1.5 w-1.5 rounded-full bg-white/12" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">{summary}</div>
      </button>
      {expandable && open ? (
        <div className="ml-5 mt-1 space-y-2 border-l border-white/[0.05] pl-3">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function normalizeFileSystemPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function trimTrailingSlashes(value: string): string {
  if (value === "/") return value;
  return value.replace(/\/+$/, "");
}

function resolveFilesNavigationTarget(args: {
  path: string;
  workspaces: FilesWorkspace[];
  fallbackLaneId: string | null;
}): { openFilePath: string; laneId: string | null } | null {
  const candidate = normalizeWorkspacePathCandidate(args.path);
  if (!candidate) return null;

  const normalizedCandidate = normalizeFileSystemPath(candidate);
  if (normalizedCandidate.startsWith("/")) {
    const matches = args.workspaces
      .map((workspace) => ({
        workspace,
        rootPath: trimTrailingSlashes(normalizeFileSystemPath(workspace.rootPath)),
      }))
      .filter(({ rootPath }) =>
        normalizedCandidate === rootPath || normalizedCandidate.startsWith(`${rootPath}/`),
      )
      .sort((left, right) => {
        const rightMatchesLane = right.workspace.laneId != null && right.workspace.laneId === args.fallbackLaneId ? 1 : 0;
        const leftMatchesLane = left.workspace.laneId != null && left.workspace.laneId === args.fallbackLaneId ? 1 : 0;
        if (rightMatchesLane !== leftMatchesLane) return rightMatchesLane - leftMatchesLane;
        return right.rootPath.length - left.rootPath.length;
      });

    const match = matches[0];
    if (!match) return null;
    const openFilePath = normalizedCandidate.slice(match.rootPath.length).replace(/^\/+/, "");
    if (!openFilePath.length) return null;
    return {
      openFilePath,
      laneId: match.workspace.laneId ?? args.fallbackLaneId ?? null,
    };
  }

  const openFilePath = normalizedCandidate.replace(/^\.\//, "");
  if (!openFilePath.length) return null;
  return {
    openFilePath,
    laneId: args.fallbackLaneId ?? null,
  };
}

/* ── Markdown renderer ── */

const MarkdownBlock = React.memo(function MarkdownBlock({
  markdown,
  onOpenWorkspacePath,
  workspaceLaneId,
}: {
  markdown: string;
  onOpenWorkspacePath?: (path: string, laneId?: string | null) => void;
  workspaceLaneId?: string | null;
}) {
  const openWorkspacePath = useCallback((path: string) => {
    onOpenWorkspacePath?.(path, workspaceLaneId ?? null);
  }, [onOpenWorkspacePath, workspaceLaneId]);

  return (
    <div className="prose prose-invert max-w-none text-[13px] leading-[1.78] text-fg/92 prose-headings:mb-3 prose-headings:mt-6 prose-headings:font-sans prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-fg prose-p:my-3 prose-ul:my-3 prose-ul:pl-5 prose-ol:my-3 prose-ol:pl-5 prose-li:my-1.5 prose-li:pl-1 prose-strong:text-fg prose-blockquote:border-l-2 prose-blockquote:border-l-white/20 prose-blockquote:pl-4 prose-blockquote:text-fg/78 prose-hr:my-5 prose-hr:border-white/[0.08] prose-table:my-4 prose-th:border-white/[0.08] prose-th:bg-white/[0.03] prose-th:px-3 prose-th:py-2 prose-td:border-white/[0.06] prose-td:px-3 prose-td:py-2">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="text-[1rem]">{children}</h1>,
          h2: ({ children }) => <h2 className="text-[0.95rem]">{children}</h2>,
          h3: ({ children }) => <h3 className="text-[0.9rem]">{children}</h3>,
          ul: ({ children }) => <ul className="my-3 list-disc space-y-1.5 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-3 list-decimal space-y-1.5 pl-5">{children}</ol>,
          li: ({ children }) => <li className="pl-1 text-fg/88">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-white/20 pl-4 italic text-fg/72">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[12px]">{children}</table>
            </div>
          ),
          pre: ({ children }) => (
            <pre className={cn("my-3 max-h-80", RECESSED_BLOCK_CLASS)}>
              {children}
            </pre>
          ),
          code: ({ className, children }) => {
            const text = String(children ?? "");
            const isBlock = /\n/.test(text) || (typeof className === "string" && className.length > 0);
            const workspacePath = !isBlock ? normalizeWorkspacePathCandidate(text) : null;
            const pathIsClickable = Boolean(workspacePath && looksLikeWorkspacePath(workspacePath));
            return isBlock ? (
              <code className="font-mono text-[11px] text-fg/82">{children}</code>
            ) : pathIsClickable ? (
              <span
                role="button"
                tabIndex={0}
                className="inline-flex cursor-pointer items-center rounded-md border border-sky-400/16 bg-sky-500/[0.08] px-1.5 py-0.5 font-mono text-[11px] text-sky-200 underline decoration-sky-300/30 underline-offset-2 transition-colors hover:border-sky-400/24 hover:bg-sky-500/[0.12] hover:text-sky-100"
                onClick={() => openWorkspacePath(workspacePath!)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openWorkspacePath(workspacePath!); } }}
                title="Open file in Files"
              >
                {children}
              </span>
            ) : (
              <code className="rounded-md border border-white/[0.08] bg-black/30 px-1.5 py-0.5 font-mono text-[11px] text-fg/90">{children}</code>
            );
          },
          a: ({ children, href }) => {
            const workspacePath = resolveWorkspacePathFromHref(href);
            if (workspacePath) {
              return (
                <button
                  type="button"
                  className="inline-flex items-center rounded-sm border border-sky-400/12 bg-sky-500/[0.06] px-1.5 py-0.5 font-sans text-[12px] text-sky-200 underline decoration-sky-300/30 underline-offset-2 transition-colors hover:border-sky-400/22 hover:bg-sky-500/[0.1] hover:text-sky-100"
                  onClick={() => openWorkspacePath(workspacePath)}
                  title="Open file in Files"
                >
                  {children}
                </button>
              );
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="text-accent underline decoration-accent/30 underline-offset-2 transition-colors hover:text-accent/80 hover:decoration-accent/50"
              >
                {children}
              </a>
            );
          }
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
});

/* ── Collapsible card ── */

function CollapsibleCard({
  children,
  defaultOpen = false,
  forceOpen,
  summary,
  className
}: {
  children: React.ReactNode;
  defaultOpen?: boolean;
  /** When set, overrides the open state. When it transitions from true→undefined, auto-collapses. */
  forceOpen?: boolean;
  summary: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Track whether the user explicitly collapsed while forceOpen is active
  const [userCollapsed, setUserCollapsed] = useState(false);
  const prevForceOpen = useRef(forceOpen);

  useEffect(() => {
    // Auto-collapse when forceOpen transitions from true → falsy (turn finished)
    if (prevForceOpen.current === true && !forceOpen) {
      setOpen(false);
      setUserCollapsed(false);
    }
    // Reset user override when forceOpen activates (new turn)
    if (!prevForceOpen.current && forceOpen) {
      setUserCollapsed(false);
    }
    prevForceOpen.current = forceOpen;
  }, [forceOpen]);

  const isOpen = forceOpen === true ? !userCollapsed : open;

  return (
    <div className={cn(GLASS_CARD_CLASS, "transition-colors", className)} style={SURFACE_INLINE_CARD_STYLE}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3.5 py-3 text-left font-mono text-[11px]"
        onClick={() => {
          if (forceOpen === true) {
            setUserCollapsed((v) => !v);
          } else {
            setOpen((v) => !v);
          }
        }}
      >
        {isOpen ? <CaretDown size={10} weight="bold" className="text-muted-fg/60" /> : <CaretRight size={10} weight="bold" className="text-muted-fg/60" />}
        <div className="flex flex-1 flex-wrap items-center gap-2">{summary}</div>
      </button>
      {isOpen ? <div className="border-t border-white/[0.04] px-3.5 pb-3.5 pt-2.5">{children}</div> : null}
    </div>
  );
}

/* ── Diff preview ── */

function DiffPreview({ diff }: { diff: string }) {
  const lines = diff.split(/\r?\n/);
  return (
    <pre className={cn("max-h-80", RECESSED_BLOCK_CLASS)}>
      {lines.map((line, index) => {
        let tone = "text-fg/70";
        let bg = "";
        if (line.startsWith("+")) {
          tone = "text-emerald-400/90";
          bg = "bg-emerald-500/[0.06]";
        } else if (line.startsWith("-")) {
          tone = "text-red-400/90";
          bg = "bg-rose-500/[0.06]";
        } else if (line.startsWith("@@")) {
          tone = "text-accent/60";
        }
        return (
          <div key={`${index}:${line}`} className={cn(tone, bg, "px-1 -mx-1")}>
            {line}
          </div>
        );
      })}
    </pre>
  );
}

/* ── Activity indicator ── */

const ACTIVITY_LABELS: Record<string, string> = {
  thinking: "Thinking",
  working: "Working",
  editing_file: "Editing",
  running_command: "Running command",
  searching: "Searching",
  reading: "Reading",
  tool_calling: "Calling tool"
};

function ThinkingDots({ toneClass = "bg-emerald-300/70" }: { toneClass?: string }) {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className={cn("ade-thinking-pulse inline-block h-1.5 w-1.5 rounded-full", toneClass)}
          style={{ animationDelay: `${index * 0.16}s` }}
        />
      ))}
    </span>
  );
}


function ActivityIndicator({ activity, detail }: { activity: string; detail?: string; animate?: boolean }) {
  const label = ACTIVITY_LABELS[activity] ?? activity;
  const displayText = detail ? `${label}: ${replaceInternalToolNames(detail)}` : `${label}...`;

  return (
    <div className="flex items-center gap-2 py-1 font-mono text-[12px] text-emerald-200/75">
      <ThinkingDots toneClass="bg-emerald-300/75" />
      <span className="truncate">{displayText}</span>
    </div>
  );
}

/* ── Tool result card ── */

const TOOL_RESULT_TRUNCATE_LIMIT = 500;

function ToolResultCard({ event }: { event: Extract<AgentChatEvent, { type: "tool_result" }> }) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const meta = getToolMeta(event.tool);
  const ToolIcon = meta.icon;
  const toolDisplay = describeToolIdentifier(event.tool);
  const sourceChip = toolSourceChip(event.tool);
  const navigationSuggestions = readNavigationSuggestions(event.result);
  const resultStr = formatStructuredValue(event.result);
  const isTruncated = resultStr.length > TOOL_RESULT_TRUNCATE_LIMIT;
  const displayStr = !expanded && isTruncated ? `${resultStr.slice(0, TOOL_RESULT_TRUNCATE_LIMIT)}...` : resultStr;
  const preview = summarizeStructuredValue(event.result, 180);

  return (
    <CollapsibleCard
      summary={
        <div className="flex items-center gap-2 font-mono text-[11px]">
          <StatusIcon status={event.status ?? "completed"} />
          <span className={cn("inline-flex items-center gap-1 border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider", meta.badgeCls)}>
            <ToolIcon size={11} weight="bold" />
            {meta.label}
          </span>
          {sourceChip ? (
            <span className={cn("inline-flex items-center border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.16em]", chatChipToneClass(sourceChip.tone))}>
              {sourceChip.label}
            </span>
          ) : null}
          {toolDisplay.secondaryLabel ? (
            <span className="font-bold text-fg/75">{toolDisplay.secondaryLabel}</span>
          ) : null}
          {preview.length ? <span className="max-w-[360px] truncate text-[10px] text-fg/40">{preview}</span> : null}
          {event.status ? (
            <span className={cn("text-[10px] uppercase tracking-wider", statusColorClass(event.status))}>
              {event.status}
            </span>
          ) : null}
        </div>
      }
      defaultOpen={navigationSuggestions.length > 0}
      className="border-transparent"
    >
      {navigationSuggestions.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {navigationSuggestions.map((suggestion) => (
            <button
              key={`${suggestion.surface}:${suggestion.href}`}
              type="button"
              className="rounded-[8px] border border-accent/20 bg-accent/[0.08] px-2.5 py-1 font-mono text-[10px] font-semibold text-accent/85 transition-colors hover:bg-accent/[0.14] hover:text-accent"
              onClick={() => navigate(suggestion.href)}
            >
              {suggestion.label}
            </button>
          ))}
        </div>
      ) : null}
      <pre className={cn("max-h-52", RECESSED_BLOCK_CLASS)}>
        {displayStr}
      </pre>
      {isTruncated ? (
        <button
          type="button"
          className="mt-1.5 font-mono text-[10px] text-accent/60 hover:text-accent"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "collapse" : `show all (${resultStr.length} chars)`}
        </button>
      ) : null}
    </CollapsibleCard>
  );
}

/* ── Main event renderer ── */

function resolveModelLabel(modelId?: string, model?: string): string | null {
  if (modelId) {
    const desc = getModelById(modelId);
    if (desc) {
      // When the runtime-reported model name differs from all known canonical
      // identifiers, show it in the parenthetical so the user sees the exact
      // model string the provider returned (e.g. a snapshot variant).
      const normalizedModel = model?.trim().toLowerCase() ?? "";
      const isNonCanonicalModel = normalizedModel.length > 0
        && normalizedModel !== desc.id.toLowerCase()
        && normalizedModel !== desc.shortId.toLowerCase()
        && normalizedModel !== desc.sdkModelId.toLowerCase();
      if (isNonCanonicalModel) {
        return `${desc.displayName} (${model?.trim()})`;
      }
      return `${desc.displayName} (${modelId})`;
    }
    return modelId;
  }
  if (model) {
    const desc = resolveModelDescriptor(model);
    if (desc) return `${desc.displayName} (${desc.id})`;
    return model;
  }
  return null;
}

function resolveModelMeta(modelId?: string, model?: string): { label: string | null; family: string | null; cliCommand: string | null } {
  const key = modelId ?? model;
  const descriptor = key ? (getModelById(key) ?? resolveModelDescriptor(key)) : undefined;
  const idHint = String(modelId ?? model ?? "").trim();
  const inferredCursor = !descriptor && idHint.startsWith("cursor/");
  return {
    label: resolveModelLabel(modelId, model),
    family: descriptor?.family ?? (inferredCursor ? "cursor" : null),
    cliCommand: descriptor?.cliCommand ?? (inferredCursor ? "cursor" : null),
  };
}

type TurnModelDescriptor = { label: string; modelId?: string; model?: string };

type DerivedTurnModelState = {
  map: Map<string, TurnModelDescriptor>;
  lastModel: TurnModelDescriptor | null;
  processedLength: number;
  lastProcessedEnvelope: AgentChatEventEnvelope | null;
};

export function deriveTurnModelState(
  events: AgentChatEventEnvelope[],
  previous: DerivedTurnModelState | null = null,
): DerivedTurnModelState {
  const canIncrementallyAppend =
    !!previous
    && previous.processedLength <= events.length
    && (
      previous.processedLength === 0
      || previous.lastProcessedEnvelope === events[previous.processedLength - 1]
    );

  const map = canIncrementallyAppend && previous
    ? new Map(previous.map)
    : new Map<string, TurnModelDescriptor>();
  let lastModel = canIncrementallyAppend ? (previous?.lastModel ?? null) : null;
  const startIndex = canIncrementallyAppend && previous ? previous.processedLength : 0;

  for (let index = startIndex; index < events.length; index += 1) {
    const evt = events[index]?.event;
    if (!evt || evt.type !== "done") continue;
    const modelLabel = resolveModelLabel(evt.modelId, evt.model);
    if (!evt.turnId || !modelLabel) continue;
    const model = {
      label: modelLabel,
      ...(evt.modelId ? { modelId: evt.modelId } : {}),
      ...(evt.model ? { model: evt.model } : {}),
    };
    map.set(evt.turnId, model);
    lastModel = model;
  }

  return {
    map,
    lastModel,
    processedLength: events.length,
    lastProcessedEnvelope: events.length > 0 ? events[events.length - 1]! : null,
  };
}

function ModelGlyph({
  modelId,
  model,
  size = 12,
  className,
}: {
  modelId?: string;
  model?: string;
  size?: number;
  className?: string;
}) {
  const meta = resolveModelMeta(modelId, model);
  if (meta.family === "cursor" || meta.cliCommand === "cursor") {
    return <CursorAgentLogo size={size} className={className} />;
  }
  if (meta.family === "anthropic" || meta.cliCommand === "claude") {
    return <ClaudeLogo size={size} className={className} />;
  }
  if (meta.cliCommand === "codex") {
    return <CodexLogo size={size} className={className} />;
  }
  return <Robot size={size} weight="bold" className={className} />;
}

type AssistantPresentation = {
  label: string;
  glyph: React.ReactNode;
};

const KNOWN_PROVIDER_LABELS = new Set(["Claude", "Codex", "Cursor"]);
const GENERIC_ASSISTANT_LABELS = new Set(["Agent", "Assistant", ...KNOWN_PROVIDER_LABELS]);

function inferProviderLabel(meta: { family: string | null; cliCommand: string | null }): string | null {
  if (meta.family === "anthropic" || meta.cliCommand === "claude") return "Claude";
  if (meta.cliCommand === "codex") return "Codex";
  if (meta.family === "cursor" || meta.cliCommand === "cursor") return "Cursor";
  return null;
}

function providerGlyph(provider: string | null): React.ReactNode {
  switch (provider) {
    case "Claude": return <ClaudeLogo size={10} className="text-fg/70" />;
    case "Codex": return <CodexLogo size={10} className="text-fg/70" />;
    case "Cursor": return <CursorAgentLogo size={10} className="text-fg/70" />;
    default: return <Robot size={10} weight="bold" className="text-fg/70" />;
  }
}

function resolveAssistantPresentation({
  assistantLabel,
  turnModel,
}: {
  assistantLabel?: string;
  turnModel?: { label: string; modelId?: string; model?: string } | null;
}): AssistantPresentation {
  const customLabel = assistantLabel?.trim() ?? "";
  const modelMeta = turnModel ? resolveModelMeta(turnModel.modelId, turnModel.model) : { family: null, cliCommand: null };
  const resolvedProviderLabel = inferProviderLabel(modelMeta)
    ?? (KNOWN_PROVIDER_LABELS.has(customLabel) ? customLabel : null);
  const hardOverrideLabel =
    customLabel.length > 0 && !GENERIC_ASSISTANT_LABELS.has(customLabel)
      ? customLabel
      : null;
  const label = hardOverrideLabel ?? resolvedProviderLabel ?? "Assistant";
  return { label, glyph: providerGlyph(resolvedProviderLabel) };
}

function commandTimelineVerb(status: Extract<AgentChatEvent, { type: "command" }>["status"]): string {
  if (status === "failed") return "Command failed";
  if (status === "running") return "Running";
  return "Ran";
}

function CommandEventCard({
  event,
}: {
  event: Extract<AgentChatEvent, { type: "command" }>;
}) {
  const outputTrimmed = event.output.trim();
  const hasOutput = outputTrimmed.length > 0;
  const timelineVerb = commandTimelineVerb(event.status);
  const timelineSummary = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-fg/52">
      <span className="inline-flex h-3 w-3 items-center justify-center">
        <ChatStatusGlyph status={event.status === "running" ? "working" : event.status} size={11} />
      </span>
      <Terminal size={11} weight="regular" className="text-fg/34" />
      <span className="font-medium text-fg/62">{timelineVerb}</span>
      <span className="min-w-0 flex-1 truncate text-fg/76">{event.command}</span>
      {event.durationMs != null ? <span className="text-[10px] text-fg/28">{Math.max(0, event.durationMs)}ms</span> : null}
      {event.exitCode != null ? (
        <span className={cn("text-[10px]", event.exitCode === 0 ? "text-emerald-300/60" : "text-red-300/65")}>
          {event.exitCode === 0 ? "pass" : `exit ${event.exitCode}`}
        </span>
      ) : null}
    </div>
  );

  const commandBody = (
    <>
      <div className="rounded-lg border border-white/[0.06] bg-black/25 px-3.5 py-2.5 font-mono text-[11px] text-fg/80">
        <span className="select-none text-amber-500/40">$ </span>
        {event.command}
      </div>
      {hasOutput ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/[0.06] bg-black/25 px-3.5 py-2.5 font-mono text-[11px] leading-[1.5] text-fg/60">
          {event.output}
        </pre>
      ) : null}
    </>
  );

  return (
    <InlineDisclosureRow
      defaultOpen={event.status === "failed"}
      summary={timelineSummary}
      className={WORK_LOG_CARD_CLASS}
    >
      {commandBody}
    </InlineDisclosureRow>
  );
}

function FileChangeEventCard({
  event,
}: {
  event: Extract<AgentChatEvent, { type: "file_change" }>;
}) {
  const { additions, deletions } = summarizeDiffStats(event.diff);
  const hasDiff = event.diff.trim().length > 0;
  const basename = basenamePathLabel(event.path);
  const dirname = dirnamePathLabel(event.path);
  const summary = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-fg/52">
      <span className="inline-flex h-3 w-3 items-center justify-center">
        <ChatStatusGlyph status={event.status === "running" ? "working" : (event.status ?? "completed")} size={11} />
      </span>
      <FileCode size={11} weight="regular" className="text-fg/34" />
      <span className="font-medium text-fg/62">{formatFileAction(event.kind)}</span>
      <span className="truncate text-fg/78">{basename}</span>
      {additions > 0 ? <span className="text-emerald-300/70">+{additions}</span> : null}
      {deletions > 0 || event.kind === "delete" ? <span className="text-red-300/70">-{deletions}</span> : null}
      {dirname ? <span className="truncate text-[10px] text-fg/26">{dirname}</span> : null}
    </div>
  );

  return (
    <InlineDisclosureRow
      defaultOpen={event.status === "failed"}
      summary={summary}
      className={WORK_LOG_CARD_CLASS}
    >
      {hasDiff ? (
        <DiffPreview diff={event.diff} />
      ) : (
        <div className="font-mono text-[11px] text-muted-fg/40">No diff payload available.</div>
      )}
    </InlineDisclosureRow>
  );
}

function renderEvent(
  envelope: RenderEnvelope,
  options?: {
    onApproval?: (itemId: string, decision: AgentChatApprovalDecision, responseText?: string | null) => void;
    turnModel?: { label: string; modelId?: string; model?: string } | null;
    surfaceMode?: ChatSurfaceMode;
    surfaceProfile?: ChatSurfaceProfile;
    assistantLabel?: string;
    turnActive?: boolean;
    onOpenWorkspacePath?: (path: string) => void;
    respondingApprovalIds?: Set<string>;
    pendingApprovalIds?: Set<string>;
  }
) {
  const event = envelope.event;

  /* ── User message ── */
  if (event.type === "user_message") {
    const deliveryChip = describeUserDeliveryState(event);
    if (event.deliveryState === "queued" && !event.turnId) {
      return (
        <div className="flex justify-end">
          <div
            className={cn(GLASS_CARD_CLASS, "max-w-[88%] border-l-2 border-l-amber-400/40 px-4 py-3")}
            style={SURFACE_INLINE_CARD_STYLE}
          >
            <div className="mb-1.5 flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400/60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-400" />
              </span>
              <span className="font-sans text-[10px] font-medium text-amber-200/80">
                Queued — will be delivered after this turn
              </span>
              <span className="ml-auto font-sans text-[10px] text-fg/40">{formatTime(envelope.timestamp)}</span>
            </div>
            <div className="whitespace-pre-wrap break-words text-[12px] leading-[1.7] text-fg/80">{event.text}</div>
            {event.attachments?.length ? (
              <ChatAttachmentTray attachments={event.attachments} mode={options?.surfaceMode ?? "standard"} className="mt-1 px-0 py-0" />
            ) : null}
          </div>
        </div>
      );
    }
    return (
      <div className="flex justify-end">
        <div className={cn(GLASS_CARD_CLASS, "group max-w-[82%] px-4 py-3")} style={MESSAGE_CARD_STYLE}>
          <div className="mb-2 flex items-center gap-2">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-amber-300/20 bg-amber-400/[0.10]">
              <User size={10} weight="regular" className="text-amber-200/90" />
            </span>
            <span className="font-sans text-[11px] font-medium text-amber-100/92">You</span>
            {deliveryChip ? (
              <span className={cn("inline-flex items-center border px-1.5 py-0.5 font-sans text-[9px] font-medium", deliveryChip.className)}>
                {deliveryChip.label}
              </span>
            ) : null}
            <div className="ml-auto flex items-center gap-2">
              <MessageCopyButton value={event.text} className="opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100" />
              <span className="font-sans text-[10px] text-amber-100/55">{formatTime(envelope.timestamp)}</span>
            </div>
          </div>
          <div className="whitespace-pre-wrap break-words text-[13px] leading-[1.7] text-fg/96">{event.text}</div>
          {event.attachments?.length ? (
            <ChatAttachmentTray attachments={event.attachments} mode={options?.surfaceMode ?? "standard"} className="mt-1 px-0 py-0" />
          ) : null}
        </div>
      </div>
    );
  }

  /* ── Agent text ── */
  if (event.type === "text") {
    const assistant = resolveAssistantPresentation({
      assistantLabel: options?.assistantLabel,
      turnModel: options?.turnModel,
    });
    return (
      <div className="flex justify-start">
        <div
          className={cn(
            GLASS_CARD_CLASS,
            "group max-w-[94%] px-4 py-3",
            options?.turnActive && "min-h-[5.5rem]",
          )}
          style={ASSISTANT_MESSAGE_CARD_STYLE}
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="inline-flex h-4.5 w-4.5 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.03]">
              {assistant.glyph}
            </span>
            <span className="font-sans text-[10px] font-medium text-fg/72">{assistant.label}</span>
            {options?.turnModel?.label ? (
              <span className="inline-flex items-center rounded-full border border-white/[0.07] bg-white/[0.03] px-2 py-0.5 font-sans text-[9px] text-fg/44">
                {options.turnModel.label}
              </span>
            ) : null}
            <div className="ml-auto flex items-center gap-2">
              <MessageCopyButton value={event.text} className="opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100" />
            </div>
          </div>
          <div>
            <MarkdownBlock markdown={event.text} onOpenWorkspacePath={options?.onOpenWorkspacePath} />
          </div>
        </div>
      </div>
    );
  }

  /* ── Command ── */
  if (event.type === "command") {
    return <CommandEventCard event={event} />;
  }

  /* ── File change ── */
  if (event.type === "file_change") {
    return <FileChangeEventCard event={event} />;
  }

  /* ── Plan ── */
  if (event.type === "plan") {
    const completedCount = event.steps.filter((step) => step.status === "completed").length;
    return (
      <InlineDisclosureRow
        summary={
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-fg/52">
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-violet-400/80" />
            <ListChecks size={11} weight="regular" className="text-fg/34" />
            <span className="font-medium text-fg/62">Plan updated</span>
            <span className="text-fg/76">{completedCount}/{event.steps.length || 0} complete</span>
            {event.steps[0]?.text ? <span className="truncate text-[10px] text-fg/34">{summarizeInlineText(event.steps[0].text, 96)}</span> : null}
          </div>
        }
      >
        <div className="space-y-1.5">
          {event.steps.length ? (
            event.steps.map((step, index) => (
              <div key={`${step.text}:${index}`} className="flex items-start gap-2.5 px-1 py-1">
                <div className="mt-0.5 flex-shrink-0">
                  <PlanStepIcon status={step.status} />
                </div>
                <div className={cn(
                  "flex-1 text-[12px]",
                  step.status === "completed" ? "text-fg/45 line-through decoration-fg/15" : "text-fg/80"
                )}>
                  {step.text}
                </div>
              </div>
            ))
          ) : (
            <div className="font-mono text-[11px] text-muted-fg/40">No plan steps yet.</div>
          )}
        </div>
        {event.explanation ? (
          <div className="mt-2 border-t border-white/[0.05] pt-2 text-[11px] text-muted-fg/50">{event.explanation}</div>
        ) : null}
      </InlineDisclosureRow>
    );
  }

  /* ── TODO Update ── */
  if (event.type === "todo_update") {
    const completedCount = event.items.filter((item) => item.status === "completed").length;
    const totalCount = event.items.length;
    const activeItem = event.items.find((item) => item.status === "in_progress") ?? null;
    return (
      <InlineDisclosureRow
        defaultOpen={Boolean(activeItem)}
        summary={
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-fg/52">
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-cyan-400/80" />
            <ListChecks size={11} weight="regular" className="text-fg/34" />
            <span className="font-medium text-fg/62">Task list</span>
            <span className="text-fg/76">{completedCount}/{totalCount} complete</span>
            {activeItem?.description ? (
              <span className="truncate text-[10px] text-fg/34">
                {summarizeInlineText(activeItem.description, 96)}
              </span>
            ) : null}
          </div>
        }
      >
        <div className="space-y-1.5">
          {event.items.length ? (
            event.items.map((item) => (
              <div key={item.id} className="flex items-start gap-2.5 px-1 py-1">
                <div className="mt-0.5 flex-shrink-0">
                  {item.status === "completed" ? (
                    <Checks size={13} weight="bold" className="text-emerald-400" />
                  ) : item.status === "in_progress" ? (
                    <Circle size={11} weight="fill" className="text-sky-400/80" />
                  ) : (
                    <Circle size={11} weight="regular" className="text-amber-400/60" />
                  )}
                </div>
                <div className={cn(
                  "flex-1 text-[12px]",
                  item.status === "completed" ? "text-fg/45 line-through decoration-fg/15" : "text-fg/80"
                )}>
                  {item.description}
                </div>
                <span className={cn(
                  "inline-flex shrink-0 items-center border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.16em]",
                  todoItemStatusClass(item.status),
                )}>
                  {item.status.replace("_", " ")}
                </span>
              </div>
            ))
          ) : (
            <div className="font-mono text-[11px] text-muted-fg/40">No items yet.</div>
          )}
        </div>
      </InlineDisclosureRow>
    );
  }

  /* ── Web Search ── */
  if (event.type === "web_search") {
    const isRunning = event.status === "running";
    const isFailed = event.status === "failed";
    return (
      <div
        className={cn(
          "group relative overflow-hidden rounded-xl border p-0",
          isFailed
            ? "border-red-500/12 bg-gradient-to-br from-red-950/20 to-red-950/5"
            : "border-cyan-500/10 bg-gradient-to-br from-cyan-950/25 via-[#0a0e14] to-[#0d0d10]",
        )}
      >
        {/* Subtle top accent line */}
        <div className={cn(
          "h-px w-full",
          isFailed ? "bg-gradient-to-r from-transparent via-red-500/30 to-transparent"
            : "bg-gradient-to-r from-transparent via-cyan-400/25 to-transparent",
        )} />
        <div className="flex items-start gap-3 px-4 py-3.5">
          <div className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
            isFailed ? "bg-red-500/10" : "bg-cyan-500/10",
          )}>
            {isRunning ? (
              <ChatStatusGlyph status="working" size={15} />
            ) : isFailed ? (
              <XCircle size={15} weight="bold" className="text-red-400/80" />
            ) : (
              <Globe size={15} weight="bold" className="text-cyan-400/70" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={cn(
                "font-mono text-[9px] font-bold uppercase tracking-[0.18em]",
                isFailed ? "text-red-300/60" : "text-cyan-300/50",
              )}>
                Web Search
              </span>
              {event.action ? (
                <span className="font-mono text-[9px] text-fg/25">{event.action}</span>
              ) : null}
              {isRunning ? (
                <span className="font-mono text-[9px] text-cyan-400/40">searching...</span>
              ) : null}
            </div>
            <div className={cn(
              "mt-1.5 text-[13px] leading-relaxed",
              isFailed ? "text-red-200/70" : "text-fg/80",
            )}>
              <MagnifyingGlass size={12} weight="bold" className="mr-1.5 inline text-fg/30" />
              {event.query}
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ── Auto Approval Review (Guardian) ── */
  if (event.type === "auto_approval_review") {
    const isStarted = event.reviewStatus === "started";
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-indigo-500/10 bg-indigo-500/[0.04] px-3.5 py-2">
        {isStarted ? (
          <ChatStatusGlyph status="working" size={13} />
        ) : (
          <ShieldCheck size={13} weight="bold" className="text-indigo-400/60" />
        )}
        <span className="font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-indigo-300/55">
          {isStarted ? "Guardian reviewing" : "Guardian approved"}
        </span>
        {event.action ? (
          <span className="font-mono text-[9px] text-fg/30">{event.action}</span>
        ) : null}
        {event.review ? (
          <span className="flex-1 truncate text-[11px] text-fg/45">{event.review}</span>
        ) : null}
      </div>
    );
  }

  /* ── Plan Text (streaming plan delta) ── */
  if (event.type === "plan_text") {
    return (
      <div className="relative overflow-hidden rounded-xl border border-amber-500/8 bg-gradient-to-br from-amber-950/15 via-[#0d0d10] to-[#0d0d10]">
        <div className="h-px w-full bg-gradient-to-r from-transparent via-amber-400/20 to-transparent" />
        <div className="px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <ListChecks size={13} weight="bold" className="text-amber-400/50" />
            <span className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-amber-300/45">
              Plan
            </span>
          </div>
          <div className="prose prose-invert prose-sm max-w-none text-[12px] leading-relaxed text-fg/70">
            <MarkdownBlock markdown={event.text} onOpenWorkspacePath={options?.onOpenWorkspacePath} />
          </div>
        </div>
      </div>
    );
  }

  /* ── Subagent Started ── */
  if (event.type === "subagent_started") {
    return (
      <div className={cn("overflow-hidden rounded-xl border p-0", "border-violet-500/10 bg-gradient-to-br from-violet-950/20 via-[#0d0b14] to-[#0d0d10]")}>
        <div className="h-px w-full bg-gradient-to-r from-transparent via-violet-400/25 to-transparent" />
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/10">
            <ChatStatusGlyph status="working" size={14} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-violet-300/55">Agent</span>
              {event.background ? (
                <span className="rounded-md border border-violet-500/12 bg-violet-500/[0.06] px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-[0.16em] text-violet-300/50">background</span>
              ) : null}
            </div>
            <div className="mt-0.5 truncate text-[12px] text-fg/70">{event.description}</div>
          </div>
        </div>
      </div>
    );
  }

  /* ── Subagent Progress ── */
  if (event.type === "subagent_progress") {
    const summaryText = summarizeInlineText(event.summary, 140);
    return (
      <InlineDisclosureRow
        defaultOpen={false}
        summary={
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-fg/52">
            <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-violet-500/10">
              <ChatStatusGlyph status="working" size={11} />
            </div>
            <span className="font-medium text-fg/62">Agent running</span>
            {event.lastToolName?.trim() ? (
              <span className="rounded-md border border-violet-500/10 bg-violet-500/[0.05] px-1.5 py-0.5 text-[9px] text-violet-300/55">
                {replaceInternalToolNames(event.lastToolName.trim())}
              </span>
            ) : null}
            {summaryText ? <span className="flex-1 truncate text-[10px] text-fg/45">{summaryText}</span> : null}
          </div>
        }
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted-fg/45">
            {event.description?.trim() ? <span>{event.description.trim()}</span> : null}
          </div>
          <div className="text-[12px] leading-relaxed text-fg/70">
            {event.summary.trim() || "Waiting for the next progress update."}
          </div>
          {renderSubagentUsage(event.usage)}
        </div>
      </InlineDisclosureRow>
    );
  }

  /* ── Subagent Result ── */
  if (event.type === "subagent_result") {
    const isSuccess = event.status === "completed";
    const defaultOpen = !isSuccess;
    const summaryTruncated = summarizeInlineText(event.summary, 120);
    return (
      <InlineDisclosureRow
        defaultOpen={defaultOpen}
        summary={
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-fg/52">
            <div className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-md", isSuccess ? "bg-emerald-500/10" : "bg-red-500/10")}>
              {isSuccess ? (
                <CheckCircle size={12} weight="bold" className="text-emerald-400/80" />
              ) : (
                <XCircle size={12} weight="bold" className="text-red-400/80" />
              )}
            </div>
            <span className={cn("font-medium", isSuccess ? "text-emerald-200/70" : "text-red-200/70")}>{isSuccess ? "Agent finished" : "Agent failed"}</span>
            {summaryTruncated ? <span className="flex-1 truncate text-[10px] text-fg/45">{summaryTruncated}</span> : null}
          </div>
        }
      >
        <div className="space-y-3">
          <div className="text-[12px] leading-relaxed text-fg/70">{event.summary}</div>
          {renderSubagentUsage(event.usage)}
        </div>
      </InlineDisclosureRow>
    );
  }

  /* ── Structured Question ── */
  if (event.type === "structured_question") {
    return (
      <div className={cn(GLASS_CARD_CLASS, "p-4")} style={MESSAGE_CARD_STYLE}>
        <div className="mb-2 flex items-center gap-2">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--chat-radius-pill)] border border-[var(--chat-accent-faint)] bg-[var(--chat-accent-faint)]">
            <ChatCircleText size={13} weight="bold" className="text-[var(--chat-accent)]" />
          </span>
          <span className="font-mono text-[11px] font-bold uppercase tracking-widest text-[var(--chat-accent)]">Agent Question</span>
        </div>
        <div className="rounded-[calc(var(--chat-radius-card)-6px)] border border-[color:color-mix(in_srgb,var(--chat-accent)_18%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_8%,transparent)] px-4 py-3 text-[12.5px] leading-[1.65] text-fg/85">
          {event.question}
        </div>
        {event.options?.length ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {event.options.map((option) => (
              <button
                key={option.value}
                type="button"
                className="border border-accent/40 bg-transparent px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-fg/70 transition-colors hover:bg-accent/15"
                onClick={() => options?.onApproval?.(event.itemId, "accept", option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="mt-2 font-mono text-[9px] text-muted-fg/35">or type a custom answer</div>
      </div>
    );
  }

  /* ── Tool Use Summary ── */
  if (event.type === "tool_use_summary") {
    const summaryText = event.summary;
    const toolCount = event.toolUseIds.length;
    return (
      <InlineDisclosureRow
        defaultOpen={summaryText.length <= 120}
        summary={
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-fg/52">
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-white/30" />
            <Info size={11} weight="regular" className="text-fg/34" />
            <span className="font-medium text-fg/62">Tool summary</span>
            <span className="text-[10px] text-fg/35">{toolCount} tool{toolCount === 1 ? "" : "s"}</span>
            <span className="flex-1 truncate text-[10px] text-fg/45">{summarizeInlineText(summaryText, 100)}</span>
          </div>
        }
      >
        <div className="text-[12px] leading-relaxed text-fg/65">{summaryText}</div>
      </InlineDisclosureRow>
    );
  }

  /* ── Context Compact ── */
  if (event.type === "context_compact") {
    const isAuto = event.trigger === "auto";
    const freedLabel = event.preTokens != null ? `~${formatTokenCount(event.preTokens)} tokens freed` : null;
    return (
      <div className="my-2 flex items-center gap-3 py-1">
        <div className="h-px flex-1 bg-gradient-to-r from-transparent via-amber-400/15 to-transparent" />
        <div className="inline-flex items-center gap-2 rounded-lg border border-amber-400/12 bg-amber-500/[0.04] px-3 py-1.5 shadow-[0_0_12px_-4px_rgba(245,158,11,0.08)]">
          <div className="flex h-4 w-4 items-center justify-center rounded-full bg-amber-400/10">
            <Lightning size={9} weight="fill" className="text-amber-400/70" />
          </div>
          <span className="font-mono text-[10px] font-medium tracking-wide text-amber-300/60">
            Context compacted
          </span>
          {freedLabel ? (
            <>
              <span className="text-amber-400/20">&middot;</span>
              <span className="font-mono text-[9px] text-amber-300/40">{freedLabel}</span>
            </>
          ) : null}
          <span className={cn(
            "rounded-md px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-widest",
            isAuto ? "bg-amber-500/8 text-amber-300/35" : "bg-violet-500/8 text-violet-300/40",
          )}>
            {isAuto ? "auto" : "manual"}
          </span>
        </div>
        <div className="h-px flex-1 bg-gradient-to-r from-transparent via-amber-400/15 to-transparent" />
      </div>
    );
  }

  /* ── System Notice ── */
  if (event.type === "system_notice") {
    const kindStyles: Record<string, { border: string; bg: string; text: string; icon: typeof Warning }> = {
      auth: { border: "border-amber-500/18", bg: "bg-amber-500/[0.06]", text: "text-amber-300", icon: Warning },
      rate_limit: { border: "border-red-500/18", bg: "bg-red-500/[0.06]", text: "text-red-300", icon: Warning },
      hook: { border: "border-violet-500/18", bg: "bg-violet-500/[0.06]", text: "text-violet-300", icon: Note },
      file_persist: { border: "border-emerald-500/18", bg: "bg-emerald-500/[0.06]", text: "text-emerald-300", icon: Note },
      memory: { border: "border-cyan-500/18", bg: "bg-cyan-500/[0.06]", text: "text-cyan-300", icon: MagnifyingGlass },
      info: { border: "border-border/14", bg: "bg-surface-recessed/70", text: "text-muted-fg/55", icon: Note },
    };
    const style = kindStyles[event.noticeKind] ?? kindStyles.info!;
    const NoticeIcon = style.icon;
    const hasDetail = hasNoticeDetail(event.detail);

    if (hasDetail) {
      return (
        <CollapsibleCard
          defaultOpen={false}
          summary={
            <div className="flex items-center gap-2 font-mono text-[11px]">
              <NoticeIcon size={12} weight="bold" className={style.text} />
              <span className={cn("inline-flex items-center border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em]", style.border, style.bg, style.text)}>
                {event.noticeKind.replace("_", " ")}
              </span>
              <span className="flex-1 truncate text-[10px] text-fg/55">{event.message}</span>
            </div>
          }
          className={style.border}
        >
          {event.detail ? renderNoticeDetail(event.detail) : null}
        </CollapsibleCard>
      );
    }

    return (
      <div className={cn(
        "inline-flex items-center gap-2 rounded-[var(--chat-radius-pill)] border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em]",
        style.border, style.bg, style.text,
      )}>
        <NoticeIcon size={11} weight="bold" />
        <span className="text-[9px] font-bold">{event.noticeKind.replace("_", " ")}</span>
        <span className="normal-case tracking-normal text-fg/55">{event.message}</span>
      </div>
    );
  }

  /* ── Reasoning ── */
  if (event.type === "reasoning") {
    const reasoningText = event.text.trim();
    const isLive = Boolean(options?.turnActive);

    // Compute duration if we have timestamps
    const startTs = (event as any).startTimestamp ?? envelope.timestamp;
    const endTs = envelope.timestamp;
    const durationSec = Math.max(1, Math.round((new Date(endTs).getTime() - new Date(startTs).getTime()) / 1000));
    const durationLabel = isLive ? null : `${durationSec}s`;

    return (
      <CollapsibleCard
        defaultOpen={false}
        forceOpen={isLive ? true : undefined}
        summary={
          <span className="font-mono text-[12px] text-fg/52">
            {isLive ? (
              <span className="flex items-center gap-2">
                <ThinkingDots toneClass="bg-fg/40" />
                Thinking...
              </span>
            ) : (
              `Thought for ${durationLabel}`
            )}
          </span>
        }
        className={WORK_LOG_CARD_CLASS}
      >
        <div className="text-fg/55 text-[12px] leading-relaxed">
          <MarkdownBlock markdown={reasoningText.length ? event.text : "Thinking..."} />
        </div>
      </CollapsibleCard>
    );
  }

  /* ── Step boundary ── */
  if (event.type === "step_boundary") {
    return null;
  }

  /* ── Tool call ── */
  if (event.type === "tool_invocation") {
    const meta = getToolMeta(event.tool);
    const ToolIcon = meta.icon;
    const toolDisplay = describeToolIdentifier(event.tool);
    const args = readRecord(event.args) ?? {};
    const resultText = event.result === undefined ? null : formatStructuredValue(event.result);
    const targetLine = meta.getTarget ? meta.getTarget(args) : null;
    const label = targetLine
      ? `${meta.label} ${targetLine}`
      : toolDisplay.secondaryLabel
        ? `${meta.label} ${toolDisplay.secondaryLabel}`
        : meta.label;
    const argCount = Object.keys(args).length;

    return (
      <CollapsibleCard
        defaultOpen={event.status === "failed"}
        summary={
          <div className="flex items-center gap-2 font-mono text-[12px] text-fg/50">
            {event.status === "running" ? (
              <ThinkingDots />
            ) : event.status === "failed" ? (
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-400/70" />
            ) : (
              <CaretRight size={10} weight="bold" className="text-fg/30" />
            )}
            <ToolIcon size={13} weight="regular" className="text-fg/40" />
            <span className="truncate">{label}</span>
          </div>
        }
        className={cn(
          WORK_LOG_CARD_CLASS,
          event.parentItemId ? "ml-5" : null,
        )}
      >
        <div className="space-y-3">
          <div>
            <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-fg/35">Arguments</div>
            {argCount ? (
              <pre className={cn("max-h-52", RECESSED_BLOCK_CLASS)}>
                {formatStructuredValue(args)}
              </pre>
            ) : (
              <div className="rounded-[calc(var(--chat-radius-card)-6px)] border border-white/[0.04] bg-black/20 px-4 py-2 font-mono text-[10px] text-muted-fg/40">
                No arguments
              </div>
            )}
          </div>
          {resultText ? (
            <div>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-fg/35">Result</div>
              <pre className={cn("max-h-52", RECESSED_BLOCK_CLASS)}>
                {resultText}
              </pre>
            </div>
          ) : null}
        </div>
      </CollapsibleCard>
    );
  }

  if (event.type === "tool_call") {
    const meta = getToolMeta(event.tool);
    const ToolIcon = meta.icon;
    const toolDisplay = describeToolIdentifier(event.tool);
    const args = event.args as Record<string, unknown> | null;
    const safeArgs = args && typeof args === "object" ? args : {};

    const targetLine = meta.getTarget ? meta.getTarget(safeArgs) : null;
    const label = targetLine
      ? `${meta.label} ${targetLine}`
      : toolDisplay.secondaryLabel
        ? `${meta.label} ${toolDisplay.secondaryLabel}`
        : meta.label;

    // Build expandable args display
    const kvPairs = Object.entries(safeArgs);
    const argsDisplay = kvPairs.length > 0 ? (
      <div className="space-y-1 border border-border/10 bg-surface-recessed/90 px-4 py-2.5 font-mono text-[11px]">
        {kvPairs.map(([k, v]) => {
          const val = typeof v === "string" ? v : JSON.stringify(v);
          const isLongStr = typeof v === "string" && v.includes("\n");
          return (
            <div key={k} className={isLongStr ? "flex flex-col gap-0.5" : "flex items-start gap-2"}>
              <span className="flex-shrink-0 text-muted-fg/40">{k}</span>
              {isLongStr ? (
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[10px] text-fg/55 leading-[1.5]">{val}</pre>
              ) : (
                <span className="min-w-0 break-all text-fg/65">{val}</span>
              )}
            </div>
          );
        })}
      </div>
    ) : (
      <div className="border border-border/10 bg-surface-recessed/90 px-4 py-2 font-mono text-[10px] text-muted-fg/40">
        No arguments
      </div>
    );

    return (
      <CollapsibleCard
        defaultOpen={false}
        summary={
          <div className="flex items-center gap-2 font-mono text-[12px] text-fg/50">
            <CaretRight size={10} weight="bold" className="text-fg/30" />
            <ToolIcon size={13} weight="regular" className="text-fg/40" />
            <span className="truncate">{label}</span>
          </div>
        }
        className={WORK_LOG_CARD_CLASS}
      >
        {argsDisplay}
      </CollapsibleCard>
    );
  }

  /* ── Tool result ── */
  if (event.type === "tool_result") {
    return <ToolResultCard event={event} />;
  }

  /* ── Approval request ── */
  if (event.type === "approval_request") {
    const handleApproval = options?.onApproval ? (d: AgentChatApprovalDecision) => options.onApproval?.(event.itemId, d) : undefined;
    const isResponding = options?.respondingApprovalIds?.has(event.itemId) ?? false;
    const isPending = options?.pendingApprovalIds?.has(event.itemId) ?? true;
    const isResolved = !isPending && !isResponding;
    const detail = readRecord(event.detail);
    const request = readRecord(detail?.request);
    const requestKind = typeof request?.kind === "string" ? request.kind.trim() : "";
    const requestSource = typeof request?.source === "string" ? request.source.trim() : "";
    const requestDescription = typeof request?.description === "string" ? request.description.trim() : "";
    const requestQuestions = Array.isArray(request?.questions)
      ? request.questions.map((question) => readRecord(question)).filter((question): question is Record<string, unknown> => question != null)
      : [];
    const primaryQuestion = requestQuestions[0] ?? null;
    const primaryQuestionText = typeof primaryQuestion?.question === "string" ? primaryQuestion.question.trim() : "";
    const quickOptions = Array.isArray(primaryQuestion?.options)
      ? primaryQuestion.options
          .map((option) => readRecord(option))
          .filter((option): option is Record<string, unknown> => option != null)
          .map((option) => {
            const label = typeof option.label === "string" ? option.label.trim() : "";
            const value = typeof option.value === "string" ? option.value.trim() : label;
            if (!label.length || !value.length) return null;
            return { label, value };
          })
          .filter((option): option is { label: string; value: string } => option != null)
      : [];
    const detailTool = typeof detail?.tool === "string" ? detail.tool.trim() : "";
    const question = typeof detail?.question === "string" ? detail.question.trim() : "";
    const normalizedTool = detailTool.toLowerCase();
    const isQuestionRequest = requestKind === "question" || requestKind === "structured_question";
    const isPermissionRequest = requestKind === "permissions";
    const isPlanApproval = requestKind === "plan_approval";
    const isAskUser = ((normalizedTool === "askuser" || normalizedTool === "ask_user") && question.length > 0) || isQuestionRequest;
    const detailText = (() => {
      if (event.detail == null || isAskUser) return "";
      if (!request) return formatStructuredValue(event.detail);
      const detailWithoutRequest = { ...detail };
      delete detailWithoutRequest.request;
      return Object.keys(detailWithoutRequest).length ? formatStructuredValue(detailWithoutRequest) : "";
    })();
    let bodyText: string;
    if (isQuestionRequest) {
      bodyText = requestDescription || primaryQuestionText || question || event.description;
    } else if (isAskUser) {
      bodyText = question;
    } else if (isPlanApproval) {
      bodyText = requestDescription || primaryQuestionText || event.description;
    } else {
      bodyText = event.description;
    }
    return (
      <div className={cn(GLASS_CARD_CLASS, "p-4")} style={SURFACE_INLINE_CARD_STYLE}>
        <div className="mb-2 flex items-center gap-2">
          {isAskUser ? (
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-500/[0.10] shadow-[0_0_0_3px_rgba(245,158,11,0.12)]">
              <ChatStatusGlyph status="waiting" size={11} />
            </span>
          ) : isPlanApproval ? (
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-violet-500/[0.10] shadow-[0_0_0_3px_rgba(139,92,246,0.12)]">
              <ChatStatusGlyph status="waiting" size={11} />
            </span>
          ) : (
            <Warning size={13} weight="bold" className="text-amber-500" />
          )}
          <span className="font-mono text-[11px] font-bold uppercase tracking-widest text-fg/85">
            {isAskUser ? "Needs Input" : isPlanApproval ? "Plan Approval" : isPermissionRequest ? "Permission Request" : "Approval Required"}
          </span>
          <span className="font-mono text-[10px] text-muted-fg/40">{requestSource || event.kind}</span>
        </div>
        {isPlanApproval ? (
          <div className="max-h-72 overflow-y-auto text-[12px] leading-relaxed text-fg/75 whitespace-pre-wrap">{bodyText}</div>
        ) : (
          <div className="text-[12px] leading-relaxed text-fg/75">{bodyText}</div>
        )}
        {isQuestionRequest && quickOptions.length > 0 && options?.onApproval ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {quickOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className="rounded-[var(--chat-radius-pill)] border border-accent/25 bg-accent/[0.08] px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-fg/80 transition-colors hover:bg-accent/[0.16]"
                onClick={() => options.onApproval?.(event.itemId, "accept", option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
        {detailText.length ? (
          <div className="mt-3">
            <CollapsibleCard
              defaultOpen={false}
              summary={<span className="font-mono text-[10px] uppercase tracking-wider text-amber-300/70">Request Details</span>}
              className="border-transparent bg-surface/35"
            >
              <pre className={cn("max-h-52", RECESSED_BLOCK_CLASS)}>
                {detailText}
              </pre>
            </CollapsibleCard>
          </div>
        ) : null}
        {isAskUser ? (
          <div className="mt-3 border border-accent/15 bg-accent/[0.05] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-accent/65">
            Answer this from the question modal to keep the agent moving.
          </div>
        ) : null}
        {handleApproval && !isAskUser ? (
          isPlanApproval ? (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {isResolved ? (
                <span className="inline-flex items-center gap-1.5 rounded-[var(--chat-radius-pill)] border border-emerald-500/20 bg-emerald-500/8 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-emerald-300/70">
                  <Check size={12} weight="bold" /> Responded
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={isResponding}
                    className="border border-emerald-400/40 bg-emerald-500/15 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-emerald-200 transition-colors hover:bg-emerald-500/25 disabled:opacity-40 disabled:pointer-events-none"
                    onClick={() => handleApproval("accept")}
                  >
                    {isResponding ? "Processing..." : "Approve & Implement"}
                  </button>
                  <button
                    type="button"
                    disabled={isResponding}
                    className="border border-border/25 bg-transparent px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-fg/50 transition-colors hover:bg-border/15 disabled:opacity-40 disabled:pointer-events-none"
                    onClick={() => handleApproval("decline")}
                  >
                    Reject &amp; Revise
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {isResolved ? (
                <span className="inline-flex items-center gap-1.5 rounded-[var(--chat-radius-pill)] border border-emerald-500/20 bg-emerald-500/8 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-emerald-300/70">
                  <Check size={12} weight="bold" /> Responded
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={isResponding}
                    className="border border-accent/40 bg-accent/15 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-fg transition-colors hover:bg-accent/25 disabled:opacity-40 disabled:pointer-events-none"
                    onClick={() => handleApproval("accept")}
                  >
                    {isResponding ? "Processing..." : "Accept"}
                  </button>
                  <button
                    type="button"
                    disabled={isResponding}
                    className="border border-accent/20 bg-transparent px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-fg/70 transition-colors hover:bg-accent/10 disabled:opacity-40 disabled:pointer-events-none"
                    onClick={() => handleApproval("accept_for_session")}
                  >
                    Accept All
                  </button>
                  <button
                    type="button"
                    disabled={isResponding}
                    className="border border-border/25 bg-transparent px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-fg/50 transition-colors hover:bg-border/15 disabled:opacity-40 disabled:pointer-events-none"
                    onClick={() => handleApproval("decline")}
                  >
                    Decline
                  </button>
                  <button
                    type="button"
                    disabled={isResponding}
                    className="border border-border/25 bg-transparent px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-fg/50 transition-colors hover:bg-border/15 disabled:opacity-40 disabled:pointer-events-none"
                    onClick={() => handleApproval("cancel")}
                  >
                    Dismiss
                  </button>
                </>
              )}
            </div>
          )
        ) : null}
      </div>
    );
  }

  /* ── Error ── */
  if (event.type === "error") {
    return (
      <div className={cn(GLASS_CARD_CLASS, "group border-red-500/12 p-0")} style={SURFACE_INLINE_CARD_STYLE}>
        <div className="h-px w-full bg-gradient-to-r from-transparent via-red-500/40 to-transparent" />
        <div className="p-4">
          <div className="mb-2 flex items-center gap-2">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-red-500/10">
              <Warning size={13} weight="bold" className="text-red-400/90" />
            </div>
            <span className="font-mono text-[11px] font-bold uppercase tracking-widest text-fg/85">Error</span>
            {event.errorInfo && typeof event.errorInfo !== "string" && event.errorInfo.category ? (
              <span className="inline-flex items-center rounded-md border border-red-500/12 bg-red-500/[0.06] px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-[0.16em] text-red-300/70">
                {event.errorInfo.category}
              </span>
            ) : null}
            <div className="ml-auto">
              <MessageCopyButton value={event.message} className="opacity-0 group-hover:opacity-100 focus-within:opacity-100" />
            </div>
          </div>
          <div className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-fg/80">{event.message}</div>
          {event.errorInfo ? (
            <div className="mt-2 font-mono text-[10px] text-muted-fg/40">
              {typeof event.errorInfo === "string" ? event.errorInfo : `${event.errorInfo.provider ? `${event.errorInfo.provider}` : ""}${event.errorInfo.model ? ` / ${event.errorInfo.model}` : ""}`}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  /* ── Activity ── */
  if (event.type === "activity") {
    return <ActivityIndicator activity={event.activity} detail={event.detail} animate={options?.turnActive !== false} />;
  }

  /* ── Status ── */
  if (event.type === "status") {
    const isFailure = event.turnStatus === "failed";
    const isInterrupted = event.turnStatus === "interrupted";
    if (!isFailure && !isInterrupted && !(event.message ?? "").trim().length) {
      return null;
    }
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-[var(--chat-radius-pill)] border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em]",
          isFailure
            ? "border-red-500/14 bg-red-500/[0.05] text-red-300"
            : isInterrupted
              ? "border-amber-500/14 bg-amber-500/[0.05] text-amber-300"
              : "border-border/14 bg-surface-recessed/70 text-muted-fg/55"
        )}
      >
        <Warning size={11} weight="bold" />
        <span>{event.turnStatus}</span>
        {event.message ? (
          <span className="truncate text-[9px] normal-case tracking-normal text-fg/55">
            {event.message}
          </span>
        ) : null}
      </div>
    );
  }

  /* ── Delegation ── */
  if (event.type === "delegation_state") {
    const isFailure =
      event.contract.status === "blocked"
      || event.contract.status === "launch_failed"
      || event.contract.status === "failed";
    const label = `${event.contract.workerIntent} ${event.contract.status}`.replace(/_/g, " ");
    const detail = (event.message ?? "").trim();
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-[var(--chat-radius-pill)] border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em]",
          isFailure
            ? "border-red-500/14 bg-red-500/[0.05] text-red-300"
            : "border-border/14 bg-surface-recessed/70 text-muted-fg/55"
        )}
      >
        <Warning size={11} weight="bold" />
        <span>{label}</span>
        {detail ? (
          <span className="truncate text-[9px] normal-case tracking-normal text-fg/55">
            {detail}
          </span>
        ) : null}
      </div>
    );
  }

  /* ── Done ── */
  if (event.type === "done") {
    const { label: modelLabel } = resolveModelMeta(event.modelId, event.model);
    const inputTokens = formatTokenCount(event.usage?.inputTokens);
    const outputTokens = formatTokenCount(event.usage?.outputTokens);
    const cacheRead = formatTokenCount(event.usage?.cacheReadTokens);
    const cacheCreation = formatTokenCount(event.usage?.cacheCreationTokens);
    const costLabel = typeof event.costUsd === "number" && event.costUsd > 0
      ? `$${event.costUsd < 0.01 ? event.costUsd.toFixed(4) : event.costUsd.toFixed(2)}`
      : null;
    const hasUsageData = Boolean(inputTokens || outputTokens || cacheRead || cacheCreation || costLabel || modelLabel);
    if (event.status === "completed" && !hasUsageData) {
      return null;
    }
    const statusTone = event.status === "completed"
      ? "border-teal-400/8 bg-teal-400/[0.03] text-fg/45"
      : event.status === "failed"
        ? "border-red-500/15 bg-red-500/[0.05] text-red-300"
        : "border-amber-500/15 bg-amber-500/[0.05] text-amber-300";

    return (
      <div className={cn("flex items-start justify-between gap-3 rounded-lg border px-3 py-1.5 font-sans text-[10px]", statusTone)}>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-fg/40">Usage</span>
          {modelLabel ? (
            <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-fg/35">
              <ModelGlyph modelId={event.modelId} model={event.model} size={10} className="shrink-0 text-fg/40" />
              <span className="min-w-0 break-words">{modelLabel}</span>
            </span>
          ) : null}
          {inputTokens ? <span className="text-fg/30">In {inputTokens}</span> : null}
          {outputTokens ? <span className="text-fg/30">Out {outputTokens}</span> : null}
          {cacheRead ? <span className="text-emerald-400/35">Cache {cacheRead}</span> : null}
          {cacheCreation ? <span className="text-violet-400/35">New cache {cacheCreation}</span> : null}
          {costLabel ? <span className="text-fg/30">{costLabel}</span> : null}
        </div>
        {event.status !== "completed" ? (
          <span className="shrink-0 self-center text-[9px] font-medium uppercase tracking-wide text-current">{event.status}</span>
        ) : null}
      </div>
    );
  }

  /* ── Completion report ── */
  if (event.type === "completion_report") {
    const statusTone = event.report.status === "completed"
      ? "border-emerald-400/15 bg-emerald-400/[0.05] text-emerald-200"
      : event.report.status === "blocked"
        ? "border-red-500/15 bg-red-500/[0.05] text-red-200"
        : "border-amber-500/15 bg-amber-500/[0.05] text-amber-200";
    return (
      <div className={cn("rounded-lg border px-3 py-2.5", statusTone)}>
        <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em]">
          <span>Completion</span>
          <span className="text-current/80">{event.report.status}</span>
          {event.report.artifacts.length > 0 ? (
            <span className="text-current/70">{event.report.artifacts.length} artifact{event.report.artifacts.length === 1 ? "" : "s"}</span>
          ) : null}
        </div>
        <div className="mt-2 text-[12px] leading-5 text-fg/85">{event.report.summary}</div>
        {event.report.blockerDescription ? (
          <div className="mt-2 text-[11px] leading-5 text-fg/65">{event.report.blockerDescription}</div>
        ) : null}
      </div>
    );
  }

  /* ── Fallback ── */
  return (
    <div className="flex items-center gap-3 py-0.5">
      <div className="h-px flex-1 bg-white/6" />
      <span className="font-sans text-[10px] text-muted-fg/20">event</span>
      <div className="h-px flex-1 bg-white/6" />
    </div>
  );
}

type TurnSummaryTask = {
  id: string;
  description: string;
  status: string;
};

type TurnSummaryFile = {
  path: string;
  kind: Extract<AgentChatEvent, { type: "file_change" }>["kind"];
  status?: Extract<AgentChatEvent, { type: "file_change" }>["status"];
  additions: number;
  deletions: number;
};

type TurnSummary = {
  turnId: string;
  tasks: TurnSummaryTask[];
  files: TurnSummaryFile[];
  totalAdditions: number;
  totalDeletions: number;
  backgroundAgentCount: number;
  activeBackgroundAgentCount: number;
  turnModel: { label: string; modelId?: string; model?: string } | null;
};

function deriveTurnSummary(
  events: AgentChatEventEnvelope[],
  turnModelState: DerivedTurnModelState | null,
): TurnSummary | null {
  const latestTurnId = [...events]
    .reverse()
    .map((envelope) => getEventTurnId(envelope.event))
    .find((turnId): turnId is string => Boolean(turnId));
  if (!latestTurnId) return null;

  let latestTodoUpdate: Extract<AgentChatEvent, { type: "todo_update" }> | null = null;
  let latestPlan: Extract<AgentChatEvent, { type: "plan" }> | null = null;
  const files = new Map<string, TurnSummaryFile>();
  const subagents = new Map<string, { background: boolean; status: ChatSubagentSnapshot["status"] }>();

  for (const envelope of events) {
    const event = envelope.event;
    if (getEventTurnId(event) !== latestTurnId) continue;

    if (event.type === "todo_update") {
      latestTodoUpdate = event;
      continue;
    }

    if (event.type === "plan") {
      latestPlan = event;
      continue;
    }

    if (event.type === "file_change") {
      const stats = summarizeDiffStats(event.diff);
      files.set(event.path, {
        path: event.path,
        kind: event.kind,
        status: event.status,
        additions: stats.additions,
        deletions: stats.deletions,
      });
      continue;
    }

    if (event.type === "subagent_started") {
      const existing = subagents.get(event.taskId);
      subagents.set(event.taskId, {
        background: event.background ?? existing?.background ?? false,
        status: "running",
      });
      continue;
    }

    if (event.type === "subagent_progress") {
      const existing = subagents.get(event.taskId);
      subagents.set(event.taskId, {
        background: existing?.background ?? false,
        status: "running",
      });
      continue;
    }

    if (event.type === "subagent_result") {
      const existing = subagents.get(event.taskId);
      subagents.set(event.taskId, {
        background: existing?.background ?? false,
        status: event.status,
      });
    }
  }

  const tasks: TurnSummaryTask[] = latestTodoUpdate
    ? latestTodoUpdate.items.map((item) => ({
        id: item.id,
        description: item.description,
        status: item.status,
      }))
    : latestPlan
      ? latestPlan.steps.map((step, index) => ({
          id: `plan-${index}`,
          description: step.text,
          status: step.status,
        }))
      : [];
  const changedFiles = [...files.values()];
  const totalAdditions = changedFiles.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions = changedFiles.reduce((sum, file) => sum + file.deletions, 0);
  const backgroundAgentCount = [...subagents.values()].filter((entry) => entry.background).length;
  const activeBackgroundAgentCount = [...subagents.values()].filter((entry) => entry.background && entry.status === "running").length;

  if (!tasks.length && !changedFiles.length && !backgroundAgentCount) {
    return null;
  }

  return {
    turnId: latestTurnId,
    tasks,
    files: changedFiles,
    totalAdditions,
    totalDeletions,
    backgroundAgentCount,
    activeBackgroundAgentCount,
    turnModel: turnModelState?.map.get(latestTurnId) ?? null,
  };
}

function TurnSummaryCard({
  summary,
  onReviewChanges,
}: {
  summary: TurnSummary;
  onReviewChanges?: () => void;
}) {
  const completedCount = summary.tasks.filter((task) => task.status === "completed").length;
  const totalCount = summary.tasks.length;
  const filesLabel = summary.files.length
    ? `${summary.files.length} file${summary.files.length === 1 ? "" : "s"} changed`
    : null;
  const agentsLabel = summary.backgroundAgentCount
    ? `${summary.backgroundAgentCount} background agent${summary.backgroundAgentCount === 1 ? "" : "s"}`
    : null;

  return (
    <div className="overflow-hidden rounded-[20px] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(26,26,29,0.92),rgba(19,19,22,0.94))] shadow-[0_24px_80px_-48px_rgba(0,0,0,0.85)]">
      <div className="border-b border-white/[0.05] px-4 py-3">
        <div className="flex items-center gap-2">
          <ListChecks size={13} weight="bold" className="text-fg/58" />
          <span className="font-sans text-[13px] font-medium text-fg/86">
            {totalCount
              ? `${completedCount} of ${totalCount} tasks completed`
              : filesLabel ?? agentsLabel ?? "Turn summary"}
          </span>
          {summary.turnModel?.label ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 font-mono text-[10px] text-fg/45">
              <ModelGlyph modelId={summary.turnModel.modelId} model={summary.turnModel.model} size={10} className="text-fg/35" />
              <span>{summary.turnModel.label}</span>
            </span>
          ) : null}
          {onReviewChanges && summary.files.length > 0 ? (
            <button
              type="button"
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[11px] text-fg/70 transition-colors hover:bg-white/[0.05] hover:text-fg/88"
              onClick={onReviewChanges}
            >
              Review changes
            </button>
          ) : null}
        </div>
      </div>

      {summary.tasks.length ? (
        <div className="space-y-1 border-b border-white/[0.05] px-4 py-3">
          {summary.tasks.map((task, index) => (
            <div key={task.id || `${task.description}:${index}`} className="flex items-start gap-2.5 py-1">
              <div className="mt-0.5 shrink-0">
                <PlanStepIcon status={task.status} />
              </div>
              <div className={cn(
                "flex-1 text-[12px] leading-6",
                task.status === "completed" ? "text-fg/42 line-through decoration-fg/15" : "text-fg/82",
              )}>
                {task.description}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 px-4 py-3 font-mono text-[10px] text-fg/44">
        {filesLabel ? (
          <span>
            {filesLabel}
            {summary.totalAdditions > 0 ? <span className="ml-2 text-emerald-300/70">+{summary.totalAdditions}</span> : null}
            {summary.totalDeletions > 0 ? <span className="ml-1 text-red-300/70">-{summary.totalDeletions}</span> : null}
          </span>
        ) : null}
        {agentsLabel ? (
          <span>
            {agentsLabel}
            {summary.activeBackgroundAgentCount > 0 ? <span className="ml-2 text-sky-300/60">{summary.activeBackgroundAgentCount} active</span> : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function deriveLatestActivity(events: AgentChatEventEnvelope[]): { activity: string; detail?: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i]!.event;
    if (evt.type === "activity") {
      return { activity: evt.activity, detail: evt.detail };
    }
    if (evt.type === "done" || evt.type === "status") return null;
  }
  return null;
}

function deriveActiveTurnId(events: AgentChatEventEnvelope[]): string | null {
  const completedTurnIds = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i]!.event;
    if (evt.type === "done" && evt.turnId?.trim()) {
      completedTurnIds.add(evt.turnId.trim());
      continue;
    }
    const turnId = getEventTurnId(evt);
    if (!turnId || completedTurnIds.has(turnId)) continue;
    return turnId;
  }
  return null;
}

function getGroupedTurnId(envelope: TranscriptGroupedEnvelope | undefined): string | null {
  if (!envelope) return null;
  if (envelope.event.type === "work_log_group") {
    return envelope.event.entries[0]?.turnId ?? null;
  }
  return "turnId" in envelope.event ? envelope.event.turnId ?? null : null;
}

/* ── Main component ── */

type EventRowProps = {
  envelope: TranscriptGroupedEnvelope;
  showTurnDivider: boolean;
  turnDividerLabel: string | null;
  turnModel: { label: string; modelId?: string; model?: string } | null;
  onApproval?: (itemId: string, decision: AgentChatApprovalDecision, responseText?: string | null) => void;
  surfaceMode?: ChatSurfaceMode;
  surfaceProfile?: ChatSurfaceProfile;
  assistantLabel?: string;
  turnActive?: boolean;
  onOpenWorkspacePath?: (path: string) => void;
  onNavigateSuggestion?: (suggestion: OperatorNavigationSuggestion) => void;
  respondingApprovalIds?: Set<string>;
  pendingApprovalIds?: Set<string>;
};

const EventRow = React.memo(function EventRow({
  envelope,
  showTurnDivider,
  turnDividerLabel,
  turnModel,
  onApproval,
  surfaceMode = "standard",
  surfaceProfile = "standard",
  assistantLabel,
  turnActive,
  onOpenWorkspacePath,
  onNavigateSuggestion,
  respondingApprovalIds,
  pendingApprovalIds,
}: EventRowProps) {
  return (
    <div className="space-y-3">
      {showTurnDivider ? (
        <div className="my-1 flex items-center gap-3">
          <span className="h-px flex-1 bg-gradient-to-r from-transparent via-white/[0.07] to-transparent" />
          <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.06] bg-white/[0.02] px-2.5 py-1 font-sans text-[10px] text-fg/30">
            {turnModel?.label ? (
              <>
                <ModelGlyph modelId={turnModel.modelId} model={turnModel.model} size={10} className="text-fg/25" />
                <span className="text-fg/25">{turnModel.label}</span>
                <span className="text-fg/12">&middot;</span>
              </>
            ) : null}
            <span>{turnDividerLabel ?? "Turn"}</span>
          </span>
          <span className="h-px flex-1 bg-gradient-to-r from-transparent via-white/[0.07] to-transparent" />
        </div>
      ) : null}
      {envelope.event.type === "work_log_group"
        ? (
          <ChatWorkLogBlock
            entries={envelope.event.entries}
            onNavigateSuggestion={onNavigateSuggestion}
          />
        )
        : renderEvent(envelope as RenderEnvelope, { onApproval, turnModel, surfaceMode, surfaceProfile, assistantLabel, turnActive, onOpenWorkspacePath, respondingApprovalIds, pendingApprovalIds })}
    </div>
  );
});

/**
 * MeasuredEventRow wraps EventRow and reports its rendered height back to the
 * virtualizer so subsequent frames use real measured sizes instead of estimates.
 */
const MeasuredEventRow = React.memo(function MeasuredEventRow({
  index,
  onMeasure,
  ...rest
}: EventRowProps & { index: number; onMeasure: (index: number, height: number) => void }) {
  const rowRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const height = entry.target instanceof HTMLElement ? entry.target.offsetHeight : entry.contentRect.height;
      if (height > 0) onMeasure(index, height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [index, onMeasure]);

  return (
    <div ref={rowRef}>
      <EventRow {...rest} />
    </div>
  );
});

/* ── Virtualization constants ── */

/** Estimated height per message row (px) used before real measurement. */
const ESTIMATED_ROW_HEIGHT = 80;
/** Gap between rows from `space-y-3` (Tailwind 0.75rem = 12px). */
const ROW_GAP = 12;
/** Number of extra rows to render above/below the visible viewport. */
const OVERSCAN = 10;
/** Minimum number of rows before virtualization kicks in. */
const VIRTUALIZATION_THRESHOLD = 60;

export function calculateVirtualWindow({
  rowCount,
  scrollTop,
  containerHeight,
  rowHeight,
  overscan = OVERSCAN,
  rowGap = ROW_GAP,
}: {
  rowCount: number;
  scrollTop: number;
  containerHeight: number;
  rowHeight: (index: number) => number;
  overscan?: number;
  rowGap?: number;
}): {
  startIndex: number;
  endIndex: number;
  totalHeight: number;
  offsetTop: number;
} {
  if (rowCount <= 0) {
    return { startIndex: 0, endIndex: 0, totalHeight: 0, offsetTop: 0 };
  }

  let cumulative = 0;
  const offsets: number[] = new Array(rowCount);
  for (let i = 0; i < rowCount; i += 1) {
    offsets[i] = cumulative;
    cumulative += rowHeight(i) + rowGap;
  }
  const totalHeight = cumulative - rowGap;
  const viewTop = scrollTop;
  const viewBottom = scrollTop + containerHeight;

  let lo = 0;
  let hi = rowCount - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const rowBottom = offsets[mid]! + rowHeight(mid);
    if (rowBottom < viewTop) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const firstVisible = lo;

  let lastVisible = firstVisible;
  while (lastVisible < rowCount - 1 && offsets[lastVisible + 1]! < viewBottom) {
    lastVisible += 1;
  }

  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(rowCount, lastVisible + 1 + overscan);

  return {
    startIndex,
    endIndex,
    totalHeight,
    offsetTop: offsets[startIndex] ?? 0,
  };
}

export function reconcileMeasuredScrollTop({
  index,
  previousHeight,
  nextHeight,
  scrollTop,
  rowHeight,
  rowGap = ROW_GAP,
}: {
  index: number;
  previousHeight: number;
  nextHeight: number;
  scrollTop: number;
  rowHeight: (index: number) => number;
  rowGap?: number;
}): number {
  const delta = nextHeight - previousHeight;
  if (delta === 0) return scrollTop;

  let rowTop = 0;
  for (let i = 0; i < index; i += 1) {
    rowTop += rowHeight(i) + rowGap;
  }

  const rowBottom = rowTop + previousHeight;
  if (rowBottom <= scrollTop) {
    return Math.max(0, scrollTop + delta);
  }
  return scrollTop;
}

export function AgentChatMessageList({
  events,
  showStreamingIndicator = false,
  className,
  onApproval,
  surfaceMode = "standard",
  surfaceProfile = "standard",
  assistantLabel,
  onOpenWorkspacePath,
  respondingApprovalIds,
  pendingApprovalIds,
}: {
  events: AgentChatEventEnvelope[];
  showStreamingIndicator?: boolean;
  className?: string;
  onApproval?: (itemId: string, decision: AgentChatApprovalDecision, responseText?: string | null) => void;
  surfaceMode?: ChatSurfaceMode;
  surfaceProfile?: ChatSurfaceProfile;
  assistantLabel?: string;
  onOpenWorkspacePath?: (path: string, laneId?: string | null) => void;
  respondingApprovalIds?: Set<string>;
  pendingApprovalIds?: Set<string>;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const collapseCacheRef = useRef<{ events: AgentChatEventEnvelope[]; rows: TranscriptRenderEnvelope[] }>({
    events: [],
    rows: [],
  });
  const [stickToBottom, setStickToBottom] = useState(true);
  const [filesWorkspaces, setFilesWorkspaces] = useState<FilesWorkspace[]>([]);
  const stickToBottomRef = useRef(true);
  const onApprovalRef = useRef(onApproval);

  // Virtualization scroll tracking
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [measurementTick, setMeasurementTick] = useState(0);
  // Map of row index → measured height (filled in lazily as rows render)
  const measuredHeights = useRef<Map<number, number>>(new Map());
  // Track previous events identity to clear stale measurements on session switch
  const prevEventsRef = useRef<AgentChatEventEnvelope[]>(events);
  if (prevEventsRef.current !== events && events.length > 0 && (events[0] !== prevEventsRef.current[0])) {
    measuredHeights.current.clear();
  }
  prevEventsRef.current = events;

  useEffect(() => {
    onApprovalRef.current = onApproval;
  }, [onApproval]);

  const handleApproval = useCallback((itemId: string, decision: AgentChatApprovalDecision, responseText?: string | null) => {
    onApprovalRef.current?.(itemId, decision, responseText);
  }, []);

  const rows = useMemo(() => {
    const cached = collapseCacheRef.current;
    const nextRows = collapseChatTranscriptEventsIncremental(events, cached.events, cached.rows);
    collapseCacheRef.current = { events, rows: nextRows };
    return nextRows;
  }, [events]);
  const groupedRows = useMemo(() => groupConsecutiveWorkLogRows(rows), [rows]);
  const latestActivity = useMemo(() => (showStreamingIndicator ? deriveLatestActivity(events) : null), [events, showStreamingIndicator]);
  const activeTurnId = useMemo(() => (showStreamingIndicator ? deriveActiveTurnId(events) : null), [events, showStreamingIndicator]);

  const currentLaneId = typeof (location.state as { laneId?: unknown } | null)?.laneId === "string"
    ? (location.state as { laneId: string }).laneId
    : null;

  useEffect(() => {
    let cancelled = false;
    const listWorkspaces = window.ade?.files?.listWorkspaces;
    if (typeof listWorkspaces !== "function") return;
    listWorkspaces()
      .then((workspaces) => {
        if (!cancelled) {
          setFilesWorkspaces(workspaces);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFilesWorkspaces([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openWorkspacePath = useCallback(async (path: string) => {
    let resolvedWorkspaces = filesWorkspaces;
    let target = resolveFilesNavigationTarget({
      path,
      workspaces: resolvedWorkspaces,
      fallbackLaneId: currentLaneId,
    });
    if (!target && normalizeWorkspacePathCandidate(path)?.startsWith("/")) {
      const listWorkspaces = window.ade?.files?.listWorkspaces;
      if (typeof listWorkspaces === "function") {
        try {
          resolvedWorkspaces = await listWorkspaces();
          setFilesWorkspaces(resolvedWorkspaces);
          target = resolveFilesNavigationTarget({
            path,
            workspaces: resolvedWorkspaces,
            fallbackLaneId: currentLaneId,
          });
        } catch {
          target = null;
        }
      }
    }
    if (!target) return;
    const state = target.laneId
      ? { openFilePath: target.openFilePath, laneId: target.laneId }
      : { openFilePath: target.openFilePath };
    navigate("/files", { state });
    onOpenWorkspacePath?.(target.openFilePath, target.laneId);
  }, [currentLaneId, filesWorkspaces, navigate, onOpenWorkspacePath]);

  const handleNavigateSuggestion = useCallback((suggestion: OperatorNavigationSuggestion) => {
    navigate(suggestion.href);
  }, [navigate]);

  const turnModelStateRef = useRef<DerivedTurnModelState | null>(null);
  const turnModelState = useMemo(() => {
    const nextState = deriveTurnModelState(events, turnModelStateRef.current);
    turnModelStateRef.current = nextState;
    return nextState;
  }, [events]);
  const turnSummary = useMemo(() => deriveTurnSummary(events, turnModelState), [events, turnModelState]);

  const handleReviewChanges = useCallback(() => {
    if (!turnSummary?.files.length) return;
    const state = currentLaneId ? { laneId: currentLaneId } : undefined;
    navigate("/files", state ? { state } : undefined);
  }, [currentLaneId, navigate, turnSummary]);

  useEffect(() => {
    stickToBottomRef.current = stickToBottom;
  }, [stickToBottom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottom) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [groupedRows, measurementTick, stickToBottom, showStreamingIndicator]);

  // Observe scrollHeight changes via MutationObserver so streaming content
  // (which grows existing rows without changing groupedRows identity) still
  // triggers autoscroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof MutationObserver === "undefined") return;
    let prevScrollHeight = el.scrollHeight;
    const mo = new MutationObserver(() => {
      if (el.scrollHeight !== prevScrollHeight) {
        prevScrollHeight = el.scrollHeight;
        if (stickToBottomRef.current) {
          el.scrollTop = el.scrollHeight;
        }
      }
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, []);

  // Observe the scroll container's size so we know the viewport height.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") {
      // Fallback for test environments / old browsers
      setContainerHeight(el.clientHeight);
      return;
    }
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    ro.observe(el);
    setContainerHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const shouldVirtualize = groupedRows.length >= VIRTUALIZATION_THRESHOLD;

  /** Returns the best-known height for a given row index. */
  const rowHeight = useCallback((index: number) => {
    return measuredHeights.current.get(index) ?? ESTIMATED_ROW_HEIGHT;
  }, []);

  /** Callback from MeasuredEventRow when it measures its real DOM height. */
  const measureFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleMeasure = useCallback((index: number, height: number) => {
    const prev = measuredHeights.current.get(index);
    if (prev !== height) {
      measuredHeights.current.set(index, height);
      const scrollEl = scrollRef.current;
      if (scrollEl && shouldVirtualize && !stickToBottomRef.current) {
        const adjustedScrollTop = reconcileMeasuredScrollTop({
          index,
          previousHeight: prev ?? ESTIMATED_ROW_HEIGHT,
          nextHeight: height,
          scrollTop: scrollEl.scrollTop,
          rowHeight,
        });
        if (adjustedScrollTop !== scrollEl.scrollTop) {
          scrollEl.scrollTop = adjustedScrollTop;
          setScrollTop(adjustedScrollTop);
        }
      }
      // Debounce measurement tick updates to batch rapid height changes
      // into a single re-render instead of one per row.
      if (!measureFlushTimer.current) {
        measureFlushTimer.current = setTimeout(() => {
          measureFlushTimer.current = null;
          setMeasurementTick((value) => value + 1);
        }, 80);
      }
    }
  }, [rowHeight, shouldVirtualize]);

  // Compute the visible window of rows when virtualization is active.
  // measurementTick forces recomputation when row heights are measured so
  // totalHeight stays accurate — without this, scroll-to-top can break because
  // the spacer heights are computed from stale estimates.
  const { startIndex, endIndex, totalHeight, offsetTop } = useMemo(() => {
    if (!shouldVirtualize) {
      return { startIndex: 0, endIndex: groupedRows.length, totalHeight: 0, offsetTop: 0 };
    }

    return calculateVirtualWindow({
      rowCount: groupedRows.length,
      scrollTop,
      containerHeight,
      rowHeight,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldVirtualize, groupedRows.length, scrollTop, containerHeight, rowHeight, measurementTick]);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    const nextStick = distanceFromBottom < 72;
    if (nextStick !== stickToBottomRef.current) {
      stickToBottomRef.current = nextStick;
      setStickToBottom(nextStick);
    }
    if (shouldVirtualize) {
      setScrollTop(target.scrollTop);
    }
  }, [shouldVirtualize]);

  /** Renders a single row with turn-divider logic. Used by both paths. */
  const renderRow = useCallback((envelope: TranscriptGroupedEnvelope, index: number, virtualized: boolean) => {
    const currentTurn = getGroupedTurnId(envelope);
    const previousTurn = getGroupedTurnId(groupedRows[index - 1]);
    const showTurnDivider = currentTurn && currentTurn !== previousTurn;
    const turnDividerLabel = showTurnDivider
      ? formatTime(envelope.timestamp)
      : null;
    const turnModel = currentTurn
      ? (turnModelState.map.get(currentTurn) ?? null)
      : turnModelState.lastModel;

    if (virtualized) {
      return (
        <MeasuredEventRow
          key={envelope.key}
          index={index}
          onMeasure={handleMeasure}
          envelope={envelope}
          showTurnDivider={Boolean(showTurnDivider)}
          turnDividerLabel={turnDividerLabel}
          turnModel={turnModel}
          onApproval={handleApproval}
          surfaceMode={surfaceMode}
          surfaceProfile={surfaceProfile}
          assistantLabel={assistantLabel}
          turnActive={Boolean(currentTurn && activeTurnId && currentTurn === activeTurnId)}
          onOpenWorkspacePath={openWorkspacePath}
          onNavigateSuggestion={handleNavigateSuggestion}
          respondingApprovalIds={respondingApprovalIds}
          pendingApprovalIds={pendingApprovalIds}
        />
      );
    }

    return (
      <EventRow
        key={envelope.key}
        envelope={envelope}
        showTurnDivider={Boolean(showTurnDivider)}
        turnDividerLabel={turnDividerLabel}
        turnModel={turnModel}
        onApproval={handleApproval}
        surfaceMode={surfaceMode}
        surfaceProfile={surfaceProfile}
        assistantLabel={assistantLabel}
        turnActive={Boolean(currentTurn && activeTurnId && currentTurn === activeTurnId)}
        onOpenWorkspacePath={openWorkspacePath}
        onNavigateSuggestion={handleNavigateSuggestion}
        respondingApprovalIds={respondingApprovalIds}
        pendingApprovalIds={pendingApprovalIds}
      />
    );
  }, [activeTurnId, assistantLabel, surfaceMode, surfaceProfile, groupedRows, turnModelState, handleApproval, handleMeasure, openWorkspacePath, handleNavigateSuggestion, respondingApprovalIds, pendingApprovalIds]);

  // Compute the bottom spacer height for virtualized mode.
  const bottomSpacerHeight = useMemo(() => {
    if (!shouldVirtualize) return 0;
    let h = 0;
    for (let i = endIndex; i < groupedRows.length; i++) {
      h += rowHeight(i) + ROW_GAP;
    }
    // The trailing gap accounts for the space between the last rendered row
    // and the first unrendered row — keep it so the total content fills
    // totalHeight exactly (offsetTop already includes the gap before the
    // first rendered row via the offsets array).
    return Math.max(0, h);
  }, [shouldVirtualize, endIndex, groupedRows.length, rowHeight]);

  const streamingIndicator = showStreamingIndicator ? (
    <div className="pt-3 pb-1">
      {latestActivity ? (
        <ActivityIndicator activity={latestActivity.activity} detail={latestActivity.detail} />
      ) : (
        <div className="flex items-center gap-2 py-1 font-mono text-[12px] text-emerald-200/75">
          <ThinkingDots toneClass="bg-emerald-300/75" />
          <span>Working...</span>
        </div>
      )}
    </div>
  ) : null;

  const turnSummaryCard = turnSummary ? (
    <TurnSummaryCard summary={turnSummary} onReviewChanges={turnSummary.files.length > 0 ? handleReviewChanges : undefined} />
  ) : null;

  return (
    <div
      ref={scrollRef}
      className={cn("h-full min-h-0 overflow-auto bg-[#09090b] px-4 pt-5 pb-8", className)}
      onScroll={handleScroll}
    >
      {rows.length === 0 && !streamingIndicator ? (
        <div className="flex h-full flex-col items-center justify-center gap-5">
          <div className="relative flex h-20 w-20 items-center justify-center rounded-full border border-[color:color-mix(in_srgb,var(--chat-accent)_24%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_10%,transparent)]">
            <Robot size={34} weight="thin" className="text-[var(--chat-accent)]" />
            <div className="absolute inset-0 animate-pulse rounded-full bg-[var(--chat-accent-glow)] blur-2xl" />
          </div>
          <div className="space-y-1 text-center">
            <div className="font-sans text-[18px] font-semibold tracking-tight text-fg/78">Start a chat session</div>
            <span className="font-mono text-[10px] uppercase tracking-[2px] text-muted-fg/28">
              {surfaceMode === "resolver" ? "Launch the resolver to start the transcript" : "Start a conversation"}
            </span>
          </div>
        </div>
      ) : shouldVirtualize ? (
        /* ── Virtualized path: only render rows in / near the viewport ── */
        <div className="space-y-3">
          <div style={{ height: totalHeight, position: "relative" }}>
            {/* Top spacer pushes rendered rows to their correct scroll position */}
            <div style={{ height: offsetTop }} aria-hidden />
            <div className="space-y-3">
              {groupedRows.slice(startIndex, Math.min(endIndex, groupedRows.length)).map((envelope, i) =>
                renderRow(envelope, startIndex + i, true)
              )}
            </div>
            {/* Bottom spacer fills remaining scroll area */}
            <div style={{ height: bottomSpacerHeight }} aria-hidden />
          </div>
          {streamingIndicator}
          {turnSummaryCard}
        </div>
      ) : (
        /* ── Non-virtualized path: render all rows (small conversation) ── */
        <div className="space-y-3">
          {groupedRows.map((envelope, index) => renderRow(envelope, index, false))}
          {streamingIndicator}
          {turnSummaryCard}
        </div>
      )}
    </div>
  );
}

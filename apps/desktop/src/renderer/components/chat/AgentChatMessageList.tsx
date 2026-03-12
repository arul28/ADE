import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Brain,
  CaretDown,
  CaretRight,
  Warning,
  Terminal,
  FileCode,
  CheckCircle,
  XCircle,
  SpinnerGap,
  Circle,
  Checks,
  ListChecks,
  User,
  Robot,
  Note,
} from "@phosphor-icons/react";
import type {
  AgentChatApprovalDecision,
  AgentChatEvent,
  AgentChatEventEnvelope,
  ChatSurfaceChipTone,
  ChatSurfaceMode,
} from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
import { cn } from "../ui/cn";
import { formatTime } from "../../lib/format";
import { describeToolIdentifier, replaceInternalToolNames } from "./toolPresentation";
import { chatChipToneClass } from "./chatSurfaceTheme";
import { ChatAttachmentTray } from "./ChatAttachmentTray";
import { getToolMeta } from "./chatToolAppearance";

function formatStructuredValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function summarizeStructuredValue(value: unknown, maxChars = 160): string {
  const text = formatStructuredValue(value).replace(/\s+/g, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function summarizeInlineText(value: string, maxChars = 120): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text.length) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function formatTokenCount(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

const GLASS_CARD_CLASS =
  "overflow-hidden rounded-[var(--chat-radius-card)] border border-white/6 bg-[linear-gradient(180deg,rgba(255,255,255,0.06),rgba(255,255,255,0.025))] shadow-[var(--chat-card-shadow)] backdrop-blur-md";

const RECESSED_BLOCK_CLASS =
  "overflow-auto whitespace-pre-wrap break-words rounded-[calc(var(--chat-radius-card)-6px)] border border-white/6 bg-black/20 px-4 py-3 font-mono text-[11px] leading-[1.55] text-fg/70";

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

function messageCardStyle(accentAlpha = 0.18): React.CSSProperties {
  return {
    borderColor: "color-mix(in srgb, var(--chat-accent) 18%, transparent)",
    background: `linear-gradient(180deg, color-mix(in srgb, var(--chat-accent) ${Math.round(accentAlpha * 100)}%, rgba(255,255,255,0.05)), rgba(255,255,255,0.03))`,
  };
}

function surfaceInlineCardStyle(): React.CSSProperties {
  return {
    borderColor: "color-mix(in srgb, var(--chat-accent) 14%, rgba(255,255,255,0.05))",
    background: "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02))",
  };
}

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

/** Returns " " when two non-empty strings would otherwise butt together without whitespace. */
function textJoinSeparator(a: string, b: string): string {
  if (a.length > 0 && b.length > 0 && !/\s$/.test(a) && !/^\s/.test(b)) return " ";
  return "";
}

function appendCollapsedEvent(out: RenderEnvelope[], envelope: AgentChatEventEnvelope, sequence: number): void {
  const { event } = envelope;

  if (event.type === "step_boundary") {
    return;
  }

  // Activity events are useful for the live streaming indicator, but too noisy
  // to render inline when they carry no useful detail.
  if (event.type === "activity") {
    const detail = summarizeInlineText(event.detail ?? "", 120);
    if (!detail.length && event.activity === "thinking") {
      return;
    }
  }

  if (event.type === "status") {
    const normalizedMessage = summarizeInlineText(event.message ?? "", 120).toLowerCase();
    const keepStatus =
      event.turnStatus === "failed"
      || event.turnStatus === "interrupted"
      || (normalizedMessage.length > 0
        && normalizedMessage !== event.turnStatus.toLowerCase()
        && normalizedMessage !== "started"
        && normalizedMessage !== "completed");
    if (!keepStatus) {
      return;
    }
  }

  const prev = out[out.length - 1];

  if (event.type === "reasoning") {
    const nextTurn = event.turnId ?? null;
    const nextItemId = event.itemId ?? null;
    const nextSummaryIndex = event.summaryIndex ?? null;
    const matchIndex = [...out]
      .reverse()
      .findIndex((candidate) =>
        candidate.event.type === "reasoning"
        && (
          (nextTurn !== null && (candidate.event.turnId ?? null) === nextTurn)
          || (nextItemId !== null && (candidate.event.itemId ?? null) === nextItemId && (candidate.event.summaryIndex ?? null) === nextSummaryIndex)
        ),
      );
    if (matchIndex >= 0) {
      const actualIndex = out.length - 1 - matchIndex;
      const existing = out[actualIndex];
      if (existing?.event.type === "reasoning") {
        const sep = textJoinSeparator(existing.event.text, event.text);
        out[actualIndex] = {
          ...existing,
          timestamp: envelope.timestamp,
          event: {
            ...existing.event,
            text: `${existing.event.text}${sep}${event.text}`
          }
        };
        return;
      }
    }
  }

  if (prev?.event.type === "text" && event.type === "text") {
    const prevTurn = prev.event.turnId ?? null;
    const nextTurn = event.turnId ?? null;
    const prevItem = prev.event.itemId ?? null;
    const nextItem = event.itemId ?? null;
    if (prevTurn === nextTurn && prevItem === nextItem) {
      const sep = textJoinSeparator(prev.event.text, event.text);
      out[out.length - 1] = {
        ...prev,
        timestamp: envelope.timestamp,
        event: {
          ...prev.event,
          text: `${prev.event.text}${sep}${event.text}`
        }
      };
      return;
    }
  }

  if (prev?.event.type === "command" && event.type === "command") {
    const prevTurn = prev.event.turnId ?? null;
    const nextTurn = event.turnId ?? null;
    if (prev.event.itemId === event.itemId && prevTurn === nextTurn) {
      const mergedOutput =
        event.output.length && event.output.startsWith(prev.event.output)
          ? event.output
          : `${prev.event.output}${event.output}`;
      out[out.length - 1] = {
        ...prev,
        timestamp: envelope.timestamp,
        event: {
          ...prev.event,
          output: mergedOutput,
          status: event.status,
          exitCode: event.exitCode ?? prev.event.exitCode,
          durationMs: event.durationMs ?? prev.event.durationMs
        }
      };
      return;
    }
  }

  if (prev?.event.type === "file_change" && event.type === "file_change") {
    const prevTurn = prev.event.turnId ?? null;
    const nextTurn = event.turnId ?? null;
    if (prev.event.itemId === event.itemId && prevTurn === nextTurn && prev.event.path === event.path) {
      const mergedDiff =
        event.diff.length && event.diff.startsWith(prev.event.diff)
          ? event.diff
          : `${prev.event.diff}${event.diff}`;
      out[out.length - 1] = {
        ...prev,
        timestamp: envelope.timestamp,
        event: {
          ...prev.event,
          diff: mergedDiff,
          status: event.status
        }
      };
      return;
    }
  }

  if (event.type === "tool_call") {
    out.push({
      key: `${envelope.sessionId}:${sequence}:${envelope.timestamp}`,
      timestamp: envelope.timestamp,
      event: {
        type: "tool_invocation",
        tool: event.tool,
        args: event.args,
        itemId: event.itemId,
        ...(event.parentItemId ? { parentItemId: event.parentItemId } : {}),
        turnId: event.turnId,
        status: "running",
      },
    });
    return;
  }

  if (event.type === "tool_result") {
    const matchIndex = [...out]
      .reverse()
      .findIndex((candidate) =>
        candidate.event.type === "tool_invocation"
        && candidate.event.itemId === event.itemId
        && candidate.event.tool === event.tool
        && (candidate.event.turnId ?? null) === (event.turnId ?? null),
      );
    if (matchIndex >= 0) {
      const actualIndex = out.length - 1 - matchIndex;
      const existing = out[actualIndex]!;
      if (existing.event.type === "tool_invocation") {
        out[actualIndex] = {
          ...existing,
          timestamp: envelope.timestamp,
          event: {
            ...existing.event,
            result: event.result,
            ...(event.parentItemId ? { parentItemId: event.parentItemId } : {}),
            status: event.status ?? "completed",
          },
        };
        return;
      }
    }
  }

  out.push({
    key: `${envelope.sessionId}:${sequence}:${envelope.timestamp}`,
    timestamp: envelope.timestamp,
    event
  });
}

function collapseEvents(events: AgentChatEventEnvelope[]): RenderEnvelope[] {
  const out: RenderEnvelope[] = [];
  for (let i = 0; i < events.length; i += 1) {
    appendCollapsedEvent(out, events[i]!, i);
  }
  return out;
}

function collapseEventsIncremental(
  events: AgentChatEventEnvelope[],
  prevEvents: AgentChatEventEnvelope[],
  prevRows: RenderEnvelope[],
): RenderEnvelope[] {
  if (!prevEvents.length || events.length < prevEvents.length) {
    return collapseEvents(events);
  }

  // Fast path: most updates append events at the tail during streaming.
  if (events[prevEvents.length - 1] !== prevEvents[prevEvents.length - 1]) {
    return collapseEvents(events);
  }

  const out = prevRows.slice();
  for (let i = prevEvents.length; i < events.length; i += 1) {
    appendCollapsedEvent(out, events[i]!, i);
  }
  return out;
}

/* ── Status indicators ── */

function StatusIcon({ status }: { status: "running" | "completed" | "failed" }) {
  if (status === "completed") return <CheckCircle size={13} weight="bold" className="text-emerald-400" />;
  if (status === "failed") return <XCircle size={13} weight="bold" className="text-red-400" />;
  return <SpinnerGap size={13} weight="bold" className="animate-spin text-accent" />;
}

function PlanStepIcon({ status }: { status: string }) {
  if (status === "completed") return <Checks size={13} weight="bold" className="text-emerald-400" />;
  if (status === "failed") return <XCircle size={13} weight="bold" className="text-red-400" />;
  if (status === "in_progress") return <SpinnerGap size={13} weight="bold" className="animate-spin text-accent" />;
  return <Circle size={11} weight="regular" className="text-muted-fg/40" />;
}

/* ── Markdown renderer ── */

const MarkdownBlock = React.memo(function MarkdownBlock({ markdown }: { markdown: string }) {
  return (
    <div className="prose max-w-none text-[12.5px] leading-[1.68] text-fg/82 prose-headings:mb-2 prose-headings:mt-3 prose-headings:font-sans prose-headings:text-fg/88 prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0 prose-strong:text-fg/92">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => (
            <pre className={cn("my-2.5 max-h-80", RECESSED_BLOCK_CLASS)}>
              {children}
            </pre>
          ),
          code: ({ className, children }) => {
            const text = String(children ?? "");
            const isBlock = /\n/.test(text) || (typeof className === "string" && className.length > 0);
            return isBlock ? (
              <code className="font-mono text-[11px] text-fg/75">{children}</code>
            ) : (
              <code className="rounded-[var(--chat-radius-pill)] border border-white/8 bg-black/20 px-1.5 py-0.5 font-mono text-[11px] text-accent/80">{children}</code>
            );
          },
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-accent underline decoration-accent/30 underline-offset-2 transition-colors hover:text-accent/80 hover:decoration-accent/50"
            >
              {children}
            </a>
          )
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
  summary,
  className
}: {
  children: React.ReactNode;
  defaultOpen?: boolean;
  summary: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cn(GLASS_CARD_CLASS, "transition-colors", className)} style={surfaceInlineCardStyle()}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3.5 py-3 text-left font-mono text-[11px]"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <CaretDown size={10} weight="bold" className="text-muted-fg/60" /> : <CaretRight size={10} weight="bold" className="text-muted-fg/60" />}
        <div className="flex flex-1 flex-wrap items-center gap-2">{summary}</div>
      </button>
      {open ? <div className="border-t border-white/6 px-3.5 pb-3.5 pt-2.5">{children}</div> : null}
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
  editing_file: "Editing",
  running_command: "Running command",
  searching: "Searching",
  reading: "Reading",
  tool_calling: "Calling tool"
};

function ActivityIndicator({ activity, detail }: { activity: string; detail?: string }) {
  const label = ACTIVITY_LABELS[activity] ?? activity;
  const displayText = detail ? `${label}: ${replaceInternalToolNames(detail)}` : `${label}...`;

  return (
    <div className={cn(GLASS_CARD_CLASS, "flex items-center gap-3 px-4 py-3 font-mono text-[11px] text-fg/68")} style={surfaceInlineCardStyle()}>
      <div className="flex h-7 w-7 items-center justify-center rounded-[var(--chat-radius-pill)] border border-white/6 bg-black/15">
        <div className="flex items-center gap-1">
          <span className="h-1 w-1 animate-bounce rounded-full bg-[var(--chat-accent)] [animation-delay:0ms]" />
          <span className="h-1 w-1 animate-bounce rounded-full bg-[var(--chat-accent)] [animation-delay:150ms]" />
          <span className="h-1 w-1 animate-bounce rounded-full bg-[var(--chat-accent)] [animation-delay:300ms]" />
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--chat-accent)]">Live</div>
        <span className="block truncate font-medium">{displayText}</span>
      </div>
    </div>
  );
}

/* ── Tool result card ── */

const TOOL_RESULT_TRUNCATE_LIMIT = 500;

function ToolResultCard({ event }: { event: Extract<AgentChatEvent, { type: "tool_result" }> }) {
  const [expanded, setExpanded] = useState(false);
  const meta = getToolMeta(event.tool);
  const ToolIcon = meta.icon;
  const toolDisplay = describeToolIdentifier(event.tool);
  const sourceChip = toolSourceChip(event.tool);
  const resultStr = formatStructuredValue(event.result);
  const isTruncated = resultStr.length > TOOL_RESULT_TRUNCATE_LIMIT;
  const displayStr = !expanded && isTruncated ? `${resultStr.slice(0, TOOL_RESULT_TRUNCATE_LIMIT)}...` : resultStr;
  const preview = summarizeStructuredValue(event.result, 180);

  return (
    <CollapsibleCard
      defaultOpen={false}
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
            <span className={cn(
              "text-[10px] uppercase tracking-wider",
              event.status === "completed" ? "text-emerald-400/70" : event.status === "failed" ? "text-red-400/70" : "text-accent/70"
            )}>
              {event.status}
            </span>
          ) : null}
        </div>
      }
      className="border-transparent"
    >
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
    if (desc) return `${desc.displayName} (${modelId})`;
    return modelId;
  }
  if (model) {
    const desc = getModelById(model);
    return desc?.displayName ?? model;
  }
  return null;
}

function renderEvent(
  envelope: RenderEnvelope,
  options?: {
    onApproval?: (itemId: string, decision: AgentChatApprovalDecision, responseText?: string | null) => void;
    turnModelLabel?: string | null;
    surfaceMode?: ChatSurfaceMode;
  }
) {
  const event = envelope.event;
  const isResolverMode = options?.surfaceMode === "resolver";

  /* ── User message ── */
  if (event.type === "user_message") {
    const deliveryChip = describeUserDeliveryState(event);
    return (
      <div className="flex justify-end">
        <div className={cn(GLASS_CARD_CLASS, "max-w-[82%] px-4 py-3")} style={messageCardStyle(0.18)}>
          <div className="mb-2 flex items-center gap-2">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--chat-radius-pill)] border border-white/8 bg-black/15">
              <User size={11} weight="bold" className="text-[var(--chat-accent)]" />
            </span>
            <span className="font-mono text-[9px] font-bold uppercase tracking-[1.5px] text-[var(--chat-accent)]">You</span>
            {deliveryChip ? (
              <span className={cn("inline-flex items-center border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-[0.18em]", deliveryChip.className)}>
                {deliveryChip.label}
              </span>
            ) : null}
            <span className="ml-auto font-mono text-[9px] text-muted-fg/25">{formatTime(envelope.timestamp)}</span>
          </div>
          <div className="whitespace-pre-wrap break-words text-[12.5px] leading-[1.65] text-fg/85">{event.text}</div>
          {event.attachments?.length ? (
            <ChatAttachmentTray attachments={event.attachments} mode={options?.surfaceMode ?? "standard"} className="mt-1 px-0 py-0" />
          ) : null}
        </div>
      </div>
    );
  }

  /* ── Agent text ── */
  if (event.type === "text") {
    return (
      <div className="flex justify-start">
        <div className={cn(GLASS_CARD_CLASS, "max-w-[94%] px-4 py-3")} style={surfaceInlineCardStyle()}>
          <div className="mb-2 flex items-center gap-2">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--chat-radius-pill)] border border-white/8 bg-black/15">
              <Robot size={11} weight="bold" className="text-[var(--chat-accent)]" />
            </span>
            <span className="font-mono text-[9px] font-bold uppercase tracking-[1.5px] text-[var(--chat-accent)]">Agent</span>
            <span className="ml-auto font-mono text-[9px] text-muted-fg/20">{formatTime(envelope.timestamp)}</span>
          </div>
          <MarkdownBlock markdown={event.text} />
          {options?.turnModelLabel ? (
            <div className="mt-3 border-t border-white/6 pt-2 font-mono text-[9px] uppercase tracking-[1.4px] text-muted-fg/30">
              {options.turnModelLabel}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  /* ── Command ── */
  if (event.type === "command") {
    const outputTrimmed = event.output.trim();
    const isLong = outputTrimmed.split("\n").length > 12;

    const statusBadgeCls = event.status === "completed"
      ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-400"
      : event.status === "failed"
        ? "border-red-500/25 bg-red-500/10 text-red-400"
        : "border-amber-500/25 bg-amber-500/10 text-amber-400";

    const commandHeader = (
      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
        <span className="inline-flex items-center gap-1 border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-400">
          <Terminal size={11} weight="bold" />
          BASH
        </span>
        <span className="flex-1 truncate text-[10px] text-fg/50">{event.command}</span>
        {event.durationMs != null ? <span className="text-[10px] text-muted-fg/40">{Math.max(0, event.durationMs)}ms</span> : null}
        <span className={cn("border px-1.5 py-0.5 text-[9px] font-bold uppercase", statusBadgeCls)}>
          {event.status === "completed" ? "PASS" : event.status === "failed" ? "FAIL" : "RUN"}
          {event.exitCode != null ? ` ${event.exitCode}` : ""}
        </span>
      </div>
    );

    const commandBody = (
      <>
        <div className="border border-border/10 bg-surface-recessed/90 px-4 py-2.5 font-mono text-[11px] text-fg/80">
          <span className="select-none text-amber-500/40">$ </span>{event.command}
        </div>
        {outputTrimmed.length ? (
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words border border-border/10 bg-surface-recessed/90 px-4 py-2.5 font-mono text-[11px] leading-[1.5] text-fg/60">
            {event.output}
          </pre>
        ) : null}
      </>
    );

    if (isLong) {
      return (
        <CollapsibleCard
          defaultOpen={event.status === "running"}
          summary={commandHeader}
          className="border-amber-500/10"
        >
          {commandBody}
        </CollapsibleCard>
      );
    }

    return (
      <div className={cn(GLASS_CARD_CLASS, "p-3")} style={surfaceInlineCardStyle()}>
        <div className="mb-2">{commandHeader}</div>
        {commandBody}
      </div>
    );
  }

  /* ── File change ── */
  if (event.type === "file_change") {
    const hasDiff = event.diff.trim().length > 0;
    const summary = (
      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
        <span className="inline-flex items-center gap-1 border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-400">
          <FileCode size={11} weight="bold" />
          EDIT
        </span>
        <span className="flex-1 truncate text-[10px] text-emerald-400/60">{event.path}</span>
        <span className="border border-border/15 bg-surface-recessed/90 px-1.5 py-0.5 text-[9px] text-muted-fg/50">{event.kind}</span>
      </div>
    );

    return (
      <CollapsibleCard
        defaultOpen={!hasDiff || event.diff.split("\n").length <= 20}
        summary={summary}
        className="border-transparent"
      >
        {hasDiff ? (
          <DiffPreview diff={event.diff} />
        ) : (
          <div className="font-mono text-[11px] text-muted-fg/40">No diff payload available.</div>
        )}
      </CollapsibleCard>
    );
  }

  /* ── Plan ── */
  if (event.type === "plan") {
    return (
      <div className={cn(GLASS_CARD_CLASS, "p-4")} style={surfaceInlineCardStyle()}>
        <div className="mb-3 flex items-center gap-2">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--chat-radius-pill)] border border-violet-400/18 bg-violet-500/[0.1]">
            <ListChecks size={13} weight="bold" className="text-violet-300/80" />
          </span>
          <span className="font-mono text-[11px] font-bold uppercase tracking-widest text-violet-300/80">Plan</span>
        </div>
        <div className="space-y-1">
          {event.steps.length ? (
            event.steps.map((step, index) => (
              <div key={`${step.text}:${index}`} className="flex items-start gap-2.5 px-2 py-1.5 transition-colors hover:bg-violet-500/[0.03]">
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
          <div className="mt-3 border-t border-violet-500/8 pt-2.5 text-[11px] text-muted-fg/50">{event.explanation}</div>
        ) : null}
      </div>
    );
  }

  /* ── Reasoning ── */
  if (event.type === "reasoning") {
    const reasoningText = event.text.trim();
    const displayReasoning = reasoningText.length > 0 ? event.text : "Thinking...";
    return (
      <CollapsibleCard
        defaultOpen={!isResolverMode}
        summary={
          <div className="flex items-center gap-2 font-mono text-[11px]">
            <span className="inline-flex h-5 w-5 items-center justify-center border border-violet-500/18 bg-violet-500/[0.08]">
              <Brain size={10} weight="bold" className="text-violet-300/75" />
            </span>
            <span className="font-bold uppercase tracking-[0.16em] text-violet-300/75">Reasoning</span>
          </div>
        }
        className="border-transparent"
      >
        <div className="text-fg/65">
          <MarkdownBlock markdown={displayReasoning} />
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
    const sourceChip = toolSourceChip(event.tool);
    const args = readRecord(event.args) ?? {};
    const resultText = event.result === undefined ? null : formatStructuredValue(event.result);
    const targetLine = meta.getTarget ? meta.getTarget(args) : null;
    const secondaryLabel = targetLine ?? toolDisplay.secondaryLabel;
    const argCount = Object.keys(args).length;

    return (
      <CollapsibleCard
        defaultOpen={event.status === "failed"}
        summary={
          <div className="flex items-center gap-2 font-mono text-[11px]">
            <StatusIcon status={event.status} />
            <span className={cn("inline-flex items-center gap-1 border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider", meta.badgeCls)}>
              <ToolIcon size={11} weight="bold" />
              {meta.label}
            </span>
            {sourceChip ? (
              <span className={cn("inline-flex items-center border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.16em]", chatChipToneClass(sourceChip.tone))}>
                {sourceChip.label}
              </span>
            ) : null}
            {secondaryLabel ? <span className="flex-1 truncate text-[10px] text-fg/45">{secondaryLabel}</span> : null}
            {event.parentItemId ? (
              <span className="border border-violet-500/18 bg-violet-500/[0.08] px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.16em] text-violet-300/80">
                subagent
              </span>
            ) : null}
            <span className="text-[9px] uppercase tracking-[0.16em] text-muted-fg/30">
              {event.status}
              {argCount ? ` · ${argCount} arg${argCount === 1 ? "" : "s"}` : ""}
            </span>
          </div>
        }
        className={cn(
          "border-accent/10",
          event.parentItemId ? "ml-5 border-violet-500/12" : null,
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
              <div className="rounded-[calc(var(--chat-radius-card)-6px)] border border-white/6 bg-black/20 px-4 py-2 font-mono text-[10px] text-muted-fg/40">
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
    const sourceChip = toolSourceChip(event.tool);
    const args = event.args as Record<string, unknown> | null;
    const safeArgs = args && typeof args === "object" ? args : {};

    const targetLine = meta.getTarget ? meta.getTarget(safeArgs) : null;
    const secondaryLabel = targetLine ?? toolDisplay.secondaryLabel;
    const argCount = Object.keys(safeArgs).length;

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

    const cardBorderCls =
      meta.category === "exec" || meta.category === "codex"
        ? "border-amber-500/10"
        : meta.category === "write"
          ? "border-emerald-500/10"
          : meta.category === "web"
            ? "border-indigo-500/10"
            : "border-accent/10";

    return (
      <CollapsibleCard
        defaultOpen={false}
        summary={
          <div className="flex items-center gap-2 font-mono text-[11px]">
            <span className={cn("inline-flex items-center gap-1 border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider", meta.badgeCls)}>
              <ToolIcon size={11} weight="bold" />
              {meta.label}
            </span>
            {sourceChip ? (
              <span className={cn("inline-flex items-center border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.16em]", chatChipToneClass(sourceChip.tone))}>
                {sourceChip.label}
              </span>
            ) : null}
            {secondaryLabel ? (
              <span className="flex-1 truncate text-[10px] text-fg/45">{secondaryLabel}</span>
            ) : null}
            <span className="text-[9px] uppercase tracking-[0.16em] text-muted-fg/30">
              {argCount} arg{argCount === 1 ? "" : "s"}
            </span>
          </div>
        }
        className={cardBorderCls}
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
    const detail = readRecord(event.detail);
    const detailTool = typeof detail?.tool === "string" ? detail.tool.trim() : "";
    const question = typeof detail?.question === "string" ? detail.question.trim() : "";
    const normalizedTool = detailTool.toLowerCase();
    const isAskUser = (normalizedTool === "askuser" || normalizedTool === "ask_user") && question.length > 0;
    const detailText = event.detail == null || isAskUser ? "" : formatStructuredValue(event.detail);
    return (
      <div className={cn(GLASS_CARD_CLASS, "p-4")} style={surfaceInlineCardStyle()}>
        <div className="mb-2 flex items-center gap-2">
          <Warning size={13} weight="bold" className="text-amber-500" />
          <span className="font-mono text-[11px] font-bold uppercase tracking-widest text-fg/85">
            {isAskUser ? "Needs Input" : "Approval Required"}
          </span>
          <span className="font-mono text-[10px] text-muted-fg/40">{event.kind}</span>
        </div>
        <div className="text-[12px] leading-relaxed text-fg/75">{isAskUser ? question : event.description}</div>
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
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              className="border border-accent/40 bg-accent/15 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-fg transition-colors hover:bg-accent/25"
              onClick={() => handleApproval("accept")}
            >
              Accept
            </button>
            <button
              type="button"
              className="border border-accent/20 bg-transparent px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-fg/70 transition-colors hover:bg-accent/10"
              onClick={() => handleApproval("accept_for_session")}
            >
              Accept All
            </button>
            <button
              type="button"
              className="border border-border/25 bg-transparent px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-fg/50 transition-colors hover:bg-border/15"
              onClick={() => handleApproval("decline")}
            >
              Decline
            </button>
            <button
              type="button"
              className="border border-border/25 bg-transparent px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-fg/50 transition-colors hover:bg-border/15"
              onClick={() => handleApproval("cancel")}
            >
              Dismiss
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  /* ── Error ── */
  if (event.type === "error") {
    return (
      <div className={cn(GLASS_CARD_CLASS, "border-red-500/12 p-4")} style={surfaceInlineCardStyle()}>
        <div className="mb-2 flex items-center gap-2">
          <Warning size={13} weight="bold" className="text-red-500" />
          <span className="font-mono text-[11px] font-bold uppercase tracking-widest text-fg/85">Error</span>
        </div>
        <div className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-fg/80">{event.message}</div>
        {event.errorInfo ? (
          <div className="mt-2 font-mono text-[10px] text-muted-fg/40">
            {typeof event.errorInfo === "string" ? event.errorInfo : `[${event.errorInfo.category}]${event.errorInfo.provider ? ` ${event.errorInfo.provider}` : ""}${event.errorInfo.model ? ` / ${event.errorInfo.model}` : ""}`}
          </div>
        ) : null}
      </div>
    );
  }

  /* ── Activity ── */
  if (event.type === "activity") {
    return <ActivityIndicator activity={event.activity} detail={event.detail} />;
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

  /* ── Done ── */
  if (event.type === "done") {
    const modelLabel = resolveModelLabel(event.modelId, event.model);
    const inputTokens = formatTokenCount(event.usage?.inputTokens);
    const outputTokens = formatTokenCount(event.usage?.outputTokens);
    const statusTone = event.status === "completed"
      ? "border-border/12 bg-surface-recessed/55 text-fg/52"
      : event.status === "failed"
        ? "border-red-500/15 bg-red-500/[0.05] text-red-300"
        : "border-amber-500/15 bg-amber-500/[0.05] text-amber-300";

    return (
      <div className={cn("flex flex-wrap items-center gap-2 rounded-[var(--chat-radius-pill)] border px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.16em]", statusTone)}>
        <span className="inline-flex items-center gap-1 border border-border/15 bg-surface/50 px-1.5 py-0.5 text-[8px] font-bold tracking-[0.18em] text-fg/55">
          Usage
        </span>
        {modelLabel ? <span className="text-[9px] text-fg/45">{modelLabel}</span> : null}
        {inputTokens ? <span className="text-[9px] text-fg/40">In {inputTokens}</span> : null}
        {outputTokens ? <span className="text-[9px] text-fg/40">Out {outputTokens}</span> : null}
        {event.status !== "completed" ? (
          <span className="ml-auto text-[8px] text-current">{event.status}</span>
        ) : null}
      </div>
    );
  }

  /* ── Fallback ── */
  return (
    <div className="flex items-center gap-3 py-0.5">
      <div className="h-px flex-1 bg-white/6" />
      <span className="rounded-[var(--chat-radius-pill)] border border-white/6 px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-[2px] text-muted-fg/25">event</span>
      <div className="h-px flex-1 bg-white/6" />
    </div>
  );
}

function deriveLatestActivity(events: AgentChatEventEnvelope[]): { activity: string; detail?: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i]!.event;
    if (evt.type === "activity") return { activity: evt.activity, detail: evt.detail };
    if (evt.type === "done" || evt.type === "status") return null;
  }
  return null;
}

/* ── Main component ── */

type EventRowProps = {
  envelope: RenderEnvelope;
  showTurnDivider: boolean;
  turnDividerLabel: string | null;
  turnModelLabel: string | null;
  onApproval?: (itemId: string, decision: AgentChatApprovalDecision, responseText?: string | null) => void;
  surfaceMode?: ChatSurfaceMode;
};

const EventRow = React.memo(function EventRow({
  envelope,
  showTurnDivider,
  turnDividerLabel,
  turnModelLabel,
  onApproval,
  surfaceMode = "standard",
}: EventRowProps) {
  return (
    <div className="space-y-3">
      {showTurnDivider && turnDividerLabel ? (
        <div className="flex items-center gap-3 py-2">
          <div className="h-px flex-1 bg-[color:color-mix(in_srgb,var(--chat-accent)_20%,transparent)]" />
          <span className="rounded-[var(--chat-radius-pill)] border border-[color:color-mix(in_srgb,var(--chat-accent)_18%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_10%,transparent)] px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.22em] text-[color:color-mix(in_srgb,var(--chat-accent)_84%,white_16%)]">
            {turnDividerLabel}
          </span>
          <div className="h-px flex-1 bg-[color:color-mix(in_srgb,var(--chat-accent)_20%,transparent)]" />
        </div>
      ) : null}
      {renderEvent(envelope, { onApproval, turnModelLabel, surfaceMode })}
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

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    // Report the actual rendered height (including margin from space-y-3 = 12px gap).
    const height = el.offsetHeight;
    if (height > 0) onMeasure(index, height);
  });

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

export function AgentChatMessageList({
  events,
  showStreamingIndicator = false,
  className,
  onApproval,
  surfaceMode = "standard",
}: {
  events: AgentChatEventEnvelope[];
  showStreamingIndicator?: boolean;
  className?: string;
  onApproval?: (itemId: string, decision: AgentChatApprovalDecision, responseText?: string | null) => void;
  surfaceMode?: ChatSurfaceMode;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const collapseCacheRef = useRef<{ events: AgentChatEventEnvelope[]; rows: RenderEnvelope[] }>({
    events: [],
    rows: [],
  });
  const [stickToBottom, setStickToBottom] = useState(true);
  const stickToBottomRef = useRef(true);
  const onApprovalRef = useRef(onApproval);

  // Virtualization scroll tracking
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  // Map of row index → measured height (filled in lazily as rows render)
  const measuredHeights = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    onApprovalRef.current = onApproval;
  }, [onApproval]);

  const handleApproval = useCallback((itemId: string, decision: AgentChatApprovalDecision, responseText?: string | null) => {
    onApprovalRef.current?.(itemId, decision, responseText);
  }, []);

  const rows = useMemo(() => {
    const cached = collapseCacheRef.current;
    const nextRows = collapseEventsIncremental(events, cached.events, cached.rows);
    collapseCacheRef.current = { events, rows: nextRows };
    return nextRows;
  }, [events]);
  const latestActivity = useMemo(() => (showStreamingIndicator ? deriveLatestActivity(events) : null), [events, showStreamingIndicator]);
  const latestRowIsActivity = rows[rows.length - 1]?.event.type === "activity";

  const turnModelLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const envelope of events) {
      const evt = envelope.event;
      if (evt.type !== "done") continue;
      const modelLabel = resolveModelLabel(evt.modelId, evt.model);
      if (!evt.turnId || !modelLabel) continue;
      map.set(evt.turnId, modelLabel);
    }
    return map;
  }, [events]);

  useEffect(() => {
    stickToBottomRef.current = stickToBottom;
  }, [stickToBottom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [rows, stickToBottom]);

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

  /** Returns the best-known height for a given row index. */
  const rowHeight = useCallback((index: number) => {
    return measuredHeights.current.get(index) ?? ESTIMATED_ROW_HEIGHT;
  }, []);

  /** Callback from MeasuredEventRow when it measures its real DOM height. */
  const handleMeasure = useCallback((index: number, height: number) => {
    const prev = measuredHeights.current.get(index);
    if (prev !== height) {
      measuredHeights.current.set(index, height);
    }
  }, []);

  const shouldVirtualize = rows.length >= VIRTUALIZATION_THRESHOLD;

  // Compute the visible window of rows when virtualization is active.
  const { startIndex, endIndex, totalHeight, offsetTop } = useMemo(() => {
    if (!shouldVirtualize) {
      return { startIndex: 0, endIndex: rows.length, totalHeight: 0, offsetTop: 0 };
    }

    // Build cumulative offset array for each row's top position.
    let cumulative = 0;
    const offsets: number[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      offsets[i] = cumulative;
      cumulative += rowHeight(i) + ROW_GAP;
    }
    const totalH = cumulative - (rows.length > 0 ? ROW_GAP : 0); // last row has no trailing gap

    // Determine visible range from scrollTop / containerHeight.
    const viewTop = scrollTop;
    const viewBottom = scrollTop + containerHeight;

    // Binary search for the first row visible.
    let lo = 0;
    let hi = rows.length - 1;
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

    // Walk forward to find the last visible row.
    let lastVisible = firstVisible;
    while (lastVisible < rows.length - 1 && offsets[lastVisible + 1]! < viewBottom) {
      lastVisible++;
    }

    // Apply overscan
    const start = Math.max(0, firstVisible - OVERSCAN);
    const end = Math.min(rows.length, lastVisible + 1 + OVERSCAN);

    return {
      startIndex: start,
      endIndex: end,
      totalHeight: totalH,
      offsetTop: offsets[start] ?? 0,
    };
  }, [shouldVirtualize, rows.length, scrollTop, containerHeight, rowHeight]);

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
  const renderRow = useCallback((envelope: RenderEnvelope, index: number, virtualized: boolean) => {
    const currentTurn = "turnId" in envelope.event ? envelope.event.turnId ?? null : null;
    const previous = rows[index - 1];
    const previousTurn = previous && "turnId" in previous.event ? previous.event.turnId ?? null : null;
    const showTurnDivider = currentTurn && currentTurn !== previousTurn;
    const turnDividerLabel = showTurnDivider
      ? formatTime(envelope.timestamp)
      : null;
    const turnModelLabel = currentTurn ? (turnModelLabelMap.get(currentTurn) ?? null) : null;

    if (virtualized) {
      return (
        <MeasuredEventRow
          key={envelope.key}
          index={index}
          onMeasure={handleMeasure}
          envelope={envelope}
          showTurnDivider={Boolean(showTurnDivider)}
          turnDividerLabel={turnDividerLabel}
          turnModelLabel={turnModelLabel}
          onApproval={handleApproval}
          surfaceMode={surfaceMode}
        />
      );
    }

    return (
      <EventRow
        key={envelope.key}
        envelope={envelope}
        showTurnDivider={Boolean(showTurnDivider)}
        turnDividerLabel={turnDividerLabel}
        turnModelLabel={turnModelLabel}
        onApproval={handleApproval}
        surfaceMode={surfaceMode}
      />
    );
  }, [surfaceMode, rows, turnModelLabelMap, handleApproval, handleMeasure]);

  // Compute the bottom spacer height for virtualized mode.
  const bottomSpacerHeight = useMemo(() => {
    if (!shouldVirtualize) return 0;
    let h = 0;
    for (let i = endIndex; i < rows.length; i++) {
      h += rowHeight(i) + ROW_GAP;
    }
    // Remove trailing gap
    if (rows.length > endIndex) h -= ROW_GAP;
    return Math.max(0, h);
  }, [shouldVirtualize, endIndex, rows.length, rowHeight]);

  const streamingIndicator = showStreamingIndicator && !latestRowIsActivity ? (
    latestActivity ? (
      <ActivityIndicator activity={latestActivity.activity} detail={latestActivity.detail} />
    ) : (
      <div className={cn(GLASS_CARD_CLASS, "flex items-center gap-3 px-4 py-3 font-mono text-[11px] text-fg/65")} style={surfaceInlineCardStyle()}>
        <div className="flex h-7 w-7 items-center justify-center rounded-[var(--chat-radius-pill)] border border-white/6 bg-black/15">
          <div className="flex items-center gap-1">
            <span className="h-1 w-1 animate-bounce rounded-full bg-[var(--chat-accent)] [animation-delay:0ms]" />
            <span className="h-1 w-1 animate-bounce rounded-full bg-[var(--chat-accent)] [animation-delay:150ms]" />
            <span className="h-1 w-1 animate-bounce rounded-full bg-[var(--chat-accent)] [animation-delay:300ms]" />
          </div>
        </div>
        <div>
          <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--chat-accent)]">Streaming</div>
          <span className="font-medium">Response in progress…</span>
        </div>
      </div>
    )
  ) : null;

  return (
    <div
      ref={scrollRef}
      className={cn("h-full overflow-auto px-4 py-5", className)}
      onScroll={handleScroll}
    >
      {rows.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-5">
          <div className="relative flex h-20 w-20 items-center justify-center rounded-full border border-[color:color-mix(in_srgb,var(--chat-accent)_24%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_10%,transparent)]">
            <Robot size={34} weight="thin" className="text-[var(--chat-accent)]" />
            <div className="absolute inset-0 animate-pulse rounded-full bg-[var(--chat-accent-glow)] blur-2xl" />
          </div>
          <div className="space-y-1 text-center">
            <div className="font-sans text-[18px] font-semibold tracking-tight text-fg/78">Chat feels alive here now.</div>
            <span className="font-mono text-[10px] uppercase tracking-[2px] text-muted-fg/28">
              {surfaceMode === "resolver" ? "Launch the resolver to start the transcript" : "Start a conversation"}
            </span>
          </div>
        </div>
      ) : shouldVirtualize ? (
        /* ── Virtualized path: only render rows in / near the viewport ── */
        <div style={{ height: totalHeight, position: "relative" }}>
          {/* Top spacer pushes rendered rows to their correct scroll position */}
          <div style={{ height: offsetTop }} aria-hidden />
          <div className="space-y-3">
            {rows.slice(startIndex, endIndex).map((envelope, i) =>
              renderRow(envelope, startIndex + i, true)
            )}
          </div>
          {/* Bottom spacer fills remaining scroll area */}
          <div style={{ height: bottomSpacerHeight }} aria-hidden />
          {streamingIndicator}
        </div>
      ) : (
        /* ── Non-virtualized path: render all rows (small conversation) ── */
        <div className="space-y-3">
          {rows.map((envelope, index) => renderRow(envelope, index, false))}
          {streamingIndicator}
        </div>
      )}
    </div>
  );
}

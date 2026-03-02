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
  Wrench,
  CheckCircle,
  XCircle,
  SpinnerGap,
  Circle,
  Checks,
  ListChecks,
  User,
  Robot
} from "@phosphor-icons/react";
import type { AgentChatApprovalDecision, AgentChatEvent, AgentChatEventEnvelope } from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
import { cn } from "../ui/cn";
import { formatTime } from "../../lib/format";

type RenderEnvelope = {
  key: string;
  timestamp: string;
  event: AgentChatEvent;
};

function appendCollapsedEvent(out: RenderEnvelope[], envelope: AgentChatEventEnvelope, sequence: number): void {
  const { event } = envelope;
  const prev = out[out.length - 1];

  if (prev?.event.type === "text" && event.type === "text") {
    const prevTurn = prev.event.turnId ?? null;
    const nextTurn = event.turnId ?? null;
    const prevItem = prev.event.itemId ?? null;
    const nextItem = event.itemId ?? null;
    if (prevTurn === nextTurn && prevItem === nextItem) {
      out[out.length - 1] = {
        ...prev,
        timestamp: envelope.timestamp,
        event: {
          ...prev.event,
          text: `${prev.event.text}${event.text}`
        }
      };
      return;
    }
  }

  if (prev?.event.type === "reasoning" && event.type === "reasoning") {
    const prevTurn = prev.event.turnId ?? null;
    const nextTurn = event.turnId ?? null;
    const prevItem = prev.event.itemId ?? null;
    const nextItem = event.itemId ?? null;
    if (prevTurn === nextTurn && prevItem === nextItem) {
      out[out.length - 1] = {
        ...prev,
        timestamp: envelope.timestamp,
        event: {
          ...prev.event,
          text: `${prev.event.text}${event.text}`
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

function StatusDot({ status }: { status: "running" | "completed" | "failed" }) {
  if (status === "completed") return <span className="inline-block h-1.5 w-1.5 bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.4)]" />;
  if (status === "failed") return <span className="inline-block h-1.5 w-1.5 bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.4)]" />;
  return <span className="inline-block h-1.5 w-1.5 animate-pulse bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.4)]" />;
}

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
    <div className="prose ade-prose-themed max-w-none text-[12.5px] leading-[1.65] prose-headings:mb-2 prose-headings:mt-3 prose-headings:font-sans prose-headings:text-fg/90 prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => (
            <pre className="my-2.5 overflow-auto border border-border/25 bg-[#0C0A10] px-4 py-3 font-mono text-[11px] leading-[1.6] text-fg/75">
              {children}
            </pre>
          ),
          code: ({ className, children }) => {
            const text = String(children ?? "");
            const isBlock = /\n/.test(text) || (typeof className === "string" && className.length > 0);
            return isBlock ? (
              <code className="font-mono text-[11px] text-fg/75">{children}</code>
            ) : (
              <code className="border border-border/20 bg-[#0C0A10] px-1.5 py-0.5 font-mono text-[11px] text-accent/80">{children}</code>
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
    <div className={cn("border transition-colors", className)}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-[11px]"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <CaretDown size={10} weight="bold" className="text-muted-fg/60" /> : <CaretRight size={10} weight="bold" className="text-muted-fg/60" />}
        <div className="flex flex-1 flex-wrap items-center gap-2">{summary}</div>
      </button>
      {open ? <div className="border-t border-border/15 px-3 pb-3 pt-2">{children}</div> : null}
    </div>
  );
}

/* ── Diff preview ── */

function DiffPreview({ diff }: { diff: string }) {
  const lines = diff.split(/\r?\n/);
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border border-border/15 bg-[#0C0A10] px-4 py-3 font-mono text-[11px] leading-[1.6] text-fg/70">
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
  const displayText = detail ? `${label}: ${detail}` : `${label}...`;

  return (
    <div className="flex items-center gap-3 border-l-2 border-l-accent/30 bg-gradient-to-r from-accent/[0.04] to-transparent px-4 py-2.5 font-mono text-[11px] text-fg/60">
      <div className="flex items-center gap-1">
        <span className="h-1 w-1 animate-bounce bg-accent/70 [animation-delay:0ms]" />
        <span className="h-1 w-1 animate-bounce bg-accent/70 [animation-delay:150ms]" />
        <span className="h-1 w-1 animate-bounce bg-accent/70 [animation-delay:300ms]" />
      </div>
      <span className="truncate font-medium">{displayText}</span>
    </div>
  );
}

/* ── Tool result card ── */

const TOOL_RESULT_TRUNCATE_LIMIT = 500;

function ToolResultCard({ event }: { event: Extract<AgentChatEvent, { type: "tool_result" }> }) {
  const [expanded, setExpanded] = useState(false);
  const resultStr = typeof event.result === "string" ? event.result : JSON.stringify(event.result, null, 2);
  const isTruncated = resultStr.length > TOOL_RESULT_TRUNCATE_LIMIT;
  const displayStr = !expanded && isTruncated ? `${resultStr.slice(0, TOOL_RESULT_TRUNCATE_LIMIT)}...` : resultStr;

  return (
    <CollapsibleCard
      defaultOpen={false}
      summary={
        <div className="flex items-center gap-2 font-mono text-[11px]">
          <StatusIcon status={event.status ?? "completed"} />
          <span className="font-bold text-fg/75">{event.tool}</span>
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
      className="border-border/10 bg-gradient-to-r from-surface/30 to-transparent"
    >
      <pre
        className="max-h-52 overflow-auto whitespace-pre-wrap break-words border border-border/10 bg-[#0C0A10] px-4 py-3 font-mono text-[11px] text-fg/65"
      >
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
    onApproval?: (itemId: string, decision: AgentChatApprovalDecision) => void;
    turnModelLabel?: string | null;
  }
) {
  const event = envelope.event;

  /* ── User message ── */
  if (event.type === "user_message") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] bg-gradient-to-l from-accent/[0.10] via-accent/[0.05] to-transparent px-4 py-3">
          <div className="mb-1.5 flex items-center gap-2">
            <User size={11} weight="bold" className="text-accent/50" />
            <span className="font-mono text-[9px] font-bold uppercase tracking-[1.5px] text-accent/45">You</span>
            <span className="ml-auto font-mono text-[9px] text-muted-fg/30">{formatTime(envelope.timestamp)}</span>
          </div>
          <div className="whitespace-pre-wrap break-words text-[12.5px] leading-[1.6] text-fg/90">{event.text}</div>
          {event.attachments?.length ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {event.attachments.map((attachment, index) => (
                <span key={`${attachment.path}:${index}`} className="inline-flex items-center gap-1 bg-accent/[0.06] px-2 py-0.5 font-mono text-[9px] text-fg/50">
                  {attachment.type}: {attachment.path}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  /* ── Agent text ── */
  if (event.type === "text") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[92%] border-l-2 border-l-accent/20 pl-4 py-3">
          <div className="mb-1.5 flex items-center gap-2">
            <Robot size={11} weight="bold" className="text-accent/40" />
            <span className="font-mono text-[9px] font-bold uppercase tracking-[1.5px] text-accent/35">Agent</span>
            <span className="ml-auto font-mono text-[9px] text-muted-fg/30">{formatTime(envelope.timestamp)}</span>
          </div>
          <MarkdownBlock markdown={event.text} />
          {options?.turnModelLabel ? (
            <div className="mt-2 border-t border-accent/10 pt-1.5 font-mono text-[9px] uppercase tracking-[1.4px] text-muted-fg/35">
              Model · {options.turnModelLabel}
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
        <div className="border border-border/10 bg-[#0C0A10] px-4 py-2.5 font-mono text-[11px] text-fg/80">
          <span className="select-none text-amber-500/40">$ </span>{event.command}
        </div>
        {outputTrimmed.length ? (
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words border border-border/10 bg-[#0C0A10] px-4 py-2.5 font-mono text-[11px] leading-[1.5] text-fg/60">
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
          className="border-amber-500/8 bg-gradient-to-r from-amber-500/[0.03] to-transparent shadow-[0_0_24px_-12px_rgba(245,158,11,0.06)]"
        >
          {commandBody}
        </CollapsibleCard>
      );
    }

    return (
      <div className="border border-amber-500/8 bg-gradient-to-r from-amber-500/[0.03] to-transparent p-3 shadow-[0_0_24px_-12px_rgba(245,158,11,0.06)]">
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
        <span className="border border-border/15 bg-[#0C0A10] px-1.5 py-0.5 text-[9px] text-muted-fg/50">{event.kind}</span>
      </div>
    );

    return (
      <CollapsibleCard
        defaultOpen={!hasDiff || event.diff.split("\n").length <= 20}
        summary={summary}
        className="border-emerald-500/8 bg-gradient-to-r from-emerald-500/[0.03] to-transparent shadow-[0_0_24px_-12px_rgba(16,185,129,0.06)]"
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
      <div className="border border-violet-500/8 bg-gradient-to-r from-violet-500/[0.04] to-transparent p-4 shadow-[0_0_24px_-12px_rgba(139,92,246,0.08)]">
        <div className="mb-3 flex items-center gap-2">
          <ListChecks size={13} weight="bold" className="text-violet-400/60" />
          <span className="font-mono text-[11px] font-bold uppercase tracking-widest text-violet-400/60">Plan</span>
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
    return (
      <CollapsibleCard
        defaultOpen={false}
        summary={
          <div className="flex items-center gap-2 font-mono text-[11px]">
            <Brain size={13} weight="bold" className="text-purple-400/50" />
            <span className="font-bold text-purple-400/60">thinking</span>
          </div>
        }
        className="border-purple-500/8 bg-gradient-to-r from-purple-500/[0.03] to-transparent"
      >
        <div className="text-fg/70">
          <MarkdownBlock markdown={event.text} />
        </div>
      </CollapsibleCard>
    );
  }

  /* ── Step boundary ── */
  if (event.type === "step_boundary") {
    return (
      <div className="flex items-center gap-3 py-1">
        <div className="h-px flex-1 bg-border/10" />
        <span className="font-mono text-[9px] font-bold uppercase tracking-[2px] text-muted-fg/30">Step {event.stepNumber}</span>
        <div className="h-px flex-1 bg-border/10" />
      </div>
    );
  }

  /* ── Tool call ── */
  if (event.type === "tool_call") {
    const toolName = event.tool;
    const args = event.args as Record<string, unknown> | null;

    // Determine badge color and label based on tool type
    const isRead = toolName === "readFile" || toolName === "Read" || toolName === "grep" || toolName === "Grep" || toolName === "glob" || toolName === "Glob";
    const isBash = toolName === "bash" || toolName === "Bash";
    const isEdit = toolName === "editFile" || toolName === "Edit" || toolName === "writeFile" || toolName === "Write";

    const badgeLabel = isBash ? "BASH" : isRead ? "READ" : isEdit ? "EDIT" : toolName.toUpperCase();
    const badgeCls = isBash
      ? "border-amber-500/20 bg-amber-500/10 text-amber-400"
      : isRead
        ? "border-cyan-500/20 bg-cyan-500/10 text-cyan-400"
        : isEdit
          ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
          : "border-accent/20 bg-accent/10 text-accent";
    const BadgeIcon = isBash ? Terminal : isRead ? FileCode : isEdit ? FileCode : Wrench;

    // Build the target/description line
    let targetLine: string | null = null;
    if (isBash) {
      targetLine = args && typeof args === "object" && "command" in args ? String(args.command) : null;
    } else if (isRead) {
      targetLine = args && typeof args === "object"
        ? ("file_path" in args ? String(args.file_path) : "path" in args ? String(args.path) : "pattern" in args ? String(args.pattern) : null)
        : null;
    } else if (isEdit) {
      targetLine = args && typeof args === "object" && "file_path" in args ? String(args.file_path) : null;
    }

    let argsDisplay: React.ReactNode;
    if (targetLine) {
      const extraPairs = args && typeof args === "object"
        ? Object.entries(args).filter(([k]) => !["command", "file_path", "path", "pattern"].includes(k))
        : [];
      argsDisplay = (
        <div className="border border-border/10 bg-[#0C0A10] px-4 py-2.5 font-mono text-[11px] text-fg/80">
          {isBash ? (
            <span className="flex items-center gap-1.5">
              <span className="select-none text-muted-fg/30">$ </span>
              <span>{targetLine}</span>
            </span>
          ) : (
            <div className="text-accent/70">{targetLine}</div>
          )}
          {extraPairs.length > 0 ? (
            <div className="mt-1 text-muted-fg/50">
              {extraPairs.map(([k, v]) => (
                <span key={k} className="mr-2">{k}=<span className="text-fg/60">{String(v)}</span></span>
              ))}
            </div>
          ) : null}
        </div>
      );
    } else {
      const kvPairs = args && typeof args === "object" ? Object.entries(args) : [];
      argsDisplay = kvPairs.length > 0 ? (
        <div className="border border-border/10 bg-[#0C0A10] px-4 py-2.5 font-mono text-[11px] text-fg/60">
          {kvPairs.map(([k, v]) => {
            const val = typeof v === "string" ? v : JSON.stringify(v);
            const truncated = val && val.length > 200 ? `${val.slice(0, 200)}...` : val;
            return (
              <div key={k} className="py-0.5">
                <span className="text-muted-fg/40">{k}</span>=<span className="text-fg/60">{truncated}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words border border-border/10 bg-[#0C0A10] px-4 py-2.5 font-mono text-[11px] text-fg/60">
          {JSON.stringify(args, null, 2)}
        </pre>
      );
    }

    return (
      <CollapsibleCard
        defaultOpen={false}
        summary={
          <div className="flex items-center gap-2 font-mono text-[11px]">
            <span className={cn("inline-flex items-center gap-1 border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider", badgeCls)}>
              <BadgeIcon size={11} weight="bold" />
              {badgeLabel}
            </span>
            {targetLine ? (
              <span className="flex-1 truncate text-[10px] text-fg/50">{targetLine}</span>
            ) : null}
          </div>
        }
        className="border-border/10 bg-gradient-to-r from-surface/40 to-transparent"
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
    return (
      <div className="border border-amber-500/15 bg-gradient-to-r from-amber-500/[0.06] to-transparent p-4 shadow-[0_0_24px_-8px_rgba(245,158,11,0.1)]">
        <div className="mb-2 flex items-center gap-2">
          <Warning size={13} weight="bold" className="text-amber-500" />
          <span className="font-mono text-[11px] font-bold uppercase tracking-widest text-fg/85">Approval Required</span>
          <span className="font-mono text-[10px] text-muted-fg/40">{event.kind}</span>
        </div>
        <div className="text-[12px] leading-relaxed text-fg/75">{event.description}</div>
        {handleApproval ? (
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
      <div className="border border-red-500/15 bg-gradient-to-r from-red-500/[0.05] to-transparent p-4 shadow-[0_0_24px_-8px_rgba(239,68,68,0.08)]">
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
    return (
      <div className="flex items-center gap-3 py-0.5">
        <div className="h-px flex-1 bg-border/10" />
        <span className="font-mono text-[9px] font-bold uppercase tracking-[2px] text-muted-fg/30">
          {event.turnStatus}
          {event.message ? ` — ${event.message}` : ""}
        </span>
        <div className="h-px flex-1 bg-border/10" />
      </div>
    );
  }

  /* ── Done / fallback ── */
  return (
    <div className="flex items-center gap-3 py-0.5">
      <div className="h-px flex-1 bg-border/10" />
      <span className="font-mono text-[9px] font-bold uppercase tracking-[2px] text-muted-fg/25">{event.status}</span>
      <div className="h-px flex-1 bg-border/10" />
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
  onApproval?: (itemId: string, decision: AgentChatApprovalDecision) => void;
};

const EventRow = React.memo(function EventRow({
  envelope,
  showTurnDivider,
  turnDividerLabel,
  turnModelLabel,
  onApproval,
}: EventRowProps) {
  return (
    <div className="space-y-2">
      {showTurnDivider && turnDividerLabel ? (
        <div className="flex items-center gap-3 py-2">
          <div className="h-px flex-1 bg-accent/8" />
          <span className="font-mono text-[9px] font-bold uppercase tracking-[2px] text-accent/25">
            {turnDividerLabel}
          </span>
          <div className="h-px flex-1 bg-accent/8" />
        </div>
      ) : null}
      {renderEvent(envelope, { onApproval, turnModelLabel })}
    </div>
  );
});

export function AgentChatMessageList({
  events,
  showStreamingIndicator = false,
  className,
  onApproval
}: {
  events: AgentChatEventEnvelope[];
  showStreamingIndicator?: boolean;
  className?: string;
  onApproval?: (itemId: string, decision: AgentChatApprovalDecision) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const collapseCacheRef = useRef<{ events: AgentChatEventEnvelope[]; rows: RenderEnvelope[] }>({
    events: [],
    rows: [],
  });
  const [stickToBottom, setStickToBottom] = useState(true);
  const stickToBottomRef = useRef(true);
  const onApprovalRef = useRef(onApproval);

  useEffect(() => {
    onApprovalRef.current = onApproval;
  }, [onApproval]);

  const handleApproval = useCallback((itemId: string, decision: AgentChatApprovalDecision) => {
    onApprovalRef.current?.(itemId, decision);
  }, []);

  const rows = useMemo(() => {
    const cached = collapseCacheRef.current;
    const nextRows = collapseEventsIncremental(events, cached.events, cached.rows);
    collapseCacheRef.current = { events, rows: nextRows };
    return nextRows;
  }, [events]);
  const latestActivity = useMemo(() => (showStreamingIndicator ? deriveLatestActivity(events) : null), [events, showStreamingIndicator]);

  // Map turnId → sequential turn number for display
  const turnNumberMap = useMemo(() => {
    const map = new Map<string, number>();
    let counter = 1;
    for (const row of rows) {
      const turnId = "turnId" in row.event ? (row.event as { turnId?: string }).turnId ?? null : null;
      if (turnId && !map.has(turnId)) {
        map.set(turnId, counter++);
      }
    }
    return map;
  }, [rows]);

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

  return (
    <div
      ref={scrollRef}
      className={cn("h-full overflow-auto p-4", className)}
      onScroll={(event) => {
        const target = event.currentTarget;
        const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
        const nextStick = distanceFromBottom < 72;
        if (nextStick !== stickToBottomRef.current) {
          stickToBottomRef.current = nextStick;
          setStickToBottom(nextStick);
        }
      }}
    >
      {rows.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-4">
          <div className="relative">
            <Robot size={36} weight="thin" className="text-accent/15" />
            <div className="absolute inset-0 animate-pulse bg-accent/[0.03] blur-xl" />
          </div>
          <span className="font-mono text-[10px] uppercase tracking-[2px] text-muted-fg/20">Start a conversation</span>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((envelope, index) => {
            const currentTurn = "turnId" in envelope.event ? envelope.event.turnId ?? null : null;
            const previous = rows[index - 1];
            const previousTurn = previous && "turnId" in previous.event ? previous.event.turnId ?? null : null;
            const showTurnDivider = currentTurn && currentTurn !== previousTurn;
            const turnDividerLabel = showTurnDivider
              ? `Turn ${String(turnNumberMap.get(currentTurn!) ?? 0).padStart(2, "0")} · ${formatTime(envelope.timestamp)}`
              : null;
            const turnModelLabel = currentTurn ? (turnModelLabelMap.get(currentTurn) ?? null) : null;
            return (
              <EventRow
                key={envelope.key}
                envelope={envelope}
                showTurnDivider={Boolean(showTurnDivider)}
                turnDividerLabel={turnDividerLabel}
                turnModelLabel={turnModelLabel}
                onApproval={handleApproval}
              />
            );
          })}

          {showStreamingIndicator ? (
            latestActivity ? (
              <ActivityIndicator activity={latestActivity.activity} detail={latestActivity.detail} />
            ) : (
              <div className="flex items-center gap-3 border-l-2 border-l-accent/30 bg-gradient-to-r from-accent/[0.04] to-transparent px-4 py-2.5 font-mono text-[11px] text-fg/60">
                <div className="flex items-center gap-1">
                  <span className="h-1 w-1 animate-bounce bg-accent/70 [animation-delay:0ms]" />
                  <span className="h-1 w-1 animate-bounce bg-accent/70 [animation-delay:150ms]" />
                  <span className="h-1 w-1 animate-bounce bg-accent/70 [animation-delay:300ms]" />
                </div>
                <span className="font-medium">Streaming...</span>
              </div>
            )
          ) : null}
        </div>
      )}
    </div>
  );
}

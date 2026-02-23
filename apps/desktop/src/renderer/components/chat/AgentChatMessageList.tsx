import React, { useEffect, useMemo, useRef, useState } from "react";
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
  ListChecks
} from "@phosphor-icons/react";
import type { AgentChatEvent, AgentChatEventEnvelope } from "../../../shared/types";
import { Chip } from "../ui/Chip";
import { cn } from "../ui/cn";

type RenderEnvelope = {
  key: string;
  timestamp: string;
  event: AgentChatEvent;
};

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function collapseEvents(events: AgentChatEventEnvelope[]): RenderEnvelope[] {
  const out: RenderEnvelope[] = [];

  for (let i = 0; i < events.length; i += 1) {
    const envelope = events[i]!;
    const { event } = envelope;
    const prev = out[out.length - 1];

    if (prev?.event.type === "text" && event.type === "text") {
      const prevTurn = prev.event.turnId ?? null;
      const nextTurn = event.turnId ?? null;
      const prevItem = prev.event.itemId ?? null;
      const nextItem = event.itemId ?? null;
      if (prevTurn === nextTurn && prevItem === nextItem) {
        prev.event = {
          ...prev.event,
          text: `${prev.event.text}${event.text}`
        };
        prev.timestamp = envelope.timestamp;
        continue;
      }
    }

    if (prev?.event.type === "reasoning" && event.type === "reasoning") {
      const prevTurn = prev.event.turnId ?? null;
      const nextTurn = event.turnId ?? null;
      const prevItem = prev.event.itemId ?? null;
      const nextItem = event.itemId ?? null;
      if (prevTurn === nextTurn && prevItem === nextItem) {
        prev.event = {
          ...prev.event,
          text: `${prev.event.text}${event.text}`
        };
        prev.timestamp = envelope.timestamp;
        continue;
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
        prev.event = {
          ...prev.event,
          output: mergedOutput,
          status: event.status,
          exitCode: event.exitCode ?? prev.event.exitCode,
          durationMs: event.durationMs ?? prev.event.durationMs
        };
        prev.timestamp = envelope.timestamp;
        continue;
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
        prev.event = {
          ...prev.event,
          diff: mergedDiff,
          status: event.status
        };
        prev.timestamp = envelope.timestamp;
        continue;
      }
    }

    out.push({
      key: `${envelope.sessionId}:${i}:${envelope.timestamp}`,
      timestamp: envelope.timestamp,
      event
    });
  }

  return out;
}

function StatusDot({ status }: { status: "running" | "completed" | "failed" }) {
  if (status === "completed") return <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]" />;
  if (status === "failed") return <span className="inline-block h-2 w-2 rounded-full bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.5)]" />;
  return <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.5)]" />;
}

function StatusIcon({ status }: { status: "running" | "completed" | "failed" }) {
  if (status === "completed") return <CheckCircle size={14} weight="regular" className="text-emerald-400" />;
  if (status === "failed") return <XCircle size={14} weight="regular" className="text-red-400" />;
  return <SpinnerGap size={14} weight="regular" className="animate-spin text-sky-400" />;
}

function PlanStepIcon({ status }: { status: string }) {
  if (status === "completed") return <Checks size={14} weight="regular" className="text-emerald-400" />;
  if (status === "failed") return <XCircle size={14} weight="regular" className="text-red-400" />;
  if (status === "in_progress") return <SpinnerGap size={14} weight="regular" className="animate-spin text-sky-400" />;
  return <Circle size={12} weight="regular" className="text-muted-fg" />;
}

function MarkdownBlock({ markdown }: { markdown: string }) {
  return (
    <div className="prose ade-prose-themed max-w-none text-[12px] leading-relaxed prose-headings:mb-2 prose-headings:mt-2 prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => (
            <pre className="my-2 overflow-auto rounded-md border border-border/20 bg-surface-recessed px-3 py-2 font-mono text-[11px] text-fg/80 shadow-inner">
              {children}
            </pre>
          ),
          code: ({ className, children }) => {
            const text = String(children ?? "");
            const isBlock = /\n/.test(text) || (typeof className === "string" && className.length > 0);
            return isBlock ? (
              <code className="font-mono text-[11px] text-fg/80">{children}</code>
            ) : (
              <code className="rounded-[4px] bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-secondary-fg">{children}</code>
            );
          },
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-accent underline decoration-accent/40 underline-offset-2 transition-colors hover:text-accent/80 hover:decoration-accent/60"
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
}

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
    <div className={cn("rounded-xl border transition-colors", className)}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px]"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <CaretDown size={12} weight="regular" className="text-muted-fg" /> : <CaretRight size={12} weight="regular" className="text-muted-fg" />}
        <div className="flex flex-1 flex-wrap items-center gap-2">{summary}</div>
      </button>
      {open ? <div className="border-t border-border/20 px-3 pb-2.5 pt-2">{children}</div> : null}
    </div>
  );
}

function DiffPreview({ diff }: { diff: string }) {
  const lines = diff.split(/\r?\n/);
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/20 bg-surface-recessed px-3 py-2 font-mono text-[11px] text-fg/75 shadow-inner">
      {lines.map((line, index) => {
        let tone = "text-fg/75";
        let bg = "";
        if (line.startsWith("+")) {
          tone = "text-diff-add";
          bg = "bg-emerald-500/[0.08]";
        } else if (line.startsWith("-")) {
          tone = "text-diff-del";
          bg = "bg-rose-500/[0.08]";
        } else if (line.startsWith("@@")) {
          tone = "text-diff-hunk";
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
    <div className="flex items-center gap-2.5 rounded-lg border border-accent/20 bg-accent/[0.06] px-3 py-2 text-[11px] text-fg/80">
      <div className="flex items-center gap-1">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:300ms]" />
      </div>
      <span className="truncate font-medium">{displayText}</span>
    </div>
  );
}

function renderEvent(envelope: RenderEnvelope) {
  const event = envelope.event;

  /* ── User message ── */
  if (event.type === "user_message") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] rounded-2xl border border-accent/25 bg-accent/[0.08] px-4 py-2.5 text-xs leading-relaxed text-card-fg shadow-card">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-accent/70">You</div>
          <div className="whitespace-pre-wrap break-words">{event.text}</div>
          {event.attachments?.length ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {event.attachments.map((attachment, index) => (
                <Chip key={`${attachment.path}:${index}`} className="bg-accent/15 text-[11px] text-fg/80">
                  {attachment.type}: {attachment.path}
                </Chip>
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
        <div className="max-w-[92%] rounded-2xl border-l-2 border-l-sky-500/50 border-y border-r border-y-border/20 border-r-border/20 bg-card/60 px-4 py-2.5 text-xs leading-relaxed text-fg/90 shadow-[0_1px_4px_rgba(0,0,0,0.1)]">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-sky-400/70">Agent</div>
          <MarkdownBlock markdown={event.text} />
        </div>
      </div>
    );
  }

  /* ── Command ── */
  if (event.type === "command") {
    const outputTrimmed = event.output.trim();
    const isLong = outputTrimmed.split("\n").length > 12;

    const commandHeader = (
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <Terminal size={14} weight="regular" className="text-amber-500/70" />
        <span className="font-semibold text-fg/80">Command</span>
        <StatusDot status={event.status} />
        <span className="text-muted-fg/80">{event.status}</span>
        {event.exitCode != null ? <Chip className="text-[11px]">exit {event.exitCode}</Chip> : null}
        {event.durationMs != null ? <span className="text-muted-fg/60">{Math.max(0, event.durationMs)}ms</span> : null}
      </div>
    );

    const commandBody = (
      <>
        <div className="rounded-md border border-border/15 bg-surface-recessed px-3 py-2 font-mono text-[11px] text-fg/85 shadow-inner">
          <span className="select-none text-muted-fg/50">$ </span>{event.command}
        </div>
        {outputTrimmed.length ? (
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/15 bg-surface-recessed px-3 py-2 font-mono text-[11px] text-fg/75 shadow-inner">
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
          className="border-border/30 bg-surface-recessed/80 shadow-card"
        >
          {commandBody}
        </CollapsibleCard>
      );
    }

    return (
      <div className="rounded-xl border border-border/30 bg-surface-recessed/80 p-3 shadow-card">
        <div className="mb-2">{commandHeader}</div>
        {commandBody}
      </div>
    );
  }

  /* ── File change ── */
  if (event.type === "file_change") {
    const hasDiff = event.diff.trim().length > 0;
    const summary = (
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <FileCode size={14} weight="regular" className="text-emerald-400/70" />
        <span className="font-semibold text-fg/80">File change</span>
        <StatusDot status={event.status ?? "running"} />
        <Chip className="text-[11px]">{event.kind}</Chip>
        <span className="truncate font-mono text-[11px] text-muted-fg/80">{event.path}</span>
      </div>
    );

    return (
      <CollapsibleCard
        defaultOpen={!hasDiff || event.diff.split("\n").length <= 20}
        summary={summary}
        className="border-emerald-500/20 bg-emerald-500/[0.04] shadow-[0_1px_4px_rgba(0,0,0,0.08)]"
      >
        {hasDiff ? (
          <DiffPreview diff={event.diff} />
        ) : (
          <div className="text-[11px] text-muted-fg">No diff payload available.</div>
        )}
      </CollapsibleCard>
    );
  }

  /* ── Plan ── */
  if (event.type === "plan") {
    return (
      <div className="rounded-xl border border-violet-500/20 bg-violet-500/[0.04] p-3 shadow-[0_1px_4px_rgba(0,0,0,0.08)]">
        <div className="mb-2.5 flex items-center gap-2 text-[11px]">
          <ListChecks size={14} weight="regular" className="text-violet-400/70" />
          <span className="font-semibold text-fg/80">Plan</span>
        </div>
        <div className="space-y-1.5 text-[11px]">
          {event.steps.length ? (
            event.steps.map((step, index) => (
              <div key={`${step.text}:${index}`} className="flex items-start gap-2.5 rounded-md px-2 py-1 transition-colors hover:bg-muted/20">
                <div className="mt-0.5 flex-shrink-0">
                  <PlanStepIcon status={step.status} />
                </div>
                <div className={cn(
                  "flex-1",
                  step.status === "completed" ? "text-fg/60 line-through decoration-fg/20" : "text-fg/85"
                )}>
                  {step.text}
                </div>
              </div>
            ))
          ) : (
            <div className="text-muted-fg">No plan steps yet.</div>
          )}
        </div>
        {event.explanation ? <div className="mt-2.5 border-t border-violet-500/10 pt-2 text-[11px] text-muted-fg">{event.explanation}</div> : null}
      </div>
    );
  }

  /* ── Reasoning ── */
  if (event.type === "reasoning") {
    return (
      <CollapsibleCard
        defaultOpen={false}
        summary={
          <div className="flex items-center gap-2 text-[11px]">
            <Brain size={14} weight="regular" className="text-purple-400/70" />
            <span className="font-medium text-purple-500/80">Thinking</span>
          </div>
        }
        className="border-purple-500/20 bg-purple-500/[0.04]"
      >
        <div className="text-fg/80">
          <MarkdownBlock markdown={event.text} />
        </div>
      </CollapsibleCard>
    );
  }

  /* ── Tool call ── */
  if (event.type === "tool_call") {
    return (
      <CollapsibleCard
        defaultOpen={false}
        summary={
          <div className="flex items-center gap-2 text-[11px]">
            <Wrench size={14} weight="regular" className="text-sky-400/70" />
            <span className="font-semibold text-fg/80">Tool call</span>
            <span className="font-mono text-[11px] text-accent/70">{event.tool}</span>
          </div>
        }
        className="border-border/25 bg-card/50"
      >
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/15 bg-surface-recessed px-3 py-2 font-mono text-[11px] text-fg/75">
          {JSON.stringify(event.args, null, 2)}
        </pre>
      </CollapsibleCard>
    );
  }

  /* ── Tool result ── */
  if (event.type === "tool_result") {
    return (
      <CollapsibleCard
        defaultOpen={false}
        summary={
          <div className="flex items-center gap-2 text-[11px]">
            <StatusIcon status={event.status ?? "completed"} />
            <span className="font-semibold text-fg/80">Tool result</span>
            <span className="font-mono text-[11px] text-accent/70">{event.tool}</span>
            {event.status ? (
              <span className={cn(
                "text-[11px]",
                event.status === "completed" ? "text-emerald-400/80" : event.status === "failed" ? "text-red-400/80" : "text-sky-400/80"
              )}>
                {event.status}
              </span>
            ) : null}
          </div>
        }
        className="border-border/25 bg-card/50"
      >
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/15 bg-surface-recessed px-3 py-2 font-mono text-[11px] text-fg/75">
          {JSON.stringify(event.result, null, 2)}
        </pre>
      </CollapsibleCard>
    );
  }

  /* ── Approval request ── */
  if (event.type === "approval_request") {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-gradient-to-r from-amber-500/[0.08] to-amber-400/[0.04] p-3 shadow-card">
        <div className="mb-1.5 flex items-center gap-2 text-[11px]">
          <Warning size={14} weight="regular" className="text-amber-500" />
          <span className="font-semibold text-fg/90">Approval required</span>
        </div>
        <div className="text-[11px] text-fg/80">{event.description}</div>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className="rounded-md border border-amber-500/30 bg-amber-500/15 px-2.5 py-1 text-[11px] font-medium text-fg transition-colors hover:bg-amber-500/25"
          >
            Accept
          </button>
          <button
            type="button"
            className="rounded-md border border-amber-500/20 bg-transparent px-2.5 py-1 text-[11px] font-medium text-fg/80 transition-colors hover:bg-amber-500/10"
          >
            Accept Session
          </button>
          <button
            type="button"
            className="rounded-md border border-amber-500/20 bg-transparent px-2.5 py-1 text-[11px] font-medium text-fg/80 transition-colors hover:bg-amber-500/10"
          >
            Decline
          </button>
        </div>
      </div>
    );
  }

  /* ── Error ── */
  if (event.type === "error") {
    return (
      <div className="rounded-xl border border-red-500/30 bg-gradient-to-r from-red-500/[0.08] to-red-400/[0.04] p-3 shadow-card">
        <div className="mb-1.5 flex items-center gap-2 text-[11px]">
          <Warning size={14} weight="regular" className="text-red-500" />
          <span className="font-semibold text-fg/90">Error</span>
        </div>
        <div className="whitespace-pre-wrap break-words text-[11px] text-fg/85">{event.message}</div>
        {event.errorInfo ? <div className="mt-1.5 text-[11px] text-muted-fg/60">{event.errorInfo}</div> : null}
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
      <div className="flex items-center gap-2 text-[11px] text-muted-fg/70">
        <div className="h-px flex-1 bg-border/20" />
        <span>
          Turn {event.turnStatus}
          {event.message ? ` — ${event.message}` : ""}
        </span>
        <div className="h-px flex-1 bg-border/20" />
      </div>
    );
  }

  /* ── Done / fallback ── */
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-fg/60">
      <div className="h-px flex-1 bg-border/15" />
      <span>Turn {event.status}.</span>
      <div className="h-px flex-1 bg-border/15" />
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

export function AgentChatMessageList({
  events,
  showStreamingIndicator = false,
  className
}: {
  events: AgentChatEventEnvelope[];
  showStreamingIndicator?: boolean;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  const rows = useMemo(() => collapseEvents(events), [events]);
  const latestActivity = useMemo(() => (showStreamingIndicator ? deriveLatestActivity(events) : null), [events, showStreamingIndicator]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [rows, stickToBottom]);

  return (
    <div
      ref={scrollRef}
      className={cn("h-full overflow-auto rounded-lg border border-border/30 bg-bg/55 p-3", className)}
      onScroll={(event) => {
        const target = event.currentTarget;
        const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
        setStickToBottom(distanceFromBottom < 72);
      }}
    >
      {rows.length === 0 ? (
        <div className="flex h-full items-center justify-center text-xs text-muted-fg">
          Start a conversation to see chat activity.
        </div>
      ) : (
        <div className="space-y-2.5">
          {rows.map((envelope, index) => {
            const currentTurn = "turnId" in envelope.event ? envelope.event.turnId ?? null : null;
            const previous = rows[index - 1];
            const previousTurn = previous && "turnId" in previous.event ? previous.event.turnId ?? null : null;
            const showTurnDivider = currentTurn && currentTurn !== previousTurn;
            return (
              <div key={envelope.key} className="space-y-1.5">
                {showTurnDivider ? (
                  <div className="flex items-center gap-2 py-1 text-[11px] uppercase tracking-wider text-muted-fg/60">
                    <div className="h-px flex-1 bg-border/20" />
                    <span>Turn · {formatTime(envelope.timestamp)}</span>
                    <div className="h-px flex-1 bg-border/20" />
                  </div>
                ) : null}
                {renderEvent(envelope)}
              </div>
            );
          })}

          {showStreamingIndicator ? (
            latestActivity ? (
              <ActivityIndicator activity={latestActivity.activity} detail={latestActivity.detail} />
            ) : (
              <div className="flex items-center gap-2.5 rounded-lg border border-accent/20 bg-accent/[0.06] px-3 py-2 text-[11px] text-fg/80">
                <div className="flex items-center gap-1">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:0ms]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:150ms]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:300ms]" />
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

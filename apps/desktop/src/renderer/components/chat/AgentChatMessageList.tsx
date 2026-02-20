import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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

function statusChipClass(status: "running" | "completed" | "failed"): string {
  if (status === "completed") return "bg-emerald-500/20 text-emerald-200";
  if (status === "failed") return "bg-red-500/20 text-red-200";
  return "bg-sky-500/20 text-sky-200";
}

function MarkdownBlock({ markdown }: { markdown: string }) {
  return (
    <div className="prose prose-invert max-w-none text-[12px] leading-relaxed prose-headings:mb-2 prose-headings:mt-2 prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => (
            <pre className="my-2 overflow-auto rounded border border-border/30 bg-black/40 px-2 py-1.5 font-mono text-[11px] text-zinc-200">
              {children}
            </pre>
          ),
          code: ({ className, children }) => {
            const text = String(children ?? "");
            const isBlock = /\n/.test(text) || (typeof className === "string" && className.length > 0);
            return isBlock ? (
              <code className="font-mono text-[11px] text-zinc-200">{children}</code>
            ) : (
              <code className="rounded bg-black/30 px-1 py-0.5 font-mono text-[11px] text-zinc-200">{children}</code>
            );
          },
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-sky-200 underline decoration-sky-200/50 underline-offset-2"
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

function renderEvent(envelope: RenderEnvelope) {
  const event = envelope.event;

  if (event.type === "user_message") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] rounded-xl border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs leading-relaxed text-sky-100">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-sky-200/80">You</div>
          <div className="whitespace-pre-wrap break-words">{event.text}</div>
          {event.attachments?.length ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {event.attachments.map((attachment, index) => (
                <Chip key={`${attachment.path}:${index}`} className="bg-sky-500/15 text-[10px] text-sky-100">
                  {attachment.type}: {attachment.path}
                </Chip>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  if (event.type === "text") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[92%] rounded-xl border border-border/40 bg-card/70 px-3 py-2 text-xs leading-relaxed text-fg/90">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-fg">Agent</div>
          <MarkdownBlock markdown={event.text} />
        </div>
      </div>
    );
  }

  if (event.type === "command") {
    return (
      <div className="rounded-xl border border-border/30 bg-[--color-surface-recessed]/40 p-2.5">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="font-semibold text-fg/80">Command</span>
          <Chip className={cn("text-[10px]", statusChipClass(event.status))}>{event.status}</Chip>
          {event.exitCode != null ? <Chip className="text-[10px]">exit {event.exitCode}</Chip> : null}
          {event.durationMs != null ? <span className="text-muted-fg">{Math.max(0, event.durationMs)}ms</span> : null}
        </div>
        <div className="rounded border border-border/30 bg-black/40 px-2 py-1.5 font-mono text-[11px] text-amber-100">$ {event.command}</div>
        {event.output.trim().length ? (
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border/30 bg-black/40 px-2 py-1.5 font-mono text-[11px] text-zinc-200">
            {event.output}
          </pre>
        ) : null}
      </div>
    );
  }

  if (event.type === "file_change") {
    return (
      <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-2.5">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="font-semibold text-fg/80">File change</span>
          <Chip className={cn("text-[10px]", statusChipClass(event.status ?? "running"))}>{event.status ?? "running"}</Chip>
          <Chip className="text-[10px]">{event.kind}</Chip>
          <span className="truncate text-muted-fg">{event.path}</span>
        </div>
        {event.diff.trim().length ? (
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-border/30 bg-black/40 px-2 py-1.5 font-mono text-[11px] text-zinc-200">
            {event.diff}
          </pre>
        ) : (
          <div className="text-[11px] text-muted-fg">No diff payload available.</div>
        )}
      </div>
    );
  }

  if (event.type === "plan") {
    return (
      <div className="rounded-xl border border-border/30 bg-card/70 p-2.5">
        <div className="mb-2 text-[11px] font-semibold text-fg/80">Plan</div>
        <div className="space-y-1.5 text-[11px]">
          {event.steps.length ? (
            event.steps.map((step, index) => (
              <div key={`${step.text}:${index}`} className="flex items-start gap-2">
                <Chip className={cn("mt-0.5 px-1.5 py-0.5 text-[10px]", step.status === "completed" ? "bg-emerald-500/20 text-emerald-200" : step.status === "failed" ? "bg-red-500/20 text-red-200" : step.status === "in_progress" ? "bg-sky-500/20 text-sky-200" : "")}>{step.status}</Chip>
                <div className="flex-1 text-fg/85">{step.text}</div>
              </div>
            ))
          ) : (
            <div className="text-muted-fg">No plan steps yet.</div>
          )}
        </div>
        {event.explanation ? <div className="mt-2 text-[11px] text-muted-fg">{event.explanation}</div> : null}
      </div>
    );
  }

  if (event.type === "reasoning") {
    return (
      <details className="rounded-xl border border-border/30 bg-card/60 p-2.5 text-[11px]">
        <summary className="cursor-pointer text-muted-fg">Thinking summary</summary>
        <div className="mt-2 text-fg/80">
          <MarkdownBlock markdown={event.text} />
        </div>
      </details>
    );
  }

  if (event.type === "tool_call") {
    return (
      <div className="rounded-xl border border-border/30 bg-card/60 p-2.5 text-[11px]">
        <div className="mb-1 font-semibold text-fg/80">Tool call: {event.tool}</div>
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded border border-border/30 bg-black/30 px-2 py-1 font-mono text-[11px] text-zinc-200">
          {JSON.stringify(event.args, null, 2)}
        </pre>
      </div>
    );
  }

  if (event.type === "tool_result") {
    return (
      <div className="rounded-xl border border-border/30 bg-card/60 p-2.5 text-[11px]">
        <div className="mb-1 flex items-center gap-2">
          <span className="font-semibold text-fg/80">Tool result: {event.tool}</span>
          {event.status ? <Chip className={cn("text-[10px]", statusChipClass(event.status))}>{event.status}</Chip> : null}
        </div>
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded border border-border/30 bg-black/30 px-2 py-1 font-mono text-[11px] text-zinc-200">
          {JSON.stringify(event.result, null, 2)}
        </pre>
      </div>
    );
  }

  if (event.type === "approval_request") {
    return (
      <div className="rounded-xl border border-amber-400/35 bg-amber-400/10 p-2.5 text-[11px]">
        <div className="font-semibold text-amber-100">Approval required</div>
        <div className="mt-1 text-amber-50/90">{event.description}</div>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <button
            type="button"
            className="rounded border border-amber-200/30 bg-amber-200/20 px-2 py-0.5 text-[10px] text-amber-50"
          >
            Accept
          </button>
          <button
            type="button"
            className="rounded border border-amber-200/30 bg-transparent px-2 py-0.5 text-[10px] text-amber-50"
          >
            Accept Session
          </button>
          <button
            type="button"
            className="rounded border border-amber-200/30 bg-transparent px-2 py-0.5 text-[10px] text-amber-50"
          >
            Decline
          </button>
        </div>
      </div>
    );
  }

  if (event.type === "error") {
    return (
      <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-2.5 text-[11px] text-red-100">
        <div className="font-semibold">Error</div>
        <div className="mt-1 whitespace-pre-wrap break-words">{event.message}</div>
        {event.errorInfo ? <div className="mt-1 text-red-100/80">{event.errorInfo}</div> : null}
      </div>
    );
  }

  if (event.type === "status") {
    return (
      <div className="text-[11px] text-muted-fg">
        Turn {event.turnStatus}
        {event.message ? ` · ${event.message}` : ""}
      </div>
    );
  }

  return <div className="text-[11px] text-muted-fg">Turn {event.status}.</div>;
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

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [rows, stickToBottom]);

  return (
    <div
      ref={scrollRef}
      className={cn("h-full overflow-auto rounded-lg border border-border/30 bg-bg/50 p-3", className)}
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
                  <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-fg">
                    <div className="h-px flex-1 bg-border/30" />
                    <span>Turn · {formatTime(envelope.timestamp)}</span>
                    <div className="h-px flex-1 bg-border/30" />
                  </div>
                ) : null}
                {renderEvent(envelope)}
                <div className="text-right text-[10px] text-muted-fg/70">{formatTime(envelope.timestamp)}</div>
              </div>
            );
          })}

          {showStreamingIndicator ? (
            <div className="flex items-center justify-start gap-1.5 px-1 py-1 text-[11px] text-muted-fg">
              <span className="font-semibold uppercase tracking-wide text-[10px]">Streaming</span>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-300/80" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-300/80 [animation-delay:120ms]" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-300/80 [animation-delay:240ms]" />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

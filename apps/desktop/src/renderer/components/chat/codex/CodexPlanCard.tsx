import { useState } from "react";
import { motion } from "motion/react";
import type { AgentChatEvent, AgentChatPlanStep } from "../../../../shared/types";
import { cn } from "../../ui/cn";
import { ChatMarkdown } from "../chatMarkdown";

type PlanEvent = Extract<AgentChatEvent, { type: "plan" }>;

type CodexPlanCardProps = {
  event: PlanEvent;
  onOpenInfo?: () => void;
};

const VIOLET = "#A78BFA";

function PlanMarkdown({ markdown }: { markdown: string }) {
  return (
    <div className="ade-prose-themed prose prose-invert max-w-none text-[length:calc(var(--chat-font-size)*12/14)] leading-[1.55] text-fg/72 prose-headings:mb-2 prose-headings:mt-3 prose-headings:text-fg/90 prose-p:my-2 prose-ul:my-2 prose-ul:pl-5 prose-ol:my-2 prose-ol:pl-5 prose-li:my-1">
      <ChatMarkdown tone="neutral">{markdown}</ChatMarkdown>
    </div>
  );
}

function PlanGlyph({ status }: { status: AgentChatPlanStep["status"] }) {
  if (status === "in_progress") {
    return (
      <span aria-hidden className="font-semibold text-violet-300" style={{ color: VIOLET }}>
        {"◐"}
      </span>
    );
  }
  if (status === "completed") {
    return (
      <span aria-hidden className="text-emerald-300/85">{"●"}</span>
    );
  }
  if (status === "failed") {
    return (
      <span aria-hidden className="text-red-300/85">{"✕"}</span>
    );
  }
  return (
    <span aria-hidden className="text-fg/30">{"○"}</span>
  );
}

export function CodexPlanCard({ event, onOpenInfo }: CodexPlanCardProps) {
  const [liveOpen, setLiveOpen] = useState(false);
  const steps = Array.isArray(event.steps) ? event.steps : [];
  const hasStreaming = Boolean(event.streamingText && event.streamingText.trim().length);
  let stateLabel: string;
  switch (event.state) {
    case "complete": stateLabel = "Plan ready"; break;
    case "active":
    case "delta":    stateLabel = "Planning"; break;
    default:         stateLabel = "Plan";
  }
  const streamingTrimmed = (event.streamingText ?? "").trim();
  const showCompletedMarkdownInline = hasStreaming && event.state === "complete" && !steps.length;
  const showMarkdownToggle = hasStreaming && !showCompletedMarkdownInline;

  return (
    <motion.div
      role={onOpenInfo ? "button" : undefined}
      tabIndex={onOpenInfo ? 0 : undefined}
      onClick={onOpenInfo}
      onKeyDown={(keyboardEvent) => {
        if (!onOpenInfo) return;
        if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
          keyboardEvent.preventDefault();
          onOpenInfo();
        }
      }}
      initial={{ opacity: 0, y: 2 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.14, ease: "easeOut" }}
      className={cn(
        "relative overflow-hidden rounded-xl border border-violet-400/15 bg-violet-500/[0.025]",
        onOpenInfo && "cursor-pointer transition-colors hover:border-violet-300/25 hover:bg-violet-500/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/45",
      )}
    >
      <div className="flex items-baseline justify-between gap-3 px-4 pb-1 pt-3">
        <h3 className="text-[length:calc(var(--chat-font-size)*13/14)] font-semibold tracking-[-0.005em] text-violet-100">
          {stateLabel}
        </h3>
        {steps.length ? (
          <span className="text-[length:calc(var(--chat-font-size)*11/14)] text-violet-200/45">
            {steps.filter((s) => s.status === "completed").length}
            /
            {steps.length}
          </span>
        ) : null}
      </div>

      {event.explanation ? (
        <p className="px-4 pb-2 text-[length:calc(var(--chat-font-size)*12/14)] leading-[1.5] text-fg/72">
          {event.explanation}
        </p>
      ) : null}

      {steps.length ? (
        <ul className="space-y-1 px-4 pb-3 pt-1">
          {steps.map((step, idx) => {
            const isActive = step.status === "in_progress";
            const isComplete = step.status === "completed";
            return (
              <li
                key={`${step.text}:${idx}`}
                className={cn(
                  "flex items-start gap-2.5 text-[length:calc(var(--chat-font-size)*12/14)] leading-[1.45]",
                  isActive ? "text-violet-100" : isComplete ? "text-fg/40 line-through decoration-fg/15" : "text-fg/72",
                )}
              >
                <span className="mt-[1px] inline-flex w-3 shrink-0 justify-center text-[13px] leading-none">
                  <PlanGlyph status={step.status} />
                </span>
                <span className="min-w-0 flex-1">{step.text}</span>
              </li>
            );
          })}
        </ul>
      ) : !hasStreaming ? (
        <div className="px-4 pb-3 text-[length:calc(var(--chat-font-size)*11/14)] italic text-fg/35">
          Drafting steps…
        </div>
      ) : null}

      {showCompletedMarkdownInline ? (
        <div className="border-t border-violet-400/10 px-4 pb-3 pt-2">
          <PlanMarkdown markdown={streamingTrimmed} />
        </div>
      ) : null}

      {showMarkdownToggle ? (
        <div className="flex items-center justify-end gap-2 border-t border-violet-400/10 px-4 py-1.5">
          <button
            type="button"
            onClick={(clickEvent) => {
              clickEvent.stopPropagation();
              setLiveOpen((v) => !v);
            }}
            className="inline-flex items-center gap-1 rounded text-[length:calc(var(--chat-font-size)*10/14)] text-violet-200/55 transition-colors hover:text-violet-100"
            aria-expanded={liveOpen}
          >
            <span aria-hidden>{liveOpen ? "▾" : "▸"}</span>
            <span>{event.state === "complete" ? "details" : "live"}</span>
          </button>
        </div>
      ) : null}

      {showMarkdownToggle && liveOpen ? (
        <div className="border-t border-violet-400/10 bg-violet-950/15 px-4 py-2 text-[length:calc(var(--chat-font-size)*11/14)] leading-[1.5] text-fg/55">
          <PlanMarkdown markdown={streamingTrimmed} />
        </div>
      ) : null}
    </motion.div>
  );
}

export default CodexPlanCard;

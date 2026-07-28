import { useState } from "react";
import { motion } from "motion/react";
import { ListChecks } from "@phosphor-icons/react";
import type { AgentChatEvent, AgentChatPlanStep } from "../../../../shared/types";
import { cn } from "../../ui/cn";
import { ChatMarkdown } from "../chatMarkdown";
import {
  CHAT_CARD_WIDTH_CLASS,
  ChatCardDetail,
  ChatCardDetailRow,
  ChatCardRow,
  ChatCardTitle,
  type ChatCardTone,
} from "../chatCardPrimitives";

type PlanEvent = Extract<AgentChatEvent, { type: "plan" }>;

type CodexPlanCardProps = {
  event: PlanEvent;
  onOpenInfo?: () => void;
};

function PlanMarkdown({ markdown }: { markdown: string }) {
  return (
    <div className="ade-prose-themed prose prose-invert max-w-none text-[length:calc(var(--chat-font-size)*12/14)] leading-[1.55] text-fg/72 prose-headings:mb-2 prose-headings:mt-3 prose-headings:text-fg/90 prose-p:my-2 prose-ul:my-2 prose-ul:pl-5 prose-ol:my-2 prose-ol:pl-5 prose-li:my-1">
      <ChatMarkdown tone="neutral">{markdown}</ChatMarkdown>
    </div>
  );
}

/** Step status → the shared tone vocabulary. A failed step is amber, not red. */
function planStepTone(status: AgentChatPlanStep["status"]): ChatCardTone {
  if (status === "completed") return "ok";
  if (status === "in_progress") return "running";
  if (status === "failed") return "warn";
  return "neutral";
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
        // Checklist shape: one head row, one detail row per step. Same
        // `[glyph | content | meta]` grid and same width token as every other
        // transcript card.
        CHAT_CARD_WIDTH_CLASS,
        "relative overflow-hidden rounded-[calc(var(--chat-radius-card)-6px)] bg-white/[0.03] px-3 py-2.5",
        onOpenInfo && "cursor-pointer transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/45",
      )}
    >
      <ChatCardRow
        tone={event.state === "complete" ? "ok" : "running"}
        icon={ListChecks}
        align={event.explanation ? "top" : "center"}
        meta={steps.length ? `${steps.filter((s) => s.status === "completed").length}/${steps.length}` : null}
      >
        <ChatCardTitle>{stateLabel}</ChatCardTitle>
        {event.explanation ? (
          <p className="mt-1 whitespace-normal text-[length:calc(var(--chat-font-size)*10.5/14)] leading-snug text-fg/62">
            {event.explanation}
          </p>
        ) : null}
      </ChatCardRow>

      {steps.length ? (
        <ChatCardDetail>
          {steps.map((step, idx) => (
            <ChatCardDetailRow
              key={`${step.text}:${idx}`}
              tone={planStepTone(step.status)}
              strike={step.status === "completed"}
              label={step.text}
              title={step.text}
            />
          ))}
        </ChatCardDetail>
      ) : !hasStreaming ? (
        <div className="ml-[26px] mt-1 text-[length:calc(var(--chat-font-size)*10.5/14)] italic text-fg/35">
          Drafting steps…
        </div>
      ) : null}

      {showCompletedMarkdownInline ? (
        <div className="mt-2 border-t border-white/[0.06] pt-2">
          <PlanMarkdown markdown={streamingTrimmed} />
        </div>
      ) : null}

      {showMarkdownToggle ? (
        <div className="mt-2 flex items-center justify-end gap-2 border-t border-white/[0.06] pt-1.5">
          <button
            type="button"
            onClick={(clickEvent) => {
              clickEvent.stopPropagation();
              setLiveOpen((v) => !v);
            }}
            className="inline-flex items-center gap-1 rounded text-[length:calc(var(--chat-font-size)*10/14)] text-fg/45 transition-colors hover:text-fg/80"
            aria-expanded={liveOpen}
          >
            <span aria-hidden>{liveOpen ? "▾" : "▸"}</span>
            <span>{event.state === "complete" ? "details" : "live"}</span>
          </button>
        </div>
      ) : null}

      {showMarkdownToggle && liveOpen ? (
        <div className="mt-1.5 rounded-md bg-black/20 px-2.5 py-2 text-[length:calc(var(--chat-font-size)*11/14)] leading-[1.5] text-fg/55">
          <PlanMarkdown markdown={streamingTrimmed} />
        </div>
      ) : null}
    </motion.div>
  );
}

export default CodexPlanCard;

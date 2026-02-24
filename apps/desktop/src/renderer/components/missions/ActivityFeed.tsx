import React, { useRef, useEffect, useState, useCallback } from "react";
import { CaretDown } from "@phosphor-icons/react";
import type { OrchestratorChatMessage } from "../../../shared/types";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";

type ActivityFeedProps = {
  messages: OrchestratorChatMessage[];
  agentColors: Map<string, string>;
  selectedAgent: string | null;
};

export function ActivityFeed({ messages, agentColors, selectedAgent }: ActivityFeedProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const isAtBottomRef = useRef(true);

  // Auto-scroll when new messages arrive (if user is at bottom)
  useEffect(() => {
    if (scrollRef.current && isAtBottomRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [messages.length]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 60;
    isAtBottomRef.current = atBottom;
    setShowJumpToLatest(!atBottom);
  }, []);

  const jumpToLatest = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
    setShowJumpToLatest(false);
    isAtBottomRef.current = true;
  }, []);

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto px-4 py-3 space-y-1 relative"
    >
      {messages.length === 0 && (
        <div className="flex items-center justify-center h-full text-xs" style={{ color: COLORS.textMuted }}>
          Waiting for mission activity...
        </div>
      )}
      {messages.map((msg) => (
        <FeedEntry key={msg.id} msg={msg} agentColors={agentColors} />
      ))}

      {showJumpToLatest && (
        <button
          onClick={jumpToLatest}
          className="sticky bottom-2 left-1/2 -translate-x-1/2 px-3 py-1 font-bold shadow-lg hover:opacity-90 transition-opacity flex items-center gap-1"
          style={{
            background: COLORS.accent,
            color: COLORS.pageBg,
            fontFamily: MONO_FONT,
            fontSize: "10px",
            textTransform: "uppercase" as const,
            letterSpacing: "1px"
          }}
        >
          <CaretDown size={12} weight="regular" />
          LATEST
        </button>
      )}
    </div>
  );
}

function FeedEntry({ msg, agentColors }: { msg: OrchestratorChatMessage; agentColors: Map<string, string> }) {
  const isUser = msg.role === "user";
  const isCoordinator = msg.role === "orchestrator";

  // Determine the step key label
  const label = msg.stepKey ?? (isCoordinator ? "coordinator" : isUser ? "you" : "system");
  const color = agentColors.get(label) ?? (isCoordinator ? COLORS.accent : isUser ? COLORS.info : COLORS.textMuted);

  // System events -- short orchestrator messages
  if (isCoordinator && msg.content.length < 80 && !msg.content.includes("\n")) {
    return (
      <div className="flex items-start gap-2 py-0.5">
        <span
          className="shrink-0 text-[10px] w-[100px] text-right"
          style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}
        >
          system
        </span>
        <span className="text-xs" style={{ color: COLORS.textMuted }}>
          {msg.content}
        </span>
      </div>
    );
  }

  // User messages
  if (isUser) {
    return (
      <div className="flex items-start gap-2 py-0.5">
        <span
          className="shrink-0 text-[10px] w-[100px] text-right font-semibold"
          style={{ color: COLORS.info, fontFamily: MONO_FONT }}
        >
          you
        </span>
        <span className="text-xs" style={{ color: COLORS.textPrimary }}>
          {msg.content}
        </span>
      </div>
    );
  }

  // Inter-agent messages
  const isInterAgent = msg.role === "agent" && msg.target?.kind === "agent";
  if (isInterAgent) {
    const srcKey = msg.stepKey ?? "agent";
    const dstKey = msg.target && "targetAttemptId" in msg.target
      ? "agent"
      : "agent";
    return (
      <div className="flex items-start gap-2 py-0.5">
        <span
          className="shrink-0 text-[10px] w-[100px] text-right"
          style={{ color: agentColors.get(srcKey) ?? COLORS.accent, fontFamily: MONO_FONT }}
        >
          {srcKey} &rarr; {dstKey}
        </span>
        <span className="text-xs" style={{ color: COLORS.textSecondary }}>
          {msg.content}
        </span>
      </div>
    );
  }

  // Coordinator messages -- slightly different style
  if (isCoordinator) {
    return (
      <div className="flex items-start gap-2 py-0.5">
        <span
          className="shrink-0 text-[10px] w-[100px] text-right font-semibold"
          style={{ color: COLORS.accent, fontFamily: MONO_FONT }}
        >
          coordinator
        </span>
        <span className="text-xs" style={{ color: "#E0D4FF" }}>
          {msg.content}
        </span>
      </div>
    );
  }

  // Standard agent/worker messages
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span
        className="shrink-0 text-[10px] w-[100px] text-right"
        title={new Date(msg.timestamp).toLocaleTimeString()}
        style={{ color, fontFamily: MONO_FONT }}
      >
        {label}
      </span>
      <span
        className="text-xs"
        style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}
      >
        {msg.content}
      </span>
    </div>
  );
}

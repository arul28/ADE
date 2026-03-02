import React, { useEffect, useState } from "react";
import { ChatCircle, Terminal } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { LaneTerminalsPanel } from "./LaneTerminalsPanel";
import { AgentChatPane } from "../chat/AgentChatPane";
import { COLORS, MONO_FONT } from "./laneDesignTokens";

function isChatToolType(toolType: string | null | undefined): boolean {
  return toolType === "codex-chat" || toolType === "claude-chat" || toolType === "ai-chat";
}

const WORK_TABS = [
  { id: "terminal" as const, num: "01", label: "TERMINAL", Icon: Terminal },
  { id: "chat" as const, num: "02", label: "CHAT", Icon: ChatCircle },
];

export function LaneWorkPane({
  laneId
}: {
  laneId: string | null;
}) {
  const focusedSessionId = useAppStore((state) => state.focusedSessionId);
  const [view, setView] = useState<"terminal" | "chat">("terminal");
  const [focusedChatSessionId, setFocusedChatSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (!focusedSessionId) {
      setFocusedChatSessionId(null);
      return;
    }

    let cancelled = false;
    window.ade.sessions
      .get(focusedSessionId)
      .then((session) => {
        if (cancelled) return;
        if (!session || !isChatToolType(session.toolType)) {
          setFocusedChatSessionId(null);
          return;
        }
        if (laneId && session.laneId !== laneId) {
          setFocusedChatSessionId(null);
          return;
        }
        setFocusedChatSessionId(session.id);
        setView("chat");
      })
      .catch(() => {
        if (!cancelled) setFocusedChatSessionId(null);
      });

    return () => {
      cancelled = true;
    };
  }, [focusedSessionId, laneId]);

  return (
    <div className="flex h-full flex-col" style={{ background: COLORS.pageBg }}>
      <div
        className="flex items-center shrink-0"
        style={{ borderBottom: `1px solid ${COLORS.border}`, background: COLORS.cardBg, gap: 8 }}
      >
        {WORK_TABS.map((tab) => {
          const isActive = view === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              className="relative flex items-center transition-colors duration-150"
              style={{
                fontFamily: MONO_FONT,
                fontSize: 11,
                fontWeight: isActive ? 600 : 500,
                textTransform: "uppercase",
                letterSpacing: "1px",
                height: 40,
                padding: "10px 16px",
                gap: 8,
                ...(isActive
                  ? {
                      background: `${COLORS.accent}18`,
                      borderLeft: `2px solid ${COLORS.accent}`,
                      color: COLORS.textPrimary,
                    }
                  : {
                      background: "transparent",
                      borderLeft: "2px solid transparent",
                      color: COLORS.textMuted,
                    }),
              }}
              onClick={() => setView(tab.id)}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.color = COLORS.textSecondary;
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.color = COLORS.textMuted;
              }}
            >
              <span style={{ color: isActive ? COLORS.accent : COLORS.textDim }}>{tab.num}</span>
              <tab.Icon size={14} style={{ color: isActive ? COLORS.accent : COLORS.textMuted }} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>
      <div className="relative flex-1 min-h-0">
        <div className="absolute inset-0" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, padding: 16, gap: 3 }}>
          {view === "terminal" ? (
            <LaneTerminalsPanel overrideLaneId={laneId} />
          ) : (
            <AgentChatPane laneId={laneId} initialSessionId={focusedChatSessionId} />
          )}
        </div>
      </div>
    </div>
  );
}

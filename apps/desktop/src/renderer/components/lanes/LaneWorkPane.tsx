import { useEffect, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { LaneTerminalsPanel } from "./LaneTerminalsPanel";
import { AgentChatPane } from "../chat/AgentChatPane";
import { MONO_FONT } from "./laneDesignTokens";
import { isChatToolType } from "../../lib/sessions";
import { AiChatLogo, ShellLogo } from "../terminals/ToolLogos";

const WORK_TABS = [
  { id: "terminal" as const, num: "01", label: "Workspace sessions", Logo: ShellLogo },
  { id: "chat" as const, num: "02", label: "AI chats", Logo: AiChatLogo },
];

export function LaneWorkPane({
  laneId
}: {
  laneId: string | null;
}) {
  const themeSurface = "var(--color-surface)";
  const themeRaised = "var(--color-surface-raised)";
  const themeRecessed = "var(--color-surface-recessed)";
  const themeBorder = "color-mix(in srgb, var(--color-border) 72%, transparent)";
  const themeAccent = "var(--color-accent)";
  const themeAccentMuted = "color-mix(in srgb, var(--color-accent) 12%, transparent)";
  const themeText = "var(--color-fg)";
  const themeTextMuted = "var(--color-muted-fg)";
  const themeTextDim = "color-mix(in srgb, var(--color-muted-fg) 72%, var(--color-fg) 28%)";
  const themeTextSecondary = "color-mix(in srgb, var(--color-muted-fg) 60%, var(--color-fg) 40%)";

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
    <div className="flex h-full flex-col" style={{ background: themeSurface }}>
      <div
        className="flex items-center shrink-0"
        style={{ borderBottom: `1px solid ${themeBorder}`, background: themeRaised, gap: 8 }}
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
                padding: "10px 14px",
                gap: 8,
                ...(isActive
                  ? {
                      background: themeAccentMuted,
                      borderLeft: `2px solid ${themeAccent}`,
                      color: themeText,
                    }
                  : {
                      background: "transparent",
                      borderLeft: "2px solid transparent",
                      color: themeTextMuted,
                    }),
              }}
              onClick={() => setView(tab.id)}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.color = themeTextSecondary;
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.color = themeTextMuted;
              }}
              title={tab.label}
            >
              <span style={{ color: isActive ? themeAccent : themeTextDim }}>{tab.num}</span>
              <tab.Logo size={14} className={isActive ? "" : "opacity-70"} />
            </button>
          );
        })}
      </div>
      <div className="relative flex-1 min-h-0">
        <div
          className="absolute inset-0"
          style={{ background: themeRecessed, border: `1px solid ${themeBorder}`, padding: 16, gap: 3 }}
        >
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

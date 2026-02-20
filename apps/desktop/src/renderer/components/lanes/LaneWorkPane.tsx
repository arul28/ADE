import React, { useEffect, useState } from "react";
import { MessageSquare, Terminal } from "lucide-react";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { LaneTerminalsPanel } from "./LaneTerminalsPanel";
import { AgentChatPane } from "../chat/AgentChatPane";

function isChatToolType(toolType: string | null | undefined): boolean {
  return toolType === "codex-chat" || toolType === "claude-chat";
}

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
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center gap-2 rounded-lg border border-border/30 bg-card/60 p-1">
        <Button
          size="sm"
          variant={view === "terminal" ? "primary" : "outline"}
          className="h-7 px-2 text-[11px]"
          onClick={() => setView("terminal")}
        >
          <Terminal className="h-3.5 w-3.5" />
          Terminal view
        </Button>
        <Button
          size="sm"
          variant={view === "chat" ? "primary" : "outline"}
          className="h-7 px-2 text-[11px]"
          onClick={() => setView("chat")}
        >
          <MessageSquare className="h-3.5 w-3.5" />
          Chat view
        </Button>
      </div>
      <div className="relative flex-1 min-h-0">
        <div className="absolute inset-0 p-2">
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

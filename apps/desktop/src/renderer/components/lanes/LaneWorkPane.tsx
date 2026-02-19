import React from "react";
import { useNavigate } from "react-router-dom";
import { MessageSquareText } from "lucide-react";
import { LaneTerminalsPanel } from "./LaneTerminalsPanel";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { CodexChatPage } from "../codex/CodexChatPage";

export function LaneWorkPane({
  laneId
}: {
  laneId: string | null;
}) {
  const navigate = useNavigate();
  const lanes = useAppStore((s) => s.lanes);
  const laneName = React.useMemo(() => lanes.find((lane) => lane.id === laneId)?.name ?? "", [lanes, laneId]);
  const [viewMode, setViewMode] = React.useState<"terminal" | "codex">("terminal");

  React.useEffect(() => {
    if (!laneId) {
      setViewMode("terminal");
    }
  }, [laneId]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border/20 px-2 py-1.5">
        <div className="flex items-center gap-2">
          <div className="text-xs font-semibold text-muted-fg">Work</div>
          {laneName ? <div className="text-xs text-fg/80">{laneName}</div> : null}
          <div className="ml-auto">
            <Button
              size="sm"
              variant="outline"
              disabled={!laneId}
              onClick={() => {
                if (!laneId) return;
                setViewMode("codex");
              }}
              title="Open Codex chat for this lane"
            >
              <MessageSquareText className="h-3.5 w-3.5" />
              Start Codex Chat
            </Button>
            {viewMode === "codex" && laneId ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  navigate(`/codex?laneId=${encodeURIComponent(laneId)}`);
                }}
                title="Open Codex in full page"
              >
                Open Full Page
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      <div className="relative flex-1 min-h-0">
        <div className="absolute inset-0 p-2">
          {viewMode === "codex" && laneId ? (
            <div className="h-full rounded-xl border border-border/20 bg-card/30 overflow-hidden">
              <CodexChatPage embedded laneIdOverride={laneId} onCloseEmbedded={() => setViewMode("terminal")} />
            </div>
          ) : (
            <LaneTerminalsPanel overrideLaneId={laneId} />
          )}
        </div>
      </div>
    </div>
  );
}

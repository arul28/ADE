import { useEffect, useRef } from "react";
import {
  Clipboard,
  FileText,
  Info,
  Monitor,
  Play,
  Stop as Square,
  X,
} from "@phosphor-icons/react";
import type { TerminalSessionSummary } from "../../../shared/types";
import { sanitizeTerminalInlineText } from "../../lib/terminalAttention";
import { formatToolTypeLabel, isChatToolType } from "../../lib/sessions";
import { getTerminalRuntimeHealth } from "./TerminalView";
import { SessionDeltaCard } from "./SessionDeltaCard";
import { Button } from "../ui/Button";

function runtimeStateLabel(state: TerminalSessionSummary["runtimeState"]): string {
  if (state === "waiting-input") return "waiting input";
  return state;
}

export type InfoPopoverState = {
  session: TerminalSessionSummary;
  x: number;
  y: number;
} | null;

export function SessionInfoPopover({
  popover,
  onClose,
  onCloseSession,
  onEndChat,
  onResume,
  onGoToLane,
  closingPtyIds,
  closingChatSessionId,
  resumingSessionId,
}: {
  popover: InfoPopoverState;
  onClose: () => void;
  onCloseSession: (args: { ptyId: string; sessionId: string }) => void;
  onEndChat: (sessionId: string) => void;
  onResume: (session: TerminalSessionSummary) => void;
  onGoToLane: (session: TerminalSessionSummary) => void;
  closingPtyIds: Set<string>;
  closingChatSessionId: string | null;
  resumingSessionId: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!popover) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [popover, onClose]);

  if (!popover) return null;

  const { session, x, y } = popover;
  const isChat = isChatToolType(session.toolType);
  const health = getTerminalRuntimeHealth(session.id);

  // Position: try to place to the right, but clamp to viewport
  const left = Math.min(x + 8, window.innerWidth - 420);
  const top = Math.min(y - 20, window.innerHeight - 500);

  return (
    <div
      ref={ref}
      className="fixed z-50 w-[400px] max-h-[80vh] overflow-auto rounded-lg bg-card backdrop-blur-md shadow-2xl border border-border/30"
      style={{ left, top }}
    >
      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border/10 bg-card/95 backdrop-blur-sm px-3 py-2">
        <span className="text-xs font-semibold truncate">{(session.goal ?? session.title).trim()}</span>
        <button
          type="button"
          onClick={onClose}
          className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-muted/40 text-muted-fg transition-colors"
        >
          <X size={12} />
        </button>
      </div>

      <div className="p-3 space-y-2.5">
        {/* Metadata */}
        <div className="rounded-lg border border-border/10 bg-card/60 backdrop-blur-sm p-2.5">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-fg/60">
            <Info size={12} weight="regular" />
            Session info
          </div>
          <div className="space-y-0">
            {([
              ["Title", (session.goal ?? session.title).trim()],
              ["Lane", session.laneName],
              ["Status", session.status],
              ["Runtime", runtimeStateLabel(session.runtimeState)],
              session.toolType ? ["Tool", formatToolTypeLabel(session.toolType)] : null,
              session.exitCode != null ? ["Exit", `${session.exitCode}`] : null,
              !session.tracked ? ["Context", "no context"] : null,
              ["Started", new Date(session.startedAt).toLocaleTimeString()],
              session.endedAt ? ["Ended", new Date(session.endedAt).toLocaleTimeString()] : null,
            ] as ([string, string] | null)[])
              .filter((row): row is [string, string] => row != null)
              .map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/30 transition-colors">
                  <span className="text-muted-fg/70 shrink-0">{label}</span>
                  <span className="truncate font-medium text-right">{value}</span>
                </div>
              ))}
          </div>
        </div>

        {/* Last output */}
        {sanitizeTerminalInlineText(session.lastOutputPreview, 420) ? (
          <div className="rounded-lg border border-border/10 bg-card/60 backdrop-blur-sm p-2.5">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-fg/60">
              <Monitor size={12} weight="regular" />
              Last output
            </div>
            <pre className="whitespace-pre-wrap break-words rounded border border-border/5 bg-[--color-surface-recessed] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted-fg/80">
              {sanitizeTerminalInlineText(session.lastOutputPreview, 420)}
            </pre>
          </div>
        ) : null}

        {/* Summary */}
        {session.summary && session.status !== "running" ? (
          <div className="rounded-lg border border-border/10 bg-card/60 backdrop-blur-sm p-2.5">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-fg/60">
              <FileText size={12} weight="regular" />
              Summary
            </div>
            <p className="text-xs leading-relaxed text-fg/70">{session.summary}</p>
          </div>
        ) : null}

        {/* Resume command */}
        {session.status !== "running" && session.resumeCommand ? (
          <div className="rounded-lg border border-border/10 bg-card/60 backdrop-blur-sm p-2.5">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-fg/60">
              <Play size={12} weight="regular" />
              Resume command
            </div>
            <code className="block rounded border border-border/5 bg-[--color-surface-recessed] px-2.5 py-1.5 font-mono text-[11px] text-fg/80">
              {session.resumeCommand}
            </code>
            <div className="mt-2 flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                disabled={resumingSessionId != null}
                onClick={() => onResume(session)}
              >
                <Play size={14} weight="regular" />
                {resumingSessionId === session.id ? "Resuming..." : "Resume"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { navigator.clipboard.writeText(session.resumeCommand ?? "").catch(() => {}); }}
              >
                <Clipboard size={14} weight="regular" />
                Copy
              </Button>
            </div>
          </div>
        ) : null}

        {/* Session Delta */}
        {session.status !== "running" ? (
          <SessionDeltaCard sessionId={session.id} />
        ) : null}

        {/* Terminal health */}
        {health ? (
          <div className="rounded-lg border border-border/10 bg-card/60 backdrop-blur-sm p-2.5">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-fg/60">
              <Info size={12} weight="regular" />
              Terminal health
            </div>
            <div className="grid grid-cols-2 gap-1 text-[11px] font-mono text-muted-fg/70">
              <span>fit_failures: {health.fitFailures}</span>
              <span>zero_dim: {health.zeroDimFits}</span>
              <span>renderer: {health.rendererFallbacks}</span>
              <span>dropped: {health.droppedChunks}</span>
            </div>
          </div>
        ) : null}

        {/* Actions */}
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {session.status === "running" && session.ptyId && !isChat ? (
            <Button
              variant="outline"
              size="sm"
              disabled={closingPtyIds.has(session.ptyId)}
              onClick={() => { if (session.ptyId) onCloseSession({ ptyId: session.ptyId, sessionId: session.id }); }}
            >
              <Square size={14} weight="regular" />
              {closingPtyIds.has(session.ptyId) ? "Closing..." : "Close"}
            </Button>
          ) : null}
          {session.status === "running" && isChat ? (
            <Button
              variant="outline"
              size="sm"
              disabled={closingChatSessionId === session.id}
              onClick={() => onEndChat(session.id)}
            >
              <Square size={14} weight="regular" />
              {closingChatSessionId === session.id ? "Ending..." : "End chat"}
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => onGoToLane(session)}>
            Go to lane
          </Button>
        </div>
      </div>
    </div>
  );
}

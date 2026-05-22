import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
  DotsThreeVertical,
  Info,
  StopCircle,
} from "@phosphor-icons/react";
import type { TerminalSessionSummary } from "../../../shared/types";
import { formatToolTypeLabel, primarySessionLabel, truncateSessionLabel } from "../../lib/sessions";
import { sessionNeedsUserInput, sessionStatusDot } from "../../lib/terminalAttention";
import { ChatGitToolbar } from "../chat/ChatGitToolbar";
import { SmartTooltip } from "../ui/SmartTooltip";
import { cn } from "../ui/cn";
import { ToolLogo } from "./ToolLogos";

export type WorkCliSessionHeaderProps = {
  session: TerminalSessionSummary;
  compact?: boolean;
  stopping?: boolean;
  onInfoClick?: (session: TerminalSessionSummary, event: ReactMouseEvent<HTMLElement>) => void;
  onContextMenu?: (session: TerminalSessionSummary, event: ReactMouseEvent<HTMLElement>) => void;
  onStopRunningSession?: (session: TerminalSessionSummary) => void;
};

function insertionTargetLabel(toolType: TerminalSessionSummary["toolType"]): string {
  switch (toolType) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex CLI";
    case "cursor-cli":
      return "Cursor CLI";
    case "opencode":
      return "OpenCode CLI";
    case "droid":
      return "Droid CLI";
    default:
      return formatToolTypeLabel(toolType);
  }
}

function runtimeLabel(session: TerminalSessionSummary): string {
  if (sessionNeedsUserInput({
    status: session.status,
    lastOutputPreview: session.lastOutputPreview,
    runtimeState: session.runtimeState,
    toolType: session.toolType,
    pendingInputItemId: session.pendingInputItemId,
  })) return "Awaiting input";
  if (session.runtimeState === "idle") return "Idle";
  if (session.runtimeState === "killed") return "Stopped";
  if (session.exitCode === 130 || session.exitCode === 143) return "Stopped";
  if (session.status === "running") return "Running";
  if (session.status === "failed") return "Failed";
  if (session.status === "completed") return "Completed";
  if (session.status === "disposed") return "Disposed";
  return formatToolTypeLabel(session.toolType);
}

function HeaderIconButton({
  label,
  description,
  disabled = false,
  children,
  onClick,
}: {
  label: string;
  description: string;
  disabled?: boolean;
  children: ReactNode;
  onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <SmartTooltip content={{ label, description }}>
      <button
        type="button"
        className={cn(
          "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors",
          "border-white/[0.06] bg-white/[0.025] text-muted-fg/55 hover:border-white/[0.12] hover:text-fg/85",
          disabled && "cursor-not-allowed opacity-45 hover:border-white/[0.06] hover:text-muted-fg/55",
        )}
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
      >
        {children}
      </button>
    </SmartTooltip>
  );
}

export function WorkCliSessionHeader({
  session,
  compact = false,
  stopping = false,
  onInfoClick,
  onContextMenu,
  onStopRunningSession,
}: WorkCliSessionHeaderProps) {
  const dot = sessionStatusDot(session);
  const title = truncateSessionLabel(primarySessionLabel(session), compact ? 24 : 44);
  const toolLabel = formatToolTypeLabel(session.toolType);
  const targetLabel = insertionTargetLabel(session.toolType);
  const statusLabel = runtimeLabel(session);
  const canStop = session.status === "running" && Boolean(session.ptyId) && Boolean(onStopRunningSession);

  const handleContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    if (!onContextMenu) return;
    event.preventDefault();
    event.stopPropagation();
    onContextMenu(session, event);
  };

  return (
    <div
      className={cn(
        "ade-work-cli-session-header flex w-full shrink-0 items-center gap-2 border-b border-white/[0.06] bg-card/85 px-3 py-2",
        compact && "gap-1.5 px-2 py-1.5",
      )}
      onContextMenu={handleContextMenu}
      data-testid="work-cli-session-header"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/[0.06] bg-white/[0.025]">
          <ToolLogo toolType={session.toolType} size={15} />
        </div>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-[13px] font-semibold text-fg/90" title={primarySessionLabel(session)}>
              {title}
            </span>
            <span
              title={dot.label}
              className={`${dot.cls} h-1.5 w-1.5 shrink-0${dot.spinning ? " animate-spin" : ""}`}
            />
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-fg/55">
            <span className="truncate">{toolLabel}</span>
            <span className="opacity-45">·</span>
            <span className="truncate">{session.laneName}</span>
            <span className="opacity-45">·</span>
            <span className="shrink-0">{statusLabel}</span>
          </div>
        </div>
      </div>

      {!compact ? (
        <div className="hidden min-w-0 shrink lg:block">
          <ChatGitToolbar laneId={session.laneId} />
        </div>
      ) : null}

      <div className="flex shrink-0 items-center gap-1">
        <HeaderIconButton
          label="Session info"
          description="Open metadata and session actions."
          disabled={!onInfoClick}
          onClick={(event) => onInfoClick?.(session, event)}
        >
          <Info size={13} />
        </HeaderIconButton>

        {canStop ? (
          <HeaderIconButton
            label={stopping ? "Stopping session" : `Stop ${targetLabel}`}
            description={`Terminate the running ${toolLabel}.`}
            disabled={stopping}
            onClick={() => onStopRunningSession?.(session)}
          >
            <StopCircle size={14} weight="regular" />
          </HeaderIconButton>
        ) : null}

        <HeaderIconButton
          label="Session actions"
          description="Rename, pin, copy links, archive, or delete this session."
          disabled={!onContextMenu}
          onClick={(event) => onContextMenu?.(session, event)}
        >
          <DotsThreeVertical size={14} weight="bold" />
        </HeaderIconButton>
      </div>
    </div>
  );
}

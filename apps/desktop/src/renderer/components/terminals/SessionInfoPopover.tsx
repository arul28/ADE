import { useEffect, useRef, useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Clipboard,
  FileText,
  Info,
  Monitor,
  Play,
  Stop as Square,
  Trash,
  X,
} from "@phosphor-icons/react";
import type { TerminalSessionStatus, TerminalSessionSummary } from "../../../shared/types";
import { sanitizeTerminalInlineText } from "../../lib/terminalAttention";
import { formatToolTypeLabel, isChatToolType } from "../../lib/sessions";
import { getTerminalRuntimeSnapshot } from "./TerminalView";
import { SessionDeltaCard } from "./SessionDeltaCard";
import { resolveTrackedCliResumeCommand } from "./cliLaunch";
import { Button } from "../ui/Button";
import { SmartTooltip } from "../ui/SmartTooltip";

function runtimeStateLabel(state: TerminalSessionSummary["runtimeState"]): string {
  if (state === "waiting-input") return "Waiting for input";
  if (state === "exited") return "Exited";
  if (state === "killed") return "Killed";
  if (state === "idle") return "Idle";
  if (state === "running") return "Running";
  return state;
}

function formatSessionStatus(s: TerminalSessionStatus): string {
  const map: Record<TerminalSessionStatus, string> = {
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    disposed: "Disposed",
  };
  return map[s] ?? s;
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function normalizeLoose(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function sectionShell({ title, icon: Icon, children }: { title: string; icon: typeof Info; children: ReactNode }) {
  return (
    <div className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] p-3 backdrop-blur-sm">
      <div className="mb-2 flex items-center gap-1.5 text-[10px] font-medium text-muted-fg/55">
        <Icon size={12} weight="regular" className="shrink-0 opacity-80" />
        {title}
      </div>
      {children}
    </div>
  );
}

/** Viewport-space anchor from the info trigger (`getBoundingClientRect`). */
export type SessionInfoAnchorRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type InfoPopoverState = {
  session: TerminalSessionSummary;
  anchor: SessionInfoAnchorRect;
} | null;

export function SessionInfoPopover({
  popover,
  onClose,
  onCloseSession,
  onEndChat,
  onDeleteChat,
  onDeleteSession,
  onResume,
  onGoToLane,
  closingPtyIds,
  closingChatSessionId,
  deletingSessionId,
  resumingSessionId,
}: {
  popover: InfoPopoverState;
  onClose: () => void;
  onCloseSession: (args: { ptyId: string; sessionId: string }) => void;
  onEndChat: (sessionId: string) => void;
  onDeleteChat: (session: TerminalSessionSummary) => void;
  onDeleteSession: (session: TerminalSessionSummary) => void;
  onResume: (session: TerminalSessionSummary) => void;
  onGoToLane: (session: TerminalSessionSummary) => void;
  closingPtyIds: Set<string>;
  closingChatSessionId: string | null;
  deletingSessionId: string | null;
  resumingSessionId: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const outsideDismissReadyRef = useRef(false);

  useEffect(() => {
    if (!popover) {
      outsideDismissReadyRef.current = false;
      return;
    }
    outsideDismissReadyRef.current = false;
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", keyHandler);

    // Wait until the popover has committed; then ignore a short window so the
    // opening click (incl. delayed synthetic click on touch) cannot dismiss.
    const readyT = window.setTimeout(() => {
      outsideDismissReadyRef.current = true;
    }, 80);

    let onDown: ((e: MouseEvent) => void) | undefined;
    const attachT = window.setTimeout(() => {
      onDown = (e: MouseEvent) => {
        if (!outsideDismissReadyRef.current) return;
        const t = e.target;
        if (!(t instanceof Node)) return;
        if (ref.current && !ref.current.contains(t)) onClose();
      };
      document.addEventListener("mousedown", onDown, false);
    }, 0);
    return () => {
      clearTimeout(readyT);
      clearTimeout(attachT);
      if (onDown) document.removeEventListener("mousedown", onDown, false);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [popover, onClose]);

  const lastPreview = popover?.session.lastOutputPreview;
  const lastOutputRaw = useMemo(
    () => sanitizeTerminalInlineText(lastPreview, 12_000) ?? "",
    [lastPreview],
  );

  if (!popover) return null;

  const { session, anchor } = popover;
  const isChat = isChatToolType(session.toolType);
  const runtime = getTerminalRuntimeSnapshot(session.id);
  const health = !isChat && runtime ? runtime.health ?? null : null;
  const resumeCommand = resolveTrackedCliResumeCommand(session);

  const summaryRaw = (session.summary ?? "").trim();
  const duplicateSummary =
    Boolean(lastOutputRaw && summaryRaw)
    && (normalizeLoose(lastOutputRaw) === normalizeLoose(summaryRaw)
      || (summaryRaw.length > 12
        && normalizeLoose(lastOutputRaw).startsWith(normalizeLoose(summaryRaw))));

  const showSummaryBlock = Boolean(
    summaryRaw
    && session.status !== "running"
    && !duplicateSummary,
  );
  const showLastOutput = Boolean(lastOutputRaw);

  const POPOVER_W = 400;
  const margin = 8;
  const popoverWidth = Math.min(POPOVER_W, window.innerWidth - 2 * margin);

  // Prefer to the right of the trigger (into the workspace); flip left if needed.
  let left = anchor.right + margin;
  if (left + popoverWidth > window.innerWidth - margin) {
    left = anchor.left - popoverWidth - margin;
  }
  left = Math.max(margin, Math.min(left, window.innerWidth - popoverWidth - margin));

  // Align with trigger top; clamp so the shell stays on-screen (content scrolls inside).
  let top = anchor.top - 4;
  top = Math.max(margin, Math.min(top, window.innerHeight - margin));

  const shell = (
    <div
      ref={ref}
      className="ade-liquid-glass ade-liquid-glass-menu fixed z-[2000] max-h-[min(80dvh,720px)] w-[min(100vw-1rem,22.5rem)] overflow-hidden rounded-2xl border border-white/[0.08] shadow-2xl"
      style={{ left, top, width: popoverWidth }}
    >
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-white/[0.06] bg-[color:color-mix(in_srgb,var(--color-card)_88%,transparent)] px-3 py-2.5 backdrop-blur-md">
        <span className="min-w-0 text-[13px] font-semibold leading-tight text-fg/90">
          {(session.goal ?? session.title).trim() || "Session"}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-fg transition-colors hover:bg-white/[0.06] hover:text-fg"
          aria-label="Close"
        >
          <X size={14} weight="bold" />
        </button>
      </div>

      <div className="max-h-[min(70dvh,640px)] space-y-2.5 overflow-y-auto overflow-x-hidden p-3 pb-3.5 scrollbar-none">
        {sectionShell({
          title: "Session info",
          icon: Info,
          children: (
            <div className="space-y-0.5">
              {(
                [
                  ["Title", (session.goal ?? session.title).trim() || "—"],
                  ["Lane", session.laneName || "—"],
                  ["State", formatSessionStatus(session.status)],
                  ["Process", runtimeStateLabel(session.runtimeState)],
                  session.toolType ? ["Tool", formatToolTypeLabel(session.toolType)] : null,
                  session.exitCode != null ? ["Exit code", String(session.exitCode)] : null,
                  !session.tracked ? ["Worktree", "Not linked to this lane’s worktree"] : null,
                  isChat && session.archivedAt ? ["Archived", formatWhen(session.archivedAt)] : null,
                  ["Started", formatWhen(session.startedAt)],
                  session.endedAt ? ["Ended", formatWhen(session.endedAt)] : null,
                  ["Session id", session.id] as [string, string],
                ] as const
              )
                .filter((row): row is [string, string] => row != null)
                .map(([label, value]) => (
                  <div
                    key={label}
                    className="flex min-h-[1.75rem] items-start justify-between gap-2 rounded-lg px-1.5 py-0.5 text-xs transition-colors hover:bg-white/[0.04]"
                  >
                    <span className="shrink-0 text-muted-fg/65">{label}</span>
                    {label === "Session id" ? (
                      <code className="max-w-[min(12rem,55vw)] truncate text-right font-mono text-[10px] text-muted-fg/85">
                        {value}
                      </code>
                    ) : (
                      <span className="min-w-0 text-right font-medium text-fg/90">{value}</span>
                    )}
                  </div>
                ))}
            </div>
          ),
        })}

        {showLastOutput
          ? sectionShell({
            title: isChat ? "Last event" : "Last output",
            icon: Monitor,
            children: (
              <pre className="ade-chat-recessed max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted-fg/80 scrollbar-none">
                {lastOutputRaw}
              </pre>
            ),
          })
          : null}

        {showSummaryBlock
          ? sectionShell({
            title: "Summary",
            icon: FileText,
            children: <p className="text-xs leading-relaxed text-fg/75">{session.summary}</p>,
          })
          : null}

        {session.status !== "running" && resumeCommand
          ? sectionShell({
            title: isChat ? "Resume" : "Resume command",
            icon: Play,
            children: (
              <div>
                <code className="ade-chat-recessed block max-h-32 overflow-y-auto break-all rounded-lg px-2.5 py-2 font-mono text-[10px] leading-relaxed text-fg/80 scrollbar-none">
                  {resumeCommand}
                </code>
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  <SmartTooltip
                    content={{
                      label: isChat ? "Resume" : "Resume in terminal",
                      description: isChat
                        ? "Continue or reopen this session using the stored resume key."
                        : "Spawn a terminal with the same tracked command line used for this session.",
                    }}
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={resumingSessionId != null}
                      onClick={() => onResume(session)}
                    >
                      <Play size={14} weight="regular" />
                      {resumingSessionId === session.id ? "Resuming..." : isChat ? "Resume" : "Run command"}
                    </Button>
                  </SmartTooltip>
                  <SmartTooltip content={{ label: "Copy", description: "Copy the resume value to the clipboard." }}>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void navigator.clipboard.writeText(resumeCommand);
                      }}
                    >
                      <Clipboard size={14} weight="regular" />
                      Copy
                    </Button>
                  </SmartTooltip>
                </div>
              </div>
            ),
          })
          : null}

        {session.status !== "running" ? <SessionDeltaCard sessionId={session.id} className="border-0 bg-white/[0.02]" /> : null}

        {health && !isChat
          ? sectionShell({
            title: "Terminal health",
            icon: Info,
            children: (
              <div className="grid grid-cols-1 gap-1.5 text-[10px] font-mono text-muted-fg/75 sm:grid-cols-2">
                <span>renderer: {runtime?.renderer ?? "dom"}</span>
                <span>fit_failures: {health.fitFailures}</span>
                <span>zero_dim: {health.zeroDimFits}</span>
                <span>renderer_fallbacks: {health.rendererFallbacks}</span>
                <span>dropped: {health.droppedChunks}</span>
                <span>fit_recoveries: {health.fitRecoveries}</span>
              </div>
            ),
          })
          : null}

        <div className="flex flex-wrap gap-1.5 border-t border-white/[0.06] pt-2.5">
          {session.status === "running" && session.ptyId && !isChat ? (
            <SmartTooltip content={{ label: "Close", description: "End this running terminal process." }}>
              <Button
                variant="outline"
                size="sm"
                disabled={closingPtyIds.has(session.ptyId)}
                onClick={() => {
                  if (session.ptyId) onCloseSession({ ptyId: session.ptyId, sessionId: session.id });
                }}
              >
                <Square size={14} weight="regular" />
                {closingPtyIds.has(session.ptyId) ? "Closing…" : "Close"}
              </Button>
            </SmartTooltip>
          ) : null}
          {session.status === "running" && isChat ? (
            <SmartTooltip content={{ label: "End chat", description: "Stop the in-progress chat for this session." }}>
              <Button
                variant="outline"
                size="sm"
                disabled={closingChatSessionId === session.id}
                onClick={() => onEndChat(session.id)}
              >
                <Square size={14} weight="regular" />
                {closingChatSessionId === session.id ? "Ending…" : "End chat"}
              </Button>
            </SmartTooltip>
          ) : null}
          {session.status !== "running" && isChat ? (
            <SmartTooltip content={{ label: "Delete chat", description: "Permanently remove this chat from the project." }}>
              <Button
                variant="danger"
                size="sm"
                disabled={deletingSessionId === session.id}
                onClick={() => onDeleteChat(session)}
              >
                <Trash size={14} weight="regular" />
                {deletingSessionId === session.id ? "Deleting…" : "Delete chat"}
              </Button>
            </SmartTooltip>
          ) : null}
          {session.status !== "running" && !isChat ? (
            <SmartTooltip content={{ label: "Delete session", description: "Remove this terminal session from history." }}>
              <Button
                variant="danger"
                size="sm"
                disabled={deletingSessionId === session.id}
                onClick={() => onDeleteSession(session)}
              >
                <Trash size={14} weight="regular" />
                {deletingSessionId === session.id ? "Deleting…" : "Delete session"}
              </Button>
            </SmartTooltip>
          ) : null}
          <SmartTooltip content={{ label: "Open lane", description: "Open the Lanes view for this session’s lane." }}>
            <Button variant="outline" size="sm" onClick={() => onGoToLane(session)}>
              Open lane
            </Button>
          </SmartTooltip>
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined" && document.body
    ? createPortal(shell, document.body)
    : shell;
}

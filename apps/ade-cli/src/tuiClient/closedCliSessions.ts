import type { AgentChatScheduledWorkState, AgentChatSessionSummary } from "../../../desktop/src/shared/types/chat";
import type { ChatTerminalSession } from "../../../desktop/src/shared/types/sessions";
import type { TuiChatTerminalSession, TuiSessionLifecycleFields } from "./adeApi";
import { formatRelativePastTime } from "./relativeTime";
import { theme } from "./theme";
import type { AdeCodeProvider } from "./types";
import { TUI_PROVIDERS } from "./providerMetadata";
import { statusGlyph, type StatusKind } from "./components/designKit";

export type ClosedCliSessionSummary = AgentChatSessionSummary & {
  terminalStatus?: ChatTerminalSession["status"];
  terminalExitCode?: ChatTerminalSession["exitCode"];
  terminalRuntimeState?: ChatTerminalSession["runtimeState"];
} & TuiSessionLifecycleFields;

export type DrawerChatAction = "new-chat" | "closed-toggle";

export type DrawerChatListItem =
  | { kind: "chat"; session: AgentChatSessionSummary }
  | { kind: "closed-toggle"; laneId: string; count: number; expanded: boolean }
  | { kind: "closed-chat"; session: ClosedCliSessionSummary };

export const RIGHT_CHAT_CLOSED_TOGGLE_ID = "__closed_cli_toggle__";

export function terminalSessionResumeProvider(session: ChatTerminalSession | null | undefined): AdeCodeProvider | null {
  const provider = session?.resumeMetadata?.provider ?? null;
  if (provider && TUI_PROVIDERS.has(provider as AdeCodeProvider)) return provider as AdeCodeProvider;
  const toolType = session?.toolType ?? "";
  if (toolType.startsWith("codex")) return "codex";
  if (toolType.startsWith("cursor")) return "cursor";
  if (toolType.startsWith("droid")) return "droid";
  if (toolType.startsWith("opencode")) return "opencode";
  if (toolType.startsWith("claude")) return "claude";
  return null;
}

export function terminalSessionProvider(session: ChatTerminalSession | null | undefined): AdeCodeProvider | null {
  return terminalSessionResumeProvider(session) ?? (session ? "claude" : null);
}

export function isTerminalSessionResumable(session: ChatTerminalSession | null | undefined): boolean {
  return Boolean(
    session
      && session.status !== "running"
      && terminalSessionResumeProvider(session)
      && (session.resumeMetadata || session.resumeCommand),
  );
}

/** Narrow a terminal session's derived provider to an AgentChatProvider (CLI terminals are always one of the five). */
function terminalSummaryProvider(session: ChatTerminalSession): AgentChatSessionSummary["provider"] {
  const provider = terminalSessionProvider(session);
  return provider === "codex" || provider === "claude" || provider === "opencode" || provider === "cursor" || provider === "droid"
    ? provider
    : "claude";
}

export function terminalSessionToChatSummary(
  session: ChatTerminalSession,
  scheduledWorkState?: AgentChatScheduledWorkState | null,
): ClosedCliSessionSummary {
  const lifecycle = session as TuiChatTerminalSession;
  const status: AgentChatSessionSummary["status"] = session.status === "running"
    ? session.runtimeState === "idle" ? "idle" : "active"
    : "ended";
  const provider = terminalSummaryProvider(session);
  return {
    sessionId: session.terminalId,
    laneId: session.laneId,
    provider,
    model: provider === "claude" ? "claude-code" : `${provider} cli`,
    title: session.title,
    goal: session.goal,
    permissionMode: session.resumeMetadata?.launch?.permissionMode ?? "default",
    status,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    lastActivityAt: lifecycle.lastActivityAt ?? session.endedAt ?? session.startedAt,
    lastOutputPreview: session.lastOutputPreview,
    summary: session.summary,
    awaitingInput: session.runtimeState === "waiting-input",
    nextWakeAt: scheduledWorkState?.nextWakeAt ?? null,
    scheduledWorkPaused: scheduledWorkState?.paused === true,
    scheduledWork: scheduledWorkState?.items ?? [],
    surface: "work",
    ...(session.resumeMetadata?.orchestrationParentSessionId
      ? { orchestrationParentSessionId: session.resumeMetadata.orchestrationParentSessionId }
      : {}),
    ...(session.resumeMetadata?.spawnKind
      ? { spawnKind: session.resumeMetadata.spawnKind }
      : {}),
    terminalStatus: session.status,
    terminalExitCode: session.exitCode,
    terminalRuntimeState: session.runtimeState,
    settledAt: lifecycle.settledAt ?? null,
    statusNote: lifecycle.statusNote ?? null,
    attentionRequestedAt: lifecycle.attentionRequestedAt ?? null,
    attentionMessage: lifecycle.attentionMessage ?? null,
    lastTurnFailedAt: lifecycle.lastTurnFailedAt ?? null,
  };
}

export function sortSessionsByRecentActivity<T extends { startedAt: string; lastActivityAt?: string | null }>(sessions: T[]): T[] {
  return [...sessions].sort((left, right) => {
    const rightMs = Date.parse(right.lastActivityAt ?? right.startedAt);
    const leftMs = Date.parse(left.lastActivityAt ?? left.startedAt);
    return (Number.isFinite(rightMs) ? rightMs : 0) - (Number.isFinite(leftMs) ? leftMs : 0);
  });
}

export function deriveClosedCliSessions(
  terminalSessions: ChatTerminalSession[],
  scheduledWorkStateById: Record<string, AgentChatScheduledWorkState> = {},
): ClosedCliSessionSummary[] {
  return sortSessionsByRecentActivity(
    terminalSessions
      .filter((session) => session.status !== "running" && terminalSessionProvider(session) != null)
      .map((session) => terminalSessionToChatSummary(session, scheduledWorkStateById[session.terminalId])),
  );
}

export function deriveOpenDrawerSessions(
  displaySessions: AgentChatSessionSummary[],
  closedCliSessions: AgentChatSessionSummary[],
): AgentChatSessionSummary[] {
  const closedCliSessionIds = new Set(closedCliSessions.map((session) => session.sessionId));
  return displaySessions.filter((session) => !closedCliSessionIds.has(session.sessionId));
}

export function buildDrawerChatItems(args: {
  openSessions: AgentChatSessionSummary[];
  closedSessions: ClosedCliSessionSummary[];
  closedToggleVisible: boolean;
  closedExpanded: boolean;
  laneId: string | null;
}): DrawerChatListItem[] {
  const items: DrawerChatListItem[] = args.openSessions.map((session) => ({ kind: "chat", session }));
  if (args.closedToggleVisible && args.laneId) {
    items.push({
      kind: "closed-toggle",
      laneId: args.laneId,
      count: args.closedSessions.length,
      expanded: args.closedExpanded,
    });
    if (args.closedExpanded) {
      items.push(...args.closedSessions.map((session): DrawerChatListItem => ({ kind: "closed-chat", session })));
    }
  }
  return items;
}

export function sessionFromDrawerChatItem(item: DrawerChatListItem | null | undefined): AgentChatSessionSummary | null {
  return item?.kind === "chat" || item?.kind === "closed-chat" ? item.session : null;
}

export function drawerChatActionForItem(item: DrawerChatListItem | null | undefined): DrawerChatAction | null {
  return item?.kind === "closed-toggle" ? "closed-toggle" : null;
}

// Exit 130 (Ctrl+C) and 143 (SIGTERM) are user-initiated closes — the daemon
// classifies them as disposed/killed, not failed (ptyService.statusFromExit),
// so only genuine failures may render the failed glyph here.
const USER_CLOSE_EXIT_CODES = new Set([0, 130, 143]);

export function closedCliSessionStatusKind(session: AgentChatSessionSummary): StatusKind {
  const closed = session as ClosedCliSessionSummary;
  if (
    closed.terminalStatus === "failed"
    || (closed.terminalExitCode != null && !USER_CLOSE_EXIT_CODES.has(closed.terminalExitCode))
  ) {
    return "failed";
  }
  return "idle";
}

export function closedCliRightPaneRow(session: AgentChatSessionSummary, activeSessionId: string | null): string {
  const status = statusGlyph(closedCliSessionStatusKind(session));
  const marker = session.sessionId === activeSessionId ? "●" : status.glyph;
  const provider = theme.provider((session.provider as AdeCodeProvider) ?? null);
  const ended = formatRelativePastTime(session.endedAt ?? session.lastActivityAt ?? session.startedAt);
  return `${marker} ${provider.glyph} ${session.title ?? session.sessionId} · ended ${ended}`;
}

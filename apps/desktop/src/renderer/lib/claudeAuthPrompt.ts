import type { AgentChatEvent, AgentChatEventEnvelope, TerminalSessionSummary } from "../../shared/types";

export const CLAUDE_AUTH_LOGIN_COMMAND = "claude auth login";

const CLAUDE_AUTH_ERROR_PATTERNS: RegExp[] = [
  /\bplease\s+run\s+\/login\b/i,
  /\bapi\s+error:\s*401\b.*\binvalid\s+authentication\s+credentials\b/i,
  /\binvalid\s+authentication\s+credentials\b/i,
  /\bclaude\b.*\b(not\s+logged\s+in|not\s+authenticated|unauthorized|authentication\s+failed|login\s+required)\b/i,
  /\brun\s+[`'"]?claude\s+auth\s+login[`'"]?/i,
  /\brun\s+[`'"]?claude\s+\/login[`'"]?/i,
];

const CLAUDE_CLI_TOOL_TYPES = new Set<TerminalSessionSummary["toolType"]>([
  "claude",
  "claude-orchestrated",
]);

function eventText(event: AgentChatEvent): string {
  if (event.type !== "error") return "";
  return `${event.message ?? ""}\n${event.detail ?? ""}`;
}

export function textHasClaudeAuthError(value: string | null | undefined): boolean {
  const text = value?.trim();
  if (!text) return false;
  return CLAUDE_AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

function isClaudeAuthErrorEvent(event: AgentChatEvent): boolean {
  if (event.type !== "error") return false;
  const info = typeof event.errorInfo === "object" && event.errorInfo ? event.errorInfo : null;
  if (info?.agentCli?.agent === "claude" && info.agentCli.category === "unauthenticated") return true;
  return textHasClaudeAuthError(eventText(event));
}

function isSuccessfulConversationBoundary(event: AgentChatEvent): boolean {
  if (event.type === "text" && event.text.trim().length > 0) return true;
  if (event.type === "done" && event.status === "completed") return true;
  if (event.type === "tool_call" || event.type === "tool_result") return true;
  return false;
}

export function shouldShowClaudeChatLoginPrompt({
  provider,
  events,
  turnActive = false,
  authAvailable = false,
}: {
  provider: string | null | undefined;
  events: AgentChatEventEnvelope[];
  turnActive?: boolean;
  authAvailable?: boolean;
}): boolean {
  if (provider !== "claude" || turnActive) return false;

  for (let index = events.length - 1; index >= 0 && index >= events.length - 80; index -= 1) {
    const event = events[index]?.event;
    if (!event) continue;
    if (isClaudeAuthErrorEvent(event)) return true;
    if (isSuccessfulConversationBoundary(event)) return false;
    if (event.type === "status" && event.turnStatus === "started") return false;
  }

  return !authAvailable && events.length > 0 && events.some(({ event }) => isClaudeAuthErrorEvent(event));
}

export function shouldShowClaudeCliLoginPrompt(
  session: TerminalSessionSummary,
  extraTranscriptText?: string | null,
): boolean {
  if (!CLAUDE_CLI_TOOL_TYPES.has(session.toolType)) return false;

  const previewHasAuthError = textHasClaudeAuthError(session.lastOutputPreview);
  const detected = textHasClaudeAuthError([
    session.lastOutputPreview,
    session.summary,
    extraTranscriptText,
  ].filter(Boolean).join("\n"));
  if (!detected) return false;

  const liveHealthySession = session.status === "running"
    && (session.runtimeState === "running" || session.runtimeState === "idle")
    && !previewHasAuthError
    && Boolean(session.lastOutputPreview?.trim());
  return !liveHealthySession;
}

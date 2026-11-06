import type { AgentChatEvent, AgentChatEventEnvelope, TerminalSessionSummary } from "../../shared/types";

export const CLAUDE_AUTH_LOGIN_COMMAND = "claude auth login";

const CLAUDE_INVALID_CREDENTIALS_PATTERNS: RegExp[] = [
  /\bapi\s+error:\s*401\b.*\binvalid\s+authentication\s+credentials\b/i,
  /\binvalid\s+authentication\s+credentials\b/i,
];
const CLAUDE_TEXT_AUTH_ERROR_PATTERN = /\bapi\s+error:\s*401\b.*\binvalid\s+authentication\s+credentials\b/i;

const CLAUDE_AUTH_ERROR_PATTERNS: RegExp[] = [
  /\bplease\s+run\s+\/login\b/i,
  ...CLAUDE_INVALID_CREDENTIALS_PATTERNS,
  /\bclaude\b.*\bauthentication[_\s-]*failed\b/i,
  // ADE's own classified message reads "Authentication failed for <model>. Check
  // your API key in Settings." — "claude" follows the keyword there, so the
  // claude-first patterns above miss it. Keep the match Claude-specific so tool
  // auth failures in a Claude chat do not trigger the Claude login CTA.
  /\bauthentication\s+failed\s+for\b.*\bclaude\b/i,
  /\bclaude\b.*\bfailed\s+to\s+authenticate\b/i,
  /\bclaude\b.*\b(not\s+logged\s+in|not\s+authenticated|unauthorized|authentication\s+failed|login\s+required)\b/i,
  /\brun\s+[`'"]?claude\s+auth\s+login[`'"]?/i,
  /\brun\s+[`'"]?claude\s+\/login[`'"]?/i,
];

const CLAUDE_CLI_TOOL_TYPES = new Set<TerminalSessionSummary["toolType"]>([
  "claude",
  "claude-orchestrated",
]);

function noticeDetailText(detail: Extract<AgentChatEvent, { type: "system_notice" }>["detail"]): string {
  if (typeof detail === "string") return detail;
  if (!detail || typeof detail !== "object") return "";
  return [
    typeof detail.title === "string" ? detail.title : "",
    typeof detail.summary === "string" ? detail.summary : "",
    ...(Array.isArray(detail.metrics) ? detail.metrics.map((metric) => `${metric.label}: ${metric.value}`) : []),
    ...(Array.isArray(detail.sections)
      ? detail.sections.flatMap((section) => [
          section.title,
          ...section.items.map((item) => typeof item === "string" ? item : `${item.label}: ${item.value}`),
        ])
      : []),
  ].filter(Boolean).join("\n");
}

function eventText(event: AgentChatEvent): string {
  if (event.type === "error") return `${event.message ?? ""}\n${event.detail ?? ""}`;
  if (event.type === "system_notice") return `${event.message ?? ""}\n${event.status ?? ""}\n${noticeDetailText(event.detail)}`;
  if (event.type === "text") return event.text ?? "";
  return "";
}

export function textHasClaudeAuthError(value: string | null | undefined): boolean {
  const text = value?.trim();
  if (!text) return false;
  return CLAUDE_AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

function isClaudeAuthErrorEvent(event: AgentChatEvent, options?: { allowTextAuthError?: boolean }): boolean {
  if (event.type === "error") {
    const info = typeof event.errorInfo === "object" && event.errorInfo ? event.errorInfo : null;
    if (info?.agentCli?.agent === "claude" && info.agentCli.category === "unauthenticated") return true;
    return textHasClaudeAuthError(eventText(event));
  }
  if (event.type === "system_notice") {
    const text = eventText(event);
    if (event.noticeKind !== "auth" && !/\bclaude\b/i.test(text)) return false;
    return textHasClaudeAuthError(text);
  }
  if (event.type === "text") {
    return options?.allowTextAuthError === true && CLAUDE_TEXT_AUTH_ERROR_PATTERN.test(eventText(event));
  }
  return false;
}

function isSuccessfulConversationBoundary(event: AgentChatEvent): boolean {
  if (event.type === "text" && event.text.trim().length > 0) return true;
  if (event.type === "done" && event.status === "completed") return true;
  if (event.type === "tool_call" || event.type === "tool_result") return true;
  return false;
}

/** The agent a turn's error says is signed out, when it says so. */
function signedOutAgent(
  event: AgentChatEvent,
  provider: string,
  options: { allowTextAuthError: boolean },
): string | null {
  if (event.type === "error") {
    const info = typeof event.errorInfo === "object" && event.errorInfo ? event.errorInfo : null;
    if (info?.agentCli?.category === "unauthenticated") return info.agentCli.agent;
  }
  // Claude's sign-in failures also arrive as plain text from older hosts.
  if (provider === "claude" && isClaudeAuthErrorEvent(event, options)) return "claude";
  return null;
}

/**
 * The chat's last turn stopped because the chat's own provider is signed out,
 * and nothing has worked since. Returns which event said so (its id keys the
 * card, so a dismissed card comes back for the next failure), or null.
 */
export function latestChatSignInFailure({
  provider,
  events,
  turnActive = false,
}: {
  provider: string | null | undefined;
  events: AgentChatEventEnvelope[];
  turnActive?: boolean;
}): { provider: string; eventKey: string } | null {
  if (!provider || turnActive) return null;
  let sawFailedTurnBoundary = false;
  for (let index = events.length - 1; index >= 0 && index >= events.length - 80; index -= 1) {
    const envelope = events[index];
    const event = envelope?.event;
    if (!event) continue;
    if ((event.type === "done" && event.status === "failed") || (event.type === "status" && event.turnStatus === "failed")) {
      sawFailedTurnBoundary = true;
      continue;
    }
    const agent = signedOutAgent(event, provider, { allowTextAuthError: sawFailedTurnBoundary });
    if (agent) {
      // A tool's own CLI being signed out is not the chat's provider.
      if (agent !== provider) return null;
      return { provider, eventKey: `${envelope.sequence ?? index}:${envelope.timestamp ?? ""}` };
    }
    if (isSuccessfulConversationBoundary(event)) return null;
    if (event.type === "status" && event.turnStatus === "started") return null;
  }
  return null;
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

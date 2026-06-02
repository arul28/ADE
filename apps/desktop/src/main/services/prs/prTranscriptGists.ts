import type { AgentChatSessionSummary, AgentChatTranscriptEntry } from "../../../shared/types";

export const MAX_PR_TRANSCRIPT_GIST_SESSIONS = 20;
export const MAX_PR_TRANSCRIPT_GIST_CHARS = 240_000;

export type PrTranscriptGistContext = {
  repoOwner: string;
  repoName: string;
  prNumber: number;
  githubUrl: string;
  laneId: string;
  laneName: string;
  exportedAt: string;
  session: AgentChatSessionSummary;
  entries: AgentChatTranscriptEntry[];
};

export function formatPrTranscriptGistMarkdown(context: PrTranscriptGistContext): string {
  const sessionTitle = inlineText(context.session.title) || defaultSessionTitle(context.session);
  const lines: string[] = [
    `# ${escapeHeading(sessionTitle)}`,
    "",
    `- Repository: \`${context.repoOwner}/${context.repoName}\``,
    `- Pull request: [#${context.prNumber}](${context.githubUrl})`,
    `- Lane: ${inlineText(context.laneName) || context.laneId} (\`${context.laneId}\`)`,
    `- Session: \`${context.session.sessionId}\``,
    `- Provider: ${inlineText(context.session.provider) || "unknown"}`,
    `- Model: ${inlineText(context.session.model || context.session.modelId) || "unknown"}`,
    `- Exported: ${context.exportedAt}`,
    "- Visibility: secret gist (link-accessible)",
    "",
    "## Transcript",
    "",
  ];

  if (!context.entries.length) {
    lines.push("_No user or assistant transcript entries were captured for this session._");
  } else {
    context.entries.forEach((entry, index) => {
      const role = entry.role === "user" ? "User" : "Assistant";
      const timestamp = inlineText(entry.timestamp);
      lines.push(`### ${role}${timestamp ? ` - ${timestamp}` : ""}`);
      lines.push("");
      const text = (entry.displayText || entry.text || "").trim();
      lines.push(text || "_Empty message._");
      if (index < context.entries.length - 1) lines.push("");
    });
  }

  return truncateMarkdown(lines.join("\n").trimEnd() + "\n");
}

export function transcriptGistDescription(context: {
  repoOwner: string;
  repoName: string;
  prNumber: number;
  session: Pick<AgentChatSessionSummary, "title" | "sessionId">;
}): string {
  const title = inlineText(context.session.title) || context.session.sessionId;
  return `ADE chat transcript for ${context.repoOwner}/${context.repoName}#${context.prNumber}: ${title}`;
}

export function transcriptGistLinkTitle(session: Pick<AgentChatSessionSummary, "title" | "provider" | "sessionId">): string {
  const title = inlineText(session.title) || defaultSessionTitle(session);
  const provider = inlineText(session.provider);
  return provider ? `${title} (${provider})` : title;
}

function defaultSessionTitle(session: Pick<AgentChatSessionSummary, "provider" | "sessionId">): string {
  const provider = inlineText(session.provider);
  return provider ? `${provider} chat ${session.sessionId.slice(0, 8)}` : `ADE chat ${session.sessionId.slice(0, 8)}`;
}

function inlineText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function escapeHeading(value: string): string {
  return value.replace(/^#+\s*/g, "").trim() || "ADE chat transcript";
}

function truncateMarkdown(value: string): string {
  if (value.length <= MAX_PR_TRANSCRIPT_GIST_CHARS) return value;
  return `${value.slice(0, MAX_PR_TRANSCRIPT_GIST_CHARS - 96).trimEnd()}\n\n_Transcript truncated by ADE before gist publication._\n`;
}

import type { TerminalSessionSummary } from "../../shared/types";
import { isChatToolType } from "./sessions";

function markdownLine(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function formatSessionBundleMarkdown(sessions: TerminalSessionSummary[]): string {
  const header = `# ADE session bundle\n\nExported: ${new Date().toISOString()}\nSessions: ${sessions.length}\n\n---\n\n`;
  const parts = sessions.map((session) => {
    const kind = isChatToolType(session.toolType) ? "Chat" : "Terminal";
    const title = markdownLine(session.title) || session.id;
    const goal = markdownLine(session.goal);
    const lane = markdownLine(session.laneName) || markdownLine(session.laneId);
    const started = markdownLine(session.startedAt);
    const ended = markdownLine(session.endedAt);
    const status = markdownLine(session.status);
    const tool = markdownLine(session.toolType);
    const lines: string[] = [];
    lines.push(`## ${title}`);
    lines.push("");
    lines.push(`- **Kind:** ${kind}`);
    lines.push(`- **Session ID:** \`${session.id}\``);
    if (lane) lines.push(`- **Lane:** ${lane}`);
    if (status) lines.push(`- **Status:** ${status}`);
    if (started) lines.push(`- **Started:** ${started}`);
    if (ended) lines.push(`- **Ended:** ${ended}`);
    if (tool) lines.push(`- **Tool:** ${tool}`);
    if (goal) {
      lines.push("");
      lines.push(`**Goal:** ${goal}`);
    }
    lines.push("");
    return lines.join("\n");
  });
  return header + parts.join("\n---\n\n");
}

export function triggerBrowserDownload(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  let appended = false;
  try {
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    appended = true;
    anchor.click();
  } finally {
    if (appended) {
      document.body.removeChild(anchor);
    }
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

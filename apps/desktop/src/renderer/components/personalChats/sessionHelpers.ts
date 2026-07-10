import type { AgentChatSessionSummary } from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
import type { ToolLogo } from "../terminals/ToolLogos";

export function sessionTitle(session: AgentChatSessionSummary): string {
  const title = session.title?.trim() || session.goal?.trim() || session.summary?.trim();
  if (title) return title;
  return getModelById(session.modelId ?? "")?.displayName ?? "New chat";
}

export function sessionPreview(session: AgentChatSessionSummary): string {
  return session.lastOutputPreview?.trim() || session.summary?.trim() || "Start a conversation";
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function providerToolType(provider: string): Parameters<typeof ToolLogo>[0]["toolType"] {
  if (provider === "claude") return "claude-chat";
  if (provider === "codex") return "codex-chat";
  if (provider === "cursor") return "cursor";
  if (provider === "droid") return "droid-chat";
  return "opencode-chat";
}

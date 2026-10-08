import type { AgentChatSessionSummary } from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
import type { ToolLogo } from "../terminals/ToolLogos";
import { chatToolTypeForProvider } from "../../lib/sessions";
import {
  sessionStatusPresentation,
  type SessionStatusPresentation,
} from "../../../shared/sessionStatusPresentation";

/** The square icon buttons in a chat header: the Chats page's and the Browser tab's dock. */
export const CHAT_HEADER_BUTTON =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-fg/[0.06] bg-fg/[0.025] text-muted-fg/45 transition-colors hover:text-fg disabled:opacity-35 disabled:hover:text-muted-fg/45";

export function sessionTitle(session: AgentChatSessionSummary): string {
  const title = session.title?.trim() || session.goal?.trim() || session.summary?.trim();
  if (title) return title;
  return getModelById(session.modelId ?? "")?.displayName ?? "New chat";
}

export function sessionPreview(session: AgentChatSessionSummary): string {
  return session.lastOutputPreview?.trim() || session.summary?.trim() || "Start a conversation";
}

/**
 * The rail's status word for a chat, in the Work row's vocabulary: "Needs you"
 * after the agent's `ade chat ask`, the activity it reported or ADE detected
 * ("Testing") during a live turn, else "Working" while it streams. Null at rest.
 */
export function sessionRowStatus(session: AgentChatSessionSummary): SessionStatusPresentation | null {
  if (session.attentionRequestedAt) return sessionStatusPresentation("needs_you");
  if (session.status !== "active") return null;
  return sessionStatusPresentation("running", {}, {
    activityStatus: session.activityStatus ?? null,
    currentTurnStartedAt: session.currentTurnStartedAt ?? null,
  });
}

/** The row's second line: the agent's own status note when it left one. */
export function sessionRowDetail(session: AgentChatSessionSummary): string {
  return session.statusNote?.trim() || sessionPreview(session);
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
  return chatToolTypeForProvider(provider);
}

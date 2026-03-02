/** Shared session/terminal utilities for the renderer. */

/** Returns true if the tool type represents an AI chat session. */
export function isChatToolType(toolType: string | null | undefined): boolean {
  return toolType === "codex-chat" || toolType === "claude-chat" || toolType === "ai-chat";
}

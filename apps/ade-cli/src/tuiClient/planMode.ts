import type { AgentChatEventEnvelope } from "../../../desktop/src/shared/types/chat";
import type { AdeCodeModelState } from "./types";

export function isPlanMode(modelState: AdeCodeModelState): boolean {
  if (modelState.provider === "claude") {
    return modelState.claudePermissionMode === "plan" || modelState.interactionMode === "plan";
  }
  if (modelState.provider === "codex") {
    return modelState.codexApprovalPolicy === "on-request" && modelState.codexSandbox === "read-only";
  }
  if (modelState.provider === "opencode") return modelState.opencodePermissionMode === "plan";
  if (modelState.provider === "droid") return modelState.droidPermissionMode === "read-only";
  if (modelState.provider === "cursor") return modelState.cursorModeId === "plan";
  return false;
}

export function hasFirstUserMessage(events: AgentChatEventEnvelope[]): boolean {
  for (const envelope of events) {
    if ((envelope.event as { type?: string } | null)?.type === "user_message") return true;
  }
  return false;
}

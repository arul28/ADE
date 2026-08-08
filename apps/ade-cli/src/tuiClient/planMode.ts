import type { AgentChatEventEnvelope } from "../../../desktop/src/shared/types/chat";
import type { AdeCodeModelState } from "./types";
import { usesToolPermissionModes } from "./modelState";

export function isPlanMode(modelState: AdeCodeModelState): boolean {
  if (usesToolPermissionModes(modelState.provider)) return modelState.opencodePermissionMode === "plan";
  switch (modelState.provider) {
    case "claude":
      return modelState.claudePermissionMode === "plan" || modelState.interactionMode === "plan";
    case "codex":
      return modelState.codexApprovalPolicy === "on-request" && modelState.codexSandbox === "read-only";
    case "droid":
      return modelState.droidPermissionMode === "read-only";
    case "cursor":
      return modelState.cursorModeId === "plan";
    default:
      return false;
  }
}

export function hasFirstUserMessage(events: AgentChatEventEnvelope[]): boolean {
  for (const envelope of events) {
    if ((envelope.event as { type?: string } | null)?.type === "user_message") return true;
  }
  return false;
}

import type { AgentChatCrossMachineHandoffRecord } from "./types/chat";

export type CrossMachineMoveLock = {
  handoffId: string;
  targetMachineName: string;
  targetSessionId: string;
};

/** A source chat is locked only while its latest move is still continued away. */
export function crossMachineMoveLock(
  record: AgentChatCrossMachineHandoffRecord | null | undefined,
): CrossMachineMoveLock | null {
  if (!record || record.state !== "continued" || record.resumedHere) return null;
  const handoffId = record.handoffId?.trim() || record.continuedOn?.handoffId?.trim() || "unknown";
  const targetMachineName = record.targetMachineName?.trim() || record.continuedOn?.targetMachineName?.trim() || "another machine";
  const targetSessionId = record.targetSessionId?.trim() || record.continuedOn?.targetSessionId?.trim() || "unknown";
  return { handoffId, targetMachineName, targetSessionId };
}

/** Stable typed refusal shared by explicit turns and automatic delivery paths. */
export class MovedAwayChatError extends Error {
  readonly code = "CHAT_MOVED_AWAY";
  readonly sessionId: string;
  readonly targetSessionId: string;
  readonly targetMachineName: string;

  constructor(sessionId: string, target: CrossMachineMoveLock) {
    super(
      `This chat continues on ${target.targetMachineName}. Send there instead (chat ${target.targetSessionId}), or choose "Work here instead" first.`,
    );
    this.name = "MovedAwayChatError";
    this.sessionId = sessionId;
    this.targetSessionId = target.targetSessionId;
    this.targetMachineName = target.targetMachineName;
  }
}

export function isMovedAwayChatError(error: unknown): error is MovedAwayChatError {
  return error instanceof MovedAwayChatError
    || (error != null && typeof error === "object" && (error as { code?: unknown }).code === "CHAT_MOVED_AWAY");
}

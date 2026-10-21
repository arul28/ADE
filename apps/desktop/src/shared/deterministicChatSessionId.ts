import { createHash } from "node:crypto";

/** Stable chat identifier shared by the source and destination handoff paths. */
export function deterministicChatSessionId(idempotencyKey: string): string {
  const bytes = createHash("sha256").update(`ade-agent-chat:${idempotencyKey}`, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The create-chat idempotency key of the destination chat a move with this handoff id creates. */
export function crossMachineDestinationIdempotencyKey(handoffId: string): string {
  return `cross-machine-handoff:${handoffId}`;
}

/** The destination chat a single move (or a batch item's move) with this handoff id creates. */
export function crossMachineDestinationSessionId(handoffId: string): string {
  return deterministicChatSessionId(crossMachineDestinationIdempotencyKey(handoffId));
}

/** A carried scheduled job's id on the destination when the source sent none. */
export function crossMachineScheduledWorkId(handoffId: string, index: number): string {
  return deterministicChatSessionId(`cross-machine-schedule:${handoffId}:${index}`);
}

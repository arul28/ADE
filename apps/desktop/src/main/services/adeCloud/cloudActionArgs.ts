/**
 * How the `cloud` actions read their args (`cloudAgentActions.ts`,
 * `cloudLaneVerbs.ts`, `cloudTierRequestActions.ts`): pure, one copy.
 */

import type { CloudApproval } from "./cloudAgentActions";

/** The args as an object; anything else reads as none. */
export function record(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

/** A string arg, trimmed; null when it is missing or blank. */
export function text(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** An agent's reason on a card (a size request, a pick, a disk grow): one short paragraph. */
export function clipReason(reason: string): string {
  const flat = reason.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 299)}…` : flat;
}

/** Who asked for the action: the person, or an agent (and its chat). */
export function readApproval(args: Record<string, unknown>): CloudApproval {
  const raw = record(args.approval);
  if (raw.by === "person") return { by: "person" };
  return {
    by: "agent",
    chatSessionId: typeof raw.chatSessionId === "string" && raw.chatSessionId.trim() ? raw.chatSessionId.trim() : null,
    ...(raw.viaAdeMcp === true ? { viaAdeMcp: true } : {}),
    ...(raw.automation === true ? { automation: true } : {}),
  };
}

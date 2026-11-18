import type { OpenProjectBinding } from "../../../shared/types";
import { isRemoteCallNotSentError, isRemoteOutcomeUnknownError } from "../../../shared/runtimeErrors";
import { REMOTE_RUNTIME_MANUALLY_DISCONNECTED_MESSAGE } from "../../../shared/types/remoteRuntime";
import { requireChatPin } from "../chat/chatMachinePin";

/**
 * One send of a person's text to a running agent CLI (`chat.typeIntoCli`), on
 * the CLI's own machine, for both ways of typing into it: the Work input box
 * (`when: "free"`, typed at a free prompt) and the terminal's local line on a
 * slow link (`when: "now"`, typed at once).
 *
 * The caller keeps one `clientMessageId` for a text until the machine has it,
 * and sends the same id again for a retry. The machine answers a repeated id
 * with the first answer and types the text once, and the desktop sends it
 * again by itself after a dropped link (`isDedupedSend`). So no retry here,
 * with any id, can type a text twice.
 */
export type AgentCliTypeSendResult =
  /** Typed (or, for `free`, held by the machine to type at a free prompt). */
  | { kind: "typed" }
  /** `free` only: the CLI is mid-turn; nothing was typed. */
  | { kind: "busy" }
  /** The CLI's process has ended; nothing was typed. */
  | { kind: "ended" }
  /** The link dropped after the text left; the machine may have typed it. */
  | { kind: "unconfirmed" }
  /** The window was switching projects; nothing was sent. */
  | { kind: "switching" }
  /** The machine could not be reached; nothing was typed. */
  | { kind: "offline" }
  /** The machine refused it, or this ADE cannot send one. */
  | { kind: "failed"; error: string };

const UNREACHABLE_PATTERN = /not connected|disconnected|reconnecting|host_unavailable|unreachable|not reachable|couldn'?t reach|could not reach|offline|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Refused before it left this window or reached the machine: safe to send again. */
function isUnreachableError(error: unknown): boolean {
  const message = errorText(error);
  return message.includes(REMOTE_RUNTIME_MANUALLY_DISCONNECTED_MESSAGE) || UNREACHABLE_PATTERN.test(message);
}

function friendlyError(error: unknown): string {
  return errorText(error)
    .replace(/^Error invoking remote method '[^']+': /, "")
    .replace(/^Error: /, "");
}

export async function sendAgentCliText(args: {
  sessionId: string;
  text: string;
  clientMessageId: string;
  when: "now" | "free";
  /** The CLI's machine. No machine known: the send fails here, never on the tab's machine. */
  pin: OpenProjectBinding | null;
}): Promise<AgentCliTypeSendResult> {
  const api = typeof window !== "undefined" ? window.ade?.agentChat?.typeIntoCli : undefined;
  if (typeof api !== "function") return { kind: "failed", error: "This ADE cannot type into a CLI session." };
  try {
    const result = await api({
      sessionId: args.sessionId,
      text: args.text,
      clientMessageId: args.clientMessageId,
      // An older machine reads no `when`; "free" is its only way, so only "now" is sent.
      ...(args.when === "now" ? { when: "now" as const } : {}),
    }, requireChatPin(args.pin));
    if (result.outcome === "delivered" || result.outcome === "held") return { kind: "typed" };
    if (result.outcome === "ended") return { kind: "ended" };
    return { kind: "busy" };
  } catch (error) {
    // Refused before dialing: nothing left, so the box keeps the text as offline.
    if (isRemoteCallNotSentError(error)) return { kind: "offline" };
    if (isRemoteOutcomeUnknownError(error)) return { kind: "unconfirmed" };
    if (/Project is switching/i.test(errorText(error))) return { kind: "switching" };
    if (isUnreachableError(error)) return { kind: "offline" };
    return { kind: "failed", error: friendlyError(error) };
  }
}

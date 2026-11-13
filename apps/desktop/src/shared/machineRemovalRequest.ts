import type { PendingInputRequest } from "./types/chat";

/**
 * The computer removal card: an agent asks to take a computer off the
 * person's ADE account (`ade machines remove` from a chat), and the person
 * answers in that chat with Remove or Keep.
 *
 * An agent may never remove a computer itself (`account.deleteMachine` needs a
 * person). This card is the person's decision: the brain that holds the chat
 * removes the computer while it accepts the person's answer, with the same
 * directory call the Account page and a person's terminal make. The agent's
 * role never changes, and the agent learns only the outcome.
 *
 * It rides the ordinary pending-input machinery (`requestChatInput` →
 * `respondToInput`), so any client that can answer a question can answer it.
 * The metadata key below makes the card user-only (`isUserOnlyConsentCard`):
 * an agent's `chat.respondToInput`, the CTO's tools and a lane-share guest are
 * refused. A client that knows the card draws it natively; any other client
 * shows the plain questions.
 */

/** `providerMetadata` key on the card. Its presence makes the card user-only. */
export const MACHINE_REMOVAL_REQUEST_METADATA_KEY = "machineRemovalRequest" as const;

/** Remove or Keep. Every client answers it. */
export const MACHINE_REMOVAL_DECISION_QUESTION_ID = "machine_removal_decision" as const;
export const MACHINE_REMOVAL_REMOVE_VALUE = "remove" as const;
export const MACHINE_REMOVAL_KEEP_VALUE = "keep" as const;

/**
 * The second, explicit yes. Asked only when the computer is online or is the
 * computer that holds the chat: removing one of those cuts off work in use.
 */
export const MACHINE_REMOVAL_CONFIRM_QUESTION_ID = "machine_removal_confirm" as const;
export const MACHINE_REMOVAL_CONFIRM_VALUE = "remove_anyway" as const;
export const MACHINE_REMOVAL_CANCEL_VALUE = "cancel" as const;

/** The one line every surface uses to say what removal does. */
export const MACHINE_REMOVAL_EFFECT =
  "It leaves your ADE account: other devices stop seeing it, and it can rejoin only when someone signs in on it again. Its folders and files stay on it.";

/** What the card shows. Names and facts only, from the account directory. */
export type MachineRemovalRequestCard = {
  machineKey: string;
  name: string;
  /** Which ADE install, as "ADE Alpha", when the directory says. */
  install: string | null;
  platform: string | null;
  /** Epoch ms of the computer's last check-in; null when the directory never saw one. */
  lastSeenAt: number | null;
  online: boolean;
  /** The computer that holds this chat: removing it signs this ADE out of the account's list. */
  isThisComputer: boolean;
  /** Online or this computer: Remove needs the second, explicit yes. */
  needsConfirm: boolean;
};

/** What `account.deleteMachine` answers an agent in a chat. */
export type MachineRemovalRequestResult = {
  status: "removed" | "kept" | "pending_approval" | "timed_out";
  removed: boolean;
  machine: { machineKey: string; name: string };
  /** `pending_approval`: when the card stops waiting. */
  expiresAt?: string;
  /** One sentence for the agent: what happened, and what to do next. */
  next: string;
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export function readMachineRemovalRequestCard(
  request: Pick<PendingInputRequest, "providerMetadata"> | null | undefined,
): MachineRemovalRequestCard | null {
  const record = readRecord(request?.providerMetadata?.[MACHINE_REMOVAL_REQUEST_METADATA_KEY]);
  if (!record) return null;
  const machineKey = readText(record.machineKey, 200);
  const name = readText(record.name, 200);
  if (!machineKey || !name) return null;
  const lastSeenAt = typeof record.lastSeenAt === "number" && Number.isFinite(record.lastSeenAt) ? record.lastSeenAt : null;
  const online = record.online === true;
  const isThisComputer = record.isThisComputer === true;
  return {
    machineKey,
    name,
    install: readText(record.install, 80),
    platform: readText(record.platform, 80),
    lastSeenAt,
    online,
    isThisComputer,
    // Never weaker than the facts: a card that says online always asks twice.
    needsConfirm: record.needsConfirm === true || online || isThisComputer,
  };
}

/** The answers a native card sends for Remove (with the second yes when asked). */
export function machineRemovalRemoveAnswers(card: Pick<MachineRemovalRequestCard, "needsConfirm">): Record<string, string[]> {
  return {
    [MACHINE_REMOVAL_DECISION_QUESTION_ID]: [MACHINE_REMOVAL_REMOVE_VALUE],
    ...(card.needsConfirm ? { [MACHINE_REMOVAL_CONFIRM_QUESTION_ID]: [MACHINE_REMOVAL_CONFIRM_VALUE] } : {}),
  };
}

export function machineRemovalKeepAnswers(): Record<string, string[]> {
  return { [MACHINE_REMOVAL_DECISION_QUESTION_ID]: [MACHINE_REMOVAL_KEEP_VALUE] };
}

/** True only for an explicit Remove, with the second yes when the card asks for one. */
export function machineRemovalAnswersApprove(
  card: Pick<MachineRemovalRequestCard, "needsConfirm">,
  answers: Record<string, string[]>,
): boolean {
  if (answers[MACHINE_REMOVAL_DECISION_QUESTION_ID]?.[0] !== MACHINE_REMOVAL_REMOVE_VALUE) return false;
  if (!card.needsConfirm) return true;
  return answers[MACHINE_REMOVAL_CONFIRM_QUESTION_ID]?.[0] === MACHINE_REMOVAL_CONFIRM_VALUE;
}

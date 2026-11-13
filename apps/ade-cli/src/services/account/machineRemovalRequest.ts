import {
  accountMachineDisplayName,
  accountMachineInstallLabel,
  selectAccountMachine,
} from "../../../../desktop/src/shared/accountDirectory";
import {
  MACHINE_REMOVAL_CANCEL_VALUE,
  MACHINE_REMOVAL_CONFIRM_QUESTION_ID,
  MACHINE_REMOVAL_CONFIRM_VALUE,
  MACHINE_REMOVAL_DECISION_QUESTION_ID,
  MACHINE_REMOVAL_EFFECT,
  MACHINE_REMOVAL_KEEP_VALUE,
  MACHINE_REMOVAL_REMOVE_VALUE,
  MACHINE_REMOVAL_REQUEST_METADATA_KEY,
  machineRemovalAnswersApprove,
  type MachineRemovalRequestCard,
  type MachineRemovalRequestResult,
} from "../../../../desktop/src/shared/machineRemovalRequest";
import type { AdeAccountMachine, AdeAccountMachinesResult } from "../../../../desktop/src/shared/types/account";
import {
  cardTimeoutMs,
  cardWasDeclined,
  type CardRequestChatInput,
} from "../../../../desktop/src/main/services/chat/chatCardRequest";

/**
 * `account.deleteMachine` from an agent in a chat: ask the person, in that
 * chat, whether to take a computer off the account.
 *
 * The agent never gets the right to remove anything. The card is user-only
 * (`MACHINE_REMOVAL_REQUEST_METADATA_KEY` in `isUserOnlyConsentCard`), so only
 * a person's own client can answer it. The removal runs inside `beforeAccept`,
 * which the chat service calls while it accepts that person's answer, and it
 * is `deleteMachine`: the same directory call a person's `ade machines remove`
 * makes. If the removal fails, the card stays open with the error.
 *
 * The card lives as long as the agent's command waits: it belongs to the
 * agent's turn, so stopping the turn, or archiving or deleting the chat,
 * cancels it, and nothing is removed.
 */
export type MachineRemovalRequestDeps = {
  /** The chat service of the brain that holds the chat. */
  requestChatInput: CardRequestChatInput;
  listMachines(): Promise<AdeAccountMachinesResult>;
  /** The person's removal path (`AccountMachineDirectoryService.deleteMachine`). */
  deleteMachine(machineKey: string): Promise<unknown>;
  /** This computer's account machine key, or null when it has none. */
  localMachineKey(): string | null;
};

type OpenRequest = { chatSessionId: string; outcome: Promise<MachineRemovalRequestResult> };

/** One open request per computer, account-wide on this brain: a second ask joins or is refused. */
const openByMachineKey = new Map<string, OpenRequest>();

function lastSeenLine(lastSeenAt: number | null, now: number): string {
  if (lastSeenAt == null) return "never checked in";
  const minutes = Math.max(0, Math.round((now - lastSeenAt) / 60_000));
  if (minutes < 2) return "seen just now";
  if (minutes < 120) return `last seen ${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `last seen ${hours} hours ago`;
  return `last seen ${Math.round(hours / 24)} days ago`;
}

/** The word people know for a directory platform ("darwin" reads as "macOS"). */
const PLATFORM_WORDS: Record<string, string> = {
  darwin: "macOS",
  mac: "macOS",
  macos: "macOS",
  win32: "Windows",
  windows: "Windows",
  linux: "Linux",
};

function platformWord(platform: string | null | undefined): string | null {
  const raw = platform?.trim();
  if (!raw) return null;
  return PLATFORM_WORDS[raw.toLowerCase()] ?? raw;
}

export function machineRemovalCard(machine: AdeAccountMachine, localMachineKey: string | null): MachineRemovalRequestCard {
  const isThisComputer = Boolean(localMachineKey) && machine.machineKey === localMachineKey;
  return {
    machineKey: machine.machineKey,
    name: accountMachineDisplayName(machine) ?? machine.machineKey,
    install: accountMachineInstallLabel(machine),
    platform: platformWord(machine.platform),
    lastSeenAt: machine.lastSeenAt ?? null,
    online: machine.online === true,
    isThisComputer,
    needsConfirm: machine.online === true || isThisComputer,
  };
}

/**
 * Raise the card (or join the one already open for this computer in this chat)
 * and wait for the person. Throws for a request that cannot be asked: no chat,
 * signed out, no such computer, or a name that matches two.
 */
export async function requestMachineRemovalFromUser(
  deps: MachineRemovalRequestDeps,
  args: { chatSessionId: string; machine: string; timeoutMs?: number },
): Promise<MachineRemovalRequestResult> {
  const chatSessionId = args.chatSessionId.trim();
  if (!chatSessionId) {
    throw new Error("Asking to remove a computer needs a chat to ask in. Run `ade machines remove` from inside an ADE chat.");
  }
  const selector = args.machine.trim();
  if (!selector) throw new Error("Name the computer to remove: its key, device id or name from `ade machines list`.");
  const listed = await deps.listMachines();
  if (listed.state === "signed_out" || listed.state === "auth_expired") {
    throw new Error("This computer is not signed in to ADE, so it cannot ask to remove a computer. Ask the person to sign in.");
  }
  if (listed.state !== "ok") {
    throw new Error(listed.message ?? "The account's computer list is not reachable right now. Try again soon.");
  }
  const machine = selectAccountMachine(listed.machines, selector);
  const card = machineRemovalCard(machine, deps.localMachineKey());
  const summary = { machineKey: card.machineKey, name: card.name };

  const open = openByMachineKey.get(card.machineKey);
  if (open) {
    if (open.chatSessionId === chatSessionId) return await open.outcome;
    return {
      status: "pending_approval",
      removed: false,
      machine: summary,
      next: `Another chat already asked the person to remove ${card.name}, and that card is still open. Wait for their answer there; nothing was asked here.`,
    };
  }

  const outcome = askToRemove(deps, chatSessionId, card, cardTimeoutMs({ timeoutMs: args.timeoutMs }));
  const entry: OpenRequest = { chatSessionId, outcome };
  openByMachineKey.set(card.machineKey, entry);
  try {
    return await outcome;
  } finally {
    if (openByMachineKey.get(card.machineKey) === entry) openByMachineKey.delete(card.machineKey);
  }
}

async function askToRemove(
  deps: MachineRemovalRequestDeps,
  chatSessionId: string,
  card: MachineRemovalRequestCard,
  timeoutMs: number,
): Promise<MachineRemovalRequestResult> {
  const summary = { machineKey: card.machineKey, name: card.name };
  const facts = [
    card.platform,
    card.install,
    card.online ? "online now" : "offline",
    lastSeenLine(card.lastSeenAt, Date.now()),
    card.isThisComputer ? "this is the computer this chat runs on" : null,
  ].filter(Boolean).join(" · ");
  let removed = false;
  const beforeAccept = async (answers: Record<string, string[]>): Promise<void> => {
    if (answers[MACHINE_REMOVAL_DECISION_QUESTION_ID]?.[0] !== MACHINE_REMOVAL_REMOVE_VALUE) return;
    if (!machineRemovalAnswersApprove(card, answers)) {
      // Remove without the second yes: keep the card open and say why.
      throw new Error(`${card.name} is ${card.isThisComputer ? "the computer this chat runs on" : "online"}. Confirm "Remove anyway" to remove it, or choose Keep.`);
    }
    await deps.deleteMachine(card.machineKey);
    removed = true;
  };
  const response = await deps.requestChatInput({
    chatSessionId,
    title: `Remove ${card.name} from your ADE account?`,
    body: `${facts}. ${MACHINE_REMOVAL_EFFECT}`,
    timeoutMs,
    allowsFreeform: false,
    eventDescription: `Remove ${card.name} from your ADE account?`,
    providerMetadata: { [MACHINE_REMOVAL_REQUEST_METADATA_KEY]: card },
    beforeAccept,
    questions: [
      {
        id: MACHINE_REMOVAL_DECISION_QUESTION_ID,
        header: card.name,
        question: `An agent asks to remove ${card.name} (${facts}) from your ADE account. ${MACHINE_REMOVAL_EFFECT}`,
        allowsFreeform: false,
        options: [
          { label: "Keep", value: MACHINE_REMOVAL_KEEP_VALUE, recommended: true },
          { label: "Remove", value: MACHINE_REMOVAL_REMOVE_VALUE },
        ],
      },
      ...(card.needsConfirm
        ? [{
            id: MACHINE_REMOVAL_CONFIRM_QUESTION_ID,
            header: "Confirm",
            question: card.isThisComputer
              ? `${card.name} is the computer this chat runs on. Removing it takes this ADE off your account until someone signs in here again.`
              : `${card.name} is online now. Removing it cuts off the chats and terminals running on it from your other devices.`,
            allowsFreeform: false,
            options: [
              { label: "Cancel", value: MACHINE_REMOVAL_CANCEL_VALUE, recommended: true },
              { label: "Remove anyway", value: MACHINE_REMOVAL_CONFIRM_VALUE },
            ],
          }]
        : []),
    ],
  });

  if (removed) {
    return {
      status: "removed",
      removed: true,
      machine: summary,
      next: `The person approved. ${card.name} is off the account and its Activity is cleared; it rejoins only when someone signs in on it again.`,
    };
  }
  if (response.timedOut) {
    return {
      status: "timed_out",
      removed: false,
      machine: summary,
      next: `Nobody answered in time, so ${card.name} was kept. Ask again when the person is around.`,
    };
  }
  if (cardWasDeclined(response) || response.decision === "accept") {
    return {
      status: "kept",
      removed: false,
      machine: summary,
      next: response.decision === "cancel"
        ? `The card closed before the person answered (the turn stopped or the chat closed), so ${card.name} was kept.`
        : `The person chose Keep. ${card.name} stays on the account; do not ask again unless they bring it up.`,
    };
  }
  return { status: "kept", removed: false, machine: summary, next: `${card.name} was kept.` };
}

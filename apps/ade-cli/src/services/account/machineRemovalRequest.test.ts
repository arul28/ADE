import { describe, expect, it } from "vitest";
import {
  MACHINE_REMOVAL_CANCEL_VALUE,
  MACHINE_REMOVAL_CONFIRM_QUESTION_ID,
  MACHINE_REMOVAL_CONFIRM_VALUE,
  MACHINE_REMOVAL_DECISION_QUESTION_ID,
  MACHINE_REMOVAL_KEEP_VALUE,
  MACHINE_REMOVAL_REMOVE_VALUE,
} from "../../../../desktop/src/shared/machineRemovalRequest";
import type { AdeAccountMachine } from "../../../../desktop/src/shared/types/account";
import { isUserOnlyConsentCard } from "../../../../desktop/src/shared/types/macDesktop";
import type { CardRequestChatInput } from "../../../../desktop/src/main/services/chat/chatCardRequest";
import { requestMachineRemovalFromUser } from "./machineRemovalRequest";

const LOCAL_KEY = "mk-this-mac";

function machine(machineKey: string, online: boolean): AdeAccountMachine {
  return { machineKey, deviceId: `dev-${machineKey}`, name: `Studio ${machineKey}`, online, lastSeenAt: Date.now() } as AdeAccountMachine;
}

type Answer = Record<string, string[]>;

/**
 * The chat service's side of a card: each answer in `answers` is tried in
 * order, as a person pressing buttons. `beforeAccept` throwing refuses that
 * answer and keeps the card open, as `respondToInput` does. When every answer
 * is refused, the card ends as `end` says.
 */
function person(answers: Answer[], end: "timeout" | "cancel" = "cancel") {
  const cards: Array<Parameters<CardRequestChatInput>[0]> = [];
  const refusals: string[] = [];
  const requestChatInput: CardRequestChatInput = async (input) => {
    cards.push(input);
    for (const answer of answers) {
      try {
        await input.beforeAccept?.(answer);
        return { decision: "accept", answers: answer, responseText: null };
      } catch (error) {
        refusals.push(error instanceof Error ? error.message : String(error));
      }
    }
    return end === "timeout"
      ? { decision: "cancel", answers: {}, responseText: null, timedOut: true }
      : { decision: "cancel", answers: {}, responseText: null };
  };
  return { cards, refusals, requestChatInput };
}

function run(target: AdeAccountMachine, answers: Answer[], end?: "timeout" | "cancel") {
  const deleted: string[] = [];
  const asked = person(answers, end);
  const outcome = requestMachineRemovalFromUser({
    requestChatInput: asked.requestChatInput,
    listMachines: async () => ({ state: "ok", machines: [target, machine("mk-other", false)] }) as never,
    deleteMachine: async (machineKey) => {
      deleted.push(machineKey);
    },
    localMachineKey: () => LOCAL_KEY,
  }, { chatSessionId: `chat-${target.machineKey}`, machine: target.machineKey });
  return { outcome, deleted, ...asked };
}

const remove: Answer = { [MACHINE_REMOVAL_DECISION_QUESTION_ID]: [MACHINE_REMOVAL_REMOVE_VALUE] };
const removeCancelled: Answer = { ...remove, [MACHINE_REMOVAL_CONFIRM_QUESTION_ID]: [MACHINE_REMOVAL_CANCEL_VALUE] };
const removeAnyway: Answer = { ...remove, [MACHINE_REMOVAL_CONFIRM_QUESTION_ID]: [MACHINE_REMOVAL_CONFIRM_VALUE] };
const keep: Answer = { [MACHINE_REMOVAL_DECISION_QUESTION_ID]: [MACHINE_REMOVAL_KEEP_VALUE] };

describe("an agent's request to remove a computer", () => {
  it.each([
    ["Keep", [keep], "cancel", "kept"],
    ["no answer in time", [], "timeout", "timed_out"],
    ["the card closing (turn stopped, chat archived)", [], "cancel", "kept"],
    ["Remove on an online computer without the second yes", [remove, removeCancelled], "cancel", "kept"],
  ] as const)("removes nothing after %s, on a card only the person can answer", async (_label, answers, end, status) => {
    const asked = run(machine("mk-online", true), [...answers], end);

    await expect(asked.outcome).resolves.toMatchObject({ status, removed: false });
    expect(asked.deleted).toEqual([]);
    // `chat.respondToInput` refuses an agent's answer to this card by this check.
    expect(asked.cards).toHaveLength(1);
    expect(isUserOnlyConsentCard(asked.cards[0]!.providerMetadata ?? null)).toBe(true);
  });

  it.each([
    ["an online computer", machine("mk-online", true), true],
    ["the computer that runs the chat", machine(LOCAL_KEY, false), true],
    ["an offline other computer", machine("mk-offline", false), false],
  ] as const)("needs \"Remove anyway\" for %s only when it is online or this computer", async (_label, target, needsSecondYes) => {
    const asked = run(target, [remove, removeAnyway]);

    await expect(asked.outcome).resolves.toMatchObject({ status: "removed", removed: true });
    expect(asked.deleted).toEqual([target.machineKey]);
    expect(asked.refusals).toHaveLength(needsSecondYes ? 1 : 0);
  });

  it("reports removed, not kept, when the card closes while the person's removal finishes", async () => {
    let finish!: () => void;
    const deleting = new Promise<void>((resolve) => { finish = resolve; });
    const result = requestMachineRemovalFromUser({
      requestChatInput: async (input) => {
        // The person's Remove starts the delete; the turn stops before it ends.
        void Promise.resolve(input.beforeAccept?.(remove)).catch(() => undefined);
        finish();
        return { decision: "cancel", answers: {}, responseText: null };
      },
      listMachines: async () => ({ state: "ok", machines: [machine("mk-offline", false)] }) as never,
      deleteMachine: () => deleting,
      localMachineKey: () => LOCAL_KEY,
    }, { chatSessionId: "chat-closing", machine: "mk-offline" });

    await expect(result).resolves.toMatchObject({ status: "removed", removed: true });
  });
});

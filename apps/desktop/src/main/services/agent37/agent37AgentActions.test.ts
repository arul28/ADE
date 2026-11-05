import { describe, expect, it } from "vitest";
import type { Agent37Budget } from "../../../shared/agent37";
import type { PermissionLevel } from "../../../shared/permissionLadder";
import { buildAgent37AgentActions, type Agent37AgentActionDeps, type Agent37Approval } from "./agent37AgentActions";

/**
 * Who may let an agent spend Agent 37 money or delete a machine. The person
 * decides; an unattended agent gets ADE's answer: spending within the cap
 * yes, raising the cap no, deleting a machine it didn't make no.
 */
describe("Agent 37 agent actions: approvals", () => {
  function setup(options: { level?: PermissionLevel | null; automation?: boolean; madeBy?: string; answer?: "yes" | "no" } = {}) {
    const ran: string[] = [];
    const cards: string[] = [];
    let budget: Agent37Budget = { monthlyCapUsd: 20 };
    const box = { instanceId: "inst_1", name: "lane box", machineKey: "mk_1", type: "box", runningHourlyUsd: 0.008 };
    const deps = {
      machines: {
        list: async () => ({ state: "ok", machines: [box], spending: null, balanceUsd: 10 }),
        spending: async () => ({ monthlyCapUsd: budget.monthlyCapUsd, monthSpentUsd: 1, capNear: false, capReached: false }),
        run: async (action: { action: string }) => {
          ran.push(action.action);
          return { ok: true };
        },
        instanceMetadata: async () => (options.madeBy ? { ade_made_by_chat: options.madeBy } : {}),
      },
      budget: {
        read: async () => budget,
        write: async (next: Agent37Budget) => {
          budget = next;
          ran.push(`cap:${next.monthlyCapUsd}`);
          return next;
        },
      },
      readySettings: { read: async () => ({ projects: [], authoritative: true }), write: async () => undefined },
      desktop: () => null,
      approvals: {
        requestChatInput: async (card: { title: string }) => {
          cards.push(card.title);
          return { decision: "accept", answers: { decision: [options.answer ?? "no"] } };
        },
        permissionLevel: () => options.level ?? null,
        isAutomationRun: async () => options.automation ?? false,
        notice: () => undefined,
      },
    } as unknown as Agent37AgentActionDeps;
    return { actions: buildAgent37AgentActions(deps), ran, cards };
  }

  const person: Agent37Approval = { by: "person" };
  const agent: Agent37Approval = { by: "agent", chatSessionId: "chat_1" };
  const shell: Agent37Approval = { by: "agent", chatSessionId: null };

  it.each([
    ["the person raises the cap", person, {}, "set_cap", { monthlyCapUsd: 50 }, "cap:50", 0],
    ["a full-auto agent may not raise the cap", agent, { level: "full-auto" }, "set_cap", { monthlyCapUsd: 50 }, null, 0],
    ["an automation run may not turn the cap off", agent, { automation: true }, "set_cap", { monthlyCapUsd: null }, null, 0],
    ["a full-auto agent may not keep a machine awake past the cap", agent, { level: "full-auto" }, "set_sleep", { machine: "lane box", minutes: "never" }, null, 0],
    ["a full-auto agent may let a machine sleep sooner", agent, { level: "full-auto" }, "set_sleep", { machine: "lane box", minutes: 5 }, "set_sleep", 0],
    ["any agent may lower the cap", agent, { level: "full-auto" }, "set_cap", { monthlyCapUsd: 5 }, "cap:5", 0],
    ["a full-auto agent resizes within the cap", agent, { level: "full-auto" }, "resize", { machine: "lane box", shape: "4x8" }, "resize", 0],
    ["a full-auto agent may not delete a machine it didn't make", agent, { level: "full-auto", madeBy: "chat_other" }, "delete", { machine: "inst_1" }, null, 0],
    ["a full-auto agent deletes the machine its chat made", agent, { level: "full-auto", madeBy: "chat_1" }, "delete", { machine: "inst_1" }, "delete", 0],
    ["plan mode changes nothing", agent, { level: "plan" }, "resize", { machine: "lane box", shape: "4x8" }, null, 0],
    ["a shell with no chat is refused", shell, {}, "delete", { machine: "inst_1" }, null, 0],
    ["an attended agent asks, and no stops it", agent, { level: "ask", answer: "no" }, "delete", { machine: "inst_1" }, null, 1],
    ["an attended agent asks, and yes runs it", agent, { level: "ask", answer: "yes" }, "resize", { machine: "lane box", shape: "4x8" }, "resize", 1],
  ] as const)("%s", async (_label, approval, options, verb, args, expectedRun, expectedCards) => {
    const { actions, ran, cards } = setup(options);
    const call = (actions as unknown as Record<string, (args: unknown) => Promise<unknown>>)[verb]!({ ...args, approval });
    if (expectedRun) {
      await expect(call).resolves.toBeTruthy();
      expect(ran).toEqual([expectedRun]);
    } else {
      await expect(call).rejects.toMatchObject({ code: "agent37_declined" });
      expect(ran).toEqual([]);
    }
    expect(cards).toHaveLength(expectedCards);
  });
});

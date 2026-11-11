import { describe, expect, it } from "vitest";
import type { CloudAccountState, CloudAgentLimits } from "../../../shared/adeCloud";
import type { PermissionLevel } from "../../../shared/permissionLadder";
import { buildCloudAgentActions, type CloudAgentActionDeps, type CloudApproval } from "./cloudAgentActions";

/**
 * Who may let an agent spend the account's hours or delete a machine. The person
 * decides; an unattended agent gets ADE's answer from the person's limits:
 * within them yes, past them (a bigger size, the day's count) no, deleting a
 * machine it didn't make no, and no while ADE can't read the account's hours.
 */
describe("ADE Cloud agent actions: approvals", () => {
  function setup(options: {
    level?: PermissionLevel | null;
    automation?: boolean;
    madeBy?: string;
    answer?: "yes" | "no";
    unattendedSpend?: boolean;
    madeToday?: number;
    spendUnreadable?: boolean;
  } = {}) {
    const ran: string[] = [];
    const cards: string[] = [];
    let limits: CloudAgentLimits = { unattendedSpend: options.unattendedSpend ?? true, machinesPerDay: 3, maxShape: "4x16" };
    const box = { instanceId: "inst_1", name: "lane box", machineKey: "mk_1", type: "box", hoursRate: 1 };
    const deps = {
      machines: {
        list: async () => ({ state: "ok", machines: [box], account: null }),
        account: async () => {
          if (options.spendUnreadable) throw new Error("ADE Cloud account read timed out");
          return { hours: { state: "none" } } as unknown as CloudAccountState;
        },
        run: async (action: { action: string }) => {
          ran.push(action.action);
          return { ok: true };
        },
        instanceMetadata: async () => (options.madeBy ? { ade_made_by_chat: options.madeBy } : {}),
        agentMadeToday: async () => options.madeToday ?? 0,
      },
      limits: {
        read: async () => limits,
        write: async (next: CloudAgentLimits) => {
          limits = next;
          ran.push("limits");
          return next;
        },
      },
      readySettings: { read: async () => ({ projects: [], authoritative: true }), write: async () => undefined },
      desktop: () => ({
        create: async () => {
          ran.push("create");
          return { instanceId: "inst_new" };
        },
      }),
      approvals: {
        requestChatInput: async (card: { title: string }) => {
          cards.push(card.title);
          return { decision: "accept", answers: { decision: [options.answer ?? "no"] } };
        },
        permissionLevel: () => options.level ?? null,
        isAutomationRun: async () => options.automation ?? false,
        notice: () => undefined,
      },
    } as unknown as CloudAgentActionDeps;
    return { actions: buildCloudAgentActions(deps), ran, cards };
  }

  const person: CloudApproval = { by: "person" };
  const agent: CloudApproval = { by: "agent", chatSessionId: "chat_1" };
  const shell: CloudApproval = { by: "agent", chatSessionId: null };

  it.each([
    // A size change is the person's alone: nobody is watching these callers, so none may resize, and no card is raised.
    ["a full-auto chat may not change a computer's size", agent, { level: "full-auto" }, "resize", { machine: "lane box", shape: "4x8" }, null, 0],
    ["an automation run may not change a computer's size", { by: "agent", chatSessionId: null, automation: true }, {}, "resize", { machine: "lane box", shape: "4x8" }, null, 0],
    ["an app on ADE MCP may not change a computer's size", { by: "agent", chatSessionId: null, viaAdeMcp: true }, {}, "resize", { machine: "lane box", shape: "4x8" }, null, 0],
    ["a full-auto agent may not delete a machine it didn't make", agent, { level: "full-auto", madeBy: "chat_other" }, "delete", { machine: "inst_1" }, null, 0],
    ["a full-auto agent deletes the machine its chat made", agent, { level: "full-auto", madeBy: "chat_1" }, "delete", { machine: "inst_1" }, "delete", 0],
    ["plan mode changes nothing", agent, { level: "plan" }, "resize", { machine: "lane box", shape: "4x8" }, null, 0],
    ["a shell with no chat is refused", shell, {}, "delete", { machine: "inst_1" }, null, 0],
    ["an attended agent asks, and no stops it", agent, { level: "ask", answer: "no" }, "delete", { machine: "inst_1" }, null, 1],
    ["an attended agent asks, and yes runs it", agent, { level: "ask", answer: "yes" }, "resize", { machine: "lane box", shape: "4x8" }, "resize", 1],
    // What the person lets unattended agents spend (balanced: 3 a day, up to 4x16).
    ["with unattended spending off, a full-auto agent resizes nothing", agent, { level: "full-auto", unattendedSpend: false }, "resize", { machine: "lane box", shape: "4x8" }, null, 0],
    ["a full-auto agent may not pick a size over the limit", agent, { level: "full-auto" }, "resize", { machine: "lane box", shape: "4x32" }, null, 0],
    ["a full-auto agent makes a machine within the day's limit", agent, { level: "full-auto", madeToday: 2 }, "create", { kind: "box", shape: "2x4" }, "create", 0],
    ["at the day's limit a full-auto agent makes no machine", agent, { automation: true, madeToday: 3 }, "create", { kind: "box", shape: "2x4" }, null, 0],
    ["an attended agent asks even past the limits", agent, { level: "ask", answer: "yes", madeToday: 9 }, "create", { kind: "vm", shape: "4x32" }, "create", 1],
    // A month ADE can't read counts as over the cap for whoever nobody watches; a person still decides.
    ["with an unreadable month, a full-auto agent makes no machine", agent, { level: "full-auto", spendUnreadable: true }, "create", { kind: "box", shape: "2x4" }, null, 0],
    ["with an unreadable month, an automation run resizes nothing", agent, { automation: true, spendUnreadable: true }, "resize", { machine: "lane box", shape: "4x8" }, null, 0],
    ["with an unreadable month, an attended agent asks, and yes runs it", agent, { level: "ask", answer: "yes", spendUnreadable: true }, "create", { kind: "box", shape: "2x4" }, "create", 1],
    ["with an unreadable month, the person makes a machine", person, { spendUnreadable: true }, "create", { kind: "box", shape: "2x4" }, "create", 0],
    ["a full-auto agent may not loosen the limits", agent, { level: "full-auto" }, "set_limits", { preset: "hands_off" }, null, 0],
    ["any agent may tighten the limits", agent, { level: "full-auto" }, "set_limits", { preset: "ask" }, "limits", 0],
  ] as const)("%s", async (_label, approval, options, verb, args, expectedRun, expectedCards) => {
    const { actions, ran, cards } = setup(options);
    const call = (actions as unknown as Record<string, (args: unknown) => Promise<unknown>>)[verb]!({ ...args, approval });
    if (expectedRun) {
      await expect(call).resolves.toBeTruthy();
      expect(ran).toEqual([expectedRun]);
    } else {
      await expect(call).rejects.toMatchObject({ code: "cloud_declined" });
      expect(ran).toEqual([]);
    }
    expect(cards).toHaveLength(expectedCards);
  });

  it("parallel makes by full-auto agents stay within the day's limit, counted on top of the account's", async () => {
    // Two made today on another machine, a limit of three: one more, not three.
    const { actions, ran } = setup({ level: "full-auto", madeToday: 2 });
    const results = await Promise.allSettled(
      [0, 1, 2].map(() => actions.create({ kind: "box", shape: "2x4", approval: agent })),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(2);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "cloud_declined" });
    }
    expect(ran).toEqual(["create"]);
  });
});

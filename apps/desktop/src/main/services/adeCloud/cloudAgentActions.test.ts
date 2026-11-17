import { describe, expect, it, vi } from "vitest";
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
    /** A lane launch this brain holds, already in this phase. */
    launchPhase?: "failed" | "running";
    /** The size that launch was started with. */
    savedSize?: string;
    /** How that size was chosen. */
    savedChoice?: "default" | "picked";
    maxShape?: string;
    /** The agents' paid extra disk a month, in cents (null: up to the account's limit). */
    extraDiskMonthCents?: number | null;
    /** The person's limits can't be read (the account vault doesn't answer). */
    limitsUnreadable?: boolean;
  } = {}) {
    const ran: string[] = [];
    const cards: string[] = [];
    const starts: Array<{ args: { cloud?: unknown } }> = [];
    let limits: CloudAgentLimits = {
      unattendedSpend: options.unattendedSpend ?? true,
      machinesPerDay: 3,
      maxShape: (options.maxShape ?? "4x16") as CloudAgentLimits["maxShape"],
      extraDiskMonthCents: options.extraDiskMonthCents ?? null,
    };
    /** What `grow_disk`'s approval answered the grower for paid extra disk. */
    const extraAnswers: unknown[] = [];
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
        read: async () => {
          if (options.limitsUnreadable) throw new Error("account vault timed out");
          return limits;
        },
        write: async (next: CloudAgentLimits) => {
          limits = next;
          ran.push("limits");
          return next;
        },
      },
      desktop: () => ({
        create: async () => {
          ran.push("create");
          return { instanceId: "inst_new" };
        },
      }),
      laneLaunch: () => ({
        status: async (launchId: string) => (options.launchPhase
          ? { launch: { launchId, kind: "chat", phase: options.launchPhase, cloud: { handedOff: false, sizeId: options.savedSize ?? "small", sizeChoice: options.savedChoice } }, madeByChat: "chat_1" }
          : null),
        start: async (input: { args: { cloud?: unknown } }) => {
          starts.push(input);
          ran.push("lane_launch");
          return { status: { launch: { phase: "running" } }, created: !options.launchPhase };
        },
      }),
      // The computer's grower: a 16 GB disk 4 GB past the plan, about 80¢ a month.
      diskGrow: () => ({
        growToFit: async (ask: { approveExtra?: (fit: unknown) => Promise<unknown> }) => {
          extraAnswers.push(await ask.approveExtra?.({ kind: "extra", fromGb: 8, toGb: 16, pastGb: 4, limitGb: 30, monthCents: 80, limitCents: 1000, sentence: "A 16 GB disk uses paid extra disk." }));
          return { state: "growing", fromGb: 8, toGb: 16, message: "growing" };
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
    return { actions: buildCloudAgentActions(deps), ran, cards, starts, extraAnswers };
  }

  const person: CloudApproval = { by: "person" };
  const agent: CloudApproval = { by: "agent", chatSessionId: "chat_1" };
  const shell: CloudApproval = { by: "agent", chatSessionId: null };
  const laneLaunchArgs = {
    originUrl: "https://github.com/acme/widgets.git",
    launch: { launchId: "0b7c2f4e-9a51-4d0e-8c1a-3f6b2d9e7a10", kind: "lane", laneName: "Fix login", cloud: { sizeId: "small" } },
  };

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
    // The same launch id again on a failed launch makes it a new computer: the gates of a first start, now.
    ["with unattended spending off, a full-auto agent's retry of a failed launch replaces nothing", agent, { level: "full-auto", unattendedSpend: false, launchPhase: "failed" }, "lane_launch", laneLaunchArgs, null, 0],
    ["at the day's limit, a full-auto agent's retry of a failed launch replaces nothing", agent, { level: "full-auto", madeToday: 3, launchPhase: "failed" }, "lane_launch", laneLaunchArgs, null, 0],
    ["within the limits, a full-auto agent's retry of a failed launch goes on", agent, { level: "full-auto", launchPhase: "failed" }, "lane_launch", laneLaunchArgs, "lane_launch", 0],
    ["a full-auto agent's retry is checked at the size the launch starts again, not the one it names", agent, { level: "full-auto", launchPhase: "failed", savedSize: "xlarge", maxShape: "2x4" }, "lane_launch", laneLaunchArgs, null, 0],
    ["a retry needs no first message: the launch has its own", person, { launchPhase: "failed" }, "lane_launch", { ...laneLaunchArgs, launch: { launchId: laneLaunchArgs.launch.launchId, kind: "chat" } }, "lane_launch", 0],
    ["a launch still running is only read again, asking nothing", agent, { level: "full-auto", unattendedSpend: false, launchPhase: "running" }, "lane_launch", laneLaunchArgs, "lane_launch", 0],
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

  // Paid extra disk for a disk grow (`cloud.grow_disk`): a person on a card decides for a watched chat; for an
  // agent nobody watches, the agents' extra-disk limit does, and a limit ADE can't read says no. Extra disk costs
  // money, not hours: hours ADE can't read don't stop it.
  it.each([
    ["unattended, the default limits (up to the account's limit): yes, with no card", { level: "full-auto" }, true, 0],
    ["unattended, exactly at the agents' extra disk (80¢): yes", { level: "full-auto", extraDiskMonthCents: 80 }, true, 0],
    ["unattended, a cent past the agents' extra disk: the agent limit says no", { level: "full-auto", extraDiskMonthCents: 79 }, "agent_limit", 0],
    ["unattended, agents may use no extra disk: the agent limit says no", { level: "full-auto", extraDiskMonthCents: 0 }, "agent_limit", 0],
    ["unattended, agents may not spend: the agent limit says no", { level: "full-auto", unattendedSpend: false }, "agent_limit", 0],
    ["unattended, the limits can't be read: no", { level: "full-auto", limitsUnreadable: true }, "agent_limit", 0],
    ["unattended, the hours can't be read: yes, a disk spends no hours", { level: "full-auto", spendUnreadable: true }, true, 0],
    ["a watched chat asks the person, and yes grows it", { level: "ask", answer: "yes" }, true, 1],
    ["a watched chat asks the person, and no stops it", { level: "ask", answer: "no" }, false, 1],
  ] as const)("paid extra disk for a grow: %s", async (_label, options, expected, expectedCards) => {
    vi.stubEnv("ADE_CLOUD_INSTANCE_ID", "inst_1");
    try {
      const { actions, cards, extraAnswers, ran } = setup(options);

      const answer = await actions.grow_disk!({ needFreeGb: 8, reason: "the emulator's first boot", approval: agent } as never);

      expect(answer).toMatchObject({ state: "growing" });
      expect(extraAnswers).toHaveLength(1);
      if (typeof expected === "string") expect(extraAnswers[0]).toMatchObject({ reason: expected, sentence: expect.any(String) });
      else expect(extraAnswers[0]).toBe(expected);
      expect(cards).toHaveLength(expectedCards);
      expect(ran).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // A full-auto agent's retry of a default Small: the limits as they are now decide whether setup may move it up.
  it.each<[string, string, boolean, string]>([
    ["limits that allow Medium leave the saved choice", "4x16", false, "2031-03-01T12:00:00Z"],
    ["limits lowered to Small since the first start hold it there", "2x4", true, "2031-03-02T12:00:00Z"],
  ])("a full-auto agent's retry of a default Small: %s", async (_label, maxShape, capped, day) => {
    // A day of its own: the count of computers agents made today lives for the whole process.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(day));
    try {
      const { actions, starts } = setup({ level: "full-auto", launchPhase: "failed", savedChoice: "default", maxShape });

      await actions.lane_launch!({ ...laneLaunchArgs, approval: agent } as never);

      expect(starts).toHaveLength(1);
      const choice = (starts[0]!.args.cloud as { sizeChoice?: string }).sizeChoice;
      if (capped) expect(choice).toBe("capped");
      else expect(choice).not.toBe("capped");
    } finally {
      vi.useRealTimers();
    }
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

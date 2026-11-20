import { describe, expect, it, vi } from "vitest";
import type { CloudAccountState, CloudAgentLimits } from "../../../shared/adeCloud";
import type { PermissionLevel } from "../../../shared/permissionLadder";
import { buildCloudAgentActions, type CloudAgentActionDeps, type CloudApproval } from "./cloudAgentActions";

/**
 * Who may let an agent spend the account's hours or delete a machine. The person
 * decides; an unattended agent gets ADE's answer from the person's limits:
 * within them yes, past them (a bigger size, the day's count) no, deleting a
 * machine it didn't make no, and no while ADE can't read the account's hours.
 * A computer that is no new lane's (a make, a copy, a move) is the person's
 * alone: an agent asks on a card, and with nobody to ask the answer is no.
 */
describe("ADE Cloud agent actions: approvals", () => {
  function setup(options: {
    level?: PermissionLevel | null;
    automation?: boolean;
    madeBy?: string;
    answer?: "yes" | "no" | "alternative";
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
    /** Lane work checks: each may wake an asleep computer, which uses hours. */
    const checks: string[] = [];
    const starts: Array<{ args: { cloud?: unknown } }> = [];
    let limits: CloudAgentLimits = {
      unattendedSpend: options.unattendedSpend ?? true,
      machinesPerDay: 3,
      maxShape: (options.maxShape ?? "4x16") as CloudAgentLimits["maxShape"],
      extraDiskMonthCents: options.extraDiskMonthCents ?? null,
    };
    /** What `grow_disk`'s approval answered the grower for paid extra disk. */
    const extraAnswers: unknown[] = [];
    const box = { instanceId: "inst_1", name: "lane box", machineKey: "mk_1", type: "box", hoursRate: 1, state: "asleep", lane: { laneId: "lane_1", laneName: "Fix login", projectOrigin: "github.com/acme/widgets" } };
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
        recentInstances: () => [],
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
        copy: async () => {
          ran.push("copy");
          return { instanceId: "inst_new" };
        },
        move: async () => {
          ran.push("move");
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
      // A lane's account side: its computer, its work (all on GitHub), its delete and its free.
      lanes: {
        account: () => ({
          readInstance: async () => ({ id: "inst_1", metadata: options.madeBy ? { ade_made_by_chat: options.madeBy } : {} }),
          workState: async ({ instanceId }: { instanceId: string }) => {
            checks.push(instanceId);
            return { unpushed: false, unpushedLanes: [], message: null };
          },
          deleteLane: async () => {
            ran.push("lane_delete");
            return { ok: true, message: "Deleted.", chatsKept: false };
          },
          freeLane: async () => {
            ran.push("lane_free");
            return { ok: true, message: "Kept for later.", lane: null };
          },
          lanesWithoutComputer: async () => [],
        }),
        client: async () => ({ listSavedChats: async () => ({ chats: [], nextCursor: null }) }),
        api: () => null,
      },
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
    return { actions: buildCloudAgentActions(deps), ran, cards, starts, extraAnswers, checks };
  }

  const person: CloudApproval = { by: "person" };
  const agent: CloudApproval = { by: "agent", chatSessionId: "chat_1" };
  const shell: CloudApproval = { by: "agent", chatSessionId: null };
  const laneLaunchArgs = {
    originUrl: "https://github.com/acme/widgets.git",
    launch: { launchId: "0b7c2f4e-9a51-4d0e-8c1a-3f6b2d9e7a10", kind: "lane", laneName: "Fix login", cloud: { sizeId: "small" } },
  };

  it.each([
    // A size change, a delete of a machine this chat didn't make and looser limits are the person's alone: a full-auto chat
    // asks them on a card; an automation run or an ADE MCP app has nobody to ask, so it is refused with no card.
    ["a full-auto chat asks the person on a card to change a computer's size", agent, { level: "full-auto" }, "resize", { machine: "lane box", shape: "4x8" }, null, 1],
    ["an automation run may not change a computer's size", { by: "agent", chatSessionId: null, automation: true }, {}, "resize", { machine: "lane box", shape: "4x8" }, null, 0],
    ["an app on ADE MCP may not change a computer's size", { by: "agent", chatSessionId: null, viaAdeMcp: true }, {}, "resize", { machine: "lane box", shape: "4x8" }, null, 0],
    ["a full-auto chat asks the person on a card to delete a machine it didn't make", agent, { level: "full-auto", madeBy: "chat_other" }, "delete", { machine: "inst_1" }, null, 1],
    ["the person's yes on that card deletes it", agent, { level: "full-auto", madeBy: "chat_other", answer: "yes" }, "delete", { machine: "inst_1" }, "delete", 1],
    ["an automation run may not delete a machine it didn't make", { by: "agent", chatSessionId: null, automation: true }, { madeBy: "chat_other" }, "delete", { machine: "inst_1" }, null, 0],
    ["a full-auto agent deletes the machine its chat made", agent, { level: "full-auto", madeBy: "chat_1" }, "delete", { machine: "inst_1" }, "delete", 0],
    ["plan mode changes nothing", agent, { level: "plan" }, "resize", { machine: "lane box", shape: "4x8" }, null, 0],
    ["a shell with no chat is refused", shell, {}, "delete", { machine: "inst_1" }, null, 0],
    ["an attended agent asks, and no stops it", agent, { level: "ask", answer: "no" }, "delete", { machine: "inst_1" }, null, 1],
    ["an attended agent asks, and yes runs it", agent, { level: "ask", answer: "yes" }, "resize", { machine: "lane box", shape: "4x8" }, "resize", 1],
    // What the person lets unattended agents spend (balanced: 3 a day, up to 4x16).
    ["with unattended spending off, a full-auto chat's resize still goes to the person", agent, { level: "full-auto", unattendedSpend: false }, "resize", { machine: "lane box", shape: "4x8" }, null, 1],
    ["a size over the agents' limit, in a full-auto chat, goes to the person", agent, { level: "full-auto", answer: "yes" }, "resize", { machine: "lane box", shape: "4x32" }, "resize", 1],
    // Agents start lanes and never make a computer alone: a make, a copy or a move asks the person on a card, a
    // full-auto chat too, and with nobody to ask (an automation run, an ADE MCP app, no chat) the answer is no.
    ["a full-auto chat asks the person on a card to make a computer, within the day's limit too", agent, { level: "full-auto", madeToday: 0 }, "create", { kind: "box", shape: "2x4" }, null, 1],
    ["the person's yes on that card makes it", agent, { level: "full-auto", answer: "yes" }, "create", { kind: "vm", shape: "4x8" }, "create", 1],
    ["an automation run makes no computer, within the limits too", agent, { automation: true, madeToday: 0 }, "create", { kind: "box", shape: "2x4" }, null, 0],
    ["an app on ADE MCP makes no computer", { by: "agent", chatSessionId: null, viaAdeMcp: true }, {}, "create", { kind: "vm", shape: "4x8" }, null, 0],
    ["a shell with no chat makes no computer", shell, {}, "create", { kind: "box", shape: "2x4" }, null, 0],
    ["a full-auto chat asks the person on a card to copy a computer", agent, { level: "full-auto" }, "copy", { machine: "lane box" }, null, 1],
    ["an automation run copies no computer", agent, { automation: true }, "copy", { machine: "lane box" }, null, 0],
    ["a full-auto chat asks the person on a card to move even a computer its chat made", agent, { level: "full-auto", madeBy: "chat_1" }, "move", { machine: "lane box", to: "vm" }, null, 1],
    ["an automation run moves no computer, even one its chat made", agent, { automation: true, madeBy: "chat_1" }, "move", { machine: "lane box", to: "vm" }, null, 0],
    ["an attended agent asks even past the limits", agent, { level: "ask", answer: "yes", madeToday: 9 }, "create", { kind: "vm", shape: "4x32" }, "create", 1],
    ["the person makes a computer with no card", person, {}, "create", { kind: "vm", shape: "4x8" }, "create", 0],
    // A month ADE can't read counts as over the cap for whoever nobody watches; a person still decides.
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
    ["a full-auto chat asks the person on a card to loosen the limits", agent, { level: "full-auto" }, "set_limits", { preset: "hands_off" }, null, 1],
    ["an automation run may not loosen the limits", { by: "agent", chatSessionId: null, automation: true }, {}, "set_limits", { preset: "hands_off" }, null, 0],
    ["any agent may tighten the limits", agent, { level: "full-auto" }, "set_limits", { preset: "ask" }, "limits", 0],
    // Deleting a lane (`ade cloud lanes delete`): a delete like any other. One card offers Delete lane, Keep for later and Cancel.
    ["a full-auto chat asks the person on a card to delete a lane whose computer it didn't make", agent, { level: "full-auto", madeBy: "chat_other" }, "lane_delete", { lane: "Fix login" }, null, 1],
    ["the person's Keep for later on that card frees the computer and deletes nothing", agent, { level: "ask", answer: "alternative" }, "lane_delete", { lane: "Fix login" }, "lane_free", 1],
    ["a full-auto agent asks the person even for a lane whose computer its chat made (its saved chats go too)", agent, { level: "full-auto", madeBy: "chat_1" }, "lane_delete", { lane: "Fix login" }, null, 1],
    ["an automation run may not delete a lane whose computer it didn't make", { by: "agent", chatSessionId: null, automation: true }, { madeBy: "chat_other" }, "lane_delete", { lane: "Fix login" }, null, 0],
    ["a shell with no chat may not delete a lane", shell, {}, "lane_delete", { lane: "Fix login" }, null, 0],
  ] as const)("%s", async (_label, approval, options, verb, args, expectedRun, expectedCards) => {
    const { actions, ran, cards, checks } = setup(options);
    const call = (actions as unknown as Record<string, (args: unknown) => Promise<unknown>>)[verb]!({ ...args, approval });
    if (expectedRun) {
      await expect(call).resolves.toBeTruthy();
      expect(ran).toEqual([expectedRun]);
    } else {
      await expect(call).rejects.toMatchObject({ code: "cloud_declined" });
      expect(ran).toEqual([]);
    }
    expect(cards).toHaveLength(expectedCards);
    // A lane's work check runs only for the card a person reads: never for a caller ADE refuses or answers alone.
    expect(checks).toHaveLength(verb === "lane_delete" ? expectedCards : 0);
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

  it("parallel new lanes by full-auto agents stay within the day's limit, counted on top of the account's", async () => {
    // Two made today on another machine, a limit of three: one more, not three.
    const { actions, ran } = setup({ level: "full-auto", madeToday: 2 });
    const launchIds = ["1b7c2f4e-9a51-4d0e-8c1a-3f6b2d9e7a10", "2b7c2f4e-9a51-4d0e-8c1a-3f6b2d9e7a10", "3b7c2f4e-9a51-4d0e-8c1a-3f6b2d9e7a10"];
    const results = await Promise.allSettled(
      launchIds.map((launchId) => actions.lane_launch!({ ...laneLaunchArgs, launch: { ...laneLaunchArgs.launch, launchId }, approval: agent } as never)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(2);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "cloud_declined" });
    }
    expect(ran).toEqual(["lane_launch"]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeActivitySummary, UpdateInterruptedChat } from "../../../shared/types";
import { createUpdateImpactProbe, type UpdateImpactProbeDeps } from "./updateImpactProbe";

const chat = (sessionId: string, projectRoot: string): UpdateInterruptedChat => ({
  sessionId,
  title: sessionId,
  projectName: projectRoot,
  projectRoot,
});

const activity = (activeAgentTurns: number, activeWorkSessions: number): RuntimeActivitySummary => ({
  activeAgentTurns,
  activeWorkSessions,
  idle: activeAgentTurns === 0 && activeWorkSessions === 0,
});

function probe(overrides: Partial<UpdateImpactProbeDeps> = {}) {
  const logger = { info: vi.fn(), warn: vi.fn() };
  const deps: UpdateImpactProbeDeps = {
    logger,
    readMachineImpact: async () => ({ chats: [], cliSessions: 0, terminals: 0 }),
    readMachineActivity: async () => activity(0, 0),
    listOpenProjectChats: async () => [],
    listConnectedPhones: async () => [],
    ...overrides,
  };
  return { probe: createUpdateImpactProbe(deps), logger };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("update impact probe", () => {
  it("reports the brain's machine-wide answer, keeping only well-formed chats", async () => {
    const { probe: impactProbe, logger } = probe({
      readMachineImpact: async () => ({
        chats: [
          { sessionId: "chat-1", title: "Fix login", projectName: "ADE", projectRoot: "/code/ADE", extra: "dropped" },
          null,
          { title: "no id" },
        ],
        cliSessions: 2,
        terminals: "3",
      }),
      listConnectedPhones: async () => [{ deviceId: "phone-1", deviceName: "Arul's iPhone" }],
    });

    const impact = await impactProbe.collect(3_000);

    expect(impact).toEqual({
      checked: true,
      chats: [{ sessionId: "chat-1", title: "Fix login", projectName: "ADE", projectRoot: "/code/ADE" }],
      cliSessions: 2,
      terminals: 3,
      connectedPhones: [{ deviceId: "phone-1", deviceName: "Arul's iPhone" }],
    });
    expect(logger.info).toHaveBeenCalledWith("autoUpdate.impact_probe", expect.objectContaining({ chats: 1 }));
  });

  it.each([
    {
      name: "a session the chats do not explain",
      chats: [],
      machineActivity: activity(0, 1),
      busyWithoutDetail: true,
    },
    {
      name: "a busy project with no tab open",
      chats: [chat("chat-1", "/code/ADE")],
      machineActivity: activity(2, 1),
      busyWithoutDetail: true,
    },
    {
      name: "nothing beyond the chats it found",
      chats: [chat("chat-1", "/code/ADE")],
      machineActivity: activity(1, 1),
      busyWithoutDetail: undefined,
    },
  ])("on a brain without the machine-wide answer, flags $name", async ({ chats, machineActivity, busyWithoutDetail }) => {
    const listOpenProjectChats = vi.fn(async () => chats);
    const { probe: impactProbe } = probe({
      readMachineImpact: async () => {
        throw new Error("Method runtime.updateImpact requires params.projectId.");
      },
      readMachineActivity: async () => machineActivity,
      listOpenProjectChats,
    });

    const impact = await impactProbe.collect(3_000);

    expect(impact.checked).toBe(true);
    expect(impact.chats).toEqual(chats);
    expect(impact.busyWithoutDetail).toBe(busyWithoutDetail);
    // A decision that stops agents needs every open project to answer.
    expect(listOpenProjectChats).toHaveBeenCalledWith(true);
  });

  it.each([
    { name: "does not answer in time", readMachineImpact: () => new Promise<unknown>(() => {}), reason: "timeout" },
    {
      name: "fails on both questions",
      readMachineImpact: async () => {
        throw new Error("no method");
      },
      listOpenProjectChats: async () => {
        throw new Error("project did not answer");
      },
      reason: "project did not answer",
    },
  ])("reports unknown, never nothing, when the brain $name", async ({ readMachineImpact, listOpenProjectChats, reason }) => {
    vi.useFakeTimers();
    const { probe: impactProbe, logger } = probe({
      readMachineImpact,
      ...(listOpenProjectChats ? { listOpenProjectChats } : {}),
    });

    const collecting = impactProbe.collect(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    const impact = await collecting;

    expect(impact).toMatchObject({ checked: false, chats: [], cliSessions: 0, terminals: 0 });
    expect(logger.warn).toHaveBeenCalledWith(
      "autoUpdate.impact_probe_unknown",
      expect.objectContaining({ reason }),
    );
    expect(logger.info).not.toHaveBeenCalledWith("autoUpdate.impact_probe", expect.anything());
  });
});

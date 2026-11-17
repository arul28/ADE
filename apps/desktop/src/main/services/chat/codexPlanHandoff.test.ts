import { describe, expect, it, vi } from "vitest";
import type { PendingInputRequest } from "../../../shared/types";
import { createCodexPlanDecisions, readCodexPlanHandoffs, type CodexPlanHandoffRecord, type PlanPresence } from "./codexPlanHandoff";

/**
 * The plan-handoff coordinator is a state machine with no UI and no provider:
 * one approval may create at most one chat, and one card may take one answer.
 * These are the seams a click cannot reach.
 */
function planRequest(overrides: Partial<PendingInputRequest> = {}): PendingInputRequest {
  return {
    requestId: "item-1",
    itemId: "item-1",
    source: "codex",
    kind: "plan_approval",
    description: "1. Inspect\n2. Patch",
    questions: [{ id: "plan_decision", question: "1. Inspect\n2. Patch" }],
    allowsFreeform: true,
    blocking: true,
    canProceedWithoutAnswer: false,
    turnId: "turn-1",
    ...overrides,
  };
}

function deps(records: CodexPlanHandoffRecord[]) {
  const sent: Array<{ sessionId: string; plan: string }> = [];
  const existing = new Set<string>();
  const withPlan = new Set<string>();
  return {
    records,
    sent,
    /** A chat that exists and holds the plan. */
    present(id: string, holdsPlan = true): void {
      existing.add(id);
      if (holdsPlan) withPlan.add(id);
    },
    dropped: [] as string[],
    args: {
      sessionId: "source-chat",
      itemId: "item-1",
      records,
      pending: vi.fn(async () => planRequest()),
      save: vi.fn(),
      create: vi.fn(async (record: CodexPlanHandoffRecord) => {
        existing.add(record.implementationSessionId);
      }),
      exists: (id: string) => existing.has(id),
      hasPlan: vi.fn(async (id: string): Promise<PlanPresence> => (withPlan.has(id) ? "present" : "absent")),
      send: vi.fn(async (id: string, plan: string) => {
        sent.push({ sessionId: id, plan });
        withPlan.add(id);
      }),
      onAcceptedSendError: vi.fn(),
      discard: vi.fn(async (id: string) => {
        existing.delete(id);
      }),
      complete: vi.fn(async () => undefined),
    },
  };
}

describe("codexPlanHandoff", () => {
  it("opens the reserved chat on a retry instead of creating a second one", async () => {
    const records: CodexPlanHandoffRecord[] = [];
    const setup = deps(records);
    setup.args.complete.mockImplementationOnce(async () => {
      throw new Error("lost the reply");
    });
    const decisions = createCodexPlanDecisions();

    await expect(decisions.handoff(setup.args)).rejects.toThrow("lost the reply");
    const created = records[0]!;

    const result = await decisions.handoff(setup.args);

    expect(result).toEqual({ implementationSessionId: created.implementationSessionId });
    expect(setup.args.create).toHaveBeenCalledTimes(1);
    expect(setup.args.send).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(1);
  });

  it("never sends the plan twice once the destination holds it", async () => {
    const records: CodexPlanHandoffRecord[] = [];
    const setup = deps(records);
    const decisions = createCodexPlanDecisions();

    const first = await decisions.handoff(setup.args);
    setup.present(first.implementationSessionId);
    await decisions.handoff(setup.args);

    expect(setup.args.send).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(1);
  });

  it("drops a reservation whose destination never received the plan", async () => {
    const records: CodexPlanHandoffRecord[] = [];
    const setup = deps(records);
    setup.args.create.mockImplementationOnce(async (record: CodexPlanHandoffRecord) => {
      // The chat row was written but the first message never reached it.
      setup.present(record.implementationSessionId, false);
      throw new Error("Codex app-server is not signed in.");
    });
    const decisions = createCodexPlanDecisions();

    await expect(decisions.handoff(setup.args)).rejects.toThrow("not signed in");

    expect(records).toHaveLength(0);
    expect(setup.args.discard).toHaveBeenCalledTimes(1);
  });

  it("refuses a second answer while a handoff is starting, and a handoff while an answer is starting", async () => {
    const decisions = createCodexPlanDecisions();
    const setup = deps([]);

    const release = decisions.beginAnswer("source-chat", "item-1");
    // Two clients answering the same card at once: the second is refused, so the
    // plan cannot be answered twice by a phone and a desktop in the same tick.
    expect(() => decisions.beginAnswer("source-chat", "item-1")).toThrow("already being sent");
    expect(() => decisions.handoff(setup.args)).toThrow("being answered");
    release();

    let finishCreate: () => void = () => {};
    setup.args.create.mockImplementationOnce(async (record: CodexPlanHandoffRecord) => {
      setup.present(record.implementationSessionId);
      await new Promise<void>((resolve) => { finishCreate = resolve; });
    });
    const running = decisions.handoff(setup.args);
    await vi.waitFor(() => expect(setup.args.create).toHaveBeenCalled());

    expect(() => decisions.beginAnswer("source-chat", "item-1")).toThrow("implementation chat is starting");
    expect(decisions.isHandoffStarting("source-chat")).toBe(true);

    // A plan approval restored after a restart has no runtime waiter, so the
    // handoff cannot recognise it as a plan answer: any answer in flight for the
    // chat must still block it, or the plan is implemented twice.
    const releaseChatAnswer = decisions.beginChatAnswer("restored-chat");
    expect(() => decisions.handoff({ ...setup.args, sessionId: "restored-chat" }))
      .toThrow("being answered");
    releaseChatAnswer();
    expect(decisions.isAnsweringChat("restored-chat")).toBe(false);

    finishCreate();
    await running;
    expect(decisions.isHandoffStarting("source-chat")).toBe(false);
    expect(() => decisions.beginAnswer("source-chat", "item-1")).not.toThrow();
  });

  it("only reads a ledger with a real uuid, a known item and a boolean state", () => {
    const records = readCodexPlanHandoffs([
      { itemId: "a", implementationSessionId: "not-a-uuid", turnId: null, submitted: false },
      { itemId: "b", implementationSessionId: "5f1f9f0e-2d1a-4c3b-8f1e-9a0b1c2d3e4f", turnId: null, submitted: "yes" },
      { itemId: "c", implementationSessionId: "5f1f9f0e-2d1a-4c3b-8f1e-9a0b1c2d3e4f", turnId: "turn-1", submitted: true },
    ]);
    expect(records).toEqual([
      { itemId: "c", implementationSessionId: "5f1f9f0e-2d1a-4c3b-8f1e-9a0b1c2d3e4f", turnId: "turn-1", submitted: true },
    ]);
    expect(readCodexPlanHandoffs("nonsense")).toEqual([]);
  });

});

import { describe, expect, it } from "vitest";
import type { AgentChatCrossMachineHandoffRecord } from "./types/chat";
import { crossMachineMoveLock } from "./crossMachineMoveLock";

const continuedRecord = (overrides: Partial<AgentChatCrossMachineHandoffRecord> = {}): AgentChatCrossMachineHandoffRecord => ({
  handoffId: "handoff-1",
  state: "continued",
  checkpoint: "marked",
  targetMachineKey: "studio-key",
  targetMachineName: "Mac Studio",
  mode: "brief",
  targetModelId: "openai/gpt-6.1-sol",
  includeChanges: false,
  requestedBy: "agent",
  requestedAt: "2026-10-20T12:00:00.000Z",
  updatedAt: "2026-10-20T12:00:00.000Z",
  reason: null,
  targetLaneId: "lane-2",
  targetSessionId: "chat-2",
  continuedOn: {
    handoffId: "handoff-1",
    targetMachineKey: "studio-key",
    targetMachineName: "Mac Studio",
    targetLaneId: "lane-2",
    targetSessionId: "chat-2",
    continuedAt: "2026-10-20T12:00:00.000Z",
  },
  resumedHere: false,
  ...overrides,
});

describe("crossMachineMoveLock", () => {
  it("locks every unresumed continued move and uses its destination when available", () => {
    expect(crossMachineMoveLock(continuedRecord())).toEqual({
      handoffId: "handoff-1",
      targetMachineName: "Mac Studio",
      targetSessionId: "chat-2",
    });
    expect(crossMachineMoveLock(continuedRecord({ resumedHere: true }))).toBeNull();
    expect(crossMachineMoveLock(continuedRecord({ state: "sending" }))).toBeNull();
    expect(crossMachineMoveLock(continuedRecord({ continuedOn: null, targetSessionId: null }))).toEqual({
      handoffId: "handoff-1",
      targetMachineName: "Mac Studio",
      targetSessionId: "unknown",
    });
    expect(crossMachineMoveLock(null)).toBeNull();
  });
});

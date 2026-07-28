import { describe, expect, it } from "vitest";
import { startChatDraftPatch } from "./workDraft";

describe("startChatDraftPatch", () => {
  it("opens a chat draft on the requested lane and clears active session selection", () => {
    expect(startChatDraftPatch("lane-42")).toEqual({
      draftKind: "chat",
      orchestratorEnabled: false,
      draftLaneId: "lane-42",
      draftMachineId: null,
      activeItemId: null,
      selectedItemId: null,
    });
  });
});

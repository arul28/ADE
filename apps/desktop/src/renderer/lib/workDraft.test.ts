import { describe, expect, it } from "vitest";
import { chatDraftMachineId, startChatDraftPatch } from "./workDraft";

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

  it("pins a foreign machine so the draft does not resolve against the bound lane list", () => {
    expect(startChatDraftPatch("lane-42", "studio")).toMatchObject({
      draftLaneId: "lane-42",
      draftMachineId: "studio",
    });
  });
});

describe("chatDraftMachineId", () => {
  it("collapses the bound machine to null", () => {
    expect(chatDraftMachineId("this-mac", "this-mac")).toBeNull();
    expect(chatDraftMachineId(null, "this-mac")).toBeNull();
    expect(chatDraftMachineId("studio", "this-mac")).toBe("studio");
  });
});

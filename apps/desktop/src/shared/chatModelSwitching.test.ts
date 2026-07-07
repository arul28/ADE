import { describe, expect, it } from "vitest";
import { filterChatModelIdsForSession } from "./chatModelSwitching";

describe("chatModelSwitching", () => {
  it("returns all models regardless of family after launch", () => {
    expect(
      filterChatModelIdsForSession({
        availableModelIds: [
          "anthropic/claude-sonnet-5",
          "openai/gpt-5.4",
          "openai/gpt-5.3-codex",
        ],
        activeSessionModelId: "anthropic/claude-sonnet-5",
        hasConversation: true,
      }),
    ).toEqual([
      "anthropic/claude-sonnet-5",
      "openai/gpt-5.4",
      "openai/gpt-5.3-codex",
    ]);
  });

  it("keeps the active session model visible when it fell out of the catalog", () => {
    expect(
      filterChatModelIdsForSession({
        availableModelIds: ["anthropic/claude-sonnet-5", "openai/gpt-5.4"],
        activeSessionModelId: "openai/gpt-5.2",
        hasConversation: true,
      }),
    ).toEqual([
      "openai/gpt-5.2",
      "anthropic/claude-sonnet-5",
      "openai/gpt-5.4",
    ]);
  });

  it("can leave the active session model out when a caller supplies a strict allowlist", () => {
    expect(
      filterChatModelIdsForSession({
        availableModelIds: ["anthropic/claude-sonnet-5"],
        activeSessionModelId: "openai/gpt-5.4",
        hasConversation: true,
        includeActiveSessionModel: false,
      }),
    ).toEqual(["anthropic/claude-sonnet-5"]);
  });
});

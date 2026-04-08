import { describe, expect, it } from "vitest";
import { canSwitchChatSessionModel, filterChatModelIdsForSession } from "./chatModelSwitching";

describe("chatModelSwitching", () => {
  it("returns all models regardless of family after launch", () => {
    expect(
      filterChatModelIdsForSession({
        availableModelIds: [
          "anthropic/claude-sonnet-4-6",
          "openai/gpt-5.4-codex",
          "openai/gpt-5.2-codex",
        ],
        activeSessionModelId: "anthropic/claude-sonnet-4-6",
        hasConversation: true,
      }),
    ).toEqual([
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5.4-codex",
      "openai/gpt-5.2-codex",
    ]);
  });

  it("allows launched CTO-style chats to switch across families", () => {
    expect(
      filterChatModelIdsForSession({
        availableModelIds: [
          "anthropic/claude-sonnet-4-6",
          "openai/gpt-5.4-codex",
          "openai/gpt-5.2",
        ],
        activeSessionModelId: "anthropic/claude-sonnet-4-6",
        hasConversation: true,
        policy: "any-after-launch",
      }),
    ).toEqual([
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5.4-codex",
      "openai/gpt-5.2",
    ]);
  });

  it("allows same-family switches after launch", () => {
    expect(
      canSwitchChatSessionModel({
        currentModelId: "openai/gpt-5.4-codex",
        nextModelId: "openai/gpt-5.2",
        hasConversation: true,
      }),
    ).toBe(true);
  });

  it("allows cross-family switches after launch", () => {
    expect(
      canSwitchChatSessionModel({
        currentModelId: "anthropic/claude-sonnet-4-6",
        nextModelId: "openai/gpt-5.4-codex",
        hasConversation: true,
      }),
    ).toBe(true);

    expect(
      canSwitchChatSessionModel({
        currentModelId: "anthropic/claude-sonnet-4-6",
        nextModelId: "openai/gpt-5.4-codex",
        hasConversation: true,
        policy: "any-after-launch",
      }),
    ).toBe(true);
  });

  it("allows any switch before the conversation starts", () => {
    expect(
      canSwitchChatSessionModel({
        currentModelId: "anthropic/claude-sonnet-4-6",
        nextModelId: "openai/gpt-5.4-codex",
        hasConversation: false,
      }),
    ).toBe(true);
  });
});

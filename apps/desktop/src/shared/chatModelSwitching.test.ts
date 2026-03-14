import { describe, expect, it } from "vitest";
import { canSwitchChatSessionModel, filterChatModelIdsForSession } from "./chatModelSwitching";

describe("chatModelSwitching", () => {
  it("keeps launched chats within the active family by default", () => {
    expect(
      filterChatModelIdsForSession({
        availableModelIds: [
          "anthropic/claude-sonnet-4-6",
          "anthropic/claude-sonnet-4-6-api",
          "openai/gpt-5.4-codex",
          "openai/gpt-5-chat-latest",
        ],
        activeSessionModelId: "anthropic/claude-sonnet-4-6",
        hasConversation: true,
      }),
    ).toEqual([
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-sonnet-4-6-api",
    ]);
  });

  it("allows launched CTO-style chats to switch across families", () => {
    expect(
      filterChatModelIdsForSession({
        availableModelIds: [
          "anthropic/claude-sonnet-4-6",
          "openai/gpt-5.4-codex",
          "openai/gpt-5-chat-latest",
        ],
        activeSessionModelId: "anthropic/claude-sonnet-4-6",
        hasConversation: true,
        policy: "any-after-launch",
      }),
    ).toEqual([
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5.4-codex",
      "openai/gpt-5-chat-latest",
    ]);
  });

  it("allows same-family switches after launch", () => {
    expect(
      canSwitchChatSessionModel({
        currentModelId: "openai/gpt-5.4-codex",
        nextModelId: "openai/gpt-5-chat-latest",
        hasConversation: true,
      }),
    ).toBe(true);
  });

  it("blocks cross-family switches after launch unless explicitly allowed", () => {
    expect(
      canSwitchChatSessionModel({
        currentModelId: "anthropic/claude-sonnet-4-6",
        nextModelId: "openai/gpt-5.4-codex",
        hasConversation: true,
      }),
    ).toBe(false);

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

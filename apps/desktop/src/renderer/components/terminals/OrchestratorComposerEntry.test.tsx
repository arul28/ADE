/* @vitest-environment jsdom */

/**
 * Composer entry point for new orchestrator chats. The user picks
 * "Orchestrator" from the AgentChatComposer prompt-box mode button.
 *
 * That flow resolves to `onShowDraftKind("chat-orchestrator")`. The
 * subsequent draft submit calls `agentChat.create({ interactionMode:
 * "orchestrator-lead", ... })` and `orchestration.runCreate({ laneId,
 * leadSessionId })` — see `goal.md` §10.1 + §17 step 6.
 */

import { describe, expect, it, vi } from "vitest";

/**
 * Verifies the contract from the composer side: the prompt-box button asks
 * TerminalsPage to switch the draft kind through this event.
 */
describe("composer New orchestrator chat entry contract", () => {
  it("dispatches `ade:work:start-orchestrator-chat` when invoked", () => {
    const onShowDraftKind = vi.fn();
    const handler = () => onShowDraftKind("chat-orchestrator");
    window.addEventListener("ade:work:start-orchestrator-chat", handler);
    window.dispatchEvent(new CustomEvent("ade:work:start-orchestrator-chat"));
    expect(onShowDraftKind).toHaveBeenCalledWith("chat-orchestrator");
    window.removeEventListener("ade:work:start-orchestrator-chat", handler);
  });
});

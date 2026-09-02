import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginSurfaceContext } from "../../../../shared/plugins/context";

/**
 * The `{prompt}` action-result verb, at the socket dispatcher.
 *
 * The reader-facing half of the ledger's B1: a button could not ask for a line
 * of text, so the journal plugin logged the chat's auto-generated title and the
 * user's journal filled up with "Follow Image Instructions". The rules that make
 * the verb safe behind ANY button are asserted here — cancel invokes nothing,
 * and one question per press — because both are invisible until they are wrong.
 *
 * `readPluginActionPrompt` itself is proved in `shared/plugins/sdk.test.ts`.
 * What is this layer's own contract is the round trip.
 */

const invokePluginSocketAction = vi.fn();

vi.mock("./contributionBridge", () => ({
  invokePluginSocketAction: (...args: unknown[]) => invokePluginSocketAction(...args),
  manifestOf: () => null,
}));

const CONTEXT: PluginSurfaceContext = {
  kind: "session",
  id: "chat-1",
  title: "A chat",
  provider: "claude",
  status: null,
};

const PROMPT_RESULT = {
  prompt: { id: "note", title: "What are you working on?", context: { lane: "main" } },
};

beforeEach(() => {
  invokePluginSocketAction.mockReset();
});

afterEach(async () => {
  const { closePluginPrompt } = await import("./pluginPromptStore");
  closePluginPrompt();
});

describe("an action that answers with a prompt", () => {
  it("asks the question instead of finishing", async () => {
    invokePluginSocketAction.mockResolvedValue(PROMPT_RESULT);
    const { runPluginSocketAction } = await import("./pluginActionDispatch");
    const { getPluginPrompt } = await import("./pluginPromptStore");

    await runPluginSocketAction("journal", "logIt", CONTEXT, { label: "Log it" });

    const pending = getPluginPrompt();
    expect(pending?.pluginId).toBe("journal");
    expect(pending?.prompt.title).toBe("What are you working on?");
    // The word the reader pressed, kept for the card to fall back to.
    expect(pending?.fallbackTitle).toBe("Log it");
    expect(invokePluginSocketAction).toHaveBeenCalledTimes(1);
  });

  it("re-invokes the SAME action with the answer, the pointer and the original args", async () => {
    invokePluginSocketAction
      .mockResolvedValueOnce(PROMPT_RESULT)
      .mockResolvedValueOnce({ message: "Logged." });
    const { runPluginSocketAction } = await import("./pluginActionDispatch");
    const { getPluginPrompt, submitPluginPrompt } = await import("./pluginPromptStore");

    await runPluginSocketAction("journal", "logIt", CONTEXT, {
      socket: "chat-header-action",
      args: { kind: "note" },
    });
    submitPluginPrompt("wrote the ledger");
    await vi.waitFor(() => expect(invokePluginSocketAction).toHaveBeenCalledTimes(2));

    const [pluginId, actionId, args] = invokePluginSocketAction.mock.calls[1] ?? [];
    expect(pluginId).toBe("journal");
    expect(actionId).toBe("logIt");
    expect(args).toMatchObject({
      kind: "note",
      prompt: { id: "note", text: "wrote the ledger", context: { lane: "main" } },
    });
    // Answered, so the card is gone before the re-invocation draws anything.
    expect(getPluginPrompt()).toBeNull();
  });

  it("ignores a second question from the re-invocation, so a plugin cannot loop", async () => {
    invokePluginSocketAction.mockResolvedValue(PROMPT_RESULT);
    const { runPluginSocketAction } = await import("./pluginActionDispatch");
    const { getPluginPrompt, submitPluginPrompt } = await import("./pluginPromptStore");

    await runPluginSocketAction("journal", "logIt", CONTEXT);
    submitPluginPrompt("first answer");
    await vi.waitFor(() => expect(invokePluginSocketAction).toHaveBeenCalledTimes(2));

    // The second call answered with a prompt too, and it was dropped: one press,
    // one question.
    expect(getPluginPrompt()).toBeNull();
  });

  it("invokes nothing when the reader cancels", async () => {
    invokePluginSocketAction.mockResolvedValue(PROMPT_RESULT);
    const { runPluginSocketAction } = await import("./pluginActionDispatch");
    const { closePluginPrompt, getPluginPrompt } = await import("./pluginPromptStore");

    await runPluginSocketAction("journal", "logIt", CONTEXT);
    closePluginPrompt();

    expect(getPluginPrompt()).toBeNull();
    expect(invokePluginSocketAction).toHaveBeenCalledTimes(1);
  });

  it("refuses an answer over the ceiling rather than saving half of it", async () => {
    invokePluginSocketAction.mockResolvedValue(PROMPT_RESULT);
    const { runPluginSocketAction } = await import("./pluginActionDispatch");
    const { submitPluginPrompt } = await import("./pluginPromptStore");
    const { PLUGIN_PROMPT_TEXT_MAX_BYTES } = await import("../../../../shared/plugins/sdk");

    await runPluginSocketAction("journal", "logIt", CONTEXT);
    submitPluginPrompt("x".repeat(PLUGIN_PROMPT_TEXT_MAX_BYTES + 1));

    expect(invokePluginSocketAction).toHaveBeenCalledTimes(1);
  });

  it("does not ask when the question has no usable id", async () => {
    invokePluginSocketAction.mockResolvedValue({ prompt: { title: "What?" } });
    const { runPluginSocketAction } = await import("./pluginActionDispatch");
    const { getPluginPrompt } = await import("./pluginPromptStore");

    await runPluginSocketAction("journal", "logIt", CONTEXT);

    expect(getPluginPrompt()).toBeNull();
    expect(invokePluginSocketAction).toHaveBeenCalledTimes(1);
  });

  it("carries closed options through so the card can draw a picker", async () => {
    invokePluginSocketAction.mockResolvedValue({
      prompt: {
        id: "lane",
        title: "Link to a lane",
        options: [{ value: "lane-1", label: "One" }, { value: "lane-2", label: "Two" }],
      },
    });
    const { runPluginSocketAction } = await import("./pluginActionDispatch");
    const { getPluginPrompt, submitPluginPrompt } = await import("./pluginPromptStore");

    await runPluginSocketAction("linear", "linkToLane", CONTEXT, { label: "Link to a lane" });

    expect(getPluginPrompt()?.prompt.options).toEqual([
      { value: "lane-1", label: "One" },
      { value: "lane-2", label: "Two" },
    ]);
    submitPluginPrompt("lane-2");
    await vi.waitFor(() => expect(invokePluginSocketAction).toHaveBeenCalledTimes(2));
    expect(invokePluginSocketAction.mock.calls[1]?.[2]).toMatchObject({
      prompt: { id: "lane", text: "lane-2" },
    });
  });
});

import type { AgentChatCreateArgs, AgentChatModelInfo, AgentChatProvider } from "../../../shared/types";

type ModelSource = {
  getAvailableModels: (args: { provider?: AgentChatProvider; activateRuntime?: boolean }) => Promise<AgentChatModelInfo[]>;
};

/**
 * A chat create with an empty `model` gets the host's first available model
 * for its provider. Shared by the sync host's `chat.create` / `chat.launch`
 * and the chat-launch service (desktop action and sync `chat.startLaunch`
 * alike), so every path that creates a chat picks the same model.
 */
export async function resolveChatCreateModel<T extends Pick<AgentChatCreateArgs, "provider" | "model" | "modelId">>(
  service: ModelSource,
  payload: T,
): Promise<T> {
  if (payload.model.trim().length > 0) return payload;
  const available = await service.getAvailableModels({
    provider: payload.provider,
    // ACP providers are here for the same reason as OpenCode/Pi: their model
    // rows are gated on a CLI auth pass, and `activateRuntime` refreshes that
    // pass. It does not spawn an agent for them.
    ...(
      payload.provider === "opencode"
      || payload.provider === "pi"
      || payload.provider === "qwen"
      || payload.provider === "kimi"
      || payload.provider === "grok"
      || payload.provider === "copilot"
        ? { activateRuntime: true }
        : {}
    ),
  });
  const chosen = available[0];
  if (!chosen) {
    throw new Error(`No configured ${payload.provider} chat model is available on the host.`);
  }
  return {
    ...payload,
    model: chosen.id,
    ...(!payload.modelId && chosen.modelId ? { modelId: chosen.modelId } : {}),
  };
}

import React, { createContext, useContext } from "react";

/**
 * The chat API one chat pane talks to.
 *
 * A project chat uses `window.ade.agentChat`, which routes to the project's
 * runtime. A chat with no project uses an adapter with the same shape whose
 * every call goes to the machine's `personalChats.*` actions instead (see
 * `personalChats/personalAgentChatApi.ts`). The pane and the components under
 * it read the API from here rather than from `window.ade.agentChat`, so a
 * personal chat can never reach the active project's runtime by accident.
 *
 * The adapter is deliberately partial: a method it does not implement is
 * absent, and the pane hides the affordance that would call it.
 */
export type AgentChatApi = Window["ade"]["agentChat"];

/**
 * The personal chat adapter. It is bound to one machine when it is made, so
 * its event feed needs no pin (a pin passed to it is ignored).
 */
export type MachineBoundAgentChatApi = AgentChatApi & {
  onEvent(listener: (event: Parameters<Parameters<AgentChatApi["onEvent"]>[0]>[0]) => void): () => void;
  slashCommands(args: Parameters<AgentChatApi["slashCommands"]>[0]): ReturnType<AgentChatApi["slashCommands"]>;
  getImageDataUrl(path: string): Promise<{ dataUrl: string }>;
};

/**
 * What a pane is routed to. Absent means the project chat domain. Every
 * scope is bound to one place when it is made, so the pane hides what only a
 * project chat can do:
 * - `personal`: a machine's chats with no project (`personalChats.*`);
 * - `lane_share_guest`: a guest's view of one shared lane, whose every call
 *   goes to the owner's computer through the guest connection.
 */
export type ChatPaneScope = {
  kind: "personal" | "lane_share_guest";
  /** `agentChat`-shaped API bound to that place. */
  agentChat: MachineBoundAgentChatApi;
  /** Model-catalog scope the model picker reads its descriptors under. */
  modelCatalogScopeKey: string;
  /**
   * The machine the chat runs on, when the scope names one (the Chats page
   * lists every machine's chats; a shared lane runs on its owner's);
   * otherwise the window's machine.
   */
  machineName?: string | null;
};

const AgentChatApiContext = createContext<AgentChatApi | null>(null);
const ChatPaneScopeContext = createContext<ChatPaneScope | null>(null);

export function AgentChatApiProvider({
  scope,
  children,
}: {
  scope: ChatPaneScope | null;
  children: React.ReactNode;
}) {
  return (
    <ChatPaneScopeContext.Provider value={scope}>
      <AgentChatApiContext.Provider value={scope?.agentChat ?? null}>
        {children}
      </AgentChatApiContext.Provider>
    </ChatPaneScopeContext.Provider>
  );
}

/** The chat API for the surrounding pane; the project API outside one. */
export function useAgentChatApi(): AgentChatApi {
  return useContext(AgentChatApiContext) ?? window.ade?.agentChat;
}

/** The surrounding pane's scope, or null for a project chat. */
export function useChatPaneScope(): ChatPaneScope | null {
  return useContext(ChatPaneScopeContext);
}

/**
 * The surrounding pane's own image reader, or null for a project chat (which
 * reads through its machine's runtime). A personal chat's images live in its
 * own store and workspace, which no project runtime, and not this window's
 * file reader, will open. Pass it to `readAttachmentImageDataUrl` as `reader`.
 */
export function useChatImageReader(): ((path: string) => Promise<{ dataUrl: string }>) | null {
  return useChatPaneScope()?.agentChat.getImageDataUrl ?? null;
}

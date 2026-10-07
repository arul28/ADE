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

/** What a pane is routed to. Absent means the project chat domain. */
export type ChatPaneScope = {
  kind: "personal";
  /** `agentChat`-shaped API backed by `personalChats.*`. */
  agentChat: AgentChatApi;
  /** Model-catalog scope the personal model picker registered its descriptors under. */
  modelCatalogScopeKey: string;
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

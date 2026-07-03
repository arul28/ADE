import type { AgentChatSessionSummary } from "../../../desktop/src/shared/types/chat";

export type DrawerChatSelection = {
  selectedDrawerChatId: string | null;
  selectedDrawerChatAction: "new-chat" | "closed-toggle" | null;
};

export function chatSelectionCopyText(args: {
  drawerSection: "lanes" | "chats";
  displaySessions: AgentChatSessionSummary[];
  selectedDrawerChatAction: "new-chat" | "closed-toggle" | null;
  selectedDrawerChatId: string | null;
}): string | null {
  if (args.drawerSection !== "chats") return null;
  if (args.selectedDrawerChatAction !== null || !args.selectedDrawerChatId) return null;
  const session = args.displaySessions.find((entry) => entry.sessionId === args.selectedDrawerChatId);
  if (!session) return null;
  return session.title?.trim() || session.sessionId;
}

export function resolveDrawerChatSelection(args: {
  activeLaneId: string | null;
  activeSessionId: string | null;
  draftChatActive: boolean;
  drawerLaneId: string | null;
  drawerVisibleLaneSessions: AgentChatSessionSummary[];
  closedToggleVisible?: boolean;
  selectedDrawerChatAction: "new-chat" | "closed-toggle" | null;
  selectedDrawerChatId: string | null;
}): DrawerChatSelection | null {
  const selectedChatIsVisible = Boolean(
    args.selectedDrawerChatId
    && args.drawerVisibleLaneSessions.some((session) => session.sessionId === args.selectedDrawerChatId),
  );
  if (selectedChatIsVisible) {
    return null;
  }

  const selectedClosedToggleIsValid = args.selectedDrawerChatAction === "closed-toggle"
    && args.selectedDrawerChatId == null
    && args.drawerLaneId != null
    && args.closedToggleVisible === true;
  if (selectedClosedToggleIsValid) return null;

  const selectedNewChatIsValid = args.selectedDrawerChatAction === "new-chat"
    && args.selectedDrawerChatId == null
    && args.drawerLaneId != null;
  if (selectedNewChatIsValid) return null;

  if (args.draftChatActive && args.drawerLaneId === args.activeLaneId) {
    return { selectedDrawerChatId: null, selectedDrawerChatAction: "new-chat" };
  }
  const activeChatInDrawer = args.drawerVisibleLaneSessions.find(
    (session) => session.sessionId === args.activeSessionId,
  );
  return {
    selectedDrawerChatId: activeChatInDrawer?.sessionId ?? args.drawerVisibleLaneSessions[0]?.sessionId ?? null,
    selectedDrawerChatAction: null,
  };
}

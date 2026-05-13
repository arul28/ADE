import type { AgentChatSessionSummary } from "../../../desktop/src/shared/types/chat";

export type DrawerChatSelection = {
  selectedDrawerChatId: string | null;
  selectedDrawerChatAction: "new-chat" | null;
};

export function resolveDrawerChatSelection(args: {
  activeLaneId: string | null;
  activeSessionId: string | null;
  draftChatActive: boolean;
  drawerLaneId: string | null;
  drawerVisibleLaneSessions: AgentChatSessionSummary[];
  selectedDrawerChatAction: "new-chat" | null;
  selectedDrawerChatId: string | null;
}): DrawerChatSelection | null {
  const selectedChatIsVisible = Boolean(
    args.selectedDrawerChatId
    && args.drawerVisibleLaneSessions.some((session) => session.sessionId === args.selectedDrawerChatId),
  );
  if (selectedChatIsVisible) {
    return null;
  }

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

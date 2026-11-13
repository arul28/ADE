import React from "react";
import type { LaneShareGuestState } from "../../../../shared/laneShareRights";
import { laneShareGuestSendBlockedReason } from "./laneShareGuestModel";
import { AgentChatPane } from "../../chat/AgentChatPane";
import type { ChatPaneScope } from "../../chat/agentChatApi";
import { DEFAULT_RUNTIME_CATALOG_SCOPE } from "../../shared/ModelPicker/runtimeCatalogCache";
import { createLaneShareGuestAgentChatApi } from "./laneShareGuestAgentChatApi";
import type { LaneShareGuestConnection, LaneShareGuestSession } from "./laneShareGuestConnection";

/**
 * One chat of a shared lane, in ADE's real chat pane. Calls go to the
 * owner's computer through the guest connection (`laneShareGuestAgentChatApi`),
 * where the owner's guest gates decide. What the guest's rights do not allow
 * shows as a locked control with the reason; project-only parts of the pane
 * (files, PRs, other lanes) are hidden by its bound scope.
 */

export function LaneShareGuestChatPane({
  connection,
  session,
  guestState,
  connected,
  ownerLabel,
  machineName,
}: {
  connection: LaneShareGuestConnection;
  session: LaneShareGuestSession;
  guestState: LaneShareGuestState | null;
  connected: boolean;
  ownerLabel: string;
  machineName: string | null;
}) {
  const guestStateRef = React.useRef(guestState);
  guestStateRef.current = guestState;
  const agentChat = React.useMemo(
    () => createLaneShareGuestAgentChatApi(connection, () => guestStateRef.current),
    [connection],
  );
  React.useEffect(() => () => agentChat.dispose(), [agentChat]);

  const rights = guestState?.rights ?? null;
  const modeLock = rights && rights.run.permissionModes.length === 0
    ? `${ownerLabel} keeps the mode of this chat.`
    : null;
  const reasoningLocked = Boolean(rights && rights.run.reasoningLevels.length === 0);
  const sendBlockedReason = laneShareGuestSendBlockedReason({ state: guestState, connected, ownerLabel });
  // The scope names where calls go; it stays the same while rights and
  // limits change (those are pane props), so the pane keeps its subscriptions.
  const scope = React.useMemo<ChatPaneScope>(() => ({
    kind: "lane_share_guest",
    agentChat,
    modelCatalogScopeKey: DEFAULT_RUNTIME_CATALOG_SCOPE,
    // The chat runs on the owner's computer; with hidden machine names it is still not "This computer".
    machineName: machineName ?? `${ownerLabel}'s computer`,
  }), [agentChat, machineName, ownerLabel]);
  const models = guestState?.models ?? [];
  const draftsOnly = Boolean(rights && !rights.speak.send && rights.speak.drafts);

  return (
    <AgentChatPane
      key={`${connection.grantId}:${session.sessionId}`}
      laneId={null}
      chatScope={scope}
      lockSessionId={session.sessionId}
      lockSessionProvider={null}
      availableModelIdsOverride={models}
      modelSelectionLocked={models.length === 0}
      permissionModeLockReason={modeLock}
      effortSelectionLocked={reasoningLocked}
      sendBlockedReason={sendBlockedReason}
      personalDraftKey={`lane-share:${connection.grantId}:${session.sessionId}`}
      canvasFill="var(--ade-chat-scene-canvas)"
      hideSessionTabs
      hideWorkspaceChrome
      hideSurfaceHeader
      hideLaneToolDrawers
      presentation={{
        mode: "standard",
        title: session.title,
        assistantLabel: session.title,
        messagePlaceholder: draftsOnly
          ? `Write a draft for ${ownerLabel} to send…`
          : `Message this chat on ${ownerLabel}'s computer…`,
      }}
    />
  );
}

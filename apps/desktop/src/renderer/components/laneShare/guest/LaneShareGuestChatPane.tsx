import React from "react";
import type { LaneShareGuestState } from "../../../../shared/laneShareRights";
import { AgentChatPane } from "../../chat/AgentChatPane";
import type { LaneShareGuestChatPaneScope } from "../../chat/agentChatApi";
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

/**
 * Whether the guest may see this model name: always without "Hide my
 * models", else only a permitted one. The host already hides the others;
 * this is the second check.
 */
export function laneShareGuestModelLabel(modelId: string | null | undefined, state: LaneShareGuestState | null): string | null {
  const model = typeof modelId === "string" ? modelId.trim() : "";
  if (!model || !state) return null;
  if (state.rights.privacy.hideModels && !state.models.includes(model)) return null;
  return model;
}

/** "3 of 20 left today", or null without a limit. */
export function laneShareMessagesLeftText(state: LaneShareGuestState): string | null {
  const { messagesLeftToday, messagesLeftTotal, messagesPerDay, messagesTotal } = state.limits;
  if (messagesPerDay != null && messagesLeftToday != null) return `${messagesLeftToday} of ${messagesPerDay} messages left today`;
  if (messagesTotal != null && messagesLeftTotal != null) return `${messagesLeftTotal} of ${messagesTotal} messages left`;
  return null;
}

function limitReached(state: LaneShareGuestState, ownerLabel: string): string | null {
  const { messagesLeftToday, messagesLeftTotal, dailyResetAt } = state.limits;
  if (messagesLeftTotal === 0) return `You used all the messages this share allows. Ask ${ownerLabel} for more.`;
  if (messagesLeftToday === 0) {
    const at = dailyResetAt != null
      ? new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(dailyResetAt))
      : null;
    return at ? `No messages left today. They start again ${at}.` : "No messages left today.";
  }
  return null;
}

/** Why the guest cannot send now, or null. */
export function laneShareGuestSendBlockedReason(args: {
  state: LaneShareGuestState | null;
  connected: boolean;
  ownerLabel: string;
}): string | null {
  const { state, connected, ownerLabel } = args;
  if (!connected) return `Waiting for ${ownerLabel}'s computer.`;
  if (!state) return "Reading your access…";
  if (state.state === "paused") return `${ownerLabel} paused this lane.`;
  const { speak } = state.rights;
  if (!speak.send && !speak.drafts) return `${ownerLabel} shared this lane to watch only.`;
  return limitReached(state, ownerLabel);
}

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
  const sendBlockedReason = laneShareGuestSendBlockedReason({ state: guestState, connected, ownerLabel });
  const scope = React.useMemo<LaneShareGuestChatPaneScope>(() => ({
    kind: "lane_share_guest",
    agentChat,
    modelCatalogScopeKey: DEFAULT_RUNTIME_CATALOG_SCOPE,
    machineName,
    grantId: connection.grantId,
    permissionModeLockReason: modeLock,
    sendBlockedReason,
  }), [agentChat, connection.grantId, machineName, modeLock, sendBlockedReason]);
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

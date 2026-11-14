import type { LaneShareGuestState } from "../../../../shared/laneShareRights";

/** Plain helpers for what a guest sees of its share: model names, limits, send blocks. */

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

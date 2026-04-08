import type { ChatModelSwitchPolicy } from "./types/chat";

type FilterChatModelIdsArgs = {
  availableModelIds: string[];
  activeSessionModelId?: string | null;
  hasConversation: boolean;
  policy?: ChatModelSwitchPolicy;
};

type CanSwitchChatSessionModelArgs = {
  currentModelId?: string | null;
  nextModelId?: string | null;
  hasConversation: boolean;
  policy?: ChatModelSwitchPolicy;
};

export function canSwitchChatSessionModel(_args: CanSwitchChatSessionModelArgs): boolean {
  // All switching is permitted — the runtime handles provider transitions.
  return true;
}

export function filterChatModelIdsForSession(args: FilterChatModelIdsArgs): string[] {
  const ids = args.availableModelIds.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  const activeModelId = String(args.activeSessionModelId ?? "").trim();
  if (activeModelId && !ids.includes(activeModelId)) {
    return [activeModelId, ...ids];
  }
  return ids;
}

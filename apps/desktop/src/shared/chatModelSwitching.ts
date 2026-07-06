type FilterChatModelIdsArgs = {
  availableModelIds: string[];
  activeSessionModelId?: string | null;
  hasConversation: boolean;
  includeActiveSessionModel?: boolean;
};

/**
 * Normalize the model picker's candidate list. Any model can be selected at any
 * time (the runtime handles provider transitions), so this only ensures the
 * session's active model stays visible even when it has dropped out of the
 * discovered catalog.
 */
export function filterChatModelIdsForSession(args: FilterChatModelIdsArgs): string[] {
  const ids = args.availableModelIds.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  const activeModelId = String(args.activeSessionModelId ?? "").trim();
  if (args.includeActiveSessionModel !== false && activeModelId && !ids.includes(activeModelId)) {
    return [activeModelId, ...ids];
  }
  return ids;
}

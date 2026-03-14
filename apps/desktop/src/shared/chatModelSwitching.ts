import { getModelById, resolveModelAlias, type ModelDescriptor } from "./modelRegistry";
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

function resolveDescriptor(modelId: string | null | undefined): ModelDescriptor | null {
  const normalized = String(modelId ?? "").trim();
  if (!normalized.length) return null;
  return getModelById(normalized) ?? resolveModelAlias(normalized) ?? null;
}

export function resolveModelFamily(modelId: string | null | undefined): string | null {
  return resolveDescriptor(modelId)?.family ?? null;
}

export function canSwitchChatSessionModel(args: CanSwitchChatSessionModelArgs): boolean {
  if (!args.hasConversation) return true;
  if ((args.policy ?? "same-family-after-launch") === "any-after-launch") {
    return true;
  }

  const currentFamily = resolveModelFamily(args.currentModelId);
  const nextFamily = resolveModelFamily(args.nextModelId);
  if (!currentFamily || !nextFamily) return true;
  return currentFamily === nextFamily;
}

export function filterChatModelIdsForSession(args: FilterChatModelIdsArgs): string[] {
  let ids = args.availableModelIds.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  const activeModelId = String(args.activeSessionModelId ?? "").trim();
  if (activeModelId && !ids.includes(activeModelId)) {
    ids = [activeModelId, ...ids];
  }

  if (!args.hasConversation || (args.policy ?? "same-family-after-launch") === "any-after-launch") {
    return ids;
  }

  const activeFamily = resolveModelFamily(activeModelId);
  if (!activeFamily) return ids;
  return ids.filter((modelId) => resolveModelFamily(modelId) === activeFamily);
}

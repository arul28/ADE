import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentChatModelCatalog,
  OpenProjectBinding,
  PersonalChatAction,
  PersonalChatCallResponse,
} from "../../../shared/types";
import type { ChatPaneScope } from "../chat/agentChatApi";
import {
  agentChatModelCatalogHasAvailableModels,
  descriptorsFromAgentChatModelCatalog,
  personalChatCatalogScopeKey,
} from "../shared/ModelPicker/modelCatalog";
import type { WebChatsMachinePicker } from "../../webclient/workspace/useWebChatsMachines";
import { createPersonalAgentChatApi, type PersonalChatsBridge } from "./personalAgentChatApi";

/**
 * The machine's personal-chat bridge. Resolved per call, so a runtime without
 * personal chats surfaces as a call error in the page rather than a render crash.
 */
export function personalChatsBridge(): PersonalChatsBridge {
  const candidate = (window.ade as typeof window.ade & { personalChats?: PersonalChatsBridge }).personalChats;
  if (!candidate) throw new Error("Personal chats are not available in this ADE runtime.");
  return candidate;
}

function resultOf<T>(response: PersonalChatCallResponse | T): T {
  if (response && typeof response === "object" && "result" in response) {
    return (response as PersonalChatCallResponse).result as T;
  }
  return response as T;
}

export async function callPersonal<T>(action: PersonalChatAction, args?: Record<string, unknown>): Promise<T> {
  const request = (args === undefined ? { action } : { action, args }) as Parameters<PersonalChatsBridge["call"]>[0];
  return resultOf<T>(await personalChatsBridge().call(request));
}

/** Machine identity for personal Chats catalog scope and target-scoped reload effects. */
export function resolvePersonalChatsCatalogTargetKey(
  projectBinding: OpenProjectBinding | null | undefined,
  webMachines: WebChatsMachinePicker | null,
): string {
  if (webMachines) {
    const webKey = webMachines.machineId?.trim();
    return webKey ? `web:${webKey}` : "web:pending";
  }
  return projectBinding?.kind === "remote" ? projectBinding.key : "local-machine";
}

export type PersonalChatPaneScope = {
  /** The one routing decision for a pane: every chat call goes to this machine's personal scope. */
  chatScope: ChatPaneScope;
  catalog: AgentChatModelCatalog | null;
  /** The personal catalog's models, registered under its scope key for the pane's model picker. */
  availableModelIds: string[];
  /** The catalog loaded and has no model: no connected provider. Never true while it is loading. */
  providerUnavailable: boolean;
};

/**
 * What an `AgentChatPane` needs to run a chat with no project: the personal
 * API scope and the personal model catalog, both for the machine `targetKey`
 * names. Shared by the Chats page and the Browser tab's docked chat, so the two
 * surfaces route and pick models the same way.
 *
 * The scope is rebuilt per machine so a switched window never keeps polling the
 * previous machine's stream; the catalog resets and reloads with it.
 */
export function usePersonalChatPaneScope(
  targetKey: string,
  options: { enabled?: boolean; onError?: (message: string) => void } = {},
): PersonalChatPaneScope {
  const enabled = options.enabled ?? true;
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;
  const personalCatalogScopeKey = personalChatCatalogScopeKey(targetKey);
  const personalCatalogScopeKeyRef = useRef(personalCatalogScopeKey);
  personalCatalogScopeKeyRef.current = personalCatalogScopeKey;
  const [catalog, setCatalog] = useState<AgentChatModelCatalog | null>(null);
  const generationRef = useRef(0);
  const requestSeqRef = useRef(0);

  const chatScope = useMemo<ChatPaneScope>(() => ({
    kind: "personal",
    agentChat: createPersonalAgentChatApi({
      call: (request) => personalChatsBridge().call(request),
      streamEvents: (request) => personalChatsBridge().streamEvents(request),
    }),
    modelCatalogScopeKey: personalCatalogScopeKey,
  }), [personalCatalogScopeKey]);

  const loadModelCatalog = useCallback(async (generation: number) => {
    const requestId = ++requestSeqRef.current;
    const scopeKey = personalCatalogScopeKeyRef.current;
    const current = () => (
      generation === generationRef.current
      && requestId === requestSeqRef.current
      && scopeKey === personalCatalogScopeKeyRef.current
    );
    let next = await callPersonal<AgentChatModelCatalog>("modelCatalog", { mode: "refresh-stale" });
    if (!current()) return;
    setCatalog(next);
    if (next.stale === true || !agentChatModelCatalogHasAvailableModels(next)) {
      next = await callPersonal<AgentChatModelCatalog>("modelCatalog", { mode: "force" });
      if (current()) setCatalog(next);
    }
  }, []);

  useEffect(() => {
    const generation = ++generationRef.current;
    requestSeqRef.current += 1;
    setCatalog(null);
    if (!enabled) return;
    void loadModelCatalog(generation).catch((reason) => {
      if (generation !== generationRef.current) return;
      onErrorRef.current?.(reason instanceof Error ? reason.message : String(reason));
    });
  }, [enabled, loadModelCatalog, targetKey]);

  const availableModelIds = useMemo(
    () => (catalog ? descriptorsFromAgentChatModelCatalog(catalog, undefined, personalCatalogScopeKey).availableModelIds : []),
    [catalog, personalCatalogScopeKey],
  );

  return {
    chatScope,
    catalog,
    availableModelIds,
    providerUnavailable: catalog !== null && availableModelIds.length === 0,
  };
}

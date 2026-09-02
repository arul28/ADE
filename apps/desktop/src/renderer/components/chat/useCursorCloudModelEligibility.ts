import { useEffect, useMemo } from "react";
import {
  descriptorsFromAgentChatModelCatalog,
  resolveModelDescriptorWithRuntimeCatalog,
} from "../shared/ModelPicker/modelCatalog";
import { getSharedRuntimeCatalog } from "../shared/ModelPicker/runtimeCatalogCache";

/**
 * The dynamic model ids the runtime catalog reports for one machine scope
 * (Ollama, LM Studio, OpenCode, Cursor).
 *
 * Always read the composer's OWN machine scope. Reading the bound machine's
 * catalog offers models the target machine cannot run.
 */
export function runtimeCatalogModelIds(scopeKey: string): string[] {
  const catalog = getSharedRuntimeCatalog(scopeKey);
  if (!catalog) return [];
  return descriptorsFromAgentChatModelCatalog(catalog, undefined, scopeKey).availableModelIds;
}

/**
 * The models Cursor Cloud is allowed to run, taken from `candidateIds` in order
 * and de-duplicated.
 *
 * Cursor's own SDK catalog is the authority on which models the cloud accepts,
 * and that catalog arrives asynchronously. Exclude only the models Cursor has
 * told us are CLI-only. A Cursor model whose availability is still unknown stays
 * eligible, so a cold start does not empty the cloud picker and block every
 * cloud send. The main process still fails closed: `createCursorCloudRun` throws
 * when it cannot resolve the model in the verified SDK catalog, so an unknown
 * model that turns out to be CLI-only is rejected there with a real error
 * instead of being silently swapped here.
 */
export function cursorCloudEligibleModelIds(
  candidateIds: Iterable<string>,
  scopeKey: string,
): string[] {
  const seen = new Set<string>();
  const eligible: string[] = [];
  for (const id of candidateIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!id.startsWith("cursor/")) continue;
    const descriptor = resolveModelDescriptorWithRuntimeCatalog(id, scopeKey);
    if (descriptor?.family !== "cursor") continue;
    if (descriptor.cursorAvailability?.sdk === false) continue;
    eligible.push(id);
  }
  return eligible;
}

type UseCursorCloudModelEligibilityInput = {
  availableModelIds: string[];
  /**
   * A caller-imposed model constraint. It REPLACES `availableModelIds` rather
   * than adding to it, the same way `effectiveAvailableModelIds` reads it.
   */
  availableModelIdsOverride?: string[] | null;
  modelCatalogScopeKey: string;
  modelId: string;
  /** Bumped when the shared runtime catalog changes; the memo reads that cache imperatively. */
  runtimeCatalogVersion: number;
  cursorCloudMode: boolean;
  /**
   * Applies the auto-switch to a cloud-capable model. The pane owns every
   * draft-state write, including the launch-config ownership marker, so this
   * hook never touches draft state itself.
   */
  onSwitchModel: (modelId: string) => void;
};

/**
 * Owns one rule: which Cursor models this draft may send to Cursor Cloud, and
 * whether the draft's current model is one of them.
 *
 * `cursorCloudModelReady` is deliberately separate from "cloud mode is live".
 * Folding the model check into the launchable check would make the pane's
 * cloud-mode-drop effect turn cloud mode off before the auto-switch below could
 * correct the model.
 */
export function useCursorCloudModelEligibility({
  availableModelIds,
  availableModelIdsOverride,
  modelCatalogScopeKey,
  modelId,
  runtimeCatalogVersion,
  cursorCloudMode,
  onSwitchModel,
}: UseCursorCloudModelEligibilityInput): {
  cursorCloudModelIds: string[];
  cursorCloudModelReady: boolean;
} {
  const cursorCloudModelIds = useMemo(
    () => {
      const candidateIds: string[] = [...(availableModelIdsOverride ?? availableModelIds)];
      // Keep the draft's own model in the running. Dropping it would make the auto-switch effect
      // below reassign a model the user picked, purely because a catalog has not loaded yet.
      if (modelId.startsWith("cursor/")) candidateIds.push(modelId);
      candidateIds.push(...runtimeCatalogModelIds(modelCatalogScopeKey));
      return cursorCloudEligibleModelIds(candidateIds, modelCatalogScopeKey);
    },
    [availableModelIds, availableModelIdsOverride, modelCatalogScopeKey, modelId, runtimeCatalogVersion],
  );

  useEffect(() => {
    if (!cursorCloudMode || !cursorCloudModelIds.length || cursorCloudModelIds.includes(modelId)) return;
    // A CLI-only Cursor draft can enter cloud mode with its current model still
    // selected for one render. Move it to the first SDK-capable model before the
    // send control becomes usable; a cloud request must never fall back to
    // Cursor's implicit/default model. Only a model Cursor reports as CLI-only
    // reaches this line: `cursorCloudModelIds` keeps a model of unknown
    // availability, so an unloaded catalog never reassigns the user's choice.
    onSwitchModel(cursorCloudModelIds[0]!);
  }, [cursorCloudMode, cursorCloudModelIds, modelId, onSwitchModel]);

  // True when the draft's model does not block a cloud send. Read only while
  // cloud mode is active, so an ineligible model outside cloud mode is not a
  // blocked state.
  const cursorCloudModelReady = !cursorCloudMode || cursorCloudModelIds.includes(modelId);

  return { cursorCloudModelIds, cursorCloudModelReady };
}

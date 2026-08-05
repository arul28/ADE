import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getModelById, modelSupportsFastMode, selectSupportedReasoningEffort } from "../../../shared/modelRegistry";
import { deriveConfiguredModelIds } from "../../lib/modelOptions";
import { settingsRouteFor } from "../settings/settingsManifest";

export type CtoModelSelection = {
  provider: string;
  model: string;
  modelId: string;
  reasoningEffort: string | null;
  supportsFastMode: boolean;
};

/** Reasoning tier the model supports closest to the caller's preference. */
export function pickReasoningEffort(
  modelId: string | null | undefined,
  preferred: string | null | undefined,
): string | null {
  const descriptor = modelId ? getModelById(modelId) : undefined;
  const tiers = descriptor?.reasoningTiers ?? [];
  return selectSupportedReasoningEffort({
    tiers,
    preferred,
    advertisedDefault: descriptor?.defaultReasoningEffort,
  });
}

/** Resolve a full model selection (provider/model/reasoning) from a model id. */
export function resolveModelSelection(
  modelId: string,
  preferredReasoning: string | null | undefined,
): CtoModelSelection | null {
  const descriptor = getModelById(modelId);
  if (!descriptor) return null;
  return {
    provider: descriptor.family,
    model: descriptor.shortId ?? descriptor.id.split("/").pop() ?? descriptor.id,
    modelId: descriptor.id,
    reasoningEffort: pickReasoningEffort(descriptor.id, preferredReasoning),
    supportsFastMode: modelSupportsFastMode(descriptor),
  };
}

/**
 * Loads the models the user has configured (API keys / signed-in CLIs) so the
 * CTO Settings draws from the same configured catalog as the chat composer.
 * Also exposes a jump to provider settings for the empty-catalog case.
 */
export function useCtoModelOptions(): {
  availableModelIds: string[];
  loadingModels: boolean;
  openProviderSettings: () => void;
} {
  const navigate = useNavigate();
  const [availableModelIds, setAvailableModelIds] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await window.ade.ai.getStatus();
        if (cancelled) return;
        setAvailableModelIds(deriveConfiguredModelIds(status));
      } catch {
        if (!cancelled) setAvailableModelIds([]);
      } finally {
        if (!cancelled) setLoadingModels(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openProviderSettings = useCallback(() => {
    navigate(settingsRouteFor("agents.providers"));
  }, [navigate]);

  return { availableModelIds, loadingModels, openProviderSettings };
}

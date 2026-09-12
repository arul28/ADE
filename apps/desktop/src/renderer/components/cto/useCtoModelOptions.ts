import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  getModelById,
  modelSupportsFastMode,
  resolveChatProviderForDescriptor,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { providerSupportsLiveRedirect } from "../../../shared/types/chat";
import { deriveConfiguredModelIds } from "../../lib/modelOptions";
import { settingsRouteFor } from "../settings/settingsManifest";

/**
 * The CTO may only run on a model whose provider can redirect a turn that is
 * already running — child reports, wakes and peer notes arrive constantly and
 * must not wait for a turn boundary.
 *
 * Resolved through the provider the model would actually launch on, never its
 * registry family: an OpenAI model that is not CLI-wrapped runs under OpenCode,
 * which stages everything.
 */
export function ctoModelSupportsLiveRedirect(descriptor: ModelDescriptor): boolean {
  return providerSupportsLiveRedirect(resolveChatProviderForDescriptor(descriptor).provider);
}

export type CtoModelSelection = {
  provider: string;
  model: string;
  modelId: string;
  reasoningEffort: string | null;
  supportsFastMode: boolean;
};

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
    // A model choice must not rewrite the selected thinking level. Runtime
    // capability handling belongs to launch; the raw preference stays visible.
    reasoningEffort: preferredReasoning ?? null,
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
        // Narrowed here as well as in the picker's filter, so the panel's
        // "no models configured" state counts only models the CTO can use.
        setAvailableModelIds(deriveConfiguredModelIds(status).filter((modelId) => {
          const descriptor = getModelById(modelId);
          return descriptor ? ctoModelSupportsLiveRedirect(descriptor) : false;
        }));
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

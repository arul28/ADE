import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  getModelById,
  modelSupportsFastMode,
  resolveChatProviderForDescriptor,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { providerSupportsLiveRedirect } from "../../../shared/types/chat";
import type { CtoModelPreferences, OpenProjectBinding } from "../../../shared/types";
import { deriveConfiguredModelIds } from "../../lib/modelOptions";
import { settingsRouteFor } from "../settings/settingsManifest";

/**
 * The providers the CTO can run on, in the words every CTO surface uses.
 * They are the ones whose chats take a new message in the middle of a turn
 * (`CTO_LIVE_REDIRECT_PROVIDERS`).
 */
export const CTO_ELIGIBLE_PROVIDERS_COPY = "Claude, Codex, Cursor, OpenCode or Copilot";

/** Most backup models the CTO keeps. */
export const CTO_MAX_FALLBACK_MODELS = 3;

/**
 * The CTO only runs on a model whose chat can take a new message mid-turn
 * (Claude, Codex, Cursor, OpenCode or Copilot): child reports,
 * wakes and the person's follow-ups arrive constantly and must not wait for
 * a turn to end.
 *
 * Resolved through the provider the model would actually launch on, never its
 * registry family: an OpenAI model that is not CLI-wrapped runs under
 * OpenCode, and that is the provider that has to qualify.
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

/** The stored form of a model choice (`CtoIdentity.modelPreferences` / `fallbackModels`). */
export function toCtoModelPreferences(
  modelId: string,
  reasoningEffort: string | null = null,
): CtoModelPreferences | null {
  const selection = resolveModelSelection(modelId, reasoningEffort);
  if (!selection) return null;
  return {
    provider: selection.provider,
    model: selection.model,
    modelId: selection.modelId,
    reasoningEffort: selection.reasoningEffort,
  };
}

/**
 * Loads the models the user has set up (API keys, signed-in CLIs) on the
 * CTO's home machine, narrowed to the ones the CTO can run on, so the CTO's
 * pickers draw from the same catalog as the chat composer. Also exposes a
 * jump to provider settings for the empty case.
 */
export function useCtoModelOptions(pin: OpenProjectBinding | null = null): {
  availableModelIds: string[];
  loadingModels: boolean;
  openProviderSettings: () => void;
} {
  const navigate = useNavigate();
  const [availableModelIds, setAvailableModelIds] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!pin) {
      // No home machine to ask yet.
      setAvailableModelIds([]);
      setLoadingModels(false);
      return () => { cancelled = true; };
    }
    void (async () => {
      try {
        // The CTO runs on its home machine, so its models are that machine's.
        const status = await window.ade.ai.getStatus(undefined, pin);
        if (cancelled) return;
        // Narrowed here as well as in the picker's filter, so "no models set
        // up" counts only models the CTO can use.
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
    // Keyed on the pin's key, not the object (CLAUDE.md, remote machines item 3).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin?.key]);

  const openProviderSettings = useCallback(() => {
    navigate(settingsRouteFor("agents.providers"));
  }, [navigate]);

  return { availableModelIds, loadingModels, openProviderSettings };
}

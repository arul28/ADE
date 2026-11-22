import React from "react";
import type { CtoAvatarLook } from "../../../shared/types";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { TechnicalDetailsFold } from "../app/errorSurfaceKit";
import { CtoAvatar } from "./avatar/CtoAvatar";
import { CTO_ELIGIBLE_PROVIDERS_COPY, ctoModelSupportsLiveRedirect } from "./useCtoModelOptions";

/**
 * The CTO's welcome: it is asleep until it has a model. Picking one wakes it
 * (a happy hop) before the thread takes the page. There is no setup wizard and
 * no pitch: the sleeping avatar, its name, one status word and the picker.
 */
export function CtoWelcome({
  look,
  name,
  availableModelIds,
  loadingModels,
  switchingModel,
  waking,
  error,
  onPick,
  onOpenProviderSettings,
}: {
  look: CtoAvatarLook;
  name: string;
  availableModelIds: string[];
  loadingModels: boolean;
  switchingModel: boolean;
  /** A model was just picked: the avatar wakes before the thread appears. */
  waking: boolean;
  error: string | null;
  onPick: (modelId: string) => void;
  onOpenProviderSettings: () => void;
}) {
  const avatarState = waking ? "happy" : switchingModel ? "thinking" : "asleep";
  const noModels = !loadingModels && availableModelIds.length === 0;
  const status = waking
    ? "Morning! Let's go."
    : switchingModel
      ? "Waking up…"
      : loadingModels
        ? "Checking sign-ins…"
        : noModels
          ? "No models signed in"
          : "Asleep";
  return (
    <div className="ade-cto-welcome" data-testid="cto-model-pick" data-waking={waking ? "true" : undefined}>
      <div className="ade-cto-welcome-inner">
        <div className="ade-cto-welcome-avatar">
          <div className="ade-cto-profile-halo" aria-hidden />
          <CtoAvatar look={look} state={avatarState} size={120} motion="live" title={`${name}, ${status}`} />
        </div>
        <h1 className="ade-cto-welcome-title">{name}</h1>
        <p
          key={waking ? "wake" : "sleep"}
          className={`ade-cto-status-word${waking ? " ade-cto-welcome-wake" : ""}`}
          data-tone={noModels && !waking ? "warn" : undefined}
          role="status"
        >
          <span>{status}</span>
        </p>

        {noModels && !waking ? (
          <button
            type="button"
            className="kit-btn kit-btn-primary"
            title={`${name} runs on ${CTO_ELIGIBLE_PROVIDERS_COPY}`}
            onClick={onOpenProviderSettings}
          >
            Sign in
          </button>
        ) : (
          // Only models that take a message mid-turn are listed; the tooltip
          // says which, for the person whose favourite is missing. While it
          // wakes the slot stays (hidden) so the hop doesn't shift the page.
          <div
            className="ade-cto-welcome-picker"
            title={`${name} runs on ${CTO_ELIGIBLE_PROVIDERS_COPY}`}
            aria-hidden={waking || undefined}
            style={waking ? { visibility: "hidden" } : undefined}
          >
            <ModelPicker
              value=""
              emptyLabel="Pick a model to wake"
              availableModelIds={availableModelIds}
              filter={ctoModelSupportsLiveRedirect}
              disabled={switchingModel || loadingModels || waking}
              onChange={onPick}
              onOpenSignIn={onOpenProviderSettings}
            />
          </div>
        )}

        {error ? <TechnicalDetailsFold text={error} className="mt-4 w-full text-left" /> : null}
      </div>
    </div>
  );
}

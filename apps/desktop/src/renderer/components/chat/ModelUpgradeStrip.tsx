import { memo } from "react";
import { X } from "@phosphor-icons/react";
import { ModelRowLogo } from "../shared/ProviderLogos";
import { resolveModelDescriptorWithRuntimeCatalog } from "../shared/ModelPicker/modelCatalog";
import { shortName } from "./modelHint";
import { ComposerStrip } from "./ProviderSignInSlot";
import type { ModelUpgradeSuggestion } from "./useModelUpgradeSuggestion";

/**
 * "A newer version is out: Fable 5.2." above the prompt box (ADE-300): the
 * sign-in strip's frame (`ComposerStrip`) in the newer model's tint, with
 * Switch and ×.
 */
export const ModelUpgradeStrip = memo(function ModelUpgradeStrip({
  upgrade,
  catalogScopeKey,
}: {
  upgrade: ModelUpgradeSuggestion;
  catalogScopeKey: string;
}) {
  const next = resolveModelDescriptorWithRuntimeCatalog(upgrade.toModelId, catalogScopeKey);
  const current = resolveModelDescriptorWithRuntimeCatalog(upgrade.fromModelId, catalogScopeKey);
  const nextName = shortName(next?.displayName ?? upgrade.toModelId);
  const currentName = shortName(current?.displayName ?? upgrade.fromModelId);
  return (
    <ComposerStrip
      accent={next?.color ?? "var(--color-accent)"}
      logo={(
        <ModelRowLogo
          modelFamily={next?.family ?? "anthropic"}
          cliCommand={next?.cliCommand}
          modelId={upgrade.toModelId}
          providerModelId={next?.providerModelId}
          {...(next?.openCodeProviderId ? { openCodeProviderId: next.openCodeProviderId } : {})}
          size={13}
        />
      )}
      long={{ lead: "A newer version is out: ", strong: nextName, end: "." }}
      short={`${nextName} is out`}
      title={`${nextName} is the newer version of ${currentName}.`}
      testId="model-upgrade-strip"
    >
      <button
        type="button"
        className="kit-btn ade-psi-button"
        data-size="sm"
        data-testid="model-upgrade-switch"
        aria-label={`Switch to ${nextName}`}
        onClick={upgrade.switchTo}
      >
        Switch
      </button>
      <button
        type="button"
        className="ade-psi-dismiss"
        data-testid="model-upgrade-dismiss"
        aria-label={`Keep ${currentName}`}
        title={`Keep ${currentName}`}
        onClick={upgrade.dismiss}
      >
        <X size={11} weight="bold" aria-hidden />
      </button>
    </ComposerStrip>
  );
});

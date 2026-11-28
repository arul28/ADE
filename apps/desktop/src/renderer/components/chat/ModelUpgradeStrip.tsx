import { Children, memo, type CSSProperties, type ReactNode } from "react";
import { X } from "@phosphor-icons/react";
import { getModelById } from "../../../shared/modelRegistry";
import { ModelRowLogo } from "../shared/ProviderLogos";
import { resolveModelDescriptorWithRuntimeCatalog } from "../shared/ModelPicker/modelCatalog";
import { shortName } from "./modelHint";
import type { ModelUpgradeSuggestion } from "./useModelUpgradeSuggestion";
import "./providerSignInSlot.css";

/**
 * "A newer version is out: Fable 5.2." above the prompt box (ADE-300). The
 * same strip as "Claude Code isn't signed in" (`ProviderSignInStrip`), in the
 * newer model's tint, with Switch and ×.
 */
export const ModelUpgradeStrip = memo(function ModelUpgradeStrip({
  upgrade,
  catalogScopeKey,
}: {
  upgrade: ModelUpgradeSuggestion;
  catalogScopeKey: string;
}) {
  const next = resolveModelDescriptorWithRuntimeCatalog(upgrade.toModelId, catalogScopeKey) ?? getModelById(upgrade.toModelId);
  const current = resolveModelDescriptorWithRuntimeCatalog(upgrade.fromModelId, catalogScopeKey) ?? getModelById(upgrade.fromModelId);
  const nextName = shortName(next?.displayName ?? upgrade.toModelId);
  const currentName = shortName(current?.displayName ?? upgrade.fromModelId);
  return (
    <div
      className="ade-psi-strip"
      data-testid="model-upgrade-strip"
      title={`${nextName} is the newer version of ${currentName}.`}
      style={{ "--psi-accent": next?.color ?? "var(--color-accent)" } as CSSProperties}
    >
      <span className="ade-psi-logo" aria-hidden>
        <ModelRowLogo
          modelFamily={next?.family ?? "anthropic"}
          cliCommand={next?.cliCommand}
          modelId={upgrade.toModelId}
          providerModelId={next?.providerModelId}
          {...(next?.openCodeProviderId ? { openCodeProviderId: next.openCodeProviderId } : {})}
          size={13}
        />
      </span>
      <span className="ade-psi-text ade-psi-long">
        <span className="ade-psi-lead">A newer version is out:&nbsp;</span>
        <span className="ade-psi-machine">{nextName}</span>
        <span className="ade-psi-end">.</span>
      </span>
      <span className="ade-psi-text ade-psi-short">
        <span className="ade-psi-lead">{nextName} is out</span>
      </span>
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
    </div>
  );
});

/**
 * The strips above the prompt box as one tab on it. Two at once (not signed
 * in, and a newer version) stack in one frame, each its own line, rather
 * than two tabs fighting for the box's top edge.
 */
export function ComposerNoticeStack({ children }: { children: ReactNode }) {
  const items = Children.toArray(children);
  if (items.length === 0) return null;
  if (items.length === 1) return <>{items}</>;
  return <div className="ade-psi-stack" data-testid="composer-notice-stack">{items}</div>;
}

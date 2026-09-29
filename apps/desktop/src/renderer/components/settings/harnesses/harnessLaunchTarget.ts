/**
 * What a `presetId` launches: which harness, which model, and what to call it.
 *
 * A `presetId` is either a saved Custom provider's id or an ad-hoc route id
 * (`route.<...>`, see `shared/harnessRoutes.ts`) minted by the picker's Run-in
 * view. Every surface that launches or labels a chat asks this one function,
 * so a route id is never "unknown preset" in one place and a working launch in
 * another.
 */

import {
  presetLabel,
  type HarnessPreset,
  type HarnessPresetBody,
  type HarnessPresetLogo,
  type HarnessPresetSource,
} from "../../../../shared/harnessPresets";
import { decodeRoutePresetId, isRoutePresetId } from "../../../../shared/harnessRoutes";
import { harnessModelLabel } from "./harnessModels";
import { harnessShortLabel, launchModelIdFor } from "./harnessReach";

export type HarnessLaunchTarget = {
  presetId: string;
  harness: HarnessPresetBody;
  source: HarnessPresetSource;
  /** The model as the source spells it (what a preset stores). */
  model: string;
  /** The model id the launch passes. */
  launchModelId: string;
  reasoningEffort?: string;
  /** Trigger copy: the preset's name, or "DeepSeek V4.1 Flash · Claude Code" for a route. */
  name: string;
  logo: HarnessPresetLogo;
  adHoc: boolean;
};

export function resolveHarnessLaunchTarget(
  presetId: string | null | undefined,
  presets: readonly HarnessPreset[],
  catalogScopeKey?: string,
): HarnessLaunchTarget | null {
  const id = presetId?.trim();
  if (!id) return null;
  if (isRoutePresetId(id)) {
    const spec = decodeRoutePresetId(id);
    if (!spec) return null;
    return {
      presetId: id,
      harness: spec.harness,
      source: spec.source,
      model: spec.model,
      launchModelId: launchModelIdFor(spec.harness, spec.source, spec.model),
      ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}),
      name: `${routeModelLabel(spec.source, spec.model, catalogScopeKey)} · ${harnessShortLabel(spec.harness)}`,
      logo: { kind: "provider", providerId: spec.harness },
      adHoc: true,
    };
  }
  const preset = presets.find((entry) => entry.id === id);
  if (!preset) return null;
  return {
    presetId: id,
    harness: preset.harness,
    source: preset.source,
    model: preset.model,
    launchModelId: launchModelIdFor(preset.harness, preset.source, preset.model),
    ...(preset.reasoningEffort ? { reasoningEffort: preset.reasoningEffort } : {}),
    name: presetLabel(preset),
    logo: preset.logo,
    adHoc: false,
  };
}

/**
 * A route's model by its display name. The runtime catalog files OpenCode
 * models under `opencode/<provider>/<model>`, so a raw `deepseek-v4.1-flash`
 * from an OpenCode sign-in is looked up in that spelling first.
 */
function routeModelLabel(source: HarnessPresetSource, model: string, catalogScopeKey?: string): string {
  if (source.kind === "opencode") {
    const viaCatalog = harnessModelLabel(`opencode/${source.providerId}/${encodeURIComponent(model)}`, catalogScopeKey);
    if (!viaCatalog.startsWith("opencode/")) return viaCatalog;
  }
  if (source.kind === "key") {
    const viaCatalog = harnessModelLabel(`opencode/${source.provider}/${encodeURIComponent(model)}`, catalogScopeKey);
    if (!viaCatalog.startsWith("opencode/")) return viaCatalog;
  }
  return harnessModelLabel(model, catalogScopeKey);
}

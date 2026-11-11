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
  DEFAULT_HARNESS_PRESET_ACCENT,
  presetLabel,
  presetSourceLogo,
  type HarnessPreset,
  type HarnessPresetBody,
  type HarnessPresetLogo,
  type HarnessPresetSource,
} from "../../../../shared/harnessPresets";
import { PROVIDER_CHAT_ACCENTS, PROVIDER_GROUP_COLORS } from "../../../../shared/providerColors";
import { catalogModelIdFor, decodeRoutePresetId, isRoutePresetId } from "../../../../shared/harnessRoutes";
import { encodeOpenCodeRegistryId } from "../../../../shared/modelRegistry";
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
  /** The source model's saved thinking levels, when the preset carries them. */
  reasoningTiers?: string[];
  /** Trigger copy: the preset's name, or "DeepSeek V4.1 Flash · Claude Code" for a route. */
  name: string;
  logo: HarnessPresetLogo;
  /**
   * The ring the mark is drawn with, everywhere the mark is drawn.
   *
   * A saved preset's own accent. An ad-hoc route has no preset to carry one, so
   * it wears its harness's brand colour — the same colour the transcript uses
   * for that harness, which is what makes "this is a Claude Code chat" readable
   * at a glance instead of being the mark's own colours on a purple ring.
   */
  accentColor: string;
  adHoc: boolean;
};

/** The accent a harness body wears where no preset supplies one. */
export function harnessAccentColor(harness: HarnessPresetBody | string): string {
  return (PROVIDER_GROUP_COLORS as Record<string, string | undefined>)[harness]
    ?? DEFAULT_HARNESS_PRESET_ACCENT;
}

/** The accent a source wears. Its brand colour where there is one, else the harness's. */
function sourceAccentColor(source: HarnessPresetSource, harness: HarnessPresetBody): string {
  const family = presetSourceLogo(source);
  const branded = (PROVIDER_CHAT_ACCENTS as Record<string, string | undefined>)[family];
  return branded ?? harnessAccentColor(harness);
}

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
      // The SOURCE's mark, not the harness's: an ad-hoc route is a saved
      // provider in everything but name, and the harness is the half the person
      // picked for convenience rather than the half that identifies the model.
      // The harness stays in the name and in the tooltip every row carries.
      logo: { kind: "provider", providerId: presetSourceLogo(spec.source) },
      accentColor: sourceAccentColor(spec.source, spec.harness),
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
    ...(preset.reasoningTiers?.length ? { reasoningTiers: [...preset.reasoningTiers] } : {}),
    name: presetLabel(preset),
    logo: preset.logo,
    accentColor: preset.accentColor,
    adHoc: false,
  };
}

/**
 * The model whose descriptor describes this launch's thinking levels.
 *
 * The harness and the source are independent: a Custom provider can run
 * DeepSeek inside Claude Code. Its `modelId` is often the harness's own id (or
 * none), so resolving the composer's effort picker from it shows the harness's
 * ladder (`low`…`ultracode`) instead of the source model's declared tiers.
 * OpenCode files its models under `opencode/<provider>/<model>`, which is the
 * id the runtime catalog uses; every other source keeps the launch's own id.
 */
export function reasoningModelIdForLaunchTarget(
  target: Pick<HarnessLaunchTarget, "source" | "model">,
): string {
  return catalogModelIdFor(target.source, target.model);
}

/** The vendor whose own models a harness runs when nothing routes it elsewhere. */
const HARNESS_HOME_VENDOR: Partial<Record<HarnessPresetBody, string>> = {
  claude: "anthropic",
  codex: "openai",
};

/**
 * An ad-hoc route that only bills the harness's own vendor differently: an
 * OpenAI key in Codex, an Anthropic key (or another Claude account) in Claude
 * Code. The model is the harness's own, so the chat is an ordinary Codex or
 * Claude chat and wears that harness's mark; the source's mark is for a route
 * that runs another vendor's model in the harness. A saved Custom provider
 * keeps the logo its owner gave it.
 */
export function isHomeVendorRoute(target: Pick<HarnessLaunchTarget, "adHoc" | "harness" | "source">): boolean {
  if (!target.adHoc) return false;
  const home = HARNESS_HOME_VENDOR[target.harness];
  if (!home) return false;
  const source = target.source;
  if (source.kind === "account" || source.kind === "subscription") {
    return source.provider === target.harness;
  }
  const provider = (source.kind === "key" ? source.provider : source.providerId).trim().toLowerCase();
  return provider === home;
}

/**
 * A route's model by its display name. The runtime catalog files OpenCode
 * models under `opencode/<provider>/<model>`, so a raw `deepseek-v4.1-flash`
 * from an OpenCode sign-in is looked up in that spelling first.
 */
function routeModelLabel(source: HarnessPresetSource, model: string, catalogScopeKey?: string): string {
  if (source.kind === "opencode") {
    const viaCatalog = harnessModelLabel(launchModelIdFor("opencode", source, model), catalogScopeKey);
    if (!viaCatalog.startsWith("opencode/")) return viaCatalog;
  }
  if (source.kind === "key") {
    const viaCatalog = harnessModelLabel(encodeOpenCodeRegistryId(source.provider, model), catalogScopeKey);
    if (!viaCatalog.startsWith("opencode/")) return viaCatalog;
  }
  return harnessModelLabel(model, catalogScopeKey);
}

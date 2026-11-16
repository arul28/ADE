/**
 * A Custom provider, named by an agent. Settings › Providers › Custom providers
 * saves a harness, where it runs and one model under a name; the CLI and the
 * MCP tools take that name (or its id) with `--custom-provider`, and the model
 * is still passed with it like on every other launch, so the caller always
 * states the model the agent will run.
 *
 * Stored as `HarnessPreset` rows in the account settings cache, which is why
 * the launch fields still say `presetId`. No agent-facing text does.
 */
import type { HarnessPreset } from "./harnessPresets";
import { harnessBodyLabel, presetLabel, presetSourceSummary } from "./harnessPresets";
import { catalogModelIdFor, decodeRoutePresetId, isRoutePresetId, launchModelIdFor } from "./harnessRoutes";
import { getModelById, resolveModelAlias } from "./modelRegistry";
import type { LaunchModelSpelling } from "./launchModelRule";

const LIST_COMMAND = "`ade harness providers --text`";
const LIST_HINT = `${LIST_COMMAND} lists them.`;

/** Old scripts and skills passed `--preset <id>`; the word and the flag are gone. */
export const PRESET_FLAG_GONE_MESSAGE =
  "--preset is gone. Name a Custom provider with --custom-provider \"<name>\" and pass its model with --model <id>; "
  + LIST_HINT;

/** What a launch needs from a Custom provider (or a `--via` route id). */
export type CustomProviderTarget = Pick<HarnessPreset, "id" | "name" | "harness" | "source" | "model">;

export type CustomProviderLookup =
  | { ok: true; preset: CustomProviderTarget }
  | { ok: false; message: string };

/**
 * Find a Custom provider by id, or by its name (ignoring case). A route id
 * (`ade harness route-id` prints one) names its setup in itself and is
 * decoded, not looked up.
 */
export function findCustomProvider(presets: readonly HarnessPreset[] | null, ref: string): CustomProviderLookup {
  const wanted = ref.trim();
  if (!wanted) return { ok: false, message: `--custom-provider needs a name. ${LIST_HINT}` };
  if (isRoutePresetId(wanted)) {
    const route = decodeRoutePresetId(wanted);
    return route
      ? { ok: true, preset: { id: wanted, name: `The ${presetSourceSummary(route.source).title} route`, harness: route.harness, source: route.source, model: route.model } }
      : { ok: false, message: `"${wanted}" is not a route id ADE can read. Build one again with \`ade harness route-id\`.` };
  }
  if (!presets?.length) {
    return {
      ok: false,
      message: `This machine has no Custom providers saved (Settings › Providers › Custom providers). ${LIST_HINT}`,
    };
  }
  const byId = presets.find((preset) => preset.id === wanted);
  if (byId) return { ok: true, preset: byId };
  const folded = wanted.toLowerCase();
  const byName = presets.filter((preset) => presetLabel(preset).trim().toLowerCase() === folded);
  if (byName.length === 1) return { ok: true, preset: byName[0]! };
  if (byName.length > 1) {
    return {
      ok: false,
      message: `${byName.length} Custom providers are named "${wanted}". Pass one by id: ${byName.map((preset) => preset.id).join(", ")}.`,
    };
  }
  return { ok: false, message: `No Custom provider "${wanted}" on this machine. ${LIST_HINT}` };
}

/** A saved Custom provider by its quoted name; a route by what it routes through. */
function providerName(preset: CustomProviderTarget): string {
  return isRoutePresetId(preset.id) ? preset.name : `"${presetLabel(preset)}"`;
}

/**
 * True when `given` names the model a Custom provider runs: its saved id, the
 * id its harness launches (`opencode/<provider>/<model>`), a shorter tail of
 * that launch id, or a short alias of the same registry model. A different
 * prefix (`other/<model>`) is a different model.
 */
function namesProviderModel(given: string, expected: string, launchIds: readonly string[], viaOpenCode: boolean): boolean {
  const wanted = given.trim().toLowerCase();
  if (!wanted) return false;
  const ids = [expected, ...launchIds].map((id) => id.trim().toLowerCase()).filter(Boolean);
  if (ids.some((id) => id === wanted || id.endsWith(`/${wanted}`))) return true;
  // The same registry model by alias: `opus` saved, its full id passed, or the
  // other way round. Through OpenCode a prefixed id names one provider, and the
  // launch id above already spells it, so a bare alias there could stand for
  // another provider's row: no alias match.
  if (viaOpenCode && wanted.includes("/")) return false;
  const resolved = (getModelById(wanted) ?? resolveModelAlias(wanted))?.id;
  return Boolean(resolved && ids.some((id) => getModelById(id)?.id === resolved || resolveModelAlias(id)?.id === resolved));
}

/**
 * Null when the model the caller passed is the one this Custom provider runs;
 * otherwise the sentence that names the right one. A Custom provider runs one
 * model, so a different one is a mistake, not a choice.
 */
export function customProviderModelProblem(
  preset: CustomProviderTarget,
  model: string | null | undefined,
  spelling: LaunchModelSpelling = "--model",
): string | null {
  const name = providerName(preset);
  const expected = preset.model.trim();
  const pass = (value: string) => (spelling === "--model" ? `Pass --model ${value}` : `Send ${spelling}: "${value}"`);
  if (!expected) return null;
  const given = model?.trim() ?? "";
  if (!given) return `${name} runs ${expected}. ${pass(expected)} with it.`;
  const launchId = launchModelIdFor(preset.harness, preset.source, expected);
  // Through OpenCode, the source's own catalog id (`opencode/<provider>/<model>`,
  // a `/` in the model encoded, as `ade chat models` lists it) names the same
  // model in any harness.
  const sourceId = preset.source.kind === "opencode" ? catalogModelIdFor(preset.source, expected) : "";
  if (namesProviderModel(given, expected, [launchId, sourceId], preset.source.kind === "opencode")) return null;
  // A route id names its setup in itself: there is nothing else to pick from.
  if (isRoutePresetId(preset.id)) return `${name} runs ${expected}, not ${given}. ${pass(expected)}.`;
  return `${name} runs ${expected}, not ${given}. ${pass(expected)}, or pick another Custom provider (${LIST_COMMAND} lists them).`;
}

/** Null when the harness the caller named (if any) is this Custom provider's. */
export function customProviderHarnessProblem(preset: CustomProviderTarget, provider: string | null | undefined): string | null {
  const given = provider?.trim();
  if (!given || given.toLowerCase() === preset.harness) return null;
  return `${providerName(preset)} runs in ${harnessBodyLabel(preset.harness)} (--provider ${preset.harness}), not ${given}. Leave out --provider or pass --provider ${preset.harness}.`;
}

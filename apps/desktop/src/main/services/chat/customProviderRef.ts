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
import type { HarnessPreset } from "../../../shared/harnessPresets";
import { harnessBodyLabel, presetLabel } from "../../../shared/harnessPresets";
import { launchModelIdFor } from "../../../shared/harnessRoutes";
import type { LaunchModelSpelling } from "../../../shared/launchModelRule";

const LIST_HINT = "`ade harness providers --text` lists them.";

/** Old scripts and skills passed `--preset <id>`; the word and the flag are gone. */
export const PRESET_FLAG_GONE_MESSAGE =
  "--preset is gone. Name a Custom provider with --custom-provider \"<name>\" and pass its model with --model <id>; "
  + LIST_HINT;

export type CustomProviderLookup =
  | { ok: true; preset: HarnessPreset }
  | { ok: false; message: string };

/** Find a Custom provider by id, or by its name (ignoring case). */
export function findCustomProvider(presets: readonly HarnessPreset[] | null, ref: string): CustomProviderLookup {
  const wanted = ref.trim();
  if (!wanted) return { ok: false, message: `--custom-provider needs a name. ${LIST_HINT}` };
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

function sameModel(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (!left || !right) return false;
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

/**
 * Null when the model the caller passed is the one this Custom provider runs;
 * otherwise the sentence that names the right one. A Custom provider runs one
 * model, so a different one is a mistake, not a choice.
 */
export function customProviderModelProblem(
  preset: HarnessPreset,
  model: string | null | undefined,
  spelling: LaunchModelSpelling = "flag",
): string | null {
  const name = presetLabel(preset);
  const expected = preset.model.trim();
  const pass = (value: string) => (spelling === "flag" ? `Pass --model ${value}` : `Send model: "${value}"`);
  if (!expected) return null;
  const given = model?.trim() ?? "";
  if (!given) return `"${name}" runs ${expected}. ${pass(expected)} with it.`;
  const launchId = launchModelIdFor(preset.harness, preset.source, expected);
  if (sameModel(given, expected) || sameModel(given, launchId)) return null;
  return `"${name}" runs ${expected}, not ${given}. ${pass(expected)}, or pick another Custom provider (${LIST_HINT.replace(/\.$/, "")}).`;
}

/** Null when the harness the caller named (if any) is this Custom provider's. */
export function customProviderHarnessProblem(preset: HarnessPreset, provider: string | null | undefined): string | null {
  const given = provider?.trim();
  if (!given || given === preset.harness) return null;
  return `"${presetLabel(preset)}" runs in ${harnessBodyLabel(preset.harness)} (--provider ${preset.harness}), not ${given}. Drop --provider or pass --provider ${preset.harness}.`;
}

/**
 * The subagent half of a harness preset.
 *
 * A preset's subagent settings are the part of a launch that is *not* one
 * environment or one config file: Claude Code takes them as SDK `agents`
 * entries, the rest take them in a config ADE writes, and each harness names
 * its roles its own way. Keeping that translation beside the resolver is what
 * pushed `harnessPresetLaunch.ts` past a thousand lines, so it lives here — one
 * module that answers three questions and nothing else:
 *
 * - what a preset's `subagentModel` / `subagentEffort` / role pins mean;
 * - what Claude Code's SDK entries and environment become;
 * - what a config-file harness should be handed to write.
 *
 * `HARNESS_SUBAGENT_SUPPORT` (`shared/harnessPresets.ts`) is the table that says
 * which harness has which knob, with the source each entry was read from;
 * `shared/harnessSubagentLaunch.ts` is what a config writer does with it. This
 * module is only the resolver's half: preset in, launch out.
 */

import {
  HARNESS_PRESET_AGENT_FOLLOWS,
  HARNESS_PRESET_AGENT_KEYS,
  HARNESS_PRESET_BODIES,
  HARNESS_PRESET_SUBAGENT_INHERIT,
  HARNESS_SUBAGENT_SUPPORT,
  harnessSubagentSupport,
  type HarnessPreset,
  type HarnessPresetAgentKey,
  type HarnessPresetBody,
} from "../../../shared/harnessPresets";
import {
  buildClaudeBuiltinAgentOverrides,
  type ClaudeBuiltinAgentOverride,
} from "../../../shared/claudeBuiltinAgentPrompts";
import {
  hasSubagentLaunch,
  subagentTypeName,
  type HarnessSubagentLaunch,
  type HarnessSubagentPin,
} from "../../../shared/harnessSubagentLaunch";

/** The preset's subagent model, or undefined when it says "same as main". */
export function resolveSubagentModel(preset: HarnessPreset): string | undefined {
  const value = preset.subagentModel?.trim();
  if (!value || value === HARNESS_PRESET_SUBAGENT_INHERIT) return undefined;
  return value;
}

/**
 * Per-built-in model pins, with `follows` already resolved.
 *
 * `follows` means "take the subagent model", and the subagent model may itself
 * be `inherit` — in which case the pin resolves to the preset's own model. A
 * pin is only dropped when it names nothing at all.
 */
export function resolveAgentPins(preset: HarnessPreset): Partial<Record<HarnessPresetAgentKey, string>> {
  const subagent = resolveSubagentModel(preset) ?? preset.model?.trim();
  const pins: Partial<Record<HarnessPresetAgentKey, string>> = {};
  for (const key of HARNESS_PRESET_AGENT_KEYS) {
    const raw = preset.agentOverrides?.[key]?.trim();
    if (!raw) continue;
    const resolved = raw === HARNESS_PRESET_AGENT_FOLLOWS ? subagent : raw;
    if (resolved) pins[key] = resolved;
  }
  return pins;
}

/** The thinking levels a preset pins per role, and on its default subagent. */
export function resolveClaudeSubagentEfforts(preset: HarnessPreset): {
  agents: Partial<Record<HarnessPresetAgentKey, string>>;
  defaultSubagentEffort?: string;
} {
  const agents: Partial<Record<HarnessPresetAgentKey, string>> = {};
  for (const key of HARNESS_PRESET_AGENT_KEYS) {
    const effort = preset.agentEfforts?.[key]?.trim();
    if (effort) agents[key] = effort;
  }
  const defaultSubagentEffort = preset.subagentEffort?.trim() || undefined;
  return {
    agents,
    ...(defaultSubagentEffort ? { defaultSubagentEffort } : {}),
  };
}

/**
 * The preset's subagent settings, as the harness config writers take them.
 *
 * Only the harnesses whose support table says `model` produce anything, and the
 * models stay UNPREFIXED here: the route path prefixes them, because only it
 * knows whether the launch is proxied. `undefined` means "write nothing", which
 * is what keeps a preset that pins nothing byte-identical to before this
 * existed.
 */
export function resolveSubagentLaunch(
  preset: HarnessPreset,
  harness: HarnessPresetBody,
): HarnessSubagentLaunch | undefined {
  const support = harnessSubagentSupport(harness);
  if (!support.model) return undefined;
  const followed = resolveSubagentModel(preset) ?? preset.model.trim();
  const agents: Partial<Record<HarnessPresetAgentKey, HarnessSubagentPin>> = {};
  for (const key of HARNESS_PRESET_AGENT_KEYS) {
    if (!subagentTypeName(harness, key)) continue;
    const raw = preset.agentOverrides?.[key]?.trim();
    const model = raw === HARNESS_PRESET_AGENT_FOLLOWS ? followed : raw;
    const effort = support.effort ? preset.agentEfforts?.[key]?.trim() : "";
    if (!model && !effort) continue;
    agents[key] = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  }
  // Each half stands on its own: a harness that takes a level can be told one
  // without also naming a model, and dropping that would ignore a choice the
  // wizard offered.
  const defaultSubagent = resolveSubagentModel(preset);
  const defaultEffort = support.effort ? preset.subagentEffort?.trim() : "";
  const subagents: HarnessSubagentPin | undefined = defaultSubagent || defaultEffort
    ? {
      ...(defaultSubagent ? { model: defaultSubagent } : {}),
      ...(defaultEffort ? { effort: defaultEffort } : {}),
    }
    : undefined;
  const launch: HarnessSubagentLaunch = {
    ...(subagents ? { subagents } : {}),
    ...(Object.keys(agents).length ? { agents } : {}),
  };
  return hasSubagentLaunch(launch) ? launch : undefined;
}

/** Every model id a subagent launch names, for a provider block's model list. */
export function subagentLaunchModelIds(subagent: HarnessSubagentLaunch | undefined): string[] {
  if (!subagent) return [];
  const ids = new Set<string>();
  if (subagent.subagents?.model) ids.add(subagent.subagents.model);
  for (const pin of Object.values(subagent.agents ?? {})) {
    if (pin?.model) ids.add(pin.model);
  }
  return [...ids];
}

/**
 * Claude's subagent-model env pair.
 *
 * The `_FORCE` half matters: without it the CLI treats the model as a default
 * a per-agent setting may override, and a preset that said "subagents on Haiku"
 * would silently keep running them on the main model.
 */
export function claudeSubagentEnv(subagentModel: string | undefined): Record<string, string> {
  if (!subagentModel) return {};
  return {
    CLAUDE_CODE_SUBAGENT_MODEL: subagentModel,
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
  };
}

/**
 * Everything a Claude preset's subagent settings become: one env pair for the
 * model, and one SDK `agents` entry per role it pins.
 *
 * `modelPrefix` is the proxy's upstream prefix, and every model here carries it
 * — a proxied launch reaches a model only under its upstream spelling.
 *
 * A pinned level needs a model to travel with. The SDK entry replaces the whole
 * definition, and `buildClaudeBuiltinAgentOverrides` drops an entry with no
 * model, so a level chosen without one follows the subagent model (or the
 * preset's own) rather than being silently ignored. The default subagent's
 * level has no environment variable either, so it becomes a `general-purpose`
 * entry — the type every unspecified spawn lands on — which carries ADE's copy
 * of Anthropic's prompt, exactly as a named pin does.
 */
export function claudeSubagentLaunchExtras(
  preset: HarnessPreset,
  subagentModel: string | undefined,
  modelPrefix: string,
): { env: Record<string, string>; claudeAgents?: Record<string, ClaudeBuiltinAgentOverride> } {
  const pins = Object.fromEntries(
    Object.entries(resolveAgentPins(preset)).map(([agent, model]) => [agent, `${modelPrefix}${model}`]),
  ) as ReturnType<typeof resolveAgentPins>;
  const efforts = resolveClaudeSubagentEfforts(preset);
  const agentEfforts: Partial<Record<HarnessPresetAgentKey, string>> = { ...efforts.agents };
  const followedModel = `${modelPrefix}${subagentModel ?? preset.model.trim()}`;
  for (const agent of Object.keys(agentEfforts) as HarnessPresetAgentKey[]) {
    if (!pins[agent]) pins[agent] = followedModel;
  }
  if (efforts.defaultSubagentEffort && !agentEfforts.generalPurpose) {
    agentEfforts.generalPurpose = efforts.defaultSubagentEffort;
    if (!pins.generalPurpose) pins.generalPurpose = followedModel;
  }
  const agents = buildClaudeBuiltinAgentOverrides(pins, agentEfforts);
  return {
    env: claudeSubagentEnv(subagentModel ? `${modelPrefix}${subagentModel}` : undefined),
    ...(Object.keys(agents).length ? { claudeAgents: agents } : {}),
  };
}

/**
 * Harnesses that can pin a subagent model, and those that can pin a thinking
 * level as well.
 *
 * The table in `shared/harnessPresets.ts` is the one that says why, and the
 * wizard renders from it; these two sets are the launch path's copy of the
 * same facts, kept as sets so a lookup cannot be written as a second switch.
 */
export const SUBAGENT_MODEL_SUPPORTED: ReadonlySet<HarnessPresetBody> = new Set(
  HARNESS_PRESET_BODIES.filter((harness) => HARNESS_SUBAGENT_SUPPORT[harness].model),
);
export const SUBAGENT_EFFORT_SUPPORTED: ReadonlySet<HarnessPresetBody> = new Set(
  HARNESS_PRESET_BODIES.filter((harness) => HARNESS_SUBAGENT_SUPPORT[harness].effort),
);

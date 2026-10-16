/**
 * The subagent half of a harness preset, written into the config ADE owns.
 *
 * Claude Code takes subagents as an SDK `agents` option (and the CLI's
 * `--agents` JSON), so its half lives in `claudeBuiltinAgentPrompts.ts` beside
 * the prompts those entries carry. Every other harness takes them in a config
 * file — Codex's `config.toml`, Grok's `config.toml`, OpenCode's
 * `opencode.json` — and those files are written in three different places for
 * three different sources. This module is the one place that says what a
 * preset's subagent settings become in each of those files, so the route
 * writer, the subscription writer and the key writer cannot drift into three
 * spellings of the same setting.
 *
 * WHAT EACH HARNESS ACTUALLY ACCEPTS is recorded in
 * `HARNESS_SUBAGENT_SUPPORT` (`harnessPresets.ts`) with the source it was read
 * from. Nothing here invents a key: a harness with no effort knob gets none
 * written, and the caller says so in the user's words instead.
 *
 * Pure: no fs, no IPC. Each `*Lines` builder returns the lines a caller
 * appends to a file it is already writing.
 */

import {
  HARNESS_PRESET_AGENT_KEYS,
  harnessSubagentSupport,
  type HarnessPresetAgentKey,
  type HarnessPresetBody,
} from "./harnessPresets";

/**
 * One resolved subagent pin.
 *
 * Either half may stand alone: a harness that takes a thinking level can be
 * told one without also naming a model (Codex), and a harness that takes a
 * model has no level to name (Grok, OpenCode). A pin with neither does not
 * exist — `hasSubagentLaunch` is what says so.
 */
export type HarnessSubagentPin = {
  /** The id the harness must request. Absent means "leave the model alone". */
  model?: string;
  effort?: string;
};

/**
 * What to write, already resolved for this launch.
 *
 * `agents` is keyed by the preset's SEMANTIC role (`explore`/`plan`/
 * `generalPurpose`); each writer maps it to its harness's own name for that
 * role. A pin for a role the harness does not expose by name is dropped —
 * `plan` on OpenCode, whose subagents are only `explore` and `general`.
 */
export type HarnessSubagentLaunch = {
  /** The default subagent's pin, when the preset names one. */
  subagents?: HarnessSubagentPin;
  /** Per-role pins. */
  agents?: Partial<Record<HarnessPresetAgentKey, HarnessSubagentPin>>;
};

/** Whether a preset has anything to write for this harness at all. */
export function hasSubagentLaunch(subagent: HarnessSubagentLaunch | undefined): boolean {
  if (!subagent) return false;
  if (subagent.subagents) return true;
  return HARNESS_PRESET_AGENT_KEYS.some((key) => Boolean(subagent.agents?.[key]));
}

/** Which roles a harness exposes by name, and what it calls each one. */
const AGENT_TYPE_NAMES: Partial<Record<HarnessPresetBody, Partial<Record<HarnessPresetAgentKey, string>>>> = {
  claude: { explore: "Explore", plan: "Plan", generalPurpose: "general-purpose" },
  grok: { explore: "explore", plan: "plan", generalPurpose: "general-purpose" },
  opencode: { explore: "explore", generalPurpose: "general" },
};

/** A harness's own name for a semantic role, or null when it has none. */
export function subagentTypeName(
  harness: HarnessPresetBody,
  key: HarnessPresetAgentKey,
): string | null {
  return AGENT_TYPE_NAMES[harness]?.[key] ?? null;
}

/** TOML double-quoted string, matching every other writer in the launch path. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Codex's `agents` table, as config.toml lines.
 *
 * Codex 0.155.1's own schema carries `agents.default_subagent_model` and
 * `agents.default_subagent_reasoning_effort`; the table is written whole
 * because ADE owns this file, and an empty result writes nothing rather than
 * an empty table.
 */
export function codexSubagentConfigTomlLines(subagent: HarnessSubagentLaunch | undefined): string[] {
  const model = subagent?.subagents?.model?.trim();
  const effort = subagent?.subagents?.effort?.trim();
  if (!model && !effort) return [];
  // Written whole because ADE owns this file, and an empty table would still be
  // a table. Each half is its own key, so naming only a level is a complete
  // request rather than a half-written one.
  const lines = ["", "[agents]"];
  if (model) lines.push(`default_subagent_model = ${tomlString(model)}`);
  if (effort) lines.push(`default_subagent_reasoning_effort = ${tomlString(effort)}`);
  return lines;
}

/**
 * Grok's `subagents.models` table, as config.toml lines.
 *
 * `subagents.models.<type>` is a model id per subagent type and nothing else —
 * Grok has no per-subagent effort key, so an effort here is dropped rather
 * than written in a key Grok would ignore.
 */
export function grokSubagentConfigTomlLines(
  harness: HarnessPresetBody,
  subagent: HarnessSubagentLaunch | undefined,
): string[] {
  if (!subagent || !harnessSubagentSupport(harness).model) return [];
  const entries: Array<[string, string]> = [];
  for (const key of HARNESS_PRESET_AGENT_KEYS) {
    const pin = subagent.agents?.[key];
    const type = subagentTypeName(harness, key);
    if (!pin?.model || !type) continue;
    entries.push([type, pin.model]);
  }
  // Grok's default subagent type is `general-purpose`; a preset that names only
  // a subagent model pins that type, which is the one every spawn lands on
  // unless the agent asks for another.
  if (subagent.subagents?.model && !entries.some(([type]) => type === "general-purpose")) {
    entries.unshift(["general-purpose", subagent.subagents.model]);
  }
  if (!entries.length) return [];
  return ["", "[subagents.models]", ...entries.map(([type, model]) => `${type} = ${tomlString(model)}`)];
}

/**
 * OpenCode's `agent` block, as a value to merge into `opencode.json`.
 *
 * A per-agent `model` is `provider/model`; ADE's provider id is the preset's
 * own block id, so the caller passes the whole id and this only decides which
 * agent names carry it. Effort is dropped for the same reason as Grok's.
 */
export function openCodeSubagentAgentBlock(
  harness: HarnessPresetBody,
  subagent: HarnessSubagentLaunch | undefined,
  modelIdFor: (model: string) => string,
): Record<string, { model: string }> | null {
  if (!subagent || !harnessSubagentSupport(harness).model) return null;
  const block: Record<string, { model: string }> = {};
  for (const key of HARNESS_PRESET_AGENT_KEYS) {
    const pin = subagent.agents?.[key];
    const type = subagentTypeName(harness, key);
    if (!pin?.model || !type) continue;
    block[type] = { model: modelIdFor(pin.model) };
  }
  // A model-less pin is a level, and OpenCode has no per-agent level to write.
  if (subagent.subagents?.model && !block.general) {
    block.general = { model: modelIdFor(subagent.subagents.model) };
  }
  return Object.keys(block).length ? block : null;
}

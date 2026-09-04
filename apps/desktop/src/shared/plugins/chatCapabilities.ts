/**
 * What a launch form may offer, as a plugin sees it.
 *
 * ## The gap this closes
 *
 * ADE's own launch form draws a native permission control per provider, a fast
 * toggle on the models that have a fast tier, and a reasoning ladder that is
 * per-model rather than a fixed none/low/medium/high. All three are REGISTRY
 * facts: they live in `shared/modelRegistry.ts` and in the permission unions in
 * `shared/types/chat.ts`. A plugin page rebuilding that form had no way to read
 * any of them, so the ported Linear launch modal offered one free-text
 * permission mode, no fast mode at all, and a hard-coded effort ladder.
 *
 * This module answers the question the form actually asks — "for THIS model,
 * what may the reader choose?" — and it is a READ. Nothing here launches
 * anything, and nothing here is a preference: the answer is the same for every
 * plugin and every project, so it needs no gate beyond the one `chat` already
 * has.
 *
 * ## Why it is here rather than reused from the renderer
 *
 * The app's own lists live in `renderer/lib/nativeLaunchControls.ts` and
 * `renderer/components/shared/permissionOptions.ts`, which a shared module may
 * not import and a plugin host cannot reach at all — the host runs in main and
 * in the daemon, where there is no renderer. The values are therefore restated
 * here, and `chatCapabilities.test.ts` pins them against the renderer's own
 * lists so the two cannot drift silently: a mode added to the app's Claude pill
 * and not to this file fails that test rather than quietly leaving plugin pages
 * a version behind.
 *
 * ## The shape of the answer
 *
 * Two lists, not a nesting. Providers carry the permission vocabulary because
 * permission is a provider fact — every Claude model takes the same five modes.
 * Models carry fast mode and the reasoning ladder because those are per-model,
 * and a page picking a model needs both without a second call. `provider` on a
 * model is the join.
 */

import { CURSOR_AVAILABLE_MODE_IDS } from "../cursorModes";
import {
  MODEL_REGISTRY,
  getDefaultModelDescriptor,
  getDynamicAcpModelDescriptors,
  getDynamicOpenCodeModelDescriptors,
  getDynamicPiModelDescriptors,
  modelSupportsFastMode,
  resolveProviderGroupForModel,
  type ModelDescriptor,
  type ModelProviderGroup,
} from "../modelRegistry";
import type {
  AgentChatClaudePermissionMode,
  AgentChatDroidPermissionMode,
  AgentChatOpenCodePermissionMode,
} from "../types/chat";

/**
 * The permission vocabularies a launch form can draw, by provider group.
 *
 * A closed list because it is the same closed list `AgentChatPermissionMode`
 * and its five native siblings are: a page that received a seventh family it
 * had never heard of would draw an empty control, which is worse than drawing
 * the provider's own default.
 */
export const PLUGIN_CHAT_PERMISSION_FAMILIES = [
  "claude",
  "codex",
  "cursor",
  "droid",
  "opencode",
] as const;

export type PluginChatPermissionFamily = (typeof PLUGIN_CHAT_PERMISSION_FAMILIES)[number];

/**
 * One choice on a provider's permission control.
 *
 * `value` is what a launch call takes back as its native permission argument —
 * `claudePermissionMode` for Claude, `droidPermissionMode` for Droid, and so
 * on. It is NOT the unified `AgentChatPermissionMode`: a page that sent
 * `acceptEdits` as a unified mode would be refused, and one that sent the
 * unified `edit` to Claude would get a mode Claude does not have. The two
 * vocabularies are named apart here for exactly that reason.
 */
export type PluginChatPermissionOption = {
  value: string;
  label: string;
  /** One sentence, the same one ADE's own control shows. */
  detail: string;
};

/** What one provider group lets a launch form offer. */
export type PluginChatProviderCapability = {
  provider: PluginChatPermissionFamily;
  /**
   * The launch argument a chosen `value` belongs in. A page copies this rather
   * than keeping its own provider→field table, which is the table that goes
   * stale when a sixth provider arrives.
   */
  permissionField: string;
  permissionModes: PluginChatPermissionOption[];
  /** The mode ADE itself starts on. Always one of `permissionModes`. */
  defaultPermissionMode: string;
};

/** One reasoning rung, as the model registry advertises it. */
export type PluginChatReasoningOption = {
  effort: string;
  label: string;
};

/** What one model lets a launch form offer. */
export type PluginChatModelCapability = {
  id: string;
  label: string;
  /** The provider group, and the join to {@link PluginChatProviderCapability}. */
  provider: ModelProviderGroup;
  /**
   * True when this model has a `fast` service tier, so a launch may pass
   * `fastMode: true`. False models refuse it rather than ignoring it, so a page
   * must not offer the toggle.
   */
  fastMode: boolean;
  /**
   * The reasoning ladder for THIS model. Empty means the model has no reasoning
   * control, which is a real answer and not a missing one — a page draws no
   * picker rather than falling back to none/low/medium/high.
   */
  reasoningEfforts: PluginChatReasoningOption[];
  /** The rung ADE starts on, or null when the model has no ladder. */
  defaultReasoningEffort: string | null;
  deprecated: boolean;
};

/**
 * The selection ADE's OWN launch form starts on.
 *
 * ## Why the two lists are not enough
 *
 * `providers` and `models` answer "what MAY the reader choose", and a form can
 * be drawn from them alone. What they cannot answer is "what is it set to
 * before the reader touches anything", and that answer is not derivable from
 * either list: ADE's own launch form opens on the model the user launched LAST,
 * which is per-user state in the project database, and falls back to the
 * registry default only for a user who has launched nothing. A page rebuilding
 * that form therefore opened on whatever its own author hard-coded — the ported
 * Linear launch modal opened on a fixed Claude id while the composer beside it
 * opened on the user's actual last model.
 *
 * So this is the composer's seed, computed on the HOST from the same recents
 * the composer reads, and offered as one object rather than five fields because
 * the five are only correct together: `effort` is the default rung of THIS
 * model, and `permissionMode` the default mode of THIS model's provider.
 *
 * Null only when the registry itself offers no model — a host with no Claude
 * and no OpenCode descriptors, which is a broken install rather than a user
 * with no history. A page that gets null draws its picker unset rather than
 * guessing an id.
 */
export type PluginChatDefaultModel = {
  /** The join to {@link PluginChatProviderCapability}, as on a model. */
  provider: ModelProviderGroup;
  modelId: string;
  /**
   * The rung to preselect, absent when this model has no reasoning ladder.
   * Always a member of the model's own `reasoningEfforts`.
   */
  effort?: string;
  /**
   * The provider's own default permission mode, in the provider's NATIVE
   * vocabulary — the same value `defaultPermissionMode` carries, which is what
   * `permissionField` takes back. Absent when the model's provider has no entry
   * in `providers` (a Pi or ACP model, whose permission control ADE does not
   * draw either).
   */
  permissionMode?: string;
  /**
   * Whether to start with the fast service tier ON. Always false today, because
   * ADE's own composer starts every launch on the standard tier and fast is a
   * per-launch opt-in. Reported rather than omitted so a page has the field to
   * bind its toggle to, and never on a model whose `fastMode` is false.
   */
  fastMode?: boolean;
};

/** The whole answer to `chat.capabilities`. */
export type PluginChatCapabilities = {
  providers: PluginChatProviderCapability[];
  models: PluginChatModelCapability[];
  /**
   * What the form opens on. See {@link PluginChatDefaultModel}.
   *
   * Present on every answer, `null` rather than absent when there is nothing to
   * seed: absent would be indistinguishable from a host too old to compute it,
   * and a page cannot tell "no default" from "no field" without that.
   */
  defaultModel: PluginChatDefaultModel | null;
};

const CLAUDE_PERMISSION_OPTIONS: PluginChatPermissionOption[] = [
  { value: "default", label: "Manual", detail: "Claude asks before edits, Bash, and other sensitive tools." },
  { value: "auto", label: "Auto", detail: "Claude judges each tool call." },
  { value: "acceptEdits", label: "Accept edits", detail: "File edits are auto-approved; higher-risk actions still prompt." },
  { value: "plan", label: "Plan mode", detail: "Read-only Claude turns for analysis and implementation planning." },
  { value: "bypassPermissions", label: "Bypass", detail: "Skip every Claude permission prompt for this chat." },
] satisfies { value: AgentChatClaudePermissionMode; label: string; detail: string }[];

/**
 * Codex is offered as PRESETS rather than as its two raw axes.
 *
 * The native control is an approval policy crossed with a sandbox, which is
 * sixteen combinations and four sensible ones. ADE's own form draws the four,
 * and a page drawing the sixteen would be offering the reader a matrix ADE
 * itself decided not to. The preset name is what `permissionMode` takes.
 */
const CODEX_PERMISSION_OPTIONS: PluginChatPermissionOption[] = [
  { value: "default", label: "Default", detail: "Ask on request with workspace write sandbox." },
  { value: "edit", label: "Edit", detail: "Untrusted approval with workspace write sandbox." },
  { value: "plan", label: "Plan", detail: "Read-only sandbox for planning." },
  { value: "full-auto", label: "Full auto", detail: "No approval prompts with full sandbox access." },
];

const OPENCODE_PERMISSION_OPTIONS: PluginChatPermissionOption[] = [
  { value: "plan", label: "Plan", detail: "Read-only turns for analysis and planning." },
  { value: "edit", label: "Edit", detail: "File edits are allowed; other tools still prompt." },
  { value: "full-auto", label: "Full auto", detail: "No approval prompts." },
  { value: "config-toml", label: "Config", detail: "Use the permissions in the project's own config." },
] satisfies { value: AgentChatOpenCodePermissionMode; label: string; detail: string }[];

const DROID_PERMISSION_OPTIONS: PluginChatPermissionOption[] = [
  { value: "read-only", label: "Read-only", detail: "No auto flag. Droid stays in read-only mode for analysis and planning." },
  { value: "auto-low", label: "Auto low", detail: "Passes --auto low for safe file edits and low-risk operations." },
  { value: "auto-medium", label: "Auto medium", detail: "Passes --auto medium for local development operations such as builds, tests, and package installs." },
  { value: "auto-high", label: "Auto high", detail: "Passes --auto high for broad automation. Use only in trusted workspaces." },
  { value: "agi", label: "AGI (orchestrator)", detail: "Droid decomposes the task into a mission and spawns worker subagents." },
] satisfies { value: AgentChatDroidPermissionMode; label: string; detail: string }[];

const CURSOR_MODE_LABELS: Record<string, string> = {
  agent: "Agent",
  ask: "Ask",
  plan: "Plan",
  "full-auto": "Full auto",
};

const CURSOR_PERMISSION_OPTIONS: PluginChatPermissionOption[] = CURSOR_AVAILABLE_MODE_IDS.map((modeId) => ({
  value: modeId,
  label: CURSOR_MODE_LABELS[modeId] ?? modeId,
  detail: `Launch Cursor in its ${CURSOR_MODE_LABELS[modeId] ?? modeId} mode.`,
}));

/**
 * The provider half of the answer. A pure constant — no registry read, because
 * a provider's permission vocabulary does not depend on which models are
 * installed.
 */
export function pluginChatProviderCapabilities(): PluginChatProviderCapability[] {
  return [
    {
      provider: "claude",
      permissionField: "claudePermissionMode",
      permissionModes: CLAUDE_PERMISSION_OPTIONS,
      defaultPermissionMode: "default",
    },
    {
      provider: "codex",
      permissionField: "permissionMode",
      permissionModes: CODEX_PERMISSION_OPTIONS,
      defaultPermissionMode: "default",
    },
    {
      provider: "cursor",
      permissionField: "cursorModeId",
      permissionModes: CURSOR_PERMISSION_OPTIONS,
      defaultPermissionMode: "agent",
    },
    {
      provider: "droid",
      permissionField: "droidPermissionMode",
      permissionModes: DROID_PERMISSION_OPTIONS,
      defaultPermissionMode: "read-only",
    },
    {
      provider: "opencode",
      permissionField: "opencodePermissionMode",
      permissionModes: OPENCODE_PERMISSION_OPTIONS,
      defaultPermissionMode: "edit",
    },
  ];
}

/** Title-case one effort id for a control that has no label of its own. */
function reasoningLabel(effort: string): string {
  if (!effort) return effort;
  return effort.charAt(0).toUpperCase() + effort.slice(1).replace(/[-_]/g, " ");
}

function toModelCapability(descriptor: ModelDescriptor): PluginChatModelCapability {
  const tiers = descriptor.reasoningTiers ?? [];
  return {
    id: descriptor.id,
    label: descriptor.displayName,
    provider: resolveProviderGroupForModel(descriptor),
    fastMode: modelSupportsFastMode(descriptor),
    reasoningEfforts: tiers.map((effort) => ({ effort, label: reasoningLabel(effort) })),
    // A default that is not on the ladder is dropped rather than reported: a
    // page would preselect a rung its own picker does not contain, and the
    // launch would then be refused by a validator the page cannot see.
    defaultReasoningEffort:
      descriptor.defaultReasoningEffort && tiers.includes(descriptor.defaultReasoningEffort)
        ? descriptor.defaultReasoningEffort
        : null,
    deprecated: descriptor.deprecated === true,
  };
}

/**
 * Every model a plugin may launch, with its own fast and reasoning facts.
 *
 * The dynamic registries are included because they are where the OpenCode, Pi
 * and ACP models live, and a page that only saw the static table would offer a
 * model list shorter than ADE's own picker. Dynamic Cursor and Droid CLI
 * descriptors are NOT included: they are created per checkout from what the CLI
 * reports and are not registered on a module-level list this process can read
 * without a runtime.
 */
export function pluginChatModelCapabilities(): PluginChatModelCapability[] {
  const seen = new Set<string>();
  const out: PluginChatModelCapability[] = [];
  const push = (descriptor: ModelDescriptor): void => {
    if (seen.has(descriptor.id)) return;
    seen.add(descriptor.id);
    out.push(toModelCapability(descriptor));
  };
  for (const descriptor of MODEL_REGISTRY) push(descriptor);
  for (const descriptor of getDynamicOpenCodeModelDescriptors()) push(descriptor);
  for (const descriptor of getDynamicPiModelDescriptors()) push(descriptor);
  for (const provider of ["qwen", "kimi", "grok", "copilot"] as const) {
    for (const descriptor of getDynamicAcpModelDescriptors(provider)) push(descriptor);
  }
  return out;
}

/**
 * The launch-form seed, from this user's recent models.
 *
 * The selection rule is `BatchLaunchModal`'s, restated rather than imported for
 * the reason the permission lists above are: that file is renderer code a
 * shared module may not import and the plugin host cannot reach. The rule is
 * "the most recent model that still exists, else the Claude default, else the
 * OpenCode default", and `chatCapabilities.test.ts` pins it against the
 * modal's own expression so the two cannot drift.
 *
 * Recents that name a model this host no longer has are SKIPPED rather than
 * ending the search: a user whose last launch was a dynamic OpenCode model that
 * is no longer installed still has a second-most-recent, and falling straight
 * to the Claude default there would move their form under them for one absent
 * catalog entry.
 *
 * `recents` is newest-first, exactly as `modelPicker.getRecents` answers it. An
 * empty list is the ordinary state for a new user, not an error.
 */
export function pluginChatDefaultModel(
  recents: readonly string[] = [],
): PluginChatDefaultModel | null {
  const models = pluginChatModelCapabilities();
  const byId = new Map(models.map((model) => [model.id, model] as const));
  let chosen: PluginChatModelCapability | undefined;
  for (const modelId of recents) {
    const match = byId.get(modelId);
    if (match) {
      chosen = match;
      break;
    }
  }
  if (!chosen) {
    for (const provider of ["claude", "opencode"] as const) {
      const descriptor = getDefaultModelDescriptor(provider);
      const match = descriptor ? byId.get(descriptor.id) : undefined;
      if (match) {
        chosen = match;
        break;
      }
    }
  }
  if (!chosen) return null;
  const model = chosen;
  const providerCap = pluginChatProviderCapabilities()
    .find((entry) => entry.provider === model.provider);
  return {
    provider: model.provider,
    modelId: model.id,
    ...(model.defaultReasoningEffort ? { effort: model.defaultReasoningEffort } : {}),
    ...(providerCap ? { permissionMode: providerCap.defaultPermissionMode } : {}),
    ...(model.fastMode ? { fastMode: false } : {}),
  };
}

/** What the host knows that the registry does not. */
export type PluginChatCapabilitiesInput = {
  /**
   * This user's recently launched model ids, newest first — the answer to
   * `modelPicker.getRecents`. Absent on a host that cannot read them (no
   * project bound, or a read that failed), which resolves to the registry
   * default rather than to no default at all.
   */
  recents?: readonly string[];
};

/** The whole answer. See {@link PluginChatCapabilities}. */
export function pluginChatCapabilities(
  input: PluginChatCapabilitiesInput = {},
): PluginChatCapabilities {
  return {
    providers: pluginChatProviderCapabilities(),
    models: pluginChatModelCapabilities(),
    defaultModel: pluginChatDefaultModel(input.recents ?? []),
  };
}

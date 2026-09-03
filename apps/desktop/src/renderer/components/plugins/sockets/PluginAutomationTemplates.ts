import React from "react";

import { isRecord, trimmed } from "../../../../shared/plugins/parse";
import type {
  AutomationLaneMode,
  AutomationLaneNamePreset,
  AutomationMode,
  AutomationOutputDisposition,
  AutomationReviewProfile,
  AutomationRuleDraft,
  AutomationToolFamily,
  AutomationTrigger,
  ThinkingLevel,
} from "../../../../shared/types";
import { usePluginAutomationTriggers } from "../usePluginRegistry";
import { usePluginSurfaceContributions, useSurfaceContributions } from "./useSurfaceContributions";

/**
 * The `automation-template` socket: a plugin's cards in the Automations
 * templates gallery.
 *
 * The whole file is one judgement: **the template body is untrusted plugin JSON
 * and is normalized field by field, not merged.** `parsePluginAutomationTemplateBody`
 * (shared) proved it is a small record and stopped there deliberately — a
 * module that runs in the daemon, in the terminal and on the phone has no
 * business knowing a rule draft's shape. So the MEANING is proved here, in the
 * one client that owns the draft type, by building a fresh draft out of the
 * fields below and dropping everything else.
 *
 * Two things are deliberately NOT accepted, and both are refusals rather than
 * omissions:
 *
 * - **Built-in action chains.** `execution.builtIn.actions` is where
 *   `run-command` lives, and a template that could seed one would be a plugin
 *   writing a shell command into a rule the user is one Save away from arming.
 *   A plugin template seeds an AGENT rule — a prompt, a model, a tool palette —
 *   which runs under ADE's own permission model and is the shape every ported
 *   playbook actually wants.
 * - **Anyone else's trigger.** The trigger is forced to this plugin's own
 *   `plugin` trigger, so a template cannot seed a rule that fires on GitHub, on
 *   the schedule, or on a second plugin's events. The body may still CHOOSE
 *   which of the plugin's triggers, because that is a choice inside its own
 *   namespace and the plugin is the only thing that can fire it.
 */

const MODES: readonly AutomationMode[] = ["review", "fix", "monitor"];

const REVIEW_PROFILES: readonly AutomationReviewProfile[] = [
  "quick",
  "incremental",
  "full",
  "security",
  "release-risk",
  "cross-repo-contract",
];

const TOOL_FAMILIES: readonly AutomationToolFamily[] = [
  "repo",
  "git",
  "tests",
  "github",
  "linear",
  "browser",
];

const DISPOSITIONS: readonly AutomationOutputDisposition[] = [
  "comment-only",
  "open-task",
  "open-lane",
  "prepare-patch",
  "open-pr-draft",
];

const LANE_MODES: readonly AutomationLaneMode[] = ["create", "reuse", "require-on-trigger"];

const LANE_NAME_PRESETS: readonly AutomationLaneNamePreset[] = [
  "issue-title",
  "issue-num-title",
  "pr-title-author",
  "custom",
];

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "max",
  "xhigh",
  "ultra",
  "ultracode",
];

/** A prompt is the body of a template; longer than a label, shorter than a file. */
const PROMPT_MAX = 4_000;

/** The same ceiling `parsePluginAutomationTriggerOptions` puts on a radio's label. */
const NAME_MAX = 60;

const DESCRIPTION_MAX = 240;

function oneOfList<T extends string>(value: unknown, list: readonly T[]): T | null {
  const text = trimmed(value);
  if (!text) return null;
  return list.find((entry) => entry === text) ?? null;
}

function boundedText(value: unknown, max: number): string | null {
  const text = trimmed(value);
  if (!text) return null;
  return text.slice(0, max);
}

/** A finite, non-negative number, or null. `Infinity` and `NaN` survive JSON round trips as neither. */
function boundedNumber(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(value, max);
}

/** One plugin template, already normalized and ready to seed the builder. */
export type PluginAutomationTemplateCard = {
  pluginId: string;
  pluginName: string;
  accent: string | null;
  /** The plugin's declared icon token for the card, when it declared one. */
  icon: string | null;
  /** Stable per-plugin id — the gallery's React key. */
  id: string;
  name: string;
  description: string;
  draft: Omit<AutomationRuleDraft, "id">;
};

/**
 * The defaults every ADE template already shares (`templateData.ts`'s `BASE`).
 *
 * Repeated here rather than imported because `templateData` is a MAIN-process
 * import (`automationPlannerService.test.ts`) and this module is React; the
 * dependency would run the wrong way. They are defaults, not a contract — a
 * body may override each of them through the fields below.
 */
function baseDraft(): Omit<AutomationRuleDraft, "id" | "name" | "trigger" | "triggers"> {
  return {
    enabled: true,
    mode: "review",
    executor: { mode: "automation-bot" },
    reviewProfile: "quick",
    toolPalette: ["repo", "git"],
    contextSources: [],
    guardrails: {},
    outputs: { disposition: "comment-only", createArtifact: true },
    verification: { verifyBeforePublish: false, mode: "intervention" },
    execution: { kind: "agent-session" },
    billingCode: "",
    actions: [],
  };
}

/**
 * Build a draft from one template body, or `null` when nothing usable survives.
 *
 * "Nothing usable" is measured on the body, not on the result: a body that
 * contributed no recognized field would produce a perfectly valid EMPTY rule —
 * the base defaults plus the forced trigger — and a gallery card offering that
 * is a card offering nothing, indistinguishable from ADE's own "New rule"
 * button while claiming the plugin's name.
 *
 * `declaredTriggerIds` is the plugin's own `automationTriggers`. A body naming
 * one of them keeps it; a body naming none takes the first declared. A plugin
 * that declares no trigger at all yields `null`: save-time validation refuses a
 * `plugin` trigger with no `pluginTrigger`, so such a card could only ever seed
 * a rule the user cannot save.
 */
export function normalizePluginTemplateDraft(
  body: Record<string, unknown>,
  context: {
    pluginId: string;
    declaredTriggerIds: readonly string[];
    /** The card's own name, used when the body does not carry one. */
    fallbackName: string;
  },
): Omit<AutomationRuleDraft, "id"> | null {
  let recognized = 0;
  const draft = baseDraft() as Omit<AutomationRuleDraft, "id">;

  const name = boundedText(body.name, NAME_MAX);
  if (name) recognized += 1;
  draft.name = name ?? context.fallbackName;

  const description = boundedText(body.description, DESCRIPTION_MAX);
  if (description) {
    draft.description = description;
    recognized += 1;
  }

  if (typeof body.enabled === "boolean") {
    draft.enabled = body.enabled;
    recognized += 1;
  }

  const mode = oneOfList(body.mode, MODES);
  if (mode) {
    draft.mode = mode;
    recognized += 1;
  }

  const reviewProfile = oneOfList(body.reviewProfile, REVIEW_PROFILES);
  if (reviewProfile) {
    draft.reviewProfile = reviewProfile;
    recognized += 1;
  }

  const prompt = boundedText(body.prompt, PROMPT_MAX);
  if (prompt) {
    draft.prompt = prompt;
    recognized += 1;
  }

  if (Array.isArray(body.toolPalette)) {
    const families = [...new Set(
      body.toolPalette
        .map((entry) => oneOfList(entry, TOOL_FAMILIES))
        .filter((entry): entry is AutomationToolFamily => entry != null),
    )];
    // An array that contained only unknown families is not "no tools" — it is a
    // plugin naming things this build does not have. Keeping the base palette
    // is the honest fallback; an empty one would strip the agent of the repo.
    if (families.length > 0) {
      draft.toolPalette = families;
      recognized += 1;
    }
  }

  // Only the model the body names, never a permission config: permissions are
  // ADE's own gate on what an agent may do, and a plugin widening them from a
  // template body would be the template granting itself trust.
  if (isRecord(body.modelConfig)) {
    const modelId = boundedText(body.modelConfig.modelId, 120);
    if (modelId) {
      const thinkingLevel = oneOfList(body.modelConfig.thinkingLevel, THINKING_LEVELS);
      draft.modelConfig = { modelId, ...(thinkingLevel ? { thinkingLevel } : {}) };
      recognized += 1;
    }
  }

  if (isRecord(body.guardrails)) {
    const maxDurationMin = boundedNumber(body.guardrails.maxDurationMin, 24 * 60);
    const budgetUsd = boundedNumber(body.guardrails.budgetUsd, 1_000);
    const guardrails = {
      ...(maxDurationMin != null ? { maxDurationMin } : {}),
      ...(budgetUsd != null ? { budgetUsd } : {}),
    };
    if (Object.keys(guardrails).length > 0) {
      draft.guardrails = guardrails;
      recognized += 1;
    }
  }

  if (isRecord(body.outputs)) {
    const disposition = oneOfList(body.outputs.disposition, DISPOSITIONS);
    if (disposition) {
      draft.outputs = {
        disposition,
        createArtifact: body.outputs.createArtifact !== false,
      };
      recognized += 1;
    }
  }

  // `kind` is pinned to `agent-session` and `builtIn` is never read — see the
  // file header. What a body may say about execution is which lane the agent
  // runs in, which is a placement, not a capability.
  if (isRecord(body.execution)) {
    const laneMode = oneOfList(body.execution.laneMode, LANE_MODES);
    const laneNamePreset = oneOfList(body.execution.laneNamePreset, LANE_NAME_PRESETS);
    const laneNameTemplate = boundedText(body.execution.laneNameTemplate, 200);
    if (laneMode || laneNamePreset || laneNameTemplate) {
      draft.execution = {
        kind: "agent-session",
        ...(laneMode ? { laneMode } : {}),
        ...(laneNamePreset ? { laneNamePreset } : {}),
        ...(laneNameTemplate ? { laneNameTemplate } : {}),
      };
      recognized += 1;
    }
  }

  if (recognized === 0) return null;

  const requested = trimmed(isRecord(body.trigger) ? body.trigger.pluginTrigger : null);
  const pluginTrigger = requested && context.declaredTriggerIds.includes(requested)
    ? requested
    : context.declaredTriggerIds[0];
  if (!pluginTrigger) return null;

  const trigger: AutomationTrigger = {
    type: "plugin",
    pluginId: context.pluginId,
    pluginTrigger,
  };
  draft.trigger = trigger;
  draft.triggers = [trigger];
  draft.billingCode = `auto:${context.pluginId}`;
  return draft;
}

/**
 * Every enabled plugin's template cards, normalized, in the host's order.
 *
 * A card whose body normalizes to nothing is absent rather than disabled: a
 * greyed-out template is a promise the plugin made and did not keep, and the
 * reader can do nothing about it from here.
 */
export function usePluginAutomationTemplates(active = true): PluginAutomationTemplateCard[] {
  const contributions = useSurfaceContributions("automations", "automation-template", { active });
  const { identities } = usePluginSurfaceContributions("automations", active);
  const triggerIdsByPlugin = usePluginDeclaredTriggerIds();

  return React.useMemo(() => {
    const cards: PluginAutomationTemplateCard[] = [];
    for (const contribution of contributions) {
      const identity = identities.get(contribution.pluginId);
      const draft = normalizePluginTemplateDraft(contribution.payload.template, {
        pluginId: contribution.pluginId,
        declaredTriggerIds: triggerIdsByPlugin.get(contribution.pluginId) ?? [],
        fallbackName: contribution.payload.name,
      });
      if (!draft) continue;
      cards.push({
        pluginId: contribution.pluginId,
        pluginName: identity?.displayName || contribution.pluginId,
        accent: identity?.accent ?? null,
        icon: contribution.payload.icon ?? null,
        id: `${contribution.pluginId}::${contribution.id}`,
        name: contribution.payload.name,
        description: contribution.payload.description ?? "",
        draft,
      });
    }
    return cards;
  }, [contributions, identities, triggerIdsByPlugin]);
}

/**
 * Which trigger ids each plugin declares, read off the installed registry.
 *
 * Not read from the tile socket: a plugin may ship templates and no tile, and a
 * template still has to point at a real declared trigger. `usePluginAutomationTriggers`
 * would answer the same question flattened, but the gallery needs it grouped by
 * plugin and needs the DISABLED-contribution filter it already applies, so this
 * reuses that hook rather than re-deriving from the store.
 */
function usePluginDeclaredTriggerIds(): ReadonlyMap<string, string[]> {
  const options = usePluginAutomationTriggers();
  return React.useMemo(() => {
    const byPlugin = new Map<string, string[]>();
    for (const option of options) {
      const existing = byPlugin.get(option.pluginId);
      if (existing) existing.push(option.value);
      else byPlugin.set(option.pluginId, [option.value]);
    }
    return byPlugin;
  }, [options]);
}

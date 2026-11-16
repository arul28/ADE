// Requests that pick a model must name it in full (`anthropic/claude-fable-5-2`
// or `claude-fable-5-2`). `shorthandModelNameRefusal` says why a name is not;
// this module names the inputs that pick a model and turns a refusal into the
// JSON-RPC error the caller sees.

import { resolveClaudeCliModelAlias } from "../../desktop/src/shared/claudeCliModels";
import { getModelById, shorthandModelNameRefusal } from "../../desktop/src/shared/modelRegistry";
import {
  launchModelMissing,
  launchModelRequiredMessage,
  unknownModelHint,
  webhookModelRequiredMessage,
} from "../../desktop/src/shared/launchModelRule";
import { customProviderModelProblem } from "../../desktop/src/shared/customProviderRef";
import type { HarnessPreset } from "../../desktop/src/shared/harnessPresets";
import { JsonRpcError, JsonRpcErrorCode } from "./jsonrpc";

type Fields = Record<string, unknown>;
/** A model name and the provider the request runs it on, when it says. */
type PickedModel = { ref: unknown; provider?: unknown };

function record(value: unknown): Fields | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Fields : null;
}

/**
 * The model a chat-shaped input picks. `modelId` wins when it is given:
 * callers that know the registry row send it with the harness's own id beside
 * it as `model` (a Devin chat sends `model: "opus"` with `modelId:
 * "devin/opus"`), and that `model` is not a name anyone typed.
 */
function chatModelRef(fields: Fields | null): unknown {
  if (!fields) return undefined;
  const modelId = typeof fields.modelId === "string" ? fields.modelId.trim() : "";
  return modelId || fields.model;
}

/** A launch's provider, the fields that may name its model, and its Custom provider id. */
type LaunchModels = { provider: unknown; models: unknown[]; presetId?: unknown; message?: string };

/** What one action's input says about models. */
type ActionModelRule = {
  /** The model names it picks, checked for shorthand. */
  refs: (fields: Fields) => PickedModel[];
  /**
   * For an action that starts a new agent: the provider and every field that
   * may name its model, or null when this input starts none. An agent caller
   * must fill one of them.
   */
  launch?: (fields: Fields) => LaunchModels | null;
};

const chatRefs = (fields: Fields): PickedModel[] => [{ ref: chatModelRef(fields), provider: fields.provider }];
const chatLaunch = (fields: Fields): LaunchModels => ({
  provider: fields.provider,
  models: [fields.model, fields.modelId],
  presetId: fields.presetId,
});
const targetModelRefs = (fields: Fields): PickedModel[] => [{ ref: fields.targetModelId }];
const providerModelRefs = (fields: Fields): PickedModel[] => [{ ref: fields.model, provider: fields.provider }];

/**
 * The actions whose input picks a model, by action. Only these are checked:
 * other inputs carry a chat's stored model (a move between machines), name a
 * model as stats do (`usage.*`), or hold arbitrary JSON (a webhook sample
 * event), and old names there must keep working. A move, handoff or side chat
 * keeps a chat's own model, so only fresh launches carry `launch`.
 */
const ACTION_MODEL_RULES: ReadonlyMap<string, ActionModelRule> = new Map<string, ActionModelRule>([
  // The CLI launcher runs `model` and reads no `modelId`.
  ["chat.launchCli", {
    refs: providerModelRefs,
    launch: (fields) => ({ provider: fields.provider, models: [fields.model], presetId: fields.presetId }),
  }],
  ["chat.createSession", { refs: chatRefs, launch: chatLaunch }],
  ["chat.launchHeadless", { refs: chatRefs, launch: chatLaunch }],
  ["chat.updateSession", { refs: chatRefs }],
  ["chat.startSideChat", { refs: chatRefs }],
  ["chat.startLaunch", {
    refs: (fields) => {
      const create = record(record(fields.chat)?.create);
      return [
        { ref: fields.modelId, provider: fields.provider },
        { ref: chatModelRef(create), provider: create?.provider ?? fields.provider },
      ];
    },
    // Only a chat launch starts its agent here: a CLI launch starts it later
    // through `chat.launchCli`, and a lane launch starts none.
    launch: (fields) => {
      if (fields.kind === "cli" || fields.kind === "lane") return null;
      const create = record(record(fields.chat)?.create);
      return {
        provider: create?.provider ?? fields.provider,
        // The top-level `modelId` only names the lane; the chat runs `chat.create`'s.
        models: [create?.model, create?.modelId],
        presetId: create?.presetId,
      };
    },
  }],
  ["chat.handoffSession", { refs: targetModelRefs }],
  ["chat.startCrossMachineHandoff", { refs: targetModelRefs }],
  ["chat.previewCrossMachineHandoff", { refs: targetModelRefs }],
  ["automations.webhookCreateAutomation", {
    refs: (fields) => [{ ref: fields.modelId }],
    // Delivered into an existing chat, an event starts no new agent.
    launch: (fields) => (named(fields.chatSessionId)
      ? null
      : { provider: null, models: [fields.modelId], message: webhookModelRequiredMessage("field") }),
  }],
  ["automations.saveRule", {
    refs: (fields) => automationDraftModelRefs(record(fields.draft)),
    launch: (fields) => {
      const missing = automationDraftMissingModel(record(fields.draft));
      return missing ? { provider: null, models: [], message: missing } : null;
    },
  }],
  ["external-sessions.import", { refs: providerModelRefs }],
  ["usage.previewModelRoute", { refs: providerModelRefs }],
]);

function modelRefsPickedBy(domain: string, action: string, input: unknown): PickedModel[] {
  const fields = record(input);
  const rule = ACTION_MODEL_RULES.get(`${domain}.${action}`);
  return fields && rule ? rule.refs(fields) : [];
}

/** The rule's own model and the model of each built-in agent or handoff step. */
function automationDraftModelRefs(draft: Fields | null): PickedModel[] {
  if (!draft) return [];
  const refs: PickedModel[] = [{ ref: record(draft.modelConfig)?.modelId }];
  // Steps live in `actions` (and the older `legacyActions`), and a built-in
  // execution carries its own list; the rule runs whichever it has.
  const steps = [draft.actions, draft.legacyActions, record(record(draft.execution)?.builtIn)?.actions]
    .flatMap((list) => (Array.isArray(list) ? list : []));
  for (const step of steps) {
    const fields = record(step);
    if (fields?.type === "agent-session") refs.push({ ref: record(fields.modelConfig)?.modelId });
    if (fields?.type === "handoff") refs.push({ ref: fields.targetModelId });
  }
  return refs;
}

/**
 * Which agent a rule would start on a model nobody named, or null. The rule's
 * own `modelConfig.modelId` runs an agent-session rule and any agent step that
 * names none; a handoff names its target. Without them the run falls back to
 * ADE's default, which an agent may not choose by leaving the field out.
 */
function automationDraftMissingModel(draft: Fields | null): string | null {
  if (!draft) return null;
  const ruleModel = record(draft.modelConfig)?.modelId;
  const execution = record(draft.execution);
  const steps = [draft.actions, draft.legacyActions, record(execution?.builtIn)?.actions]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .map(record)
    .filter((step): step is Fields => step !== null);
  const legacySteps = Array.isArray(draft.legacyActions) && draft.legacyActions.length > 0;
  const kind = typeof execution?.kind === "string" ? execution.kind : legacySteps ? "built-in" : "agent-session";
  const ask = "Set modelConfig.modelId on the rule (or on that step). ";
  if (kind === "agent-session" && !named(ruleModel)) {
    return `${ask}The rule starts an agent, and ADE never picks its model. ${unknownModelHint()}`;
  }
  for (const step of steps) {
    if (step.type === "agent-session" && !named(record(step.modelConfig)?.modelId) && !named(ruleModel)) {
      return `${ask}An agent step names no model, and ADE never picks one. ${unknownModelHint()}`;
    }
    if (step.type === "handoff" && !named(step.targetModelId)) {
      return `Set targetModelId on the handoff step: ADE never picks the model it hands to. ${unknownModelHint()}`;
    }
  }
  return null;
}

/**
 * Why a name is refused, or null. Beyond the registry's own aliases, a bare
 * Claude id the registry has no row for (`claude-sonnet-4-5`) is refused on the
 * Claude provider when Claude Code would run a different model for it. Other
 * harnesses have bare ids of their own that look alike (Cursor's
 * `claude-4.6-sonnet-medium`), so the check stays on Claude.
 */
function modelNameRefusal(modelRef: unknown, provider?: unknown): string | null {
  const registryRefusal = shorthandModelNameRefusal(modelRef);
  if (registryRefusal || typeof modelRef !== "string" || provider !== "claude") return registryRefusal;
  const raw = modelRef.trim();
  if (!raw || raw.includes("/") || !/claude|opus|sonnet|haiku|fable/i.test(raw) || getModelById(raw)) return null;
  const runs = resolveClaudeCliModelAlias(raw, null);
  if (!runs || runs.toLowerCase() === raw.toLowerCase()) return null;
  return `"${raw}" is not a model ADE runs. Use "${runs}" or pick one from \`ade models catalog --text\`.`;
}

function throwIfRefused(refusal: string | null): void {
  if (refusal) throw new JsonRpcError(JsonRpcErrorCode.invalidParams, refusal);
}

/**
 * Every model name a saved automation rule holds, so an edit that leaves one
 * as it was (a rule saved before full names, renamed by an agent) still saves.
 */
export function savedRuleModelNames(rule: unknown, depth = 0): Set<string> {
  const names = new Set<string>();
  if (depth > 6 || rule === null || typeof rule !== "object") return names;
  for (const [key, value] of Object.entries(rule)) {
    if ((key === "modelId" || key === "targetModelId") && typeof value === "string") names.add(value.trim());
    else for (const name of savedRuleModelNames(value, depth + 1)) names.add(name);
  }
  return names;
}

/**
 * Refuses a model-picking action whose input names a model by shorthand.
 * `unchanged` holds names the request keeps from what it edits; those pass.
 */
export function assertActionModelNames(
  domain: string,
  action: string,
  input: unknown,
  unchanged: ReadonlySet<string> = new Set(),
): void {
  for (const picked of modelRefsPickedBy(domain, action, input)) {
    if (typeof picked.ref === "string" && unchanged.has(picked.ref.trim())) continue;
    throwIfRefused(modelNameRefusal(picked.ref, picked.provider));
  }
}

/** Refuses one model name that is shorthand, for a launch on `provider`. */
export function assertFullModelName(modelRef: string | null | undefined, provider: string): void {
  throwIfRefused(modelNameRefusal(modelRef, provider));
}

function named(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function refuseMissingModel(provider: unknown, message?: string): never {
  throw new JsonRpcError(
    JsonRpcErrorCode.invalidParams,
    message ?? launchModelRequiredMessage(typeof provider === "string" ? provider : null, "model"),
  );
}

/**
 * An agent that starts another agent names its model: ADE never picks one for
 * it. The desktop app (left out by the caller) always sends one.
 */
export function assertLaunchModelNamed(domain: string, action: string, input: unknown): void {
  const fields = record(input);
  const launch = fields ? ACTION_MODEL_RULES.get(`${domain}.${action}`)?.launch?.(fields) : null;
  if (launch && launchModelMissing(launch.provider, ...launch.models)) refuseMissingModel(launch.provider, launch.message);
}

/**
 * A launch on a saved Custom provider names that provider's own model: it runs
 * one model, so a different one is a mistake, and the service would otherwise
 * run the Custom provider's model without saying so. `readPresets` reads this
 * machine's saved list (the one the service resolves `presetId` against),
 * only when the launch names one. A
 * `--via` route id or an id not saved here is left to the service.
 */
export function assertCustomProviderModel(
  domain: string,
  action: string,
  input: unknown,
  readPresets: () => readonly HarnessPreset[] | null,
): void {
  const fields = record(input);
  const launch = fields ? ACTION_MODEL_RULES.get(`${domain}.${action}`)?.launch?.(fields) : null;
  const presetId = typeof launch?.presetId === "string" ? launch.presetId.trim() : "";
  const given = (launch?.models ?? []).filter((model): model is string => named(model));
  if (!presetId || !given.length) return;
  const preset = readPresets()?.find((candidate) => candidate.id === presetId);
  if (!preset) return;
  if (given.some((model) => customProviderModelProblem(preset, model, "model") === null)) return;
  throwIfRefused(customProviderModelProblem(preset, given[0], "model"));
}

/** The same rule for a tool that starts a CLI agent (`start_cli_session`, `spawn_agent`). */
export function assertCliLaunchModelNamed(model: string | null | undefined, provider: string): void {
  if (launchModelMissing(provider, model)) refuseMissingModel(provider);
}

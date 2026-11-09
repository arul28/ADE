// Requests that pick a model must name it in full (`anthropic/claude-fable-5-2`
// or `claude-fable-5-2`). `shorthandModelNameRefusal` says why a name is not;
// this module names the inputs that pick a model and turns a refusal into the
// JSON-RPC error the caller sees.

import { resolveClaudeCliModelAlias } from "../../desktop/src/shared/claudeCliModels";
import { getModelById, shorthandModelNameRefusal } from "../../desktop/src/shared/modelRegistry";
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

/**
 * The model names an action's input picks, by action. Only these are
 * checked: other inputs carry a chat's stored model (a move between machines),
 * name a model as stats do (`usage.*`), or hold arbitrary JSON (a webhook
 * sample event), and old names there must keep working.
 */
function modelRefsPickedBy(domain: string, action: string, input: unknown): PickedModel[] {
  const fields = record(input);
  if (!fields) return [];
  switch (`${domain}.${action}`) {
    case "chat.createSession":
    case "chat.updateSession":
    case "chat.launchCli":
    case "chat.launchHeadless":
    case "chat.startSideChat":
      return [{ ref: chatModelRef(fields), provider: fields.provider }];
    case "chat.startLaunch": {
      const create = record(record(fields.chat)?.create);
      return [
        { ref: fields.modelId, provider: fields.provider },
        { ref: chatModelRef(create), provider: create?.provider ?? fields.provider },
      ];
    }
    case "chat.handoffSession":
    case "chat.startCrossMachineHandoff":
    case "chat.previewCrossMachineHandoff":
      return [{ ref: fields.targetModelId }];
    case "automations.webhookCreateAutomation":
      return [{ ref: fields.modelId }];
    case "automations.saveRule":
      return automationDraftModelRefs(record(fields.draft));
    case "external-sessions.import":
    case "usage.previewModelRoute":
      return [{ ref: fields.model, provider: fields.provider }];
    default:
      return [];
  }
}

/** The rule's own model and the model of each built-in agent or handoff step. */
function automationDraftModelRefs(draft: Fields | null): PickedModel[] {
  if (!draft) return [];
  const refs: PickedModel[] = [{ ref: record(draft.modelConfig)?.modelId }];
  const actions = record(record(draft.execution)?.builtIn)?.actions;
  for (const step of Array.isArray(actions) ? actions : []) {
    const fields = record(step);
    if (fields?.type === "agent-session") refs.push({ ref: record(fields.modelConfig)?.modelId });
    if (fields?.type === "handoff") refs.push({ ref: fields.targetModelId });
  }
  return refs;
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

/** Refuses a model-picking action whose input names a model by shorthand. */
export function assertActionModelNames(domain: string, action: string, input: unknown): void {
  for (const picked of modelRefsPickedBy(domain, action, input)) {
    throwIfRefused(modelNameRefusal(picked.ref, picked.provider));
  }
}

/** Refuses one model name that is shorthand, for a launch on `provider`. */
export function assertFullModelName(modelRef: string | null | undefined, provider: string): void {
  throwIfRefused(modelNameRefusal(modelRef, provider));
}

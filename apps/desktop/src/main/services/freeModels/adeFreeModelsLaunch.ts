/**
 * What a chat on an ADE Free Model (`shared/adeFreeModels.ts`) needs at
 * launch: the OpenCode provider block that points at this process's relay
 * (`freeModelsRelay.ts`), and the refusals for the places they never run.
 */
import { BRAND } from "../../../shared/brand";
import { ADE_FREE_MODELS, ADE_FREE_OPENCODE_PROVIDER_ID, isAdeFreeModelId } from "../../../shared/adeFreeModels";

/** A chat on an ADE Free Model on a machine with no ADE sign-in. */
export const ADE_FREE_MODELS_SIGN_IN_MESSAGE = `Sign in to ${BRAND.NAME} to use ${BRAND.NAME} Free Models.`;
/** An ADE Free Model asked for in a terminal: a terminal can't show the sponsored cards that pay for it. */
export const ADE_FREE_MODELS_CHAT_ONLY_MESSAGE = `${BRAND.NAME} Free Models are chat-only.`;
/** An automation, a scheduled wake or a helper task asked for one: they run only while someone has the chat open. */
export const ADE_FREE_MODELS_UNWATCHED_MESSAGE =
  `${BRAND.NAME} Free Models run only while you have the chat open in ${BRAND.NAME}, so automations and scheduled wake-ups can't use them. Pick another model for this one.`;

/** The relay registration a provider block is built from. */
export type AdeFreeProviderEndpoint = { baseURL: string; apiKey: string };

type AdeFreeOpenCodeModel = {
  name: string;
  limit: { context: number; output: number };
  capabilities: { tools: boolean; input: string[]; output: string[] };
};

export type AdeFreeOpenCodeProviderBlock = {
  package: string;
  name: string;
  settings: { baseURL: string; apiKey: string };
  models: Record<string, AdeFreeOpenCodeModel>;
};

/**
 * OpenCode's `ade-free` provider for one chat. Every ADE Free Model is
 * listed, with ADE's window guesses so OpenCode compacts in time, and text
 * input only (OpenCode's default would offer images).
 *
 * OpenCode 2.x keys (`package`, `settings`), as `addCustomProviders` writes
 * them: in ADE's `providers` config, the pinned 2.0.29 binary refuses a
 * provider outside its catalog given 1.x keys (`npm`, `options`) with
 * "Unsupported package". Checked end to end on 2026-11-27.
 */
export function adeFreeOpenCodeProviderBlock(endpoint: AdeFreeProviderEndpoint): AdeFreeOpenCodeProviderBlock {
  return {
    package: "@opencode/ai/providers/openai-compatible",
    name: `${BRAND.NAME} Free Models`,
    settings: { baseURL: endpoint.baseURL, apiKey: endpoint.apiKey },
    models: Object.fromEntries(ADE_FREE_MODELS.map((model) => [model.alias, {
      name: model.displayName,
      limit: { context: model.contextWindow, output: model.maxOutputTokens },
      capabilities: {
        tools: model.capabilities.tools,
        input: model.capabilities.vision ? ["text", "image"] : ["text"],
        output: ["text"],
      },
    }])),
  };
}

/** Whether an OpenCode provider id is the ADE Free Models one. */
export function isAdeFreeOpenCodeProvider(providerId: string | null | undefined): boolean {
  return providerId?.trim() === ADE_FREE_OPENCODE_PROVIDER_ID;
}

/** Whether any of these terminal arguments names an ADE Free Model (`--model ade-free/<alias>`). */
export function argsNameAdeFreeModel(args: readonly string[]): boolean {
  return args.some((arg) => {
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
    return isAdeFreeModelId(value);
  });
}

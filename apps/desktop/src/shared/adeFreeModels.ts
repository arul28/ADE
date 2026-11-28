/**
 * ADE Free Models: models Gravity hosts and pays for from the sponsored cards
 * shown in the chats that use them. Anyone can pick one, on any plan and any
 * machine; every such chat shows cards. Chat only (a terminal can't show a
 * card), and only in the countries Gravity serves.
 *
 * They run in OpenCode through one OpenAI-compatible provider, `ade-free`,
 * that points at ADE's account server (never at Gravity: the key stays on
 * the server). The account server maps each alias to Gravity's own model id,
 * so a model can change there without an app release.
 *
 * No import of `modelRegistry` here: the registry reads this table.
 * iOS mirrors it in `WorkFreeModels.swift`; keep the two together.
 */

/** The OpenCode provider id every ADE Free Model runs under: `opencode/ade-free/<alias>`. */
export const ADE_FREE_OPENCODE_PROVIDER_ID = "ade-free";

/** The Free page source these rows group under. */
export const ADE_FREE_MODELS_SOURCE_ID = "ade-free";

export type AdeFreeModel = {
  /** The model's name for OpenCode and the account server (`opencode/ade-free/<alias>`). */
  alias: string;
  /** The ADE registry id a chat's `modelId` names. */
  id: string;
  displayName: string;
  /**
   * Gravity publishes no window size, so these are cautious guesses, sent to
   * OpenCode so it compacts in time. The server turns an over-long request
   * into OpenAI's `context_length_exceeded`, which OpenCode compacts on.
   */
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: { tools: boolean; vision: boolean; reasoning: boolean; streaming: boolean };
};

const adeFreeId = (alias: string): string => `opencode/${ADE_FREE_OPENCODE_PROVIDER_ID}/${alias}`;

export const ADE_FREE_MODELS: readonly AdeFreeModel[] = [
  {
    alias: "deepseek-v4.1-flash",
    id: adeFreeId("deepseek-v4.1-flash"),
    displayName: "DeepSeek V4.1 Flash",
    contextWindow: 128_000,
    maxOutputTokens: 32_000,
    capabilities: { tools: true, vision: false, reasoning: true, streaming: true },
  },
  {
    alias: "glm-5.3-flash",
    id: adeFreeId("glm-5.3-flash"),
    displayName: "GLM 5.3 Flash",
    contextWindow: 128_000,
    maxOutputTokens: 32_000,
    capabilities: { tools: true, vision: false, reasoning: true, streaming: true },
  },
];

const BY_ALIAS = new Map(ADE_FREE_MODELS.map((model) => [model.alias, model]));
const BY_ID = new Map(ADE_FREE_MODELS.map((model) => [model.id, model]));

export function adeFreeModelByAlias(alias: string | null | undefined): AdeFreeModel | null {
  return (alias && BY_ALIAS.get(alias.trim())) || null;
}

/**
 * The ADE Free Model a model id names: the registry id
 * (`opencode/ade-free/<alias>`) or OpenCode's own (`ade-free/<alias>`).
 */
export function adeFreeModelById(modelId: string | null | undefined): AdeFreeModel | null {
  const id = modelId?.trim();
  if (!id) return null;
  const direct = BY_ID.get(id);
  if (direct) return direct;
  const prefix = `${ADE_FREE_OPENCODE_PROVIDER_ID}/`;
  return id.startsWith(prefix) ? adeFreeModelByAlias(id.slice(prefix.length)) : null;
}

export function isAdeFreeModelId(modelId: string | null | undefined): boolean {
  return adeFreeModelById(modelId) !== null;
}

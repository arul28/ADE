/**
 * Free models: models a person can chat with without any paid plan, account
 * or key. The model picker's Free page lists them, a computer with nothing
 * signed in starts new chats on one, and a new person's sign-in strip offers
 * them.
 *
 * Two sources: OpenCode Zen's free tier (no account, no key, served only to
 * OpenCode, `modelOnlyRunsInOpenCode`), and ADE Free Models (`adeFreeModels.ts`:
 * Gravity's models, paid for by the sponsored cards in their chats, so they
 * carry the `ad-supported` badge).
 *
 * iOS mirrors these rules in `WorkFreeModels.swift`; keep the two together.
 */
import { ADE_FREE_MODELS_SOURCE_ID, ADE_FREE_OPENCODE_PROVIDER_ID, adeFreeModelByAlias } from "./adeFreeModels";
import { modelOnlyRunsInOpenCode } from "./harnessRoutes";

/** The tag a Free page row shows. */
export type FreeModelBadge = "free" | "ad-supported";

export const FREE_MODEL_BADGE_LABELS: Record<FreeModelBadge, string> = {
  free: "Free",
  "ad-supported": "Ad-supported",
};

/** Where a free model comes from. Each source is one group (tab) on the Free page. */
export type FreeModelSourceId = "opencode-zen" | typeof ADE_FREE_MODELS_SOURCE_ID | (string & {});

export const FREE_MODEL_SOURCE_LABELS: Record<string, string> = {
  "opencode-zen": "OpenCode Zen",
  [ADE_FREE_MODELS_SOURCE_ID]: "ADE Free Models",
};

export function freeModelSourceLabel(source: FreeModelSourceId): string {
  return FREE_MODEL_SOURCE_LABELS[source] ?? source;
}

/** One model's place on the Free page. */
export type FreeModelEntry = {
  source: FreeModelSourceId;
  badge: FreeModelBadge;
};

/** The descriptor fields the rule reads, so callers need not pass a full descriptor. */
export type FreeModelCandidate = {
  id: string;
  openCodeProviderId?: string | null;
  openCodeModelId?: string | null;
};

const OPENCODE_REGISTRY_PREFIX = "opencode/";

/**
 * The OpenCode provider and model of a registry id (`opencode/<provider>/<model>`),
 * for a caller that has only the id.
 */
function openCodeParts(model: FreeModelCandidate): { provider: string; model: string } | null {
  if (model.openCodeProviderId && model.openCodeModelId) {
    return { provider: model.openCodeProviderId, model: model.openCodeModelId };
  }
  if (!model.id.startsWith(OPENCODE_REGISTRY_PREFIX)) return null;
  const rest = model.id.slice(OPENCODE_REGISTRY_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { provider: rest.slice(0, slash), model: rest.slice(slash + 1) };
}

/** The Free page row for a model, or null when the model is not free. */
export function freeModelEntry(model: FreeModelCandidate): FreeModelEntry | null {
  const parts = openCodeParts(model);
  if (parts?.provider === ADE_FREE_OPENCODE_PROVIDER_ID) {
    return adeFreeModelByAlias(parts.model) ? { source: ADE_FREE_MODELS_SOURCE_ID, badge: "ad-supported" } : null;
  }
  if (parts && modelOnlyRunsInOpenCode(parts.provider, parts.model)) {
    return { source: "opencode-zen", badge: "free" };
  }
  return null;
}

export function isFreeModel(model: FreeModelCandidate): boolean {
  return freeModelEntry(model) !== null;
}

/**
 * The same rule for a bare model id: a registry id (`opencode/opencode/big-pickle`)
 * or OpenCode's own `<provider>/<model>` (`opencode/big-pickle`), as a runtime
 * reports a settled turn's model.
 */
export function isFreeModelId(modelId: string | null | undefined): boolean {
  const id = modelId?.trim();
  if (!id) return false;
  if (isFreeModel({ id })) return true;
  // OpenCode's own id has one slash; a registry id the rule above declined
  // is not read again as one.
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1 || id.includes("/", slash + 1)) return false;
  return isFreeModel({ id, openCodeProviderId: id.slice(0, slash), openCodeModelId: id.slice(slash + 1) });
}

/** A free model that shows sponsored cards in its chats: never picked for a person who didn't choose it. */
export function isAdSupportedFreeModelId(modelId: string | null | undefined): boolean {
  const id = modelId?.trim();
  return Boolean(id) && freeModelEntry({ id: id! })?.badge === "ad-supported";
}

/**
 * The free model a new chat starts on when nothing is signed in: the first of
 * `preferred` (the model manifest's `defaults.free`) that is listed now, else
 * the first listed free model. Zen's free models come and go, so a preferred
 * id that left the list never strands a new person on a model that is gone.
 * Ad-supported models are never picked here: their chats show cards, which
 * the person agrees to when they pick one themselves.
 */
export function pickFreeDefaultModelId(
  freeModelIds: readonly string[],
  preferred: readonly string[],
): string | null {
  const candidates = freeModelIds.filter((id) => !isAdSupportedFreeModelId(id));
  for (const id of preferred) {
    if (candidates.includes(id)) return id;
  }
  return candidates[0] ?? null;
}

export { FREE_MODEL_FALLBACK_DEFAULT_ID, getFreeModelDefaultIds } from "./modelRegistry";

/**
 * Free models: models a person can chat with without any paid plan, account
 * or key. The model picker's Free page lists them, a computer with nothing
 * signed in starts new chats on one, and a new person's sign-in strip offers
 * them.
 *
 * Today there is one source, OpenCode Zen's free tier: no account, no key,
 * served only to OpenCode (`modelOnlyRunsInOpenCode`). The row shape carries a
 * source and a badge so other sources (ad-supported ones included) add rows
 * without changing the page.
 *
 * iOS mirrors these rules in `WorkFreeModels.swift`; keep the two together.
 */
import { modelOnlyRunsInOpenCode } from "./harnessRoutes";

/** The tag a Free page row shows. */
export type FreeModelBadge = "free" | "ad-supported";

export const FREE_MODEL_BADGE_LABELS: Record<FreeModelBadge, string> = {
  free: "Free",
  "ad-supported": "Ad-supported",
};

/** Where a free model comes from. Each source is one group (tab) on the Free page. */
export type FreeModelSourceId = "opencode-zen" | (string & {});

export const FREE_MODEL_SOURCE_LABELS: Record<string, string> = {
  "opencode-zen": "OpenCode Zen",
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
  if (parts && modelOnlyRunsInOpenCode(parts.provider, parts.model)) {
    return { source: "opencode-zen", badge: "free" };
  }
  return null;
}

export function isFreeModel(model: FreeModelCandidate): boolean {
  return freeModelEntry(model) !== null;
}

/**
 * The free model a new chat starts on when nothing is signed in: the first of
 * `preferred` (the model manifest's `defaults.free`) that is listed now, else
 * the first listed free model. Zen's free models come and go, so a preferred
 * id that left the list never strands a new person on a model that is gone.
 */
export function pickFreeDefaultModelId(
  freeModelIds: readonly string[],
  preferred: readonly string[],
): string | null {
  for (const id of preferred) {
    if (freeModelIds.includes(id)) return id;
  }
  return freeModelIds[0] ?? null;
}

export { FREE_MODEL_FALLBACK_DEFAULT_ID, getFreeModelDefaultIds } from "./modelRegistry";

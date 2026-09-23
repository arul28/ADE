import { getModelById, resolveModelAlias } from "../../../shared/modelRegistry";

/**
 * Whether a turn's served model is a different model from the one ADE asked
 * for, or only another spelling of it.
 *
 * Runtimes report the model that answered in their own spelling: a vendor or
 * harness prefix (`anthropic/`, `opencode/openai/`), a context tier
 * (`claude-opus-5-5[1m]`), a dated snapshot (`claude-haiku-4-5-20251001`), a
 * build or effort variant (`grok-4.5-build`, `gpt-5.4-high`), a Factory
 * `custom:` id, or `.` for `-` in a version. None of those is a different
 * model. A router pick (`auto`) is never a mismatch either: the user asked
 * the provider to choose.
 */

/** Trailing name parts that mark a variant of one model, not another model. */
const VARIANT_TAGS = new Set([
  "1m",
  "api",
  "latest",
  "preview",
  "build",
  "fast",
  "thinking",
  "reasoning",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode",
]);

/** Requested ids that ask the provider to pick the model. */
const ROUTER_PICKS = new Set(["auto", "default", "router"]);

/** The model's name with every spelling-only difference taken out. */
export function modelIdentityKey(model: string): string {
  let key = model.trim().toLowerCase();
  key = key.slice(key.lastIndexOf("/") + 1).replace(/^custom:/u, "");
  key = key.replace(/\[[^\]]*\]$/u, "");
  key = key.replace(/[-@](?:\d{8}|\d{4}-\d{2}-\d{2})$/u, "");
  key = key.replace(/[._:\s]+/gu, "-");
  const parts = key.split("-").filter(Boolean);
  while (parts.length > 1 && VARIANT_TAGS.has(parts[parts.length - 1]!)) parts.pop();
  return parts.join("-");
}

function registryId(model: string): string | null {
  return (getModelById(model) ?? resolveModelAlias(model))?.id ?? null;
}

/**
 * True when `served` names a different model than `requested`. False for a
 * spelling or variant of the same model, for a router pick, and when either
 * side is missing.
 */
export function isServedModelMismatch(requested: string | null | undefined, served: string | null | undefined): boolean {
  const asked = requested?.trim();
  const answered = served?.trim();
  if (!asked || !answered) return false;
  const askedKey = modelIdentityKey(asked);
  if (!askedKey || ROUTER_PICKS.has(askedKey)) return false;
  if (askedKey === modelIdentityKey(answered)) return false;
  const askedId = registryId(asked);
  return !askedId || askedId !== registryId(answered);
}

function normalizedUpstream(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/**
 * True when a turn ran on another route than the one ADE asked for.
 *
 * A route is an upstream plus a model. When both upstreams are known and they
 * differ, the turn ran on another paid route even under the same model name
 * (`openrouter` and `anthropic` both serve `claude-sonnet-5`), so that is
 * always a mismatch. Otherwise the model names decide
 * (`isServedModelMismatch`).
 */
export function isServedRouteMismatch(args: {
  requested: string | null | undefined;
  served: string | null | undefined;
  requestedUpstream?: string | null;
  servedUpstream?: string | null;
}): boolean {
  const askedUpstream = normalizedUpstream(args.requestedUpstream);
  const answeredUpstream = normalizedUpstream(args.servedUpstream);
  if (askedUpstream && answeredUpstream && askedUpstream !== answeredUpstream) return true;
  return isServedModelMismatch(args.requested, args.served);
}

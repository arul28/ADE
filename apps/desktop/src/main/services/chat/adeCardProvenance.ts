/**
 * Plugin attribution for `chat.emitAdeCard`, stamped by the host.
 *
 * `emitAdeCard` is reachable from three untrusted callers once it is on the
 * action allowlist — an agent through `run_ade_action`, an automation step
 * through the automation action bridge, and a plugin child through
 * `sdk.actions.invoke`. All three hand the host a plain JSON object. If
 * attribution travelled in that object, any of them could write
 * `authoredBy: { pluginId: "ade-linear" }` onto a card it wrote itself, and a
 * card that carries a plugin's name is exactly the thing a reader trusts.
 *
 * So attribution does not travel in the arguments at all. It travels on a
 * module-private symbol attached to the argument object by the ONE bridge that
 * knows which plugin is calling (`bootstrap.ts`'s `invokeAdeAction`, whose
 * `pluginId` comes from the supervisor that owns the child socket, not from the
 * call). A symbol survives an in-process function call and cannot survive
 * `JSON.parse` — which is precisely the boundary the untrusted callers sit on —
 * and a module-private one cannot be reconstructed by `Symbol.for` either.
 *
 * The property is non-enumerable so it does not leak into anything that spreads
 * or serializes the args on the way through.
 */

import { normalizeAdeCardAuthor, type AdeCardAuthor } from "../../../shared/adeCard";

const TRUSTED_AUTHOR = Symbol("ade.card.trustedAuthor");

/**
 * Attach host-verified attribution to an action's arguments.
 *
 * Returns a copy: the caller's object may be the plugin's own decoded payload,
 * and mutating it would put the stamp somewhere a retry could observe it.
 */
export function withTrustedAdeCardAuthor<T extends Record<string, unknown>>(
  args: T,
  author: AdeCardAuthor,
): T {
  const normalized = normalizeAdeCardAuthor(author);
  if (!normalized) return args;
  const copy = { ...args } as T;
  Object.defineProperty(copy, TRUSTED_AUTHOR, {
    value: normalized,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return copy;
}

/** The attribution a trusted bridge stamped, or null for every other caller. */
export function readTrustedAdeCardAuthor(args: unknown): AdeCardAuthor | null {
  if (!args || typeof args !== "object") return null;
  return normalizeAdeCardAuthor((args as Record<symbol, unknown>)[TRUSTED_AUTHOR]);
}

/**
 * The narrowing primitives every plugin contract module reads untrusted JSON
 * with.
 *
 * Manifests, wire frames, CRR rows and plugin payloads all arrive as `unknown`
 * and all need the same six questions answered. Before this module each file
 * answered them itself — thirteen copies of `isRecord`, four bounded-string
 * readers with three different ideas of what "too long" does, three finite-number
 * checks and four ways of spelling enum membership. The duplication was not the
 * cost; the divergence was: one reader truncated where its neighbour rejected,
 * so the same manifest parsed differently depending on which layer read it.
 *
 * Deliberately domain-free. It knows nothing about plugins, sockets or
 * surfaces — those closed lists live beside the types they guard (see
 * `isPluginSocketKind` in `sockets.ts`) so this module stays a leaf with no
 * imports and no import cycles.
 *
 * The two string readers are NOT interchangeable, and the choice is the whole
 * reason both exist:
 *
 * - {@link bounded} REJECTS an over-long value. Use it where length is part of
 *   validity — a payload field with a documented ceiling, where silently
 *   shortening the author's text would ship a lie to the screen.
 * - {@link truncated} SHORTENS it. Use it where the value is descriptive and a
 *   long one should still render — a title, a tooltip — and dropping it
 *   entirely would blank the surface over a cosmetic problem.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Trimmed, non-empty, unbounded. `null` for everything else. */
export function trimmed(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

/** Trimmed and non-empty, or `null` — including when it exceeds `max`. */
export function bounded(value: unknown, max: number): string | null {
  const text = trimmed(value);
  if (text === null) return null;
  return text.length <= max ? text : null;
}

/** Trimmed and non-empty, cut to `max` characters rather than refused. */
export function truncated(value: unknown, max: number): string | null {
  const text = trimmed(value);
  if (text === null) return null;
  return text.length <= max ? text : text.slice(0, max);
}

/** A real number. Rejects NaN and both infinities, which JSON can carry. */
export function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Membership in a closed list, narrowed to the list's own element type.
 *
 * Written against `readonly T[]` so a `as const` tuple keeps its literal union:
 * `oneOf(raw.kind, PLUGIN_SOCKET_KINDS)` returns `PluginSocketKind | null` with
 * no cast at the call site, which is the point — every cast this replaces was a
 * place where a wrong string would have been believed.
 */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

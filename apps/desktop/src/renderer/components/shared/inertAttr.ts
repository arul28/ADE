/**
 * `inert` for React 18, which has no boolean prop for it.
 *
 * React 19 types `inert` as a boolean; on 18 the only way through is the raw
 * attribute, and `inert=""` is what the HTML spec asks for. Spread rather than
 * written inline so the cast lives in exactly one place.
 */
export const INERT_ATTR: Record<string, string> = { inert: "" };

/**
 * The three pure helpers the compiled Cursor Cloud kept in
 * `renderer/lib/cursorCloudUtils.ts`, moved rather than rewritten.
 *
 * Everything ELSE in that file stayed behind, and the split is not arbitrary:
 * what moved is what turns a value the child already sent into a class name or
 * a boolean. What did not move is everything that reads a clock
 * (`formatCursorCloudAge`), parses a URL (`cursorCloudRepoLabel`) or unwraps an
 * Electron error (`cursorCloudErrorMessage`) — the child does all three now, so
 * a phone and a Mac looking at the same agent print the same words.
 */

/**
 * Superset tone map for cloud-agent status pills across cloud surfaces.
 *
 * Copied character for character from `cursorCloudStatusToneClass`, including
 * the statuses this page can never receive (`completed`, `failed`). They are
 * Cursor's own vocabulary rather than ADE's, and an API that starts sending one
 * should tint the pill rather than fall through to the neutral tone.
 */
export function cursorCloudStatusToneClass(status: string | undefined | null): string {
  const s = (status ?? "").toLowerCase();
  if (s === "running") return "border-violet-300/30 bg-violet-500/10 text-violet-100/85";
  if (s === "creating") return "border-sky-300/25 bg-sky-500/10 text-sky-100/80";
  if (s === "finished" || s === "completed") return "border-emerald-400/22 bg-emerald-500/8 text-emerald-100/80";
  if (s === "error" || s === "failed" || s === "expired") return "border-red-400/22 bg-red-500/8 text-red-200/85";
  if (s === "cancelled") return "border-white/[0.10] bg-white/[0.03] text-fg/45";
  if (s === "archived") return "border-white/[0.08] bg-transparent text-fg/40";
  return "border-white/[0.08] bg-white/[0.025] text-fg/55";
}

/**
 * Which project secrets a cloud run may be handed.
 *
 * `CURSOR_*` is excluded because Cursor's own environment already carries it,
 * and injecting a second copy of the key the run authenticated with is how a
 * reader's personal token ends up in an environment they did not choose. The
 * child filters as well; this is the same predicate so the checkbox list and
 * the launch agree about the count.
 */
export function isInjectableCloudSecretName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && !trimmed.toUpperCase().startsWith("CURSOR_");
}

/**
 * An artifact's size, as a plain count.
 *
 * Deliberately not a KB/MB ladder. The compiled surfaces never drew artifact
 * sizes at all, so there is no rounding rule to match, and inventing one would
 * be the page deciding that 1,024 is a kilobyte on a screen where the child
 * decides everything else.
 */
export function artifactSizeLabel(bytes: number | null): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null;
  return `${bytes.toLocaleString()} bytes`;
}

/** The accent the compiled surfaces painted every live Cursor thing with. */
export const CURSOR_VIOLET = "#A78BFA";

/** The `creating` dot, which is sky rather than violet: it is not running yet. */
export const CURSOR_CREATING_SKY = "#7DD3FC";

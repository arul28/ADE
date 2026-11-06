/**
 * What ADE names a new lane's branch: a pattern saved with the project's
 * new-lane defaults (`ade/{slug}` unless the user changed it), rendered on the
 * lane's machine. One module so the brain, the New lane dialog, Settings and
 * the CLI agree on every name. Leaf module: no services.
 *
 * - `{slug}`  the lane name, lower-cased, words joined by `-`. Always last.
 * - `{user}`  git `user.name` on the lane's machine, slugged ("Arul Sharma" → `arul-sharma`).
 *
 * The text before `{slug}` is the prefix. Auto-create lanes start on
 * `<prefix><8 hex>` and are renamed to `<prefix><title slug>` once named.
 */

export const DEFAULT_LANE_BRANCH_PATTERN = "ade/{slug}";
export const LANE_BRANCH_SLUG_TOKEN = "{slug}";
export const LANE_BRANCH_USER_TOKEN = "{user}";
/** Longest rendered branch name. Windows keeps each ref as a file under `.git/refs`. */
export const LANE_BRANCH_NAME_MAX_CHARS = 100;
const LANE_BRANCH_PATTERN_MAX_CHARS = 60;
const SLUG_MAX_CHARS = 60;

/** The branch ADE made for an auto-create lane before patterns existed. */
const LEGACY_TEMPORARY_BRANCH_RE = /^ade\/[0-9a-f]{8}$/u;

// Device names Windows refuses as a file name, with or without an extension.
const WINDOWS_RESERVED_SEGMENT_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

/** Lower-case words joined by `-`: `Fix login bug` → `fix-login-bug`. Empty when nothing is left. */
export function laneBranchSlug(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_CHARS)
    .replace(/-+$/g, "");
}

/**
 * A string made into a branch name git and every OS accept, or "" when nothing
 * usable is left. Strips what `git check-ref-format` refuses, plus what
 * Windows cannot store as a file (`< > " |`, device names such as `con`,
 * trailing dots and spaces), and caps the length.
 */
export function sanitizeBranchName(input: string | null | undefined): string {
  const flat = String(input ?? "")
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^origin\//, "")
    .replace(/@\{/g, "-")
    // eslint-disable-next-line no-control-regex
    .replace(/[\\~^:?*[\]\s<>"|\u0000-\u001f\u007f]+/g, "-")
    .replace(/\.\.+/g, "-");
  const segments = flat
    .split("/")
    .map((segment) => {
      let next = segment.replace(/^[.-]+/, "").replace(/[.\s]+$/, "").replace(/\.lock$/i, "").replace(/-{2,}/g, "-");
      next = next.replace(/[.\s]+$/, "");
      // `con` → `con_`, `nul.txt` → `nul_.txt`: Windows reads the name before the first dot.
      if (WINDOWS_RESERVED_SEGMENT_RE.test(next)) next = next.replace(/^([^.]+)/, "$1_");
      return next;
    })
    .filter(Boolean);
  let name = segments.join("/");
  if (name === "@") return "";
  if (name.length > LANE_BRANCH_NAME_MAX_CHARS) {
    name = name.slice(0, LANE_BRANCH_NAME_MAX_CHARS);
  }
  return name.replace(/[./\s-]+$/g, "").replace(/\.lock$/i, "");
}

/** Why a branch name typed by the user cannot be used as-is, or null when it can. */
export function branchNameProblem(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return "Enter a branch name.";
  const clean = sanitizeBranchName(trimmed);
  if (!clean) return `"${trimmed}" can't be used as a branch name.`;
  if (clean !== trimmed) return `Branch names can't contain that. Try "${clean}".`;
  return null;
}

/** A saved pattern, or the default for anything missing or unusable (older saved settings have none). */
export function normalizeLaneBranchPattern(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_LANE_BRANCH_PATTERN;
  const trimmed = value.trim();
  return laneBranchPatternProblem(trimmed) ? DEFAULT_LANE_BRANCH_PATTERN : trimmed;
}

/** The pattern's prefix with `{user}` filled in: `ade/`, `arul-sharma/`, or "". */
export function renderLaneBranchPrefix(pattern: string, user: string | null | undefined): string {
  const normalized = normalizeLaneBranchPattern(pattern);
  const prefix = normalized.slice(0, normalized.length - LANE_BRANCH_SLUG_TOKEN.length);
  const userSlug = laneBranchSlug(user) || "user";
  return prefix.split(LANE_BRANCH_USER_TOKEN).join(userSlug).replace(/^\/+/, "");
}

/**
 * Why a pattern cannot be saved, or null when it can. The machine that saves
 * it also checks the prefix against its existing branches.
 */
export function laneBranchPatternProblem(pattern: string): string | null {
  const trimmed = pattern.trim();
  if (!trimmed.endsWith(LANE_BRANCH_SLUG_TOKEN)) return "End the pattern with {slug}, the lane name.";
  if (trimmed.length > LANE_BRANCH_PATTERN_MAX_CHARS) return `Keep the pattern under ${LANE_BRANCH_PATTERN_MAX_CHARS} characters.`;
  const prefix = trimmed.slice(0, trimmed.length - LANE_BRANCH_SLUG_TOKEN.length);
  const literal = prefix.split(LANE_BRANCH_USER_TOKEN).join("user");
  if (/[{}]/.test(literal)) return "Use only {user} and {slug} in the pattern.";
  if (!literal) return null;
  // The prefix must survive the sanitizer unchanged, or every branch would differ from the preview.
  const sample = `${literal}x`;
  if (sanitizeBranchName(sample) !== sample) return "The prefix has characters a branch name can't contain.";
  return null;
}

/** A new lane's branch from the pattern's rendered prefix and the lane name. */
export function renderLaneBranchName(prefix: string, laneName: string): string {
  return sanitizeBranchName(`${prefix}${laneBranchSlug(laneName) || "lane"}`) || "lane";
}

/** The placeholder branch an auto-create lane starts on: `<prefix><8 hex>`. */
export function temporaryLaneBranchName(prefix: string, hex: string): string {
  return `${prefix}${hex.toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 8)}`;
}

/** Shaped like the current pattern's placeholder. Alone this is not proof: see the brain's marker. */
export function looksLikeTemporaryLaneBranch(branch: string, prefix: string): boolean {
  if (!branch.startsWith(prefix)) return false;
  return /^[0-9a-f]{8}$/u.test(branch.slice(prefix.length));
}

/** ADE's own placeholder from before patterns: `ade/<8 hex>`. */
export function isLegacyTemporaryLaneBranch(branch: string): boolean {
  return LEGACY_TEMPORARY_BRANCH_RE.test(branch);
}

/**
 * The existing branch a new name clashes with, or null. Compared without case,
 * because Windows and macOS file systems fold it, and as paths: `arul/x`
 * cannot be made while a branch `arul` exists, nor `arul` while `arul/x`
 * does (git's "cannot lock ref").
 *
 * `existing` holds plain names (no `refs/heads/` or `origin/`).
 */
export function branchNameClash(candidate: string, existing: Iterable<string>): string | null {
  const key = candidate.toLowerCase();
  for (const name of existing) {
    const other = name.toLowerCase();
    if (other === key || key.startsWith(`${other}/`) || other.startsWith(`${key}/`)) return name;
  }
  return null;
}

/** The sentence for a new name that clashes with `clash` (see {@link branchNameClash}). */
export function branchNameClashMessage(branchName: string, clash: string): string {
  if (clash === branchName) {
    return `Branch "${branchName}" already exists locally or on the remote. Choose a different branch name.`;
  }
  if (clash.toLowerCase() === branchName.toLowerCase()) {
    return `Branch "${clash}" already exists. Names that differ only in case clash on Windows and macOS. Choose a different branch name.`;
  }
  return `Branch "${branchName}" can't sit next to the existing branch "${clash}": git can't make one a folder of the other. Choose a different branch name.`;
}

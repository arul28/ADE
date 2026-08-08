import type { ExternalSessionSummary } from "./types/externalSessions";

export type ImportTarget = "cli" | "chat";
export type ImportMode = "resume" | "fork";

export type ImportAffordanceKind =
  | "resume-here"
  | "resume-in-place"
  | "fork-into-lane"
  | "open-as-chat"
  | "fork-as-chat";

export type ImportAffordance = {
  kind: ImportAffordanceKind;
  label: string;
  description: string;
  target: ImportTarget;
  mode: ImportMode;
  hero: boolean;
  enabled: boolean;
  disabledReason?: string;
  hint?: string;
  foreignCwd?: string | null;
};

const PROVIDER_LABELS: Record<ExternalSessionSummary["provider"], string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  droid: "Droid",
  opencode: "OpenCode",
  pi: "Pi",
};

const CONTINUE_CLI_DESCRIPTION =
  "Continues the same session as a CLI terminal in this lane. Takes over the session — don't run it elsewhere at the same time.";
const COPY_CLI_DESCRIPTION =
  "Starts a copy of this session as a CLI terminal in this lane. The original session is left untouched.";

/**
 * Collapse the user's home directory to `~`, in the absence of an injected
 * abbreviator. `HOME` is not set on Windows — `USERPROFILE` is — and the two
 * sides of the comparison can disagree on separator AND on case (a cwd recorded
 * as `c:\users\me\dev\ade` against `USERPROFILE=C:\Users\me`), so both are
 * normalized and folded before matching. The slice runs against the ORIGINAL
 * string so the answer keeps the real casing.
 *
 * Folded unconditionally rather than per-platform like `pathComparisonKey`:
 * this module is shared with the sandboxed renderer, where `process.platform`
 * is not readable. The Linux cost is a cwd that differs from `$HOME` only by
 * case being abbreviated anyway — two such directories would have to both
 * exist, and the only consequence is a cosmetically wrong label in a row.
 */
function defaultAbbreviateHome(value: string): string {
  const rawHome =
    (typeof process !== "undefined"
      && (process.env?.HOME || process.env?.USERPROFILE))
    || (globalThis as { __ADE_HOME__?: string }).__ADE_HOME__
    || "";
  if (!rawHome) return value;
  const trimmedHome = rawHome.replace(/[\\/]+$/, "");
  const home = trimmedHome.replace(/\\/g, "/").toLowerCase();
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  if (normalized !== home && !normalized.startsWith(`${home}/`)) return value;
  return `~${value.slice(trimmedHome.length)}`;
}

export type ShortenExternalSessionCwdOptions = {
  /** Trailing path segments to keep. */
  maxSegments?: number;
  /**
   * How to collapse the home directory. The renderer passes
   * `renderer/lib/pathUtils.abbreviateHome` so there is one definition of what
   * `~` means; the default above covers the main process and the CLI.
   */
  abbreviateHome?: (value: string) => string;
};

/**
 * A path short enough to sit in a row without hiding the part that identifies
 * it — the repo folder at the end.
 *
 * Windows paths are the reason the separator is detected rather than assumed:
 * splitting `C:\Users\me\dev\ade` on "/" yields one segment, so the
 * "already short enough" check passed for every Windows path and the full
 * string went out untouched, to be clipped from the right by CSS instead.
 */
export function shortenExternalSessionCwd(
  cwd: string | null | undefined,
  options: ShortenExternalSessionCwdOptions = {},
): string {
  if (!cwd) return "its original folder";
  const maxSegments = options.maxSegments ?? 3;
  const abbreviate = options.abbreviateHome ?? defaultAbbreviateHome;

  const displayPath = abbreviate(cwd);
  // Read the separator off the original: `abbreviateHome` normalizes to "/"
  // when it matches, and a Windows path rejoined with "/" is still readable
  // but no longer copy-pasteable, and reads as a foreign OS.
  const separator = cwd.includes("\\") ? "\\" : "/";
  const segments = displayPath.split(/[\\/]/).filter(Boolean);
  if (segments.length <= maxSegments) return displayPath;
  return `…${separator}${segments.slice(-maxSegments).join(separator)}`;
}

export function externalSessionImportAffordances(
  summary: ExternalSessionSummary,
): ImportAffordance[] {
  const cap = summary.capabilities;
  const cwdMatches = summary.cwdMatchesRequestedLane === true;
  const provider = PROVIDER_LABELS[summary.provider];
  const actions: ImportAffordance[] = [];

  if (cap.importToChat) {
    if (cwdMatches || cap.resumeInDifferentCwd) {
      actions.push({
        kind: "open-as-chat",
        label: "Continue as ADE chat",
        description:
          "Continues the original provider session as a native ADE chat. Imported history is shown here; very large histories include a truncation notice.",
        target: "chat",
        mode: "resume",
        hero: true,
        enabled: true,
      });
    }
    if ((cwdMatches && cap.fork) || (!cwdMatches && cap.forkIntoDifferentCwd)) {
      actions.push({
        kind: "fork-as-chat",
        label: "Copy as ADE chat",
        description:
          "Creates a provider-backed copy in this lane and imports its history into an ADE chat. The original session stays untouched.",
        target: "chat",
        mode: "fork",
        hero: !actions.some((action) => action.hero),
        enabled: true,
        ...(!cwdMatches
          ? { hint: "The original belongs to another folder, so ADE will copy it into this lane." }
          : {}),
      });
    }
  }

  if (cwdMatches) {
    if (cap.resumeInPlace) {
      actions.push({
        kind: "resume-here",
        label: "Continue as CLI",
        description: CONTINUE_CLI_DESCRIPTION,
        target: "cli",
        mode: "resume",
        hero: false,
        enabled: true,
      });
    }
    if (cap.fork) {
      actions.push({
        kind: "fork-into-lane",
        label: "Copy as CLI",
        description: COPY_CLI_DESCRIPTION,
        target: "cli",
        mode: "fork",
        hero: false,
        enabled: true,
      });
    }
    return actions;
  }

  if (cap.resumeInDifferentCwd) {
    actions.push({
      kind: "resume-here",
      label: "Continue as CLI",
      description: CONTINUE_CLI_DESCRIPTION,
      target: "cli",
      mode: "resume",
      hero: false,
      enabled: true,
    });
    if (cap.forkIntoDifferentCwd) {
      actions.push({
        kind: "fork-into-lane",
        label: "Copy as CLI",
        description: COPY_CLI_DESCRIPTION,
        target: "cli",
        mode: "fork",
        hero: false,
        enabled: true,
      });
    }
    return actions;
  }

  if (cap.forkIntoDifferentCwd) {
    actions.push({
      kind: "fork-into-lane",
      label: "Copy as CLI",
      description: COPY_CLI_DESCRIPTION,
      target: "cli",
      mode: "fork",
      hero: false,
      enabled: true,
      hint: "This session lives in another folder — fork it into this lane instead",
    });
  }
  if (cap.resumeInPlace) {
    actions.push({
      kind: "resume-in-place",
      label: "Continue in original folder",
      description:
        "Continues the same session in its original folder (not this lane) — this provider can only continue a session where it was created.",
      target: "cli",
      mode: "resume",
      hero: false,
      enabled: true,
      foreignCwd: summary.cwd,
    });
  }
  if (!cap.forkIntoDifferentCwd && !cap.resumeInPlace) {
    const description = summary.cwd
      ? `This session lives in another folder and ${provider} can't resume across folders.`
      : `The original folder could not be recovered, so ${provider} cannot safely continue this session.`;
    actions.push({
      kind: "resume-here",
      label: "Continue as CLI",
      description,
      target: "cli",
      mode: "resume",
      hero: false,
      enabled: false,
      disabledReason: description,
    });
  }

  return actions;
}

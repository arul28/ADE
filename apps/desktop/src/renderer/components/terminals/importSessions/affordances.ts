/**
 * Pure capability -> affordance mapping for the import browser.
 *
 * Given one external session summary (its capability flags + how its cwd
 * relates to the target lane), produce exactly the row actions the user should
 * see — no more, no fewer. Kept free of React so it can be unit-tested in
 * isolation (see affordances.test.ts).
 */
import {
  providerDisplayName,
  type ExternalSessionSummary,
} from "./contract";

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
  /**
   * Plain-English explanation of exactly what this action does, shown as the
   * button's tooltip. Spells out the two axes a first-time user can't infer
   * from the label: resume (continue the same session) vs fork (branch a copy),
   * and chat (rendered ADE conversation) vs CLI terminal (raw session).
   */
  description: string;
  target: ImportTarget;
  mode: ImportMode;
  /** True only for the hero "Open as ADE chat" action. */
  hero: boolean;
  /** When false, render disabled and show {@link disabledReason}. */
  enabled: boolean;
  disabledReason?: string;
  /** Inline explanatory hint shown under the action (e.g. cross-folder fork). */
  hint?: string;
  /** The session's own cwd, set on resume-in-place so callers can label it. */
  foreignCwd?: string | null;
};

/** Copy shared across the branches that can emit the same action. */
const OPEN_AS_CLI_DESCRIPTION =
  "Continues the same session as a CLI terminal in this lane. Takes over the session — don't run it elsewhere at the same time.";
const FORK_AS_CLI_DESCRIPTION =
  "Starts a copy of this session as a CLI terminal in this lane. The original session is left untouched.";

/** Collapses `$HOME` to `~` and keeps a recognizable tail of the path. */
export function shortenCwd(cwd: string | null | undefined, maxSegments = 3): string {
  if (!cwd) return "its original folder";
  const home =
    (typeof process !== "undefined" && process.env?.HOME) ||
    (globalThis as { __ADE_HOME__?: string }).__ADE_HOME__ ||
    "";
  let path = cwd;
  if (home && path.startsWith(home)) {
    path = `~${path.slice(home.length)}`;
  }
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= maxSegments) return path;
  const tail = segments.slice(-maxSegments).join("/");
  return `…/${tail}`;
}

/**
 * Returns the ordered list of import actions for a session against the lane the
 * user is importing into. Order: chat actions first (the hero), then CLI.
 */
export function importAffordancesFor(
  summary: ExternalSessionSummary,
): ImportAffordance[] {
  const cap = summary.capabilities;
  // `cwdMatchesRequestedLane` is nullable — treat "unknown" as a non-match so
  // we never offer an in-place resume we can't guarantee is same-folder.
  const cwdMatches = summary.cwdMatchesRequestedLane === true;
  const provider = providerDisplayName(summary.provider);
  const out: ImportAffordance[] = [];

  // --- Chat import (the hero): full history opens in a native ADE chat. ---
  if (cap.importToChat) {
    out.push({
      kind: "open-as-chat",
      label: "Open as ADE chat",
      description:
        "Continues this session as a native ADE chat — the full conversation history opens in a chat pane and you keep going here. (Claude/Codex)",
      target: "chat",
      mode: "resume",
      hero: true,
      enabled: true,
    });
    out.push({
      kind: "fork-as-chat",
      label: "Fork as ADE chat",
      description:
        "Opens a COPY of this session as an ADE chat. The original session stays untouched; you continue on a branch.",
      target: "chat",
      mode: "fork",
      hero: false,
      enabled: true,
    });
  }

  // --- CLI import: resume/fork into (or at) a folder. ---
  if (cwdMatches) {
    // Session already lives in this lane's folder: resume-here IS in-place.
    if (cap.resumeInPlace) {
      out.push({
        kind: "resume-here",
        label: "Open as CLI session",
        description: OPEN_AS_CLI_DESCRIPTION,
        target: "cli",
        mode: "resume",
        hero: false,
        enabled: true,
      });
    }
    if (cap.fork) {
      out.push({
        kind: "fork-into-lane",
        label: "Fork as CLI session",
        description: FORK_AS_CLI_DESCRIPTION,
        target: "cli",
        mode: "fork",
        hero: false,
        enabled: true,
      });
    }
  } else {
    const resumeAcross = cap.resumeInDifferentCwd;
    const forkAcross = cap.forkIntoDifferentCwd;
    if (resumeAcross) {
      // Provider can point the resumed session at this lane's folder.
      out.push({
        kind: "resume-here",
        label: "Open as CLI session",
        description: OPEN_AS_CLI_DESCRIPTION,
        target: "cli",
        mode: "resume",
        hero: false,
        enabled: true,
      });
      if (forkAcross) {
        out.push({
          kind: "fork-into-lane",
          label: "Fork as CLI session",
          description: FORK_AS_CLI_DESCRIPTION,
          target: "cli",
          mode: "fork",
          hero: false,
          enabled: true,
        });
      }
    } else {
      // No cross-folder resume; surface every safe option in priority order.
      // Fork keeps work in this lane, while resume-in-place runs in the
      // original folder.
      if (forkAcross) {
        out.push({
          kind: "fork-into-lane",
          label: "Fork as CLI session",
          description: FORK_AS_CLI_DESCRIPTION,
          target: "cli",
          mode: "fork",
          hero: false,
          enabled: true,
          hint: "This session lives in another folder — fork it into this lane instead",
        });
      }
      if (cap.resumeInPlace) {
        out.push({
          kind: "resume-in-place",
          label: "Open as CLI session",
          description:
            "Continues the same session in its original folder (not this lane) — this provider can only continue a session where it was created.",
          target: "cli",
          mode: "resume",
          hero: false,
          enabled: true,
          foreignCwd: summary.cwd,
        });
      }
      if (!forkAcross && !cap.resumeInPlace) {
        // No CLI path into or at this lane — surface why resume is blocked.
        const blockedReason = `This session lives in another folder and ${provider} can't resume across folders.`;
        out.push({
          kind: "resume-here",
          label: "Open as CLI session",
          description: blockedReason,
          target: "cli",
          mode: "resume",
          hero: false,
          enabled: false,
          disabledReason: blockedReason,
        });
      }
    }
  }

  return out;
}

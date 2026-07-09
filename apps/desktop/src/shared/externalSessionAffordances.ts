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
};

const CONTINUE_CLI_DESCRIPTION =
  "Continues the same session as a CLI terminal in this lane. Takes over the session — don't run it elsewhere at the same time.";
const COPY_CLI_DESCRIPTION =
  "Starts a copy of this session as a CLI terminal in this lane. The original session is left untouched.";

export function shortenExternalSessionCwd(
  cwd: string | null | undefined,
  maxSegments = 3,
): string {
  if (!cwd) return "its original folder";
  const home =
    (typeof process !== "undefined" && process.env?.HOME)
    || (globalThis as { __ADE_HOME__?: string }).__ADE_HOME__
    || "";
  let displayPath = cwd;
  if (home && displayPath.startsWith(home)) {
    displayPath = `~${displayPath.slice(home.length)}`;
  }
  const segments = displayPath.split("/").filter(Boolean);
  if (segments.length <= maxSegments) return displayPath;
  return `…/${segments.slice(-maxSegments).join("/")}`;
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

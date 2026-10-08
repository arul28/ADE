import { CheckCircle, Prohibit, Record } from "@phosphor-icons/react";

export const GITHUB_BRAND = {
  primary: "#58A6FF",
  primaryBright: "#79B8FF",
  primaryDeep: "#1F6FEB",
  surface: "rgba(88, 166, 255, 0.10)",
  surfaceHover: "rgba(88, 166, 255, 0.16)",
  border: "rgba(88, 166, 255, 0.32)",
  borderSubtle: "rgba(88, 166, 255, 0.20)",
  text: "#E6EDF3",
  textMuted: "rgba(230, 237, 243, 0.65)",
} as const;

/** GitHub's own issue state colours: open, closed as completed, closed otherwise. */
export const GITHUB_ISSUE_STATE_COLOR = {
  open: "#3fb950",
  completed: "#a371f7",
  notPlanned: "#8b949e",
} as const;

export function githubIssueStateLabel(state: "open" | "closed", stateReason: string | null | undefined): string {
  if (state === "open") return "Open";
  if (stateReason === "not_planned") return "Closed as not planned";
  if (stateReason === "duplicate") return "Closed as duplicate";
  return "Closed";
}

/** The state glyph GitHub draws: a ringed dot, a check, or a slash. */
export function GitHubIssueStateIcon({
  state,
  stateReason,
  size = 12,
}: {
  state: "open" | "closed";
  stateReason?: string | null;
  size?: number;
}) {
  if (state === "open") {
    return <Record size={size} weight="bold" color={GITHUB_ISSUE_STATE_COLOR.open} aria-hidden className="shrink-0" />;
  }
  if (stateReason === "not_planned" || stateReason === "duplicate") {
    return <Prohibit size={size} weight="bold" color={GITHUB_ISSUE_STATE_COLOR.notPlanned} aria-hidden className="shrink-0" />;
  }
  return <CheckCircle size={size} weight="bold" color={GITHUB_ISSUE_STATE_COLOR.completed} aria-hidden className="shrink-0" />;
}

/**
 * Copy for the Claude `resume_return` dialog.
 *
 * Shared because the sentence is written once and read on four surfaces: the
 * desktop card, the hosted web client, the phone, and `ade code`. All four
 * render the same `PendingInputRequest` the main process built with this
 * helper, so the formatting lives next to the contract rather than in whichever
 * client drew the card first.
 */

/** "2h 25m", "48m", "35s" — never an empty string, so the sentence always reads. */
export function formatClaudeSessionAge(ageMinutes: number): string {
  if (!Number.isFinite(ageMinutes) || ageMinutes <= 0) return "less than a minute";
  const totalMinutes = Math.floor(ageMinutes);
  if (totalMinutes < 1) return "less than a minute";
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  // A trailing "0m" reads as noise next to "2d 3h", but "2h" alone with no
  // minutes is the honest reading when minutes really is zero.
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}

export function formatClaudeTokenCount(estimatedTokens: number): string {
  if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) return "0";
  return Math.floor(estimatedTokens).toLocaleString("en-US");
}

/**
 * The question body for a `resume_return` dialog.
 *
 * Both numbers come from the SDK payload. They are stated rather than judged:
 * ADE does not know this user's budget, and "this session is large" would be a
 * claim the host cannot back.
 */
export function formatClaudeResumeCompactionQuestion(args: {
  ageMinutes: number;
  estimatedTokens: number;
}): string {
  return `This session is ${formatClaudeSessionAge(args.ageMinutes)} old and uses `
    + `${formatClaudeTokenCount(args.estimatedTokens)} tokens. Compact it before continuing?`;
}

/**
 * The three choices, in the order they are offered.
 *
 * `value` is what the handler maps back onto the SDK result vocabulary
 * (`compact` / `continue` / `never`), so the mapping is readable in one place
 * instead of being re-derived from a label string at the far end.
 */
export const CLAUDE_RESUME_RETURN_OPTIONS = [
  {
    label: "Compact and continue",
    value: "compact",
    description: "Resume with a summary and use fewer tokens.",
    recommended: true,
  },
  {
    label: "Keep full history",
    value: "continue",
    description: "Resume without changing the conversation.",
  },
  {
    label: "Don't ask again",
    value: "never",
    description: "Keep full history and skip future resume prompts.",
  },
] as const;

export type ClaudeResumeReturnChoice = (typeof CLAUDE_RESUME_RETURN_OPTIONS)[number]["value"];

/** Map a user's answer (option value or free text) back onto the SDK result. */
export function claudeResumeReturnChoiceFromAnswer(
  answer: string | null | undefined,
): ClaudeResumeReturnChoice | null {
  const normalized = (answer ?? "").trim().toLowerCase();
  if (!normalized.length) return null;
  for (const option of CLAUDE_RESUME_RETURN_OPTIONS) {
    if (normalized === option.value) return option.value;
    if (normalized === option.label.toLowerCase()) return option.value;
  }
  return null;
}

import type { AgentChatSessionSummary } from "../../shared/types";

/**
 * The prompt the lane's "Catch up → Ask an agent" writes into a chat. It is
 * never sent: the user reads it, picks the model and presses Send.
 */
export type LaneCatchUpPromptInput = {
  laneName: string;
  /** The lane's branch, e.g. `feature/login`. */
  branch: string;
  /** The branch the lane catches up with, e.g. `main`. */
  baseBranch: string;
  kind: "behind" | "built_on_merged";
  behindBy: number;
  /** For `built_on_merged`: the PR whose commits are already in the base. */
  mergedPrNumber?: number | null;
  /** Whether the branch is on the remote. Null when not known. */
  pushed?: boolean | null;
  /** The files a scan expects to conflict. */
  conflictingFiles?: readonly string[];
  /** A direct rebase or merge that just failed, with its error. */
  failure?: { action: "rebase" | "merge"; error: string } | null;
};

const MAX_LISTED_FILES = 12;

function pushedLine(pushed: boolean | null | undefined): string | null {
  if (pushed === true) return "This branch has been pushed.";
  if (pushed === false) return "This branch has not been pushed yet.";
  return null;
}

function conflictLine(files: readonly string[] | undefined): string | null {
  if (!files || files.length === 0) return null;
  const shown = files.slice(0, MAX_LISTED_FILES).join(", ");
  const more = files.length > MAX_LISTED_FILES ? `, and ${files.length - MAX_LISTED_FILES} more` : "";
  return `Expect conflicts in ${shown}${more}.`;
}

export function buildLaneCatchUpPrompt(input: LaneCatchUpPromptInput): string {
  const base = input.baseBranch;
  const remoteBase = `origin/${base}`;
  const lane = `lane "${input.laneName}" (branch ${input.branch})`;
  const facts = [pushedLine(input.pushed), conflictLine(input.conflictingFiles)].filter(Boolean).join(" ");
  const failure = input.failure
    ? `ADE tried to ${input.failure.action === "rebase" ? `rebase onto ${remoteBase}` : `merge ${remoteBase} in`} and stopped, leaving the lane as it was:\n${input.failure.error.trim()}`
    : null;

  if (input.kind === "built_on_merged") {
    const pr = input.mergedPrNumber ? `PR #${input.mergedPrNumber}` : "an earlier pull request";
    return [
      `The commits from ${pr} in ${lane} are already in ${base}. Rebase this lane onto ${remoteBase} and drop them, keeping only this lane's own work.`,
      facts || null,
      failure,
      [
        `1. Fetch first (git fetch origin ${base}).`,
        `2. If the branch has never been pushed, rebase onto ${remoteBase}, dropping the commits that came from ${pr} (git rebase --onto ${remoteBase} <the last of them>). If it has been pushed, ask me before rewriting it; merging ${remoteBase} in is the fallback.`,
        "3. Resolve any conflicts by keeping this lane's intent while taking what changed in the base.",
        "4. Run the checks that cover the files you touched.",
        "5. Do not push without asking me.",
      ].join("\n"),
      "Then tell me what you did, each conflict you resolved, and any choice that needed judgment.",
    ].filter(Boolean).join("\n\n");
  }

  const behind = `${input.behindBy} commit${input.behindBy === 1 ? "" : "s"} behind`;
  return [
    `Bring ${lane} up to date with ${remoteBase}; it is ${behind}.`,
    facts || null,
    failure,
    [
      `1. Fetch first (git fetch origin ${base}).`,
      `2. If the branch has never been pushed, rebase it onto ${remoteBase}. If it has been pushed, merge ${remoteBase} into it instead, so its pushed history is not rewritten.`,
      "3. Resolve any conflicts by keeping this lane's intent while taking what changed in the base.",
      "4. Run the checks that cover the files you touched.",
      "5. Do not push without asking me.",
    ].join("\n"),
    "Then tell me whether you rebased or merged, each conflict you resolved, and any choice that needed judgment.",
  ].filter(Boolean).join("\n\n");
}

/** The lane's newest open Work chat: the agent that knows the lane's intent best. */
export function newestLaneWorkChat(sessions: readonly AgentChatSessionSummary[]): AgentChatSessionSummary | null {
  const timestamp = (session: AgentChatSessionSummary): number => {
    const parsed = Date.parse(session.lastActivityAt);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...sessions]
    .filter((session) => (session.surface ?? "work") === "work" && session.archivedAt == null)
    .sort((left, right) => timestamp(right) - timestamp(left))[0] ?? null;
}

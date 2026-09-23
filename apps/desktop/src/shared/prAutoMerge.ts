/**
 * GitHub answers a refused auto-merge with terse GraphQL errors. These turn the
 * known ones into a sentence that says what to do; anything unknown keeps
 * GitHub's own words so nothing is hidden.
 */
export function describeAutoMergeFailure(rawMessage: string, repoLabel: string): string {
  const message = rawMessage.trim();
  const lower = message.toLowerCase();
  if (lower.includes("auto merge is not allowed") || lower.includes("auto-merge is not allowed") || lower.includes("automerge is not allowed")) {
    return `Auto-merge is off for ${repoLabel}. Turn on "Allow auto-merge" in the repository settings, then try again.`;
  }
  if (lower.includes("clean status")) {
    return "This PR can merge now, so GitHub will not arm auto-merge. Merge it instead.";
  }
  if (lower.includes("draft")) {
    return "GitHub cannot arm auto-merge on a draft. Mark the PR ready for review first.";
  }
  if (lower.includes("protected branch rules not configured") || lower.includes("no required")) {
    return "The base branch has no required checks or reviews, so there is nothing for auto-merge to wait for. Merge it instead.";
  }
  if (lower.includes("merge method") && lower.includes("not allowed")) {
    return `That merge method is off for ${repoLabel}. Pick another method.`;
  }
  if (lower.includes("permission") || lower.includes("not authorized") || lower.includes("forbidden")) {
    return `Your GitHub account cannot merge in ${repoLabel}.`;
  }
  return message ? `GitHub refused auto-merge: ${message}` : "GitHub refused auto-merge.";
}

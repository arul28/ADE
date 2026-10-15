import type { GitHubIssueDetail } from "./githubIssueStore";
import { buildGitHubLaunchIssue, githubIssueBranchName, githubIssueKickoffPrompt } from "../../lib/linearBatchLaunch";
import { requestIssueLaunch } from "../../lib/issueLaunchRequests";

/** Compatibility exports for existing GitHub issue launch callers. */
export { githubIssueBranchName, githubIssueKickoffPrompt };

/** Route GitHub issue actions into the app-wide tracker-neutral launcher. */
export function requestGitHubIssueLaunch(issue: GitHubIssueDetail, options: { laneOnly?: boolean } = {}): void {
  const launchIssue = buildGitHubLaunchIssue(issue);
  if (launchIssue) requestIssueLaunch([launchIssue], { laneOnly: options.laneOnly === true });
}

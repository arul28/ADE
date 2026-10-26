import { redactGitOutput } from "../../utils/redaction";
import { markExpected } from "../../../shared/expectedError";
import { formatGitExecutionError, gitCommandError, GitTimeoutError, type GitRunOptions } from "./git";
import { runGitWithGithubAuthFallback } from "./gitTransportAuth";

/**
 * Why a remote refused a `git push`, read from git's output.
 *
 * Git reports a refused ref on its own line (` ! [rejected] main -> main
 * (fetch first)` or ` ! [remote rejected] main -> main (pre-receive hook
 * declined)`), and GitHub adds `remote:` lines with a code such as GH006.
 * Only a `[rejected]` line with `non-fast-forward` or `fetch first` means the
 * remote has commits the lane lacks. A hook, a branch rule, or a credential
 * refusal needs a different fix, so each gets its own sentence. The caller
 * keeps git's raw output under the sentence.
 */
export type GitPushFailureKind =
  | "secret_detected"
  | "workflow_scope"
  | "branch_protected"
  | "repository_rule"
  | "stale_lease"
  | "non_fast_forward"
  | "hook_declined"
  | "remote_rejected"
  | "permission_denied"
  | "auth_failed"
  | "repository_not_found";

export type GitPushFailure = {
  kind: GitPushFailureKind;
  message: string;
};

const REJECTED_LINE = /^\s*!\s*\[rejected\][^\n]*\(([^)\n]*)\)\s*$/im;
const REMOTE_REJECTED_LINE = /^\s*!\s*\[remote rejected\][^\n]*\(([^\n]*)\)\s*$/im;

function branchLabel(branch: string | null | undefined): string {
  const name = (branch ?? "").replace(/^refs\/heads\//, "").trim();
  return name ? `"${name}"` : "this branch";
}

export function classifyGitPushFailure(
  raw: string,
  options: { branch?: string | null } = {},
): GitPushFailure | null {
  const text = raw ?? "";
  if (!text.trim()) return null;
  const branch = branchLabel(options.branch);
  const rejectedReason = text.match(REJECTED_LINE)?.[1]?.trim().toLowerCase() ?? "";
  const remoteRejectedReason = text.match(REMOTE_REJECTED_LINE)?.[1]?.trim() ?? "";
  const remoteRejectedLower = remoteRejectedReason.toLowerCase();

  if (/push cannot contain secrets|GH009: Secrets detected/i.test(text)) {
    return {
      kind: "secret_detected",
      message: `GitHub refused the push to ${branch} because a commit contains what looks like a secret. Remove it from the commits (not only from the latest file), then push again.`,
    };
  }
  if (/refusing to allow an? [^\n]*to create or update workflow/i.test(text)) {
    return {
      kind: "workflow_scope",
      message: `GitHub refused the push to ${branch} because it changes a file in .github/workflows and the credential cannot change workflows. A token needs the "workflow" scope; a GitHub App needs the Workflows repository permission. Use a credential that has it, or push from a terminal that does.`,
    };
  }
  if (/\bGH006\b/.test(text) || remoteRejectedLower.includes("protected branch")) {
    return {
      kind: "branch_protected",
      message: `The remote refused the push because branch protection covers ${branch} (for example, required pull requests or status checks). Push to another branch and open a pull request, or ask a repository admin to change the rule.`,
    };
  }
  // GH013 covers every repository rule, not only branch protection: signed
  // commits, required pull requests, blocked paths, file size. The remote
  // lists the rule it applied, so the sentence does not guess the fix.
  if (/\bGH013\b/.test(text) || remoteRejectedLower.includes("repository rule violations")) {
    return {
      kind: "repository_rule",
      message: `A repository rule refused the push to ${branch}. The remote's output below names the rule and what it needs.`,
    };
  }
  if (rejectedReason === "stale info") {
    return {
      kind: "stale_lease",
      message: `The force push to ${branch} stopped because the remote branch changed since this lane last fetched it. Fetch, check the new remote commits, then force push again if you still want to replace them.`,
    };
  }
  if (rejectedReason === "non-fast-forward" || rejectedReason === "fetch first") {
    return {
      kind: "non_fast_forward",
      message: `The remote branch ${branch} has commits this lane does not have. Pull or rebase this lane, then push again.`,
    };
  }
  if (remoteRejectedLower.includes("hook declined")) {
    return {
      kind: "hook_declined",
      message: `A server-side hook on the remote refused the push to ${branch}. Its reason is in the remote's output below.`,
    };
  }
  if (remoteRejectedReason) {
    return {
      kind: "remote_rejected",
      message: `The remote refused the push to ${branch}: ${remoteRejectedReason}.`,
    };
  }
  if (/Permission to \S+ denied to|returned error: 403|You don't have permission to push/i.test(text)) {
    return {
      kind: "permission_denied",
      message: `The remote refused the push to ${branch} because this credential cannot write to the repository. Check that the account or token has write access.`,
    };
  }
  if (
    /Permission denied \(publickey|Authentication failed for|could not read (Username|Password)|Invalid username or (password|token)|returned error: 401/i.test(text)
  ) {
    return {
      kind: "auth_failed",
      message: "Git could not sign in to the remote. Check your SSH key or Git credentials, then push again.",
    };
  }
  if (/Repository not found|does not appear to be a git repository|returned error: 404/i.test(text)) {
    return {
      kind: "repository_not_found",
      message: "The remote repository was not found, or this credential cannot see it. Check the origin URL and the account's access.",
    };
  }
  return null;
}

type GitPushErrorOptions = {
  branch?: string | null;
  /** Leads the message, for flows that word the failure themselves. */
  prefix?: string;
};

/**
 * The error for a failed push: the classified sentence followed by git's
 * redacted output, or the plain git error when the failure has no known shape.
 * A sign-in failure keeps the plain git error, which has the full sign-in hint.
 */
export function gitPushError(raw: string, options: GitPushErrorOptions = {}): Error {
  const detail = (raw ?? "").trim();
  const failure = classifyGitPushFailure(detail, options);
  const body =
    failure && failure.kind !== "auth_failed"
      ? redactGitOutput(`${failure.message}\n\n${detail}`)
      : formatGitExecutionError(detail);
  return gitCommandError(detail, options.prefix ? `${options.prefix} ${body}` : body);
}

/**
 * Runs `git push …` and throws {@link gitPushError} when it fails. Git's own
 * sign-in goes first; on an https GitHub remote ADE's GitHub credential is
 * tried when that cannot sign in (see gitTransportAuth).
 */
export async function runGitPushOrThrow(
  args: string[],
  opts: GitRunOptions & { branch?: string | null },
): Promise<void> {
  const { branch, ...runOpts } = opts;
  const res = await runGitWithGithubAuthFallback(args, runOpts);
  // Same as runGitOrThrow: a stop or a timeout is not a refusal by the remote.
  if (res.cancelled) throw markExpected(new Error(runOpts.cancelMessage ?? "Git was cancelled."), "user");
  if (res.timedOut) {
    throw new GitTimeoutError(
      runOpts.timeoutMessage ?? formatGitExecutionError(res.stderr.trim() || `git ${args.join(" ")} timed out`),
      res.stalled === true,
    );
  }
  if (res.exitCode === 0) return;
  throw gitPushError(res.stderr.trim() || res.stdout.trim() || `git ${args.join(" ")} failed`, { branch });
}

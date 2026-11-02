import { runReapedCommand } from "../shared/runReapedCommand";

import { resolveGithubRemoteRepo } from "../github/githubSshAlias";
import {
  EMPTY_GH_OPEN_PR_SUMMARY,
  GH_PR_LIST_JSON_FIELDS,
  GH_PR_LIST_LEGACY_JSON_FIELDS,
  selectOwnRepoOpenPr,
  type GhOpenPrSummary,
} from "./ghPrHeadRepo";
import { runGitRepoCached } from "./git";

const GH_PR_LIST_TIMEOUT_MS = 8_000;
/**
 * `--head` matches on branch name across every fork, so the row we want is not
 * necessarily first. Fetch a small page and let the head-repo filter choose.
 */
const GH_PR_LIST_LIMIT = "10";

async function resolveOriginOwner(worktreePath: string): Promise<string | null> {
  // The repo-wide origin URL, shared with every other caller that asks it.
  const result = await runGitRepoCached(
    ["remote", "get-url", "origin"],
    { cwd: worktreePath, timeoutMs: 5_000 },
    { key: "remote-url:origin", cacheClass: "volatile" },
  ).catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  return (await resolveGithubRemoteRepo(result.stdout.trim()))?.owner ?? null;
}

/**
 * Runs `gh pr list`. Resolves the raw JSON on success, `""` when gh ran and
 * exited non-zero (bad flag, not authenticated, not a repo), and `null` when gh
 * could not be run at all or timed out. Callers use that distinction to decide
 * whether a retry with different flags could possibly help.
 */
async function runGhPrList(args: {
  worktreePath: string;
  branch: string;
  fields: string;
}): Promise<string | null> {
  // Reaped: when the keychain hangs, gh exits but its `security` helper stays.
  const result = await runReapedCommand(
    "gh",
    ["pr", "list", "--head", args.branch, "--state", "open", "--json", args.fields, "--limit", GH_PR_LIST_LIMIT],
    { cwd: args.worktreePath, timeoutMs: GH_PR_LIST_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
  );
  // gh missing, not executable, or timed out: no retry can fix that.
  if (result.error) return null;
  return result.exitCode === 0 ? result.stdout : "";
}

/**
 * Find the lane's own open PR for `branch`, ignoring same-named branches that
 * live in somebody else's fork. Never throws — every failure degrades to the
 * empty summary, exactly like the callers' previous inline implementations.
 */
export async function lookupOpenPrForBranch(args: {
  worktreePath: string;
  branch: string;
}): Promise<GhOpenPrSummary> {
  const worktreePath = args.worktreePath.trim();
  const branch = args.branch.trim();
  if (!worktreePath || !branch) return { ...EMPTY_GH_OPEN_PR_SUMMARY };
  try {
    const [expectedOwner, rawJson] = await Promise.all([
      resolveOriginOwner(worktreePath),
      runGhPrList({ worktreePath, branch, fields: GH_PR_LIST_JSON_FIELDS }),
    ]);
    if (rawJson) return selectOwnRepoOpenPr({ rawJson, expectedOwner });
    // null means gh could not run at all — a retry cannot help.
    if (rawJson === null) return { ...EMPTY_GH_OPEN_PR_SUMMARY };
    // Empty means gh ran and exited non-zero. One cause is a CLI too old to know
    // headRepositoryOwner: gh rejects an unknown --json field outright rather
    // than omitting it, which would silently report "no PR" for every lane.
    // Retry once with the legacy field set. Without an owner we cannot verify
    // the head repo, and parseGhPrListEntry treats an absent owner as
    // unverifiable-accept, so this degrades to the pre-filter behavior rather
    // than to nothing. Any other non-zero cause simply fails again, costing one
    // extra spawn behind the caller's existing cache.
    const legacyJson = await runGhPrList({
      worktreePath,
      branch,
      fields: GH_PR_LIST_LEGACY_JSON_FIELDS,
    });
    if (!legacyJson) return { ...EMPTY_GH_OPEN_PR_SUMMARY };
    return selectOwnRepoOpenPr({ rawJson: legacyJson, expectedOwner });
  } catch {
    return { ...EMPTY_GH_OPEN_PR_SUMMARY };
  }
}

import { spawn } from "child_process";

import { parseGithubRemoteUrl } from "../../../shared/githubRemote";
import {
  EMPTY_GH_OPEN_PR_SUMMARY,
  GH_PR_LIST_JSON_FIELDS,
  GH_PR_LIST_LEGACY_JSON_FIELDS,
  selectOwnRepoOpenPr,
  type GhOpenPrSummary,
} from "./ghPrHeadRepo";
import { runGit } from "./git";

const GH_PR_LIST_TIMEOUT_MS = 8_000;
/**
 * `--head` matches on branch name across every fork, so the row we want is not
 * necessarily first. Fetch a small page and let the head-repo filter choose.
 */
const GH_PR_LIST_LIMIT = "10";

async function resolveOriginOwner(worktreePath: string): Promise<string | null> {
  const result = await runGit(["remote", "get-url", "origin"], {
    cwd: worktreePath,
    timeoutMs: 5_000,
  }).catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  return parseGithubRemoteUrl(result.stdout.trim())?.owner ?? null;
}

/**
 * Runs `gh pr list`. Resolves the raw JSON on success, `""` when gh ran and
 * exited non-zero (bad flag, not authenticated, not a repo), and `null` when gh
 * could not be run at all or timed out. Callers use that distinction to decide
 * whether a retry with different flags could possibly help.
 */
function runGhPrList(args: {
  worktreePath: string;
  branch: string;
  fields: string;
}): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    let out = "";
    const child = spawn(
      "gh",
      [
        "pr",
        "list",
        "--head",
        args.branch,
        "--state",
        "open",
        "--json",
        args.fields,
        "--limit",
        GH_PR_LIST_LIMIT,
      ],
      {
        cwd: args.worktreePath,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* noop */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), GH_PR_LIST_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer | string) => {
      out += Buffer.isBuffer(d) ? d.toString("utf8") : String(d);
    });
    child.stderr.on("data", () => { /* swallow — may contain auth state */ });
    // gh missing / not executable: no retry can fix that.
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? out : ""));
  });
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

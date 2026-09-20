import fs from "node:fs";
import nodePath from "node:path";
import type { AgentChatGetTurnFileDiffArgs, AgentChatTurnFileDiff } from "../../../shared/types";
import { appendDiffTruncationNotice, MAX_DIFF_SIDE_TEXT_BYTES } from "../diffs/diffService";
import { runGit } from "../git/git";
import { isPathInside } from "../shared/pathCompare";

type DiffSide = {
  exists: boolean;
  text: string;
  isTruncated?: boolean;
  isBinary?: boolean;
};

/**
 * One turn's before/after for one file.
 *
 * The single implementation on purpose: the local `ipcMain` handler and the
 * `chat.getTurnFileDiff` runtime action serve the same renderer call (preload
 * prefers the action and falls back to IPC), so two copies meant the fallback
 * kept rendering the pre-fix diff long after the action was fixed.
 */
export async function getTurnFileDiffFromGit(
  projectRoot: string,
  arg: AgentChatGetTurnFileDiffArgs,
): Promise<AgentChatTurnFileDiff> {
  const lang = arg.filePath.split(".").pop() ?? undefined;
  const readSide = async (spec: string): Promise<DiffSide> => {
    const result = await runGit(["show", spec], {
      cwd: projectRoot,
      timeoutMs: 10_000,
      maxOutputBytes: MAX_DIFF_SIDE_TEXT_BYTES + 64 * 1024,
    });
    if (result.exitCode !== 0) return { exists: false, text: "" };
    const buf = Buffer.from(result.stdout, "utf8");
    if (buf.includes(0)) return { exists: true, text: "", isBinary: true };
    if (buf.length <= MAX_DIFF_SIDE_TEXT_BYTES) return { exists: true, text: result.stdout };
    return {
      exists: true,
      text: appendDiffTruncationNotice(buf.subarray(0, MAX_DIFF_SIDE_TEXT_BYTES).toString("utf8")),
      isTruncated: true,
    };
  };
  /**
   * The working-tree copy, for the side a commit cannot supply.
   *
   * A turn that changed files without committing reports the same sha on both
   * sides, and `git show <sha>:<path>` then returns the file as it was BEFORE
   * the turn for both sides — a diff of a file against itself, which renders as
   * "no changes" on a file the summary just listed as changed. The modified
   * side of an uncommitted turn is the file on disk, so that is what we read.
   */
  const readWorktreeSide = async (filePath: string): Promise<DiffSide> => {
    const absolute = nodePath.resolve(projectRoot, filePath);
    // A path that escapes the project is not a file this turn touched; the
    // commit side is already confined by git, so the worktree side must be too.
    if (!isPathInside(absolute, projectRoot)) return { exists: false, text: "" };
    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(absolute);
    } catch {
      // Deleted (or never created) in the working tree: an absent modified side
      // is exactly how a deletion renders.
      return { exists: false, text: "" };
    }
    if (buf.includes(0)) return { exists: true, text: "", isBinary: true };
    if (buf.length <= MAX_DIFF_SIDE_TEXT_BYTES) return { exists: true, text: buf.toString("utf8") };
    return {
      exists: true,
      text: appendDiffTruncationNotice(buf.subarray(0, MAX_DIFF_SIDE_TEXT_BYTES).toString("utf8")),
      isTruncated: true,
    };
  };

  const uncommitted = arg.afterSha === arg.beforeSha;
  const origResult = await readSide(`${arg.beforeSha}:${arg.filePath}`);
  const modResult = uncommitted
    ? await readWorktreeSide(arg.filePath)
    : await readSide(`${arg.afterSha}:${arg.filePath}`);
  return {
    path: arg.filePath,
    mode: "commit",
    ...(lang ? { language: lang } : {}),
    original: origResult,
    modified: modResult,
    ...(origResult.isBinary || modResult.isBinary ? { isBinary: true } : {}),
  };
}

import fs from "node:fs";
import path from "node:path";
import { findCodexRolloutPathBySessionIdAsync } from "../externalSessions/discoverCodex";

/**
 * Copies one provider thread from one local account's config home to another,
 * so the same chat can resume the same thread on the other account.
 *
 * Claude and Codex keep a conversation as local files in the account's config
 * home, not on the provider's servers:
 *
 * - Claude: `<home>/projects/<cwd slug>/<session id>.jsonl`, plus an optional
 *   `<session id>/` folder beside it (subagent transcripts, large tool results).
 * - Codex: `<home>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`.
 *
 * A resume by id reads the file from the config home the CLI runs with. With
 * the file copied to the same relative path, the other account resumes the
 * same thread id. The source stays in place, so the old account can still
 * resume it later.
 *
 * The target is replaced when it exists: a chat that moved away and back
 * carries an older copy there, and the source is the newer one.
 */
export type ProviderThreadMoveArgs = {
  provider: "claude" | "codex";
  threadId: string;
  fromConfigHome: string;
  toConfigHome: string;
};

export type ProviderThreadMoveResult =
  | { ok: true; targetPath: string }
  | { ok: false; reason: "same_home" | "thread_not_found" | "copy_failed"; message: string };

function copyFileReplacing(sourcePath: string, targetPath: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  // Copy to a sibling first, then rename: a resume that starts during the
  // copy must never read half a transcript.
  const staging = `${targetPath}.ade-move-${process.pid}-${Date.now()}`;
  try {
    fs.copyFileSync(sourcePath, staging);
    fs.renameSync(staging, targetPath);
  } finally {
    fs.rmSync(staging, { force: true });
  }
}

/** Finds `<home>/projects/*\/<id>.jsonl`. The project folder name is the CLI's own cwd slug. */
function findClaudeThreadFile(configHome: string, sessionId: string): string | null {
  const projectsDir = path.join(configHome, "projects");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest: { filePath: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projectsDir, entry.name, `${sessionId}.jsonl`);
    try {
      const stat = fs.statSync(candidate);
      if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { filePath: candidate, mtimeMs: stat.mtimeMs };
    } catch {
      // Not in this project folder.
    }
  }
  return newest?.filePath ?? null;
}

async function moveClaudeThread(args: ProviderThreadMoveArgs): Promise<ProviderThreadMoveResult> {
  const sourcePath = findClaudeThreadFile(args.fromConfigHome, args.threadId);
  if (!sourcePath) {
    return {
      ok: false,
      reason: "thread_not_found",
      message: `Claude thread ${args.threadId} is not in ${args.fromConfigHome}.`,
    };
  }
  const relative = path.relative(args.fromConfigHome, sourcePath);
  const targetPath = path.join(args.toConfigHome, relative);
  copyFileReplacing(sourcePath, targetPath);
  const sidecarSource = path.join(path.dirname(sourcePath), args.threadId);
  if (fs.existsSync(sidecarSource)) {
    fs.cpSync(sidecarSource, path.join(path.dirname(targetPath), args.threadId), {
      recursive: true,
      force: true,
    });
  }
  return { ok: true, targetPath };
}

async function moveCodexThread(args: ProviderThreadMoveArgs): Promise<ProviderThreadMoveResult> {
  const sourcePath = await findCodexRolloutPathBySessionIdAsync(args.threadId, {
    env: { CODEX_HOME: args.fromConfigHome },
  });
  if (!sourcePath) {
    return {
      ok: false,
      reason: "thread_not_found",
      message: `Codex thread ${args.threadId} is not in ${args.fromConfigHome}.`,
    };
  }
  const targetPath = path.join(args.toConfigHome, path.relative(args.fromConfigHome, sourcePath));
  copyFileReplacing(sourcePath, targetPath);
  return { ok: true, targetPath };
}

export async function moveProviderThread(args: ProviderThreadMoveArgs): Promise<ProviderThreadMoveResult> {
  const from = path.resolve(args.fromConfigHome);
  const to = path.resolve(args.toConfigHome);
  if (from === to) {
    return { ok: false, reason: "same_home", message: "Both accounts use the same config home." };
  }
  const resolved = { ...args, fromConfigHome: from, toConfigHome: to };
  try {
    return args.provider === "claude"
      ? await moveClaudeThread(resolved)
      : await moveCodexThread(resolved);
  } catch (error) {
    return {
      ok: false,
      reason: "copy_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

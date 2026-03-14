import path from "node:path";
import { randomUUID } from "node:crypto";
import { runGit, runGitOrThrow } from "../git/git";
import type { AdeDb } from "../state/kvDb";
import type { ProjectInfo } from "../../../shared/types";

export async function resolveRepoRoot(selectedPath: string): Promise<string> {
  const out = await runGitOrThrow(["rev-parse", "--show-toplevel"], { cwd: selectedPath, timeoutMs: 10_000 });
  return out.trim();
}

export async function detectDefaultBaseRef(repoRoot: string): Promise<string> {
  // Prefer the remote default branch if available.
  const originHead = await runGit(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { cwd: repoRoot, timeoutMs: 6_000 });
  if (originHead.exitCode === 0) {
    const ref = originHead.stdout.trim(); // e.g. refs/remotes/origin/main
    const m = ref.match(/refs\/remotes\/origin\/(.+)$/);
    if (m?.[1]) return m[1];
  }

  const head = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot, timeoutMs: 6_000 });
  if (head.exitCode === 0) {
    const name = head.stdout.trim();
    if (name && name !== "HEAD") return name;
  }

  return "main";
}

export function upsertProjectRow({
  db,
  repoRoot,
  displayName,
  baseRef
}: {
  db: AdeDb;
  repoRoot: string;
  displayName: string;
  baseRef: string;
}): { projectId: string } {
  const now = new Date().toISOString();
  const existing = db.get<{ id: string }>("select id from projects where root_path = ? limit 1", [repoRoot]);
  const id = existing?.id ?? randomUUID();
  if (existing?.id) {
    db.run("update projects set display_name = ?, default_base_ref = ?, last_opened_at = ? where id = ?", [
      displayName,
      baseRef,
      now,
      id
    ]);
  } else {
    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [id, repoRoot, displayName, baseRef, now, now]
    );
  }
  return { projectId: id };
}

export function toProjectInfo(repoRoot: string, baseRef: string): ProjectInfo {
  return { rootPath: repoRoot, displayName: path.basename(repoRoot), baseRef };
}

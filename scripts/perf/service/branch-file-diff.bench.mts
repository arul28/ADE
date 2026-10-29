// cd apps/ade-cli && npx tsx ../../scripts/perf/service/branch-file-diff.bench.mts <worktree> <baseRef> [clicks] [patch|file]
// What clicking through a lane's branch diff costs: getBranchChanges once, then
// getFilePatch (the lane diff pane, default) or getFileDiff (the side-by-side
// viewer) in mode "branch" for each changed file in turn (up to <clicks>,
// default 20). Counts git processes (git-count.mts) and wall time per click.
// Read-only on the worktree: the temp index lives in the OS temp folder.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitCounter } from "./git-count.mts";

const [worktree, baseRef = "main", clicksArg, method = "patch"] = process.argv.slice(2);
if (!worktree) throw new Error("usage: branch-file-diff.bench.mts <worktree> <baseRef> [clicks]");
const clicks = Number(clicksArg ?? 20);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-branch-file-diff-"));
const counter = gitCounter(dir);
const realGit = counter.realGit;

const { createDiffService } = await import("../../../apps/desktop/src/main/services/diffs/diffService");
const branchRef = spawnSync(realGit, ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktree, encoding: "utf8" }).stdout.trim();
const laneService = { getLaneBaseAndBranch: () => ({ worktreePath: worktree, baseRef, branchRef }) } as any;
const service = createDiffService({ laneService });
const count = () => counter.runs().length;
counter.reset();
const changes = await service.getBranchChanges("lane");
const files = changes.files.slice(0, clicks);
const ms: number[] = [];
counter.reset();
for (const file of files) {
  const t = performance.now();
  if (method === "file") await service.getFileDiff({ laneId: "lane", filePath: file.path, mode: "branch" });
  else await service.getFilePatch({ laneId: "lane", filePath: file.path, mode: "branch" });
  ms.push(performance.now() - t);
}
const byVerb: Record<string, number> = {};
for (const line of counter.runs()) {
  const verb = line.replace(/^(?:-c \S+ )*/, "").split(" ").slice(0, 2).join(" ");
  byVerb[verb] = (byVerb[verb] ?? 0) + 1;
}
const sorted = [...ms].sort((a, b) => a - b);
console.log(JSON.stringify({
  files: changes.files.length, clicks: files.length,
  gitPerClick: Math.round((count() / files.length) * 10) / 10,
  medianMs: Math.round(sorted[Math.floor(sorted.length / 2)]!), maxMs: Math.round(sorted[sorted.length - 1]!),
  totalMs: Math.round(ms.reduce((a, b) => a + b, 0)), byVerb,
}));
fs.rmSync(dir, { recursive: true, force: true });

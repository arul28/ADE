// cd apps/ade-cli && npx tsx ../../scripts/perf/service/branch-file-diff.bench.mts <worktree> <baseRef> [clicks] [patch|file]
// What clicking through a lane's branch diff costs: getBranchChanges once, then
// getFilePatch (the lane diff pane, default) or getFileDiff (the side-by-side
// viewer) in mode "branch" for each changed file in turn (up to <clicks>,
// default 20). Counts git processes (a counting
// ADE_GIT_EXECUTABLE wrapper) and wall time per click. Read-only on the
// worktree: the temp index lives in the OS temp folder.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [worktree, baseRef = "main", clicksArg, method = "patch"] = process.argv.slice(2);
if (!worktree) throw new Error("usage: branch-file-diff.bench.mts <worktree> <baseRef> [clicks]");
const clicks = Number(clicksArg ?? 20);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-branch-file-diff-"));
const counter = path.join(dir, "git-count.log");
const wrapper = path.join(dir, "git-wrapper.sh");
const realGit = process.platform === "darwin"
  ? spawnSync("/usr/bin/xcrun", ["--find", "git"], { encoding: "utf8" }).stdout.trim()
  : spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
fs.writeFileSync(wrapper, `#!/bin/sh\necho "$*" >> ${JSON.stringify(counter)}\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
process.env.ADE_GIT_EXECUTABLE = wrapper;

const { createDiffService } = await import("../../../apps/desktop/src/main/services/diffs/diffService");
const branchRef = spawnSync(realGit, ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktree, encoding: "utf8" }).stdout.trim();
const laneService = { getLaneBaseAndBranch: () => ({ worktreePath: worktree, baseRef, branchRef }) } as any;
const service = createDiffService({ laneService });
const count = () => fs.readFileSync(counter, "utf8").split("\n").filter(Boolean).length;
fs.writeFileSync(counter, "");
const changes = await service.getBranchChanges("lane");
const files = changes.files.slice(0, clicks);
const ms: number[] = [];
fs.writeFileSync(counter, "");
for (const file of files) {
  const t = performance.now();
  if (method === "file") await service.getFileDiff({ laneId: "lane", filePath: file.path, mode: "branch" });
  else await service.getFilePatch({ laneId: "lane", filePath: file.path, mode: "branch" });
  ms.push(performance.now() - t);
}
const byVerb: Record<string, number> = {};
for (const line of fs.readFileSync(counter, "utf8").split("\n").filter(Boolean)) {
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

// cd apps/ade-cli && npx tsx ../../scripts/perf/service/changed-file-tree.bench.mts --project <copy root> [--files 1000] [--runs 5]
// S130 against an outside target: building the changed-file tree for <files> changed files (outside target:
// 2.38 ms for 1,000 files). ADE builds two:
//   lane change list   buildChangeTree + buildChangeTreeStatsByPath + flattenChangeTreeRows (every folder open),
//                      the lane Git panel's tree
//   diff file tree     buildDiffFileTree, the branch / PR diff's tree
// The paths are the first <files> tracked files of <copy root> (a make-real-load-copy copy; only `git ls-files`
// runs there), so folder depth and fan-out are a real repository's. Each run times 50 builds and keeps the
// median; prints the median of <runs> runs with the worst.
import { execFileSync } from "node:child_process";
import { flag, median, requireCopyRoot } from "./bench-kit.mts";

const root = requireCopyRoot(flag("--project"));
const positiveInt = (name: string, fallback: number) => {
  const raw = flag(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
};
const fileCount = positiveInt("--files", 1000);
const runs = positiveInt("--runs", 5);

const { buildChangeTree, buildChangeTreeStatsByPath, flattenChangeTreeRows } = await import("../../../apps/desktop/src/renderer/components/lanes/laneGitChangeList");
const { buildDiffFileTree } = await import("../../../apps/desktop/src/renderer/components/shared/DiffFileTree");

// -z: unquoted paths (git quotes non-ASCII names otherwise, and the quotes would read as folders).
const paths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .split("\0").filter(Boolean).slice(0, fileCount);
if (paths.length < fileCount) throw new Error(`the copy has only ${paths.length} tracked files`);
const changes = paths.map((path, index) => ({ path, kind: index % 7 === 0 ? "added" : "modified", additions: index % 40, deletions: index % 13 }));
const diffEntries = paths.map((path, index) => ({ path, status: index % 7 === 0 ? "A" : "M" }));

const r2 = (x: number) => Math.round(x * 100) / 100;
function bench(name: string, build: () => unknown) {
  for (let i = 0; i < 20; i++) build();
  const runMedians: number[] = [];
  for (let run = 0; run < runs; run++) {
    const ms: number[] = [];
    for (let i = 0; i < 50; i++) {
      const started = performance.now();
      build();
      ms.push(performance.now() - started);
    }
    runMedians.push(median(ms));
  }
  console.log(JSON.stringify({ row: name, files: paths.length, medianMs: r2(median(runMedians)), worstRunMs: r2(Math.max(...runMedians)) }));
}

bench("lane change list: tree + stats + rows (all open)", () => {
  const tree = buildChangeTree(changes as never);
  const stats = buildChangeTreeStatsByPath(changes as never);
  const rows: unknown[] = [];
  flattenChangeTreeRows(tree, "unstaged" as never, 0, new Set<string>(), stats, rows as never);
  return rows;
});
bench("diff file tree", () => buildDiffFileTree(diffEntries as never));
process.exit(0);

// cd apps/ade-cli && npx tsx ../../scripts/perf/service/conflict-sweep.bench.mts [lanes]
// What the conflict predictor's periodic sweep costs when nothing changed:
// a scratch repository with <lanes> lane worktrees (default 8), each one commit
// ahead of main, then `runPrediction({})` (the two-minute sweep) four times
// with no commit in between, and once more after one lane commits. Counts the
// git processes each sweep starts (git-count.mts) and its wall time. Everything
// lives in a temp folder; it never touches ~/.ade or a real project.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitCounter } from "./git-count.mts";

const laneCount = Number(process.argv[2] ?? 8);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-conflict-sweep-"));
const counter = gitCounter(root);
const appleGit = counter.realGit;

const { openKvDb } = await import("../../../apps/desktop/src/main/services/state/kvDb");
const { createConflictService } = await import("../../../apps/desktop/src/main/services/conflicts/conflictService");

const git = (cwd: string, args: string[]) => execFileSync(appleGit, args, { cwd, encoding: "utf8" }).trim();
const repo = path.join(root, "repo");
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(repo, "src", `f${i}.ts`), `export const v${i} = ${i};\n`);
git(repo, ["init", "-q", "-b", "main"]);
git(repo, ["config", "user.email", "bench@ade.local"]);
git(repo, ["config", "user.name", "bench"]);
git(repo, ["add", "."]);
git(repo, ["commit", "-qm", "base"]);

const logger = { debug() {}, info() {}, warn() {}, error() {} } as any;
const db = await openKvDb(path.join(root, "ade.db"), logger);
const projectId = "bench-project";
const now = new Date().toISOString();
db.run("insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)", [projectId, repo, "bench", "main", now, now]);
const lanes: any[] = [];
for (let i = 0; i < laneCount; i++) {
  const wt = path.join(root, `lane-${i}`);
  git(repo, ["worktree", "add", "-q", "-b", `lane-${i}`, wt]);
  fs.writeFileSync(path.join(wt, "src", `f${i % 5}.ts`), `export const lane${i} = ${i};\n`);
  git(wt, ["commit", "-qam", `lane ${i}`]);
  lanes.push({
    id: `lane-${String(i).padStart(2, "0")}`, name: `Lane ${i}`, description: null, laneType: "worktree",
    branchRef: `lane-${i}`, baseRef: "main", worktreePath: wt, attachedRootPath: null, isEditProtected: false,
    parentLaneId: null, color: null, icon: null, tags: [], stackDepth: 0, createdAt: now, archivedAt: null,
    status: { dirty: false, ahead: 1, behind: 0, conflict: "unknown", tests: "unknown", pr: "none" },
  });
}
const service = createConflictService({
  db, logger, projectId, projectRoot: repo,
  // No lane has an open PR here, so every lane compares against its base (main).
  laneService: { list: async () => lanes, getCompareBase: () => "main", getLaneBaseAndBranch: ({ laneId }: { laneId: string }) => {
    const lane = lanes.find((entry) => entry.id === laneId)!;
    return { worktreePath: lane.worktreePath, baseRef: lane.baseRef, branchRef: lane.branchRef };
  } } as any,
  projectConfigService: { get: () => ({ local: {}, effective: { providerMode: "guest", providers: {} } }) } as any,
});

let lastDbVersion: number | null = db.get<{ v: number }>("select crsql_db_version() as v")?.v ?? null;
const sweep = async (label: string) => {
  counter.reset();
  // Past the git read cache's 1.5 s window, as two minutes apart would be.
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  const t = performance.now();
  await service.runPrediction({});
  const ms = performance.now() - t;
  // The verb is the first argument after ADE's leading `-c key=value` pairs.
  const verbs = counter.runs()
    .map((line) => line.replace(/^(?:-c \S+ )*/, "").split(" ")[0]!);
  const byVerb: Record<string, number> = {};
  for (const verb of verbs) byVerb[verb] = (byVerb[verb] ?? 0) + 1;
  const dbVersion = db.get<{ v: number }>("select crsql_db_version() as v")?.v ?? null;
  const syncedChanges = lastDbVersion == null || dbVersion == null ? null : dbVersion - lastDbVersion;
  lastDbVersion = dbVersion;
  console.log(JSON.stringify({ sweep: label, lanes: laneCount, gitProcesses: verbs.length, ms: Math.round(ms), byVerb, syncedChanges }));
};

await sweep("first (nothing stored)");
for (let i = 1; i <= 3; i++) await sweep(`unchanged #${i}`);
fs.writeFileSync(path.join(lanes[0].worktreePath, "src", "new.ts"), "export const n = 1;\n");
git(lanes[0].worktreePath, ["add", "."]);
git(lanes[0].worktreePath, ["commit", "-qm", "one more"]);
await sweep("after one lane commits");
db.close();
fs.rmSync(root, { recursive: true, force: true });

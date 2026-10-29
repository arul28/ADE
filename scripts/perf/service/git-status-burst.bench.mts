// cd apps/ade-cli && npx tsx ../../scripts/perf/service/git-status-burst.bench.mts --project <copy root> [--runs 5] [--lane <id>] [--gap-ms 300]
// F4 against an outside target: a burst of status refreshes of one folder, measured the way the target
// was: one status refresh, then 4 more that overlap it, counting the full status runs (target: at most
// 2 for a burst of N) and the git processes. ADE's refresh is
// `get_lane_status` (what `ade git status --full` asks for): the lane list, the lane's changes, its
// conflict status and its conflict state. ADE never fetches from the remote in it.
//
// Starts its own isolated measurement brain (scripts/perf/net/measure-brain.mjs: own HOME, ADE_HOME,
// pipe or socket, loopback only, the port guard) with scripts/perf/ui/spawn-trace.cjs preloaded, so
// every process the brain starts is recorded, including those started on its off-thread spawn worker.
// The brain opens <copy root>, which must be a make-real-load-copy copy (never a live project).
// Each run waits 2 s (past the git read cache), sends one refresh, then 4 at once <gap-ms> later, and
// counts git processes and `git status` runs from the first send until all five answered, plus
// those that start in the second after. Prints each run and the median of the runs with the worst.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { connectBrain, startMeasureBrain, stopMeasureBrain, type BrainClient } from "../net/brain-rpc.mts";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const project = flag("--project");
if (!project) throw new Error("--project <copy root> is required");
const projectRoot = path.resolve(project);
if (!fs.existsSync(path.join(projectRoot, ".ade", "real-load-copy.json"))) {
  throw new Error(`${projectRoot} is not a make-real-load-copy copy; refusing to open it with a brain`);
}
const runs = Number(flag("--runs") ?? 5);
// --cli <built cli.cjs>: measure another build (A/B against a saved perfdist-*/cli.cjs).
const cli = flag("--cli");
const gapMs = Number(flag("--gap-ms") ?? 300);
const here = import.meta.dirname;
const spawnTrace = path.resolve(here, "../ui/spawn-trace.cjs");

const laneId = flag("--lane") ?? (() => {
  const db = new DatabaseSync(path.join(projectRoot, ".ade", "ade.db"), { readOnly: true });
  try {
    return (db.prepare("select id from lanes where lane_type = 'primary' and archived_at is null limit 1").get() as { id: string } | undefined)?.id;
  } finally {
    db.close();
  }
})();
if (!laneId) throw new Error("no primary lane in the copy; pass --lane <id>");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ade-git-status-burst-"));
const traceDir = path.join(scratch, "trace");
fs.mkdirSync(traceDir);
const brain = { dir: scratch, n: "f4" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Spawn = { at: number; cmd: string; args: string[] };
const readSpawns = (): Spawn[] =>
  fs.readdirSync(traceDir).flatMap((file) =>
    fs.readFileSync(path.join(traceDir, file), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Spawn));
const isGit = (spawn: Spawn) => /^git(\.exe)?$/i.test(path.basename(spawn.cmd));
// The git verb is the first argument after ADE's leading `-c key=value` pairs.
const verbOf = (spawn: Spawn) => {
  const args = [...spawn.args];
  while (args[0] === "-c") args.splice(0, 2);
  return args[0] ?? "";
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const record = startMeasureBrain({ ...brain, cli, preloads: [spawnTrace], env: { ADE_SPAWN_TRACE_DIR: traceDir } });

const rows: Array<{ run: number; gitProcesses: number; statusRuns: number; trailingGit: number; wallMs: number; byVerb: Record<string, number> }> = [];
let client: BrainClient | null = null;
try {
  client = await connectBrain(record.socket, "git-status-burst-bench");
  await client.addProject(projectRoot);
  const refresh = () => client!.action("get_lane_status", { laneId });
  // Warm-up: the first refresh after a brain starts also fills one-time caches.
  await refresh();
  await refresh();
  for (let run = 1; run <= runs; run++) {
    await sleep(2_000);
    const t0 = Date.now();
    const first = refresh();
    await sleep(gapMs);
    await Promise.all([first, refresh(), refresh(), refresh(), refresh()]);
    const t1 = Date.now();
    await sleep(1_000);
    const spawns = readSpawns().filter(isGit);
    const burst = spawns.filter((spawn) => spawn.at >= t0 && spawn.at <= t1);
    const byVerb: Record<string, number> = {};
    for (const spawn of burst) byVerb[verbOf(spawn)] = (byVerb[verbOf(spawn)] ?? 0) + 1;
    rows.push({
      run,
      gitProcesses: burst.length,
      statusRuns: byVerb.status ?? 0,
      trailingGit: spawns.filter((spawn) => spawn.at > t1 && spawn.at <= t1 + 1_000).length,
      wallMs: t1 - t0,
      byVerb,
    });
    console.log(JSON.stringify(rows.at(-1)));
  }
} finally {
  client?.close();
  stopMeasureBrain(brain);
}
const summary = (key: "gitProcesses" | "statusRuns" | "trailingGit" | "wallMs") => ({
  median: median(rows.map((row) => row[key])),
  worst: Math.max(...rows.map((row) => row[key])),
});
console.log(JSON.stringify({
  bench: "git-status-burst",
  platform: process.platform,
  project: projectRoot,
  laneId,
  runs: rows.length,
  gapMs,
  gitProcesses: summary("gitProcesses"),
  statusRuns: summary("statusRuns"),
  trailingGit: summary("trailingGit"),
  wallMs: summary("wallMs"),
}));
// --keep-trace <dir>: keep the spawn trace (with each process's call stack) for attribution.
const keepTrace = flag("--keep-trace");
if (keepTrace) fs.cpSync(traceDir, keepTrace, { recursive: true });
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(0);

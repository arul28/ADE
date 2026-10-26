// cd apps/ade-cli && npx tsx ../../scripts/perf/service/db-reads.bench.mts <ade.db> [rounds]
// The brain's heaviest reads on a copy of a real project database, through
// ADE's own openKvDb (cr-sqlite loaded, migrations run): the Stats page's usage
// roll-up, every PR snapshot, the History list, the conflict matrix rows, and
// a phone's first sync export. Prints the first run and the median of the rest
// per query, plus the longest. ADE_BENCH_PRAGMAS="cache_size=-65536;mmap_size=268435456"
// applies extra pragmas after the open, to compare page-cache settings.
// It copies the database to a temp folder first and never writes the original.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const source = process.argv[2];
const rounds = Number(process.argv[3] ?? 9);
if (!source || !fs.existsSync(source)) throw new Error("usage: db-reads.bench.mts <ade.db> [rounds]");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-db-reads-"));
const copy = path.join(dir, "ade.db");
fs.copyFileSync(source, copy);

const { openKvDb } = await import("../../../apps/desktop/src/main/services/state/kvDb");
const { collectAdeDatabaseUsageStats } = await import("../../../apps/desktop/src/main/services/usage/usageStatsStore");
const logger = { debug() {}, info() {}, warn() {}, error() {} } as any;
const openStarted = performance.now();
const db = await openKvDb(copy, logger);
const openMs = performance.now() - openStarted;
for (const pragma of (process.env.ADE_BENCH_PRAGMAS ?? "").split(";").map((p) => p.trim()).filter(Boolean)) {
  db.run(`pragma ${pragma}`);
}
const projectId = db.get<{ id: string }>("select id from projects order by last_opened_at desc limit 1")?.id ?? "";
const dbVersion = db.sync?.getDbVersion?.() ?? 0;

const queries: Array<[string, () => unknown]> = [
  ["usage stats, all time", () => collectAdeDatabaseUsageStats(db, { since: null, until: new Date().toISOString() })],
  ["PR snapshots, every PR", () => db.all(
    `select s.* from pull_request_snapshots s join pull_requests p on p.id = s.pr_id and p.project_id = ? order by p.updated_at desc`,
    [projectId],
  ).map((row) => Object.values(row).map((v) => (typeof v === "string" && v.startsWith("{") ? JSON.parse(v) : v)))],
  ["History: newest 500 operations", () => db.all(
    "select * from operations where project_id = ? order by started_at desc limit 500",
    [projectId],
  )],
  ["Conflict matrix rows", () => db.all(
    "select * from conflict_predictions where project_id = ? order by predicted_at desc",
    [projectId],
  )],
  ["Sync export, first 5,000 changes", () => db.sync?.exportChangesSince(0, { maxRows: 5_000, throughDbVersion: dbVersion })],
];

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const r1 = (x: number) => Math.round(x * 10) / 10;
console.log(JSON.stringify({ db: source, bytes: fs.statSync(copy).size, openMs: Math.round(openMs), pragmas: process.env.ADE_BENCH_PRAGMAS ?? "", rss: Math.round(process.memoryUsage().rss / 1e6) }));
for (const [name, run] of queries) {
  const ms: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const t = performance.now();
    run();
    ms.push(performance.now() - t);
  }
  console.log(JSON.stringify({ query: name, firstMs: r1(ms[0]!), medianMs: r1(med(ms.slice(1))), maxMs: r1(Math.max(...ms)) }));
}
console.log(JSON.stringify({ rssAfter: Math.round(process.memoryUsage().rss / 1e6) }));
db.close();
fs.rmSync(dir, { recursive: true, force: true });

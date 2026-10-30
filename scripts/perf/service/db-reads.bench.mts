// cd apps/ade-cli && npx tsx ../../scripts/perf/service/db-reads.bench.mts --project <copy root> [--runs 5] [--rounds 9]
//    (or the older form: db-reads.bench.mts <ade.db> [rounds])
// The brain's heaviest reads on a copy of a real project database, through
// ADE's own openKvDb (cr-sqlite loaded, migrations run): the Stats page's usage
// roll-up, every PR snapshot, the History list, the conflict matrix rows, and
// a phone's first sync export. Two rows against outside targets:
//   F1  the six reads one PR discovery pass makes, no GitHub calls (lanes, PRs,
//       integration group members, integration proposals, the busiest repo's open
//       and draft PR projections, PRs again); 10 passes, the first dropped.
//       Outside target: 4.32 ms (500 seeded threads).
//   F5  the brain's startup recovery read: `reconcileStaleRunningSessions` with the
//       process registry's live and known owners, as bootstrap.ts runs it at brain
//       start; one initial run, then 20 measured. Outside target: 0.8 ms.
// Each query runs <rounds> times per run (F1 10, F5 21) and its first round is dropped;
// a run's value is the median of the rest. Prints the median of the <runs> run values,
// the slowest run, the first round and the longest single round.
// ADE_BENCH_PRAGMAS="cache_size=-65536;mmap_size=268435456" applies extra pragmas after
// the open, to compare page-cache settings. It copies the database to a temp folder
// first and never writes the original.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const projectRoot = flag("--project");
const source = projectRoot ? path.join(path.resolve(projectRoot), ".ade", "ade.db") : argv[0];
const rounds = Number(flag("--rounds") ?? (projectRoot ? 9 : argv[1] ?? 9));
const runs = Number(flag("--runs") ?? (projectRoot ? 5 : 1));
if (!source || !fs.existsSync(source)) throw new Error("usage: db-reads.bench.mts --project <copy root> [--runs 5] [--rounds 9]");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-db-reads-"));
const copy = path.join(dir, "ade.db");
fs.copyFileSync(source, copy);
// A WAL database keeps recent commits in the -wal file until a checkpoint.
if (fs.existsSync(`${source}-wal`)) fs.copyFileSync(`${source}-wal`, `${copy}-wal`);

const { openKvDb } = await import("../../../apps/desktop/src/main/services/state/kvDb");
const { collectAdeDatabaseUsageStats } = await import("../../../apps/desktop/src/main/services/usage/usageStatsStore");
const { createSessionService } = await import("../../../apps/desktop/src/main/services/sessions/sessionService");
const { createProcessRegistryService } = await import("../../../apps/desktop/src/main/services/runtime/processRegistryService");
const logger = { debug() {}, info() {}, warn() {}, error() {} } as any;
const openStarted = performance.now();
const db = await openKvDb(copy, logger);
const openMs = performance.now() - openStarted;
for (const pragma of (process.env.ADE_BENCH_PRAGMAS ?? "").split(";").map((p) => p.trim()).filter(Boolean)) {
  db.run(`pragma ${pragma}`);
}
const projectId = db.get<{ id: string }>("select id from projects order by last_opened_at desc limit 1")?.id ?? "";
const dbVersion = db.sync?.getDbVersion?.() ?? 0;

// F1. main retired some of the tables the P4 pass read (integration_proposals); a pass reads only
// what exists. The projections read is the busiest repository's, as discovery reads them.
const tables = new Set(db.all<{ name: string }>("select name from sqlite_master where type = 'table'").map((row) => row.name));
const has = (...names: string[]) => names.every((name) => tables.has(name));
const repo = (has("github_pr_projections") ? db.get<{ repo_owner: string; repo_name: string }>(
  "select repo_owner, repo_name, count(*) n from github_pr_projections where project_id = ? group by 1, 2 order by n desc limit 1",
  [projectId],
) : null) ?? { repo_owner: "x", repo_name: "y" };
const count = (sql: string, table: string) => (has(table) ? db.get<{ n: number }>(sql, [projectId])?.n ?? 0 : null);
const f1Counts = {
  lanes: count("select count(*) n from lanes where project_id = ?", "lanes"),
  pullRequests: count("select count(*) n from pull_requests where project_id = ?", "pull_requests"),
  projections: count("select count(*) n from github_pr_projections where project_id = ?", "github_pr_projections"),
  proposals: count("select count(*) n from integration_proposals where project_id = ?", "integration_proposals"),
};
const prDiscoveryPass = () => {
  const lanes = db.all("select * from lanes where project_id = ? order by created_at", [projectId]);
  const prs = db.all("select * from pull_requests where project_id = ? order by updated_at desc", [projectId]);
  const groups = !has("pr_group_members", "pr_groups") ? [] : db.all(
    "select gm.pr_id, gm.group_id from pr_group_members gm join pr_groups g on g.id = gm.group_id where g.project_id = ? and g.group_type = 'integration'",
    [projectId],
  );
  const proposals = !has("integration_proposals") ? [] : db.all("select * from integration_proposals where project_id = ? order by created_at desc", [projectId]);
  const projections = !has("github_pr_projections") ? [] : db.all(
    `select project_id, repo_owner, repo_name, github_pr_number, github_node_id, github_url, title, state, is_draft, base_branch, head_branch,
            head_repo_owner, head_repo_name, head_sha, base_sha, author, labels_json, is_bot, comment_count, created_at, updated_at, synced_at,
            last_event_name, last_delivery_id
       from github_pr_projections
      where project_id = ? and lower(repo_owner) = lower(?) and lower(repo_name) = lower(?) and state in ('open', 'draft')
      order by updated_at desc limit 250`,
    [projectId, repo.repo_owner, repo.repo_name],
  );
  const prsAgain = db.all("select * from pull_requests where project_id = ? order by updated_at desc", [projectId]);
  return lanes.length + prs.length + groups.length + proposals.length + projections.length + prsAgain.length;
};

// F5: the startup recovery read, with the brain's own services over the copy.
const sessionService = createSessionService({ db, logger } as any);
const processRegistry = createProcessRegistryService({ db, logger, role: "ade-serve-daemon", projectRoot: dir } as any);
const f5Counts = db.get<{ n: number; running: number }>("select count(*) n, sum(status = 'running') running from terminal_sessions");
// Each pass must find the same stale rows the brain finds at start: the first pass marks them
// detached, so their original state is put back (outside the timing) before every pass.
const staleCandidates = db.all<Record<string, unknown>>("select id, status, ended_at, exit_code from terminal_sessions where status = 'running'");
const restoreStaleCandidates = () => {
  for (const row of staleCandidates) {
    db.run("update terminal_sessions set status = ?, ended_at = ?, exit_code = ? where id = ?", [row.status, row.ended_at, row.exit_code, row.id] as never);
  }
};
let reconciled = 0;
const startupRecovery = () => {
  reconciled += sessionService.reconcileStaleRunningSessions({
    status: "detached",
    liveOwnerPids: processRegistry.listLivePids(),
    liveOwnerIdentities: processRegistry.listLiveProcessIdentities(),
    knownOwnerPids: processRegistry.listKnownPids(),
    knownOwnerIdentities: processRegistry.listKnownProcessIdentities(),
  });
};

const queries: Array<[string, () => unknown, number?, (() => void)?]> = [
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
  ["F1 PR discovery reads, one pass", prDiscoveryPass, 10],
  ["F5 startup recovery read", startupRecovery, 21, restoreStaleCandidates],
];

const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const r2 = (x: number) => Math.round(x * 100) / 100;
console.log(JSON.stringify({ db: source, bytes: fs.statSync(copy).size, openMs: Math.round(openMs), pragmas: process.env.ADE_BENCH_PRAGMAS ?? "", rss: Math.round(process.memoryUsage().rss / 1e6), f1Counts, f5Counts }));
for (const [name, run, queryRounds = rounds, beforeEach] of queries) {
  const runValues: number[] = [];
  let firstMs = 0;
  let maxMs = 0;
  for (let r = 0; r < runs; r++) {
    const ms: number[] = [];
    for (let i = 0; i < queryRounds; i++) {
      beforeEach?.();
      const t = performance.now();
      run();
      ms.push(performance.now() - t);
    }
    if (r === 0) firstMs = ms[0]!;
    maxMs = Math.max(maxMs, ...ms.slice(1));
    runValues.push(med(ms.slice(1)));
  }
  console.log(JSON.stringify({ query: name, rounds: queryRounds, runs, firstMs: r2(firstMs), runMediansMs: runValues.map(r2), medianMs: r2(med(runValues)), worstRunMs: r2(Math.max(...runValues)), maxMs: r2(maxMs) }));
}
console.log(JSON.stringify({ rssAfter: Math.round(process.memoryUsage().rss / 1e6), f5Reconciled: reconciled }));
processRegistry.stop?.();
db.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);

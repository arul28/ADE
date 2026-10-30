// cd apps/ade-cli && npx tsx ../../scripts/perf/service/brain-idle.bench.mts --project <copy root> [--minutes 10] [--settle-s 60] [--cli <built cli.cjs>]
// What a brain does on its own while nobody uses it: an isolated measurement brain (measure-brain.mjs: own
// HOME, sync on loopback, the port guard) opens <copy root> (a make-real-load-copy copy), settles, then sits
// idle for <minutes>. No desktop, phone or CLI is connected during the window. Reports, per window:
//   - process starts by command and verb (scripts/perf/ui/spawn-trace.cjs, including the off-thread spawn
//     worker), the costliest kind of idle work on Windows;
//   - SQL statements by kind (read / write / pragma / transaction) and thread (0 is the event loop), from
//     scripts/perf/net/sql-trace.cjs logging every statement;
//   - database versions added (the copy's cr-sqlite clock tables): every one is a synced write that goes
//     to every paired device;
//   - the brain's CPU seconds.
// Outside targets (their merged numbers): about 1 background poll query per 10 idle minutes, 0 process
// samples while idle, about 3 writer PRAGMAs a minute. The measurement brain's fake home has no GitHub CLI
// config, so `gh` lookups here run more often than on a real install; they are listed apart.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { connectBrain, prepareCopyForBrain, startMeasureBrain, stopMeasureBrain } from "../net/brain-rpc.mts";
import { flag, requireCopyRoot } from "./bench-kit.mts";

const projectRoot = requireCopyRoot(flag("--project"));
const minutes = Number(flag("--minutes") ?? 10);
const settleMs = Number(flag("--settle-s") ?? 60) * 1_000;
const here = import.meta.dirname;
const spawnTrace = path.resolve(here, "../ui/spawn-trace.cjs");
const sqlTrace = path.resolve(here, "../net/sql-trace.cjs");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The highest database version in the copy's clock tables (read-only; the brain keeps writing). */
function dbVersion(): number {
  const db = new DatabaseSync(path.join(projectRoot, ".ade", "ade.db"), { readOnly: true });
  try {
    let max = 0;
    for (const { name } of db.prepare("select name from sqlite_master where type = 'table' and name like '%__crsql_clock'").all() as Array<{ name: string }>) {
      const row = db.prepare(`select max(db_version) as v from "${name.replaceAll('"', '""')}"`).get() as { v: number | null };
      max = Math.max(max, Number(row.v ?? 0));
    }
    return max;
  } finally {
    db.close();
  }
}

/** CPU seconds a process has used, from the OS. */
function cpuSeconds(pid: number): number {
  if (process.platform === "win32") {
    return Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).TotalProcessorTime.TotalSeconds`], { encoding: "utf8" }).trim());
  }
  // `ps` prints [[dd-]hh:]mm:ss[.ss].
  const text = execFileSync("ps", ["-o", "cputime=", "-p", String(pid)], { encoding: "utf8" }).trim();
  const [days, clock] = text.includes("-") ? text.split("-") : ["0", text];
  const parts = clock!.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  return Number(days) * 86_400 + parts[0]! * 3_600 + parts[1]! * 60 + parts[2]!;
}

await prepareCopyForBrain(projectRoot);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ade-brain-idle-"));
const traceDir = path.join(scratch, "trace");
const sqlFile = path.join(scratch, "sql.jsonl");
fs.mkdirSync(traceDir);
const brain = { dir: scratch, n: "idle" };
const record = startMeasureBrain({
  ...brain,
  cli: flag("--cli"),
  preloads: [spawnTrace, sqlTrace],
  env: { ADE_SPAWN_TRACE_DIR: traceDir, ADE_PERF_SQLTRACE_FILE: sqlFile, ADE_PERF_SQLTRACE_ALL: "1" },
});
let summary: Record<string, unknown>;
try {
  const client = await connectBrain(record.socket, "brain-idle-bench");
  await client.addProject(projectRoot);
  // Opens the project's runtime, as a first desktop or phone request would.
  await client.action("list_lanes", { includeArchived: false });
  client.close();
  await sleep(settleMs);

  const t0 = Date.now();
  const version0 = dbVersion();
  const cpu0 = cpuSeconds(record.pid);
  await sleep(minutes * 60_000);
  const t1 = Date.now();
  const version1 = dbVersion();
  const cpu1 = cpuSeconds(record.pid);
  await sleep(1_500); // the SQL trace flushes once a second

  type Spawn = { at: number; cmd: string; args: string[] };
  const spawns = fs.readdirSync(traceDir).flatMap((file) =>
    fs.readFileSync(path.join(traceDir, file), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Spawn))
    .filter((spawn) => spawn.at >= t0 && spawn.at <= t1);
  const verbOf = (args: string[]) => {
    const rest = [...args];
    while (rest[0] === "-c") rest.splice(0, 2);
    return rest[0] && !rest[0].startsWith("-") && rest[0].length < 24 ? rest[0] : "";
  };
  const byCommand: Record<string, number> = {};
  for (const spawn of spawns) {
    const key = `${path.basename(spawn.cmd).replace(/\.exe$/i, "")} ${verbOf(spawn.args)}`.trim();
    byCommand[key] = (byCommand[key] ?? 0) + 1;
  }

  type Sql = { at: number; thread: number; kind: string; sql: string | null };
  const sql = fs.existsSync(sqlFile)
    ? fs.readFileSync(sqlFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Sql).filter((row) => row.at >= t0 && row.at <= t1)
    : [];
  const sqlKind = (row: Sql) => {
    if (row.kind === "txn") return "transaction";
    const head = (row.sql ?? "").trimStart().slice(0, 12).toLowerCase();
    if (head.startsWith("pragma")) return "pragma";
    if (/^(select|with)/.test(head)) return "read";
    if (/^(begin|commit|rollback|savepoint|release|end)/.test(head)) return "transaction control";
    return "write";
  };
  const sqlCounts: Record<string, number> = {};
  for (const row of sql) {
    const key = `${row.thread === 0 ? "event loop" : "worker"} ${sqlKind(row)}`;
    sqlCounts[key] = (sqlCounts[key] ?? 0) + 1;
  }
  const topStatements = (kind: string) => {
    const counts = new Map<string, number>();
    for (const row of sql) if (row.thread === 0 && sqlKind(row) === kind) counts.set((row.sql ?? "").slice(0, 70), (counts.get((row.sql ?? "").slice(0, 70)) ?? 0) + 1);
    return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]).slice(0, 8));
  };

  summary = {
    bench: "brain-idle",
    platform: process.platform,
    project: projectRoot,
    idleMinutes: +((t1 - t0) / 60_000).toFixed(1),
    processStarts: spawns.length,
    processStartsByCommand: Object.fromEntries(Object.entries(byCommand).sort((a, b) => b[1] - a[1])),
    sqlStatements: sql.filter((row) => row.kind !== "txn").length,
    sqlByKind: sqlCounts,
    topWrites: topStatements("write"),
    topReads: topStatements("read"),
    dbVersionsAdded: version1 - version0,
    brainCpuSeconds: +(cpu1 - cpu0).toFixed(2),
  };
} finally {
  stopMeasureBrain(brain);
}
console.log(JSON.stringify(summary, null, 1));
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(0);

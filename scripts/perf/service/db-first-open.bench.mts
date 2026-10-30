// cd apps/ade-cli && npx tsx ../../scripts/perf/service/db-first-open.bench.mts --project <copy root> [--runs 5] [--per-run 7]
// E1: the first open of a project database in a fresh process, as a brain or desktop pays it when a
// project opens. Each open gets its own process and its own fresh copy of <project>/.ade/ade.db (with
// its -wal), so nothing is cached in the process or repaired in the file by an earlier open; the copy
// has no secrets/, so the open writes a new local site id, as P0's macOS harness did. Timed inside the
// child from just before `openKvDb` to its return; module loading is reported apart. Prints each
// run's median of <per-run> opens, the median of the run medians and the slowest single open.
// Copies live in the OS temp folder; the project's own database is only read (copied).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { median, requireCopyRoot } from "./bench-kit.mts";

const argv = process.argv.slice(2);
const read = (name: string, fallback?: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};

if (argv[0] === "--child") {
  const dbPath = argv[1]!;
  const importStarted = performance.now();
  const { openKvDb } = await import("../../../apps/desktop/src/main/services/state/kvDb");
  const importMs = performance.now() - importStarted;
  const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;
  const started = performance.now();
  const db = await openKvDb(dbPath, logger);
  const openMs = performance.now() - started;
  const crsqlite = db.sync.isAvailable?.() ?? false;
  db.close();
  process.stdout.write(JSON.stringify({ openMs, importMs, crsqlite }));
  process.exit(0);
}

const source = path.join(requireCopyRoot(read("--project")), ".ade", "ade.db");
if (!fs.existsSync(source)) throw new Error(`no database at ${source}`);
const runs = Number(read("--runs", "5"));
const perRun = Number(read("--per-run", "7"));
const self = fileURLToPath(import.meta.url);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ade-db-first-open-"));

const r1 = (x: number) => Math.round(x * 10) / 10;

const runMedians: number[] = [];
const all: number[] = [];
const imports: number[] = [];
try {
  for (let run = 0; run < runs; run++) {
    const opens: number[] = [];
    for (let i = 0; i < perRun; i++) {
      const dir = path.join(scratch, `${run}-${i}`, ".ade");
      fs.mkdirSync(dir, { recursive: true });
      const copy = path.join(dir, "ade.db");
      fs.copyFileSync(source, copy);
      if (fs.existsSync(`${source}-wal`)) fs.copyFileSync(`${source}-wal`, `${copy}-wal`);
      // process.execArgv carries tsx's loader, so the child runs this file the same way.
      const child = spawnSync(process.execPath, [...process.execArgv, self, "--child", copy], { encoding: "utf8" });
      if (child.status !== 0) throw new Error(`child failed (${child.status}): ${child.stderr}`);
      const result = JSON.parse(child.stdout.trim().split("\n").pop()!) as { openMs: number; importMs: number; crsqlite: boolean };
      // Without cr-sqlite the open skips most of its work; that number would not be E1.
      if (!result.crsqlite) throw new Error("cr-sqlite did not load in the child");
      opens.push(result.openMs);
      imports.push(result.importMs);
      fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    }
    all.push(...opens);
    runMedians.push(median(opens));
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(JSON.stringify({
  bench: "db-first-open",
  db: source,
  dbMB: r1(fs.statSync(source).size / 1e6),
  platform: process.platform,
  runs,
  perRun,
  runMediansMs: runMedians.map(r1),
  medianMs: r1(median(runMedians)),
  worstRunMedianMs: r1(Math.max(...runMedians)),
  worstOpenMs: r1(Math.max(...all)),
  moduleImportMedianMs: r1(median(imports)),
}));

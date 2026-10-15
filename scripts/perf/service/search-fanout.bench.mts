// cd apps/ade-cli && npx tsx ../../scripts/perf/service/search-fanout.bench.mts [projects] [docsPerProject]
// A chat search across registered projects as the brain's router runs it: one
// read-only query per project index file, a turn of the event loop between
// projects. Builds its own index files in a temp dir; reads nothing of yours.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { openSearchIndexDb } from "../../../apps/desktop/src/main/services/search/searchIndexDb";
import { querySearchIndexReadOnly } from "../../../apps/desktop/src/main/services/search/searchIndexQuery";

const projects = Number(process.argv[2] ?? 37);
const docsPerProject = Number(process.argv[3] ?? 2000);
const root = mkdtempSync(path.join(tmpdir(), "ade-perf-search-fanout-"));
const words = ["scroll", "browser", "watchdog", "lane", "merge", "retry", "token", "socket", "render", "index"];
const cacheDirs: string[] = [];
for (let p = 0; p < projects; p += 1) {
  const cacheDir = path.join(root, `p${p}`, ".ade", "cache");
  const index = openSearchIndexDb(cacheDir);
  const doc = index.db.prepare(
    "INSERT INTO docs (id, doc_id, kind, session_id, title, rank_title, snippet_source, deep_link, updated_at) VALUES (?, ?, 'chat', ?, ?, '', ?, ?, ?)",
  );
  const fts = index.db.prepare("INSERT INTO docs_fts (rowid, rank_title, body) VALUES (?, '', ?)");
  index.db.exec("BEGIN");
  for (let d = 1; d <= docsPerProject; d += 1) {
    const body = Array.from({ length: 60 }, (_, w) => words[(d * 7 + w * 3 + p) % words.length]).join(" ");
    doc.run(d, `chat:s${d % 50}:${d}`, `s${d % 50}`, `chat ${d % 50}`, body.slice(0, 200), `ade://work/session/s${d % 50}`, "2026-08-01T00:00:00.000Z");
    fts.run(d, body);
  }
  index.db.exec("COMMIT");
  index.close();
  cacheDirs.push(cacheDir);
}

const loop = monitorEventLoopDelay({ resolution: 1 });
const runs: number[] = [];
let hits = 0;
for (let run = 0; run < 5; run += 1) {
  loop.reset();
  loop.enable();
  const started = performance.now();
  hits = 0;
  for (const cacheDir of cacheDirs) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    hits += querySearchIndexReadOnly({ cacheDir, query: "scroll watchdog", kinds: ["chat"], limit: 200 })?.results.length ?? 0;
  }
  runs.push(performance.now() - started);
  loop.disable();
}
console.log(JSON.stringify({
  projects,
  docsPerProject,
  hits,
  coldMs: +runs[0]!.toFixed(1),
  warmMs: runs.slice(1).map((ms) => +ms.toFixed(1)),
  longestBlockMs: +(loop.max / 1e6).toFixed(1),
}));
rmSync(root, { recursive: true, force: true });
process.exit(0);

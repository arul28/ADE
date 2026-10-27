// cd apps/ade-cli && npx tsx ../../scripts/perf/service/roster-dirty.bench.mts --home <ADE_HOME> [--rounds 20]
//
// The roster cost while a chat streams: one project's database changes between builds (as chat
// events do: a write lands in its WAL), and the roster is rebuilt, as the fanout does at most once a
// second. Prints the clean (cache hit) and dirty build times. Writes only to a scratch table
// `perf_roster_touch` in the FIRST project's database, so point --home at a scratch home whose
// projects are copies (never ~/.ade).
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ProjectRegistry } from "../../../apps/ade-cli/src/services/projects/projectRegistry";
import { buildRosterSnapshot } from "../../../apps/ade-cli/src/services/sync/rosterBuilder";

const read = (name: string, fallback: string | null = null) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]! : fallback;
};
const home = read("--home");
if (!home) throw new Error("--home <scratch ADE_HOME> is required");
if (path.resolve(home) === path.join(homedir(), ".ade")) throw new Error("Refusing the real ~/.ade");
const rounds = Number(read("--rounds", "20"));
// --sidecar: each dirty round also rewrites one chat's sidecar by rename, as a streaming chat does.
const touchSidecar = process.argv.includes("--sidecar");
const registry = new ProjectRegistry({ adeDir: home, projectsPath: path.join(home, "projects.json") } as never);
const first = JSON.parse(readFileSync(path.join(home, "projects.json"), "utf8")).projects[0];
const writer = new DatabaseSync(path.join(first.rootPath, ".ade", "ade.db"));
writer.exec("create table if not exists perf_roster_touch (n integer)");
const sessionsDir = path.join(first.rootPath, ".ade", "cache", "chat-sessions");
const sidecarName = touchSidecar ? readdirSync(sessionsDir).find((name) => name.endsWith(".json")) : null;
const build = async () => {
  const started = performance.now();
  const snapshot = await buildRosterSnapshot({ projectRegistry: registry, scopeRegistry: { getIfBooted: () => null }, hostProjectId: null } as never);
  return { ms: performance.now() - started, chats: snapshot.reduce((sum, p) => sum + p.chats.length, 0), projects: snapshot.length };
};
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const cold = await build();
const clean: number[] = [];
const dirty: number[] = [];
for (let i = 0; i < rounds; i += 1) {
  clean.push((await build()).ms);
  writer.exec(`insert into perf_roster_touch (n) values (${i})`);
  if (sidecarName) {
    const file = path.join(sessionsDir, sidecarName);
    const body = JSON.parse(readFileSync(file, "utf8"));
    body.eventSequence = (Number(body.eventSequence) || 0) + 1;
    writeFileSync(`${file}.tmp`, JSON.stringify(body));
    renameSync(`${file}.tmp`, file);
  }
  dirty.push((await build()).ms);
}
writer.close();
console.log(JSON.stringify({
  projects: cold.projects, chats: cold.chats, coldMs: +cold.ms.toFixed(1),
  cleanMs: { median: +median(clean).toFixed(1), max: +Math.max(...clean).toFixed(1) },
  dirtyMs: { median: +median(dirty).toFixed(1), max: +Math.max(...dirty).toFixed(1) },
}));

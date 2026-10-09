// cd apps/ade-cli && npx tsx ../../scripts/perf/service/roster.bench.mts
// Builds the machine roster (every project and its chats, read from disk) six
// times: the first is cold, the rest hit the per-project disk cache. Uses a
// temp copy of $ADE_HOME/projects.json (default ~/.ade); project databases are
// only read.
import { copyFileSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { ProjectRegistry } from "../../../apps/ade-cli/src/services/projects/projectRegistry";
import { buildRosterSnapshot } from "../../../apps/ade-cli/src/services/sync/rosterBuilder";

const adeDir = mkdtempSync(path.join(tmpdir(), "ade-perf-roster-"));
copyFileSync(path.join(process.env.ADE_HOME ?? path.join(homedir(), ".ade"), "projects.json"), path.join(adeDir, "projects.json"));
const projectRegistry = new ProjectRegistry({ adeDir, projectsPath: path.join(adeDir, "projects.json") } as never);
const times: number[] = [];
let projects = 0;
let chats = 0;
for (let i = 0; i < 6; i += 1) {
  const started = performance.now();
  const snapshot = await buildRosterSnapshot({ projectRegistry, scopeRegistry: { getIfBooted: () => null }, hostProjectId: null } as never);
  times.push(performance.now() - started);
  projects = snapshot.length;
  chats = snapshot.reduce((sum, project) => sum + project.chats.length, 0);
}
console.log(JSON.stringify({ projects, chats, coldMs: +times[0]!.toFixed(1), warmMs: times.slice(1).map((t) => +t.toFixed(1)) }));

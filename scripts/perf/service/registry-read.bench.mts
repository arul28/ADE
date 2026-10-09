// cd apps/ade-cli && npx tsx ../../scripts/perf/service/registry-read.bench.mts
// Project registry reads as the brain issues them: one `get` per project (an
// aggregate project search) and 50 `list` calls. Reads a temp copy of
// $ADE_HOME/projects.json (default ~/.ade); never touches the live file.
import { copyFileSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { ProjectRegistry } from "../../../apps/ade-cli/src/services/projects/projectRegistry";

const adeDir = mkdtempSync(path.join(tmpdir(), "ade-perf-registry-"));
copyFileSync(path.join(process.env.ADE_HOME ?? path.join(homedir(), ".ade"), "projects.json"), path.join(adeDir, "projects.json"));
const reg = new ProjectRegistry({ adeDir, projectsPath: path.join(adeDir, "projects.json") } as never);
const ids = reg.list().map((p) => p.projectId);
const t0 = performance.now();
for (const id of ids) reg.get(id);
const t1 = performance.now();
for (let i = 0; i < 50; i += 1) reg.list();
const t2 = performance.now();
console.log(JSON.stringify({ projects: ids.length, getPerProjectMs: +(t1 - t0).toFixed(1), list50Ms: +(t2 - t1).toFixed(1) }));

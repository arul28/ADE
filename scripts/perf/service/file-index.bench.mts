// cd apps/ade-cli && npx tsx ../../scripts/perf/service/file-index.bench.mts [root]
// Builds the Files quick-open index for a work tree (default: this repo) and
// runs a few lookups. `buildMs` is the cost a first `@` or quick open pays.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFileService } from "../../../apps/desktop/src/main/services/files/fileService";

const root = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const service = createFileService({
  laneService: { resolveWorkspaceById: () => ({ id: "w", laneId: "l", rootPath: root }), getFilesWorkspaces: () => [] },
} as never);
const started = performance.now();
await service.warmQuickOpenIndex({ workspaceId: "w" });
const buildMs = Math.round(performance.now() - started);
const lookups: Record<string, number> = {};
for (const query of ["agentchatpane", "package.json", "readme", "docs/features", ""]) {
  const t = performance.now();
  await service.quickOpen({ workspaceId: "w", query, limit: 200 });
  lookups[query || "(browse)"] = +(performance.now() - t).toFixed(1);
}
console.log(JSON.stringify({ root, buildMs, lookupMs: lookups }));
service.dispose();
process.exit(0);

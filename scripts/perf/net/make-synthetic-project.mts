// cd apps/ade-cli && npx tsx ../../scripts/perf/net/make-synthetic-project.mts <empty-dir> [--chats 1000] [--lanes 20] [--big-turns 1000]
//
// Builds the seeded 1,000-chat project the network and phone benches use (shape and seed:
// apps/ade-cli/src/test/syntheticPerfProject.ts). Prints one JSON line with the counts and writes
// <dir>/fixture.json (projectId, bigChatId). The target directory must be empty or absent.
import os from "node:os";
import path from "node:path";
import { buildSyntheticPerfProject } from "../../../apps/ade-cli/src/test/syntheticPerfProject";

const argv = process.argv.slice(2);
if (!argv[0]) throw new Error("usage: make-synthetic-project.mts <empty-dir> [--chats N] [--lanes N] [--big-turns N]");
const flag = (name: string): number | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? Math.max(0, Number(argv[index + 1])) : undefined;
};
const root = path.resolve(argv[0]);
if (root.startsWith(path.join(os.homedir(), ".ade"))) throw new Error("Refusing to build inside ~/.ade");
const fixture = await buildSyntheticPerfProject(root, { chats: flag("--chats"), lanes: flag("--lanes"), bigTurns: flag("--big-turns") });
console.log(JSON.stringify(fixture));

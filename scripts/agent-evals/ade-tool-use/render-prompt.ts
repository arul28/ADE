// Renders the ADE text a lane chat gets (arm A), from this checkout's source,
// so the eval measures the prompt as it is now (edit the source, run again).
// One file per eval provider, named prompt-<provider>.md. run.mjs passes one
// <provider>=<runtimeKind> pair per adapter in providers.mjs (an empty kind
// means the generic text).
// Usage: tsx render-prompt.ts <outDir> <repoRoot> <provider>=<runtimeKind>...
import fs from "node:fs";
import path from "node:path";
import { buildCodingAgentSystemPrompt, type AdeRuntimeKind } from "../../../apps/desktop/src/main/services/ai/tools/systemPrompt";
import { buildAdeSessionActivityGuidance } from "../../../apps/desktop/src/shared/adeCliGuidance";

const [outDir, repoRoot, ...pairs] = process.argv.slice(2);
if (!outDir || !repoRoot || !pairs.length) throw new Error("usage: render-prompt.ts <outDir> <repoRoot> <provider>=<runtimeKind>...");
const skillRoot = path.join(repoRoot, "apps/desktop/resources/agent-skills");
const cwd = path.join(outDir, "repo");

const activity = buildAdeSessionActivityGuidance({
  sessionId: "eval-session",
  cliPath: "ade",
  shell: "posix",
  sessionIdFromEnvironment: true,
});

const runtimes = pairs.map((pair): [string, AdeRuntimeKind | undefined] => {
  const [name, kind] = pair.split("=");
  return [name, (kind || undefined) as AdeRuntimeKind | undefined];
});

for (const [name, runtime] of runtimes) {
  const text = buildCodingAgentSystemPrompt({
    cwd,
    mode: "coding",
    permissionMode: "full-auto",
    interactive: true,
    runtime,
    adeSkillRoots: [skillRoot],
    sessionActivityGuidance: activity,
  });
  fs.writeFileSync(path.join(outDir, `prompt-${name}.md`), text);
}

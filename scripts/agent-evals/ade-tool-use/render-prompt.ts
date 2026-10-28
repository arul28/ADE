// Renders the ADE text a lane chat gets, from this checkout's source, so the
// eval measures the prompt as it is now (edit the source, run again).
// Usage: tsx render-prompt.ts <outDir> <repoRoot>
import fs from "node:fs";
import path from "node:path";
import { buildCodingAgentSystemPrompt } from "../../../apps/desktop/src/main/services/ai/tools/systemPrompt";
import { buildAdeSessionActivityGuidance } from "../../../apps/desktop/src/shared/adeCliGuidance";

const [outDir, repoRoot] = process.argv.slice(2);
if (!outDir || !repoRoot) throw new Error("usage: render-prompt.ts <outDir> <repoRoot>");
const skillRoot = path.join(repoRoot, "apps/desktop/resources/agent-skills");
const cwd = path.join(outDir, "repo");

const activity = buildAdeSessionActivityGuidance({
  sessionId: "eval-session",
  cliPath: "ade",
  shell: "posix",
  sessionIdFromEnvironment: true,
});

for (const [name, runtime] of [["claude", "claude-agent-sdk-query"], ["codex", "codex-app-server"]] as const) {
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

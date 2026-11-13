// Renders the ADE text a lane chat gets (arm A), from this checkout's source,
// so the eval measures the prompt as it is now (edit the source, run again).
// One file per eval provider, named prompt-<provider>.md.
// Usage: tsx render-prompt.ts <outDir> <repoRoot>
import fs from "node:fs";
import path from "node:path";
import { buildCodingAgentSystemPrompt, type AdeRuntimeKind } from "../../../apps/desktop/src/main/services/ai/tools/systemPrompt";
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

// Qwen runs over ACP and has no runtime kind of its own; it gets the generic
// text (in ADE it gets the bootstrap in its first user turn).
const runtimes: Array<[string, AdeRuntimeKind | undefined]> = [
  ["claude", "claude-agent-sdk-query"],
  ["codex", "codex-app-server"],
  ["cursor", "cursor-sdk"],
  ["droid", "droid-sdk"],
  ["copilot", "copilot-sdk"],
  ["pi", "pi-sdk"],
  ["opencode", "opencode"],
  ["qwen", undefined],
];

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

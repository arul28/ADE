import { formatAdeAgentSkillRootsForPrompt, getAdeAgentSkillRootsForPrompt } from "./agentSkillRoots";

export function buildAdeCliAgentGuidance(skillRoots: readonly string[] = getAdeAgentSkillRootsForPrompt()): string {
  return [
  "## ADE CLI",
  "ADE is a local-first desktop development environment for lanes, chats, terminal sessions, missions, PR workflows, memory, proof/artifacts, App Control, iOS Simulator/Preview Lab state, lane-tied macOS VMs, config, and managed processes.",
  "`ade` is the default control plane for ADE-managed sessions. Use normal shell commands for immediate repo inspection/edit/test work; use ADE CLI when you need ADE state, drawer/session state, proof registration, missions, PR metadata, memory, or managed app/simulator/browser/VM control.",
  "",
  "### Discovery",
  "- Start with `ade doctor --text` when the environment is unclear.",
  "- Use typed commands with `--text` for readable output: `ade lanes list --text`, `ade missions list --text`, `ade chat list --text`, `ade prs checks <pr> --text`, `ade proof status --text`, and `ade actions list --text`.",
  "- Use `ade help <command>` and `ade help <command> <subcommand>` for exact flags. `ade actions list --text` / `ade actions run ...` is the escape hatch for service actions that do not yet have a friendly command.",
  "- If `command -v ade` fails, try `${ADE_CLI_PATH:-}` when set, then `${ADE_CLI_BIN_DIR:-}/ade`, and in an ADE source checkout fall back to `node apps/ade-cli/dist/cli.cjs ...` after confirming the file exists.",
  "- The only normal reason to skip ADE CLI for an ADE action is that the user truly does not have it installed or reachable after those fallbacks.",
  "",
  "### Skills",
  "- ADE ships Agent Skills for deeper operating details. Use the relevant skill instead of relying on trial and error: `ade-cli-control-plane`, `ade-ios-simulator`, `ade-app-control`, `ade-browser`, `ade-pr-workflows`, `ade-lanes-git`, `ade-cto-missions`, `ade-proof-artifacts`, and `ade-macos-vm`.",
  "- If skills are not auto-listed by your runtime, look for them in project/user `.agents/skills`, `.ade/skills`, `.claude/skills`, or ADE's bundled `agent-skills` resources, then read that skill's `SKILL.md` on demand.",
  `- ${formatAdeAgentSkillRootsForPrompt(skillRoots)}`,
  "- ADE also sets `ADE_AGENT_SKILLS_DIRS` for ADE-launched CLI sessions when the bundled skills root is known.",
  "",
  "### Socket-backed live surfaces",
  "- Use `--socket` when the ADE desktop drawer and the CLI must share one live session. This matters for App Control, iOS Simulator, Preview Lab, terminal logs, selection/context capture, and proof drawer updates.",
  "- Common starts: `ade --socket ios-sim status --text`, `ade --socket app-control status --text`, `ade --socket browser status --text`, and `ade --socket macos-vm status --lane <lane> --text`.",
  "",
  "### Proof and cleanup",
  "- When the user asks you to capture, send, attach, or provide proof, use the appropriate computer-use/browser/app-control tool to produce evidence, then register it with ADE via `ade proof ...` so it appears in the ADE proof drawer for the active chat, mission, or lane.",
  "- When you run processes of any kind, track what you started and clean up old, stale, or finished processes before leaving the task.",
  ].join("\n");
}

export const ADE_CLI_AGENT_GUIDANCE = buildAdeCliAgentGuidance();

export function buildAdeCliInlineGuidance(skillRoots: readonly string[] = getAdeAgentSkillRootsForPrompt()): string {
  return [
  "ADE quick orientation:",
  "- ADE is a local-first desktop development environment for lanes (git worktrees), native chats, terminals, missions, PRs, memory, proof/artifacts, App Control, iOS Simulator/Preview Lab state, and lane-tied macOS VMs.",
  "- `ade` is the default control plane for ADE-managed sessions. Use shell for the immediate repo edit/test; use ADE CLI for ADE state, drawer/session state, proof registration, memory, missions, PR metadata, and managed app/simulator/VM control.",
  "- First checks: `ade doctor --text`, `ade help <command>`, typed `ade ... --text` commands, and `ade actions list --text`. Common starts: `ade lanes list --text`, `ade chat list --text`, `ade proof status --text`.",
  "- If `command -v ade` fails, try `${ADE_CLI_PATH:-}`, then `${ADE_CLI_BIN_DIR:-}/ade`, then `node apps/ade-cli/dist/cli.cjs ...` in an ADE source checkout after confirming it exists. The only normal reason to skip ADE CLI for an ADE action is that it is truly unreachable.",
  "- ADE ships Agent Skills for deeper details. Read the relevant skill on demand instead of trial and error: `ade-cli-control-plane`, `ade-ios-simulator`, `ade-app-control`, `ade-browser`, `ade-pr-workflows`, `ade-lanes-git`, `ade-cto-missions`, `ade-proof-artifacts`, or `ade-macos-vm`.",
  `- ${formatAdeAgentSkillRootsForPrompt(skillRoots)}`,
  "- ADE also sets `ADE_AGENT_SKILLS_DIRS` for ADE-launched CLI sessions when the bundled skills root is known.",
  "- Use `--socket` when the CLI and ADE desktop drawer need the same live state: App Control, iOS Simulator, Preview Lab, terminal logs, selections/context, and proof drawer updates.",
  "- If a live app/simulator/session is missing, report the exact blocker instead of guessing. When asked for proof, register artifacts with `ade proof ...` so they appear in the ADE proof drawer, and clean up old, stale, or finished processes before leaving the task.",
  ].join("\n");
}

export const ADE_CLI_INLINE_GUIDANCE = buildAdeCliInlineGuidance();

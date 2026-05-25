import { formatAdeAgentSkillRootsForPrompt, getAdeAgentSkillRootsForPrompt } from "./agentSkillRoots";

export const adeBundledAgentSkills = [
  "ade-cli-control-plane",
  "ade-ios-simulator",
  "ade-app-control",
  "ade-browser",
  "ade-pr-workflows",
  "ade-lanes-git",
  "ade-proof-artifacts",
  "ade-macos-vm",
  "ade-deeplinks",
] as const;

export function buildAdeCliAgentGuidance(skillRoots: readonly string[] = getAdeAgentSkillRootsForPrompt()): string {
  return [
  "## ADE CLI",
  "ADE is a local-first desktop development environment for lanes, chats, terminal sessions, PR workflows, proof/artifacts, App Control, iOS Simulator/Preview Lab state, the VM tab, config, and managed processes.",
  "`ade` is the default control plane for ADE-managed sessions. Use normal shell commands for immediate repo inspection/edit/test work; use ADE CLI when you need ADE state, drawer/session state, proof registration, PR metadata, or managed app/simulator/browser/VM control.",
  "",
  "### Skills",
  "- ADE exposes Agent Skills from project, user, runtime, and bundled ADE skill roots. Use the relevant skill instead of relying on long prompt guidance.",
  `- Bundled ADE skills include: ${adeBundledAgentSkills.map((name) => `\`${name}\``).join(", ")}.`,
  "- ADE injects this guidance into ADE-hosted Work chats, Work tab CLI launches, ADE Code/TUI sessions, CTO prompts, and mobile-started work that executes through ADE's desktop or project runtime.",
  "- Skills use the Agent Skills package shape: `<skill-name>/SKILL.md` plus optional `references/`, `scripts/`, and `assets/` files. When a skill applies, read its `SKILL.md` before acting, then load referenced files only when needed.",
  "- If skills are not auto-listed by your runtime, look for them in project/user `.agents/skills`, `.ade/skills`, `.claude/skills`, or ADE's bundled `agent-skills` resources, then read that skill's `SKILL.md` on demand.",
  `- ${formatAdeAgentSkillRootsForPrompt(skillRoots)}`,
  "- ADE also sets `ADE_AGENT_SKILLS_DIRS` for ADE-launched CLI sessions when skill roots are known so CLI runtimes can discover the same skills.",
  "",
  "### Minimum operating rules",
  "- Start with `ade doctor --text` when the ADE environment is unclear. Use `ade help <command>` for exact flags and `ade actions list --text` as the escape hatch for service actions without a typed command.",
  "- If `command -v ade` fails, try `${ADE_CLI_PATH:-}` when set, then `${ADE_CLI_BIN_DIR:-}/ade`, and in an ADE source checkout fall back to `node apps/ade-cli/dist/cli.cjs ...` after confirming it exists. The only normal reason to skip ADE CLI for an ADE action is that it is truly unreachable.",
  "- Use typed commands with `--text` for readable output. Common starts: `ade lanes list --text`, `ade chat list --text`, `ade proof status --text`, and `ade actions list --text`.",
  "- Use `--socket` when the ADE desktop drawer and the CLI must share live state such as App Control, iOS Simulator, Preview Lab, browser tabs, terminal logs, selection/context capture, proof drawer updates, or macOS VM state.",
  "- When the user asks you to capture, send, attach, or provide proof, use the relevant capture tool first, then register it with ADE via `ade proof ...` so it appears in the ADE proof drawer for the active chat or lane.",
  "- When you run processes of any kind, track what you started and clean up old, stale, or finished processes before leaving the task.",
  ].join("\n");
}

export const ADE_CLI_AGENT_GUIDANCE = buildAdeCliAgentGuidance();

export function buildAdeCliInlineGuidance(skillRoots: readonly string[] = getAdeAgentSkillRootsForPrompt()): string {
  return buildAdeCliAgentGuidance(skillRoots);
}

export const ADE_CLI_INLINE_GUIDANCE = buildAdeCliInlineGuidance();

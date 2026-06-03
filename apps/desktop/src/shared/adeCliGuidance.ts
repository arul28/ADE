import { formatAdeAgentSkillRootsForPrompt, getAdeAgentSkillRootsForPrompt } from "./agentSkillRoots";

export const adeBundledAgentSkills = [
  "ade-cli-control-plane",
  "ade-ios-simulator",
  "ade-app-control",
  "ade-browser",
  "ade-pr-workflows",
  "ade-lanes-git",
  "ade-linear",
  "ade-orchestrator",
  "ade-proof-artifacts",
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
  "- When a bundled skill applies *differently* in this project (a missing flag, a port conflict, a required setup step, a workaround for a local quirk), propose appending a one-line note to `<repo>/CLAUDE.md` or `<repo>/AGENTS.md` — whichever the project already uses — so the next agent picks it up automatically. Propose the edit; do not silently write to user-curated docs. If neither file exists, ask the user which they prefer before creating one.",
  "",
  "### Minimum operating rules",
  "- Start with `ade doctor --text` when the ADE environment is unclear. Use `ade help <command>` for exact flags and `ade actions list --text` as the escape hatch for service actions without a typed command.",
  "- If `command -v ade` fails, try `${ADE_CLI_PATH:-}` when set, then `${ADE_CLI_BIN_DIR:-}/ade`, and in an ADE source checkout fall back to `node apps/ade-cli/dist/cli.cjs ...` after confirming it exists. The only normal reason to skip ADE CLI for an ADE action is that it is truly unreachable.",
  "- Use typed commands with `--text` for readable output. Common starts: `ade lanes list --text`, `ade chat list --text`, `ade proof status --text`, and `ade actions list --text`.",
  "- Automations, Linear webhook ingress, and macOS VM are internal/coming-soon in production builds. Do not use `ade automations`, `ade linear ingress`, or `ade macos-vm` unless the user explicitly asks and the matching internal override env var is set.",
  "- Use `--socket` when the ADE desktop drawer and the CLI must share live state such as App Control, iOS Simulator, Preview Lab, browser tabs, terminal logs, selection/context capture, proof drawer updates, or macOS VM state.",
  "- If any task needs a browser, web page, localhost preview, login-backed site, screenshot, DOM inspection, form fill, click, or navigation, use ADE's built-in browser through `ade --socket browser ...` and read the `ade-browser` skill before trying an external browser/tool. Start with `ade --socket browser tabs --text`; reuse this chat's owned tab/session, or run plain `ade --socket browser open <url> --text` to reuse/create one in the background. Use `--new-tab` only when the task truly needs another tab and `--panel` only when the user should see it.",
  "- When the user asks you to capture, send, attach, or provide proof, use the relevant capture tool first, then register it with ADE via `ade proof ...` so it appears in the ADE proof drawer for the active chat or lane.",
  "- When you run processes of any kind, track what you started and clean up old, stale, or finished processes before leaving the task.",
  ].join("\n");
}

export const ADE_CLI_AGENT_GUIDANCE = buildAdeCliAgentGuidance();

export function buildAdeCliInlineGuidance(skillRoots: readonly string[] = getAdeAgentSkillRootsForPrompt()): string {
  return buildAdeCliAgentGuidance(skillRoots);
}

export const ADE_CLI_INLINE_GUIDANCE = buildAdeCliInlineGuidance();

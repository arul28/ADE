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
  "ade-search",
] as const;

/**
 * @deprecated Superseded by {@link buildAdeBootstrapGuidance}. Kept as a thin alias so
 * existing call sites stay wired to the (now minimal) bootstrap. The previous ~1,000-token
 * blob is gone: ADE's capabilities are delivered as Agent Skills that each runtime discovers
 * natively (progressive disclosure), seeded by `skillReseedService`. Do not re-grow this.
 */
export function buildAdeCliAgentGuidance(skillRoots: readonly string[] = getAdeAgentSkillRootsForPrompt()): string {
  return buildAdeBootstrapGuidance(skillRoots);
}

export const ADE_CLI_AGENT_GUIDANCE = buildAdeCliAgentGuidance();

export function buildAdeCliInlineGuidance(skillRoots: readonly string[] = getAdeAgentSkillRootsForPrompt()): string {
  return buildAdeCliAgentGuidance(skillRoots);
}

export const ADE_CLI_INLINE_GUIDANCE = buildAdeCliInlineGuidance();

/**
 * Minimal always-on bootstrap that replaces the heavier {@link buildAdeCliAgentGuidance}
 * blob. It teaches the habit (reach for the matching `ade-*` skill on demand) and the
 * ground-truth fallback (`ade help` / `ade actions list`) instead of inlining every
 * socket/browser/proof rule on every turn — those now live in their skills, which each
 * runtime discovers natively (progressive disclosure). Keep this short; do not re-grow it.
 */
export function buildAdeBootstrapGuidance(
  skillRoots: readonly string[] = getAdeAgentSkillRootsForPrompt(),
): string {
  return [
    "## ADE",
    "You're working inside ADE, a local-first dev environment (lanes, chats, terminals, PRs, proof/artifacts, app & iOS-simulator & browser control). The `ade` CLI is your control plane for ADE state — it is not in your training data, so consult `ade help <command>` rather than guessing command syntax.",
    "Your ADE capabilities ship as Agent Skills. When a task touches an ADE area (lanes/git, PRs, proof & screenshots, the built-in browser, iOS simulator, app control, Linear, deeplinks, or searching across everything in ADE), read the matching `ade-*` skill before acting; otherwise ignore them.",
    `Skills: ${adeBundledAgentSkills.map((name) => `\`${name}\``).join(", ")}.`,
    formatAdeAgentSkillRootsForPrompt(skillRoots),
    "If the direct `mcp__computer_use` tools are present, use them for Codex Computer Use and honor their per-app approvals; do not initialize `@oai/sky` through `node_repl` as a substitute.",
    "Ground truth for any `ade` invocation is `ade help <command>` and `ade actions list --text`; prefer typed commands with `--text`. Project secrets are available through `ade secrets`; read only the named secret the user asks you to use and avoid printing secret values. Track and clean up processes you start.",
  ].join("\n");
}

export const ADE_BOOTSTRAP_GUIDANCE = buildAdeBootstrapGuidance();

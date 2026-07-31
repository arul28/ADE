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
  "ade-mosaic",
] as const;

/**
 * The status protocol agents actually get. Note what is NOT here: settling.
 * `ade chat settle` was removed in 2026-07 — deciding that work is finished is
 * a subjective call agents are unreliable at, and a self-settling chat drops
 * out of the user's active list on the agent's say-so. Rows leave the active
 * list when the user settles them or when their PR merges. Keep this guidance
 * pointed at note/ask; do not re-add settle instructions.
 */
export const ADE_SESSION_STATUS_PROTOCOL_GUIDANCE = [
  "ADE control protocol for truthful Work status:",
  '- Working: `ade chat note "running e2e shard 2/4"`; state the concrete work and next dependency, never just "Working" or "Blocked".',
  '- Blocked on user input: first `ade chat note "<what is blocked and why>"`, then `ade chat ask "<the exact question>"`; a note alone can leave an idle row looking Done.',
  "- The next accepted user message clears the prior hand-raise. If it does not resolve the blocker, update the note and call `ade chat ask` again before ending the turn.",
  '- Done: say so in your final message and leave a durable one-line result via `ade chat note "<delivered result>"`.',
  "- You cannot settle or unsettle a session; `ade chat settle` / `ade session settle` no longer exist. Filing a row as done is the user's call, or the automatic result of its PR merging.",
  "- Waiting on something you expect to take a while? `ade session snooze <id> --for <duration>` quiets the row without claiming the work is done, and a hand-raise wakes it early.",
].join("\n");

/**
 * @deprecated Superseded by {@link buildAdeBootstrapGuidance}. Kept as a thin alias so
 * existing call sites stay wired to the (now minimal) bootstrap. The previous ~1,000-token
 * blob is gone: ADE's capabilities are delivered as session-scoped Agent Skills, with
 * `ade skill show` as the runtime-independent activation fallback. Do not re-grow this.
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
 * runtime discovers natively when it supports extra roots. Keep this short; do not re-grow it.
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
    "If your runtime does not expose those skills natively, use `ade skill list --text` to discover them and `ade skill show <name> --text` to load one on demand.",
    "If the direct `mcp__computer_use` tools are present, use them for Codex Computer Use and honor their per-app approvals; do not initialize `@oai/sky` through `node_repl` as a substitute.",
    "Ground truth for any `ade` invocation is `ade help <command>` and `ade actions list --text`; prefer typed commands with `--text`. Project secrets are available through `ade secrets`; read only the named secret the user asks you to use and avoid printing secret values. Track and clean up processes you start.",
    "`ade chat scheduled-work create` schedules durable self-resume for bound chats and tracked provider CLIs.",
    ADE_SESSION_STATUS_PROTOCOL_GUIDANCE,
  ].join("\n");
}

export const ADE_BOOTSTRAP_GUIDANCE = buildAdeBootstrapGuidance();

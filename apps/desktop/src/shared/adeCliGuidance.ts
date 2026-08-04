import { MAX_STATUS_NOTE_CHARACTERS, STATUS_NOTE_GUIDELINE_WORDS } from "./sessionStatusNote";
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
  `- Working: \`ade chat note "testing desktop auth fallback"\`; aim for ${STATUS_NOTE_GUIDELINE_WORDS} words or fewer — a guideline, not a hard limit. Notes truncate past ${MAX_STATUS_NOTE_CHARACTERS} characters, so a long note still beats no note.`,
  '- Blocked on input: call `ade chat note "<what and why>"`, then `ade chat ask "<the exact question>"`; a note alone can leave an idle row looking Done.',
  "- The next accepted user message clears the prior hand-raise. Re-note and re-ask before ending if still blocked.",
  '- Done: report it and leave `ade chat note "<delivered result>"`.',
  "- You cannot settle or unsettle a session; that is the user's call, or the automatic result of its PR merging.",
  "- Waiting a while? `ade session snooze <id> --for <duration>` hides the row without claiming done; a hand-raise wakes it.",
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
    "ADE is a local-first dev environment for lanes, chats, terminals, PRs, proof, apps, iOS, and browsers. Its `ade` CLI controls ADE state; use `ade help <command>` instead of guessing.",
    "ADE capabilities ship as Agent Skills. For ADE tasks, read the matching `ade-*` skill before acting.",
    `Skills: ${adeBundledAgentSkills.map((name) => `\`${name}\``).join(", ")}.`,
    formatAdeAgentSkillRootsForPrompt(skillRoots),
    "If skills are not native, discover with `ade skill list --text` and load with `ade skill show <name> --text`.",
    "For Codex Computer Use, prefer direct `mcp__computer_use` tools and honor per-app approvals; never substitute `@oai/sky` via `node_repl`.",
    "CLI ground truth: `ade help <command>` and `ade actions list --text`; prefer typed commands with `--text`. Read only requested `ade secrets`, never print them, and clean up started processes.",
    "`ade chat scheduled-work create` durably resumes bound chats and tracked provider CLIs.",
    ADE_SESSION_STATUS_PROTOCOL_GUIDANCE,
  ].join("\n");
}

export const ADE_BOOTSTRAP_GUIDANCE = buildAdeBootstrapGuidance();

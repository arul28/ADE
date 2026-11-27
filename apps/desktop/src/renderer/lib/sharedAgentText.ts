import { BRAND } from "../../shared/brand";
// Type only: agentSkillRoots pulls in node:path, which the renderer must not load.
import type { BundledAgentSkillName } from "../../shared/agentSkillRoots";

/**
 * The CLI command for text the renderer writes for an agent (drafts sent as
 * the person's message, automation templates, kickoff prompts). That text may
 * run on another machine still on an older version, or later from a saved
 * rule, so it uses the name every version understands. See
 * `BRAND.AGENT_CLI_FOR_SHARED_TEXT`.
 */
export const SHARED_TEXT_CLI = BRAND.AGENT_CLI_FOR_SHARED_TEXT;

/**
 * A bundled skill's name for that same text: `daex-linear` → `ade-linear`
 * while `SHARED_TEXT_CLI` is `ade`. Every `daex-<x>` skill has an `ade-<x>`
 * entry in `LEGACY_BUNDLED_AGENT_SKILL_ALIASES`, which new machines resolve,
 * and older machines only know the `ade-<x>` name.
 */
export function sharedTextSkillName(name: BundledAgentSkillName): string {
  return `${SHARED_TEXT_CLI}-${name.slice("daex-".length)}`;
}

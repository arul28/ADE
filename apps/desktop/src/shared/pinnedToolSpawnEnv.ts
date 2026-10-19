/**
 * Vendor self-update switches for ADE's pinned provider copies.
 *
 * ADE runs its own pinned, checksum-verified copy of every agent CLI and moves
 * that pin itself. A copy that updated itself in place would run a version ADE
 * never tested and leave the tools cache holding bytes that no longer match
 * the pin, so every place that starts one (chat runtimes, auth probes, model
 * discovery, one-shot tasks, terminals) applies the same switches from here.
 *
 * Keyed by tools-cache name (`claude-code`, `codex`, ...). Devin, Antigravity
 * and Muse have no switch: none was found, and their updaters do not touch
 * ADE's layout. Codex has no environment switch; its config flag is
 * {@link CODEX_NO_UPDATE_CHECK_ARGS}. Grok also takes {@link GROK_NO_AUTO_UPDATE_ARG}.
 *
 * Pure data, no Node imports: the renderer-side launch builders read it too.
 */

const SELF_UPDATE_ENV: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "claude-code": { DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_AUTOUPDATER_DISABLED_BY_HOST: "1" },
  // The SDK already passes --no-auto-update to its runtime; the variable also
  // covers the terminal CLI.
  copilot: { COPILOT_AUTO_UPDATE: "false" },
  "copilot-cli": { COPILOT_AUTO_UPDATE: "false" },
  opencode: { OPENCODE_DISABLE_AUTOUPDATE: "1" },
  droid: { FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" },
  grok: { GROK_DISABLE_AUTOUPDATER: "1" },
  kimi: { KIMI_CODE_NO_AUTO_UPDATE: "1" },
  // Skips the update check for this launch. ADE's system-defaults file also
  // sets `general.enableAutoUpdate: false` (qwenSkillDefaults.ts).
  qwen: { QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: "true" },
  pi: { PI_SKIP_VERSION_CHECK: "1" },
};

/** The tools-cache name of each provider's pinned tool, where they differ. */
const PROVIDER_TOOL: Readonly<Record<string, string>> = {
  claude: "claude-code",
};

/** `codex` global flags that turn its startup update check off. */
export const CODEX_NO_UPDATE_CHECK_ARGS: readonly string[] = ["-c", "check_for_update_on_startup=false"];

/** Grok's flag for the same, passed before its subcommand. */
export const GROK_NO_AUTO_UPDATE_ARG = "--no-auto-update";

/** The variables that keep the pinned copy of `tool` (a tools-cache name) from updating itself. */
export function pinnedToolSelfUpdateEnv(tool: string): Record<string, string> {
  return { ...(SELF_UPDATE_ENV[tool] ?? {}) };
}

/** The same, keyed by ADE provider id (`claude`, `codex`, `qwen`, ...). */
export function providerSelfUpdateEnv(provider: string): Record<string, string> {
  return pinnedToolSelfUpdateEnv(PROVIDER_TOOL[provider] ?? provider);
}

/**
 * The environment half of Grok's approval neutralization.
 *
 * It lives in `shared/` because both Grok launch paths need the identical
 * value: the ACP dialect's spawn plan
 * (`main/services/chat/acpHost/acpDialects/grok.ts`) and the tracked-CLI
 * launcher (`shared/cliLaunch.ts`).
 *
 * ## What the variable does
 *
 * Grok merges permission RULES from several sources and evaluates MODE flags
 * only AFTER those rules, so no CLI flag, `startupHints` value, or ACP `_meta`
 * field can force ask-always on its own. One of the merged sources is the
 * user's `~/.claude/settings.json`; its `permissions.defaultMode` — not the
 * allow rules beside it — is what seeds Grok's auto-classifier and silently
 * approves file writes inside ADE.
 *
 * Grok's `permission/claude_settings.rs::is_claude_import_marked` reads this
 * variable and, when it is set, skips both `resolve_permissions_with_provenance`
 * and `load_claude_env_with_project`. With it set, `grok inspect` reports
 * `Permissions └ Source: (none) └ 0 loaded`, and a cwd write raises a real
 * `session/request_permission` that ADE can reject.
 *
 * ## Both halves are required
 *
 * - `--permission-mode <mode>` cancels the user's own `~/.grok/config.toml`
 *   `[ui] permission_mode`.
 * - `_GROK_CLAUDE_MARKER_OVERRIDE=1` cancels the Claude settings import.
 *
 * A live six-arm probe on Grok 1.0.13 proved neither half works alone:
 * dropping the mode flag re-broke approvals even with the variable set, and the
 * mode flag alone was the state that shipped while writes still auto-approved.
 *
 * ## Why this route and not the config route
 *
 * Setting `[claude_compat] imported = true` in `~/.grok/config.toml`
 * neutralizes the permission import too, but it additionally strips every
 * Claude-derived capability: skills 50 -> 47, agents 11 -> 3, MCP servers
 * 4 -> 2. The environment variable is surgical — skills, agents, MCP servers,
 * and `Claude.md` all still load. It also writes nothing to the user's machine.
 *
 * ## Risk
 *
 * The leading underscore is Grok's own convention for a vendor-internal hatch.
 * It is undocumented and may be renamed or removed in any release, and Grok
 * ships roughly daily. ADE therefore never trusts it blindly: the preflight in
 * `main/services/ai/grokPermissionPreflight.ts` verifies the effect against
 * `grok inspect`, and the provider-agnostic supervision invariant in
 * `acpHost/acpSupervisionGuard.ts` catches the failure at runtime if the
 * preflight is somehow wrong.
 */

/** Name of Grok's undocumented Claude-import kill switch. */
export const GROK_CLAUDE_MARKER_OVERRIDE_ENV = "_GROK_CLAUDE_MARKER_OVERRIDE";

/**
 * Environment ADE adds to every Grok child process.
 *
 * Always pair it with `--permission-mode`; see the module comment for why
 * neither half works alone.
 */
export function grokSupervisionEnv(): Record<string, string> {
  return { [GROK_CLAUDE_MARKER_OVERRIDE_ENV]: "1" };
}

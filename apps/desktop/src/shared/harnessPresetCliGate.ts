/**
 * Which harnesses accept a preset when the launch is a tracked CLI.
 *
 * A chat launched through ADE's SDK/app-server adapters gets its environment
 * from ADE. A tracked CLI is the vendor's own terminal binary, and three of them
 * — Cursor, Copilot and Kimi — take their identity from a sign-in they own and
 * expose no documented way to hand them a different key or endpoint per
 * launch. (Grok used to be here; its CLI reads custom models from
 * `$GROK_HOME/config.toml`, which a routed launch points at an ADE-owned home.)
 *
 * The locked rule, and why it is a gate rather than an error: launching those
 * CLIs natively is a *working* session. Failing the launch because a preset was
 * attached would take away a capability the user already had, to protect a
 * capability that never existed there. So the preset is dropped, the reason is
 * logged and shown, and the native CLI starts.
 *
 * The other half of the rule is the list surface: CLI mode lists presets and
 * routes for every other harness, and shows these three as unavailable with
 * this reason, so a user cannot pick one and then discover it was ignored.
 */

/** Harnesses whose CLI cannot be pointed at a preset's brain. */
export const CLI_PRESET_GATED_HARNESSES = ["cursor", "copilot", "kimi"] as const;

export type CliPresetGatedHarness = (typeof CLI_PRESET_GATED_HARNESSES)[number];

export function isCliPresetGatedHarness(provider: string): provider is CliPresetGatedHarness {
  return (CLI_PRESET_GATED_HARNESSES as readonly string[]).includes(provider);
}

const GATE_REASONS: Record<CliPresetGatedHarness, string> = {
  cursor: "The Cursor CLI signs in with the one key its own store holds, so this session runs on Cursor's own sign-in.",
  copilot: "The Copilot CLI signs in through GitHub itself, so this session runs on Copilot's own sign-in.",
  kimi: "The Kimi CLI reads its own config home, so this session runs on Kimi's own sign-in.",
};

/**
 * One sentence for a CLI launch that had a preset attached, or `null` when the
 * harness takes one. Used for both the log line and the in-chat notice.
 */
export function cliPresetGateReason(provider: string): string | null {
  return isCliPresetGatedHarness(provider) ? GATE_REASONS[provider] : null;
}

/**
 * Per-platform availability of agent providers.
 *
 * Only Cursor is gated today. Claude, Codex, Droid and OpenCode all ship
 * runtimes for every target ADE builds, so they are unconditionally supported
 * and deliberately absent from this module.
 */

/**
 * `@cursor/sdk` publishes its native runtime as optional platform packages.
 * As of `@cursor/sdk@1.0.23` those are `darwin-arm64`, `darwin-x64`,
 * `linux-arm64`, `linux-x64` and `win32-x64` — there is no `win32-arm64`.
 * ADE's Cursor provider is built entirely on that SDK, so on Windows on ARM the
 * provider cannot load at all: every chat, model discovery and auth probe would
 * fail at `import("@cursor/sdk")`.
 *
 * Rather than ship a provider that is present and permanently broken, ADE hides
 * Cursor on that one target. This is an SDK packaging gap, not a Cursor gap —
 * Cursor's own CLI installer does support Windows ARM64.
 *
 * REVISIT: when `@cursor/sdk` adds a `win32-arm64` optional dependency, delete
 * this gate along with its callers and its `scripts/platform-gate-baseline.json`
 * entry. Check with:
 *   npm view @cursor/sdk optionalDependencies
 */
export const CURSOR_WINDOWS_ARM_BLOCKER =
  "Cursor is not available on Windows on ARM — @cursor/sdk has no win32-arm64 build. "
  + "Use Claude, Codex, Droid or OpenCode on this machine.";

/**
 * Returns false only on win32/arm64. Every other platform/arch pair — including
 * win32/x64 and all of darwin — is unchanged.
 *
 * Both arguments are injectable so callers in the main process can pass
 * `process.platform`/`process.arch` and tests can pass whatever they like; the
 * renderer passes the values the preload bridge captured from the main process.
 */
export function isCursorProviderSupported(platform: string, arch: string): boolean {
  return !(platform === "win32" && arch === "arm64");
}

/**
 * Why this provider is unavailable on this platform/arch pair, or null.
 *
 * The reason travels WITH the gate, so a caller that refuses a provider never
 * has to name it. A caller that gated on a boolean and then hard-coded
 * `CURSOR_WINDOWS_ARM_BLOCKER` as the reason is correct only while Cursor is
 * the one gated provider; the second one added would have been refused with
 * Cursor's sentence.
 */
export function providerUnavailableReason(
  provider: string,
  platform: string,
  arch: string,
): string | null {
  if (provider !== "cursor") return null;
  return isCursorProviderSupported(platform, arch) ? null : CURSOR_WINDOWS_ARM_BLOCKER;
}

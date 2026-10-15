/**
 * The Claude Code version this machine last reported, from the `system/init`
 * message every Claude process sends (a chat's or the settings probe's).
 * ADE usually runs its pinned copy, but it can fall back to one on the PATH,
 * so the version Claude reports is the one worth showing.
 */
let reportedVersion: string | null = null;

export function noteClaudeCodeVersion(version: unknown): void {
  if (typeof version !== "string") return;
  const trimmed = version.trim();
  if (trimmed) reportedVersion = trimmed;
}

export function reportedClaudeCodeVersion(): string | null {
  return reportedVersion;
}

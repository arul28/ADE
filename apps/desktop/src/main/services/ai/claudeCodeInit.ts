import {
  CLAUDE_AGENT_SDK_TOOL_PROFILE,
  claudeToolProfileFromInitTools,
  type ClaudeBuiltinToolProfile,
} from "../../../shared/claudeBuiltinAgentPrompts";

/**
 * What this machine's Claude Code last reported in the `system/init` message
 * every Claude process sends (a chat's or the settings probe's): its version,
 * and the tools it gives agents. ADE usually runs its pinned copy, but it can
 * fall back to one on the PATH, so what Claude reports is what is worth using.
 */
let reportedVersion: string | null = null;
let reportedToolProfile: ClaudeBuiltinToolProfile | null = null;

export function noteClaudeCodeInit(init: { claude_code_version?: unknown; tools?: unknown }): void {
  if (typeof init.claude_code_version === "string" && init.claude_code_version.trim()) {
    reportedVersion = init.claude_code_version.trim();
  }
  // The machine's tools, read only from a chat that has the full set: the
  // settings probe runs with none, and a chat that narrowed its tools says
  // nothing about the rest.
  const tools = Array.isArray(init.tools) ? init.tools : [];
  if (tools.includes("Write") && tools.includes("Edit")) {
    reportedToolProfile = claudeToolProfileFromInitTools(tools) ?? reportedToolProfile;
  }
}

export function reportedClaudeCodeVersion(): string | null {
  return reportedVersion;
}

/**
 * The tools Claude gives agents here, or null when that is not known. Before
 * any report, macOS and Linux are the Agent SDK's known set; on Windows the
 * shell depends on whether Git Bash is installed, so it stays unknown.
 */
export function claudeToolProfileOrNull(): ClaudeBuiltinToolProfile | null {
  return reportedToolProfile ?? (process.platform === "win32" ? null : CLAUDE_AGENT_SDK_TOOL_PROFILE);
}

/** The same, falling back to the Agent SDK's usual set where it is not known. */
export function claudeToolProfileBestGuess(): ClaudeBuiltinToolProfile {
  return claudeToolProfileOrNull() ?? CLAUDE_AGENT_SDK_TOOL_PROFILE;
}

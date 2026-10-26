import type {
  AgentChatCodexApprovalPolicy,
  AgentChatCodexConfigSource,
  AgentChatCodexSandbox,
  AgentChatDroidPermissionMode,
  AgentChatMusePermissionMode,
  AgentChatPermissionMode,
  PtySendToSessionArgs,
  TerminalResumeLaunchConfig,
  TerminalResumeMetadata,
  TerminalSessionSummary,
  TerminalToolType,
  WindowsShellKind,
} from "./types";
import type { ProviderInstanceProvider } from "./types/providerInstances";
import {
  isBaseProviderInstance,
  isProviderInstanceProvider,
  PROVIDER_INSTANCE_ENV_KEY,
} from "./types/providerInstances";
import {
  AGENT_CHAT_MUSE_PERMISSION_MODE_VALUES,
  AGENT_CHAT_PERMISSION_MODE_VALUES,
  droidPermissionModeFromLegacyPermissionMode,
  museCliApprovalFlag,
} from "./types/chat";
import {
  ADE_AGENT_SKILLS_DIRS_ENV,
  getAdeAgentSkillRootsForPrompt,
  getAgentSkillRootCandidates,
  joinAdeAgentSkillRoots,
} from "./agentSkillRoots";
import {
  buildAdeCliSessionGuidance,
  buildAdePosixTrackedCliActivityGuidance,
  buildAdeWindowsTrackedCliActivityGuidance,
} from "./adeCliGuidance";
import { isProviderSlashCommandInput } from "./chatSlashCommands";
import { PI_READ_ONLY_TOOLS, PI_SEARCH_TOOLS } from "./piTools";
import { resolveClaudeCliModelAlias } from "./claudeCliModels";
import { grokSupervisionEnv } from "./grokSupervision";
import { decodeOpenCodeRegistryId, decodePiRegistryId } from "./modelRegistry";
import { musePermissionModeFromLegacyPermissionMode } from "./modelPermissions";
import { PI_THINKING_LEVELS } from "./piThinkingLevels";
import { PROVIDER_DISPLAY_NAME } from "./providers";
import { commandArrayToLine, parseCommandLine, quoteShellArg } from "./shell";

export { PI_THINKING_LEVELS } from "./piThinkingLevels";

export type CliProvider =
  | "claude"
  | "codex"
  | "cursor"
  | "droid"
  | "opencode"
  | "pi"
  | "muse"
  | "qwen"
  | "kimi"
  | "grok"
  | "copilot"
  | "devin";
export type LaunchProfile = CliProvider | "shell";
export type TrackedCliLaunchCommand = {
  command?: string;
  args: string[];
  startupCommand: string;
  initialInput?: string;
  initialInputDelayMs?: number;
  env?: Record<string, string>;
  /** Provider-native session id ADE assigned at launch, when the CLI accepts one. */
  assignedSessionId?: string;
};

export type CodexComputerUseCliConfig = {
  command: string;
  args?: readonly string[];
};

/**
 * The user's own MCP servers as one tracked Claude or Codex CLI should start
 * them, resolved in the main process (`trackedCliUserMcp.ts`): the machine
 * login's servers an ADE account's config home lacks, and `npx` servers
 * re-pointed at the package npx already installed. Each entry replaces the
 * CLI's own server of that name. Nothing secret rides here: a tracked CLI's
 * command can be typed into the terminal as text, so Claude's servers are a
 * file path and Codex's are the entries with no secret in them.
 */
export type TrackedCliUserMcp = {
  /** `mcp_servers.<name>` overlay keys for Codex (`-c mcp_servers.<name>.<key>=…`). */
  codex?: Record<string, Record<string, unknown>> | null;
  /** A private ADE-owned file holding Claude's servers, for `--mcp-config <path>`. */
  claudeConfigPath?: string | null;
};

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

/** One JSON value as TOML: strings, numbers, booleans, string arrays, and flat string tables. */
function tomlValue(value: unknown): string | null {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.every((entry) => typeof entry === "string") ? JSON.stringify(value) : null;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.every(([, entry]) => typeof entry === "string")) return null;
    return `{ ${entries.map(([key, entry]) => `${JSON.stringify(key)} = ${JSON.stringify(entry)}`).join(", ")} }`;
  }
  return null;
}

/** The launch flags that hand a tracked CLI the user's own servers; none for other providers. */
export function trackedCliUserMcpFlags(provider: string, userMcp: TrackedCliUserMcp | null | undefined): string[] {
  if (provider === "codex" && userMcp?.codex) {
    const flags: string[] = [];
    for (const [name, entry] of Object.entries(userMcp.codex)) {
      // A name TOML cannot take bare is a basic-string key, as Codex writes it.
      const tomlName = TOML_BARE_KEY.test(name) ? name : JSON.stringify(name);
      for (const [key, value] of Object.entries(entry)) {
        const toml = TOML_BARE_KEY.test(key) ? tomlValue(value) : null;
        if (toml != null) flags.push("-c", `mcp_servers.${tomlName}.${key}=${toml}`);
      }
    }
    return flags;
  }
  if (provider === "claude" && userMcp?.claudeConfigPath) {
    return ["--mcp-config", userMcp.claudeConfigPath];
  }
  return [];
}

export type CleanShellLaunchFields = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

function unquoteWindowsShellPath(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export type WindowsShellLaunchMode = "interactive" | "clean" | "login";

export function resolveWindowsShellKind(command: string): WindowsShellKind | null {
  const normalized = command.replace(/\//g, "\\");
  if (/^\\\\(?:wsl\$|wsl\.localhost)\\/i.test(normalized)) return null;
  const basename = normalized.split("\\").pop()?.toLowerCase() ?? "";
  if (basename === "powershell" || basename === "powershell.exe" || basename === "pwsh" || basename === "pwsh.exe") {
    return "powershell";
  }
  if (basename === "cmd" || basename === "cmd.exe") return "cmd";
  if (
    (basename === "bash" || basename === "bash.exe")
    && /^(?:[a-z]:\\|\\\\).+\\(?:bin|usr\\bin)\\bash(?:\.exe)?$/i.test(normalized)
  ) {
    return "git-bash";
  }
  return null;
}

/**
 * Resolve an explicitly configured native Windows shell. `bash.exe` is only
 * accepted from a Git for Windows installation: the Windows App Execution
 * Alias historically used that name to enter WSL, which ADE intentionally
 * does not support as a local runtime.
 */
export function resolveWindowsShellLaunchFields(
  value: string | null | undefined,
  options: { mode?: WindowsShellLaunchMode } = {},
): CleanShellLaunchFields | null {
  const command = unquoteWindowsShellPath(value);
  if (!command) return null;
  const kind = resolveWindowsShellKind(command);
  const mode = options.mode ?? "interactive";
  if (kind === "powershell") {
    return {
      command,
      args: mode === "clean" ? ["-NoLogo", "-NoProfile"] : [],
    };
  }
  if (kind === "cmd") {
    return {
      command,
      args: mode === "clean" ? ["/d"] : [],
    };
  }
  if (kind === "git-bash") {
    return mode === "clean"
      ? { command, args: ["--noprofile", "--norc"], env: { BASH_ENV: "" } }
      : { command, args: mode === "login" ? ["--login"] : [] };
  }
  return null;
}

export type PtyContinuationLaunchFields = Pick<
  PtySendToSessionArgs,
  | "model"
  | "reasoningEffort"
  | "fastMode"
  | "permissionMode"
  | "codexApprovalPolicy"
  | "codexSandbox"
  | "codexConfigSource"
>;

export type CliIdentityResumeMetadataArgs = {
  provider: TerminalResumeMetadata["provider"];
  targetId: string | null;
  permissionMode: NonNullable<TerminalResumeLaunchConfig["permissionMode"]>;
  droidPermissionMode?: TerminalResumeLaunchConfig["droidPermissionMode"];
  musePermissionMode?: TerminalResumeLaunchConfig["musePermissionMode"];
  model: string | null;
  reasoningEffort: string | null;
  fastMode: boolean | null;
  fastTier?: "ultrafast" | null;
  instanceId?: string | null;
  presetId?: string | null;
  credentialId?: string | null;
};

/** Build the durable identity metadata shared by local and sync CLI launches. */
export function buildCliIdentityResumeMetadata(
  args: CliIdentityResumeMetadataArgs,
): TerminalResumeMetadata | null {
  const instanceId = args.instanceId?.trim() || null;
  const presetId = args.presetId?.trim() || null;
  const credentialId = args.credentialId?.trim() || null;
  const identity = {
    ...(instanceId ? { instanceId } : {}),
    ...(presetId ? { presetId } : {}),
    ...(credentialId ? { credentialId } : {}),
  };
  if (Object.keys(identity).length === 0) return null;

  return {
    provider: args.provider,
    targetKind: args.provider === "codex" ? "thread" : "session",
    targetId: args.targetId,
    launch: {
      permissionMode: args.permissionMode,
      ...(args.droidPermissionMode !== undefined ? { droidPermissionMode: args.droidPermissionMode } : {}),
      ...(args.musePermissionMode !== undefined ? { musePermissionMode: args.musePermissionMode } : {}),
      model: args.model,
      reasoningEffort: args.reasoningEffort,
      fastMode: args.fastMode,
      ...(args.fastMode === true && args.fastTier === "ultrafast" ? { fastTier: "ultrafast" as const } : {}),
      ...identity,
    },
    // Mirror the ids so older readers and the resume path can recover the
    // selected identity without reconstructing the original launch request.
    ...identity,
  };
}

export function buildPtyContinuationLaunchFields(
  launch: TerminalResumeLaunchConfig | null | undefined,
): PtyContinuationLaunchFields {
  return {
    ...(launch?.model?.trim() ? { model: launch.model.trim() } : {}),
    ...(launch?.reasoningEffort?.trim() ? { reasoningEffort: launch.reasoningEffort.trim() } : {}),
    ...(typeof launch?.fastMode === "boolean"
      ? { fastMode: launch.fastMode }
      : typeof launch?.codexFastMode === "boolean"
        ? { fastMode: launch.codexFastMode }
        : {}),
    ...(launch?.permissionMode ? { permissionMode: launch.permissionMode } : {}),
    ...(launch?.codexApprovalPolicy ? { codexApprovalPolicy: launch.codexApprovalPolicy } : {}),
    ...(launch?.codexSandbox ? { codexSandbox: launch.codexSandbox } : {}),
    ...(launch?.codexConfigSource ? { codexConfigSource: launch.codexConfigSource } : {}),
  };
}

export const LAUNCH_PROFILES = [
  "claude",
  "codex",
  "cursor",
  "droid",
  "opencode",
  "pi",
  "muse",
  "qwen",
  "kimi",
  "grok",
  "copilot",
  "devin",
  "shell",
] as const satisfies readonly LaunchProfile[];
export const TRACKED_CLI_PERMISSION_MODES = AGENT_CHAT_PERMISSION_MODE_VALUES;

export function sanitizeTrackedCliResumeTargetId(value: string | null | undefined): string | null {
  const target = String(value ?? "").trim();
  if (!target) return null;
  if (/[\x00-\x1F\x7F]/.test(target)) return null;
  if (target.startsWith("-")) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@%+=,/-]*$/.test(target)) return null;
  return target;
}

/** Maps a `launchPtySession` profile to the `TerminalToolType` recorded on the session. */
export const LAUNCH_PROFILE_TOOL_TYPE: Record<LaunchProfile, TerminalToolType> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor-cli",
  droid: "droid",
  opencode: "opencode",
  pi: "pi",
  muse: "muse",
  qwen: "qwen",
  kimi: "kimi",
  grok: "grok",
  copilot: "copilot",
  devin: "devin",
  shell: "shell",
};

/** Default human-readable tab title for a launch profile. */
export const LAUNCH_PROFILE_TITLE: Record<LaunchProfile, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor Agent CLI",
  droid: "Factory Droid CLI",
  opencode: "OpenCode CLI",
  pi: "Pi CLI",
  muse: PROVIDER_DISPLAY_NAME.muse,
  qwen: "Qwen Code CLI",
  kimi: "Kimi Code CLI",
  grok: "Grok CLI",
  copilot: "GitHub Copilot CLI",
  devin: "Devin CLI",
  shell: "Shell",
};

const TRACKED_CLI_PROMPT_SEED_MIN_LEN = 3;
const TRACKED_CLI_PROMPT_SEED_MAX_LEN = 180;
const TRACKED_CLI_PROMPT_TITLE_MAX_LEN = 72;

function stripAnsiForCliTitle(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "");
}

export function sanitizeTrackedCliPromptSeed(raw: string): string {
  const normalized = stripAnsiForCliTitle(raw)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .trim();
  const unwrapped = unwrapAdeGuidancePromptForTitle(normalized);
  const stripped = unwrapped
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped.length) return "";
  return stripped.slice(0, TRACKED_CLI_PROMPT_SEED_MAX_LEN);
}

function unwrapAdeGuidancePromptForTitle(raw: string): string {
  const text = raw.trim();
  if (!text.length) return "";
  const marker = /\bUser prompt:\s*/iu.exec(text);
  const looksLikeAdeGuidance =
    /^ADE session guidance\b/iu.test(text)
    || (/^Start working on that user prompt immediately\./iu.test(text) && marker != null);
  if (!looksLikeAdeGuidance) return stripAdeLaneDirectiveForTitle(text);

  const userPrompt = marker ? text.slice(marker.index + marker[0].length).trim() : text;
  return stripAdeLaneDirectiveForTitle(userPrompt);
}

function stripAdeLaneDirectiveForTitle(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let start = lines.findIndex((line) => line.trim().length > 0);
  if (start < 0) return "";

  const firstLine = lines[start]?.trim() ?? "";
  const pathLine = lines[start + 1]?.trim() ?? "";
  const looksLikeLaneDirective =
    /^You are working in ADE lane:?$/iu.test(firstLine)
    && (
      pathLine.includes(".ade/worktrees/")
      || pathLine.startsWith("/")
      || /^[A-Za-z]:[\\/]/u.test(pathLine)
  );
  if (!looksLikeLaneDirective) return raw.trim();

  let i = start + 2;
  while (i < lines.length && lines[i]!.trim().length === 0) i += 1;

  const maybeMutationRule = lines[i]?.trim() ?? "";
  if (
    maybeMutationRule.length > 0
    && /(?:edit|edits|mutating|commands)/iu.test(maybeMutationRule)
    && /(?:worktree|lane|inside)/iu.test(maybeMutationRule)
  ) {
    i += 1;
    while (i < lines.length && lines[i]!.trim().length === 0) i += 1;
  }

  const remainder = lines.slice(i).join("\n").trim();
  return remainder;
}

function trimPromptLeadIn(raw: string): string {
  let text = raw.trim();
  for (let i = 0; i < 4; i += 1) {
    const next = text
      .replace(/^(?:ok(?:ay)?|so|hey|hi|hello|please|pls|vv)\b[\s,.:;-]*/iu, "")
      .trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

function sentenceCase(raw: string): string {
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : raw;
}

export function trackedCliTitleFromPromptSeed(seed: string): string {
  const naturalLanguageSlashTitle = seed.startsWith("/") && !isProviderSlashCommandInput(seed)
    ? seed.slice(1).trim()
    : seed;
  const cleaned = trimPromptLeadIn(naturalLanguageSlashTitle)
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";

  const clauseMatch = cleaned.match(/^(.{18,}?[,.!?;:])\s/u);
  const clause = clauseMatch?.[1]?.replace(/[,.!?;:]+$/u, "").trim();
  const base = clause && clause.length >= 12 ? clause : cleaned;
  const clipped = base.length > TRACKED_CLI_PROMPT_TITLE_MAX_LEN
    ? base.slice(0, TRACKED_CLI_PROMPT_TITLE_MAX_LEN).replace(/\s+\S*$/u, "").trim()
    : base;
  return sentenceCase(clipped || base.slice(0, TRACKED_CLI_PROMPT_TITLE_MAX_LEN).trim()).replace(/[.?!,:;]+$/u, "");
}

export function isLaunchProfilePlaceholderTitle(
  title: string | null | undefined,
  profile: LaunchProfile,
): boolean {
  const normalized = String(title ?? "").trim().toLowerCase();
  if (!normalized.length) return true;
  if (isProviderSlashCommandInput(normalized)) return true;
  const defaultTitle = LAUNCH_PROFILE_TITLE[profile]?.trim().toLowerCase();
  if (defaultTitle && normalized === defaultTitle) return true;
  if (profile === "codex") return normalized === "codex cli" || normalized === "codex session";
  if (profile === "claude") return normalized === "claude" || normalized === "claude cli" || normalized === "claude session";
  if (profile === "muse") return normalized === "muse" || normalized === "muse cli" || normalized === "muse code cli" || normalized === "muse session";
  return false;
}

export function deriveTrackedCliInitialInputSessionMeta(args: {
  provider: LaunchProfile;
  title?: string | null;
  initialInput?: string | null;
}): { goal: string | null; title: string; promptTitle: string | null } {
  const explicitTitle = String(args.title ?? "").trim();
  const fallbackTitle = explicitTitle || LAUNCH_PROFILE_TITLE[args.provider];
  if (args.provider === "shell") {
    return { goal: null, title: fallbackTitle, promptTitle: null };
  }

  const seed = sanitizeTrackedCliPromptSeed(args.initialInput ?? "");
  if (seed.length < TRACKED_CLI_PROMPT_SEED_MIN_LEN || isProviderSlashCommandInput(seed)) {
    return { goal: null, title: fallbackTitle, promptTitle: null };
  }

  const promptTitle = trackedCliTitleFromPromptSeed(seed) || null;
  const title = promptTitle && isLaunchProfilePlaceholderTitle(explicitTitle, args.provider)
    ? promptTitle
    : fallbackTitle;
  return { goal: seed, title, promptTitle };
}

const LAUNCH_PROFILE_TOOL_TYPES: Record<LaunchProfile, readonly TerminalToolType[]> = {
  claude: ["claude", "claude-orchestrated", "claude-chat"],
  codex: ["codex", "codex-orchestrated", "codex-chat"],
  cursor: ["cursor-cli", "cursor"],
  droid: ["droid", "droid-chat"],
  opencode: ["opencode", "opencode-orchestrated", "opencode-chat"],
  pi: ["pi"],
  muse: ["muse", "muse-chat"],
  qwen: ["qwen", "qwen-chat"],
  kimi: ["kimi", "kimi-chat"],
  grok: ["grok", "grok-chat"],
  copilot: ["copilot", "copilot-chat"],
  devin: ["devin", "devin-chat"],
  shell: ["shell"],
};

export function isLaunchProfile(value: string | null | undefined): value is LaunchProfile {
  return typeof value === "string" && (LAUNCH_PROFILES as readonly string[]).includes(value);
}

export function isTrackedCliPermissionMode(value: string | null | undefined): value is AgentChatPermissionMode {
  return typeof value === "string" && (TRACKED_CLI_PERMISSION_MODES as readonly string[]).includes(value);
}

export function validateLaunchProfilePermissionMode(
  profile: LaunchProfile,
  permissionMode: AgentChatPermissionMode | null | undefined,
): void {
  const mode = permissionMode ?? "default";
  if (profile === "shell" && mode !== "default") {
    throw new Error(`permissionMode ${mode} is not supported for shell sessions.`);
  }
  // Pi does not currently expose ADE's permission presets as native CLI flags.
  // Keep the selected policy available to its guidance instead of rejecting a
  // launch or inventing provider-specific switches.
  if (profile === "pi") {
    // `config-toml` means "defer to the provider's own config", which Pi has in
    // its settings.json — `piToolFlags` omits `--tools` for it. Only `auto`,
    // which Pi has no equivalent for, is rejected.
    if (mode === "auto") {
      throw new Error(`permissionMode ${mode} is not supported for Pi CLI sessions.`);
    }
    return;
  }
  // Qwen and Grok both have a native `auto` approval mode, so they accept the
  // whole ADE ladder. Copilot has neither an `auto` tier nor a plan mode: its
  // permissions are allow/deny tool lists, so ADE maps `plan` to write+shell
  // denials and rejects `auto` rather than silently running as `default`.
  if (profile === "qwen" || profile === "grok") {
    if (mode === "config-toml") {
      throw new Error(`permissionMode ${mode} is not supported for ${profile} CLI sessions.`);
    }
    return;
  }
  if (profile === "kimi") {
    // Kimi's flags are `--plan`, `--auto`, and `--yolo`, which are mutually
    // exclusive. There is no distinct read-only "edit" tier, and no config
    // passthrough.
    if (mode === "auto" || mode === "config-toml") {
      throw new Error(`permissionMode ${mode} is not supported for Kimi CLI sessions.`);
    }
    return;
  }
  if (profile === "copilot") {
    if (mode === "auto" || mode === "config-toml") {
      throw new Error(`permissionMode ${mode} is not supported for GitHub Copilot CLI sessions.`);
    }
    return;
  }
  if (profile === "muse") {
    // Every ADE word has a Muse posture (see `musePermissionCliFlags`):
    // `config-toml` defers to the user's own Muse settings, and `auto` is
    // Muse's default, where an AI reviewer decides eligible approvals.
    return;
  }
  if (profile === "devin") {
    // Devin's `--permission-mode` covers the whole ladder except a raw config
    // passthrough: normal / accept-edits / smart / plan / bypass all map.
    if (mode === "config-toml") {
      throw new Error(`permissionMode ${mode} is not supported for Devin CLI sessions.`);
    }
    return;
  }
  if (mode === "auto" && profile !== "claude") {
    throw new Error("permissionMode auto is only supported for Claude CLI sessions.");
  }
  if (mode === "config-toml" && profile !== "codex" && profile !== "opencode") {
    throw new Error("permissionMode config-toml is only supported for Codex and OpenCode CLI sessions.");
  }
}

export function resolveCleanShellLaunchFields(args: {
  platform: string;
  shell?: string | null;
  comSpec?: string | null;
}): CleanShellLaunchFields {
  if (args.platform === "win32") {
    const shell = resolveWindowsShellLaunchFields(args.shell, { mode: "clean" });
    if (shell) return shell;
    const comSpec = resolveWindowsShellLaunchFields(args.comSpec, { mode: "clean" });
    // ComSpec is normally cmd.exe even when ADE was launched from PowerShell.
    // Preserve PowerShell as ADE's default, while still honoring an explicitly
    // configured PowerShell executable in ComSpec.
    if (comSpec && resolveWindowsShellKind(comSpec.command) === "powershell") {
      return comSpec;
    }
    return { command: "powershell.exe", args: ["-NoLogo", "-NoProfile"] };
  }

  const shell = args.shell?.trim() || "";
  const name = shell.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (name === "zsh") return { command: shell || "/bin/zsh", args: ["-f"], env: { ZDOTDIR: "/var/empty" } };
  if (name === "bash") return { command: shell || "/bin/bash", args: ["--noprofile", "--norc"], env: { BASH_ENV: "" } };
  if (name === "fish") return { command: shell || "fish", args: ["--no-config"] };
  if (name === "sh" && shell) return { command: shell, args: [], env: { ENV: "" } };
  return { command: "/bin/sh", args: [], env: { ENV: "" } };
}

export function launchProfileForTerminalSession(
  session: Pick<TerminalSessionSummary, "resumeMetadata" | "toolType">,
): LaunchProfile | null {
  const resumeProvider = session.resumeMetadata?.provider;
  if (resumeProvider) return resumeProvider;
  const toolType = session.toolType;
  if (!toolType) return null;
  for (const profile of LAUNCH_PROFILES) {
    if (LAUNCH_PROFILE_TOOL_TYPES[profile].includes(toolType)) return profile;
  }
  return null;
}

export function withCodexNoAltScreen(command: string): string {
  const trimmed = command.trim();
  if (!/^codex(?:\s|$)/.test(trimmed)) return trimmed;
  if (/(?:^|\s)--no-alt-screen(?:\s|$)/.test(trimmed)) return trimmed;
  return trimmed === "codex"
    ? "codex --no-alt-screen"
    : trimmed.replace(/^codex\b/, "codex --no-alt-screen");
}

export function shellWordSpans(command: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < command.length) {
    while (index < command.length && /\s/.test(command[index]!)) index += 1;
    if (index >= command.length) break;

    const start = index;
    // `$'` is ANSI-C quoting, which `quoteShellArg` uses for multi-line text:
    // a backslash escapes inside it, so `\'` does not close it.
    let quote: "'" | "\"" | "$'" | null = null;
    let escaped = false;
    while (index < command.length) {
      const char = command[index]!;
      if (escaped) {
        escaped = false;
      } else if (quote === "$'") {
        if (char === "\\") escaped = true;
        else if (char === "'") quote = null;
      } else if (quote === "'") {
        if (char === "'") quote = null;
      } else if (char === "$" && command[index + 1] === "'" && quote === null) {
        quote = "$'";
        index += 1;
      } else if (quote === "\"") {
        if (char === "\"") quote = null;
        else if (char === "\\") escaped = true;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "'" || char === "\"") {
        quote = char;
      } else if (/\s/.test(char)) {
        break;
      }
      index += 1;
    }
    spans.push({ start, end: index });
  }
  return spans;
}

export function isClaudeBinaryCommand(command: string | null | undefined): boolean {
  const trimmed = String(command ?? "").trim();
  if (!trimmed) return false;
  const base = trimmed.replace(/[\\/]+$/, "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return base === "claude" || base === "claude.exe" || base === "claude.cmd";
}

// Shell-wrapped launches (`/bin/bash --noprofile --norc -lc "<command line>"`)
// carry the real Claude invocation inside the argument that follows -c/-lc.
export function shellCommandLineArgIndex(args: string[]): number {
  const flagIndex = args.findIndex((arg) => /^-[a-z]*c$/.test(arg));
  if (flagIndex < 0) return -1;
  const commandIndex = flagIndex + 1;
  return commandIndex < args.length ? commandIndex : -1;
}

function stripSurroundingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed.startsWith("\"") || trimmed.startsWith("'")) && trimmed.endsWith(trimmed[0]!)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * A command line can name Claude as a bare word, an absolute path, or a quoted
 * Windows path. POSIX parsing eats the backslashes of a double-quoted Windows
 * path, so the raw word — quotes stripped, backslashes intact — is checked too.
 */
function wordNamesClaude(parsedWord: string, rawWord: string): boolean {
  return isClaudeBinaryCommand(parsedWord) || isClaudeBinaryCommand(stripSurroundingQuotes(rawWord));
}

/**
 * Locate the `claude` token of a shell command line, allowing leading
 * `KEY=value` env prefixes, and return the args that follow it.
 */
export function claudeInvocationInCommandLine(
  commandLine: string,
): { claudeIndex: number; claudeArgs: string[] } | null {
  if (!commandLine?.trim()) return null;
  let commandArgs: string[] = [];
  try {
    commandArgs = parseCommandLine(commandLine);
  } catch {
    // Keep malformed or unsupported shell input intact.
    return null;
  }
  const spans = shellWordSpans(commandLine);
  const claudeIndex = commandArgs.findIndex((arg, index) => {
    const span = spans[index];
    const raw = span ? commandLine.slice(span.start, span.end) : arg;
    return wordNamesClaude(arg, raw)
      && commandArgs.slice(0, index).every((prefix) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(prefix));
  });
  if (claudeIndex < 0) return null;
  return { claudeIndex, claudeArgs: commandArgs.slice(claudeIndex + 1) };
}

function withArgsAfterClaudeToken(commandLine: string, claudeIndex: number, extraArgs: string[]): string {
  const claudeSpan = shellWordSpans(commandLine)[claudeIndex];
  if (!claudeSpan) return commandLine;
  return `${commandLine.slice(0, claudeSpan.end)} ${commandArrayToLine(extraArgs)}${commandLine.slice(claudeSpan.end)}`;
}

// Insert `--plugin-dir <root>` right after the `claude` token of a shell
// command line, leaving env-var prefixes and the caller's own flags intact.
export function withClaudePluginInCommandLine(commandLine: string, pluginRoot: string): string {
  const invocation = claudeInvocationInCommandLine(commandLine);
  if (!invocation) return commandLine;
  const hasPluginRoot = invocation.claudeArgs.some((arg, index) =>
    (arg === "--plugin-dir" && invocation.claudeArgs[index + 1] === pluginRoot)
    || arg === `--plugin-dir=${pluginRoot}`,
  );
  if (hasPluginRoot) return commandLine;
  return withArgsAfterClaudeToken(commandLine, invocation.claudeIndex, ["--plugin-dir", pluginRoot]);
}

// Insert `--session-id <uuid>` right after the `claude` token of a shell
// command line. Same placement rule as the plugin flag: prepending it to the
// wrapping shell's own argv would make bash die with "invalid option".
export function withClaudeSessionIdInCommandLine(commandLine: string, sessionId: string): string {
  const invocation = claudeInvocationInCommandLine(commandLine);
  if (!invocation) return commandLine;
  if (claudeArgsCarrySessionId(invocation.claudeArgs)) return commandLine;
  return withArgsAfterClaudeToken(commandLine, invocation.claudeIndex, ["--session-id", sessionId]);
}

function claudeArgsCarrySessionId(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--session-id" || arg.startsWith("--session-id="));
}

/**
 * `claude --session-id <uuid>` starts a NEW conversation with that id, so it
 * is mutually exclusive with a plain `--resume`/`--continue`: assigning one to
 * a continuation launch would either be rejected by the CLI or silently start a
 * fresh session in place of the one the user asked to resume.
 *
 * A fork (`--resume <id> --fork-session`) is the exception: it also starts a
 * new conversation, and Claude Code accepts `--session-id` to name it. The
 * 2.1.287 binary rejects the combination only without the fork flag: "Error:
 * --session-id can only be used with --continue or --resume if --fork-session
 * is also specified."
 */
export function claudeArgsResumeExistingSession(args: readonly string[]): boolean {
  if (args.includes("--fork-session")) return false;
  return args.some((arg) =>
    arg === "--resume"
    || arg === "-r"
    || arg === "--continue"
    || arg === "-c"
    || arg.startsWith("--resume=")
    || arg.startsWith("--continue="),
  );
}

/**
 * ACP CLIs that accept a caller-chosen session id for a NEW session, and the
 * exact spelling each one takes. Verified against the installed CLIs:
 *
 * - qwen 0.22.3: `--session-id <uuid>` ("Specify a session ID for this run";
 *   rejected beside `--continue`/`--resume`, which it validates as "Cannot use
 *   --session-id with --continue or --resume").
 * - grok 1.0.40: `-s, --session-id <SESSION_ID>` ("Use a specific session UUID
 *   for a **new** conversation … With --resume/--continue, only valid together
 *   with --fork-session").
 * - copilot 1.0.88: `--session-id <id>` ("Resume an existing session or task by
 *   ID, or set the UUID for a new session").
 *
 * Kimi has no such flag; its id is adopted from the file it writes.
 */
export type PreassignedSessionIdProvider = "qwen" | "grok" | "copilot";

export function isPreassignedSessionIdProvider(provider: string | null | undefined): provider is PreassignedSessionIdProvider {
  return provider === "qwen" || provider === "grok" || provider === "copilot";
}

export function preassignedSessionIdArgs(provider: PreassignedSessionIdProvider, sessionId: string): string[] {
  if (provider === "grok") return ["-s", sessionId];
  if (provider === "copilot") return [`--session-id=${sessionId}`];
  return ["--session-id", sessionId];
}

const PREASSIGNED_SESSION_ID_FLAGS: Record<PreassignedSessionIdProvider, readonly string[]> = {
  qwen: ["--session-id"],
  grok: ["-s", "--session-id"],
  copilot: ["--session-id"],
};

const PROVIDER_RESUME_SELECTORS: Record<PreassignedSessionIdProvider, readonly string[]> = {
  qwen: ["-r", "--resume", "-c", "--continue"],
  grok: ["-r", "--resume", "-c", "--continue"],
  copilot: ["-r", "--resume", "--continue", "--connect"],
};

/** The session id a launch's argv already names with the provider's assign flag. */
export function preassignedSessionIdInArgs(
  provider: PreassignedSessionIdProvider,
  args: readonly string[],
): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    for (const flag of PREASSIGNED_SESSION_ID_FLAGS[provider]) {
      if (arg === flag) {
        const value = args[index + 1]?.trim();
        return value && !value.startsWith("-") ? value : null;
      }
      if (flag.startsWith("--") && arg.startsWith(`${flag}=`)) {
        return arg.slice(flag.length + 1).trim() || null;
      }
    }
  }
  return null;
}

/**
 * True when argv continues an existing conversation. A pre-assigned id names a
 * NEW session, so it must never be added to such a launch.
 */
export function providerArgsResumeExistingSession(
  provider: PreassignedSessionIdProvider,
  args: readonly string[],
): boolean {
  const selectors = PROVIDER_RESUME_SELECTORS[provider];
  return args.some((arg) =>
    selectors.includes(arg)
    || selectors.some((selector) => selector.startsWith("--") && arg.startsWith(`${selector}=`)),
  );
}

/** True when a command word names `binary` (bare, absolute path, or a Windows `.exe`/`.cmd`/`.bat`/`.ps1` shim). */
export function isProviderBinaryCommand(word: string | null | undefined, binary: string): boolean {
  const trimmed = stripSurroundingQuotes(String(word ?? ""));
  if (!trimmed) return false;
  const base = trimmed.replace(/[\\/]+$/, "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return base === binary || base.replace(/\.(exe|cmd|bat|ps1)$/u, "") === binary;
}

/**
 * Locate the provider binary token of a shell command line (allowing leading
 * `KEY=value` env prefixes) and return the args that follow it. Same rules as
 * {@link claudeInvocationInCommandLine}.
 */
export function providerInvocationInCommandLine(
  commandLine: string,
  binary: string,
): { binaryIndex: number; providerArgs: string[] } | null {
  if (!commandLine?.trim()) return null;
  let commandArgs: string[] = [];
  try {
    commandArgs = parseCommandLine(commandLine);
  } catch {
    return null;
  }
  const spans = shellWordSpans(commandLine);
  const binaryIndex = commandArgs.findIndex((arg, index) => {
    const span = spans[index];
    const raw = span ? commandLine.slice(span.start, span.end) : arg;
    return (isProviderBinaryCommand(arg, binary) || isProviderBinaryCommand(raw, binary))
      && commandArgs.slice(0, index).every((prefix) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(prefix));
  });
  if (binaryIndex < 0) return null;
  return { binaryIndex, providerArgs: commandArgs.slice(binaryIndex + 1) };
}

/**
 * Insert the provider's pre-assign flag right after its binary token. Returns
 * the line unchanged when the binary is absent, the line already names an id,
 * or the line continues an existing session.
 */
export function withPreassignedSessionIdInCommandLine(
  commandLine: string,
  provider: PreassignedSessionIdProvider,
  sessionId: string,
): string {
  const invocation = providerInvocationInCommandLine(commandLine, provider);
  if (!invocation) return commandLine;
  if (preassignedSessionIdInArgs(provider, invocation.providerArgs)) return commandLine;
  if (providerArgsResumeExistingSession(provider, invocation.providerArgs)) return commandLine;
  const span = shellWordSpans(commandLine)[invocation.binaryIndex];
  if (!span) return commandLine;
  return `${commandLine.slice(0, span.end)} ${commandArrayToLine(preassignedSessionIdArgs(provider, sessionId))}${commandLine.slice(span.end)}`;
}

const POSIX_COMMAND_SEPARATORS = new Set(["&&", "||", "|", ";"]);

/**
 * Spans of the words in a canonical POSIX command line that run one of
 * `binaries` as a command: the first word after any `KEY=value` assignments,
 * at the start and after each `&&`, `||`, `|` or `;`. Not only the first
 * command: Droid's launch line writes its settings file before it runs `droid`.
 * A word counts bare, as a path, or as a Windows `.exe`/`.cmd` name.
 */
export function providerCommandWordSpans(
  commandLine: string,
  binaries: readonly string[],
): Array<{ start: number; end: number }> {
  if (!commandLine?.trim() || binaries.length === 0) return [];
  let words: string[];
  try {
    words = parseCommandLine(commandLine, { platform: "linux" });
  } catch {
    return [];
  }
  const spans = shellWordSpans(commandLine);
  // The two splitters agree on every line ADE builds; anything they read
  // differently is not a line to rewrite.
  if (spans.length !== words.length) return [];
  const matches: Array<{ start: number; end: number }> = [];
  let atCommandStart = true;
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]!;
    const raw = commandLine.slice(span.start, span.end);
    if (POSIX_COMMAND_SEPARATORS.has(raw)) {
      atCommandStart = true;
      continue;
    }
    if (atCommandStart && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) {
      if (binaries.some((binary) => isProviderBinaryCommand(words[index], binary) || isProviderBinaryCommand(raw, binary))) {
        matches.push(span);
      }
      atCommandStart = false;
    }
    // `cmd; next` keeps the separator on the word before it.
    if (raw.endsWith(";") && !raw.endsWith("\\;")) atCommandStart = true;
  }
  return matches;
}

/**
 * Replace every command word naming one of `binaries` with `replacement`
 * (already quoted for the shell that reads the line). Unchanged when none does.
 */
export function withProviderCommandWord(
  commandLine: string,
  binaries: readonly string[],
  replacement: string,
): string {
  const spans = providerCommandWordSpans(commandLine, binaries);
  let next = commandLine;
  for (const span of spans.slice().reverse()) {
    next = `${next.slice(0, span.start)}${replacement}${next.slice(span.end)}`;
  }
  return next;
}

/**
 * The PowerShell form of {@link withProviderCommandWord}, for Windows Droid's
 * `& 'droid' …` launch line: the call operator's operand is replaced with
 * `replacement` (already PowerShell-quoted). Unchanged when no operand names one.
 */
export function withPowerShellProviderCommand(
  commandLine: string,
  binaries: readonly string[],
  replacement: string,
): string {
  return commandLine.replace(
    /(^|[;{(\s])&\s+('(?:[^']|'')*'|"[^"]*"|[^\s;'"]+)/g,
    (match, lead: string, operand: string) => {
      const word = operand.startsWith("'")
        ? operand.slice(1, -1).replace(/''/g, "'")
        : operand.replace(/^"|"$/g, "");
      return binaries.some((binary) => isProviderBinaryCommand(word, binary)) ? `${lead}& ${replacement}` : match;
    },
  );
}

export function defaultTrackedCliStartupCommand(provider: CliProvider): string {
  if (provider === "codex") return withCodexNoAltScreen("codex");
  if (provider === "cursor") return "cursor-agent --model auto";
  if (provider === "droid") return "droid";
  if (provider === "opencode") return "opencode";
  if (provider === "pi") return "pi";
  if (provider === "muse") return "muse --contributor-mode off";
  if (provider === "qwen") return "qwen";
  if (provider === "kimi") return "kimi";
  if (provider === "grok") return "grok --no-alt-screen";
  if (provider === "copilot") return "copilot";
  if (provider === "devin") return "devin";
  return "claude";
}

export function codexComputerUseMcpFlags(
  config: CodexComputerUseCliConfig | null | undefined,
): string[] {
  const command = config?.command?.trim();
  if (!command) return [];
  const args = config?.args?.length ? [...config.args] : ["mcp"];
  return [
    "-c",
    `mcp_servers.computer_use.command=${JSON.stringify(command)}`,
    "-c",
    `mcp_servers.computer_use.args=${JSON.stringify(args)}`,
    "-c",
    "mcp_servers.computer_use.enabled=true",
  ];
}

function workTabCliPreamblePrompt(
  sessionGuidance: string,
  hasInitialPrompt = false,
): string {
  const launchInstruction = hasInitialPrompt
    ? [
        "ADE session guidance. Treat this as operating guidance for the CLI session",
        "and keep it in mind while handling the user prompt below.",
        "Start working on that user prompt immediately.",
      ].join(" ")
    : [
        "ADE session guidance. Treat this as operating guidance for the CLI session,",
        "keep it in mind for future user messages, and wait for the user's next",
        "instruction before taking action.",
      ].join(" ");
  return [
    launchInstruction,
    "",
    sessionGuidance,
  ].join("\n");
}

function adeAgentSkillEnv(skillRoots: readonly string[]): Record<string, string> | null {
  const value = joinAdeAgentSkillRoots(skillRoots);
  return value ? { [ADE_AGENT_SKILLS_DIRS_ENV]: value } : null;
}

function withAdeAgentSkillEnv(
  env: Record<string, string> | undefined,
  skillRoots: readonly string[],
): Record<string, string> | undefined {
  const skillsEnv = adeAgentSkillEnv(skillRoots);
  if (!skillsEnv) return env;
  return { ...skillsEnv, ...(env ?? {}) };
}

/**
 * One provider account, already resolved to a directory.
 *
 * `shared/` cannot reach the machine instance store (it lives in the CLI
 * package and reads the filesystem), so callers resolve the id and hand the
 * answer down. That also keeps the fallback rule for a deleted account in one
 * place — the resolver — instead of two builders.
 */
export type ProviderInstanceLaunchTarget = {
  /** The account id; the provider slug names the base identity. */
  id: string;
  provider: ProviderInstanceProvider;
  configHome: string;
};

/**
 * The env entry that points ONE provider CLI at ONE account's config home.
 *
 * Empty for every provider that does not keep its identity in a config
 * directory, and empty when the resolved account belongs to a different
 * provider than the launch — a Claude account cannot redirect a Codex run.
 * Never rewrites `HOME`.
 */
export function providerInstanceLaunchEnv(
  provider: LaunchProfile,
  instance: ProviderInstanceLaunchTarget | null | undefined,
  options: { allowDefaultConfigHome?: boolean } = {},
): Record<string, string> {
  if (!instance) return {};
  const configHome = instance.configHome?.trim();
  if (!configHome) return {};
  if (!isProviderInstanceProvider(provider) || provider !== instance.provider) return {};
  // The base identity inherits the environment; see `isBaseProviderInstance`.
  if (isBaseProviderInstance(instance) && options.allowDefaultConfigHome !== true) return {};
  return { [PROVIDER_INSTANCE_ENV_KEY[instance.provider]]: configHome };
}

/**
 * A harness preset, already resolved to what a process needs.
 *
 * `shared/` cannot read the key store or write a config home, so the same rule
 * that applies to provider accounts applies here: the caller resolves
 * (`main/services/chat/harnessPresetLaunch.ts`) and hands the answer down.
 *
 * `configFragments` are files the harness reads at startup — Codex's
 * `config.toml`, Droid's `settings.json`. The resolver writes them on the
 * machine it runs on; they travel with the launch so a runtime that
 * materializes a command built elsewhere can write the same bytes before the
 * spawn rather than starting a CLI whose config home is empty.
 */
export type TrackedCliPresetLaunch = {
  env?: Record<string, string>;
  configFragments?: Array<{ path: string; contents: string }>;
  /**
   * Send the model id to the CLI exactly as stated, skipping ADE's alias
   * table. A preset's model can be a gateway's spelling that ADE's catalog
   * does not know, and rewriting it would point the run at a different model.
   */
  passthroughModelId?: boolean;
};

/** The env a resolved preset contributes. Empty when there is no preset. */
export function harnessPresetLaunchEnv(
  preset: TrackedCliPresetLaunch | null | undefined,
): Record<string, string> {
  return preset?.env && Object.keys(preset.env).length ? { ...preset.env } : {};
}

function mergeLaunchEnv<B extends Record<string, string> | null | undefined>(
  base: B,
  patch: Record<string, string>,
): B | Record<string, string> {
  if (!Object.keys(patch).length) return base;
  return { ...(base ?? {}), ...patch };
}

export function buildTrackedCliStartupCommand(args: {
  provider: CliProvider;
  permissionMode: AgentChatPermissionMode;
  droidPermissionMode?: AgentChatDroidPermissionMode | null;
  /** Muse's own approval mode; wins over the `permissionMode` mapping when set. */
  musePermissionMode?: AgentChatMusePermissionMode | null;
  /** Extra stdio MCP servers for a Muse run, attached with `-c mcpServers.<name>=…`. */
  museMcpServers?: readonly MuseCliMcpServer[] | null;
  /** Pre-assigned session ID for Claude CLI (enables reliable resume). */
  sessionId?: string;
  /** Optional runtime model for fresh launches. Continuation commands intentionally ignore it. */
  model?: string | null;
  /** Optional reasoning effort for fresh launches when the runtime supports it. */
  reasoningEffort?: string | null;
  /** Optional fast-mode override for runtimes that expose a fast tier. */
  fastMode?: boolean | null;
  /** Fast's tier for Codex: "ultrafast" asks for Ultrafast; absent is plain Fast. */
  fastTier?: "ultrafast" | null;
  /** Optional user prompt to submit with the fresh launch. */
  initialPrompt?: string | null;
  /** Active lane worktree used to make ADE skill roots lane-aware. */
  laneWorktreePath?: string | null;
  /** Signed standalone Computer Use MCP client selected by ADE's main process. */
  codexComputerUse?: CodexComputerUseCliConfig | null;
  /** The user's own MCP servers for a Claude or Codex launch, resolved in main. */
  userMcp?: TrackedCliUserMcp | null;
  /**
   * Provider account to launch under, already resolved by the caller. Only
   * `claude` and `codex` have one; every other provider ignores it.
   */
  instance?: ProviderInstanceLaunchTarget | null;
  /**
   * Saved harness preset for this launch, already resolved. Its env is merged
   * over ADE's own launch env, and `passthroughModelId` turns off the model
   * alias rewrite.
   */
  preset?: TrackedCliPresetLaunch | null;
}): string {
  return buildTrackedCliLaunchCommand(args).startupCommand;
}

export function buildTrackedCliLaunchCommand(args: {
  provider: CliProvider;
  permissionMode: AgentChatPermissionMode;
  droidPermissionMode?: AgentChatDroidPermissionMode | null;
  /** Muse's own approval mode; wins over the `permissionMode` mapping when set. */
  musePermissionMode?: AgentChatMusePermissionMode | null;
  /** Extra stdio MCP servers for a Muse run, attached with `-c mcpServers.<name>=…`. */
  museMcpServers?: readonly MuseCliMcpServer[] | null;
  /** Pre-assigned session ID for Claude CLI (enables reliable resume). */
  sessionId?: string;
  /** Optional runtime model for fresh launches. Continuation commands intentionally ignore it. */
  model?: string | null;
  /** Optional reasoning effort for fresh launches when the runtime supports it. */
  reasoningEffort?: string | null;
  /** Optional fast-mode override for runtimes that expose a fast tier. */
  fastMode?: boolean | null;
  /** Fast's tier for Codex: "ultrafast" asks for Ultrafast; absent is plain Fast. */
  fastTier?: "ultrafast" | null;
  /** Optional user prompt to submit with the fresh launch. */
  initialPrompt?: string | null;
  /** Active lane worktree used to make ADE skill roots lane-aware. */
  laneWorktreePath?: string | null;
  /** Signed standalone Computer Use MCP client selected by ADE's main process. */
  codexComputerUse?: CodexComputerUseCliConfig | null;
  /** The user's own MCP servers for a Claude or Codex launch, resolved in main. */
  userMcp?: TrackedCliUserMcp | null;
  /**
   * Provider account to launch under, already resolved by the caller. Only
   * `claude` and `codex` have one; every other provider ignores it.
   */
  instance?: ProviderInstanceLaunchTarget | null;
  /**
   * Saved harness preset for this launch, already resolved. Its env is merged
   * over ADE's own launch env, and `passthroughModelId` turns off the model
   * alias rewrite.
   */
  preset?: TrackedCliPresetLaunch | null;
  /** False when this runtime has no RPC endpoint that can accept agent reports. */
  sessionActivityReportingEnabled?: boolean;
  /**
   * The Project notes block, read once by the caller (the process that owns
   * the lane) when the session starts. Absent: no block.
   */
  projectNotes?: string | null;
}): TrackedCliLaunchCommand {
  const permissionMode = args.permissionMode ?? "default";
  validateLaunchProfilePermissionMode(args.provider, permissionMode);
  const initialPrompt = normalizeInitialPrompt(args.initialPrompt);
  const skillRoots = args.laneWorktreePath
    ? getAgentSkillRootCandidates({ cwd: args.laneWorktreePath })
    : getAdeAgentSkillRootsForPrompt();
  const sessionGuidance = buildAdeCliSessionGuidance(skillRoots, args.projectNotes);
  // The preset lands LAST so it outranks the account env: a preset that names
  // its own config home must win over the instance patch, or a key-sourced
  // preset would run inside the user's own signed-in directory.
  const agentSkillEnv = mergeLaunchEnv(
    mergeLaunchEnv(
      adeAgentSkillEnv(skillRoots),
      providerInstanceLaunchEnv(args.provider, args.instance),
    ),
    harnessPresetLaunchEnv(args.preset),
  );
  const passthroughModelId = args.preset?.passthroughModelId === true;
  const modelForLaunch = passthroughModelId
    ? normalizeCliFlagValue(args.model)
    : args.model;
  const activityGuidance = buildTrackedCliSessionActivityGuidance({
    provider: args.provider,
    permissionMode,
    droidPermissionMode: args.droidPermissionMode,
    hasInitialPrompt: Boolean(initialPrompt),
    sessionActivityReportingEnabled: args.sessionActivityReportingEnabled,
  });

  if (args.provider === "claude") {
    const commandArgs: string[] = [];
    const assignedSessionId = args.sessionId?.trim() || null;
    if (assignedSessionId) {
      commandArgs.push("--session-id", assignedSessionId);
    }
    const model = passthroughModelId
      ? normalizeCliFlagValue(args.model)
      : resolveClaudeCliModelForLaunch(args.model);
    if (model) {
      commandArgs.push("--model", model);
    }
    commandArgs.push(...claudeRuntimeEffortFlags(args.reasoningEffort));
    commandArgs.push(...claudeSessionSettingsFlags(args.fastMode, args.reasoningEffort));
    // `--mcp-config` takes several values, so a flag must follow it, never the prompt.
    commandArgs.push(...trackedCliUserMcpFlags("claude", args.userMcp));
    const guidance = [sessionGuidance, activityGuidance]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");
    commandArgs.push("--append-system-prompt", guidance);
    commandArgs.push(...permissionModeToClaudeFlag(permissionMode));
    // Windows keeps the user's prompt off argv. ADE launches the bare word
    // `claude` and the PTY boundary runs ADE's pinned `claude.exe` directly,
    // but a launch that falls back to a shell line (or waits for that copy to
    // download) is typed into cmd or PowerShell, and cmd rewrites the line
    // before Claude ever sees it. Measured through a real shim: `%USERPROFILE%`
    // expands (and cannot be escaped — see processExecution.ts), newlines
    // flatten to spaces, and at 8501 characters the spawn dies outright with
    // "The command line is too long." The guidance blob is already ~2KB of
    // that 8191-character budget, so an ordinary pasted prompt reaches the
    // cliff. Deliver it through the PTY once the TUI is ready instead — the
    // same transport Codex and Cursor already use. POSIX shells do none of
    // this rewriting and have no such limit, so they keep the prompt in argv.
    const promptRidesInArgv = Boolean(initialPrompt) && currentPlatform() !== "win32";
    if (initialPrompt && promptRidesInArgv) {
      commandArgs.push(initialPrompt);
    }
    // Build a shorter startupCommand for the shell-fallback path that excludes
    // the huge --append-system-prompt blob. The direct-spawn path uses the full
    // args array. The PTY launch boundary adds the validated bundled
    // `--plugin-dir`; the compact prompt remains the compatibility fallback.
    const shellArgs = commandArgs.filter(
      (arg, i, arr) => arg !== "--append-system-prompt" && arr[i - 1] !== "--append-system-prompt",
    );
    return {
      command: "claude",
      args: commandArgs,
      startupCommand: commandArrayToLine(["claude", ...shellArgs], { platform: "linux" }),
      ...(assignedSessionId ? { assignedSessionId } : {}),
      ...(initialPrompt && !promptRidesInArgv
        ? { initialInput: initialPrompt, initialInputDelayMs: 750 }
        : {}),
      ...(agentSkillEnv ? { env: agentSkillEnv } : {}),
    };
  }

  if (args.provider === "codex") {
    const codexModel = passthroughModelId
      ? normalizeCliFlagValue(args.model)
      : resolveCodexCliModelForLaunch(args.model);
    const initialInput = workTabCliPrompt(initialPrompt, sessionGuidance, activityGuidance);
    const commandArgs: string[] = [
      "--no-alt-screen",
      ...modelToCliFlag(codexModel),
      ...codexReasoningEffortFlags(args.reasoningEffort),
      ...codexServiceTierFlags(args.fastMode, args.fastTier),
      ...trackedCliUserMcpFlags("codex", args.userMcp),
      ...codexComputerUseMcpFlags(args.codexComputerUse),
      ...permissionModeToCodexFlags(permissionMode),
    ];
    // The launcher is the bare command `codex`. The PTY boundary runs ADE's
    // pinned `codex.exe` directly, but a shell fallback types the line into
    // cmd or PowerShell, and cmd rewrites the command line before Codex sees
    // it: `%` is doubled, `%NAME%` is expanded, newlines collapse to spaces,
    // and the whole line is capped at ~8191 characters. The work-tab prompt is
    // a ~2.4KB multi-line ADE preamble with the user's text appended, so
    // passing it as argv corrupts it on every Windows launch. Fall back to the
    // post-launch input path that every other Codex model already uses.
    const usePromptArg = codexModel === "gpt-5.3-codex" && currentPlatform() !== "win32";
    if (usePromptArg) commandArgs.push(initialInput);
    return {
      command: "codex",
      args: commandArgs,
      startupCommand: commandArrayToLine(["codex", ...commandArgs], { platform: "linux" }),
      ...(usePromptArg ? {} : { initialInput, initialInputDelayMs: 750 }),
      ...(agentSkillEnv ? { env: agentSkillEnv } : {}),
    };
  }

  if (args.provider === "cursor") {
    const cursorModel = passthroughModelId
      ? normalizeCliFlagValue(args.model)
      : resolveCursorCliModelForLaunch(args.model);
    const commandArgs = [
      ...permissionModeToCursorFlags(permissionMode),
      ...modelToCliFlag(cursorModel),
    ];
    const initialInput = initialPrompt
      ? workTabCliPrompt(initialPrompt, sessionGuidance, activityGuidance)
      : null;
    return {
      command: "cursor-agent",
      args: commandArgs,
      startupCommand: commandArrayToLine(["cursor-agent", ...commandArgs], { platform: "linux" }),
      ...(initialInput ? { initialInput, initialInputDelayMs: 750 } : {}),
      ...(agentSkillEnv ? { env: agentSkillEnv } : {}),
    };
  }

  if (args.provider === "droid") {
    const prompt = workTabCliPrompt(initialPrompt, sessionGuidance, activityGuidance);
    if (currentPlatform() === "win32") {
      // Windows Droid has to run through `powershell.exe -Command <line>` so the
      // settings JSON can be written to a temp file before droid starts, and
      // that transport cannot carry the prompt. Measured against an
      // npm-installed `droid.cmd`, a multi-line value handed to `& 'droid' …`
      // arrives TRUNCATED AT THE FIRST NEWLINE — a six-line prompt reached the
      // shim as its first line and nothing else — while `%TEMP%` expands and, at
      // a `droid.exe`, embedded `"` are stripped. This is not a quoting defect:
      // the repo's own stricter quoter (shell.ts `powerShellLegacyNativeValue`)
      // was measured on the same shim and still lost everything past the first
      // newline. Argv through a shell is simply the wrong transport, and the ADE
      // preamble is ~2KB over 16 lines so *every* Windows launch lost the user's
      // text. Type it into the TUI after launch instead, exactly as Codex and
      // Cursor already do. POSIX keeps the prompt in argv where it round-trips.
      const startupCommand = droidPowerShellCommand({
        permissionMode,
        droidPermissionMode: args.droidPermissionMode,
        model: modelForLaunch,
        reasoningEffort: args.reasoningEffort,
      });
      return {
        command: "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", startupCommand],
        startupCommand,
        initialInput: prompt,
        initialInputDelayMs: 750,
        ...(agentSkillEnv ? { env: agentSkillEnv } : {}),
      };
    }
    const startupCommand = buildDroidCommandLine({
      permissionMode,
      droidPermissionMode: args.droidPermissionMode,
      model: modelForLaunch,
      reasoningEffort: args.reasoningEffort,
      prompt,
    });
    return {
      command: "/bin/bash",
      args: ["-lc", startupCommand],
      startupCommand,
      ...(agentSkillEnv ? { env: agentSkillEnv } : {}),
    };
  }

  if (args.provider === "pi") {
    const guidance = [
      sessionGuidance,
      activityGuidance,
      `ADE permission policy for this Pi session: ${permissionMode}. Pi has no supported native ADE permission flag, so follow this policy and the ADE guidance without bypassing it.`,
    ].filter((part): part is string => Boolean(part)).join("\n\n");
    const commandArgs = [
      ...modelToCliFlag(resolvePiCliModelForLaunch(modelForLaunch)),
      ...piThinkingFlags(args.reasoningEffort),
      ...piToolFlags(permissionMode),
      ...PI_TERMINAL_TUI_FLAGS,
      "--append-system-prompt",
      guidance,
    ];
    // Keep the guidance off the shell fallback's command line. The direct
    // command/argv path carries it safely on every platform; the initial user
    // message rides the PTY so Windows shims cannot rewrite it.
    const startupArgs = commandArgs.filter(
      (arg, index, all) => arg !== "--append-system-prompt" && all[index - 1] !== "--append-system-prompt",
    );
    return {
      command: "pi",
      args: commandArgs,
      startupCommand: commandArrayToLine(["pi", ...startupArgs], { platform: "linux" }),
      ...(initialPrompt ? { initialInput: initialPrompt, initialInputDelayMs: 750 } : {}),
      ...(agentSkillEnv ? { env: agentSkillEnv } : {}),
    };
  }

  if (args.provider === "muse") {
    const museModel = passthroughModelId
      ? normalizeCliFlagValue(args.model)
      : resolveMuseCliModelForLaunch(args.model);
    const workspace = normalizeCliFlagValue(args.laneWorktreePath);
    const commandArgs: string[] = [
      ...museBaseFlags({
        model: museModel,
        reasoningEffort: args.reasoningEffort,
        permissionMode,
        musePermissionMode: args.musePermissionMode,
      }),
      ...(workspace ? ["--workspace", workspace] : []),
      ...museMcpServerConfigFlags(args.museMcpServers),
    ];
    // Muse has no system-prompt flag, so ADE's guidance rides the first user
    // message, as it does for Codex. The prompt goes in argv on every
    // platform: Muse ships only as a native executable (`muse` / `muse.exe`,
    // never a `.cmd` shim) and the PTY boundary substitutes ADE's pinned
    // binary path, so the spawn is direct and argv arrives intact. Typing it
    // into the TUI instead would land it in Muse's first-run "Do you trust
    // this workspace?" dialog; an argv prompt waits behind that dialog and is
    // submitted once the user answers (verified against muse 1.4.7).
    commandArgs.push(workTabCliPrompt(initialPrompt, sessionGuidance, activityGuidance));
    return {
      command: MUSE_CLI_COMMAND,
      args: commandArgs,
      startupCommand: commandArrayToLine([MUSE_CLI_COMMAND, ...commandArgs], { platform: "linux" }),
      ...(agentSkillEnv ? { env: agentSkillEnv } : {}),
    };
  }

  if (args.provider === "qwen") {
    const assignedSessionId = args.sessionId?.trim() || null;
    const commandArgs: string[] = [];
    if (assignedSessionId) {
      // Same mutual exclusion as Claude: `--session-id` starts a NEW session
      // with that id, so it can never appear beside `--resume`/`--continue`.
      commandArgs.push(...preassignedSessionIdArgs("qwen", assignedSessionId));
    }
    commandArgs.push(...qwenModelFlags(modelForLaunch));
    commandArgs.push(...permissionModeToQwenFlags(permissionMode));
    commandArgs.push("--append-system-prompt", sessionGuidance);
    // `qwen` is an npm bin, so on Windows it resolves to a `.cmd` shim and the
    // prompt goes through `cmd.exe`, which expands `%NAME%`, flattens newlines,
    // and caps the command line at ~8191 characters. Same rule as Claude:
    // POSIX keeps the prompt in argv, Windows types it into the TUI.
    const promptRidesInArgv = Boolean(initialPrompt) && currentPlatform() !== "win32";
    if (initialPrompt && promptRidesInArgv) {
      commandArgs.push("-i", initialPrompt);
    }
    const shellArgs = commandArgs.filter(
      (arg, i, all) => arg !== "--append-system-prompt" && all[i - 1] !== "--append-system-prompt",
    );
    return {
      command: "qwen",
      args: commandArgs,
      startupCommand: commandArrayToLine(["qwen", ...shellArgs], { platform: "linux" }),
      ...(assignedSessionId ? { assignedSessionId } : {}),
      ...(initialPrompt && !promptRidesInArgv
        ? { initialInput: initialPrompt, initialInputDelayMs: 750 }
        : {}),
      ...(agentSkillEnv ? { env: agentSkillEnv } : {}),
    };
  }

  if (args.provider === "kimi") {
    // Kimi's interactive TUI takes no argv prompt at all, so the prompt is
    // typed in after launch — the Cursor branch's shape. It has no flag for
    // system text either, so ADE's guidance rides in front of that first
    // message, and an empty launch stays idle rather than submitting guidance
    // as work, exactly as Cursor's does. Kimi also cannot be
    // handed a session id at launch; the id is captured from its sessions
    // directory afterwards, so no `assignedSessionId` is returned here.
    const commandArgs = [
      ...kimiModelFlags(modelForLaunch),
      ...permissionModeToKimiFlags(permissionMode),
    ];
    return {
      command: "kimi",
      args: commandArgs,
      startupCommand: commandArrayToLine(["kimi", ...commandArgs], { platform: "linux" }),
      ...(initialPrompt
        ? { initialInput: workTabCliPrompt(initialPrompt, sessionGuidance, activityGuidance), initialInputDelayMs: 750 }
        : {}),
      ...(agentSkillEnv ? { env: agentSkillEnv } : {}),
    };
  }

  if (args.provider === "grok") {
    const assignedSessionId = args.sessionId?.trim() || null;
    const commandArgs: string[] = ["--no-alt-screen"];
    if (assignedSessionId) {
      // `-s` names a NEW session's UUID; with `--resume`/`--continue` it is
      // only legal alongside `--fork-session`. Fresh launches only.
      commandArgs.push(...preassignedSessionIdArgs("grok", assignedSessionId));
    }
    commandArgs.push(...grokModelFlags(modelForLaunch));
    commandArgs.push(...grokReasoningEffortFlags(args.reasoningEffort));
    commandArgs.push(...permissionModeToGrokFlags(permissionMode));
    commandArgs.push("--rules", sessionGuidance);
    const promptRidesInArgv = Boolean(initialPrompt) && currentPlatform() !== "win32";
    if (initialPrompt && promptRidesInArgv) {
      commandArgs.push(initialPrompt);
    }
    const shellArgs = commandArgs.filter(
      (arg, i, all) => arg !== "--rules" && all[i - 1] !== "--rules",
    );
    return {
      command: "grok",
      args: commandArgs,
      startupCommand: commandArrayToLine(["grok", ...shellArgs], { platform: "linux" }),
      ...(assignedSessionId ? { assignedSessionId } : {}),
      ...(initialPrompt && !promptRidesInArgv
        ? { initialInput: initialPrompt, initialInputDelayMs: 750 }
        : {}),
      // `--permission-mode` above only overrides `~/.grok/config.toml`. Without
      // the Claude-import kill switch beside it, Grok still merges the user's
      // `~/.claude/settings.json` `permissions.defaultMode` and auto-approves
      // writes in its own TUI too. The two halves travel together everywhere.
      env: { ...(agentSkillEnv ?? {}), ...grokSupervisionEnv() },
    };
  }

  if (args.provider === "copilot") {
    const assignedSessionId = args.sessionId?.trim() || null;
    // Copilot 1.0.88 has no `--no-alt-screen` flag and exits 1 when it gets one.
    const commandArgs: string[] = [];
    if (assignedSessionId) {
      // `copilot --help` (1.0.88): "--session-id <id>  Resume an existing
      // session or task by ID, or set the UUID for a new session", with the
      // example `copilot --session-id=<uuid>` to "Start a new session with a
      // specific UUID". `--resume=<id>` is documented only for existing ids.
      commandArgs.push(...preassignedSessionIdArgs("copilot", assignedSessionId));
    }
    commandArgs.push(...copilotModelFlags(modelForLaunch));
    commandArgs.push(...copilotReasoningEffortFlags(args.reasoningEffort));
    commandArgs.push(...permissionModeToCopilotFlags(permissionMode));
    // Copilot has no flag for system text, so ADE's guidance rides in front of
    // the first message. An empty launch stays idle, as Cursor's does.
    const copilotFirstMessage = initialPrompt
      ? workTabCliPrompt(initialPrompt, sessionGuidance, activityGuidance)
      : null;
    const promptRidesInArgv = Boolean(copilotFirstMessage) && currentPlatform() !== "win32";
    if (copilotFirstMessage && promptRidesInArgv) {
      commandArgs.push("-i", copilotFirstMessage);
    }
    return {
      command: "copilot",
      args: commandArgs,
      // The shell fallback types this line; it carries the user's prompt only.
      // The guidance is several KB of multi-line text with apostrophes, which
      // the direct argv path carries safely and a typed line does not.
      startupCommand: commandArrayToLine(
        ["copilot", ...commandArgs.map((arg) => (arg === copilotFirstMessage && initialPrompt ? initialPrompt : arg))],
        { platform: "linux" },
      ),
      ...(assignedSessionId ? { assignedSessionId } : {}),
      ...(copilotFirstMessage && !promptRidesInArgv
        ? { initialInput: copilotFirstMessage, initialInputDelayMs: 750 }
        : {}),
      ...(agentSkillEnv ? { env: agentSkillEnv } : {}),
    };
  }

  if (args.provider === "devin") {
    const commandArgs: string[] = [
      ...devinModelFlags(args.model),
      ...permissionModeToDevinFlags(permissionMode),
    ];
    // `devin` is a native binary on every platform (no `.cmd` shim), and its
    // documented initial-prompt spelling is `devin -- <prompt>` — argv is a
    // safe transport for it on Windows too. Devin discovers AGENTS.md and
    // `.agents/skills/` in the lane itself, but neither names the `ade`
    // commands, so ADE's guidance rides in front of the first message. An
    // empty launch stays idle, as Cursor's does.
    const devinFirstMessage = initialPrompt
      ? workTabCliPrompt(initialPrompt, sessionGuidance, activityGuidance)
      : null;
    if (devinFirstMessage) {
      commandArgs.push("--", devinFirstMessage);
    }
    return {
      command: "devin",
      args: commandArgs,
      // As for Copilot: the typed fallback line carries the user's prompt only.
      startupCommand: commandArrayToLine(
        ["devin", ...commandArgs.map((arg) => (arg === devinFirstMessage && initialPrompt ? initialPrompt : arg))],
        { platform: "linux" },
      ),
      ...(agentSkillEnv ? { env: agentSkillEnv } : {}),
    };
  }

  // Only the user's own text rides `--prompt`: OpenCode submits it as a real
  // user message. ADE's contract reaches the session as an instruction entry
  // when the PTY host attaches the TUI to ADE's server.
  const opencode = buildOpenCodeCommandParts({
    permissionMode,
    model: modelForLaunch,
    reasoningEffort: args.reasoningEffort ?? null,
    ...(initialPrompt ? { prompt: initialPrompt } : {}),
  });
  const opencodeEnv = mergeLaunchEnv(
    mergeLaunchEnv(
      withAdeAgentSkillEnv(opencode.env, skillRoots),
      providerInstanceLaunchEnv(args.provider, args.instance),
    ),
    harnessPresetLaunchEnv(args.preset),
  );
  return {
    command: "opencode",
    args: opencode.args,
    startupCommand: opencode.startupCommand,
    ...(opencodeEnv ? { env: opencodeEnv } : {}),
  };
}

/**
 * Expose agent-reported detail only when this CLI launch mode has an ADE
 * guidance channel and a command tool ADE can rely on. The PTY host supplies
 * ADE_CLI_PATH and ADE_CHAT_SESSION_ID for chat-scoped commands, plus
 * ADE_ACTIVITY_SESSION_ID for activity reports, after this prompt is built.
 */
export function buildTrackedCliSessionActivityGuidance(args: {
  provider: CliProvider;
  permissionMode: AgentChatPermissionMode | null | undefined;
  droidPermissionMode?: AgentChatDroidPermissionMode | null;
  hasInitialPrompt?: boolean;
  sessionActivityReportingEnabled?: boolean;
}): string | null {
  if (args.sessionActivityReportingEnabled === false) return null;
  const mode = args.permissionMode;
  if (!mode || mode === "plan") return null;

  let supported = false;
  switch (args.provider) {
    case "claude":
      // The shell fallback intentionally removes --append-system-prompt. Do
      // not promise activity reporting until that launch path can carry it.
      supported = false;
      break;
    case "codex":
    case "opencode":
      // config-toml deliberately delegates tool permission to external config.
      supported = mode !== "config-toml";
      break;
    case "cursor":
      supported = args.hasInitialPrompt === true
        && (mode === "default" || mode === "edit" || mode === "full-auto");
      break;
    case "droid": {
      const droidMode = args.droidPermissionMode ?? droidPermissionModeFromLegacyPermissionMode(mode);
      supported = droidMode === "auto-low" || droidMode === "auto-medium" || droidMode === "auto-high";
      break;
    }
    case "pi":
      // Pi's tracked CLI allowlist grants Bash only in full-auto mode.
      supported = mode === "full-auto";
      break;
    default:
      // Muse, Qwen, Kimi, Grok, and Copilot do not yet have a verified tracked-CLI
      // path that combines ADE's system guidance, scoped CLI access, and shell.
      supported = false;
  }
  if (!supported) return null;

  return currentPlatform() === "win32"
    ? buildAdeWindowsTrackedCliActivityGuidance()
    : buildAdePosixTrackedCliActivityGuidance();
}

/**
 * This module is shared with the renderer bundle, where `process` may be absent
 * entirely. Callers only ever compare against `"win32"`, so an unknown host
 * degrades to the POSIX branch rather than throwing.
 */
function currentPlatform(): string {
  return typeof process !== "undefined" && typeof process.platform === "string" ? process.platform : "";
}

function normalizeInitialPrompt(value: string | null | undefined): string | null {
  const prompt = String(value ?? "").trim();
  return prompt.length ? prompt : null;
}

export function normalizeCliFlagValue(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length ? trimmed : null;
}

export function modelToCliFlag(model: string | null | undefined): string[] {
  const normalized = normalizeCliFlagValue(model);
  return normalized ? ["--model", normalized] : [];
}

function normalizeDroidCliModel(model: string | null | undefined): string | null {
  const normalized = normalizeCliFlagValue(model);
  if (!normalized) return null;
  const slash = normalized.indexOf("/");
  if (slash > 0 && normalized.slice(0, slash).toLowerCase() === "droid") {
    return normalized.slice(slash + 1).trim() || null;
  }
  return normalized;
}

export function resolveCursorCliModelForLaunch(model: string | null | undefined): string {
  const normalized = normalizeCliFlagValue(model);
  if (!normalized) return "auto";
  const slash = normalized.indexOf("/");
  if (slash > 0 && normalized.slice(0, slash).toLowerCase() === "cursor") {
    return normalized.slice(slash + 1).trim() || "auto";
  }
  return normalized;
}

export function resolveCodexCliModelForLaunch(model: string | null | undefined): string | null {
  const raw = String(model ?? "").trim();
  if (!raw) return null;
  const slash = raw.indexOf("/");
  if (slash > 0 && raw.slice(0, slash).toLowerCase() === "openai") {
    return raw.slice(slash + 1).trim() || null;
  }
  return raw;
}

/** Pi accepts provider/model, while ADE model refs may be prefixed with `pi/`. */
export function resolvePiCliModelForLaunch(model: string | null | undefined): string | null {
  const raw = normalizeCliFlagValue(model);
  if (!raw) return null;
  const slash = raw.indexOf("/");
  if (slash > 0 && raw.slice(0, slash).toLowerCase() === "pi") {
    const decoded = decodePiRegistryId(raw);
    if (decoded) return `${decoded.providerId}/${decoded.modelId}`;
    // Legacy Pi ids may only carry the provider/model suffix. Strip only
    // ADE's provider prefix and leave encoded model separators untouched.
    return raw.slice(slash + 1).trim() || null;
  }
  return raw;
}

export function piToolsForPermissionMode(permissionMode: AgentChatPermissionMode | null | undefined): string[] {
  const mode = permissionMode ?? "default";
  // Only Pi built-in names: an unknown name makes Pi reject the launch instead
  // of merely disabling an optional tool. Every mode that can read also gets
  // Pi's read-only search tools (`grep`, `find`, `ls`).
  return mode === "full-auto"
    ? ["read", "bash", "edit", "write", ...PI_SEARCH_TOOLS]
    : mode === "edit"
      ? ["read", "edit", "write", ...PI_SEARCH_TOOLS]
      : [...PI_READ_ONLY_TOOLS];
}


/**
 * How a Pi chat treats MCP tools: `off` loads no MCP support at all, `ask`
 * puts every MCP tool call behind the same approval card as a gated `bash`,
 * `allow` runs them.
 */
export type PiSdkMcpPolicy = "off" | "ask" | "allow";

/**
 * Tool policy for a Pi SDK chat session, where ADE can gate each call behind an
 * approval card.
 *
 * The CLI has no such gate, so `piToolsForPermissionMode` stays the stricter
 * allowlist-only mapping used for tracked terminals. Here `default` means "ask
 * before anything that changes the workspace" rather than "read-only", which is
 * what the mode means for every other ADE runtime.
 */
export function piSdkToolPolicyForPermissionMode(
  permissionMode: AgentChatPermissionMode | null | undefined,
  /**
   * The platform the chat's worker runs on (the brain's `process.platform`).
   * On Windows Pi also has a `powershell` tool, granted and gated exactly
   * like `bash`. Omitted means no `powershell`.
   */
  platform?: string | null,
): { tools: string[]; approvalTools: string[]; readOnly: boolean; mcp: PiSdkMcpPolicy } {
  const mode = permissionMode ?? "default";
  const shells = platform === "win32" ? ["bash", "powershell"] : ["bash"];
  if (mode === "full-auto") {
    return { tools: ["read", ...shells, "edit", "write", ...PI_SEARCH_TOOLS], approvalTools: [], readOnly: false, mcp: "allow" };
  }
  // Edit mode grants file edits outright but no shell. An MCP tool can do
  // anything a shell can, so it asks, as Claude's accept-edits mode does.
  if (mode === "edit") return { tools: ["read", "edit", "write", ...PI_SEARCH_TOOLS], approvalTools: [], readOnly: false, mcp: "ask" };
  // Plan mode is a review posture: reading is enough, and nothing to approve.
  // `readOnly` is stated rather than inferred from the tool list, because
  // callers gate real capabilities on it and adding a future read-only tool
  // must not silently flip them. No MCP: its tools can change anything.
  if (mode === "plan") return { tools: [...PI_READ_ONLY_TOOLS], approvalTools: [], readOnly: true, mcp: "off" };
  // default, auto, and config-toml all land here. Anything that changes the
  // workspace is offered rather than silently allowed or silently withheld.
  return {
    tools: ["read", ...shells, "edit", "write", ...PI_SEARCH_TOOLS],
    approvalTools: [...shells, "edit", "write"],
    readOnly: false,
    mcp: "ask",
  };
}

/**
 * Pi 1.0 opens its terminal UI fullscreen, which takes the screen over and
 * leaves ADE's terminal with no scrollback. The regular mode prints the
 * transcript into the terminal, so the user scrolls it as in any CLI.
 */
export const PI_TERMINAL_TUI_FLAGS = ["--tui-mode", "regular"] as const;

export function piToolFlags(permissionMode: AgentChatPermissionMode | null | undefined): string[] {
  // Passing no allowlist lets Pi's own settings decide, which is what the
  // user asked for by picking config-toml.
  if (permissionMode === "config-toml") return [];
  const tools = piToolsForPermissionMode(permissionMode);
  // Pi 1.0.4+ keeps MCP tools through a `--tools` allowlist unless an entry
  // names one, and an MCP tool can change the workspace. A read-only mapping
  // therefore turns MCP off for the run as well.
  const readOnly = tools.every((tool) => (PI_READ_ONLY_TOOLS as readonly string[]).includes(tool));
  return ["--tools", tools.join(","), ...(readOnly ? ["--no-mcp"] : [])];
}

/**
 * The Pi thinking level for an ADE reasoning effort, or null for one Pi has no
 * level for (Pi then keeps its own default). The Ultra tiers read as xhigh,
 * as they do for every runtime without them. The chat worker rejects any
 * other value, so the SDK path uses this too.
 */
export function piThinkingLevel(reasoningEffort: string | null | undefined): string | null {
  const normalized = normalizeCliFlagValue(reasoningEffort);
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  const thinking = lower === "ultra" || lower === "ultracode" ? "xhigh" : lower;
  return (PI_THINKING_LEVELS as readonly string[]).includes(thinking) ? thinking : null;
}

export function piThinkingFlags(reasoningEffort: string | null | undefined): string[] {
  const thinking = piThinkingLevel(reasoningEffort);
  return thinking ? ["--thinking", thinking] : [];
}

/**
 * The word ADE launches Muse with. The PTY boundary swaps it for the pinned
 * binary ADE fetched (`resolveMuseExecutable`); ADE never runs a user's own
 * `muse` install.
 */
export const MUSE_CLI_COMMAND = "muse";

/** Every reasoning effort `muse --reasoning-effort` accepts (1.4.7). */
const MUSE_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

/** Muse takes its own model id; ADE's registry ids carry a `muse/` prefix. */
export function resolveMuseCliModelForLaunch(model: string | null | undefined): string | null {
  return stripRegistryPrefix(model, "muse");
}

/** ADE's effort as a Muse effort, or null when Muse has no such tier (Muse keeps its default). */
export function resolveMuseReasoningEffort(reasoningEffort: string | null | undefined): string | null {
  const effort = normalizeCliFlagValue(reasoningEffort)?.toLowerCase();
  if (!effort) return null;
  const mapped = effort === "ultracode" ? "ultra" : effort;
  return (MUSE_REASONING_EFFORTS as readonly string[]).includes(mapped) ? mapped : null;
}

export function isMusePermissionMode(value: unknown): value is AgentChatMusePermissionMode {
  return typeof value === "string" && (AGENT_CHAT_MUSE_PERMISSION_MODE_VALUES as readonly string[]).includes(value);
}

/**
 * The CLI flags for a Muse permission posture.
 *
 * The CLI knows three approval words (`untrusted | on-request | never`), so
 * `museCliApprovalFlag` folds the two cautious wire modes together. The most
 * cautious one is the exception here: `untrusted` still lets the user approve
 * a write, which is more than "plan" allows, so `denyUnmatched` uses Muse's
 * built-in `:read-only` permission profile ("Reads files only") instead. Muse
 * refuses `--permission-profile` together with `--approval-mode`, so it is one
 * or the other.
 *
 * Full access is `--approval-mode never`, never `--yolo`: `--yolo` also turns
 * the sandbox off and trusts the workspace, which no ADE mode asks for.
 */
export function musePermissionCliFlags(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  musePermissionMode?: AgentChatMusePermissionMode | null;
}): string[] {
  const mode = isMusePermissionMode(args.musePermissionMode)
    ? args.musePermissionMode
    : musePermissionModeFromLegacyPermissionMode(args.permissionMode);
  if (!mode) return [];
  if (mode === "denyUnmatched") return ["--permission-profile", ":read-only"];
  return ["--approval-mode", museCliApprovalFlag(mode)];
}

/** One stdio MCP server for a Muse CLI run. */
export type MuseCliMcpServer = {
  name: string;
  command: string;
  args?: readonly string[];
  /**
   * Names of environment variables the server needs. Muse starts stdio
   * servers with only a small allowlist of the caller's environment, and its
   * `-c` overrides accept secret values only as a whole-value `${VAR}`, so
   * each name is passed as a reference, never as a value.
   */
  envVars?: readonly string[];
};

const MUSE_MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/u;
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * `-c mcpServers.<name>=<json>` for each server. Muse 1.4.7 accepts one server
 * per `-c` (it refuses the whole `mcpServers` map, and refuses a `type` key
 * there), with `command` a string and `args` an array. `mode: "optional"`
 * keeps a server that fails to start from blocking the whole run: Muse's
 * default is `required`, which fails the run.
 */
export function museMcpServerConfigFlags(servers: readonly MuseCliMcpServer[] | null | undefined): string[] {
  const flags: string[] = [];
  for (const server of servers ?? []) {
    const name = server.name?.trim() ?? "";
    const command = server.command?.trim() ?? "";
    if (!MUSE_MCP_SERVER_NAME.test(name) || !command) continue;
    const envVars = (server.envVars ?? []).filter((key) => ENV_VAR_NAME.test(key));
    const value: Record<string, unknown> = {
      command,
      args: [...(server.args ?? [])],
      ...(envVars.length ? { env: Object.fromEntries(envVars.map((key) => [key, `\${${key}}`])) } : {}),
      mode: "optional",
    };
    flags.push("-c", `mcpServers.${name}=${JSON.stringify(value)}`);
  }
  return flags;
}

/** Flags every Muse CLI launch (fresh or resumed) carries, in a stable order. */
function museBaseFlags(args: {
  model: string | null;
  reasoningEffort: string | null | undefined;
  permissionMode: AgentChatPermissionMode | null | undefined;
  musePermissionMode?: AgentChatMusePermissionMode | null;
}): string[] {
  const effort = resolveMuseReasoningEffort(args.reasoningEffort);
  return [
    // Contributor mode is never offered. `serve` ignores the saved setting
    // since 1.4.6, so ADE states it on every launch rather than relying on it.
    "--contributor-mode",
    "off",
    ...modelToCliFlag(args.model),
    ...(effort ? ["--reasoning-effort", effort] : []),
    ...musePermissionCliFlags(args),
  ];
}

export function codexReasoningEffortFlags(reasoningEffort: string | null | undefined): string[] {
  const effort = normalizeCliFlagValue(reasoningEffort);
  return effort ? ["-c", `model_reasoning_effort="${effort}"`] : [];
}

export function codexServiceTierFlags(
  fastMode: boolean | null | undefined,
  fastTier?: "ultrafast" | null,
): string[] {
  if (fastMode === true) {
    const tier = fastTier === "ultrafast" ? "ultrafast" : "fast";
    return ["-c", `service_tier="${tier}"`, "-c", "features.fast_mode=true"];
  }
  if (fastMode === false) {
    return ["-c", "service_tier=\"default\""];
  }
  return [];
}

export function claudeFastModeSettingsFlags(fastMode: boolean | null | undefined): string[] {
  if (fastMode === true) return ["--settings", JSON.stringify({ fastMode: true })];
  if (fastMode === false) return ["--settings", JSON.stringify({ fastMode: false })];
  return [];
}

export function claudeRuntimeEffortFlags(reasoningEffort: string | null | undefined): string[] {
  const effort = normalizeCliFlagValue(reasoningEffort);
  if (!effort) return [];
  if (effort === "ultracode") return ["--effort", "xhigh"];
  return ["--effort", effort];
}

function claudeSessionSettingsFlags(
  fastMode: boolean | null | undefined,
  reasoningEffort: string | null | undefined,
): string[] {
  const settings: Record<string, unknown> = {};
  if (fastMode === true) settings.fastMode = true;
  if (fastMode === false) settings.fastMode = false;
  if (normalizeCliFlagValue(reasoningEffort) === "ultracode") settings.ultracode = true;
  return Object.keys(settings).length ? ["--settings", JSON.stringify(settings)] : [];
}

function workTabCliPrompt(
  initialPrompt: string | null,
  sessionGuidance: string,
  additionalGuidance?: string | null,
): string {
  const preamble = workTabCliPreamblePrompt(sessionGuidance, Boolean(initialPrompt));
  const withAdditionalGuidance = additionalGuidance
    ? [preamble, "", additionalGuidance].join("\n")
    : preamble;
  if (!initialPrompt) return withAdditionalGuidance;
  return [
    withAdditionalGuidance,
    "",
    "User prompt:",
    initialPrompt,
  ].join("\n");
}

export function resolveClaudeCliModelForLaunch(model: string | null | undefined): string | null {
  return resolveClaudeCliModelAlias(model, null);
}

function permissionModeToClaudeFlag(permissionMode: AgentChatPermissionMode | null | undefined): string[] {
  if (permissionMode == null) return [];
  if (permissionMode === "full-auto") return ["--dangerously-skip-permissions"];
  if (permissionMode === "edit") return ["--permission-mode", "acceptEdits"];
  if (permissionMode === "auto") return ["--permission-mode", "auto"];
  if (permissionMode === "default") return ["--permission-mode", "default"];
  return ["--permission-mode", "plan"];
}

function permissionModeToCodexFlags(permissionMode: AgentChatPermissionMode | null | undefined): string[] {
  if (permissionMode === "full-auto") return ["--dangerously-bypass-approvals-and-sandbox"];
  if (permissionMode === "default") return ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"];
  if (permissionMode === "edit") return ["--sandbox", "workspace-write", "--ask-for-approval", "untrusted"];
  if (permissionMode === "plan") return ["--sandbox", "read-only", "--ask-for-approval", "on-request"];
  return [];
}

function codexResumePermissionFlags(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  approvalPolicy: AgentChatCodexApprovalPolicy | null | undefined;
  sandbox: AgentChatCodexSandbox | null | undefined;
  configSource: AgentChatCodexConfigSource | null | undefined;
}): string[] {
  if (args.configSource === "config-toml") return [];
  if (args.approvalPolicy && args.sandbox) {
    return ["--sandbox", args.sandbox, "--ask-for-approval", args.approvalPolicy];
  }
  if (args.approvalPolicy || args.sandbox) return [];
  return permissionModeToCodexFlags(args.permissionMode);
}

/**
 * ACP providers take the model id verbatim; ADE only strips its own registry
 * prefix. None of the four publishes a fixed enum any more — every one resolves
 * its catalog from the server at auth time — so an id ADE does not recognise is
 * forwarded rather than rejected, and the CLI gives the real error.
 */
function stripRegistryPrefix(model: string | null | undefined, prefix: string): string | null {
  const raw = normalizeCliFlagValue(model);
  if (!raw) return null;
  const slash = raw.indexOf("/");
  if (slash > 0 && raw.slice(0, slash).toLowerCase() === prefix) {
    return raw.slice(slash + 1).trim() || null;
  }
  return raw;
}

export function resolveQwenCliModelForLaunch(model: string | null | undefined): string | null {
  return stripRegistryPrefix(model, "qwen");
}

/**
 * Kimi's `-m` takes a config alias, not a raw model id, and the alias is always
 * namespaced (`kimi-code/k3`). A bare `k3` fails with "Unknown model alias", so
 * ADE restores the namespace when its own registry prefix stripped it away.
 */
export function resolveKimiCliModelForLaunch(model: string | null | undefined): string | null {
  const raw = stripRegistryPrefix(model, "moonshot");
  if (!raw) return null;
  return raw.includes("/") ? raw : `kimi-code/${raw}`;
}

export function resolveGrokCliModelForLaunch(model: string | null | undefined): string | null {
  return stripRegistryPrefix(model, "xai");
}

export function resolveCopilotCliModelForLaunch(model: string | null | undefined): string | null {
  return stripRegistryPrefix(model, "github-copilot");
}

export function resolveDevinCliModelForLaunch(model: string | null | undefined): string | null {
  return stripRegistryPrefix(model, "devin");
}

function qwenModelFlags(model: string | null | undefined): string[] {
  const resolved = resolveQwenCliModelForLaunch(model);
  return resolved ? ["-m", resolved] : [];
}

function kimiModelFlags(model: string | null | undefined): string[] {
  const resolved = resolveKimiCliModelForLaunch(model);
  return resolved ? ["-m", resolved] : [];
}

function grokModelFlags(model: string | null | undefined): string[] {
  const resolved = resolveGrokCliModelForLaunch(model);
  return resolved ? ["-m", resolved] : [];
}

function copilotModelFlags(model: string | null | undefined): string[] {
  const resolved = resolveCopilotCliModelForLaunch(model);
  return resolved ? ["--model", resolved] : [];
}

function devinModelFlags(model: string | null | undefined): string[] {
  const resolved = resolveDevinCliModelForLaunch(model);
  return resolved ? ["--model", resolved] : [];
}

const GROK_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

/**
 * ADE's effort as a Grok effort value, or `null` when Grok has no such tier.
 * The ACP session's `reasoning_effort` option and the TUI flag take the same
 * values.
 */
export function resolveGrokReasoningEffort(reasoningEffort: string | null | undefined): string | null {
  const effort = normalizeCliFlagValue(reasoningEffort)?.toLowerCase();
  if (!effort) return null;
  // ADE's ladder runs past Grok's: "max" and "ultracode" have no Grok tier, so
  // they land on its highest rather than being passed through and rejected.
  const mapped = effort === "max" || effort === "ultracode" ? "xhigh" : effort;
  return (GROK_REASONING_EFFORTS as readonly string[]).includes(mapped) ? mapped : null;
}

export function grokReasoningEffortFlags(reasoningEffort: string | null | undefined): string[] {
  const effort = resolveGrokReasoningEffort(reasoningEffort);
  return effort ? ["--reasoning-effort", effort] : [];
}

const COPILOT_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

export function copilotReasoningEffortFlags(reasoningEffort: string | null | undefined): string[] {
  const effort = normalizeCliFlagValue(reasoningEffort)?.toLowerCase();
  if (!effort) return [];
  const mapped = effort === "max" || effort === "ultracode" ? "xhigh" : effort;
  if (!(COPILOT_REASONING_EFFORTS as readonly string[]).includes(mapped)) return [];
  return ["--reasoning-effort", mapped];
}

/**
 * Qwen's approval ladder is plan | default | auto-edit | auto | yolo, set with
 * a single `--approval-mode`. `--yolo` is the older spelling of the same
 * setting: passing both makes Qwen reject the launch, so ADE only ever emits
 * `--approval-mode`.
 */
export function permissionModeToQwenFlags(
  permissionMode: AgentChatPermissionMode | null | undefined,
): string[] {
  if (permissionMode == null) return [];
  if (permissionMode === "full-auto") return ["--approval-mode", "yolo"];
  if (permissionMode === "auto") return ["--approval-mode", "auto"];
  if (permissionMode === "edit") return ["--approval-mode", "auto-edit"];
  if (permissionMode === "plan") return ["--approval-mode", "plan"];
  return ["--approval-mode", "default"];
}

/** Kimi's `--plan`, `--auto`, and `--yolo` are mutually exclusive switches. */
export function permissionModeToKimiFlags(
  permissionMode: AgentChatPermissionMode | null | undefined,
): string[] {
  if (permissionMode === "full-auto") return ["--yolo"];
  if (permissionMode === "edit") return ["--auto"];
  if (permissionMode === "plan") return ["--plan"];
  return [];
}

/**
 * Grok's own `--permission-mode` values line up with ADE's ladder one for one.
 * ADE never passes `-w/--worktree`: Grok would create a second git worktree
 * inside the lane worktree ADE already made.
 */
export function permissionModeToGrokFlags(
  permissionMode: AgentChatPermissionMode | null | undefined,
): string[] {
  if (permissionMode == null) return [];
  if (permissionMode === "full-auto") return ["--permission-mode", "bypassPermissions"];
  if (permissionMode === "auto") return ["--permission-mode", "auto"];
  if (permissionMode === "edit") return ["--permission-mode", "acceptEdits"];
  if (permissionMode === "plan") return ["--permission-mode", "plan"];
  return ["--permission-mode", "default"];
}

/**
 * Copilot has no plan mode and no approval ladder — only allow/deny tool
 * patterns. Plan becomes the two denials that make a session read-only
 * (`write` covers every file-creating tool, `shell` every command), which is
 * the closest honest equivalent. `validateLaunchProfilePermissionMode` already
 * rejected the two modes with no mapping at all.
 */
export function permissionModeToCopilotFlags(
  permissionMode: AgentChatPermissionMode | null | undefined,
): string[] {
  if (permissionMode === "full-auto") return ["--allow-all-tools"];
  if (permissionMode === "edit") return ["--allow-tool=write"];
  if (permissionMode === "plan") return ["--deny-tool=write", "--deny-tool=shell"];
  return [];
}

/**
 * Devin's `--permission-mode` accepts the mode names its `/mode` command
 * documents: normal, accept-edits, smart, plan, bypass. ADE's `auto` maps to
 * `smart` — a fast model auto-approves clearly-safe actions and prompts on
 * anything else, the closest honest tier. `config-toml` is already rejected
 * upstream because Devin has no raw-config passthrough.
 */
export function permissionModeToDevinFlags(
  permissionMode: AgentChatPermissionMode | null | undefined,
): string[] {
  if (permissionMode == null) return [];
  if (permissionMode === "full-auto") return ["--permission-mode", "bypass"];
  if (permissionMode === "auto") return ["--permission-mode", "smart"];
  if (permissionMode === "edit") return ["--permission-mode", "accept-edits"];
  if (permissionMode === "plan") return ["--permission-mode", "plan"];
  return ["--permission-mode", "normal"];
}

function permissionModeToCursorFlags(permissionMode: AgentChatPermissionMode | null | undefined): string[] {
  if (permissionMode === "full-auto") return ["--force"];
  if (permissionMode === "plan") return ["--mode", "plan"];
  if (permissionMode === "edit") return ["--mode", "ask"];
  return [];
}

function droidSettingsJson(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  droidPermissionMode?: AgentChatDroidPermissionMode | null;
  model?: string | null;
  reasoningEffort?: string | null;
}): string {
  const droidPermissionMode = args.droidPermissionMode
    ?? droidPermissionModeFromLegacyPermissionMode(args.permissionMode);
  const sessionDefaultSettings = (() => {
    switch (droidPermissionMode) {
      case "agi":
        return { interactionMode: "agi", autonomyLevel: "off" };
      case "read-only":
        return { interactionMode: "spec", autonomyLevel: "off" };
      case "auto-low":
        return { interactionMode: "auto", autonomyLevel: "low" };
      case "auto-medium":
        return { interactionMode: "auto", autonomyLevel: "medium" };
      case "auto-high":
        return { interactionMode: "auto", autonomyLevel: "high" };
      default:
        return null;
    }
  })();
  const model = normalizeDroidCliModel(args.model);
  const reasoningEffort = normalizeCliFlagValue(args.reasoningEffort);
  const settings: Record<string, unknown> = {
    ...(sessionDefaultSettings ? { sessionDefaultSettings } : {}),
  };
  if (model) settings.model = model;
  if (reasoningEffort) settings.reasoningEffort = reasoningEffort;
  if (droidPermissionMode === "read-only") {
    const specDefaults = sessionDefaultSettings as Record<string, unknown>;
    if (model) specDefaults.specModeModel = model;
    if (reasoningEffort) specDefaults.specModeReasoningEffort = reasoningEffort;
  }
  return JSON.stringify(settings);
}

/** PowerShell's literal-string quoting. */
export function quotePowerShellArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function droidPowerShellCommand(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  droidPermissionMode?: AgentChatDroidPermissionMode | null;
  model?: string | null;
  reasoningEffort?: string | null;
  prompt?: string;
  resumeTarget?: string | null;
}): string {
  const settingsJson = droidSettingsJson(args);
  const droidArgs = ["--settings", "$env:ADE_DROID_SETTINGS"];
  if (args.resumeTarget !== undefined) {
    droidArgs.push("--resume");
    if (args.resumeTarget) droidArgs.push(args.resumeTarget);
  }
  if (args.prompt) droidArgs.push(args.prompt);
  const argv = [
    quotePowerShellArg("droid"),
    ...droidArgs.map((arg) => arg === "$env:ADE_DROID_SETTINGS" ? arg : quotePowerShellArg(arg)),
  ].join(" ");
  return [
    "$env:ADE_DROID_SETTINGS = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), [System.IO.Path]::GetRandomFileName() + '.json')",
    `[System.IO.File]::WriteAllText($env:ADE_DROID_SETTINGS, ${quotePowerShellArg(settingsJson)}, [System.Text.UTF8Encoding]::new($false))`,
    `& ${argv}`,
    "$ADE_DROID_STATUS = $LASTEXITCODE",
    "Remove-Item -LiteralPath $env:ADE_DROID_SETTINGS -ErrorAction SilentlyContinue",
    "exit $ADE_DROID_STATUS",
  ].join("; ");
}

function buildDroidCommandLine(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  droidPermissionMode?: AgentChatDroidPermissionMode | null;
  model?: string | null;
  reasoningEffort?: string | null;
  prompt?: string;
  resumeTarget?: string | null;
}): string {
  const settingsJson = droidSettingsJson(args);
  const droidArgs = ["droid", "--settings", "$ADE_DROID_SETTINGS"];
  if (args.resumeTarget !== undefined) {
    droidArgs.push("--resume");
    if (args.resumeTarget) droidArgs.push(args.resumeTarget);
  }
  if (args.prompt) droidArgs.push(args.prompt);
  const droidCommand = commandArrayToLine(droidArgs, { platform: "linux" })
    .replace(
      quoteShellArg("$ADE_DROID_SETTINGS", { platform: "linux" }),
      "\"$ADE_DROID_SETTINGS\"",
    );
  return [
    "ADE_DROID_SETTINGS=\"$(mktemp \"${TMPDIR:-/tmp}/ade-droid-settings.XXXXXX.json\")\"",
    `printf %s ${quoteShellArg(settingsJson, { platform: "linux" })} > "$ADE_DROID_SETTINGS"`,
    `${droidCommand}; ADE_DROID_STATUS=$?; rm -f "$ADE_DROID_SETTINGS"; exit $ADE_DROID_STATUS`,
  ].join(" && ");
}

/**
 * ADE's launch intent for a tracked OpenCode terminal: permission mode, model,
 * and effort, as JSON in one environment variable.
 *
 * The 2.0 TUI takes none of these as flags (it rejects `--agent` and
 * `--model`), and its config comes from the server it attaches to, not from
 * its own environment. So the PTY host reads this intent, creates the session
 * on ADE's server with the matching ADE agent and model, and launches the TUI
 * on that session (see `openCodeTerminal.ts`). The intent also rides the
 * command line so the persisted launch metadata can be read back from it.
 */
export const ADE_OPENCODE_LAUNCH_ENV = "ADE_OPENCODE_LAUNCH";

export type OpenCodeLaunchIntent = {
  permissionMode?: AgentChatPermissionMode;
  model?: string;
  reasoningEffort?: string;
};

function openCodeLaunchIntentValue(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  model?: string | null;
  reasoningEffort?: string | null;
}): string | null {
  const model = normalizeOpenCodeCliModel(args.model);
  const reasoningEffort = normalizeCliFlagValue(args.reasoningEffort);
  const intent: OpenCodeLaunchIntent = {
    ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
  return Object.keys(intent).length ? JSON.stringify(intent) : null;
}

function parseOpenCodeLaunchIntent(value: string | null | undefined): OpenCodeLaunchIntent | null {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    // The intent rides a persisted command line, so a mode outside the union is dropped.
    const permissionMode = typeof record.permissionMode === "string" ? record.permissionMode.trim() : null;
    return {
      ...(isTrackedCliPermissionMode(permissionMode) ? { permissionMode } : {}),
      ...(typeof record.model === "string" && record.model.trim() ? { model: record.model.trim() } : {}),
      ...(typeof record.reasoningEffort === "string" && record.reasoningEffort.trim()
        ? { reasoningEffort: record.reasoningEffort.trim() }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The launch intent carried by a command line's leading assignments, else by
 * the environment. The command line wins: a leading `NAME=value` overrides
 * the process environment for that command.
 */
export function readOpenCodeLaunchIntent(
  startupCommand: string | null | undefined,
  env?: Record<string, string | undefined> | null,
): OpenCodeLaunchIntent | null {
  if (startupCommand?.trim()) {
    for (const token of parseCommandLine(startupCommand, { platform: "linux" })) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) break;
      if (token.startsWith(`${ADE_OPENCODE_LAUNCH_ENV}=`)) {
        return parseOpenCodeLaunchIntent(token.slice(ADE_OPENCODE_LAUNCH_ENV.length + 1));
      }
    }
  }
  return parseOpenCodeLaunchIntent(env?.[ADE_OPENCODE_LAUNCH_ENV]);
}

function normalizeOpenCodeCliModel(model: string | null | undefined): string | null {
  const normalized = normalizeCliFlagValue(model);
  if (!normalized) return null;
  const decoded = decodeOpenCodeRegistryId(normalized);
  if (!decoded) return normalized;
  return `${decoded.openCodeProviderId}/${decoded.openCodeModelId}`;
}

function buildOpenCodeCommandParts(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  model?: string | null;
  reasoningEffort?: string | null;
  prompt?: string;
  resumeTarget?: string | null;
  continueLast?: boolean;
}): { args: string[]; startupCommand: string; env?: Record<string, string> } {
  // The full root TUI. It takes only a session selector and a prompt; the
  // server URL is added at launch, because it changes whenever ADE's server
  // restarts and must never be persisted.
  const commandArgs: string[] = [];
  if (args.resumeTarget) {
    commandArgs.push("--session", args.resumeTarget);
  } else if (args.continueLast) {
    commandArgs.push("--continue");
  }
  if (args.prompt) {
    commandArgs.push("--prompt", args.prompt);
  }
  const intent = openCodeLaunchIntentValue(args);
  const assignment = intent ? `${ADE_OPENCODE_LAUNCH_ENV}=${quoteShellArg(intent, { platform: "linux" })} ` : "";
  return {
    args: commandArgs,
    startupCommand: `${assignment}${commandArrayToLine(["opencode", ...commandArgs], { platform: "linux" })}`,
    ...(intent ? { env: { [ADE_OPENCODE_LAUNCH_ENV]: intent } } : {}),
  };
}

export type TrackedCliResumeOverrides = {
  model?: string | null;
  reasoningEffort?: string | null;
  fastMode?: boolean | null;
  permissionMode?: AgentChatPermissionMode | null;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy | null;
  codexSandbox?: AgentChatCodexSandbox | null;
  codexConfigSource?: AgentChatCodexConfigSource | null;
  prompt?: string | null;
  codexComputerUse?: CodexComputerUseCliConfig | null;
  /** The user's own MCP servers for a Claude or Codex resume, resolved in main. */
  userMcp?: TrackedCliUserMcp | null;
  /**
   * The account named by `metadata.launch.instanceId`, already resolved by the
   * caller (including the fallback to the provider's default when that id no
   * longer names anything). Omit it and the resume inherits whatever config
   * home the environment already points at, exactly as before this existed.
   */
  instance?: ProviderInstanceLaunchTarget | null;
  /**
   * The preset named by `metadata.launch.presetId`, already resolved by the
   * caller. A resume that cannot resolve it (deleted preset, key removed)
   * omits it, and the terminal comes back on the harness's native sign-in.
   */
  preset?: TrackedCliPresetLaunch | null;
};

/** Canonical read of the account a tracked CLI session launched under. */
export function trackedCliResumeInstanceId(
  metadata: Pick<TerminalResumeMetadata, "launch" | "instanceId"> | null | undefined,
): string | null {
  for (const value of [metadata?.launch?.instanceId, metadata?.instanceId]) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed.length) return trimmed;
  }
  return null;
}

/** Canonical read of the harness preset a tracked CLI session launched under. */
export function trackedCliResumePresetId(
  metadata: Pick<TerminalResumeMetadata, "launch" | "presetId"> | null | undefined,
): string | null {
  for (const value of [metadata?.launch?.presetId, metadata?.presetId]) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed.length) return trimmed;
  }
  return null;
}

/** Canonical read of the stored credential a tracked CLI session launched under. */
export function trackedCliResumeCredentialId(
  metadata: Pick<TerminalResumeMetadata, "launch" | "credentialId"> | null | undefined,
): string | null {
  for (const value of [metadata?.launch?.credentialId, metadata?.credentialId]) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed.length) return trimmed;
  }
  return null;
}

export function buildTrackedCliResumeLaunchCommand(
  metadata: TerminalResumeMetadata,
  overrides: TrackedCliResumeOverrides = {},
  options: { platform?: NodeJS.Platform } = {},
): TrackedCliLaunchCommand {
  const launch = buildProviderResumeLaunchCommand(metadata, overrides, options);
  // Preset last, for the same reason as a fresh launch: a preset that owns its
  // own config home must outrank the account patch.
  const resumeEnv = {
    ...providerInstanceLaunchEnv(metadata.provider, overrides.instance),
    ...harnessPresetLaunchEnv(overrides.preset),
  };
  if (!Object.keys(resumeEnv).length) return launch;
  return { ...launch, env: { ...(launch.env ?? {}), ...resumeEnv } };
}

const CLAUDE_SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Claude same-folder copy with the new conversation's id chosen up front:
 * `claude … --resume <source> --fork-session --session-id <new>`. Claude Code
 * 2.1.287 accepts `--session-id` beside `--resume` only together with
 * `--fork-session` (see {@link claudeArgsResumeExistingSession}), so ADE knows
 * the copy's id before the process starts instead of discovering it later.
 *
 * `metadata.targetId` is the SOURCE session; `newSessionId` must be a UUID.
 * The returned `assignedSessionId` is the id to store as the copy's resume
 * target.
 */
export function buildClaudeForkLaunchCommand(
  metadata: TerminalResumeMetadata,
  newSessionId: string,
  overrides: TrackedCliResumeOverrides = {},
  options: { platform?: NodeJS.Platform } = {},
): TrackedCliLaunchCommand & { command: string; assignedSessionId: string } {
  if (metadata.provider !== "claude") {
    throw new Error(`buildClaudeForkLaunchCommand only forks Claude sessions, not ${metadata.provider}.`);
  }
  if (!sanitizeTrackedCliResumeTargetId(metadata.targetId)) {
    throw new Error("A Claude fork needs the source session id.");
  }
  const forkId = newSessionId.trim();
  if (!CLAUDE_SESSION_UUID.test(forkId)) {
    throw new Error("A Claude fork's new session id must be a UUID.");
  }
  const prompt = normalizeCliFlagValue(overrides.prompt);
  // The resume builder appends the prompt after the target; build without it so
  // the fork flags stay ahead of the positional prompt.
  const base = buildTrackedCliResumeLaunchCommand(metadata, { ...overrides, prompt: null }, options);
  const command = base.command ?? "claude";
  const args = [...base.args, "--fork-session", "--session-id", forkId, ...(prompt ? [prompt] : [])];
  return {
    ...base,
    command,
    args,
    startupCommand: commandArrayToLine([command, ...args], { platform: "linux" }),
    assignedSessionId: forkId,
  };
}

function buildProviderResumeLaunchCommand(
  metadata: TerminalResumeMetadata,
  overrides: TrackedCliResumeOverrides,
  options: { platform?: NodeJS.Platform },
): TrackedCliLaunchCommand {
  const permissionMode = overrides.permissionMode ?? metadata.launch.permissionMode;
  const hasPermissionModeOverride = overrides.permissionMode !== undefined;
  const codexApprovalPolicy = overrides.codexApprovalPolicy !== undefined
    ? overrides.codexApprovalPolicy
    : hasPermissionModeOverride
      ? null
      : metadata.launch.codexApprovalPolicy;
  const codexSandbox = overrides.codexSandbox !== undefined
    ? overrides.codexSandbox
    : hasPermissionModeOverride
      ? null
      : metadata.launch.codexSandbox;
  const codexConfigSource = overrides.codexConfigSource !== undefined
    ? overrides.codexConfigSource
    : hasPermissionModeOverride
      ? null
      : metadata.launch.codexConfigSource;
  const model = overrides.model !== undefined ? overrides.model : metadata.launch.model;
  const reasoningEffort = overrides.reasoningEffort !== undefined
    ? overrides.reasoningEffort
    : metadata.launch.reasoningEffort;
  const fastMode = overrides.fastMode !== undefined
    ? overrides.fastMode
    : metadata.launch.fastMode ?? metadata.launch.codexFastMode;
  // A resume that sets Fast itself means plain Fast; otherwise keep the tier
  // the session launched with.
  const fastTier = overrides.fastMode !== undefined ? null : metadata.launch.fastTier ?? null;
  const droidPermissionMode = overrides.permissionMode !== undefined
    ? droidPermissionModeFromLegacyPermissionMode(permissionMode)
    : metadata.launch.droidPermissionMode
      ?? droidPermissionModeFromLegacyPermissionMode(permissionMode);
  // A permission override speaks ADE's generic ladder, so it replaces the
  // stored Muse mode rather than sitting beside it.
  const musePermissionMode = overrides.permissionMode !== undefined
    ? null
    : metadata.launch.musePermissionMode ?? null;
  const prompt = normalizeCliFlagValue(overrides.prompt);
  const passthroughModelId = overrides.preset?.passthroughModelId === true;
  const modelForLaunch = passthroughModelId
    ? normalizeCliFlagValue(model)
    : model;
  validateLaunchProfilePermissionMode(metadata.provider, permissionMode);

  const targetId = sanitizeTrackedCliResumeTargetId(metadata.targetId) ?? "";
  if (metadata.provider === "claude") {
    const parts = ["claude", ...permissionModeToClaudeFlag(permissionMode)];
    const claudeModel = passthroughModelId
      ? normalizeCliFlagValue(model)
      : resolveClaudeCliModelForLaunch(model);
    if (claudeModel) parts.push("--model", claudeModel);
    parts.push(...claudeRuntimeEffortFlags(reasoningEffort));
    parts.push(...claudeSessionSettingsFlags(fastMode, reasoningEffort));
    parts.push(...trackedCliUserMcpFlags("claude", overrides.userMcp));
    parts.push("--resume");
    if (targetId) parts.push(targetId);
    if (prompt) parts.push(prompt);
    return {
      command: parts[0]!,
      args: parts.slice(1),
      startupCommand: commandArrayToLine(parts, { platform: "linux" }),
    };
  }

  if (metadata.provider === "codex") {
    const codexModel = passthroughModelId
      ? normalizeCliFlagValue(model)
      : resolveCodexCliModelForLaunch(model);
    const parts = [
      "codex",
      "--no-alt-screen",
      ...modelToCliFlag(codexModel),
      ...codexReasoningEffortFlags(reasoningEffort),
      ...codexServiceTierFlags(fastMode, fastTier),
      ...trackedCliUserMcpFlags("codex", overrides.userMcp),
      ...codexComputerUseMcpFlags(overrides.codexComputerUse),
      ...codexResumePermissionFlags({
        permissionMode,
        approvalPolicy: codexApprovalPolicy,
        sandbox: codexSandbox,
        configSource: codexConfigSource,
      }),
    ];
    parts.push("resume");
    if (targetId) parts.push(targetId);
    if (prompt) parts.push(prompt);
    return {
      command: parts[0]!,
      args: parts.slice(1),
      startupCommand: commandArrayToLine(parts, { platform: "linux" }),
    };
  }

  if (metadata.provider === "cursor") {
    const cursorModel = normalizeCliFlagValue(modelForLaunch)
      ? (passthroughModelId ? normalizeCliFlagValue(model) : resolveCursorCliModelForLaunch(model))
      : null;
    const parts = [
      "cursor-agent",
      ...permissionModeToCursorFlags(permissionMode),
      ...modelToCliFlag(cursorModel),
    ];
    // Only a captured chat id resumes. `cursor-agent --continue` means "the most
    // recent chat", which can be another terminal's or an ADE chat's — the same
    // wrong-conversation hazard Pi refuses. Without an id this is a fresh
    // launch, and the PTY resume path refuses to treat it as a resume at all.
    if (targetId) parts.push("--resume", targetId);
    if (prompt) parts.push(prompt);
    return {
      command: parts[0]!,
      args: parts.slice(1),
      startupCommand: commandArrayToLine(parts, { platform: "linux" }),
    };
  }

  if (metadata.provider === "droid") {
    if (permissionMode == null && droidPermissionMode == null && !normalizeCliFlagValue(model) && !normalizeCliFlagValue(reasoningEffort)) {
      const parts = ["droid"];
      if (targetId) parts.push("--resume", targetId);
      else parts.push("--resume");
      if (prompt) parts.push(prompt);
      return {
        command: parts[0]!,
        args: parts.slice(1),
        startupCommand: commandArrayToLine(parts, { platform: "linux" }),
      };
    }
    const droidArgs = {
      permissionMode,
      droidPermissionMode,
      model: modelForLaunch,
      reasoningEffort,
      ...(prompt ? { prompt } : {}),
      resumeTarget: targetId || null,
    };
    if ((options.platform ?? process.platform) === "win32") {
      // Same PowerShell transport as a fresh Windows launch, and the same
      // reason the prompt cannot ride along: `& 'droid' … '<multi-line>'` is
      // truncated at the first newline by a `.cmd` shim. The prompt is surfaced
      // as `initialInput` so the PTY resume path knows it still owes the user a
      // post-launch write instead of assuming the command line carried it.
      const startupCommand = droidPowerShellCommand({ ...droidArgs, prompt: undefined });
      return {
        command: "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", startupCommand],
        startupCommand,
        ...(prompt ? { initialInput: prompt } : {}),
      };
    }
    const startupCommand = buildDroidCommandLine(droidArgs);
    return {
      command: "/bin/bash",
      args: ["-lc", startupCommand],
      startupCommand,
    };
  }

  if (metadata.provider === "pi") {
    const parts = [
      "pi",
      ...modelToCliFlag(resolvePiCliModelForLaunch(modelForLaunch)),
      ...piThinkingFlags(reasoningEffort),
      ...piToolFlags(permissionMode),
      ...PI_TERMINAL_TUI_FLAGS,
    ];
    // Pi's supported native continuation target is a session id/file passed to
    // --session. When ADE has not captured a concrete id, it starts a fresh
    // session rather than falling back to `--continue`: "continue" means "the
    // most recent session for this directory", which since chat and CLI share
    // one native store can be another terminal's session or an ADE chat's.
    // Terminals were silently reopening days-old transcripts that way.
    if (metadata.targetKind === "session" && targetId) parts.push("--session", targetId);
    // A bare `pi` command resolves to an npm `.cmd` shim on some Windows
    // installs. `cmd.exe` rewrites multiline prompts, expands `%NAME%`, and
    // imposes a command-line length limit, so deliver the resume prompt over
    // the PTY on Windows just like fresh Pi launches do. POSIX keeps the
    // prompt in argv where it round-trips intact.
    const promptRidesInArgv = Boolean(prompt) && (options.platform ?? process.platform) !== "win32";
    if (prompt && promptRidesInArgv) parts.push(prompt);
    return {
      command: parts[0]!,
      args: parts.slice(1),
      startupCommand: commandArrayToLine(parts, { platform: "linux" }),
      ...(prompt && !promptRidesInArgv ? { initialInput: prompt, initialInputDelayMs: 750 } : {}),
    };
  }

  if (metadata.provider === "muse") {
    const museModel = passthroughModelId
      ? normalizeCliFlagValue(model)
      : resolveMuseCliModelForLaunch(model);
    const parts = [
      MUSE_CLI_COMMAND,
      ...museBaseFlags({ model: museModel, reasoningEffort, permissionMode, musePermissionMode }),
    ];
    // Only a captured session id resumes. `muse resume --last` means "the most
    // recent session in this workspace", which can be another terminal's or an
    // ADE chat's (the same hazard Pi and Cursor refuse). Without an id this is
    // a fresh launch, and the prompt rides argv as on any fresh launch.
    if (targetId) {
      parts.push("resume", targetId);
      // `muse resume <id>` refuses a second positional ("unknown argument
      // `resume`" in 1.4.7), so a continuation prompt is typed into the TUI
      // once it is ready.
      return {
        command: parts[0]!,
        args: parts.slice(1),
        startupCommand: commandArrayToLine(parts, { platform: "linux" }),
        ...(prompt ? { initialInput: prompt, initialInputDelayMs: 750 } : {}),
      };
    }
    if (prompt) parts.push(prompt);
    return {
      command: parts[0]!,
      args: parts.slice(1),
      startupCommand: commandArrayToLine(parts, { platform: "linux" }),
    };
  }

  if (metadata.provider === "qwen") {
    const parts = [
      "qwen",
      ...qwenModelFlags(modelForLaunch),
      ...permissionModeToQwenFlags(permissionMode),
    ];
    // `--session-id` is never emitted here: it starts a new conversation and is
    // mutually exclusive with the resume selector, exactly as with Claude.
    if (targetId) parts.push("--resume", targetId);
    else parts.push("--continue");
    const promptRidesInArgv = Boolean(prompt) && (options.platform ?? process.platform) !== "win32";
    if (prompt && promptRidesInArgv) parts.push("-i", prompt);
    return {
      command: parts[0]!,
      args: parts.slice(1),
      startupCommand: commandArrayToLine(parts, { platform: "linux" }),
      ...(prompt && !promptRidesInArgv ? { initialInput: prompt, initialInputDelayMs: 750 } : {}),
    };
  }

  if (metadata.provider === "kimi") {
    const parts = [
      "kimi",
      ...kimiModelFlags(modelForLaunch),
      ...permissionModeToKimiFlags(permissionMode),
    ];
    // Lowercase `-c`, and `-S` for a session id — Kimi's resume selectors do
    // not follow the `--resume` spelling every other provider here uses.
    if (targetId) parts.push("-S", targetId);
    else parts.push("-c");
    return {
      command: parts[0]!,
      args: parts.slice(1),
      startupCommand: commandArrayToLine(parts, { platform: "linux" }),
      // Kimi's TUI takes no argv prompt on resume either.
      ...(prompt ? { initialInput: prompt, initialInputDelayMs: 750 } : {}),
    };
  }

  if (metadata.provider === "grok") {
    const parts = [
      "grok",
      "--no-alt-screen",
      ...grokModelFlags(modelForLaunch),
      ...grokReasoningEffortFlags(reasoningEffort),
      ...permissionModeToGrokFlags(permissionMode),
    ];
    if (targetId) parts.push("-r", targetId);
    else parts.push("-c");
    const promptRidesInArgv = Boolean(prompt) && (options.platform ?? process.platform) !== "win32";
    if (prompt && promptRidesInArgv) parts.push(prompt);
    return {
      command: parts[0]!,
      args: parts.slice(1),
      startupCommand: commandArrayToLine(parts, { platform: "linux" }),
      ...(prompt && !promptRidesInArgv ? { initialInput: prompt, initialInputDelayMs: 750 } : {}),
      // A resumed Grok TUI re-reads the user's Claude settings on start, so the
      // kill switch has to ride the resume too. Fresh launch and resume must
      // agree, or the same chat changes posture when it is reattached.
      env: grokSupervisionEnv(),
    };
  }

  if (metadata.provider === "copilot") {
    const parts = [
      "copilot",
      ...copilotModelFlags(modelForLaunch),
      ...copilotReasoningEffortFlags(reasoningEffort),
      ...permissionModeToCopilotFlags(permissionMode),
    ];
    if (targetId) parts.push(`--resume=${targetId}`);
    else parts.push("--continue");
    const promptRidesInArgv = Boolean(prompt) && (options.platform ?? process.platform) !== "win32";
    if (prompt && promptRidesInArgv) parts.push("-i", prompt);
    return {
      command: parts[0]!,
      args: parts.slice(1),
      startupCommand: commandArrayToLine(parts, { platform: "linux" }),
      ...(prompt && !promptRidesInArgv ? { initialInput: prompt, initialInputDelayMs: 750 } : {}),
    };
  }

  if (metadata.provider === "devin") {
    const parts = [
      "devin",
      ...devinModelFlags(model),
      ...permissionModeToDevinFlags(permissionMode),
    ];
    // `-r <id>` resumes a specific session; `-c` resumes the most recent one
    // in the current directory. The same `--` argv prompt as a fresh launch.
    if (targetId) parts.push("--resume", targetId);
    else parts.push("--continue");
    if (prompt) parts.push("--", prompt);
    return {
      command: parts[0]!,
      args: parts.slice(1),
      startupCommand: commandArrayToLine(parts, { platform: "linux" }),
    };
  }

  const opencode = buildOpenCodeCommandParts({
    permissionMode,
    model: modelForLaunch,
    reasoningEffort,
    ...(prompt ? { prompt } : {}),
    resumeTarget: targetId || null,
    continueLast: !targetId,
  });
  return {
    command: "opencode",
    args: opencode.args,
    startupCommand: opencode.startupCommand,
    ...(opencode.env ? { env: opencode.env } : {}),
  };
}

export function buildTrackedCliResumeCommand(
  metadata: TerminalResumeMetadata,
  overrides: TrackedCliResumeOverrides = {},
): string {
  // Persisted/display commands retain the established POSIX representation.
  // The PTY resume path consumes the structured descriptor on Windows.
  return buildTrackedCliResumeLaunchCommand(metadata, overrides, { platform: "linux" }).startupCommand;
}

export function resolveTrackedCliResumeCommand(session: Pick<TerminalSessionSummary, "resumeCommand" | "resumeMetadata">): string | null {
  if (session.resumeMetadata) {
    return buildTrackedCliResumeCommand(session.resumeMetadata);
  }
  const command = session.resumeCommand?.trim() ?? "";
  return command.length > 0 ? command : null;
}

/**
 * Resolve `pty.create` launch fields, treating caller-supplied overrides as
 * atomic so we never mix the caller's `startupCommand` with default
 * `command`/`args` (or vice versa). If the caller passed *any* override field,
 * we use exactly what they supplied — defaults are skipped entirely. Only
 * when the caller passed nothing do we fall back to the profile's default
 * launch command.
 */
export function resolveLaunchFields<P extends LaunchProfile>(args: {
  profile: P;
  permissionMode?: AgentChatPermissionMode;
  startupCommand?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  initialInput?: string;
  initialInputDelayMs?: number;
}): {
  startupCommand?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  initialInput?: string;
  initialInputDelayMs?: number;
} {
  const permissionMode = args.permissionMode ?? "default";
  validateLaunchProfilePermissionMode(args.profile, permissionMode);

  const callerHasOverride =
    args.startupCommand !== undefined
    || args.command !== undefined
    || args.args !== undefined
    || args.env !== undefined
    || args.initialInput !== undefined
    || args.initialInputDelayMs !== undefined;

  if (callerHasOverride) {
    return {
      ...(args.startupCommand !== undefined ? { startupCommand: args.startupCommand } : {}),
      ...(args.command !== undefined ? { command: args.command } : {}),
      ...(args.args !== undefined ? { args: args.args } : {}),
      ...(args.env !== undefined ? { env: args.env } : {}),
      ...(args.initialInput !== undefined ? { initialInput: args.initialInput } : {}),
      ...(args.initialInputDelayMs !== undefined ? { initialInputDelayMs: args.initialInputDelayMs } : {}),
    };
  }

  if (args.profile === "shell") return {};

  const defaultLaunch = buildTrackedCliLaunchCommand({
    provider: args.profile,
    permissionMode,
  });
  return {
    startupCommand: defaultLaunch.startupCommand,
    ...(defaultLaunch.command !== undefined ? { command: defaultLaunch.command } : {}),
    args: defaultLaunch.args,
    ...(defaultLaunch.env ? { env: defaultLaunch.env } : {}),
    ...(defaultLaunch.initialInput !== undefined ? { initialInput: defaultLaunch.initialInput } : {}),
    ...(defaultLaunch.initialInputDelayMs !== undefined ? { initialInputDelayMs: defaultLaunch.initialInputDelayMs } : {}),
  };
}

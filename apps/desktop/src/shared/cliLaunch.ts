import type {
  AgentChatCodexApprovalPolicy,
  AgentChatCodexConfigSource,
  AgentChatCodexSandbox,
  AgentChatPermissionMode,
  PtySendToSessionArgs,
  TerminalResumeLaunchConfig,
  TerminalResumeMetadata,
  TerminalSessionSummary,
  TerminalToolType,
  WindowsShellKind,
} from "./types";
import {
  ADE_AGENT_SKILLS_DIRS_ENV,
  getAdeAgentSkillRootsForPrompt,
  getAgentSkillRootCandidates,
  joinAdeAgentSkillRoots,
} from "./agentSkillRoots";
import { buildAdeCliAgentGuidance, buildAdeCliInlineGuidance } from "./adeCliGuidance";
import { isProviderSlashCommandInput } from "./chatSlashCommands";
import { resolveClaudeCliModelAlias } from "./claudeCliModels";
import { decodeOpenCodeRegistryId, decodePiRegistryId } from "./modelRegistry";
import { effectiveOrchestrationPermissionMode } from "./orchestrationRuntimePolicy";
import { commandArrayToLine, parseCommandLine, quoteShellArg } from "./shell";
import type { OrchestrationRole } from "./types/orchestration";

export type CliProvider = "claude" | "codex" | "cursor" | "droid" | "opencode" | "pi";
export type LaunchProfile = CliProvider | "shell";
export type TrackedCliLaunchCommand = {
  command?: string;
  args: string[];
  startupCommand: string;
  initialInput?: string;
  initialInputDelayMs?: number;
  env?: Record<string, string>;
};

export type CodexComputerUseCliConfig = {
  command: string;
  args?: readonly string[];
};

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

export const LAUNCH_PROFILES = ["claude", "codex", "cursor", "droid", "opencode", "pi", "shell"] as const satisfies readonly LaunchProfile[];
export const TRACKED_CLI_PERMISSION_MODES = ["default", "auto", "plan", "edit", "full-auto", "config-toml"] as const satisfies readonly AgentChatPermissionMode[];

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
    let quote: "'" | "\"" | null = null;
    let escaped = false;
    while (index < command.length) {
      const char = command[index]!;
      if (escaped) {
        escaped = false;
      } else if (quote === "'") {
        if (char === "'") quote = null;
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

// Insert `--plugin-dir <root>` right after the `claude` token of a shell
// command line, leaving env-var prefixes and the caller's own flags intact.
export function withClaudePluginInCommandLine(commandLine: string, pluginRoot: string): string {
  if (!commandLine?.trim()) return commandLine;
  let commandArgs: string[] = [];
  try {
    commandArgs = parseCommandLine(commandLine);
  } catch {
    // Keep malformed or unsupported shell input intact.
    return commandLine;
  }
  const claudeIndex = commandArgs.findIndex((arg, index) =>
    arg === "claude"
    && commandArgs.slice(0, index).every((prefix) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(prefix)),
  );
  const claudeArgs = claudeIndex >= 0 ? commandArgs.slice(claudeIndex + 1) : [];
  const hasPluginRoot = claudeArgs.some((arg, index) =>
    (arg === "--plugin-dir" && claudeArgs[index + 1] === pluginRoot)
    || arg === `--plugin-dir=${pluginRoot}`,
  );
  if (claudeIndex < 0 || hasPluginRoot) {
    return commandLine;
  }
  const claudeSpan = shellWordSpans(commandLine)[claudeIndex];
  if (!claudeSpan) return commandLine;
  const pluginArgs = commandArrayToLine(["--plugin-dir", pluginRoot]);
  return `${commandLine.slice(0, claudeSpan.end)} ${pluginArgs}${commandLine.slice(claudeSpan.end)}`;
}

export function defaultTrackedCliStartupCommand(provider: CliProvider): string {
  if (provider === "codex") return withCodexNoAltScreen("codex");
  if (provider === "cursor") return "cursor-agent --model auto";
  if (provider === "droid") return "droid";
  if (provider === "opencode") return "opencode";
  if (provider === "pi") return "pi";
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

function workTabCliPreamblePrompt(skillRoots: readonly string[], hasInitialPrompt = false): string {
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
    buildAdeCliInlineGuidance(skillRoots),
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

export function buildTrackedCliStartupCommand(args: {
  provider: CliProvider;
  permissionMode: AgentChatPermissionMode;
  orchestrationRole?: OrchestrationRole | null;
  /** Pre-assigned session ID for Claude CLI (enables reliable resume). */
  sessionId?: string;
  /** Optional runtime model for fresh launches. Continuation commands intentionally ignore it. */
  model?: string | null;
  /** Optional reasoning effort for fresh launches when the runtime supports it. */
  reasoningEffort?: string | null;
  /** Optional fast-mode override for runtimes that expose a fast tier. */
  fastMode?: boolean | null;
  /** Optional user prompt to submit with the fresh launch. */
  initialPrompt?: string | null;
  /** Active lane worktree used to make ADE skill roots lane-aware. */
  laneWorktreePath?: string | null;
  /** Signed standalone Computer Use MCP client selected by ADE's main process. */
  codexComputerUse?: CodexComputerUseCliConfig | null;
}): string {
  return buildTrackedCliLaunchCommand(args).startupCommand;
}

export function buildTrackedCliLaunchCommand(args: {
  provider: CliProvider;
  permissionMode: AgentChatPermissionMode;
  orchestrationRole?: OrchestrationRole | null;
  /** Pre-assigned session ID for Claude CLI (enables reliable resume). */
  sessionId?: string;
  /** Optional runtime model for fresh launches. Continuation commands intentionally ignore it. */
  model?: string | null;
  /** Optional reasoning effort for fresh launches when the runtime supports it. */
  reasoningEffort?: string | null;
  /** Optional fast-mode override for runtimes that expose a fast tier. */
  fastMode?: boolean | null;
  /** Optional user prompt to submit with the fresh launch. */
  initialPrompt?: string | null;
  /** Active lane worktree used to make ADE skill roots lane-aware. */
  laneWorktreePath?: string | null;
  /** Signed standalone Computer Use MCP client selected by ADE's main process. */
  codexComputerUse?: CodexComputerUseCliConfig | null;
}): TrackedCliLaunchCommand {
  const permissionMode = effectiveOrchestrationPermissionMode(args);
  validateLaunchProfilePermissionMode(args.provider, permissionMode);
  const initialPrompt = normalizeInitialPrompt(args.initialPrompt);
  const skillRoots = args.laneWorktreePath
    ? getAgentSkillRootCandidates({ cwd: args.laneWorktreePath })
    : getAdeAgentSkillRootsForPrompt();
  const agentSkillEnv = adeAgentSkillEnv(skillRoots);

  if (args.provider === "claude") {
    const commandArgs: string[] = [];
    // Inject --session-id so we know the Claude session ID upfront for resume.
    if (args.sessionId) {
      commandArgs.push("--session-id", args.sessionId);
    }
    const model = resolveClaudeCliModelForLaunch(args.model);
    if (model) {
      commandArgs.push("--model", model);
    }
    commandArgs.push(...claudeRuntimeEffortFlags(args.reasoningEffort));
    commandArgs.push(...claudeSessionSettingsFlags(args.fastMode, args.reasoningEffort));
    const guidance = buildAdeCliAgentGuidance(skillRoots);
    commandArgs.push("--append-system-prompt", guidance);
    commandArgs.push(...permissionModeToClaudeFlag(permissionMode));
    // Windows keeps the user's prompt off argv. ADE launches the bare word
    // `claude`; the PTY boundary substitutes a real `claude.exe` when it can
    // find one, but any install that only ships a `.cmd` shim still goes
    // through `cmd.exe /d /s /c "…"`, which rewrites the command line before
    // Claude ever sees it. Measured through a real shim: `%USERPROFILE%`
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
      ...(initialPrompt && !promptRidesInArgv
        ? { initialInput: initialPrompt, initialInputDelayMs: 750 }
        : {}),
      ...(agentSkillEnv ? { env: agentSkillEnv } : {}),
    };
  }

  if (args.provider === "codex") {
    const codexModel = resolveCodexCliModelForLaunch(args.model);
    const initialInput = workTabCliPrompt(initialPrompt, skillRoots);
    const commandArgs: string[] = [
      "--no-alt-screen",
      ...modelToCliFlag(codexModel),
      ...codexReasoningEffortFlags(args.reasoningEffort),
      ...codexServiceTierFlags(args.fastMode),
      ...codexComputerUseMcpFlags(args.codexComputerUse),
      ...permissionModeToCodexFlags(permissionMode),
    ];
    // The launcher is the bare command `codex`, which on Windows has no
    // extension and therefore always has to be spawned through
    // `cmd.exe /d /s /c "…"`. cmd rewrites the command line before Codex sees
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
    const cursorModel = resolveCursorCliModelForLaunch(args.model);
    const commandArgs = [
      ...permissionModeToCursorFlags(permissionMode),
      ...modelToCliFlag(cursorModel),
    ];
    const initialInput = initialPrompt ? workTabCliPrompt(initialPrompt, skillRoots) : null;
    return {
      command: "cursor-agent",
      args: commandArgs,
      startupCommand: commandArrayToLine(["cursor-agent", ...commandArgs], { platform: "linux" }),
      ...(initialInput ? { initialInput, initialInputDelayMs: 750 } : {}),
      ...(agentSkillEnv ? { env: agentSkillEnv } : {}),
    };
  }

  if (args.provider === "droid") {
    const prompt = workTabCliPrompt(initialPrompt, skillRoots);
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
        model: args.model,
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
      model: args.model,
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
      buildAdeCliAgentGuidance(skillRoots),
      `ADE permission policy for this Pi session: ${permissionMode}. Pi has no supported native ADE permission flag, so follow this policy and the ADE guidance without bypassing it.`,
    ].join("\n");
    const commandArgs = [
      ...modelToCliFlag(resolvePiCliModelForLaunch(args.model)),
      ...piThinkingFlags(args.reasoningEffort),
      ...piToolFlags(permissionMode),
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

  const opencode = buildOpenCodeCommandParts({
    permissionMode,
    model: args.model,
    reasoningEffort: args.reasoningEffort,
    fastMode: args.fastMode,
    prompt: workTabCliPrompt(initialPrompt, skillRoots),
  });
  const opencodeEnv = withAdeAgentSkillEnv(opencode.env, skillRoots);
  return {
    command: "opencode",
    args: opencode.args,
    startupCommand: opencode.startupCommand,
    ...(opencodeEnv ? { env: opencodeEnv } : {}),
  };
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
  // Pi's built-in tool names are exactly read, bash, edit, and write. Keep
  // the allowlist limited to those names; unknown names make Pi reject the
  // launch instead of merely disabling an optional tool.
  return mode === "full-auto"
    ? ["read", "bash", "edit", "write"]
    : mode === "edit"
      ? ["read", "edit", "write"]
      : ["read"];
}

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
): { tools: string[]; approvalTools: string[]; readOnly: boolean } {
  const mode = permissionMode ?? "default";
  if (mode === "full-auto") return { tools: ["read", "bash", "edit", "write"], approvalTools: [], readOnly: false };
  if (mode === "edit") return { tools: ["read", "edit", "write"], approvalTools: [], readOnly: false };
  // Plan mode is a review posture: reading is enough, and nothing to approve.
  // `readOnly` is stated rather than inferred from the tool list, because
  // callers gate real capabilities on it and adding a future read-only tool
  // must not silently flip them.
  if (mode === "plan") return { tools: ["read"], approvalTools: [], readOnly: true };
  // default, auto, and config-toml all land here. Anything that changes the
  // workspace is offered rather than silently allowed or silently withheld.
  return { tools: ["read", "bash", "edit", "write"], approvalTools: ["bash", "edit", "write"], readOnly: false };
}

export function piToolFlags(permissionMode: AgentChatPermissionMode | null | undefined): string[] {
  // Passing no allowlist lets Pi's own settings decide, which is what the
  // user asked for by picking config-toml.
  if (permissionMode === "config-toml") return [];
  const tools = piToolsForPermissionMode(permissionMode);
  return ["--tools", tools.join(",")];
}

export function piThinkingFlags(reasoningEffort: string | null | undefined): string[] {
  const normalized = normalizeCliFlagValue(reasoningEffort);
  if (!normalized) return [];
  const lower = normalized.toLowerCase();
  const thinking = lower === "ultra" || lower === "ultracode" ? "xhigh" : lower;
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) return [];
  return ["--thinking", thinking];
}

export function codexReasoningEffortFlags(reasoningEffort: string | null | undefined): string[] {
  const effort = normalizeCliFlagValue(reasoningEffort);
  return effort ? ["-c", `model_reasoning_effort="${effort}"`] : [];
}

export function codexServiceTierFlags(fastMode: boolean | null | undefined): string[] {
  if (fastMode === true) {
    return ["-c", "service_tier=\"fast\"", "-c", "features.fast_mode=true"];
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

function claudeRuntimeEffortFlags(reasoningEffort: string | null | undefined): string[] {
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
  skillRoots: readonly string[],
  additionalGuidance?: string,
): string {
  const preamble = workTabCliPreamblePrompt(skillRoots, Boolean(initialPrompt));
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

function permissionModeToCursorFlags(permissionMode: AgentChatPermissionMode | null | undefined): string[] {
  if (permissionMode === "full-auto") return ["--force"];
  if (permissionMode === "plan") return ["--mode", "plan"];
  return [];
}

function droidSettingsJson(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  model?: string | null;
  reasoningEffort?: string | null;
}): string {
  const sessionDefaultSettings = (() => {
    if (args.permissionMode == null) return null;
    if (args.permissionMode === "full-auto") return { interactionMode: "auto", autonomyLevel: "high" };
    if (args.permissionMode === "default") return { interactionMode: "auto", autonomyLevel: "medium" };
    if (args.permissionMode === "edit") return { interactionMode: "auto", autonomyLevel: "low" };
    return { interactionMode: "spec", autonomyLevel: "off" };
  })();
  const model = normalizeDroidCliModel(args.model);
  const reasoningEffort = normalizeCliFlagValue(args.reasoningEffort);
  const settings: Record<string, unknown> = {
    ...(sessionDefaultSettings ? { sessionDefaultSettings } : {}),
  };
  if (model) settings.model = model;
  if (reasoningEffort) settings.reasoningEffort = reasoningEffort;
  if (args.permissionMode === "plan") {
    const specDefaults = sessionDefaultSettings as Record<string, unknown>;
    if (model) specDefaults.specModeModel = model;
    if (reasoningEffort) specDefaults.specModeReasoningEffort = reasoningEffort;
  }
  return JSON.stringify(settings);
}

function quotePowerShellArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function droidPowerShellCommand(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
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

const OPENCODE_INLINE_CONFIG_ENV = "OPENCODE_CONFIG_CONTENT";

function openCodePermissionValue(permissionMode: AgentChatPermissionMode | null | undefined): string | Record<string, string> | null {
  if (permissionMode == null) return null;
  if (permissionMode === "config-toml") return null;
  if (permissionMode === "full-auto") return "allow";
  if (permissionMode === "edit") return { "*": "ask", edit: "allow", question: "allow" };
  if (permissionMode === "plan") return { "*": "ask", edit: "deny", bash: "deny", question: "allow" };
  return { "*": "ask", question: "allow" };
}

function openCodeConfigEnv(permissionMode: AgentChatPermissionMode | null | undefined): string | null {
  const permission = openCodePermissionValue(permissionMode);
  return permission ? JSON.stringify({ permission }) : null;
}

function openCodeEnvAssignment(permissionMode: AgentChatPermissionMode | null | undefined): string {
  const config = openCodeConfigEnv(permissionMode);
  return config ? `${OPENCODE_INLINE_CONFIG_ENV}=${quoteShellArg(config, { platform: "linux" })} ` : "";
}

function permissionModeToOpenCodeArgs(permissionMode: AgentChatPermissionMode | null | undefined): string[] {
  return permissionMode === "plan" ? ["--agent", "plan"] : [];
}

function normalizeOpenCodeCliModel(model: string | null | undefined): string | null {
  const normalized = normalizeCliFlagValue(model);
  if (!normalized) return null;
  const decoded = decodeOpenCodeRegistryId(normalized);
  if (!decoded) return normalized;
  return `${decoded.openCodeProviderId}/${decoded.openCodeModelId}`;
}

function openCodeVariantForLaunch(args: {
  reasoningEffort?: string | null;
  fastMode?: boolean | null;
}): string | null {
  // Fast mode takes priority: when enabled, the "fast" variant supersedes any reasoningEffort variant.
  if (args.fastMode === true) return "fast";
  return normalizeCliFlagValue(args.reasoningEffort);
}

function buildOpenCodeCommandParts(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  model?: string | null;
  reasoningEffort?: string | null;
  fastMode?: boolean | null;
  prompt?: string;
  resumeTarget?: string | null;
  continueLast?: boolean;
}): { args: string[]; startupCommand: string; env?: Record<string, string> } {
  const variant = openCodeVariantForLaunch(args);
  const commandArgs = [
    ...(variant ? ["run", "--interactive"] : []),
    ...permissionModeToOpenCodeArgs(args.permissionMode),
  ];
  commandArgs.push(...modelToCliFlag(normalizeOpenCodeCliModel(args.model)));
  if (variant) commandArgs.push("--variant", variant);
  if (args.resumeTarget) {
    commandArgs.push("--session", args.resumeTarget);
  } else if (args.continueLast) {
    commandArgs.push("--continue");
  }
  if (args.prompt) {
    if (variant) {
      commandArgs.push("--", args.prompt);
    } else {
      commandArgs.push("--prompt", args.prompt);
    }
  }
  const config = openCodeConfigEnv(args.permissionMode);
  return {
    args: commandArgs,
    startupCommand: `${openCodeEnvAssignment(args.permissionMode)}${commandArrayToLine(["opencode", ...commandArgs], { platform: "linux" })}`,
    ...(config ? { env: { [OPENCODE_INLINE_CONFIG_ENV]: config } } : {}),
  };
}

export const OPENCODE_RESUME_REPLAY_LIMIT = 40;

type OpenCodeReplayResumeArgs = {
  permissionMode: AgentChatPermissionMode | null | undefined;
  model?: string | null;
  reasoningEffort?: string | null;
  fastMode?: boolean | null;
  prompt: string;
  resumeTarget?: string | null;
  continueLast?: boolean;
  replayLimit?: number | null;
};

export function buildOpenCodeReplayResumeLaunchCommand(
  args: OpenCodeReplayResumeArgs,
): TrackedCliLaunchCommand {
  const variant = openCodeVariantForLaunch(args);
  const commandArgs = [
    "run",
    "--interactive",
    ...permissionModeToOpenCodeArgs(args.permissionMode),
    ...modelToCliFlag(normalizeOpenCodeCliModel(args.model)),
  ];
  if (variant) commandArgs.push("--variant", variant);
  if (args.resumeTarget) {
    commandArgs.push("--session", args.resumeTarget);
  } else if (args.continueLast) {
    commandArgs.push("--continue");
  }
  commandArgs.push("--replay");
  const replayLimit = Number.isFinite(args.replayLimit)
    ? Math.max(1, Math.floor(Number(args.replayLimit)))
    : OPENCODE_RESUME_REPLAY_LIMIT;
  commandArgs.push("--replay-limit", String(replayLimit), "--", args.prompt);
  const config = openCodeConfigEnv(args.permissionMode);
  return {
    command: "opencode",
    args: commandArgs,
    startupCommand: `${openCodeEnvAssignment(args.permissionMode)}${commandArrayToLine(["opencode", ...commandArgs], { platform: "linux" })}`,
    ...(config ? { env: { [OPENCODE_INLINE_CONFIG_ENV]: config } } : {}),
  };
}

export function buildOpenCodeReplayResumeCommand(args: OpenCodeReplayResumeArgs): string {
  return buildOpenCodeReplayResumeLaunchCommand(args).startupCommand;
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
};

export function buildTrackedCliResumeLaunchCommand(
  metadata: TerminalResumeMetadata,
  overrides: TrackedCliResumeOverrides = {},
  options: { platform?: NodeJS.Platform } = {},
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
  const prompt = normalizeCliFlagValue(overrides.prompt);
  validateLaunchProfilePermissionMode(metadata.provider, permissionMode);

  const targetId = sanitizeTrackedCliResumeTargetId(metadata.targetId) ?? "";
  if (metadata.provider === "claude") {
    const parts = ["claude", ...permissionModeToClaudeFlag(permissionMode)];
    const claudeModel = resolveClaudeCliModelForLaunch(model);
    if (claudeModel) parts.push("--model", claudeModel);
    parts.push(...claudeRuntimeEffortFlags(reasoningEffort));
    parts.push(...claudeSessionSettingsFlags(fastMode, reasoningEffort));
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
    const parts = [
      "codex",
      "--no-alt-screen",
      ...modelToCliFlag(model),
      ...codexReasoningEffortFlags(reasoningEffort),
      ...codexServiceTierFlags(fastMode),
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
    const cursorModel = normalizeCliFlagValue(model)
      ? resolveCursorCliModelForLaunch(model)
      : null;
    const parts = [
      "cursor-agent",
      ...permissionModeToCursorFlags(permissionMode),
      ...modelToCliFlag(cursorModel),
    ];
    if (targetId) {
      parts.push("--resume", targetId);
    } else {
      parts.push("--continue");
    }
    if (prompt) parts.push(prompt);
    return {
      command: parts[0]!,
      args: parts.slice(1),
      startupCommand: commandArrayToLine(parts, { platform: "linux" }),
    };
  }

  if (metadata.provider === "droid") {
    if (permissionMode == null && !normalizeCliFlagValue(model) && !normalizeCliFlagValue(reasoningEffort)) {
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
      model,
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
      ...modelToCliFlag(resolvePiCliModelForLaunch(model)),
      ...piThinkingFlags(reasoningEffort),
      ...piToolFlags(permissionMode),
    ];
    // Pi's supported native continuation target is a session id/file passed to
    // --session. When ADE has not captured a concrete id yet, continue the
    // most recent session instead of silently launching a new one.
    if (metadata.targetKind === "session" && targetId) parts.push("--session", targetId);
    else parts.push("--continue");
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

  const opencode = buildOpenCodeCommandParts({
    permissionMode,
    model,
    reasoningEffort,
    fastMode,
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
  orchestrationRole?: OrchestrationRole | null;
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
  const permissionMode = effectiveOrchestrationPermissionMode(args);
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
    orchestrationRole: args.orchestrationRole,
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

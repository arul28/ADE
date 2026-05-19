import type {
  AgentChatPermissionMode,
  TerminalResumeMetadata,
  TerminalSessionSummary,
  TerminalToolType,
} from "./types";
import { ADE_AGENT_SKILLS_DIRS_ENV, getAdeAgentSkillRootsForPrompt, joinAdeAgentSkillRoots } from "./agentSkillRoots";
import { buildAdeCliAgentGuidance, buildAdeCliInlineGuidance } from "./adeCliGuidance";
import { isProviderSlashCommandInput } from "./chatSlashCommands";
import { commandArrayToLine, quoteShellArg } from "./shell";

export type CliProvider = "claude" | "codex" | "cursor" | "droid" | "opencode";
export type LaunchProfile = CliProvider | "shell";
export type TrackedCliLaunchCommand = {
  command?: string;
  args: string[];
  startupCommand: string;
  env?: Record<string, string>;
};

export type CleanShellLaunchFields = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export const LAUNCH_PROFILES = ["claude", "codex", "cursor", "droid", "opencode", "shell"] as const satisfies readonly LaunchProfile[];
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
  shell: "shell",
};

/** Default human-readable tab title for a launch profile. */
export const LAUNCH_PROFILE_TITLE: Record<LaunchProfile, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor Agent CLI",
  droid: "Factory Droid CLI",
  opencode: "OpenCode CLI",
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
  const stripped = stripAnsiForCliTitle(raw)
    .replace(/\r\n/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped.length) return "";
  return stripped.slice(0, TRACKED_CLI_PROMPT_SEED_MAX_LEN);
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
  shell: ["shell", "run-shell"],
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
  if (mode === "auto" && profile !== "claude") {
    throw new Error("permissionMode auto is only supported for Claude CLI sessions.");
  }
  if (mode === "config-toml" && profile !== "codex") {
    throw new Error("permissionMode config-toml is only supported for Codex CLI sessions.");
  }
}

export function resolveCleanShellLaunchFields(args: {
  platform: string;
  shell?: string | null;
  comSpec?: string | null;
}): CleanShellLaunchFields {
  if (args.platform === "win32") {
    const shell = args.shell?.trim() || "";
    const comSpec = args.comSpec?.trim() || "";
    const powershellPathPattern = /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i;
    let command: string;
    if (powershellPathPattern.test(shell)) {
      command = shell;
    } else if (powershellPathPattern.test(comSpec)) {
      command = comSpec;
    } else {
      command = "powershell.exe";
    }
    return {
      command,
      args: ["-NoLogo", "-NoProfile"],
    };
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

export function defaultTrackedCliStartupCommand(provider: CliProvider): string {
  if (provider === "codex") return withCodexNoAltScreen("codex");
  if (provider === "cursor") return "cursor-agent";
  if (provider === "droid") return "droid";
  if (provider === "opencode") return "opencode";
  return "claude";
}

function workTabCliPreamblePrompt(skillRoots: readonly string[]): string {
  return [
    "ADE session guidance. Treat this as operating guidance for the CLI session, keep it in mind for future user messages, and wait for the user's next instruction before taking action.",
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
  /** Pre-assigned session ID for Claude CLI (enables reliable resume). */
  sessionId?: string;
  /** Optional runtime model for fresh launches. Continuation commands intentionally ignore it. */
  model?: string | null;
  /** Optional reasoning effort for fresh launches when the runtime supports it. */
  reasoningEffort?: string | null;
  /** Optional user prompt to submit with the fresh launch. */
  initialPrompt?: string | null;
  /** Active lane worktree used to make ADE skill roots lane-aware. */
  laneWorktreePath?: string | null;
}): string {
  return buildTrackedCliLaunchCommand(args).startupCommand;
}

export function buildTrackedCliLaunchCommand(args: {
  provider: CliProvider;
  permissionMode: AgentChatPermissionMode;
  /** Pre-assigned session ID for Claude CLI (enables reliable resume). */
  sessionId?: string;
  /** Optional runtime model for fresh launches. Continuation commands intentionally ignore it. */
  model?: string | null;
  /** Optional reasoning effort for fresh launches when the runtime supports it. */
  reasoningEffort?: string | null;
  /** Optional user prompt to submit with the fresh launch. */
  initialPrompt?: string | null;
  /** Active lane worktree used to make ADE skill roots lane-aware. */
  laneWorktreePath?: string | null;
}): TrackedCliLaunchCommand {
  validateLaunchProfilePermissionMode(args.provider, args.permissionMode);
  const initialPrompt = normalizeInitialPrompt(args.initialPrompt);
  const skillRoots = getAdeAgentSkillRootsForPrompt({ cwd: args.laneWorktreePath ?? undefined });
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
    const reasoningEffort = normalizeCliFlagValue(args.reasoningEffort);
    if (reasoningEffort) {
      commandArgs.push("--effort", reasoningEffort);
    }
    commandArgs.push("--append-system-prompt", buildAdeCliAgentGuidance(skillRoots));
    commandArgs.push(...permissionModeToClaudeFlag(args.permissionMode));
    if (initialPrompt) {
      commandArgs.push(initialPrompt);
    }
    return {
      command: "claude",
      args: commandArgs,
      startupCommand: commandArrayToLine(["claude", ...commandArgs]),
      ...(agentSkillEnv ? { env: agentSkillEnv } : {}),
    };
  }

  if (args.provider === "codex") {
    const commandArgs: string[] = [
      "--no-alt-screen",
      ...modelToCliFlag(resolveCodexCliModelForLaunch(args.model)),
      ...codexReasoningEffortFlags(args.reasoningEffort),
      ...permissionModeToCodexFlags(args.permissionMode),
      workTabCliPrompt(initialPrompt, skillRoots),
    ];
    return {
      command: "codex",
      args: commandArgs,
      startupCommand: commandArrayToLine(["codex", ...commandArgs]),
      ...(agentSkillEnv ? { env: agentSkillEnv } : {}),
    };
  }

  if (args.provider === "cursor") {
    const prompt = workTabCliPrompt(initialPrompt, skillRoots);
    const commandArgs = [...permissionModeToCursorFlags(args.permissionMode), ...modelToCliFlag(args.model), prompt];
    const startupCommand = buildCursorPrecreatedChatCommand({
      permissionMode: args.permissionMode,
      model: args.model,
      prompt,
    });
    return {
      args: commandArgs,
      startupCommand,
      ...(agentSkillEnv ? { env: agentSkillEnv } : {}),
    };
  }

  if (args.provider === "droid") {
    const prompt = workTabCliPrompt(initialPrompt, skillRoots);
    return {
      command: "droid",
      args: ["exec", ...modelToCliFlag(args.model), ...droidReasoningEffortFlags(args.reasoningEffort), ...permissionModeToDroidExecFlags(args.permissionMode), prompt],
      startupCommand: buildDroidExecCommandLine({
        permissionMode: args.permissionMode,
        model: args.model,
        reasoningEffort: args.reasoningEffort,
        prompt,
      }),
      ...(agentSkillEnv ? { env: agentSkillEnv } : {}),
    };
  }

  const opencode = buildOpenCodeCommandParts({
    permissionMode: args.permissionMode,
    model: args.model,
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

export function resolveCodexCliModelForLaunch(model: string | null | undefined): string | null {
  const raw = String(model ?? "").trim();
  if (!raw) return null;
  const slash = raw.indexOf("/");
  if (slash > 0 && raw.slice(0, slash).toLowerCase() === "openai") {
    return raw.slice(slash + 1).trim() || null;
  }
  return raw;
}

export function codexReasoningEffortFlags(reasoningEffort: string | null | undefined): string[] {
  const effort = normalizeCliFlagValue(reasoningEffort);
  return effort ? ["-c", `model_reasoning_effort="${effort}"`] : [];
}

function droidReasoningEffortFlags(reasoningEffort: string | null | undefined): string[] {
  const effort = normalizeCliFlagValue(reasoningEffort);
  return effort ? ["--reasoning-effort", effort] : [];
}

function workTabCliPrompt(initialPrompt: string | null, skillRoots: readonly string[]): string {
  const preamble = workTabCliPreamblePrompt(skillRoots);
  if (!initialPrompt) return preamble;
  return [
    preamble,
    "",
    "User prompt:",
    initialPrompt,
  ].join("\n");
}

export function resolveClaudeCliModelForLaunch(model: string | null | undefined): string | null {
  const raw = String(model ?? "").trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  const known: Record<string, string> = {
    opus: "opus",
    "opus-4-7": "opus",
    "claude-opus-4-7": "opus",
    "anthropic/claude-opus-4-7": "opus",
    "anthropic/claude-opus-4-7-api": "opus",
    "opus[1m]": "opus[1m]",
    "opus-1m": "opus[1m]",
    "opus-4-7-1m": "opus[1m]",
    "claude-opus-4-7[1m]": "opus[1m]",
    "claude-opus-4-7-1m": "opus[1m]",
    "anthropic/claude-opus-4-7-1m": "opus[1m]",
    sonnet: "sonnet",
    "sonnet-4-6": "sonnet",
    "sonnet-4-5": "sonnet",
    "claude-sonnet-4-6": "sonnet",
    "claude-sonnet-4-5": "sonnet",
    "claude-sonnet-4-5-20241022": "sonnet",
    "anthropic/claude-sonnet-4-6": "sonnet",
    "anthropic/claude-sonnet-4-6-api": "sonnet",
    haiku: "haiku",
    "haiku-4-5": "haiku",
    "claude-haiku-4-5": "haiku",
    "claude-haiku-4-5-20251001": "haiku",
    "anthropic/claude-haiku-4-5": "haiku",
    "anthropic/claude-haiku-4-5-api": "haiku",
  };
  const mapped = known[normalized];
  if (mapped) return mapped;
  const hasOpus1mToken = normalized.includes("[1m]") || /(^|[^0-9])1m($|[^0-9])/.test(normalized);
  if (normalized.includes("opus") && hasOpus1mToken) return "opus[1m]";
  if (normalized.includes("sonnet")) return "sonnet";
  if (normalized.includes("opus")) return "opus";
  if (normalized.includes("haiku")) return "haiku";
  return raw;
}

function permissionModeToClaudeFlag(permissionMode: AgentChatPermissionMode | null | undefined): string[] {
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

function permissionModeToCursorFlags(permissionMode: AgentChatPermissionMode | null | undefined): string[] {
  if (permissionMode === "full-auto") return ["--force"];
  if (permissionMode === "plan") return ["--mode", "plan"];
  if (permissionMode === "edit") return ["--mode", "ask"];
  return [];
}

function permissionModeToDroidExecFlags(permissionMode: AgentChatPermissionMode | null | undefined): string[] {
  if (permissionMode === "full-auto") return ["--auto", "high"];
  if (permissionMode === "default") return ["--auto", "medium"];
  if (permissionMode === "edit") return ["--auto", "low"];
  return [];
}

function droidSettingsJson(permissionMode: AgentChatPermissionMode | null | undefined): string {
  const sessionDefaultSettings = (() => {
    if (permissionMode === "full-auto") return { interactionMode: "auto", autonomyLevel: "high" };
    if (permissionMode === "default") return { interactionMode: "auto", autonomyLevel: "medium" };
    if (permissionMode === "edit") return { interactionMode: "auto", autonomyLevel: "low" };
    return { interactionMode: "spec", autonomyLevel: "off" };
  })();
  return JSON.stringify({ sessionDefaultSettings });
}

function buildDroidCommandLine(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  prompt?: string;
  resumeTarget?: string | null;
}): string {
  const settingsJson = droidSettingsJson(args.permissionMode);
  const droidArgs = ["droid", "--settings", "$ADE_DROID_SETTINGS"];
  if (args.resumeTarget !== undefined) {
    droidArgs.push("--resume");
    if (args.resumeTarget) droidArgs.push(args.resumeTarget);
  }
  if (args.prompt) droidArgs.push(args.prompt);
  const droidCommand = commandArrayToLine(droidArgs)
    .replace(quoteShellArg("$ADE_DROID_SETTINGS"), "\"$ADE_DROID_SETTINGS\"");
  return [
    "ADE_DROID_SETTINGS=\"$(mktemp \"${TMPDIR:-/tmp}/ade-droid-settings.XXXXXX.json\")\"",
    `printf %s ${quoteShellArg(settingsJson)} > "$ADE_DROID_SETTINGS"`,
    `${droidCommand}; ADE_DROID_STATUS=$?; rm -f "$ADE_DROID_SETTINGS"; exit $ADE_DROID_STATUS`,
  ].join(" && ");
}

function buildDroidExecCommandLine(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  model?: string | null;
  reasoningEffort?: string | null;
  prompt: string;
}): string {
  return commandArrayToLine([
    "droid",
    "exec",
    ...modelToCliFlag(args.model),
    ...droidReasoningEffortFlags(args.reasoningEffort),
    ...permissionModeToDroidExecFlags(args.permissionMode),
    args.prompt,
  ]);
}

function buildCursorPrecreatedChatCommand(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  model?: string | null;
  prompt: string;
}): string {
  const commandArgs = [
    "cursor-agent",
    ...permissionModeToCursorFlags(args.permissionMode),
    ...modelToCliFlag(args.model),
    "--resume",
    "$ADE_CURSOR_CHAT_ID",
    args.prompt,
  ];
  const command = commandArrayToLine(commandArgs)
    .replace(quoteShellArg("$ADE_CURSOR_CHAT_ID"), "\"$ADE_CURSOR_CHAT_ID\"");
  return [
    "ADE_CURSOR_CHAT_ID=\"$(cursor-agent create-chat)\"",
    "[ -n \"$ADE_CURSOR_CHAT_ID\" ] || { echo \"[ADE] cursor-agent create-chat returned no chat id\" >&2; exit 1; }",
    "printf %s\\\\n \"[ADE] Continue with cursor-agent --resume ${ADE_CURSOR_CHAT_ID}\"",
    command,
  ].join(" && ");
}

const OPENCODE_INLINE_CONFIG_ENV = "OPENCODE_CONFIG_CONTENT";

function openCodePermissionValue(permissionMode: AgentChatPermissionMode | null | undefined): string | Record<string, string> | null {
  if (permissionMode === "config-toml") return null;
  if (permissionMode === "full-auto") return "allow";
  if (permissionMode === "edit") return { "*": "ask", edit: "allow" };
  if (permissionMode === "plan") return { "*": "ask", edit: "deny", bash: "deny" };
  return { "*": "ask" };
}

function openCodeConfigEnv(permissionMode: AgentChatPermissionMode | null | undefined): string | null {
  const permission = openCodePermissionValue(permissionMode);
  return permission ? JSON.stringify({ permission }) : null;
}

function openCodeEnvAssignment(permissionMode: AgentChatPermissionMode | null | undefined): string {
  const config = openCodeConfigEnv(permissionMode);
  return config ? `${OPENCODE_INLINE_CONFIG_ENV}=${quoteShellArg(config)} ` : "";
}

function permissionModeToOpenCodeArgs(permissionMode: AgentChatPermissionMode | null | undefined): string[] {
  return permissionMode === "plan" ? ["--agent", "plan"] : [];
}

function buildOpenCodeCommandParts(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  model?: string | null;
  prompt?: string;
  resumeTarget?: string | null;
  continueLast?: boolean;
}): { args: string[]; startupCommand: string; env?: Record<string, string> } {
  const commandArgs = [...permissionModeToOpenCodeArgs(args.permissionMode)];
  commandArgs.push(...modelToCliFlag(args.model));
  if (args.resumeTarget) {
    commandArgs.push("--session", args.resumeTarget);
  } else if (args.continueLast) {
    commandArgs.push("--continue");
  }
  if (args.prompt) commandArgs.push("--prompt", args.prompt);
  const config = openCodeConfigEnv(args.permissionMode);
  return {
    args: commandArgs,
    startupCommand: `${openCodeEnvAssignment(args.permissionMode)}${commandArrayToLine(["opencode", ...commandArgs])}`,
    ...(config ? { env: { [OPENCODE_INLINE_CONFIG_ENV]: config } } : {}),
  };
}

export function buildTrackedCliResumeCommand(
  metadata: TerminalResumeMetadata,
  overrides: { model?: string | null; reasoningEffort?: string | null; permissionMode?: AgentChatPermissionMode | null } = {},
): string {
  const permissionMode = overrides.permissionMode ?? metadata.launch.permissionMode;
  validateLaunchProfilePermissionMode(metadata.provider, permissionMode);

  const targetId = sanitizeTrackedCliResumeTargetId(metadata.targetId) ?? "";
  if (metadata.provider === "claude") {
    const parts = ["claude", ...permissionModeToClaudeFlag(permissionMode)];
    const model = resolveClaudeCliModelForLaunch(overrides.model);
    if (model) parts.push("--model", model);
    const reasoningEffort = normalizeCliFlagValue(overrides.reasoningEffort);
    if (reasoningEffort) parts.push("--effort", reasoningEffort);
    parts.push("--resume");
    if (targetId) parts.push(targetId);
    return commandArrayToLine(parts);
  }

  if (metadata.provider === "codex") {
    const parts = [
      "codex",
      "--no-alt-screen",
      ...modelToCliFlag(overrides.model),
      ...codexReasoningEffortFlags(overrides.reasoningEffort),
      ...permissionModeToCodexFlags(permissionMode),
    ];
    parts.push("resume");
    if (targetId) parts.push(targetId);
    return commandArrayToLine(parts);
  }

  if (metadata.provider === "cursor") {
    const parts = [
      "cursor-agent",
      ...permissionModeToCursorFlags(permissionMode),
      ...modelToCliFlag(overrides.model),
    ];
    if (targetId) {
      parts.push("--resume", targetId);
    } else {
      parts.push("--continue");
    }
    return commandArrayToLine(parts);
  }

  if (metadata.provider === "droid") {
    return buildDroidCommandLine({
      permissionMode,
      resumeTarget: targetId || null,
    });
  }

  const opencode = buildOpenCodeCommandParts({
    permissionMode,
    model: overrides.model,
    resumeTarget: targetId || null,
    continueLast: !targetId,
  });
  return opencode.startupCommand;
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
}): { startupCommand?: string; command?: string; args?: string[]; env?: Record<string, string> } {
  validateLaunchProfilePermissionMode(args.profile, args.permissionMode);

  const callerHasOverride =
    args.startupCommand !== undefined
    || args.command !== undefined
    || args.args !== undefined
    || args.env !== undefined;

  if (callerHasOverride) {
    return {
      ...(args.startupCommand !== undefined ? { startupCommand: args.startupCommand } : {}),
      ...(args.command !== undefined ? { command: args.command } : {}),
      ...(args.args !== undefined ? { args: args.args } : {}),
      ...(args.env !== undefined ? { env: args.env } : {}),
    };
  }

  if (args.profile === "shell") return {};

  const defaultLaunch = buildTrackedCliLaunchCommand({
    provider: args.profile,
    permissionMode: args.permissionMode ?? "default",
  });
  return {
    startupCommand: defaultLaunch.startupCommand,
    ...(defaultLaunch.command !== undefined ? { command: defaultLaunch.command } : {}),
    args: defaultLaunch.args,
    ...(defaultLaunch.env ? { env: defaultLaunch.env } : {}),
  };
}

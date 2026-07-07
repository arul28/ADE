import type {
  AgentChatPermissionMode,
  TerminalResumeMetadata,
  TerminalSessionSummary,
  TerminalToolType,
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
import { decodeOpenCodeRegistryId } from "./modelRegistry";
import { effectiveOrchestrationPermissionMode } from "./orchestrationRuntimePolicy";
import { commandArrayToLine, quoteShellArg } from "./shell";
import type { OrchestrationRole } from "./types/orchestration";

export type CliProvider = "claude" | "codex" | "cursor" | "droid" | "opencode";
export type LaunchProfile = CliProvider | "shell";
export type TrackedCliLaunchCommand = {
  command?: string;
  args: string[];
  startupCommand: string;
  initialInput?: string;
  initialInputDelayMs?: number;
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
  if (provider === "cursor") return "cursor-agent --model auto";
  if (provider === "droid") return "droid";
  if (provider === "opencode") return "opencode";
  return "claude";
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
    if (initialPrompt) {
      commandArgs.push(initialPrompt);
    }
    // Build a shorter startupCommand for the shell-fallback path that excludes
    // the huge --append-system-prompt blob. The direct-spawn path uses the full
    // args array. Claude still discovers ADE skills via ADE_AGENT_SKILLS_DIRS.
    const shellArgs = commandArgs.filter(
      (arg, i, arr) => arg !== "--append-system-prompt" && arr[i - 1] !== "--append-system-prompt",
    );
    return {
      command: "claude",
      args: commandArgs,
      startupCommand: commandArrayToLine(["claude", ...shellArgs]),
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
      ...permissionModeToCodexFlags(permissionMode),
    ];
    const usePromptArg = codexModel === "gpt-5.3-codex";
    if (usePromptArg) commandArgs.push(initialInput);
    return {
      command: "codex",
      args: commandArgs,
      startupCommand: commandArrayToLine(["codex", ...commandArgs]),
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
      startupCommand: commandArrayToLine(["cursor-agent", ...commandArgs]),
      ...(initialInput ? { initialInput, initialInputDelayMs: 750 } : {}),
      ...(agentSkillEnv ? { env: agentSkillEnv } : {}),
    };
  }

  if (args.provider === "droid") {
    const prompt = workTabCliPrompt(initialPrompt, skillRoots);
    const platform = typeof process !== "undefined" && typeof process.platform === "string" ? process.platform : "";
    if (platform === "win32") {
      const startupCommand = droidPowerShellCommand({
        permissionMode,
        model: args.model,
        reasoningEffort: args.reasoningEffort,
        prompt,
      });
      return {
        command: "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", startupCommand],
        startupCommand,
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

function workTabCliPrompt(initialPrompt: string | null, skillRoots: readonly string[]): string {
  const preamble = workTabCliPreamblePrompt(skillRoots, Boolean(initialPrompt));
  if (!initialPrompt) return preamble;
  return [
    preamble,
    "",
    "User prompt:",
    initialPrompt,
  ].join("\n");
}

export function resolveClaudeCliModelForLaunch(model: string | null | undefined): string | null {
  return resolveClaudeCliModelAlias(model, null);
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
  return [];
}

function droidSettingsJson(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  model?: string | null;
  reasoningEffort?: string | null;
}): string {
  const sessionDefaultSettings = (() => {
    if (args.permissionMode === "full-auto") return { interactionMode: "auto", autonomyLevel: "high" };
    if (args.permissionMode === "default") return { interactionMode: "auto", autonomyLevel: "medium" };
    if (args.permissionMode === "edit") return { interactionMode: "auto", autonomyLevel: "low" };
    return { interactionMode: "spec", autonomyLevel: "off" };
  })();
  const model = normalizeDroidCliModel(args.model);
  const reasoningEffort = normalizeCliFlagValue(args.reasoningEffort);
  const settings: Record<string, unknown> = { sessionDefaultSettings };
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
    `Set-Content -LiteralPath $env:ADE_DROID_SETTINGS -NoNewline -Value ${quotePowerShellArg(settingsJson)}`,
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
  const droidCommand = commandArrayToLine(droidArgs)
    .replace(quoteShellArg("$ADE_DROID_SETTINGS"), "\"$ADE_DROID_SETTINGS\"");
  return [
    "ADE_DROID_SETTINGS=\"$(mktemp \"${TMPDIR:-/tmp}/ade-droid-settings.XXXXXX.json\")\"",
    `printf %s ${quoteShellArg(settingsJson)} > "$ADE_DROID_SETTINGS"`,
    `${droidCommand}; ADE_DROID_STATUS=$?; rm -f "$ADE_DROID_SETTINGS"; exit $ADE_DROID_STATUS`,
  ].join(" && ");
}

const OPENCODE_INLINE_CONFIG_ENV = "OPENCODE_CONFIG_CONTENT";

function openCodePermissionValue(permissionMode: AgentChatPermissionMode | null | undefined): string | Record<string, string> | null {
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
  return config ? `${OPENCODE_INLINE_CONFIG_ENV}=${quoteShellArg(config)} ` : "";
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
    startupCommand: `${openCodeEnvAssignment(args.permissionMode)}${commandArrayToLine(["opencode", ...commandArgs])}`,
    ...(config ? { env: { [OPENCODE_INLINE_CONFIG_ENV]: config } } : {}),
  };
}

export const OPENCODE_RESUME_REPLAY_LIMIT = 40;

export function buildOpenCodeReplayResumeCommand(args: {
  permissionMode: AgentChatPermissionMode | null | undefined;
  model?: string | null;
  reasoningEffort?: string | null;
  fastMode?: boolean | null;
  prompt: string;
  resumeTarget?: string | null;
  continueLast?: boolean;
  replayLimit?: number | null;
}): string {
  const variant = openCodeVariantForLaunch(args);
  const commandArgs = [
    "opencode",
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
  return `${openCodeEnvAssignment(args.permissionMode)}${commandArrayToLine(commandArgs)}`;
}

export function buildTrackedCliResumeCommand(
  metadata: TerminalResumeMetadata,
  overrides: {
    model?: string | null;
    reasoningEffort?: string | null;
    fastMode?: boolean | null;
    permissionMode?: AgentChatPermissionMode | null;
    prompt?: string | null;
  } = {},
): string {
  const permissionMode = overrides.permissionMode ?? metadata.launch.permissionMode;
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
    return commandArrayToLine(parts);
  }

  if (metadata.provider === "codex") {
    const parts = [
      "codex",
      "--no-alt-screen",
      ...modelToCliFlag(model),
      ...codexReasoningEffortFlags(reasoningEffort),
      ...codexServiceTierFlags(fastMode),
      ...permissionModeToCodexFlags(permissionMode),
    ];
    parts.push("resume");
    if (targetId) parts.push(targetId);
    if (prompt) parts.push(prompt);
    return commandArrayToLine(parts);
  }

  if (metadata.provider === "cursor") {
    const cursorModel = overrides.model !== undefined
      ? resolveCursorCliModelForLaunch(overrides.model)
      : resolveCursorCliModelForLaunch(metadata.launch.model);
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
    return commandArrayToLine(parts);
  }

  if (metadata.provider === "droid") {
    return buildDroidCommandLine({
      permissionMode,
      model,
      reasoningEffort,
      ...(prompt ? { prompt } : {}),
      resumeTarget: targetId || null,
    });
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

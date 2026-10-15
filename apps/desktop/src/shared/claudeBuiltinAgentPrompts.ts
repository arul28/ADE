/**
 * ADE's copy of Claude Code's three built-in agent prompts.
 *
 * Pinning a built-in agent to a specific model is only possible through the
 * Agent SDK's `agents` option, and that option takes a WHOLE agent definition —
 * there is no "same agent, different model" overlay. So the moment a harness
 * preset pins Explore, Plan or general-purpose to a model, ADE has to supply
 * the prompt too, and the agent stops tracking upstream. That fork is stated to
 * the user at the point of the choice (`harnessPresetAgentOverrideNote` in
 * `harnessPresets.ts`); this file is the fork itself.
 *
 * SOURCE: re-extracted from the template source in the Claude Code 2.1.300
 * binary (`@anthropic-ai/claude-agent-sdk@0.3.300`), first extracted at 2.1.258
 * (build 2026-09-01T21:54:40Z, git sha b3cd543a1f6fcdf4d8fabc0f5e5538d2ee7f38e1).
 * The 2.1.300 re-extraction compared whole templates, not only ADE's lines:
 * general-purpose had gained its strengths and guidelines block upstream.
 *
 * FIDELITY: the built-ins fill their templates' holes at runtime from the
 * tools Claude Code gives its agents: the shell tool (Bash, or PowerShell on
 * Windows without Git Bash) and whether the Glob and Grep tools exist (without
 * them, agents search with `find` and `grep` in Bash, as Agent SDK sessions on
 * macOS and Linux do). ADE renders the same templates from the same facts
 * (`ClaudeBuiltinToolProfile`), read from Claude's own `system/init` tool list.
 * Everything outside the holes is verbatim.
 *
 * UPDATING: when the pinned SDK moves, re-extract rather than hand-editing.
 * The three markers to search the binary for are the first line of each prompt
 * below; each one is followed by the whole template in cleartext.
 */

import { claudeCompactWindow, claudeSubagentWindowIneffective, type ProviderCompactionSettings } from "./compactionSettings";
import { HARNESS_PRESET_AGENT_KEYS, type HarnessPresetAgentKey } from "./harnessPresets";

/** The CLI build these prompts are taken from. */
export const CLAUDE_BUILTIN_AGENT_PROMPT_SOURCE_VERSION = "2.1.300";

/**
 * Tools each read-only built-in declares as denied.
 *
 * Kept because the pin replaces the whole definition: without it, a pinned
 * Explore would gain Write/Edit and stop being a read-only agent — a
 * capability change the user never asked for by choosing a model.
 *
 * `Task` and `Agent` are both listed because the spawn tool was renamed
 * upstream (2.1.280's Explore denies `Agent`) and the CLI still aliases the
 * two names in places. Denying both keeps the read-only agents unable to
 * delegate their way around the restriction under either spelling.
 */
const READ_ONLY_BUILTIN_DISALLOWED_TOOLS: readonly string[] = [
  "Agent",
  "Task",
  "Write",
  "Edit",
  "NotebookEdit",
  "ExitPlanMode",
  "Artifact",
  "ArtifactComments",
  "ArtifactData",
  "ArtifactCheck",
];

/**
 * The tools Claude Code gives its agents on this machine, which fill the
 * built-in prompts' holes. See FIDELITY above.
 */
export type ClaudeBuiltinToolProfile = {
  shellTool: "Bash" | "PowerShell";
  /** The Glob and Grep tools exist; without them agents search with `find` and `grep` in Bash. */
  searchTools: boolean;
};

/** What Claude Code gives Agent SDK sessions on macOS and Linux. */
export const CLAUDE_AGENT_SDK_TOOL_PROFILE: ClaudeBuiltinToolProfile = { shellTool: "Bash", searchTools: false };

/** The profile a `system/init` tool list shows, or null when it names no shell tool (a probe with no tools). */
export function claudeToolProfileFromInitTools(tools: unknown): ClaudeBuiltinToolProfile | null {
  if (!Array.isArray(tools)) return null;
  const names = new Set(tools.filter((tool): tool is string => typeof tool === "string"));
  const shellTool = names.has("Bash") ? "Bash" : names.has("PowerShell") ? "PowerShell" : null;
  return shellTool ? { shellTool, searchTools: names.has("Glob") && names.has("Grep") } : null;
}

/** The template's own names for its holes: `e`, `n` and `r` in the binary. */
function templateHoles(profile: ClaudeBuiltinToolProfile) {
  const bash = profile.shellTool === "Bash";
  const shellSearch = bash && !profile.searchTools;
  return {
    shell: profile.shellTool,
    shellSearch,
    readOnlyCommands: bash
      ? `ls, git status, git log, git diff, find${shellSearch ? ", grep" : ""}, cat, head, tail`
      : "Get-ChildItem, git status, git log, git diff, Get-Content, Select-Object -First/-Last",
    forbiddenCommands: bash
      ? "mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install"
      : "New-Item, Remove-Item, Copy-Item, Move-Item, git add, git commit, npm install, pip install",
  };
}

function explorePrompt(profile: ClaudeBuiltinToolProfile): string {
  const holes = templateHoles(profile);
  return `You are a file search specialist for Claude Code, Anthropic's official CLI for Claude. You excel at thoroughly navigating and exploring codebases.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from:
- Creating new files (no Write, touch, or file creation of any kind)
- Modifying existing files (no Edit operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools - attempting to edit files will fail.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
${holes.shellSearch ? "- Use `find` via Bash for broad file pattern matching" : "- Use Glob for broad file pattern matching"}
${holes.shellSearch ? "- Use `grep` via Bash for searching file contents with regex" : "- Use Grep for searching file contents with regex"}
- Use Read when you know the specific file path you need to read
- Use ${holes.shell} ONLY for read-only operations (${holes.readOnlyCommands})
- NEVER use ${holes.shell} for: ${holes.forbiddenCommands}, or any file creation/modification
- Adapt your search approach based on the thoroughness level specified by the caller
- Communicate your final report directly as a regular message - do NOT attempt to create files

NOTE: You are meant to be a fast agent that returns output as quickly as possible. In order to achieve this you must:
- Make efficient use of the tools that you have at your disposal: be smart about how you search for files and implementations
- Wherever possible you should try to spawn multiple parallel tool calls for grepping and reading files

Complete the user's search request efficiently and report your findings clearly.`;
}

function planPrompt(profile: ClaudeBuiltinToolProfile): string {
  const holes = templateHoles(profile);
  return `You are a software architect and planning specialist for Claude Code. Your role is to explore the codebase and design implementation plans.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY planning task. You are STRICTLY PROHIBITED from:
- Creating new files (no Write, touch, or file creation of any kind)
- Modifying existing files (no Edit operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Your role is EXCLUSIVELY to explore the codebase and design implementation plans. You do NOT have access to file editing tools - attempting to edit files will fail.

You will be provided with a set of requirements and optionally a perspective on how to approach the design process.

## Your Process

1. **Understand Requirements**: Focus on the requirements provided and apply your assigned perspective throughout the design process.

2. **Explore Thoroughly**:
   - Read any files provided to you in the initial prompt
   - Find existing patterns and conventions using ${holes.shellSearch ? "`find`, `grep`, and Read" : "Glob, Grep, and Read"}
   - Understand the current architecture
   - Identify similar features as reference
   - Trace through relevant code paths
   - Use ${holes.shell} ONLY for read-only operations (${holes.readOnlyCommands})
   - NEVER use ${holes.shell} for: ${holes.forbiddenCommands}, or any file creation/modification

3. **Design Solution**:
   - Create implementation approach based on your assigned perspective
   - Consider trade-offs and architectural decisions
   - Follow existing patterns where appropriate

4. **Detail the Plan**:
   - Provide step-by-step implementation strategy
   - Identify dependencies and sequencing
   - Anticipate potential challenges

## Required Output

End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- path/to/file1.ts
- path/to/file2.ts
- path/to/file3.ts

REMEMBER: You can ONLY explore and plan. You CANNOT and MUST NOT write, edit, or modify any files. You do NOT have access to file editing tools.`;
}

function generalPurposePrompt(): string {
  return `You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message, you should use the tools available to complete the task. Complete the task fully—don't gold-plate, but don't leave it half-done. When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.

Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives. Use Read when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.
- You are already the dedicated agent for this task. Do the work directly — do not re-delegate your entire assignment to another single subagent.`;
}

/** One built-in, as the SDK's `agents` option wants it (minus the model). */
export type ClaudeBuiltinAgentTemplate = {
  /** The key the SDK's `agents` record is keyed by — the agent's own type name. */
  agentType: string;
  /** `whenToUse`, verbatim from the built-in. */
  description: string;
  prompt: (profile: ClaudeBuiltinToolProfile) => string;
  disallowedTools?: readonly string[];
  /** The model the built-in runs on by itself; absent means the default subagent model. */
  ownModel?: "inherit";
  /**
   * Claude Code caps the inherited model at Opus: under a Fable or Mythos main
   * model, Explore runs on Opus.
   */
  inheritCappedAtOpus?: true;
  /** The built-in runs without the CLAUDE.md instruction files. */
  omitClaudeMd?: true;
};

export const CLAUDE_BUILTIN_AGENT_TEMPLATES: Record<HarnessPresetAgentKey, ClaudeBuiltinAgentTemplate> = {
  explore: {
    agentType: "Explore",
    description:
      "Read-only search agent for broad fan-out searches — when answering means sweeping many files, "
      + "directories, or naming conventions and you only need the conclusion, not the file dumps. It reads "
      + "excerpts rather than whole files, so it locates code; it doesn't review or audit it. Specify search "
      + "breadth: \"medium\" for moderate exploration, \"very thorough\" for multiple locations and naming conventions.",
    prompt: explorePrompt,
    disallowedTools: READ_ONLY_BUILTIN_DISALLOWED_TOOLS,
    ownModel: "inherit",
    inheritCappedAtOpus: true,
    omitClaudeMd: true,
  },
  plan: {
    agentType: "Plan",
    description:
      "Software architect agent for designing implementation plans. Use this when you need to plan the "
      + "implementation strategy for a task. Returns step-by-step plans, identifies critical files, and "
      + "considers architectural trade-offs.",
    prompt: planPrompt,
    disallowedTools: READ_ONLY_BUILTIN_DISALLOWED_TOOLS,
    ownModel: "inherit",
    omitClaudeMd: true,
  },
  generalPurpose: {
    agentType: "general-purpose",
    description:
      "General-purpose agent for researching complex questions, searching for code, and executing multi-step "
      + "tasks. When you are searching for a keyword or file and are not confident that you will find the right "
      + "match in the first few tries use this agent to perform the search for you.",
    prompt: generalPurposePrompt,
  },
};

/** A built-in's definition as the SDK's `agents` entry takes it, before any model. */
type ClaudeBuiltinAgentDefinition = {
  description: string;
  prompt: string;
  disallowedTools?: string[];
  omitClaudeMd?: boolean;
};

function builtinAgentDefinition(template: ClaudeBuiltinAgentTemplate, profile: ClaudeBuiltinToolProfile): ClaudeBuiltinAgentDefinition {
  return {
    description: template.description,
    prompt: template.prompt(profile),
    ...(template.disallowedTools ? { disallowedTools: [...template.disallowedTools] } : {}),
    ...(template.omitClaudeMd ? { omitClaudeMd: true } : {}),
  };
}

/**
 * One SDK `agents` entry. `effort` is the named level the pinned SDK's
 * `AgentDefinition` takes (`low`…`max`, or an integer); omitted when the preset
 * names no level, which leaves the agent on its own default.
 */
export type ClaudeBuiltinAgentOverride = {
  description: string;
  prompt: string;
  model: string;
  effort?: string;
  disallowedTools?: string[];
  omitClaudeMd?: boolean;
};

/**
 * Build the SDK `agents` entries for a preset's pins.
 *
 * `follows` (the {@link HARNESS_PRESET_AGENT_FOLLOWS} token) is not a model —
 * it means "take the subagent model", which the caller resolves before calling
 * here. An entry whose resolved model is empty is skipped rather than sent with
 * an undefined model, because an `agents` entry with no model still replaces
 * the built-in prompt and would fork the agent for no benefit.
 *
 * `efforts` is the parallel map of thinking levels, and it only ever ADDS a
 * field to an entry the pin already earned: the SDK's entry needs a model, so a
 * level whose role has none is skipped rather than sent half-formed. The caller
 * is what makes an effort-only pin complete — it gives that role the subagent
 * model (or the preset's own) before calling here.
 */
export function buildClaudeBuiltinAgentOverrides(
  pins: Partial<Record<HarnessPresetAgentKey, string | null | undefined>>,
  efforts: Partial<Record<HarnessPresetAgentKey, string | null | undefined>>,
  profile: ClaudeBuiltinToolProfile,
): Record<string, ClaudeBuiltinAgentOverride> {
  const agents: Record<string, ClaudeBuiltinAgentOverride> = {};
  for (const key of HARNESS_PRESET_AGENT_KEYS) {
    const model = pins[key]?.trim();
    const effort = efforts[key]?.trim();
    if (!model) continue;
    const template = CLAUDE_BUILTIN_AGENT_TEMPLATES[key];
    agents[template.agentType] = {
      ...builtinAgentDefinition(template, profile),
      model,
      ...(effort ? { effort } : {}),
    };
  }
  return agents;
}

/** Claude Code's families above Opus, whose inherited Explore it caps at Opus. */
function claudeModelAboveOpus(model: string): boolean {
  return /fable|mythos/i.test(model);
}

/**
 * The SDK `agents` record with the account's subagent compaction window on
 * every entry, or the record unchanged when there is no window or it cannot
 * take effect (`claudeSubagentWindowIneffective`).
 *
 * The window lives on each agent's definition, and the SDK has no overlay for
 * a built-in, so a built-in the record does not already replace gets ADE's
 * copy of its definition on the model it runs on by itself. With no `profile`
 * (a machine whose shell ADE has not seen yet) the built-ins are left to
 * Claude Code rather than given a copy that names the wrong tools.
 */
export function withClaudeSubagentCompactWindow<TAgent extends object>(
  agents: Record<string, TAgent>,
  settings: ProviderCompactionSettings,
  launch: { profile: ClaudeBuiltinToolProfile | null; mainModel: string },
): Record<string, TAgent | (ClaudeBuiltinAgentDefinition & { model?: string; autoCompactWindow: number })> {
  const autoCompactWindow = claudeCompactWindow(settings.subagentAtTokens);
  if (autoCompactWindow === undefined || claudeSubagentWindowIneffective(settings)) return agents;
  const out: Record<string, TAgent | (ClaudeBuiltinAgentDefinition & { model?: string; autoCompactWindow: number })> = {};
  const profile = launch.profile;
  for (const key of HARNESS_PRESET_AGENT_KEYS) {
    const template = CLAUDE_BUILTIN_AGENT_TEMPLATES[key];
    if (!profile || agents[template.agentType]) continue;
    const model = template.ownModel && template.inheritCappedAtOpus && claudeModelAboveOpus(launch.mainModel)
      ? "opus"
      : template.ownModel;
    out[template.agentType] = {
      ...builtinAgentDefinition(template, profile),
      ...(model ? { model } : {}),
      autoCompactWindow,
    };
  }
  for (const [name, agent] of Object.entries(agents)) out[name] = { ...agent, autoCompactWindow };
  return out;
}

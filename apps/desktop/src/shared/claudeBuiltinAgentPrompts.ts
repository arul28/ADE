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
 * SOURCE: originally extracted from the Claude Code binary shipped with
 * `@anthropic-ai/claude-agent-sdk@0.3.258` — CLI version 2.1.258, build
 * 2026-09-01T21:54:40Z, git sha b3cd543a1f6fcdf4d8fabc0f5e5538d2ee7f38e1 —
 * and re-checked against CLI 2.1.280 (SDK 0.3.280) when the pin moved: Explore
 * and Plan are still the same templates (tool-name holes where Glob, Grep,
 * Read, and Bash are filled) and general-purpose's shared lines are unchanged,
 * so this copy still tracks the pinned binary. The prompts below are therefore
 * the 2.1.280 copies; only the 2.1.258 extraction has recorded build metadata,
 * because the CLI does not expose it.
 *
 * FIDELITY: the built-ins build their prompts from a template whose holes are
 * tool NAMES resolved at runtime (sandboxed vs. not, POSIX vs. PowerShell).
 * This copy renders the POSIX, non-sandboxed set — `Glob`, `Grep`, `Read`,
 * `Bash` — which is what ADE's chats run with on every supported platform's
 * default configuration. Everything outside those holes is verbatim.
 *
 * UPDATING: when the pinned SDK moves, re-extract rather than hand-editing.
 * The three markers to search the binary for are the first line of each prompt
 * below; each one is followed by the whole template in cleartext.
 */

import { HARNESS_PRESET_AGENT_KEYS, type HarnessPresetAgentKey } from "./harnessPresets";

/** The CLI build these prompts are taken from. */
export const CLAUDE_BUILTIN_AGENT_PROMPT_SOURCE_VERSION = "2.1.280";

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

const EXPLORE_PROMPT = `You are a file search specialist for Claude Code, Anthropic's official CLI for Claude. You excel at thoroughly navigating and exploring codebases.

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
- Use Glob for broad file pattern matching
- Use Grep for searching file contents with regex
- Use Read when you know the specific file path you need to read
- Use Bash ONLY for read-only operations (ls, git status, git log, git diff, find, cat, head, tail)
- NEVER use Bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification
- Adapt your search approach based on the thoroughness level specified by the caller
- Communicate your final report directly as a regular message - do NOT attempt to create files

NOTE: You are meant to be a fast agent that returns output as quickly as possible. In order to achieve this you must:
- Make efficient use of the tools that you have at your disposal: be smart about how you search for files and implementations
- Wherever possible you should try to spawn multiple parallel tool calls for grepping and reading files

Complete the user's search request efficiently and report your findings clearly.`;

const PLAN_PROMPT = `You are a software architect and planning specialist for Claude Code. Your role is to explore the codebase and design implementation plans.

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
   - Find existing patterns and conventions using Glob, \`find\`, \`grep\`, and Grep
   - Understand the current architecture
   - Identify similar features as reference
   - Trace through relevant code paths
   - Use Bash ONLY for read-only operations (ls, git status, git log, git diff, find, cat, head, tail)
   - NEVER use Bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification

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

const GENERAL_PURPOSE_PROMPT = `You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message, you should use the tools available to complete the task. Complete the task fully—don't gold-plate, but don't leave it half-done. When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.
- You are already the dedicated agent for this task. Do the work directly — do not re-delegate your entire assignment to another single subagent.`;

/** One built-in, as the SDK's `agents` option wants it (minus the model). */
export type ClaudeBuiltinAgentTemplate = {
  /** The key the SDK's `agents` record is keyed by — the agent's own type name. */
  agentType: string;
  /** `whenToUse`, verbatim from the built-in. */
  description: string;
  prompt: string;
  disallowedTools?: readonly string[];
};

export const CLAUDE_BUILTIN_AGENT_TEMPLATES: Record<HarnessPresetAgentKey, ClaudeBuiltinAgentTemplate> = {
  explore: {
    agentType: "Explore",
    description:
      "Read-only search agent for broad fan-out searches — when answering means sweeping many files, "
      + "directories, or naming conventions and you only need the conclusion, not the file dumps. It reads "
      + "excerpts rather than whole files, so it locates code; it doesn't review or audit it. Specify search "
      + "breadth: \"medium\" for moderate exploration, \"very thorough\" for multiple locations and naming conventions.",
    prompt: EXPLORE_PROMPT,
    disallowedTools: READ_ONLY_BUILTIN_DISALLOWED_TOOLS,
  },
  plan: {
    agentType: "Plan",
    description:
      "Software architect agent for designing implementation plans. Use this when you need to plan the "
      + "implementation strategy for a task. Returns step-by-step plans, identifies critical files, and "
      + "considers architectural trade-offs.",
    prompt: PLAN_PROMPT,
    disallowedTools: READ_ONLY_BUILTIN_DISALLOWED_TOOLS,
  },
  generalPurpose: {
    agentType: "general-purpose",
    description:
      "General-purpose agent for researching complex questions, searching for code, and executing multi-step "
      + "tasks. When you are searching for a keyword or file and are not confident that you will find the right "
      + "match in the first few tries use this agent to perform the search for you.",
    prompt: GENERAL_PURPOSE_PROMPT,
  },
};

/**
 * Build the SDK `agents` entries for a preset's pins.
 *
 * `follows` (the {@link HARNESS_PRESET_AGENT_FOLLOWS} token) is not a model —
 * it means "take the subagent model", which the caller resolves before calling
 * here. An entry whose resolved model is empty is skipped rather than sent with
 * an undefined model, because an `agents` entry with no model still replaces
 * the built-in prompt and would fork the agent for no benefit.
 */
export function buildClaudeBuiltinAgentOverrides(
  pins: Partial<Record<HarnessPresetAgentKey, string | null | undefined>>,
): Record<string, { description: string; prompt: string; model: string; disallowedTools?: string[] }> {
  const agents: Record<string, { description: string; prompt: string; model: string; disallowedTools?: string[] }> = {};
  for (const key of HARNESS_PRESET_AGENT_KEYS) {
    const model = pins[key]?.trim();
    if (!model) continue;
    const template = CLAUDE_BUILTIN_AGENT_TEMPLATES[key];
    agents[template.agentType] = {
      description: template.description,
      prompt: template.prompt,
      model,
      ...(template.disallowedTools ? { disallowedTools: [...template.disallowedTools] } : {}),
    };
  }
  return agents;
}

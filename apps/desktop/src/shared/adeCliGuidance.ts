import { MAX_STATUS_NOTE_CHARACTERS, STATUS_NOTE_GUIDELINE_WORDS } from "./sessionStatusNote";
import { formatAdeAgentSkillRootsForPrompt, getAdeAgentSkillRootsForPrompt } from "./agentSkillRoots";
import { SESSION_ACTIVITY_VALUES } from "./types/sessions";

/**
 * The bundled skill index every provider's prompt advertises.
 *
 * Order is prompt copy, not data: it runs most-reached-for first, so keep new
 * entries where they belong rather than sorting the array.
 *
 * This must name every directory under apps/desktop/resources/agent-skills — a
 * skill missing here is invisible to every agent, which is exactly what
 * happened to `ade-scene`. bundledAgentSkills.test.ts binds this list, the
 * packaging roster in scripts/bundled-agent-skills.mjs, and the real directory
 * together; adding a skill to only one of the three fails that test.
 */
export const adeBundledAgentSkills = [
  "ade-cli-control-plane",
  "ade-apple",
  "ade-harnesses",
  "ade-ios-simulator",
  "ade-app-control",
  "ade-desktop",
  "ade-browser",
  "ade-pr-workflows",
  "ade-lanes-git",
  "ade-linear",
  "ade-proof-artifacts",
  "ade-deeplinks",
  "ade-search",
  "ade-mosaic",
  "ade-scene",
] as const;

/**
 * The status protocol agents actually get. Note what is NOT here: settling.
 * `ade chat settle` was removed in 2026-07 — deciding that work is finished is
 * a subjective call agents are unreliable at, and a self-settling chat drops
 * out of the user's active list on the agent's say-so. Rows leave the active
 * list when the user settles them or when their PR merges. Keep this guidance
 * pointed at note/ask; do not re-add settle instructions.
 */
// NOTE: the Work-board status rule deliberately does NOT live here. This
// constant is emitted whole inside the Cursor SDK prompt's hard 3 KB budget,
// which truncates from the END — and that prompt already sits at ~100% of it,
// so every byte added here comes out of the subagent routing contract and the
// project rules below it. The board rule is documented where an agent actually
// reads it: the "Board and status" section of the ade-cli-control-plane skill.
export const ADE_SESSION_STATUS_PROTOCOL_GUIDANCE = [
  "ADE control protocol for truthful Work status:",
  `- Use \`ade chat note "testing desktop auth fallback"\` for a durable one-line summary (aim for ${STATUS_NOTE_GUIDELINE_WORDS} words or fewer; notes truncate past ${MAX_STATUS_NOTE_CHARACTERS} characters).`,
  '- Blocked on input: call `ade chat note "<what and why>"`, then `ade chat ask "<the exact question>"`; a note alone can leave an idle row looking Done.',
  "- The next accepted user message clears the prior hand-raise. Re-note and re-ask before ending if still blocked.",
  '- Done: report it and leave `ade chat note "<delivered result>"`.',
  "- You cannot settle or unsettle a session; that is the user's call, or the automatic result of its PR merging.",
  "- Waiting a while? `ade session snooze <id> --for <duration>` hides the row without claiming done; a hand-raise wakes it.",
  "- If the lane, branch, or chat name is wrong, rename it: `ade chat generate-names`, `ade chat update --title`, or `ade lanes rename`.",
].join("\n");

/**
 * Pin every ADE CLI socket selector to the same runtime. Different command
 * entry points prefer different variables, so setting only one can route
 * activity reports to a stale or unrelated runtime inherited from a preset.
 */
export function buildAdeRuntimeSocketEnv(runtimeSocketPath: string | null | undefined): Record<string, string> {
  const socketPath = runtimeSocketPath?.trim();
  return socketPath
    ? {
      ADE_RPC_URL: socketPath,
      ADE_RPC_SOCKET_PATH: socketPath,
      ADE_RUNTIME_SOCKET_PATH: socketPath,
    }
    : {};
}

export type AdeSessionActivityTarget =
  | { type: "environment" }
  /** OpenCode's shared server cannot receive this session's environment. */
  | { type: "inline"; runtimeSocketPath: string };

/**
 * Agent-set activity is emitted only by provider call sites that have verified
 * a shell/command tool path and the runtime-resolved ADE CLI executable. The
 * CLI path is injected into ADE-managed provider processes as ADE_CLI_PATH; the
 * explicit session id keeps the report scoped even for shared provider hosts.
 */
export function buildAdeSessionActivityGuidance(args: {
  sessionId: string;
  cliPath: string | null | undefined;
  shell: "posix" | "powershell";
  target?: AdeSessionActivityTarget;
}): string | null {
  const sessionId = args.sessionId.trim();
  if (!sessionId || !args.cliPath?.trim()) return null;
  const cliPath = args.cliPath;
  const target = args.target ?? { type: "environment" };
  const runtimeSocketPath = target.type === "inline" ? target.runtimeSocketPath.trim() || null : null;
  if (target.type === "inline" && !runtimeSocketPath) return null;

  const quoteShellValue = (value: string): string => args.shell === "powershell"
    ? `'${value.replace(/'/g, "''")}'`
    : `'${value.replace(/'/g, "'\\''")}'`;
  const safeSessionId = quoteShellValue(sessionId);
  const safeCliPath = quoteShellValue(cliPath);
  let safeRuntimeSocketPath: string | null = null;
  if (runtimeSocketPath) {
    safeRuntimeSocketPath = quoteShellValue(runtimeSocketPath);
  }
  const runtimeTargetEnv: Record<string, string> = target.type === "inline" && runtimeSocketPath
    ? {
      ADE_DEFAULT_ROLE: "agent",
      ADE_CHAT_SESSION_ID: sessionId,
      ...buildAdeRuntimeSocketEnv(runtimeSocketPath),
    }
    : {};
  let runtimeTargetAssignments = "";
  if (target.type === "inline" && Object.keys(runtimeTargetEnv).length > 0) {
    if (args.shell === "powershell") {
      runtimeTargetAssignments = `${Object.entries(runtimeTargetEnv)
        .map(([name, value]) => `$env:${name} = ${quoteShellValue(value)}`)
        .join("; ")}; `;
    } else {
      runtimeTargetAssignments = `${Object.entries(runtimeTargetEnv)
        .map(([name, value]) => `${name}=${quoteShellValue(value)}`)
        .join(" ")} `;
    }
  }
  let cliCommand: string;
  if (target.type === "inline") {
    cliCommand = args.shell === "powershell" ? `& ${safeCliPath}` : safeCliPath;
  } else {
    cliCommand = args.shell === "powershell" ? '& "$env:ADE_CLI_PATH"' : '"$ADE_CLI_PATH"';
  }
  const command = (activity: "testing" | "clear"): string => {
    const invoke = `${cliCommand} chat activity ${activity} --session ${safeSessionId}`;
    if (target.type !== "inline" || !safeRuntimeSocketPath) return invoke;
    return `${runtimeTargetAssignments}${invoke}`;
  };
  return [
    `- Report session activity with \`${command("testing")}\`; clear it with \`${command("clear")}\`.`,
    `  Choose one current state: ${SESSION_ACTIVITY_VALUES.join(", ")}.`,
  ].join("\n");
}

/**
 * Guidance for a tracked CLI PTY. ADE_ACTIVITY_SESSION_ID is the PTY row id;
 * ADE_CHAT_SESSION_ID continues to identify its owning chat for every other
 * ADE command. ADE_CLI_PATH is injected by ADE's runtime CLI resolver.
 */
export function buildAdeWindowsTrackedCliActivityGuidance(): string {
  return [
    "Activity detail for this tracked ADE CLI session:",
    "- When ADE_CLI_PATH and ADE_ACTIVITY_SESSION_ID are available, first identify your command shell. In PowerShell, report activity with `& \"$env:ADE_CLI_PATH\" chat activity testing` and clear it with `& \"$env:ADE_CLI_PATH\" chat activity clear`.",
    "  In cmd.exe, use `\"%ADE_CLI_PATH%\" chat activity testing` and `\"%ADE_CLI_PATH%\" chat activity clear`. Replace testing with one value from "
      + `${SESSION_ACTIVITY_VALUES.join(", ")}.`,
    "  In Git Bash, use `powershell.exe -NoProfile -Command '& \"$env:ADE_CLI_PATH\" chat activity testing'` and clear with `powershell.exe -NoProfile -Command '& \"$env:ADE_CLI_PATH\" chat activity clear'`.",
    "  These commands use ADE_ACTIVITY_SESSION_ID to target this terminal row. Do not guess a shell or pass another session id; if none matches, leave activity unchanged.",
  ].join("\n");
}

export function buildAdePosixTrackedCliActivityGuidance(): string {
  const command = '"$ADE_CLI_PATH"';
  return [
    "Activity detail for this tracked ADE CLI session:",
    `- When your command shell exposes ADE_CLI_PATH and ADE_ACTIVITY_SESSION_ID, report activity with \`${command} chat activity testing\`; clear it with \`${command} chat activity clear\`. Replace testing with one value from ${SESSION_ACTIVITY_VALUES.join(", ")}.`,
    "  ADE scopes this command to the tracked terminal row; do not pass another session id.",
  ].join("\n");
}

/**
 * @deprecated Superseded by {@link buildAdeBootstrapGuidance}. Kept as a thin alias so
 * existing call sites stay wired to the (now minimal) bootstrap. The previous ~1,000-token
 * blob is gone: ADE's capabilities are delivered as session-scoped Agent Skills, with
 * `ade skill show` as the runtime-independent activation fallback. Do not re-grow this.
 */
export function buildAdeCliAgentGuidance(skillRoots: readonly string[] = getAdeAgentSkillRootsForPrompt()): string {
  return buildAdeBootstrapGuidance(skillRoots);
}

export const ADE_CLI_AGENT_GUIDANCE = buildAdeCliAgentGuidance();

export function buildAdeCliInlineGuidance(skillRoots: readonly string[] = getAdeAgentSkillRootsForPrompt()): string {
  return buildAdeCliAgentGuidance(skillRoots);
}

export const ADE_CLI_INLINE_GUIDANCE = buildAdeCliInlineGuidance();

/**
 * Minimal always-on bootstrap that replaces the heavier {@link buildAdeCliAgentGuidance}
 * blob. It teaches the habit (reach for the matching `ade-*` skill on demand) and the
 * ground-truth fallback (`ade help` / `ade actions list`) instead of inlining every
 * socket/browser/proof rule on every turn — those now live in their skills, which each
 * runtime discovers natively when it supports extra roots. Keep this short; do not re-grow it.
 */
export function buildAdeBootstrapGuidance(
  skillRoots: readonly string[] = getAdeAgentSkillRootsForPrompt(),
): string {
  return [
    "## ADE",
    "ADE is a local-first dev environment for lanes, chats, terminals, PRs, proof, apps, iOS, and browsers. Its `ade` CLI controls ADE state; use `ade help <command>` instead of guessing.",
    "ADE capabilities ship as Agent Skills. For ADE tasks, read the matching `ade-*` skill before acting.",
    `Skills: ${adeBundledAgentSkills.map((name) => `\`${name}\``).join(", ")}.`,
    formatAdeAgentSkillRootsForPrompt(skillRoots),
    "If skills are not native, discover with `ade skill list --text` and load with `ade skill show <name> --text`.",
    "For Codex Computer Use, prefer direct `mcp__computer_use` tools and honor per-app approvals; never substitute `@oai/sky` via `node_repl`.",
    "CLI ground truth: `ade help <command>` and `ade actions list --text`; prefer typed commands with `--text`. Read only requested `ade secrets`, never print them, and clean up started processes.",
    "`ade chat scheduled-work create` durably resumes bound chats and tracked provider CLIs.",
    ADE_SESSION_STATUS_PROTOCOL_GUIDANCE,
  ].join("\n");
}

export const ADE_BOOTSTRAP_GUIDANCE = buildAdeBootstrapGuidance();

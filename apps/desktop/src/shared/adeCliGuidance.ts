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
  "ade-computer-use",
  "ade-apple",
  "ade-harnesses",
  "ade-ios-simulator",
  "ade-app-control",
  "ade-desktop",
  "ade-browser",
  "ade-pr-workflows",
  "ade-lanes-git",
  "ade-linear",
  "ade-webhooks",
  "ade-proof-artifacts",
  "ade-deeplinks",
  "ade-search",
  "ade-scene",
] as const;

/**
 * Old skill names kept so `ade skill show <old name>` and `/ade:<old name>`
 * still resolve. They are not advertised: each SKILL.md declares
 * `disable-model-invocation`, and the prompt's skill line leaves them out, so
 * no agent pays for two names of one skill.
 */
export const adeDeprecatedAgentSkillAliases: ReadonlySet<string> = new Set(["ade-desktop", "ade-ios-simulator"]);

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
  '- Asking the user anything, even while background work runs: `ade chat ask "<the exact question>"`; a note alone can leave an idle row looking Done. Not for progress updates.',
  "- The next accepted user message clears the prior hand-raise; re-ask if still blocked.",
  '- Done: report it and leave `ade chat note "<delivered result>"`.',
  "- You cannot settle or unsettle a session; that is the user's call, or the automatic result of its PR merging.",
  "- Waiting a while? `ade session snooze <id> --for <duration>` hides the row without claiming done; a hand-raise wakes it.",
  "- Lane and chat names are yours to keep accurate. When the work changes direction or moves to a new branch, rename without asking: `ade lanes rename`, `ade chat update --title`, or `ade chat generate-names`. A lane keeps its name when its branch changes.",
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
  | { type: "inline"; runtimeSocketPath: string }
  /**
   * A personal (project-less) chat. Its runtime has no socket of its own, so
   * every command names the personal scope and the session
   * (`--personal --session <id>`) and reaches it through the brain the CLI shim
   * already targets. Works from any shell, OpenCode's shared server included.
   * Adds the `note` / `ask` lines, and calls the row the Chats row.
   */
  | { type: "personal" };

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
  /**
   * Name the session through `ADE_CHAT_SESSION_ID` instead of spelling its id.
   * Only for an "environment" target whose provider process belongs to this
   * one session: the prompt then carries no per-chat value, so a new chat in
   * the same lane reuses the provider's prompt cache.
   */
  sessionIdFromEnvironment?: boolean;
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
  const sessionIdFromEnvironment = args.sessionIdFromEnvironment === true && target.type === "environment";
  let safeSessionId = quoteShellValue(sessionId);
  if (sessionIdFromEnvironment) {
    safeSessionId = args.shell === "powershell" ? "$env:ADE_CHAT_SESSION_ID" : '"$ADE_CHAT_SESSION_ID"';
  }
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
  if (target.type === "inline" || target.type === "personal") {
    cliCommand = args.shell === "powershell" ? `& ${safeCliPath}` : safeCliPath;
  } else {
    cliCommand = args.shell === "powershell" ? '& "$env:ADE_CLI_PATH"' : '"$ADE_CLI_PATH"';
  }
  const personal = target.type === "personal";
  const scopeFlag = personal ? " --personal" : "";
  const command = (activity: "debugging" | "clear"): string => {
    const invoke = `${cliCommand} chat activity ${activity}${scopeFlag} --session ${safeSessionId}`;
    if (target.type !== "inline" || !safeRuntimeSocketPath) return invoke;
    return `${runtimeTargetAssignments}${invoke}`;
  };
  const row = personal ? "Chats row" : "Work row";
  return [
    // A personal chat's status lines spell the scope and session too: an
    // OpenCode shell (one shared server) has no ADE_CHAT_SCOPE to route by.
    ...(personal
      ? [
        `- For long work, keep a one-line status on this chat's ${row} with \`${cliCommand} chat note${scopeFlag} --session ${safeSessionId} "<what you are doing>"\`; when you are blocked on the user, \`${cliCommand} chat ask${scopeFlag} --session ${safeSessionId} "<the question>"\`. If you asked and then kept working anyway, take the hand down with \`${cliCommand} chat ask --clear${scopeFlag} --session ${safeSessionId}\`.`,
      ]
      : []),
    `- ADE shows this chat's activity on its ${row}, detected from your tool calls. You do not need to report it.`,
    `  When the detected state is wrong or too coarse (debugging looks like testing to it), name the real one with \`${command("debugging")}\` (replace debugging with the real value); clear it with \`${command("clear")}\`.`,
    `  Values: ${SESSION_ACTIVITY_VALUES.join(", ")}.`,
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

/**
 * The screen rules a tracked CLI session needs in its own prompt.
 *
 * An ADE chat gets the full computer-use directive, written for the screens
 * its machine actually has. A provider CLI in a terminal is started with fixed
 * text and never gets that directive, yet every `ade` command works there
 * (the terminal carries the lane and session identity), so it could drive a
 * screen knowing only the name of a skill. These are the rules that prevent
 * damage; the how-to stays in `ade-computer-use`.
 */
export const ADE_CLI_SESSION_SCREEN_RULES = [
  "Screens and proof: every `ade` command works from this terminal.",
  "- The user's own screen, apps and windows are not yours to change. Never close, quit, hide or reset an app or window you did not open. Act on their real screen only when they ask.",
  "- Pick the surface: check with a CLI, test or file first; a web page or localhost is `ade browser`; an Electron app's DOM is `ade app-control`; an iOS app is `ade apple`; only a desktop app none of those reach goes on this lane's own screen, `ade mac-desktop` (`ade screen` on Windows), and you stop it when you finish.",
  "- Do not click, type or capture with anything else (osascript, cliclick, screencapture, a browser you start yourself): those drive the user's real screen.",
  "- An ok result only means the input was sent. Observe before you report, and file proof with the surface's own `proof` or `record` command.",
].join("\n");

/**
 * What a tracked provider CLI session is told: the bootstrap, the screen rules,
 * then the Project notes block when the launching process read one.
 */
export function buildAdeCliSessionGuidance(
  skillRoots: readonly string[] = getAdeAgentSkillRootsForPrompt(),
  projectNotes?: string | null,
): string {
  return [
    buildAdeCliAgentGuidance(skillRoots),
    "",
    ADE_CLI_SESSION_SCREEN_RULES,
    ...(projectNotes?.trim() ? ["", projectNotes.trim()] : []),
  ].join("\n");
}

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
    "ADE is a local-first dev environment for lanes, chats, terminals, PRs, proof, apps, iOS, and browsers. Its `ade` CLI controls ADE state.",
    "ADE capabilities ship as Agent Skills. For ADE tasks, read the matching `ade-*` skill before acting.",
    `Skills: ${adeBundledAgentSkills.filter((name) => !adeDeprecatedAgentSkillAliases.has(name)).map((name) => `\`${name}\``).join(", ")}.`,
    formatAdeAgentSkillRootsForPrompt(skillRoots),
    "If skills are not native, discover with `ade skill list --text` and load with `ade skill show <name> --text`.",
    // The one scene line every agent sees. Without it the skill was opened only
    // when a model happened to read the index, so scenes almost never appeared.
    "Visuals: when there is an obvious thing to show and a picture reads faster than prose (status across many items, a comparison, a trend), add one ```scene block; always when the user asks for a visual. Its buttons can offer options for a larger decision. Run `ade scene guide` first; check with `ade scene preview`.",
    // The one proof line every agent sees. Chat shows a picture only from the
    // project's own files or the proof store; an agent that linked a screenshot
    // it saved to /tmp left the user a chip saying "Outside this project".
    "Images in answers: `ade proof attach <file>`, then paste its `cite:` line; other paths may not show.",
    "For computer use, read `ade-computer-use` first. `mcp__computer_use` drives the user's real screen: use it only on request; never substitute `@oai/sky` via `node_repl`.",
    "CLI ground truth: `ade help <command>` and `ade actions list --text`; prefer typed commands with `--text`. Settings questions: `ade settings find <words>`. Read only requested `ade secrets`, never print them, and clean up started processes.",
    "`ade chat scheduled-work create` durably resumes bound chats and tracked provider CLIs.",
    // The distinction agents get wrong: a wake is you doing work later, a
    // draft send is the user's message arriving later. Naming both here keeps
    // an agent from reaching for its own cron when the user asked for a send.
    "Use `ade drafts` to send a message later (it lands as a real user turn in the target chat and shows in the user's Drafts); use `ade chat scheduled-work create` to wake *yourself* later to do work.",
    ADE_SESSION_STATUS_PROTOCOL_GUIDANCE,
  ].join("\n");
}

export const ADE_BOOTSTRAP_GUIDANCE = buildAdeBootstrapGuidance();

import { MAX_STATUS_NOTE_CHARACTERS, STATUS_NOTE_GUIDELINE_WORDS } from "./sessionStatusNote";
import { formatAdeAgentSkillRootsForPrompt, getAdeAgentSkillRootsForPrompt } from "./agentSkillRoots";
import { SESSION_ACTIVITY_VALUES, type AgentSpawnLineage } from "./types/sessions";

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
  "ade-android",
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
  '- Asking the user anything, even while background work runs: `ade chat ask "<the exact question>"`; a note alone can leave an idle row looking Done. Not for progress updates. A subagent puts its question in its report instead.',
  "- The next accepted user message clears the prior hand-raise; re-ask if still blocked.",
  '- Done: report it and leave `ade chat note "<delivered result>"`.',
  "- You cannot settle or unsettle a session; that is the user's call, or the automatic result of its PR merging.",
  "- Keep lane and chat names accurate. When the work changes direction or moves to a new branch, rename without asking: `ade lanes rename`, `ade chat update --title`, or `ade chat generate-names`. A lane keeps its name when its branch changes.",
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
  "- Pick the surface: check with a CLI, test or file first; a web page or localhost is `ade browser`; an Electron app's DOM is `ade app-control`; an iOS app is `ade apple`; only a desktop app none of those reach goes on this lane's own screen, `ade screen`, and you stop it when you finish.",
  "- Do not click, type or capture with anything else (osascript, cliclick, screencapture, a browser you start yourself): those drive the user's real screen.",
  "- An ok result only means the input was sent. Observe before you report, and file proof with the surface's own `proof` or `record` command.",
].join("\n");

/**
 * How a child chat or CLI sends a report to the chat that started it. One text
 * for both, so a chat subagent and a terminal subagent are told the same thing.
 */
export const ADE_PARENT_REPORT_COMMAND_GUIDANCE = [
  "Send reports with the typed `ade chat message` command, which passes a JSON object to `chat.messageSession`. Pass the report through stdin or a file with `--text-file`, never as an argument: on Windows `ade.cmd` cuts an argument at its first line break.",
  "In Bash/zsh or Git Bash, use a quoted here-doc with an end marker absent from the report: `ade chat message \"$ADE_PARENT_CHAT_SESSION_ID\" --text-file - <<'REPORT_END'`, the report, then `REPORT_END`.",
  "In PowerShell, put it in a single-quoted here-string (`$report = @'` ... `'@`; nothing inside is expanded), run `$f = New-TemporaryFile; Set-Content -LiteralPath $f -Value $report -Encoding utf8`, then `ade chat message $env:ADE_PARENT_CHAT_SESSION_ID --text-file $f`.",
].join(" ");

/**
 * What a provider CLI started by another chat is told about that chat. A
 * terminal has no reliable turn end ADE can read, so unlike a chat subagent
 * nothing reports for it: the CLI reports itself, by message, when it is done.
 */
export function buildCliSpawnReportGuidance(
  lineage: AgentSpawnLineage | null | undefined,
): string | null {
  const parent = lineage?.parentChatSessionId?.trim();
  if (!parent) return null;
  // `$ADE_PARENT_CHAT_SESSION_ID` is exported to this process and holds the
  // same id; it is named here too in case a shell loses the variable.
  if (lineage?.spawnKind === "peer") {
    return `ADE chat ${parent} started you as a peer: nobody waits on your result. If that chat needs it, report it. ${ADE_PARENT_REPORT_COMMAND_GUIDANCE}`;
  }
  return [
    `You are a subagent of ADE chat ${parent} ($ADE_PARENT_CHAT_SESSION_ID). That chat cannot see this terminal, so report to it yourself:`,
    "- When you finish a task, send a report: what you did, what you checked, and anything left open. Send one for each task you finish, not only when you exit.",
    "- When you need a decision, put the question and your recommendation in a report and wait; do not ask the user. That chat asks them when it cannot decide.",
    `- ${ADE_PARENT_REPORT_COMMAND_GUIDANCE}`,
  ].join("\n");
}

/** What a tracked provider CLI session is told: the bootstrap, then the screen rules. */
export function buildAdeCliSessionGuidance(
  skillRoots: readonly string[] = getAdeAgentSkillRootsForPrompt(),
  spawnLineage?: AgentSpawnLineage | null,
): string {
  const report = buildCliSpawnReportGuidance(spawnLineage);
  return [
    buildAdeCliAgentGuidance(skillRoots),
    "",
    ADE_CLI_SESSION_SCREEN_RULES,
    ...(report ? ["", report] : []),
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
    `Skills: for ADE tasks read the matching \`ade-*\` skill first: ${adeBundledAgentSkills.filter((name) => !adeDeprecatedAgentSkillAliases.has(name)).map((name) => `\`${name}\``).join(", ")}.`,
    formatAdeAgentSkillRootsForPrompt(skillRoots),
    "No native skills? `ade skill list --text`, then `ade skill show <name> --text`.",
    // The one scene line every agent sees. Without it the skill was opened only
    // when a model happened to read the index, so scenes almost never appeared.
    "Visuals: when a picture beats prose (status across many items, a comparison, a trend) or when asked, add one ```scene block; its buttons can offer choices. Run `ade scene guide` first; check with `ade scene preview`.",
    // The one proof line every agent sees. Chat shows a picture only from the
    // project's own files or the proof store; an agent that linked a screenshot
    // it saved to /tmp left the user a chip saying "Outside this project".
    "Images in answers: `ade proof attach <file>`, then paste its `cite:` line; other paths may not show. Proof or demos for people: read `ade-proof-artifacts`.",
    // Agents opened about two thirds of recent PRs with `gh`, and rewrote the
    // text of the rest with `gh pr edit`, which drops ADE's footer and leaves
    // cited proof as links GitHub cannot show.
    "PRs: open with `ade prs create`, rewrite text with `ade prs body`; `gh` skips proof upload and the lane link.",
    "`mcp__computer_use` drives the user's real screen: use it only on request, after `ade-computer-use`; never substitute `@oai/sky` via `node_repl`.",
    "CLI ground truth: `ade help <command>` and `ade actions list --text`; prefer typed commands with `--text`. Settings questions: `ade settings find <words>`; clean up started processes.",
    // Without this line an agent that needed Linear asked for the API key in
    // chat, where it stays in the transcript. Each command shows a card only
    // the user can answer, and the value never reaches the agent.
    "Credentials: never ask in chat. `ade secrets request` (a key), `ade integrations connect` (GitHub/Linear/Jira) and `ade mcp servers add` (MCP) show the user a card. Read only requested `ade secrets`; never print them.",
    // One default per scenario: same chat and lane, subagents for other
    // models, and one wake per thing waited on, so an agent never polls.
    "Stay in this chat and lane unless asked. Another model works as your subagent (`ade new chat --mode chat`). Later: subagents report back; a PR you watch → `ade prs watch`; terminal → `ade terminal watch`; else `ade chat scheduled-work create`. `ade drafts` sends as the user.",
    ADE_SESSION_STATUS_PROTOCOL_GUIDANCE,
  ].join("\n");
}

export const ADE_BOOTSTRAP_GUIDANCE = buildAdeBootstrapGuidance();

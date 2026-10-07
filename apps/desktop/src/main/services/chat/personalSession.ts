import path from "node:path";

import { adeBundledAgentSkills } from "../../../shared/adeCliGuidance";
import { formatAdeAgentSkillRootsForPrompt } from "../../../shared/agentSkillRoots";
import type { AgentChatPersonalProfile, AgentChatSession } from "../../../shared/types/chat";

/**
 * What a personal chat is, where it runs, and what its provider is told.
 *
 * Three questions that are all "how does the personal/SDK surface differ from a
 * work chat". They are pure and close over nothing, so the surface's rules can
 * be read in one screen.
 *
 * On the prompt: every provider inside `agentChatService.ts` builds the
 * personal prompt for its own instruction channel — Claude's `systemPrompt`,
 * Codex's `developerInstructions`, OpenCode's `system`, Pi's
 * `systemPromptOverride`, and the text Cursor and Droid get prefixed into the
 * turn. All of them must apply the host's append/replace rule identically, so
 * all of them call `resolvePersonalSystemPrompt`. Adding a provider means
 * calling it, never re-implementing the rule.
 */

/** True for a chat on the personal (SDK) surface, false for work and automation. */
export function isPersonalSession(session: Pick<AgentChatSession, "surface">): boolean {
  return session.surface === "personal";
}

/** A persisted or requested profile value, or null for anything else. */
export function normalizePersonalProfile(value: unknown): AgentChatPersonalProfile | null {
  return value === "assistant" || value === "embedded" ? value : null;
}

/**
 * A personal chat started from ADE's own UI or CLI: a normal ADE chat that is
 * not tied to a project. Only an explicit `assistant` counts — an absent
 * profile (every SDK host, every row written before profiles) is `embedded`.
 */
export function isAssistantPersonalSession(
  session: Pick<AgentChatSession, "surface" | "personalProfile">,
): boolean {
  return isPersonalSession(session) && session.personalProfile === "assistant";
}

/**
 * A personal chat on the SDK-host surface, which keeps the pre-profile
 * behavior exactly. The gates that used to read `isPersonalSession` for an
 * assistant-surface choice (skills, prompt, settings, approval cards) read
 * this instead; the project-only gates (lane id, worktree, git, lane memory)
 * keep reading `isPersonalSession`.
 */
export function isEmbeddedPersonalSession(
  session: Pick<AgentChatSession, "surface" | "personalProfile">,
): boolean {
  return isPersonalSession(session) && session.personalProfile !== "assistant";
}

/**
 * Skills an `assistant` chat does not get: they act on a lane's worktree,
 * branch or pull request, and a personal chat has none of those.
 */
export const PERSONAL_LANE_ONLY_AGENT_SKILLS = ["ade-lanes-git", "ade-pr-workflows"] as const;

/**
 * The directory a personal chat's provider actually runs in, when the host
 * named one.
 *
 * `resolveLaneLaunchContext` deliberately never lets `requestedCwd` move
 * `laneWorktreePath`, because in a project a lane's worktree is a git
 * invariant and a chat that ran outside it would produce diffs against the
 * wrong tree. A personal chat has no such invariant: its "lane" is a synthetic
 * row over a scratch directory that exists only to satisfy the chat and PTY
 * services. So this is the one surface where the host's directory replaces the
 * lane root rather than sitting beside it — which matters because every
 * provider adapter reads `laneWorktreePath`, not `requestedCwd`.
 *
 * Returns null for a work chat, an automation chat, or a personal chat with no
 * host cwd, all of which keep the lane root untouched. The path is validated
 * before it is ever stored (`personalChatScope.create`); a relative value that
 * reached persistence from an older build is rejected here rather than
 * resolved against whatever the runtime's own cwd happens to be.
 */
export function resolvePersonalHostCwd(
  session: Pick<AgentChatSession, "surface" | "requestedCwd">,
): string | null {
  if (!isPersonalSession(session)) return null;
  const requested = typeof session.requestedCwd === "string" ? session.requestedCwd.trim() : "";
  if (!requested.length) return null;
  return path.isAbsolute(requested) ? requested : null;
}

export const PERSONAL_CHAT_SYSTEM_PROMPT = [
  "You are a general-purpose AI assistant in an ADE personal chat.",
  "This conversation is not attached to a software project, repository, branch, lane, or pull request.",
  "Answer the user's request directly. Do not assume they want coding work or inspect files unless they explicitly ask.",
  "If filesystem or shell work is explicitly requested, keep it inside the scratch working directory provided by the runtime.",
].join(" ");

/**
 * The system text for one personal session.
 *
 * No instructions → the constant, byte for byte, which is what every existing
 * embedder already gets. `append` → the constant, a blank line, then the host
 * text, in that order, so ADE's framing is what the model reads first.
 * `replace` → the host text alone: a chat branded as the host's own assistant
 * must not be told it is in "an ADE personal chat", and that sentence is the
 * whole reason `replace` exists.
 *
 * Empty host text cannot reach here — `normalizeHostInstructions` rejects it —
 * so `replace` never produces an empty prompt.
 */
export function resolvePersonalSystemPrompt(
  session: Pick<AgentChatSession, "instructions">,
  base: string = PERSONAL_CHAT_SYSTEM_PROMPT,
): string {
  const instructions = session.instructions;
  const text = typeof instructions?.text === "string" ? instructions.text.trim() : "";
  if (!text.length) return base;
  if (instructions?.mode === "replace") return text;
  return `${base}\n\n${text}`;
}

/**
 * The system text an `assistant` personal chat starts from.
 *
 * The agent is on the user's own machine and not in a project. It may use the
 * shell, files wherever the user points it, ADE's browser, computer use, App
 * Control and the `ade` CLI, and works in its scratch folder by default. It is
 * deliberately not the coding-agent prompt: there is no worktree to protect,
 * no Work board to report to, and plenty of what a user asks here is not code.
 */
export function buildPersonalAssistantSystemPrompt(args: {
  /** The directory the provider runs in: the scratch folder or the host's cwd. */
  cwd: string;
  /** Skill roots as the agent will see them (lane-only skills already withheld). */
  skillRoots: readonly string[];
  /**
   * How to report this chat's activity on its Chats row
   * (`buildAdeSessionActivityGuidance`), when the provider can run the command.
   */
  activityGuidance?: string | null;
}): string {
  const withheld = new Set<string>(PERSONAL_LANE_ONLY_AGENT_SKILLS);
  const skills = adeBundledAgentSkills.filter((name) => !withheld.has(name));
  return [
    "You are the user's assistant inside ADE, running on their own computer.",
    "This chat is not attached to a project, repository, branch, lane, or pull request. Not every request is about code: answer questions directly, and when the user wants something done, do it.",
    "You can run shell commands, read and write files wherever the user points you, open and drive web pages in ADE's browser, use computer use and App Control, and use the `ade` CLI.",
    `Your working directory is this chat's scratch folder: ${args.cwd}. Put files you create there unless the user names another place. Ask before you delete or overwrite the user's own files outside it.`,
    "With the `ade` CLI you can list, read, start and message chats in any project on this machine (`--project-root <path>`), and on the account's other machines (`--machine`).",
    "",
    "## ADE",
    "ADE capabilities ship as Agent Skills. For an ADE task, read the matching `ade-*` skill before acting.",
    `Skills: ${skills.map((name) => `\`${name}\``).join(", ")}.`,
    formatAdeAgentSkillRootsForPrompt(args.skillRoots),
    "If skills are not native, discover with `ade skill list --text` and load with `ade skill show <name> --text`.",
    "Web pages go in ADE's browser (`ade browser`, the `ade-browser` skill), which shares the user's sign-ins; do not use a headless or external browser.",
    "For computer use, read `ade-computer-use` first. The user's own screen, apps and windows are not yours to change: act on their real screen only when they ask, and never close or quit an app you did not open.",
    "Visuals: when a comparison, a trend or status across many items would read faster as a picture, add one ```scene block (read `ade-scene` first). To ask the user for structured choices, use a ```mosaic block (read `ade-mosaic`).",
    "CLI ground truth: `ade help <command>` and `ade actions list --text`; prefer typed commands with `--text`. Read only requested `ade secrets`, never print them, and clean up processes you start.",
    ...(args.activityGuidance?.trim()
      ? [
        "",
        "## Status on the Chats row",
        "For long work, keep a one-line status with `ade chat note \"<what you are doing>\"`; when you are blocked on the user, `ade chat ask \"<the question>\"`. Both reach this chat's row from your shell, which carries `ADE_CHAT_SCOPE=personal`.",
        args.activityGuidance.trim().replace("on its Work row", "on its Chats row"),
      ]
      : []),
  ].join("\n");
}

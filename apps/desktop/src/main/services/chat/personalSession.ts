import path from "node:path";

import type { AgentChatSession } from "../../../shared/types/chat";

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
): string {
  const instructions = session.instructions;
  const text = typeof instructions?.text === "string" ? instructions.text.trim() : "";
  if (!text.length) return PERSONAL_CHAT_SYSTEM_PROMPT;
  if (instructions?.mode === "replace") return text;
  return `${PERSONAL_CHAT_SYSTEM_PROMPT}\n\n${text}`;
}

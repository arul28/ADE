import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAdeAgentSkillRootsForPrompt } from "../../../shared/agentSkillRoots";
import type { AgentChatPermissionMode } from "../../../shared/types";
import { buildCodingAgentSystemPrompt } from "../ai/tools/systemPrompt";

/**
 * ADE's instruction file for a tracked OpenCode CLI session.
 *
 * OpenCode reads `instructions` entries as file paths, so the one ADE
 * contributes has to exist on disk somewhere. Two placements are wrong. The lane
 * worktree is the user's repository — an ADE-authored prompt file showing up in
 * their `git status` is not something a launch should do. The system temp
 * directory is world-writable on Linux, and because this path is deliberately
 * stable and derived from public inputs, another local user could pre-create it
 * as a symlink and turn an ADE launch into a write through that link.
 *
 * `.ade/cache` is ADE's own machine-local, per-project, gitignored area, and is
 * already where terminal snapshots and chat sessions live.
 */
const INSTRUCTIONS_DIR_NAME = "opencode-instructions";

function instructionsDir(projectRoot: string): string {
  return path.join(projectRoot, ".ade", "cache", INSTRUCTIONS_DIR_NAME);
}

/**
 * Stable per-lane path. Hashed rather than slugified because worktree paths
 * routinely contain characters that are legal in a path but awkward in a
 * filename, and because OpenCode globs the basename within the parent directory
 * — a name containing `*` or `?` would match the wrong file or nothing at all.
 */
export function openCodeAdeInstructionsPath(args: {
  projectRoot: string;
  laneWorktreePath: string;
}): string {
  const key = createHash("sha256").update(args.laneWorktreePath).digest("hex").slice(0, 16);
  return path.join(instructionsDir(args.projectRoot), `ade-${key}.md`);
}

/**
 * The ADE instruction contract a tracked OpenCode CLI session receives.
 *
 * Built from the same `buildCodingAgentSystemPrompt` the OpenCode chat runtime
 * uses, with the same `runtime: "opencode"` descriptor, so chat and CLI agree on
 * one slim ADE base prompt instead of the CLI carrying a separately maintained
 * inline preamble. Only the framing header is CLI-specific.
 */
export function buildOpenCodeAdeInstructions(args: {
  laneWorktreePath: string;
  permissionMode: AgentChatPermissionMode | null | undefined;
}): string {
  const permissionMode = args.permissionMode === "plan"
    ? "plan"
    : args.permissionMode === "full-auto"
      ? "full-auto"
      : "edit";
  return [
    "# ADE session instructions",
    "",
    buildCodingAgentSystemPrompt({
      cwd: args.laneWorktreePath,
      mode: permissionMode === "plan" ? "planning" : "coding",
      permissionMode,
      interactive: true,
      runtime: "opencode",
      adeSkillRoots: getAdeAgentSkillRootsForPrompt({ cwd: args.laneWorktreePath }),
    }),
    "",
  ].join("\n");
}

/**
 * Write the instruction file for a lane and return its path.
 *
 * Rewritten on every launch so a permission-mode change or an ADE upgrade takes
 * effect rather than resurrecting whatever the previous session left behind.
 * Returns null when the file cannot be written: a missing `instructions` target
 * is skipped by OpenCode, so the CLI still launches, just without the ADE
 * preamble — strictly better than failing the launch outright.
 */
export function ensureOpenCodeAdeInstructionsFile(args: {
  projectRoot: string;
  laneWorktreePath: string;
  permissionMode: AgentChatPermissionMode | null | undefined;
}): string | null {
  const worktree = args.laneWorktreePath?.trim();
  const projectRoot = args.projectRoot?.trim();
  if (!worktree || !projectRoot) return null;
  const target = openCodeAdeInstructionsPath({ projectRoot, laneWorktreePath: worktree });
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, buildOpenCodeAdeInstructions({
      laneWorktreePath: worktree,
      permissionMode: args.permissionMode,
    }), { encoding: "utf8", mode: 0o600 });
    return target;
  } catch {
    return null;
  }
}

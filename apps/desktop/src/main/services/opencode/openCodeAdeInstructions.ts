import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAdeAgentSkillRootsForPrompt } from "../../../shared/agentSkillRoots";
import type { AgentChatPermissionMode } from "../../../shared/types";
import { buildCodingAgentSystemPrompt } from "../ai/tools/systemPrompt";

/**
 * ADE's instruction file for a tracked OpenCode CLI session.
 *
 * OpenCode reads `instructions` entries as file paths, so the one ADE
 * contributes has to exist on disk somewhere. It deliberately does NOT live in
 * the lane worktree: that is the user's repository, and an ADE-authored prompt
 * file appearing in `git status` (or worse, in a commit) is not something a
 * launch should do. A machine-local cache directory keyed by worktree keeps it
 * invisible to the repo while staying stable across relaunches and resumes of
 * the same lane.
 */
const INSTRUCTIONS_DIR_NAME = "ade-opencode-instructions";

function instructionsDir(): string {
  const override = process.env.ADE_OPENCODE_INSTRUCTIONS_DIR?.trim();
  return override ? path.resolve(override) : path.join(os.tmpdir(), INSTRUCTIONS_DIR_NAME);
}

/**
 * Stable per-lane path. Hashed rather than slugified because worktree paths
 * routinely contain characters that are legal in a path but awkward in a
 * filename, and because OpenCode globs the basename within the parent directory
 * — a name containing `*` or `?` would match the wrong file or nothing at all.
 */
export function openCodeAdeInstructionsPath(laneWorktreePath: string): string {
  const key = createHash("sha256").update(laneWorktreePath).digest("hex").slice(0, 16);
  return path.join(instructionsDir(), `ade-${key}.md`);
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
  laneWorktreePath: string;
  permissionMode: AgentChatPermissionMode | null | undefined;
}): string | null {
  const worktree = args.laneWorktreePath?.trim();
  if (!worktree) return null;
  const target = openCodeAdeInstructionsPath(worktree);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buildOpenCodeAdeInstructions({
      laneWorktreePath: worktree,
      permissionMode: args.permissionMode,
    }), "utf8");
    return target;
  } catch {
    return null;
  }
}

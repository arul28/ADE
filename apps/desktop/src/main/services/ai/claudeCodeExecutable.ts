import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DetectedAuth } from "./authDetector";

export type ClaudeCodeExecutableResolution = {
  path: string;
  source: "env" | "auth" | "path" | "common-dir" | "fallback-command";
};

const HOME_DIR = os.homedir();
const COMMON_BIN_DIRS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/bin",
  `${HOME_DIR}/.local/bin`,
  `${HOME_DIR}/.nvm/current/bin`,
].filter(Boolean);

function isExecutableFile(candidatePath: string): boolean {
  try {
    const stat = fs.statSync(candidatePath);
    return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

function resolveFromPathEntries(command: string, pathValue: string | undefined): string | null {
  if (!pathValue) return null;
  for (const entry of pathValue.split(path.delimiter)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const candidatePath = path.join(trimmed, command);
    if (isExecutableFile(candidatePath)) {
      return candidatePath;
    }
  }
  return null;
}

function findClaudeAuthPath(auth?: DetectedAuth[]): string | null {
  for (const entry of auth ?? []) {
    if (entry.type !== "cli-subscription" || entry.cli !== "claude") continue;
    const candidate = entry.path.trim();
    if (candidate && isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function resolveClaudeCodeExecutable(args?: {
  auth?: DetectedAuth[];
  env?: NodeJS.ProcessEnv;
}): ClaudeCodeExecutableResolution {
  const env = args?.env ?? process.env;
  const envPath = env.CLAUDE_CODE_EXECUTABLE_PATH?.trim();
  if (envPath) {
    return { path: envPath, source: "env" };
  }

  const authPath = findClaudeAuthPath(args?.auth);
  if (authPath) {
    return { path: authPath, source: "auth" };
  }

  const pathResolved = resolveFromPathEntries("claude", env.PATH);
  if (pathResolved) {
    return { path: pathResolved, source: "path" };
  }

  for (const binDir of COMMON_BIN_DIRS) {
    const candidatePath = path.join(binDir, "claude");
    if (isExecutableFile(candidatePath)) {
      return { path: candidatePath, source: "common-dir" };
    }
  }

  return { path: "claude", source: "fallback-command" };
}

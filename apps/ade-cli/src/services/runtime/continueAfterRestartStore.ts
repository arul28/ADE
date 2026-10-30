import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { resolveAdeLayout } from "../../../../desktop/src/shared/adeLayout";
import { resolveMachineAdeDir, resolveMachineAdeLayout } from "../projects/machineLayout";
import { ProjectRegistry } from "../projects/projectRegistry";
import { writeJsonAtomic } from "./atomicJson";

/**
 * "Continue chats after restarts", one value per machine, in
 * `~/.ade/continue-after-restart.json`.
 *
 * Each machine's brain decides its own resumes after a restart (an update, a
 * crash, a reboot), so the choice belongs to the machine, not to a project or
 * the account. It used to live in each project's `.ade/local.yaml`
 * (`ai.chat.continueAfterRestart`); older builds still read it there, and this
 * file never touches it.
 *
 * Migration, once, when the file does not exist yet: off when any project on
 * this machine had turned it off explicitly (someone chose that on purpose),
 * otherwise on, the default. The answer is written, so it is decided once.
 */
export const CONTINUE_AFTER_RESTART_FILE = "continue-after-restart.json";

export type ContinueAfterRestartRecord = {
  continueAfterRestart: boolean;
  updatedAt: string | null;
};

export function continueAfterRestartFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveMachineAdeDir(env), CONTINUE_AFTER_RESTART_FILE);
}

/** The saved value, or null when nothing (readable) was saved. */
export function readSavedContinueAfterRestart(env: NodeJS.ProcessEnv = process.env): boolean | null {
  let raw: string;
  try {
    raw = fs.readFileSync(continueAfterRestartFilePath(env), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed?.continueAfterRestart === "boolean" ? parsed.continueAfterRestart : null;
  } catch {
    return null;
  }
}

export function writeSavedContinueAfterRestart(
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): ContinueAfterRestartRecord {
  const record: ContinueAfterRestartRecord = { continueAfterRestart: enabled, updatedAt: now().toISOString() };
  writeJsonAtomic(continueAfterRestartFilePath(env), record, `${process.pid}`);
  migratedValue = null;
  return record;
}

/** True when this project's `.ade/local.yaml` turned the old per-project setting off. */
function projectTurnedItOff(rootPath: string): boolean {
  try {
    const parsed = YAML.parse(fs.readFileSync(resolveAdeLayout(rootPath).localConfigPath, "utf8")) as unknown;
    const chat = (parsed as { ai?: { chat?: { continueAfterRestart?: unknown } } } | null)?.ai?.chat;
    return chat?.continueAfterRestart === false;
  } catch {
    return false;
  }
}

/** The migrated value, kept when the file cannot be written (a read-only home). */
let migratedValue: boolean | null = null;

/**
 * The machine's value. The first read on a machine without the file migrates
 * from its projects and saves the answer; a save that fails is kept in memory.
 */
export function resolveContinueAfterRestart(env: NodeJS.ProcessEnv = process.env): boolean {
  const saved = readSavedContinueAfterRestart(env);
  if (saved != null) return saved;
  if (migratedValue != null) return migratedValue;
  let anyOff = false;
  try {
    anyOff = new ProjectRegistry(resolveMachineAdeLayout(env)).list().some((project) => projectTurnedItOff(project.rootPath));
  } catch {
    anyOff = false;
  }
  migratedValue = !anyOff;
  try {
    writeSavedContinueAfterRestart(!anyOff, env);
  } catch {
    // Read-only home: the value still holds for this process.
  }
  migratedValue = !anyOff;
  return !anyOff;
}

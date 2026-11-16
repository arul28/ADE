/**
 * Full access for Claude on a machine where ADE runs as root.
 *
 * Claude Code refuses `bypassPermissions` as root unless it is told it runs in
 * a sandbox. Its rule, read in the CLI (SDK 0.3.319): `getuid() === 0 &&
 * IS_SANDBOX !== "1" && !CLAUDE_CODE_BUBBLEWRAP`. ADE Cloud computers set
 * `IS_SANDBOX=1` in their image, so the rule never applies there.
 *
 * On a person's own Linux box run as root, the person can say once, for the
 * whole machine, that it is set aside for agents. ADE then starts Claude with
 * `IS_SANDBOX=1` for a full-access chat on that machine only. The choice lives
 * in `<ADE home>/agent-root-access.json` on that machine, and only the person
 * sets it (`chat.setRootFullAccess` is user-only in the action policy).
 *
 * Windows has no `getuid`, so none of this applies there; macOS rarely runs
 * ADE as root, and the same rule holds if it does.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeTextAtomic } from "../shared/utils";

const FILE_NAME = "agent-root-access.json";

export type RootFullAccessState = {
  /** Claude would refuse full access here without the opt-in: ADE runs as root, outside a sandbox. */
  applies: boolean;
  /** The person allowed full access as root on this machine. */
  allowed: boolean;
};

function adeHome(env: NodeJS.ProcessEnv): string {
  return env.ADE_HOME?.trim() || path.join(os.homedir(), ".ade");
}

function accessFile(env: NodeJS.ProcessEnv): string {
  return path.join(adeHome(env), FILE_NAME);
}

/** True when Claude Code's root rule would refuse full access in this process. */
export function claudeRootRuleApplies(env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return false;
  return env.IS_SANDBOX !== "1" && !env.CLAUDE_CODE_BUBBLEWRAP;
}

/** Whether the person allowed full access as root on this machine. A missing or unreadable file is no. */
export function rootFullAccessAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(accessFile(env), "utf8")) as { v?: unknown; allowed?: unknown } | null;
    return parsed?.v === 1 && parsed.allowed === true;
  } catch {
    return false;
  }
}

export function readRootFullAccessState(env: NodeJS.ProcessEnv = process.env): RootFullAccessState {
  return { applies: claudeRootRuleApplies(env), allowed: rootFullAccessAllowed(env) };
}

export function writeRootFullAccessAllowed(allowed: boolean, env: NodeJS.ProcessEnv = process.env): RootFullAccessState {
  const file = accessFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeTextAtomic(file, `${JSON.stringify({ v: 1, allowed, at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  return readRootFullAccessState(env);
}

/**
 * Claude Code exits at startup when asked to skip permissions here: ADE runs
 * as root outside a sandbox and the person has not allowed it for the machine.
 */
export function claudeCodeRefusesBypassHere(env: NodeJS.ProcessEnv = process.env): boolean {
  return claudeRootRuleApplies(env) && !rootFullAccessAllowed(env);
}

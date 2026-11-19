import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { providerSelfUpdateEnv } from "../../../shared/pinnedToolSpawnEnv";
import type { Logger } from "../logging/logger";
import { isExecutablePath, resolveClaudeCodeExecutable } from "./claudeCodeExecutable";

/**
 * Claude Code downloads the skills and plugins of a claude.ai account into
 * `<config>/skills/synced` and `<config>/plugins/synced` when a session process
 * starts. A process that starts while that first download runs lists fewer
 * account skills, in a different order, than the processes after it. The
 * skill listing is part of every request's cached prefix, so the second chat
 * in a new home cannot read the first chat's cache and writes it all again.
 *
 * When the base account (`~/.claude`, or the brain's `CLAUDE_CONFIG_DIR`) is
 * signed in with a claude.ai account and has never synced, this starts one
 * Claude session process with no prompt, so the download finishes before the
 * first chat. The process gets no prompt and writes no session file. Once per
 * brain process; other Claude accounts (their own `CLAUDE_CONFIG_DIR`) keep
 * syncing on their first chat, as before.
 */

/** The longest the process runs. */
const SYNC_MAX_MS = 15_000;
const SYNC_POLL_MS = 250;
/** The file Claude Code writes in an account's synced folder when a download round ends. */
const ROUND_COMPLETE_FILE = ".last-complete-round";
/** How long a closed process may take to exit before it is killed. */
const SYNC_EXIT_GRACE_MS = 3_000;

let started = false;

function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? configured : path.join(os.homedir(), ".claude");
}

/** True when a download round finished in `<config>/<kind>/synced/<account>/`. */
function roundComplete(configDir: string, kind: "skills" | "plugins"): boolean {
  const root = path.join(configDir, kind, "synced");
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .some((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, ROUND_COMPLETE_FILE)));
  } catch {
    return false;
  }
}

function syncComplete(configDir: string): boolean {
  return roundComplete(configDir, "skills") && roundComplete(configDir, "plugins");
}

export function ensureClaudeAccountSkillsSynced(args: { logger: Logger; env?: NodeJS.ProcessEnv }): void {
  if (started) return;
  started = true;
  const env = args.env ?? process.env;
  const configDir = claudeConfigDir(env);
  if (fs.existsSync(path.join(configDir, "skills", "synced"))) return;
  const executable = resolveClaudeCodeExecutable({ env });
  if (!isExecutablePath(executable.path)) return;

  const startedAt = Date.now();
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      executable.path,
      ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
      {
        cwd: os.homedir(),
        env: { ...env, ...providerSelfUpdateEnv("claude") },
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      },
    );
  } catch (error) {
    args.logger.warn("claude.account_skill_sync_failed", { error: String(error) });
    return;
  }

  let done = false;
  const finish = (reason: "synced" | "timeout" | "exited" | "error", error?: unknown) => {
    if (done) return;
    done = true;
    clearInterval(poll);
    clearTimeout(hardStop);
    const details = { reason, ms: Date.now() - startedAt, synced: syncComplete(configDir) };
    if (reason === "error") {
      args.logger.warn("claude.account_skill_sync_failed", { ...details, error: String(error) });
      return;
    }
    args.logger.info("claude.account_skill_sync", details);
    if (reason === "exited") return;
    // Closing stdin ends a session that never got a prompt.
    try { child.stdin?.end(); } catch { /* already closed */ }
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }, SYNC_EXIT_GRACE_MS).unref();
  };
  const poll = setInterval(() => {
    if (syncComplete(configDir)) finish("synced");
  }, SYNC_POLL_MS);
  poll.unref();
  const hardStop = setTimeout(() => finish("timeout"), SYNC_MAX_MS);
  hardStop.unref();
  child.stdin?.on("error", () => { /* the process exited first */ });
  child.once("error", (error) => finish("error", error));
  child.once("exit", () => finish("exited"));
}

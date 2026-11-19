import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { providerSelfUpdateEnv } from "../../../shared/pinnedToolSpawnEnv";
import { claudeConfigDir } from "../externalSessions/discoverClaude";
import type { Logger } from "../logging/logger";
import { terminateChildProcessTree } from "../shared/utils";
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
 * first chat, and a chat that starts during the download waits for it
 * (`waitForClaudeAccountSkillSync`). The process gets no prompt and writes no
 * session file. It loads
 * the user settings only (the download needs them) and no MCP servers or
 * hooks, so nothing of the user's runs for it. Once per brain process; other
 * Claude accounts (their own `CLAUDE_CONFIG_DIR`) keep syncing on their first
 * chat, as before.
 */

/** The longest the process runs. */
const SYNC_MAX_MS = 15_000;
const SYNC_POLL_MS = 250;
/**
 * How long the process stays after the skills round when no plugins round
 * follows: an account with no plugins may never write the plugins marker.
 */
const PLUGINS_ROUND_GRACE_MS = 2_000;
/** The file Claude Code writes in an account's synced folder when a download round ends. */
const ROUND_COMPLETE_FILE = ".last-complete-round";
/** How long a closed process may take to exit before it is killed. */
const SYNC_EXIT_GRACE_MS = 3_000;
/** The longest a chat start waits for a download in progress. */
const CHAT_WAIT_MAX_MS = 5_000;

let started = false;
/** Resolves when the download process ends; null when none ran. */
let inFlight: Promise<void> | null = null;

const SYNC_ARGS = [
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  // With no setting sources Claude Code skips the account download.
  "--setting-sources", "user",
  "--strict-mcp-config",
  "--settings", JSON.stringify({ disableAllHooks: true }),
];

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


/**
 * For a Claude chat about to start its process: while the download runs, a
 * promise that settles when it ends (at most `CHAT_WAIT_MAX_MS`), so the chat
 * lists the complete skills. Null when no download runs, so a chat start
 * awaits nothing and keeps its timing.
 */
export function waitForClaudeAccountSkillSync(): Promise<void> | null {
  if (!inFlight) return null;
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    inFlight,
    new Promise<void>((resolve) => { timer = setTimeout(resolve, CHAT_WAIT_MAX_MS); }),
  ]).finally(() => clearTimeout(timer));
}

export function ensureClaudeAccountSkillsSynced(args: { logger: Logger; env?: NodeJS.ProcessEnv }): void {
  if (started) return;
  const env = args.env ?? process.env;
  const configDir = claudeConfigDir({ env });
  // The skills round decides the listing; the plugins round ends with it.
  if (roundComplete(configDir, "skills")) {
    started = true;
    return;
  }
  // Still downloading Claude Code: a later status read tries again.
  const executable = resolveClaudeCodeExecutable({ env });
  if (!isExecutablePath(executable.path)) return;
  started = true;

  const startedAt = Date.now();
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      executable.path,
      SYNC_ARGS,
      {
        // A neutral folder: no project files and no home tree to read.
        cwd: os.tmpdir(),
        env: { ...env, ...providerSelfUpdateEnv("claude") },
        stdio: ["pipe", "ignore", "ignore"],
        // Its own process group, so a stop reaches anything it started.
        detached: process.platform !== "win32",
        windowsHide: true,
      },
    );
  } catch (error) {
    args.logger.warn("claude.account_skill_sync_failed", { error: String(error) });
    return;
  }

  let done = false;
  let settle: () => void = () => {};
  inFlight = new Promise<void>((resolve) => { settle = resolve; });
  const finish = (reason: "synced" | "timeout" | "exited" | "error", error?: unknown) => {
    if (done) return;
    done = true;
    settle();
    inFlight = null;
    clearInterval(poll);
    clearTimeout(hardStop);
    const details = { reason, ms: Date.now() - startedAt, synced: roundComplete(configDir, "skills") };
    if (reason === "error" || !details.synced) {
      args.logger.warn("claude.account_skill_sync_failed", { ...details, ...(error ? { error: String(error) } : {}) });
    } else {
      args.logger.info("claude.account_skill_sync", details);
    }
    if (reason === "error" || reason === "exited") return;
    // Closing stdin ends a session that never got a prompt.
    try { child.stdin?.end(); } catch { /* already closed */ }
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) terminateChildProcessTree(child).unref();
    }, SYNC_EXIT_GRACE_MS).unref();
  };
  let skillsDoneAt: number | null = null;
  const poll = setInterval(() => {
    if (skillsDoneAt === null && roundComplete(configDir, "skills")) skillsDoneAt = Date.now();
    if (skillsDoneAt === null) return;
    if (roundComplete(configDir, "plugins") || Date.now() - skillsDoneAt >= PLUGINS_ROUND_GRACE_MS) finish("synced");
  }, SYNC_POLL_MS);
  poll.unref();
  const hardStop = setTimeout(() => finish("timeout"), SYNC_MAX_MS);
  hardStop.unref();
  child.stdin?.on("error", () => { /* the process exited first */ });
  child.once("error", (error) => finish("error", error));
  child.once("exit", () => finish("exited"));
}

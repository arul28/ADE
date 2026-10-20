/**
 * The user's own MCP servers for one tracked Claude or Codex CLI (a Work
 * terminal ADE launches or resumes): the same set a chat on that account
 * gets (`mcpUserServersForLaunch.ts`). A terminal's launch command is a
 * command line, can be typed into the shell as text, and is kept for resume,
 * so no server definition may put a secret there:
 *
 * - Claude reads its servers from a private ADE-owned file
 *   (`--mcp-config <path>`), so every server can go, env values included.
 * - Codex has no file form for this, so a server whose env, headers,
 *   arguments or URL look like they carry a secret is left to start as the
 *   user configured it (or, on an ADE account, not at all).
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensurePrivateDirectory, writePrivateFile } from "../../../../../ade-cli/src/lib/trustedWindowsTools";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import { providerInstanceLaunchEnv, type ProviderInstanceLaunchTarget, type TrackedCliUserMcp } from "../../../shared/cliLaunch";
import { mcpPlainTextSecretFindings } from "../../../shared/mcpServerImport";
import { captureError } from "../../../shared/sentry/capture";
import { isRecord } from "./mcpProviderConfigScan";
import { resolveClaudeUserServers, resolveCodexUserServers } from "./mcpUserServersForLaunch";
import { sharedNpxDirectLauncher } from "./npxDirectLaunch";

/**
 * The main checkout of a git worktree (its `.git` file reads
 * `gitdir: <main>/.git/worktrees/<name>`), which Claude keys a project's
 * local-scope servers by. Null for a main checkout or anything unreadable.
 */
function mainCheckoutOf(cwd: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(cwd, ".git"), "utf8");
  } catch {
    return null; // A main checkout has a `.git` folder, not a file.
  }
  const gitdir = text.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  if (!gitdir) return null;
  const worktrees = path.dirname(path.resolve(cwd, gitdir));
  if (path.basename(worktrees) !== "worktrees") return null;
  return path.dirname(path.dirname(worktrees));
}

/** npx's own switches, which take no value. */
const NPX_SWITCHES = new Set(["-y", "--yes", "-q", "--quiet", "--silent", "--"]);

/** A flag whose value is a credential by its name (`--token`, `--api-key`, `--cookie`, …). */
const CREDENTIAL_FLAG = /^--?[\w-]*(token|key|secret|pass|cookie|session|auth|bearer|cred|sig)[\w-]*(=|$)/i;

/**
 * True unless a Codex overlay entry is known to carry nothing secret onto the
 * command line. Conservative on purpose: a server it refuses starts as the
 * user configured it (or, on an ADE account, not at all), never with its
 * secret in the terminal.
 */
function codexEntryCarriesSecret(entry: Record<string, unknown>): boolean {
  // The only env a re-pointed server may carry is the PATH ADE built.
  const isPathKey = (key: string) => (process.platform === "win32" ? key.toUpperCase() === "PATH" : key === "PATH");
  if (isRecord(entry.env) && Object.keys(entry.env).some((key) => !isPathKey(key))) return true;
  if (isRecord(entry.http_headers) && Object.keys(entry.http_headers).length) return true;
  const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [];
  if (args.some((arg) => CREDENTIAL_FLAG.test(arg))) return true;
  // A flag's value can be anything (`-p hunter2`), so only standalone flags
  // (`--headless`) and bare words that follow no flag (`mcp`) may ride.
  // npx's own switches take no value.
  const takesNoValue = (flag: string) => NPX_SWITCHES.has(flag);
  if (args.some((arg, index) => {
    // `-phunter2` is a short flag with its value attached.
    if (/^-[^-]./.test(arg) && !takesNoValue(arg)) return true;
    if (arg.startsWith("-")) return arg.includes("=");
    const previous = index > 0 ? args[index - 1]! : "";
    return previous.startsWith("-") && !takesNoValue(previous);
  })) return true;
  const url = typeof entry.url === "string" ? entry.url : undefined;
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.username || parsed.password || parsed.search) return true;
    } catch {
      return true;
    }
  }
  return mcpPlainTextSecretFindings({ args, url }).some((finding) => finding.kind === "value");
}

/** How long a written config is kept. Claude reads it once, at startup. */
const CLAUDE_MCP_CONFIG_KEEP_MS = 24 * 60 * 60 * 1000;

/**
 * Write a Claude MCP config into ADE's own private folder and answer its
 * path. Named by its content, so a resume that resolves the same servers
 * reuses the same file. Claude reads it only when it starts and every
 * resume writes it again, so copies older than a day are removed: a value
 * the user rotated does not stay on disk.
 */
function writeClaudeMcpConfigFile(servers: Record<string, unknown>): string {
  const contents = `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
  const dir = path.join(resolveMachineAdeLayout().adeDir, "mcp-launch");
  const file = path.join(dir, `claude-${createHash("sha256").update(contents).digest("hex").slice(0, 24)}.json`);
  ensurePrivateDirectory(dir);
  writePrivateFile(file, contents);
  const cutoff = Date.now() - CLAUDE_MCP_CONFIG_KEEP_MS;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    // Pruning is best-effort; the config this launch needs is written.
    captureError(error, { fingerprint: ["mcp", "tracked_cli_config_prune"], tags: { provider: "claude" } });
  }
  for (const name of names) {
    if (!/^claude-[0-9a-f]+\.json$/.test(name)) continue;
    const other = path.join(dir, name);
    if (other === file) continue;
    try {
      if (fs.statSync(other).mtimeMs < cutoff) fs.rmSync(other, { force: true });
    } catch (error) {
      captureError(error, { fingerprint: ["mcp", "tracked_cli_config_prune"], tags: { provider: "claude" } });
    }
  }
  return file;
}

export async function resolveTrackedCliUserMcp(args: {
  provider: string;
  cwd: string | null | undefined;
  projectRoot?: string | null;
  instance?: ProviderInstanceLaunchTarget | null;
  /** A harness preset's env, which can name its own config home. */
  presetEnv?: Record<string, string> | null;
}): Promise<TrackedCliUserMcp | null> {
  const cwd = args.cwd?.trim();
  if (!cwd || (args.provider !== "claude" && args.provider !== "codex")) return null;
  const launcher = sharedNpxDirectLauncher();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...providerInstanceLaunchEnv(args.provider, args.instance),
    ...(args.presetEnv ?? {}),
  };
  try {
    if (args.provider === "codex") {
      const overlay = await resolveCodexUserServers(launcher, { env, cwd, skipNames: new Set(["computer_use"]) });
      const safe = Object.fromEntries(Object.entries(overlay).filter(([, entry]) => !codexEntryCarriesSecret(entry)));
      return Object.keys(safe).length ? { codex: safe } : null;
    }
    const projectRoot = args.projectRoot ?? mainCheckoutOf(cwd);
    const servers = await resolveClaudeUserServers(launcher, {
      env,
      cwd,
      projectRoots: projectRoot ? [projectRoot] : [],
      settingSources: ["user", "local"],
    });
    return Object.keys(servers).length ? { claudeConfigPath: writeClaudeMcpConfigFile(servers) } : null;
  } catch (error) {
    // The CLI still starts with the servers its own config gives it.
    captureError(error, {
      fingerprint: ["mcp", "tracked_cli_user_servers", args.provider],
      tags: { provider: args.provider },
    });
    return null;
  }
}

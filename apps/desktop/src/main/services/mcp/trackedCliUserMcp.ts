/**
 * The MCP servers for one tracked agent CLI (a Work terminal ADE launches or
 * resumes): the user's own servers a chat on that account gets
 * (`mcpUserServersForLaunch.ts`), and the servers of ADE's MCP registry
 * (Settings > Integrations > MCP servers, "every agent ADE launches gets"),
 * the same set a chat gets (`mcpRegistryLaunch.ts`). A terminal's launch
 * command is a command line, can be typed into the shell as text, and is kept
 * for resume, so no server definition may put a secret there:
 *
 * - Claude reads its servers from a private ADE-owned file
 *   (`--mcp-config <path>`), so every server can go, env values included.
 * - Copilot reads them the same way (`--additional-mcp-config @<path>`).
 * - Codex has no file form for this, so a server whose env, headers,
 *   arguments or URL look like they carry a secret is left to start as the
 *   user configured it (or, on an ADE account, not at all), and a registry
 *   server with a secret value is left out.
 *
 * The other tracked CLIs have no per-launch MCP flag or file ADE can hand a
 * server through without writing the user's own config: Cursor, Droid, Pi,
 * Kimi, Qwen, Grok, Devin and Muse keep the servers their own config names,
 * and an OpenCode terminal shares ADE's OpenCode server and its config.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensurePrivateDirectory, writePrivateFile } from "../../../../../ade-cli/src/lib/trustedWindowsTools";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import { providerInstanceLaunchEnv, type LaunchProfile, type ProviderInstanceLaunchTarget, type TrackedCliUserMcp } from "../../../shared/cliLaunch";
import { mcpPlainTextSecretFindings } from "../../../shared/mcpServerImport";
import type { CallerMcpServers } from "../../../shared/callerMcpServers";
import { resolveMcpRegistryForLaunch } from "../chat/mcpRegistryLaunch";
import { createChatUserMcp } from "./chatUserMcp";
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
  // Including grouped short switches (`-yq`).
  const takesNoValue = (flag: string) => NPX_SWITCHES.has(flag) || /^-[yq]+$/.test(flag);
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
      // A fragment can carry a token too (`#access_token=…`), and the whole
      // URL lands on Codex's command line.
      if (parsed.username || parsed.password || parsed.search || parsed.hash) return true;
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
function writeClaudeMcpConfigFile(servers: Record<string, unknown>, prefix: "claude" | "copilot" = "claude"): string {
  const contents = `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
  const dir = path.join(resolveMachineAdeLayout().adeDir, "mcp-launch");
  const file = path.join(dir, `${prefix}-${createHash("sha256").update(contents).digest("hex").slice(0, 24)}.json`);
  ensurePrivateDirectory(dir);
  writePrivateFile(file, contents);
  const cutoff = Date.now() - CLAUDE_MCP_CONFIG_KEEP_MS;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    // Pruning is best-effort; the config this launch needs is written.
    captureError(error, { fingerprint: ["mcp", "tracked_cli_config_prune"], tags: { provider: prefix } });
  }
  for (const name of names) {
    if (!/^(claude|copilot)-[0-9a-f]+\.json$/.test(name)) continue;
    const other = path.join(dir, name);
    if (other === file) continue;
    try {
      if (fs.statSync(other).mtimeMs < cutoff) fs.rmSync(other, { force: true });
    } catch (error) {
      captureError(error, { fingerprint: ["mcp", "tracked_cli_config_prune"], tags: { provider: prefix } });
    }
  }
  return file;
}

/**
 * Reads one MCP secret value from the account vault, for registry servers
 * whose env or header values live there. Set once by the process that holds
 * the vault (the brain); with none set, a registry server that needs a value
 * is left out of a terminal launch rather than started without it.
 */
let registrySecretReader: ((vaultKey: string) => string | null) | null = null;

export function setTrackedCliRegistrySecretReader(reader: ((vaultKey: string) => string | null) | null): void {
  registrySecretReader = reader;
}

/** The tracked CLIs ADE hands MCP servers to. */
type TrackedCliMcpProvider = "claude" | "codex" | "copilot";
const TRACKED_CLI_MCP_PROVIDERS: ReadonlySet<string> = new Set<TrackedCliMcpProvider>(["claude", "codex", "copilot"]);

/** Whether a tracked CLI of this provider can be handed MCP servers at launch. */
export function trackedCliTakesMcpServers(provider: string): provider is TrackedCliMcpProvider {
  return TRACKED_CLI_MCP_PROVIDERS.has(provider);
}

/**
 * The registry servers a terminal launch of this provider gets: on for this
 * project and computer, not already started by the provider's own config
 * (`chatUserMcp.registryServers`), with every value they name in hand. A
 * terminal has no line to say a server started without its key, so such a
 * server (or one whose sign-in ran out) is left out, and so is one with a
 * per-tool filter the CLI's config cannot carry.
 */
function trackedCliRegistryServers(args: {
  provider: TrackedCliMcpProvider;
  cwd: string;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
}): CallerMcpServers {
  const registry = resolveMcpRegistryForLaunch({
    adeHome: resolveMachineAdeLayout().adeDir,
    projectRoot: args.projectRoot,
    provider: args.provider,
    readSecret: (vaultKey) => registrySecretReader?.(vaultKey) ?? null,
  });
  if (!registry.servers) return {};
  const incomplete = new Set([
    ...registry.missing.map((entry) => entry.split(":")[0]!.trim()),
    ...registry.signInExpired,
  ]);
  const complete: CallerMcpServers = {};
  for (const [name, server] of Object.entries(registry.servers)) {
    if (incomplete.has(name)) continue;
    if (server.disallowedTools?.length || (args.provider !== "copilot" && server.allowedTools?.length)) continue;
    complete[name] = server;
  }
  if (!Object.keys(complete).length) return {};
  return createChatUserMcp({ projectRoot: args.projectRoot })
    .registryServers({ provider: args.provider, cwd: args.cwd, env: args.env }, complete) ?? {};
}

/** A registry server as Claude's `--mcp-config` file names it. */
function claudeFileServer(server: CallerMcpServers[string]): Record<string, unknown> {
  return server.type === "stdio"
    ? { type: "stdio", command: server.command, args: server.args ?? [], ...(server.env ? { env: server.env } : {}) }
    : { type: server.type, url: server.url, ...(server.headers ? { headers: server.headers } : {}) };
}

/** A registry server as Copilot's `--additional-mcp-config` file names it. */
function copilotFileServer(server: CallerMcpServers[string]): Record<string, unknown> {
  const tools = server.allowedTools?.length ? server.allowedTools : ["*"];
  return server.type === "stdio"
    ? { type: "local", command: server.command, args: server.args ?? [], ...(server.env ? { env: server.env } : {}), tools }
    : { type: server.type, url: server.url, ...(server.headers ? { headers: server.headers } : {}), tools };
}

/** A registry server as a Codex `mcp_servers.<name>` overlay, before the secret check. */
function codexOverlayServer(server: CallerMcpServers[string]): Record<string, unknown> {
  return server.type === "stdio"
    ? { command: server.command, args: server.args ?? [], ...(server.env ? { env: server.env } : {}) }
    : { url: server.url, ...(server.headers ? { http_headers: server.headers } : {}) };
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
  const provider = args.provider;
  if (!cwd || !trackedCliTakesMcpServers(provider)) return null;
  const launcher = sharedNpxDirectLauncher();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...providerInstanceLaunchEnv(provider, args.instance),
    ...(args.presetEnv ?? {}),
  };
  const projectRoot = args.projectRoot ?? mainCheckoutOf(cwd);
  const registryFor = (): CallerMcpServers => {
    try {
      return trackedCliRegistryServers({ provider, cwd, projectRoot: projectRoot ?? cwd, env });
    } catch (error) {
      captureError(error, {
        fingerprint: ["mcp", "tracked_cli_registry_servers", args.provider],
        tags: { provider: args.provider },
      });
      return {};
    }
  };
  try {
    if (args.provider === "copilot") {
      const registry = registryFor();
      const servers = Object.fromEntries(Object.entries(registry).map(([name, server]) => [name, copilotFileServer(server)]));
      return Object.keys(servers).length ? { copilotConfigPath: writeClaudeMcpConfigFile(servers, "copilot") } : null;
    }
    if (args.provider === "codex") {
      const overlay = await resolveCodexUserServers(launcher, { env, cwd, skipNames: new Set(["computer_use"]) });
      const registry = Object.fromEntries(Object.entries(registryFor())
        .filter(([name]) => name !== "computer_use")
        .map(([name, server]) => [name, codexOverlayServer(server)]));
      const merged = { ...overlay, ...registry };
      const safe = Object.fromEntries(Object.entries(merged).filter(([, entry]) => !codexEntryCarriesSecret(entry)));
      return Object.keys(safe).length ? { codex: safe } : null;
    }
    const userServers = await resolveClaudeUserServers(launcher, {
      env,
      cwd,
      projectRoots: projectRoot ? [projectRoot] : [],
      settingSources: ["user", "local"],
    });
    const registry = Object.fromEntries(Object.entries(registryFor()).map(([name, server]) => [name, claudeFileServer(server)]));
    const servers = { ...userServers, ...registry };
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

/**
 * A background job (a chat title, a summary) on Droid, Kimi, Grok, Muse or
 * Devin runs on a private copy of the provider's config folder that lists no
 * MCP servers. None of these CLIs has a switch that starts none, and each one
 * starts every server in its own config at launch, even for a job that never
 * calls one (measured with a stdio marker server: `droid exec` 0.244, `kimi
 * --prompt` 2.3.1, `grok --single` 1.0.46 and a `muse serve` 1.4.7 session all
 * started it; Droid's `--settings` with `mcpPolicy.enabled: false` and Muse's
 * `-c mcpServers...` did not stop it).
 *
 * The copy is a folder of links to every entry of the real one, except the
 * files that list MCP servers, which are left out or rewritten. Sign-ins and
 * history stay where they are. A CLI that saves a linked file by writing a new
 * file and renaming it over the old one (Grok does this) replaces the link in
 * the copy, not the real file, so `close` writes such a file back over the
 * real one when the real one did not change meanwhile: a refreshed sign-in
 * token is never lost. Directories are linked whole, so writes inside them
 * land in the real folder.
 *
 * When the copy cannot be built (a link the filesystem refuses, a Windows
 * hard link across volumes), the job runs on the real folder, as before.
 * Servers a plugin adds are not in these files and still start.
 *
 * Cursor's one-shot worker gets a home of its own instead
 * (`providerTaskCursorHome`): it signs in with an API key, and it writes
 * ADE's tool gate into whatever home it runs on.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensurePrivateDirectory, writePrivateFile } from "../../../../../ade-cli/src/lib/trustedWindowsTools";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import { captureError } from "../../../shared/sentry/capture";
import { parseJsonc } from "../../../shared/theme/jsonc";
import { resolveMuseConfigDir } from "../ai/museAuth";
import {
  devinConfigDir,
  factoryConfigHome,
  grokConfigHome,
  kimiCodeConfigHome,
} from "../shared/providerConfigHomes";
import { readText } from "./mcpProviderConfigScan";

export type ProviderTaskMcpProvider = "droid" | "kimi" | "grok" | "muse" | "devin";

/** The env a job runs with, and the call that writes back and removes the copy. */
export type ProviderTaskMcpOff = { env: Record<string, string>; close: () => void };

type Entry = { omit: true } | { text: string } | { dir: Folder };
/** `source` is the real folder whose other entries are linked in; null for none. */
type Folder = { source: string | null; entries: Record<string, Entry> };

type LinkedFile = { real: string; copy: string; ino: bigint; mtimeNs: bigint; size: bigint };

/** One folder per user for every copy, made private once; each copy is a fresh folder inside it. */
function taskHomesRoot(): string {
  const root = path.join(resolveMachineAdeLayout().adeDir, "provider-task-homes");
  ensurePrivateDirectory(root);
  return root;
}

/** The home Cursor's one-shot workers run on, so `~/.cursor/mcp.json` is never read. */
export function providerTaskCursorHome(): string {
  const home = path.join(taskHomesRoot(), "cursor-home");
  ensurePrivateDirectory(home);
  return home;
}

function jsonObject(text: string | null): Record<string, unknown> | null {
  if (text == null) return null;
  try {
    const parsed = parseJsonc(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function hasMcpServers(file: string): boolean {
  const servers = jsonObject(readText(file))?.mcpServers;
  return !!servers && typeof servers === "object" && Object.keys(servers).length > 0;
}

/** `text` as JSON without its `mcpServers`, with `extra` merged in; null when it is not a JSON object. */
function withoutMcpServers(text: string | null, extra: Record<string, unknown> = {}): string | null {
  const parsed = text == null ? {} : jsonObject(text);
  if (!parsed) return null;
  const { mcpServers: _dropped, ...rest } = parsed;
  return `${JSON.stringify({ ...rest, ...extra }, null, 2)}\n`;
}

const GROK_COMPAT_VENDORS = ["claude", "cursor", "codex"] as const;

/**
 * The user's Grok `config.toml` without its `[mcp_servers.*]` tables, and with
 * `mcps = false` for each tool Grok imports servers from (`[compat.claude]`
 * reads `~/.claude.json` and `.mcp.json`, `[compat.cursor]` reads
 * `.cursor/mcp.json`). A config that names `compat` some other way is left to
 * it, so the copy never holds a key twice, which Grok would refuse.
 */
export function grokTaskConfigToml(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const ownCompat = lines.some((line) => /^\s*(\[\s*compat\s*\]|compat\s*[.=])/.test(line));
  const out: string[] = [];
  const seen = new Set<string>();
  let table = "";
  for (const line of lines) {
    const header = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
    if (header) {
      table = header[1]!.trim();
      if (/^mcp_servers(\.|$)/.test(table)) continue;
      out.push(line);
      const vendor = ownCompat ? undefined : table.match(/^compat\.(claude|cursor|codex)$/)?.[1];
      if (vendor) {
        seen.add(vendor);
        out.push("mcps = false");
      }
      continue;
    }
    if (/^mcp_servers(\.|$)/.test(table)) continue;
    if (!table && /^\s*mcp_servers\s*[.=]/.test(line)) continue;
    if (!ownCompat && /^compat\./.test(table) && /^\s*mcps\s*=/.test(line)) continue;
    out.push(line);
  }
  if (!ownCompat) {
    for (const vendor of GROK_COMPAT_VENDORS) {
      if (!seen.has(vendor)) out.push("", `[compat.${vendor}]`, "mcps = false");
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}

/** Devin's import of other tools' settings (`read_config_from`), all of them off. */
const DEVIN_IMPORTS_OFF = { cursor: false, windsurf: false, claude: false, opencode: false, vscode: false, zed: false };

/** What each provider's copy needs, or null when it has nothing to leave out. */
function providerFolder(provider: ProviderTaskMcpProvider, env: NodeJS.ProcessEnv): { envKey: string; folder: Folder } | null {
  switch (provider) {
    case "droid": {
      // `FACTORY_HOME_OVERRIDE` replaces the home `.factory` is appended to.
      const factory = factoryConfigHome({ env });
      if (!hasMcpServers(path.join(factory, "mcp.json"))) return null;
      return {
        envKey: "FACTORY_HOME_OVERRIDE",
        folder: { source: null, entries: { ".factory": { dir: { source: factory, entries: { "mcp.json": { omit: true } } } } } },
      };
    }
    case "kimi": {
      const home = kimiCodeConfigHome({ env });
      if (!hasMcpServers(path.join(home, "mcp.json"))) return null;
      return { envKey: "KIMI_CODE_HOME", folder: { source: home, entries: { "mcp.json": { omit: true } } } };
    }
    case "grok": {
      // Always: Grok also imports Claude's and Cursor's servers.
      const home = grokConfigHome({ env });
      const config = grokTaskConfigToml(readText(path.join(home, "config.toml")) ?? "");
      return { envKey: "GROK_HOME", folder: { source: home, entries: { "config.toml": { text: config } } } };
    }
    case "muse": {
      const museDir = resolveMuseConfigDir(env);
      const settingsPath = path.join(museDir, "settings.json");
      if (!hasMcpServers(settingsPath)) return null;
      const settings = withoutMcpServers(readText(settingsPath));
      if (settings == null) return null;
      return {
        envKey: "XDG_CONFIG_HOME",
        folder: { source: path.dirname(museDir), entries: { [path.basename(museDir)]: { dir: { source: museDir, entries: { "settings.json": { text: settings } } } } } },
      };
    }
    case "devin": {
      // Always: Devin imports other tools' servers unless `read_config_from` says not to.
      const devinDir = devinConfigDir({ env });
      const configText = readText(path.join(devinDir, "config.json"));
      const userConfig = jsonObject(configText);
      const userImports = userConfig?.read_config_from;
      const config = withoutMcpServers(configText, {
        read_config_from: { ...(userImports && typeof userImports === "object" ? userImports : {}), ...DEVIN_IMPORTS_OFF },
      });
      if (config == null) return null;
      return {
        envKey: process.platform === "win32" ? "APPDATA" : "XDG_CONFIG_HOME",
        folder: {
          source: path.dirname(devinDir),
          entries: {
            [path.basename(devinDir)]: {
              dir: {
                source: devinDir,
                entries: { "config.json": { text: config }, "mcp_config.json": { omit: true }, "mcp_config.local.json": { omit: true } },
              },
            },
          },
        },
      };
    }
  }
}

function linkEntry(real: string, copy: string, isDir: boolean): void {
  if (process.platform !== "win32") {
    fs.symlinkSync(real, copy);
  } else if (isDir) {
    // A junction needs no privilege.
    fs.symlinkSync(real, copy, "junction");
  } else {
    // A file symlink needs Developer Mode on Windows; a hard link does not.
    fs.linkSync(real, copy);
  }
}

function buildFolder(target: string, folder: Folder, linked: LinkedFile[], links: string[]): void {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  if (folder.source) {
    let real: fs.Dirent[] = [];
    try {
      real = fs.readdirSync(folder.source, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    for (const dirent of real) {
      if (dirent.name in folder.entries) continue;
      const realPath = path.join(folder.source, dirent.name);
      const copyPath = path.join(target, dirent.name);
      let stat: fs.BigIntStats;
      try {
        stat = fs.statSync(realPath, { bigint: true });
      } catch {
        continue; // A dangling link: nothing to read through it.
      }
      // A socket or pipe cannot be hard-linked on Windows.
      if (process.platform === "win32" && !stat.isDirectory() && !stat.isFile()) continue;
      linkEntry(realPath, copyPath, stat.isDirectory());
      links.push(copyPath);
      if (stat.isFile()) linked.push({ real: realPath, copy: copyPath, ino: stat.ino, mtimeNs: stat.mtimeNs, size: stat.size });
    }
  }
  for (const [name, entry] of Object.entries(folder.entries)) {
    if ("omit" in entry) continue;
    if ("text" in entry) writePrivateFile(path.join(target, name), entry.text);
    else buildFolder(path.join(target, name), entry.dir, linked, links);
  }
}

/**
 * Put a linked file the CLI replaced back over the real one, by the same
 * write-and-rename. Skipped when the real file changed during the job (the
 * other writer wins) or is gone.
 */
function writeBack(file: LinkedFile): void {
  let copy: fs.BigIntStats;
  try {
    copy = fs.lstatSync(file.copy, { bigint: true });
  } catch {
    return;
  }
  const replaced = process.platform === "win32" ? copy.ino !== file.ino : !copy.isSymbolicLink();
  if (!replaced || !copy.isFile()) return;
  let real: fs.BigIntStats;
  try {
    real = fs.statSync(file.real, { bigint: true });
  } catch {
    return;
  }
  if (real.mtimeNs !== file.mtimeNs || real.size !== file.size) return;
  const temp = path.join(path.dirname(file.real), `.${path.basename(file.real)}.ade-${randomBytes(4).toString("hex")}`);
  try {
    fs.copyFileSync(file.copy, temp);
    if (process.platform !== "win32") fs.chmodSync(temp, Number(real.mode) & 0o777);
    fs.renameSync(temp, file.real);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function removeCopy(root: string, links: string[]): void {
  // Unlink every link first, so removing the folder can never reach the real data.
  for (const link of links) {
    try {
      if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
    } catch {
      // Gone already, or replaced by a file of the CLI's own.
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
}

/**
 * The env for one background job on `provider` that starts none of the
 * servers in the user's config, or `{}` when there is nothing to leave out or
 * the copy could not be built. `env` is the environment the CLI runs with.
 * Always call `close` when the job is done.
 */
export function openProviderTaskMcpOff(provider: ProviderTaskMcpProvider, env: NodeJS.ProcessEnv): ProviderTaskMcpOff {
  const none: ProviderTaskMcpOff = { env: {}, close: () => {} };
  let plan: ReturnType<typeof providerFolder>;
  try {
    plan = providerFolder(provider, env);
  } catch (error) {
    captureError(error, { fingerprint: ["mcp", "provider_task_home_plan"], tags: { provider } });
    return none;
  }
  if (!plan) return none;
  const linked: LinkedFile[] = [];
  const links: string[] = [];
  let root: string;
  try {
    root = fs.mkdtempSync(path.join(taskHomesRoot(), `${provider}-`));
  } catch (error) {
    captureError(error, { fingerprint: ["mcp", "provider_task_home_create"], tags: { provider } });
    return none;
  }
  try {
    buildFolder(root, plan.folder, linked, links);
  } catch (error) {
    captureError(error, { fingerprint: ["mcp", "provider_task_home_build"], tags: { provider, platform: os.platform() } });
    removeCopy(root, links);
    return none;
  }
  let closed = false;
  return {
    env: { [plan.envKey]: root },
    close: () => {
      if (closed) return;
      closed = true;
      for (const file of linked) {
        try {
          writeBack(file);
        } catch (error) {
          captureError(error, { fingerprint: ["mcp", "provider_task_home_write_back"], tags: { provider } });
        }
      }
      try {
        removeCopy(root, links);
      } catch (error) {
        captureError(error, { fingerprint: ["mcp", "provider_task_home_remove"], tags: { provider } });
      }
    },
  };
}

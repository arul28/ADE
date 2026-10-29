/**
 * The item builders every provider shares: instruction files, skills, agents,
 * rules and MCP servers, each listed with an estimated size.
 */

import fs from "node:fs";
import path from "node:path";

import type {
  ProviderContextItem,
  ProviderContextItemKind,
  ProviderContextOwner,
  ProviderContextTiming,
} from "../../../../shared/types/providerContext";
import type { AdeChatContextPreview } from "../../chat/adeChatContextPreview";
import {
  firstMarkdownParagraph,
  frontmatterFlag,
  readFrontmatter,
  stripFrontmatter,
} from "../../chat/markdownSlashCommandDiscovery";
import { isRecord, parseCodexMcpServers, type McpConfigSource } from "../../mcp/mcpProviderConfigScan";
import { isPathInside, pathsEqual } from "../../shared/pathCompare";
import {
  displayPath,
  listDir,
  located,
  MAX_CONFIG_BYTES,
  MAX_HEADER_BYTES,
  MAX_TEXT_BYTES,
  readJsonCapped,
  readTextCapped,
  type Ctx,
} from "./fsScan";

const MAX_RULE_FILES = 200;
const MAX_RULE_DEPTH = 4;

/** What one provider's discovery found, and whether ADE's skill roots reach it as native skills. */
export type ProviderItems = { items: ProviderContextItem[]; adeSkillsNative: boolean };

/**
 * The one token estimate this list uses: four characters a token. It is the
 * common rule of thumb for English and code; the provider's own tokenizer can
 * differ by a fifth either way.
 */
export function estimateTextTokens(text: string): number {
  return text ? Math.round(text.length / 4) : 0;
}

export function item(ctx: Ctx, fields: {
  owner: ProviderContextOwner;
  kind: ProviderContextItemKind;
  label: string;
  source?: string | null;
  path?: string | null;
  setIn?: string | null;
  settingsEntry?: string | null;
  tokens: number | null;
  sizeKind?: ProviderContextItem["sizeKind"];
  timing: ProviderContextTiming;
  detail?: string | null;
  children?: ProviderContextItem[];
}): ProviderContextItem {
  return {
    id: ctx.nextId(fields.kind),
    owner: fields.owner,
    kind: fields.kind,
    label: fields.label,
    source: fields.source ?? null,
    ...(fields.path ? { path: fields.path } : {}),
    ...(fields.setIn ? { setIn: fields.setIn } : {}),
    ...(fields.settingsEntry ? { settingsEntry: fields.settingsEntry } : {}),
    tokens: fields.tokens,
    sizeKind: fields.sizeKind ?? (fields.tokens == null ? "unknown" : "estimated"),
    timing: fields.timing,
    detail: fields.detail ?? null,
    ...(fields.children?.length ? { children: fields.children } : {}),
  };
}

export function sumTokens(items: readonly ProviderContextItem[]): number {
  return items.reduce((total, entry) => total + (entry.tokens ?? 0), 0);
}

export function ownerFor(ctx: Ctx, file: string): ProviderContextOwner {
  const resolved = path.resolve(file);
  const roots = [ctx.cwd, ctx.gitRoot, ctx.mainRoot].filter((root): root is string => Boolean(root));
  return roots.some((root) => isPathInside(resolved, path.resolve(root))) ? "project" : "user";
}

/** "Project" for the cwd itself, else "Folder <name>": the start of a per-folder file's label. */
export function folderLabel(ctx: Ctx, dir: string): string {
  return pathsEqual(dir, ctx.cwd) ? "Project" : `Folder ${path.basename(dir)}`;
}

/** An env switch a provider reads as on when it is `1` or `true`. */
export function envFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  return env[name] === "1" || env[name] === "true";
}

// ---------------------------------------------------------------------------
// Instruction files
// ---------------------------------------------------------------------------

/** An instruction file as an item, with the text it was counted from. */
export type LoadedFile = { item: ProviderContextItem; text: string };

/** An instruction file as one item, or null when it is missing or empty. */
export async function instructionFile(ctx: Ctx, file: string, options: {
  label: string;
  timing?: ProviderContextTiming;
  detail?: string | null;
  maxBytes?: number;
  maxLines?: number;
  kind?: ProviderContextItemKind;
  owner?: ProviderContextOwner;
}): Promise<LoadedFile | null> {
  const read = await readTextCapped(ctx, file, options.maxBytes ?? MAX_TEXT_BYTES);
  if (!read) return null;
  let text = read.text;
  let detail = options.detail ?? null;
  if (options.maxLines != null) {
    const lines = text.split(/\r?\n/);
    if (lines.length > options.maxLines) {
      text = lines.slice(0, options.maxLines).join("\n");
      detail = `Only the first ${options.maxLines} of its ${lines.length} lines are loaded.`;
    }
  } else if (read.truncated) {
    detail = `Only the first ${Math.round((options.maxBytes ?? MAX_TEXT_BYTES) / 1024)} KB of this ${Math.round(read.bytes / 1024)} KB file is counted.`;
  }
  if (!text.trim()) return null;
  return {
    text,
    item: item(ctx, {
      owner: options.owner ?? ownerFor(ctx, file),
      kind: options.kind ?? "instructions",
      label: options.label,
      ...located(ctx, file),
      tokens: estimateTextTokens(text),
      timing: options.timing ?? "every-request",
      detail,
    }),
  };
}

/** The first file of `names` in `dir` that has text. */
export async function firstInstructionFile(
  ctx: Ctx,
  dir: string,
  names: readonly string[],
  label: (name: string) => string,
  options: Omit<Parameters<typeof instructionFile>[2], "label"> = {},
): Promise<LoadedFile | null> {
  for (const name of names) {
    const found = await instructionFile(ctx, path.join(dir, name), { ...options, label: label(name) });
    if (found) return found;
  }
  return null;
}

/**
 * Files that share one byte budget, as a provider loads them: `fillFrom` says
 * which end of `docs` is loaded first. The file that crosses the budget is cut to what
 * is left, and every file after it adds nothing. Returns the items in `docs`
 * order.
 */
export function applyByteBudget(docs: readonly LoadedFile[], cap: number, options: {
  fillFrom: "start" | "end";
  cut: string;
  dropped: string;
}): ProviderContextItem[] {
  const out = docs.map((doc) => doc.item);
  const indexes = docs.map((_doc, index) => index);
  if (options.fillFrom === "end") indexes.reverse();
  let used = 0;
  for (const index of indexes) {
    const doc = docs[index]!;
    const remaining = cap - used;
    const bytes = Buffer.byteLength(doc.text, "utf8");
    if (remaining <= 0) {
      out[index] = { ...doc.item, tokens: 0, detail: options.dropped };
    } else if (bytes > remaining) {
      out[index] = { ...doc.item, tokens: Math.round(remaining / 4), detail: options.cut };
      used = cap;
    } else {
      used += bytes;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Skills, agents, rules
// ---------------------------------------------------------------------------

type SkillInfo = { name: string; description: string; file: string; modelInvocable: boolean };

function headerInfo(text: string, fallbackName: string): { name: string; description: string; frontmatter: Record<string, unknown> } {
  const frontmatter = readFrontmatter(text);
  const name = typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name.trim() : fallbackName;
  const description = typeof frontmatter.description === "string" && frontmatter.description.trim()
    ? frontmatter.description.trim()
    : firstMarkdownParagraph(stripFrontmatter(text)).trim();
  return { name, description, frontmatter };
}

/** Each `<root>/<name>/SKILL.md`: name and description only, which is what a provider lists. */
async function scanSkillRoot(ctx: Ctx, root: string): Promise<SkillInfo[]> {
  const entries = await listDir(ctx, root);
  const found = await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return null;
    const file = path.join(root, entry.name, "SKILL.md");
    const read = await readTextCapped(ctx, file, MAX_HEADER_BYTES);
    if (!read) return null;
    const info = headerInfo(read.text, entry.name);
    return {
      name: info.name,
      description: info.description,
      file,
      modelInvocable: frontmatterFlag(info.frontmatter["disable-model-invocation"]) !== true,
    } satisfies SkillInfo;
  }));
  return found.filter((entry): entry is SkillInfo => entry != null);
}

/**
 * Skills found under `roots`, first root winning a name, as one item per
 * root with one child per skill. Skills that opt out of model invocation are
 * not listed to the model, so they are left out.
 */
export async function skillItems(ctx: Ctx, roots: ReadonlyArray<{ dir: string; label: string; owner?: ProviderContextOwner }>, options: {
  seen?: Set<string>;
  timing?: ProviderContextTiming;
  detail?: string;
} = {}): Promise<ProviderContextItem[]> {
  const seen = options.seen ?? new Set<string>();
  const seenDirs = new Set<string>();
  const items: ProviderContextItem[] = [];
  for (const root of roots) {
    const resolved = path.resolve(root.dir);
    let real = resolved;
    try {
      real = await fs.promises.realpath(resolved);
    } catch {
      continue;
    }
    if (seenDirs.has(real)) continue;
    seenDirs.add(real);
    const skills = (await scanSkillRoot(ctx, resolved)).filter((skill) => skill.modelInvocable);
    const children: ProviderContextItem[] = [];
    for (const skill of skills) {
      const key = skill.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      children.push(item(ctx, {
        owner: root.owner ?? ownerFor(ctx, skill.file),
        kind: "skill",
        label: skill.name,
        ...located(ctx, skill.file),
        tokens: estimateTextTokens(`- ${skill.name}: ${skill.description}`),
        timing: options.timing ?? "every-request",
        detail: "Its name and description are listed; the body is read when it is used.",
      }));
    }
    if (!children.length) continue;
    items.push(item(ctx, {
      owner: root.owner ?? ownerFor(ctx, resolved),
      kind: "skills",
      label: root.label,
      ...located(ctx, resolved),
      tokens: sumTokens(children),
      timing: options.timing ?? "every-request",
      detail: options.detail ?? "Names and descriptions; each body loads only when the skill is used.",
      children,
    }));
  }
  return items;
}

/** `*.md` agent profiles in `dir`: name and description, which is what the model is shown. */
export async function agentItems(ctx: Ctx, dirs: ReadonlyArray<{ dir: string; label: string }>, suffix = ".md"): Promise<ProviderContextItem[]> {
  const items: ProviderContextItem[] = [];
  const seen = new Set<string>();
  for (const { dir, label } of dirs) {
    const entries = await listDir(ctx, dir);
    const children: ProviderContextItem[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith(suffix) || (!entry.isFile() && !entry.isSymbolicLink())) continue;
      const file = path.join(dir, entry.name);
      const read = await readTextCapped(ctx, file, MAX_HEADER_BYTES);
      if (!read) continue;
      const info = headerInfo(read.text, entry.name.slice(0, -suffix.length).replace(/\.agent$/, ""));
      if (seen.has(info.name)) continue;
      seen.add(info.name);
      children.push(item(ctx, {
        owner: ownerFor(ctx, file),
        kind: "agent",
        label: info.name,
        ...located(ctx, file),
        tokens: estimateTextTokens(`- ${info.name}: ${info.description}`),
        timing: "every-request",
        detail: "Its name and description are listed; its instructions load when it runs.",
      }));
    }
    if (!children.length) continue;
    items.push(item(ctx, {
      owner: ownerFor(ctx, dir),
      kind: "agent",
      label,
      ...located(ctx, dir),
      tokens: sumTokens(children),
      timing: "every-request",
      children,
    }));
  }
  return items;
}

/** Markdown rule files under `dir`, a few levels deep. */
async function ruleFiles(ctx: Ctx, dir: string, extensions: readonly string[], depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > MAX_RULE_DEPTH || out.length >= MAX_RULE_FILES) return out;
  for (const entry of await listDir(ctx, dir)) {
    if (out.length >= MAX_RULE_FILES) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await ruleFiles(ctx, full, extensions, depth + 1, out);
    else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

/**
 * Rule files as items. `conditional(frontmatter)` says when a rule only
 * reaches the model on a matching file (path rules), so it is on-demand.
 */
export async function ruleItems(ctx: Ctx, dirs: ReadonlyArray<{ dir: string; label: string }>, extensions: readonly string[], conditional: (frontmatter: Record<string, unknown>) => boolean): Promise<ProviderContextItem[]> {
  const items: ProviderContextItem[] = [];
  for (const { dir, label } of dirs) {
    const files = await ruleFiles(ctx, dir, extensions);
    const children: ProviderContextItem[] = [];
    for (const file of files) {
      const read = await readTextCapped(ctx, file);
      if (!read?.text.trim()) continue;
      const scoped = conditional(readFrontmatter(read.text));
      children.push(item(ctx, {
        owner: ownerFor(ctx, file),
        kind: "rule",
        label: path.relative(dir, file),
        ...located(ctx, file),
        tokens: estimateTextTokens(read.text),
        timing: scoped ? "on-demand" : "every-request",
        detail: scoped ? "Loads only when the agent works on files it matches." : null,
      }));
    }
    if (!children.length) continue;
    const always = children.filter((child) => child.timing !== "on-demand");
    items.push(item(ctx, {
      owner: ownerFor(ctx, dir),
      kind: "rule",
      label,
      ...located(ctx, dir),
      tokens: sumTokens(always),
      timing: always.length ? "every-request" : "on-demand",
      detail: always.length < children.length
        ? `${children.length - always.length} of them load only for matching files and are not in the total.`
        : null,
      children,
    }));
  }
  return items;
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

function mcpType(entry: unknown): string {
  if (!isRecord(entry)) return "unknown";
  const declared = typeof entry.type === "string" ? entry.type : typeof entry.transport === "string" ? entry.transport : null;
  if (declared) return declared === "streamable-http" || declared === "streamableHttp" ? "http" : declared;
  if (typeof entry.command === "string" || Array.isArray(entry.command)) return "stdio";
  if (typeof entry.httpUrl === "string") return "http";
  if (typeof entry.url === "string" || typeof entry.serverUrl === "string") return "http";
  return "unknown";
}

function mcpDisabled(entry: unknown): boolean {
  return isRecord(entry) && (entry.disabled === true || entry.enabled === false);
}

/** The server tables one source holds: a project-filed source can match more than one spelling of the path. */
async function mcpTables(ctx: Ctx, source: McpConfigSource): Promise<Record<string, unknown>[]> {
  if (source.format === "toml") {
    const read = await readTextCapped(ctx, source.file, MAX_CONFIG_BYTES);
    return read ? [parseCodexMcpServers(read.text)] : [];
  }
  const root = await readJsonCapped(ctx, source.file);
  if (!root) return [];
  // Claude files a project's servers under its path, written in its own
  // spelling (forward slashes on Windows): match the key, not the string.
  // On a case-insensitive disk two keys that differ only in case both match;
  // their servers are listed once, because names are de-duplicated.
  const nodes = source.projectKey != null
    ? isRecord(root.projects)
      ? Object.entries(root.projects).filter(([key]) => pathsEqual(key, source.projectKey)).map(([, value]) => value)
      : []
    : [root];
  return nodes
    .map((node) => (isRecord(node) && isRecord(node[source.key]) ? node[source.key] as Record<string, unknown> : null))
    .filter((table): table is Record<string, unknown> => table != null);
}

/** Server names and types only: no command, argument, URL, env or header value leaves this function. */
export async function mcpItems(ctx: Ctx, sources: readonly McpConfigSource[], options: { seen?: Set<string>; detail?: string } = {}): Promise<ProviderContextItem[]> {
  const seen = options.seen ?? new Set<string>();
  const items: ProviderContextItem[] = [];
  for (const source of sources) {
    for (const table of await mcpTables(ctx, source)) {
      for (const [rawName, entry] of Object.entries(table)) {
        const name = rawName.trim();
        if (!name || seen.has(name) || mcpDisabled(entry)) continue;
        seen.add(name);
        items.push(item(ctx, {
          // A project-scope file above the repository (Droid walks every
          // folder up) is the user's.
          owner: source.scope === "project" ? ownerFor(ctx, source.file) : "user",
          kind: "mcp-server",
          label: `MCP server: ${name}`,
          setIn: `${displayPath(ctx.home, source.file)}${source.scope === "local" ? " (this project)" : ""}`,
          path: path.resolve(source.file),
          settingsEntry: "mcp.found",
          tokens: null,
          timing: "every-request",
          detail: options.detail ?? `${mcpType(entry)} server. Its tools and instructions arrive when it connects, so their size is not known here.`,
        }));
      }
    }
  }
  return items;
}

export function adeMcpItems(ctx: Ctx, servers: AdeChatContextPreview["mcpServers"], seen: Set<string>): ProviderContextItem[] {
  const items: ProviderContextItem[] = [];
  for (const server of servers) {
    if (seen.has(server.name)) continue;
    seen.add(server.name);
    items.push(item(ctx, {
      owner: "user",
      kind: "mcp-server",
      label: `MCP server: ${server.name}`,
      setIn: "ADE Settings › MCP servers",
      settingsEntry: "mcp.servers",
      tokens: null,
      timing: "every-request",
      detail: `${server.type} server ADE starts for this chat. Its tools arrive when it connects, so their size is not known here.`,
    }));
  }
  return items;
}

/** ADE's MCP servers, then the servers in `sources` whose names ADE's do not already take. */
export async function adeThenConfigMcpItems(
  ctx: Ctx,
  preview: AdeChatContextPreview | null,
  sources: readonly McpConfigSource[],
): Promise<ProviderContextItem[]> {
  const seen = new Set<string>();
  const items = adeMcpItems(ctx, preview?.mcpServers ?? [], seen);
  items.push(...await mcpItems(ctx, sources, { seen }));
  return items;
}
